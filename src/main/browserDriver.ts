/**
 * O MOTOR DO BROWSER EMBUTIDO — CDP sobre `webContents.debugger` (H2 do design
 * vinculante `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * A rota B venceu a rota A por evidência, não por gosto (sonda
 * `PROBE_BROWSER_CDP_2026-08-29.md`): `webContents.debugger` é IN-PROCESS — não
 * abre porta, não faz handshake, não pode ser anexado por outro processo da
 * máquina, e P6 provou o kit inteiro vivo numa `WebContentsView`
 * (`attach('1.3')`, `Page.*`, `Runtime.*`, `Input.dispatch*`), inclusive com o
 * devtools do dono aberto ao mesmo tempo.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DECISÃO MEDIDA #1 — A ÁRVORE COMPACTA SAI DE `Runtime.evaluate`, NÃO DO
 * `Accessibility.getFullAXTree`.
 *
 * Os três caminhos possíveis, com os números da sonda (P4, página de 4 821 nós):
 *   · `Accessibility.getFullAXTree` — 79 ms e **1 672 927 bytes**
 *   · `DOMSnapshot.captureSnapshot` — 16 ms e **305 035 bytes**
 *   · `Runtime.evaluate` (innerText) — **0,4 ms** e 35 005 bytes
 *
 * O veredito da própria sonda, verbatim: "o AX tree cru é impagável como
 * resposta de tool: 1,67 MB. O tempo (79 ms) nunca foi o problema — o payload
 * é." E o payload é o problema DUAS vezes: (a) ele atravessa a ponte do
 * debugger para o MAIN, que é a thread da UI do app — 1,67 MB de JSON por
 * leitura é GC no processo que desenha a tela do dono; (b) filtrar no main não
 * evita nada, porque o megabyte já atravessou.
 *
 * Filtrando DENTRO da página, o que atravessa já é o texto final (poucos KB).
 * O `DOMSnapshot` perde nos dois eixos: 305 KB de payload inteiro e sem papel
 * (role) nenhum — teríamos de re-derivar o papel no main de qualquer jeito.
 *
 * E há um ganho que só o `Runtime.evaluate` dá: o mesmo passo que numera os
 * refs PRENDE o elemento num registro dentro da página. A ação seguinte
 * resolve `ref → elemento → caixa` numa ida só. Pelo AX tree, cada ação
 * custaria `DOM.resolveNode` + `DOM.getBoxModel` a mais, por ref.
 *
 * O preço, dito em voz alta: o papel e o nome acessível saem de uma heurística
 * nossa (tag + ARIA + label), não do motor de acessibilidade do Chromium. Para
 * QA de UI própria isso é suficiente — e é o mesmo desenho do `agent-browser`
 * da Vercel (Apache-2.0), que a pesquisa registrou como o formato mais enxuto
 * do mercado.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DECISÃO MEDIDA #2 — REFS COM EPOCH, E O EPOCH SÓ VIRA NA NAVEGAÇÃO.
 *
 * O número do ref é dado por IDENTIDADE (um `WeakMap<Element, number>` na
 * página), nunca por posição num array. Duas consequências que valem tudo:
 *   · reler a página devolve o MESMO número para o MESMO elemento — é o que
 *     torna `browser_act` encadeável (lei 3: toda ação já devolve o read, e o
 *     read não pode invalidar o ref que o agente acabou de ler);
 *   · navegação/reload destrói o contexto JS da página, então o registro some
 *     SOZINHO. O epoch do main é o segundo cinto: `Page.frameNavigated` do
 *     frame principal incrementa, e ação com epoch velho RECUSA nomeando a
 *     receita — nunca clica às cegas num nó morto.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Este módulo NÃO importa `electron`. Ele fala com interfaces estruturais
 * (`BrowserPageLike`), que o `WebContents` real satisfaz sem cast — é o que
 * permite a suíte `test:browser-driver` provar refs, epoch, teto e lote com
 * dublês, sem subir janela nenhuma.
 */
import {
  buildProbeExpression,
  formatProbeReport,
  type BrowserProbeParams,
  type BrowserProbeRaw
} from './browserProbe'
import {
  buildPageExpression,
  describeTarget,
  isPageFailure,
  readFooter,
  type PageActKind,
  type PageReadResult,
  type PageResolveResult,
  type PageResult,
  type PageWaitResult
} from './browserPageScript'
import {
  runBrowserActions,
  type BrowserAction,
  type BrowserActionContext,
  type BrowserInputCapabilities
} from './browserActions'

// ————————————————————————— contratos estruturais —————————————————————————

/** A fatia do `Debugger` do Electron que este motor usa. */
export interface CdpDebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>
  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown) => void
  ): unknown
}

/** A fatia do `WebContents` que este motor usa (a captura mora no shot). */
export interface BrowserPageLike {
  readonly id: number
  readonly debugger: CdpDebuggerLike
  isDestroyed(): boolean
  getURL(): string
  getTitle(): string
}

/** Caixa-preta desta borda: quem chama injeta; o motor nunca importa blackbox. */
export type BrowserDriverLog = (entry: {
  event: string
  detail?: Record<string, unknown>
  err?: string
}) => void

// ————————————————————————————— tetos da casa —————————————————————————————

/** Teto default do `browser_read`. O agente vê o corte e a receita. */
export const BROWSER_READ_DEFAULT_MAX_CHARS = 8_000
/** Teto do teto: acima disso a leitura vira a bomba de token que a pesquisa
 *  mediu no playwright-mcp (50-540 KB por snapshot, contexto estourado em 2-3
 *  navegações). */
export const BROWSER_READ_CEILING_CHARS = 32_000
/** `browser_find` devolve poucos refs de propósito — é o atalho barato. */
export const BROWSER_FIND_MAX_HITS = 20
/** Profundidade default da árvore. */
export const BROWSER_READ_DEFAULT_DEPTH = 20
/** Teto de UMA chamada CDP. Acima disso a chamada virou pendura — e pendura é
 *  rodada perdida para o agente (a sonda mediu 5-8s de pendura com a view fora
 *  da árvore). */
export const BROWSER_CDP_TIMEOUT_MS = 8_000
// O teto de passos de `browser_act` mora em `browserActions.ts` (junto de quem
// o aplica) e é re-exportado aqui porque o catálogo MCP lê o motor pela porta
// da frente — número de teto duplicado à mão é como a descrição de uma tool
// começa a mentir sobre o próprio limite.
export { BROWSER_ACT_MAX_STEPS } from './browserActions'
export type { BrowserAction, BrowserActionKind } from './browserActions'
/** Anel de console e de rede. */
export const BROWSER_CONSOLE_RING = 300
export const BROWSER_NETWORK_RING = 300
/** Teto do corpo de resposta devolvido pelo `browser_network`. */
export const BROWSER_NETWORK_BODY_MAX_CHARS = 8_000
/** Teto do resultado serializado do `browser_eval`. */
export const BROWSER_EVAL_MAX_CHARS = 4_000
/** Espera default/máxima do `browser_wait`. */
export const BROWSER_WAIT_DEFAULT_MS = 5_000
export const BROWSER_WAIT_MAX_MS = 30_000

/**
 * A RECEITA do ref velho. Uma frase, um lugar: ela viaja verbatim para o
 * recibo de toda recusa por epoch/registro — beco sem saída é bug.
 */
export const BROWSER_STALE_REF_RECIPE =
  'a página mudou — chame browser_read de novo para renumerar os refs desta página'

// ————————————————————————————— tipos públicos —————————————————————————————

export interface BrowserReadOptions {
  filter?: 'interactive' | 'all'
  depth?: number
  scope?: string
  maxChars?: number
}


export interface BrowserViewportOptions {
  preset?: 'mobile' | 'tablet' | 'desktop'
  width?: number
  height?: number
  colorScheme?: 'light' | 'dark'
}

export interface BrowserWaitOptions {
  text?: string
  selector?: string
  networkIdle?: boolean
  ms?: number
  timeoutMs?: number
}

/**
 * Os presets do `browser_viewport`. `desktop` não está aqui de propósito: ele
 * DESLIGA a emulação e devolve o tamanho real do painel, que é outra operação.
 */
const VIEWPORT_PRESETS: Record<
  string,
  { width: number; height: number; mobile: boolean; scale: number }
> = {
  mobile: { width: 390, height: 844, mobile: true, scale: 2 },
  tablet: { width: 834, height: 1112, mobile: false, scale: 2 }
}

/** O que o `browser_shot` precisa saber sobre o frescor do quadro (lei 2). */
export interface BrowserFreshness {
  frames: number
  ms: number
  pulsing: boolean
}

interface ConsoleEntry {
  level: string
  text: string
  source?: string
  ts: number
}

interface NetworkEntry {
  id: string
  seq: number
  method: string
  url: string
  kind?: string
  status?: number
  mime?: string
  bytes?: number
  startedAt: number
  endedAt?: number
  failure?: string
}

// ————————————————————————————— utilidades ————————————————————————————————

/** Corre a chamada contra o relógio: pendura de CDP é rodada perdida. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} não respondeu em ${ms}ms`)),
          ms
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ————————————————————————————— a sessão CDP ——————————————————————————————

/**
 * UMA sessão de debugger por aba. Ela é o dono do epoch, do registro de refs
 * (que mora na página), do anel de console e do anel de rede.
 */
export class BrowserDriverSession {
  private readonly page: BrowserPageLike
  private readonly log: BrowserDriverLog
  private attached = false
  private epochValue = 1
  private consoleRing: ConsoleEntry[] = []
  private networkRing: NetworkEntry[] = []
  private networkSeq = 0
  private inFlight = new Set<string>()
  private lastNetworkActivity = Date.now()
  private lastNavigation = ''
  private logDomain = false
  private networkDomain = false
  /** O estado de digitação desta aba, compartilhado com `browserActions` por
   *  REFERÊNCIA: a primeira recusa de `Input.insertText` desliga o caminho
   *  rápido para sempre nesta sessão, e não a cada ação. */
  private readonly input: BrowserInputCapabilities = { insertText: true }

  constructor(page: BrowserPageLike, log: BrowserDriverLog = () => undefined) {
    this.page = page
    this.log = log
  }

  get epoch(): number {
    return this.epochValue
  }

  get alive(): boolean {
    return !this.page.isDestroyed()
  }

  /**
   * Anexa o debugger 1.3 e liga os quatro domínios. P6 provou a convivência com
   * o devtools do dono aberto — o painel dele e o agente não brigam.
   *
   * `Network` entra JÁ no attach de propósito: ligar depois perderia as
   * requisições do carregamento, que são justamente as que explicam uma tela
   * que não pintou.
   */
  async ensureAttached(): Promise<void> {
    if (this.attached && this.page.debugger.isAttached()) return
    if (!this.page.debugger.isAttached()) this.page.debugger.attach('1.3')
    if (!this.attached) {
      this.page.debugger.on('message', (_event, method, params) => {
        this.onCdpEvent(method, params)
      })
      this.attached = true
    }
    // Page e Runtime são ESSENCIAIS (sem eles não há leitura nem ação) e estão
    // provados em binário real (P6). Log e Network são acessórios: se um deles
    // não existir neste Electron, a tool correspondente diz a verdade em vez de
    // derrubar o kit inteiro. A sonda cobriu `Log.enable`; `Network.enable` NÃO
    // foi sondado — daí o try/catch, e não uma afirmação.
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    try {
      await this.send('Log.enable')
      this.logDomain = true
    } catch (error) {
      this.log({ event: 'browser-cdp-domain-off', detail: { domain: 'Log' }, err: String(error) })
    }
    try {
      await this.send('Network.enable', {
        maxTotalBufferSize: 2_000_000,
        maxResourceBufferSize: 1_000_000
      })
      this.networkDomain = true
    } catch (error) {
      this.log({ event: 'browser-cdp-domain-off', detail: { domain: 'Network' }, err: String(error) })
    }
    this.log({ event: 'browser-cdp-attached', detail: { wc: this.page.id } })
  }

  /** Toda ida ao CDP passa por aqui: teto de tempo e erro legível. */
  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return withTimeout(
      this.page.debugger.sendCommand(method, params ?? {}),
      BROWSER_CDP_TIMEOUT_MS,
      method
    )
  }

  private onCdpEvent(method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown>
    switch (method) {
      case 'Page.frameNavigated': {
        const frame = params['frame'] as { parentId?: string; url?: string } | undefined
        if (frame && !frame.parentId) {
          this.epochValue += 1
          this.lastNavigation = String(frame.url ?? '')
          this.pushConsole({
            level: 'nav',
            text: `— navegou para ${this.lastNavigation} (epoch ${this.epochValue}) —`,
            ts: Date.now()
          })
        }
        break
      }
      case 'Runtime.consoleAPICalled': {
        const args = (params['args'] as { value?: unknown; description?: string }[] | undefined) ?? []
        this.pushConsole({
          level: String(params['type'] ?? 'log'),
          text: args
            .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
            .join(' ')
            .slice(0, 600),
          ts: Date.now()
        })
        break
      }
      case 'Runtime.exceptionThrown': {
        const details = params['exceptionDetails'] as
          | { text?: string; exception?: { description?: string } }
          | undefined
        this.pushConsole({
          level: 'error',
          text: String(details?.exception?.description ?? details?.text ?? 'exceção').slice(0, 600),
          ts: Date.now()
        })
        break
      }
      case 'Log.entryAdded': {
        const entry = params['entry'] as
          | { level?: string; text?: string; url?: string; source?: string }
          | undefined
        this.pushConsole({
          level: String(entry?.level ?? 'info'),
          text: String(entry?.text ?? '').slice(0, 600),
          ...(entry?.source ? { source: entry.source } : {}),
          ts: Date.now()
        })
        break
      }
      case 'Network.requestWillBeSent': {
        const id = String(params['requestId'] ?? '')
        const request = params['request'] as { url?: string; method?: string } | undefined
        this.networkSeq += 1
        this.pushNetwork({
          id,
          seq: this.networkSeq,
          method: String(request?.method ?? 'GET'),
          url: String(request?.url ?? ''),
          ...(params['type'] ? { kind: String(params['type']) } : {}),
          startedAt: Date.now()
        })
        this.inFlight.add(id)
        this.lastNetworkActivity = Date.now()
        break
      }
      case 'Network.responseReceived': {
        const id = String(params['requestId'] ?? '')
        const response = params['response'] as { status?: number; mimeType?: string } | undefined
        const found = this.networkRing.find((n) => n.id === id)
        if (found) {
          if (response?.status !== undefined) found.status = response.status
          if (response?.mimeType) found.mime = response.mimeType
        }
        break
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const id = String(params['requestId'] ?? '')
        const found = this.networkRing.find((n) => n.id === id)
        if (found) {
          found.endedAt = Date.now()
          const length = params['encodedDataLength']
          if (typeof length === 'number') found.bytes = length
          if (method === 'Network.loadingFailed') {
            found.failure = String(params['errorText'] ?? 'falhou')
          }
        }
        this.inFlight.delete(id)
        this.lastNetworkActivity = Date.now()
        break
      }
      default:
        break
    }
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleRing.push(entry)
    if (this.consoleRing.length > BROWSER_CONSOLE_RING) this.consoleRing.shift()
  }

  private pushNetwork(entry: NetworkEntry): void {
    this.networkRing.push(entry)
    if (this.networkRing.length > BROWSER_NETWORK_RING) this.networkRing.shift()
  }

  /** Roda o script da página com os parâmetros já serializados. */
  private async runPage<T>(params: Record<string, unknown>): Promise<PageResult<T>> {
    await this.ensureAttached()
    const expression = buildPageExpression(this.epochValue, params)
    const raw = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false
    })) as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (raw.exceptionDetails) {
      return {
        ok: false,
        error: String(
          raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? 'erro na página'
        )
      }
    }
    const value = raw.result?.value
    if (!value || typeof value !== 'object') {
      return { ok: false, error: 'a página não devolveu resultado' }
    }
    return value as PageResult<T>
  }

  // ————————————————————————————— leitura —————————————————————————————

  async read(options: BrowserReadOptions = {}): Promise<string> {
    const maxChars = Math.min(
      Math.max(options.maxChars ?? BROWSER_READ_DEFAULT_MAX_CHARS, 500),
      BROWSER_READ_CEILING_CHARS
    )
    const result = await this.runPage<PageReadResult>({
      mode: 'read',
      filter: options.filter ?? 'all',
      depth: Math.min(Math.max(options.depth ?? BROWSER_READ_DEFAULT_DEPTH, 1), 40),
      scope: options.scope ?? '',
      maxChars
    })
    if (isPageFailure(result)) {
      if (result.scopeMiss) {
        return `${result.error}. Receita: chame browser_read sem \`scope\` para ver a página inteira e descobrir o seletor certo.`
      }
      return `não consegui ler a página: ${result.error}`
    }
    const header = `${result.title || '(sem título)'} · ${result.url}`
    const body = result.text || '(nenhum elemento visível casou com o filtro)'
    return `${header}\n\n${body}\n\n${readFooter(result, maxChars, BROWSER_READ_CEILING_CHARS)}`
  }

  async find(query: string, role?: string): Promise<string> {
    const result = await this.runPage<PageReadResult>({
      mode: 'find',
      query,
      role: role ?? '',
      limit: BROWSER_FIND_MAX_HITS,
      depth: 40,
      scope: '',
      filter: 'all',
      maxChars: BROWSER_READ_CEILING_CHARS
    })
    if (isPageFailure(result)) return `não consegui procurar na página: ${result.error}`
    if (!result.text) {
      return `nenhum elemento casou com "${query}"${role ? ` no papel ${role}` : ''}. Receita: chame browser_read (filter:"interactive") para ver o que existe na tela agora.`
    }
    const cut = result.truncated ? `\n(mostrando os primeiros ${BROWSER_FIND_MAX_HITS} — refine a busca)` : ''
    return `${result.text}${cut}\n— refs válidos no epoch ${result.epoch} · ${result.url} —`
  }

  // ————————————————————————————— ações —————————————————————————————

  /**
   * LEI 3 — ação já observa. A mecânica das ações (ponteiro, teclado e as três
   * que o DOM resolve melhor) mora em `browserActions.ts`; a sessão só entrega
   * os quatro verbos de que ela precisa. O `read` pós-ação é o produto final:
   * ele volta SEMPRE, inclusive quando o lote parou no meio.
   */
  async act(actions: BrowserAction[], readOptions: BrowserReadOptions = {}): Promise<string> {
    return runBrowserActions(this.actionContext(readOptions), actions)
  }

  private actionContext(readOptions: BrowserReadOptions): BrowserActionContext {
    return {
      send: (method, params) => this.send(method, params),
      resolve: (step, act) => this.resolve(step, act),
      settle: () => this.settle(),
      read: () => this.read(readOptions),
      capabilities: this.input,
      log: (entry) => this.log(entry)
    }
  }

  /**
   * ref/seletor → ponto na viewport. É AQUI que a cerca do epoch morde: um ref
   * de leitura anterior à navegação não resolve, e a recusa nomeia a receita.
   */
  private async resolve(
    step: BrowserAction,
    act: PageActKind | undefined
  ): Promise<PageResolveResult | { error: string }> {
    const result = await this.runPage<PageResolveResult>({
      mode: 'resolve',
      ...(step.ref !== undefined ? { ref: step.ref } : {}),
      ...(step.selector ? { selector: step.selector } : {}),
      ...(act ? { act } : {}),
      ...(step.value !== undefined ? { value: step.value } : {}),
      ...(step.text !== undefined && act === 'fill' ? { value: step.text } : {})
    })
    if (isPageFailure(result)) {
      return {
        error: result.stale ? `${result.error} — ${BROWSER_STALE_REF_RECIPE}` : result.error
      }
    }
    return result
  }

  /**
   * Dois quadros e um respiro: o DOM da ação precisa assentar antes do read.
   *
   * O TETO CURTO É O PONTO. Com o painel escondido o `requestAnimationFrame` é
   * estrangulado (P5: 1 quadro em 350ms, contra 21 com o painel visível) —
   * pendurar aqui no teto normal de 8s do CDP transformaria cada `browser_act`
   * de painel colapsado numa rodada perdida. O `setTimeout` de dentro é a saída
   * da própria página; este relógio é a saída de fora.
   */
  private async settle(): Promise<void> {
    try {
      await withTimeout(
        this.page.debugger.sendCommand('Runtime.evaluate', {
          expression:
            'new Promise(function(r){var done=false;function go(){if(!done){done=true;r(1)}}requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(go,60)})});setTimeout(go,300)})',
          awaitPromise: true,
          returnByValue: true
        }),
        500,
        'assentamento'
      )
    } catch {
      // Página sem compositor pulsando: o read seguinte é a verdade que
      // importa — não faz sentido derrubar a ação por causa disto.
    }
  }


  // ————————————————————————————— inspeção —————————————————————————————

  async probe(params: BrowserProbeParams): Promise<string> {
    await this.ensureAttached()
    const expression = buildProbeExpression({ ...params, epoch: this.epochValue })
    const raw = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
    if (raw.exceptionDetails) {
      return `não consegui inspecionar: ${raw.exceptionDetails.text ?? 'erro na página'}`
    }
    const value = raw.result?.value as BrowserProbeRaw | undefined
    if (!value) return 'não consegui inspecionar: a página não devolveu resultado'
    if (!value.ok) {
      return value.stale ? `${value.error} — ${BROWSER_STALE_REF_RECIPE}` : `não consegui inspecionar: ${value.error}`
    }
    return formatProbeReport(value)
  }

  async evaluate(expression: string): Promise<string> {
    await this.ensureAttached()
    const raw = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false
    })) as {
      result?: { value?: unknown; type?: string; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (raw.exceptionDetails) {
      const message =
        raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? 'erro'
      return `a página lançou: ${String(message).slice(0, BROWSER_EVAL_MAX_CHARS)}`
    }
    const value = raw.result?.value
    let printed: string
    if (value === undefined) printed = raw.result?.description ?? 'undefined'
    else if (typeof value === 'string') printed = value
    else {
      try {
        printed = JSON.stringify(value, null, 1) ?? String(value)
      } catch {
        printed = String(value)
      }
    }
    return printed.length > BROWSER_EVAL_MAX_CHARS
      ? `${printed.slice(0, BROWSER_EVAL_MAX_CHARS)}\n[CORTADO em ${BROWSER_EVAL_MAX_CHARS} caracteres — devolva menos: escolha campos em vez do objeto inteiro]`
      : printed
  }

  async wait(options: BrowserWaitOptions): Promise<string> {
    const timeout = Math.min(options.timeoutMs ?? BROWSER_WAIT_DEFAULT_MS, BROWSER_WAIT_MAX_MS)
    const started = Date.now()
    if (options.ms !== undefined) {
      const ms = Math.min(Math.max(options.ms, 0), BROWSER_WAIT_MAX_MS)
      await new Promise((resolve) => setTimeout(resolve, ms))
      return `esperei ${ms}ms.`
    }
    if (options.networkIdle && !this.networkDomain) {
      // Sem o domínio Network o contador de requisições em voo é sempre ZERO —
      // responder "rede ociosa" aqui seria uma MENTIRA com cara de sucesso.
      return 'não posso esperar a rede: o domínio Network do CDP não subiu nesta aba. Receita: espere por `selector` ou `text` (o que a página desenha quando a resposta chega) — é uma condição melhor que ociosidade de rede, porque prova que o dado virou tela.'
    }
    while (Date.now() - started < timeout) {
      if (options.networkIdle) {
        if (this.inFlight.size === 0 && Date.now() - this.lastNetworkActivity > 500) {
          return `rede ociosa depois de ${Date.now() - started}ms (nenhuma requisição em voo há 500ms).`
        }
      } else {
        const result = await this.runPage<PageWaitResult>({
          mode: 'wait',
          ...(options.selector ? { selector: options.selector } : {}),
          ...(options.text ? { text: options.text } : {})
        })
        if (!isPageFailure(result) && result.hit) {
          return `apareceu depois de ${Date.now() - started}ms.`
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    const what = options.networkIdle
      ? `a rede não ficou ociosa (${this.inFlight.size} requisição(ões) em voo)`
      : options.selector
        ? `o seletor "${options.selector}" não apareceu`
        : `o texto "${options.text ?? ''}" não apareceu`
    return `ESPERA ESGOTADA em ${timeout}ms: ${what}. Receita: chame browser_read para ver o que a página REALMENTE mostra agora, browser_console para ver se ela quebrou, ou repita com timeoutMs maior (teto ${BROWSER_WAIT_MAX_MS}).`
  }

  // ————————————————————————— console, rede, viewport —————————————————————

  consoleText(options: { onlyErrors?: boolean; pattern?: string; limit?: number }): string {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), BROWSER_CONSOLE_RING)
    let entries = this.consoleRing
    if (options.onlyErrors) {
      entries = entries.filter((e) => /error|severe|warning/i.test(e.level))
    }
    if (options.pattern) {
      const needle = options.pattern.toLowerCase()
      entries = entries.filter((e) => e.text.toLowerCase().includes(needle))
    }
    // Honestidade de cobertura: `console.*` da página chega pelo Runtime (que
    // é essencial e está sempre ligado); o que o domínio Log acrescenta são as
    // mensagens do PRÓPRIO navegador (CSP, rede, mixed content). Se ele não
    // subiu, o recibo diz — silêncio aqui viraria "não há erro nenhum".
    const gap = this.logDomain
      ? ''
      : '\n(o domínio Log do navegador não subiu neste Electron: erros de CSP/rede do próprio browser NÃO aparecem aqui — confira também o browser_network)'
    if (entries.length === 0) {
      return (
        (this.consoleRing.length === 0
          ? 'o console está vazio desde que esta aba abriu. (O buffer começa no attach do motor — recarregue a página com browser_open para gravar o carregamento inteiro.)'
          : 'nenhuma mensagem casou com o filtro. Receita: repita sem `onlyErrors`/`pattern` para ver tudo.') + gap
      )
    }
    const shown = entries.slice(-limit)
    const head = shown.length < entries.length ? `(últimas ${shown.length} de ${entries.length})\n` : ''
    return head + shown.map((e) => `[${e.level}] ${e.text}`).join('\n') + gap
  }

  networkText(options: { urlPattern?: string; onlyFailures?: boolean; limit?: number }): string {
    if (!this.networkDomain) {
      return 'o domínio Network do CDP não subiu nesta aba — NÃO existe registro de requisição para mostrar, e a ausência de linhas aqui NÃO significa que a rede está limpa. Receita: use browser_console (erros de fetch costumam aparecer lá) e browser_eval para perguntar à própria página (ex.: o estado do store que consumiu a resposta).'
    }
    const limit = Math.min(Math.max(options.limit ?? 40, 1), BROWSER_NETWORK_RING)
    let entries = this.networkRing
    if (options.urlPattern) {
      const needle = options.urlPattern.toLowerCase()
      entries = entries.filter((n) => n.url.toLowerCase().includes(needle))
    }
    if (options.onlyFailures) {
      entries = entries.filter((n) => n.failure !== undefined || (n.status !== undefined && n.status >= 400))
    }
    if (entries.length === 0) {
      return this.networkRing.length === 0
        ? 'nenhuma requisição registrada desde que o motor anexou nesta aba. Receita: recarregue a página (browser_open na mesma URL) para gravar o carregamento inteiro.'
        : 'nenhuma requisição casou com o filtro. Receita: repita sem `urlPattern`/`onlyFailures`.'
    }
    const shown = entries.slice(-limit)
    const head = shown.length < entries.length ? `(últimas ${shown.length} de ${entries.length})\n` : ''
    return (
      head +
      shown
        .map((n) => {
          const status = n.failure ? `FALHOU(${n.failure})` : (n.status ?? '—')
          const ms = n.endedAt ? `${n.endedAt - n.startedAt}ms` : 'em voo'
          const size = n.bytes !== undefined ? `, ${n.bytes}B` : ''
          return `#${n.id} ${n.method} ${status} ${ms}${size} ${n.url.slice(0, 140)}`
        })
        .join('\n') +
      '\n— o corpo de uma resposta sai em browser_network com `requestId` (o #id acima) —'
    )
  }

  async networkBody(requestId: string): Promise<string> {
    if (!this.networkDomain) return this.networkText({})
    const known = this.networkRing.find((n) => n.id === requestId)
    if (!known) {
      return `não conheço a requisição #${requestId}. Receita: chame browser_network sem \`requestId\` para ver o índice e copiar o id de lá.`
    }
    try {
      const raw = (await this.send('Network.getResponseBody', { requestId })) as {
        body?: string
        base64Encoded?: boolean
      }
      if (raw.base64Encoded) {
        return `#${requestId} ${known.url}\n(corpo binário de ${raw.body?.length ?? 0} bytes em base64 — não vale como texto; use browser_shot se o que importa é o pixel)`
      }
      const body = raw.body ?? ''
      return `#${requestId} ${known.method} ${known.status ?? '—'} ${known.url}\n\n${
        body.length > BROWSER_NETWORK_BODY_MAX_CHARS
          ? `${body.slice(0, BROWSER_NETWORK_BODY_MAX_CHARS)}\n[CORTADO em ${BROWSER_NETWORK_BODY_MAX_CHARS} caracteres]`
          : body
      }`
    } catch (error) {
      return `o corpo de #${requestId} não está mais no buffer do Chromium (${
        error instanceof Error ? error.message : String(error)
      }). Receita: refaça a requisição (browser_open recarrega a página) e peça o corpo logo em seguida.`
    }
  }

  async viewport(options: BrowserViewportOptions): Promise<string> {
    await this.ensureAttached()
    const applied: string[] = []
    if (options.preset === 'desktop' && !options.width && !options.height) {
      await this.send('Emulation.clearDeviceMetricsOverride')
      applied.push('tamanho: o do painel (emulação desligada)')
    } else if (options.preset || options.width || options.height) {
      const preset = options.preset ? VIEWPORT_PRESETS[options.preset] : undefined
      const width = options.width ?? preset?.width ?? 1280
      const height = options.height ?? preset?.height ?? 800
      await this.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: preset?.scale ?? 1,
        mobile: preset?.mobile ?? false
      })
      applied.push(`tamanho: ${width}x${height}${preset?.mobile ? ' (toque, UA móvel de layout)' : ''}`)
    }
    if (options.colorScheme) {
      await this.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: options.colorScheme }]
      })
      applied.push(`tema: ${options.colorScheme}`)
    }
    if (applied.length === 0) {
      return 'nada mudou — informe `preset`, `width`/`height` ou `colorScheme`.'
    }
    await this.settle()
    return `viewport aplicada — ${applied.join(' · ')}.\nO layout já reagiu; chame browser_probe para medir e browser_shot para o dono ver.`
  }

  /** LEI 2 — frescor é carimbo, nunca fé. Dois rAF com relógio: quadro que não
   *  pulsa vira AVISO honesto no recibo do shot, jamais aprovação silenciosa. */
  async freshness(): Promise<BrowserFreshness> {
    await this.ensureAttached()
    const started = Date.now()
    try {
      const raw = (await withTimeout(
        this.page.debugger.sendCommand('Runtime.evaluate', {
          expression:
            'new Promise(function(r){var t0=performance.now();var n=0;function tick(){n++;if(n>=2)r({frames:n,ms:performance.now()-t0});else requestAnimationFrame(tick)}requestAnimationFrame(tick);setTimeout(function(){r({frames:n,ms:performance.now()-t0})},400)})',
          awaitPromise: true,
          returnByValue: true
        }),
        1_500,
        'sonda de frescor'
      )) as { result?: { value?: { frames?: number; ms?: number } } }
      const value = raw.result?.value ?? {}
      const frames = Number(value.frames ?? 0)
      return { frames, ms: Math.round(Number(value.ms ?? Date.now() - started)), pulsing: frames >= 2 }
    } catch {
      return { frames: 0, ms: Date.now() - started, pulsing: false }
    }
  }

  /**
   * A CAIXA de um ref/seletor, para o `clip` do `browser_shot`. Sai do mesmo
   * resolvedor das ações — logo, herda a MESMA cerca de epoch: fotografar um
   * ref velho recusa nomeando a receita em vez de recortar o lugar errado.
   */
  async rectFor(
    target: { ref?: number; selector?: string }
  ): Promise<{ rect: { x: number; y: number; width: number; height: number }; label: string } | { error: string }> {
    const result = await this.runPage<PageResolveResult>({
      mode: 'resolve',
      ...(target.ref !== undefined ? { ref: target.ref } : {}),
      ...(target.selector ? { selector: target.selector } : {})
    })
    if (isPageFailure(result)) {
      return { error: result.stale ? `${result.error} — ${BROWSER_STALE_REF_RECIPE}` : result.error }
    }
    return {
      rect: { x: result.box.x, y: result.box.y, width: result.box.w, height: result.box.h },
      label: `${result.role}${result.name ? ` "${result.name}"` : ''} (${result.box.w}x${result.box.h})`
    }
  }

  /** O que a página é AGORA, sem custo de árvore — para o cabeçalho do open. */
  async readyState(): Promise<string> {
    return this.evaluate('document.readyState')
  }

  /** O epoch avança à mão quando o main recarrega/navega sem passar pelo CDP. */
  bumpEpoch(): number {
    this.epochValue += 1
    return this.epochValue
  }
}

// ——————————————————————————— registro de sessões ———————————————————————————

/**
 * Uma sessão por `webContents.id`, viva enquanto a aba viver. O registro é do
 * driver e não do manager (H1) de propósito: o manager cuida de janela, bounds
 * e ciclo de vida; o epoch e os anéis são do MOTOR.
 */
export class BrowserDriverRegistry {
  private readonly sessions = new Map<number, BrowserDriverSession>()
  private readonly log: BrowserDriverLog

  constructor(log: BrowserDriverLog = () => undefined) {
    this.log = log
  }

  /**
   * A sessão desta aba, criando-a na primeira vez. A VARREDURA MORA AQUI, e
   * não numa costura de ciclo de vida: cada sessão segura anéis de console e
   * de rede e uma referência ao `webContents`, então aba fechada que ficasse
   * no mapa seria memória presa até o quit. Como toda tool passa por este
   * método, o mapa se mantém sozinho — não existe ponto no app que precise
   * lembrar de limpar o motor, e é justamente esse tipo de lembrete que se
   * perde.
   */
  for(page: BrowserPageLike): BrowserDriverSession {
    for (const [id, session] of this.sessions) {
      if (!session.alive) this.sessions.delete(id)
    }
    const existing = this.sessions.get(page.id)
    if (existing && existing.alive) return existing
    const session = new BrowserDriverSession(page, this.log)
    this.sessions.set(page.id, session)
    return session
  }

  /** Quantas abas o motor segue enxergando — só para diagnóstico/suíte. */
  get size(): number {
    return this.sessions.size
  }
}

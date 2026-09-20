/**
 * O KIT `browser` DOS CHATS — ferramentas do browser embutido (H2 do
 * design `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * Este módulo é a metade que o AGENTE vê. Ele traduz a identidade do pane em
 * MISSÃO (a aba é da missão; a sessão de login é do projeto), chama o motor
 * (`browserDriver`/`browserProbe`/`browserShot`) e devolve TEXTO. Nenhuma
 * mecânica de CDP mora aqui, e nenhuma regra de produto mora lá.
 *
 * É o irmão exato do `guiLspTools.ts` (R14): o `mcpServer.ts` só REGISTRA o
 * catálogo nos dois papéis que o recebem (`gui-delegator` e `ajudante`), pelo
 * mesmo retorno antecipado do resto da casa — reviewer não roda nada (o
 * contrato dele é ler e reportar), e planner/release não abrem browser na v1.
 *
 * TRÊS CERCAS DE CONTRATO, ditas aqui porque é aqui que elas mordem:
 *
 * 1. **Nenhuma tool emite `structuredContent`.** O codex DESCARTA `content[]`
 *    quando há `structuredContent` (`openai/codex#10334`) — o texto sumiria
 *    para metade da frota do dono. Tudo é `content: [{type:'text'}]`, e a
 *    exceção é imagem explicitamente pedida com purpose:"vision" em
 *    browser_shot/browser_check, para o CLI claude. Codex usa o caminho local.
 *
 * 2. **Recusa é RESULTADO, nunca erro de protocolo**, e sempre nomeia a
 *    receita. `BROWSER_ENGINE_OFF` diz em letras maiúsculas que NADA foi
 *    aberto: um agente que racionalizasse "abri e falhou" contaria ao dono um
 *    QA que não aconteceu.
 *
 * 3. **O catálogo é fechado no boot.** Um conjunto pequeno: só as
 *    definições do `chrome-devtools-mcp` custam ~17 000 tokens em TODO prompt
 *    (pesquisa de mercado §2), e cortar 80% do catálogo rendeu à Vercel 3,5×
 *    de velocidade. Kit enxuto vence kit completo.
 *
 * ——— A QUARTA CERCA (2026-09-01): A ABA É SUA ———
 * `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`, D1/D7.
 * Toda tool trabalha na aba DESTA IDENTIDADE (`tabOf(missão, paneId)`), nunca
 * na aba ATIVA da missão. A diferença foi MEDIDA: na missão 86a05c06 (01/09) o
 * único ajudante que dirigiu o browser dividiu a mesma aba com o dev — a URL
 * alternou entre a porta 8791 (dele) e as 8159/8148/8163 (do dev) em minutos,
 * TRÊS leituras dele caíram na página do dev, e o dev o cancelou aos 20 min.
 * Consequências que moram aqui: `browser_open` perdeu o `tabId` (focar a aba de
 * outro não é ação de agente — o dono escolhe o que olhar), a lista de abas
 * passou a nomear o DONO de cada uma (consciência, não controle), e o ⚡ que
 * as tools acendem nomeia a ABA além da missão.
 */
import type { PaneIdentity } from './hub'
import {
  BrowserDriverRegistry,
  type BrowserAction,
  type BrowserDriverLog,
  type BrowserDriverSession,
  type BrowserPageLike,
  type BrowserReadOptions,
  type BrowserViewportOptions,
  type BrowserWaitOptions
} from './browserDriver'
import type { BrowserProbeParams } from './browserProbe'
// DE QUEM É A ABA (2026-09-01). Módulo PURO — importado, não espelhado: o
// espelho abaixo existe para não depender do MANAGER (que arrasta Electron), e
// `browserTabOwner.ts` não tem uma linha dele. Duas cópias do tipo do dono
// virariam duas ideias diferentes de dono na terceira correção.
import {
  browserTabOwnerLabel,
  type BrowserTabOwner
} from './browserTabOwner'
import {
  BROWSER_VIEWPORT_MAX_WIDTH,
  BROWSER_VIEWPORT_MIN_WIDTH,
  normalizeViewportMode,
  viewportReceipt,
  type BrowserViewportMode
} from './browserViewport'
import type { BrowserShotResult, ShotCapturer } from './browserShot'
import { captureBrowserToolShot, type BrowserToolShotInput } from './browserToolCapture'
import { instrumentBrowserToolkit } from './browserToolMetrics'
import { runBrowserCheck, validateBrowserCheck, type BrowserCheckInput, type BrowserCheckResult } from './browserCheck'
import { browserResponseBudget, boundBrowserText } from './browserObservation'
import { sanitizeGuiArtifactPreviewText } from './guiFileBrowserUrl'

// ————————————————————————— espelho do contrato da H1 —————————————————————————
//
// ESPELHO DECLARADO de `BrowserManager` (`src/main/browserPane.ts`, fatia H1 —
// o bloco de interface do design). Declarado aqui, e não importado, por uma
// razão de engenharia: este módulo continua compilando e TESTÁVEL sem o
// manager real, e o `webContents` vira exatamente as duas fatias que o motor
// usa (dirigir e capturar). O par é conferido de verdade no `index.ts`, que
// importa o tipo REAL da H1 e passa a instância — se os dois divergirem, o
// erro nasce no ponto certo: a costura.
export interface BrowserManagerTab {
  tabId: string
  webContents: BrowserPageLike & ShotCapturer
}

export interface BrowserManagerLike {
  /** OWNER-AWARE (D1): abre/reusa a aba DESTA identidade — nunca a de outro. */
  ensureTab(
    missionId: string,
    projectId: string,
    url: string | undefined,
    owner: BrowserTabOwner
  ): Promise<BrowserManagerTab>
  /** A PORTA DE ENTRADA de toda tool: a aba viva desta identidade. */
  tabOf(missionId: string, ownerPaneId: string): BrowserManagerTab | undefined
  /** A aba que o DONO está olhando. NÃO é a régua das tools desde 01/09 — está
   *  aqui porque é o que o `browser_open` usa quando a identidade não tem pane
   *  (só o dono nasce assim) e porque o espelho acompanha o contrato inteiro. */
  activeTab(missionId: string): BrowserManagerTab | undefined
  listTabs(missionId: string): {
    tabId: string
    title: string
    url: string
    active: boolean
    owner: BrowserTabOwner
    driving: boolean
  }[]
  selectTab(missionId: string, tabId: string): boolean
  closeMission(missionId: string): void
  /** D3 — a aba do ajudante morre com ele. Quem chama é o `dispose` do motor de
   *  ajudantes (fiação do índice), não este kit; o espelho acompanha porque o
   *  par é o `BrowserManager` inteiro. */
  closeTabsOf(ownerPaneId: string): number
  setAgentDriving(missionId: string, driving: boolean, tabId?: string): void
  /**
   * A GUARDA DA CAPTURA (P5), oferecida pela H1. Opcional no espelho de
   * propósito: o dublê da suíte não precisa dela, e quando ela existe é a
   * recusa RÁPIDA que evita a pendura de 5-8s da view desanexada. O relógio do
   * `browserShot` continua sendo o cinto — guarda e teto não se substituem.
   */
  captureReadiness?(
    missionId: string,
    tabId?: string
  ): { ok: true; tab: BrowserManagerTab } | { ok: false; error: string }
  /**
   * A LARGURA QUE A PÁGINA ENXERGA (2026-08-29) — a metade de `browser_viewport`
   * que NÃO é CDP. Ela mora no motor porque é geometria do painel: o zoom de
   * ajuste sai da moldura, que muda quando o dono arrasta a alça ou destaca o
   * browser (⧉). Escrever aqui é escrever o MESMO campo que o seletor do chrome
   * mostra — uma autoridade só, para o dono nunca olhar uma página emulada por
   * ordem do agente e achar que o site quebrou.
   * Opcional no espelho pelo mesmo motivo do `captureReadiness`: o dublê da
   * suíte não precisa dela, e sem ela a tool diz a verdade (não emula largura).
   */
  setViewportMode?(
    missionId: string,
    mode: BrowserViewportMode,
    /** O terceiro argumento é o que impede a caixa-preta de creditar ao DONO uma
     *  emulação que o agente ligou sozinho. */
    actor?: 'user' | 'agent',
    /** E o quarto é a ABA (2026-09-01): a largura é da SUA, não da que o dono
     *  está olhando — com a frota na mesma missão, escrever na ativa emularia a
     *  página de um vizinho. */
    tabId?: string
  ): { ok: true } | { ok: false; error: string }
  viewportOf?(missionId: string, tabId?: string): BrowserViewportMode
  /** A moldura de AGORA — o recibo precisa dela para contar a largura efetiva
   *  (o piso de zoom do Chromium morde em painel estreito). */
  viewportFrameWidth?(missionId: string): number
}

// ————————————————————————————— o contrato do kit —————————————————————————————

/** Onde o browser desta conversa vive: missão (aba) + projeto (sessão) + raiz
 *  (onde o `browser_shot` grava) + o DONO da aba (quem é esta conversa). */
export interface BrowserTarget {
  missionId: string
  projectId: string
  root: string
  /** A IDENTIDADE, em forma de dono de aba (D1). `paneId` é o pane desta
   *  conversa — é ele que decide QUAL aba as tools dirigem. */
  owner: BrowserTabOwner
}

export interface GuiBrowserToolkit {
  /** D7 — sem `tabId`: com uma aba por identidade, focar a aba de outro não é
   *  ação do agente (o dono escolhe o que olhar no chrome). */
  open(id: PaneIdentity, input: { url?: string; read?: BrowserReadOptions }): Promise<string>
  read(id: PaneIdentity, input: BrowserReadOptions): Promise<string>
  find(id: PaneIdentity, input: { query: string; role?: string }): Promise<string>
  act(
    id: PaneIdentity,
    input: { actions: BrowserAction[]; read?: BrowserReadOptions }
  ): Promise<string>
  probe(id: PaneIdentity, input: BrowserProbeParams): Promise<string>
  check(id: PaneIdentity, input: BrowserCheckInput): Promise<BrowserCheckResult>
  shot(id: PaneIdentity, input: BrowserToolShotInput): Promise<BrowserShotResult>
  viewport(id: PaneIdentity, input: BrowserViewportOptions): Promise<string>
  console(
    id: PaneIdentity,
    input: { onlyErrors?: boolean; pattern?: string; limit?: number }
  ): Promise<string>
  network(
    id: PaneIdentity,
    input: { urlPattern?: string; onlyFailures?: boolean; limit?: number; requestId?: string }
  ): Promise<string>
  evaluate(id: PaneIdentity, input: { expression: string }): Promise<string>
  wait(id: PaneIdentity, input: BrowserWaitOptions): Promise<string>
}

/**
 * Os nomes do catálogo, em UM lugar só. A pré-sanção do claude
 * (`GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS`) e as suítes leem daqui — lista
 * duplicada à mão é exatamente como uma tool nova volta a levantar card de
 * permissão para o dono no gesto que ele acabou de pedir (lição da R14).
 */
export const BROWSER_TOOL_NAMES: readonly string[] = [
  'browser_open',
  'browser_read',
  'browser_find',
  'browser_act',
  'browser_check',
  'browser_probe',
  'browser_shot',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_eval',
  'browser_wait'
]

/**
 * A resposta quando o harness ainda não ligou o motor do browser. É RESULTADO,
 * não erro de protocolo (mesma doutrina de `DELEGATION_ENGINE_OFF` e amigos):
 * o chat continua conversando e o agente lê a frase, em vez de racionalizar um
 * -32603 como "abri o browser e falhou".
 */
export const BROWSER_ENGINE_OFF =
  'o motor do browser ainda não está ligado — reinicie o app para reabrir esta conversa com as ferramentas de browser. NADA foi aberto, NADA foi navegado e NENHUMA tela foi verificada: não relate QA visual nenhum ao dono.'

/** O browser é o painel de UMA missão. Endereço órfão não abre nada. */
export const BROWSER_NO_MISSION =
  'esta conversa não está ligada a uma missão — o browser embutido é o painel de UMA missão (a aba é dela; a sessão de login é do projeto). NADA foi aberto.'

/**
 * A recusa de quem ainda não tem A SUA aba (D1). Ela nomeia a receita — e diz
 * "SUA" de propósito: até 01/09 as tools caíam na aba ATIVA da missão, e a
 * medição daquele dia (missão 86a05c06) mostrou o agente lendo a página do dev
 * e relatando-a como se fosse a dele. Nenhuma tool tem verbo para a aba alheia.
 */
export const BROWSER_NO_TAB =
  'a SUA aba do browser não está aberta nesta missão. Receita: chame browser_open com a URL que você quer verificar — ele abre A SUA aba (o dono a vê aparecer no painel BROWSER) e já devolve a leitura inicial da página. As abas dos outros aparecem na lista do browser_open, mas você não dirige nenhuma delas.'

// ————————————————————————————— a implementação —————————————————————————————

export interface GuiBrowserToolsDeps {
  manager: BrowserManagerLike
  /** Missão/projeto/raiz desta identidade. O AJUDANTE herda do delegador: ele
   *  trabalha no mesmo worktree e deve enxergar o mesmo browser. */
  resolveTarget(id: PaneIdentity): BrowserTarget | undefined
  /** O CLI do pane. Só o claude recebe a imagem inline — o codex a descarta
   *  (`openai/codex#10334`), e mandá-la seria pagar banda por nada. */
  cliOf(id: PaneIdentity): 'claude' | 'codex' | undefined
  log?: BrowserDriverLog
}

/** Quanto o ⚡ do chrome fica aceso depois da última ação do agente. */
const AGENT_DRIVING_LINGER_MS = 2_000

/**
 * Os presets do agente → o MESMO vocabulário do seletor do dono (o botão que
 * ele clica é o mesmo estado que esta tool escreve).
 *
 * `desktop` MUDOU DE SENTIDO em 2026-08-29 e a mudança é deliberada: ele
 * emulava "o tamanho real do painel" (que é o `auto` de hoje) e agora emula
 * 1280 lógicos, que é o que alguém quer dizer ao pedir desktop num painel de
 * 400px. Quem quer a moldura de verdade pede `auto`.
 */
const VIEWPORT_PRESET_WIDTHS: Record<string, BrowserViewportMode> = {
  auto: 'auto',
  mobile: 375,
  tablet: 768,
  desktop: 1280
}

/**
 * O que o agente pediu, em modo do motor. Três respostas possíveis, e as três
 * importam: `undefined` = não pediu largura nenhuma (só tema), `null` = pediu
 * uma que não existe (recusa com receita), ou o modo.
 */
function viewportModeFrom(input: BrowserViewportOptions): BrowserViewportMode | null | undefined {
  if (input.width !== undefined) {
    const mode = normalizeViewportMode(input.width)
    return mode ?? null
  }
  if (input.preset === undefined) return undefined
  return VIEWPORT_PRESET_WIDTHS[input.preset] ?? null
}

export function buildGuiBrowserTools(deps: GuiBrowserToolsDeps): GuiBrowserToolkit {
  const log = deps.log ?? ((): void => undefined)
  const registry = new BrowserDriverRegistry(log)
  const drivingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** O ⚡ do chrome: acende ao começar a agir e apaga ~2s depois da última
   *  ação. É INDICADOR, nunca trava — o dono assume quando quiser (D5.2).
   *  Desde 01/09 ele nomeia a ABA: com uma frota na mesma missão, "alguém está
   *  dirigindo" não responde a pergunta que o dono faz olhando o painel. */
  const markDriving = (missionId: string, tabId: string): void => {
    deps.manager.setAgentDriving(missionId, true, tabId)
    const key = `${missionId}::${tabId}`
    const previous = drivingTimers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      drivingTimers.delete(key)
      deps.manager.setAgentDriving(missionId, false, tabId)
    }, AGENT_DRIVING_LINGER_MS)
    if (typeof timer.unref === 'function') timer.unref()
    drivingTimers.set(key, timer)
  }

  /**
   * A ABA DESTA CONVERSA. Com `paneId` (todo agente tem um) é a aba DELE; sem
   * ele — só o dono nasce assim, e nenhum caminho do produto chega aqui — cai
   * na aba ativa, a semântica de antes do dono de aba. Simétrico ao `ensureTab`
   * do motor, de propósito: as duas pontas degradam do mesmo jeito.
   */
  const ownTab = (target: BrowserTarget): BrowserManagerTab | undefined =>
    target.owner.paneId
      ? deps.manager.tabOf(target.missionId, target.owner.paneId)
      : deps.manager.activeTab(target.missionId)

  /** A porta de entrada de TODA tool: identidade → missão → A SUA aba viva →
   *  sessão CDP. Sem a sua aba, a recusa manda abrir A SUA (a receita). */
  const withSession = async <T>(
    id: PaneIdentity,
    run: (session: BrowserDriverSession, target: BrowserTarget, tab: BrowserManagerTab) => Promise<T>,
    onMissing: (reason: string) => T
  ): Promise<T> => {
    const target = deps.resolveTarget(id)
    if (!target) return onMissing(BROWSER_NO_MISSION)
    const tab = ownTab(target)
    if (!tab) return onMissing(BROWSER_NO_TAB)
    markDriving(target.missionId, tab.tabId)
    const session = registry.for(tab.webContents)
    await session.ensureAttached()
    return run(session, target, tab)
  }

  const failText = (reason: string): string => reason

  /**
   * A LISTA DE ABAS DA MISSÃO, com o dono de cada uma — CONSCIÊNCIA, não
   * controle (D7). O agente precisa saber que existe uma frota na mesma missão
   * (e que a página que o dono está olhando pode não ser a dele); o que ele não
   * tem é verbo para dirigir aba alheia.
   */
  const tabsBlock = (target: BrowserTarget, ownTabId: string): string => {
    const tabs = deps.manager.listTabs(target.missionId)
    if (tabs.length === 0) return ''
    const lines = tabs.map((tab) => {
      const marks = `${tab.active ? '▸' : ' '}${tab.driving ? '⚡' : ' '}`
      const mine = tab.tabId === ownTabId ? '  ← a SUA' : ''
      return sanitizeGuiArtifactPreviewText(`${marks} ${browserTabOwnerLabel(tab.owner)}: ${tab.title || tab.url || 'em branco'}${mine}`)
    })
    return `\n\nabas desta missão (▸ = a que o dono está vendo · ⚡ = sendo dirigida):\n${lines.join(
      '\n'
    )}`
  }

  const toolkit: GuiBrowserToolkit = {
    async open(id, input) {
      const target = deps.resolveTarget(id)
      if (!target) return BROWSER_NO_MISSION
      let tab: BrowserManagerTab
      try {
        // O DONO viaja com o pedido (D1): o motor reusa A DELE ou cria A DELE —
        // e a que nasce vira a ativa, para o dono ver o recém-chegado (D2).
        tab = await deps.manager.ensureTab(
          target.missionId,
          target.projectId,
          input.url,
          target.owner
        )
      } catch (error) {
        return `não consegui abrir o browser desta missão: ${
          sanitizeGuiArtifactPreviewText(error instanceof Error ? error.message : String(error))
        }. NADA foi aberto. Receita: chame browser_open com a URL desta missão para tentar novamente.`
      }
      let initial: string
      let loaded = false
      const budget = browserResponseBudget(input.read)
      let stage: 'attach' | 'load' | 'read' = 'attach'
      try {
        markDriving(target.missionId, tab.tabId)
        const session = registry.for(tab.webContents)
        await session.ensureAttached()
        // Espera curta pelo carregamento: sem ela a leitura inicial fotografaria
        // o esqueleto e o agente concluiria que a página "está vazia".
        stage = 'load'
        const deadline = Date.now() + 8_000
        while (Date.now() < deadline) {
          const state = await session.readyState()
          if (state === 'complete' || state === 'interactive') { loaded = true; break }
          await new Promise((resolve) => setTimeout(resolve, 120))
        }
        stage = 'read'
        const blank = tab.webContents.getURL() === 'about:blank'
          ? 'a SUA aba está em branco. Receita: chame browser_open com a URL que você quer verificar nesta missão. Nenhuma página do projeto foi verificada.\n\n'
          : ''
        const loading = loaded ? '' : 'CARREGAMENTO EM ANDAMENTO: esta observação pode ser parcial. Receita: browser_wait com selector/text e depois browser_read.\n'
        const before = boundBrowserText(blank + loading, Math.min(300, Math.max(0, budget - 200)))
        const tabs = boundBrowserText(tabsBlock(target, tab.tabId), Math.min(600, Math.max(0, budget - before.length - 200)), 'browser_open com read.responseMaxChars maior para listar todas as abas')
        // Reserve wrapper text BEFORE observing. Truncating afterward could expose
        // a baseline id while silently withholding part of that observation.
        const observation = await session.observe({ ...input.read, responseMaxChars: budget - before.length - tabs.length })
        if (!observation.ok) throw new Error('initial observation incomplete')
        initial = `${before}${observation.text}${tabs}`
      } catch {
        // A aba já nasceu: dizer "NADA foi aberto" seria falso. CDP pode cair
        // numa troca de página; a receita retoma só a aba desta identidade.
        log({
          event: 'browser-open-incomplete',
          ids: { paneId: id.paneId, missionId: target.missionId, projectId: target.projectId },
          detail: { tabId: tab.tabId, stage }
        })
        if (tab.webContents.isDestroyed()) return BROWSER_NO_TAB
        return 'a SUA aba está aberta, mas não consegui concluir a leitura inicial. NENHUMA tela foi verificada. Receita: chame browser_open novamente com a URL desta missão para retomar a mesma aba; se ela ainda estiver carregando, use browser_wait e depois browser_read.'
      }
      log({
        event: 'browser-open',
        // D6 — AUTORIA: até 01/09 o `browser-open` saía SEM `paneId` e o diário
        // não sabia quem tinha aberto o quê.
        ids: { paneId: id.paneId, missionId: target.missionId, projectId: target.projectId },
        detail: {
          missionId: target.missionId,
          tabId: tab.tabId,
          owner: target.owner
        }
      })
      return initial
    },

    read: (id, input) => withSession(id, (session) => session.read(input), failText),

    find: (id, input) => withSession(id, (session) => session.find(input.query, input.role), failText),

    act: (id, input) =>
      withSession(id, (session) => session.act(input.actions, input.read ?? {}), failText),

    probe: (id, input) => withSession(id, (session) => session.probe(input), failText),

    async shot(id, input) {
      return withSession<BrowserShotResult>(
        id,
        (session, target, tab) => captureBrowserToolShot({
          session,
          capturer: tab.webContents,
          root: target.root,
          missionId: target.missionId,
          title: tab.webContents.getTitle(),
          url: tab.webContents.getURL(),
          cli: deps.cliOf(id),
          readiness: deps.manager.captureReadiness?.(target.missionId, tab.tabId)
        }, input),
        (reason) => ({ ok: false, text: reason })
      )
    },

    async check(id, input) {
      const invalid = validateBrowserCheck(input)
      const fail = (text: string): BrowserCheckResult => ({ ok: false, text, localSteps: 0, completedScenarios: 0 })
      if (invalid) return fail(`browser_check recusado: ${invalid}. Receita: corrija o roteiro; NENHUM passo foi executado.`)
      const resolved = deps.resolveTarget(id)
      if (!resolved) return fail(BROWSER_NO_MISSION)
      const target = { ...resolved, owner: { ...resolved.owner } }
      const paneId = id.paneId
      const role = id.role
      // Open only this identity's tab. A recipe with no URL reuses it; it never borrows the active tab.
      let tab = ownTab(target)
      if (input.url || !tab) {
        try {
          tab = await deps.manager.ensureTab(target.missionId, target.projectId, input.url, target.owner)
        } catch { return fail('não consegui abrir a SUA aba. Receita: browser_open com a URL desta missão; nenhuma verificação foi concluída.') }
      }
      const checkedTab = tab
      let expectedWidth: BrowserViewportMode | undefined
      try {
        markDriving(target.missionId, checkedTab.tabId)
        const session = registry.for(checkedTab.webContents)
        await session.ensureAttached()
        return await runBrowserCheck({
          driver: session,
          guard: () => {
            const currentTarget = deps.resolveTarget(id)
            if (!currentTarget || currentTarget.missionId !== target.missionId ||
              currentTarget.projectId !== target.projectId || currentTarget.root !== target.root ||
              currentTarget.owner.paneId !== target.owner.paneId || currentTarget.owner.kind !== target.owner.kind ||
              id.paneId !== paneId || id.role !== role) {
              return { ok: false, error: 'o vínculo desta identidade com a missão mudou; interrompi o roteiro. Receita: browser_open no contexto atual antes de nova verificação.' }
            }
            const current = ownTab(target)
            if (!current || current.tabId !== checkedTab.tabId || current.webContents !== checkedTab.webContents || current.webContents.isDestroyed()) {
              return { ok: false, error: 'a SUA aba mudou ou fechou; interrompi o roteiro. Receita: browser_open e reveja o estado antes de repetir.' }
            }
            if (expectedWidth !== undefined && deps.manager.viewportOf && deps.manager.viewportOf(target.missionId, checkedTab.tabId) !== expectedWidth) {
              return { ok: false, error: 'a largura foi alterada fora deste roteiro; interrompi para preservar o controle do dono. Receita: confirme a largura em browser_read antes de novo browser_check.' }
            }
            return { ok: true }
          },
          viewport: (width) => {
            const result = deps.manager.setViewportMode?.(target.missionId, width, 'agent', checkedTab.tabId)
            if (!result) return { ok: false, error: 'este harness não controla a largura. Receita: use browser_viewport após atualizar o app; nenhuma largura foi emulada.' }
            if (result.ok) expectedWidth = width
            return result
          },
          capture: (shot) => captureBrowserToolShot({
            session,
            capturer: checkedTab.webContents,
            root: target.root,
            missionId: target.missionId,
            title: checkedTab.webContents.getTitle(),
            url: checkedTab.webContents.getURL(),
            cli: deps.cliOf(id),
            readiness: deps.manager.captureReadiness?.(target.missionId, checkedTab.tabId)
          }, shot)
        }, input)
      } catch { return fail('a SUA aba está aberta, mas o motor não concluiu a verificação. Receita: browser_read ou browser_open para recuperar a mesma aba; nenhum QA foi confirmado.') }
    },

    /**
     * `browser_viewport` = DUAS metades, e cada uma tem um dono diferente.
     *
     * A LARGURA é do MOTOR (o painel): o zoom de ajuste sai da moldura, e é o
     * mesmo estado que o dono vê e muda no seletor do chrome. A tool escreve ali
     * em vez de emular por CDP — se ela emulasse, existiriam duas verdades sobre
     * a largura e o seletor do dono mostraria uma mentira.
     *
     * O TEMA (`prefers-color-scheme`) é do DRIVER: é emulação de mídia, não
     * geometria, e ninguém no chrome manda nele.
     */
    viewport: (id, input) =>
      withSession(
        id,
        async (session, target, tab) => {
          const extras: string[] = []
          const wanted = viewportModeFrom(input)
          if (wanted === null) {
            return `largura não reconhecida — use \`preset\` (auto · mobile · tablet · desktop) ou \`width\` entre ${BROWSER_VIEWPORT_MIN_WIDTH} e ${BROWSER_VIEWPORT_MAX_WIDTH}. NADA mudou.`
          }
          if (input.colorScheme) extras.push(await session.colorScheme(input.colorScheme))
          if (wanted === undefined) {
            if (extras.length === 0) {
              return 'nada mudou — informe `preset`, `width` ou `colorScheme`.'
            }
            // Só o tema: o recibo ainda conta a largura de agora, porque é ela
            // que explica as medidas que o `browser_probe` vai devolver. E a
            // largura de agora é a DESTA aba, não a da que o dono está olhando.
            const mode = deps.manager.viewportOf?.(target.missionId, tab.tabId) ?? 'auto'
            return viewportReceipt(mode, deps.manager.viewportFrameWidth?.(target.missionId) ?? 0, extras)
          }
          const apply = deps.manager.setViewportMode?.(
            target.missionId,
            wanted,
            'agent',
            tab.tabId
          )
          if (!apply) {
            return `este harness não controla a largura da página (motor antigo) — só o tema foi aplicado.${
              extras.length ? `\n${extras.join('\n')}` : ''
            }`
          }
          if (!apply.ok) return `${apply.error}. A largura NÃO mudou.`
          return viewportReceipt(
            wanted,
            deps.manager.viewportFrameWidth?.(target.missionId) ?? 0,
            extras
          )
        },
        failText
      ),

    console: (id, input) =>
      withSession(id, async (session) => session.consoleText(input), failText),

    network: (id, input) =>
      withSession(
        id,
        async (session) =>
          input.requestId ? session.networkBody(input.requestId) : session.networkText(input),
        failText
      ),

    evaluate: (id, input) => withSession(id, (session) => session.evaluate(input.expression), failText),

    wait: (id, input) => withSession(id, (session) => session.wait(input), failText)
  }
  return instrumentBrowserToolkit(toolkit, deps.resolveTarget, log)
}

export { registerBrowserKit } from './browserToolCatalog'

/**
 * MOTOR DOS AJUDANTES SEM ABA (Synkora 2.0 — D1 do design vinculante
 * `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
 *
 * Ordem do dono (18/08): "ele NUNCA MAIS vai abrir subagentes dele — ele vai
 * abrir subagentes via MCP. Porque via MCP eu vejo na lateral o MODELO e o
 * EFFORT que subiu". Este módulo é o lado do harness dessa ordem: um ajudante é
 * uma sessão HEADLESS do CLI, dona de um pane delegador, que recebe um prompt,
 * trabalha, entrega o texto final e MORRE. Ele nunca vira aba, nunca vira
 * terminal, e todo fato que a lateral mostra (modelo, effort, conta, atividade,
 * contexto, desfecho) nasce aqui.
 *
 * O QUE ESTE MÓDULO NÃO SABE, DE PROPÓSITO:
 * - não conhece `MaestroSession`/`CodexSession`: os dois motores entram por
 *   ADAPTADOR injetado (`spawnClaude`/`spawnCodex`). O que o motor precisa de um
 *   CLI cabe em quatro linhas — mandar prompt, receber eventos, dirigir, matar —
 *   e é só isso que o adaptador promete;
 * - não conhece `SeatStore`: a conta chega por `resolveSeat`, que é quem sabe
 *   quais estão logadas;
 * - não conhece electron, disco nem rede. É por isso que a máquina de estados, o
 *   backstop, o long-poll e o watchdog são provados em node puro
 *   (`test:gui-helper-sessions`) em vez de conferidos no olho com o app aberto.
 *
 * - não sabe ESCREVER a entrega: o arquivo canônico de cada ajudante nasce pelo
 *   `deliver` injetado (2026-08-18, ordem do dono: "todo ajudante sempre entrega
 *   em modelo de ARQUIVO"). O motor só decide QUANDO gravar e guarda o caminho.
 *
 * SEM CADEIA (cerca dura do D1): o `GuiHelperSpawnRequest` NÃO tem campo de
 * ferramenta. Ajudante nasce sem o MCP de delegação — quem delega é o chat do
 * dono, e uma frota que abre frota é justamente o laço que o backstop existe
 * para conter. Acrescentar `mcp`/`extraArgs` aqui reabriria a cadeia.
 *
 * FATOS MEDIDOS QUE VIRARAM CÓDIGO (sondas de 2026-08-18, no scratchpad:
 * probe-helper-matrix, probe-claude-fence, probe-codex-fence):
 * - claude em `-p` é FIRE-AND-FORGET: entrega o `result` e morre sozinho com
 *   exit 0 (§2.6). Por isso `closed` é DESFECHO neste motor, não ruído;
 * - o `app-server` do codex NUNCA encerra sozinho ao fim do turno (§6). Por isso
 *   todo desfecho chama `dispose()` — o kill é do motor, não do chamador;
 * - a tool MCP do claude é cortada em EXATOS 60s por default e o codex ABANDONA
 *   a espera sem cancelar o HTTP (S3). Por isso o teto do long-poll é do
 *   SERVIDOR: 45s de padrão, 240s de máximo, sempre grampeado aqui;
 * - modelo sem `supportsEffort` (haiku) engole `--effort` sem avisar (§2.4), e
 *   effort variado numa frota claude estoura o prompt-cache (§2.3, 3,7× medido).
 *   As duas armadilhas viraram função pura, para o aviso existir antes do gasto.
 *
 * FORA DE ESCOPO (MVP, explícito no design): ajudante NÃO sobrevive a restart do
 * app. O registro é de memória; o boot encerra os órfãos do anel como
 * `cancelled`, e nada aqui persiste.
 */
import { randomUUID } from 'node:crypto'

export type GuiHelperCli = 'claude' | 'codex'

/**
 * `spawning` = pedido aceito, processo nascendo; `working` = o CLI deu o
 * primeiro sinal de vida. Os três desfechos são finais e mutuamente exclusivos.
 */
export type GuiHelperState = 'spawning' | 'working' | 'done' | 'failed' | 'cancelled'

export const GUI_HELPER_TERMINAL_STATES: readonly GuiHelperState[] = [
  'done',
  'failed',
  'cancelled'
]

export function isGuiHelperSettled(state: GuiHelperState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

// ————— tetos —————

/** Briefing de ajudante é recorte de trabalho, não anexo: acima disto RECUSA.
 *  Truncar um briefing é pior que recusá-lo — o ajudante trabalharia sobre meia
 *  instrução sem ninguém saber qual metade sumiu. */
export const GUI_HELPER_PROMPT_MAX_CHARS = 64 * 1024

/**
 * Teto da ENTREGA guardada EM MEMÓRIA, aviso incluído (o corte nunca empurra o
 * aviso para fora). Ele não é mais o fim da linha: desde 2026-08-18 o texto
 * INTEIRO vai para o arquivo canônico do worktree (ver `deliver` nas deps), e
 * este teto passou a governar só a cópia que o motor carrega para responder na
 * hora.
 */
export const GUI_HELPER_RESULT_MAX_CHARS = 64 * 1024

export const GUI_HELPER_RESULT_TRUNCATION_NOTICE =
  '\n\n[synkora] entrega cortada no teto de 64KB — o texto inteiro está no arquivo da entrega. Abra o arquivo, nunca peça o texto de novo ao ajudante.'

/**
 * BACKSTOP ANTI-RUNAWAY — NUNCA UMA COTA.
 *
 * Ordem do dono (18/08): "não precisa ter um teto — ele quiser delegar vinte,
 * trinta, o problema é dele". Cem ajudantes VIVOS no mesmo chat está muito acima
 * de qualquer uso real; este número existe só para um bug em laço (delegação que
 * se chama sozinha) não derrubar a máquina — o mesmo papel do teto de 1000
 * agentes do Workflow. A recusa nomeia o cenário de bug, e nunca fala em quota.
 */
export const GUI_HELPER_RUNAWAY_BACKSTOP = 100

/**
 * Quantos ENCERRADOS um pane lembra. Tem de ser MAIOR que o backstop: se
 * coubessem menos encerrados do que ajudantes vivos, uma frota no teto perderia
 * o resultado dos primeiros antes de o delegador conseguir lê-los — o motor
 * comeria o próprio trabalho.
 */
export const GUI_HELPER_SETTLED_MEMORY = 2 * GUI_HELPER_RUNAWAY_BACKSTOP

/** Espera padrão do `helper_result` (o corte de 60s do claude é o limite duro
 *  do outro lado; 45s deixa margem para latência — sonda S3/D4). */
export const GUI_HELPER_WAIT_DEFAULT_SECONDS = 45

/** Teto do SERVIDOR. O codex desiste sem cancelar o HTTP (probe-codex-fence
 *  §B.3): quem espera precisa de relógio próprio, nunca do cliente. */
export const GUI_HELPER_WAIT_MAX_SECONDS = 240

/** Ajudante vivo além disto é falha, não paciência. */
export const GUI_HELPER_WATCHDOG_MS = 30 * 60 * 1000

/** A lateral mostra o RESUMO da última ferramenta; anunciar cada linha viraria
 *  enxurrada de card sintetizado no anel do delegador. */
export const GUI_HELPER_ACTIVITY_THROTTLE_MS = 2_000

// ————— o contrato do adaptador (o mínimo que um CLI precisa prometer) —————

/**
 * O que o motor consome de uma sessão. É um SUBCONJUNTO do `SessionEvent` dos
 * dois motores, traduzido pela costura da onda 2 — de propósito: quanto menos o
 * motor souber do protocolo, menos ele quebra quando um CLI atualiza.
 */
export type GuiHelperEvent =
  /** Pedaço do texto do agente; o motor acumula. */
  | { type: 'text'; text: string }
  /** Resumo curto do que ele está fazendo agora (nome de ferramenta, arquivo). */
  | { type: 'activity'; summary: string }
  /** Contexto vivo medido pelo CLI; `null` = o backend não informou. */
  | { type: 'context'; contextTokens: number | null }
  /** Fim do turno. `text` ausente = usa o acumulado. */
  | { type: 'result'; isError: boolean; text?: string; errorText?: string }
  /** Queda do próprio canal (binário sumiu, protocolo quebrou). */
  | { type: 'fatal'; text: string }
  /** O processo morreu. NO CLAUDE ISSO É O DESFECHO NORMAL (sonda §2.6). */
  | { type: 'closed'; code?: number | null }

export interface GuiHelperProcess {
  /** Steering no ajudante vivo — os dois motores aceitam mensagem em turno. */
  send(text: string): void
  /** Encerra o processo. TEM de ser idempotente: o motor descarta em todo
   *  desfecho, e o claude pode já ter morrido sozinho antes. */
  dispose(): void
}

/** A conta que vai rodar o ajudante, já resolvida por quem conhece o SeatStore. */
export interface GuiHelperSeat {
  seatId: string
  /** CLAUDE_CONFIG_DIR / CODEX_HOME — o isolamento da conta. */
  configDir: string
  name?: string
}

/**
 * Tudo que o adaptador recebe para nascer. NENHUM campo de ferramenta, e isso é
 * cerca, não esquecimento (ver SEM CADEIA no cabeçalho).
 */
export interface GuiHelperSpawnRequest {
  helperId: string
  projectId: string
  /** Pane dono deste ajudante — o ciclo de vida é amarrado a ele. */
  delegatorPaneId: string
  /** Worktree da missão: o ajudante trabalha ao lado do dev, no mesmo lugar. */
  cwd: string
  cli: GuiHelperCli
  model: string
  /** Já passou pela régua do `helperEffortDecision`: ausente = não mandar flag. */
  effort?: string
  seat: GuiHelperSeat
  prompt: string
  /** Modo de permissão do delegador — o ajudante herda a mão do dono. */
  permissionMode?: string
}

export type GuiHelperSpawnAdapter = (
  request: GuiHelperSpawnRequest,
  emit: (event: GuiHelperEvent) => void
) => GuiHelperProcess

// ————— o registro —————

export interface GuiHelperActivity {
  at: number
  summary: string
}

export interface GuiHelperRecord {
  helperId: string
  delegatorPaneId: string
  projectId: string
  /** Apelido dado pelo delegador — é o rótulo do card na lateral. */
  name?: string
  /** Worktree onde o ajudante trabalhou (o MESMO do delegador). Mora no
   *  registro porque é onde a ENTREGA EM ARQUIVO pousa: quem escreve o arquivo
   *  recebe o registro, não o pedido de spawn, que já morreu no nascimento. */
  cwd: string
  cli: GuiHelperCli
  model: string
  /** O que a UI pode carimbar HONESTAMENTE (ausente = o CLI não recebeu nível). */
  effort?: string
  seatId: string
  seatName?: string
  prompt: string
  state: GuiHelperState
  startedAt: number
  settledAt?: number
  lastActivity?: GuiHelperActivity
  contextTokens?: number
  /** Presente só em `done` — já cortado no teto. */
  result?: string
  resultTruncated?: boolean
  /** ARQUIVO canônico da entrega, relativo ao worktree — o endereço que o
   *  delegador abre. Ausente = o disco recusou (ver `deliveryError`). */
  resultPath?: string
  /** Por que a entrega não virou arquivo. Silêncio aqui faria o delegador
   *  procurar um arquivo que nunca existiu. */
  deliveryError?: string
  /** Motivo de `failed`/`cancelled`, na voz de quem encerrou. */
  failure?: string
}

/**
 * O QUE VAI PARA O DISCO no desfecho — o texto INTEIRO, antes do teto de 64KB.
 *
 * Ordem do dono (2026-08-18, 5º teste ao vivo): "todo ajudante sempre entrega em
 * modelo de ARQUIVO". A persona pede isso ao ajudante (cinto), mas persona não é
 * mecanismo: um ajudante que despeje 200KB no texto final continuaria custando o
 * contexto do delegador. Este é o suspensório — o harness grava SEMPRE, e o que
 * viaja inline vira um começo com o caminho na frente.
 */
export interface GuiHelperDelivery {
  /** Fotografia do registro JÁ encerrado (state/settledAt/failure preenchidos). */
  record: GuiHelperRecord
  /** Entrega inteira, sem teto: o arquivo é onde nada se perde. */
  text: string
}

export type GuiHelperDeliveryOutcome =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * A fotografia do `helpers_status`: estado, decorrido, última atividade e
 * contexto. SEM o texto da entrega — cem ajudantes × 64KB numa chamada de
 * status seria a resposta mais cara do catálogo, e para ler a entrega existe o
 * `helper_result`.
 */
export interface GuiHelperSnapshot {
  helperId: string
  name?: string
  cli: GuiHelperCli
  model: string
  effort?: string
  seatId: string
  seatName?: string
  state: GuiHelperState
  startedAt: number
  elapsedMs: number
  settledAt?: number
  lastActivity?: GuiHelperActivity
  contextTokens?: number
  hasResult: boolean
  /** O arquivo da entrega — a fotografia diz ONDE ler, nunca O QUE foi escrito. */
  resultPath?: string
  failure?: string
}

// ————— o pedido —————

/** O chat que delega: o ajudante o CLONA quando o pedido não diz o contrário. */
export interface GuiHelperDelegator {
  paneId: string
  projectId: string
  cwd: string
  cli: GuiHelperCli
  model: string
  effort?: string
  seatId: string
  permissionMode?: string
}

export interface GuiHelperRequest {
  prompt: string
  /** Ausente = o modelo do delegador. É ele que decide o CLI (ver resolveHelperCli). */
  model?: string
  effort?: string
  /** Conta pedida explicitamente — o delegador escolhe onde gastar limite. */
  seatId?: string
  name?: string
}

export type GuiHelperReceipt =
  | {
      ok: true
      helperId: string
      name?: string
      cli: GuiHelperCli
      model: string
      effort?: string
      /** Por que o effort pedido não chegou ao CLI — silêncio aqui seria mentira. */
      effortDropped?: string
      seatId: string
      seatName?: string
    }
  | { ok: false; name?: string; error: string }

export interface GuiHelperSpawnOutcome {
  receipts: GuiHelperReceipt[]
  /** Aviso de custo da frota (ver `fleetEffortWarning`). */
  warning?: string
}

export type GuiHelperCommandResult = { ok: true } | { ok: false; error: string }

export interface GuiHelperResultView {
  helperId: string
  state: GuiHelperState
  /** `true` = ainda trabalhando; o delegador re-chama. */
  pending: boolean
  waitedMs: number
  result?: string
  truncated?: boolean
  /** Onde a entrega INTEIRA está — é o que a resposta cita primeiro. */
  resultPath?: string
  /** Disco recusou: a resposta degrada para o texto inline COM o motivo. */
  deliveryError?: string
  failure?: string
  settledAt?: number
  snapshot: GuiHelperSnapshot
}

export type GuiHelperResultOutcome =
  | ({ ok: true } & GuiHelperResultView)
  | { ok: false; error: string }

// ————— observação (a lateral e o diário) —————

export type GuiHelperChangeKind = 'spawned' | 'activity' | 'settled'

export interface GuiHelperChange {
  kind: GuiHelperChangeKind
  record: GuiHelperRecord
}

export type GuiHelperLogEvent =
  | 'helper-spawned'
  | 'helper-refused'
  | 'helper-settled'
  | 'helper-watchdog'
  | 'helper-fleet-effort'

export interface GuiHelperLogEntry {
  event: GuiHelperLogEvent
  paneId: string
  helperId?: string
  detail?: Record<string, unknown>
}

export interface GuiHelperSeatQuery {
  cli: GuiHelperCli
  /** Ausente = a primeira conta LOGADA daquele CLI (caso cross-CLI). */
  preferredSeatId?: string
}

export interface GuiHelperCatalogQuery {
  cli: GuiHelperCli
  model: string
}

export interface GuiHelperEngineDeps {
  spawnClaude: GuiHelperSpawnAdapter
  spawnCodex: GuiHelperSpawnAdapter
  /**
   * GRAVA A ENTREGA EM ARQUIVO no desfecho (`done`/`failed`). Injetado porque o
   * motor não conhece disco — quem sabe escrever é a costura com o main.
   *
   * É SÍNCRONO por contrato: o caminho tem de estar no registro ANTES de os
   * long-polls acordarem e antes de o card `settled` sair, senão o delegador
   * receberia a entrega citando um arquivo que ainda não existe. Ausente = o
   * motor segue como antes, só com a cópia em memória (é assim que a suíte do
   * motor roda sem tocar em disco).
   */
  deliver?(delivery: GuiHelperDelivery): GuiHelperDeliveryOutcome
  /** `undefined` = não há conta logada daquele CLI: o motor RECUSA em vez de
   *  abrir na conta errada. */
  resolveSeat(query: GuiHelperSeatQuery): GuiHelperSeat | undefined
  /** Catálogo real do CLI. `undefined` = catálogo não carregado (ver
   *  `helperEffortDecision`: ausência NÃO é "não suporta"). */
  modelSupportsEffort?(query: GuiHelperCatalogQuery): boolean | undefined
  now?(): number
  newId?(): string
  /** Injetável para o teste do long-poll ser determinístico. */
  setTimer?(ms: number, fn: () => void): () => void
  onChange?(change: GuiHelperChange): void
  log?(entry: GuiHelperLogEntry): void
}

// ————— funções puras (as reguas que o wiring também usa) —————

/**
 * MODELO → CLI. `gpt-*` é codex; alias/id claude e qualquer outra coisa é
 * claude. É o que torna cross-CLI cidadão de primeira classe: um chat claude
 * pedindo `gpt-5.6-sol` abre um helper codex sem nenhuma cerimônia.
 *
 * O palpite nunca é silencioso — o recibo carimba `cli`, então uma resolução
 * errada aparece no primeiro uso em vez de virar mistério.
 */
export function resolveHelperCli(model: string): GuiHelperCli {
  return /^gpt-/i.test(model.trim()) ? 'codex' : 'claude'
}

/**
 * O teto da espera é do MOTOR. `undefined` = o padrão; número = grampeado em
 * [0, 240]. Nunca confiar no cancelamento do cliente: o codex abandona a espera
 * e deixa o servidor segurando a requisição (probe-codex-fence §B.3).
 */
export function clampHelperWaitSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return GUI_HELPER_WAIT_DEFAULT_SECONDS
  return Math.min(Math.max(Math.floor(value), 0), GUI_HELPER_WAIT_MAX_SECONDS)
}

/**
 * Corta a entrega no teto COM aviso — e o aviso cabe DENTRO do teto, senão quem
 * recortasse em 64KB do outro lado comeria justamente a linha que explica o
 * corte.
 */
export function capGuiHelperResult(text: string): { text: string; truncated: boolean } {
  if (text.length <= GUI_HELPER_RESULT_MAX_CHARS) return { text, truncated: false }
  const room = GUI_HELPER_RESULT_MAX_CHARS - GUI_HELPER_RESULT_TRUNCATION_NOTICE.length
  return { text: text.slice(0, room) + GUI_HELPER_RESULT_TRUNCATION_NOTICE, truncated: true }
}

export interface GuiHelperEffortInput {
  cli: GuiHelperCli
  delegatorCli: GuiHelperCli
  model: string
  /** Pedido EXPLÍCITO do delegador — vence tudo. */
  requested?: string
  delegatorEffort?: string
  /** Do catálogo do CLI; `undefined` = catálogo ainda não carregado. */
  supportsEffort?: boolean
}

export interface GuiHelperEffortDecision {
  /** O que vai ao CLI; ausente = nenhuma flag. */
  send?: string
  /** O que a UI pode carimbar; ausente = "não informado". */
  applied?: string
  /** Por que caiu. Queda de effort NUNCA é silenciosa. */
  dropped?: string
}

/**
 * O EFFORT DO AJUDANTE, com as duas armadilhas medidas.
 *
 * 1. Pedido explícito manda, sempre. Sem pedido, o ajudante CLONA o delegador
 *    (regra F6: ajudante clona o dev, salvo ordem em contrário) — mas SÓ dentro
 *    do mesmo CLI. As escalas são diferentes (claude vai até `max`; o codex
 *    trabalha com minimal/low/medium/high), então herdar entre binários manda um
 *    nível que o outro lado não conhece. Cross-CLI sem pedido = padrão da conta,
 *    com o motivo registrado.
 * 2. Modelo que o catálogo declara SEM effort não recebe o flag: o claude engole
 *    `--effort` sem aviso nenhum (sonda 2026-08-18 §2.4) e a lateral exibiria
 *    "haiku · low" como se o nível tivesse efeito. Catálogo AUSENTE não é "não
 *    suporta" — derrubar o effort de toda frota claude por catálogo não
 *    carregado seria um estrago maior que um rótulo otimista.
 */
export function helperEffortDecision(input: GuiHelperEffortInput): GuiHelperEffortDecision {
  const requested = cleanEffort(input.requested)
  const inherited = cleanEffort(input.delegatorEffort)
  if (!requested && inherited && input.cli !== input.delegatorCli) {
    return {
      dropped: `o effort "${inherited}" do delegador não viaja para o ${input.cli}: cada CLI tem a própria escala — o ajudante roda no padrão da conta`
    }
  }
  const candidate = requested ?? inherited
  if (!candidate) return {}
  if (input.supportsEffort === false) {
    return {
      dropped: `o modelo ${input.model} não aceita effort no catálogo do ${input.cli}: mandar o flag não quebra, mas carimbar "${input.model} · ${candidate}" na lateral seria mentira`
    }
  }
  return { send: candidate, applied: candidate }
}

/**
 * AVISO DE CUSTO DA FROTA (sonda §2.3, medida direta): no claude o effort entra
 * na CHAVE DO PROMPT-CACHE. Dois helpers do MESMO modelo com efforts diferentes
 * não compartilham cache, e o segundo paga cache-creation cheia — 3,7× o custo
 * no experimento controlado.
 *
 * O alarme é ESTREITO de propósito: só dentro de um mesmo modelo claude, porque
 * modelos diferentes nunca compartilhariam cache e avisar ali seria ruído. E a
 * equivalência `default ≡ low` observada no `claude-sonnet-5` NÃO foi codificada:
 * um modelo, um build — generalizá-la seria over-fitting da sonda.
 */
export function fleetEffortWarning(
  helpers: readonly { cli: GuiHelperCli; model: string; effort?: string }[]
): string | undefined {
  const byModel = new Map<string, Set<string>>()
  for (const helper of helpers) {
    if (helper.cli !== 'claude') continue
    const bucket = byModel.get(helper.model) ?? new Set<string>()
    bucket.add(cleanEffort(helper.effort) ?? 'padrão')
    byModel.set(helper.model, bucket)
  }
  const mixed: string[] = []
  for (const [model, efforts] of byModel) {
    if (efforts.size < 2) continue
    mixed.push(`${model}: ${[...efforts].join(', ')}`)
  }
  if (mixed.length === 0) return undefined
  return (
    `frota claude com efforts diferentes no MESMO modelo (${mixed.join('; ')}) — ` +
    'cada variação paga cache de prompt cheio (medido em 2026-08-18: 3,7× o mesmo pedido). ' +
    'Effort uniforme por modelo sai materialmente mais barato.'
  )
}

/** Texto opcional do pedido: string vazia é AUSÊNCIA, nunca valor. Sem isto um
 *  `model: ""` viraria modelo de verdade e o ajudante nasceria sem executor. */
function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const cleanEffort = trimmedOrUndefined

// ————— o motor —————

interface LiveHelper {
  record: GuiHelperRecord
  process?: GuiHelperProcess
  /** Texto acumulado dos eventos `text` — a entrega quando o `result` não a traz. */
  text: string
  /** Long-polls esperando o desfecho deste ajudante. */
  waiters: (() => void)[]
  activityNotifiedAt: number
  /** Ordem MONOTÔNICA de encerramento, e não o relógio: `settledAt` tem
   *  resolução de milissegundo, e uma frota inteira encerra no mesmo tick com
   *  facilidade. Empate no relógio faria a poda cair de volta na ordem de
   *  NASCIMENTO — que é exatamente o que ela não pode usar. */
  settledSeq?: number
}

export class GuiHelperEngine {
  private readonly deps: GuiHelperEngineDeps
  private readonly helpers = new Map<string, LiveHelper>()
  /** Índice por pane, em ORDEM DE CRIAÇÃO: é ele que dá a ordem estável da
   *  lateral (card que pula de lugar sozinho é o bug que a era dos panes já
   *  pagou) e a poda por pane. */
  private readonly byPane = new Map<string, string[]>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly setTimer: (ms: number, fn: () => void) => () => void
  private sweeping = false
  private settleCounter = 0

  constructor(deps: GuiHelperEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    this.setTimer =
      deps.setTimer ??
      ((ms, fn) => {
        const handle = setTimeout(fn, ms)
        // Ajudante pendurado nunca segura o encerramento do app.
        handle.unref?.()
        return () => clearTimeout(handle)
      })
  }

  /** Registros conhecidos (vivos + os encerrados ainda lembrados). */
  get size(): number {
    return this.helpers.size
  }

  liveCount(paneId?: string): number {
    let count = 0
    for (const live of this.pick(paneId)) {
      if (!isGuiHelperSettled(live.record.state)) count += 1
    }
    return count
  }

  /**
   * Abre a frota. NUNCA bloqueia: devolve o recibo de cada item na hora — é o
   * que deixa a tool `delegate` responder e o chat seguir conversando enquanto
   * os ajudantes trabalham.
   */
  spawn(
    delegator: GuiHelperDelegator,
    requests: readonly GuiHelperRequest[]
  ): GuiHelperSpawnOutcome {
    this.sweep()
    const receipts: GuiHelperReceipt[] = []
    const fleet: { cli: GuiHelperCli; model: string; effort?: string }[] = []

    for (const request of requests) {
      const name = trimmedOrUndefined(request.name)
      const named = name ? { name } : {}
      const refuse = (error: string): void => {
        receipts.push({ ok: false, ...named, error })
        this.journal({
          event: 'helper-refused',
          paneId: delegator.paneId,
          detail: { error }
        })
      }

      const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
      if (!prompt) {
        refuse('o pedido do ajudante veio vazio — descreva a fatia de trabalho dele')
        continue
      }
      if (prompt.length > GUI_HELPER_PROMPT_MAX_CHARS) {
        refuse(
          `o pedido tem ${prompt.length} caracteres e o teto é ${GUI_HELPER_PROMPT_MAX_CHARS} — ` +
            'ponha o material longo num arquivo do worktree e aponte o caminho'
        )
        continue
      }
      // BACKSTOP: recontado a cada item, então um lote grande demais é cortado
      // no ponto certo em vez de passar inteiro por ter começado abaixo do teto.
      if (this.liveCount(delegator.paneId) >= GUI_HELPER_RUNAWAY_BACKSTOP) {
        refuse(
          `trava de segurança: este chat já tem ${GUI_HELPER_RUNAWAY_BACKSTOP} ajudantes vivos ao mesmo tempo. ` +
            'Isso não é teto de delegação — é o piso de um laço de bug (delegação que se chama sozinha). ' +
            'Cancele os que ficaram (helper_cancel) ou espere encerrarem.'
        )
        continue
      }

      const model = trimmedOrUndefined(request.model) ?? delegator.model
      const cli = resolveHelperCli(model)
      const supportsEffort = this.deps.modelSupportsEffort?.({ cli, model })
      const effort = helperEffortDecision({
        cli,
        delegatorCli: delegator.cli,
        model,
        ...(request.effort ? { requested: request.effort } : {}),
        ...(delegator.effort ? { delegatorEffort: delegator.effort } : {}),
        ...(supportsEffort === undefined ? {} : { supportsEffort })
      })

      // Mesmo CLI ⇒ a conta do delegador; CLI cruzado ⇒ o resolvedor escolhe a
      // primeira LOGADA daquele binário (a conta do delegador é de outro CLI).
      const preferredSeatId =
        trimmedOrUndefined(request.seatId) ?? (cli === delegator.cli ? delegator.seatId : undefined)
      const seat = this.deps.resolveSeat({
        cli,
        ...(preferredSeatId ? { preferredSeatId } : {})
      })
      if (!seat) {
        refuse(
          `não há conta ${cli} logada para abrir este ajudante (o modelo pedido foi ${model}) — ` +
            `entre numa conta ${cli} ou peça um modelo do outro CLI`
        )
        continue
      }

      const helperId = this.newId()
      const record: GuiHelperRecord = {
        helperId,
        delegatorPaneId: delegator.paneId,
        projectId: delegator.projectId,
        ...named,
        cwd: delegator.cwd,
        cli,
        model,
        ...(effort.applied ? { effort: effort.applied } : {}),
        seatId: seat.seatId,
        ...(seat.name ? { seatName: seat.name } : {}),
        prompt,
        state: 'spawning',
        startedAt: this.now()
      }
      const live: LiveHelper = { record, text: '', waiters: [], activityNotifiedAt: 0 }
      this.remember(live)
      // O card nasce ANTES do processo: assim a ordem publicada é sempre
      // spawned → … → settled, inclusive quando o spawn morre no nascimento.
      this.notify({ kind: 'spawned', record: { ...record } })

      try {
        const adapter = cli === 'codex' ? this.deps.spawnCodex : this.deps.spawnClaude
        live.process = adapter(
          {
            helperId,
            projectId: delegator.projectId,
            delegatorPaneId: delegator.paneId,
            cwd: delegator.cwd,
            cli,
            model,
            ...(effort.send ? { effort: effort.send } : {}),
            seat,
            prompt,
            ...(delegator.permissionMode ? { permissionMode: delegator.permissionMode } : {})
          },
          (event) => this.consume(helperId, event)
        )
        // O adaptador pode ter emitido o desfecho DENTRO do próprio spawn: aí o
        // descarte já rodou sem processo nenhum em mãos, e sem esta linha o
        // processo devolvido viveria para sempre sem dono.
        if (isGuiHelperSettled(live.record.state)) live.process.dispose()
      } catch (error) {
        // O registro FICA como failed: sumir sem rastro esconderia a queda do
        // dono, que veria a lateral vazia e nenhum motivo.
        const detail = errorText(error)
        this.settle(live, 'failed', { failure: `o ajudante não subiu: ${detail}` })
        refuse(detail)
        continue
      }

      fleet.push({ cli, model, ...(effort.applied ? { effort: effort.applied } : {}) })
      this.journal({
        event: 'helper-spawned',
        paneId: delegator.paneId,
        helperId,
        detail: {
          cli,
          model,
          seatId: seat.seatId,
          ...(effort.applied ? { effort: effort.applied } : {}),
          ...(effort.dropped ? { effortDropped: effort.dropped } : {})
        }
      })
      receipts.push({
        ok: true,
        helperId,
        ...named,
        cli,
        model,
        ...(effort.applied ? { effort: effort.applied } : {}),
        ...(effort.dropped ? { effortDropped: effort.dropped } : {}),
        seatId: seat.seatId,
        ...(seat.name ? { seatName: seat.name } : {})
      })
    }

    const warning = fleetEffortWarning(fleet)
    if (warning) {
      this.journal({
        event: 'helper-fleet-effort',
        paneId: delegator.paneId,
        detail: { warning }
      })
    }
    return { receipts, ...(warning ? { warning } : {}) }
  }

  /** A fotografia do pane, em ordem de criação. */
  status(paneId: string): GuiHelperSnapshot[] {
    this.sweep()
    return this.pick(paneId).map((live) => this.snapshot(live))
  }

  /** Cópia do registro — o chamador nunca escreve no estado do motor. */
  get(helperId: string): GuiHelperRecord | undefined {
    this.sweep()
    const live = this.helpers.get(helperId)
    return live ? { ...live.record } : undefined
  }

  /**
   * LONG-POLL com teto do próprio motor. Resolve NA HORA em que o ajudante
   * encerra; estourado o teto, devolve "ainda trabalhando" com a fotografia — e
   * isso é resposta, nunca erro: o delegador re-chama.
   */
  async result(helperId: string, waitSeconds?: number): Promise<GuiHelperResultOutcome> {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: false, error: helperNotFound(helperId) }

    const seconds = clampHelperWaitSeconds(waitSeconds)
    const pollStartedAt = this.now()
    if (!isGuiHelperSettled(live.record.state) && seconds > 0) {
      await new Promise<void>((resolve) => {
        let finished = false
        let cancelTimer: (() => void) | undefined
        const finish = (): void => {
          if (finished) return
          finished = true
          cancelTimer?.()
          const index = live.waiters.indexOf(waiter)
          if (index >= 0) live.waiters.splice(index, 1)
          resolve()
        }
        const waiter = (): void => finish()
        live.waiters.push(waiter)
        cancelTimer = this.setTimer(seconds * 1000, finish)
      })
      // O teto pode ter atravessado o watchdog: varrer antes de responder evita
      // devolver "ainda trabalhando" sobre um ajudante que já devia estar morto.
      this.sweep()
    }
    return { ok: true, ...this.view(live, this.now() - pollStartedAt) }
  }

  /** Steering: dirige o ajudante VIVO, como se fosse um subagente nativo. */
  send(helperId: string, text: string): GuiHelperCommandResult {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: false, error: helperNotFound(helperId) }
    if (isGuiHelperSettled(live.record.state)) {
      return { ok: false, error: alreadySettled(live.record.state) }
    }
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'a mensagem veio vazia — diga o que mudar' }
    }
    if (!live.process) return { ok: false, error: 'o ajudante ainda não tem processo vivo' }
    live.process.send(text)
    return { ok: true }
  }

  cancel(helperId: string, reason?: string): GuiHelperCommandResult {
    this.sweep()
    const live = this.helpers.get(helperId)
    if (!live) return { ok: false, error: helperNotFound(helperId) }
    if (isGuiHelperSettled(live.record.state)) {
      return { ok: false, error: alreadySettled(live.record.state) }
    }
    this.settle(live, 'cancelled', { failure: cancelReason(reason) })
    return { ok: true }
  }

  /** Dispose do pane delegador: os ajudantes dele morrem junto. Os REGISTROS
   *  ficam — a lateral continua mostrando o desfecho de cada card. */
  cancelPane(paneId: string, reason?: string): number {
    this.sweep()
    let count = 0
    for (const live of this.pick(paneId)) {
      if (isGuiHelperSettled(live.record.state)) continue
      this.settle(live, 'cancelled', { failure: cancelReason(reason) })
      count += 1
    }
    return count
  }

  /** O pane sumiu de vez (chat fechado, projeto trocado): cancela E esquece.
   *  Sem isto a memória de encerrados de um pane morto ficaria para sempre. */
  forgetPane(paneId: string, reason?: string): number {
    const cancelled = this.cancelPane(paneId, reason)
    for (const helperId of this.byPane.get(paneId) ?? []) this.helpers.delete(helperId)
    this.byPane.delete(paneId)
    return cancelled
  }

  /** O quit: nada sobrevive ao fechamento do app. */
  cancelAll(reason?: string): number {
    this.sweep()
    let count = 0
    for (const live of this.helpers.values()) {
      if (isGuiHelperSettled(live.record.state)) continue
      this.settle(live, 'cancelled', { failure: cancelReason(reason) })
      count += 1
    }
    return count
  }

  /**
   * WATCHDOG. Roda no começo de toda operação pública (é assim que a fotografia
   * nunca mostra zumbi) e também pode ser chamada por um relógio do wiring, para
   * o ajudante esquecido cair mesmo que ninguém pergunte por ele.
   */
  sweep(): GuiHelperRecord[] {
    // Guarda de reentrância: `settle` chama observador externo, e um observador
    // que consulte o motor de volta cairia aqui de novo.
    if (this.sweeping) return []
    this.sweeping = true
    try {
      const now = this.now()
      const reaped: GuiHelperRecord[] = []
      for (const live of this.helpers.values()) {
        if (isGuiHelperSettled(live.record.state)) continue
        if (now - live.record.startedAt < GUI_HELPER_WATCHDOG_MS) continue
        this.settle(live, 'failed', {
          failure:
            'watchdog: o ajudante passou de 30 min sem encerrar e foi derrubado — ' +
            'o que ele escreveu no worktree continua lá'
        })
        this.journal({
          event: 'helper-watchdog',
          paneId: live.record.delegatorPaneId,
          helperId: live.record.helperId,
          detail: { elapsedMs: now - live.record.startedAt }
        })
        reaped.push({ ...live.record })
      }
      return reaped
    } finally {
      this.sweeping = false
    }
  }

  // ————— internos —————

  private pick(paneId?: string): LiveHelper[] {
    if (paneId === undefined) return [...this.helpers.values()]
    const list: LiveHelper[] = []
    for (const helperId of this.byPane.get(paneId) ?? []) {
      const live = this.helpers.get(helperId)
      if (live) list.push(live)
    }
    return list
  }

  private remember(live: LiveHelper): void {
    this.helpers.set(live.record.helperId, live)
    const ids = this.byPane.get(live.record.delegatorPaneId) ?? []
    ids.push(live.record.helperId)
    this.byPane.set(live.record.delegatorPaneId, ids)
  }

  private consume(helperId: string, event: GuiHelperEvent): void {
    const live = this.helpers.get(helperId)
    // Evento atrasado de ajudante já encerrado NUNCA ressuscita: um turno que
    // volta a abrir depois do desfecho deixaria o card aberto para sempre.
    if (!live || isGuiHelperSettled(live.record.state)) return
    if (live.record.state === 'spawning') live.record.state = 'working'

    if (event.type === 'text') {
      live.text += event.text
      return
    }
    if (event.type === 'activity') {
      const at = this.now()
      live.record.lastActivity = { at, summary: event.summary }
      if (at - live.activityNotifiedAt >= GUI_HELPER_ACTIVITY_THROTTLE_MS) {
        live.activityNotifiedAt = at
        this.notify({ kind: 'activity', record: { ...live.record } })
      }
      return
    }
    if (event.type === 'context') {
      if (typeof event.contextTokens === 'number' && event.contextTokens > 0) {
        live.record.contextTokens = Math.floor(event.contextTokens)
      }
      return
    }
    if (event.type === 'result') {
      if (event.isError) {
        this.settle(live, 'failed', {
          failure: event.errorText?.trim() || 'o turno do ajudante falhou sem motivo declarado'
        })
        return
      }
      this.settle(live, 'done', { text: event.text ?? live.text })
      return
    }
    if (event.type === 'fatal') {
      this.settle(live, 'failed', { failure: event.text })
      return
    }
    // PROCESSO ENCERRADO É DESFECHO (sonda §2.6): o `claude -p` entrega o
    // resultado e morre sozinho com exit 0. Esperar um desligamento explícito
    // deixaria todo helper claude com o card aberto para sempre.
    if (live.text.trim()) {
      this.settle(live, 'done', { text: live.text })
      return
    }
    const code = typeof event.code === 'number' ? `código ${event.code}` : 'sem código de saída'
    this.settle(live, 'failed', {
      failure: `o processo do CLI encerrou (${code}) sem entregar resultado`
    })
  }

  private settle(
    live: LiveHelper,
    state: 'done' | 'failed' | 'cancelled',
    payload: { text?: string; failure?: string }
  ): void {
    if (isGuiHelperSettled(live.record.state)) return
    live.record.state = state
    live.record.settledAt = this.now()
    live.settledSeq = (this.settleCounter += 1)
    if (payload.text !== undefined) {
      const capped = capGuiHelperResult(payload.text)
      live.record.result = capped.text
      if (capped.truncated) live.record.resultTruncated = true
    }
    if (payload.failure !== undefined) live.record.failure = payload.failure

    // A ENTREGA EM ARQUIVO vem AQUI, entre o registro e o anúncio: o caminho
    // precisa existir antes de os long-polls acordarem, do card `settled` sair e
    // do correio ser postado — os três citam o arquivo. `cancelled` fica de fora:
    // ninguém está esperando o trabalho que o próprio app mandou parar.
    if (state !== 'cancelled') this.persist(live, payload.text ?? live.text)

    // O KILL É DO MOTOR: o app-server do codex nunca encerra sozinho ao fim do
    // turno (sonda §6). Descartar em TODO desfecho é o que impede órfão — e o
    // `dispose` é idempotente, então o claude que já morreu não se importa.
    try {
      live.process?.dispose()
    } catch {
      // Descarte que falha não pode impedir o desfecho de ser publicado: o card
      // ficaria aberto para sempre por causa de um processo que já se foi.
    }
    for (const waiter of live.waiters.splice(0)) waiter()
    this.prune(live.record.delegatorPaneId)
    this.notify({ kind: 'settled', record: { ...live.record } })
    this.journal({
      event: 'helper-settled',
      paneId: live.record.delegatorPaneId,
      helperId: live.record.helperId,
      detail: {
        state,
        elapsedMs: (live.record.settledAt ?? 0) - live.record.startedAt,
        ...(live.record.resultTruncated ? { truncated: true } : {}),
        ...(live.record.resultPath ? { resultPath: live.record.resultPath } : {}),
        ...(live.record.deliveryError ? { deliveryError: live.record.deliveryError } : {})
      }
    })
  }

  /**
   * Grava a entrega e carimba o caminho — ou o motivo de não ter gravado.
   *
   * Falha de disco NUNCA derruba o desfecho: o registro continua com o texto em
   * memória e o `deliveryError` viaja junto para o delegador ler o que voltou
   * inline e saber por que não há arquivo. Perder a entrega porque o disco
   * encheu seria trocar um problema pequeno por um irreversível.
   */
  private persist(live: LiveHelper, text: string): void {
    if (!this.deps.deliver) return
    try {
      const outcome = this.deps.deliver({ record: { ...live.record }, text })
      if (outcome.ok) live.record.resultPath = outcome.path
      else live.record.deliveryError = outcome.error
    } catch (error) {
      live.record.deliveryError = errorText(error)
    }
  }

  /**
   * Poda a memória de ENCERRADOS do pane. Vivo nunca sai.
   *
   * A vítima é o mais antigo A ENCERRAR, nunca o mais antigo a NASCER: o
   * delegador lê os resultados na ordem em que eles chegam, e é a ordem de
   * encerramento que garante que o desfecho recém-publicado jamais seja o
   * evictado — um ajudante que nasceu primeiro e entregou por último teria o
   * resultado comido no mesmo instante em que ficou pronto.
   */
  private prune(paneId: string): void {
    const ids = this.byPane.get(paneId)
    if (!ids) return
    const settled: { helperId: string; seq: number }[] = []
    for (const helperId of ids) {
      const live = this.helpers.get(helperId)
      if (live && isGuiHelperSettled(live.record.state)) {
        settled.push({ helperId, seq: live.settledSeq ?? 0 })
      }
    }
    if (settled.length <= GUI_HELPER_SETTLED_MEMORY) return
    settled.sort((a, b) => a.seq - b.seq)
    const doomed = new Set(
      settled.slice(0, settled.length - GUI_HELPER_SETTLED_MEMORY).map((entry) => entry.helperId)
    )
    for (const helperId of doomed) this.helpers.delete(helperId)
    // O índice também solta id que outra poda já removeu: ele é a ordem da
    // lateral e não pode apontar para registro que não existe mais.
    this.byPane.set(
      paneId,
      ids.filter((helperId) => !doomed.has(helperId) && this.helpers.has(helperId))
    )
  }

  private snapshot(live: LiveHelper): GuiHelperSnapshot {
    const record = live.record
    return {
      helperId: record.helperId,
      ...(record.name ? { name: record.name } : {}),
      cli: record.cli,
      model: record.model,
      ...(record.effort ? { effort: record.effort } : {}),
      seatId: record.seatId,
      ...(record.seatName ? { seatName: record.seatName } : {}),
      state: record.state,
      startedAt: record.startedAt,
      elapsedMs: (record.settledAt ?? this.now()) - record.startedAt,
      ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
      ...(record.lastActivity ? { lastActivity: record.lastActivity } : {}),
      ...(record.contextTokens !== undefined ? { contextTokens: record.contextTokens } : {}),
      hasResult: record.result !== undefined,
      ...(record.resultPath ? { resultPath: record.resultPath } : {}),
      ...(record.failure ? { failure: record.failure } : {})
    }
  }

  private view(live: LiveHelper, waitedMs: number): GuiHelperResultView {
    const record = live.record
    return {
      helperId: record.helperId,
      state: record.state,
      pending: !isGuiHelperSettled(record.state),
      waitedMs,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.resultTruncated ? { truncated: true } : {}),
      ...(record.resultPath ? { resultPath: record.resultPath } : {}),
      ...(record.deliveryError ? { deliveryError: record.deliveryError } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
      snapshot: this.snapshot(live)
    }
  }

  // Observador e diário são de FORA: um erro deles não pode derrubar o motor que
  // segura processos de CLI vivos.
  private notify(change: GuiHelperChange): void {
    try {
      this.deps.onChange?.(change)
    } catch {
      /* a lateral que quebra não mata o ajudante */
    }
  }

  private journal(entry: GuiHelperLogEntry): void {
    try {
      this.deps.log?.(entry)
    } catch {
      /* diário indisponível nunca interrompe o ciclo de vida */
    }
  }
}

function helperNotFound(helperId: string): string {
  return `ajudante ${helperId} não encontrado neste chat — confira o id no helpers_status`
}

function alreadySettled(state: GuiHelperState): string {
  return `o ajudante já encerrou (${state}) — abra outro com delegate se ainda falta trabalho`
}

function cancelReason(reason?: string): string {
  const clean = typeof reason === 'string' ? reason.trim() : ''
  return clean || 'cancelado pelo delegador'
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

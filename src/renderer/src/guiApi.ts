import type {
  GuiAlertPayload,
  GuiAttachPayload,
  GuiAttachResult,
  GuiDelegationDefaults,
  GuiDelegationDefaultsPatch,
  GuiDelegationDefaultsResult,
  GuiAttachmentAction,
  GuiAttachmentActionResult,
  GuiAttachmentDescriptor,
  GuiFileExternalOpenMode,
  GuiFileExternalOpenResult,
  GuiFileOpenResult,
  GuiFileOpenMode,
  GuiWorkspaceFilesResult,
  GuiAttachmentPreviewPurpose,
  GuiAttachmentPreviewResult,
  GuiQueuedDeliveryInput
} from '../../preload'
import type { GuiBrowserReference, GuiBrowserReferenceRevealResult } from '../../shared/guiBrowserReferences'
import type { GuiUsageMeters } from '../../shared/guiUsage'
import type { GuiInterruptOrigin } from '../../shared/guiInterrupt'

export interface GuiBrowserReferencesResult {
  ok: boolean
  references: GuiBrowserReference[]
  error?: string
}

export interface GuiBrowserReferencesPayload {
  paneId: string
  references: GuiBrowserReference[]
}

import type { PlanDraft, PlanItemDraft, PlanItemTier, PlanKind } from './planContract'

export type { GuiFileChoice, GuiFileOpenMode, GuiFileOpenResult, GuiFilePreview } from '../../preload'
export type { GuiUsageMeters } from '../../shared/guiUsage'
export type { GuiFileExternalOpenMode, GuiFileExternalOpenResult } from '../../preload'

/** R36 — ESPELHO DECLARADO do canal `gui:fileImageData` (o par mora em
 *  `src/preload/index.ts`, onde o tipo é inline). Imagem citada pelo agente
 *  vira data URL feita no main; o CSP do renderer (`img-src 'self' data:`) só
 *  deixa pintar isso. Recusa SEMPRE traz texto com receita. */
export type GuiFileImageDataResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string }

// Ponte tipada do PANE GUI (Synkora 2.0, onda A).
//
// O contrato vive em docs/GUI_PANE_CONTRACT.md e tem duas metades: o agente
// MOTOR é dono de main/ + preload (namespace `window.synkora.gui`), o agente
// PANE é dono do renderer. Este arquivo é a ÚNICA costura entre os dois lados
// no renderer: nenhum componente fala com `window.synkora.gui` direto.
//
// Enquanto as duas frentes não mesclam, o preload deste worktree ainda não
// declara `gui` — por isso o acesso passa por um cast estreito, resolvido a
// cada chamada (o namespace pode nascer depois deste módulo ser importado).
// Quando o preload publicar os tipos, basta trocar `bridge()` por
// `window.synkora.gui`; nada fora daqui muda.

// ————— tipos do contrato (cópia VERBATIM — fonte única dos dois lados) —————

/** MODO DE PERMISSÃO POR CONVERSA (onda D, item 3 — ordem do dono): o
 *  interruptor global de bypass do universo morreu; quem decide o quanto o
 *  agente pode agir sozinho é CADA conversa, no próprio composer.
 *  padrão = pergunta o que for sensível · edições = edita sem perguntar ·
 *  bypass = segue reto · plano = só planeja, não escreve. */
/** Espelho do limite autoritativo validado no main antes do clone IPC. */
export const GUI_PROMPT_MAX_CHARS = 256 * 1024

export type GuiPermissionMode = 'default' | 'acceptEdits' | 'bypass' | 'plan'

export interface GuiPaneSpawn {
  paneId: string
  projectId: string
  cli: 'claude' | 'codex'
  /** Config dir isolado do seat (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  configDir: string
  /** id do seat dono desta conversa — alimenta o menu de troca do cabeçalho. */
  seatId?: string
  /** Worktree da missão (ou raiz do projeto no planejamento). */
  cwd: string
  model?: string
  effort?: string
  /** Persona/contrato curto (claude: append-system-prompt; codex: developerInstructions). */
  systemPrompt?: string
  /** Retomar conversa existente (claude sessionId / codex thread id). */
  resumeSessionId?: string
  /** BRIEFING da missão. Não abre turno: fica pendente no motor e sai colado
   *  na PRIMEIRA mensagem do dono (o pane nasce mudo — ordem do dono). */
  firstPrompt?: string
  /** Modo de permissão desta conversa (onda D). Trocar em voo = novo
   *  `gui:create` com o mesmo paneId: o motor respawna com resume, então a
   *  conversa continua.
   *  TODO(onda D, motor): o main é o dono canônico deste campo — quando ele
   *  publicar o tipo, esta cópia some junto com o resto do bloco. */
  permissionMode?: GuiPermissionMode
  /** R11 — modo FAST desta conversa (espelho do main): flag de processo nos
   *  dois CLIs; trocar respawna com resume (o caminho do permissionMode).
   *  Claude: ligar troca o modelo para Opus 5 (comportamento do binário). */
  fast?: boolean
  /** MCP do Synkora deste pane (onda D): só a missão de PLANEJAMENTO recebe —
   *  ver guiPlannerMcp.ts. O main é o dono canônico; aqui é espelho. Entra no
   *  fingerprint: armar/desarmar o servidor exige processo novo.
   *  CAMPO NOVO NO SPAWN ENTRA AQUI: a cerca de paridade do
   *  test:gui-chat-ui lê esta interface, as props do GuiPane, os dois
   *  literais do spawnRef e o `<GuiPane>` do Board — foi o silêncio dessas
   *  quatro listas que deixou o chat de planejamento sem ferramenta. */
  mcp?: { args: string[]; env?: Record<string, string> }
}

export type GuiPermBehavior = 'allow' | 'allow-always' | 'deny'

/** Evento vivo empurrado ao renderer. `evt` é o SessionEvent dos backends
 *  (maestroSession.ts — kinds: init, delta, thinking, text, tool, tool-result,
 *  permission, permission-cancel, session-id, ready, command-output, limit,
 *  result, fatal, closed). */
export interface GuiLivePayload {
  paneId: string
  seq: number
  evt: unknown /* SessionEvent */
}

export interface GuiExecutorPatch {
  model?: string | null
  effort?: string | null
}

export type GuiExecutorResult =
  | { ok: true; model: string | null; effort: string | null }
  | { ok: false; error: string }

export interface GuiReplayEvent {
  seq: number
  evt: GuiSessionEvent
}

export interface GuiReplayState {
  events: GuiReplayEvent[]
  cursor: number
  exists: boolean
  alive: boolean
  permissionMode?: GuiPermissionMode
}

// ————— espelho do SessionEvent do main —————
// O contrato entrega `evt` como `unknown` de propósito (o main é dono da
// união). O renderer precisa lê-lo, então mantém um ESPELHO estreito: campos
// desconhecidos são ignorados, e um kind novo nunca quebra a UI (cai no
// default do redutor). `thinking.text` é o campo ADITIVO previsto no contrato.

export interface GuiCliCommand {
  name: string
  description: string
  argumentHint?: string
}

export interface GuiCliModel {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  /** R11: o modelo aceita o modo fast (claude: supportsFastMode do bundle;
   *  codex: service tier 'priority' — o main uniformiza na MESMA chave). */
  supportsFastMode?: boolean
  supportedEffortLevels?: string[]
}

export interface GuiCliCaps {
  commands: GuiCliCommand[]
  models: GuiCliModel[]
  account?: { email?: string; subscriptionType?: string }
}

// ————— pergunta com opções (AskUserQuestion) e veredito de plano —————
// Espelho VERBATIM do maestroSession (main é o dono). A resposta viaja no
// updatedInput do mesmo control_response da permissão — por isso o card
// devolve um MAPA { texto da pergunta → labels unidos por ', ' }.

export interface GuiQuestionOption {
  label: string
  description?: string
}

export interface GuiQuestion {
  /** Espelho de src/main/maestroSession.ts. */
  id?: string
  question: string
  header?: string
  multiSelect?: boolean
  options: GuiQuestionOption[]
  allowCustom?: boolean
}

export type GuiSessionEvent =
  | {
      type: 'init'
      model: string
      sessionId: string
      permissionMode: string
      toolCount: number
      contextWindow?: number
    }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text?: string }
  | { type: 'context-compaction'; active: boolean }
  | { type: 'turn-started' }
  | { type: 'turn-continuation'; continues: boolean; turnActive?: boolean }
  | {
      type: 'session-restarted'
      ready: boolean
      /** R12: a geração nova retomou a MESMA conversa (espelho do union do
       *  main, maestroSession.ts). Ausente/false = geração nova. */
      resumed?: boolean
      contextTokens?: number | null
      contextWindow?: number | null
    }
  | { type: 'conversation-cleared' }
  | { type: 'executor-changed'; model: string | null; effort: string | null }
  | {
      type: 'user-message'
      id: string
      text: string
      attachments?: GuiAttachmentDescriptor[]
      browserReferences?: GuiBrowserReference[]
      at: number
    }
  /** D6 (2026-09-02) — O RECIBO DA FALA DO DONO. Espelho declarado do union do
   *  main (`src/main/guiSessions.ts`, que emite os estados): `stopping` ao
   *  mandar o interrupt, `delivered` quando o pote sai como turno novo (ou de
   *  carona), `answered` no primeiro texto do agente depois disso. Nasceu da
   *  queixa do dono "ele tá deixando na fila" — a bolha subia igual, tivesse a
   *  fala chegado na hora ou ficado três minutos no pote. `id` é o `messageId`
   *  da bolha; estado desconhecido não desenha nada (guiOwnerBubble.ts).
   *
   *  R39.1 (D1'/D2', 2026-09-02) — a rota padrão virou `steer` (a fala vai ao
   *  CLI sem parar o turno), e por isso o union ganhou dois estados: `unread`
   *  (mandada, ainda não absorvida — o único com AÇÃO na tela) e `read` (o
   *  RECIBO DE LEITURA, quando o CLI absorve a fala). A ordem do tempo é
   *  `unread → stopping → read`/`delivered` → `answered`; a régua que impede
   *  o recibo de andar para trás mora em `guiOwnerBubble.ts`. */
  | {
      type: 'owner-message-state'
      id: string
      state: 'unread' | 'stopping' | 'read' | 'delivered' | 'answered' | 'cancelled'
      at: number
    }
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      name: string
      input: Record<string, unknown>
      toolUseId?: string
      parentToolUseId?: string
    }
  | {
      type: 'tool-result'
      text: string
      isError: boolean
      /** `interrupted` (R6.1): card de AJUDANTE parado de forma preservadora —
       *  espelho do union do main (maestroSession.ts). */
      outcome?: 'completed' | 'failed' | 'denied' | 'cancelled' | 'interrupted'
      toolUseId?: string
      lineCount?: number
      truncated?: boolean
      /** Ciclo de vida de subagente em background (Claude). 'launched' = recibo de
       *  despacho (async_launched) — o agente segue vivo; 'settled' = terminal factual
       *  (task_notification ou reconciliação). Ausente em tool-result comum e no Codex. */
      agentStatus?: 'launched' | 'settled'
      /** task_id do CLI (== agentId do ACK). Presente sempre que agentStatus existir. */
      agentTaskId?: string
    }
  | {
      type: 'permission'
      requestId: string
      toolUseId?: string
      toolName: string
      description: string
      inputPretty: string
      reason?: string
      permissionRule?: string
      canAlways: boolean
    }
  | { type: 'permission-cancel'; requestId: string }
  | {
      type: 'interaction-resolved'
      requestId: string
      resolution:
        | {
            kind: 'permission'
            toolUseId?: string
            toolName: string
            behavior: GuiPermBehavior
          }
        | { kind: 'question'; entries: { question: string; answer: string }[]; messageId?: string }
        | { kind: 'plan'; approve: boolean }
        /** `approve` true = o dono criou o plano; o título volta para o fio
         *  poder dizer QUAL plano nasceu sem consultar o mapa. */
        | { kind: 'plan-proposal'; approve: boolean; planTitle?: string }
        | { kind: 'stale' }
    }
  /** `plan`: o corpo em markdown do cartão de plano do Synkora (plan_approval). */
  | { type: 'question'; requestId: string; questions: GuiQuestion[]; blocking?: boolean; asynchronous?: boolean; plan?: string }
  | { type: 'plan-review'; requestId: string; plan: string }
  /** PROPOSTA DE PLANO (D4.4): nasce no HARNESS, não no CLI — quando a tool
   *  `propose_plan` chega, o main injeta este evento no anel da sessão. A
   *  criação continua sendo do dono: a tool só apresenta. */
  | { type: 'plan-proposal'; requestId: string; draft: PlanDraft }
  | { type: 'session-id'; sessionId: string }
  | { type: 'ready'; caps: GuiCliCaps }
  | { type: 'command-output'; text: string }
  | {
      type: 'context-usage'
      contextTokens: number | null
      contextWindow: number | null
      /**
       * R25.1 — O ODÔMETRO DA CONVERSA (espelho declarado do union do main,
       * maestroSession.ts): quantas chamadas de API esta conversa já fez e
       * quanto elas pesaram na cota. Quem soma é o MAIN — o renderer remonta a
       * cada troca de aba e não teria como acumular nada.
       *
       * A PARCELA de cada chamada (`call`, no union do main) NÃO atravessa este
       * espelho de propósito: ela é transporte motor→registro, e o registro a
       * troca pelo total antes de publicar. Ausentes = conversa sem medição de
       * custo ainda; o redutor conserva o que já tinha em vez de zerar.
       */
      convCalls?: number
      convWeightTokens?: number
      /** Numeric-only snapshots from main/guiRequestUsage.ts; additive for
       * old replay. Missing preserves prior state; null explicitly clears. */
      usage?: GuiUsageMeters | null
    }
  | { type: 'command-completed'; isError: boolean; continues: boolean; errorText?: string }
  | { type: 'limit'; text: string }
  | {
      type: 'result'
      isError: boolean
      outcome?: 'completed' | 'failed' | 'cancelled'
      /** R7-E: o ■ DO DONO passou pelo motor e ESTE terminal é aquela
       *  interrupção — espelho declarado do union do main (maestroSession.ts).
       *  O motor já normalizou `isError:false` + `outcome:'cancelled'`; aqui a
       *  BANDEIRA ainda ganha do resto (o redutor a lê ANTES de `isError`), e
       *  ausência = desfecho comum, lido exatamente como antes. */
      interrupted?: boolean
      continues?: boolean
      /** Parent activity, separate from helper work; mirrors maestroSession.ts. */
      turnActive?: boolean
      errorText?: string
      resultText?: string
      /** Internal receipt consumed by the main registry before IPC. */
      localCommand?: 'reload-skills'
      contextTokens?: number
      contextWindow?: number
      fastModeState?: string
      costUsd?: number
    }
  | { type: 'fatal'; text: string }
  | { type: 'closed'; code: number | null }
  /** R24.1 — A PODA FALA. Evento SINTÉTICO do registro (espelho declarado:
   *  `GuiHistoryPrunedEvent` em src/main/guiSessions.ts), nunca do CLI: o anel
   *  do pane descartou os eventos mais antigos e o fio na tela começa DEPOIS do
   *  começo da conversa. Chega no replay da remontagem e uma vez ao vivo. */
  | { type: 'history-pruned'; evicted: number }

// ————— leitura defensiva do rascunho de plano —————
//
// A proposta é a ÚNICA interação com payload ESTRUTURADO (as outras são texto),
// e ela vem de fora: ou o rascunho entra normalizado — títulos aparados, listas
// com teto, campo fora do vocabulário descartado —, ou não entra. Sem isto, um
// `items` não-array quebraria o card no exato momento da decisão do dono.

const PLAN_TIERS: readonly PlanItemTier[] = ['pequeno', 'medio', 'grande']

/** Teto de itens que a UI aceita desenhar: acima disso o rascunho deixou de ser
 *  um plano e virou despejo. */
export const PLAN_DRAFT_MAX_ITEMS = 60

function planText(value: unknown, max: number): string {
  return typeof value === 'string' && value.length <= max ? value : ''
}

function planList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value.slice(0, max)) {
    const text = planText(entry, 2_000).trim()
    if (text) out.push(text)
  }
  return out
}

/** `null` quando não há título NEM item: card vazio seria pior que card nenhum
 *  (o dono decidiria sobre o nada). */
export function readPlanDraft(value: unknown): PlanDraft | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const title = planText(record['title'], 300).trim()
  const rawItems = Array.isArray(record['items'])
    ? record['items'].slice(0, PLAN_DRAFT_MAX_ITEMS)
    : []
  const items: PlanItemDraft[] = []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const itemTitle = planText(entry['title'], 300).trim()
    if (!itemTitle) continue
    // O main emite a identidade do item como `key` (slug derivado do título;
    // planDraft.ts) e o dependsOn referencia ESSAS keys — `id` fica como
    // fallback de tolerância. Sem esta leitura, o card mostraria slugs crus
    // no "depende de" em vez dos títulos.
    const id = planText(entry['key'] ?? entry['id'], 200).trim()
    const outOfScope = planText(entry['outOfScope'], 4_000).trim()
    const context = planText(entry['context'], 4_000).trim()
    const docPath = planText(entry['docPath'], 500).trim()
    const tier = entry['tier']
    items.push({
      ...(id ? { id } : {}),
      title: itemTitle,
      objective: planText(entry['objective'], 4_000).trim(),
      ...(outOfScope ? { outOfScope } : {}),
      doneCriteria: planList(entry['doneCriteria'], 30),
      ...(PLAN_TIERS.includes(tier as PlanItemTier) ? { tier: tier as PlanItemTier } : {}),
      ...(context ? { context } : {}),
      dependsOn: planList(entry['dependsOn'], 30),
      ...(docPath ? { docPath } : {})
    })
  }
  if (!title && items.length === 0) return null
  const description = planText(record['description'], 8_000).trim()
  const kind = record['kind']
  return {
    title,
    ...(description ? { description } : {}),
    ...(kind === 'mestre' || kind === 'livre' ? { kind: kind as PlanKind } : {}),
    items
  }
}

/** Só o que tem `type` string entra no redutor — payload torto do canal nunca
 *  vira exceção dentro de um `set` do zustand. */
export function asGuiEvent(evt: unknown): GuiSessionEvent | null {
  if (!evt || typeof evt !== 'object') return null
  const record = evt as Record<string, unknown>
  const type = record['type']
  if (type === 'context-compaction' && typeof record['active'] !== 'boolean') return null
  if (
    type === 'tool' &&
    record['parentToolUseId'] !== undefined &&
    (typeof record['parentToolUseId'] !== 'string' ||
      record['parentToolUseId'].length === 0 ||
      record['parentToolUseId'].length > 256)
  )
    return null
  if (type === 'plan-proposal') {
    // Proposta é a ÚNICA interação cujo payload é estruturado (as outras são
    // texto). Rascunho torto nunca chega ao redutor nem ao card: ou o evento
    // sai NORMALIZADO — títulos aparados, listas com teto, campos vazios fora
    // —, ou ele não existe. Sem isso, um `items` não-array quebraria o card
    // exatamente no momento em que o dono precisa decidir.
    const requestId = record['requestId']
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 256)
      return null
    const draft = readPlanDraft(record['draft'])
    if (!draft) return null
    return { type: 'plan-proposal', requestId, draft }
  }
  if (type === 'tool-result') {
    // Ciclo de vida de subagente: valor torto nunca vira estado. Ausência
    // continua sendo o caminho comum (tool-result normal e Codex inteiro).
    if (
      record['agentStatus'] !== undefined &&
      record['agentStatus'] !== 'launched' &&
      record['agentStatus'] !== 'settled'
    )
      return null
    if (
      record['agentTaskId'] !== undefined &&
      (typeof record['agentTaskId'] !== 'string' ||
        record['agentTaskId'].length === 0 ||
        record['agentTaskId'].length > 256)
    )
      return null
  }
  return typeof type === 'string' ? (evt as GuiSessionEvent) : null
}

// ————— acesso ao namespace do preload —————

interface GuiBridge {
  create: (spawn: GuiPaneSpawn) => Promise<{ ok: boolean; error?: string }>
  configureExecutor: (
    paneId: string,
    patch: GuiExecutorPatch
  ) => Promise<GuiExecutorResult>
  /** PADRÃO DOS AJUDANTES deste chat (D8) — o pino do dono na abinha. */
  delegationDefaults: (paneId: string) => Promise<GuiDelegationDefaults>
  setDelegationDefaults: (
    paneId: string,
    patch: GuiDelegationDefaultsPatch
  ) => Promise<GuiDelegationDefaultsResult>
  send: (
    paneId: string,
    text: string,
    messageId: string,
    attachments?: GuiAttachmentDescriptor[],
    browserReferences?: GuiBrowserReference[]
  ) => Promise<{ ok: boolean; error?: string }>
  deliverQueued: (
    paneId: string,
    input: GuiQueuedDeliveryInput
  ) => Promise<{ ok: boolean; error?: string; retryable?: boolean }>
  permission: (
    paneId: string,
    requestId: string,
    behavior: GuiPermBehavior
  ) => Promise<{ ok: boolean }>
  answerQuestion: (
    paneId: string,
    requestId: string,
    answers: Record<string, string>
  ) => Promise<{ ok: boolean; error?: string }>
  answerPlan: (
    paneId: string,
    requestId: string,
    approve: boolean
  ) => Promise<{ ok: boolean; error?: string }>
  answerPlanProposal: (
    paneId: string,
    requestId: string,
    approve: boolean,
    note?: string
  ) => Promise<{ ok: boolean; error?: string }>
  /** Mirrors GuiResult in main/guiSessions.ts for the stop/finish race. */
  interrupt: (paneId: string, origin?: GuiInterruptOrigin) => Promise<{ ok: boolean; error?: string; alreadyIdle?: boolean }>
  /** R39.1 (D4') — "LER AGORA". Espelho declarado de `gui:forceOwnerMessage`
   *  (`src/preload/index.ts` + `src/main/ipc/gui.ts`). */
  forceOwnerMessage: (paneId: string, messageId: string) => Promise<{ ok: boolean; error?: string }>
  cancelOwnerMessage: (paneId: string, messageId: string) => Promise<{ ok: boolean; error?: string }>
  kill: (paneId: string) => Promise<{ ok: boolean }>
  state: (paneId: string) => Promise<{
    events: unknown[]
    cursor?: number
    exists?: boolean
    alive?: boolean
    permissionMode?: GuiPermissionMode
  }>
  workspaceFiles: (paneId: string) => Promise<GuiWorkspaceFilesResult>
  fileOpen: (
    paneId: string,
    reference: string,
    selectedPath?: string,
    mode?: GuiFileOpenMode
  ) => Promise<GuiFileOpenResult>
  fileOpenExternal: (
    paneId: string,
    reference: string,
    selectedPath: string | undefined,
    mode: GuiFileExternalOpenMode
  ) => Promise<GuiFileExternalOpenResult>
  fileImageData: (paneId: string, reference: string) => Promise<GuiFileImageDataResult>
  attach: (paneId: string, payload: GuiAttachPayload) => Promise<GuiAttachResult>
  attachFolder: (paneId: string) => Promise<GuiAttachResult>
  attachDropped: (paneId: string, file: File) => Promise<GuiAttachResult>
  browserReferencesList: (paneId: string) => Promise<GuiBrowserReferencesResult>
  revealBrowserReference: (paneId: string, id: string) => Promise<GuiBrowserReferenceRevealResult>
  removeBrowserReference: (paneId: string, id: string) => Promise<GuiBrowserReferencesResult>
  consumeBrowserReferences: (paneId: string, ids: string[]) => Promise<GuiBrowserReferencesResult>
  onBrowserReferencesChanged: (cb: (payload: GuiBrowserReferencesPayload) => void) => () => void
  attachmentPreview: (
    paneId: string,
    attachment: GuiAttachmentDescriptor,
    purpose: GuiAttachmentPreviewPurpose
  ) => Promise<GuiAttachmentPreviewResult>
  attachmentAction: (
    paneId: string,
    action: GuiAttachmentAction,
    attachment: GuiAttachmentDescriptor
  ) => Promise<GuiAttachmentActionResult>
  visibility: (paneId: string, active: boolean) => void
  presented: (paneId: string, terminalSeq: number) => void
  onLive: (cb: (payload: GuiLivePayload) => void) => () => void
  onAlert: (cb: (payload: GuiAlertPayload) => void) => () => void
}

function bridge(): Partial<GuiBridge> | undefined {
  return (window as unknown as { synkora?: { gui?: Partial<GuiBridge> } }).synkora?.gui
}

const NO_BRIDGE = 'a ponte do pane GUI ainda não está disponível nesta janela'

export const guiApi = {
  /** false = preload sem o namespace `gui` (devMock/browser puro, ou motor
   *  ainda não mesclado). A UI mostra o aviso em vez de fingir que funcionou. */
  available(): boolean {
    return typeof bridge()?.create === 'function'
  },

  async create(spawn: GuiPaneSpawn): Promise<{ ok: boolean; error?: string }> {
    const api = bridge()
    if (!api?.create) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.create(spawn)) ?? { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async send(
    paneId: string,
    text: string,
    messageId: string,
    attachments?: GuiAttachmentDescriptor[],
    browserReferences?: GuiBrowserReference[]
  ): Promise<{ ok: boolean; error?: string; deliveryUncertain?: boolean }> {
    const api = bridge()
    if (!api?.send) return { ok: false, error: NO_BRIDGE }
    try {
      const result = await api.send(paneId, text, messageId, attachments, browserReferences)
      if (result && typeof result.ok === 'boolean') return result
      return {
        ok: false, error: 'a sessão não confirmou o envio', deliveryUncertain: true
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        deliveryUncertain: true
      }
    }
  },

  async permission(
    paneId: string,
    requestId: string,
    behavior: GuiPermBehavior
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
    const api = bridge()
    if (!api?.permission) return { ok: false, error: NO_BRIDGE, retryable: true }
    try {
      return (await api.permission(paneId, requestId, behavior)) ?? { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true
      }
    }
  },

  async deliverQueued(
    paneId: string,
    input: GuiQueuedDeliveryInput
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean; deliveryUncertain?: boolean }> {
    const api = bridge()
    if (!api?.deliverQueued) return { ok: false, error: NO_BRIDGE, deliveryUncertain: true }
    try {
      const result = await api.deliverQueued(paneId, input)
      if (result && typeof result.ok === 'boolean') return result
      return {
        ok: false, error: 'a sessão não confirmou o envio', deliveryUncertain: true
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        deliveryUncertain: true
      }
    }
  },

  async configureExecutor(
    paneId: string,
    patch: GuiExecutorPatch
  ): Promise<GuiExecutorResult> {
    const api = bridge()
    if (!api?.configureExecutor) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.configureExecutor(paneId, patch)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** O pino dos ajudantes (D8). Sem ponte, VAZIO: "herdado da conversa" é a
   *  verdade num preview sem main, e nunca um pino que ninguém gravou. */
  async delegationDefaults(paneId: string): Promise<GuiDelegationDefaults> {
    const api = bridge()
    if (!api?.delegationDefaults) return {}
    try {
      return (await api.delegationDefaults(paneId)) ?? {}
    } catch {
      return {}
    }
  },

  async setDelegationDefaults(
    paneId: string,
    patch: GuiDelegationDefaultsPatch
  ): Promise<GuiDelegationDefaultsResult> {
    const api = bridge()
    if (!api?.setDelegationDefaults) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.setDelegationDefaults(paneId, patch)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** Retorna a árvore já filtrada pelo main; a chamada é feita uma vez por
   *  pane e o índice de processo evita uma varredura a cada tecla. */
  async workspaceFiles(paneId: string): Promise<GuiWorkspaceFilesResult> {
    const api = bridge()
    if (!api?.workspaceFiles) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.workspaceFiles(paneId)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** Responde o card de pergunta. Mapa VAZIO = pular (o agente segue sem a
   *  escolha) — nunca é o mesmo que negar. */
  async answerQuestion(
    paneId: string,
    requestId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
    const api = bridge()
    if (!api?.answerQuestion) return { ok: false, error: NO_BRIDGE, retryable: true }
    try {
      return (await api.answerQuestion(paneId, requestId, answers)) ?? { ok: true }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        retryable: true
      }
    }
  },

  /** Veredito do card de plano: true = construir, false = devolver para revisão. */
  async answerPlan(
    paneId: string,
    requestId: string,
    approve: boolean
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
    const api = bridge()
    if (!api?.answerPlan) return { ok: false, error: NO_BRIDGE, retryable: true }
    try {
      return (await api.answerPlan(paneId, requestId, approve)) ?? { ok: true }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        retryable: true
      }
    }
  },

  /** Veredito da PROPOSTA de plano (D4.4). `approve` true = o dono mandou
   *  criar (o main grava o Plan e responde ao agente); false = devolveu para
   *  ajuste, e `note` é o que ele escreveu — o texto vira a mensagem que volta
   *  ao agente, então proposta devolvida sem palavra nenhuma é só "ajuste". */
  async answerPlanProposal(
    paneId: string,
    requestId: string,
    approve: boolean,
    note?: string
  ): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
    const api = bridge()
    if (!api?.answerPlanProposal) return { ok: false, error: NO_BRIDGE, retryable: true }
    try {
      return (await api.answerPlanProposal(paneId, requestId, approve, note)) ?? { ok: true }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        retryable: true
      }
    }
  },

  async interrupt(paneId: string, origin?: GuiInterruptOrigin): Promise<{ ok: boolean; error?: string; alreadyIdle?: boolean }> {
    const api = bridge()
    if (!api?.interrupt) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.interrupt(paneId, origin)) ?? { ok: false, error: 'a sessão não confirmou a interrupção' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /**
   * R39.1 (D4') — O CORTE POR GESTO. Decisão do dono: *"se eu quiser eu posso
   * forçar, aí forçando ele para o turno e lê o que eu quero falar, quando for
   * algo urgente."* Só o TURNO é cortado (a frota de ajudantes segue). Forçar
   * uma fala já lida é no-op no main; a recusa volta com texto e a bolha a
   * mostra na linha de aviso — nunca some em silêncio.
   */
  async forceOwnerMessage(
    paneId: string,
    messageId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const api = bridge()
    if (!api?.forceOwnerMessage) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.forceOwnerMessage(paneId, messageId)) ?? { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async cancelOwnerMessage(paneId: string, messageId: string): Promise<{ ok: boolean; error?: string }> {
    const api = bridge()
    if (!api?.cancelOwnerMessage) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.cancelOwnerMessage(paneId, messageId)) ?? { ok: false, error: 'o cancelamento não foi confirmado' }
    } catch {
      return { ok: false, error: 'o cancelamento não foi confirmado; a mensagem foi preservada' }
    }
  },

  browserReferencesAvailable(): boolean {
    return typeof bridge()?.browserReferencesList === 'function'
  },

  async browserReferencesList(paneId: string): Promise<GuiBrowserReferencesResult> {
    const api = bridge()
    if (!api?.browserReferencesList) return { ok: false, references: [], error: NO_BRIDGE }
    try {
      const result = await api.browserReferencesList(paneId)
      return result && typeof result.ok === 'boolean' && Array.isArray(result.references)
        ? result : { ok: false, references: [], error: 'não foi possível carregar as referências da página' }
    } catch {
      return { ok: false, references: [], error: 'não foi possível carregar as referências da página' }
    }
  },

  async removeBrowserReference(paneId: string, id: string): Promise<GuiBrowserReferencesResult> {
    const api = bridge()
    if (!api?.removeBrowserReference) return { ok: false, references: [], error: NO_BRIDGE }
    try {
      const result = await api.removeBrowserReference(paneId, id)
      return result && typeof result.ok === 'boolean' && Array.isArray(result.references)
        ? result : { ok: false, references: [], error: 'não foi possível remover a referência; tente novamente' }
    } catch {
      return { ok: false, references: [], error: 'não foi possível remover a referência; tente novamente' }
    }
  },

  async revealBrowserReference(paneId: string, id: string): Promise<GuiBrowserReferenceRevealResult> {
    const api = bridge()
    if (!api?.revealBrowserReference) return { ok: false, error: 'Reabra o Synkora para localizar referências na página.' }
    try {
      const result = await api.revealBrowserReference(paneId, id)
      if (result?.ok === true) return result
      if (result?.ok === false && typeof result.error === 'string') return result
    } catch { /* Keep IPC exceptions out of the user-facing message. */ }
    return { ok: false, error: 'Não consegui mostrar o elemento agora. Tente novamente.' }
  },

  async consumeBrowserReferences(paneId: string, ids: string[]): Promise<GuiBrowserReferencesResult> {
    const api = bridge()
    if (!api?.consumeBrowserReferences) return { ok: false, references: [], error: NO_BRIDGE }
    try {
      const result = await api.consumeBrowserReferences(paneId, ids)
      return result && typeof result.ok === 'boolean' && Array.isArray(result.references)
        ? result : { ok: false, references: [], error: 'a mensagem foi enviada, mas a lista de referências não foi atualizada' }
    } catch {
      return { ok: false, references: [], error: 'a mensagem foi enviada, mas a lista de referências não foi atualizada' }
    }
  },

  onBrowserReferencesChanged(cb: (payload: GuiBrowserReferencesPayload) => void): () => void {
    return bridge()?.onBrowserReferencesChanged?.(payload => {
      if (payload && typeof payload.paneId === 'string' && Array.isArray(payload.references)) cb(payload)
    }) ?? (() => undefined)
  },

  async kill(paneId: string): Promise<{ ok: boolean }> {
    const api = bridge()
    if (!api?.kill) return { ok: false }
    try {
      return (await api.kill(paneId)) ?? { ok: true }
    } catch {
      return { ok: false }
    }
  },

  /** Replay para remontagem: o main guarda um ring buffer (~500 eventos) por
   *  pane. Devolve a lista já filtrada pelo espelho de tipos. */
  async state(paneId: string): Promise<GuiReplayState> {
    const api = bridge()
    if (!api?.state) return { events: [], cursor: 0, exists: false, alive: false }
    try {
      const res = await api.state(paneId)
      const rawEvents = Array.isArray(res?.events) ? res.events : []
      const events: GuiReplayEvent[] = []
      for (let index = 0; index < rawEvents.length; index += 1) {
        const raw = rawEvents[index]
        const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
        const sequenced = record && typeof record['seq'] === 'number' ? record : null
        const evt = asGuiEvent(sequenced ? sequenced['evt'] : raw)
        if (!evt) continue
        events.push({ seq: sequenced ? (sequenced['seq'] as number) : index + 1, evt })
      }
      const fallbackCursor = events.reduce((max, event) => Math.max(max, event.seq), 0)
      const exists = typeof res?.exists === 'boolean' ? res.exists : events.length > 0
      return {
        events,
        cursor:
          typeof res?.cursor === 'number' && Number.isSafeInteger(res.cursor)
            ? res.cursor
            : fallbackCursor,
        exists,
        // Ponte antiga nao informava vida; assumir viva quando ela afirmava
        // que a entrada existia evita abrir dois processos durante upgrade.
        alive: typeof res?.alive === 'boolean' ? res.alive : exists,
        permissionMode: res?.permissionMode
      }
    } catch {
      return { events: [], cursor: 0, exists: false, alive: false }
    }
  },

  async fileOpen(
    paneId: string,
    reference: string,
    selectedPath?: string,
    mode?: GuiFileOpenMode
  ): Promise<GuiFileOpenResult> {
    const api = bridge()
    if (!api?.fileOpen) {
      return { ok: false, reason: 'unavailable', error: NO_BRIDGE }
    }
    try {
      return mode === undefined
        ? await api.fileOpen(paneId, reference, selectedPath)
        : await api.fileOpen(paneId, reference, selectedPath, mode)
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  },

  /** Manda o arquivo citado no fio para FORA do app (rodada 7, C1 — a metade do
   *  CHAT). Espelho tipado do canal; o par de transporte que o menu de contexto
   *  usa mora em `guiFileContextMenu.ts` (ele é carregado direto pelo node nas
   *  suítes e por isso não pode importar este módulo — o comentário de lá
   *  aponta para cá). */
  async fileOpenExternal(
    paneId: string,
    reference: string,
    selectedPath: string | undefined,
    mode: GuiFileExternalOpenMode
  ): Promise<GuiFileExternalOpenResult> {
    const api = bridge()
    if (!api?.fileOpenExternal) {
      return { ok: false, reason: 'unavailable', error: NO_BRIDGE }
    }
    try {
      return await api.fileOpenExternal(paneId, reference, selectedPath, mode)
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  },

  /** R36 — a IMAGEM citada no fio vira pixel. O main lê os bytes DENTRO do cwd
   *  do pane (mesma cerca do `fileOpen`), tira o mime dos bytes e devolve data
   *  URL; sem ponte, a recusa nomeia a receita em vez de a imagem sumir muda —
   *  foi exatamente o sumiço mudo que fez o agente alucinar "está exibida
   *  acima". */
  async fileImageData(paneId: string, reference: string): Promise<GuiFileImageDataResult> {
    const api = bridge()
    if (!api?.fileImageData) {
      return {
        ok: false,
        error:
          'reinicie o app (npm run dev) para o chat mostrar imagens do worktree — esta janela ainda não tem o canal de imagem'
      }
    }
    try {
      return await api.fileImageData(paneId, reference)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async attach(paneId: string, payload: GuiAttachPayload): Promise<GuiAttachResult> {
    const api = bridge()
    if (!api?.attach) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.attach(paneId, payload)
    } catch {
      return { ok: false, error: 'não consegui anexar o arquivo' }
    }
  },

  async attachFolder(paneId: string): Promise<GuiAttachResult> {
    const api = bridge()
    if (!api?.attachFolder) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.attachFolder(paneId)
    } catch {
      return { ok: false, error: 'não consegui abrir o seletor de pasta' }
    }
  },

  /** O item SOLTO no chat sobe como File; o caminho nasce no preload. Preload
   *  antigo (app sem reiniciar depois desta entrega) responde com a receita,
   *  nunca com o beco "não deu para ler". */
  async attachDropped(paneId: string, file: File): Promise<GuiAttachResult> {
    const api = bridge()
    if (!api?.attachDropped) {
      return {
        ok: false,
        error: api?.attach
          ? 'soltar no chat pede o app reiniciado — por enquanto use o + › Pasta'
          : NO_BRIDGE
      }
    }
    try {
      return await api.attachDropped(paneId, file)
    } catch {
      return { ok: false, error: `não consegui anexar ${file.name || 'o item solto'}` }
    }
  },

  async attachmentPreview(
    paneId: string,
    attachment: GuiAttachmentDescriptor,
    purpose: GuiAttachmentPreviewPurpose
  ): Promise<GuiAttachmentPreviewResult> {
    const api = bridge()
    if (!api?.attachmentPreview) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.attachmentPreview(paneId, attachment, purpose)
    } catch {
      // Exceções IPC podem carregar detalhes nativos (inclusive caminhos).
      // Prévia nunca reflete esse texto no DOM.
      return { ok: false, error: 'não consegui preparar a prévia' }
    }
  },

  async attachmentAction(
    paneId: string,
    action: GuiAttachmentAction,
    attachment: GuiAttachmentDescriptor
  ): Promise<GuiAttachmentActionResult> {
    const api = bridge()
    if (!api?.attachmentAction) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.attachmentAction(paneId, action, attachment)
    } catch {
      return { ok: false, error: 'não consegui concluir a ação do anexo' }
    }
  },

  /** Assina o canal `gui:live`. Devolve unsubscribe (no-op sem ponte). */
  onLive(cb: (payload: GuiLivePayload) => void): () => void {
    const api = bridge()
    if (!api?.onLive) return () => undefined
    try {
      return api.onLive(cb) ?? (() => undefined)
    } catch {
      return () => undefined
    }
  },

  visibility(paneId: string, active: boolean): void {
    const api = bridge()
    try {
      api?.visibility?.(paneId, active)
    } catch {
      // Visibilidade é um sinal auxiliar; o chat continua utilizável sem ele.
    }
  },

  /**
   * ACK visual: a interface informa somente o seq; o resultado continua sendo
   * escolhido pelo evento canônico que ficou retido no processo principal.
   */
  presented(paneId: string, terminalSeq: number): void {
    const api = bridge()
    try {
      api?.presented?.(paneId, terminalSeq)
    } catch {
      // Uma desmontagem concorrente não pode quebrar a conversa.
    }
  },

  onAlert(cb: (payload: GuiAlertPayload) => void): () => void {
    const api = bridge()
    if (!api?.onAlert) return () => undefined
    try {
      return api.onAlert(cb) ?? (() => undefined)
    } catch {
      return () => undefined
    }
  }
}

/**
 * MOTOR DO PANE GUI (Synkora 2.0, onda A — docs/GUI_PANE_CONTRACT.md).
 *
 * Onde nascia um xterm com o CLI dentro, nasce um CHAT: o motor é o que já
 * existe no repo — MaestroSession (claude, stream-json) e CodexSession (codex,
 * app-server) — só que instanciado POR PANE, num Map. Aqui não há nada de
 * terminal: o registro spawna, guarda os eventos num anel para a remontagem
 * poder replayar, e empurra cada evento ao renderer.
 *
 * REGRAS QUE VALEM COMO CONTRATO:
 * - Uma sessão por paneId. `matches()` das classes NUNCA é usado para
 *   reaproveitar sessão entre panes — a chave é o paneId e ponto.
 * - Pane GUI roda com `idleTimeoutMs: 0`: chat aberto não morre por tédio.
 * - Persona do claude vai por ARQUIVO (--append-system-prompt-file): argv tem
 *   teto de 32767 chars no Windows (caso 02/08). No codex ela é
 *   developerInstructions do thread/start, então viaja como string.
 * - `paneId → {sessionId, cli}` e o transcript visível limitado são
 *   persistidos para o resume pós-boot; a morte do pane NÃO apaga nenhum dos
 *   dois (retomar é decisão de quem reabre).
 * - Higiene de env (deletar os marcadores CLAUDE_CODE_ e CLAUDECODE herdados)
 *   já é feita dentro das classes de sessão — nada a repetir aqui.
 */
import { randomUUID } from 'node:crypto'
import { CodexSession } from './codexSession'
import { MaestroSession, type SessionEvent } from './maestroSession'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import { limitGuiToolInput } from './guiToolInput'
import { GuiAlertSequencer, type GuiNoticeKind } from './guiNotices'
import {
  GUI_ATTACHMENT_MAX_FILES,
  isGuiAttachmentDescriptor,
  withGuiAttachmentReferences,
  type GuiAttachmentDescriptor
} from './guiAttachments'
import { validateGuiAttachmentReferences } from './guiAttachmentStorage'
import { GuiAttachmentCapabilityStore } from './guiAttachmentCapabilities'
import { isPlanDraft, type PlanDraft } from './planDraft'
import {
  GuiHelperCardCorrelator,
  guiOrphanHelperCancellations,
  type GuiHelperInbox,
  type GuiHelperInterruptedInput,
  type GuiHelperWake
} from './guiHelperCards'
import { GuiOwnerMailbox, guiOwnerMailFlushText, guiOwnerMailbox } from './guiOwnerMail'
import type {
  GuiHelperChange,
  GuiHelperDelegator,
  GuiHelperSnapshot
} from './guiHelperSessions'

export const GUI_PROMPT_MAX_CHARS = 256 * 1024
export const GUI_PROMPT_MAX_BYTES = 1024 * 1024

// ————— tipos do contrato (fonte única — o renderer copia VERBATIM) —————

export interface GuiPaneSpawn {
  paneId: string
  projectId: string
  cli: 'claude' | 'codex'
  /** Config dir isolado do seat (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  configDir: string
  /** id do seat dono desta conversa — o renderer usa para o menu de troca */
  seatId?: string
  /** Worktree da missão (ou raiz do projeto no planejamento). */
  cwd: string
  model?: string
  effort?: string
  /** Persona/contrato curto (claude: append-system-prompt; codex: developerInstructions). */
  systemPrompt?: string
  /** Retomar conversa existente (claude sessionId / codex thread id). */
  resumeSessionId?: string
  /** Primeiro turno injetado logo após o spawn (ex.: conteúdo do plano da missão). */
  firstPrompt?: string
  /** Modo de permissão DESTA conversa (onda D — o seletor do composer).
   *  Ausente = 'default' (o padrão do binário). */
  permissionMode?: GuiPermissionMode
  /** R11 — MODO FAST desta conversa (sonda probe-fast: claude = opt-in
   *  --settings fastMode, que nasce LIGADO e troca o modelo para Opus 5;
   *  codex = service tier 'priority'). É configuração de PROCESSO: trocar
   *  respawna com resume (o caminho do permissionMode) e entra no
   *  fingerprint. Ausente = off — fast nunca é herdado em silêncio (a lição
   *  do prompt-cache: fast acidental é caro). */
  fast?: boolean
  /** MCP do Synkora para ESTE pane (onda D): só a missão de PLANEJAMENTO o
   *  recebe — ver guiPlannerMcp.ts. Ausente = chat sem ferramenta nossa, que
   *  é o que todo pane GUI foi até aqui. Entra no fingerprint: armar/desarmar
   *  o servidor muda a linha de comando e exige processo novo. */
  mcp?: { args: string[]; env?: Record<string, string> }
}

/**
 * Troca as ferramentas de um spawn pelas que o main acabou de re-materializar.
 * `undefined` REMOVE a chave (em vez de deixá-la com valor vazio): o spawn de
 * um pane sem ferramentas tem de ser indistinguível do de um pane que nunca as
 * teve — é o mesmo objeto que alimenta `spawnSession` e o registro vivo.
 */
export function withGuiPaneTools(
  spawn: GuiPaneSpawn,
  mcp: GuiPaneSpawn['mcp'] | undefined
): GuiPaneSpawn {
  if (mcp) return { ...spawn, mcp }
  const { mcp: _dropped, ...rest } = spawn
  return rest
}

export type GuiPermBehavior = 'allow' | 'allow-always' | 'deny'

// ————— modo de permissão POR CONVERSA (2.0, onda D) —————

/**
 * O seletor do composer, na régua do dono: padrão (pergunta tudo) / edições
 * (edita sem perguntar) / bypass (não pergunta nada) / plano (só lê).
 * Vocabulário ÚNICO — cada CLI recebe a tradução dele em `guiPermissionProfile`.
 */
export type GuiPermissionMode = 'default' | 'acceptEdits' | 'bypass' | 'plan'

export const GUI_PERMISSION_MODES: readonly GuiPermissionMode[] = [
  'default',
  'acceptEdits',
  'bypass',
  'plan'
]

export function isGuiPermissionMode(value: unknown): value is GuiPermissionMode {
  return typeof value === 'string' && (GUI_PERMISSION_MODES as readonly string[]).includes(value)
}

/** As chaves REAIS de cada CLI. Campo ausente = não passa flag nenhuma. */
export interface GuiPermissionProfile {
  /** claude: `--permission-mode` (validado no binário: acceptEdits, plan, bypassPermissions). */
  permissionMode?: string
  /** codex: SandboxMode do `thread/start`. */
  sandbox?: string
  /** codex: política de aprovação do `turn/start`. */
  approvalPolicy?: string
}

/**
 * Tradução do modo para o CLI. O claude tem UMA chave (`--permission-mode`);
 * o codex separa o que o agente PODE fazer (sandbox) de quando ele PERGUNTA
 * (approvalPolicy) — 'bypass' e 'plano' precisam dos dois, senão o pane cairia
 * num diálogo de aprovação que o chat não tem como mostrar duas vezes.
 */
export function guiPermissionProfile(
  cli: 'claude' | 'codex',
  mode: GuiPermissionMode | undefined
): GuiPermissionProfile {
  if (!mode || mode === 'default') return {}
  if (cli === 'claude') {
    if (mode === 'acceptEdits') return { permissionMode: 'acceptEdits' }
    if (mode === 'bypass') return { permissionMode: 'bypassPermissions' }
    return { permissionMode: 'plan' }
  }
  if (mode === 'acceptEdits') return { sandbox: 'workspace-write' }
  if (mode === 'bypass') return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  return { sandbox: 'read-only', approvalPolicy: 'never' }
}

/** Evento vivo empurrado ao renderer. `evt` é o SessionEvent dos backends
 *  (maestroSession.ts — kinds: init, delta, thinking, text, tool, tool-result,
 *  permission, permission-cancel, session-id, ready, command-output, limit,
 *  result, fatal, closed). */
export interface GuiSequencedEvent {
  seq: number
  evt: unknown /* SessionEvent */
}

export interface GuiLivePayload extends GuiSequencedEvent {
  paneId: string
}

export interface GuiStatePayload {
  events: GuiSequencedEvent[]
  cursor: number
  exists: boolean
  alive: boolean
}

/** Resposta padrão dos canais gui:* — `error` em PT-BR, é texto de UI. */
export interface GuiResult {
  ok: boolean
  error?: string
}

/** Mudança de executor solicitada pelo composer. `null` limpa o override;
 *  campo ausente conserva a escolha atual. O main valida contra as caps da
 *  sessão viva antes de tocar no backend. */
export interface GuiExecutorPatch {
  model?: string | null
  effort?: string | null
}

export type GuiExecutorResult =
  | { ok: true; model: string | null; effort: string | null }
  | { ok: false; error: string }

export const GUI_QUEUED_DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const GUI_QUEUED_RECEIPT_TTL_MS = GUI_QUEUED_DELIVERY_MAX_AGE_MS + 24 * 60 * 60 * 1_000
const GUI_QUEUED_RECEIPT_CAP = 256

/** Envelope autoritativo do P1. O main recebe texto, anexos e a fotografia
 * inteira das opcoes numa unica operacao; assim nunca prepara um bilhete e
 * envia outro por uma corrida entre os dois renderers. */
export interface GuiQueuedDeliveryInput {
  id: string
  text: string
  at: number
  options: {
    model: string | null
    effort: string | null
    permissionMode: string
  }
  attachments: GuiAttachmentDescriptor[]
}

export function guiQueuedDeliveryProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'mensagem da fila em formato inválido'
  }
  const candidate = value as Partial<GuiQueuedDeliveryInput>
  const options = candidate.options
  const idProblem = guiMessageIdProblem(candidate.id)
  if (idProblem) return idProblem
  const now = Date.now()
  if (
    typeof candidate.at !== 'number' ||
    !Number.isFinite(candidate.at) ||
    candidate.at > now + 5 * 60_000 ||
    candidate.at < now - GUI_QUEUED_DELIVERY_MAX_AGE_MS
  )
    return 'mensagem da fila expirou; edite para criar um novo envio'
  const promptProblem = guiPromptProblem(candidate.text, 'mensagem da fila', true)
  if (promptProblem) return promptProblem
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return 'opções da fila em formato inválido'
  }
  if (!isGuiPermissionMode(options.permissionMode)) return 'modo de permissão da fila inválido'
  for (const [label, option] of [
    ['modelo', options.model],
    ['effort', options.effort]
  ] as const) {
    if (
      option !== null &&
      (typeof option !== 'string' || !option.trim() || option.length > 128)
    ) {
      return `${label} da fila inválido`
    }
  }
  if (
    !Array.isArray(candidate.attachments) ||
    candidate.attachments.length > GUI_ATTACHMENT_MAX_FILES ||
    !candidate.attachments.every(isGuiAttachmentDescriptor)
  ) {
    return 'anexos da fila em formato inválido'
  }
  if (!candidate.text?.trim() && candidate.attachments.length === 0) return 'mensagem da fila vazia'
  return null
}

/** Valida antes de guardar, clonar por IPC ou serializar para qualquer CLI. */
export function guiPromptProblem(
  value: unknown,
  label = 'mensagem',
  allowEmpty = false
): string | null {
  if (typeof value !== 'string') return `${label} em formato inválido`
  if (value.length > GUI_PROMPT_MAX_CHARS || Buffer.byteLength(value, 'utf8') > GUI_PROMPT_MAX_BYTES)
    return `${label} grande demais (limite de 256 mil caracteres)`
  if (!allowEmpty && !value.trim()) return `${label} vazia`
  return null
}

/**
 * A PRIMEIRA MENSAGEM DO DONO, com o briefing da missão colado na frente.
 *
 * O pane nasce mudo, então o agente conhece a missão e a pergunta do dono no
 * MESMO turno. O texto do dono fica por último e íntegro — o briefing é
 * prefixo, nunca moldura —, e o rótulo separa as duas vozes para o agente não
 * confundir contrato com pedido. Função pura: o teto de tamanho é medido sobre
 * exatamente o que vai sair.
 */
export function guiBriefedPrompt(briefing: string, prompt: string): string {
  return `${briefing}\n\n---\n\nA MENSAGEM DO DONO:\n${prompt}`
}

// ————— anel de eventos (replay da remontagem) —————

export function guiMessageIdProblem(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? null
    : 'mensagem sem identificador válido'
}

export const GUI_RING_CAP = 500
export const GUI_RING_BYTE_CAP = 4 * 1024 * 1024
// TODO (degradação aceita, decisão de 2026-08-15): o anel poda por idade, sem
// saber o que ainda está VIVO. Conversa longa pode empurrar para fora o
// tool-result `agentStatus: 'launched'` de um subagente ainda trabalhando — o
// replay pós-remontagem perde aquela entrada da lateral (a sessão viva segue
// correta: o registro de tarefas mora no motor, não no anel). Se doer, reter de
// forma sticky o evento de lifecycle vivo em vez de aumentar o teto.
/** O documento guarda muitos panes; o teto global impede 4 MiB × N sem fim. */
export const GUI_TRANSCRIPT_STORE_BYTE_CAP = 32 * 1024 * 1024
export const GUI_TRANSCRIPT_STORE_PANE_CAP = 64
const GUI_TRANSCRIPT_HYDRATE_EVENT_CAP = GUI_RING_CAP * 4

function guiEventSize(evt: unknown): number {
  try {
    const serialized = JSON.stringify(evt)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  } catch {
    return GUI_RING_BYTE_CAP
  }
}

type GuiStickyEvent =
  | 'init'
  | 'session-id'
  | 'ready'
  | 'session-restarted'
  | 'executor-changed'
  | 'context-usage'

type GuiPendingInteractionEvent = 'permission' | 'question' | 'plan-review' | 'plan-proposal'

/**
 * A proposta de plano é a ÚNICA pendência que não bloqueia o CLI: o agente
 * chama `propose_plan`, a tool responde na hora e o turno termina. Se ela
 * caísse na limpeza do `result` como as outras, o card sumiria antes de o dono
 * chegar a vê-lo.
 */
function guiSurvivesTurnEnd(type: GuiPendingInteractionEvent): boolean {
  return type === 'plan-proposal'
}

function guiStickyEvent(evt: unknown): GuiStickyEvent | null {
  if (!evt || typeof evt !== 'object') return null
  const type = (evt as { type?: unknown }).type
  return type === 'init' ||
    type === 'session-id' ||
    type === 'ready' ||
    type === 'session-restarted' ||
    type === 'executor-changed' ||
    type === 'context-usage'
    ? type
    : null
}

function guiEventRecord(evt: unknown): Record<string, unknown> | null {
  return evt && typeof evt === 'object' ? (evt as Record<string, unknown>) : null
}

function guiPendingInteraction(evt: unknown): { requestId: string; type: GuiPendingInteractionEvent } | null {
  const record = guiEventRecord(evt)
  if (!record || typeof record['requestId'] !== 'string' || !record['requestId']) return null
  const type = record['type']
  if (
    type !== 'permission' &&
    type !== 'question' &&
    type !== 'plan-review' &&
    type !== 'plan-proposal'
  )
    return null
  return { requestId: record['requestId'], type }
}

function guiResolvedInteractionId(evt: unknown): string | null {
  const record = guiEventRecord(evt)
  if (!record || typeof record['requestId'] !== 'string' || !record['requestId']) return null
  return record['type'] === 'interaction-resolved' || record['type'] === 'permission-cancel'
    ? record['requestId']
    : null
}

function guiTerminalEvent(evt: unknown): boolean {
  const type = guiEventRecord(evt)?.['type']
  return type === 'result' || type === 'fatal' || type === 'closed'
}

function guiPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function guiRequestId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function guiOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function guiOptionalFinite(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function guiNullableContextTokens(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function guiNullableContextWindow(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
}

function guiOptionalContextTokens(value: unknown): boolean {
  return value === undefined || guiNullableContextTokens(value)
}

function guiOptionalContextWindow(value: unknown): boolean {
  return value === undefined || guiNullableContextWindow(value)
}

function guiPersistedCaps(value: unknown): boolean {
  const caps = guiPlainRecord(value)
  if (!caps || !Array.isArray(caps['commands']) || !Array.isArray(caps['models'])) return false
  const commandsOk = caps['commands'].every((command) => {
    const item = guiPlainRecord(command)
    return Boolean(
      item &&
        typeof item['name'] === 'string' &&
        typeof item['description'] === 'string' &&
        guiOptionalString(item['argumentHint'])
    )
  })
  const modelsOk = caps['models'].every((model) => {
    const item = guiPlainRecord(model)
    return Boolean(
      item &&
        typeof item['value'] === 'string' &&
        typeof item['displayName'] === 'string' &&
        guiOptionalString(item['description']) &&
        (item['supportedEffortLevels'] === undefined ||
          (Array.isArray(item['supportedEffortLevels']) &&
            item['supportedEffortLevels'].every((level) => typeof level === 'string')))
    )
  })
  return commandsOk && modelsOk
}

function guiPersistedQuestions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return false
  return value.every((question) => {
    const item = guiPlainRecord(question)
    if (
      !item ||
      typeof item['question'] !== 'string' ||
      !item['question'].trim() ||
      !guiOptionalString(item['header']) ||
      (item['multiSelect'] !== undefined && typeof item['multiSelect'] !== 'boolean') ||
      !Array.isArray(item['options']) ||
      item['options'].length === 0 ||
      item['options'].length > 12
    )
      return false
    return item['options'].every((option) => {
      const parsed = guiPlainRecord(option)
      return Boolean(
        parsed &&
          typeof parsed['label'] === 'string' &&
          parsed['label'].trim() &&
          guiOptionalString(parsed['description'])
      )
    })
  })
}

function guiPersistedResolution(value: unknown): boolean {
  const resolution = guiPlainRecord(value)
  if (!resolution) return false
  if (resolution['kind'] === 'stale') return true
  if (resolution['kind'] === 'plan') return typeof resolution['approve'] === 'boolean'
  if (resolution['kind'] === 'plan-proposal')
    return (
      typeof resolution['approve'] === 'boolean' &&
      (resolution['planId'] === undefined || guiRequestId(resolution['planId'])) &&
      guiOptionalString(resolution['planTitle'])
    )
  if (resolution['kind'] === 'permission')
    return (
      typeof resolution['toolName'] === 'string' &&
      guiOptionalString(resolution['toolUseId']) &&
      (resolution['behavior'] === 'allow' ||
        resolution['behavior'] === 'allow-always' ||
        resolution['behavior'] === 'deny')
    )
  if (resolution['kind'] !== 'question' || !Array.isArray(resolution['entries'])) return false
  return resolution['entries'].every((entry) => {
    const item = guiPlainRecord(entry)
    return Boolean(
      item && typeof item['question'] === 'string' && typeof item['answer'] === 'string'
    )
  })
}

/** Eventos do transcript vieram de JSON local, não do backend vivo. A
 *  hidratação aceita somente o contrato conhecido e formas que o redutor
 *  consegue consumir sem coerção/exceção. */
export function isGuiPersistedEvent(value: unknown): value is SessionEvent {
  const event = guiPlainRecord(value)
  if (!event || guiEventSize(value) > GUI_RING_BYTE_CAP) return false
  switch (event['type']) {
    case 'init':
      return (
        typeof event['model'] === 'string' &&
        typeof event['sessionId'] === 'string' &&
        typeof event['permissionMode'] === 'string' &&
        Number.isSafeInteger(event['toolCount']) &&
        guiOptionalFinite(event['contextWindow'])
      )
    case 'delta':
    case 'text':
    case 'command-output':
    case 'limit':
    case 'fatal':
      return typeof event['text'] === 'string'
    case 'thinking':
      return guiOptionalString(event['text'])
    case 'turn-started':
    case 'conversation-cleared':
      return true
    case 'turn-continuation':
      return typeof event['continues'] === 'boolean'
    case 'session-restarted':
      return (
        typeof event['ready'] === 'boolean' &&
        // R12: carimbo de "a mesma conversa continua". Ausente = fotografia
        // gravada antes do contrato novo, hidratada como geração nova.
        (event['resumed'] === undefined || typeof event['resumed'] === 'boolean') &&
        guiOptionalContextTokens(event['contextTokens']) &&
        guiOptionalContextWindow(event['contextWindow'])
      )
    case 'executor-changed':
      return (
        (event['model'] === null || typeof event['model'] === 'string') &&
        (event['effort'] === null || typeof event['effort'] === 'string')
      )
    case 'user-message':
      return (
        guiMessageIdProblem(event['id']) === null &&
        guiPromptProblem(event['text']) === null &&
        (event['attachments'] === undefined ||
          (Array.isArray(event['attachments']) &&
            event['attachments'].length <= 20 &&
            event['attachments'].every(isGuiAttachmentDescriptor))) &&
        typeof event['at'] === 'number' &&
        Number.isFinite(event['at'])
      )
    case 'tool':
      return (
        typeof event['name'] === 'string' &&
        Boolean(guiPlainRecord(event['input'])) &&
        guiOptionalString(event['toolUseId']) &&
        (event['parentToolUseId'] === undefined || guiRequestId(event['parentToolUseId']))
      )
    case 'tool-result':
      return (
        typeof event['text'] === 'string' &&
        typeof event['isError'] === 'boolean' &&
        guiOptionalString(event['toolUseId']) &&
        guiOptionalFinite(event['lineCount']) &&
        (event['truncated'] === undefined || typeof event['truncated'] === 'boolean') &&
        (event['outcome'] === undefined ||
          event['outcome'] === 'completed' ||
          event['outcome'] === 'failed' ||
          event['outcome'] === 'denied' ||
          event['outcome'] === 'cancelled' ||
          // R6.1: o card de um AJUDANTE parado de forma preservadora. Sem este
          // literal aqui, o card do interrompido seria DESCARTADO na hidratação
          // — a fotografia do boot perderia justamente o card em que o dono
          // ainda tem uma decisão a tomar.
          event['outcome'] === 'interrupted') &&
        // Ciclo de vida de subagente em background (Claude). Ausente = evento
        // comum, hidratado exatamente como antes.
        (event['agentStatus'] === undefined ||
          event['agentStatus'] === 'launched' ||
          event['agentStatus'] === 'settled') &&
        (event['agentTaskId'] === undefined || guiRequestId(event['agentTaskId']))
      )
    case 'permission':
      return (
        guiRequestId(event['requestId']) &&
        guiOptionalString(event['toolUseId']) &&
        typeof event['toolName'] === 'string' &&
        typeof event['description'] === 'string' &&
        typeof event['inputPretty'] === 'string' &&
        guiOptionalString(event['reason']) &&
        guiOptionalString(event['permissionRule']) &&
        typeof event['canAlways'] === 'boolean'
      )
    case 'permission-cancel':
      return guiRequestId(event['requestId'])
    case 'interaction-resolved':
      return guiRequestId(event['requestId']) && guiPersistedResolution(event['resolution'])
    case 'question':
      return guiRequestId(event['requestId']) && guiPersistedQuestions(event['questions'])
    case 'plan-review':
      return (
        guiRequestId(event['requestId']) &&
        typeof event['plan'] === 'string' &&
        event['plan'].length <= 64 * 1024
      )
    case 'plan-proposal':
      // O rascunho persistido volta do disco: só a forma TOTAL que a porteira
      // produz é aceita — card meio pronto não renasce.
      return guiRequestId(event['requestId']) && isPlanDraft(event['draft'])
    case 'session-id':
      return typeof event['sessionId'] === 'string' && event['sessionId'].length > 0
    case 'ready':
      return guiPersistedCaps(event['caps'])
    case 'command-completed':
      return (
        typeof event['isError'] === 'boolean' &&
        typeof event['continues'] === 'boolean' &&
        guiOptionalString(event['errorText'])
      )
    case 'context-usage':
      return (
        guiNullableContextTokens(event['contextTokens']) &&
        guiNullableContextWindow(event['contextWindow'])
      )
    case 'result':
      return (
        typeof event['isError'] === 'boolean' &&
        (event['outcome'] === undefined ||
          event['outcome'] === 'completed' ||
          event['outcome'] === 'failed' ||
          event['outcome'] === 'cancelled') &&
        (event['continues'] === undefined || typeof event['continues'] === 'boolean') &&
        guiOptionalString(event['errorText']) &&
        guiOptionalString(event['resultText']) &&
        guiOptionalString(event['fastModeState']) &&
        guiOptionalContextTokens(event['contextTokens']) &&
        guiOptionalContextWindow(event['contextWindow']) &&
        guiOptionalFinite(event['costUsd'])
      )
    case 'closed':
      return event['code'] === null || Number.isSafeInteger(event['code'])
    default:
      return false
  }
}

/** Pontos que mudam o fio legível. Metadados de handshake já são gravados
 *  por `remember`; delta/thinking/tool-start ficam no anel e entram no próximo
 *  checkpoint ou na barreira final de `dispose`. */
function guiTranscriptCheckpoint(evt: SessionEvent): boolean {
  switch (evt.type) {
    case 'user-message':
    case 'text':
    case 'tool-result':
    case 'permission':
    case 'permission-cancel':
    case 'interaction-resolved':
    case 'question':
    case 'plan-review':
    case 'plan-proposal':
    case 'turn-continuation':
    case 'session-restarted':
    case 'conversation-cleared':
    case 'executor-changed':
    case 'context-usage':
    case 'command-output':
    case 'command-completed':
    case 'limit':
    case 'result':
    case 'fatal':
    case 'closed':
      return true
    default:
      return false
  }
}

/**
 * Buffer circular por pane. O renderer remonta (troca de aba, reload da view)
 * e pede `gui:state` — sem isto a conversa nasceria vazia com a sessão viva.
 * Dois tetos independentes protegem o replay: contagem e bytes serializados.
 * O evento mais novo é preservado mesmo quando, sozinho, ultrapassa o teto.
 */
export class GuiEventRing {
  private items: { seq: number; evt: unknown; size: number }[] = []
  private sticky = new Map<GuiStickyEvent, { seq: number; evt: unknown; size: number }>()
  /**
   * Pedidos ainda sem resposta não podem competir com deltas pela janela do
   * replay: se um deles sumir, o backend continua esperando mas o dono perde o
   * único controle capaz de respondê-lo. O requestId é a identidade canônica.
   */
  private interactions = new Map<string, { seq: number; evt: unknown; size: number }>()
  private bytes = 0
  private stickyBytes = 0
  private interactionBytes = 0
  private nextSeq = 0
  private readonly cap: number
  private readonly byteCap: number

  constructor(
    cap: number = GUI_RING_CAP,
    byteCap: number = GUI_RING_BYTE_CAP,
    initialCursor = 0
  ) {
    this.cap = cap > 0 ? cap : GUI_RING_CAP
    this.byteCap = byteCap > 0 ? byteCap : GUI_RING_BYTE_CAP
    this.nextSeq = Number.isSafeInteger(initialCursor) && initialCursor > 0 ? initialCursor : 0
  }

  push(evt: unknown): number {
    const seq = ++this.nextSeq
    const size = guiEventSize(evt)

    // O backend pode mandar milhares de deltas para UMA fala. Ao vivo cada
    // chunk continua saindo com seu seq pelo IPC, mas no replay eles formam um
    // único delta acumulado. Sem esta compactação, uma resposta longa expulsava
    // turnos inteiros do histórico de 500 eventos antes mesmo de terminar.
    const event = guiEventRecord(evt)
    const previous = this.items.at(-1)
    const previousEvent = previous ? guiEventRecord(previous.evt) : null
    if (
      event?.['type'] === 'delta' &&
      typeof event['text'] === 'string' &&
      previous?.seq === seq - 1 &&
      previousEvent?.['type'] === 'delta' &&
      typeof previousEvent['text'] === 'string'
    ) {
      const merged = { type: 'delta', text: previousEvent['text'] + event['text'] }
      const mergedSize = guiEventSize(merged)
      this.bytes += mergedSize - previous.size
      previous.seq = seq
      previous.evt = merged
      previous.size = mergedSize
      this.trim()
      return seq
    }

    const stickyKey = guiStickyEvent(evt)
    if (stickyKey) {
      const previous = this.sticky.get(stickyKey)
      if (previous) this.stickyBytes -= previous.size
      this.sticky.set(stickyKey, { seq, evt, size })
      this.stickyBytes += size
      this.trim()
      return seq
    }

    const pending = guiPendingInteraction(evt)
    if (pending) {
      const previous = this.interactions.get(pending.requestId)
      if (previous) this.interactionBytes -= previous.size
      this.interactions.set(pending.requestId, { seq, evt, size })
      this.interactionBytes += size
      this.trim()
      return seq
    }

    const resolvedRequestId = guiResolvedInteractionId(evt)
    if (resolvedRequestId) {
      const previous = this.interactions.get(resolvedRequestId)
      if (previous) {
        this.interactions.delete(resolvedRequestId)
        this.interactionBytes -= previous.size
      }
    } else if (guiTerminalEvent(evt)) {
      // Pedido que BLOQUEIA o CLI morre com o turno (o backend já desistiu
      // dele). A proposta de plano não bloqueia nada e continua esperando o
      // clique do dono — limpá-la aqui apagaria o card assim que o agente
      // terminasse de falar.
      for (const [requestId, item] of this.interactions) {
        const pendingType = guiPendingInteraction(item.evt)?.type
        if (pendingType && guiSurvivesTurnEnd(pendingType)) continue
        this.interactions.delete(requestId)
        this.interactionBytes -= item.size
      }
    }

    this.items.push({ seq, evt, size })
    this.bytes += size
    this.trim()
    return seq
  }

  private trim(): void {
    while (
      this.items.length > 1 &&
      (this.items.length + this.sticky.size + this.interactions.size > this.cap ||
        this.bytes + this.stickyBytes + this.interactionBytes > this.byteCap)
    ) {
      const removed = this.items.shift()
      if (removed) this.bytes -= removed.size
    }
  }

  get size(): number {
    return this.items.length + this.sticky.size + this.interactions.size
  }

  snapshot(): unknown[] {
    // Metadados sao retidos fora da janela, mas continuam na posicao da sua
    // geracao. Isto e decisivo no retry: fatal antigo -> init/ready novos deve
    // reanimar o replay, nunca ser invertido para init novo -> fatal antigo.
    const history = [...this.sticky.values(), ...this.items].sort((a, b) => a.seq - b.seq)
    return [
      ...history.map((item) => item.evt),
      // Pendências remanescentes são necessariamente posteriores ao último
      // terminal/resolution observado. Reproduzi-las por último impede que um
      // `result` histÃ³rico apague o card atual durante a remontagem.
      ...Array.from(this.interactions.values(), (item) => item.evt)
    ]
  }

  sequencedSnapshot(): GuiSequencedEvent[] {
    const history = [...this.sticky.values(), ...this.items].sort((a, b) => a.seq - b.seq)
    return [
      ...history.map((item) => ({ seq: item.seq, evt: item.evt })),
      ...Array.from(this.interactions.values(), (item) => ({ seq: item.seq, evt: item.evt }))
    ]
  }

  /**
   * Pendência AINDA aberta por requestId. É o que torna a aprovação
   * autoritativa: o rascunho que vira `Plan` sai daqui, do anel do pane que o
   * agente escreveu — nunca de um payload que o renderer devolveu.
   */
  pending(requestId: string): unknown {
    return this.interactions.get(requestId)?.evt
  }

  /** requestIds ainda abertos de um tipo — usado para superar uma pendência
   *  que sobrevive ao turno antes de abrir outra do mesmo tipo. */
  pendingIdsOfType(type: GuiPendingInteractionEvent): string[] {
    const ids: string[] = []
    for (const [requestId, item] of this.interactions) {
      if (guiPendingInteraction(item.evt)?.type === type) ids.push(requestId)
    }
    return ids
  }

  get cursor(): number {
    return this.nextSeq
  }

  clear(preserveCursor = false): void {
    this.items = []
    this.sticky.clear()
    this.interactions.clear()
    this.bytes = 0
    this.stickyBytes = 0
    this.interactionBytes = 0
    if (!preserveCursor) this.nextSeq = 0
  }
}

/** Última medição canônica disponível no fio salvo. O anel já retém init e
 * context-usage como sticky; resultados entram apenas quando carregam números
 * reais. Eventos de outra geração são descartados pela barreira de restart. */
function guiContextSnapshotFromRing(ring: GuiEventRing): GuiContextUsageSnapshot | undefined {
  let current: GuiContextUsageSnapshot | undefined
  for (const raw of ring.snapshot()) {
    const event = raw as SessionEvent
    if (event.type === 'session-restarted' && event.contextTokens === undefined && event.contextWindow === undefined) {
      current = undefined
      continue
    }
    const next = guiContextSnapshotFromEvent(event, current)
    if (next !== undefined) current = next
  }
  return current
}

// ————— documento de resume (userData/gui-sessions.json) —————

export interface GuiSessionRecord {
  /** Ausente enquanto o CLI não anunciou a conversa (o modo já é gravado no
   *  create; o id chega no `init`/`session-id`). */
  sessionId?: string
  cli: 'claude' | 'codex'
  projectId: string
  updatedAt: string
  /** Último modo ESCOLHIDO para este pane (onda D): reabrir mantém a escolha. */
  permissionMode?: GuiPermissionMode
  /** Último modelo/effort ESCOLHIDOS para este pane (2.0, seletores do
   *  composer): mesma régua do permissionMode — reabrir a conversa cai na
   *  última escolha do dono, nunca de volta na da criação da missão. */
  /** `null` é uma escolha explícita: usar o padrão do CLI/modelo. Ausente
   *  significa que esta conversa ainda não escolheu e pode herdar a missão. */
  model?: string | null
  effort?: string | null
  /**
   * PADRÃO DOS AJUDANTES deste chat (D8 — "abinha do lado", ordem do dono de
   * 18/08: "como padrão vai vir eles; caso eu queira outros, aí eu falo").
   *
   * AUSENTE = herdar da conversa; não existe `null` aqui de propósito. Modelo/
   * effort do composer precisam do terceiro estado ("padrão do CLI" é uma
   * escolha diferente de "não escolhi"), mas o pino do dono só tem dois: ou ele
   * carimbou um valor, ou os ajudantes clonam o chat. Limpar REMOVE o campo.
   */
  delegateModel?: string
  delegateEffort?: string
  /**
   * R12 — o ⚡ do painel (a queixa 2 do dono REVOGA o "fast só explícito na
   * tool" da R11). Aqui o ausente não é "herdar": fast NUNCA se herda da
   * conversa, então sem carimbo ele é DESLIGADO. Só `true` é gravado — limpar
   * remove o campo, como nos irmãos.
   */
  delegateFast?: boolean
  /** Última fotografia canônica de contexto desta identidade de sessão. */
  contextTokens?: number | null
  contextWindow?: number | null
  contextSessionId?: string
  /** Recibos duráveis das entregas da fila. O TTL é maior que a validade do
   * envelope, então um ACK perdido nunca volta a executar após replay/evicção. */
  queuedDeliveryReceipts?: Array<{ id: string; deliveredAt: string }>
}

export interface GuiContextUsageSnapshot {
  contextTokens: number | null
  contextWindow: number | null
}

function guiContextSnapshotFromRecord(
  record: GuiSessionRecord | undefined
): GuiContextUsageSnapshot | undefined {
  if (
    !record ||
    (!Object.prototype.hasOwnProperty.call(record, 'contextTokens') &&
      !Object.prototype.hasOwnProperty.call(record, 'contextWindow'))
  )
    return undefined
  if (record.contextSessionId && record.contextSessionId !== record.sessionId) return undefined
  if (!guiNullableContextTokens(record.contextTokens ?? null)) return undefined
  if (!guiNullableContextWindow(record.contextWindow ?? null)) return undefined
  return {
    contextTokens: record.contextTokens ?? null,
    contextWindow: record.contextWindow ?? null
  }
}

function guiContextSnapshotFromEvent(
  event: SessionEvent,
  current: GuiContextUsageSnapshot | undefined
): GuiContextUsageSnapshot | undefined {
  switch (event.type) {
    case 'init':
      return event.contextWindow === undefined || !guiNullableContextWindow(event.contextWindow)
        ? undefined
        : {
            contextTokens: current?.contextTokens ?? null,
            contextWindow: event.contextWindow
          }
    case 'context-usage':
      return {
        contextTokens: event.contextTokens,
        contextWindow: event.contextWindow
      }
    case 'result': {
      if (event.contextTokens === undefined && event.contextWindow === undefined) return undefined
      if (!guiOptionalContextTokens(event.contextTokens) || !guiOptionalContextWindow(event.contextWindow))
        return undefined
      return {
        contextTokens: event.contextTokens ?? current?.contextTokens ?? null,
        contextWindow: event.contextWindow ?? current?.contextWindow ?? null
      }
    }
    case 'session-restarted':
      if (event.contextTokens === undefined && event.contextWindow === undefined) return undefined
      if (!guiOptionalContextTokens(event.contextTokens) || !guiOptionalContextWindow(event.contextWindow))
        return undefined
      return {
        contextTokens: event.contextTokens ?? null,
        contextWindow: event.contextWindow ?? null
      }
    case 'conversation-cleared':
      return { contextTokens: null, contextWindow: null }
    default:
      return undefined
  }
}

function validQueuedDeliveryReceipts(
  record: GuiSessionRecord | undefined,
  now = Date.now()
): Array<{ id: string; deliveredAt: string }> {
  if (!Array.isArray(record?.queuedDeliveryReceipts)) return []
  const seen = new Set<string>()
  const receipts: Array<{ id: string; deliveredAt: string }> = []
  for (const receipt of record.queuedDeliveryReceipts) {
    if (!receipt || guiMessageIdProblem(receipt.id) !== null || typeof receipt.deliveredAt !== 'string') {
      continue
    }
    const deliveredAt = Date.parse(receipt.deliveredAt)
    if (!Number.isFinite(deliveredAt) || deliveredAt < now - GUI_QUEUED_RECEIPT_TTL_MS) continue
    if (seen.has(receipt.id)) continue
    seen.add(receipt.id)
    receipts.push({ id: receipt.id, deliveredAt: receipt.deliveredAt })
  }
  return receipts.slice(-GUI_QUEUED_RECEIPT_CAP)
}

/** Resolve a escolha persistida sem confundir `null` (padrão explícito) com
 * campo ausente (a conversa ainda pode herdar a configuração da missão). */
export function rememberedGuiExecutorValue(
  record: GuiSessionRecord | undefined,
  cli: 'claude' | 'codex',
  field: 'model' | 'effort',
  fallback: string | undefined
): string | undefined {
  if (!record || record.cli !== cli || !Object.prototype.hasOwnProperty.call(record, field)) {
    return fallback
  }
  const value = record[field]
  if (value === null) return undefined
  return typeof value === 'string' && value.trim() ? value : fallback
}

// ————— PADRÃO DOS AJUDANTES (D8) — o pino do dono, por pane —————

/** O que o painel carimbou. Campo ausente = herdar da conversa — menos o
 *  `fast`, que não tem herança: ausente ali é DESLIGADO. */
export interface GuiDelegationDefaults {
  model?: string
  effort?: string
  /** R12 — o dono carimbou ⚡ para a frota inteira. Só `true` existe. */
  fast?: boolean
}

/** `null` LIMPA o campo; campo ausente CONSERVA o que já está gravado (mesma
 *  gramática do `GuiExecutorPatch`, para o renderer não precisar de duas).
 *  No `fast`, `false` limpa junto com `null`: desligar é a mesma ordem. */
export interface GuiDelegationDefaultsPatch {
  model?: string | null
  effort?: string | null
  fast?: boolean | null
}

export type GuiDelegationDefaultsResult =
  | ({ ok: true } & GuiDelegationDefaults)
  | { ok: false; error: string }

/** Mesmo teto do modelo/effort do envelope da fila: nome de modelo é rótulo,
 *  não payload. */
export const GUI_DELEGATION_DEFAULT_MAX_CHARS = 128

/**
 * O painel só valida a FORMA. Recusar um id que o catálogo do momento não
 * conhece seria pior que aceitá-lo: o catálogo é assíncrono e por conta, e o
 * dono pode carimbar um modelo do outro CLI de propósito (cross-CLI é cidadão
 * de primeira classe). Quem sabe dizer "esse modelo não existe" é o motor, na
 * hora de abrir o ajudante — e ele diz com o recibo na mão.
 */
export function guiDelegationDefaultProblem(label: string, value: unknown): string | null {
  if (typeof value !== 'string') return `${label} do painel em formato inválido`
  const trimmed = value.trim()
  if (!trimmed) return `${label} do painel veio vazio — use "limpar" para voltar a herdar`
  if (trimmed.length > GUI_DELEGATION_DEFAULT_MAX_CHARS) return `${label} do painel é longo demais`
  return null
}

/**
 * Lê o pino do documento. Valor sujo (versão futura, arquivo editado à mão) é
 * DESCARTADO em vez de virar padrão silencioso — um modelo inventado abriria a
 * frota inteira errada.
 */
export function guiDelegationDefaultsOf(
  record: GuiSessionRecord | undefined
): GuiDelegationDefaults {
  const clean = (value: unknown): string | undefined =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= GUI_DELEGATION_DEFAULT_MAX_CHARS
      ? value.trim()
      : undefined
  const model = clean(record?.delegateModel)
  const effort = clean(record?.delegateEffort)
  // `true` LITERAL, nada de coerção: um `"sim"` ou `1` de documento sujo ligaria
  // a frota inteira num modo que gasta mais limite sem o dono ter pedido.
  const fast = record?.delegateFast === true
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fast ? { fast: true } : {})
  }
}

/**
 * Um transplante de conversa que falhou invalida somente o endereço de
 * resume. As escolhas do pane continuam úteis quando ele recomeçar.
 */
export function guiSessionWithoutResume(record: GuiSessionRecord): GuiSessionRecord {
  const next = { ...record }
  delete next.sessionId
  delete next.contextTokens
  delete next.contextWindow
  delete next.contextSessionId
  return next
}

/**
 * A conta anterior sumiu ou o CLI mudou: além do endereço da conversa, modelo
 * e effort deixam de ter procedência confiável. A permissão continua sendo uma
 * escolha portátil do dono e pode sobreviver.
 *
 * O PINO DOS AJUDANTES (D8) também sobrevive, e por um motivo forte: ele nunca
 * dependeu do CLI deste pane. O dono pode ter carimbado `gpt-*` num chat claude
 * de propósito — apagá-lo aqui trocaria a escolha dele por uma dedução nossa.
 */
export function guiSessionWithoutIdentity(record: GuiSessionRecord): GuiSessionRecord {
  const next = guiSessionWithoutResume(record)
  delete next.model
  delete next.effort
  return next
}

export interface GuiPersistedTranscript {
  events: unknown[]
  cursor: number
  updatedAt: string
}

interface GuiSessionsDoc {
  panes: Record<string, GuiSessionRecord>
  /** Fotografia limitada do fio visível. Separada do record de resume para
   *  trocar/invalidar a identidade do CLI nunca apagar a conversa da tela. */
  transcripts?: Record<string, GuiPersistedTranscript>
}

function emptyDoc(): GuiSessionsDoc {
  return { panes: {}, transcripts: {} }
}

function isDoc(value: unknown): value is GuiSessionsDoc {
  if (!value || typeof value !== 'object') return false
  const doc = value as GuiSessionsDoc
  const panes = doc.panes
  const transcripts = doc.transcripts
  return (
    Boolean(panes) &&
    typeof panes === 'object' &&
    !Array.isArray(panes) &&
    (transcripts === undefined ||
      (Boolean(transcripts) && typeof transcripts === 'object' && !Array.isArray(transcripts)))
  )
}

function sanitizeGuiTranscripts(value: unknown): {
  transcripts: Record<string, GuiPersistedTranscript>
  changed: boolean
} {
  const source = guiPlainRecord(value)
  if (!source) return { transcripts: {}, changed: value !== undefined }
  const transcripts: Record<string, GuiPersistedTranscript> = {}
  let changed = false
  for (const [paneId, raw] of Object.entries(source)) {
    const record = guiPlainRecord(raw)
    if (
      !paneId ||
      paneId.length > 512 ||
      !record ||
      !Array.isArray(record['events']) ||
      record['events'].length === 0 ||
      !Number.isSafeInteger(record['cursor']) ||
      (record['cursor'] as number) <= 0 ||
      typeof record['updatedAt'] !== 'string' ||
      !Number.isFinite(Date.parse(record['updatedAt']))
    ) {
      changed = true
      continue
    }
    const events = record['events'].slice(-GUI_TRANSCRIPT_HYDRATE_EVENT_CAP)
    if ((record['cursor'] as number) < events.length) {
      changed = true
      continue
    }
    if (events.length !== record['events'].length) changed = true
    transcripts[paneId] = {
      events,
      cursor: record['cursor'] as number,
      updatedAt: record['updatedAt']
    }
  }
  return { transcripts, changed }
}

function guiPersistedTranscriptSize(paneId: string, transcript: GuiPersistedTranscript): number {
  // Inclui a chave e a moldura do record. A soma fica ligeiramente
  // conservadora em relação ao JSON final, nunca otimista.
  return Math.max(1, guiEventSize({ [paneId]: transcript }))
}

/**
 * Orçamento GLOBAL do documento. O anel limita um pane; esta segunda cerca
 * impede que panes antigos multipliquem esse teto sem fim. A fotografia que
 * acabou de ser salva pode ser protegida enquanto as mais antigas saem.
 */
export function pruneGuiTranscripts(
  transcripts: Record<string, GuiPersistedTranscript>,
  keepPaneId?: string,
  byteCap = GUI_TRANSCRIPT_STORE_BYTE_CAP,
  paneCap = GUI_TRANSCRIPT_STORE_PANE_CAP
): string[] {
  const safeByteCap =
    Number.isSafeInteger(byteCap) && byteCap > 0 ? byteCap : GUI_TRANSCRIPT_STORE_BYTE_CAP
  const safePaneCap =
    Number.isSafeInteger(paneCap) && paneCap > 0 ? paneCap : GUI_TRANSCRIPT_STORE_PANE_CAP
  const entries = Object.entries(transcripts)
    .map(([paneId, transcript]) => ({
      paneId,
      transcript,
      bytes: guiPersistedTranscriptSize(paneId, transcript),
      updatedAt: Date.parse(transcript.updatedAt) || 0
    }))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.paneId.localeCompare(b.paneId))
  let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0)
  let totalPanes = entries.length
  const removed: string[] = []
  for (const entry of entries) {
    if (totalPanes <= safePaneCap && totalBytes <= safeByteCap) break
    if (entry.paneId === keepPaneId) continue
    delete transcripts[entry.paneId]
    totalPanes -= 1
    totalBytes -= entry.bytes
    removed.push(entry.paneId)
  }
  // `keepPaneId` define a ordem de descarte, não uma exceção ao orçamento.
  // Um record isolado e ilegítimo nunca pode furar o teto duro do documento.
  if ((totalPanes > safePaneCap || totalBytes > safeByteCap) && keepPaneId) {
    const kept = entries.find((entry) => entry.paneId === keepPaneId)
    if (kept && transcripts[keepPaneId]) {
      delete transcripts[keepPaneId]
      removed.push(keepPaneId)
    }
  }
  return removed
}

// ————— registro —————

type GuiBackend = MaestroSession | CodexSession

interface GuiPaneEntry {
  spawn: GuiPaneSpawn
  /** Identidade do SPAWN: mudou = processo novo; igual = remontagem reusa. */
  fingerprint: string
  session: GuiBackend
  ring: GuiEventRing
  /** Desfecho canônico aguardando o renderer apresentar o seq terminal. */
  alerts: GuiAlertSequencer
  /** Guarda de geração: o `dispose` apaga a chama e o sink da sessão MORTA
   *  cala na hora — evento atrasado nunca fala pelo pane que a substituiu. */
  token: { alive: boolean }
  /** O MESMO sink do create (anel + push): é por ele que os eventos SINTÉTICOS
   *  do roteamento de slash saem — nunca por fora, senão a remontagem perderia
   *  o replay do que o comando respondeu. */
  sink: (evt: SessionEvent) => void
  /** Terminal do backend pode preceder tool-result no mesmo chunk de stdout;
   * o teardown precisa drenar esse terminal antes de salvar o replay. */
  flushPendingTerminal?: () => void
  /** BRIEFING DA MISSÃO AINDA NÃO ENTREGUE. O pane nasce mudo (ordem do dono):
   *  o dono ajusta conta/modelo/effort/permissão e só a PRIMEIRA mensagem dele
   *  abre turno — o briefing sai colado nela, nunca sozinho. Mora na ENTRADA,
   *  não no spawn: `inheritConversation` e a entrega da fila zeram
   *  `firstPrompt` de propósito, e um briefing guardado ali morreria no
   *  primeiro respawn (trocar a permissão antes de escrever é o caminho comum). */
  pendingBriefing?: string
  /** Idempotência do boundary IPC: dois renderers nunca enviam o mesmo bilhete duas vezes. */
  messageIds?: Set<string>
}

interface GuiQueuedDeliveryLock {
  id: string
  token: symbol
  promise: Promise<GuiResult>
}

function deliveredGuiMessageIds(ring: GuiEventRing): Set<string> {
  const ids = new Set<string>()
  for (const event of ring.snapshot()) {
    const record = guiPlainRecord(event)
    const id = record?.['id']
    if (record?.['type'] === 'user-message' && guiMessageIdProblem(id) === null) {
      ids.add(id as string)
    }
  }
  return ids
}

function rememberedGuiMessageIds(
  ring: GuiEventRing,
  record: GuiSessionRecord | undefined
): Set<string> {
  const ids = deliveredGuiMessageIds(ring)
  for (const receipt of validQueuedDeliveryReceipts(record)) ids.add(receipt.id)
  return ids
}

export interface GuiSessionDeps {
  /** Empurra o evento vivo ao renderer (ctx.pushAll no canal `gui:live`). */
  push(payload: GuiLivePayload): void
  /** Materializa a persona do claude em arquivo; undefined = falhou. */
  systemPromptFile(name: string, content: string): string | undefined
  /** userData/gui-sessions.json — ausente desliga a persistência (testes). */
  storeFile?: string
  /** Autoridade opaca compartilhada com os handlers de attach/preview. */
  attachmentCapabilities?: GuiAttachmentCapabilityStore
  /** Caixa-preta opcional. */
  record?(
    event: string,
    ids: { paneId: string; projectId?: string },
    detail?: Record<string, unknown>
  ): void
  /** 2.0 onda D: a conversa parou pedindo permissão. A NOTIFICAÇÃO de desktop
   *  é costurada no ipc/gui — este módulo nunca importa electron (é o que
   *  mantém a suíte test:gui-sessions rodando em node puro).
   *  `kind` (aditivo): 'question' = AskUserQuestion parou a conversa — mesma
   *  notificação, texto próprio; ausente/'permission' = pedido de sempre. */
  onPermissionPending?(input: {
    paneId: string
    projectId: string
    toolName: string
    kind?: 'permission' | 'question'
  }): void
  /** Evento canônico, somente ao vivo; replay nunca toca avisos ou sons. */
  onChatAlert?(input: {
    paneId: string
    projectId: string
    kind: GuiNoticeKind
  }): void
  /** Teardown canônico do pane, inclusive kill em lote e respawn. */
  onPaneDisposed?(input: {
    paneId: string
    projectId: string
    reason: string
  }): void
  /**
   * RE-ARMA AS FERRAMENTAS DO PANE, UMA VEZ POR SPAWN, DEPOIS DO TEARDOWN.
   *
   * O teardown é o dono da revogação: `onPaneDisposed` apaga o arquivo de
   * config MCP e revoga o token. Só que um RESPAWN passa pelo mesmo teardown —
   * trocar o modo de permissão, `/clear` e a entrega da fila com modo novo
   * disposam e recriam no mesmo instante. Sem este gancho, o processo novo
   * nascia apontando para o arquivo que o teardown ACABARA de apagar e o
   * claude morria no boot com `Invalid MCP configuration: MCP config file not
   * found` (visto ao vivo em 2026-08-17, duas vezes).
   *
   * Por isso a re-materialização mora AQUI, no seam do spawn, e não no
   * chamador: as três rotas de respawn passam por `create`, e nenhuma delas
   * sabe que revogou nada. É a mesma lição que o `pty:create` já tinha
   * aprendido para os panes TUI (a corrida armPane × cleanPaneMcpFile).
   *
   * Contrato: idempotente e derivado do PANE, nunca do que o renderer mandou —
   * o main é a autoridade sobre quem tem ferramenta. `undefined` = este pane
   * não pode tê-las agora (servidor fora do ar, pane que não é o planejador):
   * o spawn sai SEM elas, que é honesto, em vez de apontar para um arquivo que
   * não existe. Ausência do gancho = ninguém opina e o spawn vai como veio.
   */
  rearmPaneTools?(spawn: GuiPaneSpawn): GuiPaneSpawn['mcp'] | undefined
  /**
   * Relógio do DESPERTADOR dos ajudantes (a janela de coalescência do
   * `guiHelperCards`). Só existe para o teste não esperar 3s de verdade;
   * ausente, o correlacionador usa `setTimeout` com `unref`.
   */
  helperWakeTimer?(ms: number, fn: () => void): () => void
  /**
   * O CORREIO dos ajudantes — o pote que o despertador e as tools do MCP
   * dividem. Ausente = o de produção (`guiHelperInbox`), que é exatamente o que
   * o app usa dos dois lados; a injeção existe para a suíte não dividir um pote
   * global entre dois registros do mesmo paneId.
   */
  helperInbox?: GuiHelperInbox
  /**
   * O POTE DO DONO (R22) — o outro pote, com a outra carga: a fala do dono que
   * chegou com o turno ABERTO e vai de carona no próximo resultado de tool.
   * Ausente = o de produção (`guiOwnerMailbox`), o MESMO que as tools de
   * delegação drenam.
   */
  ownerMail?: GuiOwnerMailbox
  /**
   * ESTE PANE DELEGA? (R22.1 — a autoridade da ROTA.)
   *
   * Quem sabe a resposta é o main (o registro de identidade do servidor MCP diz
   * o papel de cada pane), nunca este módulo — ele não conhece hub, token nem
   * electron, e é isso que mantém a suíte em node puro. AUSENTE = nenhum pane
   * delega, e todo envio segue o caminho de sempre: é assim que as suítes rodam
   * e é assim que o pane NÃO-delegador continua se comportando, palavra por
   * palavra, depois desta rodada.
   */
  delegatorPane?(paneId: string): boolean
}

/**
 * O QUE O REGISTRO PRECISA DO MOTOR DE AJUDANTES (R6-B). Só duas coisas, e as
 * duas de mão única: PARAR a frota deste chat preservando, e OLHAR quem ficou
 * parado. O `GuiHelperEngine` satisfaz isto por estrutura — o registro não
 * conhece o motor, e a suíte injeta um duplo de três linhas.
 */
export interface GuiSessionHelperControls {
  /** Parada PRESERVADORA da frota do pane (nunca descarte). Devolve quantos. */
  interruptPane(paneId: string, reason?: string): number
  /** Fotografia dos ajudantes do pane — é dela que sai a lista de parados. */
  status(paneId: string): GuiHelperSnapshot[]
  /**
   * O DESPERTAR POR PANE (R22.3): chegou fala do dono no pote, então as esperas
   * de long-poll da frota deste pane resolvem AGORA — a carona sai em segundos
   * em vez de esperar os até 240s do `helper_result`. Não muda estado nenhum.
   *
   * Opcional porque este registro nunca dependeu do motor para funcionar
   * (`attachHelpers` pode nem ter acontecido): ausente = a carona ainda sai, só
   * que no próximo resultado de tool que o agente pedir.
   */
  wakePane?(paneId: string): number
}

/**
 * O QUE O REGISTRO PRECISA DO MOTOR DE MISSÕES (rodada 9). Uma coisa só, e de
 * mão única: avisar que a conversa de um pane ABRIU, para o motor re-derivar do
 * TICKET um ⇪ que ficou esperando. Nada é persistido aqui — o ticket na fila já
 * é o registro durável, e este aviso é só o momento de re-executá-lo.
 */
export interface GuiSessionIntegrationControls {
  paneOpened(paneId: string, projectId: string): void
}

/** O motivo que o dono vê no card e na ficha quando ele mesmo aperta o ■. */
export const GUI_HELPER_OWNER_INTERRUPTION =
  'o dono interrompeu esta conversa — o trabalho dele ficou guardado e dá para retomar'

/** Espera do handshake antes de soltar o firstPrompt (waitCaps resolve antes
 *  disso no caminho feliz; o teto só existe para o CLI que não responde). */
// Codex: initialize (até 20 s) + loadCaps (até 20 s) são sequenciais.
const READY_TIMEOUT_MS = 45_000

export class GuiSessionRegistry {
  private readonly deps: GuiSessionDeps
  private readonly panes = new Map<string, GuiPaneEntry>()
  /** Cursor salvo por INSTÂNCIA do anel. O cursor persistido não serve para
   *  dedupe depois do boot porque a hidratação renumera a janela limitada. */
  private readonly savedTranscriptCursors = new WeakMap<GuiEventRing, number>()
  private doc: GuiSessionsDoc
  private nextMessageId = 0
  /** Serializa a troca por pane. O renderer fecha o menu, mas o main continua
   *  sendo a barreira contra dois IPCs concorrentes ou um envio no intervalo. */
  private readonly executorChanges = new Set<GuiPaneEntry>()
  /** A entrega enfileirada reaplica opcoes e envia sob uma unica trava. */
  private readonly queuedDeliveries = new Map<string, GuiQueuedDeliveryLock>()
  private readonly attachmentCapabilities: GuiAttachmentCapabilityStore
  /** AJUDANTES SEM ABA (2026-08-18): a costura entre a chamada `delegate` que o
   *  CLI publica no anel e a frota que o motor abriu — e o emissor dos cards
   *  sintetizados. Publica SEMPRE pelo sink da sessão viva: card que nascesse
   *  por fora não entraria no replay da remontagem. */
  private readonly helperCards: GuiHelperCardCorrelator
  /** O POTE DO DONO (R22): a fala que chegou com o turno aberto num pane
   *  delegador espera aqui pela carona no próximo resultado de tool — e, se o
   *  turno fechar com ele cheio, o fecho a entrega pelo caminho de sempre. */
  private readonly ownerMail: GuiOwnerMailbox
  /** O motor dos ajudantes, amarrado depois do nascimento (ver `attachHelpers`).
   *  Ausente = registro sem frota: o ■ para só o turno. */
  private helpers?: GuiSessionHelperControls
  /** O motor de missões (ver `attachIntegration`). Ausente = registro sem fila:
   *  abrir uma conversa não re-estimula ⇪ nenhum. */
  private integration?: GuiSessionIntegrationControls

  constructor(deps: GuiSessionDeps) {
    this.deps = deps
    this.attachmentCapabilities = deps.attachmentCapabilities ?? new GuiAttachmentCapabilityStore()
    this.ownerMail = deps.ownerMail ?? guiOwnerMailbox
    this.helperCards = new GuiHelperCardCorrelator({
      emit: (paneId, evt) => this.panes.get(paneId)?.sink(evt),
      // SESSÃO MORTA NÃO TEM TURNO. Sem o `alive`, um processo que caiu com
      // `turnActive` cravado em `true` prenderia para sempre o despertador (e o
      // `turn-continuation` do fim de frota) num pane que nunca mais responde.
      turnActive: (paneId) => {
        const entry = this.panes.get(paneId)
        return entry?.session.alive === true && entry.session.turnActive === true
      },
      wake: (paneId, wake) => this.wakeDelegator(paneId, wake),
      ...(deps.helperInbox ? { inbox: deps.helperInbox } : {}),
      ...(deps.helperWakeTimer ? { setTimer: deps.helperWakeTimer } : {})
    })
    const loaded = deps.storeFile
      ? loadJsonStore<GuiSessionsDoc>(deps.storeFile, emptyDoc, isDoc)
      : emptyDoc()
    const sanitized = sanitizeGuiTranscripts(loaded.transcripts)
    loaded.transcripts = sanitized.transcripts
    const pruned = pruneGuiTranscripts(loaded.transcripts)
    this.doc = loaded
    if (deps.storeFile && (sanitized.changed || pruned.length > 0)) {
      try {
        persistJsonStore(deps.storeFile, this.doc)
      } catch {
        // A cópia em memória já está cercada; uma próxima gravação tenta
        // substituir o documento antigo sem impedir a abertura do app.
      }
    }
  }

  /** Sessão do pane (undefined = nunca criada ou já encerrada). */
  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  /** Conversa gravada para este pane — a chave do resume pós-boot. */
  remembered(paneId: string): GuiSessionRecord | undefined {
    return this.doc.panes[paneId]
  }

  /**
   * O PINO DOS AJUDANTES deste pane (D8). Vazio = herdar da conversa, que é o
   * comportamento de sempre — o painel só existe para o dono dizer outra coisa.
   */
  delegationDefaults(paneId: string): GuiDelegationDefaults {
    return guiDelegationDefaultsOf(this.doc.panes[paneId])
  }

  /**
   * Carimba (ou limpa) o pino. Devolve a fotografia CANÔNICA, que é o que o
   * painel passa a mostrar — o renderer nunca fica com uma escolha otimista que
   * o disco não aceitou.
   */
  setDelegationDefaults(
    paneId: string,
    patch: GuiDelegationDefaultsPatch
  ): GuiDelegationDefaultsResult {
    const previous = this.doc.panes[paneId]
    const entry = this.panes.get(paneId)
    // O pane pode ter registro no disco (conversa gravada), sessão viva, ou os
    // dois. Nenhum dos dois = endereço que este app não conhece.
    const base: GuiSessionRecord | undefined =
      previous ??
      (entry
        ? {
            cli: entry.spawn.cli,
            projectId: entry.spawn.projectId,
            updatedAt: new Date().toISOString()
          }
        : undefined)
    if (!base) return { ok: false, error: 'este pane não tem conversa aberta' }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'escolha do painel em formato inválido' }
    }
    // Tudo é decidido ANTES de tocar no documento: uma recusa nunca pode gravar
    // metade da escolha e deixar o painel contando outra história que o disco.
    const writes: { field: 'delegateModel' | 'delegateEffort'; value: string | null }[] = []
    for (const key of ['model', 'effort'] as const) {
      const value = patch[key]
      // Ausente CONSERVA (o painel manda um campo por clique); `null` LIMPA.
      if (value === undefined) continue
      const field = key === 'model' ? 'delegateModel' : 'delegateEffort'
      if (value === null) {
        writes.push({ field, value: null })
        continue
      }
      const problem = guiDelegationDefaultProblem(key === 'model' ? 'modelo' : 'effort', value)
      if (problem) return { ok: false, error: problem }
      writes.push({ field, value: value.trim() })
    }
    // O fast anda FORA da lista dos irmãos: ele não é rótulo (não tem trim nem
    // teto de tamanho) e desligar é `false` tanto quanto `null`.
    let fastWrite: boolean | undefined
    if (patch.fast !== undefined) {
      if (patch.fast !== null && typeof patch.fast !== 'boolean') {
        return { ok: false, error: 'fast do painel em formato inválido' }
      }
      fastWrite = patch.fast === true
    }
    if (writes.length === 0 && fastWrite === undefined) {
      return { ok: false, error: 'diga o modelo, o effort ou o fast padrão dos ajudantes' }
    }
    const next: GuiSessionRecord = { ...base }
    for (const write of writes) {
      if (write.value === null) delete next[write.field]
      else next[write.field] = write.value
    }
    if (fastWrite === true) next.delegateFast = true
    else if (fastWrite === false) delete next.delegateFast
    next.updatedAt = new Date().toISOString()
    this.doc.panes[paneId] = next
    if (this.deps.storeFile) {
      try {
        persistJsonStore(this.deps.storeFile, this.doc)
      } catch {
        // O pino já vale em memória para a próxima delegação; o disco tenta de
        // novo no próximo checkpoint em vez de derrubar a escolha do dono.
      }
    }
    const applied = guiDelegationDefaultsOf(next)
    // O diário responde à pergunta que o dono faria depois ("por que a frota
    // abriu em fable?") sem depender de ele lembrar quando mexeu na abinha.
    this.deps.record?.(
      'gui-delegation-defaults',
      { paneId, projectId: next.projectId },
      {
        model: applied.model ?? 'herdado',
        effort: applied.effort ?? 'herdado',
        // O fast é a única escolha daqui que GASTA MAIS: o diário responde
        // "desde quando a frota abre em ⚡?" sem depender de memória.
        fast: applied.fast ? 'ligado' : 'desligado'
      }
    )
    return { ok: true, ...applied }
  }

  /** Transplante de seat falhou: conserva preferências genéricas, mas o id
   *  não pode ser retomado num config dir onde o arquivo da conversa não existe. */
  forgetSession(paneId: string): void {
    const previous = this.doc.panes[paneId]
    if (!previous?.sessionId) return
    this.doc.panes[paneId] = guiSessionWithoutResume(previous)
    if (!this.deps.storeFile) return
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // Resume é conveniência; falha de disco não derruba a troca de conta.
    }
  }

  /** Invalida resume + executor quando não dá para provar a identidade do seat. */
  forgetSessionIdentity(paneId: string): void {
    const previous = this.doc.panes[paneId]
    if (!previous) return
    const next = guiSessionWithoutIdentity(previous)
    if (
      previous.sessionId === undefined &&
      previous.model === undefined &&
      previous.effort === undefined
    )
      return
    this.doc.panes[paneId] = next
    if (!this.deps.storeFile) return
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // Resume é conveniência; falha de disco não derruba a troca de conta.
    }
  }

  /**
   * Pasta de trabalho do pane VIVO (worktree da missão, ou raiz do projeto no
   * planejamento). É por aqui que o `gui:attach` descobre onde gravar o anexo:
   * o destino nasce do registro, NUNCA de um caminho vindo do renderer.
   * undefined = pane desconhecido — o chamador recusa em vez de adivinhar.
   */
  cwdOf(paneId: string): string | undefined {
    return this.panes.get(paneId)?.spawn.cwd
  }

  /** Universo dono do pane VIVO — a autoridade de escopo das tools do chat. */
  projectOf(paneId: string): string | undefined {
    return this.panes.get(paneId)?.spawn.projectId
  }

  create(input: GuiPaneSpawn, queuedToken?: symbol): GuiResult {
    if (!input.paneId) return { ok: false, error: 'pane sem identificador' }
    const queuedLock = this.queuedDeliveries.get(input.paneId)
    if (queuedLock && queuedLock.token !== queuedToken) {
      return { ok: false, error: 'aguarde a mensagem da fila terminar de sair' }
    }
    if (!input.cwd) return { ok: false, error: 'pane sem pasta de trabalho' }
    if (input.cli !== 'claude' && input.cli !== 'codex') {
      return { ok: false, error: `CLI desconhecido: ${String(input.cli)}` }
    }
    if (input.systemPrompt !== undefined) {
      const problem = guiPromptProblem(input.systemPrompt, 'instrução do sistema', true)
      if (problem) return { ok: false, error: problem }
    }
    if (input.firstPrompt !== undefined) {
      const problem = guiPromptProblem(input.firstPrompt, 'primeira mensagem', true)
      if (problem) return { ok: false, error: problem }
    }

    const current = this.panes.get(input.paneId)
    // O fio visível é a fonte da remontagem. Um respawn reaproveita o anel
    // vivo; depois de fechar o pane/app, ele nasce da fotografia persistida.
    // A hidratação NÃO passa pelo sink: replay nunca dispara alerta/som.
    const replayRing = current?.ring ?? this.restoreTranscript(input.paneId)
    // TROCA DE MODO NÃO PERDE A CONVERSA (onda D): mudar o modo de permissão
    // muda o fingerprint, e o fingerprint manda respawnar. Sem esta herança o
    // processo novo nasceria em branco no meio do trabalho — o modo é uma
    // alavanca do dono, não um /clear disfarçado.
    const spawn = current ? this.inheritConversation(input, current) : input
    const fingerprint = spawnFingerprint(spawn)
    if (current) {
      // Remontagem do MESMO pane (troca de aba, reload da view): sessão viva e
      // idêntica se reusa — matar aqui jogaria a conversa fora. O replay vem
      // do anel via gui:state.
      if (current.session.alive && current.fingerprint === fingerprint) return { ok: true }
      this.dispose(spawn.paneId, 'respawn', true)
    }

    // FERRAMENTAS RE-MATERIALIZADAS DEPOIS DO TEARDOWN E ANTES DO PROCESSO.
    // Esta é a única ordem correta: o dispose acima revoga token e arquivo, e
    // é o processo que nasce logo abaixo que vai lê-los. O FINGERPRINT fica de
    // fora de propósito — ele é a identidade do que o RENDERER pediu, e o
    // re-arme é derivado do pane (mesmo caminho de arquivo, mesmas flags).
    // Carimbar o re-arme no fingerprint faria a próxima remontagem divergir de
    // si mesma e matar uma conversa viva a cada troca de aba.
    const armedSpawn = spawn.mcp && this.deps.rearmPaneTools
      ? withGuiPaneTools(spawn, this.deps.rearmPaneTools(spawn))
      : spawn
    if (spawn.mcp && !armedSpawn.mcp) {
      // O pane PEDIU ferramentas e não pôde recebê-las: a conversa continua, e
      // o diário nomeia o pane em vez de deixar o dono com um chat mudo.
      this.deps.record?.(
        'gui-pane-tools-unarmed',
        { paneId: spawn.paneId, projectId: spawn.projectId },
        { cli: spawn.cli }
      )
    }

    const ring = replayRing ?? new GuiEventRing()
    // Vale já DURANTE o construtor da sessão (um 'fatal' síncrono é captado
    // antes de a entrada existir no Map).
    const token = { alive: true }
    let replaySawReady = false
    const alertSequencer = new GuiAlertSequencer()
    let terminalFlushQueued = false
    let pendingTerminal: SessionEvent[] = []
    const pendingToolIds = new Set<string>()
    let pendingAnonymousTools = 0
    let turnHasTool = false

    const publish = (raw: SessionEvent): void => {
      // Sessão substituída/encerrada: o sink da anterior morre calado — nunca
      // fala pelo pane novo nem re-suja o anel dele.
      if (!token.alive) return
      // AJUDANTES SEM ABA: a chamada `delegate` entra na fila de envelopes, o
      // resultado dela é segurado com `launched` enquanto a frota trabalha, e o
      // `result` do turno carrega `continues` enquanto houver ajudante vivo (o
      // MESMO degrau que o claude usa para as tarefas de fundo dele — sem ele o
      // fim de turno cancelaria no renderer os cards de quem ainda trabalha).
      const evt = this.helperCards.observe(spawn.paneId, raw)
      if (replayRing && evt.type === 'ready') replaySawReady = true
      // O backend conserva o input integral apenas no estado privado que
      // executa a tool. Replay e IPC recebem uma cópia orçada.
      const visibleEvt: SessionEvent =
        evt.type === 'tool' ? { ...evt, input: limitGuiToolInput(evt.input) } : evt
      const seq = ring.push(visibleEvt)
      // Eventos intermediários ficam no anel; o próximo ponto legível captura
      // o snapshot inteiro, e dispose captura inclusive um stream parcial.
      // Assim o histórico é durável sem escrever disco por token/tool-start.
      if (guiTranscriptCheckpoint(visibleEvt)) this.saveTranscript(spawn.paneId, ring)
      this.deps.push({ paneId: spawn.paneId, seq, evt: visibleEvt })
      const alertKind = alertSequencer.accept(visibleEvt, seq)
      if (alertKind) {
        this.deps.onChatAlert?.({
          paneId: spawn.paneId,
          projectId: spawn.projectId,
          kind: alertKind
        })
      }
      if (visibleEvt.type === 'init' || visibleEvt.type === 'session-id')
        {
          const previous = this.doc.panes[spawn.paneId]
          if (
            visibleEvt.type === 'session-id' &&
            previous?.sessionId &&
            previous.sessionId !== visibleEvt.sessionId
          ) {
            // Resume/fork mudou a identidade: números da sessão anterior não
            // podem aparecer como se fossem da geração nova.
            this.rememberContextUsage(spawn.paneId, undefined)
          }
          this.remember(spawn, visibleEvt.sessionId)
        }
      if (
        visibleEvt.type === 'init' ||
        visibleEvt.type === 'context-usage' ||
        visibleEvt.type === 'result' ||
        visibleEvt.type === 'conversation-cleared'
      ) {
        const currentContext = guiContextSnapshotFromRecord(this.doc.panes[spawn.paneId])
        const nextContext = guiContextSnapshotFromEvent(visibleEvt, currentContext)
        if (nextContext !== undefined) this.rememberContextUsage(spawn.paneId, nextContext)
      }
      if (visibleEvt.type === 'permission')
        this.deps.onPermissionPending?.({
          paneId: spawn.paneId,
          projectId: spawn.projectId,
          toolName: visibleEvt.toolName,
          kind: 'permission'
        })
      // Pergunta estruturada TAMBÉM acorda o dono: ela não passa pelo evento
      // de permissão, e sem este gancho a conversa pararia em silêncio.
      if (visibleEvt.type === 'question')
        this.deps.onPermissionPending?.({
          paneId: spawn.paneId,
          projectId: spawn.projectId,
          toolName: 'AskUserQuestion',
          kind: 'question'
        })
      // O RECONCILIADOR DO FECHO (R22.4): o turno acabou com fala do dono ainda
      // no pote (ele não chamou mais tool nenhuma) — a mensagem sai agora, pelo
      // caminho de sempre. Em MICROTASK de propósito: o terminal deste turno
      // atravessa o anel, o push e os alertas inteiro antes de um turno novo
      // nascer por cima — a mesma disciplina do `flushPendingTerminal`.
      //
      // O ■ DO DONO cai aqui também, e de propósito: o que o pote guarda são as
      // PALAVRAS DELE, não uma novidade do app (essa, a do despertador, o ■
      // descarta — R6.3). Segurar a própria ordem do dono depois que a UI já a
      // mostrou entregue seria perdê-la em silêncio; o motivo no diário
      // distingue os dois fechos para quem for ler isto depois.
      if (visibleEvt.type === 'result' && this.ownerMail.has(spawn.paneId)) {
        const reason = visibleEvt.interrupted === true ? 'fecho-por-interrupcao' : 'fecho-de-turno'
        queueMicrotask(() => {
          if (!token.alive) return
          this.flushOwnerMail(spawn.paneId, reason)
        })
      }
    }

    const flushPendingTerminal = (): void => {
      terminalFlushQueued = false
      const pending = pendingTerminal
      pendingTerminal = []
      if (!token.alive) return
      for (const evt of pending) {
        publish(evt)
        turnHasTool = false
      }
    }

    const sink = (evt: SessionEvent): void => {
      // Claude pode escrever `result` antes dos tool-result de uma ferramenta
      // filha no mesmo chunk de stdout. Publicar o terminal só no microtask
      // seguinte deixa o chunk inteiro atravessar o parser antes do ring e do
      // reducer, sem mascarar um órfão quando nenhum resultado aparecer.
      if (!token.alive) return
      if (evt.type === 'tool') {
        turnHasTool = true
        if (evt.toolUseId) pendingToolIds.add(evt.toolUseId)
        else pendingAnonymousTools += 1
        publish(evt)
        return
      }
      if (evt.type === 'tool-result') {
        if (evt.toolUseId) pendingToolIds.delete(evt.toolUseId)
        else if (pendingAnonymousTools > 0) pendingAnonymousTools -= 1
        publish(evt)
        return
      }
      if (evt.type !== 'result') {
        publish(evt)
        return
      }
      // Sem nenhuma ferramenta na rodada, não há nada para reconciliar e o
      // terminal mantém a latência anterior (importante para /status e para
      // os snapshots de contexto).
      if (!turnHasTool && pendingToolIds.size === 0 && pendingAnonymousTools === 0) {
        publish(evt)
        return
      }
      pendingTerminal.push(evt)
      if (terminalFlushQueued) return
      terminalFlushQueued = true
      queueMicrotask(flushPendingTerminal)
    }

    let session: GuiBackend
    try {
      session = this.spawnSession(armedSpawn, sink)
    } catch (error) {
      token.alive = false
      const text = error instanceof Error ? error.message : String(error)
      this.deps.record?.(
        'gui-session-spawn-failed',
        { paneId: spawn.paneId, projectId: spawn.projectId },
        { cli: spawn.cli, err: text }
      )
      return { ok: false, error: `não consegui abrir a sessão: ${text}` }
    }

    // Boundary canonico da nova geracao. Init/ready atrasados, sem este marco,
    // jamais podem ressuscitar uma sessao que ja terminou.
    if (replayRing) {
      const remembered = this.doc.panes[spawn.paneId]
      // Contexto só atravessa a barreira quando o pane está retomando a
      // identidade exata persistida. Troca de CLI/conta ou sessão nova recebe
      // uma fotografia vazia, mesmo que o transcript antigo ainda exista.
      const sameConversation = Boolean(
        remembered &&
          remembered.cli === spawn.cli &&
          remembered.projectId === spawn.projectId &&
          remembered.sessionId &&
          spawn.resumeSessionId === remembered.sessionId
      )
      const replayContext = sameConversation
        ? guiContextSnapshotFromRecord(remembered) ?? guiContextSnapshotFromRing(replayRing)
        : undefined
      // `resumed` é o MESMO sinal que deixa a fotografia atravessar: dito em
      // voz alta, ele deixa a apresentação distinguir "a conversa continua" de
      // "nasceu outra" — sem isso o renderer só via `ready: false` e tratava
      // todo respawn como abertura (R12/A4).
      sink({
        type: 'session-restarted',
        ready: replaySawReady,
        resumed: sameConversation,
        ...(replayContext ?? {})
      })
      // A geração nova substitui qualquer override sticky da conta/CLI
      // anterior. `null` é intencional: padrão do CLI/modelo, não “desconhecido”.
      sink({
        type: 'executor-changed',
        model: spawn.model ?? null,
        effort: spawn.effort ?? null
      })
      // AJUDANTE NÃO SOBREVIVE A ISTO (D1, MVP explícito). A fotografia que
      // voltou do disco — ou o anel preservado de um respawn — pode ter card de
      // ajudante ABERTO de um processo que não existe mais; mostrá-lo como
      // "trabalhando" seria a lateral mentindo. O motor já cancelou a frota no
      // teardown, mas ali o sink desta geração ainda não existia: o reparo
      // honesto é aqui, no anel, uma vez por nascimento.
      for (const cancellation of guiOrphanHelperCancellations(
        replayRing.snapshot(),
        current ? 'a conversa foi reaberta' : 'o app fechou'
      )) {
        sink(cancellation)
      }
    }

    this.panes.set(spawn.paneId, {
      // O spawn REALMENTE executado, com as ferramentas desta geração: é ele
      // que a entrega da fila e o `/clear` espalham para recriar o pane.
      spawn: armedSpawn,
      fingerprint,
      session,
      ring,
      alerts: alertSequencer,
      token,
      sink,
      flushPendingTerminal,
      // O BRIEFING ATRAVESSA O RESPAWN. `current?.pendingBriefing` primeiro
      // porque as três rotas que reabrem o pane antes da 1ª mensagem — trocar
      // a permissão, entregar a mensagem da fila com modo novo, remontar —
      // chegam aqui com `firstPrompt` já zerado. `/clear` NÃO herda: ele
      // descarta a entrada antes de recriar, e trocar de conversa é
      // deliberado.
      pendingBriefing: current?.pendingBriefing ?? (spawn.firstPrompt?.trim() || undefined),
      messageIds:
        current?.messageIds ?? rememberedGuiMessageIds(ring, this.doc.panes[spawn.paneId])
    })
    // O modo é gravado JÁ no create (não espera o `init`): reabrir a conversa
    // sem escolher nada tem de cair na última escolha do dono.
    this.remember(spawn)
    this.deps.record?.(
      'gui-session-created',
      { paneId: spawn.paneId, projectId: spawn.projectId },
      {
        cli: spawn.cli,
        resumed: Boolean(spawn.resumeSessionId),
        permissionMode: spawn.permissionMode ?? 'default'
      }
    )

    // O QUE FICOU PARADO (R6.1): conversa que ABRE de verdade — boot do app,
    // reabrir o chat — descobre aqui se o motor guarda ajudantes interrompidos
    // dela, e o aviso com os dois verbos entra no correio. `current` presente é
    // respawn (modo, /clear, remontagem): mesma conversa, nada a anunciar.
    if (!current) this.announceInterruptedHelpers(spawn.paneId, spawn.projectId)
    // O ⇪ QUE FICOU ESPERANDO (rodada 9), pela mesma porta e pelo mesmo motivo:
    // o dono pode ter clicado com este chat fechado (ou o app reiniciou depois
    // do clique). O motor confere a fila e re-estimula quem tem ticket em
    // espera. Nada depende de entrega única — o ticket é o registro durável.
    if (!current) {
      try {
        this.integration?.paneOpened(spawn.paneId, spawn.projectId)
      } catch {
        // Fila indisponível nunca pode impedir a conversa de abrir.
      }
    }
    // A FALA DO DONO QUE FICOU NO POTE (R22.4, a outra metade do reconciliador).
    // Duas travessias a trouxeram até aqui: o RESPAWN (troca de modo, `/clear`,
    // ⚡) mata o turno sem nunca fechá-lo, e o BOOT devolve do disco o que o app
    // não conseguiu entregar antes de morrer. Nos dois casos o processo novo
    // nasce sem turno, então este é o primeiro instante em que a entrega cabe —
    // e ela não é "turno nascendo aqui": é a mensagem do dono, que ele mandou,
    // finalmente chegando.
    this.flushOwnerMail(spawn.paneId, current ? 'respawn' : 'abertura')
    // NENHUM TURNO NASCE AQUI. O chat abre calado e espera o dono.
    return { ok: true }
  }

  /**
   * ENTREGA EM VOO NESTE PANE — a recusa TRANSITÓRIA, escrita uma vez só.
   *
   * Duas coisas ocupam a linha: a mensagem da FILA saindo (que pode até recriar
   * a sessão, se o modo de permissão dela for outro) e a TROCA DE EXECUTOR
   * esperando o ACK do backend. Enfiar um envio no meio de qualquer uma delas é
   * mandar texto para uma sessão que está sendo trocada — e o `send` recusa
   * isso desde sempre. O despertador (`wakeDelegator`) precisa da MESMA leitura:
   * ele deixou de passar pelo `send` na rodada 7 e perderia as duas guardas.
   *
   * Sessão MORTA não é "ocupada": quem chama tem uma recusa mais verdadeira para
   * dar ("a sessão deste pane encerrou"), e é ela que o dono lê no composer.
   */
  private paneBusyReason(
    paneId: string,
    entry: GuiPaneEntry | undefined,
    queuedToken?: symbol
  ): string | undefined {
    const queuedLock = this.queuedDeliveries.get(paneId)
    if (queuedLock && queuedLock.token !== queuedToken) {
      return 'aguarde a mensagem da fila terminar de sair'
    }
    if (entry?.session.alive && this.executorChanges.has(entry)) {
      return 'aguarde a troca de modelo ou effort terminar'
    }
    return undefined
  }

  /**
   * O CAMINHO DOS BASTIDORES: texto para o MODELO, sem bolha de dono.
   *
   * `turn-started` + `session.send`, e mais nada: nenhum `user-message`, nenhum
   * messageId, nenhuma linha no fio. Ele nasceu no recibo de decisão de plano
   * (`announce`) e a rodada 7 mudou o despertador de ajudantes para cá — os dois
   * são o APP falando com o agente, e app não fala na voz do dono.
   *
   * A validação mora AQUI, e não em cada chamador: o `guiPromptProblem` é o
   * mesmo teto que o `send` mede, então nenhum caminho de entrega pode mandar ao
   * backend um texto que o outro recusaria.
   *
   * O `pendingBriefing` NÃO é consumido de propósito: aviso do app não é a
   * primeira mensagem do dono, e queimar o briefing da missão num texto de
   * máquina deixaria a primeira pergunta dele chegar sem contrato nenhum.
   */
  private deliverBackstage(paneId: string, text: string, label: string): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!entry.session.alive) return { ok: false, error: 'a sessão deste pane encerrou' }
    const problem = guiPromptProblem(text, label, true)
    if (problem) return { ok: false, error: problem }
    entry.sink({ type: 'turn-started' })
    entry.session.send(text)
    return { ok: true }
  }

  send(
    paneId: string,
    text: string,
    clientMessageId?: string,
    attachmentInput?: unknown,
    queuedToken?: symbol
  ): GuiResult {
    const problem = guiPromptProblem(text, 'mensagem', true)
    if (problem) return { ok: false, error: problem }
    if (clientMessageId !== undefined) {
      const idProblem = guiMessageIdProblem(clientMessageId)
      if (idProblem) return { ok: false, error: idProblem }
    }
    const entry = this.panes.get(paneId)
    const busy = this.paneBusyReason(paneId, entry, queuedToken)
    if (busy) return { ok: false, error: busy }
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!entry.session.alive) return { ok: false, error: 'a sessão deste pane encerrou' }
    const messageId = clientMessageId ?? `main-${++this.nextMessageId}`
    const messageIds = entry.messageIds ?? (entry.messageIds = new Set<string>())
    if (messageIds.has(messageId)) return { ok: true }
    const validatedAttachments = validateGuiAttachmentReferences(
      entry.spawn.cwd,
      paneId,
      attachmentInput,
      this.attachmentCapabilities
    )
    if (!validatedAttachments.ok) return { ok: false, error: validatedAttachments.error }
    if (!text.trim() && validatedAttachments.attachments.length === 0) {
      return { ok: false, error: 'mensagem vazia' }
    }
    const prompt = withGuiAttachmentReferences(text, validatedAttachments.resolved)
    const promptProblem = guiPromptProblem(prompt)
    if (promptProblem) return { ok: false, error: 'mensagem e anexos grandes demais' }
    // O BRIEFING VIAJA COLADO NESTA MENSAGEM (ver `pendingBriefing`): o teto é
    // conferido ANTES de qualquer marco no fio, senão uma recusa deixaria um
    // turno fantasma no transcript com o id da mensagem já consumido. O
    // briefing só é DESCARTADO no envio de verdade, lá embaixo.
    if (
      entry.pendingBriefing &&
      guiPromptProblem(guiBriefedPrompt(entry.pendingBriefing, prompt))
    ) {
      return {
        ok: false,
        error: 'sua primeira mensagem mais o briefing da missão passam do limite'
      }
    }
    const trimmed = text.trim()
    if (
      validatedAttachments.attachments.length === 0 &&
      (trimmed === '/clear' || (entry.spawn.cli === 'codex' && trimmed === '/new'))
    )
      return this.clearConversation(entry)
    messageIds.add(messageId)
    if (messageIds.size > 2_048) {
      const oldest = messageIds.values().next().value
      if (oldest) messageIds.delete(oldest)
    }
    entry.sink({
      type: 'user-message',
      id: messageId,
      text,
      ...(validatedAttachments.attachments.length > 0
        ? { attachments: validatedAttachments.attachments }
        : {}),
      at: Date.now()
    })
    entry.sink({ type: 'turn-started' })
    if (
      validatedAttachments.attachments.length === 0 &&
      trimmed.startsWith('/') &&
      this.routeSlash(entry, trimmed)
    )
      return { ok: true }
    // A ROTA DO POTE (R22.1), com DUAS cercas — e as duas antes de o briefing
    // ser consumido.
    //
    // SLASH CRU (`/compact`, `/status`, uma skill do CLI) chega aqui porque o
    // roteador acima o deixou passar: é COMANDO, e comando tem de ser EXECUTADO
    // pelo binário. Citá-lo dentro de um resultado de tool viraria texto SOBRE
    // um comando, e o dono nunca veria o efeito que pediu.
    //
    // BRIEFING PENDENTE: o contrato da missão é PROMPT, não citação — e um
    // despejo desse tamanho no meio do turno é caro. Turno aberto com briefing
    // pendente é caso de canto (ele só existe antes da primeira fala do dono), e
    // segue pelo caminho de sempre.
    if (
      !trimmed.startsWith('/') &&
      !entry.pendingBriefing &&
      this.postOwnerMail(paneId, entry, messageId, prompt)
    ) {
      return { ok: true }
    }
    // AQUI, e não antes: o `/clear` e os slash roteados voltam acima sem
    // alcançar o modelo — soltar o briefing neles seria queimá-lo num comando
    // que o agente nunca vê.
    const briefing = entry.pendingBriefing
    if (briefing) entry.pendingBriefing = undefined
    // Turno durante turno é problema RESOLVIDO dos backends (claude enfileira,
    // codex faz steer) — o motor não tem fila própria.
    entry.session.send(briefing ? guiBriefedPrompt(briefing, prompt) : prompt)
    return { ok: true }
  }

  /**
   * A ROTA (R22.1) — a fala do dono no meio do turno-fortaleza vai pro POTE.
   *
   * O caso do print (19/08): o delegador esperando a frota num `helper_result`,
   * o dono manda mensagem com "enviar agora", a bolha VOCÊ aparece — e o agente
   * não lê, porque mensagem empurrada pro stdin no meio de um turno fica na fila
   * INTERNA do CLI até o turno fechar (pós-R19, potencialmente horas).
   *
   * Então, com TRÊS coisas verdadeiras ao mesmo tempo — turno ABERTO, sessão
   * viva e pane DELEGADOR —, a entrega troca de canal: o texto entra no pote e
   * viaja de carona no próximo resultado de tool da delegação
   * (`guiDelegationWiring.withInbox`), que é o único caminho que alcança o modelo
   * DENTRO do turno. A bolha no fio já saiu lá em cima, e continua saindo:
   * apresentação não é entrega.
   *
   * CARONA OU STDIN, NUNCA OS DOIS: `true` aqui significa que o `send` NÃO fala
   * com o CLI — mandar também pelo stdin faria o modelo ler a mesma ordem duas
   * vezes (agora na carona, de novo quando o CLI liberasse a fila), que é o
   * espelho do bug que esta rodada mata.
   *
   * `false` = nada mudou e o chamador segue pelo caminho de sempre: pane que não
   * delega, turno fechado, sessão morta, mensagem grande demais para viajar num
   * resultado de tool ou pote cheio. Nenhum desses é beco — todos caem no envio
   * de hoje, que entrega no fecho do turno.
   */
  private postOwnerMail(
    paneId: string,
    entry: GuiPaneEntry,
    messageId: string,
    text: string
  ): boolean {
    if (!entry.session.alive || !entry.session.turnActive) return false
    if (this.deps.delegatorPane?.(paneId) !== true) return false
    if (!this.ownerMail.post(paneId, { messageId, text, at: Date.now() })) return false
    this.deps.record?.(
      'gui-owner-mail-posted',
      { paneId, projectId: entry.spawn.projectId },
      { messageId, chars: text.length, pending: this.ownerMail.count(paneId) }
    )
    // R22.3 — o long-poll da frota resolve AGORA. Sem isto a fala do dono
    // esperaria o teto do `helper_result` (até 240s) para pegar carona.
    try {
      this.helpers?.wakePane?.(paneId)
    } catch {
      // Despertar é aceleração, nunca pré-condição: a carona sai no próximo
      // resultado de tool de qualquer jeito.
    }
    return true
  }

  /**
   * O RECONCILIADOR (R22.4) — nenhum passo depende de entrega única.
   *
   * A carona é a entrega rápida, mas ela só existe se o agente chamar mais
   * alguma tool. Se o turno FECHAR com o pote cheio (ele respondeu ao dono e
   * parou, ou o ■ derrubou o turno), o fecho entrega pelo caminho de sempre: a
   * fala do dono vai ao CLI como a mensagem de usuário que sempre foi, sem
   * bolha nova (a bolha saiu no envio) e sem embrulho de harness.
   *
   * Roda também no NASCIMENTO do pane, e é isso que fecha os dois buracos
   * sondados: o respawn (troca de modo, `/clear`, ⚡) mata o turno sem nunca
   * fechá-lo, e o boot devolve do disco o que o app não entregou antes de morrer.
   *
   * Recusa transitória NUNCA consome: o pote é devolvido inteiro, na ordem, e o
   * próximo fecho (ou a próxima abertura) tenta de novo.
   */
  private flushOwnerMail(paneId: string, reason: string): void {
    if (!this.ownerMail.has(paneId)) return
    const entry = this.panes.get(paneId)
    if (!entry || !entry.session.alive) return
    // Turno ainda vivo = a carona ainda pode acontecer, e ela é melhor: chega ao
    // modelo AGORA, sem esperar o fim.
    if (entry.session.turnActive) return
    // A mensagem da fila saindo e a troca de executor em voo seguram o envio
    // pelo MESMO motivo do despertador (`paneBusyReason`).
    if (this.paneBusyReason(paneId, entry)) return
    const entries = this.ownerMail.drain(paneId)
    if (entries.length === 0) return
    const text = guiOwnerMailFlushText(entries)
    // Pote só com brancos é impossível pela porta do `post` — e, se algum dia
    // for, some aqui em vez de abrir um turno com nada dentro.
    if (!text.trim()) return
    const sent = this.deliverBackstage(paneId, text, 'mensagem do dono')
    if (!sent.ok) {
      this.ownerMail.restore(paneId, entries)
      return
    }
    this.deps.record?.(
      'gui-owner-mail-flushed',
      { paneId, projectId: entry.spawn.projectId },
      { messages: entries.length, chars: text.length, reason }
    )
  }

  /**
   * RECIBO DE UMA DECISÃO DO DONO: texto para o MODELO, sem bolha de dono.
   *
   * O clique do dono precisa continuar a conversa sem ninguém digitar (era 2.0),
   * mas o que o app conta ao agente NÃO é uma fala do dono. Mandar isso pelo
   * `send` fazia nascer uma bolha "VOCÊ" com prefixo de máquina e um uuid cru —
   * o dono aparecia dizendo coisas que nunca disse. O fio já mostra a decisão
   * pela nota que o redutor escreve (`plano criado: <título>`), então aqui o
   * texto vai direto ao modelo: nada de `user-message`, nada de `messageId`.
   *
   * `turn-started` continua sendo emitido porque um turno REAL começa — sem
   * ele o composer ficaria ocioso enquanto o agente já está trabalhando.
   *
   * O recibo NÃO consulta o `paneBusyReason`: ele é disparado pelo clique do
   * dono e não tem quem o repita (o `ipc/gui` o entrega e segue), então recusar
   * numa janela transitória seria perdê-lo. O despertador, que tem relógio para
   * tentar de novo, é quem paga esse pedágio.
   */
  announce(paneId: string, text: string): GuiResult {
    return this.deliverBackstage(paneId, text, 'recibo')
  }

  /**
   * UMA NOTA NO FIO — o PAR VISUAL do `announce` (rodada 9, o ⇪ do dono).
   *
   * O `announce` fala com o MODELO e não deixa rastro na tela; esta fala com o
   * DONO e não chega ao modelo. Os dois juntos são o gesto inteiro: ele vê a
   * linha ("⇪ subir para … — entregue ao agente") e o agente recebe a ordem.
   * Misturar as duas superfícies é exatamente o que já fez o app aparecer
   * falando na voz dele, com prefixo de máquina e uuid cru no meio.
   *
   * Sai pelo MESMO sink da sessão (`command-output`, que o redutor do renderer
   * transforma em `note`): publicar por fora deixaria a linha ausente do replay
   * da remontagem, e o dono reabriria a conversa sem o rastro do gesto. Ela não
   * abre turno nenhum e não pede par de `command-completed` — o redutor a
   * empurra como item e segue.
   */
  note(paneId: string, text: string): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!entry.session.alive) return { ok: false, error: 'a sessão deste pane encerrou' }
    // Sem `allowEmpty`: uma nota em branco é ruído no fio do dono, e ruído de
    // máquina é justamente o que esconde a linha que importa.
    const problem = guiPromptProblem(text, 'nota')
    if (problem) return { ok: false, error: problem }
    entry.sink({ type: 'command-output', text })
    return { ok: true }
  }

  /**
   * Entrega transacional da unica mensagem em fila. A fotografia de permissao,
   * modelo e effort e aplicada no main antes do envio; o mesmo id atravessa
   * retries e o transcript persistido, portanto uma resposta IPC perdida nao
   * executa a mensagem duas vezes.
   */
  async deliverQueued(paneId: string, raw: unknown): Promise<GuiResult> {
    const problem = guiQueuedDeliveryProblem(raw)
    if (problem) return { ok: false, error: problem }
    const input = raw as GuiQueuedDeliveryInput
    if (this.hasQueuedDeliveryReceipt(paneId, input.id)) return { ok: true }
    const current = this.panes.get(paneId)
    if (!current) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (current.messageIds?.has(input.id)) {
      this.rememberQueuedDeliveryReceipt(paneId, input.id)
      return { ok: true }
    }
    if (!current.session.alive) return { ok: false, error: 'a sessão deste pane encerrou' }
    if (current.session.turnActive) {
      return { ok: false, error: 'a resposta anterior ainda não terminou' }
    }
    const existing = this.queuedDeliveries.get(paneId)
    if (existing) {
      if (existing.id === input.id) return existing.promise
      return { ok: false, error: 'outra entrega da fila já está em andamento' }
    }

    const token = Symbol(`queued:${paneId}`)
    const delivery = Promise.resolve().then(() => this.performQueuedDelivery(paneId, input, token))
    this.queuedDeliveries.set(paneId, { id: input.id, token, promise: delivery })
    try {
      return await delivery
    } finally {
      const lock = this.queuedDeliveries.get(paneId)
      if (lock?.token === token) this.queuedDeliveries.delete(paneId)
    }
  }

  private async performQueuedDelivery(
    paneId: string,
    input: GuiQueuedDeliveryInput,
    token: symbol
  ): Promise<GuiResult> {
    let entry = this.panes.get(paneId)
    if (!entry || !entry.session.alive) {
      return { ok: false, error: 'a sessão deste pane encerrou' }
    }

    const permissionMode = input.options.permissionMode as GuiPermissionMode
    if ((entry.spawn.permissionMode ?? 'default') !== permissionMode) {
      const created = this.create({ ...entry.spawn, permissionMode, firstPrompt: undefined }, token)
      if (!created.ok) return created
      entry = this.panes.get(paneId)
      if (!entry) return { ok: false, error: 'não consegui retomar a conversa' }
      const caps = await entry.session.waitCaps(READY_TIMEOUT_MS)
      if (!caps || !entry.session.alive || this.panes.get(paneId) !== entry) {
        return { ok: false, error: 'o CLI não confirmou a retomada da conversa' }
      }
    }

    const configured = await this.configureExecutor(
      paneId,
      { model: input.options.model, effort: input.options.effort },
      token
    )
    if (!configured.ok) return configured

    entry = this.panes.get(paneId)
    if (!entry || !entry.session.alive || entry.session.turnActive) {
      return { ok: false, error: 'a conversa mudou antes do envio da fila' }
    }
    const sent = this.send(paneId, input.text, input.id, input.attachments, token)
    if (sent.ok) this.rememberQueuedDeliveryReceipt(paneId, input.id)
    return sent
  }

  /**
   * Troca modelo/effort SEM recriar o processo e SEM escrever uma linha no
   * transcript. Nos dois backends esses valores são overrides do próximo
   * turno: Codex os leva no `turn/start`; Claude aplica a camada de flag
   * settings pelo protocolo de controle. A seleção só é carimbada depois
   * do ACK do backend, portanto uma recusa deixa UI, spawn e documento iguais.
   */
  async configureExecutor(
    paneId: string,
    patch: GuiExecutorPatch,
    queuedToken?: symbol
  ): Promise<GuiExecutorResult> {
    if (!paneId || paneId.length > 256) return { ok: false, error: 'pane sem identificador válido' }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'troca de executor em formato inválido' }
    }
    const keys = Object.keys(patch)
    if (keys.length === 0 || keys.some((key) => key !== 'model' && key !== 'effort')) {
      return { ok: false, error: 'troca de executor sem campo válido' }
    }
    for (const [label, value] of [
      ['modelo', patch.model],
      ['effort', patch.effort]
    ] as const) {
      if (value !== undefined && value !== null) {
        if (typeof value !== 'string' || !value.trim() || value.length > 128) {
          return { ok: false, error: `${label} inválido` }
        }
      }
    }

    const queuedLock = this.queuedDeliveries.get(paneId)
    if (queuedLock && queuedLock.token !== queuedToken) {
      return { ok: false, error: 'aguarde a mensagem da fila terminar de sair' }
    }
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!entry.session.alive) return { ok: false, error: 'a sessão deste pane encerrou' }
    if (entry.session.turnActive) {
      return { ok: false, error: 'aguarde a resposta atual terminar antes de trocar o executor' }
    }
    if (this.executorChanges.has(entry)) {
      return { ok: false, error: 'uma troca de executor já está em andamento' }
    }

    const model = patch.model === undefined ? entry.spawn.model : patch.model ?? undefined
    const effort = patch.effort === undefined ? entry.spawn.effort : patch.effort ?? undefined
    if (model === entry.spawn.model && effort === entry.spawn.effort) {
      return { ok: true, model: model ?? null, effort: effort ?? null }
    }

    const models = entry.session.caps?.models ?? []
    const selectedModel = model
      ? models.find(
          (candidate) => candidate.value === model || candidate.resolvedModel === model
        )
      : models.find(
          (candidate) =>
            candidate.value.toLowerCase() === 'default' ||
            candidate.displayName.toLowerCase().startsWith('default')
        )
    if (model && !selectedModel) {
      return { ok: false, error: 'esse modelo não está disponível nesta conta' }
    }
    if (effort) {
      if (!selectedModel?.supportedEffortLevels?.includes(effort)) {
        return { ok: false, error: 'esse effort não está disponível para o modelo escolhido' }
      }
    }

    this.executorChanges.add(entry)
    try {
      const changed = await entry.session.setExecutor({ model, effort })
      // Kill/troca de seat durante o ACK: a resposta antiga nunca pode
      // carimbar a geração que tomou o lugar dela.
      if (
        !changed ||
        !entry.token.alive ||
        !entry.session.alive ||
        this.panes.get(paneId) !== entry
      ) {
        return { ok: false, error: 'o CLI não confirmou a troca de executor' }
      }
      entry.spawn.model = model
      entry.spawn.effort = effort
      entry.fingerprint = spawnFingerprint(entry.spawn)
      this.remember(entry.spawn, undefined, {
        model: model ?? null,
        effort: effort ?? null
      })
      entry.sink({
        type: 'executor-changed',
        model: model ?? null,
        effort: effort ?? null
      })
      this.deps.record?.(
        'gui-executor-changed',
        { paneId, projectId: entry.spawn.projectId },
        { model: model ?? 'default', effort: effort ?? 'default' }
      )
      return { ok: true, model: model ?? null, effort: effort ?? null }
    } catch {
      return { ok: false, error: 'o CLI não confirmou a troca de executor' }
    } finally {
      this.executorChanges.delete(entry)
    }
  }

  /**
   * COMANDOS SLASH NO CHAT (2.0). true = tratado aqui, nada vai cru ao CLI.
   * - codex: `runSlash` mapeia cada comando ao RPC real; desconhecido responde
   *   sintético — slash cru num turn/start viraria prompt e QUEIMARIA tokens.
   * - claude: o CLI em modo SDK executa comandos crus sozinho (caminho 'raw');
   *   as exceções interceptadas são /model (set_model ao vivo + carimbo novo
   *   no spawn/documento) e /fast (fora desta rodada: o toggle REAL exige
   *   respawn com --settings {"fastMode":true} — ver o /fast do painel do PM).
   * Evento sintético sai pelo SINK do entry (anel + push): sem o par
   * command-output+result o spinner do renderer nunca fecharia.
   */
  private routeSlash(entry: GuiPaneEntry, trimmed: string): boolean {
    if (entry.session instanceof CodexSession) {
      if (entry.session.runSlash(trimmed)) return true
      entry.sink({
        type: 'command-output',
        text: codexUnknownSlashReply(slashCommandName(trimmed))
      })
      entry.sink({ type: 'command-completed', isError: false, continues: entry.session.turnActive })
      return true
    }
    const route = routeClaudeSlash(trimmed)
    if (route.kind === 'raw') return false
    if (route.kind === 'fast') {
      // R11: fast é flag de PROCESSO no claude (opt-in de spawn — sonda
      // probe-fast) e o caminho canônico do chat é o toggle ⚡ do composer,
      // que respawna com resume. A resposta nomeia a receita, nunca um beco.
      entry.sink({
        type: 'command-output',
        text: entry.spawn.fast
          ? 'o modo fast está LIGADO nesta conversa — desligue no botão ⚡ ao lado do seletor de modelo (a conversa continua de onde está)'
          : 'para ligar o modo fast use o botão ⚡ ao lado do seletor de modelo — a conversa continua de onde está. Atenção: no claude, ligar troca o modelo para Opus 5 (comportamento do próprio CLI)'
      })
      entry.sink({ type: 'command-completed', isError: false, continues: entry.session.turnActive })
      return true
    }
    if (route.kind === 'model-list') {
      const models = entry.session.caps?.models ?? []
      entry.sink({
        type: 'command-output',
        text: models.length
          ? models.map((m) => `${m.value} — ${m.displayName}`).join('\n')
          : 'a lista de modelos ainda não chegou do CLI — tente de novo em instantes'
      })
      entry.sink({ type: 'command-completed', isError: false, continues: entry.session.turnActive })
      return true
    }
    const model = route.model
    const modelValue = model === 'default' ? null : model
    const selected = (entry.session.caps?.models ?? []).find((candidate) =>
      modelValue === null
        ? candidate.value.toLowerCase() === 'default' ||
          candidate.displayName.toLowerCase().startsWith('default')
        : candidate.value === modelValue || candidate.resolvedModel === modelValue
    )
    const effort =
      entry.spawn.effort && selected?.supportedEffortLevels?.includes(entry.spawn.effort)
        ? entry.spawn.effort
        : null
    void this.configureExecutor(entry.spawn.paneId, { model: modelValue, effort }).then((result) => {
      if (!entry.token.alive) return
      entry.sink({
        type: 'command-output',
        text: result.ok
          ? `modelo: ${model}`
          : `não consegui trocar o modelo para ${model}: ${result.error}`
      })
      entry.sink({
        type: 'command-completed',
        isError: !result.ok,
        continues: entry.session.turnActive,
        ...(!result.ok ? { errorText: result.error } : {})
      })
    })
    return true
  }

  permission(paneId: string, requestId: string, behavior: GuiPermBehavior): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    const answered = entry.session.answerPermission(requestId, behavior)
    if (!answered) {
      entry.sink({ type: 'interaction-resolved', requestId, resolution: { kind: 'stale' } })
      return { ok: false, error: 'este pedido de permissão não está mais pendente' }
    }
    entry.sink({
      type: 'interaction-resolved',
      requestId,
      resolution: {
        kind: 'permission',
        ...(answered.toolUseId ? { toolUseId: answered.toolUseId } : {}),
        toolName: answered.toolName,
        behavior
      }
    })
    return { ok: true }
  }

  /** Resposta do card de AskUserQuestion (claude apenas — o codex não tem a
   *  tool, e a recusa diz isso em vez de fingir). */
  answerQuestion(paneId: string, requestId: string, answers: Record<string, string>): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!(entry.session instanceof MaestroSession))
      return { ok: false, error: 'este CLI não tem perguntas interativas' }
    if (!entry.session.answerQuestion(requestId, answers)) {
      entry.sink({ type: 'interaction-resolved', requestId, resolution: { kind: 'stale' } })
      return { ok: false, error: 'esta pergunta não está mais pendente' }
    }
    entry.sink({
      type: 'interaction-resolved',
      requestId,
      resolution: {
        kind: 'question',
        entries: Object.entries(answers)
          .slice(0, 8)
          .map(([question, answer]) => ({
            question: question.slice(0, 2_000),
            answer: answer.slice(0, 4_000)
          }))
      }
    })
    return { ok: true }
  }

  /** Veredito do card de plano (ExitPlanMode; claude apenas). */
  answerPlan(paneId: string, requestId: string, approve: boolean): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!(entry.session instanceof MaestroSession))
      return { ok: false, error: 'este CLI não tem perguntas interativas' }
    if (!entry.session.answerPlanReview(requestId, approve)) {
      entry.sink({ type: 'interaction-resolved', requestId, resolution: { kind: 'stale' } })
      return { ok: false, error: 'este plano não está mais pendente' }
    }
    entry.sink({
      type: 'interaction-resolved',
      requestId,
      resolution: { kind: 'plan', approve }
    })
    return { ok: true }
  }

  /**
   * PROPOSTA DE PLANO (2.0, onda D). Diferente de todo o resto desta classe, o
   * evento não vem do CLI: a tool `propose_plan` do pane de planejamento chega
   * pelo servidor MCP e o harness sintetiza o card AQUI, no anel daquele pane.
   *
   * A tool NUNCA cria o plano — ela apresenta. Por isso este método devolve na
   * hora (o agente encerra o turno) e o card fica pendurado no anel, imune ao
   * `result`, até o dono clicar.
   */
  proposePlan(
    paneId: string,
    draft: PlanDraft
  ): { ok: true; requestId: string } | { ok: false; error: string } {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!isPlanDraft(draft)) return { ok: false, error: 'plano em formato inválido' }
    // UMA proposta pendente por conversa. Como ela sobrevive ao fim do turno,
    // sem esta regra um agente que re-propõe sem resposta empilharia cards no
    // anel para sempre — e o dono teria de julgar versões concorrentes do mesmo
    // plano. A anterior sai do fio com eco factual de superada.
    for (const stale of entry.ring.pendingIdsOfType('plan-proposal')) {
      entry.sink({ type: 'interaction-resolved', requestId: stale, resolution: { kind: 'stale' } })
    }
    const requestId = `plan-proposal-${randomUUID()}`
    entry.sink({ type: 'plan-proposal', requestId, draft })
    // Mesmo gancho da pergunta estruturada: a conversa parou esperando o dono,
    // então a notificação de desktop precisa acordá-lo.
    this.deps.onPermissionPending?.({
      paneId,
      projectId: entry.spawn.projectId,
      toolName: 'propose_plan',
      kind: 'question'
    })
    return { ok: true, requestId }
  }

  /** O rascunho AUTORITATIVO de uma proposta ainda pendente neste pane. */
  pendingPlanProposal(paneId: string, requestId: string): PlanDraft | undefined {
    const entry = this.panes.get(paneId)
    if (!entry) return undefined
    const pending = entry.ring.pending(requestId)
    const record = guiEventRecord(pending)
    if (record?.['type'] !== 'plan-proposal') return undefined
    const draft = record['draft']
    return isPlanDraft(draft) ? draft : undefined
  }

  /**
   * Fecha a proposta no fio. O plano em si nasce fora daqui (o motor não
   * conhece store nenhum); este método só registra o desfecho e libera o card.
   */
  resolvePlanProposal(
    paneId: string,
    requestId: string,
    resolution: { approve: boolean; planId?: string; planTitle?: string }
  ): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!this.pendingPlanProposal(paneId, requestId)) {
      entry.sink({ type: 'interaction-resolved', requestId, resolution: { kind: 'stale' } })
      return { ok: false, error: 'esta proposta não está mais pendente' }
    }
    entry.sink({
      type: 'interaction-resolved',
      requestId,
      resolution: {
        kind: 'plan-proposal',
        approve: resolution.approve,
        ...(resolution.planId ? { planId: resolution.planId } : {}),
        ...(resolution.planTitle ? { planTitle: resolution.planTitle } : {})
      }
    })
    return { ok: true }
  }

  // ————— AJUDANTES SEM ABA (2026-08-18) — a ponte com o guiHelperSessions —————

  /**
   * O CHAT que está delegando, como o motor de ajudantes precisa dele: o
   * ajudante CLONA o delegador quando o pedido não diz o contrário, e a fonte
   * do modelo/effort/conta é a CONVERSA VIVA (o dono pode ter trocado os três
   * no cabeçalho depois do nascimento da missão). `undefined` = pane sem sessão
   * aberta: a tool recusa em vez de adivinhar um executor.
   */
  delegatorFor(paneId: string): GuiHelperDelegator | undefined {
    const entry = this.panes.get(paneId)
    if (!entry) return undefined
    const spawn = entry.spawn
    return {
      paneId,
      projectId: spawn.projectId,
      cwd: spawn.cwd,
      cli: spawn.cli,
      model: spawn.model ?? '',
      ...(spawn.effort ? { effort: spawn.effort } : {}),
      seatId: spawn.seatId ?? '',
      ...(spawn.permissionMode ? { permissionMode: spawn.permissionMode } : {})
    }
  }

  /**
   * Abre a janela do LOTE e reclama o envelope (o card `delegate` que o CLI já
   * publicou). Tem de envolver o `engine.spawn` inteiro: os avisos `spawned`
   * chegam DENTRO dele, e é o lote aberto que diz a qual chamada eles pertencem.
   */
  beginHelperBatch(paneId: string): string | undefined {
    if (!this.panes.has(paneId)) return undefined
    return this.helperCards.begin(paneId)
  }

  endHelperBatch(paneId: string): void {
    this.helperCards.end(paneId)
  }

  /** O motor falou (nasceu / mexeu / voltou / encerrou): vira card no anel. */
  noteHelperChange(change: GuiHelperChange): void {
    this.helperCards.change(change)
  }

  /**
   * AMARRA O MOTOR DE AJUDANTES ao registro — a segunda metade de uma costura
   * CIRCULAR, e é por isso que ela é tardia e não uma dep do construtor.
   *
   * O motor nasce ANTES do registro (o índice precisa dele para amarrar o
   * teardown do pane) e já fala com ele por closure (`onChange` →
   * `noteHelperChange`). Esta é a aresta de volta: o ■ do dono e o despertador
   * de boot precisam PERGUNTAR ao motor. Uma dep de construtor exigiria inverter
   * a ordem de nascimento dos dois.
   *
   * Ausente, tudo continua funcionando com uma coisa a menos: o ■ interrompe só
   * o turno e a conversa abre sem o aviso dos parados.
   */
  attachHelpers(controls: GuiSessionHelperControls): void {
    this.helpers = controls
  }

  /**
   * A OUTRA ARESTA DE VOLTA (rodada 9): o motor de missões precisa saber quando
   * uma conversa ABRE de verdade, para re-derivar do ticket um ⇪ que ficou
   * esperando (o dono clicou com o chat fechado, ou o app foi reiniciado).
   *
   * Amarrado depois do nascimento pelo mesmo motivo do `attachHelpers`: este
   * módulo nunca importa fila, git nem Electron — é o que mantém a suíte de
   * sessões rodando em node puro.
   */
  attachIntegration(controls: GuiSessionIntegrationControls): void {
    this.integration = controls
  }

  /**
   * O DESPERTADOR DE BOOT (R6.1, cauda): a conversa reabriu e o motor guarda
   * ajudantes PARADOS deste pane. O aviso entra no pote de sempre — o mesmo do
   * correio —, então ele sai pelo primeiro caminho de entrega que passar e nunca
   * duas vezes.
   *
   * Só em ABERTURA de verdade (nunca num respawn): quem troca o modo de
   * permissão ou remonta a aba está na mesma conversa, e repetir o aviso ali
   * seria o app cutucando o dono a cada clique.
   */
  private announceInterruptedHelpers(paneId: string, projectId: string): void {
    const controls = this.helpers
    if (!controls) return
    let parados: GuiHelperInterruptedInput[] = []
    try {
      parados = controls
        .status(paneId)
        .filter((snapshot) => snapshot.state === 'interrupted')
        .map((snapshot) => ({
          helperId: snapshot.helperId,
          ...(snapshot.name ? { name: snapshot.name } : {}),
          model: snapshot.model,
          ...(snapshot.resultPath ? { resultPath: snapshot.resultPath } : {}),
          elapsedMs: snapshot.elapsedMs
        }))
    } catch {
      // Fotografia indisponível nunca pode impedir a conversa de abrir.
      return
    }
    if (parados.length === 0) return
    const posted = this.helperCards.noteInterrupted(paneId, parados)
    if (posted > 0) {
      this.deps.record?.('gui-helper-boot-interrupted', { paneId, projectId }, { helpers: posted })
    }
  }

  /**
   * O DESPERTADOR: a frota encerrou e o delegador tem de saber.
   *
   * Caso real do dono (18/08): um chat abriu cinco ajudantes, anunciou "cinco
   * abertos e trabalhando" e ENCERROU O TURNO. Os cinco entregaram e o chat
   * ficou mudo — o agente não tinha como saber (nunca chamou `helper_result`) e
   * o dono ficou olhando uma conversa parada com o trabalho pronto do outro
   * lado. Um agente parado não tem como se acordar; quem acorda é o app.
   *
   * PELOS BASTIDORES (rodada 7, A1), e não mais pelo `send`. Ele nascia como
   * `user-message` — bolha "VOCÊ" no fio com texto de máquina —, e o dono viu
   * isso no teste ao vivo de 18/08: "avisar por trás dos panos, sem ser via
   * chat". O estímulo não precisa de bolha porque o que ele produz É visível: o
   * agente abre o turno e conta ao dono o que voltou, e a lateral já mostrou os
   * cards encerrando. Mesmo caminho do recibo de plano — `deliverBackstage`.
   *
   * As guardas de trânsito continuam todas de pé: turno vivo nunca se
   * interrompe, e a mensagem da fila / a troca de executor em voo seguram o
   * aviso pelo `paneBusyReason` (o que o `send` fazia por dentro).
   *
   * `true` = entregue ou definitivamente descartado; `false` = recusa
   * transitória, o correlacionador tenta de novo na batida seguinte.
   */
  private wakeDelegator(paneId: string, wake: GuiHelperWake): boolean {
    const entry = this.panes.get(paneId)
    // Sem conversa viva não há quem acordar. Descartar (e não segurar) é o que
    // impede o relógio de bater para sempre contra um pane morto.
    if (!entry || !entry.session.alive) return true
    if (entry.session.turnActive) return false
    const busy = this.paneBusyReason(paneId, entry)
    const sent: GuiResult = busy
      ? { ok: false, error: busy }
      : this.deliverBackstage(paneId, wake.text, 'aviso dos ajudantes')
    this.deps.record?.(
      sent.ok ? 'gui-helper-wake' : 'gui-helper-wake-held',
      { paneId, projectId: entry.spawn.projectId },
      {
        helpers: wake.helperIds.length,
        done: wake.done,
        failed: wake.failed,
        stillWorking: wake.stillWorking,
        // QUAL caminho de entrega rodou. Sem esta marca, um diário de antes da
        // rodada 7 (quando o aviso virava bolha do dono) e um de depois ficam
        // idênticos — e é justamente isso que uma sessão futura vai querer
        // distinguir ao ler um wake antigo.
        silent: true,
        ...(sent.ok ? {} : { err: sent.error })
      }
    )
    return sent.ok
  }

  /**
   * O ■ DO DONO — ATÔMICO (R6.3), e as três partes são uma decisão só:
   *
   *  1. o TURNO do CLI para (o que o botão sempre fez);
   *  2. a FROTA deste chat para PRESERVANDO — `interrupted`, não `cancelled`:
   *     "para agora" nunca quis dizer "joga fora", e cada ajudante volta com
   *     helper_resume;
   *  3. as pendências de DESPERTADOR do pane são descartadas — o caso real que
   *     originou este item foi o app abrindo um turno novo por cima da
   *     interrupção que o dono acabara de fazer.
   *
   * A ORDEM importa: o turno primeiro (é o que o dono está vendo), a frota
   * depois, e o silêncio por último — assim um encerramento que caia no meio do
   * caminho também é engolido, em vez de acordar a conversa logo em seguida.
   *
   * Sem turno ativo o ■ ainda vale: o dono pode ter apertado justamente para
   * parar a frota, e recusar aqui deixaria os ajudantes rodando.
   */
  interrupt(paneId: string): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    const turnStopped = entry.session.interrupt()
    const helpers = this.helpers?.interruptPane(paneId, GUI_HELPER_OWNER_INTERRUPTION) ?? 0
    const wakes = this.helperCards.discardPending(paneId)
    this.deps.record?.(
      'gui-interrupt',
      { paneId, projectId: entry.spawn.projectId },
      { turn: turnStopped, helpers, wakes }
    )
    if (!turnStopped && helpers === 0)
      return { ok: false, error: 'não há turno ativo para interromper' }
    return { ok: true }
  }

  /**
   * A interface confirma apenas QUAL seq terminou de aparecer. O tipo do
   * alerta nunca vem do renderer: ele permanece retido no sequenciador que
   * observou o resultado real do CLI.
   */
  presented(paneId: string, terminalSeq: number): GuiResult {
    if (!Number.isSafeInteger(terminalSeq) || terminalSeq <= 0)
      return { ok: false, error: 'confirmação visual inválida' }
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    const kind = entry.alerts.presented(terminalSeq)
    if (kind) {
      try {
        this.deps.onChatAlert?.({ paneId, projectId: entry.spawn.projectId, kind })
      } catch {
        // Aviso auxiliar nunca pode derrubar ou alterar o turno concluído.
      }
    }
    return { ok: true }
  }

  kill(paneId: string): GuiResult {
    if (!this.panes.has(paneId)) return { ok: true }
    this.dispose(paneId, 'kill')
    return { ok: true }
  }

  /**
   * Encerra em bloco os panes cujo id casa com o predicado — o caso real é a
   * missão 2.0 (dev, reviewer e ajudantes compartilham o worktree, e quando
   * ele some no merge TODOS têm de sair antes). Devolve quantos morreram.
   */
  killWhere(match: (paneId: string) => boolean): number {
    let killed = 0
    for (const paneId of [...this.panes.keys()]) {
      if (!match(paneId)) continue
      this.dispose(paneId, 'kill-batch')
      killed += 1
    }
    return killed
  }

  /**
   * Esquecimento definitivo, usado somente depois que o domínio dono excluiu
   * a missão/projeto. Arquivar chama apenas `killWhere`: identidade e fio
   * continuam gravados para a reativação.
   */
  forgetWhere(match: (paneId: string, record?: GuiSessionRecord) => boolean): number {
    const transcriptKeys = Object.keys(this.doc.transcripts ?? {})
    const paneIds = new Set([...Object.keys(this.doc.panes), ...transcriptKeys])
    let forgotten = 0
    for (const paneId of paneIds) {
      if (!match(paneId, this.doc.panes[paneId])) continue
      delete this.doc.panes[paneId]
      if (this.doc.transcripts) delete this.doc.transcripts[paneId]
      forgotten += 1
    }
    if (forgotten === 0 || !this.deps.storeFile) return forgotten
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // O domínio já concluiu a exclusão. Mantemos o documento em memória
      // limpo e não transformamos lixo de conveniência em falha da operação.
    }
    return forgotten
  }

  /** Replay da remontagem: o que o pane perdeu enquanto estava desmontado. */
  state(paneId: string): GuiStatePayload {
    const entry = this.panes.get(paneId)
    if (!entry) {
      const ring = this.restoreTranscript(paneId)
      if (!ring) return { events: [], cursor: 0, exists: false, alive: false }
      return {
        events: ring.sequencedSnapshot(),
        cursor: ring.cursor,
        exists: true,
        alive: false
      }
    }
    return {
      events: entry.ring.sequencedSnapshot(),
      cursor: entry.ring.cursor,
      exists: true,
      alive: entry.session.alive
    }
  }

  /** Encerramento do app: nenhum CLI filho sobrevive ao quit. */
  killAll(): void {
    for (const paneId of [...this.panes.keys()]) this.dispose(paneId, 'quit')
  }

  // ————— internos —————

  /**
   * RESPAWN QUE PRESERVA A CONVERSA. Trocar o modo de permissão (ou qualquer
   * campo do fingerprint) mata o processo e abre outro; a conversa mora no
   * disco do CLI e se retoma por id. Quem tem o id mais fresco é o documento
   * (o `remember` grava a cada `init`/`session-id`), então ele vem primeiro.
   * Conversa retomada JÁ tem o briefing: o firstPrompt cai junto — repeti-lo
   * seria re-briefing perseguindo o pane (lição da F6.8i).
   */
  private inheritConversation(spawn: GuiPaneSpawn, previous: GuiPaneEntry): GuiPaneSpawn {
    const inherited = inheritedResumeSessionId(spawn, this.doc.panes[spawn.paneId], previous.spawn)
    if (!inherited || inherited === spawn.resumeSessionId) return spawn
    return { ...spawn, resumeSessionId: inherited, firstPrompt: undefined }
  }

  private spawnSession(spawn: GuiPaneSpawn, sink: (evt: SessionEvent) => void): GuiBackend {
    const persona = spawn.systemPrompt?.trim() ?? ''
    const permissions = guiPermissionProfile(spawn.cli, spawn.permissionMode)
    const opts = {
      cwd: spawn.cwd,
      configDir: spawn.configDir || undefined,
      model: spawn.model,
      effort: spawn.effort,
      // Modo de permissão DESTA conversa, na chave que cada CLI entende.
      ...permissions,
      // Ferramentas Synkora deste pane (só o planejamento tem — guiPlannerMcp).
      ...(spawn.mcp ? { extraArgs: spawn.mcp.args, extraEnv: spawn.mcp.env } : {}),
      // R11 — FAST é configuração de PROCESSO nos dois CLIs (sonda probe-fast):
      // claude nasce ON com o opt-in --settings fastMode (e ligar troca o
      // modelo para Opus 5 — comportamento do binário); codex é o service tier
      // 'priority' do thread/turn. Trocar = respawn com resume, o caminho do
      // permissionMode — e é por isso que `fast` entra no fingerprint.
      ...(spawn.fast ? (spawn.cli === 'codex' ? { serviceTier: 'priority' as const } : { fastMode: true }) : {}),
      // Chat aberto não morre por tédio (contrato do pane GUI).
      idleTimeoutMs: 0
    }
    if (spawn.cli === 'codex') {
      // O id do thread é gravado com prefixo próprio pelo evento session-id —
      // o thread/resume quer o uuid cru.
      const threadId = spawn.resumeSessionId?.startsWith('codex-thread:')
        ? spawn.resumeSessionId.slice('codex-thread:'.length)
        : spawn.resumeSessionId
      return new CodexSession(
        {
          ...opts,
          resumeSessionId: threadId,
          // CERCA ANTI-SUBAGENTE-NATIVO por THREAD (D5/S2). Ela ACOMPANHA o
          // cinto que já viaja nos args: os dois lados da mesma cerca nascem e
          // morrem juntos, e a derivação é estável entre respawns porque o
          // re-arme reproduz os MESMOS args (e eles já entram no fingerprint).
          ...(guiSpawnSuppressesNativeAgents(spawn) ? { suppressNativeAgents: true } : {})
        },
        persona,
        sink
      )
    }
    // claude: persona ao nível de SISTEMA e por arquivo (teto de argv).
    const file = persona
      ? this.deps.systemPromptFile(`gui-${spawn.paneId}.system.md`, persona)
      : undefined
    return new MaestroSession(
      { ...opts, resumeSessionId: spawn.resumeSessionId, systemPromptFile: file },
      sink
    )
  }

  /** /clear (e /new do Codex) é uma troca deliberada de conversa. O cursor
   *  segue monotônico para o listener já montado, mas o fio e o resume antigos
   *  saem juntos antes de o processo novo nascer. */
  private clearConversation(entry: GuiPaneEntry): GuiResult {
    const paneId = entry.spawn.paneId
    const spawn: GuiPaneSpawn = {
      ...entry.spawn,
      resumeSessionId: undefined,
      firstPrompt: undefined
    }
    const previous = this.doc.panes[paneId]
    if (previous) {
      this.doc.panes[paneId] = {
        ...guiSessionWithoutResume(previous),
        updatedAt: new Date().toISOString()
      }
    }
    entry.flushPendingTerminal?.()
    entry.ring.clear(true)
    // O checkpoint grava numa única fotografia o fio vazio E a identidade sem
    // sessionId. Ao vivo, o mesmo marco remove o /clear otimista do composer.
    entry.sink({ type: 'conversation-cleared' })
    this.dispose(paneId, 'clear')
    return this.create(spawn)
  }

  private dispose(paneId: string, reason: string, preserveRing = false): void {
    const entry = this.panes.get(paneId)
    if (!entry) return
    // Última barreira antes de apagar a geração: inclui deltas parciais que
    // ainda não tinham alcançado um checkpoint semântico.
    entry.flushPendingTerminal?.()
    this.saveTranscript(paneId, entry.ring)
    this.panes.delete(paneId)
    entry.token.alive = false
    // A correlação morre com a geração: o anel é a memória durável dos cards, e
    // um envelope da conversa anterior nunca pode parear um lote da próxima.
    this.helperCards.forgetPane(paneId)
    try {
      this.deps.onPaneDisposed?.({ paneId, projectId: entry.spawn.projectId, reason })
    } catch {
      // Limpeza visual auxiliar nunca pode impedir o encerramento do processo.
    }
    if (!preserveRing) entry.ring.clear()
    try {
      entry.session.kill()
    } catch {
      // processo já morto — encerrar nunca derruba o app
    }
    this.deps.record?.(
      'gui-session-closed',
      { paneId, projectId: entry.spawn.projectId },
      { reason }
    )
  }

  /** Reconstrói um anel NOVO: quem chamar pode continuar incrementando seq sem
   *  compartilhar referências com o documento carregado do disco. */
  private restoreTranscript(paneId: string): GuiEventRing | null {
    const transcript = this.doc.transcripts?.[paneId]
    if (!transcript) return null
    const events = transcript.events.filter(isGuiPersistedEvent)
    if (events.length === 0) return null
    // A fotografia não guarda cada seq (só a barreira terminal), mas o cursor
    // permite recolocar a janela no mesmo intervalo e manter o próximo evento
    // estritamente posterior para quem já está ouvindo o pane.
    const initialCursor = Math.max(0, transcript.cursor - events.length)
    const ring = new GuiEventRing(GUI_RING_CAP, GUI_RING_BYTE_CAP, initialCursor)
    for (const event of events) ring.push(event)
    return ring.size > 0 ? ring : null
  }

  /** Persiste somente a fotografia limitada do anel. `cursor` evita regravar
   *  a mesma fotografia no checkpoint terminal e logo depois no dispose. */
  private saveTranscript(paneId: string, ring: GuiEventRing): void {
    if (ring.size === 0) return
    if (this.savedTranscriptCursors.get(ring) === ring.cursor) return
    const transcripts = (this.doc.transcripts ??= {})
    transcripts[paneId] = {
      events: ring.snapshot(),
      cursor: ring.cursor,
      updatedAt: new Date().toISOString()
    }
    pruneGuiTranscripts(transcripts, paneId)
    if (!this.deps.storeFile) {
      this.savedTranscriptCursors.set(ring, ring.cursor)
      return
    }
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
      this.savedTranscriptCursors.set(ring, ring.cursor)
    } catch {
      // Histórico em memória continua válido; o próximo checkpoint tenta de novo.
    }
  }

  private hasQueuedDeliveryReceipt(paneId: string, messageId: string): boolean {
    return validQueuedDeliveryReceipts(this.doc.panes[paneId]).some(
      (receipt) => receipt.id === messageId
    )
  }

  private rememberQueuedDeliveryReceipt(paneId: string, messageId: string): void {
    const previous = this.doc.panes[paneId]
    if (!previous) return
    const receipts = validQueuedDeliveryReceipts(previous).filter(
      (receipt) => receipt.id !== messageId
    )
    receipts.push({ id: messageId, deliveredAt: new Date().toISOString() })
    this.doc.panes[paneId] = {
      ...previous,
      updatedAt: new Date().toISOString(),
      queuedDeliveryReceipts: receipts.slice(-GUI_QUEUED_RECEIPT_CAP)
    }
    this.panes.get(paneId)?.messageIds?.add(messageId)
    if (!this.deps.storeFile) return
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // O Set vivo ainda impede repetição nesta execução. Se o disco voltar,
      // o próximo checkpoint/recibo tenta persistir novamente.
    }
  }

  /** Persiste somente a fotografia canônica do contexto vivo. Não aceita
   * valores de outro pane/generation e remove a foto quando o backend
   * explicitamente invalida a medição (compactação/clear). */
  private rememberContextUsage(
    paneId: string,
    snapshot: GuiContextUsageSnapshot | undefined
  ): void {
    const previous = this.doc.panes[paneId]
    if (!previous || !previous.sessionId) return
    const next = { ...previous }
    if (
      !snapshot ||
      (snapshot.contextTokens === null && snapshot.contextWindow === null)
    ) {
      delete next.contextTokens
      delete next.contextWindow
      delete next.contextSessionId
    } else {
      // Uma init nova pode anunciar só a janela. Não grave `null` como se
      // fosse uma medição: o token só entra quando context-usage/result o
      // fornecer de forma canônica.
      if (snapshot.contextTokens === null && previous.contextTokens === undefined)
        delete next.contextTokens
      else next.contextTokens = snapshot.contextTokens
      next.contextWindow = snapshot.contextWindow
      next.contextSessionId = previous.sessionId
    }
    if (
      previous.contextTokens === next.contextTokens &&
      previous.contextWindow === next.contextWindow &&
      previous.contextSessionId === next.contextSessionId
    )
      return
    next.updatedAt = new Date().toISOString()
    this.doc.panes[paneId] = next
    if (!this.deps.storeFile) return
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // A fotografia viva continua correta em memória; o próximo checkpoint
      // tenta persisti-la de novo.
    }
  }

  /**
   * Grava conversa + modo + modelo/effort do pane (nunca apaga no kill:
   * retomar é decisão de quem reabre). `sessionId` ausente = só a escolha
   * mudou — é o caminho do create, que carimba a escolha do dono antes de o
   * CLI anunciar a conversa. Modelo/effort seguem a régua do permissionMode:
   * cada create regrava a última escolha, e reabrir cai nela.
   */
  private remember(
    spawn: GuiPaneSpawn,
    sessionId?: string,
    executor?: { model: string | null; effort: string | null }
  ): void {
    const previous = this.doc.panes[spawn.paneId]
    const mode = spawn.permissionMode ?? 'default'
    // Sessão do CLI ANTERIOR não vale para o CLI de agora (trocar a conta do
    // universo/da missão para outro binário zera o id, nunca o herda).
    const kept = previous?.cli === spawn.cli ? previous.sessionId : undefined
    const nextSession = sessionId || kept
    const sameIdentity = previous?.cli === spawn.cli && previous.projectId === spawn.projectId
    const queuedDeliveryReceipts = validQueuedDeliveryReceipts(previous)
    const rememberedContext =
      sameIdentity && Boolean(previous?.sessionId) && previous?.sessionId === nextSession
        ? guiContextSnapshotFromRecord(previous)
        : undefined
    const rememberedModel = executor
      ? executor.model
      : spawn.model !== undefined
        ? spawn.model
        : sameIdentity && Object.prototype.hasOwnProperty.call(previous, 'model')
          ? previous.model
          : undefined
    const rememberedEffort = executor
      ? executor.effort
      : spawn.effort !== undefined
        ? spawn.effort
        : sameIdentity && Object.prototype.hasOwnProperty.call(previous, 'effort')
          ? previous.effort
          : undefined
    // O PINO DOS AJUDANTES ATRAVESSA (D8). Este método REESCREVE o record
    // inteiro, e todo respawn passa por aqui — trocar o modo de permissão ou
    // dar `/clear` apagaria a escolha do dono sem nenhum sinal. Ele viaja mesmo
    // com o CLI trocado: o pino pode ser do outro binário de propósito.
    const delegation = guiDelegationDefaultsOf(previous)
    if (
      previous?.cli === spawn.cli &&
      previous.sessionId === nextSession &&
      previous.permissionMode === mode &&
      previous.model === rememberedModel &&
      previous.effort === rememberedEffort
    )
      return
    this.doc.panes[spawn.paneId] = {
      ...(nextSession ? { sessionId: nextSession } : {}),
      cli: spawn.cli,
      projectId: spawn.projectId,
      updatedAt: new Date().toISOString(),
      permissionMode: mode,
      ...(rememberedModel !== undefined ? { model: rememberedModel } : {}),
      ...(rememberedEffort !== undefined ? { effort: rememberedEffort } : {}),
      ...(delegation.model ? { delegateModel: delegation.model } : {}),
      ...(delegation.effort ? { delegateEffort: delegation.effort } : {}),
      ...(delegation.fast ? { delegateFast: true } : {}),
      ...(rememberedContext
        ? {
            contextTokens: rememberedContext.contextTokens,
            contextWindow: rememberedContext.contextWindow,
            ...(previous?.contextSessionId || nextSession
              ? { contextSessionId: previous?.contextSessionId ?? nextSession }
              : {})
          }
        : {}),
      ...(queuedDeliveryReceipts.length > 0 ? { queuedDeliveryReceipts } : {})
    }
    if (!this.deps.storeFile) return
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // O resume é conveniência; falha de disco não derruba a conversa viva.
    }
  }
}

/**
 * Qual conversa o RESPAWN retoma (pura, exportada para teste). O caso que ela
 * existe para resolver: o dono troca o modo de permissão no meio do trabalho,
 * o fingerprint muda, o processo é substituído — e sem herdar o id a conversa
 * nasceria em branco. Ordem: o que o chamador pediu > o documento (id mais
 * fresco, gravado a cada `init`/`session-id`) > o spawn anterior. Sempre no
 * MESMO CLI: sessão do claude não se retoma no codex e vice-versa.
 */
export function inheritedResumeSessionId(
  next: Pick<GuiPaneSpawn, 'cli' | 'resumeSessionId'>,
  remembered: Pick<GuiSessionRecord, 'cli' | 'sessionId'> | undefined,
  previous: Pick<GuiPaneSpawn, 'cli' | 'resumeSessionId'> | undefined
): string | undefined {
  if (next.resumeSessionId) return next.resumeSessionId
  if (remembered?.cli === next.cli && remembered.sessionId) return remembered.sessionId
  if (previous?.cli === next.cli && previous.resumeSessionId) return previous.resumeSessionId
  return undefined
}

// ————— comandos slash no chat (2.0) — helpers PUROS, exportados para teste —————

/** O cardápio que o codex atende no chat (cada um vira o RPC real no
 *  runSlash) — mora aqui para a resposta de comando desconhecido nunca mentir
 *  sobre o que existe. */
export const CODEX_GUI_SLASH_COMMANDS =
  '/status /usage /compact /review /diff /init /permissions /rename /goal /mcp /skills /fast'

/** Primeiro token do comando ('/model opus' → '/model'). */
export function slashCommandName(text: string): string {
  return text.trim().split(/\s+/)[0] ?? ''
}

export function codexUnknownSlashReply(cmd: string): string {
  return `o codex não tem ${cmd} — comandos: ${CODEX_GUI_SLASH_COMMANDS}`
}

/** Decisão PURA do roteamento claude: o que o registry intercepta antes de o
 *  texto chegar ao CLI. 'raw' = o CLI executa sozinho (modo SDK interpreta
 *  comandos crus — /usage, /compact, skills…). Prefixo NUNCA casa: '/modelx'
 *  é comando do CLI, não nosso. */
export type GuiClaudeSlashRoute =
  | { kind: 'model-set'; model: string }
  | { kind: 'model-list' }
  | { kind: 'fast' }
  | { kind: 'raw' }

export function routeClaudeSlash(trimmed: string): GuiClaudeSlashRoute {
  const cmd = slashCommandName(trimmed)
  if (cmd === '/model') {
    const arg = trimmed.trim().slice(cmd.length).trim()
    return arg ? { kind: 'model-set', model: arg } : { kind: 'model-list' }
  }
  if (cmd === '/fast') return { kind: 'fast' }
  return { kind: 'raw' }
}

/**
 * O CINTO da cerca anti-subagente-nativo do codex, como ele viaja na linha de
 * comando do `app-server` (sonda probe-codex-fence §A.2: `-c` sem espaço, que
 * é o único formato que sobrevive ao `shell: true` do Windows).
 */
export const CODEX_NATIVE_AGENT_FENCE_ARG = 'features.multi_agent=false'

const CODEX_NATIVE_AGENT_FENCE_RE = /(^|\s)features\.multi_agent\s*=\s*false(\s|$)/u

/**
 * O SUSPENSÓRIO segue o CINTO: o thread nasce cercado (`suppressNativeAgents`)
 * exatamente quando o processo nasceu cercado.
 *
 * Por que DERIVAR em vez de carregar um campo próprio no spawn: o `GuiPaneSpawn`
 * atravessa o renderer e cada campo dele tem de ser repetido à mão em quatro
 * listas (o espelho do guiApi, as props do GuiPane, os dois literais do spawnRef
 * e o JSX do Board) — foi o silêncio dessas listas que deixou o planejador sem
 * ferramenta por uma noite inteira. Derivar dos args que o próprio MCP de
 * delegação já monta é estável entre respawns (o re-arme reproduz os mesmos
 * args) e JÁ ENTRA NO FINGERPRINT, porque ele soma `spawn.mcp.args`.
 *
 * O acoplamento é declarado: quem montar os args da delegação do codex sem o
 * `-c features.multi_agent=false` desliga as DUAS camadas ao mesmo tempo, nunca
 * uma sem a outra — e o rastreio do spawn nativo (guiCodexAgents) continua vivo
 * de propósito, para o dono ver o subagente em vez de ficar cego.
 */
export function guiSpawnSuppressesNativeAgents(spawn: GuiPaneSpawn): boolean {
  if (spawn.cli !== 'codex') return false
  return (spawn.mcp?.args ?? []).some((arg) => CODEX_NATIVE_AGENT_FENCE_RE.test(arg))
}

/** Identidade do spawn: o que só muda com processo novo. Exportada para teste
 *  — é ela que decide respawn, e a troca de modo TEM de cair nesse caminho. */
export function spawnFingerprint(spawn: GuiPaneSpawn): string {
  return [
    spawn.cli,
    spawn.cwd,
    spawn.configDir,
    spawn.model ?? '',
    spawn.effort ?? '',
    spawn.resumeSessionId ?? '',
    // Trocar o modo TEM de respawnar: as flags moram no SPAWN do processo
    // (--permission-mode do claude, sandbox do thread/start do codex) e
    // nenhum dos dois binários troca isso na conversa em andamento.
    spawn.permissionMode ?? 'default',
    // R11: fast é flag de processo nos dois CLIs — trocar exige respawn (e o
    // cache-break do fastModeChanged é inerente, não um custo extra do respawn).
    spawn.fast ? 'fast' : '',
    // As flags de MCP moram na linha de comando do processo: armar o servidor
    // numa conversa viva exige respawn (o resume preserva o contexto).
    (spawn.mcp?.args ?? []).join(' '),
    spawn.systemPrompt ?? ''
  ].join('\0')
}

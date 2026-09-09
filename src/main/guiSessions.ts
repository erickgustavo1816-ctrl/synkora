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
import { createHash, randomUUID } from 'node:crypto'
import { CodexSession } from './codexSession'
import { codexAsyncQuestionAnswer } from './codexAsyncQuestions'
import {
  GUI_NEW_CONVERSATION_NOTE,
  GUI_NEW_CONVERSATION_USAGE,
  routeGuiConversationCommand,
  withGuiConversationCommands
} from './guiConversationCommands'
import { MaestroSession, type SessionEvent } from './maestroSession'
import { GuiProgressTracker, type GuiProgressInput, type GuiProgressHelpers } from './guiProgress'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import { limitGuiToolInput } from './guiToolInput'
import { GuiAlertSequencer, type GuiNoticeKind } from './guiNotices'
import { GuiIntegrationReply, pendingIntegrationTool } from './guiIntegrationReply'
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
import {
  GuiOwnerMailbox,
  guiOwnerForceText,
  guiOwnerHandText,
  guiOwnerMailFlushText,
  guiOwnerMailbox
} from './guiOwnerMail'
import { GuiOwnerReplyDebt, guiOwnerReplyDebt } from './guiOwnerReplyDebt'
import { guiOwnerDebtHookSettings } from './guiOwnerDebtHook'
import {
  GuiOwnerStepTracker,
  guiOwnerMessageStateEvent,
  ownerSteerPlan,
  type GuiOwnerMessageState,
  type GuiOwnerPendingInteraction,
  type GuiOwnerReadSignal,
  type GuiOwnerSteerPlan
} from './guiOwnerSteer'
import {
  guiAddApiCall,
  guiConversationWeightTokens,
  guiHeavyContextMilestone,
  guiHeavyConversationNote,
  isGuiConversationUsage,
  type GuiConversationUsage
} from './guiConversationOdometer'
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
  retryable?: boolean
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
 * Propostas de plano e perguntas async já devolveram a tool ao CLI. Continuam
 * esperando o dono depois do turno; perguntas RPC morrem quando ele termina.
 */
function guiSurvivesTurnEnd(evt: unknown): boolean {
  const event = guiEventRecord(evt)
  return event?.['type'] === 'plan-proposal' ||
    (event?.['type'] === 'question' && event['asynchronous'] === true)
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

/** R25.1 — o odômetro que viaja no `context-usage`. Documento adulterado nunca
 *  injeta um total inventado no medidor do dono. */
function guiOptionalOdometerCount(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
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
      (item['id'] !== undefined && (typeof item['id'] !== 'string' || !item['id'] || item['id'].length > 256)) ||
      (item['allowCustom'] !== undefined && typeof item['allowCustom'] !== 'boolean') ||
      (item['multiSelect'] !== undefined && typeof item['multiSelect'] !== 'boolean') ||
      !Array.isArray(item['options']) ||
      (item['options'].length === 0 && item['allowCustom'] !== true) ||
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
  if (resolution['kind'] !== 'question' || !Array.isArray(resolution['entries']) ||
    (resolution['messageId'] !== undefined && guiMessageIdProblem(resolution['messageId']) !== null)) return false
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
      return guiRequestId(event['requestId']) && guiPersistedQuestions(event['questions']) &&
        (event['blocking'] === undefined || typeof event['blocking'] === 'boolean') &&
        (event['asynchronous'] === undefined || typeof event['asynchronous'] === 'boolean') &&
        (event['asynchronous'] !== true || event['blocking'] === false)
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
        guiNullableContextWindow(event['contextWindow']) &&
        guiOptionalOdometerCount(event['convCalls']) &&
        guiOptionalOdometerCount(event['convWeightTokens'])
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
    case 'session-id':
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
 * A PODA FALA (R24.1) — ESPELHO DECLARADO main↔renderer.
 *
 * O par deste evento mora em `src/renderer/src/guiApi.ts` (união
 * `GuiSessionEvent`, kind `history-pruned`) e o redutor em `store.ts`. Ele NÃO
 * é um `SessionEvent` de backend: nasce aqui, no registro, e nunca entra no
 * anel — senão a fotografia persistida guardaria a notícia e o replay a
 * duplicaria. Quem o publica é `state()` (na remontagem) e `publish()` (uma
 * vez, na primeira poda ao vivo).
 */
export interface GuiHistoryPrunedEvent {
  type: 'history-pruned'
  /** Quantos eventos o anel já descartou nesta conversa. Sempre > 0. */
  evicted: number
}

export function guiHistoryPrunedEvent(evicted: number): GuiHistoryPrunedEvent {
  return { type: 'history-pruned', evicted }
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
  /** R24.1 — quantos eventos a poda já descartou NESTA conversa. O anel
   *  degradava em silêncio desde 2026-08-15: o fio remontado nascia cortado e
   *  nada dizia que houve mais antes. */
  private evicted = 0
  private readonly cap: number
  private readonly byteCap: number

  constructor(
    cap: number = GUI_RING_CAP,
    byteCap: number = GUI_RING_BYTE_CAP,
    initialCursor = 0,
    initialEvicted = 0
  ) {
    this.cap = cap > 0 ? cap : GUI_RING_CAP
    this.byteCap = byteCap > 0 ? byteCap : GUI_RING_BYTE_CAP
    this.nextSeq = Number.isSafeInteger(initialCursor) && initialCursor > 0 ? initialCursor : 0
    this.evicted =
      Number.isSafeInteger(initialEvicted) && initialEvicted > 0 ? initialEvicted : 0
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
      if (stickyKey === 'session-id' && previous &&
        guiEventRecord(previous.evt)?.['sessionId'] !== event?.['sessionId']) {
        // Resume que caiu numa thread nova não herda escolhas da anterior.
        for (const [requestId, pending] of this.interactions) {
          const question = guiEventRecord(pending.evt)
          if (question?.['type'] !== 'question' || question['asynchronous'] !== true) continue
          this.interactions.delete(requestId)
          this.interactionBytes -= pending.size
        }
      }
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
      // RPC já encerrado morre com o turno; proposta e pergunta async esperam
      // uma mensagem futura e continuam respondíveis depois dele.
      for (const [requestId, item] of this.interactions) {
        if (guiSurvivesTurnEnd(item.evt)) continue
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
      if (removed) {
        this.bytes -= removed.size
        this.evicted += 1
      }
    }
  }

  get size(): number {
    return this.items.length + this.sticky.size + this.interactions.size
  }

  /** Total descartado pela poda na vida desta conversa. `0` = o fio na tela
   *  começa onde a conversa começou. */
  get evictedCount(): number {
    return this.evicted
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
    // A conversa é OUTRA (é isso que o /clear significa): a poda da anterior
    // não pode continuar dizendo que o começo desta saiu da tela.
    this.evicted = 0
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
   * A CONTA carimbada (2026-09-08, a aba "ajudantes ˄": a sequência do dono é
   * conta › modelo › effort › fast). Id de seat; ausente = a conta segue o
   * modelo, como sempre (mesmo CLI = a do delegador; cruzado = a primeira
   * logada). Limpar REMOVE o campo, como nos irmãos.
   */
  delegateSeat?: string
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
  /**
   * R25.1 — O ODÔMETRO DA CONVERSA (chamadas + parcelas somadas). Vive no
   * DOCUMENTO, e não no renderer, por dois motivos: o renderer remonta a cada
   * troca de aba, e o motor morre a cada respawn. Ele viaja pela MESMA régua da
   * fotografia de contexto — continua no respawn-com-resume (mesma conversa) e
   * sai junto com o resume no `/clear`/troca de identidade.
   */
  conversationUsage?: GuiConversationUsage
  /**
   * R25.3a — o último MARCO de conversa pesada já anunciado no fio. Persistido
   * porque o aviso é UM por marco: sem o carimbo, todo restart do app repetiria
   * a mesma nota. Ele DESCE quando o contexto desce (compactação), e é isso que
   * re-arma o aviso para uma conversa que voltou a engordar.
   */
  heavyContextMilestone?: number
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
  /** id da conta (seat) com que os ajudantes abrem; ausente = a conta segue o
   *  modelo (regra de sempre do motor) */
  seat?: string
  model?: string
  effort?: string
  /** R12 — o dono carimbou ⚡ para a frota inteira. Só `true` existe. */
  fast?: boolean
}

/** `null` LIMPA o campo; campo ausente CONSERVA o que já está gravado (mesma
 *  gramática do `GuiExecutorPatch`, para o renderer não precisar de duas).
 *  No `fast`, `false` limpa junto com `null`: desligar é a mesma ordem. */
export interface GuiDelegationDefaultsPatch {
  seat?: string | null
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
  const seat = clean(record?.delegateSeat)
  const model = clean(record?.delegateModel)
  const effort = clean(record?.delegateEffort)
  // `true` LITERAL, nada de coerção: um `"sim"` ou `1` de documento sujo ligaria
  // a frota inteira num modo que gasta mais limite sem o dono ter pedido.
  const fast = record?.delegateFast === true
  return {
    ...(seat ? { seat } : {}),
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
  // R25.1 — o odômetro é DA CONVERSA: sem endereço de resume não existe mais a
  // conversa que ele media, e o marco já anunciado se re-arma com ela.
  delete next.conversationUsage
  delete next.heavyContextMilestone
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
  /** R24.1 — eventos que a poda descartou antes desta fotografia. Ausente =
   *  gravado antes do contrato novo (ou nada foi descartado): o fio remontado
   *  não afirma nada, que é a verdade que ele tem. */
  evicted?: number
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
    // O teto de hidratação também é poda: o que ele corta aqui soma ao que o
    // anel já tinha descartado, senão o fio voltaria do disco dizendo que
    // começa no começo.
    const persistedEvicted = record['evicted']
    const evicted =
      (Number.isSafeInteger(persistedEvicted) && (persistedEvicted as number) > 0
        ? (persistedEvicted as number)
        : 0) +
      (record['events'].length - events.length)
    transcripts[paneId] = {
      events,
      cursor: record['cursor'] as number,
      updatedAt: record['updatedAt'],
      ...(evicted > 0 ? { evicted } : {})
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

// ————— A RECARGA DO CATÁLOGO DE SKILLS (Skills 3.0 — fatia 5.D) —————
//
// SONDADO em 2026-09-08 (`.synkora/reports/PROBE_SKILL_RELOAD_MIDTURN`): o
// `/reload-skills` mandado pelo stdin com o turno ABERTO não recarrega no turno
// corrente e NÃO se perde nem vira fala — o CLI o enfileira e o executa como um
// MINI-TURNO próprio logo depois do `result` do agente (`commands_changed` →
// `init` → `result` com "Reloaded skills: N skills available (1 added)").
//
// Daí saem as duas peças abaixo. A MARCA conta quantos `result` ainda são do
// AGENTE antes de o recibo chegar (1 quando o pedido sai com o turno aberto — o
// caso real, porque o `skill_pull` roda dentro de uma tool; 0 com a sessão
// ociosa, quando o CLI desenfileira na hora). O `result` que chega com o
// contador zerado é o RECIBO: ele NÃO é turno do agente, então não atravessa o
// anel como fim de turno (seria um segundo plim, um segundo fecho de pote e uma
// resposta que o dono não pediu) — ele vira uma NOTA no fio.
interface GuiSkillReloadMark {
  /** quantos `result` do AGENTE ainda vêm antes do recibo */
  pendingAgentResults: number
  at: number
}

/** Teto de espera pelo recibo. Um turno de agente pode passar de meia hora, e a
 *  marca precisa sobreviver a ele; o que ela NÃO pode é sobreviver ao dia e
 *  engolir o `result` de um turno futuro se o CLI nunca executar o comando. */
const GUI_SKILL_RELOAD_TTL_MS = 60 * 60 * 1_000

/** O slash cru que recarrega o catálogo nativo do claude. 0 token: o CLI o
 *  executa localmente (medido na sonda). */
const GUI_SKILL_RELOAD_COMMAND = '/reload-skills'

/** A linha que o DONO lê quando o recibo chega. `❖` é o marcador do harness (o
 *  mesmo das notas de pull/discard), para as três histórias ficarem juntas no
 *  fio. */
export function guiSkillReloadNote(text: string | undefined, isError: boolean): string {
  const detail = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''
  if (isError) {
    return `❖ o CLI não recarregou o catálogo de skills${detail ? ` — ${detail}` : ''} (a skill já está na pasta: o agente pode ler o SKILL.md com Read)`
  }
  return `❖ catálogo de skills recarregado${detail ? ` — ${detail}` : ''}`
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
  /** Structural progress changed; carries no conversation content. */
  onProgressChange?(): void
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
   * A DÍVIDA DE RESPOSTA (R32) — armada pela carona na delegação, QUITADA
   * aqui: o primeiro texto do assistente (ou o fecho do turno) paga. Ausente =
   * a de produção (`guiOwnerReplyDebt`), a MESMA que o guard das tools cobra.
   */
  replyDebt?: GuiOwnerReplyDebt
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
  /** Pure counts only; unavailable on older doubles, so metadata stays absent. */
  progressCounts?(paneId: string): GuiProgressHelpers
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
  private readonly progressTracker = new GuiProgressTracker()
  private readonly integrationReply = new GuiIntegrationReply()

  progress(): GuiProgressInput[] {
    return this.progressTracker.snapshot().map((pane) => {
      if (!this.helpers?.progressCounts) return pane
      return { ...pane, helpers: this.helpers.progressCounts(pane.paneId) }
    })
  }

  private notifyProgressChange(): void {
    try { this.deps.onProgressChange?.() } catch { /* Progress cannot interrupt a conversation. */ }
  }
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
  /** A DÍVIDA DE RESPOSTA (R32): o pump quita no primeiro texto do agente. */
  private readonly replyDebt: GuiOwnerReplyDebt
  /** R39 — O QUE O TURNO ESTAVA FAZENDO quando a fala do dono o parou (o passo
   *  que o envelope nomeia) e as bolhas entregues esperando o carimbo
   *  "respondida". Alimentado pelo pump; a régua da rota mora no mesmo módulo. */
  private readonly ownerSteer = new GuiOwnerStepTracker()
  /** O motor dos ajudantes, amarrado depois do nascimento (ver `attachHelpers`).
   *  Ausente = registro sem frota: o ■ para só o turno. */
  private helpers?: GuiSessionHelperControls
  /** O motor de missões (ver `attachIntegration`). Ausente = registro sem fila:
   *  abrir uma conversa não re-estimula ⇪ nenhum. */
  private integration?: GuiSessionIntegrationControls
  /** SKILLS 3.0 — a recarga PEDIDA e ainda sem recibo, por pane (ver
   *  `reloadSkills`). Chave = paneId; sai por recibo, por TTL, ou com a sessão. */
  private readonly skillReloads = new Map<string, GuiSkillReloadMark>()

  constructor(deps: GuiSessionDeps) {
    this.deps = deps
    this.attachmentCapabilities = deps.attachmentCapabilities ?? new GuiAttachmentCapabilityStore()
    this.ownerMail = deps.ownerMail ?? guiOwnerMailbox
    this.replyDebt = deps.replyDebt ?? guiOwnerReplyDebt
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
    const writes: {
      field: 'delegateSeat' | 'delegateModel' | 'delegateEffort'
      value: string | null
    }[] = []
    const FIELDS = {
      seat: { field: 'delegateSeat', label: 'conta' },
      model: { field: 'delegateModel', label: 'modelo' },
      effort: { field: 'delegateEffort', label: 'effort' }
    } as const
    for (const key of ['seat', 'model', 'effort'] as const) {
      const value = patch[key]
      // Ausente CONSERVA (o painel manda um campo por clique); `null` LIMPA.
      if (value === undefined) continue
      const { field, label } = FIELDS[key]
      if (value === null) {
        writes.push({ field, value: null })
        continue
      }
      const problem = guiDelegationDefaultProblem(label, value)
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
      return { ok: false, error: 'diga a conta, o modelo, o effort ou o fast padrão dos ajudantes' }
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
        seat: applied.seat ?? 'segue o modelo',
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

  /**
   * ONDE O CLI GRAVA O TRANSCRIPT DESTE PANE VIVO (R24.2). O leitor da conversa
   * completa precisa do par cwd+configDir junto: o caminho do arquivo do claude
   * é o slug do cwd DENTRO do config dir do seat, então ler um sem o outro
   * acharia o arquivo de outra conta. undefined = pane sem sessão viva — quem
   * chama cai no registro persistido em vez de adivinhar.
   */
  transcriptSourceOf(
    paneId: string
  ): { cli: 'claude' | 'codex'; cwd: string; configDir: string } | undefined {
    const spawn = this.panes.get(paneId)?.spawn
    return spawn ? { cli: spawn.cli, cwd: spawn.cwd, configDir: spawn.configDir } : undefined
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
    this.progressTracker.open(spawn, replayRing?.snapshot())
    this.notifyProgressChange()
    // Vale já DURANTE o construtor da sessão (um 'fatal' síncrono é captado
    // antes de a entrada existir no Map).
    const token = { alive: true }
    let replaySawReady = false
    // R24.1 — o anel pode já vir podado (respawn/hidratação): ali a verdade
    // chega pelo replay do `state`, não por um aviso ao vivo repetido.
    let evictionAnnounced = ring.evictedCount
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
      // SKILLS 3.0 — O RECIBO DA RECARGA ANTES DE TUDO (fatia 5.D, sonda §9). O
      // `result` do mini-turno do `/reload-skills` não é turno do agente: deixá-lo
      // atravessar daria um segundo plim, um segundo fecho do pote do dono e um
      // "respondi" que ninguém pediu. Ele vira NOTA pelo MESMO sink (a nota entra
      // no anel e sobrevive à remontagem) e o `result` para aqui.
      const reloadReceipt = this.takeSkillReloadReceipt(spawn.paneId, raw)
      if (reloadReceipt !== undefined) {
        publish({ type: 'command-output', text: reloadReceipt })
        return
      }
      // Processo trocado ou conversa zerada: a recarga pedida à geração anterior
      // não tem mais recibo a esperar (e a marca não pode viajar para a nova).
      if (raw.type === 'fatal' || raw.type === 'closed' || raw.type === 'conversation-cleared') {
        this.skillReloads.delete(spawn.paneId)
      }
      // AJUDANTES SEM ABA: a chamada `delegate` entra na fila de envelopes, o
      // resultado dela é segurado com `launched` enquanto a frota trabalha, e o
      // `result` do turno carrega `continues` enquanto houver ajudante vivo (o
      // MESMO degrau que o claude usa para as tarefas de fundo dele — sem ele o
      // fim de turno cancelaria no renderer os cards de quem ainda trabalha).
      const evt = this.helperCards.observe(spawn.paneId, raw)
      if (this.progressTracker.observe(spawn.paneId, evt)) this.notifyProgressChange()
      if (replayRing && evt.type === 'ready') replaySawReady = true
      // R25.1 — O ODÔMETRO ANDA AQUI, no caminho por onde TUDO passa: a parcela
      // da chamada é somada, persistida e trocada pelo TOTAL antes de o evento
      // entrar no anel. Como `context-usage` é sticky, a última fotografia
      // carrega o acumulado e o replay o entrega de graça.
      const metered =
        evt.type === 'context-usage' ? this.meterConversation(spawn, evt) : undefined
      // O backend conserva o input integral apenas no estado privado que
      // executa a tool. Replay e IPC recebem uma cópia orçada.
      const budgeted: SessionEvent =
        evt.type === 'tool' ? { ...evt, input: limitGuiToolInput(evt.input) } : evt
      const visibleEvt: SessionEvent = evt.type === 'ready'
        ? { ...evt, caps: withGuiConversationCommands(evt.caps) }
        : metered?.event ?? budgeted
      const seq = ring.push(visibleEvt)
      // Eventos intermediários ficam no anel; o próximo ponto legível captura
      // o snapshot inteiro, e dispose captura inclusive um stream parcial.
      // Assim o histórico é durável sem escrever disco por token/tool-start.
      if (guiTranscriptCheckpoint(visibleEvt)) this.saveTranscript(spawn.paneId, ring)
      this.deps.push({ paneId: spawn.paneId, seq, evt: visibleEvt })
      this.integrationReply.observe(token, visibleEvt)
      // A PRIMEIRA PODA DESTA CONVERSA (R24.1). Uma notícia só: o que a linha
      // do topo precisa é a VERDADE "há mais antes", e o número exato volta
      // afinado no próximo replay. O `seq` é o do anel (posterior ao evento
      // que causou a poda), então a notícia nunca é descartada como atrasada
      // pela janela de buffer da remontagem.
      if (ring.evictedCount > 0 && evictionAnnounced === 0) {
        evictionAnnounced = ring.evictedCount
        this.deps.push({
          paneId: spawn.paneId,
          seq: ring.cursor,
          evt: guiHistoryPrunedEvent(ring.evictedCount)
        })
      }
      // R39 D3 — O PASSO QUE A FALA DO DONO CORTA. O pump já vê tudo; aqui ele
      // só conta ao rastreio, e é dele que sai o "Você estava em: …" do
      // envelope. `tool-result` importa tanto quanto `tool`: tool que já voltou
      // não foi cortada, e dizer o contrário mandaria o modelo re-checar um
      // fato que está de pé.
      if (visibleEvt.type === 'tool')
        this.ownerSteer.noteTool(spawn.paneId, visibleEvt.name, visibleEvt.input)
      else if (visibleEvt.type === 'tool-result') this.ownerSteer.noteToolResult(spawn.paneId)
      else if (visibleEvt.type === 'thinking') this.ownerSteer.noteThinking(spawn.paneId)
      // R32 — a DÍVIDA DE RESPOSTA quita no caminho por onde todo texto passa:
      // o agente falou = o dono foi respondido. `result` quita também — o
      // turno acabou e a cobrança mid-turn perdeu o objeto (a fala do fecho o
      // dono vê como mensagem normal). Interrupção ■ é `result` com flag, cai
      // aqui igual: dívida de um turno morre com o turno.
      if (
        (visibleEvt.type === 'text' && visibleEvt.text.trim().length > 0) ||
        visibleEvt.type === 'result'
      )
        this.replyDebt.clear(spawn.paneId)
      // R39 D6 — e a BOLHA fecha o ciclo no MESMO instante: o primeiro texto do
      // assistente depois da entrega é a resposta que o dono estava esperando.
      // Só TEXTO carimba: um `result` mudo deixaria a bolha dizendo "respondida"
      // sem ninguém ter falado — que é exatamente a queixa de 01/09.
      if (visibleEvt.type === 'text' && visibleEvt.text.trim().length > 0) {
        for (const messageId of this.ownerSteer.takeDelivered(spawn.paneId)) {
          this.publishOwnerState(spawn.paneId, messageId, 'answered')
        }
      }
      // R39.1 D2' — O RECIBO APROXIMADO, e SÓ no motor que não ECOA a absorção.
      //
      // Onde há eco ele é o único recibo, e a sonda de 02/09 diz por quê: o CLI
      // dobra a fala no turno no milissegundo SEGUINTE ao `tool_result` da
      // fronteira, então a aproximação venceria a corrida sempre — por alguns
      // milissegundos — e o diário diria `approx` para uma medição que existe.
      //
      // A POSIÇÃO desta linha é a régua de D2': DEPOIS da quitação e do carimbo
      // `answered`. Um texto que o modelo já estava emitindo quando a fala
      // chegou não pode quitar uma dívida que só nasce aqui — ele é a
      // FRONTEIRA que prova a leitura, nunca a resposta a ela.
      if (
        (visibleEvt.type === 'tool-result' ||
          (visibleEvt.type === 'text' && visibleEvt.text.trim().length > 0)) &&
        this.panes.get(spawn.paneId)?.session.supportsSteerReceipt !== true
      )
        this.readOwnerSteer(spawn.paneId, 'approx')
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
            // podem aparecer como se fossem da geração nova. O odômetro sai
            // pela MESMA porta — ele mede a conversa, e ela acabou de trocar.
            this.rememberContextUsage(spawn.paneId, undefined)
            this.forgetConversationUsage(spawn.paneId)
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
      if (visibleEvt.type === 'result') {
        // R39 D3 — o passo é lido AGORA e viaja no fecho: o `result` encerra o
        // turno (e o rastreio dele), mas a entrega acontece um microtask
        // depois, e é ela que precisa saber o que ficou pela metade.
        const lastStep = this.ownerSteer.lastStepOf(spawn.paneId)
        this.ownerSteer.noteResult(spawn.paneId)
        if (this.ownerMail.has(spawn.paneId)) {
          const reason =
            visibleEvt.interrupted === true ? 'fecho-por-interrupcao' : 'fecho-de-turno'
          queueMicrotask(() => {
            if (!token.alive) return
            // R39.1 D3' — o fecho NÃO entrega a cópia `steered`: ela é cinto de
            // uma fala que o CLI já tem, e a segunda entrega é a que faz o dono
            // falar duas vezes.
            this.flushOwnerMail(spawn.paneId, reason, { lastStep, skipSteered: true })
          })
        }
      }
      // R25.3a — A NOTA DA CONVERSA PESADA, uma por marco. Sai pelo MESMO sink
      // (`command-output` vira nota no redutor), então ela é durável e volta no
      // replay; e em MICROTASK, DEPOIS de a medição que a disparou já ter
      // atravessado o anel e o IPC. É ADVISORY: nada bloqueia, nada de relógio
      // novo, e a receita vem escrita nela.
      if (metered?.note) {
        const note = metered.note
        queueMicrotask(() => {
          if (!token.alive) return
          publish({ type: 'command-output', text: note })
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
      // R39.1 D2' — O RECIBO DE LEITURA para AQUI: ele não é fala de ninguém, e
      // não pode entrar no anel nem no transcript. O que a tela lê é o
      // `owner-message-state` que este ramo publica logo abaixo.
      if (evt.type === 'owner-steer-absorbed') {
        this.readOwnerSteer(spawn.paneId, 'echo', evt.tag)
        return
      }
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
      this.progressTracker.observe(spawn.paneId, { type: 'fatal', text: '' })
      this.notifyProgressChange()
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
    // R32 — o turno da dívida morreu com o processo velho: cobrar o processo
    // novo por uma fala que ele nunca leu prenderia a delegação num pane que
    // acabou de nascer (a mensagem re-entra pelo flush logo abaixo, como turno
    // normal, e turno normal responde por si).
    this.replyDebt.clear(spawn.paneId)
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
    const conversationCommand = routeGuiConversationCommand(trimmed)
    if (conversationCommand) {
      if (validatedAttachments.attachments.length === 0 && conversationCommand === 'reset')
        return this.clearConversation(entry)
      return { ok: false, error: GUI_NEW_CONVERSATION_USAGE }
    }
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
    // A ROTA DA FALA DO DONO (R39 D1/D5; a régua mora em `guiOwnerSteer`, pura e
    // testável — este arquivo já é grande demais para ganhar decisão nova).
    //
    // Ela decide TUDO o que não é o caminho de sempre: parar o turno e entregar
    // como turno novo, responder uma pergunta aberta, ou guardar no pote. As
    // cercas antigas continuam de pé dentro dela — SLASH é comando e tem de ser
    // EXECUTADO pelo binário; BRIEFING pendente é prompt, não citação.
    const steer = ownerSteerPlan({
      alive: entry.session.alive,
      turnActive: entry.session.turnActive === true,
      isSlash: trimmed.startsWith('/'),
      hasPendingBriefing: Boolean(entry.pendingBriefing),
      pendingInteraction: this.pendingInteractionOf(entry),
      text: prompt
    })
    if (this.routeOwnerSteer(paneId, entry, messageId, prompt, steer)) return { ok: true }
    // AQUI, e não antes: o `/clear` e os slash roteados voltam acima sem
    // alcançar o modelo — soltar o briefing neles seria queimá-lo num comando
    // que o agente nunca vê.
    const briefing = entry.pendingBriefing
    if (briefing) entry.pendingBriefing = undefined
    // O CAMINHO DE SEMPRE. Depois da R39 ele quase nunca vê turno aberto: com
    // turno vivo a rota PARA o turno e entrega como turno novo (D1). Sobram as
    // cercas — comando do CLI, briefing pendente, fala que não cabe no pote — e
    // aí vale o que a sonda de 23/08 mediu (probe-claude-owner-midturn, 2.1.241):
    // os dois motores steeram (codex por `turn/steer`, claude pelo stdin na
    // fronteira da próxima tool) e nenhum tem fila própria. O que a medição de
    // 01/09 provou é que ser LIDO no meio do turno não é ser OBEDECIDO — por
    // isso o steering deixou de ser a rota principal da fala do dono.
    entry.session.send(briefing ? guiBriefedPrompt(briefing, prompt) : prompt)
    return { ok: true }
  }

  /**
   * O PEDIDO QUE ESTÁ PARADO ESPERANDO O DONO (R39 D5), lido do anel — a única
   * fonte autoritativa de pendência que este registro tem.
   *
   * PERGUNTA só entra como `question` no CLI que aceita RESPOSTA LIVRE. Isso
   * está PROVADO no claude, e em produção: o card do chat já manda o texto do
   * campo "outra resposta" por este mesmo caminho (`GuiQuestionCard` →
   * `answerQuestion` → `updatedInput.answers`), e as transcrições dos seats têm
   * 15 pares em que a resposta não é `label` nenhum e o CLI devolve, sem erro,
   * "The user answered: … follow what they actually say". No Codex, o ID
   * estável identifica a pergunta; texto livre respeita a opção do pedido.
   *
   * A PROPOSTA DE PLANO fica de fora de propósito: ela não bloqueia o CLI (a
   * tool responde na hora e o turno fecha), então um turno aberto com proposta
   * pendurada continua sendo turno aberto — e turno aberto se PARA.
   */
  private pendingInteractionOf(entry: GuiPaneEntry): GuiOwnerPendingInteraction | null {
    if (entry.session instanceof MaestroSession || entry.session instanceof CodexSession) {
      for (const requestId of entry.ring.pendingIdsOfType('question')) {
        const record = guiEventRecord(entry.ring.pending(requestId))
        // Pergunta opcional tem cartão próprio; não retém orientações do composer.
        if (record?.['blocking'] === false) continue
        const questions = record?.['questions']
        const first = Array.isArray(questions) ? guiEventRecord(questions[0]) : null
        const key = first?.['id'] ?? first?.['question']
        const question = first?.['allowCustom'] !== false && typeof key === 'string' ? key : undefined
        return { kind: 'question', requestId, ...(question ? { question } : {}) }
      }
    }
    for (const kind of ['permission', 'plan-review'] as const) {
      const requestId = entry.ring.pendingIdsOfType(kind)[0]
      if (requestId) return { kind, requestId }
    }
    return null
  }

  /**
   * A EXECUÇÃO DA ROTA (R39 + R39.1). `true` = a fala foi tratada aqui e o
   * `send` não segue para o caminho de sempre; `false` = caminho de sempre.
   *
   * ENTREGA ÚNICA, SEMPRE. Na rota `steer` (o padrão da R39.1) quem fala com o
   * CLI é ESTE ramo, uma vez só, e a cópia do pote é CINTO — ninguém a entrega
   * de novo enquanto ela existir (nem a carona, nem o fecho de turno). Toda
   * recusa cai no caminho de sempre, que entrega no fecho: nenhuma delas é beco.
   */
  private routeOwnerSteer(
    paneId: string,
    entry: GuiPaneEntry,
    messageId: string,
    text: string,
    steer: GuiOwnerSteerPlan
  ): boolean {
    if (steer.route === 'answer-question') {
      // O CLI está PARADO esperando o dono: não há turno a cortar, e o texto
      // dele É a resposta. Pergunta que ficou stale entre a régua e a resposta
      // devolve `false` — e aí a fala segue pelo caminho de sempre.
      const requestId = steer.requestId
      const question = steer.question
      if (!requestId || !question) return false
      if (!this.answerQuestion(paneId, requestId, { [question]: text }).ok) return false
      this.ownerSteer.noteDelivered(paneId, [messageId])
      this.publishOwnerState(paneId, messageId, 'delivered')
      this.deps.record?.(
        'gui-owner-answer',
        { paneId, projectId: entry.spawn.projectId },
        { messageId, requestId, chars: text.length }
      )
      return true
    }
    if (steer.route !== 'steer' && steer.route !== 'stop-and-hand' && steer.route !== 'hold')
      return false
    const handoff = steer.route === 'stop-and-hand'
    const steered = steer.route === 'steer'
    // O POTE PRIMEIRO, o CLI depois: mandar a fala para uma sessão sem ter onde
    // guardar a cópia (grande demais, pote cheio) a deixaria sem cinto — e o
    // pote recusar é justamente o que mantém a rota alternativa viva.
    if (
      !this.ownerMail.post(paneId, {
        messageId,
        text,
        at: Date.now(),
        ...(handoff ? { handoff: true } : {}),
        ...(steered ? { steered: true } : {})
      })
    )
      return false
    // R22.3 — o long-poll da frota resolve AGORA: sem isto a tool do Synkora em
    // voo seguraria até 240s a fronteira em que o CLI absorve a fala.
    try {
      this.helpers?.wakePane?.(paneId)
    } catch {
      // Despertar é aceleração, nunca pré-condição.
    }
    if (steered) {
      // R39.1 D1' — A ROTA PADRÃO: a fala vai AGORA, dentro do turno vivo, e
      // NADA é cortado (o dono: "pode ser sem parar, puro"). O `messageId` viaja
      // como carimbo: é por ele que o motor devolve o RECIBO DE LEITURA, e é o
      // recibo — não o envio — que arma a dívida e apaga a cópia do pote.
      this.ownerSteer.noteSteered(paneId, messageId, Date.now())
      let delivered = true
      try {
        entry.session.send(text, messageId)
      } catch {
        delivered = false
      }
      if (!delivered) {
        // O motor estourou: a cópia deixa de ser cinto e vira correio comum,
        // para o fecho do turno entregá-la pelo caminho de sempre. Beco sem
        // saída é bug.
        this.ownerSteer.takeRead(paneId, messageId)
        const copy = this.ownerMail.removeById(paneId, messageId)
        if (copy) this.ownerMail.post(paneId, { messageId, text: copy.text, at: copy.at })
        return true
      }
      this.publishOwnerState(paneId, messageId, 'unread')
      this.deps.record?.(
        'gui-owner-steer',
        { paneId, projectId: entry.spawn.projectId },
        {
          messageId,
          chars: text.length,
          pending: this.ownerMail.count(paneId),
          reason: steer.reason,
          // O motor ECOA o recibo, ou o registro vai ter de aproximar? A
          // resposta muda o `signal` do diário — e o diário nunca finge medição.
          echo: entry.session.supportsSteerReceipt === true
        }
      )
      return true
    }
    if (!handoff) {
      this.deps.record?.(
        'gui-owner-mail-posted',
        { paneId, projectId: entry.spawn.projectId },
        { messageId, chars: text.length, pending: this.ownerMail.count(paneId), reason: steer.reason }
      )
      return true
    }
    // D1.c — SÓ O TURNO DO CLI. Nem `helpers.interruptPane`, nem
    // `helperCards.discardPending`: a frota segue trabalhando e as pendências do
    // despertador continuam de pé. O ■ do dono é que para tudo, e ele não muda.
    //
    // O motor que estoura aqui não pode derrubar o `send`: a fala JÁ está no
    // pote (durável, com bolha no fio), e o fecho do turno a entrega de todo
    // jeito — nenhum passo depende de entrega única.
    let stopped = false
    try {
      stopped = entry.session.interrupt()
    } catch {
      stopped = false
    }
    this.publishOwnerState(paneId, messageId, 'stopping')
    this.deps.record?.(
      'gui-owner-stop',
      { paneId, projectId: entry.spawn.projectId },
      {
        messageId,
        chars: text.length,
        pending: this.ownerMail.count(paneId),
        // `false` = o turno fechou entre a régua e o interrupt (corrida
        // benigna): o fecho que já está a caminho entrega o pote do mesmo jeito.
        stopped,
        // A cerca da R22 caiu (D1 vale para QUALQUER pane); o diário continua
        // distinguindo o caso do turno-fortaleza para quem for ler depois.
        delegator: this.deps.delegatorPane?.(paneId) === true
      }
    )
    return true
  }

  /**
   * O CARIMBO DA BOLHA (R39 D6) — "parando o agente…" / "entregue" / "respondida".
   *
   * Sai pelo MESMO cano dos eventos do motor (anel + push), e não pelo `sink`:
   * ele não é vocabulário de CLI nenhum (é o harness contando o que o harness
   * fez), e o anel carrega `unknown` — a mesma porta por onde a poda já fala.
   * Entrar no anel é o que faz o carimbo sobreviver à remontagem da aba.
   *
   * Carimbo é APRESENTAÇÃO: falhar aqui nunca pode derrubar a entrega, então
   * pane sem sessão viva simplesmente não recebe carimbo.
   */
  private publishOwnerState(
    paneId: string,
    messageId: string,
    state: GuiOwnerMessageState
  ): void {
    const entry = this.panes.get(paneId)
    if (!entry || !entry.token.alive) return
    const evt = guiOwnerMessageStateEvent(messageId, state, Date.now())
    this.deps.push({ paneId, seq: entry.ring.push(evt), evt })
  }

  /**
   * O RECIBO DE LEITURA (R39.1 D2') — o instante em que o CLI ABSORVEU a fala.
   *
   * É aqui, e não no envio, que três coisas acontecem juntas: a cópia sai do
   * pote (recibo visto = entrega confirmada), a bolha vira "lida" e a DÍVIDA
   * arma. Armar no envio seria errado de um jeito medível: um texto que o modelo
   * já estava emitindo quitaria a cobrança sem ele ter lido uma linha.
   *
   * `signal` diz de onde veio a verdade — `echo` é o frame que o CLI emitiu
   * (`command_lifecycle{started}` no claude, `item/started` de `userMessage` no
   * codex, os dois sondados em 02/09); `approx` é a fronteira que o registro
   * observou num motor que não ecoa. O diário grava qual foi: aproximação
   * declarada é medição honesta, aproximação escondida é mentira.
   */
  private readOwnerSteer(
    paneId: string,
    signal: GuiOwnerReadSignal,
    messageId?: string
  ): void {
    const notes = this.ownerSteer.takeRead(paneId, messageId)
    if (notes.length === 0) return
    const entry = this.panes.get(paneId)
    const now = Date.now()
    const texts: string[] = []
    for (const note of notes) {
      const copy = this.ownerMail.removeById(paneId, note.messageId)
      if (copy) texts.push(copy.text)
      this.publishOwnerState(paneId, note.messageId, 'read')
      this.deps.record?.(
        'gui-owner-read',
        { paneId, ...(entry ? { projectId: entry.spawn.projectId } : {}) },
        {
          messageId: note.messageId,
          signal,
          // O relógio da queixa do dono, agora medido no ponto certo: quanto
          // tempo a fala dele ficou "não lida" na tela.
          msSinceSend: Math.max(0, now - note.at)
        }
      )
    }
    // A dívida ACUMULA (`arm` concatena): duas falas lidas em sequência têm de
    // aparecer as DUAS na recusa, senão a citação conta metade da história.
    if (texts.length > 0) this.replyDebt.arm(paneId, texts)
    this.ownerSteer.noteDelivered(
      paneId,
      notes.map((note) => note.messageId)
    )
  }

  /**
   * R39.1 — O CINTO VIRA ENTREGA: a cópia `steered` de uma fala que o corte
   * deixou SEM RECIBO passa a ser `handoff`, e o reconciliador do fecho a
   * entrega com o envelope completo.
   *
   * Só faz sentido no motor que DESCARTA a fila ao cortar (o codex, medido na
   * sonda 3b): ali a fala steerada morreu com o turno, e deixá-la marcada a
   * prenderia no pote até o pane renascer — perda silenciosa das palavras do
   * dono, que é o que a casa não admite. Devolve `false` quando não havia cópia.
   */
  private demoteSteeredCopy(paneId: string, messageId: string): boolean {
    if (!this.ownerMail.markHandoff(paneId, messageId)) return false
    // O bilhete do recibo morre junto: um eco atrasado não pode apagar do pote
    // uma fala que já virou entrega do fecho.
    this.ownerSteer.takeRead(paneId, messageId)
    return true
  }

  /**
   * "LER AGORA" (R39.1 D4') — o gesto do dono, e o ÚNICO lugar que ainda corta
   * um turno por causa de uma mensagem.
   *
   * *"E se eu quiser eu posso forçar, aí forçando ele para o turno e lê o que eu
   * quero falar, quando for algo urgente."* Corta SÓ o turno do CLI: nem
   * `helpers.interruptPane`, nem `helperCards.discardPending` — a frota segue
   * trabalhando, e o ■ do dono continua sendo o único que para tudo.
   *
   * O QUE VEM DEPOIS DO CORTE é o que a sonda 2 (02/09) mediu, e os dois motores
   * DIVERGEM — por isso a pergunta é à CAPACIDADE, nunca ao nome da classe:
   *  - motor que PRESERVA a fila (claude, `interrupt_receipt_v1`): a resposta do
   *    interrupt lista a fala em `still_queued` e o CLI a promove a turno novo
   *    1 ms depois do `result` interrompido. O harness manda SÓ o envelope
   *    curto de retomada — repetir a fala a entregaria duas vezes;
   *  - motor que DESCARTA (codex, medido: `turn/completed` no mesmo
   *    milissegundo e nada em 30 s): a cópia do pote vira `handoff` e o
   *    reconciliador do fecho a entrega com o envelope completo da R39.
   *
   * Forçar uma fala JÁ LIDA é no-op com nota no diário: cortar um turno por algo
   * que ele já leu seria dano puro.
   */
  forceOwnerMessage(paneId: string, messageId: string): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!messageId) return { ok: false, error: 'mensagem sem identificador' }
    const waiting = this.ownerSteer
      .pendingSteered(paneId)
      .some((note) => note.messageId === messageId)
    if (!waiting) {
      this.deps.record?.(
        'gui-owner-force',
        { paneId, projectId: entry.spawn.projectId },
        { messageId, noop: true, reason: 'ja-lida' }
      )
      return { ok: true }
    }
    const lastStep = this.ownerSteer.lastStepOf(paneId)
    let stopped = false
    try {
      stopped = entry.session.interrupt()
    } catch {
      // O motor que estoura no corte não pode derrubar o gesto: a fala já está
      // no pote e no CLI, e o fecho (ou o renascimento) resolve de todo jeito.
      stopped = false
    }
    this.publishOwnerState(paneId, messageId, 'stopping')
    const keptQueued = entry.session.keepsQueuedOnInterrupt === true
    if (keptQueued) {
      // D4'.a — só o envelope curto, como STEER do turno novo que o próprio CLI
      // vai abrir com a fala do dono.
      this.deliverBackstage(paneId, guiOwnerForceText(lastStep), 'retomada do dono')
    } else if (this.demoteSteeredCopy(paneId, messageId)) {
      // D4'.b — o corte apagou o steer neste motor: a cópia deixa de ser cinto
      // e vira a ENTREGA do turno novo, com o envelope completo. A marca de
      // "forçada" acompanha a entrega; o gesto em si não comprova leitura.
      this.ownerSteer.noteForced(paneId, messageId)
    }
    this.deps.record?.(
      'gui-owner-force',
      { paneId, projectId: entry.spawn.projectId },
      {
        messageId,
        // `false` = o turno fechou entre o gesto e o corte (corrida benigna): o
        // fecho que já está a caminho resolve do mesmo jeito.
        stopped,
        keptQueued,
        lastStep: lastStep ?? 'pensando'
      }
    )
    return { ok: true }
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
   *
   * R39 — quando o pote traz fala MARCADA (ela PAROU o turno), o que sai não é
   * a fala crua: é o ENVELOPE DE RETOMADA, que diz que ele foi parado, nomeia o
   * passo cortado e manda responder antes de retomar. E a DÍVIDA (D4) é armada
   * aqui também — no caso medido de 01/09 a entrega funcionou e a obediência é
   * que faltou.
   */
  private flushOwnerMail(
    paneId: string,
    reason: string,
    opts: { lastStep?: string | null; skipSteered?: boolean } = {}
  ): void {
    if (!this.ownerMail.has(paneId)) return
    const entry = this.panes.get(paneId)
    if (!entry || !entry.session.alive) return
    // Turno ainda vivo = a carona ainda pode acontecer, e ela é melhor: chega ao
    // modelo AGORA, sem esperar o fim.
    if (entry.session.turnActive) return
    // A mensagem da fila saindo e a troca de executor em voo seguram o envio
    // pelo MESMO motivo do despertador (`paneBusyReason`).
    if (this.paneBusyReason(paneId, entry)) return
    const lastStep = opts.lastStep !== undefined ? opts.lastStep : this.ownerSteer.lastStepOf(paneId)
    // R39.1 D3' — O FECHO DE TURNO PULA A CÓPIA `steered`: o CLI já está com
    // essa fala (ela foi steerada), e entregá-la de novo faria o dono falar duas
    // vezes. Quem a apaga é o RECIBO; quem a entrega é o RENASCIMENTO do pane —
    // ali a marca perdeu o sentido, porque o processo que a tinha morreu.
    const entries = this.ownerMail.drain(
      paneId,
      opts.skipSteered === true ? { skipSteered: true } : {}
    )
    if (entries.length === 0) return
    // UMA fala marcada marca a entrega inteira: o turno novo nasce do corte, e
    // separar as duas cargas em duas mensagens faria o dono falar duas vezes.
    const handoff = entries.some((mail) => mail.handoff === true)
    const text = handoff
      ? guiOwnerHandText(entries, lastStep)
      : guiOwnerMailFlushText(entries)
    // Pote só com brancos é impossível pela porta do `post` — e, se algum dia
    // for, some aqui em vez de abrir um turno com nada dentro.
    if (!text.trim()) return
    const sent = this.deliverBackstage(paneId, text, 'mensagem do dono')
    if (!sent.ok) {
      this.ownerMail.restore(paneId, entries)
      return
    }
    if (handoff) {
      // D4 — a dívida deixa de ser exclusividade da carona: quem foi PARADO
      // para ouvir o dono não volta a chamar tool antes de falar com ele.
      this.replyDebt.arm(
        paneId,
        entries.map((mail) => mail.text)
      )
    }
    this.ownerSteer.noteDelivered(
      paneId,
      entries.map((mail) => mail.messageId)
    )
    // Reenvio confirma entrega ao motor, não leitura. O carimbo `read`
    // pertence ao recibo nativo em readOwnerSteer, nunca ao gesto de forçar.
    for (const mail of entries) {
      this.ownerSteer.takeForced(paneId, mail.messageId)
      this.publishOwnerState(paneId, mail.messageId, 'delivered')
    }
    const oldest = entries.reduce((first, mail) => Math.min(first, mail.at), Date.now())
    this.deps.record?.(
      handoff ? 'gui-owner-hand' : 'gui-owner-mail-flushed',
      { paneId, projectId: entry.spawn.projectId },
      {
        messages: entries.length,
        chars: text.length,
        reason,
        ...(handoff
          ? {
              // O relógio da queixa: no caso medido foram 3 min de pote e 8
              // minutos até a resposta. É este número que diz se a rodada valeu.
              msSincePost: Math.max(0, Date.now() - oldest),
              lastStep: lastStep ?? 'pensando'
            }
          : {})
      }
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
   * A RECARGA DO CATÁLOGO DE SKILLS (Skills 3.0 — fatia 5.D; sonda §9). Chamada
   * pelo `skill_pull` depois de a pasta pousar no worktree.
   *
   * CLAUDE: manda `/reload-skills` cru AO CLI NA HORA, pelo bastidor — sem bolha
   * do dono, sem `messageId`, sem consumir o briefing e, diferente do
   * `deliverBackstage`, SEM `turn-started`: nenhum turno começa agora. O CLI
   * enfileira o comando e o executa sozinho ao fim do turno corrente (mini-turno
   * próprio), e a skill passa a valer para `Skill`/catálogo/chip ❖ do turno
   * seguinte em diante. O `result` desse mini-turno é RECIBO — a marca abaixo é o
   * que o distingue do turno do agente.
   *
   * CODEX: NO-OP dito. A thread enxerga a pasta no próximo turno sem recarga
   * (sondado), e mandar um slash por ali viraria prompt e queimaria tokens.
   *
   * NUNCA LANÇA e nunca é pré-condição: pane morto/ausente devolve `ok:false` com
   * o motivo, e o recibo do `skill_pull` continua entregando o caminho do
   * SKILL.md — que é o que vale no turno corrente nos dois CLIs.
   */
  async reloadSkills(paneId: string): Promise<{ ok: boolean; detail?: string }> {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, detail: 'este pane não tem sessão aberta' }
    if (!entry.session.alive) return { ok: false, detail: 'a sessão deste pane encerrou' }
    if (entry.spawn.cli === 'codex') {
      return { ok: true, detail: 'o codex enxerga a pasta no próximo turno, sem recarga' }
    }
    // UM pedido por vez: duas skills puxadas no mesmo turno não precisam de duas
    // recargas (a do fim do turno cobre as duas), e um segundo recibo sem marca
    // apareceria no fio como fim de turno fantasma.
    const pending = this.skillReloads.get(paneId)
    if (pending && Date.now() - pending.at < GUI_SKILL_RELOAD_TTL_MS) {
      return { ok: true, detail: 'a recarga deste turno já está na fila do CLI' }
    }
    this.skillReloads.set(paneId, {
      pendingAgentResults: entry.session.turnActive === true ? 1 : 0,
      at: Date.now()
    })
    try {
      entry.session.send(GUI_SKILL_RELOAD_COMMAND)
    } catch (error) {
      this.skillReloads.delete(paneId)
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'o CLI não aceitou o comando'
      }
    }
    this.deps.record?.(
      'gui-skill-reload-asked',
      { paneId, projectId: entry.spawn.projectId },
      { turnActive: entry.session.turnActive === true }
    )
    return {
      ok: true,
      detail: 'o claude recarrega o catálogo ao fim deste turno e a skill vale do próximo em diante'
    }
  }

  /**
   * O RECIBO DA RECARGA, se este `result` for ele. Devolve a linha para o fio (e
   * o `result` NÃO segue adiante), ou `undefined` quando o evento é do agente.
   *
   * A régua é ESTRUTURAL, nunca o texto do recibo: o contador da marca sabe
   * quantos `result` ainda pertencem ao turno do agente. Heurística sobre
   * conteúdo é proibida na casa — e aqui ela também erraria, porque o recibo do
   * CLI é uma frase dele que pode mudar em qualquer update.
   */
  private takeSkillReloadReceipt(paneId: string, evt: SessionEvent): string | undefined {
    if (evt.type !== 'result') return undefined
    const mark = this.skillReloads.get(paneId)
    if (!mark) return undefined
    if (Date.now() - mark.at >= GUI_SKILL_RELOAD_TTL_MS) {
      // O CLI nunca executou o comando (processo trocado, comando removido do
      // binário): a marca morre CALADA e o `result` segue como turno do agente.
      // Engolir o fecho de um turno futuro seria muito pior que perder a nota.
      this.skillReloads.delete(paneId)
      return undefined
    }
    if (mark.pendingAgentResults > 0) {
      mark.pendingAgentResults -= 1
      return undefined
    }
    this.skillReloads.delete(paneId)
    this.deps.record?.(
      'gui-skill-reload-done',
      { paneId, projectId: this.panes.get(paneId)?.spawn.projectId },
      { isError: evt.isError === true }
    )
    return guiSkillReloadNote(evt.resultText, evt.isError === true)
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

  /** O mesmo cartão responde a AskUserQuestion e ao request_user_input. */
  answerQuestion(paneId: string, requestId: string, answers: Record<string, string>): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    const pendingEvent = entry.ring.pending(requestId)
    const pending = guiEventRecord(pendingEvent)
    if (requestId.startsWith('codex-async-') || pending?.['asynchronous'] === true) {
      if (entry.spawn.cli !== 'codex' || !isGuiPersistedEvent(pendingEvent) ||
        pendingEvent.type !== 'question' || pendingEvent.asynchronous !== true) {
        return { ok: false, error: 'esta pergunta não está mais pendente' }
      }
      const reply = codexAsyncQuestionAnswer(pendingEvent.questions, answers)
      if (!reply) return { ok: false, error: 'resposta inválida; responda todas as perguntas ou use pular', retryable: true }
      const messageId = `answer-${createHash('sha256').update(requestId).digest('hex')}`
      const sent = this.send(paneId, reply.text, messageId)
      if (!sent.ok) return { ...sent, retryable: true }
      entry.sink({ type: 'interaction-resolved', requestId,
        resolution: { kind: 'question', entries: reply.entries, messageId } })
      return { ok: true }
    }
    const questions = Array.isArray(pending?.['questions']) ? pending['questions'] : []
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
          .map(([key, answer]) => {
            const original = questions.map(guiEventRecord).find((q) => q?.['id'] === key)
            const question = typeof original?.['question'] === 'string' ? original['question'] : key
            return { question: question.slice(0, 2_000), answer: answer.slice(0, 4_000) }
          })
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
    this.notifyProgressChange()
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
    this.notifyProgressChange()
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
    // R39.1 — O ■ NÃO PODE ENGOLIR A FALA DELE. Num motor que descarta a fila ao
    // cortar (o codex, medido na sonda 3b de 02/09), a fala steerada sem recibo
    // morreu com o turno: a cópia do pote deixa de ser cinto e vira a entrega do
    // fecho. No motor que preserva a fila (o claude), não há nada a resgatar — o
    // CLI a promove a turno novo sozinho, e reentregar seria falar duas vezes.
    if (entry.session.keepsQueuedOnInterrupt !== true) {
      for (const note of [...this.ownerSteer.pendingSteered(paneId)])
        this.demoteSteeredCopy(paneId, note.messageId)
    }
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

  /** A resposta MCP atravessa o CLI antes do fecho que remove seu cwd. */
  afterIntegrationReply(paneId: string, text: string, finish: () => Promise<string>): void {
    const entry = this.panes.get(paneId)
    const generation = entry?.token ?? {}
    const events = entry?.ring.snapshot() ?? this.restoreTranscript(paneId)?.snapshot() ?? []
    // O fecho mata os processos antes de remover a pasta. A nota final precisa
    // alcançar também o transcript já fechado, com o MESMO cursor monotônico.
    const emit = (event: SessionEvent): void => {
      const current = this.panes.get(paneId)
      if (current === entry && current?.token.alive) {
        current.sink(event)
        return
      }
      // Nunca publique eventos de uma geração morta por cima de uma nova.
      if (current) return
      const ring = this.restoreTranscript(paneId) ?? new GuiEventRing()
      const seq = ring.push(event)
      this.saveTranscript(paneId, ring)
      this.deps.push({ paneId, seq, evt: event })
    }
    this.integrationReply.arm(
      generation,
      pendingIntegrationTool(events.filter(isGuiPersistedEvent)),
      text,
      emit,
      finish
    )
    if (!entry?.session.alive) this.integrationReply.disposed(generation)
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

  /**
   * Replay da remontagem: o que o pane perdeu enquanto estava desmontado.
   *
   * R24.1 — quando a poda já comeu o começo, o replay ABRE dizendo isso. O
   * evento sintético vai com `seq: 0` de propósito: ele é anterior a tudo, não
   * é terminal (não entra em recibo de apresentação) e nunca ocupa um seq real.
   */
  state(paneId: string): GuiStatePayload {
    const ring = this.panes.get(paneId)?.ring ?? this.restoreTranscript(paneId)
    if (!ring) return { events: [], cursor: 0, exists: false, alive: false }
    const pruned: GuiSequencedEvent[] =
      ring.evictedCount > 0 ? [{ seq: 0, evt: guiHistoryPrunedEvent(ring.evictedCount) }] : []
    return {
      events: [...pruned, ...ring.sequencedSnapshot()],
      cursor: ring.cursor,
      exists: true,
      alive: this.panes.get(paneId)?.session.alive ?? false
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
          interactiveQuestions: true,
          resumeSessionId: threadId,
          // CERCA ANTI-SUBAGENTE-NATIVO por THREAD (D5/S2). Ela ACOMPANHA o
          // cinto que já viaja nos args: os dois lados da mesma cerca nascem e
          // morrem juntos, e a derivação é estável entre respawns porque o
          // re-arme reproduz os MESMOS args (e eles já entram no fingerprint).
          ...(guiSpawnSuppressesNativeAgents(spawn) ? { suppressNativeAgents: true } : {}),
          // CAIXA-PRETA DO CHIP DE SKILL: o motor detecta, a borda grava — o
          // codexSession nunca importa blackbox. Uma linha por skill que ENTRA
          // na conversa, com o pane para correlacionar (o `cli` vem no detail
          // porque só o codex precisa de detecção: no claude o `tool_use:Skill`
          // já é o próprio evento).
          recordSkillEntered: (detail) =>
            this.deps.record?.(
              'skill-entered',
              { paneId: spawn.paneId, projectId: spawn.projectId },
              detail
            )
        },
        persona,
        sink
      )
    }
    // claude: persona ao nível de SISTEMA e por arquivo (teto de argv).
    const file = persona
      ? this.deps.systemPromptFile(`gui-${spawn.paneId}.system.md`, persona)
      : undefined
    // R39 (2026-09-02) — a dívida de resposta ao dono alcança TODA tool deste
    // pane (nativas inclusive) por um hook PreToolUse que lê a bandeira dele em
    // disco (`guiOwnerDebtHook`, forma sondada no binário). `undefined` enquanto
    // o boot não carimbou o flagDir: aí o pane nasce exatamente como antes.
    const debtFlag = guiOwnerReplyDebt.flagPathFor(spawn.paneId)
    return new MaestroSession(
      {
        ...opts,
        resumeSessionId: spawn.resumeSessionId,
        systemPromptFile: file,
        ...(debtFlag ? { settings: guiOwnerDebtHookSettings(debtFlag) } : {})
      },
      sink
    )
  }

  /** /new, /new chat, /reset e /clear trocam deliberadamente a conversa. O cursor
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
    const result = this.create(spawn)
    if (result.ok) this.note(paneId, GUI_NEW_CONVERSATION_NOTE)
    return result
  }

  private dispose(paneId: string, reason: string, preserveRing = false): void {
    const entry = this.panes.get(paneId)
    if (!entry) return
    // Última barreira antes de apagar a geração: inclui deltas parciais que
    // ainda não tinham alcançado um checkpoint semântico.
    entry.flushPendingTerminal?.()
    this.saveTranscript(paneId, entry.ring)
    this.integrationReply.disposed(entry.token)
    this.panes.delete(paneId)
    this.progressTracker.forget(paneId)
    this.notifyProgressChange()
    entry.token.alive = false
    // A correlação morre com a geração: o anel é a memória durável dos cards, e
    // um envelope da conversa anterior nunca pode parear um lote da próxima.
    this.helperCards.forgetPane(paneId)
    // R39.1 — o rastreio da fala do dono morre junto, pelo MESMO motivo. A fala
    // sem recibo continua no POTE (durável, e o nascimento do pane a entrega);
    // o que não pode sobreviver é o BILHETE dela — um recibo tardio da geração
    // morta carimbaria "lida" numa bolha que o renascimento já entregou.
    this.ownerSteer.forget(paneId)
    // SKILLS 3.0 — a recarga pedida à geração MORTA não tem mais recibo a
    // esperar: a marca sobrevivendo ao respawn engoliria o primeiro `result` da
    // conversa nova (as skills continuam no worktree; o processo novo já nasce
    // com o catálogo lido).
    this.skillReloads.delete(paneId)
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
    // Só o que a PODA levou entra na conta (o descarte por contrato, logo
    // acima, tira eventos de qualquer posição — dizer que "o começo saiu da
    // tela" por causa dele seria inventar uma verdade que não é a mesma).
    const ring = new GuiEventRing(
      GUI_RING_CAP,
      GUI_RING_BYTE_CAP,
      initialCursor,
      transcript.evicted ?? 0
    )
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
      updatedAt: new Date().toISOString(),
      ...(ring.evictedCount > 0 ? { evicted: ring.evictedCount } : {})
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

  /**
   * O ODÔMETRO DA CONVERSA (R25.1) — soma a parcela desta chamada, persiste o
   * acumulado e devolve o evento JÁ carimbado com o total.
   *
   * Três decisões que valem como contrato:
   * - A parcela (`call`) é transporte motor→registro e NÃO segue para o anel:
   *   ao renderer viaja o TOTAL. Assim o fio persistido não engorda com a
   *   repartição de cada chamada, e há um lugar só que sabe somar.
   * - Medição SEM parcela (compactação do codex, motor sem repartição) ainda
   *   recebe o carimbo do total que já existe: a fotografia sticky é a única
   *   que o replay entrega, e ela não pode voltar do disco sem odômetro.
   * - Falha de disco não derruba nada: o acumulado em memória (o documento)
   *   continua correto e o próximo checkpoint tenta persistir de novo.
   */
  private meterConversation(
    spawn: GuiPaneSpawn,
    event: Extract<SessionEvent, { type: 'context-usage' }>
  ): { event: SessionEvent; note?: string } {
    const { call, ...visible } = event
    const previous = this.doc.panes[spawn.paneId]
    // Sem record (a conversa ainda não foi anunciada) não há onde somar: o
    // evento segue exatamente como o motor o emitiu, sem odômetro inventado.
    if (!previous) return { event: visible }

    const stored = isGuiConversationUsage(previous.conversationUsage)
      ? previous.conversationUsage
      : undefined
    const usage = call ? guiAddApiCall(stored, call) : stored

    // R25.3a — O MARCO SEGUE O CONTEXTO: sobe anunciando (cruzou 150k, 300k…)
    // e desce CALADO quando o contexto cai. É essa descida que re-arma o aviso
    // — depois de um `/compact` a conversa ficou barata de novo, e voltar a
    // engordar merece ouvir a receita outra vez.
    const stamped =
      typeof previous.heavyContextMilestone === 'number' &&
      Number.isSafeInteger(previous.heavyContextMilestone)
        ? previous.heavyContextMilestone
        : undefined
    const milestone = guiHeavyContextMilestone(visible.contextTokens)
    const announce = milestone !== null && (stamped === undefined || milestone > stamped)
    const nextStamp = milestone ?? undefined

    if (usage !== stored || nextStamp !== stamped) {
      const next: GuiSessionRecord = { ...previous, updatedAt: new Date().toISOString() }
      if (usage) next.conversationUsage = usage
      else delete next.conversationUsage
      if (nextStamp === undefined) delete next.heavyContextMilestone
      else next.heavyContextMilestone = nextStamp
      this.doc.panes[spawn.paneId] = next
      if (this.deps.storeFile) {
        try {
          persistJsonStore(this.deps.storeFile, this.doc)
        } catch {
          // O odômetro vivo continua correto em memória.
        }
      }
    }

    if (announce && milestone !== null) {
      this.deps.record?.(
        'gui-heavy-conversation',
        { paneId: spawn.paneId, projectId: spawn.projectId },
        {
          milestone,
          contextTokens: visible.contextTokens,
          apiCalls: usage?.apiCalls ?? 0,
          weightTokens: guiConversationWeightTokens(usage)
        }
      )
    }

    return {
      event: {
        ...visible,
        ...(usage
          ? {
              convCalls: usage.apiCalls,
              convWeightTokens: guiConversationWeightTokens(usage)
            }
          : {})
      },
      ...(announce && typeof visible.contextTokens === 'number'
        ? { note: guiHeavyConversationNote(visible.contextTokens) }
        : {})
    }
  }

  /** O odômetro morre com a CONVERSA (troca de identidade do resume). O
   *  `/clear` passa por `guiSessionWithoutResume`, que apaga os mesmos campos. */
  private forgetConversationUsage(paneId: string): void {
    const previous = this.doc.panes[paneId]
    if (!previous || (!previous.conversationUsage && previous.heavyContextMilestone === undefined))
      return
    const next = { ...previous, updatedAt: new Date().toISOString() }
    delete next.conversationUsage
    delete next.heavyContextMilestone
    this.doc.panes[paneId] = next
    if (!this.deps.storeFile) return
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // Estado vivo já está correto; o próximo checkpoint persiste.
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
    // R25.1 — O ODÔMETRO ATRAVESSA PELA MESMA PORTA DA FOTOGRAFIA. Este método
    // REESCREVE o record inteiro e todo respawn passa por aqui: sem esta
    // travessia, trocar o modo de permissão (ou qualquer respawn-com-resume)
    // zeraria o acumulado de uma conversa que nunca saiu do lugar — e o custo
    // do respawn é justamente o que o dono precisa ver SOMADO.
    const sameConversation =
      sameIdentity && Boolean(previous?.sessionId) && previous?.sessionId === nextSession
    const rememberedContext = sameConversation ? guiContextSnapshotFromRecord(previous) : undefined
    const rememberedUsage =
      sameConversation && isGuiConversationUsage(previous?.conversationUsage)
        ? previous.conversationUsage
        : undefined
    const rememberedMilestone =
      sameConversation &&
      typeof previous?.heavyContextMilestone === 'number' &&
      Number.isSafeInteger(previous.heavyContextMilestone)
        ? previous.heavyContextMilestone
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
      ...(delegation.seat ? { delegateSeat: delegation.seat } : {}),
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
      ...(rememberedUsage ? { conversationUsage: rememberedUsage } : {}),
      ...(rememberedMilestone !== undefined
        ? { heavyContextMilestone: rememberedMilestone }
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

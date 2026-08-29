import { create } from 'zustand'
import {
  asGuiEvent,
  guiApi,
  type GuiCliCaps,
  type GuiPermBehavior,
  type GuiQuestion,
  type GuiSessionEvent
} from './guiApi'
import type { PlanDraft } from './planContract'
import type {
  GuiAttachmentDescriptor,
  HistoryTranscriptMessage,
  SynkoraSettings,
  SynkoraSettingsPatch
} from '../../preload/index'
import { applyDeptHueVars, DEPT_HUES_LS_KEY, loadDeptHues } from './departments'
import { versionPortrait } from './projectLanding'
import { isReleaseMissionRecord } from './missionCardAccess'
import {
  guiResultEchoesSpeech,
  guiRoundClosed,
  guiRoundEarnsStamp,
  guiRoundStampText,
  trackGuiRoundWork,
  transitionGuiStartedAt
} from './guiActivity'
import { claimGuiItemId, guiItemId } from './guiItemIdentity'
import { guiPrunedEvicted, mergeGuiHistoryPage } from './guiHistoryReader'
import {
  countGuiOutputLines,
  denyLatestPendingGuiTool,
  guiToolResultTargetIndex,
  guiToolActivityText,
  isLaunchedGuiSubagentTool,
  lastPendingGuiToolActivity
} from './guiToolPresentation'
import {
  beginGuiSendBatch,
  canSendGuiMessage,
  guiCommandCompletionStatus,
  guiBackendReadyStatus,
  guiSessionRestartState,
  settleGuiRespawnStream,
  guiTransportFailureStatus,
  settleGuiActionFailure,
  settleGuiSendBatch,
  type GuiSendBatch
} from './guiTransport'
import {
  enqueueGuiInteraction as enqueueGuiInteractionQueue,
  guiInteractionBlocksTurn,
  removeGuiInteraction as removeGuiInteractionFromQueue,
  retainGuiInteractionsAfterTurnEnd,
  settleGuiInteractionFailure
} from './guiInteractionQueue'
import {
  closePendingGuiTools,
  guiClosedLine,
  guiSubagentChildClosure,
  hasPendingGuiTools,
  orphanedToolText,
  orphanedTurnTools,
  settleLaunchedGuiSubagents
} from './guiTerminalTools'
import {
  guiToolDiffInputSummary,
  normalizeGuiToolDiff,
  type GuiFileDiffSource
} from './guiToolDiff'
import type { GuiToolOutcome } from './guiToolOutcome'
import { pruneGuiDiffHistory } from './guiDiffHistory'
import {
  acknowledgeGuiQueuedMessage as acknowledgeGuiQueuedMessageStorage,
  claimGuiQueuedMessage as claimGuiQueuedMessageStorage,
  readGuiQueuedMessage,
  releaseGuiQueuedMessageClaim,
  removeGuiQueuedMessage as removeGuiQueuedMessageStorage,
  writeGuiQueuedMessage,
  type GuiQueuedMessage,
  type GuiQueuedOptions
} from './guiMessageQueue'
import { isGuiComposerAttachment } from './guiComposerAttachmentStorage'
import { GUI_COMPOSER_ATTACHMENT_MAX_FILES } from './guiComposerAttachments'
import {
  guiSubagentMetadataForTool,
  isGuiSubagentToolEvent,
  type GuiSubagentMetadata
} from './guiSubagentSidebar'
import type {
  SkillChatType,
  SkillDevWing,
  SkillsKitState,
  SkillsLibraryItem
} from './skillsSettingsModel'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  mode?: 'greenfield' | 'existing'
  planStatus?: 'draft' | 'approved' | 'in_progress' | 'revision_pending' | 'awaiting_release' | 'done'
  /** avatar do projeto (data URL) — rail estilo Discord */
  photo?: string
  /** pasta não existe mais (renomeada/movida fora do app) — computado no main */
  missing?: boolean
}

export type SeatCli = 'claude' | 'codex'
export type SeatStatus = 'logado' | 'pendente' | 'expirado'

export interface Seat {
  id: string
  name: string
  cli: SeatCli
  createdAt: string
  status: SeatStatus
  configDir: string
}

export type PaneKind = 'shell' | 'claude' | 'codex'
export type UniverseTab = 'board' | 'backlog' | 'arquivos' | 'mapa'
export type AppPage = 'workspace' | 'settings'
export type SettingsSection =
  | 'appearance'
  | 'accounts'
  | 'voice'
  | 'skills'

/** Versão do CLI que os panes executam (espelha `main/cliUpdate.ts`) — CLI
 *  velho não conhece modelo novo, então o app checa/atualiza sozinho. */
export interface CliStatus {
  cli: SeatCli
  version: string | null
  from?: string
  state: 'unknown' | 'updating' | 'current' | 'updated' | 'missing' | 'failed'
  detail?: string
  checkedAt: number
}

export type Department =
  | 'front'
  | 'back'
  | 'qa'
  | 'design'
  | 'research'
  | 'copy'
  | 'cyber'
  | 'data'
// OS TIPOS DE CARD (TaskStatus/TaskType/TaskEffort/TaskDelegationMode/
// TaskDeliverableKind/ManualSecurityValidation/PlanLane/TaskPlan/Task) e os de
// PERFIL DE MISSÃO (MissionExecutionMode/MissionRiskLevel) saíram na purga F6
// (2026-08-17): a missão 2.0 não tem card nem plano de lanes.

/** Recorte de UMA versão para os stats (decisão do usuário, 2026-07-29:
 *  acumulado nunca é global — somar a história inteira vira ruído; e pode
 *  haver 2/3/6 versões em desenvolvimento ao mesmo tempo, então o retrato é
 *  POR VERSÃO, nunca "a versão"). */
export interface VersionStats {
  name: string
  lancada: boolean
  /** missões da versão: entregues (deliveries) / entregues + vivas */
  missoesFeitas: number
  missoesTotal: number
}

export interface HomeStats {
  /** VIVOS, globais (nunca acumulam): missões 'ativa' + 'integrando' */
  missoesAtivas: number
  /** uma entrada por versão ABERTA (em dev), mais antiga primeiro; sem
   *  nenhuma aberta, a última LANÇADA entra sozinha como referência ("o que
   *  ela entregou"). Vazio = projeto nunca teve versão. */
  versoes: VersionStats[]
  /** O QUE ESTÁ NA MAIN: nome da última versão LANÇADA (ordem do dono,
   *  2026-08-17). Ausente = nada subiu ainda — e aí a tela não mostra chip de
   *  identidade nenhum, em vez de eleger a aberta mais antiga e chamá-la de
   *  "a versão do projeto". A régua mora em `projectLanding.versionPortrait`. */
  versaoNaMain?: string
  /** quando foi lido (a ausência da entrada é que significa "não li ainda") */
  at: number
}

// Missão (F3.8): fluxo de trabalho com orquestrador, tarefas e branch próprios.
export type MissionStatus = 'ativa' | 'integrando' | 'concluida' | 'arquivada'

/** NATUREZA da missão (2.0) — espelho de `src/main/guiMissionContracts`:
 *  - 'dev'          = a missão de sempre (branch/worktree isolados, ⇪ na fila);
 *  - 'planejamento' = UMA conversa na RAIZ do projeto que escreve `plano/`.
 *  Decidida no NASCIMENTO e nunca depois; missão legada não tem o carimbo. */
export type MissionType = 'dev' | 'planejamento' | 'release'

/** Tipo EFETIVO da missão: ausente/desconhecido é 'dev' por definição — nada
 *  do que já está no disco muda de natureza (mesma régua do `missionTypeOf`
 *  do main, para os dois lados lerem a mesma missão do mesmo jeito). */
export function missionTypeOf(mission?: { missionType?: MissionType } | null): MissionType {
  // R30: o espelho estava PARADO na era pré-R10 (sem 'release') — o main já
  // conhecia os três tipos e o renderer lia a subida como 'dev'. A régua de
  // "é o registro do release?" continua sendo isReleaseMissionRecord
  // (missionCardAccess) — aqui só o tipo efetivo, igual ao main.
  if (mission?.missionType === 'planejamento') return 'planejamento'
  if (mission?.missionType === 'release') return 'release'
  return 'dev'
}

export interface MissionIntegrationQueueView {
  state: 'queued' | 'sync_required' | 'blocked' | 'merging'
  position: number
  total: number
  lastError?: string
  owner?: 'maestro' | 'orchestrator'
}

export interface Mission {
  id: string
  projectId: string
  title: string
  goal?: string
  scope?: string
  status: MissionStatus
  branch?: string
  worktree?: string
  baseBranch?: string
  seatId?: string
  model?: string
  effort?: string
  /** 'direta' = registro de trabalho de agente livre (sem cards/orquestrador) */
  kind?: 'direta'
  /** MISSÃO 2.0 (onda B): sem orquestrador e sem maquinário de plano — abrir a
   *  aba abre um CHAT GUI no worktree. TODA missão criada pelo usuário nasce
   *  com este carimbo; missão legada (sem o campo) mantém o fluxo de hoje. */
  direct?: boolean
  /** 2.0: 'planejamento' abre a conversa que escreve `plano/` na RAIZ do
   *  projeto (sem branch, sem worktree, fora da fila); ausente = 'dev'. */
  missionType?: MissionType
  /** criada pelo PM: aguarda o usuário escolher conta/modelo/effort do
   *  orquestrador no modal — o pane só nasce depois */
  pendingOrchestrator?: boolean
  /** agente pediu integrar via MCP: merge aguarda o AVAL do dono no botão ⇪ */
  pendingIntegrationApproval?: boolean
  /** versão do app a que a missão pertence (integra na branch da versão) */
  versionId?: string
  /** Lugar desta missão na fila serial de integração do projeto. */
  integration?: MissionIntegrationQueueView
  createdAt: string
  /** ATENÇÃO: `updatedAt` é MUTAÇÃO DE STORE (status, seat, branch) — nunca
   *  atividade. Turno de chat, tool call e commit não passam por aqui, então
   *  rotular este campo como "última atividade" seria mentira. */
  updatedAt: string
  /** carimbo da transição para 'concluida' — a data honesta de "integrada em" */
  completedAt?: string
}

/** O que o modal de missão manda para o main ao criar uma missão. */
export interface NewMissionInput {
  title: string
  goal?: string
  scope?: string
  seatId?: string
  model?: string
  effort?: string
  versionId?: string
  /** missão 2.0: sem orquestrador, chat GUI no worktree (onda B) */
  direct?: boolean
  /** 2.0: 'planejamento' cria a missão que escreve `plano/` em vez de código;
   *  omitido = 'dev'. Só o NASCIMENTO decide (o main carimba e nunca revisita).
   *  R30: 'release' fica FORA de propósito — o registro da subida nasce no
   *  main (ensureReleaseMission), nunca pelo modal. */
  missionType?: Exclude<MissionType, 'release'>
}

// Backlog de produto: versões como escopo de planejamento + itens desejados.
export type VersionStatus = 'aberta' | 'lancada'
export type BacklogItemType = 'feature' | 'bug' | 'melhoria'
export type BacklogItemStatus = 'pendente' | 'em-missao' | 'feito'

/** Entrega automática: missão da versão integrou na branch da versão. */
export interface VersionDelivery {
  id: string
  missionId: string
  title: string
  at: string
}

export interface Version {
  id: string
  projectId: string
  name: string
  theme?: string
  goal?: string
  status: VersionStatus
  /** quando foi lançada (a mais recente = versão ATUAL na main) */
  releasedAt?: string
  /** o que já subiu nesta versão (automático, na integração da missão) */
  deliveries: VersionDelivery[]
  /** branch version/<nome> que acumula as missões até o release */
  branch?: string
  worktree?: string
  createdAt: string
  updatedAt: string
}

/** R27F2 — espelho de `ReleaseRecord` (main/releasesStore, via preload
 *  `VersionReleaseRecord` — o par declarado): o RETRATO de uma subida que a
 *  aba Versões lê. Nasce no sucesso do release; o renderer só consome. */
export interface VersionReleaseRecord {
  id: string
  projectId: string
  versionId: string
  versionName: string
  missionId?: string
  at: string
  actor: string
  mergeDetail: string
  push: { attempted: boolean; ok?: boolean; error?: string }
  bump?: { version: string; committed: boolean }
  publishRequired: boolean
  outcome: string
}

export interface BacklogItem {
  id: string
  projectId: string
  versionId?: string
  type: BacklogItemType
  title: string
  notes?: string
  status: BacklogItemStatus
  missionId?: string
  createdAt: string
  updatedAt: string
}

/** Arquivo .md do projeto (aba Arquivos). */
export interface DocFile {
  path: string
  name: string
  group: 'projeto' | 'docs' | 'synkora' | 'transcripts'
  mtime: number
  size: number
}

// A POLÍTICA DE MODELOS POR FUNÇÃO (PolicySlot/DeptPolicy/ProjectPolicies)
// saiu na purga F6: quem escolhe conta e modelo na era 2.0 é o dono, dentro
// da conversa.

export interface CatalogModel {
  id: string
  label: string
  efforts?: string[]
  defaultEffort?: string
  /** R13 — espelho de `src/main/catalog.ts` (via preload): a marca que o
   *  painel D8 usa para só oferecer o ⚡ onde ele vale. */
  supportsFastMode?: boolean
}

export interface Catalog {
  models: CatalogModel[]
  efforts: string[]
}

// O ESPELHO DO CHAT DO MAESTRO (MaestroEvent, PermissionChoice, CliCommand,
// CliModel, MaestroCaps, MaestroPermRequest, MaestroLiveEvent) morreu na purga
// F6 (2026-08-17) com o painel que ele desenhava.

/** Estado vivo de um pane: saída fluindo / ocioso aguardando / processo morto. */
export type PaneActivity = 'run' | 'idle' | 'dead'

/** Telemetria viva de um pane, lida dos JSONL de sessão que o próprio CLI grava. */
export interface PaneStats {
  model?: string
  inputTokens: number
  outputTokens: number
  freshInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  contextTokens: number | null
  contextWindow: number | null
  costUsd?: number
}

// O pane GUI substitui a TUI por um CHAT: o motor é o mesmo (maestroSession /
// codexSession, agora por pane) e o renderer só acumula os eventos de
// `gui:live`. Contrato completo em docs/GUI_PANE_CONTRACT.md.

/** starting = sessão nascendo · working = turno em curso · waiting-you =
 *  permissão pendente · idle = turno fechado · dead = sessão encerrada. */
export type GuiPaneStatus = 'starting' | 'working' | 'waiting-you' | 'idle' | 'dead'

/** Item cronológico do chat. Tool card e marcador de permissão entram na MESMA
 *  lista das mensagens — a ordem do que aconteceu É a informação. */
export type GuiItem =
  | {
      id: string
      kind: 'user'
      text: string
      /** Metadados já validados pelo main; caminhos nunca são renderizados. */
      attachments?: GuiAttachmentDescriptor[]
      at: number
    }
  | {
      id: string
      kind: 'note' | 'error'
      text: string
      at: number
      /** Aviso provisório enquanto um resultado de ferramenta correlacionado
       * ainda pode chegar depois do terminal do turno. */
      transient?: boolean
    }
  | {
      id: string
      kind: 'assistant'
      text: string
      at: number
      /** true enquanto ainda podem chegar deltas para ESTE mesmo item */
      live: boolean
      /** prefixo já revelado; replay começa no fim para não redigitar histórico */
      animateFrom: number
    }
  | {
      id: string
      kind: 'tool'
      name: string
      summary: string
      toolUseId?: string
      /** Relação explícita recebida do Claude. Ausente continua sendo uma tool
       *  comum (inclusive no Codex); o renderer não infere subagente. */
      parentToolUseId?: string
      /** Metadados factuais do input de Task/Agent, normalizados no reducer. */
      subagent?: GuiSubagentMetadata
      /** Payload de edição já normalizado e limitado; o input cru não fica no store. */
      fileDiffs?: GuiFileDiffSource[]
      result?: {
        text: string
        isError: boolean
        /** `cancelled` é terminal sem conclusão (Esc/encerramento); não pode
         *  parecer sucesso nem continuar pulsando como se ainda rodasse. */
        status?: GuiToolOutcome
        /** `result` fechou o turno antes do `tool-result`; um resultado
         * correlacionado posterior ainda pode substituir este desfecho. */
        provisional?: boolean
        /** Ciclo de vida do subagente em background (Claude): 'launched' é só o
         *  recibo de despacho — o agente segue vivo e o card ainda espera o
         *  'settled' factual. Ausente = desfecho comum (inclusive Codex). */
        agentStatus?: 'launched' | 'settled'
        /** task_id do CLI, para correlacionar o recibo com o terminal. */
        agentTaskId?: string
        /** Calculado no backend ANTES do corte de memória. */
        lineCount: number
        truncated: boolean
      }
      at: number
    }
  | {
      id: string
      kind: 'permission'
      toolName: string
      behavior: GuiPermBehavior | 'cancelada'
      at: number
    }
  /** Pergunta JÁ respondida: o fio guarda o que foi escolhido (o card some
   *  quando a resposta sai). `entries` vazio = o dono pulou. */
  | {
      id: string
      kind: 'question'
      header?: string
      entries: { question: string; answer: string }[]
      at: number
    }

/** Pedido de permissão vivo do CLI (mesma forma do PermPicker do espelho). */
export interface GuiPendingPerm {
  requestId: string
  toolUseId?: string
  toolName: string
  description: string
  inputPretty: string
  reason?: string
  /** Regra exata que será gravada ao escolher "sempre". */
  permissionRule?: string
  canAlways: boolean
}

export type GuiPendingInteraction =
  | { kind: 'permission'; requestId: string; perm: GuiPendingPerm }
  | {
      kind: 'question'
      requestId: string
      question: { requestId: string; questions: GuiQuestion[] }
    }
  | {
      kind: 'plan'
      requestId: string
      planReview: { requestId: string; plan: string }
    }
  /** PROPOSTA de plano (D4.4): entra na MESMA fila das outras decisões e por
   *  isso ganha de graça o pulso "esperando você", a ordem por requestId e a
   *  sobrevivência à remontagem. */
  | {
      kind: 'plan-proposal'
      requestId: string
      planProposal: { requestId: string; draft: PlanDraft }
    }

export interface GuiPaneState {
  items: GuiItem[]
  /** turno em curso: deltas acumulados até o `text` final fechar a mensagem */
  stream: string
  /** item assistant estável alimentado pelos deltas do turno */
  activeAssistantId: string | null
  thinking: boolean
  /** delta do raciocínio, quando o backend fornece (campo aditivo do contrato) */
  thinkingText: string
  /** Fila canônica por requestId; os campos escalares abaixo são apenas a
   * interação da frente, para manter os componentes pequenos. */
  interactionQueue: GuiPendingInteraction[]
  interactionSubmitting: string | null
  perm: GuiPendingPerm | null
  /** pergunta com opções esperando o dono (AskUserQuestion) */
  question: { requestId: string; questions: GuiQuestion[] } | null
  /** plano esperando veredito (ExitPlanMode): construir × revisar */
  planReview: { requestId: string; plan: string } | null
  /** proposta de plano esperando o dono (propose_plan): criar × ajustar */
  planProposal: { requestId: string; draft: PlanDraft } | null
  /** caps REAIS do CLI (evento `ready`): comandos do autocomplete e catálogo
   *  de modelos/efforts dos seletores do composer */
  caps: GuiCliCaps | null
  status: GuiPaneStatus
  /** relógio do turno; sobrevive a waiting-you e zera em idle/dead */
  startedAt: number | null
  /** a rodada em curso PRODUZIU alguma coisa (item novo depois que ela abriu)
   *  — o que separa a rodada de verdade da fantasma na hora do selo (R21.4) */
  roundWorked: boolean
  /** atividade factual (ex.: ferramenta real); vence o verbo cosmético */
  activityText: string | null
  sessionId: string | null
  /** Modelo efetivo anunciado pelo backend (`init`). */
  model: string | null
  /** Override escolhido no composer; `null` = padrão do CLI. */
  executorModel: string | null
  /** Override de raciocínio; `null` = padrão do modelo. */
  effort: string | null
  /** Houve uma escolha canônica no composer, inclusive `null` = padrão. */
  executorKnown: boolean
  contextTokens: number | null
  contextWindow: number | null
  costUsd: number | null
  /**
   * R25.1 — O ODÔMETRO DA CONVERSA, como o main o acumulou: chamadas de API e
   * peso aproximado de cota. Espelho declarado de `GuiSessionEvent`
   * (guiApi.ts) — chega de carona na fotografia sticky de `context-usage`,
   * então a remontagem o recebe no replay sem pedir nada a ninguém.
   */
  convCalls: number | null
  convWeightTokens: number | null
  /** handshake concluído (evento `ready` com as caps reais do CLI) */
  ready: boolean
  /** versão monotônica dos eventos reais do backend; operações assíncronas
   *  antigas nunca podem sobrescrever um turno que já avançou. */
  eventRevision: number
  /** lote de envios IPC sobrepostos, usado para fechar apenas o turno otimista
   *  que nenhuma das mensagens conseguiu iniciar. */
  sendBatch: GuiSendBatch | null
  error: string | null
  /** Código com que o processo desta conversa saiu (R23.2). É o que deixa o
   *  composer do pane morto dizer a VERDADE — "a sessão morreu (código 1)" — em
   *  vez de um beco sem saída. `null` = morte sem código provado (a nota não
   *  inventa número) ou conversa viva. */
  exitCode: number | null
  /** já houve mensagem do assistente NESTE turno — sem isso o `resultText`
   *  (que só existe para comandos locais) duplicaria a resposta */
  turnHadText: boolean
  /** `gui:create` já foi pedido para este pane nesta janela */
  spawned: boolean
  queued: GuiQueuedMessage | null
  /** R24.1 — eventos que a poda do anel descartou nesta conversa. `0` = o fio
   *  começa onde a conversa começou; `> 0` arma a linha-verdade do topo. */
  prunedEvents: number
}

/** Transcript local, já sanitizado no main, aberto pela paleta — ou pelo
 * próprio pane (R24.2) — sobre o pane GUI correspondente. É uma leitura
 * efêmera: nunca substitui o fio vivo. */
export interface GuiHistoryTarget {
  paneId: string
  sessionId: string
  provider: 'claude' | 'codex'
  messages: HistoryTranscriptMessage[]
  targetMessageId: string
  targetCursor: number
  truncated: boolean
  /** R24.3 — ficou conversa fora desta página. Só o alvo aberto PELO PANE os
   *  define: o alvo da paleta pode ser de outra conversa, e paginar a partir
   *  dele leria o transcript errado. Ausente = sem paginação nesta leitura. */
  hasMoreBefore?: boolean
  hasMoreAfter?: boolean
}

export const EMPTY_GUI_PANE: GuiPaneState = {
  items: [],
  stream: '',
  activeAssistantId: null,
  thinking: false,
  thinkingText: '',
  interactionQueue: [],
  interactionSubmitting: null,
  perm: null,
  question: null,
  planReview: null,
  planProposal: null,
  caps: null,
  status: 'starting',
  startedAt: null,
  roundWorked: false,
  activityText: null,
  sessionId: null,
  model: null,
  executorModel: null,
  effort: null,
  executorKnown: false,
  contextTokens: null,
  contextWindow: null,
  costUsd: null,
  convCalls: null,
  convWeightTokens: null,
  ready: false,
  eventRevision: 0,
  sendBatch: null,
  error: null,
  exitCode: null,
  turnHadText: false,
  spawned: false,
  queued: null,
  prunedEvents: 0
}

function safeGuiItemAttachments(value: unknown): GuiAttachmentDescriptor[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (value.length > GUI_COMPOSER_ATTACHMENT_MAX_FILES) return undefined
  const attachments = value.filter(isGuiComposerAttachment).map((attachment) => ({ ...attachment }))
  if (attachments.length !== value.length) return undefined
  const ids = new Set<string>()
  const capabilities = new Set<string>()
  for (const attachment of attachments) {
    if (ids.has(attachment.id) || capabilities.has(attachment.capability)) return undefined
    ids.add(attachment.id)
    capabilities.add(attachment.capability)
  }
  return attachments
}

function guiInteractionPatch(
  queue: GuiPendingInteraction[],
  submitting: string | null = null
): Pick<
  GuiPaneState,
  | 'interactionQueue'
  | 'interactionSubmitting'
  | 'perm'
  | 'question'
  | 'planReview'
  | 'planProposal'
> {
  const active = queue[0]
  return {
    interactionQueue: queue,
    interactionSubmitting:
      submitting && queue.some((item) => item.requestId === submitting) ? submitting : null,
    perm: active?.kind === 'permission' ? active.perm : null,
    question: active?.kind === 'question' ? active.question : null,
    planReview: active?.kind === 'plan' ? active.planReview : null,
    planProposal: active?.kind === 'plan-proposal' ? active.planProposal : null
  }
}

function enqueueGuiInteraction(
  state: GuiPaneState,
  interaction: GuiPendingInteraction
): ReturnType<typeof guiInteractionPatch> {
  return guiInteractionPatch(
    enqueueGuiInteractionQueue(state.interactionQueue, interaction),
    state.interactionSubmitting
  )
}

function removeGuiInteraction(
  state: GuiPaneState,
  requestId: string
): ReturnType<typeof guiInteractionPatch> {
  return guiInteractionPatch(
    removeGuiInteractionFromQueue(state.interactionQueue, requestId),
    state.interactionSubmitting === requestId ? null : state.interactionSubmitting
  )
}

/** Teto de itens por pane: o main guarda ~500 eventos no ring buffer, então
 *  reter mais que isto no renderer só custaria memória. */
const GUI_ITEM_CAP = 400
/** Resultado de ferramenta pode vir enorme (um `cat` inteiro) — o card mostra
 *  o começo e o resto não fica na memória do renderer. */
const GUI_TOOL_RESULT_CAP = 4000

// A identidade dos itens do fio mora em `guiItemIdentity.ts`: ela precisa
// sobreviver ao boot do renderer, porque o transcript persistido devolve ids da
// geração anterior na hidratação. Contador puro de processo re-cunhava esses
// mesmos ids e duplicava a bolha do dono depois de reabrir o app.

/** A poda nunca pode evictar o card de um subagente ainda VIVO: sem o pai, a
 *  lateral perde a ficha e os filhos vazam para a conversa. Ele é limitado por
 *  natureza (o agente assenta), então o excedente cai no próximo mais antigo.
 *
 *  TODO: o ring do main (500 eventos / 4MB) não tem a mesma retenção — um
 *  transcript longo pode aparar o `tool` do pai antes do settled e a remontagem
 *  nasce sem a ficha. Degradação aceita por ora (o chat segue limpo: card com
 *  `parentToolUseId` nunca é promovido a raiz da conversa). */
function capGuiItems(items: GuiItem[]): GuiItem[] {
  let excess = items.length - GUI_ITEM_CAP
  if (excess <= 0) return items
  const kept: GuiItem[] = []
  for (const item of items) {
    // A ficha INTERROMPIDA (R6.1) também não se poda: é o único lugar onde o
    // dono vê a frota retomável — uma conversa longa a comeria em silêncio.
    const protectedCard =
      item.kind === 'tool' &&
      (isLaunchedGuiSubagentTool(item) || item.result?.status === 'interrupted')
    if (excess > 0 && !protectedCard) {
      excess -= 1
      continue
    }
    kept.push(item)
  }
  return kept
}

function pushGuiItem(items: GuiItem[], item: GuiItem): GuiItem[] {
  const next = [...items, item]
  const capped = capGuiItems(next)
  return item.kind === 'tool' && item.fileDiffs?.length
    ? pruneGuiDiffHistory(capped)
    : capped
}

function guiOneLine(text: string, cap = 140): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat
}

/** Resumo de UMA LINHA do input da ferramenta: o card compacto mostra o que
 *  interessa (comando, arquivo, padrão) sem obrigar a abrir o JSON. */
const GUI_TOOL_KEYS = [
  'command',
  'file_path',
  'path',
  'notebook_path',
  'pattern',
  'query',
  'url',
  'prompt',
  'description'
]

export function guiToolSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of GUI_TOOL_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return guiOneLine(value)
  }
  const diffSummary = guiToolDiffInputSummary(input)
  if (diffSummary !== undefined) return guiOneLine(diffSummary)
  const keys = Object.keys(input)
  if (!keys.length) return ''
  try {
    return guiOneLine(JSON.stringify(input))
  } catch {
    return keys.join(', ')
  }
}

function guiStatusPatch(
  state: GuiPaneState,
  status: GuiPaneStatus,
  now = Date.now()
): Pick<GuiPaneState, 'status' | 'startedAt'> {
  return {
    status,
    startedAt: transitionGuiStartedAt(state.startedAt, status, now)
  }
}

/**
 * O assistant já nasce no primeiro delta e conserva o MESMO id até o fim.
 * Finalizar só fecha esse item — não o desmonta/recria — para o revelador
 * palavra a palavra drenar mesmo se `text`, `tool` e `result` chegarem juntos.
 */
function finalizeGuiStream(state: GuiPaneState): GuiPaneState {
  if (!state.activeAssistantId) return state.stream ? { ...state, stream: '' } : state
  const activeId = state.activeAssistantId
  let found = false
  const items = state.items.map((item) => {
    if (item.id !== activeId || item.kind !== 'assistant') return item
    found = true
    return { ...item, live: false }
  })
  return {
    ...state,
    items,
    stream: '',
    activeAssistantId: null,
    turnHadText: state.turnHadText || found
  }
}

/** Replay é fotografia, não espetáculo: histórico entra integralmente. Se o
 *  último item ainda está vivo, só os deltas NOVOS animam a partir do fim. */
function settleGuiReplay(state: GuiPaneState): GuiPaneState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'assistant' ? { ...item, animateFrom: item.text.length } : item
    )
  }
}

function guiInteractiveFailure(
  state: GuiPaneState,
  requestId: string,
  label: string,
  error: string | undefined,
  retryable: boolean
): GuiPaneState {
  const stillPending = state.interactionQueue.some((item) => item.requestId === requestId)
  const queue = settleGuiInteractionFailure(
    state.interactionQueue,
    requestId,
    retryable && state.status !== 'dead'
  )
  const interaction = guiInteractionPatch(queue)
  const base = { ...state, ...interaction }
  const status =
    base.status === 'dead'
      ? 'dead'
      : base.interactionQueue.length > 0
        ? 'waiting-you'
        : stillPending
          ? 'idle'
          : base.status
  return {
    ...base,
    items: pushGuiItem(base.items, {
      id: guiItemId(),
      kind: 'error',
      text: label + ' — ' + (error ?? 'a sessão não respondeu'),
      at: Date.now()
    }),
    activityText: status === 'waiting-you' ? null : base.activityText,
    ...guiStatusPatch(base, status)
  }
}

/**
 * Redutor PURO de um pane GUI. O mesmo código serve para o evento vivo e para
 * o replay de `gui:state` na remontagem — é isso que faz reabrir a aba
 * reconstruir a conversa exatamente como ela estava.
 */
function reduceGuiEvent(state: GuiPaneState, evt: GuiSessionEvent): GuiPaneState {
  // Duas perguntas diferentes, e confundi-las apagou o card da proposta:
  // `halted` = "há algo esperando o dono?" (vale na BARREIRA do turno, para
  // rotular a espera); `blocks` = "o fio está PARADO?" (vale no MEIO do turno).
  // A proposta de plano espera o dono sem parar o CLI, então ela conta na
  // primeira e nunca na segunda — espelho de `guiSurvivesTurnEnd` no anel do
  // main. Com ela contando como parada, cada delta seguinte virava
  // `waiting-you` e o card subia por cima da fala em andamento.
  const halted = (s: GuiPaneState): boolean => s.interactionQueue.length > 0
  const blocks = (s: GuiPaneState): boolean => guiInteractionBlocksTurn(s.interactionQueue)
  const busy = (s: GuiPaneState): GuiPaneStatus =>
    blocks(s) ? 'waiting-you' : s.status === 'dead' ? 'dead' : 'working'

  switch (evt.type) {
    case 'init':
      {
        const status = guiBackendReadyStatus(state.status)
        return {
          ...state,
          model: evt.model || state.model,
          sessionId: evt.sessionId || state.sessionId,
          contextWindow: evt.contextWindow ?? state.contextWindow,
          ...guiStatusPatch(state, status)
        }
      }

    case 'context-usage':
      // O main já validou a telemetria do backend. Atribuição direta é
      // intencional: `null` apaga uma medição antiga quando não há métrica
      // canônica para a geração atual.
      return {
        ...state,
        contextTokens: evt.contextTokens,
        contextWindow: evt.contextWindow,
        // R25.1 — o ODÔMETRO é a outra régua e não segue a primeira: gasto não
        // se desfaz. Uma fotografia sem medição (a compactação zera os dois
        // números acima) conserva o total que o main já contou.
        convCalls: evt.convCalls ?? state.convCalls,
        convWeightTokens: evt.convWeightTokens ?? state.convWeightTokens
      }

    case 'session-id':
      return { ...state, sessionId: evt.sessionId }

    case 'history-pruned': {
      // R24.1 — o anel do main descartou os eventos mais antigos: o fio na
      // tela começa DEPOIS do começo da conversa. Só cresce (o replay traz a
      // contagem afinada; o aviso ao vivo, a primeira notícia) e só o
      // `conversation-cleared` zera, porque ali a conversa é outra.
      const evicted = guiPrunedEvicted(evt)
      if (evicted === null || evicted <= state.prunedEvents) return state
      return { ...state, prunedEvents: evicted }
    }

    case 'executor-changed':
      return {
        ...state,
        executorModel: evt.model,
        effort: evt.effort,
        executorKnown: true
      }

    case 'session-restarted':
      {
        const restart = guiSessionRestartState(
          state.ready,
          evt.ready,
          evt.resumed === true,
          state.status
        )
        // QUIETO (R12/A4): a conversa é a mesma, então o chrome não se
        // reapresenta — status, caps e a escolha de executor ficam de pé (o
        // `executor-changed` que o main emite logo atrás continua sendo a
        // verdade), e a fotografia ausente NÃO apaga o medidor de uma conversa
        // que continua. Geração nova segue zerando tudo.
        const quiet = restart.status === null
        return {
          ...state,
          ready: restart.ready,
          caps: quiet || restart.ready ? state.caps : null,
          executorModel: quiet ? state.executorModel : null,
          effort: quiet ? state.effort : null,
          executorKnown: quiet ? state.executorKnown : false,
          // O main anexa a fotografia somente quando este restart retoma a
          // mesma identidade. Sem os campos, a geração é nova e a medição
          // antiga deve desaparecer; com eles, o contexto já usado volta
          // imediatamente antes do primeiro novo envio.
          contextTokens: evt.contextTokens ?? (quiet ? state.contextTokens : null),
          contextWindow: evt.contextWindow ?? (quiet ? state.contextWindow : null),
          // R25.1 — o odômetro acompanha: conversa que CONTINUA (respawn com
          // resume) conserva o acumulado que o main persistiu; geração NOVA
          // zera, porque odômetro de outra conversa na tela seria mentira.
          convCalls: quiet ? state.convCalls : null,
          convWeightTokens: quiet ? state.convWeightTokens : null,
          activityText: null,
          sendBatch: null,
          error: null,
          // A geração nova não herda a morte da anterior: o código do processo
          // que caiu morre com ele (R23.2).
          exitCode: null,
          ...(restart.status === null ? {} : guiStatusPatch(state, restart.status))
        }
      }

    case 'conversation-cleared':
      // O processo novo pode ter emitido init/ready antes deste marco. Limpa
      // somente o fio antigo e conserva a identidade/capacidades JÁ novas.
      return {
        ...EMPTY_GUI_PANE,
        spawned: state.spawned,
        ready: state.ready,
        caps: state.caps,
        sessionId: state.sessionId,
        model: state.model,
        executorModel: state.executorModel,
        effort: state.effort,
        executorKnown: state.executorKnown,
        status: state.ready ? 'idle' : 'starting',
        eventRevision: state.eventRevision
      }

    case 'ready':
      // As caps FICAM: são elas que alimentam o autocomplete de comandos e os
      // seletores de modelo/effort do composer (antes eram descartadas aqui).
      {
        const status = guiBackendReadyStatus(state.status)
        return {
          ...state,
          ready: true,
          caps: evt.caps ?? state.caps,
          ...guiStatusPatch(state, status)
        }
      }

    case 'delta': {
      const text = state.stream + evt.text
      let activeAssistantId = state.activeAssistantId
      let found = false
      let items = state.items.map((item) => {
        if (item.id !== activeAssistantId || item.kind !== 'assistant') return item
        found = true
        return { ...item, text, live: true }
      })
      if (!activeAssistantId || !found) {
        activeAssistantId = guiItemId()
        items = pushGuiItem(items, {
          id: activeAssistantId,
          kind: 'assistant',
          text,
          at: Date.now(),
          live: true,
          animateFrom: 0
        })
      }
      return {
        ...state,
        items,
        stream: text,
        activeAssistantId,
        thinking: false,
        activityText: null,
        turnHadText: true,
        ...guiStatusPatch(state, busy(state))
      }
    }

    case 'thinking':
      return {
        ...state,
        thinking: true,
        thinkingText: evt.text ? state.thinkingText + evt.text : state.thinkingText,
        ...guiStatusPatch(state, busy(state))
      }

    case 'user-message': {
      if (state.items.some((item) => item.kind === 'user' && item.id === evt.id)) return state
      const attachments = safeGuiItemAttachments(evt.attachments)
      return {
        ...state,
        items: pushGuiItem(state.items, {
          id: evt.id,
          kind: 'user',
          text: evt.text,
          ...(attachments ? { attachments } : {}),
          at: evt.at
        })
      }
    }

    case 'turn-started': {
      const startingNewTurn = state.status !== 'working'
      return {
        ...state,
        thinking: false,
        activityText: startingNewTurn ? null : state.activityText,
        turnHadText: startingNewTurn ? false : state.turnHadText,
        ...guiStatusPatch(state, busy(state))
      }
    }

    case 'text': {
      if (!evt.text.trim()) return finalizeGuiStream(state)
      const activeId = state.activeAssistantId
      let found = false
      let items = state.items.map((item) => {
        if (item.id !== activeId || item.kind !== 'assistant') return item
        found = true
        return {
          ...item,
          text: evt.text,
          live: false,
          animateFrom: Math.min(item.animateFrom, evt.text.length)
        }
      })
      if (!activeId || !found) {
        items = pushGuiItem(items, {
          id: guiItemId(),
          kind: 'assistant',
          text: evt.text,
          at: Date.now(),
          live: false,
          animateFrom: 0
        })
      }
      return {
        ...state,
        items,
        stream: '',
        activeAssistantId: null,
        thinking: false,
        thinkingText: '',
        activityText: null,
        turnHadText: true,
        ...guiStatusPatch(state, busy(state))
      }
    }

    case 'tool': {
      const summary = guiToolSummary(evt.input)
      const fileDiffs = normalizeGuiToolDiff(evt.name, evt.input)
      const subagent = guiSubagentMetadataForTool(evt.name, evt.input)
      const background = isGuiSubagentToolEvent(evt)
      const base = background ? state : finalizeGuiStream(state)
      return {
        ...base,
        items: pushGuiItem(base.items, {
          id: guiItemId(),
          kind: 'tool',
          name: evt.name,
          summary,
          toolUseId: evt.toolUseId,
          parentToolUseId: evt.parentToolUseId,
          ...(subagent ? { subagent } : {}),
          ...(fileDiffs ? { fileDiffs } : {}),
          at: Date.now()
        }),
        thinking: background ? base.thinking : false,
        activityText: background ? base.activityText : guiToolActivityText(evt.name, summary),
        ...guiStatusPatch(base, busy(base))
      }
    }

    case 'tool-result': {
      // Id do protocolo vence; o último card pendente é só compatibilidade
      // com payloads gravados antes de os backends propagarem toolUseId.
      const items = [...state.items]
      const target = guiToolResultTargetIndex(items, evt.toolUseId)
      if (target < 0) return state
      const item = items[target]
      if (item.kind !== 'tool') return state
      const hadProvisional = item.result?.provisional === true
      const text = evt.text.slice(0, GUI_TOOL_RESULT_CAP)
      items[target] = {
        ...item,
        result: {
          text,
          isError: evt.isError,
          status: evt.outcome ?? (evt.isError ? 'failed' : 'completed'),
          lineCount: evt.lineCount ?? countGuiOutputLines(evt.text),
          truncated: Boolean(evt.truncated) || evt.text.length > GUI_TOOL_RESULT_CAP,
          ...(evt.agentStatus ? { agentStatus: evt.agentStatus } : {}),
          ...(evt.agentTaskId ? { agentTaskId: evt.agentTaskId } : {})
        }
      }
      // Terminal factual do subagente: o protocolo do Claude nunca entrega
      // tool-result de filho, então quem fecha os cards da thread é o pai.
      if (evt.agentStatus === 'settled' && item.toolUseId) {
        const parentToolUseId = item.toolUseId
        const closure = guiSubagentChildClosure()
        for (let index = 0; index < items.length; index += 1) {
          const child = items[index]
          if (child.kind !== 'tool' || child.result) continue
          if (child.parentToolUseId !== parentToolUseId) continue
          items[index] = { ...child, result: closure }
        }
      }
      // O erro criado por um `result` sem tool-result é apenas um aviso de
      // reconciliação. Só removê-lo quando o último card provisório recebeu
      // seu resultado autoritativo; um órfão real continua visível.
      if (
        hadProvisional &&
        !items.some(
          (candidate) =>
            candidate.kind === 'tool' && candidate.result?.provisional === true
        )
      ) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const candidate = items[index]
          if (candidate.kind === 'error' && candidate.transient === true)
            items.splice(index, 1)
        }
      }
      return { ...state, items, activityText: lastPendingGuiToolActivity(items) }
    }

    case 'permission': {
      const base = finalizeGuiStream(state)
      const perm: GuiPendingPerm = {
        requestId: evt.requestId,
        ...(evt.toolUseId ? { toolUseId: evt.toolUseId } : {}),
        toolName: evt.toolName,
        description: evt.description,
        inputPretty: evt.inputPretty,
        reason: evt.reason,
        ...(evt.permissionRule ? { permissionRule: evt.permissionRule } : {}),
        canAlways: evt.canAlways
      }
      return {
        ...base,
        ...enqueueGuiInteraction(base, {
          kind: 'permission',
          requestId: evt.requestId,
          perm
        }),
        thinking: false,
        activityText: null,
        ...guiStatusPatch(base, 'waiting-you')
      }
    }

    case 'question': {
      const base = finalizeGuiStream(state)
      const question = { requestId: evt.requestId, questions: evt.questions }
      return {
        ...base,
        ...enqueueGuiInteraction(base, {
          kind: 'question',
          requestId: evt.requestId,
          question
        }),
        thinking: false,
        activityText: null,
        ...guiStatusPatch(base, 'waiting-you')
      }
    }

    case 'plan-review': {
      const base = finalizeGuiStream(state)
      const planReview = { requestId: evt.requestId, plan: evt.plan }
      return {
        ...base,
        ...enqueueGuiInteraction(base, {
          kind: 'plan',
          requestId: evt.requestId,
          planReview
        }),
        thinking: false,
        activityText: null,
        ...guiStatusPatch(base, 'waiting-you')
      }
    }

    case 'plan-proposal': {
      // A proposta é a única decisão que chega COM O AGENTE AINDA FALANDO: a
      // tool responde na hora e o turno segue. Tratá-la como as irmãs
      // bloqueantes (fechar o stream, matar o indicador, carimbar
      // `waiting-you`) fingia um fim de turno que não aconteceu — a fala
      // continuava por baixo de um card que já tinha subido. Com um turno em
      // voo ela só ENTRA NA FILA e espera; quem a anuncia é o `result`.
      const turnInFlight = state.status === 'working'
      const base = turnInFlight ? state : finalizeGuiStream(state)
      const planProposal = { requestId: evt.requestId, draft: evt.draft }
      const queued = enqueueGuiInteraction(base, {
        kind: 'plan-proposal',
        requestId: evt.requestId,
        planProposal
      })
      if (turnInFlight) return { ...base, ...queued }
      return {
        ...base,
        ...queued,
        thinking: false,
        activityText: null,
        ...guiStatusPatch(base, 'waiting-you')
      }
    }

    case 'interaction-resolved': {
      const hadPending = state.interactionQueue.some(
        (item) => item.requestId === evt.requestId
      )
      const interaction = removeGuiInteraction(state, evt.requestId)
      let items = state.items
      if (evt.resolution.kind === 'permission') {
        items = pushGuiItem(items, {
          id: guiItemId(),
          kind: 'permission',
          toolName: evt.resolution.toolName,
          behavior: evt.resolution.behavior,
          at: Date.now()
        })
        if (evt.resolution.behavior === 'deny') {
          items = denyLatestPendingGuiTool(
            items,
            evt.resolution.toolName,
            evt.resolution.toolUseId
          )
        }
      } else if (evt.resolution.kind === 'question') {
        items = pushGuiItem(items, {
          id: guiItemId(),
          kind: 'question',
          entries: evt.resolution.entries,
          at: Date.now()
        })
      } else if (evt.resolution.kind === 'plan') {
        items = pushGuiItem(items, {
          id: guiItemId(),
          kind: 'note',
          text: evt.resolution.approve
            ? 'plano aprovado — o agente começou a construir'
            : 'plano devolvido para revisão',
          at: Date.now()
        })
      } else if (evt.resolution.kind === 'plan-proposal') {
        // Recibo da DECISÃO, e só. O que o agente precisa saber (id do plano,
        // aba nova no mapa) o main injeta como mensagem — repetir aqui seria
        // dizer a mesma coisa duas vezes no mesmo fio.
        const title = evt.resolution.planTitle?.trim()
        items = pushGuiItem(items, {
          id: guiItemId(),
          kind: 'note',
          text: evt.resolution.approve
            ? title
              ? `plano criado: ${title}`
              : 'plano criado'
            : 'proposta devolvida para ajuste',
          at: Date.now()
        })
      }
      const base = { ...state, ...interaction, items }
      // Só uma pendência BLOQUEANTE remanescente mantém o fio parado: uma
      // proposta ainda pendente não pode fazer o CLI recém-liberado parecer
      // travado.
      const status =
        base.status === 'dead'
          ? 'dead'
          : blocks(base)
            ? 'waiting-you'
            : hadPending
              ? 'working'
              : base.status
      return {
        ...base,
        activityText: blocks(base) ? null : lastPendingGuiToolActivity(items),
        ...guiStatusPatch(base, status)
      }
    }

    case 'permission-cancel': {
      const pending = state.interactionQueue.find((item) => item.requestId === evt.requestId)
      if (!pending) return state
      const interaction = removeGuiInteraction(state, evt.requestId)
      const audit: GuiItem =
        pending.kind === 'question'
          ? {
              id: guiItemId(),
              kind: 'note',
              text: 'a pergunta foi cancelada pelo agente',
              at: Date.now()
            }
          : pending.kind === 'plan'
            ? {
                id: guiItemId(),
                kind: 'note',
                text: 'o plano foi retirado pelo agente',
                at: Date.now()
              }
            : pending.kind === 'plan-proposal'
              ? {
                  id: guiItemId(),
                  kind: 'note',
                  text: 'a proposta de plano foi retirada pelo agente',
                  at: Date.now()
                }
              : {
                  id: guiItemId(),
                  kind: 'permission',
                  toolName: pending.perm.toolName,
                  behavior: 'cancelada',
                  at: Date.now()
                }
      const base = {
        ...state,
        ...interaction,
        items: pushGuiItem(state.items, audit)
      }
      const status = base.status === 'dead' ? 'dead' : blocks(base) ? 'waiting-you' : 'working'
      return {
        ...base,
        activityText: blocks(base) ? null : lastPendingGuiToolActivity(base.items),
        ...guiStatusPatch(base, status)
      }
    }

    case 'command-output': {
      const base = finalizeGuiStream(state)
      return {
        ...base,
        items: pushGuiItem(base.items, {
          id: guiItemId(),
          kind: 'note',
          text: evt.text,
          at: Date.now()
        })
      }
    }

    case 'limit': {
      const base = finalizeGuiStream(state)
      return {
        ...base,
        items: pushGuiItem(base.items, {
          id: guiItemId(),
          kind: 'error',
          text: evt.text,
          at: Date.now()
        })
      }
    }

    case 'result': {
      let next = finalizeGuiStream(state)
      // `continues` = o turno lógico NÃO acabou (fila de mensagens ou subagente
      // vivo). Reconciliar ferramenta pendente aqui carimbaria falha em trabalho
      // que ainda está acontecendo — e ainda inventaria um erro de órfão.
      const settlesTurn = !evt.continues
      // R7-E — O ■ DO DONO NÃO É ERRO. A bandeira vem do motor, que sabe quem
      // mandou parar, e é lida ANTES de qualquer ramo de erro: o card vermelho
      // "falhou · erro sem detalhe" do print do dono (2026-08-18) nascia aqui,
      // do result que o claude carimba `is_error` ao interromper.
      const ownerInterrupted = evt.interrupted === true
      // Os nomes saem ANTES do fecho: `closePendingGuiTools` carimba result
      // em todas elas, e depois disso nao existe mais orfa para nomear.
      const orphan = settlesTurn
        ? orphanedTurnTools(next.items, evt)
        : { orphaned: false, names: [] }
      const orphanedTool = orphan.orphaned
      if (settlesTurn) next = { ...next, items: closePendingGuiTools(next.items, evt) }
      if (ownerInterrupted) {
        // NOTA NEUTRA, nunca item de erro: o fio precisa dizer por que o turno
        // acabou no meio — o silêncio deixaria o dono sem explicação nenhuma.
        next = {
          ...next,
          items: pushGuiItem(next.items, {
            id: guiItemId(),
            kind: 'note',
            text: 'turno interrompido',
            at: Date.now()
          })
        }
      } else if (evt.isError || evt.outcome === 'failed' || orphanedTool) {
        // A DUPLICATA MORRE (R21.3): num erro de verdade o CLI diz a MESMA
        // frase duas vezes — como fala do stream e como palavra final do turno
        // (`resultText`, que é a fonte do card). Quando a última fala é
        // idêntica a ela, fica só o CARD: é ele que carrega a voz da casa e a
        // receita. Lado escolhido pelo raio de efeito: soltar o item já
        // fechado do fim da lista não mexe em id, fila nem status de ninguém.
        // Comparação estrutural de igualdade — o conteúdo nunca é lido.
        const spoken = next.items[next.items.length - 1]
        const echoed =
          (evt.isError || evt.outcome === 'failed') &&
          spoken?.kind === 'assistant' &&
          guiResultEchoesSpeech(spoken.text, evt.resultText)
        next = {
          ...next,
          items: pushGuiItem(echoed ? next.items.slice(0, -1) : next.items, {
            id: guiItemId(),
            kind: 'error',
            text:
              evt.errorText?.trim() ||
              (orphanedTool ? orphanedToolText(orphan.names) : 'o turno falhou sem detalhes'),
            at: Date.now(),
            ...(orphanedTool && !evt.isError && evt.outcome !== 'failed'
              ? { transient: true }
              : {})
          })
        }
      } else if (!next.turnHadText && evt.resultText?.trim()) {
        // comando local (/usage, /status…) responde SÓ pelo resultText
        next = {
          ...next,
          items: pushGuiItem(next.items, {
            id: guiItemId(),
            kind: 'note',
            text: evt.resultText,
            at: Date.now()
          })
        }
      }
      // Pedido que BLOQUEIA o CLI morre com o turno (o backend já desistiu
      // dele); a proposta de plano sobrevive e continua clicável — a MESMA
      // isenção do anel no main. Zerar a fila aqui era o que fazia o card
      // sumir no instante em que o agente terminava de falar.
      next = {
        ...next,
        ...guiInteractionPatch(
          retainGuiInteractionsAfterTurnEnd(next.interactionQueue),
          next.interactionSubmitting
        )
      }
      const status = halted(next) ? 'waiting-you' : next.status === 'dead' ? 'dead' : 'idle'
      const terminalStatus =
        status === 'idle' && evt.continues ? 'working' : status
      return {
        ...next,
        thinking: false,
        thinkingText: '',
        turnHadText: false,
        contextTokens: evt.contextTokens ?? next.contextTokens,
        contextWindow: evt.contextWindow ?? next.contextWindow,
        costUsd: evt.costUsd ?? next.costUsd,
        activityText: null,
        ...guiStatusPatch(next, terminalStatus)
      }
    }

    case 'command-completed': {
      const items = evt.isError
        ? pushGuiItem(state.items, {
            id: guiItemId(),
            kind: 'error',
            text: evt.errorText?.trim() || 'o comando falhou sem detalhes',
            at: Date.now()
          })
        : state.items
      // Turno que CONTINUA só para por pendência bloqueante; na barreira,
      // qualquer card esperando o dono rotula a espera.
      const status = guiCommandCompletionStatus(
        state.status,
        evt.continues,
        evt.continues ? blocks(state) : halted(state)
      )
      return {
        ...state,
        items,
        thinking: evt.continues ? state.thinking : false,
        thinkingText: evt.continues ? state.thinkingText : '',
        activityText: evt.continues ? state.activityText : null,
        ...guiStatusPatch(state, status)
      }
    }

    case 'turn-continuation': {
      const status = guiCommandCompletionStatus(
        state.status,
        evt.continues,
        evt.continues ? blocks(state) : halted(state)
      )
      return {
        ...state,
        activityText: evt.continues ? state.activityText : null,
        ...guiStatusPatch(state, status)
      }
    }

    case 'fatal': {
      const base = finalizeGuiStream(state)
      const items = closePendingGuiTools(base.items, evt)
      return {
        ...base,
        items: pushGuiItem(items, {
          id: guiItemId(),
          kind: 'error',
          text: evt.text,
          at: Date.now()
        }),
        // Mesma régua do anel: a sessão caiu, mas a proposta já entregue não é
        // do CLI — é do dono. Ela continua no fio para o respawn honrar.
        ...guiInteractionPatch(
          retainGuiInteractionsAfterTurnEnd(base.interactionQueue),
          base.interactionSubmitting
        ),
        thinking: false,
        error: evt.text,
        // Morte anunciada SEM código provado: o `closed` que vem atrás carimba
        // o número quando existe, e até lá o composer não inventa nenhum.
        exitCode: null,
        activityText: null,
        ...guiStatusPatch(base, 'dead')
      }
    }

    case 'closed': {
      const base = finalizeGuiStream(state)
      const hadPendingTool = hasPendingGuiTools(base.items)
      const items = closePendingGuiTools(base.items, evt)
      const closed = guiClosedLine(evt.code, hadPendingTool)
      return {
        ...base,
        items: pushGuiItem(items, {
          id: guiItemId(),
          kind: closed.kind,
          text: closed.text,
          at: Date.now()
        }),
        ...guiInteractionPatch(
          retainGuiInteractionsAfterTurnEnd(base.interactionQueue),
          base.interactionSubmitting
        ),
        thinking: false,
        // R23.2 — o número que o composer do pane morto vai dizer em voz alta.
        exitCode: evt.code,
        activityText: null,
        ...guiStatusPatch(base, 'dead')
      }
    }

    default:
      // kind novo do main nunca quebra a UI: ignora e segue
      return state
  }
}

/**
 * Todo evento que realmente alterou o pane avança sua identidade. Promises de
 * envio/interrupção guardam essa revisão e não podem rebaixar um turno novo.
 */
export function applyGuiEvent(state: GuiPaneState, evt: GuiSessionEvent): GuiPaneState {
  let next = reduceGuiEvent(state, evt)
  if (next === state) return state
  // O TIMER DE RODADA (R11, ordem do dono): a régua do início/fim já era a do
  // `startedAt` — arma no working, PRESERVA esperando o dono (a espera é parte
  // da rodada), zera no fecho LÓGICO (o mesmo instante do plim; um result que
  // `continues` não zera, então subagente em background conta). O selo nasce
  // exatamente na transição que zera para 'idle' — morte de sessão não é
  // rodada concluída e não ganha carimbo. Trade-off aceito e conhecido: o
  // selo é item derivado, não renasce no replay pós-boot (mesma classe das
  // notas de turno interrompido).
  //
  // R21.4 — e SÓ carimba a rodada que trabalhou: `results` encadeados abrem e
  // fecham uma rodada de 0s (o segundo chega instantâneo), e o `0:00` daquela
  // rodada fantasma era ruído que enganava. O trabalho lido é o de ANTES deste
  // evento: o card do próprio fecho não promove fantasma a rodada.
  const appendedItem =
    next.items[next.items.length - 1]?.id !== state.items[state.items.length - 1]?.id
  if (
    guiRoundClosed(state.startedAt, next.startedAt, next.status) &&
    guiRoundEarnsStamp(Date.now() - (state.startedAt ?? 0), state.roundWorked)
  ) {
    next = {
      ...next,
      items: pushGuiItem(next.items, {
        id: guiItemId(),
        kind: 'note',
        text: guiRoundStampText(Date.now() - (state.startedAt ?? 0)),
        at: Date.now()
      })
    }
  }
  return {
    ...next,
    roundWorked: trackGuiRoundWork(
      state.startedAt,
      next.startedAt,
      state.roundWorked,
      appendedItem
    ),
    eventRevision: state.eventRevision + 1
  }
}

export interface Pane {
  id: string
  kind: PaneKind
  n: number
  title: string
  seatId?: string
  taskId?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  /** cwd próprio (ex.: worktree da tarefa assumida) — padrão: pasta do projeto */
  cwd?: string
  /** transcript (tee do PTY) — o Maestro lê o que acontece no pane */
  logFile?: string
  /** persona invisível (claude --append-system-prompt) — agente livre */
  appendSystemPrompt?: string
  /** papel do pane no pipeline (dev/review/qa/ajudante/maestro/livre) */
  role?: 'dev' | 'review' | 'qa' | 'ajudante' | 'maestro' | 'livre'
  /** missão dona do pane — o mapa agrupa por aqui. Ausente cai na cadeia de
   *  fallback de `panesNodes.ts` (tarefa → paneId do orquestrador → cwd). */
  missionId?: string
  /** pane que delegou este ajudante — o mapa pendura o card no dev certo */
  delegatorPaneId?: string
  /** servidor de teste do dono (botão ▶ testar) — o mapa mostra como nó
   *  "Teste em andamento", nunca como pane solto do "Geral" */
  testServer?: boolean
  /** versão dona do servidor de teste (botão ▶ testar da aba Versões) */
  versionId?: string
  /** SUPERFÍCIE do pane: 'tui' (xterm com o CLI dentro, padrão histórico) ou
   *  'gui' (chat do Synkora 2.0, sem PTY). O contrato chama este campo de
   *  `kind`, mas `Pane.kind` já é o CLI (shell/claude/codex) e o pane GUI
   *  continua precisando dele — para a marca no chrome e para o `cli` do
   *  `gui:create`. Ausente = 'tui'. */
  surface?: 'tui' | 'gui'
  /** effort do executor (pane GUI: viaja no `gui:create`; pane TUI já recebe
   *  o dele pelos cliArgs montados no main). */
  effort?: string
  /** conversa a retomar no pane GUI (claude sessionId / codex thread id) */
  resumeSessionId?: string
  /** persona/contrato curto do pane GUI (claude: append-system-prompt;
   *  codex: developerInstructions) — o equivalente GUI do appendSystemPrompt */
  systemPrompt?: string
}

export interface PaneOptions {
  /** id definido pelo main (hub) — senão gera um aleatório */
  id?: string
  seatId?: string
  taskId?: string
  title?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  cwd?: string
  logFile?: string
  appendSystemPrompt?: string
  role?: 'dev' | 'review' | 'qa' | 'ajudante' | 'maestro' | 'livre'
  /** missão dona do pane (agrupamento do mapa) */
  missionId?: string
  delegatorPaneId?: string
  /** servidor de teste do dono (botão ▶ testar) */
  testServer?: boolean
  versionId?: string
  /** 'gui' abre o CHAT no lugar do xterm (Synkora 2.0) — ver Pane.surface */
  surface?: 'tui' | 'gui'
  effort?: string
  resumeSessionId?: string
  systemPrompt?: string
}

export interface DevPaneSpec {
  paneId: string
  kind: 'claude' | 'codex'
  seatId: string
  model?: string
  cwd: string
  cliArgs?: string[]
  initialPrompt: string
  /** persona de subagente do ajudante (delegate.agent) — pane claude */
  appendSystemPrompt?: string
  logFile: string
  title: string
  role: 'dev' | 'review' | 'qa' | 'ajudante'
  /** missão dona do pane — o mapa da aba Panes agrupa por aqui */
  missionId?: string
  /** pane que delegou (ajudante) — o mapa pendura o card no dev certo */
  delegatorPaneId?: string
}

interface SynkoraState {
  projects: Project[]
  seats: Seat[]
  openProjectId: string | null
  appPage: AppPage
  settingsSection: SettingsSection
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  panesByProject: Record<string, Pane[]>
  /** superfície sensível liberada — sem escritor na era 2.0 (o toggle saiu
   *  da tela na onda D); o valor segue no maestroStore para o main. */
  surveyBusyByProject: Record<string, boolean>
  /** força REMONTAGEM de um universo já montado (relocação de pasta) */
  remountNonce: Record<string, number>
  /** zera a telemetria de um paneId (respawn de mesmo id) */
  resetPaneTelemetry: (paneId: string) => void
  /** aprovação pendente POR PANE — dev, ajudantes e gate dividem o mesmo taskId,
   *  então o aviso do card não serve para saber QUAL terminal está travado */
  paneAttention: Record<string, boolean>
  clearPaneAttention: (projectId: string, paneId: string) => void
  /** missões do projeto ATIVO */
  missions: Mission[]
  loadMissions: (projectId: string) => Promise<void>
  createMission: (projectId: string, input: NewMissionInput) => Promise<Mission | null>
  archiveMission: (id: string, archived: boolean) => Promise<void>
  /** planejamento: conclui num clique — a missão encerra e some da coluna; o
   *  plano/ fica no repo e a aba do plano segue no mapa (o main guarda a porta:
   *  'concluida' por aqui só entra em missão de PLANEJAMENTO). */
  concludePlanningMission: (id: string) => Promise<void>
  deleteMission: (id: string) => Promise<void>
  /** A SAÍDA DA SUBIDA: arquiva e exclui num gesto só (ver releaseRailPresentation). */
  discardRelease: (id: string) => Promise<void>
  integrateMission: (missionId: string) => Promise<string>
  /** aba de missão selecionada no board, POR projeto (null = Geral) */
  missionTabByProject: Record<string, string | null>
  setMissionTab: (projectId: string, missionId: string | null) => void
  catalogByCli: Record<string, Catalog>
  loadCatalog: (cli: SeatCli, seatId?: string) => Promise<void>
  /** esquece as listas em cache — usado quando o CLI é atualizado e passa a
   *  oferecer modelos novos (o catálogo vem do binário) */
  clearCatalogs: () => void

  loadProjects: () => Promise<void>
  /** cria o universo. `gitUrl` (onda D) conecta o repositório no nascimento;
   *  devolve o AVISO em PT-BR quando o main criou o projeto mas o GitHub não
   *  fechou (auth/push) — null = tudo certo. Aviso nunca cancela a criação. */
  createProject: (name: string, path: string, gitUrl?: string) => Promise<string | null>
  removeProject: (id: string) => Promise<void>
  setProjectPhoto: (id: string) => Promise<void>
  removeProjectPhoto: (id: string) => Promise<void>
  renameProject: (id: string, name: string) => Promise<void>
  /** troca a pasta do projeto (main abre o picker); devolve erro ou null */
  relocateProject: (id: string) => Promise<string | null>
  /** números por universo mostrados na Home. Ausente = AINDA NÃO LIDO — o card
   *  precisa saber diferenciar isso de "zero", senão mente na primeira pintura. */
  homeStats: Record<string, HomeStats>
  loadHomeStats: (projectId: string) => Promise<void>
  /** overrides de COR por função (localStorage, global à máquina). A pintura
   *  normal usa as CSS vars `--hue-<função>` (deptHueVar); este mapa existe
   *  para quem precisa do número (fios do mapa, canvas). */
  deptHues: Partial<Record<Department, number>>
  setDeptHue: (dept: Department, hue: number | null) => void
  /** ajustes globais (userData/settings.json). Fonte ÚNICA do renderer: o
   *  painel de ajustes e o alerta da Home leem o mesmo objeto — em `useState`
   *  local (como era no ImageSettings) os dois divergiriam na primeira troca. */
  settings: SynkoraSettings | null
  loadSettings: () => Promise<void>
  patchSettings: (patch: SynkoraSettingsPatch) => Promise<void>
  /** SKILLS 2.0 — a biblioteca é da MÁQUINA (userData), não do projeto: um
   *  estado só, global, alimentado pela tela de configurações. Referência
   *  estável de propósito (a lista nasce `[]` no store; seletor nunca usa
   *  `?? []` inline, que remontaria a lista a cada render). */
  skillsLibrary: SkillsLibraryItem[]
  /** null = ainda não lido. Kit vazio de verdade tem `version: 1` e listas. */
  skillsKit: SkillsKitState | null
  skillsLoading: boolean
  /** falha de leitura em PT-BR, nomeando a saída — a tela mostra e oferece
   *  "tentar de novo" (beco sem saída é bug) */
  skillsError: string | null
  loadSkills: () => Promise<void>
  setSkillEnabled: (chat: SkillChatType, id: string, enabled: boolean) => Promise<void>
  /** devolve o ERRO em PT-BR (null = entrou) em vez de acender o aviso global:
   *  a falha pertence ao formulário aberto, que fica de pé com o que foi
   *  digitado — perder a ocasião escrita por causa de um EPERM é bug */
  addSkillToKit: (
    chat: SkillChatType,
    id: string,
    occasion: string,
    wing?: SkillDevWing
  ) => Promise<string | null>
  removeSkillFromKit: (chat: SkillChatType, id: string) => Promise<void>
  /** rede SÓ aqui (ADR-0007); devolve o erro em vez de jogar */
  installSkillFromUrl: (url: string) => Promise<{ ok: boolean; id?: string; error?: string }>
  /** PODA: gesto explícito, nunca no boot */
  pruneSkills: () => Promise<{ ok: boolean; removed?: string[]; error?: string }>
  /** universos já visitados NESTA sessão — ficam MONTADOS (display:none) para
   *  os panes/maestro continuarem rodando ao trocar de projeto */
  mountedProjects: string[]
  loadSeats: () => Promise<void>
  createSeat: (name: string, cli: SeatCli) => Promise<void>
  renameSeat: (id: string, name: string) => Promise<void>
  removeSeat: (id: string) => Promise<void>
  openProject: (id: string | null) => void
  /** aba do universo POR PROJETO — universos ficam montados ao mesmo tempo, e
   *  um valor global fazia o pane nascido num projeto de FUNDO (ajudante, fase
   *  de tarefa) arrastar para a aba Panes o universo que o usuário está
   *  olhando, além de montar Backlog/Arquivos dos universos escondidos. */
  universeTabByProject: Record<string, UniverseTab>
  setUniverseTab: (projectId: string, tab: UniverseTab) => void
  /** aba escolhida DENTRO do mapa (rotas · plano mestre F6 · um plano), por
   *  projeto. Mesmo motivo do de cima: o mapa de dois universos abertos ao
   *  mesmo tempo não pode compartilhar a escolha. Id de plano que deixou de
   *  existir cai em `rotas` na leitura (resolveMapTab). */
  mapTabByProject: Record<string, string>
  setMapTab: (projectId: string, tabId: string) => void
  /** Overlays globais abertos (popovers da titlebar, paleta, SynVoice) — o
   *  contador existe para quem precisa saber que a janela está coberta. */
  hostOverlayCount: number
  bumpHostOverlay: (delta: 1 | -1) => void
  addPane: (projectId: string, kind: PaneKind, opts?: PaneOptions) => void
  closePane: (projectId: string, paneId: string) => void
  /** conversa de cada pane GUI (Synkora 2.0), por paneId. Alimentada pelo
   *  canal `gui:live` e pelo replay de `gui:state` na montagem. */
  guiPanes: Record<string, GuiPaneState>
  /** Uma seleção global por renderer; o GuiPane exato é o único consumidor. */
  guiHistoryTarget: GuiHistoryTarget | null
  showGuiHistoryTarget: (target: GuiHistoryTarget) => void
  clearGuiHistoryTarget: (paneId?: string) => void
  /** R24.3 — a página que acabou de chegar entra na leitura aberta (dedupe por
   *  id+cursor). Só a ponta pedida atualiza seu "tem mais": a página anterior
   *  não sabe nada sobre o que existe DEPOIS do que já está na tela. */
  appendGuiHistoryPage: (
    paneId: string,
    page: {
      direction: 'before' | 'after'
      messages: HistoryTranscriptMessage[]
      hasMore: boolean
    }
  ) => void
  /** evento vivo do canal `gui:live` (payload cru — o redutor valida) */
  handleGuiLive: (paneId: string, evt: unknown) => void
  /** remontagem: refaz o estado do zero a partir do ring buffer do main */
  replayGuiPane: (
    paneId: string,
    events: GuiSessionEvent[],
    prepareForRespawn?: boolean
  ) => void
  /** carimba que `gui:create` já foi pedido (não spawnar duas vezes) */
  markGuiSpawned: (paneId: string) => void
  /** revelador terminou: a mensagem vira markdown estático sem piscar/remontar */
  finishGuiReveal: (paneId: string, itemId: string, revealedLength: number) => void
  queueGuiMessage: (
    paneId: string,
    text: string,
    options: GuiQueuedOptions,
    attachments?: readonly GuiAttachmentDescriptor[]
  ) => GuiQueuedMessage | null
  discardGuiQueuedMessage: (paneId: string, expectedId?: string) => void
  claimGuiQueuedMessage: (paneId: string, ownerToken: string) => GuiQueuedMessage | null
  acknowledgeGuiQueuedMessage: (
    paneId: string,
    expectedId: string,
    ownerToken: string
  ) => boolean
  restoreGuiQueuedMessage: (
    paneId: string,
    message: GuiQueuedMessage,
    error: string,
    ownerToken: string
  ) => void
  refreshGuiQueuedMessage: (paneId: string) => GuiQueuedMessage | null
  retryGuiQueuedMessage: (paneId: string, expectedId: string) => void
  sendGuiMessage: (
    paneId: string,
    text: string,
    messageId?: string,
    attachments?: readonly GuiAttachmentDescriptor[],
    /** R23.2 — a mensagem vem logo atrás de um respawn-com-resume que o main
     *  ACABOU de aceitar (pane morto que renasceu no envio). A guarda de
     *  transporte aqui é UX — o `dead`/`starting` do renderer ainda pode estar
     *  no ar, e a autoridade é do main: `gui.send` recusa honesto se a sessão
     *  não tiver nascido, e a recusa cai no caminho de falha de sempre. */
    revived?: boolean
  ) => Promise<boolean>
  answerGuiPerm: (
    projectId: string,
    paneId: string,
    behavior: GuiPermBehavior
  ) => Promise<void>
  /** resposta do card de pergunta: { texto da pergunta → labels unidos por
   *  ', ' }. Mapa vazio = pular (o agente segue sem a escolha). */
  answerGuiQuestion: (
    projectId: string,
    paneId: string,
    answers: Record<string, string>
  ) => Promise<void>
  /** veredito do card de plano: true = construir, false = revisar */
  answerGuiPlan: (projectId: string, paneId: string, approve: boolean) => Promise<void>
  /** veredito da proposta de plano: true = criar o plano, false = devolver
   *  para ajuste levando o que o dono escreveu (`note`). */
  answerGuiPlanProposal: (
    projectId: string,
    paneId: string,
    approve: boolean,
    note?: string
  ) => Promise<void>
  interruptGuiPane: (paneId: string) => Promise<void>
  /** pane fechado: encerra a sessão no main e descarta a conversa */
  dropGuiPane: (paneId: string) => void
  paneStats: Record<string, PaneStats>
  /** últimas linhas que cada pane escreveu (cartões-vivos) */
  paneLastLines: Record<string, string[]>
  setPaneLastLines: (paneId: string, lines: string[]) => void
  /** effort real detectado no banner do CLI, por pane */
  paneEffort: Record<string, string>
  setPaneEffort: (paneId: string, effort: string) => void
  /** modelo real detectado no banner do CLI, por pane (fallback do badge) */
  paneModel: Record<string, string>
  setPaneModel: (paneId: string, model: string) => void
  setPaneStats: (paneId: string, stats: PaneStats) => void
  /** estado vivo de cada pane: rodando (saída fluindo) / esperando / parado */
  paneActivity: Record<string, PaneActivity>
  setPaneActivity: (paneId: string, state: PaneActivity) => void
}

const KIND_LABEL: Record<PaneKind, string> = {
  shell: 'Terminal',
  claude: 'Claude',
  codex: 'Codex'
}

/** Aviso PT-BR devolvido pelo `projects:create` quando o universo nasceu mas o
 *  GitHub não fechou (onda D). Lê defensivamente: o motor é o dono do nome do
 *  campo e um payload sem aviso nenhum vale como sucesso. */
function projectCreateWarning(res: unknown): string | null {
  if (!res || typeof res !== 'object') return null
  const bag = res as Record<string, unknown>
  for (const key of ['warning', 'aviso', 'msg']) {
    const value = bag[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Preload velho (app rodando sem restart) não tem a API de skills — a tela
 *  nomeia a receita em vez de morrer calada. */
const SKILLS_NO_API = 'reinicie o app (npm run dev) para abrir a biblioteca de skills'

/** falha de skills em PT-BR: sempre diz o que se tentava fazer */
function skillsFailure(error: unknown, doing: string): string {
  const detail = error instanceof Error ? error.message.trim() : String(error ?? '').trim()
  return detail ? `não deu para ${doing}: ${detail}` : `não deu para ${doing}`
}

export const useStore = create<SynkoraState>((set, get) => ({
  projects: [],
  seats: [],
  openProjectId: null,
  appPage: 'workspace',
  settingsSection: 'appearance',
  openSettings: (section) =>
    set((state) => ({
      appPage: 'settings',
      settingsSection: section ?? state.settingsSection
    })),
  closeSettings: () => set({ appPage: 'workspace' }),
  panesByProject: {},
  surveyBusyByProject: {},
  paneAttention: {},

  // Digitar responde à aprovação DAQUELE pane; o card só para de pulsar quando
  // nenhum outro pane da tarefa ainda está esperando (antes, digitar em qualquer
  // irmão apagava o aviso do pane realmente travado).
  clearPaneAttention: (projectId, paneId) =>
    set((s) => {
      const paneAttention = { ...s.paneAttention }
      delete paneAttention[paneId]
      return { paneAttention }
    }),

  missions: [],
  // Preload antigo (app rodando sem restart) não tem a API de missões — os
  // guards evitam quebrar o renderer com HMR no meio do caminho.
  loadMissions: async (projectId) => {
    if (!window.synkora.missions) return
    const missions = await window.synkora.missions.list(projectId)
    // Resposta ATRASADA de um projeto que já não é o ativo sobrescrevia o
    // estado global do universo VISÍVEL (troca rápida no rail deixava o board
    // com os dados do outro, de forma permanente).
    if (get().openProjectId !== projectId) return
    set({ missions })
  },
  createMission: async (projectId, input) => {
    if (!window.synkora.missions) return null
    // O preload já publica `direct` e `missionType` em NewMission (as duas
    // frentes da onda B mesclaram): o input viaja TIPADO, sem cast. Campo que
    // o main não conhece continua sendo ignorado por ele.
    const created = await window.synkora.missions.create(projectId, input)
    await get().loadMissions(projectId)
    return created
  },
  archiveMission: async (id, archived) => {
    if (!window.synkora.missions) return
    await window.synkora.missions.update(id, { status: archived ? 'arquivada' : 'ativa' })
    const pid = get().openProjectId
    if (pid) await get().loadMissions(pid)
  },
  concludePlanningMission: async (id) => {
    if (!window.synkora.missions) return
    await window.synkora.missions.update(id, { status: 'concluida' })
    const pid = get().openProjectId
    if (pid) {
      await get().loadMissions(pid)
      // a missão saiu da coluna — a aba volta para o painel do projeto
      get().setMissionTab(pid, null)
    }
  },
  discardRelease: async (id) => {
    if (!window.synkora.missions?.remove) return
    // `missions:remove` só aceita ARQUIVADA — o fluxo do app é arquivar →
    // excluir. Para o dono, porém, descartar uma subida aberta por engano é UMA
    // decisão, não duas: os dois passos acontecem aqui dentro.
    await window.synkora.missions.update(id, { status: 'arquivada' })
    await get().deleteMission(id)
  },
  deleteMission: async (id) => {
    if (!window.synkora.missions?.remove) return
    await window.synkora.missions.remove(id)
    const pid = get().openProjectId
    if (pid) {
      get().setMissionTab(pid, null)
      await get().loadMissions(pid)
    }
  },
  integrateMission: async (missionId) => {
    if (!window.synkora.missions) return 'reinicie o app (npm run dev) para usar missões'
    const msg = await window.synkora.missions.integrate(missionId)
    const pid = get().openProjectId
    if (pid) await get().loadMissions(pid)
    return msg
  },
  missionTabByProject: {},
  setMissionTab: (projectId, missionId) =>
    set((s) => ({
      missionTabByProject: { ...s.missionTabByProject, [projectId]: missionId }
    })),

  catalogByCli: {},

  // Cache POR SEAT (config dir próprio = lista própria); o main já cacheia a
  // consulta ao CLI, então recarregar aqui é barato.
  loadCatalog: async (cli, seatId) => {
    const key = `${cli}:${seatId ?? ''}`
    if (get().catalogByCli[key]) return
    const catalog = await window.synkora.catalog.get(cli, seatId)
    set((s) => ({ catalogByCli: { ...s.catalogByCli, [key]: catalog } }))
  },

  clearCatalogs: () => set({ catalogByCli: {} }),

  loadProjects: async () => {
    const projects = await window.synkora.projects.list()
    set({ projects })
  },

  createProject: async (name, path, gitUrl) => {
    // TODO(onda D, motor): `projects:create` ganha o 3º parâmetro (gitUrl) e
    // passa a devolver o aviso do GitHub. Enquanto o preload não publica a
    // assinatura nova, o cast estreito mora AQUI — main antigo simplesmente
    // ignora o argumento extra e nunca devolve aviso.
    const create = window.synkora.projects.create as (
      name: string,
      path: string,
      gitUrl?: string
    ) => Promise<unknown>
    const res = await create(name, path, gitUrl)
    await get().loadProjects()
    return projectCreateWarning(res)
  },

  removeProject: async (id) => {
    await window.synkora.projects.remove(id)
    set((s) => ({
      mountedProjects: s.mountedProjects.filter((x) => x !== id),
      openProjectId: s.openProjectId === id ? null : s.openProjectId
    }))
    await get().loadProjects()
  },

  setProjectPhoto: async (id) => {
    const updated = await window.synkora.projects.setPhoto(id)
    if (updated) {
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? updated : p)) }))
    }
  },

  removeProjectPhoto: async (id) => {
    const updated = await window.synkora.projects.removePhoto(id)
    if (updated) {
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? updated : p)) }))
    }
  },

  renameProject: async (id, name) => {
    const updated = await window.synkora.projects.rename(id, name)
    if (updated) {
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name: updated.name } : p)) }))
    }
  },

  remountNonce: {},

  // Pasta renomeada/movida fora do app: o main pede a pasta nova e faz a
  // cascata (mata sessões, conserta worktrees git, migra sessões claude).
  // O universo precisa remontar no cwd novo — por CHAVE, nunca tirando o id de
  // mountedProjects: sem o id na lista ninguém renderiza o universo e o
  // openProjectId ficava apontando para o vazio (área central EM BRANCO ao
  // relocar pela página ✦ geral, com o rail insistindo que o projeto está
  // aberto). Chave nova = desmonta e remonta num único commit.
  relocateProject: async (id) => {
    const res = await window.synkora.projects.relocate(id)
    if (res.ok) {
      set((s) => ({
        remountNonce: { ...s.remountNonce, [id]: (s.remountNonce[id] ?? 0) + 1 },
        panesByProject: { ...s.panesByProject, [id]: [] }
      }))
      await get().loadProjects()
    }
    // cancelar o picker não é erro — só não faz nada
    return res.ok || res.error === 'cancelado' ? null : (res.error ?? null)
  },

  mountedProjects: [],

  homeStats: {},

  deptHues: loadDeptHues(),
  setDeptHue: (dept, hue) => {
    const next = { ...get().deptHues }
    if (hue === null) delete next[dept]
    else next[dept] = ((Math.round(hue) % 360) + 360) % 360
    try {
      localStorage.setItem(DEPT_HUES_LS_KEY, JSON.stringify(next))
    } catch {
      // sem persistência não é fatal — a cor vale até fechar o app
    }
    applyDeptHueVars(next)
    set({ deptHues: next })
  },

  // Duas leituras de JSON já em memória no main (missions.json,
  // backlog.json). Nunca dispara no laço de render: quem chama é a Home no
  // mount (escalonado) e os canais de mudança. A terceira leitura era
  // tasks.json, para contar CARDS — que morreram na purga F6 (2026-08-17).
  loadHomeStats: async (projectId) => {
    const [missions, versions] = await Promise.all([
      window.synkora.missions.list(projectId),
      window.synkora.backlog.listVersions(projectId)
    ])
    // A ATRIBUIÇÃO mora em `projectLanding.versionPortrait` (puro e testado):
    // linha por versão contando missão CARIMBADA nela, e o nome do que está NA
    // MAIN. Aqui fica só a leitura do disco — quando a régua morava neste
    // corpo, o chip de identidade elegia a aberta mais antiga e o dono lia
    // "◈ V1.0" com os números de outra linha ao lado.
    // R27 — o registro de release não é missão de superfície: fora do retrato
    // e do ✦ de ativas (o cabeçalho chegou a contar a própria subida).
    const surface = missions.filter((m) => !isReleaseMissionRecord(m))
    const { versoes, versaoNaMain } = versionPortrait(versions, surface)
    set((s) => ({
      homeStats: {
        ...s.homeStats,
        [projectId]: {
          missoesAtivas: surface.filter(
            (m) => m.status === 'ativa' || m.status === 'integrando'
          ).length,
          versoes,
          ...(versaoNaMain ? { versaoNaMain } : {}),
          at: Date.now()
        }
      }
    }))
  },

  settings: null,

  loadSettings: async () => {
    set({ settings: await window.synkora.settings.get() })
  },

  patchSettings: async (patch) => {
    set({ settings: await window.synkora.settings.set(patch) })
  },

  // ————— SKILLS 2.0 (biblioteca + kit por tipo de conversa) —————
  // O kit é DADO em userData e o motor é o dono dele: toda mutação devolve o
  // estado inteiro e a tela adota o que voltou — nunca edita a cópia local e
  // torce para o disco concordar.
  skillsLibrary: [],
  skillsKit: null,
  skillsLoading: false,
  skillsError: null,

  loadSkills: async () => {
    if (!window.synkora.skills) {
      set({ skillsLoading: false, skillsError: SKILLS_NO_API })
      return
    }
    set({ skillsLoading: true, skillsError: null })
    try {
      const { library, kit } = await window.synkora.skills.list()
      set({ skillsLibrary: library, skillsKit: kit, skillsLoading: false, skillsError: null })
    } catch (error) {
      set({ skillsLoading: false, skillsError: skillsFailure(error, 'ler a biblioteca de skills') })
    }
  },

  setSkillEnabled: async (chat, id, enabled) => {
    if (!window.synkora.skills) {
      set({ skillsError: SKILLS_NO_API })
      return
    }
    try {
      const kit = await window.synkora.skills.setEnabled(chat, id, enabled)
      set({ skillsKit: kit, skillsError: null })
    } catch (error) {
      set({ skillsError: skillsFailure(error, `${enabled ? 'ligar' : 'desligar'} ${id}`) })
    }
  },

  addSkillToKit: async (chat, id, occasion, wing) => {
    if (!window.synkora.skills) return SKILLS_NO_API
    try {
      const kit = await window.synkora.skills.addToKit(chat, id, occasion, wing)
      set({ skillsKit: kit, skillsError: null })
      return null
    } catch (error) {
      return skillsFailure(error, `pôr ${id} no kit`)
    }
  },

  removeSkillFromKit: async (chat, id) => {
    if (!window.synkora.skills) {
      set({ skillsError: SKILLS_NO_API })
      return
    }
    try {
      const kit = await window.synkora.skills.removeFromKit(chat, id)
      set({ skillsKit: kit, skillsError: null })
    } catch (error) {
      set({ skillsError: skillsFailure(error, `tirar ${id} do kit`) })
    }
  },

  installSkillFromUrl: async (url) => {
    if (!window.synkora.skills) return { ok: false, error: SKILLS_NO_API }
    try {
      const res = await window.synkora.skills.installFromUrl(url)
      // a pasta nova só aparece na lista relendo o disco
      if (res.ok) await get().loadSkills()
      return res.ok ? { ok: true, id: res.id } : { ok: false, error: res.error }
    } catch (error) {
      return { ok: false, error: skillsFailure(error, 'instalar a skill') }
    }
  },

  pruneSkills: async () => {
    if (!window.synkora.skills) return { ok: false, error: SKILLS_NO_API }
    try {
      const res = await window.synkora.skills.prune()
      if (res.ok) await get().loadSkills()
      return res.ok ? { ok: true, removed: res.removed } : { ok: false, error: res.error }
    } catch (error) {
      return { ok: false, error: skillsFailure(error, 'podar a biblioteca') }
    }
  },

  loadSeats: async () => {
    const seats = await window.synkora.seats.list()
    set({ seats })
  },

  createSeat: async (name, cli) => {
    await window.synkora.seats.create(name, cli)
    await get().loadSeats()
  },

  renameSeat: async (id, name) => {
    await window.synkora.seats.rename(id, name)
    await get().loadSeats()
  },

  removeSeat: async (id) => {
    await window.synkora.seats.remove(id)
    await get().loadSeats()
  },

  // Trocar de projeto NÃO derruba nada (decisão do usuário, estilo Discord):
  // os universos visitados ficam montados; aqui só troca o ativo e recarrega
  // o estado global por-projeto (missões) para o novo ativo.
  openProject: (id) => {
    set((s) => ({
      openProjectId: id,
      appPage: 'workspace',
      // Entrar num projeto SEMPRE pousa no board ✦ geral (pedido do usuário,
      // 2026-07-28) — a última aba/missão visitada não gruda entre visitas.
      // E o ✦ geral É a landing do universo desde 2026-08-15: o centro dele
      // convida a criar missão (ProjectGeneral), que é o que o dono quer ver
      // ao abrir um projeto.
      ...(id
        ? {
            universeTabByProject: { ...s.universeTabByProject, [id]: 'board' as const },
            missionTabByProject: { ...s.missionTabByProject, [id]: null }
          }
        : {}),
      mountedProjects:
        id && !s.mountedProjects.includes(id)
          ? [...s.mountedProjects, id]
          : s.mountedProjects
    }))
    if (id) void get().loadMissions(id)
  },

  universeTabByProject: {},
  setUniverseTab: (projectId, tab) =>
    set((s) => ({ universeTabByProject: { ...s.universeTabByProject, [projectId]: tab } })),

  mapTabByProject: {},
  setMapTab: (projectId, tabId) =>
    set((s) => ({ mapTabByProject: { ...s.mapTabByProject, [projectId]: tabId } })),

  hostOverlayCount: 0,
  bumpHostOverlay: (delta) =>
    set((s) => ({ hostOverlayCount: Math.max(0, s.hostOverlayCount + delta) })),

  paneStats: {},
  paneLastLines: {},
  setPaneLastLines: (paneId, lines) =>
    set((s) => ({ paneLastLines: { ...s.paneLastLines, [paneId]: lines } })),
  paneEffort: {},
  setPaneEffort: (paneId, effort) =>
    set((s) => ({ paneEffort: { ...s.paneEffort, [paneId]: effort } })),
  paneModel: {},
  setPaneModel: (paneId, model) =>
    set((s) => ({ paneModel: { ...s.paneModel, [paneId]: model } })),
  setPaneStats: (paneId, stats) =>
    set((s) => ({ paneStats: { ...s.paneStats, [paneId]: stats } })),
  paneActivity: {},
  setPaneActivity: (paneId, state) =>
    set((s) =>
      s.paneActivity[paneId] === state
        ? {}
        : { paneActivity: { ...s.paneActivity, [paneId]: state } }
    ),

  // ————— PANE GUI —————
  // O pulso needs-perm continua sendo o `paneAttention` de sempre: pane TUI e
  // pane GUI acendem a MESMA chave, então mapa, abas e Ctrl+Alt+P funcionam
  // sem saber que existe uma superfície nova.
  guiPanes: {},
  guiHistoryTarget: null,
  showGuiHistoryTarget: (target) => set({ guiHistoryTarget: target }),
  clearGuiHistoryTarget: (paneId) =>
    set((state) =>
      !state.guiHistoryTarget || (paneId && state.guiHistoryTarget.paneId !== paneId)
        ? {}
        : { guiHistoryTarget: null }
    ),
  appendGuiHistoryPage: (paneId, page) =>
    set((state) => {
      const target = state.guiHistoryTarget
      // Leitura trocada no meio da viagem (o dono fechou ou abriu outra): a
      // página chega tarde e não ressuscita nada.
      if (!target || target.paneId !== paneId) return {}
      return {
        guiHistoryTarget: {
          ...target,
          messages: mergeGuiHistoryPage(target.messages, page.messages),
          ...(page.direction === 'before'
            ? { hasMoreBefore: page.hasMore }
            : { hasMoreAfter: page.hasMore })
        }
      }
    }),

  handleGuiLive: (paneId, raw) =>
    set((s) => {
      const evt = asGuiEvent(raw)
      if (!evt) return {}
      const prev =
        s.guiPanes[paneId] ?? {
          ...EMPTY_GUI_PANE,
          queued: readGuiQueuedMessage(paneId)
        }
      // O EPISODIO DA ORFA VIRA LINHA NO DIARIO (2026-08-28). A conta e a
      // MESMA do card (`orphanedTurnTools`), lida de `prev`: o finalize do
      // stream so toca o item do assistente, entao as tools sao identicas
      // aqui e la dentro. Preload velho nao tem o canal — a metade main
      // chega no proximo restart —, e o `?.` deixa a tela seguir igual.
      if (evt.type === 'result') {
        const orphan = orphanedTurnTools(prev.items, evt)
        if (orphan.orphaned)
          window.synkora.blackbox?.noteOrphanedTool?.(paneId, {
            tools: orphan.names,
            outcome: evt.outcome,
            isError: evt.isError === true
          })
      }
      const next = applyGuiEvent(prev, evt)
      if (next === prev) return {}
      const patch: Partial<SynkoraState> = {
        guiPanes: { ...s.guiPanes, [paneId]: next }
      }
      if ((next.interactionQueue.length > 0) !== !!s.paneAttention[paneId]) {
        const paneAttention = { ...s.paneAttention }
        if (next.interactionQueue.length > 0) paneAttention[paneId] = true
        else delete paneAttention[paneId]
        patch.paneAttention = paneAttention
      }
      return patch
    }),

  replayGuiPane: (paneId, events, prepareForRespawn = false) =>
    set((s) => {
      const prev = s.guiPanes[paneId]
      const queued = prev?.queued ?? readGuiQueuedMessage(paneId)
      let next: GuiPaneState = {
        ...EMPTY_GUI_PANE,
        spawned: prev?.spawned ?? false,
        queued
      }
      for (const evt of events) next = applyGuiEvent(next, evt)
      // A fila é estado local posterior ao transcript; um /clear histórico no
      // replay nunca pode apagar uma mensagem enfileirada agora.
      next = { ...next, queued }
      if (prepareForRespawn) {
        // Tarefa de fundo morre com o processo: agente apenas despachado não
        // pode ressuscitar na lateral só porque a fotografia foi remontada.
        next = {
          ...next,
          items: settleLaunchedGuiSubagents(next.items)
        }
        next = {
          ...next,
          ...settleGuiRespawnStream(next.items, next.activeAssistantId, next.turnHadText)
        }
      }
      next = settleGuiReplay(next)
      if (prepareForRespawn) {
        next = {
          ...next,
          status: 'starting',
          ready: false,
          caps: null,
          startedAt: null,
          activityText: null,
          sendBatch: null,
          error: null,
          // A MEDIÇÃO REPLAYADA PODE SER DE OUTRA CONVERSA. O fio persistido
          // guarda `result`/`context-usage` da sessão anterior, e nada aqui
          // sabe se ela será retomada — quem decide é o main
          // (`sameConversation` → `session-restarted`), e ele só fala depois
          // de esperar o CLI estabilizar. Até lá o medidor mostrava a
          // porcentagem de uma conversa morta. Custo: uma superfície que
          // replaya SEM criar sessão fica sem medidor — hoje só a fotografia
          // congelada, que nem desenha o composer.
          contextTokens: null,
          contextWindow: null
        }
      }
      const patch: Partial<SynkoraState> = {
        guiPanes: { ...s.guiPanes, [paneId]: next }
      }
      if ((next.interactionQueue.length > 0) !== !!s.paneAttention[paneId]) {
        const paneAttention = { ...s.paneAttention }
        if (next.interactionQueue.length > 0) paneAttention[paneId] = true
        else delete paneAttention[paneId]
        patch.paneAttention = paneAttention
      }
      return patch
    }),

  markGuiSpawned: (paneId) =>
    set((s) => {
      const prev =
        s.guiPanes[paneId] ?? {
          ...EMPTY_GUI_PANE,
          queued: readGuiQueuedMessage(paneId)
        }
      if (prev.spawned) return {}
      return { guiPanes: { ...s.guiPanes, [paneId]: { ...prev, spawned: true } } }
    }),

  finishGuiReveal: (paneId, itemId, revealedLength) =>
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev) return {}
      let changed = false
      const items = prev.items.map((item) => {
        if (item.id !== itemId || item.kind !== 'assistant') return item
        const animateFrom = Math.max(
          item.animateFrom,
          Math.min(Math.max(0, revealedLength), item.text.length)
        )
        if (animateFrom === item.animateFrom) return item
        changed = true
        return { ...item, animateFrom }
      })
      if (!changed) return {}
      return { guiPanes: { ...s.guiPanes, [paneId]: { ...prev, items } } }
    }),

  queueGuiMessage: (paneId, text, options, attachmentInput = []) => {
    const message = text.trim()
    const attachments = safeGuiItemAttachments(attachmentInput) ?? []
    if (attachmentInput.length !== attachments.length) return null
    const before = get().guiPanes[paneId]
    if (
      (!message && attachments.length === 0) ||
      (before?.status !== 'working' && before?.status !== 'waiting-you') ||
      before.queued
    )
      return null
    const queued: GuiQueuedMessage = {
      id: guiItemId(),
      text: message,
      at: Date.now(),
      options,
      attachments
    }
    if (!writeGuiQueuedMessage(paneId, queued)) return null
    let accepted = false
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (
        !prev ||
        (prev.status !== 'working' && prev.status !== 'waiting-you') ||
        prev.queued
      )
        return {}
      accepted = true
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, queued }
        }
      }
    })
    if (!accepted) {
      removeGuiQueuedMessageStorage(paneId, queued.id)
      return null
    }
    return queued
  },

  discardGuiQueuedMessage: (paneId, expectedId) => {
    removeGuiQueuedMessageStorage(paneId, expectedId)
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev?.queued || (expectedId && prev.queued.id !== expectedId)) return {}
      if (prev.queued.deliveryInFlight) return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, queued: null }
        }
      }
    })
  },

  claimGuiQueuedMessage: (paneId, ownerToken) => {
    const claimed = claimGuiQueuedMessageStorage(paneId, ownerToken)
    if (!claimed) return null
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev || (prev.queued && prev.queued.id !== claimed.id)) return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, queued: claimed }
        }
      }
    })
    return claimed
  },

  acknowledgeGuiQueuedMessage: (paneId, expectedId, ownerToken) => {
    const acknowledged = acknowledgeGuiQueuedMessageStorage(paneId, expectedId, ownerToken)
    if (!acknowledged) return false
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev?.queued || prev.queued.id !== expectedId) return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, queued: null }
        }
      }
    })
    return true
  },

  restoreGuiQueuedMessage: (paneId, message, error, ownerToken) => {
    const restored = releaseGuiQueuedMessageClaim(paneId, ownerToken, message, error)
    // Uma lease mais nova torna esta falha obsoleta; nunca ressuscitar uma fila
    // falsa por cima do renderer que realmente ganhou a entrega.
    const next = restored ?? readGuiQueuedMessage(paneId)
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev) return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, queued: next }
        }
      }
    })
  },

  refreshGuiQueuedMessage: (paneId) => {
    const queued = readGuiQueuedMessage(paneId)
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev) return {}
      const current = prev.queued
      if (
        current?.id === queued?.id &&
        current?.deliveryError === queued?.deliveryError &&
        current?.deliveryInFlight === queued?.deliveryInFlight &&
        current?.deliveryClaimedUntil === queued?.deliveryClaimedUntil
      )
        return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, queued }
        }
      }
    })
    return queued
  },

  retryGuiQueuedMessage: (paneId, expectedId) => {
    const current = get().guiPanes[paneId]?.queued ?? readGuiQueuedMessage(paneId)
    if (!current || current.id !== expectedId || current.deliveryInFlight) return
    const retrying: GuiQueuedMessage = { ...current }
    delete retrying.deliveryError
    delete retrying.deliveryInFlight
    delete retrying.deliveryClaimedUntil
    writeGuiQueuedMessage(paneId, retrying)
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev || prev.queued?.id !== expectedId) return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, queued: retrying }
        }
      }
    })
  },

  sendGuiMessage: async (paneId, text, messageId, attachmentInput = [], revived = false) => {
    const message = text.trim()
    const attachments = safeGuiItemAttachments(attachmentInput) ?? []
    if (attachmentInput.length !== attachments.length) return false
    if (!message && attachments.length === 0) return false
    const before = get().guiPanes[paneId]
    // O composer pode receber texto enquanto abre, mas o transporte só existe
    // depois do `ready`. Enviar antes dele criava um falso "pane morto".
    // `revived` é a exceção da R23.2: o respawn-com-resume acabou de ser aceito
    // pelo main e é ELE a autoridade sobre a sessão nova.
    if (!before || !(revived || canSendGuiMessage(before.status, before.ready))) return false
    // O id do bilhete da fila sobrevive ao restart no localStorage (e pode ter
    // sido gravado por uma versão antiga do app). Ele só vale quando ainda está
    // livre no fio hidratado: repetido, viraria chave duplicada aqui e id já
    // entregue no main — que responderia ok e engoliria a mensagem.
    const userItemId = claimGuiItemId(messageId, before.items)
    const batchId =
      before.sendBatch?.eventRevision === before.eventRevision
        ? before.sendBatch.id
        : userItemId
    const sentAt = Date.now()
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev || !(revived || canSendGuiMessage(prev.status, prev.ready))) return {}
      const startedTurn = prev.status !== 'working'
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: {
            ...prev,
            items: pushGuiItem(prev.items, {
              id: userItemId,
              kind: 'user',
              text: message,
              ...(attachments.length > 0 ? { attachments } : {}),
              at: sentAt
            }),
            // backend ocupado enfileira/steera sozinho — a UI nunca trava o input
            ...guiStatusPatch(prev, 'working', sentAt),
            activityText: startedTurn ? null : prev.activityText,
            turnHadText: startedTurn ? false : prev.turnHadText,
            sendBatch: beginGuiSendBatch(
              prev.sendBatch,
              batchId,
              userItemId,
              prev.eventRevision,
              startedTurn
            )
          }
        }
      }
    })
    const result = await guiApi.send(paneId, message, userItemId, attachments)
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev) return {}
      const settled = settleGuiSendBatch(
        prev.sendBatch,
        batchId,
        userItemId,
        result.ok,
        prev.eventRevision
      )
      if (result.ok) {
        if (settled.batch === prev.sendBatch) return {}
        return {
          guiPanes: {
            ...s.guiPanes,
            [paneId]: { ...prev, sendBatch: settled.batch }
          }
        }
      }
      const status = settled.closeTurn
        ? guiTransportFailureStatus(prev.status, result.error)
        : prev.status
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: {
            ...prev,
            items: pushGuiItem(prev.items, {
              id: guiItemId(),
              kind: 'error',
              text: `não deu para enviar a mensagem — ${result.error ?? 'a sessão não respondeu'}`,
              at: Date.now()
            }),
            sendBatch: settled.batch,
            activityText: settled.closeTurn ? null : prev.activityText,
            ...guiStatusPatch(prev, status)
          }
        }
      }
    })
    return result.ok
  },

  answerGuiPerm: async (_projectId, paneId, behavior) => {
    const before = get().guiPanes[paneId]
    const perm = before?.perm
    if (!before || !perm || before.interactionSubmitting) return
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (
        !prev?.perm ||
        prev.perm.requestId !== perm.requestId ||
        prev.interactionSubmitting
      )
        return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, interactionSubmitting: perm.requestId }
        }
      }
    })
    const result = await guiApi.permission(paneId, perm.requestId, behavior)
    if (!result.ok) {
      set((s) => {
        const prev = s.guiPanes[paneId]
        if (!prev) return {}
        return {
          guiPanes: {
            ...s.guiPanes,
            [paneId]: guiInteractiveFailure(
              prev,
              perm.requestId,
              'não deu para responder à permissão',
              result.error,
              Boolean(result.retryable)
            )
          }
        }
      })
    }
  },

  answerGuiQuestion: async (_projectId, paneId, answers) => {
    const before = get().guiPanes[paneId]
    const pending = before?.question
    if (!before || !pending || before.interactionSubmitting) return
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (
        !prev?.question ||
        prev.question.requestId !== pending.requestId ||
        prev.interactionSubmitting
      )
        return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, interactionSubmitting: pending.requestId }
        }
      }
    })
    const result = await guiApi.answerQuestion(paneId, pending.requestId, answers)
    if (!result.ok) {
      set((s) => {
        const prev = s.guiPanes[paneId]
        if (!prev) return {}
        return {
          guiPanes: {
            ...s.guiPanes,
            [paneId]: guiInteractiveFailure(
              prev,
              pending.requestId,
              'não deu para responder à pergunta',
              result.error,
              Boolean(result.retryable)
            )
          }
        }
      })
    }
  },

  answerGuiPlan: async (_projectId, paneId, approve) => {
    const before = get().guiPanes[paneId]
    const pending = before?.planReview
    if (!before || !pending || before.interactionSubmitting) return
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (
        !prev?.planReview ||
        prev.planReview.requestId !== pending.requestId ||
        prev.interactionSubmitting
      )
        return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, interactionSubmitting: pending.requestId }
        }
      }
    })
    const result = await guiApi.answerPlan(paneId, pending.requestId, approve)
    if (!result.ok) {
      set((s) => {
        const prev = s.guiPanes[paneId]
        if (!prev) return {}
        return {
          guiPanes: {
            ...s.guiPanes,
            [paneId]: guiInteractiveFailure(
              prev,
              pending.requestId,
              'não deu para responder ao plano',
              result.error,
              Boolean(result.retryable)
            )
          }
        }
      })
    }
  },

  answerGuiPlanProposal: async (_projectId, paneId, approve, note) => {
    const before = get().guiPanes[paneId]
    const pending = before?.planProposal
    if (!before || !pending || before.interactionSubmitting) return
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (
        !prev?.planProposal ||
        prev.planProposal.requestId !== pending.requestId ||
        prev.interactionSubmitting
      )
        return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: { ...prev, interactionSubmitting: pending.requestId }
        }
      }
    })
    const result = await guiApi.answerPlanProposal(paneId, pending.requestId, approve, note)
    if (!result.ok) {
      set((s) => {
        const prev = s.guiPanes[paneId]
        if (!prev) return {}
        return {
          guiPanes: {
            ...s.guiPanes,
            [paneId]: guiInteractiveFailure(
              prev,
              pending.requestId,
              'não deu para responder à proposta de plano',
              result.error,
              Boolean(result.retryable)
            )
          }
        }
      })
    }
  },

  interruptGuiPane: async (paneId) => {
    const before = get().guiPanes[paneId]
    if (!before || before.status !== 'working') return
    const turnIdentity = {
      eventRevision: before.eventRevision,
      startedAt: before.startedAt
    }
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev) return {}
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: {
            ...prev,
            items: pushGuiItem(prev.items, {
              id: guiItemId(),
              kind: 'note',
              text: 'interrupção pedida',
              at: Date.now()
            })
          }
        }
      }
    })
    const result = await guiApi.interrupt(paneId)
    if (result.ok) return
    set((s) => {
      const prev = s.guiPanes[paneId]
      if (!prev) return {}
      const { sameTurn, status } = settleGuiActionFailure(prev, turnIdentity, result.error)
      return {
        guiPanes: {
          ...s.guiPanes,
          [paneId]: {
            ...prev,
            items: pushGuiItem(prev.items, {
              id: guiItemId(),
              kind: 'error',
              text: `não deu para interromper o turno — ${result.error ?? 'a sessão não respondeu'}`,
              at: Date.now()
            }),
            activityText: sameTurn ? null : prev.activityText,
            ...guiStatusPatch(prev, status)
          }
        }
      }
    })
  },

  dropGuiPane: (paneId) => {
    void guiApi.kill(paneId)
    removeGuiQueuedMessageStorage(paneId)
    set((s) => {
      if (!s.guiPanes[paneId]) return {}
      const guiPanes = { ...s.guiPanes }
      delete guiPanes[paneId]
      return { guiPanes }
    })
  },

  addPane: (projectId, kind, opts = {}) =>
    set((s) => {
      const panes = s.panesByProject[projectId] ?? []
      // Menor número livre por projeto e por tipo: fechar o "Claude · 1"
      // libera o 1 para o próximo pane, em vez de contar para sempre.
      const used = new Set(panes.filter((p) => p.kind === kind).map((p) => p.n))
      let n = 1
      while (used.has(n)) n++
      const seat = opts.seatId ? s.seats.find((x) => x.id === opts.seatId) : undefined
      const pane: Pane = {
        id: opts.id ?? crypto.randomUUID(),
        kind,
        n,
        seatId: opts.seatId,
        taskId: opts.taskId,
        initialPrompt: opts.initialPrompt,
        model: opts.model,
        cliArgs: opts.cliArgs,
        cwd: opts.cwd,
        logFile: opts.logFile,
        appendSystemPrompt: opts.appendSystemPrompt,
        role: opts.role,
        missionId: opts.missionId,
        delegatorPaneId: opts.delegatorPaneId,
        testServer: opts.testServer,
        versionId: opts.versionId,
        surface: opts.surface,
        effort: opts.effort,
        resumeSessionId: opts.resumeSessionId,
        systemPrompt: opts.systemPrompt,
        // Pane de CLI com seat NÃO repete o nome do seat no título (o chip do
        // seat já diz — padronização com o Maestro/orquestrador, que também
        // não repetem); o número só aparece quando há mais de um pane igual.
        title:
          opts.title ??
          (seat ? (n > 1 ? `· ${n}` : '') : `${KIND_LABEL[kind]} · ${n}`)
      }
      return {
        panesByProject: { ...s.panesByProject, [projectId]: [...panes, pane] }
      }
    }),

  // Telemetria é chaveada por paneId e só o closePane a limpava — mas o pane do
  // PM (maestro-<pid>) e os dos orquestradores NUNCA passam por closePane (vivem
  // no estado local do Board). Respawn de mesmo id (⇄ seat, missão reativada,
  // autocura do --resume) exibia ↓/↑, contexto, modelo e "■ parado" da sessão
  // MORTA sobre um terminal vazio.
  resetPaneTelemetry: (paneId) =>
    set((s) => {
      if (
        !s.paneStats[paneId] &&
        !s.paneModel[paneId] &&
        !s.paneEffort[paneId] &&
        !s.paneActivity[paneId] &&
        !s.paneLastLines[paneId]
      ) {
        return {}
      }
      const paneStats = { ...s.paneStats }
      const paneModel = { ...s.paneModel }
      const paneEffort = { ...s.paneEffort }
      const paneActivity = { ...s.paneActivity }
      const paneLastLines = { ...s.paneLastLines }
      delete paneStats[paneId]
      delete paneModel[paneId]
      delete paneEffort[paneId]
      delete paneActivity[paneId]
      delete paneLastLines[paneId]
      return { paneStats, paneModel, paneEffort, paneActivity, paneLastLines }
    }),

  closePane: (projectId, paneId) => {
    // Pane TUI encerra o PTY no unmount do TerminalPane; o pane GUI não tem
    // PTY nenhum — quem encerra a sessão do main é o `gui:kill`. Fica AQUI (e
    // não só no botão ×) para valer em TODO caminho de fecho: fase concluída,
    // panes:closeById do main, missão arquivada.
    if ((get().panesByProject[projectId] ?? []).find((p) => p.id === paneId)?.surface === 'gui') {
      get().dropGuiPane(paneId)
    }
    set((s) => {
      const paneAttention = { ...s.paneAttention }
      delete paneAttention[paneId]
      const stats = { ...s.paneStats }
      delete stats[paneId]
      const activity = { ...s.paneActivity }
      delete activity[paneId]
      const effort = { ...s.paneEffort }
      delete effort[paneId]
      const model = { ...s.paneModel }
      delete model[paneId]
      const lastLines = { ...s.paneLastLines }
      delete lastLines[paneId]
      return {
        paneAttention,
        paneStats: stats,
        paneActivity: activity,
        paneEffort: effort,
        paneModel: model,
        paneLastLines: lastLines,
        panesByProject: {
          ...s.panesByProject,
          [projectId]: (s.panesByProject[projectId] ?? []).filter((p) => p.id !== paneId)
        }
      }
    })
  }
}))

// Cores das funções: aplica os overrides do usuário nas CSS vars globais no
// boot do renderer (o módulo é importado antes do primeiro paint do React).
applyDeptHueVars(useStore.getState().deptHues)

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { release } from 'node:os'
import type { ProgressOverlaySnapshot } from '../main/progressSnapshot'
import type { BlackboxEntry } from '../main/blackbox'

/** entrada do diário da caixa-preta + linha legível pronta para exibição */
export type BlackboxTailEntry = BlackboxEntry & { line: string }

export type {
  MissionProgressState,
  ProgressCardPreview,
  ProgressCoordinatorActivityKind,
  ProgressCoordinatorActivityInput,
  ProgressCoordinatorRole,
  ProgressCoordinatorSnapshot,
  ProgressMasterPlanSnapshot,
  ProgressMissionSnapshot,
  ProgressOverlaySnapshot,
  ProgressProjectSnapshot,
  ProgressTone,
  ProjectProgressState
} from '../main/progressSnapshot'

// Caixa-preta do RENDERER (F5.7e): erro JS não tratado na janela não derruba
// o processo, mas quebra a UI em silêncio — reporta ao main, que grava em
// userData/synkora-crash.log. Registrado AQUI (preload roda antes do app
// React montar) para pegar até erro de boot do renderer.
window.addEventListener('error', (e) =>
  ipcRenderer.send(
    'crash:renderer',
    `${e.message} @ ${e.filename || '?'}:${e.lineno ?? 0}${e.error instanceof Error && e.error.stack ? `\n${e.error.stack}` : ''}`
  )
)
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { stack?: string } | undefined
  ipcRenderer.send('crash:renderer', `unhandledrejection: ${r?.stack ?? String(e.reason)}`)
})

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  mode?: 'greenfield' | 'existing'
  planStatus?: 'draft' | 'approved' | 'in_progress' | 'revision_pending' | 'awaiting_release' | 'done'
  /** avatar do projeto (data URL) — rail estilo Discord */
  photo?: string
  /** COMPUTADO na listagem: a pasta não existe mais (renomeada/movida fora
   *  do app) — a Home oferece "alterar pasta" */
  missing?: boolean
}

/** Resultado de projects:relocate (troca de pasta do projeto). */
export interface RelocateResult {
  ok: boolean
  project?: Project
  error?: string
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

export type Department =
  | 'front'
  | 'back'
  | 'qa'
  | 'design'
  | 'research'
  | 'copy'
  | 'cyber'
  | 'data'
export type TaskStatus = 'backlog' | 'execucao' | 'qa' | 'done'
export type TaskType = 'feature' | 'bug'
export type TaskEffort = 'leve' | 'pesada'
export type MissionExecutionMode = 'fast' | 'standard' | 'deep'
export type MissionRiskLevel = 'low' | 'medium' | 'high'
export type TaskDelegationMode = 'none' | 'optional' | 'parallel'
export type TaskDeliverableKind = 'code' | 'non_code'
export type ManualSecurityValidation =
  | { required: false; status: 'not_required' }
  | { required: true; status: 'pending' }
  | {
      required: true
      status: 'approved' | 'waived'
      /** F6.6: gate especialista preenche sozinho com actor 'security-gate'. */
      actor: 'user' | 'security-gate'
      resolvedAt: string
      evidence: string
    }

// F5.7 — card de PLANO: proposta do orquestrador que o usuário lê e aprova.
export interface PlanLane {
  dept: Department
  notes?: string
  seatId?: string
  model?: string
  effort?: string
}

export interface TaskPlan {
  summary: string
  lanes: PlanLane[]
  executionMode?: MissionExecutionMode
  risk?: MissionRiskLevel
  riskSurfaces?: string[]
  riskReasons?: string[]
  securityPolicyVersion?: number
  manualSecurityValidationRequired?: boolean
  manualSecurityValidation?: ManualSecurityValidation
  sizingReason?: string
  expectedCards?: number
  planningMethod?: {
    contractVersion: 1
    receiptId: string
    skillId: string
    operation: string
    version: string
    fingerprint: string
    phaseRun: string
    appliedAt: string
  }
  planningEvidenceState?: 'receipt_required' | 'verified' | 'legacy_unverified'
  conclusion?: string
  approvedAt?: string
}

export interface Task {
  id: string
  projectId: string
  department: Department
  type: TaskType
  effort: TaskEffort
  title: string
  description: string
  status: TaskStatus
  origin: 'maestro' | 'manual'
  createdAt: string
  updatedAt: string
  runSeat?: string
  runModel?: string
  cycles?: number
  feedback?: string
  /** ajuste pequeno pós-entrega, retomado no mesmo card/conversa */
  adjustment?: { reason: string; requestedAt: string }
  /** briefing escrito pelo Maestro — vira o prompt literal do executor */
  briefing?: string
  /** gates a rodar após o dev — ausente = review+qa; [] = nenhum */
  gates?: ('review' | 'qa')[]
  /** versão do projeto quando a tarefa foi criada */
  version?: string
  /** missão dona da tarefa — ausente = "Geral" (fora de missão) */
  missionId?: string
  /** checklist de quests: 1 card por área com vários itens */
  quests?: string[]
  /** skills da biblioteca carimbadas para este card (F4) */
  skills?: string[]
  /** subagentes da biblioteca disponíveis neste card (F4) */
  agents?: string[]
  delegation?: TaskDelegationMode
  deliverable?: TaskDeliverableKind
  dependsOn?: string[]
  activePhase?: 'dev' | 'review' | 'qa'
  phaseState?: 'pending' | 'running' | 'interrupted' | 'finalizing'
  phaseStartedAt?: string
  /** 'plan' = card de PLANO da missão (F5.7) */
  kind?: 'plan'
  /** conteúdo do plano (só em kind 'plan') */
  plan?: TaskPlan
  /** card criado/gerido pelo orquestrador — apenas visual no board */
  auto?: boolean
  /** card de plano sob o qual este card nasceu (progresso por plano) */
  planId?: string
  /** item estável do grafo aprovado que originou este card */
  planItemId?: string
}

export interface NewTask {
  department: Department
  type: TaskType
  effort: TaskEffort
  title: string
  description: string
  origin: 'maestro' | 'manual'
  gates?: ('review' | 'qa')[]
  version?: string
  missionId?: string
  quests?: string[]
}

// Biblioteca de skills (F4): catálogo curado, instalado da fonte (GitHub) e
// injetado por workspace nas execuções. Espelho do SkillState do main.
export interface SkillState {
  id: string
  kind: 'skill' | 'agent'
  depts: Department[]
  group: string
  repo: string
  summary: string
  hint: string
  requires?: string[]
  defaultFor?: Department[]
  /** Só é injetada quando escolhida explicitamente para o trabalho. */
  manualOnly?: boolean
  installed: boolean
  sha?: string
  installedAt?: string
  supplyChainDecision?: 'allow' | 'review' | 'block'
  supplyChainFindings?: number
  licenseFiles?: string[]
  updateAvailable: boolean
}

// Missões (F3.8): fluxo de trabalho com orquestrador, tarefas e branch próprios.
export type MissionStatus = 'ativa' | 'integrando' | 'concluida' | 'arquivada'

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
  /** criada pelo PM: aguarda a escolha de conta/modelo/effort do orquestrador */
  pendingOrchestrator?: boolean
  /** agente pediu integrar via MCP: merge aguarda o AVAL do dono no botão ⇪ */
  pendingIntegrationApproval?: boolean
  versionId?: string
  completedAt?: string
  /** Lugar desta missão na fila serial de integração do projeto. */
  integration?: MissionIntegrationQueueView
  createdAt: string
  updatedAt: string
}

export interface NewMission {
  title: string
  goal?: string
  scope?: string
  seatId?: string
  model?: string
  effort?: string
  versionId?: string
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

export interface TerminalFileLink {
  start: number
  length: number
  text: string
}

export interface TerminalMarkdownTarget {
  ok: true
  action: 'markdown'
  paneId: string
  root: 'project' | 'pane'
  path: string
  name: string
  displayPath: string
}

export type TerminalFileOpenResult =
  | TerminalMarkdownTarget
  | { ok: true; action: 'external' }
  | { ok: true; action: 'reveal' }
  | { ok: false; error: string }

export interface PolicySlot {
  seatId: string
  model: string
}

export interface DeptPolicy {
  heavy?: PolicySlot
  light?: PolicySlot
  /** skills instaladas na função (F4 injeta no executor) */
  skills?: string[]
  /** subagentes especializados da função (F4) */
  agents?: string[]
}

export type ProjectPolicies = Partial<Record<Department, DeptPolicy>>

export interface MaestroState {
  log: MaestroEvent[]
  contextTokens: number | null
  contextLimit: number | null
  contextWindow: number | null
  model: string | null
  effort: string | null
  sessionId: string | null
  /** bypass de permissões (padrão true — fluxo reto) */
  bypass: boolean
  /** superfície sensível liberada pelo dono (bypass vale mesmo em missão sensível) */
  sensitiveBypassOk: boolean
  /** seat do Maestro persistido no projeto (escolhido no gate de entrada) */
  seatId: string | null
  /** versão atual do projeto (carimbo das tarefas novas) */
  version: string | null
}

/** Espelho READ-ONLY do plano mestre (.synkora/PROJECT_PLAN.json) para a aba
 *  Mapa. Tipagem estrutural mínima — o main envia o objeto completo. */
export interface ProjectPlanItemView {
  id: string
  title: string
  objective: string
  status: 'planned' | 'active' | 'done' | 'deferred'
  dependsOn: string[]
  wave: { id: string; name?: string }
  version?: { name: string; theme?: string }
  release?: { versionName: string; releasedAt?: string }
  missionId?: string
  outcome?: string
  deferredReason?: string
}

export interface ProjectPlanView {
  status: 'draft' | 'approved' | 'in_progress' | 'revision_pending' | 'awaiting_release' | 'done'
  projectName: string
  problem: string
  vision: string
  successCriteria: string[]
  decisions: string[]
  roadmapMeta: { expectedCount?: number; complete: boolean }
  roadmap: ProjectPlanItemView[]
  activeItemIds: string[]
  readyItemIds: string[]
  currentWaveId?: string
  approvedAt?: string
  updatedAt: string
}

export interface CatalogModel {
  id: string
  label: string
  efforts?: string[]
  defaultEffort?: string
}

export interface Catalog {
  models: CatalogModel[]
  efforts: string[]
}

/** Versão do CLI que os panes executam (espelha `main/cliUpdate.ts`). */
export interface CliStatus {
  cli: SeatCli
  version: string | null
  from?: string
  state: 'unknown' | 'updating' | 'current' | 'updated' | 'missing' | 'failed'
  detail?: string
  checkedAt: number
}

export interface MaestroEvent {
  kind: 'cmd' | 'log' | 'ok' | 'err' | 'say' | 'tool' | 'out' | 'ask'
  tag?: Department | 'maestro'
  text: string
  /** tool: input real (JSON) para expandir na UI */
  detail?: string
}

export type PermissionChoice = 'allow' | 'allow-always' | 'deny'

// Capacidades REAIS do CLI (handshake initialize do painel de fundo).
export interface CliCommand {
  name: string
  description: string
  argumentHint?: string
}

export interface CliModel {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

export interface MaestroCaps {
  commands: CliCommand[]
  models: CliModel[]
  account?: { email?: string; subscriptionType?: string }
}

// Eventos AO VIVO do painel de fundo do Maestro (não persistidos): texto
// digitando, pedidos de permissão do CLI, fim de turno.
export type MaestroLiveEvent =
  | { type: 'delta'; text: string }
  | { type: 'flush' }
  | { type: 'thinking' }
  | {
      type: 'permission'
      requestId: string
      toolName: string
      description: string
      inputPretty: string
      reason?: string
      canAlways: boolean
    }
  | { type: 'permission-cancel'; requestId: string }
  | { type: 'turn-end'; status?: 'done' | 'error' }
  | { type: 'phase'; phase: 'dev' | 'review' | 'qa' }
  | { type: 'exit' }

/** Telemetria viva de um pane, lida dos JSONL de sessão do próprio CLI. */
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

/** Spec de um pane TUI de execução (todas as fases rodam no terminal DE VERDADE). */
export interface DevPaneSpec {
  /** id do pane definido pelo main (o hub conhece cada pane pelo id) */
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

/** Pane gerenciado que continua vivo no processo principal durante um reload
 *  da interface. O renderer reaplica este snapshot pelo mesmo fluxo de
 *  `panes:open`, sem recriar a identidade do agente. */
export interface LivePaneSnapshot {
  projectId: string
  taskId: string
  spec: DevPaneSpec
}

/** Fase 3: geometria+visibilidade da WebContentsView do canvas (DIPs da
 *  página do host — titleBarStyle hidden faz o rect coincidir). */
export interface PanesViewLayout {
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/** Fase 3: recorte do estado de shell que a view de panes precisa. */
export interface PanesHostState {
  openProjectId: string | null
  mountedProjects: string[]
  remountNonce: Record<string, number>
}

/** Preferências globais editáveis; não inclui credenciais. */
export interface SynkoraPreferences {
  codeIntelligenceMode: 'automatic' | 'off'
  mcpProtocolMode: 'auto' | 'legacy' | 'modern-experimental'
  externalServicePreparation: 'automatic' | 'on-demand'
  imageProvider: 'codex' | 'openrouter'
  imageSeatId?: string
  openrouterModel?: string
  /** ESCAPE HATCH do conpty.dll empacotado (Windows). Ausente/true = ligado.
   *  O campo existe em main/settings.ts desde a F5.1 e o main já o aplica em
   *  `ptys.setConptyDll`; faltava só no espelho de tipo daqui. */
  conptyDll?: boolean
  /** Métricas fixas de todos os terminais do Synkora. */
  terminalFontSize: number
  terminalLineHeight: number
  terminalFontFamily: string
  /** vazio/ausente usa o microfone padrão do sistema */
  synVoiceInputDeviceId?: string
}

/** Snapshot seguro do main. Nenhum segredo bruto cruza esta fronteira. */
export interface SynkoraSettings extends SynkoraPreferences {
  openrouterKeyConfigured: boolean
  openrouterKeyMasked?: string
  githubTokenConfigured: boolean
  githubTokenMasked?: string
}

export type SynkoraSettingsPatch = Partial<SynkoraPreferences>
export type SettingsSecretName = 'openrouterKey' | 'githubToken'

export type RestartableService =
  | 'code-intelligence'
  | 'internal-mcp'
  | 'codex-probe'
  | 'external-services'

export interface ServicesSnapshot {
  generatedAt: number
  codeIntelligence: {
    mode: 'automatic' | 'off'
    state: 'off' | 'idle' | 'active' | 'degraded' | 'closed'
    processCount: number
    languages: Array<'TypeScript' | 'JavaScript'>
    servers: Array<{
      kind: 'typescript-native' | 'typescript-language-server'
      name: string
      version: string
      running: boolean
      activeQueries: number
      openDocuments: number
      command?: string
    }>
    telemetry: {
      starts: number
      restarts: number
      evictions: number
      failures: number
      requests: number
      reuses: number
    }
  }
  internalMcp: {
    state: 'starting' | 'ready' | 'unavailable'
    protocol: 'dual-era'
    port: number | null
  }
  codexProbe: {
    state: 'idle' | 'probing' | 'ready' | 'degraded'
    seats: Array<{
      seatId: string
      seatName: string
      state: 'idle' | 'probing' | 'ready' | 'expired'
      checkedAt: number | null
      version: string | null
      featurePresent: boolean
      featureEnabled: boolean | null
      capability: boolean
      reason?: string
    }>
  }
  externalServices: {
    preparation: 'automatic' | 'on-demand'
    state: 'unchecked' | 'available' | 'unavailable'
    checkedAt: number | null
    playwright: {
      available: boolean | null
      availability: 'on-demand'
      version: string | null
    }
  }
  paneStartup: {
    primaryMilestone: 'agent_first_output'
    windowSize: number
    samples: number
    p50Ms: number | null
    p95Ms: number | null
    milestones: Record<
      'terminal_first_frame' | 'external_mcp_available' | 'agent_first_output',
      { samples: number; p50Ms: number | null; p95Ms: number | null }
    >
  }
}

export type SynVoiceProvider = 'openai' | 'openrouter'

export interface SynVoiceProviderConfig {
  configured: boolean
  source: 'secure-storage' | 'none'
  model: string
  selectedModel: string | null
}

export interface SynVoiceConfig {
  provider: SynVoiceProvider
  configured: boolean
  source: 'secure-storage' | 'none'
  model: string
  customVocabulary: string[]
  secureStorageAvailable: boolean
  providers: Record<SynVoiceProvider, SynVoiceProviderConfig>
}

export interface SynVoiceModel {
  id: string
  name: string
  description: string
  recommended?: boolean
}

export interface SynVoiceTranscript {
  text: string
  languages: string[]
  model: string
  delivery?: 'inserted' | 'clipboard' | 'none' | 'uncertain'
}

export type SynVoiceOverlayStage =
  | 'loading'
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'processing'
  | 'inserted'

export type SynVoiceOverlayCommand = 'toggle' | 'attach' | 'open-settings'

export type SynVoiceActivationMode = 'click' | 'toggle' | 'hold'

export type SynVoiceGlobalActivationBinding =
  | {
      mode: 'toggle'
      kind: 'keyboard'
      code: string
      ctrlKey: boolean
      altKey: boolean
      shiftKey: boolean
      metaKey: boolean
    }
  | { mode: 'toggle'; kind: 'mouse'; button: number }
  | {
      mode: 'hold'
      kind: 'keyboard'
      code: string
      ctrlKey: boolean
      altKey: boolean
      shiftKey: boolean
      metaKey: boolean
    }

export type SynVoiceGlobalActivationEvent = 'toggle' | 'hold-start' | 'hold-stop'

export interface SynVoiceOverlayState {
  stage: SynVoiceOverlayStage
  elapsed: number
  level: number
  bands: number[]
  configured: boolean
  status: string
  activationMode: SynVoiceActivationMode
  activationLabel: string
}

export interface SynVoiceOverlayTooltipRequest {
  text: string
  anchor: {
    left: number
    top: number
    width: number
    height: number
  }
}

export type SynVoiceNoticeTone = 'error' | 'warning' | 'info'

export type ProgressOverlayCommand =
  | 'close'
  | 'compact'
  | 'expand'
  | 'clear-history'
  | 'open-main'
  | 'open-target'

export interface ProgressOverlayState {
  snapshot: ProgressOverlaySnapshot
  compact: boolean
  historyClearedAt: string | null
}

export interface ProgressOpenTarget {
  projectId: string
  missionId?: string
}

/** Spec do pane TUI do Maestro/orquestrador (terminal real do CLI do seat). */
export interface MaestroPaneSpec {
  paneId: string
  kind: 'claude' | 'codex'
  seatId: string
  cwd: string
  cliArgs?: string[]
  initialPrompt?: string
  appendSystemPrompt?: string
  /** modelo do orquestrador (--model no spawn) */
  model?: string
  /** presente quando é o pane do orquestrador de uma missão */
  missionId?: string
}

/** Um limite de uso da conta, já normalizado pelo main (ver seatUsage.ts). */
export interface UsageMeter {
  label: string
  pct: number
  /** `used` = barra enchendo (claude); `left` = barra esvaziando (TUI do codex) */
  mode: 'used' | 'left'
  /** 0..1 — quanto do limite já foi consumido, independente do modo */
  severity: number
  reset?: string
  window?: string
}

export interface SeatUsage {
  at: number
  account?: string
  plan?: string
  meters: UsageMeter[]
  /** texto cru; só vem preenchido quando nenhum medidor foi reconhecido */
  lines: string[]
}

/** Evento do hub (barramento central da orquestração). */
export interface HubEvent {
  ts: string
  projectId: string
  kind:
    | 'pane-open'
    | 'pane-close'
    | 'task-created'
    | 'task-updated'
    | 'report'
    | 'delegate'
    | 'merge'
    | 'image'
    | 'error'
    | 'info'
  text: string
  actor?: string
  /** missão de origem — o roteamento do hub usa para escolher o orquestrador */
  missionId?: string
  /** rotina: vai para EVENTS.md e para a UI, mas não é injetado no pane do PM */
  quiet?: boolean
}

/** Comunicação realmente entregue entre dois panes. O renderer usa os IDs
 *  estruturados para animar origem → destino sem deduzir direção por texto. */
export interface HubCommunicationEvent {
  id: string
  ts: string
  projectId: string
  missionId?: string
  taskId?: string
  sourcePaneId: string
  targetPaneId: string
  kind: 'message' | 'delegate' | 'report' | 'feedback' | 'handoff'
}

/** Build do Windows ("10.0.26200" → 26200); 0 fora do Windows. */
function windowsBuild(): number {
  if (process.platform !== 'win32') return 0
  return Number(release().split('.')[2] ?? 0) || 0
}

const api = {
  /** Dados do HOST que o renderer precisa para configurar o xterm sem
   *  importar Node: o xterm só liga o reflow e o tratamento de crescimento de
   *  linhas do ConPTY quando recebe `windowsPty` com backend+build reais (ver
   *  TerminalPane). @lydell/node-pty ignora `useConpty` (deprecado) e usa
   *  SEMPRE ConPTY no Windows — daí o backend fixo. */
  host: {
    platform: process.platform,
    windowsBuild: windowsBuild()
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    create: (name: string, path: string): Promise<Project> =>
      ipcRenderer.invoke('projects:create', name, path),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('projects:remove', id),
    rename: (id: string, name: string): Promise<Project | null> =>
      ipcRenderer.invoke('projects:rename', id, name),
    setPhoto: (id: string): Promise<Project | null> =>
      ipcRenderer.invoke('projects:setPhoto', id),
    removePhoto: (id: string): Promise<Project | null> =>
      ipcRenderer.invoke('projects:removePhoto', id),
    relocate: (id: string): Promise<RelocateResult> =>
      ipcRenderer.invoke('projects:relocate', id),
    onFlowChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('projects:flowChanged', listener)
      return () => ipcRenderer.removeListener('projects:flowChanged', listener)
    }
  },
  seats: {
    list: (): Promise<Seat[]> => ipcRenderer.invoke('seats:list'),
    create: (name: string, cli: SeatCli): Promise<Seat> =>
      ipcRenderer.invoke('seats:create', name, cli),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke('seats:rename', id, name),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('seats:remove', id),
    usage: (id: string): Promise<SeatUsage | null> =>
      ipcRenderer.invoke('seats:usage', id),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('seats:changed', listener)
      return () => ipcRenderer.removeListener('seats:changed', listener)
    }
  },
  tasks: {
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('tasks:changed', listener)
      return () => ipcRenderer.removeListener('tasks:changed', listener)
    },
    list: (projectId: string): Promise<Task[]> => ipcRenderer.invoke('tasks:list', projectId),
    create: (projectId: string, item: NewTask): Promise<Task[]> =>
      ipcRenderer.invoke('tasks:create', projectId, item),
    update: (id: string, patch: Partial<Task>): Promise<Task | undefined> =>
      ipcRenderer.invoke('tasks:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('tasks:remove', id),
    // Execução (F3): dev em pane TUI real; gates headless com eventos ao vivo.
    run: (
      projectId: string,
      taskId: string,
      seatId: string,
      model?: string,
      effort?: string
    ): Promise<DevPaneSpec | null> =>
      ipcRenderer.invoke('tasks:run', projectId, taskId, seatId, model, effort),
    // F5.7 — plano da missão: aprovar (com as lanes finais editadas pelo
    // usuário) e pausar. O resto do ciclo é do orquestrador via MCP.
    approvePlan: (
      taskId: string,
      lanes: PlanLane[],
      // revisão (task.updatedAt) que o usuário VIU no modal — o main recusa se
      // o orquestrador re-propôs no meio (CAS; caso real 2026-08-05)
      seenRevision?: string
    ): Promise<
      | Task
      | { staleRevision: true; currentRevision: string }
      | { planningEvidenceRequired: true }
      | undefined
    > =>
      ipcRenderer.invoke('tasks:planApprove', taskId, lanes, seenRevision),
    stopPlan: (taskId: string): Promise<Task | undefined> =>
      ipcRenderer.invoke('tasks:planStop', taskId),
    resolvePlanSecurityValidation: (
      taskId: string,
      decision: 'approved' | 'waived',
      evidence: string
    ): Promise<Task | undefined> =>
      ipcRenderer.invoke('tasks:planSecurityValidation', taskId, decision, evidence),
    onPaneOpen: (
      cb: (projectId: string, taskId: string, spec: DevPaneSpec) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        taskId: string,
        spec: DevPaneSpec
      ): void => cb(projectId, taskId, spec)
      ipcRenderer.on('panes:open', listener)
      return () => ipcRenderer.removeListener('panes:open', listener)
    },
    onPaneClose: (
      cb: (projectId: string, taskId: string, role: 'dev' | 'review' | 'qa') => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        taskId: string,
        role: 'dev' | 'review' | 'qa'
      ): void => cb(projectId, taskId, role)
      ipcRenderer.on('panes:close', listener)
      return () => ipcRenderer.removeListener('panes:close', listener)
    },
    onAttention: (cb: (taskId: string, paneId?: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, taskId: string, paneId?: string): void =>
        cb(taskId, paneId)
      ipcRenderer.on('tasks:attention', listener)
      return () => ipcRenderer.removeListener('tasks:attention', listener)
    },
    onPaneCloseById: (cb: (projectId: string, paneId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string, paneId: string): void =>
        cb(projectId, paneId)
      ipcRenderer.on('panes:closeById', listener)
      return () => ipcRenderer.removeListener('panes:closeById', listener)
    },
    // Troca de CONTA da fase ativa (dev/review/qa) sem perder contexto: o main
    // mata o pane da fase, transplanta a conversa quando é claude→claude (o
    // pane renasce via resume) e reabre o pane sozinho — codex/cross-CLI
    // renasce fresco sobre o worktree preservado. O effort escolhido vira o
    // novo carimbo do card.
    setPhaseSeat: (
      projectId: string,
      taskId: string,
      choice: { seatId: string; model?: string; effort?: string }
    ): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('tasks:setPhaseSeat', projectId, taskId, choice)
  },
  panes: {
    /** Snapshot dos panes gerenciados ainda vivos no processo principal.
     *  Usado para reidratar a UI depois de um reload do renderer. */
    live: (): Promise<LivePaneSnapshot[]> => ipcRenderer.invoke('panes:live'),
    /** Spec de AGENTE LIVRE (pane manual): MCP armado + persona de base limpa
     *  (claude). O agente sabe registrar o que fez via register_direct_mission. */
    freeSpec: (
      projectId: string,
      seatId: string,
      effort?: string,
      model?: string
    ): Promise<{ paneId: string; cliArgs: string[]; appendSystemPrompt?: string } | null> =>
      ipcRenderer.invoke('panes:freeSpec', projectId, seatId, effort, model),
    /** F3-c3: nascimento de pane sem fase (agente livre/test server) chega por
     *  evento do main às DUAS views — quem monta é a view de panes; o host
     *  espelha a lista. */
    onOpenFree: (
      cb: (projectId: string, kind: string, opts: Record<string, unknown>) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        kind: string,
        opts: Record<string, unknown>
      ): void => cb(projectId, kind, opts)
      ipcRenderer.on('panes:open-free', listener)
      return () => ipcRenderer.removeListener('panes:open-free', listener)
    },
    /** F3-c3: fechar pane a partir do host (■ derrubar) — o main mata o PTY e
     *  ecoa panes:closeById para as duas views. */
    requestClose: (projectId: string, paneId: string): void =>
      ipcRenderer.send('panes:requestClose', projectId, paneId),
    /** Servidor de teste do dono: pane shell no worktree da missão/versão com
     *  o script de runtime já digitado (o usuário escolhe a porta). */
    testServerSpec: (
      projectId: string,
      target: { missionId?: string; versionId?: string },
      port?: number
    ): Promise<{
      ok: boolean
      msg?: string
      paneId?: string
      cwd?: string
      command?: string
      title?: string
      missionId?: string
      versionId?: string
    }> => ipcRenderer.invoke('panes:testServerSpec', projectId, target, port),
    /** Portas em uso pelo harness (runtimes de QA + servidores de teste) —
     *  linha humana para o modal do ▶ testar (decisão do dono, 2026-08-07). */
    portsInUse: (projectId: string): Promise<string> =>
      ipcRenderer.invoke('panes:portsInUse', projectId)
  },
  // FASE 3 (docs/FASE3_PLANO.md): o canvas de Panes roda numa WebContentsView
  // própria (`?view=panes`). O HOST comanda geometria/visibilidade e empurra o
  // recorte de estado de shell; a VIEW consome os ecos do main.
  panesView: {
    /** HOST → main: onde a view fica e se aparece (o host é o dono do layout —
     *  ele sabe onde a área da aba Panes está e o que a cobre). */
    layout: (layout: PanesViewLayout): void => ipcRenderer.send('panes-view:layout', layout),
    /** HOST → main (cacheado; reload da view re-hidrata sozinho). */
    state: (state: PanesHostState): void => ipcRenderer.send('panes-view:state', state),
    /** VIEW: estado de shell do host (openProject/montados/nonce). */
    onState: (cb: (state: PanesHostState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, state: PanesHostState): void => cb(state)
      ipcRenderer.on('panes-view:state', listener)
      return () => ipcRenderer.removeListener('panes-view:state', listener)
    },
    /** VIEW: visibilidade real (gate do rAF decorativo — mapa/paperField). */
    onShown: (cb: (shown: boolean) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, shown: boolean): void => cb(shown)
      ipcRenderer.on('panes-view:shown', listener)
      return () => ipcRenderer.removeListener('panes-view:shown', listener)
    },
    // ——— relays VIEW→host (F3-c4): a view não alcança o shell do host ———
    /** VIEW: pedir navegação no host (mapa → "abrir board"). */
    navigateHost: (projectId: string, tab: string): void =>
      ipcRenderer.send('panes-view:navigate', projectId, tab),
    /** VIEW: transição de atividade de um pane de execução (o host precisa
     *  para livePaneOf/dots do rail/Home). */
    reportActivity: (paneId: string, activity: string): void =>
      ipcRenderer.send('panes-view:activity', paneId, activity),
    /** VIEW: pane promovido/visto — o pulso de atenção do host apaga junto. */
    reportAttentionCleared: (projectId: string, paneId: string): void =>
      ipcRenderer.send('panes-view:attention-cleared', projectId, paneId),
    /** HOST: consumo dos relays acima. */
    onNavigateHost: (cb: (projectId: string, tab: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string, tab: string): void =>
        cb(projectId, tab)
      ipcRenderer.on('panes-view:navigate', listener)
      return () => ipcRenderer.removeListener('panes-view:navigate', listener)
    },
    onActivity: (cb: (paneId: string, activity: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, paneId: string, activity: string): void =>
        cb(paneId, activity)
      ipcRenderer.on('panes:activity', listener)
      return () => ipcRenderer.removeListener('panes:activity', listener)
    },
    onAttentionCleared: (cb: (projectId: string, paneId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string, paneId: string): void =>
        cb(projectId, paneId)
      ipcRenderer.on('panes:attention-cleared', listener)
      return () => ipcRenderer.removeListener('panes:attention-cleared', listener)
    }
  },
  maestro: {
    /** Perguntas dirigidas ao usuário (tool ask_user): a aba do board pulsa. */
    pendingQuestions: (
      projectId: string
    ): Promise<{ projectId: string; missionKey: string; question: string; at: string }[]> =>
      ipcRenderer.invoke('maestro:pendingQuestions', projectId),
    questionSeen: (projectId: string, missionKey: string): Promise<boolean> =>
      ipcRenderer.invoke('maestro:questionSeen', projectId, missionKey),
    onUserQuestion: (
      cb: (projectId: string, missionKey: string, question: string) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        missionKey: string,
        question: string
      ): void => cb(projectId, missionKey, question)
      ipcRenderer.on('maestro:userQuestion', listener)
      return () => ipcRenderer.removeListener('maestro:userQuestion', listener)
    },
    send: (projectId: string, message: string, seatId?: string): Promise<void> =>
      ipcRenderer.invoke('maestro:send', projectId, message, seatId),
    permission: (
      projectId: string,
      requestId: string,
      choice: PermissionChoice
    ): Promise<void> => ipcRenderer.invoke('maestro:permission', projectId, requestId, choice),
    interrupt: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('maestro:interrupt', projectId),
    capabilities: (projectId: string, seatId?: string): Promise<MaestroCaps | null> =>
      ipcRenderer.invoke('maestro:capabilities', projectId, seatId),
    onLive: (cb: (evt: MaestroLiveEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: MaestroLiveEvent): void => cb(evt)
      ipcRenderer.on('maestro:live', listener)
      return () => ipcRenderer.removeListener('maestro:live', listener)
    },
    survey: (projectId: string, seatId?: string): Promise<void> =>
      ipcRenderer.invoke('maestro:survey', projectId, seatId),
    getState: (projectId: string): Promise<MaestroState> =>
      ipcRenderer.invoke('maestro:getState', projectId),
    onCtx: (cb: (tokens: number) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, tokens: number): void => cb(tokens)
      ipcRenderer.on('maestro:ctx', listener)
      return () => ipcRenderer.removeListener('maestro:ctx', listener)
    },
    reset: (projectId: string): Promise<void> => ipcRenderer.invoke('maestro:reset', projectId),
    cleanup: (projectId: string): Promise<string> =>
      ipcRenderer.invoke('maestro:cleanup', projectId),
    setSeat: (projectId: string, seatId: string, model?: string, effort?: string): Promise<void> =>
      ipcRenderer.invoke('maestro:setSeat', projectId, seatId, model, effort),
    /** reviewer independente dos gates de revisão/QA: seat+modelo+effort */
    getReviewer: (
      projectId: string
    ): Promise<{ seatId: string | null; model: string | null; effort: string | null }> =>
      ipcRenderer.invoke('maestro:getReviewer', projectId),
    setReviewer: (
      projectId: string,
      seatId?: string,
      model?: string,
      effort?: string
    ): Promise<void> => ipcRenderer.invoke('maestro:setReviewer', projectId, seatId, model, effort),
    paneSpec: (projectId: string): Promise<MaestroPaneSpec | null> =>
      ipcRenderer.invoke('maestro:paneSpec', projectId),
    setVersion: (projectId: string, version: string): Promise<void> =>
      ipcRenderer.invoke('maestro:setVersion', projectId, version),
    setModel: (projectId: string, model: string): Promise<void> =>
      ipcRenderer.invoke('maestro:setModel', projectId, model),
    setContextLimit: (projectId: string, limit: number): Promise<void> =>
      ipcRenderer.invoke('maestro:setContextLimit', projectId, limit),
    setEffort: (projectId: string, effort: string): Promise<void> =>
      ipcRenderer.invoke('maestro:setEffort', projectId, effort),
    onEvent: (cb: (evt: MaestroEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: MaestroEvent): void => cb(evt)
      ipcRenderer.on('maestro:event', listener)
      return () => ipcRenderer.removeListener('maestro:event', listener)
    }
  },
  missions: {
    list: (projectId: string): Promise<Mission[]> =>
      ipcRenderer.invoke('missions:list', projectId),
    create: (projectId: string, input: NewMission): Promise<Mission | null> =>
      ipcRenderer.invoke('missions:create', projectId, input),
    update: (
      id: string,
      patch: { title?: string; goal?: string; scope?: string; status?: 'ativa' | 'arquivada' }
    ): Promise<Mission | null> => ipcRenderer.invoke('missions:update', id, patch),
    integrate: (missionId: string): Promise<string> =>
      ipcRenderer.invoke('missions:integrate', missionId),
    remove: (missionId: string): Promise<boolean> =>
      ipcRenderer.invoke('missions:remove', missionId),
    // missão criada pelo PM: grava conta/modelo/effort do orquestrador
    // escolhidos no modal e libera o pane nascer
    confirmOrchestrator: (
      projectId: string,
      missionId: string,
      choice: { seatId?: string; model?: string; effort?: string }
    ): Promise<boolean> =>
      ipcRenderer.invoke('missions:confirmOrchestrator', projectId, missionId, choice),
    // troca de CONTA do orquestrador no meio da missão; mesmo CLI = a
    // conversa é transplantada para o seat novo (limite estourado nunca
    // prende a missão)
    setOrchestratorSeat: (
      projectId: string,
      missionId: string,
      choice: { seatId: string; model?: string; effort?: string }
    ): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('missions:setOrchestratorSeat', projectId, missionId, choice),
    paneSpec: (projectId: string, missionId: string): Promise<MaestroPaneSpec | null> =>
      ipcRenderer.invoke('missions:paneSpec', projectId, missionId),
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('missions:changed', listener)
      return () => ipcRenderer.removeListener('missions:changed', listener)
    }
  },
  backlog: {
    listVersions: (projectId: string): Promise<Version[]> =>
      ipcRenderer.invoke('backlog:listVersions', projectId),
    createVersion: (
      projectId: string,
      input: { name: string; theme?: string; goal?: string }
    ): Promise<Version | null> => ipcRenderer.invoke('backlog:createVersion', projectId, input),
    updateVersion: (
      id: string,
      patch: { name?: string; theme?: string; goal?: string; status?: VersionStatus }
    ): Promise<Version | null> => ipcRenderer.invoke('backlog:updateVersion', id, patch),
    removeVersion: (projectId: string, id: string): Promise<string> =>
      ipcRenderer.invoke('backlog:removeVersion', projectId, id),
    releaseVersion: (id: string): Promise<string> =>
      ipcRenderer.invoke('backlog:releaseVersion', id),
    listItems: (projectId: string): Promise<BacklogItem[]> =>
      ipcRenderer.invoke('backlog:listItems', projectId),
    createItem: (
      projectId: string,
      input: { title: string; type?: BacklogItemType; notes?: string; versionId?: string }
    ): Promise<BacklogItem | null> => ipcRenderer.invoke('backlog:createItem', projectId, input),
    updateItem: (
      projectId: string,
      id: string,
      patch: {
        title?: string
        notes?: string
        type?: BacklogItemType
        status?: BacklogItemStatus
        versionId?: string | null
        missionId?: string | null
      }
    ): Promise<BacklogItem | null> =>
      ipcRenderer.invoke('backlog:updateItem', projectId, id, patch),
    removeItem: (projectId: string, id: string): Promise<void> =>
      ipcRenderer.invoke('backlog:removeItem', projectId, id),
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('backlog:changed', listener)
      return () => ipcRenderer.removeListener('backlog:changed', listener)
    }
  },
  files: {
    listDocs: (projectId: string): Promise<DocFile[]> =>
      ipcRenderer.invoke('files:listDocs', projectId),
    readDoc: (
      projectId: string,
      relPath: string
    ): Promise<{ content: string; mtime: number } | null> =>
      ipcRenderer.invoke('files:readDoc', projectId, relPath),
    terminalLinks: (
      projectId: string,
      paneId: string,
      text: string
    ): Promise<TerminalFileLink[]> =>
      ipcRenderer.invoke('files:terminalLinks', projectId, paneId, text),
    openTerminalFile: (
      projectId: string,
      paneId: string,
      candidate: string
    ): Promise<TerminalFileOpenResult> =>
      ipcRenderer.invoke('files:openTerminalFile', projectId, paneId, candidate),
    readTerminalDoc: (
      projectId: string,
      paneId: string,
      root: 'project' | 'pane',
      relPath: string
    ): Promise<{ content: string; mtime: number } | null> =>
      ipcRenderer.invoke('files:readTerminalDoc', projectId, paneId, root, relPath),
    /** F3-c4 (HOST): link .md clicado em QUALQUER terminal (host ou view de
     *  panes) chega aqui — o main empurra o desfecho para quem abre a aba. */
    onNavigate: (
      cb: (projectId: string, result: TerminalFileOpenResult) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        result: TerminalFileOpenResult
      ): void => cb(projectId, result)
      ipcRenderer.on('files:navigate', listener)
      return () => ipcRenderer.removeListener('files:navigate', listener)
    }
  },
  catalog: {
    get: (cli: SeatCli, seatId?: string): Promise<Catalog> =>
      ipcRenderer.invoke('catalog:get', cli, seatId)
  },
  // Versão dos CLIs que os panes executam: o app checa/atualiza sozinho no
  // boot, e o botão do titlebar força a rodada.
  cli: {
    status: (): Promise<CliStatus[]> => ipcRenderer.invoke('cli:status'),
    update: (): Promise<CliStatus[]> => ipcRenderer.invoke('cli:update'),
    onStatus: (cb: (all: CliStatus[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, all: CliStatus[]): void => cb(all)
      ipcRenderer.on('cli:status', listener)
      return () => ipcRenderer.removeListener('cli:status', listener)
    }
  },
  perf: {
    /** travada do renderer (event-loop stall) → caixa-preta */
    reportStall: (lagMs: number): void => ipcRenderer.send('perf:renderer-stall', lagMs)
  },
  harness: {
    setBypass: (projectId: string, on: boolean): Promise<void> =>
      ipcRenderer.invoke('harness:setBypass', projectId, on),
    /** libera bypass mesmo em superfície sensível (por projeto; auditado) */
    setSensitiveBypass: (projectId: string, on: boolean): Promise<void> =>
      ipcRenderer.invoke('harness:setSensitiveBypass', projectId, on)
  },
  projectPlan: {
    /** plano mestre (PROJECT_PLAN.json) para a aba Mapa — null sem plano */
    get: (projectId: string): Promise<ProjectPlanView | null> =>
      ipcRenderer.invoke('projectPlan:get', projectId),
    /** Ações autoritativas do dono; tools do Maestro só conseguem solicitá-las. */
    approve: (projectId: string, expectedUpdatedAt: string): Promise<string> =>
      ipcRenderer.invoke('projectPlan:approve', projectId, expectedUpdatedAt),
    startMission: (
      projectId: string,
      itemId: string,
      expectedUpdatedAt: string
    ): Promise<string> =>
      ipcRenderer.invoke('projectPlan:startMission', projectId, itemId, expectedUpdatedAt)
  },
  hub: {
    onEvent: (cb: (evt: HubEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: HubEvent): void => cb(evt)
      ipcRenderer.on('hub:event', listener)
      return () => ipcRenderer.removeListener('hub:event', listener)
    },
    onCommunication: (cb: (evt: HubCommunicationEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: HubCommunicationEvent): void => cb(evt)
      ipcRenderer.on('hub:communication', listener)
      return () => ipcRenderer.removeListener('hub:communication', listener)
    }
  },
  policies: {
    get: (projectId: string): Promise<ProjectPolicies> =>
      ipcRenderer.invoke('policies:get', projectId),
    set: (projectId: string, dept: Department, policy: DeptPolicy): Promise<void> =>
      ipcRenderer.invoke('policies:set', projectId, dept, policy),
    /** o MAIN mudou a política (ex.: PM definiu o kit ★ via set_default_skills) */
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('policies:changed', listener)
      return () => ipcRenderer.removeListener('policies:changed', listener)
    }
  },
  settings: {
    get: (): Promise<SynkoraSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: SynkoraSettingsPatch): Promise<SynkoraSettings> =>
      ipcRenderer.invoke('settings:set', patch),
    setSecret: (name: SettingsSecretName, value: string): Promise<SynkoraSettings> =>
      ipcRenderer.invoke('settings:secret:set', name, value),
    clearSecret: (name: SettingsSecretName): Promise<SynkoraSettings> =>
      ipcRenderer.invoke('settings:secret:clear', name),
    /** F3-c4: o outro lado (host ↔ view de panes) gravou settings — recarrega
     *  (o zoom de fonte do terminal vale nas duas). */
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    }
  },
  services: {
    get: (includeLocalDetails = false): Promise<ServicesSnapshot> =>
      ipcRenderer.invoke('services:get', includeLocalDetails),
    restart: (service: RestartableService): Promise<ServicesSnapshot> =>
      ipcRenderer.invoke('services:restart', service)
  },
  progress: {
    ready: (): void => ipcRenderer.send('progress:renderer-ready'),
    openOverlay: (): Promise<void> => ipcRenderer.invoke('progress:overlay-open'),
    getSnapshot: (): Promise<ProgressOverlaySnapshot> =>
      ipcRenderer.invoke('progress:get-snapshot'),
    onSnapshot: (cb: (snapshot: ProgressOverlaySnapshot) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, snapshot: ProgressOverlaySnapshot): void =>
        cb(snapshot)
      ipcRenderer.on('progress:snapshot-changed', listener)
      return () => ipcRenderer.removeListener('progress:snapshot-changed', listener)
    },
    onOpenTarget: (cb: (target: ProgressOpenTarget) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, target: ProgressOpenTarget): void => cb(target)
      ipcRenderer.on('progress:open-target', listener)
      return () => ipcRenderer.removeListener('progress:open-target', listener)
    }
  },
  voice: {
    getConfig: (): Promise<SynVoiceConfig> => ipcRenderer.invoke('voice:getConfig'),
    setProvider: (provider: SynVoiceProvider): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setProvider', provider),
    setModel: (provider: SynVoiceProvider, model: string | null): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setModel', provider, model),
    setCustomVocabulary: (terms: string[]): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setCustomVocabulary', terms),
    listModels: (provider: SynVoiceProvider): Promise<SynVoiceModel[]> =>
      ipcRenderer.invoke('voice:listModels', provider),
    setApiKey: (provider: SynVoiceProvider, key: string | null): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setApiKey', provider, key),
    openApiKeys: (provider: SynVoiceProvider): Promise<void> =>
      ipcRenderer.invoke('voice:openApiKeys', provider),
    transcribe: (request: {
      requestId: string
      audio: ArrayBuffer
      mimeType: string
      durationMs: number
      externalTargetToken?: string | null
    }): Promise<SynVoiceTranscript> => ipcRenderer.invoke('voice:transcribe', request),
    // banquinho das últimas falas (2026-08-06): recuperar transcrição perdida
    history: (): Promise<Array<{ text: string; at: string }>> =>
      ipcRenderer.invoke('voice:history'),
    historyCopy: (index: number): Promise<boolean> =>
      ipcRenderer.invoke('voice:historyCopy', index),
    cancel: (requestId: string): void => ipcRenderer.send('voice:cancel', requestId),
    captureExternalTarget: (): Promise<string | null> =>
      ipcRenderer.invoke('voice:external-begin'),
    discardExternalTarget: (token: string): void =>
      ipcRenderer.send('voice:external-discard', token),
    openOverlay: (): Promise<void> => ipcRenderer.invoke('voice:overlay-open'),
    isOverlayDetached: (): Promise<boolean> => ipcRenderer.invoke('voice:overlay-is-detached'),
    publishOverlayState: (state: SynVoiceOverlayState): void =>
      ipcRenderer.send('voice:overlay-state', state),
    onOverlayCommand: (cb: (command: SynVoiceOverlayCommand) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, command: SynVoiceOverlayCommand): void => cb(command)
      ipcRenderer.on('voice:overlay-command-received', listener)
      return () => ipcRenderer.removeListener('voice:overlay-command-received', listener)
    },
    onOverlayVisibility: (cb: (detached: boolean) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, detached: boolean): void => cb(Boolean(detached))
      ipcRenderer.on('voice:overlay-visibility', listener)
      return () => ipcRenderer.removeListener('voice:overlay-visibility', listener)
    },
    setGlobalActivation: (binding: SynVoiceGlobalActivationBinding | null): void =>
      ipcRenderer.send('voice:global-activation-config', binding),
    onGlobalActivation: (cb: (event: SynVoiceGlobalActivationEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, event: SynVoiceGlobalActivationEvent): void => cb(event)
      ipcRenderer.on('voice:global-activation-event', listener)
      return () => ipcRenderer.removeListener('voice:global-activation-event', listener)
    },
    showNotice: (message: string, tone: SynVoiceNoticeTone = 'error'): void =>
      ipcRenderer.send('voice:show-notice', { message, tone })
  },
  skills: {
    list: (): Promise<SkillState[]> => ipcRenderer.invoke('skills:list'),
    install: (id: string): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('skills:install', id),
    installMany: (ids: string[]): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('skills:installMany', ids),
    addCustom: (url: string, dept: Department): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('skills:addCustom', url, dept),
    /** subagente custom: URL do ARQUIVO .md (blob/raw) — id do frontmatter name */
    addCustomAgent: (url: string, dept: Department): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('skills:addCustomAgent', url, dept),
    remove: (id: string): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('skills:remove', id),
    update: (id: string): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('skills:update', id),
    check: (): Promise<number> => ipcRenderer.invoke('skills:check'),
    /** exporta a biblioteca inteira (skills + subagentes + customs) num .zip */
    exportLib: (): Promise<{ ok: boolean; msg: string }> => ipcRenderer.invoke('skills:export'),
    /** importa um .zip exportado em outra máquina — instala sem rede */
    importLib: (): Promise<{ ok: boolean; msg: string }> => ipcRenderer.invoke('skills:import'),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('skills:changed', listener)
      return () => ipcRenderer.removeListener('skills:changed', listener)
    }
  },
  blackbox: {
    /** exporta o pacote de diagnóstico completo (diário + estado + Git) */
    exportDiagnostics: (): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('blackbox:export'),
    /** últimas entradas do diário da caixa-preta, já com linha legível */
    tail: (limit?: number): Promise<BlackboxTailEntry[]> =>
      ipcRenderer.invoke('blackbox:tail', limit)
  },
  clipboard: {
    hasImage: (): boolean => ipcRenderer.sendSync('clipboard:hasImage') as boolean,
    saveImage: (projectId: string): Promise<string | null> =>
      ipcRenderer.invoke('clipboard:saveImage', projectId),
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText')
  },
  /** Caminho absoluto de um File arrastado (Electron 43: File.path não existe;
   *  só o preload enxerga via webUtils). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  attachments: {
    /** copia arquivos soltos num pane para .synkora/attachments do projeto */
    import: (projectId: string, paths: string[]): Promise<string[]> =>
      ipcRenderer.invoke('attachments:import', projectId, paths)
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  pty: {
    create: (opts: {
      id: string
      cwd: string
      kind: PaneKind
      seatId?: string
      taskId?: string
      initialPrompt?: string
      model?: string
      cliArgs?: string[]
      appendSystemPrompt?: string
      cols?: number
      rows?: number
      logFile?: string
    }): Promise<boolean> => ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    /** Pedido inicial do renderer, antes da espera pela estabilização do layout. */
    markStartupRequest: (id: string): void => ipcRenderer.send('pty:startup-request', id),
    /** Primeiro frame com bytes do PTY realmente pintado pelo xterm. */
    markFirstFrame: (id: string): void => ipcRenderer.send('pty:first-frame', id),
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, data: string): void => cb(id, data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (cb: (id: string, exitCode: number) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, exitCode: number): void =>
        cb(id, exitCode)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    },
    /** o usuário digitou /clear (claude) ou /new (codex) neste pane — o xterm
     *  limpa tela E scrollback (sinal do comando, não adivinhação por texto) */
    onReset: (cb: (id: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string): void => cb(id)
      ipcRenderer.on('pty:reset', listener)
      return () => ipcRenderer.removeListener('pty:reset', listener)
    },
    /** últimas linhas LIMPAS que o agente escreveu (as mesmas do transcript) —
     *  alimenta os cartões-vivos: dá para ver o que 20 panes estão fazendo sem
     *  pintar 20 terminais */
    onLastLines: (cb: (id: string, lines: string[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, lines: string[]): void => cb(id, lines)
      ipcRenderer.on('pane:lastlines', listener)
      return () => ipcRenderer.removeListener('pane:lastlines', listener)
    },
    onStats: (cb: (id: string, stats: PaneStats) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, stats: PaneStats): void =>
        cb(id, stats)
      ipcRenderer.on('panes:stats', listener)
      return () => ipcRenderer.removeListener('panes:stats', listener)
    },
    /** effort REAL detectado no banner do CLI (o JSONL não registra effort) */
    onEffort: (cb: (id: string, effort: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, effort: string): void =>
        cb(id, effort)
      ipcRenderer.on('pty:effort', listener)
      return () => ipcRenderer.removeListener('pty:effort', listener)
    },
    /** modelo REAL detectado no banner do CLI — fallback do badge [MODELO]
     *  em panes sem modelo configurado (antes do JSONL da sessão existir) */
    onModel: (cb: (id: string, model: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, model: string): void =>
        cb(id, model)
      ipcRenderer.on('pty:model', listener)
      return () => ipcRenderer.removeListener('pty:model', listener)
    }
  }
}

export type SynkoraApi = typeof api

const overlayApi = {
  getState: (): Promise<SynVoiceOverlayState> => ipcRenderer.invoke('voice:overlay-get-state'),
  prepareInteraction: (): void => ipcRenderer.send('voice:overlay-prepare-interaction'),
  // banquinho das últimas falas TAMBÉM no mini destacado (2026-08-06): a
  // janela é fixa — abrir o menu cresce a própria janela via IPC dedicado
  history: (): Promise<Array<{ text: string; at: string }>> =>
    ipcRenderer.invoke('voice:overlay-history'),
  historyCopy: (index: number): Promise<boolean> =>
    ipcRenderer.invoke('voice:overlay-history-copy', index),
  setHistoryOpen: (open: boolean): void =>
    ipcRenderer.send('voice:overlay-history-open', open),
  command: (command: SynVoiceOverlayCommand): void =>
    ipcRenderer.send('voice:overlay-command', command),
  showTooltip: (request: SynVoiceOverlayTooltipRequest): void =>
    ipcRenderer.send('voice:overlay-tooltip-show', request),
  hideTooltip: (): void => ipcRenderer.send('voice:overlay-tooltip-hide'),
  onState: (cb: (state: SynVoiceOverlayState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: SynVoiceOverlayState): void => cb(state)
    ipcRenderer.on('voice:overlay-state-changed', listener)
    return () => ipcRenderer.removeListener('voice:overlay-state-changed', listener)
  }
}

export type SynkoraOverlayApi = typeof overlayApi

const progressOverlayApi = {
  getState: (): Promise<ProgressOverlayState> =>
    ipcRenderer.invoke('progress:overlay-get-state'),
  command: (command: ProgressOverlayCommand, target?: ProgressOpenTarget): void =>
    ipcRenderer.send('progress:overlay-command', { command, ...target }),
  /** Alça própria de resize (janela transparente não tem resize nativo). */
  resize: (width: number, height: number): void =>
    ipcRenderer.send('progress:overlay-resize', { width, height }),
  onSnapshot: (cb: (snapshot: ProgressOverlaySnapshot) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, snapshot: ProgressOverlaySnapshot): void =>
      cb(snapshot)
    ipcRenderer.on('progress:snapshot-changed', listener)
    return () => ipcRenderer.removeListener('progress:snapshot-changed', listener)
  },
  onMode: (cb: (state: { compact: boolean }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: { compact: boolean }): void => cb(state)
    ipcRenderer.on('progress:overlay-mode-changed', listener)
    return () => ipcRenderer.removeListener('progress:overlay-mode-changed', listener)
  },
  onHistory: (cb: (state: { clearedAt: string | null }) => void): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      state: { clearedAt: string | null }
    ): void => cb(state)
    ipcRenderer.on('progress:overlay-history-changed', listener)
    return () => ipcRenderer.removeListener('progress:overlay-history-changed', listener)
  }
}

export type SynkoraProgressOverlayApi = typeof progressOverlayApi

const isSynVoiceOverlay = process.argv.includes('--synvoice-overlay')
const isProgressOverlay = process.argv.includes('--progress-overlay')

if (isProgressOverlay) {
  contextBridge.exposeInMainWorld('synkoraProgressOverlay', progressOverlayApi)
} else if (isSynVoiceOverlay) contextBridge.exposeInMainWorld('synkoraOverlay', overlayApi)
else contextBridge.exposeInMainWorld('synkora', api)

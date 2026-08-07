import { create } from 'zustand'
import type { CanvasNodeLayout } from './paneCanvas'
import type {
  SettingsSecretName,
  SkillState,
  SynkoraSettings,
  SynkoraSettingsPatch
} from '../../preload/index'
import { applyDeptHueVars, DEPT_HUES_LS_KEY, loadDeptHues } from './departments'

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
export type UniverseTab = 'board' | 'panes' | 'backlog' | 'arquivos' | 'mapa'
export type AppPage = 'workspace' | 'settings'
export type SettingsSection =
  | 'appearance'
  | 'accounts'
  | 'skills'
  | 'agents'
  | 'services'
  | 'images'
  | 'voice'

/** Caixa de um pane no canvas: posição no MUNDO (px) + tamanho + z-order. */
/** Deslocamento de um card no MAPA, relativo à vaga dele no anel. É offset (e
 *  não posição absoluta) de propósito: redimensionar a janela recalcula o anel
 *  e o card arrastado continua onde o usuário deixou, em relação ao conjunto. */
export interface NodeOffset {
  dx: number
  dy: number
}

/** Estado da aba PANES — POR PROJETO. Universos ficam todos montados, então
 *  qualquer coisa daqui na raiz do store faz o 2º projeto sobrescrever o 1º
 *  (era o caso de focusedPane/monitorMode/paneLayout). */
export interface PanesUi {
  /** nó ancorado: `mission:<id>`, 'geral', 'orfaos' — null = só o mapa */
  anchored: string | null
  /** panes que o usuário PROMOVEU a terminal no mosaico (mais recente
   *  primeiro). Acima do teto de ladrilhos legíveis o resto vira cartão-vivo —
   *  clicar num cartão empurra o id para cá e troca por transform, sem resize. */
  promoted: string[]
  /** pane ocupando o palco inteiro (▢) */
  expanded: string | null
  /** modo imerso: o mapa colapsa numa espinha de glifos */
  immersive: boolean
  /** Layout encaixavel por no do mapa. As caixas continuam numa lista plana no
   *  DOM; aqui ficam apenas preset, ordem e proporcoes dos divisores. */
  canvasByNode: Record<string, CanvasNodeLayout>
}

export const PANES_UI_DEFAULT: PanesUi = {
  anchored: null,
  promoted: [],
  expanded: null,
  immersive: false,
  canvasByNode: {}
}

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
      /** F6.6: em modo estrito o GATE ESPECIALISTA (securityReview aprovado)
       *  preenche a validação sozinho com actor 'security-gate'. */
      actor: 'user' | 'security-gate'
      resolvedAt: string
      evidence: string
    }

// F5.7 — card de PLANO: proposta do orquestrador; o usuário lê, ajusta as
// lanes (seat/modelo/effort por função) e aprova. Depois é tudo com ele.
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
  plan?: TaskPlan
  /** card do orquestrador em modo plano — apenas visual (sem mover/executar) */
  auto?: boolean
  /** card de plano sob o qual este card nasceu (progresso por plano) */
  planId?: string
  /** item estável do grafo aprovado que originou este card */
  planItemId?: string
}

/** Retrato de um universo para o card da Home. Vive no store (e não num
 *  `useState` do card) porque os três canais que o invalidam — `tasks:changed`,
 *  `missions:changed`, `backlog:changed` — chegam no App, não no card. */
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
  /** tarefas das missões da versão: concluídas / total */
  feitas: number
  total: number
  /** tarefas da versão em execução/qa AGORA (vivo) */
  emExec: number
}

export interface HomeStats {
  /** VIVOS, globais (nunca acumulam): missões 'ativa' + 'integrando' */
  missoesAtivas: number
  /** tarefas em andamento agora (execução + qa), soltas incluídas */
  emCurso: number
  /** uma entrada por versão ABERTA (em dev), mais antiga primeiro; sem
   *  nenhuma aberta, a última LANÇADA entra sozinha como referência ("o que
   *  ela entregou"). Vazio = projeto nunca teve versão. */
  versoes: VersionStats[]
  /** quando foi lido (a ausência da entrada é que significa "não li ainda") */
  at: number
}

// Missão (F3.8): fluxo de trabalho com orquestrador, tarefas e branch próprios.
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
  updatedAt: string
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

export interface MaestroEvent {
  kind: 'cmd' | 'log' | 'ok' | 'err' | 'say' | 'tool' | 'out' | 'ask'
  tag?: Department | 'maestro'
  text: string
  detail?: string
}

export type PermissionChoice = 'allow' | 'allow-always' | 'deny'

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

export interface MaestroPermRequest {
  requestId: string
  toolName: string
  description: string
  inputPretty: string
  reason?: string
  canAlways: boolean
}

export type MaestroLiveEvent =
  | { type: 'delta'; text: string }
  | { type: 'flush' }
  | { type: 'thinking' }
  | ({ type: 'permission' } & MaestroPermRequest)
  | { type: 'permission-cancel'; requestId: string }
  | { type: 'turn-end'; status?: 'done' | 'error' }
  | { type: 'phase'; phase: 'dev' | 'review' | 'qa' }
  | { type: 'exit' }

// Execução headless de uma tarefa (F3): espelho do executor no board.
export interface TaskRunView {
  status: 'running' | 'done' | 'error'
  phase: 'dev' | 'review' | 'qa'
  events: MaestroEvent[]
  stream: string
  perm: MaestroPermRequest | null
}

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
  tasks: Task[]
  maestroBusy: boolean
  maestroLog: MaestroEvent[]
  maestroCtx: number | null
  maestroCtxLimit: number | null
  maestroCtxWindow: number | null
  maestroSessionId: string | null
  maestroModel: string | null
  maestroEffort: string | null
  maestroStream: string
  maestroThinking: boolean
  maestroPerm: MaestroPermRequest | null
  /** versão atual do projeto (carimbo das tarefas novas) */
  maestroVersion: string | null
  setMaestroVersion: (projectId: string, version: string) => Promise<void>
  /** bypass de permissões (padrão ON — fluxo reto sem prompts) */
  maestroBypass: boolean
  toggleBypass: (projectId: string, on: boolean) => Promise<void>
  /** superfície sensível liberada (bypass vale mesmo em missão sensível) */
  sensitiveBypassOk: boolean
  toggleSensitiveBypass: (projectId: string, on: boolean) => Promise<void>
  /** seat do Maestro persistido no projeto (null = gate de escolha na entrada) */
  maestroSeatId: string | null
  setMaestroSeat: (projectId: string, seatId: string, model?: string, effort?: string) => Promise<void>
  /** incrementa a cada definição de seat/modelo/effort — o Board respawna o
   *  pane. POR PROJETO: com um contador único, o bump feito no universo B ficava
   *  PENDENTE no Board de A (que sai no guard `!isActive` sem consumir o ref) e,
   *  ao voltar para A, o Maestro de A era morto e reaberto do nada. */
  maestroSpecBumpByProject: Record<string, number>
  /** /estudar em andamento, POR PROJETO (um boolean global mostrava o spinner e
   *  travava o botão no PM de OUTRO universo) */
  surveyBusyByProject: Record<string, boolean>
  /** força REMONTAGEM de um universo já montado (relocação de pasta) */
  remountNonce: Record<string, number>
  /** zera a telemetria de um paneId (respawn de mesmo id) */
  resetPaneTelemetry: (paneId: string) => void
  /** estado do maestro já carregado do main? (evita o gate piscar na entrada) */
  maestroStateLoaded: boolean
  /** gate de escolha de seat aberto por ação explícita (⇄ seat) */
  seatGateOpen: boolean
  setSeatGateOpen: (open: boolean) => void
  maestroCaps: MaestroCaps | null
  maestroCapsLoading: boolean
  maestroCapsKey: string | null
  loadMaestroCaps: (projectId: string, seatId?: string) => Promise<MaestroCaps | null>
  taskRuns: Record<string, TaskRunView>
  loadTaskRuns: (projectId: string) => Promise<void>
  runTask: (
    projectId: string,
    taskId: string,
    seatId: string,
    model?: string,
    effort?: string
  ) => Promise<void>
  openDevPane: (projectId: string, taskId: string, spec: DevPaneSpec) => void
  closeTaskPane: (projectId: string, taskId: string, role: 'dev' | 'review' | 'qa') => void
  applyTaskFeedback: (projectId: string, taskId: string, text: string, spec: DevPaneSpec) => void
  /** pane de tarefa pediu aprovação → card pulsa até o usuário interagir */
  taskAttention: Record<string, boolean>
  setTaskAttention: (taskId: string, paneId?: string) => void
  clearTaskAttention: (taskId: string) => void
  /** aprovação pendente POR PANE — dev, ajudantes e gate dividem o mesmo taskId,
   *  então o aviso do card não serve para saber QUAL terminal está travado */
  paneAttention: Record<string, boolean>
  clearPaneAttention: (projectId: string, paneId: string) => void
  /** Perguntas do ask_user por projeto (projectId → missionKey → pergunta) —
   *  GLOBAL para a atenção alcançar de qualquer lugar (rail, abas do
   *  universo), não só a aba de missão do board (pedido do usuário,
   *  2026-08-06). Quem dispensa é o Board VISÍVEL ao visitar a aba. */
  askQuestions: Record<string, Record<string, string>>
  loadAskQuestions: (projectId: string) => Promise<void>
  noteUserQuestion: (projectId: string, missionKey: string, question: string) => void
  clearAskQuestion: (projectId: string, missionKey: string) => void
  handleRunEvent: (taskId: string, evt: MaestroEvent) => void
  handleRunLive: (taskId: string, evt: MaestroLiveEvent) => void
  answerRunPerm: (taskId: string, choice: PermissionChoice) => Promise<void>
  sendToRun: (taskId: string, message: string) => Promise<void>
  interruptRun: (taskId: string) => Promise<void>
  handoffRun: (projectId: string, taskId: string) => Promise<void>
  closeRun: (taskId: string) => Promise<void>
  handleMaestroLive: (evt: MaestroLiveEvent) => void
  sendMaestro: (projectId: string, message: string, seatId?: string) => Promise<void>
  answerMaestroPerm: (projectId: string, choice: PermissionChoice) => Promise<void>
  interruptMaestro: (projectId: string) => Promise<void>
  setMaestroCtxLimit: (limit: number | null) => void
  appendMaestroEvent: (evt: MaestroEvent) => void
  setMaestroCtx: (tokens: number | null) => void
  clearMaestroLog: () => void
  loadMaestroLog: (projectId: string) => Promise<void>
  surveyMaestro: (projectId: string, seatId?: string) => Promise<void>
  policies: ProjectPolicies
  loadPolicies: (projectId: string) => Promise<void>
  setPolicy: (projectId: string, dept: Department, policy: DeptPolicy) => Promise<void>
  /** biblioteca de skills (F4) — GLOBAL à máquina (não é por projeto) */
  skillsLib: SkillState[]
  loadSkills: () => Promise<void>
  /** missões do projeto ATIVO */
  missions: Mission[]
  loadMissions: (projectId: string) => Promise<void>
  createMission: (
    projectId: string,
    input: {
      title: string
      goal?: string
      scope?: string
      seatId?: string
      model?: string
      effort?: string
      versionId?: string
    }
  ) => Promise<Mission | null>
  archiveMission: (id: string, archived: boolean) => Promise<void>
  deleteMission: (id: string) => Promise<void>
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
  createProject: (name: string, path: string) => Promise<void>
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
  setSettingsSecret: (name: SettingsSecretName, value?: string) => Promise<void>
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
  addPane: (projectId: string, kind: PaneKind, opts?: PaneOptions) => void
  closePane: (projectId: string, paneId: string) => void
  /** estado da aba PANES por projeto (nó ancorado, destaque, imerso, cartões) */
  panesUiByProject: Record<string, PanesUi>
  setPanesUi: (projectId: string, patch: Partial<PanesUi>) => void
  /** cards do mapa arrastados pelo usuário, por projeto */
  mapLayoutByProject: Record<string, Record<string, NodeOffset>>
  setNodeOffset: (projectId: string, nodeId: string, off: NodeOffset) => void
  resetNodeOffsets: (projectId: string) => void
  loadPanesUi: (projectId: string) => void
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
  loadTasks: (projectId: string) => Promise<void>
  createTask: (
    projectId: string,
    department: Department,
    title: string,
    description: string,
    missionId?: string
  ) => Promise<boolean>
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>
  removeTask: (id: string) => Promise<void>
  /** F5.7 — aprova o plano com as lanes finais (editadas pelo usuário) */
  /** Aprova o plano; devolve {staleRevision} quando o orquestrador re-propôs
   *  depois da revisão que o usuário estava lendo (CAS — a UI deve avisar e
   *  recarregar em vez de aprovar contrato desatualizado). */
  approvePlan: (
    id: string,
    lanes: PlanLane[],
    seenRevision?: string
  ) => Promise<{ staleRevision: true; currentRevision: string } | undefined>
  /** F5.7 — pausa o plano em execução (volta ao backlog) */
  stopPlan: (id: string) => Promise<void>
  resolvePlanSecurityValidation: (
    id: string,
    decision: 'approved' | 'waived',
    evidence: string
  ) => Promise<void>
}

const KIND_LABEL: Record<PaneKind, string> = {
  shell: 'Terminal',
  claude: 'Claude',
  codex: 'Codex'
}

/** layout do canvas é preferência de UI: localStorage por projeto (não vai para
 *  o main — nada aqui precisa sobreviver a uma reinstalação). */
// Persistência da aba PANES: preferência de UI pura (nada aqui precisa
// sobreviver a uma reinstalação), com `v` para invalidar formato antigo sem
// quebrar. Debounce curto porque arrastar card commita no pointerup.
const PANES_UI_KEY = (projectId: string): string => `synkora.panesUi.${projectId}`
const MAP_LAYOUT_KEY = (projectId: string): string => `synkora.mapLayout.${projectId}`

function persistJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: 1, d: value }))
  } catch {
    // cota estourada não pode derrubar a UI
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { v?: number; d?: T }
    return parsed?.v === 1 && parsed.d !== undefined ? parsed.d : fallback
  } catch {
    return fallback
  }
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
  tasks: [],
  maestroBusy: false,
  maestroLog: [],

  maestroCtx: null,
  maestroCtxLimit: null,
  maestroCtxWindow: null,
  maestroSessionId: null,
  maestroModel: null,
  maestroEffort: null,
  maestroStream: '',
  maestroThinking: false,
  maestroPerm: null,

  maestroVersion: null,
  setMaestroVersion: async (projectId, version) => {
    set({ maestroVersion: version.trim() || null })
    await window.synkora.maestro.setVersion(projectId, version)
  },
  maestroBypass: true,
  toggleBypass: async (projectId, on) => {
    set({ maestroBypass: on })
    await window.synkora.harness.setBypass(projectId, on)
  },
  sensitiveBypassOk: false,
  toggleSensitiveBypass: async (projectId, on) => {
    set({ sensitiveBypassOk: on })
    // preload antigo (HMR sem restart) pode não ter a API nova
    if (window.synkora.harness.setSensitiveBypass) {
      await window.synkora.harness.setSensitiveBypass(projectId, on)
    }
  },
  maestroSeatId: null,
  maestroSpecBumpByProject: {},
  setMaestroSeat: async (projectId, seatId, model, effort) => {
    await window.synkora.maestro.setSeat(projectId, seatId, model, effort)
    set((s) => ({
      maestroSeatId: seatId,
      maestroModel: model ?? null,
      maestroEffort: effort ?? null,
      seatGateOpen: false,
      // o main matou o pane DESTE projeto — o bump força só o Board dele a
      // buscar spec nova
      maestroSpecBumpByProject: {
        ...s.maestroSpecBumpByProject,
        [projectId]: (s.maestroSpecBumpByProject[projectId] ?? 0) + 1
      }
    }))
  },
  maestroStateLoaded: false,
  seatGateOpen: false,
  setSeatGateOpen: (open) => set({ seatGateOpen: open }),
  maestroCaps: null,
  maestroCapsLoading: false,
  maestroCapsKey: null,

  // Comandos/modelos REAIS do painel de fundo (spawna se preciso, sem tokens).
  // Cache por projeto+seat: trocar de seat recarrega do config certo.
  loadMaestroCaps: async (projectId, seatId) => {
    const key = `${projectId}:${seatId ?? ''}`
    const s = get()
    if (s.maestroCaps && s.maestroCapsKey === key) return s.maestroCaps
    if (s.maestroCapsLoading) return null
    set({ maestroCapsLoading: true })
    try {
      const caps = await window.synkora.maestro.capabilities(projectId, seatId)
      set({ maestroCaps: caps, maestroCapsKey: key, maestroCapsLoading: false })
      return caps
    } catch {
      set({ maestroCapsLoading: false })
      return null
    }
  },

  appendMaestroEvent: (evt) => set((s) => ({ maestroLog: [...s.maestroLog, evt] })),
  setMaestroCtx: (tokens) => set({ maestroCtx: tokens }),
  setMaestroCtxLimit: (limit) => set({ maestroCtxLimit: limit }),
  clearMaestroLog: () =>
    set({
      maestroLog: [],
      maestroCtx: null,
      maestroSessionId: null,
      maestroStream: '',
      maestroThinking: false,
      maestroPerm: null
    }),

  // Espelho dos eventos ao vivo do painel de fundo: o chat "bonito" renderiza
  // exatamente o que o processo real está fazendo agora.
  handleMaestroLive: (evt) => {
    switch (evt.type) {
      // delta/thinking/permission também LIGAM o busy: com steering e fila,
      // um turno novo pode começar depois de um turn-end sem send() nosso.
      case 'delta':
        set((s) => ({
          maestroStream: s.maestroStream + evt.text,
          maestroThinking: false,
          maestroBusy: true
        }))
        break
      case 'flush':
        set({ maestroStream: '' })
        break
      case 'thinking':
        set({ maestroThinking: true, maestroBusy: true })
        break
      case 'permission': {
        const { type: _type, ...perm } = evt
        set({ maestroPerm: perm, maestroThinking: false, maestroBusy: true })
        break
      }
      case 'permission-cancel':
        set((s) =>
          s.maestroPerm?.requestId === evt.requestId ? { maestroPerm: null } : {}
        )
        break
      case 'turn-end':
      case 'exit': {
        set({ maestroStream: '', maestroThinking: false, maestroBusy: false, maestroPerm: null })
        const pid = get().openProjectId
        if (pid) {
          void window.synkora.maestro.getState(pid).then((st) => {
            set({
              maestroSessionId: st.sessionId,
              maestroModel: st.model,
              maestroEffort: st.effort,
              maestroCtxWindow: st.contextWindow,
              maestroCtxLimit: st.contextLimit
            })
          })
        }
        break
      }
    }
  },

  taskRuns: {},

  loadTaskRuns: async (projectId) => {
    const snaps = await window.synkora.tasks.runState(projectId)
    // Resposta ATRASADA de um projeto que já não é o ativo sobrescrevia o
    // estado global do universo VISÍVEL (troca rápida no rail deixava o board
    // com os dados do outro, de forma permanente).
    if (get().openProjectId !== projectId) return
    const runs: Record<string, TaskRunView> = {}
    for (const s of snaps) {
      runs[s.taskId] = { status: s.status, phase: s.phase, events: s.events, stream: '', perm: null }
    }
    set({ taskRuns: runs })
  },

  // Dev roda num PANE TUI DE VERDADE: o main prepara worktree+transcript e
  // devolve a spec. Como esta ação partiu do usuário, mostramos o pane aberto.
  runTask: async (projectId, taskId, seatId, model, effort) => {
    const spec = await window.synkora.tasks.run(projectId, taskId, seatId, model, effort)
    if (!spec) return
    get().openDevPane(projectId, taskId, spec)
    get().setUniverseTab(projectId, 'panes')
    await get().loadTasks(projectId)
  },

  openDevPane: (projectId, taskId, spec) => {
    const panes = get().panesByProject[projectId] ?? []
    if (panes.some((p) => p.id === spec.paneId)) return // já aberto
    // ajudantes podem coexistir na mesma tarefa; fases (dev/review/qa) não.
    if (spec.role !== 'ajudante' && taskId && panes.some((p) => p.taskId === taskId && p.role === spec.role))
      return
    get().addPane(projectId, spec.kind, {
      id: spec.paneId,
      seatId: spec.seatId,
      taskId: taskId || undefined,
      cwd: spec.cwd,
      model: spec.model,
      cliArgs: spec.cliArgs,
      initialPrompt: spec.initialPrompt,
      // persona de subagente do ajudante (delegate.agent) — pane claude
      appendSystemPrompt: spec.appendSystemPrompt,
      logFile: spec.logFile,
      role: spec.role,
      missionId: spec.missionId,
      delegatorPaneId: spec.delegatorPaneId,
      title: spec.title
    })
    // Não troca de aba aqui: este caminho também recebe panes automáticos
    // (revisão, QA e ajudantes), que devem trabalhar sem tirar o usuário do Board.
  },

  // Fase terminou → o main manda fechar o pane daquela fase.
  closeTaskPane: (projectId, taskId, role) => {
    const panes = get().panesByProject[projectId] ?? []
    const pane = panes.find((p) => p.taskId === taskId && p.role === role)
    if (pane) get().closePane(projectId, pane.id)
  },

  taskAttention: {},
  paneAttention: {},
  askQuestions: {},
  loadAskQuestions: async (projectId) => {
    const list = await window.synkora.maestro.pendingQuestions?.(projectId)
    if (!Array.isArray(list)) return
    const map: Record<string, string> = {}
    for (const q of list) map[q.missionKey] = q.question
    set((s) => ({ askQuestions: { ...s.askQuestions, [projectId]: map } }))
  },
  noteUserQuestion: (projectId, missionKey, question) =>
    set((s) => ({
      askQuestions: {
        ...s.askQuestions,
        [projectId]: { ...(s.askQuestions[projectId] ?? {}), [missionKey]: question }
      }
    })),
  clearAskQuestion: (projectId, missionKey) =>
    set((s) => {
      const project = s.askQuestions[projectId]
      if (!project?.[missionKey]) return {}
      const next = { ...project }
      delete next[missionKey]
      return { askQuestions: { ...s.askQuestions, [projectId]: next } }
    }),
  setTaskAttention: (taskId, paneId) =>
    set((s) => ({
      taskAttention: { ...s.taskAttention, [taskId]: true },
      paneAttention: paneId ? { ...s.paneAttention, [paneId]: true } : s.paneAttention
    })),
  clearTaskAttention: (taskId) =>
    set((s) => {
      if (!s.taskAttention[taskId]) return {}
      const next = { ...s.taskAttention }
      delete next[taskId]
      return { taskAttention: next }
    }),
  // Digitar responde à aprovação DAQUELE pane; o card só para de pulsar quando
  // nenhum outro pane da tarefa ainda está esperando (antes, digitar em qualquer
  // irmão apagava o aviso do pane realmente travado).
  clearPaneAttention: (projectId, paneId) =>
    set((s) => {
      const panes = s.panesByProject[projectId] ?? []
      const pane = panes.find((p) => p.id === paneId)
      const paneAttention = { ...s.paneAttention }
      delete paneAttention[paneId]
      if (!pane?.taskId) return { paneAttention }
      const waiting = panes.some(
        (p) => p.id !== paneId && p.taskId === pane.taskId && s.paneAttention[p.id]
      )
      if (waiting) return { paneAttention }
      const taskAttention = { ...s.taskAttention }
      delete taskAttention[pane.taskId]
      return { paneAttention, taskAttention }
    }),

  // Feedback de reprovação: digitado DIRETO no pane vivo do dev; se o pane
  // foi fechado, reabre um novo já com o feedback no prompt.
  applyTaskFeedback: (projectId, taskId, text, spec) => {
    const panes = get().panesByProject[projectId] ?? []
    const pane = panes.find((p) => p.taskId === taskId && (p.role ?? 'dev') === 'dev')
    if (pane) {
      window.synkora.pty.write(pane.id, text.replace(/\s+/g, ' ').trim() + '\r')
    } else {
      get().openDevPane(projectId, taskId, spec)
    }
  },

  handleRunEvent: (taskId, evt) =>
    set((s) => {
      const run =
        s.taskRuns[taskId] ??
        ({ status: 'running', phase: 'dev', events: [], stream: '', perm: null } as TaskRunView)
      return {
        taskRuns: {
          ...s.taskRuns,
          [taskId]: { ...run, events: [...run.events, evt].slice(-400) }
        }
      }
    }),

  handleRunLive: (taskId, evt) =>
    set((s) => {
      const run =
        s.taskRuns[taskId] ??
        ({ status: 'running', phase: 'dev', events: [], stream: '', perm: null } as TaskRunView)
      if (evt.type === 'phase') {
        return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, phase: evt.phase, status: 'running' } } }
      }
      switch (evt.type) {
        case 'delta':
          return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, stream: run.stream + evt.text } } }
        case 'flush':
          return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, stream: '' } } }
        case 'permission': {
          const { type: _t, ...perm } = evt
          return { taskRuns: { ...s.taskRuns, [taskId]: { ...run, perm } } }
        }
        case 'permission-cancel':
          return run.perm?.requestId === evt.requestId
            ? { taskRuns: { ...s.taskRuns, [taskId]: { ...run, perm: null } } }
            : {}
        case 'turn-end':
          return {
            taskRuns: {
              ...s.taskRuns,
              [taskId]: { ...run, stream: '', perm: null, status: evt.status ?? run.status }
            }
          }
        default:
          return {}
      }
    }),

  answerRunPerm: async (taskId, choice) => {
    const perm = get().taskRuns[taskId]?.perm
    if (!perm) return
    set((s) => ({
      taskRuns: { ...s.taskRuns, [taskId]: { ...s.taskRuns[taskId], perm: null } }
    }))
    await window.synkora.tasks.runPermission(taskId, perm.requestId, choice)
  },

  sendToRun: async (taskId, message) => {
    set((s) => ({
      taskRuns: { ...s.taskRuns, [taskId]: { ...s.taskRuns[taskId], status: 'running' } }
    }))
    await window.synkora.tasks.runSend(taskId, message)
  },

  interruptRun: async (taskId) => {
    await window.synkora.tasks.runInterrupt(taskId)
  },

  // ▣ assumir no terminal: mata o headless e abre um TUI REAL na mesma
  // conversa (resume) dentro do worktree da tarefa — / à vontade.
  handoffRun: async (projectId, taskId) => {
    const info = await window.synkora.tasks.runHandoff(taskId)
    if (!info) return
    set((s) => {
      const runs = { ...s.taskRuns }
      delete runs[taskId]
      return { taskRuns: runs }
    })
    get().addPane(projectId, info.kind, {
      seatId: info.seatId,
      taskId,
      cwd: info.cwd,
      cliArgs: info.cliArgs.length ? info.cliArgs : undefined,
      title: `▣ ${info.title.slice(0, 30)}${info.title.length > 30 ? '…' : ''}`
    })
    get().setUniverseTab(projectId, 'panes')
  },

  closeRun: async (taskId) => {
    await window.synkora.tasks.runClose(taskId)
    set((s) => {
      const runs = { ...s.taskRuns }
      delete runs[taskId]
      return { taskRuns: runs }
    })
  },

  sendMaestro: async (projectId, message, seatId) => {
    // Steering: mandar DURANTE um turno não pode apagar o stream em andamento.
    const wasBusy = get().maestroBusy
    set(
      wasBusy
        ? { maestroBusy: true }
        : { maestroBusy: true, maestroStream: '', maestroThinking: true }
    )
    try {
      await window.synkora.maestro.send(projectId, message, seatId)
    } catch (e) {
      get().appendMaestroEvent({
        kind: 'err',
        text: e instanceof Error ? e.message : String(e)
      })
      set({ maestroBusy: false, maestroThinking: false })
    }
  },

  answerMaestroPerm: async (projectId, choice) => {
    const perm = get().maestroPerm
    if (!perm) return
    set({ maestroPerm: null })
    await window.synkora.maestro.permission(projectId, perm.requestId, choice)
  },

  interruptMaestro: async (projectId) => {
    await window.synkora.maestro.interrupt(projectId)
  },

  loadMaestroLog: async (projectId) => {
    const state = await window.synkora.maestro.getState(projectId)
    // Resposta ATRASADA de um projeto que já não é o ativo sobrescrevia o
    // estado global do universo VISÍVEL (troca rápida no rail deixava o board
    // com os dados do outro, de forma permanente).
    if (get().openProjectId !== projectId) return
    set({
      maestroLog: state.log,
      maestroCtx: state.contextTokens,
      maestroCtxLimit: state.contextLimit,
      maestroCtxWindow: state.contextWindow,
      maestroSessionId: state.sessionId,
      maestroModel: state.model,
      maestroEffort: state.effort,
      maestroBypass: state.bypass,
      sensitiveBypassOk: state.sensitiveBypassOk === true,
      maestroSeatId: state.seatId,
      maestroVersion: state.version,
      maestroStateLoaded: true
    })
  },

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
  deleteMission: async (id) => {
    if (!window.synkora.missions?.remove) return
    await window.synkora.missions.remove(id)
    const pid = get().openProjectId
    if (pid) {
      get().setMissionTab(pid, null)
      await get().loadMissions(pid)
      await get().loadTasks(pid)
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

  policies: {},
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

  loadPolicies: async (projectId) => {
    const policies = await window.synkora.policies.get(projectId)
    // Resposta ATRASADA de um projeto que já não é o ativo sobrescrevia o
    // estado global do universo VISÍVEL (troca rápida no rail deixava o board
    // com os dados do outro, de forma permanente).
    if (get().openProjectId !== projectId) return
    set({ policies })
  },

  setPolicy: async (projectId, dept, policy) => {
    await window.synkora.policies.set(projectId, dept, policy)
    set((s) => ({ policies: { ...s.policies, [dept]: policy } }))
  },

  skillsLib: [],
  loadSkills: async () => {
    const skillsLib = await window.synkora.skills.list()
    set({ skillsLib })
  },

  surveyBusyByProject: {},
  surveyMaestro: async (projectId, seatId) => {
    const mark = (on: boolean): void =>
      set((s) => ({ surveyBusyByProject: { ...s.surveyBusyByProject, [projectId]: on } }))
    mark(true)
    try {
      await window.synkora.maestro.survey(projectId, seatId)
    } catch (e) {
      get().appendMaestroEvent({
        kind: 'err',
        text: e instanceof Error ? e.message : String(e)
      })
    } finally {
      mark(false)
    }
  },

  loadProjects: async () => {
    const projects = await window.synkora.projects.list()
    set({ projects })
  },

  createProject: async (name, path) => {
    await window.synkora.projects.create(name, path)
    await get().loadProjects()
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

  // Três leituras de JSON já em memória no main (missions.json, tasks.json,
  // backlog.json). Nunca dispara no laço de render: quem chama é a Home no
  // mount (escalonado) e os canais de mudança.
  loadHomeStats: async (projectId) => {
    const [missions, tasks, versions] = await Promise.all([
      window.synkora.missions.list(projectId),
      window.synkora.tasks.list(projectId),
      window.synkora.backlog.listVersions(projectId)
    ])
    // TODAS as versões abertas contam (pode haver 2/3/6 em dev ao mesmo
    // tempo), da mais antiga para a mais nova; sem nenhuma aberta, a lançada
    // mais recente entra sozinha como referência ("o que ela entregou")
    const abertas = versions
      .filter((v) => v.status === 'aberta')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const lancadas = versions
      .filter((v) => v.status === 'lancada')
      .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))
    const refs = abertas.length ? abertas : lancadas.slice(0, 1)
    // missão VIVA sem carimbo de versão conta na CORRENTE (aberta mais
    // antiga) — é nela que vai integrar (ensureDefaultVersion na integração)
    const correnteId = abertas[0]?.id
    // card de PLANO (F5.7) não é trabalho — fora das contagens
    const work = tasks.filter((t) => t.kind !== 'plan')
    const versoes = refs.map((v) => {
      const daVersao = (m: Mission): boolean =>
        m.versionId === v.id ||
        (!m.versionId &&
          v.id === correnteId &&
          (m.status === 'ativa' || m.status === 'integrando'))
      const ids = new Set(missions.filter(daVersao).map((m) => m.id))
      const scoped = work.filter((t) => t.missionId && ids.has(t.missionId))
      const vivas = missions.filter(
        (m) => daVersao(m) && (m.status === 'ativa' || m.status === 'integrando')
      ).length
      return {
        name: v.name,
        lancada: v.status === 'lancada',
        missoesFeitas: v.deliveries.length,
        missoesTotal: v.deliveries.length + vivas,
        feitas: scoped.filter((t) => t.status === 'done').length,
        total: scoped.length,
        emExec: scoped.filter((t) => t.status === 'execucao' || t.status === 'qa').length
      }
    })
    set((s) => ({
      homeStats: {
        ...s.homeStats,
        [projectId]: {
          missoesAtivas: missions.filter(
            (m) => m.status === 'ativa' || m.status === 'integrando'
          ).length,
          emCurso: work.filter((t) => t.status === 'execucao' || t.status === 'qa').length,
          versoes,
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

  setSettingsSecret: async (name, value) => {
    const next = value
      ? await window.synkora.settings.setSecret(name, value)
      : await window.synkora.settings.clearSecret(name)
    set({ settings: next })
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
  // o estado global por-projeto (tasks/políticas/maestro) para o novo ativo.
  openProject: (id) => {
    set((s) => ({
      openProjectId: id,
      appPage: 'workspace',
      seatGateOpen: false,
      maestroStateLoaded: false,
      // Entrar num projeto SEMPRE pousa no board ✦ geral (pedido do usuário,
      // 2026-07-28) — a última aba/missão visitada não gruda entre visitas.
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
    if (id) {
      void get().loadTasks(id)
      void get().loadPolicies(id)
      void get().loadMaestroLog(id)
      void get().loadTaskRuns(id)
      void get().loadMissions(id)
    }
  },

  universeTabByProject: {},
  setUniverseTab: (projectId, tab) =>
    set((s) => ({ universeTabByProject: { ...s.universeTabByProject, [projectId]: tab } })),

  panesUiByProject: {},
  mapLayoutByProject: {},

  setPanesUi: (projectId, patch) =>
    set((s) => {
      const next = { ...(s.panesUiByProject[projectId] ?? PANES_UI_DEFAULT), ...patch }
      persistJson(PANES_UI_KEY(projectId), next)
      return { panesUiByProject: { ...s.panesUiByProject, [projectId]: next } }
    }),

  setNodeOffset: (projectId, nodeId, off) =>
    set((s) => {
      const cur = s.mapLayoutByProject[projectId] ?? {}
      const next = { ...cur, [nodeId]: off }
      persistJson(MAP_LAYOUT_KEY(projectId), next)
      return { mapLayoutByProject: { ...s.mapLayoutByProject, [projectId]: next } }
    }),

  resetNodeOffsets: (projectId) =>
    set((s) => {
      persistJson(MAP_LAYOUT_KEY(projectId), {})
      return { mapLayoutByProject: { ...s.mapLayoutByProject, [projectId]: {} } }
    }),

  // MESCLA por projeto (nunca substitui o mapa inteiro): universos ficam
  // montados e um `set({...})` cru apagaria o estado dos vizinhos.
  loadPanesUi: (projectId) =>
    set((s) => ({
      panesUiByProject: {
        ...s.panesUiByProject,
        [projectId]: { ...PANES_UI_DEFAULT, ...readJson(PANES_UI_KEY(projectId), PANES_UI_DEFAULT) }
      },
      mapLayoutByProject: {
        ...s.mapLayoutByProject,
        [projectId]: readJson<Record<string, NodeOffset>>(MAP_LAYOUT_KEY(projectId), {})
      }
    })),

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

  loadTasks: async (projectId) => {
    const tasks = await window.synkora.tasks.list(projectId)
    // Resposta ATRASADA de um projeto que já não é o ativo sobrescrevia o
    // estado global do universo VISÍVEL (troca rápida no rail deixava o board
    // com os dados do outro, de forma permanente).
    if (get().openProjectId !== projectId) return
    set({ tasks })
  },

  createTask: async (projectId, department, title, description, missionId) => {
    const created = await window.synkora.tasks.create(projectId, {
      department,
      type: 'feature',
      effort: 'leve',
      title,
      description,
      missionId,
      origin: 'manual'
    })
    await get().loadTasks(projectId)
    return created.length > 0
  },

  updateTask: async (id, patch) => {
    const updated = await window.synkora.tasks.update(id, patch)
    if (updated) set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }))
  },

  removeTask: async (id) => {
    await window.synkora.tasks.remove(id)
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
  },

  approvePlan: async (id, lanes, seenRevision) => {
    const updated = await window.synkora.tasks.approvePlan(id, lanes, seenRevision)
    if (updated && 'staleRevision' in updated) return updated
    if (updated) set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }))
    return undefined
  },

  stopPlan: async (id) => {
    const updated = await window.synkora.tasks.stopPlan(id)
    if (updated) set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }))
  },

  resolvePlanSecurityValidation: async (id, decision, evidence) => {
    const updated = await window.synkora.tasks.resolvePlanSecurityValidation(
      id,
      decision,
      evidence
    )
    if (updated) set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? updated : t)) }))
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

  closePane: (projectId, paneId) =>
    set((s) => {
      const pane = (s.panesByProject[projectId] ?? []).find((p) => p.id === paneId)
      const attention = { ...s.taskAttention }
      const paneAttention = { ...s.paneAttention }
      delete paneAttention[paneId]
      // o card só para de pulsar se NENHUM outro pane da tarefa segue esperando
      if (
        pane?.taskId &&
        !(s.panesByProject[projectId] ?? []).some(
          (p) => p.id !== paneId && p.taskId === pane.taskId && s.paneAttention[p.id]
        )
      ) {
        delete attention[pane.taskId]
      }
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
      const ui = s.panesUiByProject[projectId]
      return {
        taskAttention: attention,
        paneAttention,
        paneStats: stats,
        paneActivity: activity,
        paneEffort: effort,
        paneModel: model,
        paneLastLines: lastLines,
        panesUiByProject: ui
          ? {
              ...s.panesUiByProject,
              [projectId]: {
                ...ui,
                promoted: ui.promoted.filter((id) => id !== paneId),
                expanded: ui.expanded === paneId ? null : ui.expanded,
                canvasByNode: Object.fromEntries(
                  Object.entries(ui.canvasByNode ?? {}).map(([nodeId, layout]) => [
                    nodeId,
                    { ...layout, order: layout.order.filter((id) => id !== paneId) }
                  ])
                )
              }
            }
          : s.panesUiByProject,
        panesByProject: {
          ...s.panesByProject,
          [projectId]: (s.panesByProject[projectId] ?? []).filter((p) => p.id !== paneId)
        }
      }
    })
}))

// Cores das funções: aplica os overrides do usuário nas CSS vars globais no
// boot do renderer (o módulo é importado antes do primeiro paint do React).
applyDeptHueVars(useStore.getState().deptHues)

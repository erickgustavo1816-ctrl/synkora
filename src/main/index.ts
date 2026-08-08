import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { ProjectStore } from './projects'
import { SeatStore, type SeatCli } from './seats'
import {
  interruptActiveSkillUsage,
  isVerifiedTaskPlanPlanningMethod,
  sanitizeRendererTaskPatch,
  TaskStore,
  type NewTask,
  type Task,
  type TaskGateEvidence,
  type TaskPlan,
  type TaskUpdatePatch,
  type PlanLane,
  type PlanVerificationCheckpoint
} from './tasks'
import {
  FREE_AGENT_PERSONA,
  maestroProjectPersona,
  missionPersona,
  parseTasks as parseTasksJson,
  PERSONA_DEV,
  survey,
  SURVEY_PROMPT,
  SURVEY_SECURITY_PROMPT,
  toolLabel,
  type MaestroEvent
} from './maestro'
import { MaestroSession, type PermissionChoice, type SessionEvent } from './maestroSession'
import { CodexSession } from './codexSession'
import { MaestroStore } from './maestroStore'
import {
  alignWorktreeFromSnapshot,
  changedWorktreeFiles,
  changedWorktreeCodeFiles,
  createMissionWorktree,
  createTaskWorktree,
  createVersionWorktree,
  currentBranch,
  ensureSynkoraGitExcludes,
  gitCommitReached,
  gitHead,
  gitHistoryContainsMessage,
  gitLocalBranchExists,
  gitMergeBase,
  gitTree,
  gitVisibleWorktreeFingerprint,
  hasGitCommit,
  initGitRepo,
  isExactCleanPreCasSnapshot,
  isWorktreeClean,
  isExpectedWorktree,
  isExpectedVersionWorktree,
  isExecutableProjectPath,
  mergeTaskWorktree,
  missionMergePrecheck,
  missionWorktreeDescriptor,
  pruneWorktrees,
  removeWorktreeAndBranch,
  resolveMissionWorkspace,
  repairWorktrees,
  snapshotTaskWorktree,
  taskWorktreeDescriptor
} from './worktree'
import { MissionStore, type Mission, type NewMission } from './missions'
import { IntegrationQueueStore, type IntegrationQueueTicketView } from './integrationQueue'
import {
  EXECUTION_MODE_LABEL,
  assessMissionRisk,
  gatesForTask,
  normalizeExecutionMode,
  normalizeRiskLevel,
  retryLimitForExecutionMode,
  type MissionExecutionMode
} from './orchestratorFlow'
import { HelperSpawnReservationRegistry } from './helperSpawnReservations'
import { HelperOpenWatchdog } from './helperOpenWatchdog'
import { ptyPreparationCanContinue } from './ptyPreparationGuard'
import {
  isMethodGovernedPaneRole,
  prepareCodexSkillIsolationProfile,
  removeCodexSkillIsolationProfile
} from './codexSkillIsolation'
import { type GateVerificationEvidence } from './gateVerificationEvidence'
import { buildSkillsBlock } from './phasePrompts'
import type {
  DevPaneSpec,
  LiveGateWait,
  MissionWatch,
  PendingUserQuestion,
  PhaseWatch,
  RunPhase
} from './phaseTypes'
import type { MainContext } from './mainContext'
import { createPhaseEngine, GATE_DEATH_LIMIT, MAX_PARALLEL_RUNS } from './phaseEngine'
import { buildImagesApi } from './mcpApi/images'
import { buildMailboxApi } from './mcpApi/mailbox'
import { buildCodeApi } from './mcpApi/code'
import { buildSkillsApi } from './mcpApi/skills'
import { buildPanesApi } from './mcpApi/panes'
import { buildMissionsApi } from './mcpApi/missions'
import { buildHelpersApi } from './mcpApi/helpers'
import { buildBoardApi } from './mcpApi/board'
import { buildReportApi } from './mcpApi/report'
import { registerFilesIpc } from './ipc/files'
import { registerSettingsIpc } from './ipc/settings'
import { registerServicesIpc } from './ipc/services'
import { registerHarnessIpc } from './ipc/harness'
import { registerProjectPlanIpc } from './ipc/projectPlan'
import { registerVoiceIpc } from './ipc/voice'
import { registerProgressIpc } from './ipc/progress'
import { registerSkillsIpc } from './ipc/skills'
import { registerMiscIpc } from './ipc/misc'
import {
  SECURITY_POLICY_VERSION,
  requiresManualSecurityValidation,
  securityPromptForRole
} from './securityPolicy'
import {
  initialManualSecurityValidation,
  manualSecurityValidationOf,
  manualSecurityValidationPending,
  resolveManualSecurityValidation
} from './manualSecurityValidation'
import {
  persistSecurityReview,
  type SecurityReviewInput,
  type SecurityReviewRecord
} from './securityReview'
import { ensureProjectSecurityBaseline } from './projectSecurityBaseline'
import { redactSensitiveText } from './securityRedaction'
import { BacklogStore, type BacklogItemType, type Version } from './backlog'
import { PolicyStore, type DeptPolicy, type PolicySlot } from './policies'
import { clearCatalogCache, getCatalog } from './catalog'
import { getCliStatus, onCliStatus, updateAllClis, type CliStatus } from './cliUpdate'
import type { Department } from './tasks'
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { StallAttribution, instrumentIpcMain } from './stallAttribution'
import { gitOff } from './gitAsync'
import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { PtyManager, type PaneKind } from './pty'
import { SessionStatsWatcher, type StatsWatchHandle } from './sessionStats'
import { Hub, type HubCommunicationEvent, type PaneIdentity } from './hub'
import {
  SettingsStore,
  type SettingsSecretName,
  type SynkoraSettings,
  type SynkoraSettingsPatch
} from './settings'
import { getSeatUsage } from './seatUsage'
import {
  claudeMcpArgs,
  codexMcpArgs,
  ensurePlaywrightCmd,
  ensurePlaywrightTestCmd,
  resolveBundledPlaywrightMcp,
  resolveProjectPlaywrightTest,
  startMcpServer,
  writeClaudeMcpConfig,
  type DelegateOpts,
  type McpApi,
  type McpServerHandle,
  type McpStdioLaunch,
  type NewMissionInput,
  type SaveProjectPlanInput,
  type NewTaskInput,
  type TaskPatch
} from './mcpServer'
import { selectStaleBundledIds } from './bundledSkillRevision'
import { SkillsLibrary, setGithubToken, type SkillDef } from './skillsLibrary'
import {
  classifyTaskUiWork,
  IMPECCABLE_SKILL_ID,
  SYNKORA_FRONTEND_STANDARD_ID,
  SYNKORA_PLANNING_STANDARD_ID,
  SYNKORA_UI_QA_ID,
  type SkillCapability
} from './skillsRouting'
import {
  SkillRuntime,
  type PaneSkillPlanSnapshot,
  type PlannedSkillInput,
  type PlanningMethodEvidence
} from './skillRuntime'
import { WorkspaceSkillLeaseRegistry } from './workspaceSkills'
import { CURATED_SKILLS } from './skillsCatalog'
import { BUNDLED_AGENTS } from './agentsBundled'
import { BUNDLED_SKILLS } from './skillsBundled'
import { SynVoiceService, type SynVoiceProvider } from './synVoice'
import { WindowsTextInput } from './windowsTextInput'
import {
  WindowsGlobalActivation,
  type GlobalActivationBinding
} from './windowsGlobalActivation'
import { PaneStartupMetrics, type PaneStartupDescriptor } from './paneStartupMetrics'
import {
  codexMcpProtocolArgs,
  getCodexMcpProtocolStatus,
  invalidateCodexMcpProtocol,
  prewarmCodexMcpProtocol
} from './mcpProtocol'
import {
  CodeIntelligenceManager,
  CodeIntelligenceSession,
  CodeIntelligenceError
} from './codeIntelligence'
import { HelperCompletionTracker } from './helperCompletion'
import {
  parseHelperRecoveryTranscript,
  updateHelperRecoveryStatus,
  type HelperRecoveryRecord,
  type HelperRecoveryStatus
} from './helperRecovery'
import {
  completeProjectPlanRelease as completeStoredProjectPlanRelease,
  completeProjectMission as completeStoredProjectMission,
  deferProjectMission as deferStoredProjectMission,
  detachProjectMission as detachStoredProjectMission,
  ensureGreenfieldProjectPlan,
  isEffectivelyEmptyProject,
  legacyProjectPlanApproval,
  loadProjectPlan,
  PROJECT_PLAN_TRUST_CONTRACT_VERSION,
  projectPlanPaths,
  projectPlanReleaseGate,
  projectPlanReleaseBlockers,
  reactivateProjectMission as reactivateStoredProjectMission,
  startProjectMission as bindProjectMission,
  type ProjectPlan
} from './projectPlan'
import {
  applyProgressCoordinatorActivity,
  buildProgressSnapshot,
  type ProgressCoordinatorActivityKind,
  type ProgressCoordinatorActivityInput,
  type ProgressOverlaySnapshot
} from './progressSnapshot'
import {
  PROGRESS_OVERLAY_COMPACT_HEIGHT,
  PROGRESS_OVERLAY_DEFAULT_HEIGHT,
  PROGRESS_OVERLAY_DEFAULT_WIDTH,
  PROGRESS_OVERLAY_EDGE_MARGIN,
  PROGRESS_OVERLAY_MIN_HEIGHT,
  PROGRESS_OVERLAY_MIN_WIDTH,
  progressOverlayExpandedSize,
  progressOverlayMaximumSize
} from './progressOverlayWindow'
import {
  SYNVOICE_OVERLAY_EDGE_MARGIN,
  SYNVOICE_OVERLAY_HEIGHT,
  SYNVOICE_OVERLAY_HISTORY_HEIGHT,
  SYNVOICE_OVERLAY_WIDTH,
  synVoiceOverlayCompactPosition,
  synVoiceOverlayHistoryPlacement,
  synVoiceOverlaySize
} from './synVoiceOverlayWindow'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import {
  compareVerificationEvidence,
  detectVerificationCommands,
  recoverInterruptedVerification,
  runVerificationCommands,
  verificationBudget,
  verificationCommandDefinitionHash,
  type VerificationCommand
} from './missionVerification'
import {
  detectProjectAdapters,
  selectProjectAdapterCommands,
  type ProjectAdapterDetection
} from './projectAdapters'
import {
  codexGateMcpDisableArgs,
  codexGateMcpPolicyArgs,
  paneAccessProfile,
  effectiveSensitiveAccess,
  paneBrowserAvailable,
  paneExternalMcpCapabilities,
  panePermissionArgs,
  type PaneAccessProfile
} from './panePermissions'
import {
  detectRuntimeScript,
  activeQaRuntimes,
  installCommand,
  portInvocation,
  readScriptCommand,
  setQaRuntimeGuard,
  stopAllQaRuntimes,
  stopQaRuntime
} from './qaRuntime'
import { formatPortMap, parsePortFromUrl, type PortUseEntry } from './portMap'
import { PaneMailbox, mailboxKeyOf } from './mailbox'
import {
  PhaseLaunchCapacityGuard,
  PhaseLaunchGuard,
  type PhaseLaunchToken
} from './phaseLaunchGuard'
import {
  prepareTaskAdjustment,
  unapprovedAdjustmentRiskSurfaces
} from './taskAdjustment'
import { Blackbox, describeEntry } from './blackbox'
import { diagnosticsConsentDetail, exportDiagnostics } from './diagnostics'
import {
  findTerminalFileLinks,
  readProjectMarkdown,
  resolveTerminalFile,
  terminalFileOpenKind,
  type TerminalFileRoot
} from './terminalFileLinks'

/** Codex recebe personas como developer instructions persistentes no processo.
 *  Isso mantem o papel correto inclusive depois de /new e em sessoes retomadas. */
function codexDeveloperInstructions(value: string): string {
  const toml = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
  return `developer_instructions="${toml}"`
}

const ptys = new PtyManager()
// Runtime do QA entra no guardião de job objects: crash sujo do app não deixa
// mais a árvore órfã (fix E5×Q4 do mapa de retomada, 2026-08-06).
setQaRuntimeGuard({
  guard: (name, pid) => ptys.guardExternalPid(name, pid),
  unguard: (name) => ptys.unguardExternalPid(name)
})
// Frases vivas dos agentes (tool status_note): paneId → nota curta. Morrem
// com o pane (nota é "agora", não histórico); o consumidor é o radar de
// andamento (pedido do usuário, 2026-08-06: "preciso saber exatamente o que
// está acontecendo sem abrir o Synkora").
const paneStatusNotes = new Map<string, { text: string; at: string }>()
// Ajudantes que já chamaram report(done) — o onExit deles não re-avisa o
// delegador (o aviso de conclusão já foi dado pelo report).
const helperReported = new Set<string>()
// Ajudantes cuja saída o delegador JÁ LEU (helper_output) — morte depois
// disso não gera o aviso "encerrou sem reportar": quem leu está no controle
// (feedback real do usuário: o aviso chegava DEPOIS de tudo incorporado).
const helperSeen = new Set<string>()
// Entrega única da conclusão: helper_output após report consome o resumo e o
// aviso assíncrono deixa de ser injetado como uma segunda mensagem.
const helperCompletions = new HelperCompletionTracker()
const plannedHelperAssignments = new Map<
  string,
  { parentPhaseRun: string; agentId: string }
>()
const completedPlannedAgentsByPhaseRun = new Map<string, Set<string>>()
// Check + spawn de helper atravessa awaits (catálogo, skills, armamento). Esta
// reserva impede duas calls MCP concorrentes de consumirem o mesmo slot.
const helperSpawnReservations = new HelperSpawnReservationRegistry()
const helperOpenWatchdog = new HelperOpenWatchdog()
// Telemetria viva dos panes (tokens/contexto lidos dos JSONL dos CLIs).
const sessionStats = new SessionStatsWatcher()
// sessionId real do CLI por pane (descoberto pelo watcher) — resume/handoff.
const paneSessions = new Map<string, string>()
// Cura interna de --resume inválido: o PTY antigo sai para o mesmo pane
// renascer sem o id. Esse exit técnico não pode desarmar Hub/token/watch.
// Bearer token de cada pane no MCP do Synkora (injetado no env do PTY).
const paneTokens = new Map<string, string>()
// Config MCP escrita por pane (userData/mcp/*.json) — apagada quando o pane
// morre: arquivo sem função não fica (política do usuário).
const paneMcpFiles = new Map<string, string>()
const paneCodexSkillProfiles = new Map<string, string>()
function cleanPaneMcpFile(paneId: string): void {
  const file = paneMcpFiles.get(paneId)
  paneMcpFiles.delete(paneId)
  if (file) try {
    unlinkSync(file)
  } catch {
    // já sumiu
  }
  const profile = paneCodexSkillProfiles.get(paneId)
  paneCodexSkillProfiles.delete(paneId)
  removeCodexSkillIsolationProfile(profile)
}
// Hub de eventos + porta do servidor MCP (inicializados no whenReady).
let hub: Hub
let mcpPort = 0
let mcpServerHandle: McpServerHandle | undefined
let paneStartupMetrics: PaneStartupMetrics | undefined
let codeIntelligence: CodeIntelligenceManager | undefined
let releasePaneSkillLease: (paneId: string) => void = () => undefined
let releasePaneSkillPlan: (paneId: string) => void = () => undefined
const codeIntelligenceSessions = new Map<
  string,
  { cwd: string; session: CodeIntelligenceSession }
>()
let codeIntelligenceTransition: Promise<void> = Promise.resolve()

function createCodeIntelligenceManager(): CodeIntelligenceManager {
  return new CodeIntelligenceManager({
    ...(app.isPackaged ? {} : { appRoot: process.cwd() }),
    appPath: app.getAppPath(),
    maxServers: 8
  })
}

function transitionCodeIntelligence(
  mode: SynkoraSettings['codeIntelligenceMode'],
  restart = false
): Promise<void> {
  const transition = async (): Promise<void> => {
    if (!restart && mode === 'automatic' && codeIntelligence) return
    const previous = codeIntelligence
    codeIntelligence = undefined
    for (const active of codeIntelligenceSessions.values()) active.session.close()
    codeIntelligenceSessions.clear()
    await previous?.close()
    if (mode === 'automatic') codeIntelligence = createCodeIntelligenceManager()
  }
  const result = codeIntelligenceTransition.then(transition, transition)
  codeIntelligenceTransition = result.catch(() => undefined)
  return result
}

function releaseCodeIntelligenceSession(paneId: string): void {
  const active = codeIntelligenceSessions.get(paneId)
  if (!active) return
  codeIntelligenceSessions.delete(paneId)
  active.session.close()
}

function unregisterPane(paneId: string): PaneIdentity | undefined {
  releaseCodeIntelligenceSession(paneId)
  releasePaneSkillLease(paneId)
  releasePaneSkillPlan(paneId)
  plannedHelperAssignments.delete(paneId)
  // nota viva morre com o pane — nota velha em pane novo mentiria no radar
  paneStatusNotes.delete(paneId)
  return hub.unregisterPane(paneId)
}

function codeIntelligenceSession(id: PaneIdentity): CodeIntelligenceSession {
  if (!codeIntelligence) {
    throw new CodeIntelligenceError(
      'SERVER_UNAVAILABLE',
      'code intelligence has not started',
      true
    )
  }
  const current = codeIntelligenceSessions.get(id.paneId)
  if (current?.cwd === id.cwd) return current.session
  current?.session.close()
  const session = codeIntelligence.openWorkspace(id.cwd, id.paneId)
  codeIntelligenceSessions.set(id.paneId, { cwd: id.cwd, session })
  return session
}

let projects: ProjectStore
let seats: SeatStore
let tasks: TaskStore

// Painéis de fundo do Maestro (um processo persistente por projeto:
// claude stream-json ou codex app-server, mesma interface de eventos).
type MaestroBackend = MaestroSession | CodexSession
const maestroSessions = new Map<string, MaestroBackend>()
type ProgressHeadlessActivityKind = Extract<ProgressCoordinatorActivityKind, 'conversation' | 'survey'>
interface ProgressHeadlessActivity {
  token: number
  kind: ProgressHeadlessActivityKind
  startedAt: string
}
const progressHeadlessActivities = new Map<
  string,
  Map<ProgressHeadlessActivityKind, ProgressHeadlessActivity>
>()
const progressMaestroTurnTokens = new WeakMap<MaestroBackend, number>()
let progressHeadlessActivityToken = 0
let abortVoiceRequests: () => void = () => {}
// Janela única: o último WebContents que falou com o Maestro recebe os eventos.
let uiSender: Electron.WebContents | null = null
let mainWindow: BrowserWindow | null = null

// BLINDAGEM DO CANAL DE PUSH (CHECK 17, 2026-08-07): overlays (SynVoice/
// ANDAMENTO) são BrowserWindows próprios — um handler compartilhado fazendo
// `uiSender = e.sender` sob um overlay sequestra TODOS os pushes main→UI
// (paralisia real: panes:open perdido às 17:03Z parou o pipeline por 11min em
// silêncio). Só o webContents da JANELA PRINCIPAL amarra o canal; tentativa
// recusada e troca legítima ficam na caixa-preta.
const refusedUiSenderIds = new Set<number>()
function bindUiSender(sender: Electron.WebContents): void {
  const mainWc = mainWindow?.webContents
  if (mainWc && !mainWc.isDestroyed() && sender.id !== mainWc.id) {
    if (!refusedUiSenderIds.has(sender.id)) {
      refusedUiSenderIds.add(sender.id)
      blackbox.record({
        cat: 'app',
        event: 'ui-sender-rebind-refused',
        actor: 'harness',
        reason: `webContents ${sender.id} (overlay/janela auxiliar) tentou re-amarrar o canal de push — mantido na janela principal (${mainWc.id})`
      })
    }
    return
  }
  if (uiSender && uiSender !== sender && !uiSender.isDestroyed()) {
    blackbox.record({
      cat: 'app',
      event: 'ui-sender-rebound',
      actor: 'harness',
      reason: `canal de push re-amarrado: webContents ${uiSender.id} → ${sender.id}`
    })
  }
  uiSender = sender
}
let synVoiceOverlayWindow: BrowserWindow | null = null
let progressOverlayWindow: BrowserWindow | null = null
let synVoiceOverlayTooltipWindow: BrowserWindow | null = null
let synVoiceOverlayTooltipReady: Promise<void> | null = null
let synVoiceOverlayTooltipGeneration = 0
let synVoiceNoticeWindow: BrowserWindow | null = null
let synVoiceNoticeReady: Promise<void> | null = null
let synVoiceNoticeGeneration = 0
let synVoiceNoticeTimer: NodeJS.Timeout | null = null
let synVoiceOverlayMoveTimer: NodeJS.Timeout | null = null
let synVoiceOverlayBoundsFlush: (() => void) | null = null
let synVoiceOverlayHistoryOpen = false
let synVoiceOverlayHistoryOffsetY = 0
let progressOverlayMoveTimer: NodeJS.Timeout | null = null
let progressOverlayBoundsFlush: (() => void) | null = null
let progressSnapshotTimer: NodeJS.Timeout | null = null
let progressLivePulseTimer: NodeJS.Timeout | null = null
const progressLiveIdleTimers = new Map<string, NodeJS.Timeout>()

const PROGRESS_COORDINATOR_ACTIVE_MS = 4_000

export interface ProgressOverlayPreferences {
  x: number
  y: number
  width?: number
  height?: number
  compact: boolean
  visible: boolean
  historyClearedAt?: string | null
}

let progressOverlayPreferences: ProgressOverlayPreferences | null = null
let progressSnapshotRevision = 0
let mainProgressRendererReady = false
let pendingProgressOpenTarget: { projectId: string; missionId?: string } | null = null
let progressSnapshotSource: ((revision: number) => ProgressOverlaySnapshot) | null = null
let progressCoordinatorActivitySource: (() => ProgressCoordinatorActivityInput[]) | null = null
let latestProgressSnapshot = buildProgressSnapshot({
  projects: [],
  missions: [],
  tasks: [],
  integrationQueue: [],
  revision: 0
})

interface SynVoicePreparedExternalTarget {
  createdAt: number
  promise: Promise<string | null>
  consumed: boolean
}

let synVoicePreparedExternalTarget: SynVoicePreparedExternalTarget | null = null
let synVoicePendingOverlayTarget: Promise<string | null> | null = null
let synVoiceActiveOverlayTargetToken: string | null = null
let synVoiceOverlayCommandInFlight = false

type SynVoiceOverlayStage =
  | 'loading'
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'processing'
  | 'inserted'
export type SynVoiceOverlayCommand = 'toggle' | 'attach' | 'open-settings'
export interface SynVoiceOverlayState {
  stage: SynVoiceOverlayStage
  elapsed: number
  level: number
  bands: number[]
  configured: boolean
  status: string
  activationMode: 'click' | 'toggle' | 'hold'
  activationLabel: string
}

export interface SynVoiceOverlayTooltipRequest {
  text: string
  anchor: { left: number; top: number; width: number; height: number }
}

interface SynVoiceOverlayPreferences {
  x: number
  y: number
  width?: number
  height?: number
}

export type SynVoiceNoticeTone = 'error' | 'warning' | 'info'

const SYNVOICE_WAVE_BAND_COUNT = 13
const SYNVOICE_PREPARED_TARGET_TTL_MS = 30_000
const SYNVOICE_ATOMIC_PASTE_THRESHOLD = 320
const SYNVOICE_TOOLTIP_GAP = 5
const SYNVOICE_POPUP_MARGIN = 8
const synVoiceExternalInput = new WindowsTextInput()
const synVoiceGlobalActivation = new WindowsGlobalActivation()
let latestSynVoiceOverlayState: SynVoiceOverlayState = {
  stage: 'loading',
  elapsed: 0,
  level: 0,
  bands: Array.from({ length: SYNVOICE_WAVE_BAND_COUNT }, () => 0),
  configured: false,
  status: 'SynVoice carregando',
  activationMode: 'click',
  activationLabel: 'botão'
}
let synVoiceDetached = false
let synVoiceOverlayPreferences: Required<SynVoiceOverlayPreferences> | null = null

function discardPreparedSynVoiceTarget(): void {
  const prepared = synVoicePreparedExternalTarget
  synVoicePreparedExternalTarget = null
  if (!prepared || prepared.consumed) return
  void prepared.promise.then((token) => {
    if (token) synVoiceExternalInput.discard(token)
  })
}

function prepareSynVoiceExternalTarget(): void {
  if (
    process.platform !== 'win32' ||
    !synVoiceDetached ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !synVoiceOverlayWindow ||
    synVoiceOverlayWindow.isDestroyed() ||
    synVoiceOverlayWindow.isFocused()
  ) return

  const now = Date.now()
  if (
    synVoicePreparedExternalTarget &&
    now - synVoicePreparedExternalTarget.createdAt < 500
  ) return

  discardPreparedSynVoiceTarget()
  const prepared: SynVoicePreparedExternalTarget = {
    createdAt: now,
    promise: synVoiceExternalInput.capture(mainWindow.webContents.id),
    consumed: false
  }
  synVoicePreparedExternalTarget = prepared
  void prepared.promise.then((token) => {
    if (!token && synVoicePreparedExternalTarget === prepared) {
      synVoicePreparedExternalTarget = null
    }
  })
}

function takePreparedSynVoiceTarget(): Promise<string | null> | null {
  const prepared = synVoicePreparedExternalTarget
  synVoicePreparedExternalTarget = null
  if (!prepared) return null
  if (Date.now() - prepared.createdAt >= SYNVOICE_PREPARED_TARGET_TTL_MS) {
    void prepared.promise.then((token) => {
      if (token) synVoiceExternalInput.discard(token)
    })
    return null
  }
  prepared.consumed = true
  return prepared.promise
}

async function restoreSynVoiceTarget(token: string | null): Promise<void> {
  if (!token || !mainWindow || mainWindow.isDestroyed()) return
  await synVoiceExternalInput.restore(mainWindow.webContents.id, token).catch(() => false)
}

function killMaestroSession(projectId: string): void {
  const s = maestroSessions.get(projectId)
  if (s) {
    maestroSessions.delete(projectId)
    finishProgressMaestroTurn(projectId, s, true)
    s.kill()
  } else {
    endProgressHeadlessActivity(projectId, 'conversation')
  }
}

function beginProgressHeadlessActivity(
  projectId: string,
  kind: ProgressHeadlessActivityKind
): number {
  const token = ++progressHeadlessActivityToken
  const activities = progressHeadlessActivities.get(projectId) ?? new Map()
  activities.set(kind, { token, kind, startedAt: new Date().toISOString() })
  progressHeadlessActivities.set(projectId, activities)
  if (progressCoordinatorActivitySource) refreshProgressLiveSnapshot()
  return token
}

function endProgressHeadlessActivity(
  projectId: string,
  kind: ProgressHeadlessActivityKind,
  token?: number
): void {
  const activities = progressHeadlessActivities.get(projectId)
  const current = activities?.get(kind)
  if (!activities || !current || (token !== undefined && current.token !== token)) return
  activities.delete(kind)
  if (activities.size === 0) progressHeadlessActivities.delete(projectId)
  if (progressCoordinatorActivitySource) refreshProgressLiveSnapshot()
}

function beginProgressMaestroTurn(projectId: string, session: MaestroBackend): void {
  const token = beginProgressHeadlessActivity(projectId, 'conversation')
  progressMaestroTurnTokens.set(session, token)
}

function finishProgressMaestroTurn(
  projectId: string,
  session: MaestroBackend,
  force = false
): void {
  const token = progressMaestroTurnTokens.get(session)
  progressMaestroTurnTokens.delete(session)
  if (token !== undefined) endProgressHeadlessActivity(projectId, 'conversation', token)
  else if (force) endProgressHeadlessActivity(projectId, 'conversation')
}

function currentProgressHeadlessActivity(projectId: string): ProgressHeadlessActivity | undefined {
  const activities = progressHeadlessActivities.get(projectId)
  return activities?.get('survey') ?? activities?.get('conversation')
}

interface PaneRequest {
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
}

// Ícone da janela: a constelação do Synkora, gerada por `scripts/make-icon.mjs`
// (sem dependência de imagem — o .ico é escrito na mão). Mesma convenção de
// caminho do preload/renderer logo abaixo: tudo derivado de `__dirname`, que em
// runtime é `out/main`. Em dev isso sobe dois níveis até a raiz do repo, onde
// mora `build/`; empacotado, o arquivo viaja como extraResource e fica direto
// em `process.resourcesPath`. Devolve undefined se o ícone ainda não foi gerado
// — a janela abre com o ícone padrão do Electron em vez de estourar.
function resolveAppIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.ico'), join(process.resourcesPath, 'build', 'icon.ico')]
    : [join(__dirname, '../../build/icon.ico')]
  return candidates.find((p) => existsSync(p))
}

function trustedRendererUrl(rawUrl: string): boolean {
  try {
    const actual = new URL(rawUrl)
    const queryEntries = [...actual.searchParams.entries()]
    const allowedViews = new Set(['synvoice-overlay', 'progress-overlay'])
    const allowedQuery = queryEntries.length === 0 || (
      queryEntries.length === 1 &&
      queryEntries[0][0] === 'view' &&
      allowedViews.has(queryEntries[0][1])
    )
    if (!allowedQuery) return false
    const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
    if (devUrl) {
      const expected = new URL(devUrl)
      return actual.origin === expected.origin && actual.pathname === expected.pathname
    }
    const expected = new URL(pathToFileURL(join(__dirname, '../renderer/index.html')).href)
    return actual.protocol === 'file:' && actual.pathname.toLowerCase() === expected.pathname.toLowerCase()
  } catch {
    return false
  }
}

function trustedRendererOrigin(rawOrigin: string): boolean {
  try {
    const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
    if (devUrl) return new URL(rawOrigin).origin === new URL(devUrl).origin
    return rawOrigin === 'file://' || rawOrigin === 'null'
  } catch {
    return false
  }
}

function trustedRendererView(
  rawUrl: string,
  view: 'main' | 'synvoice-overlay' | 'progress-overlay'
): boolean {
  if (!trustedRendererUrl(rawUrl)) return false
  try {
    const entries = [...new URL(rawUrl).searchParams.entries()]
    return view === 'main'
      ? entries.length === 0
      : entries.length === 1 && entries[0][0] === 'view' && entries[0][1] === view
  } catch {
    return false
  }
}

function assertTrustedVoiceSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !trustedRendererUrl(frame.url)) {
    throw new Error('Origem não autorizada para o SynVoice.')
  }
}

function assertMainVoiceSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  assertTrustedVoiceSender(event)
  if (
    !event.senderFrame ||
    !trustedRendererView(event.senderFrame.url, 'main') ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents
  ) {
    throw new Error('Janela não autorizada para controlar o SynVoice.')
  }
}

function assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame = event.senderFrame
  if (
    !frame ||
    frame !== event.sender.mainFrame ||
    !trustedRendererView(frame.url, 'main') ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents
  ) {
    throw new Error('Janela não autorizada para controlar serviços locais.')
  }
}

function assertOverlayVoiceSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  assertTrustedVoiceSender(event)
  if (
    !synVoiceOverlayWindow ||
    synVoiceOverlayWindow.isDestroyed() ||
    !event.senderFrame ||
    !trustedRendererView(event.senderFrame.url, 'synvoice-overlay') ||
    event.sender !== synVoiceOverlayWindow.webContents
  ) {
    throw new Error('Mini SynVoice não autorizado.')
  }
}

function assertProgressOverlaySender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame = event.senderFrame
  if (
    !progressOverlayWindow ||
    progressOverlayWindow.isDestroyed() ||
    !frame ||
    frame !== event.sender.mainFrame ||
    !trustedRendererView(frame.url, 'progress-overlay') ||
    event.sender !== progressOverlayWindow.webContents
  ) {
    throw new Error('Janela de andamento não autorizada.')
  }
}

function normalizeSynVoiceOverlayState(value: unknown): SynVoiceOverlayState | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SynVoiceOverlayState>
  const stages = new Set<SynVoiceOverlayStage>([
    'loading', 'idle', 'requesting', 'recording', 'processing', 'inserted'
  ])
  if (!input.stage || !stages.has(input.stage)) return null
  if (typeof input.configured !== 'boolean' || typeof input.status !== 'string') return null
  if (
    input.activationMode !== 'click' &&
    input.activationMode !== 'toggle' &&
    input.activationMode !== 'hold'
  ) return null
  if (typeof input.activationLabel !== 'string') return null
  const elapsed = Number(input.elapsed)
  const level = Number(input.level)
  if (
    !Number.isFinite(elapsed) ||
    !Number.isFinite(level) ||
    !Array.isArray(input.bands) ||
    input.bands.length !== SYNVOICE_WAVE_BAND_COUNT
  ) return null
  const bands = input.bands.map(Number)
  if (!bands.every(Number.isFinite)) return null
  return {
    stage: input.stage,
    elapsed: Math.max(0, Math.min(5 * 60 * 1000, Math.round(elapsed))),
    level: Math.max(0, Math.min(1, level)),
    bands: bands.map((band) => Math.max(0, Math.min(1, band))),
    configured: input.configured,
    status: input.status.slice(0, 180),
    activationMode: input.activationMode,
    activationLabel: input.activationLabel.slice(0, 80)
  }
}

function isNoSpeechTranscript(value: string): boolean {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!normalized) return true
  return new Set([
    'silence', 'silent', 'no speech', 'no speech detected', 'no audio',
    'no audio detected', 'blank audio', 'inaudible', 'silencio', 'sem fala', 'nenhuma fala',
    'nenhuma fala detectada', 'sem audio', 'audio vazio', 'audio inaudivel'
  ]).has(normalized)
}

function safeExternalTranscript(value: string): string {
  try {
    return value
      .normalize('NFC')
      .replace(/[\r\n\t\u2028\u2029]/g, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .slice(0, 20_000)
  } catch {
    return ''
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function deliverProgressOpenTarget(target?: { projectId: string; missionId?: string }): void {
  if (target) pendingProgressOpenTarget = target
  if (
    !pendingProgressOpenTarget ||
    !mainProgressRendererReady ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isLoading()
  ) return
  mainWindow.webContents.send('progress:open-target', pendingProgressOpenTarget)
  pendingProgressOpenTarget = null
}

function setSynVoiceDetached(detached: boolean): void {
  synVoiceDetached = detached
  if (!detached) {
    synVoiceGlobalActivation.stop()
    discardPreparedSynVoiceTarget()
    synVoicePendingOverlayTarget = null
    synVoiceActiveOverlayTargetToken = null
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('voice:overlay-visibility', detached)
  }
}

function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const icon = resolveAppIcon()
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0c0f15',
    title: 'Synkora',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    // Discord-mode: titlebar desenhada pelo renderer (TitleBar.tsx); os controles
    // nativos min/max/fechar viram overlay sobre a barra escura (--panel).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#26241f', symbolColor: '#efe8d6', height: 36 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  mainWindow = win
  const mainWebContentsId = win.webContents.id

  // O renderer só pede áudio. Autorizar `media` sem conferir o tipo também
  // liberaria câmera para qualquer código futuro carregado na janela. A origem
  // é o renderer local do app (file:// empacotado ou a URL do Vite em dev).
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (
      webContents?.id !== win.webContents.id ||
      !details.isMainFrame ||
      !trustedRendererView(details.requestingUrl ?? webContents.getURL(), 'main')
    ) return false
    if (permission === 'clipboard-sanitized-write') return true
    return permission === 'media' &&
      details.mediaType === 'audio' &&
      trustedRendererOrigin(details.securityOrigin ?? requestingOrigin)
  })
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (
      webContents.id !== win.webContents.id ||
      !details.isMainFrame ||
      !trustedRendererView(details.requestingUrl ?? webContents.getURL(), 'main')
    ) {
      callback(false)
      return
    }
    if (permission === 'clipboard-sanitized-write') {
      callback(true)
      return
    }
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    const securityOrigin = 'securityOrigin' in details ? details.securityOrigin : undefined
    callback(
      permission === 'media' &&
        Boolean(securityOrigin && trustedRendererOrigin(securityOrigin)) &&
        mediaTypes?.length === 1 &&
        mediaTypes[0] === 'audio'
    )
  })

  // Conteúdo remoto nunca ocupa a janela privilegiada do app. Links HTTPS
  // abrem no navegador do sistema; pop-ups são sempre negados.
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (trustedRendererView(url, 'main')) return
    event.preventDefault()
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    abortVoiceRequests()
    synVoiceExternalInput.discardOwner(mainWebContentsId)
    synVoiceGlobalActivation.stop()
    hideSynVoiceOverlayTooltip()
    hideSynVoiceNotice()
    synVoiceOverlayBoundsFlush?.()
    if (synVoiceOverlayMoveTimer) {
      clearTimeout(synVoiceOverlayMoveTimer)
      synVoiceOverlayMoveTimer = null
    }
    if (progressOverlayMoveTimer) {
      progressOverlayBoundsFlush?.()
      clearTimeout(progressOverlayMoveTimer)
      progressOverlayMoveTimer = null
    }
    if (synVoiceOverlayWindow && !synVoiceOverlayWindow.isDestroyed()) {
      synVoiceOverlayWindow.destroy()
    }
    if (progressOverlayWindow && !progressOverlayWindow.isDestroyed()) {
      progressOverlayWindow.destroy()
    }
    if (synVoiceOverlayTooltipWindow && !synVoiceOverlayTooltipWindow.isDestroyed()) {
      synVoiceOverlayTooltipWindow.destroy()
    }
    if (synVoiceNoticeWindow && !synVoiceNoticeWindow.isDestroyed()) {
      synVoiceNoticeWindow.destroy()
    }
    synVoiceOverlayWindow = null
    progressOverlayWindow = null
    synVoiceOverlayTooltipWindow = null
    synVoiceOverlayTooltipReady = null
    synVoiceNoticeWindow = null
    synVoiceNoticeReady = null
    synVoiceDetached = false
    mainProgressRendererReady = false
    if (mainWindow === win) mainWindow = null
    if (uiSender?.id === mainWebContentsId) uiSender = null
  })
  // O ALVO DOS PUSHES É A JANELA, não "o último IPC que alguém chamou".
  // `uiSender` era preenchido só de carona (`uiSender = e.sender` espalhado nos
  // handlers), então nada que o main empurrasse ANTES do primeiro IPC "de
  // carona" chegava ao renderer: a rodada de update dos CLIs roda 2,5s após o
  // boot e todos os `cli:status` iam para o chão — o dropdown ficava em
  // "checando…" para sempre (bug real). `hub:event` tinha a mesma exposição.
  // Amarrar no did-finish-load mata a classe inteira do problema, e vale também
  // no reload do render-process-gone logo abaixo.
  win.webContents.on('did-start-loading', () => {
    mainProgressRendererReady = false
  })
  win.webContents.on('did-finish-load', () => {
    uiSender = win.webContents
    win.webContents.send('voice:overlay-visibility', synVoiceDetached)
    refreshProgressSnapshot()
  })
  // renderer caiu (GPU/OOM)? loga e RECARREGA em vez de deixar a janela morrer
  win.webContents.on('render-process-gone', (_e, details) => {
    mainProgressRendererReady = false
    logCrash('renderer-gone', `${details.reason} (exitCode ${details.exitCode})`)
    abortVoiceRequests()
    synVoiceExternalInput.discardOwner(mainWebContentsId)
    synVoiceGlobalActivation.stop()
    if (details.reason !== 'clean-exit') win.webContents.reload()
  })

  const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devUrl) {
    if (!trustedRendererView(devUrl, 'main')) throw new Error('URL de desenvolvimento do renderer não autorizada.')
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function safeSynVoicePopupText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  try {
    return value
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
      .trim()
      .slice(0, maxLength)
  } catch {
    return ''
  }
}

function normalizeSynVoiceTooltipRequest(value: unknown): SynVoiceOverlayTooltipRequest | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SynVoiceOverlayTooltipRequest>
  const text = safeSynVoicePopupText(input.text, 180)
  if (!text || !input.anchor || typeof input.anchor !== 'object') return null
  const raw = input.anchor as Partial<SynVoiceOverlayTooltipRequest['anchor']>
  const left = Number(raw.left)
  const top = Number(raw.top)
  const width = Number(raw.width)
  const height = Number(raw.height)
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const overlayBounds = synVoiceOverlayWindow && !synVoiceOverlayWindow.isDestroyed()
    ? synVoiceOverlayWindow.getContentBounds()
    : {
        width: SYNVOICE_OVERLAY_WIDTH,
        height: SYNVOICE_OVERLAY_HEIGHT
      }
  const overlayWidth = Math.max(1, overlayBounds.width)
  const overlayHeight = Math.max(1, overlayBounds.height)
  const x = Math.max(0, Math.min(overlayWidth - 1, left))
  const y = Math.max(0, Math.min(overlayHeight - 1, top))
  return {
    text,
    anchor: {
      left: x,
      top: y,
      width: Math.max(1, Math.min(overlayWidth - x, width)),
      height: Math.max(1, Math.min(overlayHeight - y, height))
    }
  }
}

const SYNVOICE_TOOLTIP_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden;color-scheme:dark}
body{padding:6px 7px 8px}
#popup{position:relative;display:inline-block;max-width:240px;padding:6px 10px;background:rgba(38,36,31,.99);color:#efe8d8;border:1px solid #504a3e;border-radius:7px;box-shadow:0 5px 15px rgba(20,16,10,.42);font:11px/1.4 Consolas,"Courier New",monospace;white-space:pre-line;overflow-wrap:anywhere}
#popup:before{content:"";position:absolute;left:var(--tip-arrow-x,50%);top:-5px;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);background:#26241f;border-left:1px solid #504a3e;border-top:1px solid #504a3e}
#popup[data-place="top"]:before{top:auto;bottom:-5px;border-left:0;border-top:0;border-right:1px solid #504a3e;border-bottom:1px solid #504a3e}
</style></head><body><div id="popup" role="tooltip"></div></body></html>`

const SYNVOICE_NOTICE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden;color-scheme:dark}
body{padding:7px 8px 9px}
#popup{display:flex;align-items:flex-start;gap:9px;min-width:220px;max-width:340px;padding:10px 12px;background:rgba(38,36,31,.99);color:#efe8d8;border:1px solid #5b5142;border-left:3px solid #d96c3f;border-radius:9px;box-shadow:0 7px 22px rgba(20,16,10,.46);font:11px/1.45 Consolas,"Courier New",monospace;white-space:normal;overflow-wrap:anywhere}
#mark{display:grid;place-items:center;width:18px;height:18px;flex:none;border-radius:50%;background:rgba(217,108,63,.16);color:#f19a74;font-weight:700;line-height:1}
#copy{min-width:0}#copy strong{display:block;margin-bottom:2px;color:#f4ecdb;font-size:10px;letter-spacing:.05em;text-transform:uppercase}#text{color:#c8bfae}
#popup[data-tone="warning"]{border-left-color:#d7a84f}#popup[data-tone="warning"] #mark{background:rgba(215,168,79,.16);color:#efca79}
#popup[data-tone="info"]{border-left-color:#7295b8}#popup[data-tone="info"] #mark{background:rgba(114,149,184,.16);color:#a7c4df}
</style></head><body><div id="popup"><span id="mark">!</span><span id="copy"><strong>SynVoice</strong><span id="text"></span></span></div></body></html>`

function configurePassiveSynVoiceWindow(win: BrowserWindow): void {
  // Nunca recebe foco nem intercepta cliques no aplicativo que está por baixo.
  win.hide()
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
}

function createSynVoiceTooltipWindow(): BrowserWindow | null {
  const overlay = synVoiceOverlayWindow
  if (!overlay || overlay.isDestroyed()) return null
  if (synVoiceOverlayTooltipWindow && !synVoiceOverlayTooltipWindow.isDestroyed()) {
    return synVoiceOverlayTooltipWindow
  }
  const win = new BrowserWindow({
    parent: overlay,
    width: 260,
    height: 64,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'SynVoice Tooltip',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      backgroundThrottling: false
    }
  })
  synVoiceOverlayTooltipWindow = win
  configurePassiveSynVoiceWindow(win)
  synVoiceOverlayTooltipReady = win.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(SYNVOICE_TOOLTIP_HTML)}`
  )
  win.on('closed', () => {
    if (synVoiceOverlayTooltipWindow === win) synVoiceOverlayTooltipWindow = null
    synVoiceOverlayTooltipReady = null
  })
  return win
}

function hideSynVoiceOverlayTooltip(): void {
  synVoiceOverlayTooltipGeneration++
  if (synVoiceOverlayTooltipWindow && !synVoiceOverlayTooltipWindow.isDestroyed()) {
    synVoiceOverlayTooltipWindow.hide()
  }
}

async function showSynVoiceOverlayTooltip(request: SynVoiceOverlayTooltipRequest): Promise<void> {
  const overlay = synVoiceOverlayWindow
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return
  const generation = ++synVoiceOverlayTooltipGeneration
  const win = createSynVoiceTooltipWindow()
  if (!win) return
  win.hide()
  try {
    await synVoiceOverlayTooltipReady
    if (
      generation !== synVoiceOverlayTooltipGeneration ||
      win.isDestroyed() ||
      overlay.isDestroyed() ||
      !overlay.isVisible()
    ) return
    const size = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('popup')
      if (!el) return null
      el.textContent = ${JSON.stringify(request.text)}
      return { width: Math.ceil(el.offsetWidth + 14), height: Math.ceil(el.offsetHeight + 14) }
    })()`, true) as { width?: unknown; height?: unknown } | null
    if (generation !== synVoiceOverlayTooltipGeneration || !size) return
    const width = Math.max(44, Math.min(254, Math.round(Number(size.width))))
    const height = Math.max(30, Math.min(92, Math.round(Number(size.height))))
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    const contentBounds = overlay.getContentBounds()
    const anchorCenterX = contentBounds.x + request.anchor.left + request.anchor.width / 2
    const anchorTopY = contentBounds.y + request.anchor.top
    const anchorBottomY = anchorTopY + request.anchor.height
    const display = screen.getDisplayNearestPoint({
      x: Math.round(anchorCenterX),
      y: Math.round(anchorBottomY)
    })
    const area = display.workArea
    const desiredX = Math.round(anchorCenterX - width / 2)
    const x = Math.max(
      area.x + SYNVOICE_POPUP_MARGIN,
      Math.min(desiredX, area.x + area.width - width - SYNVOICE_POPUP_MARGIN)
    )
    const minY = area.y + SYNVOICE_POPUP_MARGIN
    const maxY = area.y + area.height - height - SYNVOICE_POPUP_MARGIN
    const belowY = Math.round(anchorBottomY + SYNVOICE_TOOLTIP_GAP)
    const aboveY = Math.round(anchorTopY - height - SYNVOICE_TOOLTIP_GAP)
    const place = belowY <= maxY || aboveY < minY ? 'bottom' : 'top'
    const y = place === 'bottom'
      ? Math.max(minY, Math.min(belowY, maxY))
      : Math.max(minY, Math.min(aboveY, maxY))
    const popupWidth = Math.max(1, width - 14)
    const arrowX = Math.round(
      Math.max(10, Math.min(anchorCenterX - x - 7, popupWidth - 10))
    )
    if (generation !== synVoiceOverlayTooltipGeneration) return
    await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('popup')
      if (el) {
        el.dataset.place = ${JSON.stringify(place)}
        el.style.setProperty('--tip-arrow-x', ${JSON.stringify(`${arrowX}px`)})
      }
    })()`, true)
    if (generation !== synVoiceOverlayTooltipGeneration) return
    win.setBounds({ x, y, width, height }, false)
    win.showInactive()
    win.moveTop()
  } catch {
    if (generation === synVoiceOverlayTooltipGeneration) hideSynVoiceOverlayTooltip()
  }
}

function createSynVoiceNoticeWindow(): BrowserWindow {
  if (synVoiceNoticeWindow && !synVoiceNoticeWindow.isDestroyed()) return synVoiceNoticeWindow
  const win = new BrowserWindow({
    width: 356,
    height: 110,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'SynVoice Aviso',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      backgroundThrottling: false
    }
  })
  synVoiceNoticeWindow = win
  configurePassiveSynVoiceWindow(win)
  synVoiceNoticeReady = win.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(SYNVOICE_NOTICE_HTML)}`
  )
  win.on('closed', () => {
    if (synVoiceNoticeWindow === win) synVoiceNoticeWindow = null
    synVoiceNoticeReady = null
  })
  return win
}

function hideSynVoiceNotice(): void {
  synVoiceNoticeGeneration++
  if (synVoiceNoticeTimer) {
    clearTimeout(synVoiceNoticeTimer)
    synVoiceNoticeTimer = null
  }
  if (synVoiceNoticeWindow && !synVoiceNoticeWindow.isDestroyed()) synVoiceNoticeWindow.hide()
}

async function showSynVoiceNotice(message: string, tone: SynVoiceNoticeTone): Promise<void> {
  const generation = ++synVoiceNoticeGeneration
  if (synVoiceNoticeTimer) {
    clearTimeout(synVoiceNoticeTimer)
    synVoiceNoticeTimer = null
  }
  const win = createSynVoiceNoticeWindow()
  win.hide()
  try {
    await synVoiceNoticeReady
    if (generation !== synVoiceNoticeGeneration || win.isDestroyed()) return
    const size = await win.webContents.executeJavaScript(`(() => {
      const popup = document.getElementById('popup')
      const text = document.getElementById('text')
      const mark = document.getElementById('mark')
      if (!popup || !text || !mark) return null
      popup.dataset.tone = ${JSON.stringify(tone)}
      mark.textContent = ${JSON.stringify(tone === 'info' ? 'i' : '!')}
      text.textContent = ${JSON.stringify(message)}
      return { width: Math.ceil(popup.offsetWidth + 16), height: Math.ceil(popup.offsetHeight + 16) }
    })()`, true) as { width?: unknown; height?: unknown } | null
    if (generation !== synVoiceNoticeGeneration || !size) return
    const width = Math.max(236, Math.min(356, Math.round(Number(size.width))))
    const height = Math.max(58, Math.min(150, Math.round(Number(size.height))))
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    const target = synVoiceDetached && synVoiceOverlayWindow && !synVoiceOverlayWindow.isDestroyed()
      ? synVoiceOverlayWindow
      : mainWindow
    const targetBounds = target && !target.isDestroyed()
      ? target.getBounds()
      : screen.getPrimaryDisplay().workArea
    const display = screen.getDisplayMatching(targetBounds)
    const area = display.workArea
    const x = area.x + area.width - width - 16
    let y = area.y + area.height - height - 16
    if (synVoiceDetached && synVoiceOverlayWindow && !synVoiceOverlayWindow.isDestroyed()) {
      const overlayBounds = synVoiceOverlayWindow.getBounds()
      const overlapsOverlay =
        x < overlayBounds.x + overlayBounds.width &&
        x + width > overlayBounds.x &&
        y < overlayBounds.y + overlayBounds.height &&
        y + height > overlayBounds.y
      if (overlapsOverlay) y = Math.max(area.y + 8, overlayBounds.y - height - 10)
    }
    if (generation !== synVoiceNoticeGeneration) return
    win.setBounds({ x, y, width, height }, false)
    win.showInactive()
    win.moveTop()
    synVoiceNoticeTimer = setTimeout(() => {
      if (generation === synVoiceNoticeGeneration) hideSynVoiceNotice()
    }, 4500)
  } catch {
    if (generation === synVoiceNoticeGeneration) hideSynVoiceNotice()
  }
}

function synVoiceOverlayPreferencesFile(): string {
  return join(app.getPath('userData'), 'synvoice-overlay-position.json')
}

function synVoiceOverlayDisplayNear(
  x: number,
  y: number,
  width = SYNVOICE_OVERLAY_WIDTH,
  height = SYNVOICE_OVERLAY_HEIGHT
): Electron.Display {
  const primary = screen.getPrimaryDisplay()
  if (!Number.isFinite(x) || !Number.isFinite(y)) return primary
  return screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2)
  })
}

/** Uma janela salva ainda é alcançável? (interseção mínima com algum monitor
 *  — o clamp só REPOSICIONA quando o retângulo ficou realmente fora de tela;
 *  clampar sempre destruía a posição salva quando o layout de monitores é
 *  lido cedo/errado no boot e "teleportava" o overlay — caso real 2026-08-03) */
function overlayRectReachable(x: number, y: number, width: number, height: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x)
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y)
    if (overlapX >= 60 && overlapY >= 24) return true
  }
  return false
}

function clampSynVoiceOverlayPosition(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  const primary = screen.getPrimaryDisplay().workArea
  const fallback = {
    x: primary.x + primary.width - width - SYNVOICE_OVERLAY_EDGE_MARGIN,
    y: primary.y + 58
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback
  // posição salva alcançável = intocada (onde o usuário deixou fica gravado)
  if (overlayRectReachable(x, y, width, height)) {
    return { x: Math.round(x), y: Math.round(y) }
  }
  const display = synVoiceOverlayDisplayNear(x, y, width, height)
  const area = display.workArea
  return {
    x: Math.min(
      Math.max(area.x, area.x + area.width - width),
      Math.max(area.x, Math.round(x))
    ),
    y: Math.min(
      Math.max(area.y, area.y + area.height - height),
      Math.max(area.y, Math.round(y))
    )
  }
}

function loadSynVoiceOverlayPreferences(): Required<SynVoiceOverlayPreferences> {
  if (synVoiceOverlayPreferences) return synVoiceOverlayPreferences
  const value = loadJsonStore(
    synVoiceOverlayPreferencesFile(),
    (): SynVoiceOverlayPreferences => ({
      x: Number.NaN,
      y: Number.NaN,
      width: SYNVOICE_OVERLAY_WIDTH,
      height: SYNVOICE_OVERLAY_HEIGHT
    }),
    (candidate): candidate is SynVoiceOverlayPreferences => {
      if (!candidate || typeof candidate !== 'object') return false
      const input = candidate as Partial<SynVoiceOverlayPreferences>
      return (
        typeof input.x === 'number' &&
        Number.isFinite(input.x) &&
        typeof input.y === 'number' &&
        Number.isFinite(input.y) &&
        (input.width === undefined || (
          typeof input.width === 'number' && Number.isFinite(input.width)
        )) &&
        (input.height === undefined || (
          typeof input.height === 'number' && Number.isFinite(input.height)
        ))
      )
    }
  )
  // Tamanho é FIXO (tamanhos salvos por versões antigas são ignorados) e o
  // LOAD nunca regrava o store: regravar aqui destruía a posição boa do disco
  // quando o clamp de boot decidia errado (caso real 2026-08-03).
  const size = synVoiceOverlaySize()
  const position = clampSynVoiceOverlayPosition(value.x, value.y, size.width, size.height)
  synVoiceOverlayPreferences = { ...position, ...size }
  return synVoiceOverlayPreferences
}

function persistSynVoiceOverlayPreferences(): void {
  if (!synVoiceOverlayPreferences) return
  try {
    persistJsonStore(synVoiceOverlayPreferencesFile(), synVoiceOverlayPreferences)
  } catch {
    // Bounds são conveniência; nunca impedem o SynVoice de abrir.
  }
}

function saveSynVoiceOverlayBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getBounds()
  const size = synVoiceOverlaySize()
  const compactPosition = synVoiceOverlayHistoryOpen
    ? synVoiceOverlayCompactPosition(bounds.x, bounds.y, synVoiceOverlayHistoryOffsetY)
    : { x: bounds.x, y: bounds.y }
  const position = clampSynVoiceOverlayPosition(
    compactPosition.x,
    compactPosition.y,
    size.width,
    size.height
  )
  synVoiceOverlayPreferences = { ...position, ...size }
  persistSynVoiceOverlayPreferences()
}

function setSynVoiceOverlayHistoryOpen(expanded: boolean): void {
  const win = synVoiceOverlayWindow
  if (!win || win.isDestroyed()) {
    if (!expanded) {
      synVoiceOverlayHistoryOpen = false
      synVoiceOverlayHistoryOffsetY = 0
    }
    return
  }
  const bounds = win.getBounds()
  const size = synVoiceOverlaySize()
  if (expanded) {
    if (synVoiceOverlayHistoryOpen) return
    const area = screen.getDisplayMatching(bounds).workArea
    const placement = synVoiceOverlayHistoryPlacement(bounds.x, bounds.y, area)
    synVoiceOverlayHistoryOpen = true
    synVoiceOverlayHistoryOffsetY = placement.offsetY
    win.setBounds({
      x: placement.x,
      y: placement.y,
      width: size.width,
      height: SYNVOICE_OVERLAY_HISTORY_HEIGHT
    })
    return
  }

  const compactPosition = synVoiceOverlayHistoryOpen
    ? synVoiceOverlayCompactPosition(bounds.x, bounds.y, synVoiceOverlayHistoryOffsetY)
    : { x: bounds.x, y: bounds.y }
  const position = clampSynVoiceOverlayPosition(
    compactPosition.x,
    compactPosition.y,
    size.width,
    size.height
  )
  const needsResize = synVoiceOverlayHistoryOpen || bounds.height !== size.height
  synVoiceOverlayHistoryOpen = false
  synVoiceOverlayHistoryOffsetY = 0
  if (needsResize) win.setBounds({ ...position, ...size })
}

function createSynVoiceOverlay(): BrowserWindow {
  if (synVoiceOverlayWindow && !synVoiceOverlayWindow.isDestroyed()) {
    return synVoiceOverlayWindow
  }
  const preferences = loadSynVoiceOverlayPreferences()
  const win = new BrowserWindow({
    ...preferences,
    // TRANSPARENTE + sem thickFrame (decisão do usuário, 2026-08-03): a
    // "borda escura" era o backgroundColor da janela vazando em volta do
    // cartão CSS (anel da margem + cunhas de canto entre o raio CSS 13px e o
    // raio nativo ~8px) somado à moldura de resize nativa. Só o cartão pinta.
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    thickFrame: false,
    // TAMANHO FIXO: o destaque do microfone não se redimensiona (decisão do
    // usuário, 2026-08-03) — e janela transparente não teria resize nativo.
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // `focusable:false` vira WS_EX_NOACTIVATE no Windows. Quando outro app está
    // em primeiro plano, Chromium responde WM_MOUSEACTIVATE com
    // MA_NOACTIVATEANDEAT e o próprio Windows descarta clique e arraste. A mini
    // é mostrada inativa, mas precisa ser focável para continuar interativa.
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Mini SynVoice',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: ['--synvoice-overlay']
    }
  })
  synVoiceOverlayWindow = win
  synVoiceOverlayHistoryOpen = false
  synVoiceOverlayHistoryOffsetY = 0
  // DPI MISTO (provado em sonda 2026-08-03: primário 125%, secundário 100%):
  // criar a janela já com x/y de outro monitor aplica a escala errada e ela
  // "nasce em lugar aleatório" após reiniciar o app. Reaplicar os bounds
  // DEPOIS de criada usa a escala do monitor certo — é o fix conhecido.
  win.setBounds({
    x: preferences.x,
    y: preferences.y,
    width: preferences.width,
    height: preferences.height
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'win32') {
    // Fim do arraste nativo: devolve o foco ao aplicativo que estava ativo
    // antes de o usuário tocar na mini.
    win.hookWindowMessage(0x0232, () => {
      const activeToken = synVoiceActiveOverlayTargetToken
      if (activeToken) {
        void restoreSynVoiceTarget(activeToken)
        return
      }
      const prepared = synVoicePreparedExternalTarget
      if (!prepared || prepared.consumed) return
      void prepared.promise.then((token) => restoreSynVoiceTarget(token))
    })
  }

  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (trustedRendererView(url, 'synvoice-overlay')) return
    event.preventDefault()
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const persistBounds = (): void => saveSynVoiceOverlayBounds(win)
  synVoiceOverlayBoundsFlush = persistBounds
  const scheduleBoundsPersist = (): void => {
    if (synVoiceOverlayMoveTimer) clearTimeout(synVoiceOverlayMoveTimer)
    synVoiceOverlayMoveTimer = setTimeout(() => {
      synVoiceOverlayMoveTimer = null
      persistBounds()
    }, 160)
  }
  win.on('move', () => {
    hideSynVoiceOverlayTooltip()
    scheduleBoundsPersist()
  })
  win.on('hide', () => {
    hideSynVoiceOverlayTooltip()
    setSynVoiceOverlayHistoryOpen(false)
    if (synVoiceOverlayMoveTimer) {
      clearTimeout(synVoiceOverlayMoveTimer)
      synVoiceOverlayMoveTimer = null
    }
    persistBounds()
  })
  win.on('close', () => {
    if (synVoiceOverlayMoveTimer) {
      clearTimeout(synVoiceOverlayMoveTimer)
      synVoiceOverlayMoveTimer = null
    }
    persistBounds()
  })
  win.on('closed', () => {
    discardPreparedSynVoiceTarget()
    hideSynVoiceOverlayTooltip()
    if (synVoiceOverlayTooltipWindow && !synVoiceOverlayTooltipWindow.isDestroyed()) {
      synVoiceOverlayTooltipWindow.destroy()
    }
    synVoiceOverlayTooltipWindow = null
    synVoiceOverlayTooltipReady = null
    if (synVoiceOverlayMoveTimer) {
      clearTimeout(synVoiceOverlayMoveTimer)
      synVoiceOverlayMoveTimer = null
    }
    if (synVoiceOverlayBoundsFlush === persistBounds) synVoiceOverlayBoundsFlush = null
    if (synVoiceOverlayWindow === win) synVoiceOverlayWindow = null
    synVoiceOverlayHistoryOpen = false
    synVoiceOverlayHistoryOffsetY = 0
    setSynVoiceDetached(false)
  })
  win.webContents.on('did-finish-load', () => {
    // React renasce com o histórico fechado após HMR/reload/crash; o main
    // restaura a geometria compacta para não deixar uma janela vazia de 264px.
    setSynVoiceOverlayHistoryOpen(false)
    win.webContents.send('voice:overlay-state-changed', latestSynVoiceOverlayState)
    if (synVoiceDetached) win.showInactive()
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    hideSynVoiceOverlayTooltip()
    logCrash('synvoice-overlay-gone', `${details.reason} (exitCode ${details.exitCode})`)
    if (details.reason !== 'clean-exit') win.webContents.reload()
  })

  const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devUrl) {
    const overlayUrl = new URL(devUrl)
    overlayUrl.searchParams.set('view', 'synvoice-overlay')
    if (!trustedRendererView(overlayUrl.href, 'synvoice-overlay')) {
      throw new Error('URL de desenvolvimento da mini SynVoice não autorizada.')
    }
    void win.loadURL(overlayUrl.href)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'synvoice-overlay' }
    })
  }
  return win
}

function toggleSynVoiceOverlay(): void {
  if (synVoiceOverlayWindow && !synVoiceOverlayWindow.isDestroyed() && synVoiceOverlayWindow.isVisible()) {
    synVoiceOverlayWindow.hide()
    setSynVoiceDetached(false)
    return
  }
  const win = createSynVoiceOverlay()
  setSynVoiceDetached(true)
  if (!win.webContents.isLoading()) {
    win.webContents.send('voice:overlay-state-changed', latestSynVoiceOverlayState)
    win.showInactive()
  }
  win.setAlwaysOnTop(true, 'floating')
}

function progressOverlayPreferencesFile(): string {
  return join(app.getPath('userData'), 'progress-overlay.json')
}

function progressOverlayDisplayNear(
  x: number,
  y: number,
  width = PROGRESS_OVERLAY_DEFAULT_WIDTH,
  height = PROGRESS_OVERLAY_COMPACT_HEIGHT
): Electron.Display {
  const primary = screen.getPrimaryDisplay()
  if (!Number.isFinite(x) || !Number.isFinite(y)) return primary
  return screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2)
  })
}

function progressOverlaySizeNear(
  x: number,
  y: number,
  width: number | undefined,
  height: number | undefined,
  compact: boolean
): { width: number; height: number } {
  const display = progressOverlayDisplayNear(
    x,
    y,
    width ?? PROGRESS_OVERLAY_DEFAULT_WIDTH,
    height ?? PROGRESS_OVERLAY_DEFAULT_HEIGHT
  )
  const expanded = progressOverlayExpandedSize(
    width,
    height,
    display.workArea.width,
    display.workArea.height
  )
  return {
    width: expanded.width,
    height: compact ? PROGRESS_OVERLAY_COMPACT_HEIGHT : expanded.height
  }
}

function clampProgressOverlayPosition(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  const primary = screen.getPrimaryDisplay().workArea
  const fallback = {
    x: primary.x + primary.width - width - PROGRESS_OVERLAY_EDGE_MARGIN,
    y: primary.y + primary.height - height - PROGRESS_OVERLAY_EDGE_MARGIN
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback
  // posição salva alcançável = intocada (mesma regra do overlay do SynVoice)
  if (overlayRectReachable(x, y, width, height)) {
    return { x: Math.round(x), y: Math.round(y) }
  }
  const display = progressOverlayDisplayNear(x, y, width, height)
  const area = display.workArea
  return {
    x: Math.min(
      Math.max(area.x, area.x + area.width - width),
      Math.max(area.x, Math.round(x))
    ),
    y: Math.min(
      Math.max(area.y, area.y + area.height - height),
      Math.max(area.y, Math.round(y))
    )
  }
}

function loadProgressOverlayPreferences(): ProgressOverlayPreferences {
  if (progressOverlayPreferences) return progressOverlayPreferences
  const value = loadJsonStore(
    progressOverlayPreferencesFile(),
    (): ProgressOverlayPreferences => ({
      x: Number.NaN,
      y: Number.NaN,
      width: PROGRESS_OVERLAY_DEFAULT_WIDTH,
      height: PROGRESS_OVERLAY_DEFAULT_HEIGHT,
      compact: false,
      visible: false,
      historyClearedAt: null
    }),
    (candidate): candidate is ProgressOverlayPreferences => {
      if (!candidate || typeof candidate !== 'object') return false
      const input = candidate as Partial<ProgressOverlayPreferences>
      return (
        typeof input.x === 'number' &&
        typeof input.y === 'number' &&
        Number.isFinite(input.x) &&
        Number.isFinite(input.y) &&
        (input.width === undefined || (typeof input.width === 'number' && Number.isFinite(input.width))) &&
        (input.height === undefined || (typeof input.height === 'number' && Number.isFinite(input.height))) &&
        typeof input.compact === 'boolean' &&
        typeof input.visible === 'boolean' &&
        (
          input.historyClearedAt === undefined ||
          input.historyClearedAt === null ||
          (
            typeof input.historyClearedAt === 'string' &&
            Number.isFinite(Date.parse(input.historyClearedAt))
          )
        )
      )
    }
  )
  const size = progressOverlaySizeNear(
    value.x,
    value.y,
    value.width,
    value.height,
    value.compact
  )
  const position = clampProgressOverlayPosition(value.x, value.y, size.width, size.height)
  const display = progressOverlayDisplayNear(position.x, position.y, size.width, size.height)
  const expanded = progressOverlayExpandedSize(
    value.width,
    value.height,
    display.workArea.width,
    display.workArea.height
  )
  progressOverlayPreferences = {
    ...value,
    ...position,
    width: expanded.width,
    height: expanded.height,
    historyClearedAt: value.historyClearedAt ?? null
  }
  return progressOverlayPreferences
}

function persistProgressOverlayPreferences(): void {
  if (!progressOverlayPreferences) return
  try {
    persistJsonStore(progressOverlayPreferencesFile(), progressOverlayPreferences)
  } catch {
    // Preferências são conveniência; nunca interrompem o fluxo das missões.
  }
}

function refreshProgressSnapshot(): ProgressOverlaySnapshot {
  progressSnapshotRevision += 1
  latestProgressSnapshot = progressSnapshotSource
    ? progressSnapshotSource(progressSnapshotRevision)
    : { ...latestProgressSnapshot, revision: progressSnapshotRevision, generatedAt: new Date().toISOString() }
  return publishProgressSnapshot()
}

function refreshProgressLiveSnapshot(): ProgressOverlaySnapshot {
  if (!progressCoordinatorActivitySource) return refreshProgressSnapshot()
  progressSnapshotRevision += 1
  latestProgressSnapshot = applyProgressCoordinatorActivity(
    latestProgressSnapshot,
    progressCoordinatorActivitySource(),
    progressSnapshotRevision
  )
  return publishProgressSnapshot()
}

function publishProgressSnapshot(): ProgressOverlaySnapshot {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('progress:snapshot-changed', latestProgressSnapshot)
  }
  if (
    progressOverlayWindow &&
    !progressOverlayWindow.isDestroyed() &&
    !progressOverlayWindow.webContents.isLoading()
  ) {
    progressOverlayWindow.webContents.send('progress:snapshot-changed', latestProgressSnapshot)
  }
  return latestProgressSnapshot
}

function scheduleProgressSnapshot(): void {
  if (progressSnapshotTimer) clearTimeout(progressSnapshotTimer)
  progressSnapshotTimer = setTimeout(() => {
    progressSnapshotTimer = null
    refreshProgressSnapshot()
  }, 90)
}

/** Saída de Maestro/orquestrador chega em muitos chunks por segundo. Este
 * throttle mantém o painel vivo sem reler stores/planos a cada repaint do TUI;
 * o segundo timer publica a transição quando passam 4s sem nova atividade. */
function scheduleProgressLiveSnapshot(paneId: string): void {
  if (!progressLivePulseTimer) {
    progressLivePulseTimer = setTimeout(() => {
      progressLivePulseTimer = null
      refreshProgressLiveSnapshot()
    }, 700)
  }
  const previousIdleTimer = progressLiveIdleTimers.get(paneId)
  if (previousIdleTimer) clearTimeout(previousIdleTimer)
  progressLiveIdleTimers.set(paneId, setTimeout(() => {
    progressLiveIdleTimers.delete(paneId)
    refreshProgressLiveSnapshot()
  }, PROGRESS_COORDINATOR_ACTIVE_MS + 120))
}

function setProgressOverlayCompact(compact: boolean): void {
  const preferences = loadProgressOverlayPreferences()
  const storedSize = progressOverlaySizeNear(
    preferences.x,
    preferences.y,
    preferences.width,
    preferences.height,
    preferences.compact
  )
  const current = progressOverlayWindow && !progressOverlayWindow.isDestroyed()
    ? progressOverlayWindow.getBounds()
    : {
        x: preferences.x,
        y: preferences.y,
        ...storedSize
      }
  const expandedWidth = preferences.compact ? preferences.width : current.width
  const expandedHeight = preferences.compact ? preferences.height : current.height
  const display = progressOverlayDisplayNear(
    current.x,
    current.y,
    expandedWidth,
    expandedHeight
  )
  const expanded = progressOverlayExpandedSize(
    expandedWidth,
    expandedHeight,
    display.workArea.width,
    display.workArea.height
  )
  const nextSize = {
    width: expanded.width,
    height: compact ? PROGRESS_OVERLAY_COMPACT_HEIGHT : expanded.height
  }
  // Mantém a borda inferior no mesmo lugar: perto da barra de tarefas a janela
  // expandida cresce para cima, sem sumir para fora da tela.
  const position = clampProgressOverlayPosition(
    current.x,
    current.y + current.height - nextSize.height,
    nextSize.width,
    nextSize.height
  )
  progressOverlayPreferences = {
    ...preferences,
    ...position,
    ...expanded,
    compact
  }
  const win = progressOverlayWindow
  if (win && !win.isDestroyed()) {
    win.setMinimumSize(PROGRESS_OVERLAY_MIN_WIDTH, PROGRESS_OVERLAY_COMPACT_HEIGHT)
    win.setBounds({ ...position, ...nextSize }, true)
    win.setMinimumSize(
      PROGRESS_OVERLAY_MIN_WIDTH,
      compact ? PROGRESS_OVERLAY_COMPACT_HEIGHT : PROGRESS_OVERLAY_MIN_HEIGHT
    )
    win.setResizable(!compact)
    win.webContents.send('progress:overlay-mode-changed', { compact })
  }
  persistProgressOverlayPreferences()
}

function createProgressOverlay(): BrowserWindow {
  if (progressOverlayWindow && !progressOverlayWindow.isDestroyed()) return progressOverlayWindow
  const preferences = loadProgressOverlayPreferences()
  const size = progressOverlaySizeNear(
    preferences.x,
    preferences.y,
    preferences.width,
    preferences.height,
    preferences.compact
  )
  const position = clampProgressOverlayPosition(
    preferences.x,
    preferences.y,
    size.width,
    size.height
  )
  const initialDisplay = progressOverlayDisplayNear(
    position.x,
    position.y,
    size.width,
    size.height
  )
  const maximumSize = progressOverlayMaximumSize(
    initialDisplay.workArea.width,
    initialDisplay.workArea.height
  )
  const win = new BrowserWindow({
    ...position,
    ...size,
    minWidth: PROGRESS_OVERLAY_MIN_WIDTH,
    minHeight: preferences.compact
      ? PROGRESS_OVERLAY_COMPACT_HEIGHT
      : PROGRESS_OVERLAY_MIN_HEIGHT,
    maxWidth: maximumSize.width,
    maxHeight: maximumSize.height,
    // TRANSPARENTE + sem thickFrame (decisão do usuário, 2026-08-03): a
    // "borda escura" era o fundo da janela vazando em volta do cartão CSS +
    // a moldura nativa de resize. O redimensionamento continua existindo,
    // mas via alça própria no canto (IPC progress:overlay-resize →
    // setBounds) — janela transparente não tem resize nativo no Windows.
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    thickFrame: false,
    resizable: !preferences.compact,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Andamento · Synkora',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: ['--progress-overlay']
    }
  })
  progressOverlayWindow = win
  // DPI misto: reaplicar bounds pós-criação (ver comentário no overlay do
  // SynVoice — mesma causa, mesma cura).
  win.setBounds({ ...position, ...size })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (trustedRendererView(url, 'progress-overlay')) return
    event.preventDefault()
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const persistBounds = (): void => {
    if (win.isDestroyed()) return
    const { x, y, width, height } = win.getBounds()
    const current = loadProgressOverlayPreferences()
    progressOverlayPreferences = {
      ...current,
      x,
      y,
      ...(!current.compact ? { width, height } : {})
    }
    persistProgressOverlayPreferences()
  }
  progressOverlayBoundsFlush = persistBounds
  const scheduleBoundsPersist = (): void => {
    if (progressOverlayMoveTimer) clearTimeout(progressOverlayMoveTimer)
    progressOverlayMoveTimer = setTimeout(() => {
      progressOverlayMoveTimer = null
      persistBounds()
    }, 160)
  }
  win.on('move', scheduleBoundsPersist)
  win.on('resize', scheduleBoundsPersist)
  win.on('will-resize', (event, nextBounds) => {
    const display = progressOverlayDisplayNear(
      nextBounds.x,
      nextBounds.y,
      nextBounds.width,
      nextBounds.height
    )
    const nextSize = progressOverlayExpandedSize(
      nextBounds.width,
      nextBounds.height,
      display.workArea.width,
      display.workArea.height
    )
    if (nextSize.width === nextBounds.width && nextSize.height === nextBounds.height) return
    event.preventDefault()
    const nextPosition = clampProgressOverlayPosition(
      nextBounds.x,
      nextBounds.y,
      nextSize.width,
      nextSize.height
    )
    win.setBounds({ ...nextPosition, ...nextSize })
  })
  win.on('moved', () => {
    const bounds = win.getBounds()
    const display = progressOverlayDisplayNear(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height
    )
    const nextMaximum = progressOverlayMaximumSize(
      display.workArea.width,
      display.workArea.height
    )
    win.setMaximumSize(nextMaximum.width, nextMaximum.height)
  })
  win.on('close', () => {
    if (progressOverlayMoveTimer) {
      clearTimeout(progressOverlayMoveTimer)
      progressOverlayMoveTimer = null
    }
    persistBounds()
  })
  win.on('closed', () => {
    if (progressOverlayMoveTimer) {
      clearTimeout(progressOverlayMoveTimer)
      progressOverlayMoveTimer = null
    }
    if (progressOverlayBoundsFlush === persistBounds) progressOverlayBoundsFlush = null
    if (progressOverlayWindow === win) progressOverlayWindow = null
  })
  win.webContents.on('did-finish-load', () => {
    refreshProgressSnapshot()
    win.webContents.send('progress:overlay-mode-changed', {
      compact: loadProgressOverlayPreferences().compact
    })
    if (loadProgressOverlayPreferences().visible) win.showInactive()
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logCrash('progress-overlay-gone', `${details.reason} (exitCode ${details.exitCode})`)
    if (details.reason !== 'clean-exit') win.webContents.reload()
  })

  const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devUrl) {
    const overlayUrl = new URL(devUrl)
    overlayUrl.searchParams.set('view', 'progress-overlay')
    if (!trustedRendererView(overlayUrl.href, 'progress-overlay')) {
      throw new Error('URL de desenvolvimento da janela de andamento não autorizada.')
    }
    void win.loadURL(overlayUrl.href)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { view: 'progress-overlay' }
    })
  }
  return win
}

function showProgressOverlay(): void {
  const preferences = loadProgressOverlayPreferences()
  progressOverlayPreferences = { ...preferences, visible: true }
  persistProgressOverlayPreferences()
  const win = createProgressOverlay()
  if (!win.webContents.isLoading()) {
    refreshProgressSnapshot()
    win.showInactive()
  }
  win.setAlwaysOnTop(true, 'floating')
}

function hideProgressOverlay(): void {
  progressOverlayBoundsFlush?.()
  const preferences = loadProgressOverlayPreferences()
  progressOverlayPreferences = { ...preferences, visible: false }
  persistProgressOverlayPreferences()
  if (progressOverlayWindow && !progressOverlayWindow.isDestroyed()) {
    progressOverlayWindow.hide()
  }
}

function toggleProgressOverlay(): void {
  if (
    progressOverlayWindow &&
    !progressOverlayWindow.isDestroyed() &&
    progressOverlayWindow.isVisible()
  ) {
    hideProgressOverlay()
    return
  }
  showProgressOverlay()
}

// O app NÃO pode morrer sozinho em silêncio (aconteceu em campo): erros não
// tratados do main são LOGADOS em userData/synkora-crash.log e o processo
// segue vivo — diagnóstico fica no arquivo em vez de janela sumindo.
// F5.7e — rede COMPLETA (o exit 5 de 2026-07-28 não deixou rastro porque foi
// crash NATIVO, que não passa pelo JS): Crashpad grava MINIDUMP local de
// main/renderer/GPU em app.getPath('crashDumps'); child-process-gone loga
// GPU/utility; o preload reporta erros JS do renderer via IPC; e o marcador
// session.alive denuncia morte suja no boot seguinte. Tudo numa linha do
// tempo só (boot → … → crash/dirty-exit) com contexto de memória/panes.
crashReporter.start({ uploadToServer: false })

// HARNESS E2E (2026-08-05, ordem do usuário: "você vai testar; quando falar
// que está pronto é porque testou"): com SYNKORA_E2E=1 o app expõe o Chrome
// DevTools Protocol em 127.0.0.1:9222 e o driver (scripts/e2e/) chama o
// window.synkora REAL do renderer — as MESMAS chamadas que os botões fazem
// (criar missão, confirmar orquestrador, aprovar plano, integrar). NUNCA
// ligado sem a env; nada muda no uso normal.
if (process.env['SYNKORA_E2E'] === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['SYNKORA_E2E_PORT'] ?? '9222')
}

// CAIXA-PRETA CENTRAL (plano de estabilização 02/08/2026): diário único
// JSONL append-only em userData/blackbox + resumo legível journal.md. Todo
// ponto relevante do fluxo grava aqui com ids de correlação; o synkora-crash.log
// continua como linha do tempo mínima de crash e é espelhado no diário.
const blackbox = new Blackbox({ dir: join(app.getPath('userData'), 'blackbox') })

function crashContext(): string {
  try {
    const mem = process.memoryUsage()
    return `app ${app.getVersion()} · electron ${process.versions.electron} · uptime ${Math.round(process.uptime())}s · rss ${(mem.rss / 1048576).toFixed(0)}MB · panes ${ptys.count()}`
  } catch {
    return ''
  }
}

function logCrash(kind: string, err: unknown): void {
  const message = redactSensitiveText(
    err instanceof Error ? (err.stack ?? err.message) : String(err)
  )
  // boot é linha do tempo, não erro — no diário ele entra como motivo
  blackbox.record({
    cat: 'app',
    event: kind,
    actor: 'app',
    ...(kind === 'boot' ? { reason: message } : { err: message }),
    detail: { context: crashContext() }
  })
  try {
    const file = join(app.getPath('userData'), 'synkora-crash.log')
    appendFileSync(
      file,
      `${new Date().toISOString()} [${kind}] ${message} · ${crashContext()}\n`,
      'utf-8'
    )
    // rotação: caixa-preta, não lixão — acima de ~512KB fica só o rabo
    if (statSync(file).size > 512 * 1024) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      writeFileSync(file, lines.slice(-400).join('\n'), 'utf-8')
    }
  } catch {
    // sem onde logar
  }
}
process.on('uncaughtException', (err) => {
  // Conclusão ASSÍNCRONA de write no pipe do ConPTY (caso real 04/08: EAGAIN
  // via WriteWrap.onWriteComplete 0,4s após spawn de pane) — o safeWrite só
  // cobre o caminho síncrono. Pipe cheio/morto não é crash do app: registra
  // e segue; qualquer outra exceção continua no fluxo normal de crash-log.
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (
    (code === 'EAGAIN' || code === 'EPIPE' || code === 'ECONNRESET') &&
    /WriteWrap|stream_base|Socket/.test(err?.stack ?? '')
  ) {
    try {
      blackbox.record({
        cat: 'app',
        event: 'pty-write-async-error',
        actor: 'app',
        reason: `${code} em write assíncrono de PTY (tolerado)`,
        detail: { context: crashContext() }
      })
    } catch {
      // observador nunca derruba o app
    }
    return
  }
  logCrash('uncaught', err)
})
process.on('unhandledRejection', (reason) => logCrash('rejection', reason))
// GPU/network/utility caindo também é crash — e explica pane "congelado"
app.on('child-process-gone', (_e, details) => {
  if (details.reason !== 'clean-exit' && details.reason !== 'killed')
    logCrash(
      'child-gone',
      `${details.type}${details.name ? ` ${details.name}` : ''} → ${details.reason} (exitCode ${details.exitCode})`
    )
})
// FASE 0 do nível 5 (docs/PLANO_NIVEL_5.md): atribuição de CULPA dos stalls.
// O patch de ipcMain cobre TODO handler registrado daqui para baixo — os ~120
// canais viram operações medidas (`ipc:<canal>`); o watchdog logo abaixo anexa
// os culpados ao event-loop-stall. Módulo puro em stallAttribution.ts (suíte
// test:stall-attribution).
const mainStalls = new StallAttribution()
instrumentIpcMain(ipcMain, mainStalls)
// Erros JS do RENDERER (window.onerror/unhandledrejection registrados no
// preload): não derrubam o processo, mas quebram a UI — vão para a mesma
// caixa-preta. Throttle por mensagem: erro em loop não inunda o log.
const rendererErrSeen = new Map<string, number>()
ipcMain.on('crash:renderer', (_e, info: string) => {
  const key = String(info).slice(0, 300)
  const last = rendererErrSeen.get(key) ?? 0
  if (Date.now() - last < 5000) return
  rendererErrSeen.set(key, Date.now())
  logCrash('renderer-js', info)
})
// TRAVADA VIRA EVENTO (caso real 04/08/2026: duas "travadas sinistras" com
// recuperação sozinha e o diário MUDO — freeze de thread não passa por handler
// nenhum): cada lado mede o atraso do próprio event loop a cada 1s; stall >1s
// entra na caixa-preta com a duração e o contexto. O renderer mede no main.tsx
// e reporta por IPC.
let mainLoopLast = Date.now()
setInterval(() => {
  const now = Date.now()
  const lag = now - mainLoopLast - 1000
  mainLoopLast = now
  // Fase 0: limiar 1000→500ms — com os culpados anexados, as paradas médias
  // (as "travadinhas" de clique que antes passavam invisíveis) viram dado.
  if (lag <= 500) return
  try {
    blackbox.record({
      cat: 'app',
      event: 'event-loop-stall',
      actor: 'app',
      reason: `event loop do MAIN parado ~${Math.round(lag)}ms`,
      // Fase 0: QUEM estava ocupando o main durante a janela travada
      detail: { context: crashContext(), culprits: mainStalls.blameSummary(lag) }
    })
  } catch {
    // observador nunca derruba o app
  }
}, 1000)
let rendererStallLast = 0
ipcMain.on('perf:renderer-stall', (_e, lagMs: number) => {
  if (typeof lagMs !== 'number' || !Number.isFinite(lagMs) || lagMs < 500) return
  if (Date.now() - rendererStallLast < 5000) return
  rendererStallLast = Date.now()
  try {
    blackbox.record({
      cat: 'app',
      event: 'renderer-stall',
      actor: 'app',
      reason: `event loop do RENDERER parado ~${Math.round(lagMs)}ms`,
      detail: { context: crashContext() }
    })
  } catch {
    // observador nunca derruba o app
  }
})
// Quit LIMPO remove o marcador de sessão viva — crash não passa por aqui, e
// é exatamente assim que o boot seguinte reconhece a morte suja.
app.on('will-quit', () => {
  blackbox.record({
    cat: 'app',
    event: 'quit-clean',
    actor: 'user',
    detail: { context: crashContext() }
  })
  stopAllQaRuntimes()
  if (progressSnapshotTimer) {
    clearTimeout(progressSnapshotTimer)
    progressSnapshotTimer = null
  }
  paneStartupMetrics?.close()
  void mcpServerHandle?.close().catch(() => undefined)
  mcpServerHandle = undefined
  mcpPort = 0
  for (const active of codeIntelligenceSessions.values()) active.session.close()
  codeIntelligenceSessions.clear()
  void codeIntelligence?.close()
  codeIntelligence = undefined
  synVoiceOverlayBoundsFlush?.()
  progressOverlayBoundsFlush?.()
  hideSynVoiceOverlayTooltip()
  hideSynVoiceNotice()
  if (synVoiceOverlayTooltipWindow && !synVoiceOverlayTooltipWindow.isDestroyed()) {
    synVoiceOverlayTooltipWindow.destroy()
  }
  if (synVoiceNoticeWindow && !synVoiceNoticeWindow.isDestroyed()) {
    synVoiceNoticeWindow.destroy()
  }
  synVoiceExternalInput.clear()
  synVoiceGlobalActivation.stop()
  try {
    unlinkSync(join(app.getPath('userData'), 'session.alive'))
  } catch {
    // marcador nem existia
  }
})

// INSTÂNCIA ÚNICA (caso achado na varredura do mapa de retomada, 2026-08-06):
// dois `npm run dev`/atalhos simultâneos eram DOIS processos gravando os
// MESMOS stores atômicos (tasks/missions/queue) — último a escrever vence,
// perda silenciosa de estado; e dois PtyManagers/MCP servers disputando os
// panes. A segunda instância morre na hora e a primeira ganha o foco.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(async () => {
  // AppUserModelID: é por ele que o Windows amarra a JANELA ao APP. Sem isso o
  // shell trata a janela como avulsa — atalho fixado e entrada do Explorer
  // continuam mostrando o ícone do binário que a lançou (o electron.exe, em
  // desenvolvimento). Precisa bater com o `appId` do electron-builder.yml.
  if (process.platform === 'win32') app.setAppUserModelId('dev.synkora.app')

  // MORTE SUJA da sessão anterior (crash nativo/kill não passa pelo JS): o
  // marcador session.alive fica órfão e o boot seguinte registra na
  // caixa-preta, apontando os minidumps. Depois, marca esta sessão como viva.
  const aliveMarker = join(app.getPath('userData'), 'session.alive')
  try {
    if (existsSync(aliveMarker)) {
      logCrash(
        'dirty-exit',
        `a sessão anterior (boot ${readFileSync(aliveMarker, 'utf-8').trim() || '?'}) morreu SEM quit limpo — crash nativo ou kill; minidumps (se houver): ${app.getPath('crashDumps')}`
      )
    }
    writeFileSync(aliveMarker, new Date().toISOString(), 'utf-8')
  } catch {
    // marcador é best-effort
  }
  logCrash('boot', `app iniciado · minidumps em ${app.getPath('crashDumps')}`)

  paneStartupMetrics = new PaneStartupMetrics(app.getPath('userData'), {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron
  })

  // Fase 0: cargas síncronas dos stores no boot são etapa medida
  const endBootStores = mainStalls.begin('boot:stores')
  projects = new ProjectStore()
  seats = new SeatStore()
  tasks = new TaskStore()
  const missions = new MissionStore()
  // Caixa-preta: toda mudança de estado de card entra no diário com estado
  // anterior/seguinte — é a espinha da reconstrução de qualquer fluxo.
  tasks.onMutation = (prev, next) => {
    const summary = (t: Task): string =>
      `${t.status}/${t.activePhase ?? '-'}/${t.phaseState ?? '-'}`
    const changedState = summary(prev) !== summary(next)
    const changedFeedback = prev.feedback !== next.feedback
    if (!changedState && !changedFeedback) return
    blackbox.record({
      cat: 'task',
      event: changedState ? 'state-change' : 'feedback-change',
      ids: {
        projectId: next.projectId,
        missionId: next.missionId,
        taskId: next.id,
        planId: next.planId,
        phase: next.activePhase
      },
      prev: summary(prev),
      next: summary(next),
      reason: changedFeedback ? next.feedback : undefined,
      detail: {
        title: next.title,
        kind: next.kind,
        cycles: next.cycles,
        devHead: next.verification?.dev?.head?.slice(0, 12),
        devBaseHead: next.verification?.dev?.baseHead?.slice(0, 12)
      }
    })
  }
  tasks.onCreate = (created) => {
    for (const t of created) {
      blackbox.record({
        cat: 'task',
        event: 'created',
        ids: {
          projectId: t.projectId,
          missionId: t.missionId,
          taskId: t.id,
          planId: t.planId
        },
        next: t.status,
        detail: { title: t.title, kind: t.kind, department: t.department, auto: t.auto }
      })
    }
  }
  tasks.onRemove = (removed) => {
    blackbox.record({
      cat: 'task',
      event: 'removed',
      ids: {
        projectId: removed.projectId,
        missionId: removed.missionId,
        taskId: removed.id,
        planId: removed.planId
      },
      prev: removed.status,
      detail: { title: removed.title, kind: removed.kind }
    })
  }
  const integrationQueue = new IntegrationQueueStore(
    join(app.getPath('userData'), 'integration-queue.json')
  )
  const backlog = new BacklogStore()
  const maestro = new MaestroStore()
  const policies = new PolicyStore()
  const settings = new SettingsStore()
  endBootStores()
  const progressPlanUnavailableProjectIds = new Set<string>()
  const projectPlanOf = (projectId: string): ProjectPlan | undefined => {
    const project = projects.get(projectId)
    if (!project || !existsSync(project.path)) return undefined
    try {
      // loadProjectPlan também pode reparar JSON/backup/Markdown; portanto a
      // leitura passa pela mesma guarda de qualquer mutação do runtime.
      ensureSynkoraGitExcludes(project.path)
      return loadProjectPlan(project.path)
    } catch {
      progressPlanUnavailableProjectIds.add(projectId)
      return undefined
    }
  }
  // Migração one-shot, antes de qualquer pane de agente nascer. Somente um
  // plano que já estava aprovado no primeiro boot deste contrato recebe a
  // exceção legacy; depois disso, editar o JSON do workspace nunca consegue
  // fabricar o carimbo guardado em userData.
  for (const project of projects.list()) {
    if (
      (project.planningTrustVersion ?? 0) >= PROJECT_PLAN_TRUST_CONTRACT_VERSION
    ) {
      continue
    }
    let legacyApproval: ReturnType<typeof legacyProjectPlanApproval> = undefined
    if (existsSync(project.path)) {
      try {
        ensureSynkoraGitExcludes(project.path)
        const plan = loadProjectPlan(project.path)
        if (plan) legacyApproval = legacyProjectPlanApproval(plan)
      } catch {
        // Falha fechada: concluímos a migração sem grandfathering. O plano
        // precisa ser reparado e salvo novamente com receipt real.
      }
    }
    projects.migratePlanningTrust(project.id, legacyApproval)
  }
  progressCoordinatorActivitySource = () => {
    const activityNow = Date.now()
    return projects.list().flatMap((project) => {
      const byIdentity = new Map<string, ProgressCoordinatorActivityInput>()
      for (const activity of hub
        .panesOf(project.id)
        .filter((pane) => pane.role === 'maestro' && ptys.has(pane.paneId))
        .map((pane) => {
          const lastOutputAt = ptys.lastOutputAt(pane.paneId)
          const note = paneStatusNotes.get(pane.paneId)
          return {
            projectId: project.id,
            ...(pane.missionId ? { missionId: pane.missionId } : {}),
            role: pane.missionId ? 'orchestrator' as const : 'maestro' as const,
            kind: 'terminal' as const,
            working:
              lastOutputAt !== undefined &&
              activityNow - lastOutputAt < PROGRESS_COORDINATOR_ACTIVE_MS,
            updatedAt: new Date(lastOutputAt ?? activityNow).toISOString(),
            ...(note ? { note: note.text } : {})
          }
        })) {
        const identity = activity.role === 'orchestrator'
          ? `orchestrator:${activity.missionId ?? project.id}`
          : `maestro:${project.id}`
        const previous = byIdentity.get(identity)
        if (!previous || activity.updatedAt > previous.updatedAt) byIdentity.set(identity, activity)
      }
      const headless = currentProgressHeadlessActivity(project.id)
      if (headless) {
        byIdentity.set(`maestro:${project.id}`, {
          projectId: project.id,
          role: 'maestro',
          kind: headless.kind,
          working: true,
          updatedAt: headless.startedAt
        })
      }
      return [...byIdentity.values()]
    })
  }
  progressSnapshotSource = (revision) => {
    const allProjects = projects.list()
    progressPlanUnavailableProjectIds.clear()
    const projectPlans = Object.fromEntries(
      allProjects.map((project) => [project.id, projectPlanOf(project.id)])
    )
    return buildProgressSnapshot({
      projects: allProjects,
      missions: allProjects.flatMap((project) => missions.list(project.id)),
      tasks: allProjects.flatMap((project) => tasks.list(project.id)),
      integrationQueue: integrationQueue.listPending(),
      projectPlans,
      coordinatorActivity: progressCoordinatorActivitySource?.() ?? [],
      missingProjectIds: allProjects
        .filter((project) => !existsSync(project.path))
        .map((project) => project.id),
      planUnavailableProjectIds: [...progressPlanUnavailableProjectIds],
      // frases vivas dos agentes de execução/gate (status_note) — resolvidas
      // pela identidade do pane no instante do snapshot
      paneNotes: [...paneStatusNotes].flatMap(([paneId, note]) => {
        const identity = hub.identityByPane(paneId)
        if (!identity) return []
        const phase =
          identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa'
            ? identity.role
            : undefined
        return [
          {
            projectId: identity.projectId,
            ...(identity.missionId ? { missionId: identity.missionId } : {}),
            ...(identity.taskId ? { taskId: identity.taskId } : {}),
            ...(phase ? { phase } : {}),
            role: identity.role,
            text: note.text,
            at: note.at
          }
        ]
      }),
      pendingQuestions: [...pendingUserQuestions.values()],
      revision
    })
  }
  const hasProjectPlanArtifacts = (projectPath: string): boolean => {
    const paths = projectPlanPaths(projectPath)
    return existsSync(paths.json) || existsSync(paths.backup)
  }
  const ensureProjectRuntimeWritable = (projectId: string): void => {
    const project = projects.get(projectId)
    if (!project) throw new Error('projeto não encontrado')
    ensureSynkoraGitExcludes(project.path)
  }
  /** Projetos antigos ganham a classificação uma única vez; depois ela não
   *  muda quando as primeiras missões criarem código. */
  const projectModeOf = (projectId: string): 'greenfield' | 'existing' => {
    const project = projects.get(projectId)
    if (!project) return 'existing'
    if (project.mode) return project.mode
    const mode =
      projectPlanOf(projectId) ||
      hasProjectPlanArtifacts(project.path) ||
      isEffectivelyEmptyProject(project.path)
        ? 'greenfield'
        : 'existing'
    projects.setMode(projectId, mode)
    if (mode === 'greenfield' && existsSync(project.path)) {
      try {
        ensureSynkoraGitExcludes(project.path)
        ensureGreenfieldProjectPlan(project.path, { projectName: project.name })
        ensureProjectSecurityBaseline(project.path, {
          installRepositoryAdapters: true,
          projectName: project.name
        })
      } catch {
        /* o pane ainda explica o modo; a tool devolve o erro ao tentar salvar */
      }
    }
    return mode
  }
  let preparedPlaywright: McpStdioLaunch | undefined
  let externalServicesCheckedAt: number | null = null
  let externalServicesAvailable: boolean | null = null
  const validateExternalServices = (): McpStdioLaunch | undefined => {
    const launch = resolveBundledPlaywrightMcp()
    preparedPlaywright = launch
    externalServicesAvailable = Boolean(launch)
    externalServicesCheckedAt = Date.now()
    return launch
  }
  const externalPlaywrightForPane = (): McpStdioLaunch | undefined => {
    if (settings.get().externalServicePreparation === 'automatic') {
      return externalServicesCheckedAt == null ? validateExternalServices() : preparedPlaywright
    }
    return validateExternalServices()
  }
  if (settings.get().codeIntelligenceMode === 'automatic') {
    codeIntelligence = createCodeIntelligenceManager()
  }
  if (settings.get().externalServicePreparation === 'automatic') validateExternalServices()
  const synVoice = new SynVoiceService()

  // ConPTY v2 (conpty.dll do pacote) — a correção de raiz da TUI que repintava
  // a tela inteira a cada resize. Ligado por padrão; settings.conptyDll=false
  // volta ao ConPTY do Windows sem rebuild. Ver o bloco no spawn de pty.ts.
  ptys.setConptyDll(settings.get().conptyDll !== false)
  // Persona de pane vira ARQUIVO (--append-system-prompt-file) nesta pasta —
  // argv tem teto de 32767 chars no Windows (ver guarda no pty.ts, caso 02/08).
  const trustedPromptDir = join(app.getPath('userData'), 'prompts')
  ptys.setPromptDir(trustedPromptDir)
  const persistTrustedSystemPrompt = (name: string, content: string): string | undefined => {
    try {
      mkdirSync(trustedPromptDir, { recursive: true })
      const file = join(trustedPromptDir, name.replace(/[^A-Za-z0-9._-]/g, '-'))
      writeFileSync(file, content, 'utf-8')
      return file
    } catch {
      return undefined
    }
  }
  const maestroSystemPromptFile = persistTrustedSystemPrompt(
    'maestro-panel.system.md',
    PERSONA_DEV
  )
  const surveySystemPromptFile = persistTrustedSystemPrompt(
    'survey.system.md',
    SURVEY_SECURITY_PROMPT
  )
  // token opcional do GitHub p/ a biblioteca de skills (60/h → 5.000/h)
  setGithubToken(settings.get().githubToken)


  // SYNVOICE: bytes do microfone entram por IPC e a chamada externa acontece
  // exclusivamente no main. As chaves nunca voltam ao renderer e ficam
  // cifradas no cofre do sistema. Cada IPC valida o frame local que o originou.
  const voiceRequests = new Map<string, { controller: AbortController; senderId: number }>()
  abortVoiceRequests = () => {
    for (const request of voiceRequests.values()) request.controller.abort()
    voiceRequests.clear()
  }


  // BIBLIOTECA DE SKILLS (F4): catálogo curado instalado da fonte (GitHub)
  // em userData/skills/lib. Execução usa plano mínimo + árvore privada por
  // receipt; a UI instala/atualiza e mostra disponibilidade, não um kit ativo.
  const skillsLib = new SkillsLibrary([...CURATED_SKILLS, ...BUNDLED_AGENTS, ...BUNDLED_SKILLS])
  // Pacotes ativados vivem fora do projeto e de qualquer root autodetectada.
  // Como o app e single-instance, o sweep remove com seguranca residuos de um
  // crash anterior antes de abrir a raiz aleatoria desta sessao.
  const privateSkillRuntimeBase = join(app.getPath('temp'), 'synkora-skill-runtime')
  const privateSkillRuntimeRoot = join(privateSkillRuntimeBase, `${process.pid}-${randomUUID()}`)
  try {
    rmSync(privateSkillRuntimeBase, { recursive: true, force: true })
    mkdirSync(privateSkillRuntimeRoot, { recursive: true })
  } catch (error) {
    throw new Error(`nao foi possivel preparar o runtime privado de skills: ${error instanceof Error ? error.message : String(error)}`)
  }
  app.once('will-quit', () => {
    try {
      rmSync(privateSkillRuntimeRoot, { recursive: true, force: true })
    } catch {
      // O proximo boot repete o sweep; nao bloqueia o encerramento.
    }
  })
  // Skill embutida é conteúdo versionado: instala antes de registrar o fluxo de
  // panes e reinstala quando os bytes do app mudam. Assim a régua nova chega a
  // quem já tinha `sha: bundled`, sem rede, delay de boot ou versão manual.
  const bundledPackageMatches = (id: string): boolean => skillsLib.bundledPackageMatches(id)
  const staleBundled = selectStaleBundledIds(
    BUNDLED_SKILLS,
    skillsLib.listState(),
    bundledPackageMatches
  )
  if (staleBundled.length > 0) {
    const bundledInstall = await skillsLib.installMany(staleBundled)
    const unresolvedBundled = selectStaleBundledIds(
      BUNDLED_SKILLS,
      skillsLib.listState(),
      bundledPackageMatches
    )
    if (!bundledInstall.ok || unresolvedBundled.length > 0) {
      console.error(`[skills] falha ao atualizar contrato embutido: ${bundledInstall.msg}`)
      dialog.showErrorBox(
        'Não foi possível iniciar o Synkora',
        'A régua visual obrigatória não pôde ser atualizada. Reinicie o aplicativo; se o problema continuar, verifique as permissões da pasta de dados.'
      )
      app.quit()
      return
    }
  }
  // BACKFILL de supply-chain (2026-08-04): skills legadas sem assessment
  // ficavam invisíveis em TODO menu de pane. Avalia em lotes fora do caminho
  // quente; cada avaliação persiste no manifest e o menu enche em segundos.
  const backfillSkillAssessments = async (): Promise<void> => {
    try {
      const remaining = await skillsLib.assessMissingBatch(8)
      if (remaining > 0) {
        setTimeout(() => void backfillSkillAssessments(), 400)
        return
      }
      blackbox.record({
        cat: 'app',
        event: 'skills-backfill-done',
        actor: 'app',
        reason: 'assessments de supply-chain preenchidos para as skills legadas'
      })
    } catch {
      // próximo boot retenta; instalação/uso explícito também reavalia
    }
  }
  setTimeout(() => void backfillSkillAssessments(), 5_000)
  skillsLib.onChanged = () => {
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('skills:changed')
  }

  // Todos os panes que compartilham um worktree mantem leases. O disco recebe
  // somente a UNIAO exata dos planos vivos; nenhuma skill instalada fica
  // disponivel por acidente e um pane nunca poda o contexto de outro.
  const paneSkillLeases = new WorkspaceSkillLeaseRegistry()
  const workspaceSkillKey = (cwd: string): string =>
    resolve(cwd).replace(/\\/g, '/').toLocaleLowerCase('en-US')
  const expandedPaneSkillIds = (ids: string[]): Set<string> => {
    const expanded = new Set<string>()
    const visit = (id: string): void => {
      if (expanded.has(id)) return
      expanded.add(id)
      for (const dependency of skillsLib.byId(id)?.requires ?? []) visit(dependency)
    }
    for (const id of ids) visit(id)
    return expanded
  }
  const activePaneSkillIds = (cwd: string): string[] => {
    const workspaceKey = workspaceSkillKey(cwd)
    return [
      ...new Set(
        paneSkillLeases.activeIds(workspaceKey)
      )
    ]
  }
  /** Toda sincronizacao respeita as leases ativas no mesmo workspace. O
   *  retorno continua restrito ao menu pedido pelo chamador. */
  const syncWorkspaceSkills = async (
    cwd: string,
    ids: string[]
  ): Promise<{ injected: SkillDef[]; missing: string[] }> => {
    const own = expandedPaneSkillIds(ids)
    const union = [...new Set([...activePaneSkillIds(cwd), ...ids])]
    const syncStarted = Date.now()
    const synced = await skillsLib.syncToWorkspace(cwd, union)
    const syncMs = Date.now() - syncStarted
    // Atribuição dos stalls medidos pelo watchdog (spawn 1-2s): a cópia de
    // dezenas de skills ×2 destinos é a suspeita nº 1 — só o dado decide.
    if (syncMs > 250) {
      blackbox.record({
        cat: 'app',
        event: 'slow-skill-sync',
        actor: 'app',
        reason: `syncToWorkspace levou ${syncMs}ms (${union.length} skills; no worker, main livre)`,
        detail: { cwd }
      })
    }
    return {
      injected: synced.injected.filter((skill) => own.has(skill.id)),
      missing: synced.missing.filter((id) => own.has(id))
    }
  }
  /** createTaskWorktree cronometrado e FORA do main thread (task #2): roda no
   *  gitWorker; lento continua virando evidência na caixa-preta (agora sem
   *  congelar a UI enquanto acontece). */
  const timedTaskWorktree = async (
    ...args: Parameters<typeof createTaskWorktree>
  ): Promise<ReturnType<typeof createTaskWorktree>> => {
    const started = Date.now()
    const result = await gitOff('createTaskWorktree', ...args)
    const ms = Date.now() - started
    if (ms > 250) {
      blackbox.record({
        cat: 'app',
        event: 'slow-task-worktree',
        actor: 'app',
        reason: `createTaskWorktree levou ${ms}ms (no worker, main livre)`,
        detail: { taskId: args[2] }
      })
    }
    return result
  }
  const syncPaneSkillLease = (
    paneId: string,
    cwd: string,
    ids: string[]
  ): Promise<{ injected: SkillDef[]; missing: string[] }> => {
    const workspaceKey = workspaceSkillKey(cwd)
    paneSkillLeases.acquire(paneId, {
      cwd,
      workspaceKey,
      ids: [...new Set(ids)]
    })
    return syncWorkspaceSkills(cwd, ids)
  }
  const releaseSkillLease = (paneId: string): void => {
    const released = paneSkillLeases.release(paneId)
    if (!released) return
    syncWorkspaceSkills(released.cwd, []).catch(() => {
      // A proxima sincronizacao tenta de novo; nunca derruba o encerramento.
    })
  }
  releasePaneSkillLease = releaseSkillLease
  const skillRuntime = new SkillRuntime()
  const skillPlanScopes = new Map<
    string,
    {
      phase: string
      phaseRun: string
      agentIds: string[]
      taskId?: string
      projectId?: string
      missionId?: string
    }
  >()
  const prepareSkillPlanInputs = async (
    rootIds: string[],
    describe: (id: string) => Pick<PlannedSkillInput, 'operation' | 'reason' | 'required'>
  ): Promise<{
    definitions: SkillDef[]
    inputs: PlannedSkillInput[]
    missing: string[]
  }> => {
    const definitions: SkillDef[] = []
    const inputs: PlannedSkillInput[] = []
    const missing: string[] = []
    for (const skillId of expandedPaneSkillIds(rootIds)) {
      const definition = skillsLib.byId(skillId)
      const descriptor = describe(skillId)
      const activation = await skillsLib.loadActivationPackage(skillId, descriptor.operation)
      if (!definition || definition.kind !== 'skill' || !activation) {
        missing.push(skillId)
        continue
      }
      definitions.push(definition)
      inputs.push({
        skillId,
        ...descriptor,
        version: activation.version,
        fingerprint: activation.fingerprint
      })
    }
    return { definitions, inputs, missing }
  }
  const planningPreparationTickets = new Map<string, string>()
  const preparePlanningRun = async (input: {
    paneId: string
    projectId: string
    missionId?: string
    cwd: string
  }): Promise<{ ok: true; phaseRun: string; skillBlock: string } | { ok: false; message: string }> => {
    const ticket = randomUUID()
    planningPreparationTickets.set(input.paneId, ticket)
    let phaseRun: string | undefined
    const stillOwner = (): boolean => planningPreparationTickets.get(input.paneId) === ticket
    const fail = (message: string): { ok: false; message: string } => {
      if (stillOwner()) {
        planningPreparationTickets.delete(input.paneId)
        releaseSkillLease(input.paneId)
        const scope = skillPlanScopes.get(input.paneId)
        if (scope?.phase === 'planning' && (!phaseRun || scope.phaseRun === phaseRun)) {
          releasePaneSkillPlan(input.paneId)
        }
      }
      return { ok: false, message }
    }
    try {
      const planningIds = skillsLib.orchestratorPlanningIds()
      if (
        planningIds.length !== 1 ||
        planningIds[0] !== SYNKORA_PLANNING_STANDARD_ID
      ) {
        return fail('o método nativo synkora-planning-standard não está íntegro e elegível')
      }
      await syncPaneSkillLease(input.paneId, input.cwd, [])
      const prepared = await prepareSkillPlanInputs(planningIds, () => ({
        operation: 'plan',
        reason: 'planning.standard',
        required: true
      }))
      if (!stillOwner()) {
        return { ok: false, message: 'esta abertura foi substituída por uma geração mais nova' }
      }
      if (
        prepared.missing.length > 0 ||
        prepared.inputs.length !== 1 ||
        prepared.definitions.length !== 1
      ) {
        return fail('não foi possível carregar exatamente o método nativo de planejamento')
      }
      phaseRun = randomUUID()
      const planned = skillRuntime.planPane({
        paneId: input.paneId,
        phase: 'planning',
        phaseRun,
        skills: prepared.inputs
      })
      if (!planned.ok) return fail('não foi possível registrar o receipt de planejamento')
      if (!stillOwner()) {
        skillRuntime.release({ paneId: input.paneId, phase: 'planning', phaseRun })
        return { ok: false, message: 'esta abertura foi substituída por uma geração mais nova' }
      }
      skillPlanScopes.set(input.paneId, {
        phase: 'planning',
        phaseRun,
        agentIds: [],
        projectId: input.projectId,
        missionId: input.missionId
      })
      planningPreparationTickets.delete(input.paneId)
      const receipt = planned.plan.receipts[0]
      const definition = prepared.definitions[0]
      return {
        ok: true,
        phaseRun,
        skillBlock:
          `\n\nACTIVE PLANNING METHOD — selected and bound to this exact planning run. ` +
          `Before analysis or any plan mutation, call activate_skill with receiptId ${receipt.receiptId}. ` +
          `Use only the returned method; do not browse, stack, or substitute another planning workflow. ` +
          `Every save_project_plan/create_plan call must pass skillApplications: ["${receipt.receiptId}"]. ` +
          `The backend rejects stale, foreign, unactivated, or omitted receipts.\n` +
          `- ${definition.id} · operation ${receipt.operation} · receiptId ${receipt.receiptId} · REQUIRED: ${definition.hint}`
      }
    } catch {
      return fail('falha ao preparar o método nativo de planejamento')
    }
  }
  releasePaneSkillPlan = (paneId: string): void => {
    const scope = skillPlanScopes.get(paneId)
    if (!scope) return
    const persistInterruptedUsage = (): boolean => {
      if (!scope.taskId) return true
      const task = tasks.get(scope.taskId)
      if (task?.skillUsage?.phaseRun !== scope.phaseRun) return true
      const interrupted = interruptActiveSkillUsage(task.skillUsage)
      if (interrupted === task.skillUsage) return true
      tasks.update(scope.taskId, { skillUsage: interrupted })
      if (scope.projectId && uiSender && !uiSender.isDestroyed()) {
        try {
          uiSender.send('tasks:changed', scope.projectId)
        } catch {
          // A persistência é autoritativa; a UI recupera no próximo refresh.
        }
      }
      return true
    }
    const retryInterruptedUsage = (attempt: number): void => {
      setTimeout(() => {
        try {
          persistInterruptedUsage()
        } catch (error) {
          if (attempt < 3) {
            retryInterruptedUsage(attempt + 1)
            return
          }
          blackbox.record({
            cat: 'pane',
            event: 'skill-usage-interruption-persist-failed',
            actor: 'harness',
            ids: {
              projectId: scope.projectId,
              taskId: scope.taskId,
              paneId,
              phase: scope.phase
            },
            reason: 'task-store-persist-failed-after-pane-release'
          })
        }
      }, attempt * 250)
    }
    try {
      persistInterruptedUsage()
    } catch {
      // Encerrar o processo/identidade é prioritário. O ledger é retomado em
      // background e também reconciliado no boot se o disco seguir indisponível.
      retryInterruptedUsage(1)
    }
    skillPlanScopes.delete(paneId)
    completedPlannedAgentsByPhaseRun.delete(scope.phaseRun)
    try {
      skillRuntime.release({ paneId, phase: scope.phase, phaseRun: scope.phaseRun })
    } catch {
      // O runtime é efêmero e não pode impedir o encerramento do pane.
    }
    void gitOff(
      'removePrivateSkillPlan',
      privateSkillRuntimeRoot,
      paneId,
      scope.phaseRun
    ).catch(() => undefined)
  }

  /**
   * Um pane vivo pode receber outra rodada sem perder a conversa. A conversa
   * e reutilizada; os receipts nao. Cada novo report recebe phaseRun e IDs
   * novos, presos novamente aos bytes atuais dos pacotes.
   */
  const renewLivePaneSkillRun = async (
    paneId: string,
    taskId: string,
    projectId: string,
    phase: RunPhase
  ): Promise<string | undefined> => {
    const scope = skillPlanScopes.get(paneId)
    const task = tasks.get(taskId)
    if (!scope || scope.phase !== phase || !task) return undefined
    const activePlan = skillRuntime
      .safeSnapshot()
      .plans.find(
        (plan) =>
          plan.paneId === paneId &&
          plan.phase === scope.phase &&
          plan.phaseRun === scope.phaseRun
      )
    if (!activePlan) return undefined

    const definitions: SkillDef[] = []
    const inputs: PlannedSkillInput[] = []
    for (const receipt of activePlan.receipts) {
      const definition = skillsLib.byId(receipt.skillId)
      const activation = await skillsLib.loadActivationPackage(
        receipt.skillId,
        receipt.operation
      )
      if (!definition || definition.kind !== 'skill' || !activation) return undefined
      definitions.push(definition)
      inputs.push({
        skillId: receipt.skillId,
        operation: receipt.operation,
        version: activation.version,
        fingerprint: activation.fingerprint,
        reason: receipt.reason,
        required: receipt.required
      })
    }

    if (task.skillUsage?.phaseRun !== scope.phaseRun) return undefined
    const phaseRun = randomUUID()
    const previousUsage = task.skillUsage
    const planned = skillRuntime.replacePanePlan(
      {
        paneId,
        phase,
        phaseRun,
        expectedPhase: scope.phase,
        expectedPhaseRun: scope.phaseRun,
        skills: inputs
      },
      {
        commit: (_previousPlan, nextPlan) => {
          const latestTask = tasks.get(taskId)
          if (
            !latestTask ||
            latestTask.projectId !== projectId ||
            latestTask.skillUsage?.phaseRun !== scope.phaseRun
          ) {
            throw new Error('skill usage mudou durante a renovacao')
          }
          const updatedAt = new Date().toISOString()
          const usageRun = {
            phase,
            phaseRun,
            updatedAt,
            runStatus: 'active' as const,
            skills: nextPlan.receipts.map((receipt) => ({
              receiptId: receipt.receiptId,
              id: receipt.skillId,
              operation: receipt.operation,
              version: receipt.version,
              fingerprint: receipt.fingerprint,
              status: 'planned' as const
            }))
          }
          const currentUsage = latestTask.skillUsage
          const priorHistory = [...(currentUsage.history ?? [])]
          if (!priorHistory.some((run) => run.phaseRun === currentUsage.phaseRun)) {
            priorHistory.push({
              phase: currentUsage.phase,
              phaseRun: currentUsage.phaseRun,
              updatedAt: currentUsage.updatedAt,
              runStatus: currentUsage.runStatus ?? 'interrupted',
              skills: currentUsage.skills
            })
          }
          tasks.update(taskId, {
            skillUsage: {
              ...usageRun,
              history: [
                ...priorHistory
                  .filter((run) => run.phaseRun !== phaseRun)
                  .map((run) => ({
                    ...run,
                    runStatus:
                      run.runStatus === 'active' ? 'interrupted' as const : run.runStatus
                  })),
                usageRun
              ]
            }
          })
        },
        rollback: () => {
          tasks.update(taskId, { skillUsage: previousUsage })
        }
      }
    )
    if (!planned.ok) return undefined
    skillPlanScopes.set(paneId, { ...scope, phase, phaseRun, taskId, projectId })
    await gitOff(
      'removePrivateSkillPlan',
      privateSkillRuntimeRoot,
      paneId,
      scope.phaseRun
    ).catch(() => undefined)

    // A remoção da árvore é assíncrona. O pane pode encerrar justamente nessa
    // janela; nesse caso não persista uma rodada "active" que já nasceu morta.
    const renewedIdentity = hub.identityByPane(paneId)
    const renewedScope = skillPlanScopes.get(paneId)
    const renewedTask = tasks.get(taskId)
    if (
      !renewedIdentity ||
      !ptys.has(paneId) ||
      renewedIdentity.projectId !== projectId ||
      renewedIdentity.taskId !== taskId ||
      renewedIdentity.phase !== phase ||
      renewedScope?.phaseRun !== phaseRun ||
      renewedScope.phase !== phase ||
      renewedTask?.projectId !== projectId
    ) {
      if (renewedScope?.phaseRun === phaseRun) releasePaneSkillPlan(paneId)
      await gitOff(
        'removePrivateSkillPlan',
        privateSkillRuntimeRoot,
        paneId,
        phaseRun
      ).catch(() => undefined)
      return undefined
    }
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', projectId)

    const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]))
    return [
      'ACTIVE SKILL PLAN RENEWED — every receipt from the previous round is expired. Activate and report only the receiptIds below.',
      buildSkillsBlock({
        plannedSkills: planned.plan.receipts.map((receipt) => ({
          ...(definitionsById.get(receipt.skillId) as SkillDef),
          receiptId: receipt.receiptId,
          operation: receipt.operation,
          reason: receipt.reason,
          required: receipt.required
        }))
      })
    ].join('\n\n')
  }


  // ————— Hub Synkora: event bus + servidor MCP local —————
  // Todo evento da orquestração passa pelo hub (EVENTS.md + UI + injeção no
  // pane do Maestro); as ferramentas MCP são o canal de VOLTA dos agentes.
  const maestroPaneId = (projectId: string): string => `maestro-${projectId}`
  // Orquestrador de missão: estado no maestroStore com chave composta e pane
  // `maestro-<pid>--<mid>` — o onSession do sessionStats persiste o resume
  // pelo MESMO caminho do PM (slice do prefixo "maestro-" = a chave).
  // Separador `--` e não `:`: o paneId vira NOME DE ARQUIVO da config MCP e
  // dois-pontos é proibido no Windows (o write explodia e o pane não abria).
  const orchKey = (projectId: string, missionId: string): string => `${projectId}--${missionId}`
  const orchPaneId = (projectId: string, missionId: string): string =>
    `maestro-${orchKey(projectId, missionId)}`
  const projectLifecycleOf = (projectId: string): string => {
    if (projectModeOf(projectId) !== 'greenfield') return 'existing'
    const status = projectPlanOf(projectId)?.status
    if (status === 'done') return 'greenfield-established'
    if (status === 'awaiting_release') return 'greenfield-awaiting-release'
    return 'greenfield-planning'
  }

  /** Mantem um Maestro ja aberto alinhado quando o projeto muda de etapa. O
   *  proximo spawn tambem recebe a persona atual via developer instructions. */
  const syncMaestroProjectLifecycle = (projectId: string): void => {
    const lifecycle = projectLifecycleOf(projectId)
    const previous = maestro.get(projectId).projectLifecycle
    if (previous === lifecycle) return
    maestro.update(projectId, { projectLifecycle: lifecycle })

    const paneId = maestroPaneId(projectId)
    if (!ptys.has(paneId)) return
    const instruction =
      lifecycle === 'greenfield-planning'
        ? 'O projeto está no PLANO MESTRE. Continue pelas cinco etapas salvas em .synkora/PROJECT_PLAN.md; mostre sempre onde estamos e não abra trabalho fora da próxima missão aprovada.'
        : lifecycle === 'greenfield-awaiting-release'
          ? 'Todas as missões planejadas foram integradas, mas o projeto ainda AGUARDA A PUBLICAÇÃO FINAL. Não abra outra missão e não publique silenciosamente: mostre a versão pendente e espere a aceitação explícita do usuário.'
          : lifecycle === 'greenfield-established'
            ? 'O plano mestre original foi CONCLUÍDO e agora é histórico. A partir daqui trate este como projeto pronto: crie apenas missões focadas para melhorias, funcionalidades ou correções pedidas pelo usuário; não reabra o roadmap antigo.'
            : 'Este é um PROJETO EXISTENTE. Use missões focadas para melhorias concretas; o fluxo de plano mestre de pasta vazia não se aplica.'
    hub.notifyPaneNow(
      paneId,
      `[synkora] MUDANÇA DE ETAPA (instrução autoritativa): ${instruction}`
    )
  }
  // CORREIO MCP (CHECK 15 F1): payload de pane MCP-armado vai para a caixa
  // postal durável e chega de carona no resultado da próxima tool; o
  // terminal só recebe o aviso curto abaixo. Pane sem identidade (shell/
  // teste) segue no caminho antigo de injeção.
  const mailbox = new PaneMailbox(join(app.getPath('userData'), 'mailboxes.json'))
  const MAILBOX_NUDGE =
    '[synkora] 📬 mensagem nova no seu correio — ela chega no resultado da sua PRÓXIMA tool; parado? chame check_messages'
  const mailboxNudgeAt = new Map<string, number>()
  function nudgeMailbox(paneId: string): void {
    const last = mailboxNudgeAt.get(paneId) ?? 0
    if (Date.now() - last < 20_000) return
    mailboxNudgeAt.set(paneId, Date.now())
    ptys.inject(paneId, MAILBOX_NUDGE, () => {})
  }

  hub = new Hub({
    projectPathOf: (pid) => projects.get(pid)?.path,
    ensureProjectRuntimeWritable: ensureSynkoraGitExcludes,
    // Evento de missão → SÓ o pane do orquestrador dela (decisão do usuário,
    // 2026-07-28: nenhum pane de missão fala com o PM — orquestrador morto =
    // o evento fica em EVENTS.md e o board_status recupera no respawn; antes
    // o fallback despejava assunto de missão no PM). Evento de projeto → PM.
    maestroPaneOf: (pid, missionId) => {
      if (missionId) {
        const orch = orchPaneId(pid, missionId)
        return ptys.has(orch) ? orch : undefined
      }
      return ptys.has(maestroPaneId(pid)) ? maestroPaneId(pid) : undefined
    },
    alive: (paneId) => ptys.has(paneId),
    inject: (paneId, text, onSubmitted) => {
      // CHECK 15 F1: pane com identidade MCP recebe o PAYLOAD pelo correio
      // (durável, com carona) e só o aviso curto pelo teclado — a mensagem
      // digitada + Enter (composer sujo, fatiamento, ring do ConPTY) morre
      // aqui. Sem identidade = injeção clássica intacta.
      const identity = hub.identityByPane(paneId)
      if (identity) {
        mailbox.post(mailboxKeyOf(identity, paneId), {
          text,
          at: new Date().toISOString()
        })
        blackbox.record({
          cat: 'msg',
          event: 'mailbox-post',
          actor: 'harness',
          ids: {
            paneId,
            projectId: identity.projectId,
            missionId: identity.missionId,
            taskId: identity.taskId,
            role: identity.role
          },
          detail: { line: text.slice(0, 400) }
        })
        nudgeMailbox(paneId)
        onSubmitted(true)
        return true
      }
      return ptys.inject(paneId, text, onSubmitted)
    },
    composerBusy: (paneId) => ptys.composerBusy(paneId),
    onDelivery: (paneId, status, line, meta) => {
      const identity = hub.identityByPane(paneId)
      const sourceIdentity = meta.sourcePaneId
        ? hub.identityByPane(meta.sourcePaneId)
        : undefined
      blackbox.record({
        cat: 'msg',
        event: `delivery-${status}`,
        ids: {
          paneId,
          projectId: identity?.projectId,
          missionId: identity?.missionId,
          taskId: identity?.taskId,
          role: identity?.role
        },
        detail: {
          line,
          sourcePaneId: meta.sourcePaneId,
          communicationKind: meta.kind,
          correlationId: meta.correlationId
        }
      })
      const context = identity ?? sourceIdentity
      if (
        status === 'injected' &&
        meta.sourcePaneId &&
        context &&
        uiSender &&
        !uiSender.isDestroyed()
      ) {
        const communication: HubCommunicationEvent = {
          id: meta.correlationId
            ? `${meta.correlationId}:${paneId}`
            : randomUUID(),
          ts: new Date().toISOString(),
          projectId: context.projectId,
          missionId: identity?.missionId ?? sourceIdentity?.missionId,
          taskId: identity?.taskId ?? sourceIdentity?.taskId,
          sourcePaneId: meta.sourcePaneId,
          targetPaneId: paneId,
          kind: meta.kind ?? 'message'
        }
        uiSender.send('hub:communication', communication)
      }
    },
    onEvent: (evt) => {
      // Caixa-preta: TODO evento do hub (mensagens/estados entre agentes) vira
      // entrada correlacionada — é o espelho estruturado do EVENTS.md.
      blackbox.record({
        cat: 'msg',
        event: `hub-${evt.kind}`,
        actor: evt.actor,
        ids: { projectId: evt.projectId, missionId: evt.missionId },
        detail: { text: evt.text, quiet: evt.quiet, urgent: evt.urgent }
      })
      if (uiSender && !uiSender.isDestroyed()) uiSender.send('hub:event', evt)
    }
  })

  // ————— MainContext (Fase 1, commit 1 — docs/FASE1_MAPA_MAINCONTEXT.md) ————
  // Contrato explícito do estado do main para os módulos da cirurgia
  // (phaseEngine, mcpApi/, ipc/). ZERO movimentação: o objeto só EXPÕE o que
  // já existe. Getters cobrem as variáveis reatribuídas em runtime e as
  // consts declaradas DEPOIS deste ponto (referência direta daria TDZ na
  // construção); funções entram por delegação, imune à ordem de declaração;
  // ctx.phase delega para a máquina de fases (advancePhase segue SYNC POR
  // CONTRATO). Consumidores chegam nos commits 3–5.
  const ctx: MainContext = {
    projects,
    seats,
    tasks,
    missions,
    integrationQueue,
    backlog,
    maestro,
    policies,
    settings,
    ptys,
    mailbox,
    skillsLib,
    synVoice,
    blackbox,
    mainStalls,
    sessionStats,
    helperCompletions,
    maestroSessions,
    helperSkillLeases: paneSkillLeases,
    paneTokens,
    paneMcpFiles,
    paneSessions,
    paneStatusNotes,
    helperReported,
    helperSeen,
    voiceRequests,
    get hub() {
      return hub
    },
    get uiSender() {
      return uiSender
    },
    get mainWindow() {
      return mainWindow
    },
    get mcpPort() {
      return mcpPort
    },
    get mcpServerHandle() {
      return mcpServerHandle
    },
    get codeIntelligence() {
      return codeIntelligence
    },
    get internalMcpState() {
      return internalMcpState
    },
    get paneStartupMetrics() {
      return paneStartupMetrics
    },
    get expiredSeats() {
      return expiredSeats
    },
    get baselineVerificationRuns() {
      return baselineVerificationRuns
    },
    get finalVerificationRuns() {
      return finalVerificationRuns
    },
    get missionWatches() {
      return missionWatches
    },
    get integrationDrainTimers() {
      return integrationDrainTimers
    },
    get integrationDraining() {
      return integrationDraining
    },
    get surveyAborts() {
      return surveyAborts
    },
    get testServerPanes() {
      return testServerPanes
    },
    get livePaneSpecs() {
      return livePaneSpecs
    },
    get closingPaneIds() {
      return closingPaneIds
    },
    get paneEverSpawned() {
      return paneEverSpawned
    },
    get phaseWatches() {
      return phaseWatches
    },
    get phaseLaunches() {
      return phaseLaunches
    },
    get phaseLaunchCapacity() {
      return phaseLaunchCapacity
    },
    get pendingUserQuestions() {
      return pendingUserQuestions
    },
    get liveGateWaits() {
      return liveGateWaits
    },
    get gateDeathLog() {
      return gateDeathLog
    },
    get gateCooldownUntil() {
      return gateCooldownUntil
    },
    get bootRespawnsPending() {
      return bootRespawnsPending
    },
    get phaseMarkersProcessing() {
      return phaseMarkersProcessing
    },
    get pendingPtyPreparations() {
      return pendingPtyPreparations
    },
    get mcpCatalogServedByPane() {
      return mcpCatalogServedByPane
    },
    get mcpPaneFirstContact() {
      return mcpPaneFirstContact
    },
    get seenMcpTokens() {
      return seenMcpTokens
    },
    syncBoard: (...args) => syncBoard(...args),
    emitLog: (...args) => emitLog(...args),
    scheduleProgressSnapshot: () => scheduleProgressSnapshot(),
    ensureProjectRuntimeWritable: (...args) => ensureProjectRuntimeWritable(...args),
    projectModeOf: (...args) => projectModeOf(...args),
    projectPlanOf: (...args) => projectPlanOf(...args),
    externalPlaywrightForPane: () => externalPlaywrightForPane(),
    bypassOn: (...args) => bypassOn(...args),
    maestroPaneId: (...args) => maestroPaneId(...args),
    orchPaneId: (...args) => orchPaneId(...args),
    unregisterPane: (...args) => unregisterPane(...args),
    cleanPaneMcpFile: (...args) => cleanPaneMcpFile(...args),
    codeIntelligenceSession: (...args) => codeIntelligenceSession(...args),
    persistUserQuestions: () => persistUserQuestions(),
    abortVoiceRequests: () => abortVoiceRequests(),
    releasePaneSkillLease: (...args) => releasePaneSkillLease(...args),
    push: (channel, ...args) => {
      if (uiSender && !uiSender.isDestroyed()) uiSender.send(channel, ...args)
    },
    phase: {
      preparePhasePane: (...args) => preparePhasePane(...args),
      advancePhase: (...args) => advancePhase(...args),
      retryOrBacklog: (...args) => retryOrBacklog(...args),
      openGatePane: (...args) => openGatePane(...args),
      finalizeTask: (...args) => finalizeTask(...args),
      openPhasePane: (...args) => openPhasePane(...args),
      closePhasePane: (...args) => closePhasePane(...args),
      terminateTaskPhasePane: (...args) => terminateTaskPhasePane(...args),
      reviewArtifactProblem: (...args) => reviewArtifactProblem(...args),
      cleanupReviewArtifact: (...args) => cleanupReviewArtifact(...args),
      readReviewArtifactChunk: (...args) => readReviewArtifactChunk(...args),
      taskIntegrationMarker: (...args) => taskIntegrationMarker(...args),
      recoverFinalizingTask: (...args) => recoverFinalizingTask(...args)
    }
  }
  // consumidores do ctx: phaseEngine (commit 3); mcpApi/ipc nos commits 4–5

  // Bypass de permissões é o PADRÃO (fluxo reto, como no overclock);
  // o toggle 🛡 religa as aprovações por projeto.
  const bypassOn = (projectId: string): boolean => !maestro.get(projectId).bypassOff
  /** Opções de validação humana: o switch "sensível ok" do projeto autoriza a
   *  DISPENSA com justificativa mesmo em plano sensível (2026-08-04). */
  const securityWaiverOptions = (
    projectId: string
  ): { sensitiveWaiverAllowed: boolean } => ({
    sensitiveWaiverAllowed: maestro.get(projectId).sensitiveAutoOk === true
  })

  /** Worktree recém-criado NÃO tem node_modules — a verificação conjunta caía
   *  em paridade de ambiente quebrado (armadilha prevista no handoff; caso
   *  real 2026-08-04: typecheck/test/lint reprovaram a M01 PRONTA e o card
   *  voltou ao dev por falta de bootstrap). Roda `npm ci` UMA vez, somente
   *  quando o manifesto pede e o lockfile existe; falha vira evento — a
   *  verificação segue e acusa com contexto, nunca em silêncio. */
  // CHECK 1 (2026-08-07): até 4 npm ci CONCORRENTES (baselines da onda + devs
  // restaurando lockfile) saturavam o disco e as congeladas da UI coincidiam
  // com essas janelas. UM bootstrap por vez — segundos de fila custam menos
  // que a máquina do dono travada.
  let verificationBootstrapChain: Promise<void> = Promise.resolve()

  function ensureVerificationBootstrap(
    cwd: string,
    ids: { projectId: string; missionId?: string; taskId?: string }
  ): Promise<void> {
    const queued = verificationBootstrapChain.then(
      () => runVerificationBootstrap(cwd, ids),
      () => runVerificationBootstrap(cwd, ids)
    )
    verificationBootstrapChain = queued.catch(() => undefined)
    return queued
  }

  async function runVerificationBootstrap(
    cwd: string,
    ids: { projectId: string; missionId?: string; taskId?: string }
  ): Promise<void> {
    try {
      if (!existsSync(join(cwd, 'package.json'))) return
      if (existsSync(join(cwd, 'node_modules'))) return
      if (!existsSync(join(cwd, 'package-lock.json'))) return
      blackbox.record({
        cat: 'verify',
        event: 'bootstrap-npm-ci',
        actor: 'harness',
        ids,
        reason: 'worktree sem node_modules — rodando npm ci antes da verificação conjunta'
      })
      await new Promise<void>((resolveBootstrap) => {
        execFile(
          'npm',
          ['ci', '--no-audit', '--no-fund'],
          {
            cwd,
            shell: true,
            windowsHide: true,
            timeout: 600_000,
            env: { ...process.env, CI: '1' }
          },
          (error) => {
            if (error) {
              blackbox.record({
                cat: 'verify',
                event: 'bootstrap-npm-ci-failed',
                actor: 'harness',
                ids,
                err: String(error).slice(0, 300)
              })
            }
            resolveBootstrap()
          }
        )
      })
    } catch {
      // bootstrap é best-effort: a verificação real dá o veredito com contexto
    }
  }

  // claude: pré-aceita no config do seat os diálogos que travariam o pane —
  // o aceite do bypassPermissions (uma vez por seat) e o "trust this folder"
  // do cwd (uma vez por seat+pasta; seats novos e worktrees caíam nele).
  function ensureBypassAccepted(configDir: string, trustCwd?: string): void {
    try {
      const file = join(configDir, '.claude.json')
      let cfg: Record<string, unknown> = {}
      if (existsSync(file)) {
        try {
          cfg = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
        } catch {
          cfg = {}
        }
      }
      let dirty = false
      if (cfg['bypassPermissionsModeAccepted'] !== true) {
        cfg['bypassPermissionsModeAccepted'] = true
        dirty = true
      }
      if (trustCwd) {
        const key = trustCwd.replace(/\\/g, '/')
        const projects = (cfg['projects'] ?? {}) as Record<string, Record<string, unknown>>
        const entry = projects[key] ?? {}
        if (entry['hasTrustDialogAccepted'] !== true) {
          entry['hasTrustDialogAccepted'] = true
          projects[key] = entry
          cfg['projects'] = projects
          dirty = true
        }
      }
      if (dirty) writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf-8')
    } catch {
      // best-effort: no pior caso o TUI pergunta uma vez
    }
  }

  // codex: pré-grava no config.toml do seat o TRUST do projeto e a escolha de
  // sandbox do Windows — sem isso o codex 0.145+ TRAVA o pane no onboarding
  // ("Do you trust…" + "Set up the Codex agent sandbox…") MESMO com
  // --dangerously-bypass-approvals-and-sandbox (bug real: ajudantes codex
  // nasciam presos no diálogo). Formato SONDADO no config.toml que o próprio
  // CLI grava: seção [projects.'<path minúsculo>'] com aspas simples, e
  // [windows] sandbox = "unelevated" (a opção não-admin). Append no fim do
  // TOML é seguro; nunca sobrescreve escolha existente.
  function ensureCodexTrust(configDir: string, projectPath: string): void {
    try {
      const file = join(configDir, 'config.toml')
      const current = existsSync(file) ? readFileSync(file, 'utf-8') : ''
      // O codex normaliza o path com lowercase SÓ de ASCII (to_ascii_lowercase
      // do Rust): "GESTÃO" vira "gestÃo", nunca "gestão". Bug real 2026-08-04:
      // a chave full-lowercase não batia em pasta acentuada e o diálogo de
      // trust aparecia MESMO com a flag de bypass (evidência: o aceite do
      // usuário fez o codex gravar a forma com "Ã" ao lado da nossa). Gravamos
      // as duas formas (divergem apenas com não-ASCII no path) com checagem
      // EXATA por forma — checagem case-insensitive não distingue as duas.
      const asciiKey = projectPath.replace(/[A-Z]/g, (c) => c.toLowerCase())
      const fullKey = projectPath.toLowerCase()
      if (asciiKey.includes("'")) return // path com aspa simples quebraria a seção TOML
      let addition = ''
      for (const key of new Set([asciiKey, fullKey])) {
        if (!current.includes(`[projects.'${key}']`) && !addition.includes(`[projects.'${key}']`)) {
          addition += `\n[projects.'${key}']\ntrust_level = "trusted"\n`
        }
      }
      if (!/^\[windows\]/m.test(current)) {
        addition += `\n[windows]\nsandbox = "unelevated"\n`
      }
      if (addition) writeFileSync(file, current + addition, 'utf-8')
    } catch {
      // best-effort: no pior caso o TUI pergunta uma vez
    }
  }

  /** Classificação allowlisted da abertura do pane. Não inclui cwd, modelo,
   *  argumentos, token, prompt ou qualquer conteúdo do terminal. */
  function paneStartupDescriptor(req: PaneRequest): PaneStartupDescriptor {
    const identity = hub.identityByPane(req.id)
    const rawArgs = req.cliArgs ?? []
    const strict =
      req.kind === 'claude'
        ? rawArgs.includes('--strict-mcp-config')
        : rawArgs.some((arg) => arg.includes('mcp_servers.playwright.command='))
    const allowsBrowser = identity?.role !== 'review'
    const allowsTestRunner =
      identity?.role !== 'review' && identity?.role !== 'qa'
    const externalMcpCount = strict
      ? Number(allowsBrowser && Boolean(externalPlaywrightForPane())) +
        Number(allowsTestRunner && Boolean(resolveProjectPlaywrightTest(req.cwd)))
      : 0
    const mode: PaneStartupDescriptor['mode'] =
      req.kind === 'shell'
        ? 'shell'
        : identity?.role === 'maestro'
          ? 'maestro'
          : strict
            ? 'estrito'
            : 'livre'
    return {
      kind: req.kind,
      ...(identity ? { role: identity.role } : {}),
      mode,
      externalMcpCount,
      hasInitialPrompt: Boolean(req.initialPrompt)
    }
  }

  /** Flags de MCP do pane (claude: arquivo de config; codex: overrides -c). */
  function mcpPaneArgs(
    cli: SeatCli,
    paneId: string,
    token: string,
    strict: boolean,
    cwd?: string,
    configDir?: string,
    accessProfile: PaneAccessProfile = 'write',
    sensitive = false
  ): string[] {
    if (mcpPort === 0) return [] // servidor ainda subindo (raro): pane nasce sem tools
    // Dev/ajudante recebem browser + runner. Gates recebem somente
    // Synkora/code_*: o Playwright MCP bruto não é uma fronteira segura.
    const external = paneExternalMcpCapabilities(accessProfile)
    const configuredBrowser = externalPlaywrightForPane()
    const browserBase = paneBrowserAvailable(accessProfile, {
      sensitive,
      sensitiveAutoOk: false,
      strict,
      mcpReady: mcpPort !== 0,
      browserConfigured: Boolean(configuredBrowser)
    })
      ? configuredBrowser
      : undefined
    // EVIDÊNCIA NUNCA NASCE GIT-VISÍVEL (caso real 2026-08-06: o output dir
    // PADRÃO do @playwright/mcp é o cwd — screenshots do QA caíram na RAIZ do
    // worktree e invalidaram o próprio veredito dele, duas rodadas): todo pane
    // com browser ganha --output-dir apontando .playwright-mcp/ (git-ignorado
    // pelo produto e coberto pela higiene do .synkora). O wrapper codex é
    // fingerprinted por args — cada cwd ganha o seu.
    const browser =
      browserBase && cwd
        ? { ...browserBase, args: [...browserBase.args, '--output-dir', join(cwd, '.playwright-mcp')] }
        : browserBase
    const testRunner =
      strict && !sensitive && external.testRunner ? resolveProjectPlaywrightTest(cwd) : undefined
    if (cli === 'claude') {
      // panes de EXECUÇÃO (strict) ganham também o Playwright MCP — browser
      // de teste que funciona em qualquer seat (Chrome ext. é por conta).
      const file = writeClaudeMcpConfig(
        join(app.getPath('userData'), 'mcp'),
        paneId,
        mcpPort,
        token,
        browser,
        testRunner
      )
      paneMcpFiles.set(paneId, file)
      return claudeMcpArgs(file, strict)
    }
    // panes codex de EXECUÇÃO (mesmo critério do claude) ganham o Playwright
    // MCP via wrapper .cmd — QA/dev/ajudante codex abrem browser de verdade
    const protocolStatus = getCodexMcpProtocolStatus(configDir)
    if (protocolStatus.state !== 'ready') void prewarmCodexMcpProtocol(configDir)
    const protocolArgs = protocolStatus.state === 'ready'
      ? codexMcpProtocolArgs(settings.get().mcpProtocolMode, {
          checkedAt: protocolStatus.checkedAt ?? 0,
          version: protocolStatus.version,
          featurePresent: protocolStatus.featurePresent,
          featureEnabled: protocolStatus.featureEnabled,
          capability: protocolStatus.capability,
          reason: protocolStatus.reason ?? 'feature-output-invalid'
        })
      : []
    const args = codexMcpArgs(
      mcpPort,
      browser ? ensurePlaywrightCmd(join(app.getPath('userData'), 'mcp'), browser) : undefined,
      testRunner ? ensurePlaywrightTestCmd(join(app.getPath('userData'), 'mcp'), testRunner) : undefined,
      protocolArgs
    )
    if (accessProfile !== 'write') {
      args.push(...codexGateMcpPolicyArgs())
      if (browser) {
        args.push('-c', 'mcp_servers.playwright.default_tools_approval_mode="approve"')
      }
      if (testRunner) {
        args.push('-c', 'mcp_servers.playwright-test.default_tools_approval_mode="approve"')
      }
    }
    return args
  }

  /** Registra um pane no hub e devolve os cliArgs de MCP + permissões dele. */
  function armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts: { strictMcp?: boolean; configDir?: string; sensitive?: boolean } = {}
  ): { paneId: string; cliArgs: string[] } {
    const paneId = identity.paneId ?? randomUUID()
    const methodGoverned = isMethodGovernedPaneRole(identity.role)
    if (cli === 'codex' && methodGoverned && !opts.configDir) {
      throw new Error('Codex method-governed pane requires an isolated config directory')
    }
    const token = randomUUID()
    hub.registerPane(token, { ...identity, paneId })
    paneTokens.set(paneId, token)
    try {
    const bypass = bypassOn(identity.projectId)
    const accessProfile = paneAccessProfile(identity.role)
    // OVERRIDE DO DONO (por projeto, decisão do usuário 2026-08-04): em domínio
    // onde TODA missão cita PII/fiscal (ex.: app de PER/DCOMP fala CPF/CNPJ em
    // qualquer goal), a classificação de superfície sensível degeneraria para
    // "sempre" e mataria a automação do projeto inteiro. Com o switch ligado,
    // o toggle de bypass volta a mandar; cada uso fica auditado na caixa-preta.
    // O padrão continua protegido (override desligado).
    const sensitiveOverride =
      opts.sensitive === true && maestro.get(identity.projectId).sensitiveAutoOk === true
    const sensitive = effectiveSensitiveAccess(opts.sensitive === true, sensitiveOverride)
    const effectiveStrictMcp = sensitive ? true : (opts.strictMcp ?? true)
    const args: string[] = []
    args.push(
      ...panePermissionArgs(cli, bypass, accessProfile, {
        sensitive,
        receiptGoverned: methodGoverned
      })
    )
    if (sensitive && accessProfile === 'write' && bypass) {
      blackbox.record({
        cat: 'pane',
        event: 'automatic-bypass-suppressed',
        actor: 'harness',
        ids: {
          paneId,
          projectId: identity.projectId,
          missionId: identity.missionId,
          taskId: identity.taskId,
          role: identity.role,
          seatId: identity.seatId
        },
        reason: 'superfície sensível detectada; o pane escritor exige autorização interativa'
      })
    }
    if (sensitiveOverride) {
      blackbox.record({
        cat: 'pane',
        event: 'sensitive-bypass-override',
        actor: 'harness',
        ids: {
          paneId,
          projectId: identity.projectId,
          missionId: identity.missionId,
          taskId: identity.taskId,
          role: identity.role,
          seatId: identity.seatId
        },
        reason:
          'superfície sensível detectada, mas o usuário liberou bypass para este projeto (switch no board)'
      })
    }
    if (cli === 'claude') {
      // aceite de bypass + trust do cwd — TODO pane claude, inclusive gates
      // read-only e sensíveis (caso real 2026-08-06: QA claude nasceu PRESO no
      // "trust this folder" do worktree do card porque este pré-trust só
      // cobria accessProfile 'write'; dev codex + QA claude no mesmo worktree
      // era o caso descoberto). O trust do ROOT do projeto vai junto, em
      // grafia UTF-8 correta — entrada mojibake antiga ("GESTÃƒO") nunca casa
      // com o path real e não conta como cobertura.
      if (opts.configDir) {
        ensureBypassAccepted(opts.configDir, identity.cwd)
        const project = projects.get(identity.projectId)
        if (project && project.path !== identity.cwd)
          ensureBypassAccepted(opts.configDir, project.path)
      }
    } else {
      // trust/sandbox pré-gravados SEMPRE (o onboarding do codex 0.145+
      // aparece mesmo com a flag de bypass); o trust vale para o ROOT do
      // repo, então cobre também os worktrees em userData.
      const project = projects.get(identity.projectId)
      if (opts.configDir && project) ensureCodexTrust(opts.configDir, project.path)
      // Gates Codex must not inherit arbitrary MCP servers from the seat's
      // persistent CODEX_HOME. The ephemeral Synkora server is appended below.
      if (opts.configDir && (methodGoverned || accessProfile !== 'write' || sensitive)) {
        const configFile = join(opts.configDir, 'config.toml')
        args.push(
          ...codexGateMcpDisableArgs(
            existsSync(configFile) ? readFileSync(configFile, 'utf-8') : ''
          )
        )
      }
    }
    args.push(
      ...mcpPaneArgs(
        cli,
        paneId,
        token,
        effectiveStrictMcp,
        identity.cwd,
        opts.configDir,
        accessProfile,
        sensitive
      )
    )
    // Caixa-preta: papel/CLI/perfil solicitados + se a config MCP saiu de
    // verdade (mcpPort 0 = pane nasce sem tools; isso precisa aparecer).
    blackbox.record({
      cat: 'mcp',
      event: 'pane-armed',
      ids: {
        projectId: identity.projectId,
        missionId: identity.missionId,
        taskId: identity.taskId,
        paneId,
        phase: identity.phase,
        role: identity.role,
        seatId: identity.seatId
      },
      detail: {
        cli,
        accessProfile,
        strictMcp: effectiveStrictMcp,
        sensitive,
        sensitiveOverridden: sensitiveOverride || undefined,
        mcpPort,
        mcpConfigured: mcpPort !== 0,
        argCount: args.length
      },
      err: mcpPort === 0 ? 'servidor MCP interno ainda não estava de pé' : undefined
    })
      return { paneId, cliArgs: args }
    } catch (error) {
      hub.unregisterPane(paneId)
      paneTokens.delete(paneId)
      cleanPaneMcpFile(paneId)
      throw error
    }
  }

  // Aceite do bypass gravado JÁ NO BOOT para todos os seats claude: processos
  // antigos do CLI (catálogo/painel) reescrevem o .claude.json ao sair e podem
  // derrubar a chave — regravar cedo e a cada spawn fecha a janela da corrida.
  for (const seat of seats.list()) {
    if (seat.cli === 'claude') ensureBypassAccepted(seats.configDirOf(seat))
    else if (settings.get().externalServicePreparation === 'automatic') {
      void prewarmCodexMcpProtocol(seats.configDirOf(seat))
    }
  }

  // Seats com login VENCIDO (detectado na saída dos panes): seatId → quando.
  // O flag limpa sozinho quando o arquivo de credencial muda (re-login feito).
  const expiredSeats = new Map<string, number>()


  // ————— CLIs sempre atualizados —————
  // O catálogo de modelos é INVALIDADO a cada mudança de versão: a lista vem
  // do handshake do binário, então modelo novo só aparece perguntando de novo.
  let lastCliVersions = ''
  let lastCodexVersion = ''
  onCliStatus((all) => {
    const versions = all.map((s) => `${s.cli}@${s.version ?? '-'}`).join(' ')
    if (versions !== lastCliVersions) {
      lastCliVersions = versions
      clearCatalogCache()
    }
    const codexVersion = all.find((item) => item.cli === 'codex')?.version ?? '-'
    if (codexVersion !== lastCodexVersion) {
      lastCodexVersion = codexVersion
      invalidateCodexMcpProtocol()
      if (settings.get().externalServicePreparation === 'automatic') {
        for (const seat of seats.list()) {
          if (seat.cli === 'codex') void prewarmCodexMcpProtocol(seats.configDirOf(seat))
        }
      }
    }
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('cli:status', all)
  })


  // `missing` é COMPUTADO na listagem (nunca persistido): pasta renomeada ou
  // movida fora do app → a UI mostra o estado quebrado e oferece relocação.
  ipcMain.handle('projects:list', () =>
    projects.list().map((p) => {
      const exists = existsSync(p.path)
      // Projeto legado ainda sem classificação não deve ser carimbado como
      // existente só porque a pasta está temporariamente ausente.
      const mode = p.mode ?? (exists ? projectModeOf(p.id) : undefined)
      return {
        ...p,
        ...(mode ? { mode } : {}),
        missing: !exists,
        ...(mode === 'greenfield' ? { planStatus: projectPlanOf(p.id)?.status } : {})
      }
    })
  )
  ipcMain.handle('projects:create', (_e, name: string, path: string) => {
    // GUARDA DE PATH (CHECK 12, 2026-08-07): um path RELATIVO/amassado vira
    // pasta fantasma no cwd do app (caso real: o driver E2E perdeu as barras
    // no escape e "C:\Users\Erick\.synkora-e2e\p1" materializou como
    // "UsersErick.synkora-e2ep1" DENTRO do repo do Synkora, com scaffold
    // completo). Projeto só nasce de path absoluto e nunca dentro do
    // diretório do próprio app.
    if (!isAbsolute(path)) {
      throw new Error(
        `caminho inválido (não é absoluto): "${path.slice(0, 120)}" — provavelmente perdeu as barras no transporte (escape); use forward slashes`
      )
    }
    const appRoot = app.getAppPath().replace(/\\/g, '/').toLowerCase()
    if (path.replace(/\\/g, '/').toLowerCase().startsWith(appRoot)) {
      throw new Error('caminho recusado: a pasta cairia dentro do diretório do próprio Synkora')
    }
    // A classificação acontece ANTES de qualquer injeção de skills, que cria
    // .agents/.claude e faria uma pasta vazia parecer um projeto existente.
    const mode =
      hasProjectPlanArtifacts(path) || isEffectivelyEmptyProject(path)
        ? 'greenfield'
        : 'existing'
    const project = projects.create(name, path, mode)
    if (mode === 'greenfield') {
      try {
        ensureSynkoraGitExcludes(path)
        ensureGreenfieldProjectPlan(path, { projectName: name })
        ensureProjectSecurityBaseline(path, {
          installRepositoryAdapters: true,
          projectName: name
        })
      } catch (error) {
        // O cadastro continua disponível, mas o primeiro pane fica bloqueado
        // até a política local poder ser materializada.
        hub.publish({
          projectId: project.id,
          kind: 'error',
          text: `projeto cadastrado, mas a política local de segurança não pôde ser preparada: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
          actor: 'harness',
          urgent: true
        })
      }
    }
    if (mode === 'existing') {
      try {
        ensureSynkoraGitExcludes(path)
        ensureProjectSecurityBaseline(path, {
          installRepositoryAdapters: false,
          projectName: name
        })
      } catch {
        // Projetos existentes continuam sob a política de sistema; nenhum
        // arquivo do repositório é alterado para forçar uma migração.
      }
    }
    scheduleProgressSnapshot()
    return project
  })
  ipcMain.handle('projects:remove', (_e, id: string) => {
    projects.remove(id)
    scheduleProgressSnapshot()
  })
  ipcMain.handle('projects:rename', (_e, id: string, name: string) => {
    const updated = name.trim() ? (projects.rename(id, name.trim()) ?? null) : null
    if (updated) scheduleProgressSnapshot()
    return updated
  })

  // Foto do projeto (rail estilo Discord): picker → nativeImage 128px →
  // data URL persistida no projects.json (alguns KB, sem protocolo custom).
  ipcMain.handle('projects:setPhoto', async (_e, id: string) => {
    const result = await dialog.showOpenDialog({
      title: 'Foto do projeto',
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return projects.get(id) ?? null
    const img = nativeImage.createFromPath(result.filePaths[0])
    if (img.isEmpty()) return projects.get(id) ?? null
    // resize pode falhar/vir vazio em alguns formatos — NUNCA gravar dataURL
    // quebrada (a UI inteira mostrava imagem quebrada)
    let resized = img.resize({ width: 128, height: 128 })
    if (resized.isEmpty()) resized = img
    const dataUrl = resized.toDataURL()
    if (!dataUrl.startsWith('data:image') || dataUrl.length < 100) return projects.get(id) ?? null
    const updated = projects.setPhoto(id, dataUrl) ?? null
    if (updated) scheduleProgressSnapshot()
    return updated
  })
  ipcMain.handle('projects:removePhoto', (_e, id: string) => {
    const updated = projects.setPhoto(id, null) ?? null
    if (updated) scheduleProgressSnapshot()
    return updated
  })

  // RELOCAÇÃO: a pasta foi renomeada/movida fora do app. O id (e todo estado
  // chaveado por ele — tarefas, missões, backlog, políticas, maestro) fica;
  // só o caminho muda. Cascata: mata o que roda no cwd velho, conserta os
  // ponteiros de worktree do git e migra as sessões claude (o JSONL da
  // conversa vive em <configDir>/projects/<slug-do-cwd> — sem migrar, o
  // --resume do pane do Maestro não acha a conversa).
  ipcMain.handle('projects:relocate', async (e, id: string) => {
    bindUiSender(e.sender)
    const project = projects.get(id)
    if (!project) return { ok: false, error: 'projeto não encontrado' }
    const result = await dialog.showOpenDialog({
      title: `Nova pasta de "${project.name}"`,
      properties: ['openDirectory'],
      ...(existsSync(project.path) ? { defaultPath: project.path } : {})
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'cancelado' }
    const newPath = result.filePaths[0]
    const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    const clash = projects.list().find((p) => p.id !== id && norm(p.path) === norm(newPath))
    if (clash) return { ok: false, error: `essa pasta já é o universo "${clash.name}"` }
    const oldPath = project.path
    // 1. derruba tudo que roda no projeto (panes no cwd velho ficariam zumbis)
    killMaestroSession(id)
    for (const pane of hub.panesOf(id)) {
      if (ptys.has(pane.paneId)) ptys.kill(pane.paneId)
      if (uiSender && !uiSender.isDestroyed()) uiSender.send('panes:closeById', id, pane.paneId)
    }
    for (const [tid, watch] of phaseWatches) {
      if (watch.projectId === id) {
        phaseWatches.delete(tid)
        if (watch.paneId && !ptys.has(watch.paneId)) discardUnstartedPane(watch.paneId)
      }
    }
    // 2. caminho novo no store (única fonte de verdade do path)
    codeIntelligence?.invalidateWorktreeNow(oldPath)
    projects.setPath(id, newPath)
    // 3. git: o .git dos worktrees (userData/worktrees) aponta p/ o repo no
    // caminho antigo — repair rodado do caminho novo reescreve os ponteiros
    if (hasGitCommit(newPath)) repairWorktrees(newPath)
    // 4. sessões claude: copia o dir de conversas do slug antigo p/ o novo em
    // todos os seats + trust do cwd novo (senão o TUI trava no "trust folder")
    const slugOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
    const migratedBySeat = new Map<string, boolean>()
    for (const seat of seats.list()) {
      if (seat.cli !== 'claude') continue
      const configDir = seats.configDirOf(seat)
      try {
        const src = join(configDir, 'projects', slugOf(oldPath))
        const dst = join(configDir, 'projects', slugOf(newPath))
        if (existsSync(src) && !existsSync(dst)) cpSync(src, dst, { recursive: true })
        migratedBySeat.set(seat.id, existsSync(dst))
      } catch {
        migratedBySeat.set(seat.id, false)
      }
      ensureBypassAccepted(configDir, newPath)
    }
    // Sessão do PM presa ao slug antigo e sem migração → reset (um --resume
    // que não resolve travaria o pane). Seat codex retoma por thread id,
    // independente de cwd — nada a resetar. Orquestradores de missão rodam
    // no worktree (userData, não se moveu) — intocados.
    const pmSeatId = maestro.get(id).seatId
    const pmSeat = pmSeatId ? seats.get(pmSeatId) : undefined
    if (pmSeat?.cli === 'claude' && !migratedBySeat.get(pmSeat.id)) {
      maestro.update(id, { sessionId: undefined, tuiSessionId: undefined, personaSent: false })
    }
    // BOARD.md renasce já na pasta nova
    syncBoard(id)
    hub.publish({
      projectId: id,
      actor: 'app',
      kind: 'info',
      text: `pasta do projeto relocada: ${oldPath} → ${newPath}`,
      quiet: true
    })
    scheduleProgressSnapshot()
    return { ok: true, project: { ...projects.get(id)!, missing: false } }
  })


  ipcMain.handle('tasks:list', (_e, projectId: string) => tasks.list(projectId))
  ipcMain.handle('tasks:create', (_e, projectId: string, item: NewTask) => {
    if (item.missionId) {
      hub.publish({
        projectId,
        missionId: item.missionId,
        kind: 'error',
        text:
          'card manual bloqueado: dentro de uma missão, o orquestrador propõe o plano e cria os cards somente depois da sua aprovação',
        actor: 'harness'
      })
      return []
    }
    const masterPlan = projectPlanOf(projectId)
    if (
      !item.missionId &&
      projectModeOf(projectId) === 'greenfield' &&
      masterPlan?.status !== 'done'
    ) {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          'tarefa avulsa bloqueada: este projeto novo ainda segue o plano mestre — volte ao Maestro e siga a próxima missão indicada',
        actor: 'harness'
      })
      return []
    }
    const manualDeliverable = item.deliverable ?? 'code'
    const manualAffectsUi =
      item.affectsUi ??
      (manualDeliverable === 'code'
        ? ['front', 'design'].includes(item.department) ||
          classifyTaskUiWork({
            department: item.department,
            title: item.title,
            description: item.description,
            briefing: item.briefing,
            quests: item.quests
          })
        : false)
    const created = tasks.createMany(projectId, [
      {
        ...item,
        // Quick-add nao tem briefing suficiente para uma classificacao
        // confiavel. Em front/design, o fallback seguro e ativar o contrato;
        // nas demais lanes, sinais renderizados inequívocos também o ativam.
        // Cards orquestrados sempre declaram o booleano explicitamente.
        affectsUi: manualAffectsUi,
        deliverable: manualDeliverable,
        gates: gatesForTask(
          'standard',
          'low',
          manualDeliverable,
          item.gates,
          manualAffectsUi === true
        ),
        version: item.version ?? maestro.get(projectId).version
      }
    ])
    hub.publish({
      projectId,
      kind: 'task-created',
      text: `tarefa manual: "${item.title}" [${item.department}]`,
      actor: 'user'
    })
    syncBoard(projectId)
    return created
  })
  ipcMain.handle('tasks:update', (_e, id: string, patch: unknown) => {
    const before = tasks.get(id)
    // F5.7: card de PLANO e cards AUTO (geridos pelo orquestrador) são
    // read-only para o renderer — aprovar/pausar o plano tem IPC próprio e
    // quem move card auto é o pipeline/orquestrador.
    if (before && (before.kind === 'plan' || before.auto)) return before
    if (!before) return undefined
    const hasActivePane =
      phaseWatches.has(id) ||
      hub
        .panesOf(before.projectId)
        .some(
          (pane) =>
            pane.taskId === id &&
            (pane.role === 'dev' ||
              pane.role === 'review' ||
              pane.role === 'qa' ||
              pane.role === 'ajudante')
        )
    const sanitized = sanitizeRendererTaskPatch(patch, { hasActivePane })
    if (!sanitized.ok) {
      blackbox.record({
        cat: 'task',
        event: 'renderer-task-update-refused',
        actor: 'harness',
        ids: { projectId: before.projectId, missionId: before.missionId, taskId: id },
        reason: sanitized.reason
      })
      return before
    }
    const updated = tasks.update(id, sanitized.patch)
    if (updated) {
      if (sanitized.patch.status && sanitized.patch.status !== before.status) {
        hub.publish({
          projectId: updated.projectId,
          missionId: updated.missionId,
          kind: 'task-updated',
          text: `"${updated.title}" movida para ${sanitized.patch.status}`,
          actor: 'user'
        })
      }
      syncBoard(updated.projectId)
    }
    return updated
  })

  /** Remove a tarefa e TODO o rastro dela: watch, panes das fases, transcript,
   *  marcadores e worktree/branch (best-effort). Compartilhado entre o IPC
   *  tasks:remove e a tool MCP delete_task do orquestrador (F5.7). */
  function removeTaskCascade(task: Task): boolean {
    const project = projects.get(task.projectId)
    if (project) {
      try {
        ensureSynkoraGitExcludes(project.path)
      } catch {
        return false
      }
    }
    const activeWatchToRemove = phaseWatches.get(task.id)
    const terminatedPaneIds = new Set<string>()
    const liveWaitToRemove = liveGateWaits.get(task.id)
    if (liveWaitToRemove) terminatedPaneIds.add(liveWaitToRemove.paneId)
    closeLiveGateWait(task.projectId, task.id, 'tarefa removida')
    for (const pane of hub
      .panesOf(task.projectId)
      .filter((candidate) => candidate.taskId === task.id)) {
      terminatedPaneIds.add(pane.paneId)
      if (pane.role === 'ajudante') {
        helperCompletions.discard(pane.paneId)
        updateStoredHelperStatus(task.projectId, pane.paneId, 'interrupted')
        terminatePaneNow(task.projectId, pane.paneId)
      }
    }
    phaseWatches.delete(task.id)
    for (const role of ['dev', 'review', 'qa'] as const) {
      terminateTaskPhasePane(task.projectId, task.id, role)
    }
    if (activeWatchToRemove?.paneId && !terminatedPaneIds.has(activeWatchToRemove.paneId)) {
      terminatePaneNow(task.projectId, activeWatchToRemove.paneId)
    }
    // Só apaga o card depois que nenhum processo consegue mais escrever no
    // worktree ou reportar contra o estado removido.
    tasks.remove(task.id)
    // Depois do estado, remove transcript, marcadores e worktree.
    if (project) {
      const runsDir = join(project.path, '.synkora', 'runs')
      for (const f of [
        `${task.id}.md`,
        `${task.id}.done`,
        `${task.id}.review.verdict`,
        `${task.id}.qa.verdict`
      ]) {
        try {
          unlinkSync(join(runsDir, f))
        } catch {
          // nunca existiu
        }
      }
      if (hasGitCommit(project.path)) {
        const taskWorktree = join(
          app.getPath('userData'),
          'worktrees',
          task.projectId,
          task.id.slice(0, 8)
        )
        codeIntelligence?.invalidateWorktreeNow(taskWorktree)
        removeWorktreeAndBranch(
          project.path,
          taskWorktree,
          `task/${task.id.slice(0, 8)}`
        )
      }
    }
    return true
  }

  ipcMain.handle('tasks:remove', (e, id: string) => {
    bindUiSender(e.sender)
    const task = tasks.get(id)
    if (!task) return
    // F5.7: card AUTO é do orquestrador (delete_task); plano em execução
    // precisa ser pausado antes de sair do board.
    if (task.auto || (task.kind === 'plan' && task.status === 'execucao')) return
    if (!removeTaskCascade(task)) return
    hub.publish({
      projectId: task.projectId,
      missionId: task.missionId,
      kind: 'task-updated',
      text: `${task.kind === 'plan' ? 'card de PLANO' : 'tarefa'} "${task.title}" EXCLUÍDA pelo usuário`,
      actor: 'user'
    })
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', task.projectId)
    syncBoard(task.projectId)
  })

  // ————— F5.7: missão dirigida por PLANO —————
  // O orquestrador propõe UM card de plano (tool create_plan); o usuário lê no
  // board, pode ajustar seat/modelo/effort por lane e aprova aqui. Aprovado,
  // a missão é 100% do orquestrador (cards auto + run_task) até o
  // conclude_plan pousar a conclusão no card. Pausar devolve o plano ao
  // backlog e corta novos runs (os já abertos terminam a fase).

  function fmtLane(l: PlanLane): string {
    const seatName = l.seatId ? (seats.get(l.seatId)?.name ?? l.seatId) : 'política do dept'
    return `${l.dept} → ${seatName}${l.model ? ` · ${l.model}` : ''}${l.effort ? ` · ${l.effort}` : ''}`
  }

  /** Plano corrente da missão: o não-concluído mais recente, senão o último. */
  function currentPlanOf(projectId: string, missionId: string): Task | undefined {
    const plans = tasks
      .list(projectId)
      .filter((t) => t.missionId === missionId && t.kind === 'plan')
    return [...plans].reverse().find((t) => t.status !== 'done') ?? plans.at(-1)
  }

  function planTaskForWorkTask(task: Task): Task | undefined {
    if (task.planId) {
      const exact = tasks.get(task.planId)
      if (exact?.kind === 'plan') return exact
    }
    return task.missionId ? currentPlanOf(task.projectId, task.missionId) : undefined
  }

  function executionModeForTask(task: Task): MissionExecutionMode {
    if (task.adjustment) return 'fast'
    return normalizeExecutionMode(planTaskForWorkTask(task)?.plan?.executionMode)
  }

  function retryLimitForTask(task: Task): number {
    return retryLimitForExecutionMode(executionModeForTask(task))
  }

  const baselineVerificationRuns = new Map<string, Promise<PlanVerificationCheckpoint>>()
  const finalVerificationRuns = new Map<string, Promise<void>>()

  function updatePlanVerification(
    planId: string,
    stage: 'baseline' | 'final',
    checkpoint: PlanVerificationCheckpoint
  ): Task | undefined {
    const current = tasks.get(planId)
    if (!current?.plan) return undefined
    return tasks.update(planId, {
      plan: {
        ...current.plan,
        verification: {
          ...(current.plan.verification ?? {}),
          [stage]: checkpoint
        }
      }
    })
  }

  function verificationWorkspace(planTask: Task): {
    mission: Mission
    cwd: string
    head?: string
  } | undefined {
    const mission = planTask.missionId ? missions.get(planTask.missionId) : undefined
    const project = projects.get(planTask.projectId)
    if (!mission || !project) return undefined
    const cwd = missionWorkspacePath(project.path, mission)
    if (!cwd) return undefined
    return { mission, cwd, head: gitHead(cwd) }
  }

  /**
   * Junta os checks normais do projeto aos módulos opcionais que ele próprio
   * declarou. Scripts declarados de publish/deploy/release e seus hooks são
   * recusados; só validadores locais da allowlist conservadora consomem uma
   * parcela pequena do orçamento.
   */
  function planVerificationProfile(planTask: Task, cwd: string): {
    adapters: ProjectAdapterDetection[]
    commands: ReturnType<typeof detectVerificationCommands>
  } {
    const mode = normalizeExecutionMode(planTask.plan?.executionMode)
    const risk = normalizeRiskLevel(planTask.plan?.risk)
    const budget = verificationBudget(mode, risk)
    const adapters = detectProjectAdapters({ root: cwd })
    const core = detectVerificationCommands({ root: cwd, mode, risk })
    const maxAdapterCommands = Math.min(
      mode === 'deep' ? 2 : 1,
      Math.max(0, budget.maxCommands - (core.length > 0 ? 1 : 0))
    )
    const optional = selectProjectAdapterCommands({
      detections: adapters,
      mode,
      risk,
      riskSurfaces: planTask.plan?.riskSurfaces ?? [],
      missionText: `${planTask.title}\n${planTask.plan?.summary ?? ''}`,
      maxCommands: maxAdapterCommands
    }).map((command) => {
      const normalized = {
        id: command.id,
        kind: 'check' as const,
        label: command.label,
        command: command.command,
        args: command.args,
        cwd: command.cwd,
        source: `adaptador ${command.id.split(':')[1] ?? 'do projeto'} · ${command.sourcePath}`,
        timeoutMs: Math.min(command.timeoutMs, budget.perCommandTimeoutMs)
      }
      return {
        ...normalized,
        definitionHash: verificationCommandDefinitionHash(normalized)
      }
    })
    const invocationKey = (command: { command: string; args: string[]; cwd: string }): string =>
      `${command.command}\0${command.args.join('\0')}\0${command.cwd}`
    const optionalKeys = new Set(optional.map(invocationKey))
    const coreWithoutDuplicates = core.filter((command) => !optionalKeys.has(invocationKey(command)))
    const coreSlots = Math.max(0, budget.maxCommands - optional.length)
    return {
      adapters,
      commands: [...coreWithoutDuplicates.slice(0, coreSlots), ...optional].slice(
        0,
        budget.maxCommands
      )
    }
  }

  function baselineVerificationUsable(
    checkpoint: PlanVerificationCheckpoint | undefined
  ): boolean {
    if (!checkpoint || checkpoint.lastError || !checkpoint.result) return false
    return (
      checkpoint.result.status === 'passed' ||
      checkpoint.result.status === 'failed' ||
      checkpoint.result.status === 'not_required'
    )
  }

  function verificationCommandIdentity(
    command: Pick<
      VerificationCommand,
      'id' | 'command' | 'args' | 'cwd' | 'blockedReason' | 'definitionHash'
    >
  ): string {
    const cwd = resolve(command.cwd)
    return `${command.id}\0${command.command}\0${command.args.join('\0')}\0${process.platform === 'win32' ? cwd.toLowerCase() : cwd}\0${command.blockedReason ?? 'not-blocked'}\0${command.definitionHash ?? 'definition-missing'}`
  }

  /** Lista ampla usada só para REVALIDAR comandos persistidos. A execução
   * continua limitada pelo perfil; aqui precisamos saber se um check antigo
   * ainda existe e continua seguro antes de chamá-lo pelo mesmo nome. */
  function currentVerificationCommandAllowlist(planTask: Task, cwd: string): Set<string> {
    const mode = normalizeExecutionMode(planTask.plan?.executionMode)
    const risk = normalizeRiskLevel(planTask.plan?.risk)
    const core = detectVerificationCommands({
      root: cwd,
      mode,
      risk,
      maxCommands: 100
    })
    const adapterCommands = detectProjectAdapters({ root: cwd })
      .filter((adapter) => adapter.state === 'active')
      .flatMap((adapter) => adapter.verificationCommands)
    return new Set(
      [...core, ...adapterCommands].map((command) =>
        verificationCommandIdentity({
          ...command,
          definitionHash:
            'definitionHash' in command && typeof command.definitionHash === 'string'
              ? command.definitionHash
              : verificationCommandDefinitionHash(command)
        })
      )
    )
  }

  async function ensurePlanBaseline(planTask: Task): Promise<PlanVerificationCheckpoint> {
    const latest = tasks.get(planTask.id) ?? planTask
    const stored = latest.plan?.verification?.baseline
    if (baselineVerificationUsable(stored)) return stored as PlanVerificationCheckpoint
    const inFlight = baselineVerificationRuns.get(planTask.id)
    if (inFlight) return inFlight

    const run = (async (): Promise<PlanVerificationCheckpoint> => {
      const current = tasks.get(planTask.id) ?? planTask
      const workspace = verificationWorkspace(current)
      const mode = normalizeExecutionMode(current.plan?.executionMode)
      const risk = normalizeRiskLevel(current.plan?.risk)
      if (!workspace) {
        const now = new Date().toISOString()
        const checkpoint: PlanVerificationCheckpoint = {
          status: 'unavailable',
          commands: [],
          startedAt: now,
          finishedAt: now,
          lastError: 'workspace da missão indisponível para a fotografia inicial'
        }
        updatePlanVerification(planTask.id, 'baseline', checkpoint)
        return checkpoint
      }
      const cleanBefore = isWorktreeClean(workspace.cwd)
      if (!workspace.head || cleanBefore === undefined) {
        const now = new Date().toISOString()
        const checkpoint: PlanVerificationCheckpoint = {
          status: 'unavailable',
          commands: [],
          startedAt: now,
          finishedAt: now,
          lastError:
            'o fluxo de missão verificável exige um repositório Git válido; inicialize/repare o Git do projeto antes de executar cards'
        }
        updatePlanVerification(planTask.id, 'baseline', checkpoint)
        return checkpoint
      }
      if (!cleanBefore) {
        const now = new Date().toISOString()
        const checkpoint: PlanVerificationCheckpoint = {
          status: 'unavailable',
          head: workspace.head,
          commands: [],
          startedAt: now,
          finishedAt: now,
          lastError:
            'a branch da missão já estava suja antes da fotografia inicial; preserve o conteúdo e enquadre-o antes de iniciar um card'
        }
        updatePlanVerification(planTask.id, 'baseline', checkpoint)
        return checkpoint
      }
      const profile = planVerificationProfile(current, workspace.cwd)
      // Baseline ainda não utilizável nunca é um contrato: após timeout,
      // ferramenta ausente, crash ou erro interno, redetectamos a configuração
      // atual em vez de repetir cegamente um comando antigo/alterado.
      const commands = profile.commands
      const adapters = profile.adapters
      const startedAt = new Date().toISOString()
      const running: PlanVerificationCheckpoint = {
        status: 'running',
        head: workspace.head,
        commands,
        adapters,
        startedAt,
        interruptedAt: stored?.status === 'running'
          ? recoverInterruptedVerification(stored).interruptedAt
          : stored?.interruptedAt
      }
      updatePlanVerification(planTask.id, 'baseline', running)
      const budget = verificationBudget(mode, risk)
      try {
        await ensureVerificationBootstrap(workspace.cwd, {
          projectId: planTask.projectId,
          missionId: planTask.missionId,
          taskId: planTask.id
        })
        const result = await runVerificationCommands(commands, {
          totalTimeoutMs: budget.totalTimeoutMs,
          maxOutputChars: budget.maxOutputChars,
          env: { CI: '1', NODE_ENV: 'test' }
        })
        const headAfter = gitHead(workspace.cwd)
        const cleanAfter = isWorktreeClean(workspace.cwd)
        const changedByBaseline =
          Boolean(workspace.head && headAfter && workspace.head !== headAfter) || cleanAfter !== true
        const checkpoint: PlanVerificationCheckpoint = {
          status: result.status,
          head: workspace.head,
          commands,
          adapters,
          result,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          ...(changedByBaseline
            ? {
                lastError:
                  'a verificação inicial alterou arquivos visíveis ao Git; o conteúdo foi preservado e a execução será bloqueada até a árvore voltar a ficar limpa'
              }
            : {})
        }
        updatePlanVerification(planTask.id, 'baseline', checkpoint)
        blackbox.record({
          cat: 'verify',
          event: 'plan-verification-baseline',
          ids: { projectId: planTask.projectId, missionId: planTask.missionId, taskId: planTask.id },
          actor: 'harness',
          reason: `fotografia inicial: ${result.status}`,
          detail: { commands: result.results.map((r) => `${r.label}:${r.status}`) }
        })
        hub.publish({
          projectId: planTask.projectId,
          missionId: planTask.missionId,
          kind: changedByBaseline ? 'error' : 'info',
          text: changedByBaseline
            ? 'a fotografia inicial deixou alterações no projeto; nenhum card deve iniciar até o orquestrador inspecionar e restaurar uma base limpa'
            : result.status === 'passed'
              ? `fotografia inicial verde (${commands.map((command) => command.label).join(' · ') || 'sem comando necessário'})`
              : `fotografia inicial registrada como ${result.status}; o final será comparado com esse estado`,
          actor: 'harness',
          quiet: !changedByBaseline
        })
        return checkpoint
      } catch (error) {
        const now = new Date().toISOString()
        const checkpoint: PlanVerificationCheckpoint = {
          status: 'unavailable',
          head: workspace.head,
          commands,
          adapters,
          startedAt,
          finishedAt: now,
          lastError: error instanceof Error ? error.message : String(error)
        }
        updatePlanVerification(planTask.id, 'baseline', checkpoint)
        return checkpoint
      }
    })().finally(() => baselineVerificationRuns.delete(planTask.id))
    baselineVerificationRuns.set(planTask.id, run)
    return run
  }

  function finalVerificationAccepted(checkpoint: PlanVerificationCheckpoint | undefined): boolean {
    return (
      checkpoint?.comparison?.status === 'passed' ||
      checkpoint?.comparison?.status === 'passed_with_baseline_failures' ||
      checkpoint?.comparison?.status === 'not_required'
    )
  }

  function closeVerifiedPlan(planId: string): void {
    const planTask = tasks.get(planId)
    if (!planTask?.plan || planTask.status !== 'execucao' || !planTask.missionId) return
    if (manualSecurityValidationPending(planTask.plan, securityWaiverOptions(planTask.projectId))) return
    const final = planTask.plan.verification?.final
    const workspace = verificationWorkspace(planTask)
    const planCards = tasks
      .list(planTask.projectId)
      .filter(
        (task) =>
          task.missionId === planTask.missionId &&
          task.kind !== 'plan' &&
          (task.planId === planTask.id || (!task.planId && !planTask.plan?.executionMode))
      )
    const reopened = planCards.filter((task) => task.status !== 'done')
    if (final && reopened.length > 0) {
      updatePlanVerification(planTask.id, 'final', {
        ...final,
        comparison: {
          status: 'blocked',
          items: [
            ...(final.comparison?.items ?? []),
            {
              commandId: 'synkora:cards-still-closed',
              label: 'estado dos cards durante a verificação final',
              verdict: 'blocked',
              detail: `${reopened.length} card(s) foram reabertos antes do fechamento do plano`
            }
          ]
        },
        lastError: 'um card foi reaberto enquanto a verificação conjunta estava em andamento'
      })
      hub.publish({
        projectId: planTask.projectId,
        missionId: planTask.missionId,
        kind: 'error',
        text: 'a verificação conjunta terminou, mas o plano não fechou porque um card foi reaberto durante a execução',
        actor: 'harness',
        urgent: true
      })
      if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', planTask.projectId)
      syncBoard(planTask.projectId)
      return
    }
    if (
      !workspace ||
      !finalVerificationAccepted(final) ||
      !final?.pendingConclusion ||
      !final.head ||
      gitHead(workspace.cwd) !== final.head ||
      isWorktreeClean(workspace.cwd) !== true
    ) return
    const mission = workspace.mission
    const queueTicket = integrationQueue.getByMission(mission.id)
    const resumesAuthorizedQueue =
      queueTicket?.state === 'sync_required' &&
      (!queueTicket.planId || queueTicket.planId === planTask.id)
    tasks.update(planTask.id, {
      status: 'done',
      plan: {
        ...planTask.plan,
        conclusion: final.pendingConclusion,
        executionHead: final.head
      }
    })
    // Paridade de ambiente quebrado ("a mesma falha já existia na base") NÃO
    // é evidência de teste — a mensagem antiga dizia só "CONCLUÍDOS" e o
    // usuário lia como suíte verde (caso real 02/08: npm nem subia no
    // worktree e a missão fechou com cara de testada).
    const degraded = final.comparison?.status === 'passed_with_baseline_failures'
    const degradedNote = degraded
      ? ' · ATENÇÃO: a verificação passou por PARIDADE (as falhas de comando já existiam na base — ex.: ambiente sem dependências); NENHUM teste rodou de verdade'
      : ''
    blackbox.record({
      cat: 'verify',
      event: 'plan-verification-final',
      ids: { projectId: planTask.projectId, missionId: planTask.missionId, taskId: planTask.id },
      actor: 'harness',
      reason: degraded ? 'aceita por paridade de falhas pré-existentes' : 'aprovada com comandos verdes',
      detail: {
        comparison: final.comparison?.status,
        commands: (final.result?.results ?? []).map((r) => `${r.label}:${r.status}`)
      }
    })
    hub.publish({
      projectId: planTask.projectId,
      kind: 'report',
      text:
        (resumesAuthorizedQueue
          ? `missão "${mission.title}": sincronização e verificação conjunta APROVADAS — retomando automaticamente a posição #${queueTicket.position} com o aval original`
          : `missão "${mission.title}": plano e verificação conjunta CONCLUÍDOS — a integração aguarda o aval do usuário`) + degradedNote,
      actor: 'orchestrator',
      urgent: true
    })
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', planTask.projectId)
    syncBoard(planTask.projectId)
    if (resumesAuthorizedQueue) startMissionIntegration(mission.id, 'orquestrador · retomada autorizada')
  }

  function startFinalPlanVerification(planTask: Task, conclusion: string): void {
    if (finalVerificationRuns.has(planTask.id)) return
    const run = (async (): Promise<void> => {
      const current = tasks.get(planTask.id) ?? planTask
      const workspace = verificationWorkspace(current)
      if (!current.plan) return
      if (!workspace) {
        const now = new Date().toISOString()
        const detail =
          'o worktree isolado da missão não pôde ser provado na retomada da verificação conjunta'
        updatePlanVerification(current.id, 'final', {
          status: 'unavailable',
          commands: [],
          startedAt: now,
          finishedAt: now,
          pendingConclusion: conclusion,
          comparison: {
            status: 'blocked',
            items: [
              {
                commandId: 'synkora:mission-workspace',
                label: 'worktree isolado da missão',
                verdict: 'blocked',
                detail
              }
            ]
          },
          lastError: detail
        })
        hub.publish({
          projectId: current.projectId,
          missionId: current.missionId,
          kind: 'error',
          text: `verificação conjunta BLOQUEADA: ${detail}. Nenhum comando foi executado na branch principal.`,
          actor: 'harness',
          urgent: true
        })
        if (uiSender && !uiSender.isDestroyed())
          uiSender.send('tasks:changed', current.projectId)
        syncBoard(current.projectId)
        return
      }
      const mode = normalizeExecutionMode(current.plan.executionMode)
      const risk = normalizeRiskLevel(current.plan.risk)
      const baseline = await ensurePlanBaseline(current)
      const profile = planVerificationProfile(current, workspace.cwd)
      const budget = verificationBudget(mode, risk)
      const currentAllowlist = currentVerificationCommandAllowlist(current, workspace.cwd)
      const invalidBaselineCommands = baseline.commands.filter(
        (command) =>
          !currentAllowlist.has(
            verificationCommandIdentity({ ...command, cwd: workspace.cwd })
          )
      )
      const baselineCommands = baseline.commands
        .filter((command) => !invalidBaselineCommands.includes(command))
        .map((command) => ({
          ...command,
          cwd: workspace.cwd
        }))
      const baselineIds = new Set(baselineCommands.map((command) => command.id))
      const baselineInvocations = new Set(
        baselineCommands.map(
          (command) => `${command.command}\0${command.args.join('\0')}\0${command.cwd}`
        )
      )
      const extraSlots = Math.max(0, budget.maxCommands - baselineCommands.length)
      const newCommands = profile.commands
        .filter(
          (command) =>
            !baselineIds.has(command.id) &&
            !baselineInvocations.has(
              `${command.command}\0${command.args.join('\0')}\0${command.cwd}`
            )
        )
        .slice(0, extraSlots)
      // O baseline é contrato: apagar/renomear um teste durante a missão não
      // pode fazer a fotografia final ficar vazia e parecer "não necessária".
      const commands = [...baselineCommands, ...newCommands]
      const adapters = profile.adapters
      const head = gitHead(workspace.cwd)
      const startedAt = new Date().toISOString()
      if (!baselineVerificationUsable(baseline)) {
        const detail = baseline.lastError || `baseline ${baseline.status}`
        updatePlanVerification(current.id, 'final', {
          status: 'unavailable',
          head,
          commands,
          adapters,
          startedAt,
          finishedAt: new Date().toISOString(),
          pendingConclusion: conclusion,
          comparison: {
            status: 'blocked',
            items: [
              {
                commandId: 'synkora:baseline-required',
                label: 'fotografia inicial da missão',
                verdict: 'blocked',
                detail
              }
            ]
          },
          lastError: detail
        })
        hub.publish({
          projectId: current.projectId,
          missionId: current.missionId,
          kind: 'error',
          text: `verificação conjunta BLOQUEADA: a fotografia inicial não ficou válida (${detail})`,
          actor: 'harness',
          urgent: true
        })
        if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', current.projectId)
        syncBoard(current.projectId)
        return
      }
      // MODO LEVE aceita comando REDEFINIDO pela própria entrega (caso real
      // 2026-08-04, M02b: a missão trocou o script test de Electron+SQLite
      // para vitest puro — mudança legítima, revisada em 4 rodadas de gate —
      // e a conclusão travou em loop de escalação sem caminho sancionado):
      // a redefinição roda na definição ATUAL (redetectada e DENTRO da
      // allowlist segura) e o resultado exige verde absoluto; o evento fica
      // auditado. Modo estrito preserva o bloqueio integral.
      if (invalidBaselineCommands.length > 0) {
        const redefined = securityWaiverOptions(current.projectId).sensitiveWaiverAllowed
          ? invalidBaselineCommands
              .map((invalid) => profile.commands.find((c) => c.id === invalid.id))
              .filter((c): c is (typeof profile.commands)[number] => Boolean(c))
          : []
        if (redefined.length === invalidBaselineCommands.length && redefined.length > 0) {
          for (const command of redefined) {
            if (!commands.some((existing) => existing.id === command.id)) commands.push(command)
          }
          blackbox.record({
            cat: 'verify',
            event: 'verification-command-redefined-accepted',
            actor: 'harness',
            ids: {
              projectId: current.projectId,
              missionId: current.missionId,
              taskId: current.id
            },
            reason: `modo leve: definição de comando alterada pela missão aceita com verde absoluto — ${invalidBaselineCommands.map((c) => c.label).join(' · ')}`
          })
          hub.publish({
            projectId: current.projectId,
            missionId: current.missionId,
            kind: 'info',
            text: `verificação conjunta: comando redefinido pela missão aceito em MODO LEVE (${invalidBaselineCommands.map((c) => c.label).join(' · ')}) — rodando a definição atual com exigência de verde absoluto`,
            actor: 'harness'
          })
        } else {
        const labels = invalidBaselineCommands.map((command) => command.label).join(' · ')
        const detail = `o contrato de verificação mudou ou deixou de ser seguro: ${labels}`
        updatePlanVerification(current.id, 'final', {
          status: 'unavailable',
          head,
          commands,
          adapters,
          startedAt,
          finishedAt: new Date().toISOString(),
          pendingConclusion: conclusion,
          comparison: {
            status: 'blocked',
            items: invalidBaselineCommands.map((command) => ({
              commandId: command.id,
              label: command.label,
              verdict: 'blocked' as const,
              detail: 'existia no baseline, mas foi removido, renomeado ou deixou a allowlist segura'
            }))
          },
          lastError: detail
        })
        hub.publish({
          projectId: current.projectId,
          missionId: current.missionId,
          kind: 'error',
          text: `verificação conjunta BLOQUEADA sem executar o comando alterado: ${labels}`,
          actor: 'harness',
          urgent: true
        })
        if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', current.projectId)
        syncBoard(current.projectId)
        return
        }
      }
      updatePlanVerification(current.id, 'final', {
        status: 'running',
        head,
        commands,
        adapters,
        startedAt,
        pendingConclusion: conclusion
      })
      try {
        await ensureVerificationBootstrap(workspace.cwd, {
          projectId: current.projectId,
          missionId: current.missionId,
          taskId: current.id
        })
        const result = await runVerificationCommands(commands, {
          totalTimeoutMs: budget.totalTimeoutMs,
          maxOutputChars: budget.maxOutputChars,
          env: { CI: '1', NODE_ENV: 'test' }
        })
        let comparison = compareVerificationEvidence(baseline.result, result)
        const headAfter = gitHead(workspace.cwd)
        if (!head || headAfter !== head || isWorktreeClean(workspace.cwd) !== true) {
          comparison = {
            status: 'blocked',
            items: [
              ...comparison.items,
              {
                commandId: 'synkora:immutable-head',
                label: 'fotografia combinada da missão',
                verdict: 'blocked',
                detail: 'a branch ou os arquivos mudaram durante a verificação final'
              }
            ]
          }
        }
        const checkpoint: PlanVerificationCheckpoint = {
          status: result.status,
          head,
          commands,
          adapters,
          result,
          comparison,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          pendingConclusion: conclusion
        }
        updatePlanVerification(current.id, 'final', checkpoint)
        if (finalVerificationAccepted(checkpoint)) {
          closeVerifiedPlan(current.id)
          return
        }
        const detail = comparison.items
          .filter((item) => item.verdict === 'blocked')
          .map((item) => `${item.label}: ${item.detail}`)
          .join(' · ') || `verificação ${result.status}`
        // EVIDÊNCIA DO BLOQUEIO (caso real 2026-08-06: "npm run test falhou no
        // final" chegou SEM nenhum trecho da saída — o orquestrador teve que
        // re-rodar os testes para descobrir o motivo, e a falha original ficou
        // irrecuperável para diagnóstico. Veredito mecânico sem evidência é
        // beco): o tail dos comandos falhos viaja na caixa-preta E na mensagem.
        const failedEvidence = result.results
          .filter((r) => r.status !== 'passed')
          .map((r) => {
            const tail = `${r.stderrTail || ''}\n${r.stdoutTail || ''}`.trim().slice(-1500)
            return tail ? `--- ${r.label} (${r.status}) ---\n${tail}` : `--- ${r.label} (${r.status}) — sem saída capturada ---`
          })
          .join('\n')
        blackbox.record({
          cat: 'verify',
          event: 'plan-verification-blocked',
          ids: { projectId: current.projectId, missionId: current.missionId, taskId: current.id },
          actor: 'harness',
          reason: detail.slice(0, 300),
          detail: {
            comparison: comparison.status,
            commands: result.results.map((r) => `${r.label}:${r.status}`),
            evidence: redactSensitiveText(failedEvidence).slice(0, 4000)
          }
        })
        const latestCards = tasks
          .list(current.projectId)
          .filter(
            (task) =>
              task.planId === current.id &&
              task.kind !== 'plan' &&
              task.status === 'done' &&
              task.deliverable === 'code'
          )
        const repairCard = latestCards.at(-1)
        // MODO LEVE (2026-08-04): a verificação conjunta NUNCA desfaz card já
        // aprovado nos gates — a falha vira evento urgente e o orquestrador
        // decide (card de correção, re-verificação…). Sem o switch, o
        // comportamento estrito de devolver ao dev continua.
        const lightMode = securityWaiverOptions(current.projectId).sensitiveWaiverAllowed
        if (
          repairCard &&
          !lightMode &&
          result.status !== 'unavailable' &&
          result.status !== 'timed_out'
        ) {
          tasks.update(repairCard.id, {
            status: 'backlog',
            feedback: `verificação conjunta reprovou: ${detail}`.slice(0, 600),
            activePhase: 'dev',
            phaseState: 'interrupted',
            verification: { contractVersion: 1 }
          })
        }
        hub.publish({
          projectId: current.projectId,
          missionId: current.missionId,
          kind: 'error',
          text: `verificação conjunta BLOQUEOU a conclusão: ${detail}${
            lightMode
              ? ' — modo leve: nenhum card foi desfeito; avalie a falha e, se for real, crie um card de correção e re-chame conclude_plan'
              : repairCard && repairCard.status === 'done'
                ? ` — reabri "${repairCard.title}" para o orquestrador ajustar o briefing e rodar novamente`
                : ''
          }${
            failedEvidence
              ? `. EVIDÊNCIA (tail da saída): ${redactSensitiveText(failedEvidence).slice(-900)}`
              : ''
          }`,
          actor: 'harness',
          urgent: true
        })
        if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', current.projectId)
        syncBoard(current.projectId)
      } catch (error) {
        const now = new Date().toISOString()
        const detail = error instanceof Error ? error.message : String(error)
        updatePlanVerification(current.id, 'final', {
          status: 'unavailable',
          head,
          commands,
          adapters,
          startedAt,
          finishedAt: now,
          pendingConclusion: conclusion,
          comparison: {
            status: 'blocked',
            items: [{
              commandId: 'synkora:verification-runtime',
              label: 'verificação conjunta',
              verdict: 'blocked',
              detail
            }]
          },
          lastError: detail
        })
        hub.publish({
          projectId: current.projectId,
          missionId: current.missionId,
          kind: 'error',
          text: `verificação conjunta BLOQUEOU a conclusão por erro interno: ${detail}`,
          actor: 'harness',
          urgent: true
        })
        if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', current.projectId)
        syncBoard(current.projectId)
      }
    })().finally(() => finalVerificationRuns.delete(planTask.id))
    finalVerificationRuns.set(planTask.id, run)
  }

  function resumePlanVerificationIfNeeded(planTask: Task | undefined): void {
    const final = planTask?.plan?.verification?.final
    if (
      !planTask ||
      planTask.status !== 'execucao' ||
      !final?.pendingConclusion ||
      finalVerificationRuns.has(planTask.id)
    ) return
    if (finalVerificationAccepted(final)) {
      closeVerifiedPlan(planTask.id)
      const reconciled = tasks.get(planTask.id)
      if (reconciled?.status === 'done') return
      if (!finalVerificationAccepted(reconciled?.plan?.verification?.final)) return
      const workspace = reconciled ? verificationWorkspace(reconciled) : undefined
      const actualHead = workspace ? gitHead(workspace.cwd) : undefined
      const expectedHead = reconciled?.plan?.executionHead
      const detail = !workspace
        ? 'o worktree isolado não pôde ser provado ao reconciliar a verificação final'
        : expectedHead && actualHead !== expectedHead
          ? `a branch avançou fora da cadeia de cards (${expectedHead.slice(0, 12)} → ${actualHead?.slice(0, 12) ?? 'desconhecido'})`
          : isWorktreeClean(workspace.cwd) !== true
            ? 'a branch possui alterações fora da fotografia aprovada'
            : 'a evidência terminal não pôde ser reconciliada com o plano aprovado'
      const terminal = reconciled?.plan?.verification?.final ?? final
      updatePlanVerification(planTask.id, 'final', {
        ...terminal,
        status: 'unavailable',
        finishedAt: new Date().toISOString(),
        comparison: {
          status: 'blocked',
          items: [
            ...(terminal.comparison?.items ?? []),
            {
              commandId: 'synkora:resume-final-snapshot',
              label: 'reconciliação da fotografia final',
              verdict: 'blocked',
              detail
            }
          ]
        },
        lastError: detail
      })
      hub.publish({
        projectId: planTask.projectId,
        missionId: planTask.missionId,
        kind: 'error',
        text: `a verificação final já havia terminado, mas a conclusão não foi reconciliada: ${detail}. Nenhum commit novo foi aceito automaticamente.`,
        actor: 'harness',
        urgent: true
      })
      if (uiSender && !uiSender.isDestroyed())
        uiSender.send('tasks:changed', planTask.projectId)
      syncBoard(planTask.projectId)
      return
    }
    if (final.status !== 'running' && final.status !== 'pending') return
    if (final.status === 'running') {
      updatePlanVerification(planTask.id, 'final', recoverInterruptedVerification(final))
    }
    startFinalPlanVerification(planTask, final.pendingConclusion)
  }

  ipcMain.handle('tasks:planApprove', (e, taskId: string, lanes: PlanLane[], seenRevision?: string) => {
    bindUiSender(e.sender)
    const task = tasks.get(taskId)
    if (!task || task.kind !== 'plan' || !task.plan || task.status !== 'backlog') return undefined
    // CAS DA APROVAÇÃO (caso real E2E 2026-08-05: o orquestrador re-propôs o
    // plano ENQUANTO o usuário podia estar lendo a versão anterior — aprovar
    // a v1 com a v2 no card seria contrato errado). A UI manda a revisão que
    // o usuário VIU; plano mudou desde então → recusa e o modal recarrega.
    if (seenRevision && task.updatedAt !== seenRevision) {
      return { staleRevision: true, currentRevision: task.updatedAt }
    }
    const resumableLegacyPlan =
      task.plan.planningEvidenceState === 'legacy_unverified' &&
      Boolean(task.plan.approvedAt) &&
      !task.plan.planningMethod
    if (!isVerifiedTaskPlanPlanningMethod(task.plan) && !resumableLegacyPlan) {
      hub.publish({
        projectId: task.projectId,
        missionId: task.missionId,
        kind: 'error',
        text:
          'este plano foi criado sem um receipt verificável do método de planejamento. ' +
          'Nenhum status mudou; peça ao orquestrador para reapresentar a proposta.',
        actor: 'harness',
        urgent: true
      })
      return { planningEvidenceRequired: true as const }
    }
    const mission = task.missionId ? missions.get(task.missionId) : undefined
    const project = projects.get(task.projectId)
    const missionCwd = mission && project
      ? missionWorkspacePath(project.path, mission)
      : undefined
    const plan: TaskPlan = {
      ...task.plan,
      lanes,
      approvedAt: new Date().toISOString(),
      executionHead: missionCwd ? gitHead(missionCwd) : undefined
    }
    const updated = tasks.update(taskId, { status: 'execucao', plan })
    if (updated) void ensurePlanBaseline(updated)
    hub.publish({
      projectId: task.projectId,
      missionId: task.missionId,
      kind: 'info',
      text:
        `PLANO APROVADO pelo usuário — modo ${EXECUTION_MODE_LABEL[normalizeExecutionMode(plan.executionMode)]}, ` +
        `risco ${normalizeRiskLevel(plan.risk)}, orçamento ${plan.expectedCards ?? 'legado'} card(s). ` +
        `Lanes finais: ${lanes.map(fmtLane).join(' | ')}. Crie somente os cards previstos e dispare-os; ` +
        'checklist não autoriza ajudantes e qualquer aumento de escopo exige reclassificação.',
      actor: 'user',
      // o orquestrador está parado esperando exatamente isto — injeção na hora
      urgent: true
    })
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', task.projectId)
    syncBoard(task.projectId)
    return updated
  })

  ipcMain.handle('tasks:planStop', (e, taskId: string) => {
    bindUiSender(e.sender)
    const task = tasks.get(taskId)
    if (!task || task.kind !== 'plan' || task.status !== 'execucao') return undefined
    const updated = tasks.update(taskId, { status: 'backlog' })
    hub.publish({
      projectId: task.projectId,
      missionId: task.missionId,
      kind: 'info',
      text: 'PLANO PAUSADO pelo usuário — pare de disparar novos runs AGORA (os já abertos terminam a fase); o plano voltou ao backlog aguardando re-aprovação',
      actor: 'user',
      // "pare AGORA" não pode esperar a cadência do drain
      urgent: true
    })
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', task.projectId)
    syncBoard(task.projectId)
    return updated
  })

  // ————— MISSÕES (F3.8): fluxos de trabalho com orquestrador próprio —————
  // Missão = branch/worktree isolados (com git) + pane orquestrador + tarefas
  // carimbadas. Integração = gate de review do diff completo → merge na base.

  ipcMain.handle(
    'tasks:planSecurityValidation',
    (
      e,
      taskId: string,
      decision: 'approved' | 'waived',
      evidence: string
    ) => {
      assertMainRendererSender(e)
      bindUiSender(e.sender)
      const task = tasks.get(taskId)
      if (!task || task.kind !== 'plan' || !task.plan) {
        throw new Error('Plano nao encontrado para registrar a validacao humana.')
      }
      if (task.status !== 'execucao') {
        throw new Error(
          'A validacao humana so pode ser registrada enquanto o plano esta em execucao.'
        )
      }
      const planCards = tasks
        .list(task.projectId)
        .filter(
          (candidate) =>
            candidate.missionId === task.missionId &&
            candidate.kind !== 'plan' &&
            (candidate.planId === task.id || (!candidate.planId && !task.plan?.executionMode))
        )
      const expectedCards = task.plan.expectedCards
      const openCards = planCards.filter((candidate) => candidate.status !== 'done')
      if (
        planCards.length === 0 ||
        openCards.length > 0 ||
        (expectedCards !== undefined && planCards.length < expectedCards)
      ) {
        throw new Error(
          'A validacao humana so fica disponivel depois que todos os cards previstos do plano estiverem concluidos.'
        )
      }
      const manualSecurityValidation = resolveManualSecurityValidation(
        task.plan,
        decision,
        evidence,
        new Date().toISOString(),
        securityWaiverOptions(task.projectId)
      )
      const updated = tasks.update(taskId, {
        plan: { ...task.plan, manualSecurityValidation }
      })
      if (!updated) throw new Error('Nao foi possivel persistir a validacao humana.')
      hub.publish({
        projectId: task.projectId,
        missionId: task.missionId,
        kind: 'info',
        text:
          decision === 'approved'
            ? 'VALIDACAO HUMANA DE SEGURANCA confirmada pelo usuario; evidencia sanitizada registrada no plano'
            : 'VALIDACAO HUMANA DE SEGURANCA dispensada pelo usuario; justificativa sanitizada registrada no plano',
        actor: 'user',
        urgent: true
      })
      if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', task.projectId)
      syncBoard(task.projectId)
      return updated
    }
  )

  function emitMissionsChanged(projectId: string): void {
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('missions:changed', projectId)
    scheduleProgressSnapshot()
  }

  function integrationQueueView(ticket: IntegrationQueueTicketView): {
    state: IntegrationQueueTicketView['state']
    position: number
    total: number
    lastError?: string
    owner?: 'maestro' | 'orchestrator'
  } {
    return {
      state: ticket.state,
      position: ticket.position,
      total: ticket.total,
      lastError: ticket.lastError,
      owner: ticket.block?.owner
    }
  }

  function missionsWithIntegration(projectId: string): Array<
    Mission & { integration?: ReturnType<typeof integrationQueueView> }
  > {
    const byMission = new Map(
      integrationQueue
        .listPending(projectId)
        .map((ticket) => [ticket.missionId, integrationQueueView(ticket)] as const)
    )
    return missions.list(projectId).map((mission) => ({
      ...mission,
      ...(byMission.has(mission.id) ? { integration: byMission.get(mission.id) } : {})
    }))
  }

  /**
   * Projeto sem Git ainda pode operar diretamente. Em projeto Git, porém, uma
   * missão só tem workspace quando branch e worktree formam o isolamento exato
   * que foi persistido; nunca usamos a pasta principal como fallback.
   */
  function missionWorkspacePath(projectPath: string, mission: Mission): string | undefined {
    return resolveMissionWorkspace(
      projectPath,
      mission.id,
      mission.branch,
      mission.worktree
    )
  }

  /**
   * Branch e worktree identificam uma versao de forma exclusiva. Registros
   * legados continuam validos enquanto nao disputarem o mesmo destino com
   * outra versao; numa colisao, o fluxo bloqueia em vez de escolher uma delas.
   */
  function versionIsolationIsUnique(version: Version): boolean {
    const branch = version.branch?.toLocaleLowerCase('en-US')
    const worktree = version.worktree
      ? resolve(version.worktree).toLocaleLowerCase('en-US')
      : undefined
    return !backlog.listVersions(version.projectId).some((candidate) => {
      if (candidate.id === version.id) return false
      const sameBranch = Boolean(
        branch && candidate.branch?.toLocaleLowerCase('en-US') === branch
      )
      const sameWorktree = Boolean(
        worktree &&
          candidate.worktree &&
          resolve(candidate.worktree).toLocaleLowerCase('en-US') === worktree
      )
      return sameBranch || sameWorktree
    })
  }

  function versionIsolationIsValid(
    projectPath: string,
    version: Version
  ): version is Version & { branch: string; worktree: string } {
    return Boolean(
      version.branch &&
        version.worktree &&
        versionIsolationIsUnique(version) &&
        isExpectedVersionWorktree(projectPath, version.worktree, version.branch)
    )
  }

  /** Garante branch/worktree da missão — inicializando o GIT do projeto se
   *  preciso (sem git não há isolamento; decisão: o Synkora resolve sozinho e
   *  anuncia). Também promove missões antigas criadas sem branch. */
  function ensureMissionWorktree(missionId: string): Mission | undefined {
    const mission = missions.get(missionId)
    if (!mission) return undefined
    if (mission.status === 'concluida' || mission.status === 'arquivada') return mission
    const project = projects.get(mission.projectId)
    if (!project) return mission
    if (!hasGitCommit(project.path)) {
      if (!initGitRepo(project.path)) {
        hub.publish({
          projectId: mission.projectId,
          missionId: mission.id,
          kind: 'error',
          text: 'não consegui inicializar o Git; a missão foi bloqueada para não executar diretamente na pasta principal',
          actor: 'harness',
          urgent: true
        })
        return undefined
      }
      hub.publish({
        projectId: mission.projectId,
        kind: 'info',
        text: 'repo git inicializado pelo Synkora (.gitignore mínimo + commit inicial) — missões ganham branch própria',
        actor: 'harness',
        quiet: true
      })
    }
    ensureSynkoraGitExcludes(project.path)
    const expectedBranch = `mission/${mission.id.slice(0, 8)}`
    // Branch persistida com outro nome é um conflito de identidade, não uma
    // oportunidade para criar uma segunda linha de trabalho silenciosamente.
    if (mission.branch && mission.branch !== expectedBranch) return mission
    if (
      mission.branch &&
      mission.worktree &&
      isExpectedWorktree(project.path, mission.worktree, mission.branch)
    ) {
      return mission
    }
    // Registro legado sem `branch`, mas com um worktree íntegro: só completa o
    // metadado; não recria nem move a fotografia existente.
    if (
      !mission.branch &&
      mission.worktree &&
      isExpectedWorktree(project.path, mission.worktree, expectedBranch)
    ) {
      missions.update(mission.id, { branch: expectedBranch })
      return missions.get(mission.id)
    }
    if (
      !mission.branch &&
      tasks.list(mission.projectId).some((task) => task.missionId === mission.id)
    ) {
      // Já existe contrato/histórico desta missão. Inventar uma branch nova a
      // partir do HEAD atual poderia transformar perda de metadado em entrega
      // falsa; preserve e peça reparo explícito.
      return mission
    }
    if (
      mission.branch &&
      tasks.list(mission.projectId).some((task) => task.missionId === mission.id) &&
      gitLocalBranchExists(project.path, mission.branch) !== true
    ) {
      // A branch registrada sumiu. Recriá-la do HEAD atual manteria o nome,
      // mas perderia a fotografia histórica dos cards — bloqueia em vez de
      // fabricar uma origem nova.
      return mission
    }
    // Uma pasta existente que não prova a identidade esperada é preservada e
    // bloqueia o fluxo. Criar outra ao lado poderia esconder trabalho real.
    if (mission.worktree && existsSync(mission.worktree)) return mission
    const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
    if (mission.versionId && (!version || version.projectId !== mission.projectId)) return mission
    // A branch da versão nasce ANTES da primeira missão. Assim todas as
    // missões abertas na mesma onda partem exatamente do mesmo marco, mesmo
    // quando nenhuma delas integrou ainda.
    let versionBranch: string | undefined
    if (version) {
      if (version.branch || version.worktree) {
        if (!versionIsolationIsValid(project.path, version)) {
          return mission
        }
        versionBranch = version.branch
      } else {
        if (version.deliveries.length > 0) return mission
        const versionHasExecutionHistory = missions
          .list(mission.projectId)
          .some(
            (candidate) =>
              candidate.id !== mission.id &&
              candidate.versionId === version.id &&
              (candidate.status === 'concluida' ||
                candidate.status === 'integrando' ||
                Boolean(candidate.branch) ||
                Boolean(candidate.worktree) ||
                tasks
                  .list(mission.projectId)
                  .some((task) => task.missionId === candidate.id))
          )
        if (versionHasExecutionHistory) return mission
        const versionWt = createVersionWorktree(
          project.path,
          join(app.getPath('userData'), 'worktrees', mission.projectId),
          version.name,
          version.id
        )
        if (!versionWt) return mission
        backlog.setVersionBranch(version.id, versionWt.branch, versionWt.dir)
        versionBranch = versionWt.branch
      }
    }
    const base = versionBranch ?? currentBranch(project.path)
    const wt = createMissionWorktree(
      project.path,
      join(app.getPath('userData'), 'worktrees', mission.projectId),
      mission.id,
      versionBranch
    )
    if (!wt) return mission
    missions.update(mission.id, { branch: wt.branch, worktree: wt.dir, baseBranch: base })
    // sessão antiga do orquestrador (se houver) era no diretório do projeto —
    // zera para a próxima abertura nascer DENTRO do worktree da missão.
    maestro.update(orchKey(mission.projectId, mission.id), { tuiSessionId: undefined })
    return missions.get(mission.id)
  }

  function createMissionImpl(
    projectId: string,
    input: NewMission,
    actor: string,
    reservedId?: string
  ): Mission | null {
    const project = projects.get(projectId)
    if (!project || !input.title.trim()) return null
    const selectedVersion = input.versionId ? backlog.getVersion(input.versionId) : undefined
    if (input.versionId && selectedVersion?.projectId !== projectId) return null
    // Sem versão explícita a missão cai na versão CORRENTE (aberta mais
    // antiga; sem nenhuma, "V1.0" nasce sozinha) — decisão do usuário: a tela
    // de versões precisa fazer sentido sempre; branch da versão segue lazy
    // (criada no 1º merge de missão).
    const versionId = input.versionId ?? backlog.ensureDefaultVersion(projectId).id
    const mission = missions.create(
      projectId,
      { ...input, versionId, title: input.title.trim() },
      reservedId
    )
    ensureMissionWorktree(mission.id)
    const fresh = missions.get(mission.id) ?? mission
    // quiet: quem criou foi o usuário (ou o próprio PM) — o PM não precisa
    // comentar; ele volta a falar nos MARCOS (integrada/reprovada/arquivada).
    hub.publish({
      projectId,
      kind: 'info',
      text: `missão criada: "${fresh.title}"${fresh.branch ? ` (branch ${fresh.branch})` : ' (projeto sem git — roda direto no diretório)'}${fresh.scope ? ` · escopo: ${fresh.scope}` : ''}`,
      actor,
      quiet: true
    })
    emitMissionsChanged(projectId)
    syncBoard(projectId)
    return fresh
  }

  function ensureMissionVersion(
    projectId: string,
    input?: { id?: string; name?: string; theme?: string; goal?: string }
  ): { versionId?: string; name?: string; error?: string } {
    if (!input?.id && !input?.name?.trim()) return {}
    const byId = input.id ? backlog.getVersion(input.id) : undefined
    const name = input.name?.trim()
    if (byId && name && byId.name.toLocaleLowerCase('pt-BR') !== name.toLocaleLowerCase('pt-BR')) {
      return {
        error: `o id informado pertence a ${byId.name}, não a ${name}; revise a versão-alvo no plano mestre`
      }
    }
    const existing =
      byId ??
      (name
        ? backlog
            .listVersions(projectId)
            .find((version) => version.name.toLowerCase() === name.toLowerCase())
        : undefined)
    if (existing) {
      if (existing.projectId !== projectId)
        return { error: 'a versão indicada pertence a outro projeto' }
      if (existing.status === 'lancada')
        return {
          error: `a versão ${existing.name} já foi LANÇADA (read-only) — revise o roadmap para uma versão aberta`
        }
      if (input.theme || input.goal) {
        backlog.updateVersion(existing.id, {
          ...(input.theme ? { theme: input.theme } : {}),
          ...(input.goal ? { goal: input.goal } : {})
        })
      }
      emitBacklogChanged(projectId)
      return { versionId: existing.id, name: existing.name }
    }
    if (!name) return { error: `a versão id=${input.id} não existe neste projeto` }
    const invalid = backlog.validateNewVersion(projectId, name)
    if (invalid) return { error: invalid }
    const created = backlog.createVersion(projectId, {
      name,
      theme: input.theme,
      goal: input.goal
    })
    emitBacklogChanged(projectId)
    return { versionId: created.id, name: created.name }
  }

  interface MissionStartIntent {
    projectId: string
    itemId: string
    missionId: string
    createdAt: string
  }

  function missionStartIntentPath(projectPath: string, missionId: string): string {
    return join(projectPath, '.synkora', 'mission-starts', `${missionId}.json`)
  }

  function writeMissionStartIntent(projectPath: string, intent: MissionStartIntent): void {
    ensureSynkoraGitExcludes(projectPath)
    const directory = join(projectPath, '.synkora', 'mission-starts')
    const file = missionStartIntentPath(projectPath, intent.missionId)
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    mkdirSync(directory, { recursive: true })
    try {
      writeFileSync(temporary, `${JSON.stringify(intent, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // temporário nunca criado ou já promovido
      }
      throw error
    }
  }

  function clearMissionStartIntent(projectPath: string, missionId: string): void {
    try {
      ensureSynkoraGitExcludes(projectPath)
      unlinkSync(missionStartIntentPath(projectPath, missionId))
    } catch {
      // nunca iniciou ou já foi reconciliada
    }
  }

  function rollbackPlannedMission(projectId: string, missionId: string): void {
    const project = projects.get(projectId)
    const mission = missions.get(missionId)
    if (project && mission?.branch && mission.worktree) {
      codeIntelligence?.invalidateWorktreeNow(mission.worktree)
      removeWorktreeAndBranch(project.path, mission.worktree, mission.branch)
    }
    missions.remove(missionId)
    backlog.releaseMissionItems(missionId)
    maestro.forget(orchKey(projectId, missionId))
    hub.purgeMissionEvents(projectId, missionId)
    emitMissionsChanged(projectId)
    emitBacklogChanged(projectId)
    syncBoard(projectId)
  }

  function ensurePlannedMissionBacklogItem(
    projectId: string,
    mission: Mission,
    item: ProjectPlan['roadmap'][number]
  ): string | undefined {
    try {
      const roadmapNote = `Roadmap ${item.id}: ${item.objective}`
      const existing = backlog
        .listItems(projectId)
        .find(
          (candidate) =>
            candidate.missionId === mission.id ||
            (candidate.status === 'pendente' &&
              candidate.title === item.title &&
              candidate.notes === roadmapNote &&
              candidate.versionId === mission.versionId)
        )
      if (existing) {
        if (existing.missionId !== mission.id || existing.status !== 'em-missao') {
          backlog.updateItem(existing.id, { status: 'em-missao', missionId: mission.id })
          emitBacklogChanged(projectId)
          syncBoard(projectId)
        }
      } else {
        backlog.createItem(projectId, {
          title: item.title,
          type: 'feature',
          notes: roadmapNote,
          versionId: mission.versionId,
          status: 'em-missao',
          missionId: mission.id
        })
        emitBacklogChanged(projectId)
        syncBoard(projectId)
      }
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  function recoverMissionStartIntents(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return
    }
    const directory = join(project.path, '.synkora', 'mission-starts')
    let entries: string[] = []
    try {
      entries = readdirSync(directory).filter((entry) => entry.endsWith('.json'))
    } catch {
      return
    }

    for (const entry of entries) {
      const missionId = entry.slice(0, -'.json'.length)
      let intent: MissionStartIntent
      try {
        intent = JSON.parse(readFileSync(join(directory, entry), 'utf8')) as MissionStartIntent
        if (
          intent.projectId !== projectId ||
          intent.missionId !== missionId ||
          !intent.itemId
        ) {
          throw new Error('intent inconsistente')
        }
      } catch (error) {
        const mission = missions.get(missionId)
        if (!mission || mission.projectId !== projectId) {
          clearMissionStartIntent(project.path, missionId)
          continue
        }
        try {
          const plan = loadProjectPlan(project.path)
          if (!plan && projectModeOf(projectId) === 'greenfield') {
            throw new Error('plano mestre ausente')
          }
          const linked = plan?.roadmap.find((candidate) => candidate.missionId === missionId)
          if (linked) {
            const mirrorError = ensurePlannedMissionBacklogItem(projectId, mission, linked)
            if (!mirrorError) clearMissionStartIntent(project.path, missionId)
            continue
          }
          rollbackPlannedMission(projectId, missionId)
          clearMissionStartIntent(project.path, missionId)
        } catch {
          hub.publish({
            projectId,
            kind: 'error',
            text:
              `não consegui interpretar o ponto de recuperação da missão "${mission.title}" nem validar o plano mestre; preservei a missão para revisão: ` +
              (error instanceof Error ? error.message : String(error)),
            actor: 'harness'
          })
        }
        continue
      }

      let mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId) {
        try {
          const plan = loadProjectPlan(project.path)
          if (!plan && projectModeOf(projectId) === 'greenfield') {
            throw new Error('plano mestre ausente')
          }
          const linked = plan?.roadmap.find((candidate) => candidate.missionId === missionId)
          if (linked?.status === 'active') {
            deferStoredProjectMission(project.path, {
              itemId: linked.id,
              reason:
                'Criação interrompida: o registro da missão não sobreviveu; objetivo devolvido ao roadmap.'
            })
            detachStoredProjectMission(project.path, { missionId })
          } else if (linked?.status === 'deferred') {
            detachStoredProjectMission(project.path, { missionId })
          }
          clearMissionStartIntent(project.path, missionId)
          syncBoard(projectId)
        } catch (error) {
          hub.publish({
            projectId,
            kind: 'error',
            text:
              `a missão ${missionId.slice(0, 8)} não existe mais, mas o plano mestre ainda precisa ser reconciliado; preservei o marcador de recuperação: ` +
              (error instanceof Error ? error.message : String(error)),
            actor: 'harness'
          })
        }
        continue
      }
      let plan: ProjectPlan | undefined
      try {
        plan = loadProjectPlan(project.path)
      } catch (error) {
        hub.publish({
          projectId,
          kind: 'error',
          text:
            'há uma missão planejada aguardando reconciliação, mas o plano mestre está inválido: ' +
            (error instanceof Error ? error.message : String(error)),
          actor: 'harness'
        })
        continue
      }
      const item = plan?.roadmap.find((candidate) => candidate.id === intent.itemId)
      if (!plan || !item || (item.missionId && item.missionId !== missionId)) {
        rollbackPlannedMission(projectId, missionId)
        clearMissionStartIntent(project.path, missionId)
        continue
      }

      if (!item.missionId) {
        if (mission.status !== 'ativa') {
          rollbackPlannedMission(projectId, missionId)
          clearMissionStartIntent(project.path, missionId)
          continue
        }
        mission = ensureMissionWorktree(missionId) ?? mission
        if (
          !mission.branch ||
          !mission.worktree ||
          !missionWorkspacePath(project.path, mission)
        ) {
          rollbackPlannedMission(projectId, missionId)
          clearMissionStartIntent(project.path, missionId)
          hub.publish({
            projectId,
            kind: 'error',
            text: `não consegui recuperar a missão planejada "${mission.title}" com isolamento Git; a criação incompleta foi desfeita para não quebrar o roadmap`,
            actor: 'harness'
          })
          continue
        }
        const version =
          mission.branch && mission.versionId ? backlog.getVersion(mission.versionId) : undefined
        try {
          bindProjectMission(project.path, {
            itemId: item.id,
            missionId,
            validation: {
              requireTrustedEvidence: true,
              trustedEvidence: project.planningEvidence,
              trustedLegacyApproval: project.legacyPlanningApproval
            },
            ...(version
              ? { release: { versionId: version.id, versionName: version.name } }
              : {})
          })
        } catch {
          rollbackPlannedMission(projectId, missionId)
          clearMissionStartIntent(project.path, missionId)
          continue
        }
      }

      const mirrorError = ensurePlannedMissionBacklogItem(projectId, mission, item)
      if (!mirrorError) clearMissionStartIntent(project.path, missionId)
      else {
        hub.publish({
          projectId,
          kind: 'error',
          text: `a missão "${mission.title}" foi recuperada e vinculada ao mapa, mas o espelho em Versões ainda precisa ser reconciliado: ${mirrorError}`,
          actor: 'harness'
        })
      }
    }
  }

  /**
   * Avança o mapa macro quando uma missão ligada ao roadmap é integrada.
   * O JSON continua sendo a fonte da verdade; o Markdown é regenerado pela
   * camada de projectPlan, então isto funciona mesmo com o pane do Maestro
   * fechado. Missões pontuais simplesmente não têm vínculo e são ignoradas.
   */
  function completeLinkedProjectPlanMission(
    projectId: string,
    missionId: string,
    fallbackOutcome: string
  ): boolean {
    const project = projects.get(projectId)
    if (!project) return false
    let stored: ProjectPlan | undefined
    try {
      ensureSynkoraGitExcludes(project.path)
      stored = loadProjectPlan(project.path)
    } catch (error) {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          'a missão terminou, mas não consegui ler o plano mestre para avançá-lo: ' +
          (error instanceof Error ? error.message : String(error)),
        actor: 'harness'
      })
      return false
    }
    if (!stored) {
      if (projectModeOf(projectId) === 'greenfield') {
        hub.publish({
          projectId,
          kind: 'error',
          text:
            'a missão terminou, mas o plano mestre do projeto novo não foi encontrado; preservei a reconciliação pendente para recuperação',
          actor: 'harness'
        })
        return false
      }
      return true
    }
    const linked = stored?.roadmap.find((item) => item.missionId === missionId)
    if (!linked || linked.status === 'done') return true
    if (linked.status !== 'active') return false

    const planCard = currentPlanOf(projectId, missionId)
    const outcome = planCard?.plan?.conclusion?.trim() || fallbackOutcome
    try {
      const updated = completeStoredProjectMission(project.path, { missionId, outcome })
      const next = updated.roadmap.find((item) => item.id === updated.nextItemId)
      const releaseGate = projectPlanReleaseGate(updated)
      const pendingReleaseNames = [
        ...new Set(
          updated.roadmap
            .filter((item) => item.release && !item.release.releasedAt)
            .map((item) => item.release?.versionName)
            .filter((name): name is string => Boolean(name))
        )
      ]
      const progress =
        updated.status === 'revision_pending'
          ? '— o mapa mudou e precisa de nova aprovação antes do próximo passo'
          : releaseGate
            ? `— próximo passo único: revisar e publicar ${releaseGate.versionName}; a próxima missão fica bloqueada até essa versão chegar à base`
            : next
              ? `— próxima missão indicada: "${next.title}" [${next.id}]; aguarde autorização do usuário para abri-la`
              : updated.status === 'awaiting_release'
                ? `— próximo passo único: aceitação final e publicação de ${pendingReleaseNames.join(', ') || 'a versão planejada'}`
                : '— todas as missões planejadas foram encerradas'
      hub.publish({
        projectId,
        kind: 'info',
        text: `plano mestre avançou: "${linked.title}" concluída ${progress}`,
        actor: 'harness'
      })
      return true
    } catch (error) {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          `a missão "${linked.title}" foi concluída, mas o plano mestre não avançou: ` +
          (error instanceof Error ? error.message : String(error)),
        actor: 'harness'
      })
      return false
    }
  }

  /**
   * Reconcilia todos os registros derivados de uma missão já pousada. É
   * deliberadamente idempotente para poder rodar no clique, no boot e depois
   * de uma queda entre o merge real e a atualização dos arquivos de estado.
   */
  function reconcileConcludedMission(
    projectId: string,
    missionId: string,
    fallbackOutcome: string
  ): { ok: boolean; doneItems: number } {
    const mission = missions.get(missionId)
    if (!mission || mission.projectId !== projectId || mission.status !== 'concluida') {
      return { ok: false, doneItems: 0 }
    }
    try {
      const doneItems = backlog.completeMissionItems(missionId)
      const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
      if (mission.versionId && (!version || version.projectId !== mission.projectId)) {
        hub.publish({
          projectId,
          kind: 'error',
          text: `a missão "${mission.title}" aponta para uma versão que não existe mais; preservei a reconciliação pendente para não avançar o mapa sem uma publicação possível`,
          actor: 'harness'
        })
        return { ok: false, doneItems }
      }
      const hadDelivery = Boolean(
        version?.deliveries.some((delivery) => delivery.missionId === missionId)
      )
      if (mission.versionId) {
        const delivered = backlog.addDelivery(mission.versionId, mission.id, mission.title)
        if (!delivered) return { ok: false, doneItems }
      }
      if (doneItems > 0 || (mission.versionId && !hadDelivery)) emitBacklogChanged(projectId)
      const planOk = completeLinkedProjectPlanMission(projectId, missionId, fallbackOutcome)
      syncBoard(projectId)
      return { ok: planOk, doneItems }
    } catch (error) {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          `a missão "${mission.title}" foi concluída, mas seus registros ainda precisam ser reconciliados: ` +
          (error instanceof Error ? error.message : String(error)),
        actor: 'harness'
      })
      return { ok: false, doneItems: 0 }
    }
  }

  function transitionLinkedProjectPlanMission(
    projectId: string,
    missionId: string,
    action: 'archive' | 'reactivate' | 'detach'
  ): string | undefined {
    const project = projects.get(projectId)
    if (!project) return undefined
    let stored: ProjectPlan | undefined
    try {
      ensureSynkoraGitExcludes(project.path)
      stored = loadProjectPlan(project.path)
    } catch (error) {
      return 'o plano mestre está inválido: ' +
        (error instanceof Error ? error.message : String(error))
    }
    const linked = stored?.roadmap.find((item) => item.missionId === missionId)
    if (!linked) return undefined
    try {
      if (action === 'archive') {
        deferStoredProjectMission(project.path, {
          itemId: linked.id,
          reason: 'Missão real arquivada; branch preservada para possível retomada.'
        })
      } else if (action === 'reactivate') {
        reactivateStoredProjectMission(project.path, { itemId: linked.id })
      } else {
        detachStoredProjectMission(project.path, { missionId })
      }
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  // Missão integrada: os arquivos operacionais dela (transcripts das tarefas,
  // runs/verdicts, PLAN) morrem na hora — o gate acabou de validar o trabalho;
  // a história consolidada vive no CONTEXT.md e nas entregas da versão.
  function cleanupMissionFiles(projectId: string, missionId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return
    }
    const short = missionId.slice(0, 8)
    const zap = (full: string): void => {
      try {
        unlinkSync(full)
      } catch {
        // best-effort
      }
    }
    const missionTaskIds = new Set(
      tasks
        .list(projectId)
        .filter((t) => t.missionId === missionId)
        .map((t) => t.id)
    )
    const runsDir = join(project.path, '.synkora', 'runs')
    try {
      for (const ent of readdirSync(runsDir)) {
        if (ent.startsWith(`mission-${short}`)) zap(join(runsDir, ent))
        else {
          const tid = ent.replace(/\.(md|done|(review|qa)\.verdict|verdict)$/i, '')
          if (missionTaskIds.has(tid)) zap(join(runsDir, ent))
        }
      }
    } catch {
      // sem runs
    }
    zap(join(project.path, '.synkora', 'missions', `${short}.PLAN.md`))
  }

  // Gate de integração pendente por missão (tipo em phaseTypes.ts).
  const missionWatches = new Map<string, MissionWatch>()
  const integrationDrainTimers = new Map<string, NodeJS.Timeout>()
  const integrationDraining = new Set<string>()

  interface MissionIntegrationTarget {
    kind: 'base' | 'version'
    dir: string
    branch: string
    label: string
    versionId?: string
  }

  function resolveMissionIntegrationTarget(
    project: { id: string; path: string },
    mission: Mission
  ): MissionIntegrationTarget | undefined {
    const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
    if (mission.versionId && (!version || version.projectId !== mission.projectId)) return undefined
    if (!version) {
      return {
        kind: 'base',
        dir: project.path,
        branch: mission.baseBranch ?? currentBranch(project.path) ?? 'base',
        label: mission.baseBranch ?? currentBranch(project.path) ?? 'base'
      }
    }
    let dir = version.worktree
    let branch = version.branch
    if (!version.branch && !version.worktree) {
      // VERSÃO LEGADA (criada antes de a branch de versão nascer na abertura
      // da missão) e comprovadamente VIRGEM: sem entrega registrada e sem
      // branch version/* física no repo. Criar o destino agora é a própria
      // criação lazy antiga — não existe histórico a esconder. Caso real:
      // missão de 30/07 pronta para integrar com a V1.0 sem isolamento
      // (validação ao vivo, 02/08). Qualquer outro estado segue fail-closed.
      if (version.deliveries.length > 0) return undefined
      if (gitLocalBranchExists(project.path, `version/${version.name}`) !== false) {
        return undefined
      }
      const versionWt = createVersionWorktree(
        project.path,
        join(app.getPath('userData'), 'worktrees', project.id),
        version.name,
        version.id
      )
      if (!versionWt) return undefined
      backlog.setVersionBranch(version.id, versionWt.branch, versionWt.dir)
      blackbox.record({
        cat: 'merge',
        event: 'version-target-created-legacy',
        ids: { projectId: project.id, missionId: mission.id, ticketId: version.id },
        actor: 'harness',
        reason: `versão legada "${version.name}" sem isolamento e sem entregas — destino criado lazy para a integração`,
        evidence: `branch ${versionWt.branch}`
      })
      hub.publish({
        projectId: project.id,
        missionId: mission.id,
        kind: 'info',
        text: `a versão ${version.name} não tinha branch própria (registro anterior à F6.1) — o destino ${versionWt.branch} foi criado agora, sem entregas anteriores a preservar`,
        actor: 'harness',
        quiet: true
      })
      dir = versionWt.dir
      branch = versionWt.branch
    } else if (!versionIsolationIsValid(project.path, version)) {
      // A integração só usa a branch de versão criada na abertura da missão;
      // reconstruir um destino aqui poderia esconder histórico perdido.
      return undefined
    }
    if (
      !dir ||
      !branch ||
      !branch.startsWith('version/') ||
      !isExpectedWorktree(project.path, dir, branch)
    ) {
      return undefined
    }
    if (
      branch === mission.branch ||
      (mission.worktree &&
        resolve(dir).toLocaleLowerCase('en-US') ===
          resolve(mission.worktree).toLocaleLowerCase('en-US'))
    ) {
      return undefined
    }
    return {
      kind: 'version',
      dir,
      branch,
      label: `branch da versão ${version.name} (${branch})`,
      versionId: version.id
    }
  }

  function scheduleIntegrationDrain(projectId: string): void {
    if (integrationDrainTimers.has(projectId) || integrationDraining.has(projectId)) return
    // Pequena janela de agrupamento: quando o Maestro autoriza várias missões,
    // todas recebem uma posição antes de a primeira operação Git começar.
    const timer = setTimeout(() => {
      integrationDrainTimers.delete(projectId)
      void drainIntegrationQueue(projectId)
    }, 150)
    integrationDrainTimers.set(projectId, timer)
  }

  function createIntegrationSyncTask(
    ticket: IntegrationQueueTicketView,
    mission: Mission,
    target: MissionIntegrationTarget,
    targetHead: string,
    instruction?: string
  ): boolean {
    const current = currentPlanOf(mission.projectId, mission.id)
    const plan = ticket.planId ? tasks.get(ticket.planId) : current
    if (
      !plan?.plan ||
      plan.projectId !== mission.projectId ||
      plan.missionId !== mission.id ||
      plan.kind !== 'plan' ||
      current?.id !== plan.id ||
      (plan.status !== 'done' && plan.status !== 'execucao')
    )
      return false
    const marker = `[fila:${ticket.id}:${targetHead}]`
    const existing = tasks
      .list(mission.projectId)
      .find(
        (task) =>
          task.missionId === mission.id &&
          task.kind !== 'plan' &&
          task.briefing?.includes(marker)
      )
    if (existing) return true

    if (plan.status === 'done') {
      tasks.update(plan.id, {
        status: 'execucao',
        plan: {
          ...plan.plan,
          conclusion: plan.plan.conclusion
        }
      })
    }
    const lane =
      plan.plan.lanes.find((candidate) => candidate.dept === 'back') ?? plan.plan.lanes[0]
    const department = lane?.dept ?? 'back'
    const conflictInstruction = instruction?.trim()
      ? `\n\nDECISÃO PERSISTIDA DO MAESTRO (siga-a; não invente outra estratégia):\n${instruction.trim()}`
      : ''
    tasks.createMany(mission.projectId, [
      {
        department,
        type: 'bug',
        effort: conflictInstruction ? 'pesada' : 'leve',
        title: `Sincronizar a fila com ${target.branch}`,
        description: 'Atualizar a missão contra tudo que integrou antes dela e validar novamente.',
        briefing:
          `${marker}\nEsta missão chegou à cabeça da fila, mas ${target.label} avançou. ` +
          `Traga ${target.branch} para esta branch de trabalho, preserve a intenção das duas linhas, ` +
          `resolva conflitos conforme a orientação abaixo (se houver), rode os testes rápidos do projeto ` +
           `e reporte done. O review e o QA deste card precisam passar antes de a missão voltar à fila.` +
          conflictInstruction,
        gates: ['review', 'qa'],
        deliverable: 'code',
        delegation: 'none',
        quests: [
          `Mesclar ${target.branch} nesta linha de trabalho`,
          'Preservar as entregas já integradas e a intenção desta missão',
          'Rodar os testes rápidos relevantes'
        ],
        skills: conflictInstruction && skillsLib.isSelectable('resolving-merge-conflicts')
          ? ['resolving-merge-conflicts']
          : undefined,
        version: maestro.get(mission.projectId).version,
        missionId: mission.id,
        origin: 'maestro',
        auto: true,
        planId: plan.id
      }
    ])
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', mission.projectId)
    return true
  }

  function repairIntegrationSyncTickets(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    for (const ticket of integrationQueue
      .listPending(projectId)
      .filter((candidate) => candidate.state === 'sync_required')) {
      // Qualquer card deste ticket, inclusive já done aguardando conclude_plan,
      // prova que não estamos na janela entre decisão e criação.
      const hasCard = tasks
        .list(projectId)
        .some(
          (task) =>
            task.missionId === ticket.missionId &&
            task.kind !== 'plan' &&
            task.briefing?.includes(`[fila:${ticket.id}:`)
        )
      if (hasCard) continue
      let mission = missions.get(ticket.missionId)
      if (!mission || mission.projectId !== projectId) continue
      mission = ensureMissionWorktree(mission.id) ?? mission
      const source = missionWorkspacePath(project.path, mission)
      const target = source ? resolveMissionIntegrationTarget(project, mission) : undefined
      const targetHead = target ? gitHead(target.dir) : undefined
      if (
        !target ||
        !targetHead ||
        !createIntegrationSyncTask(
          ticket,
          mission,
          target,
          targetHead,
          ticket.resolution?.instruction
        )
      ) {
        hub.publish({
          projectId,
          kind: 'error',
          text: `a fila preservou #${ticket.position} (missão "${mission?.title ?? ticket.missionId}"), mas ainda não conseguiu reparar o card operacional; o Maestro deve revisar o plano aprovado`,
          actor: 'harness',
          urgent: true
        })
        continue
      }
      hub.publish({
        projectId,
        missionId: mission.id,
        kind: 'info',
        text: 'recuperei após reinício o card operacional que faltava na fila; execute-o e conclua o plano para retomar a mesma posição',
        actor: 'harness',
        urgent: true
      })
      emitMissionsChanged(projectId)
      syncBoard(projectId)
    }
  }

  function startMissionIntegration(missionId: string, actor: string): string {
    let mission = missions.get(missionId)
    if (!mission) return 'missão não encontrada'
    const project = projects.get(mission.projectId)
    if (!project) return 'projeto não encontrado'
    if (mission.status === 'arquivada')
      return 'a missão está ARQUIVADA — reative-a antes de pedir integração'
    if (mission.status === 'integrando') {
      const queued = integrationQueue.getByMission(missionId)
      return queued
        ? `a missão está integrando agora na cabeça da fila (#${queued.position}/${queued.total})`
        : 'a integração desta missão já está em andamento'
    }
    if (mission.status === 'concluida') {
      // Uma queda pode acontecer depois do merge real e antes da gravação do
      // mapa. Repetir integrar é também um comando de reconciliação idempotente.
      const reconciled = reconcileConcludedMission(
        mission.projectId,
        missionId,
        `Missão integrada: ${mission.title}.`
      )
      return reconciled.ok
        ? 'missão já integrada; backlog, versão e plano mestre foram reconciliados'
        : 'missão já integrada; a reconciliação ficou registrada para nova tentativa no próximo boot'
    }
    const missionPlan = currentPlanOf(mission.projectId, missionId)
    if (!missionPlan) {
      return 'integração bloqueada: esta missão ainda não tem um plano aprovado e concluído — abra a aba da missão e combine o plano com o orquestrador'
    }
    if (manualSecurityValidationPending(missionPlan.plan, securityWaiverOptions(mission.projectId))) {
      return 'integracao bloqueada: a validacao humana de seguranca deste plano continua pendente. Confirme a evidencia ou dispense com justificativa no card do plano.'
    }
    if (missionPlan.status !== 'done') {
      return missionPlan.status === 'backlog'
        ? 'integração bloqueada: o plano da missão ainda aguarda sua aprovação (ou está pausado)'
        : 'integração bloqueada: o plano aprovado ainda está em execução — conclua todos os cards e o plano antes de integrar'
    }
    const verifiedFinal = missionPlan.plan?.verification?.final
    if (missionPlan.plan?.verification && !finalVerificationAccepted(verifiedFinal)) {
      return 'integração bloqueada: a verificação conjunta do plano não está aprovada'
    }
    const open = tasks
      .list(mission.projectId)
      .filter((t) => t.missionId === missionId && t.status !== 'done')
    if (open.length > 0)
      return `ainda há ${open.length} tarefa(s) não concluída(s) na missão — finalize (ou remova) antes de integrar: ${open
        .map((t) => `"${t.title}"`)
        .join(' · ')}`
    mission = ensureMissionWorktree(missionId) ?? mission
    const gitProject = hasGitCommit(project.path)
    const missionSource = missionWorkspacePath(project.path, mission)
    if (!missionSource) {
      return 'integração bloqueada: não foi possível provar ou reanexar o worktree isolado da missão. A fila e a branch principal permaneceram intactas.'
    }
    // PORTEIRA MECÂNICA DE INTEGRAÇÃO (2026-08-07): merge de missão anda SÓ
    // com gesto do DONO. Chamada de agente chegando aqui = missão validada e
    // pronta; registra a INTENÇÃO, o board pulsa, e o clique no ⇪ (actor
    // 'user') é o único caminho que executa.
    if (actor !== 'user') {
      if (!missions.get(missionId)?.pendingIntegrationApproval) {
        missions.update(missionId, { pendingIntegrationApproval: true })
        emitMissionsChanged(mission.projectId)
        syncBoard(mission.projectId)
        hub.publish({
          projectId: mission.projectId,
          kind: 'info',
          text: `integração da missão "${mission.title}" registrada como INTENÇÃO — aguarda o AVAL do dono no botão ⇪ da missão (nada mergeia sem o clique dele)`,
          actor,
          quiet: true
        })
      }
      return (
        'a missão está PRONTA e a intenção de integração foi registrada — o botão ⇪ da missão pulsa aguardando o AVAL DO DONO; nada mergeia sem o clique dele. ' +
        'Não re-chame integrate_mission (é no-op); se o dono demorar, pergunte via ask_user e ESPERE a resposta — ausência nunca é consentimento.'
      )
    }
    if (missions.get(missionId)?.pendingIntegrationApproval) {
      missions.update(missionId, { pendingIntegrationApproval: false })
    }
    if (!gitProject) {
      // sem git não há merge: concluir é só marcar.
      missions.update(missionId, { status: 'concluida' })
      reconcileConcludedMission(
        mission.projectId,
        missionId,
        `Missão concluída: ${mission.title}.`
      )
      hub.publish({
        projectId: mission.projectId,
        kind: 'merge',
        text: `missão "${mission.title}" CONCLUÍDA (projeto sem git — sem merge)`,
        actor
      })
      emitMissionsChanged(mission.projectId)
      syncBoard(mission.projectId)
      return 'missão concluída (projeto sem git, sem merge a fazer)'
    }
    if (!mission.branch || !mission.worktree || !missionSource) {
      return 'integração bloqueada: metadados do isolamento Git estão incompletos'
    }
    if (existsSync(missionIntegrationIntentPath(project.path, missionId))) {
      return 'integração bloqueada: existe um journal anterior ainda não reconciliado. Reinicie o Synkora para a recuperação segura ou repare o marcador antes de tentar novamente.'
    }
    const target = resolveMissionIntegrationTarget(project, mission)
    if (!target)
      return 'integração bloqueada: não consegui preparar a branch de destino; a missão foi preservada'
    if (isWorktreeClean(missionSource) !== true) {
      return 'integração bloqueada: a branch da missão tem alterações não commitadas depois dos gates — conclua e valide essa fotografia antes de entrar na fila'
    }
    const sourceHead = gitHead(missionSource)
    const targetHead = gitHead(target.dir)
    if (!sourceHead || !targetHead)
      return 'integração bloqueada: não consegui identificar os commits atuais da missão e do destino'
    if (verifiedFinal?.head && verifiedFinal.head !== sourceHead) {
      return `integração bloqueada: a branch mudou depois da verificação conjunta (${verifiedFinal.head.slice(0, 12)} → ${sourceHead.slice(0, 12)}); revalide a fotografia atual`
    }

    const existing = integrationQueue.getByMission(missionId)
    if (existing?.state === 'blocked') {
      return existing.block?.owner === 'maestro'
        ? `fila pausada na posição #${existing.position}: o Maestro foi acionado e precisa registrar a estratégia de resolução antes de a missão continuar`
        : `fila pausada na posição #${existing.position}: ${existing.lastError ?? 'bloqueio operacional pendente'}`
    }
    if (existing?.state === 'sync_required') {
      if (gitCommitReached(missionSource, targetHead) !== true) {
        return `a missão mantém a posição #${existing.position} na fila e ainda precisa concluir o card de sincronização com ${target.branch}`
      }
      integrationQueue.requeueAfterSync(missionId, {
        planId: missionPlan.id,
        sourceHead,
        validatedTargetHead: targetHead,
        targetBranch: target.branch,
        targetDir: resolve(target.dir)
      })
    } else if (!existing) {
      integrationQueue.enqueue({
        projectId: mission.projectId,
        missionId,
        requestedBy: actor,
        targetKind: target.kind,
        versionId: target.versionId,
        planId: missionPlan.id,
        sourceHead,
        validatedTargetHead: targetHead,
        targetBranch: target.branch,
        targetDir: resolve(target.dir)
      })
      hub.publish({
        projectId: mission.projectId,
        kind: 'info',
        text: `missão "${mission.title}" entrou na fila serial de integração`,
        actor,
        quiet: true
      })
    }

    const queued = integrationQueue.getByMission(missionId)
    emitMissionsChanged(mission.projectId)
    syncBoard(mission.projectId)
    scheduleIntegrationDrain(mission.projectId)
    return queued
      ? `missão "${mission.title}" na fila de integração: posição #${queued.position} de ${queued.total}. O desenvolvimento das outras missões continua em paralelo; os merges acontecem um por vez.`
      : 'missão colocada na fila de integração'
  }

  async function drainIntegrationQueue(projectId: string): Promise<void> {
    if (integrationDraining.has(projectId)) return
    integrationDraining.add(projectId)
    try {
      while (true) {
        const ticket = integrationQueue.head(projectId)
        if (!ticket || ticket.state !== 'queued') return
        let mission = missions.get(ticket.missionId)
        const project = projects.get(projectId)
        if (!mission || !project || mission.projectId !== projectId) {
          integrationQueue.cancel(ticket.missionId)
          emitMissionsChanged(projectId)
          continue
        }
        if (mission.status === 'concluida') {
          integrationQueue.cancel(mission.id)
          emitMissionsChanged(projectId)
          continue
        }
        if (mission.status === 'arquivada') {
          integrationQueue.cancel(mission.id)
          missions.update(mission.id, { status: 'arquivada' })
          hub.publish({
            projectId,
            kind: 'info',
            text: `retirei "${mission.title}" da fila porque a missão foi arquivada; nenhuma outra missão foi alterada`,
            actor: 'harness'
          })
          emitMissionsChanged(projectId)
          continue
        }
        mission = ensureMissionWorktree(mission.id) ?? mission
        const missionSource = missionWorkspacePath(project.path, mission)
        if (
          !hasGitCommit(project.path) ||
          !mission.branch ||
          !mission.worktree ||
          !missionSource
        ) {
          const detail =
            'a branch/worktree isolada da missão não pôde ser provada ou reanexada; nenhum merge foi tentado'
          const blocked = integrationQueue.block(mission.id, {
            code: 'mission_isolation_unavailable',
            owner: 'maestro',
            detail
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(blocked, mission, undefined, detail)
          return
        }

        // Reparo da pequena janela entre os dois stores: se o card operacional
        // foi persistido e o app caiu antes de o ticket mudar de estado, a
        // fila reconhece o marcador e volta a aguardar esse mesmo card.
        const preparedSyncTask = tasks
          .list(projectId)
          .find(
            (task) =>
              task.missionId === mission.id &&
              task.kind !== 'plan' &&
              task.status !== 'done' &&
              task.briefing?.includes(`[fila:${ticket.id}:`)
          )
        if (preparedSyncTask) {
          integrationQueue.requireSync(mission.id, {
            code: 'sync_task_prepared',
            owner: 'orchestrator',
            detail: 'o card operacional da fila já existe e ainda precisa terminar'
          })
          missions.update(mission.id, { status: 'ativa' })
          emitMissionsChanged(projectId)
          syncBoard(projectId)
          return
        }

        // O ticket é uma fotografia do artefato aprovado. Nada que apareceu
        // depois (plano, card, commit ou arquivo solto) pode entrar escondido.
        const approvedPlan = currentPlanOf(projectId, mission.id)
        const openCards = tasks
          .list(projectId)
          .filter(
            (task) =>
              task.missionId === mission.id && task.kind !== 'plan' && task.status !== 'done'
          )
        const sourceHead = gitHead(missionSource)
        const snapshotProblems: string[] = []
        if (!approvedPlan || approvedPlan.status !== 'done')
          snapshotProblems.push('o plano aprovado não está concluído')
        const approvedFinal = approvedPlan?.plan?.verification?.final
        if (approvedPlan?.plan?.verification && !finalVerificationAccepted(approvedFinal))
          snapshotProblems.push('a verificação conjunta não está aprovada')
        if (ticket.planId && approvedPlan?.id !== ticket.planId)
          snapshotProblems.push('o plano corrente não é o plano que autorizou a entrada na fila')
        if (openCards.length > 0)
          snapshotProblems.push(`${openCards.length} card(s) voltaram a ficar abertos`)
        if (!ticket.sourceHead || !sourceHead)
          snapshotProblems.push('não foi possível confirmar o commit aprovado')
        else if (sourceHead !== ticket.sourceHead)
          snapshotProblems.push(
            `a branch avançou depois da autorização (${ticket.sourceHead.slice(0, 12)} → ${sourceHead.slice(0, 12)})`
          )
        if (approvedFinal?.head && sourceHead && approvedFinal.head !== sourceHead)
          snapshotProblems.push('o commit atual não é o mesmo que passou na verificação conjunta')
        if (isWorktreeClean(missionSource) !== true)
          snapshotProblems.push('há arquivos não commitados na branch da missão')
        if (snapshotProblems.length > 0) {
          const detail = snapshotProblems.join('; ')
          const blocked = integrationQueue.block(mission.id, {
            code: 'validation_snapshot_changed',
            owner: 'maestro',
            detail
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(blocked, mission, undefined, detail)
          return
        }

        const target = resolveMissionIntegrationTarget(project, mission)
        const targetHead = target ? gitHead(target.dir) : undefined
        if (!target || !sourceHead || !targetHead) {
          integrationQueue.block(mission.id, {
            code: 'target_unavailable',
            owner: 'maestro',
            detail: 'não foi possível identificar ou preparar a branch de destino'
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(
            integrationQueue.getByMission(mission.id)!,
            mission,
            target,
            'não foi possível identificar ou preparar a branch de destino'
          )
          return
        }

        const sameTargetDir =
          !ticket.targetDir ||
          resolve(ticket.targetDir).toLocaleLowerCase('en-US') ===
            resolve(target.dir).toLocaleLowerCase('en-US')
        if (
          ticket.targetKind !== target.kind ||
          (ticket.versionId ?? undefined) !== (target.versionId ?? undefined) ||
          (ticket.targetBranch !== undefined && ticket.targetBranch !== target.branch) ||
          !sameTargetDir
        ) {
          const detail =
            `o destino mudou desde a autorização: esperado ${ticket.targetBranch ?? ticket.targetKind}` +
            ` em ${ticket.targetDir ?? '(caminho legado)'}, encontrado ${target.branch} em ${target.dir}`
          const blocked = integrationQueue.block(mission.id, {
            code: 'integration_target_changed',
            owner: 'maestro',
            detail
          })
          missions.update(mission.id, { status: 'ativa' })
          emitIntegrationBlockForMaestro(blocked, mission, target, detail)
          return
        }

        const targetMoved = ticket.validatedTargetHead !== targetHead
        const targetIncluded = gitCommitReached(missionSource, targetHead) === true
        if (targetMoved || !targetIncluded) {
          const pre = await gitOff(
            'missionMergePrecheck',
            project.path,
            { dir: missionSource, branch: mission.branch },
            `mission: ${mission.title}`,
            target.dir,
            ticket.sourceHead
          )
          missions.update(mission.id, { status: 'ativa' })
          if (!pre.ok) {
            const blocked = integrationQueue.block(mission.id, {
              code: 'merge_conflict',
              owner: 'maestro',
              detail: pre.detail
            })
            emitIntegrationBlockForMaestro(blocked, mission, target, pre.detail)
            return
          }
          if (!createIntegrationSyncTask(ticket, mission, target, targetHead)) {
            const detail =
              'não consegui reabrir exatamente o plano aprovado para criar o card de sincronização'
            const blocked = integrationQueue.block(mission.id, {
              code: 'sync_task_unavailable',
              owner: 'maestro',
              detail
            })
            emitIntegrationBlockForMaestro(blocked, mission, target, detail)
            return
          }
          integrationQueue.requireSync(mission.id, {
            code: 'target_advanced',
            owner: 'orchestrator',
            detail: `${target.branch} avançou desde a validação desta missão`
          })
          hub.publish({
            projectId,
            missionId: mission.id,
            kind: 'info',
            text: `chegou sua vez na fila, mas ${target.branch} avançou. A fila abriu um único card de sincronização + testes; conclua o plano e ela retomará automaticamente a autorização original`,
            actor: 'harness',
            urgent: true
          })
          emitMissionsChanged(projectId)
          syncBoard(projectId)
          return
        }

        integrationQueue.beginMerge(mission.id)
        missions.update(mission.id, { status: 'integrando' })
        emitMissionsChanged(projectId)
        syncBoard(projectId)
        const result = await completeMissionMerge(
          projectId,
          mission.id,
          target,
          targetHead,
          ticket.sourceHead!
        )
        const after = missions.get(mission.id)
        if (after?.status === 'concluida') {
          integrationQueue.complete(mission.id)
          emitMissionsChanged(projectId)
          continue
        }

        missions.update(mission.id, { status: 'ativa' })
        if (result.state === 'repair_pending') {
          integrationQueue.requireTargetRepair(mission.id, result.detail)
          hub.publish({
            projectId,
            kind: 'error',
            text:
              `FILA DE INTEGRAÇÃO PAUSADA em #${ticket.position}: o merge de "${mission.title}" já foi gravado, ` +
              'mas os arquivos do destino aguardam reparo seguro. Não há conflito para o Maestro decidir e a fila não tentará integrar novamente. Feche o processo que possa estar segurando os arquivos e reinicie o Synkora.',
            actor: 'harness',
            urgent: true
          })
          emitMissionsChanged(projectId)
          syncBoard(projectId)
          return
        }
        const blocked = integrationQueue.block(mission.id, {
          code: 'merge_failed',
          owner: 'maestro',
          detail: result.detail
        })
        emitIntegrationBlockForMaestro(blocked, mission, target, result.detail)
        return
      }
    } finally {
      integrationDraining.delete(projectId)
    }
  }

  function emitIntegrationBlockForMaestro(
    ticket: IntegrationQueueTicketView,
    mission: Mission,
    target: MissionIntegrationTarget | undefined,
    detail: string
  ): void {
    const behind = integrationQueue
      .listPending(mission.projectId)
      .filter((candidate) => candidate.sequence > ticket.sequence)
      .map((candidate) => missions.get(candidate.missionId)?.title ?? candidate.missionId)
    hub.publish({
      projectId: mission.projectId,
      kind: 'error',
      text:
        `FILA DE INTEGRAÇÃO PAUSADA em #${ticket.position}: "${mission.title}" precisa da decisão do Maestro antes de integrar com ` +
        `${target?.label ?? 'o destino'}. Detalhe: ${detail}. ` +
        `Maestro: inspecione a fotografia aprovada, o estado atual e o destino; depois chame guide_integration_resolution com a estratégia concreta.` +
        (behind.length > 0 ? ` Atrás na fila: ${behind.join(' · ')}.` : ''),
      actor: 'harness',
      urgent: true
    })
    hub.publish({
      projectId: mission.projectId,
      missionId: mission.id,
      kind: 'error',
      text: 'a fila encontrou um conflito ou mudança de segurança e pausou nesta posição. Não escolha uma estratégia sozinho: o Maestro do projeto já recebeu o contexto e enviará uma orientação persistida',
      actor: 'harness',
      urgent: true
    })
    emitMissionsChanged(mission.projectId)
    syncBoard(mission.projectId)
  }

  function missionIntegrationIntentPath(projectPath: string, missionId: string): string {
    return join(projectPath, '.synkora', 'integrations', `${missionId}.intent`)
  }

  interface MissionIntegrationIntent {
    projectId: string
    missionId: string
    sourceHead: string
    targetDir: string
    queueTicketId?: string
    targetHead: string
    targetBranch: string
    createdAt: string
  }

  function writeMissionIntegrationIntent(
    projectPath: string,
    mission: Mission,
    targetDir: string
  ): void {
    ensureSynkoraGitExcludes(projectPath)
    const sourceDir = missionWorkspacePath(projectPath, mission)
    if (!sourceDir || !mission.branch) throw new Error('worktree isolado da missão inválido')
    const sourceHead = gitHead(sourceDir)
    if (!sourceHead) throw new Error('não foi possível identificar o commit da missão')
    const targetHead = gitHead(targetDir)
    const targetBranch = currentBranch(targetDir)
    if (!targetHead || !targetBranch)
      throw new Error('não foi possível identificar a fotografia da branch de destino')
    const file = missionIntegrationIntentPath(projectPath, mission.id)
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    mkdirSync(join(projectPath, '.synkora', 'integrations'), { recursive: true })
    const intent: MissionIntegrationIntent = {
      projectId: mission.projectId,
      missionId: mission.id,
      sourceHead,
      targetDir: resolve(targetDir),
      queueTicketId: integrationQueue.getByMission(mission.id)?.id,
      targetHead,
      targetBranch,
      createdAt: new Date().toISOString()
    }
    try {
      writeFileSync(temporary, `${JSON.stringify(intent, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // temporário nunca criado ou já promovido
      }
      throw error
    }
  }

  function clearMissionIntegrationIntent(projectPath: string, missionId: string): void {
    try {
      ensureSynkoraGitExcludes(projectPath)
      unlinkSync(missionIntegrationIntentPath(projectPath, missionId))
    } catch {
      // nunca iniciou ou já foi reconciliada
    }
  }

  function recoverMissionIntegrationIntents(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return
    }
    const directory = join(project.path, '.synkora', 'integrations')
    let entries: string[] = []
    try {
      entries = readdirSync(directory).filter((entry) => entry.endsWith('.intent'))
    } catch {
      return
    }
    for (const entry of entries) {
      const missionId = entry.slice(0, -'.intent'.length)
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId) {
        clearMissionIntegrationIntent(project.path, missionId)
        continue
      }
      if (mission.status === 'concluida') {
        const reconciled = reconcileConcludedMission(
          projectId,
          missionId,
          `Missão integrada: ${mission.title}.`
        )
        if (reconciled.ok) {
          clearMissionIntegrationIntent(project.path, missionId)
          integrationQueue.cancel(missionId)
        }
        continue
      }
      let intent: MissionIntegrationIntent | undefined
      try {
        const parsed = JSON.parse(readFileSync(join(directory, entry), 'utf8')) as MissionIntegrationIntent
        if (
          parsed.projectId !== projectId ||
          parsed.missionId !== missionId ||
          !/^[0-9a-f]{40,64}$/i.test(parsed.sourceHead) ||
          !/^[0-9a-f]{40,64}$/i.test(parsed.targetHead) ||
          !parsed.targetBranch?.trim() ||
          !parsed.targetDir
        ) {
          throw new Error('intent inconsistente')
        }
        intent = parsed
      } catch {
        if (integrationQueue.getByMission(missionId)) {
          integrationQueue.requireTargetRepair(
            missionId,
            'o marcador de integração está inválido; é preciso reparar ou auditar o journal antes de qualquer nova tentativa'
          )
        }
        hub.publish({
          projectId,
          kind: 'error',
          text: `o marcador de integração da missão "${mission.title}" está inválido; preservei a missão e não presumi que o merge ocorreu`,
          actor: 'harness'
        })
      }
      if (!intent) continue
      if (mission.status === 'ativa' || mission.status === 'integrando') {
        const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
        const versionTarget =
          version &&
          version.projectId === mission.projectId &&
          versionIsolationIsValid(project.path, version)
            ? resolve(version.worktree)
            : undefined
        const expectedTarget =
          mission.versionId && (!version || version.projectId !== mission.projectId)
          ? undefined
          : version
            ? versionTarget
            : resolve(project.path)
        const mergeProven =
          intent &&
          expectedTarget &&
          resolve(intent.targetDir).toLocaleLowerCase('en-US') ===
            expectedTarget.toLocaleLowerCase('en-US') &&
          currentBranch(expectedTarget) === intent.targetBranch &&
          gitCommitReached(expectedTarget, intent.targetHead) === true &&
          gitCommitReached(expectedTarget, intent.sourceHead) === true
        if (!mergeProven) {
          const sourceBeforeMerge = missionWorkspacePath(project.path, mission)
          const safelyStillBeforeMerge = Boolean(
            expectedTarget &&
              resolve(intent.targetDir).toLocaleLowerCase('en-US') ===
                expectedTarget.toLocaleLowerCase('en-US') &&
              currentBranch(expectedTarget) === intent.targetBranch &&
              gitHead(expectedTarget) === intent.targetHead &&
              isWorktreeClean(expectedTarget) === true &&
              sourceBeforeMerge &&
              gitHead(sourceBeforeMerge) === intent.sourceHead &&
              isWorktreeClean(sourceBeforeMerge) === true
          )
          if (safelyStillBeforeMerge) {
            // O app caiu depois de gravar o intent, mas antes do CAS. Remover
            // o marcador libera a MESMA fotografia/ticket para o dreno. Se o
            // journal tinha bloqueado o ticket antes do reparo, rearma esse
            // mesmo sequence somente depois desta prova pre-CAS.
            const ticket = integrationQueue.getByMission(missionId)
            if (ticket?.state === 'blocked') {
              if (
                ticket.block?.owner !== 'orchestrator' ||
                ticket.block.code !== 'target_repair_pending'
              ) {
                continue
              }
              integrationQueue.requeueAfterTargetRepair(missionId)
            } else if (ticket && ticket.state !== 'queued' && ticket.state !== 'merging') {
              continue
            }
            clearMissionIntegrationIntent(project.path, missionId)
            continue
          }
          if (integrationQueue.getByMission(missionId)) {
            integrationQueue.requireTargetRepair(
              missionId,
              'o journal existe, mas o Git não prova nem o estado anterior nem o merge concluído; nova tentativa automática bloqueada'
            )
          }
          if (!mission.worktree || !existsSync(mission.worktree)) {
            hub.publish({
              projectId,
              kind: 'error',
              text: `o worktree da missão "${mission.title}" desapareceu, mas o Git não prova que o commit chegou ao destino; preservei o estado para reparo em vez de marcar uma entrega falsa`,
              actor: 'harness'
            })
          }
          continue
        }
        if (
          isWorktreeClean(expectedTarget) !== true &&
          !alignWorktreeFromSnapshot(expectedTarget, intent!.targetHead)
        ) {
          // O store pode ter restaurado `merging` como `queued` antes de ler o
          // intent. Grave o estado operacional ANTES do aviso/continue para o
          // dreno de boot jamais interpretar este merge já pousado como novo.
          if (integrationQueue.getByMission(missionId)) {
            integrationQueue.requireTargetRepair(
              missionId,
              'o merge está provado no Git, mas os arquivos do destino ainda não puderam ser alinhados com segurança'
            )
          }
          hub.publish({
            projectId,
            kind: 'error',
            text: `o merge da missão "${mission.title}" está provado no Git, mas os arquivos do destino ainda não puderam ser alinhados com segurança. Preservei intent, ticket e branches; feche o processo que possa estar segurando esses arquivos e reinicie o app para tentar o reparo novamente.`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
        const cleanupSource = missionWorktreeDescriptor(
          join(app.getPath('userData'), 'worktrees', projectId),
          missionId
        )
        codeIntelligence?.invalidateWorktreeNow(cleanupSource.dir)
        if (
          !removeWorktreeAndBranch(
            project.path,
            cleanupSource.dir,
            cleanupSource.branch,
            intent.sourceHead
          )
        ) {
          if (integrationQueue.getByMission(missionId)) {
            integrationQueue.requireTargetRepair(
              missionId,
              'o merge está provado, mas a branch/worktree de origem ainda não pôde ser removida'
            )
          }
          hub.publish({
            projectId,
            kind: 'error',
            text: `o merge da missão "${mission.title}" está provado e o destino está alinhado, mas a limpeza da origem ficou pendente. Preservei intent, ticket e metadados para tentar novamente no próximo boot.`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
        missions.update(missionId, {
          status: 'concluida',
          branch: undefined,
          worktree: undefined
        })
        const reconciled = reconcileConcludedMission(
          projectId,
          missionId,
          `Missão integrada e recuperada após reinício: ${mission.title}.`
        )
        if (reconciled.ok) {
          hub.purgeMissionEvents(projectId, missionId)
          cleanupMissionFiles(projectId, missionId)
          clearMissionIntegrationIntent(project.path, missionId)
          integrationQueue.cancel(missionId)
        }
        emitMissionsChanged(projectId)
        hub.publish({
          projectId,
          kind: 'merge',
          text: `integração da missão "${mission.title}" reconciliada após uma interrupção do aplicativo`,
          actor: 'harness'
        })
      }
    }
  }

  // O MERGE da missão (caminho único da integração): mata o orquestrador,
  // mergeia na base OU na branch da versão, registra entrega, limpa arquivos
  // e avisa as outras missões. O resultado distingue falha real de um merge
  // já gravado cujo worktree ainda precisa ser alinhado; este último nunca
  // pode cair no caminho de conflito nem receber uma segunda tentativa.
  interface MissionMergeCompletion {
    state: 'completed' | 'failed' | 'repair_pending'
    detail: string
  }

  async function completeMissionMerge(
    projectId: string,
    missionId: string,
    target: MissionIntegrationTarget,
    expectedTargetHead: string,
    expectedSourceHead: string
  ): Promise<MissionMergeCompletion> {
    // Fase 0 (atribuição de stall): wrapper fino — o corpo real está no Inner.
    return mainStalls.wrap('completeMissionMerge', missionId.slice(0, 8), () =>
      completeMissionMergeInner(
        projectId,
        missionId,
        target,
        expectedTargetHead,
        expectedSourceHead
      )
    )
  }
  async function completeMissionMergeInner(
    projectId: string,
    missionId: string,
    target: MissionIntegrationTarget,
    expectedTargetHead: string,
    expectedSourceHead: string
  ): Promise<MissionMergeCompletion> {
    const mission = missions.get(missionId)
    const project = projects.get(projectId)
    if (!mission || !project)
      return { state: 'failed', detail: 'missão/projeto não encontrado' }
    const missionSource = missionWorkspacePath(project.path, mission)
    // Servidor de teste do dono ainda rodando neste worktree seguraria
    // arquivos durante o merge (Windows) — fecha antes de mesclar.
    if (mission.worktree) closeTestServersUnder(mission.worktree)
    if (
      !hasGitCommit(project.path) ||
      !mission.branch ||
      !mission.worktree ||
      !missionSource
    ) {
      return {
        state: 'failed',
        detail:
          'integração BLOQUEADA: a branch/worktree isolada da missão não pôde ser provada; nada foi mesclado na branch principal'
      }
    }
    // O worker já resolveu e validou este destino. Nunca o recrie pelo nome
    // aqui: renomear uma versão entre as duas etapas não pode mandar o merge
    // para uma segunda branch vazia.
    const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
    if (
      target.kind === 'version' &&
      (!version ||
        version.projectId !== mission.projectId ||
        !versionIsolationIsValid(project.path, version) ||
        target.versionId !== version.id)
    )
      return {
        state: 'failed',
        detail: 'integração BLOQUEADA: a identidade da versão mudou depois da validação'
      }
    if (
      (target.kind === 'base' &&
        resolve(target.dir).toLocaleLowerCase('en-US') !==
          resolve(project.path).toLocaleLowerCase('en-US')) ||
      (target.kind === 'version' &&
        !isExpectedWorktree(project.path, target.dir, target.branch))
    ) {
      return {
        state: 'failed',
        detail: 'integração BLOQUEADA: o worktree de destino não corresponde ao destino validado'
      }
    }
    const currentSourceHead = gitHead(missionSource)
    const currentTargetHead = gitHead(target.dir)
    const currentTargetBranch = currentBranch(target.dir)
    if (
      currentSourceHead !== expectedSourceHead ||
      currentTargetHead !== expectedTargetHead ||
      currentTargetBranch !== target.branch
    ) {
      return {
        state: 'failed',
        detail:
          'integração BLOQUEADA: a fotografia mudou no instante anterior ao merge ' +
          `(origem ${currentSourceHead?.slice(0, 12) ?? 'indisponível'}, destino ${currentTargetHead?.slice(0, 12) ?? 'indisponível'} em ${currentTargetBranch ?? 'branch desconhecida'})`
      }
    }
    const mergeTarget = target.label
    // PRÉ-CHECAGEM antes de qualquer ação irreversível. Se uma corrida mover o
    // destino entre a checagem da fila e este ponto, não tocamos no destino:
    // a fila transforma o retorno em bloqueio e o Maestro decide a estratégia.
    // git PESADO fora do main thread (task #2): o precheck roda merge-tree e
    // commit de pendências — era parte central da "travada" de integrar.
    const pre = await gitOff(
      'missionMergePrecheck',
      project.path,
      { dir: missionSource, branch: mission.branch },
      `mission: ${mission.title}`,
      target.dir,
      expectedSourceHead
    )
    if (!pre.ok) {
      hub.publish({
        projectId,
        kind: 'error',
        text: `integração da missão "${mission.title}" BLOQUEADA: ${pre.detail}`,
        actor: 'harness'
      })
      hub.publish({
        projectId,
        missionId,
        kind: 'error',
        text: `a fila detectou um conflito antes do merge: ${pre.detail}. Não escolha a resolução sozinho; preserve a branch e aguarde a orientação persistida do Maestro`,
        actor: 'harness'
      })
      emitMissionsChanged(projectId)
      return {
        state: 'failed',
        detail: `integração BLOQUEADA: ${pre.detail} — branch preservada para a decisão do Maestro`
      }
    }
    try {
      writeMissionIntegrationIntent(project.path, mission, target.dir)
    } catch (error) {
      return {
        state: 'failed',
        detail: `integração BLOQUEADA: não consegui gravar o ponto seguro de recuperação (${error instanceof Error ? error.message : String(error)}) — nenhuma mudança foi mesclada`
      }
    }
    // merge VAI acontecer: agora sim o orquestrador aposenta — fecha o pane
    // ANTES do merge real (o worktree some na limpeza; um processo com cwd
    // nele travaria a remoção).
    ptys.kill(orchPaneId(projectId, missionId))
    codeIntelligence?.invalidateWorktreeNow(missionSource)
    const res = await gitOff(
      'mergeTaskWorktree',
      project.path,
      { dir: missionSource, branch: mission.branch },
      `mission: ${mission.title}`,
      target.dir,
      {
        requireCleanSource: true,
        expectedSourceHead,
        expectedTargetHead,
        expectedTargetBranch: target.branch
      }
    )
    const alignedAfterCommit =
      !res.ok && res.committed === true
        ? await gitOff('alignWorktreeFromSnapshot', target.dir, expectedTargetHead)
        : false
    const cleanedAfterAlignment = alignedAfterCommit
      ? await gitOff(
          'removeWorktreeAndBranch',
          project.path,
          missionSource,
          mission.branch,
          expectedSourceHead
        )
      : false
    const mergeOk = res.ok || (alignedAfterCommit && cleanedAfterAlignment)
    const mergeDetail = alignedAfterCommit
      ? cleanedAfterAlignment
        ? `${res.detail}; destino alinhado e origem limpa na tentativa de reparo`
        : `${res.detail}; destino alinhado, mas a limpeza da origem ficou pendente`
      : res.detail
    if (mergeOk) {
      missions.update(missionId, { status: 'concluida', branch: undefined, worktree: undefined })
      const reconciled = reconcileConcludedMission(
        projectId,
        missionId,
        `Missão integrada: ${mission.title}.`
      )
      const doneItems = reconciled.doneItems
      // eventos da missão viraram lixo operacional — some do EVENTS.md; e a
      // limpeza + vassoura geral de sempre (transcripts/PLAN/helpers órfãos).
      if (reconciled.ok) {
        hub.purgeMissionEvents(projectId, missionId)
        cleanupMissionFiles(projectId, missionId)
        sweepProjectFiles(projectId)
      }
      hub.publish({
        projectId,
        kind: 'merge',
        text: `missão "${mission.title}" INTEGRADA na ${mergeTarget} (${mergeDetail})${doneItems > 0 ? ` · ${doneItems} item(ns) do backlog concluído(s)` : ''}${target.kind === 'version' ? ' — a main só recebe quando o usuário subir a versão' : ''}`,
        actor: 'harness'
      })
      if (target.kind === 'version') {
        // versão avançou: só as missões da MESMA versão precisam de sync
        for (const other of missions.list(projectId)) {
          if (other.id === missionId || other.status !== 'ativa' || !other.branch) continue
          if (other.versionId !== mission.versionId) continue
          hub.publish({
            projectId,
            missionId: other.id,
            kind: 'info',
            text: `a branch da versão ${version!.name} avançou (missão "${mission.title}" integrou nela). A fila verificará sua branch quando chegar sua vez e, se necessário, abrirá automaticamente um card de sincronização + testes`,
            actor: 'harness'
          })
        }
      } else {
        // base avançou: as outras missões ativas precisam trazer a base.
        for (const other of missions.list(projectId)) {
          if (other.id === missionId || other.status !== 'ativa' || !other.branch) continue
          hub.publish({
            projectId,
            missionId: other.id,
            kind: 'info',
            text: `a branch base avançou (missão "${mission.title}" foi integrada). A fila verificará sua branch quando chegar sua vez e, se necessário, abrirá automaticamente um card de sincronização + testes`,
            actor: 'harness'
          })
        }
      }
      emitMissionsChanged(projectId)
      syncBoard(projectId)
      if (reconciled.ok) clearMissionIntegrationIntent(project.path, missionId)
      return {
        state: 'completed',
        detail: `missão "${mission.title}" INTEGRADA na ${mergeTarget} (${mergeDetail})`
      }
    }
    if (!res.committed) clearMissionIntegrationIntent(project.path, missionId)
    missions.update(missionId, { status: 'ativa' })
    hub.publish({
      projectId,
      kind: 'error',
      text: res.committed
        ? `merge da missão "${mission.title}" foi gravado no Git, mas a finalização AGUARDA REPARO: ${mergeDetail}`
        : `merge da missão "${mission.title}" FALHOU: ${res.detail}`,
      actor: 'harness'
    })
    hub.publish({
      projectId,
      missionId,
      kind: 'error',
      text: res.committed
        ? `o merge exato já foi gravado, mas destino/limpeza ainda não fecharam: ${mergeDetail}. O intent e as branches foram preservados; não repita o merge`
        : `o merge atômico falhou: ${res.detail}. A branch foi preservada; a fila vai pausar e pedir ao Maestro uma estratégia antes de qualquer correção`,
      actor: 'harness'
    })
    emitMissionsChanged(projectId)
    syncBoard(projectId)
    return res.committed
      ? {
          state: 'repair_pending',
          detail: `merge GRAVADO, mas finalização aguardando reparo: ${mergeDetail} — intent preservado`
        }
      : {
          state: 'failed',
          detail: `merge FALHOU: ${res.detail} — branch preservada para a decisão do Maestro`
        }
  }

  function handleMissionVerdict(watch: MissionWatch, content: string): void {
    const mission = missions.get(watch.missionId)
    if (!mission) return
    if (uiSender && !uiSender.isDestroyed())
      uiSender.send('panes:closeById', watch.projectId, watch.paneId)
    const m = content.match(/^\s*(aprovada|reprovada)\s*:?\s*([\s\S]*)$/i)
    const approved = m?.[1]?.toLowerCase() === 'aprovada'
    const motivo = (m?.[2] ?? '').trim().slice(0, 300) || 'sem motivo'
    if (!m || !approved) {
      const why = !m ? `veredito ilegível: ${content.slice(0, 120)}` : motivo
      missions.update(watch.missionId, { status: 'ativa' })
      // PM sabe do resultado; o orquestrador recebe o que fazer.
      hub.publish({
        projectId: watch.projectId,
        kind: 'error',
        text: `integração da missão "${mission.title}" REPROVADA: ${why}`,
        actor: 'review'
      })
      hub.publish({
        projectId: watch.projectId,
        missionId: watch.missionId,
        kind: 'report',
        text: `gate de integração reprovou: ${why} — corrija (crie tarefas se preciso) e chame integrate_mission de novo`,
        actor: 'review'
      })
      emitMissionsChanged(watch.projectId)
      return
    }
    // Aprovada (marcador órfão de sessão antiga): entra na mesma fila durável;
    // nenhum caminho legado pode furar a ordem dos merges.
    startMissionIntegration(watch.missionId, 'review legado')
  }

  ipcMain.handle('missions:list', (_e, projectId: string) => missionsWithIntegration(projectId))

  ipcMain.handle('missions:create', (e, projectId: string, input: NewMission) => {
    bindUiSender(e.sender)
    const masterPlan = projectPlanOf(projectId)
    if (projectModeOf(projectId) === 'greenfield' && masterPlan?.status !== 'done') {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          'missão avulsa bloqueada: este projeto novo ainda segue o plano mestre — converse com o Maestro para revisar/aprovar o mapa ou autorizar a próxima missão indicada',
        actor: 'harness'
      })
      return null
    }
    return createMissionImpl(projectId, input, 'user')
  })

  // Missão criada pelo PM: o usuário escolhe conta/modelo/effort do
  // orquestrador no modal do board — só então o paneSpec libera o pane
  // (decisão do usuário, 02/08).
  ipcMain.handle(
    'missions:confirmOrchestrator',
    (e, projectId: string, missionId: string, choice: { seatId?: string; model?: string; effort?: string }) => {
      bindUiSender(e.sender)
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId || !mission.pendingOrchestrator) return false
      const seatId = choice?.seatId && seats.get(choice.seatId) ? choice.seatId : undefined
      const updated = missions.confirmOrchestrator(missionId, {
        seatId,
        model: choice?.model?.trim() || undefined,
        effort: choice?.effort?.trim() || undefined
      })
      if (!updated) return false
      blackbox.record({
        cat: 'user',
        event: 'orchestrator-confirmed',
        actor: 'user',
        ids: { projectId, missionId, seatId: updated.seatId },
        detail: { model: updated.model, effort: updated.effort }
      })
      emitMissionsChanged(projectId)
      return true
    }
  )

  // Troca de CONTA do orquestrador no meio da missão (decisão do usuário,
  // 2026-08-04: limite estourado nunca pode prender a missão nem custar o
  // contexto). Mesmo CLI → a conversa é TRANSPLANTADA para o seat novo
  // (sondas positivas nos dois CLIs); CLI diferente → renasce e se reergue
  // pelos arquivos duráveis (PLAN.md/board_status), como sempre.
  ipcMain.handle(
    'missions:setOrchestratorSeat',
    (
      e,
      projectId: string,
      missionId: string,
      choice: { seatId: string; model?: string; effort?: string }
    ) => {
      bindUiSender(e.sender)
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== projectId) return { ok: false, msg: 'missão não encontrada' }
      if (mission.status !== 'ativa')
        return { ok: false, msg: 'só missão ativa pode trocar a conta do orquestrador' }
      const nextSeat = choice?.seatId ? seats.get(choice.seatId) : undefined
      if (!nextSeat) return { ok: false, msg: 'escolha uma conta válida' }
      const key = orchKey(projectId, missionId)
      const state = maestro.get(key)
      const prevSeatId = mission.seatId ?? state.seatId ?? maestro.get(projectId).seatId
      const prevSeat = prevSeatId ? seats.get(prevSeatId) : undefined
      const paneId = orchPaneId(projectId, missionId)
      if (ptys.has(paneId)) ptys.kill(paneId)
      unregisterPane(paneId)
      const cwd = mission.worktree ?? projects.get(projectId)?.path
      const migrated = Boolean(
        prevSeat &&
          prevSeat.id !== nextSeat.id &&
          prevSeat.cli === nextSeat.cli &&
          state.tuiSessionId &&
          cwd &&
          migrateCliSessionBetweenSeats(
            nextSeat.cli,
            prevSeat.id,
            nextSeat.id,
            cwd,
            state.tuiSessionId
          )
      )
      // confirmOrchestrator grava seat/model/effort (mesmo caminho do modal
      // de criação); pendingOrchestrator já é undefined em missão rodando.
      missions.confirmOrchestrator(missionId, {
        seatId: nextSeat.id,
        model: choice.model?.trim() || undefined,
        effort: choice.effort?.trim() || undefined
      })
      maestro.update(key, {
        seatId: nextSeat.id,
        sessionId: undefined,
        tuiSessionId: migrated ? state.tuiSessionId : undefined,
        personaSent: false,
        contextWindow: undefined
      })
      blackbox.record({
        cat: 'pane',
        event: 'seat-swap',
        actor: 'user',
        ids: { projectId, missionId, paneId, seatId: nextSeat.id },
        reason: migrated
          ? `orquestrador migrado de ${prevSeat?.name ?? prevSeatId} para ${nextSeat.name} COM a conversa (transplante de sessão)`
          : `orquestrador trocado de ${prevSeat?.name ?? prevSeatId} para ${nextSeat.name} sem migração (CLI diferente ou sem sessão) — reergue por PLAN.md/board_status`
      })
      hub.publish({
        projectId,
        missionId,
        kind: 'info',
        quiet: true,
        text: `orquestrador da missão "${mission.title}" trocou para a conta ${nextSeat.name}${migrated ? ' mantendo a conversa' : ''}`,
        actor: 'harness'
      })
      emitMissionsChanged(projectId)
      return {
        ok: true,
        msg: migrated
          ? 'conta trocada COM a conversa transplantada'
          : 'conta trocada; conversa recomeça e o orquestrador se reergue pelos arquivos da missão'
      }
    }
  )

  ipcMain.handle(
    'missions:update',
    (e, id: string, patch: { title?: string; goal?: string; scope?: string; status?: 'ativa' | 'arquivada' }) => {
      bindUiSender(e.sender)
      const mission = missions.get(id)
      if (!mission) return null
      // status só transita entre ativa e arquivada pela UI (integração tem
      // caminho próprio; concluída é terminal — a branch já foi embora).
      if (patch.status && mission.status !== 'ativa' && mission.status !== 'arquivada')
        delete patch.status
      if (patch.status && patch.status !== mission.status) {
        if (patch.status === 'arquivada') {
          const queued = integrationQueue.getByMission(mission.id)
          if (queued?.state === 'merging') {
            hub.publish({
              projectId: mission.projectId,
              kind: 'error',
              text: `não arquivei "${mission.title}": ela está no instante de merge da cabeça da fila`,
              actor: 'harness'
            })
            return mission
          }
        }
        const planError = transitionLinkedProjectPlanMission(
          mission.projectId,
          mission.id,
          patch.status === 'arquivada' ? 'archive' : 'reactivate'
        )
        if (planError) {
          hub.publish({
            projectId: mission.projectId,
            kind: 'error',
            text: `não alterei a missão "${mission.title}": ${planError}`,
            actor: 'harness'
          })
          return mission
        }
        if (patch.status === 'arquivada') {
          const queued = integrationQueue.getByMission(mission.id)
          if (queued) {
            integrationQueue.cancel(mission.id)
            scheduleIntegrationDrain(mission.projectId)
          }
          stopMissionExecution(
            mission.projectId,
            mission.id,
            'execução pausada porque a missão foi arquivada; ao reativar, revise o transcript e rode o card novamente'
          )
        }
      }
      const updated = missions.update(id, patch)
      if (updated) {
        // Missão ARQUIVADA não fica com orquestrador vivo (bug real: o pane
        // seguia aberto com o CLI rodando): mata o pty e desarma o hub —
        // reativar respawna via resume (tuiSessionId persiste no maestroStore).
        if (patch.status === 'arquivada') {
          const paneId = orchPaneId(updated.projectId, id)
          if (ptys.has(paneId)) ptys.kill(paneId)
          unregisterPane(paneId)
        }
        // Arquivar/reativar é MARCO — o PM comenta (decisão do usuário: ele
        // fala em concluída/integrada/arquivada, não na rotina).
        if (patch.status && patch.status !== mission.status) {
          hub.publish({
            projectId: updated.projectId,
            kind: 'info',
            text:
              patch.status === 'arquivada'
                ? `missão "${updated.title}" foi ARQUIVADA${updated.branch ? ` (branch ${updated.branch} preservada)` : ''}`
                : `missão "${updated.title}" foi REATIVADA`,
            actor: 'user'
          })
        }
        emitMissionsChanged(updated.projectId)
        syncBoard(updated.projectId)
      }
      return updated ?? null
    }
  )

  ipcMain.handle('missions:integrate', (e, missionId: string) => {
    bindUiSender(e.sender)
    return startMissionIntegration(missionId, 'user')
  })

  // ————— BACKLOG DE PRODUTO (versões como escopo de planejamento) —————
  function emitBacklogChanged(projectId: string): void {
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('backlog:changed', projectId)
  }

  // SUBIR VERSÃO (release): merge da branch version/<nome> na base. Cada
  // missão da versão já passou pelo próprio gate de integração — o release é
  // um merge direto, SEMPRE disparado pelo usuário (botão na aba Versões ou
  // release_version do PM com aval explícito). Sucesso: branch/worktree da
  // versão são limpos e a versão vira a ATUAL na main (status lancada).
  function versionReleaseIntentPath(projectPath: string, versionId: string): string {
    return join(projectPath, '.synkora', 'releases', `${versionId}.intent`)
  }

  interface VersionReleaseIntent {
    id: string
    name: string
    projectId: string
    sourceHead: string
    targetHead?: string
    targetBranch?: string
    targetDir: string
    createdAt: string
  }

  function writeVersionReleaseIntent(
    projectPath: string,
    version: { id: string; name: string; projectId: string; worktree?: string }
  ): VersionReleaseIntent {
    ensureSynkoraGitExcludes(projectPath)
    if (!version.worktree) throw new Error('worktree da versão ausente')
    const sourceHead = gitHead(version.worktree)
    if (!sourceHead) throw new Error('não foi possível identificar o commit da versão')
    const targetHead = gitHead(projectPath)
    if (!targetHead) throw new Error('não foi possível identificar o commit atual da base')
    const targetBranch = currentBranch(projectPath)
    if (!targetBranch) throw new Error('não foi possível identificar a branch atual da base')
    const directory = join(projectPath, '.synkora', 'releases')
    const file = versionReleaseIntentPath(projectPath, version.id)
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    mkdirSync(directory, { recursive: true })
    const intent: VersionReleaseIntent = {
      id: version.id,
      name: version.name,
      projectId: version.projectId,
      sourceHead,
      targetHead,
      targetBranch,
      targetDir: resolve(projectPath),
      createdAt: new Date().toISOString()
    }
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify(intent, null, 2)}\n`,
        'utf8'
      )
      renameSync(temporary, file)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // temporário nunca criado ou já promovido
      }
      throw error
    }
    return intent
  }

  function clearVersionReleaseIntent(projectPath: string, versionId: string): void {
    try {
      ensureSynkoraGitExcludes(projectPath)
      unlinkSync(versionReleaseIntentPath(projectPath, versionId))
    } catch {
      // nunca iniciou ou já foi reconciliada
    }
  }

  function recoverVersionReleaseIntents(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return
    }
    const directory = join(project.path, '.synkora', 'releases')
    let entries: string[] = []
    try {
      entries = readdirSync(directory).filter((entry) => entry.endsWith('.intent'))
    } catch {
      return
    }
    for (const entry of entries) {
      const versionId = entry.slice(0, -'.intent'.length)
      const version = backlog.getVersion(versionId)
      if (!version || version.projectId !== projectId) {
        clearVersionReleaseIntent(project.path, versionId)
        continue
      }
      if (version.status !== 'lancada') {
        if (!versionIsolationIsValid(project.path, version)) {
          hub.publish({
            projectId,
            kind: 'error',
            text: `a versão ${version.name} não possui uma branch/worktree version/* exclusiva e comprovada neste projeto; preservei o journal e bloqueei a recuperação até a identidade ser reparada`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
        let intent: VersionReleaseIntent | undefined
        try {
          const parsed = JSON.parse(readFileSync(join(directory, entry), 'utf8')) as VersionReleaseIntent
          if (
            parsed.id !== versionId ||
            parsed.projectId !== projectId ||
            !/^[0-9a-f]{40,64}$/i.test(parsed.sourceHead) ||
            !/^[0-9a-f]{40,64}$/i.test(parsed.targetHead ?? '') ||
            !parsed.targetBranch?.trim() ||
            resolve(parsed.targetDir).toLocaleLowerCase('en-US') !==
              resolve(project.path).toLocaleLowerCase('en-US')
          ) {
            throw new Error('intent inconsistente')
          }
          intent = parsed
        } catch {
          hub.publish({
            projectId,
            kind: 'error',
            text: `o marcador de publicação da versão ${version.name} está inválido; preservei a versão e não presumi que ela chegou à base`,
            actor: 'harness'
          })
          continue
        }
        if (
          currentBranch(project.path) !== intent.targetBranch ||
          gitCommitReached(project.path, intent.targetHead!) !== true ||
          gitCommitReached(project.path, intent.sourceHead) !== true
        ) {
          if (
            isExactCleanPreCasSnapshot(
              version.worktree,
              intent.sourceHead,
              project.path,
              intent.targetHead!,
              intent.targetBranch!
            )
          ) {
            // Queda depois do journal, mas antes do CAS: ambas as fotografias
            // continuam exatamente intactas. Só esta prova libera nova tentativa.
            clearVersionReleaseIntent(project.path, versionId)
            continue
          }
          if (!existsSync(version.worktree)) {
            hub.publish({
              projectId,
              kind: 'error',
              text: `o worktree da versão ${version.name} desapareceu, mas o Git não prova que seu commit chegou à base; preservei o estado para reparo`,
              actor: 'harness'
            })
          }
          continue
        }
        if (
          isWorktreeClean(project.path) !== true &&
          !alignWorktreeFromSnapshot(project.path, intent.targetHead!)
        ) {
          hub.publish({
            projectId,
            kind: 'error',
            text: `a publicação da versão ${version.name} está provada no Git, mas os arquivos da base ainda não puderam ser alinhados com segurança. Preservei o intent e a versão para nova tentativa no próximo boot.`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
        if (!version.worktree || !version.branch) {
          hub.publish({
            projectId,
            kind: 'error',
            text: `a publicação da versão ${version.name} chegou à base, mas faltam metadados para provar a limpeza da origem; preservei intent e status para reparo`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
        codeIntelligence?.invalidateWorktreeNow(version.worktree)
        if (
          !removeWorktreeAndBranch(
            project.path,
            version.worktree,
            version.branch,
            intent.sourceHead
          )
        ) {
          hub.publish({
            projectId,
            kind: 'error',
            text: `a publicação da versão ${version.name} chegou à base, mas a branch/worktree de origem divergiu ou não pôde ser removida sem força; preservei tudo para reparo`,
            actor: 'harness',
            urgent: true
          })
          continue
        }
      }

      if (version.status !== 'lancada') {
        backlog.markVersionReleased(versionId)
      }
      let reconciled = true
      try {
        completeStoredProjectPlanRelease(project.path, { versionId })
      } catch (error) {
        reconciled = projectModeOf(projectId) !== 'greenfield'
        if (!reconciled) {
          hub.publish({
            projectId,
            kind: 'error',
            text:
              `a versão ${version.name} já chegou à base, mas o plano mestre ainda precisa ser reconciliado: ` +
              (error instanceof Error ? error.message : String(error)),
            actor: 'harness'
          })
        }
      }
      emitBacklogChanged(projectId)
      syncBoard(projectId)
      if (reconciled) clearVersionReleaseIntent(project.path, versionId)
      hub.publish({
        projectId,
        kind: 'merge',
        text: `publicação da versão ${version.name} reconciliada após uma interrupção do aplicativo`,
        actor: 'harness'
      })
    }
  }

  async function releaseVersionImpl(versionId: string, actor: string): Promise<string> {
    const version = backlog.getVersion(versionId)
    if (!version) return 'versão não encontrada'
    const project = projects.get(version.projectId)
    try {
      if (project) ensureSynkoraGitExcludes(project.path)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    if (!project) return 'projeto não encontrado'
    if (version.status === 'lancada') {
      let reconciled = true
      try {
        completeStoredProjectPlanRelease(project.path, { versionId: version.id })
        syncBoard(version.projectId)
      } catch {
        // Projeto existente ou plano ausente: a versão continua lançada.
        reconciled = projectModeOf(version.projectId) !== 'greenfield'
      }
      if (reconciled) clearVersionReleaseIntent(project.path, version.id)
      return `a versão ${version.name} já foi lançada`
    }
    // Servidor de teste do dono no worktree da versão fecha antes do merge.
    if (version.worktree) closeTestServersUnder(version.worktree)
    // HOLD do PM (02/08): o release subiu no meio de uma verificação do
    // Maestro e a limpeza apagou a branch da versão debaixo dele. Com hold
    // ativo, nada sobe — nem pelo botão, nem pela tool.
    const releaseHold = maestro.get(version.projectId).releaseHold
    if (releaseHold) {
      return (
        `release BLOQUEADO por hold do Maestro (desde ${releaseHold.at.slice(0, 16).replace('T', ' ')}): ` +
        `${releaseHold.reason} — quando a verificação terminar, o PM libera com set_release_hold {on: false}`
      )
    }
    if (projectModeOf(version.projectId) === 'greenfield') {
      let masterPlan: ProjectPlan | undefined
      try {
        masterPlan = loadProjectPlan(project.path)
      } catch (error) {
        return `o plano mestre está inválido; não subi a versão: ${error instanceof Error ? error.message : String(error)}`
      }
      if (!masterPlan)
        return 'o plano mestre deste projeto novo não foi encontrado; recupere-o antes de subir a versão'
      if (masterPlan.status === 'draft' || masterPlan.status === 'revision_pending') {
        return 'o plano mestre foi revisado e ainda aguarda aprovação explícita — aprove a revisão antes de publicar qualquer versão'
      }
      const blockers = projectPlanReleaseBlockers(masterPlan, {
        versionId: version.id,
        versionName: version.name
      })
      if (blockers.length > 0) {
        return (
          `a versão ${version.name} ainda contém ${blockers.length} missão(ões) futura(s) no plano mestre: ` +
          blockers.map((item) => `"${item.title}" [${item.id}]`).join(', ') +
          ' — conclua, adie para outra versão durante uma revisão aprovada ou remova do mapa explicitamente antes de publicar'
        )
      }
    }
    const queuedIntegrations = integrationQueue
      .listPending(version.projectId)
      .filter((ticket) => ticket.versionId === versionId)
    if (queuedIntegrations.length > 0) {
      return (
        `a versão ${version.name} ainda tem ${queuedIntegrations.length} missão(ões) na fila de integração: ` +
        queuedIntegrations
          .map((ticket) => {
            const mission = missions.get(ticket.missionId)
            return `#${ticket.position} "${mission?.title ?? ticket.missionId}" (${ticket.state})`
          })
          .join(', ') +
        ' — deixe a fila terminar antes de publicar a versão'
      )
    }
    if (!version.branch || !version.worktree)
      return `a versão ${version.name} ainda não tem branch — nenhuma missão dela integrou ainda`
    if (!versionIsolationIsValid(project.path, version))
      return `não subi a versão ${version.name}: a branch/worktree version/* não é exclusiva ou não pertence comprovadamente a este projeto. Repare a identidade antes do release.`
    if (isWorktreeClean(version.worktree) !== true)
      return `não subi a versão ${version.name}: o worktree dela tem alterações não commitadas. Finalize e valide esse conteúdo antes do release; o journal nunca cria commits escondidos.`
    const pending = missions
      .list(version.projectId)
      .filter((m) => m.versionId === versionId && (m.status === 'ativa' || m.status === 'integrando'))
    if (pending.length > 0)
      return `a versão ${version.name} ainda tem ${pending.length} missão(ões) em andamento: ${pending
        .map((m) => `"${m.title}"`)
        .join(', ')} — integre (ou arquive) antes de subir`
    // NADA pendente sobe junto (decisão do usuário): item de backlog aberto
    // na versão bloqueia o release — ou vira missão e é feito, ou é excluído.
    const openItems = backlog
      .listItems(version.projectId)
      .filter((i) => i.versionId === versionId && i.status !== 'feito')
    if (openItems.length > 0)
      return `a versão ${version.name} ainda tem ${openItems.length} item(ns) de backlog pendente(s): ${openItems
        .map((i) => `"${i.title}"`)
        .join(', ')} — faça (vire missão) ou exclua (remove_backlog_item) antes de subir`
    if (existsSync(versionReleaseIntentPath(project.path, version.id))) {
      return `a versão ${version.name} já possui um journal de publicação pendente; reinicie o Synkora para reconciliá-lo com segurança antes de tentar novamente`
    }
    let releaseIntent: VersionReleaseIntent
    try {
      releaseIntent = writeVersionReleaseIntent(project.path, {
        id: version.id,
        name: version.name,
        projectId: version.projectId,
        worktree: version.worktree
      })
    } catch (error) {
      return `não subi a versão: não consegui gravar o ponto seguro de recuperação (${error instanceof Error ? error.message : String(error)})`
    }
    codeIntelligence?.invalidateWorktreeNow(version.worktree)
    // git PESADO no worker (task #2): o release mergeia a versão inteira.
    const res = await gitOff(
      'mergeTaskWorktree',
      project.path,
      { dir: version.worktree, branch: version.branch },
      `release: ${version.name}`,
      undefined,
      {
        requireCleanSource: true,
        expectedSourceHead: releaseIntent.sourceHead,
        expectedTargetHead: releaseIntent.targetHead,
        expectedTargetBranch: releaseIntent.targetBranch
      }
    )
    const releaseAlignedAfterCommit =
      !res.ok && res.committed === true
        ? await gitOff('alignWorktreeFromSnapshot', project.path, releaseIntent.targetHead!)
        : false
    const releaseCleanupAfterAlignment = releaseAlignedAfterCommit
      ? await gitOff(
          'removeWorktreeAndBranch',
          project.path,
          version.worktree,
          version.branch,
          releaseIntent.sourceHead
        )
      : false
    const releaseOk =
      res.ok || (releaseAlignedAfterCommit && releaseCleanupAfterAlignment)
    const releaseDetail = releaseAlignedAfterCommit
      ? releaseCleanupAfterAlignment
        ? `${res.detail}; base alinhada e origem limpa na tentativa de reparo`
        : `${res.detail}; base alinhada, mas a origem foi preservada por divergência/lock`
      : res.detail
    if (!releaseOk) {
      if (!res.committed) clearVersionReleaseIntent(project.path, versionId)
      hub.publish({
        projectId: version.projectId,
        kind: 'error',
        text: res.committed
          ? `a versão ${version.name} foi gravada no Git, mas a base AGUARDA REPARO dos arquivos: ${res.detail}. Intent e branch foram preservados.`
          : `subida da versão ${version.name} FALHOU: ${res.detail}`,
        actor: 'harness'
      })
      return res.committed
        ? `release gravado, mas base aguardando reparo: ${res.detail}`
        : `falhou: ${res.detail}`
    }
    backlog.markVersionReleased(versionId)
    let planReconciled = true
    try {
      const masterPlan = completeStoredProjectPlanRelease(project.path, { versionId })
      if (masterPlan.status === 'done') {
        hub.publish({
          projectId: version.projectId,
          kind: 'info',
          text: 'plano mestre concluído: todas as missões terminaram e todas as versões planejadas subiram para a base',
          actor: 'harness'
        })
      }
    } catch {
      // O release real já ocorreu. A recuperação de boot reconcilia o plano.
      planReconciled = projectModeOf(version.projectId) !== 'greenfield'
    }
    emitBacklogChanged(version.projectId)
    syncBoard(version.projectId)
    hub.publish({
      projectId: version.projectId,
      kind: 'merge',
      text: `versão ${version.name} SUBIU para a ${currentBranch(project.path) ?? 'main'} (${releaseDetail}) — agora é a versão ATUAL do app`,
      actor
    })
    // a base avançou: missões ativas das OUTRAS versões precisam de sync
    for (const other of missions.list(version.projectId)) {
      if (other.status !== 'ativa' || !other.branch) continue
      hub.publish({
        projectId: version.projectId,
        missionId: other.id,
        kind: 'info',
        text: `a branch base avançou (versão ${version.name} subiu). A fila verificará sua branch antes da integração e abrirá sincronização + testes se necessário`,
        actor: 'harness'
      })
    }
    if (planReconciled) clearVersionReleaseIntent(project.path, versionId)
    return `versão ${version.name} subiu para a main (${releaseDetail}) — é a versão atual`
  }

  ipcMain.handle('backlog:releaseVersion', (e, versionId: string) => {
    bindUiSender(e.sender)
    return releaseVersionImpl(versionId, 'user')
  })

  interface StoredHelperRecovery {
    file: string
    relativePath: string
    record: HelperRecoveryRecord
  }

  function helperTranscriptPath(projectId: string, paneId: string): string | undefined {
    const project = projects.get(projectId)
    if (!project) return undefined
    const runsDir = join(project.path, '.synkora', 'runs')
    const exact = join(runsDir, `helper-${paneId}.md`)
    const legacy = join(runsDir, `helper-${paneId.slice(0, 8)}.md`)
    return existsSync(exact) || !existsSync(legacy) ? exact : legacy
  }

  function storedHelperRecoveries(projectId: string): StoredHelperRecovery[] {
    const project = projects.get(projectId)
    if (!project) return []
    const runsDir = join(project.path, '.synkora', 'runs')
    const entries: StoredHelperRecovery[] = []
    try {
      for (const name of readdirSync(runsDir).sort((left, right) => left.localeCompare(right, 'en'))) {
        if (!/^helper-.*\.md$/i.test(name)) continue
        const file = join(runsDir, name)
        try {
          const record = parseHelperRecoveryTranscript(readFileSync(file, 'utf-8').slice(0, 32_768))
          if (!record || record.projectId !== projectId) continue
          entries.push({ file, relativePath: `.synkora/runs/${name}`, record })
        } catch {
          // transcript legado/corrompido não entra no índice, mas é preservado
        }
      }
    } catch {
      // projeto ainda não possui runs
    }
    return entries
  }

  function updateStoredHelperStatus(
    projectId: string,
    paneId: string,
    status: HelperRecoveryStatus,
    statusAt = new Date().toISOString()
  ): HelperRecoveryRecord | undefined {
    const file = helperTranscriptPath(projectId, paneId)
    if (!file) return undefined
    try {
      ensureProjectRuntimeWritable(projectId)
      const current = readFileSync(file, 'utf-8')
      const updated = updateHelperRecoveryStatus(current, status, statusAt)
      if (updated.changed) writeFileSync(file, updated.transcript, 'utf-8')
      return updated.record
    } catch {
      return undefined
    }
  }

  // 🧹 LIMPEZA do .synkora (botão no chrome do Maestro): remove os .md e
  // marcadores SEM USO — transcripts de tarefas que não existem mais,
  // arquivos de missões que já eram (concluídas/excluídas), helpers e
  // marcadores órfãos. O que ainda serve (CONTEXT/BOARD/EVENTS, transcripts
  // de tarefas vivas, PLANs de missões ativas/arquivadas) FICA.
  /** VASSOURA do .synkora — a MESMA para o 🧹 manual, o boot e o pós-
   *  integração (bug real: a limpeza automática da integração não pegava os
   *  helper-*.md, e o modo plano multiplica ajudantes — o usuário achava o
   *  .synkora "cheio de lixo" e só o 🧹 manual resolvia). Poupa o que está
   *  VIVO: transcript de helper com pane aberto (o delegador ainda lê via
   *  helper_output) e marcador .done/.verdict de fase com watch ativo. */
  function sweepProjectFiles(
    projectId: string,
    opts: { preserveInterruptedHelpers?: boolean } = {}
  ): number {
    const project = projects.get(projectId)
    if (!project) return 0
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return 0
    }
    let removed = 0
    const zap = (full: string): void => {
      try {
        unlinkSync(full)
        removed++
      } catch {
        // best-effort
      }
    }
    const taskIds = new Set(tasks.list(projectId).map((t) => t.id))
    const allMissions = missions.list(projectId)
    const missionById = new Map(allMissions.map((m) => [m.id, m]))
    const liveShorts = new Set(
      allMissions.filter((m) => m.status !== 'concluida').map((m) => m.id.slice(0, 8))
    )
    // Transcript de tarefa de missão CONCLUÍDA/EXCLUÍDA também é lixo (bug
    // real: a tarefa segue existindo no board como done, então o filtro por
    // "tarefa inexistente" nunca pegava esses .md).
    const staleTaskIds = new Set(
      tasks
        .list(projectId)
        .filter((t) => {
          if (!t.missionId) return false
          const m = missionById.get(t.missionId)
          return !m || m.status === 'concluida'
        })
        .map((t) => t.id)
    )
    // helper-<paneId8>.md de pane VIVO não se toca — o delegador ainda lê
    const liveHelperShorts = new Set(
      hub
        .panesOf(projectId)
        .filter((p) => p.role === 'ajudante' && ptys.has(p.paneId))
        .flatMap((p) => [p.paneId, p.paneId.slice(0, 8)])
    )
    const runsDir = join(project.path, '.synkora', 'runs')
    try {
      for (const ent of readdirSync(runsDir)) {
        const full = join(runsDir, ent)
        if (/\.(done|verdict)$/.test(ent)) {
          // marcador de fase COM watch ativo é o fallback do report — fica
          const tid = ent.replace(/\.(done|(review|qa)\.verdict|verdict)$/i, '')
          if (!phaseWatches.has(tid)) zap(full)
        } else if (ent.startsWith('helper-')) {
          const short = ent.replace(/^helper-/, '').replace(/\..*$/, '')
          if (liveHelperShorts.has(short)) continue
          let belongsToOpenWork = false
          try {
            const record = parseHelperRecoveryTranscript(
              readFileSync(full, 'utf-8').slice(0, 32_768)
            )
            const ownerTask = record?.taskId ? tasks.get(record.taskId) : undefined
            const ownerMission = record?.missionId ? missions.get(record.missionId) : undefined
            belongsToOpenWork = Boolean(
              record &&
                ((ownerTask &&
                  ownerTask.projectId === projectId &&
                  ownerTask.status !== 'done' &&
                  (!ownerMission || ownerMission.status !== 'concluida')) ||
                  (!record.taskId &&
                    ownerMission?.projectId === projectId &&
                    ownerMission.status !== 'concluida') ||
                  (!record.taskId && !record.missionId && record.projectId === projectId))
            )
          } catch {
            // transcript legado segue a política antiga da vassoura
          }
          // Uma integração limpa o projeto inteiro, mas missões irmãs podem
          // continuar em paralelo. O transcript delas é estado recuperável,
          // não lixo da missão que acabou de integrar.
          if (!belongsToOpenWork && !opts.preserveInterruptedHelpers) zap(full)
        } else if (ent.startsWith('mission-')) {
          const short = ent.replace(/^mission-/, '').replace(/\..*$/, '')
          if (!liveShorts.has(short)) zap(full)
        } else if (/\.md$/.test(ent)) {
          const tid = ent.replace(/\.md$/, '')
          if (!taskIds.has(tid) || staleTaskIds.has(tid)) zap(full)
        }
      }
    } catch {
      // sem runs
    }
    const plansDir = join(project.path, '.synkora', 'missions')
    try {
      for (const ent of readdirSync(plansDir)) {
        const short = ent.replace(/\.PLAN\.md$/i, '')
        // plano de missão concluída já foi consolidado no CONTEXT.md pelo PM
        if (!liveShorts.has(short)) zap(join(plansDir, ent))
      }
    } catch {
      // sem planos
    }
    return removed
  }

  ipcMain.handle('maestro:cleanup', (e, projectId: string) => {
    bindUiSender(e.sender)
    if (!projects.get(projectId)) return 'projeto não encontrado'
    const removed = sweepProjectFiles(projectId)
    hub.publish({
      projectId,
      kind: 'info',
      text: `limpeza do .synkora: ${removed} arquivo(s) sem uso removido(s)`,
      actor: 'user',
      quiet: true
    })
    return `🧹 ${removed} arquivo(s) sem uso removido(s) do .synkora`
  })

  ipcMain.handle('backlog:listVersions', (_e, projectId: string) =>
    backlog.listVersions(projectId)
  )
  ipcMain.handle(
    'backlog:createVersion',
    (e, projectId: string, input: { name: string; theme?: string; goal?: string }) => {
      bindUiSender(e.sender)
      if (!input.name.trim()) return null
      // duplicada ou inferior à main → não cria (a UI só oferece opções
      // válidas; isto é a rede de segurança)
      if (backlog.validateNewVersion(projectId, input.name.trim())) return null
      const version = backlog.createVersion(projectId, { ...input, name: input.name.trim() })
      emitBacklogChanged(projectId)
      return version
    }
  )
  ipcMain.handle(
    'backlog:updateVersion',
    (e, id: string, patch: { name?: string; theme?: string; goal?: string }) => {
      bindUiSender(e.sender)
      const current = backlog.getVersion(id)
      if (!current) return null
      const nextName = patch.name?.trim()
      if (patch.name !== undefined && !nextName) return current
      if (
        nextName &&
        nextName.toLocaleLowerCase('pt-BR') !== current.name.toLocaleLowerCase('pt-BR')
      ) {
        if (backlog.validateVersionName(current.projectId, nextName, current.id)) return current
        const project = projects.get(current.projectId)
        if (projectModeOf(current.projectId) === 'greenfield' && project) {
          try {
            ensureSynkoraGitExcludes(project.path)
            const plan = loadProjectPlan(project.path)
            const referenced = plan?.roadmap.some(
              (item) =>
                item.version?.id === id ||
                item.release?.versionId === id ||
                item.version?.name.toLocaleLowerCase('pt-BR') ===
                  current.name.toLocaleLowerCase('pt-BR')
            )
            if (referenced) return current
          } catch {
            return current
          }
        }
      }
      const updated = backlog.updateVersion(id, {
        ...(nextName ? { name: nextName } : {}),
        ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
        ...(patch.goal !== undefined ? { goal: patch.goal } : {})
      })
      if (updated) emitBacklogChanged(updated.projectId)
      return updated ?? null
    }
  )
  ipcMain.handle('backlog:removeVersion', (e, projectId: string, id: string) => {
    bindUiSender(e.sender)
    // versão com branch viva: limpa worktree+branch (commits não subidos morrem
    // junto — exclusão é explícita e confirmada na UI)
    const version = backlog.getVersion(id)
    const project = projects.get(projectId)
    if (!version || version.projectId !== projectId || !project)
      return 'versão não encontrada neste projeto'
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch (error) {
      return `não excluí ${version.name}: ${error instanceof Error ? error.message : String(error)}`
    }
    const missionRefs = missions.list(projectId).filter((mission) => mission.versionId === id)
    if (missionRefs.length > 0) {
      return `não excluí ${version.name}: ela já está ligada a ${missionRefs.length} missão(ões) reais — arquive/revise o roadmap ou publique a versão; o histórico não pode ficar órfão`
    }
    if (projectModeOf(projectId) === 'greenfield') {
      let plan: ProjectPlan | undefined
      try {
        plan = loadProjectPlan(project.path)
      } catch (error) {
        return `não excluí ${version.name}: o plano mestre está inválido (${error instanceof Error ? error.message : String(error)})`
      }
      const planRefs =
        plan?.roadmap.filter(
          (item) =>
            item.release?.versionId === id ||
            item.version?.id === id ||
            item.version?.name.toLocaleLowerCase('pt-BR') ===
              version.name.toLocaleLowerCase('pt-BR')
        ) ?? []
      if (planRefs.length > 0) {
        return `não excluí ${version.name}: ela ainda aparece em ${planRefs.length} etapa(s) do plano mestre — revise e aprove o mapa antes de remover a versão`
      }
    }
    if (version.branch || version.worktree) {
      if (!versionIsolationIsValid(project.path, version)) {
        return `não excluí ${version.name}: a branch/worktree version/* não é exclusiva ou não pertence comprovadamente a este projeto`
      }
      const expectedHead = gitHead(version.worktree)
      if (!expectedHead) {
        return `não excluí ${version.name}: não consegui provar o commit atual do worktree da versão`
      }
      codeIntelligence?.invalidateWorktreeNow(version.worktree)
      if (
        !removeWorktreeAndBranch(
          project.path,
          version.worktree,
          version.branch,
          expectedHead
        )
      ) {
        return `não excluí ${version.name}: a limpeza segura da branch/worktree falhou; preservei o registro da versão para nova tentativa`
      }
    }
    backlog.removeVersion(id)
    emitBacklogChanged(projectId)
    return `versão ${version.name} excluída; os itens abertos foram movidos para a versão corrente`
  })
  ipcMain.handle('backlog:listItems', (_e, projectId: string) => backlog.listItems(projectId))
  ipcMain.handle(
    'backlog:createItem',
    (
      e,
      projectId: string,
      input: { title: string; type?: BacklogItemType; notes?: string; versionId?: string }
    ) => {
      bindUiSender(e.sender)
      if (!input.title.trim()) return null
      if (!projects.get(projectId)) return null
      if (input.versionId) {
        const version = backlog.getVersion(input.versionId)
        if (!version || version.projectId !== projectId) return null
      }
      const item = backlog.createItem(projectId, { ...input, title: input.title.trim() })
      emitBacklogChanged(projectId)
      return item
    }
  )
  ipcMain.handle(
    'backlog:updateItem',
    (
      e,
      projectId: string,
      id: string,
      patch: {
        title?: string
        notes?: string
        type?: BacklogItemType
        status?: 'pendente' | 'em-missao' | 'feito'
        versionId?: string | null
        missionId?: string | null
      }
    ) => {
      bindUiSender(e.sender)
      const current = backlog.getItem(id)
      if (!current || current.projectId !== projectId) return null
      if (typeof patch.versionId === 'string') {
        const version = backlog.getVersion(patch.versionId)
        if (!version || version.projectId !== projectId) return null
      }
      if (typeof patch.missionId === 'string') {
        const mission = missions.get(patch.missionId)
        if (!mission || mission.projectId !== projectId) return null
      }
      // null = limpar o campo (IPC não transporta undefined de forma distinta)
      const { versionId, missionId, ...rest } = patch
      const clean = {
        ...rest,
        ...(versionId !== undefined
          ? { versionId: versionId === null ? undefined : versionId }
          : {}),
        ...(missionId !== undefined
          ? { missionId: missionId === null ? undefined : missionId }
          : {})
      }
      const updated = backlog.updateItem(id, clean)
      emitBacklogChanged(projectId)
      return updated ?? null
    }
  )
  ipcMain.handle('backlog:removeItem', (e, projectId: string, id: string) => {
    bindUiSender(e.sender)
    const current = backlog.getItem(id)
    if (!current || current.projectId !== projectId) return false
    backlog.removeItem(id)
    emitBacklogChanged(projectId)
    return true
  })

  // Excluir missão: só ARQUIVADA (fluxo: arquivar → excluir). Leva junto as
  // tarefas dela e limpa worktree/branch — a exclusão é deliberada.
  ipcMain.handle('missions:remove', (e, missionId: string) => {
    bindUiSender(e.sender)
    const mission = missions.get(missionId)
    if (!mission || mission.status !== 'arquivada') return false
    const project = projects.get(mission.projectId)
    if (!project) return false
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch (error) {
      // Guard MUDO era bug real (02/08): .synkora versionado na base fazia o
      // "excluir de vez" morrer sem NENHUMA mensagem — o usuário clicava e
      // nada acontecia. Falha de guard sempre fala.
      hub.publish({
        projectId: mission.projectId,
        kind: 'error',
        text: `não excluí a missão "${mission.title}": ${error instanceof Error ? error.message : String(error)}`,
        actor: 'harness'
      })
      return false
    }
    const queued = integrationQueue.getByMission(missionId)
    if (queued?.state === 'merging') return false
    if (queued) integrationQueue.cancel(missionId)
    const planError = transitionLinkedProjectPlanMission(
      mission.projectId,
      missionId,
      'detach'
    )
    if (planError) {
      hub.publish({
        projectId: mission.projectId,
        kind: 'error',
        text: `não excluí a missão "${mission.title}": ${planError}`,
        actor: 'harness'
      })
      return false
    }
    stopMissionExecution(
      mission.projectId,
      missionId,
      'execução encerrada porque a missão arquivada foi excluída'
    )
    ptys.kill(orchPaneId(mission.projectId, missionId))
    if (mission.branch && mission.worktree) {
      codeIntelligence?.invalidateWorktreeNow(mission.worktree)
      removeWorktreeAndBranch(project.path, mission.worktree, mission.branch)
    }
    for (const t of tasks.list(mission.projectId).filter((x) => x.missionId === missionId)) {
      tasks.remove(t.id)
    }
    backlog.releaseMissionItems(missionId) // itens não-feitos voltam a pendente
    missions.remove(missionId)
    emitBacklogChanged(mission.projectId)
    // rastro da missão some junto: plano, transcript/veredito do gate e o
    // estado do orquestrador no maestroStore
    const short = missionId.slice(0, 8)
    for (const f of [
      join(project.path, '.synkora', 'missions', `${short}.PLAN.md`),
      join(project.path, '.synkora', 'runs', `mission-${short}.md`),
      join(project.path, '.synkora', 'runs', `mission-${short}.verdict`)
    ]) {
      try {
        unlinkSync(f)
      } catch {
        // nunca existiu
      }
    }
    maestro.forget(orchKey(mission.projectId, missionId))
    hub.purgeMissionEvents(mission.projectId, missionId)
    hub.publish({
      projectId: mission.projectId,
      kind: 'info',
      text: `missão "${mission.title}" EXCLUÍDA (tarefas${mission.branch ? ` e branch ${mission.branch}` : ''} removidas)`,
      actor: 'user'
    })
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', mission.projectId)
    emitMissionsChanged(mission.projectId)
    syncBoard(mission.projectId)
    return true
  })

  // TETO DE CUSTO DO RESUME DO PM/ORQUESTRADOR (pedido do usuário, 2026-08-06:
  // "eles não podem ter que reler a conversa toda — principalmente o maestro,
  // que nunca morre"): mesmo racional do RESUME_CONTEXT_BUDGET_TOKENS da fase
  // dev (F6.8e) — o resume reprocessa a conversa INTEIRA como input no 1º
  // turno. Acima do teto, a conversa não é retomada: o pane nasce fresco e se
  // reergue pelos arquivos duráveis (PM: .synkora/MAESTRO.md + BOARD.md +
  // board_status; orquestrador: caderno PLAN.md + board_status). A conversa é
  // descartável por desenho; o caderno é a memória.
  const MAESTRO_RESUME_BUDGET_TOKENS = 150_000
  function maestroResumeOverBudget(key: string): number | undefined {
    const st = maestro.get(key)
    if (!st.tuiSessionId) return undefined
    const ctx = st.tuiContextTokens ?? 0
    return ctx > MAESTRO_RESUME_BUDGET_TOKENS ? ctx : undefined
  }
  function skipMaestroResume(
    key: string,
    overBudget: number,
    ids: { projectId: string; missionId?: string; paneId: string }
  ): void {
    blackbox.record({
      cat: 'pane',
      event: 'maestro-resume-skipped-cost',
      actor: 'harness',
      ids: { ...ids, role: 'maestro' },
      reason: `conversa com ~${Math.round(overBudget / 1000)}k tokens de contexto — o resume custaria o replay integral; pane nasce fresco sobre o caderno durável`,
      detail: { tuiContextTokens: overBudget, budget: MAESTRO_RESUME_BUDGET_TOKENS }
    })
    maestro.update(key, { tuiSessionId: undefined, tuiContextTokens: undefined })
  }

  // Spec do pane TUI do ORQUESTRADOR da missão (mesma mecânica do PM: persona
  // via --append-system-prompt/1º prompt + resume + MCP). O seat é herdado do
  // PM na primeira abertura e fica preso à missão (sessão pertence ao seat).
  // ESCALONADOR DE SPAWN (CHECK 1 adendo, 2026-08-07): abrir o projeto pedia
  // TODOS os orquestradores + PM no MESMO segundo (medido: 4 claudes às
  // 15:12:20 + 4 skill syncs + stall de 2,1s — "saio clicando as missões e
  // fica lagando"). Espaçar as respostas de paneSpec em ~350ms desfaz a
  // rajada sem mudar a decisão "orquestradores sempre vivos".
  let paneSpecStaggerUntil = 0
  async function staggerPaneSpawn(): Promise<void> {
    const MIN_GAP_MS = 350
    const now = Date.now()
    const wait = Math.max(0, paneSpecStaggerUntil - now)
    paneSpecStaggerUntil = Math.max(now, paneSpecStaggerUntil) + MIN_GAP_MS
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }

  ipcMain.handle('missions:paneSpec', async (e, projectId: string, missionId: string) => {
    bindUiSender(e.sender)
    await staggerPaneSpawn()
    const project = projects.get(projectId)
    let mission = missions.get(missionId)
    if (!project || !mission || mission.projectId !== projectId) return null
    if (mission.status === 'concluida' || mission.status === 'arquivada') return null
    // Missão criada pelo PM aguardando a escolha de conta/modelo/effort no
    // modal: o orquestrador NÃO nasce com fallback silencioso (decisão do
    // usuário, 02/08) — o Board mostra o modal e chama confirmOrchestrator.
    if (mission.pendingOrchestrator) return null
    // Integração EM VOO: o harness matou este pane DE PROPÓSITO
    // (completeMissionMerge fecha o orquestrador ANTES do merge — um processo
    // com cwd no worktree travaria a remoção) e o Board reage à morte
    // rebuscando esta spec. Renascer aqui recoloca um claude DENTRO do
    // worktree que a limpeza vai remover (caso real M02d 06/08: o orquestrador
    // ressuscitado virou o próprio lock e a fila pausou em
    // target_repair_pending). Rota de saída garantida: sucesso → 'concluida'
    // (nunca respawna); falha → 'ativa' + missions:changed → o Board rebusca e
    // o pane nasce para executar o reparo; crash no meio → o recovery de boot
    // solta 'integrando' para 'ativa'.
    if (mission.status === 'integrando') {
      blackbox.record({
        cat: 'pane',
        event: 'orchestrator-respawn-refused-integration-in-flight',
        ids: { projectId, missionId, paneId: orchPaneId(projectId, missionId) },
        actor: 'harness',
        reason:
          'integração em voo: o pane do orquestrador foi fechado de propósito antes do merge; renascer agora seguraria a remoção do worktree'
      })
      return null
    }
    // pasta do projeto sumiu (renomeada fora do app) — relocar antes de abrir
    if (!existsSync(project.path)) return null
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch (error) {
      // Mesmo guard mudo do missions:remove (02/08): sem esta mensagem o
      // orquestrador simplesmente NÃO abria e nada explicava o porquê.
      hub.publish({
        projectId,
        missionId,
        kind: 'error',
        text: `não abri o orquestrador de "${mission.title}": ${error instanceof Error ? error.message : String(error)}`,
        actor: 'harness',
        urgent: true
      })
      return null
    }
    // Promove missão antiga sem Git e também tenta reanexar um worktree que
    // desapareceu. Mesmo após a tentativa, projeto Git só abre isolado.
    const missionProjectMode = projectModeOf(projectId)
    try {
      ensureProjectSecurityBaseline(project.path, {
        installRepositoryAdapters: missionProjectMode === 'greenfield',
        projectName: project.name
      })
    } catch {
      // Existing projects retain the trusted system policy for compatibility;
      // a new app does not start work without materializing its local baseline.
      if (missionProjectMode === 'greenfield') {
        hub.publish({
          projectId,
          missionId,
          kind: 'error',
          text: `não abri o orquestrador de "${mission.title}": não foi possível preparar a política local de segurança`,
          actor: 'harness',
          urgent: true
        })
        return null
      }
    }
    const before = mission.branch
    mission = ensureMissionWorktree(missionId) ?? mission
    if (mission.branch && mission.branch !== before) {
      hub.publish({
        projectId,
        kind: 'info',
        text: `missão "${mission.title}" promovida: agora tem branch própria (${mission.branch})`,
        actor: 'harness',
        quiet: true
      })
      emitMissionsChanged(projectId)
    }
    const missionCwd = missionWorkspacePath(project.path, mission)
    if (!missionCwd) {
      hub.publish({
        projectId,
        missionId,
        kind: 'error',
        text: `não foi possível provar o worktree isolado da missão "${mission.title}"; o orquestrador não será aberto na branch principal`,
        actor: 'harness',
        urgent: true
      })
      return null
    }
    const key = orchKey(projectId, missionId)
    let state = maestro.get(key)
    // Seat do orquestrador: o escolhido no modal da missão > o já usado nesta
    // missão > herdado do PM.
    const seatId = mission.seatId ?? state.seatId ?? maestro.get(projectId).seatId
    const seat = seatId ? seats.get(seatId) : undefined
    if (!seat) return null
    if (state.seatId !== seatId) maestro.update(key, { seatId })
    seats.preseed(seat)
    const paneId = orchPaneId(projectId, missionId)
    // Conversa acima do teto de custo: não retoma — nasce fresco com o caderno.
    const resumeOverBudget = maestroResumeOverBudget(key)
    if (resumeOverBudget !== undefined) {
      skipMaestroResume(key, resumeOverBudget, { projectId, missionId, paneId })
      state = maestro.get(key)
    }
    if (ptys.has(paneId)) ptys.kill(paneId)
    unregisterPane(paneId)
    const cwd = missionCwd
    const planningRun = await preparePlanningRun({ paneId, projectId, missionId, cwd })
    if (!planningRun.ok) {
      hub.publish({
        projectId,
        missionId,
        kind: 'error',
        text: `não abri o orquestrador: ${planningRun.message}`,
        actor: 'harness',
        urgent: true
      })
      return null
    }
    const missionRuntimeRisk = assessMissionRisk({
      texts: [mission.title, mission.goal, mission.scope]
    })
    let armed: ReturnType<typeof armPane>
    try {
      armed = armPane(
        { paneId, projectId, role: 'maestro', missionId, cwd, seatId: seat.id },
        seat.cli,
        {
          strictMcp: true,
          configDir: seats.configDirOf(seat),
          sensitive:
            missionRuntimeRisk.effectiveRisk === 'high' ||
            requiresManualSecurityValidation(missionRuntimeRisk.surfaces)
        }
      )
    } catch {
      releasePaneSkillLease(paneId)
      releasePaneSkillPlan(paneId)
      hub.publish({
        projectId,
        missionId,
        kind: 'error',
        text: 'não abri o orquestrador: falha ao armar o pane com o método de planejamento',
        actor: 'harness',
        urgent: true
      })
      return null
    }
    // Plano de ondas PERSISTENTE da missão: memória do orquestrador que
    // sobrevive a fechamento do app/sessão perdida (fica no projeto, não no
    // worktree — sobrevive também à integração/limpeza).
    const plansDir = join(project.path, '.synkora', 'missions')
    mkdirSync(plansDir, { recursive: true })
    const planFile = join(plansDir, `${missionId.slice(0, 8)}.PLAN.md`)
    const personaWithPlanning = `${missionPersona(mission, planFile)}${planningRun.skillBlock}`
    const cliArgs = [...armed.cliArgs]
    // Effort do orquestrador (validado: claude tem --effort low..max; codex
    // usa a chave de config). No codex o -c é global e PRECISA vir antes do
    // subcomando resume — por isso entra aqui, antes dos blocos de resume.
    if (mission.effort) {
      if (seat.cli === 'claude') cliArgs.push('--effort', mission.effort)
      else cliArgs.push('-c', `model_reasoning_effort="${mission.effort}"`)
    }
    let initialPrompt: string | undefined
    let appendSystemPrompt: string | undefined
    // Sem intro o pane abre MUDO e o usuário acha que o contexto não chegou —
    // a 1ª sessão sempre se apresenta lendo o plano e declarando goal/escopo.
    // Missão criada à MÃO (goal magro) ≠ missão vinda do PM (goal-briefing
    // rico): com goal curto o usuário vai explicar AQUI — o orquestrador não
    // sai adivinhando nem abrindo interrogatório (feedback real, 2026-07-28).
    const goalRich = (mission.goal ?? '').trim().length >= 80
    // Apresentação é a PRIMEIRA saída, antes de qualquer tool call: o usuário
    // via um pane trabalhando mudo sem saber de que missão se tratava (caso
    // real 2026-08-05). E o caderno PLAN.md é NOMEADO — "o plano não existe"
    // soava como se o briefing do Maestro tivesse se perdido.
    const introPrompt = resumeOverBudget !== undefined
      ? `Your previous conversation was NOT resumed on purpose (~${Math.round(resumeOverBudget / 1000)}k tokens of context — replaying it would burn a real slice of the account limit; deliberate economy, no work lost). Your VERY FIRST output — before ANY tool call — is a 2-3 line PT-BR note telling the user exactly that. THEN rebuild your working memory from the durable files: read your mission notebook .synkora/missions/${missionId.slice(0, 8)}.PLAN.md (if missing, say so and recreate it as you go), call board_status, and continue from where the notebook says. Do NOT re-plan from scratch, do NOT re-create existing cards, do NOT re-ask questions the user already answered.`
      : goalRich
      ? 'Your VERY FIRST output — before ANY tool call — is a 2-3 line introduction (PT-BR) as the orchestrator of this mission: restate the mission goal and scope you were given. ONLY THEN read your mission PLAN.md notebook if it exists (.synkora/missions/<id>.PLAN.md — your own persistent notebook, not the master plan nor the briefing; if missing, say "o caderno PLAN.md desta missão ainda não existe — normal em missão nova", NEVER the ambiguous "o plano não existe"). If the goal is already clear enough to plan, STUDY the project now and propose the plan via create_plan (the user reads and approves it on the board); if not, ask what is missing. NEVER create work cards before the plan is approved.'
      : 'Your VERY FIRST output — before ANY tool call — is a 1-2 line introduction (PT-BR) inviting the user to explain the mission: it was created with only a short title/goal and they will explain what they want HERE, in their next message. Then read your mission PLAN.md notebook if it exists (.synkora/missions/<id>.PLAN.md — your own persistent notebook; if missing, say "o caderno PLAN.md desta missão ainda não existe — normal em missão nova"). Do NOT guess the scope, do NOT open a detailed questionnaire and do NOT propose any plan yet — wait for their explanation first.'
    if (seat.cli === 'claude') {
      appendSystemPrompt = personaWithPlanning
      if (state.tuiSessionId) cliArgs.push('--resume', state.tuiSessionId)
      else initialPrompt = introPrompt
    } else {
      // Mantem o papel do orquestrador inclusive apos /new e em resume.
      cliArgs.push('-c', codexDeveloperInstructions(personaWithPlanning))
      if (state.tuiSessionId) cliArgs.push('resume', state.tuiSessionId)
      else initialPrompt = introPrompt
    }
    return {
      paneId,
      kind: seat.cli,
      seatId: seat.id,
      cwd,
      cliArgs,
      initialPrompt,
      appendSystemPrompt,
      // modelo escolhido no modal da missão (--model no spawn do pane)
      model: mission.model,
      missionId
    }
  })

  function makeEmitter(sender: Electron.WebContents, projectId: string) {
    return (evt: MaestroEvent): void => {
      maestro.appendLog(projectId, evt)
      if (!sender.isDestroyed()) sender.send('maestro:event', evt)
    }
  }

  ipcMain.handle('maestro:getState', (e, projectId: string) => {
    bindUiSender(e.sender)
    const state = maestro.get(projectId)
    return {
      log: state.log,
      contextTokens: state.contextTokens ?? null,
      contextLimit: state.contextLimit ?? null,
      contextWindow: state.contextWindow ?? null,
      model: state.model ?? null,
      effort: state.effort ?? null,
      sessionId: state.sessionId ?? null,
      bypass: !state.bypassOff,
      sensitiveBypassOk: state.sensitiveAutoOk === true,
      seatId: state.seatId ?? null,
      version: state.version ?? null
    }
  })

  ipcMain.handle('maestro:setEffort', (e, projectId: string, effort: string) => {
    maestro.update(projectId, { effort: effort || undefined })
    // Painel de fundo renasce com o novo --effort no próximo envio (mesma sessão via --resume).
    killMaestroSession(projectId)
    makeEmitter(e.sender, projectId)({
      kind: 'ok',
      text: `effort do maestro: ${effort || 'padrão do modelo'}`
    })
  })

  ipcMain.handle('maestro:setContextLimit', (e, projectId: string, limit: number) => {
    // limit <= 0 = automático: o medidor volta a usar a janela real do modelo.
    maestro.update(projectId, { contextLimit: limit > 0 ? limit : undefined })
    makeEmitter(e.sender, projectId)({
      kind: 'ok',
      text:
        limit > 0
          ? `limite de contexto do maestro: ${Math.round(limit / 1000)}k`
          : 'medidor de contexto no automático (janela real do modelo)'
    })
  })

  // Emissores baseados no uiSender atual: a sessão persistente sobrevive a
  // reloads do renderer, então os eventos vão sempre para a janela mais recente.
  function emitLog(projectId: string, evt: MaestroEvent): void {
    maestro.appendLog(projectId, evt)
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('maestro:event', evt)
  }
  function emitLive(evt: unknown): void {
    if (uiSender && !uiSender.isDestroyed()) uiSender.send('maestro:live', evt)
  }

  // Traduz os eventos crus do painel de fundo em log persistido + live da UI.
  function sessionSink(
    projectId: string,
    box: { session?: MaestroBackend }
  ): (evt: SessionEvent) => void {
    const isCurrent = (): boolean => maestroSessions.get(projectId) === box.session
    return (evt) => {
      switch (evt.type) {
        case 'init':
          maestro.update(projectId, {
            sessionId: evt.sessionId,
            ...(evt.contextWindow ? { contextWindow: evt.contextWindow } : {})
          })
          if (box.session?.announceOnce()) {
            emitLog(projectId, {
              kind: 'log',
              tag: 'maestro',
              text: `sessão aberta · ${evt.model} · modo ${evt.permissionMode} · ${evt.toolCount} ferramentas`
            })
          }
          break
        case 'session-id':
          maestro.update(projectId, { sessionId: evt.sessionId })
          break
        case 'delta':
          emitLive({ type: 'delta', text: evt.text })
          break
        case 'thinking':
          emitLive({ type: 'thinking' })
          break
        case 'text': {
          // Bloco de texto final do turno: extrai <tasks> e persiste a fala.
          const match = evt.text.match(/<tasks>([\s\S]*?)<\/tasks>/)
          const items = match ? parseTasksJson(match[1]) : []
          const text = (match ? evt.text.replace(match[0], '') : evt.text).trim()
          emitLive({ type: 'flush' })
          if (text) emitLog(projectId, { kind: 'say', text })
          if (items.length > 0) {
            const unplannedRisk = assessMissionRisk({
              texts: items.flatMap((item) => [item.title, item.description])
            })
            if (unplannedRisk.surfaces.length > 0) {
              emitLog(projectId, {
                kind: 'err',
                text:
                  `cards legados recusados: o pedido toca ${unplannedRisk.surfaces.join(', ')}. ` +
                  'Trabalho com superfície de risco precisa nascer em uma missão e seguir um plano aprovado; nenhum card avulso foi criado.'
              })
              break
            }
            const created = tasks.createMany(projectId, items)
            for (const t of created)
              emitLog(projectId, { kind: 'log', tag: t.department, text: t.title })
            emitLog(projectId, {
              kind: 'ok',
              text: `${created.length} tarefas criadas no backlog`
            })
            if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', projectId)
            syncBoard(projectId)
          }
          break
        }
        case 'tool':
          emitLog(projectId, {
            kind: 'tool',
            tag: 'maestro',
            text: toolLabel(evt.name, evt.input),
            detail: JSON.stringify(evt.input, null, 2).slice(0, 2000)
          })
          break
        case 'tool-result':
          emitLog(projectId, {
            kind: 'out',
            text: `${evt.isError ? '✗ ' : ''}${evt.text}`
          })
          break
        case 'permission':
          emitLive(evt)
          break
        case 'permission-cancel':
          emitLive(evt)
          break
        case 'ready':
          // Handshake respondeu: anuncia o painel com os dados REAIS da conta.
          if (box.session && !box.session.readyAnnounced) {
            box.session.readyAnnounced = true
            const acc = evt.caps.account
            const cmds = evt.caps.commands.length
            emitLog(projectId, {
              kind: 'log',
              tag: 'maestro',
              text: `painel de fundo pronto · ${acc?.email ?? 'conta ?'}${acc?.subscriptionType ? ` (${acc.subscriptionType})` : ''}${cmds > 0 ? ` · ${cmds} comandos` : ''} · ${evt.caps.models.length} modelos`
            })
          }
          break
        case 'command-output':
          emitLog(projectId, { kind: 'out', text: evt.text })
          break
        case 'limit':
          emitLog(projectId, { kind: 'err', text: evt.text })
          break
        case 'result':
          if (box.session) finishProgressMaestroTurn(projectId, box.session)
          if (evt.contextTokens) {
            maestro.update(projectId, {
              contextTokens: evt.contextTokens,
              ...(evt.contextWindow ? { contextWindow: evt.contextWindow } : {})
            })
            if (uiSender && !uiSender.isDestroyed())
              uiSender.send('maestro:ctx', evt.contextTokens)
          }
          if (evt.isError && evt.errorText)
            emitLog(projectId, { kind: 'err', text: evt.errorText })
          // fast mode ligado mas o CLI reportou off (ex.: modelo sem suporte).
          if (
            evt.fastModeState &&
            evt.fastModeState !== 'on' &&
            maestro.get(projectId).fastMode &&
            box.session instanceof MaestroSession &&
            !box.session.fastWarned
          ) {
            box.session.fastWarned = true
            emitLog(projectId, {
              kind: 'log',
              tag: 'maestro',
              text: `fast mode pedido mas o CLI reporta "${evt.fastModeState}" — só modelos Opus suportam`
            })
          }
          emitLive({ type: 'turn-end' })
          break
        case 'fatal':
          if (box.session) finishProgressMaestroTurn(projectId, box.session)
          if (isCurrent()) {
            emitLog(projectId, { kind: 'err', text: evt.text })
            emitLive({ type: 'turn-end' })
          }
          break
        case 'closed':
          if (box.session) finishProgressMaestroTurn(projectId, box.session)
          // Só reage se ESTA sessão ainda é a atual (kill+respawn dispara
          // 'closed' atrasado da antiga — não pode derrubar a nova).
          if (isCurrent()) {
            maestroSessions.delete(projectId)
            emitLive({ type: 'exit' })
          }
          break
      }
    }
  }

  // Garante o painel de fundo vivo para o projeto+seat (respawn se preciso).
  // Não manda nada — spawn + handshake não gastam tokens.
  function ensureSession(projectId: string, seatId?: string): MaestroBackend | null {
    const project = projects.get(projectId)
    if (!project) return null
    const seat = seatId ? seats.get(seatId) : undefined
    const configDir = seat ? seats.configDirOf(seat) : undefined
    let state = maestro.get(projectId)

    // Sessão pertence ao seat (config dir): trocar de seat exige sessão nova.
    // Modelo/effort são POR CLI — sem reset, um gpt-5.6 vazaria para o claude.
    if (state.sessionId && (state.seatId ?? '') !== (seatId ?? '')) {
      emitLog(projectId, {
        kind: 'log',
        tag: 'maestro',
        text: 'seat trocado — sessão nova (modelo e effort resetados)'
      })
      killMaestroSession(projectId)
      maestro.update(projectId, {
        sessionId: undefined,
        personaSent: false,
        model: undefined,
        effort: undefined,
        contextWindow: undefined,
        seatId
      })
      state = maestro.get(projectId)
    }
    maestro.update(projectId, { seatId })

    if (seat) seats.preseed(seat)
    const isCodex = seat?.cli === 'codex'
    // Claude must receive the same trusted PM contract at system priority as
    // Codex receives through developerInstructions. If the prompt file could
    // not be materialized, fail closed instead of downgrading it to user text.
    if (!isCodex && !maestroSystemPromptFile) return null
    // Threads do codex são gravadas com prefixo próprio para o resume certo.
    const codexThread = state.sessionId?.startsWith('codex-thread:')
      ? state.sessionId.slice('codex-thread:'.length)
      : undefined
    const desired = {
      cwd: project.path,
      configDir,
      resumeSessionId: isCodex ? codexThread : state.sessionId,
      model: state.model,
      effort: state.effort,
      fastMode: state.fastMode,
      systemPromptFile: isCodex ? undefined : maestroSystemPromptFile
    }
    let session = maestroSessions.get(projectId)
    const wrongKind = session && isCodex !== session instanceof CodexSession
    if (!session || wrongKind || !session.alive || !session.matches(desired)) {
      killMaestroSession(projectId)
      const box: { session?: MaestroBackend } = {}
      session = isCodex
        ? new CodexSession(desired, PERSONA_DEV, sessionSink(projectId, box))
        : new MaestroSession(desired, sessionSink(projectId, box))
      box.session = session
      if (!isCodex) {
        session.personaSent = true
        maestro.update(projectId, { personaSent: true })
      }
      maestroSessions.set(projectId, session)
    }
    return session
  }

  ipcMain.handle(
    'maestro:send',
    (e, projectId: string, message: string, seatId?: string) => {
      bindUiSender(e.sender)
      const project = projects.get(projectId)
      if (!project) {
        emitLog(projectId, { kind: 'err', text: 'projeto não encontrado' })
        emitLive({ type: 'turn-end' })
        return
      }
      emitLog(projectId, { kind: 'cmd', text: message })

      // Garante o painel de fundo vivo (claude ou codex, mesma interface).
      const session = ensureSession(projectId, seatId)
      if (!session) {
        emitLog(projectId, { kind: 'err', text: 'não consegui abrir o painel de fundo' })
        emitLive({ type: 'turn-end' })
        return
      }
      // Comandos / vão CRUS para o painel (como no TUI) — sem persona na frente.
      const isSlash = message.trimStart().startsWith('/')
      // Claude /fast: o comando é bloqueado em modo SDK, mas a CHAVE de
      // settings liga o fast mode real — toggle + respawn com --resume.
      if (isSlash && message.trim() === '/fast' && session instanceof MaestroSession) {
        const fast = !maestro.get(projectId).fastMode
        maestro.update(projectId, { fastMode: fast || undefined })
        killMaestroSession(projectId)
        emitLog(projectId, {
          kind: 'ok',
          text: fast
            ? 'fast mode ATIVADO — vale a partir da próxima mensagem (requer modelo Opus; sessão continua via --resume)'
            : 'fast mode desativado'
        })
        emitLive({ type: 'turn-end' })
        return
      }
      // Codex: comandos slash viram o RPC real correspondente (runSlash).
      if (isSlash && session instanceof CodexSession) {
        beginProgressMaestroTurn(projectId, session)
        let accepted = false
        try {
          accepted = session.runSlash(message)
        } catch (error) {
          finishProgressMaestroTurn(projectId, session)
          throw error
        }
        if (!accepted) {
          finishProgressMaestroTurn(projectId, session)
          emitLog(projectId, {
            kind: 'err',
            text: `o painel codex não tem ${message.trim().split(/\s+/)[0]} — digite / para ver a lista`
          })
          emitLive({ type: 'turn-end' })
        }
        return
      }
      beginProgressMaestroTurn(projectId, session)
      try {
        session.send(message)
      } catch (error) {
        finishProgressMaestroTurn(projectId, session)
        throw error
      }
    }
  )

  // Capacidades reais do painel (comandos, modelos, conta) — spawna o painel
  // se preciso; o handshake não gasta tokens.
  ipcMain.handle('maestro:capabilities', async (e, projectId: string, seatId?: string) => {
    bindUiSender(e.sender)
    const session = ensureSession(projectId, seatId)
    if (!session) return null
    return session.waitCaps()
  })

  ipcMain.handle(
    'maestro:permission',
    (e, projectId: string, requestId: string, choice: PermissionChoice) => {
      bindUiSender(e.sender)
      const info = maestroSessions.get(projectId)?.answerPermission(requestId, choice)
      if (info) {
        const verdict =
          choice === 'deny'
            ? '✗ negado'
            : choice === 'allow-always'
              ? '✓ permitido (sempre nesta sessão)'
              : '✓ permitido'
        emitLog(projectId, {
          kind: 'ask',
          text: `${verdict} — ${info.toolName} ${info.description}`.trim()
        })
      }
    }
  )

  // /estudar roda FORA do painel — o ⏹ precisa de um caminho próprio.
  const surveyAborts = new Map<string, () => void>()

  ipcMain.handle('maestro:interrupt', (e, projectId: string) => {
    bindUiSender(e.sender)
    const abortSurvey = surveyAborts.get(projectId)
    if (abortSurvey) {
      emitLog(projectId, { kind: 'log', tag: 'maestro', text: '⏹ interrompendo o /estudar…' })
      abortSurvey()
      return
    }
    const session = maestroSessions.get(projectId)
    if (session?.alive) {
      emitLog(projectId, { kind: 'log', tag: 'maestro', text: '⏹ interrompendo o turno…' })
      session.interrupt()
    } else {
      emitLog(projectId, { kind: 'log', tag: 'maestro', text: 'nada rodando para interromper' })
      emitLive({ type: 'turn-end' })
    }
  })

  // /estudar num seat CODEX: sessão dedicada do app-server em sandbox
  // read-only e aprovação never — explora à vontade, não escreve nada.
  function surveyViaCodex(
    projectId: string,
    cwd: string,
    configDir: string | undefined,
    onTool: (evt: MaestroEvent) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let last = ''
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        surveyAborts.delete(projectId)
        fn()
        session.kill()
      }
      const session: CodexSession = new CodexSession(
        {
          cwd,
          configDir,
          sandbox: 'read-only',
          approvalPolicy: 'never'
        },
        'Você explora repositórios e produz briefs técnicos completos. Responda sempre em PT-BR.\n\n' +
          SURVEY_SECURITY_PROMPT,
        (evt) => {
          switch (evt.type) {
            case 'tool':
              onTool({
                kind: 'tool',
                tag: 'maestro',
                text: toolLabel(evt.name, evt.input),
                detail: JSON.stringify(evt.input, null, 2).slice(0, 2000)
              })
              break
            case 'text':
              last = evt.text
              break
            case 'permission':
              // não deveria acontecer em read-only — nega para não travar
              session.answerPermission(evt.requestId, 'deny')
              break
            case 'result':
              done(() =>
                evt.isError
                  ? reject(new Error(evt.errorText ?? 'survey falhou'))
                  : resolve(last)
              )
              break
            case 'fatal':
              done(() => reject(new Error(evt.text)))
              break
            default:
              break
          }
        }
      )
      surveyAborts.set(projectId, () => session.interrupt())
      session.send(SURVEY_PROMPT)
    })
  }

  ipcMain.handle(
    'maestro:survey',
    async (e, projectId: string, seatId?: string) => {
      bindUiSender(e.sender)
      const emit = makeEmitter(e.sender, projectId)
      const project = projects.get(projectId)
      if (!project) {
        emit({ kind: 'err', text: 'projeto não encontrado' })
        return
      }
      try {
        ensureSynkoraGitExcludes(project.path)
      } catch (error) {
        emit({ kind: 'err', text: error instanceof Error ? error.message : String(error) })
        return
      }
      const seat = seatId ? seats.get(seatId) : undefined
      const configDir = seat ? seats.configDirOf(seat) : undefined
      if (seat) seats.preseed(seat)
      const state = maestro.get(projectId)

      emit({ kind: 'cmd', text: 'maestro estudar' })
      emit({ kind: 'log', tag: 'maestro', text: `mapeando o projeto… (${seat?.cli ?? 'claude'})` })
      const progressSurveyToken = beginProgressHeadlessActivity(projectId, 'survey')
      try {
        if (seat?.cli !== 'codex' && !surveySystemPromptFile) {
          throw new Error(
            'não foi possível materializar a política de sistema do survey; o /estudar foi bloqueado para não executar com prioridade reduzida'
          )
        }
        const brief =
          seat?.cli === 'codex'
            ? await surveyViaCodex(projectId, project.path, configDir, emit)
            : await survey(
                {
                  cwd: project.path,
                  systemPromptFile: surveySystemPromptFile,
                  configDir,
                  model: state.model,
                  registerKill: (kill) => surveyAborts.set(projectId, kill)
                },
                emit
              )
        if (!brief.trim()) throw new Error('o brief voltou vazio')
        ensureSynkoraGitExcludes(project.path)
        const dir = join(project.path, '.synkora')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'CONTEXT.md'), brief, 'utf-8')
        // Sessão nova (painel incluso) para a próxima conversa nascer lendo o
        // dossiê fresco — sem matar o painel, o contexto antigo continuaria.
        killMaestroSession(projectId)
        maestro.update(projectId, { sessionId: undefined, personaSent: false })
        emit({ kind: 'ok', text: 'dossiê salvo em .synkora/CONTEXT.md · sessão reiniciada com o novo contexto' })
      } catch (err) {
        emit({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
      } finally {
        surveyAborts.delete(projectId)
        endProgressHeadlessActivity(projectId, 'survey', progressSurveyToken)
      }
    }
  )

  ipcMain.handle('maestro:reset', (_e, projectId: string) => {
    killMaestroSession(projectId)
    maestro.clear(projectId)
  })

  // Seat do Maestro é escolhido NA ENTRADA do projeto (gate) e persistido.
  // REVIEWER do gate de integração (página geral): seat+modelo+effort próprios.
  ipcMain.handle('maestro:getReviewer', (_e, projectId: string) => {
    const s = maestro.get(projectId)
    return {
      seatId: s.reviewerSeatId ?? null,
      model: s.reviewerModel ?? null,
      effort: s.reviewerEffort ?? null
    }
  })
  ipcMain.handle(
    'maestro:setReviewer',
    (_e, projectId: string, seatId?: string, model?: string, effort?: string) => {
      maestro.update(projectId, {
        reviewerSeatId: seatId || undefined,
        reviewerModel: model || undefined,
        reviewerEffort: effort || undefined
      })
    }
  )

  // Trocar de seat é ação explícita: mata painel de fundo + pane TUI e zera
  // sessão/modelo/effort (são por CLI — sem isso um modelo gpt vaza p/ claude).
  /** TRANSPLANTE DE SESSÃO ENTRE SEATS (sondas 2026-08-04, ambas positivas:
   *  claude JSONL transplantado respondeu a palavra-código sob a outra conta;
   *  codex rollout recuperou a conversa inteira). O contexto é ARQUIVO LOCAL —
   *  a cobrança segue o login do config dir; copiar a conversa para o seat
   *  novo e resumir lá preserva tudo. Mesmo CLI apenas; false = chamador
   *  reseta a sessão como no fluxo antigo. */
  function migrateCliSessionBetweenSeats(
    cli: SeatCli,
    fromSeatId: string,
    toSeatId: string,
    cwd: string,
    sessionId: string
  ): boolean {
    try {
      const seatsRoot = join(app.getPath('userData'), 'seats')
      const from = join(seatsRoot, fromSeatId)
      const to = join(seatsRoot, toSeatId)
      if (cli === 'claude') {
        const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
        const src = join(from, 'projects', slug, `${sessionId}.jsonl`)
        if (!existsSync(src)) return false
        const destDir = join(to, 'projects', slug)
        mkdirSync(destDir, { recursive: true })
        copyFileSync(src, join(destDir, `${sessionId}.jsonl`))
        return true
      }
      const uuid = sessionId.replace('codex-thread:', '')
      const findRollout = (dir: string): string | undefined => {
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return undefined
        }
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            const found = findRollout(full)
            if (found) return found
          } else if (entry.name.includes(uuid) && entry.name.endsWith('.jsonl')) {
            return full
          }
        }
        return undefined
      }
      const src = findRollout(join(from, 'sessions'))
      if (!src) return false
      const dest = join(to, relative(from, src))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      return true
    } catch {
      return false
    }
  }

  // TROCA DE CONTA NOS PANES DE EXECUÇÃO (decisão do usuário, 2026-08-05:
  // "esses são os que mais gastam — quando o limite acaba eu preciso trocar a
  // conta sem perder o contexto"). Mesma semântica do reseat do orquestrador:
  // mesmo-CLI claude migra a CONVERSA (transplante de JSONL) e o pane renasce
  // via resume; codex/cross-CLI renasce fresco sobre o worktree preservado
  // (fase codex nunca resume — armadilha resume-sem-MCP, F6.7). O effort
  // escolhido vira o novo carimbo do card (o usuário decide, nunca o acaso).
  ipcMain.handle(
    'tasks:setPhaseSeat',
    async (
      e,
      projectId: string,
      taskId: string,
      choice: { seatId: string; model?: string; effort?: string }
    ) => {
      bindUiSender(e.sender)
      return setPhaseExecutorImpl(projectId, taskId, choice, 'user')
    }
  )

  // Corpo compartilhado da troca de executor de fase: o botão ⇄ do dono e a
  // tool set_phase_executor (orquestrador POR ORDEM do dono, CHECK 6
  // 2026-08-07) passam pelo MESMO caminho — transplante/resume/carimbo/evento.
  async function setPhaseExecutorImpl(
    projectId: string,
    taskId: string,
    choice: { seatId: string; model?: string; effort?: string },
    swapActor: 'user' | 'maestro',
    ownerOrder?: string
  ): Promise<{ ok: boolean; msg: string }> {
    {
      const task = tasks.get(taskId)
      if (!task || task.projectId !== projectId)
        return { ok: false, msg: 'card não encontrado' }
      if (task.kind === 'plan' || task.status === 'done')
        return { ok: false, msg: 'este card não tem fase executável para trocar de conta' }
      const nextSeat = choice?.seatId ? seats.get(choice.seatId) : undefined
      if (!nextSeat) return { ok: false, msg: 'escolha uma conta válida' }
      const phase = task.activePhase ?? 'dev'
      const watch = phaseWatches.get(taskId)
      const livePane = hub
        .panesOf(projectId)
        .find((pane) => pane.taskId === taskId && pane.role === phase)
      const prevSeatId =
        livePane?.seatId ?? task.phaseSessions?.[phase]?.seatId ?? task.runSeat
      const prevSeat = prevSeatId ? seats.get(prevSeatId) : undefined
      const sessionId =
        (livePane && paneSessions.get(livePane.paneId)) ??
        task.phaseSessions?.[phase]?.sessionId
      const worktreeGuess = join(
        app.getPath('userData'),
        'worktrees',
        projectId,
        taskId.slice(0, 8)
      )
      const cwd =
        watch?.cwd ??
        (existsSync(worktreeGuess) ? worktreeGuess : projects.get(projectId)?.path)
      // encerra a fase atual preservando tudo (worktree/transcript/fase)
      phaseWatches.delete(taskId)
      terminateTaskPhasePane(projectId, taskId, phase)
      const sameSeat = Boolean(prevSeat && prevSeat.id === nextSeat.id)
      const migrated = Boolean(
        prevSeat &&
          !sameSeat &&
          prevSeat.cli === nextSeat.cli &&
          nextSeat.cli === 'claude' &&
          sessionId &&
          cwd &&
          migrateCliSessionBetweenSeats(nextSeat.cli, prevSeat.id, nextSeat.id, cwd, sessionId)
      )
      // MESMO seat claude não precisa de transplante nenhum (mesmo config
      // dir): preserva a sessão e o respawn resume — apagar aqui perdia a
      // conversa à toa (achado do E2E, 2026-08-05).
      const keepSession = Boolean(
        sessionId && nextSeat.cli === 'claude' && (migrated || sameSeat)
      )
      const phaseSessions = { ...(task.phaseSessions ?? {}) }
      if (keepSession && sessionId) {
        phaseSessions[phase] = {
          phase,
          sessionId,
          seatId: nextSeat.id,
          cli: nextSeat.cli,
          model: choice.model?.trim() || undefined,
          effort:
            choice.effort?.trim() ||
            (phase === 'dev' ? task.devEffort : task.phaseSessions?.[phase]?.effort),
          capturedAt: new Date().toISOString()
        }
      } else {
        delete phaseSessions[phase]
      }
      const nextEffort =
        choice.effort?.trim() || (phase === 'dev' ? task.devEffort : undefined)
      tasks.update(taskId, {
        activePhase: phase,
        phaseState: 'interrupted',
        phaseSessions,
        phaseResume: phaseSessions[phase],
        runSeat: nextSeat.id,
        runModel: choice.model?.trim() || undefined,
        ...(phase === 'dev' && choice.effort?.trim() ? { devEffort: choice.effort.trim() } : {})
      })
      blackbox.record({
        cat: 'pane',
        event: 'seat-swap',
        actor: swapActor,
        ids: { projectId, missionId: task.missionId, taskId, phase, role: phase, seatId: nextSeat.id },
        reason:
          (migrated
            ? `fase ${phase} migrada de ${prevSeat?.name ?? prevSeatId ?? '?'} para ${nextSeat.name} COM a conversa (transplante de sessão)`
            : keepSession
              ? `fase ${phase} respawnada na MESMA conta ${nextSeat.name} com a conversa preservada (model/effort novos via resume)`
              : `fase ${phase} trocada de ${prevSeat?.name ?? prevSeatId ?? '?'} para ${nextSeat.name} sem migração (codex/cross-CLI/sem sessão) — renasce sobre o trabalho preservado`) +
          (ownerOrder ? ` · POR ORDEM DO DONO (verbatim): "${ownerOrder.slice(0, 300)}"` : '')
      })
      // respawn imediato na conta nova (o recovery prompt/resume cuida do resto)
      const launchToken = phaseLaunches.reserve(taskId)
      if (launchToken) {
        try {
          const spec = await preparePhasePane(
            projectId,
            taskId,
            phase,
            nextSeat.id,
            choice.model?.trim() || undefined,
            nextEffort,
            undefined,
            launchToken
          )
          if (spec) openPhasePane(spec, projectId, taskId)
        } finally {
          phaseLaunches.release(taskId, launchToken)
        }
      }
      // NÃO-QUIET (caso real 2026-08-06: o usuário trocou o dev para Opus via
      // ⇄ e o orquestrador — sem saber que a troca existe — INVENTOU a
      // explicação "o app reabriu com Opus, um degrau abaixo do contrato da
      // lane". Decisão do dono precisa chegar como FATO no pane dele).
      hub.publish({
        projectId,
        missionId: task.missionId,
        kind: 'info',
        text: `${
          swapActor === 'user'
            ? 'o USUÁRIO trocou'
            : 'o orquestrador trocou POR ORDEM REGISTRADA DO DONO'
        } o executor da fase ${phase} de "${task.title}" para ${nextSeat.name}${
          choice.model?.trim() ? ` · ${choice.model.trim()}` : ''
        }${nextEffort ? ` · ${nextEffort}` : ''} (${
          swapActor === 'user' ? 'botão ⇄ do pane — prerrogativa do dono' : 'set_phase_executor'
        }). ${
          migrated || keepSession ? 'A conversa foi preservada.' : 'O pane renasceu fresco sobre o trabalho preservado.'
        } Este é o NOVO carimbo do card: não trate como anomalia nem re-imponha o modelo da lane`,
        actor: 'harness'
      })
      if (uiSender && !uiSender.isDestroyed()) uiSender.send('tasks:changed', projectId)
      return {
        ok: true,
        msg: migrated
          ? 'conta trocada COM a conversa transplantada — o pane renasceu via resume'
          : keepSession
            ? 'mesma conta com model/effort novos — o pane renasceu via resume com a conversa preservada'
            : 'conta trocada; o pane renasceu fresco sobre o trabalho preservado'
      }
    }
  }

  ipcMain.handle('maestro:setSeat', (e, projectId: string, seatId: string, model?: string, effort?: string) => {
    bindUiSender(e.sender)
    const state = maestro.get(projectId)
    const prev = state.seatId
    if (prev === seatId) {
      // mesmo seat, modelo/effort podem ter mudado no gate: aplica e mata o
      // pane — ele renasce com --model/--effort novos NA MESMA sessão (resume)
      maestro.update(projectId, { seatId, model: model || undefined, effort: effort || undefined })
      killMaestroSession(projectId)
      ptys.kill(maestroPaneId(projectId))
      return
    }
    killMaestroSession(projectId)
    ptys.kill(maestroPaneId(projectId))
    // Troca de conta MESMO-CLI migra a conversa por padrão (decisão do
    // usuário 2026-08-04: limite estourado nunca pode custar o contexto).
    // Cross-CLI reseta como sempre; quem quiser recomeçar usa /clear depois.
    const prevSeat = prev ? seats.get(prev) : undefined
    const nextSeat = seats.get(seatId)
    const project = projects.get(projectId)
    const migrated = Boolean(
      prevSeat &&
        nextSeat &&
        prevSeat.cli === nextSeat.cli &&
        state.tuiSessionId &&
        project &&
        migrateCliSessionBetweenSeats(
          nextSeat.cli,
          prevSeat.id,
          nextSeat.id,
          project.path,
          state.tuiSessionId
        )
    )
    maestro.update(projectId, {
      seatId,
      sessionId: undefined,
      tuiSessionId: migrated ? state.tuiSessionId : undefined,
      personaSent: false,
      model: model || undefined,
      effort: effort || undefined,
      contextWindow: undefined
    })
    const seat = seats.get(seatId)
    emitLog(projectId, {
      kind: 'ok',
      text: `seat do Maestro: ${seat?.name ?? seatId} (${seat?.cli ?? '?'})${model ? ` · ${model}` : ''}${effort ? ` · effort ${effort}` : ''}${migrated ? ' · conversa transplantada para a conta nova' : ''}`
    })
    blackbox.record({
      cat: 'pane',
      event: 'seat-swap',
      actor: 'user',
      ids: { projectId, seatId },
      reason: migrated
        ? `conversa migrada de ${prevSeat?.name ?? prev} para ${seat?.name ?? seatId} (transplante de sessão)`
        : `seat trocado de ${prevSeat?.name ?? prev} para ${seat?.name ?? seatId} sem migração (CLI diferente ou sem sessão)`
    })
  })

  // SERVIDOR DE TESTE DO DONO (pedido do usuário, 2026-08-06: "quero um botão
  // que sobe o servidor pra eu testar — eu escolho a porta"): abre um PANE
  // SHELL no worktree da MISSÃO (testar a branch isolada) ou da VERSÃO
  // (testar o conjunto já integrado) com o script de runtime detectado já
  // digitado. O pane dá log visível e morte limpa (job object mata a árvore
  // ao fechar); integração/release fecham o server daquele worktree ANTES do
  // merge (processo com cwd no worktree segura arquivos no Windows).
  const testServerPanes = new Map<
    string,
    { projectId: string; cwd: string; command: string; port?: number; label?: string }
  >()
  // Mapa de portas do harness (decisão do dono, 2026-08-07): QA e modal do
  // ▶ testar veem as MESMAS entradas — runtime de QA com a porta REAL da URL
  // anunciada; servidor de teste com a porta PEDIDA (produto pinado pode ter
  // ido para outra — o flag 'requested' mantém a honestidade).
  function harnessPortsInUse(projectId: string): PortUseEntry[] {
    const entries: PortUseEntry[] = []
    for (const runtime of activeQaRuntimes()) {
      const task = tasks.get(runtime.taskId)
      if (task && task.projectId !== projectId) continue
      entries.push({
        port: parsePortFromUrl(runtime.url),
        owner: `QA do card "${task?.title?.slice(0, 48) ?? runtime.taskId.slice(0, 8)}"`
      })
    }
    for (const [paneId, srv] of testServerPanes) {
      if (srv.projectId !== projectId) continue
      if (!ptys.has(paneId)) continue
      entries.push({
        port: srv.port,
        requested: srv.port !== undefined,
        owner: `servidor de teste do dono${srv.label ? ` (${srv.label.slice(0, 40)})` : ''}`
      })
    }
    return entries
  }
  function closeTestServersUnder(pathPrefix: string): void {
    const prefix = pathPrefix.toLowerCase()
    for (const [paneId, entry] of [...testServerPanes]) {
      if (!entry.cwd.toLowerCase().startsWith(prefix)) continue
      testServerPanes.delete(paneId)
      if (!ptys.has(paneId)) continue
      ptys.kill(paneId)
      if (uiSender && !uiSender.isDestroyed())
        uiSender.send('panes:closeById', entry.projectId, paneId)
      blackbox.record({
        cat: 'pane',
        event: 'test-server-closed',
        actor: 'harness',
        ids: { projectId: entry.projectId, paneId },
        reason: 'servidor de teste fechado antes do merge/release do worktree'
      })
    }
  }
  ipcMain.handle(
    'panes:testServerSpec',
    (
      e,
      projectId: string,
      target: { missionId?: string; versionId?: string },
      port?: number
    ): {
      ok: boolean
      msg?: string
      paneId?: string
      cwd?: string
      command?: string
      title?: string
      missionId?: string
      versionId?: string
    } => {
      bindUiSender(e.sender)
      const project = projects.get(projectId)
      if (!project || !existsSync(project.path))
        return { ok: false, msg: 'projeto indisponível — a pasta existe?' }
      let cwd: string | undefined
      let label = ''
      let missionId: string | undefined
      if (target.missionId) {
        const mission = ensureMissionWorktree(target.missionId)
        if (!mission || mission.projectId !== projectId)
          return { ok: false, msg: 'missão não encontrada' }
        cwd = mission.worktree
        label = mission.title
        missionId = mission.id
      } else if (target.versionId) {
        const version = backlog
          .listVersions(projectId)
          .find((v) => v.id === target.versionId)
        if (!version) return { ok: false, msg: 'versão não encontrada' }
        if (version.worktree && existsSync(version.worktree)) {
          cwd = version.worktree
        } else {
          const wt = createVersionWorktree(
            project.path,
            join(app.getPath('userData'), 'worktrees', projectId),
            version.name,
            version.id
          )
          if (wt) {
            backlog.setVersionBranch(version.id, wt.branch, wt.dir)
            cwd = wt.dir
          }
        }
        label = `versão ${version.name}`
      }
      if (!cwd || !existsSync(cwd))
        return {
          ok: false,
          msg: 'não foi possível preparar o worktree para testar (branch existe?)'
        }
      const script = detectRuntimeScript(cwd)
      if (!script)
        return {
          ok: false,
          msg: 'nenhum script dev/preview/serve/start no package.json deste worktree'
        }
      const portN = Number(port)
      const chosenPort = Number.isInteger(portN) && portN > 0 ? portN : undefined
      const isWin = process.platform === 'win32'
      const inv = portInvocation(readScriptCommand(cwd, script), script, chosenPort, isWin)
      // Worktree recém-criado NÃO tem node_modules — sem o bootstrap o script
      // resolvia binários pelo PATH herdado (caso real: o electron-vite do
      // PRÓPRIO Synkora vazou para o produto). O npm ci roda visível no pane.
      const needsInstall = !existsSync(join(cwd, 'node_modules'))
      const install = installCommand(cwd)
      const installPrefix = needsInstall
        ? isWin
          ? `if (-not (Test-Path node_modules)) { ${install} }; `
          : `[ -d node_modules ] || ${install}; `
        : ''
      // A nota (porta não se aplica / convenção PORT=) aparece NO PANE, onde
      // o usuário está olhando — o modal fecha no sucesso.
      // Porta PINADA + runtime de QA vivo = colisão anunciada ANTES do crash
      // (caso real 2026-08-07: o dono escolheu outra porta, o produto foi na
      // 5174 pinada e morreu contra o runtime do QA de outra missão — o erro
      // cru não dizia quem segurava).
      let noteText = inv.note
      if (inv.note && /Electron/i.test(inv.note)) {
        const live = activeQaRuntimes()
        if (live.length > 0) {
          noteText = `${inv.note} · ATENÇÃO: runtime de QA vivo (${live
            .map((r) => {
              const t = tasks.get(r.taskId)
              return `card "${t?.title?.slice(0, 40) ?? r.taskId.slice(0, 8)}"${r.url ? ` em ${r.url}` : ''}`
            })
            .join(', ')}) — a porta pinada do produto provavelmente está OCUPADA; derrube aquele gate (■) ou teste depois`
        }
      }
      const noteEcho = noteText
        ? isWin
          ? `Write-Host 'nota: ${noteText.replace(/'/g, "''")}'; `
          : `echo 'nota: ${noteText.replace(/'/g, "'\\''")}'; `
        : ''
      const command = `${noteEcho}${installPrefix}${inv.prefix}npm run ${script}${inv.suffix}`
      const paneId = randomUUID()
      testServerPanes.set(paneId, { projectId, cwd, command, port: chosenPort, label })
      blackbox.record({
        cat: 'pane',
        event: 'test-server-open',
        actor: 'user',
        ids: { projectId, missionId, paneId },
        reason: `servidor de teste: "${command}" em ${cwd}`
      })
      return {
        ok: true,
        paneId,
        cwd,
        command,
        title: `▶ ${label.slice(0, 26)}`,
        missionId,
        versionId: target.versionId
      }
    }
  )

  // Mapa de portas para o MODAL do ▶ testar (decisão do dono, 2026-08-07):
  // mesma string que o QA recebe no prompt — o dono escolhe vendo o mapa.
  ipcMain.handle('panes:portsInUse', (e, projectId: string) => {
    bindUiSender(e.sender)
    return formatPortMap(harnessPortsInUse(projectId))
  })

  // Spec do PANE TUI do Maestro: um terminal REAL do CLI do seat escolhido,
  // com a persona de orquestrador e as tools MCP do Synkora. Sessão retomada
  // via --resume (claude) / resume (codex) quando o pane renasce.
  // AGENTE LIVRE (pane manual "✦ Agente"): nasce ARMADO — MCP do Synkora
  // (register_direct_mission, board_status, notify_maestro…) + persona de
  // consciência da base (claude). Sem isso ele podia quebrar o app editando a
  // main por fora do sistema de missões/versões.
  ipcMain.handle('panes:freeSpec', (e, projectId: string, seatId: string, effort?: string) => {
    bindUiSender(e.sender)
    const project = projects.get(projectId)
    const seat = seats.get(seatId)
    if (!project || !seat || !existsSync(project.path)) return null
    if (
      projectModeOf(projectId) === 'greenfield' &&
      projectPlanOf(projectId)?.status !== 'done'
    ) {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          'agente livre bloqueado: este projeto novo ainda segue o plano mestre — trabalhe somente pela missão indicada pelo Maestro',
        actor: 'harness'
      })
      return null
    }
    seats.preseed(seat)
    const armed = armPane(
      { projectId, role: 'livre', cwd: project.path, seatId: seat.id },
      seat.cli,
      {
        strictMcp: true,
        configDir: seats.configDirOf(seat),
        // Antes do primeiro prompt nao existe uma missao que possa ser
        // classificada. Contexto desconhecido usa o perfil sensivel para nao
        // herdar bypass, hooks, plugins ou MCPs persistentes.
        sensitive: true
      }
    )
    const cliArgs = [...armed.cliArgs]
    if (effort) {
      if (seat.cli === 'claude') cliArgs.push('--effort', effort)
      else cliArgs.push('-c', `model_reasoning_effort="${effort}"`)
    }
    if (seat.cli === 'codex') {
      // persona invisível do codex VALIDADA em PTY real (2026-07-24, sonda
      // BANANA123): -c developer_instructions="…" injeta developer
      // instructions sem aparecer na conversa — os dois CLIs iguais.
      // Valor vira string TOML de uma linha (\n escapado).
      cliArgs.push('-c', codexDeveloperInstructions(FREE_AGENT_PERSONA))
    }
    return {
      paneId: armed.paneId,
      cliArgs,
      appendSystemPrompt: seat.cli === 'claude' ? FREE_AGENT_PERSONA : undefined
    }
  })

  ipcMain.handle('maestro:paneSpec', async (e, projectId: string) => {
    bindUiSender(e.sender)
    await staggerPaneSpawn()
    const project = projects.get(projectId)
    if (!project) return null
    // pasta sumiu (renomeada/movida fora do app): spawnar aqui derrubaria o
    // pty:create — a Home oferece a relocação
    if (!existsSync(project.path)) return null
    // Projeto ABERTO pelo usuário (o Board ativo pede a spec do PM): hora de
    // respawnar as fases que o reinício interrompeu — o renderer está de pé.
    drainPendingRespawns(projectId)
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return null
    }
    const projectMode = projectModeOf(projectId)
    try {
      ensureProjectSecurityBaseline(project.path, {
        installRepositoryAdapters: projectMode === 'greenfield',
        projectName: project.name
      })
    } catch (error) {
      // App novo não inicia sem conseguir materializar a política. Projetos
      // existentes preservam compatibilidade e seguem sob o system prompt.
      if (projectMode === 'greenfield') {
        hub.publish({
          projectId,
          kind: 'error',
          text: `não abri o Maestro: não foi possível preparar a política local de segurança (${redactSensitiveText(error instanceof Error ? error.message : String(error))})`,
          actor: 'harness',
          urgent: true
        })
        return null
      }
    }
    if (projectMode === 'greenfield') {
      try {
        ensureGreenfieldProjectPlan(project.path, { projectName: project.name })
      } catch {
        /* a persona/tool reporta o plano inválido sem impedir o pane */
      }
    }
    const projectPlan = projectPlanOf(projectId)
    const basePersona = maestroProjectPersona(projectMode, projectPlan?.status)
    let state = maestro.get(projectId)
    const seat = state.seatId ? seats.get(state.seatId) : undefined
    if (!seat) return null
    const projectLifecycle = projectLifecycleOf(projectId)
    if (state.projectLifecycle !== projectLifecycle) {
      maestro.update(projectId, { projectLifecycle })
      state = maestro.get(projectId)
    }
    seats.preseed(seat)
    const paneId = maestroPaneId(projectId)
    // Conversa acima do teto de custo: não retoma — o PM "nunca morre" e a
    // conversa dele só cresce; nasce fresco com o caderno MAESTRO.md.
    const resumeOverBudget = maestroResumeOverBudget(projectId)
    if (resumeOverBudget !== undefined) {
      skipMaestroResume(projectId, resumeOverBudget, { projectId, paneId })
      state = maestro.get(projectId)
    }
    // pane antigo ainda vivo (reload do renderer): mata para renascer limpo
    if (ptys.has(paneId)) ptys.kill(paneId)
    unregisterPane(paneId)
    const planningRun = await preparePlanningRun({ paneId, projectId, cwd: project.path })
    if (!planningRun.ok) {
      hub.publish({
        projectId,
        kind: 'error',
        text: `não abri o Maestro: ${planningRun.message}`,
        actor: 'harness',
        urgent: true
      })
      return null
    }
    const personaWithPlanning = `${basePersona}${planningRun.skillBlock}`
    let armed: ReturnType<typeof armPane>
    try {
      armed = armPane(
        { paneId, projectId, role: 'maestro', cwd: project.path, seatId: seat.id },
        seat.cli,
        { strictMcp: true, configDir: seats.configDirOf(seat) }
      )
    } catch {
      releasePaneSkillLease(paneId)
      releasePaneSkillPlan(paneId)
      hub.publish({
        projectId,
        kind: 'error',
        text: 'não abri o Maestro: falha ao armar o pane com o método de planejamento',
        actor: 'harness',
        urgent: true
      })
      return null
    }
    const cliArgs = [...armed.cliArgs]
    // Effort do Maestro (escolhido no gate, persistido): claude --effort;
    // codex -c global — PRECISA vir antes do subcomando resume.
    if (state.effort) {
      if (seat.cli === 'claude') cliArgs.push('--effort', state.effort)
      else cliArgs.push('-c', `model_reasoning_effort="${state.effort}"`)
    }
    let initialPrompt: string | undefined
    let appendSystemPrompt: string | undefined
    // Pós-skip de resume por custo: o PM se apresenta explicando a economia e
    // se reergue pelos arquivos duráveis — sem isso o pane nasceria mudo e
    // "sem memória" aos olhos do usuário.
    const resumeSkippedIntro =
      resumeOverBudget !== undefined
        ? `Your previous conversation was NOT resumed on purpose (~${Math.round(resumeOverBudget / 1000)}k tokens of context — replaying it would burn a real slice of the account limit; deliberate economy, no work lost). Your VERY FIRST output — before ANY tool call — is a 2-3 line PT-BR note telling the user exactly that. THEN rebuild your working memory from the durable files: read .synkora/MAESTRO.md (your own notebook) if it exists, .synkora/BOARD.md, .synkora/PROJECT_PLAN.md when present, and call board_status. Summarize where the project stands in 2-3 PT-BR lines and continue. Do NOT re-ask questions the user already answered; if .synkora/MAESTRO.md does not exist yet, say "o caderno MAESTRO.md ainda não existe — vou criá-lo agora" and write it after reading the state.`
        : undefined
    if (seat.cli === 'claude') {
      appendSystemPrompt = personaWithPlanning
      if (state.tuiSessionId) cliArgs.push('--resume', state.tuiSessionId)
      else initialPrompt = resumeSkippedIntro
    } else {
      // Diferente do primeiro prompt, developer_instructions sobrevive a /new
      // e tambem vale ao retomar uma thread Codex existente.
      cliArgs.push('-c', codexDeveloperInstructions(personaWithPlanning))
      if (state.tuiSessionId) {
      // -c são flags globais: podem vir antes do subcomando resume
      cliArgs.push('resume', state.tuiSessionId)
    } else {
      const discoveryStarted = Boolean(
        projectPlan &&
          (projectPlan.problem ||
            projectPlan.audience ||
            projectPlan.vision ||
            projectPlan.successCriteria.length ||
            projectPlan.constraints.length ||
            projectPlan.scope.in.length ||
            projectPlan.scope.out.length ||
            projectPlan.decisions.length ||
            projectPlan.roadmap.length)
      )
      const intro =
        projectMode === 'greenfield'
          ? projectPlan?.status === 'done'
            ? 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, explain that the original roadmap is complete and that this is now a ready project: ask what focused improvement, feature or bug the user wants to handle next. Do not reopen the master roadmap.'
            : projectPlan?.status === 'awaiting_release'
              ? 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, explain that every planned mission is integrated but the project is NOT complete yet: show which version still awaits the user’s final acceptance and explicit release to the base. Do not open another mission or release it silently.'
            : discoveryStarted
            ? 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, resume the product discovery or roadmap at the exact saved point, and say clearly: where we are, what is already decided, what is still missing, and what the single next logical step is. Ask only that next question. Do not create a mission unless the user explicitly authorizes the next approved roadmap item.'
            : 'Read .synkora/PROJECT_PLAN.md and call board_status. Introduce yourself in PT-BR, explain in one short sentence that you detected a new empty project and ask what product the user wants to build. Begin collaborative discovery; do not create any mission yet.'
          : 'Introduce yourself in one line (in PT-BR) and ask what the user wants to do.'
      initialPrompt = resumeSkippedIntro ?? intro
      }
    }
    return {
      paneId,
      kind: seat.cli,
      seatId: seat.id,
      cwd: project.path,
      cliArgs,
      initialPrompt,
      appendSystemPrompt,
      // modelo escolhido no gate (--model no spawn; sessão preservada)
      model: state.model
    }
  })

  ipcMain.handle('maestro:setModel', async (e, projectId: string, model: string) => {
    bindUiSender(e.sender)
    const emit = makeEmitter(e.sender, projectId)
    const session = maestroSessions.get(projectId)
    if (session?.alive) {
      // Troca AO VIVO via protocolo de controle — mesma sessão, sem restart.
      // A confirmação real do CLI chega como <local-command-stdout> no log.
      const ok = await session.setModel(model || 'default')
      if (!ok) {
        emit({ kind: 'err', text: 'o CLI recusou a troca de modelo — veja /model para os nomes válidos' })
        return
      }
    } else {
      killMaestroSession(projectId)
    }
    maestro.update(projectId, { model: model || undefined })
    emit({ kind: 'ok', text: `modelo do maestro: ${model || 'padrão do seat'}` })
  })

  // A máquina de execução HEADLESS da F3 (o "espelho") morreu no commit 0.5
  // da Fase 1: o pipeline inteiro roda em panes TUI reais desde a F3.5 e o
  // taskRuns nunca mais recebia .set() — código morto provado no mapa
  // (docs/FASE1_MAPA_MAINCONTEXT.md, "ACHADO DE OURO").

  const STATUS_LABEL: Record<string, string> = {
    backlog: 'Backlog',
    execucao: 'Em execução',
    qa: 'QA',
    done: 'Concluída'
  }

  function syncBoard(projectId: string): void {
    // Fase 0 (atribuição de stall): syncBoard grava BOARD.md de forma
    // síncrona em TODA mutação de tarefa/run — suspeito clássico.
    mainStalls.wrap('syncBoard', undefined, () => syncBoardInner(projectId))
  }
  function syncBoardInner(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    try {
      ensureSynkoraGitExcludes(project.path)
      const dir = join(project.path, '.synkora')
      mkdirSync(dir, { recursive: true })
      const all = tasks.list(projectId)
      const ms = missions.list(projectId)
      const missionTitle = (mid?: string): string | undefined =>
        mid ? ms.find((m) => m.id === mid)?.title : undefined
      const lines: string[] = [
        '# Board do Synkora (gerado automaticamente — NÃO editar)',
        `Atualizado: ${new Date().toISOString()}`,
        ''
      ]
      if (ms.length > 0) {
        lines.push('## Missões')
        for (const m of ms) {
          const count = all.filter((t) => t.missionId === m.id && t.kind !== 'plan')
          const done = count.filter((t) => t.status === 'done').length
          lines.push(
            `- [${m.status}] "${m.title}"${m.branch ? ` (branch ${m.branch})` : ''} — ${done}/${count.length} tarefas concluídas${m.scope ? ` · escopo: ${m.scope}` : ''}`
          )
        }
        lines.push('')
      }
      for (const status of ['execucao', 'qa', 'backlog', 'done']) {
        const bucket = all.filter((t) => t.status === status)
        if (bucket.length === 0) continue
        lines.push(`## ${STATUS_LABEL[status]}`)
        for (const t of bucket) {
          const mt = missionTitle(t.missionId)
          // F5.7: card de PLANO tem linha própria — nunca lê como trabalho.
          if (t.kind === 'plan') {
            const st =
              t.status === 'backlog'
                ? t.plan?.approvedAt
                  ? 'PAUSADO pelo usuário'
                  : 'aguardando aprovação do usuário'
                : t.status === 'execucao'
                  ? 'APROVADO — orquestrador executando sozinho'
                  : 'concluído'
            lines.push(`- [PLANO]${mt ? ` [missão: ${mt}]` : ''} ${t.title} — ${st}`)
            continue
          }
          lines.push(
            `- [${t.department}]${mt ? ` [missão: ${mt}]` : ''} ${t.title} (${t.type}, ${t.effort})`
          )
          if (t.description) lines.push(`  ${t.description.replace(/\s+/g, ' ').slice(0, 300)}`)
        }
        lines.push('')
      }
      if (all.length === 0) lines.push('(sem tarefas no board)')
      writeFileSync(join(dir, 'BOARD.md'), lines.join('\n'), 'utf-8')
    } catch {
      // board é best-effort — nunca derruba o fluxo
    }
    syncMaestroProjectLifecycle(projectId)
    if (uiSender && !uiSender.isDestroyed()) {
      uiSender.send('projects:flowChanged', projectId)
    }
    scheduleProgressSnapshot()
  }


  // TODAS as fases rodam em PANES TUI REAIS (decisão do usuário): dev, revisão
  // e QA são o CLI de verdade, ao vivo. A orquestração é por ARQUIVOS: o dev
  // cria <id>.done ao concluir; cada gate cria <id>.<fase>.verdict contendo
  // "aprovada" ou "reprovada: motivo". O main vigia, abre/fecha os panes das
  // fases, devolve feedback ao pane do dev nos retries e faz o merge no final.
  // RunPhase / DevPaneSpec / PhaseWatch moram em phaseTypes.ts (commit 0).
  const livePaneSpecs = new Map<
    string,
    { projectId: string; taskId: string; spec: DevPaneSpec }
  >()

  // Um processo em fechamento não pode reaparecer num snapshot durante o
  // pequeno intervalo entre kill() e onExit().
  const closingPaneIds = new Set<string>()
  // Panes cujo PTY chegou a EXISTIR nesta sessão. O pty:kill TARDIO do
  // renderer (que chega depois de o main já ter matado o processo no
  // pós-report do ajudante) não pode ser confundido com "pane fechado antes
  // de iniciar" — o aviso falso "ajudante X não conseguiu abrir" chegava 1s
  // DEPOIS da conclusão entregue (bug real, diário de 2026-08-03).
  // Append-only por sessão: paneIds são UUIDs, o custo é desprezível.
  const paneEverSpawned = new Set<string>()
  // MÁQUINA DE FASES → phaseEngine.ts (fase 1, commit 3). O estado de fase
  // nasce DENTRO do engine; os aliases abaixo mantêm os call sites do index e
  // os getters do ctx textualmente intactos até os commits 4–5 (mcpApi/, ipc/)
  // consumirem ctx.phase. codeReportGuard é arrow DE PROPÓSITO: o mcpApi é
  // const declarada ~5k linhas abaixo (TDZ na construção) e o tick só roda com
  // tudo construído.
  const phaseEngine = createPhaseEngine(ctx, {
    terminatePaneNow,
    terminateTaskHelpers,
    discardUnstartedPane,
    planTaskForWorkTask,
    retryLimitForTask,
    executionModeForTask,
    securityWaiverOptions,
    missionWorkspacePath,
    ensureMissionWorktree,
    timedTaskWorktree,
    prepareSkillPlanInputs,
    syncPaneSkillLease,
    renewLivePaneSkillRun,
    releasePaneSkillPlan: (paneId) => releasePaneSkillPlan(paneId),
    skillRuntime,
    skillPlanScopes,
    storedHelperRecoveries,
    harnessPortsInUse,
    codexDeveloperInstructions,
    armPane,
    codeReportGuard: (identity) => mcpApi.codeReportGuard(identity)
  })
  const {
    phaseWatches,
    phaseLaunches,
    phaseLaunchCapacity,
    liveGateWaits,
    gateDeathLog,
    gateCooldownUntil,
    bootRespawnsPending,
    phaseMarkersProcessing,
    preparePhasePane,
    advancePhase,
    retryOrBacklog,
    finalizeTask,
    openGatePane,
    openPhasePane,
    closePhasePane,
    terminateTaskPhasePane,
    closeLiveGateWait,
    notePendingRespawn,
    drainPendingRespawns,
    recoverFinalizingTask,
    taskIntegrationMarker,
    reviewArtifactProblem,
    cleanupReviewArtifact,
    readReviewArtifactChunk
  } = phaseEngine
  // Perguntas dirigidas ao USUÁRIO (tool ask_user, 2026-08-06): chave
  // `<projectId>--<missionId|geral>` → a aba do board pulsa até o dono abrir.
  // PERSISTIDAS (fix 2026-08-06, célula 🔴 do mapa de retomada confirmada ao
  // vivo na M02d: a pergunta que pediu o restart foi apagada pelo próprio
  // restart) — o boot reidrata e a aba volta a pulsar até o dono ver.
  const userQuestionsFile = join(app.getPath('userData'), 'user-questions.json')
  const pendingUserQuestions = new Map<string, PendingUserQuestion>(
    Object.entries(
      loadJsonStore<Record<string, PendingUserQuestion>>(
        userQuestionsFile,
        () => ({}),
        (v): v is Record<string, PendingUserQuestion> =>
          typeof v === 'object' && v !== null && !Array.isArray(v)
      )
    )
  )
  const persistUserQuestions = (): void => {
    try {
      persistJsonStore(userQuestionsFile, Object.fromEntries(pendingUserQuestions))
    } catch {
      // pergunta viva em memória segue valendo; a próxima mutação re-tenta
    }
  }
  ipcMain.handle('maestro:pendingQuestions', (e, projectId: string) => {
    bindUiSender(e.sender)
    // PODA PREGUIÇOSA: pergunta de projeto removido ou de missão que deixou de
    // estar viva não tem aba para pulsar — resíduo sai do arquivo aqui mesmo.
    let pruned = false
    for (const [key, q] of [...pendingUserQuestions]) {
      const projectAlive = Boolean(projects.get(q.projectId))
      const mission = q.missionKey !== 'geral' ? missions.get(q.missionKey) : undefined
      const missionAlive =
        q.missionKey === 'geral' ||
        (mission && (mission.status === 'ativa' || mission.status === 'integrando'))
      if (!projectAlive || !missionAlive) {
        pendingUserQuestions.delete(key)
        pruned = true
      }
    }
    if (pruned) persistUserQuestions()
    return [...pendingUserQuestions.values()].filter((q) => q.projectId === projectId)
  })
  ipcMain.handle('maestro:questionSeen', (e, projectId: string, missionKey: string) => {
    bindUiSender(e.sender)
    if (pendingUserQuestions.delete(`${projectId}--${missionKey}`)) {
      persistUserQuestions()
      scheduleProgressSnapshot()
    }
    return true
  })

  ipcMain.handle('panes:live', () =>
    [...livePaneSpecs.values()].filter(
      ({ spec }) =>
        !closingPaneIds.has(spec.paneId) && Boolean(hub.identityByPane(spec.paneId))
    )
  )

  /** Reverte um armamento que nunca chegou a produzir um PTY. Arquivos,
   * worktree e sessões permanecem; apenas a afirmação "está rodando" cai. */
  function rollbackFailedPaneSpawn(paneId: string, reason: string): void {
    helperOpenWatchdog.acknowledge(paneId)
    pendingPtyPreparations.delete(paneId)
    const identity = hub.identityByPane(paneId)
    livePaneSpecs.delete(paneId)
    closingPaneIds.delete(paneId)
    unregisterPane(paneId)
    paneTokens.delete(paneId)
    cleanPaneMcpFile(paneId)
    if (!identity) return

    if (identity.role === 'ajudante') {
      helperCompletions.discard(paneId)
      updateStoredHelperStatus(identity.projectId, paneId, 'interrupted')
      if (identity.delegatorPaneId) {
        hub.notifyPane(
          identity.delegatorPaneId,
          `ajudante ${paneId.slice(0, 8)} não conseguiu abrir (${reason}); nenhum processo ficou rodando`
        )
      }
    } else if (
      identity.taskId &&
      (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')
    ) {
      const watch = phaseWatches.get(identity.taskId)
      if (watch?.paneId === paneId && watch.phase === identity.role) {
        phaseWatches.delete(identity.taskId)
        const task = tasks.get(identity.taskId)
        if (task && task.status !== 'done') {
          tasks.update(identity.taskId, {
            status: identity.role === 'qa' ? 'qa' : identity.role === 'review' ? 'execucao' : 'backlog',
            activePhase: identity.role,
            phaseState: 'interrupted',
            phaseStartedAt: undefined,
            feedback: `fase ${identity.role} não abriu (${reason}) — trabalho e conversa foram preservados para retomar o mesmo card`
          })
          hub.publish({
            projectId: identity.projectId,
            missionId: identity.missionId,
            kind: 'error',
            text: `não consegui abrir o pane ${identity.role} de "${task.title}"; retome somente esta fase do mesmo card`,
            actor: 'harness'
          })
          syncBoard(identity.projectId)
        }
      }
    }
    if (uiSender && !uiSender.isDestroyed()) {
      uiSender.send('panes:closeById', identity.projectId, paneId)
      uiSender.send('tasks:changed', identity.projectId)
    }
  }

  /** Limpa um pane já armado que nunca ganhou PTY, sem alterar o estado do card. */
  function discardUnstartedPane(paneId: string): void {
    if (ptys.has(paneId)) return
    helperOpenWatchdog.acknowledge(paneId)
    pendingPtyPreparations.delete(paneId)
    livePaneSpecs.delete(paneId)
    closingPaneIds.delete(paneId)
    unregisterPane(paneId)
    paneTokens.delete(paneId)
    cleanPaneMcpFile(paneId)
  }

  /** Encerra um pane pelo id mesmo quando o registro do Hub ja se perdeu. */
  function terminatePaneNow(projectId: string, paneId: string): void {
    helperOpenWatchdog.acknowledge(paneId)
    pendingPtyPreparations.delete(paneId)
    const terminatingIdentity = hub.identityByPane(paneId)
    const terminatingSpec = livePaneSpecs.get(paneId)
    const terminatingTaskId = terminatingIdentity?.taskId ?? terminatingSpec?.taskId
    const terminatingRole = terminatingIdentity?.role ?? terminatingSpec?.spec.role
    if (terminatingRole === 'qa' && terminatingTaskId) stopQaRuntime(terminatingTaskId)
    const hadPty = ptys.has(paneId)
    unregisterPane(paneId)
    livePaneSpecs.delete(paneId)
    if (hadPty) {
      closingPaneIds.add(paneId)
      ptys.kill(paneId)
    } else {
      closingPaneIds.delete(paneId)
      paneTokens.delete(paneId)
      cleanPaneMcpFile(paneId)
    }
    paneSessions.delete(paneId)
    if (uiSender && !uiSender.isDestroyed()) {
      uiSender.send('panes:closeById', projectId, paneId)
    }
  }

  /** Helpers pertencem ao ciclo de vida do DEV que os delegou. Se esse DEV
   * morre, não deixe escritores órfãos bloquearem ou alterarem a retomada. */
  function terminateTaskHelpers(projectId: string, taskId: string, reason: string): void {
    const helpers = hub
      .panesOf(projectId)
      .filter((pane) => pane.role === 'ajudante' && pane.taskId === taskId)
    for (const helper of helpers) {
      helperCompletions.discard(helper.paneId)
      updateStoredHelperStatus(projectId, helper.paneId, 'interrupted')
      blackbox.record({
        cat: 'pane',
        event: 'task-helper-terminated',
        actor: 'harness',
        ids: { projectId, taskId, paneId: helper.paneId },
        reason
      })
      terminatePaneNow(projectId, helper.paneId)
    }
  }


  function stopMissionExecution(projectId: string, missionId: string, reason: string): void {
    const missionTaskIds = new Set(
      tasks
        .list(projectId)
        .filter((task) => task.missionId === missionId && task.kind !== 'plan')
        .map((task) => task.id)
    )
    for (const taskId of missionTaskIds) {
      const watch = phaseWatches.get(taskId)
      phaseWatches.delete(taskId)
      if (watch) {
        try {
          ensureProjectRuntimeWritable(projectId)
          unlinkSync(watch.marker)
        } catch {
          // marcador já consumido ou nunca criado
        }
      }
      const task = tasks.get(taskId)
      if (task && (task.status === 'execucao' || task.status === 'qa')) {
        tasks.update(taskId, {
          status: 'backlog',
          feedback: reason,
          activePhase: watch?.phase ?? task.activePhase ?? 'dev',
          phaseState: 'interrupted'
        })
      }
    }

    for (const pane of hub
      .panesOf(projectId)
      .filter((candidate) => candidate.missionId === missionId)) {
      helperCompletions.discard(pane.paneId)
      helperReported.add(pane.paneId)
      helperSeen.add(pane.paneId)
      if (ptys.has(pane.paneId)) ptys.kill(pane.paneId)
      unregisterPane(pane.paneId)
      livePaneSpecs.delete(pane.paneId)
      if (uiSender && !uiSender.isDestroyed()) {
        uiSender.send('panes:closeById', projectId, pane.paneId)
      }
    }
    syncBoard(projectId)
  }


  const HELPER_OPEN_GRACE_MS = 30_000
  setInterval(() => {
    phaseEngine.tickPhaseWatches()
    // Marcadores de INTEGRAÇÃO de missão (fallback do report MCP do gate).
    // Helper tambem nasce por `panes:open`, que e um push sem ACK. Uma
    // notificacao perdida nao pode criar um escritor fantasma no Hub e ocupar
    // para sempre o unico slot de delegacao do card. Reenvie uma vez; sem PTY
    // depois da segunda janela, reverta todo o armamento de forma auditada.
    for (const pending of helperOpenWatchdog.due(Date.now(), HELPER_OPEN_GRACE_MS)) {
      const identity = hub.identityByPane(pending.paneId)
      const live = livePaneSpecs.get(pending.paneId)
      if (ptys.has(pending.paneId) || paneEverSpawned.has(pending.paneId)) {
        helperOpenWatchdog.acknowledge(pending.paneId)
        continue
      }
      if (!identity || identity.role !== 'ajudante' || !live) {
        helperOpenWatchdog.acknowledge(pending.paneId)
        if (identity) rollbackFailedPaneSpawn(pending.paneId, 'armamento do ajudante perdeu a spec')
        continue
      }
      const delegatorAlive =
        !identity.delegatorPaneId || Boolean(hub.identityByPane(identity.delegatorPaneId))
      if (
        pending.action === 'retry' &&
        delegatorAlive &&
        uiSender &&
        !uiSender.isDestroyed()
      ) {
        uiSender.send('panes:open', live.projectId, live.taskId, live.spec)
        blackbox.record({
          cat: 'pane',
          event: 'helper-open-retried',
          actor: 'harness',
          ids: {
            projectId: identity.projectId,
            missionId: identity.missionId,
            taskId: identity.taskId,
            paneId: pending.paneId,
            role: 'ajudante'
          },
          reason: 'ajudante armado nao criou PTY apos o primeiro push; panes:open reenviado uma vez'
        })
        continue
      }
      blackbox.record({
        cat: 'pane',
        event: 'helper-open-expired',
        actor: 'harness',
        ids: {
          projectId: identity.projectId,
          missionId: identity.missionId,
          taskId: identity.taskId,
          paneId: pending.paneId,
          role: 'ajudante'
        },
        reason: delegatorAlive
          ? 'ajudante nao criou PTY depois de duas tentativas'
          : 'delegador encerrou antes de o ajudante criar PTY'
      })
      rollbackFailedPaneSpawn(
        pending.paneId,
        delegatorAlive
          ? 'o pedido de abertura se perdeu duas vezes'
          : 'o pane delegador encerrou antes do inicio'
      )
    }

    for (const [missionId, watch] of [...missionWatches]) {
      if (!existsSync(watch.marker)) continue
      let content = ''
      try {
        content = readFileSync(watch.marker, 'utf-8')
      } catch {
        continue // ainda sendo escrito
      }
      try {
        ensureProjectRuntimeWritable(watch.projectId)
      } catch {
        continue
      }
      try {
        unlinkSync(watch.marker)
      } catch {
        // já sumiu
      }
      missionWatches.delete(missionId)
      handleMissionVerdict(watch, content)
    }
  }, 3000)


  // Versão atual do projeto: tarefas novas são carimbadas com ela (filtro do
  // board por versão).
  ipcMain.handle('maestro:setVersion', (e, projectId: string, version: string) => {
    bindUiSender(e.sender)
    maestro.update(projectId, { version: version.trim() || undefined })
    hub.publish({
      projectId,
      kind: 'info',
      text: version.trim() ? `versão atual do projeto: ${version.trim()}` : 'versão do projeto limpa',
      actor: 'user'
    })
  })

  ipcMain.handle(
    'tasks:run',
    async (e, projectId: string, taskId: string, seatId: string, model?: string, effort?: string) => {
      bindUiSender(e.sender)
      // F5.7: card de plano nunca roda o pipeline; card AUTO é disparado pelo
      // orquestrador via run_task, não pelo usuário.
      const guard = tasks.get(taskId)
      if (guard && (guard.kind === 'plan' || guard.auto)) return null
      if (guard?.missionId) {
        hub.publish({
          projectId,
          missionId: guard.missionId,
          kind: 'error',
          text:
            'execução manual bloqueada: dentro de uma missão, os cards são executados pelo orquestrador conforme o plano aprovado',
          actor: 'harness'
        })
        return null
      }
      if (guard && !guard.missionId) {
        const unplannedRisk = assessMissionRisk({
          texts: [
            guard.title,
            guard.description,
            guard.briefing,
            ...(guard.quests ?? [])
          ]
        })
        if (unplannedRisk.surfaces.length > 0) {
          hub.publish({
            projectId,
            kind: 'error',
            text:
              `execução avulsa bloqueada: o card toca ${unplannedRisk.surfaces.join(', ')}. ` +
              'Superfícies de risco só executam dentro de uma missão com plano aprovado.',
            actor: 'harness',
            urgent: true
          })
          return null
        }
      }
      if (
        guard &&
        !guard.missionId &&
        projectModeOf(projectId) === 'greenfield' &&
        projectPlanOf(projectId)?.status !== 'done'
      ) {
        hub.publish({
          projectId,
          kind: 'error',
          text:
            'execução avulsa bloqueada: este projeto novo ainda segue o plano mestre — volte ao Maestro e siga a próxima missão indicada',
          actor: 'harness'
        })
        return null
      }
      // Devolve a spec do pane TUI — o renderer abre o terminal de verdade.
      const spec = await preparePhasePane(projectId, taskId, 'dev', seatId, model, effort)
      // Orquestrador SABE quando o usuário inicia um card (pedido do usuário):
      // evento com missionId cai direto no pane do orquestrador da missão.
      if (spec) {
        const task = tasks.get(taskId)
        const seat = seats.get(seatId)
        if (task) {
          hub.publish({
            projectId,
            missionId: task.missionId,
            kind: 'info',
            text: `usuário INICIOU o card "${task.title}" (dev · seat ${seat?.name ?? seatId}${model ? ` · ${model}` : ''}) — acompanhe e coordene; o report do dev avisa quando concluir`,
            actor: 'user'
          })
        }
      }
      return spec
    }
  )


  /** Raízes autorizadas para links impressos por um pane. O renderer não pode
   * escolher um cwd: ele só informa o paneId, e o main recupera a identidade
   * que foi armada para aquele processo. */


  ipcMain.on('pty:startup-request', (_e, paneId: string) => {
    if (typeof paneId !== 'string' || paneId.length > 200 || ptys.has(paneId)) return
    paneStartupMetrics?.request(paneId)
  })

  ipcMain.on('pty:first-frame', (_e, paneId: string) => {
    if (typeof paneId !== 'string' || paneId.length > 200) return
    paneStartupMetrics?.mark(paneId, 'terminal_first_frame')
  })

  // Um modal pode ser fechado enquanto o seed assíncrono do seat ainda está
  // em andamento. O ticket impede que a continuação abra um processo órfão.
  const pendingPtyPreparations = new Map<string, symbol>()

  ipcMain.handle('pty:create', async (e, req: PaneRequest) => {
    const pendingIdentity = hub.identityByPane(req.id)
    const token = paneTokens.get(req.id)
    const cached = livePaneSpecs.get(req.id)
    // O terminal isolado de login não é um pane do Hub e, portanto, não possui
    // identity/token. Ele continua sendo autorizado de forma estrita: o id
    // precisa apontar para o próprio seat e o CLI solicitado deve ser o mesmo
    // cadastrado nessa conta. Sem esta exceção o handler retornava `false` em
    // silêncio e o overlay ficava apenas com uma tela preta.
    const requestedSeat = req.seatId ? seats.get(req.seatId) : undefined
    const isSeatLogin =
      requestedSeat != null &&
      req.id === `login-${requestedSeat.id}` &&
      req.kind === requestedSeat.cli &&
      req.cwd === '' &&
      req.taskId == null &&
      req.initialPrompt == null &&
      req.model == null &&
      req.cliArgs == null &&
      req.appendSystemPrompt == null &&
      req.logFile == null &&
      pendingIdentity == null &&
      token == null &&
      cached == null
    if (req.kind !== 'shell' && !isSeatLogin) {
      const identityMismatch =
        !pendingIdentity ||
        !token ||
        closingPaneIds.has(req.id) ||
        resolve(req.cwd).toLocaleLowerCase('en-US') !==
          resolve(pendingIdentity.cwd).toLocaleLowerCase('en-US') ||
        req.taskId !== pendingIdentity.taskId ||
        req.seatId !== pendingIdentity.seatId ||
        (cached != null &&
          (cached.spec.kind !== req.kind ||
            cached.spec.cwd !== req.cwd ||
            cached.spec.seatId !== req.seatId ||
            cached.taskId !== (req.taskId ?? '')))
      if (identityMismatch) {
        const projectId = pendingIdentity?.projectId ?? cached?.projectId
        if (pendingIdentity || cached) {
          rollbackFailedPaneSpawn(req.id, 'armamento ausente, encerrando ou divergente')
        } else {
          paneTokens.delete(req.id)
          cleanPaneMcpFile(req.id)
        }
        if (projectId && !e.sender.isDestroyed()) {
          e.sender.send('panes:closeById', projectId, req.id)
        }
        return false
      }
    }
    if (pendingIdentity?.role === 'ajudante' && pendingIdentity.taskId) {
      const owner = tasks.get(pendingIdentity.taskId)
      if (
        !owner ||
        owner.status !== 'execucao' ||
        owner.activePhase !== 'dev' ||
        (owner.phaseState !== 'pending' && owner.phaseState !== 'running')
      ) {
        unregisterPane(req.id)
        paneTokens.delete(req.id)
        cleanPaneMcpFile(req.id)
        if (!e.sender.isDestroyed())
          e.sender.send('panes:closeById', pendingIdentity.projectId, req.id)
        return false
      }
    }
    const reusedPty = ptys.has(req.id)
    if (!reusedPty) paneStartupMetrics?.begin(req.id, paneStartupDescriptor(req))
    const seat = requestedSeat
    const extraEnv: Record<string, string> = {}
    let effectiveCliArgs = req.cliArgs ? [...req.cliArgs] : undefined
    if (seat) {
      const dir = seats.configDirOf(seat)
      const preparationTicket = Symbol(req.id)
      pendingPtyPreparations.set(req.id, preparationTicket)
      await seats.prepare(seat)
      const phaseStillActive = (): boolean => {
        if (reusedPty || !pendingIdentity?.taskId) return true
        const owner = tasks.get(pendingIdentity.taskId)
        if (pendingIdentity.role === 'ajudante') {
          return Boolean(
            owner &&
              owner.status === 'execucao' &&
              owner.activePhase === 'dev' &&
              (owner.phaseState === 'pending' || owner.phaseState === 'running')
          )
        }
        if (
          pendingIdentity.role === 'dev' ||
          pendingIdentity.role === 'review' ||
          pendingIdentity.role === 'qa'
        ) {
          const watch = phaseWatches.get(pendingIdentity.taskId)
          return Boolean(
            owner &&
              owner.status !== 'done' &&
              owner.activePhase === pendingIdentity.role &&
              (owner.phaseState === 'pending' || owner.phaseState === 'running') &&
              watch?.phase === pendingIdentity.role &&
              watch.paneId === req.id
          )
        }
        return true
      }
      const preparationCanContinue = (): boolean =>
        ptyPreparationCanContinue({
          ticketMatches: pendingPtyPreparations.get(req.id) === preparationTicket,
          senderAlive: !e.sender.isDestroyed(),
          closing: closingPaneIds.has(req.id),
          requiresPaneGeneration: req.kind !== 'shell' && !isSeatLogin,
          capturedIdentity: pendingIdentity,
          currentIdentity: hub.identityByPane(req.id),
          capturedToken: token,
          currentToken: paneTokens.get(req.id),
          capturedSpec: cached,
          currentSpec: livePaneSpecs.get(req.id),
          phaseStillActive: phaseStillActive()
        })
      if (!preparationCanContinue()) {
        if (pendingPtyPreparations.get(req.id) === preparationTicket) {
          pendingPtyPreparations.delete(req.id)
        }
        return false
      }
      if (
        !reusedPty &&
        seat.cli === 'codex' &&
        isMethodGovernedPaneRole(pendingIdentity?.role)
      ) {
        let preparedProfile:
          | { profileName: string; profilePath: string }
          | undefined
        try {
          preparedProfile = await prepareCodexSkillIsolationProfile({
            paneGenerationId: `${req.id}-${randomUUID()}`,
            cwd: req.cwd,
            configDir: dir
          })
        } catch (error) {
          const stillOwnsPreparation =
            pendingPtyPreparations.get(req.id) === preparationTicket
          if (stillOwnsPreparation) {
            pendingPtyPreparations.delete(req.id)
            rollbackFailedPaneSpawn(
              req.id,
              `catálogo de skills do Codex não pôde ser isolado: ${String(error)}`
            )
          }
          return false
        }
        // Profile generation executes the provider binary and crosses an
        // await. Revalidate the complete pane generation before spawning.
        if (!preparationCanContinue()) {
          removeCodexSkillIsolationProfile(preparedProfile.profilePath)
          if (pendingPtyPreparations.get(req.id) === preparationTicket) {
            pendingPtyPreparations.delete(req.id)
          }
          return false
        }
        const previousProfile = paneCodexSkillProfiles.get(req.id)
        paneCodexSkillProfiles.set(req.id, preparedProfile.profilePath)
        if (previousProfile && previousProfile !== preparedProfile.profilePath) {
          removeCodexSkillIsolationProfile(previousProfile)
        }
        effectiveCliArgs = [
          ...(effectiveCliArgs ?? []),
          '-p',
          preparedProfile.profileName
        ]
      }
      pendingPtyPreparations.delete(req.id)
      if (seat.cli === 'claude') extraEnv['CLAUDE_CONFIG_DIR'] = dir
      else extraEnv['CODEX_HOME'] = dir
    }
    // Pane registrado no hub → bearer token do MCP vai pelo env (codex lê
    // via bearer_token_env_var; inofensivo para os demais).
    if (token) extraEnv['SYNKORA_TOKEN'] = token
    // CORRIDA REAL (maestro da Luma nasceu com "MCP config file not found"):
    // remount do pane reusa o MESMO id — o kill do pty antigo roda
    // cleanPaneMcpFile e apaga o arquivo que o armPane acabou de (re)gravar
    // para o pty novo. Regrava aqui, na hora do spawn: idempotente, o nome é
    // derivado do paneId e o conteúdo só depende de porta+token.
    if (req.kind === 'claude' && token && req.cliArgs?.includes('--mcp-config')) {
      const strict = req.cliArgs.includes('--strict-mcp-config')
      // Remount precisa reproduzir EXATAMENTE o perfil decidido em armPane.
      // Sem identidade comprovada, falha fechado sem MCP externo.
      const external = pendingIdentity
        ? paneExternalMcpCapabilities(paneAccessProfile(pendingIdentity.role))
        : { browser: false, testRunner: false }
      const browser = strict && external.browser ? externalPlaywrightForPane() : undefined
      const testRunner =
        strict && external.testRunner
          ? resolveProjectPlaywrightTest(req.cwd)
          : undefined
      const file = writeClaudeMcpConfig(
        join(app.getPath('userData'), 'mcp'),
        req.id,
        mcpPort,
        token,
        browser,
        testRunner
      )
      paneMcpFiles.set(req.id, file)
    }
    const sender = e.sender
    const cwd = req.cwd || app.getPath('home')
    let statsWatchHandle: StatsWatchHandle | undefined
    if (!reusedPty) paneStartupMetrics?.mark(req.id, 'pty_spawn_started')
    let ptyCreated: boolean
    try {
      ptyCreated = ptys.create(sender, {
      id: req.id,
      // cwd vazio = login/uso fora de projeto: roda na home do usuário.
      cwd,
      kind: req.kind,
      extraEnv,
      initialPrompt: req.initialPrompt,
      model: req.model,
      cliArgs: effectiveCliArgs,
      appendSystemPrompt: req.appendSystemPrompt,
      cols: req.cols,
      rows: req.rows,
      logFile: req.logFile,
      canWriteLog: req.logFile
        ? () => {
            if (!pendingIdentity) return false
            ensureProjectRuntimeWritable(pendingIdentity.projectId)
            return true
          }
        : undefined,
      // Pane de tarefa pedindo aprovação → o card correspondente pulsa.
      // Com BYPASS ligado o CLI não pede nada — a heurística só dava falso
      // positivo (mãozinha apitando à toa); o estado do pane (●/◌/■) cobre.
      onAttention: req.taskId
        ? () => {
            const identity = hub.identityByPane(req.id)
            const paneHasAutomaticBypass =
              req.cliArgs?.includes('--dangerously-bypass-approvals-and-sandbox') === true ||
              req.cliArgs?.includes('bypassPermissions') === true
            if (identity && paneHasAutomaticBypass) return
            // manda o PANE junto: dev, ajudantes e gate dividem o MESMO taskId,
            // então só com o taskId o 🖐 acendia (e piscava) em todos eles
            if (!sender.isDestroyed()) sender.send('tasks:attention', req.taskId, req.id)
          }
        : undefined,
      // Janela REAL de contexto do banner do TUI → teto do medidor do pane.
      onCtxWindow: (tokens) => sessionStats.setWindowHint(req.id, tokens),
      onOutput: () => {
        paneStartupMetrics?.observeOutput(req.id)
        if (hub.identityByPane(req.id)?.role === 'maestro') {
          scheduleProgressLiveSnapshot(req.id)
        }
      },
      onSubmit: () => paneStartupMetrics?.markFirstMessage(req.id),
      onSecurityDecision: (decision) => {
        const identity = hub.identityByPane(req.id)
        blackbox.record({
          cat: 'user',
          event:
            decision.action === 'human-authorized'
              ? 'terminal-sensitive-action-authorized'
              : 'terminal-sensitive-action-blocked',
          actor: decision.action === 'human-authorized' ? 'user' : 'harness',
          ids: {
            paneId: req.id,
            projectId: identity?.projectId,
            missionId: identity?.missionId,
            taskId: identity?.taskId,
            role: identity?.role
          },
          reason: decision.action === 'allow' ? undefined : decision.reason,
          detail:
            decision.action === 'allow'
              ? undefined
              : {
                  category: decision.category,
                  commandName: decision.commandName,
                  rawCommandPersisted: false
                }
        })
      },
      // --resume recusado (sessão sem transcript no disco): invalida o id
      // persistido — o PtyManager já respawna o pane sem o --resume sozinho.
      onResumeFail: () => {
        paneSessions.delete(req.id)
        sessionStats.noteReset(req.id)
        if (req.id.startsWith('maestro-')) {
          maestro.update(req.id.slice('maestro-'.length), {
            tuiSessionId: undefined,
            tuiContextTokens: undefined
          })
        }
        const identity = hub.identityByPane(req.id)
        if (identity?.taskId && (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')) {
          const task = tasks.get(identity.taskId)
          if (task) {
            const phaseSessions = { ...(task.phaseSessions ?? {}) }
            delete phaseSessions[identity.role]
            tasks.update(identity.taskId, {
              phaseSessions,
              ...(task.phaseResume?.phase === identity.role ? { phaseResume: undefined } : {})
            })
          }
        }
      },
      // /clear (claude) e /new|/fork (codex) começam conversa NOVA no TUI, mas o
      // arquivo de sessão novo só nasce na 1ª mensagem seguinte — se o app
      // fechar antes, o --resume persistido traria a conversa velha de volta
      // (bug real). Detecta o comando na hora e invalida o resume.
      onCommand: (cmd) => {
        const c = cmd.split(/\s+/)[0].toLowerCase()
        // O TUI completa slash commands internamente: o PTY ve "/fo" + Tab +
        // Enter, nao o sufixo "rk" pintado na tela. Prefixos com 2+ letras sao
        // univocos para estes tres comandos e cobrem esse caminho real.
        const completed = (full: string): boolean =>
          c === full || (c.length >= 3 && full.startsWith(c))
        const resets =
          req.kind === 'claude'
            ? completed('/clear')
            : completed('/new') || completed('/fork')
        if (!resets) return
        paneSessions.delete(req.id)
        // só ESTE pane pode migrar para o arquivo de sessão novo — sem isso
        // o /clear de um pane roubava o arquivo para os vizinhos de cwd
        sessionStats.noteReset(req.id)
        // avisa o xterm: /clear (ou /new) deve limpar TAMBÉM o scrollback, senão
        // a conversa "apagada" continua acessível rolando para cima. Sinal LIMPO
        // (o usuário digitou o comando de fato) — nada de adivinhar por texto.
        // Com o conpty.dll o backend também é limpo de verdade (clear() =
        // ConptyClearPseudoConsole): sem isso o buffer do ConPTY ainda guarda a
        // conversa velha e a devolve na primeira repintura.
        // /fork cria outro rollout, mas preserva a tela/historico visual do
        // Codex. /clear e /new continuam limpando backend + scrollback.
        if (c !== '/fork') {
          ptys.clear(req.id)
          if (!sender.isDestroyed()) sender.send('pty:reset', req.id)
        }
        if (req.id.startsWith('maestro-')) {
          maestro.update(req.id.slice('maestro-'.length), {
            tuiSessionId: undefined,
            tuiContextTokens: undefined
          })
        }
        const identity = hub.identityByPane(req.id)
        if (identity?.taskId && (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')) {
          const task = tasks.get(identity.taskId)
          if (task) {
            const phaseSessions = { ...(task.phaseSessions ?? {}) }
            delete phaseSessions[identity.role]
            tasks.update(identity.taskId, {
              phaseSessions,
              ...(task.phaseResume?.phase === identity.role ? { phaseResume: undefined } : {})
            })
          }
        }
      },
      // "Login expired" na saída → seat marcado como expirado no rail + hub.
      onLoginExpired: seat
        ? () => {
            if (!expiredSeats.has(seat.id)) {
              expiredSeats.set(seat.id, Date.now())
              const identity = hub.identityByPane(req.id)
              if (identity) {
                hub.publish({
                  projectId: identity.projectId,
                  kind: 'error',
                  text: `login do seat ${seat.name} EXPIROU — refaça em Configurações › Minhas contas`,
                  actor: 'harness'
                })
              }
            }
            if (!sender.isDestroyed()) sender.send('seats:changed')
          }
        : undefined,
      onExit: (exitCode, outputTail) => {
        // GERAÇÃO DO ARMAMENTO: remount reusa o MESMO paneId, e o armPane do
        // paneSpec já criou token/identidade/arquivo MCP para o pty que vai
        // nascer. Se o token corrente não é mais o que ESTE processo recebeu no
        // spawn, este exit é do processo VELHO: não pode desarmar o pane novo,
        // roubar o watcher dele nem mover o pipeline (tarefa→backlog,
        // missão→ativa). O token é a prova de dono (pane shell não tem token:
        // undefined === undefined e o fluxo segue normal).
        if (paneTokens.get(req.id) !== token) return
        testServerPanes.delete(req.id)
        paneStartupMetrics?.end(req.id)
        if (statsWatchHandle != null) sessionStats.unwatch(req.id, statsWatchHandle)
        // remount reusa paneId: o first-contact do processo MORTO não pode
        // valer como prova de conexão do processo novo
        mcpPaneFirstContact.delete(req.id)
        const identity = unregisterPane(req.id)
        blackbox.record({
          cat: 'pane',
          event: 'exit',
          ids: identity
            ? {
                projectId: identity.projectId,
                missionId: identity.missionId,
                taskId: identity.taskId,
                paneId: req.id,
                phase: identity.phase,
                role: identity.role,
                seatId: identity.seatId
              }
            : { paneId: req.id },
          // exitCode + últimas linhas: a morte em spawn do orquestrador de
          // 02/08 foi invisível no diário ("caixa-preta SEM EXCEÇÕES").
          detail: { kind: req.kind, exitCode, outputTail }
        })
        livePaneSpecs.delete(req.id)
        closingPaneIds.delete(req.id)
        paneTokens.delete(req.id)
        cleanPaneMcpFile(req.id)
        if (!identity) return
        if (identity.role === 'maestro') {
          const idleTimer = progressLiveIdleTimers.get(req.id)
          if (idleTimer) clearTimeout(idleTimer)
          progressLiveIdleTimers.delete(req.id)
          refreshProgressLiveSnapshot()
        }
        const paneSender = uiSender && !uiSender.isDestroyed() ? uiSender : sender
        if (!paneSender.isDestroyed()) {
          paneSender.send('panes:closeById', identity.projectId, req.id)
        }
        // Ajudante que morreu SEM reportar done (crash/fechado): o delegador
        // é avisado na hora — controle total sobre os ajudantes (pedido do
        // usuário). SEM ruído: com report, com helper_close deliberado ou com
        // a saída já lida (helper_output), avisar atrapalha em vez de ajudar.
        if (identity.role === 'ajudante' && identity.delegatorPaneId) {
          const reported = helperReported.delete(identity.paneId)
          const seen = helperSeen.delete(identity.paneId)
          if (!reported) helperCompletions.discard(identity.paneId)
          if (!reported) updateStoredHelperStatus(identity.projectId, identity.paneId, 'interrupted')
          if (!reported && !seen) {
            const helperPath = helperTranscriptPath(identity.projectId, identity.paneId)
            const project = projects.get(identity.projectId)
            const relativePath = helperPath && project
              ? helperPath.slice(project.path.length + 1).replace(/\\/g, '/')
              : `.synkora/runs/helper-${identity.paneId}.md`
            hub.notifyPane(
              identity.delegatorPaneId,
              `ajudante ${identity.paneId.slice(0, 8)} ENCERROU SEM reportar done — helper_output ainda lê o final da saída; transcript em ${relativePath}`,
              {
                sourcePaneId: identity.paneId,
                kind: 'feedback',
                correlationId: randomUUID()
              }
            )
          }
        }
        // FASE ATIVA morreu junto com o pane (usuário fechou/crash): solta o
        // watch, devolve a tarefa para o backlog com o motivo e avisa o
        // orquestrador AO VIVO — nada fica preso em "execução" fantasma.
        if (identity.taskId) {
          // O runtime do QA vive e morre com o PANE do QA (gate vivo em
          // espera mantém os dois; morte por qualquer motivo derruba a
          // árvore do dev server — nada de Electron/vite órfão).
          if (identity.role === 'qa') stopQaRuntime(identity.taskId)
          // Gate VIVO em espera fechado na mão: só higiene do mapa — o
          // reciclo seguinte detecta o pane morto e abre um gate novo.
          const gateWait = liveGateWaits.get(identity.taskId)
          if (gateWait && gateWait.paneId === identity.paneId)
            liveGateWaits.delete(identity.taskId)
          const watch = phaseWatches.get(identity.taskId)
          if (watch && watch.phase === identity.phase) {
            phaseWatches.delete(identity.taskId)
            const task = tasks.get(identity.taskId)
            if (task && task.status !== 'done') {
              if (watch.phase === 'review' || watch.phase === 'qa') {
                // GATE morreu sem veredito: o trabalho do dev está INTACTO no
                // worktree — voltar ao backlog custava uma rodada inteira de
                // dev (caso real 2026-07-30). O card fica onde está e o
                // orquestrador reabre SÓ o gate.
                // BREAKER DE CRASH-LOOP (caso real 05/08 16:59: review morreu
                // 3× em 33s e cada morte foi reaberta às cegas — precedente do
                // Board: 3 mortes/30s param de ressuscitar).
                const { looping, deaths } = phaseEngine.recordGateDeath(identity.taskId)
                tasks.update(identity.taskId, {
                  status: watch.phase === 'qa' ? 'qa' : 'execucao',
                  activePhase: watch.phase,
                  phaseState: 'interrupted',
                  ...(task.feedback
                    ? {}
                    : {
                        feedback: `gate ${watch.phase} interrompido (pane fechado) — o desenvolvimento está preservado`
                      })
                })
                hub.publish({
                  projectId: identity.projectId,
                  missionId: identity.missionId,
                  kind: 'error',
                  text: looping
                    ? `gate ${watch.phase} de "${task.title}" morreu ${deaths}× em 1 minuto SEM veredito — reabertura automática SUSPENSA por 5 minutos. NÃO re-rode em reflexo: leia as últimas linhas no evento pane/exit da caixa-preta, avalie trocar o seat/modelo do gate (config do reviewer ou lane) e só então reabra com run_task {id: "${identity.taskId}", phase: "${watch.phase}"}`
                    : `gate ${watch.phase} de "${task.title}" fechou SEM veredito — o trabalho do dev está intacto; reabra só o gate com run_task {id: "${identity.taskId}", phase: "${watch.phase}"}`,
                  actor: 'harness'
                })
              } else {
                terminateTaskHelpers(
                  identity.projectId,
                  identity.taskId,
                  'pane dev encerrou antes de concluir a fase'
                )
                tasks.update(identity.taskId, {
                  status: 'backlog',
                  ...(task.feedback
                    ? {}
                    : {
                        feedback: `fase ${watch.phase} interrompida (pane fechado) — transcript .synkora/runs/${identity.taskId}.md registra o que já foi feito`
                      }),
                  activePhase: 'dev',
                  phaseState: 'interrupted'
                })
                hub.publish({
                  projectId: identity.projectId,
                  missionId: identity.missionId,
                  kind: 'error',
                  text: `pane ${identity.role} de "${task.title}" FECHOU no meio da fase ${watch.phase} — worktree, briefing e transcript foram preservados; retome o MESMO card com run_task {id: "${identity.taskId}"}. Atualize o briefing somente se o escopo real tiver mudado`,
                  actor: 'harness'
                })
              }
              if (!sender.isDestroyed()) sender.send('tasks:changed', identity.projectId)
              syncBoard(identity.projectId)
            }
          }
        } else if (identity.missionId && identity.role === 'review') {
          // gate de INTEGRAÇÃO fechado sem veredito
          const mw = missionWatches.get(identity.missionId)
          if (mw && mw.paneId === identity.paneId) {
            missionWatches.delete(identity.missionId)
            missions.update(identity.missionId, { status: 'ativa' })
            hub.publish({
              projectId: identity.projectId,
              missionId: identity.missionId,
              kind: 'error',
              text: 'o gate de integração fechou sem veredito — chame integrate_mission de novo quando quiser',
              actor: 'harness'
            })
            emitMissionsChanged(identity.projectId)
          }
        }
        if (identity.role !== 'maestro') {
          hub.publish({
            projectId: identity.projectId,
            missionId: identity.missionId,
            kind: 'pane-close',
            text: `pane ${identity.role} encerrado${identity.taskId ? ` (tarefa ${tasks.get(identity.taskId)?.title ?? identity.taskId})` : ''}`,
            actor: identity.role,
            // QUIET (decisão 2026-07-28, coerente com o PM silencioso):
            // abrir pane manual nunca avisou — fechar avisar era assimétrico
            // e ruído ("pane livre encerrado" → PM responde "Ok."). O ciclo
            // de vida cru de pane fica em EVENTS.md/UI; o que IMPORTA já tem
            // evento próprio: fase interrompida (error), ajudante morto sem
            // report (notifyPane) e missão direta do agente livre.
            quiet: true
          })
        }
      }
      })
    } catch (error) {
      paneStartupMetrics?.fail(req.id)
      blackbox.record({
        cat: 'pane',
        event: 'spawn-failed',
        ids: { paneId: req.id, taskId: req.taskId, seatId: req.seatId },
        detail: { kind: req.kind, cwd },
        err: error instanceof Error ? error.message : String(error)
      })
      rollbackFailedPaneSpawn(
        req.id,
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
    if (ptyCreated) {
      paneEverSpawned.add(req.id)
      helperOpenWatchdog.acknowledge(req.id)
      // Servidor de teste do dono: o pane shell nasce cru — o comando entra
      // digitado (inject fatiado) assim que o prompt do PowerShell assentar.
      const testSrv = testServerPanes.get(req.id)
      if (req.kind === 'shell' && testSrv) {
        setTimeout(() => {
          if (ptys.has(req.id)) ptys.inject(req.id, testSrv.command)
        }, 1200)
      }
      const spawnIdentity = hub.identityByPane(req.id)
      if (
        spawnIdentity &&
        (spawnIdentity.role === 'review' || spawnIdentity.role === 'qa') &&
        spawnIdentity.taskId
      ) {
        armGateMcpWatchdog(spawnIdentity, req.id)
      }
      // DEV SEM MCP NUNCA É SILENCIOSO (caso real 04/08 23:28: dev codex
      // trabalhou a fase INTEIRA sem nenhuma requisição autenticada —
      // notify_pane não alcançava e ninguém sabia). Irmão SOFT do watchdog de
      // gate: 120s sem 1º contato → evento informativo ao orquestrador; nada
      // é morto (o done ainda chega pelo marcador .done).
      if (spawnIdentity && spawnIdentity.role === 'dev' && spawnIdentity.taskId) {
        const devIdentity = spawnIdentity
        const devPaneId = req.id
        const soft = setTimeout(() => {
          if (!ptys.has(devPaneId)) return
          if (mcpPaneFirstContact.has(devPaneId)) return
          const stillSame = hub.identityByPane(devPaneId)
          if (!stillSame || stillSame.role !== 'dev' || stillSame.taskId !== devIdentity.taskId)
            return
          blackbox.record({
            cat: 'mcp',
            event: 'dev-mcp-silent',
            actor: 'harness',
            ids: {
              projectId: devIdentity.projectId,
              missionId: devIdentity.missionId,
              taskId: devIdentity.taskId,
              paneId: devPaneId,
              phase: 'dev',
              role: 'dev'
            },
            reason: 'nenhuma requisição MCP autenticada em 120s — pane possivelmente degradado'
          })
          hub.publish({
            projectId: devIdentity.projectId,
            missionId: devIdentity.missionId,
            kind: 'info',
            text: `o dev do card ${devIdentity.taskId?.slice(0, 8)} está SEM MCP nesta sessão (nenhuma requisição em 120s) — notify_pane pode não alcançar e o done virá por marcador; se precisar corrigir rumo, use update_task + respawn (run_task)`,
            actor: 'harness'
          })
        }, 120_000)
        soft.unref?.()
      }
      blackbox.record({
        cat: 'pane',
        event: reusedPty ? 'remount' : 'spawn',
        ids: spawnIdentity
          ? {
              projectId: spawnIdentity.projectId,
              missionId: spawnIdentity.missionId,
              taskId: spawnIdentity.taskId,
              paneId: req.id,
              phase: spawnIdentity.phase,
              role: spawnIdentity.role,
              seatId: spawnIdentity.seatId
            }
          : { paneId: req.id, taskId: req.taskId, seatId: req.seatId },
        detail: {
          kind: req.kind,
          model: req.model,
          cwd,
          resume: req.cliArgs?.includes('--resume') || req.cliArgs?.includes('resume') || false,
          hasInitialPrompt: Boolean(req.initialPrompt)
        }
      })
      closingPaneIds.delete(req.id)
      paneStartupMetrics?.mark(req.id, 'pty_spawn_completed')
      if (req.initialPrompt) paneStartupMetrics?.markFirstMessage(req.id)
      const identity = hub.identityByPane(req.id)
      if (
        identity?.taskId &&
        (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')
      ) {
        const task = tasks.get(identity.taskId)
        const watch = phaseWatches.get(identity.taskId)
        if (
          task?.phaseState === 'pending' &&
          watch?.paneId === req.id &&
          watch.phase === identity.role
        ) {
          tasks.update(identity.taskId, {
            phaseState: 'running',
            phaseStartedAt: new Date().toISOString()
          })
          if (!sender.isDestroyed()) sender.send('tasks:changed', identity.projectId)
          syncBoard(identity.projectId)
        }
      }
    }
    // Badges ao vivo: tokens/contexto lidos do JSONL que o próprio CLI grava.
    if (ptyCreated && req.kind !== 'shell') {
      // Pane RESUMADO conhece a própria sessão (--resume <sid> / resume <tid>
      // nos cliArgs) — adoção exata no watcher, imune a vizinhos de cwd.
      let sessionHint: string | undefined
      const rawArgs = req.cliArgs ?? []
      const resumeIdx = rawArgs.indexOf(req.kind === 'claude' ? '--resume' : 'resume')
      if (resumeIdx >= 0 && rawArgs[resumeIdx + 1] && !rawArgs[resumeIdx + 1].startsWith('-')) {
        sessionHint = rawArgs[resumeIdx + 1]
      }
      // TETO DE CUSTO DO RESUME (2026-08-06): carimba o contexto vivo da fase
      // no card para o próximo respawn decidir resume × fresco. Throttle por
      // delta (25k) — gravar a cada tick seria churn no tasks.json.
      let lastStampedCtx = 0
      const stampPhaseContext = (contextTokens: number | null): void => {
        if (contextTokens == null) return
        const identity = hub.identityByPane(req.id)
        const phase = identity?.phase
        if (!identity?.taskId || !phase) return
        if (Math.abs(contextTokens - lastStampedCtx) < 25_000) return
        const task = tasks.get(identity.taskId)
        const entry = task?.phaseSessions?.[phase]
        if (!entry) return
        lastStampedCtx = contextTokens
        tasks.update(identity.taskId, {
          phaseSessions: {
            ...task!.phaseSessions,
            [phase]: { ...entry, lastContextTokens: contextTokens }
          }
        })
      }
      // TETO DE CUSTO DO RESUME DO PM/ORQUESTRADOR (pedido do usuário,
      // 2026-08-06: "eles não podem ter que reler a conversa toda"): mesmo
      // carimbo da fase, gravado no maestroStore para o próximo paneSpec
      // decidir resume × fresco. Throttle 25k — churn no maestro.json.
      let lastMaestroCtx = 0
      const stampMaestroContext = (contextTokens: number | null): void => {
        if (contextTokens == null || !req.id.startsWith('maestro-')) return
        if (Math.abs(contextTokens - lastMaestroCtx) < 25_000) return
        lastMaestroCtx = contextTokens
        maestro.update(req.id.slice('maestro-'.length), { tuiContextTokens: contextTokens })
      }
      statsWatchHandle = sessionStats.watch(req.id, {
        cli: req.kind,
        configDir: seat ? seats.configDirOf(seat) : undefined,
        cwd,
        sessionHint,
        // o JSONL não carrega o [1m] — o teto real vem do modelo do spawn
        modelHint: req.model,
        onStats: (stats) => {
          if (!sender.isDestroyed()) sender.send('panes:stats', req.id, stats)
          stampPhaseContext(stats.contextTokens)
          stampMaestroContext(stats.contextTokens)
        },
        onSession: (sessionId) => {
          paneSessions.set(req.id, sessionId)
          // Pane do Maestro: persiste a sessão para o --resume/resume na
          // próxima abertura do projeto/app. Sessão DIFERENTE da persistida =
          // conversa nova — o carimbo de contexto da antiga não pode vetar o
          // resume barato da nova (o stamp recomeça com os stats dela).
          if (req.id.startsWith('maestro-')) {
            const key = req.id.slice('maestro-'.length)
            const prevSession = maestro.get(key).tuiSessionId
            maestro.update(key, {
              tuiSessionId: sessionId,
              ...(prevSession !== sessionId ? { tuiContextTokens: undefined } : {})
            })
          }
          const identity = hub.identityByPane(req.id)
          if (
            identity?.taskId &&
            (identity.role === 'dev' || identity.role === 'review' || identity.role === 'qa')
          ) {
            const task = tasks.get(identity.taskId)
            if (task && task.status !== 'done' && req.seatId) {
              const rawArgs = req.cliArgs ?? []
              const effortFromArgs =
                req.kind === 'claude'
                  ? (() => {
                      const at = rawArgs.indexOf('--effort')
                      return at >= 0 ? rawArgs[at + 1] : undefined
                    })()
                  : rawArgs
                      .find((arg) => arg.startsWith('model_reasoning_effort='))
                      ?.replace(/^model_reasoning_effort=["']?|["']$/g, '')
              const phaseSession = {
                phase: identity.role,
                sessionId,
                seatId: req.seatId,
                cli: req.kind === 'claude' ? 'claude' as const : 'codex' as const,
                model: req.model,
                effort:
                  task.phaseSessions?.[identity.role]?.effort ??
                  (task.phaseResume?.phase === identity.role
                    ? task.phaseResume.effort
                    : effortFromArgs),
                capturedAt: new Date().toISOString()
              }
              tasks.update(identity.taskId, {
                phaseSessions: {
                  ...(task.phaseSessions ?? {}),
                  [identity.role]: phaseSession
                },
                ...(task.activePhase === identity.role ? { phaseResume: phaseSession } : {})
              })
            }
          }
        }
      })
    } else if (!ptyCreated && req.kind !== 'shell') {
      // Remount do renderer: o PTY e o watcher continuam vivos. Reenvia o
      // snapshot porque TerminalPane zerou o store local antes de pty:create.
      sessionStats.replay(req.id)
    }
    return true
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, id: string) => {
    pendingPtyPreparations.delete(id)
    // Este canal chega a CADA REMOUNT do TerminalPane (cliArgs novos de um
    // paneSpec, troca de seat) — "remount" NÃO é "pane fechado". Desarmar aqui
    // apagava o token, a identidade no hub e o userData/mcp/<paneId>.json que o
    // armPane tinha ACABADO de gravar para o pty que ia nascer: o Maestro subia
    // com --mcp-config apontando para arquivo inexistente e SEM NENHUMA tool
    // synkora (create_mission/board_status/delegate), até reiniciar o app.
    // O desarmamento vive no onExit do pty:create, com guard de geração.
    if (!ptys.has(id) && livePaneSpecs.has(id)) {
      if (!paneEverSpawned.has(id)) {
        closingPaneIds.add(id)
        rollbackFailedPaneSpawn(id, 'pane fechado antes de iniciar')
        paneSessions.delete(id)
        return
      }
      // O pane JÁ viveu e morreu (ex.: o main matou o PTY no pós-report e o
      // renderer só desmontou depois): é limpeza de registro, nunca "não
      // conseguiu abrir" — o aviso falso confundia o delegador (bug real,
      // 2026-08-03).
      livePaneSpecs.delete(id)
      closingPaneIds.delete(id)
      paneSessions.delete(id)
      return
    }
    ptys.kill(id)
    paneSessions.delete(id)
  })

  // Curadoria de modelos PARA AGENTES (decisão do usuário, 2026-07-28): os
  // advisors/orquestradores só enxergam e usam as 3 linhas de cima de cada
  // CLI — claude: sonnet/opus/fable · codex: luna/terra/sol. Modelo antigo
  // (spark, mini, gpt-5.3-codex…) não aparece nem é aceito: o orquestrador
  // chegou a mandar um id MORTO (gpt-5.4-mini — o codex o migra p/ luna no
  // config.toml). A UI manual (ModelSelect) segue com o catálogo completo —
  // a curadoria vale para os AGENTES.
  const isBannedModel = (m?: string): boolean => !!m && /spark/i.test(m)
  const isTopModel = (cli: SeatCli, id: string): boolean =>
    cli === 'claude' ? /sonnet|opus|fable/i.test(id) : /luna|terra|sol/i.test(id)
  /** Catálogo do seat filtrado para agentes (top-3; nunca vazio se o catálogo
   *  existir — sem nenhum top, cai na lista completa sem banidos). */
  async function agentModelPool(seat: {
    cli: SeatCli
    id: string
  }): Promise<{ id: string; label: string }[]> {
    const s = seats.get(seat.id)
    if (!s) return []
    const cat = await getCatalog(s.cli, seats.configDirOf(s))
    const top = cat.models.filter((m) => !isBannedModel(m.id) && isTopModel(s.cli, m.id))
    const pool = top.length > 0 ? top : cat.models.filter((m) => !isBannedModel(m.id))
    return pool.map((m) => ({ id: m.id, label: m.label }))
  }

  // ————— API real por trás das ferramentas MCP do Synkora —————
  // CHECK 14: assinatura do último catálogo servido por pane — só mudança
  // (ou 1º serve) vira evento; requisições repetidas não inundam o journal.
  const mcpCatalogServedByPane = new Map<string, string>()
  // Autorizações humanas de uso único. Só handlers IPC acionados pela UI
  // entram nestes conjuntos e consomem a autorização na mesma pilha síncrona;
  // nenhuma tool MCP consegue fabricar o gesto do dono.
  const humanProjectPlanApprovals = new Set<string>()
  const humanProjectMissionStarts = new Set<string>()
  const preparePlanningArtifactEvidence = (
    id: PaneIdentity,
    skillApplications: string[] | undefined
  ):
    | { ok: true; evidence: PlanningMethodEvidence; accept: () => boolean }
    | { ok: false; message: string } => {
    const scope = skillPlanScopes.get(id.paneId)
    const currentIdentity = hub.identityByPane(id.paneId)
    if (
      id.role !== 'maestro' ||
      !scope ||
      scope.phase !== 'planning' ||
      scope.projectId !== id.projectId ||
      scope.missionId !== id.missionId ||
      !currentIdentity ||
      currentIdentity.projectId !== id.projectId ||
      currentIdentity.missionId !== id.missionId
    ) {
      return { ok: false, message: 'esta conversa não possui uma rodada ativa de planejamento' }
    }
    const guarded = skillRuntime.guardReport({
      paneId: id.paneId,
      phase: 'planning',
      phaseRun: scope.phaseRun,
      skillApplications
    })
    if (!guarded.ok) {
      return {
        ok: false,
        message: 'ative e declare o receipt obrigatório do ACTIVE PLANNING METHOD desta rodada'
      }
    }
    const activePlan = skillRuntime
      .safeSnapshot()
      .plans.find(
        (plan) =>
          plan.paneId === id.paneId &&
          plan.phase === 'planning' &&
          plan.phaseRun === scope.phaseRun
      )
    const receipt = activePlan?.receipts.find(
      (candidate) => guarded.skillApplications.includes(candidate.receiptId)
    )
    if (
      !receipt ||
      receipt.skillId !== SYNKORA_PLANNING_STANDARD_ID ||
      receipt.operation !== 'plan' ||
      !receipt.activatedAt
    ) {
      return { ok: false, message: 'o receipt declarado não corresponde ao método nativo ativado' }
    }
    const evidence: PlanningMethodEvidence = {
      contractVersion: 1,
      receiptId: receipt.receiptId,
      skillId: receipt.skillId,
      operation: receipt.operation,
      version: receipt.version,
      fingerprint: receipt.fingerprint,
      phaseRun: scope.phaseRun,
      appliedAt: receipt.appliedAt ?? new Date().toISOString()
    }
    return {
      ok: true,
      evidence,
      accept: () =>
        skillRuntime.acceptReport({
          paneId: id.paneId,
          phase: 'planning',
          phaseRun: scope.phaseRun,
          skillApplications
        }).ok
    }
  }

  const mcpApi: McpApi = {
    ...buildReportApi(ctx, {
      handleMissionVerdict,
      updateStoredHelperStatus,
      helperTranscriptPath,
      skillRuntime,
      skillPlanScopes,
      securityWaiverOptions,
      planTaskForWorkTask,
      plannedHelperAssignments,
      completedPlannedAgentsByPhaseRun
    }),
    ...buildMissionsApi(ctx, {
      emitMissionsChanged,
      emitBacklogChanged,
      missionWorkspacePath,
      clearMissionStartIntent,
      writeMissionStartIntent,
      createMissionImpl,
      ensureMissionVersion,
      rollbackPlannedMission,
      startMissionIntegration,
      ensurePlannedMissionBacklogItem,
      transitionLinkedProjectPlanMission,
      stopMissionExecution,
      scheduleIntegrationDrain,
      resolveMissionIntegrationTarget,
      createIntegrationSyncTask,
      humanProjectPlanApprovals,
      humanProjectMissionStarts,
      preparePlanningArtifactEvidence
    }),
    ...buildHelpersApi(ctx, {
      armPane,
      prepareSkillPlanInputs,
      syncPaneSkillLease,
      releasePaneSkillPlan: (paneId) => releasePaneSkillPlan(paneId),
      terminatePaneNow,
      executionModeForTask,
      storedHelperRecoveries,
      helperTranscriptPath,
      isBannedModel,
      agentModelPool,
      skillRuntime,
      skillPlanScopes,
      helperSpawnReservations,
      helperOpenWatchdog,
      plannedHelperAssignments,
      codexDeveloperInstructions,
      securityWaiverOptions,
      planTaskForWorkTask
    }),
    ...buildBoardApi(ctx, {
      currentPlanOf,
      finalVerificationAccepted,
      resumePlanVerificationIfNeeded,
      baselineVerificationUsable,
      ensurePlanBaseline,
      startFinalPlanVerification,
      closeVerifiedPlan,
      removeTaskCascade,
      ensureMissionWorktree,
      missionWorkspacePath,
      isBannedModel,
      agentModelPool,
      preparePlanningArtifactEvidence,
      securityWaiverOptions,
      planTaskForWorkTask,
      setPhaseExecutorImpl
    }),
    // Domínios extraídos (fase 1, commit 4b) — spreads compõem o literal;
    // o tipo McpApi confere a superfície completa na atribuição.
    ...buildImagesApi(ctx),
    ...buildMailboxApi(ctx),
    ...buildCodeApi(ctx, {
      planTaskForWorkTask,
      missionWorkspacePath,
      skillPlanScopes,
      completedPlannedAgentsByPhaseRun
    }),
    ...buildSkillsApi(ctx, { skillRuntime, skillPlanScopes, privateSkillRuntimeRoot }),
    ...buildPanesApi(ctx, { securityWaiverOptions, planTaskForWorkTask, agentModelPool }),
    hub,


  }

  // VARREDURA DE BOOT (política do usuário: arquivo sem função não fica):
  // marcadores órfãos (watch não sobrevive ao restart), transcripts de
  // ajudante velhos, prints colados antigos, registros de worktree mortos e
  // configs MCP de panes de sessões passadas.
  let internalMcpState: 'starting' | 'ready' | 'unavailable' = 'starting'
  let mcpLifecycle: Promise<void> = Promise.resolve()
  const queueMcpLifecycle = (operation: () => Promise<void>): Promise<void> => {
    const result = mcpLifecycle.then(operation, operation)
    mcpLifecycle = result.catch(() => undefined)
    return result
  }
  // CAIXA-PRETA + PRÉ-CHECAGEM: primeira requisição MCP autenticada de cada
  // pane fica registrada (mcpPaneFirstContact) — é a prova de que o CLI do
  // pane CONECTOU no servidor Synkora. Toda chamada de tool que move estado
  // também entra no diário (board_status/codeQuery ficam de fora: alto
  // volume, zero decisão).
  const mcpPaneFirstContact = new Map<string, number>()
  const seenMcpTokens = new Set<string>()
  // GATE PARCIALMENTE EQUIPADO (plano 02/08, frente 2): um Reviewer/QA sem
  // conexão MCP não tem como registrar veredito — deixá-lo vivo é uma sessão
  // inútil que termina em silêncio (caso real de 01/08: Codex read-only).
  // Depois do spawn, o main espera a PRIMEIRA requisição autenticada do pane;
  // sem ela dentro da janela, o gate é encerrado com causa explícita e a fase
  // fica preservada para uma nova tentativa segura.
  const GATE_MCP_CONTACT_MS = 75_000
  function armGateMcpWatchdog(identity: PaneIdentity, paneId: string): void {
    setTimeout(() => {
      if (!ptys.has(paneId)) return
      if (mcpPaneFirstContact.has(paneId)) return
      const stillSame = hub.identityByPane(paneId)
      if (!stillSame || stillSame.role !== identity.role || stillSame.taskId !== identity.taskId)
        return
      blackbox.record({
        cat: 'mcp',
        event: 'gate-mcp-timeout',
        ids: {
          projectId: identity.projectId,
          missionId: identity.missionId,
          taskId: identity.taskId,
          paneId,
          phase: identity.phase,
          role: identity.role,
          seatId: identity.seatId
        },
        actor: 'harness',
        reason: `o CLI do gate não fez NENHUMA requisição ao servidor MCP em ${GATE_MCP_CONTACT_MS / 1000}s — sem conexão não há report`,
        evidence: 'mcpPaneFirstContact ausente para o paneId'
      })
      hub.publish({
        projectId: identity.projectId,
        missionId: identity.missionId,
        kind: 'error',
        text:
          `o gate ${identity.role} nasceu SEM conexão com o servidor MCP do Synkora (nenhuma requisição em ${GATE_MCP_CONTACT_MS / 1000}s) — sem isso não existe veredito possível. ` +
          `O pane foi encerrado e a fase está preservada; reabra com run_task {id: "${identity.taskId ?? '?'}", phase: "${identity.phase ?? identity.role}"}. Se repetir, o problema é a preparação MCP deste seat, não o trabalho do card`,
        actor: 'harness',
        urgent: true
      })
      ptys.kill(paneId)
    }, GATE_MCP_CONTACT_MS)
  }
  function noteMcpConnected(identity: PaneIdentity): void {
    if (mcpPaneFirstContact.has(identity.paneId)) return
    mcpPaneFirstContact.set(identity.paneId, Date.now())
    blackbox.record({
      cat: 'mcp',
      event: 'pane-connected',
      ids: {
        projectId: identity.projectId,
        missionId: identity.missionId,
        taskId: identity.taskId,
        paneId: identity.paneId,
        phase: identity.phase,
        role: identity.role,
        seatId: identity.seatId
      },
      evidence: 'primeira requisição autenticada no servidor MCP interno'
    })
  }
  function instrumentMcpApi(api: McpApi): McpApi {
    // Proxy (e não spread): o hub é uma CLASSE — copiar propriedades perderia
    // os métodos do protótipo e o estado privado. Só identityByToken é
    // interceptado; o resto é delegado com bind.
    const hubWrapper: McpApi['hub'] = new Proxy(api.hub, {
      get(target, prop, receiver) {
        if (prop === 'identityByToken') {
          return (token: string): PaneIdentity | undefined => {
            const identity = target.identityByToken(token)
            if (identity && !seenMcpTokens.has(token)) {
              seenMcpTokens.add(token)
              noteMcpConnected(identity)
            }
            return identity
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    // SEM EXCEÇÕES (decisão do usuário, 02/08): TODA tool entra no diário,
    // inclusive board_status/code_* — e o RETORNO (truncado) vai junto: uma
    // recusa de tool é decisão de fluxo e precisa aparecer, nunca ser caçada.
    const summarizeResult = (value: unknown): string => {
      const text =
        typeof value === 'string'
          ? value
          : ((): string => {
              try {
                // JSON.stringify(undefined) devolve undefined SEM lançar — o
                // .length abaixo explodia e derrubava a PRÓPRIA chamada de
                // tool (caso real 02/08: codeReportGuard retorna undefined no
                // SUCESSO; o report(done) do dev morria com "reading 'length'"
                // sem deixar rastro no diário).
                return JSON.stringify(value) ?? String(value)
              } catch {
                return String(value)
              }
            })()
      return text.length > 400 ? `${text.slice(0, 400)}…[+${text.length - 400}]` : text
    }
    return new Proxy(api, {
      get(target, prop, receiver) {
        if (prop === 'hub') return hubWrapper
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value
        // Instrumentação interna não é chamada de tool: noteCatalogServed já
        // grava o evento oficial (mcp/catalog-served, com dedupe) — logá-la
        // aqui triplicava o journal a cada request do pane (ruído real
        // visto em 2026-08-07).
        if (prop === 'noteCatalogServed' || prop === 'drainInboxFor') return value
        return (...args: unknown[]): unknown => {
          const first = args[0]
          const id =
            first && typeof first === 'object' && 'paneId' in first
              ? (first as PaneIdentity)
              : undefined
          const recordCall = (result?: unknown, err?: string): void => {
            // Observador NUNCA derruba a chamada real (mesma regra dos hooks
            // do TaskStore) — um bug de journaling não pode virar erro de tool.
            try {
              recordCallUnsafe(result, err)
            } catch {
              /* diário best-effort */
            }
          }
          const recordCallUnsafe = (result?: unknown, err?: string): void => {
            blackbox.record({
              cat: 'mcp',
              event: `tool-${String(prop)}`,
              actor: id?.role,
              ids: id
                ? {
                    projectId: id.projectId,
                    missionId: id.missionId,
                    taskId: id.taskId,
                    paneId: id.paneId,
                    phase: id.phase,
                    role: id.role
                  }
                : undefined,
              detail: {
                args: args.slice(id ? 1 : 0),
                ...(err === undefined
                  ? {
                      result:
                        prop === 'activateSkill'
                          ? 'pacote de instrução entregue (conteúdo omitido do diário)'
                          : summarizeResult(result)
                    }
                  : {})
              },
              err
            })
          }
          try {
            // Fase 0 (atribuição de stall): toda tool MCP vira operação medida
            const result = mainStalls.wrap(`mcp:${String(prop)}`, id?.taskId?.slice(0, 8), () =>
              (value as (...call: unknown[]) => unknown).apply(target, args)
            )
            if (result instanceof Promise) {
              return result.then(
                (resolved) => {
                  recordCall(resolved)
                  return resolved
                },
                (error: unknown) => {
                  recordCall(undefined, error instanceof Error ? error.message : String(error))
                  throw error
                }
              )
            }
            recordCall(result)
            return result
          } catch (error) {
            recordCall(undefined, error instanceof Error ? error.message : String(error))
            throw error
          }
        }
      }
    })
  }
  const instrumentedMcpApi = instrumentMcpApi(mcpApi)

  const installInternalMcp = async (preferredPort = 0): Promise<void> => {
    internalMcpState = 'starting'
    paneStartupMetrics?.markInternalMcpUnavailable()
    try {
      const handle = await startMcpServer(instrumentedMcpApi, preferredPort)
      mcpServerHandle = handle
      mcpPort = handle.port
      internalMcpState = 'ready'
      paneStartupMetrics?.markInternalMcpAvailable()
    } catch {
      mcpServerHandle = undefined
      // Em um restart, a URL já está gravada nos panes. Mesmo indisponível,
      // conservar o alvo permite que a próxima tentativa recupere exatamente
      // o endpoint original; trocar para porta aleatória os deixaria órfãos.
      mcpPort = preferredPort > 0 ? preferredPort : 0
      internalMcpState = 'unavailable'
    }
  }
  const startInternalMcp = (preferredPort = 0): Promise<void> =>
    queueMcpLifecycle(() => installInternalMcp(preferredPort))
  const restartInternalMcp = (): Promise<void> =>
    queueMcpLifecycle(async () => {
      const preferredPort = mcpPort
      const previous = mcpServerHandle
      mcpServerHandle = undefined
      // A porta continua publicada durante a janela curta de reinício. Assim,
      // um pane criado em paralelo recebe a mesma URL e reconecta quando o
      // listener volta, em vez de nascer definitivamente sem ferramentas.
      internalMcpState = 'starting'
      paneStartupMetrics?.markInternalMcpUnavailable()
      await previous?.close().catch(() => undefined)
      await installInternalMcp(preferredPort)
    })

  const servicesSnapshot = (includeLocalDetails = false) => {
    // Resolver o runtime local é apenas uma checagem de filesystem; nenhum
    // processo Playwright é iniciado por esta tela.
    const currentSettings = settings.get()
    if (
      currentSettings.externalServicePreparation === 'automatic' &&
      externalServicesCheckedAt == null
    ) {
      validateExternalServices()
    }
    const managerSnapshot = codeIntelligence?.serviceSnapshot(includeLocalDetails)
    const emptyTelemetry = {
      starts: 0, restarts: 0, evictions: 0, failures: 0, requests: 0, reuses: 0
    }
    const codexSeats = seats.list().filter((seat) => seat.cli === 'codex').map((seat) => {
      const status = getCodexMcpProtocolStatus(seats.configDirOf(seat))
      return {
        seatId: seat.id,
        seatName: seat.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
        state: status.state,
        checkedAt: status.checkedAt,
        version: status.version,
        featurePresent: status.featurePresent,
        featureEnabled: status.featureEnabled,
        capability: status.capability,
        ...(status.reason ? { reason: status.reason } : {})
      }
    })
    const codexState = codexSeats.some((seat) => seat.state === 'probing')
      ? 'probing'
      : codexSeats.length === 0 || codexSeats.every((seat) => seat.state === 'idle')
        ? 'idle'
        : codexSeats.every((seat) => seat.state === 'ready')
          ? 'ready'
          : 'degraded'
    const paneStartup = paneStartupMetrics?.recentSummary() ?? {
      primaryMilestone: 'agent_first_output' as const,
      windowSize: 200,
      samples: 0,
      p50Ms: null,
      p95Ms: null,
      milestones: {
        terminal_first_frame: { samples: 0, p50Ms: null, p95Ms: null },
        external_mcp_available: { samples: 0, p50Ms: null, p95Ms: null },
        agent_first_output: { samples: 0, p50Ms: null, p95Ms: null }
      }
    }
    return {
      generatedAt: Date.now(),
      codeIntelligence: managerSnapshot
        ? { mode: currentSettings.codeIntelligenceMode, ...managerSnapshot }
        : {
            mode: currentSettings.codeIntelligenceMode,
            state: currentSettings.codeIntelligenceMode === 'off' ? 'off' as const : 'closed' as const,
            processCount: 0,
            languages: [] as Array<'TypeScript' | 'JavaScript'>,
            servers: [],
            telemetry: emptyTelemetry
          },
      internalMcp: {
        state: internalMcpState,
        protocol: 'dual-era' as const,
        port: mcpPort > 0 ? mcpPort : null
      },
      codexProbe: { state: codexState, seats: codexSeats },
      externalServices: {
        preparation: currentSettings.externalServicePreparation,
        state: externalServicesAvailable == null
          ? 'unchecked' as const
          : externalServicesAvailable
            ? 'available' as const
            : 'unavailable' as const,
        checkedAt: externalServicesCheckedAt,
        playwright: {
          available: externalServicesAvailable,
          availability: 'on-demand' as const,
          version: preparedPlaywright?.version ?? null
        }
      },
      paneStartup
    }
  }


  const HELPER_TTL = 7 * 86_400_000
  const CLIP_TTL = 14 * 86_400_000
  for (const p of projects.list()) {
    try {
      ensureSynkoraGitExcludes(p.path)
    } catch {
      continue
    }
    pruneWorktrees(p.path)
    const runsDir = join(p.path, '.synkora', 'runs')
    try {
      for (const ent of readdirSync(runsDir)) {
        const full = join(runsDir, ent)
        try {
          if (/\.(done|verdict)$/.test(ent)) unlinkSync(full)
          else if (ent.startsWith('helper-')) {
            if (Date.now() - statSync(full).mtimeMs > HELPER_TTL) {
              unlinkSync(full)
            } else {
              const transcript = readFileSync(full, 'utf-8')
              const recovered = updateHelperRecoveryStatus(
                transcript,
                'interrupted',
                new Date().toISOString()
              )
              if (recovered.changed) writeFileSync(full, recovered.transcript, 'utf-8')
            }
          }
        } catch {
          // best-effort
        }
      }
    } catch {
      // sem runs ainda
    }
    const attDir = join(p.path, '.synkora', 'attachments')
    try {
      for (const ent of readdirSync(attDir)) {
        if (!ent.startsWith('clip-')) continue
        const full = join(attDir, ent)
        try {
          if (Date.now() - statSync(full).mtimeMs > CLIP_TTL) unlinkSync(full)
        } catch {
          // best-effort
        }
      }
    } catch {
      // sem attachments ainda
    }
  }
  try {
    const mcpDir = join(app.getPath('userData'), 'mcp')
    for (const ent of readdirSync(mcpDir)) {
      try {
        unlinkSync(join(mcpDir, ent))
      } catch {
        // best-effort
      }
    }
  } catch {
    // sem configs ainda
  }

  // RECUPERAÇÃO PÓS-FECHAMENTO/CRASH: nenhum processo sobrevive, mas a FASE
  // sobrevive. DEV interrompido volta ao backlog; REVIEW/QA ficam exatamente
  // no gate que já estava rodando, sobre o mesmo worktree. Assim um restart
  // nunca paga outra implementação por causa de um gate perdido.
  for (const p of projects.list()) {
    let runtimeWritable = true
    try {
      ensureSynkoraGitExcludes(p.path)
    } catch {
      runtimeWritable = false
    }
    if (runtimeWritable) {
      recoverMissionStartIntents(p.id)
      recoverMissionIntegrationIntents(p.id)
      recoverVersionReleaseIntents(p.id)
    }
    let dirty = false
    for (const t of tasks.list(p.id)) {
      // Plano não é pane, mas a verificação conjunta É um processo. Se o app
      // caiu durante ela, o próprio boot converte running→pending e relança;
      // não depende de o orquestrador lembrar de chamar board_status.
      if (t.kind === 'plan') {
        if (runtimeWritable) {
          resumePlanVerificationIfNeeded(t)
        } else if (t.plan?.verification) {
          const verification = t.plan.verification
          const baseline = verification.baseline?.status === 'running'
            ? recoverInterruptedVerification(verification.baseline)
            : verification.baseline
          const final = verification.final?.status === 'running'
            ? recoverInterruptedVerification(verification.final)
            : verification.final
          if (baseline !== verification.baseline || final !== verification.final) {
            tasks.update(t.id, {
              plan: {
                ...t.plan,
                verification: { ...verification, baseline, final }
              }
            })
          }
        }
        continue
      }
      const recoveredSkillUsage = interruptActiveSkillUsage(t.skillUsage)
      if (recoveredSkillUsage !== t.skillUsage) {
        tasks.update(t.id, { skillUsage: recoveredSkillUsage })
        dirty = true
      }
      const recoveryDecision = (decision: string, reason: string): void => {
        blackbox.record({
          cat: 'recovery',
          event: decision,
          ids: {
            projectId: p.id,
            missionId: t.missionId,
            taskId: t.id,
            phase: t.activePhase
          },
          actor: 'boot',
          prev: `${t.status}/${t.activePhase ?? '-'}/${t.phaseState ?? '-'}`,
          reason,
          evidence: 'estado persistido em tasks.json; nenhum processo sobrevive a um reinício'
        })
      }
      if (t.phaseState === 'finalizing') {
        recoveryDecision(
          'finalizing-recheck',
          runtimeWritable
            ? 'card estava em finalização — reconciliando com o journal Git antes de qualquer decisão'
            : 'runtime do projeto bloqueado; finalização marcada como interrompida sem fingir fase ativa'
        )
        if (runtimeWritable) {
          void recoverFinalizingTask(t)
        } else {
          tasks.update(t.id, {
            phaseState: 'interrupted',
            feedback: 'finalização interrompida pelo reinício; o runtime do projeto está bloqueado e nenhuma fase foi fingida como ativa'
          })
        }
        dirty = true
        continue
      }
      if (t.status === 'execucao') {
        if (t.activePhase === 'review') {
          recoveryDecision(
            'gate-preserved',
            'review estava ativo no fechamento — fase preservada; reabre sozinha quando o projeto abrir'
          )
          tasks.update(t.id, {
            activePhase: 'review',
            phaseState: 'interrupted',
            ...(t.feedback
              ? {}
              : {
                  feedback: 'review interrompido pelo fechamento/reinício — o desenvolvimento está preservado; o gate reabre AUTOMATICAMENTE quando você abrir o projeto'
                })
          })
          notePendingRespawn(p.id, t.id)
        } else if (t.activePhase === 'qa') {
          recoveryDecision(
            'gate-preserved',
            'QA estava ativo no fechamento — fase preservada; reabre sozinha quando o projeto abrir'
          )
          tasks.update(t.id, {
            status: 'qa',
            activePhase: 'qa',
            phaseState: 'interrupted',
            ...(t.feedback
              ? {}
              : {
                  feedback: 'QA interrompido pelo fechamento/reinício — o trabalho está preservado; o gate reabre AUTOMATICAMENTE quando você abrir o projeto'
                })
          })
          notePendingRespawn(p.id, t.id)
        } else {
          recoveryDecision(
            'dev-interrupted',
            'dev estava ativo no fechamento — fase preservada; reabre sozinha (resume) quando o projeto abrir'
          )
          tasks.update(t.id, {
            status: 'backlog',
            activePhase: 'dev',
            phaseState: 'interrupted',
            // task.feedback é do GATE (a lista da reprovação — o prompt-delta
            // a consome no respawn). Nota operacional NUNCA sobrescreve lista
            // pendente (bug real 05/08: o boot apagava o motivo da reprovação
            // e o dev retomava sem saber o que corrigir).
            ...(t.feedback
              ? {}
              : {
                  feedback: `execução interrompida pelo fechamento/reinício — o pane reabre AUTOMATICAMENTE quando você abrir o projeto (dev claude retoma a MESMA conversa; comandos e helpers que estavam rodando foram encerrados, e os transcripts em .synkora/runs preservam o que já ocorreu)`
                })
          })
          notePendingRespawn(p.id, t.id)
        }
        dirty = true
      } else if (t.status === 'qa') {
        recoveryDecision(
          'gate-preserved',
          'card em QA no fechamento — fase preservada; reabre sozinha quando o projeto abrir'
        )
        tasks.update(t.id, {
          activePhase: 'qa',
          phaseState: 'interrupted',
          ...(t.feedback
            ? {}
            : {
                feedback: 'QA interrompido pelo fechamento/reinício — desenvolvimento e review estão preservados; o gate reabre AUTOMATICAMENTE quando você abrir o projeto'
              })
        })
        notePendingRespawn(p.id, t.id)
        dirty = true
      }
    }
    for (const m of missions.list(p.id)) {
      if (m.status === 'integrando') missions.update(m.id, { status: 'ativa' })
      if (runtimeWritable && m.status === 'concluida') {
        reconcileConcludedMission(
          p.id,
          m.id,
          `Missão integrada: ${m.title}.`
        )
      }
    }
    if (runtimeWritable) {
      for (const version of backlog
        .listVersions(p.id)
        .filter((candidate) => candidate.status === 'lancada')) {
        try {
          completeStoredProjectPlanRelease(p.path, { versionId: version.id })
        } catch {
          // Projeto existente/plano ausente ou inválido: não afeta o release real.
        }
      }
      // Vassoura no BOOT: marcadores sem processo podem sair, mas resultados de
      // helpers interrompidos ainda pertencem ao trabalho recuperável do card.
      // Fase 0: etapa medida — fs sync por projeto é candidato clássico do
      // stall de boot (~1,9s aos 3s com culprits vazio no 1º boot medido).
      const endSweep = mainStalls.begin('boot:project-sweep', p.id.slice(0, 8))
      sweepProjectFiles(p.id, { preserveInterruptedHelpers: true })
      repairIntegrationSyncTickets(p.id)
      if (integrationQueue.head(p.id)?.state === 'queued') scheduleIntegrationDrain(p.id)
      if (dirty) syncBoard(p.id)
      endSweep()
    }
  }

  void startInternalMcp()

  // REGISTRO DOS MODULOS DE IPC (fase 1, commit 5) — SEMPRE aqui: dentro do
  // whenReady (instrumentIpcMain cobre so o que registra DEPOIS dele) e
  // ANTES do createWindow (o renderer, unico cliente, ainda nao existe —
  // registrar tarde e identico a registrar cedo, e aqui TODO simbolo do
  // closure ja foi declarado: zero TDZ). NUNCA registrar no import.
  registerSkillsIpc(ctx)
  registerMiscIpc(ctx, { bindUiSender, assertMainRendererSender, ensureBypassAccepted })
  registerVoiceIpc(ctx, {
    assertMainVoiceSender,
    assertOverlayVoiceSender,
    prepareSynVoiceExternalTarget,
    takePreparedSynVoiceTarget,
    restoreSynVoiceTarget,
    normalizeSynVoiceOverlayState,
    isNoSpeechTranscript,
    safeExternalTranscript,
    showMainWindow,
    setSynVoiceDetached,
    safeSynVoicePopupText,
    normalizeSynVoiceTooltipRequest,
    hideSynVoiceOverlayTooltip,
    showSynVoiceOverlayTooltip,
    hideSynVoiceNotice,
    showSynVoiceNotice,
    setSynVoiceOverlayHistoryOpen,
    toggleSynVoiceOverlay,
    synVoiceExternalInput,
    synVoiceGlobalActivation,
    SYNVOICE_ATOMIC_PASTE_THRESHOLD,
    state: {
      get synVoiceOverlayWindow() {
        return synVoiceOverlayWindow
      },
      get synVoicePendingOverlayTarget() {
        return synVoicePendingOverlayTarget
      },
      set synVoicePendingOverlayTarget(v) {
        synVoicePendingOverlayTarget = v
      },
      get synVoiceActiveOverlayTargetToken() {
        return synVoiceActiveOverlayTargetToken
      },
      set synVoiceActiveOverlayTargetToken(v) {
        synVoiceActiveOverlayTargetToken = v
      },
      get synVoiceOverlayCommandInFlight() {
        return synVoiceOverlayCommandInFlight
      },
      set synVoiceOverlayCommandInFlight(v) {
        synVoiceOverlayCommandInFlight = v
      },
      get latestSynVoiceOverlayState() {
        return latestSynVoiceOverlayState
      },
      set latestSynVoiceOverlayState(v) {
        latestSynVoiceOverlayState = v
      },
      get synVoiceDetached() {
        return synVoiceDetached
      }
    }
  })
  registerProgressIpc(ctx, {
    assertMainRendererSender,
    assertProgressOverlaySender,
    deliverProgressOpenTarget,
    hideProgressOverlay,
    toggleProgressOverlay,
    loadProgressOverlayPreferences,
    persistProgressOverlayPreferences,
    progressOverlayDisplayNear,
    refreshProgressSnapshot,
    setProgressOverlayCompact,
    showMainWindow,
    state: {
      get progressOverlayWindow() {
        return progressOverlayWindow
      },
      get progressOverlayPreferences() {
        return progressOverlayPreferences
      },
      set progressOverlayPreferences(v) {
        progressOverlayPreferences = v
      },
      get mainProgressRendererReady() {
        return mainProgressRendererReady
      },
      set mainProgressRendererReady(v) {
        mainProgressRendererReady = v
      },
      get latestProgressSnapshot() {
        return latestProgressSnapshot
      }
    }
  })
  registerFilesIpc(ctx)
  registerSettingsIpc(ctx, {
    assertMainRendererSender,
    transitionCodeIntelligence,
    validateExternalServices,
    state: {
      get preparedPlaywright() {
        return preparedPlaywright
      },
      set preparedPlaywright(v) {
        preparedPlaywright = v
      },
      get externalServicesAvailable() {
        return externalServicesAvailable
      },
      set externalServicesAvailable(v) {
        externalServicesAvailable = v
      },
      get externalServicesCheckedAt() {
        return externalServicesCheckedAt
      },
      set externalServicesCheckedAt(v) {
        externalServicesCheckedAt = v
      }
    }
  })
  registerServicesIpc(ctx, {
    assertMainRendererSender,
    transitionCodeIntelligence,
    restartInternalMcp,
    servicesSnapshot,
    validateExternalServices
  })
  registerHarnessIpc(ctx, { bindUiSender })
  registerProjectPlanIpc(ctx, {
    bindUiSender,
    humanProjectPlanApprovals,
    humanProjectMissionStarts,
    getMcpApi: () => mcpApi
  })

  // Fase 0: criação da janela é etapa medida do boot
  mainStalls.wrap('boot:createWindow', undefined, () => createWindow())
  mainStalls.wrap('boot:progressSnapshot', undefined, () => refreshProgressSnapshot())
  if (loadProgressOverlayPreferences().visible) createProgressOverlay()

  // CLIs SEMPRE ATUALIZADOS (decisão do usuário, 2026-07-24): pane roda o
  // binário do PATH, então CLI velho = modelo novo que não existe no seletor
  // (o Opus 5 saiu e os panes seguiam no catálogo do 2.1.218). A checagem
  // roda no boot, ANTES de qualquer pane nascer — trocar o binário com pane
  // vivo é que daria arquivo travado.
  setTimeout(() => {
    // Fase 0: o tick de 2,5s coincide com o stall de boot medido — o trecho
    // SYNC do kickoff (PATH do registro etc.) entra no sensor; o trabalho
    // async segue fora (se o culpado for ele, culprits continua vazio aqui).
    mainStalls.wrap('boot:cli-skills-kickoff', undefined, () => {
      void updateAllClis().then((all) => {
        for (const s of all) {
          console.log(
            `[cli] ${s.cli} ${s.version ?? '—'} · ${s.state}${s.from ? ` (era ${s.from})` : ''}`
          )
        }
      })
      // Skills também não podem envelhecer (o diferencial da biblioteca): check
      // diário no boot — TTL de 24h e batch por repo dentro do próprio método.
      void skillsLib.checkUpdates().then((n) => {
        if (n > 0) console.log(`[skills] ${n} atualização(ões) disponíveis na biblioteca`)
      })
    })
  }, 2500)

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    else showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (progressLivePulseTimer) clearTimeout(progressLivePulseTimer)
  for (const timer of progressLiveIdleTimers.values()) clearTimeout(timer)
  progressLiveIdleTimers.clear()
  for (const s of maestroSessions.values()) s.kill()
  maestroSessions.clear()
  progressHeadlessActivities.clear()
  ptys.killAll()
  app.quit()
})

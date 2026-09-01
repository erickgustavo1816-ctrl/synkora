import {
  app,
  BrowserWindow,
  crashReporter,
  ipcMain,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import {    join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { ProjectStore } from './projects'
import { SeatStore, type SeatCli } from './seats'
import { PERSONA_DEV, SURVEY_SECURITY_PROMPT } from './maestro'
import { MaestroStore } from './maestroStore'
import {
  alignWorktreeFromSnapshot,
  currentBranch,
  ensureSynkoraGitExcludes,
  gitCommitReached,
  gitHead,
  isExactCleanPreCasSnapshot,
  isWorktreeClean,
  isExpectedVersionWorktree,
  pruneWorktrees,
  remoteAheadOf,
  removeWorktreeAndBranch,
  setGitObserver
} from './worktree'
import { MissionStore } from './missions'
import { PlanStore } from './plans'
import { activeMasterPlan, planReleaseLock } from './planReleaseLock'
import { releaseDoneDecision, releaseStatusText, runReleaseForChat } from './releaseChat'
import {
  bumpLockVersion,
  bumpManifestVersion,
  probeManifestPublish,
  releaseOutcomeFragments,
  semverFromVersionName,
  type ReleaseBumpOutcome
} from './releasePublish'
import { ReleasesStore, type ReleaseRecordBump, type ReleaseRecordPush } from './releasesStore'
import { IntegrationQueueStore } from './integrationQueue'
import type { MainContext } from './mainContext'
import {} from './cliSessionTransplant'
import { createMaestroEngine, type MaestroBackend } from './maestroEngine'
import { createMissionEngine } from './missionEngine'
import { createPaneLifecycle } from './paneLifecycle'
import { buildPlansApi } from './mcpApi/plans'
import { registerMaestroIpc } from './ipc/maestro'
import { registerMissionsIpc } from './ipc/missions'
import { registerPtyIpc } from './ipc/pty'
import { registerPanesIpc } from './ipc/panes'
import { registerProjectsIpc } from './ipc/projects'
import { registerBacklogIpc } from './ipc/backlog'
import { registerFilesIpc } from './ipc/files'
import { registerSettingsIpc } from './ipc/settings'
import { registerGuiIpc } from './ipc/gui'
import { registerHistoryIpc } from './ipc/history'
import { waitForGuiCliStable } from './guiCliLaunch'
import type { GuiSessionRegistry } from './guiSessions'
import {
  GUI_HELPERS_STORE_FILE,
  buildGuiDelegationApi,
  createGuiHelperEngine
} from './guiDelegationWiring'
import {
  guiMissionRoleOf,
  isGuiMissionPaneId,
  isGuiPlanningPaneId,
  missionTypeOf
} from './guiMissionContracts'
import { initDesktopNotifications } from './desktopNotifications'
import {
  WINDOWS_TOAST_ACTIVATOR_CLSID,
  windowsNotificationShortcutSpec
} from './desktopNotificationPolicy'
import { registerPlansIpc } from './ipc/plans'
import { registerSkillsIpc } from './ipc/skills'
import { registerVoiceIpc } from './ipc/voice'
import { registerProgressIpc } from './ipc/progress'
import { registerMiscIpc } from './ipc/misc'
import {} from './projectSecurityBaseline'
import { redactSensitiveText } from './securityRedaction'
import { BacklogStore, type Version } from './backlog'
import { clearCatalogCache, getCatalog } from './catalog'
import {
  getCliStatus,
  isUpdatingClis,
  onCliStatus,
  startCliVersionWatch,
  updateAllClis,
} from './cliUpdate'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { StallAttribution, instrumentIpcMain } from './stallAttribution'
import { gitOff } from './gitAsync'
import {} from 'child_process'
import {   } from 'crypto'
import { PtyManager } from './pty'
import { SessionStatsWatcher } from './sessionStats'
import { Hub, type PaneIdentity } from './hub'
import {
  SettingsStore,
} from './settings'
import { getSeatUsage } from './seatUsage'
import {
  startMcpServer,
  type McpApi,
  type McpServerHandle
} from './mcpServer'
// R14 — o motor de linguagem (onda 1) e as tools que o expõem aos chats
// (onda 2). O manager é o dono das sessões: uma por RAIZ, aberta sob demanda,
// derrubada por ociosidade, por worktree removido e no quit.
import { LspManager, tsServerLaunch } from './lsp/lspManager'
import { buildGuiLspTools } from './guiLspTools'
// BROWSER EMBUTIDO (2026-08-29 — design DESIGN_BROWSER_EMBUTIDO). Três peças
// que só valem juntas: o MOTOR das views por missão (H1), a superfície do DONO
// (`browser:*`, H1) e o KIT DE 11 TOOLS do agente (H2). A costura é esta.
import {
  createBrowserManager,
  type BrowserHostKind,
  type BrowserPaneManager,
  type BrowserTabOwner
} from './browserPane'
// POP-OUT do browser (2026-08-29 — design DESIGN_BROWSER_POPOUT §P1): a MESMA
// view salta para uma janela própria, com função inteira, e o X reencaixa.
import {
  createBrowserPopoutWindows,
  type BrowserPopoutWindows
} from './browserPopoutWindow'
import { registerBrowserIpc } from './ipc/browser'
import { buildGuiBrowserTools, type GuiBrowserToolkit } from './guiBrowserTools'
import { GUI_HELPER_MCP_PANE_PREFIX, guiHelperMcpPaneId } from './guiHelperLspMcp'
import { guiHelperPorts } from './guiHelperPorts'
import { SynVoiceService } from './synVoice'
import { WindowsTextInput } from './windowsTextInput'
import { WindowsGlobalActivation } from './windowsGlobalActivation'
import { PaneStartupMetrics } from './paneStartupMetrics'
import {} from './projectFolder'
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
import { Blackbox } from './blackbox'

const ptys = new PtyManager()
// Frases vivas dos agentes (tool status_note): paneId → nota curta. Morrem
// com o pane (nota é "agora", não histórico); o consumidor é o radar de
// andamento (pedido do usuário, 2026-08-06: "preciso saber exatamente o que
// está acontecendo sem abrir o Synkora").
const paneStatusNotes = new Map<string, { text: string; at: string }>()
// Entrega única da conclusão: helper_output após report consome o resumo e o
// aviso assíncrono deixa de ser injetado como uma segunda mensagem.
const plannedHelperAssignments = new Map<
  string,
  { parentPhaseRun: string; agentId?: string }
>()
const completedPlannedAgentsByPhaseRun = new Map<string, Set<string>>()
// Uma delegação `parallel` é decisão do orquestrador, não sugestão textual.
// Qualquer helper que conclui na rodada satisfaz a obrigação de paralelismo;
// a coleção acima continua provando separadamente a persona escolhida.
const completedHelperPhaseRuns = new Set<string>()
// Check + spawn de helper atravessa awaits (catálogo, skills, armamento). Esta
// reserva impede duas calls MCP concorrentes de consumirem o mesmo slot.
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
}
// Hub de eventos + porta do servidor MCP (inicializados no whenReady).
let hub: Hub
let mcpPort = 0
let mcpServerHandle: McpServerHandle | undefined
let paneStartupMetrics: PaneStartupMetrics | undefined
function unregisterPane(paneId: string): PaneIdentity | undefined {
  plannedHelperAssignments.delete(paneId)
  // nota viva morre com o pane — nota velha em pane novo mentiria no radar
  paneStatusNotes.delete(paneId)
  return hub.unregisterPane(paneId)
}

let projects: ProjectStore
let seats: SeatStore

// Painéis de fundo do Maestro (um processo persistente por projeto:
// claude stream-json ou codex app-server, mesma interface de eventos).
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
// O canal de push é amarrado EXCLUSIVAMENTE no did-finish-load da janela
// (F5.5) — o bindUiSender oportunista (`uiSender = e.sender` nos handlers)
// morreu na F3-c0: era redundante desde a F5.5 e, com a segunda view (F3),
// deixaria qualquer IPC vindo dela sequestrar/perder o canal do host (a
// blindagem CHECK 17 contra overlays existia só por causa dele).
let uiSender: Electron.WebContents | null = null
let mainWindow: BrowserWindow | null = null
// COSTURA DE PUSH DA FASE 3 (docs/FASE3_PLANO.md §3-D3): o destino de um push
// é a VIEW, não "a janela". A Fase 3 tinha uma SEGUNDA superfície (a
// WebContentsView do canvas de panes) e a família push classificava canal →
// destino por isso. A ilha morreu na purga F6 (2026-08-17): sobrou uma
// janela, e `pushPanes`/`pushAll` são hoje o MESMO push do board. Os nomes
// ficam porque os módulos de ipc/* falam por eles; unificá-los num só é
// varredura de quem for dono do `ctx`.
function pushBoard(channel: string, ...args: unknown[]): void {
  if (uiSender && !uiSender.isDestroyed()) uiSender.send(channel, ...args)
}
function pushPanes(channel: string, ...args: unknown[]): void {
  pushBoard(channel, ...args)
}
function pushAll(channel: string, ...args: unknown[]): void {
  pushBoard(channel, ...args)
}
let synVoiceOverlayWindow: BrowserWindow | null = null
/** As janelas destacadas do browser (uma por missão). Vive no módulo porque o
 *  porteiro do IPC (`assertBrowserSurfaceSender`) é uma função de topo e
 *  precisa perguntar se o remetente é uma delas. */
let browserPopoutWindows: BrowserPopoutWindows | null = null
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

/** Views do renderer que ganham janela própria (a `main` não tem query). */
const ALLOWED_RENDERER_VIEWS = new Set(['synvoice-overlay', 'progress-overlay', 'browser-popout'])
/** Chaves de query permitidas ALÉM de `view`, POR view. O pop-out do browser é
 *  a primeira janela da casa que precisa saber DE QUEM ela é: a missão e o
 *  projeto viajam na URL (os overlays só carregavam `view`). */
const ALLOWED_RENDERER_VIEW_QUERY: Record<string, readonly string[]> = {
  'browser-popout': ['missionId', 'projectId']
}
/** Valor de query aceito: id da casa (uuid) e nada de exótico. */
const SAFE_RENDERER_QUERY_VALUE = /^[A-Za-z0-9._:-]{1,120}$/

function allowedRendererQuery(entries: readonly [string, string][]): boolean {
  if (entries.length === 0) return true
  const seen = new Set<string>()
  for (const [key] of entries) {
    if (seen.has(key)) return false
    seen.add(key)
  }
  const view = entries.find(([key]) => key === 'view')?.[1]
  if (!view || !ALLOWED_RENDERER_VIEWS.has(view)) return false
  const extra = ALLOWED_RENDERER_VIEW_QUERY[view] ?? []
  return entries.every(
    ([key, value]) =>
      key === 'view' || (extra.includes(key) && SAFE_RENDERER_QUERY_VALUE.test(value))
  )
}

function trustedRendererUrl(rawUrl: string): boolean {
  try {
    const actual = new URL(rawUrl)
    const queryEntries = [...actual.searchParams.entries()]
    if (!allowedRendererQuery(queryEntries)) return false
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
    // SONDADO em binário real (2026-08-08, probe-file-media-origin): o
    // Chromium serializa a origem de página file: como "file:///" (barra
    // extra) — comparar com o literal "file://" NEGAVA o microfone só no
    // empacotado e o SynVoice morria mudo. Aceita qualquer origem cujo parse
    // dê protocolo file: (e nada além de file:/null).
    if (rawOrigin === 'null') return true
    return new URL(rawOrigin).protocol === 'file:'
  } catch {
    return false
  }
}

function trustedRendererView(
  rawUrl: string,
  view: 'main' | 'synvoice-overlay' | 'progress-overlay' | 'browser-popout'
): boolean {
  if (!trustedRendererUrl(rawUrl)) return false
  try {
    const entries = [...new URL(rawUrl).searchParams.entries()]
    // O `trustedRendererUrl` acima já provou que a query INTEIRA é legal para a
    // view que ela declara (chaves permitidas, valores sãos, sem repetição);
    // aqui só se confere QUAL view é.
    return view === 'main'
      ? entries.length === 0
      : entries.some(([key, value]) => key === 'view' && value === view)
  } catch {
    return false
  }
}

/**
 * Carrega uma view de janela própria do renderer. Mesma rota do mini SynVoice
 * (dev = URL do Vite com a query; empacotado = `loadFile` com `query`), UMA vez
 * só para todas as views que a usarem — e com o `trustedRendererView` como
 * porteiro do endereço em dev, onde a URL vem do ambiente.
 */
function loadRendererViewInto(
  win: BrowserWindow,
  view: 'browser-popout',
  query: Record<string, string>
): void {
  const params: Record<string, string> = { view, ...query }
  const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  if (devUrl) {
    const url = new URL(devUrl)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    if (!trustedRendererView(url.href, view)) {
      throw new Error(`URL de desenvolvimento da janela ${view} não autorizada.`)
    }
    void win.loadURL(url.href)
    return
  }
  void win.loadFile(join(__dirname, '../renderer/index.html'), { query: params })
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

/** Fase 3: host OU view de panes — para IPCs que as DUAS superfícies do app
 *  usam legitimamente (settings gerais: a view lê a fonte do terminal e o
 *  zoom Ctrl+/- grava dela). Secrets/serviços continuam host-only. */
function assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error('Janela não autorizada para controlar serviços locais.')
  }
  const isHost =
    trustedRendererView(frame.url, 'main') &&
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents
  if (!isHost) {
    throw new Error('Janela não autorizada para controlar serviços locais.')
  }
}

/**
 * BROWSER DA MISSÃO — o porteiro das DUAS superfícies (pop-out, 2026-08-29).
 *
 * O `assertAppRendererSender` acima é host-only de propósito, e continua sendo:
 * a janela destacada do browser NÃO pode mexer em projetos, ajustes, seats ou
 * chats. O que ela pode é comandar o BROWSER — e para isso existe este
 * porteiro, que além de recusar diz QUAL das duas superfícies falou. Esse
 * retorno é a autoridade de geometria do motor (`ipc/browser.ts` explica por
 * que a identidade vem do remetente e não de um campo do payload).
 */
function assertBrowserSurfaceSender(event: IpcMainInvokeEvent | IpcMainEvent): BrowserHostKind {
  const frame = event.senderFrame
  if (frame && frame === event.sender.mainFrame) {
    if (
      trustedRendererView(frame.url, 'main') &&
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      event.sender === mainWindow.webContents
    ) {
      return 'dock'
    }
    // Janela destacada VIVA e registrada: o id do webContents tem de estar no
    // registro do pop-out (uma janela fechada some dele no mesmo tique).
    if (
      trustedRendererView(frame.url, 'browser-popout') &&
      browserPopoutWindows?.missionOf(event.sender.id)
    ) {
      return 'popout'
    }
  }
  throw new Error('Janela não autorizada para comandar o browser da missão.')
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
  // MEMBERSHIP por view (F3-c1): a session é COMPARTILHADA com a
  // WebContentsView de panes — o handler identifica a superfície pelo
  // webContents e exige a URL da view correspondente. Escopos: host =
  // clipboard + microfone (SynVoice mora nele); view de panes = SÓ clipboard
  // (cópia de seleção nos terminais; mídia jamais).
  const permissionScopeOf = (
    webContents: Electron.WebContents | null,
    requestingUrl: string | undefined
  ): 'main' | null => {
    const url = requestingUrl ?? webContents?.getURL() ?? ''
    if (webContents?.id === win.webContents.id && trustedRendererView(url, 'main')) return 'main'
    return null
  }
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!details.isMainFrame) return false
    const scope = permissionScopeOf(webContents, details.requestingUrl)
    if (!scope) return false
    if (permission === 'clipboard-sanitized-write') return true
    return scope === 'main' &&
      permission === 'media' &&
      details.mediaType === 'audio' &&
      trustedRendererOrigin(details.securityOrigin ?? requestingOrigin)
  })
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!details.isMainFrame) {
      callback(false)
      return
    }
    const scope = permissionScopeOf(webContents, details.requestingUrl)
    if (!scope) {
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
      scope === 'main' &&
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
  let mainLoadRetries = 0
  win.webContents.on('did-finish-load', () => {
    mainLoadRetries = 0
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
  // AUTOCURA DO LOAD (crash real 2026-08-11: o Utility Network Service do
  // Chromium morreu e o reload pós renderer-gone disparou com a rede interna
  // ainda reiniciando — em dev o load do vite por HTTP falha e a janela fica
  // MORTA com o main e os panes vivos; o dono percebe como "o app caiu").
  // Load falho re-tenta com backoff; -3 (ERR_ABORTED) é navegação
  // interrompida, não falha real.
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (mainLoadRetries >= 5) return
    mainLoadRetries += 1
    logCrash(
      'main-load-retry',
      `did-fail-load ${errorCode} ${errorDescription} — tentativa ${mainLoadRetries}/5 em 2s`
    )
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload()
    }, 2000)
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

// INSTALADO ≠ DEV (decisão do dono, 2026-08-08): o app EMPACOTADO tem
// userData PRÓPRIO em %LOCALAPPDATA%\Synkora — instalar nunca herda os dados
// do `npm run dev` (o name "synkora" resolvia a MESMA pasta em %APPDATA%,
// case-insensitive no Windows, e o instalado abria com os stores do dev).
// Precisa rodar ANTES do single-instance lock, do crashReporter e de qualquer
// store; sessionData acompanha explícito (cache/Local Storage juntos). Efeito
// colateral desejado: locks separados = dev e instalado podem rodar JUNTOS.
if (app.isPackaged) {
  const packagedData = join(process.env['LOCALAPPDATA'] ?? app.getPath('appData'), 'Synkora')
  app.setPath('userData', packagedData)
  app.setPath('sessionData', packagedData)
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
  if (progressSnapshotTimer) {
    clearTimeout(progressSnapshotTimer)
    progressSnapshotTimer = null
  }
  paneStartupMetrics?.close()
  void mcpServerHandle?.close().catch(() => undefined)
  mcpServerHandle = undefined
  mcpPort = 0
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

// TOAST DO WINDOWS: o AUMID e o ativador precisam existir antes do primeiro
// aviso. Em desenvolvimento a identidade correta é o electron.exe; no pacote,
// é o appId declarado no electron-builder.
const windowsNotificationShortcut = process.platform === 'win32'
  ? windowsNotificationShortcutSpec({
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath()
    })
  : null
if (windowsNotificationShortcut) {
  app.setAppUserModelId(windowsNotificationShortcut.appUserModelId)
  app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID)
}

app.whenReady().then(async () => {
  // NSIS cria o atalho do pacote, mas o desenvolvimento não passa pelo
  // instalador. Atualizar/criar esta entrada também grava o ToastActivatorCLSID
  // correspondente, requisito do Windows para o aviso chegar ao Action Center.
  if (windowsNotificationShortcut) {
    try {
      const programsDir = join(
        app.getPath('appData'),
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs'
      )
      mkdirSync(programsDir, { recursive: true })
      const { shortcutName, ...details } = windowsNotificationShortcut
      if (!shell.writeShortcutLink(join(programsDir, shortcutName), 'create', details)) {
        logCrash('notification-shortcut', 'o Windows recusou o atalho de notificações')
      }
    } catch (error) {
      logCrash('notification-shortcut', error)
    }
  }

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
  const missions = new MissionStore()
  // Planos do universo (2.0, onda D): a fonte das abas do MAPA. Fica em
  // userData, fora do repo do produto — worktree limpo e veredito de gate
  // legado intactos.
  const plans = new PlanStore()
  const integrationQueue = new IntegrationQueueStore(
    join(app.getPath('userData'), 'integration-queue.json')
  )
  // R27F2 — o RETRATO das subidas (entidade por release, no sucesso). A aba
  // Versões lê daqui; o fato continua sendo version.status no backlog.
  const releases = new ReleasesStore(join(app.getPath('userData'), 'releases.json'))
  const backlog = new BacklogStore()
  const maestro = new MaestroStore()
  const settings = new SettingsStore()
  endBootStores()
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
    return buildProgressSnapshot({
      projects: allProjects,
      missions: allProjects.flatMap((project) => missions.list(project.id)),
      integrationQueue: integrationQueue.listPending(),
      coordinatorActivity: progressCoordinatorActivitySource?.() ?? [],
      missingProjectIds: allProjects
        .filter((project) => !existsSync(project.path))
        .map((project) => project.id),
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
      revision
    })
  }
  const ensureProjectRuntimeWritable = (projectId: string): void => {
    const project = projects.get(projectId)
    if (!project) throw new Error('projeto não encontrado')
    ensureSynkoraGitExcludes(project.path)
  }
  const synVoice = new SynVoiceService()

  // ConPTY v2 (conpty.dll do pacote) — a correção de raiz da TUI que repintava
  // a tela inteira a cada resize. Ligado por padrão; settings.conptyDll=false
  // volta ao ConPTY do Windows sem rebuild. Ver o bloco no spawn de pty.ts.
  ptys.setConptyDll(settings.get().conptyDll !== false)
  // Chrome dos panes (lastlines/effort/model) é consumido pelas DUAS views —
  // o PtyManager troca o wc capturado pelo broadcast da costura (F3-c0).
  ptys.setBroadcast(pushAll)
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


  // SYNVOICE: bytes do microfone entram por IPC e a chamada externa acontece
  // exclusivamente no main. As chaves nunca voltam ao renderer e ficam
  // cifradas no cofre do sistema. Cada IPC valida o frame local que o originou.
  const voiceRequests = new Map<string, { controller: AbortController; senderId: number }>()
  abortVoiceRequests = () => {
    for (const request of voiceRequests.values()) request.controller.abort()
    voiceRequests.clear()
  }



  // A BIBLIOTECA DE SKILLS E SUBAGENTES saiu inteira na limpa F6
  // (2026-08-17): catálogo, instalador, cofre de pacotes, leases por
  // worktree e o runtime de receipts. Nenhum pane recebe skill hoje; a
  // pasta userData/skills FICA no disco — é conteúdo do dono, não código.


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

  hub = new Hub({
    projectPathOf: (pid) => projects.get(pid)?.path,
    ensureProjectRuntimeWritable: ensureSynkoraGitExcludes,
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
      pushAll('hub:event', evt)
    }
  })

  // ————— MainContext (Fase 1, commit 1 — docs/FASE1_MAPA_MAINCONTEXT.md) ————
  // Contrato explícito do estado do main para os módulos da cirurgia
  // (phaseEngine, mcpApi/, ipc/). ZERO movimentação: o objeto só EXPÕE o que
  // já existe. Getters cobrem as variáveis reatribuídas em runtime e as
  // consts declaradas DEPOIS deste ponto (referência direta daria TDZ na
  // construção); funções entram por delegação, imune à ordem de declaração;
  // ctx.phase delega para a máquina de fases — advancePhase é ASSÍNCRONO
  // desde o F2-c5 (Promise<boolean>; atomicidade por SERIALIZAÇÃO via
  // PhaseTransitionLock; a cicatriz do "[object Promise]" exige await em
  // todo consumidor). Consumidores chegam nos commits 3–5.
  const ctx: MainContext = {
    projects,
    seats,
    missions,
    plans,
    integrationQueue,
    backlog,
    maestro,
    settings,
    ptys,
    synVoice,
    blackbox,
    mainStalls,
    sessionStats,
    maestroSessions,
    paneTokens,
    paneMcpFiles,
    paneSessions,
    paneStatusNotes,
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
    get internalMcpState() {
      return internalMcpState
    },
    get paneStartupMetrics() {
      return paneStartupMetrics
    },
    get expiredSeats() {
      return expiredSeats
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
    maestroPaneId: (...args) => maestroPaneId(...args),
    orchPaneId: (...args) => orchPaneId(...args),
    unregisterPane: (...args) => unregisterPane(...args),
    cleanPaneMcpFile: (...args) => cleanPaneMcpFile(...args),
    abortVoiceRequests: () => abortVoiceRequests(),
    pushBoard: (channel, ...args) => pushBoard(channel, ...args),
    pushPanes: (channel, ...args) => pushPanes(channel, ...args),
    pushAll: (channel, ...args) => pushAll(channel, ...args)
  }
  // consumidores do ctx: phaseEngine (commit 3); mcpApi/ipc nos commits 4–5

  // Bypass de permissões é o PADRÃO (fluxo reto, como no overclock);
  // o toggle 🛡 religa as aprovações por projeto.

  /** Desde a R15 o worktree de projeto node nasce MOBILIADO (junction de
   *  node_modules — nodeModulesLink.ts) e este bootstrap vira no-op no caso
   *  comum; ele FICA para os casos em que a mobília não veio (projeto sem a
   *  linha no .gitignore, store ausente na raiz). A lição original: worktree
   *  sem node_modules caía em paridade de ambiente quebrado (caso real
   *  2026-08-04: typecheck/test/lint reprovaram a M01 PRONTA e o card voltou
   *  ao dev por falta de bootstrap). Roda `npm ci` UMA vez, somente quando o
   *  manifesto pede e o lockfile existe; falha vira evento — a verificação
   *  segue e acusa com contexto, nunca em silêncio. */
  // CHECK 1 (2026-08-07): até 4 npm ci CONCORRENTES (baselines da onda + devs
  // restaurando lockfile) saturavam o disco e as congeladas da UI coincidiam
  // com essas janelas. UM bootstrap por vez — segundos de fila custam menos
  // que a máquina do dono travada.
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
    // TEMA DE FÁBRICA (pedido do dono, 2026-08-12): todo seat claude nasce com
    // "Dark mode (ANSI colors only)" — a chave mora em settings.json do config
    // dir (sondado: foi onde o picker /theme gravou "dark-ansi" nos seats
    // reais). SÓ semeia quando ausente; escolha feita no TUI nunca é
    // sobrescrita.
    try {
      const settingsFile = join(configDir, 'settings.json')
      let seatSettings: Record<string, unknown> = {}
      if (existsSync(settingsFile)) {
        try {
          seatSettings = JSON.parse(readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>
        } catch {
          seatSettings = {}
        }
      }
      if (typeof seatSettings['theme'] !== 'string') {
        seatSettings['theme'] = 'dark-ansi'
        writeFileSync(settingsFile, JSON.stringify(seatSettings, null, 2), 'utf-8')
      }
    } catch {
      // best-effort: sem o seed o pane só nasce no tema default
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


  // Aceite do bypass gravado JÁ NO BOOT para todos os seats claude: processos
  // antigos do CLI (catálogo/painel) reescrevem o .claude.json ao sair e podem
  // derrubar a chave — regravar cedo e a cada spawn fecha a janela da corrida.

  // Seats com login VENCIDO (detectado na saída dos panes): seatId → quando.
  // O flag limpa sozinho quando o arquivo de credencial muda (re-login feito).
  const expiredSeats = new Map<string, number>()


  // ————— CLIs sempre atualizados —————
  // O catálogo de modelos é INVALIDADO a cada mudança de versão: a lista vem
  // do handshake do binário, então modelo novo só aparece perguntando de novo.
  let lastCliVersions = ''
  onCliStatus((all) => {
    const versions = all.map((s) => `${s.cli}@${s.version ?? '-'}`).join(' ')
    if (versions !== lastCliVersions) {
      // O diário nomeia a mudança (rodada do app OU o vigia pós-boot): é a
      // linha que explica "por que o modelo novo apareceu/sumiu agora".
      if (lastCliVersions) {
        blackbox.record({
          cat: 'app',
          event: 'cli-version-changed',
          actor: 'harness',
          detail: {
            from: lastCliVersions,
            to: versions,
            reasons: all.map((s) => s.detail).filter(Boolean)
          }
        })
      }
      lastCliVersions = versions
      clearCatalogCache()
    }
    pushBoard('cli:status', all)
  })




  // versionIsolation* fica AQUI (domínio VERSÃO — extras do ipc/backlog
  // e do missionEngine); o resto da região de missões vive no engine.
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

  /**
   * A metade PURA do isolamento (registro completo + exclusivo), sem nenhum
   * git. Ela existe para o predicado síncrono e o probe assíncrono da R18.3
   * nascerem do MESMO lugar — narrowing copiado à mão viraria uma segunda
   * verdade sobre a identidade da versão, e divergiria no primeiro conserto.
   */
  function versionIsolationIsNarrow(
    version: Version
  ): version is Version & { branch: string; worktree: string } {
    return Boolean(version.branch && version.worktree && versionIsolationIsUnique(version))
  }

  function versionIsolationIsValid(
    projectPath: string,
    version: Version
  ): version is Version & { branch: string; worktree: string } {
    return (
      versionIsolationIsNarrow(version) &&
      isExpectedVersionWorktree(projectPath, version.worktree, version.branch)
    )
  }

  /**
   * R18.3 — o MESMO isolamento para quem já está em caminho assíncrono: a
   * metade pura acima e, no lugar exato onde o predicado spawnava git, um
   * `gitOff`. TRANSPORTE, NÃO LÓGICA: mesma ordem (pureza primeiro, git
   * depois, curto-circuito idêntico) e mesma resposta.
   *
   * O predicado FICA para os chamadores síncronos legítimos (ipc/backlog, o
   * `ensureMissionWorktree` completo e a reconciliação de BOOT): type predicate
   * não sobrevive a `async`, e ninguém pode perder o narrowing por causa disto.
   */
  async function versionIsolationProbe(projectPath: string, version: Version): Promise<boolean> {
    if (!versionIsolationIsNarrow(version)) return false
    return gitOff('isExpectedVersionWorktree', projectPath, version.worktree, version.branch)
  }


  // ————— BACKLOG DE PRODUTO (versões como escopo de planejamento) —————
  function emitBacklogChanged(projectId: string): void {
    pushBoard('backlog:changed', projectId)
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
      // O REGISTRO acompanha o fato (a versão provada na base): a missão de
      // release não tem mais o que operar. Sem isto, uma subida reconciliada
      // por boot deixava o release eternamente "rodando" no board (incidente
      // de 2026-08-20 — a limpeza falha porque o chat do release mora DENTRO
      // do worktree da versão e segura o diretório no Windows).
      //
      // R38 (2026-08-29) — aqui NÃO entra a sonda de pane viva que a
      // reconciliação de leitura ganhou (missionEngine.missionsWithIntegration),
      // e o motivo é VERIFICADO, não presumido: este bloco tem UM chamador só
      // (o laço de `projects.list()` do whenReady, ~350 linhas abaixo) e ele
      // roda ANTES de `guiSessions = registerGuiIpc(...)` — o registro de
      // conversas ainda nem existe, e o Map dele nasce vazio a cada boot. Não
      // há chat vivo a roubar: no boot, todo release é órfão por construção.
      for (const m of missions.list(projectId)) {
        if (
          m.versionId === versionId &&
          missionTypeOf(m) === 'release' &&
          (m.status === 'ativa' || m.status === 'integrando')
        ) {
          missions.update(m.id, { status: 'concluida' })
        }
      }
      emitBacklogChanged(projectId)
      // R27F2 — a reconciliação também AVISA A TELA (mesma régua do fecho
      // vivo): no boot o push cai no vazio, inofensivo; rodando com o app
      // aberto, é ele que tira o card concluído da coluna sem restart.
      pushAll('missions:changed', projectId)
      syncBoard(projectId)
      clearVersionReleaseIntent(project.path, versionId)
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
      clearVersionReleaseIntent(project.path, version.id)
      return `a versão ${version.name} já foi lançada`
    }
    // Servidor de teste do dono no worktree da versão fecha antes do merge.
    if (version.worktree) closeTestServersUnder(version.worktree)
    // Pelo mesmo motivo, o servidor de LINGUAGEM daquela raiz (R14): o
    // worktree da versão some na limpeza, e um processo com `cwd` lá dentro
    // trava a remoção no Windows.
    if (version.worktree) lspManager.invalidate(version.worktree)
    // R-5 DA LIMPA F6: o gate de release do plano mestre saiu SEM substituto.
    // O que continua barrando uma publicação prematura são as travas reais —
    // fila de integração, worktree limpo, missão viva na versão e item de
    // backlog em aberto — logo abaixo.
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
      // Missão de RELEASE é o REGISTRO da própria subida, nunca pendência:
      // contá-la fazia o release_run recusar por causa da missão do próprio
      // botão (deadlock de 2026-08-20), enquanto o release_status a excluía
      // e dizia "tudo livre". A régua é UMA, por tipo.
      .filter(
        (m) =>
          m.versionId === versionId &&
          missionTypeOf(m) !== 'release' &&
          (m.status === 'ativa' || m.status === 'integrando')
      )
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
    // TRAVA DE RELEASE DO PLANO MESTRE (ordem do dono, 17/08): item pendente do
    // plano do MAPA atribuído a esta versão recusa a publicação — "ou eu excluo
    // ou eu faço". A régua inteira mora no módulo puro; aqui só a fotografia.
    const planLock = planReleaseLock({
      versionId,
      versionName: version.name,
      plan: activeMasterPlan(plans.list(version.projectId)),
      missions: missions.list(version.projectId).map((mission) => ({
        id: mission.id,
        title: mission.title,
        status: mission.status,
        ...(mission.versionId ? { versionId: mission.versionId } : {})
      }))
    })
    if (planLock) return planLock.message
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
    emitBacklogChanged(version.projectId)
    syncBoard(version.projectId)
    // R29 — O RELEASE ENTREGA A CAIXA (ordem do dono, 2026-08-21): produto que
    // declara pipeline de publicação (script `release` no package.json — sinal
    // estrutural, nunca heurística) tem subida em dois atos. O ato do HARNESS
    // é este: alinhar o `version` do manifesto ao nome da versão AQUI, depois
    // do merge e ANTES do push (o commit viaja no mesmo push; git na main é do
    // harness, nunca do agente). O ato do AGENTE sai como receita no desfecho.
    // Nada neste bloco derruba um release feito: falha vira frase advisory.
    let publishSignalForOutcome: { hasReleaseScript: boolean; bump: ReleaseBumpOutcome | null } = {
      hasReleaseScript: false,
      bump: null
    }
    try {
      const manifestPath = join(project.path, 'package.json')
      if (existsSync(manifestPath)) {
        const manifestRaw = readFileSync(manifestPath, 'utf8')
        const probe = probeManifestPublish(manifestRaw)
        if (probe) {
          const expected = semverFromVersionName(version.name)
          let bump: ReleaseBumpOutcome
          if (!expected) bump = { kind: 'name-not-semver', name: version.name }
          else if (probe.version === null) bump = { kind: 'manifest-opaque' }
          else if (probe.version === expected) bump = { kind: 'aligned', version: expected }
          else {
            const bumpedManifest = bumpManifestVersion(manifestRaw, expected)
            if (!bumpedManifest) bump = { kind: 'manifest-opaque' }
            else {
              writeFileSync(manifestPath, bumpedManifest)
              const bumpFiles = ['package.json']
              const lockPath = join(project.path, 'package-lock.json')
              if (existsSync(lockPath)) {
                const bumpedLock = bumpLockVersion(readFileSync(lockPath, 'utf8'), expected)
                if (bumpedLock) {
                  writeFileSync(lockPath, bumpedLock)
                  bumpFiles.push('package-lock.json')
                }
              }
              const committed = await gitOff(
                'commitProjectFiles',
                project.path,
                bumpFiles,
                `release: ${version.name} (version ${expected})`
              )
              bump = committed.ok
                ? { kind: 'committed', version: expected }
                : { kind: 'commit-failed', version: expected, error: committed.error }
            }
          }
          publishSignalForOutcome = { hasReleaseScript: probe.hasReleaseScript, bump }
        }
      }
    } catch (error) {
      publishSignalForOutcome = {
        hasReleaseScript: false,
        bump: {
          kind: 'commit-failed',
          version: version.name,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
    // R28 — O REMOTO ACOMPANHA A SUBIDA: projeto com origin configurado tem o
    // clique em subir versão como A demanda do push (uma missão configurou o
    // GitHub e o release o ignorava — o dono ficou com o remoto na versão
    // antiga). Falha de push NUNCA desfaz o release local: ela volta nomeada,
    // com o comando que resolve na mão.
    const targetBranch = releaseIntent.targetBranch ?? currentBranch(project.path) ?? 'main'
    const remote = await gitOff('remoteAheadOf', project.path, targetBranch)
    let pushLine = ''
    // R27F2 — o push como FATO para a entidade da subida (não só como frase).
    let releasePush: ReleaseRecordPush = { attempted: false }
    if (remote) {
      const pushed = await gitOff('pushBranchToRemote', project.path, targetBranch)
      releasePush = pushed.ok
        ? { attempted: true, ok: true }
        : { attempted: true, ok: false, error: pushed.error }
      pushLine = pushed.ok
        ? ` · GitHub atualizado (${targetBranch} → origin)`
        : ` · ATENÇÃO: o push para o origin FALHOU (${pushed.error}) — o release local está completo; rode git push origin ${targetBranch} na pasta do projeto quando o acesso voltar`
    }
    // R28.1 — merge leva o package.json, mas NUNCA instala nada: sem este
    // aviso o dono buildava na pasta com node_modules velho, o gate do
    // produto barrava, e o agente re-consertava no worktree um problema que
    // só existia na main (o loop das 4 versões de 2026-08-20).
    const manifestChanged =
      releaseIntent.targetHead !== undefined
        ? await gitOff(
            'commitRangeTouchesFile',
            project.path,
            releaseIntent.targetHead,
            'HEAD',
            'package.json'
          )
        : undefined
    if (manifestChanged === true) {
      pushLine += ` · as DEPENDÊNCIAS mudaram nesta subida: rode npm install na pasta do projeto antes do próximo build/instalador`
    }
    // R29 — o desfecho conta o ato do harness (bump) e entrega a receita do
    // ato do agente (a publicação da caixa). Frases no módulo puro.
    for (const fragment of releaseOutcomeFragments(publishSignalForOutcome)) {
      pushLine += ` · ${fragment}`
    }
    hub.publish({
      projectId: version.projectId,
      kind: 'merge',
      text: `versão ${version.name} SUBIU para a ${currentBranch(project.path) ?? 'main'} (${releaseDetail}) — agora é a versão ATUAL do app${pushLine}`,
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
    clearVersionReleaseIntent(project.path, versionId)
    const releaseOutcome = `versão ${version.name} subiu para a main (${releaseDetail}) — é a versão atual${pushLine}`
    // R27F2 Onda 2 — o RETRATO da subida vira DADO (a entidade que a aba
    // Versões e a auditoria leem: quando, quem, merge, push, bump, caixa).
    // Nasce DEPOIS do fato provado e nunca o derruba: retrato falho é perda
    // de foto, não de release.
    try {
      const bump = publishSignalForOutcome.bump
      const releaseBump: ReleaseRecordBump | undefined =
        bump?.kind === 'committed'
          ? { version: bump.version, committed: true }
          : bump?.kind === 'commit-failed'
            ? { version: bump.version, committed: false }
            : undefined
      const releaseMission = missions
        .list(version.projectId)
        .find((m) => m.versionId === versionId && missionTypeOf(m) === 'release')
      releases.append({
        projectId: version.projectId,
        versionId,
        versionName: version.name,
        ...(releaseMission ? { missionId: releaseMission.id } : {}),
        actor,
        mergeDetail: releaseDetail,
        push: releasePush,
        ...(releaseBump ? { bump: releaseBump } : {}),
        publishRequired: publishSignalForOutcome.hasReleaseScript,
        outcome: releaseOutcome
      })
    } catch {
      // sem retrato — o hub e o backlog seguem contando o fato.
    }
    return releaseOutcome
  }


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
    const allMissions = missions.list(projectId)
    const missionById = new Map(allMissions.map((m) => [m.id, m]))
    const liveShorts = new Set(
      allMissions.filter((m) => m.status !== 'concluida').map((m) => m.id.slice(0, 8))
    )
    const runsDir = join(project.path, '.synkora', 'runs')
    try {
      for (const ent of readdirSync(runsDir)) {
        const full = join(runsDir, ent)
        if (/\.(done|verdict)$/.test(ent)) {
          // Marcadores da orquestração por arquivo da era F6 (o fallback do
          // report do dev/gate). Sem máquina de fases não há watch que os
          // preserve — o que sobrou no disco é resíduo.
          zap(full)
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
          lines.push(
            `- [${m.status}] "${m.title}"${m.branch ? ` (branch ${m.branch})` : ''}${m.scope ? ` · escopo: ${m.scope}` : ''}`
          )
        }
        lines.push('')
      }
      writeFileSync(join(dir, 'BOARD.md'), lines.join('\n'), 'utf-8')
    } catch {
      // board é best-effort — nunca derruba o fluxo
    }
    pushAll('projects:flowChanged', projectId)
    scheduleProgressSnapshot()
  }


  // PANE LIFECYCLE → paneLifecycle.ts (fase 1, commit 7a). Armamento
  // (armPane/mcpPaneArgs), estado vivo, encerramento, servidor de teste do
  // dono e o aviso de longa duração nascem no engine; os aliases mantêm os call
  // sites e os literais de extras dos outros engines textualmente intactos.
  // ORDEM OBRIGATÓRIA: paneLifecycle → mission → maestro → phase (o
  // phaseEngine desestrutura ctx.livePaneSpecs/ctx.closingPaneIds NA
  // CONSTRUÇÃO — TDZ de boot se o paneLifecycle nascer depois).
  const paneLifecycle = createPaneLifecycle(ctx, {
    ensureBypassAccepted,
    ensureCodexTrust,
  })
  const {
    livePaneSpecs,
    closingPaneIds,
    paneEverSpawned,
    pendingPtyPreparations,
    testServerPanes,
    staggerPaneSpawn,
    discardUnstartedPane,
    closeTestServersUnder
  } = paneLifecycle

  // MÁQUINA DE FASES → phaseEngine.ts (fase 1, commit 3). O estado de fase
  // nasce DENTRO do engine; os aliases abaixo mantêm os call sites do index e
  // os getters do ctx textualmente intactos até os commits 4–5 (mcpApi/, ipc/)
  // consumirem ctx.phase. codeReportGuard é arrow DE PROPÓSITO: o mcpApi é
  // const declarada ~5k linhas abaixo (TDZ na construção) e o tick só roda com
  // tudo construído.
  // SESSÕES GUI (Synkora 2.0, onda B): o registro nasce no registerGuiIpc, lá
  // no fim do whenReady — LATE-BOUND de propósito, como releasePaneSkillPlan.
  // Os dois acessos abaixo são a fonte ÚNICA para engine/ipc/mcpApi: entregar
  // texto na conversa de um pane e ceifar os chats de uma missão (dev,
  // reviewer e ajudantes) quando o worktree dela vai embora.
  let guiSessions: GuiSessionRegistry | undefined
  const deliverToGuiPane = (paneId: string, text: string): boolean =>
    guiSessions?.send(paneId, text).ok === true
  // R9 — as DUAS superfícies do ⇪, e elas não se misturam: a NOTA é o que o
  // dono lê de relance no fio; o ESTÍMULO é o texto que chega ao modelo pelos
  // bastidores (o caminho do recibo de plano). `false` = sem sessão viva, e a
  // reabertura do chat re-deriva o gesto a partir do ticket.
  const noteInGuiPane = (paneId: string, text: string): boolean =>
    guiSessions?.note(paneId, text).ok === true
  const announceToGuiPane = (paneId: string, text: string): boolean =>
    guiSessions?.announce(paneId, text).ok === true
  // R14 — O MOTOR DE LINGUAGEM. Uma sessão por RAIZ (o worktree da missão ou a
  // raiz do projeto), aberta sob demanda pela primeira pergunta do chat. O
  // lançador de produção resolve o `typescript-language-server` do app e o roda
  // sobre o próprio binário do Electron em modo node: o dono não precisa ter
  // node instalado, e nenhuma janela nasce.
  //
  // Pacote ausente NÃO derruba nada: o `tsServerLaunch` levanta um `LspError`
  // com o comando que instala, e o recibo da tool mostra a frase ao agente.
  const lspManager = new LspManager({
    launcherFor: (root) => tsServerLaunch(root),
    onProtocolError: (message) =>
      blackbox.record({ cat: 'mcp', event: 'lsp-protocol', actor: 'harness', err: message })
  })
  const guiLspTools = buildGuiLspTools({
    manager: lspManager,
    // A MESMA fonte do trilho de diff do dono, e pelo mesmo caminho: o
    // gitWorker. Git no main thread foi a causa raiz das travadas de 08-04, e
    // uma tool de chat é exatamente o tipo de chamada que voltaria a pagá-las.
    //
    // Sem `baseBranch` o resumo diffa contra `HEAD`: o alvo são as mudanças NÃO
    // COMMITADAS mais os arquivos novos — que é o que "o que eu mexi até agora"
    // significa para quem está editando. Arquivo DELETADO sai da lista: pedir
    // diagnóstico de um arquivo que não existe mais só produziria um "não
    // existe" que o agente leria como problema de código.
    changedFiles: async (root) => {
      const summary = await gitOff('missionWorkspaceSummary', root)
      return (summary?.files ?? [])
        .filter((file) => file.status !== 'D')
        .map((file) => file.path)
    },
    log: (entry) =>
      blackbox.record({
        cat: 'mcp',
        event: entry.event,
        actor: 'harness',
        ids: {
          paneId: entry.paneId,
          ...(entry.projectId ? { projectId: entry.projectId } : {}),
          ...(entry.missionId ? { missionId: entry.missionId } : {})
        },
        detail: { root: entry.root, ...entry.detail },
        ...(entry.err ? { err: entry.err } : {})
      })
  })
  // ————— SENSORES DA TRAVADA (diagnóstico, 2026-08-19: "quando clico pra
  // subir, o app trava muito"). Dois olhos na caixa-preta:
  // 1. todo git SÍNCRONO no main que passar de 200ms (cada um desses é UI
  //    congelada — o gancho fica no-op dentro do gitWorker);
  // 2. o estol do próprio event loop do main (>400ms de deriva = alguém
  //    segurou o thread, git ou não). Correlacionar os dois com os eventos de
  //    integração conta a história inteira de um clique no ⇪.
  setGitObserver(({ ms, args, cwd }) => {
    if (ms < 200) return
    blackbox.record({
      cat: 'git',
      event: 'git-sync-slow',
      actor: 'harness',
      detail: { ms, cmd: args.slice(0, 3).join(' '), cwd: cwd.slice(-70) }
    })
  })
  {
    const STALL_TICK_MS = 250
    const STALL_REPORT_MS = 400
    let lastTick = Date.now()
    setInterval(() => {
      const now = Date.now()
      const stall = now - lastTick - STALL_TICK_MS
      lastTick = now
      if (stall >= STALL_REPORT_MS) {
        blackbox.record({
          cat: 'app',
          event: 'main-thread-stall',
          actor: 'harness',
          detail: { ms: stall }
        })
      }
    }, STALL_TICK_MS)
  }
  // ————— BROWSER EMBUTIDO: o motor das views por missão (H1) —————
  //
  // Nasce AQUI, antes do `killMissionGuiPanes`, porque é lá que ele morre: a
  // aba de uma missão tem exatamente o mesmo tempo de vida que os chats dela.
  // A partition (cookies, logins) é do PROJETO e sobrevive — é isso que faz o
  // dono logar uma vez só.
  //
  // O POP-OUT (design DESIGN_BROWSER_POPOUT §P1) nasce ANTES do motor porque é
  // dependência dele — e os ganchos apontam de volta para o motor por closure
  // (nenhum deles roda durante a construção: a primeira janela só existe depois
  // de um ⧉ do dono).
  const browserPopouts = createBrowserPopoutWindows({
    record: (input) => blackbox.record(input),
    storeFile: () => join(app.getPath('userData'), 'browser-popout-position.json'),
    missionTitle: (missionId) => missions.get(missionId)?.title ?? 'missão',
    anchorBounds: () =>
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null,
    icon: () => resolveAppIcon(),
    preloadFile: () => join(__dirname, '../preload/index.js'),
    loadView: (win, query) => loadRendererViewInto(win, 'browser-popout', query),
    trustedUrl: (url) => trustedRendererView(url, 'browser-popout'),
    // O X da janela REENCAIXA a página (§P6: o Electron 43 não mata o
    // webContents filho junto com a janela — sem isto a view ficaria viva,
    // órfã e com a captura pendurando 6s).
    onCloseRequested: (missionId) => browserPanes.dockBack(missionId, 'window-close'),
    // Arrastar/redimensionar/maximizar a janela destacada move o retângulo sem
    // o ResizeObserver do cromo acordar — o mesmo gancho que a janela do app já
    // tinha.
    onGeometry: (missionId) => browserPanes.relayout(missionId),
    // CURA 2: restaurada de minimizada, o `setBounds` da view é REFEITO (o
    // `restore` sozinho não cura — a sonda mediu o pixel errado 356× seguidas).
    onRestored: (missionId) => browserPanes.relayout(missionId)
  })
  browserPopoutWindows = browserPopouts
  const browserPanes: BrowserPaneManager = createBrowserManager({
    window: () => mainWindow,
    record: (input) => blackbox.record(input),
    // O `pushAll` da casa só fala com a janela principal; a janela destacada é
    // uma superfície do app como outra qualquer e precisa do mesmo repaint.
    push: (channel, ...args) => {
      pushAll(channel, ...args)
      browserPopouts.broadcast(channel, ...args)
    },
    popouts: browserPopouts
  })
  const killMissionGuiPanes = (missionId: string): void => {
    guiSessions?.killWhere((paneId) => isGuiMissionPaneId(paneId, missionId))
    // O servidor de linguagem tem `cwd` DENTRO do worktree, igual aos chats:
    // este ponto é chamado logo antes de toda remoção de worktree de missão (o
    // merge da fila e o "excluir de vez"), e um processo segurando a pasta é o
    // que trava a limpeza do git no Windows. Derrubar aqui é o par exato do
    // kill dos panes — a próxima pergunta em outra raiz sobe um servidor novo.
    const worktree = missions.get(missionId)?.worktree
    if (worktree) lspManager.invalidate(worktree)
    // O BROWSER MORRE NO MESMO PONTO (design H1/H2). É a costura que o design
    // pede nominalmente: arquivar, integrar e "excluir de vez" passam todos
    // por aqui, então nenhum deles precisa lembrar do browser. Uma view viva
    // segurando o worktree é a mesma classe de bug do LSP acima — e a fatia
    // que ficaria órfã na tela é pior ainda: ela mostraria a missão que o dono
    // acabou de fechar.
    browserPanes.closeMission(missionId)
  }
  // Onda C: os chats do PROJETO (hoje só o de planejamento, `gui-plan-<id8>`)
  // rodam na RAIZ do universo — morrem quando essa raiz sai debaixo deles
  // (relocação, exclusão do projeto). Os de MISSÃO não entram aqui: o cwd
  // deles é o worktree em userData, que sobrevive aos dois gestos.
  const killProjectGuiPanes = (projectId: string): void => {
    guiSessions?.killWhere((paneId) => isGuiPlanningPaneId(paneId, projectId))
  }
  // MISSÕES → missionEngine.ts (fase 1, commit 6d). Missões + fila de
  // integração nascem no engine; os aliases abaixo mantêm os call sites do
  // index (onExit do PTY, boot recovery, extras do mcpApi/) e os getters do
  // ctx textualmente intactos. stopMissionExecution/tickMissionWatches migram
  // no 6e. Ordem obrigatória: mission → maestro → phase (o PhaseEngineExtras
  // consome missionWorkspacePath/ensureMissionWorktree).
  const missionEngine = createMissionEngine(ctx, {
    orchKey,
    versionIsolationIsValid,
    versionIsolationProbe,
    emitBacklogChanged,
    sweepProjectFiles,
    closeTestServersUnder,
    deliverToGuiPane,
    noteInGuiPane,
    announceToGuiPane,
    killMissionGuiPanes,
    // R38 — a sonda de VIDA do chat, para a rede de reconciliação parar de
    // pescar conversa viva. `has` é a resposta do próprio registro ("sessão do
    // pane: ausente = nunca criada ou já encerrada"), e o `?.` cobre o boot:
    // `guiSessions` só é atribuído no registerGuiIpc, lá embaixo — antes disso
    // não existe pane nenhum e a resposta honesta é `false`.
    paneAlive: (paneId) => guiSessions?.has(paneId) === true
  })
  const {
    integrationDrainTimers,
    integrationDraining,
    emitMissionsChanged,
    ensureMissionWorktree,
    reconcileConcludedMission,
    scheduleIntegrationDrain,
    recoverMissionIntegrationIntents,
    restimulateIntegrationOnOpen,
  } = missionEngine

  // MAESTRO → maestroEngine.ts (fase 1, commit 6b). Sessão de fundo do PM,
  // /estudar, teto de resume, método de planejamento e perguntas ao dono
  // nascem no engine; os aliases abaixo mantêm os call sites do index (os
  // handlers maestro:*/missions:* migram nos commits 6c/6f) e os getters do
  // ctx textualmente intactos. releasePaneSkillPlan é arrow DE PROPÓSITO:
  // o let só é atribuído mais acima no closure (late-bound como no phaseEngine).
  const maestroEngine = createMaestroEngine(ctx, {
    killMaestroSession,
    finishProgressMaestroTurn,
    maestroSystemPromptFile,
  })
  const {
    emitLog,
    surveyAborts,
  } = maestroEngine



  setInterval(() => {
  }, 3000)


  /** Raízes autorizadas para links impressos por um pane. O renderer não pode
   * escolher um cwd: ele só informa o paneId, e o main recupera a identidade
   * que foi armada para aquele processo. */


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
  //
  // EXPURGO F6 (2026-08-17): o único preenchedor destes conjuntos era o
  // `ipc/projectPlan.ts`, que morreu com a aba do roadmap. Eles seguem aqui
  // PERMANENTEMENTE VAZIOS porque o `mcpApi/missions` legado ainda os exige —
  // e vazio é o veredito certo: sem tela, `approve_project_plan` e
  // `start_project_mission` passam a recusar sempre. Morrem juntos na onda 3.
  const humanProjectPlanApprovals = new Set<string>()
  const humanProjectMissionStarts = new Set<string>()
  // KIT DO CHAT DE PLANEJAMENTO (2.0, onda D): o único catálogo do Synkora.
  // `propose_plan` apresenta e devolve — quem cria o plano é o clique do dono
  // no card (porteira mecânica, nunca persona). O `hub` entra porque é ele
  // quem autentica o bearer do pane no `startMcpServer`.
  // AJUDANTES SEM ABA (2026-08-18 — design DESIGN_SUBAGENTES_SEM_ABA): o motor
  // headless dos helpers e as tools que o chat de missão dev usa para comandá-los.
  // O `guiSessions` é late-bound de propósito (o registro nasce lá no fim do
  // whenReady): o motor só fala com ele quando um ajudante muda de estado, e aí
  // ele já existe. Sem chat aberto, o card sintetizado simplesmente não nasce —
  // o ajudante segue trabalhando e a entrega continua no helper_result.
  const guiHelperEngine = createGuiHelperEngine({
    // A FROTA SOBREVIVE AO APP (R6.1): sem este arquivo nada persiste e o boot
    // não reencontra ninguém — a ordem do dono só existe com esta linha.
    storeFile: join(app.getPath('userData'), GUI_HELPERS_STORE_FILE),
    seats: () =>
      seats.list().map((seat) => ({
        id: seat.id,
        name: seat.name,
        cli: seat.cli,
        status: seat.status,
        configDir: seat.configDir
      })),
    systemPromptFile: persistTrustedSystemPrompt,
    prepareSeat: (seat, cli) => {
      if (cli !== 'codex') return
      const found = seats.get(seat.seatId)
      if (found) seats.preseed(found)
    },
    // R14 (L3) — O KIT SÓ-LSP DE CADA AJUDANTE. Quem arma é o MOTOR, com o que o
    // REGISTRO do ajudante diz (worktree, projeto, delegador): a cerca do D1
    // continua fechada porque o `delegate` não tem por onde pedir ferramenta. O
    // bearer nasce no spawn e morre no desfecho (`guiHelperLspMcp`).
    lsp: {
      hub,
      port: () => mcpPort,
      configRoot: () => join(app.getPath('userData'), 'mcp')
    },
    journalLsp: (entry) =>
      blackbox.record({
        cat: 'pane',
        event: entry.event,
        actor: 'harness',
        ids: { paneId: entry.paneId, taskId: entry.helperId },
        detail: entry.detail
      }),
    // D4 (2026-09-01) — A PORTA DE CADA AJUDANTE: reservada no spawn, anunciada
    // no ambiente, na persona e no mapa do ▶ testar; devolvida no desfecho. O
    // registro é o singleton do processo porque o mapa lê a MESMA faixa.
    ports: guiHelperPorts,
    // D3 — A ABA DO AJUDANTE MORRE COM ELE: o dispose do processo (done/failed/
    // cancelled/interrupted) fecha as abas cujo dono é o `helper-mcp-<id>`. A
    // bancada é do ajudante; o registro que fica são os shots em .synkora/browser/.
    onHelperDisposed: (helperId) => browserPanes.closeTabsOf(guiHelperMcpPaneId(helperId)),
    onChange: (change) => guiSessions?.noteHelperChange(change),
    log: (entry) =>
      blackbox.record({
        cat: 'pane',
        event: entry.event,
        actor: 'harness',
        ids: { paneId: entry.paneId, ...(entry.helperId ? { taskId: entry.helperId } : {}) },
        detail: entry.detail
      })
  })
  // A VASSOURA DA AUDITORIA (R19). O motor varre no começo de toda operação
  // pública, então um chat que continua conversando audita sozinho. O relógio
  // existe para o chat ABANDONADO: sem ninguém perguntando, o aviso de longa
  // duração nunca sairia. Ele NÃO derruba ninguém — desde a R19 nenhum
  // ajudante é assentado por relógio; quem decide parar é o dono (■) ou o
  // delegador (helper_cancel).
  setInterval(() => guiHelperEngine.sweep(), 60_000).unref()
  const guiDelegation = buildGuiDelegationApi({
    engine: guiHelperEngine,
    delegator: (paneId) => guiSessions?.delegatorFor(paneId),
    // O PINO DO DONO no painel do chat (D8): pedido sem modelo/effort abre com
    // o que ele carimbou, e o recibo diz de onde cada valor veio.
    defaults: (paneId) => guiSessions?.delegationDefaults(paneId),
    beginBatch: (paneId) => guiSessions?.beginHelperBatch(paneId),
    endBatch: (paneId) => guiSessions?.endHelperBatch(paneId),
    seats: () =>
      seats.list().map((seat) => ({
        id: seat.id,
        name: seat.name,
        cli: seat.cli,
        status: seat.status,
        configDir: seat.configDir
      })),
    // O MESMO cache de 5 min do `limites ▾` do titlebar: o delegador lê a folga
    // real das contas antes de espalhar uma frota, sem pagar processo por item.
    seatUsage: (seat) => getSeatUsage(seat.id, seat.cli, seat.configDir)
  })

  // ————— BROWSER EMBUTIDO: o kit de 11 tools do agente (H2) —————
  //
  // Três traduções moram aqui, e só aqui:
  //  1. IDENTIDADE → MISSÃO. O chat de missão traz `missionId` no bearer; o
  //     AJUDANTE não traz nenhum — ele nasce com o endereço do DELEGADOR
  //     (`guiHelperLspMcp`), e é de lá que a missão vem. Os dois trabalham no
  //     MESMO worktree, então têm de enxergar o MESMO browser: dar ao ajudante
  //     um browser próprio seria uma segunda tela para a mesma missão.
  //  2. IDENTIDADE → CLI. Só o claude recebe a imagem inline do `browser_shot`
  //     — o codex DESCARTA imagem de MCP (`openai/codex#10334`), e o caminho em
  //     texto é o que serve aos dois (o chat do dono renderiza, R36).
  //  3. EVENTOS → CAIXA-PRETA. O kit é um OBJETO no `McpApi` (como o `lsp`),
  //     então o proxy de instrumentação o deixa passar intacto de propósito: é
  //     este `log` que escreve o diário, com a missão junto.
  //  4. IDENTIDADE → DONO DA ABA (2026-09-01, D1 do design
  //     `DESIGN_BROWSER_ABAS_POR_IDENTIDADE`). A missão continua compartilhada —
  //     é o worktree do dev —, mas a ABA passou a ser de quem chama: o dev tem a
  //     dele, cada ajudante tem a dele. É aqui que a identidade vira DONO, e é o
  //     único lugar do app que sabe traduzir `helper-mcp-<id>` no NOME que o dono
  //     lê na aba (o apelido da delegação, `inv-brand`, e não um uuid).
  const browserOwnerOf = (id: PaneIdentity): BrowserTabOwner => {
    if (id.paneId.startsWith(GUI_HELPER_MCP_PANE_PREFIX)) {
      const helperId = id.paneId.slice(GUI_HELPER_MCP_PANE_PREFIX.length)
      return {
        kind: 'helper',
        // Ajudante que já morreu (a entrega ainda sendo lida) não fica sem
        // rótulo: o id curto é feio, mas é verdade.
        label: guiHelperEngine.get(helperId)?.name ?? helperId.slice(0, 8),
        paneId: id.paneId
      }
    }
    if (guiMissionRoleOf(id.paneId) === 'dev') {
      return { kind: 'dev', label: 'dev', paneId: id.paneId }
    }
    // Identidade de agente sem classificação — o papel do bearer é o rótulo.
    // Chutar "dev" aqui faria o dono ler uma aba errada com cara de certa.
    return { kind: 'agent', label: id.role, paneId: id.paneId }
  }

  const guiBrowserTools: GuiBrowserToolkit = buildGuiBrowserTools({
    manager: browserPanes,
    resolveTarget: (id) => {
      const missionId =
        id.missionId ??
        (id.delegatorPaneId ? hub.identityByPane(id.delegatorPaneId)?.missionId : undefined)
      if (!missionId) return undefined
      return { missionId, projectId: id.projectId, root: id.cwd, owner: browserOwnerOf(id) }
    },
    cliOf: (id) => {
      if (id.paneId.startsWith(GUI_HELPER_MCP_PANE_PREFIX)) {
        return guiHelperEngine.get(id.paneId.slice(GUI_HELPER_MCP_PANE_PREFIX.length))?.cli
      }
      return guiSessions?.delegatorFor(id.paneId)?.cli
    },
    log: (entry) =>
      blackbox.record({
        cat: 'mcp',
        event: entry.event,
        actor: 'harness',
        // D6 — AUTORIA: sem estes ids o diário sabia que uma aba abriu, não QUEM
        // abriu (foi por isso que a colisão de 01/09 só apareceu na transcrição
        // dos CLIs, e não na caixa-preta).
        ...(entry.ids ? { ids: entry.ids } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(entry.err ? { err: entry.err } : {})
      })
  })

  // R38 — A SONDA DA CAIXA NUM LUGAR SÓ: `scripts.release` no package.json do
  // produto, a MESMA pergunta ESTRUTURAL que a linha PUBLICAÇÃO do
  // release_status faz (R29). Manifesto ausente ou ilegível = false — produto
  // quebrado responde no build dele, e nunca inventamos pipeline de publicação
  // para quem não declara nenhum. Leitura local de um arquivo pequeno, a mesma
  // classe leve do resto da fotografia.
  const releaseProductPublishesBox = (projectPath: string): boolean => {
    try {
      const manifestPath = join(projectPath, 'package.json')
      if (!existsSync(manifestPath)) return false
      return probeManifestPublish(readFileSync(manifestPath, 'utf8'))?.hasReleaseScript === true
    } catch {
      return false
    }
  }

  const mcpApi: McpApi = {
    ...buildPlansApi(ctx, {
      proposePlanToPane: (paneId, draft) =>
        guiSessions?.proposePlan(paneId, draft) ?? {
          ok: false,
          error: 'o chat deste pane não está aberto'
        }
    }),
    delegateHelpers: (id, helpers) => guiDelegation.delegateHelpers(id, helpers),
    listSeats: (id) => guiDelegation.listSeats(id),
    helpersStatus: (id) => guiDelegation.helpersStatus(id),
    helperResult: (id, helperId, waitSeconds) =>
      guiDelegation.helperResult(id, helperId, waitSeconds),
    helperSend: (id, helperId, text) => guiDelegation.helperSend(id, helperId, text),
    helperCancel: (id, helperId) => guiDelegation.helperCancel(id, helperId),
    helperResume: (id, helperId) => guiDelegation.helperResume(id, helperId),
    // R10 — o CHAT DE RELEASE. Cascas finas: a identidade (bearer) diz a
    // missão; a missão diz a versão; a fotografia lê as MESMAS réguas do
    // releaseVersionImpl sem executá-lo, e o run é o próprio impl com o
    // sinal estrutural de sucesso (status 'lancada') concluindo a missão.
    releaseStatus: (id) => {
      const mission = id.missionId ? missions.get(id.missionId) : undefined
      const version = mission?.versionId ? backlog.getVersion(mission.versionId) : undefined
      const project = version ? projects.get(version.projectId) : undefined
      if (!mission || !version || !project)
        return 'esta conversa não está ligada a uma versão — não há release a consultar.'
      const pendingMissions = missions
        .list(version.projectId)
        // A MESMA régua do releaseVersionImpl: release não é pendência de
        // release — por TIPO (cobre também uma release órfã antiga), não só
        // a missão desta conversa.
        .filter(
          (candidate) =>
            candidate.versionId === version.id &&
            missionTypeOf(candidate) !== 'release' &&
            candidate.status !== 'concluida' &&
            candidate.status !== 'arquivada'
        )
        .map((candidate) => ({ title: candidate.title, status: candidate.status }))
      const planLock = planReleaseLock({
        versionId: version.id,
        versionName: version.name,
        plan: activeMasterPlan(plans.list(version.projectId)),
        missions: missions.list(version.projectId).map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          status: candidate.status,
          ...(candidate.versionId ? { versionId: candidate.versionId } : {})
        }))
      })
      const statusMainBranch = currentBranch(project.path) ?? undefined
      // R28 — leitura LOCAL do origin (get-url + rev-list): mesma classe leve
      // dos gits síncronos que esta fotografia já faz; nenhuma rede sai daqui.
      const statusRemote = remoteAheadOf(project.path, statusMainBranch ?? 'main')
      // R29 — a sonda de publicação: o agente sabe ANTES do release_run se a
      // subida termina no push ou na caixa. Leitura local de um arquivo
      // pequeno — mesma classe leve do resto da fotografia.
      let statusPublish:
        | { hasReleaseScript: boolean; manifestVersion?: string; expectedVersion?: string }
        | undefined
      try {
        const statusManifestPath = join(project.path, 'package.json')
        if (existsSync(statusManifestPath)) {
          const probe = probeManifestPublish(readFileSync(statusManifestPath, 'utf8'))
          if (probe) {
            const expected = semverFromVersionName(version.name)
            statusPublish = {
              hasReleaseScript: probe.hasReleaseScript,
              ...(probe.version ? { manifestVersion: probe.version } : {}),
              ...(expected ? { expectedVersion: expected } : {})
            }
          }
        }
      } catch {
        statusPublish = undefined
      }
      return releaseStatusText({
        version,
        mainBranch: statusMainBranch,
        versionHead: version.worktree ? gitHead(version.worktree) : undefined,
        mainHead: gitHead(project.path),
        ...(statusRemote
          ? {
              remote: {
                url: statusRemote.url,
                ...(statusRemote.ahead !== undefined ? { ahead: statusRemote.ahead } : {})
              }
            }
          : {}),
        ...(statusPublish ? { publish: statusPublish } : {}),
        pendingMissions,
        openBacklogItems: backlog
          .listItems(version.projectId)
          .filter((item) => item.versionId === version.id && item.status !== 'feito')
          .map((item) => ({ title: item.title })),
        planLockMessage: planLock ? planLock.message : null,
        integrationPending: integrationQueue.listPending(version.projectId).map((ticket) => ({
          title: missions.get(ticket.missionId)?.title ?? ticket.missionId,
          state: ticket.state
        })),
        releaseIntentPending: existsSync(versionReleaseIntentPath(project.path, version.id))
      })
    },
    releaseRun: async (id) => {
      const mission = id.missionId ? missions.get(id.missionId) : undefined
      const version = mission?.versionId ? backlog.getVersion(mission.versionId) : undefined
      if (!mission || !version)
        return 'esta conversa não está ligada a uma versão — nada subiu para a main.'
      const runProject = projects.get(version.projectId)
      return runReleaseForChat(
        {
          run: (versionId, actor) => releaseVersionImpl(versionId, actor),
          versionAfter: (versionId) => backlog.getVersion(versionId),
          // R38 — a subida DEIXOU de concluir a missão (o fecho é do agente,
          // pelo release_done). O que ela ainda decide é o que DIZER: produto
          // com pipeline declarado ouve a receita da CAIXA no próprio desfecho.
          publishRequired: () =>
            runProject ? releaseProductPublishesBox(runProject.path) : false
        },
        version.id
      )
    },
    // R38 — O FECHO É DO AGENTE. A plumbing do fecho é a MESMA de sempre
    // (missions.update + emitBacklogChanged + missions:changed + syncBoard);
    // o que mudou é o GATILHO: era a ascensão, agora é a decisão do agente.
    releaseDone: (id) => {
      const mission = id.missionId ? missions.get(id.missionId) : undefined
      if (!mission) return 'esta conversa não está ligada a uma missão — não há release a encerrar.'
      const version = mission.versionId ? backlog.getVersion(mission.versionId) : undefined
      const doneProject = version ? projects.get(version.projectId) : undefined
      const decision = releaseDoneDecision({
        version,
        publishRequired: doneProject ? releaseProductPublishesBox(doneProject.path) : false
        // `boxConfirmed` fica AUSENTE de propósito: o veredito do `npm run
        // release` mora no shell do agente e a release publicada mora na rede.
        // Nada disso é verificável BARATO daqui, e fabricar prova (procurar um
        // arquivo em dist/, adivinhar pelo texto) seria heurística — a casa
        // proíbe. Ausência vira ADVISORY auditado, nunca recusa.
      })
      blackbox.record({
        cat: 'merge',
        event: decision.ok
          ? decision.advisory
            ? 'release-done-advisory'
            : 'release-done'
          : 'release-done-refused',
        actor: 'agent-release',
        ids: {
          projectId: mission.projectId,
          missionId: mission.id,
          ...(version ? { ticketId: version.id } : {})
        },
        reason:
          decision.advisory ??
          (decision.ok
            ? 'o agente declarou o release terminado'
            : decision.text.slice(0, 200)),
        ...(version ? { detail: { versionName: version.name, versionStatus: version.status } } : {})
      })
      if (!decision.ok) return decision.text
      missions.update(mission.id, { status: 'concluida' })
      emitBacklogChanged(mission.projectId)
      // R27F2 — o fecho AVISA A TELA (bug do dono, 2026-08-22): a tela só
      // recarrega missões por este push, e sem ele a aba do release ficava
      // aberta até o restart (emitBacklogChanged é VERSÕES; syncBoard escreve
      // ARQUIVO). Régua: todo mutador de missão fora do missionEngine empurra
      // missions:changed.
      pushAll('missions:changed', mission.projectId)
      syncBoard(mission.projectId)
      return decision.text
    },
    // R9 — O AGENTE É O INTEGRADOR. Cascas FINAS: a identidade do pane (que o
    // bearer autenticou) diz o universo e a missão, e o motor faz o resto. A
    // missão vem do TOKEN, nunca de um argumento — um chat não integra outro.
    // R18.1: a casca aguarda — o motor mandou os ~7 gits desta fotografia para
    // o gitWorker e o handler MCP da tool sempre foi assíncrono.
    integrationStatus: async (id) =>
      id.missionId
        ? missionEngine.missionIntegrationStatus(id.projectId, id.missionId)
        : 'esta conversa não está ligada a uma missão — não há fila de integração a consultar.',
    integrationRun: async (id) =>
      id.missionId
        ? missionEngine.runMissionIntegration(id.projectId, id.missionId)
        : 'esta conversa não está ligada a uma missão — nada foi mesclado.',
    // R14 — o kit de CÓDIGO dos quatro papéis. Objeto, não função: cada método
    // já escreve a própria caixa-preta com a RAIZ junto (ver o comentário do
    // `McpApi.lsp`), então o proxy de instrumentação abaixo o deixa passar
    // intacto de propósito.
    lsp: guiLspTools,
    // BROWSER (2026-08-29): o kit dos dois papéis que verificam a própria tela
    // (`gui-delegator` sem ser reviewer, e `ajudante`). Objeto, não função —
    // ver o comentário do `McpApi.browser`.
    browser: guiBrowserTools,
    hub
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
        if (prop === 'noteCatalogServed') return value
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
      recoverMissionIntegrationIntents(p.id)
      recoverVersionReleaseIntents(p.id)
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
      // Vassoura no BOOT: marcadores sem processo podem sair, mas resultados de
      // helpers interrompidos ainda pertencem ao trabalho recuperável do card.
      // Fase 0: etapa medida — fs sync por projeto é candidato clássico do
      // stall de boot (~1,9s aos 3s com culprits vazio no 1º boot medido).
      const endSweep = mainStalls.begin('boot:project-sweep', p.id.slice(0, 8))
      sweepProjectFiles(p.id, { preserveInterruptedHelpers: true })
      // R9: isto DEIXOU de drenar. O boot reconcilia a cabeça (missão apagada,
      // já concluída ou arquivada sai da fila) e ESTIMULA o agente de quem
      // ficou esperando. Com o chat ainda fechado o estímulo não chega — e não
      // precisa: abrir a conversa o re-deriva do próprio ticket.
      if (integrationQueue.head(p.id)) scheduleIntegrationDrain(p.id)
      syncBoard(p.id)
      endSweep()
    }
  }

  void startInternalMcp()

  // REGISTRO DOS MODULOS DE IPC (fase 1, commit 5) — SEMPRE aqui: dentro do
  // whenReady (instrumentIpcMain cobre so o que registra DEPOIS dele) e
  // ANTES do createWindow (o renderer, unico cliente, ainda nao existe —
  // registrar tarde e identico a registrar cedo, e aqui TODO simbolo do
  // closure ja foi declarado: zero TDZ). NUNCA registrar no import.
  // NOTIFICAÇÕES DE DESKTOP (2.0, onda D): acessor PREGUIÇOSO da janela — o
  // createWindow só roda no fim deste bloco, e o módulo só consulta a janela
  // na hora de notificar (é ela que decide se o app está em foco; em foco,
  // nada é notificado). Mesmo padrão do `window: () => mainWindow` da view.
  initDesktopNotifications(() => mainWindow)
  registerMiscIpc(ctx, { assertMainRendererSender, ensureBypassAccepted })
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
  registerFilesIpc(ctx, { assertAppRendererSender })
  registerSettingsIpc(ctx, { assertMainRendererSender, assertAppRendererSender })
  // BROWSER EMBUTIDO: a superfície do DONO (barra de URL, abas, ← → ⟳,
  // devtools, bounds do painel). O agente entra pelo MCP, nunca por aqui.
  registerBrowserIpc(ctx, {
    assertBrowserSender: assertBrowserSurfaceSender,
    browser: browserPanes
  })
  // PANE GUI (Synkora 2.0, onda A — docs/GUI_PANE_CONTRACT.md): sessão de chat
  // por pane. Nenhum CLI filho sobrevive ao quit.
  // O VIGIA DE VERSÃO PÓS-BOOT (2026-09-01): o binário pode mudar com o app de
  // pé (o dono atualizou o claude por fora e o Fable 5.1 não aparecia). A
  // cada 5 min, e a cada pane que nasce, a versão é re-lida; mudança entra pelo
  // mesmo `onCliStatus` de uma rodada de update — o catálogo cai, o renderer
  // esquece as listas, o titlebar acende "CLIs atualizados".
  const cliVersionWatch = startCliVersionWatch({ intervalMs: 5 * 60_000 })
  guiSessions = registerGuiIpc(ctx, {
    assertAppRendererSender,
    waitForCliStable: (cli) => {
      // Fora do caminho crítico de propósito: o pane não espera o `--version`;
      // se o binário mudou, o próximo catálogo já sai fresco.
      void cliVersionWatch.check()
      return waitForGuiCliStable(cli, {
        getStatus: getCliStatus,
        isUpdating: isUpdatingClis,
        updateAll: updateAllClis
      })
    },
    systemPromptFile: persistTrustedSystemPrompt,
    storeFile: join(app.getPath('userData'), 'gui-sessions.json'),
    helpers: guiHelperEngine
  })
  const guiSessionRegistry = guiSessions
  // A ARESTA DE VOLTA da costura circular (R6-B): o motor já fala com o registro
  // por closure (`onChange`, acima); aqui o registro ganha o motor, que é o que
  // o ■ do dono e o despertador de boot precisam perguntar. Uma linha, e é ela
  // que torna a interrupção ATÔMICA (turno + frota + avisos pendentes).
  guiSessionRegistry.attachHelpers(guiHelperEngine)
  // A MESMA aresta de volta para a FILA (R9): quando um chat de missão abre de
  // verdade (boot, reabrir a aba), o motor confere se existe um ⇪ do dono
  // esperando por ele e re-estimula. O clique com o chat fechado deixa de se
  // perder sem que nada novo precise ser persistido — o ticket já é durável.
  guiSessionRegistry.attachIntegration({ paneOpened: restimulateIntegrationOnOpen })
  app.once('will-quit', () => {
    // A frota para ANTES dos chats: é o motor que descarta cada processo de CLI
    // headless (o app-server do codex nunca encerra sozinho — sonda
    // probe-helper-matrix §6). E fechar o app INTERROMPE, nunca descarta (R6.1,
    // ordem do dono): os registros vão ao disco retomáveis, e a conversa que
    // reabrir recebe o aviso com os dois verbos.
    guiHelperEngine.interruptAll('o app foi fechado')
    guiSessionRegistry.killAll()
    // R14: os servidores de linguagem morrem junto com os chats. O
    // `disposeAll` pede tchau pelo protocolo antes de matar — o
    // typescript-language-server tem o tsserver como FILHO, e matar só o pai
    // deixaria um órfão segurando o worktree.
    lspManager.disposeAll()
    // As views do browser são filhas da janela e morrem com ela; o `destroy`
    // existe para o que NÃO morre sozinho (listeners de janela, sessões CDP
    // anexadas) e para o quit não deixar processo de renderer órfão. E agora
    // também para as JANELAS DESTACADAS: elas são superfícies do app, não
    // janelas soltas do sistema — o `destroy` fecha todas (`closeAll`).
    browserPanes.destroy()
  })
  // Cmd/Ctrl+K: só depois do registro GUI existir, porque o índice de
  // históricos liga sessionId aos panes/mission tabs que podem remontá-los.
  registerHistoryIpc(ctx, {
    assertAppRendererSender,
    guiSessions: guiSessionRegistry
  })
  // PLANOS DO UNIVERSO (2.0, onda D): as abas do MAPA e os gestos do dono
  // sobre elas. A leitura já traz o progresso derivado das missões.
  //
  // EXPURGO F6 (2026-08-17): o `registerProjectPlanIpc` que ficava aqui morreu
  // com a aba do roadmap por ondas — `plans:*` é a ÚNICA ponte de plano viva.
  registerPlansIpc(ctx, { assertAppRendererSender })
  // SKILLS 2.0 (2026-08-29): a biblioteca é da MÁQUINA e o kit é DADO em
  // userData — a tela de Ajustes ▸ Skills entra por aqui.
  registerSkillsIpc(ctx, { assertAppRendererSender })
  registerProjectsIpc(ctx, {
    killMaestroSession,
    ensureBypassAccepted,
    discardUnstartedPane,
    guiSessions: guiSessionRegistry,
    killProjectGuiPanes
  })
  registerBacklogIpc(ctx, {
    emitBacklogChanged,
    releaseVersionImpl,
    versionIsolationIsValid,
    invalidateLspRoot: (root) => lspManager.invalidate(root),
    listVersionReleases: (versionId) => releases.listForVersion(versionId),
    listProjectReleases: (projectId) => releases.list(projectId)
  })
  registerMaestroIpc(ctx, {
    engine: maestroEngine,
    sweepProjectFiles,
    killMaestroSession,
    beginProgressMaestroTurn,
    finishProgressMaestroTurn,
    beginProgressHeadlessActivity,
    endProgressHeadlessActivity,
    surveySystemPromptFile
  })
  registerMissionsIpc(ctx, {
    engine: missionEngine,
    maestroEngine,
    orchKey,
    emitBacklogChanged,
    staggerPaneSpawn,
    guiSessions: guiSessionRegistry,
    killMissionGuiPanes
  })
  registerPtyIpc(ctx, {
    engine: paneLifecycle,
    paneCodexSkillProfiles,
    scheduleProgressLiveSnapshot,
    refreshProgressLiveSnapshot,
    progressLiveIdleTimers,
    emitMissionsChanged,
    recordGateDeath: () => ({ looping: false, deaths: 0 })
  })
  registerPanesIpc(ctx, {
    engine: paneLifecycle,
    ensureMissionWorktree
  })

  // Fase 0: criação da janela é etapa medida do boot
  mainStalls.wrap('boot:createWindow', undefined, () => createWindow())
  mainStalls.wrap('boot:progressSnapshot', undefined, () => refreshProgressSnapshot())
  if (loadProgressOverlayPreferences().visible) createProgressOverlay()

  // CLIs SEMPRE ATUALIZADOS (decisão do usuário, 2026-07-24): pane roda o
  // binário do PATH, então CLI velho = modelo novo que não existe no seletor
  // (o Opus 5 saiu e os panes seguiam no catálogo do 2.1.218). A checagem
  // roda no boot; `gui:create` compartilha esta mesma barreira single-flight,
  // então nenhum pane nasce enquanto o executável global está sendo trocado.
  setTimeout(() => {
    // Fase 0: o tick de 2,5s coincide com o stall de boot medido — o trecho
    // SYNC do kickoff (PATH do registro etc.) entra no sensor; o trabalho
    // async segue fora (se o culpado for ele, culprits continua vazio aqui).
    mainStalls.wrap('boot:cli-skills-kickoff', undefined, () => {
      const before = getCliStatus()
      // Um `gui:create` antes deste timer já pode ter concluído a checagem.
      // Nesse caso não abre uma segunda rodada sobre o pane que acabou de nascer.
      const cliUpdate =
        isUpdatingClis() || before.some(({ state }) => state === 'unknown' || state === 'updating')
          ? updateAllClis()
          : Promise.resolve(before)
      void cliUpdate.then((all) => {
        for (const s of all) {
          console.log(
            `[cli] ${s.cli} ${s.version ?? '—'} · ${s.state}${s.from ? ` (era ${s.from})` : ''}`
          )
        }
      })
      // Skills também não podem envelhecer (o diferencial da biblioteca): check
      // diário no boot — TTL de 24h e batch por repo dentro do próprio método.
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

/**
 * MAINCONTEXT — contrato explícito do estado do main (Fase 1, commit 1).
 *
 * A cirurgia do índice (docs/PLANO_NIVEL_5.md + docs/FASE1_MAPA_MAINCONTEXT.md)
 * extrai módulos (phaseEngine, mcpApi/, ipc/) que recebem ESTE contrato em vez
 * de viver no closure do whenReady. Aqui só há TIPOS — o objeto é construído
 * no index, logo após o hub nascer, expondo o que já existe (zero movimentação
 * de código; qualquer divergência de shape quebra o typecheck).
 *
 * Regras de implementação (valem para quem constrói e para quem consome):
 * - Campos `readonly` podem ser getter por trás: variáveis reatribuídas em
 *   runtime (uiSender, hub, mcpPort…) e consts declaradas DEPOIS do ponto de
 *   construção entram como getter — leia sempre via ctx, nunca copie o valor.
 * - `ctx.tasks`: onMutation/onCreate/onRemove são atribuídos pelo index
 *   pós-construção — módulos que recebem o contexto NUNCA os reatribuem.
 * - `ctx.push` é o caminho único para empurrar evento à janela principal
 *   (encapsula o padrão `uiSender && !uiSender.isDestroyed()` — CHECK 17).
 */
import type { BrowserWindow, WebContents } from 'electron'
import type { ProjectStore } from './projects'
import type { SeatStore } from './seats'
import type { TaskStore, Task, PlanVerificationCheckpoint } from './tasks'
import type { MissionStore } from './missions'
import type { IntegrationQueueStore } from './integrationQueue'
import type { BacklogStore } from './backlog'
import type { MaestroStore } from './maestroStore'
import type { PolicyStore } from './policies'
import type { SettingsStore } from './settings'
import type { PtyManager } from './pty'
import type { PaneMailbox } from './mailbox'
import type { SkillsLibrary } from './skillsLibrary'
import type { SynVoiceService } from './synVoice'
import type { Blackbox } from './blackbox'
import type { StallAttribution } from './stallAttribution'
import type { SessionStatsWatcher } from './sessionStats'
import type { HelperCompletionTracker } from './helperCompletion'
import type { MaestroSession } from './maestroSession'
import type { CodexSession } from './codexSession'
import type { Hub, PaneIdentity } from './hub'
import type { CodeIntelligenceManager, CodeIntelligenceSession } from './codeIntelligence'
import type { McpServerHandle, McpStdioLaunch } from './mcpServer'
import type { PaneStartupMetrics } from './paneStartupMetrics'
import type { WorkspaceSkillLeaseRegistry } from './workspaceSkills'
import type {
  PhaseLaunchGuard,
  PhaseLaunchCapacityGuard,
  PhaseLaunchToken
} from './phaseLaunchGuard'
import type { MaestroEvent } from './maestro'
import type { SecurityReviewRecord } from './securityReview'
import type { ProjectPlan } from './projectPlan'
import type {
  DevPaneSpec,
  LiveGateWait,
  MissionWatch,
  PendingUserQuestion,
  PhaseWatch,
  RunPhase
} from './phaseTypes'

/**
 * Máquina de fases por delegação (o corpo vira phaseEngine.ts no commit 3).
 * Permite extrair o mcpApi antes OU depois do phaseEngine sem retrabalho.
 */
export interface PhaseApi {
  preparePhasePane(
    projectId: string,
    taskId: string,
    phase: RunPhase,
    devSeatId: string,
    devModel?: string,
    devEffort?: string,
    feedback?: string,
    launchToken?: PhaseLaunchToken
  ): Promise<DevPaneSpec | null>
  /** SYNC POR CONTRATO (barreira síncrona do veredito — a cicatriz do
   *  "[object Promise]"): NUNCA transformar em Promise<boolean>. */
  advancePhase(
    watch: PhaseWatch,
    content: string,
    securityReview?: SecurityReviewRecord
  ): boolean
  retryOrBacklog(watch: PhaseWatch, who: string, motivo: string): Promise<void>
  openGatePane(watch: PhaseWatch, phase: 'review' | 'qa'): Promise<boolean>
  finalizeTask(watch: PhaseWatch, task: Task, approvedBy: string): Promise<void>
  openPhasePane(watchSpec: DevPaneSpec, projectId: string, taskId: string): void
  closePhasePane(projectId: string, taskId: string, role: RunPhase): void
  terminateTaskPhasePane(projectId: string, taskId: string, role: RunPhase): void
}

export interface MainContext {
  // ——— stores e serviços (referência estável — atribuídos 1×) ———
  readonly projects: ProjectStore
  readonly seats: SeatStore
  /** onMutation/onCreate/onRemove pertencem ao index — nunca reatribuir. */
  readonly tasks: TaskStore
  readonly missions: MissionStore
  readonly integrationQueue: IntegrationQueueStore
  readonly backlog: BacklogStore
  readonly maestro: MaestroStore
  readonly policies: PolicyStore
  readonly settings: SettingsStore
  readonly ptys: PtyManager
  readonly mailbox: PaneMailbox
  readonly skillsLib: SkillsLibrary
  readonly synVoice: SynVoiceService
  readonly blackbox: Blackbox
  readonly mainStalls: StallAttribution
  readonly sessionStats: SessionStatsWatcher
  readonly helperCompletions: HelperCompletionTracker
  readonly maestroSessions: Map<string, MaestroSession | CodexSession>
  readonly helperSkillLeases: WorkspaceSkillLeaseRegistry

  // ——— reatribuíveis em runtime (getters — sempre o valor ATUAL) ———
  /** Getter de propósito: quebra o ciclo Hub↔contexto (HubDeps captura
   *  projects/ptys/mailbox/blackbox/uiSender antes de o hub existir). */
  readonly hub: Hub
  readonly uiSender: WebContents | null
  readonly mainWindow: BrowserWindow | null
  readonly mcpPort: number
  readonly mcpServerHandle: McpServerHandle | undefined
  readonly codeIntelligence: CodeIntelligenceManager | undefined
  readonly internalMcpState: 'starting' | 'ready' | 'unavailable'
  readonly paneStartupMetrics: PaneStartupMetrics | undefined

  // ——— estado vivo (Maps/Sets — a INSTÂNCIA é estável, o conteúdo muda) ———
  readonly paneTokens: Map<string, string>
  readonly paneMcpFiles: Map<string, string>
  readonly paneSessions: Map<string, string>
  readonly paneStatusNotes: Map<string, { text: string; at: string }>
  readonly helperReported: Set<string>
  readonly helperSeen: Set<string>
  readonly voiceRequests: Map<string, { controller: AbortController; senderId: number }>
  readonly materializedPlanningSkillsByProject: Map<string, Set<string>>
  readonly expiredSeats: Map<string, number>
  readonly baselineVerificationRuns: Map<string, Promise<PlanVerificationCheckpoint>>
  readonly finalVerificationRuns: Map<string, Promise<void>>
  readonly missionWatches: Map<string, MissionWatch>
  readonly integrationDrainTimers: Map<string, NodeJS.Timeout>
  readonly integrationDraining: Set<string>
  readonly surveyAborts: Map<string, () => void>
  readonly testServerPanes: Map<
    string,
    { projectId: string; cwd: string; command: string; port?: number; label?: string }
  >
  readonly livePaneSpecs: Map<
    string,
    { projectId: string; taskId: string; spec: DevPaneSpec }
  >
  readonly closingPaneIds: Set<string>
  readonly paneEverSpawned: Set<string>
  readonly phaseWatches: Map<string, PhaseWatch>
  readonly phaseLaunches: PhaseLaunchGuard
  readonly phaseLaunchCapacity: PhaseLaunchCapacityGuard
  readonly pendingUserQuestions: Map<string, PendingUserQuestion>
  readonly liveGateWaits: Map<string, LiveGateWait>
  readonly gateDeathLog: Map<string, number[]>
  readonly gateCooldownUntil: Map<string, number>
  readonly bootRespawnsPending: Map<string, Set<string>>
  readonly phaseMarkersProcessing: Set<string>
  readonly pendingPtyPreparations: Map<string, symbol>
  readonly mcpCatalogServedByPane: Map<string, string>
  readonly mcpPaneFirstContact: Map<string, number>
  readonly seenMcpTokens: Set<string>

  // ——— funções do closure (delegação — imune à ordem de declaração) ———
  syncBoard(projectId: string): void
  emitLog(projectId: string, evt: MaestroEvent): void
  scheduleProgressSnapshot(): void
  ensureProjectRuntimeWritable(projectId: string): void
  projectModeOf(projectId: string): 'greenfield' | 'existing'
  projectPlanOf(projectId: string): ProjectPlan | undefined
  externalPlaywrightForPane(): McpStdioLaunch | undefined
  bypassOn(projectId: string): boolean
  maestroPaneId(projectId: string): string
  orchPaneId(projectId: string, missionId: string): string
  unregisterPane(paneId: string): PaneIdentity | undefined
  cleanPaneMcpFile(paneId: string): void
  codeIntelligenceSession(id: PaneIdentity): CodeIntelligenceSession
  persistUserQuestions(): void
  abortVoiceRequests(): void
  releasePaneSkillLease(paneId: string): void

  /** Push seguro à janela principal — ponto único do padrão
   *  `if (uiSender && !uiSender.isDestroyed()) uiSender.send(...)`. */
  push(channel: string, ...args: unknown[]): void

  readonly phase: PhaseApi
}

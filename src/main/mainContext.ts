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
import type {
  PhaseTransitionLock,
  PhaseTransitionToken
} from './phaseTransitionLock'
import type { MaestroEvent } from './maestro'
import type { SecurityReviewRecord } from './securityReview'
import type { GateVerificationEvidence } from './gateVerificationEvidence'
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
  /** ASSÍNCRONO POR SERIALIZAÇÃO (Fase 2, F2-c5): a atomicidade do veredito
   *  vem do PhaseTransitionLock (lock por card), não mais da sincronicidade —
   *  a barreira síncrona morreu aqui. A CICATRIZ do "[object Promise]"
   *  (2026-08-05) continua a régua: todo consumidor DEVE `await` — uma
   *  Promise não-aguardada tratada como valor volta a ser possível a cada
   *  await esquecido, e o typecheck de Promise<boolean> é o que força os call
   *  sites. Arity COMPLETA (fix do commit 3): o tipo antigo parava em
   *  securityReview e um consumidor via ctx.phase droparia
   *  verificationEvidence/acceptance em silêncio.
   *  `token` é a posse adquirida pelo ENTRANTE (report/poller) — o
   *  advancePhase assume o release nos desfechos normais (imediato ou no
   *  settle da cadeia de continuação); no THROW a posse volta ao call site,
   *  que faz rollback + release via rollbackVerdictTransaction (§8.2 do
   *  mapa: o release vem DEPOIS do re-index). Chamada sem posse emite
   *  `phase-advance-without-lock` na caixa-preta, nunca lança. */
  advancePhase(
    watch: PhaseWatch,
    content: string,
    securityReview?: SecurityReviewRecord,
    verificationEvidence?: GateVerificationEvidence,
    acceptance?: {
      skillUsage: NonNullable<Task['skillUsage']>
      commitRuntime: () => boolean
    },
    token?: PhaseTransitionToken,
    /** Fotografia do dev POR VALOR (F2-c5b, §7.10): vem do codeReportGuard
     *  do PRÓPRIO entrante — o campo watch.devSnapshot virou fallback. */
    devSnapshot?: PhaseWatch['devSnapshot']
  ): Promise<boolean>
  /** Rollback padrão do caminho de THROW do veredito (F2-c5): re-indexa o
   *  watch com createdAt renovado (§7.4) — a menos que o registry já tenha um
   *  watch NOVO do card (R2: o novo vence e o artefato do velho é limpo) — e
   *  SÓ ENTÃO solta o lock. Idempotente; token errado/velho é no-op. */
  rollbackVerdictTransaction(watch: PhaseWatch, token?: PhaseTransitionToken): void
  /** `rejectingGate` viaja por PARÂMETRO (F2-c5, §6.1 do mapa): o gate
   *  reprovador é calculado DENTRO do lock — re-consultar liveGateWaits após
   *  awaits deixava um onExit apagar a espera e a evidência do gate reprovador
   *  não era zerada (a memoização poderia "aprovar" o que reprovou). */
  retryOrBacklog(
    watch: PhaseWatch,
    who: string,
    motivo: string,
    rejectingGate?: 'review' | 'qa'
  ): Promise<void>
  openGatePane(watch: PhaseWatch, phase: 'review' | 'qa'): Promise<boolean>
  finalizeTask(watch: PhaseWatch, task: Task, approvedBy: string): Promise<void>
  openPhasePane(watchSpec: DevPaneSpec, projectId: string, taskId: string): void
  closePhasePane(projectId: string, taskId: string, role: RunPhase): void
  terminateTaskPhasePane(projectId: string, taskId: string, role: RunPhase): void
  // ——— superfície extra do engine consumida pelo mcpApi (commit 4a) ———
  /** Valida o artefato imutável do review (hash/tamanho/containment).
   *  Async desde o F2-c5 (R11): o sha256 de patch grande roda no worker via
   *  gitOff('reviewArtifactIdentity') — era o único I/O pesado sem caminho. */
  reviewArtifactProblem(watch: PhaseWatch): Promise<string | undefined>
  /** Remove o artefato do storage privado (fim de rodada/veredito). */
  cleanupReviewArtifact(watch: PhaseWatch): void
  /** Chunk autenticado do diff SHA-pinado servido ao reviewer. */
  readReviewArtifactChunk(watch: PhaseWatch, offset: number, maxBytes?: number): string
  /** Marcador `synkora-task:<id>` usado no recibo de integração. */
  taskIntegrationMarker(task: Task): string
  /** Retoma merge/finalize interrompido sobre os gates já aprovados. */
  recoverFinalizingTask(task: Task): Promise<boolean>
  // ——— superfície extra do engine consumida pelo ipc/ (commit 5e) ———
  /** Fecha um gate VIVO em espera (higiene do mapa + kill do pane). */
  closeLiveGateWait(projectId: string, taskId: string, reason: string): void
  /** Drena os respawns LAZY anotados pelo recovery de boot (projeto aberto). */
  drainPendingRespawns(projectId: string): void
  /** Ocupação REAL do projeto para o teto MAX_PARALLEL_RUNS (§7.6 do mapa da
   *  Fase 2): fases com watch + cards em TRANSIÇÃO (lock tomado com o watch
   *  detached) — um veredito em voo não pode furar o teto em 1. Card com
   *  watch E lock (rollback/continuação re-indexada) conta UMA vez. */
  phaseOccupancy(projectId: string, excludeTaskId?: string): number
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
  /** PhaseWatchRegistry do phaseEngine (tipo estrutural para não criar ciclo
   *  de import): delete() limpa o artefato de review; detach() remove só a
   *  indexação durante a transação do report — advancePhase continua dono do
   *  artefato até aceitar ou restaurar a rodada. */
  readonly phaseWatches: Map<string, PhaseWatch> & { detach(taskId: string): boolean }
  readonly phaseLaunches: PhaseLaunchGuard
  readonly phaseLaunchCapacity: PhaseLaunchCapacityGuard
  /** Lock de transição por card (Fase 2, docs/FASE2_PLANO.md §3): "sem watch"
   *  deixou de significar "card livre" — quem pergunta consulta isLocked. */
  readonly phaseTransitions: PhaseTransitionLock
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

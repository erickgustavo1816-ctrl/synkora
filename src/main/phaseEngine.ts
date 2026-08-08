/**
 * PHASE ENGINE — máquina de fases da execução (fase 1, commit 3).
 *
 * Corpo movido VERBATIM do closure do whenReady em index.ts (cirurgia do
 * índice, docs/FASE1_MAPA_MAINCONTEXT.md). O estado de fase (phaseWatches,
 * liveGateWaits, gateDeathLog, gateCooldownUntil, phaseLaunches,
 * phaseLaunchCapacity, bootRespawnsPending, phaseMarkersProcessing) nasce
 * AQUI; o index expõe aliases para os call sites legados e para os getters
 * do MainContext até os commits 4–5 (mcpApi/, ipc/) consumirem ctx.phase.
 *
 * Contratos que este módulo NÃO pode quebrar:
 * - advancePhase é SYNC POR CONTRATO (barreira síncrona do veredito — a
 *   cicatriz do "[object Promise]"): nunca virar Promise<boolean>.
 * - Fase 2 (F2-c4, docs/FASE2_PLANO.md §3): toda TRANSIÇÃO de card roda sob o
 *   PhaseTransitionLock (phaseTransitions) — aquisição SÓ nos pontos de
 *   entrada (report/poller/boot/reseat/recover), ordem síncrona sagrada
 *   acquire → detach → unlink, e "quem SEGURA O LOCK deleta o watch". O
 *   advancePhase é o dono do release a partir da chamada; continuações
 *   (openGatePane/retryOrBacklog/finalizeTask) herdam o token via
 *   chainContinuation e o release acontece no settle da cadeia.
 * - MAX_PARALLEL_RUNS declarado ANTES de qualquer consumidor (no index a
 *   const vinha DEPOIS do poller e vivia de hoisting — aqui é export de
 *   módulo, sem TDZ).
 * - O poller de 3s continua no index: só a parte de FASES mora aqui
 *   (tickPhaseWatches); helper watchdog e missionWatches ficam lá até a
 *   extração de missões.
 * - gateDeathLog é escrito pelo onExit do PTY via recordGateDeath(taskId),
 *   nunca pelo Map cru.
 */
import { app, shell } from 'electron'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { type SeatCli } from './seats'
import { type Task, type TaskGateEvidence, type TaskUpdatePatch } from './tasks'
import {
  alignWorktreeFromSnapshot,
  changedWorktreeFiles,
  createTaskWorktree,
  currentBranch,
  ensureSynkoraGitExcludes,
  gitCommitReached,
  gitHead,
  gitHistoryContainsMessage,
  gitTree,
  gitVisibleWorktreeFingerprint,
  hasGitCommit,
  isExecutableProjectPath,
  isWorktreeClean,
  mergeTaskWorktree,
  quarantineUntrackedNew,
  removeWorktreeAndBranch,
  snapshotProblemFor,
  taskWorktreeDescriptor
} from './worktree'
import { type Mission } from './missions'
import {
  assessMissionRisk,
  normalizeDelegationMode,
  type MissionExecutionMode
} from './orchestratorFlow'
import { type GateVerificationEvidence } from './gateVerificationEvidence'
import {
  buildReviewEvidenceChunkManifest,
  readAuthenticatedReviewEvidenceChunk,
  reviewArtifactIdentity
} from './reviewEvidence'
import {
  buildAgentsBlock,
  buildAtomicRoundRule,
  buildBasePrompt,
  buildBrowserHint,
  buildClosedListBlock,
  buildDevContract,
  buildExecutionProfileBlock,
  buildGateRecyclePrompt,
  buildPhasePrompt,
  buildQaDeliverySnapshotBlock,
  buildQaRuntimeBlock,
  buildQuestBlock,
  buildResumeReadFirstPrompt,
  buildReviewDiffBlock,
  buildSkillsBlock,
  buildStructuredReviewRule,
  buildVerdictRule,
  buildWorkspaceMaterialsNote,
  qaRuntimeAlreadyRunningNote,
  qaRuntimeHarnessFailedNote,
  qaRuntimeHarnessStartedNote
} from './phasePrompts'
import { type DevPaneSpec, type LiveGateWait, type PhaseWatch, type RunPhase } from './phaseTypes'
import { PhaseTransitionLock, type PhaseTransitionToken } from './phaseTransitionLock'
import { type MainContext } from './mainContext'
import { requiresManualSecurityValidation, securityPromptForRole } from './securityPolicy'
import { manualSecurityValidationOf } from './manualSecurityValidation'
import { persistSecurityReview, type SecurityReviewRecord } from './securityReview'
import { ensureProjectSecurityBaseline } from './projectSecurityBaseline'
import { redactSensitiveText } from './securityRedaction'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { GIT_CHECKPOINT_MARKER, gitOff, gitOffWithCheckpoint } from './gitAsync'
import { randomUUID } from 'crypto'
import { type PaneIdentity } from './hub'
import { type SkillDef } from './skillsLibrary'
import {
  IMPECCABLE_SKILL_ID,
  SYNKORA_FRONTEND_STANDARD_ID,
  SYNKORA_UI_QA_ID,
  classifyTaskUiWork,
  missingMandatoryUiPhaseSkills,
  selectPhaseSkillPlan,
  type SkillCapability
} from './skillsRouting'
import { SkillRuntime, type PlannedSkillInput } from './skillRuntime'
import { type HelperRecoveryRecord } from './helperRecovery'
import {
  effectiveSensitiveAccess,
  paneAccessProfile,
  paneBrowserAvailable
} from './panePermissions'
import { immutableReviewDiff } from './reviewDiff'
import { detectRuntimeScript, qaRuntimeOf, startQaRuntime, stopQaRuntime } from './qaRuntime'
import { formatPortMap, type PortUseEntry } from './portMap'
import {
  PhaseLaunchCapacityGuard,
  PhaseLaunchGuard,
  type PhaseLaunchToken
} from './phaseLaunchGuard'

// Teto de execuções simultâneas por projeto quando o ORQUESTRADOR dispara
// (run_task) — backpressure simples; o humano não é limitado. Uma onda
// greenfield pode ter cinco ou seis missões independentes; o limite protege
// a máquina sem transformar o paralelismo entre missões numa fila invisível.
export const MAX_PARALLEL_RUNS = 6
// Crash-loop de gate: 3 mortes SEM veredito em 60s suspendem a reabertura
// automática por 5min (precedente do Board: 3 mortes/30s).
export const GATE_DEATH_LIMIT = 3
const GATE_DEATH_WINDOW_MS = 60_000

/**
 * Dependências do closure do index que a máquina de fases consome e que ainda
 * NÃO migraram para módulos próprios. Entregues por referência no
 * createPhaseEngine; `codeReportGuard` é late-bound (o mcpApi nasce DEPOIS do
 * engine — arrow no call site, resolvida na chamada, nunca na construção).
 */
export interface PhaseEngineExtras {
  terminatePaneNow(projectId: string, paneId: string): void
  terminateTaskHelpers(projectId: string, taskId: string, reason: string): void
  discardUnstartedPane(paneId: string): void
  planTaskForWorkTask(task: Task): Task | undefined
  retryLimitForTask(task: Task): number
  executionModeForTask(task: Task): MissionExecutionMode
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  missionWorkspacePath(projectPath: string, mission: Mission): string | undefined
  ensureMissionWorktree(missionId: string): Mission | undefined
  timedTaskWorktree(
    ...args: Parameters<typeof createTaskWorktree>
  ): Promise<ReturnType<typeof createTaskWorktree>>
  prepareSkillPlanInputs(
    rootIds: string[],
    describe: (id: string) => Pick<PlannedSkillInput, 'operation' | 'reason' | 'required'>
  ): Promise<{ definitions: SkillDef[]; inputs: PlannedSkillInput[]; missing: string[] }>
  syncPaneSkillLease(
    paneId: string,
    cwd: string,
    ids: string[]
  ): Promise<{ injected: SkillDef[]; missing: string[] }>
  renewLivePaneSkillRun(
    paneId: string,
    taskId: string,
    projectId: string,
    phase: RunPhase
  ): Promise<string | undefined>
  releasePaneSkillPlan(paneId: string): void
  skillRuntime: SkillRuntime
  skillPlanScopes: Map<
    string,
    {
      phase: string
      phaseRun: string
      agentIds: string[]
      taskId?: string
      projectId?: string
      missionId?: string
    }
  >
  storedHelperRecoveries(
    projectId: string
  ): Array<{ file: string; relativePath: string; record: HelperRecoveryRecord }>
  harnessPortsInUse(projectId: string): PortUseEntry[]
  codexDeveloperInstructions(value: string): string
  armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts?: { strictMcp?: boolean; configDir?: string; sensitive?: boolean }
  ): { paneId: string; cliArgs: string[] }
  /** Late-bound: o mcpApi nasce depois do engine. */
  codeReportGuard(identity: PaneIdentity): Promise<string | undefined>
}

export type PhaseEngine = ReturnType<typeof createPhaseEngine>

export function createPhaseEngine(ctx: MainContext, extras: PhaseEngineExtras) {
  const {
    tasks,
    seats,
    projects,
    missions,
    ptys,
    blackbox,
    maestro,
    policies,
    skillsLib,
    mainStalls,
    paneSessions,
    emitLog,
    syncBoard,
    ensureProjectRuntimeWritable,
    projectModeOf,
    externalPlaywrightForPane,
    releasePaneSkillLease,
    orchPaneId
  } = ctx
  // hub é atribuído UMA vez, antes de o engine nascer — capturar é seguro.
  const hub = ctx.hub
  // livePaneSpecs/closingPaneIds pertencem ao ciclo de vida de PANE (dev,
  // gate, helper, teste) e ficam no index — aqui só se lê/escreve a instância.
  const livePaneSpecs = ctx.livePaneSpecs
  const closingPaneIds = ctx.closingPaneIds
  const {
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
    releasePaneSkillPlan,
    skillRuntime,
    skillPlanScopes,
    storedHelperRecoveries,
    harnessPortsInUse,
    codexDeveloperInstructions,
    armPane,
    codeReportGuard
  } = extras

  const DEPT_NAME: Record<string, string> = {
    front: 'front-end',
    back: 'back-end',
    qa: 'QA',
    design: 'design',
    research: 'research'
  }

  // reviewArtifactIdentity extraído para reviewEvidence.ts na Fase 2 (R11):
  // módulo puro, elegível ao worker — o sha256 de patch grande sai do main
  // no F2-c5 via gitOff('reviewArtifactIdentity').
  const reviewEvidenceRoot = join(app.getPath('userData'), 'review-evidence')
  let sweptReviewArtifacts = false
  function removeAllReviewArtifacts(): void {
    try {
      mkdirSync(reviewEvidenceRoot, { recursive: true })
      for (const name of readdirSync(reviewEvidenceRoot)) {
        if (!/^[a-zA-Z0-9_-]+-[0-9a-f-]{36}\.review\.patch$/i.test(name)) continue
        try {
          unlinkSync(join(reviewEvidenceRoot, name))
        } catch {
          // outro processo pode ter limpado primeiro
        }
      }
    } catch {
      // diretório ainda não existe
    }
  }
  function sweepReviewArtifactsOnce(): void {
    if (sweptReviewArtifacts) return
    sweptReviewArtifacts = true
    removeAllReviewArtifacts()
  }
  // Resíduos de crash são removidos no boot mesmo que esta sessão não abra
  // outro review grande. A instância do app é única e nenhuma rodada viva
  // existe antes deste ponto da inicialização.
  sweepReviewArtifactsOnce()
  app.once('will-quit', removeAllReviewArtifacts)

  /** Grava patches grandes fora do worktree. O gate só os lê pela tool
   * vinculada a pane/fase; DEV e conteúdo do projeto nunca recebem o path. */
  function materializeReviewDiffArtifact(
    _cwd: string,
    taskId: string,
    evidence: ReturnType<typeof immutableReviewDiff>
  ): PhaseWatch['reviewArtifact'] | undefined {
    if (
      evidence?.mode !== 'local' ||
      (!evidence.artifactText && !evidence.artifactSourcePath)
    ) {
      return undefined
    }
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    if (!safeTaskId) return undefined
    sweepReviewArtifactsOnce()
    const absolutePath = join(
      reviewEvidenceRoot,
      `${safeTaskId}-${randomUUID()}.review.patch`
    )
    try {
      mkdirSync(dirname(absolutePath), { recursive: true })
      if (evidence.artifactText) {
        writeFileSync(absolutePath, evidence.artifactText, 'utf-8')
      } else if (evidence.artifactSourcePath) {
        copyFileSync(evidence.artifactSourcePath, absolutePath)
      }
      const identity = reviewArtifactIdentity(absolutePath)
      if (
        (evidence.artifactSha256 && evidence.artifactSha256 !== identity.sha256) ||
        (evidence.artifactBytes !== undefined && evidence.artifactBytes !== identity.bytes)
      ) {
        unlinkSync(absolutePath)
        return undefined
      }
      return {
        privatePath: absolutePath,
        ...identity,
        chunks: buildReviewEvidenceChunkManifest(absolutePath, identity.bytes),
        servedUntil: 0
      }
    } catch {
      try {
        unlinkSync(absolutePath)
      } catch {
        // destino parcial pode não ter sido criado
      }
      return undefined
    } finally {
      if (evidence.artifactSourcePath) {
        try {
          unlinkSync(evidence.artifactSourcePath)
          rmSync(dirname(evidence.artifactSourcePath), { force: true })
        } catch {
          // O diretório temporário do sistema cobre crash/interrupção.
        }
      }
    }
  }

  function reviewArtifactProblem(watch: PhaseWatch): string | undefined {
    const artifact = watch.reviewArtifact
    if (!artifact) return undefined
    const storageProblem = reviewArtifactStorageProblem(watch)
    if (storageProblem) return storageProblem
    try {
      const identity = reviewArtifactIdentity(artifact.privatePath)
      if (identity.sha256 !== artifact.sha256) return 'hash do artefato imutável mudou'
      return undefined
    } catch {
      return 'artefato imutável do review não está mais legível'
    }
  }

  function reviewArtifactStorageProblem(watch: PhaseWatch): string | undefined {
    const artifact = watch.reviewArtifact
    if (!artifact) return undefined
    try {
      const absolutePath = resolve(artifact.privatePath)
      const relativePath = relative(resolve(reviewEvidenceRoot), absolutePath)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return 'artefato imutável saiu do storage privado autorizado'
      }
      if (statSync(absolutePath).size !== artifact.bytes) {
        return 'tamanho do artefato imutável mudou'
      }
      return undefined
    } catch {
      return 'artefato imutável do review não está mais legível'
    }
  }

  function cleanupReviewArtifact(watch: PhaseWatch): void {
    if (!watch.reviewArtifact) return
    try {
      const absolutePath = resolve(watch.reviewArtifact.privatePath)
      const relativePath = relative(resolve(reviewEvidenceRoot), absolutePath)
      if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) unlinkSync(absolutePath)
    } catch {
      // sweep do runtime remove resíduos após crash
    }
  }

  function readReviewArtifactChunk(
    watch: PhaseWatch,
    offset: number,
    _maxBytes = 32 * 1024
  ): string {
    const artifact = watch.reviewArtifact
    if (!artifact) return 'evidência privada indisponível nesta rodada'
    const problem = reviewArtifactStorageProblem(watch)
    if (problem) return `evidência privada recusada: ${problem}`
    return readAuthenticatedReviewEvidenceChunk(artifact, offset)
  }

  class PhaseWatchRegistry extends Map<string, PhaseWatch> {
    override set(taskId: string, watch: PhaseWatch): this {
      const previous = this.get(taskId)
      if (
        previous?.reviewArtifact &&
        previous.reviewArtifact.privatePath !== watch.reviewArtifact?.privatePath
      ) {
        cleanupReviewArtifact(previous)
      }
      return super.set(taskId, watch)
    }

    override delete(taskId: string): boolean {
      const watch = this.get(taskId)
      if (watch) cleanupReviewArtifact(watch)
      return super.delete(taskId)
    }

    /** Remove só a indexação durante a transação do report; advancePhase
     * continua dono do artefato até aceitar ou restaurar a rodada. */
    detach(taskId: string): boolean {
      return super.delete(taskId)
    }
  }
  const phaseWatches = new PhaseWatchRegistry()
  const phaseLaunches = new PhaseLaunchGuard()
  const phaseLaunchCapacity = new PhaseLaunchCapacityGuard()
  // LOCK DE TRANSIÇÃO POR CARD (Fase 2, docs/FASE2_PLANO.md §3): a partir do
  // F2-c4 todo entrante de veredito/transição adquire ANTES do detach — a
  // idempotência "quem chega primeiro deleta o watch" vira "quem SEGURA O
  // LOCK deleta o watch". Contenda real (alguém recusado/esperando) é
  // exatamente a corrida que o lock existe para pegar — vai à caixa-preta.
  const phaseTransitions = new PhaseTransitionLock((info) => {
    blackbox.record({
      cat: 'phase',
      event: 'phase-transition-contention',
      actor: 'harness',
      ids: { projectId: info.projectId, taskId: info.taskId },
      reason: `${info.waiterLabel} ${
        info.refused ? 'foi recusado' : 'entrou na fila'
      } — o card está em transição sob ${info.holderLabel}`
    })
  })
  /** Ocupação REAL do projeto (§7.6 do mapa): fases com watch + cards em
   *  transição (lock tomado, watch detached). Card com watch E lock conta UMA
   *  vez; `excludeTaskId` tira o próprio card do entrante que já segura o
   *  lock (respawn de boot) para não se contar como ocupação. */
  function phaseOccupancy(projectId: string, excludeTaskId?: string): number {
    let count = 0
    for (const watch of phaseWatches.values()) {
      if (watch.projectId === projectId && watch.taskId !== excludeTaskId) count++
    }
    for (const held of phaseTransitions.snapshot()) {
      if (held.projectId !== projectId) continue
      if (held.taskId === excludeTaskId) continue
      if (phaseWatches.has(held.taskId)) continue
      count++
    }
    return count
  }

  function terminateTaskPhasePane(
    projectId: string,
    taskId: string,
    role: RunPhase
  ): void {
    if (role === 'qa') stopQaRuntime(taskId)
    for (const pane of hub
      .panesOf(projectId)
      .filter((candidate) => candidate.taskId === taskId && candidate.role === role)) {
      // Desregistre antes do kill: o report já consumiu esta fase, portanto o
      // onExit não pode reinterpretar o encerramento deliberado como crash.
      terminatePaneNow(projectId, pane.paneId)
    }
    closePhasePane(projectId, taskId, role)
  }

  // git no WORKER (task #2): o fingerprint varre a árvore inteira — era parte
  // do stall de abrir gate. As checagens moram em worktree.snapshotProblemFor
  // (fonte única): aqui viajam ao worker numa chamada só; advancePhase — sync
  // por contrato — chama a mesma função direto no main.
  async function taskSnapshotProblem(task: Task, cwd: string): Promise<string | undefined> {
    const dev = task.verification?.dev
    return gitOff(
      'snapshotProblemFor',
      cwd,
      { head: dev?.head, tree: dev?.tree, fingerprint: dev?.fingerprint, baseHead: dev?.baseHead },
      task.deliverable === 'code'
    )
  }

  function returnTaskToDevForSnapshotDrift(task: Task, reason: string): void {
    const verification = task.verification ?? { contractVersion: 1 as const }
    tasks.update(task.id, {
      status: 'backlog',
      feedback: `fotografia imutável invalidada: ${reason}`,
      activePhase: 'dev',
      phaseState: 'interrupted',
      phaseStartedAt: undefined,
      phaseResume: task.phaseSessions?.dev,
      integrationReceipt: undefined,
      verification: {
        ...verification,
        activeGate: undefined,
        review: undefined,
        qa: undefined
      }
    })
    hub.publish({
      projectId: task.projectId,
      missionId: task.missionId,
      kind: 'error',
      text: `os gates de "${task.title}" foram bloqueados: ${reason}. Os arquivos foram preservados; o dev deve conferir a diferença e reportar novamente para criar uma nova fotografia.`,
      actor: 'harness',
      urgent: true
    })
    if (ctx.uiSender && !ctx.uiSender.isDestroyed()) {
      ctx.uiSender.send('tasks:changed', task.projectId)
    }
    syncBoard(task.projectId)
  }

  const PHASE_ICON: Record<RunPhase, string> = { dev: '▶', review: '🧐 revisão:', qa: '🔎 QA:' }

  async function preparePhasePane(
    projectId: string,
    taskId: string,
    phase: RunPhase,
    devSeatId: string,
    devModel?: string,
    devEffort?: string,
    feedback?: string,
    launchToken?: PhaseLaunchToken
  ): Promise<DevPaneSpec | null> {
    // Fase 0 (atribuição de stall): wrapper fino — o corpo real está no Inner.
    return mainStalls.wrap(`preparePhasePane:${phase}`, taskId.slice(0, 8), () =>
      preparePhasePaneInner(
        projectId,
        taskId,
        phase,
        devSeatId,
        devModel,
        devEffort,
        feedback,
        launchToken
      )
    )
  }
  async function preparePhasePaneInner(
    projectId: string,
    taskId: string,
    phase: RunPhase,
    devSeatId: string,
    devModel?: string,
    devEffort?: string,
    feedback?: string,
    launchToken?: PhaseLaunchToken
  ): Promise<DevPaneSpec | null> {
    const project = projects.get(projectId)
    const task = tasks.list(projectId).find((t) => t.id === taskId)
    if (!project || !task) return null
    const phaseProjectMode = projectModeOf(projectId)
    try {
      ensureProjectSecurityBaseline(project.path, {
        installRepositoryAdapters: phaseProjectMode === 'greenfield',
        projectName: project.name
      })
    } catch (error) {
      // Existing projects keep their established flow under the system policy.
      if (phaseProjectMode === 'greenfield') {
        hub.publish({
          projectId,
          kind: 'error',
          text: `não abri a etapa ${phase}: não foi possível preparar a política local de segurança (${redactSensitiveText(error instanceof Error ? error.message : String(error))})`,
          actor: 'harness',
          urgent: true
        })
        return null
      }
    }
    if (phaseWatches.has(taskId)) return null
    if (
      phaseLaunches.isReserved(taskId) &&
      (!launchToken || !phaseLaunches.owns(taskId, launchToken))
    ) return null
    // MCP phases are opened through the renderer. Never persist "running"
    // before there is a live renderer able to acknowledge the pane request.
    if (!ctx.uiSender || ctx.uiSender.isDestroyed()) return null
    const planTask = planTaskForWorkTask(task)
    const executionMode = executionModeForTask(task)
    const delegationMode = normalizeDelegationMode(task.delegation, executionMode)
    const securityAssessment = assessMissionRisk({
      declaredRisk: planTask?.plan?.risk,
      surfaces: planTask?.plan?.riskSurfaces,
      texts: [
        task.title,
        task.description,
        task.briefing,
        ...(task.quests ?? []),
        feedback
      ]
    })
    const securityBlock = securityPromptForRole(
      phase === 'review' ? 'review' : phase === 'qa' ? 'qa' : 'dev',
      securityAssessment.surfaces
    )
    const sensitiveRuntime =
      securityAssessment.effectiveRisk === 'high' ||
      requiresManualSecurityValidation(securityAssessment.surfaces)
    const sensitiveAutoOk = securityWaiverOptions(projectId).sensitiveWaiverAllowed
    const effectiveSensitiveRuntime = effectiveSensitiveAccess(sensitiveRuntime, sensitiveAutoOk)
    const browserAvailable = paneBrowserAvailable(paneAccessProfile(phase), {
      sensitive: sensitiveRuntime,
      sensitiveAutoOk,
      strict: true,
      mcpReady: ctx.mcpPort !== 0,
      browserConfigured: Boolean(externalPlaywrightForPane())
    })
    const recoveringPhase = task.phaseState === 'interrupted' && task.activePhase === phase
    const retryingOriginalDev =
      phase === 'dev' && Boolean(feedback) && Boolean(task.phaseSessions?.dev)
    const persistedResume =
      recoveringPhase || retryingOriginalDev
        ? task.phaseSessions?.[phase] ??
          (task.phaseResume?.phase === phase ? task.phaseResume : undefined)
        : undefined
    // pasta do projeto sumiu (renomeada fora do app) — relocar antes de rodar
    if (!existsSync(project.path)) return null
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return null
    }
    let mission = task.missionId ? missions.get(task.missionId) : undefined
    if (task.missionId) mission = ensureMissionWorktree(task.missionId)
    const gitProject = hasGitCommit(project.path)
    if (
      task.missionId &&
      (!mission || mission.projectId !== projectId || !missionWorkspacePath(project.path, mission))
    ) {
      tasks.update(taskId, {
        status: phase === 'qa' ? 'qa' : phase === 'review' ? 'execucao' : 'backlog',
        activePhase: phase,
        phaseState: 'interrupted',
        feedback:
          'o isolamento Git da missão está ausente ou inconsistente; a fase foi preservada sem usar a branch principal'
      })
      hub.publish({
        projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `a fase ${phase} de "${task.title}" foi bloqueada: não consegui provar a branch isolada da missão`,
        actor: 'harness',
        urgent: true
      })
      return null
    }

    // Gates: a LANE 'qa' do plano APROVADO é contrato (bug real 2026-07-29: o
    // usuário aprovou QA em opus[1m] e o gate abriu em Fable 5 — só a política
    // era lida e, vazia, o model ia a undefined = default do seat).
    // Cadeia do REVIEW (gate 1): reviewer de código configurado na página ✦
    // geral (maestroStore.reviewer*, 2026-07-30) > lane do plano > política
    // 'qa' > seat/modelo do dev. Cadeia do QA (gate 2): lane > política > dev.
    let seat = seats.get(devSeatId)
    let model = devModel
    let gateEffort: string | undefined
    if (phase !== 'dev') {
      const pmState = maestro.get(projectId)
      const revSeat =
        phase === 'review' && pmState.reviewerSeatId
          ? seats.get(pmState.reviewerSeatId)
          : undefined
      const planTask = task.missionId
        ? tasks
            .list(projectId)
            .find((t) => t.kind === 'plan' && t.missionId === task.missionId && t.plan?.approvedAt)
        : undefined
      const lane = planTask?.plan?.lanes.find((l) => l.dept === 'qa')
      const pol = policies.get(projectId)['qa']
      const slot = task.effort === 'pesada' ? pol?.heavy : pol?.light
      const laneSeat = lane?.seatId ? seats.get(lane.seatId) : undefined
      const slotSeat = slot?.seatId ? seats.get(slot.seatId) : undefined
      seat = revSeat ?? laneSeat ?? slotSeat ?? seat
      // modelo/effort seguem a MESMA origem do seat escolhido; fallback de
      // modelo só quando o gate ficou no próprio seat do dev (modelo de um
      // seat não vale noutro)
      model = revSeat
        ? pmState.reviewerModel || undefined
        : ((laneSeat ? lane?.model || undefined : undefined) ??
          (slotSeat ? slot?.model || undefined : undefined) ??
          (seat === seats.get(devSeatId) ? devModel : undefined))
      gateEffort = revSeat
        ? pmState.reviewerEffort || undefined
        : laneSeat
          ? lane?.effort || undefined
          : undefined
    }
    // Retomar uma conversa exige o MESMO provedor e o MESMO diretório de
    // credenciais. Preferimos o seat persistido da fase; se ele deixou de
    // existir, abrimos uma conversa nova e preservamos arquivos/transcript.
    let resumable = persistedResume
    if (resumable) {
      const resumeSeat = seats.get(resumable.seatId)
      if (resumeSeat?.cli === resumable.cli) {
        seat = resumeSeat
        model = resumable.model
        if (phase !== 'dev') gateEffort = resumable.effort
      } else {
        resumable = undefined
      }
    }
    // TETO DE CUSTO DO RESUME (decisão do usuário, 2026-08-06: retomar um dev
    // Fable com ~700k de janela custou ~10% do limite da conta SÓ para reler
    // a própria conversa — "extremamente inviável" em escala): o resume
    // reprocessa o histórico INTEIRO como input no 1º turno e reinício de
    // app/dia seguinte nunca tem cache quente. Acima do teto, a conversa não
    // é retomada: o pane nasce fresco sobre o trabalho preservado (o prompt
    // de recovery já manda inspecionar transcript/git). A conversa é
    // descartável por desenho — worktree/transcript/PLAN são a verdade.
    const RESUME_CONTEXT_BUDGET_TOKENS = 150_000
    if (
      resumable?.lastContextTokens &&
      resumable.lastContextTokens > RESUME_CONTEXT_BUDGET_TOKENS
    ) {
      blackbox.record({
        cat: 'phase',
        event: 'resume-skipped-cost',
        actor: 'harness',
        ids: { projectId, missionId: task.missionId, taskId, phase, role: phase },
        reason: `conversa da fase ${phase} com ~${Math.round(resumable.lastContextTokens / 1000)}k tokens de contexto — resume custaria o replay integral; pane nasce fresco sobre o trabalho preservado`,
        detail: { lastContextTokens: resumable.lastContextTokens, budget: RESUME_CONTEXT_BUDGET_TOKENS }
      })
      hub.publish({
        projectId,
        missionId: task.missionId,
        kind: 'info',
        text: `a fase ${phase} de "${task.title}" NÃO retomou a conversa antiga (~${Math.round(resumable.lastContextTokens / 1000)}k tokens — o replay custaria uma fatia real do limite da conta): o pane nasceu fresco sobre o worktree e o transcript preservados. É economia deliberada, não perda de trabalho`,
        actor: 'harness'
      })
      resumable = undefined
    }
    if (resumable?.cli === 'codex') {
      // CODEX RESUME EM FASE: DUAS EVIDÊNCIAS CONTRADITÓRIAS, VENCE O APP.
      // A sonda isolada (probe-codex-resume-mcp.mjs, 2026-08-04, 0.146.0)
      // provou `codex resume` nascendo COM MCP — mas a reabilitação recaiu NO
      // MESMO DIA no app real (card Sincronizar, pane c9bd5a2a: respawn via
      // resume trabalhou a fase inteira SEM nenhuma requisição autenticada;
      // report-guard-degraded-no-mcp salvou o fluxo pelo marcador .done).
      // Algo do caminho do app (PTY/PowerShell/env/config por pane) difere da
      // sonda (spawn node-pty direto). Até uma sonda que reproduza o CAMINHO
      // EXATO do app explicar a diferença, fase codex interrompida respawna
      // FRESCA sobre o trabalho preservado — spawn fresco conecta sempre.
      resumable = undefined
    }
    if (!seat) return null
    seats.preseed(seat)

    const runsDir = join(project.path, '.synkora', 'runs')
    mkdirSync(runsDir, { recursive: true })
    const recoveredHelperLogs: string[] = []
    if (recoveringPhase || retryingOriginalDev) {
      recoveredHelperLogs.push(
        ...storedHelperRecoveries(projectId)
          .filter((entry) => entry.record.taskId === taskId)
          .map((entry) => entry.relativePath)
      )
    }
    // Tarefa de missão: o worktree nasce DA BRANCH DA MISSÃO (e o merge final
    // volta para ela) — a base só vê a missão na integração.
    const worktree = gitProject
      ? await timedTaskWorktree(
          project.path,
          join(app.getPath('userData'), 'worktrees', projectId),
          taskId,
          mission?.branch
        )
      : null
    if (gitProject && !worktree) {
      tasks.update(taskId, {
        status: phase === 'qa' ? 'qa' : phase === 'review' ? 'execucao' : 'backlog',
        activePhase: phase,
        phaseState: 'interrupted',
        feedback:
          'não foi possível criar/reanexar o worktree isolado; a fase não será executada na branch compartilhada'
      })
      hub.publish({
        projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `worktree isolado indisponível para "${task.title}"; a fase ${phase} foi bloqueada sem tocar na branch compartilhada`,
        actor: 'harness',
        urgent: true
      })
      return null
    }
    const cwd = worktree?.dir ?? project.path
    if (phase !== 'dev' && task.deliverable === 'code') {
      if (!worktree) {
        returnTaskToDevForSnapshotDrift(
          task,
          'gate de código exige um worktree Git isolado; execução direta não é verificável'
        )
        return null
      }
      const snapshotProblem = await taskSnapshotProblem(task, cwd)
      if (snapshotProblem) {
        returnTaskToDevForSnapshotDrift(task, snapshotProblem)
        return null
      }
    }
    let immutableReviewerEvidence: ReturnType<typeof immutableReviewDiff>
    let immutableReviewerArtifact: PhaseWatch['reviewArtifact'] | undefined
    let immutableReviewerDelivered = task.verification?.dev
    if (phase === 'review' && worktree && task.deliverable === 'code') {
      const delivered = task.verification?.dev
      const inheritedGateRound = task.gateRound?.phase === 'review' ? task.gateRound : undefined
      const inheritedRejectedHead = inheritedGateRound?.rejectedHead
      const reviewBaseHead = inheritedRejectedHead ?? delivered?.baseHead
      const currentReviewNote = task.gateNotes?.review ?? ''
      const inheritedRulingChanged = Boolean(
        inheritedGateRound &&
          (inheritedGateRound.gateNotesAtRejection === undefined
            ? currentReviewNote.trim().length > 0
            : inheritedGateRound.gateNotesAtRejection !== JSON.stringify(currentReviewNote))
      )
      // FOTOGRAFIA DEGENERADA (base == entrega): o diff seria vazio por
      // construção e o Reviewer nasceria sem objeto — o caso real de 01/08.
      // O guard de entrega vazia impede isso de nascer; aqui cobrimos o
      // estado LEGADO já persistido e qualquer corrida futura.
      if (reviewBaseHead && reviewBaseHead === delivered?.head && !inheritedRulingChanged) {
        returnTaskToDevForSnapshotDrift(
          task,
          inheritedRejectedHead
            ? 'a nova rodada não contém delta desde o head rejeitado; a lista fechada ainda não foi corrigida'
            : 'a fotografia do dev é degenerada (base == entrega): não há diff para revisar. Ou a entrega foi vazia, ou o trabalho já está na branch da missão (integrado por fora) — nesse caso NÃO re-execute o card: remova-o com delete_task ou conclua o plano sem ele'
        )
        return null
      }
      if (
        reviewBaseHead &&
        delivered?.head &&
        !(await gitOff('immutableReviewRangeValid', cwd, reviewBaseHead, delivered.head))
      ) {
        returnTaskToDevForSnapshotDrift(
          task,
          inheritedRejectedHead
            ? 'o head rejeitado não é ancestral da nova entrega; não existe delta SHA-pinado seguro para retomar a lista fechada'
            : 'o range base..entrega do reviewer não é um par de commits ancestral verificável'
        )
        return null
      }
      immutableReviewerEvidence =
        reviewBaseHead && delivered?.head
          ? await gitOff('immutableReviewDiff', cwd, reviewBaseHead, delivered.head)
          : undefined
      if (delivered && reviewBaseHead && immutableReviewerEvidence) {
        immutableReviewerDelivered = {
          ...delivered,
          baseHead: reviewBaseHead,
          changedPaths: immutableReviewerEvidence.changedPaths
        }
      }
      if (immutableReviewerEvidence?.mode === 'local') {
        try {
          immutableReviewerArtifact = materializeReviewDiffArtifact(
            cwd,
            taskId,
            immutableReviewerEvidence
          )
        } catch {
          immutableReviewerArtifact = undefined
        }
        if (!immutableReviewerArtifact) {
          returnTaskToDevForSnapshotDrift(
            task,
            'o backend não conseguiu materializar o patch imutável grande para o reviewer read-only'
          )
          return null
        }
      }
      // Caixa-preta: o range e o tamanho do diff imutável entregue ao Reviewer.
      // Diff VAZIO com range degenerado (base == head) é exatamente o caso que
      // cegou um gate em 01/08 — precisa aparecer como evidência, nunca como
      // silêncio.
      blackbox.record({
        cat: 'git',
        event: 'immutable-diff',
        ids: {
          projectId,
          missionId: task.missionId,
          taskId,
          phase: 'review'
        },
        evidence: reviewBaseHead
          ? `${reviewBaseHead.slice(0, 12)}..${delivered?.head?.slice(0, 12) ?? '?'}`
          : 'sem fotografia do dev',
        detail: {
          bytes: immutableReviewerEvidence?.text.length ?? 0,
          truncated: immutableReviewerEvidence?.truncated ?? false,
          mode: immutableReviewerEvidence?.mode,
          degenerateRange: Boolean(
            reviewBaseHead && reviewBaseHead === delivered?.head
          ),
          waiverOnlyRound: Boolean(
            reviewBaseHead && reviewBaseHead === delivered?.head && inheritedRulingChanged
          )
        },
        err: immutableReviewerEvidence ? undefined : 'diff imutável não materializado'
      })
      if (!immutableReviewerEvidence) {
        returnTaskToDevForSnapshotDrift(
          task,
          'o backend não conseguiu materializar o diff imutável para o reviewer'
        )
        return null
      }
      // Entrega maior que o teto inline NÃO devolve mais o card (caso real
      // 2026-08-04: design system legítimo de ~120k levava "divida a entrega",
      // conselho impossível): o modo 'local' instrui o gate a ler o patch pelo
      // range SHA-pinado, imutável por definição — nenhum tamanho bloqueia.
    }
    let qaDeliverySnapshotBlock = ''
    if (phase === 'qa' && worktree && task.deliverable === 'code') {
      const delivered = task.verification?.dev
      const inheritedGateRound = task.gateRound?.phase === 'qa' ? task.gateRound : undefined
      const inheritedRejectedHead = inheritedGateRound?.rejectedHead
      const qaBaseHead = inheritedRejectedHead ?? delivered?.baseHead
      const currentQaNote = task.gateNotes?.qa ?? ''
      const inheritedRulingChanged = Boolean(
        inheritedGateRound &&
          (inheritedGateRound.gateNotesAtRejection === undefined
            ? currentQaNote.trim().length > 0
            : inheritedGateRound.gateNotesAtRejection !== JSON.stringify(currentQaNote))
      )
      if (qaBaseHead && qaBaseHead === delivered?.head && !inheritedRulingChanged) {
        returnTaskToDevForSnapshotDrift(
          task,
          inheritedRejectedHead
            ? 'a nova rodada de QA não contém commit nem ruling novo desde o head rejeitado'
            : 'a fotografia do QA é degenerada (base == entrega)'
        )
        return null
      }
      if (
        !qaBaseHead ||
        !delivered?.head ||
        !(await gitOff('immutableReviewRangeValid', cwd, qaBaseHead, delivered.head))
      ) {
        returnTaskToDevForSnapshotDrift(
          task,
          inheritedRejectedHead
            ? 'o QA retomado não recebeu um delta SHA-pinado válido desde o head rejeitado'
            : 'o QA não recebeu um snapshot SHA-pinado válido da entrega'
        )
        return null
      }
      const qaChangedPaths = await gitOff(
        'immutableReviewChangedPaths',
        cwd,
        qaBaseHead,
        delivered.head
      )
      if (!qaChangedPaths) {
        returnTaskToDevForSnapshotDrift(
          task,
          'o backend não conseguiu enumerar o blast radius SHA-pinado para o QA'
        )
        return null
      }
      qaDeliverySnapshotBlock = buildQaDeliverySnapshotBlock({
        baseHead: qaBaseHead,
        head: delivered.head,
        changedPaths: qaChangedPaths
      })
    }
    const routingText = [
      task.title,
      task.description,
      task.briefing,
      ...(task.quests ?? []),
      task.feedback,
      feedback
    ]
      .filter(Boolean)
      .join('\n')
    const uiWork = classifyTaskUiWork(task, feedback)

    // QA DE VERDADE, VERSÃO FINAL (decisão do usuário, 2026-08-06 — "não é só
    // o próprio QA subir? que dificuldade"): SEM pré-aquecimento no harness.
    // O pane do QA nasce NA HORA (fim do "Electron abre, morre, e o QA chega
    // depois") e o PRÓPRIO QA sobe o runtime pela tool runtime_control — a
    // chamada espera a URL e a devolve na resposta. O harness segue dono do
    // processo (QA sem shell; runtime morre com o pane).
    let qaRuntimeBlock = ''
    if (
      phase === 'qa' &&
      uiWork &&
      browserAvailable &&
      !effectiveSensitiveRuntime &&
      worktree &&
      detectRuntimeScript(cwd)
    ) {
      const qaPortMapLine = formatPortMap(harnessPortsInUse(projectId))
      // REDE DE SEGURANÇA DO RESUME (CHECK 14, 2026-08-07): pane de QA
      // RESUMADO nasce comprovadamente SEM a tool runtime_control (8/8 panes
      // no journal do dia; todo pane FRESCO tem — variante claude da
      // armadilha codex-resume-sem-MCP; causa exata pendente de sonda). No
      // caminho resumado o HARNESS sobe o runtime e entrega a URL no prompt —
      // o QA vê o produto sem depender da tool. Caminho fresco segue
      // self-service (decisão F6.8h do dono, intacta).
      let resumedRuntimeNote = ''
      if (resumable) {
        const runtimeScript = detectRuntimeScript(cwd)
        const liveRuntime = qaRuntimeOf(taskId)
        if (liveRuntime?.url) {
          resumedRuntimeNote = qaRuntimeAlreadyRunningNote(liveRuntime.url)
        } else if (runtimeScript) {
          const started = await startQaRuntime(taskId, cwd, runtimeScript)
          // A rede de segurança era CEGA (caso real 2026-08-07: QA reclamou de
          // runtime ausente e o journal não dizia se o harness chegou a subir).
          blackbox.record({
            cat: 'phase',
            event: 'qa-runtime-harness-start',
            actor: 'harness',
            ids: { projectId, missionId: task.missionId, taskId, phase, role: phase },
            reason: started.url
              ? `runtime subido pelo harness para o QA resumado: ${started.url}`
              : `runtime NÃO subiu para o QA resumado: ${(started.error ?? 'sem detalhe').slice(0, 260)}`
          })
          resumedRuntimeNote = started.url
            ? qaRuntimeHarnessStartedNote(started.url)
            : qaRuntimeHarnessFailedNote(started.error)
        }
      }
      qaRuntimeBlock = buildQaRuntimeBlock({
        resumedRuntimeNote,
        portMapLine: qaPortMapLine
      })
    }
    const logFile = join(runsDir, `${taskId}.md`)
    const marker =
      phase === 'dev' ? join(runsDir, `${taskId}.done`) : join(runsDir, `${taskId}.${phase}.verdict`)
    // MATERIAIS DENTRO DO WORKTREE (caso real 2026-08-06: o reviewer codex —
    // sandbox read-only PRESO ao worktree — reportou DESIGN.md e transcript
    // "inexistentes": o briefing citava caminhos ABSOLUTOS do projeto, que o
    // sandbox não alcança e cujo acento (GESTÃO) ainda quebrava no PS 5.1).
    // Cópia snapshot para <worktree>/.synkora: caminho RELATIVO, sem acento,
    // igual para claude e codex; .synkora já está fora do fingerprint/diff.
    let workspaceMaterialsNote = ''
    if (worktree) {
      try {
        const wtRuns = join(cwd, '.synkora', 'runs')
        mkdirSync(wtRuns, { recursive: true })
        const copied: string[] = []
        const designSrc = join(project.path, '.synkora', 'DESIGN.md')
        if (existsSync(designSrc)) {
          copyFileSync(designSrc, join(cwd, '.synkora', 'DESIGN.md'))
          copied.push('.synkora/DESIGN.md (design language)')
        }
        if (existsSync(logFile)) {
          copyFileSync(logFile, join(wtRuns, `${taskId}.md`))
          copied.push(`.synkora/runs/${taskId}.md (this card's transcript so far)`)
        }
        if (copied.length > 0) {
          workspaceMaterialsNote = buildWorkspaceMaterialsNote(copied)
        }
      } catch {
        // cópia é conveniência; os caminhos do projeto continuam citados
      }
    }
    try {
      ensureProjectRuntimeWritable(projectId)
      unlinkSync(marker)
    } catch {
      // sem marcador antigo
    }

    try {
      ensureProjectRuntimeWritable(projectId)
      appendFileSync(
        logFile,
        `\n— FASE ${phase.toUpperCase()} · ${new Date().toISOString()} · seat ${seat.name} (${seat.cli}) · modelo ${model || 'padrão'}${worktree ? ` · branch ${worktree.branch}` : ''} —\n`,
        'utf-8'
      )
    } catch {
      // transcript é best-effort
    }

    const persistedGate = task.verification?.activeGate
    const reusingGateBaseline =
      phase !== 'dev' && persistedGate?.phase === phase
        ? persistedGate
        : undefined
    const gateBaselineFingerprint =
      phase === 'dev'
        ? undefined
        : task.deliverable === 'code' && worktree
          ? task.verification?.dev?.fingerprint
          : reusingGateBaseline?.baselineFingerprint ??
            (await gitOff('gitVisibleWorktreeFingerprint', cwd))
    const gateStartedAt =
      phase === 'dev'
        ? undefined
        : reusingGateBaseline?.startedAt ?? new Date().toISOString()

    // EFFORT DO EXECUTOR É CONTRATO DO USUÁRIO (caso real 2026-08-04: o pane
    // do dev morreu e a reabertura veio SEM o effort escolhido — executor caiu
    // no default do modelo): a primeira abertura CARIMBA o effort no card
    // (task.devEffort) e TODA reabertura reusa o carimbo quando o chamador
    // não trouxer um valor novo. O usuário decide o effort, nunca o acaso.
    const effectiveDevEffort = devEffort ?? task.devEffort
    const plannedPaneId = randomUUID()
    const phaseRun = randomUUID()
    phaseWatches.set(taskId, {
      projectId,
      taskId,
      phase,
      devSeatId,
      devModel,
      devEffort: effectiveDevEffort,
      cwd,
      worktree,
      logFile,
      marker,
      paneId: plannedPaneId,
      gateBaselineFingerprint,
      gateStartedAt,
      reviewArtifact: immutableReviewerArtifact,
      uiWork,
      browserAvailable,
      createdAt: Date.now()
    })

    const blockForMissingFrontendStandard = (reason: string): void => {
      if (phase === 'qa') stopQaRuntime(taskId)
      phaseWatches.delete(taskId)
      releasePaneSkillLease(plannedPaneId)
      releasePaneSkillPlan(plannedPaneId)
      const feedback = `${reason}; a fase foi interrompida antes de abrir o pane`
      tasks.update(taskId, {
        status: phase === 'qa' ? 'qa' : phase === 'review' ? 'execucao' : 'backlog',
        activePhase: phase,
        phaseState: 'interrupted',
        feedback
      })
      blackbox.record({
        cat: 'pane',
        event: 'required-frontend-skill-missing',
        actor: 'harness',
        ids: { projectId, missionId: task.missionId, taskId, phase, role: phase },
        reason: feedback
      })
      hub.publish({
        projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `não abri a fase ${phase} de "${task.title}": ${reason}`,
        actor: 'harness',
        urgent: true
      })
      if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', projectId)
      syncBoard(projectId)
    }

    // Plano mínimo por fase. Disponibilidade no catálogo não equivale a
    // injeção: o workspace recebe apenas o contrato/método/técnica selecionados
    // para este pane, e QA usa uma régua independente da criação.
    const installedSkillIds = new Set(skillsLib.installedIds())
    if (task.affectsUi === false && uiWork) {
      blockForMissingFrontendStandard('affectsUi=false contradiz a superficie visual descrita no card')
      return null
    }
    const routedExplicitSkillIds = task.skills ?? []
    const routedExplicitAgentIds = task.agents ?? []
    if (routedExplicitSkillIds.length > 1 || routedExplicitAgentIds.length > 1) {
      blockForMissingFrontendStandard(
        'card legado possui mais de uma skill técnica ou persona; ajuste o card para uma seleção única antes de executar'
      )
      return null
    }
    const rejectedExplicitIds = [
      ...new Set([...routedExplicitSkillIds, ...routedExplicitAgentIds])
    ]
      .filter((skillId) => {
        const definition = skillsLib.byId(skillId)
        const expectedKind = routedExplicitAgentIds.includes(skillId) ? 'agent' : 'skill'
        return (
          !installedSkillIds.has(skillId) ||
          !definition ||
          definition.kind !== expectedKind ||
          !definition.depts.includes(task.department) ||
          (expectedKind === 'skill' && definition.adapter === 'synkora-native')
        )
      })
    if (rejectedExplicitIds.length > 0) {
      blockForMissingFrontendStandard(
        `seleção explícita indisponível, bloqueada ou corrompida: ${rejectedExplicitIds.join(', ')}`
      )
      return null
    }
    const phaseCapabilities: SkillCapability[] =
      phase === 'dev'
        ? ['read', 'write', 'shell', ...(browserAvailable ? ['browser' as const] : [])]
        : ['read', ...(phase === 'qa' && browserAvailable ? ['browser' as const] : [])]
    const phaseSkillSelection = selectPhaseSkillPlan({
      defs: skillsLib.definitions(),
      isInstalled: (id) => installedSkillIds.has(id),
      department: task.department,
      phase,
      taskText: routingText,
      explicitSkillIds: routedExplicitSkillIds,
      explicitAgentIds: routedExplicitAgentIds,
      executionMode,
      delegationMode,
      uiCard: uiWork,
      securitySensitive: sensitiveRuntime,
      availableCapabilities: phaseCapabilities
    })
    if (phaseSkillSelection.incompatibilities.length > 0) {
      const details = phaseSkillSelection.incompatibilities.map((issue) =>
        issue.reason === 'phase'
          ? `${issue.id} não permite a fase ${phase}`
          : `${issue.id} exige ${issue.missingCapabilities?.join(', ') || 'capacidade indisponível'}`
      )
      blockForMissingFrontendStandard(
        `o método obrigatório é incompatível com as capacidades reais do pane: ${details.join('; ')}`
      )
      return null
    }
    const skillIds = phaseSkillSelection.skillIds
    const agentIds = phaseSkillSelection.agentIds
    // Skills não entram mais nos diretórios autodetectados pelo CLI. O pane
    // recebe o corpo somente por receipt/activate_skill, o que preserva a
    // independência entre dev, review, QA e helpers no mesmo worktree.
    let preparedSkills: Awaited<ReturnType<typeof prepareSkillPlanInputs>>
    const injAgents: SkillDef[] = []
    const missingAgents: string[] = []
    try {
      await syncPaneSkillLease(plannedPaneId, cwd, [])
      preparedSkills = await prepareSkillPlanInputs(skillIds, (skillId) => ({
        operation:
          skillId === IMPECCABLE_SKILL_ID
            ? phaseSkillSelection.impeccableOperation ?? 'polish'
            : skillId === SYNKORA_FRONTEND_STANDARD_ID
              ? phase === 'qa'
                ? 'verify'
                : phaseSkillSelection.uiOperation ?? 'polish'
              : skillId === SYNKORA_UI_QA_ID
                ? 'review'
                : phase === 'review'
                  ? 'review'
                  : phase === 'qa'
                    ? 'verify'
                    : 'apply',
        reason:
          skillId === SYNKORA_FRONTEND_STANDARD_ID
            ? 'ui.contract'
            : skillId === SYNKORA_UI_QA_ID
              ? 'ui.independent-qa'
              : skillId === IMPECCABLE_SKILL_ID
                ? `ui.${phaseSkillSelection.impeccableOperation ?? 'polish'}`
                : `${phase}.technique`,
        required: true
      }))
      for (const agentId of agentIds) {
        const definition = skillsLib.byId(agentId)
        if (!definition || definition.kind !== 'agent' || !(await skillsLib.agentBody(agentId))) {
          missingAgents.push(agentId)
        } else {
          injAgents.push(definition)
        }
      }
    } catch {
      blockForMissingFrontendStandard('falha ao preparar o plano privado de skills')
      return null
    }
    const injSkills = preparedSkills.definitions
    const missingPlanned = [...new Set([...preparedSkills.missing, ...missingAgents])]
    if (missingPlanned.length > 0) {
      blockForMissingFrontendStandard(
        `o plano selecionado não pôde ser preparado integralmente: ${missingPlanned.join(', ')}`
      )
      return null
    }
    const mandatoryMissing = missingMandatoryUiPhaseSkills(
      injSkills.map((skill) => skill.id),
      task.department,
      phase,
      uiWork
    )
    if (mandatoryMissing.length > 0) {
      blockForMissingFrontendStandard(
        `o contrato obrigatório da fase não entrou no workspace: ${mandatoryMissing.join(', ')}`
      )
      return null
    }
    const plannedRuntime = skillRuntime.planPane({
      paneId: plannedPaneId,
      phase,
      phaseRun,
      skills: preparedSkills.inputs
    })
    if (!plannedRuntime.ok) {
      blockForMissingFrontendStandard('não foi possível registrar o plano rastreável de skills')
      return null
    }
    skillPlanScopes.set(plannedPaneId, {
      phase,
      phaseRun,
      agentIds: phaseSkillSelection.agentIds,
      taskId,
      projectId
    })
    const usageNow = new Date().toISOString()
    const usageRun = {
      phase,
      phaseRun,
      updatedAt: usageNow,
      runStatus: 'active' as const,
      skills: plannedRuntime.plan.receipts.map((receipt) => ({
        receiptId: receipt.receiptId,
        id: receipt.skillId,
        operation: receipt.operation,
        version: receipt.version,
        fingerprint: receipt.fingerprint,
        status: 'planned' as const
      }))
    }
    const priorUsage = task.skillUsage
    const priorHistory = priorUsage?.history ?? (priorUsage ? [{
      phase: priorUsage.phase,
      phaseRun: priorUsage.phaseRun,
      updatedAt: priorUsage.updatedAt,
      runStatus: priorUsage.runStatus ?? 'interrupted' as const,
      skills: priorUsage.skills
    }] : [])
    tasks.update(taskId, {
      skillUsage: {
        ...usageRun,
        history: [
          ...priorHistory
            .filter((run) => run.phaseRun !== phaseRun)
            .map((run) => ({
              ...run,
              runStatus: run.runStatus === 'active' ? 'interrupted' as const : run.runStatus
            })),
          usageRun
        ]
      }
    })
    const injectedById = new Map(injSkills.map((skill) => [skill.id, skill]))
    const skillsBlock = buildSkillsBlock({
      plannedSkills: plannedRuntime.plan.receipts.map((receipt) => ({
        ...(injectedById.get(receipt.skillId) as SkillDef),
        receiptId: receipt.receiptId,
        operation: receipt.operation,
        reason: receipt.reason,
        required: receipt.required
      }))
    })
    // Persona selecionada fica como id de delegate.agent; não é materializada
    // em diretório compartilhado nem depende do CLI do pane atual.
    const agentsBlock = buildAgentsBlock({ injAgents, cli: seat.cli })

    // Prompts em INGLÊS (rendem melhor); respostas SEMPRE em PT-BR — os
    // vereditos aprovada/reprovada são PROTOCOLO e ficam em PT.
    const structuredSecurityReviewRequired =
      phase === 'review' &&
      (securityAssessment.effectiveRisk === 'high' ||
        requiresManualSecurityValidation(securityAssessment.surfaces)) &&
      // MODO LEVE (2026-08-04): reviewer sem o formulário estruturado extra
      !securityWaiverOptions(projectId).sensitiveWaiverAllowed
    const structuredReviewRule = buildStructuredReviewRule(
      structuredSecurityReviewRequired,
      securityAssessment.surfaces
    )
    const verdictRule = buildVerdictRule(structuredReviewRule)
    // Dev recebe browser + runner. Gates não recebem MCP externo enquanto o
    // browser não estiver atrás de um proxy com allowlist real.
    const browserHint = buildBrowserHint(phase, browserAvailable)
    const executionProfileBlock = buildExecutionProfileBlock({
      executionMode,
      delegationMode,
      questCount: task.quests?.length ?? 0
    })
    // O CONTEÚDO do prompt do dev é do MAESTRO (task.briefing, escrito por ele
    // no create_tasks — contextualizado, sem dicas genéricas). O harness só
    // anexa o CONTRATO técnico (report/fallback + feedback de reprovação).
    // Sem briefing (tarefa manual): título+descrição, cru.
    const devContract = buildDevContract({
      feedback,
      title: task.title,
      deptLabel: DEPT_NAME[task.department],
      uiWork,
      browserAvailable,
      executionMode,
      executionProfileBlock,
      browserHint,
      marker
    })
    // Quests são checklist, não contagem de ajudantes. A política persistida
    // no card decide se existe delegação e o backend impõe o teto do perfil.
    const questBlock = buildQuestBlock({ quests: task.quests, executionMode, delegationMode })
    // Lista fechada da rodada vigente (task.gateRound): pane NOVO de gate não
    // re-legisla — herda a lista da instituição (raiz da rodada 5 do caso
    // real 2026-08-05: o restart matou o gate vivo e o novo re-auditou tudo
    // com régua nova).
    const closedListBlock = buildClosedListBlock({ phase, gateRound: task.gateRound })
    const reviewDiffBlock = buildReviewDiffBlock({
      delivered: immutableReviewerDelivered,
      evidence: immutableReviewerEvidence
        ? { ...immutableReviewerEvidence, artifactAvailable: Boolean(immutableReviewerArtifact) }
        : undefined
    })
    // RODADA DE GATE É ATÔMICA (caso real 2026-08-06: mudança do dono
    // injetada no reviewer COM A ANÁLISE EM CURSO cruzou com o veredito e
    // gerou um segundo relatório por fora — duas listas circulando enquanto o
    // dev corrigia a primeira).
    const atomicRoundRule = buildAtomicRoundRule(phase)
    const assemblePhasePrompt = (
      currentGateNotes: typeof task.gateNotes,
      currentTaskFeedback: typeof task.feedback
    ): string => {
      const basePrompt = buildBasePrompt({
        phase,
        title: task.title,
        description: task.description,
        briefing: task.briefing,
        gates: task.gates,
        gateNotes: currentGateNotes,
        executionMode,
        logFile,
        skillsBlock: phase === 'dev' ? skillsBlock : '',
        agentsBlock: phase === 'dev' ? agentsBlock : '',
        questBlock,
        devContract,
        workspaceMaterialsNote,
        atomicRoundRule,
        reviewDiffBlock,
        qaDeliverySnapshotBlock,
        qaRuntimeBlock,
        browserHint,
        verdictRule,
        closedListBlock,
        gateSkillsBlock: phase === 'dev' ? '' : skillsBlock,
        gateAgentsBlock: ''
      })

      return buildPhasePrompt({
        phase,
        resumed: Boolean(resumable),
        recoveringPhase,
        retryingOriginalDev,
        feedback,
        taskFeedback: currentTaskFeedback,
        gateNotes: currentGateNotes,
        logFile,
        recoveredHelperLogs,
        basePrompt,
        activeSkillPlanBlock: skillsBlock,
        continuationEnvironmentBlock:
          phase === 'review'
            ? reviewDiffBlock
            : phase === 'qa'
              ? `${qaDeliverySnapshotBlock}${qaRuntimeBlock}${browserHint}`
              : browserHint
      })
    }

    // RE-SPAWN COM RESUME = PROMPT DELTA (caso real 2026-08-05: o pane do dev
    // voltou com a conversa INTEIRA via --resume e AINDA recebeu o briefing
    // completo por arquivo — redundância que gasta contexto e convida a
    // re-executar trabalho pronto; "o dev tem o contexto, não tem por que
    // mandar o briefing completo" — o usuário). Conversa retomada recebe SÓ o
    // delta; o briefing completo fica para conversa genuinamente nova. A
    // autocura de resume-fail (respawn sem --resume com o MESMO prompt) é
    // coberta pela instrução de ler o transcript preservado.
    let prompt = assemblePhasePrompt(task.gateNotes, task.feedback)

    // Checkpoint transacional: os awaits acima nao autorizam ressuscitar um
    // card removido, um watch substituido ou uma reserva que mudou de dono.
    const currentTaskBeforeArm = tasks.get(taskId)
    const currentWatchBeforeArm = phaseWatches.get(taskId)
    const launchStillOwned = launchToken
      ? phaseLaunches.owns(taskId, launchToken)
      : !phaseLaunches.isReserved(taskId)
    if (
      !currentTaskBeforeArm ||
      currentTaskBeforeArm.projectId !== projectId ||
      currentWatchBeforeArm?.paneId !== plannedPaneId ||
      currentWatchBeforeArm.phase !== phase ||
      !launchStillOwned
    ) {
      if (currentWatchBeforeArm?.paneId === plannedPaneId) phaseWatches.delete(taskId)
      if (phase === 'qa') stopQaRuntime(taskId)
      releasePaneSkillLease(plannedPaneId)
      releasePaneSkillPlan(plannedPaneId)
      blackbox.record({
        cat: 'phase',
        event: 'phase-prepare-cancelled',
        actor: 'harness',
        ids: {
          projectId,
          missionId: currentTaskBeforeArm?.missionId ?? task.missionId,
          taskId,
          paneId: plannedPaneId,
          phase,
          role: phase
        },
        reason: 'o card, o watch ou a reserva mudou durante a preparacao assincrona'
      })
      return null
    }

    if (phase !== 'dev') {
      const latestRound =
        currentTaskBeforeArm.gateRound?.phase === phase
          ? currentTaskBeforeArm.gateRound
          : undefined
      const latestDelivered = currentTaskBeforeArm.verification?.dev
      const latestBase = latestRound?.rejectedHead ?? latestDelivered?.baseHead
      const latestNote = currentTaskBeforeArm.gateNotes?.[phase] ?? ''
      const latestRulingChanged = Boolean(
        latestRound &&
          (latestRound.gateNotesAtRejection === undefined
            ? latestNote.trim().length > 0
            : latestRound.gateNotesAtRejection !== JSON.stringify(latestNote))
      )
      if (latestBase && latestBase === latestDelivered?.head && !latestRulingChanged) {
        phaseWatches.delete(taskId)
        if (phase === 'qa') stopQaRuntime(taskId)
        releasePaneSkillLease(plannedPaneId)
        releasePaneSkillPlan(plannedPaneId)
        returnTaskToDevForSnapshotDrift(
          currentTaskBeforeArm,
          `o ruling de ${phase} mudou durante o preparo e a rodada nao possui delta nem waiver vigente`
        )
        return null
      }
    }

    // `update_task` permite um patch somente de gateNotes enquanto a fase
    // esta em preparo. Releia essa excecao no ultimo ponto sincrono antes de
    // armar o pane: o ruling novo entra no prompt e um waiver removido nao
    // sobrevive por ter sido capturado antes de um await.
    if (
      JSON.stringify(currentTaskBeforeArm.gateNotes ?? {}) !==
      JSON.stringify(task.gateNotes ?? {})
    ) {
      prompt = assemblePhasePrompt(
        currentTaskBeforeArm.gateNotes,
        currentTaskBeforeArm.feedback
      )
      blackbox.record({
        cat: 'phase',
        event: 'phase-prompt-refreshed',
        actor: 'harness',
        ids: {
          projectId,
          missionId: currentTaskBeforeArm.missionId,
          taskId,
          paneId: plannedPaneId,
          phase,
          role: phase
        },
        reason: 'gateNotes mudou durante o preparo; prompt reconstruido antes de armar o pane'
      })
    }

    const phaseSessions = { ...(task.phaseSessions ?? {}) }
    if (resumable) phaseSessions[phase] = resumable
    else delete phaseSessions[phase]
    const verification = task.verification ?? { contractVersion: 1 as const }
    tasks.update(taskId, {
      status: phase === 'qa' ? 'qa' : 'execucao',
      activePhase: phase,
      phaseState: 'pending',
      phaseStartedAt: new Date().toISOString(),
      phaseResume: resumable,
      phaseSessions,
      verification:
        phase === 'dev'
          ? { ...verification, activeGate: undefined }
          : {
              ...verification,
              activeGate: {
                phase,
                startedAt: gateStartedAt as string,
                baselineFingerprint: gateBaselineFingerprint
              }
            },
      ...(phase === 'dev'
        ? {
            runSeat: seat.name,
            runModel: `${model || 'modelo padrão'}${effectiveDevEffort ? ` · ${effectiveDevEffort}` : ''}`,
            devEffort: effectiveDevEffort
          }
        : {})
    })
    if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', projectId)
    syncBoard(projectId)
    // Identidade no hub: o MCP sabe QUEM é este pane (projeto/tarefa/fase) e
    // os cliArgs já saem com permissões (bypass/accept) + config MCP.
    let armed: ReturnType<typeof armPane>
    try {
      armed = armPane(
        {
          paneId: plannedPaneId,
          projectId,
          role: phase,
          taskId,
          phase,
          cwd,
          seatId: seat.id,
          missionId: task.missionId
        },
        seat.cli,
        {
          strictMcp: true,
          configDir: seats.configDirOf(seat),
          sensitive: sensitiveRuntime
        }
      )
    } catch {
      blockForMissingFrontendStandard('falha ao armar o pane da fase')
      return null
    }
    const armedWatch = phaseWatches.get(taskId)
    if (armedWatch?.paneId === plannedPaneId && armedWatch.phase === phase) {
      armedWatch.paneId = armed.paneId
    } else {
      terminatePaneNow(projectId, armed.paneId)
      releasePaneSkillLease(plannedPaneId)
      releasePaneSkillPlan(plannedPaneId)
      return null
    }
    // Effort do EXECUTOR na fase dev; gate herda o effort da LANE 'qa' do
    // plano quando ela define (contrato aprovado pelo usuário).
    const cliArgs = [...armed.cliArgs]
    const phaseEffort = resumable?.effort ?? (phase === 'dev' ? effectiveDevEffort : gateEffort)
    if (phaseEffort) {
      if (seat.cli === 'claude') cliArgs.push('--effort', phaseEffort)
      else cliArgs.push('-c', `model_reasoning_effort="${phaseEffort}"`)
    }
    if (seat.cli === 'codex') {
      cliArgs.push('-c', codexDeveloperInstructions(securityBlock))
    }
    if (resumable) {
      if (seat.cli === 'claude') cliArgs.push('--resume', resumable.sessionId)
      // codex resume aceita só o UUID do rollout; ids vindos do backend de
      // painel carregam o prefixo 'codex-thread:' — strip inofensivo.
      else cliArgs.push('resume', resumable.sessionId.replace('codex-thread:', ''))
    }
    // CHECK 14, causa PROVADA em sonda (2026-08-07, probe-claude-qa-resume-mcp
    // R1–R10): o claude monta o catálogo de tools POR REQUEST e o request 1 do
    // turno sai ANTES do handshake MCP completar quando o prompt viaja no argv
    // — pane RESUMADO com prompt-delta curto chamava a tool MCP no request 1
    // (ele a conhece pela conversa carregada) e via "No such tool available"
    // MESMO com o catálogo servido logo depois. Frescos sempre escaparam por
    // acidente: o briefing-por-arquivo força uma leitura builtin e o catálogo
    // entra no request seguinte. A proteção acidental vira deliberada: prompt
    // de RESUME vai por arquivo com read-first — o round-trip da leitura dá ao
    // handshake o tempo que ele precisa. NUNCA voltar a mandar prompt de
    // resume inline. Issue upstream: docs/ISSUE_DRAFT_claude-code_mcp-first-turn.md.
    let deliveredPrompt = prompt
    if (resumable) {
      try {
        const resumePromptDir = join(cwd, '.synkora')
        mkdirSync(resumePromptDir, { recursive: true })
        const resumePromptFile = join(
          resumePromptDir,
          `prompt-resume-${armed.paneId.replace(/[^A-Za-z0-9._-]/g, '_')}.md`
        )
        // BOM: mesma lição do prompt-<paneId>.md do pty (PS 5.1 sem BOM
        // decodifica UTF-8 como ANSI); o Read do claude ignora BOM.
        writeFileSync(resumePromptFile, '﻿' + prompt, 'utf-8')
        deliveredPrompt = buildResumeReadFirstPrompt(resumePromptFile)
        blackbox.record({
          cat: 'phase',
          event: 'resume-prompt-via-file',
          actor: 'harness',
          ids: {
            projectId,
            missionId: task.missionId,
            taskId,
            paneId: armed.paneId,
            phase,
            role: phase
          },
          reason:
            'prompt de resume entregue por arquivo (read-first) para o handshake MCP vencer o request 1'
        })
      } catch {
        // sem disco: segue inline — comportamento antigo, janela conhecida
      }
    }
    const spec: DevPaneSpec = {
      paneId: armed.paneId,
      kind: seat.cli,
      seatId: seat.id,
      model: model || undefined,
      cwd,
      cliArgs,
      appendSystemPrompt: seat.cli === 'claude' ? securityBlock : undefined,
      initialPrompt: deliveredPrompt,
      logFile,
      title: `${PHASE_ICON[phase]} ${task.title.slice(0, 28)}${task.title.length > 28 ? '…' : ''}`,
      role: phase,
      missionId: task.missionId
    }
    livePaneSpecs.set(armed.paneId, { projectId, taskId, spec })
    closingPaneIds.delete(armed.paneId)
    return spec
  }

  function openPhasePane(watchSpec: DevPaneSpec, projectId: string, taskId: string): void {
    if (ctx.uiSender && !ctx.uiSender.isDestroyed())
      ctx.uiSender.send('panes:open', projectId, taskId, watchSpec)
    const task = tasks.get(taskId)
    hub.publish({
      projectId,
      missionId: task?.missionId,
      kind: 'pane-open',
      // paneId no evento: é assim que o orquestrador sabe COM QUEM falar
      // (notify_pane) sem precisar de list_panes toda hora
      text: `pane ${watchSpec.role} aberto para "${task?.title ?? taskId}" (paneId ${watchSpec.paneId} · seat ${seats.get(watchSpec.seatId)?.name ?? '?'}${watchSpec.model ? `, ${watchSpec.model}` : ''})`,
      actor: 'harness'
    })
  }

  function closePhasePane(projectId: string, taskId: string, role: RunPhase): void {
    if (ctx.uiSender && !ctx.uiSender.isDestroyed())
      ctx.uiSender.send('panes:close', projectId, taskId, role)
  }

  // GATES VIVOS (decisão do usuário, 2026-08-05: "só tô gastando token de
  // review" — a cada reprovação o gate renascia do zero e re-auditava a
  // entrega INTEIRA; 4 auditorias completas num só card de DS). Reprovação
  // LIMPA (readonly provado) não fecha o pane do gate: ele fica em espera e o
  // próximo done do dev injeta a rodada nova NA MESMA conversa — o gate
  // re-verifica só a lista pendente + o delta SHA-provado desde o head que
  // reprovou. Espelho exato do dev-vivo da F6.7. Entrada com pane morto
  // (fechado na mão/restart) cai sozinha no caminho antigo (spawn novo).
  // Tipo LiveGateWait em phaseTypes.ts.
  const liveGateWaits = new Map<string, LiveGateWait>()
  // Crash-loop de gate: 3 mortes SEM veredito em 60s suspendem a reabertura
  // automática por 5min (precedente do Board: 3 mortes/30s). Caso real 05/08
  // 16:59 — review morreu 3× em 33s, cada morte reaberta às cegas.
  const gateDeathLog = new Map<string, number[]>()
  const gateCooldownUntil = new Map<string, number>()
  function closeLiveGateWait(projectId: string, taskId: string, reason: string): void {
    const wait = liveGateWaits.get(taskId)
    if (!wait) return
    liveGateWaits.delete(taskId)
    if (wait.phase === 'qa') stopQaRuntime(taskId)
    terminatePaneNow(projectId, wait.paneId)
    blackbox.record({
      cat: 'phase',
      event: 'live-gate-closed',
      actor: 'harness',
      ids: { projectId, taskId, paneId: wait.paneId, phase: wait.phase, role: wait.phase },
      reason
    })
  }

  // PLACAR DO GATE (item 18, 2026-08-05): "placar: resolvidos X/Y · parciais P
  // · pendentes Z · novos W". Sem placar parseável = sem entrada no detector
  // (nunca alarmar por falha de parse — anti-falso-positivo 18b).
  function parseGateScore(
    reason: string
  ): { pendentes: number; parciais: number; novos: number } | undefined {
    const m = reason.match(
      /^\s*placar\s*:\s*resolvidos\s+\d+\s*\/\s*\d+\s*·\s*parciais\s+(\d+)\s*·\s*pendentes\s+(\d+)\s*·\s*novos\s+(\d+)/i
    )
    if (!m) return undefined
    return { parciais: Number(m[1]), pendentes: Number(m[2]), novos: Number(m[3]) }
  }
  // ANTI-LOOP (18b): loop ≠ muitas rodadas; loop = ZERO progresso. Lista
  // encolhendo NUNCA alarma (7→4 em 5 rodadas é saudável); parcial conta como
  // progresso; "novos" com pendentes caindo é regressão legítima; o alarme é
  // INFORMATIVO — acorda o juiz, nunca fecha nada sozinho.
  function maybeAlarmGateLoop(
    watch: PhaseWatch,
    task: Task,
    scores: { pendentes: number; parciais: number; novos: number }[]
  ): void {
    if (scores.length < 2) return
    const prev = scores[scores.length - 2]
    const curr = scores[scores.length - 1]
    const prev2 = scores.length >= 3 ? scores[scores.length - 3] : undefined
    const noProgress = (
      a: { pendentes: number; parciais: number },
      b: { pendentes: number; parciais: number }
    ): boolean => b.pendentes >= a.pendentes && b.parciais <= a.parciais
    if (!(noProgress(prev, curr) && prev2 && noProgress(prev2, prev))) return
    hub.publish({
      projectId: watch.projectId,
      missionId: task.missionId,
      kind: 'error',
      urgent: true,
      text: `LOOP DETECTADO em "${task.title}": 2 rodadas de ${watch.phase} sem NENHUM item sair da lista (pendentes ${prev.pendentes}→${curr.pendentes}). Re-despachar a mesma lista é PROIBIDO — mude a estratégia: re-briefing cirúrgico do item travado, troca de modelo/effort do executor (reseat), mandar aplicar literalmente o patch sugerido do gate, ou waiver em gateNotes do que não é contrato. Se a PRÓXIMA rodada ainda não progredir, escale ao USUÁRIO com UMA pergunta objetiva`,
      actor: 'harness'
    })
    blackbox.record({
      cat: 'phase',
      event: 'gate-loop-detected',
      actor: 'harness',
      ids: {
        projectId: watch.projectId,
        missionId: task.missionId,
        taskId: watch.taskId,
        phase: watch.phase,
        role: watch.phase
      },
      reason: `pendentes ${prev.pendentes}→${curr.pendentes} · parciais ${prev.parciais}→${curr.parciais} em 2 rodadas`
    })
  }

  // PANES DE EXECUÇÃO RENASCEM NO BOOT (função oficial, decisão do usuário
  // 2026-08-05: "se o Synkora fecha, quando eu abrir de volta quero que
  // estejam no mesmo lugar com o mesmo contexto, como acontece com o Maestro
  // e o orquestrador"). O recovery de boot marca as fases interrompidas e
  // anota aqui; o respawn é LAZY — dispara quando o usuário ABRE o projeto
  // (maestro:paneSpec), porque o renderer precisa estar de pé para montar o
  // pane. Dev claude volta via --resume (phaseSessions preserva a conversa);
  // dev/gate codex renascem frescos sobre o trabalho preservado (codex resume
  // no caminho do app nasce sem MCP — armadilha provada, F6.7). UMA tentativa
  // por task por boot: pane que morrer de novo segue o fluxo normal, sem loop
  // de ressurreição.
  const bootRespawnsPending = new Map<string, Set<string>>()
  function notePendingRespawn(projectId: string, taskId: string): void {
    const set = bootRespawnsPending.get(projectId) ?? new Set<string>()
    set.add(taskId)
    bootRespawnsPending.set(projectId, set)
  }
  async function respawnInterruptedPhase(projectId: string, taskId: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task || task.kind === 'plan' || task.status === 'done') return
    if (task.phaseState !== 'interrupted' || !task.activePhase) return
    const planTask = planTaskForWorkTask(task)
    if (planTask?.status === 'backlog' && planTask.plan?.approvedAt) return
    if (phaseWatches.has(taskId)) return
    const phase = task.activePhase
    const session = task.phaseSessions?.[phase]
    // Cadeia de seat do respawn (fix 2026-08-06: task.runSeat guarda o NOME
    // do seat e a busca exige ID — gate interrompido sem sessão persistida
    // nunca respawnava no boot e a retomada ficava presa no orquestrador).
    // Para GATES o seat real é re-resolvido dentro do preparePhasePane
    // (reviewer config > lane > política > este fallback) — aqui basta um
    // seat VÁLIDO para destravar a cadeia.
    const mission = task.missionId ? missions.get(task.missionId) : undefined
    const seatId =
      session?.seatId ??
      seats.list().find((s) => s.name === task.runSeat)?.id ??
      mission?.seatId ??
      maestro.get(projectId).seatId
    if (!seatId || !seats.get(seatId)) return
    // Fase 2 (§3.3): card em transição não respawna — o veredito em voo manda
    // no desfecho; o drain é "uma tentativa por boot", perder a vez é barato.
    const transitionToken = phaseTransitions.acquire(taskId, {
      label: 'boot:respawn',
      projectId
    })
    if (!transitionToken) return
    const launchToken = phaseLaunches.reserve(taskId)
    if (!launchToken) {
      phaseTransitions.release(taskId, transitionToken)
      return
    }
    // ocupação soma cards em transição (§7.6), excluindo o próprio lock acima
    const active = phaseOccupancy(projectId, taskId)
    const capacityToken = phaseLaunchCapacity.reserve(projectId, active, MAX_PARALLEL_RUNS)
    if (!capacityToken) {
      phaseLaunches.release(taskId, launchToken)
      phaseTransitions.release(taskId, transitionToken)
      return
    }
    try {
      const spec = await preparePhasePane(
        projectId,
        taskId,
        phase,
        seatId,
        session?.model ?? task.runModel,
        session?.effort ?? task.devEffort,
        undefined,
        launchToken
      )
      if (!spec) return
      openPhasePane(spec, projectId, taskId)
      blackbox.record({
        cat: 'recovery',
        event: 'phase-respawned',
        actor: 'boot',
        ids: { projectId, missionId: task.missionId, taskId, phase, role: phase },
        reason: `fase ${phase} reaberta automaticamente ao abrir o projeto (uma tentativa por boot)`
      })
      hub.publish({
        projectId,
        missionId: task.missionId,
        kind: 'info',
        text: `"${task.title}" — a fase ${phase} foi reaberta automaticamente após o reinício${
          session?.cli === 'claude' ? ' com a MESMA conversa (resume)' : ' sobre o trabalho preservado'
        }; nenhuma ação sua é necessária`,
        actor: 'harness'
      })
    } finally {
      phaseLaunches.release(taskId, launchToken)
      phaseLaunchCapacity.release(projectId, capacityToken)
      phaseTransitions.release(taskId, transitionToken)
    }
  }
  function drainPendingRespawns(projectId: string): void {
    const pending = bootRespawnsPending.get(projectId)
    if (!pending?.size) return
    bootRespawnsPending.delete(projectId)
    void (async () => {
      for (const taskId of pending) {
        try {
          await respawnInterruptedPhase(projectId, taskId)
        } catch (error) {
          blackbox.record({
            cat: 'recovery',
            event: 'phase-respawn-failed',
            actor: 'boot',
            ids: { projectId, taskId },
            err: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })()
  }

  // Reprovação: com ciclos proporcionais sobrando, o feedback volta DIRETO
  // para o dev. Esgotado o limite, o card volta ao ORQUESTRADOR; só uma dúvida
  // real de produto deve interromper o usuário.
  async function retryOrBacklog(watch: PhaseWatch, who: string, motivo: string): Promise<void> {
    const task = tasks.get(watch.taskId)
    if (!task) return
    const cycles = task.cycles ?? 0
    const retryLimit = retryLimitForTask(task)
    const planTask = planTaskForWorkTask(task)
    // Reprovação NÃO apaga evidência de gate JÁ APROVADA (item 21,
    // 2026-08-06: o reset varria review/qa e a memoização por head nunca
    // encontrava a aprovação — o review re-rodou à toa sobre head idêntico).
    // Seguro por construção: o memo só vale quando snapshotHead === head da
    // entrega nova; evidência velha de head diferente simplesmente não casa.
    // Zera: dev, activeGate e a evidência do PRÓPRIO gate que reprovou.
    const priorVerification = task.verification ?? { contractVersion: 1 as const }
    const rejectingGate =
      watch.phase === 'review' || watch.phase === 'qa'
        ? watch.phase
        : liveGateWaits.get(watch.taskId)?.phase
    const resetVerification = {
      ...priorVerification,
      dev: undefined,
      activeGate: undefined,
      ...(rejectingGate ? { [rejectingGate]: undefined } : {})
    }
    if (planTask?.status === 'backlog' && planTask.plan?.approvedAt) {
      // Plano pausado não deixa dev "esperandinho" zumbi: fecha o pane (a
      // retomada do plano reabre com recovery sobre o mesmo worktree). O gate
      // vivo em espera fecha junto — sem próxima rodada, seria zumbi também.
      terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')
      closeLiveGateWait(watch.projectId, watch.taskId, 'plano pausado — sem próxima rodada para esperar')
      tasks.update(watch.taskId, {
        status: 'backlog',
        feedback: `${who} reprovou: ${motivo}`,
        activePhase: 'dev',
        phaseState: 'interrupted',
        verification: resetVerification
      })
      hub.publish({
        projectId: watch.projectId,
        missionId: task.missionId,
        kind: 'info',
        text: `"${task.title}" aguarda o plano ser retomado; a correção do ${who} foi preservada sem abrir outro pane`,
        actor: 'harness'
      })
    } else {
      const liveDev = hub
        .panesOf(watch.projectId)
        .find(
          (pane) =>
            pane.taskId === watch.taskId && pane.role === 'dev' && ptys.has(pane.paneId)
        )
      if (liveDev) {
        const renewedSkillsBlock = await renewLivePaneSkillRun(
          liveDev.paneId,
          watch.taskId,
          watch.projectId,
          'dev'
        )
        if (!renewedSkillsBlock) {
          terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')
          phaseWatches.delete(watch.taskId)
          tasks.update(watch.taskId, {
            status: 'backlog',
            activePhase: 'dev',
            phaseState: 'interrupted',
            feedback: `${motivo} — a rodada de skills expirou e o dev precisa ser reaberto`
          })
          const replacement = await preparePhasePane(
            watch.projectId,
            watch.taskId,
            'dev',
            watch.devSeatId,
            watch.devModel,
            watch.devEffort,
            motivo
          )
          if (replacement) openPhasePane(replacement, watch.projectId, watch.taskId)
          return
        }
        // DEV VIVO NÃO TEM TETO DE CICLOS (decisão do usuário, 2026-08-04:
        // "se o reviewer reprovar dez vezes porque ele tá errando dez vezes,
        // paciência — o dev não fecha enquanto não terminar o trabalho"). O
        // contador de ciclos é SINAL para o orquestrador decidir intervir
        // (briefing/modelo/estratégia/impasse dev×gate), nunca gatilho de
        // fechamento. Reutilizar o processo preserva a conversa que
        // realmente implementou o card — zero re-briefing.
        tasks.update(watch.taskId, {
          cycles: cycles + 1,
          feedback: motivo,
          status: 'backlog',
          activePhase: 'dev',
          phaseState: 'interrupted',
          verification: resetVerification
        })
        emitLog(watch.projectId, {
          kind: 'log',
          tag: task.department,
          text: `↩ ${who} reprovou "${task.title}" — ciclo ${cycles + 1}: feedback devolvido ao dev vivo`
        })
        const project = projects.get(watch.projectId)
        const marker = project
          ? join(project.path, '.synkora', 'runs', `${watch.taskId}.done`)
          : watch.marker.replace(/\.(review|qa)\.verdict$/i, '.done')
        try {
          ensureProjectRuntimeWritable(watch.projectId)
          unlinkSync(marker)
        } catch {
          // marcador anterior já foi consumido
        }
        const liveSeatId = liveDev.seatId ?? watch.devSeatId
        const liveSeat = seats.get(liveSeatId)
        const sessionId = paneSessions.get(liveDev.paneId)
        const latest = tasks.get(watch.taskId) ?? task
        const resumedDev =
          sessionId && liveSeat
            ? {
                phase: 'dev' as const,
                sessionId,
                seatId: liveSeat.id,
                cli: liveSeat.cli,
                model: watch.devModel,
                effort: watch.devEffort,
                capturedAt: new Date().toISOString()
              }
            : undefined
        tasks.update(watch.taskId, {
          status: 'execucao',
          activePhase: 'dev',
          phaseState: 'running',
          phaseStartedAt: new Date().toISOString(),
          phaseResume: resumedDev,
          phaseSessions: resumedDev
            ? { ...(latest.phaseSessions ?? {}), dev: resumedDev }
            : latest.phaseSessions,
          verification: {
            ...(latest.verification ?? { contractVersion: 1 as const }),
            activeGate: undefined
          }
        })
        phaseWatches.set(watch.taskId, {
          ...watch,
          phase: 'dev',
          marker,
          paneId: liveDev.paneId,
          gateBaselineFingerprint: undefined,
          gateStartedAt: undefined
        })
        // UM AVISO SÓ (decisão do usuário, 2026-08-04 — caso real: o dev
        // recebia o veredito cru do harness E a triagem do orquestrador em
        // duas mensagens): com o orquestrador VIVO, o harness NÃO fala com o
        // dev — o orquestrador recebe o veredito + paneId em evento urgente e
        // monta UMA mensagem completa (veredito + triagem + o que não
        // refazer) via notify_pane. Fallback (orquestrador morto / tarefa
        // solta): injeção direta como antes — o retry nunca fica órfão.
        const orchestratorPaneId = task.missionId
          ? orchPaneId(watch.projectId, task.missionId)
          : undefined
        if (orchestratorPaneId && ptys.has(orchestratorPaneId)) {
          const renewedPlanDelivery = hub.notifyPane(
            liveDev.paneId,
            `${renewedSkillsBlock}\n\nAguarde a triagem do orquestrador antes de corrigir; receipts de rodadas anteriores expiraram.`
          )
          if (renewedPlanDelivery === 'dead') {
            terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')
            phaseWatches.delete(watch.taskId)
            tasks.update(watch.taskId, {
              status: 'backlog',
              activePhase: 'dev',
              phaseState: 'interrupted',
              feedback: `${motivo} — o dev encerrou antes de receber a nova rodada de skills`
            })
            const replacement = await preparePhasePane(
              watch.projectId,
              watch.taskId,
              'dev',
              watch.devSeatId,
              watch.devModel,
              watch.devEffort,
              motivo
            )
            if (replacement) openPhasePane(replacement, watch.projectId, watch.taskId)
            return
          }
          hub.publish({
            projectId: watch.projectId,
            missionId: task.missionId,
            kind: 'error',
            urgent: true,
            text: `${who} REPROVOU "${task.title}" (ciclo ${cycles + 1}): ${motivo}. PASSO 1 — JULGUE cada bloqueio contra o CONTRATO do card (briefing/critérios/DESIGN.md): bloqueio que o contrato não pede (norma externa, "autorização", meta-auditoria, cobertura extra) é o gate legislando — registre o waiver em update_task.gateNotes.${watch.phase} AGORA e não repasse. AUTOCONTRADIÇÃO DO GATE = WAIVER IMEDIATO SEU, sem consultar o dono: item que o próprio gate RECEITOU em rodada anterior e o dev fez conforme a receita não se reabre nem ganha régua mais funda — waive citando a receita do gate. PASSO 2 — envie via notify_pane UMA mensagem CURTA ao dev VIVO, que NÃO recebeu este veredito: só a lista SOBREVIVENTE (nunca re-briefing; ele já sabe tudo), corrigindo a CLASSE de cada item no repo inteiro. Endereço estável: notify_pane {taskId: "${watch.taskId}", role: "dev"} — dispensa copiar paneId. Ciclos repetidos = seu diagnóstico; disputa dev×gate: VOCÊ é o juiz final`,
            actor: 'harness'
          })
          if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
          syncBoard(watch.projectId)
          return
        }
        const delivered = hub.notifyPaneNow(
          liveDev.paneId,
          `${renewedSkillsBlock}\n\nA tarefa foi REPROVADA no gate (${who}): ${motivo}. Corrija no mesmo card e, quando estiver 100% resolvido, reporte done novamente.`,
          {
            sourcePaneId: watch.paneId,
            kind: 'feedback',
            correlationId: randomUUID()
          }
        )
        if (delivered === 'dead') {
          phaseWatches.delete(watch.taskId)
          tasks.update(watch.taskId, {
            status: 'backlog',
            activePhase: 'dev',
            phaseState: 'interrupted'
          })
          const deadSpec = await preparePhasePane(
            watch.projectId,
            watch.taskId,
            'dev',
            watch.devSeatId,
            watch.devModel,
            watch.devEffort,
            motivo
          )
          if (deadSpec) openPhasePane(deadSpec, watch.projectId, watch.taskId)
        }
      } else if (task.phaseSessions?.dev || cycles < retryLimit) {
        // O DEV é fechado deliberadamente antes dos gates para que nenhum
        // escritor compartilhe a fotografia auditada. Sessão preservada =
        // continuação intencional e sem teto artificial de qualidade; pane que
        // morreu sem sessão continua protegido pelo orçamento de respawn.
        tasks.update(watch.taskId, {
          cycles: cycles + 1,
          feedback: motivo,
          status: 'backlog',
          activePhase: 'dev',
          phaseState: 'interrupted',
          verification: resetVerification
        })
        emitLog(watch.projectId, {
          kind: 'log',
          tag: task.department,
          text: `↩ ${who} reprovou "${task.title}" — ciclo ${cycles + 1}${task.phaseSessions?.dev ? '' : `/${retryLimit}`}: dev reaberto com o feedback`
        })
        const spec = await preparePhasePane(
          watch.projectId,
          watch.taskId,
          'dev',
          watch.devSeatId,
          watch.devModel,
          watch.devEffort,
          motivo
        )
        if (spec) openPhasePane(spec, watch.projectId, watch.taskId)
      } else {
        // Dev morto E ciclos esgotados: o card volta ao orquestrador.
        terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')
        tasks.update(watch.taskId, {
          status: 'backlog',
          feedback: motivo,
          activePhase: 'dev',
          phaseState: 'interrupted',
          verification: resetVerification
        })
        emitLog(watch.projectId, {
          kind: 'err',
          text: `${who} reprovou "${task.title}": ${motivo} — ciclos esgotados (${retryLimit}) · voltou ao orquestrador`
        })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `"${task.title}" reprovada pelo ${who} (${motivo}) — ciclos automáticos esgotados com o pane do dev morto; diagnostique briefing, modelo ou estratégia e ajuste o card. Só consulte o usuário se existir uma decisão real de produto`,
          actor: 'harness'
        })
      }
    }
    if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
    syncBoard(watch.projectId)
  }

  // Fim de linha do pipeline: fecha o pane do dev, integra a branch (se
  // houver worktree) e marca concluída.
  function taskIntegrationMarker(task: Task): string {
    return `synkora-task:${task.id}`
  }

  async function recoverFinalizingTask(task: Task): Promise<boolean> {
    // Fase 2 (§3.3): este caminho muta o card com watch SINTÉTICO que nunca
    // entra no registry — por isso o lock é chaveado por taskId. Adquire como
    // ENTRANTE (boot `void` ou run_task {finalize}); o finalizeTask disparado
    // no fim roda SOB este token e o release acontece no settle da cadeia
    // (mesmo padrão chainContinuation do advancePhase).
    const transitionToken = phaseTransitions.acquire(task.id, {
      label: 'finalize:recover',
      projectId: task.projectId
    })
    if (!transitionToken) {
      blackbox.record({
        cat: 'recovery',
        event: 'finalize-recover-refused-transition',
        actor: 'harness',
        ids: { projectId: task.projectId, missionId: task.missionId, taskId: task.id },
        reason: `card em transição sob ${
          phaseTransitions.holderLabel(task.id) ?? '?'
        } — a recuperação não compete com um veredito em voo; repita em segundos`
      })
      return false
    }
    let chained = false
    const chainContinuation = (continuation: Promise<unknown>): void => {
      chained = true
      void continuation.finally(() => phaseTransitions.release(task.id, transitionToken))
    }
    try {
      return await recoverFinalizingTaskInner(task, chainContinuation)
    } finally {
      if (!chained) phaseTransitions.release(task.id, transitionToken)
    }
  }

  async function recoverFinalizingTaskInner(
    task: Task,
    chainContinuation: (continuation: Promise<unknown>) => void
  ): Promise<boolean> {
    const project = projects.get(task.projectId)
    if (!project) return false
    let mission = task.missionId ? missions.get(task.missionId) : undefined
    if (task.missionId) mission = ensureMissionWorktree(task.missionId) ?? mission
    const missionTarget = mission ? missionWorkspacePath(project.path, mission) : undefined
    if (task.missionId && (!mission || !missionTarget)) {
      tasks.update(task.id, {
        phaseState: 'finalizing',
        feedback:
          'a branch isolada da missão não pôde ser provada; a recuperação foi preservada sem usar a branch principal'
      })
      hub.publish({
        projectId: task.projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `a recuperação de "${task.title}" foi bloqueada: o destino isolado da missão está indisponível`,
        actor: 'harness',
        urgent: true
      })
      return false
    }
    const target = missionTarget ?? project.path
    const marker = taskIntegrationMarker(task)
    const completeRecoveredIntegration = (): boolean => {
      const taskWorktree = taskWorktreeDescriptor(
        join(app.getPath('userData'), 'worktrees', task.projectId),
        task.id
      )
      const latest = tasks.get(task.id) ?? task
      const receipt = latest.integrationReceipt
      const approvedSnapshot = latest.verification?.dev
      const expectedSourceHead = receipt?.sourceHead ?? approvedSnapshot?.head
      const expectedSourceTree = receipt?.sourceTree ?? approvedSnapshot?.tree
      const sourceStillExact = Boolean(
        expectedSourceHead &&
          expectedSourceTree &&
          (!existsSync(taskWorktree.dir) ||
            (gitHead(taskWorktree.dir) === expectedSourceHead &&
              gitTree(taskWorktree.dir, expectedSourceHead) === expectedSourceTree &&
              isWorktreeClean(taskWorktree.dir) === true &&
              (!approvedSnapshot?.fingerprint ||
                gitVisibleWorktreeFingerprint(taskWorktree.dir) ===
                  approvedSnapshot.fingerprint)))
      )
      ctx.codeIntelligence?.invalidateWorktreeNow(taskWorktree.dir)
      if (
        !sourceStillExact ||
        !removeWorktreeAndBranch(
          project.path,
          taskWorktree.dir,
          taskWorktree.branch,
          expectedSourceHead
        )
      ) {
        tasks.update(task.id, {
          phaseState: 'finalizing',
          feedback:
            'o merge foi confirmado, mas o worktree isolado do card ainda não pôde ser removido'
        })
        hub.publish({
          projectId: task.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `"${task.title}" já foi integrada, mas a limpeza do worktree isolado ficou pendente; o card não será duplicado nem marcado como concluído antes do reparo`,
          actor: 'harness',
          urgent: true
        })
        return false
      }
      const planTask = planTaskForWorkTask(task)
      const head = gitHead(target)
      if (planTask?.plan && head) {
        tasks.update(planTask.id, {
          plan: { ...planTask.plan, executionHead: head }
        })
      }
      // O receipt do plano pousa primeiro; `finalizing` só é limpo no último
      // write. Se o app cair entre ambos, o boot repete esta reconciliação.
      tasks.update(task.id, {
        status: 'done',
        feedback: undefined,
        activePhase: undefined,
        phaseState: undefined,
        phaseStartedAt: undefined,
        phaseResume: undefined,
        phaseSessions: task.phaseSessions?.dev
          ? { dev: task.phaseSessions.dev }
          : undefined,
        integrationReceipt: undefined
      })
      hub.publish({
        projectId: task.projectId,
        missionId: task.missionId,
        kind: 'merge',
        text: `"${task.title}" já havia sido integrada antes do fechamento; o card foi reconciliado sem repetir desenvolvimento, review ou QA`,
        actor: 'harness'
      })
      return true
    }
    const gitProject = hasGitCommit(project.path)
    const receipt = task.integrationReceipt
    if (gitProject && receipt?.stage === 'prepared') {
      const currentTargetHead = gitHead(target)
      if (currentBranch(target) !== receipt.targetBranch) {
        tasks.update(task.id, {
          phaseState: 'finalizing',
          feedback:
            'a branch de destino mudou depois do journal; a conclusão automática foi bloqueada'
        })
        hub.publish({
          projectId: task.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `a finalização de "${task.title}" foi preservada: a branch aberta não é a branch journalada`,
          actor: 'harness',
          urgent: true
        })
        return false
      }
      const reached = gitCommitReached(target, receipt.committedHead)
      if (
        currentTargetHead === receipt.committedHead &&
        isWorktreeClean(target) !== true
      ) {
        alignWorktreeFromSnapshot(target, receipt.previousTargetHead)
      }
      // O journal nasce ANTES do update-ref. Se o commit já é ancestral do
      // destino, não repetimos gates nem merge; apenas reconciliamos arquivos.
      if (reached === true) {
        if (isWorktreeClean(target) === true) return completeRecoveredIntegration()
        tasks.update(task.id, {
          phaseState: 'finalizing',
          feedback:
            'o merge já alcançou o ref Git, mas os arquivos do destino ainda não puderam ser alinhados com segurança'
        })
        hub.publish({
          projectId: task.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `"${task.title}" já chegou ao Git, mas o worktree de destino requer reparo; o card permanece em finalização e nenhum gate será repetido`,
          actor: 'harness',
          urgent: true
        })
        return false
      }
      const stillBeforeMerge =
        reached === false &&
        currentTargetHead === receipt.previousTargetHead &&
        currentBranch(target) === receipt.targetBranch &&
        isWorktreeClean(target) === true
      if (!stillBeforeMerge) {
        tasks.update(task.id, {
          phaseState: 'finalizing',
          feedback:
            'a fotografia do destino divergiu do journal de integração; nenhuma tentativa automática foi feita'
        })
        hub.publish({
          projectId: task.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `a finalização de "${task.title}" foi preservada: o destino não corresponde nem ao estado anterior nem ao merge registrado`,
          actor: 'harness',
          urgent: true
        })
        return false
      }
    }
    if (gitProject && receipt?.stage === 'preparing') {
      const stillBeforeSourceSnapshot =
        gitHead(target) === receipt.previousTargetHead &&
        currentBranch(target) === receipt.targetBranch &&
        isWorktreeClean(target) === true
      if (!stillBeforeSourceSnapshot) {
        tasks.update(task.id, {
          phaseState: 'finalizing',
          feedback:
            'o destino mudou durante a preparação da integração; o card aprovado foi preservado'
        })
        hub.publish({
          projectId: task.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `a finalização de "${task.title}" foi preservada: o destino mudou antes de o merge ser journalado`,
          actor: 'harness',
          urgent: true
        })
        return false
      }
    }
    // Compatibilidade com uma conclusão antiga sem receipt: o UUID no
    // histórico prova que o merge terminou antes da última gravação do card.
    if (gitProject && !receipt && gitHistoryContainsMessage(target, marker)) {
      if (isWorktreeClean(target) === true) return completeRecoveredIntegration()
      tasks.update(task.id, {
        phaseState: 'finalizing',
        feedback:
          'o merge já alcançou o ref Git, mas os arquivos do destino ainda não puderam ser alinhados com segurança'
      })
      hub.publish({
        projectId: task.projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `"${task.title}" já chegou ao Git, mas o worktree de destino requer reparo; o card permanece em finalização e nenhum gate será repetido`,
        actor: 'harness',
        urgent: true
      })
      return false
    }
    const worktree = gitProject
      ? await timedTaskWorktree(
          project.path,
          join(app.getPath('userData'), 'worktrees', task.projectId),
          task.id,
          mission?.branch
        )
      : null
    if (gitProject && !worktree) {
      tasks.update(task.id, {
        phaseState: 'finalizing',
        feedback:
          'não foi possível reanexar o worktree isolado; a finalização foi preservada sem executar na branch compartilhada'
      })
      hub.publish({
        projectId: task.projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `não foi possível recuperar o worktree isolado de "${task.title}"; o card continua em finalização e não caiu na base compartilhada`,
        actor: 'harness',
        urgent: true
      })
      return false
    }
    const cwd = worktree?.dir ?? project.path
    const phase = task.activePhase ?? (task.gates?.at(-1) ?? 'dev')
    const watch: PhaseWatch = {
      projectId: task.projectId,
      taskId: task.id,
      phase,
      devSeatId: task.runSeat ?? mission?.seatId ?? '',
      devModel: task.runModel,
      cwd,
      worktree,
      logFile: join(project.path, '.synkora', 'runs', `${task.id}.md`),
      marker:
        phase === 'dev'
          ? join(project.path, '.synkora', 'runs', `${task.id}.done`)
          : join(project.path, '.synkora', 'runs', `${task.id}.${phase}.verdict`),
      createdAt: Date.now()
    }
    chainContinuation(finalizeTask(watch, task, 'gates já aprovados antes do reinício'))
    return true
  }

  async function finalizeTask(watch: PhaseWatch, task: Task, approvedBy: string): Promise<void> {
    liveGateWaits.delete(watch.taskId)
    closePhasePane(watch.projectId, watch.taskId, 'dev')
    // O renderer fecha visualmente de forma assíncrona. Encerra os processos
    // de fase aqui, antes da fotografia final, para nenhum dev/gate/helper de
    // fase conseguir escrever entre a aprovação e o snapshot integrado.
    for (const pane of hub.panesOf(watch.projectId)) {
      if (
        pane.taskId === watch.taskId &&
        (pane.role === 'dev' ||
          pane.role === 'review' ||
          pane.role === 'qa' ||
          pane.role === 'ajudante')
      ) {
        if (pane.role === 'ajudante') ptys.flushLogOf(pane.paneId)
        // terminatePaneNow desregistra ANTES do kill (F2-c4, nota da tabela
        // §3.3): o kill cru deixava a identidade viva e o onExit reinterpretava
        // o encerramento deliberado do finalize como crash de fase.
        terminatePaneNow(watch.projectId, pane.paneId)
      }
    }
    const project = projects.get(watch.projectId)
    if (!project) return
    // Tarefa de missão: merge NA BRANCH DA MISSÃO (executado no worktree
    // dela); tarefa solta (Geral): merge direto na base, como sempre.
    let mission = task.missionId ? missions.get(task.missionId) : undefined
    if (task.missionId) mission = ensureMissionWorktree(task.missionId) ?? mission
    const gitProject = hasGitCommit(project.path)
    const missionTarget = mission ? missionWorkspacePath(project.path, mission) : undefined
    if (task.missionId && (!mission || !missionTarget)) {
      tasks.update(watch.taskId, {
        phaseState: 'finalizing',
        feedback:
          'o destino isolado da missão não pôde ser provado; a integração foi preservada sem usar a branch principal'
      })
      hub.publish({
        projectId: watch.projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `finalização de "${task.title}" bloqueada: a branch isolada da missão está indisponível`,
        actor: 'harness',
        urgent: true
      })
      return
    }
    const target = missionTarget
    const where = mission ? `na branch da missão "${mission.title}"` : ''
    const latestTask = tasks.get(watch.taskId) ?? task
    if (gitProject && !watch.worktree) {
      tasks.update(watch.taskId, {
        phaseState: 'finalizing',
        feedback:
          'o worktree isolado não está disponível; a integração foi preservada e não cairá na branch compartilhada'
      })
      hub.publish({
        projectId: watch.projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `finalização de "${task.title}" bloqueada: worktree isolado indisponível`,
        actor: 'harness',
        urgent: true
      })
      return
    }
    let validatedFinalFingerprint: string | undefined
    if (watch.worktree) {
      const devEvidence = latestTask.verification?.dev
      const requiredGates =
        latestTask.deliverable === 'code' ? (latestTask.gates ?? ['review', 'qa']) : []
      const invalidEvidence = requiredGates.filter((gate) => {
        const evidence = latestTask.verification?.[gate]
        return (
          evidence?.verdict !== 'approved' ||
          evidence.readonly !== true ||
          evidence.snapshotHead !== devEvidence?.head ||
          evidence.snapshotTree !== devEvidence?.tree ||
          evidence.finalFingerprint !== devEvidence?.fingerprint
        )
      })
      const currentFingerprint = gitVisibleWorktreeFingerprint(watch.cwd)
      const snapshotProblem = await taskSnapshotProblem(latestTask, watch.cwd)
      if (
        !devEvidence?.head ||
        !devEvidence.tree ||
        !devEvidence.fingerprint ||
        invalidEvidence.length > 0 ||
        Boolean(snapshotProblem) ||
        currentFingerprint !== devEvidence.fingerprint
      ) {
        const reason = invalidEvidence.length > 0
          ? `evidência inválida em: ${invalidEvidence.join(', ')}`
          : snapshotProblem ?? 'a fotografia imutável do dev está ausente ou divergente'
        tasks.update(watch.taskId, {
          status: 'backlog',
          feedback: `integração bloqueada: ${reason}`,
          activePhase: 'dev',
          phaseState: 'interrupted',
          integrationReceipt: undefined
        })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `"${task.title}" não foi integrada: ${reason}. O dev precisa revisar a fotografia preservada e passar novamente pelos gates.`,
          actor: 'harness',
          urgent: true
        })
        if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
        syncBoard(watch.projectId)
        return
      }
      validatedFinalFingerprint = devEvidence.fingerprint
    }
    const approvedDevSnapshot = latestTask.verification?.dev
    const refreshExecutionHead = (): void => {
      const planTask = planTaskForWorkTask(task)
      const head = missionTarget ? gitHead(missionTarget) : undefined
      if (!planTask?.plan || !head) return
      tasks.update(planTask.id, {
        plan: { ...planTask.plan, executionHead: head }
      })
    }
    if (watch.worktree && project) {
      ctx.codeIntelligence?.invalidateWorktreeNow(watch.worktree.dir)
      const targetDir = mission ? target! : project.path
      const existingReceipt = (tasks.get(watch.taskId) ?? latestTask).integrationReceipt
      const expectedTargetHead =
        existingReceipt?.previousTargetHead ?? gitHead(targetDir)
      const expectedTargetBranch =
        existingReceipt?.targetBranch ?? currentBranch(targetDir)
      const approvedFingerprint =
        approvedDevSnapshot?.fingerprint ?? validatedFinalFingerprint
      const sourceFingerprintNow = await gitOff(
        'gitVisibleWorktreeFingerprint',
        watch.worktree.dir
      )
      const receiptMatchesSnapshot = Boolean(
        !existingReceipt ||
          (existingReceipt.sourceHead === approvedDevSnapshot?.head &&
            existingReceipt.sourceTree === approvedDevSnapshot?.tree &&
            (existingReceipt.stage === 'prepared' ||
              existingReceipt.approvedFingerprint === approvedFingerprint))
      )
      if (
        !expectedTargetHead ||
        !expectedTargetBranch ||
        !approvedDevSnapshot?.head ||
        !approvedDevSnapshot.tree ||
        !approvedFingerprint ||
        sourceFingerprintNow !== approvedFingerprint ||
        gitHead(watch.worktree.dir) !== approvedDevSnapshot.head ||
        gitTree(watch.worktree.dir, approvedDevSnapshot.head) !== approvedDevSnapshot.tree ||
        isWorktreeClean(watch.worktree.dir) !== true ||
        !receiptMatchesSnapshot
      ) {
        tasks.update(watch.taskId, {
          phaseState: 'finalizing',
          feedback:
            'não foi possível fotografar origem e destino da integração; o card aprovado foi preservado'
        })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `finalização de "${task.title}" bloqueada: fotografia Git da origem ou do destino indisponível`,
          actor: 'harness',
          urgent: true
        })
        return
      }
      const approvedSourceHead = approvedDevSnapshot.head
      const approvedSourceTree = approvedDevSnapshot.tree
      let integrationState = existingReceipt
      if (!integrationState) {
        const prepared = tasks.update(watch.taskId, {
          phaseState: 'finalizing',
          integrationReceipt: {
            version: 1,
            stage: 'preparing',
            marker: taskIntegrationMarker(task),
            sourceHead: approvedSourceHead,
            sourceTree: approvedSourceTree,
            approvedFingerprint,
            previousTargetHead: expectedTargetHead,
            targetBranch: expectedTargetBranch,
            recordedAt: new Date().toISOString()
          }
        })
        integrationState = prepared?.integrationReceipt
        if (!integrationState) {
          hub.publish({
            projectId: watch.projectId,
            missionId: task.missionId,
            kind: 'error',
            text: `finalização de "${task.title}" bloqueada: não foi possível gravar a intenção de integração`,
            actor: 'harness',
            urgent: true
          })
          return
        }
      }
      // git PESADO fora do main (task #2): o merge do card era o stall de
      // ~4s a cada aprovação. O recibo continua sendo persistido NO MEIO do
      // merge (checkpoint síncrono: o WORKER pausa, o main grava e libera —
      // crash-safety do merge-repair intacta; o main nunca bloqueia).
      const res = await gitOffWithCheckpoint(
        'mergeTaskWorktree',
        [
          project.path,
          watch.worktree,
          `${taskIntegrationMarker(task)} · ${task.title}`,
          target,
          {
            requireCleanSource: true,
            expectedSourceFingerprint: approvedFingerprint,
            expectedSourceHead: approvedSourceHead,
            expectedTargetHead,
            expectedTargetBranch,
            expectedMergeCommit:
              integrationState.stage === 'prepared'
                ? integrationState.committedHead
                : undefined,
            beforeTargetUpdate: GIT_CHECKPOINT_MARKER as unknown as (snapshot: {
              sourceHead: string
              previousTargetHead: string
              targetBranch: string
              committedHead: string
            }) => void
          }
        ],
        (payload) => {
          const snapshot = payload as {
            sourceHead: string
            previousTargetHead: string
            targetBranch: string
            committedHead: string
          }
          const updated = tasks.update(watch.taskId, {
            phaseState: 'finalizing',
            integrationReceipt: {
              version: 1,
              stage: 'prepared',
              marker: taskIntegrationMarker(task),
              sourceHead: snapshot.sourceHead,
              sourceTree: approvedSourceTree,
              previousTargetHead: snapshot.previousTargetHead,
              targetBranch: snapshot.targetBranch,
              committedHead: snapshot.committedHead,
              recordedAt: new Date().toISOString()
            }
          })
          if (!updated)
            throw new Error('não foi possível persistir o journal de integração do card')
          return undefined
        }
      )
      blackbox.record({
        cat: 'merge',
        event: res.ok ? 'task-merge-ok' : res.committed ? 'task-merge-committed-unaligned' : 'task-merge-blocked',
        ids: { projectId: watch.projectId, missionId: task.missionId, taskId: watch.taskId },
        actor: 'harness',
        reason: res.ok ? undefined : res.detail,
        evidence: `origem ${approvedSourceHead.slice(0, 12)} → destino ${expectedTargetBranch}@${expectedTargetHead.slice(0, 12)}`,
        detail: { approvedBy, committedHead: res.committedHead?.slice(0, 12) }
      })
      if (res.ok) {
        // Primeiro atualiza o receipt agregado do plano. O card permanece em
        // `finalizing` até o último write, tornando o crash reconciliável.
        refreshExecutionHead()
        tasks.update(watch.taskId, {
          status: 'done',
          feedback: undefined,
          activePhase: undefined,
          phaseState: undefined,
          phaseStartedAt: undefined,
          phaseResume: undefined,
          phaseSessions: task.phaseSessions?.dev
            ? { dev: task.phaseSessions.dev }
            : undefined,
          integrationReceipt: undefined
        })
        emitLog(watch.projectId, { kind: 'ok', text: `"${task.title}" concluída (${approvedBy}) e integrada ${where} (${res.detail})` })
        hub.publish({ projectId: watch.projectId, missionId: task.missionId, kind: 'merge', text: `"${task.title}" CONCLUÍDA (${approvedBy}) e integrada ${where} (${res.detail})`, actor: 'harness' })
      } else if (
        res.committed &&
        res.previousTargetHead &&
        res.committedHead
      ) {
        tasks.update(watch.taskId, {
          phaseState: 'finalizing',
          feedback: `merge gravado; alinhamento do worktree pendente: ${res.detail}`.slice(0, 300)
        })
        emitLog(watch.projectId, {
          kind: 'err',
          text: `"${task.title}" já foi gravada no Git, mas o worktree requer reparo: ${res.detail}`
        })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'error',
          text: `"${task.title}" já chegou ao ref Git, mas os arquivos do destino não alinharam; o card ficou em finalização recuperável e os gates não serão repetidos`,
          actor: 'harness',
          urgent: true
        })
      } else {
        // MERGE BLOQUEADO PRÉ-COMMIT (plano de estabilização 02/08, frente 3a):
        // o card foi APROVADO por review+QA — devolvê-lo ao dev descartava as
        // aprovações e re-pagava uma implementação inteira (caso real de
        // 01/08). Agora ele entra em REPARO DE INTEGRAÇÃO: fica em
        // `finalizing`, preserva verification/worktree/commit aprovado, e o
        // orquestrador resolve a CAUSA (em geral o destino sujo — a branch da
        // missão é dele) e reabre SÓ a integração com run_task
        // {phase: "finalize"}. Nenhuma fase é repetida.
        tasks.update(watch.taskId, {
          phaseState: 'finalizing',
          feedback: `merge bloqueado (reparo de integração pendente): ${res.detail}`.slice(0, 300)
        })
        emitLog(watch.projectId, { kind: 'err', text: `"${task.title}" aprovada, mas o merge foi bloqueado: ${res.detail}` })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'error',
          text:
            `"${task.title}" está APROVADA (review+QA), mas o merge foi BLOQUEADO: ${res.detail}. ` +
            `As aprovações e o commit entregue estão preservados — NENHUMA fase será repetida e nenhum pane novo deve ser aberto para "verificar" o trabalho. ` +
            `Resolva a causa no DESTINO (a branch da missão é sua: commit ou stash do que estiver sujo) e reabra somente a integração com run_task {id: "${watch.taskId}", phase: "finalize"}`,
          actor: 'harness',
          urgent: true
        })
      }
    } else {
      tasks.update(watch.taskId, {
        status: 'done',
        feedback: undefined,
        activePhase: undefined,
        phaseState: undefined,
        phaseStartedAt: undefined,
        phaseResume: undefined,
        phaseSessions: task.phaseSessions?.dev
          ? { dev: task.phaseSessions.dev }
          : undefined,
        integrationReceipt: undefined
      })
      emitLog(watch.projectId, { kind: 'ok', text: `"${task.title}" concluída (${approvedBy})` })
      hub.publish({ projectId: watch.projectId, missionId: task.missionId, kind: 'merge', text: `"${task.title}" CONCLUÍDA (${approvedBy})`, actor: 'harness' })
      refreshExecutionHead()
    }
  }

  async function openGatePane(watch: PhaseWatch, phase: 'review' | 'qa'): Promise<boolean> {
    const task = tasks.get(watch.taskId)
    if (!task) return false
    const planTask = planTaskForWorkTask(task)
    if (planTask?.status === 'backlog' && planTask.plan?.approvedAt) {
      tasks.update(watch.taskId, {
        status: phase === 'qa' ? 'qa' : 'execucao',
        activePhase: phase,
        phaseState: 'interrupted'
      })
      hub.publish({
        projectId: watch.projectId,
        missionId: task.missionId,
        kind: 'info',
        text: `plano pausado: a fase ${phase} de "${task.title}" foi preservada e não abriu pane; reabra somente esse gate após a retomada`,
        actor: 'harness'
      })
      if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
      syncBoard(watch.projectId)
      return false
    }
    // GATE VIVO: se o gate desta fase reprovou e ficou esperando, a rodada
    // nova entra NA MESMA conversa — sem pane novo, sem re-auditoria do que
    // não mudou (o delta é SHA-provado). Pane morto no meio = spawn normal.
    const wait = liveGateWaits.get(watch.taskId)
    if (wait && wait.phase === phase) {
      // RODADA VAZIA É ANOMALIA DE ENCANAMENTO, nunca "dev sem progresso"
      // (18b-d; caso real r6 2026-08-05: done com head idêntico ao reprovado
      // queimou uma auditoria para o gate dizer "delta 0"). Head idêntico E
      // nenhum waiver novo em gateNotes → NÃO recicla o gate: devolve ao dev
      // com a lista vigente e acorda o juiz. Waiver novo (gateNotes mudou)
      // legitima a rodada mesmo sem commit.
      {
        const latestForDelta = tasks.get(watch.taskId) ?? task
        const notesNow = JSON.stringify(latestForDelta.gateNotes?.[phase] ?? '')
        if (
          wait.rejectedHead &&
          latestForDelta.verification?.dev?.head === wait.rejectedHead &&
          notesNow === (wait.gateNotesAtRejection ?? notesNow)
        ) {
          blackbox.record({
            cat: 'phase',
            event: 'gate-round-empty-delta',
            actor: 'harness',
            ids: {
              projectId: watch.projectId,
              missionId: task.missionId,
              taskId: watch.taskId,
              phase,
              role: phase
            },
            reason: `done sem commit novo desde o head reprovado ${wait.rejectedHead.slice(0, 12)} — rodada não aberta; gate segue em espera`
          })
          void retryOrBacklog(
            watch,
            phase === 'review' ? 'revisor' : 'QA',
            `rodada vazia: o done não trouxe NENHUM commit novo desde o head reprovado ${wait.rejectedHead.slice(0, 12)} — a lista da reprovação não foi executada (provável falha de entrega da lista, não do dev). Lista vigente: ${wait.rejectedReason}`
          )
          return true
        }
      }
      if (ptys.has(wait.paneId)) {
        const renewedSkillsBlock = await renewLivePaneSkillRun(
          wait.paneId,
          watch.taskId,
          watch.projectId,
          phase
        )
        if (!renewedSkillsBlock) {
          liveGateWaits.delete(watch.taskId)
          phaseWatches.delete(watch.taskId)
          terminatePaneNow(watch.projectId, wait.paneId)
          return openGatePane(watch, phase)
        }
        liveGateWaits.delete(watch.taskId)
        const latest = tasks.get(watch.taskId) ?? task
        const devFacts = latest.verification?.dev
        const recycleRoutingText = [
          latest.title,
          latest.description,
          latest.briefing,
          ...(latest.quests ?? []),
          latest.feedback
        ]
          .filter(Boolean)
          .join('\n')
        const recycleUiWork = classifyTaskUiWork(latest)
        const recyclePlanTask = planTaskForWorkTask(latest)
        const recycleSecurity = assessMissionRisk({
          declaredRisk: recyclePlanTask?.plan?.risk,
          surfaces: recyclePlanTask?.plan?.riskSurfaces,
          texts: [recycleRoutingText]
        })
        const recycleSensitive =
          recycleSecurity.effectiveRisk === 'high' ||
          requiresManualSecurityValidation(recycleSecurity.surfaces)
        const recycleSensitiveAutoOk = securityWaiverOptions(
          watch.projectId
        ).sensitiveWaiverAllowed
        const recycleBrowserAvailable = paneBrowserAvailable(paneAccessProfile(phase), {
          sensitive: recycleSensitive,
          sensitiveAutoOk: recycleSensitiveAutoOk,
          strict: true,
          mcpReady: ctx.mcpPort !== 0,
          browserConfigured: Boolean(externalPlaywrightForPane())
        })
        let recycleDeltaBlock = ''
        let recycleReviewArtifact: PhaseWatch['reviewArtifact'] | undefined
        if (
          wait.rejectedHead &&
          devFacts?.head &&
          /^[0-9a-f]{40,64}$/i.test(wait.rejectedHead) &&
          /^[0-9a-f]{40,64}$/i.test(devFacts.head)
        ) {
          const rangeValid = await gitOff(
            'immutableReviewRangeValid',
            watch.cwd,
            wait.rejectedHead,
            devFacts.head
          )
          if (!rangeValid) {
            phaseWatches.delete(watch.taskId)
            cleanupReviewArtifact(watch)
            terminatePaneNow(watch.projectId, wait.paneId)
            return openGatePane(watch, phase)
          }
          if (phase === 'review') {
            const deltaEvidence = await gitOff(
              'immutableReviewDiff',
              watch.cwd,
              wait.rejectedHead,
              devFacts.head
            )
            let deltaArtifact: PhaseWatch['reviewArtifact'] | undefined
            if (deltaEvidence?.mode === 'local') {
              try {
                deltaArtifact = materializeReviewDiffArtifact(
                  watch.cwd,
                  watch.taskId,
                  deltaEvidence
                )
              } catch {
                deltaArtifact = undefined
              }
            }
            if (!deltaEvidence || (deltaEvidence.mode === 'local' && !deltaArtifact)) {
              phaseWatches.delete(watch.taskId)
              cleanupReviewArtifact(watch)
              terminatePaneNow(watch.projectId, wait.paneId)
              return openGatePane(watch, phase)
            }
            recycleDeltaBlock = buildReviewDiffBlock({
              delivered: {
                baseHead: wait.rejectedHead,
                head: devFacts.head,
                changedPaths: deltaEvidence.changedPaths
              },
              evidence: { ...deltaEvidence, artifactAvailable: Boolean(deltaArtifact) }
            })
            recycleReviewArtifact = deltaArtifact
          } else {
            const deltaPaths = await gitOff(
              'immutableReviewChangedPaths',
              watch.cwd,
              wait.rejectedHead,
              devFacts.head
            )
            if (!deltaPaths) {
              phaseWatches.delete(watch.taskId)
              cleanupReviewArtifact(watch)
              terminatePaneNow(watch.projectId, wait.paneId)
              return openGatePane(watch, phase)
            }
            recycleDeltaBlock = buildQaDeliverySnapshotBlock({
              baseHead: wait.rejectedHead,
              head: devFacts.head,
              changedPaths: deltaPaths
            })
          }
        }
        const project = projects.get(watch.projectId)
        const baselineFingerprint = await gitOff('gitVisibleWorktreeFingerprint', watch.cwd)
        const gateStartedAt = new Date().toISOString()
        const marker = project
          ? join(project.path, '.synkora', 'runs', `${watch.taskId}.${phase}.verdict`)
          : watch.marker.replace(/\.done$/i, `.${phase}.verdict`)
        cleanupReviewArtifact(watch)
        phaseWatches.set(watch.taskId, {
          ...watch,
          phase,
          paneId: wait.paneId,
          marker,
          gateBaselineFingerprint: baselineFingerprint,
          gateStartedAt,
          reviewArtifact: recycleReviewArtifact,
          uiWork: recycleUiWork,
          browserAvailable: recycleBrowserAvailable
        })
        tasks.update(watch.taskId, {
          status: phase === 'qa' ? 'qa' : 'execucao',
          activePhase: phase,
          phaseState: 'running',
          phaseStartedAt: gateStartedAt,
          phaseResume: undefined,
          verification: {
            ...(latest.verification ?? { contractVersion: 1 as const }),
            activeGate: { phase, startedAt: gateStartedAt, baselineFingerprint }
          }
        })
        const oldHead = wait.rejectedHead ?? 'desconhecido'
        // RECICLO, VERSÃO FINAL (2026-08-06 — "não é só o próprio QA subir?"):
        // nada de pré-aquecer; o QA da rodada nova sobe o runtime ele mesmo.
        let recycleRuntimeNote = ''
        if (
          phase === 'qa' &&
          (latest.department === 'front' || latest.department === 'design') &&
          recycleUiWork &&
          recycleBrowserAvailable &&
          !effectiveSensitiveAccess(recycleSensitive, recycleSensitiveAutoOk) &&
          watch.worktree
        ) {
          const alive = qaRuntimeOf(watch.taskId)
          recycleRuntimeNote = alive?.url
            ? ` The product runtime is STILL RUNNING at ${alive.url} (serves the updated worktree — hot reload); restart it via runtime_control if it misbehaves.`
            : ` Start the product yourself for the visual pass: runtime_control {action:"restart"} returns the URL; retry with another port if needed, and only report "bloqueada" when your tool cannot reach the cause.`
        }
        const delivered = hub.notifyPaneNow(
          wait.paneId,
          buildGateRecyclePrompt({
            phase,
            renewedSkillsBlock,
            devBaseHead: devFacts?.baseHead,
            devHead: devFacts?.head,
            rejectedHead: oldHead,
            rejectionReason: wait.rejectedReason,
            deltaEvidenceBlock: recycleDeltaBlock,
            uiWork: recycleUiWork,
            browserAvailable: recycleBrowserAvailable,
            runtimeNote: recycleRuntimeNote,
            gateRuling:
              latest.gateNotes?.[phase] &&
              JSON.stringify(latest.gateNotes[phase] ?? '') !==
                (wait.gateNotesAtRejection ?? '')
                ? latest.gateNotes[phase]
                : undefined
          }),
          { kind: 'feedback', correlationId: randomUUID() }
        )
        if (delivered !== 'dead') {
          blackbox.record({
            cat: 'phase',
            event: 'gate-recycled',
            actor: 'harness',
            ids: {
              projectId: watch.projectId,
              missionId: task.missionId,
              taskId: watch.taskId,
              paneId: wait.paneId,
              phase,
              role: phase
            },
            reason: `rodada nova do gate ${phase} na MESMA conversa (head reprovado ${wait.rejectedHead?.slice(0, 12) ?? '?'} → novo ${devFacts?.head?.slice(0, 12) ?? '?'})`
          })
          hub.publish({
            projectId: watch.projectId,
            missionId: task.missionId,
            kind: 'info',
            quiet: true,
            text: `gate ${phase} de "${task.title}" reaproveitou o pane vivo — re-verificação incremental do delta`,
            actor: 'harness'
          })
          if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
          syncBoard(watch.projectId)
          return true
        }
        // o pane morreu entre o has() e a injeção: desfaz e cai no spawn normal
        phaseWatches.delete(watch.taskId)
      } else {
        liveGateWaits.delete(watch.taskId)
      }
    }
    const spec = await preparePhasePane(
      watch.projectId,
      watch.taskId,
      phase,
      watch.devSeatId,
      watch.devModel,
      watch.devEffort
    )
    if (!spec) {
      const latest = tasks.get(watch.taskId)
      // `preparePhasePane` pode ter detectado que a fotografia imutável mudou
      // e já devolvido o card ao dev. Não sobrescreva esse bloqueio seguro com
      // um simples "gate interrompido".
      if (
        latest?.status === 'backlog' &&
        latest.activePhase === 'dev' &&
        latest.phaseState === 'interrupted'
      ) {
        return false
      }
      tasks.update(watch.taskId, {
        status: phase === 'qa' ? 'qa' : 'execucao',
        activePhase: phase,
        phaseState: 'interrupted',
        feedback: `não foi possível abrir o gate ${phase}; tente reabri-lo sem repetir o desenvolvimento`
      })
      if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
      syncBoard(watch.projectId)
      return false
    }
    openPhasePane(spec, watch.projectId, watch.taskId)
    return true
  }

  // Avança o pipeline de uma fase concluída — chamado pela tool MCP `report`
  // (caminho primário) OU pelo poller de arquivos-marcador (fallback). Quem
  // chega primeiro remove o watch; o outro caminho vira no-op.
  // Os GATES são POR TAREFA (task.gates, decisão do Maestro no create_tasks):
  // ausente = review+qa; ['qa'] pula a revisão; [] = entregável não executável,
  // direto para a conclusão. Código novo nunca recebe gates vazios.
  function advancePhase(
    watch: PhaseWatch,
    content: string,
    securityReview?: SecurityReviewRecord,
    verificationEvidence?: GateVerificationEvidence,
    acceptance?: {
      skillUsage: NonNullable<Task['skillUsage']>
      commitRuntime: () => boolean
    },
    token?: PhaseTransitionToken
  ): boolean {
    // Fase 0 (atribuição de stall): wrapper fino e SÍNCRONO — o contrato SYNC
    // do veredito (comentário-âncora no Inner) fica intacto: wrap de função
    // sync devolve sync.
    // Fase 2 (F2-c4): o advancePhase é o DONO do release do lock a partir da
    // chamada — imediato nos desfechos sem continuação (incluindo throw: no
    // c4 o rollback do call site roda na MESMA pilha síncrona, sem janela;
    // revisitar a ordem set→release no c5, §8.2 do mapa) e no SETTLE da
    // cadeia quando o Inner dispara continuação. O call site só solta quando
    // recusa/rola de volta ANTES de chamar aqui.
    let chained = false
    const chainContinuation = (continuation: Promise<unknown>): void => {
      chained = true
      if (token) {
        void continuation.finally(() => phaseTransitions.release(watch.taskId, token))
      }
    }
    try {
      return mainStalls.wrap(`advancePhase:${watch.phase}`, watch.taskId.slice(0, 8), () =>
        advancePhaseInner(
          watch,
          content,
          securityReview,
          verificationEvidence,
          acceptance,
          token,
          chainContinuation
        )
      )
    } finally {
      if (!chained && token) phaseTransitions.release(watch.taskId, token)
    }
  }
  function advancePhaseInner(
    watch: PhaseWatch,
    content: string,
    securityReview?: SecurityReviewRecord,
    verificationEvidence?: GateVerificationEvidence,
    acceptance?: {
      skillUsage: NonNullable<Task['skillUsage']>
      commitRuntime: () => boolean
    },
    token?: PhaseTransitionToken,
    chainContinuation: (continuation: Promise<unknown>) => void = (continuation) => {
      void continuation
    }
  ): boolean {
    // TRIPWIRE DE CONTRATO (Fase 2, §3.2 do plano): todo caminho de veredito
    // entra aqui SOB o lock do card. Chamada sem posse é anomalia auditável
    // (o critério de pronto exige zero) — nunca um throw que brickaria o
    // veredito.
    if (!token || !phaseTransitions.owns(watch.taskId, token)) {
      blackbox.record({
        cat: 'phase',
        event: 'phase-advance-without-lock',
        actor: 'harness',
        ids: {
          projectId: watch.projectId,
          taskId: watch.taskId,
          phase: watch.phase,
          role: watch.phase
        },
        reason: token
          ? 'advancePhase chamado com token que não é o dono atual do lock deste card'
          : 'advancePhase chamado sem token de transição — entrante fora da tabela §3.3'
      })
    }
    const task = tasks.get(watch.taskId)
    if (!task) return false
    let runtimeAcceptanceCommitted = false
    const commitRuntimeAcceptance = (): void => {
      if (!acceptance || runtimeAcceptanceCommitted) return
      if (acceptance.commitRuntime()) {
        runtimeAcceptanceCommitted = true
        return
      }
      // A gravação autoritativa já ocorreu numa única atualização do card.
      // Falha aqui indica divergência interna, não licença para apagar a prova.
      blackbox.record({
        cat: 'phase',
        event: 'skill-runtime-post-commit-mismatch',
        actor: 'harness',
        ids: {
          projectId: watch.projectId,
          missionId: task.missionId,
          taskId: watch.taskId,
          phase: watch.phase,
          role: watch.phase
        },
        reason: 'o ledger persistido aceitou a rodada, mas o stamp efêmero recusou o fechamento'
      })
    }
    if (
      watch.phase === 'dev' &&
      hub
        .panesOf(watch.projectId)
        .some(
          (pane) =>
            pane.taskId === watch.taskId && pane.role === 'ajudante'
        )
    ) {
      // Última barreira síncrona: cobre a corrida entre diagnósticos async e
      // o snapshot, tanto no report MCP quanto no marcador `.done`.
      phaseWatches.set(watch.taskId, watch)
      if (watch.paneId) {
        hub.notifyPane(
          watch.paneId,
          '[synkora] conclusão bloqueada: ainda existe ajudante aberto neste card. Aguarde o fechamento e reporte done novamente.'
        )
      }
      return false
    }
    const configuredGates = task.gates ?? ['review', 'qa']
    const taskUiWork = classifyTaskUiWork(task)
    const gates =
      task.deliverable === 'code' && taskUiWork && !configuredGates.includes('qa')
        ? [...configuredGates, 'qa' as const]
        : configuredGates
    if (watch.phase === 'dev') {
      // O report encerra o executor imediatamente. A fotografia abaixo ainda
      // se protege contra filhos/background tardios, mas não deixamos o mesmo
      // CLI continuar operando enquanto review e QA já estão abertos.
      const snapshot = watch.devSnapshot
      const snapshotStillExact = Boolean(
        !watch.worktree ||
          (snapshot &&
            gitHead(watch.cwd) === snapshot.head &&
            gitTree(watch.cwd, snapshot.head) === snapshot.tree &&
            isWorktreeClean(watch.cwd) === true &&
            gitVisibleWorktreeFingerprint(watch.cwd) === snapshot.fingerprint)
      )
      if (!snapshotStillExact) {
        watch.devSnapshot = undefined
        phaseWatches.set(watch.taskId, watch)
        if (watch.paneId) {
          hub.notifyPane(
            watch.paneId,
            '[synkora] conclusão bloqueada: a fotografia mudou depois dos diagnósticos. Confira os arquivos e reporte done novamente.'
          )
        }
        return false
      }
      const mission = task.missionId ? missions.get(task.missionId) : undefined
      const project = projects.get(watch.projectId)
      const baseRef =
        snapshot?.baseHead ??
        (mission
          ? mission.branch
          : project
            ? currentBranch(project.path)
            : undefined)
      const changedPaths = baseRef ? changedWorktreeFiles(watch.cwd, baseRef) : undefined
      // ENTREGA VAZIA (plano de estabilização 02/08, frente 3a): dev reportou
      // done sem NENHUM commit novo sobre a base (head == baseHead). Abrir um
      // gate aqui produziria um diff imutável degenerado (base..base = vazio)
      // e um reviewer cego — o caso real de 01/08. Vira estado explícito para
      // o orquestrador decidir, nunca um gate sem objeto.
      if (
        task.deliverable === 'code' &&
        watch.worktree &&
        snapshot?.head &&
        snapshot.baseHead &&
        snapshot.head === snapshot.baseHead
      ) {
        blackbox.record({
          cat: 'phase',
          event: 'empty-delivery-blocked',
          ids: {
            projectId: watch.projectId,
            missionId: task.missionId,
            taskId: watch.taskId,
            phase: 'dev'
          },
          actor: 'harness',
          evidence: `head == base (${snapshot.head.slice(0, 12)})`,
          reason: 'dev reportou done sem nenhuma alteração sobre a base'
        })
        terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')
        tasks.update(watch.taskId, {
          status: 'backlog',
          activePhase: 'dev',
          phaseState: 'interrupted',
          feedback:
            'entrega vazia: o dev reportou done sem nenhuma alteração em relação à base do worktree — nenhum gate foi aberto'
        })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'error',
          text:
            `"${task.title}" terminou SEM nenhuma alteração sobre a base — não há diff para revisar e nenhum gate foi aberto. ` +
            `Duas causas comuns: (1) o trabalho JÁ está na branch da missão (integrado por fora) — nesse caso este card não deve re-executar: remova-o com delete_task e, se o plano ficar sem o card que o orçamento exige (FAST = exatamente 1), proponha um plano novo com o trabalho que realmente falta (create_plan pausa o atual sozinho quando nada está rodando); ` +
            `(2) o dev realmente não fez nada — nesse caso corrija o briefing e rode o card de novo. Nunca abra outro executor só para "verificar" trabalho existente.`,
          actor: 'harness',
          urgent: true
        })
        if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
        syncBoard(watch.projectId)
        return true
      }
      if (
        task.deliverable === 'non_code' &&
        watch.worktree &&
        (changedPaths === undefined || changedPaths.some(isExecutableProjectPath))
      ) {
        watch.devSnapshot = undefined
        phaseWatches.set(watch.taskId, watch)
        if (watch.paneId) {
          hub.notifyPane(
            watch.paneId,
            '[synkora] conclusão bloqueada: a fotografia non_code não pôde ser provada como livre de código/configuração executável. Peça reclassificação ao orquestrador.'
          )
        }
        return false
      }
      const reportedAt = new Date().toISOString()
      // FASE APROVADA É MEMOIZADA POR EVIDÊNCIA (ordem do usuário, 2026-08-06
      // — "o aplicativo fechou, voltou, tem que CONTINUAR o fluxo, não refazer
      // coisas": um estado corrompido por qualquer caminho mandava o card de
      // volta ao dev, o done reabria o review e o review re-auditava um head
      // que ele JÁ TINHA APROVADO). O princípio: gate aprovado para o head H
      // vale para SEMPRE que a entrega continuar em H — não importa como o
      // estado se confundiu no meio. Entrega NOVA (head diferente) roda os
      // gates completos como sempre.
      const headNow = snapshot?.head
      const priorV = task.verification
      const reviewMemo =
        headNow &&
        priorV?.review?.verdict === 'approved' &&
        priorV.review.snapshotHead === headNow
          ? priorV.review
          : undefined
      const qaMemo =
        headNow && priorV?.qa?.verdict === 'approved' && priorV.qa.snapshotHead === headNow
          ? priorV.qa
          : undefined
      const next =
        gates.includes('review') && !reviewMemo
          ? 'review'
          : gates.includes('qa') && !qaMemo
            ? 'qa'
            : null
      if (reviewMemo || qaMemo) {
        blackbox.record({
          cat: 'phase',
          event: 'gate-skipped-memoized',
          actor: 'harness',
          ids: {
            projectId: watch.projectId,
            missionId: task.missionId,
            taskId: watch.taskId,
            phase: 'dev'
          },
          evidence: `head ${headNow?.slice(0, 12)}`,
          reason: `entrega idêntica à já aprovada — pulando ${[
            reviewMemo ? 'review' : '',
            qaMemo ? 'qa' : ''
          ]
            .filter(Boolean)
            .join('+')}${next ? `; próxima fase real: ${next}` : '; nada a re-validar'}`
        })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'info',
          text: `"${task.title}": a entrega é o MESMO commit já aprovado (${headNow?.slice(0, 10)}) — ${
            reviewMemo && qaMemo
              ? 'review e QA memoizados, indo direto para a conclusão'
              : reviewMemo
                ? 'review memoizado, indo direto ao QA'
                : 'QA memoizado'
          }; nada é refeito`,
          actor: 'harness'
        })
      }
      // REVIEW/QA nunca dividem uma árvore gravável com o autor. A conversa e
      // o handoff ficam persistidos, mas o processo escritor morre antes de o
      // gate nascer; uma reprovação reabre o mesmo card sobre esta fotografia.
      const latestBeforeGate = tasks.get(watch.taskId) ?? task
      const phaseSessions = { ...(latestBeforeGate.phaseSessions ?? {}) }
      if (next) delete phaseSessions[next]
      tasks.update(watch.taskId, {
        ...(acceptance ? { skillUsage: acceptance.skillUsage } : {}),
        status: next === 'qa' ? 'qa' : 'execucao',
        activePhase: next ?? 'dev',
        phaseState: next ? 'pending' : 'finalizing',
        phaseStartedAt: undefined,
        phaseResume: undefined,
        phaseSessions,
        verification: {
          ...(task.verification ?? { contractVersion: 1 as const }),
          dev: {
            reportedAt,
            head: snapshot?.head,
            tree: snapshot?.tree,
            baseHead: snapshot?.baseHead,
            fingerprint: snapshot?.fingerprint ?? gitVisibleWorktreeFingerprint(watch.cwd),
            changedPaths,
            ...(verificationEvidence ? { verificationEvidence } : {})
          },
          activeGate: undefined,
          // Evidência memoizada SOBREVIVE quando a entrega é o mesmo head já
          // aprovado; entrega nova zera e os gates rodam de verdade.
          review: reviewMemo,
          qa: qaMemo
        }
      })
      commitRuntimeAcceptance()
      hub.publish({
        projectId: watch.projectId,
        missionId: task.missionId,
        kind: 'report',
        text: `dev concluiu "${task.title}"${next ? ` — próxima fase: ${next === 'review' ? 'revisão de código' : 'QA'}` : ' — entregável sem gates, finalizando'}`,
        actor: 'dev'
      })
      emitLog(watch.projectId, {
        kind: 'log',
        tag: task.department,
        text: `✔ dev sinalizou conclusão de "${task.title}"${next ? ` — ${next === 'review' ? '🧐 revisão' : '🔎 QA'} entrando` : ' — sem gates, concluindo'}`
      })
      // "Abriu, testou, reportou → FECHOU": encerra também janelas de teste e
      // helpers antes de qualquer leitor/runtime independente tocar a árvore.
      if (watch.paneId) ptys.reapVisualsOf(watch.paneId)
      terminateTaskHelpers(watch.projectId, watch.taskId, 'entrega congelada para gates independentes')
      terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')
      if (next) chainContinuation(openGatePane(watch, next))
      else
        chainContinuation(
          finalizeTask(
            watch,
            task,
            reviewMemo || qaMemo
              ? 'gates já aprovados para esta mesma entrega (memoização por head)'
              : 'sem gates — decisão do Maestro'
          )
        )
      if (!next) {
        if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
        syncBoard(watch.projectId)
      }
      return true
    }
    // review/qa: parse do veredito e fecha o pane do gate.
    const finishedAt = new Date().toISOString()
    let finalFingerprint = gitVisibleWorktreeFingerprint(watch.cwd)
    const baselineFingerprint = watch.gateBaselineFingerprint
    const latestForSnapshot = tasks.get(watch.taskId) ?? task
    // SYNC de propósito: advancePhase é a barreira síncrona do veredito — a
    // versão async (taskSnapshotProblem/gitOff) NÃO pode ser usada aqui: a
    // Promise não-aguardada invalidava TODO veredito como "[object Promise]"
    // (bug real 2026-08-05, primeiro gate pós-gitWorker).
    const devFacts = latestForSnapshot.verification?.dev
    const snapFacts = {
      head: devFacts?.head,
      tree: devFacts?.tree,
      fingerprint: devFacts?.fingerprint,
      baseHead: devFacts?.baseHead
    }
    let snapshotProblem = watch.worktree
      ? snapshotProblemFor(watch.cwd, snapFacts, latestForSnapshot.deliverable === 'code')
      : undefined
    const artifactProblem = reviewArtifactProblem(watch)
    if (artifactProblem) {
      snapshotProblem = snapshotProblem
        ? `${snapshotProblem}; ${artifactProblem}`
        : artifactProblem
    }
    // QUARENTENA DE EVIDÊNCIA (item 20, 2026-08-06: screenshots do QA na raiz
    // invalidaram uma aprovação visual GENUÍNA — mas o que se integra é o
    // COMMIT; untracked nunca entra no merge): se a única divergência são
    // arquivos NOVOS untracked com o head/árvore intactos, move-os para
    // .synkora/quarantine e REVALIDA — o veredito sobrevive ao lixo de gate.
    if (
      watch.worktree &&
      (snapshotProblem || baselineFingerprint !== finalFingerprint) &&
      gitHead(watch.cwd) === devFacts?.head
    ) {
      const quarantineProject = projects.get(watch.projectId)
      const moved = quarantineProject
        ? quarantineUntrackedNew(
            watch.cwd,
            join(
              quarantineProject.path,
              '.synkora',
              'quarantine',
              `${watch.taskId.slice(0, 8)}-${finishedAt.replace(/[:.]/g, '-')}`
            )
          )
        : []
      if (moved.length > 0) {
        finalFingerprint = gitVisibleWorktreeFingerprint(watch.cwd)
        snapshotProblem = snapshotProblemFor(
          watch.cwd,
          snapFacts,
          latestForSnapshot.deliverable === 'code'
        )
        blackbox.record({
          cat: 'phase',
          event: 'gate-evidence-quarantined',
          actor: 'harness',
          ids: {
            projectId: watch.projectId,
            missionId: task.missionId,
            taskId: watch.taskId,
            phase: watch.phase,
            role: watch.phase
          },
          evidence: moved.slice(0, 8).join(', ') + (moved.length > 8 ? ` +${moved.length - 8}` : ''),
          reason: `${moved.length} arquivo(s) untracked de evidência movidos para .synkora/quarantine — o commit julgado está intacto e o veredito segue válido`
        })
        hub.publish({
          projectId: watch.projectId,
          missionId: task.missionId,
          kind: 'info',
          quiet: true,
          text: `evidência de gate em caminho git-visível foi movida para quarentena em "${task.title}" (${moved.length} arquivo(s)) — nada integrável mudou`,
          actor: 'harness'
        })
      }
    }
    const boundToDevSnapshot = Boolean(
      !watch.worktree ||
        (latestForSnapshot.verification?.dev?.fingerprint &&
          baselineFingerprint === latestForSnapshot.verification.dev.fingerprint)
    )
    const readonly =
      Boolean(baselineFingerprint) &&
      Boolean(finalFingerprint) &&
      baselineFingerprint === finalFingerprint &&
      boundToDevSnapshot &&
      !snapshotProblem
    if (securityReview && watch.phase !== 'review') {
      throw new Error(
        'securityReview recusado: somente o revisor, durante a fase review, pode emitir esta evidência'
      )
    }
    let pendingSecurityPlanApproval:
      | { planTaskId: string; plan: NonNullable<Task['plan']> }
      | undefined
    if (securityReview) {
      const parsedVerdict = /^\s*aprovada\b/i.test(content)
        ? 'approved'
        : /^\s*reprovada\b/i.test(content)
          ? 'rejected'
          : 'invalid'
      securityReview = {
        ...securityReview,
        // A evidência em disco descreve o veredito efetivo do harness, não
        // apenas a palavra enviada antes da verificação de imutabilidade.
        verdict: readonly ? parsedVerdict : 'invalid'
      }
      const project = projects.get(watch.projectId)
      if (!project) {
        phaseWatches.set(watch.taskId, watch)
        return false
      }
      try {
        persistSecurityReview(project.path, securityReview)
      } catch {
        phaseWatches.set(watch.taskId, watch)
        if (watch.paneId) {
          hub.notifyPane(
            watch.paneId,
            '[synkora] report preservado: não foi possível gravar a evidência sanitizada; tente novamente'
          )
        }
        return false
      }
      // O relatório sanitizado acima é somente evidência isolada. A autoridade
      // do GATE ESPECIALISTA (plano aprovado + veredito + receipt do card) só
      // nasce, de forma indivisível, no updateMany executado por recordGate.
      // Decisão do usuário 2026-08-04:
      // "não sou especialista em segurança — ou retira, ou um especialista
      // olha o código"). Em modo estrito, o securityReview APROVADO sobre
      // fotografia imutável preenche a validação do plano com ator
      // 'security-gate' — o humano nunca mais é perguntado sobre segurança;
      // segue decidindo apenas produto e integração.
      if (watch.phase === 'review' && readonly && securityReview.verdict === 'approved') {
        const workTask = tasks.get(watch.taskId)
        const securityPlanTask = workTask ? planTaskForWorkTask(workTask) : undefined
        const pendingValidation =
          securityPlanTask?.plan &&
          manualSecurityValidationOf(securityPlanTask.plan).status === 'pending'
        if (securityPlanTask?.plan && pendingValidation) {
          pendingSecurityPlanApproval = {
            planTaskId: securityPlanTask.id,
            plan: {
              ...securityPlanTask.plan,
              manualSecurityValidation: {
                required: true,
                status: 'approved',
                actor: 'security-gate',
                resolvedAt: finishedAt,
                evidence: `securityReview aprovado e imutável no gate de review do card "${workTask?.title ?? watch.taskId}"; a autoridade foi persistida junto do veredito e do receipt, com relatório sanitizado isolado em .synkora`
              }
            }
          }
        }
      }
    }
    // O fechamento do pane do gate é POR RAMO (gates vivos): aprovação e
    // veredito inválido/ilegível fecham; reprovação limpa mantém o pane em
    // espera para a próxima rodada na mesma conversa.
    const recordGate = (
      verdict: 'approved' | 'rejected' | 'invalid',
      reason: string,
      wasReadonly = readonly,
      transition?: 'dev' | 'qa' | 'finalize',
      consumeAcceptance = false,
      nextGateRound?: Task['gateRound']
    ): void => {
      const latest = tasks.get(watch.taskId)
      const verification = latest?.verification ?? { contractVersion: 1 as const }
      const phaseSessions = { ...(latest?.phaseSessions ?? {}) }
      if (transition === 'qa') delete phaseSessions.qa
      const gateEvidence: TaskGateEvidence = {
        phase: watch.phase === 'qa' ? 'qa' : 'review',
        verdict,
        startedAt: watch.gateStartedAt ?? latest?.phaseStartedAt ?? finishedAt,
        finishedAt,
        baselineFingerprint,
        finalFingerprint,
        snapshotHead: verification.dev?.head,
        snapshotTree: verification.dev?.tree,
        readonly: wasReadonly,
        reason,
        ...(securityReview ? { securityReview } : {}),
        ...(verificationEvidence ? { verificationEvidence } : {})
      }
      const workTaskPatch: TaskUpdatePatch = {
        ...(consumeAcceptance && acceptance ? { skillUsage: acceptance.skillUsage } : {}),
        // aprovação encerra a rodada aberta: lista fechada/placar não vazam
        // para a fase seguinte nem para um card aprovado
        ...(verdict === 'approved'
          ? { gateRound: undefined }
          : nextGateRound
            ? { gateRound: nextGateRound }
            : {}),
        ...(transition === 'dev'
          ? {
              status: 'backlog' as const,
              activePhase: 'dev' as const,
              phaseState: 'interrupted' as const,
              phaseStartedAt: undefined,
              phaseResume: latest?.phaseSessions?.dev,
              phaseSessions
            }
          : transition === 'qa'
          ? {
              status: 'qa' as const,
              activePhase: 'qa' as const,
              phaseState: 'pending' as const,
              phaseStartedAt: undefined,
              phaseResume: undefined,
              phaseSessions
            }
          : transition === 'finalize'
            ? {
                activePhase: watch.phase,
                phaseState: 'finalizing' as const,
                phaseResume: undefined,
                phaseSessions
              }
            : {}),
        verification: {
          ...verification,
          activeGate: undefined,
          gateHistory: [...(verification.gateHistory ?? []), gateEvidence].slice(-24),
          [watch.phase]: gateEvidence
        }
      }
      const approveSecurityPlan = verdict === 'approved' && pendingSecurityPlanApproval
      if (approveSecurityPlan) {
        if (!consumeAcceptance || !acceptance) {
          throw new Error(
            'aprovação de segurança recusada: veredito, plano e receipt precisam da mesma transação'
          )
        }
        const committed = tasks.updateMany([
          { id: watch.taskId, patch: workTaskPatch },
          {
            id: approveSecurityPlan.planTaskId,
            patch: { plan: approveSecurityPlan.plan }
          }
        ])
        if (!committed) {
          throw new Error(
            'aprovação de segurança recusada: card de trabalho ou plano desapareceu antes do commit'
          )
        }
        // Observabilidade não é autoridade e nunca pode anteceder o commit.
        blackbox.record({
          cat: 'verify',
          event: 'security-gate-validated',
          actor: 'harness',
          ids: {
            projectId: watch.projectId,
            missionId: latest?.missionId,
            taskId: watch.taskId
          },
          reason:
            'validação de segurança do plano, veredito do gate e receipt persistidos numa única transação — sem ação humana'
        })
      } else if (!tasks.update(watch.taskId, workTaskPatch)) {
        throw new Error('card desapareceu antes do commit do veredito do gate')
      }
      if (consumeAcceptance) commitRuntimeAcceptance()
    }
    if (!readonly) {
      cleanupReviewArtifact(watch)
      terminateTaskPhasePane(watch.projectId, watch.taskId, watch.phase)
      liveGateWaits.delete(watch.taskId)
      const reason = snapshotProblem
        ? `a fotografia imutável deixou de ser válida: ${snapshotProblem}`
        : !boundToDevSnapshot
          ? `${watch.phase} não revisou a mesma fotografia entregue pelo dev`
          : baselineFingerprint && finalFingerprint
            ? `${watch.phase} alterou arquivos visíveis ao Git; gates são somente leitura`
            : `não foi possível provar que o gate ${watch.phase} permaneceu somente leitura`
      recordGate('invalid', reason, false, 'dev')
      // UM AVISO SÓ (ordem do dono, 2026-08-07: "tá avisando 2 vezes, não
      // quero mais"): a injeção ACIONÁVEL é a do retryOrBacklog (reprovação
      // com PASSO 1/2) — este evento fica quiet: EVENTS.md/UI registram, o
      // orquestrador não recebe o mesmo fato duas vezes.
      hub.publish({
        projectId: watch.projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `${watch.phase === 'review' ? 'revisor' : 'QA'} teve o veredito INVALIDADO em "${task.title}": ${reason}. As alterações foram preservadas e voltam ao dev para inspeção; nada será integrado escondido.`,
        actor: 'harness',
        quiet: true
      })
      chainContinuation(
        retryOrBacklog(watch, watch.phase === 'review' ? 'revisor' : 'QA', reason)
      )
      return true
    }
    const m = content.match(/^\s*(aprovada|reprovada)\s*:?\s*([\s\S]*)$/i)
    const approved = m?.[1]?.toLowerCase() === 'aprovada'
    // 1500, não 300 (2026-08-05): o motivo É o payload do ciclo de correção —
    // truncá-lo fazia o dev corrigir o resumo enquanto o gate vivo re-checava
    // a lista completa da memória ("persistem…" em 3 rodadas seguidas). Logs
    // curtos fatiam na exibição, nunca na fonte.
    const motivo = (m?.[2] ?? '').trim() || 'sem motivo'
    const who = watch.phase === 'review' ? 'revisor' : 'QA'
    if (!m) {
      cleanupReviewArtifact(watch)
      terminateTaskPhasePane(watch.projectId, watch.taskId, watch.phase)
      liveGateWaits.delete(watch.taskId)
      recordGate('invalid', `veredito ilegível: ${content.slice(0, 120)}`)
      tasks.update(watch.taskId, {
        status: watch.phase === 'qa' ? 'qa' : 'execucao',
        feedback: `veredito ilegível do ${who}: ${content.slice(0, 120)}`,
        activePhase: watch.phase,
        phaseState: 'interrupted'
      })
      emitLog(watch.projectId, {
        kind: 'err',
        text: `veredito ilegível do ${who} em "${task.title}" — somente o gate ${watch.phase} precisa ser reaberto`
      })
      hub.publish({
        projectId: watch.projectId,
        missionId: task.missionId,
        kind: 'error',
        text: `veredito ilegível do ${who} em "${task.title}" — o desenvolvimento está preservado; reabra apenas run_task {id: "${watch.taskId}", phase: "${watch.phase}"}`,
        actor: who
      })
    } else if (!approved) {
      // LISTA FECHADA NO CARD (2026-08-05): a regra "lista completa na 1ª
      // passada" morria com o pane — um gate novo re-legislava do zero (r5 do
      // caso real). A lista + placar persistem no card e um spawn fresco os
      // herda como a lista da instituição, não da conversa.
      const prevRound = task.gateRound?.phase === watch.phase ? task.gateRound : undefined
      const score = parseGateScore(motivo)
      const roundScores = [
        ...(prevRound?.scores ?? []).slice(-8),
        ...(score ? [{ ...score, head: devFacts?.head, at: finishedAt }] : [])
      ]
      const nextGateRound: Task['gateRound'] = {
        phase: watch.phase,
        rejectedHead: devFacts?.head,
        list: (m?.[2] ?? '').trim() || motivo,
        round: (prevRound?.round ?? 0) + 1,
        scores: roundScores,
        ...(verificationEvidence ? { verificationEvidence } : {}),
        gateNotesAtRejection: JSON.stringify(
          (tasks.get(watch.taskId) ?? task).gateNotes?.[watch.phase] ?? ''
        )
      }
      recordGate('rejected', motivo, readonly, 'dev', true, nextGateRound)
      cleanupReviewArtifact(watch)
      maybeAlarmGateLoop(watch, task, roundScores)
      // GATE VIVO: a reprovação limpa deixa o pane do gate ABERTO em espera;
      // o próximo done do dev recicla esta mesma conversa com o delta.
      const gatePhase = watch.phase
      if (watch.paneId && ptys.has(watch.paneId)) {
        liveGateWaits.set(watch.taskId, {
          phase: gatePhase,
          paneId: watch.paneId,
          rejectedHead: devFacts?.head,
          rejectedReason: motivo,
          rejectedAt: finishedAt,
          gateNotesAtRejection: JSON.stringify(
            tasks.get(watch.taskId)?.gateNotes?.[watch.phase] ?? ''
          )
        })
        hub.notifyPane(
          watch.paneId,
          '[synkora] veredito registrado. Este pane FICA ABERTO em espera: não toque em NADA — a rodada de correção do dev chega NESTA conversa com a fotografia nova, e você re-verifica só a sua lista + o delta.'
        )
        // gate vivo esperando não deixa browser/app de teste aberto na máquina
        ptys.reapVisualsOf(watch.paneId)
      } else {
        terminateTaskPhasePane(watch.projectId, watch.taskId, watch.phase)
      }
      hub.publish({ projectId: watch.projectId, missionId: task.missionId, kind: 'report', text: `${who} REPROVOU "${task.title}": ${motivo}`, actor: who })
      chainContinuation(retryOrBacklog(watch, who, motivo))
      return true
    } else if (watch.phase === 'review' && gates.includes('qa')) {
      // MEMOIZAÇÃO (2026-08-06): QA já aprovado para ESTE MESMO head (estado
      // que regrediu e voltou) não re-roda — segue direto para a conclusão.
      const qaEvidence = (tasks.get(watch.taskId) ?? task).verification?.qa
      const qaAlreadyApproved = Boolean(
        devFacts?.head &&
          qaEvidence?.verdict === 'approved' &&
          qaEvidence.snapshotHead === devFacts.head
      )
      if (qaAlreadyApproved) {
        recordGate('approved', motivo, readonly, 'finalize', true)
        cleanupReviewArtifact(watch)
        terminateTaskPhasePane(watch.projectId, watch.taskId, watch.phase)
        liveGateWaits.delete(watch.taskId)
        blackbox.record({
          cat: 'phase',
          event: 'gate-skipped-memoized',
          actor: 'harness',
          ids: { projectId: watch.projectId, missionId: task.missionId, taskId: watch.taskId, phase: 'qa' },
          evidence: `head ${devFacts?.head?.slice(0, 12)}`,
          reason: 'QA já aprovou este mesmo head — indo direto para a conclusão'
        })
        hub.publish({ projectId: watch.projectId, missionId: task.missionId, kind: 'report', text: `revisor aprovou "${task.title}" — QA já havia aprovado este mesmo commit; concluindo sem refazer`, actor: 'review' })
        chainContinuation(
          finalizeTask(watch, task, 'aprovada pelo revisor (QA memoizado para o mesmo head)')
        )
        if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
        syncBoard(watch.projectId)
        return true
      }
      recordGate('approved', motivo, readonly, 'qa', true)
      cleanupReviewArtifact(watch)
      terminateTaskPhasePane(watch.projectId, watch.taskId, watch.phase)
      liveGateWaits.delete(watch.taskId)
      emitLog(watch.projectId, { kind: 'log', tag: 'maestro', text: `🧐 revisor aprovou "${task.title}" — 🔎 QA entrando (pane real)` })
      hub.publish({ projectId: watch.projectId, missionId: task.missionId, kind: 'report', text: `revisor aprovou "${task.title}" — QA entrando`, actor: 'review' })
      chainContinuation(openGatePane(watch, 'qa'))
      return true
    } else {
      recordGate('approved', motivo, readonly, 'finalize', true)
      cleanupReviewArtifact(watch)
      terminateTaskPhasePane(watch.projectId, watch.taskId, watch.phase)
      liveGateWaits.delete(watch.taskId)
      chainContinuation(finalizeTask(watch, task, `aprovada pelo ${who}`))
    }
    if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
    syncBoard(watch.projectId)
    return true
  }

  const phaseMarkersProcessing = new Set<string>()
  // Cobre com folga a preparação assíncrona da fase (worktree ~1s + skill
  // sync ~0,7s + prompt); um card movido à mão espera no máximo isto a mais.
  const PHASE_WATCH_GRACE_MS = 30_000

  /** Poller de 3s (a parte de FASES; helpers/missões seguem no index). */
  function tickPhaseWatches(): void {
    for (const [taskId, watch] of [...phaseWatches]) {
      const task = tasks.get(taskId)
      const activeStatus = watch.phase === 'qa' ? 'qa' : 'execucao'
      // tarefa sumiu ou foi movida manualmente para fora da fase → solta.
      // JANELA DE GRAÇA (corrida real 2026-08-06): o preparePhasePane registra
      // o watch ANTES do tasks.update para a fase (awaits de skill sync no
      // meio) — status divergente em watch RECÉM-criado é preparação em curso,
      // nunca staleness. E soltar um watch NUNCA é silencioso: sem o evento na
      // caixa-preta, o report(done) recusado virou mistério de 10 minutos.
      // Card em TRANSIÇÃO (lock tomado) nunca é julgado stale nem "pane
      // perdido": um rollback re-indexado com createdAt vencido viraria fogo
      // amigo do terminatePaneNow (§7.4 do mapa da Fase 2).
      if (phaseTransitions.isLocked(taskId)) continue
      if (!task || (task.status !== activeStatus && !existsSync(watch.marker))) {
        if (task && Date.now() - watch.createdAt < PHASE_WATCH_GRACE_MS) continue
        phaseWatches.delete(taskId)
        if (watch.paneId) terminatePaneNow(watch.projectId, watch.paneId)
        blackbox.record({
          cat: 'phase',
          event: 'phase-watch-released',
          actor: 'harness',
          ids: {
            projectId: watch.projectId,
            missionId: task?.missionId,
            taskId,
            paneId: watch.paneId,
            phase: watch.phase,
            role: watch.phase
          },
          prev: `${task?.status ?? 'tarefa inexistente'}/${watch.phase}`,
          reason: task
            ? `card saiu do status ${activeStatus} sem marcador — watch da fase ${watch.phase} solto`
            : 'tarefa não existe mais — watch da fase solto'
        })
        continue
      }
      // RECONCILIADOR DE PANE PERDIDO (CHECK 17, 2026-08-07 — princípio do
      // dono: "perder mensagem pode custar segundos; perder a noite, não"):
      // panes:open é um push fire-and-forget — quando se perde (ctx.uiSender
      // sequestrado por overlay, renderer recarregando), o watch fica armado
      // com um paneId que NUNCA vira PTY e o pipeline inteiro espera em
      // SILÊNCIO (11min30s reais às 17:03Z). Estado manda, evento acelera:
      // fase pending com pane armado e inexistente além da graça se REABRE
      // sozinha, auditada, com teto anti-loop de 1 tentativa/2min.
      if (
        watch.paneId &&
        task.phaseState === 'pending' &&
        !ptys.has(watch.paneId) &&
        Date.now() - watch.createdAt > PHASE_WATCH_GRACE_MS &&
        (watch.lastOpenLostRetryAt === undefined ||
          Date.now() - watch.lastOpenLostRetryAt > 120_000)
      ) {
        watch.lastOpenLostRetryAt = Date.now()
        blackbox.record({
          cat: 'phase',
          event: 'pane-open-lost',
          actor: 'harness',
          ids: {
            projectId: watch.projectId,
            missionId: task.missionId,
            taskId,
            paneId: watch.paneId,
            phase: watch.phase,
            role: watch.phase
          },
          reason: `pane ${watch.phase} armado há ${Math.round((Date.now() - watch.createdAt) / 1000)}s nunca virou PTY (push panes:open perdido?) — reabrindo a fase automaticamente`
        })
        void (async () => {
          const launchToken = phaseLaunches.reserve(taskId)
          if (!launchToken) return
          try {
            phaseWatches.delete(taskId)
            if (watch.paneId) discardUnstartedPane(watch.paneId)
            const spec = await preparePhasePane(
              watch.projectId,
              taskId,
              watch.phase,
              watch.devSeatId,
              watch.devModel,
              watch.devEffort,
              undefined,
              launchToken
            )
            if (spec) {
              openPhasePane(spec, watch.projectId, taskId)
            } else {
              const current = tasks.get(taskId)
              if (current && !phaseWatches.has(taskId)) {
                tasks.update(taskId, {
                  activePhase: watch.phase,
                  phaseState: 'interrupted',
                  feedback: `o pane ${watch.phase} nao abriu; a fase foi preservada para retomada`
                })
                syncBoard(watch.projectId)
              }
            }
          } catch {
            const current = tasks.get(taskId)
            if (current && !phaseWatches.has(taskId)) {
              tasks.update(taskId, {
                activePhase: watch.phase,
                phaseState: 'interrupted',
                feedback: `falha ao reabrir o pane ${watch.phase}; a fase foi preservada para retomada`
              })
              syncBoard(watch.projectId)
            }
          } finally {
            phaseLaunches.release(taskId, launchToken)
          }
        })()
        continue
      }
      if (existsSync(watch.marker)) {
        // O arquivo-marcador é compatibilidade exclusiva do DEV. Gates só
        // avançam pelo report autenticado/validado; aceitar um verdict file
        // permitiria a uma tool externa contornar a ACL MCP.
        if (watch.phase !== 'dev') {
          try {
            ensureProjectRuntimeWritable(watch.projectId)
            unlinkSync(watch.marker)
            appendFileSync(
              watch.logFile,
              `\n[guard] marcador de ${watch.phase} ignorado; use MCP report\n`,
              'utf-8'
            )
          } catch {
            // Sem escrita segura, deixa o gate parado e tenta a limpeza depois.
          }
          if (watch.paneId) {
            hub.notifyPane(
              watch.paneId,
              `[synkora] veredito por arquivo foi recusado; gate ${watch.phase} conclui somente pela tool MCP report`
            )
          }
          continue
        }
        if (phaseMarkersProcessing.has(taskId)) continue
        phaseMarkersProcessing.add(taskId)
        void (async () => {
          try {
            let content = ''
            try {
              content = readFileSync(watch.marker, 'utf-8')
            } catch {
              return // ainda sendo escrito — tenta no próximo tick
            }
            try {
              ensureProjectRuntimeWritable(watch.projectId)
            } catch {
              return
            }
            if (watch.phase === 'dev') {
              const identity = watch.paneId ? hub.identityByPane(watch.paneId) : undefined
              if (!identity) return
              const skillScope = skillPlanScopes.get(identity.paneId)
              if (!skillScope) {
                try {
                  unlinkSync(watch.marker)
                } catch {
                  // marcador ja sumiu
                }
                hub.notifyPane(
                  identity.paneId,
                  '[synkora] conclusao recusada: o plano de skills desta rodada expirou; reabra somente esta fase'
                )
                return
              }
              const skillGuard = skillRuntime.guardReport({
                paneId: identity.paneId,
                phase: identity.phase ?? 'dev',
                phaseRun: skillScope.phaseRun,
                skillApplications: []
              })
              if (!skillGuard.ok) {
                try {
                  unlinkSync(watch.marker)
                } catch {
                  // marcador ja sumiu
                }
                hub.notifyPane(
                  identity.paneId,
                  '[synkora] conclusão por arquivo recusada: este pane tem um ACTIVE SKILL PLAN. Ative os receipts exigidos e conclua pela tool MCP report com skillApplications.'
                )
                return
              }
              const blocked = await codeReportGuard(identity)
              try {
                ensureProjectRuntimeWritable(watch.projectId)
              } catch {
                hub.notifyPane(
                  identity.paneId,
                  '[synkora] conclusão pausada: .synkora passou a ser rastreado pelo Git; retire o runtime do versionamento e reporte novamente'
                )
                return
              }
              if (blocked) {
                try {
                  unlinkSync(watch.marker)
                } catch {
                  // marcador já sumiu
                }
                try {
                  appendFileSync(watch.logFile, `\n[guard] ${blocked}\n`, 'utf-8')
                } catch {
                  // transcript é best-effort; a trava e o aviso continuam valendo
                }
                hub.notifyPane(identity.paneId, `[synkora] conclusão bloqueada: ${blocked}`)
                return
              }
            }
            // Re-check de VIGÊNCIA (mesmo objeto): cobre a rodada que FECHOU
            // por completo durante o await do guard (report venceu, watch novo
            // ou nenhum). A POSSE abaixo cobre a rodada EM VOO (report ainda
            // dentro da transação segura o lock e este acquire falha) — é ela
            // que substitui a identidade por referência como garantia (§3.2
            // regra 3 do plano; o caso rollback-de-mesmo-objeto §7.1 morre no
            // c5 com o lock atravessando os awaits do veredito).
            if (phaseWatches.get(taskId) !== watch) return
            const transitionToken = phaseTransitions.acquire(taskId, {
              label: 'poller:done',
              projectId: watch.projectId
            })
            if (!transitionToken) return
            try {
              unlinkSync(watch.marker)
            } catch {
              // já sumiu
            }
            phaseWatches.detach(taskId)
            // o advancePhase assume o release (imediato ou no settle da cadeia)
            advancePhase(watch, content, undefined, undefined, undefined, transitionToken)
          } finally {
            phaseMarkersProcessing.delete(taskId)
          }
        })()
      }
    }
  }

  /** Breaker de crash-loop de gate — escrito pelo onExit do PTY (fora do
   * engine): expõe a mecânica sem entregar o Map cru ao ciclo de vida do
   * pane. Devolve o placar para a mensagem do orquestrador. */
  function recordGateDeath(taskId: string): { looping: boolean; deaths: number } {
    const now = Date.now()
    const deaths = (gateDeathLog.get(taskId) ?? []).filter(
      (t) => now - t < GATE_DEATH_WINDOW_MS
    )
    deaths.push(now)
    gateDeathLog.set(taskId, deaths)
    const looping = deaths.length >= GATE_DEATH_LIMIT
    if (looping) gateCooldownUntil.set(taskId, now + 5 * 60_000)
    return { looping, deaths: deaths.length }
  }

  return {
    phaseWatches,
    phaseLaunches,
    phaseLaunchCapacity,
    phaseTransitions,
    phaseOccupancy,
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
    respawnInterruptedPhase,
    recoverFinalizingTask,
    taskIntegrationMarker,
    reviewArtifactProblem,
    cleanupReviewArtifact,
    readReviewArtifactChunk,
    tickPhaseWatches,
    recordGateDeath
  }
}

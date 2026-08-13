/**
 * MISSION ENGINE — ciclo de vida de missões e fila de integração (fase 1,
 * commit 6d).
 *
 * Corpo movido VERBATIM do closure do whenReady em index.ts (cirurgia do
 * índice, docs/FASE1_MAPA_MISSIONENGINE.md). O estado do domínio
 * (missionWatches, integrationDrainTimers, integrationDraining) nasce AQUI;
 * o index expõe aliases para os call sites legados (onExit do PTY, boot
 * recovery, extras do mcpApi/) e os getters do MainContext seguem
 * textualmente intactos.
 *
 * Contratos que este módulo NÃO pode quebrar:
 * - startMissionIntegration devolve string SÍNCRONA (mensagem da tool MCP e
 *   do IPC) — virar Promise quebraria integrate_mission/queue_missions em
 *   silêncio. pendingIntegrationApproval: ausência NUNCA é consentimento —
 *   só actor 'user' enfileira (F6.9).
 * - completeMissionMerge é wrapper fino da Fase 0
 *   (mainStalls.wrap('completeMissionMerge', …)) — manter par wrapper→Inner
 *   e o rótulo idêntico, senão o ranking de stall perde a série.
 * - missionWatches está MORTO (sem nenhum .set() em src/main — resíduo do
 *   gate de integração aposentado na F6.1); movido como está, remoção é
 *   card de higiene separado, nunca dentro da cirurgia.
 * - versionIsolationIsValid/releaseVersionImpl são domínio VERSÃO e ficam
 *   no index (extras) — mover inverteria o acoplamento com ipc/backlog.
 */
import { app } from 'electron'
import { join, resolve } from 'path'
import {
  alignWorktreeFromSnapshot,
  createMissionWorktree,
  createVersionWorktree,
  currentBranch,
  ensureSynkoraGitExcludes,
  gitCommitReached,
  gitHead,
  gitLocalBranchExists,
  hasGitCommit,
  initGitRepo,
  isExpectedWorktree,
  isWorktreeClean,
  missionWorktreeDescriptor,
  removeWorktreeAndBranch,
  resolveMissionWorkspace
} from './worktree'
import { type Mission, type NewMission } from './missions'
import { guiMissionPaneId, missionConflictRecipe } from './guiMissionContracts'
import { type IntegrationQueueTicketView } from './integrationQueue'
import {
  completeProjectMission as completeStoredProjectMission,
  deferProjectMission as deferStoredProjectMission,
  detachProjectMission as detachStoredProjectMission,
  loadProjectPlan,
  projectPlanReleaseGate,
  reactivateProjectMission as reactivateStoredProjectMission,
  startProjectMission as bindProjectMission,
  type ProjectPlan
} from './projectPlan'
import { manualSecurityValidationPending } from './manualSecurityValidation'
import { gitOff } from './gitAsync'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { type MissionWatch } from './phaseTypes'
import { type Task, type PlanVerificationCheckpoint } from './tasks'
import { type Version } from './backlog'
import { type MainContext } from './mainContext'

/**
 * Dependências do closure do index que o domínio de missões consome e que
 * ainda não migraram para módulos próprios — todas funções de delegação,
 * nenhum let mutável (diferente do phaseEngine, nada aqui é late-bound).
 */
export interface MissionEngineExtras {
  /** `${projectId}--${missionId}` — chave do maestroStore do orquestrador. */
  orchKey(projectId: string, missionId: string): string
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  /** Plano ativo da missão (card kind:'plan'). */
  currentPlanOf(projectId: string, missionId: string): Task | undefined
  finalVerificationAccepted(checkpoint: PlanVerificationCheckpoint | undefined): boolean
  /** Domínio VERSÃO — fica no index (também extra do ipc/backlog). */
  versionIsolationIsValid(
    projectPath: string,
    version: Version
  ): version is Version & { branch: string; worktree: string }
  /** Domínio backlog. */
  emitBacklogChanged(projectId: string): void
  /** Vassoura genérica do .synkora. */
  sweepProjectFiles(projectId: string, opts?: { preserveInterruptedHelpers?: boolean }): number
  /** Derruba servidor de teste com cwd sob o prefixo (antes do merge). */
  closeTestServersUnder(pathPrefix: string): void
  /** 2.0: entrega texto na CONVERSA do pane GUI (false = sem sessão viva).
   *  Late-bound no index — o registro do gui nasce depois deste engine. */
  deliverToGuiPane(paneId: string, text: string): boolean
  /** 2.0: encerra dev/reviewer/ajudantes GUI da missão (o worktree some). */
  killMissionGuiPanes(missionId: string): void
}

export type MissionEngine = ReturnType<typeof createMissionEngine>

export function createMissionEngine(ctx: MainContext, extras: MissionEngineExtras) {
  const {
    missions,
    projects,
    tasks,
    backlog,
    integrationQueue,
    maestro,
    ptys,
    blackbox,
    mainStalls,
    skillsLib,
    helperCompletions,
    helperReported,
    helperSeen,
    syncBoard,
    scheduleProgressSnapshot,
    projectModeOf,
    orchPaneId,
    unregisterPane,
    ensureProjectRuntimeWritable
  } = ctx
  // hub é atribuído UMA vez, antes de o engine nascer — capturar é seguro.
  const hub = ctx.hub
  const {
    orchKey,
    securityWaiverOptions,
    currentPlanOf,
    finalVerificationAccepted,
    versionIsolationIsValid,
    emitBacklogChanged,
    sweepProjectFiles,
    closeTestServersUnder,
    deliverToGuiPane,
    killMissionGuiPanes
  } = extras

  /** Missão 2.0: sem orquestrador e sem plano — o ⇪ tem caminho direto. */
  function isDirectMission(mission: Pick<Mission, 'direct'> | undefined): boolean {
    return mission?.direct === true
  }

  // ————— MISSÕES (F3.8): fluxos de trabalho com orquestrador próprio —————
  // Missão = branch/worktree isolados (com git) + pane orquestrador + tarefas
  // carimbadas. Integração = gate de review do diff completo → merge na base.

  function emitMissionsChanged(projectId: string): void {
    ctx.pushAll('missions:changed', projectId)
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
      ctx.codeIntelligence?.invalidateWorktreeNow(mission.worktree)
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
    // Dedupe por IDENTIDADE PERSISTENTE (2026-08-10): o marcador do briefing
    // morre em reescrita — queueSync é a placa que sobrevive. Um ticket por
    // missão de cada vez: QUALQUER card de sync vivo da missão conta como
    // existente (criar outro era a fábrica de fantasmas).
    const existing = tasks
      .list(mission.projectId)
      .find(
        (task) =>
          task.missionId === mission.id &&
          task.kind !== 'plan' &&
          (task.queueSync === true || task.briefing?.includes(`[fila:${ticket.id}:`))
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
        planId: plan.id,
        // Identidade PERSISTENTE de card do harness (2026-08-10): o marcador
        // [fila:...] do briefing morre se o briefing for reescrito — este
        // campo é o que mantém o card fora do contrato de proporcionalidade.
        queueSync: true
      }
    ])
    ctx.pushAll('tasks:changed', mission.projectId)
    return true
  }

  function repairIntegrationSyncTickets(projectId: string): void {
    const project = projects.get(projectId)
    if (!project) return
    for (const ticket of integrationQueue
      .listPending(projectId)
      .filter((candidate) => candidate.state === 'sync_required')) {
      // Qualquer card deste ticket, inclusive já done aguardando conclude_plan,
      // prova que não estamos na janela entre decisão e criação. Identidade
      // PERSISTENTE (2026-08-10): a detecção só por marcador criava um
      // FANTASMA a cada boot quando o briefing tinha sido reescrito (caso
      // real M06: duplicata em backlog ressuscitou o deadlock já resolvido).
      const syncCards = tasks
        .list(projectId)
        .filter(
          (task) =>
            task.missionId === ticket.missionId &&
            task.kind !== 'plan' &&
            (task.queueSync === true || task.briefing?.includes(`[fila:${ticket.id}:`))
        )
      // Autocura dos fantasmas de boots anteriores: fica UM card (o mais
      // avançado); duplicata parada em backlog sai com auditoria.
      if (syncCards.length > 1) {
        const rank = (s: string): number =>
          s === 'done' ? 3 : s === 'qa' ? 2 : s === 'execucao' ? 1 : 0
        const keep = [...syncCards].sort((a, b) => rank(b.status) - rank(a.status))[0]
        for (const ghost of syncCards) {
          if (ghost.id === keep.id || ghost.status !== 'backlog') continue
          tasks.remove(ghost.id)
          blackbox.record({
            cat: 'recovery',
            event: 'queue-sync-ghost-removed',
            actor: 'harness',
            ids: { projectId, missionId: ticket.missionId, taskId: ghost.id, ticketId: ticket.id },
            reason: `duplicata de card de sync em backlog removida no boot (identidade por marcador falhou em boot anterior); card mantido: ${keep.id.slice(0, 8)} (${keep.status})`
          })
        }
        ctx.pushAll('tasks:changed', projectId)
        syncBoard(projectId)
      }
      if (syncCards.length > 0) continue
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
    const missionProjectId = mission.projectId
    const missionTitle = mission.title
    // Bloqueio de integração NUNCA é mudo (2026-08-10: o clique do dono no ⇪
    // devolvia só uma string que virava banner — zero rastro no journal e
    // cara de clique morto): todo retorno bloqueante audita na caixa-preta
    // e, quando o gesto é do DONO, o orquestrador recebe o motivo como
    // evento urgente com a receita de destravar.
    const integrateBlocked = (code: string, msg: string): string => {
      blackbox.record({
        cat: 'queue',
        event: 'mission-integrate-blocked',
        actor,
        ids: { projectId: missionProjectId, missionId },
        reason: `${code}: ${msg.slice(0, 400)}`
      })
      if (actor === 'user')
        hub.publish({
          projectId: missionProjectId,
          missionId,
          kind: 'error',
          urgent: true,
          text: `⇪ do dono BLOQUEADO em "${missionTitle}": ${msg}`,
          actor: 'harness'
        })
      return msg
    }
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
    // MISSÃO 2.0 (direct): não existe plano, nem validação humana de plano,
    // nem verificação conjunta — o contrato é a conversa do dev com o dono e
    // o ⇪ é o aval. Tudo o que continua valendo (árvore limpa, heads, lacre,
    // FIFO, identidade do destino, precheck de conflito) vale IGUAL abaixo.
    const direct = isDirectMission(mission)
    const missionPlan = direct ? undefined : currentPlanOf(mission.projectId, missionId)
    if (!direct) {
      if (!missionPlan) {
        return integrateBlocked(
          'no-plan',
          'integração bloqueada: esta missão ainda não tem um plano aprovado e concluído — abra a aba da missão e combine o plano com o orquestrador'
        )
      }
      if (
        manualSecurityValidationPending(missionPlan.plan, securityWaiverOptions(mission.projectId))
      ) {
        return integrateBlocked(
          'security-validation',
          'integracao bloqueada: a validacao humana de seguranca deste plano continua pendente. Confirme a evidencia ou dispense com justificativa no card do plano.'
        )
      }
      if (missionPlan.status !== 'done') {
        return integrateBlocked(
          'plan-not-done',
          missionPlan.status === 'backlog'
            ? 'integração bloqueada: o plano da missão ainda aguarda sua aprovação (ou está pausado)'
            : 'integração bloqueada: o plano aprovado ainda está em execução — conclua todos os cards e o plano antes de integrar'
        )
      }
      if (missionPlan.plan?.verification && !finalVerificationAccepted(missionPlan.plan.verification.final)) {
        return integrateBlocked(
          'final-verification',
          'integração bloqueada: a verificação conjunta do plano não está aprovada'
        )
      }
    }
    // Fotografia lacrada pela verificação conjunta — só existe no fluxo legado.
    const verifiedFinal = missionPlan?.plan?.verification?.final
    const open = tasks
      .list(mission.projectId)
      .filter((t) => t.missionId === missionId && t.status !== 'done')
    if (open.length > 0)
      return integrateBlocked(
        'open-cards',
        `ainda há ${open.length} tarefa(s) não concluída(s) na missão — finalize (ou remova) antes de integrar: ${open
          .map((t) => `"${t.title}"`)
          .join(' · ')}`
      )
    mission = ensureMissionWorktree(missionId) ?? mission
    const gitProject = hasGitCommit(project.path)
    const missionSource = missionWorkspacePath(project.path, mission)
    if (!missionSource) {
      return integrateBlocked(
        'no-worktree',
        'integração bloqueada: não foi possível provar ou reanexar o worktree isolado da missão. A fila e a branch principal permaneceram intactas.'
      )
    }
    // PORTEIRA MECÂNICA DE INTEGRAÇÃO (2026-08-07): merge de missão anda SÓ
    // com gesto do DONO. Chamada de agente chegando aqui = missão validada e
    // pronta; registra a INTENÇÃO, o board pulsa, e o clique no ⇪ (actor
    // 'user') é o único caminho que executa.
    if (actor !== 'user') {
      // A porteira só anuncia "PRONTA" com a fotografia PROVADA (2026-08-10:
      // o agente registrou intenção com o head defasado, o botão pulsou e o
      // clique do dono bateu no bloqueio — botão pulsando para um clique que
      // ia falhar). Árvore suja/head defasado voltam com a receita, sem
      // registrar intenção.
      if (gitProject) {
        if (isWorktreeClean(missionSource) !== true)
          return integrateBlocked(
            'agent-dirty-tree',
            'a missão NÃO está pronta para o aval do dono: a branch tem alterações não commitadas depois dos gates — enquadre a árvore (commit auditado ou limpeza) antes de pedir integração'
          )
        const agentHead = gitHead(missionSource)
        if (verifiedFinal?.head && agentHead && verifiedFinal.head !== agentHead)
          return integrateBlocked(
            'agent-photo-stale',
            `a missão NÃO está pronta para o aval do dono: a branch mudou depois da verificação conjunta (${verifiedFinal.head.slice(0, 12)} → ${agentHead.slice(0, 12)}). Chame conclude_plan para REVALIDAR a fotografia (o plano reabre só para a verificação re-rodar e fecha sozinho); depois peça a integração de novo.`
          )
      }
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
    if (!gitProject) {
      // sem git não há merge: concluir é só marcar.
      missions.update(missionId, { status: 'concluida', pendingIntegrationApproval: false })
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
      return integrateBlocked(
        'git-meta',
        'integração bloqueada: metadados do isolamento Git estão incompletos'
      )
    }
    if (existsSync(missionIntegrationIntentPath(project.path, missionId))) {
      return integrateBlocked(
        'intent-journal',
        'integração bloqueada: existe um journal anterior ainda não reconciliado. Reinicie o Synkora para a recuperação segura ou repare o marcador antes de tentar novamente.'
      )
    }
    const target = resolveMissionIntegrationTarget(project, mission)
    if (!target)
      return integrateBlocked(
        'target',
        'integração bloqueada: não consegui preparar a branch de destino; a missão foi preservada'
      )
    if (isWorktreeClean(missionSource) !== true) {
      return integrateBlocked(
        'dirty-tree',
        'integração bloqueada: a branch da missão tem alterações não commitadas depois dos gates — peça ao orquestrador para enquadrar a árvore (commit auditado ou limpeza) e valide essa fotografia antes de entrar na fila'
      )
    }
    const sourceHead = gitHead(missionSource)
    const targetHead = gitHead(target.dir)
    if (!sourceHead || !targetHead)
      return integrateBlocked(
        'heads',
        'integração bloqueada: não consegui identificar os commits atuais da missão e do destino'
      )
    // Missão 2.0 não tem verificação conjunta: `verifiedFinal` é undefined e
    // esta cerca some sozinha — o lacre do ticket (sourceHead) segue valendo.
    if (verifiedFinal?.head && verifiedFinal.head !== sourceHead) {
      return integrateBlocked(
        'photo-stale',
        `integração bloqueada: a branch mudou depois da verificação conjunta (${verifiedFinal.head.slice(0, 12)} → ${sourceHead.slice(0, 12)}). RECEITA: o orquestrador chama conclude_plan para REVALIDAR a fotografia (o plano reabre só para a verificação re-rodar no head atual e fecha sozinho); depois clique ⇪ de novo.`
      )
    }
    // O AVAL do dono só se consome quando o clique ATRAVESSA todas as
    // checagens (2026-08-10: o clear precoce apagava a pulsação do botão
    // mesmo com o clique bloqueado — a intenção do agente se perdia).
    if (missions.get(missionId)?.pendingIntegrationApproval) {
      missions.update(missionId, { pendingIntegrationApproval: false })
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
        // 2.0: sem plano — o ticket entra sem planId (campo opcional da fila).
        planId: missionPlan?.id,
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
        planId: missionPlan?.id,
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
        // Missão 2.0 não tem plano nem verificação conjunta: o lacre que
        // sobrevive é o COMMIT (ticket.sourceHead) e a árvore limpa — as duas
        // cercas que provam que o que entra é o que o dono aprovou.
        const directTicket = isDirectMission(mission)
        const approvedPlan = directTicket ? undefined : currentPlanOf(projectId, mission.id)
        const openCards = tasks
          .list(projectId)
          .filter(
            (task) =>
              task.missionId === mission.id && task.kind !== 'plan' && task.status !== 'done'
          )
        const sourceHead = gitHead(missionSource)
        const snapshotProblems: string[] = []
        const approvedFinal = approvedPlan?.plan?.verification?.final
        if (!directTicket) {
          if (!approvedPlan || approvedPlan.status !== 'done')
            snapshotProblems.push('o plano aprovado não está concluído')
          if (approvedPlan?.plan?.verification && !finalVerificationAccepted(approvedFinal))
            snapshotProblems.push('a verificação conjunta não está aprovada')
        }
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
          // MISSÃO 2.0: destino que andou NÃO vira card de sincronização (não
          // há plano para reabrir nem orquestrador para disparar o card). O
          // precheck acima acabou de provar que a mescla é limpa contra o
          // destino ATUAL — cai fora do if e segue para o merge; conflito real
          // parou no bloqueio acima e a receita chegou na conversa do dev.
          if (!directTicket) {
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
    // MISSÃO 2.0: o bloqueio volta para QUEM ESCREVEU — não há orquestrador
    // para triar nem Maestro para decidir estratégia. O evento/auditoria de
    // sempre continua saindo (o board e o journal não perdem nada); o que se
    // soma é a receita chegando na conversa viva do dev.
    if (isDirectMission(mission)) {
      const paneId = guiMissionPaneId('dev', mission.id)
      const delivered = deliverToGuiPane(
        paneId,
        missionConflictRecipe({
          missionTitle: mission.title,
          detail,
          targetBranch: target?.branch,
          sourceBranch: mission.branch
        })
      )
      blackbox.record({
        cat: 'queue',
        event: 'direct-mission-block-to-dev',
        actor: 'harness',
        ids: { projectId: mission.projectId, missionId: mission.id, paneId },
        reason: delivered
          ? `receita do bloqueio entregue na conversa do dev: ${detail.slice(0, 300)}`
          : `conversa do dev não está aberta — a receita fica no board: ${detail.slice(0, 300)}`
      })
    }
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
        ctx.codeIntelligence?.invalidateWorktreeNow(cleanupSource.dir)
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
    // nele travaria a remoção). Na missão 2.0 quem tem cwd lá dentro são os
    // panes GUI (dev, reviewer e ajudantes) — mesmo motivo, mesma hora.
    ptys.kill(orchPaneId(projectId, missionId))
    killMissionGuiPanes(missionId)
    ctx.codeIntelligence?.invalidateWorktreeNow(missionSource)
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
    ctx.pushAll('panes:closeById', watch.projectId, watch.paneId)
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

  function stopMissionExecution(projectId: string, missionId: string, reason: string): void {
    const missionTaskIds = new Set(
      tasks
        .list(projectId)
        .filter((task) => task.missionId === missionId && task.kind !== 'plan')
        .map((task) => task.id)
    )
    for (const taskId of missionTaskIds) {
      // F2-c4 (§5.3 do mapa da Fase 2): card em TRANSIÇÃO não entra na parada
      // em lote — apagar o watch/marcador sob um veredito em voo perderia a
      // rodada. Os chamadores pré-checam e recusam a operação inteira; este
      // continue é o cinto contra a corrida entre a checagem e a execução.
      if (ctx.phaseTransitions.isLocked(taskId)) {
        blackbox.record({
          cat: 'phase',
          event: 'mission-stop-skipped-transition',
          actor: 'harness',
          ids: { projectId, missionId, taskId },
          reason: `card em transição sob ${
            ctx.phaseTransitions.holderLabel(taskId) ?? '?'
          } — a parada da missão pulou este card; o veredito em voo decide o estado dele`
        })
        continue
      }
      // phaseWatches/livePaneSpecs em CALL TIME via ctx: os aliases do index
      // nascem no createPhaseEngine, DEPOIS deste engine — destructurar na
      // construção seria TDZ.
      const watch = ctx.phaseWatches.get(taskId)
      ctx.phaseWatches.delete(taskId)
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
      ctx.livePaneSpecs.delete(pane.paneId)
      ctx.pushAll('panes:closeById', projectId, pane.paneId)
    }
    syncBoard(projectId)
  }

  /** Poller de 3s (a parte de MISSÕES; fases e watchdog de helper seguem no
   * index). Marcadores de INTEGRAÇÃO de missão (fallback do report MCP do
   * gate). Preservar o catch { continue } do runtime não gravável: sem ele,
   * um projeto com .synkora versionado travaria o poller inteiro. */
  function tickMissionWatches(): void {
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
  }

  return {
    // ——— estado (nasce aqui; ctx expõe por getter via alias no index) ———
    missionWatches,
    integrationDrainTimers,
    integrationDraining,
    // ——— ciclo de vida de missão ———
    emitMissionsChanged,
    missionsWithIntegration,
    missionWorkspacePath,
    ensureMissionWorktree,
    createMissionImpl,
    ensureMissionVersion,
    stopMissionExecution,
    // ——— vínculo com o plano mestre (roadmap) ———
    writeMissionStartIntent,
    clearMissionStartIntent,
    rollbackPlannedMission,
    ensurePlannedMissionBacklogItem,
    transitionLinkedProjectPlanMission,
    reconcileConcludedMission,
    // ——— fila de integração ———
    resolveMissionIntegrationTarget,
    createIntegrationSyncTask,
    scheduleIntegrationDrain,
    startMissionIntegration,
    handleMissionVerdict,
    // ——— recuperação (chamada pelo boot) ———
    recoverMissionStartIntents,
    recoverMissionIntegrationIntents,
    repairIntegrationSyncTickets,
    // ——— tick do poller de 3s ———
    tickMissionWatches
  }
}

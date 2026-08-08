/**
 * IPC — domínio missions (fase 1, commit 6f).
 * Missões pelo renderer: CRUD, confirmação/troca de conta do orquestrador,
 * integração (botão ⇪) e a spec do pane TUI do orquestrador. A mecânica mora
 * no missionEngine (extras.engine); o lado maestro do paneSpec
 * (resume budget/planejamento) vem do maestroEngine pelos extras, e o pane
 * lifecycle (armPane/stagger) segue no index até a obra própria.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import. A cerca anti-ressurreição do paneSpec
 * (orchestrator-respawn-refused-integration-in-flight) é o par do kill do
 * orquestrador feito por completeMissionMergeInner no missionEngine — os
 * dois lados vivem em módulos diferentes de propósito; o comentário no
 * handler conta a história da corrida da M02d.
 */
import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { ensureSynkoraGitExcludes, removeWorktreeAndBranch } from '../worktree'
import { gitOff } from '../gitAsync'
import { type NewMission } from '../missions'
import { assessMissionRisk } from '../orchestratorFlow'
import { missionPersona } from '../maestro'
import { ensureProjectSecurityBaseline } from '../projectSecurityBaseline'
import { requiresManualSecurityValidation } from '../securityPolicy'
import { migrateCliSessionBetweenSeats } from '../cliSessionTransplant'
import type { PaneIdentity } from '../hub'
import type { SeatCli } from '../seats'
import type { MainContext } from '../mainContext'
import type { MissionEngine } from '../missionEngine'
import type { MaestroEngine } from '../maestroEngine'

/** Dependências do closure do index ainda não migradas (mesmo padrão dos
 * outros ipc/*). Os dois engines viajam inteiros; o lado maestro do
 * paneSpec (budget de resume + método de planejamento) vem do maestroEngine. */
export interface MissionsIpcExtras {
  engine: MissionEngine
  maestroEngine: Pick<
    MaestroEngine,
    'maestroResumeOverBudget' | 'skipMaestroResume' | 'preparePlanningRun'
  >
  bindUiSender(sender: Electron.WebContents): void
  /** `${projectId}--${missionId}` — chave do maestroStore do orquestrador. */
  orchKey(projectId: string, missionId: string): string
  emitBacklogChanged(projectId: string): void
  staggerPaneSpawn(): Promise<void>
  armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts?: { strictMcp?: boolean; configDir?: string; sensitive?: boolean }
  ): { paneId: string; cliArgs: string[] }
  /** Late-bound: let do index. */
  releasePaneSkillPlan(paneId: string): void
  codexDeveloperInstructions(value: string): string
}

export function registerMissionsIpc(ctx: MainContext, extras: MissionsIpcExtras): void {
  const {
    projects,
    seats,
    missions,
    tasks,
    backlog,
    maestro,
    integrationQueue,
    ptys,
    blackbox,
    hub,
    syncBoard,
    projectModeOf,
    projectPlanOf,
    orchPaneId,
    unregisterPane,
    releasePaneSkillLease
  } = ctx
  const {
    engine,
    bindUiSender,
    orchKey,
    emitBacklogChanged,
    staggerPaneSpawn,
    armPane,
    releasePaneSkillPlan,
    codexDeveloperInstructions
  } = extras
  const { maestroResumeOverBudget, skipMaestroResume, preparePlanningRun } = extras.maestroEngine
  const {
    missionsWithIntegration,
    createMissionImpl,
    emitMissionsChanged,
    ensureMissionWorktree,
    missionWorkspacePath,
    scheduleIntegrationDrain,
    startMissionIntegration,
    stopMissionExecution,
    transitionLinkedProjectPlanMission
  } = engine

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
          // F2-c4 (§5.3 do mapa da Fase 2): arquivar com veredito em voo
          // perderia a rodada — recusa ANTES de qualquer mutação, com receita.
          const inTransition = tasks
            .list(mission.projectId)
            .filter(
              (t) => t.missionId === mission.id && ctx.phaseTransitions.isLocked(t.id)
            )
          if (inTransition.length > 0) {
            hub.publish({
              projectId: mission.projectId,
              kind: 'error',
              text: `não arquivei "${mission.title}": há veredito de fase fechando em ${inTransition
                .map((t) => `"${t.title}"`)
                .join(', ')} — aguarde alguns segundos e tente de novo`,
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

  // Excluir missão: só ARQUIVADA (fluxo: arquivar → excluir). Leva junto as
  // tarefas dela e limpa worktree/branch — a exclusão é deliberada.
  ipcMain.handle('missions:remove', (e, missionId: string) => {
    bindUiSender(e.sender)
    const mission = missions.get(missionId)
    if (!mission || mission.status !== 'arquivada') return false
    const project = projects.get(mission.projectId)
    if (!project) return false
    // F2-c4 (§5.3): exclusão com veredito em voo em card da missão — recusa
    // com receita antes de qualquer mutação (missão arquivada raramente tem
    // transição viva; o caso é corrida real de segundos).
    const inTransition = tasks
      .list(mission.projectId)
      .filter((t) => t.missionId === missionId && ctx.phaseTransitions.isLocked(t.id))
    if (inTransition.length > 0) {
      hub.publish({
        projectId: mission.projectId,
        kind: 'error',
        text: `não excluí a missão "${mission.title}": há veredito de fase fechando em ${inTransition
          .map((t) => `"${t.title}"`)
          .join(', ')} — aguarde alguns segundos e tente de novo`,
        actor: 'harness'
      })
      return false
    }
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
      ctx.codeIntelligence?.invalidateWorktreeNow(mission.worktree)
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
    if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', mission.projectId)
    emitMissionsChanged(mission.projectId)
    syncBoard(mission.projectId)
    return true
  })

  // Spec do pane TUI do ORQUESTRADOR da missão (mesma mecânica do PM: persona
  // via --append-system-prompt/1º prompt + resume + MCP). O seat é herdado do
  // PM na primeira abertura e fica preso à missão (sessão pertence ao seat).
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
    // TRAVADINHA DA ABERTURA (triagem 2026-08-08, ESTADO 9): o caminho quente
    // rodava ~18 execFileSync de git NO MAIN (~450ms por missão — culpado
    // nomeado pelo journal: ipc:missions:paneSpec ×3 num stall de ~1,5s). A
    // leitura agrupada viaja UMA vez pelo gitWorker; qualquer divergência cai
    // no caminho completo síncrono de sempre (promoção/reparo, raro).
    const readout = await gitOff(
      'missionWorkspaceReadout',
      project.path,
      mission.id,
      mission.branch,
      mission.worktree
    )
    // Janela de await: revalida o estado que as guardas do topo checaram.
    {
      const fresh = missions.get(missionId)
      if (!fresh || fresh.projectId !== projectId) return null
      if (fresh.status === 'concluida' || fresh.status === 'arquivada') return null
      if (fresh.pendingOrchestrator || fresh.status === 'integrando') return null
      mission = fresh
    }
    if (readout.excludesError) {
      // Mesmo guard mudo do missions:remove (02/08): sem esta mensagem o
      // orquestrador simplesmente NÃO abria e nada explicava o porquê.
      hub.publish({
        projectId,
        missionId,
        kind: 'error',
        text: `não abri o orquestrador de "${mission.title}": ${readout.excludesError}`,
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
    let missionCwd: string | undefined
    if (readout.healthy) {
      // fast path: missão saudável — zero git no main.
      missionCwd = readout.workspace
    } else {
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
      missionCwd = missionWorkspacePath(project.path, mission)
    }
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
}

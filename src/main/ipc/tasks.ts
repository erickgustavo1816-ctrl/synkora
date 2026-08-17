/**
 * IPC — domínio tasks (fase 1, commit 5).
 * Cards pelo renderer: CRUD, aprovação/pausa de plano, validação de
 * segurança, troca de executor de fase e o disparo humano (tasks:run).
 * Máquina de fases sempre via ctx.phase (inclui closeLiveGateWait, 5e).
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import {
  sanitizeRendererTaskPatch,
  type NewTask,
  type PlanLane,
  type PlanVerificationCheckpoint,
  type Task,
  type TaskPlan
} from '../tasks'
import { gitHead } from '../worktree'
import { type Mission } from '../missions'
import {
  EXECUTION_MODE_LABEL,
  assessMissionRisk,
  gatesForTask,
  normalizeExecutionMode,
  normalizeRiskLevel
} from '../orchestratorFlow'
import { resolveManualSecurityValidation } from '../manualSecurityValidation'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface TasksIpcExtras {
  assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  removeTaskCascade(task: Task): boolean
  fmtLane(l: PlanLane): string
  ensurePlanBaseline(planTask: Task): Promise<PlanVerificationCheckpoint>
  missionWorkspacePath(projectPath: string, mission: Mission): string | undefined
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  setPhaseExecutorImpl(
    projectId: string,
    taskId: string,
    choice: { seatId: string; model?: string; effort?: string },
    swapActor: 'user' | 'maestro',
    ownerOrder?: string
  ): Promise<{ ok: boolean; msg: string }>
}

export function registerTasksIpc(ctx: MainContext, extras: TasksIpcExtras): void {
  const {
    tasks,
    seats,
    projects,
    missions,
    blackbox,
    maestro,
    backlog,
    phaseWatches,
    syncBoard,
    projectModeOf,
    projectPlanOf,
    hub
  } = ctx
  const {
    assertMainRendererSender,
    removeTaskCascade,
    fmtLane,
    ensurePlanBaseline,
    missionWorkspacePath,
    securityWaiverOptions,
    setPhaseExecutorImpl
  } = extras
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
      (manualDeliverable === 'code' ? ['front', 'design'].includes(item.department) : false)
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
          manualAffectsUi === true,
          item.department
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
    // F2-c4 (§5.12 do mapa da Fase 2): card em TRANSIÇÃO (lock tomado, watch
    // detached) conta como pane ativo — o kanban não move card por baixo do
    // veredito em processamento.
    const hasActivePane =
      phaseWatches.has(id) ||
      ctx.phaseTransitions.isLocked(id) ||
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

  ipcMain.handle('tasks:remove', (e, id: string) => {
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
    ctx.pushAll('tasks:changed', task.projectId)
    syncBoard(task.projectId)
  })

  ipcMain.handle('tasks:planApprove', (e, taskId: string, lanes: PlanLane[], seenRevision?: string) => {
    const task = tasks.get(taskId)
    if (!task || task.kind !== 'plan' || !task.plan || task.status !== 'backlog') return undefined
    // CAS DA APROVAÇÃO (caso real E2E 2026-08-05: o orquestrador re-propôs o
    // plano ENQUANTO o usuário podia estar lendo a versão anterior — aprovar
    // a v1 com a v2 no card seria contrato errado). A UI manda a revisão que
    // o usuário VIU; plano mudou desde então → recusa e o modal recarrega.
    if (seenRevision && task.updatedAt !== seenRevision) {
      return { staleRevision: true, currentRevision: task.updatedAt }
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
    ctx.pushAll('tasks:changed', task.projectId)
    syncBoard(task.projectId)
    return updated
  })

  ipcMain.handle('tasks:planStop', (e, taskId: string) => {
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
    ctx.pushAll('tasks:changed', task.projectId)
    syncBoard(task.projectId)
    return updated
  })

  ipcMain.handle(
    'tasks:planSecurityValidation',
    (
      e,
      taskId: string,
      decision: 'approved' | 'waived',
      evidence: string
    ) => {
      assertMainRendererSender(e)
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
      ctx.pushAll('tasks:changed', task.projectId)
      syncBoard(task.projectId)
      return updated
    }
  )

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
      return setPhaseExecutorImpl(projectId, taskId, choice, 'user')
    }
  )

  ipcMain.handle(
    'tasks:run',
    async (e, projectId: string, taskId: string, seatId: string, model?: string, effort?: string) => {
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
      const spec = await ctx.phase.preparePhasePane(projectId, taskId, 'dev', seatId, model, effort)
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
}

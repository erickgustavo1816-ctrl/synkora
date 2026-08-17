/**
 * MCP API — domínio board (fase 1, commit 4c).
 * O board pelo olhar dos agentes: status completo, cards, plano da
 * missão, disparo de fases (run_task), conclusão verificada e troca de
 * executor por ordem do dono.
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing; uiSender/mcpPort e a
 * máquina de fases são lidos via ctx (getters/ctx.phase).
 */
import { app } from 'electron'
import { join } from 'path'
import { type SeatCli } from '../seats'
import {
  type Department,
  type NewTask,
  type PlanLane,
  type PlanVerificationCheckpoint,
  type Task,
  type TaskPlan,
  type TaskUpdatePatch
} from '../tasks'
import { gitHead, hasGitCommit, isWorktreeClean } from '../worktree'
import { releaseQaCdpPort } from '../qaCdp'
import { type Mission } from '../missions'
import {
  EXECUTION_MODE_LABEL,
  assessMissionRisk,
  gatesForTask,
  isHarnessQueueCard,
  newTaskDelegationProblem,
  normalizeDelegationMode,
  normalizeExecutionMode,
  normalizeRiskLevel,
  validatePlanCompletion,
  validatePlanDependencies,
  validatePlanSizing,
  validateTaskSizing
} from '../orchestratorFlow'
import { GATE_DEATH_LIMIT, MAX_PARALLEL_RUNS } from '../phaseEngine'
import { SECURITY_POLICY_VERSION, requiresManualSecurityValidation } from '../securityPolicy'
import {
  initialManualSecurityValidation,
  manualSecurityValidationPending
} from '../manualSecurityValidation'
import { type PolicySlot } from '../policies'
import { getCatalog } from '../catalog'
import { type PaneIdentity } from '../hub'
import { type TaskPatch } from '../mcpServer'
import { summarizeProjectPlanForBoard } from '../projectPlan'
import { prepareTaskAdjustment, unapprovedAdjustmentRiskSurfaces } from '../taskAdjustment'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface BoardApiExtras {
  currentPlanOf(projectId: string, missionId: string): Task | undefined
  finalVerificationAccepted(checkpoint: PlanVerificationCheckpoint | undefined): boolean
  resumePlanVerificationIfNeeded(planTask: Task | undefined): void
  baselineVerificationUsable(checkpoint: PlanVerificationCheckpoint | undefined): boolean
  ensurePlanBaseline(planTask: Task): Promise<PlanVerificationCheckpoint>
  startFinalPlanVerification(planTask: Task, conclusion: string): void
  closeVerifiedPlan(planId: string): void
  removeTaskCascade(task: Task): boolean
  ensureMissionWorktree(missionId: string): Mission | undefined
  missionWorkspacePath(projectPath: string, mission: Mission): string | undefined
  isBannedModel(m?: string): boolean
  agentModelPool(seat: { cli: SeatCli; id: string }): Promise<{ id: string; label: string }[]>
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  planTaskForWorkTask(task: Task): Task | undefined
  setPhaseExecutorImpl(
    projectId: string,
    taskId: string,
    choice: { seatId: string; model?: string; effort?: string },
    swapActor: 'user' | 'maestro',
    ownerOrder?: string
  ): Promise<{ ok: boolean; msg: string }>
}

export function buildBoardApi(
  ctx: MainContext,
  extras: BoardApiExtras
): Pick<
  McpApi,
  | 'boardStatus'
  | 'createTasks'
  | 'updateTask'
  | 'createPlan'
  | 'runTask'
  | 'concludePlan'
  | 'completeTask'
  | 'stopTask'
  | 'deleteTask'
  | 'setPhaseExecutor'
> {
  const {
    tasks,
    seats,
    projects,
    missions,
    blackbox,
    maestro,
    policies,
    integrationQueue,
    backlog,
    phaseWatches,
    gateCooldownUntil,
    phaseLaunches,
    phaseLaunchCapacity,
    finalVerificationRuns,
    emitLog,
    syncBoard,
    projectModeOf,
    projectPlanOf
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  const {
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
    securityWaiverOptions,
    planTaskForWorkTask,
    setPhaseExecutorImpl
  } = extras
  return {
    boardStatus: (id) => {
      if (id.missionId) resumePlanVerificationIfNeeded(currentPlanOf(id.projectId, id.missionId))
      // Orquestrador de missão vê SÓ as tarefas da missão dele; o PM vê tudo
      // (agrupado) + o resumo das missões. O card de PLANO (F5.7) sai da lista
      // de tarefas e ganha seção própria.
      const allRaw = tasks
        .list(id.projectId)
        .filter((t) => !id.missionId || t.missionId === id.missionId)
      const all = allRaw.filter((t) => t.kind !== 'plan')
      const planLabel = (p: Task): string => {
        const final = p.plan?.verification?.final
        const verification = final?.status === 'running' || final?.status === 'pending'
          ? ' · validação conjunta em andamento'
          : final?.comparison?.status === 'blocked'
            ? ' · validação conjunta BLOQUEADA'
            : finalVerificationAccepted(final)
              ? ' · conjunto verificado'
              : ''
        const label = p.status === 'backlog'
          ? p.plan?.approvedAt
            ? 'PAUSADO pelo usuário — aguardando re-aprovação'
            : 'proposto — aguardando aprovação do usuário'
          : p.status === 'execucao'
            ? 'APROVADO — em execução (você dirige: create_tasks + run_task)'
            : 'concluído'
        return label + verification
      }
      const panes = hub.panesOf(id.projectId).map((p) => ({
        role: p.role,
        taskId: p.taskId,
        taskTitle: p.taskId ? tasks.get(p.taskId)?.title : undefined
      }))
      const ms = missions.list(id.projectId)
      const integrationLane = integrationQueue.listPending(id.projectId)
      const productPlan = id.missionId ? undefined : projectPlanOf(id.projectId)
      const missionOf = (mid?: string): string | undefined =>
        mid ? ms.find((m) => m.id === mid)?.title : undefined
      return JSON.stringify(
        {
          ...(id.missionId
            ? { missao: (() => {
                const m = missions.get(id.missionId)
                return m
                  ? {
                      id: m.id,
                      title: m.title,
                      status: m.status,
                      branch: m.branch,
                      baseBranch: m.baseBranch,
                      filaIntegracao: integrationQueue.getByMission(m.id) ?? null
                    }
                  : undefined
              })(),
              plano: (() => {
                const p = currentPlanOf(id.projectId, id.missionId)
                return p
                  ? {
                      id: p.id,
                      title: p.title,
                      status: planLabel(p),
                      lanes: p.plan?.lanes,
                      fluxo: EXECUTION_MODE_LABEL[normalizeExecutionMode(p.plan?.executionMode)],
                      risco: normalizeRiskLevel(p.plan?.risk),
                      politicaSeguranca: p.plan?.securityPolicyVersion
                        ? `Synkora v${p.plan.securityPolicyVersion}`
                        : 'plano legado',
                      superficiesSensiveis: p.plan?.riskSurfaces ?? [],
                      motivosDeSeguranca: p.plan?.riskReasons ?? [],
                      validacaoHumanaNecessaria:
                        p.plan?.manualSecurityValidationRequired ?? false,
                      motivoDoTamanho: p.plan?.sizingReason,
                      cardsPrevistos: p.plan?.expectedCards,
                      ...(p.plan?.conclusion ? { conclusao: p.plan.conclusion } : {})
                    }
                  : 'nenhum — proponha com create_plan'
              })() }
            : {
                modoProjeto: projectModeOf(id.projectId),
                planoProjeto: productPlan
                  ? {
                      status: productPlan.status,
                      resumo: summarizeProjectPlanForBoard(productPlan),
                      progresso: `${productPlan.roadmap.filter((item) => item.status === 'done').length}/${productPlan.roadmap.length}`,
                      ondaAtual: productPlan.currentWaveId ?? null,
                      missoesAtivas: productPlan.activeItemIds.map(
                        (itemId) => productPlan.roadmap.find((item) => item.id === itemId)?.title ?? itemId
                      ),
                      missoesProntas: productPlan.readyItemIds.map(
                        (itemId) => productPlan.roadmap.find((item) => item.id === itemId)?.title ?? itemId
                      ),
                      roadmap: productPlan.roadmap.map((item) => ({
                        id: item.id,
                        title: item.title,
                        status: item.status,
                        wave: item.wave,
                        dependsOn: item.dependsOn,
                        missionId: item.missionId,
                        version: item.version?.name
                      })),
                      arquivo: '.synkora/PROJECT_PLAN.md'
                    }
                  : null,
                missoes: ms.map((m) => ({
                  id: m.id,
                  title: m.title,
                  status: m.status,
                  branch: m.branch,
                  scope: m.scope,
                  filaIntegracao: integrationQueue.getByMission(m.id) ?? null,
                  tarefas: tasks
                    .list(id.projectId)
                    .filter((t) => t.missionId === m.id && t.kind !== 'plan').length,
                  ...(() => {
                    const p = m.kind === 'direta' ? undefined : currentPlanOf(id.projectId, m.id)
                    return p ? { plano: planLabel(p) } : {}
                  })()
                })),
                filaIntegracao: integrationLane.map((ticket) => ({
                  posicao: ticket.position,
                  total: ticket.total,
                  missaoId: ticket.missionId,
                  missao: ms.find((mission) => mission.id === ticket.missionId)?.title,
                  estado: ticket.state,
                  bloqueio: ticket.block,
                  orientacaoMaestro: ticket.resolution
                })),
                // roadmap do PO: versões do backlog + itens ainda não feitos
                backlogVersoes: backlog.listVersions(id.projectId).map((v) => ({
                  id: v.id,
                  name: v.name,
                  theme: v.theme,
                  status: v.status,
                  branch: v.branch,
                  jaSubiuNaVersao: v.deliveries.map((d) => d.title),
                  itensPendentes: backlog
                    .listItems(id.projectId)
                    .filter((i) => i.versionId === v.id && i.status !== 'feito')
                    .map((i) => `[${i.type}] ${i.title}`)
                })),
                versaoAtualNaMain:
                  backlog
                    .listVersions(id.projectId)
                    .filter((v) => v.status === 'lancada')
                    .sort((a, b) => (a.releasedAt ?? '').localeCompare(b.releasedAt ?? ''))
                    .at(-1)?.name ?? null,
                backlogSemVersao: backlog
                  .listItems(id.projectId)
                  .filter((i) => !i.versionId && i.status !== 'feito')
                  .map((i) => `[${i.type}] ${i.title}`)
              }),
          tasks: all.map((t) => ({
            id: t.id,
            department: t.department,
            type: t.type,
            effort: t.effort,
            title: t.title,
            status: t.status,
            cycles: t.cycles,
            feedback: t.feedback,
            faseAtiva: t.activePhase,
            estadoDaFase: t.phaseState,
            delegacao: t.delegation,
            runSeat: t.runSeat,
            runModel: t.runModel,
            ...(id.missionId ? {} : { missao: missionOf(t.missionId) ?? '(geral)' })
          })),
          panesAbertos: panes,
          arquivos: {
            board: '.synkora/BOARD.md',
            eventos: '.synkora/EVENTS.md',
            transcripts: '.synkora/runs/<taskId>.md',
            reports: '.synkora/reports/ (relatórios/auditorias de agentes — NUNCA .md solto na raiz/docs)',
            ...(!id.missionId && productPlan
              ? { planoMestre: '.synkora/PROJECT_PLAN.md' }
              : {}),
            ...(id.missionId
              ? { planoDaMissao: `.synkora/missions/${id.missionId.slice(0, 8)}.PLAN.md` }
              : {})
          }
        },
        null,
        2
      )
    },
    createTasks: (id, items) => {
      const invalidDelegations = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => newTaskDelegationProblem(item.delegation) !== undefined)
      if (invalidDelegations.length > 0) {
        return `todo card novo precisa declarar delegation="none" ou delegation="parallel"; optional é apenas legado: ${invalidDelegations.map(({ index }) => index + 1).join(', ')}`
      }
      const oversizedBriefings = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => (item.briefing?.length ?? 0) > 6000)
      if (oversizedBriefings.length > 0) {
        return `briefing excede o teto autoritativo de 6000 caracteres nos cards: ${oversizedBriefings.map(({ index }) => index + 1).join(', ')}; resuma sem remover critérios de aceite`
      }
      const overloadedSkillPlans = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => (item.skills?.length ?? 0) > 1 || (item.agents?.length ?? 0) > 1)
      if (overloadedSkillPlans.length > 0) {
        return `cards aceitam no máximo uma skill técnica e um subagente especialista explícitos: ${overloadedSkillPlans.map(({ index }) => index + 1).join(', ')}`
      }
      const missingUiDeclarations = items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item }) =>
            item.deliverable === 'code' && typeof item.affectsUi !== 'boolean'
        )
      if (missingUiDeclarations.length > 0) {
        return `todo card de código precisa declarar affectsUi explicitamente: ${missingUiDeclarations.map(({ index }) => index + 1).join(', ')}`
      }
      if (id.role !== 'maestro' || !id.missionId)
        return 'só o orquestrador da missão cria cards de trabalho'
      const mission = missions.get(id.missionId)
      if (!mission || mission.projectId !== id.projectId || mission.status !== 'ativa')
        return 'a missão deste orquestrador não está ativa neste projeto'
      const queuedMission = integrationQueue.getByMission(id.missionId)
      if (queuedMission)
        return `esta missão está na posição #${queuedMission.position} da fila; novos cards avulsos estão congelados. Execute apenas o card de sincronização/conflito que a própria fila criar.`
      if (
        !id.missionId &&
        projectModeOf(id.projectId) === 'greenfield' &&
        projectPlanOf(id.projectId)?.status !== 'done'
      ) {
        return 'este projeto novo ainda segue o plano mestre — tarefas soltas não são permitidas; use start_project_mission somente para a próxima missão aprovada'
      }
      // F5.7: numa missão plan-driven nada nasce antes da aprovação; depois
      // dela os cards do orquestrador nascem AUTO (visuais para o usuário —
      // quem executa é o orquestrador via run_task).
      let auto = false
      let activePlanId: string | undefined
      if (id.role === 'maestro' && id.missionId) {
        const plan = currentPlanOf(id.projectId, id.missionId)
        if (plan && plan.status === 'backlog')
          return 'o PLANO desta missão ainda aguarda a aprovação do usuário — nenhum card de trabalho nasce antes disso (ajuste a proposta com create_plan se precisar)'
        auto = plan?.status === 'execucao'
        // carimbo do plano: o modal/progresso de cada plano lista SÓ os
        // cards dele (2 planos na mesma missão não se misturam)
        if (auto) activePlanId = plan?.id
      }
      const approvedPlan = currentPlanOf(id.projectId, id.missionId)
      if (!approvedPlan || approvedPlan.status !== 'execucao')
        return approvedPlan?.status === 'backlog'
          ? 'o PLANO desta missão ainda aguarda a aprovação do usuário — nenhum card de trabalho nasce antes disso'
          : 'nenhum card nasce sem um plano aprovado em execução nesta missão'
      auto = true
      activePlanId = approvedPlan.id
      const executionMode = normalizeExecutionMode(approvedPlan.plan?.executionMode)
      const risk = normalizeRiskLevel(approvedPlan.plan?.risk)
      const runtimeRisk = assessMissionRisk({
        declaredRisk: risk,
        texts: items.flatMap((item) => [
          item.title,
          item.description,
          item.briefing,
          ...(item.quests ?? [])
        ])
      })
      if (runtimeRisk.raised) {
        return `os cards revelaram risco ${runtimeRisk.effectiveRisk} acima do plano aprovado (${risk}): ${runtimeRisk.reasons
          .map((reason) => reason.reason)
          .join('; ')}. Pause e reapresente o plano; o backend não deixa risco sensível entrar escondido.`
      }
      const approvedSecuritySurfaces = new Set(approvedPlan.plan?.riskSurfaces ?? [])
      const newManualSurfaces = runtimeRisk.surfaces.filter(
        (surface) => !approvedSecuritySurfaces.has(surface)
      )
      if (requiresManualSecurityValidation(newManualSurfaces)) {
        // MODO LEVE (2026-08-04): com o switch "sensível ok" do projeto, a
        // superfície nova é AUTO-ANOTADA no plano aprovado e o trabalho segue
        // — auditada na caixa-preta, nunca uma rodada extra de aprovação
        // humana (o vai-e-vem da M01 custou 3 aprovações para zero trabalho).
        if (securityWaiverOptions(id.projectId).sensitiveWaiverAllowed && approvedPlan.plan) {
          const merged = [...new Set([...approvedSecuritySurfaces, ...newManualSurfaces])]
          tasks.update(approvedPlan.id, {
            plan: { ...approvedPlan.plan, riskSurfaces: merged }
          })
          blackbox.record({
            cat: 'task',
            event: 'plan-surfaces-auto-annotated',
            actor: 'harness',
            ids: { projectId: id.projectId, missionId: id.missionId, taskId: approvedPlan.id },
            reason: `superfície(s) ${newManualSurfaces.join(', ')} anotada(s) no plano aprovado (modo leve do projeto)`
          })
        } else {
          return `os cards introduziram uma superfície sensível que não estava no plano aprovado (${newManualSurfaces.join(', ')}). Pause e reapresente o plano para que a validação humana e os controles corretos fiquem visíveis antes da execução.`
        }
      }
      const expectedCards = approvedPlan.plan?.expectedCards
      const allowedDepartments = new Set(approvedPlan.plan?.lanes.map((lane) => lane.dept) ?? [])
      const outsideContract = items
        .map((item) => item.department)
        .filter((department) => !allowedDepartments.has(department))
      if (outsideContract.length > 0) {
        return `card fora do contrato aprovado: ${[...new Set(outsideContract)].join(', ')} não está nas lanes do plano. Reclassifique/reapresente o plano em vez de acrescentar trabalho escondido.`
      }
      if (expectedCards !== undefined) {
        // Card de sync criado pela FILA fica fora da contagem: o contrato é
        // contra expansão do orquestrador, nunca contra o próprio harness.
        const existingCards = tasks
          .list(id.projectId)
          .filter(
            (task) =>
              task.planId === approvedPlan.id &&
              task.kind !== 'plan' &&
              !isHarnessQueueCard(task, {
                planHasWorkItems: (approvedPlan.plan?.workItems ?? []).length > 0
              })
          ).length
        const sizingProblems = validateTaskSizing(
          executionMode,
          risk,
          expectedCards,
          existingCards,
          items
        )
        if (sizingProblems.length > 0) {
          return (
            'cards recusados pelo contrato de proporcionalidade: ' +
            sizingProblems.join('; ') +
            '. Se a inspeção revelou complexidade real, pause e reapresente um plano maior para aprovação.'
          )
        }
      }
      const planCards = tasks
        .list(id.projectId)
        .filter((task) => task.planId === approvedPlan.id && task.kind !== 'plan')
      const planCardById = new Map(planCards.map((task) => [task.id, task]))
      const planCardByItemId = new Map(
        planCards.flatMap((task) => (task.planItemId ? [[task.planItemId, task] as const] : []))
      )
      const workItems = approvedPlan.plan?.workItems ?? []
      const workItemById = new Map(workItems.map((item) => [item.id, item]))
      const dependencyProblems: string[] = []
      const resolvedDependencies = new Map<number, string[]>()
      const batchPlanItems = new Set<string>()
      for (const [index, item] of items.entries()) {
        if (workItems.length > 0) {
          if (!item.planItemId) {
            dependencyProblems.push(`card ${index + 1}: informe planItemId do grafo aprovado`)
            continue
          }
          const workItem = workItemById.get(item.planItemId)
          if (!workItem) {
            dependencyProblems.push(
              `card ${index + 1}: planItemId ${item.planItemId} não existe no grafo aprovado`
            )
            continue
          }
          if (batchPlanItems.has(item.planItemId) || planCardByItemId.has(item.planItemId)) {
            dependencyProblems.push(
              `card ${index + 1}: o item ${item.planItemId} já ganhou um card`
            )
            continue
          }
          batchPlanItems.add(item.planItemId)
          if (workItem.department !== item.department) {
            dependencyProblems.push(
              `card ${index + 1}: ${item.department} não corresponde à função ${workItem.department} aprovada para ${item.planItemId}`
            )
          }
          if (workItem.deliverable !== item.deliverable) {
            dependencyProblems.push(
              `card ${index + 1}: o entregável de ${item.planItemId} foi aprovado como ${workItem.deliverable}, não ${item.deliverable}`
            )
          }
          const dependencyTaskIds: string[] = []
          for (const dependencyItemId of workItem.dependsOn) {
            const dependency = planCardByItemId.get(dependencyItemId)
            if (!dependency) {
              dependencyProblems.push(
                `card ${index + 1}: a entrega anterior ${dependencyItemId} ainda não tem card concluído; crie ondas somente quando forem liberadas`
              )
              continue
            }
            dependencyTaskIds.push(dependency.id)
          }
          resolvedDependencies.set(index, dependencyTaskIds)
          continue
        }
        const seen = new Set<string>()
        for (const dependencyId of item.dependsOn ?? []) {
          if (seen.has(dependencyId)) {
            dependencyProblems.push(`card ${index + 1}: dependencia duplicada ${dependencyId}`)
            continue
          }
          seen.add(dependencyId)
          const dependency = planCardById.get(dependencyId)
          if (!dependency) {
            dependencyProblems.push(
              `card ${index + 1}: ${dependencyId} nao e um card anterior deste plano`
            )
          } else {
            const dependencies = resolvedDependencies.get(index) ?? []
            dependencies.push(dependency.id)
            resolvedDependencies.set(index, dependencies)
          }
        }
      }
      if (dependencyProblems.length > 0) {
        return (
          'dependencias recusadas: ' +
          dependencyProblems.join('; ') +
          '. Use IDs devolvidos por create_tasks em ondas anteriores do mesmo plano.'
        )
      }
      // Skills/subagentes do card: só ids INSTALADOS e do TIPO certo entram
      // (id fantasma viraria injeção silenciosamente vazia; skill no campo de
      // subagente ganharia hint errado — melhor avisar o orquestrador na hora).
      const badSkills: string[] = []
      const routedAestheticStamps: string[] = []
      const news: NewTask[] = items.map((i, index) => {
        badSkills.push(...(i.skills ?? []), ...(i.agents ?? []))
        return {
          department: i.department,
          type: i.type ?? 'feature',
          effort: i.effort ?? 'leve',
          title: i.title,
          description: i.description ?? '',
          briefing: i.briefing,
          gates: gatesForTask(
            executionMode,
            risk,
            i.deliverable,
            i.gates,
            i.affectsUi === true,
            i.department
          ),
          quests: i.quests,
          affectsUi: i.affectsUi,
          delegation: normalizeDelegationMode(i.delegation, executionMode),
          deliverable: i.deliverable,
          dependsOn: resolvedDependencies.get(index)?.length
            ? [...new Set(resolvedDependencies.get(index))]
            : undefined,
          verification: { contractVersion: 1 },
          version: maestro.get(id.projectId).version,
          missionId: id.missionId,
          origin: 'maestro',
          auto: auto || undefined,
          planId: activePlanId,
          planItemId: i.planItemId
        }
      })
      if (badSkills.length > 0) {
        return `lote recusado sem criar cards: skills/subagentes inexistentes, não instalados, incompatíveis com a função ou no campo errado: ${[
          ...new Set(badSkills)
        ].join(', ')}. Corrija os ids pelo list_skills e reenvie o lote inteiro.`
      }
      const created = tasks.createMany(id.projectId, news)
      for (const t of created)
        emitLog(id.projectId, { kind: 'log', tag: t.department, text: t.title })
      emitLog(id.projectId, { kind: 'ok', text: `${created.length} tarefas criadas no backlog` })
      hub.publish({
        projectId: id.projectId,
        missionId: id.missionId,
        kind: 'task-created',
        text: `${created.length} tarefa(s): ${created.map((t) => t.title).join(' · ')}`,
        actor: id.role
      })
      ctx.pushAll('tasks:changed', id.projectId)
      syncBoard(id.projectId)
      // TEST CARD SÓ RODA APÓS O ACEITE DO DONO (ordem 2026-08-12, caso M09:
      // a suíte re-rodava atrás de cada ajuste visual): lembrete colado na
      // resposta sempre que um card de QA nasce no lote.
      const qaSequencingReminder = created.some((t) => t.department === 'qa')
        ? ' · LEMBRETE (card de QA/testes): despache-o por ÚLTIMO, somente depois que o DONO aceitar a UI que ele cobre — ajuste de tela nunca re-dispara a suíte; acumule os ajustes e sincronize os testes UMA vez, ao final'
        : ''
      return `${created.length} tarefa(s) criadas no backlog dentro do modo ${EXECUTION_MODE_LABEL[executionMode]}: ${created
        .map((t) => `"${t.title}" [${t.department}/${t.effort}${t.gates ? `/gates:${t.gates.join('+') || 'nenhum'}` : ''}] id=${t.id}`)
        .join(' · ')}${qaSequencingReminder} — ${
        auto
          ? 'cards AUTO (o usuário só acompanha) — dispare cada um com run_task'
          : 'o usuário decide quando executar'
      }${
        badSkills.length
          ? ` · AVISO: skills/subagentes ignorados (não instalados, inexistentes ou no campo do tipo errado): ${[...new Set(badSkills)].join(', ')} — use ids EXATOS de list_skills, no campo certo (tipo=skill → skills; tipo=subagente → agents)`
          : ''
      }${
        routedAestheticStamps.length
          ? ` · AVISO: carimbos estéticos removidos (${[...new Set(routedAestheticStamps)].join(', ')}); direção visual é responsabilidade do roteador, e o card aceita somente uma técnica concreta.`
          : ''
      } · O roteador definirá o plano mínimo de cada fase; não carimbe estética por rotina.`
    },
    updateTask: (id, taskId, patchWithOrder: TaskPatch & { ownerOrder?: string }) => {
      if (id.role !== 'maestro' || !id.missionId)
        return 'só o orquestrador da missão ajusta cards'
      // T10 (2026-08-10, caso real: o dono respondeu no ask_user "tira o QA
      // deste card" e o motor recusou por piso de risco — decisão do dono
      // não tinha canal mecânico): ownerOrder VERBATIM (padrão do
      // set_phase_executor) autoriza mudança de gates contra o piso, sempre
      // auditada. Nunca persiste no card.
      const { ownerOrder: ownerOrderRaw, ...patch } = patchWithOrder
      const ownerOrder = ownerOrderRaw?.trim() || undefined
      const gateOwnerWaiver = Boolean(ownerOrder && patch.gates !== undefined)
      const t0 = tasks.get(taskId)
      if (!t0 || t0.projectId !== id.projectId || t0.missionId !== id.missionId)
        return 'card não encontrado nesta missão'
      if (t0?.kind === 'plan')
        return 'o card de PLANO não se edita por update_task — use create_plan (substituir a proposta) ou conclude_plan (encerrar com a conclusão)'
      if (!t0.auto) return 'só cards AUTO do plano podem ser ajustados pelo orquestrador'
      if ((patch.briefing?.length ?? 0) > 6000) {
        return 'ajuste recusado: briefing excede o teto autoritativo de 6000 caracteres; resuma sem remover critérios de aceite'
      }
      // gateNotes SOZINHAS podem entrar com o card em andamento: o gate alvo
      // ainda não nasceu e a nota viaja no PROMPT dele no spawn — é o caminho
      // do "instrução no briefing, nunca perseguindo o pane".
      const gateNotesOnly =
        patch.gateNotes !== undefined &&
        Object.keys(patch).every((key) => key === 'gateNotes')
      const requestedDeliverable = patch.deliverable ?? t0.deliverable ?? 'code'
      if (
        !gateNotesOnly &&
        requestedDeliverable === 'code' &&
        typeof (patch.affectsUi ?? t0.affectsUi) !== 'boolean'
      ) {
        return 'ajuste recusado: todo card de código precisa declarar affectsUi explicitamente'
      }
      if (false) {
        return 'ajuste recusado: affectsUi=false contradiz a superficie visual descrita no card'
      }
      if (t0.status === 'done')
        return 'card concluído não recebe ajuste — reabra via run_task { adjustment } se necessário'
      // Ajuste em card EM ANDAMENTO é permitido (ordem do dono, 2026-08-10:
      // "essa burocracia é desnecessária"): o patch vale para as FASES
      // FUTURAS (gates, affectsUi, skills do próximo spawn); o aviso honesto
      // abaixo lembra que o pane já rodando não relê o briefing.
      const inFlightPatch = t0.status !== 'backlog' && !gateNotesOnly
      if (patch.status)
        return 'status não pode ser alterado por update_task — use run_task e aguarde os gates do pipeline'
      const planTask = planTaskForWorkTask(t0)
      const executionMode = normalizeExecutionMode(planTask?.plan?.executionMode)
      const risk = normalizeRiskLevel(planTask?.plan?.risk)
      const deliverable = requestedDeliverable
      const runtimeRisk = assessMissionRisk({
        declaredRisk: risk,
        texts: [
          patch.title ?? t0.title,
          patch.description ?? t0.description,
          patch.briefing ?? t0.briefing,
          patch.gateNotes?.review ?? t0.gateNotes?.review,
          patch.gateNotes?.qa ?? t0.gateNotes?.qa,
          ...(patch.quests ?? t0.quests ?? [])
        ]
      })
      if (runtimeRisk.raised) {
        // Rebaixamento (regra do dono 2026-08-10, "guardas não capam
        // inteligência"): em MODO LEVE risco maior num AJUSTE é ANOTADO e
        // auditado, nunca multa o julgamento do orquestrador. Modo estrito
        // mantém a recusa (validação humana de segurança é o contrato lá).
        if (securityWaiverOptions(id.projectId).sensitiveWaiverAllowed) {
          blackbox.record({
            cat: 'task',
            event: 'risk-raise-annotated',
            actor: id.role,
            ids: { projectId: id.projectId, missionId: id.missionId, taskId },
            reason: `ajuste elevou o risco percebido para ${runtimeRisk.effectiveRisk} (plano: ${risk}) — aceito em modo leve, superfícies auditadas`
          })
        } else {
          return `ajuste recusado: o novo briefing revela risco ${runtimeRisk.effectiveRisk} acima do plano aprovado (${risk}). Pause e reapresente o plano com gates proporcionais.`
        }
      }
      if ((patch.skills?.length ?? 0) > 1)
        return 'ajuste recusado: cada card aceita no máximo uma skill técnica explícita'
      if ((patch.agents?.length ?? 0) > 1)
        return 'ajuste recusado: cada card aceita no máximo um subagente especialista explícito'
      const approvedSecuritySurfaces = new Set(planTask?.plan?.riskSurfaces ?? [])
      const newManualSurfaces = runtimeRisk.surfaces.filter(
        (surface) => !approvedSecuritySurfaces.has(surface)
      )
      if (
        requiresManualSecurityValidation(newManualSurfaces) &&
        // MODO LEVE (2026-08-04): superfície nova em ajuste é anotada, não recusada
        !securityWaiverOptions(id.projectId).sensitiveWaiverAllowed
      ) {
        return `ajuste recusado: o briefing introduz uma superfície sensível que não estava no plano (${newManualSurfaces.join(', ')}). Reapresente o plano para registrar controles e validação humana.`
      }
      const candidate = {
        department: t0.department,
        title: patch.title ?? t0.title,
        description: patch.description ?? t0.description,
        briefing: patch.briefing ?? t0.briefing,
        affectsUi: patch.affectsUi ?? t0.affectsUi,
        feedback: t0.feedback,
        effort: patch.effort ?? t0.effort,
        gates: patch.gates ?? t0.gates,
        delegation: patch.delegation ?? t0.delegation,
        deliverable,
        skills: patch.skills ?? t0.skills,
        agents: patch.agents ?? t0.agents,
        quests: patch.quests ?? t0.quests
      }
      // AJUSTE nunca muda a CONTAGEM de cards — o teto de proporcionalidade
      // não se aplica aqui (caso real 2026-08-10: card de sync da fila levava
      // o total acima do prometido e TODO update do plano passava a ser
      // recusado). Ficam só as validações de conteúdo por item.
      // MODO LEVE = escolha EXPLÍCITA de gates do orquestrador vale sem
      // ownerOrder (caso real M09, 2026-08-12: o piso de risco alto
      // re-carimbava review+qa a cada update e o dono teve que repetir a
      // ordem; guarda de julgamento anota, nunca re-impõe). Estrito mantém.
      const gatesLightMode = securityWaiverOptions(id.projectId).sensitiveWaiverAllowed
      const explicitGatesInLightMode = !gateOwnerWaiver && gatesLightMode && patch.gates !== undefined
      const sizingProblems = validateTaskSizing(
        executionMode,
        risk,
        Number.MAX_SAFE_INTEGER,
        0,
        [candidate],
        { ownerGateWaiver: gateOwnerWaiver || explicitGatesInLightMode }
      )
      if (sizingProblems.length > 0)
        return 'ajuste recusado pelo contrato de proporcionalidade: ' + sizingProblems.join('; ')
      const normalizedPatch: TaskPatch = {
        ...patch,
        deliverable,
        delegation: normalizeDelegationMode(candidate.delegation, executionMode),
        // ownerOrder presente + gates no patch = os gates do DONO valem
        // literalmente (o piso de risco não re-impõe); sem ordem, piso normal.
        gates: gateOwnerWaiver || explicitGatesInLightMode
          ? patch.gates
          : gatesForTask(
              executionMode,
              risk,
              deliverable,
              candidate.gates,
              candidate.affectsUi === true,
              t0.department
            )
      }
      if (gateOwnerWaiver) {
        blackbox.record({
          cat: 'task',
          event: 'gate-owner-waiver',
          actor: id.role,
          ids: { projectId: id.projectId, missionId: id.missionId, taskId },
          reason: `gates → [${(patch.gates ?? []).join(', ') || 'nenhum'}] por ORDEM DO DONO: "${(ownerOrder ?? '').slice(0, 300)}"`
        })
      } else if (explicitGatesInLightMode && risk === 'high') {
        blackbox.record({
          cat: 'task',
          event: 'gates-explicit-light-mode',
          actor: id.role,
          ids: { projectId: id.projectId, missionId: id.missionId, taskId },
          reason: `gates → [${(patch.gates ?? []).join(', ') || 'nenhum'}] por escolha explícita do orquestrador em modo leve (risco ${risk} — piso não re-impõe, anotado)`
        })
      }
      const updated = tasks.update(taskId, normalizedPatch as Partial<Task>)
      if (!updated) return `tarefa ${taskId} não encontrada`
      hub.publish({
        projectId: id.projectId,
        missionId: updated.missionId,
        kind: 'task-updated',
        text: `"${updated.title}" atualizada${patch.status ? ` → ${patch.status}` : ''}`,
        actor: id.role
      })
      ctx.pushAll('tasks:changed', id.projectId)
      syncBoard(id.projectId)
      const waiverNote = gateOwnerWaiver
        ? ' · gates ajustados por ORDEM DO DONO (auditado na caixa-preta)'
        : ''
      return (
        (inFlightPatch
          ? `tarefa "${updated.title}" atualizada COM o card em andamento — o patch vale para as próximas fases/spawns; o pane que já está rodando NÃO relê o briefing (se precisar avisá-lo agora, use notify_pane)`
          : `tarefa "${updated.title}" atualizada`) + waiverNote
      )
    },

    // ————— F5.7: plano da missão (proposta → aprovação → autonomia) —————,
    createPlan: async (id, input) => {
      if (id.role !== 'maestro' || !id.missionId)
        return 'só o orquestrador da missão propõe o plano'
      const mission = missions.get(id.missionId)
      if (!mission || mission.status !== 'ativa')
        return 'a missão não está ativa — sem plano novo'
      const queuedMission = integrationQueue.getByMission(id.missionId)
      if (queuedMission)
        return `esta missão já ocupa a posição #${queuedMission.position} da fila de integração — o plano aprovado está congelado. Se a fila pedir sincronização/conflito, ela mesma reabre esse plano e cria o único card operacional.`
      if (input.lanes.length === 0) return 'o plano precisa de ao menos uma lane'
      const executionMode = normalizeExecutionMode(input.executionMode)
      const declaredRisk = normalizeRiskLevel(input.risk)
      // PRÉ-VOO DE SUPERFÍCIES (caso real 04/08/2026: o plano V1 foi aprovado
      // sem personal_data e o create_tasks recusou DEPOIS da aprovação humana
      // — 3 aprovações para zero trabalho novo). O goal da missão nem sempre
      // carrega o sinal (o CPF morava no schema que o orquestrador ia criar);
      // o plano do PROJETO e o item do roadmap carregam — entram na varredura
      // para a proposta já nascer com as superfícies declaradas.
      const projectMasterPlan = projectPlanOf(id.projectId)
      const missionRoadmapItem = projectMasterPlan?.roadmap.find(
        (item) => item.missionId === id.missionId
      )
      const riskAssessment = assessMissionRisk({
        declaredRisk,
        surfaces: input.riskSurfaces,
        texts: [
          mission.title,
          mission.goal,
          mission.scope,
          input.title,
          input.summary,
          input.sizingReason,
          ...input.workItems.map((item) => item.title),
          projectMasterPlan?.problem,
          projectMasterPlan?.vision,
          ...(projectMasterPlan?.successCriteria ?? []),
          ...(projectMasterPlan?.scope.in ?? []),
          missionRoadmapItem?.objective,
          ...(missionRoadmapItem?.acceptanceCriteria ?? []),
          ...(missionRoadmapItem?.scope.in ?? [])
        ]
      })
      // MODO LEVE: elevação vinda SÓ de sinal de TEXTO vira ANOTAÇÃO
      // auditada (ordem do dono, 2026-08-11, falso positivo real ao vivo: a
      // regex de payments casou a prosa do plano MESTRE — produto tributário
      // fala de honorários/cobrança — e elevou uma repaginação puramente
      // visual de LOW a HIGH; doutrina F6.12: keyword é JULGAMENTO, não
      // autoridade). Superfície DECLARADA pelo agente segue impondo piso nos
      // DOIS modos (ele mesmo declarou); modo ESTRITO preserva a imposição
      // integral por texto. As superfícies detectadas continuam anotadas no
      // plano (riskSurfaces/riskReasons) — anotar ≠ ignorar.
      const planLightMode = securityWaiverOptions(id.projectId).sensitiveWaiverAllowed
      const declaredOnlyRisk = assessMissionRisk({ declaredRisk, surfaces: input.riskSurfaces })
      const textOnlyRaise = riskAssessment.effectiveRisk !== declaredOnlyRisk.effectiveRisk
      const risk = planLightMode ? declaredOnlyRisk.effectiveRisk : riskAssessment.effectiveRisk
      const sizingProblems = validatePlanSizing({
        mode: executionMode,
        expectedCards: input.expectedCards,
        laneCount: input.lanes.length
      })
      const dependencyProblems = validatePlanDependencies({
        mode: executionMode,
        expectedCards: input.expectedCards,
        items: input.workItems.map((item) => ({
          id: item.id,
          waveId: item.waveId,
          dependsOn: item.dependsOn
        }))
      })
      const laneDepartments = new Set(input.lanes.map((lane) => lane.dept))
      for (const item of input.workItems) {
        if (!laneDepartments.has(item.department)) {
          dependencyProblems.push(
            `o item ${item.id} usa ${item.department}, mas essa função não existe nas lanes`
          )
        }
      }
      if (sizingProblems.length > 0 || dependencyProblems.length > 0) {
        return (
          'plano desproporcional: ' +
          [...sizingProblems, ...dependencyProblems].join('; ') +
          '. Ajuste o perfil ou reduza a estrutura antes de mostrar ao usuário.'
        )
      }
      const existing = tasks
        .list(id.projectId)
        .filter((t) => t.missionId === id.missionId && t.kind === 'plan')
      const unresolvedPlans = existing.filter((task) => task.status !== 'done')
      if (unresolvedPlans.length > 1) {
        return 'plano recusado: a missão já possui mais de um card de plano aberto; reconcilie essa duplicidade no board antes de propor outra versão'
      }
      // Tudo abaixo pode atravessar consultas assíncronas de catálogo. Guarde a
      // fotografia autoritativa que fundamentou o pré-voo; no trecho final ela
      // precisa continuar idêntica. Sem este CAS lógico, um clique de aprovação
      // durante o await podia ser sobrescrito pela proposta antiga.
      const initialPlanState = existing
        .map((task) => `${task.id}:${task.status}:${task.updatedAt}`)
        .sort()
        .join('|')
      const initialPlanIds = new Set(existing.map((task) => task.id))
      const initialLinkedCardState = tasks
        .list(id.projectId)
        .filter(
          (task) =>
            task.missionId === id.missionId &&
            task.kind !== 'plan' &&
            Boolean(task.planId && initialPlanIds.has(task.planId))
        )
        .map(
          (task) =>
            `${task.id}:${task.status}:${task.updatedAt}:${task.planId ?? ''}:${task.planItemId ?? ''}`
        )
        .sort()
        .join('|')
      const initialMissionUpdatedAt = mission.updatedAt
      const runningPlan = existing.find((t) => t.status === 'execucao')
      if (runningPlan) {
        // PAUSA AUTOMÁTICA PARA RECLASSIFICAÇÃO (decisão do usuário,
        // 02/08/2026: "com 10/20 missões eu não vou saber que precisa pausar").
        // O clique de pausa existe para proteger TRABALHO EM CURSO; quando
        // nenhum card do plano está rodando, exigi-lo é burocracia sem
        // decisão. Com card ativo a recusa continua — pausar mataria runs.
        const planCards = tasks
          .list(id.projectId)
          .filter(
            (t) =>
              t.missionId === id.missionId &&
              t.kind !== 'plan' &&
              t.planId === runningPlan.id
          )
        if (planCards.length > 0)
          return 'já existe um plano APROVADO com cards ligados — conclua ou descarte explicitamente esse grafo antes de propor outro; a reclassificação nunca reaproveita cards do plano antigo'
      }
      // Lanes — REGRA DO USUÁRIO (2026-07-28): função COM política definida
      // NÃO dá liberdade de modelo ao orquestrador no planejamento — a lane
      // usa um dos DOIS slots do usuário (▲ pesadas / ▽ leves; a escolha
      // ENTRE eles e o effort são do orquestrador; o usuário segue livre no
      // modal). Sugestão fora da política é CORRIGIDA aqui (bug real: lane de
      // qa veio com sonnet, que não está em slot nenhum). Liberdade de modelo
      // só em função SEM política — e nos ajudantes do dev (outro fluxo).
      // Modelo banido (spark) é limpo em qualquer caminho.
      const pmSeatId = maestro.get(id.projectId).seatId
      const sane = (m?: string): string | undefined => (isBannedModel(m) ? undefined : m)
      const adjusted: string[] = []
      const lanes: PlanLane[] = []
      for (const l of input.lanes) {
        const pol = policies.get(id.projectId)[l.dept]
        const heavySlot = pol?.heavy?.seatId && seats.get(pol.heavy.seatId) ? pol.heavy : undefined
        const lightSlot = pol?.light?.seatId && seats.get(pol.light.seatId) ? pol.light : undefined
        const slots = [heavySlot, lightSlot].filter(
          (s): s is PolicySlot => !!s?.seatId && !!seats.get(s.seatId)
        )
        if (slots.length > 0) {
          const match = slots.find(
            (s) =>
              s.seatId === l.seatId &&
              (l.model === undefined || (s.model || undefined) === sane(l.model))
          )
          // O fallback antigo era sempre heavy porque esse slot aparecia
          // primeiro. Rápido/equilibrado caem no light; deep ou risco alto
          // justificam heavy quando o orquestrador não escolheu explicitamente.
          const chosen =
            match ??
            (executionMode === 'deep' || risk === 'high'
              ? heavySlot ?? lightSlot ?? slots[0]
              : lightSlot ?? heavySlot ?? slots[0])
          if (!match && (l.seatId || l.model))
            adjusted.push(
              `${l.dept} → ${seats.get(chosen.seatId)?.name ?? chosen.seatId}${chosen.model ? ` · ${chosen.model}` : ''}`
            )
          lanes.push({
            dept: l.dept,
            notes: l.notes,
            seatId: chosen.seatId,
            model: sane(chosen.model || undefined),
            effort: l.effort
          })
          continue
        }
        if (l.seatId && seats.get(l.seatId)) {
          // Dept SEM política: escolha livre — mas o id tem que EXISTIR no
          // catálogo do seat (id inventado degradaria o run inteiro).
          let m = sane(l.model)
          if (m) {
            try {
              const pool = await agentModelPool(seats.get(l.seatId)!)
              if (pool.length > 0 && !pool.some((x) => x.id === m)) {
                adjusted.push(`${l.dept}: modelo "${m}" não existe → padrão do seat`)
                m = undefined
              }
            } catch {
              // catálogo indisponível — deixa passar
            }
          }
          lanes.push({ dept: l.dept, notes: l.notes, seatId: l.seatId, model: m, effort: l.effort })
          continue
        }
        const seatId = mission.seatId ?? pmSeatId
        lanes.push({
          dept: l.dept,
          notes: l.notes,
          seatId,
          model: sane(l.model ?? (seatId && seatId === mission.seatId ? mission.model : undefined)),
          effort: l.effort
        })
      }
      // LANE DE QA OBRIGATÓRIA QUANDO HAVERÁ GATES (decisão do usuário,
      // 2026-08-06: o plano da O02d nasceu sem lane qa e o gate 2 abriu com
      // modelo da política e um effort que NINGUÉM escolheu — "eu não pude
      // escolher"). O QA é executor tão contratual quanto o dev: com qualquer
      // entrega de código no plano, a lane qa é auto-completada pela cadeia
      // de sempre e o usuário a ajusta no modal antes de aprovar.
      const hasCodeDelivery = input.workItems.some((item) => item.deliverable === 'code')
      if (hasCodeDelivery && !lanes.some((l) => l.dept === 'qa')) {
        const qaPol = policies.get(id.projectId)['qa']
        const qaHeavy = qaPol?.heavy?.seatId && seats.get(qaPol.heavy.seatId) ? qaPol.heavy : undefined
        const qaLight = qaPol?.light?.seatId && seats.get(qaPol.light.seatId) ? qaPol.light : undefined
        const qaSlot =
          executionMode === 'deep' || risk === 'high'
            ? qaHeavy ?? qaLight
            : qaLight ?? qaHeavy
        const qaSeatId = qaSlot?.seatId ?? mission.seatId ?? pmSeatId
        if (qaSeatId && seats.get(qaSeatId)) {
          lanes.push({
            dept: 'qa',
            notes: 'gates (review/QA) — auto-completada; ajuste conta/modelo/effort antes de aprovar',
            seatId: qaSeatId,
            model: sane(qaSlot?.model || (qaSeatId === mission.seatId ? mission.model : undefined)),
            effort: undefined
          })
          adjusted.push('lane qa AUTO-COMPLETADA (o plano terá gates — o usuário escolhe o executor no modal)')
        }
      }
      // Proposta nova zera a aprovação anterior (plano pausado re-proposto).
      // MODO LEVE (decisão do usuário, 2026-08-04: "muita barra de segurança,
      // não estamos conseguindo avançar"): com o switch "sensível ok" do
      // projeto ligado, a VALIDAÇÃO HUMANA por plano não nasce — a aprovação
      // do plano pelo usuário já é o ato humano. Sem o switch, regra estrita.
      const manualSecurityValidationRequired =
        requiresManualSecurityValidation(riskAssessment.surfaces) &&
        !securityWaiverOptions(id.projectId).sensitiveWaiverAllowed
      const currentMission = missions.get(id.missionId)
      if (
        !currentMission ||
        currentMission.status !== 'ativa' ||
        currentMission.updatedAt !== initialMissionUpdatedAt ||
        integrationQueue.getByMission(id.missionId)
      ) {
        return 'plano recusado: a missão ou a fila mudou durante o preparo; releia o estado atual antes de propor novamente'
      }
      const currentExisting = tasks
        .list(id.projectId)
        .filter((task) => task.missionId === id.missionId && task.kind === 'plan')
      const currentPlanState = currentExisting
        .map((task) => `${task.id}:${task.status}:${task.updatedAt}`)
        .sort()
        .join('|')
      if (currentPlanState !== initialPlanState) {
        return 'plano recusado: o card de plano mudou durante o preparo (por exemplo, foi aprovado, pausado ou reproposto); releia o board e tente novamente'
      }
      const currentPlanIds = new Set(currentExisting.map((task) => task.id))
      const currentLinkedCards = tasks
        .list(id.projectId)
        .filter(
          (task) =>
            task.missionId === id.missionId &&
            task.kind !== 'plan' &&
            Boolean(task.planId && currentPlanIds.has(task.planId))
        )
      const currentLinkedCardState = currentLinkedCards
        .map(
          (task) =>
            `${task.id}:${task.status}:${task.updatedAt}:${task.planId ?? ''}:${task.planItemId ?? ''}`
        )
        .sort()
        .join('|')
      if (currentLinkedCardState !== initialLinkedCardState) {
        return 'plano recusado: os cards ligados ao plano mudaram durante o preparo; releia a missão antes de reclassificar'
      }
      const currentRunningPlan = currentExisting.find((task) => task.status === 'execucao')
      if (
        currentRunningPlan &&
        tasks
          .list(id.projectId)
          .some(
            (task) =>
              task.missionId === id.missionId &&
              task.kind !== 'plan' &&
              task.planId === currentRunningPlan.id &&
              (task.status === 'execucao' || task.status === 'qa' || phaseWatches.has(task.id))
          )
      ) {
        return 'plano recusado: um card do plano entrou em execução durante o preparo; conclua-o ou aguarde a pausa humana antes de reclassificar'
      }
      const candidatePlanId =
        currentRunningPlan?.id ?? currentExisting.find((task) => task.status === 'backlog')?.id
      if (candidatePlanId && currentLinkedCards.some((task) => task.planId === candidatePlanId)) {
        return 'plano recusado: este plano já possui cards de trabalho; conclua, descarte ou replaneje esses cards explicitamente antes de trocar o grafo aprovado'
      }
      const plan: TaskPlan = {
        summary: input.summary,
        lanes,
        executionMode,
        declaredRisk,
        risk,
        riskSurfaces: riskAssessment.surfaces,
        riskReasons: riskAssessment.reasons.map(
          (reason) => `${reason.reason} (${reason.evidence})`
        ),
        securityPolicyVersion: SECURITY_POLICY_VERSION,
        manualSecurityValidationRequired,
        manualSecurityValidation: initialManualSecurityValidation(
          manualSecurityValidationRequired
        ),
        sizingReason: input.sizingReason.trim(),
        expectedCards: input.expectedCards,
        workItems: input.workItems.map((item) => ({
          id: item.id,
          title: item.title,
          department: item.department,
          deliverable: item.deliverable,
          waveId: item.waveId,
          dependsOn: [...item.dependsOn]
        }))
      }
      // O plano em execução sem card ativo é o próprio alvo da reproposta.
      // Status backlog + conteúdo novo pousam no mesmo commit, sem fotografia
      // intermediária pausada e sem criar um segundo card de plano.
      const proposed =
        currentRunningPlan ?? currentExisting.find((task) => task.status === 'backlog')
      const planTask = proposed
        ? tasks.update(proposed.id, {
            status: 'backlog',
            title: input.title,
            department: lanes[0].dept,
            plan
          })
        : tasks.createMany(id.projectId, [
            {
              department: lanes[0].dept,
              type: 'feature',
              effort: 'leve',
              title: input.title,
              description: '',
              origin: 'maestro',
              missionId: id.missionId,
              version: maestro.get(id.projectId).version,
              kind: 'plan',
              plan
            }
          ])[0]
      if (!planTask) return 'plano recusado: a proposta não pôde ser persistida'
      if (planLightMode && textOnlyRaise) {
        blackbox.record({
          cat: 'task',
          event: 'plan-risk-raise-annotated',
          actor: 'harness',
          ids: { projectId: id.projectId, missionId: id.missionId, taskId: planTask.id },
          reason: `sinais de texto sugeriam ${riskAssessment.effectiveRisk} (declarado ${declaredRisk}); modo leve manteve o declarado e anotou: ${riskAssessment.reasons.map((r) => r.surface).join(', ')}`
        })
      }
      if (currentRunningPlan && planTask.id === currentRunningPlan.id) {
        blackbox.record({
          cat: 'task',
          event: 'plan-auto-paused',
          ids: {
            projectId: id.projectId,
            missionId: id.missionId,
            taskId: currentRunningPlan.id
          },
          actor: 'maestro',
          reason:
            'reclassificação: o mesmo card recebeu a proposta nova e voltou ao backlog em commit único; aprovação continua humana'
        })
        hub.publish({
          projectId: id.projectId,
          missionId: id.missionId,
          kind: 'info',
          text: `plano "${currentRunningPlan.title}" reclassificado no mesmo card (nenhum card estava rodando) — a proposta nova aguarda a aprovação do usuário no board`,
          actor: 'harness',
          quiet: true
        })
      }
      hub.publish({
        projectId: id.projectId,
        missionId: id.missionId,
        kind: 'info',
        text: `orquestrador propôs o PLANO da missão ("${input.title}") — aguardando aprovação do usuário no board`,
        actor: 'maestro'
      })
      ctx.pushAll('tasks:changed', id.projectId)
      syncBoard(id.projectId)
      return `plano ${proposed ? 'atualizado' : 'criado'} no board (card "${planTask?.title ?? input.title}" · modo ${EXECUTION_MODE_LABEL[executionMode]} · risco ${risk} · ${input.expectedCards} card(s))${
        adjusted.length
          ? ` — OBS: lane(s) com política do departamento foram TRAVADAS nela (regra do usuário; sua sugestão fora da política foi corrigida): ${adjusted.join(' · ')}.`
          : ' —'
      }${
        !planLightMode && riskAssessment.raised
          ? ` O backend elevou o risco de ${declaredRisk} para ${risk} por: ${riskAssessment.reasons.map((reason) => reason.reason).join('; ')}.`
          : ''
      }${
        planLightMode && textOnlyRaise
          ? ` Sinais de risco no TEXTO foram ANOTADOS no plano SEM elevar o risco (modo leve): ${riskAssessment.reasons.map((reason) => reason.surface).join(', ')} — se algum for real NESTE trabalho, redeclare risk/riskSurfaces você mesmo.`
          : ''
      }${
        plan.manualSecurityValidationRequired
          ? ' O card marca VALIDAÇÃO HUMANA: deixe o cenário seguro e a evidência ainda necessária explícitos na conclusão antes de pedir integração.'
          : ''
      }${
        executionMode === 'fast'
          ? ' LEMBRETE FAST: os cards deste plano deverão ser LEVES, sem ajudantes e com no máximo 1 skill — entrega que exigiria card "pesada" NÃO cabe em fast; reclassifique para standard/deep AGORA (o create_tasks recusará depois da aprovação, custando outra rodada humana).'
          : ''
      } avise o usuário e aguarde: ele pode ajustar seat/modelo/effort das lanes no card antes de aprovar. NÃO crie cards de trabalho até o evento "[synkora] PLANO APROVADO".`
    },
    runTask: async (id, taskId, phase, adjustment) => {
      if (id.role !== 'maestro' || !id.missionId)
        return 'só o orquestrador da missão dispara cards — executores paralelizam via delegate'
      let task = tasks.get(taskId)
      if (!task || task.missionId !== id.missionId) return 'card não encontrado nesta missão'
      if (task.kind === 'plan')
        return 'o card de plano é o contrato, não se executa — dispare os cards de trabalho'
      if (phase && adjustment)
        return 'phase e adjustment são caminhos diferentes; use apenas um deles'
      if (phase === 'review' || phase === 'qa') {
        // breaker de crash-loop: gate que morreu 3× em 60s não reabre em
        // reflexo — diagnóstico primeiro (caso real 05/08 16:59)
        const cooldown = gateCooldownUntil.get(taskId)
        if (cooldown && Date.now() < cooldown)
          return `o gate ${phase} deste card morreu ${GATE_DEATH_LIMIT}× em 1 minuto — reabertura em cooldown por mais ${Math.ceil((cooldown - Date.now()) / 1000)}s. Diagnostique a causa (últimas linhas no evento pane/exit da caixa-preta) ou troque o executor do gate (config do reviewer/lane) antes de tentar de novo`
      }
      if (phaseWatches.has(taskId))
        return 'já existe uma fase rodando para este card — não abri outro pane. Se a seu juízo o trabalho já está pronto e validado, complete_task {id, reason} encerra tudo e conclui o card direto (auditado)'
      // F2-c4 (§7.5/§7.9 do mapa): card em TRANSIÇÃO parece livre (watch
      // detached) — a recusa com receita fecha o run_task no meio do veredito.
      if (ctx.phaseTransitions.isLocked(taskId))
        return 'a rodada anterior deste card ainda está fechando (veredito em processamento) — aguarde alguns segundos ou o evento de conclusão e chame run_task de novo'
      const launchToken = phaseLaunches.reserve(taskId)
      if (!launchToken)
        return 'este card já está sendo preparado por outra chamada — não abri outro pane'
      const activeAtReservation = ctx.phase.phaseOccupancy(id.projectId, taskId)
      const capacityToken = phaseLaunchCapacity.reserve(
        id.projectId,
        activeAtReservation,
        MAX_PARALLEL_RUNS
      )
      if (!capacityToken) {
        phaseLaunches.release(taskId, launchToken)
        return `limite de ${MAX_PARALLEL_RUNS} execuções paralelas atingido — aguarde um evento de conclusão e chame run_task de novo`
      }
      try {
        // REPARO DE INTEGRAÇÃO (plano de estabilização 02/08): card APROVADO
        // cujo merge foi bloqueado fica em `finalizing`; este ramo re-tenta
        // SOMENTE o merge do mesmo commit aprovado — nunca reabre dev/gates.
        if (phase === 'finalize') {
          if (task.status === 'done') return 'o card já está concluído'
          if (task.phaseState !== 'finalizing')
            return `este card não está em finalização (estado atual: ${task.status}/${task.phaseState ?? '-'}) — o reparo de integração vale apenas para card aprovado com merge bloqueado. Se a seu juízo o trabalho já está pronto e validado, complete_task {id, reason} conclui o card direto (auditado)`
          // Receipt 'preparing' é só intenção: nenhum commit de merge foi
          // journalado, então é seguro refazê-lo com o destino ATUAL — é assim
          // que o retry aceita o destino já reparado (commit da sujeira) pelo
          // orquestrador. Um receipt 'prepared' tem commit journalado e o
          // recover o revalida integralmente, como sempre.
          if (task.integrationReceipt?.stage === 'preparing') {
            tasks.update(task.id, { integrationReceipt: undefined })
          }
          blackbox.record({
            cat: 'merge',
            event: 'finalize-retry',
            ids: {
              projectId: id.projectId,
              missionId: id.missionId,
              taskId: task.id
            },
            actor: 'maestro',
            reason: 'run_task {phase: "finalize"} — reparo de integração solicitado'
          })
          const latest = tasks.get(taskId)
          const recovered = latest ? await ctx.phase.recoverFinalizingTask(latest) : false
          const after = tasks.get(taskId)
          return recovered && after?.status === 'done'
            ? `integração concluída: "${after.title}" está done — nenhuma fase foi repetida`
            : `a integração foi re-tentada e continua pendente: ${after?.feedback ?? 'veja o feedback do card'}. Resolva a causa apontada e chame run_task {id: "${taskId}", phase: "finalize"} de novo`
        }
        if (adjustment) {
          if (task.adjustment && task.status !== 'done')
            return `o ajuste já está persistido neste card (${task.phaseState ?? task.status}); retome-o com run_task {id: "${taskId}"}, sem repetir adjustment`
          const planTask = planTaskForWorkTask(task)
          const mission = missions.get(id.missionId)
          if (!planTask || !mission)
            return 'não encontrei o plano/missão original; o ajuste não foi aberto'
          const currentPlan = currentPlanOf(id.projectId, id.missionId)
          const anotherOpenPlan = tasks
            .list(id.projectId)
            .some(
              (candidate) =>
                candidate.missionId === id.missionId &&
                candidate.kind === 'plan' &&
                candidate.id !== planTask.id &&
                candidate.status !== 'done'
            )
          if (currentPlan?.id !== planTask.id || anotherOpenPlan) {
            return 'há um plano mais novo/aberto nesta missão; não reabri uma entrega antiga por baixo dele'
          }
          const adjustmentRisk = assessMissionRisk({
            declaredRisk: planTask.plan?.risk,
            texts: [adjustment]
          })
          const newAdjustmentSurfaces = unapprovedAdjustmentRiskSurfaces(
            adjustmentRisk.surfaces,
            planTask.plan?.riskSurfaces ?? []
          )
          // MODO LEVE (2026-08-04): superfície nova em AJUSTE também é
          // auto-anotada — a recusa deste site travou o reparo pós-verificação
          // da M01 ("ai_agents, supply_chain" no briefing de lint).
          const adjustmentLightMode = securityWaiverOptions(id.projectId).sensitiveWaiverAllowed
          if (newAdjustmentSurfaces.length > 0) {
            if (adjustmentLightMode && planTask.plan) {
              const merged = [
                ...new Set([...(planTask.plan.riskSurfaces ?? []), ...newAdjustmentSurfaces])
              ]
              tasks.update(planTask.id, { plan: { ...planTask.plan, riskSurfaces: merged } })
              blackbox.record({
                cat: 'task',
                event: 'plan-surfaces-auto-annotated',
                actor: 'harness',
                ids: { projectId: id.projectId, missionId: id.missionId, taskId: planTask.id },
                reason: `superfície(s) ${newAdjustmentSurfaces.join(', ')} anotada(s) via ajuste (modo leve do projeto)`
              })
            } else {
              return `o ajuste introduz superfície(s) que não estavam no plano aprovado (${newAdjustmentSurfaces.join(', ')}); reapresente um novo plano e obtenha aprovação antes de executar`
            }
          }
          if (adjustmentRisk.raised && !adjustmentLightMode) {
            return `o pedido deixou de ser um ajuste pequeno seguro (${adjustmentRisk.reasons.map((reason) => reason.surface).join(' · ')}); reclassifique o plano e obtenha aprovação antes de executar`
          }
          const decision = prepareTaskAdjustment({
            reason: adjustment,
            integrationQueued: Boolean(integrationQueue.getByMission(id.missionId)),
            // válvula sancionada (05/08 00:25-00:45): verificação final do
            // plano existente e ainda não aceita = o único momento em que um
            // card done PRECISA reabrir sem o plano concluído — remediação
            // auditada, dev → gates integrais de novo.
            verificationBlocked: Boolean(
              planTask.plan?.verification?.final &&
                !finalVerificationAccepted(planTask.plan.verification.final)
            ),
            task,
            planTask,
            mission
          })
          if (!decision.ok) return decision.message
          const { adjustment: adjustmentPatch, ...taskPatch } = decision.patches.task
          const taskAdjustmentPatch: TaskUpdatePatch = {
            ...taskPatch,
            adjustment: {
              ...adjustmentPatch,
              requestedAt: new Date().toISOString()
            },
            // AJUSTE RÁPIDO (ordem do dono 2026-08-12): adjustment É a rodada
            // quick — protocolo cortado (checks/evidência do delta, review
            // olhada-relâmpago, sem QA), skills/qualidade intactas.
            quickRound: true,
            // Re-imposição de gates por risco alto SÓ em modo estrito (a
            // guarda de julgamento em modo leve atropelava a escolha
            // explícita — caso real M09: recolocou o QA que o dono mandou
            // tirar, uma linha antes do ownerOrder dele chegar).
            ...(normalizeRiskLevel(planTask.plan?.risk) === 'high' && !adjustmentLightMode
              ? { gates: ['review', 'qa'] }
              : {})
          }
          const reopened = tasks.updateMany([
            {
              id: decision.patches.planTaskId,
              patch: decision.patches.planTask
            },
            { id: decision.patches.taskId, patch: taskAdjustmentPatch }
          ])
          task = reopened?.find((candidate) => candidate.id === taskId)
          if (!task) return 'o card desapareceu durante a reabertura; nada foi iniciado'
          hub.publish({
            projectId: id.projectId,
            missionId: id.missionId,
            kind: 'info',
            text: `ajuste pequeno reabriu o MESMO card "${task.title}" em rodada QUICK — protocolo cortado (delta + olhada-relâmpago), sem novo plano ou card`,
            actor: 'maestro'
          })
        } else if (!phase && task.quickRound) {
          // Dispatch CHEIO zera o carimbo quick da rodada anterior — cada
          // run_task decide o perfil da SUA rodada.
          const refreshed = tasks.update(taskId, { quickRound: false })
          if (refreshed) task = refreshed
        }
      if (!task) return 'o card não está mais disponível; nada foi iniciado'
      const taskIdentity = {
        projectId: task.projectId,
        missionId: task.missionId,
        planId: task.planId,
        department: task.department
      }
      const dependencyProblems = (task.dependsOn ?? []).flatMap((dependencyId) => {
        const dependency = tasks.get(dependencyId)
        if (
          !dependency ||
          dependency.projectId !== taskIdentity.projectId ||
          dependency.missionId !== taskIdentity.missionId ||
          dependency.planId !== taskIdentity.planId ||
          dependency.kind === 'plan'
        ) {
          return [`${dependencyId} (inválida ou fora do plano)`]
        }
        return dependency.status === 'done'
          ? []
          : [`"${dependency.title}" (${dependency.status})`]
      })
      if (dependencyProblems.length > 0) {
        return `card bloqueado por dependência: ${dependencyProblems.join(' · ')}. Aguarde os cards anteriores terminarem; esta onda não pode furar a ordem.`
      }
      // REABRIR SÓ O GATE (2026-07-30: fechar/perder o QA não pode custar uma
      // rodada inteira de dev — o worktree do card está intacto).
      if (phase) {
        if (task.status === 'done') return 'o card já está concluído'
        const active = phaseWatches.get(taskId)
        if (active)
          return `já existe uma fase "${active.phase}" rodando para este card — aguarde o veredito/conclusão dela. Se o pane dessa fase estiver MORTO/zumbi (confira com list_panes), peça ao usuário para fechá-lo no mapa (×) — a fase solta sozinha e aí o run_task funciona`
        const gates = task.gates ?? ['review', 'qa']
        if (!gates.includes(phase))
          return `o gate ${phase} não faz parte do contrato deste card — gates: ${gates.join(' + ') || 'nenhum'}`
        if (task.activePhase && task.activePhase !== phase)
          return `a fase preservada deste card é "${task.activePhase}", não "${phase}". RECEITA: ${
            task.activePhase === 'dev'
              ? 'o dev vivo pode simplesmente reportar done (re-entrega aceita); se o pane do dev morreu, chame run_task {id} sem phase para redespachá-lo'
              : `chame run_task {id, phase: "${task.activePhase}"} para reabrir o gate preservado`
          } — não repita nem pule trabalho já feito`
        if (
          !task.activePhase &&
          !((phase === 'review' && task.status === 'execucao') || (phase === 'qa' && task.status === 'qa'))
        )
          return `não existe um gate ${phase} interrompido neste card; o estado atual é "${task.status}"`
      } else if (
        task.phaseState === 'interrupted' &&
        task.activePhase &&
        task.activePhase !== 'dev'
      ) {
        return `o card preservou a fase "${task.activePhase}" — reabra somente ela com run_task {id: "${taskId}", phase: "${task.activePhase}"}`
      } else if (task.status !== 'backlog') {
        return `o card está em "${task.status}" — só card em backlog pode ser disparado (para REABRIR um gate morto use phase: "review"/"qa")`
      }
      let plan = currentPlanOf(id.projectId, id.missionId)
      if (!plan || plan.status !== 'execucao')
        return plan && plan.status === 'backlog'
          ? 'o plano ainda não foi aprovado (ou está pausado) — aguarde o evento "[synkora] PLANO APROVADO"'
          : 'sem plano em execução nesta missão — proponha com create_plan e aguarde a aprovação do usuário'
      const projectForRun = projects.get(id.projectId)
      let missionForRun = missions.get(id.missionId)
      if (!projectForRun || !missionForRun)
        return 'execução bloqueada: projeto ou missão não estão mais disponíveis'
      missionForRun = ensureMissionWorktree(id.missionId)
      if (!missionForRun)
        return 'execução bloqueada: não consegui criar ou comprovar o isolamento Git desta missão'
      const missionCwd = missionWorkspacePath(projectForRun.path, missionForRun)
      if (!missionCwd) {
        return 'execução bloqueada: não foi possível provar ou reanexar o worktree isolado desta missão. Nada será aberto na branch principal; repare/reabra a missão e tente novamente.'
      }
      const baseline = await ensurePlanBaseline(plan)
      if (!baselineVerificationUsable(baseline)) {
        return `execução bloqueada: não foi possível registrar uma fotografia inicial confiável (${baseline.lastError || baseline.status}). Corrija a causa e rode o card novamente; nenhum desenvolvimento foi iniciado.`
      }
      if (hasGitCommit(projectForRun.path)) {
        const currentHead = gitHead(missionCwd)
        const expectedHead = plan.plan?.executionHead
        if (isWorktreeClean(missionCwd) !== true) {
          return 'execução bloqueada: a branch da missão tem alterações feitas fora de um card. O orquestrador não é desenvolvedor; preserve o conteúdo, encaminhe o ajuste a um card FAST e só continue depois de restaurar uma fotografia limpa.'
        }
        if (expectedHead && currentHead && currentHead !== expectedHead) {
          // Mesmo rebaixamento do conclude_plan (doutrina 2026-08-10 aplicada
          // aqui em 2026-08-11 — caso real M09: merge manual AUDITADO como
          // idêntico ao commit aprovado travava o 3º card do plano e o único
          // remédio era reiniciar o app, que nem resolvia): a cadeia-de-cards
          // é guarda de JULGAMENTO e o orquestrador é dono da branch da
          // missão. A árvore LIMPA (guard acima) é o que fica de
          // verificabilidade; as cercas reais seguem sendo os gates do card
          // que vai rodar e a verificação conjunta no fim. Aceita, audita e
          // re-carimba — beco sem rota de saída é bug, não rigor (F6.8b).
          blackbox.record({
            cat: 'task',
            event: 'plan-execution-head-restamped',
            actor: id.role,
            ids: { projectId: id.projectId, missionId: id.missionId, taskId: plan.id },
            reason: `branch avançou fora da cadeia de cards (${expectedHead.slice(0, 12)} → ${currentHead.slice(0, 12)}) — aceito por autoridade do orquestrador no run_task; gates do card + verificação conjunta seguem como cerca`
          })
          if (plan.plan) {
            tasks.update(plan.id, { plan: { ...plan.plan, executionHead: currentHead } })
            plan = tasks.get(plan.id) ?? plan
          }
        }
        if (!expectedHead && currentHead && plan.plan) {
          tasks.update(plan.id, {
            plan: { ...plan.plan, executionHead: currentHead }
          })
        }
      }
      const running = ctx.phase.phaseOccupancy(id.projectId, taskId)
      if (running >= MAX_PARALLEL_RUNS)
        return `limite de ${MAX_PARALLEL_RUNS} execuções paralelas atingido — aguarde um evento de conclusão e chame run_task de novo`
      // Executor: lane do plano (contrato do usuário) > política do dept >
      // seat da missão > seat do PM.
      const lane = plan.plan?.lanes.find((l) => l.dept === taskIdentity.department)
      const pol = policies.get(id.projectId)[task.department]
      const slot = task.effort === 'pesada' ? (pol?.heavy ?? pol?.light) : (pol?.light ?? pol?.heavy)
      const mission = missionForRun
      let seatId: string | undefined
      let model: string | undefined
      if (lane?.seatId && seats.get(lane.seatId)) {
        seatId = lane.seatId
        model = lane.model
      } else if (slot?.seatId && seats.get(slot.seatId)) {
        seatId = slot.seatId
        model = lane?.model ?? (slot.model || undefined)
      } else {
        seatId = mission?.seatId ?? maestro.get(id.projectId).seatId
        model = lane?.model
      }
      const seat = seatId ? seats.get(seatId) : undefined
      if (!seat)
        return `sem seat válido para a função ${task.department} — a lane do plano não tem seat e não há política do departamento`
      if (isBannedModel(model)) model = undefined
      // id que não existe mais no catálogo degrada para o padrão do seat —
      // a execução nunca trava por modelo morto (caso gpt-5.4-mini).
      if (model) {
        try {
          const cat = await getCatalog(seat.cli, seats.configDirOf(seat))
          if (cat.models.length > 0 && !cat.models.some((m) => m.id === model)) model = undefined
        } catch {
          // catálogo indisponível — segue com o configurado
        }
      }
      const finalPlan = tasks.get(plan.id)
      const finalTask = tasks.get(taskId)
      if (
        finalPlan?.status !== 'execucao' ||
        finalTask?.missionId !== id.missionId ||
        finalTask.kind === 'plan' ||
        currentPlanOf(id.projectId, id.missionId)?.id !== plan.id
      ) {
        return 'o plano/card mudou ou foi pausado enquanto a fase era preparada; nenhum pane foi aberto'
      }
      const activeBeforeSpawn = ctx.phase.phaseOccupancy(id.projectId, taskId)
      if (activeBeforeSpawn >= MAX_PARALLEL_RUNS)
        return `limite de ${MAX_PARALLEL_RUNS} execuções paralelas atingido antes do spawn — tente novamente quando uma fase terminar`
      const spec = await ctx.phase.preparePhasePane(
        id.projectId,
        taskId,
        phase ?? 'dev',
        seat.id,
        model,
        lane?.effort,
        undefined,
        launchToken
      )
      if (!spec)
        return 'não deu para abrir a execução AGORA — causa mais comum: outra transição de fase deste card ainda em andamento (corrida) ou a janela do app recarregando. Aguarde ~5s e chame run_task de novo; se persistir 3+ vezes, confira board_status e a pasta do projeto'
      ctx.phase.openPhasePane(spec, id.projectId, taskId)
      hub.publish({
        projectId: id.projectId,
        missionId: id.missionId,
        kind: 'info',
        text: phase
          ? `orquestrador REABRIU o gate ${phase} de "${task.title}" (worktree preservado)`
          : `orquestrador INICIOU o card "${task.title}" (dev · seat ${seat.name}${model ? ` · ${model}` : ''}${lane?.effort ? ` · ${lane.effort}` : ''})`,
        actor: 'maestro'
      })
      return phase
        ? `gate ${phase} de "${task.title}" reaberto sobre o worktree existente — o veredito chega como evento`
        : `execução de "${task.title}" iniciada (seat ${seat.name}${model ? ` · ${model}` : ''}${lane?.effort ? ` · effort ${lane.effort}` : ''}) — o pipeline (dev → gates → merge na branch da missão) avisa por eventos "[synkora]"`
      } finally {
        phaseLaunchCapacity.release(id.projectId, capacityToken)
        phaseLaunches.release(taskId, launchToken)
      }
    },
    concludePlan: async (id, conclusion) => {
      if (id.role !== 'maestro' || !id.missionId) return 'só o orquestrador conclui o plano'
      let plan = currentPlanOf(id.projectId, id.missionId)
      if (!plan) return 'não há plano em execução para concluir'
      if (plan.status !== 'execucao') {
        // VÁLVULA SANCIONADA (2026-08-10): plano DONE cuja fotografia final
        // ficou DEFASADA (a branch ganhou commit fora da cadeia de cards —
        // ex.: runtime do teste de aceite commitado para limpar a árvore)
        // reabre SÓ para revalidar: a verificação conjunta re-roda no head
        // atual e o plano fecha sozinho pelo caminho normal. Era o beco do ⇪
        // ("revalide a fotografia atual" sem nenhuma ferramenta que
        // revalidasse). O range fora da cadeia fica auditado — nada entra em
        // silêncio.
        const staleProject = projects.get(id.projectId)
        const staleMission = staleProject ? missions.get(id.missionId) : undefined
        const staleCwd =
          staleProject && staleMission
            ? missionWorkspacePath(staleProject.path, staleMission)
            : undefined
        const staleHead = staleCwd ? gitHead(staleCwd) : undefined
        const staleFinal = plan.plan?.verification?.final
        const photoStale =
          plan.status === 'done' &&
          staleMission?.status === 'ativa' &&
          plan.plan !== undefined &&
          finalVerificationAccepted(staleFinal) &&
          typeof staleHead === 'string' &&
          staleFinal !== undefined &&
          typeof staleFinal.head === 'string' &&
          staleFinal.head !== staleHead
        if (!photoStale) return 'não há plano em execução para concluir'
        const deltaFrom = plan.plan?.executionHead ?? staleFinal?.head ?? ''
        tasks.update(plan.id, {
          status: 'execucao',
          plan: { ...plan.plan!, executionHead: staleHead as string }
        })
        blackbox.record({
          cat: 'task',
          event: 'plan-reverify-reopened',
          actor: id.role,
          ids: { projectId: id.projectId, missionId: id.missionId, taskId: plan.id },
          reason: `fotografia final defasada (${deltaFrom.slice(0, 12)} → ${(staleHead as string).slice(0, 12)}) — plano reaberto SÓ para a verificação conjunta re-rodar no head atual; commits fora da cadeia de cards entram SEM novo gate: confira o range no git se algum não for esperado`
        })
        hub.publish({
          projectId: id.projectId,
          missionId: id.missionId,
          kind: 'info',
          text: `plano de "${staleMission?.title ?? id.missionId}" reaberto para REVALIDAÇÃO da fotografia (${deltaFrom.slice(0, 10)} → ${(staleHead as string).slice(0, 10)}) — a verificação conjunta re-roda e o plano fecha sozinho`,
          actor: 'harness'
        })
        plan = tasks.get(plan.id) ?? plan
      }
      if (manualSecurityValidationPending(plan.plan, securityWaiverOptions(id.projectId))) {
        return 'conclusao bloqueada: este plano exige validacao humana de seguranca ainda pendente. O usuario precisa confirmar a evidencia ou dispensar com justificativa no card do plano.'
      }
      // consts para os callbacks (plan é `let` por causa da válvula acima —
      // closure perderia o narrowing do TS)
      const planKey = plan.id
      const planPreContract = !plan.plan?.executionMode
      const planCards = tasks
        .list(id.projectId)
        .filter(
          (t) =>
            t.missionId === id.missionId &&
            t.kind !== 'plan' &&
            (t.planId === planKey || (!t.planId && planPreContract))
        )
      // Cards do CONTRATO = o que o orquestrador prometeu na aprovação. Card
      // operacional criado pela FILA (sync) precisa estar done e com gates
      // válidos como os demais, mas fica FORA da contagem e do grafo — contar
      // trabalho do próprio harness era o deadlock de 2026-08-10.
      const planHasGraph = (plan.plan?.workItems ?? []).length > 0
      const contractCards = planCards.filter(
        (card) => !isHarnessQueueCard(card, { planHasWorkItems: planHasGraph })
      )
      const open = planCards.filter((task) => task.status !== 'done')
      if (open.length > 0)
        return `ainda há ${open.length} card(s) não concluído(s): ${open
          .map((t) => `"${t.title}" (${t.status})`)
          .join(' · ')} — rode com run_task, aguarde os eventos, ou remova com delete_task o que não será feito`
      const project = projects.get(id.projectId)
      let mission = missions.get(id.missionId)
      if (!project || !mission) return 'missão não encontrada'
      mission = ensureMissionWorktree(id.missionId) ?? mission
      const missionCwd = missionWorkspacePath(project.path, mission)
      if (!missionCwd || !mission.branch || !mission.worktree) {
        return 'conclusão bloqueada: não foi possível provar ou reanexar a branch isolada da missão; nada será concluído na branch principal'
      }
      const mode = normalizeExecutionMode(plan.plan?.executionMode)
      const expectedCards = plan.plan?.expectedCards ?? contractCards.length
      const completionProblems = validatePlanCompletion({
        mode,
        expectedCards,
        cards: contractCards.map((card) => ({ status: card.status }))
      })
      if (plan.plan?.expectedCards !== undefined && contractCards.length !== expectedCards) {
        completionProblems.push(
          `o plano aprovou ${expectedCards} card(s), mas ${contractCards.length} foram registrados; não é permitido pular ou apagar entrega para encerrar`
        )
      }
      const workItems = plan.plan?.workItems ?? []
      if (workItems.length > 0) {
        const deliveredItems = new Set(
          contractCards.map((card) => card.planItemId).filter(Boolean)
        )
        for (const item of workItems) {
          if (!deliveredItems.has(item.id))
            completionProblems.push(`o item aprovado ${item.id} não possui card entregue`)
        }
        if (deliveredItems.size !== contractCards.length)
          completionProblems.push('há card sem vínculo único com o grafo aprovado do plano')
      }
      for (const card of planCards.filter((candidate) => candidate.deliverable === 'code')) {
        if (card.verification?.contractVersion !== 1) continue
        const gates = card.gates ?? ['review', 'qa']
        for (const gate of gates) {
          const evidence = card.verification[gate]
          // 'waived' = dispensa por autoridade do orquestrador (complete_task)
          // — juízo auditado conta como desfecho válido do gate; a cerca do
          // merge é a verificação conjunta logo abaixo.
          const gateSettled =
            (evidence?.verdict === 'approved' && evidence.readonly === true) ||
            evidence?.verdict === 'waived'
          if (!gateSettled) {
            completionProblems.push(`"${card.title}" não possui evidência válida do gate ${gate}`)
          }
        }
      }
      if (completionProblems.length > 0) {
        return `conclusão bloqueada pelo contrato verificável: ${completionProblems.join('; ')}`
      }
      if (isWorktreeClean(missionCwd) !== true) {
        return 'conclusão bloqueada: a branch da missão não está limpa; alterações fora de cards ou artefatos de verificação precisam ser enquadrados antes de concluir'
      }
      const head = gitHead(missionCwd)
      if (plan.plan?.executionHead && head && head !== plan.plan.executionHead) {
        // Rebaixamento (doutrina 2026-08-10, "guardas não capam julgamento"):
        // a cadeia-de-cards era guarda de JULGAMENTO — o orquestrador é dono
        // da branch da missão (merge manual de card concluído por autoridade
        // é legítimo; caso real: a entrega 767a6a8 verde recusada aqui). A
        // cerca REAL é a verificação conjunta que roda em seguida no head
        // verdadeiro. Aceita, audita e re-carimba.
        blackbox.record({
          cat: 'task',
          event: 'plan-execution-head-restamped',
          actor: id.role,
          ids: { projectId: id.projectId, missionId: id.missionId, taskId: plan.id },
          reason: `branch avançou fora da cadeia de cards (${plan.plan.executionHead.slice(0, 12)} → ${head.slice(0, 12)}) — aceito por autoridade do orquestrador; a verificação conjunta prova o head atual`
        })
        tasks.update(plan.id, { plan: { ...plan.plan, executionHead: head } })
        plan = tasks.get(plan.id) ?? plan
      }
      const final = plan.plan?.verification?.final
      if (
        finalVerificationAccepted(final) &&
        final?.head === head &&
        final?.pendingConclusion === conclusion
      ) {
        closeVerifiedPlan(plan.id)
        return tasks.get(plan.id)?.status === 'done'
          ? 'plano concluído: todos os cards e a fotografia combinada foram verificados. Avise o usuário e aguarde o aval explícito para integrar.'
          : 'a evidência final ficou desatualizada; a verificação será refeita'
      }
      if (finalVerificationRuns.has(plan.id)) {
        return 'a verificação conjunta da missão já está em andamento — aguarde o evento do harness; não abra outro gate nem repita os cards'
      }
      startFinalPlanVerification(plan, conclusion)
      return 'todos os cards foram entregues. Iniciei a verificação conjunta na branch da missão; o plano só será marcado como concluído quando essa fotografia passar. Você receberá um evento automático. ENQUANTO ELA RODA: grave o aprendizado durável desta missão via record_learnings (5-15 linhas destiladas por tópico — decisões, pegadinhas, pedras; nunca o que board_status/git já respondem).'
    },
    // AUTONOMIA (ordem do dono, 2026-08-10 — "dá autonomia pro orquestrador";
    // caso real: um dev inteiro queimado só para re-carimbar fotografia de
    // trabalho já pronto, com finalize/reabrir-gate/adjustment TODOS
    // recusando): o orquestrador declara o card CONCLUÍDO por juízo próprio,
    // com motivo auditado verbatim. O motor faz a higiene (panes/watch/
    // espera/runtime) e carimba 'waived' nos gates que faltarem — juízo
    // REGISTRADO, nunca evidência fabricada. As cercas que ficam são as de
    // autoridade: verificação conjunta no conclude_plan e o ⇪ do dono.
    completeTask: (id, taskId, reason) => {
      if (id.role !== 'maestro')
        return 'só o Maestro/orquestrador conclui card por autoridade'
      const task = tasks.get(taskId)
      if (!task || task.projectId !== id.projectId) return 'card não encontrado'
      if (id.missionId && task.missionId !== id.missionId)
        return 'card não pertence à sua missão'
      if (!id.missionId && task.missionId)
        return 'card de missão se conclui pelo orquestrador dela'
      if (task.kind === 'plan')
        return 'o card de PLANO se conclui via conclude_plan (a verificação conjunta é a cerca do merge)'
      if (!task.auto)
        return 'card criado pelo usuário é dele — peça a ele para concluir no board'
      if (task.status === 'done') return 'card já está concluído'
      const why = (reason ?? '').trim()
      if (why.length < 10)
        return 'reason obrigatório: diga em 1-2 frases POR QUE o trabalho já está pronto/validado — vai auditado verbatim para a caixa-preta'
      if (ctx.phaseTransitions.isLocked(taskId))
        return 'há um veredito de fase fechando neste card AGORA — aguarde alguns segundos e chame de novo'
      ctx.phase.closeLiveGateWait(
        id.projectId,
        taskId,
        'card concluído por autoridade do orquestrador'
      )
      for (const role of ['dev', 'review', 'qa'] as const)
        ctx.phase.terminateTaskPhasePane(id.projectId, taskId, role)
      phaseWatches.delete(taskId)
      // Fecho do ciclo de vida do card também aqui (caminho próprio, não
      // passa pelo finalizeTask): a reserva CDP por card morre com o card.
      releaseQaCdpPort(taskId)
      const verification: NonNullable<Task['verification']> = {
        ...(task.verification ?? { contractVersion: 1 as const }),
        activeGate: undefined
      }
      const waivedGates: Array<'review' | 'qa'> = []
      for (const gate of (task.gates ?? ['review', 'qa']) as Array<'review' | 'qa'>) {
        const evidence = verification[gate]
        if (evidence?.verdict === 'approved' && evidence.readonly === true) continue
        const now = new Date().toISOString()
        verification[gate] = {
          phase: gate,
          verdict: 'waived',
          startedAt: now,
          finishedAt: now,
          readonly: true,
          reason: `dispensado por autoridade do orquestrador: ${why.slice(0, 300)}`
        }
        waivedGates.push(gate)
      }
      tasks.update(taskId, {
        status: 'done',
        activePhase: undefined,
        phaseState: undefined,
        phaseStartedAt: undefined,
        phaseResume: undefined,
        verification
      } as Partial<Task>)
      blackbox.record({
        cat: 'task',
        event: 'task-completed-by-authority',
        actor: id.role,
        ids: { projectId: id.projectId, missionId: id.missionId, taskId },
        reason: `${why.slice(0, 400)}${waivedGates.length ? ` · gates dispensados: ${waivedGates.join('+')}` : ''}`
      })
      hub.publish({
        projectId: id.projectId,
        missionId: task.missionId,
        kind: 'task-updated',
        text: `orquestrador concluiu "${task.title}" por autoridade própria${waivedGates.length ? ` (gates ${waivedGates.join('+')} dispensados)` : ''}: ${why.slice(0, 140)}`,
        actor: id.role,
        quiet: true
      })
      ctx.pushAll('tasks:changed', id.projectId)
      syncBoard(id.projectId)
      return `card "${task.title}" CONCLUÍDO por sua autoridade (motivo auditado)${waivedGates.length ? ` — gates ${waivedGates.join('+')} registrados como dispensados por você` : ''}. A verificação conjunta do conclude_plan e o ⇪ do dono seguem valendo.${
        task.verification?.dev?.head
          ? ` ATENÇÃO: complete_task NÃO mescla a branch task/${taskId.slice(0, 8)} na branch da missão — se a entrega ainda vive só lá, faça você mesmo o merge --no-ff (sua branch, sua autoridade) antes do conclude_plan.`
          : ''
      }`
    },
    // AUTORIDADE PLENA SOBRE OS PANES (ordem do dono 2026-08-12, caso real
    // M09: "pode fechar o pane dele" e o orquestrador não tinha ferramenta —
    // "ele tem que poder fazer o que quiser"): o gêmeo do complete_task.
    // Parar NUNCA fabrica veredito: gate parado encerra a rodada sem veredito
    // e run_task {phase} reabre; o trabalho do dev fica intacto (worktree,
    // commits, conversa preservada para resume).
    stopTask: (id, taskId, reason) => {
      if (id.role !== 'maestro')
        return 'só o Maestro/orquestrador para um card por autoridade'
      const task = tasks.get(taskId)
      if (!task || task.projectId !== id.projectId) return 'card não encontrado'
      if (id.missionId && task.missionId !== id.missionId)
        return 'card não pertence à sua missão'
      if (!id.missionId && task.missionId)
        return 'card de missão se para pelo orquestrador dela'
      if (task.kind === 'plan')
        return 'o card de PLANO se pausa pelo dono no board (⏸) — não por aqui'
      if (task.status === 'done') return 'card já está concluído — nada rodando para parar'
      if (task.status !== 'execucao' && task.status !== 'qa')
        return 'card não tem fase rodando — já está parado no backlog'
      const why = (reason ?? '').trim()
      if (why.length < 10)
        return 'reason obrigatório: diga em 1-2 frases POR QUE está parando — vai auditado verbatim para a caixa-preta'
      if (ctx.phaseTransitions.isLocked(taskId))
        return 'há um veredito de fase fechando neste card AGORA — aguarde alguns segundos e chame de novo'
      const stoppedPhase = task.activePhase ?? 'dev'
      ctx.phase.closeLiveGateWait(id.projectId, taskId, 'card parado por autoridade do orquestrador')
      for (const role of ['dev', 'review', 'qa'] as const)
        ctx.phase.terminateTaskPhasePane(id.projectId, taskId, role)
      phaseWatches.delete(taskId)
      tasks.update(taskId, {
        status: 'backlog',
        activePhase: stoppedPhase,
        phaseState: 'interrupted',
        phaseStartedAt: undefined,
        // feedback TEM UM DONO (F6.8b): a nota operacional do stop NUNCA
        // sobrescreve uma lista de reprovação pendente.
        feedback: task.feedback ?? `parado pelo orquestrador: ${why.slice(0, 300)}`
      } as Partial<Task>)
      blackbox.record({
        cat: 'task',
        event: 'task-stopped-by-authority',
        actor: id.role,
        ids: { projectId: id.projectId, missionId: id.missionId, taskId, phase: stoppedPhase },
        reason: why.slice(0, 400)
      })
      hub.publish({
        projectId: id.projectId,
        missionId: task.missionId,
        kind: 'task-updated',
        text: `orquestrador PAROU "${task.title}" (fase ${stoppedPhase}) por autoridade própria: ${why.slice(0, 140)}`,
        actor: id.role,
        quiet: true
      })
      ctx.pushAll('tasks:changed', id.projectId)
      syncBoard(id.projectId)
      return `card "${task.title}" PARADO (fase ${stoppedPhase} encerrada, motivo auditado): pane fechado, trabalho preservado (worktree/commits/conversa intactos), card de volta ao backlog como interrompido — sem contar ciclo. run_task {id: "${taskId}"} retoma quando você decidir${
        stoppedPhase !== 'dev' ? `; a rodada do gate morreu SEM veredito — run_task {id, phase: "${stoppedPhase}"} reabre só o gate` : ''
      }.`
    },
    deleteTask: (id, taskId) => {
      if (id.role !== 'maestro' || !id.missionId) return 'só o orquestrador remove cards'
      const task = tasks.get(taskId)
      if (!task || task.missionId !== id.missionId) return 'card não encontrado nesta missão'
      if (task.kind === 'plan') return 'o card de plano não se remove por aqui'
      if (!task.auto)
        return 'só cards AUTO (criados por você no modo plano) podem ser removidos — cards do usuário são dele'
      if (task.status === 'execucao' || task.status === 'qa')
        return 'card em execução/QA — aguarde o pipeline terminar (ou o evento de erro) antes de remover'
      if (ctx.phaseTransitions.isLocked(taskId))
        return 'não removi o card: há um veredito de fase fechando nele agora — aguarde alguns segundos e chame delete_task de novo'
      if (!removeTaskCascade(task))
        return 'não removi o card: .synkora está rastreado pelo Git (retire o runtime do versionamento) ou uma transição de fase começou neste instante — corrija/aguarde e tente de novo'
      hub.publish({
        projectId: id.projectId,
        missionId: id.missionId,
        kind: 'task-updated',
        text: `orquestrador removeu o card "${task.title}" (não será feito)`,
        actor: 'maestro'
      })
      ctx.pushAll('tasks:changed', id.projectId)
      syncBoard(id.projectId)
      return `card "${task.title}" removido do board`
    },
    setPhaseExecutor: async (id, taskId, seatQuery, ownerOrder, model, effort) => {
      if (id.role !== 'maestro')
        return 'apenas o PM ou o orquestrador trocam o executor de uma fase — e SEMPRE por ordem explícita do dono'
      const order = ownerOrder?.trim()
      if (!order || order.length < 8)
        return 'recusado: ownerOrder precisa da ordem VERBATIM do dono. A troca de executor é prerrogativa DELE — sem ordem registrada, pergunte via ask_user e espere'
      const task = tasks.get(taskId)
      if (!task || task.projectId !== id.projectId) return 'card não encontrado neste projeto'
      if (id.missionId && task.missionId !== id.missionId)
        return 'um orquestrador só troca executor de card da PRÓPRIA missão'
      const q = seatQuery.trim().toLowerCase()
      const seat = seats.list().find((s) => s.id === seatQuery.trim() || s.name.toLowerCase() === q)
      if (!seat) return `conta "${seatQuery}" não encontrada — use o NOME exato do list_seats`
      if (model && isBannedModel(model))
        return `o modelo ${model} é banido para agentes — escolha outro do list_seats`
      hub.publish({
        projectId: id.projectId,
        missionId: task.missionId,
        kind: 'info',
        text:
          `troca de executor solicitada para "${task.title}": ${seat.name}` +
          `${model?.trim() ? ` · ${model.trim()}` : ''}${effort?.trim() ? ` · ${effort.trim()}` : ''}. ` +
          'A alteração só acontece pelo controle do próprio card, acionado pelo dono.',
        actor: 'maestro',
        urgent: true
      })
      return (
        `pedido registrado, mas nenhuma conta/modelo foi alterado. ` +
        `O dono precisa confirmar no controle do card "${task.title}". Ordem citada: ${order}`
      )
    }
  }
}

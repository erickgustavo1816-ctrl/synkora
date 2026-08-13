/**
 * MCP API — domínio missions (fase 1, commit 4c).
 * Ciclo de vida de missões e roadmap: criar/arquivar, plano mestre,
 * integração (fila FIFO), release e os aprova-com-humano do projeto.
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing; uiSender/mcpPort e a
 * máquina de fases são lidos via ctx (getters/ctx.phase).
 */
import { app } from 'electron'
import { join, resolve } from 'path'
import { ensureSynkoraGitExcludes, gitCommitReached, gitHead, isWorktreeClean } from '../worktree'
import { type Mission, type NewMission } from '../missions'
import { type IntegrationQueueTicketView } from '../integrationQueue'
import { randomUUID } from 'crypto'
import { type PaneIdentity } from '../hub'
import { type NewMissionInput, type SaveProjectPlanInput } from '../mcpServer'
import { type PlanningMethodEvidence } from '../skillRuntime'
import {
  approveProjectPlan as approveStoredProjectPlan,
  projectPlanExecutionWindow,
  projectPlanReleaseBlockers,
  projectPlanReleaseGate,
  saveProjectPlanDraft,
  startProjectMission as bindProjectMission,
  validateProjectPlanForApproval,
  type ProjectPlan
} from '../projectPlan'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface MissionsApiExtras {
  emitMissionsChanged(projectId: string): void
  emitBacklogChanged(projectId: string): void
  missionWorkspacePath(projectPath: string, mission: Mission): string | undefined
  clearMissionStartIntent(projectPath: string, missionId: string): void
  writeMissionStartIntent(
    projectPath: string,
    intent: { projectId: string; itemId: string; missionId: string; createdAt: string }
  ): void
  createMissionImpl(
    projectId: string,
    input: NewMission,
    actor: string,
    reservedId?: string
  ): Mission | null
  ensureMissionVersion(
    projectId: string,
    input?: { id?: string; name?: string; theme?: string; goal?: string }
  ): { versionId?: string; name?: string; error?: string }
  rollbackPlannedMission(projectId: string, missionId: string): void
  startMissionIntegration(missionId: string, actor: string): string
  ensurePlannedMissionBacklogItem(
    projectId: string,
    mission: Mission,
    item: ProjectPlan['roadmap'][number]
  ): string | undefined
  transitionLinkedProjectPlanMission(
    projectId: string,
    missionId: string,
    action: 'archive' | 'reactivate' | 'detach'
  ): string | undefined
  stopMissionExecution(projectId: string, missionId: string, reason: string): void
  scheduleIntegrationDrain(projectId: string): void
  resolveMissionIntegrationTarget(
    project: { id: string; path: string },
    mission: Mission
  ): { kind: 'base' | 'version'; dir: string; branch: string; label: string; versionId?: string } | undefined
  createIntegrationSyncTask(
    ticket: IntegrationQueueTicketView,
    mission: Mission,
    target: { kind: 'base' | 'version'; dir: string; branch: string; label: string; versionId?: string },
    targetHead: string,
    instruction?: string
  ): boolean
  /** Handshake de autorização humana 1-uso — compartilhado POR REFERÊNCIA
   * com os IPCs projectPlan:approve / projectPlan:startMission. */
  humanProjectPlanApprovals: Set<string>
  humanProjectMissionStarts: Set<string>
  preparePlanningArtifactEvidence(
    id: PaneIdentity,
    skillApplications: string[] | undefined
  ):
    | { ok: true; evidence: PlanningMethodEvidence; accept: () => boolean }
    | { ok: false; message: string }
  /** 2.0: encerra dev/reviewer/ajudantes GUI da missão (fonte única no index). */
  killMissionGuiPanes(missionId: string): void
}

export function buildMissionsApi(
  ctx: MainContext,
  extras: MissionsApiExtras
): Pick<McpApi, 'archiveMission' | 'removeBacklogItem' | 'registerDirectMission' | 'saveProjectPlan' | 'approveProjectPlan' | 'guideIntegrationResolution' | 'startProjectMission' | 'createMission' | 'integrateMission' | 'queueMissions' | 'releaseVersion' | 'setReleaseHold'> {
  const {
    projects,
    missions,
    ptys,
    maestro,
    integrationQueue,
    backlog,
    syncBoard,
    projectModeOf,
    projectPlanOf,
    unregisterPane,
    orchPaneId,
    blackbox
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  const {
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
    preparePlanningArtifactEvidence,
    killMissionGuiPanes
  } = extras
  return {
    archiveMission: (id, query) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) arquiva missões'
      const q = query.trim().toLowerCase()
      const list = missions.list(id.projectId).filter((m) => m.status === 'ativa')
      let matches = list.filter((m) => m.id === query.trim() || m.id.startsWith(query.trim()))
      if (matches.length === 0) matches = list.filter((m) => m.title.toLowerCase().includes(q))
      if (matches.length === 0)
        return 'missão ATIVA não encontrada com esse id/título — confira no board_status'
      if (matches.length > 1)
        return `mais de uma missão casa com "${query}": ${matches
          .map((m) => `"${m.title}" (${m.id.slice(0, 8)})`)
          .join(', ')} — repita com o id`
      const m = matches[0]
      const queued = integrationQueue.getByMission(m.id)
      if (queued?.state === 'merging') {
        return `não arquivei a missão "${m.title}": ela está no instante de merge da cabeça da fila`
      }
      // F2-c4 (§5.3): veredito em voo em card da missão — recusa com receita
      // ANTES de qualquer mutação (transition/cancel/stop).
      const inTransition = ctx.tasks
        .list(id.projectId)
        .filter((t) => t.missionId === m.id && ctx.phaseTransitions.isLocked(t.id))
      if (inTransition.length > 0) {
        return `não arquivei a missão "${m.title}": há veredito de fase fechando em ${inTransition
          .map((t) => `"${t.title}"`)
          .join(', ')} — aguarde alguns segundos e chame archive_mission de novo`
      }
      const planError = transitionLinkedProjectPlanMission(id.projectId, m.id, 'archive')
      if (planError) return `não arquivei a missão: ${planError}`
      if (queued) integrationQueue.cancel(m.id)
      stopMissionExecution(
        id.projectId,
        m.id,
        'execução pausada porque a missão foi arquivada pelo Maestro; ao reativar, revise o transcript e rode o card novamente'
      )
      const paneId = orchPaneId(id.projectId, m.id)
      if (ptys.has(paneId)) ptys.kill(paneId)
      unregisterPane(paneId)
      // 2.0: missão direta não tem orquestrador, mas tem chats (dev/reviewer/
      // ajudantes) com cwd no worktree — arquivar encerra os três.
      killMissionGuiPanes(m.id)
      missions.update(m.id, { status: 'arquivada' })
      hub.publish({
        projectId: id.projectId,
        kind: 'info',
        text: `missão "${m.title}" ARQUIVADA pelo PM (branch ${m.branch ?? '—'} preservada) — reativável na aba Versões`,
        actor: 'maestro'
      })
      emitMissionsChanged(id.projectId)
      syncBoard(id.projectId)
      if (queued) scheduleIntegrationDrain(id.projectId)
      return `missão "${m.title}" arquivada — branch ${m.branch ?? 'sem branch'} preservada; reativável na aba Versões → missões`
    },
    removeBacklogItem: (id, query) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) remove itens de backlog'
      const q = query.trim().toLowerCase()
      const items = backlog.listItems(id.projectId)
      let matches = items.filter((i) => i.id === query.trim())
      if (matches.length === 0)
        matches = items.filter((i) => i.title.toLowerCase().includes(q))
      if (matches.length === 0)
        return 'item não encontrado — confira o título exato na aba Versões/board_status'
      if (matches.length > 1)
        return `mais de um item casa com "${query}": ${matches
          .map((i) => `"${i.title}" (${i.id.slice(0, 8)})`)
          .join(', ')} — repita com o id`
      const item = matches[0]
      if (item.status === 'feito') return 'esse item já foi FEITO — histórico não se apaga'
      const v = item.versionId ? backlog.getVersion(item.versionId) : undefined
      if (v?.status === 'lancada')
        return `a versão ${v.name} já foi lançada — histórico read-only`
      emitBacklogChanged(id.projectId)
      hub.publish({
        projectId: id.projectId,
        kind: 'info',
        text:
          `remoção solicitada para o item "${item.title}". Nada foi apagado: ` +
          'o dono precisa confirmar a exclusão na aba Versões.',
        actor: 'maestro',
        urgent: true
      })
      return (
        `pedido para remover "${item.title}" registrado${v ? ` na ${v.name}` : ''}. ` +
        'O item continua no backlog até a confirmação humana na aba Versões.'
      )
    },
    registerDirectMission: (id, title, points) => {
      if (id.role !== 'livre')
        return 'essa tool é do AGENTE LIVRE — o trabalho de dev/gate/missão já é registrado pelo próprio pipeline'
      const masterPlan = projectPlanOf(id.projectId)
      if (projectModeOf(id.projectId) === 'greenfield' && masterPlan?.status !== 'done') {
        return 'este projeto novo ainda segue o plano mestre — não registre trabalho avulso antes da publicação final; volte ao Maestro e siga a missão indicada'
      }
      if (!title.trim() || points.length === 0) return 'título e pontos são obrigatórios'
      // registro cai na versão CORRENTE — o trabalho já está na base
      const versionId = backlog.ensureDefaultVersion(id.projectId).id
      const mission = missions.createDirect(id.projectId, {
        title: title.trim(),
        points,
        versionId
      })
      backlog.addDelivery(versionId, mission.id, mission.title)
      emitBacklogChanged(id.projectId)
      emitMissionsChanged(id.projectId)
      syncBoard(id.projectId)
      hub.publish({
        projectId: id.projectId,
        kind: 'info',
        text: `missão DIRETA registrada (trabalho de agente livre na base): "${mission.title}" — ${points.length} ponto(s)`,
        actor: id.role
      })
      return `registrado: missão direta "${mission.title}" (${points.length} ponto(s)) na versão corrente — o PM foi avisado`
    },
    saveProjectPlan: (id, input: SaveProjectPlanInput) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) mantém o plano mestre'
      const planningEvidence = preparePlanningArtifactEvidence(id, input.skillApplications)
      if (!planningEvidence.ok) return `não salvei o plano mestre: ${planningEvidence.message}`
      const project = projects.get(id.projectId)
      if (!project) return 'projeto não encontrado'
      try {
        ensureSynkoraGitExcludes(project.path)
      } catch (error) {
        return 'não salvei o plano mestre: ' +
          (error instanceof Error ? error.message : String(error))
      }
      if (projectModeOf(id.projectId) !== 'greenfield')
        return 'este é um projeto existente — use missões pontuais; o plano mestre automático pertence ao fluxo de pasta vazia'
      try {
        const now = new Date().toISOString()
        const {
          planningStage,
          planningContribution,
          skillApplications: _skillApplications,
          ...draft
        } = input
        const { skillId, ...receiptEvidence } = planningEvidence.evidence
        const trustedPlanningEvidence = {
          id: skillId,
          stage: planningStage,
          contribution: planningContribution,
          usedAt: now,
          ...receiptEvidence,
          planningRevision: now
        } as const
        const plan = saveProjectPlanDraft(project.path, {
          ...draft,
          now,
          planningEvidence: trustedPlanningEvidence
        })
        const persistedPlanningEvidence = plan.planningSkills.find(
          (entry) => entry.receiptId === trustedPlanningEvidence.receiptId
        )
        if (!persistedPlanningEvidence?.planningFingerprint) {
          return 'não salvei o plano mestre: a fotografia não recebeu um fingerprint de conteúdo verificável'
        }
        if (!planningEvidence.accept()) {
          return 'não salvei o plano mestre: o receipt expirou antes da confirmação do artefato; reabra o Maestro'
        }
        projects.setPlanningEvidence(id.projectId, persistedPlanningEvidence)
        syncBoard(id.projectId)
        const missing = validateProjectPlanForApproval(plan)
        return (
          'plano mestre atualizado em .synkora/PROJECT_PLAN.md (' +
          plan.roadmap.length +
          ' missões futuras). ' +
          (missing.length
            ? 'Antes da revisão final ainda falta: ' +
              missing.join('; ') +
              '. Explique ao usuário onde a descoberta está e faça somente a próxima pergunta lógica.'
            : 'O mapa já tem os elementos obrigatórios: mostre-o ao usuário para revisão e aguarde o aval explícito. NÃO abra missão antes desse aval.')
        )
      } catch (error) {
        return 'não salvei o plano mestre: ' + (error instanceof Error ? error.message : String(error))
      }
    },
    approveProjectPlan: (id) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) aprova o plano mestre'
      const project = projects.get(id.projectId)
      if (!project) return 'projeto não encontrado'
      if (!humanProjectPlanApprovals.has(id.projectId)) {
        hub.publish({
          projectId: id.projectId,
          kind: 'info',
          text:
            'o Maestro solicitou aprovação do plano mestre. Nenhum status mudou: ' +
            'o dono precisa abrir o Mapa e clicar em “aprovar roadmap”.',
          actor: 'maestro',
          urgent: true
        })
        return (
          'pedido de aprovação registrado, mas o plano continua pendente. ' +
          'Somente o clique humano “aprovar roadmap” pode alterar o status.'
        )
      }
      try {
        ensureSynkoraGitExcludes(project.path)
      } catch (error) {
        return 'não aprovei o plano mestre: ' +
          (error instanceof Error ? error.message : String(error))
      }
      if (projectModeOf(id.projectId) !== 'greenfield')
        return 'este projeto foi classificado como existente — o fluxo de plano mestre não se aplica'
      try {
        const plan = approveStoredProjectPlan(project.path, undefined, {
          requireTrustedEvidence: true,
          trustedEvidence: project.planningEvidence,
          trustedLegacyApproval: project.legacyPlanningApproval
        })
        syncBoard(id.projectId)
        const ready = plan.readyItemIds
          .map((itemId) => plan.roadmap.find((item) => item.id === itemId))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
        const releaseGate = projectPlanReleaseGate(plan)
        return (
          'plano mestre APROVADO (' +
          plan.roadmap.length +
          ' missões no roadmap). ' +
           (ready.length > 0
             ? `Onda ${plan.currentWaveId}: ${ready.length} missão(ões) pronta(s) para abrir em paralelo — ` +
               ready.map((item) => `${item.title} [${item.id}]`).join(', ') +
               '. Aguarde o usuário autorizar a onda (ou itens dela) antes de chamar start_project_mission para cada uma.'
             : releaseGate
               ? 'Próximo passo único: revisar e publicar ' +
                 releaseGate.versionName +
                 '; nenhuma missão da versão seguinte está liberada ainda.'
             : 'Nenhuma missão está liberada; revise dependências no roadmap.')
        )
      } catch (error) {
        return 'não aprovei o plano mestre: ' + (error instanceof Error ? error.message : String(error))
      }
    },
    guideIntegrationResolution: (id, missionId, instruction, directResolution) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o Maestro do projeto decide a estratégia de um conflito da fila'
      const mission = missions.get(missionId)
      if (!mission || mission.projectId !== id.projectId)
        return 'missão não encontrada neste projeto'
      const project = projects.get(id.projectId)
      if (!project) return 'projeto não encontrado'
      const queued = integrationQueue.getByMission(missionId)
      if (
        !queued ||
        !(
          (queued.state === 'blocked' && queued.block?.owner === 'maestro') ||
          (queued.state === 'sync_required' && queued.resolution?.decidedBy === 'maestro')
        )
      )
        return 'esta missão não está aguardando uma decisão do Maestro na fila'
      const target = resolveMissionIntegrationTarget(project, mission)
      const targetHead = target ? gitHead(target.dir) : undefined
      if (!target || !targetHead)
        return 'não consegui preparar o destino para transformar sua decisão em um card seguro'
      // RESOLUÇÃO DIRETA AUDITADA (ordem do dono, 2026-08-11 — caso real M08:
      // conflito de UMA linha no package.json custou estratégia + card de
      // sync + dev + gates): quando o conflito é MECÂNICO e o próprio
      // Maestro já o resolveu na branch da missão (merge do destino +
      // commit), esta chamada re-lacra o ticket no head novo e a fila
      // retoma com o aval ORIGINAL do dono — sem card, sem gates novos.
      // Cercas que ficam: origem provada LIMPA e contendo o head do destino;
      // range da resolução auditado verbatim (o diff é reproduzível por
      // qualquer um via git); o drain re-roda o precheck do merge real.
      // Conflito semântico continua no fluxo com card — o julgamento
      // mecânico×semântico é do Maestro, auditado (doutrina F6.12).
      if (directResolution) {
        const missionSource = missionWorkspacePath(project.path, mission)
        if (!missionSource)
          return 'não encontrei o worktree da missão para validar a resolução direta'
        if (isWorktreeClean(missionSource) !== true)
          return 'resolução direta recusada: a branch da missão tem alterações não commitadas — commite a resolução (ou limpe a árvore) e chame de novo'
        if (gitCommitReached(missionSource, targetHead) !== true)
          return `resolução direta recusada: a branch da missão ainda não contém o head do destino (${targetHead.slice(0, 12)}) — faça o merge de ${target.branch} na branch da missão, resolva, commite e chame de novo; se o conflito não for mecânico, use o fluxo normal (sem directResolution) para abrir o card de sincronização`
        const newSourceHead = gitHead(missionSource)
        if (!newSourceHead)
          return 'resolução direta recusada: não consegui ler o head atual da branch da missão'
        try {
          if (queued.state === 'blocked') {
            integrationQueue.guideResolution(missionId, { instruction })
          } else if (queued.resolution?.instruction.trim() !== instruction.trim()) {
            return `já existe uma estratégia persistida para esta posição e ela não foi sobrescrita: ${queued.resolution?.instruction}`
          }
          integrationQueue.requeueAfterSync(missionId, {
            sourceHead: newSourceHead,
            validatedTargetHead: targetHead,
            targetBranch: target.branch,
            targetDir: resolve(target.dir)
          })
        } catch (error) {
          return (
            'não registrei a resolução direta: ' +
            (error instanceof Error ? error.message : String(error))
          )
        }
        blackbox.record({
          cat: 'queue',
          event: 'queue-direct-resolution',
          actor: id.role,
          ids: { projectId: project.id, missionId },
          reason: `Maestro resolveu o conflito da posição #${queued.position} DIRETO na branch da missão (${(queued.sourceHead ?? '?').slice(0, 12)} → ${newSourceHead.slice(0, 12)}; destino ${targetHead.slice(0, 12)}) — sem card; estratégia verbatim: ${instruction.slice(0, 600)}`
        })
        hub.publish({
          projectId: project.id,
          missionId,
          kind: 'info',
          text: `o Maestro resolveu o conflito da fila DIRETAMENTE na branch da missão "${mission.title}" (resolução mecânica auditada) — a fila retoma sozinha com o aval original; nenhum card novo`,
          actor: 'harness',
          urgent: true
        })
        emitMissionsChanged(project.id)
        syncBoard(project.id)
        scheduleIntegrationDrain(project.id)
        return (
          `resolução direta aceita para "${mission.title}": ticket re-lacrado em ${newSourceHead.slice(0, 12)} e fila retomada na posição #${queued.position} com o aval original do dono. ` +
          'O merge real ainda passa pelo precheck do drain; se algo divergir, a fila pausa de novo com o motivo.'
        )
      }
      try {
        // A decisão é a fonte de verdade e nasce ANTES do card. Se o app cair
        // no intervalo, boot/retry recriam o card usando somente a orientação
        // já persistida — uma segunda frase nunca diverge silenciosamente.
        const guided =
          queued.state === 'blocked'
            ? integrationQueue.guideResolution(missionId, { instruction })
            : queued
        if (
          queued.state === 'sync_required' &&
          queued.resolution?.instruction.trim() !== instruction.trim()
        ) {
          return `já existe uma estratégia persistida para esta posição e ela não foi sobrescrita: ${queued.resolution?.instruction}`
        }
        const persistedInstruction = guided.resolution?.instruction
        if (!persistedInstruction)
          return 'a fila preservou a posição, mas não conseguiu recuperar a decisão persistida'
        if (
          !createIntegrationSyncTask(
            guided,
            mission,
            target,
            targetHead,
            persistedInstruction
          )
        ) {
          return 'a estratégia ficou persistida e a posição foi preservada, mas o card ainda não pôde ser aberto. O app tentará repará-lo no próximo boot; revise também o plano aprovado desta missão.'
        }
        hub.publish({
          projectId: mission.projectId,
          missionId: mission.id,
          kind: 'info',
          text: 'o Maestro decidiu como resolver o bloqueio da fila. A orientação persistida está no único card operacional; execute-o, conclua o plano e a fila retomará automaticamente a autorização original',
          actor: 'harness',
          urgent: true
        })
        emitMissionsChanged(mission.projectId)
        syncBoard(mission.projectId)
        return (
          `estratégia registrada para "${mission.title}" na posição #${guided.position}: ${persistedInstruction}. ` +
          'O orquestrador recebeu um card de sincronização, review e QA; a fila preservou a posição.'
        )
      } catch (error) {
        return 'não registrei a estratégia: ' + (error instanceof Error ? error.message : String(error))
      }
    },
    startProjectMission: (id, itemId) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) abre missões do plano mestre'
      const project = projects.get(id.projectId)
      if (!project) return 'projeto não encontrado'
      const humanStartKey = `${id.projectId}:${itemId.trim()}`
      if (!humanProjectMissionStarts.has(humanStartKey)) {
        hub.publish({
          projectId: id.projectId,
          kind: 'info',
          text:
            `o Maestro solicitou abrir o item ${itemId.trim()} do roadmap. ` +
            'Nenhuma missão foi criada: o dono precisa confirmar esse item no Mapa.',
          actor: 'maestro',
          urgent: true
        })
        return (
          `pedido para abrir ${itemId.trim()} registrado, mas nenhuma missão foi criada. ` +
          'Somente a confirmação humana no Mapa autoriza esta ação.'
        )
      }
      if (projectModeOf(id.projectId) !== 'greenfield')
        return 'este projeto foi classificado como existente — use create_mission para melhorias pontuais'
      const plan = projectPlanOf(id.projectId)
      if (!plan) return 'sem plano mestre — construa o rascunho com save_project_plan'
      const item = plan.roadmap.find((candidate) => candidate.id === itemId.trim())
      if (!item) return 'item "' + itemId + '" não existe no roadmap'
      if (item.missionId) {
        const linked = missions.get(item.missionId)
        return linked
          ? 'a missão "' +
              linked.title +
              '" já está vinculada a ' +
              item.id +
              ' (id ' +
              linked.id +
              ', status ' +
              linked.status +
              ') — não criei duplicata'
          : 'o item ' +
              item.id +
              ' já guarda a missão ' +
              item.missionId +
              '; revise o plano antes de tentar de novo'
      }
      if (plan.status !== 'approved' && plan.status !== 'in_progress')
        return 'o plano mestre ainda não foi aprovado explicitamente pelo usuário'
      const planProblems = validateProjectPlanForApproval(plan, {
        requireTrustedEvidence: true,
        trustedEvidence: project.planningEvidence,
        trustedLegacyApproval: project.legacyPlanningApproval
      })
      if (planProblems.length)
        return (
          'o mapa precisa ser revisado e aprovado novamente antes de abrir outra missão: ' +
          planProblems.join('; ')
        )
      if (item.status !== 'planned')
        return 'o item ' + item.id + ' está "' + item.status + '" e não pode ser aberto agora'
      const releaseGate = projectPlanReleaseGate(plan)
      if (releaseGate) {
        const blockers = projectPlanReleaseBlockers(plan, releaseGate)
        return blockers.length
          ? 'antes de abrir ' +
              item.id +
              ', resolva os itens ainda pendentes em ' +
              releaseGate.versionName +
              ': ' +
              blockers.map((candidate) => candidate.id).join(', ') +
              '. Essa versão só pode ser publicada quando o bloco estiver encerrado.'
          : 'antes de abrir ' +
              item.id +
              ', publique ' +
              releaseGate.versionName +
              '. A próxima versão só começa depois que a anterior chega à base.'
      }
      const executionWindow = projectPlanExecutionWindow(plan)
      if (!executionWindow.readyItemIds.includes(item.id)) {
        const ready = executionWindow.readyItemIds.join(', ')
        return ready
          ? `a onda atual é ${executionWindow.currentWaveId}; as missões prontas são ${ready}. Não abri ${item.id} fora da onda.`
          : `o item ${item.id} ainda não está pronto: conclua/retome a onda ${executionWindow.currentWaveId ?? 'atual'} ou publique a versão anterior.`
      }
      const incomplete = item.dependsOn.filter(
        (dependencyId) =>
          plan.roadmap.find((candidate) => candidate.id === dependencyId)?.status !== 'done'
      )
      if (incomplete.length)
        return 'a missão ' + item.id + ' ainda depende de: ' + incomplete.join(', ')

      const version = ensureMissionVersion(id.projectId, item.version)
      if (version.error) return 'não abri a missão: ' + version.error
      const criteria = item.acceptanceCriteria.map((criterion) => '- ' + criterion).join('\n')
      const inScope = item.scope.in.length ? item.scope.in.join('; ') : 'objetivo declarado'
      const outScope = item.scope.out.length
        ? item.scope.out.join('; ')
        : 'nada adicional declarado'
      const substantial =
        item.dependsOn.length > 1 || item.scope.in.length > 3 || item.acceptanceCriteria.length > 4
      const goal =
        'Esta é a missão ' +
        item.id +
        ' do plano mestre (.synkora/PROJECT_PLAN.md).\n\nObjetivo: ' +
        item.objective +
        '\n\nCritérios de aceite:\n' +
        criteria +
        '\n\nFora desta missão: ' +
        outScope +
        '.\n\n' +
        (substantial
          ? 'missão com dependências reais: planejar em ondas'
          : 'missão PEQUENA: resolver com o menor número de cards coerente, sem ondas artificiais')
      const reservedMissionId = randomUUID()
      try {
        writeMissionStartIntent(project.path, {
          projectId: id.projectId,
          itemId: item.id,
          missionId: reservedMissionId,
          createdAt: new Date().toISOString()
        })
      } catch (error) {
        return (
          'não abri a missão: não consegui gravar o ponto seguro de recuperação (' +
          (error instanceof Error ? error.message : String(error)) +
          ')'
        )
      }
      const mission = createMissionImpl(
        id.projectId,
        {
          title: item.title,
          goal,
          scope: 'Dentro: ' + inScope + '. Fora: ' + outScope + '.',
          versionId: version.versionId,
          // Missão do plano mestre TAMBÉM não herda seat em silêncio (bug real
          // 2026-08-04): o usuário escolhe conta/modelo/effort do orquestrador
          // no modal do board antes de o pane nascer — mesma regra do
          // create_mission do PM (decisão do usuário, 02/08).
          pendingOrchestrator: true
        },
        'maestro · plano mestre',
        reservedMissionId
      )
      if (!mission) {
        clearMissionStartIntent(project.path, reservedMissionId)
        return 'não foi possível criar a missão planejada'
      }
      if (
        !mission.branch ||
        !mission.worktree ||
        !missionWorkspacePath(project.path, mission)
      ) {
        rollbackPlannedMission(id.projectId, mission.id)
        clearMissionStartIntent(project.path, mission.id)
        return 'não abri a missão planejada: não foi possível preparar o repositório e o isolamento Git; o mapa foi preservado e nenhuma missão órfã ficou aberta'
      }
      const releaseVersion =
        mission.branch && mission.versionId ? backlog.getVersion(mission.versionId) : undefined
      try {
        bindProjectMission(project.path, {
          itemId: item.id,
          missionId: mission.id,
          validation: {
            requireTrustedEvidence: true,
            trustedEvidence: project.planningEvidence,
            trustedLegacyApproval: project.legacyPlanningApproval
          },
          ...(releaseVersion
            ? {
                release: {
                  versionId: releaseVersion.id,
                  versionName: releaseVersion.name
                }
              }
            : {})
        })
      } catch (error) {
        // A missão real e o vínculo são uma unidade lógica. Se o JSON não
        // aceitar/persistir o vínculo, desfazemos o worktree e o registro para
        // não deixar uma missão órfã bloqueando o roteiro.
        rollbackPlannedMission(id.projectId, mission.id)
        clearMissionStartIntent(project.path, mission.id)
        return (
          'não abri a missão planejada; o vínculo com o mapa falhou e a criação foi desfeita: ' +
          (error instanceof Error ? error.message : String(error))
        )
      }

      let backlogWarning = ''
      const mirrorError = ensurePlannedMissionBacklogItem(id.projectId, mission, item)
      if (mirrorError) {
        backlogWarning =
          ' · aviso: a missão está corretamente ligada ao plano, mas o espelho na aba Versões falhou (' +
          mirrorError +
          ')'
        hub.publish({
          projectId: id.projectId,
          kind: 'error',
          text: backlogWarning.slice(3),
          actor: 'harness'
        })
      } else clearMissionStartIntent(project.path, mission.id)
      return (
        'missão planejada "' +
        mission.title +
        '" aberta (roadmap ' +
        item.id +
        ', id ' +
        mission.id +
        ')' +
        (releaseVersion?.name || version.name
          ? ' · versão ' + (releaseVersion?.name ?? version.name)
          : '') +
        `. Onda ${item.wave.name ?? item.wave.id}. Um modal pediu ao usuário a conta/modelo/effort do orquestrador; após a escolha, o orquestrador abre na aba da missão e propõe o plano de execução. ` +
        (() => {
          const refreshed = projectPlanOf(id.projectId)
          const remaining = refreshed?.readyItemIds ?? []
          return remaining.length > 0
            ? `Ainda há ${remaining.length} missão(ões) independente(s) pronta(s) nesta mesma onda: ${remaining.join(', ')}.`
            : 'Todas as missões autorizadas desta onda já foram abertas; a próxima onda aguarda a conclusão delas.'
        })() +
        backlogWarning
      )
    },
    createMission: (id, input: NewMissionInput) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) cria missões'
      const planningEvidence = preparePlanningArtifactEvidence(id, input.skillApplications)
      if (!planningEvidence.ok) return `não criei a missão: ${planningEvidence.message}`
      const masterPlan = projectPlanOf(id.projectId)
      if (projectModeOf(id.projectId) === 'greenfield' && masterPlan?.status !== 'done') {
        return masterPlan?.status === 'draft'
          ? 'este projeto novo ainda está em planejamento — refine o mapa com save_project_plan e aprove-o antes de abrir qualquer missão'
          : 'este projeto novo segue um roadmap aprovado — abra somente a próxima missão autorizada com start_project_mission; create_mission fica reservado a projetos existentes e melhorias pontuais após o plano mestre'
      }

      const version = ensureMissionVersion(
        id.projectId,
        input.version?.trim() ? { name: input.version.trim() } : undefined
      )
      if (version.error) return `não criei a missão: ${version.error}`
      const mission = createMissionImpl(
        id.projectId,
        {
          title: input.title,
          goal: input.goal,
          scope: input.scope,
          versionId: version.versionId,
          planningMethod: planningEvidence.evidence,
          // Missão do PM NÃO herda seat em silêncio: o usuário escolhe
          // conta/modelo/effort do orquestrador num modal no board e só
          // então o pane nasce (decisão do usuário, 02/08).
          pendingOrchestrator: true
        },
        'maestro'
      )
      if (!mission) return 'projeto não encontrado (ou título vazio)'
      if (!planningEvidence.accept()) {
        return 'não criei a missão: o receipt expirou antes da confirmação do artefato; reabra o Maestro'
      }
      return (
        `missão "${mission.title}" criada (id ${mission.id})` +
        (mission.branch
          ? ` na branch ${mission.branch} (worktree isolado — a base só vê a missão na integração)`
          : ' (projeto sem git — roda direto no diretório)') +
        (version.name ? ` · versão ${version.name} (integra na branch da versão)` : '') +
        ' — um modal pediu ao usuário a conta/modelo/effort do orquestrador; o orquestrador abre depois dessa escolha e quebra o trabalho em tarefas'
      )
    },
    integrateMission: (id, missionIdArg) => {
      if (id.role !== 'maestro')
        return 'apenas o Maestro do projeto ou o orquestrador da própria missão pode integrar'
      const missionId = id.missionId ?? missionIdArg
      if (!missionId) return 'informe o missionId (o PM vê os ids no board_status)'
      if (id.missionId && missionIdArg && missionIdArg !== id.missionId)
        return 'um orquestrador só integra a própria missão'
      const mission = missions.get(missionId)
      if (!mission) return 'missão não encontrada'
      if (mission.projectId !== id.projectId)
        return 'essa missão pertence a outro projeto — integração recusada'
      if (id.missionId && mission.id !== id.missionId)
        return 'um orquestrador só integra a própria missão'
      return startMissionIntegration(missionId, id.role)
    },
    queueMissions: (id, missionIds) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o Maestro do projeto coloca um lote de missões na fila'
      const orderedIds = [...new Set(missionIds.map((missionId) => missionId.trim()).filter(Boolean))]
      if (orderedIds.length === 0) return 'informe ao menos uma missão'
      const results: string[] = []
      for (const missionId of orderedIds) {
        const mission = missions.get(missionId)
        if (!mission || mission.projectId !== id.projectId) {
          results.push(`${missionId}: fora da fila (missão não encontrada neste projeto)`)
          continue
        }
        results.push(`${mission.title}: ${startMissionIntegration(missionId, 'maestro · lote')}`)
      }
      const lane = integrationQueue.listPending(id.projectId)
      const laneBlock =
        lane.length > 0
          ? `fila atual com ${lane.length} missão(ões) pendente(s), em ordem FIFO:\n` +
            lane
              .map(
                (ticket) =>
                  `#${ticket.position} ${missions.get(ticket.missionId)?.title ?? ticket.missionId} — ${ticket.state}`
              )
              .join('\n')
          : 'nenhuma missão entrou na fila ainda — cada intenção registrada aguarda o AVAL do dono no botão ⇪ da missão'
      return `${laneBlock}\n\nResultado por pedido:\n${results.join('\n')}`
    },
    releaseVersion: (id, versionName) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) solicita releases'
      const version = backlog
        .listVersions(id.projectId)
        .find((v) => v.name.toLowerCase() === versionName.trim().toLowerCase())
      if (!version) return `versão "${versionName}" não encontrada — veja as versões no board_status`
      hub.publish({
        projectId: id.projectId,
        kind: 'info',
        text:
          `release solicitado para ${version.name}. Nenhum merge foi executado: ` +
          'o dono precisa abrir a versão e confirmar “subir agora”.',
        actor: 'maestro',
        urgent: true
      })
      emitBacklogChanged(id.projectId)
      return (
        `pedido de release de ${version.name} registrado. ` +
        'Nenhum merge foi feito; somente o clique humano “subir agora” pode publicar a versão.'
      )
    },
    setReleaseHold: (id, on, reason) => {
      if (id.role !== 'maestro' || id.missionId)
        return 'apenas o PM (Maestro do projeto) controla o hold de release'
      if (on) {
        const why = reason?.trim()
        if (!why) return 'informe o motivo: o que está sendo verificado enquanto o release fica travado'
        maestro.update(id.projectId, {
          releaseHold: { reason: why.slice(0, 200), at: new Date().toISOString() }
        })
        hub.publish({
          projectId: id.projectId,
          kind: 'info',
          text: `HOLD de release LIGADO pelo Maestro: ${why.slice(0, 160)} — nenhuma versão sobe até liberar`,
          actor: 'maestro',
          quiet: true
        })
        return 'hold de release LIGADO — nenhuma versão sobe (nem pelo botão do usuário) até você chamar set_release_hold {on: false}'
      }
      const current = maestro.get(id.projectId).releaseHold
      maestro.update(id.projectId, { releaseHold: undefined })
      hub.publish({
        projectId: id.projectId,
        kind: 'info',
        text: 'HOLD de release desligado pelo Maestro — releases liberados',
        actor: 'maestro',
        quiet: true
      })
      return current
        ? `hold desligado (estava ativo desde ${current.at.slice(0, 16).replace('T', ' ')}: ${current.reason})`
        : 'não havia hold ativo — releases já estavam liberados'
    }
  }
}

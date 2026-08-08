/**
 * MCP API — domínio report (fase 1, commit 4d — commit PRÓPRIO por ordem do
 * mapa: é o bloco mais entrelaçado do arquivo).
 * A barreira do veredito: report de helper (conclusão/announce), gate de
 * integração de missão, identidade de rodada, parsing de veredito +
 * evidência, validação do artefato imutável, ledger de skills, bloqueio
 * ambiental ("bloqueada"), security review, patch sugerido e a transação
 * detach → advancePhase → rollback. readReviewEvidence viaja junto: divide
 * o guard de rodada e o chunk autenticado do diff.
 *
 * CONTRATOS (reescritos no F2-c5 — a barreira síncrona morreu):
 * - report é ASYNC no caminho do veredito desde a Fase 2: advancePhase
 *   devolve Promise<boolean> e é SEMPRE aguardado. A CICATRIZ do
 *   "[object Promise]" (2026-08-05) segue a régua — um await esquecido
 *   reabre o modo de falha; o McpApi.report sempre aceitou Promise<string>
 *   e o handler MCP sempre fez await.
 * - A transação: acquire SÍNCRONO do PhaseTransitionLock → detach → unlink
 *   (ordem sagrada §3.2 — nunca reordenar, nunca await entre os três).
 *   Falha de acquire = rodada anterior fechando; recusa com receita, nada é
 *   consumido. A atomicidade do veredito vem da SERIALIZAÇÃO por card.
 * - Desfazer: o advancePhase solta o lock nos desfechos normais; no THROW a
 *   posse volta para cá e ctx.phase.rollbackVerdictTransaction re-indexa o
 *   watch (createdAt renovado; cede ao watch novo — R2) e SÓ ENTÃO solta.
 * - A anotação positional de securityReview segue a do literal.
 */
import { dirname, join } from 'path'
import { TaskStore, type Task } from '../tasks'
import { assessMissionRisk } from '../orchestratorFlow'
import {
  validateGateVerificationEvidence,
  type GateVerificationEvidence
} from '../gateVerificationEvidence'
import { type MissionWatch } from '../phaseTypes'
import { requiresManualSecurityValidation } from '../securityPolicy'
import {
  normalizeSecurityReview,
  validateSecurityReview,
  type SecurityReviewInput,
  type SecurityReviewRecord
} from '../securityReview'
import { redactSensitiveText } from '../securityRedaction'
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { type PaneIdentity } from '../hub'
import { classifyTaskUiWork } from '../skillsRouting'
import { SkillRuntime } from '../skillRuntime'
import {
  formatHelperCompletionShortNotice,
  helperCompletionNotificationKey
} from '../helperCompletion'
import { type HelperRecoveryRecord, type HelperRecoveryStatus } from '../helperRecovery'
import { stopQaRuntime } from '../qaRuntime'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface ReportApiExtras {
  handleMissionVerdict(watch: MissionWatch, content: string): void
  updateStoredHelperStatus(
    projectId: string,
    paneId: string,
    status: HelperRecoveryStatus,
    statusAt?: string
  ): HelperRecoveryRecord | undefined
  helperTranscriptPath(projectId: string, paneId: string): string | undefined
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
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  planTaskForWorkTask(task: Task): Task | undefined
  plannedHelperAssignments: Map<string, { parentPhaseRun: string; agentId: string }>
  completedPlannedAgentsByPhaseRun: Map<string, Set<string>>
}

export function buildReportApi(
  ctx: MainContext,
  extras: ReportApiExtras
): Pick<McpApi, 'readReviewEvidence' | 'report'> {
  const {
    tasks,
    projects,
    missions,
    ptys,
    blackbox,
    maestro,
    backlog,
    helperCompletions,
    phaseWatches,
    liveGateWaits,
    missionWatches,
    helperReported,
    closingPaneIds,
    syncBoard,
    ensureProjectRuntimeWritable,
    maestroPaneId,
    orchPaneId
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  const {
    handleMissionVerdict,
    updateStoredHelperStatus,
    helperTranscriptPath,
    skillRuntime,
    skillPlanScopes,
    securityWaiverOptions,
    planTaskForWorkTask,
    plannedHelperAssignments,
    completedPlannedAgentsByPhaseRun
  } = extras
  return {
    readReviewEvidence: (id, offset, maxBytes) => {
      if (id.role !== 'review' || !id.taskId || id.phase !== 'review') {
        return 'leitura recusada: somente o reviewer ativo lê a evidência privada da própria rodada'
      }
      const watch = phaseWatches.get(id.taskId)
      if (
        !watch ||
        watch.phase !== 'review' ||
        watch.paneId !== id.paneId ||
        !hub.identityByPane(id.paneId)
      ) {
        return 'leitura recusada: esta rodada de review não está mais ativa'
      }
      return ctx.phase.readReviewArtifactChunk(watch, offset, maxBytes)
    },
    report: async (
      id,
      content,
      summary,
      securityReview: SecurityReviewInput | undefined,
      suggestedPatch?: string,
      skillApplications?: string[],
      verificationEvidence?: GateVerificationEvidence
    ) => {
      // Report cru atravessa MCP e pode acabar em task.feedback, transcript,
      // EVENTS e notificações. Sanitizamos uma vez na fronteira para nenhum
      // caminho de persistência depender da disciplina do modelo.
      content = redactSensitiveText(content)
      summary = summary ? redactSensitiveText(summary) : undefined
      if (id.role === 'ajudante') {
        const helperScope = skillPlanScopes.get(id.paneId)
        if (!helperScope || helperScope.phase !== 'helper') {
          return 'report recusado: o plano rastreável de skills deste ajudante não está disponível'
        }
        const guardedHelperReport = skillRuntime.guardReport({
          paneId: id.paneId,
          phase: 'helper',
          phaseRun: helperScope.phaseRun,
          skillApplications
        })
        if (!guardedHelperReport.ok) {
          const details =
            guardedHelperReport.code === 'report_incomplete'
              ? [
                  ...(guardedHelperReport.missingActivated ?? []).map(
                    (receipt) => `ative ${receipt} com activate_skill`
                  ),
                  ...(guardedHelperReport.missingDeclared ?? []).map(
                    (receipt) => `inclua ${receipt} em skillApplications`
                  ),
                  ...(guardedHelperReport.unknownApplications ?? []).map(
                    (receipt) => `receipt desconhecido ${receipt}`
                  ),
                  ...(guardedHelperReport.unactivatedApplications ?? []).map(
                    (receipt) => `receipt não ativado ${receipt}`
                  )
                ]
              : []
          return `report de skills incompleto: ${details.join('; ') || guardedHelperReport.message}`
        }
        const acceptedHelperReport = skillRuntime.acceptReport({
          paneId: id.paneId,
          phase: 'helper',
          phaseRun: helperScope.phaseRun,
          skillApplications
        })
        if (!acceptedHelperReport.ok) {
          return 'report recusado: o plano de skills do ajudante mudou durante a conclusão'
        }
        const plannedAssignment = plannedHelperAssignments.get(id.paneId)
        if (plannedAssignment) {
          const completed =
            completedPlannedAgentsByPhaseRun.get(plannedAssignment.parentPhaseRun) ??
            new Set<string>()
          completed.add(plannedAssignment.agentId)
          completedPlannedAgentsByPhaseRun.set(
            plannedAssignment.parentPhaseRun,
            completed
          )
        }
        const firstReport = !helperReported.has(id.paneId)
        helperReported.add(id.paneId)
        const { paneId, projectId, missionId, delegatorPaneId } = id
        // Capturado JÁ (o pane do delegador pode morrer antes do announce):
        // conclusão de ajudante de agente LIVRE é rotina do fluxo dele — o
        // delegador é avisado normalmente, mas o PM não ganha um turno por
        // isso (5 textões injetados no PM em 2026-08-03; ver F5.7j).
        const delegatorRole = delegatorPaneId
          ? hub.identityByPane(delegatorPaneId)?.role
          : undefined
        ptys.flushLogOf(paneId)
        if (firstReport) {
          const transcript = helperTranscriptPath(projectId, paneId)
          const durableSummary = redactSensitiveText(summary ?? content).trim().slice(0, 8_000)
          if (transcript && durableSummary) {
            try {
              ensureProjectRuntimeWritable(projectId)
              appendFileSync(
                transcript,
                `\n[report ajudante · conclusão persistida]\n${durableSummary}\n`,
                'utf-8'
              )
            } catch {
              // O tracker ainda entrega ao vivo; o status abaixo permanece
              // recuperável mesmo se o arquivo tiver sido removido externamente.
            }
          }
        }
        updateStoredHelperStatus(projectId, paneId, 'done')
        const completionId = helperCompletions.report(
          paneId,
          delegatorPaneId,
          redactSensitiveText(summary ?? content)
        )
        // NADA acontece por timer fixo: o report costuma chegar ENQUANTO a
        // resposta longa ainda está sendo impressa (streaming de 30-60s), e o
        // fluxo antigo (avisar na hora + fechar em 4s) fazia o delegador ler
        // helper_output ANTES do fim e o pane morrer no meio da impressão —
        // transcript truncado, trabalho perdido (bug real, 2026-07-29).
        // Espera o terminal AQUIETAR (2,5s sem saída; teto de 90s), força o
        // flush do tee e SÓ ENTÃO avisa e fecha.
        const announce = (): void => {
          const completion = helperCompletions.peek(paneId, completionId)
          if (!completion) return
          const notificationKey = helperCompletionNotificationKey(paneId, completionId)
          ptys.flushLogOf(paneId)
          // ENTREGA POR DESTINO (bug real 2026-08-03: o delegador acompanhou a
          // saída via helper_output e mesmo assim o resultado COMPLETO era
          // digitado de novo no input dele): quem consumiu pós-report não
          // recebe nada; quem só acompanhou recebe o sinal curto; quem nunca
          // leu recebe o texto completo. A guarda stillNeeded reavalia no
          // instante da injeção — consumo tardio ainda cancela a digitação.
          const maestroPane = missionId
            ? (ptys.has(orchPaneId(projectId, missionId)) ? orchPaneId(projectId, missionId) : undefined)
            : (ptys.has(maestroPaneId(projectId)) ? maestroPaneId(projectId) : undefined)
          const maestroMode = maestroPane
            ? helperCompletions.noticeMode(paneId, completionId, maestroPane)
            : 'full'
          const delegatorMode = delegatorPaneId
            ? helperCompletions.noticeMode(paneId, completionId, delegatorPaneId)
            : 'skip'
          const stillNeededFor = (target: string) => (): boolean =>
            !helperCompletions.wasConsumedBy(paneId, completionId, target)
          const quietForMaestro = delegatorRole === 'livre'
          hub.publish({
            projectId,
            // com missionId o evento cai no ORQUESTRADOR (bug real: ia pro PM)
            missionId,
            kind: 'report',
            text: `ajudante concluiu: ${completion.text}`,
            actor: 'ajudante',
            quiet: quietForMaestro
          }, {
            // A injeção do publish só alcança o pane do maestro/orquestrador:
            // se ELE já leu a saída, o texto completo não é digitado de novo
            // (o modo 'short' abaixo cobre o sinal). EVENTS.md/UI ficam com o
            // evento completo de qualquer forma.
            excludePaneId: maestroPane && maestroMode !== 'full' ? maestroPane : undefined,
            notificationKey,
            sourcePaneId: paneId,
            communicationKind: 'report',
            correlationId: notificationKey,
            stillNeeded: maestroPane ? stillNeededFor(maestroPane) : undefined
          })
          if (maestroPane && maestroMode === 'short' && maestroPane !== delegatorPaneId && !quietForMaestro) {
            hub.notifyPane(maestroPane, formatHelperCompletionShortNotice(paneId), {
              key: notificationKey,
              sourcePaneId: paneId,
              kind: 'report',
              correlationId: notificationKey,
              stillNeeded: stillNeededFor(maestroPane)
            })
          }
          if (delegatorPaneId && delegatorMode !== 'skip') {
            hub.notifyPane(
              delegatorPaneId,
              delegatorMode === 'short'
                ? formatHelperCompletionShortNotice(paneId)
                : `ajudante ${paneId.slice(0, 8)} concluiu: ${completion.text || 'sem resumo'} — saída completa via helper_output`,
              {
                key: notificationKey,
                onSettled: () => helperCompletions.settle(paneId, completionId),
                sourcePaneId: paneId,
                kind: 'report',
                correlationId: notificationKey,
                stillNeeded: stillNeededFor(delegatorPaneId)
              }
            )
          } else {
            helperCompletions.settle(paneId, completionId)
          }
          if (ctx.uiSender && !ctx.uiSender.isDestroyed())
            ctx.uiSender.send('panes:closeById', projectId, paneId)
          // O renderer normalmente desmonta o pane e mata o PTY. Fazemos o
          // mesmo no main para que uma janela fechada/remount lento não deixe
          // um helper já reportado capaz de escrever após o snapshot do dev.
          if (ptys.has(paneId)) {
            closingPaneIds.add(paneId)
            ptys.kill(paneId)
          }
        }
        const t0 = Date.now()
        const tick = (): void => {
          if (!ptys.has(paneId) || ptys.isIdle(paneId, 2500) || Date.now() - t0 > 90_000) {
            announce()
            return
          }
          setTimeout(tick, 1000)
        }
        setTimeout(tick, 1500)
        return 'reportado — quando o pane terminar de imprimir, o delegador é avisado e este pane fecha sozinho'
      }
      // Gate de INTEGRAÇÃO de missão: pane review sem taskId, com missionId.
      if (!id.taskId && id.missionId && missionWatches.has(id.missionId)) {
        const watch = missionWatches.get(id.missionId) as MissionWatch
        try {
          ensureProjectRuntimeWritable(watch.projectId)
        } catch {
          return 'veredito preservado: .synkora está rastreado pelo Git; retire o runtime do versionamento e reporte novamente'
        }
        missionWatches.delete(id.missionId)
        try {
          unlinkSync(watch.marker)
        } catch {
          // marcador nem chegou a existir (caminho MCP)
        }
        if (summary) {
          try {
            appendFileSync(
              watch.logFile,
              `\n[report integração] ${redactSensitiveText(summary)}\n`,
              'utf-8'
            )
          } catch {
            // transcript é best-effort
          }
        }
        handleMissionVerdict(watch, content)
        return 'veredito de integração recebido — o resultado chega como evento'
      }
      if (id.role === 'maestro')
        return 'o Maestro não reporta fases — use create_tasks/update_task/board_status/delegate'
      const watch = id.taskId ? phaseWatches.get(id.taskId) : undefined
      if (!watch)
        return id.role === 'review' || id.role === 'qa'
          ? 'sua rodada já FECHOU (o veredito foi processado) — nada a fazer agora: fique em silêncio no modo espera; se houver próxima rodada, ela chega NESTA conversa com as instruções. Não emita segundo relatório nem adendos.'
          : 'nenhuma fase ativa para esta tarefa (report já processado ou tarefa fora da fase)'
      if (watch.phase !== id.phase)
        return `a fase ativa agora é ${watch.phase} — report da fase ${id.phase ?? '?'} ignorado`
      if (watch.paneId !== id.paneId)
        return 'esta rodada já foi substituída por outro pane — relatório antigo ignorado'
      if (
        securityReview &&
        (id.role !== 'review' || id.phase !== 'review' || watch.phase !== 'review')
      ) {
        return 'securityReview recusado: somente o revisor ativo, durante a fase review, pode enviar esta evidência. Nenhum receipt, veredito ou plano foi alterado.'
      }
      const evidenceTask = tasks.get(watch.taskId)
      const evidenceUiWork = Boolean(
        watch.uiWork ?? (evidenceTask && classifyTaskUiWork(evidenceTask))
      )
      const evidenceStatus = /^\s*aprovada\b/i.test(content)
        ? 'aprovada'
        : /^\s*reprovada\b/i.test(content)
          ? 'reprovada'
          : /^\s*bloqueada\b/i.test(content)
            ? 'bloqueada'
            : 'done'
      if (
        evidenceStatus === 'done' &&
        watch.phase === 'dev' &&
        evidenceUiWork &&
        watch.browserAvailable === false
      ) {
        return 'report done recusado: este pane de UI não tem browser/runtime autorizado. Não fabrique evidência; reporte bloqueada com o motivo ambiental para preservar o trabalho.'
      }
      const evidenceValidation = validateGateVerificationEvidence({
        status: evidenceStatus,
        phase: watch.phase,
        uiWork: evidenceUiWork,
        evidence: verificationEvidence
      })
      if (!evidenceValidation.ok) {
        return `report sem evidencia suficiente: ${evidenceValidation.reason}. Nenhum receipt ou veredito foi consumido.`
      }
      const sanitizeEvidenceList = (
        items: string[] | undefined,
        maxItems: number
      ): string[] | undefined => {
        const sanitized = items
          ?.slice(0, maxItems)
          .map((item) => redactSensitiveText(item).trim().slice(0, 600))
          .filter(Boolean)
        return sanitized?.length ? sanitized : undefined
      }
      const sanitizedVerificationEvidence: GateVerificationEvidence | undefined =
        verificationEvidence
          ? {
              summary: redactSensitiveText(verificationEvidence.summary).trim().slice(0, 2000),
              surfaces: sanitizeEvidenceList(verificationEvidence.surfaces, 24),
              states: sanitizeEvidenceList(verificationEvidence.states, 24),
              viewports: sanitizeEvidenceList(verificationEvidence.viewports, 12),
              observations: sanitizeEvidenceList(verificationEvidence.observations, 32) ?? []
            }
          : undefined
      const skillScope = skillPlanScopes.get(id.paneId)
      if (!skillScope)
        return 'report recusado: o plano rastreável de skills desta rodada não está disponível; reabra somente esta fase'
      const blockedReport = /^\s*bloqueada\b/i.test(content)
      if (
        !blockedReport &&
        watch.phase === 'review' &&
        watch.reviewArtifact &&
        watch.reviewArtifact.bytes > 0 &&
        watch.reviewArtifact.servedUntil === 0
      ) {
        return 'report recusado: a evidência privada do patch grande ainda não foi aberta. Use read_review_evidence ao menos uma vez e combine os trechos relevantes com a inspeção de TODOS os changed paths fornecidos pelo harness; nenhum receipt ou veredito foi consumido.'
      }
      const boundArtifactProblem = blockedReport
        ? undefined
        : await ctx.phase.reviewArtifactProblem(watch)
      if (boundArtifactProblem) {
        const transitionToken = ctx.phaseTransitions.acquire(watch.taskId, {
          label: `report:${watch.phase}:artifact-invalid`,
          projectId: watch.projectId
        })
        if (!transitionToken)
          return 'a rodada anterior deste card ainda está fechando — aguarde alguns segundos e reporte de novo; nenhum receipt ou veredito foi consumido'
        phaseWatches.detach(watch.taskId)
        try {
          unlinkSync(watch.marker)
        } catch {
          // marcador nem chegou a existir
        }
        // F2-c5: a MESMA transação do call site principal — o buraco
        // pré-existente (throw aqui perdia o watch) fecha nesta obra (§4.4).
        let advanced = false
        try {
          advanced = await ctx.phase.advancePhase(
            watch,
            content,
            undefined,
            sanitizedVerificationEvidence,
            undefined,
            transitionToken
          )
        } catch (error) {
          ctx.phase.rollbackVerdictTransaction(watch, transitionToken)
          return `report preservado: não foi possível persistir a transação da fase (${redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 240)}). Nenhum receipt foi consumido; tente novamente.`
        }
        return advanced
          ? `veredito invalidado antes de consumir receipts: ${boundArtifactProblem}`
          : `artefato imutável inválido e pipeline preservado: ${boundArtifactProblem}`
      }
      if (!blockedReport) {
        const guardedSkillReport = skillRuntime.guardReport({
          paneId: id.paneId,
          phase: id.phase ?? watch.phase,
          phaseRun: skillScope.phaseRun,
          skillApplications
        })
        if (!guardedSkillReport.ok) {
          const details =
            guardedSkillReport.code === 'report_incomplete'
              ? [
                  ...(guardedSkillReport.missingActivated ?? []).map(
                    (receipt) => `ative ${receipt} com activate_skill`
                  ),
                  ...(guardedSkillReport.missingDeclared ?? []).map(
                    (receipt) => `inclua ${receipt} em skillApplications`
                  ),
                  ...(guardedSkillReport.unknownApplications ?? []).map(
                    (receipt) => `receipt desconhecido ${receipt}`
                  ),
                  ...(guardedSkillReport.unactivatedApplications ?? []).map(
                    (receipt) => `receipt não ativado ${receipt}`
                  )
                ]
              : []
          return `report de skills incompleto: ${details.join('; ') || guardedSkillReport.message}`
        }
      }
      const prepareSkillUsageAcceptance = (): {
        skillUsage: NonNullable<Task['skillUsage']>
        commitRuntime: () => boolean
      } | undefined => {
        if (!id.taskId || !skillScope) return undefined
        const task = tasks.get(id.taskId)
        const usage = task?.skillUsage
        if (usage?.phaseRun !== skillScope.phaseRun) return undefined
        const updatedAt = new Date().toISOString()
        const skills = usage.skills.map((skill) => ({ ...skill, status: 'applied' as const }))
        return {
          skillUsage: {
            ...usage,
            updatedAt,
            runStatus: 'completed',
            skills,
            history: (usage.history ?? []).map((run) =>
              run.phaseRun === skillScope.phaseRun
                ? { ...run, updatedAt, runStatus: 'completed' as const, skills }
                : run
            )
          },
          commitRuntime: () =>
            skillRuntime.acceptReport({
              paneId: id.paneId,
              phase: id.phase ?? watch.phase,
              phaseRun: skillScope.phaseRun,
              skillApplications
            }).ok
        }
      }
      try {
        ensureProjectRuntimeWritable(watch.projectId)
      } catch {
        return 'report preservado: .synkora está rastreado pelo Git; retire o runtime do versionamento e reporte novamente'
      }
      // BLOQUEIO AMBIENTAL NÃO É REPROVAÇÃO (caso real 2026-08-06, O02d: o
      // runtime do QA não subiu, o QA só tinha "reprovada" como saída e o
      // encanamento mandou a "lista" ao dev — que não tinha nada a corrigir;
      // a volta ainda esbarrava no guard de rodada vazia). Veredito próprio:
      // não conta ciclo, não vira gateRound/feedback, não toca no dev. Fecha
      // o gate preservando a fase; o orquestrador corrige o ambiente e reabre
      // SÓ o gate (o respawn tenta subir o runtime de novo).
      if (
        (watch.phase === 'review' || watch.phase === 'qa') &&
        blockedReport
      ) {
        // F2-c4: `bloqueada` fica FORA do advancePhase mas É transição de
        // card — sem o lock, ele protegeria só metade das saídas do gate.
        const transitionToken = ctx.phaseTransitions.acquire(watch.taskId, {
          label: 'report:bloqueada-gate',
          projectId: watch.projectId
        })
        if (!transitionToken)
          return 'a rodada anterior deste card ainda está fechando — aguarde alguns segundos e reporte bloqueada de novo'
        try {
          const blockedTask = tasks.get(watch.taskId)
          ctx.phase.cleanupReviewArtifact(watch)
          phaseWatches.delete(watch.taskId)
          try {
            unlinkSync(watch.marker)
          } catch {
            // marcador nem chegou a existir
          }
          try {
            appendFileSync(watch.logFile, `\n[report ${id.role}] ${content}\n`, 'utf-8')
          } catch {
            // transcript é best-effort
          }
          stopQaRuntime(watch.taskId)
          liveGateWaits.delete(watch.taskId)
          ctx.phase.terminateTaskPhasePane(watch.projectId, watch.taskId, watch.phase)
          tasks.update(watch.taskId, {
            status: watch.phase === 'qa' ? 'qa' : 'execucao',
            activePhase: watch.phase,
            phaseState: 'interrupted'
            // feedback INTOCADO: bloqueio ambiental não é lista de correção
          })
          blackbox.record({
            cat: 'phase',
            event: 'gate-blocked-environment',
            actor: id.role,
            ids: {
              projectId: watch.projectId,
              missionId: blockedTask?.missionId,
              taskId: watch.taskId,
              paneId: id.paneId,
              phase: watch.phase,
              role: watch.phase
            },
            reason: content.slice(0, 400)
          })
          hub.publish({
            projectId: watch.projectId,
            missionId: blockedTask?.missionId,
            kind: 'error',
            urgent: true,
            text: `gate ${watch.phase} de "${blockedTask?.title ?? watch.taskId}" BLOQUEADO POR AMBIENTE (não é defeito do produto — NÃO repasse nada ao dev): ${content.slice(0, 400)}. Corrija o ambiente se estiver ao seu alcance e reabra SÓ o gate com run_task {id: "${watch.taskId}", phase: "${watch.phase}"} — a reabertura tenta subir o runtime de novo. Se o bloqueio persistir na segunda tentativa, escale ao USUÁRIO com UMA pergunta objetiva`,
            actor: 'harness'
          })
          if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
          syncBoard(watch.projectId)
          return 'bloqueio ambiental registrado — o gate fechou SEM contar ciclo e nada foi ao dev; o orquestrador reabre o gate após o ambiente ser corrigido'
        } finally {
          ctx.phaseTransitions.release(watch.taskId, transitionToken)
        }
      }
      if (watch.phase === 'dev' && blockedReport) {
        if (!evidenceUiWork || watch.browserAvailable !== false) {
          return 'bloqueio recusado: DEV só pode usar bloqueada quando uma entrega de UI ficou sem browser/runtime autorizado'
        }
        // F2-c4: mesmo racional do bloco `bloqueada` do gate — é transição.
        const transitionToken = ctx.phaseTransitions.acquire(watch.taskId, {
          label: 'report:bloqueada-dev',
          projectId: watch.projectId
        })
        if (!transitionToken)
          return 'a rodada anterior deste card ainda está fechando — aguarde alguns segundos e reporte bloqueada de novo'
        try {
          const blockedTask = tasks.get(watch.taskId)
          phaseWatches.delete(watch.taskId)
          try {
            unlinkSync(watch.marker)
          } catch {
            // marcador nem chegou a existir
          }
          try {
            appendFileSync(watch.logFile, `\n[report dev bloqueada] ${content}\n`, 'utf-8')
          } catch {
            // transcript é best-effort
          }
          ctx.phase.terminateTaskPhasePane(watch.projectId, watch.taskId, 'dev')
          tasks.update(watch.taskId, {
            status: 'backlog',
            activePhase: 'dev',
            phaseState: 'interrupted',
            feedback: `bloqueio ambiental de validação visual: ${content.slice(0, 400)}`
          })
          blackbox.record({
            cat: 'phase',
            event: 'dev-ui-blocked-environment',
            actor: 'dev',
            ids: {
              projectId: watch.projectId,
              missionId: blockedTask?.missionId,
              taskId: watch.taskId,
              paneId: id.paneId,
              phase: 'dev',
              role: 'dev'
            },
            reason: content.slice(0, 400)
          })
          hub.publish({
            projectId: watch.projectId,
            missionId: blockedTask?.missionId,
            kind: 'error',
            urgent: true,
            text: `DEV de UI bloqueado por falta de browser/runtime em "${blockedTask?.title ?? watch.taskId}". O trabalho foi preservado, nenhum receipt foi marcado como aplicado e a fase ficou interrompida para correção da capacidade.`,
            actor: 'harness'
          })
          if (ctx.uiSender && !ctx.uiSender.isDestroyed()) ctx.uiSender.send('tasks:changed', watch.projectId)
          syncBoard(watch.projectId)
          return 'bloqueio ambiental do DEV registrado — trabalho preservado, rodada interrompida e nenhum receipt aplicado'
        } finally {
          ctx.phaseTransitions.release(watch.taskId, transitionToken)
        }
      }
      let normalizedSecurityReview: SecurityReviewRecord | undefined
      if (watch.phase === 'review') {
        const task = tasks.get(watch.taskId)
        const planTask = task ? planTaskForWorkTask(task) : undefined
        const assessment = assessMissionRisk({
          declaredRisk: planTask?.plan?.risk,
          surfaces: planTask?.plan?.riskSurfaces,
          texts: task
            ? [task.title, task.description, task.briefing, ...(task.quests ?? [])]
            : []
        })
        const structuredReviewRequired =
          watch.phase === 'review' &&
          (assessment.effectiveRisk === 'high' ||
            requiresManualSecurityValidation(assessment.surfaces)) &&
          // MODO LEVE (2026-08-04): report simples basta com o switch ligado
          !securityWaiverOptions(watch.projectId).sensitiveWaiverAllowed
        if (structuredReviewRequired && !securityReview) {
          return (
            'report de segurança incompleto: este card é sensível e o revisor precisa enviar ' +
            'securityReview com fluxos revisados, achados, testes ausentes e próximo passo. ' +
            'Nenhum veredito foi consumido; complete o mesmo report.'
          )
        }
        if (securityReview) {
          const parsedVerdict = /^\s*aprovada\b/i.test(content)
            ? 'approved'
            : /^\s*reprovada\b/i.test(content)
              ? 'rejected'
              : 'invalid'
          const project = projects.get(watch.projectId)
          const mission = task?.missionId ? missions.get(task.missionId) : undefined
          normalizedSecurityReview = normalizeSecurityReview(securityReview, {
            projectId: watch.projectId,
            taskId: watch.taskId,
            phase: watch.phase,
            verdict: parsedVerdict,
            authorizedScope:
              mission?.scope?.trim() ||
              (task ? `card ${task.title} no projeto ${project?.name ?? watch.projectId}` : 'card local')
          })
          const validation = validateSecurityReview(normalizedSecurityReview, {
            sensitive: structuredReviewRequired
          })
          if (!validation.ok) {
            return `report de segurança recusado: ${validation.errors.slice(0, 6).join('; ')}`
          }
          if (!project) return 'report de segurança preservado: projeto não encontrado'
        }
      }
      if (
        id.role === 'dev' &&
        hub
          .panesOf(id.projectId)
          .some(
            (pane) =>
              pane.taskId === id.taskId && pane.role === 'ajudante'
          )
      ) {
        return 'conclusão bloqueada: ainda existe ajudante aberto neste card. Aguarde o fechamento automático após o report (ou encerre-o) e tente novamente.'
      }
      if (summary) {
        try {
          appendFileSync(
            watch.logFile,
            `\n[report ${id.role}] ${redactSensitiveText(summary)}\n`,
            'utf-8'
          )
        } catch {
          // transcript é best-effort
        }
      }
      // F2-c4: try-acquire SÍNCRONO abre a transação — ordem sagrada
      // acquire → detach → unlink (regra de ouro §3.2 do plano da Fase 2).
      const transitionToken = ctx.phaseTransitions.acquire(watch.taskId, {
        label: `report:${watch.phase}`,
        projectId: watch.projectId
      })
      if (!transitionToken)
        return 'a rodada anterior deste card ainda está fechando — aguarde alguns segundos e reporte de novo; nenhum receipt ou veredito foi consumido'
      phaseWatches.detach(watch.taskId)
      try {
        unlinkSync(watch.marker)
      } catch {
        // marcador nem chegou a existir (caminho MCP)
      }
      // PATCH SUGERIDO (meio-termo do usuário, 2026-08-05 — autor≠auditor
      // preservado): o gate NÃO escreve arquivo nenhum (catálogo sem escrita /
      // sandbox read-only); o diff viaja pelo report e o HARNESS o grava
      // git-invisível em .synkora/reports. O dev aplica, revisa e ASSUME.
      let patchNote = ''
      if (
        suggestedPatch?.trim() &&
        (watch.phase === 'review' || watch.phase === 'qa') &&
        /^\s*reprovada\b/i.test(content)
      ) {
        const roundN = (tasks.get(watch.taskId)?.gateRound?.round ?? 0) + 1
        const rel = join(
          '.synkora',
          'reports',
          `${watch.taskId.slice(0, 8)}-${watch.phase}-fixes-r${roundN}.diff`
        )
        try {
          const project = projects.get(watch.projectId)
          if (project) {
            const abs = join(project.path, rel)
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, redactSensitiveText(suggestedPatch), 'utf-8')
            patchNote = ` · patch sugerido em ${rel} (aplique com git apply, revise como autor)`
            blackbox.record({
              cat: 'phase',
              event: 'gate-suggested-patch',
              actor: watch.phase,
              ids: {
                projectId: watch.projectId,
                missionId: id.missionId,
                taskId: watch.taskId,
                phase: watch.phase,
                role: watch.phase
              },
              evidence: rel,
              detail: { bytes: suggestedPatch.length }
            })
          }
        } catch {
          patchNote = ''
        }
      }
      const acceptance = prepareSkillUsageAcceptance()
      if (!acceptance) {
        // recusa ANTES do advancePhase: o rollback re-indexa (createdAt
        // renovado) e solta o lock na ordem set→release
        ctx.phase.rollbackVerdictTransaction(watch, transitionToken)
        return 'report recusado: o ledger persistido desta rodada não corresponde ao plano ativo; reabra somente esta fase'
      }
      let advanced = false
      try {
        advanced = await ctx.phase.advancePhase(
          watch,
          patchNote ? `${content}${patchNote}` : content,
          normalizedSecurityReview,
          sanitizedVerificationEvidence,
          acceptance,
          transitionToken
        )
      } catch (error) {
        // TaskStore só publica a nova fotografia depois de o JSON atômico
        // pousar. Reindexar o watch torna o mesmo report repetível sem receipt
        // aplicado, pane órfão ou fase que avançou apenas em memória.
        // F2-c5 (§8.2): no throw a posse do lock volta para cá — o rollback
        // re-indexa (ou cede ao watch novo, R2) e SÓ ENTÃO solta.
        ctx.phase.rollbackVerdictTransaction(watch, transitionToken)
        return `report preservado: não foi possível persistir a transação da fase (${redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 240)}). Nenhum receipt foi consumido; tente novamente.`
      }
      return advanced
        ? 'report recebido — o pipeline avançou'
        : 'conclusão preservada: o pipeline não avançou; confira o aviso do Synkora, reconcilie ajudantes/arquivos/diagnósticos e reporte done novamente'
    }
  }
}

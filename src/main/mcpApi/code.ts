/**
 * MCP API — domínio code (fase 1, commit 4b).
 * Inteligência de código (LSP) e o guard do report(done) do dev:
 * helpers abertos, diagnósticos, drift de fotografia e fingerprint.
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing que o literal dava aos
 * parâmetros. uiSender/mcpPort (e campos nascidos depois do literal, como
 * mcpPaneFirstContact) são lidos via ctx a cada uso — getters reativos.
 */
import { join } from 'path'
import { type Task } from '../tasks'
import {
  changedWorktreeCodeFiles,
  changedWorktreeFiles,
  currentBranch,
  gitHead,
  gitMergeBase,
  gitTree,
  gitVisibleWorktreeFingerprint,
  hasGitCommit,
  isExecutableProjectPath,
  isWorktreeClean,
  snapshotTaskWorktree
} from '../worktree'
import { type Mission } from '../missions'
import { type PhaseWatch } from '../phaseTypes'
import { existsSync } from 'fs'
import { CodeIntelligenceError, CodeIntelligenceSession, type CodeQuery } from '../codeIntelligence'
import { formatCodeQueryError, formatCodeQueryResult } from '../codeIntelligence/format'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface CodeApiExtras {
  planTaskForWorkTask(task: Task): Task | undefined
  missionWorkspacePath(projectPath: string, mission: Mission): string | undefined
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
  completedPlannedAgentsByPhaseRun: Map<string, Set<string>>
}

export function buildCodeApi(
  ctx: MainContext, extras: CodeApiExtras
): Pick<McpApi, 'codeQuery' | 'codeReportGuard'> {
  const {
    tasks,
    projects,
    missions,
    blackbox,
    backlog,
    phaseWatches,
    codeIntelligenceSession
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  const {
    planTaskForWorkTask,
    missionWorkspacePath,
    skillPlanScopes,
    completedPlannedAgentsByPhaseRun
  } = extras
  return {
    codeQuery: async (id, query: CodeQuery) => {
      try {
        const result = await codeIntelligenceSession(id).query(query)
        return formatCodeQueryResult(result)
      } catch (error) {
        return formatCodeQueryError(query.operation, error)
      }
    },
    // F2-c5b (§7.10 do mapa da Fase 2): a fotografia viaja por VALOR — o
    // guard a devolve e ela segue guard → report → advancePhase como
    // argumento. Dois guards concorrentes (poller × MCP) escrevendo
    // watch.devSnapshot deixam de contaminar a decisão um do outro: cada
    // entrante julga a fotografia que ELE tirou. As limpezas
    // `watch.devSnapshot = undefined` ficam como higiene de valor antigo.
    codeReportGuard: async (id) => {
      const block = (blocked: string): { blocked: string } => ({ blocked })
      if (id.role !== 'dev' || !id.taskId) return {}
      const task = tasks.get(id.taskId)
      // Diagnóstico é independente de quantos panes de gate existem. Só um
      // card non_code é protegido se, por engano, tocar num arquivo executável.
      // Sem mudança de código, ele sai antes de iniciar qualquer LSP.
      if (!task || task.kind === 'plan') return {}
      const openHelpers = hub
        .panesOf(id.projectId)
        .filter(
          (pane) =>
            pane.taskId === id.taskId &&
            pane.role === 'ajudante'
        )
      if (openHelpers.length > 0) {
        return block(`${openHelpers.length} ajudante(s) deste card ainda estão abertos. Aguarde o fechamento automático após o report (ou encerre-os explicitamente) antes de reportar done; o snapshot final só nasce depois que nenhum outro processo pode escrever.`)
      }
      const parentSkillScope = skillPlanScopes.get(id.paneId)
      const requiredAgentId = parentSkillScope?.agentIds[0]
      if (
        requiredAgentId &&
        !completedPlannedAgentsByPhaseRun
          .get(parentSkillScope.phaseRun)
          ?.has(requiredAgentId)
      ) {
        return block(
          `o subagente especialista ${requiredAgentId} foi selecionado para esta rodada, ` +
            'mas nenhum ajudante com essa persona concluiu e reportou. Abra-o via delegate e integre o resultado antes de reportar done.'
        )
      }
      const project = projects.get(task.projectId)
      const mission = task.missionId ? missions.get(task.missionId) : undefined
      if (
        task.missionId &&
        (!project || !mission || !missionWorkspacePath(project.path, mission))
      ) {
        return block('Conclusão bloqueada: o worktree isolado da missão não pôde ser provado. Preserve este card; o Synkora não continuará os gates nem usará a branch principal.')
      }
      // RE-ENTREGA SANCIONADA (ordem do usuário, 2026-08-06 — "done do dev
      // SEMPRE funciona quando nenhum gate está ativamente julgando"): o dev
      // vivo com trabalho novo e o card estacionado (fase interrompida, sem
      // watch) era recusado e o fluxo MORRIA (caso real: correção de ambiente
      // aprovada pelo dono, commitada, e o report recusado — pingue-pongue
      // até o usuário pausar o plano). Reconstrói a fase dev aqui e o done
      // segue o caminho normal: snapshot novo → gates de verdade.
      if (
        !phaseWatches.get(id.taskId) &&
        task.phaseState === 'interrupted' &&
        existsSync(id.cwd)
      ) {
        const planTask = planTaskForWorkTask(task)
        if (planTask?.status === 'backlog' && planTask.plan?.approvedAt) {
          return block('Conclusão preservada: o PLANO desta missão está pausado — seu commit está seguro no worktree; quando o usuário re-aprovar o plano, reporte done de novo.')
        }
        const gitProject = project ? hasGitCommit(project.path) : false
        const rebuiltWorktree = gitProject
          ? { dir: id.cwd, branch: currentBranch(id.cwd) ?? `task/${id.taskId.slice(0, 8)}` }
          : null
        const runsDirRe = project ? join(project.path, '.synkora', 'runs') : id.cwd
        phaseWatches.set(id.taskId, {
          projectId: id.projectId,
          taskId: id.taskId,
          phase: 'dev',
          devSeatId: task.phaseSessions?.dev?.seatId ?? mission?.seatId ?? '',
          devEffort: task.devEffort,
          cwd: id.cwd,
          worktree: rebuiltWorktree,
          logFile: join(runsDirRe, `${id.taskId}.md`),
          marker: join(runsDirRe, `${id.taskId}.done`),
          paneId: id.paneId,
          createdAt: Date.now()
        })
        tasks.update(id.taskId, {
          status: 'execucao',
          activePhase: 'dev',
          phaseState: 'running'
        })
        blackbox.record({
          cat: 'phase',
          event: 'redelivery-accepted',
          actor: 'dev',
          ids: {
            projectId: id.projectId,
            missionId: task.missionId,
            taskId: id.taskId,
            paneId: id.paneId,
            phase: 'dev',
            role: 'dev'
          },
          prev: `${task.status}/${task.activePhase ?? '-'}/interrupted`,
          reason:
            'dev vivo reportou done com o card estacionado e nenhum gate julgando — fase dev reconstruída; a entrega segue para os gates normalmente'
        })
      }
      const watch = phaseWatches.get(id.taskId)
      if (!watch || watch.phase !== 'dev' || watch.cwd !== id.cwd) {
        return block('Conclusão bloqueada: há um gate ativo julgando este card (ou outra fase em andamento) — aguarde o veredito nesta conversa; seu trabalho está preservado e nada precisa ser reaberto por você.')
      }
      let preparedSnapshot: PhaseWatch['devSnapshot']
      if (watch.worktree) {
        const snapshot = snapshotTaskWorktree(
          watch.cwd,
          `${ctx.phase.taskIntegrationMarker(task)} · snapshot entregue por dev · ${task.title}`
        )
        if (!snapshot.ok || !snapshot.head || !snapshot.tree || !snapshot.fingerprint) {
          watch.devSnapshot = undefined
          return block(`Conclusão bloqueada: ${snapshot.detail}. Confira o worktree e reporte done novamente.`)
        }
        preparedSnapshot = {
          head: snapshot.head,
          tree: snapshot.tree,
          fingerprint: snapshot.fingerprint
        }
      }
      const snapshotDrift = (): string | undefined => {
        if (!preparedSnapshot) return undefined
        if (
          gitHead(watch.cwd) !== preparedSnapshot.head ||
          gitTree(watch.cwd, preparedSnapshot.head) !== preparedSnapshot.tree ||
          isWorktreeClean(watch.cwd) !== true ||
          gitVisibleWorktreeFingerprint(watch.cwd) !== preparedSnapshot.fingerprint
        ) {
          watch.devSnapshot = undefined
          return 'Conclusão bloqueada: arquivos mudaram durante a validação da fotografia. Tudo foi preservado; confira a diferença e reporte done novamente.'
        }
        return undefined
      }
      // Sucesso devolve a fotografia POR VALOR; drift devolve o bloqueio.
      const settleGuard = (): { blocked?: string; devSnapshot?: PhaseWatch['devSnapshot'] } => {
        const drift = snapshotDrift()
        return drift ? { blocked: drift } : { devSnapshot: preparedSnapshot }
      }
      const baseRef = mission
        ? mission.branch
        : (project ? currentBranch(project.path) : undefined)
      if (preparedSnapshot) {
        const fallbackBase = baseRef ?? (project ? gitHead(project.path) : undefined)
        const baseHead = fallbackBase
          ? gitMergeBase(id.cwd, preparedSnapshot.head, fallbackBase)
          : undefined
        if (!baseHead) {
          watch.devSnapshot = undefined
          return block('Conclusão bloqueada: não consegui calcular a base imutável do card para review/diagnóstico. Preservei a entrega; repare a referência Git e reporte novamente.')
        }
        preparedSnapshot.baseHead = baseHead
      }
      const diffBaseRef = preparedSnapshot?.baseHead ?? baseRef
      const changedPaths = diffBaseRef
        ? changedWorktreeFiles(id.cwd, diffBaseRef)
        : undefined
      // CERCA DO RUNTIME (02/08): o info/exclude não segura `git add`
      // explícito — um dev commitou .synkora/DESIGN.md, o release levou à
      // master e o guard de runtime passou a bloquear o projeto inteiro.
      // Entrega que versiona .synkora/** não passa daqui.
      const synkoraTracked = (changedPaths ?? []).filter(
        (p) => p === '.synkora' || p.startsWith('.synkora/')
      )
      if (synkoraTracked.length > 0) {
        const visible = synkoraTracked.slice(0, 4).join(', ')
        return block(
          `Conclusão bloqueada: a entrega VERSIONA arquivos de runtime do Synkora (${visible}` +
            `${synkoraTracked.length > 4 ? ` +${synkoraTracked.length - 4}` : ''}). ` +
            `.synkora/** nunca entra no repositório. Rode git rm --cached -r nesses paths ` +
            `(os arquivos ficam no disco), commite a remoção do índice e reporte done novamente.`
        )
      }
      if (task.deliverable === 'non_code') {
        if (watch.worktree && changedPaths === undefined) {
          return block('Conclusão bloqueada: não consegui provar quais arquivos pertencem ao snapshot non_code; preservei a entrega para reclassificação ou reparo do Git.')
        }
        const executable = (changedPaths ?? []).filter(isExecutableProjectPath)
        if (executable.length > 0) {
          const visible = executable.slice(0, 6).join(', ')
          return block(`Este card foi aprovado como non_code, mas alterou comportamento executável (${visible}${executable.length > 6 ? ` +${executable.length - 6}` : ''}). O orquestrador precisa reclassificá-lo como code; o backend não permite pular review/QA com um rótulo incorreto.`)
        }
      }
      const changedFiles = diffBaseRef
        ? changedWorktreeCodeFiles(id.cwd, diffBaseRef)
        : undefined
      if (changedFiles?.length === 0) return settleGuard()

      if (id.paneId && !ctx.mcpPaneFirstContact.has(id.paneId)) {
        // Pane que NUNCA autenticou no MCP não tem como rodar code_diagnostics
        // — exigir vira beco sem saída (caso real 04/08: dev codex resumado
        // sem tools ficou preso no guard com typecheck/lint/testes verdes; o
        // caminho de chegada é o marcador .done, que existe exatamente para
        // pane sem MCP). A fotografia e os gates do card continuam valendo;
        // o desvio fica auditado na caixa-preta.
        blackbox.record({
          cat: 'verify',
          event: 'report-guard-degraded-no-mcp',
          actor: 'harness',
          ids: {
            projectId: id.projectId,
            missionId: id.missionId,
            taskId: id.taskId,
            paneId: id.paneId,
            role: id.role
          },
          reason:
            'guard de diagnósticos dispensado: o pane nunca conectou ao MCP nesta sessão (marcador .done)'
        })
        return settleGuard()
      }

      let session: CodeIntelligenceSession
      try {
        session = codeIntelligenceSession(id)
      } catch (error) {
        if (
          error instanceof CodeIntelligenceError &&
          (error.code === 'SERVER_UNAVAILABLE' || error.code === 'MANAGER_CLOSED')
        ) return settleGuard()
        return block('Não foi possível iniciar a validação dos diagnósticos. Execute code_diagnostics e tente reportar done novamente.')
      }

      if (changedFiles !== undefined) {
        const missing: string[] = []
        const stale: string[] = []
        const failed: string[] = []
        const red: string[] = []

        for (const path of changedFiles) {
          try {
            const status = await session.diagnosticsGuard(path)
            if (status.state === 'missing') missing.push(path)
            else if (status.state === 'stale') stale.push(path)
            else if (status.state === 'current' && (status.errorCount ?? 0) > 0)
              red.push(`${path} (${status.errorCount} erro(s))`)
            // Servidor realmente indisponível mantém o fallback textual do
            // pane; ele não deve transformar uma indisponibilidade externa em
            // um bloqueio impossível de resolver.
          } catch (error) {
            if (
              error instanceof CodeIntelligenceError &&
              error.code === 'SERVER_UNAVAILABLE'
            ) continue
            failed.push(path)
          }
        }

        const compactPaths = (paths: string[]): string => {
          const visible = paths.slice(0, 6).map((path) =>
            path.replace(/[\u0000-\u001f\u007f]/g, '�').slice(0, 180)
          )
          return `${visible.join(', ')}${paths.length > visible.length ? ` (+${paths.length - visible.length})` : ''}`
        }
        if (failed.length > 0) {
          return block(`Não foi possível validar os diagnósticos de: ${compactPaths(failed)}. Execute code_diagnostics nesses arquivos e tente reportar done novamente.`)
        }
        if (red.length > 0) {
          return block(`Os diagnósticos estão atualizados, mas ainda vermelhos: ${compactPaths(red)}. Corrija os erros e execute code_diagnostics novamente; consultar o diagnóstico não transforma erro em aprovação.`)
        }
        if (missing.length > 0 || stale.length > 0) {
          const details = [
            missing.length > 0 ? `sem diagnóstico: ${compactPaths(missing)}` : '',
            stale.length > 0 ? `diagnóstico desatualizado: ${compactPaths(stale)}` : ''
          ].filter(Boolean).join('; ')
          return block(`Antes de reportar done, execute code_diagnostics em todos os arquivos TypeScript/JavaScript alterados (${details}).`)
        }
        return settleGuard()
      }

      // Sem Git/base legível não dá para reconstruir o diff com segurança.
      // Mantém o gate owner-wide anterior como degradação conservadora.
      try {
        const status = await session.diagnosticsStatus()
        if (status.state === 'unavailable') return settleGuard()
        if (status.state === 'missing') {
          return block('Antes de reportar done, execute code_diagnostics nos arquivos TypeScript/JavaScript alterados e leia o resultado. Se o servidor não estiver disponível, a própria ferramenta liberará o fallback textual.')
        }
        if (status.state === 'stale') {
          return block('Os diagnósticos ficaram desatualizados após novas alterações. Execute code_diagnostics novamente nos arquivos TypeScript/JavaScript alterados antes de reportar done.')
        }
        if (status.state === 'current' && (status.errorCount ?? 0) > 0) {
          return block(`Os diagnósticos atuais ainda contêm ${status.errorCount} erro(s). Corrija-os e execute code_diagnostics novamente antes de reportar done.`)
        }
      } catch {
        // Falha da inteligência de código nunca impede o fallback normal do pane.
      }
      return settleGuard()
    }
  }
}

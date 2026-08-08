/**
 * MCP API — domínio skills (fase 1, commit 4b).
 * Biblioteca de skills: ativação por receipt e o menu pesquisável.
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing que o literal dava aos
 * parâmetros. uiSender/mcpPort (e campos nascidos depois do literal, como
 * mcpPaneFirstContact) são lidos via ctx a cada uso — getters reativos.
 */
import { join, relative, resolve } from 'path'
import { type Task } from '../tasks'
import { gitOff } from '../gitAsync'
import { SkillRuntime } from '../skillRuntime'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface SkillsApiExtras {
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
  privateSkillRuntimeRoot: string
}

export function buildSkillsApi(
  ctx: MainContext, extras: SkillsApiExtras
): Pick<McpApi, 'activateSkill' | 'listSkills'> {
  const {
    tasks,
    blackbox,
    maestro,
    skillsLib
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  const {
    skillRuntime,
    skillPlanScopes,
    privateSkillRuntimeRoot
  } = extras
  return {
    activateSkill: async (id, receiptId) => {
      const scope = skillPlanScopes.get(id.paneId)
      const activeSkillPhase =
        id.role === 'maestro'
          ? 'planning'
          : id.phase ?? (id.role === 'ajudante' ? 'helper' : undefined)
      if (
        !scope ||
        !activeSkillPhase ||
        scope.phase !== activeSkillPhase ||
        scope.projectId !== id.projectId ||
        (id.role === 'maestro' && scope.missionId !== id.missionId)
      )
        return 'ativação recusada: este pane não possui um plano ativo de skills'
      const input = {
        paneId: id.paneId,
        phase: activeSkillPhase,
        phaseRun: scope.phaseRun,
        receiptId
      }
      const resolved = skillRuntime.resolve(input)
      if (!resolved.ok) return `ativação recusada: ${resolved.message}`
      const payload = await skillsLib.loadActivationPackage(
        resolved.receipt.skillId,
        resolved.receipt.operation
      )
      if (!payload) {
        return 'ativação recusada: o pacote selecionado não está íntegro ou o playbook não existe'
      }
      if (
        payload.version !== resolved.receipt.version ||
        payload.fingerprint !== resolved.receipt.fingerprint
      ) {
        return 'ativação recusada: o pacote mudou depois que esta rodada foi planejada; reabra a fase para receber um receipt novo'
      }
      const privateRoot = await skillsLib.materializeActivationTree(
        payload.id,
        privateSkillRuntimeRoot,
        id.paneId,
        scope.phaseRun,
        resolved.receipt.version,
        payload.sourceFingerprint,
        payload.content
      )
      if (!privateRoot) {
        return 'ativação recusada: não foi possível preparar a árvore privada e íntegra desta skill'
      }
      const currentIdentity = hub.identityByPane(id.paneId)
      const currentScope = skillPlanScopes.get(id.paneId)
      if (
        !currentIdentity ||
        currentScope?.phaseRun !== scope.phaseRun ||
        currentScope.phase !== scope.phase
      ) {
        await gitOff(
          'removePrivateSkillPlan',
          privateSkillRuntimeRoot,
          id.paneId,
          scope.phaseRun,
          payload.id
        ).catch(() => undefined)
        return 'ativação recusada: o pane ou a rodada encerrou durante a preparação do pacote'
      }
      const privateContent = payload.content
        .replaceAll(`.claude/skills/${payload.id}`, privateRoot)
        .replaceAll(`.agents/skills/${payload.id}`, privateRoot)
      let durableUsageBefore: NonNullable<Task['skillUsage']> | undefined
      let durableUsageAfter: NonNullable<Task['skillUsage']> | undefined
      const durableTaskId = scope.taskId
      if (durableTaskId) {
        const task = tasks.get(durableTaskId)
        const usage = task?.skillUsage
        const ledgerReceipt = usage?.skills.find((skill) => skill.receiptId === receiptId)
        if (
          id.taskId !== durableTaskId ||
          task?.projectId !== id.projectId ||
          usage?.phaseRun !== scope.phaseRun ||
          usage.phase !== scope.phase ||
          !ledgerReceipt ||
          ledgerReceipt.id !== resolved.receipt.skillId ||
          ledgerReceipt.operation !== resolved.receipt.operation ||
          ledgerReceipt.version !== resolved.receipt.version ||
          ledgerReceipt.fingerprint !== resolved.receipt.fingerprint
        ) {
          await gitOff(
            'removePrivateSkillPlan',
            privateSkillRuntimeRoot,
            id.paneId,
            scope.phaseRun,
            payload.id
          ).catch(() => undefined)
          return 'ativação recusada: o ledger durável desta rodada não corresponde ao receipt planejado'
        }
        if (ledgerReceipt.status === 'planned') {
          const updatedAt = new Date().toISOString()
          const skills = usage.skills.map((skill) =>
            skill.receiptId === receiptId ? { ...skill, status: 'activated' as const } : skill
          )
          durableUsageBefore = usage
          durableUsageAfter = {
            ...usage,
            updatedAt,
            skills,
            history: (usage.history ?? []).map((run) =>
              run.phaseRun === scope.phaseRun ? { ...run, updatedAt, skills } : run
            )
          }
        }
      }
      const activated = durableTaskId
        ? skillRuntime.activateAfterDurableCommit(input, {
            commit: () => {
              if (!durableUsageAfter) return
              if (!tasks.update(durableTaskId, { skillUsage: durableUsageAfter })) {
                throw new Error('task ledger disappeared before activation commit')
              }
            },
            rollback: () => {
              if (!durableUsageBefore) return
              if (!tasks.update(durableTaskId, { skillUsage: durableUsageBefore })) {
                throw new Error('task ledger disappeared before activation rollback')
              }
            }
          })
        : skillRuntime.activate(input)
      if (!activated.ok) {
        await gitOff(
          'removePrivateSkillPlan',
          privateSkillRuntimeRoot,
          id.paneId,
          scope.phaseRun,
          payload.id
        ).catch(() => undefined)
        return `ativação recusada: ${activated.message}`
      }
      blackbox.record({
        cat: 'pane',
        event: 'skill-activated',
        actor: id.role,
        ids: {
          projectId: id.projectId,
          missionId: id.missionId,
          taskId: id.taskId,
          paneId: id.paneId,
          phase: id.phase,
          role: id.role
        },
        reason: `${payload.id}:${payload.operation}`,
        evidence: payload.fingerprint.slice(0, 24),
        detail: { receiptId, references: payload.loadedReferences }
      })
      if (durableTaskId && ctx.uiSender && !ctx.uiSender.isDestroyed()) {
        try {
          ctx.uiSender.send('tasks:changed', id.projectId)
        } catch {
          // A notificação acelera a UI, mas nunca invalida ledger+runtime já confirmados.
        }
      }
      return [
        `SKILL ACTIVATED · ${payload.id} · operation ${payload.operation} · receiptId ${receiptId}`,
        `PRIVATE PACKAGE ROOT · ${privateRoot} · resolve every relative reference, script, template, or asset from this directory; do not browse another pane's runtime plan.`,
        privateContent
      ].join('\n\n')
    },
    // Um OU vários ajudantes numa chamada só (lote = uma rodada de modelo do
    // delegador em vez de N — abrir 3 ajudantes custava ~3min de re-thinking
    // entre calls, reclamação real do usuário em 2026-07-29).
    // Biblioteca (skills + subagentes) na mão dos agentes: o orquestrador
    // consulta antes de carimbar cards e de aconselhar/abrir ajudantes.
    listSkills: (id, filter = {}) => {
      const normalize = (value: string): string =>
        value
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLocaleLowerCase('pt-BR')
      const query = normalize(filter.query?.trim() ?? '')
      const taskDepartment = id.taskId ? tasks.get(id.taskId)?.department : undefined
      const department = filter.department ?? taskDepartment
      const installedOnly = filter.installedOnly ?? true
      if (!query && !filter.kind && !department) {
        return 'consulta ampla recusada para proteger o contexto — informe query, department ou kind; o roteador já escolhe automaticamente o plano mínimo de cada fase'
      }
      const limit = Math.max(1, Math.min(20, filter.limit ?? 16))
      const all = skillsLib.listState()
      const selectableIds = new Set(skillsLib.installedIds())
      if (!all.length) return 'biblioteca vazia — nada curado disponível ainda'
      const matches = all
        .filter((skill) => !installedOnly || selectableIds.has(skill.id))
        .filter((skill) => !filter.kind || skill.kind === filter.kind)
        .filter((skill) => !department || skill.depts.includes(department))
        .filter((skill) => {
          if (!query) return true
          return normalize([skill.id, skill.group, skill.summary, skill.hint].join(' ')).includes(query)
        })
        .sort((a, b) => Number(b.installed) - Number(a.installed) || a.id.localeCompare(b.id))
      const list = matches.slice(0, limit)
      if (!list.length) {
        return 'nenhum item corresponde aos filtros — ajuste query/função/tipo; use installedOnly=false somente para descobrir opções instaláveis'
      }
      return JSON.stringify(
        {
          itens: list.map((s) => ({
            id: s.id,
            tipo: s.kind === 'agent' ? 'subagente' : 'skill',
            grupo: s.group,
            funcoes: s.depts,
            instalado: s.installed,
            disponivelParaExecucao: selectableIds.has(s.id),
            quandoUsar: s.hint,
            ...(s.updateAvailable ? { atualizacaoDisponivel: true } : {})
          })),
          correspondencias: matches.length,
          retornados: list.length,
          ...(matches.length > list.length
            ? { refine: 'há mais resultados; refine query/função/tipo em vez de ampliar o contexto' }
            : {}),
          dica: 'ids EXATOS e instalado=true, só o que encaixa. O roteador da fase escolhe automaticamente o plano mínimo; carimbos explícitos servem apenas para uma necessidade técnica concreta. SUBAGENTES exigem um subproblema independente.'
        },
        null,
        2
      )
    }
  }
}

/**
 * MCP API — domínio plans (Synkora 2.0, onda D).
 * O kit de ferramentas do CHAT de planejamento: ler os planos do universo,
 * APRESENTAR um plano novo ao dono e editar/arquivar os que já existem.
 *
 * A régua de autoridade (memória feedback-guardas-nao-capam-inteligencia):
 * - `propose_plan` NUNCA cria. Ele valida, apresenta o card no chat e devolve
 *   "apresentada ao dono" — a criação é o CLIQUE, e ausência de resposta nunca
 *   é consentimento (a lição do M04).
 * - `update_plan` e `delete_plan` EXECUTAM: editar e arquivar são reversíveis e
 *   auditáveis, e travá-los só ensinaria o agente a pedir permissão para o que
 *   as alavancas dele já dão.
 * - `missionId` e o estado 'concluida' de um item ficam FORA do alcance de
 *   qualquer patch: são derivados da missão real, não opinião do agente.
 *
 * Escopo: toda tool enxerga somente os planos do `projectId` da identidade.
 */
import { normalizePlanDraft, type PlanDraft } from '../planDraft'
import {
  planView,
  type PlanItemView,
  type PlanMissionSnapshot,
  type PlanPatch,
  type PlanView
} from '../plans'
import type { PaneIdentity } from '../hub'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

export interface PlansApiExtras {
  /**
   * Apresenta a proposta NO CHAT do pane (evento sintético + card). É o único
   * caminho: o motor do pane é quem tem o anel, e é do anel que a aprovação
   * lê o rascunho autoritativo.
   */
  proposePlanToPane(
    paneId: string,
    draft: PlanDraft
  ): { ok: true; requestId: string } | { ok: false; error: string }
}

function missionSnapshots(ctx: MainContext, projectId: string): PlanMissionSnapshot[] {
  return ctx.missions
    .list(projectId)
    .map((mission) => ({ id: mission.id, title: mission.title, status: mission.status }))
}

/** Fotografia com autocura + progresso derivado — a MESMA que o mapa mostra. */
function viewsOf(ctx: MainContext, projectId: string): PlanView[] {
  const missions = missionSnapshots(ctx, projectId)
  ctx.plans.reconcile(projectId, new Set(missions.map((mission) => mission.id)))
  return ctx.plans.list(projectId).map((plan) => planView(plan, missions))
}

function itemLine(item: PlanItemView): string {
  const bits = [`  - [${item.status}] ${item.title}`, `id ${item.id}`]
  if (item.tier) bits.push(`tier ${item.tier}`)
  if (item.mission) bits.push(`missão "${item.mission.title}" (${item.mission.status})`)
  if (item.docPath) bits.push(item.docPath)
  if (item.note) bits.push(`⚠ ${item.note}`)
  return bits.join(' · ')
}

function planSummary(plan: PlanView): string {
  const head = `${plan.kind === 'mestre' ? '★ ' : ''}${plan.title} — ${plan.status} · ${plan.progress.done}/${plan.progress.total} · id ${plan.id} · updatedAt ${plan.updatedAt}`
  return [head, ...plan.items.map(itemLine)].join('\n')
}

function planDetail(plan: PlanView): string {
  const lines = [
    `PLANO ${plan.title} (${plan.kind}, ${plan.status})`,
    `id: ${plan.id}`,
    `updatedAt: ${plan.updatedAt}   ← mande este valor em expectedUpdatedAt`,
    `progresso: ${plan.progress.done}/${plan.progress.total}`
  ]
  if (plan.description) lines.push('', plan.description)
  for (const item of plan.items) {
    lines.push('', `— ${item.title} [${item.status}] (id ${item.id})`)
    lines.push(`  Objetivo: ${item.objective}`)
    if (item.outOfScope) lines.push(`  Fora de escopo: ${item.outOfScope}`)
    if (item.doneCriteria.length > 0) {
      lines.push('  Critério de pronto:')
      for (const criterion of item.doneCriteria) lines.push(`    • ${criterion}`)
    }
    if (item.tier) lines.push(`  Tier: ${item.tier}`)
    if (item.context) lines.push(`  Contexto: ${item.context}`)
    if (item.dependsOn.length > 0) lines.push(`  Depende de: ${item.dependsOn.join(', ')}`)
    if (item.docPath) lines.push(`  Brief: ${item.docPath}`)
    if (item.mission) {
      lines.push(`  Missão vinculada: "${item.mission.title}" (${item.mission.status})`)
    }
    if (item.note) lines.push(`  ⚠ ${item.note}`)
  }
  return lines.join('\n')
}

export function buildPlansApi(
  ctx: MainContext,
  extras: PlansApiExtras
): Pick<McpApi, 'listPlans' | 'getPlan' | 'proposePlan' | 'updatePlan' | 'deletePlan'> {
  /** Um plano DESTE universo — a cerca de escopo de todas as tools. */
  const scoped = (id: PaneIdentity, planId: string): PlanView | undefined =>
    viewsOf(ctx, id.projectId).find((plan) => plan.id === planId)

  return {
    listPlans: (id) => {
      const plans = viewsOf(ctx, id.projectId)
      if (plans.length === 0) {
        return 'este universo ainda não tem nenhum plano. Converse com o dono e, quando ele concordar com o recorte, chame propose_plan.'
      }
      return plans.map(planSummary).join('\n\n')
    },

    getPlan: (id, planId) => {
      const plan = scoped(id, planId)
      return plan ? planDetail(plan) : 'plano não encontrado neste universo'
    },

    proposePlan: (id, draft) => {
      const normalized = normalizePlanDraft(draft)
      if (!normalized.ok) return `proposta recusada: ${normalized.error}`
      const presented = extras.proposePlanToPane(id.paneId, normalized.draft)
      if (!presented.ok) return `não consegui apresentar a proposta: ${presented.error}`
      ctx.blackbox.record({
        cat: 'user',
        event: 'plan-proposal-presented',
        actor: 'gui-planner',
        ids: { projectId: id.projectId, paneId: id.paneId },
        detail: {
          title: normalized.draft.title,
          kind: normalized.draft.kind,
          items: normalized.draft.items.length
        }
      })
      return [
        `proposta "${normalized.draft.title}" (${normalized.draft.items.length} missão(ões)) APRESENTADA ao dono no chat.`,
        'Ela NÃO virou plano: quem cria é o clique dele no card. Encerre o turno e espere — se ele pedir ajuste, o texto chega como mensagem nova.'
      ].join(' ')
    },

    updatePlan: (id, planId, patch, expectedUpdatedAt) => {
      const plan = scoped(id, planId)
      if (!plan) return 'plano não encontrado neste universo'
      const result = ctx.plans.update(planId, patch, expectedUpdatedAt)
      if (!result.ok) return `alteração recusada: ${result.error}`
      ctx.pushAll('plans:changed', id.projectId)
      const updated = planView(result.plan, missionSnapshots(ctx, id.projectId))
      return [
        `plano "${updated.title}" atualizado.`,
        `updatedAt novo: ${updated.updatedAt}`,
        '',
        planSummary(updated)
      ].join('\n')
    },

    deletePlan: (id, planId, expectedUpdatedAt) => {
      const plan = scoped(id, planId)
      if (!plan) return 'plano não encontrado neste universo'
      const result = ctx.plans.archive(planId, expectedUpdatedAt)
      if (!result.ok) return `arquivamento recusado: ${result.error}`
      ctx.pushAll('plans:changed', id.projectId)
      return `plano "${result.plan.title}" ARQUIVADO (reversível — a aba some do mapa, o conteúdo fica). Exclusão definitiva é só pelo gesto do dono no mapa.`
    }
  }
}

export type { PlanPatch }

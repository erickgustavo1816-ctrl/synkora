/**
 * IPC — domínio plans (Synkora 2.0, onda D — o MAPA vira menu de planejamento).
 * Leitura com progresso DERIVADO e os gestos do dono sobre um plano. O motor
 * mora no `plans.ts`; aqui só há a costura: validar o remetente, delegar,
 * empurrar `plans:changed`.
 *
 * CERCA VIVA da Fase 0: register*Ipc é CHAMADO do whenReady (bloco único antes
 * do createWindow), NUNCA no import — instrumentIpcMain só cobre handlers
 * registrados depois dele.
 *
 * Sender: `assertAppRendererSender` (host OU view de panes) — o mapa mora no
 * host, mas o card de proposta que dispara a criação nasce dentro do canvas.
 *
 * CAS EM TODO MUTADOR (padrão ipc/projectPlan.ts): a fotografia que o dono leu
 * na tela é a que ele grava por cima. Sem isso, o agente editando o plano por
 * `update_plan` enquanto o modal está aberto faria o clique do dono sobrescrever
 * uma versão que ele nunca viu.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { normalizePlanDraft } from '../planDraft'
import {
  PLAN_NOT_FOUND_ERROR,
  planView,
  type PlanMissionSnapshot,
  type PlanMutation,
  type PlanPatch,
  type PlanRemoval,
  type PlanView
} from '../plans'
import type { MainContext } from '../mainContext'

export interface PlansIpcExtras {
  /** F3-c4: host OU view de panes — o card de proposta mora no canvas. */
  assertAppRendererSender(event: IpcMainInvokeEvent): void
}

/** Só o que o mapa precisa da missão — nunca o registro inteiro. */
export function planMissionSnapshots(ctx: MainContext, projectId: string): PlanMissionSnapshot[] {
  return ctx.missions
    .list(projectId)
    .map((mission) => ({ id: mission.id, title: mission.title, status: mission.status }))
}

/**
 * Fotografia canônica do mapa: autocura primeiro (vínculo com missão que não
 * existe mais é desfeito e PERSISTIDO), progresso derivado depois. Exportada
 * porque o caminho de aprovação do card responde com a mesma visão.
 */
export function planViewsOf(ctx: MainContext, projectId: string): PlanView[] {
  const missions = planMissionSnapshots(ctx, projectId)
  const known = new Set(missions.map((mission) => mission.id))
  const healed = ctx.plans.reconcile(projectId, known)
  if (healed.detached.length > 0) {
    ctx.blackbox.record({
      cat: 'recovery',
      event: 'plan-item-mission-detached',
      actor: 'harness',
      ids: { projectId },
      reason: 'a missão vinculada não existe mais',
      detail: { detached: healed.detached }
    })
  }
  return ctx.plans.list(projectId).map((plan) => planView(plan, missions))
}

function expected(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

export function registerPlansIpc(ctx: MainContext, extras: PlansIpcExtras): void {
  const changed = (projectId: string): void => {
    ctx.pushAll('plans:changed', projectId)
  }

  /** O plano existe? Devolve o projeto dele para o push acertar o destino. */
  const projectOf = (planId: unknown): string | undefined =>
    typeof planId === 'string' ? ctx.plans.get(planId)?.projectId : undefined

  ipcMain.handle('plans:list', (e, projectId: unknown): PlanView[] => {
    extras.assertAppRendererSender(e)
    if (typeof projectId !== 'string' || !projectId) return []
    return planViewsOf(ctx, projectId)
  })

  /**
   * Criação MANUAL (o gesto do dono no mapa). A aprovação do card de proposta
   * NÃO passa por aqui: ela usa o rascunho autoritativo guardado no anel do
   * pane (gui:answerPlanProposal), porque um rascunho vindo do renderer seria
   * texto que ninguém validou contra o que o agente realmente propôs.
   */
  ipcMain.handle('plans:create', (e, projectId: unknown, draft: unknown): PlanMutation => {
    extras.assertAppRendererSender(e)
    if (typeof projectId !== 'string' || !projectId) {
      return { ok: false, error: 'projeto não encontrado' }
    }
    if (!ctx.projects.get(projectId)) return { ok: false, error: 'projeto não encontrado' }
    const normalized = normalizePlanDraft(draft)
    if (!normalized.ok) return { ok: false, error: normalized.error }
    const created = ctx.plans.create(projectId, normalized.draft, { manual: true })
    if (created.ok) {
      ctx.blackbox.record({
        cat: 'user',
        event: 'plan-created',
        actor: 'user',
        ids: { projectId, planId: created.plan.id },
        detail: { kind: created.plan.kind, items: created.plan.items.length }
      })
      changed(projectId)
    }
    return created
  })

  ipcMain.handle(
    'plans:update',
    (e, planId: unknown, patch: unknown, expectedUpdatedAt: unknown): PlanMutation => {
      extras.assertAppRendererSender(e)
      const projectId = projectOf(planId)
      if (!projectId || typeof planId !== 'string') {
        return { ok: false, error: PLAN_NOT_FOUND_ERROR }
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: 'alteração em formato inválido' }
      }
      const result = ctx.plans.update(planId, patch as PlanPatch, expected(expectedUpdatedAt))
      if (result.ok) changed(projectId)
      return result
    }
  )

  ipcMain.handle(
    'plans:archive',
    (e, planId: unknown, expectedUpdatedAt: unknown): PlanMutation => {
      extras.assertAppRendererSender(e)
      const projectId = projectOf(planId)
      if (!projectId || typeof planId !== 'string') {
        return { ok: false, error: PLAN_NOT_FOUND_ERROR }
      }
      const result = ctx.plans.archive(planId, expected(expectedUpdatedAt))
      if (result.ok) changed(projectId)
      return result
    }
  )

  /**
   * DESIGNAÇÃO DE MESTRE — canal SEPARADO por desenho (2026-08-17). Ele não
   * entra no `PlanPatch` porque `update_plan` executa direto: o agente passaria
   * a se autodesignar plano de fundo do universo. Aqui só chega clique do dono,
   * e a caixa-preta grava a transição com `actor: 'user'`.
   */
  ipcMain.handle(
    'plans:setKind',
    (e, planId: unknown, kind: unknown, expectedUpdatedAt: unknown): PlanMutation => {
      extras.assertAppRendererSender(e)
      const projectId = projectOf(planId)
      if (!projectId || typeof planId !== 'string') {
        return { ok: false, error: PLAN_NOT_FOUND_ERROR }
      }
      if (kind !== 'mestre' && kind !== 'livre') {
        return { ok: false, error: 'natureza de plano desconhecida' }
      }
      const before = ctx.plans.get(planId)?.kind
      const result = ctx.plans.setKind(planId, kind, expected(expectedUpdatedAt))
      if (result.ok) {
        ctx.blackbox.record({
          cat: 'user',
          event: kind === 'mestre' ? 'plan-designated-master' : 'plan-master-designation-removed',
          actor: 'user',
          ids: { projectId, planId },
          prev: before,
          next: kind,
          detail: { title: result.plan.title }
        })
        changed(projectId)
      }
      return result
    }
  )

  /** Exclusão DURA — o modal de confirmação do mapa é a única porta. */
  ipcMain.handle(
    'plans:remove',
    (e, planId: unknown, expectedUpdatedAt: unknown): PlanRemoval => {
      extras.assertAppRendererSender(e)
      const projectId = projectOf(planId)
      if (!projectId || typeof planId !== 'string') {
        return { ok: false, error: PLAN_NOT_FOUND_ERROR }
      }
      const result = ctx.plans.remove(planId, expected(expectedUpdatedAt))
      if (result.ok) {
        ctx.blackbox.record({
          cat: 'user',
          event: 'plan-removed',
          actor: 'user',
          ids: { projectId, planId }
        })
        changed(projectId)
      }
      return result
    }
  )

  /**
   * O item virou missão de verdade. Só este canal escreve `missionId` — e ele
   * exige que a missão exista E pertença ao MESMO projeto do plano, senão o
   * mapa passaria a mostrar progresso de outro universo.
   */
  ipcMain.handle(
    'plans:linkMission',
    (
      e,
      planId: unknown,
      itemId: unknown,
      missionId: unknown,
      expectedUpdatedAt: unknown
    ): PlanMutation => {
      extras.assertAppRendererSender(e)
      const projectId = projectOf(planId)
      if (!projectId || typeof planId !== 'string') {
        return { ok: false, error: PLAN_NOT_FOUND_ERROR }
      }
      if (typeof itemId !== 'string' || !itemId) {
        return { ok: false, error: 'item sem identificador' }
      }
      if (typeof missionId !== 'string' || !missionId) {
        return { ok: false, error: 'missão sem identificador' }
      }
      const mission = ctx.missions.get(missionId)
      if (!mission || mission.projectId !== projectId) {
        return { ok: false, error: 'missão não encontrada neste universo' }
      }
      const result = ctx.plans.linkMission(
        planId,
        itemId,
        missionId,
        expected(expectedUpdatedAt)
      )
      if (result.ok) changed(projectId)
      return result
    }
  )
}

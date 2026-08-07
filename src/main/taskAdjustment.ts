import type { Mission } from './missions'
import type { MissionRiskSurface } from './orchestratorFlow'
import type {
  Task,
  TaskPhaseResume,
  TaskPhaseSessions,
  TaskPlan,
  TaskVerification
} from './tasks'

const MAX_ADJUSTMENT_LENGTH = 1_200
const ADJUSTMENT_HEADING = 'AJUSTE PEQUENO PÓS-ENTREGA (mesmo card)'

/**
 * A post-delivery adjustment may reuse the approved plan only while it stays
 * inside the exact risk-surface set the user saw. This comparison is
 * deliberately independent from risk-level escalation: a HIGH plan can still
 * acquire a new MEDIUM surface and must be presented again.
 */
export function unapprovedAdjustmentRiskSurfaces(
  detected: readonly MissionRiskSurface[],
  approved: readonly string[] = []
): MissionRiskSurface[] {
  const approvedSet = new Set(approved)
  return [...new Set(detected)].filter((surface) => !approvedSet.has(surface))
}

export interface TaskAdjustmentRequest {
  reason: string
  integrationQueued: boolean
  /** true quando a verificação conjunta do plano está atualmente BLOQUEADA —
   *  o chamador calcula do estado persistido da verificação. Abre a válvula
   *  sancionada: card done pode ser reaberto como remediação (dev → gates
   *  integrais de novo) mesmo com o plano não concluído. Caso real 05/08
   *  00:25-00:45: verificação bloqueada + create_tasks recusado (orçamento) +
   *  adjustment recusado ("plano não concluído") = beco sem saída total que
   *  só um restart afortunado destravou. Beco sem saída é bug, não rigor. */
  verificationBlocked?: boolean
  task: Pick<
    Task,
    | 'id'
    | 'projectId'
    | 'missionId'
    | 'planId'
    | 'kind'
    | 'deliverable'
    | 'status'
    | 'feedback'
    | 'briefing'
    | 'verification'
    | 'phaseResume'
    | 'phaseSessions'
  >
  planTask: Pick<
    Task,
    'id' | 'projectId' | 'missionId' | 'kind' | 'status' | 'plan'
  >
  mission: Pick<Mission, 'id' | 'projectId' | 'status'>
}

export interface TaskAdjustmentPatches {
  taskId: string
  planTaskId: string
  task: {
    status: 'backlog'
    effort: 'leve'
    cycles: 0
    delegation: 'none'
    agents: []
    skills: []
    quests: [string]
    activePhase: 'dev'
    phaseState: 'interrupted'
    phaseStartedAt: undefined
    phaseResume: TaskPhaseResume | undefined
    phaseSessions: TaskPhaseSessions | undefined
    integrationReceipt: undefined
    verification: Pick<TaskVerification, 'contractVersion'>
    adjustment: { reason: string }
    feedback: string
    briefing: string
  }
  planTask: {
    status: 'execucao'
    plan: TaskPlan
  }
}

export type TaskAdjustmentDecision =
  | { ok: true; reason: string; patches: TaskAdjustmentPatches }
  | {
      ok: false
      code:
        | 'invalid_reason'
        | 'reason_too_long'
        | 'invalid_task'
        | 'plan_mismatch'
        | 'plan_not_completed'
        | 'mission_not_active'
        | 'integration_queued'
      message: string
    }

function appendAdjustment(current: string | undefined, reason: string): string {
  const block = `${ADJUSTMENT_HEADING}:\n${reason}`
  const existing = current?.trim()
  return existing ? `${existing}\n\n${block}` : block
}

function withoutCompletedPlanState(plan: TaskPlan): TaskPlan {
  const { conclusion: _conclusion, verification, ...openPlan } = plan
  const manualValidationWasRequired =
    plan.manualSecurityValidationRequired === true ||
    plan.manualSecurityValidation?.required === true
  const reopenedPlan: TaskPlan = {
    ...openPlan,
    // A decisão humana descrevia a entrega anterior. Qualquer ajuste reabre
    // também este gate para que uma aprovação antiga nunca libere código novo.
    ...(manualValidationWasRequired
      ? { manualSecurityValidation: { required: true, status: 'pending' } }
      : {})
  }
  if (!verification?.baseline) return reopenedPlan

  return {
    ...reopenedPlan,
    verification: { baseline: verification.baseline }
  }
}

function completedPlan(task: TaskAdjustmentRequest['planTask']): boolean {
  if (task.status === 'done') return true
  return task.status === 'execucao' && Boolean(task.plan?.conclusion?.trim())
}

/**
 * Decide se um ajuste pequeno pode reabrir o card que entregou o trabalho e,
 * quando pode, devolve apenas os patches a persistir. A função não lê relógio,
 * disco ou estado global: a mesma entrada sempre produz a mesma decisão.
 */
export function prepareTaskAdjustment(
  input: TaskAdjustmentRequest
): TaskAdjustmentDecision {
  const reason = input.reason.trim()
  if (!reason) {
    return {
      ok: false,
      code: 'invalid_reason',
      message: 'Explique o ajuste pequeno antes de reabrir o card.'
    }
  }
  if (Array.from(reason).length > MAX_ADJUSTMENT_LENGTH) {
    return {
      ok: false,
      code: 'reason_too_long',
      message: `O ajuste deve ter no máximo ${MAX_ADJUSTMENT_LENGTH} caracteres.`
    }
  }

  const { task, planTask, mission } = input
  if (
    task.kind === 'plan' ||
    task.deliverable !== 'code' ||
    task.status !== 'done'
  ) {
    return {
      ok: false,
      code: 'invalid_task',
      message: 'Somente um card normal de código já concluído pode ser reaberto.'
    }
  }

  if (
    !task.planId ||
    task.planId !== planTask.id ||
    planTask.kind !== 'plan' ||
    !planTask.plan ||
    !task.missionId ||
    task.missionId !== mission.id ||
    planTask.missionId !== mission.id ||
    task.projectId !== mission.projectId ||
    planTask.projectId !== mission.projectId
  ) {
    return {
      ok: false,
      code: 'plan_mismatch',
      message: 'O card, seu plano e sua missão não formam a mesma entrega.'
    }
  }

  if (!completedPlan(planTask) && !input.verificationBlocked) {
    return {
      ok: false,
      code: 'plan_not_completed',
      message:
        'O plano correspondente ainda não foi concluído. Exceção única: quando a verificação conjunta do plano está BLOQUEADA, o ajuste é aceito como remediação sancionada (dev → gates integrais de novo).'
    }
  }

  if (mission.status !== 'ativa') {
    return {
      ok: false,
      code: 'mission_not_active',
      message: 'A missão precisa continuar ativa para reabrir este card.'
    }
  }

  if (input.integrationQueued) {
    return {
      ok: false,
      code: 'integration_queued',
      message: 'A missão já entrou na fila de integração e não pode mudar agora.'
    }
  }

  const phaseSessions = task.phaseSessions
    ? { ...task.phaseSessions }
    : undefined
  const devResume = phaseSessions?.dev ??
    (task.phaseResume?.phase === 'dev' ? task.phaseResume : undefined)

  return {
    ok: true,
    reason,
    patches: {
      taskId: task.id,
      planTaskId: planTask.id,
      task: {
        status: 'backlog',
        effort: 'leve',
        cycles: 0,
        delegation: 'none',
        agents: [],
        skills: [],
        quests: [reason],
        activePhase: 'dev',
        phaseState: 'interrupted',
        phaseStartedAt: undefined,
        phaseResume: devResume,
        phaseSessions,
        integrationReceipt: undefined,
        verification: {
          contractVersion: task.verification?.contractVersion ?? 1
        },
        adjustment: { reason },
        feedback: appendAdjustment(task.feedback, reason),
        briefing: appendAdjustment(task.briefing, reason)
      },
      planTask: {
        status: 'execucao',
        plan: withoutCompletedPlanState(planTask.plan)
      }
    }
  }
}

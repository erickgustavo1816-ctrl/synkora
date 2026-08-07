import assert from 'node:assert/strict'
import test from 'node:test'
import {
  prepareTaskAdjustment,
  unapprovedAdjustmentRiskSurfaces
} from '../src/main/taskAdjustment.ts'

const devSession = {
  phase: 'dev',
  sessionId: 'dev-session',
  seatId: 'seat-dev',
  cli: 'claude',
  capturedAt: '2026-08-01T10:00:00.000Z'
}

const validRequest = (overrides = {}) => ({
  reason: 'Diminuir a altura do header em 8 px.',
  integrationQueued: false,
  task: {
    id: 'card-code',
    projectId: 'project-1',
    missionId: 'mission-1',
    planId: 'plan-1',
    deliverable: 'code',
    status: 'done',
    feedback: 'Entrega original aprovada.',
    briefing: 'Construir o header.',
    verification: {
      contractVersion: 1,
      dev: { reportedAt: '2026-08-01T10:30:00.000Z' },
      review: {
        phase: 'review',
        verdict: 'approved',
        startedAt: '2026-08-01T10:31:00.000Z',
        finishedAt: '2026-08-01T10:32:00.000Z',
        readonly: true
      }
    },
    phaseSessions: {
      dev: devSession,
      review: {
        phase: 'review',
        sessionId: 'review-session',
        seatId: 'seat-review',
        cli: 'codex',
        capturedAt: '2026-08-01T10:31:00.000Z'
      }
    }
  },
  planTask: {
    id: 'plan-1',
    projectId: 'project-1',
    missionId: 'mission-1',
    kind: 'plan',
    status: 'done',
    plan: {
      summary: 'Plano aprovado',
      lanes: [],
      conclusion: 'Tudo entregue.',
      verification: {
        baseline: {
          status: 'passed',
          startedAt: '2026-08-01T09:00:00.000Z',
          finishedAt: '2026-08-01T09:01:00.000Z',
          commands: []
        },
        final: {
          status: 'passed',
          startedAt: '2026-08-01T10:40:00.000Z',
          finishedAt: '2026-08-01T10:41:00.000Z',
          commands: []
        }
      }
    }
  },
  mission: {
    id: 'mission-1',
    projectId: 'project-1',
    status: 'ativa'
  },
  ...overrides
})

test('reabre o mesmo card em modo leve e preserva a conversa do dev', () => {
  const decision = prepareTaskAdjustment(validRequest())

  assert.equal(decision.ok, true)
  assert.equal(decision.patches.taskId, 'card-code')
  assert.equal(decision.patches.planTaskId, 'plan-1')
  assert.deepEqual(
    {
      status: decision.patches.task.status,
      effort: decision.patches.task.effort,
      cycles: decision.patches.task.cycles,
      delegation: decision.patches.task.delegation,
      agents: decision.patches.task.agents,
      skills: decision.patches.task.skills,
      quests: decision.patches.task.quests,
      activePhase: decision.patches.task.activePhase,
      phaseState: decision.patches.task.phaseState
    },
    {
      status: 'backlog',
      effort: 'leve',
      cycles: 0,
      delegation: 'none',
      agents: [],
      skills: [],
      quests: ['Diminuir a altura do header em 8 px.'],
      activePhase: 'dev',
      phaseState: 'interrupted'
    }
  )
  assert.equal(decision.patches.task.phaseResume, devSession)
  assert.deepEqual(decision.patches.task.phaseSessions, validRequest().task.phaseSessions)
  assert.equal(decision.patches.task.integrationReceipt, undefined)
  assert.equal(decision.patches.task.phaseStartedAt, undefined)
})

test('zera evidências antigas, reabre o plano e mantém apenas a baseline', () => {
  const decision = prepareTaskAdjustment(validRequest())

  assert.equal(decision.ok, true)
  assert.deepEqual(decision.patches.task.verification, { contractVersion: 1 })
  assert.equal(decision.patches.planTask.status, 'execucao')
  assert.equal('conclusion' in decision.patches.planTask.plan, false)
  assert.equal(decision.patches.planTask.plan.verification?.final, undefined)
  assert.equal(
    decision.patches.planTask.plan.verification?.baseline?.status,
    'passed'
  )
})

test('ajuste invalida a validação humana da entrega anterior', () => {
  const request = validRequest()
  request.planTask.plan.manualSecurityValidationRequired = true
  request.planTask.plan.manualSecurityValidation = {
    required: true,
    status: 'approved',
    actor: 'user',
    resolvedAt: '2026-08-01T10:42:00.000Z',
    evidence: 'Entrega original conferida em ambiente de teste.'
  }

  const decision = prepareTaskAdjustment(request)

  assert.equal(decision.ok, true)
  assert.deepEqual(decision.patches.planTask.plan.manualSecurityValidation, {
    required: true,
    status: 'pending'
  })
})

test('grava o ajuste normalizado no feedback e no briefing', () => {
  const decision = prepareTaskAdjustment(
    validRequest({ reason: '  Reduzir o espaçamento lateral.  ' })
  )

  assert.equal(decision.ok, true)
  assert.equal(decision.reason, 'Reduzir o espaçamento lateral.')
  assert.match(decision.patches.task.feedback, /Entrega original aprovada\./)
  assert.match(decision.patches.task.feedback, /AJUSTE PEQUENO PÓS-ENTREGA/)
  assert.match(decision.patches.task.feedback, /Reduzir o espaçamento lateral\./)
  assert.match(decision.patches.task.briefing, /Construir o header\./)
  assert.match(decision.patches.task.briefing, /Reduzir o espaçamento lateral\./)
})

test('aceita plano em execução que já possui conclusão', () => {
  const request = validRequest()
  request.planTask.status = 'execucao'

  const decision = prepareTaskAdjustment(request)
  assert.equal(decision.ok, true)
})

test('recusa motivo vazio ou acima de 1200 caracteres', () => {
  assert.deepEqual(
    prepareTaskAdjustment(validRequest({ reason: '   ' })),
    {
      ok: false,
      code: 'invalid_reason',
      message: 'Explique o ajuste pequeno antes de reabrir o card.'
    }
  )
  assert.equal(
    prepareTaskAdjustment(validRequest({ reason: 'a'.repeat(1_201) })).code,
    'reason_too_long'
  )
  assert.equal(
    prepareTaskAdjustment(validRequest({ reason: 'a'.repeat(1_200) })).ok,
    true
  )
})

test('recusa card que não seja código normal concluído', () => {
  for (const taskPatch of [
    { status: 'execucao' },
    { deliverable: 'non_code' },
    { kind: 'plan' }
  ]) {
    const request = validRequest()
    Object.assign(request.task, taskPatch)
    assert.equal(prepareTaskAdjustment(request).code, 'invalid_task')
  }
})

test('recusa plano não correspondente ou ainda aberto', () => {
  const mismatch = validRequest()
  mismatch.task.planId = 'outro-plano'
  assert.equal(prepareTaskAdjustment(mismatch).code, 'plan_mismatch')

  const openPlan = validRequest()
  openPlan.planTask.status = 'execucao'
  delete openPlan.planTask.plan.conclusion
  assert.equal(prepareTaskAdjustment(openPlan).code, 'plan_not_completed')
})

test('recusa missão fora do estado ativo ou já na fila de integração', () => {
  const completedMission = validRequest()
  completedMission.mission.status = 'integrando'
  assert.equal(
    prepareTaskAdjustment(completedMission).code,
    'mission_not_active'
  )

  assert.equal(
    prepareTaskAdjustment(validRequest({ integrationQueued: true })).code,
    'integration_queued'
  )
})

test('é pura: não altera task, plano ou sessões recebidos', () => {
  const request = validRequest()
  const before = structuredClone(request)

  const decision = prepareTaskAdjustment(request)

  assert.equal(decision.ok, true)
  assert.deepEqual(request, before)
  assert.notEqual(decision.patches.task.phaseSessions, request.task.phaseSessions)
  assert.notEqual(decision.patches.planTask.plan, request.planTask.plan)
})

test('qualquer superfície nova exige reapresentar o plano, mesmo sem elevar o risco', () => {
  assert.deepEqual(
    unapprovedAdjustmentRiskSurfaces(
      ['authentication', 'logging_errors', 'public_contract', 'logging_errors'],
      ['authentication']
    ),
    ['logging_errors', 'public_contract']
  )
  assert.deepEqual(
    unapprovedAdjustmentRiskSurfaces(['authentication'], ['authentication', 'secrets']),
    []
  )
})

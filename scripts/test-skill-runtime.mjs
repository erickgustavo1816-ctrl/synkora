import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillRuntime } from '../src/main/skillRuntime.ts'

function fixture() {
  let receipt = 0
  let time = 0
  const runtime = new SkillRuntime({
    receiptId: () => `receipt-${++receipt}`,
    now: () => new Date(Date.parse('2026-08-07T12:00:00.000Z') + time++ * 1_000)
  })
  return { runtime }
}

const scope = Object.freeze({ paneId: 'pane-a', phase: 'dev', phaseRun: 'run-1' })

function planTwo(runtime) {
  const result = runtime.planPane({
    ...scope,
    skills: [
      {
        skillId: 'impeccable',
        operation: 'adapt',
        version: 'git:v1',
        fingerprint: 'sha256:impeccable-v1',
        reason: 'ui.responsive',
        required: true,
        // Extra caller data must never enter the safe ledger.
        body: 'SKILL BODY SENTINEL',
        prompt: 'PROMPT SENTINEL',
        path: 'C:/PRIVATE/PATH/SENTINEL'
      },
      {
        skillId: 'react-best-practices',
        operation: 'review',
        version: 'git:v2',
        fingerprint: 'sha256:react-v2',
        reason: 'code.react',
        required: false
      }
    ]
  })
  assert.equal(result.ok, true)
  return result.plan.receipts
}

test('plans opaque receipts and emits a control-plane-only safe snapshot', () => {
  const { runtime } = fixture()
  const receipts = planTwo(runtime)
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].receiptId, 'receipt-1')
  assert.equal(receipts[0].receiptId.includes(receipts[0].skillId), false)
  assert.equal(receipts[0].version, 'git:v1')
  assert.equal(receipts[0].fingerprint, 'sha256:impeccable-v1')

  const serialized = JSON.stringify(runtime.safeSnapshot())
  assert.doesNotMatch(serialized, /SKILL BODY SENTINEL/)
  assert.doesNotMatch(serialized, /PROMPT SENTINEL/)
  assert.doesNotMatch(serialized, /PRIVATE\/PATH/)
  assert.deepEqual(Object.keys(receipts[0]).sort(), [
    'fingerprint',
    'operation',
    'plannedAt',
    'reason',
    'receiptId',
    'required',
    'skillId',
    'version'
  ])
})

test('package version and fingerprint are immutable parts of the active plan', () => {
  const { runtime } = fixture()
  const input = {
    ...scope,
    skills: [{
      skillId: 'impeccable',
      operation: 'adapt',
      version: 'git:v1',
      fingerprint: 'sha256:impeccable-v1',
      reason: 'ui.responsive',
      required: true
    }]
  }
  assert.equal(runtime.planPane(input).ok, true)
  assert.deepEqual(
    runtime.planPane({
      ...input,
      skills: [{
        ...input.skills[0],
        version: 'git:v2',
        fingerprint: 'sha256:impeccable-v2'
      }]
    }),
    {
      ok: false,
      code: 'plan_conflict',
      message: 'pane already has a different active skill plan'
    }
  )
})

test('same pane plan is idempotent, while a different active plan conflicts', () => {
  const { runtime } = fixture()
  const input = {
    ...scope,
    skills: [
      {
        skillId: 'impeccable',
        operation: 'adapt',
        version: 'git:v1',
        fingerprint: 'sha256:impeccable-v1',
        reason: 'ui.responsive',
        required: true
      }
    ]
  }
  const first = runtime.planPane(input)
  const repeated = runtime.planPane(input)
  assert.equal(first.ok, true)
  assert.equal(repeated.ok, true)
  assert.equal(repeated.idempotent, true)
  assert.equal(repeated.plan.receipts[0].receiptId, first.plan.receipts[0].receiptId)

  const conflict = runtime.planPane({
    ...input,
    skills: [{ ...input.skills[0], operation: 'critique' }]
  })
  assert.deepEqual(conflict, {
    ok: false,
    code: 'plan_conflict',
    message: 'pane already has a different active skill plan'
  })
})

test('renewal keeps the old receipts when durable persistence fails', () => {
  const { runtime } = fixture()
  const [oldReceipt] = planTwo(runtime)
  const replacement = runtime.replacePanePlan(
    {
      paneId: scope.paneId,
      phase: scope.phase,
      phaseRun: 'run-2',
      expectedPhase: scope.phase,
      expectedPhaseRun: scope.phaseRun,
      skills: [
        {
          skillId: 'impeccable',
          operation: 'adapt',
          version: 'git:v1',
          fingerprint: 'sha256:impeccable-v1',
          reason: 'ui.responsive',
          required: true
        }
      ]
    },
    {
      commit: () => {
        throw new Error('disk unavailable')
      },
      rollback: () => {
        assert.fail('nothing was durably committed, so rollback must not run')
      }
    }
  )
  assert.equal(replacement.ok, false)
  assert.equal(replacement.code, 'durable_commit_failed')
  const snapshot = runtime.safeSnapshot().plans[0]
  assert.equal(snapshot.phaseRun, scope.phaseRun)
  assert.equal(snapshot.receipts[0].receiptId, oldReceipt.receiptId)
  assert.equal(runtime.resolve({ ...scope, receiptId: oldReceipt.receiptId }).ok, true)
})

test('renewal persists one snapshot before atomically expiring the old receipts', () => {
  const { runtime } = fixture()
  const [oldReceipt] = planTwo(runtime)
  let durableRun = scope.phaseRun
  const replacement = runtime.replacePanePlan(
    {
      paneId: scope.paneId,
      phase: scope.phase,
      phaseRun: 'run-2',
      expectedPhase: scope.phase,
      expectedPhaseRun: scope.phaseRun,
      skills: [
        {
          skillId: 'impeccable',
          operation: 'polish',
          version: 'git:v2',
          fingerprint: 'sha256:impeccable-v2',
          reason: 'ui.polish',
          required: true
        }
      ]
    },
    {
      commit: (previous, next) => {
        assert.equal(runtime.safeSnapshot().plans[0].phaseRun, previous.phaseRun)
        durableRun = next.phaseRun
      },
      rollback: (previous) => {
        durableRun = previous.phaseRun
      }
    }
  )
  assert.equal(replacement.ok, true)
  assert.equal(durableRun, 'run-2')
  assert.equal(runtime.safeSnapshot().plans[0].phaseRun, 'run-2')
  assert.equal(
    runtime.resolve({ ...scope, receiptId: oldReceipt.receiptId }).code,
    'receipt_not_planned'
  )
  const nextReceipt = replacement.plan.receipts[0]
  assert.equal(
    runtime.resolve({ ...scope, phaseRun: 'run-2', receiptId: nextReceipt.receiptId }).ok,
    true
  )
})

test('activation accepts only a planned receipt bound to the same pane, phase and phaseRun', () => {
  const { runtime } = fixture()
  const [planned] = planTwo(runtime)

  assert.equal(
    runtime.activate({ ...scope, paneId: 'pane-b', receiptId: planned.receiptId }).code,
    'pane_mismatch'
  )
  assert.equal(
    runtime.activate({ ...scope, phase: 'qa', receiptId: planned.receiptId }).code,
    'phase_mismatch'
  )
  assert.equal(
    runtime.activate({ ...scope, phaseRun: 'run-2', receiptId: planned.receiptId }).code,
    'phase_run_mismatch'
  )
  assert.deepEqual(runtime.activate({ ...scope, receiptId: 'receipt-never-planned' }), {
    ok: false,
    code: 'receipt_not_planned',
    message: 'skill receipt is not planned or is no longer active'
  })
})

test('resolve validates the receipt without claiming activation before package delivery', () => {
  const { runtime } = fixture()
  const [planned] = planTwo(runtime)

  const resolved = runtime.resolve({ ...scope, receiptId: planned.receiptId })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.idempotent, false)
  assert.equal(resolved.receipt.activatedAt, undefined)
  assert.equal(runtime.safeSnapshot().plans[0].receipts[0].activatedAt, undefined)

  const activated = runtime.activate({ ...scope, receiptId: planned.receiptId })
  assert.equal(activated.ok, true)
  assert.equal(typeof activated.receipt.activatedAt, 'string')
  const resolvedAgain = runtime.resolve({ ...scope, receiptId: planned.receiptId })
  assert.equal(resolvedAgain.ok, true)
  assert.equal(resolvedAgain.idempotent, true)
  assert.equal(resolvedAgain.receipt.activatedAt, activated.receipt.activatedAt)
})

test('duplicate activation is idempotent and preserves the original timestamp', () => {
  const { runtime } = fixture()
  const [planned] = planTwo(runtime)
  const first = runtime.activate({ ...scope, receiptId: planned.receiptId })
  const second = runtime.activate({ ...scope, receiptId: planned.receiptId })
  assert.equal(first.ok, true)
  assert.equal(first.idempotent, false)
  assert.equal(second.ok, true)
  assert.equal(second.idempotent, true)
  assert.equal(second.receipt.activatedAt, first.receipt.activatedAt)
})

test('report guard requires every required receipt to be activated and declared', () => {
  const { runtime } = fixture()
  const [required, optional] = planTwo(runtime)

  const empty = runtime.guardReport({ ...scope, skillApplications: [] })
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.missingActivated, [required.receiptId])
  assert.deepEqual(empty.missingDeclared, [required.receiptId])

  runtime.activate({ ...scope, receiptId: required.receiptId })
  const notDeclared = runtime.guardReport({ ...scope, skillApplications: [] })
  assert.equal(notDeclared.ok, false)
  assert.deepEqual(notDeclared.missingActivated, undefined)
  assert.deepEqual(notDeclared.missingDeclared, [required.receiptId])

  const optionalNotActivated = runtime.guardReport({
    ...scope,
    skillApplications: [required.receiptId, optional.receiptId]
  })
  assert.equal(optionalNotActivated.ok, false)
  assert.deepEqual(optionalNotActivated.unactivatedApplications, [optional.receiptId])

  const complete = runtime.guardReport({
    ...scope,
    skillApplications: [required.receiptId, required.receiptId]
  })
  assert.deepEqual(complete, {
    ok: true,
    skillApplications: [required.receiptId],
    requiredReceipts: [required.receiptId]
  })
})

test('report refuses a receipt that was never planned for the pane', () => {
  const { runtime } = fixture()
  const [required] = planTwo(runtime)
  runtime.activate({ ...scope, receiptId: required.receiptId })
  const guarded = runtime.guardReport({
    ...scope,
    skillApplications: [required.receiptId, 'receipt-never-planned']
  })
  assert.equal(guarded.ok, false)
  assert.deepEqual(guarded.unknownApplications, ['receipt-never-planned'])
})

test('pane sem plano aceita relatório vazio, mas rejeita receipt inventado', () => {
  const { runtime } = fixture()
  assert.deepEqual(runtime.guardReport(scope), {
    ok: true,
    skillApplications: [],
    requiredReceipts: []
  })
  const invented = runtime.guardReport({
    ...scope,
    skillApplications: ['receipt-never-planned', 'receipt-never-planned']
  })
  assert.equal(invented.ok, false)
  assert.deepEqual(invented.unknownApplications, ['receipt-never-planned'])
})

test('accepted report stamps only declared activated receipts and is idempotent', () => {
  const { runtime } = fixture()
  const [required, optional] = planTwo(runtime)
  runtime.activate({ ...scope, receiptId: required.receiptId })
  runtime.activate({ ...scope, receiptId: optional.receiptId })

  const accepted = runtime.acceptReport({
    ...scope,
    skillApplications: [required.receiptId]
  })
  assert.equal(accepted.ok, true)
  const afterFirst = runtime.safeSnapshot().plans[0].receipts
  assert.equal(typeof afterFirst[0].appliedAt, 'string')
  assert.equal(afterFirst[1].appliedAt, undefined)

  runtime.acceptReport({ ...scope, skillApplications: [required.receiptId] })
  const afterSecond = runtime.safeSnapshot().plans[0].receipts
  assert.equal(afterSecond[0].appliedAt, afterFirst[0].appliedAt)
})

test('release is scoped, removes receipts and is idempotent after success', () => {
  const { runtime } = fixture()
  const receipts = planTwo(runtime)

  assert.equal(runtime.release({ ...scope, phase: 'qa' }).code, 'phase_mismatch')
  assert.equal(runtime.release({ ...scope, phaseRun: 'run-2' }).code, 'phase_run_mismatch')
  assert.deepEqual(runtime.release(scope), {
    ok: true,
    released: true,
    receiptCount: receipts.length
  })
  assert.deepEqual(runtime.safeSnapshot(), { contractVersion: 1, plans: [] })
  assert.equal(
    runtime.activate({ ...scope, receiptId: receipts[0].receiptId }).code,
    'receipt_not_planned'
  )
  assert.deepEqual(runtime.release(scope), {
    ok: true,
    released: false,
    receiptCount: 0
  })
})

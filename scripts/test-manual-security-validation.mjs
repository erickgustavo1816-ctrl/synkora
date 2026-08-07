import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
const {
  initialManualSecurityValidation,
  manualSecurityValidationOf,
  manualSecurityValidationPending,
  resolveManualSecurityValidation
} = await import(
  new URL('../.tmp/manual-security-validation-test/manualSecurityValidation.js', import.meta.url)
)

test('planos sensiveis nascem pendentes e planos comuns nao ganham gate', () => {
  assert.deepEqual(initialManualSecurityValidation(true), {
    required: true,
    status: 'pending'
  })
  assert.deepEqual(initialManualSecurityValidation(false), {
    required: false,
    status: 'not_required'
  })
  assert.equal(
    manualSecurityValidationPending({ manualSecurityValidationRequired: true }),
    true,
    'plano legado sensivel deve falhar fechado'
  )
  assert.equal(manualSecurityValidationPending({}), false)
})

test('decisao explicita persiste ator, data e evidencia e libera o gate', () => {
  const resolvedAt = '2026-08-03T14:30:00.000Z'
  const approved = resolveManualSecurityValidation(
    { manualSecurityValidationRequired: true },
    'approved',
    'Fluxo de permissao conferido em ambiente de teste.',
    resolvedAt
  )

  assert.deepEqual(approved, {
    required: true,
    status: 'approved',
    actor: 'user',
    resolvedAt,
    evidence: 'Fluxo de permissao conferido em ambiente de teste.'
  })

  const persistedPlan = JSON.parse(
    JSON.stringify({
      manualSecurityValidationRequired: true,
      manualSecurityValidation: approved
    })
  )
  assert.deepEqual(manualSecurityValidationOf(persistedPlan), approved)
  assert.equal(manualSecurityValidationPending(persistedPlan), false)
})

test('dispensa exige justificativa e tambem fica auditavel', () => {
  assert.throws(
    () =>
      resolveManualSecurityValidation(
        { manualSecurityValidationRequired: true },
        'waived',
        'curta'
      ),
    /20 caracteres/
  )

  const waived = resolveManualSecurityValidation(
    { manualSecurityValidationRequired: true },
    'waived',
    'Nao se aplica: o dado usado e inteiramente sintetico.',
    '2026-08-03T14:31:00.000Z'
  )
  assert.equal(waived.status, 'waived')
  assert.equal(waived.actor, 'user')
  assert.equal(manualSecurityValidationPending({ manualSecurityValidation: waived }), false)
})

test('risco alto ou superficie sensivel nunca aceita dispensa nova', () => {
  assert.throws(
    () =>
      resolveManualSecurityValidation(
        {
          manualSecurityValidationRequired: true,
          risk: 'high',
          riskSurfaces: ['authorization']
        },
        'waived',
        'O fluxo foi analisado, mas ainda nao foi validado manualmente.'
      ),
    /nao pode ser dispensada/
  )
})

test('metadado incompleto nunca libera plano sensivel', () => {
  const malformed = {
    manualSecurityValidationRequired: true,
    manualSecurityValidation: {
      required: true,
      status: 'approved',
      actor: 'user',
      resolvedAt: 'data-invalida',
      evidence: 'parece preenchida'
    }
  }
  assert.deepEqual(manualSecurityValidationOf(malformed), {
    required: true,
    status: 'pending'
  })
  assert.equal(manualSecurityValidationPending(malformed), true)
})

test('dispensa legada volta a pendente quando o plano atual é sensível', () => {
  const state = manualSecurityValidationOf({
    manualSecurityValidationRequired: true,
    risk: 'high',
    riskSurfaces: ['authorization'],
    manualSecurityValidation: {
      required: true,
      status: 'waived',
      actor: 'user',
      resolvedAt: '2026-08-01T10:00:00.000Z',
      evidence: 'Dispensa registrada antes da política atual.'
    }
  })
  assert.equal(state.status, 'pending')
})

test('evidencia persistida tem segredos redigidos', () => {
  const secret = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890'
  const approved = resolveManualSecurityValidation(
    { manualSecurityValidationRequired: true },
    'approved',
    `Validado sem usar a credencial ${secret}.`,
    '2026-08-03T14:32:00.000Z'
  )
  assert.doesNotMatch(approved.evidence, new RegExp(secret))
  assert.match(approved.evidence, /\[redigido:token\]/)
})

test('backend aplica o mesmo gate na conclusao e antes da fila de integracao', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /tasks:planSecurityValidation[\s\S]*?task\.status !== 'execucao'[\s\S]*?openCards\.length > 0[\s\S]*?resolveManualSecurityValidation/
  )
  // As chamadas carregam securityWaiverOptions(projectId) desde 2026-08-04
  // (o switch "sensível ok" do projeto autoriza dispensa com justificativa);
  // o guard continua obrigatório em cada ponto.
  assert.match(
    source,
    /function closeVerifiedPlan[\s\S]*?manualSecurityValidationPending\(planTask\.plan, securityWaiverOptions\(planTask\.projectId\)\)/
  )
  assert.match(
    source,
    /concludePlan:\s*async[\s\S]*?manualSecurityValidationPending\(plan\.plan, securityWaiverOptions\(id\.projectId\)\)/
  )
  assert.match(
    source,
    /function startMissionIntegration[\s\S]*?manualSecurityValidationPending\(missionPlan\.plan, securityWaiverOptions\(mission\.projectId\)\)[\s\S]*?integrationQueue\.enqueue/
  )
})

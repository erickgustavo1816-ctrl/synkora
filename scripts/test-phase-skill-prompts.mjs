import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBasePrompt,
  buildBrowserHint,
  buildDevContract,
  buildGateRecyclePrompt,
  buildQaDeliverySnapshotBlock,
  buildVerdictRule,
  buildPhasePrompt,
  buildReviewDiffBlock
} from '../.tmp/phase-skill-prompts-test/phasePrompts.js'

test('texto do browser nunca promete uma capacidade ausente', () => {
  assert.equal(buildBrowserHint('review', true), '')
  assert.match(buildBrowserHint('dev', true), /they are available in this pane/)
  assert.match(buildBrowserHint('qa', true), /available in this read-only pane/)
  assert.match(buildBrowserHint('dev', false), /browser is unavailable/)
  assert.match(buildBrowserHint('qa', false), /browser is unavailable/)
  assert.doesNotMatch(buildBrowserHint('dev', false), /they are available in this pane/)
})

test('gate distingue bloqueio ambiental de rejeicao do produto', () => {
  const rule = buildVerdictRule('')
  assert.match(rule, /"aprovada", "reprovada" or "bloqueada"/)
  assert.match(rule, /environmental or capability failure/)
  assert.match(rule, /never a product rejection or approval/)
  assert.match(rule, /Every aprovada\/reprovada report must include verificationEvidence/)
})

const receiptBlock = '\n\nACTIVE SKILL PLAN\n- ui receiptId receipt-new REQUIRED'

function prompt(overrides = {}) {
  return buildPhasePrompt({
    phase: 'dev',
    resumed: true,
    recoveringPhase: true,
    retryingOriginalDev: false,
    logFile: '.synkora/runs/task.md',
    recoveredHelperLogs: [],
    basePrompt: 'FULL BRIEFING',
    activeSkillPlanBlock: receiptBlock,
    ...overrides
  })
}

test('resume de DEV recebe os receipts novos sem repetir o briefing completo', () => {
  const result = prompt()
  assert.match(result, /receipt-new/)
  assert.match(result, /previous process receipts are expired/i)
  assert.doesNotMatch(result, /FULL BRIEFING/)
})

test('resume de QA também recebe seu plano independente da rodada nova', () => {
  const result = prompt({
    phase: 'qa',
    gateNotes: { qa: 'validar o overlay' },
    continuationEnvironmentBlock: 'runtime ativo em http://127.0.0.1:4321; browser available'
  })
  assert.match(result, /receipt-new/)
  assert.match(result, /NEW ACTIVE SKILL PLAN/)
  assert.match(result, /validar o overlay/)
  assert.match(result, /http:\/\/127\.0\.0\.1:4321/)
  assert.doesNotMatch(result, /FULL BRIEFING/)
})

test('conversa fresca continua recebendo o briefing que já contém o plano', () => {
  const result = prompt({ resumed: false, recoveringPhase: false })
  assert.equal(result, 'FULL BRIEFING')
})

test('front técnico sem impacto visual não recebe contrato Impeccable inexistente', () => {
  const base = {
    title: 'Refatorar adapter',
    deptLabel: 'Front-end',
    department: 'front',
    executionMode: 'standard',
    executionProfileBlock: '',
    browserHint: '',
    marker: '.synkora/runs/task.done'
  }
  const technical = buildDevContract({ ...base, uiWork: false })
  const visual = buildDevContract({ ...base, uiWork: true })
  assert.doesNotMatch(technical, /UI DELIVERY CONTRACT|Impeccable operation/)
  assert.match(visual, /UI DELIVERY CONTRACT/)
  assert.match(visual, /exactly ONE Impeccable operation/)
})

test('criação de design system recebe um único método nativo e não empilha Impeccable', () => {
  const result = buildDevContract({
    title: 'Criar design system',
    deptLabel: 'Design',
    uiWork: true,
    designSystemWork: true,
    browserAvailable: true,
    executionMode: 'deep',
    executionProfileBlock: '',
    browserHint: '',
    marker: '.synkora/runs/task.done'
  })
  assert.match(result, /exactly ONE design-system creation method/)
  assert.match(result, /synkora-design-system-standard/)
  assert.match(result, /do not invoke Impeccable/)
  assert.match(result, /tokens, components, product patterns, documentation, specimen, manifest and governance/)
  assert.doesNotMatch(result, /exactly ONE Impeccable operation/)
})

test('review FAST ativa somente o plano obrigatório e não proíbe o próprio receipt', () => {
  const result = buildBasePrompt({
    phase: 'review',
    title: 'Card',
    executionMode: 'fast',
    logFile: '.synkora/runs/task.md',
    skillsBlock: '',
    agentsBlock: '',
    questBlock: '',
    devContract: '',
    workspaceMaterialsNote: '',
    atomicRoundRule: '',
    reviewDiffBlock: '',
    qaRuntimeBlock: '',
    browserHint: '',
    verdictRule: 'REPORT',
    closedListBlock: '',
    gateSkillsBlock: 'ACTIVE SKILL PLAN — synkora-review-standard receipt-review',
    gateAgentsBlock: ''
  })
  assert.match(result, /Activate only the receipts in the ACTIVE SKILL PLAN/)
  assert.match(result, /receipt-review/)
  assert.doesNotMatch(result, /load methodology skills/)
})

test('reciclo de gate usa capacidade real e nunca manda gate read-only executar git', () => {
  const reviewEvidence = buildReviewDiffBlock({
    delivered: {
      baseHead: 'a'.repeat(40),
      head: 'b'.repeat(40),
      changedPaths: ['src/app.ts']
    },
    evidence: {
      text: 'RESUMO\nsrc/app.ts',
      truncated: true,
      mode: 'local',
      artifactAvailable: true
    }
  })
  const review = buildGateRecyclePrompt({
    phase: 'review',
    renewedSkillsBlock: 'ACTIVE SKILL PLAN',
    devHead: 'b'.repeat(40),
    rejectedHead: 'a'.repeat(40),
    rejectionReason: 'corrigir contrato',
    deltaEvidenceBlock: reviewEvidence,
    uiWork: false,
    browserAvailable: false
  })
  assert.match(review, /read_review_evidence/)
  assert.match(review, /gate-private storage \(ready\)/)
  assert.doesNotMatch(review, /\.synkora\/runs/)
  assert.doesNotMatch(review, /git --no-pager|git diff/)
  assert.match(review, /bloqueada/)

  const technicalQa = buildGateRecyclePrompt({
    phase: 'qa',
    renewedSkillsBlock: 'ACTIVE SKILL PLAN',
    rejectionReason: 'validar adapter',
    uiWork: false,
    browserAvailable: false
  })
  assert.doesNotMatch(technicalQa, /visual pass|Start the product|rendered surfaces/)

  const unavailableUiQa = buildGateRecyclePrompt({
    phase: 'qa',
    renewedSkillsBlock: 'ACTIVE SKILL PLAN',
    rejectionReason: 'validar responsividade',
    uiWork: true,
    browserAvailable: false
  })
  assert.match(unavailableUiQa, /browser is unavailable/)
  assert.match(unavailableUiQa, /report "bloqueada"/)
  assert.doesNotMatch(unavailableUiQa, /runtime_control/)
})

test('gates recebem o contrato inteiro e o QA enxerga todos os changed paths', () => {
  const tailCriterion = 'CRITERIO-CRITICO-DEPOIS-DO-LIMITE'
  const briefing = `${'x'.repeat(6100)}${tailCriterion}`
  for (const phase of ['review', 'qa']) {
    const result = buildBasePrompt({
      phase,
      title: 'Card extenso',
      briefing,
      executionMode: 'standard',
      logFile: '.synkora/runs/task.md',
      skillsBlock: '',
      agentsBlock: '',
      questBlock: '',
      devContract: '',
      workspaceMaterialsNote: '',
      atomicRoundRule: '',
      reviewDiffBlock: '',
      qaDeliverySnapshotBlock: '',
      qaRuntimeBlock: '',
      browserHint: '',
      verdictRule: 'REPORT',
      closedListBlock: '',
      gateSkillsBlock: '',
      gateAgentsBlock: ''
    })
    assert.match(result, new RegExp(tailCriterion))
  }

  const paths = Array.from({ length: 81 }, (_, index) => `src/surface-${index + 1}.tsx`)
  const snapshot = buildQaDeliverySnapshotBlock({
    baseHead: 'a'.repeat(40),
    head: 'b'.repeat(40),
    changedPaths: paths
  })
  assert.match(snapshot, /src\/surface-81\.tsx/)
  assert.doesNotMatch(snapshot, /\(\+1\)/)
})

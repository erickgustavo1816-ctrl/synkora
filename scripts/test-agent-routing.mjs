import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_INTENT_RULES,
  detectContextualAgentId,
  plannedAgentForHelper,
  plannedHelperCompletionProblem
} from '../src/main/agentRouting.ts'
import { BUNDLED_AGENTS } from '../src/main/agentsBundled.ts'
import { selectPhaseSkillPlan } from '../src/main/skillsRouting.ts'

const installed = new Set(BUNDLED_AGENTS.map((agent) => agent.id))

test('as 56 personas instaladas possuem uma rota explícita e nenhuma regra fantasma', () => {
  const catalog = [...installed].sort()
  const routed = [...new Set(AGENT_INTENT_RULES.map((candidate) => candidate.id))].sort()
  assert.equal(BUNDLED_AGENTS.length, 56)
  assert.deepEqual(routed, catalog)
})

test('cada frente escolhe a persona que realmente possui o subproblema', () => {
  const cases = [
    ['front', 'Refactor CSS specificity and remove !important safely.', 'css-surgeon'],
    ['front', 'Implement enter and exit animations with a coherent motion transition.', 'motion-choreographer'],
    ['front', 'Replace hardcoded colors with semantic design tokens.', 'design-token-guardian'],
    ['front', 'Audit responsive breakpoints across mobile, tablet and desktop.', 'responsive-auditor'],
    ['front', 'Design the typed API and variants for a reusable component.', 'component-architect'],
    ['front', 'Review microcopy for button labels, errors and empty states.', 'microcopy-reviewer'],
    ['front', 'Audit Core Web Vitals, LCP and INP before shipping.', 'web-perf-auditor'],
    ['front', 'Build a multi-step form with autofill and field validation.', 'form-ux-specialist'],
    ['front', 'Create a consistent SVG icon set with viewBox and currentColor.', 'svg-icon-specialist'],
    ['front', 'Implement the analytics dashboard charts, axes and tooltips.', 'dataviz-frontend'],
    ['back', 'Optimize the slow Postgres query using EXPLAIN ANALYZE.', 'sql-query-surgeon'],
    ['back', 'Create a zero-downtime schema migration and batched backfill.', 'migration-surgeon'],
    ['back', 'Protect the API contract, request and response DTOs and status codes.', 'api-contract-guardian'],
    ['back', 'Optimize the Dockerfile with a multi-stage container build.', 'container-optimizer'],
    ['back', 'Fix the failing GitHub Actions pipeline and its cold cache.', 'ci-doctor'],
    ['back', 'Add distributed tracing, structured logs and request IDs.', 'observability-instrumentor'],
    ['back', 'Fresh verification: prove the endpoint using real commands.', 'backend-reality-checker'],
    ['qa', 'Debug failing Playwright tests with test_debug.', 'playwright-test-healer'],
    ['qa', 'Write a Playwright test plan for the critical scenarios.', 'playwright-test-planner'],
    ['qa', 'Generate Playwright tests for the approved user flow.', 'playwright-test-generator'],
    ['qa', 'Diagnose flaky order-dependent tests that pass on rerun.', 'flaky-test-surgeon'],
    ['qa', 'Create a deterministic minimal repro for the intermittent bug.', 'bug-reproducer'],
    ['qa', 'Hunt the regression blast radius and collateral damage.', 'regression-hunter'],
    ['qa', 'Author the end-to-end tests for the critical user flow.', 'e2e-scenario-author'],
    ['qa', 'Verify every acceptance criterion item by item.', 'acceptance-verifier'],
    ['qa', 'Write unit and integration tests for the new behavior.', 'test-writer'],
    ['design', 'Generate image assets and a hero illustration for the product.', 'image-asset-producer'],
    ['design', 'Produce three visual mockup directions for approval.', 'mockup-artist'],
    ['design', 'Audit brand identity consistency and visual tone.', 'brand-guardian'],
    ['design', 'Produce SVG logo variants and the final wordmark.', 'svg-logo-producer'],
    ['design', 'Define the motion system and animation vocabulary.', 'motion-director'],
    ['design', 'Turn the vague “make it nicer” request into a design brief.', 'design-brief-writer'],
    ['design', 'Create a color palette in OKLCH with semantic dark-mode tokens.', 'palette-composer'],
    ['design', 'Map the multi-screen checkout UX flow and error paths.', 'ux-flow-mapper'],
    ['design', 'Produce the favicon kit, Apple touch icon and Open Graph image.', 'favicon-og-producer'],
    ['research', 'Curate recent mission reports into .synkora/CONTEXT.md.', 'context-curator'],
    ['copy', 'Rewrite the microcopy for buttons, errors and confirmation dialogs.', 'microcopy-surgeon'],
    ['copy', 'Define the brand voice and tone matrix in VOICE.md.', 'voice-guardian'],
    ['copy', 'Audit terminology drift and update the glossary PT/EN.', 'terminology-guardian'],
    ['copy', 'Write user-facing release notes from the delivered version.', 'release-notes-writer'],
    ['copy', 'Localize the i18n strings and preserve every placeholder.', 'copy-localizer'],
    ['copy', 'Review conversion copy, CTA and objections on the pricing page.', 'conversion-copy-reviewer'],
    ['data', 'Build dbt staging and marts with incremental models.', 'analytics-engineer'],
    ['data', 'Audit data quality, null rates, duplicates and freshness.', 'data-quality-sentinel'],
    ['data', 'Repair the Pandas dataframe OOM and incorrect dtypes.', 'dataframe-surgeon'],
    ['data', 'Design an A/B test with MDE, sample size and guardrails.', 'experiment-designer'],
    ['data', 'Design the event taxonomy, tracking plan and event properties.', 'event-taxonomy-designer'],
    ['data', 'Reconcile metric definitions, numerator and denominator.', 'metrics-guardian'],
    ['cyber', 'Audit a secret leak and hardcoded credentials in Git history.', 'secrets-hygiene-auditor'],
    ['cyber', 'Audit dependencies, CVEs and lockfile integrity.', 'dependency-auditor'],
    ['cyber', 'Review tenant authorization for IDOR and privilege escalation.', 'authz-reviewer'],
    ['cyber', 'Build a STRIDE threat model for file uploads and payments.', 'threat-modeler'],
    ['cyber', 'Review LGPD privacy, the PII inventory and data retention.', 'privacy-engineer'],
    ['cyber', 'Review cryptography, password hashing and static IV usage.', 'crypto-usage-reviewer'],
    ['cyber', 'Harden CSP, CSRF, CORS and file upload security.', 'web-surface-hardener'],
    ['cyber', 'Verify the confirmed security fix and prove the exploit is dead.', 'security-fix-verifier']
  ]

  assert.equal(cases.length, 56)
  for (const [department, taskText, expected] of cases) {
    assert.equal(detectContextualAgentId({ department, taskText }), expected, taskText)
  }
})

test('palavras genéricas não fabricam um especialista', () => {
  const nearMisses = [
    ['front', 'Implement a new calendar screen.'],
    ['back', 'Add a small pure utility function.'],
    ['qa', 'Update the test documentation.'],
    ['design', 'Adjust one existing spacing token in a local component.'],
    ['research', 'Compare two competitors using primary sources.'],
    ['copy', 'Fix one typo in an internal note.'],
    ['data', 'Export the already validated CSV.'],
    ['cyber', 'Rename an internal security section.']
  ]
  for (const [department, taskText] of nearMisses) {
    assert.equal(detectContextualAgentId({ department, taskText }), undefined, taskText)
  }
})

test('o orquestrador decide a necessidade; somente parallel ativa roteamento automático', () => {
  const route = (delegationMode, availableCapabilities = ['read', 'write', 'shell', 'browser']) =>
    selectPhaseSkillPlan({
      defs: BUNDLED_AGENTS,
      isInstalled: (id) => installed.has(id),
      department: 'front',
      phase: 'dev',
      taskText: 'Audit the responsive layout across mobile, tablet and desktop viewports.',
      executionMode: 'standard',
      delegationMode,
      availableCapabilities
    })

  assert.deepEqual(route('none').agentIds, [])
  assert.deepEqual(route('optional').agentIds, [])
  assert.deepEqual(route('parallel').agentIds, ['responsive-auditor'])
  assert.deepEqual(route('parallel', ['read', 'write', 'shell']).agentIds, [])
})

test('override explícito compatível vence a taxonomia, mas continua único', () => {
  const selected = selectPhaseSkillPlan({
    defs: BUNDLED_AGENTS,
    isInstalled: (id) => installed.has(id),
    department: 'front',
    phase: 'dev',
    taskText: 'Audit the responsive layout across viewports.',
    explicitAgentIds: ['component-architect', 'responsive-auditor'],
    executionMode: 'standard',
    delegationMode: 'parallel',
    availableCapabilities: ['read', 'write', 'shell', 'browser']
  })
  assert.deepEqual(selected.agentIds, ['component-architect'])
})

test('done prova tanto o paralelismo planejado quanto a persona da mesma rodada', () => {
  const completedHelpers = new Set()
  const completedAgents = new Map()
  const common = {
    delegationMode: 'parallel',
    phaseRun: 'dev:42',
    requiredAgentId: 'form-ux-specialist',
    completedHelperPhaseRuns: completedHelpers,
    completedAgentsByPhaseRun: completedAgents
  }

  assert.match(plannedHelperCompletionProblem(common), /nenhum ajudante concluiu/)
  completedHelpers.add('dev:42')
  assert.match(plannedHelperCompletionProblem(common), /form-ux-specialist/)
  completedAgents.set('dev:42', new Set(['form-ux-specialist']))
  assert.equal(plannedHelperCompletionProblem(common), undefined)

  assert.equal(
    plannedHelperCompletionProblem({
      ...common,
      delegationMode: 'none',
      requiredAgentId: undefined,
      completedHelperPhaseRuns: new Set(),
      completedAgentsByPhaseRun: new Map()
    }),
    undefined
  )
})

test('uma persona roteada ocupa apenas um ajudante; os demais blocos ficam genéricos', () => {
  assert.equal(
    plannedAgentForHelper({
      plannedAgentId: 'responsive-auditor',
      plannedAlreadyAssigned: false
    }),
    'responsive-auditor'
  )
  assert.equal(
    plannedAgentForHelper({
      plannedAgentId: 'responsive-auditor',
      plannedAlreadyAssigned: true
    }),
    undefined
  )
  assert.equal(
    plannedAgentForHelper({
      requestedAgentId: 'responsive-auditor',
      plannedAgentId: 'responsive-auditor',
      plannedAlreadyAssigned: true
    }),
    undefined
  )
})

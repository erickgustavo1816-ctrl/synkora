const QA_STANDARD_BODY = `---
name: synkora-qa-standard
description: Mandatory Synkora contract for authoring or repairing automated tests, test harnesses, fixtures, quality checks, and verification suites. Use it on QA department DEV/helper work to translate acceptance criteria and risks into executable, deterministic evidence while selecting at most one contextual testing technique. It does not approve its own delivery and never replaces the independent QA gate.
---

# Synkora QA authoring contract

Build evidence that can genuinely disprove a broken delivery. Do not optimize
for test count, coverage percentage, snapshots, or a green command detached
from the acceptance criteria.

1. Extract the closed acceptance criteria, changed behavior and highest-risk
   failure. Turn them into a compact actor/precondition/action/oracle matrix.
2. Choose the lowest test layer that can observe the real contract. Add a
   broader layer only for a boundary that the lower layer cannot prove.
3. Establish how the test would fail for the intended defect before trusting
   the passing result. Avoid assertions that merely repeat the implementation.
4. Use deterministic, synthetic, isolated fixtures. Control time, randomness,
   ordering, external effects and cleanup where they affect the result.
5. Exercise the main success path, the largest relevant negative path and the
   state/permission boundary named by the card. Keep the matrix proportional.
6. Run the narrowest meaningful command, then the nearest affected suite.
   Preserve exact commands and outcomes without claiming checks not executed.
7. Report the test paths, covered criteria, observed failure/pass evidence and
   anything blocked by environment or authorization.

Read only the references needed for the active work:

- \`references/test-strategy.md\` for layer and scope selection.
- \`references/oracles-fixtures.md\` for assertions, fixtures and isolation.
- \`references/reliability-evidence.md\` for execution, flake and completion.

The ACTIVE SKILL PLAN may add exactly one testing technique. Use it as a
specialized procedure inside this contract, never as a second workflow.

## Boundaries

- Never weaken a product assertion, delete a test, inflate a timeout, add blind
  retries, over-mock a boundary or update a snapshot only to obtain green.
- Never use production credentials, customer data or external destructive
  effects. Prefer local, synthetic and redacted evidence.
- Never turn security validation into broad scanning or offensive activity.
- Never publish, deploy, migrate, release or mutate cloud/production.
- You author evidence; the independent gate owns the verdict.
`

const QA_TEST_STRATEGY_REFERENCE = `# Test strategy and layer selection

## Start from the contract

For each acceptance criterion, record:

- observable outcome;
- actor or caller;
- precondition and relevant state;
- operation or stimulus;
- success oracle;
- highest-value negative oracle;
- boundary that could hide a false positive.

Do not mirror every implementation branch. Cover the public behavior and the
risk that would make the delivery wrong.

## Choose the lowest sufficient layer

- Unit: deterministic transformation or state transition with no meaningful
  integration boundary.
- Component: UI behavior whose contract can be observed without a full system.
- API/integration: serialization, auth, persistence, transaction or service
  boundary.
- Contract: compatibility between independently released producer/consumer or
  an authoritative schema.
- Browser/E2E: user-visible navigation, focus, rendering, browser APIs or a
  cross-layer journey.
- Visual: composition/regression that semantic assertions cannot observe.
- Accessibility: keyboard, focus, name/role/value, zoom and assistive behavior.
- Performance/load: an explicit SLO, capacity hypothesis or regression budget.
- Security: a concrete defensive boundary in the authorized local scope.

Prefer one strong layer over duplicate assertions across every layer. Add a
second layer only when it proves a different boundary.

## Proportional matrix

At minimum include the primary path and the largest plausible failure. Add
roles, states, sizes, locales, viewports, concurrency or retries only when the
card or affected surface makes them material.
`

const QA_ORACLES_FIXTURES_REFERENCE = `# Oracles, fixtures and isolation

## Strong oracles

A strong assertion observes the product contract: returned value and error,
persisted state, emitted event, visible affordance, accessibility tree, network
effect or other externally meaningful outcome.

Weak patterns include:

- asserting a mock was called without proving the result;
- duplicating the implementation formula in the test;
- snapshots with no reviewed semantic boundary;
- accepting any truthy value or broad error;
- asserting private details that can change while behavior remains correct;
- a test that still passes when the intended failure is reintroduced.

Where practical, demonstrate a negative control: the test fails against the
known-broken condition and passes after the fix.

## Fixtures

Use the smallest realistic synthetic fixture. Name the property it represents.
Avoid copied customer payloads, secrets and production identifiers.

Control sources of nondeterminism:

- freeze or inject time;
- seed or replace randomness;
- wait on observable readiness, never arbitrary sleep;
- isolate filesystem, database and network state;
- make cleanup idempotent;
- avoid order dependence and shared mutable globals;
- test concurrency with controlled barriers when it is part of the contract.

Mock beyond the boundary under test, not through it. A persistence test that
mocks persistence or an authz test that mocks the authorization decision proves
the mock, not the product.
`

const QA_RELIABILITY_EVIDENCE_REFERENCE = `# Reliability and evidence

## Execution

Run the smallest command that can fail for the changed contract. Then run the
nearest affected suite or project check. Record command, exit, relevant count
and any environment limitation. Do not paste secrets or unbounded logs.

## Flake discipline

Treat a flaky result as a defect in synchronization, isolation, determinism or
environment modeling. Retries may help classify a flake but are not the fix.
Never increase timeout or quarantine silently. If quarantine is explicitly
authorized, preserve an owner, reason and removal condition.

## Coverage and mutation

Coverage locates unexecuted code; it does not prove assertion quality. Mutation
can test assertion strength when the cost is justified. Neither percentage is
an acceptance criterion unless the card explicitly names it.

## Completion evidence

Report:

- acceptance criterion to test-path mapping;
- primary and negative cases exercised;
- negative-control or before/after evidence when available;
- exact targeted and adjacent commands;
- pass, fail or blocked outcome;
- known gaps and why they remain.

Never claim a whole product, platform or release is tested because one card's
matrix passed.
`

const QA_INDEPENDENT_BODY = `---
name: synkora-qa-qa
description: Independent Synkora gate for reviewing test-authoring deliveries. Use it in the QA phase of QA department cards to determine whether the new or repaired tests observe the intended behavior, fail for the right defect, remain deterministic, and provide truthful execution evidence. It is read-only, does not inherit the author's testing technique, and does not rewrite tests.
---

# Independent QA for test deliveries

Judge whether the delivered tests are capable of catching the defect or
contract violation they claim to cover. A green suite is evidence, not the
verdict by itself.

1. Map the closed acceptance criteria to the changed test artifacts.
2. Inspect the observable oracle and the boundary being exercised.
3. Check that the intended broken behavior would make the test fail. Prefer a
   supplied negative control; otherwise identify the exact assertion path.
4. Audit fixture realism, isolation, cleanup, time/randomness, ordering and
   any mock that could bypass the behavior under test.
5. Compare targeted and adjacent execution evidence with the actual files and
   configuration. Do not accept invented or stale commands/results.
6. Re-check the largest negative, permission, state or regression path in the
   card. Use authorized browser/runtime evidence when available and relevant.
7. Approve only the observed scope. Reject material oracle, coverage or
   reliability failures; report blocked when essential evidence is unavailable.

Read \`references/independent-audit.md\` for the audit matrix and
\`references/verdict-evidence.md\` for evidence and verdict rules.

## Boundaries

- Read only. Do not edit tests, fixtures, snapshots or product code.
- Do not use shell, subagents, production data, secrets or external effects.
- Do not inherit or replay the DEV technique; inspect the result independently.
- Do not equate approval with complete product coverage or release clearance.
`

const QA_INDEPENDENT_AUDIT_REFERENCE = `# Independent test-delivery audit

Audit proportionally across these dimensions:

1. Traceability: every claimed criterion names an actual test or deliberate
   evidence path.
2. Oracle: assertions observe public behavior rather than mocks or private
   implementation details.
3. Sensitivity: the intended defect would make the test fail.
4. Boundaries: auth, persistence, serialization, browser, contract or other
   material integration is not mocked away.
5. Negative coverage: the largest relevant invalid, denied, empty, stale,
   concurrent or failure state is represented.
6. Determinism: time, randomness, readiness, data and cleanup cannot leak
   between runs.
7. Suite health: no assertion was weakened, snapshot blindly refreshed,
   timeout inflated or retry used to hide a defect.
8. Evidence: commands and outcomes correspond to the delivered revision.

Prioritize issues that allow a broken product to remain green. Style or test
organization is material only when it affects reliability or maintainability.
`

const QA_VERDICT_EVIDENCE_REFERENCE = `# Evidence and verdict

## Approve

Approve only when the delivered tests trace to the closed criteria, exercise
the intended boundary, contain meaningful oracles, address the largest risk and
have credible targeted/adjacent execution evidence.

## Reject

Reject when a material criterion has no executable evidence, the test cannot
fail for the intended defect, a mock bypasses the contract, nondeterminism is
introduced, assertions were weakened or supplied results contradict the files.

Return one closed list of evidence-backed defects. Do not prescribe a new test
framework unless the current one cannot express the contract.

## Block

Report blocked when the authoritative test artifact, required fixture,
delivered revision or essential authorized runtime evidence cannot be observed.
An environmental block is not a product rejection and never becomes approval.
`

export const QA_BUNDLED_SKILLS = [
  {
    id: 'synkora-qa-standard',
    kind: 'skill',
    depts: ['qa'],
    group: 'qa autoral',
    source: { repo: 'synkora/bundled', path: 'synkora-qa-standard' },
    summary:
      'Contrato nativo para autoria de testes: critérios viram evidência executável, oráculos sensíveis, fixtures determinísticas e execução rastreável.',
    hint: 'Use em DEV/ajudante de cards QA; escolha no máximo uma técnica contextual e deixe o veredito para o gate independente.',
    bundledBody: QA_STANDARD_BODY.trim() + '\n',
    bundledFiles: {
      'references/test-strategy.md': QA_TEST_STRATEGY_REFERENCE.trim() + '\n',
      'references/oracles-fixtures.md': QA_ORACLES_FIXTURES_REFERENCE.trim() + '\n',
      'references/reliability-evidence.md': QA_RELIABILITY_EVIDENCE_REFERENCE.trim() + '\n'
    },
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell'],
    adapter: 'synkora-native'
  },
  {
    id: 'synkora-qa-qa',
    kind: 'skill',
    depts: ['qa'],
    group: 'qa independente',
    source: { repo: 'synkora/bundled', path: 'synkora-qa-qa' },
    summary:
      'Gate nativo independente para testes entregues: audita traceabilidade, sensibilidade do oráculo, limites reais, determinismo e evidência.',
    hint: 'Use somente no QA de cards da função QA; é read-only e não herda a técnica usada pelo autor.',
    bundledBody: QA_INDEPENDENT_BODY.trim() + '\n',
    bundledFiles: {
      'references/independent-audit.md': QA_INDEPENDENT_AUDIT_REFERENCE.trim() + '\n',
      'references/verdict-evidence.md': QA_VERDICT_EVIDENCE_REFERENCE.trim() + '\n'
    },
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  }
]

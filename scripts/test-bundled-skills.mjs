import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  bundledBodySha,
  bundledPackageSha,
  selectStaleBundledIds
} from '../src/main/bundledSkillRevision.ts'
import { BUNDLED_SKILLS } from '../src/main/skillsBundled.ts'
import { BUNDLED_AGENTS } from '../src/main/agentsBundled.ts'
import {
  assessSkillPackage,
  skillPackageBlockMessage
} from '../src/main/skillPackageSecurity.ts'
import {
  IMPECCABLE_SKILL_ID,
  missingMandatoryUiPhaseSkills,
  skillCompatibilityIssue,
  SYNKORA_BACKEND_QA_ID,
  SYNKORA_BACKEND_STANDARD_ID,
  SYNKORA_CYBER_QA_ID,
  SYNKORA_CYBER_STANDARD_ID,
  SYNKORA_COPY_QA_ID,
  SYNKORA_COPY_STANDARD_ID,
  SYNKORA_DATA_QA_ID,
  SYNKORA_DATA_STANDARD_ID,
  SYNKORA_DESIGN_SYSTEM_QA_ID,
  SYNKORA_DESIGN_SYSTEM_STANDARD_ID,
  SYNKORA_DEVOPS_QA_ID,
  SYNKORA_DEVOPS_STANDARD_ID,
  SYNKORA_PLANNING_STANDARD_ID,
  SYNKORA_FRONTEND_STANDARD_ID,
  SYNKORA_QA_QA_ID,
  SYNKORA_QA_STANDARD_ID,
  SYNKORA_RESEARCH_QA_ID,
  SYNKORA_RESEARCH_STANDARD_ID,
  SYNKORA_REVIEW_STANDARD_ID,
  SYNKORA_RUNTIME_QA_ID,
  SYNKORA_UI_QA_ID,
  withMandatoryFrontendStandard
} from '../src/main/skillsRouting.ts'

function exactlyOne(id) {
  const matches = BUNDLED_SKILLS.filter((skill) => skill.id === id)
  assert.equal(matches.length, 1, `esperava exatamente um pacote ${id}`)
  return matches[0]
}

const standard = exactlyOne(SYNKORA_FRONTEND_STANDARD_ID)
const uiQa = exactlyOne(SYNKORA_UI_QA_ID)
const planning = exactlyOne(SYNKORA_PLANNING_STANDARD_ID)
const review = exactlyOne(SYNKORA_REVIEW_STANDARD_ID)
const runtimeQa = exactlyOne(SYNKORA_RUNTIME_QA_ID)
const designSystem = exactlyOne(SYNKORA_DESIGN_SYSTEM_STANDARD_ID)
const designSystemQa = exactlyOne(SYNKORA_DESIGN_SYSTEM_QA_ID)
const backend = exactlyOne(SYNKORA_BACKEND_STANDARD_ID)
const backendQa = exactlyOne(SYNKORA_BACKEND_QA_ID)
const devops = exactlyOne(SYNKORA_DEVOPS_STANDARD_ID)
const devopsQa = exactlyOne(SYNKORA_DEVOPS_QA_ID)
const cyber = exactlyOne(SYNKORA_CYBER_STANDARD_ID)
const cyberQa = exactlyOne(SYNKORA_CYBER_QA_ID)
const data = exactlyOne(SYNKORA_DATA_STANDARD_ID)
const dataQa = exactlyOne(SYNKORA_DATA_QA_ID)
const research = exactlyOne(SYNKORA_RESEARCH_STANDARD_ID)
const researchQa = exactlyOne(SYNKORA_RESEARCH_QA_ID)
const copy = exactlyOne(SYNKORA_COPY_STANDARD_ID)
const copyQa = exactlyOne(SYNKORA_COPY_QA_ID)
const qaStandard = exactlyOne(SYNKORA_QA_STANDARD_ID)
const qaQa = exactlyOne(SYNKORA_QA_QA_ID)

test('personas bundled declare helper phase and derive their real tool capabilities', () => {
  assert.ok(BUNDLED_AGENTS.length > 0)
  for (const agent of BUNDLED_AGENTS) {
    assert.deepEqual(agent.allowedPhases, ['helper'], agent.id)
    assert.equal(agent.requiresCapabilities?.includes('read'), true, agent.id)
  }
  for (const id of [
    'responsive-auditor',
    'e2e-scenario-author',
    'playwright-test-planner',
    'playwright-test-generator',
    'playwright-test-healer'
  ]) {
    const agent = BUNDLED_AGENTS.find((candidate) => candidate.id === id)
    assert.ok(agent, id)
    assert.equal(agent.requiresCapabilities?.includes('browser'), true, id)
    assert.deepEqual(skillCompatibilityIssue(agent, 'helper', ['read', 'write', 'shell']), {
      id,
      reason: 'capability',
      missingCapabilities: ['browser']
    })
  }
})

test('boot trata contratos e todas as personas nativas como pacotes app-owned', () => {
  assert.equal(BUNDLED_AGENTS.length, 56)
  assert.equal(BUNDLED_AGENTS.every((agent) => agent.kind === 'agent' && agent.bundledBody), true)
  const indexSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(indexSource, /appOwnedSkillPackages\s*=\s*\[\.\.\.BUNDLED_SKILLS,\s*\.\.\.BUNDLED_AGENTS\]/)
  assert.match(indexSource, /selectStaleBundledIds\(\s*appOwnedSkillPackages/)
})

function packageFiles(definition) {
  return {
    [definition.kind === 'agent' ? 'agent.md' : 'SKILL.md']: definition.bundledBody,
    ...(definition.bundledFiles ?? {})
  }
}

function materializePackage(root, definition) {
  for (const [relativePath, content] of Object.entries(packageFiles(definition))) {
    const destination = join(root, ...relativePath.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content, 'utf8')
  }
}

test('contrato de UI e QA são pacotes progressivos distintos e autocontidos', () => {
  assert.equal(standard.kind, 'skill')
  assert.deepEqual(standard.depts, ['front', 'design', 'qa'])
  assert.equal(standard.source.repo, 'synkora/bundled')
  assert.match(standard.bundledBody, /^---\nname: synkora-frontend-standard\n/)
  assert.ok(!standard.bundledBody.startsWith('\uFEFF'))
  assert.ok(standard.bundledBody.split(/\r?\n/).length <= 100)
  assert.deepEqual(Object.keys(standard.bundledFiles).sort(), [
    'references/composition.md',
    'references/evidence.md',
    'references/responsive-content.md'
  ])

  assert.equal(uiQa.kind, 'skill')
  assert.deepEqual(uiQa.depts, ['qa'])
  assert.deepEqual(uiQa.defaultFor, ['qa'])
  assert.match(uiQa.bundledBody, /^---\nname: synkora-ui-qa\n/)
  assert.ok(!uiQa.bundledBody.startsWith('\uFEFF'))
  assert.ok(uiQa.bundledBody.split(/\r?\n/).length <= 80)
  assert.deepEqual(Object.keys(uiQa.bundledFiles).sort(), [
    'references/runtime-checks.md',
    'references/visual-review.md'
  ])
})

test('design system é um método nativo completo com QA separado', () => {
  assert.deepEqual(designSystem.depts, ['design', 'front'])
  assert.deepEqual(designSystem.allowedPhases, ['dev', 'helper'])
  assert.deepEqual(designSystem.requiresCapabilities, ['read', 'write', 'shell', 'browser'])
  assert.equal(designSystem.adapter, 'synkora-native')
  assert.match(designSystem.bundledBody, /^---\nname: synkora-design-system-standard\n/)
  assert.match(designSystem.bundledBody, /five connected layers/)
  assert.match(designSystem.bundledBody, /Do not\s+invoke Impeccable/)
  assert.match(designSystem.bundledBody, /A screenshot, moodboard,\s+token list, component gallery, or DESIGN\.md alone is not a design system/)
  assert.deepEqual(Object.keys(designSystem.bundledFiles).sort(), [
    'assets/design-system-manifest.template.json',
    'references/components-patterns.md',
    'references/evidence.md',
    'references/foundations.md',
    'references/governance.md',
    'references/showcase.md',
    'scripts/validate-design-system.mjs'
  ])

  assert.deepEqual(designSystemQa.depts, ['qa'])
  assert.deepEqual(designSystemQa.allowedPhases, ['qa'])
  assert.deepEqual(designSystemQa.requiresCapabilities, ['read', 'browser'])
  assert.equal(designSystemQa.adapter, 'synkora-native')
  assert.match(designSystemQa.bundledBody, /^---\nname: synkora-design-system-qa\n/)
  assert.match(designSystemQa.bundledBody, /Do not load the creator's\s+design-system method/)
  assert.match(designSystemQa.bundledBody, /Use the manifest as a map, never as proof/)
  assert.deepEqual(Object.keys(designSystemQa.bundledFiles).sort(), [
    'references/governance-evidence.md',
    'references/specimen-runtime.md',
    'references/system-integrity.md'
  ])
})

test('Back, DevOps e Cyber têm contratos nativos e QA independentes', () => {
  const pairs = [
    {
      standard: backend,
      qa: backendQa,
      standardRefs: [
        'references/contracts-boundaries.md',
        'references/data-concurrency.md',
        'references/failure-observability.md'
      ],
      qaRefs: [
        'references/api-runtime.md',
        'references/data-failure.md',
        'references/evidence.md'
      ]
    },
    {
      standard: devops,
      qa: devopsQa,
      standardRefs: [
        'references/ci-artifacts.md',
        'references/infrastructure-containers.md',
        'references/rollout-recovery.md'
      ],
      qaRefs: [
        'references/pipeline-infrastructure.md',
        'references/recovery-evidence.md'
      ]
    },
    {
      standard: cyber,
      qa: cyberQa,
      standardRefs: [
        'references/evidence-remediation.md',
        'references/llm-mcp.md',
        'references/secrets-supply-chain.md',
        'references/trust-boundaries.md'
      ],
      qaRefs: [
        'references/agent-supply-chain.md',
        'references/authorization-data.md',
        'references/evidence.md',
        'references/remediation-verification.md'
      ]
    }
  ]

  for (const pair of pairs) {
    assert.equal(pair.standard.adapter, 'synkora-native', pair.standard.id)
    assert.deepEqual(pair.standard.allowedPhases, ['dev', 'qa', 'helper'], pair.standard.id)
    assert.deepEqual(pair.standard.requiresCapabilities, ['read'], pair.standard.id)
    assert.match(pair.standard.bundledBody, new RegExp(`^---\\nname: ${pair.standard.id}\\n`))
    assert.deepEqual(Object.keys(pair.standard.bundledFiles).sort(), pair.standardRefs.sort())

    assert.equal(pair.qa.adapter, 'synkora-native', pair.qa.id)
    assert.deepEqual(pair.qa.allowedPhases, ['qa'], pair.qa.id)
    assert.deepEqual(pair.qa.requiresCapabilities, ['read'], pair.qa.id)
    assert.match(pair.qa.bundledBody, new RegExp(`^---\\nname: ${pair.qa.id}\\n`))
    assert.deepEqual(Object.keys(pair.qa.bundledFiles).sort(), pair.qaRefs.sort())
    assert.match(pair.qa.bundledBody, /independent|independently/i, pair.qa.id)
    assert.match(pair.qa.bundledBody, /read-only|Do not edit/i, pair.qa.id)
  }

  assert.match(backend.bundledBody, /exactly one contextual backend technique/i)
  assert.match(backend.bundledFiles['references/contracts-boundaries.md'], /Authentication proves identity/)
  assert.match(backendQa.bundledFiles['references/data-failure.md'], /duplicate or competing attempt/)

  assert.match(devops.bundledBody, /Never deploy, release, mutate cloud\/production/i)
  assert.match(devops.bundledFiles['references/ci-artifacts.md'], /Build once and promote the same immutable artifact/)
  assert.match(devopsQa.bundledBody, /Never apply, deploy, destroy/i)

  assert.match(cyber.bundledBody, /Rationalizations to reject/)
  assert.match(cyber.bundledBody, /Do not inspect\s+secret values, customer data or production/i)
  assert.match(cyber.bundledFiles['references/llm-mcp.md'], /Treat model input.*as untrusted data/s)
  assert.match(cyberQa.bundledBody, /It is not a pentest, certification/i)
})

test('Data, Research e Copy tem contratos nativos e QA independentes', () => {
  const pairs = [
    {
      standard: data,
      qa: dataQa,
      standardRefs: [
        'references/analysis-validity.md',
        'references/delivery-evidence.md',
        'references/source-context.md'
      ],
      qaRefs: ['references/method-evidence.md', 'references/reconciliation.md']
    },
    {
      standard: research,
      qa: researchQa,
      standardRefs: [
        'references/claim-citation.md',
        'references/question-source-plan.md',
        'references/synthesis-uncertainty.md'
      ],
      qaRefs: ['references/source-audit.md', 'references/synthesis-audit.md']
    },
    {
      standard: copy,
      qa: copyQa,
      standardRefs: [
        'references/brief-voice-proof.md',
        'references/channel-structure.md',
        'references/clarity-consent.md'
      ],
      qaRefs: [
        'references/channel-completeness.md',
        'references/claim-voice.md',
        'references/safety-accessibility.md'
      ]
    }
  ]

  for (const pair of pairs) {
    assert.equal(pair.standard.adapter, 'synkora-native', pair.standard.id)
    assert.deepEqual(pair.standard.allowedPhases, ['dev', 'qa', 'helper'], pair.standard.id)
    assert.deepEqual(pair.standard.requiresCapabilities, ['read'], pair.standard.id)
    assert.match(pair.standard.bundledBody, new RegExp(`^---\\nname: ${pair.standard.id}\\n`))
    assert.deepEqual(Object.keys(pair.standard.bundledFiles).sort(), pair.standardRefs)

    assert.equal(pair.qa.adapter, 'synkora-native', pair.qa.id)
    assert.deepEqual(pair.qa.allowedPhases, ['qa'], pair.qa.id)
    assert.deepEqual(pair.qa.requiresCapabilities, ['read'], pair.qa.id)
    assert.match(pair.qa.bundledBody, new RegExp(`^---\\nname: ${pair.qa.id}\\n`))
    assert.deepEqual(Object.keys(pair.qa.bundledFiles).sort(), pair.qaRefs)
    assert.match(pair.qa.bundledBody, /independent|independently/i, pair.qa.id)
    assert.match(pair.qa.bundledBody, /read-only|Do not edit/i, pair.qa.id)
  }

  assert.match(data.bundledBody, /Treat every number as a claim/i)
  assert.match(data.bundledFiles['references/analysis-validity.md'], /join explosion/)
  assert.match(dataQa.bundledBody, /Reconstruct the claim independently/)

  assert.match(research.bundledBody, /Never invent a citation/)
  assert.match(research.bundledFiles['references/claim-citation.md'], /Each material factual claim/)
  assert.match(researchQa.bundledBody, /citation count/i)

  assert.match(copy.bundledBody, /Truth before persuasion/)
  assert.match(copy.bundledBody, /Do not publish, send a campaign/i)
  assert.match(copyQa.bundledBody, /not legal clearance/i)
})

test('QA autoral tem contrato nativo progressivo e gate independente dos testes', () => {
  assert.deepEqual(qaStandard.depts, ['qa'])
  assert.deepEqual(qaStandard.allowedPhases, ['dev', 'helper'])
  assert.deepEqual(qaStandard.requiresCapabilities, ['read', 'write', 'shell'])
  assert.equal(qaStandard.adapter, 'synkora-native')
  assert.match(qaStandard.bundledBody, /^---\nname: synkora-qa-standard\n/)
  assert.match(qaStandard.bundledBody, /Build evidence that can genuinely disprove a broken delivery/)
  assert.match(qaStandard.bundledBody, /The ACTIVE SKILL PLAN may add exactly one testing technique/)
  assert.match(qaStandard.bundledBody, /Never weaken a product assertion/)
  assert.match(qaStandard.bundledBody, /independent gate owns the verdict/)
  assert.deepEqual(Object.keys(qaStandard.bundledFiles).sort(), [
    'references/oracles-fixtures.md',
    'references/reliability-evidence.md',
    'references/test-strategy.md'
  ])
  assert.match(
    qaStandard.bundledFiles['references/oracles-fixtures.md'],
    /the test fails against the\s+known-broken condition/
  )
  assert.match(
    qaStandard.bundledFiles['references/reliability-evidence.md'],
    /Retries may help classify a flake but are not the fix/
  )
  assert.match(
    qaStandard.bundledFiles['references/test-strategy.md'],
    /Choose the lowest sufficient layer/
  )

  assert.deepEqual(qaQa.depts, ['qa'])
  assert.deepEqual(qaQa.allowedPhases, ['qa'])
  assert.deepEqual(qaQa.requiresCapabilities, ['read'])
  assert.equal(qaQa.adapter, 'synkora-native')
  assert.match(qaQa.bundledBody, /^---\nname: synkora-qa-qa\n/)
  assert.match(qaQa.bundledBody, /A green suite is evidence, not the\s+verdict by itself/)
  assert.match(qaQa.bundledBody, /Read only\. Do not edit tests/)
  assert.match(qaQa.bundledBody, /Do not inherit or replay the DEV technique/)
  assert.deepEqual(Object.keys(qaQa.bundledFiles).sort(), [
    'references/independent-audit.md',
    'references/verdict-evidence.md'
  ])
  assert.match(
    qaQa.bundledFiles['references/independent-audit.md'],
    /the intended defect would make the test fail/
  )
  assert.match(
    qaQa.bundledFiles['references/verdict-evidence.md'],
    /An environmental block is not a product rejection/
  )
})

test('a árvore multi-arquivo completa passa pelo gate de supply chain', (t) => {
  for (const definition of [
    standard,
    uiQa,
    designSystem,
    designSystemQa,
    backend,
    backendQa,
    devops,
    devopsQa,
    cyber,
    cyberQa,
    data,
    dataQa,
    research,
    researchQa,
    copy,
    copyQa,
    qaStandard,
    qaQa
  ]) {
    const directory = mkdtempSync(join(tmpdir(), `synkora-${definition.id}-`))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    materializePackage(directory, definition)
    const assessment = assessSkillPackage(directory)
    assert.equal(
      assessment.filesScanned,
      1 + Object.keys(definition.bundledFiles ?? {}).length,
      definition.id
    )
    assert.equal(skillPackageBlockMessage(assessment), undefined, definition.id)
  }
})

test('o entrypoint curto governa autoridade e carrega detalhes sob demanda', () => {
  const body = standard.bundledBody
  const flattened = body.replace(/\s+/g, ' ')
  for (const expected of [
    'Completion is conjunctive',
    'explicit user intent',
    'Select exactly one visual method',
    'invoke only that operation',
    'Do not open its general menu',
    'independent synkora-ui-qa skill',
    '[composition.md](references/composition.md)',
    '[responsive-content.md](references/responsive-content.md)',
    '[evidence.md](references/evidence.md)',
    'Do not report perfection'
  ]) {
    assert.ok(flattened.includes(expected), `contrato essencial ausente: ${expected}`)
  }

  assert.doesNotMatch(body, /\b(?:CAIS|REBITE)\b/)
  assert.doesNotMatch(body, /sidebar (?:must|always|is required)/i)
  assert.doesNotMatch(body, /actions? (?:must|always) (?:sit|go|stay|align) (?:on|to) the right/i)
  assert.doesNotMatch(body, /use (?:all|multiple) (?:aesthetic|visual) skills/i)

  const composition = standard.bundledFiles['references/composition.md']
  const responsive = standard.bundledFiles['references/responsive-content.md']
  const evidence = standard.bundledFiles['references/evidence.md']
  assert.match(composition, /Place an action at the smallest scope it governs/)
  assert.match(composition, /Group filters by the content they affect/)
  assert.match(composition, /Long titles may change the identity region's\s+height/)
  assert.match(composition, /Run one removal pass/)
  assert.match(responsive, /min-width: 0/)
  assert.match(responsive, /single-line ellipsis/)
  assert.match(responsive, /Truncation changes presentation, never the source value/)
  assert.match(responsive, /Every enabled control must produce the result/)
  assert.match(evidence, /Compare like for like/)
  assert.match(evidence, /Automation can reveal geometry/)
  assert.match(evidence, /It\s+cannot prove harmony/)
  assert.match(evidence, /validar com uma pessoa/)
})

test('QA permanece independente e separa veredito visual de runtime', () => {
  const body = uiQa.bundledBody
  const flattened = body.replace(/\s+/g, ' ')
  for (const expected of [
    'independent reviewer',
    'cold visual pass',
    'Do not assign a numerical beauty score',
    '[visual-review.md](references/visual-review.md)',
    '[runtime-checks.md](references/runtime-checks.md)',
    'A clean runtime pass cannot award visual harmony',
    'Never claim perfection'
  ]) {
    assert.ok(flattened.includes(expected), `contrato de QA ausente: ${expected}`)
  }
  assert.match(uiQa.bundledFiles['references/visual-review.md'], /Apply a squint test/)
  assert.match(uiQa.bundledFiles['references/visual-review.md'], /Each critical region/)
  assert.match(uiQa.bundledFiles['references/runtime-checks.md'], /Exercise representative short, long, missing/)
  assert.match(uiQa.bundledFiles['references/runtime-checks.md'], /A tool signal is a\s+hypothesis/)
  assert.match(body, /Do not modify\s+the implementation/i)
})

test('validador do design system prova estrutura e caminhos sem decidir estética', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'synkora-design-system-validator-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const packageRoot = join(project, '.runtime')
  materializePackage(packageRoot, designSystem)

  const trackedFiles = [
    'src/tokens.css',
    'src/components.tsx',
    'docs/design-system.md',
    'src/showcase.tsx',
    'docs/contributing.md',
    'docs/decisions.md'
  ]
  for (const relativePath of trackedFiles) {
    const destination = join(project, ...relativePath.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, 'tracked\n', 'utf8')
  }

  const manifest = {
    schemaVersion: 1,
    name: 'Aurora',
    version: '1.0.0',
    designThesis: 'Dense operational clarity with calm hierarchy.',
    sources: {
      tokens: ['src/tokens.css'],
      components: ['src/components.tsx'],
      documentation: ['docs/design-system.md'],
      showcase: ['src/showcase.tsx']
    },
    foundations: ['color', 'typography', 'spacing', 'radius', 'elevation', 'motion', 'breakpoints'],
    componentFamilies: [
      {
        name: 'Button',
        source: 'src/components.tsx',
        variants: ['primary'],
        states: ['default', 'focus-visible', 'disabled'],
        accessibility: 'Native button with visible focus and keyboard activation.'
      }
    ],
    patterns: [
      {
        name: 'Data review',
        source: 'src/showcase.tsx',
        states: ['loading', 'empty', 'error', 'success']
      }
    ],
    coverage: {
      themes: ['default'],
      viewports: ['compact', 'wide'],
      content: ['short', 'long', 'empty', 'localized'],
      requiredStates: ['default', 'hover', 'focus-visible', 'disabled', 'loading', 'empty', 'error', 'success']
    },
    accessibility: {
      standard: 'WCAG 2.2 AA',
      keyboard: 'Logical order and visible focus.',
      contrast: 'Every supported theme and state.'
    },
    governance: {
      owner: 'Product design',
      contributionPath: 'docs/contributing.md',
      versioning: 'Semantic versioning',
      deprecationPolicy: 'Document migration before removal.',
      decisionLogPath: 'docs/decisions.md'
    }
  }
  const manifestPath = join(project, 'design-system.manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  const validator = join(packageRoot, 'scripts', 'validate-design-system.mjs')
  const valid = spawnSync(process.execPath, [validator, 'design-system.manifest.json'], {
    cwd: project,
    encoding: 'utf8'
  })
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /structurally complete/)

  manifest.governance.decisionLogPath = '../outside.md'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  const traversal = spawnSync(process.execPath, [validator, 'design-system.manifest.json'], {
    cwd: project,
    encoding: 'utf8'
  })
  assert.equal(traversal.status, 1)
  assert.match(traversal.stderr, /must stay inside the project/)
})

test('fingerprint cobre caminhos e bytes da árvore inteira de forma determinística', () => {
  const files = standard.bundledFiles
  const reversed = Object.fromEntries(Object.entries(files).reverse())
  const sha = bundledPackageSha(standard.bundledBody, files)
  assert.match(sha, /^bundled:[a-f0-9]{64}$/)
  assert.equal(sha, bundledPackageSha(standard.bundledBody, reversed))
  assert.notEqual(sha, bundledBodySha(standard.bundledBody))
  assert.notEqual(
    sha,
    bundledPackageSha(standard.bundledBody, {
      ...files,
      'references/composition.md': `${files['references/composition.md']}changed\n`
    })
  )
  assert.notEqual(
    sha,
    bundledPackageSha(standard.bundledBody, {
      ...Object.fromEntries(
        Object.entries(files).filter(([path]) => path !== 'references/composition.md')
      ),
      'references/composition-renamed.md': files['references/composition.md']
    })
  )
  assert.notEqual(
    bundledPackageSha('same body', {}, 'SKILL.md'),
    bundledPackageSha('same body', {}, 'agent.md')
  )
})

test('revisão de bundle promove legado e qualquer referência divergente', () => {
  const sha = bundledPackageSha(standard.bundledBody, standard.bundledFiles)
  const installed = [{ id: standard.id, installed: true, sha }]
  assert.deepEqual(selectStaleBundledIds([standard], installed), [])
  assert.deepEqual(
    selectStaleBundledIds([standard], [
      { id: standard.id, installed: true, sha: bundledBodySha(standard.bundledBody) }
    ]),
    [standard.id],
    'fingerprint legado de um arquivo precisa ser promovido'
  )
  assert.deepEqual(selectStaleBundledIds([standard], installed, () => false), [standard.id])
  assert.deepEqual(selectStaleBundledIds([standard], []), [standard.id])

  const changed = {
    ...standard,
    bundledFiles: {
      ...standard.bundledFiles,
      'references/evidence.md': `${standard.bundledFiles['references/evidence.md']}changed\n`
    }
  }
  assert.deepEqual(selectStaleBundledIds([changed], installed), [standard.id])
})

test('DEV e QA de UI não conseguem pular seus contratos obrigatórios', () => {
  assert.deepEqual(withMandatoryFrontendStandard([], 'front'), [standard.id])
  assert.deepEqual(withMandatoryFrontendStandard([], 'design'), [standard.id])
  assert.deepEqual(withMandatoryFrontendStandard(['custom', standard.id], 'front'), [
    'custom',
    standard.id
  ])
  assert.deepEqual(withMandatoryFrontendStandard(['custom'], 'back'), ['custom'])

  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'front', 'dev'), [
    standard.id,
    IMPECCABLE_SKILL_ID
  ])
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([standard.id], 'front', 'dev'),
    [IMPECCABLE_SKILL_ID]
  )
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'design', 'qa'), [standard.id, uiQa.id])
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([standard.id], 'front', 'qa'),
    [uiQa.id]
  )
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([standard.id, uiQa.id], 'front', 'qa'),
    []
  )
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'design', 'dev', true, true), [
    standard.id,
    designSystem.id
  ])
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([standard.id, uiQa.id], 'design', 'qa', true, true),
    [designSystemQa.id]
  )
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'front', 'review'), [review.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'dev', false), [backend.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'qa', false), [
    backend.id,
    backendQa.id
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'dev', false, false, true), [
    devops.id
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'qa', false, false, true), [
    devops.id,
    devopsQa.id
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'cyber', 'dev', false), [cyber.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'cyber', 'qa', false), [
    cyber.id,
    cyberQa.id
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'data', 'dev', false), [data.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'data', 'qa', false), [
    data.id,
    dataQa.id
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'research', 'dev', false), [research.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'research', 'qa', false), [
    research.id,
    researchQa.id
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'copy', 'dev', false), [copy.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'copy', 'qa', false), [
    copy.id,
    copyQa.id
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'qa', 'dev', false), [qaStandard.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'qa', 'qa', false), [qaQa.id])
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([qaStandard.id], 'qa', 'dev', false),
    []
  )
  assert.deepEqual(missingMandatoryUiPhaseSkills([qaQa.id], 'qa', 'qa', false), [])
  assert.equal(planning.orchestratorDefault, true)
  assert.deepEqual(planning.allowedPhases, ['planning'])
})

test('o runtime instala, valida e entrega pacotes multi-arquivo em vez de só SKILL.md', () => {
  // Fase 1 moveu o plano de fase/ativacao para phaseEngine e mcpApi/skills —
  // as ancoras seguem o codigo (o boot de bundled continua no index).
  const indexSource = new URL('../src/main/index.ts', import.meta.url)
  const librarySource = new URL('../src/main/skillsLibrary.ts', import.meta.url)
  const phaseEngineSource = new URL('../src/main/phaseEngine.ts', import.meta.url)
  const skillsApiSource = new URL('../src/main/mcpApi/skills.ts', import.meta.url)
  const indexText = requireSource(indexSource)
  const libraryText = requireSource(librarySource)
  const phaseEngineText = requireSource(phaseEngineSource)
  const skillsApiText = requireSource(skillsApiSource)

  assert.match(indexText, /selectStaleBundledIds/)
  assert.match(indexText, /skillsLib\.bundledPackageMatches\(id\)/)
  assert.match(phaseEngineText, /selectPhaseSkillPlan\(/)
  assert.match(phaseEngineText, /missingMandatoryUiPhaseSkills\(/)
  assert.match(phaseEngineText, /skillRuntime\.planPane\(/)
  assert.match(skillsApiText, /skillsLib\.loadActivationPackage\(/)

  assert.match(libraryText, /function writeBundledPackage\(/)
  assert.match(libraryText, /safeBundledDestination\(/)
  assert.match(libraryText, /bundledFiles/)
  assert.match(libraryText, /bundledPackageSha\(/)
  assert.match(libraryText, /bundledPackageMatches\(id: string\)/)
  assert.match(libraryText, /expected\.length !== actual\.length/)
  assert.match(libraryText, /loadActivationPackage\(/)
  assert.match(libraryText, /id === 'synkora-design-system-standard'/)
  assert.match(libraryText, /references\/components-patterns\.md/)
  assert.match(libraryText, /id === 'synkora-design-system-qa'/)
  assert.match(libraryText, /id === 'synkora-backend-standard'/)
  assert.match(libraryText, /references\/contracts-boundaries\.md/)
  assert.match(libraryText, /id === 'synkora-backend-qa'/)
  assert.match(libraryText, /id === 'synkora-devops-standard'/)
  assert.match(libraryText, /references\/rollout-recovery\.md/)
  assert.match(libraryText, /id === 'synkora-devops-qa'/)
  assert.match(libraryText, /id === 'synkora-cyber-standard'/)
  assert.match(libraryText, /references\/llm-mcp\.md/)
  assert.match(libraryText, /id === 'synkora-cyber-qa'/)
  assert.match(libraryText, /id === 'synkora-data-standard'/)
  assert.match(libraryText, /references\/analysis-validity\.md/)
  assert.match(libraryText, /id === 'synkora-data-qa'/)
  assert.match(libraryText, /id === 'synkora-research-standard'/)
  assert.match(libraryText, /references\/claim-citation\.md/)
  assert.match(libraryText, /id === 'synkora-research-qa'/)
  assert.match(libraryText, /id === 'synkora-copy-standard'/)
  assert.match(libraryText, /references\/brief-voice-proof\.md/)
  assert.match(libraryText, /id === 'synkora-copy-qa'/)
  assert.match(libraryText, /id === 'synkora-qa-standard'/)
  assert.match(libraryText, /references\/oracles-fixtures\.md/)
  assert.match(libraryText, /id === 'synkora-qa-qa'/)
  assert.match(libraryText, /references\/independent-audit\.md/)
  assert.match(phaseEngineText, /isDesignSystemWork\(task\.department, routingText\)/)
  assert.match(phaseEngineText, /isDevOpsWork\(task\.department, routingText\)/)
  assert.match(phaseEngineText, /skillId === SYNKORA_BACKEND_STANDARD_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_DEVOPS_QA_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_CYBER_QA_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_DATA_STANDARD_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_RESEARCH_QA_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_COPY_QA_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_QA_STANDARD_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_QA_QA_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_DESIGN_SYSTEM_STANDARD_ID/)
  assert.match(phaseEngineText, /skillId === SYNKORA_DESIGN_SYSTEM_QA_ID/)
})

function requireSource(url) {
  // Keep source-contract checks local to this test; behavior is covered above.
  return readFileSync(url, 'utf8')
}

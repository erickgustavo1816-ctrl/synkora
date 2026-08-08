import assert from 'node:assert/strict'
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
  SYNKORA_PLANNING_STANDARD_ID,
  SYNKORA_FRONTEND_STANDARD_ID,
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

test('a árvore multi-arquivo completa passa pelo gate de supply chain', (t) => {
  for (const definition of [standard, uiQa]) {
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
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'front', 'review'), [review.id])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'qa', false), [runtimeQa.id])
  assert.equal(planning.orchestratorDefault, true)
  assert.deepEqual(planning.allowedPhases, ['planning'])
})

test('o runtime instala, valida e entrega pacotes multi-arquivo em vez de só SKILL.md', () => {
  const indexSource = new URL('../src/main/index.ts', import.meta.url)
  const librarySource = new URL('../src/main/skillsLibrary.ts', import.meta.url)
  const indexText = requireSource(indexSource)
  const libraryText = requireSource(librarySource)

  assert.match(indexText, /selectStaleBundledIds/)
  assert.match(indexText, /skillsLib\.bundledPackageMatches\(id\)/)
  assert.match(indexText, /selectPhaseSkillPlan\(/)
  assert.match(indexText, /missingMandatoryUiPhaseSkills\(/)
  assert.match(indexText, /skillRuntime\.planPane\(/)
  assert.match(indexText, /skillsLib\.loadActivationPackage\(/)

  assert.match(libraryText, /function writeBundledPackage\(/)
  assert.match(libraryText, /safeBundledDestination\(/)
  assert.match(libraryText, /bundledFiles/)
  assert.match(libraryText, /bundledPackageSha\(/)
  assert.match(libraryText, /bundledPackageMatches\(id: string\)/)
  assert.match(libraryText, /expected\.length !== actual\.length/)
  assert.match(libraryText, /loadActivationPackage\(/)
})

function requireSource(url) {
  // Keep source-contract checks local to this test; behavior is covered above.
  return readFileSync(url, 'utf8')
}

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  bundledBodySha,
  selectStaleBundledIds
} from '../src/main/bundledSkillRevision.ts'
import { BUNDLED_SKILLS } from '../src/main/skillsBundled.ts'
import {
  assessSkillPackage,
  skillPackageBlockMessage
} from '../src/main/skillPackageSecurity.ts'
import {
  missingMandatoryFrontendStandard,
  selectFastQaUiSkillIds,
  SYNKORA_FRONTEND_STANDARD_ID,
  withMandatoryFrontendStandard
} from '../src/main/skillsRouting.ts'

const matches = BUNDLED_SKILLS.filter((skill) => skill.id === SYNKORA_FRONTEND_STANDARD_ID)
const standard = matches[0]
const body = standard?.bundledBody ?? ''

test('a biblioteca contém uma única régua frontend válida e autocontida', () => {
  assert.equal(matches.length, 1)
  assert.equal(standard.kind, 'skill')
  assert.deepEqual(standard.depts, ['front', 'design', 'qa'])
  assert.deepEqual(standard.defaultFor, ['front', 'design', 'qa'])
  assert.equal(standard.source.repo, 'synkora/bundled')
  assert.ok(!body.startsWith('\uFEFF'), 'SKILL.md embutido não pode carregar BOM')
  assert.match(body, /^---\nname: synkora-frontend-standard\n/)
  assert.match(body, /description: .*including localized FAST fixes/)
  assert.ok(body.split(/\r?\n/).length <= 420, 'a skill deve manter progressive disclosure')
})

test('o pacote embutido passa pelo mesmo gate de supply chain usado na instalação', () => {
  const directory = mkdtempSync(join(tmpdir(), 'synkora-frontend-standard-'))
  try {
    writeFileSync(join(directory, 'SKILL.md'), body, 'utf8')
    const assessment = assessSkillPackage(directory)
    assert.equal(assessment.filesScanned, 1)
    assert.equal(skillPackageBlockMessage(assessment), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('o corpo torna harmonia um gate visual independente e não compensável', () => {
  for (const expected of [
    'Completion is conjunctive',
    'READY = visual gate PASS',
    'Never average these verdicts',
    'HARD GATE',
    'CONTEXTUAL DEFAULT',
    'Robin Williams',
    'Müller-Brockmann',
    'Marcotte, Simmons',
    'Wroblewski',
    'Norman/Cooper/Tidwell',
    'Nielsen/Krug',
    'Refactoring UI',
    'WCAG 2.2',
    'Do not stack aesthetic-direction or taste skills',
    'Four passes with separate owners',
    '**SHAPE**',
    '**CRAFT**',
    '**CRITIQUE**',
    '**AUDIT**',
    'surface contract',
    'preferred co-row',
    'one dominant region',
    'role budgets, not numeric quotas',
    'Compose region packing explicitly',
    'sparse auto-placement',
    'one optical silhouette',
    'Define repeated-item anatomy',
    'deliberate item-owned rail',
    'Gestalt grouping',
    'Run a removal pass',
    'composition wins',
    'A tie does not validate a design skill',
    'Do not argue preference away with extra features',
    'When the owner/designated human prefers the baseline',
    'material visual ambiguity',
    'min-width: 0',
    'minmax(0, 1fr)',
    'Never let Grid/Flex auto-placement decide',
    'Siblings of the same semantic rank',
    'Every enabled affordance passes only',
    'Use local scrolling when the surface contract names',
    'AUDIT control state against affected content',
    'Single-line ellipsis',
    'Copy uses the full value',
    'Select the affected-width matrix by blast radius',
    'absolute regional gate before any pairwise preference',
    'Every critical region must pass',
    'neither is acceptable',
    'every reachable topology breakpoint',
    'terminal partial rows with unanchored actions',
    'intentional negative space is not a packing failure',
    'WCAG 2.5.8',
    'two animation frames',
    'accessible name plus implicit/explicit role',
    'synthetic fixtures',
    'QA rejects unsanitized evidence',
    'untrusted task data',
    'auditoria synkora-frontend-standard',
    'validar com uma pessoa'
  ]) {
    assert.ok(body.includes(expected), `contrato essencial ausente: ${expected}`)
  }

  assert.doesNotMatch(body, /What the script can check, the eye never re-checks/i)
  assert.doesNotMatch(body, /Cancel\/Esc\/backdrop blocked/i)
  assert.doesNotMatch(body, /TOUCH: hit areas ≥ 44px/)
  assert.doesNotMatch(body, /A skip link appears only on focus/)
  assert.doesNotMatch(body, /popovers originate from their trigger, not an arbitrary center/)
  assert.doesNotMatch(body, /maximum (?:of )?\d+ cards/i)
  assert.doesNotMatch(body, /use (?:all|multiple) (?:aesthetic|visual) skills/i)
  assert.doesNotMatch(body, /44×44[\s\S]{0,120}40×40[\s\S]{0,120}32×32/)
  assert.doesNotMatch(body, /voice \d+ \/ tasks \d+ \/ calendar \d+/i)
  assert.doesNotMatch(body, /\b(?:CAIS|REBITE)\b/)
  assert.doesNotMatch(body, /\b768\b/)
  assert.doesNotMatch(body, /sidebar (?:must|always|is required)/i)
  assert.doesNotMatch(body, /actions? (?:must|always) (?:sit|go|stay|align) (?:on|to) the right/i)
})

test('o fingerprint do conteúdo atualiza legado e preserva instalação idêntica', () => {
  const sha = bundledBodySha(body)
  assert.match(sha, /^bundled:[a-f0-9]{64}$/)
  assert.equal(sha, bundledBodySha(body))
  assert.notEqual(sha, bundledBodySha(`${body}\nchanged`))

  assert.deepEqual(
    selectStaleBundledIds([standard], [
      { id: standard.id, installed: true, sha: 'bundled' }
    ]),
    [standard.id],
    'a instalação legada precisa ser promovida uma vez'
  )
  assert.deepEqual(
    selectStaleBundledIds([standard], [
      { id: standard.id, installed: true, sha }
    ]),
    [],
    'bytes idênticos não devem reinstalar a skill a cada boot'
  )
  assert.deepEqual(
    selectStaleBundledIds(
      [standard],
      [{ id: standard.id, installed: true, sha }],
      () => false
    ),
    [standard.id],
    'manifest correto não pode mascarar bytes adulterados no pacote'
  )
  assert.deepEqual(selectStaleBundledIds([standard], []), [standard.id])
})

test('front/design e QA FAST não conseguem pular a régua visual', () => {
  assert.deepEqual(withMandatoryFrontendStandard([], 'front'), [standard.id])
  assert.deepEqual(withMandatoryFrontendStandard([], 'design'), [standard.id])
  assert.deepEqual(withMandatoryFrontendStandard(['custom', standard.id], 'front'), [
    'custom',
    standard.id
  ])
  assert.deepEqual(withMandatoryFrontendStandard(['custom'], 'back'), ['custom'])

  const qa = [standard.id, 'webapp-testing', 'better-accessibility']
  assert.deepEqual(selectFastQaUiSkillIds(qa, true), [standard.id])
  assert.deepEqual(selectFastQaUiSkillIds(qa, false), [])

  assert.equal(missingMandatoryFrontendStandard([standard.id], 'front', 'dev'), false)
  assert.equal(missingMandatoryFrontendStandard([], 'front', 'dev'), true)
  assert.equal(missingMandatoryFrontendStandard([], 'design', 'qa'), true)
  assert.equal(missingMandatoryFrontendStandard([], 'front', 'review'), false)
  assert.equal(missingMandatoryFrontendStandard([], 'back', 'qa'), false)
})

test('o boot e os prompts usam a versão atual antes do primeiro pane', () => {
  const indexSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const librarySource = readFileSync(
    new URL('../src/main/skillsLibrary.ts', import.meta.url),
    'utf8'
  )
  const workspaceSource = readFileSync(
    new URL('../src/main/workspaceSkills.ts', import.meta.url),
    'utf8'
  )

  assert.match(indexSource, /app\.whenReady\(\)\.then\(async \(\) =>/)
  assert.match(indexSource, /await skillsLib\.installMany\(staleBundled\)/)
  assert.match(indexSource, /const unresolvedBundled = selectStaleBundledIds/)
  assert.match(indexSource, /skillsLib\.bundledPackageMatches\(id\)/)
  assert.match(indexSource, /dialog\.showErrorBox\(/)
  assert.doesNotMatch(indexSource, /setTimeout\(\(\) => \{\s*const missing = BUNDLED_SKILLS/)
  assert.match(indexSource, /withMandatoryFrontendStandard\(/)
  assert.match(indexSource, /selectFastQaUiSkillIds\(/)
  assert.match(indexSource, /missingMandatoryFrontendStandard\(/)
  assert.match(indexSource, /required-frontend-skill-missing/)
  assert.match(indexSource, /FAST narrows blast radius, never visual quality/)
  assert.match(indexSource, /Use the isolated Playwright MCP for rendered UI verification/)
  assert.match(indexSource, /FAST narrows the affected state\/viewport matrix/)
  assert.doesNotMatch(
    indexSource,
    /phase === 'qa'[\s\S]{0,180}executionMode !== 'fast'[\s\S]{0,180}detectRuntimeScript/
  )
  assert.match(librarySource, /sha: bundledBodySha\(d\.bundledBody\)/)
  assert.match(librarySource, /bundledPackageMatches\(id: string\)/)
  assert.match(librarySource, /if \(def\?\.bundledBody && !this\.bundledPackageMatches\(id\)\)/)
  assert.match(librarySource, /if \(def\.bundledBody && !this\.bundledPackageMatches\(id\)\) continue/)
  assert.match(librarySource, /if \(this\.byId\(id\)\?\.bundledBody\)/)
  assert.match(librarySource, /if \(def\.bundledBody\) \{\s*protectedBundledPackages\+\+/)
  assert.match(librarySource, /managedWorkspaceSkillContentsMatch\(join\(this\.libDir, id\), dest\)/)
  assert.match(librarySource, /Boolean\(def\.bundledBody\)/)
  assert.match(workspaceSource, /managedWorkspaceSkillContentsMatch\(source, destination\)/)
})

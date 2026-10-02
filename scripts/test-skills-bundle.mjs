import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  bundledSkillsRoot, seedBundledSkills, seedBundledSkillsAtBoot
} from '../.tmp/skills-bundle-test/main/skillsBundle.js'

const fixtures = resolve('.tmp/skills-bundle-fixtures')
const timestamp = Date.parse('2026-09-21T12:00:00.000Z')
const manifestStore = createRequire(import.meta.url)('../.tmp/skills-bundle-test/main/skillsLibraryScan.js')

function sandbox(t) {
  mkdirSync(fixtures, { recursive: true })
  const root = mkdtempSync(join(fixtures, 'seed-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(`${fixtures}${sep}`))
    rmSync(root, { recursive: true, force: true })
  })
  const bundleRoot = join(root, 'bundle')
  const libraryRoot = join(root, 'skills', 'lib')
  const manifestFile = join(root, 'skills', 'manifest.json')
  mkdirSync(bundleRoot)
  return { root, bundleRoot, libraryRoot, manifestFile, now: () => timestamp }
}

function addSkill(root, id, content = `---\nname: ${id}\n---\nConteúdo sem BOM.\n`) {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), content)
  return directory
}

function writeBundle(root, skills = {}) {
  writeFileSync(join(root, 'BUNDLE.json'), JSON.stringify({ version: 1, generatedAt: '2026-09-20', skills }))
}

test('seeds missing skills byte-for-byte and preserves provenance and unrelated manifest fields', (t) => {
  const input = sandbox(t)
  const bytes = Buffer.from([0x00, 0xef, 0xbb, 0xbf, 0xff, 0x0d, 0x0a])
  const source = addSkill(input.bundleRoot, 'upstream-skill')
  writeFileSync(join(source, 'asset.bin'), bytes)
  addSkill(input.bundleRoot, 'synkora-house')
  const provenance = { sha: 'a'.repeat(40), installedAt: '2026-08-01', etag: 'fixture-etag', supplyChain: { review: 'fixture' } }
  writeBundle(input.bundleRoot, { 'upstream-skill': provenance, 'synkora-house': { origin: 'house' } })
  mkdirSync(input.libraryRoot, { recursive: true })
  const old = { installed: { unrelated: { sha: 'b', installedAt: '2026-08-01' } }, updates: { unrelated: 'c' }, ownerField: { keep: true } }
  writeFileSync(input.manifestFile, JSON.stringify(old))
  const result = seedBundledSkills({ ...input, kitIds: ['upstream-skill', 'synkora-house'] })
  assert.deepEqual(result, { seeded: ['upstream-skill', 'synkora-house'], skipped: [], failures: [] })
  assert.deepEqual(readFileSync(join(input.libraryRoot, 'upstream-skill', 'asset.bin')), bytes)
  assert.deepEqual(readFileSync(join(input.libraryRoot, 'upstream-skill', 'SKILL.md')), readFileSync(join(source, 'SKILL.md')))
  const manifest = JSON.parse(readFileSync(input.manifestFile, 'utf8'))
  assert.deepEqual(manifest.installed['upstream-skill'], { ...provenance, installedAt: new Date(timestamp).toISOString(), origin: 'bundle' })
  assert.equal(manifest.installed['synkora-house'].origin, 'bundle')
  assert.equal(manifest.installed['synkora-house'].installedAt, new Date(timestamp).toISOString())
  assert.equal(manifest.installed['synkora-house'].sha, '')
  assert.deepEqual(manifest.installed.unrelated, old.installed.unrelated)
  assert.deepEqual(manifest.updates, old.updates)
  assert.deepEqual(manifest.ownerField, old.ownerField)
  assert.deepEqual(JSON.parse(readFileSync(`${input.manifestFile}.bak`, 'utf8')), {
    ...old,
    installed: { ...old.installed, 'upstream-skill': manifest.installed['upstream-skill'] }
  })
  assert.deepEqual(JSON.parse(readFileSync(`${input.manifestFile}.bak.1`, 'utf8')), old)
})

test('never overwrites an existing library folder or its manifest entry', (t) => {
  const input = sandbox(t)
  addSkill(input.bundleRoot, 'owned', 'bundle content')
  const owned = addSkill(input.libraryRoot, 'owned', 'owner content')
  const manifest = '{ "installed": { "owned": { "sha": "owner", "installedAt": "before" } } }\n'
  writeFileSync(input.manifestFile, manifest)
  const result = seedBundledSkills({ ...input, kitIds: ['owned'] })
  assert.deepEqual(result, { seeded: [], skipped: ['owned'], failures: [] })
  assert.equal(readFileSync(join(owned, 'SKILL.md'), 'utf8'), 'owner content')
  assert.equal(readFileSync(input.manifestFile, 'utf8'), manifest)
})

test('existing files and dangling library links are also skipped', (t) => {
  const input = sandbox(t)
  mkdirSync(input.libraryRoot, { recursive: true })
  writeFileSync(join(input.libraryRoot, 'owner-file'), 'owner file')
  symlinkSync(join(input.root, 'absent-target'), join(input.libraryRoot, 'owner-link'), 'junction')
  const result = seedBundledSkills({ ...input, kitIds: ['owner-file', 'owner-link'] })
  assert.deepEqual(result, { seeded: [], skipped: ['owner-file', 'owner-link'], failures: [] })
  assert.equal(readFileSync(join(input.libraryRoot, 'owner-file'), 'utf8'), 'owner file')
  assert.equal(lstatSync(join(input.libraryRoot, 'owner-link')).isSymbolicLink(), true)
  assert.equal(existsSync(input.manifestFile), false)
})

test('a missing bundled id returns a named failure and does not prevent another seed', (t) => {
  const input = sandbox(t)
  addSkill(input.bundleRoot, 'present')
  writeBundle(input.bundleRoot)
  assert.deepEqual(seedBundledSkills({ ...input, kitIds: ['missing', 'present'] }), {
    seeded: ['present'], skipped: [], failures: [{ id: 'missing', error: 'não está no pacote do app' }]
  })
})

test('rerunning the seed is idempotent, including the manifest bytes', (t) => {
  const input = sandbox(t)
  addSkill(input.bundleRoot, 'repeat')
  writeBundle(input.bundleRoot)
  assert.deepEqual(seedBundledSkills({ ...input, kitIds: ['repeat'] }).seeded, ['repeat'])
  const before = readFileSync(input.manifestFile)
  assert.deepEqual(seedBundledSkills({ ...input, kitIds: ['repeat'], now: () => timestamp + 1 }), {
    seeded: [], skipped: ['repeat'], failures: []
  })
  assert.deepEqual(readFileSync(input.manifestFile), before)
})

test('a nested bundle symlink refuses that id before copying, while another id succeeds', (t) => {
  const input = sandbox(t)
  const bad = addSkill(input.bundleRoot, 'linked')
  const external = addSkill(input.root, 'external', 'external content')
  symlinkSync(external, join(bad, 'link'), 'junction')
  addSkill(input.bundleRoot, 'valid')
  writeBundle(input.bundleRoot)
  const result = seedBundledSkills({ ...input, kitIds: ['linked', 'valid'] })
  assert.deepEqual(result.seeded, ['valid'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].id, 'linked')
  assert.match(result.failures[0].error, /link simbólico/)
  assert.equal(existsSync(join(input.libraryRoot, 'linked')), false)
  assert.equal(readFileSync(join(external, 'SKILL.md'), 'utf8'), 'external content')
})

test('a linked skill root is refused without touching its target', (t) => {
  const input = sandbox(t)
  const external = addSkill(input.root, 'external')
  symlinkSync(external, join(input.bundleRoot, 'linked-root'), 'junction')
  writeBundle(input.bundleRoot)
  const result = seedBundledSkills({ ...input, kitIds: ['linked-root'] })
  assert.equal(result.failures[0].id, 'linked-root')
  assert.match(result.failures[0].error, /link simbólico/)
  assert.equal(existsSync(join(input.libraryRoot, 'linked-root')), false)
})

test('an unreadable owner manifest is preserved and no folder is installed', (t) => {
  const input = sandbox(t)
  addSkill(input.bundleRoot, 'valid')
  writeBundle(input.bundleRoot)
  mkdirSync(input.libraryRoot, { recursive: true })
  writeFileSync(input.manifestFile, '{broken owner manifest')
  const result = seedBundledSkills({ ...input, kitIds: ['valid'] })
  assert.equal(result.failures[0].id, 'valid')
  assert.match(result.failures[0].error, /manifest\.json/)
  assert.equal(readFileSync(input.manifestFile, 'utf8'), '{broken owner manifest')
  assert.equal(existsSync(join(input.libraryRoot, 'valid')), false)
})

test('broken bundle metadata fails the missing id without disturbing an existing owner folder', (t) => {
  const input = sandbox(t)
  addSkill(input.bundleRoot, 'valid')
  addSkill(input.libraryRoot, 'owned', 'owner')
  writeFileSync(join(input.bundleRoot, 'BUNDLE.json'), '{broken bundle')
  const result = seedBundledSkills({ ...input, kitIds: ['valid', 'owned'] })
  assert.deepEqual(result.skipped, ['owned'])
  assert.equal(result.failures[0].id, 'valid')
  assert.equal(existsSync(join(input.libraryRoot, 'valid')), false)
})

test('failed manifest persistence leaves no half-installed folder and allows a retry', (t) => {
  const input = sandbox(t)
  addSkill(input.bundleRoot, 'valid')
  writeBundle(input.bundleRoot)
  const persist = t.mock.method(manifestStore, 'writeSkillsManifest', () => {
    assert.equal(existsSync(join(input.libraryRoot, 'valid', 'SKILL.md')), true)
    throw Object.assign(new Error('fixture private path must not enter the diary'), { code: 'EACCES' })
  })
  const result = seedBundledSkills({ ...input, kitIds: ['valid'] })
  assert.equal(result.failures[0].id, 'valid')
  assert.match(result.failures[0].error, /EACCES/)
  assert.doesNotMatch(result.failures[0].error, /private path/)
  assert.equal(existsSync(join(input.libraryRoot, 'valid')), false)
  assert.equal(existsSync(input.manifestFile), false)
  persist.mock.restore()
  assert.deepEqual(seedBundledSkills({ ...input, kitIds: ['valid'] }).seeded, ['valid'])
  assert.deepEqual(readdirSync(input.libraryRoot), ['valid'])
})

test('invalid ids cannot escape either supplied root', (t) => {
  const input = sandbox(t)
  const result = seedBundledSkills({ ...input, kitIds: ['../outside', 'bad/id', 'C:\\outside'] })
  assert.equal(result.failures.length, 3)
  assert.equal(result.seeded.length, 0)
})

test('bundle path resolution separates packaged resources from development files', () => {
  assert.equal(bundledSkillsRoot(true, 'resources', 'app'), join('resources', 'skills'))
  assert.equal(bundledSkillsRoot(false, 'resources', 'app'), join('app', 'build', 'skills'))
})

test('boot degradation records one event and never throws even when Electron or logging is unavailable', () => {
  const events = []
  assert.doesNotThrow(() => seedBundledSkillsAtBoot((event) => events.push(event)))
  assert.equal(events.length, 1)
  assert.equal(events[0].cat, 'app')
  assert.equal(events[0].event, 'skills-bundle-seed')
  assert.equal(events[0].actor, 'harness')
  assert.deepEqual(events[0].detail.seeded, [])
  assert.equal(events[0].detail.skipped, 0)
  assert.equal(events[0].detail.failures.length, 1)
  assert.doesNotThrow(() => seedBundledSkillsAtBoot(() => { throw new Error('fixture recorder failure') }))
})

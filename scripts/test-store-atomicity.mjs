import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import Module, { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { BacklogStore } from '../.tmp/store-atomicity-test/main/backlog.js'
import { loadJsonStore, persistJsonStore } from '../.tmp/store-atomicity-test/main/jsonStore.js'

const fixtureRoot = fileURLToPath(new URL('../.tmp/', import.meta.url))

const require = createRequire(import.meta.url)
let missionUserData = ''
const originalLoad = Module._load
let MissionStore
try {
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => missionUserData } }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  ;({ MissionStore } = require('../.tmp/store-atomicity-test/main/missions.js'))
} finally {
  Module._load = originalLoad
}

function temporaryRoot(t, prefix) {
  const root = mkdtempSync(join(fixtureRoot, prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function isMissingParentError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

const validSnapshot = value => value !== null && typeof value === 'object' && Array.isArray(value.items)
const emptySnapshot = () => ({ items: [] })
const unrecoverable = error => error?.code === 'JSON_STORE_UNRECOVERABLE'

function withFilesystemFault(method, replacement, action) {
  const original = fs[method]
  fs[method] = (...args) => replacement(original, ...args)
  syncBuiltinESMExports()
  try {
    return action()
  } finally {
    fs[method] = original
    syncBuiltinESMExports()
  }
}

test('ordinary JSON load preserves the richer alternate byte for byte', t => {
  const file = join(temporaryRoot(t, 'json-load-'), 'store.json')
  writeFileSync(file, '{"items":[]}\n')
  const alternate = '{ "items": ["synthetic-prior"], "legacy": true }\n'
  writeFileSync(`${file}.bak`, alternate)
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: [] })
  assert.equal(readFileSync(file, 'utf8'), '{"items":[]}\n')
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), alternate)
})

test('JSON generations keep the previous commit and the older alternate', t => {
  const file = join(temporaryRoot(t, 'json-generations-'), 'store.json')
  persistJsonStore(file, { items: ['first'] })
  persistJsonStore(file, { items: ['second'] })
  persistJsonStore(file, { items: ['third'] })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { items: ['third'] })
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { items: ['second'] })
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak.1`, 'utf8')), { items: ['first'] })
})

test('repeated bootstrap loads and identical checkpoints preserve the previous good generation', t => {
  const file = join(temporaryRoot(t, 'json-bootstrap-'), 'store.json')
  persistJsonStore(file, { items: ['previous-good'] })
  persistJsonStore(file, { items: [] })
  const backup = readFileSync(`${file}.bak`)
  for (let boot = 0; boot < 4; boot++) {
    const loaded = loadJsonStore(file, emptySnapshot, validSnapshot)
    assert.deepEqual(loaded, { items: [] })
    persistJsonStore(file, loaded)
  }
  assert.deepEqual(readFileSync(`${file}.bak`), backup)
  writeFileSync(file, '{broken')
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: ['previous-good'] })
})

test('backup recovery leaves damaged bytes and the backup intact through load and save', t => {
  const root = temporaryRoot(t, 'json-recovery-')
  const file = join(root, 'store.json')
  const damaged = Buffer.from([0xff, 0x00, 0x7b])
  const alternate = '{ "items": ["recovered"], "legacy": { "kept": true } }\n'
  writeFileSync(file, damaged)
  writeFileSync(`${file}.bak`, alternate)
  const loaded = loadJsonStore(file, emptySnapshot, validSnapshot)
  assert.deepEqual(loaded, { items: ['recovered'], legacy: { kept: true } })
  assert.deepEqual(readFileSync(file), damaged)
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), alternate)
  persistJsonStore(file, { ...loaded, items: ['recovered', 'next'] })
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), alternate)
  const artifacts = readdirSync(root).filter(name => name.startsWith('store.json.corrupt-'))
  assert.equal(artifacts.length, 1)
  assert.deepEqual(readFileSync(join(root, artifacts[0])), damaged)
})

for (const [name, primary, backup] of [
  ['malformed JSON', '{broken', '[broken'],
  ['invalid document shape', '{"unexpected":true}', 'null']
]) {
  test(`failed load of ${name} cannot persist the empty fallback`, t => {
    const file = join(temporaryRoot(t, 'json-invalid-'), 'store.json')
    writeFileSync(file, primary)
    writeFileSync(`${file}.bak`, backup)
    assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: [] })
    assert.throws(() => persistJsonStore(file, emptySnapshot()), unrecoverable)
    assert.equal(readFileSync(file, 'utf8'), primary)
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), backup)
    writeFileSync(file, '{"items":["repaired"],"legacy":true}')
    assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: ['repaired'], legacy: true })
    persistJsonStore(file, { items: ['repaired', 'next'], legacy: true })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { items: ['repaired', 'next'], legacy: true })
    const damagedBackup = readdirSync(join(file, '..')).filter(name => name.startsWith('store.json.bak.corrupt-'))
    assert.equal(damagedBackup.length, 1)
    assert.equal(readFileSync(join(file, '..', damagedBackup[0]), 'utf8'), backup)
  })
}

test('an unreadable document differs from first use and remains write blocked', t => {
  const file = join(temporaryRoot(t, 'json-unreadable-'), 'store.json')
  mkdirSync(file)
  mkdirSync(`${file}.bak`)
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: [] })
  assert.throws(() => persistJsonStore(file, emptySnapshot()), unrecoverable)
})

test('an unreadable primary can be read through backup but cannot erase that backup', t => {
  const file = join(temporaryRoot(t, 'json-unreadable-recovery-'), 'store.json')
  mkdirSync(file)
  writeFileSync(`${file}.bak`, '{"items":["recoverable"]}')
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: ['recoverable'] })
  assert.throws(() => persistJsonStore(file, { items: ['next'] }), unrecoverable)
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"items":["recoverable"]}')
})

test('a missing store can initialize and recover its first commit', t => {
  const file = join(temporaryRoot(t, 'json-first-use-'), 'store.json')
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: [] })
  persistJsonStore(file, { items: ['first'], legacy: true })
  writeFileSync(file, '{broken')
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: ['first'], legacy: true })
})

test('an older valid generation recovers a damaged primary and immediate backup', t => {
  const file = join(temporaryRoot(t, 'json-older-recovery-'), 'store.json')
  writeFileSync(file, '{broken')
  writeFileSync(`${file}.bak`, '{broken-backup')
  writeFileSync(`${file}.bak.1`, '{"items":["older"]}')
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: ['older'] })
  persistJsonStore(file, { items: ['older', 'next'] })
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{broken-backup')
  assert.equal(readFileSync(`${file}.bak.1`, 'utf8'), '{"items":["older"]}')
})

test('every promoted JSON snapshot was flushed while still a temporary file', t => {
  const file = join(temporaryRoot(t, 'json-flush-'), 'store.json')
  persistJsonStore(file, { items: ['first'] })
  const opened = new Map()
  const flushed = new Set()
  withFilesystemFault('openSync', (original, target, ...args) => {
    const fd = original(target, ...args)
    opened.set(fd, String(target))
    return fd
  }, () => withFilesystemFault('fsyncSync', (original, fd) => {
    original(fd)
    flushed.add(opened.get(fd))
  }, () => withFilesystemFault('renameSync', (original, source, destination) => {
    assert.ok(flushed.has(String(source)), 'a snapshot was promoted without flushing')
    return original(source, destination)
  }, () => persistJsonStore(file, { items: ['second'] }))))
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { items: ['second'] })
})

test('a flush failure preserves the committed primary and alternate', t => {
  const root = temporaryRoot(t, 'json-flush-failure-')
  const file = join(root, 'store.json')
  persistJsonStore(file, { items: ['first'] })
  const before = readFileSync(file)
  const backup = readFileSync(`${file}.bak`)
  withFilesystemFault('fsyncSync', () => { throw Object.assign(new Error('synthetic flush failure'), { code: 'EIO' }) }, () => {
    assert.throws(() => persistJsonStore(file, { items: ['second'] }), error => error?.code === 'EIO')
  })
  assert.deepEqual(readFileSync(file), before)
  assert.deepEqual(readFileSync(`${file}.bak`), backup)
  assert.equal(readdirSync(root).some(name => name.includes('.tmp-')), false)
})

test('failed backup preparation keeps both existing recoverable generations', t => {
  const file = join(temporaryRoot(t, 'json-backup-failure-'), 'store.json')
  writeFileSync(file, '{"items":["current"]}')
  writeFileSync(`${file}.bak`, '{"items":["previous"]}')
  withFilesystemFault('fsyncSync', () => { throw Object.assign(new Error('synthetic backup flush failure'), { code: 'EIO' }) }, () => {
    assert.throws(() => persistJsonStore(file, { items: ['next'] }), error => error?.code === 'EIO')
  })
  assert.equal(readFileSync(file, 'utf8'), '{"items":["current"]}')
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"items":["previous"]}')
})

test('failed damaged-artifact preservation cannot replace the damaged primary', t => {
  const file = join(temporaryRoot(t, 'json-artifact-failure-'), 'store.json')
  writeFileSync(file, '{broken')
  writeFileSync(`${file}.bak`, '{"items":["recoverable"]}')
  withFilesystemFault('renameSync', (original, source, destination) => {
    if (destination.includes('.corrupt-')) throw Object.assign(new Error('synthetic archive failure'), { code: 'EIO' })
    return original(source, destination)
  }, () => assert.throws(() => persistJsonStore(file, { items: ['next'] }), error => error?.code === 'EIO'))
  assert.equal(readFileSync(file, 'utf8'), '{broken')
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"items":["recoverable"]}')
})

test('failed primary promotion keeps the live commit and all prior recoverable data', t => {
  const root = temporaryRoot(t, 'json-promotion-failure-')
  const file = join(root, 'store.json')
  persistJsonStore(file, { items: ['first'] })
  persistJsonStore(file, { items: ['second'] })
  const before = readFileSync(file)
  withFilesystemFault('renameSync', (original, source, destination) => {
    if (destination === file) throw Object.assign(new Error('synthetic promotion failure'), { code: 'EIO' })
    return original(source, destination)
  }, () => assert.throws(() => persistJsonStore(file, { items: ['third'] }), error => error?.code === 'EIO'))
  assert.deepEqual(readFileSync(file), before)
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: ['second'] })
  const snapshots = ['.bak', '.bak.1'].filter(suffix => fs.existsSync(`${file}${suffix}`))
    .map(suffix => JSON.parse(readFileSync(`${file}${suffix}`, 'utf8')))
  assert.ok(snapshots.some(snapshot => snapshot.items.includes('first')))
  assert.equal(readdirSync(root).some(name => name.includes('.tmp-')), false)
})

test('a failed first primary promotion cannot publish an uncommitted backup', t => {
  const root = temporaryRoot(t, 'json-first-failure-')
  const file = join(root, 'store.json')
  withFilesystemFault('renameSync', (original, source, destination) => {
    if (destination === file) throw Object.assign(new Error('synthetic promotion failure'), { code: 'EIO' })
    return original(source, destination)
  }, () => assert.throws(() => persistJsonStore(file, { items: ['uncommitted'] }), error => error?.code === 'EIO'))
  assert.deepEqual(loadJsonStore(file, emptySnapshot, validSnapshot), { items: [] })
  assert.deepEqual(readdirSync(root), [])
})

test('direct persistence refuses a present corrupt pair before a loader has run', t => {
  const file = join(temporaryRoot(t, 'json-direct-invalid-'), 'store.json')
  writeFileSync(file, '{broken')
  writeFileSync(`${file}.bak`, '[broken')
  assert.throws(() => persistJsonStore(file, emptySnapshot()), unrecoverable)
  assert.equal(readFileSync(file, 'utf8'), '{broken')
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '[broken')
})

test('destino da release pertence à versão, sobrevive ao reload e não muda depois da subida', t => {
  const root = temporaryRoot(t, 'synkora-release-destination-')
  const file = join(root, 'backlog.json')
  const store = new BacklogStore(file)
  const first = store.createVersion('p1', { name: '1.0.0' })
  const other = store.createVersion('p1', { name: '1.1.0' })
  assert.equal(store.setVersionReleaseTarget(first.id, 'main'), true)
  const reloaded = new BacklogStore(file)
  assert.equal(reloaded.getVersion(first.id).releaseTargetBranch, 'main')
  assert.equal(reloaded.getVersion(other.id).releaseTargetBranch, undefined)
  reloaded.markVersionReleased(first.id)
  assert.equal(reloaded.setVersionReleaseTarget(first.id, 'dev'), false)
  assert.equal(new BacklogStore(file).getVersion(first.id).releaseTargetBranch, 'main')
})

test('mission summaries survive completion and reload into the version delivery without duplication', (t) => {
  const root = temporaryRoot(t, 'synkora-mission-summary-')
  missionUserData = root
  const missions = new MissionStore()
  const backlogFile = join(root, 'backlog.json')
  const backlog = new BacklogStore(backlogFile)
  const version = backlog.createVersion('project-1', { name: '1.0.0' })
  const mission = missions.create('project-1', { title: 'Restore search', versionId: version.id, direct: true })
  const summary = 'A busca voltou a encontrar os itens pelo nome. Agora é possível localizar o que você precisa sem repetir a pesquisa.'
  missions.update(mission.id, { summary })
  missions.update(mission.id, { status: 'concluida', branch: undefined, worktree: undefined })
  const saved = new MissionStore().get(mission.id)
  assert.equal(saved.summary, summary)
  backlog.addDelivery(version.id, mission.id, mission.title, saved.summary)
  const delivered = new BacklogStore(backlogFile).getVersion(version.id).deliveries[0]
  assert.equal(delivered.summary, summary)
  const revised = 'A busca encontra itens pelo nome completo ou por parte dele. Os resultados aparecem sem precisar repetir a pesquisa.'
  backlog.addDelivery(version.id, mission.id, mission.title, revised)
  backlog.addDelivery(version.id, mission.id, mission.title, revised)
  const reloaded = new BacklogStore(backlogFile).getVersion(version.id).deliveries
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0].summary, revised)
  assert.equal(reloaded[0].id, delivered.id)
  assert.equal(reloaded[0].at, delivered.at)
})

test('failed mission persistence never publishes a ghost mission in memory', (t) => {
  const root = temporaryRoot(t, 'synkora-mission-atomicity-')
  missionUserData = join(root, 'missing')
  const store = new MissionStore()

  assert.throws(() => store.create('project-1', { title: 'Ghost mission' }), isMissingParentError)
  assert.throws(
    () => store.createDirect('project-1', { title: 'Ghost direct mission', points: ['change'] }),
    isMissingParentError
  )
  assert.deepEqual(store.list('project-1'), [])
})

test('failed mission update keeps the last persisted snapshot live', (t) => {
  const root = temporaryRoot(t, 'synkora-mission-update-atomicity-')
  const storage = join(root, 'storage')
  mkdirSync(storage)
  missionUserData = storage
  const store = new MissionStore()
  const mission = store.create('project-1', { title: 'Persisted mission' })
  const before = { ...mission }
  rmSync(storage, { recursive: true, force: true })

  assert.throws(
    () => store.update(mission.id, { title: 'Memory-only title', status: 'concluida' }),
    isMissingParentError
  )
  assert.deepEqual(store.get(mission.id), before)
})

test('failed backlog persistence publishes neither a version nor its automatic item', (t) => {
  const root = temporaryRoot(t, 'synkora-backlog-atomicity-')
  const store = new BacklogStore(join(root, 'missing', 'backlog.json'))

  assert.throws(
    () => store.createVersion('project-1', { name: 'Ghost version' }),
    isMissingParentError
  )
  assert.deepEqual(store.listVersions('project-1'), [])

  assert.throws(
    () => store.createItem('project-1', { title: 'Ghost item' }),
    isMissingParentError
  )
  assert.deepEqual(store.listVersions('project-1'), [])
  assert.deepEqual(store.listItems('project-1'), [])
})

test('failed backlog update keeps the last persisted snapshot live', (t) => {
  const root = temporaryRoot(t, 'synkora-backlog-update-atomicity-')
  const storage = join(root, 'storage')
  mkdirSync(storage)
  const store = new BacklogStore(join(storage, 'backlog.json'))
  const version = store.createVersion('project-1', { name: 'V1.0' })
  const before = { ...version }
  rmSync(storage, { recursive: true, force: true })

  assert.throws(
    () => store.updateVersion(version.id, { name: 'Memory-only version', status: 'lancada' }),
    isMissingParentError
  )
  assert.deepEqual(store.getVersion(version.id), before)
})

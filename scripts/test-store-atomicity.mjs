import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BacklogStore } from '../.tmp/store-atomicity-test/backlog.js'

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
  ;({ MissionStore } = require('../.tmp/store-atomicity-test/missions.js'))
} finally {
  Module._load = originalLoad
}

function temporaryRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function isMissingParentError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

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

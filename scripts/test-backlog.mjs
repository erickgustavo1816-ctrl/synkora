import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BacklogStore } from '../.tmp/backlog-test/backlog.js'

test('release status and isolation metadata are persisted as one logical transition', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'backlog.json')
  const store = new BacklogStore(file)
  const version = store.createVersion('project-1', { name: 'V1.0' })
  store.setVersionBranch(
    version.id,
    'version/legacy-v1',
    join(root, 'worktrees', 'version-legacy-v1')
  )

  const released = store.markVersionReleased(version.id)
  assert.equal(released?.status, 'lancada')
  assert.equal(released?.branch, undefined)
  assert.equal(released?.worktree, undefined)
  assert.ok(released?.releasedAt)

  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  const persistedVersion = persisted.versions.find((candidate) => candidate.id === version.id)
  assert.equal(persistedVersion.status, 'lancada')
  assert.equal('branch' in persistedVersion, false)
  assert.equal('worktree' in persistedVersion, false)
  assert.equal(persistedVersion.releasedAt, released.releasedAt)

  const releasedAt = released.releasedAt
  const repeated = store.markVersionReleased(version.id)
  assert.equal(repeated?.releasedAt, releasedAt)

  const reopened = new BacklogStore(file).getVersion(version.id)
  assert.equal(reopened?.status, 'lancada')
  assert.equal(reopened?.branch, undefined)
  assert.equal(reopened?.worktree, undefined)
  assert.equal(reopened?.releasedAt, releasedAt)
})

test('rename validation never permits two versions with the same visible name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-version-name-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const first = store.createVersion('project-1', { name: 'V1.0' })
  const second = store.createVersion('project-1', { name: 'V2.0' })

  assert.equal(store.validateVersionName('project-1', ' v1.0 ', second.id), 'a versão v1.0 já existe')
  assert.equal(store.validateVersionName('project-1', 'V2.0', second.id), null)
  assert.equal(store.validateVersionName('project-1', 'V1.0', first.id), null)
})

test('default version advances from the highest numeric history without duplicating a legacy name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-default-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const numeric = store.createVersion('project-1', { name: 'V1.0' })
  store.markVersionReleased(numeric.id)
  const legacy = store.createVersion('project-1', { name: 'Beta' })
  store.markVersionReleased(legacy.id)

  const next = store.ensureDefaultVersion('project-1')
  assert.equal(next.name, 'V1.1')
  assert.equal(
    store.listVersions('project-1').filter((version) => version.name === 'V1.0').length,
    1
  )
})

test('backlog items reject versions owned by another project', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-ownership-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const own = store.createVersion('project-1', { name: 'V1.0' })
  const foreign = store.createVersion('project-2', { name: 'V1.0' })

  assert.throws(
    () => store.createItem('project-1', { title: 'foreign', versionId: foreign.id }),
    /não pertence a este projeto/
  )
  const item = store.createItem('project-1', { title: 'owned', versionId: own.id })
  assert.equal(store.updateItem(item.id, { versionId: foreign.id }), undefined)
  assert.equal(store.getItem(item.id)?.versionId, own.id)
})

test('mission version choices expose only open versions and their current default', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-mission-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const current = store.createVersion('project-1', { name: 'V1.2' })
  const next = store.createVersion('project-1', { name: 'V2.0' })
  const released = store.createVersion('project-1', { name: 'V1.1' })
  const foreign = store.createVersion('project-2', { name: 'V9.0' })
  store.markVersionReleased(released.id)

  const choices = store.missionVersionChoices('project-1')

  assert.equal(choices.defaultVersionId, current.id)
  assert.deepEqual(
    choices.versions.map((version) => version.id),
    [current.id, next.id]
  )
  assert.equal(choices.versions.some((version) => version.id === released.id), false)
  assert.equal(choices.versions.some((version) => version.id === foreign.id), false)
})

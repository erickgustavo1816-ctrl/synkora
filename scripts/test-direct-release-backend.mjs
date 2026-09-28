import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { ensureReleaseMission } from '../src/main/releaseChat.ts'
import { guiReleaseFirstPrompt } from '../src/main/guiMissionContracts.ts'
import { fixture } from './direct-release-test-utils.mjs'

test('direct release creates its isolation immediately, preserves the owner title and reuses a live conversation concurrently', async t => {
  const f = fixture(t), version = f.backlog.createVersion('p1', { name: 'V1.1.0' })
  const results = await Promise.all([f.call({ title: '  Corrigir impressão  ', versionId: version.id }), f.call({ title: 'Outro pedido', versionId: version.id })])
  assert.ok(results.every(r => r.ok), JSON.stringify(results))
  assert.deepEqual(results.map(r => r.created), [true, false])
  assert.equal(results[0].missionId, results[1].missionId)
  assert.equal(f.isolationCalls(), 1)
  const mission = f.missions.get(results[0].missionId), stored = f.backlog.getVersion(version.id)
  assert.equal(mission.title, 'Corrigir impressão'); assert.equal(mission.direct, true); assert.equal(mission.missionType, 'release')
  assert.match(mission.goal, /Corrigir impressão/); assert.match(mission.goal, /before-release/)
  assert.ok(f.worktree.isExpectedVersionWorktree(f.path, stored.worktree, stored.branch))
  assert.equal(mission.worktree, undefined)
  assert.ok(f.events.includes('p1'))
})

test('new-version gesture uses the existing createVersion validation and retains its chosen name', async t => {
  const f = fixture(t)
  const created = await f.call({ title: 'Corrigir tela', newVersionName: ' V1.2.0 ' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(f.backlog.getVersion(created.versionId).name, 'V1.2.0')
  for (const name of ['V1.2.0', '']) {
    const refused = await f.call({ title: 'Outro', newVersionName: name })
    assert.equal(refused.ok, false); assert.match(refused.error, /[Rr]eceita/)
  }
  assert.equal(f.backlog.listVersions('p1').length, 1)
})

test('current released destination is selected by releasedAt and makes no isolation or new version', async t => {
  const f = fixture(t)
  const old = f.backlog.createVersion('p1', { name: 'V1.0.0' }), current = f.backlog.createVersion('p1', { name: 'V1.1.0' })
  f.backlog.updateVersion(old.id, { status: 'lancada', releasedAt: '2026-01-01' })
  f.backlog.updateVersion(current.id, { status: 'lancada', releasedAt: '2026-02-01' })
  f.backlog.updateVersion(old.id, { theme: 'edited later' })
  const result = await f.call({ title: 'Corrigir atual', versionId: current.id })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(f.missions.get(result.missionId).goal, /after-release/)
  assert.match(f.missions.get(result.missionId).goal, /sem novo número/)
  assert.equal(f.isolationCalls(), 0); assert.equal(f.backlog.listVersions('p1').length, 2)
  const refusal = await f.call({ title: 'Não', versionId: old.id })
  assert.equal(refusal.ok, false); assert.match(refusal.error, /[Rr]eceita/)
})

test('direct IPC refuses malformed, foreign, missing and damaged destinations before mission creation', async t => {
  const f = fixture(t), foreign = f.backlog.createVersion('p2', { name: 'Foreign' }), broken = f.backlog.createVersion('p1', { name: 'Broken' })
  f.backlog.setVersionBranch(broken.id, 'version/missing', join(f.root, 'missing'))
  for (const input of [null, {}, { title: 'x' }, { title: ' ', versionId: broken.id },
    { title: 'x', versionId: foreign.id }, { title: 'x', versionId: 'missing' }, { title: 'x', versionId: broken.id },
    { title: 'x', versionId: broken.id, newVersionName: 'Both' }]) {
    const result = await f.call(input)
    assert.equal(result.ok, false); assert.match(result.error, /[Rr]eceita/)
  }
  assert.equal((await f.call({ title: 'x', newVersionName: 'New' }, 'missing')).ok, false)
  assert.equal(f.missions.list('p1').length, 0); assert.equal(f.isolationCalls(), 0)
})

test('direct ensure permits only the current release, including when an old release conversation still lives', () => {
  const version = { id: 'v1', projectId: 'p1', name: 'V1', status: 'lancada' }
  let payload
  const deps = { version, missions: [], directRequest: { title: '  Corrigir  ', currentVersionId: 'v1' }, create: input => { payload = input; return { id: 'm1' } } }
  assert.equal(ensureReleaseMission(deps).ok, true)
  assert.equal(payload.title, 'Corrigir'); assert.match(payload.goal, /after-release/)
  const refused = ensureReleaseMission({ ...deps, directRequest: { ...deps.directRequest, currentVersionId: 'v2' }, missions: [{ id: 'old', projectId: 'p1', versionId: 'v1', status: 'ativa', missionType: 'release' }] })
  assert.equal(refused.ok, false)
})

test('release briefing preserves owner request and phase without assuming a button press', () => {
  const base = { versionName: 'V1', projectPath: '/project', ownerRequest: 'Corrigir impressão' }
  const before = guiReleaseFirstPrompt({ ...base, versionStatus: 'aberta', versionWorktree: '/version' })
  assert.match(before, /Corrigir impressão/); assert.match(before, /before-release/); assert.match(before, /\/version/)
  const after = guiReleaseFirstPrompt({ ...base, versionStatus: 'lancada' })
  assert.match(after, /after-release/); assert.match(after, /auto-update/); assert.match(after, /new version/i)
  assert.doesNotMatch(after, /owner pressed/)
})

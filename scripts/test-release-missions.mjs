import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'

const code = buildSync({ stdin: { contents: `
  export { buildReleaseMissions } from './src/main/releaseMissions';
  export { buildMissionLifecycle } from './src/main/missionLifecycle';
  export { guiMissionPaneId } from './src/main/guiMissionContracts';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  packages: 'external', write: false }).outputFiles[0].text
const loaded = { exports: {} }
new Function('require', 'module', 'exports', code)(createRequire(import.meta.url), loaded, loaded.exports)
const { buildReleaseMissions, buildMissionLifecycle, guiMissionPaneId } = loaded.exports

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-release-missions-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mission = (id, patch = {}) => ({ id, projectId: 'project', title: id,
    missionType: 'dev', status: 'ativa', direct: true, updatedAt: '2026-09-21T00:00:00.000Z', ...patch })
  const rows = new Map([
    mission('release', { missionType: 'release', versionId: 'version' }),
    mission('completed', { status: 'concluida' }), mission('active'),
    mission('archived', { status: 'arquivada' }), mission('foreign', { projectId: 'elsewhere' })
  ].map(row => [row.id, row]))
  const identity = { paneId: guiMissionPaneId('dev', 'release'), role: 'gui-release',
    missionId: 'release', projectId: 'project', cwd: root }
  const effects = [], audit = [], tickets = new Map()
  let live = identity, busy = false, cleanup = async () => {}
  const ctx = {
    projects: { get: id => id === 'project' ? { id, path: root } : undefined },
    missions: { get: id => rows.get(id), list: id => [...rows.values()].filter(m => m.projectId === id),
      update: (id, patch) => { const row = { ...rows.get(id), ...patch }; rows.set(id, row); return row },
      remove: id => { effects.push(['remove', id]); return rows.delete(id) } },
    backlog: { getVersion: id => id === 'version' ? { id, projectId: 'project', status: 'lancada' } : undefined,
      releaseMissionItems: id => effects.push(['backlog', id]) },
    integrationQueue: { getByMission: id => tickets.get(id), cancel: id => tickets.delete(id) },
    hub: { identityByPane: () => live, publish() {}, purgeMissionEvents: id => effects.push(['events', id]) },
    ptys: { has: () => false, kill: id => effects.push(['pty', id]) },
    maestro: { forget: id => effects.push(['maestro', id]) },
    blackbox: { record() {} }, syncBoard() {}, unregisterPane() {}, pushAll() {},
    orchPaneId: (project, id) => `${project}-${id}`
  }
  const lifecycle = buildMissionLifecycle(ctx, {
    engine: { emitMissionsChanged() {}, scheduleIntegrationDrain() {}, stopMissionExecution() {} },
    orchKey: (project, id) => `${project}-${id}`, emitBacklogChanged() {},
    guiSessions: { forgetWhere: predicate => effects.push(['forget', predicate(guiMissionPaneId('dev', 'completed'))]) },
    killMissionGuiPanes: async id => { effects.push(['close', id]); await cleanup(id) }
  })
  const api = buildReleaseMissions({ context: ctx, lifecycle, releaseBusy: () => busy,
    audit: (...entry) => audit.push(entry) })
  const list = () => JSON.parse(api.list(identity))
  const selection = (id = 'completed') => {
    const snapshot = list()
    assert.equal(snapshot.ok, true, snapshot.error)
    const row = snapshot.missions.find(m => m.id === id)
    assert.ok(row, `mission ${id} is visible`)
    return { missionId: row.id, expectedRevision: row.revision }
  }
  return { api, identity, rows, effects, audit, tickets, lifecycle, list, selection,
    cleanup: fn => { cleanup = fn }, setLive: value => { live = value }, busy: value => { busy = value },
    remove: async (patch = {}) => JSON.parse(await api.remove(identity, {
      ...selection(), confirmTitle: 'completed', ownerConfirmed: true, ...patch })) }
}

test('Release lists only its project and removes an explicitly selected completed mission through canonical cleanup', async t => {
  const h = fixture(t)
  assert.equal(h.list().ok, true)
  assert.deepEqual(h.list().missions.map(m => m.id).sort(), ['active', 'archived', 'completed', 'release'])
  const receipt = await h.remove()
  assert.equal(receipt.ok, true, receipt.error)
  assert.equal(h.rows.has('completed'), false)
  assert.equal(h.rows.has('foreign'), true)
  assert.ok(h.effects.find(e => e[0] === 'forget' && e[1] === true))
  assert.ok(h.effects.find(e => e[0] === 'backlog'))
  assert.ok(h.audit.find(e => e[0] === 'release-mission-removed'))
})

test('Release edits, archives and restores without marking delivery complete or changing the target project', t => {
  const h = fixture(t)
  for (const patch of [{ title: 'Renamed', goal: 'Synthetic goal' }, { status: 'arquivada' }, { status: 'ativa' }]) {
    const receipt = JSON.parse(h.api.update(h.identity, { ...h.selection('active'), ...patch }))
    assert.equal(receipt.ok, true, receipt.error)
  }
  assert.equal(h.rows.get('active').title, 'Renamed')
  assert.equal(h.rows.get('active').status, 'ativa')
  assert.equal(JSON.parse(h.api.update(h.identity, { ...h.selection('active'), status: 'concluida' })).ok, false)
  assert.equal(JSON.parse(h.api.update(h.identity, { ...h.selection('active'), projectId: 'elsewhere' })).ok, false)
})

for (const scenario of ['unconfirmed', 'wrong-title', 'stale', 'self', 'foreign', 'active', 'merging', 'recovery', 'busy', 'closed', 'revoked', 'forged', 'non-direct']) {
  test(`Release refuses ${scenario} deletion without cleanup effects`, async t => {
    const h = fixture(t)
    const input = { ...h.selection(), confirmTitle: 'completed', ownerConfirmed: true }
    if (scenario === 'unconfirmed') input.ownerConfirmed = false
    if (scenario === 'wrong-title') input.confirmTitle = 'another mission'
    if (scenario === 'stale') h.rows.get('completed').title = 'Changed after inspection'
    if (scenario === 'self') Object.assign(input, h.selection('release'), { confirmTitle: 'release' })
    if (scenario === 'foreign') input.missionId = 'foreign'
    if (scenario === 'active') Object.assign(input, h.selection('active'), { confirmTitle: 'active' })
    if (scenario === 'merging') h.tickets.set('completed', { state: 'merging' })
    if (scenario === 'recovery') h.tickets.set('completed', { state: 'blocked', block: { owner: 'orchestrator', code: 'target_repair_pending' } })
    if (scenario === 'busy') h.busy(true)
    if (scenario === 'closed') h.rows.get('release').status = 'concluida'
    if (scenario === 'revoked') h.setLive(undefined)
    if (scenario === 'forged') h.identity.role = 'gui-delegator'
    if (scenario === 'non-direct') h.rows.get('release').direct = false
    const receipt = JSON.parse(await h.api.remove(h.identity, input))
    assert.equal(receipt.ok, false)
    assert.equal(h.rows.has('completed'), true)
    assert.deepEqual(h.effects, [])
  })
}

for (const scenario of ['target', 'authority', 'queue', 'busy']) {
  test(`Release rechecks ${scenario} after waiting for cleanup`, async t => {
    const h = fixture(t)
    h.cleanup(async () => {
      await new Promise(resolve => setImmediate(resolve))
      if (scenario === 'target') h.rows.get('completed').title = 'Changed during cleanup'
      if (scenario === 'authority') h.setLive(undefined)
      if (scenario === 'queue') h.tickets.set('completed', { state: 'merging' })
      if (scenario === 'busy') h.busy(true)
    })
    assert.equal((await h.remove()).ok, false)
    assert.equal(h.rows.has('completed'), true)
    assert.equal(h.effects.some(e => e[0] === 'remove'), false)
  })
}

test('concurrent removal cannot run cleanup twice or update a mission being removed', async t => {
  const h = fixture(t)
  let resume, entered
  const gate = new Promise(resolve => { resume = resolve })
  const started = new Promise(resolve => { entered = resolve })
  t.after(() => resume())
  h.cleanup(async () => { entered(); await gate })
  const first = h.remove()
  await started
  assert.equal((await h.remove()).ok, false)
  assert.equal(JSON.parse(h.api.update(h.identity, { ...h.selection(), title: 'Racing edit' })).ok, false)
  resume()
  assert.equal((await first).ok, true)
  assert.equal(h.effects.filter(e => e[0] === 'close').length, 1)
})

test('Release directs dirty mission discard to the trash without granting discard implicitly', async t => {
  const h = fixture(t)
  let argumentsPassed
  h.lifecycle.remove = async (...args) => {
    argumentsPassed = args
    return { ok: false, error: 'Confirme o descarte abaixo.',
      discard: { token: 'synthetic-discard-secret-token', title: 'completed' } }
  }
  const result = await h.remove()
  assert.equal(result.ok, false)
  assert.match(result.error, /lixeira/iu)
  assert.equal(argumentsPassed.length, 2)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-discard-secret-token/u)
  assert.equal(h.rows.has('completed'), true)
})

test('the shared archive operation preserves a pending integration finalization ticket', t => {
  const h = fixture(t)
  h.tickets.set('active', { state: 'blocked', block: { owner: 'orchestrator', code: 'target_repair_pending' } })
  assert.equal(h.lifecycle.update('active', { status: 'arquivada' }).status, 'ativa')
  assert.equal(h.tickets.has('active'), true)
  assert.deepEqual(h.effects, [])
})

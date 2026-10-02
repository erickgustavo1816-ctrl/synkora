import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
let userData
const handlers = new Map()
const electron = {
  app: { getPath: () => userData, isPackaged: false, on() {}, once() {}, off() {} },
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
  Notification: class { static isSupported() { return false } },
  shell: {}, dialog: {}, BrowserWindow: class {}, safeStorage: { isEncryptionAvailable: () => false }
}
const code = buildSync({
  stdin: { contents: [
    "export { buildMissionLifecycle } from './src/main/missionLifecycle'",
    "export { registerMissionsIpc } from './src/main/ipc/missions'",
    "export { MissionStore } from './src/main/missions'",
    "export { BacklogStore } from './src/main/backlog'",
    "export { IntegrationQueueStore } from './src/main/integrationQueue'",
    "export { guiMissionPaneId } from './src/main/guiMissionContracts'"
  ].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  logLevel: 'error'
}).outputFiles[0].text
const bundled = { exports: {} }
new Function('require', 'module', 'exports', code)(
  name => name === 'electron' ? electron : require(name), bundled, bundled.exports
)
const { buildMissionLifecycle, registerMissionsIpc, MissionStore, BacklogStore,
  IntegrationQueueStore, guiMissionPaneId } = bundled.exports

function fixture(t, { git = false } = {}) {
  const workspace = resolve('.synkora/tmp')
  mkdirSync(workspace, { recursive: true })
  const root = mkdtempSync(join(workspace, 'mission-version-change-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(workspace + sep))
    rmSync(root, { recursive: true, force: true })
  })
  userData = join(root, 'store')
  mkdirSync(userData)
  const project = { id: 'synthetic-project', path: join(root, 'project'), versioning: 'git' }
  const source = join(root, 'source')
  mkdirSync(project.path)
  const runGit = (dir, args) => execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  if (git) {
    runGit(project.path, ['init', '-b', 'main'])
    writeFileSync(join(project.path, 'example.txt'), 'original\n')
    runGit(project.path, ['add', 'example.txt'])
    runGit(project.path, ['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'synthetic base'])
    runGit(project.path, ['branch', 'version/origin'])
    runGit(project.path, ['worktree', 'add', '-b', 'mission/synthetic', source, 'version/origin'])
    writeFileSync(join(source, 'example.txt'), 'mission commit\n')
    runGit(source, ['add', 'example.txt'])
    runGit(source, ['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'synthetic mission commit'])
  } else mkdirSync(source)
  writeFileSync(join(source, 'example.txt'), 'local tracked edits\n')
  writeFileSync(join(source, 'untracked.txt'), 'local untracked work\n')
  const backlogFile = join(userData, 'backlog.json')
  const queueFile = join(userData, 'queue.json')
  const backlog = new BacklogStore(backlogFile)
  const origin = backlog.createVersion(project.id, { name: '1.0.0' })
  const target = backlog.createVersion(project.id, { name: '1.1.0' })
  const foreign = backlog.createVersion('other-project', { name: '2.0.0' })
  const closed = backlog.createVersion(project.id, { name: '0.9.0' })
  backlog.updateVersion(closed.id, { status: 'lancada' })
  const missions = new MissionStore()
  const created = missions.create(project.id, {
    title: 'Missão sintética', goal: 'Preservar o trabalho sintético', scope: 'example.txt',
    versionId: origin.id, seatId: 'synthetic-seat', model: 'synthetic-model', effort: 'high', direct: true
  })
  const mission = missions.update(created.id, {
    branch: 'mission/synthetic', worktree: source, baseBranch: 'version/origin',
    summary: 'Resultado sintético', delivery: { capturedAt: '2026-10-01T00:00:00.000Z',
      sourceHead: 'a'.repeat(40), commits: ['synthetic mission commit'], files: ['example.txt'] }
  })
  const paneId = guiMissionPaneId('dev', mission.id)
  const conversationFile = join(userData, 'synthetic-conversation.json')
  writeFileSync(conversationFile, JSON.stringify({ paneId, sessionId: 'synthetic-session',
    transcript: [{ type: 'text', text: 'Conversa sintética preservada' }] }))
  const integrationQueue = new IntegrationQueueStore(queueFile)
  const changed = [], audit = [], effects = []
  const projects = new Map([[project.id, project]])
  let cleanup = async () => { effects.push('close-chat') }
  const ctx = {
    projects: { get: id => projects.get(id) }, missions, backlog, integrationQueue,
    seats: {}, plans: {}, maestro: { forget() { effects.push('forget-maestro') } },
    ptys: { has: () => false, kill() { effects.push('kill-pty') } },
    blackbox: { record: event => audit.push(event) },
    hub: { publish() { effects.push('publish-hub') }, purgeMissionEvents() { effects.push('purge-hub') } },
    syncBoard() { effects.push('sync-board') },
    orchPaneId: () => 'synthetic-orchestrator', unregisterPane() { effects.push('unregister-pane') }
  }
  const extras = {
    engine: {
      emitMissionsChanged: id => changed.push(id),
      scheduleIntegrationDrain() { effects.push('drain') },
      stopMissionExecution() { effects.push('stop-execution') }
    },
    orchKey: () => 'synthetic-key', emitBacklogChanged() { effects.push('backlog-changed') },
    guiSessions: { forgetWhere() { effects.push('forget-chat') } },
    killMissionGuiPanes: id => cleanup(id), maestroEngine: {}
  }
  const lifecycle = buildMissionLifecycle(ctx, extras)
  const files = ['missions.json', 'missions.json.bak', 'backlog.json', 'backlog.json.bak',
    'queue.json', 'queue.json.bak', 'synthetic-conversation.json'].map(name => join(userData, name))
  files.push(join(source, 'example.txt'), join(source, 'untracked.txt'))
  const snapshot = () => ({
    mission: structuredClone(missions.get(mission.id)), queue: integrationQueue.listPending(),
    files: files.map(file => !existsSync(file) ? null : statSync(file).isDirectory()
      ? 'directory' : readFileSync(file).toString('base64')),
    changed: [...changed], audit: structuredClone(audit), effects: [...effects]
  })
  return { root, userData, project, projects, source, runGit, missions, backlog, integrationQueue,
    origin, target, foreign, closed, mission, paneId, conversationFile, ctx, extras,
    lifecycle, changed, audit, effects, snapshot, cleanup: fn => { cleanup = fn },
    reload: () => { userData = join(root, 'store'); return new MissionStore().get(mission.id) } }
}

function refusedWithoutMutation(h, missionId, versionId, reason) {
  const before = h.snapshot()
  const result = h.lifecycle.changeVersion?.(missionId, versionId)
  assert.equal(result?.ok, false)
  assert.equal(typeof result.error, 'string')
  assert.match(result.error, reason)
  assert.deepEqual(h.snapshot(), before)
}

test('reassignment survives real store reload and preserves conversation, Git origin, commits and local work', t => {
  const h = fixture(t, { git: true })
  const before = h.reload()
  const conversation = readFileSync(h.conversationFile, 'utf8')
  const gitBefore = ['rev-parse HEAD', 'status --porcelain', 'log --oneline', 'show-ref'].map(
    args => h.runGit(h.source, args.split(' ')))
  const backlogBefore = readFileSync(join(h.userData, 'backlog.json'), 'utf8')
  const result = h.lifecycle.changeVersion?.(h.mission.id, h.target.id)
  assert.equal(result?.ok, true, 'the lifecycle must reassign an active development mission')
  const saved = h.reload()
  assert.equal(saved.versionId, h.target.id)
  assert.equal(result.mission.id, before.id)
  const { versionId: oldVersion, updatedAt: oldStamp, ...identityBefore } = before
  const { versionId: newVersion, updatedAt: newStamp, ...identityAfter } = saved
  assert.equal(oldVersion, h.origin.id)
  assert.equal(newVersion, h.target.id)
  assert.ok(newStamp >= oldStamp)
  assert.deepEqual(identityAfter, identityBefore)
  assert.deepEqual(JSON.parse(JSON.stringify(result.mission)), saved)
  assert.equal(guiMissionPaneId('dev', saved.id), h.paneId)
  assert.equal(readFileSync(h.conversationFile, 'utf8'), conversation)
  assert.equal(readFileSync(join(h.source, 'example.txt'), 'utf8'), 'local tracked edits\n')
  assert.equal(readFileSync(join(h.source, 'untracked.txt'), 'utf8'), 'local untracked work\n')
  assert.deepEqual(['rev-parse HEAD', 'status --porcelain', 'log --oneline', 'show-ref'].map(
    args => h.runGit(h.source, args.split(' '))), gitBefore)
  assert.equal(readFileSync(join(h.userData, 'backlog.json'), 'utf8'), backlogBefore)
  assert.deepEqual(h.integrationQueue.listPending(), [])
  assert.deepEqual(h.changed, [h.project.id])
  assert.deepEqual(h.effects, [])
  assert.equal(h.audit.length, 1)
  assert.deepEqual(h.audit[0], {
    cat: 'app', event: 'mission-version-changed', actor: 'user',
    ids: { projectId: h.project.id, missionId: h.mission.id },
    detail: { previousVersionId: h.origin.id, targetVersionId: h.target.id }
  })
})

for (const invalid of [undefined, null, false, 7, {}, [], '', ' ', '\n', 'x'.repeat(257)]) {
  for (const argument of ['mission', 'version']) {
    test(`rejects invalid ${argument} argument ${JSON.stringify(invalid)} without mutation`, t => {
      const h = fixture(t)
      refusedWithoutMutation(h, argument === 'mission' ? invalid : h.mission.id,
        argument === 'version' ? invalid : h.target.id, /válid|escolh|lista/iu)
    })
  }
}

for (const [name, change, reason] of [
  ['missing mission', h => ['missing-mission', h.target.id], /missão|encontrad/iu],
  ['missing project', h => { h.projects.clear(); return [h.mission.id, h.target.id] }, /projeto/iu],
  ['unversioned project', h => { h.project.versioning = 'none'; return [h.mission.id, h.target.id] }, /não é versionado|não.*versões/iu],
  ['missing target', h => [h.mission.id, 'missing-version'], /versão|versões/iu],
  ['foreign target', h => [h.mission.id, h.foreign.id], /projeto/iu],
  ['closed target', h => [h.mission.id, h.closed.id], /aberta/iu],
  ['pending owner approval', h => { h.missions.update(h.mission.id, { pendingIntegrationApproval: true }); return [h.mission.id, h.target.id] }, /integração/iu]
]) {
  test(`rejects ${name} without mutation`, t => {
    const h = fixture(t)
    const [missionId, versionId] = change(h)
    refusedWithoutMutation(h, missionId, versionId, reason)
  })
}

for (const origin of ['absent', 'closed', 'missing', 'foreign']) {
  test(`active source association ${origin} moves to an eligible target while preserving Git origin`, t => {
    const h = fixture(t)
    if (origin === 'closed') h.backlog.updateVersion(h.origin.id, { status: 'lancada' })
    if (origin === 'absent') delete h.missions.get(h.mission.id).versionId
    if (origin === 'missing') h.missions.get(h.mission.id).versionId = 'missing-origin'
    if (origin === 'foreign') h.missions.get(h.mission.id).versionId = h.foreign.id
    const { versionId, updatedAt, ...before } = structuredClone(h.missions.get(h.mission.id))
    const conversation = readFileSync(h.conversationFile, 'utf8')
    const result = h.lifecycle.changeVersion?.(h.mission.id, h.target.id)
    assert.equal(result?.ok, true)
    assert.equal(result.mission.versionId, h.target.id)
    const { versionId: savedVersion, updatedAt: savedStamp, ...after } = h.reload()
    assert.equal(savedVersion, h.target.id)
    assert.ok(savedStamp >= updatedAt)
    assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)))
    assert.equal(result.mission.baseBranch, 'version/origin')
    assert.equal(h.audit[0].detail.previousVersionId, versionId)
    assert.equal(readFileSync(h.conversationFile, 'utf8'), conversation)
    assert.deepEqual(h.effects, [])
  })
}

for (const status of ['arquivada', 'concluida', 'integrando']) {
  test(`rejects ${status} missions without mutation`, t => {
    const h = fixture(t)
    h.missions.update(h.mission.id, { status })
    refusedWithoutMutation(h, h.mission.id, h.target.id, /ativa/iu)
  })
}

for (const input of [{ missionType: 'planejamento' }, { missionType: 'release' }, { kind: 'direta' }]) {
  test(`rejects unsupported mission ${JSON.stringify(input)} without mutation`, t => {
    const h = fixture(t)
    Object.assign(h.missions.get(h.mission.id), input)
    refusedWithoutMutation(h, h.mission.id, h.target.id, /desenvolvimento/iu)
  })
}

for (const state of ['queued', 'sync_required', 'blocked', 'merging', 'finalization']) {
  for (const destination of ['other', 'current']) {
    test(`rejects real queue ${state} even for ${destination} destination without mutation`, t => {
      const h = fixture(t)
      h.integrationQueue.enqueue({ projectId: h.project.id, missionId: h.mission.id,
        requestedBy: 'user', targetKind: 'version', versionId: h.origin.id })
      const block = { code: 'synthetic-block', owner: 'orchestrator', detail: 'Synthetic pending integration' }
      if (state === 'sync_required') h.integrationQueue.requireSync(h.mission.id, block)
      if (state === 'blocked') h.integrationQueue.block(h.mission.id, block)
      if (state === 'merging') h.integrationQueue.beginMerge(h.mission.id)
      if (state === 'finalization') h.integrationQueue.requireTargetRepair(h.mission.id, 'Synthetic pending finalization')
      refusedWithoutMutation(h, h.mission.id, destination === 'current' ? h.origin.id : h.target.id, /integração/iu)
    })
  }
}

test('current version is an idempotent success without persistence, events or audit', t => {
  const h = fixture(t)
  const before = h.snapshot()
  const result = h.lifecycle.changeVersion?.(h.mission.id, h.origin.id)
  assert.equal(result?.ok, true)
  assert.equal(result.mission.versionId, h.origin.id)
  assert.deepEqual(h.snapshot(), before)
})

test('uses the canonical eligible version choices rather than an independent open-version check', t => {
  const h = fixture(t)
  h.backlog.missionVersionChoices = () => ({ versions: [h.origin], defaultVersionId: h.origin.id })
  refusedWithoutMutation(h, h.mission.id, h.target.id, /aberta|disponível/iu)
})

test('supports an active legacy development mission and leaves another mission unchanged', t => {
  const h = fixture(t)
  delete h.missions.get(h.mission.id).direct
  const other = h.missions.create(h.project.id, { title: 'Outra missão', versionId: h.origin.id, direct: true })
  const before = structuredClone(other)
  assert.equal(h.lifecycle.changeVersion?.(h.mission.id, h.target.id)?.ok, true)
  assert.deepEqual(h.missions.get(other.id), before)
  assert.equal(h.reload().versionId, h.target.id)
})

test('store write failure returns a sanitized refusal and keeps memory unchanged', t => {
  const h = fixture(t)
  const file = join(h.userData, 'missions.json')
  const current = readFileSync(file)
  rmSync(file)
  mkdirSync(file)
  const before = h.snapshot()
  try {
    refusedWithoutMutation(h, h.mission.id, h.target.id, /não consegui|tente/iu)
    assert.deepEqual(h.snapshot(), before)
  } finally {
    rmdirSync(file)
    writeFileSync(file, current)
  }
})

test('metadata IPC cannot smuggle version or immutable workspace fields into persisted metadata', t => {
  const h = fixture(t)
  registerMissionsIpc(h.ctx, { ...h.extras, lifecycle: h.lifecycle })
  const update = handlers.get('missions:update')
  const before = h.reload()
  update({}, h.mission.id, { title: 'Título revisado', versionId: h.foreign.id,
    projectId: 'other-project', branch: 'forged', worktree: 'forged', baseBranch: 'forged',
    missionType: 'release', direct: false, pendingIntegrationApproval: true })
  const saved = h.reload()
  const { title: beforeTitle, updatedAt: beforeStamp, ...beforeIdentity } = before
  const { title: afterTitle, updatedAt: afterStamp, ...afterIdentity } = saved
  assert.equal(beforeTitle, 'Missão sintética')
  assert.equal(afterTitle, 'Título revisado')
  assert.ok(afterStamp >= beforeStamp)
  assert.deepEqual(afterIdentity, beforeIdentity)
})

for (const patch of [null, undefined]) {
  test(`metadata IPC preserves harmless ${patch} patch behavior`, t => {
    const h = fixture(t)
    registerMissionsIpc(h.ctx, { ...h.extras, lifecycle: h.lifecycle })
    const { updatedAt, ...before } = h.reload()
    const result = handlers.get('missions:update')({}, h.mission.id, patch)
    assert.equal(result.id, h.mission.id)
    const { updatedAt: savedStamp, ...after } = h.reload()
    assert.ok(savedStamp >= updatedAt)
    assert.deepEqual(after, before)
  })
}

test('dedicated IPC authenticates the sender and returns the lifecycle result without extra renderer fields', t => {
  const h = fixture(t)
  const trusted = { sender: 'synthetic-app-renderer' }
  const checked = []
  registerMissionsIpc(h.ctx, { ...h.extras, lifecycle: h.lifecycle,
    assertAppRendererSender: event => { checked.push(event); assert.equal(event, trusted) } })
  const change = handlers.get('missions:changeVersion')
  assert.ok(change, 'missions:changeVersion must be registered')
  const result = change(trusted, h.mission.id, h.target.id, { worktree: 'forged', versionId: h.foreign.id })
  assert.equal(result.ok, true)
  assert.equal(h.reload().versionId, h.target.id)
  assert.equal(h.missions.get(h.mission.id).worktree, h.source)
  assert.deepEqual(checked, [trusted])
  const before = h.snapshot()
  const denied = change({ sender: 'foreign-renderer' }, h.mission.id, h.origin.id)
  assert.equal(denied.ok, false)
  assert.match(denied.error, /autoriz|janela|Synkora/iu)
  assert.deepEqual(h.snapshot(), before)
  const invalid = change(trusted, h.mission.id, { versionId: h.origin.id })
  assert.equal(invalid.ok, false)
  assert.deepEqual(h.snapshot(), before)
})

test('lifecycle removal lock rejects a concurrent version change before the active-status check', async t => {
  const h = fixture(t, { git: true })
  h.missions.update(h.mission.id, { status: 'arquivada' })
  let release
  h.cleanup(() => new Promise(resolve => { release = resolve }))
  const removing = h.lifecycle.remove(h.mission.id)
  assert.equal(typeof release, 'function')
  try {
    h.missions.update(h.mission.id, { status: 'ativa' })
    refusedWithoutMutation(h, h.mission.id, h.target.id, /exclusão|excluída/iu)
  } finally { release() }
  assert.equal((await removing).ok, false)
  assert.ok(h.missions.get(h.mission.id))
  assert.equal(h.lifecycle.changeVersion?.(h.mission.id, h.target.id)?.ok, true)
})

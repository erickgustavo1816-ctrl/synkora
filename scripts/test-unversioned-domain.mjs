import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const output = join(root, '.tmp', 'unversioned-domain-test')
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
  '--outDir', output, '--rootDir', 'src', '--target', 'ES2022', '--module', 'Node16',
  '--moduleResolution', 'Node16', '--esModuleInterop', '--skipLibCheck', '--noCheck', '--types', 'node',
  ...['projects', 'missions', 'backlog', 'plans', 'panes', 'files'].map(name => `src/main/ipc/${name}.ts`)
], { cwd: root, stdio: 'pipe' })
// Replay the same assertions against a committed implementation without
// modifying/stashing the shared worktree. Only ignored compiled output changes.
if (process.env.SYNKORA_UNVERSIONED_BASE_REF) {
  const { transformSync } = require('esbuild')
  for (const file of ['backlog', 'directRelease', 'fileActions', 'missionEngine', 'missionLifecycle', 'projectFolder',
    ...['projects', 'missions', 'backlog', 'plans', 'panes', 'files'].map(name => `ipc/${name}`)]) {
    const source = execFileSync('git', ['show', `${process.env.SYNKORA_UNVERSIONED_BASE_REF}:src/main/${file}.ts`],
      { cwd: root, encoding: 'utf8' })
    const result = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' })
    writeFileSync(join(output, 'main', file + '.js'), result.code)
  }
}
const temporary = join(root, '.synkora', 'unversioned-test-data')
mkdirSync(temporary, { recursive: true })
const scratch = mkdtempSync(join(temporary, 'run-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
let userData = scratch
let pickedPath
const handlers = new Map()
const gitCalls = []
const baselineCalls = []
const git = new Proxy({}, { get: (_target, name) => (...args) => {
  gitCalls.push({ name, args })
  if (name === 'hasGitCommit' || name === 'initGitRepo') return false
  return undefined
} })
const electron = {
  app: { getPath: () => userData, getAppPath: () => join(scratch, 'app'), getName: () => 'test',
    getVersion: () => '0.0.0', on() {}, once() {}, off() {}, isPackaged: false },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on() {} },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [pickedPath] }) },
  shell: {}, clipboard: {}, nativeImage: {}, Notification: class { static isSupported() { return false } }
}
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return electron
  if (/(^|[\\/])gitAsync(?:\.js)?$/.test(request)) return {
    gitOff: async (name, ...args) => git[name](...args),
    gitOffWithCheckpoint: async (...args) => git.checkpoint(...args)
  }
  if (/(^|[\\/])worktree(?:\.js)?$/.test(request)) return git
  if (/(^|[\\/])projectSecurityBaseline(?:\.js)?$/.test(request)) return {
    ensureProjectSecurityBaseline: (...args) => baselineCalls.push(args)
  }
  if (request.endsWith('.ts') && parent?.filename.startsWith(output)) request = request.slice(0, -3) + '.js'
  return originalLoad.call(this, request, parent, isMain)
}
const main = name => require(join(output, 'main', name + '.js'))
const { ProjectStore } = main('projects')
const { MissionStore } = main('missions')
const { BacklogStore } = main('backlog')
const { PlanStore } = main('plans')
const { createMissionEngine } = main('missionEngine')
const { buildMissionLifecycle } = main('missionLifecycle')
const { resolveFileActionRoot } = main('fileActions')
const { projectVersioning, unversionedRefusal } = require(join(output, 'shared', 'projectVersioning.js'))

function harness(versioning = 'none') {
  userData = mkdtempSync(join(scratch, 'store-'))
  const folder = join(userData, 'product')
  mkdirSync(folder)
  writeFileSync(join(folder, 'document.txt'), 'original bytes\n')
  handlers.clear(); gitCalls.length = 0; baselineCalls.length = 0
  const projects = new ProjectStore()
  const project = projects.create('Synthetic', folder, versioning)
  const missions = new MissionStore()
  const backlog = new BacklogStore(undefined, id => projectVersioning(projects.get(id)) === 'none' ? unversionedRefusal('versions') : undefined)
  const plans = new PlanStore()
  const events = [], stopped = [], live = new Set(), chats = new Set(), helpers = new Set()
  let waitForTeardown = async () => {}
  let waitForProjectTeardown = async () => {}
  const ctx = {
    projects, missions, backlog, plans, blackbox: { record() {} },
    maestro: { get: () => ({}), forget() {}, update() {} }, seats: { list: () => [], get: id => ({ id, cli: 'claude' }), preseed() {}, configDirOf: () => userData },
    ptys: { has: id => live.has(id), kill: id => { live.delete(id); stopped.push(id) } },
    hub: { publish() {}, panesOf: () => [], purgeMissionEvents() {}, registerPane() {}, identityByToken() {} },
    integrationQueue: { listPending: () => [], getByMission() {} },
    integrationDrainTimers: new Map(), integrationDraining: new Set(),
    testServerPanes: new Map(), livePaneSpecs: new Map(), closingPaneIds: new Set(),
    paneTokens: new Map(), paneMcpFiles: new Map(), mcpPort: 0,
    syncBoard() {}, scheduleProgressSnapshot() {}, ensureProjectRuntimeWritable() {},
    pushAll: (...args) => events.push(args), unregisterPane() {},
    orchPaneId: (_p, m) => `orch-${m}`, mainStalls: { wrap: (_name, fn) => fn }
  }
  const extras = {
    orchKey: (_p, m) => `orch-${m}`, emitBacklogChanged() {},
    versionIsolationIsValid: () => false, versionIsolationProbe: async () => false,
    sweepProjectFiles() {}, closeTestServersUnder() {}, deliverToGuiPane: () => false,
    async killMissionGuiPanes(missionId) {
      chats.delete(missionId)
      await waitForTeardown()
      helpers.delete(missionId)
      stopped.push(`gui-${missionId}`)
    },
    guiSessions: { remembered() {}, has: () => false, forgetWhere() {}, killWhere() {} },
    maestroEngine: {}, staggerPaneSpawn: async () => {}, assertAppRendererSender() {},
    killProjectGuiPanes: async () => waitForProjectTeardown(), killMaestroSession() {}, ensureBypassAccepted() {}, syncProjectLayout() {},
    listProjectReleases: () => [], listVersionReleases: () => [], releaseVersionImpl: async () => 'unexpected release',
    resolveReleaseWorkspace: async () => { throw new Error('release workspace reached') }
  }
  const engine = createMissionEngine(ctx, extras)
  extras.engine = engine
  const lifecycle = buildMissionLifecycle(ctx, extras)
  extras.lifecycle = lifecycle
  extras.stopSoloMission = (id, afterStop) => lifecycle.stopSolo(id, afterStop)
  for (const name of ['projects', 'missions', 'backlog', 'plans', 'files']) {
    main(`ipc/${name}`)[`register${name[0].toUpperCase() + name.slice(1)}Ipc`](ctx, extras)
  }
  main('ipc/panes').registerPanesIpc(ctx, { ensureMissionWorktree: engine.ensureMissionWorktree,
    engine: { ...ctx, harnessPortsInUse: () => [] } })
  const call = (name, ...args) => {
    assert.equal(typeof handlers.get(name), 'function', `missing handler ${name}`)
    return handlers.get(name)({}, ...args)
  }
  const seed = input => missions.create(project.id, { title: 'Document', direct: true, ...input })
  return { ctx, extras, engine, lifecycle, project, folder, missions, projects, backlog, plans,
    events, stopped, live, chats, helpers, call, seed, teardown: fn => { waitForTeardown = fn },
    projectTeardown: fn => { waitForProjectTeardown = fn } }
}
function noGit() { assert.deepEqual(gitCalls, [], 'unversioned flows must never start Git') }
async function rejectsCapability(fn, capability) {
  await assert.rejects(async () => fn(), error => error.message.includes(unversionedRefusal(capability)))
}
function treeBytes(folder) {
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => [join(entry.parentPath ?? entry.path, entry.name).slice(folder.length),
      readFileSync(join(entry.parentPath ?? entry.path, entry.name)).toString('base64')]).sort()
}

test('project IPC persists none; omitted modality preserves legacy Git registration', async () => {
  const h = harness()
  const p = await h.call('projects:create', 'Plain', join(h.folder, 'plain'), undefined, 'none')
  assert.equal(projectVersioning(new ProjectStore().get(p.id)), 'none')
  assert.equal(baselineCalls.length, 1); noGit()
  const legacy = await h.call('projects:create', 'Legacy', join(h.folder, 'legacy'))
  assert.equal(projectVersioning(legacy), 'git')
  assert.equal(Object.hasOwn(legacy, 'versioning'), false)
  assert.ok(gitCalls.some(call => call.name === 'ensureSynkoraGitExcludes'))
})
for (const kind of ['git-remote', 'git-file', 'git-directory']) test(`project create refuses ${kind} before Git`, async () => {
  const h = harness()
  if (kind === 'git-file') writeFileSync(join(h.folder, '.git'), 'gitdir: elsewhere')
  if (kind === 'git-directory') mkdirSync(join(h.folder, '.git'))
  await rejectsCapability(() => h.call('projects:create', 'No', h.folder,
    kind === 'git-remote' ? 'https://example.invalid/synthetic.git' : undefined, 'none'),
    kind === 'git-remote' ? 'git-remote' : 'git-folder')
  assert.equal(h.projects.list().length, 1); noGit()
})
test('inspectFolder uses filesystem, including Git files and effectively empty metadata', async () => {
  const h = harness(), path = join(h.folder, 'new')
  assert.deepEqual(await h.call('projects:inspectFolder', path), { exists: false, hasGit: false, empty: true })
  mkdirSync(path); mkdirSync(join(path, '.synkora')); writeFileSync(join(path, '.git'), 'gitdir: x')
  assert.deepEqual(await h.call('projects:inspectFolder', path), { exists: true, hasGit: true, empty: true })
  writeFileSync(join(path, 'note.txt'), 'a')
  assert.equal((await h.call('projects:inspectFolder', path)).empty, false)
  await assert.rejects(async () => h.call('projects:inspectFolder', 'relative'), /absoluto/)
  await assert.rejects(async () => h.call('projects:inspectFolder', join(scratch, 'app', 'nested')), /Synkora/)
  noGit()
})
test('mission creates synchronously in root without version, worktree or branch and reopens there', async () => {
  const h = harness()
  mkdirSync(join(h.folder, '.git')) // A later filesystem change never changes the recorded intent.
  const m = await h.call('missions:create', h.project.id, { title: 'Work', versionId: 'forged', direct: false })
  assert.ok(m); assert.equal(m.direct, true)
  for (const key of ['versionId', 'branch', 'baseBranch', 'worktree']) assert.equal(m[key], undefined)
  assert.deepEqual(h.backlog.listVersions(h.project.id), [])
  assert.equal(await h.engine.missionWorkspacePath(h.folder, m), h.folder)
  assert.equal((await h.engine.ensureMissionWorktree(m.id)).worktree, undefined)
  assert.equal((await h.call('missions:shellSpec', m.id)).spec.cwd, h.folder)
  h.missions.update(m.id, { seatId: 'seat-1' })
  h.ctx.mcpPort = 12345
  const gui = await h.call('missions:guiSpec', m.id, 'dev')
  assert.equal(gui.spawn?.cwd, h.folder, gui.error)
  assert.equal(gui.spawn.mcp?.env.SYNKORA_PROJECT_VERSIONING, 'none')
  assert.equal(h.missions.get(m.id).worktree, undefined); noGit()
})
for (const concurrent of [false, true]) test(`second mission refused (${concurrent ? 'concurrent' : 'sequential'})`, async () => {
  const h = harness()
  const first = h.engine.createMissionImpl(h.project.id, { title: 'one' }, 'user')
  if (!concurrent) await first
  const second = h.engine.createMissionImpl(h.project.id, { title: 'two' }, 'user')
  await rejectsCapability(() => second, 'second-mission')
  await first; assert.equal(h.missions.list(h.project.id).length, 1); noGit()
})
for (const [missionType, refusal] of [['planejamento', 'planning'], ['release', 'release']]) test(`mission refuses ${missionType}`, async () => {
  const h = harness()
  await rejectsCapability(() => h.call('missions:create', h.project.id, { title: 'No', missionType }), refusal)
  assert.deepEqual(h.missions.list(h.project.id), []); noGit()
})
test('finish waits for helpers, stops shells/tests, preserves bytes, is idempotent and frees the root', async () => {
  const h = harness(), m = h.seed(), before = treeBytes(h.folder)
  h.chats.add(m.id); h.helpers.add(m.id)
  for (const purpose of ['mission-shell', 'test-server']) {
    h.live.add(purpose)
    h.ctx.testServerPanes.set(purpose, { projectId: h.project.id, missionId: m.id, cwd: h.folder, purpose })
  }
  let release
  h.teardown(() => new Promise(resolve => { release = resolve }))
  const finishing = h.call('missions:finish', m.id)
  const duplicate = h.call('missions:finish', m.id)
  await Promise.resolve()
  assert.equal(h.missions.get(m.id).status, 'ativa')
  await rejectsCapability(() => h.call('missions:create', h.project.id, { title: 'too soon' }), 'second-mission')
  assert.equal((await h.call('missions:shellSpec', m.id)).ok, false)
  release()
  assert.deepEqual(await finishing, { ok: true })
  assert.deepEqual(await duplicate, { ok: true })
  assert.equal(h.chats.size, 0); assert.equal(h.helpers.size, 0); assert.equal(h.live.size, 0)
  assert.equal(h.ctx.testServerPanes.size, 0)
  const completed = h.missions.get(m.id)
  assert.equal(completed.status, 'concluida'); assert.ok(completed.completedAt)
  assert.ok(h.events.some(e => e[0] === 'missions:changed'))
  const stops = h.stopped.length
  assert.deepEqual(await h.call('missions:finish', m.id), { ok: true })
  assert.equal(h.stopped.length, stops)
  assert.equal(h.missions.get(m.id).completedAt, completed.completedAt)
  assert.ok(await h.call('missions:create', h.project.id, { title: 'next' }))
  assert.deepEqual(treeBytes(h.folder), before); noGit()
})
test('finish is unavailable for versioned missions and a failed teardown keeps solo mission open', async () => {
  const legacy = harness('git'), old = legacy.seed()
  assert.match((await legacy.call('missions:finish', old.id)).error, /⇪/)
  const h = harness(), m = h.seed()
  h.teardown(async () => { throw new Error('synthetic teardown failure') })
  assert.equal((await h.call('missions:finish', m.id)).ok, false)
  assert.equal(h.missions.get(m.id).status, 'ativa'); noGit()
})
test('metadata edits remain possible but status changes and reopening refuse', async () => {
  const h = harness(), m = h.seed()
  assert.equal(h.call('missions:update', m.id, { title: 'Changed', goal: 'Write' }).title, 'Changed')
  await rejectsCapability(() => h.call('missions:update', m.id, { status: 'arquivada' }), 'integration')
  await rejectsCapability(() => h.call('missions:update', m.id, { status: 'concluida' }), 'integration')
  h.missions.update(m.id, { status: 'concluida' })
  await rejectsCapability(() => h.call('missions:update', m.id, { status: 'ativa' }), 'reopen'); noGit()
})
test('removing concluded solo history cannot touch even a stale worktree path', async () => {
  const h = harness(), m = h.seed(), before = treeBytes(h.folder)
  h.missions.update(m.id, { status: 'concluida', worktree: h.folder, branch: 'stale' })
  assert.deepEqual(await h.call('missions:remove', m.id), { ok: true })
  assert.equal(h.missions.get(m.id), undefined)
  assert.deepEqual(treeBytes(h.folder), before); noGit()
})
for (const [channel, args, capability] of [
  ['missions:integrate', [], 'integration'], ['missions:workspaceFiles', [], 'history'],
  ['missions:workspaceFileDiff', ['document.txt'], 'history'], ['missions:commits', [], 'history'],
  ['missions:commitDiff', ['a'.repeat(40)], 'history'], ['missions:guiSpec', ['reviewer'], 'review']
]) test(`${channel} refuses ${capability}`, async () => {
  const h = harness(), m = h.seed()
  const result = await h.call(channel, m.id, ...args)
  assert.equal(typeof result === 'string' ? result : result.error, unversionedRefusal(capability)); noGit()
})
test('versions and release routes refuse and lists hide stale versions', async () => {
  const h = harness()
  const v = { id: 'stale', projectId: h.project.id, name: 'V1.0', status: 'aberta', deliveries: [] }
  h.backlog.getVersion = () => v
  assert.equal((await h.call('backlog:createVersion', h.project.id, { name: 'V1.0' })).error, unversionedRefusal('versions'))
  assert.equal((await h.call('backlog:directRelease', h.project.id, { title: 'No', versionId: v.id })).error, unversionedRefusal('release'))
  assert.equal((await h.call('backlog:releaseChat', v.id)).error, unversionedRefusal('release'))
  assert.deepEqual(await h.call('backlog:listVersions', h.project.id), [])
  assert.deepEqual((await h.call('missions:versionChoices', h.project.id)).versions, []); noGit()
})
test('planning GUI and all plan mutations refuse before writes', async () => {
  const h = harness()
  const created = h.plans.create(h.project.id, { title: 'Plan', kind: 'livre', items: [] }, { manual: true })
  assert.equal(created.ok, true)
  const id = created.plan.id, at = created.plan.updatedAt
  assert.equal((await h.call('projects:planningGuiSpec', h.project.id)).error, unversionedRefusal('planning'))
  for (const [channel, args] of [
    ['plans:create', [h.project.id, { title: 'No', items: [] }]], ['plans:update', [id, { title: 'No' }, at]],
    ['plans:archive', [id, at]], ['plans:setKind', [id, 'mestre', at]], ['plans:remove', [id, at]],
    ['plans:linkMission', [id, 'item', 'mission', at]]
  ]) assert.equal((await h.call(channel, ...args)).error, unversionedRefusal('planning'), channel)
  assert.equal(h.plans.get(id).title, 'Plan'); noGit()
})
test('files and test terminals use the active solo root; concluded scopes stay closed', async () => {
  const h = harness(), m = h.seed()
  const lookup = { project: id => h.projects.get(id), mission: id => h.missions.get(id) }
  assert.equal(resolveFileActionRoot({ projectId: h.project.id, missionId: m.id }, lookup), h.folder)
  const tree = await h.call('files:listTree', h.project.id, { kind: 'mission', missionId: m.id })
  assert.ok(tree.entries.some(e => e.path === 'document.txt'), tree.error)
  writeFileSync(join(h.folder, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
  const terminal = await h.call('panes:testServerSpec', h.project.id, { missionId: m.id })
  assert.equal(terminal.cwd, h.folder, terminal.msg)
  assert.equal(h.ctx.testServerPanes.get(terminal.paneId).missionId, m.id)
  h.missions.update(m.id, { status: 'concluida' })
  assert.throws(() => resolveFileActionRoot({ projectId: h.project.id, missionId: m.id }, lookup))
  assert.equal((await h.call('panes:testServerSpec', h.project.id, { missionId: m.id })).ok, false); noGit()
})
test('relocate stops solo writers and uses the new root without Git repair', async () => {
  const h = harness(), m = h.seed()
  h.chats.add(m.id); h.helpers.add(m.id)
  pickedPath = join(dirname(h.folder), 'relocated'); mkdirSync(pickedPath)
  assert.equal((await h.call('projects:relocate', h.project.id)).ok, true)
  assert.equal(h.chats.size, 0); assert.equal(h.helpers.size, 0)
  assert.equal(h.missions.get(m.id).status, 'ativa')
  assert.equal((await h.call('missions:shellSpec', m.id)).spec.cwd, pickedPath); noGit()
})

for (const method of ['missionIntegrationStatus', 'runMissionIntegration']) test(`${method} refuses before inspecting the queue`, async () => {
  const h = harness(), m = h.seed()
  assert.equal(await h.engine[method](h.project.id, m.id), unversionedRefusal('integration')); noGit()
})
test('mission recovery, target resolution and version helpers do not reach Git or create versions', async () => {
  const h = harness(), m = h.seed()
  assert.equal(h.engine.ensureMissionVersion(h.project.id, { name: 'V1.0' }).error, unversionedRefusal('versions'))
  await h.engine.recoverMissionIntegrationIntents(h.project.id)
  assert.equal(await h.engine.resolveMissionIntegrationTarget(h.project, m), undefined)
  noGit()
})
test('backlog store refuses implicit and explicit versions for a registered solo project', async () => {
  const h = harness()
  await rejectsCapability(() => h.backlog.createVersion(h.project.id, { name: 'V1.0' }), 'versions')
  await rejectsCapability(() => h.backlog.ensureDefaultVersion(h.project.id), 'versions')
  assert.deepEqual(h.backlog.missionVersionChoices(h.project.id), { versions: [], defaultVersionId: undefined })
  assert.deepEqual(new BacklogStore(undefined, id => projectVersioning(h.projects.get(id)) === 'none' ? unversionedRefusal('versions') : undefined).listVersions(h.project.id), []); noGit()
})

for (const channel of ['missions:shellSpec', 'missions:guiSpec']) test(`finish closes the ${channel} race after root proof`, async () => {
  const h = harness(), m = h.seed({ seatId: 'seat-1' })
  const opening = h.call(channel, m.id, 'dev')
  if (channel === 'missions:guiSpec') await Promise.resolve() // let pane staggering finish
  const finishing = h.call('missions:finish', m.id)
  const result = await opening
  assert.equal(result.ok, false, 'a pane cannot respawn after teardown has started')
  assert.deepEqual(await finishing, { ok: true })
  assert.equal(h.ctx.testServerPanes.size, 0); noGit()
})

test('relocation drains terminals opened while project teardown awaits', async () => {
  const h = harness(), m = h.seed()
  pickedPath = join(dirname(h.folder), 'relocated'); mkdirSync(pickedPath)
  let reached, release
  const entered = new Promise(resolve => { reached = resolve })
  h.projectTeardown(() => { reached(); return new Promise(resolve => { release = resolve }) })
  const relocating = h.call('projects:relocate', h.project.id)
  await entered
  await h.call('missions:shellSpec', m.id)
  release()
  assert.equal((await relocating).ok, true)
  assert.equal(h.ctx.testServerPanes.size, 0, 'no terminal may retain the previous project cwd')
  noGit()
})

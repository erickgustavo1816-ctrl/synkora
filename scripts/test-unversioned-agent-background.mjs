import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { load, sourceFunction, readSource } from './test-unversioned-agent-fixture.mjs'

const { isUnversionedProject, projectVersioning, unversionedRefusal } = load('src/shared/projectVersioning.ts')
const { Hub } = load('src/main/hub.ts')

test('closing a solo mission cancels helpers even without a live developer pane and invalidates its root LSP', async () => {
  const calls = []
  const contracts = load('src/main/guiMissionContracts.ts')
  const { GuiHelperEngine } = load('src/main/guiHelperSessions.ts')
  const spawn = () => ({ send() {}, dispose: () => calls.push(['disposed']) })
  const engine = new GuiHelperEngine({ spawnClaude: spawn, spawnCodex: spawn,
    resolveSeat: () => ({ seatId: 'synthetic', configDir: '/synthetic/seat' }),
    spawnIntervalMs: 0, setTimer: () => () => {}, newId: () => 'orphan-helper' })
  const receipt = engine.spawn({ paneId: 'gui-dev-12345678', projectId: 'solo', cwd: '/synthetic/project',
    cli: 'claude', model: 'opus', seatId: 'synthetic' }, [{ prompt: 'synthetic task' }])
  assert.equal(receipt.receipts[0].ok, true)
  assert.equal(engine.liveCount(), 1)
  const stop = sourceFunction('src/main/index.ts', 'killMissionGuiPanes', {
    mobile: { closeMission: async () => {} }, guiSessions: { killWhere: () => calls.push(['panes']) },
    missions: { get: () => ({ id: '12345678-mission', projectId: 'solo' }) },
    projects: { get: () => ({ versioning: 'none', path: '/synthetic/project' }) },
    lspManager: { invalidate: root => calls.push(['lsp', root]) }, browserPanes: { closeMission() {} },
    guiHelperEngine: engine,
    isGuiMissionPaneId: contracts.isGuiMissionPaneId, guiMissionPaneId: contracts.guiMissionPaneId,
    isUnversionedProject
  })
  await stop('12345678-mission')
  assert.equal(engine.get('orphan-helper').state, 'cancelled')
  assert.equal(engine.liveCount(), 0)
  assert.deepEqual(calls, [['disposed'], ['lsp', '/synthetic/project'], ['panes']])
})

test('boot and recovery never run Git or integration reconciliation for solo projects', async () => {
  const source = readSource('src/main/index.ts')
  const begin = source.indexOf('  const HELPER_TTL =')
  const end = source.indexOf('  void startInternalMcp()', begin)
  assert.ok(begin > 0 && end > begin)
  const calls = []
  const record = name => () => { calls.push(name) }
  const deps = {
    projects: { list: () => [{ id: 'solo', path: '/synthetic/project', versioning: 'none' }] },
    missions: { list: () => [{ id: 'old', status: 'concluida' }, { id: 'pending', status: 'integrando' }], update: record('reset') },
    ensureSynkoraGitExcludes: record('excludes'), pruneWorktrees: record('prune'),
    recoverMissionIntegrationIntents: record('integration'), recoverVersionReleaseIntents: record('release'),
    reconcileConcludedMission: record('reconcile'), scheduleIntegrationDrain: record('drain'),
    releaseMutationLocks: new Set(), integrationQueue: { head: () => ({ id: 'stale' }) },
    app: { getPath: () => '/synthetic/data' }, join, readdirSync: () => [], unlinkSync() {}, statSync: () => ({ mtimeMs: 0 }),
    mainStalls: { begin: () => () => {} }, sweepProjectFiles() {}, syncBoard() {},
    isUnversionedProject, projectVersioning
  }
  const code = transformSync(source.slice(begin, end), { loader: 'ts', target: 'es2022' }).code
  await new Function(...Object.keys(deps), `return (async () => { ${code} })()`)(...Object.values(deps))
  assert.deepEqual(calls, [])
})

test('backlog wiring rejects implicit versions for solo projects', () => {
  const source = readSource('src/main/index.ts')
  const begin = source.indexOf('  const backlog = new BacklogStore(')
  const end = source.indexOf('  const projectContext =', begin)
  let refusal
  const deps = { BacklogStore: class { constructor(_file, guard) { refusal = guard?.('solo') } },
    projects: { get: () => ({ versioning: 'none' }) }, isUnversionedProject, unversionedRefusal }
  const code = transformSync(source.slice(begin, end), { loader: 'ts', target: 'es2022' }).code
  new Function(...Object.keys(deps), code)(...Object.values(deps))
  assert.match(refusal ?? '', /não existem versões/u)
})

test('Board and sweep use the runtime guard without starting Git for a solo project', () => {
  const calls = []
  const deps = { projects: { get: () => ({ id: 'solo', path: '/synthetic', versioning: 'none' }) },
    missions: { list: () => [] }, ensureSynkoraGitExcludes: () => calls.push('git'), isUnversionedProject,
    join, readdirSync: () => [], mkdirSync() {}, writeFileSync: () => calls.push('board'), pushAll() {}, scheduleProgressSnapshot() {} }
  deps.ensureProjectRuntimeWritable = sourceFunction('src/main/index.ts', 'ensureProjectRuntimeWritable', deps)
  sourceFunction('src/main/index.ts', 'sweepProjectFiles', deps)('solo')
  sourceFunction('src/main/index.ts', 'syncBoardInner', deps)('solo')
  assert.deepEqual(calls, ['board'])
})

test('release workspace resolution rejects stale solo release records before probing Git', async () => {
  const calls = []
  const resolve = sourceFunction('src/main/index.ts', 'releaseWorkspaceForMission', {
    projects: { get: () => ({ versioning: 'none', path: '/synthetic' }) },
    backlog: { getVersion: () => ({ id: 'v1', status: 'lancada' }), listVersions: () => [] },
    releases: { listForVersion: () => [] }, gitOff: async name => { calls.push(name); return { branch: 'main' } },
    releaseChangesStore: { list: () => [] }, resolveReleaseWorkspace: () => ({ dir: '/synthetic', base: 'main' }),
    versionIsolationProbe: async () => true, isUnversionedProject, unversionedRefusal
  })
  const result = await resolve({ id: 'stale', projectId: 'solo', versionId: 'v1' })
  assert.deepEqual(calls, [])
  assert.match(result.error, /não existe release/u)
})

test('Hub writes and purges runtime events without its Git guard in solo projects', t => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-solo-hub-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = []
  const hub = new Hub({ projectPathOf: () => root, projectVersioningOf: () => 'none',
    ensureProjectRuntimeWritable: () => calls.push('git'), onEvent() {} })
  hub.publish({ projectId: 'solo', missionId: 'm1', kind: 'info', text: 'synthetic event' })
  hub.purgeMissionEvents('solo', 'm1')
  assert.deepEqual(calls, [])
})

test('diagnostics export preserves artifacts without collecting Git evidence for solo projects', t => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-solo-diagnostics-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = []
  const { exportDiagnostics } = load('src/main/diagnostics.ts', { 'node:child_process': {
    execFileSync: () => { calls.push('git'); throw new Error('synthetic unavailable') }
  } })
  const result = exportDiagnostics({ outFile: join(root, 'diagnostics.zip'), userDataDir: root, blackboxDir: join(root, 'missing'),
    meta: {}, projects: [{ id: 'solo', name: 'Documento', path: root, versioning: 'none' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [])
})

test('GUI attachment storage skips excludes before writing solo bytes', () => {
  const calls = []
  const save = sourceFunction('src/main/ipc/gui.ts', 'storeAttachmentBytes', {
    GUI_ATTACHMENT_MAX_BYTES: 1024, ensureSynkoraGitExcludes: () => calls.push('git'),
    prepareGuiAttachmentDirectory: () => '/synthetic/attachments',
    writeGuiAttachmentExclusive: (_dir, _name, bytes) => { calls.push(bytes.toString()); return '/synthetic/attachment.txt' },
    guiAttachmentMediaType: () => ({ kind: 'file', mime: 'text/plain' }),
    isUnversionedProject, projectVersioning
  })
  const result = save('/synthetic', 'gui-dev-test', 'note.txt', Buffer.from('synthetic bytes'), { issue: (_pane, value) => value }, 'none')
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['synthetic bytes'])
})

test('misc clipboard/import handlers preserve files without Git in a solo project', () => {
  const handlers = new Map(), calls = []
  const register = sourceFunction('src/main/ipc/misc.ts', 'registerMiscIpc', {
    ipcMain: { handle: (name, action) => handlers.set(name, action), on: (name, action) => handlers.set(name, action) },
    ensureSynkoraGitExcludes: () => calls.push('git'), clipboard: { readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from('synthetic image') }) },
    join, mkdirSync() {}, writeFileSync: () => calls.push('write'), copyFileSync: () => calls.push('copy'),
    existsSync: () => false, statSync: () => ({ size: 4, isFile: () => true }), basename: () => 'note.txt',
    isUnversionedProject, projectVersioning
  })
  register({ projects: { get: () => ({ id: 'solo', path: '/synthetic', versioning: 'none' }) } }, {})
  assert.ok(handlers.get('clipboard:saveImage')({}, 'solo'))
  assert.equal(handlers.get('attachments:import')({}, 'solo', ['/synthetic-source/note.txt']).length, 1)
  assert.deepEqual(calls, ['write', 'copy'])
})

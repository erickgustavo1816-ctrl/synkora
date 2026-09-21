import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join, sep } from 'node:path'
import test from 'node:test'
import { build, buildSync } from 'esbuild'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const built = buildSync({ stdin: { contents: `
  export { startMcpServer } from './src/main/mcpServer'
  export { Hub } from './src/main/hub'
  export { guiDelegateClaudeArgs, guiDelegateCodexArgs } from './src/main/guiDelegateMcp'
  export { buildPlansApi } from './src/main/mcpApi/plans'
  export { PlanStore } from './src/main/plans'
  export { normalizePlanDraft } from './src/main/planDraft'
  export { buildGuiDelegationApi } from './src/main/guiDelegationWiring'
  export { GuiHelperEngine } from './src/main/guiHelperSessions'
  export { buildProjectContextTools } from './src/main/projectContextTools'
  export { ProjectContextStore } from './src/main/projectContextStore'
  export { buildGuiMobileTools, resolveMobileAgentTarget } from './src/main/guiMobileTools'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['electron', '@modelcontextprotocol/server', '@modelcontextprotocol/node'] })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { startMcpServer, Hub, guiDelegateClaudeArgs, guiDelegateCodexArgs, buildPlansApi, PlanStore,
  normalizePlanDraft, buildGuiDelegationApi, GuiHelperEngine, buildProjectContextTools, ProjectContextStore,
  buildGuiMobileTools, resolveMobileAgentTarget } = loaded.exports

const PLAN_TOOLS = ['list_plans', 'get_plan', 'propose_plan', 'update_plan', 'delete_plan']
const MANAGEMENT_TOOLS = ['release_missions', 'release_mission_update', 'release_mission_remove']
const EXPANDED_TOOLS = [...PLAN_TOOLS, ...MANAGEMENT_TOOLS, 'delegate', 'list_seats', 'helpers_status',
  'helper_result', 'helper_send', 'helper_resume', 'helper_cancel', 'skill_search', 'skill_pull', 'skill_discard',
  'context_record', 'browser_open', 'browser_check', 'mobile_status', 'mobile_start', 'mobile_stop',
  'mobile_screenshot', 'mobile_action', 'mobile_expo']
const textOf = value => value.content.find(block => block.type === 'text').text
const parse = async value => JSON.parse(await value)
const recordInput = { key: 'validation', expectedRevision: 0, kind: 'note', title: 'Validation',
  body: 'Synthetic checks passed.', sources: ['file:src/check.ts'] }

function fixture(t) {
  mkdirSync('.tmp', { recursive: true })
  const root = mkdtempSync(resolve('.tmp/release-capabilities-'))
  t.after(() => { assert.ok(root.startsWith(resolve('.tmp') + sep)); rmSync(root, { recursive: true, force: true }) })
  const project = { id: 'project-a', path: root, name: 'Synthetic project' }
  const mission = { id: 'release1-synthetic', projectId: project.id, direct: true, missionType: 'release',
    status: 'ativa', versionId: 'version-a', title: 'Synthetic release' }
  const identity = { paneId: 'gui-dev-release1', role: 'gui-release', projectId: project.id, missionId: mission.id, cwd: root }
  const hub = new Hub({ projectPathOf: () => root, ensureProjectRuntimeWritable: () => {}, onEvent: () => {} })
  hub.registerPane('synthetic-release', identity)
  const helpers = new Map()
  const context = { identityOf: id => hub.identityByPane(id), missionOf: id => id === mission.id ? mission : undefined,
    projectOf: id => id === project.id ? project : undefined, helperOf: id => helpers.get(id) }
  const plans = new PlanStore(join(root, 'plans.json'))
  const normalized = normalizePlanDraft({ title: 'Synthetic plan', items: [{ title: 'Check access', objective: 'Verify scope' }] })
  assert.equal(normalized.ok, true)
  const plan = plans.create(project.id, normalized.draft, { manual: true }).plan
  const foreignPlan = plans.create('project-b', normalized.draft, { manual: true }).plan
  const proposals = []
  const version = { id: 'version-a', name: 'Synthetic version', projectId: project.id, status: 'aberta', deliveries: [],
    createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z' }
  const ctx = { hub, plans, projects: { get: context.projectOf }, backlog: { getVersion: id => id === version.id ? version : undefined },
    missions: { get: context.missionOf, list: id => id === project.id ? [mission] : [] },
    blackbox: { record() {} }, pushAll() {} }
  const planApi = buildPlansApi(ctx, { proposePlanToPane: (paneId, draft) => {
    proposals.push({ paneId, draft }); return { ok: true, requestId: 'proposal-a' }
  } })
  const notes = new ProjectContextStore(join(root, 'context.json'))
  const contextDeps = { projects: ctx.projects, missions: ctx.missions, plans, notes,
    versions: { listVersions: () => [version] }, inspect: async () => ({ head: 'a'.repeat(40), included: {} }) }
  return { root, project, mission, identity, hub, helpers, context, ctx, plans, plan, foreignPlan, proposals, planApi,
    notes, contextDeps, contextTools: buildProjectContextTools(contextDeps) }
}

async function clientFor(t, f, extra = {}, identity = f.identity) {
  const handle = await startMcpServer({ hub: f.hub, ...f.planApi, context: f.contextTools, ...extra })
  t.after(() => handle.close())
  const token = `synthetic-${identity.role}`
  f.hub.registerPane(token, identity)
  const client = new Client({ name: 'release-capabilities', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`),
    { authProvider: { token: async () => token } }))
  t.after(() => client.close())
  return client
}

test('Release exposes every approved kit in MCP and in both CLI allowlists, without mission integration', async t => {
  const f = fixture(t)
  const client = await clientFor(t, f)
  const names = (await client.listTools()).tools.map(tool => tool.name)
  for (const name of EXPANDED_TOOLS) assert.ok(names.includes(name), `Release catalog lacks ${name}`)
  for (const name of ['integration_run', 'integration_status', 'enqueue_mission', 'mission_summary']) {
    assert.ok(!names.includes(name), name)
    await assert.rejects(() => client.callTool({ name, arguments: {} }))
  }
  const claude = guiDelegateClaudeArgs('synthetic.json', 'gui-release')
  const allowed = claude[claude.indexOf('--allowedTools') + 1].split(',').map(name => name.replace('mcp__synkora__', ''))
  assert.deepEqual(allowed.toSorted(), names.toSorted())
  const codex = guiDelegateCodexArgs(12345, 'gui-release')
  assert.ok(codex.includes('features.multi_agent=false'))
  const setting = codex.find(arg => arg.startsWith('mcp_servers.synkora.enabled_tools='))
  assert.ok(setting, 'Codex Release needs the same explicit allowed operations')
  assert.deepEqual(setting.slice(setting.indexOf('=') + 1).replace(/^\[|\]$/g, '').replaceAll("'", '').split(',').toSorted(), names.toSorted())
})

test('Release plan tools execute the canonical service, preserve project scope and reject stale writes', async t => {
  const f = fixture(t)
  const client = await clientFor(t, f)
  assert.match(textOf(await client.callTool({ name: 'list_plans', arguments: {} })), new RegExp(f.plan.id))
  assert.match(textOf(await client.callTool({ name: 'get_plan', arguments: { planId: f.plan.id } })), /Synthetic plan/)
  assert.match(textOf(await client.callTool({ name: 'get_plan', arguments: { planId: f.foreignPlan.id } })), /não encontrado/)
  const proposal = { title: 'Another plan', items: [{ title: 'Verify release', objective: 'Check behavior' }] }
  assert.match(textOf(await client.callTool({ name: 'propose_plan', arguments: proposal })), /APRESENTADA/)
  assert.equal(f.proposals[0].paneId, f.identity.paneId)
  assert.equal(f.plans.list(f.project.id).length, 1, 'a proposal does not create a plan')
  await client.callTool({ name: 'update_plan', arguments: { planId: f.plan.id, title: 'Updated', expectedUpdatedAt: f.plan.updatedAt } })
  assert.equal(f.plans.get(f.plan.id).title, 'Updated')
  assert.match(f.planApi.updatePlan(f.identity, f.plan.id, { title: 'Stale' }, '2000-01-01'), /recusada/)
  assert.equal(f.plans.get(f.plan.id).title, 'Updated')
  await client.callTool({ name: 'delete_plan', arguments: { planId: f.plan.id, expectedUpdatedAt: f.plans.get(f.plan.id).updatedAt } })
  assert.equal(f.plans.get(f.plan.id).status, 'arquivado')
  assert.equal(f.plans.get(f.foreignPlan.id).status, 'ativo')
})

test('mission toolkit dispatch preserves bearer identity and rejects malformed or unconfirmed removal', async t => {
  const f = fixture(t), calls = []
  const client = await clientFor(t, f, { releaseMissions: {
    list: id => { calls.push(['list', id]); return JSON.stringify({ ok: true, missions: [] }) },
    update: (id, input) => { calls.push(['update', id, input]); return JSON.stringify({ ok: true }) },
    remove: async (id, input) => { calls.push(['remove', id, input]); return JSON.stringify({ ok: true }) }
  } })
  const selection = { missionId: 'target-mission', expectedRevision: 'a'.repeat(64) }
  await client.callTool({ name: 'release_missions', arguments: {} })
  const update = { ...selection, title: 'Updated target' }
  await client.callTool({ name: 'release_mission_update', arguments: update })
  const remove = { ...selection, confirmTitle: 'Updated target', ownerConfirmed: true }
  await client.callTool({ name: 'release_mission_remove', arguments: remove })
  assert.deepEqual(calls, [['list', f.identity], ['update', f.identity, update], ['remove', f.identity, remove]])
  for (const invalid of [{ ...remove, expectedRevision: 'stale' }, { ...remove, ownerConfirmed: false }]) {
    assert.equal((await client.callTool({ name: 'release_mission_remove', arguments: invalid })).isError, true)
  }
  assert.equal(calls.length, 3)
})

test('Release plan engine refuses forged identities, closed missions and wrong project roots before any operation', t => {
  const f = fixture(t)
  const attempt = id => {
    const before = JSON.stringify(f.plans.list(f.project.id))
    assert.doesNotMatch(f.planApi.listPlans(id), /Synthetic plan/)
    assert.doesNotMatch(f.planApi.getPlan(id, f.plan.id), /PLANO Synthetic/)
    f.planApi.proposePlan(id, { title: 'Forged', items: [{ title: 'Forbidden', objective: 'Forbidden' }] })
    f.planApi.updatePlan(id, f.plan.id, { title: 'Forbidden' })
    f.planApi.deletePlan(id, f.plan.id)
    assert.equal(JSON.stringify(f.plans.list(f.project.id)), before)
    assert.equal(f.proposals.length, 0)
  }
  for (const patch of [{ projectId: 'project-b' }, { missionId: 'another' }, { paneId: 'gui-dev-foreign1' }, { cwd: join(f.root, 'other') }]) attempt({ ...f.identity, ...patch })
  for (const state of ['concluida', 'arquivada']) { f.mission.status = state; attempt(f.identity) }
  f.mission.status = 'ativa'
  f.mission.direct = false
  attempt(f.identity)
  f.mission.direct = true
  f.mission.missionType = 'dev'
  attempt(f.identity)
  f.mission.missionType = 'release'
  f.hub.unregisterPane(f.identity.paneId)
  attempt(f.identity)
})

function helperApi(f) {
  const spawned = [], messages = []
  const adapter = (request, emit) => {
    spawned.push(request)
    emit({ type: 'session', sessionId: 'synthetic-helper-session' })
    return { send: text => messages.push(text), dispose() {} }
  }
  let seq = 0
  const engine = new GuiHelperEngine({ spawnClaude: adapter, spawnCodex: adapter,
    resolveSeat: () => ({ seatId: 'seat-a', configDir: f.root, name: 'Synthetic seat' }),
    newId: () => `helper-${++seq}`, spawnIntervalMs: 0 })
  const deps = { engine, delegator: paneId => paneId === f.identity.paneId ? { paneId, projectId: f.project.id,
    cwd: f.root, cli: 'claude', model: 'opus', effort: 'low', seatId: 'seat-a' } : undefined,
    releaseAllowed: id => id.missionId === f.mission.id && f.mission.status === 'ativa' && id.role === 'gui-release',
    defaults: () => ({ model: 'gpt-5.6-sol', effort: 'high' }), beginBatch() {}, endBatch() {},
    seats: () => [{ id: 'seat-a', name: 'Synthetic seat', cli: 'codex', status: 'logado', configDir: f.root }] }
  return { engine, spawned, messages, deps, api: buildGuiDelegationApi(deps) }
}

test('Release helpers honor the owner pin and keep results, steering, resume and cancel within their owner', async t => {
  const f = fixture(t), h = helperApi(f)
  const client = await clientFor(t, f, h.api)
  const receipt = textOf(await client.callTool({ name: 'delegate', arguments: { helpers: [{ prompt: 'Check the synthetic release' }] } }))
  assert.equal(h.spawned.length, 1, receipt)
  assert.equal(h.spawned[0].model, 'gpt-5.6-sol')
  assert.equal(h.spawned[0].effort, 'high')
  assert.equal(h.spawned[0].cwd, f.root)
  assert.equal(h.spawned[0].projectId, f.project.id)
  assert.match(h.api.helpersStatus(f.identity), /helper-1/)
  assert.match(await h.api.listSeats(f.identity), /Synthetic seat/)
  assert.match(h.api.helperSend(f.identity, 'helper-1', 'Scope stays local'), /entregue/)
  assert.deepEqual(h.messages, ['Scope stays local'])
  assert.match(await h.api.helperResult(f.identity, 'helper-1', 0), /ainda trabalhando/)
  h.engine.interruptPane(f.identity.paneId)
  assert.match(h.api.helperResume(f.identity, 'helper-1'), /RETOMADO/)
  const outsider = { ...f.identity, paneId: 'gui-dev-other123' }
  for (const result of [h.api.helperSend(outsider, 'helper-1', 'No'), h.api.helperCancel(outsider, 'helper-1'),
    h.api.helperResume(outsider, 'helper-1'), await h.api.helperResult(outsider, 'helper-1', 0)]) assert.doesNotMatch(result, /entregue|DESCARTADO|RETOMADO|entrega do ajudante/)
  assert.match(h.api.helperCancel(f.identity, 'helper-1'), /DESCARTADO/)
  assert.equal(h.engine.get('helper-1').state, 'cancelled')
})

test('Release helper engine refuses wrong scope and closed Release even when the session remains', async t => {
  const f = fixture(t), h = helperApi(f)
  for (const patch of [{ projectId: 'project-b' }, { cwd: join(f.root, 'other') }, { missionId: 'missing' }, { role: 'ajudante' }]) {
    await h.api.delegateHelpers({ ...f.identity, ...patch }, [{ prompt: 'Forbidden' }])
  }
  f.mission.status = 'concluida'
  await h.api.delegateHelpers(f.identity, [{ prompt: 'Closed' }])
  assert.equal(h.spawned.length, 0)
  assert.doesNotMatch(await h.api.listSeats(f.identity), /Synthetic seat/)
})

test('context_record writes revisions only for its own live Release and rechecks after Git inspection', async t => {
  const f = fixture(t)
  const written = await parse(f.contextTools.record(f.identity, recordInput))
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.equal(written.id, 'note:release1-synthetic:validation')
  assert.equal((await parse(f.contextTools.record(f.identity, { ...recordInput, body: 'New validation evidence.', expectedRevision: 1 }))).revision, 2)
  for (const patch of [{ paneId: 'gui-dev-other123' }, { role: 'ajudante' }, { missionId: 'missing' }, { projectId: 'other' }, { cwd: join(f.root, 'other') }]) {
    assert.equal((await parse(f.contextTools.record({ ...f.identity, ...patch }, recordInput))).ok, false)
  }
  for (const state of ['concluida', 'arquivada']) {
    f.mission.status = state
    assert.equal((await parse(f.contextTools.record(f.identity, { ...recordInput, expectedRevision: 2 }))).ok, false)
  }
  f.mission.status = 'ativa'
  const racing = buildProjectContextTools({ ...f.contextDeps, inspect: async () => {
    f.mission.status = 'concluida'; return { included: {} }
  } })
  assert.equal((await parse(racing.record(f.identity, { ...recordInput, expectedRevision: 2 }))).ok, false)
  assert.equal(f.notes.get(f.project.id, written.id).revision, 2)
})

test('Mobile resolves Release and its own helper to the project root, with live identity and state fences', async t => {
  const f = fixture(t)
  const versionRoot = join(f.root, 'version-worktree')
  mkdirSync(versionRoot)
  f.mission.worktree = versionRoot
  assert.deepEqual(resolveMobileAgentTarget(f.context, f.identity), { paneId: f.identity.paneId,
    missionId: f.mission.id, projectId: f.project.id, rootPath: f.root })
  const helper = { paneId: 'helper-mcp-release-helper', role: 'ajudante', cwd: f.root, projectId: f.project.id,
    delegatorPaneId: f.identity.paneId }
  f.hub.registerPane('synthetic-helper', helper)
  const record = { delegatorPaneId: f.identity.paneId, cwd: f.root, projectId: f.project.id, state: 'working' }
  f.helpers.set(helper.paneId, record)
  assert.equal(resolveMobileAgentTarget(f.context, helper)?.rootPath, f.root)
  const calls = []
  const toolkit = buildGuiMobileTools({ context: f.context, runtime: {
    inspect: async (missionId, actor) => { calls.push({ missionId, actor }); return { ok: true, value: { hostPlatform: 'win32', platforms: [], devices: [], sessions: [] } } }
  } })
  assert.equal((await toolkit.status(f.identity)).ok, true)
  assert.equal((await toolkit.status(helper)).ok, true)
  assert.deepEqual(calls.map(call => call.actor.paneId), [f.identity.paneId, helper.paneId])
  for (const patch of [{ projectId: 'other' }, { cwd: versionRoot }, { missionId: 'other' }, { role: 'gui-delegator' }]) assert.equal(resolveMobileAgentTarget(f.context, { ...f.identity, ...patch }), undefined)
  for (const patch of [{ state: 'interrupted' }, { delegatorPaneId: 'other' }, { projectId: 'other' }, { cwd: versionRoot }]) {
    const saved = { ...record }; Object.assign(record, patch)
    assert.equal(resolveMobileAgentTarget(f.context, helper), undefined)
    Object.assign(record, saved)
  }
  for (const state of ['concluida', 'arquivada']) {
    f.mission.status = state
    assert.equal((await toolkit.status(f.identity)).ok, false)
    assert.equal((await toolkit.status(helper)).ok, false)
  }
  assert.equal(calls.length, 2)
})

const mobileBuilt = await build({ stdin: { contents: `
  export { createMobileIntegration } from './src/main/mobileIntegration'
  export { runtimeInstance, runtimeResolve } from 'test-mobile-runtime'
  export { expoInstance, expoResolve } from 'test-mobile-expo'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['electron'], plugins: [{ name: 'mobile-external-effects', setup(builder) {
    builder.onResolve({ filter: /^test-mobile-(runtime|expo)$/ }, args => ({ path: args.path, namespace: 'mobile-test' }))
    builder.onResolve({ filter: /^\.\/mobile(Runtime|Expo)$/ }, args => {
      if (!args.importer.endsWith('mobileIntegration.ts')) return undefined
      return { path: args.path.endsWith('Runtime') ? 'test-mobile-runtime' : 'test-mobile-expo', namespace: 'mobile-test' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'mobile-test' }, args => ({ loader: 'ts', resolveDir: process.cwd(),
      contents: args.path.endsWith('runtime') ? `
        import { MobileRuntimeManager as RealRuntime } from './src/main/mobileRuntime'
        export let runtimeInstance, runtimeResolve
        export class MobileRuntimeManager extends RealRuntime {
          constructor(deps) {
            super({ ...deps, discover: async () => ({ hostPlatform: 'win32', platforms: [], devices: [], tools: {} }),
              executor: { run() { throw new Error('No device commands in this test') }, spawn() { throw new Error('No emulator in this test') } } })
            runtimeInstance = this; runtimeResolve = deps.resolveMission
          }
        }
      ` : `
        import { MobileExpoManager as RealExpo } from './src/main/mobileExpo'
        export let expoInstance, expoResolve
        export class MobileExpoManager extends RealExpo {
          constructor(deps) { super({ ...deps, addresses: () => [] }); expoInstance = this; expoResolve = deps.resolveMission }
        }
      ` }))
  } }] })
const mobileLoaded = { exports: {} }
new Function('require', 'module', 'exports', mobileBuilt.outputFiles[0].text)(createRequire(import.meta.url), mobileLoaded, mobileLoaded.exports)

test('real Mobile integration sends Release and its helper through runtime and Expo using project root', async t => {
  const f = fixture(t)
  const versionRoot = join(f.root, 'version-worktree')
  mkdirSync(versionRoot)
  f.mission.worktree = versionRoot
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'synthetic-release', dependencies: { expo: '~55.0.0' } }))
  writeFileSync(join(versionRoot, 'package.json'), JSON.stringify({ name: 'synthetic-dev' }))
  const integration = mobileLoaded.exports.createMobileIntegration({ ...f.ctx, pushBoard() {} },
    { cacheRoot: join(f.root, 'cache'), helperOf: id => f.helpers.get(id) })
  const { runtimeInstance, runtimeResolve, expoInstance, expoResolve } = mobileLoaded.exports
  assert.equal(runtimeResolve, expoResolve, 'both real managers receive the same mission resolver')
  assert.deepEqual(runtimeResolve(f.mission.id), { projectId: f.project.id, rootPath: f.root })
  assert.equal((await runtimeInstance.inspect(f.mission.id)).ok, true)
  assert.equal((await expoInstance.inspect(f.mission.id)).value?.project.kind, 'expo')
  const client = await clientFor(t, f, { mobile: integration.toolkit })
  assert.match(textOf(await client.callTool({ name: 'mobile_status', arguments: {} })), /hostPlatform/)
  assert.equal(JSON.parse(textOf(await client.callTool({ name: 'mobile_expo', arguments: { action: 'status' } }))).project.kind, 'expo')
  const helper = { paneId: 'helper-mcp-integrated', role: 'ajudante', cwd: f.root, projectId: f.project.id,
    delegatorPaneId: f.identity.paneId }
  f.hub.registerPane('synthetic-helper', helper)
  f.helpers.set(helper.paneId, { ...helper, state: 'working' })
  assert.equal((await integration.toolkit.status(helper)).ok, true)
  assert.equal(JSON.parse((await integration.toolkit.expo(helper, { action: 'status' })).text).project.kind, 'expo')
  assert.equal(runtimeResolve('foreign-mission'), null)
  for (const patch of [{ status: 'concluida' }, { status: 'arquivada' }, { direct: false },
    { projectId: 'foreign-project' }, { missionType: 'planejamento' }]) {
    const saved = { ...f.mission }; Object.assign(f.mission, patch)
    assert.equal((await runtimeInstance.inspect(f.mission.id)).ok, false)
    assert.equal((await expoInstance.inspect(f.mission.id)).ok, false)
    assert.equal((await integration.toolkit.status(helper)).ok, false)
    Object.assign(f.mission, saved)
  }
  f.mission.status = 'integrando'
  assert.equal((await runtimeInstance.inspect(f.mission.id)).ok, true)
  f.mission.missionType = 'dev'
  assert.deepEqual(runtimeResolve(f.mission.id), { projectId: f.project.id, rootPath: versionRoot })
  assert.equal((await expoInstance.inspect(f.mission.id)).value?.project.kind, 'other')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { load } from './test-unversioned-agent-fixture.mjs'

const contracts = load('src/main/guiMissionContracts.ts')
const { buildProjectContextTools } = load('src/main/projectContextTools.ts')
const { buildGuiLspTools } = load('src/main/guiLspTools.ts')
const { buildMissionSummaries } = load('src/main/missionSummary.ts')
const { Hub } = load('src/main/hub.ts')
const { startMcpServer } = load('src/main/mcpServer.ts')
const { armGuiDelegateMcp, guiPaneToolKind } = load('src/main/guiDelegateMcp.ts')
const project = { id: 'p1', name: 'Documento', path: '/synthetic/project', versioning: 'none' }
const mission = { id: '12345678-mission', projectId: 'p1', title: 'Escrever documento', status: 'ativa', direct: true }
const identity = { role: 'gui-delegator', paneId: 'gui-dev-12345678', projectId: 'p1', missionId: mission.id, cwd: project.path }

test('solo route opens the project root and refuses diff roles and planning/release missions', () => {
  const route = contracts.routeGuiMissionPane(mission, 'dev', 'none')
  assert.equal(route.ok, true)
  assert.equal(route.workspace, 'root')
  for (const role of ['reviewer', 'helper']) {
    const refused = contracts.routeGuiMissionPane(mission, role, 'none')
    assert.equal(refused.ok, false)
    assert.match(refused.error, /chat/u)
  }
  for (const missionType of ['planejamento', 'release'])
    assert.equal(contracts.routeGuiMissionPane({ missionType }, 'dev', 'none').ok, false)
})

test('solo persona and first prompt require summary, immediate edits and finish by owner', () => {
  const prompt = contracts.routeGuiMissionPane(mission, 'dev', 'none').systemPrompt
  const first = contracts.guiMissionFirstPrompt('dev', mission, 'none')
  for (const text of [prompt, first]) {
    assert.doesNotMatch(text, /\b(?:commits?|branches?|worktrees?|versions?|maps?|release|integration)\b|⇪/iu)
    assert.match(text, /mission_summary/u)
    assert.match(text, /owner.{0,45}finish|finish.{0,45}owner/iu)
    assert.match(text, /immediat/iu)
  }
  for (const tool of ['delegate', 'skill_search', 'commentary', 'plan_approval', 'lsp_diagnostics', 'mobile_status', 'browser_open'])
    assert.match(prompt, new RegExp(tool, 'u'))
  assert.match(prompt, /cancel.{0,80}(?:does not|never|cannot).{0,25}undo/iu)
})

test('MCP for a solo developer excludes integration, plan and release tools', async t => {
  const hub = new Hub({ projectPathOf: () => undefined, ensureProjectRuntimeWritable() {}, onEvent() {} })
  hub.registerPane('synthetic-token', identity)
  const server = await startMcpServer({ hub, projectVersioning: () => 'none' })
  const client = new Client({ name: 'solo-test', version: '1' })
  t.after(async () => { await client.close(); await server.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer synthetic-token' } }
  }))
  const { tools } = await client.listTools()
  assert.equal(tools.some(tool => /^(?:integration_|release_|list_plans|get_plan|propose_plan|update_plan|delete_plan)/u.test(tool.name)), false)
  assert.ok(tools.some(tool => tool.name === 'mission_summary'))
  assert.doesNotMatch(tools.find(tool => tool.name === 'mission_summary').description, /versão|integration_run/u)
})

test('Claude arm carries solo modality and never preapproves prohibited tools', t => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-solo-arm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const hub = new Hub({ projectPathOf: () => undefined, ensureProjectRuntimeWritable() {}, onEvent() {} })
  const armed = armGuiDelegateMcp({ ...identity, cli: 'claude', projectVersioning: 'none' }, {
    hub, port: () => 47495, configRoot: () => root, tokenOf: () => undefined, remember() {}
  })
  assert.equal(armed.env.SYNKORA_PROJECT_VERSIONING, 'none')
  assert.doesNotMatch(armed.args.join(' '), /mcp__synkora__(?:integration_|release_|list_plans|get_plan|propose_plan|update_plan|delete_plan)/u)
  assert.equal(guiPaneToolKind(identity.paneId, { missionType: 'planejamento' }, 'none'), 'none')
})

test('MCP refuses stale calls to excluded solo tools with the canonical recipe', async t => {
  const hub = new Hub({ projectPathOf: () => undefined, ensureProjectRuntimeWritable() {}, onEvent() {} })
  hub.registerPane('synthetic-token', identity)
  const server = await startMcpServer({ hub, projectVersioning: () => 'none' })
  const client = new Client({ name: 'solo-refusal-test', version: '1' })
  t.after(async () => { await client.close(); await server.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer synthetic-token' } }
  }))
  for (const name of ['integration_run', 'integration_status', 'list_plans', 'get_plan', 'propose_plan', 'update_plan', 'delete_plan', 'release_run', 'release_save', 'release_missions']) {
    const result = await client.callTool({ name, arguments: {} })
    assert.match(result.content[0].text, /Este projeto não é versionado/u)
  }
})

test('solo projects reject stale planner and release identities with empty catalogs and explicit refusals', async t => {
  for (const role of ['gui-planner', 'gui-release']) {
    const hub = new Hub({ projectPathOf: () => undefined, ensureProjectRuntimeWritable() {}, onEvent() {} })
    hub.registerPane('synthetic-token', { ...identity, role })
    const server = await startMcpServer({ hub, projectVersioning: () => 'none' })
    const client = new Client({ name: 'solo-stale-role-test', version: '1' })
    t.after(async () => { await client.close(); await server.close() })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer synthetic-token' } }
    }))
    assert.deepEqual((await client.listTools()).tools, [])
    const result = await client.callTool({ name: role === 'gui-planner' ? 'list_plans' : 'release_status', arguments: {} })
    assert.match(result.content[0].text, /Este projeto não é versionado/u)
  }
})

test('headless solo helper knows the permanent folder and cancellation does not undo edits', () => {
  const { guiHelperPersonaFor } = load('src/main/guiDelegationWiring.ts')
  const persona = guiHelperPersonaFor(true, 47495, undefined, 'none')
  assert.match(persona, /permanent/iu)
  assert.match(persona, /cancel.{0,80}(?:does not|never|cannot).{0,25}undo/iu)
  assert.doesNotMatch(persona, /\bworktree|git ignores|versioned folder/iu)
})

test('solo helper cancellation receipt leaves no promise of Git undo', () => {
  const { buildGuiDelegationApi } = load('src/main/guiDelegationWiring.ts')
  const api = buildGuiDelegationApi({ projectVersioning: () => 'none',
    engine: { get: () => ({ delegatorPaneId: identity.paneId }), cancel: () => ({ ok: true }) },
    inbox: { drain: () => [] }, ownerMail: { drain: () => [] }, replyDebt: { pending: () => undefined }
  })
  const text = api.helperCancel(identity, 'synthetic-helper')
  assert.match(text, /pasta permanente/u)
  assert.match(text, /cancelar não desfaz/u)
  assert.doesNotMatch(text, /git|worktree/iu)
})

test('solo arm retains /diff capability restrictions even when the MCP server is down', () => {
  const armed = armGuiDelegateMcp({ ...identity, cli: 'codex', projectVersioning: 'none' }, { port: () => 0 })
  assert.equal(armed?.env.SYNKORA_PROJECT_VERSIONING, 'none')
  assert.deepEqual(armed.args, [])
})

test('plan API refuses every entry point for an unversioned project before touching the plan store', () => {
  const { buildPlansApi } = load('src/main/mcpApi/plans.ts')
  const calls = []
  const api = buildPlansApi({ projects: { get: () => project }, missions: { list: () => [] },
    plans: { reconcile() {}, list: () => { calls.push('plans'); return [] } } }, {})
  for (const name of ['listPlans', 'getPlan', 'proposePlan', 'updatePlan', 'deletePlan']) {
    assert.match(api[name](identity, 'synthetic'), /Este projeto não é versionado/u)
  }
  assert.deepEqual(calls, [])
})

function contextFixture() {
  const calls = []
  const current = { ...mission }
  const old = { ...mission, id: 'old', title: 'Primeiro texto', summary: 'Texto anterior.', status: 'concluida' }
  let note
  const tools = buildProjectContextTools({
    projects: { get: () => project }, missions: { get: () => current, list: () => [current, old] },
    versions: { listVersions: () => [] }, plans: { list: () => [] },
    notes: { list: () => note ? [note] : [], get: () => note,
      save: value => (note = { ...value, revision: 1, updatedAt: '2026-09-30' }) },
    inspect: async () => { calls.push('git'); return { head: 'a'.repeat(40), included: {} } }
  })
  return { tools, calls }
}

test('context status/search/read/record preserve project memory with zero Git inspections', async () => {
  const { tools, calls } = contextFixture()
  await tools.status(identity)
  const saved = JSON.parse(await tools.record(identity, { key: 'decision', expectedRevision: 0, kind: 'decision',
    title: 'Decisão', body: 'Texto documentado.', sources: ['file:documento.md'] }))
  assert.equal(saved.ok, true)
  const search = JSON.parse(await tools.search(identity, {}))
  assert.ok(search.entries.some(entry => entry.id === 'mission:old'))
  const read = JSON.parse(await tools.read(identity, { id: 'mission:old' }))
  assert.match(read.content, /Texto anterior/u)
  assert.deepEqual(calls, [])
})

test('solo context receipts omit publication, branch and version vocabulary', async () => {
  const { tools } = contextFixture()
  for (const output of [await tools.status(identity), await tools.search(identity, {}),
    await tools.read(identity, { id: 'mission:old' }), tools.briefing('p1', mission.id)]) {
    assert.doesNotMatch(output, /version|versão|versões|branch|publication|publicação|checkout|commit|worktree|Git/iu)
  }
})

test('solo LSP without files refuses before changed-files Git and explicit files still work', async () => {
  const calls = []
  const tools = buildGuiLspTools({ projectVersioning: () => 'none',
    changedFiles: async () => { calls.push('git'); return ['src/example.ts'] },
    manager: { sessionFor: async () => ({ diagnostics: async files => { calls.push(files); return [] } }) }
  })
  const refusal = await tools.diagnostics(identity)
  assert.match(refusal, /files/u)
  assert.deepEqual(calls, [])
  await tools.diagnostics(identity, ['src/example.ts'])
  assert.deepEqual(calls, [['src/example.ts']])
})

test('mission_summary records project history without version reconciliation', () => {
  let reconciliations = 0
  const tools = buildMissionSummaries({ projectVersioning: () => 'none',
    missions: { get: () => ({ ...mission, status: 'concluida', summary: 'Texto pronto.' }), update: () => undefined },
    reconcile: () => { reconciliations++; return true }, changed() {}, audit() {}
  })
  const receipt = tools.save(identity, 'Texto pronto.')
  assert.equal(receipt.ok, true)
  assert.match(receipt.text, /histórico do projeto/u)
  assert.equal(reconciliations, 0)
})

test('Codex /diff refuses before spawning Git in a solo workspace', async () => {
  const calls = [], output = []
  const { CodexSession } = load('src/main/codexSession.ts', { 'child_process': {
    spawn: command => { calls.push(command); const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('synthetic unavailable'))); return child }
  } })
  const session = Object.create(CodexSession.prototype)
  session.opts = { cwd: project.path, extraEnv: { SYNKORA_PROJECT_VERSIONING: 'none' } }
  session.finishCommand = text => output.push(text)
  await session.cmdDiff()
  assert.deepEqual(calls, [])
  assert.match(output.join(' '), /cartões de edição/u)
})

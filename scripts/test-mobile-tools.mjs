import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join, sep } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const built = buildSync({ stdin: { contents: `
  export * from './src/main/guiMobileTools'
  export * from './src/main/mobileToolCatalog'
  export { startMcpServer } from './src/main/mcpServer'
  export { Hub } from './src/main/hub'
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['@modelcontextprotocol/server', '@modelcontextprotocol/node'] })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { buildGuiMobileTools, resolveMobileAgentTarget, registerMobileKit, MOBILE_TOOL_NAMES, mobileActionSchema, mobileStartSchema, mobileExpoSchema, startMcpServer, Hub } = loaded.exports
const DISPLAY_PROFILE_IDS = ['native', 'pixel-7', 'pixel-9', 'galaxy-s24', 'galaxy-s24-ultra', 'galaxy-a54']

function fixture(t) {
  mkdirSync('.tmp', { recursive: true })
  const root = mkdtempSync(resolve('.tmp/mobile-tools-'))
  t.after(() => { assert.ok(root.startsWith(resolve('.tmp') + sep)); rmSync(root, { recursive: true, force: true }) })
  const mission = { id: 'a1111111-synthetic', projectId: 'project-a', direct: true, status: 'ativa', worktree: root }
  const identity = { paneId: 'gui-dev-a1111111', projectId: 'project-a', role: 'gui-delegator', missionId: mission.id, cwd: root }
  const identities = new Map([[identity.paneId, identity]])
  const helpers = new Map()
  const context = { identityOf: id => identities.get(id), missionOf: id => id === mission.id ? mission : undefined,
    projectOf: id => id === 'project-a' ? { id, path: root } : undefined, helperOf: id => helpers.get(id) }
  const calls = []
  const session = { id: 'session-a', missionId: mission.id, platform: 'android', deviceId: 'avd-a', deviceName: 'Synthetic AVD', state: 'ready', inputAvailable: true, controllerPaneId: identity.paneId }
  const frame = { sessionId: session.id, mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 400, height: 800, capturedAt: 1000 }
  const runtime = {
    inspect: async (...args) => { calls.push(['inspect', ...args]); return { ok: true, value: { hostPlatform: 'win32', platforms: [], devices: [], sessions: [session] } } },
    start: async (...args) => { calls.push(['start', ...args]); return { ok: true, value: session } },
    stop: async (...args) => { calls.push(['stop', ...args]); return args[1] === session.id ? { ok: true, value: undefined } : { ok: false, error: 'Sessão encerrada. Use mobile_status.' } },
    capture: async (...args) => { calls.push(['capture', ...args]); return { ok: true, value: frame } },
    act: async (...args) => { calls.push(['act', ...args]); return { ok: true, value: undefined } }
  }
  const logs = []
  const expoState = { project: { kind: 'expo', expoVersion: 'synthetic', dependenciesInstalled: true, hasDevClient: false, message: 'Expo disponível' },
    status: 'running', addresses: ['192.168.0.2'], selectedAddress: '192.168.0.2', port: 8081,
    lanUrl: 'exp://192.168.0.2:8081', androidUrl: 'exp://127.0.0.1:8081', qrDataUrl: 'data:image/png;base64,synthetic-private-qr' }
  const expo = Object.fromEntries(['inspect', 'start', 'stop', 'openAndroid', 'installGo'].map(method => [method, async (...args) => {
    calls.push([`expo:${method}`, ...args]); return { ok: true, value: ['inspect', 'start'].includes(method) ? expoState : undefined }
  }]))
  return { root, mission, identity, identities, helpers, context, runtime, calls, session, frame, logs, expo, expoState,
    toolkit: buildGuiMobileTools({ context, runtime, expo, log: event => logs.push(event) }) }
}

test('mobile authority comes from live pane, mission, project and physical worktree', t => {
  const f = fixture(t)
  assert.deepEqual(resolveMobileAgentTarget(f.context, f.identity), { missionId: f.mission.id, projectId: 'project-a', rootPath: f.root, paneId: f.identity.paneId })
  assert.equal(resolveMobileAgentTarget(f.context, { ...f.identity, projectId: 'project-b' }), undefined)
  assert.equal(resolveMobileAgentTarget(f.context, { ...f.identity, cwd: join(f.root, 'other') }), undefined)
  const otherRoot = join(f.root, 'other')
  mkdirSync(otherRoot)
  f.identity.cwd = otherRoot
  assert.equal(resolveMobileAgentTarget(f.context, f.identity), undefined, 'even the live bearer cannot remap its mission worktree')
  f.identity.cwd = f.root
  f.mission.projectId = 'project-b'
  assert.equal(resolveMobileAgentTarget(f.context, f.identity), undefined, 'the store must still bind mission to this project')
  f.mission.projectId = 'project-a'
  f.identities.delete(f.identity.paneId)
  assert.equal(resolveMobileAgentTarget(f.context, f.identity), undefined)
})

test('planner, reviewer, release, legacy, orphan and wrong mission panes cannot act', async t => {
  const f = fixture(t)
  for (const patch of [{ role: 'gui-planner' }, { role: 'gui-release' }, { role: 'dev' },
    { paneId: 'gui-reviewer-a1111111' }, { paneId: 'gui-dev-b2222222' }, { missionId: undefined }]) {
    const id = { ...f.identity, ...patch }
    f.identities.set(id.paneId, id)
    assert.equal((await f.toolkit.start(id, { platform: 'android', deviceId: 'avd-a' })).ok, false)
  }
  assert.equal(f.calls.length, 0)
})

test('archived, completed, non-direct and non-development missions fail closed', t => {
  const f = fixture(t)
  for (const patch of [{ status: 'arquivada' }, { status: 'concluida' }, { direct: false }, { missionType: 'planejamento' }, { missionType: 'release' }]) {
    const before = { ...f.mission }
    Object.assign(f.mission, patch)
    assert.equal(resolveMobileAgentTarget(f.context, f.identity), undefined)
    for (const key of Object.keys(f.mission)) delete f.mission[key]
    Object.assign(f.mission, before)
  }
  f.mission.status = 'integrando'
  assert.ok(resolveMobileAgentTarget(f.context, f.identity))
})

test('helper authority needs its live record and same registered developer root', t => {
  const f = fixture(t)
  const id = { paneId: 'helper-mcp-synthetic', projectId: 'project-a', role: 'ajudante', cwd: f.root, delegatorPaneId: f.identity.paneId }
  f.identities.set(id.paneId, id)
  const record = { delegatorPaneId: f.identity.paneId, projectId: 'project-a', cwd: f.root, state: 'working' }
  f.helpers.set(id.paneId, record)
  assert.equal(resolveMobileAgentTarget(f.context, id)?.missionId, f.mission.id)
  record.state = 'interrupted'
  assert.equal(resolveMobileAgentTarget(f.context, id), undefined)
  record.state = 'working'
  record.projectId = 'project-b'
  assert.equal(resolveMobileAgentTarget(f.context, id), undefined)
  record.projectId = 'project-a'
  f.identities.delete(f.identity.paneId)
  assert.equal(resolveMobileAgentTarget(f.context, id), undefined)
})

test('all agent calls bind mission and controller, never accept an owner actor', async t => {
  const f = fixture(t)
  await f.toolkit.status(f.identity)
  await f.toolkit.start(f.identity, { platform: 'android', deviceId: 'avd-a' })
  await f.toolkit.stop(f.identity, 'session-a')
  await f.toolkit.screenshot(f.identity, 'session-a')
  await f.toolkit.action(f.identity, 'session-a', { type: 'tap', x: 0.2, y: 0.4 })
  assert.equal(f.calls.length, 5)
  for (const call of f.calls) {
    assert.equal(call[1], f.mission.id)
    assert.deepEqual(call.at(-1), { kind: 'agent', paneId: f.identity.paneId })
  }
})

test('stale sessions and missing SDK are honest tool results with recovery recipe', async t => {
  const f = fixture(t)
  assert.equal((await f.toolkit.stop(f.identity, 'stale-session')).ok, false)
  f.runtime.start = async () => ({ ok: false, error: 'Android SDK ausente. Consulte mobile_status para configurar.' })
  const result = await f.toolkit.start(f.identity, { platform: 'android', deviceId: 'avd-a' })
  assert.equal(result.ok, false)
  assert.match(result.text, /SDK ausente/u)
  assert.match(result.text, /mobile_status/u)
})

test('screenshot returns actual inline image and dimensions without a persisted path', async t => {
  const f = fixture(t)
  const result = await f.toolkit.screenshot(f.identity, 'session-a')
  assert.equal(result.ok, true)
  assert.deepEqual(result.image, { data: f.frame.data, mimeType: 'image/png' })
  assert.match(result.text, /400.*800/u)
  assert.doesNotMatch(result.text, /\.synkora|[A-Za-z]:\\/u)
})

test('authority changed during capture cannot deliver device pixels', async t => {
  const f = fixture(t)
  f.runtime.capture = async () => { f.identities.delete(f.identity.paneId); return { ok: true, value: f.frame } }
  const result = await f.toolkit.screenshot(f.identity, 'session-a')
  assert.equal(result.ok, false)
  assert.equal(result.image, undefined)
})

test('telemetry never records typed text, URLs, local paths, frames or raw process errors', async t => {
  const f = fixture(t)
  await f.toolkit.action(f.identity, 'session-a', { type: 'text', text: 'synthetic-private-typing' })
  await f.toolkit.action(f.identity, 'session-a', { type: 'openUrl', url: 'https://example.invalid/synthetic-private-url' })
  await f.toolkit.screenshot(f.identity, 'session-a')
  f.runtime.act = async () => { throw new Error('synthetic-raw-process-output') }
  const failed = await f.toolkit.action(f.identity, 'session-a', { type: 'key', key: 'home' })
  assert.equal(failed.ok, false)
  const serialized = JSON.stringify(f.logs)
  assert.doesNotMatch(serialized, /synthetic-private|synthetic-raw|iVBOR|rootPath|cwd/u)
  assert.doesNotMatch(failed.text, /synthetic-raw/u)
  assert.ok(f.logs.every(event => event.paneId === f.identity.paneId))
})

test('action schemas reject unbounded coordinates, shell verbs and extra authority', () => {
  for (const action of [{ type: 'shell', command: 'whoami' }, { type: 'tap', x: Infinity, y: 0 },
    { type: 'tap', x: -1, y: 0.4 }, { type: 'tap', x: 0.2, y: 0.4, missionId: 'other' },
    { type: 'text', text: 'x'.repeat(10000) }, { type: 'key', key: 'POWER' }, { type: 'reverse', port: 65536 }]) {
    assert.equal(mobileActionSchema.safeParse(action).success, false)
  }
  for (const action of [{ type: 'tap', x: 0, y: 1 }, { type: 'swipe', x: 0.5, y: 0.8, endX: 0.5, endY: 0.2 },
    { type: 'text', text: 'Synthetic input' }, { type: 'key', key: 'back' }, { type: 'openUrl', url: 'http://localhost:8080/' },
    { type: 'install', relativePath: 'build/synthetic.apk' }, { type: 'launch', appId: 'example.synthetic' }, { type: 'reverse', port: 8080 }]) {
    assert.equal(mobileActionSchema.safeParse(action).success, true)
  }
})

test('Android display profile schemas expose exact IDs and reject dimensions or script-shaped values', () => {
  for (const profileId of DISPLAY_PROFILE_IDS) {
    assert.equal(mobileStartSchema.safeParse({ platform: 'android', deviceId: 'avd-a', displayProfileId: profileId }).success, true)
    assert.equal(mobileActionSchema.safeParse({ type: 'displayProfile', profileId }).success, true)
  }
  for (const profileId of ['custom', 'galaxy-s99', 'pixel-9;unexpected', ' pixel-9', 'pixel-9\n', { width: 1080 }, null, 9]) {
    assert.equal(mobileStartSchema.safeParse({ platform: 'android', deviceId: 'avd-a', displayProfileId: profileId }).success, false)
    assert.equal(mobileActionSchema.safeParse({ type: 'displayProfile', profileId }).success, false)
  }
  for (const extra of [{ width: 1080, height: 2400 }, { density: 420 }, { missionId: 'another' }]) {
    assert.equal(mobileStartSchema.safeParse({ platform: 'android', deviceId: 'avd-a', displayProfileId: 'pixel-7', ...extra }).success, false)
    assert.equal(mobileActionSchema.safeParse({ type: 'displayProfile', profileId: 'pixel-7', ...extra }).success, false)
  }
  assert.equal(mobileStartSchema.safeParse({ platform: 'ios', deviceId: 'simulator-a', displayProfileId: 'native' }).success, false)
  assert.equal(mobileStartSchema.safeParse({ platform: 'ios', deviceId: 'simulator-a' }).success, true)
})

test('agent discovery explains screen profiles and profile calls retain authenticated mission and controller', async t => {
  const f = fixture(t), catalog = new Map()
  registerMobileKit({ registerTool: (name, definition, callback) => catalog.set(name, { definition, callback }) }, f.toolkit, f.identity)
  const start = catalog.get('mobile_start'), action = catalog.get('mobile_action')
  for (const id of DISPLAY_PROFILE_IDS) assert.ok(start.definition.description.includes(id), id)
  assert.match(start.definition.description, /densidade/u)
  assert.match(action.definition.description, /displayProfile/u)
  assert.match(action.definition.description, /mobile_screenshot/u)
  f.session.displayProfileId = 'galaxy-s24'
  const started = await start.callback({ platform: 'android', deviceId: 'avd-a', displayProfileId: 'galaxy-s24' })
  assert.equal(JSON.parse(started.content[0].text).displayProfileId, 'galaxy-s24')
  assert.deepEqual(f.calls.at(-1), ['start', f.mission.id, { platform: 'android', deviceId: 'avd-a', displayProfileId: 'galaxy-s24' }, { kind: 'agent', paneId: f.identity.paneId }])
  const status = await f.toolkit.status(f.identity)
  assert.equal(JSON.parse(status.text).sessions[0].displayProfileId, 'galaxy-s24')
  await action.callback({ sessionId: 'session-a', action: { type: 'displayProfile', profileId: 'native' } })
  assert.deepEqual(f.calls.at(-1), ['act', f.mission.id, 'session-a', { type: 'displayProfile', profileId: 'native' }, { kind: 'agent', paneId: f.identity.paneId }])
})

test('MCP catalog is bounded, keeps image content and never adds structuredContent', async t => {
  const f = fixture(t)
  const tools = new Map()
  registerMobileKit({ registerTool: (name, definition, callback) => tools.set(name, { definition, callback }) }, f.toolkit, f.identity)
  assert.deepEqual([...tools.keys()].sort(), [...MOBILE_TOOL_NAMES].sort())
  const result = await tools.get('mobile_screenshot').callback({ sessionId: 'session-a' })
  assert.equal(result.structuredContent, undefined)
  assert.equal(result.content.filter(block => block.type === 'image').length, 1)
  for (const tool of tools.values()) assert.equal('missionId' in (tool.definition.inputSchema ?? {}), false)
  assert.ok(tools.has('mobile_expo'))
})

test('Expo actions bind live mission and agent, while metadata omits QR images and private process data', async t => {
  const f = fixture(t)
  for (const request of [{ action: 'status' }, { action: 'start' }, { action: 'stop' },
    { action: 'open_android', sessionId: 'session-a' }, { action: 'install_go', sessionId: 'session-a' }]) {
    const reply = await f.toolkit.expo(f.identity, request)
    assert.equal(reply.ok, true)
    assert.equal(reply.image, undefined)
    assert.doesNotMatch(reply.text, /qrDataUrl|base64|synthetic-private-qr/u)
    if (request.action === 'status' || request.action === 'start') assert.match(reply.text, /exp:\/\/192\.168\.0\.2:8081/u)
  }
  assert.deepEqual(f.calls.map(call => call[0]), ['expo:inspect', 'expo:start', 'expo:stop', 'expo:openAndroid', 'expo:installGo'])
  for (const call of f.calls) {
    assert.equal(call[1], f.mission.id)
    assert.deepEqual(call.at(-1), { kind: 'agent', paneId: f.identity.paneId })
  }
  assert.deepEqual(f.calls[1][2], {}, 'agent cannot select an address, port or CLI target')
  assert.doesNotMatch(JSON.stringify(f.logs), /192\.168|8081|qrDataUrl|synthetic-private/u)
})

test('Expo authorization fails before launch, and revoked authority suppresses server details', async t => {
  const f = fixture(t)
  const foreign = { ...f.identity, role: 'gui-planner' }
  f.identities.set(foreign.paneId, foreign)
  assert.equal((await f.toolkit.expo(foreign, { action: 'start' })).ok, false)
  assert.equal(f.calls.length, 0)
  f.identities.set(f.identity.paneId, f.identity)
  f.expo.start = async () => { f.identities.delete(f.identity.paneId); return { ok: true, value: f.expoState } }
  const reply = await f.toolkit.expo(f.identity, { action: 'start' })
  assert.equal(reply.ok, false)
  assert.doesNotMatch(reply.text, /192\.168|exp:\/\//u)
})

test('Expo schema offers only bounded actions and requires an Android session for effects', () => {
  for (const request of [{ action: 'start', url: 'exp://example.invalid:8081' }, { action: 'start', root: '/other' },
    { action: 'start', port: 8081 }, { action: 'start', address: '192.168.0.2' }, { action: 'install_go' },
    { action: 'open_android', sessionId: '' }, { action: 'tunnel' }, { action: 'shell', command: 'anything' }]) {
    assert.equal(mobileExpoSchema.safeParse(request).success, false)
  }
  for (const request of [{ action: 'status' }, { action: 'start' }, { action: 'stop' },
    { action: 'open_android', sessionId: 'session-a' }, { action: 'install_go', sessionId: 'session-a' }]) {
    assert.equal(mobileExpoSchema.safeParse(request).success, true)
  }
})

test('unavailable engine remains discoverable and never claims a device was started', async () => {
  const tools = new Map()
  registerMobileKit({ registerTool: (name, definition, callback) => tools.set(name, callback) }, undefined, {})
  const result = await tools.get('mobile_start')({ platform: 'android', deviceId: 'avd-a' })
  assert.equal(result.structuredContent, undefined)
  assert.match(result.content[0].text, /mobile_status/u)
  assert.match(result.content[0].text, /Nenhum dispositivo/u)
})

test('real MCP bearer scopes mobile tools, validates actions and routes inline screenshots', async t => {
  const f = fixture(t)
  const hub = new Hub({ projectPathOf: () => f.root, ensureProjectRuntimeWritable: () => undefined, onEvent: () => undefined })
  f.context.identityOf = paneId => hub.identityByPane(paneId)
  hub.registerPane('synthetic-dev-token', f.identity)
  const server = await startMcpServer({ hub, mobile: f.toolkit })
  t.after(() => server.close())
  const open = async (token, name) => {
    const client = new Client({ name, version: '1.0.0' }, { cachePartition: name })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { authProvider: { token: async () => token } }))
    t.after(() => client.close())
    return client
  }
  const client = await open('synthetic-dev-token', 'mobile-dev')
  const catalog = (await client.listTools()).tools
  assert.deepEqual(catalog.map(tool => tool.name).filter(name => name.startsWith('mobile_')).sort(), [...MOBILE_TOOL_NAMES].sort())
  assert.equal(catalog.find(tool => tool.name === 'mobile_expo').inputSchema.type, 'object')
  const screenshot = await client.callTool({ name: 'mobile_screenshot', arguments: { sessionId: 'session-a' } })
  assert.equal(screenshot.structuredContent, undefined)
  assert.equal(screenshot.content.find(block => block.type === 'image')?.data, f.frame.data)
  const expo = await client.callTool({ name: 'mobile_expo', arguments: { action: 'status' } })
  assert.match(expo.content[0].text, /exp:\/\/192\.168\.0\.2:8081/u)
  assert.equal(expo.content.length, 1, 'QR pixels remain in the owner UI')
  assert.equal(expo.structuredContent, undefined)
  for (const id of DISPLAY_PROFILE_IDS) assert.ok(JSON.stringify(catalog.find(tool => tool.name === 'mobile_start').inputSchema).includes(id), id)
  await client.callTool({ name: 'mobile_start', arguments: { platform: 'android', deviceId: 'avd-a', displayProfileId: 'pixel-9' } })
  assert.deepEqual(f.calls.at(-1), ['start', f.mission.id, { platform: 'android', deviceId: 'avd-a', displayProfileId: 'pixel-9' }, { kind: 'agent', paneId: f.identity.paneId }])
  await client.callTool({ name: 'mobile_action', arguments: { sessionId: 'session-a', action: { type: 'displayProfile', profileId: 'galaxy-a54' } } })
  assert.deepEqual(f.calls.at(-1), ['act', f.mission.id, 'session-a', { type: 'displayProfile', profileId: 'galaxy-a54' }, { kind: 'agent', paneId: f.identity.paneId }])
  const before = f.calls.length
  for (const [name, arguments_] of [
    ['mobile_start', { platform: 'android', deviceId: 'avd-a', displayProfileId: 'unknown' }],
    ['mobile_start', { platform: 'android', deviceId: 'avd-a', displayProfileId: 'pixel-7', density: 420 }],
    ['mobile_start', { platform: 'android', deviceId: 'avd-a', displayProfileId: 'pixel-7', actor: { kind: 'owner' } }],
    ['mobile_action', { sessionId: 'session-a', action: { type: 'displayProfile', profileId: 'pixel-7', width: 1080 } }],
    ['mobile_action', { sessionId: 'session-a', action: { type: 'displayProfile', profileId: 'pixel-7' }, height: 2400 }],
    ['mobile_action', { sessionId: 'session-a', action: { type: 'displayProfile', profileId: 'native' }, actor: { kind: 'owner' } }]
  ]) {
    assert.equal((await client.callTool({ name, arguments: arguments_ })).isError, true)
    assert.equal(f.calls.length, before)
  }
  const foreignExpo = await client.callTool({ name: 'mobile_expo', arguments: { action: 'start', root: '/foreign' } })
  assert.equal(foreignExpo.isError, true)
  assert.equal(f.calls.length, before)
  const invalid = await client.callTool({ name: 'mobile_action', arguments: { sessionId: 'session-a', action: { type: 'shell', command: 'synthetic' } } })
  assert.equal(invalid.isError, true)
  assert.equal(f.calls.length, before)
  assert.equal((await client.callTool({ name: 'mobile_action', arguments: { missionId: 'other-mission', sessionId: 'session-a', action: { type: 'tap', x: 0.5, y: 0.5 } } })).isError, true)
  assert.equal(f.calls.length, before)
  for (const [label, patch] of [['planner', { role: 'gui-planner' }], ['release', { role: 'gui-release' }], ['reviewer', { paneId: 'gui-reviewer-a1111111' }]]) {
    const token = `synthetic-${label}-token`
    hub.registerPane(token, { ...f.identity, paneId: `gui-dev-${label}`, ...patch })
    const other = await open(token, `mobile-${label}`)
    assert.deepEqual((await other.listTools()).tools.filter(tool => tool.name.startsWith('mobile_')), [])
  }
  hub.unregisterPane(f.identity.paneId)
  await assert.rejects(() => client.callTool({ name: 'mobile_screenshot', arguments: { sessionId: 'session-a' } }))
})

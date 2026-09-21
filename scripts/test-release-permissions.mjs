import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const compiled = buildSync({
  stdin: { contents: `
    export { default as GuiPane } from './src/renderer/src/components/GuiPane';
    export { default as Board } from './src/renderer/src/components/Board';
    export { installDevMock } from './src/renderer/src/devMock';
    export { useStore } from './src/renderer/src/store';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'zustand']
}).outputFiles[0].text

const ipcCode = buildSync({ entryPoints: ['src/main/ipc/missions.ts'], bundle: true,
  platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text

function missionSpec({ missionType, cli = 'codex', saved = 'plan', requested, role = 'dev' }) {
  const handlers = new Map()
  const loaded = { exports: {} }
  const require = createRequire(import.meta.url)
  const electron = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    app: { getPath: () => resolve('.synkora/release-permissions-state'), on() {}, once() {},
      getName: () => 'synkora-test', getVersion: () => '0.0.0-test', isPackaged: false } }
  new Function('require', 'module', 'exports', '__dirname', ipcCode)(
    id => id === 'electron' ? electron : require(id), loaded, loaded.exports, resolve('src/main/ipc'))
  const mission = { id: 'synthetic-mission', projectId: 'synthetic', title: 'Synthetic mission',
    direct: true, missionType, seatId: 'synthetic-seat', versionId: 'synthetic-version',
    status: 'ativa', createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' }
  const project = { id: 'synthetic', name: 'Synthetic project', path: process.cwd() }
  const seat = { id: 'synthetic-seat', cli }
  loaded.exports.registerMissionsIpc({
    projects: { get: () => project }, missions: { get: () => mission },
    seats: { get: () => seat, preseed() {}, configDirOf: () => resolve('.synkora/synthetic-seat') },
    backlog: { getVersion: () => ({ id: 'synthetic-version', projectId: 'synthetic', status: 'lancada' }) },
    blackbox: { record() {} }, integrationQueue: { getByMission: () => undefined },
    mcpPort: 0, paneTokens: new Map(), paneMcpFiles: new Map(), hub: {}
  }, {
    engine: { ensureMissionWorktree: async () => mission, missionWorkspacePath: async () => project.path },
    maestroEngine: {}, staggerPaneSpawn: async () => {}, projectContextBriefing: () => '',
    guiSessions: { remembered: () => ({ cli, projectId: 'synthetic', sessionId: 'synthetic-resume',
      permissionMode: saved, model: 'synthetic-model', effort: 'high' }), has: () => false }
  })
  return handlers.get('missions:guiSpec')({}, mission.id, role, requested)
}

async function mountPane(t, props = {}, { missions, replay, createResult = { ok: true } } = {}) {
  const stored = new Map()
  const storage = { getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) }
  const window = Object.assign(new EventTarget(), { location: { search: '' }, localStorage: storage,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    setTimeout, clearTimeout, setInterval, clearInterval })
  const document = { visibilityState: 'visible', documentElement: { style: { setProperty() {} } },
    addEventListener() {}, removeEventListener() {}, getSelection: () => null }
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'window', 'document', 'localStorage', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports, window, document, storage)
  const { GuiPane, Board, installDevMock, useStore } = loaded.exports
  installDevMock()
  const spawns = [], selections = []
  window.synkora.gui.state = async () => replay ?? { exists: false, alive: false, cursor: 0, events: [] }
  window.synkora.gui.create = async spawn => {
    spawns.push(spawn)
    if (!createResult.ok) return createResult
    useStore.getState().handleGuiLive(spawn.paneId, { type: 'ready', caps: {
      models: [{ value: 'default', displayName: 'Padrão', supportsFastMode: true }], commands: []
    } })
    return { ok: true }
  }
  let current = { paneId: 'gui-dev-synthetic', projectId: 'synthetic', cli: 'codex',
    configDir: 'synthetic-config', cwd: 'synthetic-workspace', active: true, showHeader: false,
    onPermissionMode: value => selections.push(value), ...props }
  if (missions) {
    window.synkora.missions.list = async () => missions
    window.synkora.missions.guiSpec = async id => ({ ok: true, spawn: {
      paneId: `gui-dev-${id}`, projectId: 'synthetic', cli: 'codex',
      configDir: 'synthetic-config', cwd: 'synthetic-workspace', permissionMode: 'plan'
    } })
    useStore.setState({ missions, missionsByProject: { synthetic: missions },
      openProjectId: 'synthetic', missionTabByProject: { synthetic: missions[0].id } })
  }
  let tree
  t.after(async () => { if (tree) await act(async () => tree.unmount()) })
  await act(async () => { tree = create(missions ? React.createElement(Board, { projectId: 'synthetic' }) :
    React.createElement(GuiPane, current)) })
  const modeButton = () => tree.root.find(node => node.type === 'button' &&
    node.props['aria-label']?.startsWith('Permissão desta conversa:'))
  return {
    tree, spawns, selections, useStore,
    modeButton,
    async update(patch) {
      current = { ...current, ...patch }
      await act(async () => tree.update(React.createElement(GuiPane, current)))
    },
    async menu() {
      await act(async () => modeButton().props.onClick())
      return tree.root.findAll(node => node.type === 'button' && node.props.role === 'menuitem')
    }
  }
}

// Removing the role filter must expose plan again; changing the fallback to
// acceptEdits/bypass must fail the emitted-spawn and selected-button assertions.
for (const cli of ['codex', 'claude']) {
  test(`${cli}: release menu excludes planning even with a dev pane id and generic header role`, async t => {
    const pane = await mountPane(t, { cli, missionType: 'release', role: 'agente' })
    const menu = await pane.menu()
    assert.deepEqual(menu.map(item => item.props.className.split(' ')[1]),
      ['mode-default', 'mode-acceptEdits', 'mode-bypass'])
  })

  test(`${cli}: persisted release plan starts with default permissions and keeps conversation settings`, async t => {
    const pane = await mountPane(t, { cli, missionType: 'release', permissionMode: 'plan',
      resumeSessionId: 'synthetic-resume', fast: true, model: 'synthetic-model', effort: 'high' })
    assert.equal(pane.spawns.length, 1)
    assert.equal(pane.spawns[0].permissionMode, 'default')
    assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: padrão')
    assert.equal(pane.spawns[0].resumeSessionId, 'synthetic-resume')
    assert.equal(pane.spawns[0].fast, true)
    assert.equal(pane.spawns[0].model, 'synthetic-model')
    assert.equal(pane.spawns[0].effort, 'high')
  })
}

test('release selections arriving after mount normalize before fast respawn', async t => {
  const pane = await mountPane(t, { missionType: 'release', permissionMode: 'acceptEdits' })
  await pane.update({ permissionMode: 'plan' })
  assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: padrão')
  await act(async () => pane.tree.root.find(node => node.type === 'button' &&
    node.props.className?.includes('gui-fast-btn')).props.onClick())
  assert.equal(pane.spawns.at(-1).permissionMode, 'default')
  assert.equal(pane.spawns.at(-1).fast, true)
})

for (const missionType of ['dev', 'planejamento', undefined]) {
  test(`${missionType ?? 'legacy'} chat retains planning regardless of its header label`, async t => {
    const pane = await mountPane(t, { missionType, permissionMode: 'plan', role: 'release' })
    assert.equal(pane.spawns[0].permissionMode, 'plan')
    assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: plano')
    const menu = await pane.menu()
    assert.equal(menu.filter(item => item.props.className.includes('mode-plan')).length, 1)
  })
}

for (const permissionMode of ['default', 'acceptEdits', 'bypass']) {
  test(`release preserves an explicit ${permissionMode} selection`, async t => {
    const pane = await mountPane(t, { missionType: 'release', permissionMode })
    assert.equal(pane.spawns[0].permissionMode, permissionMode)
    const menu = await pane.menu()
    const chosen = menu.find(item => item.props.className.includes(`mode-${permissionMode}`))
    assert.ok(chosen.props.className.includes(' active'))
  })
}

test('release permission changes use the existing spawn and selection callback', async t => {
  const pane = await mountPane(t, { missionType: 'release', permissionMode: 'plan' })
  const menu = await pane.menu()
  await act(async () => menu.find(item => item.props.className.includes('mode-acceptEdits')).props.onClick())
  assert.equal(pane.spawns.at(-1).permissionMode, 'acceptEdits')
  assert.deepEqual(pane.selections, ['acceptEdits'])
  assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: edições')
})

test('Board routes the mission type for each mounted chat across tab changes', async t => {
  const missions = [
    { id: 'release1', missionType: 'release' },
    { id: 'develop1', missionType: 'dev' }
  ].map(mission => ({ ...mission, projectId: 'synthetic', title: 'Synthetic chat', status: 'ativa',
    direct: true, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' }))
  const board = await mountPane(t, {}, { missions })
  assert.equal(board.spawns[0]?.permissionMode, 'default')
  await act(async () => board.useStore.getState().setMissionTab('synthetic', 'develop1'))
  assert.equal(board.spawns.at(-1)?.permissionMode, 'plan')
  const buttons = board.tree.root.findAll(node => node.type === 'button' &&
    node.props['aria-label']?.startsWith('Permissão desta conversa:'))
  assert.deepEqual(buttons.map(node => node.props['aria-label']),
    ['Permissão desta conversa: padrão', 'Permissão desta conversa: plano'])
})

for (const working of [false, true]) {
  test(`a live release in planning is reported honestly on ${working ? 'active' : 'idle'} remount without respawn`, async t => {
    const pane = await mountPane(t, { missionType: 'release', permissionMode: 'default' }, { replay: {
      exists: true, alive: true, permissionMode: 'plan', cursor: 1,
      events: [{ seq: 1, evt: { type: 'ready', caps: { models: [], commands: [] } } }]
    } })
    if (working) await act(async () => pane.useStore.setState(state => ({ guiPanes: {
      ...state.guiPanes, 'gui-dev-synthetic': { ...state.guiPanes['gui-dev-synthetic'], status: 'working' }
    } })))
    assert.equal(pane.spawns.length, 0, 'remount must preserve the running conversation')
    assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: plano')
    assert.equal(pane.modeButton().props.disabled, working)
    if (working) return
    const menu = await pane.menu()
    assert.equal(menu.some(item => item.props.className.includes('mode-plan')), false)
    assert.equal(menu.some(item => item.props.className.includes(' active')), false)
    await act(async () => menu.find(item => item.props.className.includes('mode-default')).props.onClick())
    assert.equal(pane.spawns.length, 1)
    assert.equal(pane.spawns[0].permissionMode, 'default')
    assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: padrão')
  })
}

test('a failed change keeps the live release planning permission visible', async t => {
  const pane = await mountPane(t, { missionType: 'release', permissionMode: 'default' }, {
    replay: { exists: true, alive: true, permissionMode: 'plan', cursor: 1,
      events: [{ seq: 1, evt: { type: 'ready', caps: { models: [], commands: [] } } }] },
    createResult: { ok: false, error: 'synthetic refusal' }
  })
  const menu = await pane.menu()
  await act(async () => menu.find(item => item.props.className.includes('mode-default')).props.onClick())
  assert.equal(pane.spawns.length, 1)
  assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: plano')
})

test('sending after a legacy release closes clears its old plan label after revival', async t => {
  const pane = await mountPane(t, { missionType: 'release', permissionMode: 'default' }, { replay: {
    exists: true, alive: true, permissionMode: 'plan', cursor: 1,
    events: [{ seq: 1, evt: { type: 'ready', caps: { models: [], commands: [] } } }]
  } })
  await act(async () => pane.useStore.getState().handleGuiLive('gui-dev-synthetic', { type: 'closed', code: 0 }))
  await act(async () => pane.tree.root.findByProps({ 'aria-label': 'Mensagem para esta conversa' })
    .props.onChange({ currentTarget: { value: 'Continue a entrega sintética', selectionStart: 27 } }))
  await act(async () => pane.tree.root.findByProps({ 'aria-label': 'Enviar mensagem' }).props.onClick())
  assert.equal(pane.spawns.length, 1)
  assert.equal(pane.spawns[0].permissionMode, 'default')
  assert.equal(pane.modeButton().props['aria-label'], 'Permissão desta conversa: padrão')
})

for (const cli of ['codex', 'claude']) {
  for (const requested of [undefined, 'plan']) {
    test(`${cli}: canonical release spec normalizes ${requested ? 'explicit' : 'saved'} planning`, async () => {
      const result = await missionSpec({ missionType: 'release', cli, saved: requested ? 'bypass' : 'plan', requested })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.spawn.permissionMode, 'default')
      assert.equal(result.spawn.resumeSessionId, 'synthetic-resume')
      assert.equal(result.spawn.model, 'synthetic-model')
      assert.equal(result.spawn.effort, 'high')
    })
  }
}

for (const [missionType, role] of [['dev', 'dev'], ['dev', 'reviewer'], ['dev', 'helper'], ['planejamento', 'dev']]) {
  test(`${missionType}/${role}: canonical spec keeps planning available`, async () => {
    const result = await missionSpec({ missionType, role })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.spawn.permissionMode, 'plan')
  })
}

for (const requested of ['default', 'acceptEdits', 'bypass']) {
  test(`canonical release spec preserves an explicit ${requested} choice over saved planning`, async () => {
    const result = await missionSpec({ missionType: 'release', requested })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.spawn.permissionMode, requested)
  })
}

test('the shared harness server serves the real release fixture JavaScript and imported CSS', async () => {
  const source = resolve('scripts/harness-serve.mjs')
  const code = buildSync({ entryPoints: [source], bundle: true, packages: 'external',
    platform: 'node', format: 'cjs', write: false,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(source).href) } }).outputFiles[0].text
  const require = createRequire(import.meta.url)
  let handler
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(id => id === 'node:http' ? {
    createServer: callback => { handler = callback; return { listen() {} } }
  } : require(id), module, module.exports)
  for (const [path, contentType] of [
    ['/release-permissions.js', 'text/javascript'],
    ['/release-permissions.css', 'text/css; charset=utf-8']
  ]) {
    let status, headers, body
    await handler({ url: path }, {
      writeHead: (code, value) => { status = code; headers = value },
      end: value => { body = Buffer.from(value).toString('utf8') }
    })
    assert.equal(status, 200, `${path}: ${body}`)
    assert.equal(headers['content-type'], contentType)
    assert.ok(body.length > 0)
    if (path.endsWith('.js')) assert.doesNotThrow(() => new Script(body))
  }
})

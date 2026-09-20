import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const require = createRequire(import.meta.url)
const compiled = buildSync({ stdin: { contents: `
  export * from './workspacePanels'
  export * from './workspace/useWorkspaceLayout'
  export * from './workspace/WorkspacePanelContext'
  export { default as WorkspacePanels } from './workspace/WorkspacePanels'
  export { default as DockSection } from './components/DockSection'
`, resolveDir: 'src/renderer/src', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'react-dom'] }).outputFiles[0].text

function runtime() {
  const values = new Map(), observers = [], frames = []
  const window = Object.assign(new EventTarget(), {
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    getComputedStyle: () => ({ flexDirection: 'row-reverse' }),
    requestAnimationFrame: run => { frames.push(run); return frames.length }, cancelAnimationFrame() {}
  })
  class Observer { constructor(run) { this.run = run; observers.push(this) } observe() {} disconnect() {} }
  const module = { exports: {} }
  const load = name => name === 'react-dom' ? { ...require(name), createPortal: children => children } : require(name)
  new Function('require', 'module', 'exports', 'window', 'document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', compiled)(
    load, module, module.exports, window, { body: {} }, Observer, window.requestAnimationFrame, window.cancelAnimationFrame)
  return { ...module.exports, values, observers, flushFrames: () => { for (const run of frames.splice(0)) run() } }
}

function exclusive(state) {
  assert.deepEqual(state.panels, state.columns.flat())
  assert.equal(new Set(state.panels).size, state.panels.length, 'panels are never duplicated')
  assert.ok(state.columns.every(column => column.length > 0 && column.length <= 2))
  for (const column of state.columns) if (column.includes('mobile')) assert.deepEqual(column, ['mobile'])
}

const mixed = (mobileFirst = false) => ({
  panels: ['browser', 'mobile', 'frota', 'historico'],
  columns: [mobileFirst ? ['mobile', 'browser'] : ['browser', 'mobile'], ['frota', 'historico']],
  columnWidths: [620, 780], rowSplits: [33, 67], maximized: 'mobile', fitToChat: true, sidebarCollapsed: true
})

test('empty workspace stays closed and every opening order gives Mobile its own column', () => {
  const m = runtime()
  assert.deepEqual(m.normalizeWorkspacePreference(null).columns, [])
  for (const other of ['browser', 'frota', 'trabalho', 'historico', 'release']) {
    for (const order of [[other, 'mobile'], ['mobile', other]]) {
      let state = m.normalizeWorkspacePreference({ columnWidths: [940, 880] })
      for (const id of order) state = m.openWorkspacePanel(state, id)
      assert.deepEqual(state.columns, order.map(id => [id]))
      assert.deepEqual(state.columnWidths, [360, 360], 'new columns retain minimum-opening behavior')
      exclusive(state)
    }
  }
})

test('legacy panel-only preferences keep order and pair only non-Mobile neighbors', () => {
  const m = runtime()
  for (const panels of [
    ['mobile', 'browser', 'frota', 'trabalho', 'historico'],
    ['browser', 'mobile', 'frota', 'trabalho', 'historico'],
    ['browser', 'frota', 'mobile', 'trabalho', 'historico'],
    ['browser', 'frota', 'trabalho', 'historico', 'mobile']
  ]) {
    const state = m.normalizeWorkspacePreference({ panels })
    exclusive(state)
    assert.deepEqual(state.panels, panels)
    assert.deepEqual(m.normalizeWorkspacePreference(state), state)
  }
})

for (const mobileFirst of [false, true]) {
  test(`mixed saved column migrates in place with original sizing (Mobile ${mobileFirst ? 'first' : 'last'})`, () => {
    const m = runtime(), raw = mixed(mobileFirst), before = JSON.stringify(raw)
    const state = m.normalizeWorkspacePreference(raw)
    assert.deepEqual(state.columns, [...raw.columns[0].map(id => [id]), ['frota', 'historico']])
    assert.deepEqual(state.columnWidths, [620, 620, 780], 'following columns retain their own original width')
    assert.deepEqual(state.rowSplits, [33, 33, 67], 'row preferences follow their source column')
    assert.equal(state.maximized, 'mobile')
    assert.equal(state.fitToChat, true)
    assert.equal(state.sidebarCollapsed, true)
    assert.equal(JSON.stringify(raw), before, 'normalization does not mutate the saved object')
    assert.deepEqual(m.normalizeWorkspacePreference(JSON.parse(JSON.stringify(state))), state)
    exclusive(state)
  })
}

test('already separate user columns are not compacted or resized', () => {
  const m = runtime()
  const state = m.normalizeWorkspacePreference({ panels: ['browser', 'mobile', 'frota', 'historico'],
    columns: [['browser'], ['mobile'], ['frota'], ['historico']], columnWidths: [510, 680, 790, 920], rowSplits: [26, 37, 48, 59] })
  assert.deepEqual(state.columns, [['browser'], ['mobile'], ['frota'], ['historico']])
  assert.deepEqual(state.columnWidths, [510, 680, 790, 920])
  assert.deepEqual(state.rowSplits, [26, 37, 48, 59])
  assert.deepEqual(m.normalizeWorkspacePreference(state), state)
})

test('panel-only legacy layouts keep original pair widths when Mobile is split out', () => {
  const m = runtime()
  for (const pair of [['browser', 'mobile'], ['mobile', 'browser']]) {
    const state = m.normalizeWorkspacePreference({ panels: [...pair, 'frota', 'historico'],
      columnWidths: [620, 780], rowSplits: [33, 67] })
    assert.deepEqual(state.columns, [...pair.map(id => [id]), ['frota', 'historico']])
    assert.deepEqual(state.columnWidths, [620, 620, 780])
    assert.deepEqual(state.rowSplits, [33, 33, 67])
    assert.deepEqual(m.normalizeWorkspacePreference(state), state)
    exclusive(state)
  }
})

test('malformed columns retain each known panel once and map sizing from the original column', () => {
  const m = runtime()
  const state = m.normalizeWorkspacePreference({ panels: ['browser', 'mobile', 'frota', 'historico', 'mobile', 'unknown'],
    columns: [null, ['browser', 'mobile', 'frota', 'mobile'], ['historico', 'browser', 'unknown']],
    columnWidths: [400, 680, 910], rowSplits: [22, 36, 64] })
  assert.deepEqual(state.columns, [['browser'], ['mobile'], ['frota'], ['historico']])
  assert.deepEqual(state.columnWidths, [680, 680, 680, 910])
  assert.deepEqual(state.rowSplits, [36, 36, 36, 64])
  exclusive(state)
})

test('row drops are rejected in both directions without changing a valid layout', () => {
  const m = runtime()
  const state = m.normalizeWorkspacePreference({ panels: ['browser', 'mobile', 'frota'], columns: [['browser'], ['mobile'], ['frota']] })
  for (const other of ['browser', 'frota']) for (const edge of ['above', 'below']) {
    for (const [id, panel] of [['mobile', other], [other, 'mobile']]) {
      assert.equal(m.canMoveWorkspacePanel(state, id, { panel, edge }), false)
      assert.deepEqual(m.moveWorkspacePanel(state, id, { panel, edge }), state)
    }
  }
})

test('horizontal movement keeps Mobile exclusive and carries its width', () => {
  const m = runtime()
  let state = m.normalizeWorkspacePreference({ panels: ['browser', 'frota', 'mobile', 'trabalho', 'historico'],
    columns: [['browser', 'frota'], ['mobile'], ['trabalho', 'historico']], columnWidths: [620, 680, 760], rowSplits: [33, 44, 67] })
  state = m.moveWorkspacePanel(state, 'mobile', { panel: 'browser', edge: 'left' })
  assert.deepEqual(state.columns, [['mobile'], ['browser', 'frota'], ['trabalho', 'historico']])
  assert.deepEqual(state.columnWidths, [680, 620, 760])
  state = m.moveWorkspacePanel(state, 'mobile', { panel: 'trabalho', edge: 'right' })
  assert.deepEqual(state.columns, [['browser', 'frota'], ['trabalho', 'historico'], ['mobile']])
  assert.deepEqual(state.columnWidths, [620, 760, 680])
  state = m.moveWorkspacePanel(state, 'frota', { panel: 'mobile', edge: 'left' })
  assert.deepEqual(state.columns, [['browser'], ['trabalho', 'historico'], ['frota'], ['mobile']])
  assert.deepEqual(state.columnWidths, [620, 760, 620, 680])
  exclusive(state)
})

test('other panels still stack and closing Mobile does not compact unrelated columns', () => {
  const m = runtime()
  let state = m.normalizeWorkspacePreference({ panels: ['browser', 'mobile', 'frota', 'historico'],
    columns: [['browser'], ['mobile'], ['frota'], ['historico']], columnWidths: [510, 680, 790, 920] })
  state = m.moveWorkspacePanel(state, 'historico', { panel: 'frota', edge: 'above' })
  assert.deepEqual(state.columns, [['browser'], ['mobile'], ['historico', 'frota']])
  state = m.closeWorkspacePanel(state, 'mobile')
  assert.deepEqual(state.columns, [['browser'], ['historico', 'frota']])
  assert.deepEqual(state.columnWidths, [510, 790])
  state = m.openWorkspacePanel(state, 'mobile')
  assert.deepEqual(state.columns, [['browser'], ['historico', 'frota'], ['mobile']])
  assert.deepEqual(state.columnWidths, [510, 790, 360])
  exclusive(state)
})

test('narrow windows project widths without stacking Mobile or overwriting saved sizes', () => {
  const m = runtime(), state = m.normalizeWorkspacePreference(mixed())
  const saved = JSON.stringify(state)
  for (const board of [0, 100, 320, 800, 1700]) for (const fit of [false, true]) {
    const layout = m.workspacePanelLayout(board, 0, state.panels.length, state.columnWidths, false, state.columns.length, fit)
    const widths = m.fitWorkspaceColumnWidths(state.columnWidths, layout.width)
    const gap = Math.min(m.PANEL_GAP, layout.width / Math.max(1, state.columns.length - 1))
    assert.ok(widths.every(width => Number.isFinite(width) && width >= 0))
    assert.ok(widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1) <= layout.width + 0.001)
    const position = m.workspacePanelPosition(state.panels.indexOf('mobile'), state.panels.length, false, state.columns)
    assert.equal(position.span, 2)
    assert.equal(position.row, 1)
  }
  assert.equal(JSON.stringify(state), saved)
})

async function harness(t, saved) {
  const m = runtime(), mounts = new Map(), unmounts = []
  let controller, tree, width = 1700
  let props = { projectId: 'column-qa', missionId: 'one', available: m.availableWorkspacePanels('dev', true), visible: true }
  if (saved) m.values.set(m.workspaceStorageKey(props.projectId, props.missionId), JSON.stringify(saved))
  const ref = { current: null }
  const box = id => {
    const columns = controller.preference.columns.map(column => column.filter(panel => props.available.includes(panel))).filter(column => column.length)
    const column = columns.findIndex(items => items.includes(id)), items = columns[column] ?? []
    const row = items.indexOf(id), left = Math.max(0, column) * 400, top = row > 0 ? 310 : 0, height = items.length === 2 ? 290 : 600
    return { left, right: left + 360, top, bottom: top + height, width: 360, height }
  }
  const board = { style: { setProperty() {}, removeProperty() {} },
    getBoundingClientRect: () => ({ width, left: 0, right: width, top: 0, bottom: 600 }), querySelector: () => null,
    querySelectorAll: () => controller.preference.panels.filter(id => props.available.includes(id)).map(id => ({
      dataset: { workspacePanel: id }, getBoundingClientRect: () => box(id)
    })) }
  function Content({ id }) {
    React.useEffect(() => { mounts.set(id, (mounts.get(id) ?? 0) + 1); return () => { unmounts.push(id) } }, [id])
    return React.createElement('p', null, id)
  }
  function Harness({ projectId, missionId, available, visible }) {
    controller = m.useWorkspaceLayout(projectId, missionId)
    return React.createElement('div', { ref, 'data-column-qa': true },
      React.createElement(m.WorkspacePanels, { controller, projectId, boardRef: ref, available, visible, enabled: true, legacyEnabled: false },
        m.WORKSPACE_PANELS.map(({ id, title }) => React.createElement(m.DockSection, { id, title, key: id }, React.createElement(Content, { id })))))
  }
  await act(() => { tree = create(React.createElement(Harness, props), { createNodeMock: node => node.props['data-column-qa'] ? board : { clientHeight: 600 } }) })
  const settle = async () => { await act(() => m.flushFrames()); await act(() => m.flushFrames()) }
  await settle()
  t.after(async () => { await act(() => tree.unmount()) })
  return { m, tree, mounts, unmounts, box, controller: () => controller,
    panel: id => tree.root.findByProps({ 'data-workspace-panel': id }),
    run: async (method, ...args) => { await act(() => controller[method](...args)); await settle() },
    update: async patch => { props = { ...props, ...patch }; await act(() => tree.update(React.createElement(Harness, props))); await settle() },
    resize: async next => { width = next; await act(() => m.observers.forEach(observer => observer.run())) }
  }
}

test('the hook migrates saved Mobile rows before rendering and persists the canonical layout per mission', async t => {
  const h = await harness(t, mixed())
  exclusive(h.controller().preference)
  const key = h.m.workspaceStorageKey('column-qa', 'one')
  assert.deepEqual(JSON.parse(h.m.values.get(key)).columns, [['browser'], ['mobile'], ['frota', 'historico']])
  const staleMove = h.controller().movePanel
  await h.update({ missionId: 'two' })
  assert.deepEqual(h.controller().preference.panels, [])
  await h.run('openPanel', 'mobile')
  await h.run('openPanel', 'browser')
  await act(() => staleMove('mobile', { panel: 'browser', edge: 'below' }))
  assert.deepEqual(h.controller().preference.columns, [['mobile'], ['browser']])
  await h.update({ missionId: 'one' })
  assert.deepEqual(h.controller().preference.columnWidths, [620, 620, 780])
  await h.update({ projectId: 'other-project' })
  assert.deepEqual(h.controller().preference.panels, [])
  assert.deepEqual(JSON.parse(h.m.values.get(key)).columns, [['browser'], ['mobile'], ['frota', 'historico']])
})

test('rendered Mobile is full-height without a row divider through hide, resize and maximize', async t => {
  const h = await harness(t, { ...mixed(), maximized: null })
  const fullHeight = () => {
    assert.equal(h.panel('mobile').props.style.height, '100%')
    assert.equal(h.panel('mobile').props.style.alignSelf, 'start')
    const separators = h.tree.root.findAll(node => node.props.role === 'separator' && node.props['aria-orientation'] === 'horizontal')
    assert.ok(separators.every(node => !node.props['aria-label'].includes('Mobile')))
  }
  fullHeight()
  await h.update({ available: ['browser', 'frota', 'historico'] })
  assert.equal(h.panel('mobile').props['aria-hidden'], true)
  await h.run('setColumnWidths', [640, 940], [0, 2])
  assert.deepEqual(h.controller().preference.columnWidths, [640, 620, 940])
  await h.update({ available: h.m.availableWorkspacePanels('dev', true) })
  assert.equal(h.panel('mobile').props.style.gridColumn, 2)
  for (const width of [320, 800, 1700]) { await h.resize(width); fullHeight() }
  await h.run('maximizePanel', 'browser')
  assert.equal(h.panel('mobile').props.hidden, true)
  await h.run('restorePanels')
  fullHeight()
  await h.run('maximizePanel', 'mobile')
  fullHeight()
  await h.run('restorePanels')
  await h.update({ visible: false })
  await h.update({ visible: true })
  fullHeight()
  assert.equal(h.mounts.get('mobile'), 1)
  assert.deepEqual(h.unmounts, [])
})

test('keyboard movement shares the Mobile row gate while horizontal movement remains available', async t => {
  const h = await harness(t, { panels: ['browser', 'mobile', 'frota'], columns: [['browser'], ['mobile'], ['frota']] })
  const key = async (id, key) => act(() => h.panel(id).findByProps({ className: 'workspace-panel-head' }).props.onKeyDown({
    key, altKey: true, target: { closest: () => null }, preventDefault() {}, stopPropagation() {}
  }))
  const before = h.controller().preference
  await key('mobile', 'ArrowUp')
  await key('mobile', 'ArrowDown')
  await key('browser', 'ArrowDown')
  assert.deepEqual(h.controller().preference, before)
  await key('mobile', 'ArrowRight')
  assert.deepEqual(h.controller().preference.columns, [['browser'], ['frota'], ['mobile']])
  exclusive(h.controller().preference)
})

test('pointer drops reject rows involving Mobile and explain the dedicated column', async t => {
  const h = await harness(t, { panels: ['browser', 'mobile'], columns: [['browser'], ['mobile']] })
  for (const [id, target] of [['browser', 'mobile'], ['mobile', 'browser']]) {
    const before = h.controller().preference, source = h.box(id), destination = h.box(target)
    const currentTarget = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} }
    const event = { pointerId: 1, isPrimary: true, button: 0, target: { closest: () => null }, currentTarget, preventDefault() {} }
    const head = () => h.panel(id).findByProps({ className: 'workspace-panel-head' })
    await act(() => head().props.onPointerDown({ ...event, clientX: source.left + 30, clientY: 20 }))
    await act(() => head().props.onPointerMove({ ...event, clientX: destination.left + destination.width / 2, clientY: destination.top + destination.height * .75 }))
    const feedback = h.panel(target).find(node => typeof node.props.className === 'string' && node.props.className.startsWith('workspace-drop-target'))
    assert.ok(feedback.props.className.includes('is-full'))
    assert.equal(feedback.children.join(''), 'Mobile ocupa uma coluna exclusiva')
    await act(() => head().props.onPointerUp(event))
    assert.deepEqual(h.controller().preference, before)
  }
})

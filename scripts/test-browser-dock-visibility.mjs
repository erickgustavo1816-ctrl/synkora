import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React, { useLayoutEffect } from 'react'
import { act, create } from 'react-test-renderer'

const compiled = buildSync({ entryPoints: ['src/renderer/src/useBrowserDockVisibility.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { eligibleDockMission, useBrowserDockVisibility, BROWSER_DOCK_CONTEXT_CHANGED } = loaded.exports
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mission = (id, projectId, extra = {}) => ({ id, projectId, status: 'ativa', direct: true, ...extra })
const base = () => ({ appPage: 'workspace', openProjectId: 'p1', universeTabByProject: {},
  missionTabByProject: { p1: 'm1', p2: 'm2' }, missions: [mission('m1', 'p1'), mission('m2', 'p2')] })

test('navigation eligibility is structural: workspace, project, board, selected direct live non-release mission', () => {
  assert.equal(eligibleDockMission(base()), 'm1')
  for (const patch of [
    { appPage: 'settings' }, { openProjectId: null }, { universeTabByProject: { p1: 'map' } },
    { missionTabByProject: { p1: null } }, { missions: [] },
    { missions: [mission('m1', 'other')] }, { missions: [mission('m1', 'p1', { direct: false })] },
    { missions: [mission('m1', 'p1', { status: 'concluida' })] },
    { missions: [mission('m1', 'p1', { status: 'arquivada' })] },
    { missions: [mission('m1', 'p1', { missionType: 'release' })] }
  ]) assert.equal(eligibleDockMission({ ...base(), ...patch }), null, JSON.stringify(patch))
  assert.equal(eligibleDockMission({ ...base(), missions: [mission('m1', 'p1', { status: 'integrando' })] }), 'm1')
  assert.equal(eligibleDockMission({ ...base(), openProjectId: 'p2' }), 'm2')
})

test('real navigation hook publishes after child layout, requests fresh measurement, and revokes on unmount', async () => {
  const target = new EventTarget()
  const log = []
  const host = { setDockMission: id => log.push(['context', id]),
    requestMeasurement: () => target.dispatchEvent(new Event(BROWSER_DOCK_CONTEXT_CHANGED)) }
  function Panel({ id }) {
    useLayoutEffect(() => {
      const measure = () => log.push(['measure', id])
      measure()
      target.addEventListener(BROWSER_DOCK_CONTEXT_CHANGED, measure)
      return () => target.removeEventListener(BROWSER_DOCK_CONTEXT_CHANGED, measure)
    }, [id])
    return null
  }
  function Owner({ state }) {
    const id = eligibleDockMission(state)
    useBrowserDockVisibility(id, host)
    return id ? React.createElement(Panel, { id }) : null
  }
  let tree
  // Opening a project before its mission list arrives must stay revoked.
  await act(() => { tree = create(React.createElement(Owner, { state: { ...base(), missions: [] } })) })
  assert.deepEqual(log, [['context', null]])
  for (const state of [base(), { ...base(), openProjectId: 'p2' }, base()]) {
    log.length = 0
    await act(() => tree.update(React.createElement(Owner, { state })))
    const id = eligibleDockMission(state)
    assert.deepEqual(log.slice(-3), [['measure', id], ['context', id], ['measure', id]])
  }
  // Same context rerender does not erase a valid geometry report.
  log.length = 0
  await act(() => tree.update(React.createElement(Owner, { state: base() })))
  assert.deepEqual(log, [])
  for (const state of [{ ...base(), appPage: 'settings' }, base(), { ...base(), openProjectId: null }, base()]) {
    await act(() => tree.update(React.createElement(Owner, { state })))
    const id = eligibleDockMission(state)
    assert.deepEqual(log.at(-1), id ? ['measure', id] : ['context', null])
  }
  log.length = 0
  await act(() => tree.unmount())
  assert.deepEqual(log, [['context', null]])
  target.dispatchEvent(new Event(BROWSER_DOCK_CONTEXT_CHANGED))
  assert.deepEqual(log, [['context', null]], 'no retained measurement listener after unmount')
})

test('real IPC accepts navigation only from app dock and validates the mission without creating a browser', () => {
  const source = buildSync({ entryPoints: ['src/main/ipc/browser.ts'], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['electron'] }).outputFiles[0].text
  const listeners = new Map()
  const records = []
  const calls = []
  const ipcMain = { on: (name, handler) => listeners.set(name, handler), handle() {} }
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', source)(id => id === 'electron' ? { ipcMain } : require(id), module, module.exports)
  const missions = new Map([['m1', mission('m1', 'p1')], ['release', mission('release', 'p1', { missionType: 'release' })],
    ['closed', mission('closed', 'p1', { status: 'concluida' })]])
  module.exports.registerBrowserIpc({ missions, blackbox: { record: r => records.push(r) } }, {
    browser: { setDockMission: id => calls.push(id) },
    assertBrowserSender: event => {
      if (event.sender.id === 1) return 'dock'
      if (event.sender.id === 2) return 'popout'
      throw new Error('untrusted web page')
    }
  })
  const handler = listeners.get('browser:setDockMission')
  assert.equal(typeof handler, 'function')
  const dock = { sender: { id: 1 } }
  handler(dock, 'm1')
  assert.deepEqual(calls, ['m1'])
  handler({ sender: { id: 2 } }, null)
  handler({ sender: { id: 3 } }, 'm1')
  assert.deepEqual(calls, ['m1'], 'popout and web page cannot revoke or grant app navigation')
  assert.equal(records.length, 1)
  for (const value of [null, undefined, {}, true, '', 'absent', 'release', 'closed']) {
    handler(dock, value)
    assert.equal(calls.at(-1), null)
  }
  assert.equal(missions.size, 3)
})

test('real DockBrowser hides in layout and retired observers cannot publish after mission change or unmount', async () => {
  const source = buildSync({ stdin: { contents: readFileSync(process.env.BROWSER_DOCK_SOURCE ??
    'src/renderer/src/components/DockBrowser.tsx', 'utf8'), loader: 'tsx', resolveDir: resolve('src/renderer/src/components') },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
    external: ['react', 'react/jsx-runtime', '../store'] }).outputFiles[0].text
  const callbacks = []
  const frames = []
  const reports = []
  class Observer {
    constructor(callback) { callbacks.push(callback) }
    observe() {}
    disconnect() {}
  }
  class Element {
    parentElement = null
    children = []
    style = { setProperty() {} }
    getBoundingClientRect() { return { x: 300, y: 120, width: 600, height: 300 } }
    checkVisibility() { return true }
  }
  const document = Object.assign(new EventTarget(), { body: new Element() })
  const window = Object.assign(new EventTarget(), {
    innerWidth: 1200, innerHeight: 900, localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({ overflowX: 'visible', overflowY: 'visible', clipPath: 'none' }),
    setInterval: callback => { callbacks.push(callback); return 1 }, clearInterval() {},
    requestAnimationFrame: callback => { frames.push(callback); return frames.length }, cancelAnimationFrame() {},
    synkora: { browser: { bounds: (...args) => reports.push(args) } }
  })
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', 'window', 'document', 'HTMLElement', 'ResizeObserver', 'MutationObserver', source)(
    id => id === '../store' ? { useStore() { throw new Error('no store access in synthetic DockBrowser') } } : require(id),
    module, module.exports, window, document, Element, Observer, Observer)
  const DockBrowser = module.exports.default
  const state = { alive: true, agentDriving: false, host: 'dock', tabs: [] }
  const layoutReports = []
  function Parent({ visible, missionId }) {
    useLayoutEffect(() => { layoutReports.push(reports.at(-1)) }, [visible, missionId])
    return React.createElement(DockBrowser, { missionId, projectId: 'synthetic-project', state, engine: 'ready', error: null, visible })
  }
  let tree
  await act(() => { tree = create(React.createElement(Parent, { visible: true, missionId: 'm1' }), {
    createNodeMock: () => new Element()
  }) })
  assert.equal(layoutReports.at(-1)?.[2], true, 'first measurement is already committed before the parent layout effect')
  await act(() => tree.update(React.createElement(Parent, { visible: false, missionId: 'm1' })))
  assert.equal(layoutReports.at(-1)[2], false, 'hidden keepalive pane publishes false during layout, before passive effects')
  const retired = [...callbacks]
  await act(() => tree.update(React.createElement(Parent, { visible: true, missionId: 'm2' })))
  const start = reports.length
  await act(() => { for (const callback of retired) callback(); for (const callback of frames) callback() })
  assert.equal(reports.slice(start).some(([id]) => id === 'm1'), false)
  await act(() => tree.unmount())
  assert.deepEqual([reports.at(-1)[0], reports.at(-1)[2]], ['m2', false])
  const end = reports.length
  await act(() => { for (const callback of callbacks) callback(); for (const callback of frames) callback() })
  assert.equal(reports.length, end, 'disconnected callbacks cannot repaint a removed native panel')
})

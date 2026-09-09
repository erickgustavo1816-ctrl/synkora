import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const source = buildSync({ stdin: { contents: `
  export * from './workspace/useWorkspaceActivity'
  export * from './workspace/useWorkspaceLayout'
  export * from './workspace/WorkspacePanelContext'
`, resolveDir: 'src/renderer/src', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['react'] }).outputFiles[0].text
const module = { exports: {} }
const window = { localStorage: { getItem: () => null, setItem() {} } }
new Function('require', 'module', 'exports', 'window', source)(createRequire(import.meta.url), module, module.exports, window)
const { workspaceActivityPanels, useWorkspaceActivity, useWorkspaceLayout, WorkspacePanelContext } = module.exports
const empty = () => ({ browser: { alive: false, agentDriving: false, host: 'dock', tabs: [] }, helpers: [],
  workspace: { ahead: 0, insertions: 0, deletions: 0, files: [] } })
const browse = (url = 'http://127.0.0.1:3000/') => ({ alive: true, agentDriving: false, host: 'dock',
  tabs: [{ tabId: 'tab-1', url, active: true }] })

test('browser opens for new pages or agent use, not title, geometry or repeated state', () => {
  const a = empty(), b = { ...a, browser: browse() }
  assert.deepEqual(workspaceActivityPanels({ ...a, browser: null }, b), [], 'first asynchronous browser snapshot only hydrates the view')
  assert.deepEqual(workspaceActivityPanels(a, b), ['browser'])
  assert.deepEqual(workspaceActivityPanels(b, b), [])
  assert.deepEqual(workspaceActivityPanels(b, { ...b, browser: { ...b.browser, viewportWidth: 768,
    tabs: b.browser.tabs.map(tab => ({ ...tab, title: 'Example', loading: true })) } }), [])
  assert.deepEqual(workspaceActivityPanels(b, { ...b, browser: browse('http://127.0.0.1:3000/about') }), ['browser'])
  const driving = { ...b, browser: { ...b.browser, agentDriving: true } }
  assert.deepEqual(workspaceActivityPanels(b, driving), ['browser'])
  assert.deepEqual(workspaceActivityPanels(driving, driving), [])
  assert.deepEqual(workspaceActivityPanels(a, { ...b, browser: { ...b.browser, host: 'popout' } }), [])
})

test('fleet opens for new and resumed helpers, not each activity update', () => {
  const a = empty(), b = { ...a, helpers: [{ id: 'helper-1', status: 'running' }] }
  assert.deepEqual(workspaceActivityPanels(a, b), ['frota'])
  assert.deepEqual(workspaceActivityPanels(b, b), [])
  const stopped = { ...b, helpers: [{ id: 'helper-1', status: 'interrupted' }] }
  assert.deepEqual(workspaceActivityPanels(b, stopped), [])
  assert.deepEqual(workspaceActivityPanels(stopped, b), ['frota'])
  assert.deepEqual(workspaceActivityPanels(undefined, stopped), [], 'old stopped fleet is not a new activity')
  assert.deepEqual(workspaceActivityPanels(undefined, b), [], 'initial fleet state restores without auto-opening')
})

test('new commits reveal history; working changes reveal work without reopening on every poll', () => {
  const a = empty()
  const edited = { ...a, workspace: { ...a.workspace, insertions: 5, files: [{ path: 'example.ts', status: 'M' }] } }
  assert.deepEqual(workspaceActivityPanels(a, edited), ['trabalho'])
  assert.deepEqual(workspaceActivityPanels(edited, edited), [])
  const committed = { ...edited, workspace: { ...edited.workspace, ahead: 1 } }
  assert.deepEqual(workspaceActivityPanels(edited, committed), ['historico'])
  assert.deepEqual(workspaceActivityPanels(undefined, committed), [], 'initial history is a baseline')
  assert.deepEqual(workspaceActivityPanels(committed, a), [], 'removing commits does not pretend a new commit')
})

test('real controller keeps manual dismissal and sizes across background updates and mission changes', async t => {
  let controller
  function Activity({ id, activity, enabled }) { useWorkspaceActivity(id, activity, enabled); return null }
  function Harness({ id = 'a', activity = empty(), visible = true, enabled = true }) {
    controller = useWorkspaceLayout('synthetic')
    return React.createElement(WorkspacePanelContext.Provider, { value: { controller, visible } },
      React.createElement(Activity, { id, activity, enabled }))
  }
  let tree
  const update = props => act(() => tree.update(React.createElement(Harness, props)))
  await act(() => { tree = create(React.createElement(Harness)) })
  t.after(() => act(() => tree.unmount()))
  const state = { ...empty(), browser: browse() }
  await update({ activity: state })
  assert.deepEqual(controller.preference.panels, ['browser'])
  await act(() => { controller.setColumnWidth(680); controller.closePanel('browser') })
  await update({ activity: structuredClone(state) })
  assert.deepEqual(controller.preference.panels, [], 'repeat state respects the close button')
  const fleet = { ...state, helpers: [{ id: 'helper-1', status: 'running' }] }
  await update({ activity: fleet, visible: false })
  assert.deepEqual(controller.preference.panels, [], 'background mission cannot seize the workspace')
  await update({ id: 'b', activity: empty() })
  assert.deepEqual(controller.preference.panels, [], 'mission B does not consume mission A activity')
  await update({ activity: fleet })
  assert.deepEqual(controller.preference.panels, [], 'returning restores the last arrangement without replaying background activity')
  assert.equal(controller.preference.columnWidths[0], 680)
  const committed = { ...fleet, workspace: { ...fleet.workspace, ahead: 1 } }
  await update({ activity: committed })
  assert.deepEqual(controller.preference.panels, ['historico'])
  await act(() => controller.closeAll())
  await update({ activity: { ...committed, browser: browse('http://127.0.0.1:3000/new') }, enabled: false })
  assert.deepEqual(controller.preference.panels, [], 'closed missions do not auto-open panels')
})

test('an existing browser does not reopen on mount, visibility changes or remount', async t => {
  let controller
  function Activity({ activity }) { useWorkspaceActivity('mission-a', activity, true); return null }
  function Harness({ activity, visible = true, mounted = true }) {
    controller = useWorkspaceLayout('return-qa')
    return React.createElement(WorkspacePanelContext.Provider, { value: { controller, visible } },
      mounted && React.createElement(Activity, { activity }))
  }
  let props = { activity: { ...empty(), browser: browse() } }
  let tree
  await act(() => { tree = create(React.createElement(Harness, props)) })
  t.after(() => act(() => tree.unmount()))
  const update = patch => act(() => { props = { ...props, ...patch }; tree.update(React.createElement(Harness, props)) })
  assert.deepEqual(controller.preference.panels, [], 'hydrating an already running browser is not a new action')
  await update({ activity: { ...props.activity, browser: browse('http://127.0.0.1:3000/new') } })
  assert.deepEqual(controller.preference.panels, ['browser'], 'new activity in the visible mission still opens the panel')
  await act(() => controller.closePanel('browser'))
  await update({ visible: false })
  await update({ activity: { ...props.activity, browser: browse('http://127.0.0.1:3000/background') } })
  await update({ visible: true })
  assert.deepEqual(controller.preference.panels, [], 'background navigation does not override the manual close on return')
  await update({ mounted: false })
  await update({ mounted: true })
  assert.deepEqual(controller.preference.panels, [], 'a remount uses the existing state as a baseline')
})

test('general chat without workspace context has no auto-opening side effect', async () => {
  function General() { useWorkspaceActivity('general', { ...empty(), browser: browse() }, true); return null }
  let tree
  await act(() => { tree = create(React.createElement(General)) })
  await act(() => tree.unmount())
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { validateProgressOpenTarget } from '../src/main/progressNavigation.ts'
import { isGuiMissionPaneId, isGuiPlanningPaneId } from '../src/main/guiMissionContracts.ts'
import { focusProgressDelivery, onProgressOpen, queueProgressOpen, resolveBoardProgressTarget } from '../src/renderer/src/progressNavigation.ts'

const missions = [
  { id: '11111111-live', projectId: 'project-1', status: 'ativa' },
  { id: '22222222-done', projectId: 'project-1', status: 'concluida' },
  { id: '33333333-other', projectId: 'project-2', status: 'ativa' }
]
const panes = [
  ...['dev', 'reviewer', 'helper'].map((role) => ({
    paneId: `gui-${role}-11111111${role === 'helper' ? '-3' : ''}`, projectId: 'project-1'
  })),
  { paneId: 'gui-dev-33333333', projectId: 'project-2' },
  { paneId: 'gui-plan-project-', projectId: 'project-1' }
]
const ctx = {
  projectExists: (id) => ['project-1', 'project-2'].includes(id),
  mission: (id) => missions.find((mission) => mission.id === id),
  missions: (id) => missions.filter((mission) => mission.projectId === id),
  panes: () => panes,
  isMissionPane: isGuiMissionPaneId,
  isPlanningPane: isGuiPlanningPaneId
}
const target = (over = {}) => ({ projectId: 'project-1', missionId: missions[0].id,
  paneId: panes[1].paneId, destination: 'chat', ...over })

test('main accepts only existing runtime panes in the exact project and mission', () => {
  for (const pane of panes.slice(0, 3)) {
    const input = target({ paneId: pane.paneId })
    assert.deepEqual(validateProgressOpenTarget(input, ctx), input)
  }
  for (const input of [
    target({ projectId: 'project-2' }), target({ missionId: missions[2].id }),
    target({ paneId: panes[3].paneId }), target({ paneId: 'gui-helper-11111111-999' }),
    target({ paneId: '../bad' }), target({ destination: 'run-integration' }),
    target({ destination: ['chat'] }),
    target({ destination: 'delivery' }), target({ missionId: undefined }),
    target({ projectId: 'unknown' }), target({ paneId: 'x'.repeat(201) })
  ]) assert.equal(validateProgressOpenTarget(input, ctx), null)
  const collision = { ...missions[0], id: '11111111-collision' }
  assert.equal(validateProgressOpenTarget(target(), { ...ctx, missions: () => [missions[0], collision] }), null)
})

test('done missions normalize to project history and delivery is navigation only', () => {
  assert.deepEqual(validateProgressOpenTarget(target({ missionId: missions[1].id,
    paneId: undefined, destination: 'project' }), ctx), { projectId: 'project-1', destination: 'project' })
  const delivery = { projectId: 'project-1', missionId: missions[0].id, destination: 'delivery' }
  assert.deepEqual(validateProgressOpenTarget(delivery, ctx), delivery)
  const general = { projectId: 'project-1', paneId: panes[4].paneId, destination: 'chat' }
  assert.deepEqual(validateProgressOpenTarget(general, ctx), general)
})

test('Board selects each exact mounted slot and never invents a helper or resurrects history', () => {
  const slots = { [missions[0].id]: panes.slice(0, 3).map((spawn) => ({ spawn })) }
  for (const pane of panes.slice(0, 3)) {
    assert.deepEqual(resolveBoardProgressTarget(target({ paneId: pane.paneId }), missions, slots), {
      missionId: missions[0].id, paneId: pane.paneId, delivery: false, unavailable: false
    })
  }
  assert.deepEqual(resolveBoardProgressTarget(target(), missions, {}), {
    missionId: null, delivery: false, unavailable: true
  })
  assert.equal(resolveBoardProgressTarget(target({ missionId: missions[1].id, paneId: undefined }), missions, slots).missionId, null)
  assert.equal(resolveBoardProgressTarget(target({ missionId: missions[2].id }), missions, slots).missionId, null)
  assert.equal(resolveBoardProgressTarget(target({ paneId: undefined, destination: 'delivery' }), missions, slots).delivery, true)
})

test('navigation queued before Board mounts is consumed once and stays project-scoped', () => {
  const seen = []
  queueProgressOpen(target())
  const offOther = onProgressOpen('project-2', (value) => seen.push(value))
  assert.equal(seen.length, 0)
  const off = onProgressOpen('project-1', (value) => seen.push(value))
  assert.deepEqual(seen, [target()])
  off()
  const offAgain = onProgressOpen('project-1', (value) => seen.push(value))
  assert.equal(seen.length, 1)
  queueProgressOpen(target({ paneId: panes[0].paneId }))
  assert.equal(seen[1].paneId, panes[0].paneId)
  offAgain(); offOther()
})

test('delivery focus expands only disclosure controls after React removes inert', () => {
  const calls = []
  let frame
  globalThis.requestAnimationFrame = (callback) => { frame = callback; return 1 }
  globalThis.cancelAnimationFrame = (id) => calls.push(['cancel', id])
  const section = { getAttribute: () => 'false', click: () => calls.push('section'),
    focus: () => calls.push('focus'), scrollIntoView: () => calls.push('scroll') }
  const rail = { querySelector: (selector) => selector === '.dock-sec-head' ? section :
    (assert.equal(selector, '.right-rail-toggle[aria-expanded="false"]'), { click: () => calls.push('rail') }) }
  const cancel = focusProgressDelivery({ querySelector: selector => selector === '.board-content' ? rail : null }, () => calls.push('done'))
  assert.deepEqual(calls, ['rail'])
  frame()
  assert.deepEqual(calls, ['rail', 'section', 'focus', 'scroll', 'done'])
  cancel()
  delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame
})

// Real IPC registration, with Electron replaced by a synthetic sender/handler map.
// Set PROGRESS_TEST_OLD_IPC=1 to prove the same assertions reject the old behavior.
const ipcSource = process.env.PROGRESS_TEST_OLD_IPC === '1'
  ? execFileSync('git', ['show', 'HEAD:src/main/ipc/progress.ts'], { encoding: 'utf8' })
  : readFileSync(new URL('../src/main/ipc/progress.ts', import.meta.url), 'utf8')
const compiled = buildSync({ stdin: { contents: ipcSource, resolveDir: fileURLToPath(new URL('../src/main/ipc/', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] })

test('restricted overlay IPC rejects foreign panes and forwards the exact valid destination', () => {
  const handlers = new Map(), forwarded = []
  let shown = 0
  const loaded = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
    (name) => name === 'electron' ? { ipcMain: { on: (name, fn) => handlers.set(name, fn), handle() {} } } : require(name), loaded, loaded.exports)
  loaded.exports.registerProgressIpc({ projects: { get: (id) => ctx.projectExists(id) ? { id } : undefined },
    missions: { get: ctx.mission, list: ctx.missions } }, {
    assertProgressOverlaySender: (event) => { if (!event.trusted) throw Error('foreign sender') },
    progressPanes: ctx.panes, showMainWindow: () => shown++,
    deliverProgressOpenTarget: (value) => forwarded.push(value), state: {}
  })
  const command = (value, trusted = true) => handlers.get('progress:overlay-command')({ trusted }, { command: 'open-target', ...value })
  command(target(), false)
  command(target({ paneId: panes[3].paneId }))
  command(target({ missionId: missions[2].id }))
  command(target({ paneId: 'gui-helper-11111111-999' }))
  assert.equal(shown, 0)
  assert.deepEqual(forwarded, [])
  command(target())
  assert.deepEqual(forwarded, [target()])
  assert.equal(shown, 1)
  command({ projectId: 'project-1', missionId: missions[1].id, destination: 'project' })
  assert.deepEqual(forwarded[1], { projectId: 'project-1', destination: 'project' })
})

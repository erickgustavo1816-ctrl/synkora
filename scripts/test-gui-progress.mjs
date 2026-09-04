import assert from 'node:assert/strict'
import test from 'node:test'
import { GuiProgressTracker } from '../src/main/guiProgress.ts'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/guiSessions.js'
import { GuiHelperEngine } from '../.tmp/gui-sessions-test/guiHelperSessions.js'

const identity = { paneId: 'gui-dev-mission1', projectId: 'project1' }
const AT = '2026-09-04T12:00:00.000Z'
function tracker() { const value = new GuiProgressTracker(); value.open(identity); return value }
const first = (value) => value.snapshot()[0]
const emit = (value, event) => value.observe(identity.paneId, event, AT)

test('initial open and ready are honest, terminal ignores late init/ready/delta', () => {
  const value = tracker()
  assert.equal(first(value).state, 'starting')
  emit(value, { type: 'ready', caps: {} })
  assert.equal(first(value).state, 'idle')
  emit(value, { type: 'turn-started' })
  assert.equal(first(value).state, 'working')
  emit(value, { type: 'result', isError: false })
  for (const event of [{ type: 'init' }, { type: 'ready' }, { type: 'delta', text: 'synthetic' }, { type: 'session-restarted', ready: true }]) emit(value, event)
  assert.equal(first(value).state, 'turn_finished')
  emit(value, { type: 'turn-started' })
  assert.equal(first(value).state, 'working')
})
test('blocking permission/question/review waits; matching resolution resumes previous work', () => {
  for (const type of ['permission', 'question', 'plan-review']) {
    const value = tracker()
    emit(value, { type: 'turn-started' })
    emit(value, { type, requestId: 'request1' })
    assert.equal(first(value).state, 'waiting_user')
    emit(value, { type: 'interaction-resolved', requestId: 'unrelated' })
    assert.equal(first(value).pendingCount, 1)
    emit(value, { type: 'permission-cancel', requestId: 'request1' })
    assert.equal(first(value).state, 'working')
    assert.equal(first(value).pendingCount, 0)
  }
})
test('optional question and proposal coexist with work; terminal clears only turn pending', () => {
  const value = tracker()
  emit(value, { type: 'turn-started' })
  emit(value, { type: 'question', requestId: 'optional', blocking: false })
  emit(value, { type: 'plan-proposal', requestId: 'proposal' })
  assert.equal(first(value).state, 'working')
  assert.equal(first(value).pendingCount, 2)
  emit(value, { type: 'result', isError: false })
  assert.equal(first(value).state, 'turn_finished')
  assert.equal(first(value).pendingCount, 1)
  assert.equal(first(value).pendingKind, 'plan-proposal')
  emit(value, { type: 'interaction-resolved', requestId: 'proposal' })
  assert.equal(first(value).pendingCount, 0)
})
test('continuation remains working after normalized result and ends only on continuation end', () => {
  const value = tracker()
  emit(value, { type: 'turn-started' })
  emit(value, { type: 'result', isError: false, continues: true })
  assert.equal(first(value).state, 'working')
  emit(value, { type: 'turn-continuation', continues: false })
  assert.equal(first(value).state, 'turn_finished')
})
test('failed result remains attention after helper continuation; slash completion cannot leave false work', () => {
  const value = tracker()
  emit(value, { type: 'turn-started' })
  emit(value, { type: 'result', isError: true, continues: true })
  assert.equal(first(value).state, 'error')
  emit(value, { type: 'turn-continuation', continues: false })
  assert.equal(first(value).state, 'error')
  emit(value, { type: 'turn-started' })
  emit(value, { type: 'question', requestId: 'optional', blocking: false })
  emit(value, { type: 'command-completed', isError: false, continues: true })
  assert.equal(first(value).state, 'working')
  assert.equal(first(value).pendingCount, 1)
  emit(value, { type: 'command-completed', isError: false, continues: false })
  assert.equal(first(value).state, 'turn_finished')
})
test('interrupted beats error; closed cannot overwrite terminal; fatal clears blocking', () => {
  const value = tracker()
  emit(value, { type: 'turn-started' })
  emit(value, { type: 'permission', requestId: 'pending' })
  emit(value, { type: 'result', isError: true, interrupted: true, continues: true })
  emit(value, { type: 'closed', code: 1 })
  assert.equal(first(value).state, 'interrupted')
  assert.equal(first(value).pendingCount, 0)
  emit(value, { type: 'turn-started' })
  emit(value, { type: 'question', requestId: 'q' })
  emit(value, { type: 'fatal', text: 'synthetic failure' })
  assert.equal(first(value).state, 'error')
  assert.equal(first(value).pendingCount, 0)
})
test('reopen seeds only unresolved persistent proposal and never old activity', () => {
  const value = tracker()
  value.open(identity, [
    { type: 'turn-started' }, { type: 'question', requestId: 'q' },
    { type: 'plan-proposal', requestId: 'resolved' }, { type: 'interaction-resolved', requestId: 'resolved' },
    { type: 'plan-proposal', requestId: 'open' }, { type: 'result', isError: false }
  ])
  assert.equal(first(value).state, 'starting')
  assert.equal(first(value).activityAt, undefined)
  assert.equal(first(value).pendingCount, 1)
  value.forget(identity.paneId)
  assert.deepEqual(value.snapshot(), [])
})
test('projection never copies event content or accepts mutation of returned state', () => {
  const value = tracker()
  emit(value, { type: 'tool', name: 'secret', input: { path: 'SYNTHETIC_PRIVATE' } })
  emit(value, { type: 'question', requestId: 'q', questions: [{ text: 'SYNTHETIC_PRIVATE' }], blocking: false })
  const snapshot = value.snapshot()
  snapshot[0].state = 'error'
  assert.equal(first(value).state, 'working')
  assert.equal(JSON.stringify(value.snapshot()).includes('SYNTHETIC_PRIVATE'), false)
})

function registry() {
  const events = []; let notifications = 0; const sinks = []
  const gui = new GuiSessionRegistry({ push: (event) => events.push(event), systemPromptFile: () => undefined, onProgressChange: () => { notifications += 1 } })
  gui.spawnSession = (_spawn, sink) => {
    sinks.push(sink)
    return { alive: true, turnActive: false, kill: () => undefined }
  }
  const spawn = { ...identity, cli: 'claude', cwd: 'C:/synthetic', configDir: 'C:/synthetic-config' }
  gui.create(spawn)
  return { gui, spawn, sinks, events, notifications: () => notifications }
}
test('actual registry captures post-correlator results and continuation, independent of turnActive', () => {
  const value = registry()
  value.gui.helperCards.observe = (_pane, event) => event.type === 'result' ? { ...event, continues: true } : event
  value.sinks[0]({ type: 'turn-started' })
  value.sinks[0]({ type: 'question', requestId: 'optional', blocking: false, questions: [] })
  assert.equal(value.gui.progress()[0].pendingCount, 1)
  value.sinks[0]({ type: 'result', isError: false })
  assert.equal(value.gui.progress()[0].state, 'working')
  assert.equal(value.gui.progress()[0].pendingCount, 0)
  assert.equal(value.gui.panes.get(identity.paneId).ring.pending('optional'), undefined,
    'tracker matches guiTerminalEvent: result clears even when continues is true')
  value.sinks[0]({ type: 'turn-continuation', continues: false })
  assert.equal(value.gui.progress()[0].state, 'turn_finished')
  assert.ok(value.notifications() >= 3)
  value.gui.kill(identity.paneId)
  assert.deepEqual(value.gui.progress(), [])
})
test('actual registry respawn clears work and ignores old sink; synchronous fatal survives restart marker', () => {
  const value = registry()
  value.sinks[0]({ type: 'turn-started' })
  value.gui.create({ ...value.spawn, permissionMode: 'plan' })
  assert.equal(value.gui.progress()[0].state, 'starting')
  value.sinks[0]({ type: 'turn-started' })
  assert.equal(value.gui.progress()[0].state, 'starting')
  value.gui.spawnSession = (_spawn, sink) => { sink({ type: 'fatal', text: 'synthetic' }); return { alive: false, kill: () => undefined } }
  value.gui.create({ ...value.spawn, permissionMode: 'default' })
  assert.equal(value.gui.progress()[0].state, 'error')
  value.gui.kill(identity.paneId)
})
test('actual registry asks only pure helper counts and notifies even without synthesized GUI event', () => {
  const value = registry()
  let snapshots = 0
  value.gui.attachHelpers({ status: () => { snapshots += 1; throw new Error('must not read full snapshots') }, interruptPane: () => 0, progressCounts: () => ({ running: 2, interrupted: 1, failed: 1 }) })
  assert.deepEqual(value.gui.progress()[0].helpers, { running: 2, interrupted: 1, failed: 1 })
  assert.equal(snapshots, 0)
  value.gui.helperCards.change = () => undefined
  const before = value.notifications()
  value.gui.noteHelperChange({ kind: 'activity', record: {} })
  assert.equal(value.notifications(), before + 1)
  value.gui.kill(identity.paneId)
})
test('helper engine projection never sweeps, reads delivery files, or includes account/content', () => {
  const engine = Object.create(GuiHelperEngine.prototype)
  engine.byPane = new Map([[identity.paneId, ['a', 'b', 'c', 'd', 'e', 'f']]])
  engine.helpers = new Map(['spawning', 'working', 'interrupted', 'failed', 'done', 'cancelled'].map((state, index) => [String.fromCharCode(97 + index), { record: { state, seatId: 'SYNTHETIC_PRIVATE', resultPath: 'SYNTHETIC_PRIVATE' } }]))
  engine.sweep = () => { throw new Error('must not sweep') }
  assert.deepEqual(engine.progressCounts(identity.paneId), { running: 2, interrupted: 1, failed: 1 })
  assert.deepEqual(engine.progressCounts('unknown'), { running: 0, interrupted: 0, failed: 0 })
})

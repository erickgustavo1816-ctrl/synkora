import assert from 'node:assert/strict'
import test from 'node:test'
import { applyProgressCoordinatorActivity, buildProgressSnapshot } from '../src/main/progressSnapshot.ts'

const NOW = '2026-09-04T12:00:00.000Z'
const project = (id = 'project1') => ({ id, name: id, path: 'C:/synthetic', createdAt: NOW })
const mission = (over = {}) => ({ id: 'mission1', projectId: 'project1', title: 'Synthetic mission', status: 'ativa', direct: true, createdAt: NOW, updatedAt: NOW, ...over })
const session = (over = {}) => ({ paneId: 'gui-dev-mission1', projectId: 'project1', state: 'working', pendingCount: 0, activityAt: NOW, ...over })
const ticket = (over = {}) => ({ id: 'ticket1', projectId: 'project1', missionId: 'mission1', state: 'queued', position: 1, total: 2, isHead: true, attempts: 0, requestedBy: 'user', targetKind: 'base', createdAt: NOW, ...over })
const build = (over = {}) => buildProgressSnapshot({ projects: [project()], missions: [mission()], integrationQueue: [], now: NOW, ...over })
const first = (snapshot) => snapshot.projects[0].activeMissions.find((row) => row.kind !== 'general')

test('active mission without GUI runtime is idle, never implementing', () => {
  const snapshot = build()
  assert.equal(first(snapshot).state, 'idle')
  assert.equal(first(snapshot).group, 'idle')
  assert.equal(snapshot.totals.workingMissions, 0)
})
test('F6 activity, notes and questions cannot invent execution or leak text', () => {
  const forbidden = 'SYNTHETIC_PRIVATE_CONTENT'
  const snapshot = build({ coordinatorActivity: [{ projectId: 'project1', role: 'maestro', working: true, updatedAt: NOW, note: forbidden }], paneNotes: [{ projectId: 'project1', missionId: 'mission1', role: 'dev', text: forbidden, at: NOW }], pendingQuestions: [{ projectId: 'project1', missionKey: 'mission1', question: forbidden, at: NOW }] })
  assert.equal(first(snapshot).group, 'idle')
  assert.equal(snapshot.totals.activeCoordinators, 0)
  assert.equal(JSON.stringify(snapshot).includes(forbidden), false)
  const pulsed = applyProgressCoordinatorActivity(snapshot, [{ projectId: 'project1', role: 'maestro', working: true, updatedAt: NOW }], 2, NOW)
  assert.equal(pulsed.projects[0].group, 'idle')
})
test('working, finished, interrupted and error are separate from mission completion', () => {
  for (const [state, group] of [['working', 'working'], ['turn_finished', 'idle'], ['interrupted', 'attention'], ['error', 'attention'], ['idle', 'idle'], ['starting', 'idle']]) {
    const snapshot = build({ guiSessions: [session({ state })] })
    assert.equal(first(snapshot).state, state)
    assert.equal(first(snapshot).group, group)
    assert.equal(snapshot.totals.recentCompletions, 0)
    if (state === 'turn_finished') assert.equal(snapshot.totals.deliveryMissions, 0)
  }
})
test('attention in any pane wins working and delivery; optional questions still count work', () => {
  const snapshot = build({ integrationQueue: [ticket({ state: 'merging' })], guiSessions: [session(), session({ paneId: 'gui-reviewer-mission1', pendingCount: 1, pendingKind: 'question' })] })
  const row = first(snapshot)
  assert.equal(row.group, 'attention')
  assert.equal(row.paneId, 'gui-reviewer-mission1')
  assert.equal(row.workingSessions, 2)
  assert.equal(row.sessionCount, 2)
  assert.equal(row.queue.state, 'merging')
  assert.equal(snapshot.totals.attentionMissions, 1)
  assert.equal(snapshot.totals.workingMissions, 0)
})
test('queue states are authoritative and sync-required does not claim syncing', () => {
  for (const [state, group] of [['queued', 'delivery'], ['sync_required', 'attention'], ['merging', 'delivery'], ['blocked', 'attention']]) {
    const row = first(build({ guiSessions: [session()], integrationQueue: [ticket({ state })] }))
    assert.equal(row.group, group)
    assert.equal(row.queue.state, state)
    if (state === 'sync_required') { assert.equal(row.state, 'sync_required'); assert.match(row.label, /precisa sincronizar/) }
  }
  assert.equal(first(build({ missions: [mission({ pendingIntegrationApproval: true })] })).state, 'ready_to_integrate')
})
test('completed and archived domain missions override live GUI and preserve recent cutoff', () => {
  const snapshot = build({ missions: [mission({ status: 'concluida' }), mission({ id: 'archived', status: 'arquivada' }), mission({ id: 'old', status: 'concluida', completedAt: '2020-01-01T00:00:00.000Z' })], guiSessions: [session({ pendingCount: 1, pendingKind: 'permission' })] })
  assert.equal(snapshot.totals.activeMissions, 0)
  assert.equal(snapshot.totals.recentCompletions, 1)
  assert.equal(snapshot.projects[0].recentCompletions[0].state, 'completed')
})
test('project binding rejects cross-project tickets, panes, malformed and ambiguous IDs', () => {
  assert.equal(first(build({ guiSessions: [session({ projectId: 'other' })], integrationQueue: [ticket({ projectId: 'other' })] })).group, 'idle')
  assert.equal(first(build({ guiSessions: [session({ paneId: 'gui-dev-mission1-extra' })] })).group, 'idle')
  const ambiguous = build({ missions: [mission({ id: 'mission1-a' }), mission({ id: 'mission1-b' })], guiSessions: [session()] })
  assert.ok(ambiguous.projects[0].activeMissions.every((row) => row.sessionCount === 0))
})
test('general planning is explicit and excluded from mission totals', () => {
  const snapshot = build({ missions: [], guiSessions: [session({ paneId: 'gui-plan-project1' })] })
  assert.equal(snapshot.projects[0].activeMissions[0].kind, 'general')
  assert.equal(snapshot.projects[0].group, 'working')
  assert.equal(snapshot.totals.activeMissions, 0)
  assert.equal(snapshot.totals.workingMissions, 0)
})
test('group totals partition missions and helper counts use structural fields only', () => {
  const snapshot = build({ missions: [mission(), mission({ id: 'mission2' }), mission({ id: 'mission3' }), mission({ id: 'mission4' })], integrationQueue: [ticket({ missionId: 'mission2' })], guiSessions: [session({ helpers: { running: 2, interrupted: 1, failed: 0 }, text: 'SYNTHETIC_PRIVATE_CONTENT' }), session({ paneId: 'gui-dev-mission2', state: 'turn_finished' }), session({ paneId: 'gui-dev-mission3', state: 'waiting_user', pendingCount: 1, pendingKind: 'permission' })] })
  assert.deepEqual([snapshot.totals.attentionMissions, snapshot.totals.workingMissions, snapshot.totals.deliveryMissions, snapshot.totals.idleMissions], [1, 1, 1, 1])
  assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC_PRIVATE_CONTENT'), false)
  assert.deepEqual(snapshot.projects[0].activeMissions.find((row) => row.id === 'mission1').helpers, { running: 2, interrupted: 1, failed: 0 })
})
test('missing project produces project attention even when missions are idle', () => {
  const snapshot = build({ missingProjectIds: ['project1'] })
  assert.equal(snapshot.projects[0].group, 'attention')
  assert.equal(snapshot.totals.attentionProjects, 1)
})

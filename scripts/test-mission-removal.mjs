import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { build, buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mainCode = buildSync({
  stdin: { contents: "export { buildMissionLifecycle } from './src/main/missionLifecycle'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text
const main = { exports: {} }
new Function('require', 'module', 'exports', mainCode)(require, main, main.exports)

const uiCode = (await build({
  stdin: { contents: "export { MissionsPane } from './src/renderer/src/components/BacklogView'; export { useStore } from './src/renderer/src/store'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'zustand'], loader: { '.css': 'empty' },
  plugins: [{ name: 'mission-pane-test-export', setup(build) {
    build.onLoad({ filter: /BacklogView\.tsx$/ }, ({ path }) => ({
      contents: readFileSync(path, 'utf8') + '\nexport { MissionsPane }', loader: 'tsx'
    }))
  } }]
})).outputFiles[0].text

function lifecycleFixture(t) {
  const workspace = resolve('.tmp')
  mkdirSync(workspace, { recursive: true })
  const root = mkdtempSync(join(workspace, 'mission-removal-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(workspace + sep))
    rmSync(root, { recursive: true, force: true })
  })
  const project = join(root, 'project'), source = join(root, 'source')
  mkdirSync(project)
  const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(project, ['init', '-b', 'main'])
  writeFileSync(join(project, 'example.txt'), 'committed\n')
  git(project, ['add', 'example.txt'])
  git(project, ['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'test fixture'])
  git(project, ['worktree', 'add', '-b', 'mission/synthetic', source])
  let mission = { id: 'synthetic', projectId: 'project', title: 'Missão sintética', status: 'arquivada',
    updatedAt: '2026-09-29T00:00:00.000Z', branch: 'mission/synthetic', worktree: source }
  let cleanup = async () => {}
  const effects = [], tickets = new Map()
  const ctx = {
    projects: { get: () => ({ path: project }) }, missions: { get: () => mission, remove: () => { mission = undefined; effects.push('removed') } },
    backlog: { releaseMissionItems: () => effects.push('backlog') }, maestro: { forget() {} },
    integrationQueue: { getByMission: id => tickets.get(id), cancel: id => tickets.delete(id) },
    ptys: { kill() {} }, blackbox: { record() {} }, hub: { publish() {}, purgeMissionEvents() {} },
    syncBoard() {}, orchPaneId: () => 'synthetic-pane', unregisterPane() {}, pushAll() {}
  }
  const lifecycle = main.exports.buildMissionLifecycle(ctx, {
    engine: { emitMissionsChanged() {}, scheduleIntegrationDrain() {}, stopMissionExecution() {} },
    orchKey: () => 'synthetic-key', emitBacklogChanged() {}, guiSessions: { forgetWhere() {} },
    killMissionGuiPanes: async () => cleanup()
  })
  return { lifecycle, project, source, effects, tickets, git, mission: () => mission,
    cleanup: fn => { cleanup = fn } }
}

test('local changes produce an actionable refusal without removing the mission or its files', async t => {
  const h = lifecycleFixture(t)
  writeFileSync(join(h.source, 'example.txt'), 'local edits\n')
  const result = await h.lifecycle.remove('synthetic')
  assert.equal(result.ok, false)
  assert.match(result.error, /alterações locais/iu)
  assert.match(result.error, /reative/iu)
  assert.equal(readFileSync(join(h.source, 'example.txt'), 'utf8'), 'local edits\n')
  assert.ok(h.mission())
  assert.deepEqual(h.effects, [])
})

test('a verified clean worktree produces a success receipt and completes canonical cleanup', async t => {
  const h = lifecycleFixture(t)
  assert.deepEqual(await h.lifecycle.remove('synthetic'), { ok: true })
  assert.equal(h.mission(), undefined)
  assert.equal(existsSync(h.source), false)
  assert.ok(h.effects.includes('backlog'))
})

test('pending integration gives a recovery action and preserves the ticket', async t => {
  const h = lifecycleFixture(t)
  h.tickets.set('synthetic', { state: 'blocked', block: { owner: 'orchestrator', code: 'target_repair_pending' } })
  const result = await h.lifecycle.remove('synthetic')
  assert.equal(result.ok, false)
  assert.match(result.error, /integração.*chat/iu)
  assert.ok(h.tickets.has('synthetic'))
  assert.deepEqual(h.effects, [])
})

test('an unexpected branch is refused with an isolation reason, preserving the worktree', async t => {
  const h = lifecycleFixture(t)
  h.mission().branch = 'mission/another'
  const result = await h.lifecycle.remove('synthetic')
  assert.equal(result.ok, false)
  assert.match(result.error, /pasta.*missão/iu)
  assert.ok(existsSync(h.source))
  assert.deepEqual(h.effects, [])
})

test('state changes while stopping sessions are refused with a retry action', async t => {
  const h = lifecycleFixture(t)
  h.cleanup(async () => { h.mission().updatedAt = '2026-09-29T01:00:00.000Z' })
  const result = await h.lifecycle.remove('synthetic')
  assert.equal(result.ok, false)
  assert.match(result.error, /mudou.*reabra/iu)
  assert.ok(existsSync(h.source))
  assert.deepEqual(h.effects, [])
})

async function uiFixture(t, remove) {
  const loaded = { exports: {} }, calls = []
  const mission = { id: 'synthetic', projectId: 'project', title: 'Missão sintética', status: 'arquivada',
    branch: 'mission/synthetic', direct: true, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' }
  const window = { synkora: { missions: {
    remove: async id => { calls.push(['remove', id]); return remove() },
    list: async id => { calls.push(['list', id]); return [mission] }
  } } }
  const document = { body: {}, documentElement: { style: { setProperty() {} } } }
  const uiRequire = name => name === 'react-dom' ? { createPortal: children => children } : require(name)
  new Function('require', 'module', 'exports', 'window', 'document', 'localStorage', uiCode)(
    uiRequire, loaded, loaded.exports, window, document, { getItem: () => null }
  )
  const { MissionsPane, useStore } = loaded.exports
  useStore.setState({ missions: [mission], openProjectId: 'project', missionTabByProject: { project: 'current' } })
  let tree
  await act(async () => { tree = create(React.createElement(MissionsPane, { projectId: 'project', versions: [] })) })
  t.after(async () => { await act(async () => tree.unmount()) })
  const find = className => tree.root.findAll(node => node.props.className === className)
  const click = async node => { await act(async () => node.props.onClick()) }
  await click(find('btn ghost tiny danger')[0])
  return { tree, useStore, calls, find, click }
}

test('refused deletion leaves confirmation open, explains the reason and preserves the selected tab', async t => {
  const error = 'A pasta contém alterações locais. Reative a missão e salve as alterações antes de excluir.'
  const h = await uiFixture(t, () => ({ ok: false, error }))
  await h.click(h.find('btn danger-solid')[0])
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.ok(h.tree.root.findAll(node => node.props.role === 'alert').some(node => node.children.includes(error)))
  assert.equal(h.useStore.getState().missionTabByProject.project, 'current')
  assert.deepEqual(h.calls, [['remove', 'synthetic']])
})

test('pending deletion stays visible and disables submission until success is confirmed', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const h = await uiFixture(t, () => pending)
  await h.click(h.find('btn danger-solid')[0])
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.equal(h.find('btn danger-solid')[0].props.disabled, true)
  assert.equal(h.useStore.getState().missionTabByProject.project, 'current')
  await act(async () => { finish({ ok: true }); await pending })
  assert.equal(h.find('task-modal confirm-modal').length, 0)
  assert.equal(h.useStore.getState().missionTabByProject.project, null)
  assert.deepEqual(h.calls, [['remove', 'synthetic'], ['list', 'project']])
})

test('an IPC exception becomes a recoverable message instead of an unhandled rejection', async t => {
  const h = await uiFixture(t, () => { throw new Error('synthetic private transport details') })
  await h.click(h.find('btn danger-solid')[0])
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  const alerts = h.tree.root.findAll(node => node.props.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.match(alerts[0].children.join(''), /tente novamente/iu)
  assert.doesNotMatch(alerts[0].children.join(''), /private transport/iu)
})

test('a second click while pending cannot repeat deletion or close confirmation', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const h = await uiFixture(t, () => pending)
  const submit = h.find('btn danger-solid')[0]
  await act(async () => { submit.props.onClick(); submit.props.onClick() })
  await h.click(h.find('overlay')[0])
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.deepEqual(h.calls, [['remove', 'synthetic']])
  await act(async () => { finish({ ok: false, error: 'Aguarde e tente novamente.' }); await pending })
  assert.equal(h.find('btn danger-solid')[0].props.disabled, false)
})

test('a failed attempt can be retried and confirmation closes only on success', async t => {
  let attempts = 0
  const h = await uiFixture(t, () => ++attempts === 1 ? { ok: false, error: 'Reative a missão e confira as alterações.' } : { ok: true })
  await h.click(h.find('btn danger-solid')[0])
  assert.equal(h.tree.root.findAll(node => node.props.role === 'alert').length, 1)
  await h.click(h.find('btn danger-solid')[0])
  assert.equal(h.find('task-modal confirm-modal').length, 0)
  assert.equal(attempts, 2)
})

test('unexpected cleanup errors produce a sanitized receipt and allow another attempt', async t => {
  const h = lifecycleFixture(t)
  h.cleanup(async () => { throw new Error('synthetic private process details') })
  const result = await h.lifecycle.remove('synthetic')
  assert.equal(result.ok, false)
  assert.match(result.error, /tente novamente/iu)
  assert.doesNotMatch(result.error, /private process/iu)
  assert.ok(h.mission())
  h.cleanup(async () => {})
  assert.deepEqual(await h.lifecycle.remove('synthetic'), { ok: true })
})

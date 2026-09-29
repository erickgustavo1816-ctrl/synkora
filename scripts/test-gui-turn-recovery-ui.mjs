import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const browser = { setTimeout, synkora: { gui: {} } }
const output = buildSync({ stdin: { contents: `
  export { default as GuiErrorLine } from './src/renderer/src/components/GuiErrorLine';
  export { EMPTY_GUI_PANE, applyGuiEvent, useStore } from './src/renderer/src/store';
  export { guiApi, asGuiEvent } from './src/renderer/src/guiApi';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node',
  format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'zustand'] })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'window', 'document', output.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports, browser,
  { documentElement: { style: { setProperty() {} } } }
)
const { GuiErrorLine, EMPTY_GUI_PANE, applyGuiEvent, useStore, guiApi, asGuiEvent } = loaded.exports
const paneId = 'synthetic-codex-pane'
const token = 'synthetic-recovery-token'
const failed = { type: 'result', isError: true, outcome: 'failed', turnId: 'failed-turn',
  recoveryToken: token, errorText: 'Selected model is at capacity. Please try a different model.' }
const reduce = events => events.reduce(applyGuiEvent, { ...EMPTY_GUI_PANE, status: 'idle', ready: true })

test('a confirmed failed turn retains one error and its server recovery receipt', () => {
  const state = reduce([{ type: 'turn-started' }, failed])
  assert.equal(state.recoveryToken, token)
  assert.equal(state.status, 'idle')
  assert.equal(state.items.filter(item => item.kind === 'error').length, 1)
  assert.equal(state.items.find(item => item.kind === 'error').recoveryToken, token)
})

test('retry progress is neutral and disappears on success without changing completed tools', () => {
  const state = reduce([
    { type: 'turn-started' },
    { type: 'tool', name: 'Bash', input: {}, toolUseId: 'done' },
    { type: 'tool-result', toolUseId: 'done', text: 'synthetic receipt', isError: false, outcome: 'completed' },
    { type: 'turn-retry', turnId: 'retry-turn', text: 'O serviço está tentando novamente.' },
    { type: 'turn-retry', turnId: 'retry-turn', text: 'O serviço está tentando novamente.' }
  ])
  assert.equal(state.status, 'working')
  assert.equal(state.items.filter(item => item.retryTurnId === 'retry-turn').length, 1)
  assert.equal(state.items.some(item => item.kind === 'error'), false)
  const finished = applyGuiEvent(state, { type: 'result', turnId: 'retry-turn', isError: false })
  assert.equal(finished.items.some(item => item.retryTurnId), false)
  assert.equal(finished.items.find(item => item.kind === 'tool').result.status, 'completed')
})

test('new work, executor change and disconnected sessions clear recovery authority', () => {
  for (const event of [
    { type: 'turn-started' }, { type: 'executor-changed', model: 'same-model', effort: 'high' },
    { type: 'fatal', text: 'synthetic disconnect' }, { type: 'closed', code: 1 },
    { type: 'session-restarted', ready: true, resumed: true }, { type: 'conversation-cleared' }
  ]) assert.equal(applyGuiEvent(reduce([failed]), event).recoveryToken, null, event.type)
})

test('a stopped or disconnected conversation no longer claims that the service is retrying', () => {
  for (const event of [
    { type: 'fatal', text: 'synthetic disconnect' }, { type: 'closed', code: 1 },
    { type: 'session-restarted', ready: true, resumed: true }, { type: 'conversation-cleared' },
    { type: 'turn-started' }
  ]) {
    const state = reduce([{ type: 'turn-retry', turnId: 'retry-turn', text: 'Retry em andamento.' }])
    assert.equal(applyGuiEvent(state, event).items.some(item => item.retryTurnId), false, event.type)
  }
})

test('replay accepts bounded retry metadata and rejects malformed recovery tokens', () => {
  assert.equal(asGuiEvent({ type: 'turn-retry', turnId: 't', text: 'retry' }).type, 'turn-retry')
  assert.equal(asGuiEvent({ type: 'turn-retry', turnId: {}, text: 'retry' }), null)
  assert.equal(asGuiEvent({ ...failed, recoveryToken: {} }), null)
})

async function mount(status = 'idle') {
  useStore.setState({ guiPanes: { [paneId]: { ...reduce([failed]), status } } })
  let tree
  await act(async () => { tree = create(React.createElement(GuiErrorLine,
    { text: failed.errorText, paneId, recoveryToken: token })) })
  return tree
}

test('recovery action sends one opaque receipt, preserves the model and blocks double submission', async () => {
  let resolve, calls = []
  browser.synkora.gui.resumeFailedTurn = (...args) => {
    calls.push(args)
    return new Promise(done => { resolve = done })
  }
  const tree = await mount()
  try {
    const button = tree.root.findByType('button')
    assert.match(button.children.join(''), /Retomar conversa/u)
    await act(async () => { button.props.onClick(); button.props.onClick() })
    assert.deepEqual(calls, [[paneId, token]])
    assert.equal(tree.root.findByType('button').props.disabled, true)
    await act(async () => { resolve({ ok: true }) })
    assert.equal(tree.root.findAllByType('button').length, 0)
    assert.equal(useStore.getState().guiPanes[paneId].items.some(item => item.kind === 'user'), false)
  } finally { await act(async () => tree.unmount()) }
})

test('server refusal remains visible and permits an explicit retry of the same receipt', async () => {
  browser.synkora.gui.resumeFailedTurn = async () => ({ ok: false, error: 'A conversa ainda está trabalhando.' })
  const tree = await mount()
  try {
    await act(async () => tree.root.findByType('button').props.onClick())
    assert.match(JSON.stringify(tree.toJSON()), /A conversa ainda está trabalhando/u)
    assert.equal(tree.root.findByType('button').props.disabled, false)
    assert.equal(useStore.getState().guiPanes[paneId].items.filter(item => item.kind === 'error').length, 1)
  } finally { await act(async () => tree.unmount()) }
})

test('stale receipts and busy panes expose no enabled recovery action', async () => {
  for (const status of ['working', 'waiting-you', 'dead']) {
    const tree = await mount(status)
    try { assert.equal(tree.root.findAllByType('button').some(button => !button.props.disabled), false) }
    finally { await act(async () => tree.unmount()) }
  }
  const tree = await mount()
  try {
    await act(async () => useStore.setState({ guiPanes: { [paneId]: { ...reduce([failed]), recoveryToken: 'changed' } } }))
    assert.equal(tree.root.findAllByType('button').length, 0)
  } finally { await act(async () => tree.unmount()) }
})

test('uncertain IPC confirmation produces a sanitized failure and never invents acceptance', async () => {
  assert.equal(typeof guiApi.resumeFailedTurn, 'function')
  browser.synkora.gui.resumeFailedTurn = async () => { throw new Error('synthetic private transport details') }
  const result = await guiApi.resumeFailedTurn(paneId, token)
  assert.equal(result.ok, false)
  assert.equal(result.deliveryUncertain, true)
  assert.doesNotMatch(result.error, /private transport/u)
  browser.synkora.gui.resumeFailedTurn = async () => undefined
  assert.equal((await guiApi.resumeFailedTurn(paneId, token)).ok, false)
})

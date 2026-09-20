import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join, sep } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/guiSessions.js'
import { MaestroSession } from '../.tmp/gui-sessions-test/maestroSession.js'
import { GuiClaudeTaskRegistry } from '../.tmp/gui-sessions-test/guiClaudeTasks.js'
import { GuiOwnerMailbox } from '../.tmp/gui-sessions-test/guiOwnerMail.js'
import { GuiOwnerReplyDebt } from '../.tmp/gui-sessions-test/guiOwnerReplyDebt.js'
import { guiOwnerDebtHookSettings } from '../.tmp/gui-sessions-test/guiOwnerDebtHook.js'

const compiled = buildSync({
  stdin: { contents: `
    export { useStore, EMPTY_GUI_PANE } from './src/renderer/src/store';
    export { default as QueueDispatcher } from './src/renderer/src/components/GuiQueueDispatcher';
    export { guiThinkingPresentation } from './src/renderer/src/guiThinkingPresentation';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'zustand']
})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Real protocol -> registry -> IPC adapter -> Zustand -> React dispatcher.
// Only process IO, browser storage and executor controls are synthetic.
function bench(t) {
  const root = mkdtempSync(resolve('.tmp/gui-queued-turn-'))
  t.after(() => {
    assert.ok(root.startsWith(resolve('.tmp') + sep))
    rmSync(root, { recursive: true, force: true })
  })
  const storage = new Map(), writes = [], events = [], calls = [], debt = new GuiOwnerReplyDebt()
  const session = Object.create(MaestroSession.prototype)
  Object.assign(session, {
    killed: false, closed: false, child: { exitCode: null, signalCode: null },
    claudeTasks: new GuiClaudeTaskRegistry(), pending: new Map(), steerTags: new Map(),
    pendingTurnGenerations: [], activeTurnGeneration: null, turnGeneration: 0,
    interruptGeneration: null, interruptRequestId: null, interruptTimer: null,
    capabilities: ['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'], opts: {},
    write: frame => writes.push(frame), resetIdle() {}, kill() { this.closed = true },
    setModel: async () => true, setEffort: async () => true
  })
  const loaded = { exports: {} }
  let gui
  const bridge = {
    send: async (...args) => { calls.push(['send', ...args]); return gui.send(...args) },
    deliverQueued: async (...args) => { calls.push(['queue', ...args]); return gui.deliverQueued(...args) },
    forceOwnerMessage: () => assert.fail('automatic delivery must not interrupt the agent')
  }
  new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiled.outputFiles[0].text)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { documentElement: { style: { setProperty() {} } } },
    { synkora: { gui: bridge }, setTimeout, clearTimeout },
    { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key) }
  )
  const { useStore, EMPTY_GUI_PANE, QueueDispatcher, guiThinkingPresentation } = loaded.exports
  const paneId = 'gui-queued-synthetic'
  useStore.setState({ guiPanes: { [paneId]: { ...EMPTY_GUI_PANE, ready: true, status: 'idle' } } })
  gui = new GuiSessionRegistry({
    push: ({ evt }) => { events.push(evt); useStore.getState().handleGuiLive(paneId, evt) },
    systemPromptFile: () => undefined, storeFile: join(root, 'sessions.json'),
    ownerMail: new GuiOwnerMailbox(), replyDebt: debt
  })
  gui.spawnSession = (_spawn, sink) => { session.emit = sink; return session }
  assert.equal(gui.create({ paneId, projectId: 'synthetic', cli: 'claude', cwd: root, configDir: root }).ok, true)
  session.emit({ type: 'ready', caps: { models: [], commands: [] } })
  let tree
  t.after(async () => { if (tree) await act(async () => tree.unmount()) })
  return {
    gui, paneId, session, writes, events, calls, debt, useStore, guiThinkingPresentation,
    pane: () => useStore.getState().guiPanes[paneId],
    async mount() { await act(async () => { tree = create(React.createElement(QueueDispatcher)) }) },
    start() { assert.equal(gui.send(paneId, 'pedido inicial sintético', 'initial').ok, true) },
    queue(text = 'considere também esta orientação', options = {}) {
      return useStore.getState().queueGuiMessage(paneId, text,
        { model: null, effort: null, permissionMode: 'default', ...options }, [])
    },
    line(frame) { session.handleLine(JSON.stringify(frame)) },
    finish() {
      session.handleLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        num_turns: 1, duration_api_ms: 100, result: 'Resposta sintética concluída.' }))
    }
  }
}

test('queued guidance reaches an active parent once and its native receipt marks it read', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  await b.mount()
  assert.equal(b.writes.length, 2, 'guidance must reach the active agent without waiting for helper_result')
  assert.equal(b.writes[1].message.content[0].text, queued.text)
  assert.equal(b.pane().queued, null)
  assert.equal(b.pane().items.find(item => item.id === queued.id)?.delivery?.state, 'unread')
  await act(async () => b.line({ type: 'command_lifecycle', command_uuid: b.writes[1].uuid, state: 'started' }))
  assert.equal(b.events.filter(evt => evt.type === 'owner-message-state' && evt.id === queued.id).at(-1)?.state, 'read')
  assert.equal((await b.gui.deliverQueued(b.paneId, queued)).ok, true)
  assert.equal(b.writes.length, 2, 'receipt retries must never duplicate delivery')
  await act(async () => b.finish())
  assert.equal(b.pane().status, 'idle')
})

test('normal queued reading can be answered and followed by work in the same turn without force or a second approval', async t => {
  const b = bench(t)
  b.start()
  const generation = b.session.activeTurnGeneration
  const queued = b.queue('Aplique o ajuste sintético ao arquivo.')
  await b.mount()
  assert.equal(b.writes.length, 2)
  assert.equal(b.writes[1].message.content[0].text, queued.text)
  assert.equal(b.debt.pending(b.paneId), null, 'enqueueing is not proof of reading')
  await act(async () => b.line({ type: 'command_lifecycle', command_uuid: b.writes[1].uuid, state: 'started' }))
  assert.deepEqual(b.debt.pending(b.paneId), [queued.text], 'the native read receipt arms the response guard')
  assert.equal(b.session.activeTurnGeneration, generation, 'normal steering must preserve the current turn')
  assert.equal(b.pane().items.find(item => item.id === queued.id)?.delivery?.state, 'read')
  await act(async () => {
    assert.deepEqual(b.gui.commentary({ paneId: b.paneId, projectId: 'synthetic' },
      'Entendi o ajuste. Vou aplicá-lo e verificar o resultado.'), { ok: true })
  })
  assert.equal(b.debt.pending(b.paneId), null)
  assert.equal(b.pane().items.find(item => item.id === queued.id)?.delivery?.state, 'answered')
  assert.equal(b.pane().status, 'working')
  await act(async () => {
    b.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'queued-edit', name: 'Edit',
      input: { file_path: 'synthetic.txt', old_string: 'before', new_string: 'after' } }] } })
    b.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'queued-edit',
      is_error: false, content: 'synthetic edit completed' }] } })
  })
  assert.equal(b.session.activeTurnGeneration, generation)
  assert.equal(b.session.turnActive, true)
  assert.ok(b.events.some(evt => evt.type === 'tool-result' && evt.toolUseId === 'queued-edit' && !evt.isError))
  assert.equal(b.events.some(evt => evt.type === 'result'), false, 'an acknowledgment must not create a terminal')
  assert.equal(b.writes.length, 2, 'no interrupt, extra approval or automatic follow-up was sent')
  await act(async () => b.finish())
  assert.equal(b.pane().status, 'idle')
})

test('a finished parent releases its queue while helpers remain alive and stops showing preparing', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  // The real helper projection preserves logical activity after the root result.
  b.gui.helperCards.hasLiveHelpers = () => true
  b.finish()
  assert.equal(b.pane().status, 'working', 'helper activity remains visible')
  assert.equal(b.guiThinkingPresentation({ ...b.pane(), awaitingInteraction: false }), null,
    'a completed parent is not preparing an answer just because helpers remain')
  await b.mount()
  assert.equal(b.writes.length, 2, 'parent completion must release the queued message')
  assert.equal(b.writes[1].message.content[0].text, queued.text)
  assert.equal(b.pane().queued, null)
})

test('a transient executor lock keeps the exact queue retryable and sends after the lock clears', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  b.finish()
  const entry = b.gui.panes.get(b.paneId)
  b.gui.executorChanges.add(entry)
  await b.mount()
  assert.equal(b.writes.length, 1)
  assert.equal(b.pane().queued?.id, queued.id)
  assert.equal(b.pane().queued?.deliveryError, undefined, 'temporary activity is not a permanent delivery failure')
  b.gui.executorChanges.delete(entry)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
  assert.equal(b.writes.length, 2)
  assert.equal(b.pane().queued, null)
})

test('queued slash commands and executor changes wait for the real parent terminal', async t => {
  for (const [text, options] of [
    ['/status', {}],
    ['orientação sintética', { effort: 'high' }],
    ['orientação sintética', { model: 'synthetic-other-model' }],
    ['orientação sintética', { permissionMode: 'plan' }]
  ]) {
    const b = bench(t)
    b.start()
    const queued = b.queue(text, options)
    const before = await b.gui.deliverQueued(b.paneId, queued)
    assert.equal(before.ok, false)
    assert.equal(before.retryable, true)
    assert.equal(b.writes.length, 1, 'the active executor and raw command cannot be changed by steering')
    assert.equal(b.gui.panes.get(b.paneId).spawn.permissionMode, undefined)
  }
})

test('a native queued message starting after the previous result owns a new active turn', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  await b.gui.deliverQueued(b.paneId, queued)
  b.finish()
  assert.equal(b.session.turnActive, false)
  b.line({ type: 'command_lifecycle', command_uuid: b.writes[1].uuid, state: 'started' })
  assert.equal(b.session.turnActive, true, 'the native next turn must be tracked before its first token')
  assert.equal(b.pane().status, 'working')
  assert.equal(b.pane().turnActive, true)
  b.finish()
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.session.turnActive, false)
})

test('force read can answer through commentary before resuming work without duplicating the owner', async t => {
  const b = bench(t)
  t.after(() => b.session.clearInterruptGuard())
  b.session.capabilities.push('interrupt_receipt_v1')
  b.start()
  const queued = b.queue('Preciso de uma resposta sobre o andamento.')
  await b.gui.deliverQueued(b.paneId, queued)
  const uuid = b.writes[1].uuid
  b.session.emit({ type: 'tool', name: 'Read', input: {}, toolUseId: 'before-force' })
  assert.equal(b.gui.forceOwnerMessage(b.paneId, queued.id).ok, true)
  assert.equal(b.writes.filter(frame => frame.request?.subtype === 'interrupt').length, 1)
  b.finish()
  b.line({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(b.debt.pending(b.paneId), [queued.text], 'the old terminal cannot erase the newly read debt')
  const hooks = guiOwnerDebtHookSettings('C:/synthetic/debt.txt').hooks.PreToolUse
  const blocked = name => b.debt.pending(b.paneId) && hooks.some(hook =>
    hook.matcher === '*' || new RegExp(hook.matcher).test(name))
  assert.equal(blocked('Read'), true)
  assert.equal(blocked('mcp__synkora__commentary'), false, 'public speech must pass the real hook selection')
  const activeGeneration = b.session.activeTurnGeneration
  const writesBeforeReply = b.writes.length
  const terminalsBeforeReply = b.events.filter(evt => evt.type === 'result').length
  assert.equal(b.gui.commentary({ paneId: b.paneId, projectId: 'synthetic' }, 'Recebi sua pergunta. Vou conferir o andamento.').ok, true)
  assert.equal(b.debt.pending(b.paneId), null)
  assert.equal(b.pane().items.find(item => item.id === queued.id)?.delivery?.state, 'answered')
  assert.equal(b.pane().items.filter(item => item.id === queued.id).length, 1)
  assert.equal(b.writes.filter(frame => frame.message?.content?.some(part => part.text === queued.text)).length, 1)
  assert.ok(b.gui.state(b.paneId).events.some(event => event.evt.type === 'text' && event.evt.text.startsWith('Recebi sua pergunta.')))
  assert.equal(b.session.turnActive, true, 'answering is not a terminal result')
  assert.equal(b.pane().status, 'working')
  assert.equal(Boolean(blocked('Edit')), false, 'authorized work unlocks immediately after the reply')
  b.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'after-reply',
    name: 'Edit', input: { file_path: 'synthetic.txt', old_string: 'before', new_string: 'after' } }] } })
  b.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'after-reply',
    is_error: false, content: 'synthetic edit completed' }] } })
  assert.equal(b.session.activeTurnGeneration, activeGeneration, 'the tool runs in the same native turn')
  assert.equal(b.events.filter(evt => evt.type === 'result').length, terminalsBeforeReply)
  assert.equal(b.writes.length, writesBeforeReply, 'no extra owner message or automatic continuation is needed')
  assert.ok(b.events.some(evt => evt.type === 'tool-result' && evt.toolUseId === 'after-reply' && !evt.isError))
  assert.equal(b.pane().status, 'working', 'the verified final answer still belongs to this turn')
  b.finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.pane().status, 'idle')
})

test('a native rejected steer is recovered from durable mail at the terminal without a second user bubble', async t => {
  for (const state of ['discarded', 'cancelled', 'refused']) {
    const b = bench(t)
    b.start()
    const queued = b.queue()
    await b.gui.deliverQueued(b.paneId, queued)
    b.line({ type: 'command_lifecycle', command_uuid: b.writes[1].uuid, state })
    b.finish()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(b.writes.length, 3, 'a structurally rejected steer must not be left unread forever')
    assert.ok(b.writes[2].message.content[0].text.includes(queued.text))
    assert.equal(b.pane().items.filter(item => item.kind === 'user' && item.id === queued.id).length, 1)
    assert.equal(b.events.filter(evt => evt.type === 'owner-message-state' && evt.id === queued.id).at(-1)?.state, 'unread')
    b.line({ type: 'command_lifecycle', command_uuid: b.writes[2].uuid, state: 'started' })
    assert.equal(b.pane().items.find(item => item.id === queued.id)?.delivery?.state, 'read')
    assert.equal(b.pane().status, 'working')
  }
})

test('a pending previous result is published before a newly started turn in the same IO cycle', async t => {
  const b = bench(t)
  b.start()
  b.session.emit({ type: 'tool', name: 'synthetic_tool', input: {}, toolUseId: 'tool-a' })
  b.session.emit({ type: 'tool-result', toolUseId: 'tool-a', text: 'done', isError: false })
  b.finish()
  assert.equal(b.gui.send(b.paneId, 'mensagem seguinte', 'next').ok, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.session.turnActive, true)
  assert.equal(b.pane().status, 'working', 'the previous terminal cannot reset the next turn')
  assert.equal(b.pane().turnActive, true)
})

test('a terminal starts the next queued message once and read receipts cannot create phantom turns', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  b.finish()
  await b.mount()
  assert.equal(b.writes.length, 2)
  assert.equal(b.writes[1].message.content[0].text, queued.text)
  assert.equal(b.pane().status, 'working')
  assert.equal(b.pane().queued, null)
  await act(async () => b.finish())
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.pane().turnActive, false)
  b.line({ type: 'command_lifecycle', command_uuid: 'unknown', state: 'started' })
  assert.equal(b.session.turnActive, false)
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.guiThinkingPresentation({ ...b.pane(), awaitingInteraction: false }), null)
})

test('a late negative receipt recovers only unread mail and does not resend an absorbed message', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  await b.gui.deliverQueued(b.paneId, queued)
  const uuid = b.writes[1].uuid
  b.line({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  b.finish()
  b.line({ type: 'command_lifecycle', command_uuid: uuid, state: 'discarded' })
  b.line({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.writes.length, 2)
  assert.equal(b.session.turnActive, false)
  assert.equal(b.pane().status, 'idle')
})

test('a rejected message arriving after the terminal is recovered immediately', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  await b.gui.deliverQueued(b.paneId, queued)
  b.finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.writes.length, 2, 'absence of a receipt alone is not permission to duplicate a queued message')
  b.line({ type: 'command_lifecycle', command_uuid: b.writes[1].uuid, state: 'discarded' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(b.writes.length, 3)
  assert.equal(b.pane().status, 'working')
})

// CANCELAR É CONTRAORDEM, nunca corte (ordem do dono, 2026-09-16): a bolha some
// na hora, o CLI não recebe interrupt nenhum, e um bilhete de bastidor chega
// junto com a fala na próxima fronteira dizendo ao modelo para ignorá-la. Nada
// de "turno interrompido", nada de retomada — parece que cancelou sem afetar.
const isInterrupt = frame => frame.type === 'control_request' && frame.request?.subtype === 'interrupt'
const userText = frame => frame.message?.content?.map(part => part.text ?? '').join('\n') ?? ''

test('cancel is a counter-order: the bubble disappears, nothing is interrupted and the text never returns', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue('orientação sintética cancelável, com bastante texto para citar')
  await b.mount()
  assert.equal(b.pane().queued, null, 'the authoritative unread bubble replaced the local queue')
  const uuid = b.writes[1].uuid
  const before = b.writes.length
  let result
  await act(async () => { result = await b.gui.cancelOwnerMessage(b.paneId, queued.id) })
  assert.equal(result.ok, true)
  assert.equal(b.writes.some(isInterrupt), false, 'cancel never interrupts the turn')
  assert.equal(b.writes.length, before + 1, 'exactly one counter-order goes to the CLI')
  const order = userText(b.writes.at(-1))
  assert.match(order, /\[synkora\] MENSAGEM DO DONO/u)
  assert.match(order, /RETIROU/u)
  assert.ok(order.includes('orientação sintética cancelável'), 'the counter-order quotes the start of the withdrawn text')
  assert.equal(b.pane().items.find(item => item.id === queued.id), undefined, 'the bubble leaves the thread')
  assert.equal(b.pane().status, 'working', 'the turn keeps going')
  assert.ok(b.gui.restoreTranscript(b.paneId).snapshot().some(evt => evt.type === 'owner-message-state' && evt.id === queued.id && evt.state === 'cancelled'),
    'reopening the recorded transcript preserves the cancellation')
  assert.equal((await b.gui.cancelOwnerMessage(b.paneId, queued.id)).ok, true, 'repeated cancellation uses the recorded result')
  assert.equal(b.writes.length, before + 1, 'a repeated cancel sends nothing more')
  assert.equal((await b.gui.deliverQueued(b.paneId, queued)).ok, true, 'late queue retries are idempotent')
  assert.equal(b.writes.filter(frame => userText(frame).startsWith(queued.text)).length, 1,
    'the cancelled text is never resent as a message of its own')
  // A late native read receipt for the withdrawn message changes nothing.
  const eventsBefore = b.events.length
  b.line({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  assert.equal(b.events.slice(eventsBefore).some(evt => evt.type === 'owner-message-state' && evt.id === queued.id), false,
    'no read stamp for a bubble that already left')
  assert.equal(b.pane().items.find(item => item.id === queued.id), undefined)
  await act(async () => { b.finish() })
  assert.equal(b.writes.some(frame => /Continue a tarefa em andamento|retirada da fila/u.test(userText(frame))), false,
    'no resumption note: nothing was interrupted')
  assert.equal(b.writes.some(isInterrupt), false)
})

test('cancelling one native queued message preserves its neighbour and never stops the helper fleet', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue('mensagem a cancelar')
  await b.gui.deliverQueued(b.paneId, queued)
  assert.equal(b.gui.send(b.paneId, 'mensagem que deve continuar', 'kept').ok, true)
  const secondUuid = b.writes[2].uuid
  b.gui.helpers = { interruptPane() { assert.fail('cancellation must not stop the helper fleet') } }
  assert.equal((await b.gui.cancelOwnerMessage(b.paneId, queued.id)).ok, true)
  assert.equal(b.writes.some(isInterrupt), false)
  const order = userText(b.writes.at(-1))
  assert.ok(order.includes('mensagem a cancelar'))
  assert.ok(!order.includes('mensagem que deve continuar'), 'the neighbour is not mentioned by the counter-order')
  assert.equal(b.pane().items.find(item => item.id === queued.id), undefined)
  assert.equal(b.pane().items.find(item => item.id === 'kept')?.delivery?.state, 'unread',
    'the neighbouring message remains cancellable until its own native read receipt')
  b.line({ type: 'command_lifecycle', command_uuid: secondUuid, state: 'started' })
  assert.equal(b.pane().items.find(item => item.id === 'kept')?.delivery?.state, 'read')
  b.finish()
  assert.equal(b.writes.some(isInterrupt), false)
})

test('a message the agent already read cannot be cancelled, and the refusal names why', async t => {
  const b = bench(t)
  b.start()
  const queued = b.queue()
  await b.gui.deliverQueued(b.paneId, queued)
  b.line({ type: 'command_lifecycle', command_uuid: b.writes[1].uuid, state: 'started' })
  assert.equal(b.pane().items.find(item => item.id === queued.id)?.delivery?.state, 'read')
  const result = await b.gui.cancelOwnerMessage(b.paneId, queued.id)
  assert.equal(result.ok, false)
  assert.match(result.error, /já foi lida/u)
  assert.equal(b.writes.some(isInterrupt), false)
  assert.ok(b.pane().items.find(item => item.id === queued.id), 'a read bubble stays')
})

test('durable cancellation refuses an uncommitted disk change and preserves neighbouring messages', () => {
  let fail = false, saved = []
  const mailbox = new GuiOwnerMailbox({ store: {
    load: () => [], save: records => { if (fail) throw new Error('synthetic disk failure'); saved = structuredClone(records) }
  } })
  mailbox.post('pane', { messageId: 'target', text: 'texto sintético', at: Date.now(), steered: true })
  mailbox.post('pane', { messageId: 'other', text: 'outro texto sintético', at: Date.now(), steered: true })
  fail = true
  assert.equal(mailbox.cancelById('pane', 'target'), false)
  assert.equal(mailbox.count('pane'), 2)
  fail = false
  assert.equal(mailbox.cancelById('pane', 'target'), true)
  assert.deepEqual(saved.map(record => record.messageId), ['other'])
})

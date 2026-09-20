import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { GuiSessionRegistry, isGuiPersistedEvent } from '../.tmp/gui-sessions-test/guiSessions.js'
import { MaestroSession } from '../.tmp/gui-sessions-test/maestroSession.js'
import { CodexSession } from '../.tmp/gui-sessions-test/codexSession.js'
import { GuiClaudeTaskRegistry } from '../.tmp/gui-sessions-test/guiClaudeTasks.js'
import { GuiOwnerMailbox } from '../.tmp/gui-sessions-test/guiOwnerMail.js'

const compiledStore = buildSync({ stdin: { contents: `export { useStore, EMPTY_GUI_PANE } from './src/renderer/src/store';`,
  resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['react', 'zustand'] }).outputFiles[0].text
const drain = () => new Promise(resolve => setImmediate(resolve))
const parcels = input => ({ inputTokens: input, cacheWriteTokens: 0, cacheReadTokens: 200, outputTokens: 10 })

function bench(t) {
  const root = mkdtempSync(resolve('.tmp/gui-usage-'))
  t.after(() => { assert.ok(root.startsWith(resolve('.tmp') + sep)); rmSync(root, { recursive: true, force: true }) })
  const loaded = { exports: {} }, storage = new Map()
  new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiledStore)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { documentElement: { style: { setProperty() {} } } },
    { synkora: {}, setTimeout, clearTimeout },
    { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  )
  const { useStore, EMPTY_GUI_PANE } = loaded.exports, paneId = 'usage-synthetic'
  useStore.setState({ guiPanes: { [paneId]: { ...EMPTY_GUI_PANE, ready: true, status: 'idle' } } })
  let sink, active = false
  const events = []
  const gui = new GuiSessionRegistry({ push: ({ evt }) => {
    events.push(evt); useStore.getState().handleGuiLive(paneId, evt)
  }, systemPromptFile: () => undefined, storeFile: join(root, 'sessions.json'), ownerMail: new GuiOwnerMailbox() })
  gui.spawnSession = (_spawn, nextSink) => {
    sink = nextSink
    sink({ type: 'init', model: 'synthetic', sessionId: 'synthetic-thread', permissionMode: 'default', toolCount: 0, contextWindow: 200_000 })
    sink({ type: 'ready', caps: { commands: [], models: [] } })
    return { alive: true, get turnActive() { return active }, waitCaps: async () => ({ commands: [], models: [] }),
      send() { active = true }, kill() { active = false } }
  }
  const spawn = { paneId, projectId: 'synthetic', cli: 'claude', cwd: root, configDir: root }
  assert.equal(gui.create(spawn).ok, true)
  return { gui, paneId, spawn, events, useStore,
    emit: evt => sink(evt),
    send: id => assert.equal(gui.send(paneId, 'Pedido sintético.', id).ok, true),
    async finish() { active = false; sink({ type: 'result', isError: false }); await drain() },
    sample(requestId, input = 100, output = 10) {
      const usage = { ...parcels(input), outputTokens: output }
      sink({ type: 'context-usage', contextTokens: input + 200 + output, contextWindow: 200_000,
        call: usage, sample: { kind: 'request', scopeId: 'claude:synthetic-thread', requestId, usage } })
    },
    pane: () => useStore.getState().guiPanes[paneId]
  }
}

test('registry and renderer separate rounds, keep mid-turn steering together and never sum replay twice', async t => {
  const b = bench(t)
  b.send('owner-a')
  b.sample('request-a', 100, 2)
  b.sample('request-a', 100, 2)
  b.sample('request-a', 100, 10)
  assert.equal(b.pane().usage.conversation.apiCalls, 1)
  assert.equal(b.pane().usage.round.usage.outputTokens, 10)
  const firstRound = b.pane().usage.round.id
  b.send('owner-steer')
  assert.equal(b.pane().usage.round.id, firstRound)
  await b.finish()
  b.send('owner-b')
  assert.notEqual(b.pane().usage.round.id, firstRound)
  assert.equal(b.pane().usage.round.usage, null)
  b.sample('request-b', 40)
  assert.equal(b.pane().usage.conversation.inputTokens, 140)
  assert.equal(b.pane().usage.round.usage.inputTokens, 40)
  const context = b.events.filter(evt => evt.type === 'context-usage').at(-1)
  assert.equal('sample' in context, false)
  assert.equal('call' in context, false)
  const before = b.pane().usage
  b.useStore.getState().handleGuiLive(b.paneId, context)
  b.useStore.getState().handleGuiLive(b.paneId, context)
  assert.deepEqual(b.pane().usage, before)
  b.emit({ type: 'context-usage', contextTokens: null, contextWindow: null })
  assert.deepEqual(b.pane().usage, before, 'compaction does not refund consumed history')
})

test('stored legacy parcels seed history and tracked request IDs survive a resumed process', async t => {
  const b = bench(t)
  b.gui.doc.panes[b.paneId].conversationUsage = { ...parcels(5_000), apiCalls: 20 }
  b.send('owner-a')
  b.sample('request-a', 100)
  assert.equal(b.pane().usage.conversation.inputTokens, 5_100)
  assert.equal(b.pane().usage.round.usage.inputTokens, 100)
  await b.finish()
  assert.equal(b.gui.create({ ...b.spawn, permissionMode: 'acceptEdits' }).ok, true)
  b.sample('request-a', 100)
  assert.equal(b.pane().usage.conversation.inputTokens, 5_100)
  assert.equal(b.pane().usage.conversation.apiCalls, null, 'legacy observations do not become verified requests')
  assert.equal(b.pane().usage.round.usage.apiCalls, 1)
  b.emit({ type: 'conversation-cleared' })
  assert.equal(b.pane().usage, null)
})

test('persisted usage snapshots reject invalid counters and accept old replay without the new field', () => {
  const base = { type: 'context-usage', contextTokens: 10, contextWindow: 200_000 }
  assert.equal(isGuiPersistedEvent(base), true)
  assert.equal(isGuiPersistedEvent({ ...base, usage: { conversation: { ...parcels(10), apiCalls: 1 }, round: null } }), true)
  assert.equal(isGuiPersistedEvent({ ...base, usage: { conversation: { ...parcels(-10), apiCalls: 1 }, round: null } }), false)
  assert.equal(isGuiPersistedEvent({ ...base, usage: { conversation: {}, round: null } }), false)
})

test('live background helpers preserve the owner round until all work closes', async t => {
  const b = bench(t)
  b.send('owner-a'); b.sample('request-a')
  const firstRound = b.pane().usage.round.id
  await b.finish()
  b.gui.helperCards.hasLiveHelpers = () => true
  b.send('owner-during-helper')
  assert.equal(b.pane().usage.round.id, firstRound)
})

test('unidentified new-protocol frames mark measured subtotals partial instead of appearing free', t => {
  const b = bench(t)
  b.send('owner-a'); b.sample('identified')
  b.emit({ type: 'context-usage', contextTokens: 310, contextWindow: 200_000, sample: null, call: parcels(100) })
  assert.equal(b.pane().usage.conversation.apiCalls, 1)
  assert.equal(b.pane().usage.partial, true)
  assert.equal(b.pane().usage.round.partial, true)
})

test('Claude parser retains stable message identity for usage corrections and leaves missing IDs unavailable', () => {
  const session = Object.create(MaestroSession.prototype), events = []
  Object.assign(session, { opts: {}, emit: event => events.push(event), resetIdle() {},
    claudeTasks: new GuiClaudeTaskRegistry(), capabilities: [], initModel: null, pending: new Map(),
    steerTags: new Map(), pendingTurnGenerations: [], controlWaiters: new Map() })
  session.handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'synthetic-thread', model: 'synthetic' }))
  const frame = { type: 'assistant', message: { id: 'synthetic-request', usage: {
    input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 2
  }, content: [] } }
  session.handleLine(JSON.stringify(frame))
  frame.message.usage.output_tokens = 12
  session.handleLine(JSON.stringify(frame))
  const measured = events.filter(event => event.type === 'context-usage')
  assert.equal(measured[0].sample.requestId, 'synthetic-request')
  assert.equal(measured[1].sample.requestId, 'synthetic-request')
  assert.equal(measured[1].sample.usage.outputTokens, 12)
  delete frame.message.id
  session.handleLine(JSON.stringify(frame))
  assert.equal(events.at(-1).sample, null)
})

test('Codex parser supplies cumulative usage with a resume baseline and does not count notifications as calls', () => {
  const session = Object.create(CodexSession.prototype), events = []
  Object.assign(session, { opts: { resumeSessionId: 'synthetic-thread' }, threadId: 'synthetic-thread', turnId: null,
    codexAgents: { has: () => false },
    emit: event => events.push(event) })
  const tokenUsage = { last: { totalTokens: 12 }, modelContextWindow: 200_000,
    total: { inputTokens: 1_000, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 40 } }
  session.handleNotification('thread/tokenUsage/updated', { threadId: 'synthetic-thread', tokenUsage })
  assert.equal(events[0].contextTokens, 12)
  assert.equal(events[0].sample.kind, 'cumulative')
  assert.equal(events[0].sample.initial, 'baseline')
  assert.equal(events[0].sample.attribution, 'conversation')
  assert.equal(events[0].sample.usage.apiCalls, null)
})

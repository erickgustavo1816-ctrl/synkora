import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/guiSessions.js'
import { MaestroSession, translateGuiRateLimit } from '../.tmp/gui-sessions-test/maestroSession.js'
import { GuiClaudeTaskRegistry } from '../.tmp/gui-sessions-test/guiClaudeTasks.js'
import { GuiOwnerMailbox } from '../.tmp/gui-sessions-test/guiOwnerMail.js'

const compiled = buildSync({ stdin: { contents: `
  export { useStore, EMPTY_GUI_PANE } from './src/renderer/src/store';
  export { guiThinkingPresentation } from './src/renderer/src/guiThinkingPresentation';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['react', 'zustand'] }).outputFiles[0].text
const drain = () => new Promise(resolve => setImmediate(resolve))

// Real parser -> registry -> bridge -> renderer. Process IO/storage are synthetic.
function bench(t) {
  const root = mkdtempSync(resolve('.tmp/gui-activity-'))
  const writes = [], events = [], storage = new Map()
  const session = Object.create(MaestroSession.prototype)
  Object.assign(session, {
    killed: false, closed: false, child: { exitCode: null, signalCode: null }, opts: {},
    claudeTasks: new GuiClaudeTaskRegistry(), pending: new Map(), steerTags: new Map(), controlWaiters: new Map(),
    pendingTurnGenerations: [], activeTurnGeneration: null, turnGeneration: 0,
    interruptGeneration: null, interruptRequestId: null, interruptTimer: null,
    capabilities: [], rateLimitKey: null, rateLimitBlocked: null,
    write: frame => writes.push(frame), resetIdle() {}
  })
  let gui
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { documentElement: { style: { setProperty() {} } } },
    { synkora: { gui: { interrupt: async paneId => gui.interrupt(paneId) } }, setTimeout, clearTimeout },
    { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  )
  const { useStore, EMPTY_GUI_PANE, guiThinkingPresentation } = loaded.exports
  const paneId = 'gui-activity-synthetic'
  useStore.setState({ guiPanes: { [paneId]: { ...EMPTY_GUI_PANE, ready: true, status: 'idle' } } })
  gui = new GuiSessionRegistry({
    push: ({ evt }) => { events.push(evt); useStore.getState().handleGuiLive(paneId, evt) },
    systemPromptFile: () => undefined, storeFile: join(root, 'sessions.json'), ownerMail: new GuiOwnerMailbox()
  })
  gui.spawnSession = (_spawn, sink) => { session.emit = sink; return session }
  assert.equal(gui.create({ paneId, projectId: 'synthetic', cli: 'claude', cwd: root, configDir: root }).ok, true)
  session.emit({ type: 'ready', caps: { models: [], commands: [] } })
  t.after(() => {
    session.clearInterruptGuard()
    assert.ok(root.startsWith(resolve('.tmp') + sep))
    rmSync(root, { recursive: true, force: true })
  })
  const line = frame => session.handleLine(JSON.stringify(frame))
  return {
    gui, session, paneId, writes, events, useStore, guiThinkingPresentation, line,
    pane: () => useStore.getState().guiPanes[paneId],
    start() { assert.equal(gui.send(paneId, 'Pedido sintético.', 'owner-synthetic').ok, true) },
    finish() { line({ type: 'result', is_error: false, result: 'Resposta sintética.' }) },
    task() {
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'native-tool', name: 'Agent', input: {} }] } })
      line({ type: 'system', subtype: 'task_started', task_id: 'native-task', tool_use_id: 'native-tool' })
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: 'Despachado.' }] },
        tool_use_result: { status: 'async_launched', agentId: 'native-task' } })
    },
    settled() { line({ type: 'system', subtype: 'task_notification', task_id: 'native-task', tool_use_id: 'native-tool', status: 'completed' }) }
  }
}

for (const via of ['notification', 'snapshot']) {
  test(`last native background task closes GUI activity via ${via} without another root result`, async t => {
    const b = bench(t)
    b.start(); b.task(); b.finish(); await drain()
    assert.equal(b.session.turnActive, false)
    assert.equal(b.pane().status, 'working')
    assert.equal(b.pane().turnActive, false)
    if (via === 'notification') b.settled()
    else b.line({ type: 'system', subtype: 'background_tasks_changed' })
    await drain()
    assert.equal(b.session.claudeTasks.size, 0)
    assert.equal(b.pane().status, 'idle')
    assert.equal(b.pane().startedAt, null)
    assert.equal(b.events.filter(evt => evt.type === 'turn-continuation' && evt.continues === false).length, 1)
    b.settled(); await drain()
    assert.equal(b.events.filter(evt => evt.type === 'turn-continuation' && evt.continues === false).length, 1, 'late duplicate cannot finish a round twice')
  })
}

const activities = [
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'synthetic-private' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Retomando.' } } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'root-tool', name: 'Read', input: {} }] } }
]
for (const [index, frame] of activities.entries()) {
  test(`autonomous root activity ${index} starts a real interruptible generation`, async t => {
    const b = bench(t)
    b.start(); b.finish(); await drain()
    b.line({ type: 'system', subtype: 'init', session_id: 'same-session', model: 'synthetic' })
    assert.equal(b.session.turnActive, false, 'init alone is not proof of a request')
    b.line({ ...frame, parent_tool_use_id: 'child-tool' })
    assert.equal(b.session.turnActive, false, 'child events cannot open a parent turn')
    b.line(frame)
    assert.equal(b.session.turnActive, true)
    assert.equal(b.pane().turnActive, true)
    assert.equal(b.pane().status, 'working')
    assert.equal(b.gui.interrupt(b.paneId).ok, true)
    assert.equal(b.writes.at(-1).request.subtype, 'interrupt')
    b.finish(); await drain()
    assert.equal(b.pane().status, 'idle')
  })
}

test('last background receipt cannot settle a new root request in the same chunk', async t => {
  const b = bench(t)
  b.start(); b.task(); b.finish(); await drain()
  b.settled()
  b.line(activities[1])
  await drain()
  assert.equal(b.session.turnActive, true)
  assert.equal(b.pane().status, 'working')
  assert.equal(b.pane().turnActive, true)
  assert.equal(b.events.some(evt => evt.type === 'turn-continuation' && evt.continues === false), false)
})

test('a new thinking phase closes the partial speech and remains visibly active', async t => {
  const b = bench(t)
  b.start()
  b.line(activities[2])
  b.line(activities[1])
  assert.equal(b.pane().stream, '')
  assert.equal(b.pane().activeAssistantId, null)
  assert.equal(b.pane().items.find(item => item.kind === 'assistant').live, false)
  assert.equal(b.guiThinkingPresentation({ ...b.pane(), awaitingInteraction: false }).label, 'o agente está pensando')
  b.line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })
  assert.equal(b.session.turnActive, true)
  assert.equal(b.pane().status, 'working')
  assert.ok(b.guiThinkingPresentation({ ...b.pane(), awaitingInteraction: false }))
})

test('stop reconciles an already idle engine without a failure banner or live text', async t => {
  const b = bench(t)
  b.useStore.getState().handleGuiLive(b.paneId, { type: 'turn-started' })
  b.useStore.getState().handleGuiLive(b.paneId, { type: 'delta', text: 'Texto parcial sintético.' })
  assert.equal(b.session.turnActive, false)
  await b.useStore.getState().interruptGuiPane(b.paneId)
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.pane().turnActive, false)
  assert.equal(b.pane().stream, '')
  assert.equal(b.pane().activeAssistantId, null)
  assert.equal(b.pane().items.some(item => item.kind === 'error'), false)
  assert.ok(b.pane().items.some(item => item.kind === 'note' && /já havia terminado/u.test(item.text)))
  assert.equal(b.writes.length, 0, 'no interrupt request is invented for an idle process')
})

test('a real interrupt refusal cannot be disguised as an idle success', t => {
  const b = bench(t)
  b.start()
  b.session.interrupt = () => false
  assert.equal(b.gui.interrupt(b.paneId).ok, false)
  assert.equal(b.pane().status, 'working')
})

test('an idle stop acknowledgement cannot downgrade a newer request', async t => {
  const b = bench(t)
  b.useStore.getState().handleGuiLive(b.paneId, { type: 'turn-started' })
  const stopping = b.useStore.getState().interruptGuiPane(b.paneId)
  // The canonical idle event arrived, but its asynchronous IPC reply has not.
  b.start()
  b.line(activities[1])
  await stopping
  assert.equal(b.session.turnActive, true)
  assert.equal(b.pane().status, 'working')
  assert.equal(b.pane().turnActive, true)
  assert.equal(b.pane().thinking, true)
  assert.equal(b.pane().items.some(item => item.kind === 'error'), false)
})

function backgroundShell(b) {
  b.line({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'preview-tool', name: 'Bash', input: { command: 'synthetic-preview', run_in_background: true } }
  ] } })
  // SDKTaskStartedMessage.task_type distinguishes persistent shell work from
  // native agents; descriptions and the command text carry no authority here.
  b.line({ type: 'system', subtype: 'task_started', task_id: 'preview-task',
    tool_use_id: 'preview-tool', task_type: 'local_bash', description: 'Synthetic preview' })
  b.line({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'preview-tool', content: 'Synthetic launch receipt.' }
  ] }, tool_use_result: { stdout: '', stderr: '', backgroundTaskId: 'preview-task' } })
}

test('a background preview server does not keep a completed answer working or fail idle Stop', async t => {
  const b = bench(t)
  b.start(); backgroundShell(b); b.finish(); await drain()
  assert.equal(b.session.turnActive, false)
  assert.equal(b.session.backgroundActive, false, 'a shell process is not active agent work')
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.pane().startedAt, null)
  const writesBeforeStop = b.writes.length
  assert.deepEqual(b.gui.interrupt(b.paneId), { ok: true, alreadyIdle: true })
  assert.equal(b.writes.length, writesBeforeStop, 'idle Stop must not send interrupt or kill a preview server')
  assert.ok(b.session.claudeTasks.taskFor('preview-task'), 'the running preview remains tracked and alive')
  b.line({ type: 'system', subtype: 'task_notification', task_id: 'preview-task',
    tool_use_id: 'preview-tool', status: 'completed', summary: 'Synthetic server ended.' })
  b.line({ type: 'system', subtype: 'task_notification', task_id: 'preview-task',
    tool_use_id: 'preview-tool', status: 'completed', summary: 'Repeated synthetic server receipt.' })
  await drain()
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.events.some(evt => evt.agentTaskId === 'preview-task'), false, 'shell events never invent an agent card')
})

test('the last agent settles the logical turn while a background shell remains alive', async t => {
  const b = bench(t)
  b.start(); backgroundShell(b); b.task(); b.finish(); await drain()
  assert.equal(b.pane().status, 'working')
  assert.equal(b.pane().turnActive, false)
  b.settled(); await drain()
  assert.equal(b.pane().status, 'idle')
  assert.ok(b.session.claudeTasks.taskFor('preview-task'))
})

test('Stop can cancel a native background agent after the parent result and settles only on ACK', async t => {
  const b = bench(t)
  b.start(); b.task(); b.finish(); await drain()
  assert.equal(b.gui.interrupt(b.paneId).ok, true)
  const request = b.writes.at(-1)
  assert.equal(request.request.subtype, 'interrupt')
  assert.equal(b.session.turnActive, false, 'cancelling an agent must not invent a model request')
  assert.equal(b.session.backgroundActive, true, 'a dispatched interrupt is not an acknowledgement')
  assert.equal(b.pane().status, 'working')
  assert.equal(b.gui.interrupt(b.paneId).ok, true)
  assert.equal(b.writes.at(-1), request, 'duplicate Stop reuses the pending request')
  b.line({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } })
  await drain()
  assert.equal(b.session.backgroundActive, false)
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.session.interruptTimer, null, 'ACK requires no nonexistent parent result to clear its timeout')
  assert.deepEqual(b.gui.interrupt(b.paneId), { ok: true, alreadyIdle: true })
})

test('a background-only Stop cannot clear or kill a newer parent request through its late ACK', async t => {
  const b = bench(t)
  b.start(); b.task(); b.finish(); await drain()
  assert.equal(b.gui.interrupt(b.paneId).ok, true)
  const stopped = b.writes.at(-1)
  b.line(activities[1])
  const generation = b.session.activeTurnGeneration
  b.line({ type: 'control_response', response: { subtype: 'success', request_id: stopped.request_id } })
  await drain()
  assert.equal(b.session.activeTurnGeneration, generation)
  assert.equal(b.pane().status, 'working')
  assert.equal(b.pane().turnActive, true)
  assert.equal(b.session.interruptTimer, null, 'an obsolete background Stop must not kill a newer request')
  assert.equal(b.session.backgroundActive, false, 'the matching ACK still confirms the older agent stopped')
})

test('authoritative background metadata corrects an earlier untyped shell without adopting unknown tasks', async t => {
  const b = bench(t)
  b.start()
  b.line({ type: 'system', subtype: 'task_started', task_id: 'preview-task', tool_use_id: 'preview-tool' })
  b.finish(); await drain()
  assert.equal(b.pane().status, 'working', 'missing type alone is not proof of an idle agent')
  b.line({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'preview-task', task_type: 'local_bash' },
    { task_id: 'unknown-task', task_type: 'local_agent' }
  ] })
  await drain()
  assert.equal(b.pane().status, 'idle')
  assert.ok(b.session.claudeTasks.taskFor('preview-task'))
  assert.equal(b.session.claudeTasks.taskFor('unknown-task'), null)
})

for (const taskType of ['local_agent', 'remote_agent', 'background', 'future-task-type', undefined]) {
  test(`agent or unclassified native task ${String(taskType)} remains active after the parent result`, async t => {
    const b = bench(t)
    b.start()
    b.line({ type: 'system', subtype: 'task_started', task_id: 'native-task',
      tool_use_id: 'native-tool', ...(taskType ? { task_type: taskType } : {}) })
    b.finish(); await drain()
    assert.equal(b.session.turnActive, false)
    assert.equal(b.session.backgroundActive, true)
    assert.equal(b.pane().status, 'working')
  })
}

test('missing ACK for active native background work remains a failure', async t => {
  const b = bench(t)
  b.start(); b.task(); b.finish(); await drain()
  let killed = 0
  b.session.kill = () => { killed += 1 }
  assert.equal(b.gui.interrupt(b.paneId).ok, true)
  b.session.failInterrupt(b.session.interruptGeneration, 'Synthetic timeout: no acknowledgement.')
  assert.equal(killed, 1)
  assert.equal(b.pane().status, 'dead')
  assert.ok(b.pane().items.some(item => item.kind === 'error' && /Synthetic timeout/u.test(item.text)))
})

test('a native terminal while Stop awaits ACK closes cleanly and disarms the pending timeout', async t => {
  const b = bench(t)
  b.start(); b.task(); b.finish(); await drain()
  assert.equal(b.gui.interrupt(b.paneId).ok, true)
  b.settled(); await drain()
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.session.interruptTimer, null)
})

test('a terminal task receipt remembered before a late start cannot resurrect background work', async t => {
  const b = bench(t)
  b.start(); b.settled(); b.task(); b.finish(); await drain()
  assert.equal(b.session.backgroundActive, false)
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.events.filter(evt => evt.agentTaskId === 'native-task' && evt.agentStatus === 'launched').length, 0)
})

test('native completion keeps the logical turn open for live MCP helpers', async t => {
  const b = bench(t)
  b.start(); b.task(); b.finish(); await drain()
  b.gui.helperCards.hasLiveHelpers = () => true
  b.settled(); await drain()
  assert.equal(b.pane().status, 'working')
  assert.equal(b.pane().turnActive, false)
  b.gui.helperCards.hasLiveHelpers = () => false
  b.gui.panes.get(b.paneId).sink({ type: 'turn-continuation', continues: false })
  assert.equal(b.pane().status, 'idle')
})

test('a helper completion cannot overtake a deferred native parent result and leave working stuck', async t => {
  const b = bench(t)
  b.start(); b.task(); b.finish()
  // Synchronous helper lifecycle projection can close before the terminal
  // microtask. The terminal must retain its position in the event stream.
  b.session.claudeTasks.settleAll()
  b.gui.panes.get(b.paneId).sink({ type: 'turn-continuation', continues: false })
  await drain()
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.events.at(-1).type, 'turn-continuation')
})

test('plan warning uses plain language without claiming that work is still running', () => {
  const warning = translateGuiRateLimit({ status: 'allowed_warning', resetsAt: 1_800_000_000 }, null).event
  assert.equal(warning.type, 'command-output')
  assert.match(warning.text, /Você está perto do limite do plano\./u)
  assert.match(warning.text, /Renovação prevista às \d{2}:\d{2}\./u)
  assert.doesNotMatch(warning.text, /allowed_warning|APROXIMANDO|nada parou/u)
})

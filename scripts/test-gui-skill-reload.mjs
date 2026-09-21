import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/main/guiSessions.js'
import { MaestroSession } from '../.tmp/gui-sessions-test/main/maestroSession.js'
import { GuiClaudeTaskRegistry } from '../.tmp/gui-sessions-test/main/guiClaudeTasks.js'
import { GuiClaudeSkillReload, GUI_SKILL_RELOAD_TTL_MS } from '../.tmp/gui-sessions-test/main/guiClaudeSkillReload.js'

const compiled = buildSync({
  stdin: { contents: "export { applyGuiEvent, EMPTY_GUI_PANE } from './src/renderer/src/store'",
    resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'zustand']
})
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports,
  { documentElement: { style: { setProperty() {} } } }, {}, { getItem() { return null } }
)
const { applyGuiEvent, EMPTY_GUI_PANE } = loaded.exports

// Real protocol handler -> registry -> renderer reducer; no CLI or app is launched.
function bench(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-reload-receipt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const session = Object.create(MaestroSession.prototype)
  const events = [], writes = []
  let pane = { ...EMPTY_GUI_PANE, ready: true, status: 'idle' }
  Object.assign(session, {
    killed: false, closed: false, child: { exitCode: null, signalCode: null },
    claudeTasks: new GuiClaudeTaskRegistry(), pending: new Map(), steerTags: new Map(),
    pendingTurnGenerations: [], activeTurnGeneration: null, turnGeneration: 0,
    interruptGeneration: null, interruptRequestId: null, interruptTimer: null,
    rateLimitKey: null, rateLimitBlocked: null, capabilities: [],
    write: frame => writes.push(frame), resetIdle() {}, kill() { this.closed = true }
  })
  const gui = new GuiSessionRegistry({
    push: ({ evt }) => { events.push(evt); pane = applyGuiEvent(pane, evt) },
    systemPromptFile: () => undefined, storeFile: join(root, 'sessions.json')
  })
  gui.spawnSession = (_spawn, sink) => { session.emit = sink; return session }
  const paneId = 'gui-dev-reload-proof'
  assert.equal(gui.create({ paneId, projectId: 'synthetic', cli: 'claude', cwd: root, configDir: root }).ok, true)
  return {
    gui, paneId, session, events, writes, pane: () => pane,
    line: frame => session.handleLine(JSON.stringify(frame)),
    start() { session.send('synthetic turn'); session.emit({ type: 'turn-started' }) }
  }
}

const answer = '**Entrega pronta.**\n\n- Ajuste concluído.\n- Verificação concluída.'
const finalFrame = (result = answer, extra = {}) => ({ type: 'result', subtype: 'success',
  is_error: false, num_turns: 1, duration_api_ms: 120, result, ...extra })
const catalog = { type: 'system', subtype: 'commands_changed', commands: [] }
const receipt = () => finalFrame('Catálogo atualizado pelo CLI.', { num_turns: 0, duration_api_ms: 0 })
function speak(b, text = answer) { b.session.emit({ type: 'text', text }) }
function assertNormalAnswer(b) {
  assert.equal(b.pane().status, 'idle', 'the real final result must leave preparing')
  assert.equal(b.events.filter(evt => evt.type === 'result').at(-1)?.resultText, answer)
  assert.equal(b.pane().items.filter(item => item.kind === 'assistant' && item.text === answer).length, 1)
  assert.equal(b.pane().items.some(item => item.kind === 'note' && item.text.includes('Entrega pronta')), false,
    'the formatted answer must never be flattened into a system note')
}

test('a residual agent turn is not mistaken for a reload receipt when turnActive was false', async t => {
  const b = bench(t)
  assert.equal(b.session.turnActive, false)
  assert.equal((await b.gui.reloadSkills(b.paneId)).ok, true)
  speak(b)
  b.line(finalFrame())
  assertNormalAnswer(b)
})

test('a missing reload receipt cannot consume the next agent final or keep it preparing', async t => {
  const b = bench(t)
  b.start()
  await b.gui.reloadSkills(b.paneId)
  speak(b, 'Primeira resposta.')
  b.line(finalFrame('Primeira resposta.'))
  b.start()
  speak(b)
  b.line(finalFrame())
  assertNormalAnswer(b)
  assert.equal(b.events.filter(evt => evt.type === 'result').length, 2)
})

test('a confirmed reload before the agent final does not consume its generation', async t => {
  const b = bench(t)
  b.start()
  const generation = b.session.activeTurnGeneration
  await b.gui.reloadSkills(b.paneId)
  b.line(catalog)
  b.line(receipt())
  assert.equal(b.session.activeTurnGeneration, generation, 'a local command cannot finish a model turn')
  assert.equal(b.events.filter(evt => evt.type === 'result').length, 0)
  assert.ok(b.events.some(evt => evt.type === 'command-output' && evt.text.includes('Catálogo atualizado pelo CLI.')))
  speak(b)
  b.line(finalFrame())
  assertNormalAnswer(b)
})

test('a late reload receipt preserves the newly started turn, context and pending interaction', async t => {
  const b = bench(t)
  b.start()
  await b.gui.reloadSkills(b.paneId)
  speak(b, 'Primeira resposta.')
  b.line(finalFrame('Primeira resposta.'))
  b.start()
  const generation = b.session.activeTurnGeneration
  b.session.turnContextTokens = 1234
  b.session.pending.set('pending-question', { toolName: 'AskUserQuestion', description: '', input: {}, suggestions: [] })
  b.line(catalog)
  b.line(receipt())
  assert.equal(b.session.activeTurnGeneration, generation)
  assert.equal(b.session.turnContextTokens, 1234)
  assert.equal(b.session.pending.has('pending-question'), true)
  assert.equal(b.pane().status, 'working')
  speak(b)
  b.line(finalFrame())
  assertNormalAnswer(b)
})

test('an idle reload does not open an agent turn, and repeated requests share one command', async t => {
  const b = bench(t)
  await b.gui.reloadSkills(b.paneId)
  await b.gui.reloadSkills(b.paneId)
  assert.equal(b.writes.length, 1)
  assert.equal(b.writes[0].message.content[0].text, '/reload-skills')
  assert.equal(b.session.turnActive, false)
  b.line(catalog)
  b.line(receipt())
  assert.equal(b.pane().status, 'idle')
  assert.equal(b.events.some(evt => evt.type === 'turn-started' || evt.type === 'result'), false)
  await b.gui.reloadSkills(b.paneId)
  assert.equal(b.writes.length, 2, 'a confirmed receipt releases the next catalog update')
})

test('receipt classification requires explicit catalog and zero-model-work metadata, never answer wording', async t => {
  for (const variant of ['no-catalog', 'model-turns', 'api-work', 'missing-turns', 'missing-api', 'child-catalog', 'intervening-answer']) {
    const b = bench(t)
    await b.gui.reloadSkills(b.paneId)
    if (variant !== 'no-catalog') b.line({ ...catalog, ...(variant === 'child-catalog' ? { parent_tool_use_id: 'child' } : {}) })
    if (variant === 'intervening-answer') b.line({ type: 'stream_event', event: { type: 'message_start' } })
    const frame = receipt()
    if (variant === 'model-turns') frame.num_turns = 1
    if (variant === 'api-work') frame.duration_api_ms = 10
    if (variant === 'missing-turns') delete frame.num_turns
    if (variant === 'missing-api') delete frame.duration_api_ms
    b.line(frame)
    assert.equal(b.events.filter(evt => evt.type === 'result').length, 1, variant)
    assert.equal(b.events.some(evt => evt.type === 'command-output' && evt.text.includes('catálogo de skills recarregado')), false, variant)
  }
})

test('a child receipt cannot consume the parent receipt, and an unsolicited catalog signal is not a reload', async t => {
  const b = bench(t)
  b.line(catalog)
  b.line(receipt())
  assert.equal(b.events.filter(evt => evt.type === 'result').length, 1)
  await b.gui.reloadSkills(b.paneId)
  b.line(catalog)
  b.line({ ...receipt(), parent_tool_use_id: 'child' })
  assert.equal(b.events.some(evt => evt.type === 'command-output'), false)
  b.line(receipt())
  assert.equal(b.events.filter(evt => evt.type === 'command-output').length, 1)
})

test('catalog evidence expires and a normal result cannot lend its catalog signal to a later result', () => {
  const expired = new GuiClaudeSkillReload(0)
  expired.observe(catalog, GUI_SKILL_RELOAD_TTL_MS - 1)
  assert.equal(expired.observe(receipt(), GUI_SKILL_RELOAD_TTL_MS), undefined)
  const tracker = new GuiClaudeSkillReload(0)
  tracker.observe(catalog, 1)
  assert.equal(tracker.observe(finalFrame(), 2), undefined)
  assert.equal(tracker.observe(receipt(), 3), undefined)
  tracker.observe(catalog, 4)
  assert.deepEqual(tracker.observe(receipt(), 5), { text: 'Catálogo atualizado pelo CLI.', isError: false })
  tracker.observe(catalog, 6)
  assert.equal(tracker.observe(receipt(), 7), undefined, 'one request has at most one receipt')
})

test('a failed command write permits retry, and a confirmed command error cannot finish the agent', async t => {
  const b = bench(t)
  b.start()
  const generation = b.session.activeTurnGeneration
  b.session.write = () => { throw new Error('synthetic write failure') }
  assert.equal((await b.gui.reloadSkills(b.paneId)).ok, false)
  assert.equal(b.session.activeTurnGeneration, generation)
  b.session.write = frame => b.writes.push(frame)
  assert.equal((await b.gui.reloadSkills(b.paneId)).ok, true)
  b.line(catalog)
  b.line({ ...receipt(), is_error: true, result: 'Falha sintética no catálogo.' })
  assert.ok(b.events.some(evt => evt.type === 'command-output' && evt.text.includes('não recarregou')))
  assert.equal(b.session.activeTurnGeneration, generation)
  assert.equal(b.pane().status, 'working')
  speak(b)
  b.line(finalFrame())
  assertNormalAnswer(b)
})

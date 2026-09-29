import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import test from 'node:test'
import { GuiSessionRegistry, isGuiPersistedEvent } from '../.tmp/gui-sessions-test/main/guiSessions.js'
import { CodexSession } from '../.tmp/gui-sessions-test/main/codexSession.js'
import { GuiCodexAgentRegistry } from '../.tmp/gui-sessions-test/main/guiCodexAgents.js'
import { GuiHelperInbox } from '../.tmp/gui-sessions-test/main/guiHelperCards.js'
import { GuiOwnerMailbox } from '../.tmp/gui-sessions-test/main/guiOwnerMail.js'

const drain = () => new Promise(resolve => setImmediate(resolve))
const failed = { type: 'result', isError: true, outcome: 'failed', turnId: 'failed-turn', errorText: 'Falha sintética.' }
const completed = { type: 'result', isError: false, outcome: 'completed', turnId: 'later-turn' }

function bench(t, { store = false, identity = true, cli = 'codex' } = {}) {
  const root = mkdtempSync(resolve('.tmp/gui-turn-recovery-'))
  const paneId = 'gui-recovery-synthetic', sent = [], pushed = [], sessions = []
  const ownerMail = new GuiOwnerMailbox(), helperInbox = new GuiHelperInbox()
  const storeFile = store ? join(root, 'sessions.json') : undefined
  const gui = new GuiSessionRegistry({
    push: payload => pushed.push(payload.evt), systemPromptFile: () => undefined,
    ownerMail, helperInbox, helperWakeTimer: () => () => {}, ...(storeFile ? { storeFile } : {})
  })
  const spawn = { paneId, projectId: 'synthetic', cli, configDir: root, cwd: root,
    seatId: 'synthetic-seat', model: 'synthetic-model', effort: 'high', permissionMode: 'plan', fast: true,
    resumeSessionId: 'codex-thread:same-thread' }
  let emit
  gui.spawnSession = (input, sink) => {
    emit = sink
    const session = Object.create(CodexSession.prototype)
    Object.assign(session, {
      opts: { cwd: input.cwd, configDir: input.configDir, model: input.model, effort: input.effort,
        sandbox: 'read-only', approvalPolicy: 'untrusted', serviceTier: 'priority' },
      killed: false, closed: false, starting: false, child: { exitCode: null, signalCode: null },
      threadId: 'same-thread', turnId: null, pendingTurnStart: null, pendingSendOperations: new Set(),
      activeCollabParentIds: new Set(), codexAgents: new GuiCodexAgentRegistry(), deferredCollabResult: null,
      caps: { commands: [], models: ['synthetic-model', 'other-model'].map(value =>
        ({ value, displayName: value, supportedEffortLevels: ['high', 'low'] })) },
      send(text, tag) { sent.push({ text, tag, session, thread: session.threadId, opts: { ...session.opts } }) },
      interrupt() { return false }, kill() { session.killed = true }
    })
    sessions.push(session)
    if (identity) sink({ type: 'session-id', sessionId: 'codex-thread:same-thread' })
    return session
  }
  assert.equal(gui.create(spawn).ok, true)
  t.after(() => {
    gui.killAll()
    assert.ok(root.startsWith(resolve('.tmp') + sep))
    rmSync(root, { recursive: true, force: true })
  })
  const events = () => gui.state(paneId).events.map(({ evt }) => evt)
  return { gui, paneId, spawn, root, storeFile, sent, pushed, sessions, ownerMail, helperInbox, events,
    get session() { return sessions.at(-1) }, emit: evt => emit(evt),
    async fail(patch = {}) {
      emit({ ...failed, ...patch }); await drain()
      return pushed.filter(evt => evt.type === 'result').at(-1)?.recoveryToken
    },
    resume(token) { return gui.resumeFailedTurn(paneId, token) }
  }
}

function refused(b, token, pattern) {
  const count = b.sent.length, generations = b.sessions.length
  const result = b.resume(token)
  assert.equal(result.ok, false)
  assert.match(result.error, pattern ?? /.+/u)
  assert.equal(b.sent.length, count, 'recusa não envia texto')
  assert.equal(b.sessions.length, generations, 'recusa nunca recria a conversa')
}

test('confirmed failed turn publishes one-shot authority and continues only on the same executor/thread', async t => {
  const b = bench(t)
  const attachment = { id: 'synthetic-attachment', name: 'source.txt', kind: 'text', bytes: 1 }
  b.emit({ type: 'user-message', id: 'original', text: 'PROMPT ORIGINAL', attachments: [attachment], at: 1 })
  const receipt = { type: 'tool-result', toolUseId: 'completed-tool', text: 'recibo sintético concluído', isError: false, outcome: 'completed' }
  b.emit({ type: 'tool', name: 'Write', toolUseId: 'completed-tool', input: { content: 'synthetic' } })
  b.emit(receipt)
  const token = await b.fail()
  assert.equal(typeof token, 'string', 'terminal failed deve publicar autoridade opaca')
  assert.ok(token.length >= 32)
  assert.equal(b.sent.length, 0, 'nenhuma retomada automática')
  const session = b.session, options = { ...session.opts }, before = b.events()
  assert.equal(b.gui.create(b.spawn).ok, true, 'remontagem idêntica conserva a entrada')
  assert.equal(b.events().at(-1).recoveryToken, token)
  assert.equal(b.resume(token).ok, true)
  assert.equal(b.sent.length, 1)
  assert.equal(b.sessions.length, 1)
  assert.equal(b.sent[0].session, session)
  assert.equal(b.sent[0].thread, 'same-thread')
  assert.deepEqual(b.sent[0].opts, options)
  assert.equal(b.sent[0].tag, undefined)
  assert.doesNotMatch(b.sent[0].text, /PROMPT ORIGINAL|source\.txt|completed-tool|Falha sintética/u)
  assert.match(b.sent[0].text, /histórico/iu)
  assert.match(b.sent[0].text, /estado/iu)
  assert.match(b.sent[0].text, /recibos/iu)
  assert.match(b.sent[0].text, /concluíd/iu)
  assert.equal(b.events().filter(evt => evt.type === 'user-message').length, 1, 'não inventa bolha do dono')
  assert.deepEqual(b.events().find(evt => evt.type === 'tool-result'), receipt)
  assert.deepEqual(before.find(evt => evt.type === 'tool'), b.events().find(evt => evt.type === 'tool'))
  assert.equal(b.events().some(evt => evt.recoveryToken !== undefined), false)
  refused(b, token, /expirou|utilizada|disponível/iu)
})

test('tokens are opaque, scoped to the current entry and reject untrusted input', async t => {
  const b = bench(t), token = await b.fail()
  assert.equal(typeof token, 'string')
  for (const invalid of [undefined, null, 12, {}, [], '', 'forged-token', 'x'.repeat(300)]) refused(b, invalid)
  assert.equal(b.gui.resumeFailedTurn('other-pane', token).ok, false)
  assert.equal(b.resume(token).ok, true)
  b.emit({ type: 'turn-started' })
  const next = await b.fail({ turnId: 'next-failed-turn' })
  assert.equal(typeof next, 'string')
  assert.notEqual(next, token)
  refused(b, token)
  assert.equal(b.resume(next).ok, true)
  const count = b.sent.length
  await b.fail({ turnId: 'next-failed-turn' })
  assert.equal(b.events().at(-1).recoveryToken, undefined, 'terminal duplicado não renova token consumido')
  assert.equal(b.sent.length, count)
})

for (const patch of [
  { outcome: 'completed', isError: false }, { outcome: 'cancelled', interrupted: true },
  { outcome: undefined }, { turnId: undefined }, { turnId: '' }, { continues: true }
]) test(`nonrecoverable terminal ${JSON.stringify(patch)} never grants authority`, async t => {
  const b = bench(t)
  assert.equal(await b.fail(patch), undefined)
  refused(b, 'forged-token')
})

for (const field of ['turnId', 'pendingTurnStart', 'pendingSendOperations', 'activeCollabParentIds', 'deferredCollabResult']) {
  test(`canonical Codex busy state ${field} refuses recovery`, async t => {
    const b = bench(t), token = await b.fail()
    b.session[field] = field.endsWith('Ids') || field === 'pendingSendOperations' ? new Set(['synthetic-pending']) : 'synthetic-active'
    assert.equal(b.session.turnActive, true)
    refused(b, token, /resposta|turno|aguarde/iu)
    assert.equal(b.events().some(evt => evt.recoveryToken), false)
    b.session[field] = field.endsWith('Ids') || field === 'pendingSendOperations' ? new Set() : null
    assert.equal(b.resume(token).ok, true, 'recusa temporária conserva autoridade na mesma identidade')
  })
}

test('temporary registry operations and pending deliveries retain authority until they clear', async t => {
  for (const blocker of ['executor', 'queue', 'helper-mail', 'owner-mail']) {
    const b = bench(t), token = await b.fail(), entry = b.gui.panes.get(b.paneId)
    if (blocker === 'executor') b.gui.executorChanges.add(entry)
    if (blocker === 'queue') b.gui.queuedDeliveries.set(b.paneId, { id: 'pending', token: Symbol(), promise: Promise.resolve() })
    if (blocker === 'helper-mail') b.helperInbox.post(b.paneId, { helperId: 'pending', state: 'done', model: 'synthetic' })
    if (blocker === 'owner-mail') b.ownerMail.post(b.paneId, { messageId: 'pending', text: 'Sintético' })
    refused(b, token)
    if (blocker === 'executor') b.gui.executorChanges.delete(entry)
    if (blocker === 'queue') b.gui.queuedDeliveries.delete(b.paneId)
    if (blocker === 'helper-mail') b.helperInbox.drain(b.paneId)
    if (blocker === 'owner-mail') b.ownerMail.drain(b.paneId)
    assert.equal(b.resume(token).ok, true)
    refused(b, token)
  }
})

for (const field of ['model', 'effort', 'seatId', 'configDir', 'permissionMode', 'fast', 'cwd']) {
  test(`changed spawn ${field} invalidates the failed-turn executor`, async t => {
    const b = bench(t), token = await b.fail()
    b.gui.panes.get(b.paneId).spawn[field] = field === 'fast' ? false : 'changed-synthetic'
    refused(b, token, /conversa|configuração|executor|identidade/iu)
  })
}
for (const field of ['model', 'effort', 'sandbox', 'approvalPolicy', 'serviceTier', 'configDir', 'cwd']) {
  test(`changed engine option ${field} refuses recovery`, async t => {
    const b = bench(t), token = await b.fail()
    b.session.opts[field] = 'changed-synthetic'
    refused(b, token)
  })
}

test('async executor ACK revokes authority even when the change is refused or later reverted', async t => {
  const b = bench(t), token = await b.fail()
  let acknowledge
  b.session.setExecutor = () => new Promise(resolve => { acknowledge = resolve })
  const pending = b.gui.configureExecutor(b.paneId, { model: 'other-model' })
  refused(b, token, /troca|expirou|disponível/iu)
  acknowledge(false)
  assert.equal((await pending).ok, false)
  refused(b, token)
  assert.equal(b.events().some(evt => evt.recoveryToken), false)
})

test('queued delivery lock rejects recovery before its asynchronous work starts', async t => {
  const b = bench(t), token = await b.fail()
  const pending = b.gui.deliverQueued(b.paneId, { id: 'queued-owner', text: 'NOVA MENSAGEM', at: Date.now(), attachments: [], options: {
    permissionMode: 'plan', model: 'synthetic-model', effort: 'high'
  } })
  refused(b, token, /fila|expirou|disponível/iu)
  assert.equal((await pending).ok, true)
  refused(b, token)
  assert.deepEqual(b.sent.map(item => item.text), ['NOVA MENSAGEM'])
})

for (const event of [
  { type: 'turn-started' }, { type: 'turn-retry', turnId: 'failed-turn', text: 'Tentando novamente.' },
  { type: 'conversation-cleared' }, { type: 'executor-changed', model: 'other', effort: 'low' },
  { type: 'session-id', sessionId: 'codex-thread:other-thread' }, { type: 'fatal', text: 'Falha sintética.' },
  { type: 'closed', code: 1 }, completed
]) test(`boundary ${event.type} invalidates previous failure and late duplicate cannot revive it`, async t => {
  const b = bench(t), token = await b.fail()
  b.emit(event)
  refused(b, token)
  assert.equal(await b.fail(), undefined)
  assert.equal(b.events().some(evt => evt.recoveryToken), false)
})

test('accepted owner send, idle interruption and entry replacement revoke failed authority', async t => {
  for (const change of ['send', 'interrupt', 'replace']) {
    const b = bench(t), token = await b.fail()
    if (change === 'send') assert.equal(b.gui.send(b.paneId, 'Nova orientação.', 'new-owner').ok, true)
    else if (change === 'interrupt') assert.equal(b.gui.interrupt(b.paneId).ok, true)
    else assert.equal(b.gui.create({ ...b.spawn, fast: false }).ok, true)
    refused(b, token)
  }
})

test('a successful terminal for the same turn supersedes the previous failure', async t => {
  const b = bench(t), token = await b.fail()
  b.emit({ ...completed, turnId: failed.turnId })
  refused(b, token)
  assert.equal(b.events().some(evt => evt.recoveryToken), false)
})

test('dead or unconfirmed identity safely refuses without reconnecting', async t => {
  for (const change of ['dead', 'lost', 'no-live-id', 'claude']) {
    const b = bench(t, { identity: change !== 'no-live-id', cli: change === 'claude' ? 'claude' : 'codex' })
    const token = await b.fail()
    if (change === 'dead') b.session.killed = true
    if (change === 'lost') delete b.gui.doc.panes[b.paneId].sessionId
    refused(b, token)
    assert.equal(b.events().some(evt => evt.recoveryToken), false)
  }
})

test('blocking interactions and pending owner/helper deliveries reject recovery', async t => {
  const blockers = [
    b => b.emit({ type: 'question', requestId: 'q', questions: [{ id: 'q', question: 'Sintética?', options: [] }] }),
    b => b.emit({ type: 'permission', requestId: 'p', toolName: 'Write', description: 'Sintética', inputPretty: '{}', canAlways: false }),
    b => b.emit({ type: 'plan-review', requestId: 'p', plan: 'Sintético' }),
    b => b.ownerMail.post(b.paneId, { messageId: 'pending-owner', text: 'Orientação pendente.' }),
    b => b.helperInbox.post(b.paneId, { helperId: 'pending-helper', state: 'done', name: 'Sintético', model: 'synthetic' }),
    b => { b.gui.beginHelperBatch(b.paneId); b.gui.noteHelperChange({ kind: 'spawned', record: {
      helperId: 'live-helper', delegatorPaneId: b.paneId, projectId: 'synthetic', name: 'Sintético',
      cli: 'codex', model: 'synthetic', prompt: 'Sintético', state: 'working', startedAt: 1
    } }) },
    b => b.gui.pendingIntegrationRecovery.set(b.paneId, b.gui.panes.get(b.paneId).token)
  ]
  for (const block of blockers) {
    const b = bench(t), token = await b.fail()
    block(b); refused(b, token)
    assert.equal(b.events().some(evt => evt.recoveryToken), false)
  }
})

test('deferred failed terminal cannot grant authority after a new send in the same chunk', async t => {
  const b = bench(t)
  b.emit({ type: 'tool', name: 'Read', toolUseId: 't', input: {} })
  b.emit(failed)
  assert.equal(b.gui.send(b.paneId, 'Nova orientação.', 'new-owner').ok, true)
  b.emit({ type: 'tool-result', toolUseId: 't', text: 'Sintético', isError: false })
  await drain()
  assert.equal(b.events().some(evt => evt.recoveryToken), false)
})

test('replay validates additive fields and never restores token authority from disk', async t => {
  assert.equal(isGuiPersistedEvent({ ...failed, recoveryToken: 'opaque-synthetic-token' }), true)
  assert.equal(isGuiPersistedEvent({ type: 'turn-retry', turnId: 't', text: 'Tentando novamente.' }), true)
  for (const patch of [{ turnId: 7 }, { turnId: '' }, { recoveryToken: {} }, { recoveryToken: '' }, { recoveryToken: 'x'.repeat(300) }]) {
    assert.equal(isGuiPersistedEvent({ ...failed, ...patch }), false)
  }
  for (const event of [{ type: 'turn-retry', text: 'Faltou ID.' }, { type: 'turn-retry', turnId: 't', text: 7 }]) {
    assert.equal(isGuiPersistedEvent(event), false)
  }
  const b = bench(t, { store: true }), token = await b.fail()
  assert.equal(typeof token, 'string')
  const persisted = JSON.parse(readFileSync(b.storeFile, 'utf8'))
  assert.equal(persisted.transcripts[b.paneId].events.some(evt => evt.recoveryToken), false, 'autoridade efêmera nunca é gravada')
  persisted.transcripts[b.paneId].events.at(-1).recoveryToken = token
  writeFileSync(b.storeFile, JSON.stringify(persisted))
  const restored = new GuiSessionRegistry({ storeFile: b.storeFile, push() {}, systemPromptFile: () => undefined })
  refused({ ...b, gui: restored, resume: token => restored.resumeFailedTurn(b.paneId, token) }, token)
  assert.equal(restored.state(b.paneId).events.some(({ evt }) => evt.recoveryToken), false)
  assert.equal(JSON.parse(readFileSync(b.storeFile, 'utf8')).transcripts[b.paneId].events.some(evt => evt.recoveryToken), false)
  assert.equal(b.resume(token).ok, true)
  assert.equal(JSON.parse(readFileSync(b.storeFile, 'utf8')).transcripts[b.paneId].events.some(evt => evt.recoveryToken), false)
})

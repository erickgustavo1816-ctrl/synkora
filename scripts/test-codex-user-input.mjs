import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexSession } from '../.tmp/gui-sessions-test/main/codexSession.js'
import { GuiEventRing, GuiSessionRegistry, isGuiPersistedEvent } from '../.tmp/gui-sessions-test/main/guiSessions.js'

const questions = [
  { id: 'direction', header: 'Caminho', question: 'Qual caminho?', isOther: true,
    options: [{ label: 'A', description: 'Primeira opção' }, { label: 'B', description: 'Segunda opção' }] }
]
const params = (extra = {}) => ({
  threadId: 'root', turnId: 'turn', itemId: 'item', isBlocking: true, questions, ...extra
})
function bench() {
  const session = Object.create(CodexSession.prototype)
  const events = [], replies = []
  Object.assign(session, {
    opts: { cwd: '/synthetic', idleTimeoutMs: 0, interactiveQuestions: true }, threadId: 'root', turnId: 'turn',
    killed: false, closed: false, child: { exitCode: 0, signalCode: null },
    approvals: new Map(), pendingTurnStart: null, codexAgents: { has: () => false },
    emit: e => events.push(e), respond: (id, result) => replies.push({ id, result })
  })
  return { session, events, replies, ask: (p = params(), id = 7) =>
    session.handleServerRequest(id, 'item/tool/requestUserInput', p) }
}

test('Codex aguarda a escolha e correlaciona a resposta por id, uma única vez', () => {
  const b = bench()
  b.ask()
  assert.deepEqual(b.replies, [], 'o pedido não pode ser recusado ou respondido automaticamente')
  assert.equal(b.events[0].type, 'question')
  assert.equal(b.events[0].questions[0].id, 'direction')
  assert.equal(b.events[0].questions[0].allowCustom, true)
  assert.equal(b.session.turnSilenceTimer ?? null, null, 'espera humana suspende o watchdog')
  assert.equal(b.session.answerQuestion('rpc-7', { direction: 'B' }), true)
  assert.deepEqual(b.replies, [{ id: 7, result: { answers: { direction: { answers: ['B'] } } } }])
  assert.equal(b.session.answerQuestion('rpc-7', { direction: 'A' }), false)
  b.session.clearTurnSilence()
})

test('perguntas com texto igual conservam IDs distintos e aceitam resposta livre', () => {
  const b = bench()
  b.ask(params({ questions: [questions[0], { id: 'detail', header: 'Detalhe',
    question: 'Qual caminho?', options: null, isOther: true }] }))
  assert.equal(b.events[0].type, 'question')
  assert.equal(b.events[0].questions[1].options.length, 0)
  assert.equal(b.session.answerQuestion('rpc-7', { direction: 'A', detail: 'meu caminho' }), true)
  assert.deepEqual(b.replies[0].result, { answers: {
    direction: { answers: ['A'] }, detail: { answers: ['meu caminho'] }
  } })
  b.session.clearTurnSilence()
})

test('pergunta opcional não suspende o turno nem ganha uma escolha automática', () => {
  const b = bench()
  b.ask(params({ isBlocking: false, autoResolutionMs: 1 }))
  assert.equal(b.events[0].type, 'question')
  assert.equal(b.events[0].blocking, false)
  assert.deepEqual(b.replies, [])
  assert.ok(b.session.turnSilenceTimer)
  b.session.clearTurnSilence()
})

test('pular é mapa vazio; IDs de resposta desconhecidos não consomem a pergunta', () => {
  const b = bench()
  b.ask()
  assert.equal(b.session.answerQuestion('rpc-7', { invented: 'A' }), false)
  assert.deepEqual(b.replies, [])
  assert.equal(b.session.answerQuestion('rpc-7', {}), true)
  assert.deepEqual(b.replies, [{ id: 7, result: { answers: {} } }])
  b.session.clearTurnSilence()
})

test('pedido resolvido pelo servidor fecha só a pergunta correspondente', () => {
  const b = bench()
  b.ask()
  b.session.handleNotification('serverRequest/resolved', { threadId: 'other', requestId: 7 })
  assert.equal(b.events.filter(e => e.type === 'permission-cancel').length, 0)
  b.session.handleNotification('serverRequest/resolved', { threadId: 'root', requestId: 7 })
  assert.deepEqual(b.events.at(-1), { type: 'permission-cancel', requestId: 'rpc-7' })
  assert.equal(b.session.answerQuestion('rpc-7', { direction: 'A' }), false)
  assert.deepEqual(b.replies, [])
  b.session.clearTurnSilence()
})

test('interrupção cancela perguntas sem reaproveitar respostas em turno novo', () => {
  const b = bench()
  b.ask()
  b.session.cancelPendingInteractions()
  assert.deepEqual(b.events.at(-1), { type: 'permission-cancel', requestId: 'rpc-7' })
  assert.equal(b.session.answerQuestion('rpc-7', { direction: 'A' }), false)
  assert.deepEqual(b.replies, [])
})

test('payload inválido, sigiloso ou de outra thread nunca entra no cartão', () => {
  for (const p of [
    params({ threadId: 'other' }), params({ turnId: 'old' }), params({ questions: [] }),
    params({ questions: [questions[0], questions[0]] }),
    params({ questions: [{ ...questions[0], isSecret: true }] }),
    params({ questions: [{ ...questions[0], options: [{ label: '', description: '' }] }] })
  ]) {
    const b = bench()
    b.ask(p)
    assert.equal(b.events.some(e => e.type === 'question'), false)
    assert.deepEqual(b.replies, [{ id: 7, result: { answers: {} } }])
    assert.equal(b.events[0].type, 'limit')
  }
})

const asyncItem = (extra = {}) => ({
  type: 'agentMessage', id: 'call-synthetic-question', text: '',
  questions: [{ title: 'Qual direção?', options: ['Primeira', 'Segunda', 'Terceira'] }], ...extra
})
const asyncQuestion = () => ({ type: 'question', requestId: 'codex-async-call-synthetic-question',
  blocking: false, asynchronous: true, questions: [{ id: '0', question: 'Qual direção?',
    options: [{ label: 'Primeira' }, { label: 'Segunda' }, { label: 'Terceira' }], allowCustom: true }] })

test('request_user_input_async do 0.153 vira cartão por agentMessage.questions, mesmo com texto vazio', () => {
  const b = bench()
  const p = { threadId: 'root', turnId: 'turn', item: asyncItem() }
  b.session.handleNotification('item/completed', p)
  assert.deepEqual(b.events, [asyncQuestion()])
  assert.deepEqual(b.replies, [], 'pergunta assíncrona não responde RPC nem escolhe pelo dono')
  b.session.handleNotification('item/completed', p)
  assert.equal(b.events.length, 1, 'started/completed repetido não reabre a mesma pergunta')
})

test('texto de pergunta sem questions estruturado nunca vira cartão por heurística', () => {
  const b = bench()
  b.session.handleNotification('item/completed', { threadId: 'root', turnId: 'turn',
    item: asyncItem({ questions: null, text: 'Qual direção? 1. Primeira 2. Segunda' }) })
  assert.deepEqual(b.events, [{ type: 'text', text: 'Qual direção? 1. Primeira 2. Segunda' }])
})

test('perguntas async inválidas, de outro turno ou sem cartão habilitado são recusadas', () => {
  for (const p of [
    { threadId: 'other', turnId: 'turn', item: asyncItem() },
    { threadId: 'root', turnId: 'old', item: asyncItem() },
    { threadId: 'root', turnId: 'turn', item: asyncItem({ id: '' }) },
    { threadId: 'root', turnId: 'turn', item: asyncItem({ questions: [{ title: '', options: ['A'] }] }) },
    { threadId: 'root', turnId: 'turn', item: asyncItem({ questions: [{ title: 'Título', options: [7] }] }) },
    { threadId: 'root', turnId: 'turn', item: asyncItem({ questions: [{ title: 'Título', options: ['A'], isSecret: true }] }) }
  ]) {
    const b = bench()
    b.session.handleNotification('item/completed', p)
    assert.equal(b.events.some(event => event.type === 'question'), false)
  }
  const b = bench()
  b.session.opts.interactiveQuestions = false
  b.session.handleNotification('item/completed', { threadId: 'root', turnId: 'turn', item: asyncItem() })
  assert.equal(b.events.some(event => event.type === 'question'), false)
})

test('async mantém opções explicativas integrais e aceita perguntas abertas com títulos iguais', () => {
  const b = bench(), label = 'Uma explicação longa '.repeat(25)
  b.session.handleNotification('item/completed', { threadId: 'root', turnId: 'turn', item: asyncItem({
    questions: [{ title: 'Qual direção?', options: [label] }, { title: 'Qual direção?', options: null }] }) })
  const event = b.events.find(event => event.type === 'question')
  assert.equal(event.questions[0].options[0].label, label)
  assert.equal(event.questions[1].id, '1')
  assert.deepEqual(event.questions[1].options, [])
  assert.equal(event.questions[1].allowCustom, true)
})

test('somente pergunta async persiste no anel ao encerrar e retomar o turno', () => {
  const ring = new GuiEventRing()
  ring.push(asyncQuestion())
  ring.push({ type: 'question', requestId: 'rpc-7', blocking: false, questions: questions.map(q => ({
    id: q.id, header: q.header, question: q.question, options: q.options, allowCustom: true
  })) })
  ring.push({ type: 'result', isError: false })
  ring.push({ type: 'closed', code: 0 })
  ring.push({ type: 'session-restarted', ready: true, resumed: true })
  assert.deepEqual(ring.pendingIdsOfType('question'), [asyncQuestion().requestId])
  assert.equal(isGuiPersistedEvent(asyncQuestion()), true)
  assert.equal(isGuiPersistedEvent({ ...asyncQuestion(), asynchronous: 'yes' }), false)
  const replay = new GuiEventRing()
  for (const event of JSON.parse(JSON.stringify(ring.snapshot()))) {
    if (isGuiPersistedEvent(event)) replay.push(event)
  }
  assert.deepEqual(replay.pendingIdsOfType('question'), [asyncQuestion().requestId],
    'hidratação da fotografia conserva o card sem depender de um RPC vivo')
})

test('pergunta async não atravessa troca de identidade da conversa', () => {
  const ring = new GuiEventRing()
  ring.push({ type: 'session-id', sessionId: 'codex-thread:old' })
  ring.push(asyncQuestion())
  ring.push({ type: 'session-id', sessionId: 'codex-thread:old' })
  assert.equal(ring.pendingIdsOfType('question').length, 1)
  ring.push({ type: 'session-id', sessionId: 'codex-thread:new' })
  assert.deepEqual(ring.pendingIdsOfType('question'), [])
})

function asyncRegistry() {
  const registry = new GuiSessionRegistry({ push() {}, systemPromptFile: () => undefined })
  const ring = new GuiEventRing(), sent = []
  ring.push(asyncQuestion())
  const session = { alive: true, turnActive: false, send: text => sent.push(text),
    answerQuestion() { throw new Error('async não usa o RPC de pergunta bloqueante') } }
  registry.panes.set('p-async', { spawn: { paneId: 'p-async', projectId: 'project', cli: 'codex',
    cwd: '/synthetic', configDir: '/synthetic-seat' }, session, ring, token: { alive: true },
    sink: event => ring.push(event) })
  return { registry, ring, sent, session }
}

test('resposta async segue envio normal com um recibo, IDs validados e entrega única', () => {
  const b = asyncRegistry(), requestId = asyncQuestion().requestId
  assert.equal(b.registry.answerQuestion('p-async', requestId, { invented: 'Primeira' }).ok, false)
  assert.deepEqual(b.ring.pendingIdsOfType('question'), [requestId])
  assert.deepEqual(b.registry.answerQuestion('p-async', requestId, { 0: 'Uma direção própria' }), { ok: true })
  assert.equal(b.sent.length, 1)
  assert.match(b.sent[0], /Qual direção\?/u)
  assert.match(b.sent[0], /Uma direção própria/u)
  const events = b.ring.snapshot()
  assert.equal(events.filter(e => e.type === 'user-message').length, 1)
  assert.equal(events.filter(e => e.type === 'turn-started').length, 1)
  const receipt = events.find(e => e.type === 'interaction-resolved')
  assert.equal(receipt.resolution.messageId, events.find(e => e.type === 'user-message').id)
  assert.deepEqual(b.ring.pendingIdsOfType('question'), [])
  assert.equal(b.registry.answerQuestion('p-async', requestId, { 0: 'Segunda' }).ok, false)
  assert.equal(b.sent.length, 1)
})

test('falha no envio async preserva cartão para tentar de novo; pular não fabrica escolha', () => {
  const b = asyncRegistry(), requestId = asyncQuestion().requestId
  b.session.alive = false
  const failed = b.registry.answerQuestion('p-async', requestId, { 0: 'Primeira' })
  assert.equal(failed.ok, false)
  assert.equal(failed.retryable, true)
  assert.deepEqual(b.ring.pendingIdsOfType('question'), [requestId])
  assert.deepEqual(b.sent, [])
  b.session.alive = true
  assert.equal(b.registry.answerQuestion('p-async', requestId, {}).ok, true)
  assert.equal(b.sent.length, 1)
  assert.match(b.sent[0], /pulou/u)
  assert.doesNotMatch(b.sent[0], /Primeira|Segunda|Terceira/u)
})

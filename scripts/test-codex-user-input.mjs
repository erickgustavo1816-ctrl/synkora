import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexSession } from '../.tmp/gui-sessions-test/codexSession.js'

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

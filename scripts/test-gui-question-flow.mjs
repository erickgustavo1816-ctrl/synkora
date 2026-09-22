import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

// O reducer e o cartão reais, com DOM sintético e sem IPC/processo do usuário.
const compiled = buildSync({ stdin: { contents: `
  export { EMPTY_GUI_PANE, applyGuiEvent } from './src/renderer/src/store';
  export { guiThinkingPresentation } from './src/renderer/src/guiThinkingPresentation';
  export { default as Card } from './src/renderer/src/components/GuiQuestionCard';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node',
  // O cartão de plano puxa o GuiMarkdown, que precisa de um DOM real (DOMPurify,
  // <template>) — fora do alcance deste DOM sintético. Ele fica EXTERNO ao
  // bundle e o `require` abaixo entrega um dublê que só ecoa o texto; o
  // markdown de verdade tem suíte própria num browser real.
  format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'zustand', '*/GuiMarkdown'] })
const loaded = { exports: {} }
const realRequire = createRequire(import.meta.url)
const markdownStub = { __esModule: true, default: ({ text }) => React.createElement('div', { 'data-markdown-stub': 'true' }, text) }
const requireWithStubs = (id) => /GuiMarkdown$/u.test(id) ? markdownStub : realRequire(id)
new Function('require', 'module', 'exports', 'document', 'window', 'HTMLInputElement', compiled.outputFiles[0].text)(
  requireWithStubs, loaded, loaded.exports,
  { documentElement: { style: { setProperty() {} } } }, { setTimeout }, class {}
)
const { EMPTY_GUI_PANE, applyGuiEvent, guiThinkingPresentation, Card } = loaded.exports
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const question = { id: 'choice', question: 'Qual caminho?', header: 'Caminho',
  options: [{ label: 'A' }, { label: 'B' }], allowCustom: false }

test('compactação aparece durante o trabalho, sobrevive ao replay e limpa no término', () => {
  const events = [{ type: 'turn-started' }, { type: 'thinking', text: 'synthetic private reasoning' },
    { type: 'context-compaction', active: true }]
  const presentation = state => guiThinkingPresentation({ ...state, awaitingInteraction: false })
  const state = events.reduce(applyGuiEvent, { ...EMPTY_GUI_PANE })
  assert.equal(presentation(state)?.label, 'Compactando contexto…')
  assert.equal(presentation(events.reduce(applyGuiEvent, { ...EMPTY_GUI_PANE }))?.label, 'Compactando contexto…')
  assert.equal(presentation(applyGuiEvent(state, { type: 'command-completed', isError: false, continues: false }))?.label,
    'Compactando contexto…', 'aceite do comando não encerra a compactação')
  assert.notEqual(presentation(applyGuiEvent(state, { type: 'context-compaction', active: false }))?.label, 'Compactando contexto…')
  for (const event of [
    { type: 'result', isError: false }, { type: 'result', isError: true, errorText: 'synthetic failure' },
    { type: 'result', isError: false, interrupted: true }, { type: 'closed', code: 0 },
    { type: 'fatal', text: 'synthetic failure' }, { type: 'session-restarted', ready: true, resumed: true },
    { type: 'conversation-cleared' }, { type: 'turn-started' }
  ]) {
    const next = applyGuiEvent(state, event)
    assert.equal(next.contextCompacting, false, event.type)
    assert.notEqual(presentation(next)?.label, 'Compactando contexto…', event.type)
  }
})

test('pergunta bloqueante espera o dono; pergunta opcional mantém stream e trabalho', () => {
  for (const blocking of [true, false]) {
    let state = applyGuiEvent({ ...EMPTY_GUI_PANE }, { type: 'delta', text: 'texto sintético' })
    state = applyGuiEvent(state, { type: 'question', requestId: 'rpc-7', questions: [question], blocking })
    assert.equal(state.status, blocking ? 'waiting-you' : 'working')
    assert.equal(Boolean(state.stream), !blocking)
    state = applyGuiEvent(state, { type: 'delta', text: ' continuação' })
    assert.equal(state.status, blocking ? 'waiting-you' : 'working')
    state = applyGuiEvent(state, { type: 'permission-cancel', requestId: 'rpc-7' })
    assert.equal(state.question, null)
    assert.equal(state.status, 'working')
  }
})

test('comando antigo ainda pendente não esconde a atividade após outra ferramenta terminar', () => {
  let state = { ...EMPTY_GUI_PANE }
  for (const event of [
    { type: 'turn-started' },
    { type: 'tool', name: 'Bash', toolUseId: 'background', input: {} },
    { type: 'tool', name: 'Read', toolUseId: 'foreground', input: {} },
    { type: 'tool-result', toolUseId: 'foreground', text: 'ok', isError: false }
  ]) state = applyGuiEvent(state, event)
  assert.equal(state.activityText, 'Bash')
  assert.equal(guiThinkingPresentation({ ...state, awaitingInteraction: false }).label,
    'aguardando retorno da ferramenta')
  state = applyGuiEvent(state, { type: 'result', isError: false, outcome: 'cancelled', interrupted: true })
  assert.equal(guiThinkingPresentation({ ...state, awaitingInteraction: false }), null)
})

function button(card, label) {
  return card.root.findAllByType('button').find(b => b.children.includes(label))
}

test('aprovação estruturada responde sim ou não com um clique e conserva a pergunta', async () => {
  for (const label of ['Aprovar', 'Não aprovar']) {
    let card
    const answers = []
    const approval = { id: 'scope', header: 'Aprovação', question: 'Aprova alterar a tela de projetos?',
      options: [{ label: 'Aprovar' }, { label: 'Não aprovar' }], allowCustom: true }
    await act(async () => { card = create(React.createElement(Card, { questions: [approval],
      onAnswer: answer => { answers.push({ ...answer }) }, onSkip() {} })) })
    try {
      assert.equal(answers.length, 0, 'mostrar a pergunta nunca aprova')
      const choice = card.root.findAllByType('button').find(b => b.props['aria-label'] === label)
      assert.ok(choice, 'a opção deve ser um botão de resposta direta')
      await act(async () => choice.props.onClick())
      assert.deepEqual(answers, [{ scope: label }])
      assert.equal(button(card, 'responder'), undefined, 'não exige um segundo clique')
    } finally { await act(async () => card.unmount()) }
  }
})

test('aprovação permite ajuste livre e respeita envio pendente', async () => {
  let card
  const answers = []
  const approval = { ...question, allowCustom: true }
  const props = { questions: [approval], onAnswer: answer => { answers.push({ ...answer }) }, onSkip() {} }
  await act(async () => { card = create(React.createElement(Card, props)) })
  try {
    await act(async () => button(card, 'outra resposta…').props.onClick())
    const input = card.root.findByProps({ className: 'gq-custom' })
    await act(async () => input.props.onChange({ target: { value: 'Pode seguir somente na tela de projetos.' } }))
    await act(async () => button(card, 'responder').props.onClick())
    assert.deepEqual(answers, [{ choice: 'Pode seguir somente na tela de projetos.' }])
    await act(async () => card.update(React.createElement(Card, { ...props, disabled: true })))
    assert.ok(card.root.findAllByType('button').every(b => b.props.disabled))
    const choice = card.root.findAllByType('button').find(b => b.props['aria-label'] === 'B')
    await act(async () => choice.props.onClick())
    assert.equal(answers.length, 1)
  } finally { await act(async () => card.unmount()) }
})

test('cartão devolve IDs distintos para perguntas iguais e texto livre sem opções', async () => {
  let card, answer
  await act(async () => { card = create(React.createElement(Card, { questions: [question,
    { id: 'detail', question: question.question, options: [], allowCustom: true }],
    onAnswer: value => { answer = value }, onSkip() {} })) })
  try {
    assert.equal(card.root.findAllByProps({ className: 'gq-custom' }).length, 0)
    assert.equal(card.root.findAllByProps({ className: 'gq-option other' }).length, 0)
    await act(async () => card.root.findAllByProps({ role: 'radio' })[1].props.onClick())
    await act(async () => button(card, 'próxima').props.onClick())
    const input = card.root.findByProps({ className: 'gq-custom' })
    await act(async () => input.props.onChange({ target: { value: 'caminho próprio' } }))
    await act(async () => button(card, 'responder').props.onClick())
    assert.deepEqual({ ...answer }, { choice: 'B', detail: 'caminho próprio' })
  } finally { await act(async () => card.unmount()) }
})

test('Enter sem seleção não responde nem aceita; pular continua explícito', async () => {
  let card, answered = 0, skipped = 0
  await act(async () => { card = create(React.createElement(Card, { questions: [question],
    onAnswer: () => { answered++ }, onSkip: () => { skipped++ } })) })
  try {
    await act(async () => card.root.findByProps({ className: 'gui-question' }).props.onKeyDown({
      key: 'Enter', target: {}, preventDefault() {}
    }))
    assert.equal(answered, 0)
    assert.equal(skipped, 0)
    await act(async () => button(card, 'pular').props.onClick())
    assert.equal(skipped, 1)
  } finally { await act(async () => card.unmount()) }
})

test('o cartão de plano do Synkora mostra o plano DENTRO do cartão, na variante rápida e no questionário', async () => {
  // 2026-09-22: o plano que o Claude escrevia antes do AskUserQuestion caía no
  // canal de raciocínio e o dono via "aprova o plano?" sem plano. Aqui o plano
  // é parte do pedido e o cartão o renderiza acima da pergunta.
  const plan = 'SYNTHETIC_PLAN_LINE_ONE\n\nSYNTHETIC_PLAN_LINE_TWO'
  const approval = { id: 'plan', header: 'Plano', question: 'Aprova este plano?',
    options: [{ label: 'Aprovar' }, { label: 'Não aprovar' }], allowCustom: true }
  const answers = []
  for (const questions of [[approval], [approval, question]]) {
    let card
    await act(async () => { card = create(React.createElement(Card, { paneId: 'pane-plan', plan, questions,
      onAnswer: answer => { answers.push({ ...answer }) }, onSkip() {} })) })
    try {
      const body = card.root.findByProps({ 'data-question-plan': 'true' })
      assert.ok(body, 'o corpo do plano existe no cartão')
      const text = JSON.stringify(card.toJSON())
      assert.match(text, /SYNTHETIC_PLAN_LINE_ONE/u)
      assert.match(text, /SYNTHETIC_PLAN_LINE_TWO/u)
      assert.match(text, /Aprova este plano\?/u)
      const plans = card.root.findAllByProps({ 'data-question-plan': 'true' })
      assert.equal(plans.length, 1, 'um corpo de plano por cartão')
    } finally { await act(async () => card.unmount()) }
  }
  // Pergunta comum (sem `plan`) continua sem corpo de plano.
  let plain
  await act(async () => { plain = create(React.createElement(Card, { paneId: 'pane-plan', questions: [question],
    onAnswer() {}, onSkip() {} })) })
  try {
    assert.equal(plain.root.findAllByProps({ 'data-question-plan': 'true' }).length, 0)
  } finally { await act(async () => plain.unmount()) }
})

test('cartão async sobrevive ao fim do turno e resume; resposta normal não duplica o recibo', () => {
  let state = applyGuiEvent({ ...EMPTY_GUI_PANE }, { type: 'question', requestId: 'async-7',
    questions: [question], blocking: false, asynchronous: true })
  for (const event of [
    { type: 'result', isError: false }, { type: 'closed', code: 0 },
    { type: 'session-restarted', ready: true, resumed: true },
    { type: 'turn-started' }, { type: 'delta', text: 'trabalho independente' }
  ]) state = applyGuiEvent(state, event)
  assert.equal(state.question?.requestId, 'async-7')
  assert.equal(state.interactionQueue.length, 1)
  state = applyGuiEvent(state, { type: 'user-message', id: 'answer-7', text: 'Resposta escolhida', at: 1 })
  state = applyGuiEvent(state, { type: 'interaction-resolved', requestId: 'async-7', resolution: {
    kind: 'question', entries: [{ question: 'Qual caminho?', answer: 'A' }], messageId: 'answer-7' } })
  assert.equal(state.question, null)
  assert.equal(state.items.filter(i => i.kind === 'user').length, 1)
  assert.equal(state.items.filter(i => i.kind === 'question').length, 0)
})

test('cartão async da conversa anterior sai quando o resume abre outra identidade', () => {
  let state = applyGuiEvent({ ...EMPTY_GUI_PANE }, { type: 'session-id', sessionId: 'codex-thread:old' })
  state = applyGuiEvent(state, { type: 'question', requestId: 'async-old',
    questions: [question], blocking: false, asynchronous: true })
  state = applyGuiEvent(state, { type: 'session-id', sessionId: 'codex-thread:old' })
  assert.equal(state.question?.requestId, 'async-old')
  state = applyGuiEvent(state, { type: 'session-id', sessionId: 'codex-thread:new' })
  assert.equal(state.question, null)
})

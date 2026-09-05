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
  format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'zustand'] })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'document', 'window', 'HTMLInputElement', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports,
  { documentElement: { style: { setProperty() {} } } }, { setTimeout }, class {}
)
const { EMPTY_GUI_PANE, applyGuiEvent, guiThinkingPresentation, Card } = loaded.exports
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const question = { id: 'choice', question: 'Qual caminho?', header: 'Caminho',
  options: [{ label: 'A' }, { label: 'B' }], allowCustom: false }

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

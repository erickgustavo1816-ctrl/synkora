import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

// Exercita o reducer real com eventos sintéticos: nenhum CLI, IPC ou histórico.
const compiled = buildSync({ stdin: { contents: `
  export { EMPTY_GUI_PANE, applyGuiEvent } from './src/renderer/src/store';
  export { guiToolOutcomeView, guiToolGroupOutcomeView } from './src/renderer/src/guiToolOutcome';
  export { closePendingGuiTools } from './src/renderer/src/guiTerminalTools';
  export { guiCodexToolCompletion } from './src/main/guiCodexTools';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node',
  format: 'cjs', write: false, external: ['zustand'] })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'document', 'window', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports,
  { documentElement: { style: { setProperty() {} } } }, { setTimeout }
)
const { EMPTY_GUI_PANE, applyGuiEvent, guiToolOutcomeView, guiToolGroupOutcomeView,
  closePendingGuiTools, guiCodexToolCompletion } = loaded.exports

const start = (id = 'command-1') => ({ type: 'tool', name: 'Bash', toolUseId: id, input: {} })
const terminal = { type: 'result', isError: false, outcome: 'completed' }
const receipt = (id = 'command-1', outcome = 'completed') => ({ type: 'tool-result',
  toolUseId: id, outcome, isError: outcome === 'failed', text: 'resultado sintético' })
function reduce(events, initial = { ...EMPTY_GUI_PANE }) {
  return events.reduce(applyGuiEvent, initial)
}
const toolsOf = state => state.items.filter(item => item.kind === 'tool')
const warningsOf = state => state.items.filter(item => item.transient)

test('turno encerrado sem recibo deixa resultado não confirmado, sem inventar falha ou sucesso', () => {
  const state = reduce([start(), { type: 'text', text: 'fala sintética de conclusão' }, terminal])
  const tool = toolsOf(state)[0]
  assert.equal(tool.result.status, 'unconfirmed')
  assert.equal(tool.result.isError, false)
  assert.equal(tool.result.provisional, true)
  assert.equal(state.items.some(item => item.kind === 'error'), false)
  assert.equal(warningsOf(state)[0].kind, 'note')
  assert.match(warningsOf(state)[0].text, /não confirmado/u)
  assert.deepEqual(guiToolOutcomeView(tool.result), {
    tone: 'cancel', compactLabel: 'não confirmado', statusLabel: 'não confirmado'
  })
})

test('a falta de fala final não muda a classificação estrutural de um recibo ausente', () => {
  const state = reduce([start(), terminal])
  assert.equal(toolsOf(state)[0].result.status, 'unconfirmed')
  assert.equal(state.items.some(item => item.kind === 'error'), false)
})

test('recibo tardio substitui incerteza por sucesso ou falha factual e remove só aviso transitório', () => {
  for (const outcome of ['completed', 'failed']) {
    const state = reduce([start(), terminal,
      { type: 'limit', text: 'erro real sintético independente' }, receipt('command-1', outcome)])
    assert.equal(toolsOf(state)[0].result.status, outcome)
    assert.equal(toolsOf(state)[0].result.provisional, undefined)
    assert.equal(guiToolOutcomeView(toolsOf(state)[0].result).tone, outcome === 'failed' ? 'err' : 'ok')
    assert.equal(warningsOf(state).length, 0)
    assert.equal(state.items.filter(item => item.kind === 'error').length, 1)
  }
})

test('último recibo atrasado remove o aviso: primeiro recibo não oculta a segunda lacuna', () => {
  let state = reduce([start('one'), start('two'), terminal, receipt('two')])
  assert.equal(toolsOf(state)[0].result.status, 'unconfirmed')
  assert.equal(warningsOf(state).length, 1)
  state = reduce([receipt('one')], state)
  assert.equal(warningsOf(state).length, 0)
  assert.equal(toolsOf(state).every(item => item.result.status === 'completed'), true)
})

test('replay antigo com erro provisório aceita recibo tardio e remove o aviso legado', () => {
  const old = reduce([start(), terminal])
  const initial = { ...old, items: old.items.map(item => item.kind === 'tool'
    ? { ...item, result: { ...item.result, status: 'failed', isError: true } }
    : item.transient ? { ...item, kind: 'error' } : item) }
  const state = reduce([receipt()], initial)
  assert.equal(toolsOf(state)[0].result.status, 'completed')
  assert.equal(state.items.some(item => item.kind === 'error'), false)
})

test('turno bem-sucedido com outra lacuna não apaga falha já confirmada de ferramenta', () => {
  const state = reduce([start('failed-command'), start('missing-command'),
    receipt('failed-command', 'failed'), terminal])
  assert.equal(toolsOf(state)[0].result.status, 'failed')
  assert.equal(guiToolOutcomeView(toolsOf(state)[0].result).tone, 'err')
  assert.equal(toolsOf(state)[1].result.status, 'unconfirmed')
})

test('ID desconhecido ou duplicado nunca confirma outro comando', () => {
  for (const events of [[start(), terminal, receipt('unknown')],
    [start(), start(), terminal, receipt()]]) {
    const state = reduce(events)
    assert.equal(toolsOf(state).every(item => item.result.status === 'unconfirmed'), true)
    assert.equal(warningsOf(state).length, 1)
  }
})

test('ordem inversa entre dois recibos e recibo silencioso confirmam os IDs correspondentes', () => {
  const state = reduce([start('one'), start('two'), receipt('two'),
    { ...receipt('one'), text: '' }, terminal])
  assert.equal(toolsOf(state).every(item => item.result.status === 'completed'), true)
  assert.equal(warningsOf(state).length, 0)
})

test('continuação não encerra ferramentas e interrupção pelo dono continua cancelada', () => {
  let state = reduce([start(), { ...terminal, continues: true }])
  assert.equal(toolsOf(state)[0].result, undefined)
  assert.equal(warningsOf(state).length, 0)
  state = reduce([{ ...terminal, isError: true, outcome: 'failed', interrupted: true }], state)
  assert.equal(toolsOf(state)[0].result.status, 'cancelled')
  assert.equal(state.items.some(item => item.kind === 'error'), false)
})

test('falha real do turno ou processo mantém card e banner de erro', () => {
  for (const event of [
    { ...terminal, outcome: 'failed', isError: true, errorText: 'falha sintética' },
    { type: 'fatal', text: 'falha sintética' },
    { type: 'closed', code: 2 }
  ]) {
    const state = reduce([start(), event])
    assert.equal(toolsOf(state)[0].result.status, 'failed')
    assert.equal(toolsOf(state)[0].result.isError, true)
    assert.equal(state.items.some(item => item.kind === 'error'), true)
    assert.equal(warningsOf(state).length, 0)
  }
})

test('exit code não zero e erros explícitos do Codex continuam falhando', () => {
  for (const item of [{ type: 'commandExecution', status: 'completed', exitCode: 2 },
    { type: 'mcpToolCall', error: 'falha sintética' }, { type: 'fileChange', status: 'failed' }]) {
    const completion = guiCodexToolCompletion(item)
    assert.equal(completion.outcome, 'failed')
    assert.equal(completion.isError, true)
  }
})

test('grupo preserva a incerteza; erro autoritativo ainda ganha prioridade', () => {
  const unknown = { text: '123 passed', isError: false, status: 'unconfirmed' }
  const good = { text: 'ok', isError: false, status: 'completed' }
  const bad = { text: 'falha sintética', isError: true, status: 'failed' }
  assert.equal(guiToolOutcomeView(unknown).compactLabel, 'não confirmado')
  assert.equal(guiToolGroupOutcomeView([unknown, good]).compactLabel, 'não confirmado')
  assert.equal(guiToolGroupOutcomeView([unknown, bad]).tone, 'err')
  assert.equal(guiToolOutcomeView({ ...unknown, isError: true }).tone, 'err')
})

test('pai síncrono sem recibo e descendentes não ganham conclusão inventada', () => {
  const parent = { id: 'parent', kind: 'tool', name: 'Agent', summary: '', toolUseId: 'parent', at: 1 }
  const child = { id: 'child', kind: 'tool', name: 'Bash', summary: '', toolUseId: 'child',
    parentToolUseId: 'parent', at: 2 }
  const closed = closePendingGuiTools([parent, child], terminal)
  assert.equal(closed.every(item => item.result.status === 'unconfirmed'), true)
})

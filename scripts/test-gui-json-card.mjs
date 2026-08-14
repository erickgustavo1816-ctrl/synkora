import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUI_JSON_CARD_MAX_CHARS,
  GUI_JSON_CARD_MAX_DEPTH,
  GUI_JSON_CARD_MAX_NODES,
  parseGuiJsonCard
} from '../src/renderer/src/guiJsonCard.ts'

test('JSON puro vira cartão formatado, sem perder tipos', () => {
  const card = parseGuiJsonCard('{"ok":true,"items":[1,"dois",null]}')
  assert.ok(card)
  assert.equal(card.formatted, '{\n  "ok": true,\n  "items": [\n    1,\n    "dois",\n    null\n  ]\n}')
  assert.equal(card.depth, 2)
  assert.equal(card.nodes, 6)
})

test('whitespace externo e valores JSON simples continuam sendo JSON', () => {
  assert.equal(parseGuiJsonCard('  [1, 2]\n')?.formatted, '[\n  1,\n  2\n]')
  assert.equal(parseGuiJsonCard('"uma string"')?.formatted, '"uma string"')
  assert.equal(parseGuiJsonCard('null')?.formatted, 'null')
})

test('texto misto ou JSON inválido segue no Markdown', () => {
  assert.equal(parseGuiJsonCard('Resposta:\n{"ok":true}'), null)
  assert.equal(parseGuiJsonCard('{"ok":}'), null)
  assert.equal(parseGuiJsonCard('```json\n{"ok":true}\n```'), null)
})

test('limites recusam respostas grandes, profundas ou numerosas', () => {
  assert.equal(parseGuiJsonCard('x'.repeat(GUI_JSON_CARD_MAX_CHARS + 1)), null)

  const deep = `${'{'.repeat(GUI_JSON_CARD_MAX_DEPTH + 1)}"value":1${'}'.repeat(GUI_JSON_CARD_MAX_DEPTH + 1)}`
  assert.equal(parseGuiJsonCard(deep), null)

  const many = `[${Array.from({ length: GUI_JSON_CARD_MAX_NODES }, () => '0').join(',')}]`
  assert.equal(parseGuiJsonCard(many), null)
})

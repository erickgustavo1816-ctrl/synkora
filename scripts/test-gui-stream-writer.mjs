// A ESCRITA DO CHAT — a régua pura do escritor único (mockup aprovado pelo dono
// em 2026-09-21, docs/mockups/chat-writer-2026-09-21.html).
//
// O que estas provas cercam:
// - UM escritor por conversa: o item de fala mais antigo ainda não revelado é o
//   escritor da vez; o que vem depois dele espera enquanto ele tiver texto
//   pendente na tela — e NUNCA quando não tiver (stream morto não segura card).
// - Cadência adaptativa: uma palavra por tique na base; passo maior só quando o
//   pendente estoura o atraso máximo; texto completo drena em 600 ms; nunca
//   meia palavra; velocidade 0 = tudo de uma vez.
// - As preferências do dono viram régua com faixas fechadas.
//
// Rode: node --experimental-strip-types --test scripts/test-gui-stream-writer.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  GUI_REVEAL_DRAIN_MS,
  GUI_WRITING_PACE_DEFAULT,
  guiHeldItems,
  guiPendingWords,
  guiRevealFadePlan,
  guiRevealTickMs,
  guiRevealWordsThisTick,
  guiWriterIndex,
  guiWritingPaceOf,
  nextGuiRevealShown,
  nextGuiWordEnd
} from '../src/renderer/src/guiStreamReveal.ts'

const words = (n, prefix = 'palavra') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')

test('o escritor da vez é a PRIMEIRA fala ainda não revelada, nunca a última', () => {
  const items = [
    { kind: 'user', text: 'oi' },
    { kind: 'assistant', text: 'pronta', animateFrom: 6, live: false },
    { kind: 'assistant', text: 'ainda escrevendo', animateFrom: 5, live: false },
    { kind: 'tool', text: '' },
    { kind: 'assistant', text: 'nem começou', animateFrom: 0, live: true }
  ]
  assert.equal(guiWriterIndex(items), 2)
  assert.equal(guiWriterIndex(items.slice(0, 2)), -1)
  // item vivo com tudo revelado continua sendo o escritor (esperando o delta)
  assert.equal(guiWriterIndex([{ kind: 'assistant', text: 'x', animateFrom: 1, live: true }]), 0)
})

test('com o escritor ocupado, tudo depois dele espera; sem trabalho pendente, nada é retido', () => {
  const items = [
    { kind: 'user', text: 'oi' },
    { kind: 'assistant', text: 'primeiro parágrafo', animateFrom: 3, live: false },
    { kind: 'assistant', text: 'segundo parágrafo', animateFrom: 0, live: false },
    { kind: 'tool', text: '' }
  ]
  const held = guiHeldItems(items, true)
  assert.deepEqual(held.map((item) => item.kind), ['user', 'assistant'])
  // a lista volta INTACTA (mesma referência) quando o escritor não tem pendência
  assert.equal(guiHeldItems(items, false), items)
  // escritor no fim do fio: nada a reter
  const tail = items.slice(0, 2)
  assert.equal(guiHeldItems(tail, true), tail)
  // sem escritor nenhum: lista intacta mesmo com busy (estado transitório)
  const done = [{ kind: 'assistant', text: 'ok', animateFrom: 2, live: false }, { kind: 'tool', text: '' }]
  assert.equal(guiHeldItems(done, true), done)
})

test('cadência base: uma palavra inteira por tique, com o espaço que vem depois', () => {
  // 15 palavras pendentes cabem em 750 ms na base (20/s) — abaixo do atraso
  // máximo de 1 s, então nada acelera.
  const text = words(15)
  const pace = GUI_WRITING_PACE_DEFAULT
  const tick = guiRevealTickMs(pace)
  assert.equal(tick, 50)
  let shown = 0
  for (let step = 1; step <= 5; step += 1) {
    const n = guiRevealWordsThisTick(text, shown, false, pace, tick)
    assert.equal(n, 1, `passo ${step} revelou ${n} palavras com só ${guiPendingWords(text, shown)} pendentes`)
    shown = nextGuiRevealShown(text, shown, n)
    assert.equal(text.slice(0, shown).trim().split(/\s+/u).length, step)
    assert.ok(/\s$/u.test(text.slice(0, shown)), 'o passo leva o espaço que vem depois da palavra')
  }
  assert.equal(nextGuiRevealShown(text, 0, 1), nextGuiWordEnd(text, 0))
})

test('rajada grande acelera para caber no atraso máximo — e nunca pula meia palavra', () => {
  const pace = { wordsPerSecond: 20, maxLagMs: 1000, fade: true }
  const tick = guiRevealTickMs(pace) // 50 ms → 20 tiques no teto
  const text = words(400)
  const n = guiRevealWordsThisTick(text, 0, false, pace, tick)
  assert.equal(n, 20, '400 palavras pendentes em 20 tiques = 20 por tique')
  const shown = nextGuiRevealShown(text, 0, n)
  assert.ok(/\s$/u.test(text.slice(0, shown)) || shown === text.length, 'termina no fim de uma palavra')
  assert.equal(text.slice(0, shown).trim().split(/\s+/u).length, 20)
  // pouco pendente volta à cadência base
  assert.equal(guiRevealWordsThisTick(words(10), 0, false, pace, tick), 1)
  // atraso máximo maior = passos menores para a mesma rajada
  assert.equal(guiRevealWordsThisTick(text, 0, false, { ...pace, maxLagMs: 2000 }, tick), 10)
})

test('texto completo drena em 600 ms; nada pendente = passo zero', () => {
  const pace = GUI_WRITING_PACE_DEFAULT
  const tick = guiRevealTickMs(pace)
  const text = words(120)
  const n = guiRevealWordsThisTick(text, 0, true, pace, tick)
  assert.equal(n, Math.ceil(120 / Math.floor(GUI_REVEAL_DRAIN_MS / tick)))
  assert.equal(guiRevealWordsThisTick(text, text.length, true, pace, tick), 0)
  assert.equal(nextGuiRevealShown(text, text.length, 3), text.length)
})

test('velocidade 0 é instantâneo: tudo num passo só', () => {
  const pace = { wordsPerSecond: 0, maxLagMs: 1000, fade: true }
  const text = words(57)
  assert.equal(guiRevealWordsThisTick(text, 0, false, pace), 57)
  assert.equal(nextGuiRevealShown(text, 0, 57), text.length)
  assert.equal(guiRevealTickMs(pace), 16)
})

test('as preferências do dono viram régua com faixas fechadas e padrão para o que faltar', () => {
  assert.deepEqual(guiWritingPaceOf(null), GUI_WRITING_PACE_DEFAULT)
  assert.deepEqual(guiWritingPaceOf({}), GUI_WRITING_PACE_DEFAULT)
  assert.deepEqual(
    guiWritingPaceOf({ chatWritingWordsPerSecond: 999, chatWritingMaxLagMs: 10, chatWritingFade: false }),
    { wordsPerSecond: 60, maxLagMs: 300, fade: false }
  )
  assert.deepEqual(
    guiWritingPaceOf({ chatWritingWordsPerSecond: '35', chatWritingMaxLagMs: 1499.6 }),
    { wordsPerSecond: 35, maxLagMs: 1500, fade: true }
  )
  assert.equal(guiRevealTickMs({ wordsPerSecond: 60, maxLagMs: 300, fade: true }), 17)
})

test('o plano do fade continua do valor atual: idade negativa, só os passos recentes, nunca os já assentados', () => {
  const now = 1000
  const history = [
    { words: 2, at: now - 900 }, // já assentou: fora
    { words: 1, at: now - 200 },
    { words: 3, at: now - 100 },
    { words: 1, at: now - 10 }
  ]
  assert.deepEqual(guiRevealFadePlan(history, now), [
    { words: 1, ageMs: 200 },
    { words: 3, ageMs: 100 },
    { words: 1, ageMs: 10 }
  ])
  assert.deepEqual(guiRevealFadePlan([], now), [])
})

test('cercas de forma: pintor só toca o ÚLTIMO bloco e o pane segura as decisões atrás do escritor', () => {
  const paint = readFileSync(new URL('../src/renderer/src/guiRevealPaint.ts', import.meta.url), 'utf8')
  assert.match(paint, /function lastTopBlock/u)
  assert.match(paint, /unwrapPaint\(block\)/u, 'cada pintura desfaz a anterior (idempotente)')
  assert.match(paint, /VERBATIM_TAGS = new Set\(\['PRE', 'CODE', 'TABLE'\]\)/u)
  assert.match(paint, /animationDelay = `-\$\{Math\.round\(word\.ageMs\)\}ms`/u, 'o fade continua do valor atual')
  const markdown = readFileSync(new URL('../src/renderer/src/components/GuiMarkdown.tsx', import.meta.url), 'utf8')
  assert.match(markdown, /applyGuiStableMarkdown\(container, html\)\s*\n[\s\S]*?onPaintedRef\.current\?\.\(container\)/u, 'a cauda é pintada DEPOIS do patch de prefixo estável')
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  assert.match(css, /\.gui-word-in \{\s*animation: gui-word-settle 220ms/u)
  assert.match(css, /\.gui-caret \{/u)
  assert.match(css, /\.gui-word-in,\s*\.gui-caret \{\s*animation: none;/u, 'reduzir movimento desliga fade e caret')
})

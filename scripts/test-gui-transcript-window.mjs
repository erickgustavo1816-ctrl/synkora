import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  GUI_TRANSCRIPT_INITIAL_ITEMS,
  GUI_TRANSCRIPT_PAGE_SIZE,
  GUI_TRANSCRIPT_INITIAL_PIN_MS,
  guiTranscriptAnchoredScrollTop,
  guiTranscriptInitialStart,
  guiTranscriptPageStart,
  guiTranscriptWindowRange
} from '../src/renderer/src/useGuiTranscriptWindow.ts'

test('janela começa nas últimas 100 e busca páginas de 20 ao subir', () => {
  const items = Array.from({ length: 157 }, (_, index) => ({ id: `item-${index}` }))
  const initial = guiTranscriptWindowRange(items.length, guiTranscriptInitialStart(items.length))

  assert.equal(GUI_TRANSCRIPT_INITIAL_ITEMS, 100)
  assert.equal(GUI_TRANSCRIPT_PAGE_SIZE, 20)
  assert.equal(initial.start, 57)
  assert.equal(initial.end, 157)
  assert.equal(initial.hiddenBefore, 57)
  assert.deepEqual(items.slice(initial.start, initial.end), items.slice(-100))

  const next = guiTranscriptWindowRange(items.length, guiTranscriptPageStart(initial.start))
  assert.equal(next.start, 37)
  assert.equal(next.end, 157)
  assert.equal(next.hiddenBefore, 37)
  assert.equal(items[next.start].id, 'item-37')
  assert.equal(next.end - next.start, 120)
  assert.equal(items[next.end - 1].id, 'item-156', 'o fim recente continua visível após o prepend')
})

test('prepender preserva a âncora pelo delta exato de scrollHeight', () => {
  assert.equal(guiTranscriptAnchoredScrollTop(180, 1_000, 1_360), 540)
  assert.equal(guiTranscriptAnchoredScrollTop(180, 1_360, 1_000), 0)
  assert.equal(guiTranscriptAnchoredScrollTop(Number.NaN, 1_000, 1_360), 360)
})

test('load-all abre a memória inteira e a pílula some quando não há prefixo', () => {
  const total = 211
  const initial = guiTranscriptWindowRange(total, guiTranscriptInitialStart(total))
  assert.equal(initial.hiddenBefore, 111)

  const all = guiTranscriptWindowRange(total, 0)
  assert.equal(all.start, 0)
  assert.equal(all.end, total)
  assert.equal(all.hiddenBefore, 0)
})

test('integra a janela no bloco de render/scroll sem alterar o cap do store', () => {
  const pane = readFileSync(new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url), 'utf8')
  const hook = readFileSync(new URL('../src/renderer/src/useGuiTranscriptWindow.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  assert.match(pane, /useGuiTranscriptWindow/u)
  // P11 acrescenta a etapa de aninhamento, mas a fonte continua sendo a janela
  // paginada — nunca `gui.items` inteiro.
  assert.match(pane, /guiThreadRenderItems\(visibleItems\)/u)
  assert.match(pane, /onScroll=\{onTranscriptScroll\}/u)
  assert.match(pane, /onClick=\{loadAll\}/u)
  assert.match(pane, /carregar todas as \{totalItems\}/u)
  assert.match(pane, /onRevealProgress=\{keepPinnedToEnd\}/u)
  assert.match(hook, /useLayoutEffect/u)
  assert.match(hook, /restoringScrollRef/u)
  assert.match(hook, /scrollHeight/u)
  assert.match(hook, /GUI_TRANSCRIPT_INITIAL_PIN_MS/u)
  assert.equal(GUI_TRANSCRIPT_INITIAL_PIN_MS, 1_000)
  assert.match(css, /\.gui-transcript-load-all\s*\{/u)
  assert.match(store, /const GUI_ITEM_CAP = 400/u)
})

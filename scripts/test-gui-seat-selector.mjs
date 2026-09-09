import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 2026-09-08: o seletor de conta mudou de casa — do cabeçalho do GuiPane para o
// StageSeatChip na cabeça do palco (uma fileira). O que a cerca protege é o
// mesmo: o menu não pode ser cortado, a lista longa tem teto e rola, a lista
// passada é a renderizada, e a falha da troca continua visível no chat.
test('chat seat selector escapes header clipping and bounds long lists', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const chip = readFileSync(
    new URL('../src/renderer/src/components/StageSeatChip.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const seatPick = readFileSync(
    new URL('../src/renderer/src/components/GuiSeatPick.tsx', import.meta.url),
    'utf8'
  )
  const stageHead = css.match(/\n\.stage-head\s*\{[^}]*\}/su)?.[0] ?? ''
  const seatHost = css.match(/\n\.stage-seat\s*\{[^}]*\}/su)?.[0] ?? ''
  const seatMenu = css.match(/\n\.gui-seat-menu\s*\{[^}]*\}/su)?.[0] ?? ''

  assert.doesNotMatch(stageHead, /overflow:\s*hidden/u, 'the head must not clip the menu')
  assert.match(seatHost, /position:\s*relative/u, 'the popover anchors on its host')
  assert.match(seatMenu, /top:\s*calc\(100% \+ 6px\)/u)
  assert.match(seatMenu, /right:\s*0/u, 'the chip sits at the right edge: the menu aligns right')
  assert.match(seatMenu, /overflow-y:\s*auto/u)
  assert.match(seatMenu, /max-height:\s*min\(320px, calc\(100dvh - 72px\)\)/u)
  assert.match(seatMenu, /width:\s*min\(320px, calc\(100cqw - 36px\)\)/u)
  assert.match(chip, /\{seats\.map\(\(option\) => \(/u, 'the passed seat list is rendered')
  assert.match(pane, /seatError &&/u, 'a failed swap remains visible in the chat')
  assert.match(seatPick, /seats\.length === 0/u, 'the empty state is explicit')
})

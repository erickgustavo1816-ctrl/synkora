import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('chat seat selector escapes header clipping and bounds long lists', () => {
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const seatPick = readFileSync(
    new URL('../src/renderer/src/components/GuiSeatPick.tsx', import.meta.url),
    'utf8'
  )
  const genericHeadChild = css.match(/\.gui-head > \*\s*\{[^}]*\}/su)?.[0] ?? ''
  const seatHost = css.match(/\.gui-head > \.gui-head-seat\s*\{[^}]*\}/su)?.[0] ?? ''
  const seatMenu = css.match(/\.gui-seat-menu\s*\{[^}]*\}/su)?.[0] ?? ''

  assert.match(genericHeadChild, /overflow:\s*hidden/u)
  assert.match(seatHost, /overflow:\s*visible/u, 'the popover host must not clip its menu')
  assert.match(seatHost, /white-space:\s*normal/u)
  assert.match(seatMenu, /top:\s*calc\(100% \+ 6px\)/u)
  assert.match(seatMenu, /overflow-y:\s*auto/u)
  assert.match(seatMenu, /max-height:\s*min\(320px, calc\(100dvh - 72px\)\)/u)
  assert.match(seatMenu, /width:\s*min\(320px, calc\(100cqw - 36px\)\)/u)
  assert.match(pane, /\{seats\.map\(\(option\) => \(/u, 'the passed seat list is rendered')
  assert.match(pane, /seatError &&/u, 'a failed swap remains visible in the chat')
  assert.match(seatPick, /seats\.length === 0/u, 'the empty state is explicit')
})

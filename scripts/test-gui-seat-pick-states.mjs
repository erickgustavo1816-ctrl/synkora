import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
const picker = readFileSync(
  new URL('../src/renderer/src/components/GuiSeatPick.tsx', import.meta.url),
  'utf8'
)

test('seletor de conta tem estados estaveis de hover, foco e escolha pendente', () => {
  assert.match(picker, /const isBusy = busySeatId === seat\.id/u)
  assert.match(picker, /data-state=\{isBusy \? 'pending' : undefined\}/u)
  assert.match(picker, /aria-busy=\{isBusy \|\| undefined\}/u)
  assert.match(picker, /gsp-pending/u, 'a linha escolhida explica o processamento')

  const base = css.match(/\.gsp-seat\s*\{[^}]*\}/su)?.[0] ?? ''
  assert.match(base, /box-shadow:\s*inset 2px 0 0 transparent/u)
  assert.match(base, /transition:[\s\S]*?box-shadow 120ms ease/u)

  const hoverAndFocus =
    css.match(/\.gsp-seat:hover:not\(:disabled\),\s*\.gsp-seat:focus-visible\s*\{[^}]*\}/su)?.[0] ??
    ''
  assert.match(hoverAndFocus, /box-shadow:\s*inset 2px 0 0 var\(--accent\)/u)
  assert.match(hoverAndFocus, /background:\s*color-mix/u)

  const focus = css.match(/\.gsp-seat:focus-visible\s*\{\s*z-index:[^}]*\}/su)?.[0] ?? ''
  assert.match(focus, /outline:\s*2px solid/u)
  assert.match(focus, /outline-offset:\s*2px/u)
  assert.match(css, /\.gsp-seat:focus-visible \.gsp-name/u)

  const pending = css.match(/\.gsp-seat\.busy\s*\{[^}]*\}/su)?.[0] ?? ''
  assert.match(pending, /box-shadow:\s*inset 2px 0 0 var\(--accent-deep\)/u)
  assert.match(pending, /cursor:\s*progress/u)
  assert.match(css, /\.gsp-seat:disabled:not\(\.busy\)/u)
})

test('seletor de conta preserva foco em alto contraste e respeita movimento reduzido', () => {
  assert.match(
    css,
    /@media \(forced-colors: active\)[\s\S]*?\.gsp-seat:focus-visible[\s\S]*?Highlight/u
  )

  // A transicao e somente cosmetica; a regra global a desliga integralmente.
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none !important/u
  )
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { guiContextPanelPresentation } from '../src/renderer/src/guiContextPanel.ts'

const readWorkspaceFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('painel de contexto só mostra a fotografia canônica e preserva números exatos', () => {
  const withCost = guiContextPanelPresentation(51_234, 200_000, 0.0035)
  assert.deepEqual(withCost, {
    contextTokens: 51_234,
    contextWindow: 200_000,
    percent: 26,
    percentLabel: '26%',
    contextTokensLabel: '51.234',
    contextWindowLabel: '200.000',
    costLabel: '$0.0035',
    tooltip: 'contexto: 51.234 de 200.000 tokens usados · 26% da janela · custo $0.0035'
  })

  const withoutCost = guiContextPanelPresentation(0, 200_000, null)
  assert.equal(withoutCost?.tooltip, 'contexto: 0 de 200.000 tokens usados · 0% da janela')
  assert.equal(guiContextPanelPresentation(10.5, 200_000), null)
  assert.equal(guiContextPanelPresentation(10, 0), null)
  assert.equal(guiContextPanelPresentation(10, 200_000, Number.NaN)?.costLabel, undefined)
  assert.equal(guiContextPanelPresentation(10, 200_000, -0.1)?.costLabel, undefined)
})

test('integração usa botão discreto, popover nomeado e restauração de foco', () => {
  const component = readWorkspaceFile('src/renderer/src/components/GuiContextPanel.tsx')
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const css = readWorkspaceFile('src/renderer/src/global.css')

  assert.match(component, /<button[\s\S]*aria-haspopup="dialog"/u)
  assert.match(component, /aria-expanded=\{open\}/u)
  assert.match(component, /role="dialog"/u)
  assert.match(component, /tabIndex=\{-1\}/u)
  assert.match(component, /event\.key !== 'Escape'/u)
  assert.match(component, /triggerRef\.current\?\.focus/u)
  assert.match(component, /data-tip=\{usage\.tooltip\}/u)
  assert.match(component, /usage\.costLabel &&/u)
  assert.match(pane, /<GuiContextPanel/u)
  assert.match(pane, /open=\{openMenu === 'context'\}/u)
  assert.match(pane, /guiContextPanelPresentation\(/u)
  assert.match(css, /\.gui-context-trigger\s*\{/u)
  assert.match(css, /\.gui-context-popover\s*\{[\s\S]*bottom: calc\(100% \+ 9px\)/u)
  assert.match(css, /\.gui-context-trigger:focus-visible/u)
})

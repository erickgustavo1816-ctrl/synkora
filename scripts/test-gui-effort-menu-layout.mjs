import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readWorkspaceFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('seletor de effort usa conteúdo intrínseco e respeita pane/viewport', () => {
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const css = readWorkspaceFile('src/renderer/src/global.css')
  const effortMenu = pane.match(
    /\{openMenu === 'effort' && \([\s\S]*?className="gui-menu gui-mode-menu gui-effort-menu"[\s\S]*?<\/div>\s*\)\}/u
  )?.[0]
  const menuRule = css.match(/\.gui-composer-effort \.gui-effort-menu\s*\{[^}]*\}/su)?.[0] ?? ''
  const itemRule = css.match(/\.gui-effort-menu \.gui-menu-item\s*\{[^}]*\}/su)?.[0] ?? ''

  assert.ok(effortMenu, 'o menu de effort precisa ter uma geometria própria')
  assert.match(effortMenu, /role="menu"/u)
  assert.match(effortMenu, /aria-label="Níveis de esforço"/u)
  assert.doesNotMatch(effortMenu, /<span\b/u, 'as opções curtas não renderizam descrição vazia')

  assert.match(menuRule, /width: max-content;/u)
  assert.match(menuRule, /min-width: 0;/u)
  assert.match(menuRule, /max-width: min\(184px, calc\(100cqw - 64px\)\);/u)
  assert.match(menuRule, /max-height: min\(288px, calc\(100dvh - 112px\)\);/u)
  assert.match(menuRule, /overflow-y: auto;/u)
  assert.match(menuRule, /overscroll-behavior: contain;/u)
  assert.doesNotMatch(
    menuRule,
    /(?:^|\n)\s*(?:height|min-height|block-size|min-block-size):/u,
    'a altura normal do popover deve continuar intrínseca'
  )

  assert.match(itemRule, /min-height: 36px;/u)
  assert.match(itemRule, /justify-content: center;/u)
  assert.match(itemRule, /padding: 7px 10px;/u)
  assert.match(
    css,
    /\.gui-composer-model \.gui-mode-menu,[\s\S]*?\.gui-composer-effort \.gui-mode-menu\s*\{[^}]*right: 0;[^}]*left: auto;/u,
    'o menu abre para dentro do pane a partir do rail direito'
  )

  const cappedWidth = (paneWidth) => Math.min(184, paneWidth - 64)
  assert.equal(cappedWidth(360), 184, 'painel largo preserva a largura do conteúdo')
  assert.equal(cappedWidth(180), 116, 'painel estreito preserva o rail de envio')
})

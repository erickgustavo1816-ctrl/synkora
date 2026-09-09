import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  guiComposerCatalogModels,
  guiEffortLabel,
  guiModelIsDefault,
  guiModelLabel,
  guiModelShortName
} from '../src/renderer/src/guiComposerPresentation.ts'

const readWorkspaceFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('identificadores técnicos ganham um nome legível sem alterar a seleção', () => {
  const model = { value: 'gpt-6-astra', displayName: 'gpt-6-astra' }
  assert.equal(guiModelShortName(model), 'GPT-6 Astra')
  assert.equal(guiModelShortName({ value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }), 'GPT-5.6 Sol')
  assert.equal(guiModelShortName(undefined, 'GPT-6 ASTRA'), 'GPT-6 Astra')
  assert.equal(guiModelShortName({ value: 'gpt-5.4-mini', displayName: 'gpt-5.4-mini' }), 'GPT-5.4 Mini')
  assert.equal(guiModelShortName({ value: 'claude-opus-4-8', displayName: 'claude-opus-4-8' }), 'Opus 4.8')
  assert.equal(model.value, 'gpt-6-astra')
  assert.equal(guiEffortLabel('high'), 'HIGH')
  assert.equal(guiEffortLabel('xhigh'), 'XHIGH')
  assert.equal(guiEffortLabel(null), 'PADRÃO')
})

test('seletor de modelo usa geometria intrínseca e cabe em pane/viewport', () => {
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const css = readWorkspaceFile('src/renderer/src/global.css')
  const modelMenu = pane.match(
    /\{openMenu === 'model' && \([\s\S]*?<div className="gui-menu gui-mode-menu" role="menu">[\s\S]*?<\/div>\s*\)\}/u
  )?.[0]
  const menuRule =
    css.match(/\.gui-composer-model \.gui-mode-menu\s*\{[^}]*\}/su)?.[0] ?? ''
  const itemRule =
    css.match(/\.gui-composer-model \.gui-mode-menu \.gui-menu-item\s*\{[^}]*\}/su)?.[0] ?? ''
  const labelRule =
    css.match(/\.gui-composer-model \.gui-mode-menu \.gui-menu-item b\s*\{[^}]*\}/su)?.[0] ?? ''

  assert.ok(modelMenu, 'o menu de modelo precisa continuar sendo um menu acessível')
  assert.match(modelMenu, /role="menu"/u)
  assert.match(menuRule, /width: max-content;/u)
  assert.match(menuRule, /min-width: 0;/u)
  assert.match(menuRule, /max-width: min\(240px, calc\(100cqw - 64px\)\);/u)
  assert.match(menuRule, /max-height: min\(288px, calc\(100dvh - 112px\)\);/u)
  assert.match(menuRule, /overflow-y: auto;/u)
  assert.match(menuRule, /overscroll-behavior: contain;/u)
  assert.match(
    css,
    /\.gui-composer-model \.gui-mode-menu::-webkit-scrollbar\s*\{[^}]*display: block;[^}]*\}/su,
    'catálogos longos precisam deixar a rolagem descoberta no Chromium'
  )
  assert.doesNotMatch(
    menuRule,
    /(?:^|\n)\s*(?:height|min-height|block-size|min-block-size):/u,
    'a altura normal do popover deve continuar intrínseca'
  )
  assert.match(itemRule, /min-width: 0;/u)
  assert.match(labelRule, /overflow-wrap: anywhere;/u)

  const cappedWidth = (paneWidth) => Math.min(240, paneWidth - 64)
  assert.equal(cappedWidth(360), 240, 'pane confortável preserva a largura do conteúdo')
  assert.equal(cappedWidth(180), 116, 'pane estreito mantém o rail de envio')
  assert.equal(cappedWidth(90), 26, 'pane muito estreito nunca ganha largura fixa')
})

test('modelo mostra a versão canônica e mantém um único padrão', () => {
  const pane = readWorkspaceFile('src/renderer/src/components/GuiPane.tsx')
  const modelBlock = pane.match(
    /\{openMenu === 'model' && \([\s\S]*?<\/div>\s*\)\}/u
  )?.[0]
  assert.ok(modelBlock, 'o trecho do menu de modelo precisa existir')
  assert.match(modelBlock, /modelDefaultLabel/u)
  assert.match(modelBlock, /modelChoiceOptions\.map/u)
  assert.doesNotMatch(modelBlock, /modelOptions\.map/u)

  const models = [
    {
      value: 'default',
      resolvedModel: 'claude-opus-4-8[1m]',
      displayName: 'Default (recommended)',
      description: 'descrição longa não deve entrar no botão'
    },
    { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
    { value: 'sonnet', displayName: 'Sonnet' }
  ]

  assert.equal(guiModelIsDefault(models[0]), true)
  assert.equal(guiModelShortName(models[0]), 'Opus 4.8')
  assert.equal(guiModelShortName(models[1]), 'Fable 5')
  assert.equal(guiModelShortName(models[2]), 'Sonnet')
  assert.equal(guiModelLabel(models, 'claude-opus-4-8[1m]'), 'Opus 4.8')
  assert.equal(guiModelIsDefault(models[1]), false)

  assert.equal(
    guiModelShortName({
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku'
    }),
    'Haiku 4.5'
  )
  assert.equal(
    guiModelShortName({
      value: 'haiku',
      resolvedModel: 'claude-haiku-4.5.20251001',
      displayName: 'Haiku 4.5.20251001'
    }),
    'Haiku 4.5'
  )
  assert.equal(
    guiModelShortName({ value: 'haiku', displayName: 'Haiku 4-5-20251001' }),
    'Haiku 4.5'
  )
  assert.equal(
    guiModelShortName({ value: 'opus', resolvedModel: 'claude-opus-5.0', displayName: 'Opus' }),
    'Opus 5'
  )
  assert.equal(
    guiModelShortName({ value: 'sonnet', resolvedModel: 'claude-sonnet-5.1.0', displayName: 'Sonnet' }),
    'Sonnet 5.1'
  )

  const noVersionDefault = { value: 'default', displayName: 'Default (recommended)' }
  assert.equal(guiModelShortName(noVersionDefault), 'Default')
  assert.match(
    pane,
    /modelDefaultIdentity[\s\S]*!\/\^default\\b\/iu/u,
    'o label padrão não deve renderizar Default como uma segunda escolha'
  )
})

// A LISTA ANTES DAS CAPS (foto do dono, 2026-08-30): no "abrindo" do boot
// frio — waitForCliStable pode segurar o spawn por minutos — os menus ficavam
// vazios e o chip de effort sumia. O composer passou a cair no catálogo REAL
// da conta, vestido na forma das caps. A régua dos efforts é espelho declarado
// de guiDelegationModelGroups (guiDelegationDefaults.ts): declarada não-vazia
// é ela; declarada VAZIA = o modelo não aceita effort; AUSENTE = os níveis do
// binário. E o rótulo parte no " — " (descrição não é nome de menu).
test('o catálogo vira lista de modelos do composer enquanto as caps não chegam', () => {
  const models = guiComposerCatalogModels({
    models: [
      { id: 'opus[1m]', label: 'Opus — o confiável', efforts: ['low', 'high'] },
      { id: 'haiku', label: 'Haiku', efforts: [] },
      { id: 'fable-5[1m]' },
      { id: '  ', label: 'fantasma' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['medium', ' ', 'medium'] }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh']
  })
  assert.deepEqual(models, [
    { value: 'opus[1m]', displayName: 'Opus', supportedEffortLevels: ['low', 'high'] },
    { value: 'haiku', displayName: 'Haiku', supportedEffortLevels: [] },
    {
      value: 'fable-5[1m]',
      displayName: 'fable-5[1m]',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh']
    },
    { value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', supportedEffortLevels: ['medium'] }
  ])
  assert.deepEqual(guiComposerCatalogModels(undefined), [])
  assert.deepEqual(guiComposerCatalogModels({}), [])
})

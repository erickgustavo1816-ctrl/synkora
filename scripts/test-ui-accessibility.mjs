// ACESSIBILIDADE DO SYNKORA (ordem do dono, 2026-09-21) — a seção "Tipografia
// fixa" dos painéis xterm "hoje não serve para nada"; no lugar, a regulagem do
// APP INTEIRO: escala (zoom real da janela), fonte, movimento reduzido e a
// leitura do chat. Aqui se prova o que é puro (régua da escala, conversão do
// retângulo do browser, aplicador do zoom/mídia sobre uma superfície falsa,
// variáveis CSS) e os contratos de fonte que ligam tudo.
//
// Como rodar:
//   node --experimental-strip-types --test scripts/test-ui-accessibility.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createUiAccessibilityApplier,
  scaleRectByZoom,
  uiZoomFactor
} from '../src/main/uiAccessibility.ts'
import {
  CHAT_FONT_SIZE_RANGE,
  CHAT_LINE_HEIGHT_RANGE,
  UI_SCALE_RANGE,
  applyUiAccessibilityVars,
  stepUiScale,
  uiAccessibilityVars
} from '../src/renderer/src/uiAccessibility.ts'
import {
  CHAT_FONT_SIZE_RANGE as MAIN_CHAT_FONT_SIZE_RANGE,
  CHAT_LINE_HEIGHT_RANGE as MAIN_CHAT_LINE_HEIGHT_RANGE,
  UI_SCALE_RANGE as MAIN_UI_SCALE_RANGE
} from '../src/main/settingsCore.ts'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

// ————— a escala —————

test('zoom: porcento vira fator; torto ou não positivo cai em 1', () => {
  assert.equal(uiZoomFactor(100), 1)
  assert.equal(uiZoomFactor(125), 1.25)
  assert.equal(uiZoomFactor(80), 0.8)
  assert.equal(uiZoomFactor(NaN), 1)
  assert.equal(uiZoomFactor(0), 1)
  assert.equal(uiZoomFactor(-40), 1)
})

test('Ctrl + −/+/0 andam de 5 em 5 dentro da faixa e assentam na grade', () => {
  assert.equal(stepUiScale(100, 1), 105)
  assert.equal(stepUiScale(100, -1), 95)
  assert.equal(stepUiScale(100, 0), 100)
  assert.equal(stepUiScale(undefined, 1), 105, 'sem preferência gravada conta do padrão')
  assert.equal(stepUiScale(103, 1), 105, 'valor fora da grade sobe para o próximo múltiplo')
  assert.equal(stepUiScale(103, -1), 100, 'e desce para o anterior')
  assert.equal(stepUiScale(150, 1), 150, 'teto')
  assert.equal(stepUiScale(80, -1), 80, 'piso')
  assert.equal(stepUiScale(148, 0), 100)
})

test('as faixas do renderer são espelho das do main', () => {
  assert.deepEqual(UI_SCALE_RANGE, MAIN_UI_SCALE_RANGE)
  assert.deepEqual(CHAT_FONT_SIZE_RANGE, MAIN_CHAT_FONT_SIZE_RANGE)
  assert.deepEqual(CHAT_LINE_HEIGHT_RANGE, MAIN_CHAT_LINE_HEIGHT_RANGE)
})

// ————— o retângulo do browser embutido —————
// O renderer mede em px CSS (já escalados pelo zoom); a WebContentsView quer
// DIP. Sem esta conversão o painel do browser desalinha em qualquer escala.

test('retângulo: zoom 1 devolve o mesmo objeto; outro zoom multiplica e arredonda', () => {
  const rect = { x: 10, y: 20.4, width: 300, height: 199.6 }
  assert.equal(scaleRectByZoom(rect, 1), rect)
  assert.deepEqual(scaleRectByZoom(rect, 1.25), { x: 13, y: 26, width: 375, height: 250 })
  assert.deepEqual(scaleRectByZoom(rect, 0.8), { x: 8, y: 16, width: 240, height: 160 })
  assert.equal(scaleRectByZoom(rect, NaN), rect)
  assert.equal(scaleRectByZoom(rect, 0), rect)
  assert.deepEqual(
    scaleRectByZoom({ ...rect, extra: 'kept' }, 2),
    { x: 20, y: 41, width: 600, height: 399, extra: 'kept' },
    'campos que não são geometria atravessam intactos'
  )
})

test('browser:bounds converte o retângulo pelo zoom do remetente, num ponto só', async () => {
  const ipc = await source('src/main/ipc/browser.ts')
  assert.match(ipc, /scaleRectByZoom\(rect, e\.sender\.getZoomFactor\(\)\)/u)
})

// ————— o aplicador sobre a janela —————

function fakeSurface(zoom = 1) {
  const calls = []
  let attached = false
  return {
    calls,
    getZoomFactor: () => zoom,
    setZoomFactor: (factor) => {
      zoom = factor
      calls.push(['zoom', factor])
    },
    debugger: {
      isAttached: () => attached,
      attach: (version) => {
        attached = true
        calls.push(['attach', version])
      },
      sendCommand: async (method, params) => {
        calls.push([method, params])
      }
    }
  }
}

test('aplicador: muda o zoom só quando difere e nunca anexa o debugger sem o modo ligado', async () => {
  const applier = createUiAccessibilityApplier()
  const surface = fakeSurface(1)
  await applier.apply(surface, { uiScale: 100, uiReduceMotion: false })
  assert.deepEqual(surface.calls, [], 'padrão sobre padrão: nada a fazer')
  await applier.apply(surface, { uiScale: 125, uiReduceMotion: false })
  assert.deepEqual(surface.calls, [['zoom', 1.25]])
})

test('aplicador: reduzir movimento emula a mídia; desligar devolve a mídia ao sistema; quem nunca ligou não recebe CDP', async () => {
  const applier = createUiAccessibilityApplier()
  const surface = fakeSurface(1)
  await applier.apply(surface, { uiScale: 100, uiReduceMotion: true })
  assert.deepEqual(surface.calls, [
    ['attach', '1.3'],
    ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }]
  ])
  surface.calls.length = 0
  await applier.apply(surface, { uiScale: 100, uiReduceMotion: false })
  assert.deepEqual(surface.calls, [
    ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] }]
  ], 'desligar não re-anexa (já está) e limpa a emulação')
  surface.calls.length = 0
  await applier.apply(surface, { uiScale: 100, uiReduceMotion: false })
  assert.deepEqual(surface.calls, [], 'já limpo: silêncio')
})

test('aplicador: falha de CDP não sobe', async () => {
  const applier = createUiAccessibilityApplier()
  const surface = fakeSurface(1)
  surface.debugger.attach = () => {
    throw new Error('devtools ocupados')
  }
  await assert.doesNotReject(() => applier.apply(surface, { uiScale: 110, uiReduceMotion: true }))
  assert.deepEqual(surface.calls, [['zoom', 1.1]], 'o zoom já tinha sido aplicado')
})

// ————— as variáveis CSS —————

test('variáveis: fonte com fallbacks, chat em px e altura de linha; sem settings, os padrões do global.css', () => {
  assert.deepEqual(uiAccessibilityVars(null), {
    '--mono': '"Cascadia Code", Consolas, monospace',
    '--chat-font-size': '12.5px',
    '--chat-line-height': '1.55'
  })
  assert.deepEqual(
    uiAccessibilityVars({ uiFontFamily: 'JetBrains Mono', chatFontSize: 14, chatLineHeight: 1.8 }),
    {
      '--mono': '"JetBrains Mono", Consolas, monospace',
      '--chat-font-size': '14px',
      '--chat-line-height': '1.8'
    }
  )
  const written = []
  applyUiAccessibilityVars({ chatFontSize: 11 }, { style: { setProperty: (n, v) => written.push([n, v]) } })
  assert.deepEqual(written, [
    ['--mono', '"Cascadia Code", Consolas, monospace'],
    ['--chat-font-size', '11px'],
    ['--chat-line-height', '1.55']
  ])
})

// ————— os contratos de fonte —————

test('a janela recebe escala e movimento no boot e a cada gravação; o chat lê as variáveis', async () => {
  const index = await source('src/main/index.ts')
  assert.match(index, /applyUiAccessibilityToMainWindow\(\)/u)
  assert.match(index, /applyUiAccessibility: \(\) => applyUiAccessibilityToMainWindow\(\)/u)
  const settingsIpc = await source('src/main/ipc/settings.ts')
  assert.match(settingsIpc, /applyUiAccessibility\?\.\(next\)/u)
  const app = await source('src/renderer/src/App.tsx')
  assert.match(app, /applyUiAccessibilityVars\(settings\)/u)
  assert.match(app, /stepUiScale\(current, action\)/u)
  assert.doesNotMatch(app, /terminalFontSize/u, 'o atalho deixou de mexer na fonte xterm')
  const css = await source('src/renderer/src/uiAccessibility.css')
  assert.match(css, /\.gui-pane \.gui-msg \{[\s\S]*?font-size: var\(--chat-font-size, 12\.5px\)/u)
  assert.match(css, /line-height: var\(--chat-line-height, 1\.55\)/u)
})

test('a seção antiga saiu e a nova regula o app inteiro', async () => {
  const settingsScreen = await source('src/renderer/src/screens/Settings.tsx')
  assert.match(settingsScreen, /<AccessibilitySettings \/>/u)
  assert.doesNotMatch(settingsScreen, /AppearanceSettings/u)
  const section = await source('src/renderer/src/components/AccessibilitySettings.tsx')
  assert.match(section, /Acessibilidade do Synkora/u)
  for (const field of ['uiScale', 'uiFontFamily', 'uiReduceMotion', 'chatFontSize', 'chatLineHeight'])
    assert.match(section, new RegExp(`patchSettings\\(\\{[^}]*${field}`, 'u'), `a tela grava ${field}`)
  assert.doesNotMatch(section, /terminalFontSize|terminalLineHeight|terminalFontFamily/u)
})

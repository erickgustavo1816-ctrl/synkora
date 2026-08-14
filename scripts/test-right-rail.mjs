import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  clampRightRailWidth,
  readRightRailPreference,
  rightRailBounds,
  rightRailStorageKey,
  stepRightRailWidth,
  writeRightRailPreference
} from '../src/renderer/src/rightRailSizing.ts'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('trilho limita largura pela fração disponível e preserva o centro', () => {
  assert.deepEqual(rightRailBounds(1000), { min: 176, max: 420 })
  assert.equal(clampRightRailWidth(100, 1000), 176)
  assert.equal(clampRightRailWidth(999, 1000), 420)
  assert.equal(clampRightRailWidth(300, 1000), 300)

  const narrow = rightRailBounds(500)
  assert.deepEqual(narrow, { min: 128, max: 128 })
  assert.equal(clampRightRailWidth(204, 500), 128)
})

test('preferência é isolada por projeto, tolera storage inválido e persiste sem bloquear', () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
  const key = rightRailStorageKey('Projeto / um')
  assert.equal(key, 'synkora.rightRail.v1:Projeto%20%2F%20um')
  assert.deepEqual(readRightRailPreference(storage, key), { width: 204, collapsed: false })

  writeRightRailPreference(storage, key, { width: 287.6, collapsed: true })
  assert.deepEqual(readRightRailPreference(storage, key), { width: 288, collapsed: true })

  values.set(key, '{quebrado')
  assert.deepEqual(readRightRailPreference(storage, key), { width: 204, collapsed: false })
  assert.deepEqual(readRightRailPreference(null, key), { width: 204, collapsed: false })
})

test('passos de teclado respeitam os dois limites', () => {
  assert.equal(stepRightRailWidth(204, 'increase', 1000, 24), 228)
  assert.equal(stepRightRailWidth(204, 'decrease', 1000, 24), 180)
  assert.equal(stepRightRailWidth(176, 'decrease', 1000, 24), 176)
  assert.equal(stepRightRailWidth(420, 'increase', 1000, 24), 420)
})

test('contrato da UI expõe recolher, separator focável e cleanup do gesto', async () => {
  const [component, css, board] = await Promise.all([
    source('src/renderer/src/components/ResizableRightRail.tsx'),
    source('src/renderer/src/global.css'),
    source('src/renderer/src/components/Board.tsx')
  ])
  assert.match(component, /role="separator"/u)
  assert.match(component, /tabIndex=\{0\}/u)
  assert.match(component, /aria-valuemin=\{bounds\.min\}/u)
  assert.match(component, /ArrowLeft/u)
  assert.match(component, /ArrowRight/u)
  assert.match(component, /case 'Home'/u)
  assert.match(component, /case 'End'/u)
  assert.match(component, /setPointerCapture/u)
  assert.match(component, /releasePointerCapture/u)
  assert.match(component, /window\.removeEventListener\('blur', onCancel\)/u)
  assert.match(component, /aria-expanded=\{!preference\.collapsed\}/u)
  assert.match(component, /inert=\{preference\.collapsed \? true : undefined\}/u)
  assert.doesNotMatch(component, /right-rail-chrome/u)
  assert.doesNotMatch(component, /right-rail-toolbar/u)
  assert.match(css, /\.board-main\.stage-mode \.board-content\.right-rail/u)
  assert.match(css, /\.right-rail\.is-collapsed/u)
  assert.match(css, /\.right-rail-resizer:focus-visible/u)
  assert.match(css, /\.board-main\.stage-mode \.board-content\.right-rail\s*\{[\s\S]*?border-left:\s*1px solid var\(--line\)/u)
  assert.match(css, /\.right-rail-resizer\s*\{[\s\S]*?position:\s*absolute/u)
  assert.match(css, /\.right-rail-toggle\s*\{[\s\S]*?right:\s*12px/u)
  assert.match(css, /\.right-rail-content\s*\{[\s\S]*?padding-left:\s*12px/u)
  assert.match(css, /\.right-rail-content > \.delivery-rail > \.dr-head\s*\{[\s\S]*?padding-right:\s*22px/u)
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\s*\{[\s\S]*?position:\s*absolute[\s\S]*?width:\s*0\s*!important[\s\S]*?border:\s*0/u
  )
  assert.match(
    css,
    /\.right-rail\.is-collapsed \.right-rail-toggle\s*\{[\s\S]*?top:\s*9px[\s\S]*?right:\s*9px[\s\S]*?transform:\s*none/u
  )
  assert.doesNotMatch(css, /\.right-rail-enabled\.is-collapsed\s*\{[\s\S]*?(?:width|flex-basis):\s*22px/u)
  assert.doesNotMatch(css, /grid-template-columns:\s*18px minmax\(0, 1fr\)/u)
  assert.doesNotMatch(css, /\.right-rail-chrome\s*\{/u)
  assert.doesNotMatch(css, /\.right-rail-toolbar\s*\{/u)
  assert.match(board, /<ResizableRightRail/u)
  assert.match(board, /projectKey=\{projectId\}/u)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  clampRightRailWidth,
  readRightRailPreference,
  rightRailBounds,
  rightRailStorageKey,
  stepRightRailWidth,
  writeRightRailPreference,
  RIGHT_RAIL_MOTION_MS,
  RIGHT_RAIL_MOTION_TAIL_MS
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

test('a rampa do recolher pertence ao BOTÃO e nunca atravessa o arrasto', async () => {
  const [component, css] = await Promise.all([
    source('src/renderer/src/components/ResizableRightRail.tsx'),
    source('src/renderer/src/global.css')
  ])

  // O clique liga a classe do gesto; o arrasto a desliga ANTES de capturar o
  // ponteiro. Sem essa ordem a largura ficaria elástica atrás do cursor.
  assert.match(component, /animating \? 'is-animating' : ''/u)
  assert.match(component, /onClick=\{toggleCollapsed\}/u)
  assert.match(
    component,
    /function onResizePointerDown\([\s\S]*?cancelCollapseAnimation\(\)[\s\S]*?setPointerCapture/u
  )
  // Movimento reduzido = toggle seco, o comportamento anterior à rampa.
  assert.match(component, /prefers-reduced-motion: reduce/u)
  assert.match(component, /!prefersReducedMotion\(\)/u)
  // Timer do gesto morre com o componente e com a troca de projeto.
  assert.match(component, /window\.clearTimeout\(motionTimerRef\.current\)/u)

  // A duração é UMA só: o componente publica a constante como custom property
  // e o CSS a consome — não há como o timer e a transição divergirem.
  assert.ok(
    RIGHT_RAIL_MOTION_MS >= 180 && RIGHT_RAIL_MOTION_MS <= 240,
    'a rampa precisa ficar na faixa curta (180–240ms) do tema'
  )
  assert.ok(RIGHT_RAIL_MOTION_TAIL_MS > 0, 'a classe precisa sobreviver ao último frame')
  assert.match(component, /'--right-rail-motion': `\$\{RIGHT_RAIL_MOTION_MS\}ms`/u)
  assert.match(component, /RIGHT_RAIL_MOTION_MS \+ RIGHT_RAIL_MOTION_TAIL_MS/u)

  const railRule = css.match(
    /\.board-main\.stage-mode \.board-content\.right-rail \{([\s\S]*?)\n\}/u
  )?.[1]
  assert.ok(railRule, 'a regra base do trilho precisa existir')
  // CERCA CENTRAL: transição na regra BASE pegaria o arrasto junto.
  assert.doesNotMatch(
    railRule,
    /transition/u,
    'a rampa mora em .is-animating; na regra base ela tornaria o arrasto elástico'
  )
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-animating\s*\{[\s\S]*?transition:\s*\n?\s*width var\(--right-rail-motion/u
  )
  // Fechando, o trilho continua NO FLUXO: é a largura dele que devolve o espaço
  // ao chat quadro a quadro (sem isso o centro saltaria de uma vez).
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\.is-animating\s*\{[\s\S]*?position:\s*relative/u
  )

  // A margem negativa tem que comer EXATAMENTE o gap do .board-main, senão a
  // pegada salta no último frame, quando o trilho sai do fluxo.
  const boardMain = css.match(/\n\.board-main \{([\s\S]*?)\n\}/u)?.[1]
  const gap = Number(boardMain?.match(/\bgap:\s*(\d+)px/u)?.[1])
  const gutter = Number(railRule.match(/--right-rail-gutter:\s*(\d+)px/u)?.[1])
  assert.ok(Number.isFinite(gap) && Number.isFinite(gutter))
  assert.equal(gutter, gap, 'o --right-rail-gutter espelha o gap do .board-main')
  assert.match(
    css,
    /\.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\s*\{[\s\S]*?margin-left:\s*calc\(-1 \* var\(--right-rail-gutter\)\)/u
  )

  // O conteúdo fica na largura ABERTA durante o gesto (não se espreme): a conta
  // precisa bater com a caixa real — borda do trilho + paddings do scroller.
  const contentRule = css.match(/\n\.right-rail-content \{([\s\S]*?)\n\}/u)?.[1]
  const inset = Number(contentRule?.match(/--right-rail-content-inset:\s*(\d+)px/u)?.[1])
  const padLeft = Number(contentRule?.match(/padding-left:\s*(\d+)px/u)?.[1])
  const padRight = Number(contentRule?.match(/padding-right:\s*(\d+)px/u)?.[1])
  const border = Number(railRule.match(/border-left:\s*(\d+)px solid/u)?.[1])
  assert.ok([inset, padLeft, padRight, border].every(Number.isFinite))
  assert.equal(
    inset,
    padLeft + padRight + border,
    'o inset congelado no gesto = paddings do scroller + borda do trilho'
  )
  assert.match(
    css,
    /\.right-rail\.is-animating \.right-rail-content > \*\s*\{[\s\S]*?width:\s*calc\([\s\S]*?--right-rail-content-inset/u
  )
  // `visibility` na lista segura o conteúdo visível até o fim da rampa.
  assert.match(
    css,
    /\.right-rail\.is-animating \.right-rail-content\s*\{[\s\S]*?visibility var\(--right-rail-motion/u
  )
})

test('gesto seco onde a rampa não descreveria o movimento', async () => {
  const css = await source('src/renderer/src/global.css')

  // Empilhado a caixa que fecha é a ALTURA: largura animada ali seria mentira.
  const stacked = (css.match(/@container board \(max-width: 1103px\) \{[\s\S]*?\n\}/gu) ?? []).find(
    (block) => block.includes('.right-rail-resizer')
  )
  assert.ok(stacked, 'o bloco empilhado do trilho precisa existir')
  assert.match(
    stacked,
    /\.board \.board-main\.stage-mode \.board-content\.right-rail\.is-animating\s*\{[\s\S]*?transition:\s*none/u
  )
  assert.match(
    stacked,
    /\.board \.board-main\.stage-mode \.board-content\.right-rail\.is-collapsed\.is-animating\s*\{[\s\S]*?position:\s*absolute/u
  )

  // Movimento reduzido: o toggle volta a ser instantâneo, mesmo se a classe
  // escapar do guarda do componente.
  const reduced = (
    css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/gu) ?? []
  ).find((block) => block.includes('.right-rail-toggle'))
  assert.ok(reduced, 'o bloco de movimento reduzido do trilho precisa existir')
  assert.match(reduced, /\.board-main\.stage-mode \.board-content\.right-rail\.is-animating/u)
  assert.match(reduced, /\.right-rail\.is-animating \.right-rail-content/u)
  assert.match(reduced, /\.is-collapsed\.is-animating\s*\{[\s\S]*?position:\s*absolute/u)
})

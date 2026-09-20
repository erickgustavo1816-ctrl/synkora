import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

const boundary = readFileSync(
  new URL('../src/renderer/src/components/GuiPanelErrorBoundary.tsx', import.meta.url),
  'utf8'
)
const board = readFileSync(new URL('../src/renderer/src/components/Board.tsx', import.meta.url), 'utf8')
const seats = readFileSync(
  new URL('../src/renderer/src/components/SeatDeck.tsx', import.meta.url),
  'utf8'
)
const universe = readFileSync(
  new URL('../src/renderer/src/screens/Universe.tsx', import.meta.url),
  'utf8'
)
const home = readFileSync(new URL('../src/renderer/src/screens/Home.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/renderer/src/screens/Settings.tsx', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/renderer/src/mainApp.tsx', import.meta.url), 'utf8')
const bootstrap = readFileSync(new URL('../src/renderer/src/main.tsx', import.meta.url), 'utf8')
const phone = readFileSync(new URL('../src/renderer/src/components/MobilePhone.tsx', import.meta.url), 'utf8')

test('falha de painel é contida, recuperável e não revela a exceção', () => {
  assert.match(boundary, /getDerivedStateFromError/)
  assert.match(boundary, /componentDidCatch/)
  assert.match(boundary, /role="alert"/)
  assert.match(boundary, /tentar de novo/)
  assert.match(boundary, /safePanelLabel/)
  assert.match(boundary, /Fragment key=/)
  assert.doesNotMatch(boundary, /error\.message|info\.componentStack/)
})

test('painéis do board e do canvas ficam dentro do limite isolado', () => {
  // A ilha panes-view morreu na purga F6 (2026-08-17), e com ela saiu do
  // Board todo o mundo LEGADO: PlanModal, TaskModal, reseat e confirmação de
  // orquestrador, o slot do PM e os slots dos orquestradores TUI. O piso caiu
  // de 12 para 7. A CONTAGEM sozinha não protege nada — o que protege é a
  // lista de paneId abaixo, que diz QUAL painel precisa estar dentro do
  // limite; baixar o número sem tirar um nome da lista não é possível.
  assert.ok((board.match(/<GuiPanelErrorBoundary/g) ?? []).length >= 7)
  assert.match(board, /<GuiPanelErrorBoundary[\s\S]*<GuiPane/)
  assert.match(board, /<GuiPanelErrorBoundary[\s\S]*<TerminalPane/)
  for (const paneId of [
    'paneId={`board-general:${projectId}`}',
    'paneId={`mission-delivery:${selMission.id}`}',
    'paneId={`mission-column:${projectId}`}',
    'paneId={`overlay:test-server:${selMission.id}`}',
    'paneId="overlay:new-mission"',
    'paneId={slot.spawn.paneId}'
  ])
    assert.ok(board.includes(paneId), `painel fora do limite isolado: ${paneId}`)
  assert.match(board, /paneId=\{`board-general:\$\{projectId\}`\}[\s\S]*<ProjectGeneral/)
  assert.match(board, /paneId=\{`mission-delivery:\$\{selMission\.id\}`\}[\s\S]*<MissionDeliveryRail/)
  assert.match(board, /paneId=\{`mission-column:\$\{projectId\}`\}[\s\S]*<MissionColumn/)
  assert.match(seats, /<GuiPanelErrorBoundary[\s\S]*<TerminalPane/)
  // As QUATRO abas do universo (board, backlog, arquivos, mapa). Era 5 até
  // 2026-08-15, quando o gate "quem é o Maestro deste projeto?" foi removido:
  // o overlay era o quinto limite. Cada aba é conferida pelo paneId para o
  // número não poder cair sem alguém notar QUAL painel saiu do limite.
  assert.ok((universe.match(/<GuiPanelErrorBoundary/g) ?? []).length >= 4)
  for (const view of ['board', 'backlog', 'arquivos', 'mapa'])
    assert.match(universe, new RegExp(`paneId=\\{\`view:\\$\\{projectId\\}:${view}\`\\}`))
  assert.doesNotMatch(universe, /SeatGate/)
  assert.match(home, /paneId="overlay:home:new-universe"/)
  assert.match(settings, /paneId="settings:accounts"/)
  assert.match(main, /paneId="overlay:progress"/)
  assert.match(phone, /<GuiPanelErrorBoundary[\s\S]*<MobileViewport/)
  assert.match(bootstrap, /query\.get\('view'\) === 'mobile-phone'[\s\S]*import\('\.\/components\/MobilePhone'\)[\s\S]*else\s*\{\s*void import\('\.\/mainApp'\)/)
  assert.doesNotMatch(bootstrap, /import .* from ['"]\.\/App|installDevMock\(|startRendererPerfWatchdog\(/)
})

test('boundary React mantém o irmão, remonta no retry e recupera por paneId', async () => {
  const React = await import('react')
  const { Component, Fragment, createElement } = React
  const { create } = await import('react-test-renderer')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const tempRoot = join(process.cwd(), '.tmp')
  mkdirSync(tempRoot, { recursive: true })
  const boundaryDir = mkdtempSync(join(tempRoot, 'gui-panel-boundary-'))
  const boundaryFile = join(boundaryDir, 'GuiPanelErrorBoundary.mjs')
  const boundarySource = boundary
    .replace(/import '\.\/GuiPanelErrorBoundary\.css'\r?\n/u, '')
  let compiled = transformSync(boundarySource, {
    loader: 'tsx',
    format: 'esm',
    jsx: 'transform'
  }).code.replace(
    'import { Component, Fragment } from "react";',
    'import React, { Component, Fragment } from "react";'
  )
  compiled = compiled.replace(
    /export\s*\{[^}]*GuiPanelErrorBoundary as default[^}]*\};/u,
    'export { GuiPanelErrorBoundary as default, Component };'
  )
  assert.match(compiled, /static getDerivedStateFromError/)
  writeFileSync(boundaryFile, compiled, 'utf8')

  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const module = await import(`${pathToFileURL(boundaryFile).href}?test=${Date.now()}`)
    const Boundary = module.default
    assert.equal(typeof Boundary, 'function')
    assert.equal(typeof Boundary.getDerivedStateFromError, 'function')
    assert.equal(Boundary.prototype instanceof Component, true)
    assert.equal(module.Component, Component)
    assert.equal(Boundary.prototype.isReactComponent !== undefined, true)

    let paneId = 'one'
    let throwOnce = true
    let constructed = 0
    let mounted = 0

    class ThrowOnce extends Component {
      constructor(props) {
        super(props)
        constructed += 1
      }

      componentDidMount() {
        mounted += 1
      }

      render() {
        if (throwOnce) {
          throw new Error('conteúdo privado que não pode aparecer')
        }
        return createElement('span', { 'data-role': 'surface' }, `painel ${this.props.paneId}`)
      }
    }

    const tree = () =>
      createElement(
        Fragment,
        null,
        createElement(
          Boundary,
          { paneId, label: 'painel <sensível>' },
          createElement(ThrowOnce, { paneId })
        ),
        createElement('span', { 'data-role': 'sibling' }, 'chat vizinho')
      )

    const renderer = create(tree(), { unstable_isConcurrent: false })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(findRenderedText(renderer.toJSON(), 'chat vizinho'), true)
    assert.equal(findRenderedText(renderer.toJSON(), 'tentar de novo'), true)
    assert.doesNotMatch(findRenderedTextValue(renderer.toJSON()), /conteúdo privado/)
    assert.match(findRenderedTextValue(renderer.toJSON()), /painel <sensível> encontrou um erro/u)

    throwOnce = false
    renderer.root.findByType('button').props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(findRenderedText(renderer.toJSON(), 'painel one'), true)
    assert.equal(findRenderedText(renderer.toJSON(), 'chat vizinho'), true)
    assert.equal(mounted, 1)
    assert.ok(constructed >= 2)

    // Falha de novo e troca de identidade: o pane novo limpa o fallback e
    // monta uma superfície nova, sem tocar no irmão.
    throwOnce = true
    renderer.update(tree())
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(findRenderedText(renderer.toJSON(), 'tentar de novo'), true)

    throwOnce = false
    paneId = 'two'
    renderer.update(tree())
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(findRenderedText(renderer.toJSON(), 'painel two'), true)
    assert.equal(findRenderedText(renderer.toJSON(), 'chat vizinho'), true)
    assert.ok(constructed >= 4)
    renderer.unmount()
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100))
    console.error = originalConsoleError
    rmSync(boundaryDir, { recursive: true, force: true })
  }
})

function findRenderedText(node, text) {
  return findRenderedTextValue(node).includes(text)
}

function findRenderedTextValue(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(findRenderedTextValue).join('')
  return findRenderedTextValue(node.children)
}

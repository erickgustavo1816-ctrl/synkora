import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const compiled = buildSync({ stdin: { contents: `
  export * from './workspacePanels'
  export * from './workspace/useWorkspaceLayout'
  export * from './workspace/WorkspacePanelContext'
  export { default as DockSection } from './components/DockSection'
  export { default as WorkspacePanels } from './workspace/WorkspacePanels'
  export { default as MissionHeaderActions } from './workspace/MissionHeaderActions'
  export { focusProgressDelivery } from './progressNavigation'
`, resolveDir: 'src/renderer/src', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'react-dom'] }).outputFiles[0].text

function runtime() {
  const values = new Map()
  const observers = []
  const frames = []
  const window = Object.assign(new EventTarget(), { localStorage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)
  }, innerWidth: 1700, getComputedStyle: node => ({ flexDirection: node.stacked ? 'column' : 'row-reverse' }), requestAnimationFrame: run => { frames.push(run); return frames.length }, cancelAnimationFrame() {} })
  const loaded = { exports: {} }
  class Observer { constructor(run) { this.run = run; observers.push(this) } observe() {} disconnect() {} }
  new Function('require', 'module', 'exports', 'window', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports, window, Observer, window.requestAnimationFrame, window.cancelAnimationFrame)
  return { ...loaded.exports, values, observers, flushFrames: () => { for (const run of frames.splice(0)) run() } }
}

test('regressão: reabrir uma coluna começa no mínimo e empilhar reinicia a divisão no meio', () => {
  const m = runtime()
  let state = m.normalizeWorkspacePreference({ columnWidths: [980, 860], rowSplits: [72, 31] })
  state = m.openWorkspacePanel(state, 'browser')
  assert.equal(state.columnWidths[0], 360)
  state = m.openWorkspacePanel({ ...state, rowSplits: [72, 31] }, 'frota')
  assert.equal(state.rowSplits[0], 50)
  state = m.openWorkspacePanel(state, 'trabalho')
  assert.equal(state.columnWidths[1], 360)
  state = m.openWorkspacePanel({ ...state, rowSplits: [50, 31] }, 'historico')
  assert.equal(state.rowSplits[1], 50)
})

test('regressão: terceiro painel abre à direita e no mínimo', async t => {
  const h = await harness(t)
  for (const id of ['browser', 'frota', 'trabalho']) await h.run('openPanel', id)
  assert.equal(h.panel('browser').props.style.gridColumn, 1)
  assert.equal(h.panel('trabalho').props.style.gridColumn, 2)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Largura de Trabalho' }).props['aria-valuenow'], 360)
})

test('regressão: aumentar qualquer coluna cede a vizinha e respeita a largura total', async t => {
  const h = await harness(t)
  for (const id of ['browser', 'frota', 'trabalho']) await h.run('openPanel', id)
  await h.resize(1500)
  const grow = async label => act(() => h.tree.root.findByProps({ 'aria-label': label }).props.onKeyDown({ key: 'End', preventDefault() {}, stopPropagation() {} }))
  await grow('Largura de Browser e Frota')
  assert.deepEqual(h.controller().preference.columnWidths, [744, 360])
  await grow('Largura de Trabalho')
  assert.deepEqual(h.controller().preference.columnWidths, [360, 744])
  const deck = h.tree.root.findByProps({ className: 'workspace-panel-deck is-overlay' })
  assert.equal(deck.props.style.width, 1116)
  assert.equal(h.controller().preference.columnWidths.reduce((sum, width) => sum + width, 12), deck.props.style.width)
})

test('regressão: duplo clique no cabeçalho encaixa tanto o mínimo quanto o overlay no limite do chat', async t => {
  const covered = []
  const h = await harness(t, { onCovered: value => covered.push(value) })
  await h.run('openPanel', 'browser')
  const fit = async () => act(() => h.panel('browser').findByProps({ className: 'workspace-panel-head' }).props.onDoubleClick())
  await fit()
  assert.equal(h.controller().preference.maximized, null)
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 1016)
  await h.run('setColumnWidth', 1300)
  assert.equal(covered.at(-1), true)
  await fit()
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 1016)
  assert.equal(covered.at(-1), true, 'o chat continua coberto durante a redução animada')
  const deck = h.tree.root.findByProps({ className: 'workspace-panel-deck' })
  const target = {}
  await act(() => deck.props.onTransitionEnd({ target, currentTarget: target, propertyName: 'width' }))
  assert.equal(covered.at(-1), false)
  assert.deepEqual(h.unmounts, [])
})

test('regressão: encaixar a segunda coluna minimiza a primeira e continua sem overlay ao estreitar', async t => {
  const h = await harness(t)
  for (const id of ['browser', 'frota', 'trabalho']) await h.run('openPanel', id)
  await h.run('setColumnWidth', 800)
  await act(() => h.panel('trabalho').findByProps({ className: 'workspace-panel-head' }).props.onDoubleClick())
  assert.equal(h.controller().preference.maximized, null)
  assert.deepEqual(h.controller().preference.columnWidths, [360, 644])
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 1016)
  await h.resize(1300)
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 616)
  await h.resize(1700)
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 1016)
  assert.deepEqual(h.unmounts, [])
})

test('regressão: duplo clique na divisória também encaixa sem overlay', async t => {
  const h = await harness(t)
  await h.run('openPanel', 'browser')
  const separator = h.tree.root.findByProps({ 'aria-label': 'Largura de Browser' })
  assert.equal(typeof separator.props.onDoubleClick, 'function')
  await act(() => separator.props.onDoubleClick())
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 1016)
})

test('redução do overlay mantém a camada e o chat inerte até a transição terminar', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const covered = []
  const h = await harness(t, { onCovered: value => covered.push(value) })
  await h.run('openPanel', 'browser')
  await h.run('setColumnWidth', 1300)
  await act(() => h.panel('browser').findByProps({ className: 'workspace-panel-head' }).props.onDoubleClick())
  const deck = () => h.tree.root.findByProps({ className: 'workspace-panel-deck' })
  assert.equal(deck().props['data-overlay-leaving'], true)
  assert.equal(covered.at(-1), true)
  const target = {}
  await act(() => deck().props.onTransitionEnd({ target: {}, currentTarget: target, propertyName: 'width' }))
  await act(() => deck().props.onTransitionEnd({ target, currentTarget: target, propertyName: 'opacity' }))
  assert.equal(deck().props['data-overlay-leaving'], true, 'transições dos filhos não encerram a redução do deck')
  await act(() => deck().props.onTransitionEnd({ target, currentTarget: target, propertyName: 'width' }))
  assert.notEqual(deck().props['data-overlay-leaving'], true)
  assert.equal(covered.at(-1), false)

  await h.run('setColumnWidth', 1300)
  await act(() => h.panel('browser').findByProps({ className: 'workspace-panel-head' }).props.onDoubleClick())
  await act(() => t.mock.timers.tick(253))
  assert.notEqual(deck().props['data-overlay-leaving'], true, 'o fallback encerra a camada se o browser omitir transitionend')
  assert.equal(covered.at(-1), false)

  await h.run('setColumnWidth', 1300)
  await act(() => h.panel('browser').findByProps({ className: 'workspace-panel-head' }).props.onDoubleClick())
  await h.update({ projectId: 'B' })
  assert.equal(covered.at(-1), false, 'a camada em saída não acompanha a troca de projeto')
  await h.run('openPanel', 'frota')
  assert.notEqual(deck().props['data-overlay-leaving'], true)
})

test('geometria compartilha o limite entre uma a quatro colunas sem alterar as preferências', () => {
  const m = runtime()
  for (const count of [1, 2, 3, 4]) for (const board of [0, 320, 800, 1300.5, 1700, 2500]) for (const fit of [false, true]) {
    const widths = Object.freeze(Array.from({ length: count }, (_, column) => column % 2 ? 360 : 1800))
    const layout = m.workspacePanelLayout(board, 252, count, widths, false, count, fit)
    const sizes = m.fitWorkspaceColumnWidths(widths, layout.width)
    const gap = Math.min(12, layout.width / Math.max(1, count - 1))
    assert.ok(sizes.every(width => Number.isFinite(width) && width >= 0))
    assert.ok(sizes.reduce((sum, width) => sum + width, 0) + (count - 1) * gap <= layout.width + 0.001)
    if (fit) assert.equal(layout.overlay, false)
    const limit = m.workspacePanelLimit(board, 252)
    for (let active = 0; active < count; active++) {
      const resized = m.resizeWorkspaceColumns(sizes, active, 2400, limit)
      const bounds = m.workspaceColumnBounds(limit, count)
      assert.ok(resized.every(width => width >= bounds.minimum))
      assert.ok(resized.reduce((sum, width) => sum + width, 0) <= bounds.budget)
    }
  }
})

test('encaixe persiste por projeto e só o próximo redimensionamento libera overlay', async t => {
  const h = await harness(t)
  await h.run('openPanel', 'browser')
  await act(() => h.panel('browser').findByProps({ className: 'workspace-panel-head' }).props.onDoubleClick())
  assert.equal(h.controller().preference.fitToChat, true)
  await h.update({ projectId: 'B' })
  assert.equal(h.controller().preference.fitToChat, false)
  await h.update({ projectId: 'A' })
  assert.equal(h.controller().preference.fitToChat, true)
  await h.resize(1300)
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 616)
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Largura de Browser' }).props.onKeyDown({ key: 'End', preventDefault() {}, stopPropagation() {} }))
  assert.equal(h.controller().preference.fitToChat, false)
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck is-overlay' }).props.style.width, 916)
})

test('redimensionar a coluna visível conserva os tamanhos dos painéis incompatíveis', async t => {
  const h = await harness(t)
  for (const id of ['trabalho', 'historico', 'browser']) await h.run('openPanel', id)
  await h.run('setColumnWidth', 680)
  await h.update({ available: h.m.availableWorkspacePanels(true, true) })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Largura de Browser' }).props.onDoubleClick())
  assert.deepEqual(h.controller().preference.columnWidths, [680, 1016])
  await h.update({ available: h.m.availableWorkspacePanels(false, true) })
  assert.equal(h.panel('trabalho').props.hidden, false)
  assert.equal(h.panel('browser').props.style.gridColumn, 2)
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-deck' }).props.style.width, 1016)
})

test('preferências validam dados, toleram storage quebrado e isolam projetos', () => {
  const m = runtime()
  assert.deepEqual(m.normalizeWorkspacePreference(null), { panels: [], columns: [], maximized: null, fitToChat: false, sidebarCollapsed: false, columnWidths: [360, 360], rowSplits: [50, 50] })
  assert.deepEqual(m.normalizeWorkspacePreference({ panels: ['frota', 'frota', {}, 'browser'], maximized: 'trabalho', columnWidth: -30, sidebarCollapsed: 'true' }),
    { panels: ['frota', 'browser'], columns: [['frota', 'browser']], maximized: null, fitToChat: false, columnWidths: [360, 360], sidebarCollapsed: false, rowSplits: [50, 50] })
  assert.deepEqual(m.normalizeWorkspacePreference({ columnWidth: Infinity }).columnWidths, [360, 360])
  assert.deepEqual(m.normalizeWorkspacePreference({ columnWidth: 9999 }).columnWidths, [2400, 2400])
  assert.equal(m.readWorkspacePreference({ getItem: () => '{broken' }, 'A').panels.length, 0)
  assert.notEqual(m.workspaceStorageKey('A / B'), m.workspaceStorageKey('A'))
})

test('abrir não duplica janelas e fechar preserva a ordem das restantes', () => {
  const m = runtime()
  let state = m.normalizeWorkspacePreference(null)
  for (const id of ['frota', 'trabalho', 'browser', 'frota']) state = m.openWorkspacePanel(state, id)
  assert.deepEqual(state.panels, ['frota', 'trabalho', 'browser'])
  state = m.closeWorkspacePanel({ ...state, maximized: 'trabalho' }, 'trabalho')
  assert.deepEqual(state.panels, ['frota', 'browser'])
  assert.equal(state.maximized, null)
  assert.equal(m.openWorkspacePanel({ ...state, maximized: 'browser' }, 'frota').maximized, null)
})

test('janelas ocupam duas linhas por coluna e sobrepõem o chat quando falta largura', () => {
  const m = runtime()
  assert.deepEqual(m.workspacePanelLayout(1700, 252, 1, 520, false), { width: 520, reservedWidth: 520, columns: 1, overlay: false })
  assert.deepEqual(m.workspacePanelLayout(1300, 252, 3, 520, false), { width: 916, reservedWidth: 616, columns: 2, overlay: true })
  assert.deepEqual(m.workspacePanelLayout(1300, 0, 1, 520, true), { width: 1300, reservedWidth: 520, columns: 1, overlay: true })
  assert.equal(m.workspacePanelLayout(320, 0, 6, 520, false).width, 320)
  assert.equal(m.workspacePanelLayout(320, 500, 1, 520, false).width, 0)
  assert.equal(m.workspacePanelLayout(1000, 240, 0, 520, false).overlay, false)
  assert.deepEqual([0, 1, 2].map(i => m.workspacePanelPosition(i, 3, false)), [
    { column: 1, row: 1, span: 1 }, { column: 1, row: 2, span: 1 }, { column: 2, row: 1, span: 2 }
  ])
  for (let count = 1; count <= 6; count++) {
    const cells = new Set()
    for (let i = 0; i < count; i++) {
      const { column, row, span } = m.workspacePanelPosition(i, count, false)
      for (let y = row; y < row + span; y++) { const key = `${column}:${y}`; assert.ok(!cells.has(key)); cells.add(key) }
    }
  }
  assert.deepEqual(m.workspacePanelPosition(4, 6, true), { column: 1, row: 1, span: 2 })
})

async function harness(t, extra = {}) {
  const m = runtime()
  let controller
  let width = 1700
  const mounts = new Map()
  const unmounts = []
  const visibility = []
  const board = { stacked: false, style: { setProperty() {}, removeProperty() {} }, getBoundingClientRect: () => ({ width, top: 0 }), querySelector: (selector) => selector === '.mission-col'
    ? { getBoundingClientRect: () => ({ width: controller.preference.sidebarCollapsed ? 0 : board.stacked ? width : 240 }) } : null }
  const ref = { current: null }
  function Content({ id }) {
    const visible = React.useContext(m.WorkspacePanelVisibility)
    const [stamp] = React.useState(() => { const stamp = (mounts.get(id) ?? 0) + 1; mounts.set(id, stamp); return stamp })
    React.useLayoutEffect(() => { visibility.push([id, visible]) }, [id, visible])
    React.useEffect(() => () => unmounts.push(id), [id])
    return React.createElement('p', { 'data-content': id, 'data-stamp': stamp }, id)
  }
  function Harness({ projectId, available, visible, onCovered }) {
    controller = m.useWorkspaceLayout(projectId)
    return React.createElement('div', { ref, 'data-qa-board': true },
      React.createElement(Content, { id: 'chat' }),
      React.createElement(m.WorkspacePanels, { projectId, controller, available, visible, enabled: true, legacyEnabled: true, boardRef: ref, onCovered },
        React.createElement('div', { className: 'delivery-rail dock' },
          m.WORKSPACE_PANELS.map(({ id, title }) => React.createElement(m.DockSection, { id, title, key: id }, React.createElement(Content, { id }))))))
  }
  let props = { projectId: 'A', available: m.availableWorkspacePanels(false, true), visible: true, ...extra }
  let tree
  await act(() => { tree = create(React.createElement(Harness, props), { createNodeMock: node => node.props['data-qa-board'] ? board : ({ querySelector: () => null, clientWidth: width }) }) })
  await act(() => m.flushFrames())
  const enter = async () => { await act(() => m.flushFrames()); await act(() => m.flushFrames()) }
  t.after(async () => { await act(() => tree.unmount()) })
  return { m, tree, mounts, unmounts, visibility,
    controller: () => controller,
    run: async (method, ...args) => { await act(() => controller[method](...args)); await enter() },
    update: async patch => { props = { ...props, ...patch }; await act(() => tree.update(React.createElement(Harness, props))); await enter() },
    resize: async (size, stacked = false) => { width = size; board.stacked = stacked; await act(() => m.observers.forEach(observer => observer.run())) },
    panel: id => tree.root.findByProps({ 'data-workspace-panel': id }),
    click: async label => { await act(() => tree.root.findByProps({ 'aria-label': label }).props.onClick()); await enter() }
  }
}

test('painéis reais abrem sob demanda; fechar, ampliar e reordenar não remontam chat ou conteúdo', async t => {
  const h = await harness(t)
  assert.deepEqual([...h.mounts.keys()], ['chat'])
  await h.run('openPanel', 'frota')
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Painéis da missão' }).props.style.width, 360, 'a medida funciona quando o ref do Board chega depois do layout do filho')
  await h.run('openPanel', 'trabalho')
  await h.run('openPanel', 'browser')
  assert.deepEqual(h.panel('browser').props.style, { gridColumn: 2, gridRow: 1, alignSelf: 'start', height: '100%' })
  await h.click('Ampliar Trabalho')
  assert.equal(h.panel('browser').props.hidden, true)
  assert.deepEqual(h.visibility.filter(([id]) => id === 'browser').at(-1), ['browser', false])
  await h.click('Restaurar Trabalho')
  assert.equal(h.panel('browser').props.hidden, false)
  await h.click('Fechar Frota')
  assert.equal(h.panel('frota').props.inert, true)
  assert.deepEqual(h.panel('browser').props.style, { gridColumn: 2, gridRow: 1, alignSelf: 'start', height: '100%' })
  await h.run('openPanel', 'frota')
  await h.run('toggleSidebar')
  await h.run('closeAll')
  await h.run('openPanel', 'browser')
  assert.deepEqual(h.unmounts, [])
  assert.ok([...h.mounts.values()].every(value => value === 1))
})

test('troca de projeto restaura preferências e o escopo nunca recebe as escolhas do anterior', async t => {
  const h = await harness(t)
  await h.run('openPanel', 'browser')
  await h.run('toggleSidebar')
  await h.run('setColumnWidth', 620)
  await h.update({ projectId: 'B' })
  assert.deepEqual(h.controller().preference.panels, [])
  assert.equal(h.controller().preference.sidebarCollapsed, false)
  await h.run('openPanel', 'frota')
  await h.update({ projectId: 'A' })
  assert.deepEqual(h.controller().preference.panels, ['browser'])
  assert.equal(h.controller().preference.sidebarCollapsed, true)
  assert.deepEqual(h.controller().preference.columnWidths, [620, 360])
  assert.deepEqual(JSON.parse(h.m.values.get(h.m.workspaceStorageKey('B'))).panels, ['frota'])
})

test('missão de planejamento e projeto fora de vista escondem somente seus painéis incompatíveis', async t => {
  const h = await harness(t)
  for (const id of ['trabalho', 'browser', 'frota']) await h.run('openPanel', id)
  await h.update({ available: h.m.availableWorkspacePanels(true, true) })
  assert.equal(h.panel('trabalho').props['aria-hidden'], true)
  assert.equal(h.panel('browser').props.hidden, false)
  await h.update({ visible: false })
  assert.deepEqual(h.visibility.filter(([id]) => id === 'browser').at(-1), ['browser', false])
  await h.update({ visible: true, available: h.m.availableWorkspacePanels(false, true) })
  assert.equal(h.panel('trabalho').props.hidden, false)
  assert.deepEqual(h.visibility.filter(([id]) => id === 'browser').at(-1), ['browser', true])
})

test('resize e teclado mantêm painéis dentro da área disponível e guardam a largura', async t => {
  const h = await harness(t)
  await h.run('openPanel', 'browser')
  await h.run('setColumnWidth', 520)
  await h.resize(780)
  let deck = h.tree.root.findByProps({ className: 'workspace-panel-deck is-overlay' })
  assert.ok(deck.props.className.includes('is-overlay'))
  assert.equal(deck.props.style.width, 396)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Painéis da missão' }).props.style.width, 96)
  await h.run('toggleSidebar')
  await h.resize(1600)
  deck = h.tree.root.findByProps({ className: 'workspace-panel-deck' })
  assert.ok(!deck.props.className.includes('is-overlay'))
  for (const [key, expected] of [['End', 1468], ['ArrowLeft', 1468], ['Home', 360], ['ArrowRight', 360], ['ArrowLeft', 384]]) {
    await act(() => h.tree.root.findByProps({ 'aria-label': 'Largura de Browser' }).props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} }))
    assert.equal(h.controller().preference.columnWidths[0], expected)
  }
})

test('o deck em overlay avisa o Board, que deixa o palco inerte (ordem do dono, 09/09)', async t => {
  const covered = []
  const h = await harness(t, { onCovered: (value) => covered.push(value) })
  assert.equal(covered.at(-1), false, 'sem painel nenhum o chat está livre')
  await h.run('openPanel', 'browser')
  await h.resize(780)
  assert.ok(h.tree.root.findByProps({ className: 'workspace-panel-deck is-overlay' }))
  assert.equal(covered.at(-1), true, 'painel por cima do chat = chat coberto')
  await h.run('toggleSidebar')
  await h.resize(1600)
  assert.equal(covered.at(-1), false, 'deck de volta ao espaço reservado = chat livre')
  await h.run('closePanel', 'browser')
  assert.equal(covered.at(-1), false)
  // O Board traduz o aviso em `inert` + classe no palco: nada do chat aceita
  // clique nem foco enquanto o painel o cobre.
  const board = readFileSync(new URL('../src/renderer/src/components/Board.tsx', import.meta.url), 'utf8')
  assert.match(board, /onCovered=\{setChatCovered\}/u)
  assert.match(board, /inert=\{chatCovered \|\| undefined\}/u)
  assert.match(board, /chatCovered \? ' is-covered' : ''/u)
  const css = readFileSync(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  assert.match(css, /\.maestro-window\.stage-window\.is-covered \{[^}]*opacity/u, 'a nesga visível diz que está atrás')
})

test('atalho da entrega foca a ação no cabeçalho sem executar integração', () => {
  const m = runtime()
  let focused = 0
  let done = 0
  m.focusProgressDelivery({ querySelector: selector => selector === '.workspace-integrate-button' ? { focus: () => focused++ } : null }, () => done++)
  m.flushFrames()
  assert.equal(focused, 1)
  assert.equal(done, 1)
})

test('a lista horizontal da tela compacta não é descontada como largura lateral', async t => {
  const h = await harness(t)
  await h.run('openPanel', 'browser')
  await h.run('setColumnWidth', 520)
  await h.resize(868, true)
  const deck = h.tree.root.findByProps({ className: 'workspace-panel-deck is-overlay' })
  assert.equal(deck.props.style.width, 520)
  assert.ok(deck.props.className.includes('is-overlay'))
})

test('o chat conserva a largura mínima quando o painel ultrapassa o limite', () => {
  const m = runtime()
  const before = m.workspacePanelLayout(1300, 252, 1, 600, false)
  const limit = m.workspacePanelLayout(1300, 252, 1, 616, false)
  const over = m.workspacePanelLayout(1300, 252, 1, 760, false)
  assert.equal(before.reservedWidth, 600)
  assert.equal(limit.reservedWidth, 616)
  assert.equal(over.reservedWidth, limit.reservedWidth, 'sobrepor não devolve a área reservada ao chat')
  assert.equal(over.width, 760)
  assert.equal(over.overlay, true)
  assert.equal(m.workspacePanelLayout(1300, 252, 1, 760, true).reservedWidth, over.reservedWidth)
})

test('preferências antigas descartam Arquivos e Entrega e cada coluna guarda sua altura', () => {
  const m = runtime()
  const state = m.normalizeWorkspacePreference({ panels: ['browser', 'arquivos', 'entrega', 'frota'], maximized: 'entrega', rowSplits: [66, -80] })
  assert.deepEqual(state.panels, ['browser', 'frota'])
  assert.equal(state.maximized, null)
  assert.deepEqual(state.rowSplits, [66, 20])
  assert.deepEqual(m.normalizeWorkspacePreference({ rowSplits: [NaN, Infinity] }).rowSplits, [50, 50])
})

test('arrastar e usar o teclado muda a altura só do par escolhido sem remontar o browser', async t => {
  const h = await harness(t)
  for (const id of ['browser', 'frota', 'trabalho', 'historico']) await h.run('openPanel', id)
  const separator = () => h.tree.root.findByProps({ 'aria-label': 'Altura entre Browser e Frota' })
  let captured = false
  const currentTarget = { parentElement: { clientHeight: 612 }, setPointerCapture: () => { captured = true }, hasPointerCapture: () => captured, releasePointerCapture: () => { captured = false } }
  await act(() => separator().props.onPointerDown({ isPrimary: true, button: 0, pointerId: 1, clientY: 100, currentTarget, preventDefault() {} }))
  assert.equal(separator().props['data-dragging'], true, 'o destaque continua enquanto o ponteiro está preso à divisória')
  await act(() => separator().props.onPointerMove({ pointerId: 2, clientY: 190 }))
  assert.deepEqual(h.controller().preference.rowSplits, [50, 50], 'outro ponteiro não assume o arraste')
  await act(() => separator().props.onPointerMove({ pointerId: 1, clientY: 190 }))
  assert.deepEqual(h.controller().preference.rowSplits, [65, 50])
  assert.equal(h.panel('browser').props.style.height, 'calc(65% - 7.8px)')
  assert.equal(h.panel('frota').props.style.height, 'calc(35% - 4.2px)')
  assert.equal(h.panel('trabalho').props.style.height, 'calc(50% - 6px)')
  await act(() => separator().props.onPointerUp({ pointerId: 1, currentTarget }))
  assert.equal(captured, false)
  assert.notEqual(separator().props['data-dragging'], true)
  await act(() => separator().props.onPointerMove({ pointerId: 1, clientY: 280 }))
  assert.equal(h.controller().preference.rowSplits[0], 65)
  await act(() => separator().props.onKeyDown({ key: 'ArrowUp', currentTarget, preventDefault() {}, stopPropagation() {} }))
  assert.equal(h.controller().preference.rowSplits[0], 60)
  await h.update({ projectId: 'B' })
  assert.deepEqual(h.controller().preference.rowSplits, [50, 50])
  await h.update({ projectId: 'A' })
  assert.deepEqual(h.controller().preference.rowSplits, [60, 50])
  await act(() => separator().props.onDoubleClick())
  assert.deepEqual(h.controller().preference.rowSplits, [50, 50])
  assert.deepEqual(h.unmounts, [])
  assert.equal(h.mounts.get('browser'), 1)
  assert.equal(h.m.workspaceRowSplit(20, 252), 50, 'janelas curtas reservam altura para os dois cabeçalhos')
})

test('cabeçalho mantém quatro ações e as guardas de integração, revisão e planejamento', async () => {
  const m = runtime()
  const called = []
  const callbacks = Object.fromEntries(['Integrate', 'TestServer', 'KillTestServer', 'Review', 'Archive', 'Conclude'].map(name => [`on${name}`, () => called.push(name)]))
  const mission = { id: 'synthetic', status: 'ativa' }
  const base = { mission, planning: false, guiAvailable: true, reviewReady: true, testServerOpen: false, ...callbacks }
  let tree
  await act(() => { tree = create(React.createElement(m.MissionHeaderActions, base)) })
  const button = label => tree.root.findByProps({ 'aria-label': label })
  try {
    assert.equal(tree.root.findAllByType('button').length, 4)
    for (const label of ['Subir missão', 'Abrir terminal de teste', 'Solicitar revisão', 'Arquivar missão']) {
      assert.equal(button(label).props.disabled, false)
      await act(() => button(label).props.onClick())
    }
    assert.deepEqual(called, ['Integrate', 'TestServer', 'Review', 'Archive'])
    await act(() => tree.update(React.createElement(m.MissionHeaderActions, { ...base, reviewReady: false, testServerOpen: true,
      mission: { ...mission, integration: { state: 'queued' } } })))
    assert.equal(button('Subir missão').props.disabled, true)
    assert.equal(button('Solicitar revisão').props.disabled, true)
    await act(() => button('Parar servidor de teste').props.onClick())
    assert.equal(called.at(-1), 'KillTestServer')
    await act(() => tree.update(React.createElement(m.MissionHeaderActions, { ...base, mission: { ...mission, integration: { state: 'sync_required' } } })))
    assert.equal(button('Retomar integração').props.disabled, false)
    await act(() => tree.update(React.createElement(m.MissionHeaderActions, { ...base, planning: true })))
    assert.equal(button('Concluir planejamento').props.disabled, false)
    assert.equal(button('Abrir terminal de teste').props.disabled, true)
    assert.equal(button('Solicitar revisão').props.disabled, true)
    await act(() => button('Concluir planejamento').props.onClick())
    assert.equal(called.at(-1), 'Conclude')
    await act(() => tree.update(React.createElement(m.MissionHeaderActions, { ...base, mission: { ...mission, status: 'arquivada' } })))
    assert.equal(button('Subir missão').props.disabled, true)
    assert.equal(button('Reativar missão').props.disabled, false)
  } finally { await act(() => tree.unmount()) }
})

test('o terceiro painel tem uma divisória própria e redimensiona só sua coluna', async t => {
  const h = await harness(t)
  for (const id of ['browser', 'frota', 'trabalho']) await h.run('openPanel', id)
  const separator = () => h.tree.root.findByProps({ 'aria-label': 'Largura de Trabalho' })
  assert.equal(separator().props['aria-orientation'], 'vertical')
  assert.equal(h.panel('trabalho').props.style.gridColumn, 2, 'a nova coluna abre à direita')
  assert.equal(h.panel('browser').props.style.gridColumn, 1)
  await act(() => separator().props.onKeyDown({ key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} }))
  assert.deepEqual(h.controller().preference.columnWidths, [360, 384])
  await h.run('openPanel', 'historico')
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Largura de Trabalho e Histórico' }).props['aria-valuenow'], 384)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Largura de Browser e Frota' }).props['aria-valuenow'], 360)
  await h.update({ projectId: 'B' })
  assert.deepEqual(h.controller().preference.columnWidths, [360, 360])
  await h.update({ projectId: 'A' })
  assert.deepEqual(h.controller().preference.columnWidths, [360, 384])
  assert.deepEqual(h.unmounts, [])
})

test('fechar mantém a moldura durante a saída, mas retira foco e browser nativo imediatamente', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = await harness(t)
  await h.run('openPanel', 'browser')
  await h.run('closePanel', 'browser')
  assert.equal(h.panel('browser').props.hidden, false)
  assert.equal(h.panel('browser').props.inert, true)
  assert.equal(h.panel('browser').props['aria-hidden'], true)
  assert.deepEqual(h.visibility.filter(([id]) => id === 'browser').at(-1), ['browser', false])
  assert.ok(h.tree.root.findByProps({ 'aria-label': 'Painéis da missão' }).props.className.includes('is-closing'))
  await act(() => t.mock.timers.tick(221))
  assert.equal(h.panel('browser').props.hidden, true)
  assert.ok(h.tree.root.findByProps({ 'aria-label': 'Painéis da missão' }).props.className.includes('is-empty'))
  await h.run('openPanel', 'browser')
  assert.equal(h.panel('browser').props.hidden, false)
  assert.equal(h.mounts.get('browser'), 1)
  assert.deepEqual(h.unmounts, [])
})

test('arranjo por arraste cria colunas e empilha até dois painéis, preservando os tamanhos', () => {
  const m = runtime()
  let state = m.normalizeWorkspacePreference({ panels: ['browser', 'frota', 'trabalho', 'historico'], columnWidths: [620, 720] })
  assert.deepEqual(state.columns, [['browser', 'frota'], ['trabalho', 'historico']])
  state = m.moveWorkspacePanel(state, 'trabalho', { panel: 'browser', edge: 'right' })
  assert.deepEqual(state.columns, [['browser', 'frota'], ['trabalho'], ['historico']])
  assert.deepEqual(state.columnWidths, [620, 720, 720])
  state = m.moveWorkspacePanel(state, 'historico', { panel: 'trabalho', edge: 'below' })
  assert.deepEqual(state.columns, [['browser', 'frota'], ['trabalho', 'historico']])
  assert.equal(m.canMoveWorkspacePanel(state, 'browser', { panel: 'trabalho', edge: 'below' }), false)
  assert.deepEqual(m.moveWorkspacePanel(state, 'browser', { panel: 'trabalho', edge: 'below' }), state)
  state = m.moveWorkspacePanel(state, 'historico', { panel: 'browser', edge: 'left' })
  state = m.moveWorkspacePanel(state, 'frota', { panel: 'browser', edge: 'left' })
  assert.deepEqual(state.columns, [['historico'], ['frota'], ['browser'], ['trabalho']])
  assert.equal(state.columns.length, 4)
  assert.ok(state.columns.every(column => column.length <= 2))
  const restored = m.normalizeWorkspacePreference(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored, state)
  const malformed = m.normalizeWorkspacePreference({ panels: ['browser', 'frota', 'trabalho', 'historico'], columns: [['browser', 'frota', 'trabalho'], ['browser', 'historico', 'unknown']] })
  assert.ok(malformed.columns.every(column => column.length <= 2))
  assert.equal(new Set(malformed.columns.flat()).size, 4)
})

test('a primeira abertura pinta o espaço fechado antes de expandir e preserva a montagem', async t => {
  const h = await harness(t)
  await act(() => h.controller().openPanel('browser'))
  const slot = () => h.tree.root.findByProps({ 'aria-label': 'Painéis da missão' })
  assert.equal(slot().props.style.width, 0)
  assert.ok(slot().props.className.includes('is-opening'))
  assert.ok(!slot().props.className.includes('is-empty'))
  assert.deepEqual(h.visibility.filter(([id]) => id === 'browser').at(-1), ['browser', false])
  await act(() => h.m.flushFrames())
  assert.equal(slot().props.style.width, 0, 'o primeiro quadro ainda conserva a origem da transição')
  await act(() => h.m.flushFrames())
  assert.equal(slot().props.style.width, 360)
  assert.ok(h.panel('browser').props.className.includes('is-open'))
  assert.equal(h.mounts.get('browser'), 1)
})

test('restaurar um projeto não repete a abertura e sair encerra a animação em andamento', async t => {
  const h = await harness(t)
  const slot = () => h.tree.root.findByProps({ 'aria-label': 'Painéis da missão' })
  await h.run('openPanel', 'browser')
  assert.ok(slot().props.className.includes('is-opening'), 'new openings still animate')
  await h.update({ visible: false })
  assert.ok(!slot().props.className.includes('is-opening'), 'leaving settles the opening')
  await h.update({ visible: true })
  assert.ok(!slot().props.className.includes('is-opening'))
  assert.ok(!h.panel('browser').props.className.includes('is-unentered'))
  assert.equal(slot().props.style.width, 360)
  await h.update({ projectId: 'B' })
  assert.deepEqual(h.controller().preference.panels, [])
  await h.update({ projectId: 'A' })
  assert.ok(!slot().props.className.includes('is-opening'), 'restoring stored open panels is immediate')
  assert.ok(!h.panel('browser').props.className.includes('is-unentered'))
  assert.equal(slot().props.style.width, 360)
  assert.equal(h.mounts.get('browser'), 1)
})

test('mover painéis no grid real conserva conteúdo, larguras e no máximo duas linhas', async t => {
  const h = await harness(t)
  for (const id of ['browser', 'frota', 'trabalho']) await h.run('openPanel', id)
  await h.run('movePanel', 'frota', { panel: 'trabalho', edge: 'below' })
  assert.equal(h.panel('browser').props.style.height, '100%')
  assert.equal(h.panel('frota').props.style.gridColumn, h.panel('trabalho').props.style.gridColumn)
  assert.equal(h.panel('frota').props.style.alignSelf, 'end')
  await h.run('movePanel', 'frota', { panel: 'trabalho', edge: 'left' })
  assert.deepEqual(['browser', 'frota', 'trabalho'].map(id => h.panel(id).props.style.gridColumn), [1, 2, 3])
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-grid' }).props.style.gridTemplateColumns, 'minmax(0, 360fr) minmax(0, 360fr) minmax(0, 360fr)')
  await h.run('closeAll')
  assert.equal(h.tree.root.findByProps({ className: 'workspace-panel-grid' }).props.style.gridTemplateColumns, 'minmax(0, 360fr) minmax(0, 360fr) minmax(0, 360fr)', 'as colunas conservam a largura durante a animação de saída')
  assert.deepEqual(h.unmounts, [])
  assert.ok([...h.mounts.values()].every(count => count === 1))
})

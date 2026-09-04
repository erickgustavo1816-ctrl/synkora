import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { progressView, progressFocus, progressTarget, progressAction, progressSignalLabel, createProgressRevisionGate } from '../src/renderer/src/progressPresentation.ts'
const { progressCompletionFeed } = await import(pathToFileURL(resolve(process.env.PROGRESS_HISTORY_SOURCE ?? 'src/renderer/src/progressHistory.ts')).href)

const at = '2026-09-04T12:00:00.000Z'
const row = (id, group = 'idle', extra = {}) => ({ id, projectId: 'a', title: id, group,
  state: group === 'working' ? 'working' : 'idle', tone: 'idle', label: `Estado ${id}`,
  updatedAt: at, sessionCount: 0, workingSessions: 0, pendingCount: 0, ...extra })
const project = (id, rows = [], completions = [], extra = {}) => ({ id, name: `Projeto ${id}`, state: 'idle', group: 'idle', tone: 'idle',
  label: 'Sem atividade', missing: false, coordinators: [], activeMissions: rows.map(r => ({ ...r, projectId: id })),
  recentCompletions: completions.map(r => ({ ...r, projectId: id })), ...extra })
const snapshot = (projects, revision = 1) => ({ revision, generatedAt: at, projects, totals: {
  projects: projects.length, activeProjects: projects.length, activeMissions: projects.flatMap(p => p.activeMissions).filter(r => r.kind !== 'general').length,
  activeCoordinators: 0, attentionMissions: 1, attentionProjects: 0, workingMissions: 1, deliveryMissions: 0, idleMissions: 1, recentCompletions: 0 } })
const mixed = snapshot([project('a', [row('idle'), row('working', 'working'), row('attention', 'attention', {
  paneId: 'pane-exact-reviewer', pendingCount: 1, pendingKind: 'question', workingSessions: 1, sessionCount: 2,
  detail: 'Resposta opcional.', activityAt: at }), row('general', 'working', { kind: 'general' })]),
  project('b', [row('delivery', 'delivery')])])

test('exclusive mission counts omit general planning and duplicate rows', () => {
  const data = structuredClone(mixed)
  data.projects[0].activeMissions.push(data.projects[0].activeMissions[0])
  const view = progressView(data)
  assert.deepEqual(view.counts, { all: 4, attention: 1, working: 1, delivery: 1, idle: 1 })
  assert.equal(view.generalCounts.all, 1)
  assert.equal(view.totalRows, 5)
  assert.equal(view.projects[0].activeMissions[0].id, 'attention')
})

test('filters, accent-insensitive title search and project scope compose', () => {
  assert.equal(progressView(mixed, 'working').projects[0].activeMissions.length, 2)
  assert.equal(progressView(mixed, 'attention', 'b').projects.length, 0)
  const data = snapshot([project('a', [row('one', 'idle', { title: 'Revisão de navegação' })]), project('b', [row('two')])])
  assert.equal(progressView(data, 'all', '', 'revisao').projects[0].activeMissions[0].id, 'one')
  assert.equal(progressView(data, 'all', 'b', 'revisao').counts.all, 0)
})

test('attention anywhere wins compact focus over working, delivery and idle', () => {
  const data = snapshot([project('z', [row('working', 'working')]), project('a', [row('attention', 'attention')])])
  assert.equal(progressFocus(data).mission.id, 'attention')
  assert.equal(progressFocus(snapshot([])), null)
})

test('exact pending conversation wins a simultaneous queue; response alone opens chat', () => {
  assert.deepEqual(progressTarget(row('m', 'attention', { paneId: 'reviewer', pendingCount: 1, queue: { state: 'queued' } })),
    { projectId: 'a', missionId: 'm', paneId: 'reviewer', destination: 'chat' })
  assert.equal(progressTarget(row('m', 'idle', { state: 'turn_finished', paneId: 'dev' })).destination, 'chat')
  assert.equal(progressTarget(row('m', 'attention', { state: 'ready_to_integrate', paneId: 'dev' })).destination, 'delivery')
  assert.equal(progressTarget(row('m', 'delivery')).destination, 'delivery')
  assert.equal(progressAction(row('m', 'idle')), 'Abrir missão')
})

test('general planning and completion navigation promise project context honestly', () => {
  assert.deepEqual(progressTarget(row('general', 'attention', { kind: 'general', paneId: 'planner', pendingCount: 1 })), { projectId: 'a', destination: 'project' })
  assert.equal(progressAction(row('general', 'attention', { kind: 'general', paneId: 'planner' })), 'Abrir projeto')
  assert.deepEqual(progressTarget(row('old', 'idle', { state: 'completed', paneId: 'dead' })), { projectId: 'a', missionId: 'old', destination: 'project' })
  assert.equal(progressAction(row('old', 'idle', { state: 'completed' })), 'Ver no projeto')
})

test('missing project remains actionable without manufacturing a mission', () => {
  const data = snapshot([project('missing', [], [], { missing: true, group: 'attention' })])
  assert.equal(progressView(data, 'attention').projects.length, 1)
  assert.equal(progressView(data, 'attention').counts.all, 0)
  assert.equal(progressView(data, 'working').projects.length, 0)
  assert.equal(progressFocus(data).project.id, 'missing')
  assert.equal(progressFocus(data).mission, null)
})

test('history deduplicates identities within a project but preserves cross-project completions', () => {
  const done = row('same', 'idle', { state: 'completed', completedAt: at })
  const data = snapshot([project('a', [], [done, done]), project('b', [], [done])])
  const feed = progressCompletionFeed(data, null, 10)
  assert.equal(feed.items.length, 2)
  assert.deepEqual(feed.items.map(item => progressTarget(item.mission).projectId), ['a', 'b'])
  assert.equal(progressCompletionFeed(data, at, 10).items.length, 0)
})

test('revision gate rejects older/equal results; silence changes only the age label', () => {
  const accept = createProgressRevisionGate()
  assert.equal(accept({ revision: 2 }), true)
  assert.equal(accept({ revision: 1 }), false)
  assert.equal(accept({ revision: 2 }), false)
  assert.equal(accept({ revision: 3 }), true)
  assert.equal(progressSignalLabel(undefined, 0), 'sem sinal de conversa')
  assert.equal(progressSignalLabel('invalid', 0), 'sem sinal de conversa')
  assert.equal(progressSignalLabel(at, Date.parse(at) + 3_600_000), 'há 1 h')
})

// Real React component bundled with local modules; the bridge is synthetic and
// cannot reach Electron, user projects or any external process.
const sourcePath = resolve(process.env.PROGRESS_OVERLAY_SOURCE ?? 'src/renderer/src/components/ProgressOverlay.tsx')
const compiled = buildSync({ stdin: { contents: readFileSync(sourcePath, 'utf8') + "\nexport { default as Radar } from './ProgressRadarButton'\n",
  resolveDir: resolve('src/renderer/src/components'), loader: 'tsx' }, bundle: true, platform: 'node',
  format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'react-dom'] })
const fakeWindow = { setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(), addEventListener() {}, removeEventListener() {} }
const fakeDocument = { body: {}, addEventListener() {}, removeEventListener() {} }
const loaded = { exports: {} }
const nativeRequire = createRequire(import.meta.url)
// Portal placement is browser QA; keep the real Select's state and keyboard
// behavior while rendering its portal children in this synthetic React tree.
const componentRequire = name => name === 'react-dom' ? { createPortal: children => children } : nativeRequire(name)
new Function('require', 'module', 'exports', 'window', 'document', compiled.outputFiles[0].text)(componentRequire, loaded, loaded.exports, fakeWindow, fakeDocument)
const Overlay = loaded.exports.default
const Radar = loaded.exports.Radar
globalThis.IS_REACT_ACT_ENVIRONMENT = true
function setup(getState) {
  const listeners = {}
  const commands = []
  fakeWindow.synkoraProgressOverlay = { getState, command: (...args) => commands.push(args), resize() {},
    onSnapshot: callback => { listeners.snapshot = callback; return () => { delete listeners.snapshot } },
    onMode: callback => { listeners.mode = callback; return () => { delete listeners.mode } },
    onHistory: callback => { listeners.history = callback; return () => { delete listeners.history } } }
  return { listeners, commands }
}
const button = (tree, label) => tree.root.findAllByType('button').find(node => node.props['aria-label'] === label)
const rowButtons = tree => tree.root.findAllByType('button').filter(node => node.props.className?.startsWith('progress-mission '))

test('custom project select filters real rows with pointer and keyboard and Escape preserves selection', async () => {
  setup(async () => ({ snapshot: mixed, compact: false, historyClearedAt: null }))
  let tree
  await act(async () => { tree = create(React.createElement(Overlay)) })
  try {
    assert.equal(tree.root.findAllByType('select').length, 0)
    const trigger = () => tree.root.findAllByType('button').find(node => node.props['aria-haspopup'] === 'listbox')
    assert.equal(trigger().props['aria-label'], 'Filtrar por projeto: Todos os projetos')
    await act(async () => trigger().props.onClick())
    const options = () => tree.root.findAllByProps({ role: 'option' })
    assert.equal(options().length, 3)
    await act(async () => options()[2].props.onClick())
    assert.equal(rowButtons(tree).length, 1)
    assert.deepEqual(rowButtons(tree)[0].findByProps({ className: 'progress-mission-title' }).children, ['delivery'])
    assert.equal(trigger().props['aria-label'], 'Filtrar por projeto: Projeto b')
    const key = async value => act(async () => trigger().props.onKeyDown({ key: value, preventDefault() {} }))
    await key('ArrowDown')
    await key('Home')
    await key('Escape')
    assert.equal(trigger().props['aria-expanded'], false)
    assert.equal(rowButtons(tree).length, 1)
    await key('ArrowDown')
    await key('Home')
    await key('Enter')
    assert.equal(rowButtons(tree).length, 5)
    assert.equal(trigger().props['aria-label'], 'Filtrar por projeto: Todos os projetos')
  } finally { await act(async () => tree.unmount()) }
})

test('real UI filters rows and opens exact optional pending conversation without losing working signal', async () => {
  const { commands } = setup(async () => ({ snapshot: mixed, compact: false, historyClearedAt: null }))
  let tree
  await act(async () => { tree = create(React.createElement(Overlay)) })
  try {
    assert.equal(rowButtons(tree).length, 5)
    assert.match(JSON.stringify(tree.toJSON()), /Continua trabalhando/)
    const attentionFilter = tree.root.findAllByType('button').find(node => node.props.className === 'progress-filter group-attention')
    await act(async () => attentionFilter.props.onClick())
    assert.equal(rowButtons(tree).length, 1)
    await act(async () => rowButtons(tree)[0].props.onClick())
    assert.deepEqual(commands.at(-1), ['open-target', { projectId: 'a', missionId: 'attention', paneId: 'pane-exact-reviewer', destination: 'chat' }])
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: 'no match' } }))
    assert.match(JSON.stringify(tree.toJSON()), /Nenhuma missão neste filtro/)
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Sem missões em acompanhamento/)
  } finally { await act(async () => tree.unmount()) }
})

test('late initial response never overwrites pushed compact mode, history watermark or snapshot', async () => {
  let resolveInitial
  const { listeners } = setup(() => new Promise(resolve => { resolveInitial = resolve }))
  let tree
  await act(async () => { tree = create(React.createElement(Overlay)) })
  try {
    const pushed = structuredClone(mixed)
    pushed.revision = 2
    pushed.projects[0].recentCompletions = [row('done', 'idle', { state: 'completed', completedAt: at })]
    await act(async () => { listeners.snapshot(pushed); listeners.mode({ compact: true }); listeners.history({ clearedAt: at }) })
    await act(async () => resolveInitial({ snapshot: snapshot([], 1), compact: false, historyClearedAt: null }))
    assert.equal(tree.root.findAllByProps({ className: 'progress-overlay-shell compact' }).length, 1)
    assert.ok(button(tree, 'Ver pendência no chat: attention'))
    await act(async () => listeners.mode({ compact: false }))
    assert.equal(rowButtons(tree).length, 5)
    assert.equal(button(tree, 'Abrir contexto de done em Projeto a'), undefined)
  } finally { await act(async () => tree.unmount()) }
})

test('radar never sums project attention with the same attention missions', async () => {
  let resolveInitial, push
  fakeWindow.synkora = { progress: {
    onSnapshot: listener => { push = listener; return () => {} },
    getSnapshot: () => new Promise(resolve => { resolveInitial = resolve }), openOverlay: async () => {}
  } }
  let tree
  await act(async () => { tree = create(React.createElement(Radar)) })
  try {
    const next = { ...mixed, revision: 2, totals: { ...mixed.totals, attentionMissions: 1, attentionProjects: 1 } }
    await act(async () => push(next))
    await act(async () => resolveInitial({ ...mixed, revision: 1, totals: { ...mixed.totals, attentionMissions: 7 } }))
    assert.deepEqual(tree.root.findByType('b').children, ['1'])
    assert.match(tree.root.findByType('button').props['aria-label'], /1 trabalhando/)
    assert.doesNotMatch(tree.root.findByType('button').props['aria-label'], /coordenação/)
  } finally { await act(async () => tree.unmount()) }
})

test('unavailable UI is honest, retry recovers and clear-history keeps its watermark command', async () => {
  let attempts = 0
  const done = row('done', 'idle', { state: 'completed', completedAt: at })
  const data = snapshot([project('a', [], [done])])
  const { commands } = setup(async () => { if (++attempts === 1) throw Error('synthetic'); return { snapshot: data, compact: false, historyClearedAt: null } })
  let tree
  await act(async () => { tree = create(React.createElement(Overlay)) })
  try {
    assert.match(JSON.stringify(tree.toJSON()), /Andamento indisponível/)
    const retry = tree.root.findAllByType('button').find(node => node.children.includes('Tentar novamente'))
    await act(async () => retry.props.onClick())
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Andamento indisponível/)
    await act(async () => button(tree, 'Ocultar o histórico concluído desta janela — as missões não serão apagadas').props.onClick())
    assert.deepEqual(commands.at(-1), ['clear-history'])
    assert.match(JSON.stringify(tree.toJSON()), /Nenhuma missão foi apagada/)
    assert.equal(button(tree, 'Abrir contexto de done em Projeto a'), undefined)
  } finally { await act(async () => tree.unmount()) }
})

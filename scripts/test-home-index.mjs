import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

// The Home index (search · filters · sort · group tabs) is a pure model:
// renderer/homeIndexModel.ts. Bundled on the fly so the suite runs the real
// module, with the shared layout queries it depends on.
const compiled = buildSync({
  entryPoints: ['src/renderer/src/homeIndexModel.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false
}).outputFiles[0].text

const loaded = { exports: {} }
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports)
const model = loaded.exports

const NOW = new Date('2026-09-29T12:00:00')

function project(id, overrides = {}) {
  return {
    id,
    name: id,
    path: `C:\\Projetos\\${id}`,
    createdAt: '2026-05-02T12:00:00',
    running: false,
    attention: false,
    activeMissions: 0,
    missing: false,
    ...overrides
  }
}

const PROJECTS = [
  project('synkora', { name: 'Synkora', path: 'C:\\Users\\Erick\\Desktop\\Synkora', running: true, activeMissions: 2 }),
  project('nucleo-site', { name: 'Nucleo Site', path: 'C:\\Projetos\\nucleo\\site', createdAt: '2026-07-14T12:00:00' }),
  project('luma', { name: 'Luma Landing', path: 'C:\\Projetos\\nucleo\\luma-landing', createdAt: '2026-09-24T12:00:00', activeMissions: 1 }),
  project('perdcomp', { name: 'PERDCOMP Fila', path: 'D:\\trib\\perdcomp-fila', createdAt: '2026-06-03T12:00:00', attention: true }),
  project('compensacao', { name: 'Compensação', path: 'D:\\trib\\compensacao', createdAt: '2026-09-25T12:00:00', running: true }),
  project('barbearia', { name: 'App Barbearia', path: 'C:\\Projetos\\barbearia-app', createdAt: '2026-08-08T12:00:00' }),
  project('rust', { name: 'Estudos Rust', path: 'C:\\estudos\\rust', createdAt: '2025-04-20T12:00:00', missing: true })
]

const LAYOUT = {
  entries: [
    { kind: 'project', projectId: 'synkora' },
    { kind: 'group', id: 'g-nucleo', name: 'Nucleo', hue: 315, open: false, projectIds: ['nucleo-site', 'luma'] },
    { kind: 'group', id: 'g-trib', name: 'Tributário', hue: null, open: true, projectIds: ['perdcomp', 'compensacao'] },
    { kind: 'project', projectId: 'barbearia' },
    { kind: 'project', projectId: 'rust' }
  ],
  lastOpenedAt: {
    synkora: '2026-09-29T11:20:00',
    luma: '2026-09-27T10:05:00',
    perdcomp: '2026-09-29T10:40:00',
    barbearia: '2026-09-15T19:20:00'
  }
}

const view = (overrides = {}) => ({ ...model.HOME_VIEW_DEFAULT, states: [], ...overrides })
const ids = (list) => list.map((p) => p.id)
const index = (overrides = {}, query = '', layout = LAYOUT, projects = PROJECTS) =>
  model.computeHomeIndex({ projects, layout, view: view(overrides), query, now: NOW })

test('search folds accents and case and looks at name, folder and group name', () => {
  assert.equal(model.foldText('Compensação'), 'compensacao')
  assert.equal(model.foldText('LEITOR Métricas'), 'leitor metricas')
  assert.deepEqual(ids(index({}, 'COMPENSACAO').shown), ['compensacao'])
  assert.deepEqual(ids(index({}, 'nucleo\\luma').shown), ['luma'], 'folder path matches')
  assert.deepEqual(ids(index({}, 'tributario').shown), ['perdcomp', 'compensacao'], 'group name matches')
  assert.deepEqual(ids(index({}, '   ').shown), ids(PROJECTS), 'blank query is no filter')
  assert.deepEqual(ids(index({}, 'synkora c:').shown), [], 'a query never spans two fields')
})

test('highlight maps the folded match back onto the original text', () => {
  assert.deepEqual(model.highlightMatch('Compensação', 'sacao'), { before: 'Compen', match: 'sação', after: '' })
  assert.deepEqual(model.highlightMatch('D:\\trib\\compensacao', 'TRIB'), {
    before: 'D:\\',
    match: 'trib',
    after: '\\compensacao'
  })
  assert.deepEqual(model.highlightMatch('a😀b', 'b'), { before: 'a😀', match: 'b', after: '' })
  assert.equal(model.highlightMatch('Synkora', 'rust'), null)
  assert.equal(model.highlightMatch('Synkora', '  '), null)
})

test('states combine with OR and an empty selection means every universe', () => {
  assert.deepEqual(ids(index({ states: ['running'] }).shown), ['synkora', 'compensacao'])
  assert.deepEqual(ids(index({ states: ['attention', 'missing'] }).shown), ['perdcomp', 'rust'])
  assert.deepEqual(ids(index({ states: ['active'] }).shown), ['synkora', 'luma'])
  assert.equal(index({ states: [] }).shown.length, PROJECTS.length)
})

test('the creation period counts back from now, and the year is the calendar year', () => {
  assert.deepEqual(ids(index({ period: '7' }).shown), ['luma', 'compensacao'])
  assert.deepEqual(ids(index({ period: '90' }).shown), ['nucleo-site', 'luma', 'compensacao', 'barbearia'])
  assert.equal(index({ period: 'year' }).shown.some((p) => p.id === 'rust'), false)
  assert.equal(model.matchesPeriod('not a date', '30', NOW), false, 'an unreadable date never proves a period')
  assert.equal(model.matchesPeriod('not a date', 'any', NOW), true)
})

test('tab counts obey every other filter but never the tab itself', () => {
  const result = index({ group: 'g-trib', states: ['running'] })
  assert.deepEqual(
    result.tabs.map((t) => [t.key, t.label, t.count]),
    [
      ['all', 'todos', 2],
      ['g-nucleo', 'Nucleo', 0],
      ['g-trib', 'Tributário', 1],
      ['none', 'sem grupo', 1]
    ]
  )
  assert.deepEqual(ids(result.shown), ['compensacao'])
  assert.equal(result.tab, 'g-trib')
})

test('the SEM GRUPO tab exists only while some universe is loose; no layout means only TODOS', () => {
  const allGrouped = {
    entries: [{ kind: 'group', id: 'g1', name: 'Tudo', hue: null, open: false, projectIds: ['a', 'b'] }],
    lastOpenedAt: {}
  }
  const two = [project('a'), project('b')]
  assert.deepEqual(index({}, '', allGrouped, two).tabs.map((t) => t.key), ['all', 'g1'])
  assert.equal(index({ group: 'none' }, '', allGrouped, two).tab, 'all', 'a vanished SEM GRUPO falls back')
  const flat = index({ group: 'g-trib' }, '', null)
  assert.deepEqual(flat.tabs.map((t) => t.key), ['all'])
  assert.equal(flat.tab, 'all')
  assert.equal(flat.sections, null, 'without a layout the Home is one flat grid')
  assert.equal(index({ group: 'g-gone' }).tab, 'all', 'a dissolved group falls back to TODOS')
})

test('rail order follows the layout flattened, with unknown universes at the end', () => {
  const extra = [...PROJECTS, project('fresh', { name: 'Fresh' })]
  assert.deepEqual(ids(index({ sort: 'rail' }, '', LAYOUT, extra).shown), [
    'synkora', 'nucleo-site', 'luma', 'perdcomp', 'compensacao', 'barbearia', 'rust', 'fresh'
  ])
  assert.deepEqual(ids(index({ sort: 'rail' }, '', null, [...PROJECTS].reverse()).shown), ids([...PROJECTS].reverse()))
})

test('abertos por último uses lastOpenedAt and never-opened universes go last in rail order', () => {
  assert.deepEqual(ids(index({ sort: 'opened', grouped: false }).shown), [
    'synkora', 'perdcomp', 'luma', 'barbearia', 'nucleo-site', 'compensacao', 'rust'
  ])
})

test('creation and name orders', () => {
  assert.deepEqual(ids(index({ sort: 'newest', grouped: false }).shown), [
    'compensacao', 'luma', 'barbearia', 'nucleo-site', 'perdcomp', 'synkora', 'rust'
  ])
  assert.deepEqual(ids(index({ sort: 'oldest', grouped: false }).shown)[0], 'rust')
  const named = [project('b', { name: 'Bola' }), project('a2', { name: 'Árvore' }), project('a1', { name: 'abelha' })]
  assert.deepEqual(ids(index({ sort: 'name' }, '', null, named).shown), ['a1', 'a2', 'b'])
})

test('por grupo: one section per group in layout order, SEM GRUPO last, empty sections skipped', () => {
  const grouped = index({ grouped: true })
  assert.deepEqual(
    grouped.sections.map((s) => [s.key, ids(s.items), s.total]),
    [
      ['g-nucleo', ['nucleo-site', 'luma'], 2],
      ['g-trib', ['perdcomp', 'compensacao'], 2],
      ['none', ['synkora', 'barbearia', 'rust'], 3]
    ]
  )
  const filtered = index({ grouped: true, states: ['running'] })
  assert.deepEqual(
    filtered.sections.map((s) => [s.key, ids(s.items), s.total]),
    [
      ['g-trib', ['compensacao'], 2],
      ['none', ['synkora'], 3]
    ]
  )
  assert.equal(index({ grouped: true, group: 'g-trib' }).sections, null, 'a chosen tab is a grid without header')
  assert.equal(index({ grouped: false }).sections, null)
})

test('group tag only in todos juntos with TODOS, and the date bit follows sort and period', () => {
  assert.equal(index({ grouped: false }).showGroupTag, true)
  assert.equal(index({ grouped: false, group: 'g-trib' }).showGroupTag, false)
  assert.equal(index({ grouped: true }).showGroupTag, false)
  assert.equal(index({ sort: 'rail' }).dateMode, null)
  assert.equal(index({ sort: 'newest' }).dateMode, 'created')
  assert.equal(index({ sort: 'rail', period: '30' }).dateMode, 'created')
  assert.equal(index({ sort: 'opened' }).dateMode, 'opened')
})

test('active tokens, the filter badge and clearing', () => {
  const result = index({ states: ['missing', 'running'], period: '30' }, 'nucleo')
  assert.deepEqual(
    result.tokens.map((t) => [t.kind, t.id, t.label]),
    [
      ['query', 'query', 'busca “nucleo”'],
      ['state', 'running', 'rodando agora'],
      ['state', 'missing', 'pasta sumida'],
      ['period', '30', 'criados nos últimos 30 dias']
    ]
  )
  assert.equal(result.filterCount, 3)
  assert.equal(result.total, PROJECTS.length)
  assert.deepEqual(index().tokens, [], 'nothing active, no tokens')

  const current = view({ group: 'g-trib', states: ['running', 'missing'], period: '30', sort: 'name', grouped: false })
  assert.deepEqual(model.removeToken(current, result.tokens[1]).states, ['missing'])
  assert.equal(model.removeToken(current, result.tokens[3]).period, 'any')
  assert.deepEqual(model.clearFilters(current), view({ sort: 'name', grouped: false }))
  assert.equal(model.periodLabel('year', NOW), 'em 2026')
})

test('the remembered view round-trips and every unknown value falls back to its default', () => {
  const saved = view({ group: 'g-trib', states: ['running', 'missing'], period: '90', sort: 'opened', grouped: false })
  assert.deepEqual(model.parseHomeView(model.serializeHomeView(saved)), saved)
  assert.deepEqual(
    model.parseHomeView(model.serializeHomeView({ ...saved, states: ['missing', 'running'] })).states,
    ['running', 'missing'],
    'states come back in the canonical order'
  )
  assert.equal(model.HOME_VIEW_STORAGE_KEY, 'synkora.home.view.v1')
  assert.deepEqual(model.parseHomeView(null), model.HOME_VIEW_DEFAULT)
  assert.deepEqual(model.parseHomeView('{not json'), model.HOME_VIEW_DEFAULT)
  assert.deepEqual(model.parseHomeView('[1,2]'), model.HOME_VIEW_DEFAULT)
  assert.deepEqual(
    model.parseHomeView(JSON.stringify({ group: 7, states: ['running', 'bogus', 'running', 'attention'], period: '365', sort: 'activity', grouped: 'yes' })),
    view({ states: ['running', 'attention'] })
  )
  const withQuery = JSON.parse(model.serializeHomeView({ ...saved, query: 'segredo' }))
  assert.equal('query' in withQuery, false, 'the search text is never persisted')
})

test('card dates read like the mockup', () => {
  assert.equal(model.formatCreatedDate('2026-09-24T12:00:00'), '24 set 2026')
  assert.equal(model.formatCreatedDate('garbage'), null)
  assert.equal(model.formatOpenedAgo('2026-09-29T11:30:00', NOW), 'há 30 min')
  assert.equal(model.formatOpenedAgo('2026-09-29T09:50:00', NOW), 'há 2 h')
  assert.equal(model.formatOpenedAgo('2026-09-28T10:00:00', NOW), 'ontem')
  assert.equal(model.formatOpenedAgo('2026-09-17T12:00:00', NOW), 'há 12 dias')
  assert.equal(model.formatOpenedAgo('2026-06-29T12:00:00', NOW), 'há 3 meses')
  assert.equal(model.cardDateLabel('created', PROJECTS[2], null, NOW), 'criado 24 set 2026')
  assert.equal(model.cardDateLabel('opened', PROJECTS[0], '2026-09-29T10:00:00', NOW), 'aberto há 2 h')
  assert.equal(model.cardDateLabel('opened', PROJECTS[1], null, NOW), 'nunca aberto')
  assert.equal(model.cardDateLabel(null, PROJECTS[0], null, NOW), null)
})

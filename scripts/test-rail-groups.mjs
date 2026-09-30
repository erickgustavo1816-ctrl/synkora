// O RAIL COM GRUPOS — os dois módulos puros (missão "Nova features de Grupos",
// 2026-09-29; mockup aprovado: docs/mockups/grupos-universos-2026-09-29.html).
//
// railDragModel: das fileiras MEDIDAS + a altura do ponteiro + o que se
// arrasta → onde cai (os limiares do `computeTarget` do mockup), a operação
// do layout e a pílula "soltar: …".
// railGroupPresentation: as miniaturas da pasta, o sinal agregado, a pílula do
// ativo, a lista desenhada quando o layout ainda não chegou e as dicas.
//
// Rode: node --test scripts/test-rail-groups.mjs

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

// railDragModel importa consultas de runtime de src/shared/projectLayout (sem
// extensão, como o resto do renderer): empacota os dois módulos juntos.
const compiled = buildSync({
  stdin: {
    contents: `
      export * from './src/renderer/src/railDragModel';
      export * from './src/renderer/src/railGroupPresentation';
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false
}).outputFiles[0].text

const loaded = { exports: {} }
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports)
const {
  railDropAt,
  railDropOp,
  railDropHint,
  railDropHintText,
  railDragStarted,
  railAutoScrollStep,
  railEntries,
  railRenderedCount,
  railFolderMinis,
  railFolderSignal,
  railFolderHoldsActive,
  railProjectTip,
  railGroupMembersLine,
  railGroupHueLabel
} = loaded.exports

// ————— fixtures —————
// Um rail medido: tile solto (0–46), pasta fechada (56–108, com o nome), a
// cápsula aberta (118–300: cabeçalho 118–150, filhos 160–206 e 216–262, e a
// sobra 262–300 até o pé da cápsula), outro tile solto (310–356).
const rect = (top, bottom) => ({ top, bottom })
const SLOTS = [
  { kind: 'project', projectId: 'a', rect: rect(0, 46) },
  { kind: 'folder', groupId: 'g1', rect: rect(56, 108) },
  {
    kind: 'capsule',
    groupId: 'g2',
    rect: rect(118, 300),
    head: rect(118, 150),
    children: [
      { projectId: 'c1', rect: rect(160, 206) },
      { projectId: 'c2', rect: rect(216, 262) }
    ]
  },
  { kind: 'project', projectId: 'z', rect: rect(310, 356) }
]
const dragP = (projectId) => ({ kind: 'project', projectId })
const dragG = (groupId) => ({ kind: 'group', groupId })

const LAYOUT = {
  entries: [
    { kind: 'project', projectId: 'a' },
    { kind: 'group', id: 'g1', name: 'Nucleo', hue: 315, open: false, projectIds: ['n1', 'n2'] },
    { kind: 'group', id: 'g2', name: 'Tributário', hue: null, open: true, projectIds: ['c1', 'c2'] },
    { kind: 'project', projectId: 'z' }
  ],
  lastOpenedAt: {}
}
const NAMES = { a: 'Alfa', z: 'Zeta', c1: 'PERDCOMP', c2: 'SPED', n1: 'Nucleo Site', n2: 'Luma' }
const nameOf = (id) => NAMES[id] ?? id

// ————————————————————————————————————————————————————————————————
// railDropAt — os limiares do mockup
// ————————————————————————————————————————————————————————————————

test('tile solto: borda de cima = antes, borda de baixo = depois, centro = combinar', () => {
  const at = (y) => railDropAt(SLOTS, dragP('z'), y)
  // rel < 0.28 → antes; a linha fica no meio do vão (5 px acima)
  assert.deepEqual(at(10), {
    target: { type: 'before', ref: { kind: 'project', projectId: 'a' } },
    feedback: { kind: 'line', y: -5, inset: false }
  })
  // a fronteira dos 28%: 12,8 px (27,8%) ainda é antes, 13 px (28,3%) já é centro
  assert.deepEqual(at(12.8).target, { type: 'before', ref: { kind: 'project', projectId: 'a' } })
  assert.deepEqual(at(13).target, { type: 'combine', projectId: 'a' })
  assert.deepEqual(at(23), { target: { type: 'combine', projectId: 'a' }, feedback: { kind: 'combine', projectId: 'a' } })
  // e a dos 72%: 33 px (71,7%) é centro, 33,2 px (72,2%) é depois
  assert.deepEqual(at(33).target, { type: 'combine', projectId: 'a' })
  assert.deepEqual(at(33.2).target, { type: 'after', ref: { kind: 'project', projectId: 'a' } })
  // rel > 0.72 → depois
  assert.deepEqual(at(40), {
    target: { type: 'after', ref: { kind: 'project', projectId: 'a' } },
    feedback: { kind: 'line', y: 51, inset: false }
  })
})

test('pasta fechada: < 0.22 antes do grupo, > 0.84 depois, meio = entrar', () => {
  const at = (y) => railDropAt(SLOTS, dragP('a'), y)
  const h = 108 - 56
  assert.deepEqual(at(56 + 0.2 * h), {
    target: { type: 'before', ref: { kind: 'group', groupId: 'g1' } },
    feedback: { kind: 'line', y: 51, inset: false }
  })
  assert.deepEqual(at(56 + 0.5 * h), { target: { type: 'into', groupId: 'g1' }, feedback: { kind: 'into', groupId: 'g1' } })
  // fronteiras: 21,7% antes / 22,1% entrar; 83,8% entrar / 84,2% depois
  assert.deepEqual(at(67.3).target, { type: 'before', ref: { kind: 'group', groupId: 'g1' } })
  assert.deepEqual(at(67.5).target, { type: 'into', groupId: 'g1' })
  assert.deepEqual(at(99.6).target, { type: 'into', groupId: 'g1' })
  assert.deepEqual(at(99.8).target, { type: 'after', ref: { kind: 'group', groupId: 'g1' } })
  assert.deepEqual(at(56 + 0.9 * h), {
    target: { type: 'after', ref: { kind: 'group', groupId: 'g1' } },
    feedback: { kind: 'line', y: 113, inset: false }
  })
})

test('cabeçalho da cápsula: topo = antes do grupo; o resto = primeiro de dentro', () => {
  const at = (y) => railDropAt(SLOTS, dragP('a'), y)
  assert.deepEqual(at(118 + 0.2 * 32), {
    target: { type: 'before', ref: { kind: 'group', groupId: 'g2' } },
    feedback: { kind: 'line', y: 113, inset: false }
  })
  // 31% do cabeçalho já é "primeiro de dentro"
  assert.deepEqual(at(128), {
    target: { type: 'first-in', groupId: 'g2' },
    feedback: { kind: 'line', y: 155, inset: true }
  })
})

test('filho da cápsula: metade de cima = antes dele, de baixo = depois (linha recuada)', () => {
  const at = (y) => railDropAt(SLOTS, dragP('a'), y)
  assert.deepEqual(at(170), {
    target: { type: 'before', ref: { kind: 'project', projectId: 'c1' } },
    feedback: { kind: 'line', y: 155, inset: true }
  })
  assert.deepEqual(at(200), {
    target: { type: 'after', ref: { kind: 'project', projectId: 'c1' } },
    feedback: { kind: 'line', y: 211, inset: true }
  })
})

test('a sobra entre o último filho e o pé da cápsula tira do grupo (depois do grupo)', () => {
  assert.deepEqual(railDropAt(SLOTS, dragP('c1'), 280), {
    target: { type: 'after', ref: { kind: 'group', groupId: 'g2' } },
    feedback: { kind: 'line', y: 305, inset: false }
  })
})

test('no vão entre fileiras vale a mais próxima; soltar sobre si mesmo não faz nada', () => {
  // 50 fica a 4 px do tile "a" e a 6 px da pasta → depois de "a"
  assert.deepEqual(railDropAt(SLOTS, dragP('z'), 50).target, { type: 'after', ref: { kind: 'project', projectId: 'a' } })
  // 53 fica mais perto da pasta → antes do grupo
  assert.deepEqual(railDropAt(SLOTS, dragP('z'), 53).target, { type: 'before', ref: { kind: 'group', groupId: 'g1' } })
  assert.equal(railDropAt(SLOTS, dragP('a'), 23), null)
  assert.equal(railDropAt(SLOTS, dragP('c2'), 240), null)
  // abaixo de tudo: o último tile, lado de baixo
  assert.deepEqual(railDropAt(SLOTS, dragP('a'), 900).target, { type: 'after', ref: { kind: 'project', projectId: 'z' } })
  assert.equal(railDropAt([], dragP('a'), 10), null)
})

test('arrastar um grupo só oferece antes/depois no nível de cima', () => {
  const at = (y) => railDropAt(SLOTS, dragG('g1'), y)
  assert.deepEqual(at(10), {
    target: { type: 'before', ref: { kind: 'project', projectId: 'a' } },
    feedback: { kind: 'line', y: -5, inset: false }
  })
  assert.deepEqual(at(30).target, { type: 'after', ref: { kind: 'project', projectId: 'a' } })
  // a própria pasta é "si mesmo"
  assert.equal(at(80), null)
  // a cápsula inteira é UMA fileira (nada de entrar num grupo)
  assert.deepEqual(at(170), {
    target: { type: 'before', ref: { kind: 'group', groupId: 'g2' } },
    feedback: { kind: 'line', y: 113, inset: false }
  })
  assert.deepEqual(at(250), {
    target: { type: 'after', ref: { kind: 'group', groupId: 'g2' } },
    feedback: { kind: 'line', y: 305, inset: false }
  })
  // arrastando a cápsula aberta: ela mesma não é alvo
  assert.equal(railDropAt(SLOTS, dragG('g2'), 200), null)
})

// ————————————————————————————————————————————————————————————————
// railDropOp — o alvo vira a operação do main
// ————————————————————————————————————————————————————————————————

test('o alvo vira moveProject / moveGroup', () => {
  const combine = { type: 'combine', projectId: 'a' }
  assert.deepEqual(railDropOp(dragP('z'), combine), { op: 'moveProject', projectId: 'z', target: combine })
  const before = { type: 'before', ref: { kind: 'group', groupId: 'g2' } }
  assert.deepEqual(railDropOp(dragG('g1'), before), { op: 'moveGroup', groupId: 'g1', target: before })
  // grupo dentro de grupo não existe
  assert.equal(railDropOp(dragG('g1'), { type: 'into', groupId: 'g2' }), null)
  assert.equal(railDropOp(dragG('g1'), combine), null)
})

// ————————————————————————————————————————————————————————————————
// railDropHint — a pílula "soltar: …"
// ————————————————————————————————————————————————————————————————

test('a pílula diz o que acontece ao soltar', () => {
  const hint = (source, target) => railDropHintText(railDropHint(LAYOUT, nameOf, source, target))
  assert.equal(hint(dragP('z'), { type: 'combine', projectId: 'a' }), 'soltar: criar grupo com Alfa')
  assert.deepEqual(railDropHint(LAYOUT, nameOf, dragP('z'), { type: 'combine', projectId: 'a' }), {
    lead: 'soltar: ',
    em: 'criar grupo',
    tail: ' com Alfa'
  })
  assert.equal(hint(dragP('a'), { type: 'into', groupId: 'g1' }), 'soltar: entrar em Nucleo')
  assert.equal(hint(dragP('a'), { type: 'first-in', groupId: 'g2' }), 'soltar: entrar em Tributário')
  // de fora para perto de um filho = entrar naquele grupo
  assert.equal(hint(dragP('a'), { type: 'after', ref: { kind: 'project', projectId: 'c2' } }), 'soltar: entrar em Tributário')
  // de dentro para o nível de cima = sair
  assert.equal(hint(dragP('c1'), { type: 'after', ref: { kind: 'group', groupId: 'g2' } }), 'soltar: sair de Tributário')
  assert.deepEqual(railDropHint(LAYOUT, nameOf, dragP('c1'), { type: 'before', ref: { kind: 'project', projectId: 'z' } }), {
    lead: 'soltar: ',
    em: 'sair de Tributário',
    tail: ''
  })
  // reordenar dentro do mesmo grupo / no nível de cima = mover
  assert.equal(hint(dragP('c1'), { type: 'after', ref: { kind: 'project', projectId: 'c2' } }), 'soltar: mover PERDCOMP')
  assert.equal(hint(dragP('a'), { type: 'after', ref: { kind: 'project', projectId: 'z' } }), 'soltar: mover Alfa')
  assert.equal(hint(dragG('g1'), { type: 'after', ref: { kind: 'project', projectId: 'z' } }), 'soltar: mover Nucleo')
})

// ————————————————————————————————————————————————————————————————
// gesto: tolerância de 5 px e rolagem automática nas bordas
// ————————————————————————————————————————————————————————————————

test('o arraste só nasce depois de 5 px', () => {
  assert.equal(railDragStarted(3, 4), false)
  assert.equal(railDragStarted(0, 5), false)
  assert.equal(railDragStarted(4, 4), true)
  assert.equal(railDragStarted(-6, 0), true)
})

test('rolagem automática: 28 px de borda, sobe em cima, desce embaixo', () => {
  assert.equal(railAutoScrollStep(110, 100, 500), -8)
  assert.equal(railAutoScrollStep(127, 100, 500), -8)
  assert.equal(railAutoScrollStep(128, 100, 500), 0)
  assert.equal(railAutoScrollStep(300, 100, 500), 0)
  assert.equal(railAutoScrollStep(473, 100, 500), 8)
  assert.equal(railAutoScrollStep(600, 100, 500), 8)
  assert.equal(railAutoScrollStep(40, 100, 500), -8)
})

// ————————————————————————————————————————————————————————————————
// railGroupPresentation
// ————————————————————————————————————————————————————————————————

test('miniaturas: até 4 mostra todas; com mais, 3 e um +N', () => {
  assert.deepEqual(railFolderMinis(['a']), { ids: ['a'], more: 0 })
  assert.deepEqual(railFolderMinis(['a', 'b', 'c', 'd']), { ids: ['a', 'b', 'c', 'd'], more: 0 })
  assert.deepEqual(railFolderMinis(['a', 'b', 'c', 'd', 'e']), { ids: ['a', 'b', 'c'], more: 2 })
  assert.deepEqual(railFolderMinis(['a', 'b', 'c', 'd', 'e', 'f', 'g']), { ids: ['a', 'b', 'c'], more: 4 })
})

test('sinal da pasta: atenção > rodando > pausado > pasta sumida', () => {
  const m = (over) => ({ attention: false, activity: null, missing: false, ...over })
  assert.equal(railFolderSignal([]), null)
  assert.equal(railFolderSignal([m(), m()]), null)
  assert.equal(railFolderSignal([m({ missing: true }), m()]), 'missing')
  assert.equal(railFolderSignal([m({ missing: true }), m({ activity: 'paused' })]), 'paused')
  assert.equal(railFolderSignal([m({ activity: 'paused' }), m({ activity: 'running' })]), 'running')
  assert.equal(railFolderSignal([m({ activity: 'running' }), m({ attention: true }), m({ missing: true })]), 'attention')
  // universo de pasta sumida não pulsa nem mostra atividade (como o tile)
  assert.equal(railFolderSignal([m({ missing: true, attention: true, activity: 'running' })]), 'missing')
})

test('a pasta fechada ganha a pílula quando guarda o universo aberto', () => {
  assert.equal(railFolderHoldsActive(['a', 'b'], 'b'), true)
  assert.equal(railFolderHoldsActive(['a', 'b'], 'c'), false)
  assert.equal(railFolderHoldsActive(['a', 'b'], null), false)
})

test('sem layout o rail desenha a lista plana de projetos', () => {
  assert.deepEqual(railEntries(null, ['a', 'b']), [
    { kind: 'project', projectId: 'a' },
    { kind: 'project', projectId: 'b' }
  ])
})

test('com layout: some o desconhecido, o novo entra no fim, o grupo vazio some', () => {
  const layout = {
    entries: [
      { kind: 'project', projectId: 'gone' },
      { kind: 'group', id: 'g1', name: 'um', hue: null, open: false, projectIds: ['a', 'gone2'] },
      { kind: 'group', id: 'g2', name: 'dois', hue: null, open: true, projectIds: ['gone3'] },
      { kind: 'project', projectId: 'b' },
      { kind: 'project', projectId: 'a' }
    ],
    lastOpenedAt: {}
  }
  const entries = railEntries(layout, ['a', 'b', 'novo'])
  assert.deepEqual(entries, [
    { kind: 'group', id: 'g1', name: 'um', hue: null, open: false, projectIds: ['a'] },
    { kind: 'project', projectId: 'b' },
    { kind: 'project', projectId: 'novo' }
  ])
  // entrada intacta mantém a mesma referência (React não redesenha à toa)
  assert.equal(railEntries(LAYOUT, ['a', 'z', 'c1', 'c2', 'n1', 'n2'])[1], LAYOUT.entries[1])
})

test('contagem de nós desenhados (re-mede as bordas esmaecidas)', () => {
  assert.equal(railRenderedCount(LAYOUT.entries, true), 1 + 2 + 4 + 1)
  assert.equal(railRenderedCount(LAYOUT.entries, false), 1 + 1 + 3 + 1)
})

test('dica do universo: nome e estado, sem a linha do clique direito', () => {
  const idle = railProjectTip({ name: 'Alfa', missing: false, attention: false, activityLabel: 'Nenhum trabalho em aberto' })
  assert.equal(idle, 'Alfa\nNenhum trabalho em aberto')
  const asking = railProjectTip({ name: 'Alfa', missing: false, attention: true, activityLabel: 'Há trabalho em andamento' })
  assert.equal(asking, 'Alfa\nHá trabalho em andamento\n❓ um agente está esperando você aqui')
  const missing = railProjectTip({ name: 'Alfa', missing: true, attention: true, activityLabel: 'x' })
  assert.equal(missing, 'Alfa\npasta não encontrada — corrija na Home (📁 alterar pasta)')
  for (const tip of [idle, asking, missing]) assert.doesNotMatch(tip, /clique direito/u)
})

test('a folha lista os membros e nomeia as cores', () => {
  assert.equal(railGroupMembersLine(['Alfa']), '1 universo · Alfa')
  assert.equal(railGroupMembersLine(['Alfa', 'Zeta']), '2 universos · Alfa, Zeta')
  assert.equal(railGroupHueLabel(null), 'neutra')
  assert.equal(railGroupHueLabel(210), 'azul')
  assert.equal(railGroupHueLabel(21), 'laranja')
})

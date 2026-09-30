// O PROJETO SEM VERSIONAMENTO NA HOME E NO RAIL (2026-09-30; mockup aprovado:
// docs/mockups/projeto-sem-versao-2026-09-30.html cena 7, com a marca trocada
// pelo SELO DE PASTA — opção B de projeto-sem-versao-marca-2026-09-30.html).
//
// Os componentes de verdade (UniverseCard, ProjectRail) com o store de
// verdade, montados pelo react-test-renderer (o HTML estático do zustand lê o
// estado INICIAL do store, nunca o do teste); a ponte `window.synkora` é
// falsa.
//
// O que prende:
//  · o retrato da Home de um projeto sem versão é a missão ABERTA (título) e
//    quantas foram finalizadas — lido sem pedir versões ao main;
//  · o card diz "MISSÃO · <título>" com o ponto do turno, ou "nenhuma aberta ·
//    N finalizadas"; carrega o selo de pasta e a etiqueta "sem versionamento";
//    sem chip ◈ nem barra de progresso;
//  · o rail põe o selo só no avatar do universo sem versionamento e o nome
//    acessível diz o modo;
//  · o universo versionado segue exatamente como era.
//
// Rodar: node --test scripts/test-unversioned-home.mjs

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** react-test-renderer não desenha portal (o rail só usa no arraste/menu). */
const portalStub = {
  name: 'portal-stub',
  setup(b) {
    b.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'portal-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'portal-stub' }, () => ({
      contents: 'export function createPortal(node) { return node }',
      loader: 'js'
    }))
  }
}

const compiled = (
  await build({
    stdin: {
      contents: `
        export { useStore } from './src/renderer/src/store';
        export { default as UniverseCard } from './src/renderer/src/components/UniverseCard';
        export { default as ProjectRail } from './src/renderer/src/components/ProjectRail';
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    write: false,
    loader: { '.css': 'empty' },
    external: ['react', 'react/jsx-runtime', 'zustand'],
    plugins: [portalStub]
  })
).outputFiles[0].text

const windowStub = Object.assign(new EventTarget(), {
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  synkora: {}
})
class ResizeObserverStub { observe() {} disconnect() {} }
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', 'ResizeObserver', compiled)(
  createRequire(import.meta.url),
  loaded,
  loaded.exports,
  { documentElement: { style: { setProperty() {} } }, visibilityState: 'visible', body: {} },
  windowStub,
  { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
  ResizeObserverStub
)
const { useStore, UniverseCard, ProjectRail } = loaded.exports

// ————————————————————————— fixtures —————————————————————————

const VERSIONED = { id: 'sy', name: 'Synkora', path: 'C:\\Users\\Erick\\Desktop\\Synkora', createdAt: '2026-07-21T12:00:00.000Z' }
const SOLO = {
  id: 'pc',
  name: 'Proposta Clínica Vida',
  path: 'C:\\Users\\Erick\\Documents\\proposta-clinica',
  createdAt: '2026-09-25T12:00:00.000Z',
  versioning: 'none'
}

const mission = (over) => ({
  projectId: SOLO.id,
  status: 'ativa',
  createdAt: '2026-09-25T09:00:00.000Z',
  updatedAt: '2026-09-25T09:00:00.000Z',
  ...over
})

function setState(homeStats) {
  useStore.setState({
    projects: [VERSIONED, SOLO],
    homeStats,
    panesByProject: {},
    paneActivity: {},
    paneAttention: {},
    mountedProjects: [],
    missions: [],
    appPage: 'workspace',
    openProjectId: null
  })
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return (node.children ?? []).map(textOf).join(' ')
}
const plain = (node) => textOf(node).replace(/\s+/g, ' ').trim()
const classes = (node) => (typeof node.props.className === 'string' ? node.props.className.split(/\s+/) : [])
const byClass = (root, name) => root.findAll((n) => typeof n.type === 'string' && classes(n).includes(name))

/** A bridge mínima que os efeitos do rail e do card chamam ao montar. */
function quietBridge(extra = {}) {
  windowStub.synkora = {
    appUpdate: { status: async () => null, onStatus: () => () => {} },
    missions: { list: async () => [], onChanged: () => () => {} },
    ...extra
  }
}

const mounted = []
async function mount(element) {
  let tree
  await act(async () => { tree = create(element) })
  mounted.push(tree)
  return tree
}
test.afterEach(async () => {
  for (const tree of mounted.splice(0)) await act(async () => tree.unmount())
})

async function card(projectId) {
  quietBridge()
  const tree = await mount(React.createElement(UniverseCard, { projectId, index: 0, anchor: () => {} }))
  const root = tree.root
  const [work] = byClass(root, 'uc-work')
  return { root, work, tree }
}

const VERSIONED_STATS = {
  missoesAtivas: 2,
  versoes: [{ name: 'v0.4', lancada: false, missoesFeitas: 2, missoesTotal: 5 }],
  at: 1
}

// ————————————————————————— o retrato (store) —————————————————————————

test('o retrato de um projeto sem versionamento é a missão aberta e as finalizadas — sem ler versões', async () => {
  const versionReads = []
  windowStub.synkora = {
    missions: {
      list: async (projectId) =>
        projectId === SOLO.id
          ? [
              mission({ id: 'm-old-1', title: 'Montar a estrutura da proposta', status: 'concluida' }),
              mission({ id: 'm-open', title: 'Reescrever a seção de preços', status: 'ativa', direct: true }),
              mission({ id: 'm-old-2', title: 'Trocar a fonte do PDF', status: 'concluida' }),
              mission({ id: 'm-other', projectId: 'outro', title: 'de outro projeto', status: 'concluida' })
            ]
          : [mission({ id: 'v-1', projectId: VERSIONED.id, title: 'x', status: 'ativa', versionId: 'v1' })]
    },
    backlog: {
      listVersions: async (projectId) => {
        versionReads.push(projectId)
        return []
      }
    }
  }
  setState({})

  await useStore.getState().loadHomeStats(SOLO.id)
  const solo = useStore.getState().homeStats[SOLO.id]
  assert.deepEqual(solo.solo, { openMissionTitle: 'Reescrever a seção de preços', finished: 2 })
  assert.equal(solo.missoesAtivas, 1)
  assert.deepEqual(solo.versoes, [])
  assert.deepEqual(versionReads, [], 'projeto sem versão não pergunta versões ao main')

  await useStore.getState().loadHomeStats(VERSIONED.id)
  const versioned = useStore.getState().homeStats[VERSIONED.id]
  assert.deepEqual(versionReads, [VERSIONED.id], 'o versionado segue lendo as versões')
  assert.equal(versioned.solo, undefined)
})

// ————————————————————————— o card —————————————————————————

const soloStats = (solo, missoesAtivas = solo.openMissionTitle ? 1 : 0) => ({
  [SOLO.id]: { missoesAtivas, versoes: [], solo, at: 1 }
})

test('card com missão aberta: "missão" + título com o ponto do turno, selo de pasta e etiqueta do modo', async () => {
  setState(soloStats({ openMissionTitle: 'Reescrever a seção de preços', finished: 4 }))
  const { root, work } = await card(SOLO.id)
  assert.equal(plain(work), 'missão Reescrever a seção de preços')
  assert.equal(byClass(work, 'uc-solo').length, 1)
  const [dot] = byClass(work, 'dot')
  assert.ok(dot, 'o ponto do turno')
  assert.equal(dot.props['aria-hidden'], 'true')
  assert.equal(byClass(root, 'uc-progress').length, 0, 'sem versão, sem barra (barra vazia mentiria)')
  assert.equal(byClass(root, 'uc-version').length, 0, 'sem chip ◈')
  const [tag] = byClass(root, 'mode-tag')
  assert.equal(plain(tag), 'sem versionamento')
  const [seal] = byClass(root, 'uv-seal')
  assert.ok(seal, 'o selo de pasta na foto')
  assert.ok(classes(seal).includes('uv-seal--card'))
  assert.equal(seal.props['aria-hidden'], 'true')
  const open = root.find((n) => n.type === 'button' && classes(n).includes('uc-open-hit'))
  assert.equal(open.props['aria-label'], 'Abrir universo Proposta Clínica Vida (sem versionamento)')
})

test('card sem missão aberta: "nenhuma aberta · N finalizadas", no singular quando é uma', async () => {
  setState(soloStats({ openMissionTitle: null, finished: 4 }))
  assert.equal(plain((await card(SOLO.id)).work), 'missão nenhuma aberta · 4 finalizadas')

  setState(soloStats({ openMissionTitle: null, finished: 1 }))
  assert.equal(plain((await card(SOLO.id)).work), 'missão nenhuma aberta · 1 finalizada')

  setState(soloStats({ openMissionTitle: null, finished: 0 }))
  assert.equal(plain((await card(SOLO.id)).work), 'missão nenhuma aberta')
})

test('o ponto do turno só anima com trabalho rodando (movimento é sinal)', async () => {
  setState(soloStats({ openMissionTitle: 'Reescrever', finished: 0 }))
  const quiet = byClass((await card(SOLO.id)).work, 'dot')[0]
  assert.ok(quiet)
  assert.ok(!classes(quiet).includes('run'))
  useStore.setState({
    panesByProject: { [SOLO.id]: [{ id: 'gui-pc-dev', kind: 'claude', projectId: SOLO.id }] },
    paneActivity: { 'gui-pc-dev': 'run' },
    mountedProjects: [SOLO.id]
  })
  const running = byClass((await card(SOLO.id)).work, 'dot')[0]
  assert.ok(classes(running).includes('run'))
})

test('o card versionado segue como era: atividade, barra, chip ◈ e nenhum selo', async () => {
  setState({ [VERSIONED.id]: VERSIONED_STATS })
  const { root, work } = await card(VERSIONED.id)
  assert.equal(plain(work), 'atividade 2/5 missões')
  assert.equal(byClass(root, 'uc-progress').length, 1)
  assert.equal(plain(byClass(root, 'uc-version')[0]), '◈ v0.4')
  assert.equal(byClass(root, 'uv-seal').length, 0)
  assert.equal(byClass(root, 'mode-tag').length, 0)
  const open = root.find((n) => n.type === 'button' && classes(n).includes('uc-open-hit'))
  assert.equal(open.props['aria-label'], 'Abrir universo Synkora')
})

// ————————————————————————— o rail —————————————————————————

test('o rail põe o selo de pasta só no universo sem versionamento, e o nome acessível diz o modo', async () => {
  setState({})
  quietBridge()
  const tree = await mount(React.createElement(ProjectRail))
  const tile = (pid) => tree.root.find((n) => n.type === 'button' && n.props['data-pid'] === pid)
  const solo = tile(SOLO.id)
  const versioned = tile(VERSIONED.id)
  const [seal] = byClass(solo, 'uv-seal')
  assert.ok(seal, 'o selo no avatar sem versionamento')
  assert.ok(classes(seal).includes('uv-seal--rail'))
  assert.equal(seal.props['aria-hidden'], 'true')
  assert.match(solo.props['aria-label'], /^Proposta Clínica Vida \(sem versionamento\) — /)
  assert.match(solo.props['data-tip'], /^Proposta Clínica Vida\nsem versionamento\n/)
  assert.equal(byClass(versioned, 'uv-seal').length, 0)
  assert.doesNotMatch(versioned.props['aria-label'], /sem versionamento/)
})

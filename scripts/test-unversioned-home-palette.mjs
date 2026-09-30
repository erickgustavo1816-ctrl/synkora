// A PALETA (Ctrl K) NUM PROJETO SEM VERSIONAMENTO (2026-09-30; design:
// docs/DESIGN_PROJETO_SEM_VERSAO_2026-09-30.md §5 — "fora deste modo: abas
// Mapa/Versões, fontes commits/branches da paleta").
//
// A paleta de verdade, com o store de verdade, montada pelo
// react-test-renderer e aberta pelo mesmo Ctrl K do app.
//
// O que prende:
//  · projeto sem versão não oferece Mapa nem Versões, nem os filtros Commits e
//    Branches — e NÃO pede commits ao main (a tela nem chama o que o main
//    recusaria);
//  · a aba da missão se chama "Missão" e o status da missão sai em palavra do
//    modo (aberta/finalizada);
//  · um destino velho para Mapa/Versões cai na aba da missão;
//  · o projeto versionado segue com tudo.
//
// Rodar: node --test scripts/test-unversioned-home-palette.mjs

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
        export { default as CommandPalette } from './src/renderer/src/components/CommandPalette';
        export { navigateFromCommandPalette } from './src/renderer/src/commandPaletteNavigation';
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

const keyListeners = []
const windowStub = Object.assign(new EventTarget(), {
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  synkora: {}
})
const addEventListener = windowStub.addEventListener.bind(windowStub)
windowStub.addEventListener = (type, listener, options) => {
  if (type === 'keydown') keyListeners.push(listener)
  return addEventListener(type, listener, options)
}
class HTMLElementStub {}
const documentStub = {
  documentElement: { style: { setProperty() {} } },
  visibilityState: 'visible',
  body: {},
  activeElement: null
}
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', 'HTMLElement', 'requestAnimationFrame', 'cancelAnimationFrame', compiled)(
  createRequire(import.meta.url),
  loaded,
  loaded.exports,
  documentStub,
  windowStub,
  { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
  HTMLElementStub,
  windowStub.requestAnimationFrame,
  windowStub.cancelAnimationFrame
)
const { useStore, CommandPalette, navigateFromCommandPalette } = loaded.exports

// ————————————————————————— fixtures —————————————————————————

const VERSIONED = { id: 'sy', name: 'Synkora', path: 'C:\\dev\\synkora', createdAt: '2026-07-21T12:00:00.000Z' }
const SOLO = {
  id: 'pc',
  name: 'Proposta Clínica Vida',
  path: 'C:\\docs\\proposta-clinica',
  createdAt: '2026-09-25T12:00:00.000Z',
  versioning: 'none'
}
const MISSIONS = [
  { id: 'm-open', projectId: SOLO.id, title: 'Reescrever a seção de preços', status: 'ativa', direct: true, createdAt: 'x', updatedAt: 'x' },
  { id: 'm-done', projectId: SOLO.id, title: 'Trocar a fonte do PDF', status: 'concluida', direct: true, createdAt: 'x', updatedAt: 'x' },
  { id: 'v-m', projectId: VERSIONED.id, title: 'Rail com grupos', status: 'ativa', branch: 'mission/abc', baseBranch: 'main', createdAt: 'x', updatedAt: 'x' }
]

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

/** Paleta que ficou montada de um teste que reprovou continuaria ouvindo o
 *  store e pedindo commits no teste seguinte. */
const mounted = []
test.afterEach(async () => {
  for (const tree of mounted.splice(0)) await act(async () => tree.unmount())
})

/** Abre a paleta com o projeto aberto e devolve o que ela desenhou. */
async function openPalette(projectId) {
  const commitCalls = []
  windowStub.synkora = {
    files: { listDocs: async () => [{ name: 'proposta.md', path: 'proposta.md', group: 'docs' }] },
    missions: {
      list: async (projectId) => MISSIONS.filter((m) => m.projectId === projectId),
      commits: async (missionId) => {
        commitCalls.push(missionId)
        return { ok: true, commits: [{ sha: 'abc1234', subject: 'feat: rail' }] }
      }
    },
    history: { search: async () => ({ ok: true, hits: [] }), cancel() {} }
  }
  useStore.setState({
    projects: [VERSIONED, SOLO],
    openProjectId: projectId,
    missions: MISSIONS,
    universeTabByProject: {},
    missionTabByProject: {}
  })
  keyListeners.length = 0
  let tree
  await act(async () => { tree = create(React.createElement(CommandPalette)) })
  mounted.push(tree)
  await act(async () => {
    for (const listener of keyListeners) {
      listener({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'k', preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} })
    }
  })
  await flush()
  const root = tree.root
  const filters = root
    .find((n) => n.props['aria-label'] === 'Fontes da busca')
    .findAll((n) => n.type === 'button')
    .map(textOf)
  const entries = root
    .findAll((n) => n.type === 'button' && typeof n.props['data-palette-entry-id'] === 'string')
    .map((n) => ({ id: n.props['data-palette-entry-id'], title: textOf(n.findByType('b')), text: textOf(n) }))
  const search = root.find((n) => n.type === 'input' && n.props['aria-label'] === 'Buscar em toda a Synkora')
  return { commitCalls, filters, entries, placeholder: search.props.placeholder }
}

// ————————————————————————— sem versionamento —————————————————————————

test('projeto sem versão: sem Mapa/Versões, sem Commits/Branches, e nenhum commit pedido ao main', async () => {
  const p = await openPalette(SOLO.id)
  assert.deepEqual(p.commitCalls, [], 'a tela nem chama o que o main recusaria')
  assert.deepEqual(p.filters, ['Tudo', 'Ações', 'Arquivos', 'Sessões'])
  const titles = p.entries.map((e) => e.title)
  assert.ok(!titles.includes('Abrir Mapa'), 'sem Mapa')
  assert.ok(!titles.includes('Abrir Versões'), 'sem Versões')
  assert.ok(!titles.includes('Abrir Board'), 'a aba se chama Missão aqui')
  assert.ok(titles.includes('Abrir Missão'))
  assert.ok(titles.includes('Abrir Arquivos'))
  assert.ok(!p.entries.some((e) => e.id.startsWith('branch:') || e.id.startsWith('base-branch:') || e.id.startsWith('commit:')))
  assert.equal(p.placeholder, 'Buscar ações, arquivos e sessões…')
})

test('projeto sem versão: a missão diz "aberta" ou "finalizada", não o status cru', async () => {
  const p = await openPalette(SOLO.id)
  const open = p.entries.find((e) => e.id === 'mission:m-open')
  const done = p.entries.find((e) => e.id === 'mission:m-done')
  assert.match(open.text, /Missão · aberta/)
  assert.match(done.text, /Missão · finalizada/)
})

/** O que `openProject` chama ao abrir o universo pela paleta. */
function navigationBridge() {
  windowStub.synkora = {
    missions: { list: async (projectId) => MISSIONS.filter((m) => m.projectId === projectId) },
    projectLayout: { apply: async () => ({ layout: null }) }
  }
}

test('um destino velho para Mapa ou Versões cai na aba da missão do projeto sem versão', async () => {
  navigationBridge()
  useStore.setState({ projects: [VERSIONED, SOLO], universeTabByProject: {}, openProjectId: null, appPage: 'workspace' })
  await navigateFromCommandPalette({ kind: 'project', projectId: SOLO.id, tab: 'mapa' })
  assert.equal(useStore.getState().universeTabByProject[SOLO.id], 'board')
  await navigateFromCommandPalette({ kind: 'project', projectId: SOLO.id, tab: 'backlog' })
  assert.equal(useStore.getState().universeTabByProject[SOLO.id], 'board')
  await navigateFromCommandPalette({ kind: 'project', projectId: SOLO.id, tab: 'arquivos' })
  assert.equal(useStore.getState().universeTabByProject[SOLO.id], 'arquivos')
})

// ————————————————————————— versionado (regressão) —————————————————————————

test('projeto versionado segue com Mapa, Versões, Commits, Branches e a busca de commits', async () => {
  const p = await openPalette(VERSIONED.id)
  assert.deepEqual(p.commitCalls, ['v-m'])
  assert.deepEqual(p.filters, ['Tudo', 'Ações', 'Arquivos', 'Sessões', 'Commits', 'Branches'])
  const titles = p.entries.map((e) => e.title)
  for (const title of ['Abrir Board', 'Abrir Mapa', 'Abrir Versões', 'Abrir Arquivos']) assert.ok(titles.includes(title), title)
  assert.ok(p.entries.some((e) => e.id === 'branch:v-m:mission/abc'))
  assert.ok(p.entries.some((e) => e.id === 'commit:v-m:abc1234'))
  assert.match(p.entries.find((e) => e.id === 'mission:v-m').text, /Missão · ativa/)
  assert.equal(p.placeholder, 'Buscar ações, arquivos, sessões, commits e branches…')

  navigationBridge()
  useStore.setState({ universeTabByProject: {} })
  await navigateFromCommandPalette({ kind: 'project', projectId: VERSIONED.id, tab: 'mapa' })
  assert.equal(useStore.getState().universeTabByProject[VERSIONED.id], 'mapa')
})

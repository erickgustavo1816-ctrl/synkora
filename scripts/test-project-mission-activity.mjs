import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const compiled = buildSync({
  stdin: { contents: `export { default as ProjectRail } from './src/renderer/src/components/ProjectRail'; export { useStore } from './src/renderer/src/store'`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'zustand'], loader: { '.css': 'empty' }
}).outputFiles[0].text

async function harness(t, initial) {
  const records = { a: [], b: [], ...initial }
  const listeners = new Set(), reads = []
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'window', 'document', 'localStorage', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { synkora: { missions: {
      async list(id) { reads.push(id); return records[id] ?? [] },
      onChanged(callback) { listeners.add(callback); return () => listeners.delete(callback) }
    } } },
    { documentElement: { style: { setProperty() {} } } }, { getItem: () => null }
  )
  const { useStore, ProjectRail } = loaded.exports
  useStore.setState({ projects: [{ id: 'a', name: 'Alfa' }, { id: 'b', name: 'Beta' }], openProjectId: null })
  let tree
  await act(async () => { tree = create(React.createElement(ProjectRail)) })
  t.after(async () => { await act(async () => tree.unmount()); assert.equal(listeners.size, 0) })
  const button = name => tree.root.findAllByType('button').find(item => item.props['data-tip']?.startsWith(name))
  const activity = name => button(name).findAll(node => node.props['data-activity'])[0]?.props['data-activity'] ?? null
  return { tree, useStore, records, reads, button, activity,
    async change(id) { await act(async () => { for (const callback of listeners) callback(id) }) },
    async panes(guiPanes) { await act(async () => { useStore.setState({ guiPanes }) }) }
  }
}

const mission = (id, projectId, extra = {}) => ({ id, projectId, title: 'Missão sintética', status: 'ativa', direct: true, ...extra })
const pane = (status, extra = {}) => ({ status, perm: null, ...extra })

test('lateral mostra missões paradas sem precisar visitar ou iniciar cada projeto', async t => {
  const h = await harness(t, { a: [mission('aaaaaaaa-01', 'a')], b: [mission('bbbbbbbb-01', 'b')] })
  assert.deepEqual([...new Set(h.reads)].sort(), ['a', 'b'])
  assert.equal(h.activity('Alfa'), 'paused')
  assert.equal(h.activity('Beta'), 'paused')
  assert.match(h.button('Beta').props['aria-label'], /trabalho em espera/iu)
  assert.equal(h.useStore.getState().openProjectId, null)
  assert.deepEqual(h.useStore.getState().mountedProjects, [])
  assert.deepEqual(h.useStore.getState().guiPanes, {})
})

test('lateral reage a trabalho, espera, pausa e fim de sessão no projeto fora de foco', async t => {
  const h = await harness(t, { b: [mission('bbbbbbbb-01', 'b')] })
  for (const status of ['starting', 'working', 'waiting-you', 'idle', 'dead']) {
    await h.panes({ 'gui-dev-bbbbbbbb': pane(status) })
    assert.equal(h.activity('Beta'), ['starting', 'working'].includes(status) ? 'running' : 'paused', status)
    assert.equal(h.activity('Alfa'), null)
  }
  await h.panes({ 'gui-dev-bbbbbbbb': pane('working', { perm: { requestId: 'synthetic' } }) })
  assert.equal(h.activity('Beta'), 'paused', 'uma permissão bloqueante não é trabalho em curso')
})

test('uma missão trabalhando prevalece sobre outra parada; revisor e integração contam', async t => {
  const h = await harness(t, { a: [mission('aaaaaaaa-01', 'a'), mission('cccccccc-01', 'a')] })
  await h.panes({ 'gui-dev-aaaaaaaa': pane('idle'), 'gui-reviewer-cccccccc': pane('working') })
  assert.equal(h.activity('Alfa'), 'running')
  await h.panes({})
  h.records.a = [mission('aaaaaaaa-01', 'a', { status: 'integrando', integration: { state: 'merging' } })]
  await h.change('a')
  assert.equal(h.activity('Alfa'), 'running')
  h.records.a = [mission('aaaaaaaa-01', 'a', { integration: { state: 'queued' } })]
  await h.change('a')
  assert.equal(h.activity('Alfa'), 'paused')
})

test('evento de missão em projeto fechado atualiza indicador e conclusão o remove', async t => {
  const h = await harness(t)
  assert.equal(h.activity('Beta'), null)
  h.records.b = [mission('bbbbbbbb-01', 'b')]
  await h.change('b')
  assert.equal(h.activity('Beta'), 'paused')
  h.records.b = [mission('bbbbbbbb-01', 'b', { status: 'concluida' })]
  await h.change('b')
  assert.equal(h.activity('Beta'), null)
  const reads = h.reads.length
  await h.change('project-not-in-rail')
  assert.equal(h.reads.length, reads)
})

test('release participa do indicador do projeto em execução, espera e encerramento', async t => {
  const release = mission('dddddddd-01', 'b', { missionType: 'release' })
  const h = await harness(t, { b: [release] })
  for (const status of ['starting', 'working', 'waiting-you', 'idle', 'dead']) {
    await h.panes({ 'gui-dev-dddddddd': pane(status) })
    assert.equal(h.activity('Beta'), ['starting', 'working'].includes(status) ? 'running' : 'paused', status)
    assert.equal(h.activity('Alfa'), null, 'não transfere atividade para outro projeto')
  }
  await h.panes({ 'gui-dev-dddddddd': pane('working', { perm: { requestId: 'release-permission' } }) })
  assert.equal(h.activity('Beta'), 'paused')
  await h.panes({ 'gui-dev-dddddddd': pane('working') })
  assert.equal(h.activity('Beta'), 'running')
  for (const status of ['concluida', 'arquivada']) {
    h.records.b = [{ ...release, status }]
    await h.change('b')
    assert.equal(h.activity('Beta'), null, 'registro encerrado não mantém o ponto verde')
  }
  assert.equal(h.useStore.getState().openProjectId, null)
})

test('release trabalhando prevalece sobre missão parada no mesmo projeto', async t => {
  const h = await harness(t, { a: [mission('aaaaaaaa-01', 'a'), mission('dddddddd-01', 'a', { missionType: 'release' })] })
  await h.panes({ 'gui-dev-aaaaaaaa': pane('idle'), 'gui-dev-dddddddd': pane('working') })
  assert.equal(h.activity('Alfa'), 'running')
})

test('terminais, releases encerradas e missões encerradas não inventam atividade', async t => {
  const h = await harness(t, { a: [
    mission('aaaaaaaa-01', 'a', { status: 'concluida' }),
    mission('cccccccc-01', 'a', { status: 'arquivada' }),
    mission('dddddddd-01', 'a', { missionType: 'release', status: 'concluida' }),
    mission('eeeeeeee-01', 'a', { kind: 'direta' })
  ] })
  await act(async () => h.useStore.setState({ panesByProject: { a: [{ id: 'shell-synthetic' }] } }))
  await h.panes({ 'gui-dev-aaaaaaaa': pane('working'), 'gui-dev-dddddddd': pane('working') })
  assert.equal(h.activity('Alfa'), null)
  assert.equal(h.button('Alfa').findAllByProps({ className: 'rail-run-dot' }).length, 0)
})

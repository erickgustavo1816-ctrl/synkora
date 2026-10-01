import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const uiCode = (await build({
  stdin: {
    contents: "export { MissionsPane } from './src/renderer/src/components/BacklogView'; export { useStore } from './src/renderer/src/store'",
    resolveDir: process.cwd(), loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'zustand'],
  loader: { '.css': 'empty' },
  plugins: [{ name: 'missions-pane-test-export', setup(builder) {
    builder.onLoad({ filter: /BacklogView\.tsx$/ }, ({ path }) => ({
      contents: readFileSync(path, 'utf8') + '\nexport { MissionsPane }', loader: 'tsx'
    }))
  } }]
})).outputFiles[0].text

const preloadCode = (await build({
  entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['electron']
})).outputFiles[0].text

const at = '2026-10-01T12:00:00.000Z'
const versions = [
  { id: 'v-current', projectId: 'project', name: '2.4', status: 'aberta', deliveries: [], branch: 'version/2.4', createdAt: at, updatedAt: at },
  { id: 'v-next', projectId: 'project', name: '2.5', status: 'aberta', deliveries: [], branch: 'version/2.5', createdAt: at, updatedAt: at }
]
const mission = {
  id: 'synthetic', projectId: 'project', title: 'Missão sintética', missionType: 'dev',
  status: 'ativa', direct: true, versionId: 'v-current', branch: 'mission/synthetic',
  baseBranch: 'version/2.4', worktree: 'synthetic-workspace', seatId: 'synthetic-seat',
  createdAt: at, updatedAt: at
}
const changed = { ...mission, versionId: 'v-next', updatedAt: '2026-10-01T12:01:00.000Z' }
const textOf = node => node == null ? '' : typeof node === 'string' || typeof node === 'number'
  ? String(node) : (node.children ?? []).map(textOf).join('')
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, options = {}) {
  const loaded = { exports: {} }, requests = [], choiceRequests = [], portals = [], nodes = new Map()
  const document = {
    body: { style: {} }, activeElement: { isConnected: true, focus() { document.restored = true } },
    documentElement: { style: { setProperty() {} } },
    addEventListener() {}, removeEventListener() {}
  }
  const window = {
    setTimeout, clearTimeout, requestAnimationFrame: callback => callback(),
    addEventListener() {}, removeEventListener() {}, innerHeight: 900, innerWidth: 1280,
    synkora: { missions: {
      versionChoices: async id => {
        choiceRequests.push(id)
        return options.choices ? options.choices(id) : { versions, defaultVersionId: 'v-current' }
      },
      changeVersion: async (...args) => {
        requests.push(args)
        return options.change ? options.change(...args) : { ok: true, mission: changed }
      },
      list: options.list ?? (async () => [mission])
    } }
  }
  if (options.missingBridge) delete window.synkora.missions.changeVersion
  if (options.missingChoices) delete window.synkora.missions.versionChoices
  const uiRequire = name => name === 'react-dom' ? {
    createPortal: (children, target) => { portals.push(target); return children }
  } : require(name)
  new Function('require', 'module', 'exports', 'window', 'document', 'localStorage', uiCode)(
    uiRequire, loaded, loaded.exports, window, document, { getItem: () => null }
  )
  const { MissionsPane, useStore } = loaded.exports
  const missions = options.missions ?? [mission]
  useStore.setState({ missions, openProjectId: 'project', missionsByProject: { project: missions }, missionTabByProject: { project: mission.id } })
  let tree
  await act(async () => {
    tree = create(React.createElement(MissionsPane, { projectId: 'project', versions }), {
      createNodeMock(element) {
        if (nodes.has(element.props)) return nodes.get(element.props)
        if (element.props.role === 'dialog') {
          if (nodes.has('dialog')) return nodes.get('dialog')
          const node = {
            querySelector: () => null,
            querySelectorAll: () => tree.root.find(node => node.props.role === 'dialog')
              .findAll(node => node.type === 'button' && !node.props.disabled).map(node => node.instance),
            contains: target => [...nodes.values()].includes(target),
            focus() { document.activeElement = node }
          }
          nodes.set(element.props, node)
          nodes.set('dialog', node)
          return node
        }
        if (element.type === 'button') {
          const node = { focus() { document.activeElement = node }, getBoundingClientRect: () => ({ width: 280, bottom: 200, top: 170, left: 100 }) }
          nodes.set(element.props, node)
          return node
        }
        return null
      }
    })
  })
  t.after(async () => { await act(async () => tree.unmount()) })
  const buttons = pattern => tree.root.findAll(node => node.type === 'button' && pattern.test(textOf(node)))
  const click = async node => { await act(async () => { node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }) }) }
  const dialog = () => tree.root.findAll(node => node.props.role === 'dialog')[0]
  const submit = () => dialog()?.findAll(node => node.type === 'button' && /^(Alterar versão|Alterando…)$/.test(textOf(node)))[0]
  const alerts = () => tree.root.findAll(node => node.props.role === 'alert').map(textOf).join('\n')
  const select = () => dialog().find(node => node.type === 'button' && node.props['aria-haspopup'] === 'listbox')
  const pick = async (id = 'v-next') => {
    await click(select())
    const option = tree.root.find(node => node.props.role === 'option' && textOf(node).includes(versions.find(version => version.id === id).name))
    await click(option)
  }
  const open = async (index = 0) => {
    const actions = buttons(/^Alterar versão$/)
    assert.ok(actions[index], 'a lista precisa oferecer Alterar versão')
    await click(actions[index])
  }
  const key = async (target, values) => {
    const event = { defaultPrevented: false, target: document.activeElement, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...values }
    await act(async () => { target.props.onKeyDown(event) })
    return event
  }
  return { tree, useStore, window, document, requests, choiceRequests, portals, nodes, buttons, click, dialog, submit, alerts, select, pick, open, key }
}

test('bridge envia somente os dois identificadores pelo canal dedicado e conserva o resultado', async () => {
  let api
  const requests = []
  const result = { ok: true, mission: changed }
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'synkora') api = value } },
    ipcRenderer: { invoke: async (...args) => { requests.push(args); return result } }, webUtils: {}
  }
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'window', preloadCode)(
    name => name === 'electron' ? electron : require(name), loaded, loaded.exports,
    { addEventListener() {} }
  )
  assert.equal(typeof api.missions.changeVersion, 'function', 'ponte dedicada ausente')
  assert.equal(await api.missions.changeVersion('synthetic', 'v-next'), result)
  assert.deepEqual(requests, [['missions:changeVersion', 'synthetic', 'v-next']])
})

test('Alterar versão aparece somente nas missões dev ativas', async t => {
  const h = await fixture(t, { missions: [mission,
    { ...mission, id: 'legacy-dev', missionType: undefined },
    { ...mission, id: 'planning', missionType: 'planejamento' },
    { ...mission, id: 'release', missionType: 'release' },
    ...['arquivada', 'concluida', 'integrando'].map(status => ({ ...mission, id: status, status }))
  ] })
  assert.equal(h.buttons(/^Alterar versão$/).length, 2)
})

test('consulta a API canônica, identifica a versão atual e exige escolher outro destino', async t => {
  const h = await fixture(t)
  await h.open()
  assert.deepEqual(h.choiceRequests, ['project'])
  assert.equal(String(h.dialog().props['aria-modal']), 'true')
  assert.ok(h.portals.includes(h.document.body))
  assert.match(textOf(h.dialog()), /Versão atual.*2\.4/)
  assert.match(textOf(h.dialog()), /conversa.*trabalho.*(permanecem|continuam)/i)
  assert.match(textOf(h.dialog()), /integração.*(destino|versão escolhida)/i)
  assert.match(textOf(h.dialog()), /conflitos/i)
  assert.equal(h.submit().props.disabled, true)
  await h.click(h.submit())
  assert.deepEqual(h.requests, [])
  await h.click(h.select())
  const options = h.tree.root.findAll(node => node.props.role === 'option')
  assert.equal(options.length, 1)
  assert.match(textOf(options[0]), /2\.5/)
})

test('leitura pendente bloqueia o envio até os destinos chegarem', async t => {
  const choices = deferred()
  const h = await fixture(t, { choices: () => choices.promise })
  await h.open()
  assert.match(textOf(h.dialog()), /Carregando versões/)
  assert.equal(h.select().props.disabled, true)
  assert.equal(h.submit().props.disabled, true)
  await h.click(h.submit())
  assert.deepEqual(h.requests, [])
  await act(async () => { choices.resolve({ versions }); await choices.promise })
  assert.equal(h.select().props.disabled, false)
})

test('sucesso aplica a missão devolvida no badge e cache sem aguardar outra leitura nem mudar identidade', async t => {
  const h = await fixture(t, { list: () => new Promise(() => {}) })
  await h.open()
  await h.pick()
  await h.click(h.submit())
  assert.deepEqual(h.requests, [['synthetic', 'v-next']])
  assert.equal(h.dialog(), undefined)
  assert.match(textOf(h.tree.root.findByProps({ className: 'ms-head-line' })), /2\.5/)
  assert.doesNotMatch(textOf(h.tree.root.findByProps({ className: 'ms-head-line' })), /2\.4/)
  assert.deepEqual(h.useStore.getState().missions[0], changed)
  assert.deepEqual(h.useStore.getState().missionsByProject.project[0], changed)
  assert.equal(h.useStore.getState().missionTabByProject.project, 'synthetic')
})

test('o filtro da versão de origem deixa de mostrar a missão assim que ela muda', async t => {
  const h = await fixture(t)
  const selects = h.tree.root.findAll(node => node.type === 'button' && node.props['aria-haspopup'] === 'listbox')
  await h.click(selects[1])
  await h.click(h.tree.root.find(node => node.props.role === 'option' && textOf(node) === '◈ 2.4'))
  await h.open()
  await h.pick()
  await h.click(h.submit())
  assert.equal(h.tree.root.findAll(node => node.props.className === 'ms-row ativa').length, 0)
})

test('envio pendente trava seletor e fechamento e ignora duplo clique no mesmo turno', async t => {
  const result = deferred()
  const h = await fixture(t, { change: () => result.promise })
  await h.open()
  await h.pick()
  const submit = h.submit()
  await act(async () => { submit.props.onClick(); submit.props.onClick() })
  assert.deepEqual(h.requests, [['synthetic', 'v-next']])
  assert.equal(h.dialog().props['aria-busy'], true)
  assert.equal(h.submit().props.disabled, true)
  assert.equal(h.select().props.disabled, true)
  for (const node of h.dialog().findAll(node => node.type === 'button' && /cancelar|×/i.test(textOf(node)))) await h.click(node)
  await h.click(h.tree.root.find(node => node.type === 'div' && node.props.className?.split(' ').includes('overlay')))
  await h.key(h.dialog(), { key: 'Escape' })
  assert.ok(h.dialog())
  await act(async () => { result.resolve({ ok: true, mission: changed }); await result.promise })
  assert.equal(h.dialog(), undefined)
})

test('recusa do servidor permanece no modal, não muda o store e permite nova tentativa', async t => {
  let attempt = 0
  const h = await fixture(t, { change: () => ++attempt === 1
    ? { ok: false, error: 'A missão está na fila de integração. Aguarde a integração terminar.' }
    : { ok: true, mission: changed } })
  await h.open()
  await h.pick()
  await h.click(h.submit())
  assert.match(h.alerts(), /fila de integração/)
  assert.deepEqual(h.useStore.getState().missions, [mission])
  assert.equal(h.submit().props.disabled, false)
  await h.click(h.submit())
  assert.equal(h.dialog(), undefined)
  assert.equal(h.useStore.getState().missions[0].versionId, 'v-next')
})

test('falha de transporte libera o envio e explica a saída sem expor detalhes do IPC', async t => {
  const h = await fixture(t, { change: () => { throw new Error("Error invoking remote method 'missions:changeVersion': internal synthetic detail") } })
  await h.open()
  await h.pick()
  await h.click(h.submit())
  assert.match(h.alerts(), /tente novamente/i)
  assert.doesNotMatch(h.alerts(), /internal synthetic detail|Error invoking/)
  assert.equal(h.submit().props.disabled, false)
  assert.deepEqual(h.useStore.getState().missions, [mission])
})

test('sem outra versão elegível orienta abrir uma versão e mantém o envio bloqueado', async t => {
  const h = await fixture(t, { choices: () => ({ versions: [versions[0]] }) })
  await h.open()
  assert.match(textOf(h.dialog()), /Nenhuma outra versão aberta/)
  assert.match(textOf(h.dialog()), /aba Versões/)
  assert.equal(h.submit().props.disabled, true)
  await h.click(h.submit())
  assert.deepEqual(h.requests, [])
})

test('falha ao carregar destinos oferece uma nova consulta e mantém seleção segura', async t => {
  let attempt = 0
  const h = await fixture(t, { choices: () => { if (++attempt === 1) throw new Error('synthetic failure'); return { versions } } })
  await h.open()
  assert.match(h.alerts(), /carregar.*versões/i)
  assert.equal(h.submit().props.disabled, true)
  await h.click(h.buttons(/tentar novamente/i)[0])
  assert.equal(h.alerts(), '')
  assert.equal(h.select().props.disabled, false)
  await h.pick()
  await h.click(h.submit())
  assert.equal(h.dialog(), undefined)
})

for (const missing of ['missingBridge', 'missingChoices']) {
  test(`ponte antiga (${missing}) orienta reiniciar e não deixa o modal preso`, async t => {
    const h = await fixture(t, { [missing]: true })
    await h.open()
    if (missing === 'missingBridge') { await h.pick(); await h.click(h.submit()) }
    assert.match(h.alerts(), /reinicie.*Synkora/i)
    await h.click(h.buttons(/^cancelar$/i)[0])
    assert.equal(h.dialog(), undefined)
  })
}

test('Escape fecha a folha, mas respeita o Escape já consumido pelo Select', async t => {
  const h = await fixture(t)
  await h.open()
  await h.key(h.dialog(), { key: 'Escape', defaultPrevented: true })
  assert.ok(h.dialog())
  await h.key(h.dialog(), { key: 'Escape' })
  assert.equal(h.dialog(), undefined)
  assert.equal(h.document.restored, true)
})

test('Tab e Shift+Tab mantêm o foco dentro da folha, inclusive durante o envio', async t => {
  const pending = deferred()
  const h = await fixture(t, { change: () => pending.promise })
  await h.open()
  const controls = () => h.dialog().findAll(node => node.type === 'button' && !node.props.disabled)
  const first = controls()[0].instance
  first.focus()
  assert.equal((await h.key(h.dialog(), { key: 'Tab', shiftKey: true })).defaultPrevented, true)
  assert.equal(h.document.activeElement, controls().at(-1).instance)
  assert.equal((await h.key(h.dialog(), { key: 'Tab' })).defaultPrevented, true)
  assert.equal(h.document.activeElement, first)
  await h.pick()
  await h.click(h.submit())
  assert.equal(h.document.activeElement, h.dialog().instance, 'o envio mantém foco no diálogo quando todos os controles desabilitam')
  const event = await h.key(h.dialog(), { key: 'Tab' })
  assert.equal(event.defaultPrevented, true)
  assert.equal(h.document.activeElement, h.dialog().instance)
  await act(async () => { pending.resolve({ ok: false, error: 'Recusa sintética' }); await pending.promise })
})

test('o Select real abre pelo teclado, escolhe o destino e consome Escape antes da folha', async t => {
  const h = await fixture(t)
  await h.open()
  await h.key(h.select(), { key: 'Enter' })
  assert.equal(h.select().props['aria-expanded'], true)
  await h.key(h.select(), { key: 'ArrowDown' })
  await h.key(h.select(), { key: 'Enter' })
  assert.match(textOf(h.select()), /2\.5/)
  assert.equal(h.submit().props.disabled, false)
  await h.key(h.select(), { key: 'Enter' })
  const event = await h.key(h.select(), { key: 'Escape' })
  await act(async () => { h.dialog().props.onKeyDown(event) })
  assert.equal(h.select().props['aria-expanded'], false)
  assert.ok(h.dialog())
})

test('resposta tardia de listagem não desfaz a versão e trocar projeto preserva o cache de cada um', async t => {
  const oldList = deferred()
  const h = await fixture(t, { list: () => oldList.promise })
  assert.equal(typeof h.useStore.getState().changeMissionVersion, 'function')
  const reading = h.useStore.getState().loadMissions('project')
  const other = { ...mission, id: 'other', projectId: 'other-project' }
  await act(async () => {
    h.useStore.setState({ openProjectId: 'other-project', missions: [other], missionsByProject: { project: [mission], 'other-project': [other] } })
    await h.useStore.getState().changeMissionVersion('synthetic', 'v-next')
    oldList.resolve([mission])
    await reading
  })
  assert.deepEqual(h.useStore.getState().missions, [other])
  assert.deepEqual(h.useStore.getState().missionsByProject.project, [changed])
  assert.deepEqual(h.useStore.getState().missionsByProject['other-project'], [other])
})

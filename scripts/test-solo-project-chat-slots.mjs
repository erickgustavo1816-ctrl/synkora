import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

// OS SLOTS DE CHAT DA MISSÃO — um hook, duas telas (2026-09-30).
//
// O Board versionado e a tela do projeto sem versionamento abrem a MESMA
// conversa pelo mesmo caminho: pedir a spec do agente ao entrar na missão,
// mostrar a escolha de conta quando falta uma, trocar a conta descartando o
// que foi pedido com a anterior (época) e soltar as sessões quando a missão
// deixa de estar viva. Antes, tudo isso morava dentro do Board (1540 linhas);
// a tela nova não podia reusar sem copiar. Este teste exercita o hook de
// verdade, com o store e a ponte do preload falsos.
//
// Código velho: `useMissionChatSlots.ts` não existe — a carga reprova.

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const storeStub = {
  name: 'store-stub',
  setup(build) {
    // (o esbuild lê o filtro como regex do Go: sem a flag `u`)
    build.onResolve({ filter: /^\.\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const useStore = (selector) => selector(globalThis.__chatSlotsStore)',
      loader: 'js'
    }))
  }
}

const compiled = await build({
  stdin: { contents: "export * from './useMissionChatSlots'", resolveDir: 'src/renderer/src', loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'], plugins: [storeStub]
}).then((result) => result.outputFiles[0].text)

function setup() {
  const specs = []
  const seatCalls = []
  const dropped = []
  const loads = []
  const focused = []
  const droppedWhileRendering = []
  const window = { synkora: { missions: {
    guiSpec: (missionId, role) => new Promise((resolve) => specs.push({ missionId, role, resolve })),
    setChatSeat: async (projectId, missionId, seatId) => { seatCalls.push([projectId, missionId, seatId]); return { ok: true } }
  } } }
  globalThis.__chatSlotsStore = {
    loadMissions: async (projectId) => { loads.push(projectId) },
    dropGuiPane: (paneId) => { dropped.push(paneId); if (globalThis.__chatSlotsRendering) droppedWhileRendering.push(paneId) }
  }
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'window', compiled)(createRequire(import.meta.url), loaded, loaded.exports, window)
  const { useMissionChatSlots } = loaded.exports
  let api
  function Harness({ pendingSibling, ...props }) {
    // Uma atualização do MESMO componente já enfileirada no commit (como no app,
    // onde o finalizar recarrega a lista e troca a aba): o React deixa de
    // calcular o updater na hora e o executa no PRÓXIMO render.
    const [, setSibling] = React.useState(0)
    React.useEffect(() => { if (pendingSibling) setSibling((n) => n + 1) }, [props.missions, pendingSibling])
    globalThis.__chatSlotsRendering = true
    try {
      api = useMissionChatSlots(props)
    } finally {
      globalThis.__chatSlotsRendering = false
    }
    return null
  }
  const baseProps = {
    projectId: 'p1',
    isActive: true,
    mission: { id: 'm1', direct: true },
    missions: [{ id: 'm1', status: 'ativa' }],
    onChatFocus: (missionId) => focused.push(missionId)
  }
  let tree
  return {
    specs, seatCalls, dropped, loads, focused, droppedWhileRendering,
    get api() { return api },
    mount: async (over = {}) => { await act(() => { tree = create(React.createElement(Harness, { ...baseProps, ...over })) }) },
    update: async (over = {}) => { await act(() => tree.update(React.createElement(Harness, { ...baseProps, ...over }))) },
    resolve: async (index, value) => { await act(async () => { specs[index].resolve(value) }) }
  }
}

const spawn = (over = {}) => ({ paneId: 'gui-dev-m1', cli: 'claude', cwd: 'C:/proposta', seatId: 's1', configDir: 'C:/seat', ...over })

test('entrar na missão pede a spec do agente UMA vez e publica o slot em foco', async () => {
  const h = setup()
  await h.mount()
  assert.deepEqual(h.specs.map((s) => [s.missionId, s.role]), [['m1', 'dev']])
  await h.update()
  assert.equal(h.specs.length, 1, 'a guarda de voo impede o pedido duplo enquanto a spec viaja')
  await h.resolve(0, { ok: true, spawn: spawn() })
  assert.deepEqual(h.api.slots.m1, [{ role: 'dev', spawn: spawn() }])
  assert.equal(h.api.active.m1, 'gui-dev-m1')
  await h.update()
  assert.equal(h.specs.length, 1, 'com o slot aberto nada é pedido de novo')
})

test('projeto fora de foco ou missão legada não abrem conversa', async () => {
  const h = setup()
  await h.mount({ isActive: false })
  await h.update({ mission: { id: 'm1', direct: false } })
  await h.update({ mission: undefined })
  assert.equal(h.specs.length, 0)
})

test('falta de conta é o card de escolha; erro tem retry que limpa e pede de novo', async () => {
  const h = setup()
  await h.mount()
  await h.resolve(0, { ok: false, needsSeat: true })
  assert.equal(h.api.needsSeat.m1, true)
  assert.equal(h.api.errors.m1, undefined, 'falta de conta não é erro')
  assert.equal(h.api.slots.m1, undefined)

  const g = setup()
  await g.mount()
  await g.resolve(0, { ok: false, error: 'a pasta do projeto não existe mais' })
  assert.equal(g.api.errors.m1, 'a pasta do projeto não existe mais')
  await act(async () => { g.api.retry('m1') })
  assert.equal(g.api.errors.m1, undefined)
  assert.equal(g.specs.length, 2)
  await g.resolve(1, { ok: true, spawn: spawn() })
  assert.equal(g.api.slots.m1.length, 1)
})

test('trocar a conta derruba as sessões, recarrega e descarta a spec pedida com a conta antiga', async () => {
  const h = setup()
  await h.mount()
  await h.resolve(0, { ok: true, spawn: spawn() })
  await act(async () => { await h.api.chooseSeat('m1', 's2') })
  assert.deepEqual(h.seatCalls, [['p1', 'm1', 's2']])
  assert.deepEqual(h.dropped, ['gui-dev-m1'])
  assert.deepEqual(h.loads, ['p1'])
  assert.equal(h.api.slots.m1, undefined)
  assert.equal(h.api.seatBusy, null)
  // a remoção acorda o efeito canônico: uma spec nova para a conta nova
  assert.equal(h.specs.length, 2)
  await h.resolve(1, { ok: true, spawn: spawn({ seatId: 's2' }) })
  assert.equal(h.api.slots.m1[0].spawn.seatId, 's2')

  // ÉPOCA: a resposta da conta anterior que chega DEPOIS da troca não pinta nada
  const g = setup()
  await g.mount()
  await act(async () => { await g.api.chooseSeat('m1', 's2') })
  assert.equal(g.specs.length, 2)
  await g.resolve(0, { ok: true, spawn: spawn({ paneId: 'gui-dev-old', seatId: 's1' }) })
  assert.equal(g.api.slots.m1, undefined, 'spec da conta antiga descartada')
  await g.resolve(1, { ok: true, spawn: spawn({ seatId: 's2' }) })
  assert.equal(g.api.slots.m1[0].spawn.seatId, 's2')
})

test('missão que deixa de viver solta as sessões; ausente da lista não solta nada', async () => {
  const h = setup()
  await h.mount()
  await h.resolve(0, { ok: true, spawn: spawn() })
  await h.update({ missions: [] })
  assert.deepEqual(h.dropped, [], 'fotografia incompleta não encerra conversa')
  await h.update({ missions: [{ id: 'm1', status: 'concluida' }], mission: undefined })
  assert.deepEqual(h.dropped, ['gui-dev-m1'])
  assert.equal(h.api.slots.m1, undefined)
})

test('soltar as sessões nunca mexe no store durante o render (efeito, não updater)', async () => {
  // O dropGuiPane é um `set` do store. Dentro do updater do setState ele roda
  // na fase de RENDER sempre que o componente já tem outra atualização na fila
  // — e o React avisa "Cannot update a component while rendering a different
  // component" (visto no console ao finalizar, 2026-09-30).
  const h = setup()
  await h.mount({ pendingSibling: true })
  await h.resolve(0, { ok: true, spawn: spawn() })
  await h.update({ pendingSibling: true, missions: [{ id: 'm1', status: 'concluida' }], mission: undefined })
  assert.deepEqual(h.dropped, ['gui-dev-m1'])
  assert.deepEqual(h.droppedWhileRendering, [], 'a sessão foi solta no meio de um render')
  assert.equal(h.api.slots.m1, undefined)
})

test('abrir de novo o papel existente só traz a conversa para a frente', async () => {
  const h = setup()
  await h.mount()
  await h.resolve(0, { ok: true, spawn: spawn() })
  await act(async () => { h.api.focus('m1', 'elsewhere') })
  assert.equal(h.api.active.m1, 'elsewhere')
  await act(async () => { await h.api.openRole('m1', 'dev') })
  assert.equal(h.api.active.m1, 'gui-dev-m1')
  assert.deepEqual(h.focused, ['m1'], 'quem hospeda tira o terminal da frente')
  assert.equal(h.specs.length, 1)
  // o composer muda o modo/executor: o slot guarda para a remontagem
  await act(async () => { h.api.setPermission('m1', 'gui-dev-m1', 'plan') })
  await act(async () => { h.api.setFast('m1', 'gui-dev-m1', true) })
  await act(async () => { h.api.setExecutor('m1', 'gui-dev-m1', { model: 'opus', effort: 'high' }) })
  assert.deepEqual(
    [h.api.slots.m1[0].spawn.permissionMode, h.api.slots.m1[0].spawn.fast, h.api.slots.m1[0].spawn.model, h.api.slots.m1[0].spawn.effort],
    ['plan', true, 'opus', 'high']
  )
})

// O MODAL DE NOVO UNIVERSO COM O INTERRUPTOR "VERSIONAR COM GIT"
// (projeto sem versionamento, 2026-09-30; mockup aprovado:
// docs/mockups/projeto-sem-versao-2026-09-30.html, cena 1).
//
// O componente de verdade, com o store de verdade, renderizado pelo
// react-test-renderer. A ponte `window.synkora` é a única coisa falsa: cada
// teste diz o que a pasta tem (`inspectFolder`) e como o main responde
// (`projects.create`).
//
// O que prende:
//  · pasta com Git TRAVA o interruptor ligado, com o motivo, e o pedido sai
//    versionado;
//  · desligado recolhe o campo do GitHub e o pedido sai `versioning: 'none'`
//    SEM link (mesmo que um link tenha sido digitado antes);
//  · a leitura da pasta que falha vale "não sei": não trava nem bloqueia;
//  · erro do main aparece ONDE quebrou (clone → no campo do link, com a saída
//    "crie sem o link"; pasta com Git → no interruptor, que trava) e o botão
//    volta a funcionar — nunca mais "… criando" parado;
//  · "Não dá para trocar depois." mora ao lado do botão que decide.
//
// Rodar: node --test scripts/test-new-universe-modal.mjs

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** react-test-renderer não desenha portal: o modal cai na própria árvore. */
const portalStub = {
  name: 'portal-stub',
  setup(build) {
    build.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'portal-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'portal-stub' }, () => ({
      contents: 'export function createPortal(node) { return node }',
      loader: 'js'
    }))
  }
}

const compiled = (await build({
  stdin: {
    contents: `
      export { useStore } from './src/renderer/src/store';
      export { default as NewUniverseModal } from './src/renderer/src/components/NewUniverseModal';
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
})).outputFiles[0].text

/** A ponte que o store e o modal enxergam — cada teste troca a dele. */
const windowStub = { setTimeout, clearTimeout, synkora: {} }
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiled)(
  createRequire(import.meta.url),
  loaded,
  loaded.exports,
  { documentElement: { style: { setProperty() {} } }, visibilityState: 'visible', body: {} },
  windowStub,
  { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }
)
const { useStore, NewUniverseModal } = loaded.exports

const GIT_FOLDER_REFUSAL =
  'Esta pasta já tem Git. Crie o projeto como versionado, ou escolha uma pasta sem Git.'

// ————————————————————————— utilidades —————————————————————————

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

/** Monta o modal com uma pasta, uma leitura dela e uma resposta do main. */
async function harness({ folder = 'C:\\Users\\Erick\\Documents\\proposta-clinica', inspect, create: onCreate } = {}) {
  const calls = { create: [], inspect: [], closed: 0 }
  let createdProject
  windowStub.synkora = {
    pickFolder: async () => folder,
    missions: { list: async () => [] },
    projects: {
      list: async () => createdProject ? [createdProject] : [],
      inspectFolder: async (path) => {
        calls.inspect.push(path)
        if (inspect instanceof Error) throw inspect
        return inspect ?? { exists: true, hasGit: false, empty: false }
      },
      create: async (...args) => {
        calls.create.push(args)
        createdProject = onCreate
          ? await onCreate(...args)
          : { id: 'p-new', name: args[0], path: args[1], versioning: args[3], createdAt: '2026-09-30T12:00:00.000Z' }
        return createdProject
      }
    }
  }
  useStore.setState({ projects: [], openProjectId: null, mountedProjects: [], missions: [], missionsByProject: {} })
  let tree
  await act(async () => {
    tree = create(React.createElement(NewUniverseModal, { onClose: () => { calls.closed += 1 } }))
  })
  const root = () => tree.root
  const button = (pattern) => {
    const found = root().findAll((n) => n.type === 'button' && pattern.test(textOf(n)))
    assert.ok(found.length > 0, `botão ${pattern} não encontrado`)
    return found[0]
  }
  const toggle = () => root().find((n) => n.type === 'button' && n.props.role === 'switch')
  const remoteInput = () =>
    root().find((n) => n.type === 'input' && n.props.placeholder === 'https://github.com/voce/projeto')
  const remoteBlock = () => root().find((n) => n.props['data-nu'] === 'remote')
  const click = async (node) => {
    await act(async () => { node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }) })
    await flush()
  }
  const type = async (input, value) => {
    await act(async () => { input.props.onChange({ target: { value }, currentTarget: { value } }) })
  }
  return { calls, root, button, toggle, remoteInput, remoteBlock, click, type, tree }
}

async function pickFolder(h) {
  await h.click(h.button(/escolher pasta/i))
  await flush()
}

for (const origin of [null, 'p-existing']) {
  for (const versioning of ['git', 'none']) {
    test(`criar universo ${versioning} a partir de ${origin ?? 'Home'} abre o universo recém-criado`, async () => {
      const h = await harness()
      useStore.setState({ openProjectId: origin, mountedProjects: origin ? [origin] : [] })
      await pickFolder(h)
      if (versioning === 'none') await h.click(h.toggle())
      await h.click(h.button(/criar universo/i))

      const state = useStore.getState()
      assert.equal(state.openProjectId, 'p-new')
      assert.ok(state.mountedProjects.includes('p-new'), 'o universo aberto precisa estar montado')
      if (origin) assert.ok(state.mountedProjects.includes(origin), 'o universo anterior permanece montado')
      assert.equal(state.projects.find((project) => project.id === 'p-new')?.versioning, versioning)
      assert.equal(h.calls.closed, 1)
    })
  }
}

test('criação recusada preserva o universo aberto e mantém o modal', async () => {
  const h = await harness({ create: async () => { throw new Error('Pasta indisponível') } })
  useStore.setState({ openProjectId: 'p-existing', mountedProjects: ['p-existing'] })
  await pickFolder(h)
  await h.click(h.button(/criar universo/i))

  assert.equal(useStore.getState().openProjectId, 'p-existing')
  assert.deepEqual(useStore.getState().mountedProjects, ['p-existing'])
  assert.equal(h.calls.closed, 0)
})

test('universo criado com aviso do GitHub já fica aberto e preserva o aviso até confirmar', async () => {
  const h = await harness({
    create: async (name, path) => ({
      id: 'p-new', name, path, createdAt: '2026-09-30T12:00:00.000Z', gitWarning: 'Não foi possível enviar ao GitHub.'
    })
  })
  await pickFolder(h)
  await h.click(h.button(/criar universo/i))

  assert.equal(useStore.getState().openProjectId, 'p-new')
  assert.ok(useStore.getState().mountedProjects.includes('p-new'))
  assert.match(textOf(h.root()), /Não foi possível enviar ao GitHub\./)
  assert.equal(h.calls.closed, 0)
  await h.click(h.button(/entendi/i))
  assert.equal(h.calls.closed, 1)
  assert.equal(useStore.getState().openProjectId, 'p-new')
})

// ————————————————————————— o interruptor —————————————————————————

test('pasta com Git trava o interruptor LIGADO, diz o motivo e o pedido sai versionado', async () => {
  const h = await harness({
    folder: 'C:\\Users\\Erick\\Projetos\\site-clinica',
    inspect: { exists: true, hasGit: true, empty: false }
  })
  await pickFolder(h)
  assert.deepEqual(h.calls.inspect, ['C:\\Users\\Erick\\Projetos\\site-clinica'])

  const sw = h.toggle()
  assert.equal(String(sw.props['aria-checked']), 'true')
  assert.equal(sw.props.disabled, true, 'travado: o dono não desliga')
  assert.match(textOf(sw), /Versionar com Git/)
  assert.match(textOf(sw), /Esta pasta já tem Git, então o universo nasce versionado\./)

  // clicar no travado não muda nada
  await h.click(sw)
  assert.equal(String(h.toggle().props['aria-checked']), 'true')

  await h.click(h.button(/criar universo/i))
  assert.equal(h.calls.create.length, 1)
  const [name, path, gitUrl, versioning] = h.calls.create[0]
  assert.equal(name, 'site-clinica', 'o nome sai da pasta')
  assert.equal(path, 'C:\\Users\\Erick\\Projetos\\site-clinica')
  assert.equal(gitUrl, undefined)
  assert.equal(versioning, 'git')
  assert.equal(h.calls.closed, 1)
})

test('desligado recolhe o campo do GitHub e o pedido sai sem versionamento e sem link', async () => {
  const h = await harness()
  await pickFolder(h)

  const on = h.toggle()
  assert.equal(String(on.props['aria-checked']), 'true', 'nasce ligado (o de sempre)')
  assert.notEqual(on.props.disabled, true)
  assert.match(textOf(on), /Missões em paralelo, cada uma isolada, entregues por versão\./)
  assert.notEqual(h.remoteBlock().props['aria-hidden'], true, 'ligado: o campo do link aparece')

  // um link digitado ANTES de desligar não pode vazar no pedido
  await h.type(h.remoteInput(), 'https://github.com/erick/proposta')
  await h.click(h.toggle())

  const off = h.toggle()
  assert.equal(String(off.props['aria-checked']), 'false')
  assert.match(textOf(off), /desligado/)
  assert.match(textOf(off), /Uma missão por vez, e o que ela faz vale direto na pasta\./)
  const remote = h.remoteBlock()
  assert.equal(remote.props['aria-hidden'], true, 'desligado: o campo do link some')
  assert.equal(remote.props.inert, true, 'e sai do foco do teclado')

  await h.click(h.button(/criar universo/i))
  assert.equal(h.calls.create.length, 1)
  const [, , gitUrl, versioning] = h.calls.create[0]
  assert.equal(versioning, 'none')
  assert.equal(gitUrl, undefined)
})

test('a leitura da pasta que falha vale "não sei": o interruptor não trava e o modal não bloqueia', async () => {
  const h = await harness({ inspect: new Error("No handler registered for 'projects:inspectFolder'") })
  await pickFolder(h)
  const sw = h.toggle()
  assert.notEqual(sw.props.disabled, true)
  await h.click(sw)
  assert.equal(String(h.toggle().props['aria-checked']), 'false')
  await h.click(h.button(/criar universo/i))
  assert.equal(h.calls.create.length, 1)
  assert.equal(h.calls.create[0][3], 'none')
})

// ————————————————————————— o erro onde quebrou —————————————————————————

test('clone que falha aparece colado ao campo do link, com a saída, e o botão volta a funcionar', async () => {
  const h = await harness({
    inspect: { exists: true, hasGit: false, empty: true },
    create: async () => {
      throw new Error(
        "Error invoking remote method 'projects:create': Error: não consegui clonar: repository not found"
      )
    }
  })
  await pickFolder(h)
  await h.type(h.remoteInput(), 'https://github.com/erick/proposta-clinica')
  await h.click(h.button(/criar universo/i))

  assert.equal(h.calls.create.length, 1)
  assert.equal(h.calls.closed, 0, 'não nasceu: o modal fica')
  const alert = h.remoteBlock().find((n) => n.props.role === 'alert')
  assert.match(textOf(alert), /^Não consegui clonar: repository not found\. /, 'frase da folha, sem o prefixo do IPC')
  assert.doesNotMatch(textOf(alert), /Error invoking remote method/)
  assert.equal(String(h.remoteInput().props['aria-invalid']), 'true')

  const createBtn = h.button(/criar universo/i)
  assert.notEqual(createBtn.props.disabled, true, 'o botão nunca fica preso')
  assert.doesNotMatch(textOf(createBtn), /criando/i)

  // "crie sem o link": tira o link e cria de novo, já sem ele
  await h.click(h.button(/crie sem o link/i))
  assert.equal(h.remoteInput().props.value, '')
  assert.equal(h.remoteBlock().findAll((n) => n.props.role === 'alert').length, 0)
  assert.equal(h.calls.create.length, 2)
  assert.equal(h.calls.create[1][2], undefined, 'o segundo pedido vai sem o link')
  assert.equal(h.calls.create[1][3], 'git')
})

test('pasta com Git recusada pelo main trava o interruptor e mostra a recusa nele', async () => {
  const h = await harness({
    // a leitura não soube (handler ausente) e o main descobriu na criação
    inspect: new Error('sem handler'),
    create: async (...args) => {
      if (args[3] === 'none') throw new Error(`Error invoking remote method 'projects:create': Error: ${GIT_FOLDER_REFUSAL}`)
      return { id: 'p-new', name: args[0], path: args[1], createdAt: '2026-09-30T12:00:00.000Z' }
    }
  })
  await pickFolder(h)
  await h.click(h.toggle())
  await h.click(h.button(/criar universo/i))

  const sw = h.toggle()
  assert.equal(String(sw.props['aria-checked']), 'true')
  assert.equal(sw.props.disabled, true)
  const alerts = h.root().findAll((n) => n.props.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(textOf(alerts[0]), GIT_FOLDER_REFUSAL)
  assert.equal(alerts[0].props['data-nu'], 'versioning-error', 'o erro mora no interruptor')

  // a saída: criar de novo já vai versionado
  await h.click(h.button(/criar universo/i))
  assert.equal(h.calls.create.length, 2)
  assert.equal(h.calls.create[1][3], 'git')
  assert.equal(h.calls.closed, 1)
})

test('"Não dá para trocar depois." mora na linha do botão que decide', async () => {
  const h = await harness()
  const actions = h.root().find((n) => n.props.className === 'sm-actions')
  assert.match(textOf(actions), /Não dá para trocar depois\./)
  assert.ok(actions.findAll((n) => n.type === 'button' && /criar universo/i.test(textOf(n))).length === 1)
})

test('o modal é uma folha de papel: sem o filete vermelho do confirm-modal', async () => {
  const h = await harness()
  const dialog = h.root().find((n) => n.props.role === 'dialog')
  assert.match(dialog.props.className, /\bsheet-modal\b/)
  assert.doesNotMatch(dialog.props.className, /confirm-modal/)
})

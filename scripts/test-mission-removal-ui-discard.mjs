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
  external: ['react', 'react/jsx-runtime', 'react-dom', 'zustand'], loader: { '.css': 'empty' },
  plugins: [{ name: 'mission-discard-test-export', setup(builder) {
    builder.onLoad({ filter: /BacklogView\.tsx$/ }, ({ path }) => ({
      contents: readFileSync(path, 'utf8') + '\nexport { MissionsPane }', loader: 'tsx'
    }))
  } }]
})).outputFiles[0].text

const dirtyError = 'A pasta da missão contém alterações locais. Salve as alterações antes de excluir.'
const receipt = { token: 'synthetic-opaque-receipt-1', title: 'Missão sintética 📄 中文' }
const refusal = discard => ({ ok: false, error: dirtyError, discard })
const confirmation = discard => ({ discardToken: discard.token, confirmTitle: discard.title })
const textOf = node => typeof node === 'string' ? node : (node.children ?? []).map(textOf).join('')

async function fixture(t, remove, options = {}) {
  const loaded = { exports: {} }, requests = []
  const first = {
    id: 'synthetic', projectId: 'project', title: receipt.title, status: 'arquivada', direct: true,
    branch: 'mission/synthetic', createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z'
  }
  const second = { ...first, id: 'synthetic-other', title: 'Outra missão sintética', branch: 'mission/synthetic-other' }
  const missions = options.twoMissions ? [first, second] : [first]
  const window = { synkora: { missions: {
    remove: async (id, ownerConfirmation) => {
      requests.push({ id, ...(ownerConfirmation === undefined ? {} : { confirmation: ownerConfirmation }) })
      return remove(id, ownerConfirmation)
    },
    list: options.list ?? (async () => missions)
  } } }
  const document = { body: {}, documentElement: { style: { setProperty() {} } } }
  const uiRequire = name => name === 'react-dom' ? { createPortal: children => children } : require(name)
  new Function('require', 'module', 'exports', 'window', 'document', 'localStorage', uiCode)(
    uiRequire, loaded, loaded.exports, window, document, { getItem: () => null }
  )
  const { MissionsPane, useStore } = loaded.exports
  useStore.setState({ missions, openProjectId: 'project', missionTabByProject: { project: 'current' } })
  let tree
  await act(async () => { tree = create(React.createElement(MissionsPane, { projectId: 'project', versions: [] })) })
  t.after(async () => { await act(async () => tree.unmount()) })
  const find = className => tree.root.findAll(node => node.props.className === className)
  const click = async node => { await act(async () => { node.props.onClick() }) }
  const submit = () => find('btn danger-solid')[0]
  const checkbox = () => tree.root.findAll(node => node.type === 'input' && node.props.type === 'checkbox')[0]
  const consent = async checked => {
    assert.ok(checkbox(), 'structured dirty refusal must offer explicit consent')
    await act(async () => { checkbox().props.onChange({ target: { checked } }) })
  }
  const alerts = () => tree.root.findAll(node => node.props.role === 'alert').map(textOf).join('\n')
  const open = async (index = 0) => click(find('btn ghost tiny danger')[index])
  await open()
  return { tree, useStore, requests, find, click, submit, checkbox, consent, alerts, open, missions }
}

test('ordinary refusal carries no confirmation and dirty wording alone cannot authorize discard', async t => {
  const h = await fixture(t, () => ({ ok: false, error: dirtyError }))
  await h.click(h.submit())
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.equal(h.alerts(), dirtyError)
  assert.equal(h.checkbox(), undefined)
  assert.deepEqual(h.requests, [{ id: 'synthetic' }])
  assert.equal(h.useStore.getState().missionTabByProject.project, 'current')
})

test('structured dirty refusal preserves its reason and requires initially unchecked explicit loss consent', async t => {
  const h = await fixture(t, () => refusal(receipt))
  await h.click(h.submit())
  assert.equal(h.alerts(), dirtyError)
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.ok(h.checkbox(), 'dirty receipt must show an explicit consent checkbox')
  assert.equal(h.checkbox().props.checked, false)
  assert.equal(h.submit().props.disabled, true)
  assert.equal(textOf(h.submit()), 'Descartar alterações e excluir')
  assert.match(textOf(h.tree.root), /alterações locais.*arquivos.*apagados/iu)
  assert.match(textOf(h.tree.root), /Não dá para desfazer/u)
  await h.click(h.submit())
  assert.deepEqual(h.requests, [{ id: 'synthetic' }])
})

test('only checked consent sends the exact opaque receipt and title, then closes on confirmed success', async t => {
  const h = await fixture(t, (_id, ownerConfirmation) => ownerConfirmation ? { ok: true } : refusal(receipt), {
    list: async () => []
  })
  await h.click(h.submit())
  await h.consent(true)
  assert.equal(h.submit().props.disabled, false)
  await h.click(h.submit())
  assert.deepEqual(h.requests, [{ id: 'synthetic' }, { id: 'synthetic', confirmation: confirmation(receipt) }])
  assert.equal(h.find('task-modal confirm-modal').length, 0)
  assert.equal(h.find('ms-row arquivada').length, 0)
  assert.equal(h.find('files-empty').length, 1)
  assert.equal(h.useStore.getState().missionTabByProject.project, null)
})

test('unchecking consent blocks even a direct submission handler call', async t => {
  const h = await fixture(t, () => refusal(receipt))
  await h.click(h.submit())
  await h.consent(true)
  await h.consent(false)
  await h.click(h.submit())
  assert.equal(h.requests.length, 1)
})

test('pending discard retains the refusal, locks consent and all closing controls, and ignores duplicate clicks', async t => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const h = await fixture(t, (_id, ownerConfirmation) => ownerConfirmation ? pending : refusal(receipt))
  await h.click(h.submit())
  await h.consent(true)
  const submit = h.submit()
  await act(async () => { submit.props.onClick(); submit.props.onClick() })
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.equal(h.alerts(), dirtyError)
  assert.equal(h.submit().props.disabled, true)
  assert.equal(h.checkbox().props.disabled, true)
  assert.equal(h.tree.root.findByProps({ role: 'dialog' }).props['aria-busy'], true)
  for (const close of [h.find('overlay')[0], h.find('btn ghost')[0], h.find('pane-close dark-close')[0]]) await h.click(close)
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.equal(h.requests.length, 2)
  await act(async () => { finish({ ok: true }); await pending })
  assert.equal(h.find('task-modal confirm-modal').length, 0)
})

for (const [name, next] of [
  ['receipt', { ...receipt, token: 'synthetic-opaque-receipt-2' }],
  ['title', { ...receipt, title: 'Título sintético atualizado' }]
]) {
  test(`changed ${name} after refusal requires renewed consent and sends only the new pair`, async t => {
    let attempt = 0
    const h = await fixture(t, () => ++attempt === 1 ? refusal(receipt) : attempt === 2
      ? { ok: false, error: 'As alterações mudaram. Confira e confirme novamente.', discard: next }
      : { ok: true })
    await h.click(h.submit())
    await h.consent(true)
    await h.click(h.submit())
    assert.equal(h.find('task-modal confirm-modal').length, 1)
    assert.equal(h.checkbox().props.checked, false)
    assert.equal(h.submit().props.disabled, true)
    assert.match(h.alerts(), /mudaram/u)
    assert.ok(textOf(h.tree.root).includes(next.title))
    await h.click(h.submit())
    assert.equal(h.requests.length, 2)
    await h.consent(true)
    await h.click(h.submit())
    assert.deepEqual(h.requests[2], { id: 'synthetic', confirmation: confirmation(next) })
    assert.equal(h.find('task-modal confirm-modal').length, 0)
  })
}

test('a refusal without a new receipt revokes discard authority and retains an ordinary retry', async t => {
  let attempt = 0
  const h = await fixture(t, () => ++attempt === 1 ? refusal(receipt)
    : { ok: false, error: 'Há uma integração pendente. Abra o chat da missão.' })
  await h.click(h.submit())
  await h.consent(true)
  await h.click(h.submit())
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.equal(h.checkbox(), undefined)
  assert.match(h.alerts(), /integração pendente/u)
  await h.click(h.submit())
  assert.deepEqual(h.requests[2], { id: 'synthetic' })
})

test('a renewed refusal with the same receipt still starts unchecked', async t => {
  const h = await fixture(t, () => refusal(receipt))
  await h.click(h.submit())
  await h.consent(true)
  await h.click(h.submit())
  assert.equal(h.checkbox().props.checked, false)
  assert.equal(h.submit().props.disabled, true)
})

test('closing and reopening a mission clears its receipt, refusal and consent', async t => {
  const h = await fixture(t, () => refusal(receipt))
  await h.click(h.submit())
  await h.consent(true)
  await h.click(h.find('btn ghost')[0])
  await h.open()
  assert.equal(h.checkbox(), undefined)
  assert.equal(h.alerts(), '')
  await h.click(h.submit())
  assert.deepEqual(h.requests[1], { id: 'synthetic' })
  assert.equal(h.checkbox().props.checked, false)
})

test('opening another mission cannot inherit the first mission receipt or consent', async t => {
  const h = await fixture(t, id => refusal({ ...receipt, title: id === 'synthetic' ? receipt.title : 'Outra missão sintética' }), { twoMissions: true })
  await h.click(h.submit())
  await h.consent(true)
  await h.open(1)
  assert.equal(h.checkbox(), undefined)
  assert.equal(h.alerts(), '')
  await h.click(h.submit())
  assert.deepEqual(h.requests[1], { id: 'synthetic-other' })
  assert.equal(h.checkbox().props.checked, false)
})

test('a live mission title change resets discard authority before another submission', async t => {
  const h = await fixture(t, () => refusal(receipt))
  await h.click(h.submit())
  await h.consent(true)
  await act(async () => { h.useStore.setState({ missions: [{ ...h.missions[0], title: 'Título atualizado no estado' }] }) })
  assert.equal(h.checkbox(), undefined)
  assert.ok(textOf(h.tree.root).includes('Título atualizado no estado'))
  await h.click(h.submit())
  assert.deepEqual(h.requests[1], { id: 'synthetic' })
})

test('transport uncertainty requires a fresh normal refusal and unchecked consent before any discard retry', async t => {
  const refreshed = { ...receipt, token: 'synthetic-opaque-receipt-after-transport' }
  let attempt = 0
  const h = await fixture(t, () => {
    attempt += 1
    if (attempt === 1) return refusal(receipt)
    if (attempt === 2) throw new Error('synthetic private transport details')
    if (attempt === 3) return refusal(refreshed)
    return { ok: true }
  })
  await h.click(h.submit())
  await h.consent(true)
  await h.click(h.submit())
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.match(h.alerts(), /confirmar.*exclusão|conferir.*resultado/iu)
  assert.doesNotMatch(h.alerts(), /private transport/u)
  assert.equal(h.checkbox(), undefined)
  await h.click(h.submit())
  assert.deepEqual(h.requests[2], { id: 'synthetic' })
  assert.equal(h.checkbox().props.checked, false)
  assert.equal(h.submit().props.disabled, true)
  await h.click(h.submit())
  assert.equal(h.requests.length, 3)
  await h.consent(true)
  await h.click(h.submit())
  assert.deepEqual(h.requests[3], { id: 'synthetic', confirmation: confirmation(refreshed) })
  assert.equal(h.find('task-modal confirm-modal').length, 0)
})

test('successful removal followed by list refresh failure remains visible without reusable consent', async t => {
  const h = await fixture(t, (_id, ownerConfirmation) => ownerConfirmation ? { ok: true } : refusal(receipt), {
    list: async () => { throw new Error('synthetic private refresh details') }
  })
  await h.click(h.submit())
  await h.consent(true)
  await h.click(h.submit())
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.match(h.alerts(), /conferir o resultado/u)
  assert.doesNotMatch(h.alerts(), /private refresh/u)
  assert.equal(h.checkbox(), undefined)
})

test('a direct store rejection clears consent and reports uncertainty without exposing exception details', async t => {
  const h = await fixture(t, () => refusal(receipt))
  await h.click(h.submit())
  await h.consent(true)
  await act(async () => {
    h.useStore.setState({ deleteMission: async () => { throw new Error('synthetic private store details') } })
  })
  await h.click(h.submit())
  assert.equal(h.find('task-modal confirm-modal').length, 1)
  assert.match(h.alerts(), /conferir o resultado/u)
  assert.doesNotMatch(h.alerts(), /private store/u)
  assert.equal(h.checkbox(), undefined)
})

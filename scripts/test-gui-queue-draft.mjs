import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'
import {
  GUI_QUEUE_CLAIM_LEASE_MS,
  acknowledgeGuiQueuedMessage,
  claimGuiQueuedMessage,
  readGuiQueuedMessage,
  releaseGuiQueuedMessageClaim,
  removeGuiQueuedMessage,
  writeGuiQueuedMessage
} from '../src/renderer/src/guiMessageQueue.ts'
import {
  dispatchOneGuiQueuedMessage,
  forceOneGuiQueuedMessage,
  shouldAttemptGuiQueuedDelivery
} from '../src/renderer/src/guiQueuedDelivery.ts'
import { guiComposerClearPlan } from '../src/renderer/src/guiComposerDelivery.ts'
import { guiWaitsForHelperResult } from '../src/renderer/src/guiHelperWait.ts'
import {
  readGuiDraft,
  removeGuiDraft,
  writeGuiDraft
} from '../src/renderer/src/guiDraftStorage.ts'
import {
  readGuiComposerAttachments,
  removeGuiComposerAttachments,
  writeGuiComposerAttachments
} from '../src/renderer/src/guiComposerAttachmentStorage.ts'

const compiled = buildSync({
  stdin: { contents: `
    export { useStore, EMPTY_GUI_PANE } from './src/renderer/src/store';
    export { default as QueueDispatcher } from './src/renderer/src/components/GuiQueueDispatcher';
    export { default as QueueCard } from './src/renderer/src/components/GuiQueuedMessageCard';
    export { guiApi } from './src/renderer/src/guiApi';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'zustand']
})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function rendererHarness(storage, windowMock = {}) {
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiled.outputFiles[0].text)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { documentElement: { style: { setProperty() {} } } }, { setTimeout, clearTimeout, ...windowMock }, storage
  )
  return loaded.exports
}

class MemoryStorage {
  #values = new Map()
  #maxChars

  constructor(maxChars = Infinity) {
    this.#maxChars = maxChars
  }

  get length() {
    return this.#values.size
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null
  }

  getItem(key) {
    return this.#values.get(key) ?? null
  }

  setItem(key, value) {
    const next = new Map(this.#values)
    next.set(key, String(value))
    const size = [...next.entries()].reduce((total, [entryKey, entryValue]) => {
      return total + entryKey.length + entryValue.length
    }, 0)
    if (size > this.#maxChars) {
      const error = new Error('quota')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.#values = next
  }

  removeItem(key) {
    this.#values.delete(key)
  }
}

test('helper-wait delivery requires a ready, quiet parent with only its own result waits pending', () => {
  const waiting = { kind: 'tool', name: 'helper_result', toolUseId: 'wait' }
  const pane = { status: 'working', ready: true, thinking: false, stream: '', items: [waiting] }
  assert.equal(guiWaitsForHelperResult(pane), true)
  for (const patch of [
    { status: 'idle' }, { status: 'waiting-you' }, { status: 'dead' }, { status: 'starting' },
    { ready: false }, { thinking: true }, { stream: 'resposta em andamento' }, { items: [] },
    { items: [{ ...waiting, result: { status: 'completed' } }] },
    { items: [{ ...waiting, parentToolUseId: 'child' }] },
    { items: [{ ...waiting, name: 'mcp__another__helper_result' }] },
    { items: [{ kind: 'assistant', text: 'estou esperando helper_result' }] }
  ]) assert.equal(guiWaitsForHelperResult({ ...pane, ...patch }), false, JSON.stringify(patch))
  assert.equal(guiWaitsForHelperResult({ ...pane, items: [waiting,
    { ...waiting, name: 'mcp__synkora__helper_result', toolUseId: 'second-wait' },
    { kind: 'tool', name: 'Bash', parentToolUseId: 'child' }] }), true)
})

test('queued guidance reaches a helper wait without ending the parent turn or forcing the fleet', async () => {
  for (const name of ['helper_result', 'mcp__synkora__helper_result']) {
    const storage = new MemoryStorage(), sent = []
    const { useStore, EMPTY_GUI_PANE, QueueDispatcher } = rendererHarness(storage, { synkora: { gui: {
      deliverQueued: async (...args) => { sent.push(args); return { ok: true } },
      send: () => { throw new Error('queued delivery must preserve the executor snapshot') },
      forceOwnerMessage: () => { throw new Error('automatic reading must not interrupt anything') }
    } } })
    useStore.setState({ guiPanes: { pane: { ...EMPTY_GUI_PANE, ready: false, status: 'working' } } })
    const attachments = [{ id: 'synthetic-image', capability: `gui-cap-v1-${'Q'.repeat(43)}`,
      kind: 'image', name: 'layout.png', mime: 'image/png', size: 42 }]
    const queued = useStore.getState().queueGuiMessage('pane', 'corrija a letra cortada',
      { model: null, effort: null, permissionMode: 'default' }, attachments)
    let tree
    await act(async () => { tree = create(React.createElement(QueueDispatcher)) })
    try {
      assert.equal(sent.length, 0, 'an unready parent keeps the message cancellable')
      await act(async () => {
        useStore.getState().handleGuiLive('pane', { type: 'ready' })
        useStore.getState().handleGuiLive('pane', {
          type: 'tool', name, toolUseId: 'waiting-for-helper', input: { helperId: 'synthetic-helper' }
        })
      })
      assert.equal(sent.length, 1, 'waiting for a helper must release the queued guidance now')
      assert.equal(sent[0][0], 'pane')
      assert.equal(sent[0][1].id, queued.id)
      assert.equal(sent[0][1].text, queued.text)
      assert.deepEqual(sent[0][1].options, queued.options)
      assert.deepEqual(sent[0][1].attachments, attachments)
      assert.equal(useStore.getState().guiPanes.pane.status, 'working')
      assert.equal(useStore.getState().guiPanes.pane.queued, null)
      assert.equal(readGuiQueuedMessage('pane', storage), null)
    } finally { await act(async () => tree.unmount()) }
  }
})

test('cancelled guidance stays cancelled across child and parent activity before the bridge becomes ready', async () => {
  const storage = new MemoryStorage(), sent = []
  const { useStore, EMPTY_GUI_PANE, QueueDispatcher } = rendererHarness(storage, { synkora: { gui: {
    deliverQueued: async (...args) => { sent.push(args); return { ok: true } }
  } } })
  useStore.setState({ guiPanes: { pane: { ...EMPTY_GUI_PANE, ready: false, status: 'working' } } })
  const queued = useStore.getState().queueGuiMessage('pane', 'orientação cancelável',
    { model: null, effort: null, permissionMode: 'default' }, [])
  let tree
  await act(async () => { tree = create(React.createElement(QueueDispatcher)) })
  try {
    for (const event of [
      { type: 'tool', name: 'helper_result', toolUseId: 'child-wait', parentToolUseId: 'helper-card' },
      { type: 'tool', name: 'Bash', toolUseId: 'real-work' },
      { type: 'tool', name: 'helper_result', toolUseId: 'parent-wait' }
    ]) await act(async () => useStore.getState().handleGuiLive('pane', { ...event, input: {} }))
    assert.equal(sent.length, 0, 'tool activity cannot bypass bridge readiness')
    await act(async () => {
      assert.equal(useStore.getState().discardGuiQueuedMessage('pane', queued.id), true)
      useStore.getState().handleGuiLive('pane', { type: 'tool-result', toolUseId: 'real-work', text: 'done', isError: false })
      useStore.getState().handleGuiLive('pane', { type: 'ready' })
    })
    assert.equal(sent.length, 0, 'entering a helper wait cannot resurrect a cancelled message')
    assert.equal(readGuiQueuedMessage('pane', storage), null)
    await act(async () => useStore.getState().queueGuiMessage('pane', 'nova orientação', queued.options, []))
    assert.equal(sent.length, 1, 'a message submitted during an existing wait is delivered automatically')
  } finally { await act(async () => tree.unmount()) }
})

/** Real Zustand queue actions; only browser globals and storage are synthetic. */
function discardActionHarness(message, storage) {
  const { useStore } = rendererHarness(storage)
  useStore.setState({ guiPanes: { pane: { status: 'working', queued: message } } })
  return { action: useStore.getState().discardGuiQueuedMessage, state: useStore.getState }
}

test('cancelamento recusado pelo storage conserva o cartão e informa a falha', () => {
  const storage = new MemoryStorage()
  const message = {
    id: 'cancel-storage', text: 'ainda necessária', at: 10,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: []
  }
  writeGuiQueuedMessage('pane', message, storage)
  const refusing = {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: () => { throw new Error('armazenamento indisponível') }
  }
  const harness = discardActionHarness(message, refusing)
  const cancelled = harness.action('pane', message.id)
  assert.deepEqual(harness.state().guiPanes.pane.queued, message)
  assert.deepEqual(readGuiQueuedMessage('pane', storage), message)
  assert.equal(cancelled, false)
})

test('cancelar com cartão antigo preserva a mensagem que outro renderer já está enviando', () => {
  const storage = new MemoryStorage()
  const message = {
    id: 'cancel-race', text: 'mensagem exata', at: 11,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: []
  }
  writeGuiQueuedMessage('pane', message, storage)
  const harness = discardActionHarness(message, storage)
  claimGuiQueuedMessage('pane', 'other-renderer', storage)
  const cancelled = harness.action('pane', message.id)
  assert.equal(harness.state().guiPanes.pane.queued?.deliveryInFlight, true)
  assert.equal(readGuiQueuedMessage('pane', storage)?.id, message.id)
  assert.equal(cancelled, false)
})

test('mensagem comum pode esperar e ser cancelada sem tocar no turno atual ou nos anexos', async () => {
  const storage = new MemoryStorage()
  const { useStore } = rendererHarness(storage)
  const currentItems = [{ id: 'current', kind: 'assistant', text: 'trabalho em andamento' }]
  useStore.setState({ guiPanes: { pane: { status: 'working', queued: null, items: currentItems } } })
  const options = { model: 'modelo-sintetico', effort: 'high', permissionMode: 'default' }
  const attachments = [{ id: 'document', capability: `gui-cap-v1-${'Q'.repeat(43)}`,
    kind: 'file', name: 'notas.txt', mime: 'text/plain', size: 18 }]
  const queued = useStore.getState().queueGuiMessage('pane', 'pode fazer isso depois', options, attachments)
  assert.ok(queued)
  assert.deepEqual(readGuiQueuedMessage('pane', storage)?.attachments, attachments)
  assert.equal(useStore.getState().discardGuiQueuedMessage('pane', queued.id), true)
  assert.equal(useStore.getState().guiPanes.pane.status, 'working')
  assert.equal(useStore.getState().guiPanes.pane.items, currentItems)
  assert.deepEqual(attachments[0].name, 'notas.txt')
  assert.equal(readGuiQueuedMessage('pane', storage), null)
  const reopened = rendererHarness(storage)
  reopened.useStore.getState().markGuiSpawned('pane')
  assert.equal(reopened.useStore.getState().guiPanes.pane.queued, null)
  const outcome = await dispatchOneGuiQueuedMessage({
    claim: () => claimGuiQueuedMessage('pane', 'next-turn', storage),
    deliver: () => { throw new Error('cancelamento não pode virar envio') },
    ack: () => false,
    restore: () => { throw new Error('cancelamento não pode ressuscitar a fila') }
  })
  assert.equal(outcome.status, 'empty')
})

test('cartão antigo não cancela a próxima mensagem e reenvio recusado conserva o rascunho', () => {
  const storage = new MemoryStorage()
  const older = { id: 'older', text: 'antiga', at: 1,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  const newer = { ...older, id: 'newer', text: 'mais recente' }
  writeGuiQueuedMessage('pane', newer, storage)
  const harness = discardActionHarness(older, storage)
  assert.equal(harness.action('pane', older.id), false)
  assert.deepEqual(harness.state().guiPanes.pane.queued, newer)
  assert.deepEqual(readGuiQueuedMessage('pane', storage), newer)
  const { useStore } = rendererHarness(storage)
  useStore.setState({ guiPanes: { pane: { status: 'idle', queued: null } } })
  const queued = useStore.getState().queueGuiMessage('pane', 'rascunho atual', older.options, [])
  assert.equal(queued, null, 'resposta já terminou; o gesto não deve enviar agora por conta própria')
  assert.deepEqual(guiComposerClearPlan(Boolean(queued), 'rascunho atual', 'rascunho atual', [], []),
    { draft: false, attachments: false })
})

test('mensagem na fila aparece como bolha com ler agora e X; envio em curso bloqueia ambos', async () => {
  const { QueueCard } = rendererHarness(new MemoryStorage())
  let card, now = 0, cancelled = 0
  const message = { id: 'queue-ui', text: 'orientação sintética', at: 10,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  const cardProps = { message, onReadNow: () => now++,
    onCancel: () => { cancelled++; return false } }
  await act(async () => { card = create(React.createElement(QueueCard, cardProps)) })
  try {
    const buttons = card.root.findAllByType('button')
    assert.equal(buttons.length, 2, 'the queue offers only read now or cancel')
    assert.ok(card.root.findByProps({ className: 'gui-msg-text' }).children.includes(message.text))
    assert.equal(card.root.findByProps({ className: 'gui-msg-tag' }).children.join(''), 'você')
    await act(async () => buttons.find(button => button.children.includes('ler agora')).props.onClick())
    assert.equal(now, 1)
    await act(async () => card.root.findByProps({ 'aria-label': 'Cancelar envio da mensagem na fila' }).props.onClick())
    assert.equal(cancelled, 1)
    assert.match(card.root.findByProps({ role: 'alert' }).children.join(''), /não foi possível confirmar o cancelamento/iu)
    await act(async () => card.update(React.createElement(QueueCard, { ...cardProps,
      message: { ...message, deliveryInFlight: true } })))
    assert.ok(card.root.findAllByType('button').every(button => button.props.disabled))
  } finally { await act(async () => card.unmount()) }
})

test('fila com arquivo ou pasta sem palavras mantém o anexo e os controles sem bolha vazia', async () => {
  const { QueueCard } = rendererHarness(new MemoryStorage())
  for (const kind of ['file', 'folder']) {
    for (const text of ['', ' \n\t ']) {
      const message = { id: 'queue-attachment', text, at: 10,
        options: { model: null, effort: null, permissionMode: 'default' },
        attachments: [{ id: 'synthetic', capability: `gui-cap-v1-${'A'.repeat(43)}`,
          kind, name: kind === 'file' ? 'sintetico.txt' : 'pasta-sintetica',
          mime: kind === 'file' ? 'text/plain' : null, size: kind === 'file' ? 20 : null }] }
      let card
      await act(async () => { card = create(React.createElement(QueueCard, {
        paneId: 'synthetic', message, onReadNow() {}, onCancel: () => true
      })) })
      try {
        assert.equal(card.root.findAllByProps({ className: 'gui-msg-text' }).length, 0,
          `${kind} with ${JSON.stringify(text)} must not produce an empty text bubble`)
        assert.equal(card.root.findByProps({ className: 'gui-attachment-name' }).children.join(''), message.attachments[0].name)
        assert.deepEqual(card.root.findAllByType('button').map(button => button.children.join('')), ['ler agora', 'cancelar'])
      } finally { await act(async () => card.unmount()) }
    }
  }
})

test('bridge diferencia recusa autoritativa de envio sem recibo', async () => {
  const response = { value: { ok: false, error: 'a resposta anterior ainda não terminou' } }
  const { guiApi } = rendererHarness(new MemoryStorage(), { synkora: { gui: {
    send: async () => response.value,
    deliverQueued: async () => response.value
  } } })
  const message = { id: 'api-queue', text: 'texto sintético', at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  assert.deepEqual(await guiApi.deliverQueued('pane', message), response.value)
  response.value = undefined
  assert.equal((await guiApi.deliverQueued('pane', message)).deliveryUncertain, true)
  assert.equal((await guiApi.send('pane', message.text, message.id, [])).deliveryUncertain, true)
  response.value = {}
  assert.equal((await guiApi.deliverQueued('pane', message)).deliveryUncertain, true)
  assert.equal((await guiApi.send('pane', message.text, message.id, [])).deliveryUncertain, true)
})

test('fila persiste até o ACK e uma lease impede outro renderer de tomar o bilhete', () => {
  const storage = new MemoryStorage()
  const attachments = [
    {
      id: 'attachment-1',
      capability: `gui-cap-v1-${'A'.repeat(43)}`,
      kind: 'image',
      name: 'print.png',
      mime: 'image/png',
      size: 42
    }
  ]
  const message = {
    id: 'queued-1',
    text: 'continue depois',
    at: 42,
    options: { model: 'gpt-5.6-terra', effort: 'max', permissionMode: 'default' },
    attachments
  }
  assert.equal(writeGuiQueuedMessage('pane-a', message, storage), true)
  assert.deepEqual(readGuiQueuedMessage('pane-a', storage), message)
  const now = Date.now()
  const claimed = claimGuiQueuedMessage('pane-a', 'renderer-a', storage, now)
  assert.equal(claimed?.id, message.id)
  assert.equal(claimed?.deliveryInFlight, true)
  assert.equal(claimed?.deliveryClaimedUntil, now + GUI_QUEUE_CLAIM_LEASE_MS)
  assert.equal(claimGuiQueuedMessage('pane-a', 'renderer-b', storage, now + 1), null)
  assert.equal(readGuiQueuedMessage('pane-a', storage)?.id, message.id)
  assert.equal(acknowledgeGuiQueuedMessage('pane-a', message.id, 'renderer-a', storage), true)
  assert.equal(readGuiQueuedMessage('pane-a', storage), null)
})

test('crash do renderer conserva o bilhete e outra janela o reclama após a lease', () => {
  const storage = new MemoryStorage()
  const message = {
    id: 'queued-crash',
    text: 'não perca esta mensagem',
    at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' },
    attachments: []
  }
  const now = Date.now()
  assert.equal(writeGuiQueuedMessage('pane-crash', message, storage), true)
  assert.equal(claimGuiQueuedMessage('pane-crash', 'renderer-a', storage, now)?.id, message.id)
  assert.equal(
    claimGuiQueuedMessage(
      'pane-crash',
      'renderer-b',
      storage,
      now + GUI_QUEUE_CLAIM_LEASE_MS - 1
    ),
    null
  )
  const reclaimed = claimGuiQueuedMessage(
    'pane-crash',
    'renderer-b',
    storage,
    now + GUI_QUEUE_CLAIM_LEASE_MS + 1
  )
  assert.equal(reclaimed?.id, message.id)
  assert.equal(
    releaseGuiQueuedMessageClaim(
      'pane-crash',
      'renderer-b',
      reclaimed,
      'ponte indisponível',
      storage
    )?.deliveryError,
    'ponte indisponível'
  )
  assert.equal(readGuiQueuedMessage('pane-crash', storage)?.id, message.id)
})

test('lease vencida permite retomada, mas nunca libera editar ou apagar antes do desfecho', () => {
  const storage = new MemoryStorage()
  const message = {
    id: 'queued-slow',
    text: 'entrega lenta',
    at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' },
    attachments: []
  }
  const now = Date.now()
  assert.equal(writeGuiQueuedMessage('pane-slow', message, storage), true)
  assert.equal(
    claimGuiQueuedMessage(
      'pane-slow',
      'renderer-a',
      storage,
      now - GUI_QUEUE_CLAIM_LEASE_MS - 1
    )?.id,
    message.id
  )
  assert.equal(readGuiQueuedMessage('pane-slow', storage)?.deliveryInFlight, true)
  assert.equal(removeGuiQueuedMessage('pane-slow', message.id, storage), false)
  const expired = readGuiQueuedMessage('pane-slow', storage)
  assert.equal(shouldAttemptGuiQueuedDelivery('dead', false, expired, now), true)
  assert.equal(
    shouldAttemptGuiQueuedDelivery('dead', false, {
      ...expired,
      deliveryClaimedUntil: now + 1
    }, now),
    false
  )
  assert.equal(claimGuiQueuedMessage('pane-slow', 'renderer-b', storage, now)?.id, message.id)
  assert.equal(acknowledgeGuiQueuedMessage('pane-slow', message.id, 'renderer-b', storage), true)
})

test('remoção da fila respeita o id esperado e payload adulterado não entra', () => {
  const storage = new MemoryStorage()
  const message = {
    id: 'queued-2',
    text: 'mensagem',
    at: 7,
    options: { model: null, effort: null, permissionMode: 'plan' },
    attachments: []
  }
  assert.equal(writeGuiQueuedMessage('pane-a', message, storage), true)
  assert.equal(removeGuiQueuedMessage('pane-a', 'outra', storage), false)
  assert.deepEqual(readGuiQueuedMessage('pane-a', storage), message)
  assert.equal(removeGuiQueuedMessage('pane-a', message.id, storage), true)
  storage.setItem('synkora.guiQueue.pane-a', JSON.stringify({ v: 1, text: 'sem id' }))
  assert.equal(readGuiQueuedMessage('pane-a', storage), null)
})

test('rascunho é isolado por pane e texto vazio remove a chave', () => {
  const storage = new MemoryStorage()
  assert.equal(writeGuiDraft('pane-a', 'alpha', storage, 1), true)
  assert.equal(writeGuiDraft('pane-b', 'beta', storage, 2), true)
  assert.equal(readGuiDraft('pane-a', storage), 'alpha')
  assert.equal(readGuiDraft('pane-b', storage), 'beta')
  assert.equal(writeGuiDraft('pane-a', '', storage, 3), true)
  assert.equal(readGuiDraft('pane-a', storage), '')
  removeGuiDraft('pane-b', storage)
  assert.equal(readGuiDraft('pane-b', storage), '')
})

test('quota cheia descarta primeiro o rascunho mais antigo', () => {
  const storage = new MemoryStorage(230)
  assert.equal(writeGuiDraft('old', 'a'.repeat(45), storage, 1), true)
  assert.equal(writeGuiDraft('newer', 'b'.repeat(45), storage, 2), true)
  assert.equal(writeGuiDraft('current', 'c'.repeat(70), storage, 3), true)
  assert.equal(readGuiDraft('old', storage), '')
  assert.equal(readGuiDraft('current', storage), 'c'.repeat(70))
})

test('substituição impossível não apaga a versão anterior do rascunho atual', () => {
  const storage = new MemoryStorage(130)
  const prior = 'rascunho que ainda precisa sobreviver'
  assert.equal(writeGuiDraft('current', prior, storage, 1), true)
  assert.equal(writeGuiDraft('current', 'x'.repeat(180), storage, 2), false)
  assert.equal(readGuiDraft('current', storage), prior)
})

test('50 MB attachment survives composer and queue reload without losing the prior draft on overflow', () => {
  const storage = new MemoryStorage()
  const attachment = {
    id: 'large-synthetic', capability: `gui-cap-v1-${'L'.repeat(43)}`,
    kind: 'file', name: 'large-synthetic.txt', mime: 'text/plain', size: 50 * 1024 * 1024
  }
  assert.equal(writeGuiComposerAttachments('large-pane', [attachment], storage, 1), true)
  assert.deepEqual(readGuiComposerAttachments('large-pane', storage), [attachment])
  const queued = {
    id: 'large-message', text: 'Confira o documento sintético.', at: 2,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [attachment]
  }
  assert.equal(writeGuiQueuedMessage('large-pane', queued, storage), true)
  assert.deepEqual(readGuiQueuedMessage('large-pane', storage)?.attachments, [attachment])

  const oversized = { ...attachment, size: attachment.size + 1 }
  assert.equal(writeGuiComposerAttachments('large-pane', [oversized], storage, 3), false)
  assert.equal(writeGuiQueuedMessage('large-pane', { ...queued, attachments: [oversized] }, storage), false)
  assert.deepEqual(readGuiComposerAttachments('large-pane', storage), [attachment])
  assert.deepEqual(readGuiQueuedMessage('large-pane', storage)?.attachments, [attachment])
})

test('anexos persistem por pane, removem e atravessam a fila sem virar texto', () => {
  const storage = new MemoryStorage()
  const attachments = [
    {
      id: 'attachment-image',
      capability: `gui-cap-v1-${'B'.repeat(43)}`,
      kind: 'image',
      name: 'tela.png',
      mime: 'image/png',
      size: 120
    },
    {
      id: 'attachment-folder',
      capability: `gui-cap-v1-${'C'.repeat(43)}`,
      kind: 'folder',
      name: 'src',
      mime: null,
      size: null
    }
  ]
  assert.equal(writeGuiComposerAttachments('pane-a', attachments, storage, 1), true)
  assert.deepEqual(readGuiComposerAttachments('pane-a', storage), attachments)
  const queued = {
    id: 'queued-attachments',
    text: 'olhe os anexos',
    at: 2,
    options: { model: null, effort: null, permissionMode: 'default' },
    attachments
  }
  assert.equal(writeGuiQueuedMessage('pane-a', queued, storage), true)
  assert.deepEqual(readGuiQueuedMessage('pane-a', storage)?.attachments, attachments)
  removeGuiComposerAttachments('pane-a', storage)
  assert.deepEqual(readGuiComposerAttachments('pane-a', storage), [])

  const forgedWithPath = { ...attachments[1], path: 'C:\\pasta-existente' }
  storage.setItem(
    'synkora.guiAttachments.pane-forged',
    JSON.stringify({ v: 2, attachments: [forgedWithPath], updatedAt: 3 })
  )
  assert.deepEqual(
    readGuiComposerAttachments('pane-forged', storage),
    [],
    'path forjado não sobrevive nem como metadado visível do composer'
  )
  storage.setItem(
    'synkora.guiQueue.pane-forged',
    JSON.stringify({ ...queued, v: 2, attachments: [forgedWithPath] })
  )
  assert.equal(readGuiQueuedMessage('pane-forged', storage), null)

  const forgedName = { ...attachments[1], name: 'C:\\Users\\Pessoa\\segredo' }
  storage.setItem(
    'synkora.guiAttachments.pane-name-forged',
    JSON.stringify({ v: 2, attachments: [forgedName], updatedAt: 4 })
  )
  assert.deepEqual(readGuiComposerAttachments('pane-name-forged', storage), [])
  storage.setItem(
    'synkora.guiQueue.pane-name-forged',
    JSON.stringify({ ...queued, v: 2, attachments: [forgedName] })
  )
  assert.equal(readGuiQueuedMessage('pane-name-forged', storage), null)
})

test('storage indisponível degrada para memória sem derrubar draft, anexos ou fila', () => {
  const unavailable = {
    get length() {
      throw new Error('indisponível')
    },
    key() {
      throw new Error('indisponível')
    },
    getItem() {
      throw new Error('indisponível')
    },
    setItem() {
      throw new Error('indisponível')
    },
    removeItem() {
      throw new Error('indisponível')
    }
  }
  assert.equal(readGuiDraft('pane', unavailable), '')
  assert.doesNotThrow(() => removeGuiDraft('pane', unavailable))
  assert.equal(writeGuiDraft('pane', 'texto', unavailable), false)
  assert.deepEqual(readGuiComposerAttachments('pane', unavailable), [])
  assert.doesNotThrow(() => removeGuiComposerAttachments('pane', unavailable))
  assert.equal(writeGuiComposerAttachments('pane', [], unavailable), false)
  assert.equal(readGuiQueuedMessage('pane', unavailable), null)
  assert.equal(
    writeGuiQueuedMessage(
      'pane',
      {
        id: 'queue-unavailable',
        text: 'texto',
        at: 1,
        options: { model: null, effort: null, permissionMode: 'default' },
        attachments: []
      },
      unavailable
    ),
    false
  )
  assert.equal(removeGuiQueuedMessage('pane', undefined, unavailable), false)
  assert.equal(claimGuiQueuedMessage('pane', 'renderer', unavailable), null)
})

test('dispatcher toma o bilhete antes de entregar e restaura o mesmo id na falha', async () => {
  const order = []
  const message = {
    id: 'queued-transaction',
    text: 'mensagem exata',
    at: 10,
    options: { model: 'opus', effort: 'high', permissionMode: 'plan' },
    attachments: []
  }
  let restored = null
  const outcome = await dispatchOneGuiQueuedMessage({
    claim: () => {
      order.push('claim')
      return message
    },
    deliver: async (claimed) => {
      order.push(`deliver:${claimed.id}:${claimed.options.permissionMode}`)
      return { ok: false, error: 'CLI indisponível' }
    },
    ack: () => {
      throw new Error('ACK não pode acontecer numa falha')
    },
    restore: (claimed, error) => {
      order.push('restore')
      restored = { claimed, error }
    }
  })
  assert.deepEqual(order, ['claim', 'deliver:queued-transaction:plan', 'restore'])
  assert.equal(outcome.status, 'failed')
  assert.equal(restored.claimed, message)
  assert.equal(restored.error, 'CLI indisponível')
})

test('resposta IPC perdida não autoriza cancelar uma mensagem possivelmente entregue', async () => {
  const storage = new MemoryStorage()
  const message = {
    id: 'cancel-uncertain', text: 'uma vez só', at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: []
  }
  writeGuiQueuedMessage('pane', message, storage)
  let restores = 0
  const outcome = await dispatchOneGuiQueuedMessage({
    claim: () => claimGuiQueuedMessage('pane', 'renderer', storage),
    deliver: async () => ({ ok: false, deliveryUncertain: true }),
    ack: () => { throw new Error('não houve recibo') },
    restore: (claimed, error) => {
      restores += 1
      releaseGuiQueuedMessageClaim('pane', 'renderer', claimed, error, storage)
    }
  })
  assert.equal(restores, 0)
  assert.equal(outcome.status, 'pending-ack')
  assert.equal(removeGuiQueuedMessage('pane', message.id, storage), false)
  assert.equal(readGuiQueuedMessage('pane', storage)?.deliveryInFlight, true)
})

test('reconciliação depois do ACK perdido conserva o id e encerra a fila sem reenviar', async () => {
  const storage = new MemoryStorage()
  const now = Date.now()
  const message = { id: 'delivery-receipt', text: 'entrega única', at: now,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  writeGuiQueuedMessage('pane', message, storage)
  const deliveredIds = new Set()
  let sends = 0
  const run = (owner, at, loseAck) => dispatchOneGuiQueuedMessage({
    claim: () => claimGuiQueuedMessage('pane', owner, storage, at),
    deliver: async (claimed) => {
      assert.equal(claimed.id, message.id)
      if (!deliveredIds.has(claimed.id)) { deliveredIds.add(claimed.id); sends++ }
      if (loseAck) throw new Error('conexão caiu após o main aceitar')
      return { ok: true }
    },
    ack: claimed => acknowledgeGuiQueuedMessage('pane', claimed.id, owner, storage),
    restore: () => { throw new Error('entrega aceita não pode voltar como falha') }
  })
  assert.equal((await run('renderer-first', now, true)).status, 'pending-ack')
  assert.equal(removeGuiQueuedMessage('pane', message.id, storage), false)
  assert.equal((await run('renderer-reopened', now + GUI_QUEUE_CLAIM_LEASE_MS + 1, false)).status, 'sent')
  assert.equal(sends, 1)
  assert.equal(readGuiQueuedMessage('pane', storage), null)
})

test('ACK confirmado não restaura e exceção de bridge conserva a claim para reconciliar', async () => {
  let restores = 0
  const message = {
    id: 'queued-ack',
    text: 'uma vez',
    at: 11,
    options: { model: null, effort: null, permissionMode: 'default' },
    attachments: []
  }
  const sent = await dispatchOneGuiQueuedMessage({
    claim: () => message,
    deliver: async () => ({ ok: true }),
    ack: () => true,
    restore: () => {
      restores += 1
    }
  })
  assert.equal(sent.status, 'sent')
  assert.equal(restores, 0)

  const failed = await dispatchOneGuiQueuedMessage({
    claim: () => message,
    deliver: async () => {
      throw new Error('ponte caiu')
    },
    ack: () => false,
    restore: (_claimed, error) => {
      restores += 1
      assert.equal(error, 'ponte caiu')
    }
  })
  assert.equal(failed.status, 'pending-ack')
  assert.equal(restores, 0)

  const pendingAck = await dispatchOneGuiQueuedMessage({
    claim: () => message,
    deliver: async () => ({ ok: true }),
    ack: () => false,
    restore: () => {
      throw new Error('ACK perdido não pode converter entrega confirmada em falha')
    }
  })
  assert.equal(pendingAck.status, 'pending-ack')
})

test('composer só limpa a fotografia aceita e preserva texto ou anexos em falha', () => {
  const sentAttachments = [
    {
      id: 'attachment-sent',
      capability: `gui-cap-v1-${'D'.repeat(43)}`,
      kind: 'file',
      name: 'notas.txt',
      mime: 'text/plain',
      size: 12
    }
  ]
  assert.deepEqual(
    guiComposerClearPlan(false, 'rascunho', 'rascunho', sentAttachments, sentAttachments),
    { draft: false, attachments: false }
  )
  assert.deepEqual(
    guiComposerClearPlan(true, 'rascunho', 'rascunho', sentAttachments, sentAttachments),
    { draft: true, attachments: true }
  )
  assert.deepEqual(
    guiComposerClearPlan(true, 'texto novo', 'rascunho', sentAttachments, sentAttachments),
    { draft: false, attachments: true }
  )
  assert.deepEqual(
    guiComposerClearPlan(true, 'rascunho', 'rascunho', [], sentAttachments),
    { draft: true, attachments: false }
  )
})

test('composer enfileira durante a resposta e coloca as ações na bolha do fio', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const dispatcher = readFileSync(
    new URL('../src/renderer/src/components/GuiQueueDispatcher.tsx', import.meta.url),
    'utf8'
  )
  // Era "nos dois renderers" até a purga F6 (2026-08-17) matar a ilha
  // panes-view: sobrou um renderer, e o dispatcher continua sendo global nele.
  assert.match(app, /<GuiQueueDispatcher \/>/)
  assert.match(pane, /if \(turnOpen\)[\s\S]*queueGuiMessage\(paneId, outgoing/)
  assert.doesNotMatch(pane, /GuiComposerDeliveryActions|after-turn|enviar depois|enviar agora/iu)
  const log = pane.slice(pane.indexOf('{renderItems.map'), pane.indexOf('{!pinned &&'))
  assert.match(log, /<GuiQueuedMessageCard/)
  assert.match(log, /onCancel=\{\(\) => discardGuiQueuedMessage\(paneId, queuedMessage.id\)\}/)
  assert.match(pane, /useGuiDraft\(paneId\)/)
  assert.match(dispatcher, /shouldAttemptGuiQueuedDelivery\(pane\.status, pane\.ready, queued,/)
  assert.match(dispatcher, /claimGuiQueuedMessage/)
  assert.match(dispatcher, /await dispatchOneGuiQueuedMessage/)
  assert.match(dispatcher, /guiApi\.deliverQueued\(paneId, message\)/)
  assert.match(dispatcher, /acknowledgeGuiQueuedMessage/)
  assert.match(dispatcher, /refreshGuiQueuedMessage/)
  assert.match(pane, /guiComposerClearPlan/)
  assert.match(pane, /setSubmitPending\(true\)/)
})

test('ações da fila reutilizam a apresentação e os estados dos botões de leitura', () => {
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiQueuedMessageCard.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(
    new URL('../src/renderer/src/global.css', import.meta.url),
    'utf8'
  )
  assert.match(card, /className=\{`gui-msg user gui-queued-message[\s\S]*is-sending/u)
  assert.match(card, /className="gui-owner-force"[\s\S]*disabled=\{sending \|\| readNowDisabled\}/u)
  assert.match(card, /className="gui-owner-force gui-owner-cancel"[\s\S]*disabled=\{sending\}[\s\S]*aria-label="Cancelar envio da mensagem na fila"/u)
  assert.match(css, /\.gui-owner-force:hover:not\(:disabled\)/u)
  assert.match(css, /\.gui-owner-force:focus-visible[\s\S]*outline: 2px solid/u)
  assert.match(css, /\.gui-owner-force:disabled[\s\S]*opacity: 0.45/u)
})

test('ler agora reclama a fila e aciona a leitura da identidade entregue', () => {
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiQueuedMessageCard.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  assert.match(card, /onClick=\{onReadNow\}[\s\S]{0,80}ler agora/u)
  assert.doesNotMatch(card, /enviar agora|enviar depois|onEdit|onRetry/u)
  // O GuiPane entrega pelo MESMO protocolo do dispatcher (claim -> envio ->
  // ack/restore): "enviando..." e o erro com "tentar novamente" vem de graca,
  // e a lease impede o dispatcher de disputar o mesmo bilhete.
  assert.match(pane, /claimGuiQueuedMessage/u, 'o pulo de fila nao reclama o bilhete')
  assert.match(
    pane,
    /guiApi\.send\(paneId, claimed\.text, claimed\.id, claimed\.attachments, claimed\.browserReferences\)/u,
    'o envio direto deve conservar a identidade durável da fila, inclusive no retry'
  )
  assert.match(pane, /acknowledgeGuiQueuedMessage/u, 'sucesso nao da ACK no bilhete')
  assert.match(pane, /restoreGuiQueuedMessage/u, 'falha nao devolve o bilhete com o motivo')
  assert.match(pane, /forceOneGuiQueuedMessage/u)
  assert.match(pane, /force: \(messageId\) => guiApi.forceOwnerMessage\(paneId, messageId\)/u)
})

test('a bolha explica leitura forçada e cancelamento sem interromper a resposta', () => {
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiQueuedMessageCard.tsx', import.meta.url),
    'utf8'
  )
  assert.match(card, /força o agente a parar e ler esta mensagem agora/u)
  assert.match(card, /retira esta mensagem da fila sem interromper a resposta atual/u)
  // A ponte fora do ar continua com a dica honesta: ali nao ha turno nenhum.
  assert.match(card, /a ponte do chat[\s\S]{0,20}fora do ar/u)
})

test('ler agora envia o bilhete exato, força a leitura e confirma uma única vez', async () => {
  const storage = new MemoryStorage()
  const message = { id: 'read-now', text: 'prioridade sintética', at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  writeGuiQueuedMessage('pane', message, storage)
  const calls = []
  const deps = {
    claim: () => claimGuiQueuedMessage('pane', 'owner', storage),
    deliver: async claimed => {
      calls.push(['send', claimed.id, claimed.text, claimed.attachments])
      assert.equal(removeGuiQueuedMessage('pane', claimed.id, storage), false, 'claimed delivery cannot be cancelled')
      return { ok: true }
    },
    force: async id => { calls.push(['force', id]); return { ok: true } },
    ack: claimed => { calls.push(['ack', claimed.id]); return acknowledgeGuiQueuedMessage('pane', claimed.id, 'owner', storage) },
    restore: () => assert.fail('an accepted delivery cannot return to the queue'),
    onForceError: () => assert.fail('unexpected force error')
  }
  assert.equal((await forceOneGuiQueuedMessage(deps)).status, 'sent')
  assert.deepEqual(calls, [['send', message.id, message.text, []], ['force', message.id], ['ack', message.id]])
  assert.equal((await forceOneGuiQueuedMessage(deps)).status, 'empty', 'a repeated gesture cannot send or interrupt twice')
  assert.equal(calls.length, 3)
})

test('cancelamento vence antes da claim: ler agora não envia nem interrompe', async () => {
  const storage = new MemoryStorage()
  const message = { id: 'cancel-wins', text: 'cancelável', at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  writeGuiQueuedMessage('pane', message, storage)
  assert.equal(removeGuiQueuedMessage('pane', message.id, storage), true)
  const unexpected = () => assert.fail('a cancelled message has no delivery side effects')
  assert.equal((await forceOneGuiQueuedMessage({
    claim: () => claimGuiQueuedMessage('pane', 'owner', storage), deliver: unexpected,
    force: unexpected, ack: unexpected, restore: unexpected, onForceError: unexpected
  })).status, 'empty')
})

test('ler agora não interrompe com envio recusado ou incerto; falha só do force não duplica envio', async () => {
  const message = { id: 'force-failure', text: 'mensagem sintética', at: Date.now(),
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  for (const receipt of [{ ok: false, error: 'recusado' }, { ok: false, deliveryUncertain: true }, { ok: true }]) {
    const calls = []
    const outcome = await forceOneGuiQueuedMessage({
      claim: () => message, deliver: async () => receipt,
      force: async () => { calls.push('force'); return { ok: false, error: 'não foi possível interromper' } },
      ack: () => { calls.push('ack'); return true },
      restore: () => calls.push('restore'), onForceError: error => calls.push(error)
    })
    if (receipt.ok) {
      assert.equal(outcome.status, 'sent')
      assert.deepEqual(calls, ['force', 'não foi possível interromper', 'ack'])
    } else if (receipt.deliveryUncertain) {
      assert.equal(outcome.status, 'pending-ack')
      assert.deepEqual(calls, [])
    } else {
      assert.equal(outcome.status, 'failed')
      assert.deepEqual(calls, ['restore'])
    }
  }
})

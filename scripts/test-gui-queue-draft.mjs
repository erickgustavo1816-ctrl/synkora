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
  shouldAttemptGuiQueuedDelivery
} from '../src/renderer/src/guiQueuedDelivery.ts'
import { guiComposerClearPlan } from '../src/renderer/src/guiComposerDelivery.ts'
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
    export { useStore } from './src/renderer/src/store';
    export { default as QueueCard } from './src/renderer/src/components/GuiQueuedMessageCard';
    export { default as DeliveryActions } from './src/renderer/src/components/GuiComposerDeliveryActions';
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
    { documentElement: { style: { setProperty() {} } } }, windowMock, storage
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

test('ações de envio têm destinos distintos e cartão anuncia recusa do cancelamento', async () => {
  const { DeliveryActions, QueueCard } = rendererHarness(new MemoryStorage())
  let actions, card, now = 0, later = 0, cancelled = 0, edited = 0
  const props = { disabled: false, showSendNow: true,
    onSendNow: () => now++, onSendLater: () => later++ }
  await act(async () => { actions = create(React.createElement(DeliveryActions, props)) })
  try {
    const buttons = actions.root.findAllByType('button')
    await act(async () => buttons.find(button => button.children.includes('enviar depois')).props.onClick())
    assert.equal(later, 1)
    assert.equal(now, 0)
    await act(async () => buttons.find(button => button.children.includes('enviar agora')).props.onClick())
    assert.equal(now, 1)
    await act(async () => actions.update(React.createElement(DeliveryActions, { ...props, disabled: true })))
    assert.ok(actions.root.findAllByType('button').every(button => button.props.disabled))
  } finally { await act(async () => actions.unmount()) }
  const message = { id: 'queue-ui', text: 'orientação sintética', at: 10,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [] }
  const cardProps = { message, editDisabled: true, onEdit: () => { edited++; return true },
    onCancel: () => { cancelled++; return false }, onRetry() {} }
  await act(async () => { card = create(React.createElement(QueueCard, cardProps)) })
  try {
    assert.equal(card.root.findAllByType('button').find(button => button.children.includes('editar')).props.disabled, true)
    await act(async () => card.root.findByProps({ 'aria-label': 'Cancelar envio da mensagem na fila' }).props.onClick())
    assert.equal(cancelled, 1)
    assert.equal(edited, 0)
    assert.match(card.root.findByProps({ role: 'alert' }).children.join(''), /não foi possível confirmar o cancelamento/iu)
    await act(async () => card.update(React.createElement(QueueCard, { ...cardProps,
      message: { ...message, deliveryInFlight: true } })))
    assert.equal(card.root.findByProps({ 'aria-label': 'Cancelar envio da mensagem na fila' }).props.disabled, true)
  } finally { await act(async () => card.unmount()) }
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

test('dispatcher global mantém envio imediato e permite fila por escolha explícita', () => {
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
  // R31.1 (queixa de 2026-08-23: "eu mando e ele lê três horas depois"):
  // turno aberto NÃO segura mensagem comum — o envio é o mesmo do turno
  // fechado (o CLI steera; sonda probe-claude-owner-midturn). A fila só fica
  // com o slash cru (comando é do binário; slash steerado não foi sondado).
  assert.match(pane, /if \(turnOpen && message\.startsWith\('\/'\)\)[\s\S]*queueGuiMessage/)
  assert.match(pane, /if \(timing === 'after-turn'\)[\s\S]*queueGuiMessage\(paneId, outgoing/)
  assert.match(pane, /onSendLater=\{\(\) => submit\('after-turn'\)\}/)
  assert.match(pane, /onSendNow=\{\(\) => submit\(\)\}/)
  assert.ok(!pane.includes('Colocar mensagem na fila'), 'mensagem comum enviada agora não é fila')
  assert.match(pane, /useGuiDraft\(paneId\)/)
  assert.match(dispatcher, /shouldAttemptGuiQueuedDelivery\(pane\.status, pane\.ready, queued\)/)
  assert.match(dispatcher, /claimGuiQueuedMessage/)
  assert.match(dispatcher, /await dispatchOneGuiQueuedMessage/)
  assert.match(dispatcher, /deliver: \(message\) => guiApi\.deliverQueued\(paneId, message\)/)
  assert.match(dispatcher, /acknowledgeGuiQueuedMessage/)
  assert.match(dispatcher, /refreshGuiQueuedMessage/)
  assert.match(pane, /guiComposerClearPlan/)
  assert.match(pane, /setSubmitPending\(true\)/)
})

test('acoes da fila têm hover/foco contrastantes e disabled honesto durante o envio', () => {
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiQueuedMessageCard.tsx', import.meta.url),
    'utf8'
  )
  const css = readFileSync(
    new URL('../src/renderer/src/components/GuiQueuedMessageCard.css', import.meta.url),
    'utf8'
  )
  assert.match(card, /className=\{`gui-queued-message[\s\S]*is-sending/u)
  assert.match(card, /className="term-btn ghost-dim"[\s\S]*disabled=\{sending \|\| editDisabled\}/u)
  assert.match(card, /className="term-btn ghost-dim"[\s\S]*disabled=\{sending\}[\s\S]*aria-label="Cancelar envio da mensagem na fila"/u)
  assert.match(css, /\.gui-queued-message-actions \.term-btn\.ghost-dim:hover:not\(:disabled\)[\s\S]*color: var\(--ink\)[\s\S]*border-color:[^;]*var\(--accent\)/u)
  assert.match(css, /\.gui-queued-message-actions \.term-btn\.ghost-dim:focus-visible[\s\S]*outline: 2px solid/u)
  // `\r?\n`: a árvore é conferida com core.autocrlf, então a folha chega em
  // CRLF e o `\n` cravado entre os seletores nunca casava. A asserção é a
  // mesma — os três seletores adjacentes e o cursor honesto.
  assert.match(css, /\.gui-queued-message-actions \.term-btn\.ghost-dim:disabled,\r?\n\.gui-queued-message-actions \.term-btn\.ghost-dim:disabled:hover,\r?\n\.gui-queued-message-actions \.term-btn\.ghost-dim:disabled:focus-visible[\s\S]*cursor: not-allowed/u)
})

test('enviar agora: o dono pula a fila e a mensagem entra no turno vivo (ordem de 18/08)', () => {
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiQueuedMessageCard.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  // O card tem o TERCEIRO verbo, antes de editar/apagar, com estado honesto:
  // some o clique enquanto uma entrega (desta ou do dispatcher) esta em voo.
  assert.match(card, /onSendNow/u, 'o card nao recebe o verbo enviar agora')
  assert.match(card, /enviar agora/u, 'o rotulo do verbo nao existe')
  assert.match(
    card,
    /onSendNow[\s\S]{0,400}enviar agora|enviar agora[\s\S]{0,400}onSendNow/u,
    'o rotulo nao esta ligado ao verbo'
  )
  // O GuiPane entrega pelo MESMO protocolo do dispatcher (claim -> envio ->
  // ack/restore): "enviando..." e o erro com "tentar novamente" vem de graca,
  // e a lease impede o dispatcher de disputar o mesmo bilhete.
  assert.match(pane, /claimGuiQueuedMessage/u, 'o pulo de fila nao reclama o bilhete')
  assert.match(
    pane,
    /guiApi\.send\(paneId, claimed\.text, claimed\.id, claimed\.attachments\)/u,
    'o envio direto deve conservar a identidade durável da fila, inclusive no retry'
  )
  assert.match(pane, /acknowledgeGuiQueuedMessage/u, 'sucesso nao da ACK no bilhete')
  assert.match(pane, /restoreGuiQueuedMessage/u, 'falha nao devolve o bilhete com o motivo')
})

test('card explica que enviar agora encerra a possibilidade de cancelamento', () => {
  const card = readFileSync(
    new URL('../src/renderer/src/components/GuiQueuedMessageCard.tsx', import.meta.url),
    'utf8'
  )
  const tip = card.slice(card.indexOf('sendNowDisabled'), card.indexOf('enviar agora'))
  assert.match(tip, /durante a resposta atual/u)
  assert.match(tip, /depois do envio ela não pode mais ser cancelada/u)
  // A ponte fora do ar continua com a dica honesta: ali nao ha turno nenhum.
  assert.match(card, /a ponte do chat[\s\S]{0,20}fora do ar/u)
})

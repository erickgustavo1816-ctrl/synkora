import { useEffect, useRef, useState } from 'react'
import { guiApi } from '../guiApi'
import { readGuiQueuedMessage } from '../guiMessageQueue'
import {
  dispatchOneGuiQueuedMessage,
  shouldAttemptGuiQueuedDelivery
} from '../guiQueuedDelivery'
import { useStore } from '../store'

/**
 * P1: vive na raiz dos dois renderers, não dentro do GuiPane. Assim uma fila
 * dispara mesmo quando a missão não está visível. A lease no localStorage
 * e a coalescência por id no main resolvem a disputa entre renderers.
 */
export default function GuiQueueDispatcher(): null {
  const guiPanes = useStore((state) => state.guiPanes)
  const ownerRef = useRef(`renderer-${globalThis.crypto.randomUUID()}`)
  const runningRef = useRef(new Set<string>())
  const retryAtRef = useRef(new Map<string, number>())
  const [leaseWake, setLeaseWake] = useState(0)
  const hasPending = Object.values(guiPanes).some((pane) => pane.queued && !pane.queued.deliveryError)

  // O envelope continua durável enquanto o main trabalha. Outro renderer (ou
  // um app reaberto após crash) observa a lease e a reclama quando ela vence.
  useEffect(() => {
    if (!hasPending) return
    const timer = window.setTimeout(() => {
      const state = useStore.getState()
      for (const [paneId, pane] of Object.entries(state.guiPanes)) {
        if (pane.queued && !pane.queued.deliveryError) state.refreshGuiQueuedMessage(paneId)
      }
      setLeaseWake((value) => value + 1)
    }, 1_000)
    return () => window.clearTimeout(timer)
  }, [hasPending, leaseWake])

  useEffect(() => {
    for (const [paneId, pane] of Object.entries(guiPanes)) {
      const queued = pane.queued ?? readGuiQueuedMessage(paneId)
      // Uma claim vencida precisa ser reconciliada mesmo se o pane ficou dead,
      // starting ou working: o main devolve o recibo da entrega anterior ou uma
      // falha autoritativa, e só então o cartão volta a aceitar edição/remoção.
      if (!shouldAttemptGuiQueuedDelivery(pane.status, pane.ready, queued, Date.now())) continue
      if (runningRef.current.has(paneId)) continue
      if ((retryAtRef.current.get(paneId) ?? 0) > Date.now()) continue
      runningRef.current.add(paneId)
      // A refusal must not retry for every streamed token. The wake below
      // also retries when a temporary main-process lock clears without IPC.
      retryAtRef.current.set(paneId, Date.now() + 1_000)
      void (async () => {
        try {
          const state = useStore.getState()
          const outcome = await dispatchOneGuiQueuedMessage({
            claim: () => state.claimGuiQueuedMessage(paneId, ownerRef.current),
            // Every route preserves the snapshot and uses the main's durable
            // receipt. Active guidance never reconfigures a running executor.
            deliver: (message) => guiApi.deliverQueued(paneId, message),
            ack: (message) =>
              useStore
                .getState()
                .acknowledgeGuiQueuedMessage(paneId, message.id, ownerRef.current),
            restore: (message, error) =>
              useStore
                .getState()
                .restoreGuiQueuedMessage(paneId, message, error, ownerRef.current)
          })
          if (outcome.status === 'empty' || outcome.status === 'pending-ack') {
            useStore.getState().refreshGuiQueuedMessage(paneId)
          }
          if (outcome.status === 'sent' || outcome.status === 'empty') {
            retryAtRef.current.delete(paneId)
          }
        } finally {
          runningRef.current.delete(paneId)
        }
      })()
    }
  }, [guiPanes, leaseWake])

  return null
}

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
  const [leaseWake, setLeaseWake] = useState(0)

  // O envelope continua durável enquanto o main trabalha. Outro renderer (ou
  // um app reaberto após crash) observa a lease e a reclama quando ela vence.
  useEffect(() => {
    const claimed = Object.entries(guiPanes).filter(([, pane]) => pane.queued?.deliveryInFlight)
    if (claimed.length === 0) return
    const timer = window.setTimeout(() => {
      const state = useStore.getState()
      for (const [paneId] of claimed) state.refreshGuiQueuedMessage(paneId)
      setLeaseWake((value) => value + 1)
    }, 1_000)
    return () => window.clearTimeout(timer)
  }, [guiPanes, leaseWake])

  useEffect(() => {
    for (const [paneId, pane] of Object.entries(guiPanes)) {
      const queued = pane.queued ?? readGuiQueuedMessage(paneId)
      // Uma claim vencida precisa ser reconciliada mesmo se o pane ficou dead,
      // starting ou working: o main devolve o recibo da entrega anterior ou uma
      // falha autoritativa, e só então o cartão volta a aceitar edição/remoção.
      if (!shouldAttemptGuiQueuedDelivery(pane.status, pane.ready, queued)) continue
      if (runningRef.current.has(paneId)) continue
      runningRef.current.add(paneId)
      void (async () => {
        try {
          const state = useStore.getState()
          const outcome = await dispatchOneGuiQueuedMessage({
            claim: () => state.claimGuiQueuedMessage(paneId, ownerRef.current),
            // O main aplica a fotografia inteira e envia sob uma única trava.
            // O renderer nunca prepara opções de um envelope e envia outro.
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
        } finally {
          runningRef.current.delete(paneId)
        }
      })()
    }
  }, [guiPanes, leaseWake])

  return null
}

import type { GuiQueuedMessage } from './guiMessageQueue'

export type GuiQueuedDeliveryResult =
  | { status: 'empty' }
  | { status: 'sent'; message: GuiQueuedMessage }
  | { status: 'pending-ack'; message: GuiQueuedMessage }
  | { status: 'deferred'; message: GuiQueuedMessage }
  | { status: 'failed'; message: GuiQueuedMessage; error: string }

export interface GuiMessageDeliveryResult {
  ok: boolean
  error?: string
  retryable?: boolean
  /** No authoritative reply reached the renderer. The main may already have
   * accepted the exact message ID; keep its claim until receipt reconciliation. */
  deliveryUncertain?: boolean
}

interface GuiQueuedDeliveryDeps {
  /** Claim comes first: the options and attachments sent are from the exact
   * storage envelope won by this renderer, never from an earlier render. */
  claim: () => GuiQueuedMessage | null
  deliver: (message: GuiQueuedMessage) => Promise<GuiMessageDeliveryResult>
  ack: (message: GuiQueuedMessage) => boolean
  restore: (message: GuiQueuedMessage, error: string) => void
}

/** The main decides whether to steer, start a turn, or defer. Renderer
 * activity can include helpers and is not authority to hold an owner's text. */
export function shouldAttemptGuiQueuedDelivery(
  status: string,
  ready: boolean,
  message: GuiQueuedMessage | null,
  now = Date.now()
): boolean {
  if (!message || message.deliveryError) return false
  const expiredClaim = Boolean(
    message.deliveryInFlight &&
      message.deliveryClaimedUntil !== undefined &&
      message.deliveryClaimedUntil <= now
  )
  return (ready && (status === 'idle' || status === 'working')) || expiredClaim
}

export async function dispatchOneGuiQueuedMessage(
  deps: GuiQueuedDeliveryDeps
): Promise<GuiQueuedDeliveryResult> {
  const message = deps.claim()
  if (!message) return { status: 'empty' }

  let result: GuiMessageDeliveryResult
  try {
    result = await deps.deliver(message)
  } catch {
    return { status: 'pending-ack', message }
  }
  if (result.deliveryUncertain) return { status: 'pending-ack', message }
  if (result.ok) {
    return deps.ack(message)
      ? { status: 'sent', message }
      : { status: 'pending-ack', message }
  }
  if (result.retryable) {
    deps.restore(message, '')
    return { status: 'deferred', message }
  }

  const reason = result.error?.trim() || 'a sessão não confirmou o envio'
  deps.restore(message, reason)
  return { status: 'failed', message, error: reason }
}

/** A read-now gesture must first win the queue and get an authoritative send
 * receipt. A failed force never restores an already delivered message. */
export async function forceOneGuiQueuedMessage(
  deps: GuiQueuedDeliveryDeps & {
    force: (messageId: string) => Promise<{ ok: boolean; error?: string }>
    onForceError: (error: string) => void
  }
): Promise<GuiQueuedDeliveryResult> {
  return dispatchOneGuiQueuedMessage({
    ...deps,
    deliver: async (message) => {
      const result = await deps.deliver(message)
      if (!result.ok || result.deliveryUncertain) return result
      try {
        const forced = await deps.force(message.id)
        if (!forced.ok) deps.onForceError(forced.error || 'a sessão não confirmou a leitura forçada')
      } catch {
        deps.onForceError('a sessão não confirmou a leitura forçada')
      }
      return result
    }
  })
}

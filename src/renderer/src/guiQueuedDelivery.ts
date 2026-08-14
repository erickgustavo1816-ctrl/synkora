import type { GuiQueuedMessage } from './guiMessageQueue'

export type GuiQueuedDeliveryResult =
  | { status: 'empty' }
  | { status: 'sent'; message: GuiQueuedMessage }
  | { status: 'pending-ack'; message: GuiQueuedMessage }
  | { status: 'failed'; message: GuiQueuedMessage; error: string }

interface GuiQueuedDeliveryDeps {
  /** Claim comes first: the options and attachments sent are from the exact
   * storage envelope won by this renderer, never from an earlier render. */
  claim: () => GuiQueuedMessage | null
  deliver: (message: GuiQueuedMessage) => Promise<{ ok: boolean; error?: string }>
  ack: (message: GuiQueuedMessage) => boolean
  restore: (message: GuiQueuedMessage, error: string) => void
}

/** Decide quando o dispatcher pode tentar. Claim vencida é exceção deliberada:
 * mesmo pane morto/ocupado precisa consultar o recibo do main e destravar o
 * envelope por ACK ou falha autoritativa. */
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
  return (status === 'idle' && ready) || expiredClaim
}

export async function dispatchOneGuiQueuedMessage(
  deps: GuiQueuedDeliveryDeps
): Promise<GuiQueuedDeliveryResult> {
  const message = deps.claim()
  if (!message) return { status: 'empty' }

  let result: { ok: boolean; error?: string }
  try {
    result = await deps.deliver(message)
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (result.ok) {
    return deps.ack(message)
      ? { status: 'sent', message }
      : { status: 'pending-ack', message }
  }

  const reason = result.error?.trim() || 'a sessão não confirmou o envio'
  deps.restore(message, reason)
  return { status: 'failed', message, error: reason }
}

export interface GuiInteractionIdentity {
  requestId: string
}

/** Fila estável por requestId: retransmissão atualiza no lugar, sem furar fila. */
export function enqueueGuiInteraction<T extends GuiInteractionIdentity>(
  queue: readonly T[],
  interaction: T
): T[] {
  const index = queue.findIndex((item) => item.requestId === interaction.requestId)
  if (index < 0) return [...queue, interaction]
  const next = [...queue]
  next[index] = interaction
  return next
}

export function removeGuiInteraction<T extends GuiInteractionIdentity>(
  queue: readonly T[],
  requestId: string
): T[] {
  return queue.filter((item) => item.requestId !== requestId)
}

/** Falha transitória conserva o pedido; falha autoritativa remove só o id alvo. */
export function settleGuiInteractionFailure<T extends GuiInteractionIdentity>(
  queue: readonly T[],
  requestId: string,
  retryable: boolean
): T[] {
  const pending = queue.some((item) => item.requestId === requestId)
  return retryable && pending ? [...queue] : removeGuiInteraction(queue, requestId)
}

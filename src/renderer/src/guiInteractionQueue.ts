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

/** A fila mistura duas naturezas, e o tipo é a única coisa que as separa. */
export interface GuiInteractionNature {
  kind: string
}

/**
 * ESPELHO RENDERER da isenção do anel (`guiSurvivesTurnEnd`, src/main/
 * guiSessions.ts): a proposta de plano é a ÚNICA pendência que não bloqueia o
 * CLI — o agente chama `propose_plan`, a tool responde na hora e o turno segue.
 * Permissão, pergunta e veredito de plano PARAM o backend, então morrem com o
 * turno (quem esperava já desistiu); a proposta continua esperando o dono.
 */
export function guiInteractionSurvivesTurnEnd(kind: string): boolean {
  return kind === 'plan-proposal'
}

/**
 * O que sobra da fila quando o turno fecha (`result`/`fatal`/`closed`). Zerar a
 * fila às cegas aqui era o que apagava o card da proposta no instante em que o
 * dono finalmente ia lê-lo.
 */
export function retainGuiInteractionsAfterTurnEnd<T extends GuiInteractionNature>(
  queue: readonly T[]
): T[] {
  return queue.filter((item) => guiInteractionSurvivesTurnEnd(item.kind))
}

/**
 * "O fio está PARADO esperando o dono?" — a pergunta do MEIO do turno. Contar a
 * proposta aqui fazia cada delta seguinte virar `waiting-you`, e o card
 * aparecia por cima da fala em andamento.
 */
export function guiInteractionBlocksTurn<T extends GuiInteractionNature>(
  queue: readonly T[]
): boolean {
  return queue.some((item) => !guiInteractionSurvivesTurnEnd(item.kind))
}

export interface GuiTurnQueueAdvance {
  completed: number | null
  active: number | null
  pending: number[]
}

export function enqueueGuiTurn(pending: readonly number[], generation: number): number[] {
  return [...pending, generation]
}

/** Resultados do stream bidirecional chegam em FIFO: conclui a cabeça e
 * promove a próxima mensagem já aceita sem reaproveitar a identidade antiga. */
export function advanceGuiTurn(pending: readonly number[]): GuiTurnQueueAdvance {
  const completed = pending[0] ?? null
  const rest = pending.slice(1)
  return { completed, active: rest[0] ?? null, pending: rest }
}

export const GUI_ACTIVE_TURN_SILENCE_TIMEOUT = 10 * 60 * 1_000

/** Pane GUI desliga expiração por ociosidade, mas um turno iniciado ainda
 * precisa terminar. Espera humana suspende esse relógio. */
export function shouldArmGuiTurnWatchdog(
  idleTimeoutMs: number | undefined,
  active: boolean,
  waitingForHuman: boolean
): boolean {
  return idleTimeoutMs === 0 && active && !waitingForHuman
}

/** Um resultado espera enquanto existe envio sem destino. */
export function canFlushGuiTurnResult(
  pendingOperations: number,
  hasTurnDestination: boolean
): boolean {
  return pendingOperations === 0 || hasTurnDestination
}

export function ownsFailedGuiSteer(
  currentTurnId: string | null,
  expectedTurnId: string
): boolean {
  return currentTurnId === expectedTurnId
}

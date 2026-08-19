export type GuiActivityStatus = 'starting' | 'working' | 'waiting-you' | 'idle' | 'dead'

const GENERIC_ACTIVITY = ['pensando', 'analisando', 'trabalhando', 'raciocinando'] as const

/** Um turno preserva o relógio ao esperar o usuário e o encerra atomicamente. */
export function transitionGuiStartedAt(
  current: number | null,
  nextStatus: GuiActivityStatus,
  now: number
): number | null {
  if (nextStatus === 'working') return current ?? now
  if (nextStatus === 'idle' || nextStatus === 'dead') return null
  return current
}

/**
 * O FECHO DA RODADA (R11, ordem do dono: "sempre no final de cada rodada eu
 * quero o timer em algum lugar"). A rodada é a régua do `startedAt` acima —
 * arma no working, sobrevive à espera pelo dono, zera no fecho lógico. O selo
 * nasce EXATAMENTE na transição que zera para `idle`: morte de sessão não é
 * rodada concluída, e turno que continua (subagente em background) ainda conta.
 */
export function guiRoundClosed(
  prevStartedAt: number | null,
  nextStartedAt: number | null,
  nextStatus: GuiActivityStatus
): boolean {
  return prevStartedAt !== null && nextStartedAt === null && nextStatus === 'idle'
}

/** O texto do selo — fonte única (o fio e qualquer superfície futura leem o
 *  MESMO formato). */
export function guiRoundStampText(elapsedMs: number): string {
  return `⏱ rodada: ${formatGuiElapsed(elapsedMs)}`
}

/** Texto factual do backend vence sempre o verbo cosmético. */
export function guiActivityLabel(elapsedMs: number, statusText?: string | null): string {
  const factual = statusText?.trim()
  if (factual) return factual
  const index = Math.floor(Math.max(0, elapsedMs) / 4_000) % GENERIC_ACTIVITY.length
  return GENERIC_ACTIVITY[index]
}

export function formatGuiElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}


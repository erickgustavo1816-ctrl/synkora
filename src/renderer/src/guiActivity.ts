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


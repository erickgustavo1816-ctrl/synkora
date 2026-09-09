import type { ProgressOpenTarget } from '../../preload/index'

const pending = new Map<string, ProgressOpenTarget>()
const listeners = new Map<string, (target: ProgressOpenTarget) => void>()

/** Ephemeral navigation survives a Board that has not mounted yet. */
export function queueProgressOpen(target: ProgressOpenTarget): void {
  const listener = listeners.get(target.projectId)
  if (listener) listener(target)
  else pending.set(target.projectId, target)
}

export function onProgressOpen(projectId: string, listener: (target: ProgressOpenTarget) => void): () => void {
  listeners.set(projectId, listener)
  const target = pending.get(projectId)
  if (target) { pending.delete(projectId); listener(target) }
  return () => { if (listeners.get(projectId) === listener) listeners.delete(projectId) }
}

export function resolveBoardProgressTarget(
  target: ProgressOpenTarget,
  missions: readonly { id: string; projectId: string; status: string }[],
  slots: Record<string, readonly { spawn: { paneId: string; projectId: string } }[]>
): { missionId: string | null; paneId?: string; delivery: boolean; unavailable: boolean } {
  const mission = missions.find((item) => item.id === target.missionId && item.projectId === target.projectId)
  if (!mission || !['ativa', 'integrando'].includes(mission.status)) {
    return { missionId: null, delivery: false, unavailable: Boolean(target.paneId) }
  }
  if (target.paneId && !slots[mission.id]?.some((slot) =>
    slot.spawn.paneId === target.paneId && slot.spawn.projectId === target.projectId)) {
    return { missionId: null, delivery: false, unavailable: true }
  }
  return {
    missionId: mission.id,
    ...(target.paneId ? { paneId: target.paneId } : {}),
    delivery: target.destination === 'delivery',
    unavailable: false
  }
}

/** Open only UI disclosure controls; never click any integration action. */
export function focusProgressDelivery(board: HTMLElement, done: () => void): () => void {
  const rail = board.querySelector<HTMLElement>('.board-content')
  const toggle = rail?.querySelector<HTMLButtonElement>('.right-rail-toggle[aria-expanded="false"]')
  toggle?.click()
  // React must remove `inert` after expanding the rail before focus can enter.
  const frame = requestAnimationFrame(() => {
    const action = board.querySelector<HTMLElement>('.workspace-integrate-button')
    if (action) {
      action.focus()
      done()
      return
    }
    const section = rail?.querySelector<HTMLButtonElement>('.dock-sec-head')
    if (section?.getAttribute('aria-expanded') === 'false') section.click()
    section?.focus()
    section?.scrollIntoView({ block: 'nearest' })
    done()
  })
  return () => cancelAnimationFrame(frame)
}

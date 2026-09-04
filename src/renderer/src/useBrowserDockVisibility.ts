import { useLayoutEffect } from 'react'
import { BROWSER_DOCK_CONTEXT_CHANGED } from './browserDockVisibility'
export { BROWSER_DOCK_CONTEXT_CHANGED, eligibleDockMission } from './browserDockVisibility'

export interface BrowserDockVisibilityHost {
  setDockMission(missionId: string | null): void
  requestMeasurement(): void
}

const appHost: BrowserDockVisibilityHost = {
  setDockMission: (missionId) => window.synkora?.browser?.setDockMission?.(missionId),
  requestMeasurement: () => window.dispatchEvent(new Event(BROWSER_DOCK_CONTEXT_CHANGED))
}

/** Called once, by App. Child layout effects run before this parent: publish
 * authority first, then ask mounted panels for a fresh committed measurement.
 * Both IPC sends use the same renderer channel ordering, with no timer race. */
export function useBrowserDockVisibility(
  missionId: string | null,
  host: BrowserDockVisibilityHost = appHost
): void {
  useLayoutEffect(() => {
    host.setDockMission(missionId)
    host.requestMeasurement()
    return () => host.setDockMission(null)
  }, [missionId, host])
}

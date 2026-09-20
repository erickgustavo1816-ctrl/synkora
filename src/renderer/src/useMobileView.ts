import { useEffect, useState } from 'react'
import { currentMobileConsumer, retainMobileView, type MobileClient, type MobileViewState } from './mobileClient'

export function useMobileView(client: MobileClient | null, missionId: string, sessionId: string | undefined, enabled: boolean, retry: number): MobileViewState {
  const key = JSON.stringify([missionId, sessionId ?? '', retry])
  const [state, setState] = useState<MobileViewState & { key: string; client: MobileClient | null }>({ key, client, consumerId: null, error: null })
  useEffect(() => {
    if (!enabled || !client || !sessionId) return
    return retainMobileView(client, missionId, sessionId, value => setState({ ...value, key, client }))
  }, [client, missionId, sessionId, enabled, retry, key])
  const current = sessionId ? currentMobileConsumer(client, missionId, sessionId) : null
  return enabled && state.key === key && state.client === client && (!state.consumerId || state.consumerId === current) ? state : { consumerId: null, error: null }
}

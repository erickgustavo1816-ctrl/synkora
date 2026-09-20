import type { MobileApi, MobilePhoneApi, MobilePhoneDescriptor, MobileResult, MobileViewLease } from '../../shared/mobileSimulator'

/** Both presentations use this narrow client; the detached adapter cannot reach
 * the general app bridge or choose another mission/session in its native API.
 */
export type MobileClient = Pick<MobileApi, 'acquireView' | 'releaseView' | 'capture' | 'act' | 'pointer' | 'setVideoVisible' | 'ackVideo' | 'onVideo' | 'onChanged' | 'monitorScale' | 'calibrationRead' | 'calibrationWrite' | 'onCalibrationChanged'>
export const ownerMobileClient = (): MobileClient | null => window.synkora?.mobile ?? null
const refused = (): MobileResult<never> => ({ ok: false, error: 'Esta visualização não controla mais o aparelho.' })

export function createMobilePhoneClient(api: MobilePhoneApi, descriptor: MobilePhoneDescriptor): MobileClient {
  const owns = (missionId: string, sessionId: string): boolean => missionId === descriptor.missionId && sessionId === descriptor.sessionId
  return {
    acquireView: (missionId, sessionId) => owns(missionId, sessionId) ? api.acquireView() : Promise.resolve(refused()),
    releaseView: (missionId, sessionId, consumerId) => owns(missionId, sessionId) ? api.releaseView(consumerId) : Promise.resolve(refused()),
    capture: (missionId, sessionId, consumerId) => owns(missionId, sessionId) ? api.capture(consumerId) : Promise.resolve(refused()),
    act: (missionId, sessionId, action, consumerId) => {
      if (!owns(missionId, sessionId) || !consumerId || !['tap', 'swipe', 'text', 'key'].includes(action.type)) return Promise.resolve(refused())
      if (action.type === 'tap' || action.type === 'swipe' || action.type === 'text' || action.type === 'key') return api.act(action, consumerId)
      return Promise.resolve(refused())
    },
    pointer: (missionId, sessionId, input, consumerId) => owns(missionId, sessionId) ? api.pointer(input, consumerId) : Promise.resolve(refused()),
    setVideoVisible: (missionId, sessionId, visible, consumerId) => owns(missionId, sessionId) ? api.setVideoVisible(visible, consumerId) : Promise.resolve(refused()),
    ackVideo: (missionId, sessionId, streamId, timestampUs, consumerId) => { if (owns(missionId, sessionId)) api.ackVideo(streamId, timestampUs, consumerId) },
    monitorScale: () => api.monitorScale(),
    // An older preload (app not restarted yet) lacks the shared record; refuse instead of throwing.
    calibrationRead: key => typeof api.calibrationRead === 'function' ? api.calibrationRead(key) : Promise.resolve(refused()),
    calibrationWrite: (key, pixelsPerMm) => typeof api.calibrationWrite === 'function' ? api.calibrationWrite(key, pixelsPerMm) : Promise.resolve(refused()),
    onCalibrationChanged: callback => typeof api.onCalibrationChanged === 'function' ? api.onCalibrationChanged(callback) : () => {},
    onChanged: callback => api.onChanged(() => callback(descriptor.missionId)),
    onVideo: callback => api.onVideo(packet => { if (owns(packet.missionId, packet.sessionId)) callback(packet) })
  }
}

export interface MobileViewState { consumerId: string | null; error: string | null }
interface ViewRecord {
  listeners: Set<(value: MobileViewState) => void>
  value: MobileViewState
  request: Promise<MobileResult<MobileViewLease> | null>
}
interface ClientViews { active: Map<string, ViewRecord>; closing: Map<string, Promise<void>> }
const clients = new WeakMap<MobileClient, ClientViews>()
const keyOf = (missionId: string, sessionId: string): string => JSON.stringify([missionId, sessionId])
function viewsFor(client: MobileClient): ClientViews {
  let views = clients.get(client)
  if (!views) { views = { active: new Map(), closing: new Map() }; clients.set(client, views) }
  return views
}
export function currentMobileConsumer(client: MobileClient | null, missionId: string, sessionId: string): string | null {
  return client ? clients.get(client)?.active.get(keyOf(missionId, sessionId))?.value.consumerId ?? null : null
}

/** A screen, its pointer controller and button queue share one claim. A rapid
 * hide/reopen waits for an in-flight claim and exact-token release before it can
 * acquire again, so a late result never replaces the new presentation's token.
 */
export function retainMobileView(client: MobileClient, missionId: string, sessionId: string, changed: (value: MobileViewState) => void): () => void {
  const views = viewsFor(client), key = keyOf(missionId, sessionId)
  let record = views.active.get(key)
  if (!record) {
    record = { listeners: new Set(), value: { consumerId: null, error: null }, request: Promise.resolve(null) }
    views.active.set(key, record)
    const current = record, barrier = views.closing.get(key)
    current.request = (async () => {
      if (barrier) await barrier
      if (views.active.get(key) !== current) return null
      let result: MobileResult<MobileViewLease>
      try {
        result = typeof client.acquireView === 'function' ? await client.acquireView(missionId, sessionId)
          : { ok: false, error: 'Reinicie o Synkora para usar esta visualização.' }
        if (result.ok && (typeof result.value?.consumerId !== 'string' || !result.value.consumerId || result.value.consumerId.length > 200)) result = refused()
      } catch { result = { ok: false, error: 'Não foi possível assumir a visualização. Tente abrir o aparelho novamente.' } }
      if (views.active.get(key) === current) {
        current.value = result.ok ? { consumerId: result.value.consumerId, error: null } : { consumerId: null, error: result.error }
        for (const listener of current.listeners) listener(current.value)
      }
      return result
    })()
  }
  const current = record
  current.listeners.add(changed)
  changed(current.value)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    current.listeners.delete(changed)
    if (current.listeners.size || views.active.get(key) !== current) return
    views.active.delete(key)
    const cleanup = current.request.then(async result => {
      if (result?.ok) try { await client.releaseView(missionId, sessionId, result.value.consumerId) } catch { /* Main also revokes on window/session close. */ }
    }).catch(() => {})
    views.closing.set(key, cleanup)
    void cleanup.then(() => { if (views.closing.get(key) === cleanup) views.closing.delete(key) })
  }
}

import { useLayoutEffect, useRef, useState } from 'react'
import type { MobilePointerInput, MobileResult, MobileSession } from '../../shared/mobileSimulator'
import type { MobilePoint } from './mobileModel'
import { ownerMobileClient, type MobileClient } from './mobileClient'

interface PointerOptions {
  send: (event: MobilePointerInput) => Promise<MobileResult>
  onError: (message: string) => void
  onCancel: () => void
  now?: () => number
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (id: number) => void
  scheduleTimeout?: (callback: () => void, delay: number) => () => void
}

interface Gesture {
  id: string; created: number; start: MobilePoint; latest: MobilePoint; sent: MobilePoint
  started: boolean; ended: boolean; cancelled: boolean; completed: boolean; movePending: boolean
  frame?: number; cancelExpiry?: () => void
  done: Promise<boolean>; resolveDone: (successful: boolean) => void
}

let controllerSequence = 0
const MAX_GESTURES = 4
const MAX_QUEUE_AGE = 1000
const MAX_PENDING_CALLS = 8
const SLOW_DEVICE = 'O dispositivo está respondendo devagar. Tente o toque novamente.'

/** One native gesture at a time. Only the next DOWN waits for the preceding
 * terminal confirmation; MOVE and UP never wait for their own DOWN response.
 */
export function createMobilePointerController(options: PointerOptions) {
  const now = options.now ?? Date.now
  const requestFrame = options.requestFrame ?? (callback => window.requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame ?? (id => window.cancelAnimationFrame(id))
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer) })
  const prefix = `mp_${Date.now().toString(36)}_${++controllerSequence}`
  const gestures = new Set<Gesture>()
  let active: Gesture | null = null, last: Gesture | null = null, sequence = 0, pendingCalls = 0, disposed = false
  const current = (gesture: Gesture): boolean => !disposed && !gesture.cancelled && gestures.has(gesture)
  const dirty = (gesture: Gesture): boolean => gesture.latest.x !== gesture.sent.x || gesture.latest.y !== gesture.sent.y
  const clearScheduled = (gesture: Gesture): void => {
    if (gesture.frame !== undefined) cancelFrame(gesture.frame)
    gesture.frame = undefined
    gesture.cancelExpiry?.(); gesture.cancelExpiry = undefined
  }
  const packet = (gesture: Gesture, phase: MobilePointerInput['phase'], point = gesture.latest): MobilePointerInput => ({ phase, gestureId: gesture.id, x: point.x, y: point.y })
  const post = (event: MobilePointerInput): Promise<MobileResult> => {
    pendingCalls++
    let response: Promise<MobileResult>
    try { response = options.send(event) } catch { response = Promise.resolve({ ok: false, error: 'Não foi possível enviar o toque. Tente novamente.' }) }
    return Promise.resolve(response).catch((): MobileResult => ({ ok: false, error: 'A conexão com o dispositivo foi interrompida. Tente novamente.' }))
      .finally(() => { pendingCalls-- })
  }
  const cancel = (): void => {
    const pending = [...gestures]
    gestures.clear(); active = null
    for (const gesture of pending) {
      gesture.cancelled = true; gesture.completed = true
      clearScheduled(gesture)
      gesture.resolveDone(false)
      // Cancellation uses the captured bridge even while hidden or unmounting.
      if (gesture.started) void post(packet(gesture, 'cancel'))
    }
    if (pending.length) options.onCancel()
  }
  const fail = (message: string): void => { if (!disposed) { cancel(); options.onError(message) } }
  const send = (gesture: Gesture, event: MobilePointerInput): Promise<MobileResult> => post(event).then(result => {
    if (current(gesture) && !result.ok) fail(result.error)
    return result
  })
  const scheduleMove = (gesture: Gesture): void => {
    if (!current(gesture) || !gesture.started || gesture.ended || gesture.movePending || gesture.frame !== undefined || !dirty(gesture)) return
    gesture.frame = requestFrame(() => {
      gesture.frame = undefined
      if (!current(gesture) || gesture.ended || !dirty(gesture)) return
      if (pendingCalls >= MAX_PENDING_CALLS - 2) { fail(SLOW_DEVICE); return }
      gesture.movePending = true
      gesture.sent = { ...gesture.latest }
      void send(gesture, packet(gesture, 'move')).then(() => { gesture.movePending = false; scheduleMove(gesture) })
    })
  }
  const finish = (gesture: Gesture): void => {
    clearScheduled(gesture)
    // Flush the newest point before UP, including while a previous MOVE or
    // initial DOWN is unresolved. The bridge preserves this submission order.
    if (dirty(gesture)) { gesture.sent = { ...gesture.latest }; void send(gesture, packet(gesture, 'move')) }
    void send(gesture, packet(gesture, 'up')).then(result => {
      if (!current(gesture)) return
      gesture.completed = true
      gestures.delete(gesture)
      gesture.resolveDone(result.ok)
    })
  }
  const begin = (gesture: Gesture): void => {
    if (!current(gesture)) return
    if (now() - gesture.created > MAX_QUEUE_AGE || pendingCalls > MAX_PENDING_CALLS - 4) { fail(SLOW_DEVICE); return }
    gesture.cancelExpiry?.(); gesture.cancelExpiry = undefined
    gesture.started = true
    void send(gesture, packet(gesture, 'down', gesture.start))
    if (gesture.ended) finish(gesture)
    else scheduleMove(gesture)
  }

  return {
    down(point: MobilePoint): boolean {
      if (disposed) return false
      if (active) cancel()
      if (gestures.size >= MAX_GESTURES || pendingCalls > MAX_PENDING_CALLS - 4) { options.onError(SLOW_DEVICE); return false }
      let resolveDone!: (successful: boolean) => void
      const done = new Promise<boolean>(resolve => { resolveDone = resolve })
      const previous = last
      const gesture: Gesture = { id: `${prefix}_${++sequence}`, created: now(), start: { ...point }, latest: { ...point }, sent: { ...point },
        started: false, ended: false, cancelled: false, completed: false, movePending: false, done, resolveDone }
      active = gesture; last = gesture; gestures.add(gesture)
      if (!previous || previous.completed) begin(gesture)
      else {
        gesture.cancelExpiry = scheduleTimeout(() => { if (current(gesture) && !gesture.started) fail(SLOW_DEVICE) }, MAX_QUEUE_AGE)
        void previous.done.then(successful => { if (!current(gesture)) return; if (successful) begin(gesture); else fail(SLOW_DEVICE) })
      }
      return current(gesture)
    },
    move(point: MobilePoint): void { if (active && current(active)) { active.latest = { ...point }; scheduleMove(active) } },
    up(point: MobilePoint): void {
      const gesture = active; active = null
      if (!gesture || !current(gesture)) return
      gesture.latest = { ...point }; gesture.ended = true
      if (gesture.started) finish(gesture)
    },
    cancel,
    dispose(): void { if (!disposed) { cancel(); disposed = true } }
  }
}

export function useMobilePointer(missionId: string, session: MobileSession | null, enabled: boolean, geometryKey: string, onCancel: () => void, client: MobileClient | null = ownerMobileClient(), consumerId?: string | null) {
  const controller = useRef<ReturnType<typeof createMobilePointerController> | null>(null)
  const cancelled = useRef(onCancel); cancelled.current = onCancel
  const [error, setError] = useState<string | null>(null)
  const api = client
  const bridge = api?.pointer
  const available = enabled && !!consumerId && session?.platform === 'android' && session.liveInputAvailable === true && typeof bridge === 'function'
  useLayoutEffect(() => {
    setError(null)
    if (!available || !session || !api || !bridge || !consumerId) return
    const pointer = createMobilePointerController({ send: event => bridge.call(api, missionId, session.id, event, consumerId), onError: setError, onCancel: () => cancelled.current() })
    controller.current = pointer
    const blur = (): void => pointer.cancel()
    const visibility = (): void => { if (document.visibilityState === 'hidden') pointer.cancel() }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      pointer.dispose()
      if (controller.current === pointer) controller.current = null
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [available, missionId, session?.id, session?.displayProfileId, geometryKey, bridge, api, consumerId])
  return {
    available, error,
    down: (point: MobilePoint): boolean => {
      if (!available || document.visibilityState === 'hidden') return false
      setError(null)
      return controller.current?.down(point) ?? false
    },
    move: (point: MobilePoint): void => controller.current?.move(point),
    up: (point: MobilePoint): void => controller.current?.up(point),
    cancel: (): void => controller.current?.cancel()
  }
}

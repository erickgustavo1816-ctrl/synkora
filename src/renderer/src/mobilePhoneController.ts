import type { MobileAction, MobilePhoneApi, MobilePhoneDescriptor } from '../../shared/mobileSimulator'
import { currentMobileConsumer, type MobileClient } from './mobileClient'

/** Button/wheel fallback queue. Native continuous pointer events keep their own
 * controller. A queued click never changes consumers after it was accepted.
 */
export function createMobilePhoneActionQueue(client: MobileClient, descriptor: MobilePhoneDescriptor, enabled: () => boolean, error: (message: string | null) => void) {
  let tail = Promise.resolve(), count = 0, disposed = false
  return {
    send(action: MobileAction): Promise<boolean> {
      const token = currentMobileConsumer(client, descriptor.missionId, descriptor.sessionId)
      if (disposed || !enabled() || !token || count >= 4 || !['tap', 'swipe', 'text', 'key'].includes(action.type)) return Promise.resolve(false)
      const acceptedAt = Date.now()
      const current = (): boolean => !disposed && enabled() && Date.now() - acceptedAt <= 1800 &&
        currentMobileConsumer(client, descriptor.missionId, descriptor.sessionId) === token
      count++
      const work = tail.then(async () => {
        if (!current()) return false
        try {
          const result = await client.act(descriptor.missionId, descriptor.sessionId, action, token)
          if (!current()) return false
          error(result.ok ? null : result.error)
          return result.ok
        } catch { if (current()) error('O aparelho não respondeu. Tente novamente.'); return false }
      })
      tail = work.then(() => {}, () => {})
      return work.finally(() => { count-- })
    },
    dispose(): void { disposed = true }
  }
}

export function validMobilePhoneDescriptor(value: MobilePhoneDescriptor, windowId: string): boolean {
  return !!value && value.windowId === windowId && !!value.missionId && !!value.projectId && !!value.sessionId &&
    (value.platform === 'android' || value.platform === 'ios') && value.session?.id === value.sessionId &&
    value.session.missionId === value.missionId && value.session.platform === value.platform
}

export function createMobilePhoneSizer(resize: MobilePhoneApi['resize'], state: (clamped: boolean) => void,
  schedule: (callback: () => void) => () => void = callback => { const timer = setTimeout(callback, 80); return () => clearTimeout(timer) }) {
  let disposed = false, sending = false, pending: { width: number; height: number } | null = null
  let cancel: (() => void) | undefined, lastSucceeded = '', inFlight = ''
  const keyOf = (size: { width: number; height: number }): string => `${size.width}:${size.height}`
  const flush = async (): Promise<void> => {
    cancel = undefined
    if (disposed || sending || !pending) return
    const size = pending; pending = null; sending = true; inFlight = keyOf(size)
    try {
      const result = await resize(size)
      lastSucceeded = result.ok ? keyOf(size) : ''
      if (!disposed && result.ok) state(result.value.clamped)
    } catch { lastSucceeded = '' /* The bound window may already be docking or closing. */ }
    finally { sending = false; inFlight = ''; if (!disposed && pending) cancel = schedule(() => { void flush() }) }
  }
  return {
    request(size: { width: number; height: number }): void {
      if (disposed || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return
      const value = { width: Math.max(100, Math.min(8192, Math.ceil(size.width))), height: Math.max(100, Math.min(8192, Math.ceil(size.height))) }
      const key = keyOf(value)
      if (pending ? key === keyOf(pending) : key === (sending ? inFlight : lastSucceeded)) return
      pending = value; cancel?.()
      if (!sending) cancel = schedule(() => { void flush() })
    },
    dispose(): void { disposed = true; pending = null; cancel?.(); cancel = undefined }
  }
}

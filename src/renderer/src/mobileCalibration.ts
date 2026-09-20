import { useEffect, useMemo, useRef, useState } from 'react'
import type { MobileMonitorScale, MobileResult } from '../../shared/mobileSimulator'

export interface MobileCalibrationScreen {
  width: number; height: number; left: number; top: number; pixelRatio: number; viewportScale: number
}

/** The slice of a mobile bridge the calibration needs. The panel and a
 * detached phone window both hand in their own client; the record itself
 * lives in the main process, so both read the SAME "Tamanho real". */
export interface MobileCalibrationClient {
  monitorScale?: () => Promise<MobileResult<MobileMonitorScale | null>>
  calibrationRead?: (key: string) => Promise<MobileResult<number | null>>
  calibrationWrite?: (key: string, pixelsPerMm: number | null) => Promise<MobileResult<boolean>>
  onCalibrationChanged?: (callback: () => void) => () => void
}

const validScale = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= .5 && value <= 20
const validScreen = (screen: MobileCalibrationScreen): boolean =>
  [screen.width, screen.height, screen.left, screen.top, screen.pixelRatio, screen.viewportScale].every(Number.isFinite) && screen.width > 0 && screen.height > 0 && screen.pixelRatio > 0 && screen.viewportScale > 0

function nativeIdentity(monitor: MobileMonitorScale): string | null {
  const bounds = monitor.displayBounds
  if (!Number.isSafeInteger(monitor.displayId) || !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height, monitor.scaleFactor].every(Number.isFinite) ||
    bounds.width <= 0 || bounds.height <= 0 || monitor.scaleFactor <= 0 || monitor.scaleFactor > 16) return null
  return [monitor.displayId, bounds.x, bounds.y, bounds.width, bounds.height, monitor.scaleFactor].join(':')
}

export function mobileCalibrationKey(screen: MobileCalibrationScreen, monitor: MobileMonitorScale | null = null): string {
  return `synkora.mobile.calibration.v3:${[screen.width, screen.height, screen.left, screen.top, screen.pixelRatio, screen.viewportScale].join(':')}:${monitor ? nativeIdentity(monitor) ?? 'invalid' : 'unidentified'}`
}
const keyAllowed = (screen: MobileCalibrationScreen, monitor: MobileMonitorScale | null): boolean =>
  validScreen(screen) && (!monitor || nativeIdentity(monitor) !== null)

function readStoredCalibration(storage: Pick<Storage, 'getItem'> | null, key: string): number | null {
  try {
    const record = JSON.parse(storage?.getItem(key) ?? 'null') as { version?: unknown; pixelsPerMm?: unknown } | null
    return record?.version === 3 && validScale(record.pixelsPerMm) ? record.pixelsPerMm : null
  } catch { return null }
}
function writeStoredCalibration(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, key: string, pixelsPerMm: number | null): boolean {
  if (!storage) return false
  try {
    if (pixelsPerMm === null) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify({ version: 3, pixelsPerMm }))
    return true
  } catch { return false }
}

export function readMobileCalibration(storage: Pick<Storage, 'getItem'> | null, screen: MobileCalibrationScreen, monitor: MobileMonitorScale | null = null): number | null {
  return keyAllowed(screen, monitor) ? readStoredCalibration(storage, mobileCalibrationKey(screen, monitor)) : null
}

export function writeMobileCalibration(storage: Pick<Storage, 'setItem'> | null, screen: MobileCalibrationScreen, pixelsPerMm: number, monitor: MobileMonitorScale | null = null): boolean {
  if (!storage || !keyAllowed(screen, monitor) || !validScale(pixelsPerMm)) return false
  return writeStoredCalibration({ setItem: storage.setItem.bind(storage), removeItem: () => {} }, mobileCalibrationKey(screen, monitor), pixelsPerMm)
}

function currentScreen(): MobileCalibrationScreen {
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number }
  return { width: screen.width, height: screen.height, left: screen.availLeft ?? 0, top: screen.availTop ?? 0,
    pixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale ?? 1 }
}
function localStorageOf(): Storage | null {
  try { return window.localStorage } catch { return null }
}

interface CalibrationStorage {
  read(key: string): Promise<number | null>
  write(key: string, pixelsPerMm: number | null): Promise<boolean>
  subscribe(callback: () => void): () => void
}
/** The app store when the bridge offers it (shared by every window); this
 * window's own storage only for older bridges and browser previews. */
function calibrationStorage(client: MobileCalibrationClient | null | undefined): CalibrationStorage {
  const api = client ?? (window.synkora?.mobile as MobileCalibrationClient | undefined)
  if (api && typeof api.calibrationRead === 'function' && typeof api.calibrationWrite === 'function') {
    const bridge = api
    return {
      read: async key => {
        try { const result = await bridge.calibrationRead!(key); return result.ok && validScale(result.value) ? result.value : null } catch { return null }
      },
      write: async (key, pixelsPerMm) => {
        try { const result = await bridge.calibrationWrite!(key, pixelsPerMm); return result.ok && result.value === true } catch { return false }
      },
      subscribe: callback => typeof bridge.onCalibrationChanged === 'function' ? bridge.onCalibrationChanged(callback) : () => {}
    }
  }
  return {
    read: async key => readStoredCalibration(localStorageOf(), key),
    write: async (key, pixelsPerMm) => writeStoredCalibration(localStorageOf(), key, pixelsPerMm),
    subscribe: callback => { window.addEventListener('storage', callback); return () => window.removeEventListener('storage', callback) }
  }
}

interface CalibrationState {
  screen: MobileCalibrationScreen; key: string; manualPixelsPerMm: number | null; automatic: MobileMonitorScale | null; resolved: boolean
}

/** OS monitor metadata is in device pixels, while layout is in CSS pixels. */
export function mobileMonitorPixelsPerMm(monitor: MobileMonitorScale | null, screen: MobileCalibrationScreen): number | null {
  if (!monitor || !['edid-detailed', 'edid-basic', 'coregraphics'].includes(monitor.source) || !validScreen(screen) || nativeIdentity(monitor) === null) return null
  const scale = monitor.physicalPixelsPerMm / (screen.pixelRatio * screen.viewportScale)
  return validScale(scale) ? scale : null
}

/** Polling detects moving a fixed-size window; a normal panel resize does not
 * reprobe. Each result and manual override is bound to its exact screen context.
 */
export function useMobileCalibration(physicalActive = false, client?: MobileCalibrationClient | null): {
  screen: MobileCalibrationScreen; key: string; pixelsPerMm: number; manualPixelsPerMm: number | null
  source: 'manual' | 'edid-detailed' | 'edid-basic' | 'coregraphics' | 'estimated'
  confirm: (pixelsPerMm: number) => boolean; reset: () => boolean
} {
  const [value, setValue] = useState<CalibrationState>(() => {
    const screen = currentScreen()
    return { screen, key: mobileCalibrationKey(screen), manualPixelsPerMm: null, automatic: null, resolved: false }
  })
  const current = useRef(value)
  current.current = value
  const active = useRef(physicalActive)
  active.current = physicalActive
  const revalidate = useRef<(() => void) | null>(null)
  const store = useMemo(() => calibrationStorage(client), [client])
  useEffect(() => {
    let disposed = false, request = 0, polls = 0
    const query = async (screen: MobileCalibrationScreen, key: string): Promise<void> => {
      const sequence = ++request
      const monitorApi = client && typeof client.monitorScale === 'function' ? client : window.synkora?.mobile
      let automatic: MobileMonitorScale | null = null
      try {
        if (typeof monitorApi?.monitorScale === 'function') {
          const result = await monitorApi.monitorScale()
          if (result.ok && mobileMonitorPixelsPerMm(result.value, screen) !== null) automatic = result.value
        }
      } catch { /* Older bridges and unavailable monitor data use an explicit estimate. */ }
      const stale = (): boolean => disposed || sequence !== request || mobileCalibrationKey(current.current.screen) !== key || mobileCalibrationKey(currentScreen()) !== key
      if (stale()) return
      const identityKey = mobileCalibrationKey(screen, automatic)
      const manualPixelsPerMm = keyAllowed(screen, automatic) ? await store.read(identityKey) : null
      if (stale()) return
      const previous = current.current
      if (previous.resolved && previous.key === identityKey && previous.manualPixelsPerMm === manualPixelsPerMm &&
        previous.automatic?.physicalPixelsPerMm === automatic?.physicalPixelsPerMm && previous.automatic?.source === automatic?.source) return
      const next = { screen, key: identityKey, manualPixelsPerMm, automatic, resolved: true }
      current.current = next
      setValue(next)
    }
    const check = (force = false): void => {
      const screen = currentScreen(), key = mobileCalibrationKey(screen)
      const changed = key !== mobileCalibrationKey(current.current.screen)
      if (changed) {
        const next = { screen, key, manualPixelsPerMm: null, automatic: null, resolved: false }
        current.current = next
        setValue(next)
      }
      if (changed || force) void query(screen, key)
    }
    const resized = (): void => check()
    const focused = (): void => check(true)
    revalidate.current = focused
    const synced = (): void => {
      check()
      const state = current.current
      if (!state.resolved) return
      void store.read(state.key).then(manualPixelsPerMm => {
        if (disposed || current.current.key !== state.key || !current.current.resolved || current.current.manualPixelsPerMm === manualPixelsPerMm) return
        const next = { ...current.current, manualPixelsPerMm }
        current.current = next
        setValue(next)
      })
    }
    check(true)
    // Native IDs can change without changing CSS screen metrics, e.g. replacing
    // the primary monitor. The main caches this read until OS display events.
    const timer = window.setInterval(() => check(++polls % 5 === 0 && active.current && document.visibilityState !== 'hidden'), 1000)
    const unsubscribe = store.subscribe(synced)
    window.addEventListener('resize', resized)
    window.addEventListener('focus', focused)
    window.addEventListener('synkora-mobile-calibration', synced)
    window.visualViewport?.addEventListener('resize', resized)
    return () => {
      disposed = true; request++
      if (revalidate.current === focused) revalidate.current = null
      window.clearInterval(timer)
      unsubscribe()
      window.removeEventListener('resize', resized)
      window.removeEventListener('focus', focused)
      window.removeEventListener('synkora-mobile-calibration', synced)
      window.visualViewport?.removeEventListener('resize', resized)
    }
  }, [store])
  useEffect(() => { if (physicalActive) revalidate.current?.() }, [physicalActive])
  const automaticScale = mobileMonitorPixelsPerMm(value.automatic, value.screen)
  const source = value.manualPixelsPerMm !== null ? 'manual' : automaticScale !== null ? value.automatic!.source : 'estimated'
  /** Optimistic: the layout follows at once; a refused write re-reads the store and reverts. */
  const commit = (pixelsPerMm: number | null): boolean => {
    const screen = currentScreen(), key = mobileCalibrationKey(screen, current.current.automatic)
    if (!current.current.resolved || key !== value.key || key !== current.current.key || !keyAllowed(screen, current.current.automatic) ||
      (pixelsPerMm !== null && !validScale(pixelsPerMm))) return false
    const next = { ...current.current, screen, key, manualPixelsPerMm: pixelsPerMm }
    current.current = next
    setValue(next)
    void store.write(key, pixelsPerMm).then(ok => { if (!ok) revalidate.current?.() })
    window.dispatchEvent?.(new Event('synkora-mobile-calibration'))
    return true
  }
  return { screen: value.screen, key: value.key, manualPixelsPerMm: value.manualPixelsPerMm, source,
    pixelsPerMm: value.manualPixelsPerMm ?? automaticScale ?? 96 / 25.4,
    confirm: pixelsPerMm => commit(pixelsPerMm), reset: () => commit(null) }
}

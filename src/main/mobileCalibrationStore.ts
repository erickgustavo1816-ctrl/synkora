/** One "Tamanho real" calibration for the whole app: the panel and every
 * detached phone window read and write the SAME record, keyed by the exact
 * screen + monitor identity the renderer computes. Renderer-local storage
 * cannot do this: a detached window lives in its own throwaway partition. */
import { loadJsonStore, persistJsonStore } from './jsonStore'

export interface MobileCalibrationStoreLike {
  read(key: string): number | null
  /** `null` removes the record. Returns false when nothing was stored. */
  write(key: string, pixelsPerMm: number | null): boolean
}

interface CalibrationDoc { version: 1; entries: Record<string, number> }

export const MOBILE_CALIBRATION_KEY_PATTERN = /^synkora\.mobile\.calibration\.v3:[0-9A-Za-z.:_-]{1,200}$/u
export const validMobileCalibrationKey = (key: unknown): key is string => typeof key === 'string' && MOBILE_CALIBRATION_KEY_PATTERN.test(key)
export const validMobileCalibrationScale = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= .5 && value <= 20

const emptyDoc = (): CalibrationDoc => ({ version: 1, entries: {} })
const isDoc = (value: unknown): value is CalibrationDoc => {
  if (!value || typeof value !== 'object' || (value as CalibrationDoc).version !== 1) return false
  const entries = (value as CalibrationDoc).entries
  return !!entries && typeof entries === 'object' && !Array.isArray(entries) &&
    Object.entries(entries).every(([key, scale]) => validMobileCalibrationKey(key) && validMobileCalibrationScale(scale))
}

export class MobileCalibrationStore implements MobileCalibrationStoreLike {
  private doc: CalibrationDoc
  private readonly listeners = new Set<() => void>()
  constructor(private readonly file?: string) {
    this.doc = file ? loadJsonStore(file, emptyDoc, isDoc) : emptyDoc()
  }
  read(key: string): number | null {
    if (!validMobileCalibrationKey(key)) return null
    return Object.hasOwn(this.doc.entries, key) ? this.doc.entries[key] : null
  }
  write(key: string, pixelsPerMm: number | null): boolean {
    if (!validMobileCalibrationKey(key) || (pixelsPerMm !== null && !validMobileCalibrationScale(pixelsPerMm))) return false
    const entries = { ...this.doc.entries }
    if (pixelsPerMm === null) delete entries[key]
    else entries[key] = pixelsPerMm
    const next: CalibrationDoc = { version: 1, entries }
    try { if (this.file) persistJsonStore(this.file, next) } catch { return false }
    this.doc = next
    for (const listener of this.listeners) listener()
    return true
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

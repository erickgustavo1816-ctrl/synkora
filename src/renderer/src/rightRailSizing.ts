export const RIGHT_RAIL_MIN_WIDTH = 176
export const RIGHT_RAIL_DEFAULT_WIDTH = 204
export const RIGHT_RAIL_MAX_RATIO = 0.42
export const RIGHT_RAIL_MIN_CENTER_WIDTH = 360
export const RIGHT_RAIL_KEYBOARD_STEP = 24

export interface RightRailBounds {
  min: number
  max: number
}

export interface RightRailPreference {
  width: number
  collapsed: boolean
}

export interface RightRailStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * Calcula os limites do trilho sem depender do DOM.
 *
 * `availableWidth` é a caixa real do split. O trilho nunca pode ocupar mais
 * que uma fração dela nem deixar o centro abaixo do mínimo legível. Em telas
 * estreitas o mínimo se adapta para que o contrato não force overflow.
 */
export function rightRailBounds(
  availableWidth: number,
  options: {
    minWidth?: number
    maxRatio?: number
    minCenterWidth?: number
    reservedGap?: number
  } = {}
): RightRailBounds {
  const available = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0
  const requestedMin = Math.max(0, options.minWidth ?? RIGHT_RAIL_MIN_WIDTH)
  const ratio = Math.min(1, Math.max(0, options.maxRatio ?? RIGHT_RAIL_MAX_RATIO))
  const center = Math.max(0, options.minCenterWidth ?? RIGHT_RAIL_MIN_CENTER_WIDTH)
  const gap = Math.max(0, options.reservedGap ?? 12)
  const max = Math.max(0, Math.min(available * ratio, available - center - gap))
  // A geometria não pode devolver min > max: quando o viewport fica apertado,
  // deixamos o rail ceder até a caixa que o layout realmente oferece.
  const min = Math.min(requestedMin, max)
  return { min, max }
}

export function clampRightRailWidth(
  width: number,
  availableWidth: number,
  options?: Parameters<typeof rightRailBounds>[1]
): number {
  const bounds = rightRailBounds(availableWidth, options)
  const fallback = bounds.min
  const value = Number.isFinite(width) ? width : fallback
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)))
}

export function stepRightRailWidth(
  width: number,
  direction: 'decrease' | 'increase',
  availableWidth: number,
  step = RIGHT_RAIL_KEYBOARD_STEP,
  options?: Parameters<typeof rightRailBounds>[1]
): number {
  const delta = Math.max(1, Math.abs(step)) * (direction === 'increase' ? 1 : -1)
  return clampRightRailWidth(width + delta, availableWidth, options)
}

export function rightRailStorageKey(projectKey?: string): string {
  const suffix = projectKey?.trim() ? `:${encodeURIComponent(projectKey.trim())}` : ''
  return `synkora.rightRail.v1${suffix}`
}

export function readRightRailPreference(
  storage: RightRailStorage | null | undefined,
  key: string,
  fallback: RightRailPreference = {
    width: RIGHT_RAIL_DEFAULT_WIDTH,
    collapsed: false
  }
): RightRailPreference {
  if (!storage) return fallback
  try {
    const raw = storage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    const candidate = parsed as { width?: unknown; collapsed?: unknown }
    const width =
      typeof candidate.width === 'number' && Number.isFinite(candidate.width)
        ? candidate.width
        : fallback.width
    const collapsed =
      typeof candidate.collapsed === 'boolean' ? candidate.collapsed : fallback.collapsed
    return { width, collapsed }
  } catch {
    // Preferência corrompida não pode impedir o app de abrir.
    return fallback
  }
}

export function writeRightRailPreference(
  storage: RightRailStorage | null | undefined,
  key: string,
  preference: RightRailPreference
): void {
  if (!storage) return
  try {
    storage.setItem(
      key,
      JSON.stringify({
        width: Math.round(preference.width),
        collapsed: Boolean(preference.collapsed)
      })
    )
  } catch {
    // Storage cheio/bloqueado é uma preferência opcional, nunca um erro fatal.
  }
}

import {
  viewportEffectiveWidth,
  viewportFitZoom,
  viewportViewWidth,
  type BrowserViewportMode,
  type ViewportRect
} from './browserViewport'

export interface ViewportFitTarget {
  getURL(): string
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  enableDeviceEmulation(parameters: {
    screenPosition: 'desktop'
    screenSize: { width: number; height: number }
    viewPosition: { x: number; y: number }
    deviceScaleFactor: number
    viewSize: { width: number; height: number }
    scale: number
  }): void
  disableDeviceEmulation(): void
}

interface ViewportFitState {
  zoom: number
  width: number
  height: number
  emulated: boolean
}

const fits = new WeakMap<object, ViewportFitState>()

export function applyViewportFit(
  target: ViewportFitTarget,
  mode: BrowserViewportMode,
  frameWidth: number,
  frameHeight = 0,
  force = false
): { zoom: number; changed: boolean } {
  const zoom = viewportFitZoom(mode, frameWidth)
  const emulated = mode !== 'auto' && viewportViewWidth(mode, frameWidth) > 0
  const width = emulated ? viewportEffectiveWidth(mode, frameWidth) : 0
  const height = emulated && Number.isFinite(frameHeight) && frameHeight > 0
    ? Math.max(1, Math.round(frameHeight / zoom)) : 0
  const previous = fits.get(target)
  try {
    if (!target.getURL()) return { zoom, changed: false }
    const resetZoom = target.getZoomFactor() !== 1
    if (resetZoom) target.setZoomFactor(1)
    if (!force && previous && previous.zoom === zoom && previous.width === width &&
      previous.height === height && previous.emulated === emulated) {
      return { zoom, changed: resetZoom }
    }
    if (emulated) {
      target.enableDeviceEmulation({
        screenPosition: 'desktop', screenSize: { width: 0, height: 0 },
        viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0,
        viewSize: { width, height }, scale: zoom
      })
    } else if (previous?.emulated) {
      target.disableDeviceEmulation()
    }
    fits.set(target, { zoom, width, height, emulated })
    return { zoom, changed: resetZoom || emulated || previous?.emulated === true }
  } catch {
    return { zoom, changed: false }
  }
}

export function viewportInputParams(
  target: object,
  params: Record<string, unknown>
): Record<string, unknown> {
  const zoom = fits.get(target)?.zoom ?? 1
  if (zoom === 1) return params
  const scaled = { ...params }
  for (const key of ['x', 'y', 'deltaX', 'deltaY']) {
    const value = params[key]
    if (typeof value === 'number' && Number.isFinite(value)) scaled[key] = value * zoom
  }
  return scaled
}

export function viewportCaptureRect(target: object, rect?: ViewportRect): ViewportRect | undefined {
  const zoom = fits.get(target)?.zoom ?? 1
  if (!rect || zoom === 1) return rect
  const x = Math.floor(rect.x * zoom)
  const y = Math.floor(rect.y * zoom)
  return {
    x,
    y,
    width: Math.ceil((rect.x + rect.width) * zoom) - x,
    height: Math.ceil((rect.y + rect.height) * zoom) - y
  }
}

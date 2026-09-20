import { BROWSER_DEFAULT_VIEW_SIZE, type BrowserPanelRect } from './browserPaneContracts'

interface SurfaceLayout {
  rect: BrowserPanelRect
  visible: boolean
}

export function roundBrowserRect(rect: BrowserPanelRect): BrowserPanelRect {
  const num = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0)
  return { x: num(rect.x), y: num(rect.y), width: Math.max(0, num(rect.width)), height: Math.max(0, num(rect.height)) }
}

/** Intersect visible native content with its host; an outside rectangle has
 * zero area, rather than being shifted back into a one-pixel strip. */
export function clipBrowserSurfaceRect(
  rect: BrowserPanelRect,
  size: { width: number; height: number } | null
): BrowserPanelRect {
  const bounds = roundBrowserRect(rect)
  if (!size) return bounds
  const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y)
  const width = Math.max(0, size.width), height = Math.max(0, size.height)
  return {
    x: Math.min(left, width), y: Math.min(top, height),
    width: Math.max(0, Math.min(width, bounds.x + bounds.width) - left),
    height: Math.max(0, Math.min(height, bounds.y + bounds.height) - top)
  }
}

const usable = (rect: BrowserPanelRect | null | undefined): rect is BrowserPanelRect =>
  !!rect && rect.width > 1 && rect.height > 1

/** Visibility controls painting, not the page's ability to lay out and accept
 * browser tools. Hidden/collapsing panels retain their last usable surface;
 * a mission born in the background starts at desktop size, independently of
 * the window. A hidden surface remains attached to its existing host. */
export function resolveBrowserSurfaceLayout(
  wanted: SurfaceLayout | null,
  size: { width: number; height: number } | null,
  previous: BrowserPanelRect | null
): SurfaceLayout {
  const clipped = wanted?.visible ? clipBrowserSurfaceRect(wanted.rect, size) : null
  if (usable(clipped)) return { rect: clipped, visible: true }
  const rect = usable(previous) ? previous
    : usable(wanted?.rect) ? roundBrowserRect(wanted.rect)
      : { x: 0, y: 0, ...BROWSER_DEFAULT_VIEW_SIZE }
  return { rect, visible: false }
}

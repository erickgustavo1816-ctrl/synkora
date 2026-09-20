import type { MobileMonitorScale } from '../shared/mobileSimulator'
import type { NativeMonitorMetrics, WindowsMonitorMetrics } from './mobileMonitorScale'

export interface MobileMonitorContext {
  platform?: 'win32' | 'darwin'
  displayId: number
  displayBounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  /** Physical pixels, obtained by Electron's Windows DIP conversion. */
  centerPx: { x: number; y: number }
}

const validRectangle = (box: MobileMonitorContext['displayBounds']): boolean =>
  !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
  Math.abs(box.x) <= 1_000_000 && Math.abs(box.y) <= 1_000_000 &&
  box.width >= 16 && box.height >= 16 && box.width <= 65536 && box.height <= 65536

const validContext = (value: MobileMonitorContext | null): value is MobileMonitorContext => !!value &&
  Number.isSafeInteger(value.displayId) && validRectangle(value.displayBounds) &&
  Number.isFinite(value.scaleFactor) && value.scaleFactor >= .25 && value.scaleFactor <= 8 &&
  Number.isFinite(value.centerPx?.x) && Number.isFinite(value.centerPx?.y)

/** The renderer supplies no monitor selector. A stale/ambiguous OS match yields
 * no measurement; the UI can offer an explicitly approximate or manual scale.
 */
export function createMobileMonitorReader(deps: {
  current(): MobileMonitorContext | null
  read(): Promise<NativeMonitorMetrics[]>
}): () => Promise<MobileMonitorScale | null> {
  return async () => {
    try {
      const context = deps.current()
      if (!validContext(context)) return null
      const signature = JSON.stringify(context)
      const monitors = await deps.read()
      if (JSON.stringify(deps.current()) !== signature || !Array.isArray(monitors) || monitors.length > 32) return null
      if (context.platform === 'darwin') {
        const matches = monitors.filter(item => item.source === 'coregraphics' && item.displayId === context.displayId)
        if (matches.length !== 1 || matches[0].source !== 'coregraphics') return null
        const monitor = matches[0]
        if (!validRectangle(monitor.boundsDip) || !['x', 'y', 'width', 'height'].every(key =>
          monitor.boundsDip[key as keyof typeof monitor.boundsDip] === context.displayBounds[key as keyof typeof context.displayBounds]) ||
          ![monitor.widthMm, monitor.heightMm].every(value => Number.isFinite(value) && value >= 70 && value <= 2500)) return null
        // macOS "More Space" can render a framebuffer larger than the panel.
        // Layout needs current DIP/mm, converted to backing pixels for the same
        // renderer DPR/zoom contract used by Windows. Never use panel resolution.
        const horizontal = context.displayBounds.width * context.scaleFactor / monitor.widthMm
        const vertical = context.displayBounds.height * context.scaleFactor / monitor.heightMm
        if (horizontal < .5 || horizontal > 100 || vertical < .5 || vertical > 100 || Math.abs(horizontal / vertical - 1) > .05) return null
        return { physicalPixelsPerMm: horizontal, source: monitor.source, displayId: context.displayId,
          displayBounds: { ...context.displayBounds }, scaleFactor: context.scaleFactor }
      }
      const matches = monitors.filter((item): item is WindowsMonitorMetrics => item.source !== 'coregraphics' && validRectangle(item.boundsPx) &&
        context.centerPx.x >= item.boundsPx.x && context.centerPx.x < item.boundsPx.x + item.boundsPx.width &&
        context.centerPx.y >= item.boundsPx.y && context.centerPx.y < item.boundsPx.y + item.boundsPx.height)
      if (matches.length !== 1) return null
      const monitor = matches[0]
      if (!['edid-detailed', 'edid-basic'].includes(monitor.source) ||
        ![monitor.widthMm, monitor.heightMm].every(value => Number.isFinite(value) && value >= 20 && value <= 4000)) return null
      const tolerance = Math.max(2, 2 * context.scaleFactor)
      if (Math.abs(monitor.boundsPx.width - context.displayBounds.width * context.scaleFactor) > tolerance ||
        Math.abs(monitor.boundsPx.height - context.displayBounds.height * context.scaleFactor) > tolerance) return null
      const horizontal = monitor.boundsPx.width / monitor.widthMm
      const vertical = monitor.boundsPx.height / monitor.heightMm
      if (horizontal < .5 || horizontal > 100 || vertical < .5 || vertical > 100 || Math.abs(horizontal / vertical - 1) > .05) return null
      return { physicalPixelsPerMm: horizontal, source: monitor.source, displayId: context.displayId,
        displayBounds: { ...context.displayBounds }, scaleFactor: context.scaleFactor }
    } catch { return null }
  }
}

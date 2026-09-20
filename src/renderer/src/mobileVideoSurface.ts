export interface MobileVideoSize { width: number; height: number }
export interface MobileVideoBox extends MobileVideoSize { left: number; top: number }
export interface MobileVideoSurface extends MobileVideoSize {
  left: number
  top: number
  cssWidth: number
  cssHeight: number
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
}

/** Only the canvas surface is snapped. Its parent's physical/fit layout stays exact. */
export function mobileVideoSurface(box: MobileVideoBox, source: MobileVideoSize, pixelRatio: number, origin = { left: 0, top: 0 }): MobileVideoSurface | null {
  if (![box.left, box.top, box.width, box.height, source.width, source.height, pixelRatio, origin.left, origin.top].every(Number.isFinite)
    || box.width <= 0 || box.height <= 0 || source.width <= 0 || source.height <= 0 || pixelRatio <= 0) return null
  const width = Math.max(1, Math.round(box.width * pixelRatio))
  const height = Math.max(1, Math.round(box.height * pixelRatio))
  if (width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) return null
  const scale = Math.min(width / source.width, height / source.height)
  const drawWidth = source.width * scale, drawHeight = source.height * scale
  return {
    width, height, cssWidth: width / pixelRatio, cssHeight: height / pixelRatio,
    left: Math.round((box.left - origin.left) * pixelRatio) / pixelRatio + origin.left - box.left,
    top: Math.round((box.top - origin.top) * pixelRatio) / pixelRatio + origin.top - box.top,
    drawX: (width - drawWidth) / 2, drawY: (height - drawHeight) / 2, drawWidth, drawHeight
  }
}

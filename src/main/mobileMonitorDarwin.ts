/** CoreGraphics metadata only: no window capture, Accessibility or Apple Events. */
export interface DarwinMonitorMetrics {
  displayId: number
  /** macOS global display coordinates, before Electron backing scale/zoom. */
  boundsDip: { x: number; y: number; width: number; height: number }
  widthMm: number
  heightMm: number
  source: 'coregraphics'
  confidence: 'reported'
}

// JXA's Objective-C bridge loads the system frameworks in this owned process.
// There is no Application() target, renderer input, file access or shell command.
export const DARWIN_MONITOR_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
(function () {
  var screens = $.NSScreen.screens;
  if (screens.count > 32) return '[]';
  var rows = [];
  for (var index = 0; index < screens.count; index++) {
    var screen = screens.objectAtIndex(index);
    var id = Number(screen.deviceDescription.objectForKey('NSScreenNumber').unsignedIntValue);
    var bounds = $.CGDisplayBounds(id);
    var physical = $.CGDisplayScreenSize(id);
    rows.push({displayId: id,
      boundsDip: {x: Number(bounds.origin.x), y: Number(bounds.origin.y),
        width: Number(bounds.size.width), height: Number(bounds.size.height)},
      widthMm: Number(physical.width), heightMm: Number(physical.height),
      rotation: Number($.CGDisplayRotation(id)),
      active: Boolean($.CGDisplayIsActive(id)), mirrored: Boolean($.CGDisplayIsInMirrorSet(id))});
  }
  return JSON.stringify(rows);
})();
`

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const dimension = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 70 && value <= 2500

/** Apple documents a 72 dpi estimate when EDID is missing. CoreGraphics does
 * not expose a provenance flag. Reject values consistent with that fallback,
 * even if this conservatively rejects a genuine panel near that exact density.
 * Remaining values are OS-reported measurements, never certified calibration.
 */
function inferredSize(widthMm: number, heightMm: number, width: number, height: number): boolean {
  return [72 / 25.4, 2.835].some(density =>
    Math.abs(width / widthMm - density) <= .012 && Math.abs(height / heightMm - density) <= .012)
}

export function parseDarwinMonitorSamples(output: unknown): DarwinMonitorMetrics[] {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 65536) return []
  let samples: unknown
  try { samples = JSON.parse(output) } catch { return [] }
  if (!Array.isArray(samples) || samples.length > 32) return []
  const result: DarwinMonitorMetrics[] = []
  for (const sample of samples) {
    if (!object(sample) || !integer(sample.displayId, 1, 0xffffffff) || sample.active !== true || sample.mirrored !== false ||
      ![0, 90, 180, 270].includes(sample.rotation as number) || !object(sample.boundsDip) ||
      !dimension(sample.widthMm) || !dimension(sample.heightMm)) continue
    const { x, y, width, height } = sample.boundsDip
    if (!integer(x, -1000000, 1000000) || !integer(y, -1000000, 1000000) ||
      !integer(width, 128, 32768) || !integer(height, 128, 32768) || Math.abs(x + width) > 1000000 || Math.abs(y + height) > 1000000 ||
      Math.hypot(sample.widthMm, sample.heightMm) < 150 || Math.hypot(sample.widthMm, sample.heightMm) > 3000 ||
      inferredSize(sample.widthMm, sample.heightMm, width, height)) continue
    const rotated = sample.rotation === 90 || sample.rotation === 270
    const widthMm = rotated ? sample.heightMm : sample.widthMm, heightMm = rotated ? sample.widthMm : sample.heightMm
    const aspect = (widthMm / heightMm) / (width / height)
    if (!Number.isFinite(aspect) || aspect < 1 / 1.05 || aspect > 1.05 || inferredSize(widthMm, heightMm, width, height)) continue
    result.push({ displayId: sample.displayId, boundsDip: { x, y, width, height }, widthMm, heightMm,
      source: 'coregraphics', confidence: 'reported' })
  }
  return result.filter((row, index) => !result.some((other, otherIndex) => index !== otherIndex &&
    (row.displayId === other.displayId || (row.boundsDip.x < other.boundsDip.x + other.boundsDip.width &&
      other.boundsDip.x < row.boundsDip.x + row.boundsDip.width && row.boundsDip.y < other.boundsDip.y + other.boundsDip.height &&
      other.boundsDip.y < row.boundsDip.y + row.boundsDip.height))))
}

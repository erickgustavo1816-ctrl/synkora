import type { MobileAction, MobileFrame, MobilePlatform, MobileSession, MobileState } from '../../shared/mobileSimulator'
import { getMobileDeviceProfile, type MobileDeviceProfileId } from '../../shared/mobileDeviceProfiles'

export const MOBILE_NO_API = 'reinicie o app para abrir os simuladores desta missão'
const MAX_FRAME_CHARS = 24 * 1024 * 1024

export interface MobileSelection {
  platform: MobilePlatform
  view?: 'expo'
  displayProfileId?: MobileDeviceProfileId
  devices: Partial<Record<MobilePlatform, string>>
}

export function mobileSelectionKey(projectId: string, missionId: string): string {
  return `synkora.mobile.v1:${encodeURIComponent(projectId)}:${encodeURIComponent(missionId)}`
}

export function readMobileSelection(storage: Pick<Storage, 'getItem'> | null, key: string): MobileSelection {
  try {
    const raw = JSON.parse(storage?.getItem(key) ?? 'null') as Partial<MobileSelection> | null
    return {
      platform: raw?.platform === 'ios' ? 'ios' : 'android',
      ...(raw?.view === 'expo' ? { view: 'expo' as const } : {}),
      ...(getMobileDeviceProfile(raw?.displayProfileId) ? { displayProfileId: getMobileDeviceProfile(raw?.displayProfileId)!.id } : {}),
      devices: {
        ...(typeof raw?.devices?.android === 'string' ? { android: raw.devices.android } : {}),
        ...(typeof raw?.devices?.ios === 'string' ? { ios: raw.devices.ios } : {})
      }
    }
  } catch { return { platform: 'android', devices: {} } }
}

export function mobilePlatformEnabled(state: MobileState | null, platform: MobilePlatform): boolean {
  return !!state && (platform !== 'ios' || state.hostPlatform === 'darwin') &&
    state.platforms.some(item => item.platform === platform && item.supported)
}

export function activeMobileSession(state: MobileState | null, missionId: string, platform: MobilePlatform): MobileSession | null {
  return state?.sessions.find(session => session.missionId === missionId && session.platform === platform) ?? null
}

/** The main owns capture; only bounded PNG data from this lease can be painted. */
export function mobileFrameSource(frame: MobileFrame, sessionId: string): string | null {
  if (frame.sessionId !== sessionId || frame.mimeType !== 'image/png' ||
    !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) ||
    frame.width <= 0 || frame.height <= 0 || frame.width > 16384 || frame.height > 16384 ||
    typeof frame.data !== 'string' || frame.data.length > MAX_FRAME_CHARS || !frame.data.startsWith('iVBORw0KGgo')) return null
  return `data:image/png;base64,${frame.data}`
}

export interface MobilePoint { x: number; y: number }

export function mobileFrameAppearance(platform: MobilePlatform, profileId?: string, deviceTypeIdentifier?: string): {
  family: 'pixel' | 'galaxy' | 'galaxy-ultra' | 'iphone' | 'iphone-home' | 'iphone-notch' | 'iphone-island'
  bezel: number; chin: number
} {
  if (platform === 'android') {
    const profile = getMobileDeviceProfile(profileId)
    return { family: profile?.frame ?? 'pixel', bezel: 2, chin: 0 }
  }
  const prefix = 'com.apple.CoreSimulator.SimDeviceType.'
  const type = deviceTypeIdentifier?.startsWith(prefix) ? deviceTypeIdentifier.slice(prefix.length) : ''
  if (/^iPhone-(?:SE(?:-|$)|[4-8]s?(?:-|$))/i.test(type)) return { family: 'iphone-home', bezel: 6, chin: 26 }
  if (/^iPhone-(?:14-Pro(?:-Max)?|15(?:-Plus|-Pro(?:-Max)?)?|16(?:-Plus|-Pro(?:-Max)?)?|17(?:-Pro(?:-Max)?)?|Air)$/i.test(type)) return { family: 'iphone-island', bezel: 6, chin: 0 }
  if (/^iPhone-(?:X[RS]?|(?:11|12|13|14)(?:-mini|-Plus|-Pro(?:-Max)?)?|(?:16|17)e)$/i.test(type)) return { family: 'iphone-notch', bezel: 6, chin: 0 }
  return { family: 'iphone', bezel: 6, chin: 0 }
}

/** Hardware remains outside the display; zoom never changes input coordinates. */
export function mobilePhoneLayout(width: number, height: number, ratio: number, zoom: number, bezel = 6, chin = 0): { width: number; height: number } {
  const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : .5
  const scale = Number.isFinite(zoom) ? Math.max(1, Math.min(2.5, zoom)) : 1
  const horizontal = 2 * bezel + (aspect > 1 ? 2 * chin : 0)
  const vertical = 2 * bezel + (aspect <= 1 ? 2 * chin : 0)
  const displayWidth = Math.max(24, Math.min(Math.max(24, width - 12 - horizontal), Math.max(24, height - 12 - vertical) * aspect)) * scale
  return { width: displayWidth + horizontal, height: displayWidth / aspect + vertical }
}

/** Known structural types only; editable device names never imply dimensions.
 * Full rectangular display diagonals, not rounded marketing sizes. Official
 * sources and the canonical-type scope are recorded in
 * .synkora/reports/MOBILE_APPEARANCE_2026-09-20.md.
 */
export interface MobilePhysicalDevice {
  bodyWidthMm: number; bodyHeightMm: number; displayDiagonalMm: number; aspectRatio: number
}
const IOS_PHYSICAL_DEVICES: Readonly<Record<string, MobilePhysicalDevice>> = {
  'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation': { bodyWidthMm: 67.3, bodyHeightMm: 138.4, displayDiagonalMm: 119.38, aspectRatio: 750 / 1334 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-14-Pro': { bodyWidthMm: 71.5, bodyHeightMm: 147.5, displayDiagonalMm: 155.448, aspectRatio: 1179 / 2556 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-16': { bodyWidthMm: 71.6, bodyHeightMm: 147.6, displayDiagonalMm: 155.448, aspectRatio: 1179 / 2556 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Plus': { bodyWidthMm: 77.8, bodyHeightMm: 160.9, displayDiagonalMm: 169.926, aspectRatio: 1290 / 2796 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro': { bodyWidthMm: 71.5, bodyHeightMm: 149.6, displayDiagonalMm: 159.258, aspectRatio: 1206 / 2622 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max': { bodyWidthMm: 77.6, bodyHeightMm: 163, displayDiagonalMm: 174.244, aspectRatio: 1320 / 2868 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-16e': { bodyWidthMm: 71.5, bodyHeightMm: 146.7, displayDiagonalMm: 153.924, aspectRatio: 1170 / 2532 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-17': { bodyWidthMm: 71.5, bodyHeightMm: 149.6, displayDiagonalMm: 159.258, aspectRatio: 1206 / 2622 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro': { bodyWidthMm: 71.9, bodyHeightMm: 150, displayDiagonalMm: 159.258, aspectRatio: 1206 / 2622 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max': { bodyWidthMm: 78, bodyHeightMm: 163.4, displayDiagonalMm: 174.244, aspectRatio: 1320 / 2868 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-Air': { bodyWidthMm: 74.7, bodyHeightMm: 156.2, displayDiagonalMm: 166.37, aspectRatio: 1260 / 2736 },
  'com.apple.CoreSimulator.SimDeviceType.iPhone-17e': { bodyWidthMm: 71.5, bodyHeightMm: 146.7, displayDiagonalMm: 153.924, aspectRatio: 1170 / 2532 }
}

export function mobilePhysicalDevice(platform: MobilePlatform, profileId?: string, deviceTypeIdentifier?: string): MobilePhysicalDevice | null {
  if (platform === 'ios') return deviceTypeIdentifier ? IOS_PHYSICAL_DEVICES[deviceTypeIdentifier] ?? null : null
  const profile = getMobileDeviceProfile(profileId)
  return profile?.bodyWidthMm && profile.bodyHeightMm && profile.displayDiagonalMm && profile.width && profile.height
    ? { bodyWidthMm: profile.bodyWidthMm, bodyHeightMm: profile.bodyHeightMm, displayDiagonalMm: profile.displayDiagonalMm, aspectRatio: profile.width / profile.height } : null
}

/** The official display rectangle follows monitor scale. By the owner's explicit
 * visual choice the surrounding frame is decorative and always2CSSpx, not body size.
 * Incompatible aspects fail closed, and encoded pixels are never stretched.
 */
export function mobileCalibratedPhoneLayout(device: MobilePhysicalDevice, ratio: number, pixelsPerMm: number, zoom: number): {
  width: number; height: number; displayWidth: number; displayHeight: number; paddingX: number; paddingY: number
} | null {
  if (![ratio, pixelsPerMm, zoom, device.bodyWidthMm, device.bodyHeightMm, device.displayDiagonalMm].every(value => Number.isFinite(value) && value > 0) || pixelsPerMm < .5 || pixelsPerMm > 20 || zoom < .5 || zoom > 2.5) return null
  const aspect = ratio > 1 ? 1 / device.aspectRatio : device.aspectRatio
  // Encoded video can round its size to even pixels. Keep official hardware
  // dimensions and contain that image, instead of resizing the physical screen.
  if (!Number.isFinite(aspect) || aspect <= 0 || Math.abs(ratio / aspect - 1) > .02) return null
  const scale = pixelsPerMm * zoom
  const portraitHeight = device.displayDiagonalMm * scale / Math.hypot(device.aspectRatio, 1)
  const portraitWidth = portraitHeight * device.aspectRatio
  const displayWidth = ratio > 1 ? portraitHeight : portraitWidth
  const displayHeight = ratio > 1 ? portraitWidth : portraitHeight
  return { width: displayWidth + 4, height: displayHeight + 4, displayWidth, displayHeight, paddingX: 2, paddingY: 2 }
}

export function mobilePointerAction(start: MobilePoint, end: MobilePoint, movement: number, durationMs: number): MobileAction {
  if (movement < 6 && durationMs < 450) return { type: 'tap', ...start }
  const destination = movement < 6 ? start : end
  return { type: 'swipe', ...start, endX: destination.x, endY: destination.y,
    durationMs: Math.max(100, Math.min(movement < 6 ? 1500 : 2000, durationMs)) }
}

export function mobileWheelSwipe(deltaX: number, deltaY: number, width: number, height: number): MobileAction | null {
  if (![deltaX, deltaY, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 4) return null
  const horizontal = Math.abs(deltaX) > Math.abs(deltaY)
  const delta = horizontal ? deltaX : deltaY
  const distance = Math.sign(delta) * Math.max(.08, Math.min(.6, Math.abs(delta) / (horizontal ? width : height)))
  return { type: 'swipe', x: horizontal ? .5 + distance / 2 : .5, y: horizontal ? .5 : .5 + distance / 2,
    endX: horizontal ? .5 - distance / 2 : .5, endY: horizontal ? .5 : .5 - distance / 2, durationMs: 180 }
}

/** Coordinates of the contained image, not its letterboxed CSS element. */
export function mobileViewportPoint(
  box: { left: number; top: number; width: number; height: number },
  width: number, height: number, clientX: number, clientY: number, clamp = false
): MobilePoint | null {
  if (![box.left, box.top, box.width, box.height, width, height, clientX, clientY].every(Number.isFinite) ||
    width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return null
  const scale = Math.min(box.width / width, box.height / height)
  const x = (clientX - box.left - (box.width - width * scale) / 2) / (width * scale)
  const y = (clientY - box.top - (box.height - height * scale) / 2) / (height * scale)
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}

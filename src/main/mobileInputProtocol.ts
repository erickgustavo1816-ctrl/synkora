import { MobileCommandError, mobilePixel } from './mobileCommands'

export interface MobileAndroidTouch {
  phase: 'down' | 'move' | 'up' | 'cancel'
  x: number
  y: number
}
export interface MobileAndroidInputDimensions { width: number; height: number }

/** scrcpy 4.1 INJECT_TOUCH_EVENT. Only one real finger, on display zero. */
export function serializeMobileAndroidTouch(event: MobileAndroidTouch, dimensions: MobileAndroidInputDimensions): Buffer {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
    Object.keys(event).some(key => !['phase', 'x', 'y'].includes(key)) ||
    !['down', 'move', 'up', 'cancel'].includes(event.phase) ||
    ![event.x, event.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new MobileCommandError('Toque inválido. Use um gesto dentro da tela do aparelho.')
  }
  if (!dimensions || typeof dimensions !== 'object' ||
    ![dimensions.width, dimensions.height].every(value => Number.isInteger(value) && value >= 1 && value <= 8192) ||
    dimensions.width * dimensions.height > 40_000_000) {
    throw new MobileCommandError('As dimensões da tela são inválidas. Atualize o aparelho e tente novamente.')
  }
  const actions = { down: 0, up: 1, move: 2, cancel: 3 } as const
  const bytes = Buffer.alloc(32)
  bytes[0] = 2
  bytes[1] = actions[event.phase]
  // Bytes 2..9 = pointer id 0; 24..31 = no mouse buttons.
  bytes.writeInt32BE(Number(mobilePixel(event.x, dimensions.width)), 10)
  bytes.writeInt32BE(Number(mobilePixel(event.y, dimensions.height)), 14)
  bytes.writeUInt16BE(dimensions.width, 18)
  bytes.writeUInt16BE(dimensions.height, 20)
  bytes.writeUInt16BE(event.phase === 'down' || event.phase === 'move' ? 0xffff : 0, 22)
  return bytes
}

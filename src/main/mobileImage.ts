const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
export const MOBILE_PNG_MAX_BYTES = 20 * 1024 * 1024

/** Validate the bounded PNG envelope before allocating a canvas or publishing it. */
export function readMobilePng(data: Buffer): { width: number; height: number } {
  if (data.length < 45 || data.length > MOBILE_PNG_MAX_BYTES || !data.subarray(0, 8).equals(SIGNATURE) ||
    data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('invalid-png')
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20)
  if (!width || !height || width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error('invalid-png-size')
  let offset = 8, imageData = false
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset)
    if (length > data.length - offset - 12) throw new Error('invalid-png-chunk')
    const type = data.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') imageData = true
    offset += length + 12
    if (type === 'IEND') {
      if (length || !imageData || offset !== data.length) throw new Error('invalid-png-end')
      return { width, height }
    }
  }
  throw new Error('incomplete-png')
}

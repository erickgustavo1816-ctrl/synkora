/** Bounded Annex-B framing for Android screenrecord (progressive AVC, no B frames).
 * Raw stdout has neither chunk boundaries nor PTS. NALs are not video frames.
 * https://www.w3.org/TR/webcodecs-avc-codec-registration/#encodedvideochunk-data
 */
export const MOBILE_H264_LIMITS = Object.freeze({
  maxNalBytes: 1024 * 1024,
  maxAccessUnitBytes: 2 * 1024 * 1024,
  maxParameterBytes: 64 * 1024,
  maxNalsPerAccessUnit: 256
})

export interface H264AccessUnit {
  codec: string
  key: boolean
  data: Uint8Array
}

interface ParameterSet { data: Uint8Array; codec: string }
interface PictureParameterSet { data: Uint8Array; spsId: number }
interface SliceHeader { firstMb: number; ppsId: number }

function invalid(): never { throw new Error('Invalid mobile AVC stream') }
function limit(): never { throw new Error('Mobile AVC buffer limit exceeded') }

/** Reads only the small header prefix; strips emulation-prevention bytes first. */
class HeaderBits {
  private bytes: number[] = []
  private position = 0

  constructor(data: Uint8Array, offset: number) {
    let zeros = 0
    for (let i = offset; i < Math.min(data.length, offset + 64); i++) {
      const value = data[i]
      if (zeros === 2 && value === 3) { zeros = 0; continue }
      this.bytes.push(value)
      zeros = value === 0 ? zeros + 1 : 0
    }
  }

  private bit(): number | undefined {
    if (this.position >= this.bytes.length * 8) return undefined
    const value = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1
    this.position++
    return value
  }

  unsigned(): number | undefined {
    let zeros = 0
    let value = this.bit()
    while (value === 0) {
      if (++zeros > 30) invalid()
      value = this.bit()
    }
    if (value === undefined) return undefined
    let result = 1
    for (let i = 0; i < zeros; i++) {
      const next = this.bit()
      if (next === undefined) return undefined
      result = result * 2 + next
    }
    return result - 1
  }
}

function readSlice(data: Uint8Array): SliceHeader | undefined {
  const bits = new HeaderBits(data, 1)
  const firstMb = bits.unsigned()
  const sliceType = bits.unsigned()
  const ppsId = bits.unsigned()
  if (firstMb === undefined || sliceType === undefined || ppsId === undefined) return undefined
  if (sliceType > 9 || ppsId > 255) invalid()
  return { firstMb, ppsId }
}

function equal(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index])
}

export class H264AnnexBParser {
  private readonly onAccessUnit: (unit: H264AccessUnit) => void
  private buffer = new Uint8Array(MOBILE_H264_LIMITS.maxNalBytes)
  private length = 0
  private zeros = 0
  private scanned = 0
  private started = false
  private boundaryChecked = false
  private failed = false
  private nals: Uint8Array[] = []
  private unitBytes = 0
  private hasPicture = false
  private pictureKey = false
  private picturePps = -1
  private synchronized = false
  private sps = new Map<number, ParameterSet>()
  private pps = new Map<number, PictureParameterSet>()
  private parameterBytes = 0

  constructor(onAccessUnit: (unit: H264AccessUnit) => void) { this.onAccessUnit = onAccessUnit }

  push(chunk: Uint8Array): void {
    if (this.failed) invalid()
    try {
      for (const value of chunk) {
        if (++this.scanned > MOBILE_H264_LIMITS.maxNalBytes + (this.started ? 4 : 0)) limit()
        if (value === 0) { this.zeros = Math.min(3, this.zeros + 1); continue }
        if (value === 1 && this.zeros >= 2) {
          this.finishNal()
          this.started = true
          this.length = 0
          this.scanned = 0
          this.boundaryChecked = false
        } else if (this.started) {
          for (let i = 0; i < this.zeros; i++) this.append(0)
          this.append(value)
        }
        this.zeros = 0
      }
    } catch (error) { this.failed = true; this.discardUnit(); throw error }
  }

  /** Only at EOF or a complete producer-framed AVC buffer; never a TCP/stdout
   * chunk boundary or silence timeout. Parameter sets persist between buffers.
   */
  flush(): void {
    if (this.failed) return
    try {
      this.finishNal()
      this.finishUnit()
      this.started = false
      this.length = 0
      this.zeros = 0
      this.scanned = 0
    } catch (error) { this.failed = true; this.discardUnit(); throw error }
  }

  private append(value: number): void {
    if (this.length >= this.buffer.length) limit()
    this.buffer[this.length++] = value
    if (this.boundaryChecked) return
    const type = this.buffer[0] & 31
    if ((this.buffer[0] & 0x80) !== 0 || type === 0 || type >= 24) invalid()
    // Prefix NALs belong to the next picture. An AUD makes the boundary explicit.
    if ([6, 7, 8, 9, 14, 15, 16, 17, 18].includes(type)) {
      this.finishUnit()
      this.boundaryChecked = true
    } else if (type === 1 || type === 5) {
      const header = readSlice(this.buffer.subarray(0, this.length))
      if (header) {
        if (header.firstMb === 0) this.finishUnit()
        this.boundaryChecked = true
      } else if (this.length >= 64) invalid()
    } else {
      // Data partitioning, MVC/SVC and auxiliary pictures are not screenrecord AVC.
      if ([2, 3, 4, 19, 20, 21].includes(type)) invalid()
      this.boundaryChecked = true
    }
  }

  private finishNal(): void {
    if (!this.started || this.length === 0) return
    const data = this.buffer.slice(0, this.length)
    const type = data[0] & 31
    if (type === 7) {
      if (data.length < 5) invalid()
      const id = new HeaderBits(data, 4).unsigned()
      if (id === undefined || id > 31) invalid()
      const previous = this.sps.get(id)
      this.storeParameter(previous?.data, data)
      this.sps.set(id, { data, codec: `avc1.${[...data.subarray(1, 4)].map(value => value.toString(16).padStart(2, '0')).join('')}` })
      return
    }
    if (type === 8) {
      const bits = new HeaderBits(data, 1)
      const id = bits.unsigned()
      const spsId = bits.unsigned()
      if (id === undefined || id > 255 || spsId === undefined || spsId > 31) invalid()
      this.storeParameter(this.pps.get(id)?.data, data)
      this.pps.set(id, { data, spsId })
      return
    }
    if (type === 1 || type === 5) {
      const header = readSlice(data)
      if (!header) invalid()
      // A continuation without its first slice is never an independently decodable AU.
      if (header.firstMb !== 0 && !this.hasPicture) { this.synchronized = false; this.discardUnit(); return }
      if (this.hasPicture && (this.picturePps !== header.ppsId || this.pictureKey !== (type === 5))) invalid()
      this.hasPicture = true
      this.pictureKey = type === 5
      this.picturePps = header.ppsId
    }
    if (this.unitBytes + data.length + 4 > MOBILE_H264_LIMITS.maxAccessUnitBytes || this.nals.length >= MOBILE_H264_LIMITS.maxNalsPerAccessUnit) limit()
    this.unitBytes += data.length + 4
    this.nals.push(data)
    if (type === 10 || type === 11) this.finishUnit()
  }

  private storeParameter(previous: Uint8Array | undefined, data: Uint8Array): void {
    this.parameterBytes += data.length - (previous?.length ?? 0)
    if (this.parameterBytes > MOBILE_H264_LIMITS.maxParameterBytes) limit()
    if (!equal(previous, data)) this.synchronized = false
  }

  private discardUnit(): void {
    this.nals = []
    this.unitBytes = 0
    this.hasPicture = false
    this.pictureKey = false
    this.picturePps = -1
  }

  private finishUnit(): void {
    if (!this.hasPicture) return
    const pps = this.pps.get(this.picturePps)
    const sps = pps && this.sps.get(pps.spsId)
    if (!pps || !sps || (!this.pictureKey && !this.synchronized)) { this.discardUnit(); return }
    const key = this.pictureKey
    const nals = [...this.nals]
    if (key) nals.splice(((nals[0]?.[0] ?? 0) & 31) === 9 ? 1 : 0, 0, sps.data, pps.data)
    const length = nals.reduce((total, nal) => total + nal.length + 4, 0)
    if (length > MOBILE_H264_LIMITS.maxAccessUnitBytes) limit()
    const data = new Uint8Array(length)
    let offset = 0
    for (const nal of nals) {
      data.set([0, 0, 0, 1], offset)
      data.set(nal, offset + 4)
      offset += nal.length + 4
    }
    this.synchronized = true
    this.discardUnit()
    this.onAccessUnit({ codec: sps.codec, key, data })
  }
}

import { H264AnnexBParser, MOBILE_H264_LIMITS, type H264AccessUnit } from './mobileH264'

/** Pinned scrcpy 4.1 Streamer/demuxer protocol, after the transport's dummy byte.
 * https://github.com/Genymobile/scrcpy/blob/v4.1/server/src/main/java/com/genymobile/scrcpy/device/Streamer.java
 */
export const MOBILE_SCRCPY_VIDEO_LIMITS = Object.freeze({
  maxConfigBytes: MOBILE_H264_LIMITS.maxParameterBytes,
  maxFrameBytes: MOBILE_H264_LIMITS.maxAccessUnitBytes,
  maxEncodedEdge: 2400
})
export interface MobileScrcpyVideoSession { width: number; height: number }
export interface MobileScrcpyVideoFrame { ptsUs: number; unit: H264AccessUnit }
export type MobileScrcpyVideoEvent =
  | ({ type: 'session' } & MobileScrcpyVideoSession)
  | ({ type: 'frame' } & MobileScrcpyVideoFrame)

const FLAG_CONFIG = 1n << 62n
const FLAG_KEY = 1n << 61n
const PTS_MASK = FLAG_KEY - 1n
function invalid(): never { throw new Error('Invalid mobile framed video stream') }
function limit(): never { throw new Error('Mobile framed video limit exceeded') }

/** CONFIG must actually contain AVC parameters, never a hidden picture. The
 * AVC parser then validates the parameter IDs, NAL headers and reference chain.
 */
function validateConfiguration(bytes: Uint8Array): void {
  let parameters = 0, nals = 0
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue
    const type = bytes[i + 3] & 31
    if (![6, 7, 8, 9].includes(type)) invalid()
    if (type === 7 || type === 8) parameters++
    if (++nals > MOBILE_H264_LIMITS.maxNalsPerAccessUnit) limit()
  }
  if (!parameters) invalid()
}

/** Keeps one bounded packet plus the bounded AVC state, never an array of TCP
 * chunks. Length metadata is the only non-EOF boundary allowed to flush AVC.
 */
export class MobileScrcpyVideoParser {
  private readonly header = new Uint8Array(12)
  private headerLength = 0
  private codecRead = false
  private sessionRead = false
  private configured = false
  private ended = false
  private failed = false
  private payload?: Uint8Array
  private payloadLength = 0
  private packet?: { config: boolean; key: boolean; ptsUs: number }
  private avc?: H264AnnexBParser
  private collected?: H264AccessUnit
  private lastPtsUs = -1

  constructor(private readonly emit: (event: MobileScrcpyVideoEvent) => void) {}

  get hasIncompletePacket(): boolean { return this.headerLength > 0 || this.payload !== undefined }

  push(bytes: Uint8Array): void {
    if (this.failed || this.ended || !(bytes instanceof Uint8Array)) invalid()
    try {
      let offset = 0
      while (offset < bytes.length) {
        if (this.payload) {
          const count = Math.min(bytes.length - offset, this.payload.length - this.payloadLength)
          this.payload.set(bytes.subarray(offset, offset + count), this.payloadLength)
          offset += count; this.payloadLength += count
          if (this.payloadLength === this.payload.length) this.finishPayload()
          continue
        }
        const size = this.codecRead ? 12 : 4
        const count = Math.min(bytes.length - offset, size - this.headerLength)
        this.header.set(bytes.subarray(offset, offset + count), this.headerLength)
        offset += count; this.headerLength += count
        if (this.headerLength === size) {
          this.headerLength = 0
          this.readHeader()
        }
      }
    } catch (error) {
      this.failed = true; this.payload = undefined; this.packet = undefined; this.collected = undefined; this.avc = undefined
      throw error
    }
  }

  end(): void {
    if (this.failed || this.ended) invalid()
    this.ended = true
    if (!this.codecRead || !this.sessionRead || this.hasIncompletePacket) {
      this.payload = undefined; this.avc = undefined
      throw new Error('Incomplete mobile framed video stream')
    }
    this.avc = undefined
  }

  private readHeader(): void {
    const header = new DataView(this.header.buffer)
    if (!this.codecRead) {
      if (header.getUint32(0) !== 0x68323634) throw new Error('Unsupported mobile video codec')
      this.codecRead = true
      return
    }
    if ((this.header[0] & 0x80) !== 0) {
      const flags = header.getUint32(0), width = header.getUint32(4), height = header.getUint32(8)
      if (flags !== 0x80000000 && flags !== 0x80000001) invalid()
      if (!width || !height || width > MOBILE_SCRCPY_VIDEO_LIMITS.maxEncodedEdge || height > MOBILE_SCRCPY_VIDEO_LIMITS.maxEncodedEdge) limit()
      this.sessionRead = true; this.configured = false; this.lastPtsUs = -1; this.collected = undefined
      this.avc = new H264AnnexBParser(unit => {
        // Do not publish the first picture before discovering a second one in
        // the same producer payload. A packet is validated atomically.
        if (this.collected) invalid()
        this.collected = unit
      })
      this.emit({ type: 'session', width, height })
      return
    }
    if (!this.sessionRead) invalid()
    const flags = header.getBigUint64(0), config = (flags & FLAG_CONFIG) !== 0n
    const key = (flags & FLAG_KEY) !== 0n, pts = flags & PTS_MASK
    if (config && flags !== FLAG_CONFIG) invalid()
    if (!config && (!this.configured || pts > BigInt(Number.MAX_SAFE_INTEGER) || Number(pts) <= this.lastPtsUs)) invalid()
    const size = header.getUint32(8)
    if (!size || size > (config ? MOBILE_SCRCPY_VIDEO_LIMITS.maxConfigBytes : MOBILE_SCRCPY_VIDEO_LIMITS.maxFrameBytes)) limit()
    this.packet = { config, key, ptsUs: Number(pts) }
    this.payload = new Uint8Array(size)
    this.payloadLength = 0
  }

  private finishPayload(): void {
    const bytes = this.payload!, packet = this.packet!
    this.payload = undefined; this.packet = undefined; this.payloadLength = 0; this.collected = undefined
    if (packet.config) validateConfiguration(bytes)
    this.avc!.push(bytes)
    // Exact MediaCodec buffer length from the trusted producer, not a TCP read,
    // an idle timeout or a guessed slice boundary. Parameters persist in AVC.
    this.avc!.flush()
    const unit = this.collected as H264AccessUnit | undefined
    this.collected = undefined
    if (packet.config) {
      if (unit) invalid()
      this.configured = true
      return
    }
    if (!unit || unit.key !== packet.key) invalid()
    this.lastPtsUs = packet.ptsUs
    this.emit({ type: 'frame', ptsUs: packet.ptsUs, unit })
  }
}

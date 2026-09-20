import type { Socket } from 'node:net'
import { createMobileScrcpyLink, type MobileScrcpyLink, type MobileScrcpyScope } from './mobileScrcpy'
import { MobileScrcpyVideoParser, type MobileScrcpyVideoSession, type MobileScrcpyVideoFrame } from './mobileScrcpyVideoProtocol'

export const MOBILE_VIDEO_CHANNEL_LIMITS = Object.freeze({ partialTimeoutMs: 5000, maxReadChunkBytes: 256 * 1024 })
export interface MobileAndroidVideoOptions extends MobileScrcpyScope {
  onSession(session: MobileScrcpyVideoSession): void
  onFrame(frame: MobileScrcpyVideoFrame): void
}
export interface MobileAndroidVideoChannel {
  pause(): void
  resume(): void
  alive(): boolean
  close(): Promise<void>
}
const unavailable = (): Error => new Error('Mobile video channel unavailable')

/** Thin protocol consumer; the common link owns all native setup and cleanup.
 * The returned channel is paused until the registry has installed its entry.
 */
class AndroidVideo implements MobileAndroidVideoChannel {
  private link?: MobileScrcpyLink
  private socket?: Socket
  private parser?: MobileScrcpyVideoParser
  private paused = true
  private closed = false
  private installed = false
  private notified = false
  private closing?: Promise<void>
  private partialTimer?: ReturnType<typeof setTimeout>
  private partialDeadline = 0
  private partialRemaining: number = MOBILE_VIDEO_CHANNEL_LIMITS.partialTimeoutMs
  private readonly aborted = (): void => { void this.close() }
  private readonly lost = (): void => { void this.close() }
  private readonly ended = (): void => {
    if (this.closed) return
    try { this.parser?.end() } catch { /* Partial EOF also closes, never flushes. */ }
    void this.close()
  }
  private readonly data = (bytes: Uint8Array): void => {
    if (this.closed) return
    try {
      this.assertActive()
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MOBILE_VIDEO_CHANNEL_LIMITS.maxReadChunkBytes) throw unavailable()
      if (!bytes.byteLength) return
      this.parser!.push(bytes)
      this.partialRemaining = MOBILE_VIDEO_CHANNEL_LIMITS.partialTimeoutMs
      this.armPartialTimer()
    } catch { void this.close() }
  }

  constructor(private readonly options: MobileAndroidVideoOptions) {}

  async open(): Promise<MobileAndroidVideoChannel> {
    this.options.signal.addEventListener('abort', this.aborted, { once: true })
    try {
      if (this.options.signal.aborted) throw unavailable()
      this.options.assertCurrent()
      const link = await createMobileScrcpyLink({ ...this.options, mode: 'video', onClosed: this.lost })
      this.link = link
      if (this.closed || this.options.signal.aborted || !link.alive()) {
        await link.close()
        throw unavailable()
      }
      this.options.assertCurrent()
      this.socket = link.socket
      this.socket.pause()
      this.parser = new MobileScrcpyVideoParser(event => {
        this.assertActive()
        if (event.type === 'session') this.options.onSession({ width: event.width, height: event.height })
        else this.options.onFrame({ ptsUs: event.ptsUs, unit: event.unit })
      })
      this.socket.on('data', this.data)
      this.socket.on('end', this.ended)
      this.socket.on('error', this.lost)
      this.socket.on('close', this.lost)
      this.installed = true
      return this
    } catch (error) {
      await this.close()
      throw error
    }
  }

  alive(): boolean { return !this.closed && !this.options.signal.aborted && !!this.link?.alive() }

  pause(): void {
    if (this.closed || this.paused) return
    this.paused = true
    this.socket?.pause()
    if (this.partialTimer) this.partialRemaining = Math.min(MOBILE_VIDEO_CHANNEL_LIMITS.partialTimeoutMs, Math.max(0, this.partialDeadline - Date.now()))
    clearTimeout(this.partialTimer); this.partialTimer = undefined
  }

  resume(): void {
    if (this.closed || !this.paused) return
    try {
      this.assertActive()
      this.paused = false
      this.armPartialTimer()
      this.socket!.resume()
    } catch { void this.close() }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true; this.paused = true
    clearTimeout(this.partialTimer); this.partialTimer = undefined
    this.options.signal.removeEventListener('abort', this.aborted)
    this.socket?.pause()
    this.parser = undefined
    this.closing = Promise.resolve().then(() => this.link?.close()).then(() => undefined).finally(() => {
      this.socket?.removeListener('data', this.data)
      this.socket?.removeListener('end', this.ended)
      this.socket?.removeListener('error', this.lost)
      this.socket?.removeListener('close', this.lost)
    })
    if (this.installed && !this.notified) {
      this.notified = true
      try { this.options.onClosed?.() } catch { /* Consumer callback cannot block cleanup. */ }
    }
    return this.closing
  }

  private assertActive(): void {
    if (!this.alive()) throw unavailable()
    this.options.assertCurrent()
  }

  private armPartialTimer(): void {
    clearTimeout(this.partialTimer); this.partialTimer = undefined
    if (this.closed || this.paused || !this.parser?.hasIncompletePacket) return
    this.partialDeadline = Date.now() + this.partialRemaining
    this.partialTimer = setTimeout(this.lost, this.partialRemaining)
    this.partialTimer.unref?.()
  }
}

export async function createMobileAndroidVideo(options: MobileAndroidVideoOptions): Promise<MobileAndroidVideoChannel> {
  return new AndroidVideo(options).open()
}

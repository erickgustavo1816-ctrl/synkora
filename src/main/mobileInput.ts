import type { Socket } from 'node:net'
import { MobileCommandError } from './mobileCommands'
import { createMobileScrcpyLink, MOBILE_SCRCPY_LIMITS, type MobileScrcpyLink, type MobileScrcpyScope } from './mobileScrcpy'
import { serializeMobileAndroidTouch, type MobileAndroidInputDimensions, type MobileAndroidTouch } from './mobileInputProtocol'

export type { MobileAndroidInputDimensions, MobileAndroidTouch } from './mobileInputProtocol'
export { MOBILE_SCRCPY_SERVER_VERSION as MOBILE_INPUT_SERVER_VERSION, MOBILE_SCRCPY_SERVER_SHA256 as MOBILE_INPUT_SERVER_SHA256 } from './mobileScrcpy'
export const MOBILE_INPUT_LIMITS = Object.freeze({
  maxServerBytes: MOBILE_SCRCPY_LIMITS.maxServerBytes,
  connectTimeoutMs: MOBILE_SCRCPY_LIMITS.connectTimeoutMs,
  handshakeTimeoutMs: MOBILE_SCRCPY_LIMITS.handshakeTimeoutMs,
  writeTimeoutMs: 1500,
  cancelGraceMs: 150,
  closeTimeoutMs: MOBILE_SCRCPY_LIMITS.closeTimeoutMs,
  maxFlushWaiters: 8
})

export type MobileAndroidInputOptions = MobileScrcpyScope
export interface MobileAndroidInputChannel {
  touch(event: MobileAndroidTouch, dimensions: MobileAndroidInputDimensions): void
  cancel(): void
  /** Transport drain only: scrcpy does not acknowledge native touch delivery. */
  flush(): Promise<void>
  close(): Promise<void>
  alive(): boolean
}

const unavailable = (): MobileCommandError => new MobileCommandError('O controle direto do aparelho foi encerrado. Pare e inicie o emulador para restabelecer a conexão.')
const busy = (): MobileCommandError => new MobileCommandError('Aguarde o gesto atual terminar antes de iniciar outro toque.')
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

function assertAuthority(options: MobileAndroidInputOptions): void {
  if (options.signal.aborted) throw unavailable()
  try { options.assertCurrent() } catch { throw unavailable() }
}

interface PendingPacket { bytes: Buffer; terminal: boolean }
interface ActiveTouch {
  dimensions: MobileAndroidInputDimensions
  last: MobileAndroidTouch
  ending: boolean
  cancelled: boolean
}
interface FlushWaiter { resolve(): void; reject(error: Error): void }

class AndroidInput implements MobileAndroidInputChannel {
  private socket?: Socket
  private link?: MobileScrcpyLink
  private ready = false
  private closing = false
  private closedNotified = false
  private closingPromise?: Promise<void>
  private gesture?: ActiveTouch
  private pendingMove?: PendingPacket
  private pendingTerminal?: PendingPacket
  private writing?: PendingPacket
  private writeDone = false
  private drainDone = true
  private writeTimer?: NodeJS.Timeout
  private readonly waiters = new Set<FlushWaiter>()
  private readonly unexpectedData = (): void => { void this.beginClose(false) }
  private readonly drained = (): void => { this.drainDone = true; this.completeWrite() }

  constructor(private readonly options: MobileAndroidInputOptions) {}

  async start(): Promise<void> {
    try {
      this.link = await createMobileScrcpyLink({ ...this.options, mode: 'input',
        onClosed: () => { void this.beginClose(false) } })
      if (this.closing || !this.link.alive()) { await this.link.close(); throw unavailable() }
      this.socket = this.link.socket
      this.socket.on('data', this.unexpectedData)
      this.socket.on('drain', this.drained)
      this.ready = true
      this.socket.resume()
      if (!this.alive()) throw unavailable()
    } catch (error) {
      await this.beginClose(false)
      throw error
    }
  }

  private current(): boolean {
    try { assertAuthority(this.options); return true } catch { return false }
  }

  alive(): boolean {
    const live = this.ready && !this.closing && !!this.link?.alive() && !!this.socket &&
      !this.socket.destroyed && this.socket.writable && this.current()
    if (!live && this.ready && !this.closing) void this.beginClose(false)
    return live
  }

  touch(event: MobileAndroidTouch, dimensions: MobileAndroidInputDimensions): void {
    if (!this.alive()) throw unavailable()
    const bytes = serializeMobileAndroidTouch(event, dimensions)
    if (event.phase === 'down') {
      if (this.gesture || this.writing || this.pendingTerminal) throw busy()
      this.gesture = { dimensions: { ...dimensions }, last: { ...event }, ending: false, cancelled: false }
      this.send({ bytes, terminal: false })
      return
    }
    const gesture = this.gesture
    if (!gesture) {
      if (event.phase === 'cancel') return
      throw busy()
    }
    if (gesture.dimensions.width !== dimensions.width || gesture.dimensions.height !== dimensions.height) {
      this.cancel()
      throw new MobileCommandError('A tela mudou durante o gesto. Solte o toque e tente novamente no aparelho atualizado.')
    }
    if (event.phase === 'cancel') { this.cancel(); return }
    if (gesture.ending) throw busy()
    gesture.last = { ...event }
    if (event.phase === 'move') {
      this.pendingMove = { bytes, terminal: false }
    } else {
      gesture.ending = true
      // A flick may finish while DOWN is still draining. Preserve its last MOVE:
      // Android scroll containers need ACTION_MOVE to enter their dragging state.
      this.pendingTerminal = { bytes: this.pendingMove ? Buffer.concat([this.pendingMove.bytes, bytes]) : bytes, terminal: true }
      this.pendingMove = undefined
    }
    this.pump()
  }

  cancel(): void {
    if (!this.current()) { void this.beginClose(false); return }
    if (!this.ready || !this.socket || this.socket.destroyed) return
    const gesture = this.gesture
    if (!gesture || gesture.cancelled) return
    // A sent UP cannot be recalled. Do not manufacture a second gesture to cancel it.
    if (this.writing?.terminal) return
    gesture.ending = true
    gesture.cancelled = true
    const point = gesture.last
    this.pendingMove = undefined
    // scrcpy 4.1 only removes pointer zero on UP. Android CANCEL first prevents a tap.
    this.pendingTerminal = { bytes: Buffer.concat([
      serializeMobileAndroidTouch({ ...point, phase: 'cancel' }, gesture.dimensions),
      serializeMobileAndroidTouch({ ...point, phase: 'up' }, gesture.dimensions)
    ]), terminal: true }
    this.pump()
  }

  flush(): Promise<void> {
    if (!this.alive()) return Promise.reject(unavailable())
    return this.waitForDrain()
  }

  private waitForDrain(): Promise<void> {
    if (!this.writing && !this.pendingMove && !this.pendingTerminal) return Promise.resolve()
    if (this.waiters.size >= MOBILE_INPUT_LIMITS.maxFlushWaiters) return Promise.reject(busy())
    return new Promise((resolve, reject) => { this.waiters.add({ resolve, reject }) })
  }

  private pump(): void {
    if (this.writing || !this.ready) return
    if (!this.current()) { void this.beginClose(false); return }
    const packet = this.pendingTerminal ?? this.pendingMove
    if (!packet) {
      for (const waiter of this.waiters) waiter.resolve()
      this.waiters.clear()
      return
    }
    if (packet.terminal) this.pendingTerminal = undefined
    else this.pendingMove = undefined
    this.send(packet)
  }

  private send(packet: PendingPacket): void {
    if (!this.current() || !this.socket || this.socket.destroyed || !this.socket.writable) {
      void this.beginClose(false)
      return
    }
    this.writing = packet
    this.writeDone = false
    this.drainDone = true
    this.writeTimer = setTimeout(() => { void this.beginClose(false) }, MOBILE_INPUT_LIMITS.writeTimeoutMs)
    try {
      const accepted = this.socket.write(packet.bytes, error => {
        if (this.writing !== packet) return
        if (error) { void this.beginClose(false); return }
        this.writeDone = true
        this.completeWrite()
      })
      if (!accepted) this.drainDone = false
    } catch { void this.beginClose(false) }
  }

  private completeWrite(): void {
    if (!this.writing || !this.writeDone || !this.drainDone) return
    clearTimeout(this.writeTimer)
    const terminal = this.writing.terminal
    this.writing = undefined
    if (terminal) this.gesture = undefined
    this.pump()
  }

  close(): Promise<void> { return this.beginClose(true) }

  private beginClose(release: boolean): Promise<void> {
    if (this.closingPromise) return this.closingPromise
    // Promise assignment precedes callbacks, so close/onClosed reentrancy is harmless.
    let finish!: () => void
    this.closingPromise = new Promise(resolve => { finish = resolve })
    if (release && this.current()) this.cancel()
    this.closing = true
    if (!this.closedNotified) {
      this.closedNotified = true
      try { this.options.onClosed?.() } catch { /* structural notification cannot block cleanup */ }
    }
    const timeout = setTimeout(() => { this.socket?.destroy(); finish() }, MOBILE_INPUT_LIMITS.closeTimeoutMs)
    void (async () => {
      if (release && this.current() && this.ready) {
        await Promise.race([this.waitForDrain().catch(() => {}), delay(MOBILE_INPUT_LIMITS.cancelGraceMs)])
      }
      this.ready = false
      clearTimeout(this.writeTimer)
      this.pendingMove = undefined
      this.pendingTerminal = undefined
      this.writing = undefined
      this.gesture = undefined
      for (const waiter of this.waiters) waiter.reject(unavailable())
      this.waiters.clear()
      this.socket?.removeListener('data', this.unexpectedData)
      this.socket?.removeListener('drain', this.drained)
      await this.link?.close()
    })().catch(() => {}).finally(() => { clearTimeout(timeout); finish() })
    return this.closingPromise
  }

}

export async function createMobileAndroidInput(options: MobileAndroidInputOptions): Promise<MobileAndroidInputChannel> {
  const channel = new AndroidInput(options)
  await channel.start()
  return channel
}

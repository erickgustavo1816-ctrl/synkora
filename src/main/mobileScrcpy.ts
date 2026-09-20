import { createHash, randomBytes, randomInt } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import { androidShellArgs, MobileCommandError } from './mobileCommands'
import type { MobileExecutor, MobileOwnedProcess } from './mobileProcess'

export const MOBILE_SCRCPY_SERVER_VERSION = '4.1'
export const MOBILE_SCRCPY_SERVER_SHA256 = 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae'
export const MOBILE_SCRCPY_LIMITS = Object.freeze({
  maxServerBytes: 2 * 1024 * 1024,
  maxHandshakeBytes: 128 * 1024,
  connectTimeoutMs: 5000,
  handshakeTimeoutMs: 1000,
  closeTimeoutMs: 10_000
})

/** Internal runtime lease. No path, command or target is accepted from IPC. */
export interface MobileScrcpyScope {
  executable: string
  serial: string
  serverPath: string
  executor: MobileExecutor
  signal: AbortSignal
  assertCurrent(): void
  verifyTarget(): Promise<void>
  onClosed?(): void
}
export interface MobileScrcpyLinkOptions extends MobileScrcpyScope { mode: 'input' | 'video' }
export interface MobileScrcpyLink {
  /** Paused at handoff. The dummy byte is removed; coalesced video bytes remain. */
  readonly socket: Socket
  alive(): boolean
  close(): Promise<void>
}

const unavailable = (): MobileCommandError => new MobileCommandError('A conexão com o aparelho foi encerrada. Pare e inicie o emulador para restabelecê-la.')
const setupFailed = (): MobileCommandError => new MobileCommandError('Não foi possível preparar a conexão com o aparelho. Pare e inicie o emulador para tentar novamente.')
const integrityFailed = (): MobileCommandError => new MobileCommandError('O componente de controle do aparelho não passou na verificação de integridade. Reinstale o Synkora antes de tentar novamente.')
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

function assertAuthority(options: MobileScrcpyScope): void {
  if (options.signal.aborted) throw unavailable()
  try { options.assertCurrent() } catch { throw unavailable() }
}

async function verifiedServer(options: MobileScrcpyLinkOptions): Promise<string> {
  const validPath = (value: string): boolean => typeof value === 'string' && isAbsolute(value) &&
    value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)
  const match = /^emulator-(\d{4,5})$/u.exec(options.serial)
  const port = match ? Number(match[1]) : 0
  if (!['input', 'video'].includes(options.mode) || !match || port < 5554 || port > 65534 || port % 2 ||
    !validPath(options.executable) || !validPath(options.serverPath)) throw setupFailed()
  assertAuthority(options)
  try {
    const logical = await lstat(options.serverPath)
    if (!logical.isFile() || logical.isSymbolicLink() || logical.size <= 0 || logical.size > MOBILE_SCRCPY_LIMITS.maxServerBytes) throw integrityFailed()
    const path = await realpath(options.serverPath), file = await open(path, 'r')
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size !== logical.size || before.size > MOBILE_SCRCPY_LIMITS.maxServerBytes) throw integrityFailed()
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
      let offset = 0
      for (;;) {
        assertAuthority(options)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
        if (!bytesRead) break
        offset += bytesRead
        if (offset > MOBILE_SCRCPY_LIMITS.maxServerBytes) throw integrityFailed()
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat()
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        hash.digest('hex') !== MOBILE_SCRCPY_SERVER_SHA256) throw integrityFailed()
    } finally { await file.close() }
    assertAuthority(options)
    return path
  } catch (error) {
    if (error instanceof MobileCommandError) throw error
    throw integrityFailed()
  }
}

class ScrcpyLink implements MobileScrcpyLink {
  private readonly scid = randomInt(0, 0x8000_0000).toString(16).padStart(8, '0')
  private readonly jar: string
  private readonly remote = `localabstract:scrcpy_${this.scid}`
  private connection?: Socket
  private child?: MobileOwnedProcess
  private localPort?: number
  private forwardAttempted = false
  private jarAttempted = false
  private ready = false
  private closing = false
  private closingPromise?: Promise<void>
  private readonly abort = (): void => {
    if (this.ready) void this.close()
    else this.connection?.destroy()
  }

  constructor(private readonly options: MobileScrcpyLinkOptions) {
    this.jar = `/data/local/tmp/synkora-${options.mode}-${randomBytes(16).toString('hex')}.jar`
    options.signal.addEventListener('abort', this.abort, { once: true })
  }

  get socket(): Socket {
    if (!this.connection) throw unavailable()
    return this.connection
  }

  private async verify(): Promise<void> {
    assertAuthority(this.options)
    await this.options.verifyTarget()
    assertAuthority(this.options)
  }

  private serverArgs(): string[] {
    const mode = this.options.mode === 'input' ? ['video=false', 'audio=false', 'control=true'] : [
      'video=true', 'audio=false', 'control=false', 'video_codec=h264', 'video_bit_rate=4000000',
      'max_size=2400', 'max_fps=60', 'video_codec_options=max-bframes:int=0', 'downsize_on_error=false',
      'send_stream_meta=true', 'send_frame_meta=true'
    ]
    return androidShellArgs(this.options.serial, ['env', `CLASSPATH=${this.jar}`, 'app_process', '/',
      'com.genymobile.scrcpy.Server', MOBILE_SCRCPY_SERVER_VERSION, `scid=${this.scid}`, ...mode,
      'clipboard_autosync=false', 'power_on=false', 'send_device_meta=false', 'tunnel_forward=true',
      'send_dummy_byte=true', 'cleanup=true', 'log_level=error'])
  }

  async start(serverPath: string): Promise<void> {
    try {
      await this.verify()
      assertAuthority(this.options)
      this.jarAttempted = true
      await this.options.executor.run({ executable: this.options.executable,
        args: ['-s', this.options.serial, 'push', serverPath, this.jar],
        timeoutMs: 10_000, maxBytes: 4096, signal: this.options.signal })
      await this.verify()
      assertAuthority(this.options)
      this.forwardAttempted = true
      const forward = await this.options.executor.run({ executable: this.options.executable,
        args: ['-s', this.options.serial, 'forward', '--no-rebind', 'tcp:0', this.remote],
        timeoutMs: 3000, maxBytes: 64, signal: this.options.signal })
      const text = forward.stdout.toString('ascii').trim()
      if (!/^\d{1,5}$/u.test(text) || Number(text) < 1 || Number(text) > 65535) throw setupFailed()
      this.localPort = Number(text)
      await this.verify()
      assertAuthority(this.options)
      this.child = await this.options.executor.launch({ executable: this.options.executable,
        args: this.serverArgs(), signal: this.options.signal })
      void this.child.exited.then(() => {
        if (this.ready) void this.close()
        else this.connection?.destroy()
      })
      assertAuthority(this.options)
      await this.connect()
      if (!await this.ownedForward(this.options.signal)) throw setupFailed()
      assertAuthority(this.options)
      if (this.closing || !this.child.isAlive() || !this.connection || this.connection.destroyed) throw setupFailed()
      this.ready = true
    } catch (error) {
      await this.close()
      if (error instanceof MobileCommandError) throw error
      throw setupFailed()
    }
  }

  private async connect(): Promise<void> {
    const deadline = Date.now() + MOBILE_SCRCPY_LIMITS.connectTimeoutMs
    while (Date.now() < deadline) {
      await this.verify()
      if (!await this.ownedForward(this.options.signal)) throw setupFailed()
      assertAuthority(this.options)
      if (!this.child?.isAlive() || this.closing) throw setupFailed()
      if (Date.now() >= deadline) break
      const status = await this.connectOnce(Math.min(MOBILE_SCRCPY_LIMITS.handshakeTimeoutMs, deadline - Date.now()))
      if (status === 'ready') return
      if (status === 'invalid') throw setupFailed()
      assertAuthority(this.options)
      await delay(50)
    }
    throw setupFailed()
  }

  private connectOnce(timeoutMs: number): Promise<'ready' | 'retry' | 'invalid'> {
    return new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port: this.localPort! })
      this.connection = socket
      socket.setNoDelay(true)
      let settled = false, accepted = false
      const finish = (status: 'ready' | 'retry' | 'invalid'): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        accepted = status === 'ready'
        if (!accepted) socket.destroy()
        resolve(status)
      }
      const timer = setTimeout(() => finish('retry'), Math.max(1, timeoutMs))
      const handshake = (bytes: Buffer): void => {
        if (settled || !bytes.length) return
        if (bytes[0] !== 0 || bytes.length > MOBILE_SCRCPY_LIMITS.maxHandshakeBytes ||
          (this.options.mode === 'input' && bytes.length !== 1)) { finish('invalid'); return }
        // Pause before detaching: codec/session/frame bytes may share this read.
        socket.pause()
        socket.removeListener('data', handshake)
        if (bytes.length > 1) socket.unshift(bytes.subarray(1))
        finish('ready')
      }
      socket.on('data', handshake)
      const ended = (): void => {
        if (!settled) finish('retry')
        else if (accepted) void this.close()
      }
      socket.on('error', ended)
      socket.on('end', ended)
      socket.on('close', ended)
      if (this.options.signal.aborted) socket.destroy()
    })
  }

  private current(): boolean {
    try { assertAuthority(this.options); return true } catch { return false }
  }

  alive(): boolean {
    const live = this.ready && !this.closing && !!this.child?.isAlive() && !!this.connection &&
      !this.connection.destroyed && this.connection.writable && this.current()
    if (!live && this.ready && !this.closing) void this.close()
    return live
  }

  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise
    let finish!: () => void
    this.closingPromise = new Promise(resolve => { finish = resolve })
    this.closing = true
    this.ready = false
    this.options.signal.removeEventListener('abort', this.abort)
    this.connection?.destroy()
    try { this.options.onClosed?.() } catch { /* structural notification cannot block cleanup */ }
    const cleanupAbort = new AbortController()
    const timeout = setTimeout(() => { cleanupAbort.abort(); finish() }, MOBILE_SCRCPY_LIMITS.closeTimeoutMs)
    void Promise.allSettled([
      this.child?.stop() ?? Promise.resolve(),
      this.removeForward(cleanupAbort.signal),
      this.removeUnstartedJar(cleanupAbort.signal)
    ]).finally(() => { clearTimeout(timeout); cleanupAbort.abort(); finish() })
    return this.closingPromise
  }

  private async removeForward(signal: AbortSignal): Promise<void> {
    if (!this.forwardAttempted || signal.aborted) return
    try {
      const local = await this.ownedForward(signal)
      if (!local || signal.aborted) return
      await this.options.executor.run({ executable: this.options.executable,
        args: ['-s', this.options.serial, 'forward', '--remove', local], timeoutMs: 2000, maxBytes: 1024, signal })
    } catch { /* unavailable or changed mapping is left untouched */ }
  }

  private async ownedForward(signal: AbortSignal): Promise<string | undefined> {
    const { stdout } = await this.options.executor.run({ executable: this.options.executable,
      args: ['-s', this.options.serial, 'forward', '--list'], timeoutMs: 2000, maxBytes: 16 * 1024, signal })
    if (signal.aborted || stdout.length > 16 * 1024) return undefined
    const rows = stdout.toString('ascii').split(/\r?\n/u).filter(Boolean).map(line => line.trim().split(/\s+/u))
    const matches = rows.filter(row => row.length === 3 && row[0] === this.options.serial && row[2] === this.remote &&
      /^tcp:\d{1,5}$/u.test(row[1]) && Number(row[1].slice(4)) >= 1 && Number(row[1].slice(4)) <= 65535 &&
      (this.localPort === undefined || row[1] === `tcp:${this.localPort}`))
    if (matches.length !== 1 || rows.filter(row => row[1] === matches[0][1]).length !== 1) return undefined
    return matches[0][1]
  }

  private async removeUnstartedJar(signal: AbortSignal): Promise<void> {
    if (!this.jarAttempted || this.child || signal.aborted || !this.current()) return
    try {
      await this.verify()
      if (signal.aborted || !this.current()) return
      await this.options.executor.run({ executable: this.options.executable,
        args: androidShellArgs(this.options.serial, ['rm', '-f', '--', this.jar]),
        timeoutMs: 2000, maxBytes: 1024, signal })
    } catch { /* never clean a remote file after target revocation */ }
  }
}

export async function createMobileScrcpyLink(options: MobileScrcpyLinkOptions): Promise<MobileScrcpyLink> {
  const serverPath = await verifiedServer(options)
  const link = new ScrcpyLink(options)
  await link.start(serverPath)
  return link
}

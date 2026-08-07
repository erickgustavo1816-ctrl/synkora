import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const MAX_HEADER_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const MAX_PENDING_REQUESTS = 256

type JsonObject = Record<string, unknown>
type NotificationListener = (params: unknown) => void

interface PendingRequest {
  method: string
  timer: NodeJS.Timeout
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export interface LspLaunchSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface LspInitializeResult {
  capabilities?: Record<string, unknown>
  serverInfo?: { name?: string; version?: string }
}

export class LspRpcError extends Error {
  readonly method: string
  readonly rpcCode: number | string

  constructor(method: string, code: number | string, message?: string) {
    super(message ? `LSP ${method}: ${message}` : `LSP ${method} failed (${String(code)})`)
    this.name = 'LspRpcError'
    this.method = method
    this.rpcCode = code
  }
}

export class LspTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LspTransportError'
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonObject
}

function initializationParams(workspaceRoot: string): JsonObject {
  const rootUri = pathToFileURL(workspaceRoot).href
  return {
    processId: process.pid,
    clientInfo: { name: 'synkora-code-intelligence', version: '1' },
    locale: 'en',
    rootPath: null,
    rootUri,
    initializationOptions: null,
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      workspace: {
        configuration: true,
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: false }
      },
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false },
        documentSymbol: {
          dynamicRegistration: false,
          hierarchicalDocumentSymbolSupport: true
        },
        references: { dynamicRegistration: false },
        definition: { dynamicRegistration: false, linkSupport: true },
        implementation: { dynamicRegistration: false, linkSupport: true },
        hover: { dynamicRegistration: false, contentFormat: ['plaintext'] },
        callHierarchy: { dynamicRegistration: false },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
        publishDiagnostics: {
          relatedInformation: true,
          versionSupport: true,
          codeDescriptionSupport: true,
          dataSupport: true
        }
      },
      window: { workDoneProgress: true }
    },
    trace: 'off',
    workspaceFolders: [{ uri: rootUri, name: basename(workspaceRoot) }]
  }
}

export class LspClient {
  readonly child: ChildProcessWithoutNullStreams
  readonly workspaceRoot: string
  readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  initializeResult: LspInitializeResult | null = null
  stderrBytes = 0

  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notificationListeners = new Map<string, Set<NotificationListener>>()
  private resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
  private transportFailure: Error | null = null
  private exited = false
  private shuttingDown = false
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(child: ChildProcessWithoutNullStreams, workspaceRoot: string) {
    this.child = child
    this.workspaceRoot = workspaceRoot
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })

    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    child.stdout.on('error', () => this.fail(new LspTransportError('language server stdout failed')))
    child.stdin.on('error', () => {
      if (!this.exited && !this.shuttingDown) {
        this.fail(new LspTransportError('language server stdin failed'))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // Count only. Server stderr may contain source paths or source text.
      this.stderrBytes += chunk.length
    })
    child.once('error', () => this.fail(new LspTransportError('language server failed to start')))
    child.once('exit', (code, signal) => {
      this.exited = true
      const error = new LspTransportError(`language server exited (${String(code ?? signal)})`)
      if (!this.shuttingDown) this.fail(error, false)
      else this.rejectPending(error)
      this.resolveExit({ code, signal })
    })
  }

  static async start(
    spec: LspLaunchSpec,
    workspaceRoot: string,
    onCreated?: (client: LspClient) => void
  ): Promise<LspClient> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      // Invalid commands/arguments can throw before Node creates a ChildProcess.
      // Keep transport failures stable and free of platform-specific details.
      throw new LspTransportError('language server failed to start')
    }
    const client = new LspClient(child, workspaceRoot)
    onCreated?.(client)

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (): void => {
        child.off('spawn', onSpawn)
        reject(new LspTransportError('language server failed to start'))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

    try {
      const result = await client.request('initialize', initializationParams(workspaceRoot))
      client.initializeResult = (asObject(result) ?? {}) as LspInitializeResult
      await client.notify('initialized', {})
      return client
    } catch (error) {
      await client.stop()
      throw error
    }
  }

  get isRunning(): boolean {
    return !this.exited && this.transportFailure === null
  }

  onNotification(method: string, listener: NotificationListener): () => void {
    let listeners = this.notificationListeners.get(method)
    if (!listeners) {
      listeners = new Set()
      this.notificationListeners.set(method, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.notificationListeners.delete(method)
    }
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.transportFailure) return Promise.reject(this.transportFailure)
    if (this.exited) return Promise.reject(new LspTransportError('language server is not running'))
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new LspTransportError('language server request queue is full'))
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(String(id))) return
        reject(new LspTransportError(`LSP request ${method} timed out`))
        void this.notify('$/cancelRequest', { id }).catch(() => undefined)
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(String(id), { method, timer, resolve, reject })
      void this.write({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const pending = this.pending.get(String(id))
        if (!pending) return
        this.pending.delete(String(id))
        clearTimeout(timer)
        reject(error instanceof Error ? error : new LspTransportError('LSP write failed'))
      })
    })
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', method, params })
  }

  async stop(): Promise<void> {
    if (this.exited) return
    this.shuttingDown = true
    try {
      await this.request('shutdown', undefined, SHUTDOWN_TIMEOUT_MS)
    } catch {
      // A forced process termination below is the bounded cleanup fallback.
    }
    if (!this.exited) {
      try {
        // TypeScript 7 treats shutdown as RequestType0 (no params field), but
        // its exit notification must carry an explicit null to return code 0.
        await this.notify('exit', null)
      } catch {
        // Some servers close stdin immediately after shutdown.
      }
    }
    try {
      this.child.stdin.end()
    } catch {
      // Already closed.
    }
    if (await this.waitForExit(1_500)) return
    this.forceKill()
    await this.waitForExit(1_500)
  }

  forceKill(): void {
    if (this.exited) return
    this.shuttingDown = true
    try {
      this.child.kill('SIGKILL')
    } catch {
      // The process exited between the guard and kill.
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    })
    const exited = this.exitPromise.then(() => true as const)
    const result = await Promise.race([timeout, exited])
    if (timer) clearTimeout(timer)
    return result
  }

  private consume(chunk: Buffer): void {
    if (this.transportFailure || chunk.length === 0) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    try {
      while (this.buffer.length > 0) {
        const crlfEnd = this.buffer.indexOf('\r\n\r\n')
        const lfEnd = this.buffer.indexOf('\n\n')
        let headerEnd = -1
        let separatorLength = 0
        if (crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd)) {
          headerEnd = crlfEnd
          separatorLength = 4
        } else if (lfEnd >= 0) {
          headerEnd = lfEnd
          separatorLength = 2
        }

        if (headerEnd < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) {
            throw new LspTransportError('LSP header exceeds the allowed size')
          }
          return
        }
        if (headerEnd > MAX_HEADER_BYTES) {
          throw new LspTransportError('LSP header exceeds the allowed size')
        }

        const header = this.buffer.subarray(0, headerEnd).toString('ascii')
        const contentLengthLines = header
          .split(/\r?\n/)
          .filter((line) => /^content-length\s*:/i.test(line))
        if (contentLengthLines.length !== 1) {
          throw new LspTransportError('LSP message has an invalid Content-Length header')
        }
        const value = contentLengthLines[0].slice(contentLengthLines[0].indexOf(':') + 1).trim()
        if (!/^\d+$/.test(value)) {
          throw new LspTransportError('LSP message has an invalid Content-Length value')
        }
        const length = Number(value)
        if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) {
          throw new LspTransportError('LSP message exceeds the allowed size')
        }

        const bodyStart = headerEnd + separatorLength
        const bodyEnd = bodyStart + length
        if (this.buffer.length < bodyEnd) return
        const body = this.buffer.subarray(bodyStart, bodyEnd)
        this.buffer = this.buffer.subarray(bodyEnd)

        let message: unknown
        try {
          message = JSON.parse(body.toString('utf8'))
        } catch {
          throw new LspTransportError('LSP message contains invalid JSON')
        }
        this.dispatch(message)
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new LspTransportError('LSP protocol failed'))
    }
  }

  private dispatch(value: unknown): void {
    const message = asObject(value)
    if (!message) throw new LspTransportError('LSP message has an invalid shape')

    if (typeof message.method === 'string') {
      if (hasOwn(message, 'id')) void this.answerServerRequest(message)
      else this.emitNotification(message.method, message.params)
      return
    }

    if (!hasOwn(message, 'id')) return
    const pending = this.pending.get(String(message.id))
    if (!pending) return
    this.pending.delete(String(message.id))
    clearTimeout(pending.timer)

    const rpcError = asObject(message.error)
    if (rpcError) {
      const code = typeof rpcError.code === 'number' || typeof rpcError.code === 'string'
        ? rpcError.code
        : 'unknown'
      const rpcMessage = typeof rpcError.message === 'string' ? rpcError.message.slice(0, 300) : undefined
      pending.reject(new LspRpcError(pending.method, code, rpcMessage))
    } else {
      pending.resolve(message.result)
    }
  }

  private emitNotification(method: string, params: unknown): void {
    const listeners = this.notificationListeners.get(method)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(params)
      } catch {
        // Notification consumers cannot break the transport.
      }
    }
  }

  private async answerServerRequest(message: JsonObject): Promise<void> {
    const method = String(message.method)
    try {
      let result: unknown
      switch (method) {
        case 'workspace/configuration': {
          const params = asObject(message.params)
          const items = Array.isArray(params?.items) ? params.items : []
          result = items.map(() => ({}))
          break
        }
        case 'workspace/workspaceFolders': {
          const uri = pathToFileURL(this.workspaceRoot).href
          result = [{ uri, name: basename(this.workspaceRoot) }]
          break
        }
        case 'client/registerCapability':
        case 'client/unregisterCapability':
        case 'window/workDoneProgress/create':
        case 'workspace/semanticTokens/refresh':
        case 'workspace/inlayHint/refresh':
        case 'workspace/inlineValue/refresh':
        case 'workspace/codeLens/refresh':
        case 'workspace/diagnostic/refresh':
        case 'workspace/foldingRange/refresh':
        case 'workspace/textDocumentContent/refresh':
          result = null
          break
        case 'workspace/applyEdit':
          result = { applied: false, failureReason: 'Synkora code intelligence is read-only' }
          break
        case 'window/showDocument':
          result = { success: false }
          break
        case 'window/showMessageRequest':
          result = null
          break
        default:
          await this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not supported by Synkora client' }
          })
          return
      }
      await this.write({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      this.fail(error instanceof Error ? error : new LspTransportError('LSP response failed'))
    }
  }

  private write(message: JsonObject): Promise<void> {
    const writeOperation = this.writeChain.then(async () => {
      if (this.transportFailure) throw this.transportFailure
      if (this.exited || this.child.stdin.destroyed) {
        throw new LspTransportError('language server is not writable')
      }
      const body = Buffer.from(JSON.stringify(message), 'utf8')
      if (body.length > MAX_MESSAGE_BYTES) {
        throw new LspTransportError('outgoing LSP message exceeds the allowed size')
      }
      const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
      const payload = Buffer.concat([header, body])
      await new Promise<void>((resolve, reject) => {
        this.child.stdin.write(payload, (error) => {
          if (error) reject(new LspTransportError('failed to write to language server'))
          else resolve()
        })
      })
    })
    this.writeChain = writeOperation.catch(() => undefined)
    return writeOperation
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private fail(error: Error, terminate = true): void {
    if (this.transportFailure) return
    this.transportFailure = error
    this.rejectPending(error)
    if (terminate && !this.exited) this.forceKill()
  }
}

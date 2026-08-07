#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REQUEST_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 5_000
const MAX_HEADER_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_APP_DIR = join(REPO_ROOT, 'release', 'phase2', 'win-unpacked')

class ProbeError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'ProbeError'
    this.exitCode = exitCode
  }
}

function usage() {
  return [
    'Usage: node scripts/probe-packaged-typescript-lsp.mjs [options]',
    '',
    '  --app-dir DIR  Unpacked application directory (default: release/phase2/win-unpacked)',
    '  --output FILE  Write the privacy-safe JSON result to FILE; omit for stdout',
    '  --help         Show this help'
  ].join('\n')
}

function parseArgs(argv) {
  let appDir = DEFAULT_APP_DIR
  let output

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true, appDir, output }
    if (arg === '--app-dir') {
      if (index + 1 >= argv.length) throw new ProbeError('--app-dir requires a value', 2)
      appDir = resolve(argv[++index])
      continue
    }
    if (arg.startsWith('--app-dir=')) {
      appDir = resolve(arg.slice('--app-dir='.length))
      continue
    }
    if (arg === '--output') {
      if (index + 1 >= argv.length) throw new ProbeError('--output requires a value', 2)
      output = argv[++index]
      continue
    }
    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length)
      continue
    }
    throw new ProbeError(`unknown argument: ${arg}`, 2)
  }

  if (!appDir) throw new ProbeError('--app-dir cannot be empty', 2)
  if (output === '') throw new ProbeError('--output cannot be empty', 2)
  return { help: false, appDir, output }
}

function findPackagedTypeScript(appDir) {
  const packageScope = join(
    appDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@typescript'
  )
  if (!existsSync(packageScope)) throw new ProbeError('packaged @typescript runtime directory is missing')

  const candidates = []
  for (const entry of readdirSync(packageScope, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('typescript-')) continue
    const libraryDir = join(packageScope, entry.name, 'lib')
    const executableNames = process.platform === 'win32' ? ['tsc.exe'] : ['tsc', 'tsc.exe']
    const executable = executableNames
      .map((name) => join(libraryDir, name))
      .find((candidate) => existsSync(candidate))
    if (executable) candidates.push({ packageName: entry.name, libraryDir, executable })
  }

  if (candidates.length !== 1) {
    throw new ProbeError(`expected one packaged TypeScript runtime, found ${candidates.length}`)
  }
  return candidates[0]
}

function readVersion(executable, cwd) {
  const result = spawnSync(executable, ['--version'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new ProbeError('packaged TypeScript version command failed')
  }
  const match = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/\bVersion\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)
  if (!match) throw new ProbeError('packaged TypeScript version could not be parsed')
  return match[1]
}

function hasId(message) {
  return Object.prototype.hasOwnProperty.call(message, 'id')
}

class LspClient {
  constructor(child, workspaceFolder) {
    this.child = child
    this.workspaceFolder = workspaceFolder
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.failure = null
    this.stderrBytes = 0
    this.exited = false
    this.exitResult = null

    this.exitPromise = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => {
        this.exited = true
        this.exitResult = { code, signal }
        if (this.pending.size > 0) {
          this.fail(new ProbeError(`language server exited before completing ${this.pending.size} request(s)`))
        }
        resolveExit(this.exitResult)
      })
    })
    child.once('error', () => this.fail(new ProbeError('language server process failed to start')))
    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stdout.once('error', () => this.fail(new ProbeError('language server stdout failed')))
    child.stdin.once('error', () => {
      if (!this.exited) this.fail(new ProbeError('language server stdin failed'))
    })
    child.stderr.on('data', (chunk) => {
      this.stderrBytes += chunk.length
    })
  }

  fail(error) {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  consume(chunk) {
    if (this.failure) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    try {
      while (this.buffer.length > 0) {
        const crlfEnd = this.buffer.indexOf('\r\n\r\n')
        const lfEnd = this.buffer.indexOf('\n\n')
        const useCrlf = crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd)
        const headerEnd = useCrlf ? crlfEnd : lfEnd
        const separatorBytes = useCrlf ? 4 : 2
        if (headerEnd < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) throw new ProbeError('LSP header is too large')
          return
        }
        if (headerEnd > MAX_HEADER_BYTES) throw new ProbeError('LSP header is too large')

        const header = this.buffer.subarray(0, headerEnd).toString('ascii')
        const lengthLine = header.split(/\r?\n/).find((line) => /^content-length\s*:/i.test(line))
        if (!lengthLine) throw new ProbeError('LSP message is missing Content-Length')
        const lengthText = lengthLine.slice(lengthLine.indexOf(':') + 1).trim()
        if (!/^\d+$/.test(lengthText)) throw new ProbeError('LSP Content-Length is invalid')
        const contentLength = Number(lengthText)
        if (!Number.isSafeInteger(contentLength) || contentLength > MAX_MESSAGE_BYTES) {
          throw new ProbeError('LSP message is too large')
        }

        const bodyStart = headerEnd + separatorBytes
        const bodyEnd = bodyStart + contentLength
        if (this.buffer.length < bodyEnd) return
        const body = this.buffer.subarray(bodyStart, bodyEnd)
        this.buffer = this.buffer.subarray(bodyEnd)
        this.dispatch(JSON.parse(body.toString('utf8')))
      }
    } catch {
      this.fail(new ProbeError('invalid LSP response framing'))
    }
  }

  dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ProbeError('LSP message has an invalid shape')
    }
    if (typeof message.method === 'string') {
      if (hasId(message)) void this.answerServerRequest(message)
      return
    }
    if (!hasId(message)) return

    const pending = this.pending.get(String(message.id))
    if (!pending) return
    this.pending.delete(String(message.id))
    clearTimeout(pending.timer)
    if (message.error) {
      const code = typeof message.error.code === 'number' || typeof message.error.code === 'string'
        ? String(message.error.code)
        : 'unknown'
      pending.reject(new ProbeError(`JSON-RPC request ${pending.method} failed (${code})`))
    } else {
      pending.resolve(message.result)
    }
  }

  async answerServerRequest(message) {
    let result
    switch (message.method) {
      case 'workspace/configuration': {
        const items = Array.isArray(message.params?.items) ? message.params.items : []
        result = items.map(() => ({}))
        break
      }
      case 'workspace/workspaceFolders':
        result = [this.workspaceFolder]
        break
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
      case 'window/showMessageRequest':
        result = null
        break
      case 'workspace/applyEdit':
        result = { applied: false, failureReason: 'probe is read-only' }
        break
      case 'window/showDocument':
        result = { success: false }
        break
      default:
        await this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not supported by probe client' }
        })
        return
    }
    await this.write({ jsonrpc: '2.0', id: message.id, result })
  }

  async write(message) {
    if (this.failure) throw this.failure
    if (this.exited || this.child.stdin.destroyed) throw new ProbeError('language server is not writable')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const payload = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
      body
    ])
    await new Promise((resolveWrite, rejectWrite) => {
      this.child.stdin.write(payload, (error) => {
        if (error) rejectWrite(new ProbeError('failed to write to language server'))
        else resolveWrite()
      })
    })
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        rejectRequest(new ProbeError(`JSON-RPC request ${method} timed out`))
      }, timeoutMs)
      this.pending.set(String(id), { method, timer, resolve: resolveRequest, reject: rejectRequest })
      void this.write({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        const pending = this.pending.get(String(id))
        if (!pending) return
        this.pending.delete(String(id))
        clearTimeout(timer)
        rejectRequest(error)
      })
    })
  }

  async notify(method, params) {
    await this.write({ jsonrpc: '2.0', method, params })
  }

  async waitForExit(timeoutMs) {
    if (this.exited) return true
    let timer
    const timedOut = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs)
    })
    const result = await Promise.race([this.exitPromise.then(() => true), timedOut])
    clearTimeout(timer)
    return result
  }

  forceKill() {
    if (this.exited) return
    try {
      this.child.kill('SIGKILL')
    } catch {
      // The process may already have exited.
    }
  }
}

async function runHandshake(executable) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'synkora-phase2-packaged-lsp-'))
  const rootUri = pathToFileURL(`${fixtureDir}/`).href
  const workspaceFolder = { uri: rootUri, name: 'phase2-packaged-lsp-probe' }
  writeFileSync(join(fixtureDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n', 'utf8')
  writeFileSync(join(fixtureDir, 'probe.ts'), 'export const probe: number = 42\n', 'utf8')

  let child
  let client
  try {
    child = spawn(executable, ['--lsp', '--stdio'], {
      cwd: fixtureDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    client = new LspClient(child, workspaceFolder)
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn)
      child.once('error', () => rejectSpawn(new ProbeError('language server process failed to start')))
    })

    const initializeResult = await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'synkora-packaged-lsp-probe', version: '1' },
      locale: 'en',
      rootPath: null,
      rootUri,
      workspaceFolders: [workspaceFolder],
      initializationOptions: null,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { synchronization: { dynamicRegistration: false } }
      }
    })
    if (!initializeResult || typeof initializeResult.capabilities !== 'object') {
      throw new ProbeError('initialize response did not advertise capabilities')
    }
    await client.notify('initialized', {})
    // TypeScript's native RequestType0 implementation rejects an explicit
    // `params: null`; passing undefined omits the field from the JSON payload.
    const shutdownResult = await client.request('shutdown', undefined)
    // The native server accepts the exit notification with an explicit null
    // parameter and then terminates with code zero.
    await client.notify('exit', null)
    child.stdin.end()
    if (!(await client.waitForExit(EXIT_TIMEOUT_MS))) {
      client.forceKill()
      await client.waitForExit(EXIT_TIMEOUT_MS)
      throw new ProbeError('language server did not exit after shutdown')
    }
    if (client.exitResult?.code !== 0) {
      throw new ProbeError(`language server exited unsuccessfully (${String(client.exitResult?.code)})`)
    }

    return {
      transport: 'stdio',
      framing: 'Content-Length',
      initialize_response: true,
      initialized_notification: true,
      shutdown_response: shutdownResult === null,
      exit_notification: true,
      clean_exit: true,
      exit_code: client.exitResult.code,
      stderr_bytes_discarded: client.stderrBytes
    }
  } finally {
    if (client && !client.exited) {
      client.forceKill()
      await client.waitForExit(EXIT_TIMEOUT_MS)
    } else if (child && child.exitCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

async function runProbe(appDir) {
  if (!existsSync(appDir)) throw new ProbeError('unpacked application directory is missing')
  const runtime = findPackagedTypeScript(appDir)
  const libraryNames = readdirSync(runtime.libraryDir)
    .filter((name) => /^lib(?:\..+)?\.d\.ts$/i.test(name))
    .sort((left, right) => left.localeCompare(right))
  if (!libraryNames.some((name) => name.toLowerCase() === 'lib.d.ts')) {
    throw new ProbeError('packaged TypeScript runtime has no lib.d.ts')
  }

  const version = readVersion(runtime.executable, appDir)
  const handshake = await runHandshake(runtime.executable)
  const relativeAppDir = relative(REPO_ROOT, appDir).replaceAll('\\', '/')

  return {
    schema_version: 1,
    probe: 'packaged_typescript_native_lsp',
    created_at_utc: new Date().toISOString(),
    passed: true,
    artifact: relativeAppDir && !relativeAppDir.startsWith('../')
      ? relativeAppDir
      : basename(appDir),
    runtime: {
      platform_package: runtime.packageName,
      executable: basename(runtime.executable),
      version,
      arguments: ['--lsp', '--stdio'],
      declaration_library_count: libraryNames.length,
      has_default_library: true
    },
    handshake
  }
}

function writeOutput(report, output) {
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (!output || output === '-') {
    process.stdout.write(json)
    return
  }
  const destination = resolve(output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, json, 'utf8')
  process.stderr.write('[probe-packaged-typescript-lsp] result written\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  writeOutput(await runProbe(options.appDir), options.output)
}

main().catch((error) => {
  const safe = error instanceof ProbeError ? error : new ProbeError('unexpected packaged LSP probe failure')
  process.stderr.write(`[probe-packaged-typescript-lsp] ${safe.message}\n`)
  process.exitCode = safe.exitCode
})

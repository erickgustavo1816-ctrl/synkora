#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const DEFAULT_ROUNDS = 30
const CONCURRENCY_LEVELS = [1, 8, 32]
const REQUEST_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const MAX_HEADER_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024

class BenchError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'BenchError'
    this.exitCode = exitCode
  }
}

class JsonRpcError extends BenchError {
  constructor(method, code) {
    super(`JSON-RPC request ${method} failed with code ${String(code)}`)
    this.name = 'JsonRpcError'
  }
}

function usage() {
  return [
    'Usage: node scripts/bench-lsp.mjs [--rounds N] [--output FILE]',
    '',
    `  --rounds N     Warm samples per operation (default: ${DEFAULT_ROUNDS})`,
    '  --output FILE  Write JSON to FILE; omit it or use - for stdout',
    '  --help         Show this help'
  ].join('\n')
}

function parseArgs(argv) {
  let rounds = DEFAULT_ROUNDS
  let output

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true, rounds, output }
    if (arg === '--rounds') {
      if (i + 1 >= argv.length) throw new BenchError('--rounds requires a value', 2)
      rounds = Number(argv[++i])
      continue
    }
    if (arg.startsWith('--rounds=')) {
      rounds = Number(arg.slice('--rounds='.length))
      continue
    }
    if (arg === '--output') {
      if (i + 1 >= argv.length) throw new BenchError('--output requires a value', 2)
      output = argv[++i]
      continue
    }
    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length)
      continue
    }
    throw new BenchError(`unknown argument: ${arg}`, 2)
  }

  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10_000) {
    throw new BenchError('--rounds must be an integer from 1 to 10000', 2)
  }
  if (output === '') throw new BenchError('--output cannot be empty', 2)
  return { help: false, rounds, output }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function resolveLocalTypeScript(repoRoot) {
  const require = createRequire(import.meta.url)
  const typescriptPackageFile = require.resolve('typescript/package.json', { paths: [repoRoot] })
  const typescriptPackage = readJson(typescriptPackageFile)
  const platformPackageName = `@typescript/typescript-${process.platform}-${process.arch}`
  let platformPackageFile
  try {
    platformPackageFile = require.resolve(`${platformPackageName}/package.json`, {
      paths: [repoRoot]
    })
  } catch {
    throw new BenchError(`local native TypeScript package is missing for ${process.platform}-${process.arch}`)
  }

  const executableName = process.platform === 'win32' ? 'tsc.exe' : 'tsc'
  const executable = join(dirname(platformPackageFile), 'lib', executableName)
  if (!existsSync(executable)) throw new BenchError('local native TypeScript executable is missing')

  const realRoot = realpathSync(repoRoot)
  const realExecutable = realpathSync(executable)
  if (!isInside(realRoot, realExecutable)) {
    throw new BenchError('resolved TypeScript executable is outside this repository')
  }

  return {
    executable: realExecutable,
    executableName: basename(realExecutable),
    packageVersion: String(typescriptPackage.version ?? 'unknown'),
    platformPackageName
  }
}

function findPosition(text, needle, identifierOffset = 0) {
  const index = text.indexOf(needle)
  if (index < 0) throw new BenchError('benchmark target symbol was not found')
  const absolute = index + identifierOffset
  const before = text.slice(0, absolute)
  const lines = before.split(/\r?\n/)
  return { line: lines.length - 1, character: lines.at(-1).length }
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return {
    min_ms: roundMs(sorted[0]),
    median_ms: roundMs(median(sorted)),
    p95_ms: roundMs(sorted[p95Index]),
    max_ms: roundMs(sorted.at(-1))
  }
}

function resultShape(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

function resultCount(value) {
  if (value === null || value === undefined) return 0
  if (Array.isArray(value)) return value.length
  if (typeof value === 'object' && Array.isArray(value.items)) return value.items.length
  return 1
}

function serializeResult(value) {
  const serialized = JSON.stringify(value)
  return Buffer.from(serialized === undefined ? 'undefined' : serialized, 'utf8')
}

function fingerprintResult(value) {
  const serialized = serializeResult(value)
  return {
    shape: resultShape(value),
    count: resultCount(value),
    bytes: serialized.length,
    sha256: createHash('sha256').update(serialized).digest('hex')
  }
}

function summarizeResultBatch(results) {
  const aggregateHash = createHash('sha256')
  const uniqueHashes = new Set()
  const shapes = {}
  let count = 0
  let bytes = 0

  for (const result of results) {
    const serialized = serializeResult(result)
    const sha256 = createHash('sha256').update(serialized).digest('hex')
    aggregateHash.update(`${serialized.length}:`, 'ascii')
    aggregateHash.update(serialized)
    uniqueHashes.add(sha256)
    count += resultCount(result)
    bytes += serialized.length
    const shape = resultShape(result)
    shapes[shape] = (shapes[shape] ?? 0) + 1
  }

  return {
    response_count: results.length,
    count,
    bytes,
    sha256: aggregateHash.digest('hex'),
    hash_scope: 'ordered_length_prefixed_responses',
    unique_response_hashes: uniqueHashes.size,
    shapes
  }
}

function captureProcess(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  })
  if (result.error || result.status !== 0) return null
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '')
  }
}

function readGitMetadata(repoRoot) {
  const commitResult = captureProcess('git', ['rev-parse', 'HEAD'], repoRoot)
  const commitCandidate = commitResult?.stdout.trim() ?? ''
  const commit = /^[0-9a-f]{40,64}$/i.test(commitCandidate) ? commitCandidate : null
  const statusResult = captureProcess(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    repoRoot
  )

  return {
    commit,
    dirty: statusResult ? statusResult.stdout.trim().length > 0 : null
  }
}

function readCliVersion(command, repoRoot) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase()
    if (normalized === 'CLAUDECODE' || normalized.startsWith('CLAUDE_CODE_')) delete env[key]
  }

  const result = process.platform === 'win32'
    ? captureProcess('cmd.exe', ['/d', '/s', '/c', `${command} --version`], repoRoot, env)
    : captureProcess(command, ['--version'], repoRoot, env)
  if (!result) return null
  const match = `${result.stdout}\n${result.stderr}`.match(
    /\b\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/
  )
  return match?.[0] ?? null
}

function hasId(message) {
  return Object.prototype.hasOwnProperty.call(message, 'id')
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function makeErrorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

class LspClient {
  constructor(child, workspaceFolder) {
    this.child = child
    this.workspaceFolder = workspaceFolder
    this.buffer = Buffer.alloc(0)
    this.nextId = 1
    this.pending = new Map()
    this.protocolFailure = null
    this.stderrBytes = 0
    this.exited = false
    this.exitResult = null

    this.exitPromise = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => {
        this.exited = true
        this.exitResult = { code, signal }
        this.rejectPending(new BenchError(`language server exited with code ${String(code)}`))
        resolveExit(this.exitResult)
      })
    })

    child.once('error', () => {
      this.failProtocol(new BenchError('language server process failed to start'))
    })
    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stdout.once('error', () => {
      this.failProtocol(new BenchError('language server stdout failed'))
    })
    child.stdin.once('error', () => {
      if (!this.exited) this.failProtocol(new BenchError('language server stdin failed'))
    })
    child.stderr.on('data', (chunk) => {
      this.stderrBytes += chunk.length
    })
  }

  failProtocol(error) {
    if (this.protocolFailure) return
    this.protocolFailure = error
    this.rejectPending(error)
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  consume(chunk) {
    if (this.protocolFailure) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    try {
      while (this.buffer.length > 0) {
        const crlfEnd = this.buffer.indexOf('\r\n\r\n')
        const lfEnd = this.buffer.indexOf('\n\n')
        let headerEnd = -1
        let separatorBytes = 0
        if (crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd)) {
          headerEnd = crlfEnd
          separatorBytes = 4
        } else if (lfEnd >= 0) {
          headerEnd = lfEnd
          separatorBytes = 2
        }

        if (headerEnd < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) throw new BenchError('LSP header is too large')
          return
        }
        if (headerEnd > MAX_HEADER_BYTES) throw new BenchError('LSP header is too large')

        const header = this.buffer.subarray(0, headerEnd).toString('ascii')
        const lengthLine = header
          .split(/\r?\n/)
          .find((line) => /^content-length\s*:/i.test(line))
        if (!lengthLine) throw new BenchError('LSP message is missing Content-Length')
        const lengthText = lengthLine.slice(lengthLine.indexOf(':') + 1).trim()
        if (!/^\d+$/.test(lengthText)) throw new BenchError('LSP Content-Length is invalid')
        const contentLength = Number(lengthText)
        if (!Number.isSafeInteger(contentLength) || contentLength > MAX_MESSAGE_BYTES) {
          throw new BenchError('LSP message is too large')
        }

        const bodyStart = headerEnd + separatorBytes
        const bodyEnd = bodyStart + contentLength
        if (this.buffer.length < bodyEnd) return
        const body = this.buffer.subarray(bodyStart, bodyEnd)
        this.buffer = this.buffer.subarray(bodyEnd)

        let message
        try {
          message = JSON.parse(body.toString('utf8'))
        } catch {
          throw new BenchError('LSP message contains invalid JSON')
        }
        this.dispatch(message)
      }
    } catch (error) {
      this.failProtocol(error instanceof BenchError ? error : new BenchError('LSP protocol failed'))
    }
  }

  dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new BenchError('LSP message has an invalid shape')
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
      pending.reject(new JsonRpcError(pending.method, message.error.code ?? 'unknown'))
    } else {
      pending.resolve(message.result)
    }
  }

  async answerServerRequest(message) {
    const id = message.id
    const method = message.method
    try {
      let result
      switch (method) {
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
          result = null
          break
        case 'workspace/applyEdit':
          result = { applied: false, failureReason: 'benchmark is read-only' }
          break
        case 'window/showDocument':
          result = { success: false }
          break
        case 'window/showMessageRequest':
          result = null
          break
        default:
          await this.write(makeErrorResponse(id, -32601, 'Method not supported by benchmark client'))
          return
      }
      await this.write(makeResponse(id, result))
    } catch {
      this.failProtocol(new BenchError('failed to answer a language server request'))
    }
  }

  async write(message) {
    if (this.protocolFailure) throw this.protocolFailure
    if (this.exited || this.child.stdin.destroyed) throw new BenchError('language server is not writable')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
    const payload = Buffer.concat([header, body])

    await new Promise((resolveWrite, rejectWrite) => {
      this.child.stdin.write(payload, (error) => {
        if (error) rejectWrite(new BenchError('failed to write to language server'))
        else resolveWrite()
      })
    })
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.protocolFailure) return Promise.reject(this.protocolFailure)
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        rejectRequest(new BenchError(`JSON-RPC request ${method} timed out`))
      }, timeoutMs)
      this.pending.set(String(id), {
        method,
        timer,
        resolve: resolveRequest,
        reject: rejectRequest
      })
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

  forceKill() {
    if (this.exited) return
    try {
      this.child.kill('SIGKILL')
    } catch {
      // The process already exited between the guard and kill.
    }
  }

  async waitForExit(timeoutMs) {
    if (this.exited) return true
    let timer
    const timedOut = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs)
    })
    const exited = this.exitPromise.then(() => true)
    const result = await Promise.race([exited, timedOut])
    clearTimeout(timer)
    return result
  }

  async shutdown() {
    if (this.exited) return
    try {
      await this.request('shutdown', null, SHUTDOWN_TIMEOUT_MS)
    } catch {
      // A forced kill below is the cleanup fallback.
    }
    if (!this.exited) {
      try {
        await this.notify('exit', null)
      } catch {
        // The process may have closed stdin after shutdown.
      }
    }
    try {
      this.child.stdin.end()
    } catch {
      // Already closed.
    }
    if (await this.waitForExit(2_000)) return
    this.forceKill()
    await this.waitForExit(2_000)
  }
}

function initializeParams(repoRoot, rootUri) {
  return {
    processId: process.pid,
    clientInfo: { name: 'synkora-lsp-benchmark', version: '1' },
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
        hover: { dynamicRegistration: false, contentFormat: ['plaintext'] },
        diagnostic: {
          dynamicRegistration: false,
          relatedDocumentSupport: true
        },
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
    workspaceFolders: [{ uri: rootUri, name: basename(repoRoot) }]
  }
}

function advertisedCapabilities(initializeResult) {
  const capabilities = initializeResult?.capabilities ?? {}
  return {
    document_symbol: Boolean(capabilities.documentSymbolProvider),
    references: Boolean(capabilities.referencesProvider),
    definition: Boolean(capabilities.definitionProvider),
    hover: Boolean(capabilities.hoverProvider),
    pull_diagnostics: Boolean(capabilities.diagnosticProvider)
  }
}

async function benchmarkOperation(client, operation, rounds) {
  const warmupResult = await client.request(operation.method, operation.params)
  const samples = []
  let lastResult = warmupResult

  for (let i = 0; i < rounds; i++) {
    const started = performance.now()
    const result = await client.request(operation.method, operation.params)
    samples.push(performance.now() - started)
    lastResult = result
  }

  const warmupFingerprint = fingerprintResult(warmupResult)
  const lastFingerprint = fingerprintResult(lastResult)

  return {
    method: operation.method,
    rounds,
    warmup_rounds: 1,
    result_shape: lastFingerprint.shape,
    result_summary: {
      ...lastFingerprint,
      hash_algorithm: 'sha256',
      stable_after_warmup: warmupFingerprint.sha256 === lastFingerprint.sha256
    },
    stats: stats(samples)
  }
}

async function benchmarkConcurrentBatch(client, operation, concurrency) {
  let releaseBarrier
  const release = new Promise((resolveRelease) => {
    releaseBarrier = resolveRelease
  })
  const ready = []
  const workers = Array.from({ length: concurrency }, () => {
    let markReady
    ready.push(new Promise((resolveReady) => {
      markReady = resolveReady
    }))

    return (async () => {
      markReady()
      await release
      const started = performance.now()
      const result = await client.request(operation.method, operation.params)
      return { elapsed: performance.now() - started, result }
    })()
  })

  await Promise.all(ready)
  const wallStarted = performance.now()
  releaseBarrier()
  const completed = await Promise.all(workers)
  const wallElapsed = performance.now() - wallStarted

  return {
    concurrency,
    request_count: concurrency,
    wall_clock_ms: roundMs(wallElapsed),
    throughput_requests_per_second: roundMs((concurrency * 1000) / wallElapsed),
    per_request_stats: stats(completed.map(({ elapsed }) => elapsed)),
    result_summary: summarizeResultBatch(completed.map(({ result }) => result))
  }
}

async function benchmarkConcurrency(client, operation) {
  const batches = {}
  for (const concurrency of CONCURRENCY_LEVELS) {
    batches[String(concurrency)] = await benchmarkConcurrentBatch(
      client,
      operation,
      concurrency
    )
  }
  return {
    method: operation.method,
    warmed_server: true,
    batches
  }
}

async function runBenchmark(rounds) {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = realpathSync(resolve(scriptDir, '..'))
  const appPackage = readJson(join(repoRoot, 'package.json'))
  const typescript = resolveLocalTypeScript(repoRoot)
  const git = readGitMetadata(repoRoot)
  const versions = {
    synkora: String(appPackage.version ?? 'unknown'),
    typescript: typescript.packageVersion,
    node: process.version,
    claude: readCliVersion('claude', repoRoot),
    codex: readCliVersion('codex', repoRoot)
  }
  const targetFileRelative = 'src/main/index.ts'
  const targetFile = join(repoRoot, ...targetFileRelative.split('/'))
  const targetText = readFileSync(targetFile, 'utf8')
  const targetUri = pathToFileURL(targetFile).href
  const rootUri = pathToFileURL(`${repoRoot}/`).href
  const position = findPosition(targetText, 'new PtyManager', 'new '.length)
  const workspaceFolder = { uri: rootUri, name: basename(repoRoot) }

  let child
  let client
  let receivedSignal = null
  const totalStarted = performance.now()
  const coldStarted = performance.now()

  const onSignal = (signal) => {
    receivedSignal = signal
    client?.forceKill()
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  const onProcessExit = () => client?.forceKill()
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  process.once('exit', onProcessExit)

  try {
    child = spawn(typescript.executable, ['--lsp', '--stdio'], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    client = new LspClient(child, workspaceFolder)

    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn)
      child.once('error', () => rejectSpawn(new BenchError('language server process failed to start')))
    })

    const initializeRequestStarted = performance.now()
    const initializeResult = await client.request('initialize', initializeParams(repoRoot, rootUri))
    const initializeFinished = performance.now()
    await client.notify('initialized', {})
    await client.notify('textDocument/didOpen', {
      textDocument: {
        uri: targetUri,
        languageId: 'typescript',
        version: 1,
        text: targetText
      }
    })

    const textDocument = { uri: targetUri }
    const operations = [
      {
        key: 'document_symbol',
        method: 'textDocument/documentSymbol',
        params: { textDocument }
      },
      {
        key: 'references',
        method: 'textDocument/references',
        params: { textDocument, position, context: { includeDeclaration: true } }
      },
      {
        key: 'definition',
        method: 'textDocument/definition',
        params: { textDocument, position }
      },
      {
        key: 'hover',
        method: 'textDocument/hover',
        params: { textDocument, position }
      },
      {
        key: 'diagnostic',
        method: 'textDocument/diagnostic',
        params: { textDocument }
      }
    ]

    const measured = {}
    for (const operation of operations) {
      if (receivedSignal) throw new BenchError(`benchmark interrupted by ${receivedSignal}`, 130)
      measured[operation.key] = await benchmarkOperation(client, operation, rounds)
    }

    const concurrent = {}
    for (const operation of operations) {
      if (receivedSignal) throw new BenchError(`benchmark interrupted by ${receivedSignal}`, 130)
      concurrent[operation.key] = await benchmarkConcurrency(client, operation)
    }

    await client.notify('textDocument/didClose', { textDocument })

    return {
      schema_version: 2,
      benchmark: 'typescript_native_lsp',
      created_at_utc: new Date().toISOString(),
      metadata: {
        repository: {
          name: String(appPackage.name ?? 'synkora'),
          version: String(appPackage.version ?? 'unknown')
        },
        git,
        versions,
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch
        },
        server: {
          implementation: 'TypeScript native LSP',
          typescript_version: typescript.packageVersion,
          platform_package: typescript.platformPackageName,
          executable: typescript.executableName,
          arguments: ['--lsp', '--stdio'],
          advertised_capabilities: advertisedCapabilities(initializeResult)
        },
        protocol: {
          transport: 'stdio',
          framing: 'Content-Length',
          position_encoding: 'utf-16'
        },
        target: {
          file: targetFileRelative,
          line_1_based: position.line + 1,
          column_1_based: position.character + 1
        },
        rounds,
        warmup_rounds_per_operation: 1,
        concurrency: {
          levels: CONCURRENCY_LEVELS,
          server_instances: 1,
          server_state: 'warmed_by_sequential_measurements',
          dispatch_barrier: 'Promise.all(ready)',
          completion_barrier: 'Promise.all(requests)',
          timing: 'wall_clock'
        },
        stderr_bytes_discarded: client.stderrBytes
      },
      initialize: {
        cold_spawn_to_response_ms: roundMs(initializeFinished - coldStarted),
        request_to_response_ms: roundMs(initializeFinished - initializeRequestStarted)
      },
      operations: measured,
      concurrency: concurrent,
      total_duration_ms: roundMs(performance.now() - totalStarted)
    }
  } finally {
    if (client) await client.shutdown()
    else if (child && child.exitCode === null) child.kill('SIGKILL')
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('exit', onProcessExit)
  }
}

function writeOutput(report, output) {
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (!output || output === '-') {
    process.stdout.write(json)
    return
  }
  const destination = resolve(process.cwd(), output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, json, 'utf8')
  process.stderr.write('[bench-lsp] benchmark JSON written\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const report = await runBenchmark(options.rounds)
  writeOutput(report, options.output)
}

main().catch((error) => {
  const safe = error instanceof BenchError ? error : new BenchError('unexpected benchmark failure')
  process.stderr.write(`[bench-lsp] ${safe.message}\n`)
  process.exitCode = safe.exitCode
})

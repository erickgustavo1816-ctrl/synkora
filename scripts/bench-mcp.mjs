#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpus, freemem, platform, release, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_SOURCE_URL = new URL('../src/main/mcpServer.ts', import.meta.url)
const CONCURRENCY_LEVELS = [1, 8, 32]
const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_ROUNDS = 20
const WARMUP_ROUNDS = 3
const MAX_CAPTURE_BYTES = 64 * 1024
const EXTERNAL_TIMEOUT_MS = 120_000
const PROFILE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'livre',
    label: 'Agente livre',
    strict: false,
    role: 'livre',
    missionId: undefined,
    catalogExpectedAs: undefined
  }),
  Object.freeze({
    id: 'maestro-pm',
    label: 'Maestro / PM',
    strict: false,
    role: 'maestro',
    missionId: undefined,
    catalogExpectedAs: undefined
  }),
  Object.freeze({
    id: 'orquestrador',
    label: 'Orquestrador de missão',
    strict: false,
    role: 'maestro',
    missionId: 'bench-mission',
    catalogExpectedAs: undefined
  }),
  Object.freeze({
    id: 'estrito',
    label: 'Execução estrita',
    strict: true,
    role: 'dev',
    missionId: undefined,
    catalogExpectedAs: 'livre'
  })
])

function usage() {
  return `Uso: node --experimental-strip-types scripts/bench-mcp.mjs [opções]

Mede o servidor real de src/main/mcpServer.ts por Streamable HTTP stateless.

Opções:
  --rounds <n>       lotes por cenário de concorrência (padrão: ${DEFAULT_ROUNDS})
  --output <arquivo> grava o relatório JSON no caminho informado (padrão: stdout)
  --external         mede readiness MCP stdio real do @playwright/mcp atual
  --help             mostra esta ajuda
`
}

function parseArgs(argv) {
  const options = { rounds: DEFAULT_ROUNDS, output: undefined, external: false, help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--external') {
      options.external = true
      continue
    }

    const [name, inlineValue] = arg.split('=', 2)
    if (name === '--rounds' || name === '--output') {
      const value = inlineValue ?? argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} exige um valor`)
      if (name === '--rounds') {
        const rounds = Number(value)
        if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1_000)
          throw new Error('--rounds deve ser um inteiro entre 1 e 1000')
        options.rounds = rounds
      } else {
        options.output = value
      }
      continue
    }

    throw new Error(`opção desconhecida: ${arg}`)
  }

  return options
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(sorted, percentileValue) {
  if (sorted.length === 1) return sorted[0]
  const rank = (sorted.length - 1) * percentileValue
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower)
}

function stats(values, digits = 3) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    samples: sorted.length,
    min: round(sorted[0], digits),
    median: round(percentile(sorted, 0.5), digits),
    p95: round(percentile(sorted, 0.95), digits),
    max: round(sorted.at(-1), digits),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, digits)
  }
}

function sanitizeLine(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function firstUsefulLine(stdout, stderr = '') {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map(sanitizeLine)
    .filter(Boolean)
  return lines[0] ?? null
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageVersion(name) {
  try {
    const require = createRequire(import.meta.url)
    let entrypoint
    try {
      entrypoint = require.resolve(`${name}/package.json`)
    } catch {
      entrypoint = require.resolve(name)
    }
    let current = dirname(entrypoint)
    // Pacotes MCP v2 não exportam package.json; suba do entrypoint até o
    // manifesto cujo `name` realmente corresponde ao pacote solicitado.
    for (let depth = 0; depth < 8; depth += 1) {
      const packageJsonPath = resolve(current, 'package.json')
      if (existsSync(packageJsonPath)) {
        const manifest = readJson(packageJsonPath)
        if (manifest.name === name && manifest.version) return manifest.version
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return null
  } catch {
    return null
  }
}

function gitMetadata() {
  const run = (args) => {
    const result = spawnSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000
    })
    return result.status === 0 ? sanitizeLine(result.stdout) : null
  }

  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000
  })

  return {
    commit: run(['rev-parse', 'HEAD']),
    branch: run(['branch', '--show-current']),
    dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null
  }
}

function commandVersion(command) {
  const executable = process.platform === 'win32' ? 'cmd.exe' : command
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `${command} --version`]
      : ['--version']
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8_000
  })
  if (result.error || result.status !== 0) return null
  return firstUsefulLine(result.stdout, result.stderr)
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_CAPTURE_BYTES) return current
  return (current + chunk.toString('utf8')).slice(0, MAX_CAPTURE_BYTES)
}

function terminateTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // O processo já terminou.
    }
  }
}

function externalPlaywrightCommand() {
  const require = createRequire(import.meta.url)
  try {
    const packageJsonPath = require.resolve('@playwright/mcp/package.json')
    const cliPath = resolve(dirname(packageJsonPath), 'cli.js')
    if (!existsSync(cliPath)) throw new Error('entrypoint cli.js ausente')
    return {
      command: process.execPath,
      args: [cliPath],
      source: 'runtime-dependency',
      packageVersion: packageVersion('@playwright/mcp')
    }
  } catch {
    if (process.platform === 'win32') {
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', 'npx -y @playwright/mcp@latest'],
        source: 'npx-latest',
        packageVersion: null
      }
    }
    return {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      source: 'npx-latest',
      packageVersion: null
    }
  }
}

function externalPlaywrightMeasurement() {
  const spec = externalPlaywrightCommand()
  return new Promise((resolvePromise) => {
    const startedAt = performance.now()
    const child = spawn(spec.command, spec.args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdoutBuffer = ''
    let stderr = ''
    let settled = false
    let initializeSentAt = performance.now()
    let toolsListSentAt
    let initializeResult
    let initializeMs
    let initializeResponseBytes

    const finish = (result) => {
      if (settled) return
      settled = true
      const finishedAt = performance.now()
      clearTimeout(timer)
      try {
        child.stdin?.end()
      } catch {
        // O servidor já fechou o pipe.
      }
      if (child.exitCode === null) terminateTree(child)
      resolvePromise({
        source: spec.source,
        mode: 'mcp-stdio-readiness',
        packageVersion: spec.packageVersion,
        totalReadyMs: result.ready ? round(finishedAt - startedAt) : null,
        timedOut: result.timedOut ?? false,
        ready: result.ready,
        protocolVersion: initializeResult?.protocolVersion ?? null,
        serverInfo: initializeResult?.serverInfo ?? null,
        initializeMs: initializeMs === undefined ? null : round(initializeMs),
        initializeResponseBytes: initializeResponseBytes ?? null,
        toolsListMs: result.toolsListMs ?? null,
        toolsListResponseBytes: result.toolsListResponseBytes ?? null,
        toolsPayloadBytes: result.toolsPayloadBytes ?? null,
        toolCount: result.toolCount ?? null,
        toolNames: result.toolNames ?? null,
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        error: result.error ?? null
      })
    }

    const send = (message) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`)
    }

    const onMessage = (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // npm pode emitir avisos no stdout antes de entregar o stdio ao MCP.
        return
      }

      if (message.id === 1) {
        if (message.error) {
          finish({ ready: false, error: 'initialize externo devolveu erro JSON-RPC' })
          return
        }
        initializeResult = message.result
        initializeMs = performance.now() - initializeSentAt
        initializeResponseBytes = Buffer.byteLength(line, 'utf8')
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        toolsListSentAt = performance.now()
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        return
      }

      if (message.id === 2) {
        if (message.error) {
          finish({ ready: false, error: 'tools/list externo devolveu erro JSON-RPC' })
          return
        }
        const tools = Array.isArray(message.result?.tools) ? message.result.tools : []
        finish({
          ready: true,
          toolsListMs: round(performance.now() - toolsListSentAt),
          toolsListResponseBytes: Buffer.byteLength(line, 'utf8'),
          toolsPayloadBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
          toolCount: tools.length,
          toolNames: tools.map((tool) => tool.name)
        })
      }
    }

    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8')
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) onMessage(line)
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr = appendCapped(stderr, chunk)
    })
    child.stdin?.once('error', () => {
      finish({ ready: false, error: 'pipe stdin do MCP externo foi encerrado' })
    })
    child.once('error', () => {
      finish({ ready: false, error: 'não foi possível iniciar o MCP externo' })
    })
    child.once('close', (exitCode) => {
      if (!settled)
        finish({
          ready: false,
          error: `MCP externo encerrou antes de tools/list (exit ${exitCode ?? 'desconhecido'})`
        })
    })

    const timer = setTimeout(() => {
      finish({ ready: false, timedOut: true, error: 'timeout no readiness MCP externo' })
    }, EXTERNAL_TIMEOUT_MS)

    initializeSentAt = performance.now()
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'synkora-bench-mcp-external', version: '1.0.0' }
      }
    })
  })
}

function parseSse(text) {
  const messages = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    messages.push(JSON.parse(data))
  }
  return messages
}

function parseRpcBody(text, contentType) {
  if (!text.trim()) return []
  if (contentType.includes('text/event-stream')) return parseSse(text)
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function postRpc(url, token, payload) {
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION
    },
    body: JSON.stringify(payload)
  })
  const body = await response.text()
  const durationMs = performance.now() - startedAt
  const bytes = Buffer.byteLength(body, 'utf8')
  if (!response.ok)
    throw new Error(`MCP HTTP ${response.status}: ${sanitizeLine(body) || 'resposta vazia'}`)

  return {
    durationMs,
    bytes,
    messages: parseRpcBody(body, response.headers.get('content-type') ?? '')
  }
}

function rpcResult(response, id) {
  const message = response.messages.find((candidate) => candidate?.id === id)
  if (!message) throw new Error(`resposta JSON-RPC ${id} ausente`)
  if (message.error)
    throw new Error(`JSON-RPC ${id}: ${sanitizeLine(message.error.message ?? JSON.stringify(message.error))}`)
  return message.result
}

async function runClient(url, token, expectedTools) {
  const clientStartedAt = performance.now()
  const initialize = await postRpc(url, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'synkora-bench-mcp', version: '1.0.0' }
    }
  })
  const initializeResult = rpcResult(initialize, 1)

  await postRpc(url, token, {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  })

  const toolsList = await postRpc(url, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  })
  const toolsResult = rpcResult(toolsList, 2)
  const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : []
  const toolNames = tools.map((tool) => tool.name)
  if (expectedTools && JSON.stringify(toolNames) !== JSON.stringify(expectedTools))
    throw new Error('tools/list mudou de conteúdo ou ordem durante o benchmark')

  return {
    initializeMs: initialize.durationMs,
    initializeBytes: initialize.bytes,
    protocolVersion: initializeResult?.protocolVersion ?? null,
    serverInfo: initializeResult?.serverInfo ?? null,
    toolsListMs: toolsList.durationMs,
    toolsListBytes: toolsList.bytes,
    toolsPayloadBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    toolCount: tools.length,
    toolNames,
    clientTotalMs: performance.now() - clientStartedAt
  }
}

async function warmServer(url, token) {
  let reference
  for (let index = 0; index < WARMUP_ROUNDS; index += 1)
    reference = await runClient(url, token, reference?.toolNames)
  return reference
}

async function runScenario(url, token, concurrency, rounds, expectedTools) {
  const initializeMs = []
  const initializeBytes = []
  const toolsListMs = []
  const toolsListBytes = []
  const toolsPayloadBytes = []
  const clientTotalMs = []
  const batchWallMs = []
  const toolCounts = []

  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const batchStartedAt = performance.now()
    const samples = await Promise.all(
      Array.from({ length: concurrency }, () => runClient(url, token, expectedTools))
    )
    batchWallMs.push(performance.now() - batchStartedAt)
    for (const sample of samples) {
      initializeMs.push(sample.initializeMs)
      initializeBytes.push(sample.initializeBytes)
      toolsListMs.push(sample.toolsListMs)
      toolsListBytes.push(sample.toolsListBytes)
      toolsPayloadBytes.push(sample.toolsPayloadBytes)
      clientTotalMs.push(sample.clientTotalMs)
      toolCounts.push(sample.toolCount)
    }
  }

  return {
    concurrency,
    batches: rounds,
    clients: concurrency * rounds,
    requestsPerClient: 3,
    initializeMs: stats(initializeMs),
    toolsListMs: stats(toolsListMs),
    clientTotalMs: stats(clientTotalMs),
    batchWallMs: stats(batchWallMs),
    initializeResponseBytes: stats(initializeBytes, 0),
    toolsListResponseBytes: stats(toolsListBytes, 0),
    toolsPayloadBytes: stats(toolsPayloadBytes, 0),
    toolCount: {
      min: Math.min(...toolCounts),
      max: Math.max(...toolCounts),
      distinct: [...new Set(toolCounts)].sort((a, b) => a - b)
    }
  }
}

function createProfileRuns() {
  return PROFILE_DEFINITIONS.map((profile) => ({
    ...profile,
    token: randomUUID(),
    identity: Object.freeze({
      paneId: `bench-${profile.id}`,
      projectId: 'bench-project',
      role: profile.role,
      ...(profile.missionId ? { missionId: profile.missionId } : {}),
      cwd: ROOT,
      seatId: 'bench-seat'
    })
  }))
}

function buildApi(profilesByToken) {
  const value = () => 'benchmark-stub'
  const asyncValue = async () => 'benchmark-stub'

  return Object.freeze({
    hub: Object.freeze({
      identityByToken(candidate) {
        return profilesByToken.get(candidate)?.identity
      }
    }),
    boardStatus: value,
    createTasks: value,
    archiveMission: value,
    updateTask: value,
    report: value,
    delegateMany: asyncValue,
    listSkills: value,
    setDefaultSkills: value,
    notifyMaestro: value,
    notifyPane: asyncValue,
    listPanes: value,
    generateImage: asyncValue,
    createMission: value,
    saveProjectPlan: value,
    approveProjectPlan: value,
    startProjectMission: value,
    createPlan: asyncValue,
    concludePlan: value,
    runTask: asyncValue,
    deleteTask: value,
    integrateMission: value,
    releaseVersion: value,
    removeBacklogItem: value,
    registerDirectMission: value,
    listSeats: asyncValue,
    listHelpers: value,
    helperOutput: value,
    helperSend: value,
    helperClose: value
  })
}

function metadata() {
  const rootPackage = readJson(resolve(ROOT, 'package.json'))
  const source = readFileSync(MCP_SOURCE_URL)
  const cpuList = cpus()
  return {
    repository: {
      name: rootPackage.name,
      version: rootPackage.version,
      source: 'src/main/mcpServer.ts',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      git: gitMetadata()
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      release: release(),
      arch: process.arch,
      logicalCpus: cpuList.length,
      cpuModel: cpuList[0]?.model ?? null,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem()
    },
    packages: {
      '@modelcontextprotocol/server': packageVersion('@modelcontextprotocol/server'),
      '@modelcontextprotocol/node': packageVersion('@modelcontextprotocol/node'),
      '@modelcontextprotocol/client': packageVersion('@modelcontextprotocol/client'),
      zod: packageVersion('zod'),
      typescript: packageVersion('typescript'),
      electron: packageVersion('electron')
    },
    localClients: {
      claude: commandVersion('claude'),
      codex: commandVersion('codex')
    }
  }
}

function writeReport(report, output) {
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (!output || output === '-') {
    writeFileSync(process.stdout.fd, json)
    return
  }
  const destination = resolve(process.cwd(), output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, json, 'utf8')
  writeFileSync(process.stderr.fd, `benchmark salvo em ${destination}\n`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    writeFileSync(process.stdout.fd, usage())
    return
  }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 24)
    throw new Error(`Node 24+ é obrigatório para importar TypeScript por type stripping; atual: ${process.version}`)

  // Capture antes do import/benchmark para vincular o resultado exatamente ao
  // fonte e ao ambiente que iniciaram esta execução.
  const benchmarkMetadata = metadata()
  const { startMcpServer } = await import(MCP_SOURCE_URL.href)
  if (typeof startMcpServer !== 'function')
    throw new Error('src/main/mcpServer.ts não exporta startMcpServer')

  const profileRuns = createProfileRuns()
  const profilesByToken = new Map(profileRuns.map((profile) => [profile.token, profile]))
  const handle = await startMcpServer(buildApi(profilesByToken))
  try {
  const url = `http://127.0.0.1:${handle.port}/mcp`
  const measuredProfiles = []
  for (const profile of profileRuns) {
    const warmup = await warmServer(url, profile.token)
    const scenarios = []
    for (const concurrency of CONCURRENCY_LEVELS)
      scenarios.push(
        await runScenario(url, profile.token, concurrency, options.rounds, warmup.toolNames)
      )
    measuredProfiles.push({ profile, warmup, scenarios })
  }

  const measuredById = new Map(measuredProfiles.map((entry) => [entry.profile.id, entry]))
  for (const entry of measuredProfiles) {
    const expectedAs = entry.profile.catalogExpectedAs
    if (!expectedAs) continue
    const reference = measuredById.get(expectedAs)
    if (!reference) throw new Error(`perfil de referência ausente: ${expectedAs}`)
    if (JSON.stringify(entry.warmup.toolNames) !== JSON.stringify(reference.warmup.toolNames))
      throw new Error(
        `catálogo do perfil ${entry.profile.id} divergiu do perfil esperado ${expectedAs}`
      )
  }

  const firstWarmup = measuredProfiles[0].warmup

  const report = {
    schemaVersion: 2,
    benchmark: 'synkora-mcp-streamable-http-stateless',
    generatedAt: new Date().toISOString(),
    options: {
      rounds: options.rounds,
      concurrency: CONCURRENCY_LEVELS,
      profiles: PROFILE_DEFINITIONS.map((profile) => profile.id),
      external: options.external
    },
    metadata: benchmarkMetadata,
    server: {
      host: '127.0.0.1',
      transport: 'Streamable HTTP stateless',
      requestedProtocolVersion: PROTOCOL_VERSION,
      negotiatedProtocolVersion: firstWarmup.protocolVersion,
      serverInfo: firstWarmup.serverInfo
    },
    profiles: measuredProfiles.map(({ profile, warmup, scenarios }) => ({
      id: profile.id,
      label: profile.label,
      identity: {
        role: profile.role,
        mission: Boolean(profile.missionId),
        strict: profile.strict,
        strictScope: profile.strict
          ? 'política do cliente/pane; o catálogo MCP interno deve ser igual ao perfil livre'
          : null
      },
      catalog: {
        expectedAs: profile.catalogExpectedAs ?? null,
        matchesExpected: profile.catalogExpectedAs ? true : null,
        count: warmup.toolCount,
        names: warmup.toolNames,
        responseBytes: warmup.toolsListBytes,
        payloadBytes: warmup.toolsPayloadBytes
      },
      warmup: {
        rounds: WARMUP_ROUNDS,
        finalInitializeMs: round(warmup.initializeMs),
        finalToolsListMs: round(warmup.toolsListMs)
      },
      scenarios
    })),
    external: options.external ? await externalPlaywrightMeasurement() : null
  }

  writeReport(report, options.output)
  } finally {
    await handle.close()
  }
}

try {
  await main()
} catch (error) {
  process.exitCode = 1
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  writeFileSync(process.stderr.fd, `bench-mcp: ${message}\n`)
}

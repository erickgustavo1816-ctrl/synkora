#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { compileCodeIntelligence, ROOT } from './code-intelligence-compile.mjs'

const DEFAULT_ROUNDS = 30
const CONCURRENCY_LEVELS = [1, 8, 32]
const ISOLATION_LEVELS = [2, 4, 8]
const LIFECYCLE_CYCLES = 5
const DEFAULT_OUTPUT = join(ROOT, 'docs', 'benchmarks', '2026-07-31', 'phase2-lsp.json')

const SOURCE = [
  'export interface Greeter {',
  '  greet(name: string): string',
  '}',
  '',
  'export class EnglishGreeter implements Greeter {',
  '  greet(name: string): string {',
  '    return `hello ${name}`',
  '  }',
  '}',
  '',
  'export function welcome(greeter: Greeter, name: string): string {',
  '  return greeter.greet(name)',
  '}',
  '',
  'export function run(): string {',
  '  const greeter: Greeter = new EnglishGreeter()',
  "  return welcome(greeter, 'Synkora')",
  '}',
  '',
  'export const output = run()',
  ''
].join('\n')

function usage() {
  return [
    'Usage: node scripts/bench-code-intelligence.mjs [--rounds N] [--output FILE]',
    '',
    `  --rounds N     Rodadas quentes por operação/cenário (padrão: ${DEFAULT_ROUNDS}, mínimo: 30)`,
    `  --output FILE  JSON de saída (padrão: ${DEFAULT_OUTPUT})`,
    '  --help         Mostra esta ajuda'
  ].join('\n')
}

function parseArgs(argv) {
  let rounds = DEFAULT_ROUNDS
  let output = DEFAULT_OUTPUT
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true, rounds, output }
    if (arg === '--rounds') {
      if (index + 1 >= argv.length) throw new Error('--rounds exige um valor')
      rounds = Number(argv[++index])
      continue
    }
    if (arg.startsWith('--rounds=')) {
      rounds = Number(arg.slice('--rounds='.length))
      continue
    }
    if (arg === '--output') {
      if (index + 1 >= argv.length) throw new Error('--output exige um caminho')
      output = resolve(process.cwd(), argv[++index])
      continue
    }
    if (arg.startsWith('--output=')) {
      output = resolve(process.cwd(), arg.slice('--output='.length))
      continue
    }
    throw new Error(`argumento desconhecido: ${arg}`)
  }
  if (!Number.isSafeInteger(rounds) || rounds < 30 || rounds > 1_000) {
    throw new Error('--rounds deve ser inteiro entre 30 e 1000')
  }
  return { help: false, rounds, output }
}

function round(value) {
  return Math.round(value * 1_000) / 1_000
}

function quantile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
  return {
    samples: sorted.length,
    min_ms: round(sorted[0]),
    median_ms: round(median),
    p95_ms: round(quantile(sorted, 0.95)),
    max_ms: round(sorted.at(-1))
  }
}

function positionOf(text, needle, occurrence = 1) {
  let from = 0
  let index = -1
  for (let count = 0; count < occurrence; count++) {
    index = text.indexOf(needle, from)
    if (index < 0) throw new Error(`posição de benchmark não encontrada: ${needle}`)
    from = index + needle.length
  }
  const before = text.slice(0, index)
  const lines = before.split('\n')
  return { line: lines.length, column: lines.at(-1).length + 1 }
}

function responseSummary(payloads) {
  const hashes = new Set()
  const aggregate = createHash('sha256')
  const totals = new Set()
  let bytes = 0
  let responseHash = null
  for (const payload of payloads) {
    const buffer = Buffer.from(payload, 'utf8')
    const parsed = JSON.parse(payload)
    if (parsed.ok !== true) throw new Error(`borda compacta retornou falha: ${payload}`)
    const hash = createHash('sha256').update(buffer).digest('hex')
    responseHash ??= hash
    hashes.add(hash)
    totals.add(Number(parsed.total ?? 0))
    aggregate.update(`${buffer.length}:`, 'ascii').update(buffer)
    bytes += buffer.length
  }
  return {
    responses: payloads.length,
    bytes,
    unique_hashes: hashes.size,
    response_sha256: responseHash,
    distinct_totals: [...totals].sort((a, b) => a - b),
    aggregate_sha256: aggregate.digest('hex')
  }
}

async function measured(runOperation) {
  const started = performance.now()
  const payload = await runOperation()
  return { elapsed: performance.now() - started, payload }
}

async function sequential(operation, rounds) {
  const samples = []
  const payloads = []
  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    const result = await measured(operation)
    samples.push(result.elapsed)
    payloads.push(result.payload)
  }
  return { latency: stats(samples), result: responseSummary(payloads) }
}

async function concurrent(operationForSession, sessions, concurrency, rounds) {
  const requestSamples = []
  const batchSamples = []
  const payloads = []
  for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
    const started = performance.now()
    const batch = await Promise.all(
      sessions.slice(0, concurrency).map((session) => measured(() => operationForSession(session)))
    )
    batchSamples.push(performance.now() - started)
    for (const result of batch) {
      requestSamples.push(result.elapsed)
      payloads.push(result.payload)
    }
  }
  return {
    concurrency,
    batches: rounds,
    requests: rounds * concurrency,
    request_latency: stats(requestSamples),
    batch_wall: stats(batchSamples),
    result: responseSummary(payloads)
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function writeFixture(root, source, name = 'synkora-code-intelligence-benchmark') {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, private: true }))
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['sample.ts'] })
  )
  await writeFile(join(root, 'sample.ts'), source)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const freeMemoryBytesAtStart = freemem()

  const buildDir = await mkdtemp(join(tmpdir(), 'synkora-code-intelligence-bench-build-'))
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'synkora-code-intelligence-bench-fixture-'))
  let manager
  let isolationManager
  let lifecycleManager
  const sessions = []
  const isolationSessions = []
  let lifecycleSession
  try {
    const typescriptVersion = await compileCodeIntelligence(buildDir, ['manager.ts', 'format.ts'])
    const require = createRequire(import.meta.url)
    const { CodeIntelligenceManager } = require(join(buildDir, 'manager.js'))
    const { formatCodeQueryResult } = require(join(buildDir, 'format.js'))

    await writeFixture(fixtureRoot, SOURCE)

    manager = new CodeIntelligenceManager({ appRoot: ROOT, idleTtlMs: 60_000, maxServers: 8 })
    for (let index = 0; index < Math.max(...CONCURRENCY_LEVELS); index++) {
      sessions.push(manager.openWorkspace(fixtureRoot, `bench-pane-${index}-${randomUUID()}`))
    }

    const welcomeCall = positionOf(SOURCE, "welcome(greeter, 'Synkora')")
    const welcomeDeclaration = positionOf(SOURCE, 'welcome(greeter: Greeter')
    const interfaceDeclaration = positionOf(SOURCE, 'Greeter {')
    const operations = [
      {
        key: 'diagnostics',
        run: (session) => session.diagnostics('sample.ts')
      },
      {
        key: 'definition',
        run: (session) => session.definition('sample.ts', welcomeCall)
      },
      {
        key: 'references',
        run: (session) => session.references('sample.ts', welcomeCall)
      },
      {
        key: 'symbols',
        run: (session) => session.symbols('sample.ts')
      },
      {
        key: 'hover',
        run: (session) => session.hover('sample.ts', welcomeCall)
      },
      {
        key: 'implementations',
        run: (session) => session.implementations('sample.ts', interfaceDeclaration)
      },
      {
        key: 'call_hierarchy',
        run: (session) => session.callHierarchy('sample.ts', welcomeDeclaration)
      }
    ]

    const measuredOperations = {}
    let coldFirstQueryMs = null
    for (const operation of operations) {
      const warmStarted = performance.now()
      const warmResult = await operation.run(sessions[0])
      const warmElapsed = performance.now() - warmStarted
      formatCodeQueryResult(warmResult)
      if (coldFirstQueryMs === null) coldFirstQueryMs = round(warmElapsed)

      const invoke = (session) => operation.run(session).then(formatCodeQueryResult)
      const concurrency = {}
      for (const level of CONCURRENCY_LEVELS) {
        concurrency[String(level)] = await concurrent(invoke, sessions, level, options.rounds)
      }
      measuredOperations[operation.key] = {
        warmup_ms: round(warmElapsed),
        sequential: await sequential(() => invoke(sessions[0]), options.rounds),
        concurrency
      }
    }

    const sameWorktreeMatrix = {}
    for (const level of ISOLATION_LEVELS) {
      const results = await Promise.all(
        sessions.slice(0, level).map((session) => session.symbols('sample.ts'))
      )
      const levelSnapshot = manager.snapshot()
      sameWorktreeMatrix[String(level)] = {
        sessions: level,
        process_count: levelSnapshot.processCount,
        entries: levelSnapshot.entries.length,
        responses_correct: results.every((result) => result.items.some((item) => item.name === 'welcome')),
        passed: levelSnapshot.processCount === 1 && levelSnapshot.entries.length === 1
      }
    }

    const isolationRoot = join(fixtureRoot, 'isolated-worktrees')
    isolationManager = new CodeIntelligenceManager({ appRoot: ROOT, idleTtlMs: 60_000, maxServers: 8 })
    for (let index = 0; index < Math.max(...ISOLATION_LEVELS); index += 1) {
      const root = join(isolationRoot, `worktree-${index}`)
      const marker = `branchMarker${index}`
      await writeFixture(root, `export const ${marker}: number = ${index}\n`, `isolated-${index}`)
      isolationSessions.push({
        marker,
        session: isolationManager.openWorkspace(root, `isolated-pane-${index}-${randomUUID()}`)
      })
    }
    const differentWorktreeMatrix = {}
    for (const level of ISOLATION_LEVELS) {
      const active = isolationSessions.slice(0, level)
      const results = await Promise.all(active.map(({ session }) => session.symbols('sample.ts')))
      const levelSnapshot = isolationManager.snapshot()
      const isolated = results.every((result, index) => {
        const names = result.items.map((item) => item.name)
        return names.includes(active[index].marker) &&
          active.every(({ marker }, markerIndex) => markerIndex === index || !names.includes(marker))
      })
      differentWorktreeMatrix[String(level)] = {
        worktrees: level,
        process_count: levelSnapshot.processCount,
        entries: levelSnapshot.entries.length,
        responses_isolated: isolated,
        passed: isolated && levelSnapshot.processCount === level && levelSnapshot.entries.length === level
      }
    }

    const lifecycleRoot = join(fixtureRoot, 'lifecycle')
    await writeFixture(lifecycleRoot, 'export const lifecycleMarker = 1\n', 'lifecycle')
    lifecycleManager = new CodeIntelligenceManager({
      appRoot: ROOT,
      idleTtlMs: 60_000,
      maxServers: 1,
      restartBaseDelayMs: 0
    })
    lifecycleSession = lifecycleManager.openWorkspace(lifecycleRoot, 'lifecycle-owner')
    await lifecycleSession.symbols('sample.ts')
    const lifecycleResults = []
    for (let cycle = 1; cycle <= LIFECYCLE_CYCLES; cycle += 1) {
      const invalidated = await lifecycleManager.invalidateWorktree(lifecycleRoot)
      const result = await lifecycleSession.symbols('sample.ts')
      const levelSnapshot = lifecycleManager.snapshot()
      lifecycleResults.push({
        cycle,
        invalidated_entries: invalidated,
        process_count: levelSnapshot.processCount,
        response_correct: result.items.some((item) => item.name === 'lifecycleMarker'),
        passed: invalidated === 1 && levelSnapshot.processCount === 1
      })
    }
    const lifecycleSnapshot = lifecycleManager.snapshot()

    const snapshot = manager.snapshot()
    const packageJson = await readJson(join(ROOT, 'package.json'))
    const sequentialP95 = Object.fromEntries(
      Object.entries(measuredOperations).map(([key, value]) => [key, value.sequential.latency.p95_ms])
    )
    const deterministicCompactResponses = Object.fromEntries(
      Object.entries(measuredOperations).map(([key, value]) => {
        const summaries = [
          value.sequential.result,
          ...CONCURRENCY_LEVELS.map((level) => value.concurrency[String(level)].result)
        ]
        return [
          key,
          summaries.every((summary) => summary.unique_hashes === 1)
            && new Set(summaries.map((summary) => summary.response_sha256)).size === 1
        ]
      })
    )
    const report = {
      schema_version: 1,
      benchmark: 'synkora-code-intelligence-manager-compact-edge',
      created_at_utc: new Date().toISOString(),
      metadata: {
        repository: { name: packageJson.name, version: packageJson.version },
        runtime: {
          node: process.version,
          platform: platform(),
          os_release: release(),
          arch: process.arch,
          logical_cpus: cpus().length,
          total_memory_bytes: totalmem(),
          free_memory_bytes_at_start: freeMemoryBytesAtStart
        },
        compiler: {
          typescript: typescriptVersion,
          module: 'Node16',
          module_resolution: 'Node16',
          target: 'ES2022'
        },
        fixture: {
          language: 'typescript',
          file: 'sample.ts',
          strict: true
        },
        rounds: options.rounds,
        warmup_rounds_per_operation: 1,
        concurrency_levels: CONCURRENCY_LEVELS,
        worktree_matrix_levels: ISOLATION_LEVELS,
        lifecycle_cycles: LIFECYCLE_CYCLES,
        measured_boundary: 'CodeIntelligenceManager query + formatCodeQueryResult JSON'
      },
      cold_first_query_ms: coldFirstQueryMs,
      operations: measuredOperations,
      pool: {
        process_count: snapshot.processCount,
        entries: snapshot.entries.length,
        max_owners_on_shared_entry: Math.max(0, ...snapshot.entries.map((entry) => entry.owners)),
        document_bytes: snapshot.documentBytes,
        telemetry: snapshot.telemetry
      },
      acceptance: {
        hot_sequential_p95_target_ms: 100,
        sequential_p95_ms: sequentialP95,
        passed: Object.values(sequentialP95).every((value) => value < 100) &&
          Object.values(sameWorktreeMatrix).every((level) => level.passed) &&
          Object.values(differentWorktreeMatrix).every((level) => level.passed) &&
          lifecycleResults.every((cycle) => cycle.passed && cycle.response_correct),
        shared_server_for_32_sessions: snapshot.processCount === 1 && snapshot.entries.length === 1,
        same_worktree_matrix: sameWorktreeMatrix,
        different_worktree_matrix: differentWorktreeMatrix,
        lifecycle: {
          cycles: lifecycleResults,
          starts: lifecycleSnapshot.telemetry.starts,
          failures: lifecycleSnapshot.telemetry.failures,
          passed: lifecycleResults.every((cycle) => cycle.passed && cycle.response_correct)
        },
        deterministic_compact_responses: deterministicCompactResponses
      },
      privacy: {
        absolute_paths_in_report: false,
        source_text_in_report: false,
        lsp_payloads_in_report: false,
        persisted_values: 'aggregate timings, byte counts, totals and SHA-256 fingerprints only'
      }
    }

    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`benchmark salvo em ${options.output}\n`)
    process.stdout.write(`p95 quente <100ms: ${report.acceptance.passed ? 'sim' : 'não'}\n`)
  } finally {
    for (const session of sessions) session.close()
    for (const { session } of isolationSessions) session.close()
    lifecycleSession?.close()
    if (manager) await manager.close()
    if (isolationManager) await isolationManager.close()
    if (lifecycleManager) await lifecycleManager.close()
    await Promise.all([
      rm(buildDir, { recursive: true, force: true }),
      rm(fixtureRoot, { recursive: true, force: true })
    ])
  }
}

await main()

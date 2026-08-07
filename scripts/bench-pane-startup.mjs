#!/usr/bin/env node

import { spawn as spawnChild, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { performance } from 'perf_hooks'
import { fileURLToPath } from 'url'
import { spawn as spawnPty } from '@lydell/node-pty'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)

if (process.argv[2] === '--pty-batch-worker') await runPtyBatchWorker(process.argv.slice(3))
else await main()

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const result = {
    schemaVersion: 2,
    benchmark: 'pane-startup',
    generatedAt: new Date().toISOString(),
    environment: environmentInfo(),
    definitions: {
      livre: 'PTY + primeiro frame + primeira mensagem, sem MCP externo',
      maestro: 'mesmo caminho de terminal do Maestro/orquestrador, sem MCP externo',
      estrito:
        'readiness MCP stdio externo (initialize + initialized + tools/list) + PTY + primeiro frame + primeira mensagem',
      syntheticFrame: 'marcador determinístico emitido por um shell dentro do PTY; não é uma TUI de agente',
      runtimeTrace: 'eventos reais do app; external_mcp_available é identificado como inferido no próprio log',
      windowsIsolation: 'cada lote roda em subprocesso para conter falha nativa do backend ConPTY DLL'
    },
    runtime: readRuntimeLog(opts.log),
    synthetic: opts.synthetic ? await runSyntheticMatrix(opts) : { skipped: true }
  }

  const json = `${JSON.stringify(result, null, 2)}\n`
  if (opts.output) {
    const outputFile = resolve(ROOT, opts.output)
    mkdirSync(dirname(outputFile), { recursive: true })
    writeFileSync(outputFile, json, 'utf-8')
  }
  writeAndExit(json, 0)
}

async function runPtyBatchWorker(args) {
  const [scenario, rawCount, externalMode] = args
  const count = Number(rawCount)
  if (!['livre', 'maestro', 'estrito'].includes(scenario) || !Number.isInteger(count) || count < 1) {
    writeAndExit('', 2)
    return
  }
  try {
    const batch = await runSyntheticBatch(scenario, count, externalMode)
    writeAndExit(`${JSON.stringify(batch)}\n`, 0)
  } catch {
    writeAndExit(`${JSON.stringify(failedBatch(count, 'worker-error'))}\n`, 0)
  }
}

function writeAndExit(output, code) {
  // ConPTY pode manter um handle nativo sem trabalho pendente. O artefato já
  // está completo; sair no callback impede que a sonda pareça travada.
  if (!output) process.exit(code)
  else process.stdout.write(output, () => process.exit(code))
}

function parseArgs(args) {
  const out = {
    counts: [1, 8, 32],
    externalMode: 'current',
    log:
      process.env.SYNKORA_PERF_LOG ||
      join(process.env.APPDATA || '', 'synkora', 'performance', 'pane-startup.jsonl'),
    output: '',
    synthetic: true,
    warmup: 1
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--counts') out.counts = args[++i].split(',').map(Number).filter((n) => n > 0)
    else if (arg === '--external-mode') out.externalMode = args[++i]
    else if (arg === '--log') out.log = resolve(ROOT, args[++i])
    else if (arg === '--output') out.output = args[++i]
    else if (arg === '--no-synthetic') out.synthetic = false
    else if (arg === '--warmup') out.warmup = Math.max(0, Number(args[++i]) || 0)
    else if (arg === '--help') usage(0)
    else throw new Error(`argumento desconhecido: ${arg}`)
  }
  if (!out.counts.length) throw new Error('--counts precisa de pelo menos um inteiro positivo')
  if (!['current', 'local', 'none'].includes(out.externalMode)) {
    throw new Error('--external-mode deve ser current, local ou none')
  }
  return out
}

function usage(code) {
  process.stdout.write(`Uso: node scripts/bench-pane-startup.mjs [opções]\n\n`)
  process.stdout.write(`  --counts 1,8,32              concorrências (padrão: 1,8,32)\n`)
  process.stdout.write(`  --external-mode current      npx @latest (baseline atual)\n`)
  process.stdout.write(`  --external-mode local        entrypoint local fixado (Fase 1)\n`)
  process.stdout.write(`  --external-mode none         não executar probe externo\n`)
  process.stdout.write(`  --log <arquivo>              pane-startup.jsonl do app\n`)
  process.stdout.write(`  --output <arquivo>           também salvar JSON\n`)
  process.stdout.write(`  --no-synthetic               somente agregar traces reais\n`)
  process.exit(code)
}

async function runSyntheticMatrix(options) {
  const scenarios = ['livre', 'maestro', 'estrito']
  const matrix = {}
  if (options.externalMode !== 'none' && options.warmup > 0) {
    for (let i = 0; i < options.warmup; i++) await runExternalProbe(options.externalMode)
  }
  for (const scenario of scenarios) {
    matrix[scenario] = {}
    for (const count of options.counts) {
      const batch =
        process.platform === 'win32'
          ? await runIsolatedBatch(scenario, count, options.externalMode)
          : await runSyntheticBatch(scenario, count, options.externalMode)
      // Uma falha nativa apaga as amostras do worker. Ainda medimos o MCP
      // externo separadamente, sem fingir que ele compõe um startup de PTY.
      if (scenario === 'estrito' && batch.crashed && options.externalMode !== 'none') {
        batch.externalOnly = await runExternalOnlyBatch(count, options.externalMode)
      }
      matrix[scenario][String(count)] = batch
    }
  }
  return {
    externalMode: options.externalMode,
    framing: options.externalMode === 'none' ? null : 'json-lines',
    counts: options.counts,
    matrix
  }
}

async function runSyntheticBatch(scenario, count, externalMode) {
  const batchStart = performance.now()
  const panes = await Promise.all(
    Array.from({ length: count }, (_, index) => runSyntheticPane(scenario, index, externalMode))
  )
  return summarizeBatch(panes, performance.now() - batchStart)
}

function runIsolatedBatch(scenario, count, externalMode) {
  const started = performance.now()
  return new Promise((resolvePromise) => {
    const child = spawnChild(
      process.execPath,
      [SCRIPT_FILE, '--pty-batch-worker', scenario, String(count), externalMode],
      { cwd: ROOT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    let output = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => void finish('timeout'), 180_000)
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 2 * 1024 * 1024) {
        void finish('oversized-output')
        return
      }
      output = Buffer.concat([output, chunk])
    })
    child.once('error', () => void finish('spawn-error'))
    child.once('exit', (code, signal) => {
      if (settled) return
      if (code === 0) {
        try {
          void finish(undefined, JSON.parse(output.toString('utf-8')), code, signal)
          return
        } catch {
          void finish('invalid-output', undefined, code, signal)
          return
        }
      }
      void finish('native-process-crash', undefined, code, signal)
    })

    async function finish(category, value, exitCode = child.exitCode, signal = child.signalCode) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (category && child.exitCode == null) await terminateProcessTree(child)
      resolvePromise(
        value ?? failedBatch(count, category ?? 'unknown', exitCode, signal, performance.now() - started)
      )
    }
  })
}

async function runExternalOnlyBatch(count, mode) {
  const started = performance.now()
  try {
    const probes = await Promise.all(Array.from({ length: count }, () => runExternalProbe(mode)))
    return {
      available: true,
      clients: probes.length,
      batchMs: round(performance.now() - started),
      spawnToInitializeMs: stats(probes.map((probe) => probe.spawnToInitializeMs)),
      spawnToToolsListMs: stats(probes.map((probe) => probe.spawnToToolsListMs))
    }
  } catch {
    return { available: false, clients: count, errorCategory: 'external-batch-failed' }
  }
}

function failedBatch(count, category, exitCode = null, signal = null, batchMs = null) {
  return {
    panes: count,
    completed: 0,
    failures: count,
    crashed: category === 'native-process-crash',
    errorCategory: category,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    signal: typeof signal === 'string' ? signal : null,
    batchMs: Number.isFinite(batchMs) ? round(batchMs) : null,
    metrics: emptyMetrics()
  }
}

function emptyMetrics() {
  return Object.fromEntries(
    [
      'externalReadyMs',
      'externalSpawnToInitializeMs',
      'externalSpawnToToolsListMs',
      'spawnStartedMs',
      'spawnReturnedMs',
      'spawnDurationMs',
      'firstFrameMs',
      'firstMessageMs',
      'agentFirstOutputMs'
    ].map((key) => [key, null])
  )
}

async function runSyntheticPane(scenario, index, externalMode) {
  const started = performance.now()
  let externalProbe = null
  if (scenario === 'estrito' && externalMode !== 'none') {
    externalProbe = await runExternalProbe(externalMode)
  }
  const spawnStarted = performance.now()
  const ptyResult = await runPtyProbe(index)
  return {
    // Readiness é o instante de tools/list, não o fim do taskkill usado pela
    // sonda para não deixar processos externos vivos.
    externalReadyMs: externalProbe?.requestToToolsListMs ?? null,
    externalSpawnToInitializeMs: externalProbe?.spawnToInitializeMs ?? null,
    externalSpawnToToolsListMs: externalProbe?.spawnToToolsListMs ?? null,
    spawnStartedMs: spawnStarted - started,
    spawnReturnedMs: ptyResult.spawnReturnedAt - started,
    firstFrameMs: ptyResult.firstFrameAt - started,
    firstMessageMs: ptyResult.firstMessageAt - started,
    agentFirstOutputMs: ptyResult.agentOutputAt - started,
    spawnDurationMs: ptyResult.spawnReturnedAt - spawnStarted
  }
}

function runPtyProbe(index) {
  return new Promise((resolvePromise, rejectPromise) => {
    const frameMarker = `__SYNKORA_FRAME_${index}__`
    const outputMarker = `__SYNKORA_AGENT_${index}__`
    const ps =
      `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ` +
      `Write-Output '${frameMarker}'; $null=Read-Host; Write-Output '${outputMarker}'`
    let pty
    let settled = false
    let buffer = ''
    let firstFrameAt = 0
    let firstMessageAt = 0
    let agentOutputAt = 0
    const spawnStartedAt = performance.now()
    try {
      pty = spawnPty(
        process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash',
        process.platform === 'win32'
          ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]
          : ['-lc', `printf '${frameMarker}\\n'; read _; printf '${outputMarker}\\n'`],
        {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: ROOT,
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
          useConptyDll: process.platform === 'win32'
        }
      )
    } catch (error) {
      rejectPromise(error)
      return
    }
    const spawnReturnedAt = performance.now()
    const timer = setTimeout(() => finish(new Error('timeout no probe de PTY')), 20_000)

    pty.onData((data) => {
      // O ConPTY v2 pergunta as capacidades do terminal antes de liberar todo
      // o fluxo. No app o xterm responde automaticamente; a sonda precisa
      // imitar essa resposta para medir o mesmo caminho sem aguardar timeout.
      if (data.includes('\x1b[c')) pty.write('\x1b[?1;2c')
      buffer = (buffer + data).slice(-4096)
      if (!firstFrameAt && buffer.includes(frameMarker)) {
        firstFrameAt = performance.now()
        firstMessageAt = performance.now()
        pty.write('mensagem de benchmark\r')
      }
      if (!agentOutputAt && buffer.includes(outputMarker)) agentOutputAt = performance.now()
    })
    pty.onExit(() => {
      if (!agentOutputAt) {
        finish(new Error('PTY encerrou antes do output esperado'))
        return
      }
      finish()
    })

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        try {
          pty?.kill()
        } catch {
          // processo já encerrou
        }
        rejectPromise(error)
      } else {
        resolvePromise({ spawnStartedAt, spawnReturnedAt, firstFrameAt, firstMessageAt, agentOutputAt })
      }
    }
  })
}

function runExternalProbe(mode) {
  const command = externalCommand(mode)
  const requestedAt = performance.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnChild(command.file, command.args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      // O protocolo passa exclusivamente por stdin/stdout. Stderr é
      // deliberadamente descartado: mensagens do npx/servidor nunca entram no
      // JSON do benchmark, nem mesmo em caso de falha.
      stdio: ['pipe', 'pipe', 'ignore'],
      // No POSIX isto cria um grupo que pode ser encerrado por inteiro. No
      // Windows a limpeza equivalente usa taskkill /T sobre o PID raiz.
      detached: process.platform !== 'win32'
    })
    let settled = false
    let stdout = Buffer.alloc(0)
    let spawnedAt = 0
    let initializeAt = 0
    const pending = new Map()
    const timer = setTimeout(() => {
      void done(new Error(`timeout no MCP externo (${mode})`))
    }, 90_000)
    child.once('spawn', () => {
      spawnedAt = performance.now()
      request(
        1,
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'synkora-pane-startup-bench', version: '1.0.0' }
        },
        (message) => {
          if (message.error || !message.result) {
            void done(new Error(`initialize rejeitado pelo MCP externo (${mode})`))
            return
          }
          initializeAt = performance.now()
          writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          request(2, 'tools/list', {}, (toolsMessage) => {
            if (toolsMessage.error || !Array.isArray(toolsMessage.result?.tools)) {
              void done(new Error(`tools/list inválido no MCP externo (${mode})`))
              return
            }
            const toolsListAt = performance.now()
            void done(undefined, {
              requestToToolsListMs: toolsListAt - requestedAt,
              spawnToInitializeMs: initializeAt - spawnedAt,
              spawnToToolsListMs: toolsListAt - spawnedAt
            })
          })
        }
      )
    })
    child.stdout.on('data', (chunk) => {
      if (settled) return
      stdout = Buffer.concat([stdout, chunk])
      // Resposta MCP nunca deve crescer sem limite. O conteúdo não é salvo e
      // é descartado imediatamente depois de cada frame validado.
      if (stdout.length > 8 * 1024 * 1024) {
        void done(new Error(`resposta MCP externa grande demais (${mode})`))
        return
      }
      parseFrames()
    })
    child.stdin.on('error', () => {
      if (!settled) void done(new Error(`stdin do MCP externo foi encerrado (${mode})`))
    })
    child.stdout.on('error', () => {
      if (!settled) void done(new Error(`stdout do MCP externo falhou (${mode})`))
    })
    child.once('error', (error) => {
      void done(error)
    })
    child.once('exit', (code) => {
      if (!settled) void done(new Error(`MCP externo (${mode}) encerrou antes do readiness (código ${code})`))
    })

    function request(id, method, params, onResponse) {
      pending.set(id, onResponse)
      writeFrame({ jsonrpc: '2.0', id, method, params })
    }

    function writeFrame(message) {
      if (settled || child.stdin.destroyed) return
      const body = Buffer.from(JSON.stringify(message), 'utf-8')
      child.stdin.write(body)
      child.stdin.write('\n')
    }

    function parseFrames() {
      while (!settled) {
        // StdioServerTransport do SDK MCP v1 usa um JSON-RPC por linha. Isso
        // foi conferido no pacote que o `current` resolve e vale igualmente
        // para o entrypoint local; Content-Length é framing de LSP, não deste
        // transporte MCP.
        const lineEnd = stdout.indexOf('\n')
        if (lineEnd < 0) return
        const body = stdout.subarray(0, lineEnd)
        stdout = stdout.subarray(lineEnd + 1)
        if (!body.length) continue
        let message
        try {
          message = JSON.parse(body.toString('utf-8').replace(/\r$/, ''))
        } catch {
          void done(new Error(`JSON-RPC inválido no MCP externo (${mode})`))
          return
        }
        // Só o callback e os campos estruturais necessários sobrevivem a este
        // ponto; payload, catálogo e qualquer output do servidor são soltos.
        if (message?.id != null && pending.has(message.id)) {
          const callback = pending.get(message.id)
          pending.delete(message.id)
          callback(message)
        }
      }
    }

    async function done(error, timings) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pending.clear()
      stdout = Buffer.alloc(0)
      await terminateProcessTree(child)
      if (error) rejectPromise(error)
      else resolvePromise(timings)
    }
  })
}

function externalCommand(mode) {
  if (mode === 'current') {
    if (process.platform === 'win32') {
      // Node 24 não spawna um .cmd diretamente com stdio em pipe (EINVAL).
      // Usar o interpretador nativo mantém stdin/stdout conectados ao servidor
      // final, e o PID do cmd continua sendo a raiz correta para taskkill /T.
      return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npx.cmd -y @playwright/mcp@latest']
      }
    }
    return {
      file: 'npx',
      args: ['-y', '@playwright/mcp@latest']
    }
  }
  const pkg = require.resolve('@playwright/mcp/package.json')
  const cli = join(dirname(pkg), 'cli.js')
  if (!existsSync(cli)) throw new Error(`entrypoint local do @playwright/mcp não encontrado: ${cli}`)
  return { file: process.execPath, args: [cli] }
}

function terminateProcessTree(child) {
  const pid = child.pid
  if (!pid) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolvePromise) => {
      const killer = spawnChild('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('error', () => resolvePromise())
      killer.once('exit', () => resolvePromise())
    })
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // processo já encerrou
    }
  }
  return Promise.resolve()
}

function summarizeBatch(panes, batchMs) {
  const keys = [
    'externalReadyMs',
    'externalSpawnToInitializeMs',
    'externalSpawnToToolsListMs',
    'spawnStartedMs',
    'spawnReturnedMs',
    'spawnDurationMs',
    'firstFrameMs',
    'firstMessageMs',
    'agentFirstOutputMs'
  ]
  const metrics = {}
  for (const key of keys) metrics[key] = stats(panes.map((pane) => pane[key]).filter(Number.isFinite))
  return {
    panes: panes.length,
    completed: panes.length,
    failures: 0,
    crashed: false,
    batchMs: round(batchMs),
    metrics
  }
}

function readRuntimeLog(file) {
  if (!file || !existsSync(file)) return { available: false, fileFound: false, traces: 0, groups: {} }
  const traces = new Map()
  let invalidLines = 0
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      invalidLines++
      continue
    }
    if (record.record !== 'milestone' || !record.traceId || !record.milestone) continue
    const trace = traces.get(record.traceId) || { pane: record.pane, marks: {} }
    trace.pane = trace.pane || record.pane
    trace.marks[record.milestone] = record.elapsedMs
    traces.set(record.traceId, trace)
  }
  const groups = {}
  for (const trace of traces.values()) {
    const mode = trace.pane?.mode || 'desconhecido'
    const group = (groups[mode] ||= { traces: 0, complete: 0, metrics: {} })
    group.traces++
    if (Number.isFinite(trace.marks.terminal_first_frame)) group.complete++
    const pairs = {
      requestToSpawnStartMs: trace.marks.pty_spawn_started,
      requestToSpawnCompleteMs: trace.marks.pty_spawn_completed,
      requestToFirstFrameMs: trace.marks.terminal_first_frame,
      requestToFirstMessageMs: trace.marks.first_message_sent,
      requestToAgentFirstOutputMs: trace.marks.agent_first_output,
      requestToExternalReadyMs: trace.marks.external_mcp_available
    }
    for (const [key, value] of Object.entries(pairs)) {
      if (Number.isFinite(value)) (group.metrics[key] ||= []).push(value)
    }
  }
  for (const group of Object.values(groups)) {
    for (const [key, values] of Object.entries(group.metrics)) group.metrics[key] = stats(values)
  }
  return { available: true, fileFound: true, traces: traces.size, invalidLines, groups }
}

function stats(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted[sorted.length - 1])
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0]
  const index = (sorted.length - 1) * fraction
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function environmentInfo() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
  return {
    synkora: pkg.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    claude: versionOf('claude'),
    codex: versionOf('codex'),
    git: commandText('git', ['rev-parse', '--short', 'HEAD']),
    dirty: Boolean(commandText('git', ['status', '--porcelain']))
  }
}

function versionOf(command) {
  return commandText(command, ['--version']) || 'indisponível'
}

function commandText(command, args) {
  const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command
  const commandArgs =
    process.platform === 'win32' ? ['/d', '/s', '/c', `${command} ${args.join(' ')}`] : args
  const result = spawnSync(executable, commandArgs, {
    cwd: ROOT,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 15_000
  })
  return `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/)[0] || ''
}

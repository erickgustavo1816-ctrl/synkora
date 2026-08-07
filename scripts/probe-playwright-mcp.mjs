#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const options = parseArgs(process.argv.slice(2))
const report = await probe(options)
const json = `${JSON.stringify(report, null, 2)}\n`
if (options.output) {
  const destination = resolve(options.output)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, json, 'utf-8')
}
process.stdout.write(json)

function parseArgs(args) {
  const options = { runtime: '', cli: '', output: '', cwd: process.cwd() }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--runtime') options.runtime = args[++index]
    else if (arg === '--cli') options.cli = args[++index]
    else if (arg === '--output') options.output = args[++index]
    else if (arg === '--cwd') options.cwd = args[++index]
    else if (arg === '--help') {
      process.stdout.write(
        'Uso: node scripts/probe-playwright-mcp.mjs --runtime <exe> --cli <cli.js> [--cwd <dir>] [--output <json>]\n'
      )
      process.exit(0)
    } else throw new Error(`argumento desconhecido: ${String(arg)}`)
  }
  options.runtime = resolve(options.runtime)
  options.cli = resolve(options.cli)
  options.cwd = resolve(options.cwd)
  if (!existsSync(options.runtime) || !existsSync(options.cli)) {
    throw new Error('runtime ou entrypoint Playwright ausente')
  }
  return options
}

async function probe({ runtime, cli, cwd }) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_PATH
  const version = await runVersion(runtime, cli, cwd, env)
  const started = performance.now()
  const child = spawn(runtime, [cli], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = ''
  let stderrBytes = 0
  let initializeAt = 0
  let settled = false
  const pending = new Map()

  const result = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => done(new Error('timeout no handshake Playwright MCP')), 30_000)
    child.stderr.on('data', (chunk) => (stderrBytes += chunk.length))
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      if (Buffer.byteLength(buffer, 'utf-8') > 8 * 1024 * 1024) {
        void done(new Error('resposta Playwright MCP grande demais'))
        return
      }
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          void done(new Error('JSON-RPC inválido no Playwright MCP'))
          return
        }
        const callback = pending.get(message.id)
        if (callback) {
          pending.delete(message.id)
          callback(message)
        }
      }
    })
    child.once('error', () => void done(new Error('falha ao iniciar runtime Electron')))
    child.once('exit', (code) => {
      if (!settled) void done(new Error(`Playwright MCP encerrou antes do readiness (${String(code)})`))
    })
    child.once('spawn', () => {
      request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'synkora-packaged-probe', version: '1.0.0' }
      }, (initialize) => {
        if (initialize.error || !initialize.result) {
          void done(new Error('initialize rejeitado'))
          return
        }
        initializeAt = performance.now()
        write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
        request(2, 'tools/list', {}, (listed) => {
          const tools = listed.result?.tools
          if (listed.error || !Array.isArray(tools)) {
            void done(new Error('tools/list inválido'))
            return
          }
          const names = tools.map((tool) => String(tool.name)).sort()
          const toolsAt = performance.now()
          void done(undefined, {
            schemaVersion: 1,
            runtime: runtime.endsWith('Synkora.exe') ? 'packaged-electron' : 'development-electron',
            version,
            protocolVersion: initialize.result.protocolVersion ?? null,
            serverInfo: initialize.result.serverInfo ?? null,
            toolCount: names.length,
            toolNamesSha256: createHash('sha256').update(JSON.stringify(names)).digest('hex'),
            spawnToInitializeMs: round(initializeAt - started),
            spawnToToolsListMs: round(toolsAt - started),
            stderrBytes
          })
        })
      })
    })

    function request(id, method, params, callback) {
      pending.set(id, callback)
      write({ jsonrpc: '2.0', id, method, params })
    }

    function write(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    async function done(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pending.clear()
      buffer = ''
      child.stdin.end()
      await waitForExit(child, 1_000)
      if (child.exitCode == null) child.kill()
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
  })
  return result
}

function runVersion(runtime, cli, cwd, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(runtime, [cli, '--version'], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error('timeout em --version'))
    }, 15_000)
    child.stdout.on('data', (chunk) => (output += chunk.toString('utf-8')))
    child.stderr.on('data', (chunk) => (output += chunk.toString('utf-8')))
    child.once('error', () => rejectPromise(new Error('falha em --version')))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(output.trim().split(/\r?\n/)[0])
      else rejectPromise(new Error(`--version encerrou com ${String(code)}`))
    })
  })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve()
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

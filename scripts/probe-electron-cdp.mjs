/**
 * SONDA F5-F4 (CHECK 7c, implementação): Electron REAL com --remote-debugging-port
 * atacado via CDP pelo MESMO caminho que o pane de QA vai usar.
 *
 * O que esta sonda PROVA (cada R imprime veredito):
 *  R1  spawn via SHELL (o caminho exato do qaRuntime: shell:true + pipes) de um
 *      app Electron com --remote-debugging-port=<porta reservada> → a linha
 *      "DevTools listening on ws://..." chega no NOSSO pipe (stderr atravessa a
 *      cadeia shell→electron) e a porta anunciada é a reservada.
 *  R2  GET http://127.0.0.1:<porta>/json/version responde (endpoint HTTP que o
 *      --cdp-endpoint do @playwright/mcp usa para descobrir o browser ws).
 *  R3  playwright-core connectOverCDP → página real → window.probeApi.ping()
 *      responde 'pong-from-preload' — PRELOAD REAL via contextBridge, a razão
 *      de ser da Fase 4 (o duplo de bridge morre).
 *  R4  browser.close() do lado playwright NÃO mata o app (connectOverCDP só
 *      desconecta) — por isso o fim de rodada do QA precisa de
 *      runtime_control {action:"stop"}; a ceifa (taskkill /T /F na raiz shell)
 *      mata a árvore.
 *
 * FATOS ESTÁTICOS conferidos no electron-vite instalado (dist/chunks/lib-*.js,
 * função startElectron — mesma major dos produtos):
 *  - env REMOTE_DEBUGGING_PORT → args.push('--remote-debugging-port=...') SÓ em
 *    NODE_ENV_ELECTRON_VITE === 'development' (ou seja: script `dev`).
 *  - args após `--` do CLI viram env ELECTRON_CLI_ARGS (JSON) e são anexados
 *    SEMPRE (dev E preview) — `npm run dev -- -- --remote-debugging-port=N`.
 *  - o filho electron nasce com stdio:'inherit' → a linha DevTools flui até o
 *    pipe do qaRuntime.
 *
 * Rodar: node scripts/probe-electron-cdp.mjs
 */
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const electronExe = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')

function findFreePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(undefined))
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      const port = typeof addr === 'object' && addr ? addr.port : undefined
      probe.close(() => resolve(port))
    })
  })
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

const dir = mkdtempSync(join(tmpdir(), 'synkora-cdp-probe-'))
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({ name: 'cdp-probe-app', main: 'main.js' })
)
writeFileSync(
  join(dir, 'preload.js'),
  `const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('probeApi', { ping: () => 'pong-from-preload' })
`
)
writeFileSync(
  join(dir, 'index.html'),
  '<!doctype html><title>cdp-probe</title><body>probe</body>'
)
writeFileSync(
  join(dir, 'main.js'),
  `const { app, BrowserWindow } = require('electron')
const { join } = require('path')
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, 'preload.js') }
  })
  win.loadFile('index.html')
})
`
)

const port = await findFreePort()
if (!port) throw new Error('sem porta livre')

// R1 — o caminho do qaRuntime: linha de comando via shell, pipes, tee acumulado
const commandLine = `"${electronExe}" "${dir}" --remote-debugging-port=${port}`
const proc = spawn(commandLine, {
  shell: true,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let cleanTail = ''
const DEVTOOLS_RE = /DevTools listening on (ws:\/\/[^\s]+)/i
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`R1 FALHOU: sem linha DevTools em 30s — tail: ${cleanTail.slice(-400)}`)), 30_000)
  const onChunk = (chunk) => {
    cleanTail = (cleanTail + String(chunk).replace(/\[[0-9;]*[A-Za-z]/g, '')).slice(-8000)
    const m = DEVTOOLS_RE.exec(cleanTail)
    if (m) {
      clearTimeout(timer)
      resolve(m[1])
    }
  }
  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)
  proc.on('exit', (code) => reject(new Error(`R1 FALHOU: electron saiu (exit ${code}) antes da linha DevTools`)))
})
const announced = Number(new URL(wsUrl).port)
console.log(`R1 OK — DevTools listening chegou pelo pipe do shell: ${wsUrl}`)
if (announced !== port) throw new Error(`R1b FALHOU: porta anunciada ${announced} != reservada ${port}`)
console.log(`R1b OK — porta anunciada == reservada (${port})`)

// R2 — endpoint HTTP de descoberta (o que o --cdp-endpoint consome)
const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`)
if (!version.webSocketDebuggerUrl) throw new Error('R2 FALHOU: /json/version sem webSocketDebuggerUrl')
console.log(`R2 OK — /json/version: ${version.Browser} · ws ${version.webSocketDebuggerUrl.slice(0, 60)}…`)

// R3 — playwright-core connectOverCDP + PRELOAD REAL
const { chromium } = require('playwright-core')
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const contexts = browser.contexts()
if (contexts.length === 0) throw new Error('R3 FALHOU: nenhum contexto via CDP')
let page
for (let i = 0; i < 50 && !page; i++) {
  page = contexts.flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'))
  if (!page) await new Promise((r) => setTimeout(r, 200))
}
if (!page) throw new Error('R3 FALHOU: página do app não apareceu via CDP')
const pong = await page.evaluate(() => window.probeApi?.ping?.())
if (pong !== 'pong-from-preload') throw new Error(`R3 FALHOU: preload não respondeu (${pong})`)
console.log('R3 OK — window.probeApi.ping() === "pong-from-preload" (PRELOAD REAL via CDP)')

// R4 — close() desconecta sem matar; a ceifa mata a árvore
await browser.close()
await new Promise((r) => setTimeout(r, 800))
const aliveAfterClose = proc.exitCode === null
console.log(
  aliveAfterClose
    ? 'R4a OK — browser.close() só desconectou: o app segue vivo (fim de rodada EXIGE runtime_control stop)'
    : 'R4a INESPERADO — o app morreu com o close() do playwright'
)
await new Promise((resolve) => {
  execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => resolve())
})
await new Promise((r) => setTimeout(r, 1000))
const deadAfterKill = proc.exitCode !== null
console.log(deadAfterKill ? 'R4b OK — taskkill /T /F na raiz shell matou a árvore' : 'R4b FALHOU — árvore sobreviveu ao taskkill')

rmSync(dir, { recursive: true, force: true })
if (!aliveAfterClose || !deadAfterKill) process.exitCode = 1
console.log('probe-electron-cdp: fim')

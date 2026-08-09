/**
 * SONDA F5-F4 (parte 2): a cadeia REAL de produto electron-vite —
 *   npm run dev (shell) → electron-vite dev → electron
 * com a ENTREGA EXATA do qaRuntime em modo CDP:
 *   env REMOTE_DEBUGGING_PORT=<porta> + sufixo ` -- -- --remote-debugging-port=<porta>`.
 *
 * Prova que: (V1) o npm/cmd não come o `--` duplo e o electron-vite repassa;
 * (V2) a linha "DevTools listening" atravessa as TRÊS camadas de processo até
 * o pipe; (V3) a porta anunciada é a pedida (env e argv com o MESMO valor —
 * flag duplicada é inofensiva); (V4) connectOverCDP enxerga a janela real.
 *
 * Fixture: app electron-vite mínimo em tmpdir com node_modules por JUNCTION
 * para o node_modules deste worktree (fora do repo — nada de junction DENTRO
 * de worktree, a lição de 2026-08). Rodar: node scripts/probe-electron-vite-cdp.mjs
 */
import { spawn, execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repoNodeModules = join(process.cwd(), 'node_modules')

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

const dir = mkdtempSync(join(tmpdir(), 'synkora-evite-cdp-'))
mkdirSync(join(dir, 'src', 'main'), { recursive: true })
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({
    name: 'evite-cdp-probe',
    main: 'out/main/index.js',
    scripts: { dev: 'electron-vite dev' }
  })
)
writeFileSync(
  join(dir, 'electron.vite.config.mjs'),
  `export default {
  main: { build: { rollupOptions: { input: 'src/main/index.js' } } },
  preload: undefined,
  renderer: undefined
}
`
)
writeFileSync(
  join(dir, 'src', 'main', 'index.js'),
  `import { app, BrowserWindow } from 'electron'
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false })
  win.loadURL('about:blank')
})
`
)
// JUNCTION (não symlink — junction dispensa privilégio) para o node_modules
// do worktree: o npm resolve o .bin e o electron-vite resolve o electron.
execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(dir, 'node_modules'), repoNodeModules], {
  stdio: 'ignore'
})

const port = await findFreePort()
if (!port) throw new Error('sem porta livre')

// A LINHA DE COMANDO EXATA do qaRuntime em modo CDP (cdpInvocation electron-vite)
const commandLine = `npm run dev -- -- --remote-debugging-port=${port}`
const proc = spawn(commandLine, {
  cwd: dir,
  env: { ...process.env, REMOTE_DEBUGGING_PORT: String(port) },
  shell: true,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
let cleanTail = ''
const DEVTOOLS_RE = /DevTools listening on (ws:\/\/[^\s'"]+\/devtools\/browser\/[0-9a-fA-F-]+)/
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`V2 FALHOU: sem linha DevTools em 90s — tail: ${cleanTail.slice(-600)}`)),
    90_000
  )
  const onChunk = (chunk) => {
    cleanTail = (cleanTail + String(chunk).replace(/\[[0-9;]*[A-Za-z]/g, '')).slice(-8000)
    const m = DEVTOOLS_RE.exec(cleanTail)
    if (m) {
      clearTimeout(timer)
      resolve(m[1])
    }
  }
  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)
  proc.on('exit', (code) =>
    reject(new Error(`V1 FALHOU: cadeia morreu (exit ${code}) — tail: ${cleanTail.slice(-600)}`))
  )
})
console.log(`V1/V2 OK — npm→electron-vite→electron entregou a linha DevTools no pipe: ${wsUrl}`)
const announced = Number(new URL(wsUrl).port)
if (announced !== port) throw new Error(`V3 FALHOU: porta anunciada ${announced} != pedida ${port}`)
console.log(`V3 OK — porta anunciada == pedida (${port}); env+argv com o mesmo valor não conflitam`)

const { chromium } = require('playwright-core')
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const pages = browser.contexts().flatMap((c) => c.pages())
if (pages.length === 0) throw new Error('V4 FALHOU: nenhuma página via CDP')
console.log(`V4 OK — connectOverCDP viu ${pages.length} página(s) do app real (${pages[0].url()})`)
await browser.close()

// ceifa: taskkill /T /F na raiz shell (mesma 2ª camada do qaRuntime)
await new Promise((resolve) => execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => resolve()))
await new Promise((r) => setTimeout(r, 1200))
// rmdirSync remove SÓ o reparse point da junction, NUNCA o alvo (lição das
// junctions: jamais deletar recursivo com a junction ainda de pé)
rmdirSync(join(dir, 'node_modules'))
rmSync(dir, { recursive: true, force: true })
console.log('probe-electron-vite-cdp: fim')

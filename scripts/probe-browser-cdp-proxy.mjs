// SONDA — a PONTE DO AGENTE para o browser embutido (rota A × rota B).
//
// Por que existe: `DESIGN_SYNKORA_BROWSER_2026-08-15.md` §3 deixou a ponte do
// agente decidida POR SONDA, e não por opinião. As duas rotas em disputa:
//   · ROTA A — `@playwright/mcp --cdp-endpoint` apontando para um PROXY CDP que
//     filtra targets, para o driver ver só as views de navegação da missão e
//     NUNCA a janela do app (o CDP do Electron é process-wide: expõe tudo);
//   · ROTA B — MCP da casa sobre `webContents.debugger` (CDP por-view, isolado
//     por construção), com kit navigate/click/type/screenshot/read.
//
// O dono acrescentou dois requisitos que pesam tanto quanto a capacidade:
//   (1) compatibilidade PERFEITA com os DOIS CLIs (claude e codex), que
//       consomem tudo pelo MCP da casa (`src/main/mcpServer.ts`);
//   (2) VELOCIDADE — QA visual não pode custar 40-50 min; screenshot e leitura
//       de página têm de ser quase instantâneos.
//
// Esta sonda pergunta ao BINÁRIO REAL (electron 43 do próprio repo), com fato:
//   P1  `--remote-debugging-port` lista UM target por WebContentsView? A janela
//       do APP (renderer privilegiado) aparece junto — o perigo do design?
//   P2  Um proxy WS+HTTP que filtra /json/list e o domínio Target.* engana o
//       `chromium.connectOverCDP` do playwright (ver só as views, e dirigi-las)?
//   P3  `Target.attachToTarget` por targetId de alvo NÃO listado escapa do
//       filtro, ou o proxy segura? (Tentativa REAL de fuga, com controle: a
//       mesma tentativa DIRETO na porta, sem proxy, tem de funcionar.)
//   P4  LATÊNCIA medida (mediana de >=10 amostras quentes) de screenshot por
//       `capturePage`, por `webContents.debugger` e por playwright-sobre-proxy;
//       e de leitura de página (innerText, AXTree, DOMSnapshot) com TAMANHOS.
//   P5  A ARMADILHA DO PANE ESCONDIDO (lição cara da casa: pane escondido não
//       compõe): detached, 0x0, ocluído, setVisible(false), fora da janela,
//       janela escondida/minimizada — sai PIXEL DE VERDADE e FRESCO?
//   P6  `webContents.debugger` (rota B) faz o kit inteiro numa WebContentsView?
//       Conflita com devtools aberto ou com o playwright atacado ao mesmo alvo?
//
// Uso:
//   node scripts/probe-browser-cdp-proxy.mjs               # tudo
//   node scripts/probe-browser-cdp-proxy.mjs --samples 20  # mais amostras
//   node scripts/probe-browser-cdp-proxy.mjs --keep        # não limpa scratch
//   node scripts/probe-browser-cdp-proxy.mjs --no-playwright
//   node scripts/probe-browser-cdp-proxy.mjs --headed=false # janela oculta
//
// Não toca em src/. Não roda o app do dono: sobe um electron PRÓPRIO a partir
// de um main.js descartável em %TEMP%/synkora-probe-browser (apagado no fim,
// salvo --keep) e mata o processo filho PELO PID (taskkill /T, nunca por nome
// de imagem). Evidência crua em .tmp/probe-browser/.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { inflateSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-browser')
const SHOTS = join(OUT_DIR, 'shots')
const SCRATCH = join(tmpdir(), 'synkora-probe-browser')
const APP_DIR = join(SCRATCH, 'app')
const PW_DIR = join(SCRATCH, 'pw')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return i >= 0 ? 'true' : dflt
}
const SAMPLES = Number(flag('samples', '12'))
const KEEP = flag('keep', 'false') === 'true'
const WANT_PW = flag('no-playwright', 'false') !== 'true'
const HEADED = flag('headed', 'true') !== 'false'
const CDP_PORT = Number(flag('cdp-port', '0')) || 9333 + (process.pid % 300)
const PROXY_PORT = CDP_PORT + 1
const PAGES_PORT = CDP_PORT + 2

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
mkdirSync(APP_DIR, { recursive: true })

const requireRepo = createRequire(join(REPO, 'package.json'))
const ELECTRON_BIN = requireRepo('electron')
const { WebSocket, WebSocketServer } = requireRepo('ws')

const report = {
  probedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  electron: requireRepo('electron/package.json').version,
  ports: { cdp: CDP_PORT, proxy: PROXY_PORT, pages: PAGES_PORT },
  samples: SAMPLES,
  p1_targets: null,
  p2_playwright: null,
  p3_escape: null,
  p4_latency: null,
  p5_hidden: null,
  p6_debugger: null,
  p7_playwrightMcp: null,
  p8_dualCli: null,
  notes: [],
  errors: []
}
const log = (...a) => console.log(...a)
const note = (s) => {
  report.notes.push(s)
  log(`   · ${s}`)
}
const raw = (name, data) =>
  writeFileSync(
    join(OUT_DIR, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    'utf-8'
  )

// ————————————————————————————————————————————————————————————————
// 0. utilitários: PNG cru (prova por BYTES, nunca por tamanho de arquivo)
// ————————————————————————————————————————————————————————————————

/** Decodifica PNG 8-bit não-entrelaçado (o que o Chromium emite) e devolve um
 *  leitor de pixel. É a única forma honesta de responder "saiu pixel de
 *  verdade?": tamanho de arquivo mente (um PNG branco de 1600x900 tem 8 KB). */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels || bitDepth !== 8 || interlace !== 0 || !width) return null
  const rawBytes = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = rawBytes[src++]
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const rawv = rawBytes[src++]
      const a = x >= channels ? row[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = rawv
      if (filter === 1) v = rawv + a
      else if (filter === 2) v = rawv + b
      else if (filter === 3) v = rawv + ((a + b) >> 1)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      row[x] = v & 0xff
    }
  }
  const at = (x, y) => {
    const i = y * stride + x * channels
    if (channels >= 3) return [out[i], out[i + 1], out[i + 2]]
    return [out[i], out[i], out[i]]
  }
  return { width, height, channels, at }
}

/** Retrato de uma captura: a cor DOMINANTE do miolo (o #stage, 220x220 CSS px
 *  no centro, SEM texto) + quantas cores distintas numa grade da tela inteira.
 *  Uma tela morta/branca tem 1 cor distinta; uma tela real tem dezenas.
 *
 *  Cor dominante, e não o pixel central: a primeira rodada desta sonda foi
 *  enganada pelo ANTIALIASING do rótulo que havia no meio do #stage — o pixel
 *  do centro caía na borda de um glifo e vinha misturado com o branco, e todo
 *  modo aparecia "congelado". Pixel único é evidência frágil; maioria em caixa
 *  não é. */
function shotFacts(pngBuffer) {
  const img = decodePng(pngBuffer)
  if (!img) return { decoded: false, bytes: pngBuffer.length }
  const cx = img.width >> 1
  const cy = img.height >> 1
  const half = Math.max(8, Math.min(60, Math.floor(Math.min(img.width, img.height) * 0.06)))
  const box = new Map()
  for (let y = cy - half; y <= cy + half; y += 4)
    for (let x = cx - half; x <= cx + half; x += 4) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue
      const k = img.at(x, y).join(',')
      box.set(k, (box.get(k) || 0) + 1)
    }
  let dominant = null
  let dominantCount = 0
  let total = 0
  for (const [k, n] of box) {
    total += n
    if (n > dominantCount) {
      dominantCount = n
      dominant = k
    }
  }
  const seen = new Set()
  for (let gy = 1; gy < 20; gy++)
    for (let gx = 1; gx < 20; gx++) {
      const p = img.at(Math.floor((img.width * gx) / 20), Math.floor((img.height * gy) / 20))
      seen.add(p.join(','))
    }
  return {
    decoded: true,
    bytes: pngBuffer.length,
    w: img.width,
    h: img.height,
    center: img.at(cx, cy).join(','),
    dominant,
    dominantShare: total ? Math.round((dominantCount / total) * 100) : 0,
    distinctColors: seen.size
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}
const stat = (xs) => ({
  n: xs.length,
  median: median(xs),
  min: Math.min(...xs),
  max: Math.max(...xs),
  p90: [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ————————————————————————————————————————————————————————————————
// 1. as PÁGINAS (servidor estático da sonda) — conteúdo real, não about:blank
// ————————————————————————————————————————————————————————————————

function pageHtml(viewKey, nodes) {
  const cards = []
  for (let i = 0; i < nodes; i++) {
    cards.push(
      `<article class="card"><h3>Card ${i}</h3><p>Linha de texto ${i} com conteudo suficiente para o extrator ter o que ler.</p><span class="badge">B${i % 7}</span></article>`
    )
  }
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>PROBE ${viewKey}</title>
<style>
 body{margin:0;font:13px/1.5 Consolas,monospace;background:#efe9dc;color:#26241f}
 header{padding:12px 16px;background:#26241f;color:#efe9dc;display:flex;gap:12px;align-items:center}
 .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px}
 .card{border:1px solid #26241f;padding:8px;background:#fff}
 .badge{display:inline-block;border:1px solid #d96c3f;color:#d96c3f;padding:0 4px}
 #stage{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:220px;height:220px;
        background:rgb(217,108,63);z-index:9999}
</style></head><body>
<header><strong>PROBE ${viewKey}</strong><input id="q" placeholder="busca"><button id="btn">acionar</button><output id="out">idle</output><span id="raf">0</span></header>
<div class="grid">${cards.join('')}</div>
<div id="stage"></div>
<script>
 let n=0; const el=document.getElementById('raf');
 (function tick(){ n++; el.textContent=String(n); requestAnimationFrame(tick) })();
 window.__raf = () => n;
 document.getElementById('btn').addEventListener('click',()=>{document.getElementById('out').textContent='CLICADO'});
 document.getElementById('q').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('out').textContent='ENTER:'+e.target.value});
</script></body></html>`
}

const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>SYNKORA-APP-WINDOW</title>
<style>body{margin:0;background:#1b1a17;color:#efe9dc;font:14px Consolas,monospace;padding:16px}</style>
</head><body><h1>janela do APP (renderer privilegiado)</h1>
<p id="s">segredo ainda nao lido</p>
<script>window.__leak = () => (window.synkoraFake ? window.synkoraFake.secret() : 'SEM-BRIDGE')</script>
</body></html>`

const APP_PRELOAD = `const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('synkoraFake', {
  secret: () => 'SEGREDO-DO-DONO-42',
  seats: () => ['conta-1', 'conta-2']
})`

// ————————————————————————————————————————————————————————————————
// 2. o MAIN.JS descartável do electron (nasce e morre no scratch)
// ————————————————————————————————————————————————————————————————

const MAIN_JS = `// main descartavel da sonda (NAO e produto). Fala por HTTP em 127.0.0.1.
const { app, BaseWindow, WebContentsView } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

const arg = (n, d) => {
  const p = '--' + n + '='
  const hit = process.argv.find((a) => a.indexOf(p) === 0)
  return hit ? hit.slice(p.length) : d
}
const PAGES = arg('pages', 'http://127.0.0.1:0')
const HEADED = arg('headed', 'true') === 'true'
const OUT = arg('out', app.getPath('temp'))
const READY_FILE = arg('ready', path.join(OUT, 'control.json'))

let win = null
let appView = null
const views = new Map()
const attached = new Set()

function makeBrowserView(key, url) {
  const v = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  v.setBounds({ x: 400, y: 0, width: 1000, height: 900 })
  win.contentView.addChildView(v)
  v.webContents.loadURL(url)
  views.set(key, v)
  return v
}

function dbg(key) {
  const v = views.get(key)
  if (!v) throw new Error('view desconhecida: ' + key)
  if (!v.webContents.debugger.isAttached()) {
    v.webContents.debugger.attach('1.3')
    attached.add(key)
  }
  return v.webContents.debugger
}

async function ready(key) {
  const v = views.get(key)
  if (!v) throw new Error('view desconhecida: ' + key)
  if (v.webContents.isLoading()) await new Promise((r) => v.webContents.once('did-finish-load', r))
  return v
}

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + label + ' ' + ms + 'ms')), ms))
  ])
}

async function capturePageOnce(key) {
  const v = views.get(key)
  const t0 = process.hrtime.bigint()
  const img = await withTimeout(v.webContents.capturePage(), 5000, 'capturePage')
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const png = img.isEmpty() ? Buffer.alloc(0) : img.toPNG()
  return { ms: ms, png: png, empty: img.isEmpty(), size: img.getSize() }
}

async function cdpShotOnce(key, opts, remedy) {
  const d = dbg(key)
  const params = Object.assign({ format: 'png' }, opts || {})
  // REMEDIO candidato para a view escondida: forcar metricas de dispositivo
  // antes do disparo (o truque do headless — obriga o compositor a produzir
  // quadro mesmo sem superficie visivel).
  if (remedy === 'deviceMetrics') {
    const v = views.get(key)
    const bb = v.getBounds()
    await d.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: bb.width || 1000,
      height: bb.height || 900,
      deviceScaleFactor: 1,
      mobile: false
    })
  }
  const t0 = process.hrtime.bigint()
  try {
    const r = await withTimeout(d.sendCommand('Page.captureScreenshot', params), 8000, 'captureScreenshot')
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    return { ms: ms, png: Buffer.from(r.data, 'base64') }
  } finally {
    if (remedy === 'deviceMetrics') {
      try { await d.sendCommand('Emulation.clearDeviceMetricsOverride', {}) } catch (e) {}
    }
  }
}

const ops = {
  async hello() {
    return {
      pid: process.pid,
      views: [...views.keys()].map((k) => ({
        key: k,
        url: views.get(k).webContents.getURL(),
        wcId: views.get(k).webContents.id
      })),
      appUrl: appView ? appView.webContents.getURL() : null,
      appWcId: appView ? appView.webContents.id : null
    }
  },
  async ping() {
    return { alive: true, windows: BaseWindow.getAllWindows().length, at: Date.now() }
  },
  async newView(b) {
    const key = b.key || 'extra'
    makeBrowserView(key, PAGES + '/page?view=' + key + '&nodes=' + (b.nodes || 300))
    await ready(key)
    return { created: key, url: views.get(key).webContents.getURL() }
  },
  // MARCA FRESCA: pinta o #stage (220x220 no centro, SEM texto — glifo
  // antialiasado no miolo estragaria a prova por pixel) e devolve a cor
  // computada como recibo.
  async stage(b) {
    const d = dbg(b.key)
    const expr =
      "(()=>{const s=document.getElementById('stage'); s.textContent=''; s.style.background='" +
      b.color +
      "'; document.getElementById('out').textContent='" +
      (b.label || '') +
      "'; return getComputedStyle(s).backgroundColor})()"
    const r = await d.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true })
    return { applied: r.result && r.result.value }
  },
  // O agente consegue CLICAR num pane que o dono colapsou? (a outra metade da
  // armadilha: ver e DIRIGIR sao coisas diferentes)
  async clickTest(b) {
    const d = dbg(b.key)
    await d.sendCommand('Runtime.evaluate', {
      expression: "document.getElementById('out').textContent='idle'",
      returnByValue: true
    })
    const box = await d.sendCommand('Runtime.evaluate', {
      expression:
        "(()=>{const r=document.getElementById('btn').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,w:r.width})})()",
      returnByValue: true
    })
    const p = JSON.parse(box.result.value)
    const base = { x: p.x, y: p.y, button: 'left', clickCount: 1 }
    await d.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base))
    await d.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base))
    await new Promise((r) => setTimeout(r, 120))
    const r = await d.sendCommand('Runtime.evaluate', {
      expression: "document.getElementById('out').textContent",
      returnByValue: true
    })
    return { rect: p, out: r.result.value, clicked: r.result.value === 'CLICADO' }
  },
  async live(b) {
    const d = dbg(b.key)
    const one = await d.sendCommand('Runtime.evaluate', { expression: 'window.__raf()', returnByValue: true })
    await new Promise((r) => setTimeout(r, 350))
    const two = await d.sendCommand('Runtime.evaluate', { expression: 'window.__raf()', returnByValue: true })
    return { rafStart: one.result.value, rafEnd: two.result.value, delta: two.result.value - one.result.value }
  },
  async mode(b) {
    const v = views.get(b.key)
    const other = views.get(b.cover || 'v2')
    const applied = []
    // sempre parte do estado neutro
    try { win.contentView.removeChildView(v) } catch (e) {}
    try { if (other) win.contentView.removeChildView(other) } catch (e) {}
    v.setVisible(true)
    v.setBounds({ x: 400, y: 0, width: 1000, height: 900 })
    if (!win.isVisible() && b.mode !== 'window-hidden') { win.show(); applied.push('win.show') }
    if (win.isMinimized()) { win.restore(); applied.push('win.restore') }
    if (b.mode === 'visible') {
      win.contentView.addChildView(v)
      applied.push('addChildView')
    } else if (b.mode === 'occluded') {
      win.contentView.addChildView(v)
      if (other) {
        other.setBounds({ x: 400, y: 0, width: 1000, height: 900 })
        win.contentView.addChildView(other)
        applied.push('cover em cima')
      }
    } else if (b.mode === 'zero-bounds') {
      win.contentView.addChildView(v)
      v.setBounds({ x: 400, y: 0, width: 0, height: 0 })
      applied.push('bounds 0x0')
    } else if (b.mode === 'offscreen-attached') {
      win.contentView.addChildView(v)
      v.setBounds({ x: 3000, y: 0, width: 1000, height: 900 })
      applied.push('bounds fora da janela')
    } else if (b.mode === 'set-visible-false') {
      win.contentView.addChildView(v)
      v.setVisible(false)
      applied.push('setVisible(false)')
    } else if (b.mode === 'detached') {
      applied.push('removeChildView')
    } else if (b.mode === 'window-hidden') {
      win.contentView.addChildView(v)
      win.hide()
      applied.push('win.hide()')
    } else if (b.mode === 'window-minimized') {
      win.contentView.addChildView(v)
      win.minimize()
      applied.push('win.minimize()')
    } else throw new Error('modo desconhecido: ' + b.mode)
    await new Promise((r) => setTimeout(r, b.settle || 400))
    return { mode: b.mode, applied: applied, bounds: v.getBounds(), winVisible: win.isVisible() }
  },
  async capture(b) {
    const file = path.join(OUT, b.file)
    let out
    if (b.method === 'capturePage') out = await capturePageOnce(b.key)
    else out = await cdpShotOnce(b.key, b.opts, b.remedy)
    fs.writeFileSync(file, out.png)
    return { ms: out.ms, bytes: out.png.length, file: file, empty: !!out.empty, size: out.size || null }
  },
  async bench(b) {
    const n = b.samples || 10
    const ms = []
    let bytes = 0
    // aquecimento (2 disparos fora da conta)
    for (let i = 0; i < 2; i++) {
      if (b.method === 'capturePage') await capturePageOnce(b.key)
      else await cdpShotOnce(b.key, b.opts, b.remedy)
    }
    for (let i = 0; i < n; i++) {
      const out = b.method === 'capturePage' ? await capturePageOnce(b.key) : await cdpShotOnce(b.key, b.opts, b.remedy)
      ms.push(out.ms)
      bytes = out.png.length
    }
    return { ms: ms, bytes: bytes }
  },
  // O SCREENCAST: em vez de pedir um quadro e esperar o compositor, o Chromium
  // EMPURRA quadros. Se o app mantiver o screencast ligado no pane visivel, o
  // "screenshot" do agente vira "devolva o ultimo quadro" — custo ~0.
  async screencast(b) {
    const key = b.key
    const d = dbg(key)
    const frames = []
    const onMsg = (event, method, params) => {
      if (method !== 'Page.screencastFrame') return
      frames.push({ t: Date.now(), bytes: Buffer.from(params.data, 'base64').length })
      d.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    }
    d.on('message', onMsg)
    const t0 = Date.now()
    await d.sendCommand('Page.startScreencast', {
      format: b.format || 'jpeg',
      quality: b.quality || 70,
      everyNthFrame: 1
    })
    await new Promise((r) => setTimeout(r, b.ms || 2000))
    // FRESCOR: muda o DOM e cronometra ate o PROXIMO quadro chegar.
    const mark = Date.now()
    const before = frames.length
    await d.sendCommand('Runtime.evaluate', {
      expression: "document.getElementById('stage').style.background='rgb(9,9,9)'",
      returnByValue: true
    })
    await new Promise((r) => setTimeout(r, 600))
    const firstAfter = frames[before] ? frames[before].t - mark : null
    await d.sendCommand('Page.stopScreencast', {})
    d.removeListener('message', onMsg)
    const gaps = []
    for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t)
    return {
      firstFrameMs: frames.length ? frames[0].t - t0 : null,
      frames: frames.length,
      windowMs: b.ms || 2000,
      gaps: gaps,
      avgBytes: frames.length ? Math.round(frames.reduce((a, f) => a + f.bytes, 0) / frames.length) : 0,
      msAteQuadroFrescoAposMutacao: firstAfter
    }
  },
  async read(b) {
    const d = dbg(b.key)
    const n = b.samples || 10
    const ms = []
    let bytes = 0
    let extra = null
    const run = async () => {
      if (b.kind === 'innerText') {
        const r = await d.sendCommand('Runtime.evaluate', {
          expression: 'document.body.innerText',
          returnByValue: true
        })
        return String(r.result.value || '')
      }
      if (b.kind === 'html') {
        const r = await d.sendCommand('Runtime.evaluate', {
          expression: 'document.documentElement.outerHTML',
          returnByValue: true
        })
        return String(r.result.value || '')
      }
      if (b.kind === 'axtree') {
        const r = await d.sendCommand('Accessibility.getFullAXTree', {})
        extra = { nodes: (r.nodes || []).length }
        return JSON.stringify(r)
      }
      if (b.kind === 'domsnapshot') {
        const r = await d.sendCommand('DOMSnapshot.captureSnapshot', { computedStyles: [] })
        return JSON.stringify(r)
      }
      throw new Error('kind desconhecido: ' + b.kind)
    }
    if (b.kind === 'axtree') await d.sendCommand('Accessibility.enable', {})
    if (b.kind === 'domsnapshot') await d.sendCommand('DOMSnapshot.enable', {})
    await run()
    for (let i = 0; i < n; i++) {
      const t0 = process.hrtime.bigint()
      const text = await run()
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6)
      bytes = Buffer.byteLength(text, 'utf8')
    }
    return { ms: ms, bytes: bytes, extra: extra }
  },
  // ——— P6: o kit da rota B, um a um, na WebContentsView ———
  async kit(b) {
    const key = b.key
    const v = await ready(key)
    const d = dbg(key)
    const out = {}
    const t = async (label, fn) => {
      const t0 = process.hrtime.bigint()
      try {
        const r = await fn()
        out[label] = { ok: true, ms: Number(process.hrtime.bigint() - t0) / 1e6, value: r }
      } catch (e) {
        out[label] = { ok: false, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: String(e && e.message) }
      }
    }
    await t('attach', async () => d.isAttached())
    await t('Page.enable', () => d.sendCommand('Page.enable', {}))
    await t('Page.navigate', async () => {
      const r = await d.sendCommand('Page.navigate', { url: PAGES + '/page?view=' + key + '&nodes=120' })
      await new Promise((res) => v.webContents.once('did-finish-load', res))
      return { frameId: !!r.frameId, url: v.webContents.getURL() }
    })
    await t('Runtime.evaluate', async () => {
      const r = await d.sendCommand('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true
      })
      return r.result.value
    })
    await t('Input.dispatchMouseEvent(click #btn)', async () => {
      const box = await d.sendCommand('Runtime.evaluate', {
        expression: "(()=>{const r=document.getElementById('btn').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()",
        returnByValue: true
      })
      const p = JSON.parse(box.result.value)
      const base = { x: p.x, y: p.y, button: 'left', clickCount: 1 }
      await d.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base))
      await d.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base))
      await new Promise((r) => setTimeout(r, 60))
      const r = await d.sendCommand('Runtime.evaluate', {
        expression: "document.getElementById('out').textContent",
        returnByValue: true
      })
      return r.result.value
    })
    await t('Input.dispatchKeyEvent(digitar+Enter)', async () => {
      await d.sendCommand('Runtime.evaluate', {
        expression: "document.getElementById('q').focus()",
        returnByValue: true
      })
      for (const ch of 'oi') {
        await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
        await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      }
      await d.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
      })
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: '\\r', key: 'Enter' })
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await new Promise((r) => setTimeout(r, 80))
      const r = await d.sendCommand('Runtime.evaluate', {
        expression: "document.getElementById('out').textContent",
        returnByValue: true
      })
      return r.result.value
    })
    await t('Page.captureScreenshot', async () => {
      const s = await cdpShotOnce(key, { format: 'jpeg', quality: 70 })
      return { bytes: s.png.length }
    })
    await t('Network/console (Log.enable)', () => d.sendCommand('Log.enable', {}))
    return out
  },
  // A CONTRADICAO da rodada anterior: em P5 o clique funcionou na view
  // detached; no kit de P6 (que NAVEGA antes) o mesmo clique caiu no vazio.
  // Em vez de deduzir, mede-se a matriz: pagina ja pintada x pagina navegada
  // enquanto escondida, com e sem folga.
  async hiddenInputMatrix(b) {
    const key = b.key
    const v = views.get(key)
    const d = dbg(key)
    const mode = b.mode || 'detached'
    const click = async () => {
      const r = await ops.clickTest({ key: key })
      return { out: r.out, clicked: r.clicked, rectW: r.rect.w }
    }
    // parte SEMPRE de uma pagina pintada com a view visivel, e so entao
    // aplica o modo — senao a medida mistura "nunca pintou" com "escondida".
    await ops.mode({ key: key, mode: 'visible', cover: 'v1' })
    await new Promise((r) => setTimeout(r, 400))
    await ops.mode({ key: key, mode: mode, cover: 'v1' })
    const out = { mode: mode }
    out.aPaginaJaPintada = await click()
    await d.sendCommand('Page.navigate', { url: PAGES + '/page?view=' + key + '&nodes=120' })
    await new Promise((res) => v.webContents.once('did-finish-load', res))
    out.bAposNavegarEscondida = await click()
    await new Promise((r) => setTimeout(r, 1200))
    out.cMesmaPaginaComFolga = await click()
    // e se ela for exibida por um instante e escondida de novo?
    await ops.mode({ key: key, mode: 'visible', cover: 'v1' })
    await new Promise((r) => setTimeout(r, 400))
    await ops.mode({ key: key, mode: mode, cover: 'v1' })
    await new Promise((r) => setTimeout(r, 200))
    out.dAposUmPiscarVisivel = await click()
    return out
  },
  async dbgStatus(b) {
    const v = views.get(b.key)
    const attached = v.webContents.debugger.isAttached()
    let evalOk = null
    if (attached) {
      try {
        const r = await v.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: '1+1',
          returnByValue: true
        })
        evalOk = r.result.value
      } catch (e) {
        evalOk = 'ERRO: ' + String(e && e.message)
      }
    }
    return { attached: attached, devtoolsOpen: v.webContents.isDevToolsOpened(), evalOk: evalOk }
  },
  async devtools(b) {
    const v = views.get(b.key)
    if (b.action === 'open') {
      v.webContents.openDevTools({ mode: 'detach' })
      await new Promise((r) => setTimeout(r, 700))
      return { opened: v.webContents.isDevToolsOpened() }
    }
    v.webContents.closeDevTools()
    await new Promise((r) => setTimeout(r, 300))
    return { opened: v.webContents.isDevToolsOpened() }
  },
  async attachTry(b) {
    const v = views.get(b.key)
    try {
      if (b.detachFirst && v.webContents.debugger.isAttached()) v.webContents.debugger.detach()
      v.webContents.debugger.attach('1.3')
      return { attached: true }
    } catch (e) {
      return { attached: false, error: String(e && e.message) }
    }
  },
  async detach(b) {
    const v = views.get(b.key)
    try {
      if (v.webContents.debugger.isAttached()) v.webContents.debugger.detach()
      return { detached: true }
    } catch (e) {
      return { detached: false, error: String(e && e.message) }
    }
  },
  async evalMain(b) {
    const v = views.get(b.key)
    const r = await v.webContents.executeJavaScript(b.expression, true)
    return { value: r }
  },
  async quit() {
    setTimeout(() => app.exit(0), 100)
    return { quitting: true }
  }
}

app.whenReady().then(async () => {
  win = new BaseWindow({ width: 1400, height: 900, show: HEADED, title: 'SONDA-SYNKORA-BROWSER' })
  appView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'app-preload.js'), contextIsolation: true, sandbox: false }
  })
  appView.setBounds({ x: 0, y: 0, width: 400, height: 900 })
  win.contentView.addChildView(appView)
  appView.webContents.loadFile(path.join(__dirname, 'app-window.html'))
  for (const key of ['v1', 'v2', 'v3']) makeBrowserView(key, PAGES + '/page?view=' + key + '&nodes=' + (key === 'v1' ? 400 : 120))
  win.contentView.removeChildView(views.get('v2'))
  win.contentView.removeChildView(views.get('v3'))
  for (const key of ['v1', 'v2', 'v3']) await ready(key)

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let payload = {}
      try { payload = body ? JSON.parse(body) : {} } catch (e) {}
      const op = (req.url || '').replace(/^\\//, '').split('?')[0]
      const fn = ops[op]
      if (!fn) { res.writeHead(404).end('op'); return }
      try {
        const out = await fn(payload)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, out: out }))
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: String((e && e.stack) || e) })
        )
      }
    })
  })
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(READY_FILE, JSON.stringify({ port: server.address().port, pid: process.pid }))
  })
})
`

// ————————————————————————————————————————————————————————————————
// 3. o PROXY CDP com filtro de targets (o coração da rota A)
// ————————————————————————————————————————————————————————————————

/** Comandos de nível BROWSER que o proxy recusa. `attachToTarget`,
 *  `getTargetInfo` e `closeTarget` passam QUANDO o targetId está na lista da
 *  missão — o veto é sobre alvo estranho, não sobre o verbo. */
const BROWSER_ONLY_BLOCK = new Set([
  'Target.attachToTarget',
  'Target.createTarget',
  'Target.closeTarget',
  'Target.getTargetInfo',
  'Target.exposeDevToolsProtocol',
  'Target.attachToBrowserTarget',
  'Browser.close',
  'Browser.crash'
])

/** MEDIDO nesta sonda: o `connectOverCDP` do playwright dispara
 *  `Browser.setDownloadBehavior` no handshake — recusar DERRUBA a conexão
 *  inteira ("Protocol error ... <ws disconnecting>"). Mas deixar passar entrega
 *  ao driver a política de download do app INTEIRO (nível browser, não por
 *  contexto). A saída é o TAPA-BURACO: o proxy responde OK e não encaminha —
 *  o driver segue feliz e a política do app fica intacta. */
const BROWSER_STUB_OK = new Set(['Browser.setDownloadBehavior', 'Browser.setPermission', 'Browser.grantPermissions'])

function startCdpProxy({ cdpPort, proxyPort, allow, secret, journal }) {
  const allowed = new Set(allow)
  // `allowCreate` é a chave que o P7 vira: com ela, `Target.createTarget` passa
  // e o alvo criado entra na lista sozinho (ADOÇÃO). É o que um driver que
  // abre a própria página exige — e é exatamente a superfície que o app
  // perderia de vista se ela ficasse ligada de graça.
  const state = { blockedAttempts: [], forwarded: 0, filteredEvents: 0, absorbedAttaches: [], allowCreate: false, adopted: [] }
  const rec = (o) => {
    journal && appendFileSync(journal, JSON.stringify({ t: Date.now(), ...o }) + '\n')
  }

  const fetchJson = async (p) => {
    const r = await fetch(`http://127.0.0.1:${cdpPort}${p}`)
    return { status: r.status, text: await r.text() }
  }

  const http1 = createServer(async (req, res) => {
    const url = req.url || ''
    try {
      if (url.startsWith('/json/version')) {
        const j = JSON.parse((await fetchJson('/json/version')).text)
        j.webSocketDebuggerUrl = `ws://127.0.0.1:${proxyPort}/${secret}/browser`
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(j))
        return
      }
      if (url.startsWith('/json/list') || url === '/json' || url.startsWith('/json?')) {
        const all = JSON.parse((await fetchJson('/json/list')).text)
        const kept = all
          .filter((t) => allowed.has(t.id))
          .map((t) => ({
            ...t,
            webSocketDebuggerUrl: `ws://127.0.0.1:${proxyPort}/${secret}/page/${t.id}`,
            devtoolsFrontendUrl: undefined
          }))
        rec({ kind: 'json/list', total: all.length, kept: kept.length })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(kept))
        return
      }
      if (url.startsWith('/json/protocol')) {
        const r = await fetchJson('/json/protocol')
        res.writeHead(200, { 'content-type': 'application/json' }).end(r.text)
        return
      }
      // /json/new, /json/close, /json/activate: superfície de criação/morte de
      // target por HTTP — fechada, senão o filtro do WS seria teatro.
      rec({ kind: 'http-block', url })
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'bloqueado pelo proxy do Synkora', path: url })
      )
    } catch (e) {
      res.writeHead(502).end(String(e))
    }
  })

  const wss = new WebSocketServer({ noServer: true })

  http1.on('upgrade', (req, socket, head) => {
    const url = req.url || ''
    const m = url.match(/^\/([^/]+)\/(browser|page\/(.+))$/)
    if (!m || m[1] !== secret) {
      rec({ kind: 'upgrade-block', url, why: 'segredo invalido' })
      state.blockedAttempts.push({ what: 'upgrade', url, why: 'segredo invalido' })
      socket.destroy()
      return
    }
    const isBrowser = m[2] === 'browser'
    const targetId = m[3]
    if (!isBrowser && !allowed.has(targetId)) {
      rec({ kind: 'upgrade-block', url, why: 'target fora da lista' })
      state.blockedAttempts.push({ what: 'upgrade-page', targetId, why: 'target fora da lista' })
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, async (client) => {
      let upstreamUrl
      if (isBrowser) {
        const v = JSON.parse((await fetchJson('/json/version')).text)
        upstreamUrl = v.webSocketDebuggerUrl
      } else {
        const all = JSON.parse((await fetchJson('/json/list')).text)
        upstreamUrl = all.find((t) => t.id === targetId)?.webSocketDebuggerUrl
      }
      if (!upstreamUrl) return client.close()
      pipe(client, upstreamUrl, isBrowser)
    })
  })

  function pipe(client, upstreamUrl, isBrowser) {
    const up = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    const q = []
    const blockedSessions = new Set()
    const pendingGetTargets = new Set()
    const pendingCreate = new Set()
    let proxyId = 1_000_000_000
    const proxyOwned = new Set()

    const toUp = (obj) => {
      const s = JSON.stringify(obj)
      if (up.readyState === 1) up.send(s)
      else q.push(s)
    }
    const toClient = (obj) => {
      if (client.readyState === 1) client.send(JSON.stringify(obj))
    }
    const proxySend = (method, params, sessionId) => {
      const id = proxyId++
      proxyOwned.add(id)
      toUp({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    }

    up.on('open', () => {
      for (const s of q) up.send(s)
      q.length = 0
    })
    up.on('close', () => client.close())
    up.on('error', () => client.close())
    client.on('close', () => up.close())
    client.on('error', () => up.close())

    client.on('message', (buf) => {
      let msg
      try {
        msg = JSON.parse(buf.toString())
      } catch {
        return
      }
      const onBrowserSession = !msg.sessionId
      if (onBrowserSession && BROWSER_STUB_OK.has(msg.method)) {
        state.stubbed = (state.stubbed || 0) + 1
        rec({ kind: 'cmd-stub', method: msg.method })
        toClient({ id: msg.id, result: {} })
        return
      }
      if (onBrowserSession && BROWSER_ONLY_BLOCK.has(msg.method)) {
        const tid = msg.params?.targetId
        // MEDIDO: o handshake do playwright chama `Target.getTargetInfo` SEM
        // targetId (pergunta pelo alvo da própria conexão — o browser). Recusar
        // isso derruba a conexão inteira; não vaza página nenhuma.
        const selfInfo = msg.method === 'Target.getTargetInfo' && !tid
        const aboutAllowed = tid && allowed.has(tid)
        const perTarget =
          msg.method === 'Target.attachToTarget' ||
          msg.method === 'Target.getTargetInfo' ||
          msg.method === 'Target.closeTarget'
        if (msg.method === 'Target.createTarget' && state.allowCreate) {
          pendingCreate.add(msg.id)
          state.forwarded++
          toUp(msg)
          return
        }
        if (selfInfo || (perTarget && aboutAllowed)) {
          state.forwarded++
          toUp(msg)
          return
        }
        state.blockedAttempts.push({ what: msg.method, targetId: tid ?? null })
        rec({ kind: 'cmd-block', method: msg.method, targetId: tid ?? null })
        toClient({
          id: msg.id,
          error: { code: -32000, message: `Synkora: ${msg.method} bloqueado (target fora do escopo da missao)` }
        })
        return
      }
      if (onBrowserSession && msg.method === 'Target.getTargets') pendingGetTargets.add(msg.id)
      if (msg.sessionId && blockedSessions.has(msg.sessionId)) {
        toClient({ id: msg.id, error: { code: -32000, message: 'Synkora: sessao fora do escopo' } })
        return
      }
      state.forwarded++
      toUp(msg)
    })

    up.on('message', (buf) => {
      let msg
      try {
        msg = JSON.parse(buf.toString())
      } catch {
        return
      }
      if (typeof msg.id === 'number' && proxyOwned.has(msg.id)) {
        proxyOwned.delete(msg.id)
        return
      }
      // ——— respostas ———
      if (pendingCreate.has(msg.id)) {
        pendingCreate.delete(msg.id)
        const tid = msg.result?.targetId
        if (tid) {
          allowed.add(tid)
          state.adopted.push(tid)
          rec({ kind: 'adopt', targetId: tid })
        }
        toClient(msg)
        return
      }
      if (pendingGetTargets.has(msg.id)) {
        pendingGetTargets.delete(msg.id)
        const infos = msg.result?.targetInfos ?? []
        msg.result.targetInfos = infos.filter((t) => allowed.has(t.targetId))
        state.filteredEvents += infos.length - msg.result.targetInfos.length
        toClient(msg)
        return
      }
      // ——— eventos de target no nivel do BROWSER ———
      const topLevel = !msg.sessionId
      if (topLevel && msg.method === 'Target.attachedToTarget') {
        const info = msg.params?.targetInfo
        if (!allowed.has(info?.targetId)) {
          const sid = msg.params.sessionId
          blockedSessions.add(sid)
          state.filteredEvents++
          state.absorbedAttaches.push({ targetId: info?.targetId, type: info?.type, url: info?.url })
          rec({ kind: 'attach-absorb', targetId: info?.targetId, url: info?.url })
          // ABSORVE: o alvo pode ter nascido PAUSADO (waitForDebuggerOnStart do
          // auto-attach). Se o proxy so engolisse o evento, a janela do app
          // ficaria congelada esperando um debugger que nunca responde.
          if (msg.params.waitingForDebugger) proxySend('Runtime.runIfWaitingForDebugger', {}, sid)
          proxySend('Target.detachFromTarget', { sessionId: sid })
          return
        }
      }
      if (topLevel && (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged')) {
        if (!allowed.has(msg.params?.targetInfo?.targetId)) {
          state.filteredEvents++
          return
        }
      }
      if (topLevel && msg.method === 'Target.targetDestroyed') {
        if (!allowed.has(msg.params?.targetId)) {
          state.filteredEvents++
          return
        }
      }
      if (msg.sessionId && blockedSessions.has(msg.sessionId)) {
        state.filteredEvents++
        return
      }
      toClient(msg)
    })
  }

  return new Promise((res) => {
    http1.listen(proxyPort, '127.0.0.1', () =>
      res({
        state,
        endpoint: `http://127.0.0.1:${proxyPort}`,
        allow: allowed,
        close: () =>
          new Promise((r) => {
            try { wss.close() } catch {}
            http1.close(() => r())
          })
      })
    )
  })
}

// ————————————————————————————————————————————————————————————————
// 4. cliente CDP cru (para as tentativas de FUGA do P3)
// ————————————————————————————————————————————————————————————————

function rawCdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
  let id = 1
  const pending = new Map()
  const events = []
  const ready = new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  ws.on('message', (b) => {
    let m
    try {
      m = JSON.parse(b.toString())
    } catch {
      return
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) events.push(m)
  })
  return {
    ready,
    events,
    send(method, params, sessionId) {
      const mid = id++
      return new Promise((res) => {
        pending.set(mid, res)
        ws.send(JSON.stringify({ id: mid, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }))
        setTimeout(() => {
          if (pending.has(mid)) {
            pending.delete(mid)
            res({ id: mid, error: { message: 'TIMEOUT (sem resposta em 5s)' } })
          }
        }, 5000)
      })
    },
    close: () => ws.close()
  }
}

// ————————————————————————————————————————————————————————————————
// 5. orquestração da sonda
// ————————————————————————————————————————————————————————————————

let electronChild = null
let control = null
let pagesServer = null
let proxy = null

const call = async (op, body) => {
  const r = await fetch(`http://127.0.0.1:${control.port}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })
  const j = await r.json()
  if (!j.ok) throw new Error(`${op}: ${j.error}`)
  return j.out
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

async function cleanup() {
  try { if (control) await call('quit') } catch {}
  await sleep(300)
  killTree(electronChild?.pid)
  try { pagesServer?.close() } catch {}
  try { await proxy?.close() } catch {}
  if (!KEEP) {
    try { rmSync(APP_DIR, { recursive: true, force: true }) } catch {}
  }
}

async function main() {
  log('=== SONDA BROWSER CDP ===')
  log(`electron ${report.electron} · node ${process.version} · portas cdp=${CDP_PORT} proxy=${PROXY_PORT} pages=${PAGES_PORT}`)

  // 5.1 páginas
  pagesServer = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/page') {
      const html = pageHtml(u.searchParams.get('view') || 'v?', Number(u.searchParams.get('nodes') || 200))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => pagesServer.listen(PAGES_PORT, '127.0.0.1', r))

  // 5.2 app descartável
  writeFileSync(join(APP_DIR, 'main.js'), MAIN_JS, 'utf-8')
  writeFileSync(join(APP_DIR, 'app-preload.js'), APP_PRELOAD, 'utf-8')
  writeFileSync(join(APP_DIR, 'app-window.html'), APP_HTML, 'utf-8')
  writeFileSync(
    join(APP_DIR, 'package.json'),
    JSON.stringify({ name: 'synkora-probe-browser', version: '0.0.0', main: 'main.js' }),
    'utf-8'
  )
  const readyFile = join(APP_DIR, 'control.json')
  if (existsSync(readyFile)) rmSync(readyFile)

  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
  delete env.CLAUDECODE
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  electronChild = spawn(
    ELECTRON_BIN,
    [
      APP_DIR,
      `--remote-debugging-port=${CDP_PORT}`,
      `--pages=http://127.0.0.1:${PAGES_PORT}`,
      `--headed=${HEADED}`,
      `--out=${APP_DIR}`,
      `--ready=${readyFile}`
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderrTail = ''
  electronChild.stdout.on('data', (d) => (stderrTail += d.toString()))
  electronChild.stderr.on('data', (d) => (stderrTail += d.toString()))
  electronChild.on('exit', (c) => {
    if (!control) log(`[electron] saiu antes de subir (code=${c})\n${stderrTail.slice(-2000)}`)
  })

  for (let i = 0; i < 200 && !control; i++) {
    if (existsSync(readyFile)) {
      try { control = JSON.parse(readyFile ? readFileSync(readyFile, 'utf-8') : '{}') } catch {}
    }
    if (!control) await sleep(150)
  }
  if (!control) throw new Error(`electron nao subiu:\n${stderrTail.slice(-3000)}`)
  const hello = await call('hello')
  log(`\n[app] pid=${hello.pid} views=${hello.views.map((v) => v.key).join(',')} appWcId=${hello.appWcId}`)

  await runP1(hello)
  await runP3Control()
  await startProxyForViews()
  if (WANT_PW) await runP2()
  await runP3Escape()
  await runP4()
  // P7 antes de P5 de propósito: aqui o estado das views é conhecido (v1
  // visível, v2/v3 detached desde o nascimento) — a matriz visível×escondida
  // do driver sai limpa, e não como acidente de ordem.
  if (WANT_PW) await runP7()
  await runP5()
  await runP6()
  if (WANT_PW) await runP8()

  raw('summary.json', report)
  log(`\n=== evidência crua em ${OUT_DIR} ===`)
}

// ——— P1 ———
let targetsByView = {}
let appTargetId = null

async function runP1(hello) {
  log('\n--- P1: targets do --remote-debugging-port ---')
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  raw('p1-json-version-raw.json', version)
  raw('p1-json-list-raw.json', list)
  const byUrl = new Map(list.map((t) => [t.url, t]))
  targetsByView = {}
  for (const v of hello.views) {
    const t = byUrl.get(v.url)
    if (t) targetsByView[v.key] = t.id
  }
  const appEntry = list.find((t) => /app-window\.html$/.test(t.url || ''))
  appTargetId = appEntry?.id ?? null
  report.p1_targets = {
    browserVersion: version.Browser,
    protocolVersion: version['Protocol-Version'],
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    totalTargets: list.length,
    byType: list.reduce((a, t) => ((a[t.type] = (a[t.type] || 0) + 1), a), {}),
    oneTargetPerView: Object.keys(targetsByView).length === hello.views.length,
    viewTargets: targetsByView,
    appWindowListed: !!appEntry,
    appWindowTarget: appEntry ? { id: appEntry.id, type: appEntry.type, title: appEntry.title, url: appEntry.url } : null,
    rawSample: list.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url }))
  }
  log(`   targets=${list.length} tipos=${JSON.stringify(report.p1_targets.byType)}`)
  log(`   1 target por WebContentsView: ${report.p1_targets.oneTargetPerView}`)
  log(`   janela do APP listada: ${report.p1_targets.appWindowListed} (${appTargetId})`)
}

// ——— P3 controle: sem proxy, a fuga FUNCIONA? ———
async function runP3Control() {
  log('\n--- P3(controle): porta CDP crua alcança a janela do app? ---')
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
  const c = rawCdp(version.webSocketDebuggerUrl)
  await c.ready
  const att = await c.send('Target.attachToTarget', { targetId: appTargetId, flatten: true })
  const sid = att.result?.sessionId
  let leak = null
  if (sid) {
    const r = await c.send('Runtime.evaluate', { expression: 'window.__leak()', returnByValue: true }, sid)
    leak = r.result?.result?.value ?? r.error?.message
  }
  c.close()
  report.p3_escape = {
    control_noProxy: {
      attached: !!sid,
      privilegedBridgeValue: leak,
      veredicto:
        leak && String(leak).includes('SEGREDO')
          ? 'PERIGO CONFIRMADO: qualquer processo local que alcance a porta CDP dirige o renderer privilegiado'
          : 'nao alcancou'
    }
  }
  log(`   attach na janela do app: ${!!sid} · window.synkoraFake.secret() => ${leak}`)
}

async function startProxyForViews() {
  const allow = Object.values(targetsByView)
  proxy = await startCdpProxy({
    cdpPort: CDP_PORT,
    proxyPort: PROXY_PORT,
    allow,
    secret: 'segredo-da-missao-' + Math.random().toString(36).slice(2, 10),
    journal: join(OUT_DIR, 'p2p3-proxy-journal.jsonl')
  })
  writeFileSync(join(OUT_DIR, 'p2-proxy-allowlist.json'), JSON.stringify({ allow, endpoint: proxy.endpoint }, null, 2))
  log(`\n[proxy] ${proxy.endpoint} · allowlist=${allow.length} alvos`)
}

// ——— P2 ———
let pw = null
let pwPage = null
let pwBrowser = null

async function runP2() {
  log('\n--- P2: playwright connectOverCDP através do proxy ---')
  const pwEntry = join(PW_DIR, 'node_modules', 'playwright-core', 'index.js')
  if (!existsSync(pwEntry)) {
    mkdirSync(PW_DIR, { recursive: true })
    writeFileSync(join(PW_DIR, 'package.json'), '{"name":"probe-pw","private":true,"version":"0.0.0"}')
    log('   instalando playwright-core no scratch (nunca no repo)...')
    const r = spawnSync('npm', ['install', 'playwright-core', '--no-audit', '--no-fund'], {
      cwd: PW_DIR,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      shell: process.platform === 'win32',
      encoding: 'utf-8'
    })
    if (!existsSync(pwEntry)) {
      report.p2_playwright = { skipped: 'npm install playwright-core falhou', stderr: r.stderr?.slice(-500) }
      return
    }
  }
  // playwright-core é CJS: o namespace do import() traz tudo em `default`.
  const mod = await import(pathToFileURL(pwEntry).href)
  pw = mod.chromium ? mod : mod.default
  const t0 = Date.now()
  pwBrowser = await pw.chromium.connectOverCDP(proxy.endpoint)
  const connectMs = Date.now() - t0
  const contexts = pwBrowser.contexts()
  const pages = contexts.flatMap((c) => c.pages())
  const urls = pages.map((p) => p.url())
  pwPage = pages.find((p) => /view=v1/.test(p.url())) ?? pages[0]

  const drive = {}
  try {
    const t1 = Date.now()
    await pwPage.click('#btn')
    drive.click = { ms: Date.now() - t1, out: await pwPage.textContent('#out') }
  } catch (e) {
    drive.click = { error: String(e.message).slice(0, 200) }
  }
  try {
    const t1 = Date.now()
    await pwPage.fill('#q', 'sonda')
    await pwPage.press('#q', 'Enter')
    drive.type = { ms: Date.now() - t1, out: await pwPage.textContent('#out') }
  } catch (e) {
    drive.type = { error: String(e.message).slice(0, 200) }
  }
  try {
    const t1 = Date.now()
    await pwPage.goto(`http://127.0.0.1:${PAGES_PORT}/page?view=v1&nodes=400`)
    drive.goto = { ms: Date.now() - t1, url: pwPage.url() }
  } catch (e) {
    drive.goto = { error: String(e.message).slice(0, 200) }
  }
  try {
    const buf = await pwPage.screenshot()
    writeFileSync(join(SHOTS, 'p2-playwright.png'), buf)
    drive.screenshot = shotFacts(buf)
  } catch (e) {
    drive.screenshot = { error: String(e.message).slice(0, 200) }
  }
  // a criação de target é gesto do APP, não do driver: o proxy fecha
  let newPage = null
  try {
    const p = await contexts[0].newPage()
    newPage = { created: true, url: p.url() }
  } catch (e) {
    newPage = { created: false, error: String(e.message).split('\n')[0].slice(0, 200) }
  }

  report.p2_playwright = {
    connectMs,
    contexts: contexts.length,
    pagesSeen: pages.length,
    urls,
    onlyAllowed: urls.every((u) => /\/page\?view=/.test(u)),
    appWindowVisible: urls.some((u) => /app-window/.test(u)),
    drive,
    newPageThroughProxy: newPage
  }
  log(`   páginas vistas=${pages.length} (${urls.join(' | ')})`)
  log(`   janela do app visível ao playwright: ${report.p2_playwright.appWindowVisible}`)
  log(`   click=${JSON.stringify(drive.click)} goto=${JSON.stringify(drive.goto)}`)
}

// ——— P3 fuga ———
async function runP3Escape() {
  log('\n--- P3: tentativa de FUGA através do proxy ---')
  const attempts = []
  const v = await (await fetch(`${proxy.endpoint}/json/version`)).json()
  const c = rawCdp(v.webSocketDebuggerUrl)
  await c.ready

  const tries = [
    ['Target.getTargets', {}],
    ['Target.attachToTarget', { targetId: appTargetId, flatten: true }],
    ['Target.getTargetInfo', { targetId: appTargetId }],
    ['Target.createTarget', { url: 'about:blank' }],
    ['Target.closeTarget', { targetId: appTargetId }],
    ['Browser.close', {}],
    ['Target.setDiscoverTargets', { discover: true }]
  ]
  for (const [method, params] of tries) {
    const r = await c.send(method, params)
    const entry = { method, params, error: r.error?.message ?? null }
    if (method === 'Target.getTargets') {
      const infos = r.result?.targetInfos ?? []
      entry.returnedTargets = infos.map((t) => ({ id: t.targetId, type: t.type, url: t.url }))
      entry.leakedAppWindow = infos.some((t) => /app-window/.test(t.url || ''))
    }
    if (method === 'Target.attachToTarget') entry.sessionId = r.result?.sessionId ?? null
    attempts.push(entry)
  }
  await sleep(400)
  const discovered = c.events.filter((e) => e.method?.startsWith('Target.')).map((e) => ({
    method: e.method,
    url: e.params?.targetInfo?.url ?? e.params?.targetId ?? null
  }))
  attempts.push({ method: '(eventos apos setDiscoverTargets)', events: discovered })

  // fuga por HTTP: /json/new e ws direto do target proibido
  const httpNew = await fetch(`${proxy.endpoint}/json/new?about:blank`, { method: 'PUT' }).catch((e) => ({
    status: 'erro ' + e.message
  }))
  attempts.push({ method: 'HTTP PUT /json/new', status: httpNew.status })

  let wsDirect = 'bloqueado'
  try {
    const secretPath = new URL(v.webSocketDebuggerUrl).pathname.split('/')[1]
    const bad = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/${secretPath}/page/${appTargetId}`)
    wsDirect = await new Promise((res) => {
      bad.once('open', () => res('ABRIU (fuga!)'))
      bad.once('error', (e) => res('recusado: ' + e.message))
      bad.once('close', () => res('fechado pelo proxy'))
      setTimeout(() => res('sem resposta'), 3000)
    })
  } catch (e) {
    wsDirect = 'recusado: ' + e.message
  }
  attempts.push({ method: 'WS direto no path do target proibido', result: wsDirect })

  const alive = await call('ping')
  c.close()
  raw('p3-escape-attempts.json', attempts)

  report.p3_escape = {
    ...report.p3_escape,
    throughProxy: attempts,
    appStillAlive: alive.alive,
    proxyState: {
      blockedAttempts: proxy.state.blockedAttempts,
      filteredEvents: proxy.state.filteredEvents,
      absorbedAttaches: proxy.state.absorbedAttaches
    },
    veredicto:
      attempts.find((a) => a.method === 'Target.attachToTarget')?.sessionId == null &&
      !attempts.find((a) => a.method === 'Target.getTargets')?.leakedAppWindow
        ? 'BLOQUEÁVEL: o proxy segurou attach/getTargets/createTarget/Browser.close e o app seguiu vivo'
        : 'FUGA: o filtro do proxy NAO segura'
  }
  for (const a of attempts.slice(0, 7)) log(`   ${a.method} -> ${a.error ?? 'OK'}`)
  log(`   app vivo depois de Browser.close: ${alive.alive}`)
}

// ——— P4 ———
async function runP4() {
  log('\n--- P4: LATÊNCIA (mediana de amostras quentes) ---')
  await call('mode', { key: 'v1', mode: 'visible' })
  const table = {}
  const bench = async (label, body) => {
    const r = await call('bench', body)
    table[label] = { ...stat(r.ms.map((x) => Math.round(x * 100) / 100)), bytes: r.bytes }
    log(`   ${label.padEnd(42)} mediana=${table[label].median}ms  bytes=${r.bytes}`)
  }
  await bench('(a) capturePage() no main', { key: 'v1', method: 'capturePage', samples: SAMPLES })
  await bench('(b) CDP Page.captureScreenshot png', { key: 'v1', method: 'cdp', samples: SAMPLES, opts: { format: 'png' } })
  await bench('(b2) CDP screenshot jpeg q70', { key: 'v1', method: 'cdp', samples: SAMPLES, opts: { format: 'jpeg', quality: 70 } })
  await bench('(b3) CDP screenshot webp q70', { key: 'v1', method: 'cdp', samples: SAMPLES, opts: { format: 'webp', quality: 70 } })
  await bench('(b4) CDP jpeg q60 escala 0.5', {
    key: 'v1',
    method: 'cdp',
    samples: SAMPLES,
    opts: { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 1000, height: 900, scale: 0.5 } }
  })
  await bench('(b5) CDP png optimizeForSpeed', {
    key: 'v1',
    method: 'cdp',
    samples: SAMPLES,
    opts: { format: 'png', optimizeForSpeed: true }
  })
  await bench('(b6) CDP jpeg q70 fromSurface=false', {
    key: 'v1',
    method: 'cdp',
    samples: SAMPLES,
    opts: { format: 'jpeg', quality: 70, fromSurface: false }
  })
  const cast = await call('screencast', { key: 'v1', ms: 2000, format: 'jpeg', quality: 70 })
  log(
    `   (b7) screencast: 1o quadro=${cast.firstFrameMs}ms · ${cast.frames} quadros em ${cast.windowMs}ms · ` +
      `intervalo mediano=${cast.gaps.length ? median(cast.gaps) : '-'}ms · quadro fresco apos mutacao=${cast.msAteQuadroFrescoAposMutacao}ms · ${cast.avgBytes}B/quadro`
  )

  const reads = {}
  for (const kind of ['innerText', 'html', 'axtree', 'domsnapshot']) {
    const r = await call('read', { key: 'v1', kind, samples: SAMPLES })
    reads[kind] = { ...stat(r.ms.map((x) => Math.round(x * 100) / 100)), bytes: r.bytes, extra: r.extra }
    log(`   (leitura) ${kind.padEnd(33)} mediana=${reads[kind].median}ms  bytes=${r.bytes}${r.extra ? ' nodes=' + r.extra.nodes : ''}`)
  }

  const viaPw = {}
  if (pwPage) {
    const shot = []
    await pwPage.screenshot()
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now()
      const b = await pwPage.screenshot()
      shot.push(Date.now() - t0)
      viaPw.bytes = b.length
    }
    viaPw.screenshot = { ...stat(shot), bytes: viaPw.bytes }
    const jpg = []
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now()
      const b = await pwPage.screenshot({ type: 'jpeg', quality: 70 })
      jpg.push(Date.now() - t0)
      viaPw.jpegBytes = b.length
    }
    viaPw.screenshotJpeg = { ...stat(jpg), bytes: viaPw.jpegBytes }
    const txt = []
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now()
      const s = await pwPage.innerText('body')
      txt.push(Date.now() - t0)
      viaPw.textBytes = Buffer.byteLength(s)
    }
    viaPw.innerText = { ...stat(txt), bytes: viaPw.textBytes }
    const ping = []
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now()
      await pwPage.evaluate('1+1')
      ping.push(Date.now() - t0)
    }
    viaPw.evaluateRoundTrip = stat(ping)
    log(`   (c) playwright screenshot png             mediana=${viaPw.screenshot.median}ms  bytes=${viaPw.bytes}`)
    log(`   (c2) playwright screenshot jpeg q70       mediana=${viaPw.screenshotJpeg.median}ms  bytes=${viaPw.jpegBytes}`)
    log(`   (c3) playwright innerText                 mediana=${viaPw.innerText.median}ms  bytes=${viaPw.textBytes}`)
    log(`   (c4) playwright evaluate(1+1) ida e volta mediana=${viaPw.evaluateRoundTrip.median}ms`)
  }
  report.p4_latency = { mainProcess: table, screencast: cast, reads, playwrightOverProxy: viaPw }
  raw('p4-latency.json', report.p4_latency)
}

// ——— P5 ———
async function runP5() {
  log('\n--- P5: ARMADILHA DO PANE ESCONDIDO ---')
  const modes = [
    'visible',
    'occluded',
    'zero-bounds',
    'offscreen-attached',
    'set-visible-false',
    'detached',
    'window-hidden',
    'window-minimized'
  ]
  const palette = {
    visible: 'rgb(0,200,0)',
    occluded: 'rgb(0,0,255)',
    'zero-bounds': 'rgb(255,0,0)',
    'offscreen-attached': 'rgb(255,255,0)',
    'set-visible-false': 'rgb(255,0,255)',
    detached: 'rgb(0,255,255)',
    'window-hidden': 'rgb(128,0,128)',
    'window-minimized': 'rgb(255,128,0)'
  }
  const rows = []
  for (const mode of modes) {
    const applied = await call('mode', { key: 'v1', mode, cover: 'v2' })
    // MARCA FRESCA: se a captura mostrar a cor NOVA, o compositor está vivo;
    // se mostrar a cor de um modo anterior, o quadro está congelado.
    let staged = null
    try {
      staged = await call('stage', { key: 'v1', color: palette[mode], label: mode })
    } catch (e) {
      staged = { error: String(e.message).slice(0, 120) }
    }
    await sleep(450)
    const live = await call('live', { key: 'v1' }).catch((e) => ({ error: String(e.message).slice(0, 120) }))
    const row = {
      mode,
      applied: applied.applied,
      expected: palette[mode],
      stageEcho: staged.applied ?? staged.error,
      rafDelta: live.delta ?? live.error,
      methods: {}
    }
    for (const [label, body] of [
      ['capturePage', { key: 'v1', method: 'capturePage', file: `p5-${mode}-capturePage.png` }],
      ['cdp', { key: 'v1', method: 'cdp', file: `p5-${mode}-cdp.png`, opts: { format: 'png' } }],
      [
        'cdp+beyondViewport',
        { key: 'v1', method: 'cdp', file: `p5-${mode}-cdp-beyond.png`, opts: { format: 'png', captureBeyondViewport: true } }
      ],
      [
        'cdp+deviceMetrics',
        { key: 'v1', method: 'cdp', file: `p5-${mode}-cdp-metrics.png`, opts: { format: 'png' }, remedy: 'deviceMetrics' }
      ]
    ]) {
      try {
        const r = await call('capture', body)
        const buf = readFileSync(r.file)
        writeFileSync(join(SHOTS, body.file), buf)
        const facts = shotFacts(buf)
        const expect = palette[mode].match(/\d+/g).join(',')
        const fresh = facts.dominant === expect
        // `captureBeyondViewport` devolve a PÁGINA INTEIRA (rolagem toda), não
        // o viewport: o miolo da imagem cai no corpo do documento, longe do
        // #stage fixo. O teste de frescor não se aplica a ela — dizer
        // "congelado" ali seria mentira de medida.
        const fullPage = label === 'cdp+beyondViewport'
        row.methods[label] = {
          ms: Math.round(r.ms),
          ...facts,
          fresh: fullPage ? null : fresh,
          verdict: !facts.decoded
            ? 'sem PNG decodificável'
            : fullPage
              ? `página inteira ${facts.w}x${facts.h} (frescor não se aplica)`
              : facts.distinctColors <= 1
                ? 'BRANCO/MORTO'
                : fresh
                  ? 'PIXEL REAL E FRESCO'
                  : `pixel real porém CONGELADO (miolo=${facts.dominant}, esperado=${expect})`
        }
      } catch (e) {
        row.methods[label] = { error: String(e.message).slice(0, 200), verdict: 'ERRO/TIMEOUT' }
      }
    }
    row.click = await call('clickTest', { key: 'v1' }).catch((e) => ({ error: String(e.message).slice(0, 120) }))
    rows.push(row)
    log(`   ${mode.padEnd(20)} raf=${String(row.rafDelta).padEnd(5)} clique=${row.click.clicked ?? row.click.error}`)
    for (const [k, v] of Object.entries(row.methods)) log(`      ${k.padEnd(20)} ${v.verdict}`)
  }
  await call('mode', { key: 'v1', mode: 'visible' })
  report.p5_hidden = { rows }
  raw('p5-hidden-modes.json', report.p5_hidden)
}

// ——— P6 ———
async function runP6() {
  log('\n--- P6: webContents.debugger (rota B) + conflitos ---')
  const out = { kitVisivel: {}, kitEscondida: {} }
  // O kit roda DUAS vezes: numa view VISÍVEL (v3 trazida ao topo) e na mesma
  // view ESCONDIDA (detached). A diferença entre as duas é a resposta real
  // sobre dirigir um pane que o dono colapsou.
  await call('mode', { key: 'v3', mode: 'visible' })
  const kitOn = await call('kit', { key: 'v3' })
  for (const [k, v] of Object.entries(kitOn)) {
    out.kitVisivel[k] = { ok: v.ok, ms: Math.round(v.ms), value: v.value ?? v.error }
    log(`   [visível]   ${k.padEnd(38)} ${v.ok ? 'OK' : 'FALHOU'}  ${JSON.stringify(v.value ?? v.error).slice(0, 80)}`)
  }
  await call('mode', { key: 'v3', mode: 'detached' })
  const kitOff = await call('kit', { key: 'v3' })
  for (const [k, v] of Object.entries(kitOff)) {
    out.kitEscondida[k] = { ok: v.ok, ms: Math.round(v.ms), value: v.value ?? v.error }
    log(`   [escondida] ${k.padEnd(38)} ${v.ok ? 'OK' : 'FALHOU'}  ${JSON.stringify(v.value ?? v.error).slice(0, 80)}`)
  }
  // A matriz do INPUT nos três jeitos de esconder um pane — é o que decide se
  // o agente pode trabalhar com o dock fechado.
  out.inputEscondida = {}
  for (const modo of ['detached', 'set-visible-false', 'offscreen-attached']) {
    const m = await call('hiddenInputMatrix', { key: 'v3', mode: modo })
    out.inputEscondida[modo] = m
    const linha = ['aPaginaJaPintada', 'bAposNavegarEscondida', 'cMesmaPaginaComFolga', 'dAposUmPiscarVisivel']
      .map((k) => `${k.replace(/^[a-d]/, '')}=${m[k].clicked}`)
      .join(' · ')
    log(`   [input ${modo.padEnd(18)}] ${linha}`)
  }
  await call('mode', { key: 'v1', mode: 'visible' })

  // conflito 1: devtools aberto × debugger, nas DUAS ordens
  await call('detach', { key: 'v3' })
  const dt = await call('devtools', { key: 'v3', action: 'open' })
  const afterDevtools = await call('attachTry', { key: 'v3' })
  const cmdWithDevtools = await call('dbgStatus', { key: 'v3' })
  await call('devtools', { key: 'v3', action: 'close' })
  await call('detach', { key: 'v3' })
  const attachFirst = await call('attachTry', { key: 'v3' })
  await call('devtools', { key: 'v3', action: 'open' })
  const survived = await call('dbgStatus', { key: 'v3' })
  await call('devtools', { key: 'v3', action: 'close' })
  out.devtoolsConflict = {
    devtoolsOpened: dt.opened,
    ordem1_devtoolsDepoisAttach: { attach: afterDevtools, comando: cmdWithDevtools },
    ordem2_attachDepoisDevtools: { attach: attachFirst, apósAbrirDevtools: survived }
  }
  log(`   devtools aberto -> attach: ${JSON.stringify(afterDevtools)} · comando: ${JSON.stringify(cmdWithDevtools)}`)
  log(`   attach -> devtools aberto: ${JSON.stringify(survived)}`)

  // conflito 2: playwright (proxy) e webContents.debugger no MESMO alvo.
  // O `detachFirst` é obrigatório: a rodada anterior desta sonda mediu um
  // "Debugger is already attached" que era do PRÓPRIO bench, não do playwright
  // — e teria virado um veredito falso de conflito.
  if (pwPage) {
    const both = { debuggerAttached: null, playwrightStillDrives: null, mainEvalWhilePwAttached: null }
    const att = await call('attachTry', { key: 'v1', detachFirst: true })
    both.debuggerAttached = att
    try {
      await pwPage.click('#btn')
      both.playwrightStillDrives = await pwPage.textContent('#out')
    } catch (e) {
      both.playwrightStillDrives = 'ERRO: ' + String(e.message).slice(0, 160)
    }
    try {
      const r = await call('read', { key: 'v1', kind: 'innerText', samples: 1 })
      both.mainEvalWhilePwAttached = `ok (${r.bytes} bytes)`
    } catch (e) {
      both.mainEvalWhilePwAttached = 'ERRO: ' + String(e.message).slice(0, 160)
    }
    out.coexistence = both
    log(`   playwright + webContents.debugger no mesmo alvo: ${JSON.stringify(both)}`)
  }

  // conflito 3: target NOVO nasce enquanto o playwright está atacado —
  // o auto-attach pausa a página nova e o proxy tem de absorver.
  if (pwPage) {
    const t0 = Date.now()
    const created = await call('newView', { key: 'v4', nodes: 80 })
    const ms = Date.now() - t0
    const pingAfter = await call('ping')
    out.newTargetWhileDriverAttached = {
      ms,
      created: created.created,
      appResponsive: pingAfter.alive,
      absorbedByProxy: proxy.state.absorbedAttaches.length,
      obs: ms > 4000 ? 'SUSPEITA DE CONGELAMENTO (auto-attach pausou o alvo novo)' : 'sem congelamento'
    }
    log(`   view nova com driver atacado: ${ms}ms · ${out.newTargetWhileDriverAttached.obs}`)
  }
  report.p6_debugger = out
  raw('p6-debugger.json', out)
}

// ——— P7: a ROTA A DE VERDADE — `@playwright/mcp --cdp-endpoint <proxy>` ———
// P2 provou que o playwright ENXERGA e dirige. Isto aqui mede o que o AGENTE
// sente: quanto custa o servidor subir, qual catálogo ele publica (a lista que
// teria de entrar no `--allowedTools` do claude e nos `-c mcp_servers.*` do
// codex) e qual o tamanho da resposta que volta para o contexto do modelo.

function mcpStdio(cmd, args, env, cwd) {
  const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const pending = new Map()
  const stderr = []
  let nextId = 1
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    }
  })
  child.stderr.on('data', (d) => stderr.push(d.toString()))
  return {
    child,
    stderr,
    request(method, params, timeoutMs = 45000) {
      const id = nextId++
      return new Promise((res) => {
        pending.set(id, res)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n')
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            res({ error: { message: `TIMEOUT ${timeoutMs}ms` } })
          }
        }, timeoutMs)
      })
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n')
    }
  }
}

async function runP7() {
  log('\n--- P7: @playwright/mcp --cdp-endpoint <proxy> (a rota A que o agente vê) ---')
  const cli = join(PW_DIR, 'node_modules', '@playwright', 'mcp', 'cli.js')
  if (!existsSync(cli)) {
    log('   instalando @playwright/mcp no scratch...')
    spawnSync('npm', ['install', '@playwright/mcp', '--no-audit', '--no-fund'], {
      cwd: PW_DIR,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      shell: process.platform === 'win32',
      encoding: 'utf-8'
    })
  }
  if (!existsSync(cli)) {
    report.p7_playwrightMcp = { skipped: '@playwright/mcp indisponível no scratch' }
    return
  }
  // PREPARO do cenário: v1 VISÍVEL; v2 já pintada e depois COLAPSADA
  // (setVisible(false) — o caso real do dock fechado); v3 DETACHED de berço.
  await call('mode', { key: 'v2', mode: 'visible' })
  await sleep(500)
  await call('mode', { key: 'v2', mode: 'set-visible-false' })
  await call('mode', { key: 'v1', mode: 'visible', cover: 'v3' })
  await sleep(300)

  const out = { version: null, startupMs: null, tools: [], calls: {}, adopted: null }
  const t0 = Date.now()
  const srv = mcpStdio(
    process.execPath,
    [cli, '--cdp-endpoint', proxy.endpoint, '--cdp-timeout', '20000'],
    { ...process.env },
    PW_DIR
  )
  const init = await srv.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'synkora-probe', version: '0.0.1' }
  })
  out.startupMs = Date.now() - t0
  out.version = init.result?.serverInfo ?? init.error ?? null
  srv.notify('notifications/initialized', {})
  const tl = await srv.request('tools/list', {})
  out.tools = (tl.result?.tools ?? []).map((t) => t.name)
  out.toolCount = out.tools.length
  // O esquema é a fonte: a forma dos argumentos do clique MUDOU entre versões
  // (0.0.79 recusou `{element, ref}` com "expected string ... at target"), e
  // adivinhar a forma é como o agente perde uma rodada inteira.
  out.schemas = Object.fromEntries(
    (tl.result?.tools ?? [])
      .filter((t) => ['browser_click', 'browser_take_screenshot', 'browser_snapshot'].includes(t.name))
      .map((t) => [t.name, t.inputSchema])
  )
  raw('p7-tool-schemas.json', out.schemas)
  log(`   subiu em ${out.startupMs}ms · ${out.toolCount} ferramentas`)

  const callTool = async (name, args, label) => {
    const t = Date.now()
    const r = await srv.request('tools/call', { name, arguments: args ?? {} })
    const text = JSON.stringify(r.result?.content ?? r.error ?? {})
    const entry = {
      ms: Date.now() - t,
      bytes: Buffer.byteLength(text, 'utf8'),
      isError: !!r.result?.isError || !!r.error,
      head: text.slice(0, 240)
    }
    out.calls[label ?? name] = entry
    log(`   ${(label ?? name).padEnd(34)} ${entry.ms}ms  ${entry.bytes}B  ${entry.isError ? 'ERRO' : 'ok'}`)
    return { r, entry }
  }

  // 1) o primeiro toque (é aqui que ele conecta no CDP de verdade)
  let first = await callTool('browser_snapshot', {}, 'browser_snapshot (1o, com conexao)')
  if (first.entry.isError) {
    // A hipótese: o driver quis CRIAR a própria página e o proxy fechou.
    note(`primeiro snapshot falhou com createTarget fechado: ${first.entry.head.slice(0, 160)}`)
    proxy.state.allowCreate = true
    first = await callTool('browser_snapshot', {}, 'browser_snapshot (2a tentativa, createTarget liberado)')
    out.neededCreateTarget = !first.entry.isError
  } else {
    out.neededCreateTarget = false
  }

  // Quais abas ele enxerga (só as 3 da missão?) e em qual índice está a VISÍVEL
  const textOf = (res) =>
    (res?.result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
  const tabs = await callTool('browser_tabs', { action: 'list' }, 'browser_tabs list')
  const tabsText = textOf(tabs.r)
  out.tabsVistas = tabsText.slice(0, 400)
  out.enxergaJanelaDoApp = /app-window/.test(tabsText)
  const idxOf = (marker) => {
    const m = tabsText.match(new RegExp('- (\\d+):[^\\n]*' + marker))
    return m ? Number(m[1]) : null
  }
  const idxVisivel = idxOf('view=v1')
  const idxColapsada = idxOf('view=v2')
  const idxDetached = idxOf('view=v3')
  out.indices = { visivel: idxVisivel, colapsada: idxColapsada, detached: idxDetached }

  // 2) MATRIZ do screenshot: aba VISÍVEL × aba ESCONDIDA (v2 nasce detached).
  if (idxVisivel != null) await callTool('browser_tabs', { action: 'select', index: idxVisivel }, 'browser_tabs select(visivel)')
  const warm = await callTool('browser_snapshot', {}, 'browser_snapshot (quente, aba visivel)')
  const shot = await callTool('browser_take_screenshot', { type: 'png' }, 'screenshot png (aba VISIVEL)')
  await callTool('browser_take_screenshot', { type: 'jpeg' }, 'screenshot jpeg (aba VISIVEL)')

  // 3) o clique de verdade, pelo `ref` do snapshot (o ciclo do agente)
  const snapText = textOf(warm.r) || textOf(first.r)
  const refMatch = snapText.match(/button "acionar"[^\]]*\[ref=(e\d+)\]/) ?? snapText.match(/\[ref=(e\d+)\]/)
  out.refUsado = refMatch?.[1] ?? null
  if (refMatch && out.tools.includes('browser_click')) {
    const ref = refMatch[1]
    const formas = [
      ['{element, ref}', { element: 'botao acionar', ref }],
      ['{target:{ref,element}}', { target: { ref, element: 'botao acionar' } }],
      ['{target: ref}', { target: ref }]
    ]
    for (const [nome, args] of formas) {
      const c = await callTool('browser_click', args, `browser_click ${nome}`)
      if (!c.entry.isError) {
        out.claudeClickShape = nome
        break
      }
      note(`browser_click ${nome} recusado: ${c.entry.head.slice(0, 160)}`)
    }
  }

  if (out.tools.includes('browser_navigate'))
    await callTool(
      'browser_navigate',
      { url: `http://127.0.0.1:${PAGES_PORT}/page?view=v1&nodes=400` },
      'browser_navigate'
    )

  // 4) a ARMADILHA pela porta da rota A: as DUAS formas de esconder.
  for (const [rotulo, idx] of [
    ['COLAPSADA (attached+setVisible(false))', idxColapsada],
    ['DETACHED (fora da janela)', idxDetached]
  ]) {
    if (idx == null) continue
    await callTool('browser_tabs', { action: 'select', index: idx }, `browser_tabs select(${rotulo})`)
    await callTool('browser_snapshot', {}, `browser_snapshot (aba ${rotulo})`)
    await callTool('browser_take_screenshot', { type: 'png' }, `screenshot png (aba ${rotulo})`)
  }
  out.screenshotVisivelOk = !shot.entry.isError

  out.adopted = proxy.state.adopted
  out.proxyBlockedDuringMcp = proxy.state.blockedAttempts.length
  out.stderrTail = srv.stderr.join('').slice(-800)
  killTree(srv.child.pid)

  // 5) o teto de 5s é do PRÓPRIO servidor (`--timeout-action`, default 5000ms).
  // Levantar o teto salva a aba DETACHED (a única que falhou)?
  if (idxDetached != null) {
    const srv2 = mcpStdio(
      process.execPath,
      [cli, '--cdp-endpoint', proxy.endpoint, '--cdp-timeout', '20000', '--timeout-action', '30000'],
      { ...process.env },
      PW_DIR
    )
    await srv2.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'synkora-probe', version: '0.0.1' }
    })
    srv2.notify('notifications/initialized', {})
    // o índice sai da lista DESTE servidor — a ordem das abas não é contrato
    const lst = await srv2.request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } })
    const lstText = (lst.result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    const m = lstText.match(new RegExp('- (\\d+):[^\\n]*view=v3'))
    const idx2 = m ? Number(m[1]) : idxDetached
    await srv2.request('tools/call', { name: 'browser_tabs', arguments: { action: 'select', index: idx2 } })
    const t = Date.now()
    const r = await srv2.request('tools/call', { name: 'browser_take_screenshot', arguments: { type: 'png' } })
    const txt = JSON.stringify(r.result?.content ?? r.error ?? {})
    const label = 'screenshot DETACHED com --timeout-action=30000'
    out.calls[label] = {
      ms: Date.now() - t,
      bytes: Buffer.byteLength(txt, 'utf8'),
      isError: !!r.result?.isError || !!r.error,
      head: txt.slice(0, 200)
    }
    log(`   ${label}: ${out.calls[label].ms}ms · ${out.calls[label].isError ? 'ERRO' : 'ok'}`)
    killTree(srv2.child.pid)
  }
  report.p7_playwrightMcp = out
  raw('p7-playwright-mcp.json', out)
}

// ——— P8: a FIAÇÃO nos DOIS CLIs (requisito nº 1 do dono) ———
// A rota A precisa de um SEGUNDO servidor MCP por pane. No claude isso é uma
// chave a mais num JSON (sem shell no caminho). No codex é `-c`, e é aí que
// mora a armadilha da casa: os overrides viajam por `spawn(..., shell: true)`,
// que não escapa nada.
async function runP8() {
  log('\n--- P8: declarar um 2o servidor MCP nos dois CLIs ---')
  const out = { codex: {}, claude: {} }
  const cli = join(PW_DIR, 'node_modules', '@playwright', 'mcp', 'cli.js').replace(/\\/g, '/')
  const endpoint = proxy?.endpoint ?? 'http://127.0.0.1:9999'
  const run = (args, opts = {}) =>
    spawnSync('codex', args, {
      shell: true,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env },
      ...opts
    })

  // (1) o array TOML pela forma da casa
  const a = run([
    '-c',
    'mcp_servers.synkbrowser.command=node',
    '-c',
    `mcp_servers.synkbrowser.args=["${cli}","--cdp-endpoint","${endpoint}"]`,
    'mcp',
    'list'
  ])
  out.codex.arrayViaShell = {
    status: a.status,
    stderr: (a.stderr || '').slice(0, 400).trim(),
    ok: a.status === 0
  }
  log(`   codex args=[...] via shell:true -> status=${a.status} · ${out.codex.arrayViaShell.stderr.split('\n')[0]}`)

  // A linha da tabela do `codex mcp list` é o recibo (o formato 0.151 é uma
  // tabela; procurar a palavra "enabled" solta pegaria o cabeçalho).
  const rowOf = (r) => {
    const line = `${r.stdout || ''}`.split('\n').find((l) => /synkbrowser/.test(l))
    return line ? line.replace(/\s{2,}/g, ' | ').trim() : null
  }

  // (2) REMÉDIO 1 — o que a casa já tinha (demolido na limpa F6): wrapper .cmd
  // de uma linha, que reduz a config a UMA string escalar.
  const wrapper = join(APP_DIR, 'synkbrowser-mcp.cmd')
  writeFileSync(wrapper, `@echo off\r\nnode "${cli}" --cdp-endpoint "${endpoint}" %*\r\n`, 'utf-8')
  const b = run(['-c', `mcp_servers.synkbrowser.command=${wrapper.replace(/\\/g, '/')}`, 'mcp', 'list'])
  out.codex.wrapperCmd = { status: b.status, row: rowOf(b), enabled: /enabled/i.test(rowOf(b) ?? '') }
  log(`   codex wrapper .cmd -> status=${b.status} · ${out.codex.wrapperCmd.row}`)

  // (3) REMÉDIO 2 — o mesmo array SEM shell. Mede se o culpado é o cmd.exe.
  const c = spawnSync(
    'codex',
    [
      '-c',
      'mcp_servers.synkbrowser.command=node',
      '-c',
      `mcp_servers.synkbrowser.args=["${cli}","--cdp-endpoint","${endpoint}"]`,
      'mcp',
      'list'
    ],
    { shell: false, encoding: 'utf-8', timeout: 60_000 }
  )
  out.codex.arraySemShell = {
    status: c.status,
    spawnError: c.error ? String(c.error.code ?? c.error.message) : null,
    row: rowOf(c),
    enabled: /enabled/i.test(rowOf(c) ?? '')
  }
  log(`   codex args=[...] via shell:false -> status=${c.status} · ${out.codex.arraySemShell.row}`)

  // (4) claude: o arquivo de config aceita N servidores e NÃO passa por shell.
  const file = join(APP_DIR, 'claude-dois-servidores.json')
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        synkora: { type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer <token>' } },
        synkbrowser: { command: 'node', args: [cli, '--cdp-endpoint', endpoint] }
      }
    }),
    'utf-8'
  )
  writeFileSync(join(OUT_DIR, 'p8-claude-dois-servidores.json'), readFileSync(file))
  out.claude = {
    caminho: 'arquivo JSON por pane (writeClaudeMcpConfig) — sem shell no caminho',
    custo: 'as 24 tools do playwright-mcp entram em --allowedTools, senão cada uma vira card de permissão para o dono',
    exemplo: 'p8-claude-dois-servidores.json'
  }
  report.p8_dualCli = out
  raw('p8-dual-cli.json', out)
}

main()
  .catch((e) => {
    report.errors.push(String(e?.stack ?? e))
    console.error('\n!!! SONDA FALHOU:', e?.stack ?? e)
  })
  .finally(async () => {
    raw('summary.json', report)
    await cleanup()
    log('\n[limpeza] electron morto pelo PID, scratch ' + (KEEP ? 'preservado' : 'apagado'))
    process.exit(report.errors.length ? 1 : 0)
  })

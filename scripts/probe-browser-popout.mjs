// SONDA — o POP-OUT do browser da missão (destacar o painel em janela própria).
//
// Por que existe: o dono quer arrancar o browser embutido da missão para uma
// JANELA PRÓPRIA (como o mini overlay do SynVoice), com função INTEIRA, e
// encaixar de volta. A arquitetura inteira depende de UMA pergunta que a sonda
// anterior (`PROBE_BROWSER_CDP_2026-08-29.md`) NÃO respondeu:
//
//   uma WebContentsView VIVA pode ser REPARENTADA entre BrowserWindows sem
//   matar a página?
//
// O que a sonda anterior provou e vale como lei de partida (P5 de lá):
//   · view DETACHED (`removeChildView`) = rAF 0, `capturePage` PENDURA 5 s,
//     CDP screenshot PENDURA 8 s, input navegado cai no vazio;
//   · reanexar na MESMA janela recupera tudo.
// O que ela NUNCA sondou: reanexar em OUTRA janela. É o buraco desta aqui.
//
// Perguntas (uma por bloco, cada uma com número cru):
//   P1 REPARENTAR — remove de A + add em B (e a variante de UM passo: add em B
//      direto, sem remover de A). Renderiza em B? Quantos ms de buraco (rAF
//      maxGap + ms até PIXEL FRESCO em B)? Aguenta 10 idas e voltas?
//   P2 A PÁGINA SOBREVIVE — scroll, valor de formulário digitado, timers
//      (setInterval + rAF), nonce de carga (prova de que NÃO recarregou),
//      contadores de EventSource e WebSocket abertos antes do gesto.
//   P3 CAPTURA — `capturePage` (latência e FRESCOR pela cor dominante do miolo,
//      técnica da casa) logo após o gesto e em regime na janela B; e o
//      `webContents.debugger`: a sessão CDP sobrevive à mudança de janela?
//   P4 OS ESTADOS ESCONDIDOS de uma janela secundária — minimizada, ocluída por
//      outra janela, `hide()`, e uma janela nascida com `show:false` +
//      `showInactive()`. Onde a captura PENDURA, e qual é o guarda BARATO que o
//      gerente consulta antes de capturar (tabela-verdade + custo).
//   P5 INPUT + CROMO — a janela B também tem renderer próprio (a barra da
//      janela), com a view composta por cima de um retângulo. Os dois são
//      dirigíveis? A ordem de pintura (z-order) se comporta como na janela
//      principal? `win.webContents.capturePage()` compõe a view filha?
//   P6 BORDAS DE CICLO DE VIDA — fechar B com a view ainda anexada mata o
//      webContents? Se `removeChildView` no 'close', a view sobrevive e volta a
//      encaixar em A (o caminho do DOCK-BACK)? E o X da barra de tarefas no meio
//      de uma navegação: o que o driver vê?
//
// Uso:
//   node scripts/probe-browser-popout.mjs                # tudo
//   node scripts/probe-browser-popout.mjs --loops 10     # idas e voltas do P1
//   node scripts/probe-browser-popout.mjs --samples 12   # amostras de latência
//   node scripts/probe-browser-popout.mjs --keep         # não limpa o scratch
//   node scripts/probe-browser-popout.mjs --headed=false # janelas ocultas
//
// Não toca em src/. Não roda o app do dono: sobe um electron PRÓPRIO a partir de
// um main.js descartável em %TEMP%/synkora-probe-popout (apagado no fim, salvo
// --keep) e mata o filho PELO PID (taskkill /T, NUNCA por nome de imagem).
// Evidência crua em .tmp/probe-browser-popout/.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-browser-popout')
const SHOTS = join(OUT_DIR, 'shots')
const SCRATCH = join(tmpdir(), 'synkora-probe-popout')
const APP_DIR = join(SCRATCH, 'app')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return i >= 0 ? 'true' : dflt
}
const LOOPS = Number(flag('loops', '10'))
const SAMPLES = Number(flag('samples', '12'))
const KEEP = flag('keep', 'false') === 'true'
const HEADED = flag('headed', 'true') !== 'false'
const PAGES_PORT = Number(flag('pages-port', '0')) || 9700 + (process.pid % 200)

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
mkdirSync(APP_DIR, { recursive: true })

const requireRepo = createRequire(join(REPO, 'package.json'))
const ELECTRON_BIN = requireRepo('electron')
const { WebSocketServer } = requireRepo('ws')

const report = {
  probedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  electron: requireRepo('electron/package.json').version,
  pagesPort: PAGES_PORT,
  loops: LOOPS,
  samples: SAMPLES,
  p1_reparent: null,
  p2_survive: null,
  p3_capture: null,
  p4_hidden: null,
  p5_coexist: null,
  p6_lifecycle: null,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 100) / 100
}
const stat = (xs) => ({
  n: xs.length,
  median: median(xs),
  min: Math.round(Math.min(...xs) * 100) / 100,
  max: Math.round(Math.max(...xs) * 100) / 100,
  p90: [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]
})

// ————————————————————————————————————————————————————————————————
// 1. as PÁGINAS — a página VIVA da missão (é ela que tem de sobreviver)
// ————————————————————————————————————————————————————————————————

/** A página da sonda carrega TODO tipo de estado que um pop-out pode perder:
 *  · rAF contando (e medindo o MAIOR buraco entre quadros — é assim que se mede
 *    o "engasgo" do gesto sem depender de olho);
 *  · setInterval (timer de renderer: morre se o processo for congelado);
 *  · scroll de documento E de container;
 *  · <input> com valor DIGITADO (não atribuído — digitar passa pelo Blink);
 *  · EventSource e WebSocket abertos ANTES do gesto;
 *  · um nonce sorteado no load: se ele mudar, a página RECARREGOU. */
function pageHtml(nodes) {
  const cards = []
  for (let i = 0; i < nodes; i++) {
    cards.push(
      `<article class="card"><h3>Card ${i}</h3><p>Linha ${i} com texto suficiente para o documento rolar de verdade.</p></article>`
    )
  }
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>PAGINA VIVA DA MISSAO</title>
<style>
 html,body{margin:0;font:13px/1.5 Consolas,monospace;background:#efe9dc;color:#26241f}
 /* o cabeçalho da PÁGINA tem cor PRÓPRIA (rgb(20,90,140)): é ele que prova a
    ordem de pintura no retrato composto pelo SO (desktopCapturer) — se o
    cabeçalho da página aparecer ACIMA do cabeçalho do cromo, a view está por
    cima. Se fosse a mesma cor do cromo, a prova não existiria. */
 header{position:sticky;top:0;padding:10px 14px;background:rgb(20,90,140);color:#efe9dc;display:flex;gap:10px;align-items:center;z-index:5}
 #scroller{height:180px;overflow:auto;border:1px solid #26241f;margin:10px}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:10px}
 .card{border:1px solid #26241f;padding:8px;background:#fff}
 /* o #stage NAO tem texto: glifo antialiasado no miolo estraga a prova por pixel */
 #stage{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:240px;height:240px;
        background:rgb(217,108,63);z-index:9999}
</style></head><body>
<header><strong>PAGINA VIVA</strong><input id="q" placeholder="digite"><button id="btn">acionar</button>
<output id="out">idle</output><span id="raf">0</span></header>
<div id="scroller">${cards.slice(0, 60).join('')}</div>
<div class="grid">${cards.join('')}</div>
<div id="stage"></div>
<script>
 window.__nonce = 'N' + Math.random().toString(36).slice(2, 12)
 var raf = 0, tick = 0, maxGap = 0, last = performance.now(), visChanges = [], sse = 0, sseLast = null, wsN = 0, wsLast = null
 var el = document.getElementById('raf')
 ;(function loop(){ var t = performance.now(); var g = t - last; if (g > maxGap) maxGap = g; last = t
   raf++; el.textContent = String(raf); requestAnimationFrame(loop) })()
 setInterval(function(){ tick++ }, 100)
 document.addEventListener('visibilitychange', function(){ visChanges.push(document.visibilityState) })
 var es = new EventSource('/sse'); es.onmessage = function(e){ sse++; sseLast = e.data }
 var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws')
 ws.onmessage = function(e){ wsN++; wsLast = e.data }
 document.getElementById('btn').addEventListener('click', function(){ document.getElementById('out').textContent = 'CLICADO' })
 window.__resetGap = function(){ maxGap = 0; last = performance.now(); return true }
 window.__state = function(){ return {
   nonce: window.__nonce, raf: raf, tick: tick, maxGapMs: Math.round(maxGap * 100) / 100,
   docScroll: Math.round(document.scrollingElement.scrollTop),
   boxScroll: Math.round(document.getElementById('scroller').scrollTop),
   input: document.getElementById('q').value,
   sse: { count: sse, last: sseLast, readyState: es.readyState },
   ws: { count: wsN, last: wsLast, readyState: ws.readyState },
   visibility: document.visibilityState, visChanges: visChanges.slice(-6),
   hasFocus: document.hasFocus(), url: location.href, dpr: window.devicePixelRatio,
   size: [window.innerWidth, window.innerHeight]
 } }
</script></body></html>`
}

/** O CROMO da janela: o renderer PRÓPRIO de cada BrowserWindow (a barra do
 *  pop-out no desenho da casa). Fundo de cor única para a prova de composição. */
function chromeHtml(which, bg) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>SONDA ${which}</title>
<style>
 html,body{margin:0;height:100%;font:12px Consolas,monospace;background:${bg};color:#efe9dc}
 header{height:48px;display:flex;gap:10px;align-items:center;padding:0 12px;background:#26241f;border-bottom:2px solid #d96c3f}
 button{font:12px Consolas,monospace;text-transform:uppercase}
</style></head><body>
<header><strong>JANELA ${which}</strong><button id="chromeBtn">botao do cromo</button><output id="out">idle</output><span id="raf">0</span></header>
<script>
 var n = 0; var el = document.getElementById('raf')
 ;(function loop(){ n++; el.textContent = String(n); requestAnimationFrame(loop) })()
 document.getElementById('chromeBtn').addEventListener('click', function(){ document.getElementById('out').textContent = 'CROMO-CLICADO' })
 window.__chrome = function(){ return { raf: n, out: document.getElementById('out').textContent, which: '${which}' } }
</script></body></html>`
}

// ————————————————————————————————————————————————————————————————
// 2. o MAIN.JS descartável (nasce e morre no scratch; fala por HTTP local)
//    ATENÇÃO: nada de crase nem de interpolação aqui dentro — é template.
// ————————————————————————————————————————————————————————————————

const MAIN_JS = `// main descartavel da SONDA POP-OUT (nao e produto).
const { app, BrowserWindow, WebContentsView, screen, desktopCapturer } = require('electron')
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
const CHROME_H = 48

const wins = {}        // key -> BrowserWindow
const winMeta = {}     // key -> { closed, destroyedAt, bounds }
let pageView = null
let altView = null     // view IRMA com backgroundThrottling DEFAULT (a variavel suspeita)
let altHost = null
let host = null        // em qual janela a view esta anexada agora
let colorSeed = 0
const nav = { didStartNavigation: 0, didFinishLoad: 0, didStartLoading: 0, didStopLoading: 0, renderProcessGone: 0, destroyed: 0, dbgDetach: 0 }
const events = []      // diario cru de eventos do webContents da view

function rec(kind, extra) { events.push(Object.assign({ t: Date.now(), kind: kind }, extra || {})) }

function withTimeout(p, ms, label) {
  let to = null
  const timer = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('TIMEOUT ' + label + ' ' + ms + 'ms')), ms) })
  return Promise.race([p, timer]).finally(() => clearTimeout(to))
}

function layout() {
  const wa = screen.getPrimaryDisplay().workArea
  const w = Math.min(940, Math.floor((wa.width - 60) / 2))
  const h = Math.min(760, wa.height - 80)
  return {
    A: { x: wa.x + 20, y: wa.y + 30, width: w, height: h },
    B: { x: wa.x + 30 + w, y: wa.y + 30, width: w, height: h - 60 }
  }
}

function makeWindow(key, opts) {
  const base = layout()[key]
  const L = base || (function () {
    const b = layout().B
    return { x: b.x + 60, y: b.y + 70, width: b.width - 80, height: b.height - 80 }
  })()
  const win = new BrowserWindow({
    x: L.x, y: L.y, width: L.width, height: L.height,
    show: false,
    title: 'SONDA-POPOUT-' + key,
    backgroundColor: '#101010',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  })
  // o <title> da pagina SEQUESTRA o titulo da janela — e o titulo e a unica
  // chave que o desktopCapturer da para achar a NOSSA janela entre as do dono.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.loadURL(PAGES + '/chrome?win=' + key)
  winMeta[key] = { closed: false, createdAt: Date.now(), showMode: (opts && opts.showMode) || 'showInactive' }
  win.on('close', () => { rec('win-close', { win: key }); winMeta[key].closed = true })
  win.on('closed', () => { rec('win-closed', { win: key }) })
  wins[key] = win
  if (!HEADED) return win
  if (opts && opts.show === false) return win
  // showInactive de proposito: a sonda NAO rouba o foco do dono
  win.showInactive()
  return win
}

function viewRect(key, overChrome) {
  const win = wins[key]
  const b = win.getContentBounds()
  if (overChrome) return { x: 0, y: 0, width: b.width, height: b.height }
  return { x: 0, y: CHROME_H, width: b.width, height: Math.max(1, b.height - CHROME_H) }
}

function makePageView() {
  const v = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const wc = v.webContents
  wc.on('did-start-navigation', (_e, url) => { nav.didStartNavigation++; rec('did-start-navigation', { url: String(url).slice(0, 120) }) })
  wc.on('did-finish-load', () => { nav.didFinishLoad++; rec('did-finish-load') })
  wc.on('did-start-loading', () => { nav.didStartLoading++ })
  wc.on('did-stop-loading', () => { nav.didStopLoading++ })
  wc.on('render-process-gone', (_e, d) => { nav.renderProcessGone++; rec('render-process-gone', { reason: d && d.reason }) })
  wc.on('destroyed', () => { nav.destroyed++; rec('wc-destroyed') })
  wc.debugger.on('detach', (_e, reason) => { nav.dbgDetach++; rec('debugger-detach', { reason: String(reason) }) })
  return v
}

function dbg() {
  if (!pageView || pageView.webContents.isDestroyed()) throw new Error('a view esta morta')
  const d = pageView.webContents.debugger
  if (!d.isAttached()) d.attach('1.3')
  return d
}

async function evalPage(expression) {
  const d = dbg()
  const r = await d.sendCommand('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: false })
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result ? r.result.value : null
}

async function evalChrome(key, expression) {
  return wins[key].webContents.executeJavaScript(expression, true)
}

// ——— fatos por BITMAP (a prova honesta de "saiu pixel de verdade e FRESCO").
// Nada de PNG no laco quente: capturePage devolve NativeImage e toBitmap() ja
// entrega BGRA cru — decodificar PNG a cada amostra falsearia a latencia.
function bmpFacts(img) {
  if (!img || img.isEmpty()) return { empty: true }
  const size = img.getSize()
  const buf = img.toBitmap()
  if (!buf || !buf.length || !size.height) return { empty: true, size: size }
  const stride = Math.floor(buf.length / size.height)
  const px = Math.floor(stride / 4)
  const at = (x, y) => { const i = y * stride + x * 4; return [buf[i + 2], buf[i + 1], buf[i]] }
  const counts = new Map()
  const stepX = Math.max(1, Math.floor(px / 24))
  const stepY = Math.max(1, Math.floor(size.height / 24))
  let total = 0
  for (let y = 0; y < size.height; y += stepY)
    for (let x = 0; x < px; x += stepX) {
      const k = at(x, y).join(',')
      counts.set(k, (counts.get(k) || 0) + 1)
      total++
    }
  let dominant = null, best = 0
  for (const e of counts) if (e[1] > best) { best = e[1]; dominant = e[0] }
  return {
    empty: false, size: size, bitmapPx: [px, size.height],
    dominant: dominant, dominantShare: total ? Math.round((best / total) * 100) : 0,
    distinctColors: counts.size
  }
}

/** Varre um retrato COMPOSTO PELO SO (desktopCapturer) atras de cores
 *  conhecidas: quantas vezes cada uma aparece e em que linha ela aparece pela
 *  PRIMEIRA vez. E assim que se prova ordem de pintura sem depender de moldura:
 *  se o cabecalho da PAGINA aparece acima do cabecalho do CROMO, a view esta
 *  por cima. Comparar por tolerancia porque a miniatura passa por reescala. */
function colorScan(img, palette, tol) {
  if (!img || img.isEmpty()) return { empty: true }
  const size = img.getSize()
  const buf = img.toBitmap()
  const stride = Math.floor(buf.length / size.height)
  const px = Math.floor(stride / 4)
  const out = {}
  for (const name of Object.keys(palette)) out[name] = { count: 0, topY: null, topYFrac: null }
  const t = tol || 12
  for (let y = 0; y < size.height; y += 2) {
    for (let x = 0; x < px; x += 3) {
      const i = y * stride + x * 4
      const r = buf[i + 2], g = buf[i + 1], b = buf[i]
      for (const name of Object.keys(palette)) {
        const p = palette[name]
        if (Math.abs(r - p[0]) <= t && Math.abs(g - p[1]) <= t && Math.abs(b - p[2]) <= t) {
          const e = out[name]
          e.count++
          if (e.topY === null) { e.topY = y; e.topYFrac = Math.round((y / size.height) * 1000) / 1000 }
        }
      }
    }
  }
  return { empty: false, size: size, bitmapPx: [px, size.height], achados: out }
}

function near(dominant, want, tol) {
  if (!dominant || !want) return false
  const a = dominant.split(',').map(Number)
  const b = want.split(',').map(Number)
  for (let i = 0; i < 3; i++) if (Math.abs(a[i] - b[i]) > (tol || 8)) return false
  return true
}

// retangulo pequeno no MIOLO da view (dentro do #stage 240x240): capturar so
// ele deixa o laco de frescor com resolucao fina.
function centerRect() {
  const b = pageView.getBounds()
  const w = Math.min(120, Math.max(8, b.width - 2))
  const h = Math.min(120, Math.max(8, b.height - 2))
  return { x: Math.max(0, Math.round(b.width / 2 - w / 2)), y: Math.max(0, Math.round(b.height / 2 - h / 2)), width: w, height: h }
}

async function captureOnce(opts) {
  const o = opts || {}
  const timeout = o.timeoutMs || 5000
  const t0 = process.hrtime.bigint()
  let img = null, timedOut = false, error = null
  try {
    if (o.target === 'alt') img = await withTimeout(altView.webContents.capturePage(o.rect || undefined), timeout, 'captureAlt')
    else if (o.target === 'winChrome') img = await withTimeout(wins[o.win].webContents.capturePage(o.rect || undefined), timeout, 'winCapture')
    else if (o.target === 'cdp') {
      const d = dbg()
      const r = await withTimeout(d.sendCommand('Page.captureScreenshot', { format: 'png' }), timeout, 'cdpShot')
      const ms0 = Number(process.hrtime.bigint() - t0) / 1e6
      return { ms: ms0, cdp: true, bytes: Buffer.from(r.data, 'base64').length, png: Buffer.from(r.data, 'base64') }
    } else img = await withTimeout(pageView.webContents.capturePage(o.rect || undefined), timeout, 'capturePage')
  } catch (e) {
    timedOut = /TIMEOUT/.test(String(e && e.message))
    error = String(e && e.message)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const facts = img ? bmpFacts(img) : { empty: true, missing: true }
  return { ms: ms, timedOut: timedOut, error: error, facts: facts, png: img && !img.isEmpty() ? img.toPNG() : null }
}

/** Pinta uma cor INEDITA no #stage e cronometra ate a captura devolver aquela
 *  cor. E a diferenca entre "a captura respondeu" e "a captura mostra o AGORA":
 *  quadro velho em cache responde rapido e MENTE. */
async function pollFresh(opts) {
  const o = opts || {}
  colorSeed++
  const r = (colorSeed * 53) % 200 + 20
  const g = (colorSeed * 97) % 200 + 20
  const b = (colorSeed * 31) % 200 + 20
  const want = r + ',' + g + ',' + b
  const paintedAt = Date.now()
  try {
    await withTimeout(evalPage("document.getElementById('stage').style.background='rgb(" + r + "," + g + "," + b + ")'"), o.evalTimeoutMs || 4000, 'paint')
  } catch (e) {
    return { want: want, paintMs: Date.now() - paintedAt, msToFresh: null, attempts: 0, error: 'paint: ' + String(e && e.message) }
  }
  const budget = o.budgetMs || 4000
  const deadline = Date.now() + budget
  let attempts = 0, lastFacts = null, lastMs = null
  while (Date.now() < deadline) {
    attempts++
    const shot = await captureOnce({ rect: centerRect(), timeoutMs: o.perCallTimeoutMs || 1500 })
    lastFacts = shot.facts
    lastMs = shot.ms
    if (!shot.facts.empty && near(shot.facts.dominant, want, o.tol || 10))
      return { want: want, msToFresh: Date.now() - paintedAt, attempts: attempts, captureMs: Math.round(lastMs * 100) / 100, facts: lastFacts }
    if (shot.timedOut) return { want: want, msToFresh: null, attempts: attempts, pendurou: true, captureMs: Math.round(lastMs * 100) / 100, facts: lastFacts }
  }
  return { want: want, msToFresh: null, attempts: attempts, esgotou: budget, captureMs: lastMs ? Math.round(lastMs * 100) / 100 : null, facts: lastFacts }
}

const ops = {
  async hello() {
    return {
      pid: process.pid,
      wins: Object.keys(wins).map((k) => ({ key: k, id: wins[k].id, bounds: wins[k].getBounds() })),
      viewWcId: pageView ? pageView.webContents.id : null,
      host: host,
      url: pageView ? pageView.webContents.getURL() : null
    }
  },
  async ping() { return { alive: true, windows: BrowserWindow.getAllWindows().length, at: Date.now() } },
  async state(b) {
    const key = (b && b.win) || 'B'
    const w = wins[key]
    const alive = w && !w.isDestroyed()
    return {
      win: key,
      exists: !!w, destroyed: !alive,
      visible: alive ? w.isVisible() : null,
      minimized: alive ? w.isMinimized() : null,
      focused: alive ? w.isFocused() : null,
      bounds: alive ? w.getBounds() : null,
      host: host,
      viewAlive: !!(pageView && !pageView.webContents.isDestroyed()),
      viewVisible: pageView && !pageView.webContents.isDestroyed() ? pageView.getVisible() : null,
      viewBounds: pageView && !pageView.webContents.isDestroyed() ? pageView.getBounds() : null,
      nav: Object.assign({}, nav),
      dbgAttached: pageView && !pageView.webContents.isDestroyed() ? pageView.webContents.debugger.isAttached() : null,
      // higiene do gesto de UM passo: a janela de origem fica com filho pendurado?
      filhosPorJanela: Object.keys(wins)
        .filter((k) => wins[k] && !wins[k].isDestroyed())
        .map((k) => ({ win: k, filhos: wins[k].contentView.children.length }))
    }
  },
  async pageState() { return await evalPage('JSON.stringify(window.__state())').then(JSON.parse) },
  async chromeState(b) { return await evalChrome(b.win, 'JSON.stringify(window.__chrome())').then(JSON.parse) },

  // ——— o estado que TEM de sobreviver ao gesto ———
  async seedPage(b) {
    const d = dbg()
    // digitar de VERDADE (Input do CDP), nao atribuir .value: atribuicao nao
    // passa pelo Blink e nao provaria estado de edicao.
    await evalPage("document.getElementById('q').focus(); document.getElementById('q').value=''")
    for (const ch of (b && b.text) || 'sonda-42') {
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
    await evalPage("document.scrollingElement.scrollTop=" + ((b && b.docScroll) || 900) +
      "; document.getElementById('scroller').scrollTop=" + ((b && b.boxScroll) || 420))
    await new Promise((r) => setTimeout(r, 120))
    return JSON.parse(await evalPage('JSON.stringify(window.__state())'))
  },

  // ——— P1 + P2: O GESTO, com tudo medido em volta ———
  async move(b) {
    const to = b.to
    const mode = b.mode || 'two-step'
    if (!wins[to] || wins[to].isDestroyed()) throw new Error('janela alvo inexistente: ' + to)
    const before = JSON.parse(await evalPage('JSON.stringify(window.__state())'))
    await evalPage('window.__resetGap()')
    const from = host
    const t0 = process.hrtime.bigint()
    let removeMs = 0
    if (mode === 'two-step' && from && wins[from] && !wins[from].isDestroyed()) {
      wins[from].contentView.removeChildView(pageView)
      removeMs = Number(process.hrtime.bigint() - t0) / 1e6
    }
    const tAdd = process.hrtime.bigint()
    wins[to].contentView.addChildView(pageView)
    pageView.setBounds(viewRect(to, !!b.overChrome))
    pageView.setVisible(true)
    const t1 = process.hrtime.bigint()
    const addMs = Number(t1 - tAdd) / 1e6
    const totalMs = Number(t1 - t0) / 1e6
    const tsAfter = Date.now()
    host = to

    // 1) quando a PRIMEIRA captura responde de novo (a view voltou a compor?)
    let msToFirstCapture = null, firstCaptureMs = null, firstAttempts = 0
    const deadline = Date.now() + (b.budgetMs || 4000)
    while (Date.now() < deadline) {
      firstAttempts++
      const s = await captureOnce({ rect: centerRect(), timeoutMs: 1500 })
      firstCaptureMs = Math.round(s.ms * 100) / 100
      if (!s.facts.empty) { msToFirstCapture = Date.now() - tsAfter; break }
    }
    // 2) quando o pixel fica FRESCO (cor inedita pintada depois do gesto)
    const fresh = await pollFresh({ budgetMs: b.budgetMs || 4000 })
    await new Promise((r) => setTimeout(r, b.settleMs || 400))
    const after = JSON.parse(await evalPage('JSON.stringify(window.__state())'))
    return {
      to: to, from: from, mode: mode,
      removeMs: Math.round(removeMs * 100) / 100,
      addMs: Math.round(addMs * 100) / 100,
      reparentMs: Math.round(totalMs * 100) / 100,
      msToFirstCapture: msToFirstCapture, firstCaptureMs: firstCaptureMs, firstAttempts: firstAttempts,
      msToFreshPixel: fresh.msToFresh, freshAttempts: fresh.attempts, freshWant: fresh.want, freshFacts: fresh.facts,
      freshPendurou: !!fresh.pendurou,
      rafMaxGapMs: after.maxGapMs,
      rafDelta: after.raf - before.raf,
      tickDelta: after.tick - before.tick,
      sseDelta: after.sse.count - before.sse.count,
      wsDelta: after.ws.count - before.ws.count,
      nonceIgual: after.nonce === before.nonce,
      docScroll: [before.docScroll, after.docScroll],
      boxScroll: [before.boxScroll, after.boxScroll],
      input: [before.input, after.input],
      visibility: after.visibility, visChanges: after.visChanges,
      size: [before.size, after.size],
      navDepois: Object.assign({}, nav),
      before: before, after: after
    }
  },

  async bench(b) {
    const n = (b && b.samples) || 10
    const ms = []
    let facts = null, bytes = 0
    for (let i = 0; i < 2; i++) await captureOnce({ target: b && b.target, win: b && b.win, timeoutMs: 6000 })
    for (let i = 0; i < n; i++) {
      const s = await captureOnce({ target: b && b.target, win: b && b.win, timeoutMs: 6000 })
      ms.push(Math.round(s.ms * 100) / 100)
      facts = s.facts || null
      bytes = s.png ? s.png.length : (s.bytes || 0)
      if (s.timedOut) break
    }
    return { ms: ms, facts: facts, bytes: bytes }
  },

  async capture(b) {
    const s = await captureOnce({ target: b && b.target, win: b && b.win, timeoutMs: (b && b.timeoutMs) || 5000 })
    if (b && b.file && s.png) fs.writeFileSync(path.join(OUT, b.file), s.png)
    return { ms: Math.round(s.ms * 100) / 100, timedOut: !!s.timedOut, error: s.error || null, facts: s.facts || null, bytes: s.png ? s.png.length : (s.bytes || 0), file: b && b.file ? path.join(OUT, b.file) : null }
  },

  async fresh(b) { return await pollFresh(b || {}) },

  // ——— P3: a sessao CDP atravessa a mudanca de janela? ———
  async dbgStatus() {
    const wc = pageView.webContents
    const attached = wc.debugger.isAttached()
    let evalOk = null, evalMs = null
    if (attached) {
      const t0 = process.hrtime.bigint()
      try {
        const r = await withTimeout(wc.debugger.sendCommand('Runtime.evaluate', { expression: '40+2', returnByValue: true }), 4000, 'dbgEval')
        evalOk = r.result.value
      } catch (e) { evalOk = 'ERRO: ' + String(e && e.message) }
      evalMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 100) / 100
    }
    return { attached: attached, evalOk: evalOk, evalMs: evalMs, detachEvents: nav.dbgDetach, wcId: wc.id }
  },

  // ——— P4: estados escondidos + o guarda barato ———
  async winOp(b) {
    const key = b.win || 'B'
    const w = wins[key]
    if (!w || w.isDestroyed()) return { done: false, why: 'janela destruida' }
    const t0 = process.hrtime.bigint()
    if (b.action === 'minimize') w.minimize()
    else if (b.action === 'restore') w.restore()
    else if (b.action === 'hide') w.hide()
    else if (b.action === 'show') w.show()
    else if (b.action === 'showInactive') w.showInactive()
    else if (b.action === 'focus') w.focus()
    else if (b.action === 'blur') w.blur()
    else if (b.action === 'close') w.close()
    else if (b.action === 'destroy') w.destroy()
    else if (b.action === 'moveOver') {
      const t = wins[b.over || 'B']
      if (t && !t.isDestroyed()) { const bb = t.getBounds(); w.setBounds(bb); w.focus() }
    } else if (b.action === 'restoreBounds') {
      const L = (key === 'A' || key === 'B') ? layout()[key] : null
      if (L) w.setBounds(L)
    } else throw new Error('acao desconhecida: ' + b.action)
    await new Promise((r) => setTimeout(r, b.settleMs || 500))
    const alive = wins[key] && !wins[key].isDestroyed()
    return {
      done: true, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 100) / 100,
      visible: alive ? wins[key].isVisible() : null,
      minimized: alive ? wins[key].isMinimized() : null,
      destroyed: !alive
    }
  },

  /** O guarda que o gerente consulta ANTES de capturar tem de ser barato e
   *  sincrono. Aqui esta o custo (ns por chamada) e a tabela-verdade. */
  async guardCost(b) {
    const n = (b && b.samples) || 2000
    const w = wins[(b && b.win) || 'B']
    const BW = require('electron').BrowserWindow
    const probes = {
      'BrowserWindow.fromWebContents(view.wc)': () => { const o = BW.fromWebContents(pageView.webContents); return o ? o.id : null },
      'win.isVisible()': () => w.isVisible(),
      'win.isMinimized()': () => w.isMinimized(),
      'win.isDestroyed()': () => w.isDestroyed(),
      'view.getVisible()': () => pageView.getVisible(),
      'wc.isDestroyed()': () => pageView.webContents.isDestroyed(),
      'wc.isPainting()': () => (pageView.webContents.isPainting ? pageView.webContents.isPainting() : 'n/d')
    }
    const out = {}
    for (const k of Object.keys(probes)) {
      let v = null
      const t0 = process.hrtime.bigint()
      for (let i = 0; i < n; i++) v = probes[k]()
      const total = Number(process.hrtime.bigint() - t0)
      out[k] = { valor: v, nsPorChamada: Math.round(total / n) }
    }
    return out
  },

  // ——— P5: cromo + view na mesma janela ———
  async clickChrome(b) {
    const key = b.win || 'B'
    await evalChrome(key, "document.getElementById('out').textContent='idle'")
    const r = await evalChrome(key, "(()=>{const b=document.getElementById('chromeBtn'); b.click(); return document.getElementById('out').textContent})()")
    return { out: r }
  },
  async clickPage() {
    const d = dbg()
    await evalPage("document.getElementById('out').textContent='idle'")
    const box = JSON.parse(await evalPage("(()=>{const r=document.getElementById('btn').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,w:r.width})})()"))
    const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
    await d.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base))
    await d.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base))
    await new Promise((r) => setTimeout(r, 120))
    const out = await evalPage("document.getElementById('out').textContent")
    return { rect: box, out: out, clicked: out === 'CLICADO' }
  },
  async setViewRect(b) {
    pageView.setBounds(viewRect(b.win || host, !!b.overChrome))
    await new Promise((r) => setTimeout(r, b.settleMs || 350))
    return { bounds: pageView.getBounds(), overChrome: !!b.overChrome }
  },

  /** O RETRATO COMPOSTO pelo SO: a unica captura que enxerga cromo + view na
   *  mesma imagem (capturePage e SEMPRE por webContents). Le so a NOSSA janela;
   *  das outras registra apenas a contagem — nada de nome, nada de imagem. */
  async deskShot(b) {
    const key = b.win || 'B'
    colorSeed++
    const r = (colorSeed * 53) % 200 + 20, g = (colorSeed * 97) % 200 + 20, bl = (colorSeed * 31) % 200 + 20
    try { await withTimeout(evalPage("document.getElementById('stage').style.background='rgb(" + r + "," + g + "," + bl + ")'"), 3000, 'paintDesk') } catch (e) {}
    await new Promise((res) => setTimeout(res, 260))
    const t0 = process.hrtime.bigint()
    const sources = await withTimeout(desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1200, height: 1000 } }), 12000, 'desktopCapturer')
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const alvo = sources.find((s) => s.name === 'SONDA-POPOUT-' + key) ||
      sources.find((s) => s.name.indexOf('SONDA') === 0 && s.name.indexOf(key) >= 0)
    if (!alvo) return { ms: Math.round(ms * 100) / 100, encontrou: false, janelasNaMaquina: sources.length }
    const palette = {
      cromoHeader: [38, 36, 31],
      cromoFundoB: [42, 18, 54],
      cromoFundoA: [18, 60, 42],
      paginaHeader: [20, 90, 140],
      paginaPapel: [239, 233, 220],
      stage: [r, g, bl]
    }
    // tolerancia APERTADA: com 14 a barra de menu do Electron (31,31,31) entrava
    // como se fosse o cabecalho do cromo e a leitura de topo saia contaminada.
    const scan = colorScan(alvo.thumbnail, palette, 6)
    const facts = bmpFacts(alvo.thumbnail)
    if (b && b.file) { try { fs.writeFileSync(path.join(OUT, b.file), alvo.thumbnail.toPNG()) } catch (e) {} }
    return {
      ms: Math.round(ms * 100) / 100, encontrou: true, janelasNaMaquina: sources.length,
      corDoStage: r + ',' + g + ',' + bl, facts: facts, scan: scan
    }
  },

  /** CONTROLE do gesto de dois passos: no instante em que a view esta FORA de
   *  qualquer arvore, a captura PENDURA (lei P5 da sonda anterior)? E como isso
   *  se compara com a view cuja JANELA MORREU (o caso do X do pop-out)? */
  async detachedControl(b) {
    const from = host
    if (!from || !wins[from] || wins[from].isDestroyed()) return { pulou: 'sem janela hospedeira' }
    await evalPage('window.__resetGap()')
    const antes = JSON.parse(await evalPage('JSON.stringify(window.__state())'))
    wins[from].contentView.removeChildView(pageView)
    host = null
    await new Promise((r) => setTimeout(r, (b && b.settleMs) || 400))
    const cap = await captureOnce({ timeoutMs: (b && b.timeoutMs) || 5000 })
    const cdp = await captureOnce({ target: 'cdp', timeoutMs: (b && b.cdpTimeoutMs) || 8000 })
    let evalOk = null
    try { evalOk = await withTimeout(evalPage('1+1'), 3000, 'evalDetached') } catch (e) { evalOk = 'ERRO: ' + String(e && e.message) }
    await new Promise((r) => setTimeout(r, 500))
    const depois = JSON.parse(await evalPage('JSON.stringify(window.__state())'))
    // reanexa na janela de onde saiu e mede a recuperacao
    wins[from].contentView.addChildView(pageView)
    pageView.setBounds(viewRect(from, false))
    pageView.setVisible(true)
    host = from
    const fresh = await pollFresh({ budgetMs: 4000 })
    return {
      capturePage: { ms: Math.round(cap.ms * 100) / 100, pendurou: !!cap.timedOut, vazia: cap.facts.empty, erro: cap.error || null },
      cdpShot: { ms: Math.round(cdp.ms * 100) / 100, pendurou: !!cdp.timedOut, bytes: cdp.bytes || 0, erro: cdp.error || null },
      evalContinuaRespondendo: evalOk,
      rafEm500ms: depois.raf - antes.raf,
      tickEm500ms: depois.tick - antes.tick,
      rafMaxGapMs: depois.maxGapMs,
      recuperouAoReanexar: { msToFresh: fresh.msToFresh, tentativas: fresh.attempts }
    }
  },

  /** O gesto INTEIRO como o dono sente: criar a janela do pop-out do zero,
   *  mudar a view para ela, e depois encaixar de volta e matar a janela. */
  async popoutRoundTrip(b) {
    const key = (b && b.key) || 'POP'
    if (wins[key] && !wins[key].isDestroyed()) wins[key].destroy()
    const t0 = Date.now()
    makeWindow(key, {})
    const criouEm = Date.now() - t0
    if (b && b.waitChrome !== false) {
      await new Promise((res) => {
        if (!wins[key].webContents.isLoading()) return res()
        wins[key].webContents.once('did-finish-load', res)
      })
    }
    const cromoPronto = Date.now() - t0
    const ida = await ops.move({ to: key, mode: (b && b.mode) || 'one-step', budgetMs: 5000, settleMs: 300 })
    const totalPopout = Date.now() - t0
    const t1 = Date.now()
    const volta = await ops.move({ to: (b && b.back) || 'A', mode: (b && b.mode) || 'one-step', budgetMs: 5000, settleMs: 300 })
    wins[key].destroy()
    const totalDock = Date.now() - t1
    await new Promise((r) => setTimeout(r, 300))
    const fim = await ops.state({ win: (b && b.back) || 'A' })
    return {
      criarJanelaMs: criouEm, cromoCarregadoMs: cromoPronto,
      popoutTotalMs: totalPopout, dockBackTotalMs: totalDock,
      ida: { msToFreshPixel: ida.msToFreshPixel, rafMaxGapMs: ida.rafMaxGapMs, nonceIgual: ida.nonceIgual, reparentMs: ida.reparentMs },
      volta: { msToFreshPixel: volta.msToFreshPixel, rafMaxGapMs: volta.rafMaxGapMs, nonceIgual: volta.nonceIgual, reparentMs: volta.reparentMs },
      estadoFinal: { input: volta.after.input, docScroll: volta.after.docScroll, sse: volta.after.sse, ws: volta.after.ws, nonce: volta.after.nonce },
      hospedeiro: fim.host
    }
  },

  /** Reanexar a view (dock-back) depois que a janela hospedeira MORREU. */
  async reattach(b) {
    const to = (b && b.to) || 'A'
    if (!pageView || pageView.webContents.isDestroyed()) return { ok: false, why: 'view morta' }
    if (!wins[to] || wins[to].isDestroyed()) return { ok: false, why: 'janela alvo morta' }
    const t0 = Date.now()
    wins[to].contentView.addChildView(pageView)
    pageView.setBounds(viewRect(to, false))
    pageView.setVisible(true)
    host = to
    const fresh = await pollFresh({ budgetMs: 5000 })
    let estado = null
    try { estado = JSON.parse(await withTimeout(evalPage('JSON.stringify(window.__state())'), 4000, 'estadoPosReattach')) } catch (e) { estado = { erro: String(e && e.message) } }
    return { ok: true, ms: Date.now() - t0, msToFresh: fresh.msToFresh, tentativas: fresh.attempts, estado: estado }
  },

  // ——— P6: bordas de ciclo de vida ———
  async makeWin(b) {
    const key = b.key || 'B'
    if (wins[key] && !wins[key].isDestroyed()) return { reused: true, id: wins[key].id }
    makeWindow(key, { show: b.show !== false, showMode: b.showMode })
    await new Promise((r) => setTimeout(r, 700))
    return { created: key, id: wins[key].id, visible: wins[key].isVisible() }
  },

  /** A janela SEM renderer proprio (BaseWindow) — é o tipo que a sonda anterior
   *  usou quando viu win.hide() PENDURAR a captura. Existe para isolar a
   *  contradicao entre as duas sondas com UMA variavel trocada. */
  async makeBaseWin(b) {
    const { BaseWindow } = require('electron')
    const key = (b && b.key) || 'BASE'
    if (wins[key] && !wins[key].isDestroyed()) return { reused: true, id: wins[key].id }
    const L = layout().B
    const win = new BaseWindow({
      x: L.x + 40, y: L.y + 50, width: L.width - 60, height: L.height - 60,
      show: false, title: 'SONDA-POPOUT-' + key, backgroundColor: '#101010'
    })
    winMeta[key] = { closed: false, createdAt: Date.now(), tipo: 'BaseWindow' }
    win.on('close', () => { rec('win-close', { win: key }); winMeta[key].closed = true })
    wins[key] = win
    if (HEADED) win.showInactive()
    await new Promise((r) => setTimeout(r, 500))
    return { created: key, tipo: 'BaseWindow', id: win.id, visible: win.isVisible(), temWebContents: !!win.webContents }
  },

  /** QUEM É O DONO da view agora? É a pergunta que o guarda barato precisa
   *  responder antes de capturar — e a única que separa "anexada a uma janela
   *  viva" de "órfã" (detached ou com a janela morta). */
  async ownerProbe() {
    const { BrowserWindow: BW, BaseWindow: BaW } = require('electron')
    const wc = pageView && !pageView.webContents.isDestroyed() ? pageView.webContents : null
    const out = { hostSegundoASonda: host, viewViva: !!wc }
    if (!wc) return out
    let owner = null
    try { owner = BW.fromWebContents(wc) } catch (e) { out.erroFromWebContents = String(e && e.message) }
    out['BrowserWindow.fromWebContents'] = owner
      ? { id: owner.id, title: owner.getTitle(), destroyed: owner.isDestroyed(), visible: owner.isVisible() }
      : null
    try {
      const g = wc.getOwnerBrowserWindow ? wc.getOwnerBrowserWindow() : undefined
      out['wc.getOwnerBrowserWindow()'] = g === undefined ? 'inexistente' : (g ? { id: g.id, title: g.getTitle(), destroyed: g.isDestroyed() } : null)
    } catch (e) { out['wc.getOwnerBrowserWindow()'] = 'ERRO: ' + String(e && e.message) }
    out.janelasVivas = BaW.getAllWindows().map((w) => ({ id: w.id, title: w.getTitle(), visible: w.isVisible() }))
    return out
  },

  /** A VIEW IRMA, identica salvo por UMA variavel: backgroundThrottling no
   *  DEFAULT (true). A sonda anterior viu a janela escondida PENDURAR a
   *  captura; esta ve 25 ms. Se a irma penduar onde a nossa nao pendura, o
   *  culpado esta identificado e vira regra de producao. */
  async makeAltView(b) {
    if (altView && !altView.webContents.isDestroyed()) return { reused: true }
    // JANELA PROPRIA para a irma: duas views na mesma janela misturariam
    // oclusao com throttling, e a sonda anterior tambem tinha UMA view por
    // janela. Uma variavel de diferenca, nao duas.
    const key = 'ALT'
    if (!wins[key] || wins[key].isDestroyed()) makeWindow(key, {})
    altHost = key
    await new Promise((r) => setTimeout(r, 500))
    altView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    wins[key].contentView.addChildView(altView)
    altView.setBounds(viewRect(key, false))
    altView.setVisible(true)
    altView.webContents.loadURL(PAGES + '/page?nodes=60')
    await new Promise((res) => altView.webContents.once('did-finish-load', res))
    altView.webContents.debugger.attach('1.3')
    await new Promise((r) => setTimeout(r, 700))
    return {
      wcId: altView.webContents.id, backgroundThrottling: 'default (true)', em: key,
      bounds: altView.getBounds(), visible: altView.getVisible(), janelaVisivel: wins[key].isVisible()
    }
  },
  async altProbe(b) {
    const d = altView.webContents.debugger
    const ler = async () => {
      const r = await withTimeout(d.sendCommand('Runtime.evaluate', { expression: 'JSON.stringify(window.__state())', returnByValue: true }), 4000, 'altEval')
      return JSON.parse(r.result.value)
    }
    const a = await ler()
    await new Promise((r) => setTimeout(r, 500))
    const bb = await ler()
    const cap = await captureOnce({ target: 'alt', timeoutMs: (b && b.timeoutMs) || 5000 })
    if (b && b.file && cap.png) { try { fs.writeFileSync(path.join(OUT, b.file), cap.png) } catch (e) {} }
    const w = wins[altHost]
    const viva = w && !w.isDestroyed()
    return {
      rafEm500ms: bb.raf - a.raf, tickEm500ms: bb.tick - a.tick,
      capturePage: { ms: Math.round(cap.ms * 100) / 100, pendurou: !!cap.timedOut, vazia: cap.facts.empty, dominante: cap.facts.dominant || null, erro: cap.error || null },
      diag: {
        viewVisible: altView.getVisible(), viewBounds: altView.getBounds(),
        janelaVisivel: viva ? w.isVisible() : null, janelaMinimizada: viva ? w.isMinimized() : null,
        conteudo: viva ? w.getContentBounds() : null, dpr: bb.dpr, tamanhoDaPagina: bb.size
      }
    }
  },
  async killAltView() {
    if (!altView) return { ok: true, jaMorta: true }
    try { if (altHost && wins[altHost] && !wins[altHost].isDestroyed()) wins[altHost].contentView.removeChildView(altView) } catch (e) {}
    try { altView.webContents.close() } catch (e) {}
    try { if (wins.ALT && !wins.ALT.isDestroyed()) wins.ALT.destroy() } catch (e) {}
    altView = null
    return { ok: true }
  },

  async gapBaseline(b) {
    await evalPage('window.__resetGap()')
    await new Promise((r) => setTimeout(r, (b && b.ms) || 900))
    const s = JSON.parse(await evalPage('JSON.stringify(window.__state())'))
    return { janelaMs: (b && b.ms) || 900, maxGapMs: s.maxGapMs, raf: s.raf, tick: s.tick }
  },
  async remakeView(b) {
    if (pageView && !pageView.webContents.isDestroyed()) {
      try { if (host && wins[host] && !wins[host].isDestroyed()) wins[host].contentView.removeChildView(pageView) } catch (e) {}
      try { pageView.webContents.close() } catch (e) {}
    }
    pageView = makePageView()
    const to = b && b.into ? b.into : 'A'
    wins[to].contentView.addChildView(pageView)
    pageView.setBounds(viewRect(to, false))
    host = to
    pageView.webContents.loadURL(PAGES + '/page?nodes=' + ((b && b.nodes) || 260))
    await new Promise((res) => pageView.webContents.once('did-finish-load', res))
    await new Promise((r) => setTimeout(r, 350))
    dbg()
    return { wcId: pageView.webContents.id, host: host, url: pageView.webContents.getURL() }
  },
  /** Fechar a janela com a view AINDA anexada — o webContents morre junto? */
  async closeHostWindow(b) {
    const key = b.win || 'B'
    const wcId = pageView.webContents.id
    const before = { alive: !pageView.webContents.isDestroyed(), wcId: wcId }
    let removedFirst = false
    if (b.removeFirst) {
      // o caminho candidato do DOCK-BACK: interceptar o 'close' e tirar a view
      // da arvore ANTES da janela morrer.
      wins[key].once('close', () => {
        try { wins[key].contentView.removeChildView(pageView); removedFirst = true; rec('remove-on-close') } catch (e) { rec('remove-on-close-erro', { e: String(e) }) }
      })
    }
    wins[key].close()
    await new Promise((r) => setTimeout(r, b.settleMs || 900))
    const destroyed = !wins[key] || wins[key].isDestroyed()
    let viewAlive = false, urlDepois = null, evalDepois = null
    try {
      viewAlive = !!(pageView && !pageView.webContents.isDestroyed())
      if (viewAlive) urlDepois = pageView.webContents.getURL()
      if (viewAlive) evalDepois = await withTimeout(evalPage('window.__nonce'), 3000, 'evalPosClose')
    } catch (e) { evalDepois = 'ERRO: ' + String(e && e.message) }
    if (destroyed) { host = viewAlive && !removedFirst ? null : (removedFirst ? null : null) }
    return {
      janelaDestruida: destroyed, removedFirst: removedFirst, antes: before,
      viewViva: viewAlive, urlDepois: urlDepois, nonceDepois: evalDepois,
      nav: Object.assign({}, nav)
    }
  },
  /** O X da barra de tarefas NO MEIO de uma navegacao: o que o driver ve? */
  async midNavClose(b) {
    const key = b.win || 'B'
    const d = dbg()
    const seen = {}
    const t0 = Date.now()
    // 1) navegacao lenta em voo (o servidor segura a resposta)
    const navP = pageView.webContents.loadURL(PAGES + '/slow?ms=' + ((b && b.slowMs) || 5000))
      .then(() => { seen.loadURL = { ok: true, ms: Date.now() - t0 } })
      .catch((e) => { seen.loadURL = { ok: false, ms: Date.now() - t0, erro: String(e && e.message).slice(0, 200) } })
    // 2) comando CDP em voo
    const cdpP = d.sendCommand('Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(()=>r(7),4000))', returnByValue: true, awaitPromise: true })
      .then((r) => { seen.cdpEmVoo = { ok: true, ms: Date.now() - t0, value: r && r.result && r.result.value } })
      .catch((e) => { seen.cdpEmVoo = { ok: false, ms: Date.now() - t0, erro: String(e && e.message).slice(0, 200) } })
    // 3) captura em voo
    const capP = pageView.webContents.capturePage()
      .then((img) => { seen.capturaEmVoo = { ok: true, ms: Date.now() - t0, empty: img.isEmpty() } })
      .catch((e) => { seen.capturaEmVoo = { ok: false, ms: Date.now() - t0, erro: String(e && e.message).slice(0, 200) } })
    await new Promise((r) => setTimeout(r, (b && b.afterMs) || 700))
    seen.fechouEm = Date.now() - t0
    wins[key].close()   // exatamente o que o X da barra de tarefas dispara
    await Promise.race([Promise.allSettled([navP, cdpP, capP]), new Promise((r) => setTimeout(r, 9000))])
    await new Promise((r) => setTimeout(r, 400))
    let depois = {}
    try {
      depois.janelaDestruida = !wins[key] || wins[key].isDestroyed()
      depois.viewViva = !!(pageView && !pageView.webContents.isDestroyed())
      depois.dbgAttached = depois.viewViva ? pageView.webContents.debugger.isAttached() : null
      if (depois.viewViva) {
        try { depois.evalDepois = await withTimeout(evalPage('1+1'), 3000, 'evalPos') } catch (e) { depois.evalDepois = 'ERRO: ' + String(e && e.message).slice(0, 160) }
        try {
          const s = await captureOnce({ timeoutMs: 3000 })
          depois.capturaDepois = { ms: Math.round(s.ms * 100) / 100, timedOut: s.timedOut, vazia: s.facts.empty, erro: s.error || null }
        } catch (e) { depois.capturaDepois = { erro: String(e && e.message) } }
      }
    } catch (e) { depois.erro = String(e && e.message) }
    return { emVoo: seen, depois: depois, appVivo: true, nav: Object.assign({}, nav), eventos: events.slice(-12) }
  },

  async events() { return events.slice(-80) },
  async quit() { setTimeout(() => app.exit(0), 120); return { quitting: true } }
}

app.whenReady().then(async () => {
  makeWindow('A')
  makeWindow('B')
  await new Promise((r) => setTimeout(r, 800))
  pageView = makePageView()
  wins.A.contentView.addChildView(pageView)
  pageView.setBounds(viewRect('A', false))
  host = 'A'
  pageView.webContents.loadURL(PAGES + '/page?nodes=260')
  await new Promise((res) => pageView.webContents.once('did-finish-load', res))
  dbg()

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
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }))
      }
    })
  })
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(READY_FILE, JSON.stringify({ port: server.address().port, pid: process.pid }))
  })
})

// fechar TODAS as janelas nao pode matar o processo no meio da sonda do P6
app.on('window-all-closed', () => {})
`

// ————————————————————————————————————————————————————————————————
// 3. orquestração
// ————————————————————————————————————————————————————————————————

let electronChild = null
let control = null
let pagesServer = null
let wss = null
const sseClients = new Set()
const slowTimers = new Set()

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
const tryCall = async (op, body) => {
  try {
    return await call(op, body)
  } catch (e) {
    report.errors.push(`${op}: ${String(e.message).slice(0, 300)}`)
    return { __erro: String(e.message).slice(0, 300) }
  }
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
  await sleep(350)
  killTree(electronChild?.pid)
  for (const t of slowTimers) clearTimeout(t)
  for (const c of sseClients) { try { c.res.end() } catch {}; clearInterval(c.timer) }
  try { wss?.close() } catch {}
  try { pagesServer?.close() } catch {}
  if (!KEEP) {
    try { rmSync(APP_DIR, { recursive: true, force: true }) } catch {}
  }
}

async function main() {
  log('=== SONDA BROWSER POP-OUT (reparentar WebContentsView entre janelas) ===')
  log(`electron ${report.electron} · node ${process.version} · pages=${PAGES_PORT} · loops=${LOOPS}`)

  // 3.1 servidor das páginas (+ SSE + WebSocket + rota lenta para o P6)
  pagesServer = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml(Number(u.searchParams.get('nodes') || 260)))
      return
    }
    if (u.pathname === '/chrome') {
      const which = u.searchParams.get('win') || '?'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(chromeHtml(which, which === 'A' ? '#123c2a' : '#2a1236'))
      return
    }
    if (u.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      let n = 0
      const timer = setInterval(() => {
        n++
        try { res.write(`data: ${n}\n\n`) } catch {}
      }, 250)
      const entry = { res, timer }
      sseClients.add(entry)
      req.on('close', () => {
        clearInterval(timer)
        sseClients.delete(entry)
      })
      return
    }
    if (u.pathname === '/slow') {
      // o servidor SEGURA a resposta: é assim que se pega a navegação em voo
      const ms = Number(u.searchParams.get('ms') || 5000)
      const t = setTimeout(() => {
        slowTimers.delete(t)
        try { res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>lenta enfim</h1>') } catch {}
      }, ms)
      slowTimers.add(t)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => pagesServer.listen(PAGES_PORT, '127.0.0.1', r))
  wss = new WebSocketServer({ server: pagesServer, path: '/ws' })
  wss.on('connection', (ws) => {
    let n = 0
    const timer = setInterval(() => {
      n++
      try { ws.send(String(n)) } catch {}
    }, 250)
    ws.on('close', () => clearInterval(timer))
  })

  // 3.2 app descartável
  writeFileSync(join(APP_DIR, 'main.js'), MAIN_JS, 'utf-8')
  writeFileSync(
    join(APP_DIR, 'package.json'),
    JSON.stringify({ name: 'synkora-probe-popout', version: '0.0.0', main: 'main.js' }),
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
    [APP_DIR, `--pages=http://127.0.0.1:${PAGES_PORT}`, `--headed=${HEADED}`, `--out=${OUT_DIR}`, `--ready=${readyFile}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let tail = ''
  electronChild.stdout.on('data', (d) => (tail += d.toString()))
  electronChild.stderr.on('data', (d) => (tail += d.toString()))
  electronChild.on('exit', (c) => {
    if (!control) log(`[electron] saiu antes de subir (code=${c})\n${tail.slice(-2000)}`)
  })
  for (let i = 0; i < 220 && !control; i++) {
    if (existsSync(readyFile)) {
      try { control = JSON.parse(readFileSync(readyFile, 'utf-8')) } catch {}
    }
    if (!control) await sleep(150)
  }
  if (!control) throw new Error(`electron nao subiu:\n${tail.slice(-3000)}`)
  const hello = await call('hello')
  log(`\n[app] pid=${hello.pid} janelas=${hello.wins.map((w) => w.key).join(',')} view.wcId=${hello.viewWcId} host=${hello.host}`)

  await runP1P2()
  await runP3()
  await runP5()
  await runP4()
  await runP6()

  raw('summary.json', report)
  log(`\n=== evidência crua em ${OUT_DIR} ===`)
}

// ——— P1 + P2 ———
async function runP1P2() {
  log('\n--- P1/P2: REPARENTAR a view viva entre janelas ---')
  const seed = await call('seedPage', { text: 'sonda-42', docScroll: 900, boxScroll: 420 })
  log(`   semente: nonce=${seed.nonce} scrollDoc=${seed.docScroll} scrollBox=${seed.boxScroll} input="${seed.input}" sse=${seed.sse.count} ws=${seed.ws.count}`)
  // BASE DE COMPARAÇÃO do "buraco": sem gesto nenhum, qual é o maior intervalo
  // entre quadros? Sem esta linha, "17 ms de gap" não quer dizer nada.
  const baseline = await call('gapBaseline', { ms: 900 })
  log(`   linha de base SEM gesto: maior intervalo entre quadros = ${baseline.maxGapMs}ms (60 Hz ⇒ ~16,7ms é o normal)`)

  const primeiro = await call('move', { to: 'B', mode: 'two-step' })
  raw('p1-primeiro-move.json', primeiro)
  log(
    `   A→B (dois passos): reparent=${primeiro.reparentMs}ms · 1a captura ok em ${primeiro.msToFirstCapture}ms · ` +
      `PIXEL FRESCO em ${primeiro.msToFreshPixel}ms · rAF maior buraco=${primeiro.rafMaxGapMs}ms`
  )
  log(
    `   sobreviveu? nonce igual=${primeiro.nonceIgual} · scroll ${primeiro.docScroll.join('→')}/${primeiro.boxScroll.join('→')} · ` +
      `input "${primeiro.input[1]}" · tick+${primeiro.tickDelta} · sse+${primeiro.sseDelta} · ws+${primeiro.wsDelta}`
  )

  const loops = []
  for (let i = 0; i < LOOPS; i++) {
    const mode = i % 2 === 0 ? 'two-step' : 'one-step'
    const ida = await call('move', { to: 'A', mode })
    const volta = await call('move', { to: 'B', mode })
    loops.push({ i: i + 1, mode, ida, volta })
    log(
      `   [${String(i + 1).padStart(2)}/${LOOPS}] ${mode.padEnd(8)} B→A fresco=${String(ida.msToFreshPixel).padStart(4)}ms gap=${String(ida.rafMaxGapMs).padStart(6)}ms · ` +
        `A→B fresco=${String(volta.msToFreshPixel).padStart(4)}ms gap=${String(volta.rafMaxGapMs).padStart(6)}ms · nonce=${ida.nonceIgual && volta.nonceIgual}`
    )
  }
  raw('p1-loops.json', loops)

  const todas = [primeiro, ...loops.flatMap((l) => [l.ida, l.volta])]
  const twoStep = todas.filter((m) => m.mode === 'two-step')
  const oneStep = todas.filter((m) => m.mode === 'one-step')
  const agrega = (arr) => ({
    n: arr.length,
    reparentMs: stat(arr.map((m) => m.reparentMs)),
    msToFirstCapture: stat(arr.map((m) => m.msToFirstCapture ?? -1)),
    msToFreshPixel: stat(arr.map((m) => m.msToFreshPixel ?? -1)),
    rafMaxGapMs: stat(arr.map((m) => m.rafMaxGapMs)),
    freshFalhou: arr.filter((m) => m.msToFreshPixel == null).length
  })
  const st = await call('state', { win: 'B' })
  const finalState = await call('pageState')

  report.p1_reparent = {
    linhaDeBaseSemGesto: baseline,
    primeiro: {
      reparentMs: primeiro.reparentMs, removeMs: primeiro.removeMs, addMs: primeiro.addMs,
      msToFirstCapture: primeiro.msToFirstCapture, msToFreshPixel: primeiro.msToFreshPixel,
      rafMaxGapMs: primeiro.rafMaxGapMs, freshFacts: primeiro.freshFacts
    },
    idasEVoltas: LOOPS * 2,
    twoStep: agrega(twoStep),
    oneStep: agrega(oneStep),
    nonceSempreIgual: todas.every((m) => m.nonceIgual),
    navegacoesDisparadas: st.nav,
    renderizaEmB: primeiro.msToFreshPixel != null && !primeiro.freshFacts?.empty,
    ultimoEstado: finalState
  }
  report.p2_survive = {
    semente: seed,
    depoisDoPrimeiroGesto: primeiro.after,
    depoisDeTodasAsIdas: finalState,
    scrollDocumentoMantido: primeiro.docScroll[0] === primeiro.docScroll[1] && finalState.docScroll === seed.docScroll,
    scrollContainerMantido: primeiro.boxScroll[0] === primeiro.boxScroll[1] && finalState.boxScroll === seed.boxScroll,
    inputMantido: finalState.input === seed.input,
    nonceMantido: finalState.nonce === seed.nonce,
    timersVivos: { rafDelta: finalState.raf - seed.raf, tickDelta: finalState.tick - seed.tick },
    sse: { antes: seed.sse, depois: finalState.sse, entregasDurante: finalState.sse.count - seed.sse.count },
    ws: { antes: seed.ws, depois: finalState.ws, entregasDurante: finalState.ws.count - seed.ws.count },
    visibilityChanges: finalState.visChanges,
    navContadores: st.nav,
    recarregou: finalState.nonce !== seed.nonce || st.nav.didStartNavigation > 1
  }
  log(
    `   AGREGADO dois-passos: fresco mediana=${report.p1_reparent.twoStep.msToFreshPixel.median}ms · gap rAF mediana=${report.p1_reparent.twoStep.rafMaxGapMs.median}ms`
  )
  log(
    `   AGREGADO um-passo  : fresco mediana=${report.p1_reparent.oneStep.msToFreshPixel.median}ms · gap rAF mediana=${report.p1_reparent.oneStep.rafMaxGapMs.median}ms`
  )
  log(
    `   P2: scrollDoc=${report.p2_survive.scrollDocumentoMantido} scrollBox=${report.p2_survive.scrollContainerMantido} input=${report.p2_survive.inputMantido} ` +
      `nonce=${report.p2_survive.nonceMantido} recarregou=${report.p2_survive.recarregou} sse+${report.p2_survive.sse.entregasDurante} ws+${report.p2_survive.ws.entregasDurante}`
  )
}

// ——— P3 ———
async function runP3() {
  log('\n--- P3: captura e CDP logo depois do gesto e em regime na janela B ---')
  await call('move', { to: 'A', mode: 'two-step' })
  const logoApos = await call('move', { to: 'B', mode: 'two-step' })
  const primeiraCaptura = await call('capture', { file: 'p3-logo-apos-o-gesto.png' })
  const benchB = await call('bench', { samples: SAMPLES })
  const cdpDepois = await call('dbgStatus')
  const cdpShot = await call('capture', { target: 'cdp' })
  const freshRegime = await call('fresh', {})
  await call('capture', { file: 'p3-regime-janela-B.png' })
  // CONTROLE: o instante detached do gesto de dois passos (a lei P5 da sonda
  // anterior) reproduz NESTE arnês? É o que separa dois-passos de um-passo.
  const detached = await tryCall('detachedControl', {})
  log(
    `   CONTROLE detached (view fora da árvore): capturePage=${detached.capturePage?.pendurou ? 'PENDURA' : detached.capturePage?.ms + 'ms'} · ` +
      `CDP=${detached.cdpShot?.pendurou ? 'PENDURA' : detached.cdpShot?.ms + 'ms'} · rAF/500ms=${detached.rafEm500ms} · ` +
      `eval=${detached.evalContinuaRespondendo} · recupera em ${detached.recuperouAoReanexar?.msToFresh}ms`
  )

  report.p3_capture = {
    controleDetached: detached,
    logoAposOGesto: {
      msToFirstCapture: logoApos.msToFirstCapture,
      msToFreshPixel: logoApos.msToFreshPixel,
      primeiraCapturaMs: primeiraCaptura.ms,
      primeiraCapturaFacts: primeiraCaptura.facts
    },
    regimeEmB: { capturePage: stat(benchB.ms), bytes: benchB.bytes, facts: benchB.facts },
    frescorEmRegime: { msToFresh: freshRegime.msToFresh, tentativas: freshRegime.attempts, cor: freshRegime.want, facts: freshRegime.facts },
    cdpSobreviveuAoReparent: cdpDepois,
    cdpScreenshotDepois: { ms: cdpShot.ms, bytes: cdpShot.bytes, erro: cdpShot.error }
  }
  log(`   1a captura após o gesto: ${primeiraCaptura.ms}ms · dominante=${primeiraCaptura.facts?.dominant} (${primeiraCaptura.facts?.distinctColors} cores)`)
  log(`   regime em B: capturePage mediana=${report.p3_capture.regimeEmB.capturePage.median}ms · frescor=${freshRegime.msToFresh}ms em ${freshRegime.attempts} tentativa(s)`)
  log(`   CDP depois do reparent: attached=${cdpDepois.attached} eval=${cdpDepois.evalOk} (${cdpDepois.evalMs}ms) detaches=${cdpDepois.detachEvents} · CDP shot=${cdpShot.ms}ms`)
}

// ——— P5 (antes do P4 de propósito: aqui a janela B ainda está limpa/visível) ———
async function runP5() {
  log('\n--- P5: cromo da janela B + view composta por cima ---')
  const abaixo = await call('setViewRect', { win: 'B', overChrome: false })
  const cliquePagina1 = await call('clickPage')
  const cliqueCromo1 = await call('clickChrome', { win: 'B' })
  const cromoState = await call('chromeState', { win: 'B' })
  const shotCromoAbaixo = await call('capture', { target: 'winChrome', win: 'B', file: 'p5-winCapture-view-abaixo.png' })
  const deskAbaixo = await tryCall('deskShot', { win: 'B', file: 'p5-desktopCapturer-view-abaixo.png' })

  // z-order: a view sobe POR CIMA do cabeçalho do cromo (mesma superfície)
  const acima = await call('setViewRect', { win: 'B', overChrome: true })
  const shotCromoAcima = await call('capture', { target: 'winChrome', win: 'B', file: 'p5-winCapture-view-acima.png' })
  const shotViewAcima = await call('capture', { file: 'p5-view-acima.png' })
  const deskAcima = await tryCall('deskShot', { win: 'B', file: 'p5-desktopCapturer-view-acima.png' })
  const cliquePagina2 = await call('clickPage')
  const cliqueCromo2 = await call('clickChrome', { win: 'B' })
  await call('setViewRect', { win: 'B', overChrome: false })

  // controle: o mesmo teste na janela A (a "principal" desta sonda)
  await call('move', { to: 'A', mode: 'two-step' })
  const cliqueCromoA = await call('clickChrome', { win: 'A' })
  const cliquePaginaA = await call('clickPage')
  const shotCromoA = await call('capture', { target: 'winChrome', win: 'A', file: 'p5-winCapture-janela-A.png' })
  const deskA = await tryCall('deskShot', { win: 'A', file: 'p5-desktopCapturer-janela-A.png' })
  await call('move', { to: 'B', mode: 'two-step' })

  report.p5_coexist = {
    viewAbaixoDoCromo: abaixo,
    viewSobreOCromo: acima,
    cliqueNaPagina: { emB: cliquePagina1, comViewSobreOCromo: cliquePagina2, emA: cliquePaginaA },
    cliqueNoCromo: { emB: cliqueCromo1, comViewSobreOCromo: cliqueCromo2, emA: cliqueCromoA },
    cromoVivo: cromoState,
    winCapturePegaAViewFilha: {
      viewAbaixo: { ms: shotCromoAbaixo.ms, facts: shotCromoAbaixo.facts },
      viewAcima: { ms: shotCromoAcima.ms, facts: shotCromoAcima.facts },
      janelaA: { ms: shotCromoA.ms, facts: shotCromoA.facts },
      capturaDaPropriaView: { ms: shotViewAcima.ms, facts: shotViewAcima.facts }
    },
    retratoCompostoPeloSO: { viewAbaixo: deskAbaixo, viewAcima: deskAcima, janelaAControle: deskA }
  }
  log(`   clique na página (B)=${cliquePagina1.clicked} · clique no cromo (B)="${cliqueCromo1.out}" · cromo vivo raf=${cromoState.raf}`)
  log(`   win.webContents.capturePage(B): view abaixo dominante=${shotCromoAbaixo.facts?.dominant} · view POR CIMA dominante=${shotCromoAcima.facts?.dominant}`)
  log(`   (a própria view, por cima do cromo) dominante=${shotViewAcima.facts?.dominant}`)
  const zo = (d) =>
    d?.scan?.achados
      ? `cromoHeader topo=${d.scan.achados.cromoHeader.topYFrac ?? '—'} (${d.scan.achados.cromoHeader.count}) · paginaHeader topo=${d.scan.achados.paginaHeader.topYFrac ?? '—'} (${d.scan.achados.paginaHeader.count}) · stage=${d.scan.achados.stage.count}`
      : JSON.stringify(d).slice(0, 160)
  log(`   desktopCapturer (composto pelo SO) view ABAIXO: ${zo(deskAbaixo)}`)
  log(`   desktopCapturer (composto pelo SO) view ACIMA : ${zo(deskAcima)}`)

  // o gesto INTEIRO: criar a janela do pop-out do zero → mover → encaixar de volta
  const roundTrip = await tryCall('popoutRoundTrip', { key: 'POP', back: 'A', mode: 'one-step' })
  await tryCall('move', { to: 'B', mode: 'one-step' })
  report.p5_coexist.gestoInteiro = roundTrip
  log(
    `   GESTO INTEIRO: criar janela=${roundTrip.criarJanelaMs}ms · cromo carregado=${roundTrip.cromoCarregadoMs}ms · ` +
      `POP-OUT total=${roundTrip.popoutTotalMs}ms (fresco ${roundTrip.ida?.msToFreshPixel}ms) · DOCK-BACK total=${roundTrip.dockBackTotalMs}ms (fresco ${roundTrip.volta?.msToFreshPixel}ms)`
  )
}

// ——— P4 ———
async function runP4() {
  log('\n--- P4: os estados escondidos de uma janela SECUNDÁRIA (pop-out) ---')
  const modos = []

  const medir = async (rotulo, prep, opts) => {
    if (prep) await prep()
    await sleep((opts && opts.settle) || 600)
    const st = await tryCall('state', { win: (opts && opts.win) || 'B' })
    const cap = await tryCall('capture', { timeoutMs: 6000, file: `p4-${rotulo.replace(/[^a-z0-9]+/gi, '-')}.png` })
    const cdp = await tryCall('capture', { target: 'cdp', timeoutMs: 9000 })
    const fresh = await tryCall('fresh', { budgetMs: 6000, perCallTimeoutMs: 2500, evalTimeoutMs: 4000 })
    const antes = await tryCall('pageState')
    await sleep(500)
    const depois = await tryCall('pageState')
    const dono = await tryCall('ownerProbe')
    const linha = {
      modo: rotulo,
      janela: { visible: st.visible, minimized: st.minimized, destroyed: st.destroyed },
      dono: dono['BrowserWindow.fromWebContents'] ?? null,
      capturePage: { ms: cap.ms, pendurou: !!cap.timedOut, vazia: cap.facts?.empty ?? null, dominante: cap.facts?.dominant ?? null, erro: cap.error || cap.__erro || null },
      cdpShot: { ms: cdp.ms, pendurou: !!cdp.timedOut, bytes: cdp.bytes, erro: cdp.error || cdp.__erro || null },
      frescor: {
        msToFresh: fresh.msToFresh ?? null, pendurou: !!fresh.pendurou, tentativas: fresh.attempts ?? null,
        corPedida: fresh.want ?? null, corVista: fresh.facts?.dominant ?? null, capturaVazia: fresh.facts?.empty ?? null
      },
      viewBounds: st.viewBounds ?? null,
      conteudoDaJanela: st.bounds ?? null,
      rafEm500ms: depois.raf != null && antes.raf != null ? depois.raf - antes.raf : null,
      tickEm500ms: depois.tick != null && antes.tick != null ? depois.tick - antes.tick : null,
      visibility: depois.visibility ?? null
    }
    modos.push(linha)
    log(
      `   ${rotulo.padEnd(30)} capturePage=${String(linha.capturePage.pendurou ? 'PENDURA' : Math.round(linha.capturePage.ms) + 'ms').padStart(8)} · ` +
        `CDP=${String(linha.cdpShot.pendurou ? 'PENDURA' : Math.round(linha.cdpShot.ms) + 'ms').padStart(8)} · ` +
        `fresco=${String(linha.frescor.msToFresh ?? (linha.frescor.pendurou ? 'PENDURA' : 'NAO')).padStart(7)} · rAF/500ms=${linha.rafEm500ms} · vis=${linha.visibility}`
    )
    return linha
  }

  await medir('B visível (base)', async () => {
    await call('winOp', { win: 'B', action: 'restore' })
    await call('winOp', { win: 'B', action: 'showInactive' })
  })
  await medir('B minimizada', () => call('winOp', { win: 'B', action: 'minimize' }))
  await medir('B restaurada', async () => {
    await call('winOp', { win: 'B', action: 'restore' })
    await call('winOp', { win: 'B', action: 'showInactive' })
  })
  await medir('B ocluída por A (100%)', async () => {
    await call('winOp', { win: 'A', action: 'moveOver', over: 'B' })
  })
  await medir('B desocluída', async () => {
    await call('winOp', { win: 'A', action: 'restoreBounds' })
    await call('winOp', { win: 'B', action: 'showInactive' })
  })
  await medir('B com win.hide()', () => call('winOp', { win: 'B', action: 'hide' }))
  // CONTROLE DO MECANISMO: a sonda anterior viu `win.hide()` PENDURAR a captura
  // — mas lá a janela escondida era a ÚNICA do app. Aqui a A continua visível.
  // Esconder TODAS separa "esta janela sumiu" de "o app não tem superfície".
  const todasEscondidas = await medir('TODAS as janelas escondidas', async () => {
    await call('winOp', { win: 'A', action: 'hide' })
    await call('winOp', { win: 'B', action: 'hide' })
  })
  await tryCall('winOp', { win: 'A', action: 'showInactive' })
  await medir('B de volta com showInactive()', () => call('winOp', { win: 'B', action: 'showInactive' }))

  // a janela que NASCEU escondida (show:false) e nunca foi mostrada
  await call('makeWin', { key: 'C', show: false })
  await call('move', { to: 'C', mode: 'two-step' })
  const nascidaEscondida = await medir('C nunca mostrada (show:false)', null, { settle: 800 })
  await call('winOp', { win: 'C', action: 'showInactive' })
  const depoisDeShowInactive = await medir('C após showInactive()', null, { settle: 700 })
  await call('move', { to: 'B', mode: 'two-step' })
  await call('winOp', { win: 'C', action: 'destroy' })

  // O CASO DE PRODUÇÃO que ninguém sondou: encaixar a view DENTRO de uma janela
  // que já está escondida/minimizada (dock-back com a janela principal
  // minimizada; pop-out para uma janela ainda não mostrada). Aqui a view nunca
  // compôs um quadro naquela janela — é a hipótese que resta para o "pendura"
  // que a sonda anterior viu no win.hide().
  await tryCall('winOp', { win: 'A', action: 'showInactive' })
  await tryCall('move', { to: 'A', mode: 'one-step' })
  await tryCall('winOp', { win: 'B', action: 'hide' })
  const moveuParaEscondida = await medir('view MOVIDA para a escondida', () => call('move', { to: 'B', mode: 'one-step', budgetMs: 6000 }))
  // ROTA DE SAÍDA: mostrar a janela cura o estado pendurado? (toda guarda da
  // casa nasce com saída sancionada — sem isto o gesto seria um beco)
  const curaAoMostrar = await medir('… e depois showInactive (cura?)', () => call('winOp', { win: 'B', action: 'showInactive' }))
  await tryCall('move', { to: 'A', mode: 'one-step' })
  await tryCall('winOp', { win: 'B', action: 'minimize' })
  const moveuParaMinimizada = await medir('view MOVIDA para a minimizada', () => call('move', { to: 'B', mode: 'one-step', budgetMs: 6000 }))
  const curaAoRestaurar = await medir('… e depois restore (cura?)', async () => {
    await call('winOp', { win: 'B', action: 'restore' })
    await call('winOp', { win: 'B', action: 'showInactive' })
  })
  // hipótese: `getContentBounds()` de uma janela MINIMIZADA devolve lixo, e a
  // view herdou esse retângulo. Refazer o setBounds com a janela já restaurada
  // separa "compositor doente" de "retângulo errado".
  const curaComBoundsRefeitos = await medir('… e depois setBounds refeito', () => call('setViewRect', { win: 'B' }))

  // CONTRA-PROVA nº 1 da contradição com a sonda anterior: a view IRMÃ, igual em
  // tudo salvo `backgroundThrottling` no default. É a hipótese mais barata para
  // "por que lá a janela escondida pendurava a captura e aqui não".
  const alt = {}
  try {
    alt.criacao = await call('makeAltView', {})
    alt.visivel = await call('altProbe', { file: 'p4-irma-visivel.png' })
    await call('winOp', { win: 'ALT', action: 'hide' })
    alt.janelaEscondida = await call('altProbe', { file: 'p4-irma-escondida.png' })
    await call('winOp', { win: 'ALT', action: 'showInactive' })
    await call('winOp', { win: 'ALT', action: 'minimize' })
    alt.janelaMinimizada = await call('altProbe', { file: 'p4-irma-minimizada.png' })
    await call('winOp', { win: 'ALT', action: 'restore' })
    await call('killAltView')
    for (const k of ['visivel', 'janelaEscondida', 'janelaMinimizada'])
      log(
        `   view IRMÃ (backgroundThrottling default, janela própria) · ${k.padEnd(17)} rAF/500ms=${String(alt[k].rafEm500ms).padStart(3)} · ` +
          `capturePage=${alt[k].capturePage.pendurou ? 'PENDURA' : alt[k].capturePage.ms + 'ms'} vazia=${alt[k].capturePage.vazia} dom=${alt[k].capturePage.dominante}`
      )
  } catch (e) {
    alt.erro = String(e.message).slice(0, 200)
    report.errors.push('altView: ' + alt.erro)
  }

  // CONTRA-PROVA nº 2: lá a janela escondida era uma BaseWindow (sem renderer
  // próprio). Uma variável trocada, mesma medida.
  await tryCall('makeBaseWin', { key: 'BASE' })
  await tryCall('move', { to: 'BASE', mode: 'one-step' })
  const baseVisivel = await medir('BaseWindow visível', null, { settle: 700, win: 'BASE' })
  const baseEscondida = await medir('BaseWindow com hide()', () => call('winOp', { win: 'BASE', action: 'hide' }), { settle: 700, win: 'BASE' })
  const baseMinimizada = await medir('BaseWindow minimizada', async () => {
    await call('winOp', { win: 'BASE', action: 'showInactive' })
    await call('winOp', { win: 'BASE', action: 'minimize' })
  }, { settle: 700, win: 'BASE' })
  await tryCall('winOp', { win: 'BASE', action: 'restore' })
  await tryCall('move', { to: 'B', mode: 'one-step' })
  await tryCall('winOp', { win: 'BASE', action: 'destroy' })

  const guardas = {}
  for (const [rotulo, prep] of [
    ['visível', async () => { await call('winOp', { win: 'B', action: 'restore' }); await call('winOp', { win: 'B', action: 'showInactive' }) }],
    ['minimizada', () => call('winOp', { win: 'B', action: 'minimize' })],
    ['escondida (hide)', async () => { await call('winOp', { win: 'B', action: 'restore' }); await call('winOp', { win: 'B', action: 'hide' }) }]
  ]) {
    await prep()
    await sleep(400)
    guardas[rotulo] = await call('guardCost', { win: 'B', samples: 2000 })
  }
  await call('winOp', { win: 'B', action: 'showInactive' })

  report.p4_hidden = {
    matriz: modos,
    todasAsJanelasEscondidas: todasEscondidas,
    moverParaDentroDeJanelaEscondida: {
      escondida: moveuParaEscondida, curaAoMostrar,
      minimizada: moveuParaMinimizada, curaAoRestaurar, curaComBoundsRefeitos
    },
    viewIrmaComThrottlingPadrao: alt,
    baseWindowSemRendererProprio: { visivel: baseVisivel, escondida: baseEscondida, minimizada: baseMinimizada },
    nascidaEscondida,
    depoisDeShowInactive,
    guardaBarato: guardas,
    backgroundThrottlingFalse: 'a view e o cromo nascem com backgroundThrottling:false nesta sonda',
    visibilityStateDaPagina: modos.map((m) => m.visibility)
  }
  raw('p4-matriz.json', modos)
}

// ——— P6 ———
async function runP6() {
  log('\n--- P6: bordas de ciclo de vida (fechar a janela do pop-out) ---')

  // (1) o caminho candidato do DOCK-BACK: removeChildView no 'close'
  await call('move', { to: 'B', mode: 'two-step' })
  const comRemove = await tryCall('closeHostWindow', { win: 'B', removeFirst: true })
  log(`   fechar B com removeChildView no 'close': view viva=${comRemove.viewViva} · nonce=${comRemove.nonceDepois}`)
  let dockBack = null
  if (comRemove.viewViva) {
    const de_volta = await tryCall('move', { to: 'A', mode: 'one-step' })
    dockBack = {
      voltouParaA: !de_volta.__erro,
      msToFreshPixel: de_volta.msToFreshPixel ?? null,
      rafMaxGapMs: de_volta.rafMaxGapMs ?? null,
      nonceIgual: de_volta.nonceIgual ?? null,
      estado: de_volta.after ?? null,
      erro: de_volta.__erro || null
    }
    log(`   DOCK-BACK para A: fresco=${dockBack.msToFreshPixel}ms · gap=${dockBack.rafMaxGapMs}ms · nonce igual=${dockBack.nonceIgual}`)
  }
  await tryCall('makeWin', { key: 'B' })

  // (2) fechar a janela com a view AINDA anexada — e o que a captura faz DEPOIS
  await tryCall('move', { to: 'B', mode: 'two-step' })
  const semRemove = await tryCall('closeHostWindow', { win: 'B', removeFirst: false })
  log(`   fechar B com a view ANEXADA: view viva=${semRemove.viewViva} · nonce=${semRemove.nonceDepois} · nav.destroyed=${semRemove.nav?.destroyed}`)
  const donoOrfa = await tryCall('ownerProbe')
  log(`   quem é o dono da view órfã? BrowserWindow.fromWebContents=${JSON.stringify(donoOrfa['BrowserWindow.fromWebContents'])} · getOwnerBrowserWindow=${JSON.stringify(donoOrfa['wc.getOwnerBrowserWindow()'])}`)
  const capturaOrfa = await tryCall('capture', { timeoutMs: 6000 })
  log(`   captura com a view ÓRFÃ (janela morta): ${capturaOrfa.timedOut ? 'PENDURA' : capturaOrfa.ms + 'ms'} vazia=${capturaOrfa.facts?.empty} erro=${capturaOrfa.error || capturaOrfa.__erro}`)
  const resgate = await tryCall('reattach', { to: 'A' })
  log(`   RESGATE da view órfã para A: ok=${resgate.ok} fresco=${resgate.msToFresh}ms nonce=${resgate.estado?.nonce} input="${resgate.estado?.input}" ws=${resgate.estado?.ws?.count}`)
  const vivoDepois = await tryCall('ping')

  // (3) o X no meio de uma navegação
  await tryCall('makeWin', { key: 'B' })
  await tryCall('remakeView', { into: 'A' })
  await tryCall('move', { to: 'B', mode: 'two-step' })
  const midNav = await tryCall('midNavClose', { win: 'B', slowMs: 6000, afterMs: 700 })
  log(`   X no meio da navegação: loadURL=${JSON.stringify(midNav.emVoo?.loadURL)}`)
  log(`   .................... CDP em voo=${JSON.stringify(midNav.emVoo?.cdpEmVoo)}`)
  log(`   .................... captura em voo=${JSON.stringify(midNav.emVoo?.capturaEmVoo)}`)
  log(`   .................... depois: ${JSON.stringify(midNav.depois)}`)
  const vivoFinal = await tryCall('ping')

  report.p6_lifecycle = {
    fecharComRemoveChildViewNoClose: comRemove,
    dockBackDepoisDoFechamento: dockBack,
    fecharComAViewAnexada: semRemove,
    donoDaViewOrfa: donoOrfa,
    capturaComAViewOrfa: {
      ms: capturaOrfa.ms ?? null, pendurou: !!capturaOrfa.timedOut,
      vazia: capturaOrfa.facts?.empty ?? null, erro: capturaOrfa.error || capturaOrfa.__erro || null
    },
    resgateDaViewOrfa: resgate,
    appVivoDepoisDosFechamentos: vivoDepois,
    xNoMeioDaNavegacao: midNav,
    appVivoNoFim: vivoFinal
  }
  raw('p6-lifecycle.json', report.p6_lifecycle)
}

const t0 = Date.now()
main()
  .catch((e) => {
    report.errors.push(String((e && e.stack) || e))
    log(`\n!!! ERRO: ${e && e.message}`)
  })
  .finally(async () => {
    report.durationMs = Date.now() - t0
    try { raw('summary.json', report) } catch {}
    await cleanup()
    log(`\n[fim] ${Math.round(report.durationMs / 1000)}s · erros=${report.errors.length}`)
    process.exit(0)
  })

// SONDA — VIEWPORT EMULADA QUE CABE NA MOLDURA (o "modo desktop" do painel).
//
// Por que existe: o dono reprovou o painel ao vivo — "ta meio limitado o quanto
// consigo deixar ele maior, meio que sempre vou ver o site/app com modo tablet,
// ta um pouco diferente de como e hoje no claude code". O diagnóstico é
// geométrico: a página renderiza na largura FÍSICA do trilho (~300-500px), então
// todo site responsivo entrega o layout de celular/tablet. O browser do Claude
// Code resolve EMULANDO uma viewport de desktop e ESCALANDO a página para caber
// na moldura.
//
// A casa proíbe afirmar protocolo sem binário real. As perguntas:
//
//   P1 QUAL RECEITA — numa WebContentsView de ~400x600 físicos, emular 1280
//      lógicos por cinco caminhos e medir, em cada um: innerWidth/clientWidth,
//      media queries (o layout REAL, não a promessa), devicePixelRatio, e se a
//      LARGURA INTEIRA aparece no pixel (faixa colorida no extremo direito da
//      página tem de aparecer na captura).
//        A = setDeviceMetricsOverride(1280) + webContents.setZoomFactor(400/1280)
//        B = setDeviceMetricsOverride(1280, scale: 400/1280)   (o botão da CDP)
//        C = setZoomFactor(400/1280) sozinho (sem emulação)
//        D = setDeviceMetricsOverride(1280, height:0, dsf:0) + setZoomFactor
//        E = setDeviceMetricsOverride(1280) SEM escala (controle: tem de CORTAR)
//   P2 O INPUT AINDA ACERTA — o mesmo botão, clicado por DOIS caminhos:
//      (a) Input.dispatchMouseEvent em coordenada LÓGICA (o caminho do driver da
//          casa, que sai de getBoundingClientRect);
//      (b) webContents.sendInputEvent em coordenada FÍSICA da moldura (o mouse
//          do DONO, que é quem clica de verdade no painel).
//   P3 A CAPTURA — capturePage devolve a view lógica INTEIRA e FRESCA? (técnica
//      da casa: pinta uma cor inédita e cronometra até ela aparecer no bitmap.)
//   P4 AS ARMADILHAS — o zoom do Chromium é POR ORIGEM: setZoomFactor numa aba
//      vaza para a irmã do mesmo host? E o piso: 300/1280 = 0,234 é menor que os
//      25% do zoom do Chromium — ele grampeia?
//   P5 A MOLDURA MUDA — redimensionar a view (o dono arrastando o trilho) sem
//      recalcular a escala: o que quebra? E com o recálculo?
//   P6 A VOLTA — clear + zoom 1 devolve o comportamento de hoje?
//
// Uso:
//   node scripts/probe-browser-viewport-fit.mjs
//   node scripts/probe-browser-viewport-fit.mjs --samples 8 --keep --headed=false
//
// Não toca em src/. Não roda o app do dono: sobe um electron PRÓPRIO a partir de
// um main.js descartável em %TEMP%/synkora-probe-vpfit (apagado no fim, salvo
// --keep) e mata o filho PELO PID (taskkill /T, NUNCA por nome de imagem).
// Evidência crua em .tmp/probe-browser-viewport-fit/.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-browser-viewport-fit')
const SHOTS = join(OUT_DIR, 'shots')
const SCRATCH = join(tmpdir(), 'synkora-probe-vpfit')
const APP_DIR = join(SCRATCH, 'app')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return i >= 0 ? 'true' : dflt
}
const SAMPLES = Number(flag('samples', '6'))
const KEEP = flag('keep', 'false') === 'true'
const HEADED = flag('headed', 'true') !== 'false'
const PAGES_PORT = Number(flag('pages-port', '0')) || 9800 + (process.pid % 150)

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
mkdirSync(APP_DIR, { recursive: true })

const requireRepo = createRequire(join(REPO, 'package.json'))
const ELECTRON_BIN = requireRepo('electron')

const report = {
  probedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  electron: requireRepo('electron/package.json').version,
  pagesPort: PAGES_PORT,
  p1_receitas: null,
  p2_input: null,
  p3_captura: null,
  p4_armadilhas: null,
  p5_moldura: null,
  p6_volta: null,
  veredito: null,
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

// ————————————————————————————————————————————————————————————————
// 1. A PÁGINA responsiva (a cobaia: ela tem de MUDAR de layout com a largura)
// ————————————————————————————————————————————————————————————————

/** Uma página que só sabe fazer uma coisa: contar a verdade sobre a largura que
 *  ela enxerga. Três provas independentes, porque `innerWidth` sozinho pode ser
 *  emulação sem layout:
 *   · `--layout` é escrito por MEDIA QUERY (se a query não pegou, o texto mente);
 *   · o grid `auto-fill` de 240px muda de NÚMERO DE COLUNAS com a largura real;
 *   · duas faixas de cor nos extremos esquerdo/direito provam, no PIXEL, que a
 *     largura inteira coube na moldura (a da direita é a que some quando corta). */
function pageHtml() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SONDA VIEWPORT FIT</title>
<style>
 html,body{margin:0;background:#efe9dc;color:#26241f;font:14px/1.5 Consolas,monospace}
 #probe{--layout:desconhecido}
 @media (max-width:699px){ #probe{--layout:mobile} }
 @media (min-width:700px) and (max-width:1023px){ #probe{--layout:tablet} }
 @media (min-width:1024px){ #probe{--layout:desktop} }
 /* faixa ESQUERDA e faixa DIREITA: a prova por pixel de "a largura inteira
    apareceu". A da direita é grudada no extremo direito da viewport. */
 #L{position:fixed;left:0;top:0;width:12px;height:100%;background:rgb(10,120,60);z-index:9}
 #R{position:fixed;right:0;top:0;width:12px;height:100%;background:rgb(200,30,120);z-index:9}
 /* o #stage nao tem texto: glifo antialiasado no miolo estraga a prova por pixel */
 #stage{position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);width:160px;height:160px;
        background:rgb(217,108,63);z-index:20}
 #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;padding:24px 30px}
 .card{border:1px solid #26241f;background:#fff;padding:10px}
 #target{position:fixed;right:40px;bottom:60px;width:120px;height:44px;z-index:30;
         background:rgb(30,60,200);color:#fff;border:0;font:12px Consolas,monospace}
 h1{font-size:16px;padding:16px 30px 0;margin:0}
</style></head><body>
<div id="probe"><h1>SONDA — largura que a pagina enxerga</h1>
<div id="grid">
${Array.from({ length: 24 }, (_, i) => `<article class="card">Card ${i}</article>`).join('')}
</div></div>
<div id="L"></div><div id="R"></div><div id="stage"></div>
<button id="target">ALVO</button>
<script>
 window.__nonce = 'N' + Math.random().toString(36).slice(2, 10)
 window.__lastClick = null
 window.__hits = 0
 var raf = 0
 ;(function loop(){ raf++; requestAnimationFrame(loop) })()
 document.getElementById('target').addEventListener('click', function(){ window.__hits++ })
 document.addEventListener('click', function(e){
   var el = document.elementFromPoint(e.clientX, e.clientY)
   window.__lastClick = {
     id: (e.target && e.target.id) || '', tag: e.target && e.target.tagName,
     clientX: Math.round(e.clientX), clientY: Math.round(e.clientY),
     fromPoint: el ? (el.id || el.tagName) : null, at: Date.now()
   }
 }, true)
 function rect(el){ var r = el.getBoundingClientRect(); return {
   x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
   cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) } }
 window.__facts = function(){
   var probe = document.getElementById('probe')
   var grid = document.getElementById('grid')
   var cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(function(s){ return s }).length
   return {
     nonce: window.__nonce, raf: raf,
     innerWidth: window.innerWidth, innerHeight: window.innerHeight,
     clientWidth: document.documentElement.clientWidth,
     clientHeight: document.documentElement.clientHeight,
     dpr: window.devicePixelRatio,
     layout: getComputedStyle(probe).getPropertyValue('--layout').trim(),
     colunas: cols,
     mq: {
       desktop: window.matchMedia('(min-width:1024px)').matches,
       tablet: window.matchMedia('(min-width:700px) and (max-width:1023px)').matches,
       mobile: window.matchMedia('(max-width:699px)').matches
     },
     scrollW: document.documentElement.scrollWidth,
     rolagemH: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
     alvo: rect(document.getElementById('target')),
     faixaDir: rect(document.getElementById('R')),
     hits: window.__hits, ultimoClique: window.__lastClick
   }
 }
</script></body></html>`
}

// ————————————————————————————————————————————————————————————————
// 2. O MAIN.JS descartável (nasce e morre no scratch; fala por HTTP local)
//    ATENÇÃO: nada de crase nem de interpolação aqui dentro — é template.
// ————————————————————————————————————————————————————————————————

const MAIN_JS = `// main descartavel da SONDA VIEWPORT-FIT (nao e produto).
const { app, BrowserWindow, WebContentsView, session, desktopCapturer } = require('electron')
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
const CHROME_H = 56

let win = null
let view = null       // a view do PAINEL (a cobaia)
let sibling = null    // a IRMA, mesma origem e mesma SESSAO: a prova do vazamento
let outsider = null   // a ESTRANHA: mesma origem, OUTRA partition (outro projeto)
let colorSeed = 0

function withTimeout(p, ms, label) {
  let to = null
  const timer = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('TIMEOUT ' + label + ' ' + ms + 'ms')), ms) })
  return Promise.race([p, timer]).finally(() => clearTimeout(to))
}

function makeView(partition) {
  const prefs = {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false
  }
  // A casa cria uma partition POR PROJETO. Se o mapa de zoom do Chromium for por
  // sessao, o vazamento por origem morre na fronteira do projeto — e isso muda o
  // tamanho do problema.
  if (partition) prefs.session = session.fromPartition(partition)
  const v = new WebContentsView({ webPreferences: prefs })
  v.setBackgroundColor('#ffffff')
  return v
}

function dbgOf(v) {
  const d = v.webContents.debugger
  if (!d.isAttached()) d.attach('1.3')
  return d
}

async function evalIn(v, expression) {
  const r = await dbgOf(v).sendCommand('Runtime.evaluate', {
    expression: expression, returnByValue: true, awaitPromise: false
  })
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result ? r.result.value : null
}

// ——— fatos por BITMAP. Nada de PNG no laco quente: toBitmap() ja entrega BGRA
// cru, e decodificar PNG a cada amostra falsearia a latencia.
function scan(img, palette, tol) {
  if (!img || img.isEmpty()) return { vazia: true }
  const size = img.getSize()
  const buf = img.toBitmap()
  if (!buf || !buf.length || !size.height) return { vazia: true, size: size }
  const stride = Math.floor(buf.length / size.height)
  const px = Math.floor(stride / 4)
  const out = {}
  const names = Object.keys(palette)
  for (let i = 0; i < names.length; i++) out[names[i]] = { count: 0, minX: null, maxX: null }
  const counts = new Map()
  const t = tol || 14
  let total = 0
  for (let y = 0; y < size.height; y += 2) {
    for (let x = 0; x < px; x += 1) {
      const i = y * stride + x * 4
      const r = buf[i + 2], g = buf[i + 1], b = buf[i]
      const k = r + ',' + g + ',' + b
      counts.set(k, (counts.get(k) || 0) + 1)
      total++
      for (let n = 0; n < names.length; n++) {
        const p = palette[names[n]]
        if (Math.abs(r - p[0]) <= t && Math.abs(g - p[1]) <= t && Math.abs(b - p[2]) <= t) {
          const e = out[names[n]]
          e.count++
          if (e.minX === null || x < e.minX) e.minX = x
          if (e.maxX === null || x > e.maxX) e.maxX = x
        }
      }
    }
  }
  let dominant = null, best = 0
  for (const e of counts) if (e[1] > best) { best = e[1]; dominant = e[0] }
  return {
    vazia: false, size: size, bitmapPx: [px, size.height],
    dominante: dominant, dominanteShare: total ? Math.round((best / total) * 100) : 0,
    cores: counts.size, achados: out
  }
}

const PALETTE = { faixaEsq: [10, 120, 60], faixaDir: [200, 30, 120], stage: [217, 108, 63], alvo: [30, 60, 200] }

function near(dominant, want, tol) {
  if (!dominant || !want) return false
  const a = dominant.split(',').map(Number)
  const b = want.split(',').map(Number)
  for (let i = 0; i < 3; i++) if (Math.abs(a[i] - b[i]) > (tol || 10)) return false
  return true
}

/** target 'view' = a superficie da PAGINA (o que o agente fotografa).
 *  target 'win'  = a JANELA composta na regiao da moldura — e o que o DONO VE.
 *  Os dois nao sao a mesma coisa quando ha emulacao: a superficie da view passa
 *  a ter o tamanho EMULADO, e so um pedaco dela aparece na tela. */
async function captureOnce(opts) {
  const o = opts || {}
  const t0 = process.hrtime.bigint()
  let img = null, timedOut = false, error = null
  try {
    if (o.target === 'win') {
      const b = view.getBounds()
      img = await withTimeout(win.webContents.capturePage({ x: b.x, y: b.y, width: b.width, height: b.height }), o.timeoutMs || 4000, 'winCapture')
    } else {
      img = await withTimeout(view.webContents.capturePage(o.rect || undefined), o.timeoutMs || 4000, 'capturePage')
    }
  } catch (e) {
    timedOut = /TIMEOUT/.test(String(e && e.message))
    error = String(e && e.message)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return {
    ms: Math.round(ms * 100) / 100, timedOut: timedOut, error: error,
    facts: img ? scan(img, o.palette || PALETTE, o.tol) : { vazia: true, faltou: true },
    png: img && !img.isEmpty() ? img.toPNG() : null
  }
}

async function clearAll() {
  try { await dbgOf(view).sendCommand('Emulation.clearDeviceMetricsOverride') } catch (e) {}
  try { view.webContents.setZoomFactor(1) } catch (e) {}
}

const ops = {
  async hello() {
    return {
      pid: process.pid, winId: win.id, viewWcId: view.webContents.id,
      siblingWcId: sibling ? sibling.webContents.id : null,
      viewBounds: view.getBounds(), contentSize: win.getContentSize(),
      url: view.webContents.getURL()
    }
  },

  /** Aplica UMA das receitas e devolve o que o motor fez (nao o que ele disse). */
  async apply(b) {
    const mode = b.mode
    const logical = b.logical || 1280
    const bounds = view.getBounds()
    await clearAll()
    const zoom = bounds.width / logical
    const emuHeight = Math.max(1, Math.round(bounds.height / zoom))
    const t0 = process.hrtime.bigint()
    const passos = []
    if (mode === 'A-emul-zoom') {
      await dbgOf(view).sendCommand('Emulation.setDeviceMetricsOverride', {
        width: logical, height: emuHeight, deviceScaleFactor: 1, mobile: false
      })
      passos.push('setDeviceMetricsOverride(' + logical + 'x' + emuHeight + ', dsf=1)')
      view.webContents.setZoomFactor(zoom)
      passos.push('setZoomFactor(' + Math.round(zoom * 10000) / 10000 + ')')
    } else if (mode === 'B-emul-scale') {
      await dbgOf(view).sendCommand('Emulation.setDeviceMetricsOverride', {
        width: logical, height: emuHeight, deviceScaleFactor: 1, mobile: false, scale: zoom
      })
      passos.push('setDeviceMetricsOverride(' + logical + 'x' + emuHeight + ', scale=' + Math.round(zoom * 10000) / 10000 + ')')
    } else if (mode === 'C-zoom-only') {
      view.webContents.setZoomFactor(zoom)
      passos.push('setZoomFactor(' + Math.round(zoom * 10000) / 10000 + ') sozinho')
    } else if (mode === 'D-emul-h0-zoom') {
      await dbgOf(view).sendCommand('Emulation.setDeviceMetricsOverride', {
        width: logical, height: 0, deviceScaleFactor: 0, mobile: false
      })
      passos.push('setDeviceMetricsOverride(' + logical + ', height=0, dsf=0)')
      view.webContents.setZoomFactor(zoom)
      passos.push('setZoomFactor(' + Math.round(zoom * 10000) / 10000 + ')')
    } else if (mode === 'E-emul-only') {
      await dbgOf(view).sendCommand('Emulation.setDeviceMetricsOverride', {
        width: logical, height: emuHeight, deviceScaleFactor: 1, mobile: false
      })
      passos.push('setDeviceMetricsOverride(' + logical + 'x' + emuHeight + ') SEM escala')
    } else if (mode === 'F-dpr-pin') {
      // A largura da emulacao e PRE-zoom: pinar a MOLDURA (400) e depois dividir
      // pelo zoom da a mesma viewport logica do C, mas com o dpr preso em 1.
      await dbgOf(view).sendCommand('Emulation.setDeviceMetricsOverride', {
        width: bounds.width, height: bounds.height, deviceScaleFactor: 1, mobile: false
      })
      passos.push('setDeviceMetricsOverride(' + bounds.width + 'x' + bounds.height + ', dsf=1) [a MOLDURA]')
      view.webContents.setZoomFactor(zoom)
      passos.push('setZoomFactor(' + Math.round(zoom * 10000) / 10000 + ')')
    } else if (mode === 'auto') {
      passos.push('nada (o de hoje)')
    } else {
      throw new Error('modo desconhecido: ' + mode)
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    await new Promise((r) => setTimeout(r, b.settleMs || 260))
    return {
      mode: mode, passos: passos, aplicarMs: Math.round(ms * 100) / 100,
      zoomPedido: Math.round(zoom * 100000) / 100000,
      zoomReal: Math.round(view.webContents.getZoomFactor() * 100000) / 100000,
      emuHeight: emuHeight, bounds: bounds
    }
  },

  async clear() { await clearAll(); await new Promise((r) => setTimeout(r, 200)); return { limpo: true, zoom: view.webContents.getZoomFactor() } },

  async facts() { return await evalIn(view, 'JSON.stringify(window.__facts())').then(JSON.parse) },
  async siblingFacts() { return await evalIn(sibling, 'JSON.stringify(window.__facts())').then(JSON.parse) },

  async setBounds(b) {
    view.setBounds({ x: 0, y: CHROME_H, width: b.width, height: b.height })
    await new Promise((r) => setTimeout(r, b.settleMs || 260))
    return { bounds: view.getBounds() }
  },

  async setZoomRaw(b) {
    view.webContents.setZoomFactor(b.factor)
    await new Promise((r) => setTimeout(r, 180))
    return { pedido: b.factor, real: Math.round(view.webContents.getZoomFactor() * 100000) / 100000 }
  },

  async siblingZoom() { return { zoom: Math.round(sibling.webContents.getZoomFactor() * 100000) / 100000 } },
  /** Some com as vizinhas: no retrato do SO elas tambem tem as faixas, e o
   *  scanner nao sabe de qual view veio o pixel. Sem isto a prova nao prova. */
  async onlyCobaia(b) {
    const on = !(b && b.off === true)
    sibling.setVisible(!on)
    outsider.setVisible(false)
    await new Promise((r) => setTimeout(r, 260))
    return { irmaVisivel: sibling.getVisible() }
  },

  async outsiderFacts() { return await evalIn(outsider, 'JSON.stringify(window.__facts())').then(JSON.parse) },
  async outsiderZoom() { return { zoom: Math.round(outsider.webContents.getZoomFactor() * 100000) / 100000 } },

  /** NAVEGAR PARA OUTRA ORIGEM: o zoom do Chromium e por HOST. A pagina nova
   *  herda o zoom do host NOVO (que e 1), e a moldura continua estreita — ou
   *  seja, a receita tem de ser RE-APLICADA depois de navegar. */
  async navigateTo(b) {
    const wc = view.webContents
    const done = new Promise((res) => wc.once('did-finish-load', res))
    wc.loadURL(b.url)
    await withTimeout(done, 8000, 'navegar')
    await new Promise((r) => setTimeout(r, 250))
    const f = await evalIn(view, 'JSON.stringify(window.__facts())').then(JSON.parse)
    return {
      url: wc.getURL(),
      zoomDepois: Math.round(wc.getZoomFactor() * 100000) / 100000,
      innerWidth: f.innerWidth, layout: f.layout
    }
  },

  /** O QUE O DONO VE, composto pelo SISTEMA OPERACIONAL (nao pelo Chromium):
   *  a unica prova que nao depende de eu acreditar em como o compositor recorta
   *  a superficie da view dentro da moldura. */
  async osShot(b) {
    const o = b || {}
    const sources = await desktopCapturer.getSources({
      types: ['window'], thumbnailSize: { width: 1400, height: 1100 }
    })
    const hit = sources.find((s) => s.name && s.name.indexOf('SONDA-VPFIT') >= 0)
    if (!hit) return { achou: false, nomes: sources.map((s) => s.name).slice(0, 12) }
    const img = hit.thumbnail
    if (o.save) { try { fs.writeFileSync(path.join(OUT, 'shots', o.save + '.png'), img.toPNG()) } catch (e) {} }
    return { achou: true, facts: scan(img, PALETTE, 18) }
  },

  /** Captura e conta o que apareceu (as duas faixas). de = 'view' ou 'win'. */
  async shot(b) {
    const o = b || {}
    const s = await captureOnce({ timeoutMs: 4000, target: o.de === 'win' ? 'win' : 'view', rect: o.rect })
    if (s.png && o.save) { try { fs.writeFileSync(path.join(OUT, 'shots', o.save + '.png'), s.png) } catch (e) {} }
    return { ms: s.ms, timedOut: s.timedOut, error: s.error, facts: s.facts, bytes: s.png ? s.png.length : 0 }
  },

  /** LEI 2 da casa: frescor e carimbo. Pinta cor INEDITA e cronometra ate ela
   *  aparecer no bitmap — quadro velho responde rapido e MENTE.
   *  A busca e pela COR EM QUALQUER LUGAR do quadro (nao pela dominante de um
   *  retangulo): sob escala, o mesmo #stage ocupa um pedaco menor da moldura, e
   *  a dominante passaria a ser o papel — mediria a minha regua, nao o motor. */
  async fresh(b) {
    const o = b || {}
    colorSeed++
    const r = (colorSeed * 53) % 190 + 30
    const g = (colorSeed * 97) % 190 + 30
    const bl = (colorSeed * 31) % 190 + 30
    const want = r + ',' + g + ',' + bl
    const palette = { novo: [r, g, bl] }
    const paintedAt = Date.now()
    try {
      await withTimeout(evalIn(view, "document.getElementById('stage').style.background='rgb(" + r + "," + g + "," + bl + ")'"), 4000, 'paint')
    } catch (e) {
      return { want: want, msToFresh: null, erro: 'paint: ' + String(e && e.message) }
    }
    const deadline = Date.now() + (o.budgetMs || 4000)
    let attempts = 0, lastMs = null, melhor = 0
    while (Date.now() < deadline) {
      attempts++
      const s = await captureOnce({ timeoutMs: 1500, palette: palette, tol: 10, target: o.de === 'win' ? 'win' : 'view' })
      lastMs = s.ms
      const achou = s.facts && s.facts.achados && s.facts.achados.novo ? s.facts.achados.novo.count : 0
      if (achou > melhor) melhor = achou
      if (!s.facts.vazia && achou >= (o.minPx || 20)) {
        return { want: want, msToFresh: Date.now() - paintedAt, attempts: attempts, captureMs: lastMs, px: achou }
      }
      if (s.timedOut) return { want: want, msToFresh: null, pendurou: true, attempts: attempts, captureMs: lastMs }
    }
    return { want: want, msToFresh: null, esgotou: true, attempts: attempts, captureMs: lastMs, melhorPx: melhor }
  },

  /** A MESMA receita aplicada N vezes seguidas: a largura que a pagina enxerga
   *  e ESTAVEL, ou depende de corrida entre os dois botoes? */
  async applyTimes(b) {
    const out = []
    for (let i = 0; i < (b.times || 5); i++) {
      const a = await ops.apply({ mode: b.mode, logical: b.logical, settleMs: b.settleMs || 300 })
      const f = await evalIn(view, 'JSON.stringify(window.__facts())').then(JSON.parse)
      out.push({ i: i + 1, innerWidth: f.innerWidth, layout: f.layout, zoomReal: a.zoomReal, dpr: f.dpr })
    }
    return out
  },

  /** CLIQUE PELO CDP em coordenada LOGICA (o caminho do driver da casa). */
  async clickCdp(b) {
    await evalIn(view, 'window.__lastClick = null; window.__hits = 0')
    const d = dbgOf(view)
    const t0 = process.hrtime.bigint()
    for (const type of ['mousePressed', 'mouseReleased']) {
      await d.sendCommand('Input.dispatchMouseEvent', {
        type: type, x: b.x, y: b.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1
      })
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    await new Promise((r) => setTimeout(r, 160))
    const f = await evalIn(view, 'JSON.stringify({hits: window.__hits, last: window.__lastClick})').then(JSON.parse)
    return { enviado: { x: b.x, y: b.y }, ms: Math.round(ms * 100) / 100, hits: f.hits, ultimo: f.last }
  },

  /** CLIQUE NATIVO em coordenada FISICA da moldura (o mouse do DONO). */
  async clickNative(b) {
    await evalIn(view, 'window.__lastClick = null; window.__hits = 0')
    const t0 = process.hrtime.bigint()
    view.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 })
    view.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    await new Promise((r) => setTimeout(r, 200))
    const f = await evalIn(view, 'JSON.stringify({hits: window.__hits, last: window.__lastClick})').then(JSON.parse)
    return { enviado: { x: b.x, y: b.y }, ms: Math.round(ms * 100) / 100, hits: f.hits, ultimo: f.last }
  },

  async quit() { setTimeout(() => app.exit(0), 120); return { quitting: true } }
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 980, height: 780, show: false, title: 'SONDA-VPFIT',
    backgroundColor: '#26241f',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.on('page-title-updated', (e) => e.preventDefault())
  await win.loadURL('data:text/html,<body style="margin:0;background:%2326241f"></body>')
  if (HEADED) win.showInactive()

  view = makeView()
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: CHROME_H, width: 400, height: 600 })
  view.webContents.loadURL(PAGES + '/page')
  await new Promise((res) => view.webContents.once('did-finish-load', res))
  dbgOf(view)

  // a IRMA: MESMA origem, MESMA sessao (default), so que numa moldura larga.
  // E ela quem responde se o zoom do Chromium vaza por ORIGEM.
  sibling = makeView()
  win.contentView.addChildView(sibling)
  sibling.setBounds({ x: 420, y: CHROME_H, width: 540, height: 600 })
  sibling.webContents.loadURL(PAGES + '/page')
  await new Promise((res) => sibling.webContents.once('did-finish-load', res))
  dbgOf(sibling)

  // A ESTRANHA: MESMA origem, OUTRA partition (o vizinho de outro PROJETO).
  outsider = makeView('persist:sonda-outro-projeto')
  win.contentView.addChildView(outsider)
  outsider.setBounds({ x: 420, y: CHROME_H, width: 540, height: 600 })
  outsider.setVisible(false)
  outsider.webContents.loadURL(PAGES + '/page')
  await new Promise((res) => outsider.webContents.once('did-finish-load', res))
  dbgOf(outsider)

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

app.on('window-all-closed', () => {})
`

// ————————————————————————————————————————————————————————————————
// 3. orquestração
// ————————————————————————————————————————————————————————————————

let electronChild = null
let control = null
let pagesServer = null

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
  await sleep(300)
  killTree(electronChild?.pid)
  try { pagesServer?.close() } catch {}
  if (!KEEP) {
    try { rmSync(APP_DIR, { recursive: true, force: true }) } catch {}
  }
}

const MODES = ['auto', 'A-emul-zoom', 'B-emul-scale', 'C-zoom-only', 'D-emul-h0-zoom', 'E-emul-only', 'F-dpr-pin']

/** O veredito de UMA receita: mede tudo e diz se a moldura mostra a página
 *  inteira. Nada aqui é opinião — cada campo tem um número atrás. */
function faixas(shot) {
  const achados = shot?.facts?.achados ?? {}
  const w = shot?.facts?.bitmapPx?.[0] ?? 0
  const dir = achados.faixaDir ?? { count: 0, maxX: null }
  const esq = achados.faixaEsq ?? { count: 0, minX: null }
  return {
    bitmapW: w,
    esq,
    dir,
    // "a largura inteira apareceu" = as DUAS faixas no quadro, e a da direita
    // encostada na borda direita (dentro de 6% da largura do quadro).
    inteira: dir.count > 0 && esq.count > 0 && w > 0 && dir.maxX !== null && dir.maxX >= w * 0.94,
    // quanto da moldura a página ocupa (o resto é faixa vazia — o letterbox)
    ocupaPct: w > 0 && dir.maxX !== null ? Math.round(((dir.maxX + 1) / w) * 100) : null
  }
}

async function measure(mode, tag) {
  const applied = await call('apply', { mode, logical: 1280 })
  const facts = await call('facts')
  const daView = await call('shot', { save: `${tag ?? mode}-view`, de: 'view' })
  // O PEDAÇO QUE CABE NA MOLDURA. A superfície da view passa a ter o tamanho
  // EMULADO quando há override, e a tela mostra só o retângulo do widget — então
  // "a página inteira apareceu" é uma pergunta sobre ESTE recorte, não sobre a
  // superfície toda. (A prova final, composta pelo SO, é o P9.4.)
  const b = applied.bounds
  const daTela = await call('shot', {
    save: `${tag ?? mode}-moldura`,
    de: 'view',
    rect: { x: 0, y: 0, width: b.width, height: b.height }
  })
  return {
    mode,
    passos: applied.passos,
    aplicarMs: applied.aplicarMs,
    zoomPedido: applied.zoomPedido,
    zoomReal: applied.zoomReal,
    emuHeight: applied.emuHeight,
    innerWidth: facts.innerWidth,
    clientWidth: facts.clientWidth,
    innerHeight: facts.innerHeight,
    dpr: facts.dpr,
    layout: facts.layout,
    colunas: facts.colunas,
    mq: facts.mq,
    rolagemH: facts.rolagemH,
    alvo: facts.alvo,
    view: { ms: daView.ms, ...faixas(daView) },
    tela: { ms: daTela.ms, ...faixas(daTela) },
    larguraInteira: faixas(daTela).inteira
  }
}

async function main() {
  log('=== SONDA VIEWPORT FIT (emular desktop e caber na moldura) ===')
  log(`electron ${report.electron} · node ${process.version} · pages=${PAGES_PORT}`)

  pagesServer = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml())
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => pagesServer.listen(PAGES_PORT, '127.0.0.1', r))

  writeFileSync(join(APP_DIR, 'main.js'), MAIN_JS, 'utf-8')
  writeFileSync(
    join(APP_DIR, 'package.json'),
    JSON.stringify({ name: 'synkora-probe-vpfit', version: '0.0.0', main: 'main.js' }),
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
  log(`\n[app] pid=${hello.pid} view.wc=${hello.viewWcId} irma.wc=${hello.siblingWcId} moldura=${hello.viewBounds.width}x${hello.viewBounds.height}`)

  await runP1()
  await runP7()
  await runP2()
  await runP3()
  await runP8()
  await runP4()
  await runP5()
  await runP9()
  await runP6()

  raw('summary.json', report)
  log(`\n=== evidência crua em ${OUT_DIR} ===`)
}

// ——— P1: as cinco receitas ———
async function runP1() {
  log('\n--- P1: QUAL RECEITA emula 1280 lógicos numa moldura de 400x600 ---')
  const rows = []
  for (const mode of MODES) {
    const m = await measure(mode)
    rows.push(m)
    log(
      `   ${mode.padEnd(15)} innerW=${String(m.innerWidth).padStart(5)} layout=${String(m.layout).padEnd(8)} ` +
        `cols=${String(m.colunas).padStart(2)} dpr=${String(m.dpr).padEnd(6)} zoom=${String(m.zoomReal).padEnd(7)}`
    )
    log(
      `   ${' '.repeat(15)} NA MOLDURA (recorte ${m.tela.bitmapW}px): a página ocupa ${m.tela.ocupaPct}% · inteira=${m.tela.inteira ? 'SIM' : 'NAO'} · ` +
        `superfície da view (${m.view.bitmapW}px): ocupa ${m.view.ocupaPct}% · inteira=${m.view.inteira ? 'SIM' : 'NAO'}`
    )
  }
  report.p1_receitas = rows
  raw('p1-receitas.json', rows)
  const vencedoras = rows.filter((r) => r.mode !== 'auto' && r.tela.inteira && r.innerWidth >= 1200 && r.layout === 'desktop')
  note(`receitas que entregaram desktop INTEIRO NA TELA: ${vencedoras.map((v) => v.mode).join(', ') || 'NENHUMA'}`)
}

// ——— P7: a receita A é determinística? ———
async function runP7() {
  log('\n--- P7: DETERMINISMO (emulação + zoom aplicados juntos, 5 vezes) ---')
  const out = {}
  for (const mode of ['A-emul-zoom', 'B-emul-scale', 'C-zoom-only']) {
    const rows = await call('applyTimes', { mode, logical: 1280, times: 5 })
    out[mode] = rows
    const larguras = [...new Set(rows.map((r) => r.innerWidth))]
    log(`   ${mode.padEnd(15)} larguras vistas em 5 aplicações: ${rows.map((r) => r.innerWidth).join(', ')} ⇒ ${larguras.length === 1 ? 'ESTÁVEL' : 'INSTÁVEL'}`)
  }
  await call('apply', { mode: 'auto' })
  report.p7_determinismo = out
  raw('p7-determinismo.json', out)
}

// ——— P8: a foto do agente sob emulação ———
async function runP8() {
  log('\n--- P8: A FOTO DO AGENTE sob emulação (a superfície é maior que a moldura) ---')
  const out = []
  for (const mode of ['B-emul-scale', 'C-zoom-only']) {
    const applied = await call('apply', { mode, logical: 1280 })
    const cheia = await call('shot', { save: `p8-${mode}-cheia`, de: 'view' })
    // recorte no tamanho da MOLDURA: é o pedaço que o dono vê
    const recorte = await call('shot', {
      save: `p8-${mode}-recorte`,
      de: 'view',
      rect: { x: 0, y: 0, width: 400, height: 600 }
    })
    const f1 = faixas(cheia)
    const f2 = faixas(recorte)
    out.push({ mode, zoomReal: applied.zoomReal, cheia: { ms: cheia.ms, ...f1 }, recorte: { ms: recorte.ms, ...f2 } })
    log(
      `   ${mode.padEnd(15)} capturePage() cheio: ${f1.bitmapW}px, página ocupa ${f1.ocupaPct}% · ` +
        `capturePage({0,0,400,600}): ${f2.bitmapW}px, ocupa ${f2.ocupaPct}%, inteira=${f2.inteira ? 'SIM' : 'nao'}`
    )
  }
  await call('apply', { mode: 'auto' })
  report.p8_foto = out
  raw('p8-foto.json', out)
}

// ——— P2: o input ainda acerta? ———
async function runP2() {
  log('\n--- P2: o INPUT ainda acerta o alvo (CDP lógico + mouse nativo físico) ---')
  // A MATRIZ: dois emissores (o CDP do driver e o mouse nativo do dono) × duas
  // coordenadas (a LÓGICA, que sai do getBoundingClientRect, e a FÍSICA da
  // moldura). É a única forma de descobrir em que espaço cada porta fala.
  const out = []
  for (const mode of MODES) {
    await call('apply', { mode, logical: 1280 })
    const facts = await call('facts')
    const alvo = facts.alvo
    const escala = 400 / (facts.innerWidth || 400)
    const fx = Math.round(alvo.cx * escala)
    const fy = Math.round(alvo.cy * escala)
    const cdpLog = await tryCall('clickCdp', { x: alvo.cx, y: alvo.cy })
    const cdpFis = await tryCall('clickCdp', { x: fx, y: fy })
    const natLog = await tryCall('clickNative', { x: alvo.cx, y: alvo.cy })
    const natFis = await tryCall('clickNative', { x: fx, y: fy })
    const hit = (r) => (r?.hits > 0 ? 'ACERTOU' : r?.ultimo ? `errou (${r.ultimo.id || r.ultimo.tag})` : 'nada')
    out.push({ mode, alvo, escala, logico: { x: alvo.cx, y: alvo.cy }, fisico: { x: fx, y: fy }, cdpLog, cdpFis, natLog, natFis })
    log(
      `   ${mode.padEnd(15)} lógico=(${alvo.cx},${alvo.cy}) físico=(${fx},${fy}) · ` +
        `CDP-lógico ${hit(cdpLog).padEnd(14)} CDP-físico ${hit(cdpFis).padEnd(14)} · ` +
        `nativo-lógico ${hit(natLog).padEnd(14)} nativo-físico ${hit(natFis)}`
    )
  }
  await call('apply', { mode: 'auto' })
  report.p2_input = out
  raw('p2-input.json', out)
}

// ——— P3: captura fresca e inteira ———
async function runP3() {
  log('\n--- P3: a CAPTURA devolve a view lógica inteira e FRESCA ---')
  const out = []
  for (const mode of ['auto', 'B-emul-scale', 'C-zoom-only']) {
    await call('apply', { mode, logical: 1280 })
    const amostras = []
    for (let i = 0; i < SAMPLES; i++) amostras.push(await call('fresh', { budgetMs: 4000, de: 'view' }))
    const bons = amostras.filter((a) => a.msToFresh !== null)
    const ms = bons.map((a) => a.msToFresh).sort((a, b) => a - b)
    const cap = bons.map((a) => a.captureMs).sort((a, b) => a - b)
    const row = {
      mode,
      frescos: `${bons.length}/${amostras.length}`,
      medianaFrescorMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
      medianaCapturaMs: cap.length ? cap[Math.floor(cap.length / 2)] : null,
      pior: ms.length ? ms[ms.length - 1] : null,
      amostras
    }
    out.push(row)
    log(
      `   ${mode.padEnd(15)} frescos ${row.frescos} · mediana até o pixel novo ${row.medianaFrescorMs}ms · captura ${row.medianaCapturaMs}ms · pior ${row.pior}ms`
    )
  }
  report.p3_captura = out
  raw('p3-captura.json', out)
}

// ——— P4: as armadilhas ———
async function runP4() {
  log('\n--- P4: ARMADILHAS (zoom vaza por origem? o piso de 25% grampeia?) ---')
  // 4.1 vazamento por ORIGEM: a irmã tem a mesma URL e a mesma sessão.
  await call('apply', { mode: 'auto' })
  const antes = await call('siblingFacts')
  await call('apply', { mode: 'C-zoom-only', logical: 1280 })
  const depoisZoom = await call('siblingFacts')
  const zoomIrma = await call('siblingZoom')
  await call('apply', { mode: 'auto' })
  await call('apply', { mode: 'B-emul-scale', logical: 1280 })
  const depoisScale = await call('siblingFacts')
  const zoomIrmaScale = await call('siblingZoom')
  await call('apply', { mode: 'auto' })

  const vazouZoom = depoisZoom.innerWidth !== antes.innerWidth
  const vazouScale = depoisScale.innerWidth !== antes.innerWidth
  log(
    `   irmã (mesma origem, moldura 540px): antes innerW=${antes.innerWidth} · ` +
      `depois de setZoomFactor na cobaia: innerW=${depoisZoom.innerWidth} zoom=${zoomIrma.zoom} ⇒ ${vazouZoom ? 'VAZOU' : 'não vazou'}`
  )
  log(
    `   irmã depois de setDeviceMetricsOverride(scale) na cobaia: innerW=${depoisScale.innerWidth} zoom=${zoomIrmaScale.zoom} ⇒ ${vazouScale ? 'VAZOU' : 'não vazou'}`
  )

  // 4.2 o PISO do zoom (o trilho estreito do dono: 300/1280 = 0,234)
  const pisos = []
  for (const f of [0.5, 0.3125, 0.25, 0.234, 0.2, 0.15, 0.1]) {
    const r = await call('setZoomRaw', { factor: f })
    pisos.push(r)
  }
  await call('clear')
  log(`   piso do setZoomFactor: ${pisos.map((p) => `${p.pedido}→${p.real}`).join(' · ')}`)

  // 4.3 o mesmo piso, pelo botão `scale` da CDP (moldura estreita de verdade)
  await call('setBounds', { width: 300, height: 600 })
  const estreitoScale = await measure('B-emul-scale', 'p4-estreito-scale')
  const estreitoZoom = await measure('A-emul-zoom', 'p4-estreito-zoom')
  await call('setBounds', { width: 400, height: 600 })
  await call('apply', { mode: 'auto' })
  log(
    `   moldura 300px (o trilho do dono): scale ⇒ innerW=${estreitoScale.innerWidth} layout=${estreitoScale.layout} inteira=${estreitoScale.larguraInteira ? 'SIM' : 'nao'} · ` +
      `zoom ⇒ innerW=${estreitoZoom.innerWidth} layout=${estreitoZoom.layout} zoomReal=${estreitoZoom.zoomReal} inteira=${estreitoZoom.larguraInteira ? 'SIM' : 'nao'}`
  )

  report.p4_armadilhas = {
    vazamentoPorOrigem: { antes, depoisZoom, zoomIrma, depoisScale, zoomIrmaScale, vazouZoom, vazouScale },
    pisoZoom: pisos,
    molduraEstreita: { scale: estreitoScale, zoom: estreitoZoom }
  }
  raw('p4-armadilhas.json', report.p4_armadilhas)
}

// ——— P5: a moldura muda de tamanho ———
async function runP5() {
  log('\n--- P5: a MOLDURA MUDA (o dono arrasta o trilho) ---')
  const out = {}
  for (const mode of ['C-zoom-only', 'B-emul-scale']) {
    await call('setBounds', { width: 400, height: 600 })
    const inicial = await measure(mode, `p5-${mode}-400`)
    // o dono arrasta: a moldura cresce e NINGUÉM recalcula a escala
    await call('setBounds', { width: 760, height: 600 })
    const semFacts = await call('facts')
    const semShot = await call('shot', {
      save: `p5-${mode}-760-sem-recalculo`,
      de: 'view',
      rect: { x: 0, y: 0, width: 760, height: 600 }
    })
    const sem = faixas(semShot)
    // e agora COM o recálculo (o que o motor vai fazer a cada relato de bounds)
    const comRecalculo = await measure(mode, `p5-${mode}-760-com-recalculo`)
    out[mode] = {
      inicial: { innerWidth: inicial.innerWidth, zoomReal: inicial.zoomReal, inteiraNaTela: inicial.tela.inteira, ocupaPct: inicial.tela.ocupaPct },
      semRecalculo: { innerWidth: semFacts.innerWidth, ocupaPct: sem.ocupaPct, inteiraNaTela: sem.inteira, bitmapW: sem.bitmapW },
      comRecalculo: {
        innerWidth: comRecalculo.innerWidth,
        zoomReal: comRecalculo.zoomReal,
        inteiraNaTela: comRecalculo.tela.inteira,
        ocupaPct: comRecalculo.tela.ocupaPct
      }
    }
    log(
      `   ${mode}: 400px ⇒ innerW=${out[mode].inicial.innerWidth} ocupa ${out[mode].inicial.ocupaPct}% · ` +
        `moldura vira 760px SEM recalcular ⇒ innerW=${out[mode].semRecalculo.innerWidth}, a página ocupa ${out[mode].semRecalculo.ocupaPct}% da moldura · ` +
        `COM recalcular ⇒ innerW=${out[mode].comRecalculo.innerWidth} zoom=${out[mode].comRecalculo.zoomReal} ocupa ${out[mode].comRecalculo.ocupaPct}% inteira=${out[mode].comRecalculo.inteiraNaTela ? 'SIM' : 'nao'}`
    )
  }
  await call('setBounds', { width: 400, height: 600 })
  report.p5_moldura = out
  raw('p5-moldura.json', out)
}

// ——— P9: o que fecha o veredito ———
async function runP9() {
  log('\n--- P9: A FRONTEIRA do vazamento, a NAVEGAÇÃO, as molduras extremas ---')
  const out = {}

  // 9.1 — o vazamento por origem morre na fronteira da PARTITION (= projeto)?
  await call('apply', { mode: 'auto' })
  const forasteiraAntes = await call('outsiderFacts')
  await call('apply', { mode: 'C-zoom-only', logical: 1280 })
  const forasteiraDepois = await call('outsiderFacts')
  const irmaDepois = await call('siblingFacts')
  out.fronteira = {
    forasteiraAntes: forasteiraAntes.innerWidth,
    forasteiraDepois: forasteiraDepois.innerWidth,
    zoomForasteira: (await call('outsiderZoom')).zoom,
    irmaDepois: irmaDepois.innerWidth,
    atravessaPartition: forasteiraDepois.innerWidth !== forasteiraAntes.innerWidth
  }
  log(
    `   outra partition (outro PROJETO), mesma origem: innerW ${out.fronteira.forasteiraAntes} → ${out.fronteira.forasteiraDepois} ` +
      `(zoom=${out.fronteira.zoomForasteira}) ⇒ ${out.fronteira.atravessaPartition ? 'ATRAVESSA a partition' : 'PARA na partition'} · ` +
      `irmã da MESMA partition: ${out.fronteira.irmaDepois}`
  )

  // 9.2 — navegar para OUTRA origem: o zoom volta a 1 e a receita morre?
  const outraOrigem = await call('navigateTo', { url: `http://127.0.0.1:${PAGES_PORT}/page` })
  out.navegacao = { ...outraOrigem, perdeuAReceita: outraOrigem.innerWidth < 1200 }
  log(
    `   navegou para outra ORIGEM (127.0.0.1) com a receita ligada: zoom=${outraOrigem.zoomDepois} innerW=${outraOrigem.innerWidth} (${outraOrigem.layout}) ⇒ ` +
      `${out.navegacao.perdeuAReceita ? 'PERDEU a emulação — tem de re-aplicar' : 'sobreviveu'}`
  )
  // e o mesmo host, outra página: sobrevive?
  await call('navigateTo', { url: `http://127.0.0.1:${PAGES_PORT}/page?x=2` })
  await call('apply', { mode: 'auto' })
  await call('navigateTo', { url: `http://127.0.0.1:${PAGES_PORT}/page` })

  // 9.3 — molduras extremas: o trilho de 300px e o pop-out de 1400px
  const extremos = []
  for (const w of [300, 500, 1400]) {
    await call('setBounds', { width: w, height: 600 })
    const m = await measure('C-zoom-only', `p9-c-${w}`)
    extremos.push({
      moldura: w,
      innerWidth: m.innerWidth,
      zoomReal: m.zoomReal,
      layout: m.layout,
      dpr: m.dpr,
      inteiraNaSuperficie: m.view.inteira,
      ocupaPct: m.view.ocupaPct
    })
    log(
      `   moldura ${String(w).padStart(4)}px ⇒ zoom=${String(m.zoomReal).padEnd(8)} innerW=${String(m.innerWidth).padStart(5)} ` +
        `layout=${m.layout} dpr=${m.dpr} · a página ocupa ${m.view.ocupaPct}% da superfície (inteira=${m.view.inteira ? 'SIM' : 'nao'})`
    )
  }
  out.extremos = extremos
  // O TETO do zoom: o botão 375 numa janela destacada larga pede AMPLIAÇÃO
  // (1400/375 = 3,7×). O Chromium tem preset máximo de 500% — ele grampeia?
  const ampliacoes = []
  for (const [w, logical] of [[400, 375], [1400, 375], [1400, 768]]) {
    await call('setBounds', { width: w, height: 600 })
    const a = await call('apply', { mode: 'C-zoom-only', logical })
    const f = await call('facts')
    ampliacoes.push({ moldura: w, pedido: logical, zoom: a.zoomReal, innerWidth: f.innerWidth, layout: f.layout, bateu: f.innerWidth === logical })
    log(
      `   moldura ${String(w).padStart(4)}px pedindo ${logical} ⇒ zoom=${a.zoomReal} innerW=${f.innerWidth} (${f.layout}) ⇒ ${f.innerWidth === logical ? 'EXATO' : 'GRAMPEOU'}`
    )
  }
  out.ampliacoes = ampliacoes
  await call('setBounds', { width: 400, height: 600 })

  // 9.4 — O QUE O DONO VÊ, composto pelo SO
  // Só a cobaia na tela: as vizinhas têm as MESMAS faixas, e o scanner do
  // retrato do SO não sabe de qual view veio o pixel.
  await call('onlyCobaia')
  const osOut = []
  for (const mode of ['auto', 'C-zoom-only', 'B-emul-scale', 'E-emul-only']) {
    await call('apply', { mode, logical: 1280 })
    const s = await call('osShot', { save: `p9-os-${mode}` })
    if (!s.achou) {
      log(`   desktopCapturer não achou a janela (${(s.nomes || []).slice(0, 4).join(' | ')})`)
      break
    }
    const a = s.facts.achados
    // A moldura ocupa 400 de 980 px de conteúdo da janela ⇒ ~41% da largura do
    // retrato. A faixa DIREITA da página só pode aparecer aí dentro; achá-la
    // depois disso seria pixel de outra coisa.
    const larguraRetrato = s.facts.bitmapPx?.[0] ?? 0
    const fimDaMoldura = Math.round(larguraRetrato * 0.42)
    const dirDentro = a.faixaDir.count > 0 && a.faixaDir.maxX !== null && a.faixaDir.maxX <= fimDaMoldura
    osOut.push({
      mode, larguraRetrato, fimDaMoldura,
      esq: a.faixaEsq.count, esqMinX: a.faixaEsq.minX,
      dir: a.faixaDir.count, dirMaxX: a.faixaDir.maxX,
      donoVeABordaDireita: dirDentro
    })
    log(
      `   [SO] ${mode.padEnd(15)} retrato ${larguraRetrato}px, moldura até x≈${fimDaMoldura} · ` +
        `faixa esq=${a.faixaEsq.count}px (x≥${a.faixaEsq.minX}) · faixa DIR=${a.faixaDir.count}px (x≤${a.faixaDir.maxX}) ⇒ ` +
        `${dirDentro ? 'o dono VÊ a borda direita' : 'a borda direita NÃO aparece na moldura'}`
    )
  }
  out.telaDoSO = osOut
  await call('apply', { mode: 'auto' })
  await call('onlyCobaia', { off: true })
  report.p9_fronteira = out
  raw('p9-fronteira.json', out)
}

// ——— P6: a volta para o modo de hoje ———
async function runP6() {
  log('\n--- P6: a VOLTA (auto = o comportamento de hoje) ---')
  await call('apply', { mode: 'B-emul-scale', logical: 1280 })
  const emulado = await call('facts')
  await call('clear')
  await sleep(250)
  const voltou = await call('facts')
  const shot = await call('shot', { save: 'p6-auto' })
  const row = {
    emulado: { innerWidth: emulado.innerWidth, layout: emulado.layout },
    depoisDoClear: { innerWidth: voltou.innerWidth, layout: voltou.layout, dpr: voltou.dpr, nonce: voltou.nonce },
    mesmoNonce: emulado.nonce === voltou.nonce,
    captura: { ms: shot.ms, cores: shot.facts?.cores }
  }
  report.p6_volta = row
  log(
    `   emulado innerW=${row.emulado.innerWidth} (${row.emulado.layout}) → clear ⇒ innerW=${row.depoisDoClear.innerWidth} (${row.depoisDoClear.layout}) · ` +
      `a página RECARREGOU? ${row.mesmoNonce ? 'não (mesmo nonce)' : 'SIM'}`
  )
  raw('p6-volta.json', row)
}

main()
  .catch((e) => {
    report.errors.push(String(e?.stack || e))
    log(`\n!! ${String(e?.message || e)}`)
  })
  .finally(async () => {
    await cleanup()
    raw('summary.json', report)
    if (report.errors.length) log(`\n(${report.errors.length} erro(s) registrado(s) em summary.json)`)
  })

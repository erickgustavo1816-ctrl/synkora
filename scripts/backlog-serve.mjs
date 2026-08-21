// O CONSOLE DO BACKLOG (localhost — 2026-08-21, ordem do dono: "não adianta
// só eu ver, eu quero poder mexer").
//
// Servidor local sem dependência: GET / entrega o console interativo (arrastar
// entre trilhos, adicionar item, "vamos fazer"); POST /api grava no MESMO
// docs/backlog-synkora.json que o MCP e o CLI usam, carimbando by:'dono' no
// diário — é assim que o orquestrador fica sabendo (backlog_inbox). Toda
// mutação re-renderiza o HTML estático do artifact.
//
// Sobe junto com o Windows via atalho na pasta Startup (scripts abaixo).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  LANES,
  addItem,
  appendJournal,
  loadBacklog,
  moveItem,
  removeItem,
  saveBacklog,
  updateItem
} from './backlog.mjs'

const PORT = Number(process.env.SYNKORA_BACKLOG_PORT ?? 8090)
const HTML_PATH = fileURLToPath(new URL('../docs/backlog-synkora.html', import.meta.url))

const CONSOLE_PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backlog Synkora — console</title>
<style>
  :root { --paper:#efe9dc; --card:#f6f1e6; --panel:#26241f; --panel-ink:#efe9dc; --ink:#26241f;
    --ink-2:#57534a; --ink-3:#857f70; --accent:#d96c3f; --ok:#3e9b5f; --line:#c9c2b0;
    --mono:"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,monospace; }
  * { box-sizing:border-box; }
  body { background:var(--paper); color:var(--ink); font-family:var(--mono); font-size:13.5px;
    line-height:1.5; margin:0; padding:24px 18px 60px; }
  .wrap { max-width:920px; margin:0 auto; display:flex; flex-direction:column; gap:20px; }
  header { background:var(--panel); color:var(--panel-ink); border-radius:10px; padding:14px 20px;
    display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 16px; }
  h1 { font-size:16px; margin:0; letter-spacing:.14em; text-transform:uppercase; }
  header .hint { color:#b8b09c; font-size:11.5px; }
  h2 { font-size:11.5px; letter-spacing:.18em; text-transform:uppercase; margin:0; color:var(--ink-2);
    display:flex; gap:10px; align-items:baseline; }
  h2::after { content:""; flex:1; border-bottom:1px solid var(--line); transform:translateY(-4px); }
  section { display:flex; flex-direction:column; gap:8px; }
  .lane { min-height:34px; border-radius:9px; display:flex; flex-direction:column; gap:8px;
    padding:2px; transition:background .12s ease; }
  .lane.dragover { background:rgba(217,108,63,.12); outline:2px dashed var(--accent); }
  .card { background:var(--card); border:1.5px solid var(--ink); border-radius:9px; padding:9px 13px;
    display:grid; grid-template-columns:1fr auto; gap:2px 10px; cursor:grab; }
  .card:active { cursor:grabbing; }
  .card .title { font-weight:700; }
  .card .desc { grid-column:1 / -1; color:var(--ink-2); font-size:12.5px; }
  .card .id { grid-column:1 / -1; color:var(--ink-3); font-size:10.5px; letter-spacing:.04em; }
  .card .acts { display:flex; gap:6px; align-self:start; }
  .card button { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase;
    background:transparent; border:1px solid var(--ink-2); border-radius:5px; color:var(--ink-2);
    padding:2px 8px; cursor:pointer; }
  .card button:hover, .card button:focus-visible { border-color:var(--ink); color:var(--ink); outline:none; }
  .card button.go { border-color:var(--accent); color:var(--accent); font-weight:700; }
  .card button.go:hover { background:var(--accent); color:var(--paper); }
  .lane-agora .card { border-color:var(--accent); border-width:2px; }
  .lane-candidatas .card, .lane-dividas .card { border-style:dashed; border-color:var(--ink-2); background:transparent; }
  .lane-feito .card { border:0; border-left:3px solid var(--ok); border-radius:0 7px 7px 0; cursor:default; }
  form.add { display:flex; gap:8px; flex-wrap:wrap; background:var(--card); border:1.5px solid var(--ink);
    border-radius:9px; padding:10px 13px; }
  form.add input, form.add select { font-family:var(--mono); font-size:12.5px; background:var(--paper);
    border:1px solid var(--line); border-radius:6px; padding:5px 8px; color:var(--ink); }
  form.add input[name=title] { flex:2 1 220px; }
  form.add input[name=desc] { flex:3 1 280px; }
  form.add button { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase;
    background:var(--ink); color:var(--paper); border:1.5px solid var(--ink); border-radius:6px;
    padding:5px 14px; cursor:pointer; }
  #toast { position:fixed; bottom:18px; left:50%; transform:translateX(-50%); background:var(--panel);
    color:var(--panel-ink); border-radius:8px; padding:8px 16px; font-size:12px; opacity:0;
    transition:opacity .15s ease; pointer-events:none; }
  #toast.on { opacity:1; }
  @media (prefers-reduced-motion: reduce) { .lane, #toast { transition:none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>✦ Backlog Synkora — console</h1>
    <span class="hint">arraste entre trilhos · "vamos fazer" empurra pra fila · tudo que você mexe aqui o orquestrador vê no diário</span>
  </header>
  <form class="add" id="addForm">
    <input name="title" placeholder="novo item — título" required>
    <input name="desc" placeholder="uma linha de contexto (opcional)">
    <select name="lane">
      <option value="candidatas">candidatas</option>
      <option value="fila">fila</option>
      <option value="agora">agora</option>
      <option value="dividas">dívidas</option>
    </select>
    <button type="submit">+ adicionar</button>
  </form>
  <div id="board"></div>
  <div id="toast" role="status"></div>
</div>
<script>
const LANE_META = {
  agora: 'Agora — em curso',
  fila: 'Fila — ordem do dono',
  candidatas: 'Candidatas — sem urgência',
  dividas: 'Dívidas de higiene',
  feito: 'Feito recente'
}
let toastTimer
function toast(text) {
  const el = document.getElementById('toast')
  el.textContent = text
  el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200)
}
async function api(body) {
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const out = await res.json()
  if (!out.ok) toast('recusado: ' + out.error)
  else toast(out.msg)
  await load()
}
function card(item, lane) {
  const el = document.createElement('div')
  el.className = 'card'
  el.draggable = lane !== 'feito'
  el.dataset.id = item.id
  const acts = []
  if (lane === 'candidatas' || lane === 'dividas')
    acts.push('<button class="go" data-act="vamos">vamos fazer</button>')
  if (lane !== 'feito' && lane !== 'agora')
    acts.push('<button data-act="agora">agora</button>')
  if (lane !== 'feito') acts.push('<button data-act="feito">feito</button>')
  acts.push('<button data-act="remove">×</button>')
  el.innerHTML =
    '<span class="title"></span><span class="acts">' + acts.join('') + '</span>' +
    (item.desc ? '<span class="desc"></span>' : '') +
    '<span class="id"></span>'
  el.querySelector('.title').textContent = item.title
  if (item.desc) el.querySelector('.desc').textContent = item.desc
  el.querySelector('.id').textContent = item.id + (item.refs && item.refs.length ? ' · ' + item.refs.join(' · ') : '')
  el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', item.id))
  el.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act
    if (!act) return
    if (act === 'vamos') api({ verb: 'move', id: item.id, lane: 'fila', flag: 'vamos-fazer' })
    if (act === 'agora') api({ verb: 'move', id: item.id, lane: 'agora' })
    if (act === 'feito') api({ verb: 'move', id: item.id, lane: 'feito' })
    if (act === 'remove' && confirm('Remover "' + item.title + '"?')) api({ verb: 'remove', id: item.id })
  })
  return el
}
async function load() {
  const doc = await (await fetch('/data')).json()
  const board = document.getElementById('board')
  board.innerHTML = ''
  for (const lane of Object.keys(LANE_META)) {
    const section = document.createElement('section')
    const h = document.createElement('h2')
    h.textContent = LANE_META[lane]
    const zone = document.createElement('div')
    zone.className = 'lane lane-' + lane
    zone.dataset.lane = lane
    for (const item of doc.lanes[lane] || []) zone.appendChild(card(item, lane))
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover') })
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'))
    zone.addEventListener('drop', (e) => {
      e.preventDefault()
      zone.classList.remove('dragover')
      const id = e.dataTransfer.getData('text/plain')
      if (id) api({ verb: 'move', id, lane })
    })
    section.appendChild(h)
    section.appendChild(zone)
    board.appendChild(section)
  }
}
document.getElementById('addForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const data = new FormData(e.target)
  api({ verb: 'add', lane: data.get('lane'), title: data.get('title'), desc: data.get('desc') })
  e.target.reset()
})
load()
</script>
</body>
</html>
`

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function mutate(body) {
  const doc = loadBacklog()
  if (body.verb === 'add') {
    const item = addItem(doc, body.lane, { title: body.title, desc: body.desc })
    appendJournal(doc, { by: 'dono', action: 'add', id: item.id, detail: `→ ${body.lane}` })
    saveBacklog(doc)
    return `adicionado em ${body.lane}`
  }
  if (body.verb === 'move') {
    moveItem(doc, body.id, body.lane, body.position)
    if (body.flag === 'vamos-fazer') updateItem(doc, body.id, { badge: 'vamos fazer — pedido do dono' })
    appendJournal(doc, {
      by: 'dono',
      action: body.flag === 'vamos-fazer' ? 'VAMOS FAZER' : 'move',
      id: body.id,
      detail: `→ ${body.lane}`
    })
    saveBacklog(doc)
    return body.flag === 'vamos-fazer' ? 'na fila — o orquestrador vai ver' : `movido para ${body.lane}`
  }
  if (body.verb === 'remove') {
    removeItem(doc, body.id)
    appendJournal(doc, { by: 'dono', action: 'remove', id: body.id })
    saveBacklog(doc)
    return 'removido'
  }
  throw new Error(`verbo desconhecido: ${body.verb}`)
}

const server = createServer((req, res) => {
  // Só a máquina do dono: nada de rede externa neste console.
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(CONSOLE_PAGE)
    return
  }
  if (req.method === 'GET' && url.pathname === '/data') {
    json(res, 200, loadBacklog())
    return
  }
  if (req.method === 'GET' && url.pathname === '/backlog-synkora.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(HTML_PATH, 'utf8'))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        json(res, 200, { ok: true, msg: mutate(JSON.parse(raw)) })
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    return
  }
  json(res, 404, { ok: false, error: 'rota desconhecida' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`backlog console: http://localhost:${PORT}/`)
})

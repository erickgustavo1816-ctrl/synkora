// O BACKLOG VIVO DO SYNKORA — motor + CLI (2026-08-21, ordem do dono).
//
// Fonte da verdade: docs/backlog-synkora.json. O HTML publicado como artifact
// (docs/backlog-synkora.html) é GERADO daqui — nunca editar o HTML na mão.
// Quem consome: o CLI abaixo, o servidor MCP (scripts/backlog-mcp.mjs) e
// qualquer sessão futura do orquestrador. Depois de toda mutação o HTML é
// re-renderizado; republicar o artifact continua sendo gesto do orquestrador.
//
// CLI:
//   node scripts/backlog.mjs list
//   node scripts/backlog.mjs add <lane> "titulo" ["desc"] ["ref1,ref2"]
//   node scripts/backlog.mjs move <id> <lane> [posicao1based]
//   node scripts/backlog.mjs update <id> campo=valor [...]   (title/desc/badge/refs/day)
//   node scripts/backlog.mjs remove <id>
//   node scripts/backlog.mjs render
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const LANES = ['agora', 'fila', 'candidatas', 'dividas', 'feito']

const DATA_PATH = fileURLToPath(new URL('../docs/backlog-synkora.json', import.meta.url))
const HTML_PATH = fileURLToPath(new URL('../docs/backlog-synkora.html', import.meta.url))

export function loadBacklog(path = DATA_PATH) {
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  if (!doc || typeof doc !== 'object' || !doc.lanes) throw new Error('backlog JSON inválido')
  for (const lane of LANES) if (!Array.isArray(doc.lanes[lane])) doc.lanes[lane] = []
  return doc
}

export function saveBacklog(doc, path = DATA_PATH) {
  doc.updatedAt = new Date().toISOString()
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  renderBacklog(doc)
}

export function findItem(doc, id) {
  for (const lane of LANES) {
    const index = doc.lanes[lane].findIndex((item) => item.id === id)
    if (index >= 0) return { lane, index, item: doc.lanes[lane][index] }
  }
  return null
}

export function slugify(title) {
  const base = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || `item-${Date.now().toString(36)}`
}

export function addItem(doc, lane, { title, desc, refs, badge }) {
  if (!LANES.includes(lane)) throw new Error(`lane desconhecida: ${lane} (use ${LANES.join('/')})`)
  if (!title?.trim()) throw new Error('título vazio')
  let id = slugify(title)
  while (findItem(doc, id)) id = `${id}-2`
  const item = { id, title: title.trim() }
  if (desc?.trim()) item.desc = desc.trim()
  if (refs?.length) item.refs = refs
  if (badge?.trim()) item.badge = badge.trim()
  if (lane === 'feito' && !item.day) item.day = stampToday()
  doc.lanes[lane].push(item)
  return item
}

export function moveItem(doc, id, lane, position) {
  if (!LANES.includes(lane)) throw new Error(`lane desconhecida: ${lane} (use ${LANES.join('/')})`)
  const found = findItem(doc, id)
  if (!found) throw new Error(`item não encontrado: ${id}`)
  doc.lanes[found.lane].splice(found.index, 1)
  if (lane === 'feito' && !found.item.day) found.item.day = stampToday()
  if (lane !== 'feito') delete found.item.day
  const target = doc.lanes[lane]
  const at = position && position >= 1 && position <= target.length + 1 ? position - 1 : target.length
  target.splice(at, 0, found.item)
  return found.item
}

export function updateItem(doc, id, patch) {
  const found = findItem(doc, id)
  if (!found) throw new Error(`item não encontrado: ${id}`)
  for (const key of ['title', 'desc', 'badge', 'day']) {
    if (patch[key] !== undefined) {
      if (String(patch[key]).trim() === '') delete found.item[key]
      else found.item[key] = String(patch[key]).trim()
    }
  }
  if (patch.refs !== undefined) {
    const refs = Array.isArray(patch.refs) ? patch.refs : String(patch.refs).split(',')
    const clean = refs.map((ref) => String(ref).trim()).filter(Boolean)
    if (clean.length) found.item.refs = clean
    else delete found.item.refs
  }
  return found.item
}

export function removeItem(doc, id) {
  const found = findItem(doc, id)
  if (!found) throw new Error(`item não encontrado: ${id}`)
  doc.lanes[found.lane].splice(found.index, 1)
  return found.item
}

// O DIÁRIO: toda mexida registra quem foi (dono no console local, orquestrador
// no MCP/CLI). É o canal do "ele me avisa" — backlog_inbox lê daqui.
export function appendJournal(doc, entry) {
  if (!Array.isArray(doc.journal)) doc.journal = []
  doc.journal.push({ at: new Date().toISOString(), ...entry })
  if (doc.journal.length > 100) doc.journal = doc.journal.slice(-100)
}

export function listBacklog(doc) {
  const lines = []
  const glyphs = { agora: '●', fila: '▸', candidatas: '◇', dividas: '⊟', feito: '✓' }
  for (const lane of LANES) {
    lines.push(`${lane.toUpperCase()} (${doc.lanes[lane].length})`)
    for (const item of doc.lanes[lane]) {
      const refs = item.refs?.length ? `  [${item.refs.join(' · ')}]` : ''
      lines.push(`  ${glyphs[lane]} ${item.id} — ${item.title}${refs}`)
    }
  }
  return lines.join('\n')
}

function stampToday() {
  const now = new Date()
  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
  const dd = String(now.getDate()).padStart(2, '0')
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm} — ${dias[now.getDay()]}`
}

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function refsHtml(item) {
  if (!item.refs?.length) return ''
  const codes = item.refs.map((ref) => `<code>${esc(ref)}</code>`).join(' · ')
  return `\n      <span class="refs">refs: ${codes}</span>`
}

function itemHtml(item, cls, glyph) {
  const badge = item.badge ? `\n      <span class="badge">${esc(item.badge)}</span>` : ''
  const desc = item.desc ? `\n      <span class="desc">${esc(item.desc)}</span>` : ''
  return `    <div class="item ${cls}">
      <span class="glyph">${glyph}</span>
      <span class="title">${esc(item.title)}</span>${badge}${desc}${refsHtml(item)}
    </div>`
}

function doneHtml(items) {
  const parts = []
  let lastDay = null
  for (const item of items) {
    const day = item.day ?? ''
    if (day !== lastDay) {
      parts.push(`      <p class="done-day">${esc(day || 'sem data')}</p>`)
      lastDay = day
    }
    parts.push(
      `      <div class="done"><span class="glyph">✓</span><span class="title">${esc(item.title)}</span>${
        item.refs?.length
          ? `<span class="refs">${item.refs.map((ref) => `<code>${esc(ref)}</code>`).join(' · ')}</span>`
          : ''
      }</div>`
    )
  }
  return parts.join('\n')
}

export function renderBacklog(doc, path = HTML_PATH) {
  const stamp = new Date(doc.updatedAt ?? Date.now())
  const dd = String(stamp.getDate()).padStart(2, '0')
  const mm = String(stamp.getMonth() + 1).padStart(2, '0')
  const fila = doc.lanes.fila
    .map((item, index) => itemHtml(item, 'queue', item.id === 'restart-pendente' ? '⟳' : String(index + 1)))
    .join('\n')
  const html = `<title>Backlog Synkora</title>
<style>
  :root {
    --paper: #efe9dc;
    --card: #f6f1e6;
    --panel: #26241f;
    --panel-ink: #efe9dc;
    --ink: #26241f;
    --ink-2: #57534a;
    --ink-3: #857f70;
    --accent: #d96c3f;
    --ok: #3e9b5f;
    --line: #c9c2b0;
    --mono: "Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, "Courier New", monospace;
  }
  * { box-sizing: border-box; }
  body { background: var(--paper); color: var(--ink); font-family: var(--mono); font-size: 14px; line-height: 1.55; margin: 0; padding: 28px 20px 64px; }
  .wrap { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 26px; }
  header.masthead { background: var(--panel); color: var(--panel-ink); border-radius: 10px; padding: 18px 22px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; }
  .masthead h1 { font-size: 18px; margin: 0; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 700; }
  .masthead .stamp { color: #b8b09c; font-size: 12px; }
  .masthead .how { flex-basis: 100%; color: #b8b09c; font-size: 12px; border-top: 1px dashed #57534a; margin-top: 6px; padding-top: 8px; }
  .masthead .how b { color: var(--panel-ink); font-weight: 700; }
  section { display: flex; flex-direction: column; gap: 10px; }
  h2 { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; margin: 0; color: var(--ink-2); display: flex; align-items: baseline; gap: 10px; }
  h2 .count { color: var(--ink-3); letter-spacing: normal; }
  h2::after { content: ""; flex: 1; border-bottom: 1px solid var(--line); transform: translateY(-4px); }
  .item { background: var(--card); border: 1.5px solid var(--ink); border-radius: 9px; padding: 12px 16px; display: grid; grid-template-columns: 26px 1fr; gap: 4px 10px; }
  .item .glyph { font-weight: 700; text-align: center; }
  .item .title { font-weight: 700; }
  .item .desc { grid-column: 2; color: var(--ink-2); font-size: 13px; }
  .item .refs { grid-column: 2; color: var(--ink-3); font-size: 11.5px; letter-spacing: 0.03em; }
  .item .refs code { background: var(--paper); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  .now { border-color: var(--accent); border-width: 2px; }
  .now .glyph { color: var(--accent); }
  .now .badge { justify-self: start; grid-column: 2; background: var(--accent); color: var(--paper); font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; border-radius: 4px; padding: 1px 8px; margin-bottom: 2px; }
  .queue .glyph { color: var(--ink-2); }
  .maybe { border-style: dashed; border-width: 1.5px; border-color: var(--ink-2); background: transparent; }
  .maybe .glyph, .maybe .title { color: var(--ink-2); font-weight: 400; }
  .debt { border-style: dashed; border-color: var(--line); background: transparent; padding: 8px 16px; }
  .debt .glyph { color: var(--ink-3); }
  .debt .title { font-weight: 400; color: var(--ink-2); font-size: 13px; }
  details.done-wrap { border-top: 1px solid var(--line); padding-top: 12px; }
  details.done-wrap summary { cursor: pointer; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-2); list-style: none; display: flex; gap: 10px; align-items: baseline; }
  details.done-wrap summary::before { content: "▸"; }
  details.done-wrap[open] summary::before { content: "▾"; }
  details.done-wrap summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .done-list { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .done { display: grid; grid-template-columns: 26px 1fr; gap: 2px 10px; padding: 7px 12px; border-left: 3px solid var(--ok); background: var(--card); border-radius: 0 7px 7px 0; }
  .done .glyph { color: var(--ok); font-weight: 700; text-align: center; }
  .done .title { font-size: 13px; }
  .done .refs { grid-column: 2; color: var(--ink-3); font-size: 11.5px; }
  .done .refs code { background: var(--paper); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  .done-day { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-3); margin: 10px 0 2px; }
</style>

<div class="wrap">
  <header class="masthead">
    <h1>✦ Backlog Synkora</h1>
    <span class="stamp">atualizado ${dd}/${mm} · pelo orquestrador</span>
    <p class="how"><b>Como funciona:</b> este é o mapa vivo da obra — eu re-publico neste MESMO link a cada
    entrega. Quer mudar prioridade ou adicionar item? Comente aqui na página ou me diga no chat.
    Fonte da verdade: <b>docs/backlog-synkora.json</b> (MCP + CLI em scripts/backlog*.mjs).</p>
  </header>

  <section>
    <h2>Agora <span class="count">— em curso</span></h2>
${doc.lanes.agora.map((item) => itemHtml(item, 'now', '●')).join('\n')}
  </section>

  <section>
    <h2>Fila <span class="count">— ordem do dono</span></h2>
${fila}
  </section>

  <section>
    <h2>Candidatas <span class="count">— nomeadas, sem urgência</span></h2>
${doc.lanes.candidatas.map((item) => itemHtml(item, 'maybe', '◇')).join('\n')}
  </section>

  <section>
    <h2>Dívidas de higiene <span class="count">— pagar quando doer</span></h2>
${doc.lanes.dividas.map((item) => itemHtml(item, 'debt', '⊟')).join('\n')}
  </section>

  <details class="done-wrap" open>
    <summary>Feito recente <span class="count">— com commits</span></summary>
    <div class="done-list">
${doneHtml(doc.lanes.feito)}
    </div>
  </details>
</div>
`
  writeFileSync(path, html, 'utf8')
  return path
}

// ————— CLI —————
const entry = process.argv[1]
if (entry && fileURLToPath(import.meta.url) === entry) {
  const [verb, ...args] = process.argv.slice(2)
  const doc = loadBacklog()
  try {
    if (verb === 'list' || !verb) {
      console.log(listBacklog(doc))
    } else if (verb === 'add') {
      const [lane, title, desc, refs] = args
      const item = addItem(doc, lane, {
        title,
        desc,
        refs: refs ? refs.split(',').map((r) => r.trim()).filter(Boolean) : undefined
      })
      saveBacklog(doc)
      console.log(`adicionado em ${lane}: ${item.id}`)
    } else if (verb === 'move') {
      const [id, lane, pos] = args
      moveItem(doc, id, lane, pos ? Number(pos) : undefined)
      saveBacklog(doc)
      console.log(`movido: ${id} → ${lane}`)
    } else if (verb === 'update') {
      const [id, ...pairs] = args
      const patch = {}
      for (const pair of pairs) {
        const eq = pair.indexOf('=')
        if (eq > 0) patch[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
      updateItem(doc, id, patch)
      saveBacklog(doc)
      console.log(`atualizado: ${id}`)
    } else if (verb === 'remove') {
      const removed = removeItem(doc, args[0])
      saveBacklog(doc)
      console.log(`removido: ${removed.id}`)
    } else if (verb === 'render') {
      console.log(`renderizado: ${renderBacklog(doc)}`)
    } else {
      console.error(`verbo desconhecido: ${verb} (list/add/move/update/remove/render)`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

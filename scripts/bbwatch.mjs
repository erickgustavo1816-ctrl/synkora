#!/usr/bin/env node
// bbwatch.mjs — monitor humano da caixa-preta do Synkora (roda FORA do app).
// Traduz o journal JSONL em linhas legíveis: hora [cat/event] papel·card ⇒ resumo.
// Uso:
//   node bbwatch.mjs                # últimos 40 eventos de hoje
//   node bbwatch.mjs --since 30     # últimos 30 minutos
//   node bbwatch.mjs --follow       # segue ao vivo (poll 2s), Ctrl+C para sair
//   node bbwatch.mjs --grep merge   # filtra por texto (cat/event/reason/ids)
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync
} from 'node:fs'
import { join } from 'node:path'

const dir = join(process.env.APPDATA, 'synkora', 'blackbox')
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined
}
const follow = Boolean(opt('follow'))
const sinceMin = Number(opt('since')) || 0
const grep = typeof opt('grep') === 'string' ? String(opt('grep')).toLowerCase() : ''

const todayFile = () => {
  // O journal é nomeado pela DATA UTC — adivinhar pela data LOCAL deixava o
  // monitor mudo da virada UTC até a meia-noite local (caso real 2026-08-06,
  // BRT: 21h-00h sem eventos). O arquivo mais novo POR NOME é a verdade.
  try {
    const names = readdirSync(dir)
      .filter((n) => /^journal-\d{8}\.jsonl$/.test(n))
      .sort()
    if (names.length > 0) return join(dir, names[names.length - 1])
  } catch {
    // sem diretório legível: cai no chute por data local abaixo
  }
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return join(dir, `journal-${ymd}.jsonl`)
}

const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : '')
const fmt = (line) => {
  let j
  try {
    j = JSON.parse(line)
  } catch {
    return null
  }
  const t = (j.ts ?? '').slice(11, 19)
  const who = [j.actor, j.ids?.role && j.ids.role !== j.actor ? j.ids.role : '']
    .filter(Boolean)
    .join('/')
  const card = j.ids?.taskId ? ` card:${short(j.ids.taskId)}` : ''
  const mid = j.ids?.missionId ? ` miss:${short(j.ids.missionId)}` : ''
  const pane = j.ids?.paneId ? ` pane:${String(j.ids.paneId).slice(0, 24)}` : ''
  let body = j.reason ?? j.err ?? ''
  if (!body && j.detail) {
    const d = j.detail
    if (d.args) body = `args:${JSON.stringify(d.args).slice(0, 120)}`
    if (d.result) body += ` ⇒ ${String(d.result).slice(0, 120)}`
    if (!body) body = JSON.stringify(d).slice(0, 140)
  }
  if (j.prev || j.next) body = `${j.prev ?? ''} → ${j.next ?? ''} ${body}`.trim()
  const out = `${t} [${j.cat}/${j.event}] ${who}${mid}${card}${pane}${body ? ' · ' + body.replace(/\s+/g, ' ').slice(0, 220) : ''}`
  if (grep && !out.toLowerCase().includes(grep)) return null
  if (sinceMin && j.ts && Date.now() - Date.parse(j.ts) > sinceMin * 60_000) return null
  return out
}

const printTail = (file, maxLines) => {
  if (!existsSync(file)) return 0
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const slice = sinceMin || grep ? lines : lines.slice(-maxLines)
  for (const l of slice) {
    const s = fmt(l)
    if (s) console.log(s)
  }
  return statSync(file).size
}

let file = todayFile()
let offset = printTail(file, 40)
if (!follow) process.exit(0)

console.log(`— seguindo ${file} (Ctrl+C para sair) —`)
let carry = ''
setInterval(() => {
  const f = todayFile()
  if (f !== file) {
    file = f
    offset = 0
    carry = ''
  }
  if (!existsSync(file)) return
  const size = statSync(file).size
  if (size <= offset) return
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)
  offset = size
  const chunk = carry + buf.toString('utf-8')
  const lines = chunk.split('\n')
  carry = lines.pop() ?? ''
  for (const l of lines) {
    if (!l.trim()) continue
    const s = fmt(l)
    if (s) console.log(s)
  }
}, 2000)

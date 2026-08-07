#!/usr/bin/env node
// Análise da sonda 2026-08-04 (bytes crus de TUI codex real capturados por
// probe-codex-resume-mcp.mjs): reproduz o pipeline cleanPtyChunk sobre cada
// chunk e caça as classes de "letras comidas" dos tails — em especial a
// cadeia de sufixos do shimmer ("Working"→"orking"→"rking").

import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { cleanPtyChunk } = await import(
  new URL('../.tmp/pty-transcript-test/pty.js', import.meta.url)
)

const esc = (s) =>
  s
    .replace(/\x1b/g, '\\e')
    .replace(/\x07/g, '\\a')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')

function loadChunks(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const { t, b64 } = JSON.parse(line)
      return { t, raw: Buffer.from(b64, 'base64').toString('utf8') }
    })
}

for (const name of ['fresh', 'resume']) {
  const chunks = loadChunks(join(ROOT, '.tmp', `probe-codex-chunks-${name}.jsonl`))
  console.log(`\n===== sessão ${name}: ${chunks.length} chunks =====`)
  const lines = []
  for (let i = 0; i < chunks.length; i++) {
    const cleaned = cleanPtyChunk(chunks[i].raw)
    for (const line of cleaned.split('\n')) {
      const t = line.trim()
      if (t) lines.push({ chunk: i, text: t })
    }
  }
  console.log(`linhas limpas: ${lines.length}`)

  // classe A: linha nova é SUFIXO estrito da anterior (shimmer comendo letras)
  let suffixChains = 0
  const samples = []
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].text.replace(/^[•·*✻✽◦›❯\s]+/, '')
    const cur = lines[i].text.replace(/^[•·*✻✽◦›❯\s]+/, '')
    if (cur.length >= 2 && cur.length < prev.length && prev.endsWith(cur)) {
      suffixChains++
      if (samples.length < 12)
        samples.push({ i, prev: lines[i - 1].text, cur: lines[i].text, chunk: lines[i].chunk })
    }
  }
  console.log(`classe A (sufixo estrito da linha anterior): ${suffixChains}`)
  for (const s of samples) console.log(`  [${s.i}] "${s.prev}" -> "${s.cur}"`)

  // bytes crus dos chunks que geraram as amostras (as 3 primeiras)
  for (const s of samples.slice(0, 3)) {
    console.log(`  chunk ${s.chunk} RAW: ${esc(chunks[s.chunk].raw.slice(0, 320))}`)
  }

  // classe B: linhas consecutivas quase-idênticas (dist. de 1-2 chars no meio)
  let nearDup = 0
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1].text
    const b = lines[i].text
    if (a !== b && Math.abs(a.length - b.length) <= 2 && (a.includes(b) || b.includes(a)))
      nearDup++
  }
  console.log(`classe B (contido no vizinho, delta <=2): ${nearDup}`)

  // amostra do transcript final (últimas 25 linhas) para inspeção visual
  console.log('--- tail do transcript simulado ---')
  for (const line of lines.slice(-25)) console.log(`  | ${line.text}`)
}

#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Node 24+ is required for TypeScript type stripping')
}

const { Blackbox, describeEntry, sanitizeDetail } = await import(
  new URL('../.tmp/blackbox-test/blackbox.js', import.meta.url)
)

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
}

const dir = mkdtempSync(join(tmpdir(), 'synkora-blackbox-'))
try {
  // relógio injetável e determinístico
  let nowMs = Date.parse('2026-08-02T12:00:00.000Z')
  const now = () => new Date(nowMs)

  const box = new Blackbox({ dir, now, maxFileBytes: 2_000, retentionDays: 14 })

  // 1) record básico: ts/seq/boot + arquivo do dia
  const first = box.record({
    cat: 'task',
    event: 'state-change',
    ids: { projectId: 'p1', taskId: 't1', missionId: 'm1', phase: 'review' },
    prev: 'execucao/review/running',
    next: 'execucao/review/interrupted',
    actor: 'boot',
    reason: 'reinício do app'
  })
  ok(first && first.seq === 1 && first.ts === '2026-08-02T12:00:00.000Z', 'primeiro record com seq 1')
  const journal = box.journalFile()
  ok(journal.endsWith('journal-20260802.jsonl'), 'journal nomeado pelo dia')
  const lines = readFileSync(journal, 'utf8').trim().split('\n')
  ok(lines.length === 1, 'uma linha no journal')
  const parsed = JSON.parse(lines[0])
  ok(parsed.boot.length === 8 && parsed.cat === 'task', 'linha JSONL íntegra')

  // 2) sanitização: segredos nunca entram; strings longas truncam
  const secret = box.record({
    cat: 'mcp',
    event: 'tool-report',
    detail: {
      bearer_token: 'super-secreto-123',
      apiKey: 'x'.repeat(50),
      nested: { authorization: 'Bearer abc', texto: 'y'.repeat(700) },
      lista: Array.from({ length: 30 }, (_, i) => i)
    }
  })
  ok(secret.detail.bearer_token === '[redigido:campo]', 'chave token redigida')
  ok(secret.detail.apiKey === '[redigido:campo]', 'apiKey redigida')
  ok(secret.detail.nested.authorization === '[redigido:campo]', 'authorization aninhada redigida')
  ok(String(secret.detail.nested.texto).includes('…[+'), 'string longa truncada')
  ok(secret.detail.lista.length === 21 && String(secret.detail.lista.at(-1)).startsWith('…+'), 'array capado')
  const raw = readFileSync(journal, 'utf8')
  ok(!raw.includes('super-secreto-123'), 'segredo ausente do arquivo')

  // Valores sensíveis também podem chegar sob chaves genéricas ou nos campos
  // livres do evento; o redator central não depende apenas do nome da chave.
  const inlineToken = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
  const freeText = box.record({
    cat: 'pane',
    event: 'spawn-failed',
    actor: `cli com ${inlineToken}`,
    reason: `comando devolveu Authorization: Bearer abcdefghijklmnop`,
    evidence: `saída ${inlineToken}`,
    err: 'proxy https://user:pass@example.test indisponível',
    detail: { output: `token impresso: ${inlineToken}` }
  })
  const rawAfterFreeText = readFileSync(journal, 'utf8')
  ok(!rawAfterFreeText.includes(inlineToken), 'token inline ausente do journal')
  ok(!rawAfterFreeText.includes('abcdefghijklmnop'), 'bearer ausente do journal')
  ok(!rawAfterFreeText.includes('user:pass'), 'credencial de URL ausente do journal')
  const readableAfterFreeText = readFileSync(box.readableFile(), 'utf8')
  ok(!readableAfterFreeText.includes(inlineToken), 'token inline ausente do journal legível')
  ok(!readableAfterFreeText.includes('user:pass'), 'URL credenciada ausente do journal legível')
  ok(String(freeText.reason).includes('[redigido:autorizacao]'), 'reason mantém marcador útil')

  // 3) linha legível
  const line = describeEntry(first)
  ok(
    line.includes('12:00:00') &&
      line.includes('[task/state-change]') &&
      line.includes('card t1') &&
      line.includes('→ execucao/review/interrupted'),
    'describeEntry legível com ids e transição'
  )
  ok(readFileSync(box.readableFile(), 'utf8').split('\n').length >= 2, 'journal.md alimentado')

  // 4) rotação por tamanho: acima do teto, o arquivo atual é renomeado
  for (let i = 0; i < 30; i++) {
    box.record({ cat: 'msg', event: 'hub-info', detail: { text: 'z'.repeat(120) } })
  }
  const journals = readdirSync(dir).filter((n) => n.startsWith('journal-') && n.endsWith('.jsonl'))
  ok(journals.length >= 2, `rotação criou arquivo extra (${journals.join(', ')})`)

  // 5) tail devolve as últimas entradas em ordem, ignorando linha corrompida
  writeFileSync(journal, readFileSync(journal, 'utf8') + '{corrompida\n', 'utf8')
  const tail = box.tail(5)
  ok(tail.length === 5, 'tail limita')
  ok(tail.every((e) => typeof e.seq === 'number'), 'tail só entradas válidas')

  // 6) virada de dia muda o arquivo
  nowMs = Date.parse('2026-08-03T09:00:00.000Z')
  box.record({ cat: 'app', event: 'boot' })
  ok(
    readdirSync(dir).some((n) => n === 'journal-20260803.jsonl'),
    'novo dia = novo journal'
  )

  // 7) retenção: arquivo velho é varrido no boot seguinte
  const oldFile = join(dir, 'journal-20250101.jsonl')
  writeFileSync(oldFile, '{"seq":0}\n', 'utf8')
  const past = Date.parse('2025-01-01T00:00:00.000Z') / 1000
  const { utimesSync } = await import('node:fs')
  utimesSync(oldFile, past, past)
  new Blackbox({ dir, now, retentionDays: 14 })
  ok(!readdirSync(dir).includes('journal-20250101.jsonl'), 'journal antigo removido na retenção')

  // 8) sanitizeDetail exportado é puro
  ok(sanitizeDetail(undefined) === undefined, 'sanitizeDetail(undefined)')

  console.log(`test-blackbox: ${passed} assertions ok`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

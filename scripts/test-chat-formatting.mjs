import assert from 'node:assert/strict'
import test from 'node:test'
import { formatUsageLimitText } from '../src/renderer/src/chatFormatting.ts'

const NOW = Date.parse('2026-08-14T12:00:00.000Z')

function epoch(iso) {
  return String(Math.floor(Date.parse(iso) / 1000))
}

test('limite do Claude vira aviso PT-BR para hoje em São Paulo', () => {
  const raw = `Claude AI usage limit reached|${epoch('2026-08-14T18:00:00.000Z')}`
  assert.equal(
    formatUsageLimitText(raw, NOW),
    'seu limite volta às 15:00 de hoje (horário de São Paulo)'
  )
})

test('limite do Claude identifica amanhã e datas fora do intervalo', () => {
  const tomorrow = `Claude AI usage limit reached|${epoch('2026-08-15T03:30:00.000Z')}`
  const later = `Claude AI usage limit reached|${epoch('2026-08-20T03:30:00.000Z')}`
  assert.match(formatUsageLimitText(tomorrow, NOW), /às 00:30 de amanhã/u)
  assert.match(formatUsageLimitText(later, NOW), /às 00:30 em 20\/08\/2026/u)
})

test('payload malformado permanece intacto e não lança', () => {
  const malformed = 'Claude AI usage limit reached|nao-e-epoch'
  const mixed = `${malformed}\nlinha complementar`
  assert.doesNotThrow(() => formatUsageLimitText(malformed, NOW))
  assert.equal(formatUsageLimitText(malformed, NOW), malformed)
  assert.equal(formatUsageLimitText(mixed, NOW), mixed)
  assert.equal(formatUsageLimitText('erro genérico', NOW), 'erro genérico')
})

test('uma linha válida é convertida sem perder texto vizinho', () => {
  const raw = `prefixo\nClaude AI usage limit reached|${epoch('2026-08-14T18:00:00.000Z')}\nsufixo`
  assert.equal(
    formatUsageLimitText(raw, NOW),
    'prefixo\nseu limite volta às 15:00 de hoje (horário de São Paulo)\nsufixo'
  )
})

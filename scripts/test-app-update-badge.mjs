// O SELO DE VERSÃO DO RAIL — a apresentação pura (missão "Atualização do
// Synkora", 2026-09-21). Cada fase do main vira número + gesto + dica + ação;
// a forma muda antes da cor; a receita do clique está sempre na dica.
//
// Rode: node --experimental-strip-types --test scripts/test-app-update-badge.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { appUpdateBadgeView, appUpdateRelativeTime } from '../src/renderer/src/appUpdatePresentation.ts'

const NOW = 1_700_000_000_000

test('sem estado ainda: número reticente, sem ação', () => {
  const view = appUpdateBadgeView(null, NOW)
  assert.equal(view.label, '…')
  assert.equal(view.action, 'none')
  assert.equal(view.tone, 'quiet')
})

test('em dia: número quieto, dica com quando verificou e a receita de verificar de novo', () => {
  const view = appUpdateBadgeView({ phase: 'current', version: '0.1.0', checkedAt: NOW - 12 * 60_000 }, NOW)
  assert.equal(view.label, '0.1.0')
  assert.equal(view.glyph, '')
  assert.equal(view.tone, 'quiet')
  assert.equal(view.percent, null)
  assert.equal(view.action, 'check')
  assert.match(view.tip, /em dia \(verificado há 12 min\)/u)
  assert.match(view.tip, /clique para verificar de novo/u)
})

test('dev/não empacotado: o motivo vai na dica e o clique não faz nada', () => {
  const view = appUpdateBadgeView({ phase: 'unsupported', version: '0.1.0', reason: 'só no instalado' }, NOW)
  assert.equal(view.action, 'none')
  assert.match(view.tip, /só no instalado/u)
})

test('disponível → baixando → pronto: o número passa a ser o que vem; o gesto muda de forma', () => {
  const available = appUpdateBadgeView({ phase: 'available', version: '0.1.0', next: '0.2.0' }, NOW)
  assert.equal(available.label, '0.2.0')
  assert.equal(available.glyph, '↓')
  assert.equal(available.tone, 'busy')
  assert.equal(available.action, 'download')

  const downloading = appUpdateBadgeView(
    { phase: 'downloading', version: '0.1.0', next: '0.2.0', percent: 42.4, transferred: 40 * 1_048_576, total: 95 * 1_048_576 },
    NOW
  )
  assert.equal(downloading.percent, 42)
  assert.equal(downloading.action, 'none')
  assert.match(downloading.tip, /42% · 40\.0 MB de 95\.0 MB/u)
  assert.match(downloading.tip, /instala sozinho quando você reiniciar/u)

  const ready = appUpdateBadgeView({ phase: 'ready', version: '0.1.0', next: '0.2.0' }, NOW)
  assert.equal(ready.tone, 'ready')
  assert.equal(ready.glyph, '↻')
  assert.equal(ready.percent, 100)
  assert.equal(ready.action, 'install')
  assert.match(ready.tip, /reiniciar e atualizar/u)
  assert.match(ready.ariaLabel, /reiniciar e atualizar/u)
})

test('falha: aviso em âmbar com a mensagem do main e a receita de tentar de novo', () => {
  const view = appUpdateBadgeView(
    { phase: 'error', version: '0.1.0', error: 'sem conexão para verificar atualizações', checkedAt: NOW - 3_600_000 * 2 },
    NOW
  )
  assert.equal(view.tone, 'warn')
  assert.equal(view.glyph, '!')
  assert.equal(view.action, 'check')
  assert.match(view.tip, /sem conexão para verificar atualizações \(há 2 h\)/u)
  assert.match(view.tip, /tentar de novo/u)
})

test('verificando: glifo de espera, sem ação até terminar', () => {
  const view = appUpdateBadgeView({ phase: 'checking', version: '0.1.0' }, NOW)
  assert.equal(view.glyph, '◌')
  assert.equal(view.action, 'none')
})

test('tempo relativo: agora há pouco · minutos · horas · dias', () => {
  assert.equal(appUpdateRelativeTime(undefined, NOW), '')
  assert.equal(appUpdateRelativeTime(NOW - 20_000, NOW), 'agora há pouco')
  assert.equal(appUpdateRelativeTime(NOW - 5 * 60_000, NOW), 'há 5 min')
  assert.equal(appUpdateRelativeTime(NOW - 3 * 3_600_000, NOW), 'há 3 h')
  assert.equal(appUpdateRelativeTime(NOW - 2 * 86_400_000, NOW), 'há 2 d')
})

test('cerca de forma: o selo mora no pé do rail e o reinício passa por confirmação', () => {
  const rail = readFileSync(new URL('../src/renderer/src/components/ProjectRail.tsx', import.meta.url), 'utf8')
  assert.match(rail, /<AppUpdateBadge \/>/u)
  const badge = readFileSync(new URL('../src/renderer/src/components/AppUpdateBadge.tsx', import.meta.url), 'utf8')
  assert.match(badge, /window\.synkora\.appUpdate\.onStatus/u)
  assert.match(badge, /setConfirming\(true\)/u, 'instalar pede confirmação (reiniciar derruba as conversas)')
  assert.match(badge, /createPortal\(/u, 'a folha é overlay via portal, nunca window.confirm')
  assert.doesNotMatch(badge, /window\.confirm|alert\(/u)
  const css = readFileSync(new URL('../src/renderer/src/components/ProjectRail.css', import.meta.url), 'utf8')
  assert.match(css, /\.rail-version \{\s*margin-top: auto;/u, 'o selo fica no pé do rail')
  assert.match(css, /\.rail-version-badge\.tone-ready \{[\s\S]*?animation: rail-version-ready/u)
})

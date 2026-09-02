import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cliVersionDrift } from '../src/main/cliVersionDrift.ts'

// O VIGIA DE VERSÃO PÓS-BOOT (2026-09-01). Caso real do dono: o Fable 5.1
// saiu, o `claude` foi atualizado por fora do app (15:29) e o Synkora — de pé
// desde a véspera — seguiu servindo o catálogo do binário velho: o modelo novo
// não aparecia em lugar nenhum. A versão só era lida no boot, e o catálogo de
// modelos (cache eterno por processo) só cai quando a versão MUDA — que nunca
// era observado. Duas metades: a régua pura (aqui, provada) e a costura no
// boot (contratos de fonte abaixo).

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('versão diferente da carregada vira `updated` com o de-onde-veio no detail', () => {
  const drift = cliVersionDrift({ version: '2.1.240', state: 'current' }, '2.1.257')
  assert.deepEqual(drift, {
    version: '2.1.257',
    from: '2.1.240',
    state: 'updated',
    detail: 'versão mudou fora do app: 2.1.240 → 2.1.257'
  })
  // O estado `updated` é o MESMO de uma rodada do app de propósito: para o
  // resto do app o fato é um só — o binário mudou, todo catálogo lido antes
  // está velho — e é ele que acende "CLIs atualizados" no titlebar.
  assert.equal(cliVersionDrift({ version: '2.1.257', state: 'updated' }, '2.1.260')?.state, 'updated')
})

test('versão igual, rodada em curso e nunca-lida NÃO falam — o updater é o dono', () => {
  assert.equal(cliVersionDrift({ version: '2.1.257', state: 'current' }, '2.1.257'), null)
  assert.equal(cliVersionDrift({ version: '2.1.257', state: 'updated' }, '2.1.257'), null)
  assert.equal(cliVersionDrift({ version: '2.1.240', state: 'updating' }, '2.1.257'), null)
  assert.equal(cliVersionDrift({ version: null, state: 'unknown' }, '2.1.257'), null)
})

test('binário que some do PATH vira `missing` uma vez; que volta vira `updated`', () => {
  assert.deepEqual(cliVersionDrift({ version: '2.1.257', state: 'current' }, null), {
    version: null,
    from: '2.1.257',
    state: 'missing',
    detail: 'o CLI sumiu do PATH (era 2.1.257)'
  })
  // já ausente e continua ausente: silêncio, não um `missing` por tique
  assert.equal(cliVersionDrift({ version: null, state: 'missing' }, null), null)
  assert.deepEqual(cliVersionDrift({ version: null, state: 'missing' }, '2.1.257'), {
    version: '2.1.257',
    state: 'updated',
    detail: 'CLI voltou ao PATH na versão 2.1.257'
  })
})

test('a costura: o vigia nasce no boot, é cutucado a cada pane e a mudança vai ao diário', () => {
  const update = source('src/main/cliUpdate.ts')
  assert.match(update, /export function startCliVersionWatch/u, 'o vigia sumiu do updater')
  assert.match(update, /cliVersionDrift\(current, await read\(cli\)\)/u, 'a régua pura é quem decide')
  assert.match(update, /if \(running\) return/u, 'rodada de update em curso é dona da verdade')
  assert.match(update, /timer\.unref\(\)/u, 'o relógio não pode segurar o processo no quit')

  const index = source('src/main/index.ts')
  assert.match(index, /startCliVersionWatch\(\{ intervalMs: 5 \* 60_000 \}\)/u, 'o vigia não nasce no boot')
  assert.match(
    index,
    /void cliVersionWatch\.check\(\)\s*\n\s*return waitForGuiCliStable\(/u,
    'cada pane que nasce cutuca o vigia, sem esperar por ele'
  )
  assert.match(index, /event: 'cli-version-changed'/u, 'a mudança de versão tem de constar no diário')

  // O leaf continua leaf: import NENHUM (nem electron, nem processo) — é o
  // que deixa esta suíte importá-lo em node cru.
  const drift = source('src/main/cliVersionDrift.ts')
  assert.doesNotMatch(drift, /^import /mu, 'o módulo puro ganhou um import — a suíte deixa de rodar em node cru')
})

test('o composer pede o catálogo de novo quando o app o esquece', () => {
  const pane = source('src/renderer/src/components/GuiPane.tsx')
  // `clearCatalogs` (renderer) apaga a entrada; é o sumiço dela que re-dispara
  // o `loadCatalog` — sem isso o fallback do "abrindo" ficava vazio até
  // remontar o pane.
  assert.match(pane, /if \(readOnly \|\| gui\.caps \|\| catalogEntry\) return/u)
  assert.match(pane, /\[catalogEntry, cli, gui\.caps, loadCatalog, readOnly, seatId\]/u)
})

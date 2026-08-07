// test-stall-attribution.mjs — suíte da Fase 0 (atribuição de stall).
// Roda em node cru: node --experimental-strip-types --test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StallAttribution, instrumentIpcMain } from '../src/main/stallAttribution.ts'

const makeClock = () => {
  const clock = { t: 100_000 }
  clock.now = () => clock.t
  return clock
}

test('fechada curta fica fora do ring; longa é culpada na janela', () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  const endShort = s.begin('curtinha')
  clock.t += 50
  endShort()
  const endLong = s.begin('paneSpec', 'projeto-x')
  clock.t += 1500
  endLong()
  clock.t += 100
  const blamed = s.blame(1400, 1000)
  assert.equal(blamed.length, 1)
  assert.equal(blamed[0].kind, 'paneSpec')
  assert.equal(blamed[0].detail, 'projeto-x')
  assert.equal(blamed[0].open, false)
  assert.equal(blamed[0].durationMs, 1500)
})

test('operação ainda aberta é culpada com open=true e overlap correto', () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  s.begin('merge', 'missao-y')
  clock.t += 2500
  const blamed = s.blame(1500, 1000)
  assert.equal(blamed.length, 1)
  assert.equal(blamed[0].open, true)
  assert.equal(blamed[0].overlapMs, 2500)
  assert.equal(s.openCount(), 1)
})

test('fechada ANTES da janela do stall não é culpada', () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  const end = s.begin('antiga')
  clock.t += 1000
  end()
  clock.t += 10_000
  assert.deepEqual(s.blame(1000, 1000), [])
})

test('ordenação por overlap e teto de 8 culpadas', () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  for (let i = 1; i <= 10; i++) {
    const end = s.begin(`op-${i}`)
    clock.t += 130 + i * 10
    end()
  }
  const blamed = s.blame(5000, 1000)
  assert.equal(blamed.length, 8)
  for (let i = 1; i < blamed.length; i++) {
    assert.ok(blamed[i - 1].overlapMs >= blamed[i].overlapMs, 'ordem decrescente por overlap')
  }
})

test('fechador é idempotente — segundo end não duplica o ring', () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  const end = s.begin('uma-vez')
  clock.t += 500
  end()
  clock.t += 100
  end()
  const blamed = s.blame(600, 1000)
  assert.equal(blamed.filter((b) => b.kind === 'uma-vez').length, 1)
})

test('wrap: sync fecha na volta; exceção fecha e relança', () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  const out = s.wrap('sync-ok', undefined, () => {
    clock.t += 300
    return 42
  })
  assert.equal(out, 42)
  assert.equal(s.openCount(), 0)
  assert.throws(() =>
    s.wrap('sync-boom', undefined, () => {
      clock.t += 300
      throw new Error('boom')
    })
  )
  assert.equal(s.openCount(), 0)
})

test('wrap: promise fecha no settle (sucesso e rejeição)', async () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  const ok = s.wrap('async-ok', 'detalhe', async () => {
    clock.t += 400
    return 'pronto'
  })
  assert.equal(s.openCount(), 1)
  assert.equal(await ok, 'pronto')
  assert.equal(s.openCount(), 0)
  const bad = s.wrap('async-boom', undefined, async () => {
    clock.t += 400
    throw new Error('async boom')
  })
  await assert.rejects(bad)
  assert.equal(s.openCount(), 0)
})

test('instrumentIpcMain: handler registrado após o patch vira operação medida', async () => {
  const clock = makeClock()
  const s = new StallAttribution(clock.now)
  const handlers = new Map()
  const fakeIpc = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    on(channel, listener) {
      handlers.set(`on:${channel}`, listener)
    }
  }
  instrumentIpcMain(fakeIpc, s)
  fakeIpc.handle('tasks:run', async () => {
    clock.t += 1800
    return 'ok'
  })
  const pending = handlers.get('tasks:run')()
  assert.equal(s.openCount(), 1)
  assert.equal(await pending, 'ok')
  assert.equal(s.openCount(), 0)
  clock.t += 200
  const blamed = s.blame(1500, 1000)
  assert.equal(blamed.length, 1)
  assert.equal(blamed[0].kind, 'ipc:tasks:run')
  const summary = s.blameSummary(1500, 1000)
  assert.ok(summary[0].includes('ipc:tasks:run'))
})

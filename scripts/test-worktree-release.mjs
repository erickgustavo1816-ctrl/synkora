import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RELEASE_PAUSES,
  retryWorktreeRelease
} from '../src/main/worktreeRelease.ts'

// O INCIDENTE 2026-08-26 (missão f5c8fa04): o ⇪ matou os panes e disparou o
// `git worktree remove` na linha seguinte. No Windows o filho (codex app-server
// com cwd no worktree) ainda não tinha morrido, o rmdir final falhou e sobrou
// uma carcaça — merge gravado, missão bloqueada em reparo. Estes testes prendem
// a cura: insistir por uma janela curta, e SÓ isso.

/** Relógio de mentira: a espera é contada, nunca cumprida (teste não dorme). */
function fakeSleep() {
  const slept = []
  return {
    slept,
    sleep: async (ms) => {
      slept.push(ms)
    }
  }
}

test('a pasta presa que se solta no meio do velório é removida sem intervenção', async () => {
  const clock = fakeSleep()
  let tentativas = 0
  const outcome = await retryWorktreeRelease(
    async () => {
      tentativas += 1
      // as duas primeiras falham (filho ainda vivo), a terceira prova
      return tentativas >= 3
    },
    { sleep: clock.sleep }
  )

  assert.equal(outcome.released, true)
  assert.equal(outcome.attempts, 3)
  // esperou exatamente as duas primeiras pausas não-nulas da janela
  assert.deepEqual(clock.slept, [150, 350])
  assert.equal(outcome.waitedMs, 500)
})

test('sucesso de primeira não paga espera nenhuma', async () => {
  const clock = fakeSleep()
  const outcome = await retryWorktreeRelease(async () => true, { sleep: clock.sleep })

  assert.equal(outcome.released, true)
  assert.equal(outcome.attempts, 1)
  assert.equal(outcome.waitedMs, 0)
  assert.deepEqual(clock.slept, [], 'a primeira tentativa é imediata')
})

test('processo VIVO de verdade não é escondido: a janela acaba e o veredito é falso', async () => {
  const clock = fakeSleep()
  let tentativas = 0
  const outcome = await retryWorktreeRelease(
    async () => {
      tentativas += 1
      return false
    },
    { sleep: clock.sleep }
  )

  assert.equal(outcome.released, false, 'insistir para sempre esconderia um processo real')
  assert.equal(outcome.attempts, DEFAULT_RELEASE_PAUSES.length)
  assert.equal(tentativas, DEFAULT_RELEASE_PAUSES.length)
  assert.equal(outcome.waitedMs, 2400, 'a janela inteira é ~2,4s')
})

test('erro de git sobe na hora, sem consumir a janela', async () => {
  const clock = fakeSleep()
  let tentativas = 0
  await assert.rejects(
    () =>
      retryWorktreeRelease(
        async () => {
          tentativas += 1
          throw new Error('git explodiu')
        },
        { sleep: clock.sleep }
      ),
    /git explodiu/
  )
  assert.equal(tentativas, 1, 'problema de git não é problema de tempo')
  assert.deepEqual(clock.slept, [])
})

test('a janela é configurável e a primeira tentativa é sempre imediata', async () => {
  const clock = fakeSleep()
  let tentativas = 0
  const outcome = await retryWorktreeRelease(
    async () => {
      tentativas += 1
      return tentativas === 2
    },
    { pauses: [0, 50], sleep: clock.sleep }
  )

  assert.equal(outcome.released, true)
  assert.deepEqual(clock.slept, [50])
  assert.equal(DEFAULT_RELEASE_PAUSES[0], 0, 'a janela padrão também começa sem espera')
})

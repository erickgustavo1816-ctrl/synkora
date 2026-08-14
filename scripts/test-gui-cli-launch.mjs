import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { waitForGuiCliStable } from '../src/main/guiCliLaunch.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const initialState of ['unknown', 'updating']) {
  test(`${initialState} inicia ou compartilha a rodada e aguarda antes do spawn`, async () => {
    const update = deferred()
    let updateCalls = 0
    let released = false
    const waiting = waitForGuiCliStable('claude', {
      getStatus: () => [{ cli: 'claude', state: initialState }],
      isUpdating: () => initialState === 'updating',
      updateAll: () => {
        updateCalls += 1
        return update.promise
      }
    }).then(() => {
      released = true
    })

    await Promise.resolve()
    assert.equal(updateCalls, 1)
    assert.equal(released, false)

    update.resolve([])
    await waiting
    assert.equal(released, true)
  })
}

test('estado ausente é tratado como unknown e aguarda a checagem', async () => {
  let updateCalls = 0
  await waitForGuiCliStable('codex', {
    getStatus: () => [{ cli: 'claude', state: 'current' }],
    isUpdating: () => false,
    updateAll: async () => {
      updateCalls += 1
    }
  })
  assert.equal(updateCalls, 1)
})

test('estados estáveis não disparam uma nova rodada', async () => {
  for (const state of ['current', 'updated', 'missing', 'failed']) {
    let updateCalls = 0
    await waitForGuiCliStable('claude', {
      getStatus: () => [{ cli: 'claude', state }],
      isUpdating: () => false,
      updateAll: async () => {
        updateCalls += 1
      }
    })
    assert.equal(updateCalls, 0, state)
  }
})

test('rodada global viva fecha a janela antes de o estado do CLI virar updating', async () => {
  let updateCalls = 0
  await waitForGuiCliStable('claude', {
    getStatus: () => [{ cli: 'claude', state: 'current' }],
    isUpdating: () => true,
    updateAll: async () => {
      updateCalls += 1
    }
  })
  assert.equal(updateCalls, 1)
})

test('gui:create espera a barreira antes de registry.create', () => {
  const source = readFileSync(new URL('../src/main/ipc/gui.ts', import.meta.url), 'utf8')
  const handlerStart = source.indexOf("ipcMain.handle('gui:create'")
  const wait = source.indexOf('await extras.waitForCliStable(spawn.cli)', handlerStart)
  const create = source.indexOf('return registry.create(spawn)', handlerStart)

  assert.ok(handlerStart >= 0)
  assert.ok(wait > handlerStart)
  assert.ok(create > wait)
})

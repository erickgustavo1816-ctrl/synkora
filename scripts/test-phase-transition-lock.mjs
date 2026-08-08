import assert from 'node:assert/strict'
import test from 'node:test'
import { PhaseTransitionLock } from '../src/main/phaseTransitionLock.ts'

const meta = (label, projectId = 'p1') => ({ label, projectId })

test('acquire síncrono concede a posse e nega o segundo entrante', () => {
  const contentions = []
  const lock = new PhaseTransitionLock((info) => contentions.push(info))
  const owner = lock.acquire('card-1', meta('report:review'))

  assert.equal(typeof owner, 'symbol')
  assert.equal(lock.isLocked('card-1'), true)
  assert.equal(lock.holderLabel('card-1'), 'report:review')
  assert.equal(lock.owns('card-1', owner), true)
  assert.equal(lock.acquire('card-1', meta('poller:done')), undefined)
  assert.deepEqual(contentions, [
    {
      taskId: 'card-1',
      projectId: 'p1',
      holderLabel: 'report:review',
      waiterLabel: 'poller:done',
      refused: true
    }
  ])
})

test('somente o token dono libera; release é no-op para token errado', () => {
  const lock = new PhaseTransitionLock()
  const owner = lock.acquire('card-1', meta('report:dev'))
  const stranger = Symbol('stranger')

  assert.equal(lock.release('card-1', stranger), false)
  assert.equal(lock.isLocked('card-1'), true)
  assert.equal(lock.release('outro-card', owner), false)
  assert.equal(lock.release('card-1', owner), true)
  assert.equal(lock.isLocked('card-1'), false)
  assert.equal(lock.release('card-1', owner), false)
  assert.equal(typeof lock.acquire('card-1', meta('de-novo')), 'symbol')
})

test('tentativas concorrentes no mesmo tick concedem exatamente uma posse', async () => {
  const lock = new PhaseTransitionLock()
  const attempts = await Promise.all(
    Array.from({ length: 32 }, async () => {
      await Promise.resolve()
      return lock.acquire('card-corrida', meta('report:review'))
    })
  )
  const granted = attempts.filter((token) => token !== undefined)

  assert.equal(granted.length, 1)
  assert.equal(lock.owns('card-corrida', granted[0]), true)
})

test('cards distintos nunca se serializam entre si (o lock é por card)', () => {
  const lock = new PhaseTransitionLock()
  const a = lock.acquire('card-a', meta('report:review', 'p1'))
  const b = lock.acquire('card-b', meta('report:qa', 'p1'))
  const c = lock.acquire('card-c', meta('finalize', 'p2'))

  assert.equal([a, b, c].every((token) => typeof token === 'symbol'), true)
  assert.equal(lock.lockedCount('p1'), 2)
  assert.equal(lock.lockedCount('p2'), 1)
  assert.equal(lock.lockedCount('p3'), 0)
})

test('waitAndAcquire com card livre resolve já adquirido', async () => {
  const lock = new PhaseTransitionLock()
  const token = await lock.waitAndAcquire('card-1', meta('reseat'))

  assert.equal(typeof token, 'symbol')
  assert.equal(lock.owns('card-1', token), true)
  assert.equal(lock.holderLabel('card-1'), 'reseat')
})

test('fila FIFO: release transfere a posse na ordem e sem janela destravada', async () => {
  const contentions = []
  const lock = new PhaseTransitionLock((info) => contentions.push(info))
  const first = lock.acquire('card-1', meta('report:review'))
  const order = []
  const second = lock.waitAndAcquire('card-1', meta('reseat')).then((token) => {
    order.push('reseat')
    return token
  })
  const third = lock.waitAndAcquire('card-1', meta('respawn')).then((token) => {
    order.push('respawn')
    return token
  })

  assert.equal(lock.release('card-1', first), true)
  // transferência no mesmo tick: o card CONTINUA travado, agora do 2º da fila
  assert.equal(lock.isLocked('card-1'), true)
  const secondToken = await second
  assert.equal(lock.owns('card-1', secondToken), true)
  assert.equal(lock.holderLabel('card-1'), 'reseat')
  assert.equal(lock.owns('card-1', first), false)

  assert.equal(lock.release('card-1', secondToken), true)
  const thirdToken = await third
  assert.deepEqual(order, ['reseat', 'respawn'])
  assert.equal(lock.holderLabel('card-1'), 'respawn')

  assert.equal(lock.release('card-1', thirdToken), true)
  assert.equal(lock.isLocked('card-1'), false)
  assert.deepEqual(
    contentions.map((info) => ({ waiter: info.waiterLabel, refused: info.refused })),
    [
      { waiter: 'reseat', refused: false },
      { waiter: 'respawn', refused: false }
    ]
  )
})

test('padrão do call site: try/finally solta o lock mesmo com exceção no meio', async () => {
  const lock = new PhaseTransitionLock()
  const run = async () => {
    const token = lock.acquire('card-1', meta('report:review'))
    assert.equal(typeof token, 'symbol')
    try {
      await Promise.resolve()
      throw new Error('recordGate falhou')
    } finally {
      lock.release('card-1', token)
    }
  }

  await assert.rejects(run, /recordGate falhou/)
  assert.equal(lock.isLocked('card-1'), false)
  const waiter = await lock.waitAndAcquire('card-1', meta('proximo'))
  assert.equal(lock.owns('card-1', waiter), true)
})

test('callback de contenda que lança nunca derruba a transição', () => {
  const lock = new PhaseTransitionLock(() => {
    throw new Error('observador quebrado')
  })
  const owner = lock.acquire('card-1', meta('report:review'))

  assert.equal(lock.acquire('card-1', meta('poller:done')), undefined)
  assert.equal(lock.owns('card-1', owner), true)
  assert.equal(lock.release('card-1', owner), true)
})

test('taskId vazio nunca vira posse; snapshot retrata donos e fila', async () => {
  const lock = new PhaseTransitionLock()

  assert.equal(lock.acquire('   ', meta('report:review')), undefined)
  assert.equal(lock.isLocked(''), false)
  await assert.rejects(lock.waitAndAcquire('  ', meta('reseat')), /taskId vazio/)

  const owner = lock.acquire(' card-1 ', meta('report:review'))
  assert.equal(lock.isLocked('card-1'), true)
  void lock.waitAndAcquire('card-1', meta('reseat'))
  assert.deepEqual(lock.snapshot(), [
    { taskId: 'card-1', label: 'report:review', projectId: 'p1', waiters: 1 }
  ])
  assert.equal(lock.owns('card-1 ', owner), true)
})

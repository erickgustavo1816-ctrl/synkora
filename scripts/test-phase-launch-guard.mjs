import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PhaseLaunchCapacityGuard,
  PhaseLaunchGuard
} from '../src/main/phaseLaunchGuard.ts'

test('recusa uma segunda reserva síncrona para a mesma task', () => {
  const guard = new PhaseLaunchGuard()
  const owner = guard.reserve('task-1')

  assert.equal(typeof owner, 'symbol')
  assert.equal(guard.isReserved('task-1'), true)
  assert.equal(guard.reserve('task-1'), undefined)
  assert.equal(guard.owns('task-1', owner), true)
})

test('somente o token dono consegue liberar a reserva', () => {
  const guard = new PhaseLaunchGuard()
  const owner = guard.reserve('task-1')
  const stranger = Symbol('stranger')

  assert.equal(guard.release('task-1', stranger), false)
  assert.equal(guard.isReserved('task-1'), true)
  assert.equal(guard.release('outra-task', owner), false)
  assert.equal(guard.release('task-1', owner), true)
  assert.equal(guard.isReserved('task-1'), false)
  assert.equal(guard.release('task-1', owner), false)
  assert.equal(typeof guard.reserve('task-1'), 'symbol')
})

test('tentativas concorrentes concedem exatamente uma reserva', async () => {
  const guard = new PhaseLaunchGuard()
  const attempts = await Promise.all(
    Array.from({ length: 32 }, async () => {
      await Promise.resolve()
      return guard.reserve('task-concorrente')
    })
  )
  const granted = attempts.filter((token) => token !== undefined)

  assert.equal(granted.length, 1)
  assert.equal(guard.owns('task-concorrente', granted[0]), true)
})

test('normaliza taskId e recusa identificador vazio', () => {
  const guard = new PhaseLaunchGuard()
  const owner = guard.reserve('  task-1  ')

  assert.equal(guard.reserve('task-1'), undefined)
  assert.equal(guard.owns(' task-1', owner), true)
  assert.equal(guard.reserve('   '), undefined)
  assert.equal(guard.isReserved(''), false)
})

test('reserva capacidade por projeto sem corrida entre tasks diferentes', async () => {
  const guard = new PhaseLaunchCapacityGuard()
  const attempts = await Promise.all(
    Array.from({ length: 20 }, async () => {
      await Promise.resolve()
      return guard.reserve('project-1', 4, 6)
    })
  )
  const granted = attempts.filter((token) => token !== undefined)
  assert.equal(granted.length, 2)
  assert.equal(guard.pending('project-1'), 2)
  assert.equal(guard.reserve('project-2', 5, 6) !== undefined, true)
  assert.equal(guard.release('project-1', granted[0]), true)
  assert.equal(guard.pending('project-1'), 1)
})

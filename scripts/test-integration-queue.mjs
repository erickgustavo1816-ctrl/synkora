import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  IntegrationQueueError,
  IntegrationQueueStore
} from '../src/main/integrationQueue.ts'

const T0 = '2026-08-01T10:00:00.000Z'
const T1 = '2026-08-01T10:01:00.000Z'
const T2 = '2026-08-01T10:02:00.000Z'
const T3 = '2026-08-01T10:03:00.000Z'

function temporaryStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-integration-queue-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'integration-queue.json')
  return { file, store: new IntegrationQueueStore(file) }
}

function enqueue(store, projectId, missionId, requestedAt = T0) {
  return store.enqueue({
    projectId,
    missionId,
    requestedBy: 'orchestrator',
    targetKind: 'version',
    versionId: `${projectId}-v1`,
    requestedAt
  })
}

function hasCode(code) {
  return (error) => error instanceof IntegrationQueueError && error.code === code
}

test('manté FIFO por projeto e deriva as posições sem persistir posição', (t) => {
  const { file, store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1', T0)
  enqueue(store, 'p1', 'm2', T1)
  enqueue(store, 'p1', 'm3', T2)

  assert.deepEqual(
    store.listPending('p1').map(({ missionId, position, total, isHead }) => ({
      missionId,
      position,
      total,
      isHead
    })),
    [
      { missionId: 'm1', position: 1, total: 3, isHead: true },
      { missionId: 'm2', position: 2, total: 3, isHead: false },
      { missionId: 'm3', position: 3, total: 3, isHead: false }
    ]
  )
  assert.equal(readFileSync(file, 'utf8').includes('"position"'), false)

  assert.equal(store.beginNext('p1', T3)?.missionId, 'm1')
  assert.equal(store.complete('m1'), true)
  assert.deepEqual(
    store.listPending('p1').map((ticket) => [ticket.missionId, ticket.position]),
    [
      ['m2', 1],
      ['m3', 2]
    ]
  )
})

test('enqueue é idempotente e nunca cria dois tickets para a mesma missão', (t) => {
  const { store } = temporaryStore(t)
  const first = enqueue(store, 'p1', 'm1')
  const duplicate = store.enqueue({
    projectId: 'outro-projeto',
    missionId: 'm1',
    requestedBy: 'maestro',
    targetKind: 'base',
    requestedAt: T2
  })

  assert.equal(duplicate.id, first.id)
  assert.equal(duplicate.projectId, 'p1')
  assert.equal(store.listPending().length, 1)
})

test('fotografia validada persiste e a sincronização a renova sem perder a posição', (t) => {
  const { file, store } = temporaryStore(t)
  const initial = {
    planId: 'plan-before-sync',
    sourceHead: 'a'.repeat(40),
    validatedTargetHead: 'b'.repeat(40),
    targetBranch: 'version/v1',
    targetDir: 'C:\\repo\\worktrees\\version-v1'
  }
  const first = store.enqueue({
    projectId: 'p1',
    missionId: 'm1',
    requestedBy: 'orchestrator',
    targetKind: 'version',
    versionId: 'p1-v1',
    requestedAt: T0,
    ...initial
  })
  enqueue(store, 'p1', 'm2', T1)
  store.beginNext('p1', T1)
  store.requireSync('m1', {
    code: 'target_advanced',
    owner: 'orchestrator',
    detail: 'A branch da versão avançou.',
    at: T2
  })

  const reopened = new IntegrationQueueStore(file)
  assert.deepEqual(
    (({ planId, sourceHead, validatedTargetHead, targetBranch, targetDir }) => ({
      planId,
      sourceHead,
      validatedTargetHead,
      targetBranch,
      targetDir
    }))(reopened.getByMission('m1')),
    initial
  )
  assert.equal(reopened.getByMission('m1')?.id, first.id)
  assert.equal(reopened.getByMission('m1')?.position, 1)

  const refreshed = {
    planId: 'plan-after-sync',
    sourceHead: 'c'.repeat(40),
    validatedTargetHead: 'd'.repeat(40),
    targetBranch: 'version/v1-current',
    targetDir: 'C:\\repo\\worktrees\\version-v1-current'
  }
  const requeued = reopened.requeueAfterSync('m1', refreshed)
  assert.equal(requeued.id, first.id)
  assert.equal(requeued.sequence, first.sequence)
  assert.equal(requeued.state, 'queued')
  assert.equal(requeued.position, 1)
  assert.equal(requeued.total, 2)
  assert.deepEqual(
    (({ planId, sourceHead, validatedTargetHead, targetBranch, targetDir }) => ({
      planId,
      sourceHead,
      validatedTargetHead,
      targetBranch,
      targetDir
    }))(requeued),
    refreshed
  )

  const persistedAgain = new IntegrationQueueStore(file)
  assert.deepEqual(
    persistedAgain.listPending('p1').map((ticket) => [
      ticket.missionId,
      ticket.position,
      ticket.sourceHead,
      ticket.validatedTargetHead
    ]),
    [
      ['m1', 1, refreshed.sourceHead, refreshed.validatedTargetHead],
      ['m2', 2, undefined, undefined]
    ]
  )
  assert.equal(persistedAgain.getByMission('m1')?.planId, refreshed.planId)
  assert.equal(persistedAgain.getByMission('m1')?.targetBranch, refreshed.targetBranch)
  assert.equal(persistedAgain.getByMission('m1')?.targetDir, refreshed.targetDir)
})

test('cancelamento remove o ticket e avança as posições restantes', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1')
  enqueue(store, 'p1', 'm2', T1)

  assert.equal(store.cancel('m1'), true)
  assert.equal(store.cancel('m1'), false)
  assert.equal(store.head('p1')?.missionId, 'm2')
  assert.equal(store.head('p1')?.position, 1)
})

test('cancelar a cabeça bloqueada destrava e promove a próxima missão', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1')
  enqueue(store, 'p1', 'm2', T1)
  store.beginNext('p1', T1)
  store.block('m1', {
    code: 'merge_conflict',
    owner: 'maestro',
    detail: 'A cabeça precisa ser retirada da fila.',
    at: T2
  })

  assert.equal(store.head('p1')?.state, 'blocked')
  assert.equal(store.cancel('m1'), true)
  assert.deepEqual(
    store.listPending('p1').map(({ missionId, position, isHead }) => ({
      missionId,
      position,
      isHead
    })),
    [{ missionId: 'm2', position: 1, isHead: true }]
  )
  assert.equal(store.beginNext('p1', T3)?.missionId, 'm2')
})

test('conflito conserva a posição; Maestro orienta e sincronização refaz a tentativa', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1')
  enqueue(store, 'p1', 'm2', T1)
  store.beginNext('p1', T1)

  const blocked = store.block('m1', {
    code: 'merge_conflict',
    owner: 'maestro',
    detail: 'As duas missões alteraram src/app.ts.',
    files: ['src/app.ts'],
    at: T2
  })
  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.position, 1)
  assert.equal(store.beginNext('p1', T2), undefined)

  const guided = store.guideResolution('m1', {
    instruction: 'Preserve a validação nova e adapte a chamada antiga.',
    decidedAt: T3
  })
  assert.equal(guided.state, 'sync_required')
  assert.deepEqual(guided.resolution, {
    instruction: 'Preserve a validação nova e adapte a chamada antiga.',
    decidedAt: T3,
    decidedBy: 'maestro'
  })

  const requeued = store.requeueAfterSync('m1', {
    sourceHead: 'source-after-fix',
    validatedTargetHead: 'target-current'
  })
  assert.equal(requeued.state, 'queued')
  assert.equal(requeued.position, 1)
  assert.equal(requeued.resolution?.decidedBy, 'maestro')
  assert.equal(store.beginNext('p1', T3)?.attempts, 2)
})

test('merge já gravado aguarda reparo operacional e nunca aceita nova estratégia', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1')
  store.beginNext('p1', T1)

  const blocked = store.requireTargetRepair(
    'm1',
    'O ref avançou, mas o worktree do destino ainda não alinhou.',
    T2
  )

  assert.equal(blocked.state, 'blocked')
  assert.equal(blocked.block?.owner, 'orchestrator')
  assert.throws(
    () => store.guideResolution('m1', { instruction: 'tente mesclar de novo' }),
    hasCode('invalid_transition')
  )
  assert.equal(store.getByMission('m1')?.state, 'blocked')
  assert.equal(store.getByMission('m1')?.resolution, undefined)
})

test('recovery troca um merge interrompido por reparo pendente antes do dreno', (t) => {
  const { file, store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1')
  store.beginNext('p1', T1)

  // O construtor representa a queda: merging volta a queued. A leitura do
  // intent provado então precisa congelá-lo como reparo, não iniciar de novo.
  const recovered = new IntegrationQueueStore(file)
  assert.equal(recovered.getByMission('m1')?.state, 'queued')
  recovered.requireTargetRepair('m1', 'merge provado; alinhar destino', T2)

  const reopened = new IntegrationQueueStore(file)
  assert.equal(reopened.getByMission('m1')?.state, 'blocked')
  assert.equal(reopened.getByMission('m1')?.block?.code, 'target_repair_pending')
  assert.equal(reopened.getByMission('m1')?.block?.owner, 'orchestrator')
  assert.equal(reopened.beginNext('p1', T3), undefined)
})

test('ao reabrir, recupera merge interrompido pelo backup e preserva bloqueio/sync', (t) => {
  const { file, store } = temporaryStore(t)
  enqueue(store, 'p1', 'merging')
  enqueue(store, 'p2', 'blocked')
  enqueue(store, 'p3', 'sync')
  store.beginNext('p1', T1)
  store.beginNext('p2', T1)
  store.block('blocked', {
    code: 'conflict',
    owner: 'maestro',
    detail: 'Decisão necessária.',
    at: T2
  })
  store.beginNext('p3', T1)
  store.requireSync('sync', {
    code: 'stale_base',
    owner: 'orchestrator',
    detail: 'Atualizar a base.',
    at: T2
  })

  // O backup contém a fotografia válida; o principal simula uma queda.
  writeFileSync(file, '{ json interrompido', 'utf8')
  const recovered = new IntegrationQueueStore(file)

  assert.equal(recovered.getByMission('merging')?.state, 'queued')
  assert.equal(recovered.getByMission('merging')?.attempts, 1)
  assert.equal(recovered.getByMission('blocked')?.state, 'blocked')
  assert.equal(recovered.getByMission('sync')?.state, 'sync_required')
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
  assert.doesNotThrow(() => JSON.parse(readFileSync(`${file}.bak`, 'utf8')))
})

test('projetos possuem filas independentes e podem ter um merge cada', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'p1-m1')
  enqueue(store, 'p1', 'p1-m2', T1)
  enqueue(store, 'p2', 'p2-m1', T2)

  assert.equal(store.beginNext('p1', T3)?.missionId, 'p1-m1')
  assert.equal(store.beginNext('p2', T3)?.missionId, 'p2-m1')
  assert.equal(store.activeMerge('p1')?.missionId, 'p1-m1')
  assert.equal(store.activeMerge('p2')?.missionId, 'p2-m1')
  assert.equal(store.listPending('p2')[0].position, 1)
})

test('nunca permite dois merges no mesmo projeto', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1')
  enqueue(store, 'p1', 'm2', T1)

  store.beginNext('p1', T2)
  assert.equal(store.beginNext('p1', T3), undefined)
  assert.throws(() => store.beginMerge('m2', T3), hasCode('not_queue_head'))
  assert.equal(
    store.listPending('p1').filter((ticket) => ticket.state === 'merging').length,
    1
  )
})

test('transições inválidas são rejeitadas sem alterar a fila', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1')

  assert.throws(
    () => store.guideResolution('m1', { instruction: 'não deveria aceitar' }),
    hasCode('invalid_transition')
  )
  assert.throws(() => store.complete('m1'), hasCode('invalid_transition'))
  assert.equal(store.getByMission('m1')?.state, 'queued')
})

test('pre-CAS repair rearms the same FIFO ticket without bypassing the queue', (t) => {
  const { store } = temporaryStore(t)
  const first = enqueue(store, 'p1', 'm1', T0)
  enqueue(store, 'p1', 'm2', T1)
  store.beginNext('p1', T2)
  store.requireTargetRepair('m1', 'journal needs an external audit', T3)

  const requeued = store.requeueAfterTargetRepair('m1')
  assert.equal(requeued.id, first.id)
  assert.equal(requeued.sequence, first.sequence)
  assert.equal(requeued.state, 'queued')
  assert.equal(requeued.position, 1)
  assert.equal(requeued.block, undefined)
  assert.equal(requeued.lastError, undefined)
  assert.equal(store.beginNext('p1', T3)?.missionId, 'm1')
  assert.equal(store.complete('m1'), true)
  assert.equal(store.head('p1')?.missionId, 'm2')
  assert.equal(store.head('p1')?.position, 1)
})

test('only an operational target-repair block can be rearmed automatically', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1', T0)
  store.beginNext('p1', T1)
  store.block('m1', {
    code: 'merge_conflict',
    owner: 'maestro',
    detail: 'a product decision is required',
    at: T2
  })

  assert.throws(() => store.requeueAfterTargetRepair('m1'), hasCode('invalid_transition'))
  assert.equal(store.getByMission('m1')?.state, 'blocked')
  assert.equal(store.getByMission('m1')?.block?.owner, 'maestro')
})

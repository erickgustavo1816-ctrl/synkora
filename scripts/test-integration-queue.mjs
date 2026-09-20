import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
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

// ————— RODADA 9 (2026-08-19): a fila é COORDENAÇÃO, o agente é o EXECUTOR —————
//
// Ordem do dono: "quando eu clico em subir, o certo é avisar o agente e o AGENTE
// sobe. Qualquer erro, ELE arruma." Os três verbos abaixo são o que o store
// precisou ganhar para isso: o LACRE acompanha a mão de quem resolve o conflito,
// a tentativa falha NÃO congela o ticket, e o que a era da máquina congelou tem
// uma saída sancionada. Sem eles a única transição disponível era `block`, que é
// exatamente o card parado que o dono não quer mais ver.

test('re-lacre: o commit da entrega muda e o ticket segue na MESMA posição', (t) => {
  const { file, store } = temporaryStore(t)
  const first = store.enqueue({
    projectId: 'p1',
    missionId: 'm1',
    requestedBy: 'user',
    targetKind: 'base',
    requestedAt: T0,
    sourceHead: 'a'.repeat(40),
    validatedTargetHead: 'b'.repeat(40),
    targetBranch: 'main',
    targetDir: 'C:\projeto'
  })
  enqueue(store, 'p1', 'm2', T1)

  const resealed = store.reseal('m1', { sourceHead: 'c'.repeat(40) })
  assert.equal(resealed.id, first.id, 'o re-lacre nunca cria outro ticket')
  assert.equal(resealed.sequence, first.sequence, 'e nunca fura a FIFO')
  assert.equal(resealed.position, 1)
  assert.equal(resealed.sourceHead, 'c'.repeat(40))
  // O resto da fotografia fica onde estava: re-lacrar é sobre a ENTREGA.
  assert.equal(resealed.validatedTargetHead, 'b'.repeat(40))
  assert.equal(resealed.targetBranch, 'main')
  // e sobrevive ao disco: o lacre novo é o que o próximo boot vai conferir
  const reopened = new IntegrationQueueStore(file)
  assert.equal(reopened.getByMission('m1')?.sourceHead, 'c'.repeat(40))
  assert.equal(reopened.getByMission('m1')?.position, 1)
  assert.equal(reopened.getByMission('m2')?.position, 2)
})

test('re-lacre só existe sobre um ticket EM ESPERA — nunca debaixo de um merge', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1', T0)
  store.beginNext('p1', T1)

  assert.throws(() => store.reseal('m1', { sourceHead: 'd'.repeat(40) }), hasCode('invalid_transition'))
  assert.throws(() => store.reseal('m-inexistente', { sourceHead: 'd'.repeat(40) }), hasCode('ticket_not_found'))
  assert.equal(store.getByMission('m1')?.state, 'merging')
})

test('tentativa falha do agente NÃO congela: volta para a cabeça com o motivo', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1', T0)
  enqueue(store, 'p1', 'm2', T1)
  store.beginNext('p1', T2)

  const back = store.noteAttemptFailure('m1', 'conflito em src/main/index.ts')
  // O ESTADO É O CONTRATO: `blocked` era o card parado esperando a máquina.
  assert.equal(back.state, 'queued')
  assert.equal(back.block, undefined, 'nenhum bloqueio de máquina nasce aqui')
  assert.equal(back.isHead, true, 'quem falhou continua sendo a vez de quem falhou')
  assert.equal(back.position, 1)
  assert.equal(back.lastError, 'conflito em src/main/index.ts')
  assert.equal(back.startedAt, undefined)
  // a tentativa CONTOU (o attempts do beginMerge não é apagado)
  assert.equal(back.attempts, 1)
  // e a fila volta a aceitar a mesma missão, sem passar por ninguém
  assert.equal(store.beginNext('p1', T3)?.missionId, 'm1')
})

test('tentativa falha exige motivo e um ticket que esteja de fato tentando', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1', T0)
  assert.throws(() => store.noteAttemptFailure('m1', '   '), hasCode('invalid_input'))
  store.beginNext('p1', T1)
  store.requireTargetRepair('m1', 'o destino precisa de reparo', T2)
  assert.throws(() => store.noteAttemptFailure('m1', 'tentei de novo'), hasCode('invalid_transition'))
})

test('o congelado da era da máquina tem saída: o agente reabre na MESMA posição', (t) => {
  const { store } = temporaryStore(t)
  const first = enqueue(store, 'p1', 'm1', T0)
  enqueue(store, 'p1', 'm2', T1)
  store.beginNext('p1', T2)
  store.block('m1', {
    code: 'merge_conflict',
    owner: 'maestro',
    detail: 'a estratégia precisava do Maestro',
    at: T3
  })

  const reclaimed = store.reclaimForAgent('m1')
  assert.equal(reclaimed.id, first.id)
  assert.equal(reclaimed.sequence, first.sequence)
  assert.equal(reclaimed.state, 'queued')
  assert.equal(reclaimed.position, 1)
  assert.equal(reclaimed.block, undefined)
  assert.equal(reclaimed.resolution, undefined)
  // o motivo NÃO se apaga: é o que o agente lê para saber o que resolver
  assert.equal(reclaimed.lastError, 'a estratégia precisava do Maestro')

  // sync_required de estratégia (o card do Maestro) tem a mesma saída
  const { store: other } = temporaryStore(t)
  enqueue(other, 'p2', 'mx', T0)
  other.requireSync('mx', { code: 'sync', owner: 'maestro', detail: 'sincronize com o destino', at: T1 })
  assert.equal(other.reclaimForAgent('mx').state, 'queued')
})

test('bloqueio OPERACIONAL continua fora do alcance do agente: o merge já está gravado', (t) => {
  const { store } = temporaryStore(t)
  enqueue(store, 'p1', 'm1', T0)
  store.beginNext('p1', T1)
  store.requireTargetRepair('m1', 'o destino aguarda reparo seguro', T2)

  assert.throws(() => store.reclaimForAgent('m1'), hasCode('invalid_transition'))
  assert.equal(store.getByMission('m1')?.state, 'blocked')
  assert.equal(store.getByMission('m1')?.block?.owner, 'orchestrator')
  // e um ticket que nem está congelado não tem o que reabrir
  enqueue(store, 'p2', 'm2', T0)
  assert.throws(() => store.reclaimForAgent('m2'), hasCode('invalid_transition'))
})

// ————— R16: A ENTREGA É CAPTURADA ANTES DE O WORKTREE MORRER (2026-08-19) —————
//
// O dono cronometrou ~10 minutos de dev re-derivando o que a missão-dependência
// acabou de construir. A cura só existe se a ENTREGA da dependência ficar
// gravada, e a única janela para lê-la é ANTES do merge: o `mergeTaskWorktree`
// remove worktree e branch na limpeza dele, e o `missions.update` da conclusão
// zera os dois campos no mesmo gesto. Depois disso não há de onde ler.
//
// MECÂNICA: o motor REAL roda contra um repositório de verdade — o mesmo
// arranjo do test-mission-creation (fecho compilado para CJS por `tsc --noCheck`
// + `electron` e `gitAsync` trocados por stubs no `Module._load`). A fila é o
// STORE REAL importado no topo deste arquivo e o registro é o MissionStore
// REAL: o que se prova é o que ficou PERSISTIDO.

const gitCli = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

const userData = mkdtempSync(join(tmpdir(), 'synkora-r16-userdata-'))
process.on('exit', () => rmSync(userData, { recursive: true, force: true }))

const electronStub = {
  app: {
    getPath: () => userData,
    isPackaged: false,
    getName: () => 'synkora',
    getVersion: () => '0.0.0-test',
    on: () => electronStub.app,
    once: () => electronStub.app,
    off: () => electronStub.app,
    whenReady: () => Promise.resolve()
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  shell: { openExternal: () => {} },
  dialog: {},
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false
    }
    on() {}
    show() {}
  },
  clipboard: {},
  nativeImage: {},
  net: {},
  safeStorage: { isEncryptionAvailable: () => false }
}

/** Ordem observável das chamadas de git do motor — é ela que prova o SEAM. */
const gitOffCalls = []
/** Operações que o git "não consegue" fazer na rodada (falha de captura). */
const failingGitOps = new Set()
const gitAsyncStub = {
  GIT_CHECKPOINT_MARKER: '__SYNKORA_GIT_CHECKPOINT__',
  gitOff: async (fn, ...args) => {
    gitOffCalls.push(fn)
    if (failingGitOps.has(fn)) throw new Error(`git indisponivel para ${fn}`)
    return worktreeApi[fn](...args)
  },
  gitOffWithCheckpoint: async () => {
    throw new Error('o merge da fila não usa checkpoint neste caminho')
  }
}

const requireCompiled = createRequire(import.meta.url)
const COMPILED = join(import.meta.dirname, '..', '.tmp', 'integration-queue-test')
const loadModule = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (/(^|[\\/])gitAsync(\.js)?$/.test(request)) return gitAsyncStub
  return loadModule.call(this, request, parent, isMain)
}
const { createMissionEngine } = requireCompiled(join(COMPILED, 'missionEngine.js'))
const {
  MISSION_DELIVERY_COMMITS_CAP,
  MISSION_DELIVERY_FILES_CAP,
  MissionStore,
  missionDeliveryFrom
} = requireCompiled(join(COMPILED, 'missions.js'))
const worktreeApi = requireCompiled(join(COMPILED, 'worktree.js'))
const { BacklogStore } = requireCompiled(join(COMPILED, 'backlog.js'))

test('completed mission summaries are projected into version history and repaired idempotently', (t) => {
  const projectId = randomUUID()
  const missions = new MissionStore()
  const file = join(userData, `summary-backlog-${projectId}.json`)
  const backlog = new BacklogStore(file)
  const version = backlog.createVersion(projectId, { name: '1.0.0' })
  const mission = missions.create(projectId, { title: 'Busca corrigida', direct: true, versionId: version.id })
  const summary = 'A busca voltou a encontrar os itens pelo nome. Os resultados aparecem sem repetir a pesquisa.'
  const pushes = []
  const engine = createMissionEngine({ missions, backlog, syncBoard: () => {}, hub: { publish: () => {} } }, {
    emitBacklogChanged: id => pushes.push(id)
  })
  missions.update(mission.id, { summary, status: 'concluida' })
  assert.equal(engine.reconcileConcludedMission(projectId, mission.id, 'Concluída.').ok, true)
  const first = new BacklogStore(file).getVersion(version.id).deliveries[0]
  assert.equal(first.summary, summary)
  assert.equal(engine.reconcileConcludedMission(projectId, mission.id, 'Concluída.').ok, true)
  assert.equal(backlog.getVersion(version.id).deliveries.length, 1)
  assert.equal(pushes.length, 1, 'unchanged reconciliation stays quiet')
  const revised = 'A busca encontra os itens pelo nome completo ou por parte dele. Os resultados aparecem sem repetir a pesquisa.'
  missions.update(mission.id, { summary: revised })
  assert.equal(engine.reconcileConcludedMission(projectId, mission.id, 'Concluída.').ok, true)
  const repaired = new BacklogStore(file).getVersion(version.id).deliveries[0]
  assert.equal(repaired.summary, revised)
  assert.equal(repaired.id, first.id)
  assert.equal(repaired.at, first.at)
  assert.deepEqual(pushes, [projectId, projectId], 'summary repair refreshes the version immediately')
  assert.equal(engine.reconcileConcludedMission('other-project', mission.id, 'Concluída.').ok, false)
})

test('release pendente sobrevive à leitura depois de reiniciar sem pane vivo', (t) => {
  const projectId = randomUUID()
  const original = new MissionStore()
  const release = original.create(projectId, { title: 'Synthetic release', missionType: 'release',
    versionId: 'synthetic-version', direct: true })
  const reopened = new MissionStore()
  const { store: queue } = temporaryStore(t)
  const ctx = {
    missions: reopened, backlog: { getVersion: () => ({ status: 'lancada' }) }, integrationQueue: queue,
    blackbox: { record: () => {} }, pushAll: () => {}, scheduleProgressSnapshot: () => {}
  }
  const engine = createMissionEngine(ctx, { paneAlive: () => false })
  assert.equal(engine.missionsWithIntegration(projectId).find((m) => m.id === release.id)?.status, 'ativa')
  assert.equal(new MissionStore().get(release.id)?.status, 'ativa', 'a leitura não grava conclusão no disco')
})

/** Motor real + repositório real + missão com worktree isolado e uma entrega. */
async function mergeHarness(t) {
  const projectId = randomUUID()
  const projectPath = mkdtempSync(join(tmpdir(), 'synkora-r16-repo-'))
  gitCli(projectPath, ['init'])
  gitCli(projectPath, ['config', 'user.name', 'Synkora Test'])
  gitCli(projectPath, ['config', 'user.email', 'synkora-test@example.invalid'])
  writeFileSync(join(projectPath, 'base.txt'), 'base\n', 'utf8')
  gitCli(projectPath, ['add', '-A'])
  gitCli(projectPath, ['commit', '-m', 'commit inicial'])
  const mainBranch = gitCli(projectPath, ['branch', '--show-current'])

  const missions = new MissionStore()
  const { store: queue } = temporaryStore(t)
  const audited = []
  const ctx = {
    projects: { get: (id) => (id === projectId ? { id: projectId, path: projectPath } : undefined) },
    missions,
    backlog: {
      getVersion: () => undefined,
      completeMissionItems: () => 0,
      addDelivery: () => true,
      setVersionBranch: () => {},
      listVersions: () => []
    },
    integrationQueue: queue,
    maestro: { get: () => ({}), update: () => {} },
    ptys: { kill: () => {}, has: () => false },
    blackbox: { record: (event) => audited.push(event) },
    // O wrapper de stall é fino de propósito (contrato do missionEngine).
    mainStalls: { wrap: (_label, _id, run) => run() },
    hub: { publish: () => {}, purgeMissionEvents: () => {}, panesOf: () => [] },
    pushAll: () => {},
    syncBoard: () => {},
    scheduleProgressSnapshot: () => {},
    orchPaneId: (project, mission) => `${project}--${mission}`,
    unregisterPane: () => {}
  }
  const engine = createMissionEngine(ctx, {
    orchKey: (project, mission) => `${project}--${mission}`,
    versionIsolationIsValid: () => false,
    // R18.3: o espelho assíncrono do mesmo isolamento (aqui a missão integra na
    // BASE, então nenhum dos dois chega a ser perguntado — o par existe para a
    // fronteira do motor ficar igual à do index).
    versionIsolationProbe: async () => false,
    emitBacklogChanged: () => {},
    sweepProjectFiles: () => 0,
    closeTestServersUnder: () => {},
    deliverToGuiPane: () => false,
    noteInGuiPane: () => false,
    announceToGuiPane: () => false,
    killMissionGuiPanes: () => {}
  })

  const mission = missions.create(projectId, {
    title: 'Fila: o store',
    goal: 'Guardar os tickets por universo',
    direct: true
  })
  const withWorktree = await engine.ensureMissionWorktree(mission.id)
  assert.ok(withWorktree?.worktree && withWorktree.branch, 'a missão precisa de worktree isolado')
  gitCli(withWorktree.worktree, ['config', 'user.name', 'Synkora Test'])
  gitCli(withWorktree.worktree, ['config', 'user.email', 'synkora-test@example.invalid'])
  writeFileSync(join(withWorktree.worktree, 'fila.ts'), 'export const fila = []\n', 'utf8')
  gitCli(withWorktree.worktree, ['add', '-A'])
  gitCli(withWorktree.worktree, ['commit', '-m', 'feat(queue): o ticket nasce com a fotografia'])

  gitOffCalls.length = 0
  failingGitOps.clear()
  t.after(() => {
    failingGitOps.clear()
    rmSync(join(userData, 'worktrees', projectId), { recursive: true, force: true })
    rmSync(projectPath, { recursive: true, force: true })
  })

  queue.enqueue({
    projectId,
    missionId: mission.id,
    requestedBy: 'user',
    targetKind: 'base',
    requestedAt: T0,
    sourceHead: gitCli(withWorktree.worktree, ['rev-parse', 'HEAD']),
    validatedTargetHead: gitCli(projectPath, ['rev-parse', 'HEAD']),
    targetBranch: mainBranch,
    targetDir: projectPath
  })

  return {
    engine,
    projectId,
    projectPath,
    missions,
    missionId: mission.id,
    worktree: withWorktree.worktree,
    audited
  }
}

test('R16: o merge real GRAVA a entrega da missão — lida antes de o worktree sumir', async (t) => {
  const harness = await mergeHarness(t)
  const sourceHead = gitCli(harness.worktree, ['rev-parse', 'HEAD']).trim()
  const summary = 'As missões aguardam sua vez na fila. Cada entrega mantém a posição até a integração terminar.'
  harness.missions.update(harness.missionId, { summary })
  const outcome = await harness.engine.runMissionIntegration(harness.projectId, harness.missionId)
  assert.match(outcome, /INTEGRADA/u, outcome)

  const stored = harness.missions.get(harness.missionId)
  assert.equal(stored.status, 'concluida')
  // O MESMO gesto que zerou branch/worktree gravou a entrega: se a captura
  // viesse depois, não haveria worktree de onde ler (a asserção abaixo prova
  // que ele não existe mais no disco).
  assert.equal(stored.branch, undefined)
  assert.equal(stored.worktree, undefined)
  assert.equal(existsSync(harness.worktree), false, 'o worktree tem de morrer no merge')
  assert.ok(stored.delivery, 'a missão concluiu SEM entrega registrada')
  assert.equal(stored.delivery.sourceHead, sourceHead, 'a origem deve continuar verificável depois da limpeza')
  assert.deepEqual(stored.delivery.commits, ['feat(queue): o ticket nasce com a fotografia'])
  assert.deepEqual(stored.delivery.files, ['fila.ts'])
  assert.equal(stored.delivery.truncated, undefined, 'nada foi cortado nesta entrega')
  assert.match(stored.delivery.capturedAt, /^\d{4}-\d{2}-\d{2}T/u)

  // ORDEM, e não só resultado: o git da captura roda ANTES do merge.
  assert.ok(
    gitOffCalls.indexOf('missionCommits') >= 0 &&
      gitOffCalls.indexOf('missionCommits') < gitOffCalls.indexOf('mergeTaskWorktree'),
    `ordem inesperada das chamadas de git: ${gitOffCalls.join(' → ')}`
  )
  assert.ok(
    gitOffCalls.indexOf('missionWorkspaceSummary') < gitOffCalls.indexOf('mergeTaskWorktree')
  )

  // e o disco é a autoridade: outra instância do store lê a mesma entrega
  assert.deepEqual(new MissionStore().get(harness.missionId).delivery, stored.delivery)
  assert.equal(new MissionStore().get(harness.missionId).summary, summary)

  const captured = harness.audited.find((event) => event.event === 'mission-delivery-captured')
  assert.ok(captured, 'captura boa tem de virar evento de caixa-preta')
  assert.equal(captured.ids.missionId, harness.missionId)
  assert.equal(captured.detail.commits, 1)
  assert.equal(captured.detail.files, 1)
})

test('R16: falha na captura NÃO segura a conclusão — a missão integra sem entrega', async (t) => {
  const harness = await mergeHarness(t)
  failingGitOps.add('missionCommits')
  failingGitOps.add('missionWorkspaceSummary')

  const outcome = await harness.engine.runMissionIntegration(harness.projectId, harness.missionId)
  assert.match(outcome, /INTEGRADA/u, outcome)

  const stored = harness.missions.get(harness.missionId)
  assert.equal(stored.status, 'concluida', 'a entrega é bônus de conhecimento, nunca pré-condição')
  assert.equal(stored.delivery, undefined, 'sem leitura não se inventa entrega')
  const failed = harness.audited.find((event) => event.event === 'mission-delivery-capture-failed')
  assert.ok(failed, 'a captura que falhou tem de deixar rastro na caixa-preta')
  assert.equal(failed.ids.missionId, harness.missionId)
  assert.match(failed.err, /git indisponivel/u)
})

test('R16: os tetos da entrega cortam a lista, mas o TOTAL continua verdadeiro', () => {
  // A entrega é o que o briefing do dev imprime: lista curta é aceitável,
  // lista curta se passando por entrega inteira não — o dev estudaria pela
  // metade acreditando ter visto tudo.
  const grande = missionDeliveryFrom({
    capturedAt: '2026-08-19T10:00:00.000Z',
    commits: Array.from({ length: 61 }, (_, i) => `feat: passo ${i + 1}`),
    files: Array.from({ length: 118 }, (_, i) => `src/arquivo-${i + 1}.ts`),
    totalCommits: 61
  })
  assert.equal(grande.commits.length, MISSION_DELIVERY_COMMITS_CAP)
  assert.equal(grande.files.length, MISSION_DELIVERY_FILES_CAP)
  assert.deepEqual(grande.truncated, { commits: 61, files: 118 })
  // os mais NOVOS primeiro: o corte mantém a cabeça da lista que o git deu
  assert.equal(grande.commits[0], 'feat: passo 1')

  // `ahead` é a autoridade sobre o total quando o leitor já veio com teto
  // próprio (missionCommits para em 50): o total nunca encolhe para o que coube.
  const lidoComTeto = missionDeliveryFrom({
    capturedAt: '2026-08-19T10:00:00.000Z',
    commits: Array.from({ length: 50 }, (_, i) => `feat: passo ${i + 1}`),
    files: ['a.ts'],
    totalCommits: 137
  })
  assert.equal(lidoComTeto.truncated.commits, 137)
  assert.equal(lidoComTeto.truncated.files, 1)

  // nada cortado = sem `truncated` (o briefing não imprime "N de N")
  const pequena = missionDeliveryFrom({
    capturedAt: '2026-08-19T10:00:00.000Z',
    commits: ['feat: uma coisa só', '   '],
    files: ['a.ts', 'a.ts', '  ']
  })
  assert.deepEqual(pequena.commits, ['feat: uma coisa só'])
  assert.deepEqual(pequena.files, ['a.ts'], 'arquivo repetido conta uma vez')
  assert.equal(pequena.truncated, undefined)

  // sem commit e sem arquivo NÃO existe entrega: ausência é a resposta honesta
  assert.equal(
    missionDeliveryFrom({ capturedAt: '2026-08-19T10:00:00.000Z', commits: [], files: [] }),
    undefined
  )
})

// ————— R17: O ⇪ SOBE SEM TRAVAR O APP (2026-08-19) —————
//
// Reprodução do dono com os sensores da caixa-preta armados: `main-thread-stall`
// de 809ms no instante do clique e 1546ms no meio do run, enquanto
// `git-sync-slow` (≥200ms individual) deu ZERO evento. O culpado não é um git
// lento: é a RAJADA. No Windows cada spawn de git custa ~100-180ms (imposto do
// Defender por processo) e uma sequência SÍNCRONA no main nunca deixa o event
// loop respirar — dez chamadas baratas viram UM estol de segundos.
//
// A cura é TRANSPORTE, NÃO LÓGICA: as MESMAS perguntas, na MESMA ordem, dentro
// do gitWorker. Estes testes seguram as duas metades disso — o seam observável
// (a rajada aparece no `gitOff`, com a ordem intacta, porque fotografia lida em
// sequência é parte do lacre) e o FONTE (o caminho do ⇪ não chama mais nenhuma
// das funções síncronas direto, então a rajada não volta por descuido).

const engineSource = readFileSync(
  new URL('../src/main/missionEngine.ts', import.meta.url),
  'utf8'
).replace(/\r\n/gu, '\n')

/** Corpo de uma função do closure: da assinatura (`nome(`, com ou sem `async` —
 *  a busca é pelo `function nome(`, que casa nas duas formas) até o primeiro
 *  fecho NA INDENTAÇÃO DO CLOSURE (`\n  }`). Tudo que é corpo tem indentação
 *  maior, então esse é o fim da função, não um bloco interno.
 *  R18: a régua ganhou a fonte como parâmetro (o domínio VERSÃO mora no index),
 *  e o `engineBody` continua sendo o atalho para o motor. */
function bodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `função não encontrada no fonte: ${name}`)
  const end = source.indexOf('\n  }\n', start)
  assert.ok(end > start, `fim do corpo não encontrado: ${name}`)
  return source.slice(start, end)
}

function engineBody(name) {
  return bodyOf(engineSource, name)
}

/** Chamada DIRETA de `nome(` — a string `'nome'` dentro de `gitOff('nome', …)`
 *  não casa, que é exatamente a diferença entre main thread e gitWorker. */
function directCall(name) {
  return new RegExp(`(?<![\\w'])${name}\\(`, 'u')
}

/** As funções de git que a rajada do ⇪ usava. No caminho do ⇪ elas só podem
 *  aparecer como ARGUMENTO do gitOff. */
const SYNC_GIT_BURST = [
  'gitHead',
  'currentBranch',
  'isWorktreeClean',
  'hasGitCommit',
  'isExpectedWorktree',
  'gitCommitReached',
  'gitLocalBranchExists',
  'createVersionWorktree',
  'ensureSynkoraGitExcludes',
  'ensureWorktreeEnvironment',
  'resolveMissionWorkspace',
  'missionWorkspacePath'
]

test('R17: o caminho do ⇪ não tem NENHUM git síncrono no fonte', () => {
  const path = {
    startMissionIntegration: engineBody('startMissionIntegration'),
    runHeadIntegration: engineBody('runHeadIntegration'),
    completeMissionMergeInner: engineBody('completeMissionMergeInner'),
    resolveMissionIntegrationTarget: engineBody('resolveMissionIntegrationTarget'),
    writeMissionIntegrationIntent: engineBody('writeMissionIntegrationIntent'),
    ensureMissionWorktreeOffThread: engineBody('ensureMissionWorktreeOffThread'),
    ensureMissionWorktree: engineBody('ensureMissionWorktree')
  }
  for (const [name, body] of Object.entries(path)) {
    for (const fn of SYNC_GIT_BURST) {
      assert.doesNotMatch(
        body,
        directCall(fn),
        `${name} chama ${fn}() direto — isso é spawn de git no MAIN THREAD, e é a rajada que trava o app`
      )
    }
  }
  // Integration uses the same serialized preparation as creation and reopening.
  for (const name of ['startMissionIntegration', 'runHeadIntegration']) {
    assert.doesNotMatch(path[name], directCall('ensureMissionWorktree'), name)
    assert.match(path[name], /ensureMissionWorktreeOffThread\(/u, name)
    assert.match(path[name], /missionWorkspacePathOffThread\(/u, name)
  }
  // E o transporte existe de verdade: os nomes viajam como argumento do gitOff.
  for (const fn of ['isWorktreeClean', 'gitHead', 'hasGitCommit']) {
    assert.match(path.startMissionIntegration, new RegExp(`gitOff\\('${fn}'`, 'u'), fn)
    assert.match(path.runHeadIntegration, new RegExp(`gitOff\\('${fn}'`, 'u'), fn)
  }
  assert.match(path.completeMissionMergeInner, /gitOff\('currentBranch'/u)
  assert.match(path.writeMissionIntegrationIntent, /gitOff\('gitHead'/u)
})

test('mission preparation has one complete worker path for creation, reopen and integration', () => {
  const preparation = engineBody('ensureMissionWorktree')
  const off = engineBody('ensureMissionWorktreeOffThread')
  for (const operation of ['hasGitCommit', 'initGitRepo', 'ensureSynkoraGitExcludes', 'isExpectedWorktree',
    'ensureWorktreeEnvironment', 'createVersionWorktree', 'createMissionWorktree']) {
    assert.match(preparation, new RegExp(`gitOff\\(\\s*'${operation}'`, 'u'))
    assert.doesNotMatch(preparation, directCall(operation))
  }
  assert.match(off, /ensureMissionWorktree\(missionId\)/u)
  assert.match(engineBody('createMissionImpl'), /await ensureMissionWorktreeOffThread\(mission.id\)/u)
})

test('R17: o ⇪ do dono manda a rajada inteira para o gitWorker, na ordem do lacre', async (t) => {
  const harness = await mergeHarness(t)
  const msg = await harness.engine.startMissionIntegration(harness.missionId, 'user')
  assert.match(msg, /fila de integração/u, msg)
  // ORDEM E CONTEÚDO: a sequência abaixo é o lacre do ⇪ lido em fotografia —
  // worktree provado, repo, workspace, árvore limpa, head da origem e head do
  // destino. Nenhuma some, nenhuma troca de lugar; todas fora do main thread.
  assert.deepEqual(gitOffCalls, [
    'hasGitCommit', //             ensureMissionWorktree: o repo tem commit?
    'ensureSynkoraGitExcludes', // ensureMissionWorktree: .synkora invisível
    'isExpectedWorktree', //       ensureMissionWorktree: o worktree é o desta missão
    'ensureWorktreeEnvironment', // configuração local depois da prova de isolamento
    'hasGitCommit', //             projeto git? (sem git não há merge)
    'resolveMissionWorkspace', //  o worktree isolado, provado
    'isWorktreeClean', //          a árvore da entrega está limpa
    'gitHead', //                  lacre da ORIGEM
    'gitHead' //                   fotografia do DESTINO
  ])
})

test('R17: o integration_run também não spawna git no main — do começo ao merge', async (t) => {
  const harness = await mergeHarness(t)
  const outcome = await harness.engine.runMissionIntegration(harness.projectId, harness.missionId)
  assert.match(outcome, /INTEGRADA/u, outcome)
  // O run repete as MESMAS conferências do ⇪ (a fila é serial: entre o clique e
  // a vez dela o mundo pode ter mudado) e só então mescla.
  assert.deepEqual(gitOffCalls.slice(0, 10), [
    'hasGitCommit',
    'ensureSynkoraGitExcludes',
    'isExpectedWorktree',
    'ensureWorktreeEnvironment',
    'resolveMissionWorkspace',
    'hasGitCommit',
    'isWorktreeClean',
    'gitHead', //          lacre da origem (re-lacre auditado se mudou)
    'gitHead', //          head do destino
    'gitCommitReached' //  o destino já está dentro da entrega?
  ])
  // E o fecho do merge — fotografia pré-merge, ponto seguro de recuperação e
  // captura da entrega — segue o mesmo caminho, sempre ANTES do merge real.
  const tail = gitOffCalls.slice(10)
  assert.deepEqual(tail, [
    'resolveMissionWorkspace', // completeMissionMerge: workspace de novo
    'hasGitCommit',
    'gitHead', //                 fotografia do instante anterior ao merge
    'gitHead',
    'currentBranch',
    'missionMergePrecheck',
    'ensureSynkoraGitExcludes', // writeMissionIntegrationIntent (ponto seguro)
    'resolveMissionWorkspace',
    'gitHead',
    'gitHead',
    'currentBranch',
    'missionCommits', //          R16: a entrega é lida antes de o worktree sumir
    'missionWorkspaceSummary',
    'gitHead', //                 origem durável para as consultas de contexto
    'mergeTaskWorktree',
    // R18.2: e o FECHO, que até aqui era o último git SÍNCRONO do caminho —
    // limpeza dos arquivos da missão e remoção do marcador de integração.
    'ensureSynkoraGitExcludes', // cleanupMissionFilesOffThread
    'ensureSynkoraGitExcludes' //  clearMissionIntegrationIntentOffThread
  ])
})

// ————— R18: OS RESÍDUOS DO ESTOL (2026-08-19) —————
//
// A R17 tirou a rajada do ⇪ do main thread e deixou QUATRO resíduos nomeados.
// Estes testes seguram três deles: a tool que o agente mais chama
// (`integration_status`, ~7 spawns por consulta — e a persona do release manda
// lê-la ANTES de agir), o FECHO do merge (a parte GIT do estol de 411ms que o
// dono mediu) e o isolamento da versão (~5 spawns por resolução de destino).
//
// A regra é a mesma da R17: TRANSPORTE, NÃO LÓGICA. Nenhuma pergunta muda de
// conteúdo, de ordem ou de frase; o que muda é o thread. E onde a função é
// COMPARTILHADA com a reconciliação de BOOT (que segue síncrona por desenho),
// o espelho é PINADO contra o original — é o par que impede as duas metades de
// divergirem no primeiro conserto aplicado de um lado só.

test('R18: o integration_status manda a fotografia dele para o gitWorker, na ordem', async (t) => {
  // O harness já deixa o ticket na fila — exatamente o que o ⇪ do dono deixa —
  // e zera o `gitOffCalls` antes disso: o que sobra aqui é SÓ a consulta.
  const harness = await mergeHarness(t)

  const status = await harness.engine.missionIntegrationStatus(
    harness.projectId,
    harness.missionId
  )

  // O TEXTO é o contrato e não mudou uma linha: cabeçalho, ticket, lacre,
  // árvore e a RECEITA do próximo passo.
  assert.match(status, /FILA DE INTEGRAÇÃO deste universo/u, status)
  assert.match(status, /SEU TICKET: posição #1 de 1 · estado queued · você é a CABEÇA/u, status)
  assert.match(status, /LACRE DA ENTREGA/u, status)
  assert.match(status, /ÁRVORE DA MISSÃO: limpa/u, status)
  assert.match(status, /PRÓXIMO PASSO: é a SUA VEZ: chame integration_run\./u, status)

  // E cada git dela viajou, na ORDEM de leitura de sempre.
  assert.deepEqual(
    gitOffCalls,
    [
      'resolveMissionWorkspace', // o worktree isolado da missão, provado
      'gitHead', //                lacre ATUAL da entrega
      'isWorktreeClean', //        a árvore da missão
      'gitHead' //                 head do DESTINO
    ],
    'a consulta mais frequente do agente não pode spawnar git no main thread'
  )
})

test('R18: status, fecho e recuperação pelo botão não têm git SÍNCRONO no fonte', () => {
  const bodies = {
    missionIntegrationStatus: engineBody('missionIntegrationStatus'),
    cleanupMissionFilesOffThread: engineBody('cleanupMissionFilesOffThread'),
    clearMissionIntegrationIntentOffThread: engineBody('clearMissionIntegrationIntentOffThread'),
    recoverMissionIntegrationIntents: engineBody('recoverMissionIntegrationIntents')
  }
  for (const [name, body] of Object.entries(bodies)) {
    for (const fn of SYNC_GIT_BURST) {
      assert.doesNotMatch(
        body,
        directCall(fn),
        `${name} chama ${fn}() direto — isso é spawn de git no MAIN THREAD`
      )
    }
  }
  // O fecho do merge chama os ESPELHOS, nunca os originais compartilhados.
  const closing = engineBody('completeMissionMergeInner')
  assert.doesNotMatch(closing, directCall('cleanupMissionFiles'), 'o fecho do merge')
  assert.doesNotMatch(closing, directCall('clearMissionIntegrationIntent'), 'o fecho do merge')
  assert.match(closing, /await cleanupMissionFilesOffThread\(/u)
  assert.match(closing, /await clearMissionIntegrationIntentOffThread\(/u)
  // (O twin no CRIAR missão — R18.4 — foi revertido no review: sem ganho de
  // main thread medido; ver r18-agent-report.md, nota honesta nº 2.)
  // Recovery also serves the owner's retry button, so its Git cannot block UI.
  const boot = engineBody('recoverMissionIntegrationIntents')
  assert.match(boot, /await clearMissionIntegrationIntentOffThread\(/u)
  assert.match(boot, /await cleanupMissionFilesOffThread\(/u)
})

/** A sequência de OPERAÇÕES de um corpo, com o `gitOff('x', …)` achatado no
 *  nome que ele transporta: é ISSO que o par espelho-vs-original precisa ter
 *  idêntico — mesma pergunta, mesma ordem, thread diferente. */
function operationSequence(body, names) {
  const alternatives = names.join('|')
  const pattern = new RegExp(`gitOff\\('(${alternatives})'|(?<![\\w'])(${alternatives})\\(`, 'gu')
  return [...body.matchAll(pattern)].map((match) => match[1] ?? match[2])
}

test('R18: fecho e recuperação compartilham a limpeza depois de configurar excludes', () => {
  const clearOps = ['ensureSynkoraGitExcludes', 'unlinkSync', 'missionIntegrationIntentPath']
  assert.deepEqual(
    operationSequence(engineBody('clearMissionIntegrationIntentOffThread'), clearOps),
    ['ensureSynkoraGitExcludes', 'unlinkSync', 'missionIntegrationIntentPath'],
    'o marcador só sai depois de configurar excludes'
  )
  const cleanupOps = ['ensureSynkoraGitExcludes', 'cleanupMissionFilesAfterExcludes']
  assert.deepEqual(
    operationSequence(engineBody('cleanupMissionFilesOffThread'), cleanupOps),
    ['ensureSynkoraGitExcludes', 'cleanupMissionFilesAfterExcludes'],
    'a limpeza só começa depois de configurar excludes'
  )
  // E o corpo de ARQUIVOS é função COMPARTILHADA: o que some da missão tem um
  // dono da verdade só, senão os dois lados divergem no primeiro conserto.
  assert.match(engineBody('cleanupMissionFilesAfterExcludes'), /unlinkSync\(/u)
  for (const name of ['cleanupMissionFilesOffThread']) {
    assert.doesNotMatch(
      engineBody(name),
      /readdirSync\(/u,
      `${name} duplicou o corpo de arquivos em vez de compartilhá-lo`
    )
  }
})

const indexSource = readFileSync(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8'
).replace(/\r\n/gu, '\n')

test('R18: o isolamento da versão tem UM dono da verdade — predicado e probe da mesma pureza', () => {
  // All asynchronous paths, including recovery, use the worker probe.
  for (const name of ['resolveMissionIntegrationTarget', 'completeMissionMergeInner', 'recoverMissionIntegrationIntents']) {
    const body = engineBody(name)
    assert.doesNotMatch(
      body,
      directCall('versionIsolationIsValid'),
      `${name} ainda chama o predicado SÍNCRONO — são ~5 spawns de git no main thread`
    )
    assert.match(body, /await versionIsolationProbe\(/u, name)
  }
  // First checkout and recovery now use the same asynchronous probe too.
  assert.match(engineBody('ensureMissionWorktree'), /await versionIsolationProbe\(/u)
  assert.doesNotMatch(engineBody('ensureMissionWorktree'), directCall('versionIsolationIsValid'))

  // No index: a metade PURA é UMA função, e os dois lados nascem dela.
  const probe = bodyOf(indexSource, 'versionIsolationProbe')
  assert.match(probe, /versionIsolationIsNarrow\(version\)/u, 'o probe deriva a pureza, não a copia')
  assert.match(probe, /gitOff\('isExpectedVersionWorktree'/u, 'o git do probe tem de viajar')
  assert.doesNotMatch(probe, directCall('isExpectedVersionWorktree'))
  const predicate = bodyOf(indexSource, 'versionIsolationIsValid')
  assert.match(predicate, /versionIsolationIsNarrow\(version\)/u, 'o predicado deriva a MESMA pureza')
  assert.match(
    indexSource,
    /version is Version & \{ branch: string; worktree: string \}/u,
    'o narrowing dos chamadores síncronos (ipc/backlog) não pode sumir'
  )
  // E o probe entra nos extras do motor, ao lado do predicado.
  const wiring = indexSource.slice(indexSource.indexOf('createMissionEngine(ctx, {'))
  assert.match(
    wiring.slice(0, 400),
    /versionIsolationProbe/u,
    'o motor só enxerga o probe se ele for fiado nos extras'
  )
})

test('R18: o FECHO do merge (limpeza + marcador) também roda no gitWorker', async (t) => {
  const harness = await mergeHarness(t)
  const outcome = await harness.engine.runMissionIntegration(harness.projectId, harness.missionId)
  assert.match(outcome, /INTEGRADA/u, outcome)

  // Depois do merge real vem o fecho: limpeza dos arquivos operacionais da
  // missão e remoção do marcador de integração. Os dois perguntam
  // `ensureSynkoraGitExcludes` (2 spawns cada) — e era isso, colado no main,
  // que sobrava do caminho da integração depois da R17.
  const closing = gitOffCalls.slice(gitOffCalls.indexOf('mergeTaskWorktree') + 1)
  assert.deepEqual(
    closing,
    ['ensureSynkoraGitExcludes', 'ensureSynkoraGitExcludes'],
    `o fecho ainda tem git no main thread: ${gitOffCalls.join(' → ')}`
  )
  // E o fecho FEZ o que promete: o marcador não sobrevive à integração.
  assert.equal(
    existsSync(join(harness.projectPath, '.synkora', 'integrations', `${harness.missionId}.intent`)),
    false,
    'o marcador de integração tem de sumir no fecho'
  )
})

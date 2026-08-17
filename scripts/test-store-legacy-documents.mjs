import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * R-12 DA LIMPA F6 — "um documento gravado pelo build F6 carrega, ignora as
 * chaves órfãs e NÃO lança".
 *
 * A demolição tirou campos inteiros dos tipos: `planningEvidence` e
 * `planningTrustVersion` do projeto, `planningMethod` da missão, `bypassOff`
 * e `releaseHold` do maestro, o card de plano do backlog. O que está no disco
 * do dono continua lá — e é EVIDÊNCIA, não lixo. Estes testes provam as duas
 * metades do contrato: carrega sem quebrar, e regrava sem AMPUTAR.
 *
 * Cada store é carregado com o `electron` estubado para um userData
 * temporário, exatamente como test-store-atomicity faz.
 */

const require = createRequire(import.meta.url)
const COMPILED = '../.tmp/store-legacy-test'

let userData = ''
const originalLoad = Module._load
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userData } }
  return originalLoad.call(this, request, parent, isMain)
}
const { ProjectStore } = require(`${COMPILED}/projects.js`)
const { MissionStore } = require(`${COMPILED}/missions.js`)
const { MaestroStore } = require(`${COMPILED}/maestroStore.js`)
const { BacklogStore } = require(`${COMPILED}/backlog.js`)
const { PlanStore } = require(`${COMPILED}/plans.js`)
Module._load = originalLoad

function sandbox(t, file, document) {
  userData = mkdtempSync(join(tmpdir(), 'synkora-legacy-store-'))
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  writeFileSync(join(userData, file), JSON.stringify(document, null, 2), 'utf-8')
  return {
    path: join(userData, file),
    read: () => JSON.parse(readFileSync(join(userData, file), 'utf-8'))
  }
}

test('projects.json do build F6 carrega e conserva planningEvidence ao regravar', (t) => {
  const disk = sandbox(t, 'projects.json', [
    {
      id: 'p1',
      name: 'PAINEL DE GESTAO',
      path: 'C:/universos/painel',
      createdAt: '2026-08-01T00:00:00.000Z',
      mode: 'greenfield',
      planningTrustVersion: 1,
      legacyPlanningApproval: { approvedAt: '2026-08-02T00:00:00.000Z' },
      planningEvidence: {
        receiptId: 'r-1',
        fingerprint: 'abc123',
        phaseRun: 'run-9'
      }
    }
  ])

  const store = new ProjectStore()
  const project = store.get('p1')
  assert.equal(project.name, 'PAINEL DE GESTAO')

  // A mutação mais banal do dono: renomear o universo.
  store.rename('p1', 'PAINEL')
  const [written] = disk.read()
  assert.equal(written.name, 'PAINEL')
  assert.deepEqual(
    written.planningEvidence,
    { receiptId: 'r-1', fingerprint: 'abc123', phaseRun: 'run-9' },
    'a evidência de planejamento do dono foi AMPUTADA na regravação'
  )
  assert.equal(written.planningTrustVersion, 1)
  assert.ok(written.legacyPlanningApproval, 'a aprovação legada some do disco')
})

test('missions.json com campos legados carrega, lista e regrava sem perdê-los', (t) => {
  const disk = sandbox(t, 'missions.json', [
    {
      id: 'm1',
      projectId: 'p1',
      title: 'Extrator PERDCOMP',
      goal: 'ler o PDF',
      status: 'ativa',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      // pré-2.0: sem `direct`, com o vocabulário do orquestrador
      pendingOrchestrator: true,
      kind: 'direta',
      planningMethod: { skillId: 'writing-plans', at: '2026-08-10T00:00:00.000Z' }
    }
  ])

  const store = new MissionStore()
  const [mission] = store.list('p1')
  assert.equal(mission.title, 'Extrator PERDCOMP')
  assert.equal(mission.direct, undefined, 'um registro pré-2.0 não ganha direct do nada')

  store.update('m1', { status: 'arquivada' })
  const [written] = disk.read()
  assert.equal(written.status, 'arquivada')
  assert.ok(written.planningMethod, 'planningMethod foi apagado do disco')
  assert.equal(written.kind, 'direta')
})

test('maestro.json com os toggles e o hold antigos carrega e não lança', (t) => {
  const disk = sandbox(t, 'maestro.json', {
    p1: {
      seatId: 'seat-1',
      version: 'V1.2',
      tuiSessionId: 'sess-1',
      bypassOff: true,
      sensitiveAutoOk: true,
      runtimePaths: ['data'],
      projectLifecycle: 'greenfield-planning',
      reviewerSeatId: 'seat-2',
      releaseHold: { reason: 'verificação em curso', at: '2026-08-11T00:00:00.000Z' },
      log: [{ kind: 'say', text: 'oi' }]
    }
  })

  const store = new MaestroStore()
  const state = store.get('p1')
  assert.equal(state.seatId, 'seat-1')
  assert.equal(state.version, 'V1.2')

  store.update('p1', { version: 'V1.3' })
  assert.equal(disk.read().p1.version, 'V1.3')
  assert.equal(disk.read().p1.releaseHold?.reason, 'verificação em curso')
})

test('backlog.json e plans.json com chaves órfãs carregam e seguem mutáveis', (t) => {
  userData = mkdtempSync(join(tmpdir(), 'synkora-legacy-store-'))
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  writeFileSync(
    join(userData, 'backlog.json'),
    JSON.stringify({
      versions: [
        {
          id: 'v1',
          projectId: 'p1',
          name: 'V1.0',
          status: 'aberta',
          createdAt: '2026-08-01T00:00:00.000Z',
          deliveries: [],
          roadmapItemId: 'onda-3'
        }
      ],
      items: []
    }),
    'utf-8'
  )
  writeFileSync(
    join(userData, 'plans.json'),
    JSON.stringify([
      {
        id: 'plan-1',
        projectId: 'p1',
        title: 'Rotas',
        status: 'ativo',
        items: [],
        createdAt: '2026-08-15T00:00:00.000Z',
        updatedAt: '2026-08-15T00:00:00.000Z',
        legacyWaveId: 'onda-3'
      }
    ]),
    'utf-8'
  )

  const backlog = new BacklogStore()
  const [version] = backlog.listVersions('p1')
  assert.equal(version.name, 'V1.0')

  const plans = new PlanStore()
  assert.equal(plans.list('p1').length, 1)
  assert.equal(plans.list('p1')[0].title, 'Rotas')
})

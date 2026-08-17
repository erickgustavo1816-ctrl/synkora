import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProgressCoordinatorActivity,
  buildProgressSnapshot
} from '../src/main/progressSnapshot.ts'

/**
 * RADAR DE ANDAMENTO — o que ele sabe depois da limpa F6 (2026-08-17).
 *
 * A suíte antiga (21 testes) descrevia o pipeline de cards: fases, gates,
 * verificação conjunta, plano mestre por ondas. Nada disso existe. O snapshot
 * é re-derivado de TRÊS fontes e só delas — missões, fila de integração e as
 * notas vivas que o agente registra. Estes testes prendem exatamente isso: o
 * que o dono vê no overlay quando não há card nenhum no mundo.
 */

const NOW = '2026-08-17T12:00:00.000Z'

const project = (id, name) => ({
  id,
  name,
  path: `C:/universos/${id}`,
  createdAt: '2026-08-01T00:00:00.000Z'
})

const mission = (over = {}) => ({
  id: 'm1',
  projectId: 'p1',
  title: 'Máscara de CNPJ',
  status: 'ativa',
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-17T11:59:00.000Z',
  direct: true,
  ...over
})

const ticket = (over = {}) => ({
  id: 't1',
  missionId: 'm1',
  projectId: 'p1',
  state: 'queued',
  position: 1,
  total: 2,
  isHead: true,
  attempts: 0,
  requestedBy: 'user',
  targetKind: 'base',
  createdAt: NOW,
  ...over
})

const build = (over = {}) =>
  buildProgressSnapshot({
    projects: [project('p1', 'PAINEL')],
    missions: [mission()],
    integrationQueue: [],
    now: NOW,
    revision: 1,
    ...over
  })

const only = (snapshot) => snapshot.projects[0]
const firstMission = (snapshot) => only(snapshot).activeMissions[0]

test('missão viva sem fila aparece em andamento, e a nota do agente é o detalhe', () => {
  const snapshot = build({
    paneNotes: [
      {
        projectId: 'p1',
        missionId: 'm1',
        role: 'dev',
        text: 'aplicando a máscara no formulário',
        at: '2026-08-17T11:59:30.000Z'
      }
    ]
  })
  const m = firstMission(snapshot)
  assert.equal(m.state, 'implementing')
  assert.equal(m.tone, 'running')
  assert.equal(m.detail, 'aplicando a máscara no formulário')
  // frescor: a nota é mais nova que a missão e manda no updatedAt
  assert.equal(m.updatedAt, '2026-08-17T11:59:30.000Z')
})

test('a nota de OUTRA missão nunca vaza para esta', () => {
  const snapshot = build({
    missions: [mission(), mission({ id: 'm2', title: 'Extrator' })],
    paneNotes: [
      { projectId: 'p1', missionId: 'm2', role: 'dev', text: 'lendo o SPED', at: NOW }
    ]
  })
  const cnpj = only(snapshot).activeMissions.find((item) => item.id === 'm1')
  assert.equal(cnpj.detail, undefined)
})

test('a fila manda no estado: enfileirada, sincronizando, integrando, bloqueada', () => {
  const cases = [
    [ticket({ state: 'queued' }), 'queued', 'waiting'],
    [ticket({ state: 'sync_required' }), 'syncing', 'waiting'],
    [ticket({ state: 'merging' }), 'integrating', 'running'],
    [ticket({ state: 'blocked', block: { owner: 'maestro' } }), 'blocked', 'attention']
  ]
  for (const [entry, state, tone] of cases) {
    const m = firstMission(build({ integrationQueue: [entry] }))
    assert.equal(m.state, state, `estado errado para ${entry.state}`)
    assert.equal(m.tone, tone, `tom errado para ${entry.state}`)
    assert.equal(m.queue?.state, entry.state, 'a posição na fila viaja no snapshot')
  }
})

test('missão em "integrando" conta como integração mesmo sem ticket', () => {
  const m = firstMission(build({ missions: [mission({ status: 'integrando' })] }))
  assert.equal(m.state, 'integrating')
})

test('o ⇪ pedido e não clicado vira ATENÇÃO — é decisão parada do dono', () => {
  const snapshot = build({ missions: [mission({ pendingIntegrationApproval: true })] })
  const m = firstMission(snapshot)
  assert.equal(m.state, 'awaiting_approval')
  assert.equal(m.tone, 'attention')
  assert.equal(only(snapshot).tone, 'attention')
})

test('missão concluída sai das ativas e entra nas conclusões recentes', () => {
  const snapshot = build({
    missions: [mission({ status: 'concluida', updatedAt: '2026-08-17T10:00:00.000Z' })]
  })
  assert.deepEqual(only(snapshot).activeMissions, [])
  assert.equal(only(snapshot).recentCompletions.length, 1)
  assert.equal(snapshot.totals.recentCompletions, 1)
})

test('pergunta do dono vence qualquer tom, na missão e no projeto', () => {
  const snapshot = build({
    pendingQuestions: [
      { projectId: 'p1', missionKey: 'm1', question: 'posso publicar a versão?', at: NOW }
    ]
  })
  const m = firstMission(snapshot)
  assert.equal(m.question, 'posso publicar a versão?')
  assert.equal(m.tone, 'attention')
  assert.equal(only(snapshot).label, 'pergunta esperando você')
})

test('pasta que sumiu do disco é o alarme mais alto do projeto', () => {
  const snapshot = build({ missingProjectIds: ['p1'] })
  assert.equal(only(snapshot).missing, true)
  assert.equal(only(snapshot).label, 'pasta não encontrada')
  assert.equal(snapshot.totals.attentionProjects, 1)
})

test('projeto sem missão viva fica ocioso e não inventa atividade', () => {
  const snapshot = build({ missions: [] })
  assert.equal(only(snapshot).state, 'idle')
  assert.equal(only(snapshot).label, 'sem missão em andamento')
  assert.equal(snapshot.totals.activeMissions, 0)
})

test('a atividade de coordenação entra no snapshot e o pulso vivo a atualiza', () => {
  const activity = [
    {
      projectId: 'p1',
      missionId: 'm1',
      role: 'orchestrator',
      working: true,
      updatedAt: NOW,
      note: 'combinando o plano'
    }
  ]
  const snapshot = build({ coordinatorActivity: activity })
  assert.equal(only(snapshot).coordinators.length, 1)
  assert.equal(snapshot.totals.activeCoordinators, 1)

  const quiet = applyProgressCoordinatorActivity(
    snapshot,
    [{ ...activity[0], working: false }],
    2,
    NOW
  )
  assert.equal(quiet.projects[0].coordinators.length, 0)
  assert.equal(quiet.revision, 2)
})

test('o snapshot NÃO tem mais nenhuma superfície de card ou de plano mestre', () => {
  const snapshot = build({ integrationQueue: [ticket()] })
  const m = firstMission(snapshot)
  for (const dead of ['activeCards', 'progress']) {
    assert.equal(dead in m, false, `a missão ainda expõe "${dead}"`)
  }
  for (const dead of ['masterPlan', 'planUnavailable']) {
    assert.equal(dead in only(snapshot), false, `o projeto ainda expõe "${dead}"`)
  }
  assert.equal('activeCards' in snapshot.totals, false, 'os totais ainda contam cards')
})

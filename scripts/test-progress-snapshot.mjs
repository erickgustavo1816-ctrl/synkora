import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProgressCoordinatorActivity,
  buildProgressSnapshot
} from '../src/main/progressSnapshot.ts'

const NOW = '2026-08-01T15:00:00.000Z'

function project(id = 'p1', overrides = {}) {
  return {
    id,
    name: `Projeto ${id}`,
    path: `C:\\dev\\${id}`,
    createdAt: '2026-07-01T10:00:00.000Z',
    mode: 'existing',
    ...overrides
  }
}

function mission(id = 'm1', overrides = {}) {
  return {
    id,
    projectId: 'p1',
    title: `Missão ${id}`,
    status: 'ativa',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T14:00:00.000Z',
    ...overrides
  }
}

function task(id, overrides = {}) {
  return {
    id,
    projectId: 'p1',
    missionId: 'm1',
    department: 'back',
    type: 'feature',
    effort: 'leve',
    title: `Card ${id}`,
    description: '',
    status: 'backlog',
    origin: 'maestro',
    createdAt: '2026-08-01T11:00:00.000Z',
    updatedAt: '2026-08-01T14:00:00.000Z',
    ...overrides
  }
}

function plan(id = 'plan-1', overrides = {}) {
  return task(id, {
    kind: 'plan',
    title: 'Plano',
    status: 'execucao',
    plan: {
      summary: 'Plano da missão',
      lanes: [],
      expectedCards: 2,
      approvedAt: '2026-08-01T10:30:00.000Z'
    },
    ...overrides
  })
}

function queue(missionId, state, overrides = {}) {
  return {
    id: `ticket-${missionId}`,
    projectId: 'p1',
    missionId,
    sequence: 1,
    state,
    requestedAt: '2026-08-01T14:00:00.000Z',
    requestedBy: 'orchestrator',
    targetKind: 'base',
    attempts: 0,
    position: 1,
    total: 1,
    isHead: true,
    ...overrides
  }
}

function snapshot(overrides = {}) {
  return buildProgressSnapshot({
    projects: [project()],
    missions: [mission()],
    tasks: [],
    integrationQueue: [],
    now: NOW,
    revision: 7,
    ...overrides
  })
}

function firstMission(result) {
  return result.projects[0].activeMissions[0]
}

test('distingue implementação, revisão e QA usando a fase persistida', () => {
  for (const [activePhase, expected] of [
    ['dev', 'implementing'],
    ['review', 'reviewing'],
    ['qa', 'qa']
  ]) {
    const result = snapshot({
      tasks: [
        plan(),
        task('work-1', { planId: 'plan-1', status: 'execucao', activePhase, phaseState: 'running' }),
        task('work-2', { planId: 'plan-1', status: 'done' })
      ]
    })
    assert.equal(firstMission(result).state, expected)
    assert.deepEqual(firstMission(result).progress, { done: 1, total: 2, active: 1 })
    assert.equal(firstMission(result).activeCards[0].phase, activePhase)
  }
})

test('mostra a transição durável de um card aprovado sem fingir que o QA continua', () => {
  const result = snapshot({
    tasks: [
      plan(),
      task('work-1', {
        planId: 'plan-1',
        status: 'qa',
        activePhase: 'qa',
        phaseState: 'finalizing'
      })
    ]
  })
  assert.equal(firstMission(result).state, 'finalizing')
  assert.equal(firstMission(result).label, 'integrando card aprovado')
  assert.equal(firstMission(result).activeCards[0].phaseLabel, 'integrando o card aprovado')
})

test('interrupção pede atenção e bloqueio da fila tem prioridade máxima', () => {
  const interrupted = snapshot({
    tasks: [
      plan(),
      task('work-1', {
        planId: 'plan-1',
        status: 'qa',
        activePhase: 'qa',
        phaseState: 'interrupted'
      })
    ]
  })
  assert.equal(firstMission(interrupted).state, 'interrupted')
  assert.equal(interrupted.totals.attentionMissions, 1)

  const blocked = snapshot({
    tasks: [
      plan(),
      task('work-1', {
        planId: 'plan-1',
        status: 'qa',
        activePhase: 'qa',
        phaseState: 'interrupted'
      })
    ],
    integrationQueue: [queue('m1', 'blocked', {
      block: {
        code: 'conflict',
        owner: 'maestro',
        detail: 'conflito entre arquivos',
        at: NOW
      }
    })]
  })
  assert.equal(firstMission(blocked).state, 'blocked')
  assert.match(firstMission(blocked).detail, /Maestro/)
})

test('separa aprovação, pausa, finalização e pronto para integrar', () => {
  const awaiting = snapshot({ tasks: [plan('plan-1', {
    status: 'backlog',
    plan: { summary: 'x', lanes: [] }
  })] })
  assert.equal(firstMission(awaiting).state, 'awaiting_approval')
  assert.equal(awaiting.totals.attentionMissions, 1)

  const paused = snapshot({ tasks: [plan('plan-1', { status: 'backlog' })] })
  assert.equal(firstMission(paused).state, 'paused')

  const finalizing = snapshot({
    tasks: [plan(), task('work', { planId: 'plan-1', status: 'done' })]
  })
  assert.equal(firstMission(finalizing).state, 'finalizing')

  const ready = snapshot({
    tasks: [plan('plan-1', { status: 'done' }), task('work', { planId: 'plan-1', status: 'done' })]
  })
  assert.equal(firstMission(ready).state, 'ready_to_integrate')
  assert.equal(firstMission(ready).label, 'pronta para integrar')
})

test('radar mostra a verificação conjunta e sua reprovação sem fingir ociosidade', () => {
  const running = snapshot({
    tasks: [
      plan('plan-1', {
        plan: {
          summary: 'x',
          lanes: [],
          verification: { final: { status: 'running', commands: [] } }
        }
      }),
      task('work', { planId: 'plan-1', status: 'done' })
    ]
  })
  assert.equal(firstMission(running).state, 'finalizing')
  assert.equal(firstMission(running).label, 'verificando o resultado conjunto')

  const blocked = snapshot({
    tasks: [
      plan('plan-1', {
        plan: {
          summary: 'x',
          lanes: [],
          verification: {
            final: {
              status: 'failed',
              commands: [],
              comparison: { status: 'blocked', items: [] }
            }
          }
        }
      })
    ]
  })
  assert.equal(firstMission(blocked).state, 'interrupted')
  assert.equal(blocked.totals.attentionMissions, 1)
})

test('mantém os quatro estados reais da fila e sua posição', () => {
  const cases = [
    ['queued', 'queued'],
    ['sync_required', 'syncing'],
    ['merging', 'integrating']
  ]
  for (const [queueState, expected] of cases) {
    const ticket = queue('m1', queueState, {
      position: 2,
      total: 4,
      ...(queueState === 'sync_required'
        ? { block: { code: 'stale', owner: 'orchestrator', detail: 'base mudou', at: NOW } }
        : {})
    })
    const result = snapshot({ integrationQueue: [ticket] })
    assert.equal(firstMission(result).state, expected)
    assert.equal(firstMission(result).queue.position, 2)
    assert.equal(firstMission(result).queue.total, 4)
  }
})

test('plano novo não herda cards de um plano anterior', () => {
  const result = snapshot({
    tasks: [
      plan('old-plan', { status: 'done', createdAt: '2026-07-20T10:00:00.000Z' }),
      task('old-work', { planId: 'old-plan', status: 'done', createdAt: '2026-07-20T11:00:00.000Z' }),
      plan('new-plan', { status: 'execucao', createdAt: '2026-08-01T10:00:00.000Z' }),
      task('new-work', { planId: 'new-plan', status: 'execucao', activePhase: 'dev', phaseState: 'running' })
    ]
  })
  assert.deepEqual(firstMission(result).progress, { done: 0, total: 1, active: 1 })
})

test('se houver recuperação com dois planos abertos, usa o plano mais recente', () => {
  const result = snapshot({
    tasks: [
      plan('older-open', { status: 'execucao', createdAt: '2026-08-01T10:00:00.000Z' }),
      task('older-work', { planId: 'older-open', status: 'done' }),
      plan('newer-open', {
        status: 'backlog',
        createdAt: '2026-08-01T12:00:00.000Z',
        plan: { summary: 'novo', lanes: [] }
      })
    ]
  })
  assert.equal(firstMission(result).state, 'awaiting_approval')
  assert.deepEqual(firstMission(result).progress, { done: 0, total: 0, active: 0 })
})

test('ignora arquivadas, limita conclusões recentes e não trata cards prontos como missão concluída', () => {
  const missions = [
    mission('active'),
    mission('archived', { status: 'arquivada' }),
    ...Array.from({ length: 7 }, (_, index) => mission(`done-${index}`, {
      status: 'concluida',
      completedAt: new Date(Date.parse(NOW) - index * 60_000).toISOString()
    })),
    mission('old', {
      status: 'concluida',
      completedAt: '2026-06-01T10:00:00.000Z'
    })
  ]
  const result = snapshot({ missions })
  assert.equal(result.projects[0].activeMissions.length, 1)
  assert.equal(result.projects[0].recentCompletions.length, 5)
  assert.equal(result.projects[0].recentCompletions[0].id, 'done-0')
  assert.equal(result.projects[0].recentCompletions.some((item) => item.id === 'archived'), false)
  assert.equal(result.projects[0].recentCompletions.some((item) => item.id === 'old'), false)
})

test('plano mestre greenfield aparece sem despejar o roadmap inteiro', () => {
  const masterPlan = {
    schemaVersion: 2,
    origin: 'greenfield',
    status: 'in_progress',
    projectName: 'Novo produto',
    problem: 'x',
    audience: 'y',
    vision: 'z',
    successCriteria: [],
    constraints: [],
    scope: { in: [], out: [] },
    decisions: [],
    roadmapMeta: { complete: true },
    roadmap: [
      { id: 'a', title: 'A', objective: '', status: 'done', dependsOn: [], scope: { in: [], out: [] }, acceptanceCriteria: [], wave: { id: 'w1' }, createdAt: NOW, updatedAt: NOW },
      { id: 'b', title: 'B', objective: '', status: 'active', dependsOn: ['a'], scope: { in: [], out: [] }, acceptanceCriteria: [], wave: { id: 'w2' }, createdAt: NOW, updatedAt: NOW }
    ],
    planningSkills: [],
    activeItemIds: ['b'],
    readyItemIds: [],
    currentWaveId: 'w2',
    createdAt: NOW,
    updatedAt: NOW
  }
  const result = snapshot({
    projects: [project('p1', { mode: 'greenfield' })],
    missions: [],
    projectPlans: { p1: masterPlan }
  })
  assert.equal(result.projects[0].masterPlan.total, 2)
  assert.equal(result.projects[0].masterPlan.done, 1)
  assert.equal(result.projects[0].state, 'planning')
  assert.equal(JSON.stringify(result).includes('objective'), false)
})

test('trabalho avulso em execução não desaparece por não pertencer a uma missão', () => {
  const result = snapshot({
    missions: [],
    tasks: [
      task('general-done', { missionId: undefined, status: 'done' }),
      task('general-live', {
        missionId: undefined,
        status: 'execucao',
        activePhase: 'dev',
        phaseState: 'running'
      })
    ]
  })
  assert.equal(firstMission(result).kind, 'general')
  assert.equal(firstMission(result).title, 'Trabalho geral')
  assert.deepEqual(firstMission(result).progress, { done: 1, total: 2, active: 1 })
})

test('mostra Maestro e orquestrador trabalhando com descrições estruturadas', () => {
  const result = snapshot({
    tasks: [
      plan(),
      task('work-1', {
        planId: 'plan-1',
        status: 'execucao',
        activePhase: 'dev',
        phaseState: 'running'
      })
    ],
    coordinatorActivity: [
      {
        projectId: 'p1',
        role: 'maestro',
        working: true,
        updatedAt: NOW,
        outputTail: 'C:\\segredo\\nao-pode-vazar'
      },
      {
        projectId: 'p1',
        missionId: 'm1',
        role: 'orchestrator',
        working: true,
        updatedAt: NOW,
        transcript: 'prompt privado'
      },
      {
        projectId: 'p1',
        missionId: 'm1',
        role: 'orchestrator',
        working: false,
        updatedAt: NOW
      }
    ]
  })
  assert.equal(result.projects[0].coordinators.length, 2)
  assert.equal(result.projects[0].coordinators[0].roleLabel, 'Orquestrador')
  assert.match(result.projects[0].coordinators[0].label, /implementação/)
  assert.equal(result.projects[0].coordinators[1].roleLabel, 'Maestro')
  assert.equal(result.totals.activeCoordinators, 2)
  assert.equal(result.totals.activeCards, 1)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('segredo'), false)
  assert.equal(serialized.includes('prompt privado'), false)
})

test('prévia detalhada limita seis cards e informa quantos continuam ativos', () => {
  // teto 4→6 em 2026-08-06 (radar detalhado: "preciso ver tudo o que está
  // acontecendo") — acima de 6 ainda vira o contador "+N".
  const result = snapshot({
    tasks: [
      plan(),
      ...Array.from({ length: 8 }, (_, index) => task(`parallel-${index}`, {
        planId: 'plan-1',
        status: 'execucao',
        activePhase: index % 2 === 0 ? 'dev' : 'review',
        phaseState: 'running'
      }))
    ]
  })
  assert.equal(firstMission(result).activeCards.length, 6)
  assert.equal(firstMission(result).progress.active, 8)
  assert.equal(result.totals.activeCards, 8)
})

test('pulso vivo muda coordenação para aguardando sem reconstruir dados do projeto', () => {
  const working = snapshot({
    missions: [],
    coordinatorActivity: [{
      projectId: 'p1',
      role: 'maestro',
      working: true,
      updatedAt: NOW
    }]
  })
  assert.equal(working.projects[0].state, 'running')
  assert.equal(working.totals.activeCoordinators, 1)

  const waiting = applyProgressCoordinatorActivity(
    working,
    [{
      projectId: 'p1',
      role: 'maestro',
      working: false,
      updatedAt: NOW
    }],
    8,
    NOW
  )
  assert.equal(waiting.revision, 8)
  assert.equal(waiting.projects[0].state, 'idle')
  assert.deepEqual(waiting.projects[0].coordinators, [])
  assert.equal(waiting.totals.activeCoordinators, 0)
  assert.equal(waiting.totals.projects, working.totals.projects)
})

test('projeto ausente sobe para o topo e o snapshot não expõe caminhos nem briefings', () => {
  const result = snapshot({
    projects: [project('healthy'), project('missing')],
    missions: [],
    tasks: [task('secret', { projectId: 'healthy', briefing: 'segredo', missionId: undefined })],
    missingProjectIds: ['missing']
  })
  assert.equal(result.projects[0].id, 'missing')
  assert.equal(result.projects[0].state, 'attention')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('C:\\dev'), false)
  assert.equal(serialized.includes('segredo'), false)
})

test('totais contam todos os projetos que precisam de atencao', () => {
  const result = snapshot({
    projects: [project('missing'), project('revision'), project('healthy')],
    missions: [],
    projectPlans: {
      revision: {
        status: 'revision_pending',
        roadmap: [],
        activeItemIds: [],
        readyItemIds: [],
        createdAt: NOW,
        updatedAt: NOW
      }
    },
    missingProjectIds: ['missing']
  })

  assert.equal(result.projects.filter((item) => item.state === 'attention').length, 2)
  assert.equal(result.totals.attentionProjects, 2)
})

test('aprovação de publicação e falha de leitura do plano ficam visíveis', () => {
  const result = snapshot({
    projects: [project('release'), project('broken')],
    missions: [],
    projectPlans: {
      release: {
        status: 'awaiting_release',
        roadmap: [],
        activeItemIds: [],
        readyItemIds: [],
        createdAt: NOW,
        updatedAt: NOW
      }
    },
    planUnavailableProjectIds: ['broken']
  })

  assert.equal(result.totals.attentionProjects, 2)
  assert.match(result.projects.find((item) => item.id === 'release').label, /aprova|public/i)
  assert.match(result.projects.find((item) => item.id === 'broken').label, /ler|plano/i)
})

test('previa prioriza card interrompido antes de aplicar o limite de seis', () => {
  const result = snapshot({
    tasks: [
      plan(),
      ...Array.from({ length: 7 }, (_, index) => task(`running-${index}`, {
        planId: 'plan-1',
        status: 'execucao',
        activePhase: 'dev',
        phaseState: 'running'
      })),
      task('interrupted', {
        planId: 'plan-1',
        status: 'execucao',
        activePhase: 'review',
        phaseState: 'interrupted'
      })
    ]
  })

  assert.equal(firstMission(result).activeCards.length, 6)
  assert.equal(firstMission(result).activeCards[0].id, 'interrupted')
  assert.equal(firstMission(result).activeCards[0].interrupted, true)
})

test('fase pendente comunica preparacao sem afirmar que a execucao comecou', () => {
  const result = snapshot({
    tasks: [
      plan(),
      task('pending', {
        planId: 'plan-1',
        status: 'execucao',
        activePhase: 'dev',
        phaseState: 'pending'
      })
    ]
  })
  const current = firstMission(result)
  const card = current.activeCards[0]

  assert.match(card.phaseLabel, /prepar/i)
  assert.notEqual(card.phaseLabel, 'implementando')
  assert.match(current.label, /prepar/i)
  assert.notEqual(current.label, 'implementando')
})

test('orquestrador aguarda a decisao do Maestro quando o bloqueio pertence a ele', () => {
  const result = snapshot({
    integrationQueue: [queue('m1', 'blocked', {
      block: {
        code: 'conflict',
        owner: 'maestro',
        detail: 'texto bruto do conflito',
        at: NOW
      }
    })],
    coordinatorActivity: [{
      projectId: 'p1',
      missionId: 'm1',
      role: 'orchestrator',
      working: true,
      updatedAt: NOW
    }]
  })
  const coordinator = result.projects[0].coordinators[0]
  const description = `${coordinator.label} ${coordinator.detail ?? ''}`

  assert.match(description, /acompanh|aguard/i)
  assert.match(description, /Maestro/i)
  assert.doesNotMatch(description, /reparando|resolvendo/i)
})

test('atividade de estudo e conversa recebe descricao especifica sem expor texto bruto', () => {
  const result = snapshot({
    projects: [project('survey'), project('conversation')],
    missions: [],
    coordinatorActivity: [
      {
        projectId: 'survey',
        role: 'maestro',
        kind: 'survey',
        working: true,
        updatedAt: NOW,
        outputTail: 'RAW_SURVEY_SHOULD_NOT_LEAK'
      },
      {
        projectId: 'conversation',
        role: 'maestro',
        kind: 'conversation',
        working: true,
        updatedAt: NOW,
        transcript: 'RAW_CONVERSATION_SHOULD_NOT_LEAK'
      }
    ]
  })
  const surveyProject = result.projects.find((item) => item.id === 'survey')
  const conversationProject = result.projects.find((item) => item.id === 'conversation')
  const surveyCopy = `${surveyProject.coordinators[0].label} ${surveyProject.coordinators[0].detail ?? ''}`
  const conversationCopy = `${conversationProject.coordinators[0].label} ${conversationProject.coordinators[0].detail ?? ''}`

  assert.match(surveyCopy, /estud|mape|dossi/i)
  assert.match(conversationCopy, /convers|respond|atend/i)
  assert.notEqual(surveyCopy, conversationCopy)

  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('RAW_SURVEY_SHOULD_NOT_LEAK'), false)
  assert.equal(serialized.includes('RAW_CONVERSATION_SHOULD_NOT_LEAK'), false)
})

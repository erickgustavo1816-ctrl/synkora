import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  ProjectPlanError,
  approveProjectPlan,
  completeProjectPlanRelease,
  completeProjectMission,
  deferProjectMission,
  detachProjectMission,
  ensureGreenfieldProjectPlan,
  isEffectivelyEmptyProject,
  loadProjectPlan,
  projectPlanReleaseBlockers,
  projectPlanReleaseGate,
  projectPlanExecutionWindow,
  projectPlanPaths,
  reactivateProjectMission,
  recordProjectPlanningSkillUse,
  renderProjectPlanMarkdown,
  saveProjectPlanDraft,
  startProjectMission,
  summarizeProjectPlanForBoard
} from '../src/main/projectPlan.ts'

const T0 = '2026-07-31T10:00:00.000Z'
const T1 = '2026-07-31T11:00:00.000Z'
const T2 = '2026-07-31T12:00:00.000Z'
const T3 = '2026-07-31T13:00:00.000Z'
const T4 = '2026-07-31T14:00:00.000Z'

function temporaryProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-project-plan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function roadmap() {
  return [
    {
      id: 'foundation',
      title: 'Construir fundação',
      objective: 'Preparar a base técnica e os contratos do produto.',
      scope: {
        in: ['Arquitetura mínima', 'Contratos principais'],
        out: ['Polimento visual']
      },
      acceptanceCriteria: ['Base executa localmente', 'Contratos estão documentados'],
      version: {
        name: 'V1.0',
        theme: 'MVP',
        goal: 'Validar o fluxo central'
      }
    },
    {
      id: 'experience',
      title: 'Entregar experiência principal',
      objective: 'Construir o primeiro fluxo completo para o usuário.',
      dependsOn: ['foundation'],
      scope: {
        in: ['Fluxo principal'],
        out: ['Casos avançados']
      },
      acceptanceCriteria: ['Pessoa conclui o fluxo sem ajuda'],
      version: { name: 'V1.0' }
    }
  ]
}

function saveValidDraft(root, overrides = {}) {
  const plannedRoadmap = overrides.roadmap ?? roadmap()
  return saveProjectPlanDraft(root, {
    projectName: 'Projeto Aurora',
    problem: 'Hoje a pessoa não sabe qual é a próxima etapa do trabalho.',
    audience: 'Pessoas criando um produto digital do zero.',
    vision: 'Permitir que a pessoa conclua o fluxo central sem se perder.',
    successCriteria: ['Fluxo principal utilizável', 'Estado sempre visível'],
    constraints: ['Uma onda ativa por vez', 'Preservar decisões já aprovadas'],
    scope: {
      in: ['Experiência principal'],
      out: ['Integrações avançadas']
    },
    decisions: ['Paralelizar somente missões da mesma onda'],
    roadmapMeta: {
      expectedCount: plannedRoadmap.length,
      complete: true
    },
    roadmap: plannedRoadmap,
    now: T0,
    ...overrides
  })
}

function approvedProject(t) {
  const root = temporaryProject(t)
  saveValidDraft(root)
  approveProjectPlan(root, T1)
  return root
}

function hasCode(code) {
  return (error) => error instanceof ProjectPlanError && error.code === code
}

test('reconhece uma pasta efetivamente vazia e ignora somente metadados conhecidos', (t) => {
  const root = temporaryProject(t)
  for (const entry of ['.git', '.synkora', '.agents', '.claude', '.codex']) {
    mkdirSync(join(root, entry), { recursive: true })
    writeFileSync(join(root, entry, 'metadata'), 'não é implementação', 'utf8')
  }
  writeFileSync(join(root, '.DS_Store'), '', 'utf8')
  writeFileSync(join(root, 'desktop.ini'), '', 'utf8')

  assert.equal(isEffectivelyEmptyProject(root), true)
  writeFileSync(join(root, 'README.md'), '# produto', 'utf8')
  assert.equal(isEffectivelyEmptyProject(root), false)
  assert.equal(isEffectivelyEmptyProject(join(root, 'ainda-nao-existe')), true)
})

test('ensure cria uma única vez o JSON autoritativo e o MD legível para projeto novo', (t) => {
  const root = temporaryProject(t)
  const first = ensureGreenfieldProjectPlan(root, {
    projectName: 'Aurora',
    now: T0
  })
  const paths = projectPlanPaths(root)

  assert.equal(first.greenfield, true)
  assert.equal(first.created, true)
  assert.equal(first.plan?.status, 'draft')
  assert.equal(first.plan?.projectName, 'Aurora')
  assert.equal(existsSync(paths.json), true)
  assert.equal(existsSync(paths.markdown), true)
  assert.match(readFileSync(paths.markdown, 'utf8'), /Plano mestre/)

  const second = ensureGreenfieldProjectPlan(root, {
    projectName: 'Nome que não deve sobrescrever',
    now: T1
  })
  assert.equal(second.created, false)
  assert.equal(second.plan?.projectName, 'Aurora')
  assert.equal(second.plan?.createdAt, T0)
})

test('ensure não transforma silenciosamente um projeto existente em greenfield', (t) => {
  const root = temporaryProject(t)
  writeFileSync(join(root, 'package.json'), '{}', 'utf8')

  const result = ensureGreenfieldProjectPlan(root, { now: T0 })

  assert.deepEqual(result, { greenfield: false, created: false })
  assert.equal(existsSync(projectPlanPaths(root).directory), false)
  assert.throws(
    () =>
      saveValidDraft(root, {
        now: T1
      }),
    hasCode('not_greenfield')
  )
})

test('descoberta parcial atualiza o MD por etapas sem apagar decisões anteriores', (t) => {
  const root = temporaryProject(t)
  ensureGreenfieldProjectPlan(root, { projectName: 'Aurora', now: T0 })

  const firstRound = saveProjectPlanDraft(root, {
    problem: 'A pessoa se perde entre muitas etapas.',
    decisions: ['O mapa sempre mostrará a próxima ação.'],
    now: T1
  })
  assert.equal(firstRound.problem, 'A pessoa se perde entre muitas etapas.')
  assert.equal(firstRound.audience, '')
  assert.equal(firstRound.roadmap.length, 0)

  const secondRound = saveProjectPlanDraft(root, {
    audience: 'Pessoas criando seu primeiro produto.',
    now: T2
  })
  assert.equal(secondRound.problem, 'A pessoa se perde entre muitas etapas.')
  assert.equal(secondRound.audience, 'Pessoas criando seu primeiro produto.')
  assert.deepEqual(secondRound.decisions, ['O mapa sempre mostrará a próxima ação.'])
  assert.match(readFileSync(projectPlanPaths(root).markdown, 'utf8'), /conte ao Maestro/)
})

test('listas parciais acumulam decisões e só são apagadas com replace explícito', (t) => {
  const root = temporaryProject(t)
  ensureGreenfieldProjectPlan(root, { now: T0 })
  saveProjectPlanDraft(root, {
    successCriteria: ['Critério A'],
    constraints: ['Limite A'],
    scope: { in: ['Escopo A'], out: ['Fora A'] },
    decisions: ['Decisão A'],
    now: T1
  })

  const merged = saveProjectPlanDraft(root, {
    successCriteria: ['Critério B'],
    constraints: ['Limite B'],
    scope: { in: ['Escopo B'], out: ['Fora B'] },
    decisions: ['Decisão B'],
    now: T2
  })
  assert.deepEqual(merged.successCriteria, ['Critério A', 'Critério B'])
  assert.deepEqual(merged.constraints, ['Limite A', 'Limite B'])
  assert.deepEqual(merged.scope, {
    in: ['Escopo A', 'Escopo B'],
    out: ['Fora A', 'Fora B']
  })
  assert.deepEqual(merged.decisions, ['Decisão A', 'Decisão B'])

  const replaced = saveProjectPlanDraft(root, {
    listMode: 'replace',
    decisions: ['Decisão final'],
    scope: { out: [] },
    now: T3
  })
  assert.deepEqual(replaced.decisions, ['Decisão final'])
  assert.deepEqual(replaced.scope.in, ['Escopo A', 'Escopo B'])
  assert.deepEqual(replaced.scope.out, [])
})

test('rascunho é persistido, normalizado e ainda não libera uma missão antes da aprovação', (t) => {
  const root = temporaryProject(t)
  const plan = saveProjectPlanDraft(root, {
    projectName: '  Aurora  ',
    problem: '  O fluxo atual desorienta a pessoa.  ',
    audience: '  Criadores de produtos digitais.  ',
    vision: '  Uma visão clara  ',
    successCriteria: ['  Funciona  ', 'Funciona', '  '],
    constraints: ['  Uma missão por vez  ', 'Uma missão por vez'],
    scope: { in: ['  MVP  '], out: [' Escala global '] },
    decisions: ['  Simples primeiro  '],
    roadmap: [
      {
        id: '  m1 ',
        title: ' Base ',
        objective: ' Criar base ',
        dependsOn: [],
        scope: { in: ['  Fundação  '], out: ['  Polimento  '] },
        acceptanceCriteria: ['  Base validada  ', 'Base validada'],
        version: {
          id: '  version-1  ',
          name: '  V1.0  ',
          theme: '  MVP  ',
          goal: '  Validar o essencial  '
        }
      }
    ],
    now: T0
  })

  assert.equal(plan.status, 'draft')
  assert.equal(plan.projectName, 'Aurora')
  assert.equal(plan.problem, 'O fluxo atual desorienta a pessoa.')
  assert.equal(plan.audience, 'Criadores de produtos digitais.')
  assert.equal(plan.vision, 'Uma visão clara')
  assert.deepEqual(plan.successCriteria, ['Funciona'])
  assert.deepEqual(plan.constraints, ['Uma missão por vez'])
  assert.deepEqual(plan.scope, { in: ['MVP'], out: ['Escala global'] })
  assert.equal(plan.roadmap[0].id, 'm1')
  assert.deepEqual(plan.roadmap[0].scope, {
    in: ['Fundação'],
    out: ['Polimento']
  })
  assert.deepEqual(plan.roadmap[0].acceptanceCriteria, ['Base validada'])
  assert.deepEqual(plan.roadmap[0].version, {
    id: 'version-1',
    name: 'V1.0',
    theme: 'MVP',
    goal: 'Validar o essencial'
  })
  assert.equal(plan.nextItemId, undefined)
  assert.deepEqual(loadProjectPlan(root), plan)
})

test('aprovação exige visão, critério de sucesso e roadmap', (t) => {
  const root = temporaryProject(t)
  ensureGreenfieldProjectPlan(root, { now: T0 })

  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.equal(error instanceof ProjectPlanError, true)
    assert.equal(error.code, 'invalid_plan')
    assert.match(error.message, /problema/)
    assert.match(error.message, /para quem/)
    assert.match(error.message, /visão/)
    assert.match(error.message, /critério/)
    assert.match(error.message, /roadmap/)
    return true
  })

})

test('aprovação não pula escopo, limites, não-objetivos nem decisões da etapa 2/3', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    constraints: [],
    scope: { in: [], out: [] },
    decisions: []
  })

  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.equal(error instanceof ProjectPlanError, true)
    assert.equal(error.code, 'invalid_plan')
    assert.match(error.message, /limites\/restrições/)
    assert.match(error.message, /primeiro escopo/)
    assert.match(error.message, /não-objetivo/)
    assert.match(error.message, /decisões de produto\/arquitetura/)
    return true
  })
})

test('aprova um plano completo e indica a primeira missão sem dependências', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root)

  const plan = approveProjectPlan(root, T1)

  assert.equal(plan.status, 'approved')
  assert.equal(plan.approvedAt, T1)
  assert.equal(plan.nextItemId, 'foundation')
  assert.match(readFileSync(projectPlanPaths(root).markdown, 'utf8'), /Construir fundação/)
})

test('aprovação exige critério de aceite em cada missão planejada', (t) => {
  const root = temporaryProject(t)
  const draft = saveValidDraft(root, {
    roadmap: [
      {
        ...roadmap()[0],
        acceptanceCriteria: []
      }
    ]
  })
  assert.match(summarizeProjectPlanForBoard(draft), /4\/5/)
  assert.match(summarizeProjectPlanForBoard(draft), /critério de aceite/)

  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.equal(error instanceof ProjectPlanError, true)
    assert.equal(error.code, 'invalid_plan')
    assert.match(error.message, /critério de aceite.*foundation/)
    return true
  })
})

test('aprovação exige uma versão-alvo para cada missão futura', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    roadmap: [{ ...roadmap()[0], version: undefined }]
  })
  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.equal(error instanceof ProjectPlanError, true)
    assert.equal(error.code, 'invalid_plan')
    assert.match(error.message, /versão-alvo.*foundation/)
    return true
  })
})

test('rejeita dependências inexistentes, duplicadas e cíclicas', (t) => {
  const root = temporaryProject(t)
  assert.throws(
    () =>
      saveValidDraft(root, {
        roadmap: [
          {
            id: 'a',
            title: 'A',
            objective: 'A',
            dependsOn: ['inexistente']
          }
        ]
      }),
    hasCode('invalid_plan')
  )

  assert.throws(
    () =>
      saveValidDraft(root, {
        roadmap: [
          { id: 'a', title: 'A', objective: 'A' },
          { id: 'a', title: 'Outra A', objective: 'Outra A' }
        ]
      }),
    hasCode('invalid_plan')
  )

  assert.throws(
    () =>
      saveValidDraft(root, {
        roadmap: [
          { id: 'a', title: 'A', objective: 'A', dependsOn: ['b'] },
          { id: 'b', title: 'B', objective: 'B', dependsOn: ['a'] }
        ]
      }),
    hasCode('invalid_plan')
  )
})

test('start exige aprovação, respeita dependências e mantém ondas seriais por padrão', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root)

  assert.throws(
    () => startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T1 }),
    hasCode('approval_required')
  )

  approveProjectPlan(root, T1)
  assert.throws(
    () => startProjectMission(root, { itemId: 'experience', missionId: 'mission-2', now: T2 }),
    hasCode('item_not_planned')
  )

  const started = startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    now: T2
  })
  assert.equal(started.status, 'in_progress')
  assert.equal(started.activeItemId, 'foundation')
  assert.equal(started.roadmap[0].missionId, 'mission-1')
  assert.throws(
    () => startProjectMission(root, { itemId: 'experience', missionId: 'mission-2', now: T3 }),
    hasCode('item_not_planned')
  )
})

test('start respeita a ordem indicada mesmo entre missões independentes', (t) => {
  const root = temporaryProject(t)
  const independent = roadmap().map((item) => ({ ...item, dependsOn: [] }))
  saveValidDraft(root, { roadmap: independent })
  approveProjectPlan(root, T1)

  assert.throws(
    () => startProjectMission(root, { itemId: 'experience', missionId: 'mission-2', now: T2 }),
    hasCode('item_not_planned')
  )
  const first = startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    now: T2
  })
  assert.equal(first.activeItemId, 'foundation')
})

test('start é idempotente por missionId e impede reutilização em outro item', (t) => {
  const root = approvedProject(t)
  const first = startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    now: T2
  })
  const before = readFileSync(projectPlanPaths(root).json, 'utf8')

  const repeated = startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    now: T4
  })

  assert.deepEqual(repeated, first)
  assert.equal(readFileSync(projectPlanPaths(root).json, 'utf8'), before)
  assert.throws(
    () => startProjectMission(root, { itemId: 'experience', missionId: 'mission-1', now: T4 }),
    hasCode('mission_id_conflict')
  )
})

test('novo rascunho nunca apaga nem reescreve itens ativos ou concluídos pelo mesmo id', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })

  const whileActive = saveValidDraft(root, {
    vision: 'Visão revisada durante a execução.',
    roadmap: [
      {
        id: 'foundation',
        title: 'Tentativa de trocar o título ativo',
        objective: 'Tentativa de trocar o objetivo ativo.',
        scope: { in: ['Escopo indevido'], out: [] },
        acceptanceCriteria: ['Critério indevido'],
        version: { name: 'V9.9' }
      },
      roadmap()[1]
    ],
    now: T3
  })
  assert.equal(whileActive.status, 'revision_pending')
  assert.equal(whileActive.roadmap[0].title, 'Construir fundação')
  assert.equal(whileActive.roadmap[0].missionId, 'mission-1')
  assert.deepEqual(whileActive.roadmap[0].scope.in, [
    'Arquitetura mínima',
    'Contratos principais'
  ])
  assert.deepEqual(whileActive.roadmap[0].acceptanceCriteria, [
    'Base executa localmente',
    'Contratos estão documentados'
  ])
  assert.equal(whileActive.roadmap[0].version?.name, 'V1.0')

  completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Base entregue e validada.',
    now: T4
  })
  const afterDone = saveValidDraft(root, {
    roadmap: [roadmap()[1]],
    now: '2026-07-31T15:00:00.000Z'
  })
  const preserved = afterDone.roadmap.find((item) => item.id === 'foundation')

  assert.equal(afterDone.status, 'draft')
  assert.equal(afterDone.roadmap[0].id, 'foundation')
  assert.equal(preserved?.status, 'done')
  assert.equal(preserved?.missionId, 'mission-1')
  assert.equal(preserved?.outcome, 'Base entregue e validada.')
})

test('patch parcial do roadmap preserva missões futuras omitidas por padrão', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root)

  const merged = saveProjectPlanDraft(root, {
    roadmap: [
      {
        ...roadmap()[0],
        title: 'Construir fundação revisada'
      }
    ],
    now: T1
  })

  assert.deepEqual(
    merged.roadmap.map((item) => item.id),
    ['foundation', 'experience']
  )
  assert.equal(merged.roadmap[0].title, 'Construir fundação revisada')
  assert.equal(merged.roadmap[1].title, 'Entregar experiência principal')
})

test('merge parcial dentro da missão preserva dependências, escopo e versão omitidos', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root)

  const merged = saveProjectPlanDraft(root, {
    roadmap: [
      {
        id: 'experience',
        title: 'Entregar experiência refinada',
        objective: 'Refinar somente o objetivo desta missão.',
        acceptanceCriteria: ['Fluxo refinado validado']
      }
    ],
    now: T1
  })
  const item = merged.roadmap.find((candidate) => candidate.id === 'experience')
  assert.deepEqual(item?.dependsOn, ['foundation'])
  assert.deepEqual(item?.scope, {
    in: ['Fluxo principal'],
    out: ['Casos avançados']
  })
  assert.deepEqual(item?.version, { name: 'V1.0' })
  assert.deepEqual(item?.acceptanceCriteria, ['Fluxo refinado validado'])
})

test('mover missão futura para outra versão limpa o id antigo e preserva os demais detalhes', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    roadmap: [
      {
        ...roadmap()[0],
        version: { id: 'version-1', name: 'V1.0', theme: 'Base', goal: 'Fundar o produto' }
      },
      roadmap()[1]
    ]
  })

  const merged = saveProjectPlanDraft(root, {
    roadmap: [
      {
        ...roadmap()[0],
        version: { id: 'version-1', name: 'V1.1' }
      }
    ],
    now: T1
  })

  assert.deepEqual(merged.roadmap[0].version, {
    name: 'V1.1',
    theme: 'Base',
    goal: 'Fundar o produto'
  })
})

test('replace remove só o futuro sem vínculo e preserva toda missão real omitida', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  deferProjectMission(root, { itemId: 'foundation', reason: 'Pausa segura.', now: T3 })

  const replaced = saveProjectPlanDraft(root, {
    roadmapMode: 'replace',
    roadmap: [roadmap()[1]],
    now: T4
  })

  assert.deepEqual(
    replaced.roadmap.map((item) => item.id),
    ['foundation', 'experience']
  )
  assert.equal(replaced.roadmap[0].status, 'deferred')
  assert.equal(replaced.roadmap[0].missionId, 'mission-1')
  assert.equal(replaced.roadmap[0].title, 'Construir fundação')

  const cleanRoot = temporaryProject(t)
  saveValidDraft(cleanRoot)
  const cleanReplace = saveProjectPlanDraft(cleanRoot, {
    roadmapMode: 'replace',
    roadmap: [roadmap()[0]],
    now: T1
  })
  assert.deepEqual(cleanReplace.roadmap.map((item) => item.id), ['foundation'])
})

test('revisão durante missão ativa exige novo aval e segura a próxima missão', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })

  const revised = saveProjectPlanDraft(root, {
    vision: 'Visão refinada enquanto a fundação é executada.',
    now: T3
  })
  assert.equal(revised.status, 'revision_pending')
  assert.equal(revised.activeItemId, 'foundation')

  const completed = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Fundação entregue com a revisão registrada.',
    now: T4
  })
  assert.equal(completed.status, 'revision_pending')
  assert.equal(completed.nextItemId, undefined)
  assert.throws(
    () => startProjectMission(root, { itemId: 'experience', missionId: 'mission-2' }),
    hasCode('approval_required')
  )

  const approved = approveProjectPlan(root, '2026-07-31T15:00:00.000Z')
  assert.equal(approved.status, 'in_progress')
  assert.equal(approved.nextItemId, 'experience')
  const next = startProjectMission(root, {
    itemId: 'experience',
    missionId: 'mission-2',
    now: '2026-07-31T16:00:00.000Z'
  })
  assert.equal(next.activeItemId, 'experience')
})

test('revisão pendente da última missão só encerra o roadmap depois do novo aval', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { roadmap: [roadmap()[0]] })
  approveProjectPlan(root, T1)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  saveProjectPlanDraft(root, { vision: 'Visão final revisada.', now: T3 })

  const waiting = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'A única missão foi entregue.',
    now: T4
  })
  assert.equal(waiting.status, 'revision_pending')
  assert.equal(waiting.completedAt, undefined)

  const done = approveProjectPlan(root, '2026-07-31T15:00:00.000Z')
  assert.equal(done.status, 'done')
  assert.equal(done.completedAt, '2026-07-31T15:00:00.000Z')
})

test('aprovar uma revisão enquanto a primeira missão está ativa mantém execução', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  saveProjectPlanDraft(root, { vision: 'Visão revisada com a missão ativa.', now: T3 })

  const approved = approveProjectPlan(root, T4)
  assert.equal(approved.status, 'in_progress')
  assert.equal(approved.activeItemId, 'foundation')
})

test('última missão aguarda a versão subir antes de declarar o projeto concluído', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { roadmap: [roadmap()[0]] })
  approveProjectPlan(root, T1)
  startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    release: { versionId: 'version-1', versionName: 'V1.0' },
    now: T2
  })
  const integrated = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Missão integrada na branch da versão.',
    now: T3
  })
  assert.equal(integrated.status, 'awaiting_release')
  assert.equal(integrated.completedAt, undefined)
  assert.match(renderProjectPlanMarkdown(integrated), /aguardando subir para a base/)

  const unrelated = completeProjectPlanRelease(root, { versionId: 'outra', now: T4 })
  assert.equal(unrelated.status, 'awaiting_release')
  const released = completeProjectPlanRelease(root, {
    versionId: 'version-1',
    now: '2026-07-31T15:00:00.000Z'
  })
  assert.equal(released.status, 'done')
  assert.equal(released.completedAt, '2026-07-31T15:00:00.000Z')
})

test('publicar versão não aprova silenciosamente uma revisão feita após as missões', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { roadmap: [roadmap()[0]] })
  approveProjectPlan(root, T1)
  startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    release: { versionId: 'version-1', versionName: 'V1.0' },
    now: T2
  })
  completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Missão integrada.',
    now: T3
  })
  const revised = saveProjectPlanDraft(root, {
    vision: 'Visão revisada antes da publicação.',
    now: T4
  })
  assert.equal(revised.status, 'draft')

  const released = completeProjectPlanRelease(root, {
    versionId: 'version-1',
    now: '2026-07-31T15:00:00.000Z'
  })
  assert.equal(released.status, 'draft')
  assert.equal(released.completedAt, undefined)

  const approved = approveProjectPlan(root, '2026-07-31T16:00:00.000Z')
  assert.equal(approved.status, 'done')
})

test('uma versão não pode subir enquanto ainda contém missão futura no roadmap', (t) => {
  const root = approvedProject(t)
  const plan = loadProjectPlan(root)
  assert.ok(plan)

  const blockers = projectPlanReleaseBlockers(plan, {
    versionId: 'version-1',
    versionName: 'V1.0'
  })
  assert.deepEqual(
    blockers.map((item) => item.id),
    ['foundation', 'experience']
  )

  const otherVersion = projectPlanReleaseBlockers(plan, {
    versionId: 'version-2',
    versionName: 'V2.0'
  })
  assert.deepEqual(otherVersion, [])
})

test('troca de bloco exige publicar a versão anterior antes de indicar a próxima missão', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    roadmap: [
      roadmap()[0],
      { ...roadmap()[1], version: { name: 'V2.0' } }
    ]
  })
  approveProjectPlan(root, T1)
  startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    release: { versionId: 'version-1', versionName: 'V1.0' },
    now: T2
  })

  const boundary = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'V1 integrada na branch de versão.',
    now: T3
  })
  assert.equal(boundary.status, 'in_progress')
  assert.equal(boundary.nextItemId, undefined)
  assert.deepEqual(projectPlanReleaseGate(boundary), {
    versionId: 'version-1',
    versionName: 'V1.0'
  })
  assert.match(renderProjectPlanMarkdown(boundary), /bloqueadas até publicar \*\*V1\.0\*\*/)
  const boardSummary = summarizeProjectPlanForBoard(boundary)
  assert.match(boardSummary, /Etapa do fluxo: transição de versão/)
  assert.match(boardSummary, /bloqueadas até publicar V1\.0/)
  assert.throws(
    () =>
      startProjectMission(root, {
        itemId: 'experience',
        missionId: 'mission-2',
        release: { versionId: 'version-2', versionName: 'V2.0' }
      }),
    hasCode('release_required')
  )

  const released = completeProjectPlanRelease(root, { versionId: 'version-1', now: T4 })
  assert.equal(projectPlanReleaseGate(released), undefined)
  assert.equal(released.nextItemId, 'experience')
})

test('missão adicionada depois continua na mesma versão quando só o item concluído tem id', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { roadmap: [roadmap()[0]] })
  approveProjectPlan(root, T1)
  startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    release: { versionId: 'version-1', versionName: 'V1.0' },
    now: T2
  })
  completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Primeiro lote integrado.',
    now: T3
  })
  saveProjectPlanDraft(root, {
    roadmapMeta: { expectedCount: 2, complete: true },
    roadmap: [roadmap()[1]],
    now: T4
  })

  const approved = approveProjectPlan(root, '2026-07-31T15:00:00.000Z')
  assert.equal(projectPlanReleaseGate(approved), undefined)
  assert.equal(approved.nextItemId, 'experience')
  const started = startProjectMission(root, {
    itemId: 'experience',
    missionId: 'mission-2',
    release: { versionId: 'version-1', versionName: 'V1.0' },
    now: '2026-07-31T16:00:00.000Z'
  })
  assert.equal(started.activeItemId, 'experience')
})

test('aprovação recusa roadmap que sai de uma versão e volta a ela depois', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    roadmap: [
      roadmap()[0],
      { ...roadmap()[1], version: { name: 'V2.0' } },
      {
        id: 'return-to-v1',
        title: 'Voltar para a versão anterior',
        objective: 'Expor a ordem ambígua.',
        dependsOn: ['experience'],
        scope: { in: ['Fluxo legado'], out: ['Novo produto'] },
        acceptanceCriteria: ['Ordem revisada'],
        version: { name: 'V1.0' }
      }
    ]
  })

  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /bloco contínuo/)
    return true
  })
})

test('aprovação exige que toda dependência apareça antes da missão dependente', (t) => {
  const root = temporaryProject(t)
  const [foundation, experience] = roadmap()
  saveValidDraft(root, {
    roadmap: [
      { ...foundation, dependsOn: ['experience'] },
      { ...experience, dependsOn: [] }
    ]
  })

  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /ordene experience antes de foundation/)
    return true
  })
})

test('missão adiada pausa o roteiro no próprio ponto e não deixa pular para a seguinte', (t) => {
  const root = temporaryProject(t)
  const independent = roadmap().map((item) => ({ ...item, dependsOn: [] }))
  saveValidDraft(root, { roadmap: independent })
  approveProjectPlan(root, T1)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })

  const paused = deferProjectMission(root, {
    itemId: 'foundation',
    reason: 'Aguardar decisão do usuário.',
    now: T3
  })
  assert.equal(paused.nextItemId, undefined)
  const pausedSummary = summarizeProjectPlanForBoard(paused)
  assert.match(pausedSummary, /Etapa do fluxo: roteiro pausado/)
  assert.match(pausedSummary, /onda pausada em Construir fundação/)
  assert.match(pausedSummary, /deve ser retomada ou retirada/)
  assert.throws(
    () =>
      saveProjectPlanDraft(root, {
        roadmapMode: 'replace',
        roadmap: [
          {
            id: 'inserted-before',
            title: 'Trabalho inserido antes',
            objective: 'Tentar envelhecer a branch arquivada.',
            scope: { in: ['Nova base'], out: ['Missão arquivada'] },
            acceptanceCriteria: ['Ordem segura'],
            version: { name: 'V1.0' }
          },
          ...independent
        ],
        now: T4
      }),
    (error) => {
      assert.ok(hasCode('invalid_plan')(error))
      assert.match(error.message, /preserva sua posição/)
      return true
    }
  )
  assert.deepEqual(loadProjectPlan(root)?.roadmap.map((item) => item.id), [
    'foundation',
    'experience'
  ])
  assert.throws(
    () => startProjectMission(root, { itemId: 'experience', missionId: 'mission-2', now: T4 }),
    hasCode('item_not_planned')
  )
})

test('revisão não pode recolocar trabalho numa versão que já foi publicada', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    roadmap: [roadmap()[0], { ...roadmap()[1], version: { name: 'V2.0' } }]
  })
  approveProjectPlan(root, T1)
  startProjectMission(root, {
    itemId: 'foundation',
    missionId: 'mission-1',
    release: { versionId: 'version-1', versionName: 'V1.0' },
    now: T2
  })
  completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'V1 entregue.',
    now: T3
  })
  completeProjectPlanRelease(root, { versionId: 'version-1', now: T4 })
  saveProjectPlanDraft(root, {
    roadmapMode: 'replace',
    roadmap: [
      {
        id: 'late-v1',
        title: 'Complementar V1',
        objective: 'Tentar reabrir uma versão publicada.',
        dependsOn: ['foundation'],
        scope: { in: ['Complemento'], out: ['V2'] },
        acceptanceCriteria: ['Complemento validado'],
        version: { name: 'V1.0' }
      },
      { ...roadmap()[1], version: { name: 'V2.0' } }
    ],
    now: '2026-07-31T15:00:00.000Z'
  })

  assert.throws(() => approveProjectPlan(root, '2026-07-31T16:00:00.000Z'), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /já foi publicada/)
    return true
  })
})

test('aprovação recusa o mesmo id real associado a nomes de versão diferentes', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    roadmap: [
      { ...roadmap()[0], version: { id: 'version-shared', name: 'V1.0' } },
      { ...roadmap()[1], version: { id: 'version-shared', name: 'V2.0' } }
    ]
  })

  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /identificador version-shared/)
    return true
  })
})

test('aprovação recusa versões numéricas em ordem regressiva', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, {
    roadmap: [
      { ...roadmap()[0], version: { name: 'V2.0' } },
      { ...roadmap()[1], version: { name: 'V1.0' } }
    ]
  })

  assert.throws(() => approveProjectPlan(root, T1), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /ordene as versões de forma crescente/)
    return true
  })
})

test('conclusão registra resultado, libera a próxima missão e encerra o projeto no fim', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })

  const firstDone = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Contratos e fundação entregues.',
    now: T3
  })
  assert.equal(firstDone.status, 'in_progress')
  assert.equal(firstDone.activeItemId, undefined)
  assert.equal(firstDone.nextItemId, 'experience')
  assert.equal(firstDone.roadmap[0].outcome, 'Contratos e fundação entregues.')

  startProjectMission(root, { itemId: 'experience', missionId: 'mission-2', now: T4 })
  const finished = completeProjectMission(root, {
    missionId: 'mission-2',
    outcome: 'Fluxo principal entregue.',
    now: '2026-07-31T15:00:00.000Z'
  })

  assert.equal(finished.status, 'done')
  assert.equal(finished.completedAt, '2026-07-31T15:00:00.000Z')
  assert.equal(finished.nextItemId, undefined)
  assert.match(readFileSync(projectPlanPaths(root).markdown, 'utf8'), /Fluxo principal entregue/)
})

test('conclusão é idempotente e não troca um resultado já registrado', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  const first = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Resultado original.',
    now: T3
  })

  const repeated = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Tentativa de sobrescrever.',
    now: T4
  })

  assert.deepEqual(repeated, first)
  assert.equal(repeated.roadmap[0].outcome, 'Resultado original.')
})

test('missão planejada pode ser adiada e reativada sem perder o fluxo', (t) => {
  const root = approvedProject(t)
  const deferred = deferProjectMission(root, {
    itemId: 'experience',
    reason: 'Aguardar validação externa.',
    now: T2
  })
  assert.equal(deferred.roadmap[1].status, 'deferred')
  assert.equal(deferred.roadmap[1].deferredReason, 'Aguardar validação externa.')

  const reactivated = reactivateProjectMission(root, { itemId: 'experience', now: T3 })
  assert.equal(reactivated.roadmap[1].status, 'planned')
  assert.equal(reactivated.roadmap[1].deferredReason, undefined)
  assert.equal(reactivated.status, 'approved')
})

test('adiar todas as missões não marca o projeto como concluído', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { roadmap: [roadmap()[0]] })
  approveProjectPlan(root, T1)

  const deferred = deferProjectMission(root, {
    itemId: 'foundation',
    reason: 'Decisão ainda pendente.',
    now: T2
  })

  assert.equal(deferred.status, 'approved')
  assert.equal(deferred.completedAt, undefined)
  assert.equal(deferred.nextItemId, undefined)
  assert.equal(deferred.roadmap[0].status, 'deferred')
})

test('missão real arquivada pausa o item e volta ativa com o mesmo vínculo', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })

  const archived = deferProjectMission(root, {
    itemId: 'foundation',
    reason: 'Pausa solicitada pelo usuário.',
    now: T3
  })
  assert.equal(archived.status, 'in_progress')
  assert.equal(archived.activeItemId, undefined)
  assert.equal(archived.roadmap[0].status, 'deferred')
  assert.equal(archived.roadmap[0].missionId, 'mission-1')

  const reactivated = reactivateProjectMission(root, { itemId: 'foundation', now: T4 })
  assert.equal(reactivated.status, 'in_progress')
  assert.equal(reactivated.activeItemId, 'foundation')
  assert.equal(reactivated.roadmap[0].status, 'active')
  assert.equal(reactivated.roadmap[0].missionId, 'mission-1')
})

test('revisão do roadmap preserva missão arquivada e exige novo aval para retomá-la', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  deferProjectMission(root, { itemId: 'foundation', now: T3 })

  const revised = saveValidDraft(root, {
    vision: 'Visão refinada durante a pausa.',
    now: T4
  })
  assert.equal(revised.status, 'draft')
  assert.equal(revised.roadmap[0].status, 'deferred')
  assert.equal(revised.roadmap[0].missionId, 'mission-1')
  assert.throws(
    () => reactivateProjectMission(root, { itemId: 'foundation' }),
    hasCode('approval_required')
  )

  approveProjectPlan(root, '2026-07-31T15:00:00.000Z')
  const reactivated = reactivateProjectMission(root, {
    itemId: 'foundation',
    now: '2026-07-31T16:00:00.000Z'
  })
  assert.equal(reactivated.roadmap[0].status, 'active')
  assert.equal(reactivated.roadmap[0].missionId, 'mission-1')
})

test('excluir uma missão arquivada devolve o objetivo ao roadmap sem id morto', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  deferProjectMission(root, { itemId: 'foundation', now: T3 })

  const reset = detachProjectMission(root, { missionId: 'mission-1', now: T4 })
  assert.equal(reset.roadmap[0].status, 'planned')
  assert.equal(reset.roadmap[0].missionId, undefined)
  assert.equal(reset.nextItemId, 'foundation')
  assert.equal(reset.status, 'approved')
})

test('desvincular missão arquivada não aprova silenciosamente um rascunho revisado', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  deferProjectMission(root, { itemId: 'foundation', now: T3 })
  saveProjectPlanDraft(root, { vision: 'Visão revisada antes de excluir a missão.', now: T4 })

  const detached = detachProjectMission(root, {
    missionId: 'mission-1',
    now: '2026-07-31T15:00:00.000Z'
  })
  assert.equal(detached.status, 'draft')
  assert.equal(detached.roadmap[0].missionId, undefined)
})

test('plano concluído vira histórico e não volta a rascunho', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { roadmap: [roadmap()[0]] })
  approveProjectPlan(root, T1)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  const done = completeProjectMission(root, {
    missionId: 'mission-1',
    outcome: 'Produto inicial concluído.',
    now: T3
  })
  assert.equal(done.status, 'done')
  assert.throws(
    () => saveProjectPlanDraft(root, { vision: 'Tentativa de reabrir.', now: T4 }),
    hasCode('plan_complete')
  )
})

test('resumo do board mostra estado, missão ativa, próxima etapa e caminho do mapa', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  const plan = loadProjectPlan(root)
  const summary = summarizeProjectPlanForBoard(plan)

  assert.match(summary, /Plano mestre: em andamento/)
  assert.match(summary, /Etapa do fluxo: execução por ondas paralelas/)
  assert.match(summary, /Missões ativas: Construir fundação/)
  assert.match(summary, /O que fazer agora: acompanhe/)
  assert.match(summary, /PROJECT_PLAN\.md/)
  assert.match(renderProjectPlanMarkdown(plan), /Regra.*mesma onda podem avançar em paralelo/)
  assert.match(renderProjectPlanMarkdown(plan), /Problema/)
  assert.match(renderProjectPlanMarkdown(plan), /Critérios de aceite/)
  assert.match(renderProjectPlanMarkdown(plan), /Versão-alvo/)
  assert.equal(summarizeProjectPlanForBoard(undefined), '')
})

test('três missões irmãs abrem em paralelo e a próxima onda espera todas terminarem', (t) => {
  const root = temporaryProject(t)
  const parallelRoadmap = [
    {
      id: 'api',
      title: 'Construir API',
      objective: 'Entregar os contratos do produto.',
      wave: { id: 'W001', name: 'Fundação paralela' },
      scope: { in: ['API'], out: ['Interface'] },
      acceptanceCriteria: ['API validada'],
      version: { name: 'V1.0' }
    },
    {
      id: 'ui',
      title: 'Construir interface',
      objective: 'Entregar a experiência principal.',
      wave: { id: 'W001', name: 'Fundação paralela' },
      scope: { in: ['Interface'], out: ['API'] },
      acceptanceCriteria: ['Interface validada'],
      version: { name: 'V1.0' }
    },
    {
      id: 'observability',
      title: 'Preparar observabilidade',
      objective: 'Tornar o produto diagnosticável.',
      wave: { id: 'W001', name: 'Fundação paralela' },
      scope: { in: ['Logs'], out: ['Alertas avançados'] },
      acceptanceCriteria: ['Logs validados'],
      version: { name: 'V1.0' }
    },
    {
      id: 'journey',
      title: 'Integrar jornada',
      objective: 'Unir as entregas da fundação.',
      dependsOn: ['api', 'ui', 'observability'],
      wave: { id: 'W002', name: 'Integração funcional' },
      scope: { in: ['Fluxo completo'], out: ['Escala'] },
      acceptanceCriteria: ['Jornada validada'],
      version: { name: 'V1.0' }
    }
  ]
  saveValidDraft(root, { roadmap: parallelRoadmap })
  const approved = approveProjectPlan(root, T1)
  assert.equal(approved.currentWaveId, 'W001')
  assert.deepEqual(approved.readyItemIds, ['api', 'ui', 'observability'])

  startProjectMission(root, { itemId: 'ui', missionId: 'mission-ui', now: T2 })
  startProjectMission(root, { itemId: 'api', missionId: 'mission-api', now: T3 })
  const threeActive = startProjectMission(root, {
    itemId: 'observability',
    missionId: 'mission-observability',
    now: T4
  })
  assert.deepEqual(threeActive.activeItemIds, ['api', 'ui', 'observability'])
  assert.deepEqual(threeActive.readyItemIds, [])
  assert.throws(
    () => startProjectMission(root, { itemId: 'journey', missionId: 'mission-journey' }),
    hasCode('item_not_planned')
  )

  completeProjectMission(root, { missionId: 'mission-ui', outcome: 'UI pronta.', now: T4 })
  completeProjectMission(root, {
    missionId: 'mission-observability',
    outcome: 'Logs prontos.',
    now: '2026-07-31T15:00:00.000Z'
  })
  const lastPeer = completeProjectMission(root, {
    missionId: 'mission-api',
    outcome: 'API pronta.',
    now: '2026-07-31T16:00:00.000Z'
  })
  assert.equal(lastPeer.currentWaveId, 'W002')
  assert.deepEqual(lastPeer.readyItemIds, ['journey'])
  assert.deepEqual(projectPlanExecutionWindow(lastPeer).readyItemIds, ['journey'])
})

test('aprovação exige mesma versão na onda e dependências somente de ondas anteriores', (t) => {
  const versionRoot = temporaryProject(t)
  saveValidDraft(versionRoot, {
    roadmap: roadmap().map((item, index) => ({
      ...item,
      dependsOn: [],
      wave: { id: 'W001' },
      version: { name: index === 0 ? 'V1.0' : 'V2.0' }
    }))
  })
  assert.throws(() => approveProjectPlan(versionRoot, T1), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /mesma versão/)
    return true
  })

  const dependencyRoot = temporaryProject(t)
  const [foundation, experience] = roadmap()
  saveValidDraft(dependencyRoot, {
    roadmap: [
      { ...foundation, wave: { id: 'W001' } },
      { ...experience, dependsOn: ['foundation'], wave: { id: 'W001' } }
    ]
  })
  assert.throws(() => approveProjectPlan(dependencyRoot, T1), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /ondas anteriores/)
    return true
  })
})

test('adiamento pausa novas aberturas da onda, mas pares já ativos podem concluir', (t) => {
  const root = temporaryProject(t)
  const peers = ['a', 'b', 'c'].map((id) => ({
    id,
    title: `Missão ${id.toUpperCase()}`,
    objective: `Entregar ${id}.`,
    wave: { id: 'W001' },
    scope: { in: [id], out: ['fora'] },
    acceptanceCriteria: [`${id} validado`],
    version: { name: 'V1.0' }
  }))
  saveValidDraft(root, { roadmap: peers })
  approveProjectPlan(root, T1)
  startProjectMission(root, { itemId: 'a', missionId: 'mission-a', now: T2 })

  const paused = deferProjectMission(root, {
    itemId: 'b',
    reason: 'Decisão do Maestro pendente.',
    now: T3
  })
  assert.deepEqual(paused.activeItemIds, ['a'])
  assert.deepEqual(paused.readyItemIds, [])
  assert.equal(projectPlanExecutionWindow(paused).pausedByDeferred, true)
  assert.throws(
    () => startProjectMission(root, { itemId: 'c', missionId: 'mission-c', now: T4 }),
    hasCode('item_not_planned')
  )

  const peerDone = completeProjectMission(root, {
    missionId: 'mission-a',
    outcome: 'A terminou durante a pausa.',
    now: T4
  })
  assert.equal(peerDone.roadmap.find((item) => item.id === 'a')?.status, 'done')
  assert.equal(peerDone.currentWaveId, 'W001')
  assert.deepEqual(peerDone.readyItemIds, [])

  const resumed = reactivateProjectMission(root, { itemId: 'b', now: T4 })
  assert.deepEqual(resumed.readyItemIds, ['b', 'c'])
})

test('load migra schema v1 para v2 com ondas seriais e persiste a conversão', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root)
  const current = approveProjectPlan(root, T1)
  const legacy = structuredClone(current)
  legacy.schemaVersion = 1
  delete legacy.roadmapMeta
  delete legacy.planningSkills
  delete legacy.activeItemIds
  delete legacy.readyItemIds
  delete legacy.currentWaveId
  for (const item of legacy.roadmap) delete item.wave
  writeFileSync(projectPlanPaths(root).json, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

  const migrated = loadProjectPlan(root)
  assert.equal(migrated?.schemaVersion, 2)
  assert.deepEqual(migrated?.roadmap.map((item) => item.wave.id), ['W001', 'W002'])
  assert.deepEqual(migrated?.roadmapMeta, { expectedCount: 2, complete: true })
  assert.deepEqual(migrated?.planningSkills, [])
  assert.equal(migrated?.currentWaveId, 'W001')
  assert.deepEqual(migrated?.readyItemIds, ['foundation'])
  assert.equal(migrated?.nextItemId, 'foundation')
  assert.equal(JSON.parse(readFileSync(projectPlanPaths(root).json, 'utf8')).schemaVersion, 2)
})

test('roadmap completo aceita lote de 150 missões e valida sua contagem declarada', (t) => {
  const root = temporaryProject(t)
  const largeRoadmap = Array.from({ length: 150 }, (_, index) => {
    const wave = Math.floor(index / 10) + 1
    return {
      id: `mission-${String(index + 1).padStart(3, '0')}`,
      title: `Missão ${index + 1}`,
      objective: `Entregar o recorte ${index + 1}.`,
      wave: { id: `W${String(wave).padStart(3, '0')}` },
      scope: { in: [`Recorte ${index + 1}`], out: ['Fora'] },
      acceptanceCriteria: [`Recorte ${index + 1} validado`],
      version: { name: 'V1.0' }
    }
  })
  saveValidDraft(root, { roadmap: largeRoadmap })
  const approved = approveProjectPlan(root, T1)
  assert.equal(approved.roadmap.length, 150)
  assert.deepEqual(approved.roadmapMeta, { expectedCount: 150, complete: true })
  assert.equal(approved.readyItemIds.length, 10)

  const incompleteRoot = temporaryProject(t)
  saveValidDraft(incompleteRoot, {
    roadmap: largeRoadmap.slice(0, 2),
    roadmapMeta: { expectedCount: 3, complete: false }
  })
  assert.throws(() => approveProjectPlan(incompleteRoot, T1), (error) => {
    assert.ok(hasCode('invalid_plan')(error))
    assert.match(error.message, /decomposto por completo/)
    assert.match(error.message, /declara 3 missões, mas contém 2/)
    return true
  })

  const oversizedRoot = temporaryProject(t)
  assert.throws(
    () => saveValidDraft(oversizedRoot, { roadmap: Array.from({ length: 501 }, (_, index) => ({
      ...largeRoadmap[0],
      id: `oversized-${index}`,
      wave: { id: `W${String(index + 1).padStart(3, '0')}` }
    })) }),
    hasCode('invalid_plan')
  )
})

test('Maestro registra skills de planejamento com contribuição auditável', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root)
  const first = recordProjectPlanningSkillUse(root, {
    id: 'grill-me',
    stage: 'discovery',
    contribution: 'Expôs a principal hipótese de público.',
    now: T1
  })
  assert.equal(first.planningSkills.length, 1)

  const updated = recordProjectPlanningSkillUse(root, {
    id: 'grill-me',
    stage: 'discovery',
    contribution: 'Expôs a hipótese de público e seu risco central.',
    now: T2
  })
  assert.equal(updated.planningSkills.length, 2)
  assert.equal(updated.planningSkills[0].usedAt, T1)
  assert.equal(updated.planningSkills[1].usedAt, T2)

  const idempotent = recordProjectPlanningSkillUse(root, {
    id: 'grill-me',
    stage: 'discovery',
    contribution: 'Expôs a hipótese de público e seu risco central.',
    now: T3
  })
  assert.equal(idempotent.planningSkills.length, 2)

  const second = recordProjectPlanningSkillUse(root, {
    id: 'roadmap-planning',
    stage: 'roadmap',
    contribution: 'Separou o projeto em ondas e dependências.',
    now: T3
  })
  assert.deepEqual(second.planningSkills.map((entry) => entry.id), [
    'grill-me',
    'grill-me',
    'roadmap-planning'
  ])
  assert.match(renderProjectPlanMarkdown(second), /Skills de planejamento declaradas/)
  assert.match(renderProjectPlanMarkdown(second), /Separou o projeto em ondas/)
  assert.match(summarizeProjectPlanForBoard(second), /grill-me, roadmap-planning/)
})

test('JSON corrompido é rejeitado de forma explícita', (t) => {
  const root = temporaryProject(t)
  const paths = projectPlanPaths(root)
  mkdirSync(paths.directory, { recursive: true })
  writeFileSync(paths.json, '{ não é json', 'utf8')

  assert.throws(() => loadProjectPlan(root), hasCode('invalid_plan'))
})

test('backup válido recupera e repara um JSON principal corrompido', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { vision: 'Fotografia segura anterior.' })
  saveProjectPlanDraft(root, { vision: 'Fotografia mais nova.', now: T1 })
  const paths = projectPlanPaths(root)

  assert.equal(existsSync(paths.backup), true)
  writeFileSync(paths.json, '{ arquivo truncado', 'utf8')

  const recovered = loadProjectPlan(root)
  assert.equal(recovered?.vision, 'Fotografia mais nova.')
  assert.deepEqual(JSON.parse(readFileSync(paths.json, 'utf8')), recovered)
  assert.match(readFileSync(paths.markdown, 'utf8'), /Fotografia mais nova/)
})

test('backup também recupera o plano quando o JSON principal desaparece', (t) => {
  const root = temporaryProject(t)
  saveValidDraft(root, { vision: 'Fotografia anterior recuperável.' })
  saveProjectPlanDraft(root, { vision: 'Fotografia mais nova.', now: T1 })
  const paths = projectPlanPaths(root)
  rmSync(paths.json, { force: true })

  const recovered = loadProjectPlan(root)
  assert.equal(recovered?.vision, 'Fotografia mais nova.')
  assert.equal(existsSync(paths.json), true)
  assert.deepEqual(JSON.parse(readFileSync(paths.json, 'utf8')), recovered)
})

test('backup corrente preserva o vínculo da missão ativa', (t) => {
  const root = approvedProject(t)
  startProjectMission(root, { itemId: 'foundation', missionId: 'mission-1', now: T2 })
  const paths = projectPlanPaths(root)
  writeFileSync(paths.json, '{ truncado', 'utf8')

  const recovered = loadProjectPlan(root)
  assert.equal(recovered?.activeItemId, 'foundation')
  assert.equal(recovered?.roadmap[0].status, 'active')
  assert.equal(recovered?.roadmap[0].missionId, 'mission-1')
})

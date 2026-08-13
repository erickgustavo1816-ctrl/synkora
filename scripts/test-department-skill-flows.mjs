import assert from 'node:assert/strict'
import test from 'node:test'

import { CURATED_SKILLS } from '../src/main/skillsCatalog.ts'
import { BUNDLED_SKILLS } from '../src/main/skillsBundled.ts'
import { MAESTRO_DEPARTMENTS, parseMaestroTasks } from '../src/main/maestroTasks.ts'
import {
  IMPECCABLE_SKILL_ID,
  isDesignSystemWork,
  isDevOpsWork,
  missingMandatoryUiPhaseSkills,
  selectPhaseSkillPlan,
  SYNKORA_BACKEND_QA_ID,
  SYNKORA_BACKEND_STANDARD_ID,
  SYNKORA_COPY_QA_ID,
  SYNKORA_COPY_STANDARD_ID,
  SYNKORA_CYBER_QA_ID,
  SYNKORA_CYBER_STANDARD_ID,
  SYNKORA_DATA_QA_ID,
  SYNKORA_DATA_STANDARD_ID,
  SYNKORA_DESIGN_SYSTEM_QA_ID,
  SYNKORA_DESIGN_SYSTEM_STANDARD_ID,
  SYNKORA_DEVOPS_QA_ID,
  SYNKORA_DEVOPS_STANDARD_ID,
  SYNKORA_FRONTEND_STANDARD_ID,
  SYNKORA_QA_QA_ID,
  SYNKORA_QA_STANDARD_ID,
  SYNKORA_RESEARCH_QA_ID,
  SYNKORA_RESEARCH_STANDARD_ID,
  SYNKORA_REVIEW_STANDARD_ID,
  SYNKORA_RUNTIME_QA_ID,
  SYNKORA_UI_QA_ID
} from '../src/main/skillsRouting.ts'
import { DEPARTMENTS } from '../src/renderer/src/departments.ts'

const defs = [...BUNDLED_SKILLS, ...CURATED_SKILLS]
const installedIds = new Set(defs.map((def) => def.id))
const defById = new Map(defs.map((def) => [def.id, def]))

function plan({ department, phase, text, uiCard }) {
  return selectPhaseSkillPlan({
    defs,
    isInstalled: (id) => installedIds.has(id),
    department,
    phase,
    taskText: text,
    uiCard,
    executionMode: 'standard',
    delegationMode: 'none'
  })
}

const flows = [
  {
    name: 'Front',
    department: 'front',
    text: 'Implementar uma nova tela responsiva de reservas',
    uiCard: true,
    dev: [SYNKORA_FRONTEND_STANDARD_ID, IMPECCABLE_SKILL_ID],
    qa: [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_UI_QA_ID]
  },
  {
    name: 'Design System',
    department: 'design',
    text: 'Criar o design system completo do produto com tokens, componentes e governança',
    uiCard: true,
    dev: [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_DESIGN_SYSTEM_STANDARD_ID],
    qa: [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_UI_QA_ID, SYNKORA_DESIGN_SYSTEM_QA_ID],
    devExcluded: [IMPECCABLE_SKILL_ID]
  },
  {
    name: 'Back',
    department: 'back',
    text: 'Implementar endpoint OAuth com autorização por tenant',
    uiCard: false,
    dev: [SYNKORA_BACKEND_STANDARD_ID],
    qa: [SYNKORA_BACKEND_STANDARD_ID, SYNKORA_BACKEND_QA_ID]
  },
  {
    name: 'DevOps',
    department: 'back',
    text: 'Criar pipeline de deploy canário no GitHub Actions com rollback',
    uiCard: false,
    dev: [SYNKORA_DEVOPS_STANDARD_ID],
    qa: [SYNKORA_DEVOPS_STANDARD_ID, SYNKORA_DEVOPS_QA_ID]
  },
  {
    name: 'Cyber',
    department: 'cyber',
    text: 'Revisar autorização OAuth e hardening de segredos do serviço',
    uiCard: false,
    dev: [SYNKORA_CYBER_STANDARD_ID],
    qa: [SYNKORA_CYBER_STANDARD_ID, SYNKORA_CYBER_QA_ID]
  },
  {
    name: 'Data',
    department: 'data',
    text: 'Definir KPI de retenção e implementar a camada semântica no dbt',
    uiCard: false,
    dev: [SYNKORA_DATA_STANDARD_ID],
    qa: [SYNKORA_DATA_STANDARD_ID, SYNKORA_DATA_QA_ID]
  },
  {
    name: 'Research',
    department: 'research',
    text: 'Comparar concorrentes por fontes primárias e sintetizar a decisão',
    uiCard: false,
    dev: [SYNKORA_RESEARCH_STANDARD_ID],
    qa: [SYNKORA_RESEARCH_STANDARD_ID, SYNKORA_RESEARCH_QA_ID],
    devExcluded: ['deep-research']
  },
  {
    name: 'Copy',
    department: 'copy',
    text: 'Escrever a sequência de e-mails de onboarding sem inventar claims',
    uiCard: false,
    dev: [SYNKORA_COPY_STANDARD_ID],
    qa: [SYNKORA_COPY_STANDARD_ID, SYNKORA_COPY_QA_ID]
  },
  {
    name: 'QA genérico',
    department: 'qa',
    text: 'Validar o comportamento observável do fluxo de importação',
    uiCard: false,
    dev: [SYNKORA_QA_STANDARD_ID],
    qa: [SYNKORA_QA_QA_ID],
    qaExcluded: [SYNKORA_RUNTIME_QA_ID]
  }
]

test('o Maestro aceita exatamente as oito funções exibidas pelo produto', () => {
  const rendererDepartments = DEPARTMENTS.map((department) => department.key)
  assert.deepEqual([...MAESTRO_DEPARTMENTS], rendererDepartments)

  const parsed = parseMaestroTasks(
    JSON.stringify({
      tasks: MAESTRO_DEPARTMENTS.map((department) => ({
        department,
        title: `Card ${department}`,
        description: `Entrega da função ${department}`,
        type: department === 'cyber' ? 'bug' : 'feature',
        effort: department === 'data' ? 'pesada' : 'leve'
      }))
    })
  )

  assert.deepEqual(
    parsed.map((task) => task.department),
    [...MAESTRO_DEPARTMENTS]
  )
  assert.equal(parsed.find((task) => task.department === 'cyber')?.type, 'bug')
  assert.equal(parsed.find((task) => task.department === 'data')?.effort, 'pesada')
  assert.deepEqual(parseMaestroTasks('{invalido'), [])
})

test('o board mostra somente contratos automáticos reais, nunca o catálogo ornamental', () => {
  const bundledIds = new Set(BUNDLED_SKILLS.map((skill) => skill.id))
  for (const department of DEPARTMENTS) {
    assert.ok(department.skills.length > 0, `${department.key} precisa mostrar contratos`)
    assert.match(department.skillFlow, /QA|qa|review/)
    for (const skillId of department.skills) {
      assert.match(skillId, /^synkora-/)
      assert.ok(bundledIds.has(skillId), `${department.key} mostra contrato inexistente: ${skillId}`)
    }
  }
})

for (const flow of flows) {
  test(`${flow.name}: DEV recebe contrato e QA recebe uma régua independente`, () => {
    const devPlan = plan({
      department: flow.department,
      phase: 'dev',
      text: flow.text,
      uiCard: flow.uiCard
    })
    const qaPlan = plan({
      department: flow.department,
      phase: 'qa',
      text: flow.text,
      uiCard: flow.uiCard
    })

    for (const required of flow.dev) assert.ok(devPlan.skillIds.includes(required), required)
    for (const required of flow.qa) assert.ok(qaPlan.skillIds.includes(required), required)
    for (const excluded of flow.devExcluded ?? []) {
      assert.ok(!devPlan.skillIds.includes(excluded), `${excluded} não pertence ao DEV`)
    }
    for (const excluded of flow.qaExcluded ?? []) {
      assert.ok(!qaPlan.skillIds.includes(excluded), `${excluded} não pertence ao QA`)
    }

    const externalTechniques = devPlan.skillIds.filter((skillId) => {
      const adapter = defById.get(skillId)?.adapter
      return adapter !== 'synkora-native' && adapter !== 'impeccable-operation'
    })
    assert.ok(externalTechniques.length <= 1, `empilhou técnicas: ${externalTechniques.join(', ')}`)
    assert.ok(
      qaPlan.skillIds.every((skillId) => defById.get(skillId)?.adapter === 'synkora-native'),
      `QA herdou método do DEV: ${qaPlan.skillIds.join(', ')}`
    )

    const designSystemWork = isDesignSystemWork(flow.department, flow.text)
    const devOpsWork = isDevOpsWork(flow.department, flow.text)
    assert.deepEqual(
      missingMandatoryUiPhaseSkills(
        devPlan.skillIds,
        flow.department,
        'dev',
        flow.uiCard,
        designSystemWork,
        devOpsWork
      ),
      []
    )
    assert.deepEqual(
      missingMandatoryUiPhaseSkills(
        qaPlan.skillIds,
        flow.department,
        'qa',
        flow.uiCard,
        designSystemWork,
        devOpsWork
      ),
      []
    )
  })
}

test('REVIEW permanece um gate único e não herda contrato ou técnica de nenhuma função', () => {
  for (const flow of flows) {
    const reviewPlan = plan({
      department: flow.department,
      phase: 'review',
      text: flow.text,
      uiCard: flow.uiCard
    })
    assert.deepEqual(reviewPlan.skillIds, [SYNKORA_REVIEW_STANDARD_ID])
    assert.deepEqual(reviewPlan.agentIds, [])
  }
})

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CURATED_SKILLS } from '../src/main/skillsCatalog.ts'
import { buildSynkoraImpeccableActivation } from '../src/main/impeccableAdapter.ts'
import {
  classifyTaskUiWork,
  detectImpeccableOperation,
  IMPECCABLE_SKILL_ID,
  isDesignSystemWork,
  isDevOpsWork,
  isUiSurfaceWork,
  missingMandatoryUiPhaseSkills,
  selectPhaseSkillPlan,
  selectInstalledIdsForDepartment,
  selectInstalledManualOnlyIdsToPrune,
  selectInstalledPlanningIds,
  SYNKORA_PLANNING_STANDARD_ID,
  SYNKORA_BACKEND_QA_ID,
  SYNKORA_BACKEND_STANDARD_ID,
  SYNKORA_CYBER_QA_ID,
  SYNKORA_CYBER_STANDARD_ID,
  SYNKORA_COPY_QA_ID,
  SYNKORA_COPY_STANDARD_ID,
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
import {
  managedWorkspaceSkillContentsMatch,
  MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX,
  MANAGED_WORKSPACE_SKILL_MARKER,
  materializePrivateSkillPackage,
  pruneUnrequestedManagedWorkspaceAgents,
  pruneUnrequestedManagedWorkspaceSkills,
  removePrivateSkillPlan,
  syncManagedWorkspaceAgentCopy,
  syncManagedWorkspaceSkillCopies,
  WorkspaceSkillLeaseRegistry
} from '../src/main/workspaceSkills.ts'

const SUPERPOWERS_IDS = [
  'brainstorming',
  'dispatching-parallel-agents',
  'executing-plans',
  'finishing-a-development-branch',
  'receiving-code-review',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'using-git-worktrees',
  'using-superpowers',
  'verification-before-completion',
  'writing-plans'
]

const PLANNING_IDS = [
  'grilling',
  'grill-me',
  'grill-with-docs',
  'brainstorming',
  'writing-plans',
  'to-tickets',
  'before-you-build',
  'roadmap-planning'
]

const ROUTING_DEFS = [
  {
    id: SYNKORA_PLANNING_STANDARD_ID,
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    orchestratorDefault: true,
    allowedPhases: ['planning'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_REVIEW_STANDARD_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'review nativo',
    allowedPhases: ['review'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_RUNTIME_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'qa nativo',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read', 'browser'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_QA_STANDARD_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'qa authoring contract',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_QA_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'qa authoring independent qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_BACKEND_STANDARD_ID,
    kind: 'skill',
    depts: ['back', 'qa'],
    group: 'backend contract',
    allowedPhases: ['dev', 'qa', 'helper'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_BACKEND_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'backend qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_DEVOPS_STANDARD_ID,
    kind: 'skill',
    depts: ['back', 'qa'],
    group: 'devops contract',
    allowedPhases: ['dev', 'qa', 'helper'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_DEVOPS_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'devops qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_CYBER_STANDARD_ID,
    kind: 'skill',
    depts: ['cyber', 'qa'],
    group: 'cyber contract',
    allowedPhases: ['dev', 'qa', 'helper'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_CYBER_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'cyber qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_DATA_STANDARD_ID,
    kind: 'skill',
    depts: ['data', 'qa'],
    group: 'data contract',
    allowedPhases: ['dev', 'qa', 'helper'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_DATA_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'data qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_RESEARCH_STANDARD_ID,
    kind: 'skill',
    depts: ['research', 'qa'],
    group: 'research contract',
    allowedPhases: ['dev', 'qa', 'helper'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_RESEARCH_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'research qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_COPY_STANDARD_ID,
    kind: 'skill',
    depts: ['copy', 'qa'],
    group: 'copy contract',
    allowedPhases: ['dev', 'qa', 'helper'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_COPY_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'copy qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_DESIGN_SYSTEM_STANDARD_ID,
    kind: 'skill',
    depts: ['design', 'front'],
    group: 'design system',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell', 'browser'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_DESIGN_SYSTEM_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'design system qa',
    allowedPhases: ['qa'],
    requiresCapabilities: ['read', 'browser'],
    adapter: 'synkora-native'
  },
  {
    id: SYNKORA_FRONTEND_STANDARD_ID,
    kind: 'skill',
    depts: ['front', 'design', 'qa'],
    group: 'contrato do produto',
    allowedPhases: ['dev', 'qa', 'helper'],
    requiresCapabilities: ['read']
  },
  {
    id: IMPECCABLE_SKILL_ID,
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'polish & micro-interações',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'browser']
  },
  {
    id: SYNKORA_UI_QA_ID,
    kind: 'skill',
    depts: ['qa'],
    group: 'revisão de interface',
    defaultFor: ['qa'],
    allowedPhases: ['qa'],
    requiresCapabilities: ['read', 'browser']
  },
  {
    id: 'better-layout',
    kind: 'skill',
    depts: ['front'],
    group: 'layout · tipografia · cor',
    defaultFor: ['front']
  },
  {
    id: 'react-best-practices',
    kind: 'skill',
    depts: ['front'],
    group: 'react & next',
    defaultFor: ['front']
  },
  {
    id: 'typescript-advanced-types',
    kind: 'skill',
    depts: ['back'],
    group: 'typescript & python',
    defaultFor: ['back']
  },
  {
    id: 'oauth',
    kind: 'skill',
    depts: ['back', 'cyber'],
    group: 'auth & security'
  },
  {
    id: 'api-design-principles',
    kind: 'skill',
    depts: ['back'],
    group: 'api & services'
  },
  {
    id: 'diagnosing-bugs',
    kind: 'skill',
    depts: ['back'],
    group: 'debugging'
  },
  {
    id: 'deployment-pipeline-design',
    kind: 'skill',
    depts: ['back'],
    group: 'devops ci cd iac'
  },
  {
    id: 'github-actions-templates',
    kind: 'skill',
    depts: ['back'],
    group: 'devops ci cd iac'
  },
  {
    id: 'terraform-skill',
    kind: 'skill',
    depts: ['back'],
    group: 'devops ci cd iac'
  },
  {
    id: 'slo-implementation',
    kind: 'skill',
    depts: ['back'],
    group: 'devops ci cd iac'
  },
  {
    id: 'secrets-audit',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & secrets'
  },
  {
    id: 'prompt-injection-defense',
    kind: 'skill',
    depts: ['cyber'],
    group: 'llm security'
  },
  {
    id: 'security-threat-model',
    kind: 'skill',
    depts: ['cyber'],
    group: 'threat modeling'
  },
  {
    id: 'security-best-practices',
    kind: 'skill',
    depts: ['back', 'cyber'],
    group: 'auth & security',
    defaultFor: ['cyber']
  },
  { id: 'sql-queries', kind: 'skill', depts: ['data'], group: 'sql', defaultFor: ['data'] },
  { id: 'building-dbt-semantic-layer', kind: 'skill', depts: ['data'], group: 'dbt' },
  { id: 'using-dbt-for-analytics-engineering', kind: 'skill', depts: ['data'], group: 'dbt' },
  { id: 'polars', kind: 'skill', depts: ['data'], group: 'dataframes' },
  { id: 'read-file', kind: 'skill', depts: ['data'], group: 'files' },
  { id: 'query', kind: 'skill', depts: ['data'], group: 'duckdb' },
  { id: 'kpi-dashboard-design', kind: 'skill', depts: ['data'], group: 'bi' },
  { id: 'build-dashboard', kind: 'skill', depts: ['data'], group: 'bi' },
  { id: 'data-visualization', kind: 'skill', depts: ['data'], group: 'bi' },
  { id: 'data-quality-frameworks', kind: 'skill', depts: ['data'], group: 'quality' },
  { id: 'validate-data', kind: 'skill', depts: ['data'], group: 'quality' },
  { id: 'ab-testing', kind: 'skill', depts: ['data'], group: 'statistics' },
  { id: 'statistical-analysis', kind: 'skill', depts: ['data'], group: 'statistics' },
  { id: 'explore-data', kind: 'skill', depts: ['data'], group: 'exploration' },
  { id: 'research', kind: 'skill', depts: ['research'], group: 'research', defaultFor: ['research'] },
  { id: 'spec-miner', kind: 'skill', depts: ['research'], group: 'specs' },
  { id: 'write-spec', kind: 'skill', depts: ['research'], group: 'specs' },
  { id: 'competitive-brief', kind: 'skill', depts: ['research'], group: 'research' },
  { id: 'market-sizing-analysis', kind: 'skill', depts: ['research'], group: 'research' },
  { id: 'synthesize-research', kind: 'skill', depts: ['research'], group: 'research' },
  { id: 'copywriting', kind: 'skill', depts: ['copy'], group: 'conversion', defaultFor: ['copy'] },
  { id: 'brand-review', kind: 'skill', depts: ['copy'], group: 'voice' },
  { id: 'email-sequence', kind: 'skill', depts: ['copy'], group: 'email' },
  { id: 'social', kind: 'skill', depts: ['copy'], group: 'social' },
  { id: 'landing-page-copy', kind: 'skill', depts: ['copy'], group: 'conversion' },
  { id: 'ai-seo', kind: 'skill', depts: ['copy'], group: 'seo' },
  { id: 'brand-voice', kind: 'skill', depts: ['copy'], group: 'voice' },
  { id: 'ux-writing', kind: 'skill', depts: ['copy'], group: 'ux' },
  { id: 'copy-editing', kind: 'skill', depts: ['copy'], group: 'editing' },
  { id: 'humanizer', kind: 'skill', depts: ['copy'], group: 'editing' },
  {
    id: 'webapp-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'teste ao vivo (browser)',
    defaultFor: ['qa']
  },
  {
    id: 'better-accessibility',
    kind: 'skill',
    depts: ['front', 'qa'],
    group: 'acessibilidade & microcopy'
  },
  {
    id: 'code-review',
    kind: 'skill',
    depts: ['qa'],
    group: 'review de código (gate)',
    defaultFor: ['qa']
  },
  {
    id: 'code-review-and-quality',
    kind: 'skill',
    depts: ['qa'],
    group: 'review de código (gate)'
  },
  {
    id: 'differential-review',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança'
  },
  {
    id: 'ui-ux-designer',
    kind: 'agent',
    depts: ['front', 'design'],
    group: 'subagentes especializados'
  },
  {
    id: 'frontend-developer',
    kind: 'agent',
    depts: ['front'],
    group: 'subagentes especializados'
  }
]

const ROUTING_INSTALLED = new Set(ROUTING_DEFS.map((def) => def.id))
const route = (patch) =>
  selectPhaseSkillPlan({
    defs: ROUTING_DEFS,
    isInstalled: (id) => ROUTING_INSTALLED.has(id),
    department: 'front',
    phase: 'dev',
    taskText: '',
    executionMode: 'standard',
    delegationMode: 'optional',
    ...patch
  })

test('roteia somente operações visuais seguras do Impeccable', () => {
  const cases = [
    {
      expected: 'layout',
      text: 'Reorganize o header da tela, alinhe os filtros e corrija o espaçamento do layout.'
    },
    {
      expected: 'adapt',
      text: 'Adapte o calendário da interface para mobile e tablet com breakpoints responsivos.'
    },
    {
      expected: 'harden',
      text: 'A tela precisa suportar texto longo com ellipsis, overflow e estados vazios.'
    },
    {
      expected: 'typeset',
      text: 'Corrija a tipografia da página, a fonte, a altura de linha e a escala tipográfica.'
    },
    {
      expected: 'polish',
      text: 'Faça o polimento visual da interface e deixe os componentes mais harmônicos.'
    }
  ]

  for (const { expected, text } of cases) {
    assert.equal(detectImpeccableOperation(text), expected)
    const selected = route({ taskText: text })
    assert.deepEqual(selected.skillIds.slice(0, 2), [
      SYNKORA_FRONTEND_STANDARD_ID,
      IMPECCABLE_SKILL_ID
    ])
    assert.equal(selected.impeccableOperation, expected)
    assert.ok(selected.skillIds.length <= 3)
  }
})

test('criação de design system recebe um método fixo em vez de empilhar Impeccable', () => {
  const text =
    'Criar um design system completo com design tokens, biblioteca de componentes, estados, Storybook, specimen e governança.'
  assert.equal(isDesignSystemWork('design', text), true)
  assert.equal(isDesignSystemWork('front', text), true)
  assert.equal(isDesignSystemWork('back', text), false)

  const dev = route({ department: 'design', taskText: text, uiCard: true })
  assert.deepEqual(dev.skillIds, [
    SYNKORA_FRONTEND_STANDARD_ID,
    SYNKORA_DESIGN_SYSTEM_STANDARD_ID
  ])
  assert.equal(dev.skillIds.includes(IMPECCABLE_SKILL_ID), false)
  assert.equal(dev.impeccableOperation, undefined)

  const qa = route({ department: 'design', phase: 'qa', taskText: text, uiCard: true })
  assert.deepEqual(qa.skillIds, [
    SYNKORA_FRONTEND_STANDARD_ID,
    SYNKORA_UI_QA_ID,
    SYNKORA_DESIGN_SYSTEM_QA_ID
  ])
  assert.equal(qa.skillIds.includes(IMPECCABLE_SKILL_ID), false)
})

test('consumir o design system numa tela continua sendo trabalho Impeccable', () => {
  const cases = [
    'Use o design system existente para criar uma nova tela de calendário.',
    'Crie uma nova tela com os componentes do design system existente.',
    'Ajuste somente o botão do design system nesta página.'
  ]
  for (const text of cases) {
    assert.equal(isDesignSystemWork('design', text), false, text)
    const selected = route({ department: 'design', taskText: text, uiCard: true })
    assert.deepEqual(selected.skillIds.slice(0, 2), [
      SYNKORA_FRONTEND_STANDARD_ID,
      IMPECCABLE_SKILL_ID
    ])
    assert.equal(selected.skillIds.includes(SYNKORA_DESIGN_SYSTEM_STANDARD_ID), false)
  }
})

test('near-misses técnicos não ativam skill visual', () => {
  const cases = [
    { department: 'back', text: 'Harden the API authentication endpoint.' },
    { department: 'data', text: 'Adapt the warehouse schema for the new ingestion job.' },
    { department: 'back', text: 'Typeset the TypeScript generic types used by the service.' },
    { department: 'research', text: 'Polish the wording of the final research report.' },
    { department: 'front', text: 'Refactor the data adapter and its TypeScript types; no user interface changes.' }
  ]

  for (const item of cases) {
    const selected = route({ ...item, uiCard: false })
    assert.ok(!selected.skillIds.includes(SYNKORA_FRONTEND_STANDARD_ID), item.text)
    assert.ok(!selected.skillIds.includes(IMPECCABLE_SKILL_ID), item.text)
    assert.ok(selected.skillIds.length <= 2, item.text)
    if (item.department === 'back') {
      assert.equal(selected.skillIds[0], SYNKORA_BACKEND_STANDARD_ID, item.text)
    }
    assert.deepEqual(selected.agentIds, [], item.text)
    assert.equal(selected.impeccableOperation, undefined, item.text)
  }
})

test('cada departamento não visual recebe no máximo uma técnica-base curada', () => {
  for (const department of ['back', 'copy', 'cyber', 'data', 'research']) {
    const selected = route({
      department,
      taskText: 'Implementar a entrega descrita no card.',
      uiCard: false
    })
    assert.equal(selected.skillIds.length, 2, department)
    if (department === 'back') assert.equal(selected.skillIds[0], SYNKORA_BACKEND_STANDARD_ID)
    if (department === 'cyber') assert.equal(selected.skillIds[0], SYNKORA_CYBER_STANDARD_ID)
    if (department === 'data') assert.equal(selected.skillIds[0], SYNKORA_DATA_STANDARD_ID)
    if (department === 'research') assert.equal(selected.skillIds[0], SYNKORA_RESEARCH_STANDARD_ID)
    if (department === 'copy') assert.equal(selected.skillIds[0], SYNKORA_COPY_STANDARD_ID)
    assert.deepEqual(selected.agentIds, [], department)
    assert.equal(selected.impeccableOperation, undefined, department)
  }
})

test('Back escolhe contrato nativo e uma técnica específica antes do fallback genérico', () => {
  const cases = [
    {
      text: 'Corrigir falha de autorização OAuth no refresh token.',
      technique: 'oauth'
    },
    {
      text: 'Projetar o contrato dos endpoints REST e os status HTTP.',
      technique: 'api-design-principles'
    },
    {
      text: 'Investigar uma regressão sem pista de domínio e provar a causa raiz.',
      technique: 'diagnosing-bugs'
    }
  ]
  for (const { text, technique } of cases) {
    const selected = route({ department: 'back', taskText: text, uiCard: false })
    assert.deepEqual(selected.skillIds, [SYNKORA_BACKEND_STANDARD_ID, technique], text)
    assert.deepEqual(selected.incompatibilities, [], text)
  }
})

test('Data recebe contrato nativo e a tecnica especifica para o artefato', () => {
  const cases = [
    ['Definir a camada semantica MetricFlow e as metricas dbt.', 'building-dbt-semantic-layer'],
    ['Criar um modelo dbt com ref, source e lineage.', 'using-dbt-for-analytics-engineering'],
    ['Otimizar a transformacao Polars com LazyFrame.', 'polars'],
    ['Inspecionar schema e amostra de um arquivo Parquet.', 'read-file'],
    ['Consultar os eventos locais com DuckDB.', 'query'],
    ['Definir a hierarquia de KPIs do scorecard executivo.', 'kpi-dashboard-design'],
    ['Construir um dashboard interativo com filtros.', 'build-dashboard'],
    ['Criar um grafico acessivel para comparar as distribuicoes.', 'data-visualization'],
    ['Desenhar um experimento A/B com sample size e guardrails.', 'ab-testing'],
    ['Analisar significancia, effect size e intervalo de confianca.', 'statistical-analysis']
  ]
  for (const [text, technique] of cases) {
    const selected = route({ department: 'data', taskText: text, uiCard: false })
    assert.deepEqual(selected.skillIds, [SYNKORA_DATA_STANDARD_ID, technique], text)
    assert.equal(selected.skillIds.length, 2, text)
  }
})

test('Research recebe contrato nativo e evita workflow deep-research com subagentes', () => {
  const deepResearch = CURATED_SKILLS.find((skill) => skill.id === 'deep-research')
  assert.equal(deepResearch?.manualOnly, true)
  assert.equal(deepResearch?.defaultFor, undefined)
  const cases = [
    ['Extrair a spec do codigo legado sem documentacao.', 'spec-miner'],
    ['Escrever PRD com user stories e criterios de aceitacao.', 'write-spec'],
    ['Comparar concorrentes e produzir benchmark de mercado.', 'competitive-brief'],
    ['Estimar TAM, SAM e SOM com premissas explicitas.', 'market-sizing-analysis'],
    ['Sintetizar entrevistas e survey de user research.', 'synthesize-research'],
    ['Fazer pesquisa profunda multi-source com fontes primarias.', 'research']
  ]
  for (const [text, technique] of cases) {
    const selected = route({ department: 'research', taskText: text, uiCard: false })
    assert.deepEqual(selected.skillIds, [SYNKORA_RESEARCH_STANDARD_ID, technique], text)
    assert.equal(selected.skillIds.includes('deep-research'), false, text)
  }
})

test('Copy recebe contrato nativo e uma tecnica adequada ao canal', () => {
  const cases = [
    ['Revisar o texto contra a brand voice e o guia de estilo.', 'brand-review'],
    ['Criar uma sequencia de emails de onboarding com exit conditions.', 'email-sequence'],
    ['Escrever um carrossel para LinkedIn.', 'social'],
    ['Escrever a landing page e o CTA de conversao.', 'landing-page-copy'],
    ['Otimizar o artigo para SEO, AEO e llms.txt.', 'ai-seo'],
    ['Definir a voz da marca e o tom de voz.', 'brand-voice'],
    ['Escrever microcopy, empty state e mensagem de erro.', 'ux-writing'],
    ['Fazer copy edit e revisar o rascunho.', 'copy-editing'],
    ['Humanizar o texto robotico escrito por IA.', 'humanizer']
  ]
  for (const [text, technique] of cases) {
    const selected = route({ department: 'copy', taskText: text, uiCard: false })
    assert.deepEqual(selected.skillIds, [SYNKORA_COPY_STANDARD_ID, technique], text)
    assert.equal(selected.skillIds.length, 2, text)
  }
})

test('QA de Data, Research e Copy usa somente os contratos independentes', () => {
  const cases = [
    {
      department: 'data',
      text: 'Validar metricas dbt, joins, denominadores e reconciliacao.',
      expected: [SYNKORA_DATA_STANDARD_ID, SYNKORA_DATA_QA_ID]
    },
    {
      department: 'research',
      text: 'Validar fontes, claims, datas, contraevidencia e sintese.',
      expected: [SYNKORA_RESEARCH_STANDARD_ID, SYNKORA_RESEARCH_QA_ID]
    },
    {
      department: 'copy',
      text: 'Validar claims, voz, canal, acessibilidade e consentimento.',
      expected: [SYNKORA_COPY_STANDARD_ID, SYNKORA_COPY_QA_ID]
    }
  ]
  for (const { department, text, expected } of cases) {
    const selected = route({
      department,
      phase: 'qa',
      taskText: text,
      uiCard: false,
      explicitSkillIds: ['sql-queries', 'research', 'copywriting'],
      availableCapabilities: ['read']
    })
    assert.deepEqual(selected.skillIds, expected, text)
    assert.deepEqual(selected.agentIds, [], text)
    assert.deepEqual(selected.incompatibilities, [], text)
  }
})

test('contratos de conhecimento falham fechado e nao atravessam departamentos', () => {
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'data', 'dev', false), [
    SYNKORA_DATA_STANDARD_ID
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'data', 'qa', false), [
    SYNKORA_DATA_STANDARD_ID,
    SYNKORA_DATA_QA_ID
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'research', 'qa', false), [
    SYNKORA_RESEARCH_STANDARD_ID,
    SYNKORA_RESEARCH_QA_ID
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'copy', 'qa', false), [
    SYNKORA_COPY_STANDARD_ID,
    SYNKORA_COPY_QA_ID
  ])

  assert.deepEqual(
    route({ department: 'research', taskText: 'Documentar como o projeto usa dbt.', uiCard: false }).skillIds,
    [SYNKORA_RESEARCH_STANDARD_ID, 'research']
  )
  assert.deepEqual(
    route({ department: 'data', taskText: 'A coluna se chama social_post.', uiCard: false }).skillIds,
    [SYNKORA_DATA_STANDARD_ID, 'sql-queries']
  )
})

test('Data e Copy visuais combinam contrato funcional com UI sem contaminar o QA', () => {
  const dataDev = route({
    department: 'data',
    taskText: 'Criar um dashboard responsivo com KPIs e filtros visuais.',
    uiCard: true
  })
  assert.deepEqual(dataDev.skillIds, [
    SYNKORA_DATA_STANDARD_ID,
    SYNKORA_FRONTEND_STANDARD_ID,
    IMPECCABLE_SKILL_ID,
    'build-dashboard'
  ])

  const dataQa = route({
    department: 'data',
    phase: 'qa',
    taskText: 'Validar o dashboard responsivo com KPIs e filtros visuais.',
    uiCard: true,
    availableCapabilities: ['read', 'browser']
  })
  assert.deepEqual(dataQa.skillIds, [
    SYNKORA_DATA_STANDARD_ID,
    SYNKORA_DATA_QA_ID,
    SYNKORA_FRONTEND_STANDARD_ID,
    SYNKORA_UI_QA_ID
  ])

  const copyQa = route({
    department: 'copy',
    phase: 'qa',
    taskText: 'Validar microcopy, empty state e mensagem de erro da tela.',
    uiCard: true,
    availableCapabilities: ['read', 'browser']
  })
  assert.deepEqual(copyQa.skillIds, [
    SYNKORA_COPY_STANDARD_ID,
    SYNKORA_COPY_QA_ID,
    SYNKORA_FRONTEND_STANDARD_ID,
    SYNKORA_UI_QA_ID
  ])
  assert.equal(copyQa.skillIds.includes('ux-writing'), false)
})

test('DevOps é uma lane própria dentro de Back e evita near-misses de backend/dados', () => {
  for (const text of [
    'Criar um workflow do GitHub Actions para build e testes.',
    'Corrigir o state lock do Terraform antes do rollout.',
    'Definir SLO, error budget e alertas PromQL.',
    'Revisar o Dockerfile e a imagem de container.'
  ]) assert.equal(isDevOpsWork('back', text), true, text)

  for (const text of [
    'Implementar o endpoint que publica uma entidade chamada Release.',
    'Criar pipeline de dados para normalização no serviço.',
    'Corrigir a API, sem mudanças no pipeline de deployment.',
    'Revisar Terraform como palavra em um relatório de pesquisa.'
  ]) assert.equal(isDevOpsWork(text.includes('pesquisa') ? 'research' : 'back', text), false, text)

  assert.deepEqual(
    route({
      department: 'back',
      taskText: 'Criar workflow do GitHub Actions com cache e artefato de build.',
      uiCard: false
    }).skillIds,
    [SYNKORA_DEVOPS_STANDARD_ID, 'github-actions-templates']
  )
  assert.deepEqual(
    route({
      department: 'back',
      taskText: 'Corrigir state drift e lock concorrente do Terraform.',
      uiCard: false
    }).skillIds,
    [SYNKORA_DEVOPS_STANDARD_ID, 'terraform-skill']
  )
  assert.deepEqual(
    route({
      department: 'back',
      taskText: 'Definir SLO e alertas por error budget com PromQL.',
      uiCard: false
    }).skillIds,
    [SYNKORA_DEVOPS_STANDARD_ID, 'slo-implementation']
  )
})

test('Cyber recebe contrato defensivo e somente a técnica contextual', () => {
  const cases = [
    ['Auditar prompt injection no fluxo de LLM.', 'prompt-injection-defense'],
    ['Verificar vazamento de secrets e credenciais no histórico.', 'secrets-audit'],
    ['Criar threat model STRIDE dos trust boundaries.', 'security-threat-model'],
    ['Revisar OAuth PKCE e rotação de refresh token.', 'oauth']
  ]
  for (const [text, technique] of cases) {
    const selected = route({ department: 'cyber', taskText: text, uiCard: false })
    assert.deepEqual(selected.skillIds, [SYNKORA_CYBER_STANDARD_ID, technique], text)
    assert.equal(selected.skillIds.length, 2, text)
  }
})

test('QA de Back, DevOps e Cyber usa contratos independentes sem técnica do DEV', () => {
  const cases = [
    {
      department: 'back',
      text: 'Validar contrato e autorização dos endpoints REST.',
      expected: [SYNKORA_BACKEND_STANDARD_ID, SYNKORA_BACKEND_QA_ID]
    },
    {
      department: 'back',
      text: 'Validar o workflow GitHub Actions, artefato e rollback do deployment pipeline.',
      expected: [SYNKORA_DEVOPS_STANDARD_ID, SYNKORA_DEVOPS_QA_ID]
    },
    {
      department: 'cyber',
      text: 'Validar a remediação de prompt injection e MCP security.',
      expected: [SYNKORA_CYBER_STANDARD_ID, SYNKORA_CYBER_QA_ID]
    }
  ]
  for (const { department, text, expected } of cases) {
    const selected = route({
      department,
      phase: 'qa',
      taskText: text,
      uiCard: false,
      explicitSkillIds: ['oauth', 'secrets-audit', 'github-actions-templates'],
      availableCapabilities: ['read']
    })
    assert.deepEqual(selected.skillIds, expected, text)
    assert.deepEqual(selected.agentIds, [], text)
    assert.deepEqual(selected.incompatibilities, [], text)
  }
})

test('skill explícita vence fallback e o plano limita método, técnica e agente', () => {
  const selected = route({
    taskText: 'Ajuste o layout da tela e seus componentes.',
    explicitSkillIds: ['better-layout', 'better-accessibility', 'react-best-practices'],
    explicitAgentIds: ['ui-ux-designer', 'frontend-developer']
  })

  assert.deepEqual(selected.skillIds, [
    SYNKORA_FRONTEND_STANDARD_ID,
    IMPECCABLE_SKILL_ID,
    'better-accessibility'
  ])
  assert.deepEqual(selected.agentIds, ['ui-ux-designer'])
  assert.equal(selected.impeccableOperation, 'layout')
})

test('defaultFor é somente fallback e método visual concorrente não entra', () => {
  const selected = route({
    taskText: 'Ajuste o layout da interface.',
    explicitSkillIds: []
  })

  assert.deepEqual(selected.skillIds, [
    SYNKORA_FRONTEND_STANDARD_ID,
    IMPECCABLE_SKILL_ID,
    'react-best-practices'
  ])
  assert.equal(selected.skillIds.includes('better-layout'), false)
})

test('FAST e delegation none nunca expõem agentes', () => {
  for (const patch of [
    { executionMode: 'fast' },
    { executionMode: 'deep', delegationMode: 'none' }
  ]) {
    const selected = route({
      taskText: 'Corrija o espaçamento da tela.',
      explicitAgentIds: ['ui-ux-designer'],
      ...patch
    })
    assert.deepEqual(selected.agentIds, [])
  }
})

test('DEV e QA usam planos separados; QA não herda Impeccable nem agente', () => {
  const common = {
    taskText: 'Ajuste o layout responsivo da tela e valide no navegador.',
    uiCard: true,
    explicitSkillIds: ['impeccable', 'webapp-testing'],
    explicitAgentIds: ['ui-ux-designer']
  }
  const dev = route({ ...common, phase: 'dev' })
  const qa = route({ ...common, phase: 'qa' })

  assert.deepEqual(dev.skillIds, [SYNKORA_FRONTEND_STANDARD_ID, IMPECCABLE_SKILL_ID])
  assert.deepEqual(dev.agentIds, ['ui-ux-designer'])
  assert.deepEqual(qa.skillIds, [
    SYNKORA_FRONTEND_STANDARD_ID,
    SYNKORA_UI_QA_ID
  ])
  assert.deepEqual(qa.agentIds, [])
  assert.equal(qa.impeccableOperation, undefined)
  assert.equal(qa.uiOperation, undefined)

  const qaWithOnlyDevMethod = route({
    ...common,
    phase: 'qa',
    explicitSkillIds: ['impeccable']
  })
  assert.deepEqual(qaWithOnlyDevMethod.skillIds, [
    SYNKORA_FRONTEND_STANDARD_ID,
    SYNKORA_UI_QA_ID
  ])
})

test('QA de UI falha fechado sem contrato e sem revisor independente', () => {
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([], 'front', 'dev'),
    [SYNKORA_FRONTEND_STANDARD_ID, IMPECCABLE_SKILL_ID]
  )
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([], 'front', 'qa'),
    [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_UI_QA_ID]
  )
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([SYNKORA_FRONTEND_STANDARD_ID], 'design', 'qa'),
    [SYNKORA_UI_QA_ID]
  )
  assert.deepEqual(
    missingMandatoryUiPhaseSkills(
      [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_UI_QA_ID],
      'front',
      'qa'
    ),
    []
  )
  assert.deepEqual(
    missingMandatoryUiPhaseSkills([], 'design', 'dev', true, true),
    [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_DESIGN_SYSTEM_STANDARD_ID]
  )
  assert.deepEqual(
    missingMandatoryUiPhaseSkills(
      [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_UI_QA_ID],
      'design',
      'qa',
      true,
      true
    ),
    [SYNKORA_DESIGN_SYSTEM_QA_ID]
  )
  assert.deepEqual(
    missingMandatoryUiPhaseSkills(
      [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_UI_QA_ID, SYNKORA_DESIGN_SYSTEM_QA_ID],
      'design',
      'qa',
      true,
      true
    ),
    []
  )
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'qa', false), [
    SYNKORA_BACKEND_STANDARD_ID,
    SYNKORA_BACKEND_QA_ID
  ])

  const fastQa = route({
    phase: 'qa',
    uiCard: true,
    executionMode: 'fast',
    taskText: 'Valide a tela responsiva.',
    explicitSkillIds: ['webapp-testing']
  })
  assert.deepEqual(fastQa.skillIds, [SYNKORA_FRONTEND_STANDARD_ID, SYNKORA_UI_QA_ID])
  assert.deepEqual(fastQa.agentIds, [])
})

test('REVIEW usa allowlist curta e só soma a lente cyber quando o risco exige', () => {
  const normal = route({
    phase: 'review',
    taskText: 'Revise o diff.',
    explicitSkillIds: ['code-review-and-quality', 'impeccable']
  })
  const sensitive = route({
    phase: 'review',
    taskText: 'Revise o diff de autenticação.',
    explicitSkillIds: [],
    securitySensitive: true
  })

  assert.deepEqual(normal.skillIds, [SYNKORA_REVIEW_STANDARD_ID])
  assert.deepEqual(normal.agentIds, [])
  assert.deepEqual(sensitive.skillIds, [SYNKORA_REVIEW_STANDARD_ID])

  const devOnlyStamp = route({
    phase: 'review',
    taskText: 'Revise o diff.',
    explicitSkillIds: ['impeccable']
  })
  assert.deepEqual(devOnlyStamp.skillIds, [SYNKORA_REVIEW_STANDARD_ID])
})

test('o catálogo contém as 13 skills permitidas do Superpowers com paths exatos', () => {
  const byId = new Map(CURATED_SKILLS.map((skill) => [skill.id, skill]))
  for (const id of SUPERPOWERS_IDS) {
    const skill = byId.get(id)
    assert.ok(skill, `skill ausente: ${id}`)
    assert.equal(skill.source.repo, 'obra/superpowers')
    assert.equal(skill.source.path, `skills/${id}`)
    assert.equal(skill.source.ref, 'main')
  }
  assert.equal(SUPERPOWERS_IDS.includes('writing-skills'), false)
})

test('skills manuais não entram na injeção automática do departamento', () => {
  const defs = [
    { id: 'normal', kind: 'skill', depts: ['back'], group: 'x' },
    { id: 'manual', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true },
    { id: 'other', kind: 'skill', depts: ['front'], group: 'x' }
  ]
  const installed = new Set(['normal', 'manual', 'other'])
  assert.deepEqual(
    selectInstalledIdsForDepartment(defs, (id) => installed.has(id), 'back'),
    ['normal']
  )
})

test('uma escolha manual não vaza para a próxima execução no mesmo workspace', () => {
  const defs = [
    { id: 'normal', kind: 'skill', depts: ['back'], group: 'x' },
    { id: 'manual-a', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true },
    { id: 'manual-b', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true },
    { id: 'missing', kind: 'skill', depts: ['back'], group: 'x', manualOnly: true }
  ]
  const installed = new Set(['normal', 'manual-a', 'manual-b'])
  assert.deepEqual(
    selectInstalledManualOnlyIdsToPrune(
      defs,
      (id) => installed.has(id),
      ['normal', 'manual-b']
    ),
    ['manual-a']
  )
})

test('injeção preserva uma skill local em colisão e não deixa cópia parcial', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-collision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'brainstorming')
  const claude = join(root, 'project', '.claude', 'skills', 'brainstorming')
  const agents = join(root, 'project', '.agents', 'skills', 'brainstorming')
  mkdirSync(source, { recursive: true })
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'versão da biblioteca\n', 'utf8')
  writeFileSync(join(claude, 'SKILL.md'), 'versão local do projeto\n', 'utf8')

  assert.equal(syncManagedWorkspaceSkillCopies(source, [claude, agents], 'brainstorming'), false)
  assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'versão local do projeto\n')
  assert.equal(existsSync(agents), false, 'o preflight deve impedir uma injeção parcial')
})

test('marcador inválido nunca autoriza sobrescrever uma skill local', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-invalid-marker-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'brainstorming')
  const local = join(root, 'project', '.claude', 'skills', 'brainstorming')
  mkdirSync(source, { recursive: true })
  mkdirSync(local, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'mesmos bytes\n', 'utf8')
  writeFileSync(join(local, 'SKILL.md'), 'mesmos bytes\n', 'utf8')
  writeFileSync(join(local, MANAGED_WORKSPACE_SKILL_MARKER), '{inválido', 'utf8')

  assert.equal(syncManagedWorkspaceSkillCopies(source, [local], 'brainstorming'), false)
  assert.equal(readFileSync(join(local, MANAGED_WORKSPACE_SKILL_MARKER), 'utf8'), '{inválido')
})

test('injeção pode atualizar somente cópias comprovadamente gerenciadas', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-managed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'brainstorming')
  const claude = join(root, 'project', '.claude', 'skills', 'brainstorming')
  const agents = join(root, 'project', '.agents', 'skills', 'brainstorming')
  mkdirSync(source, { recursive: true })
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'versão nova\n', 'utf8')
  writeFileSync(join(claude, 'SKILL.md'), 'versão antiga\n', 'utf8')
  writeFileSync(
    join(claude, MANAGED_WORKSPACE_SKILL_MARKER),
    `${JSON.stringify({ managedBy: 'synkora', id: 'brainstorming' })}\n`,
    'utf8'
  )

  assert.equal(syncManagedWorkspaceSkillCopies(source, [claude, agents], 'brainstorming'), true)
  assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'versão nova\n')
  assert.equal(readFileSync(join(agents, 'SKILL.md'), 'utf8'), 'versão nova\n')
  assert.equal(existsSync(join(agents, MANAGED_WORKSPACE_SKILL_MARKER)), true)
})

test('skill app-owned repara bytes adulterados mesmo com marcador e versão atuais', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-app-owned-repair-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'synkora-frontend-standard')
  const destination = join(root, 'project', '.agents', 'skills', 'synkora-frontend-standard')
  mkdirSync(source, { recursive: true })
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'contrato oficial\n', 'utf8')
  writeFileSync(join(destination, 'SKILL.md'), 'conteúdo adulterado\n', 'utf8')
  writeFileSync(join(destination, 'extra.md'), 'arquivo inesperado\n', 'utf8')
  writeFileSync(
    join(destination, MANAGED_WORKSPACE_SKILL_MARKER),
    `${JSON.stringify({
      managedBy: 'synkora',
      id: 'synkora-frontend-standard',
      version: 'bundled:sha-atual'
    })}\n`,
    'utf8'
  )

  assert.equal(managedWorkspaceSkillContentsMatch(source, destination), false)
  assert.equal(
    syncManagedWorkspaceSkillCopies(
      source,
      [destination],
      'synkora-frontend-standard',
      'bundled:sha-atual',
      true
    ),
    true
  )
  assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'contrato oficial\n')
  assert.equal(existsSync(join(destination, 'extra.md')), false)
  assert.equal(managedWorkspaceSkillContentsMatch(source, destination), true)
})

test('workspace expõe exatamente a união ativa e poda apenas cópias marcadas', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-skill-prune-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const roots = [join(root, '.claude', 'skills'), join(root, '.agents', 'skills')]
  const makeSkill = (skillRoot, id, marker) => {
    const dir = join(skillRoot, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `${id}\n`, 'utf8')
    if (marker) {
      writeFileSync(
        join(dir, MANAGED_WORKSPACE_SKILL_MARKER),
        `${JSON.stringify(marker)}\n`,
        'utf8'
      )
    }
    return dir
  }

  const removedClaude = makeSkill(roots[0], 'removed', {
    managedBy: 'synkora',
    id: 'removed'
  })
  const removedAgents = makeSkill(roots[1], 'removed', {
    managedBy: 'synkora',
    id: 'removed'
  })
  const kept = makeSkill(roots[0], 'kept', { managedBy: 'synkora', id: 'kept' })
  const local = makeSkill(roots[0], 'local', undefined)
  const forged = makeSkill(roots[0], 'forged', {
    managedBy: 'synkora',
    id: 'outro-id'
  })

  assert.deepEqual(pruneUnrequestedManagedWorkspaceSkills(roots, new Set(['kept'])), ['removed'])
  assert.equal(existsSync(removedClaude), false)
  assert.equal(existsSync(removedAgents), false)
  assert.equal(existsSync(kept), true)
  assert.equal(existsSync(local), true)
  assert.equal(existsSync(forged), true)
})

test('pacote privado materializa a arvore completa fora de .claude e .agents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-private-skill-tree-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'ui-contract')
  const cwd = join(root, 'workspace')
  const runtimeRoot = join(root, 'private-runtime')
  mkdirSync(join(source, 'references', 'nested'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'contrato raiz\n', 'utf8')
  writeFileSync(join(source, 'references', 'layout.md'), 'regras de layout\n', 'utf8')
  writeFileSync(
    join(source, 'references', 'nested', 'evidence.md'),
    'evidencia visual\n',
    'utf8'
  )

  const destination = materializePrivateSkillPackage(
    source,
    runtimeRoot,
    'pane-ui-01',
    'run-ui-01',
    'ui-contract'
  )

  assert.equal(
    destination,
    join(runtimeRoot, 'pane-ui-01', 'run-ui-01', 'ui-contract').replace(/\\/g, '/')
  )
  assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), 'contrato raiz\n')
  assert.equal(
    readFileSync(join(destination, 'references', 'layout.md'), 'utf8'),
    'regras de layout\n'
  )
  assert.equal(
    readFileSync(join(destination, 'references', 'nested', 'evidence.md'), 'utf8'),
    'evidencia visual\n'
  )
  assert.equal(existsSync(join(cwd, '.claude')), false)
  assert.equal(existsSync(join(cwd, '.agents')), false)
})

test('remocao de pacote privado e limitada ao pane encerrado', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-private-skill-pane-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'ui-contract')
  const cwd = join(root, 'workspace')
  const runtimeRoot = join(root, 'private-runtime')
  mkdirSync(source, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'contrato\n', 'utf8')

  const paneA = materializePrivateSkillPackage(
    source,
    runtimeRoot,
    'pane-a',
    'run-a',
    'ui-contract'
  )
  const paneB = materializePrivateSkillPackage(
    source,
    runtimeRoot,
    'pane-b',
    'run-b',
    'ui-contract'
  )
  const runtimeSentinel = join(runtimeRoot, 'local.txt')
  writeFileSync(runtimeSentinel, 'nao pertence ao pane\n', 'utf8')

  assert.equal(removePrivateSkillPlan(runtimeRoot, 'pane-a'), true)
  assert.equal(existsSync(paneA), false)
  assert.equal(readFileSync(join(paneB, 'SKILL.md'), 'utf8'), 'contrato\n')
  assert.equal(readFileSync(runtimeSentinel, 'utf8'), 'nao pertence ao pane\n')
})

test('geracoes e skills privadas sao removidas sem afetar vizinhas validas', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-private-skill-generation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'contract')
  const runtimeRoot = join(root, 'private-runtime')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'contrato\n', 'utf8')

  const oldSkill = materializePrivateSkillPackage(
    source,
    runtimeRoot,
    'pane-shared',
    'run-old',
    'skill-a'
  )
  const currentA = materializePrivateSkillPackage(
    source,
    runtimeRoot,
    'pane-shared',
    'run-current',
    'skill-a'
  )
  const currentB = materializePrivateSkillPackage(
    source,
    runtimeRoot,
    'pane-shared',
    'run-current',
    'skill-b'
  )

  assert.equal(
    removePrivateSkillPlan(runtimeRoot, 'pane-shared', 'run-old'),
    true
  )
  assert.equal(existsSync(oldSkill), false)
  assert.equal(readFileSync(join(currentA, 'SKILL.md'), 'utf8'), 'contrato\n')
  assert.equal(readFileSync(join(currentB, 'SKILL.md'), 'utf8'), 'contrato\n')

  assert.equal(
    removePrivateSkillPlan(runtimeRoot, 'pane-shared', 'run-current', 'skill-b'),
    true
  )
  assert.equal(existsSync(currentB), false)
  assert.equal(readFileSync(join(currentA, 'SKILL.md'), 'utf8'), 'contrato\n')
})

test('path traversal e recusado sem escrever ou remover fora da raiz privada', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-private-skill-traversal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'ui-contract')
  const cwd = join(root, 'workspace')
  const runtimeRoot = join(root, 'private-runtime')
  const sentinel = join(root, 'sentinel.txt')
  mkdirSync(source, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), 'contrato\n', 'utf8')
  writeFileSync(sentinel, 'intacto\n', 'utf8')

  for (const [paneId, phaseRun, id] of [
    ['../escape', 'run', 'ui-contract'],
    ['pane', '../escape', 'ui-contract'],
    ['pane', 'run', '../escape'],
    ['pane/filho', 'run', 'ui-contract'],
    ['C:\\escape', 'run', 'ui-contract']
  ]) {
    assert.throws(
      () => materializePrivateSkillPackage(source, runtimeRoot, paneId, phaseRun, id),
      /identidade inv.lida/
    )
  }
  for (const paneId of ['../escape', 'pane/filho', 'C:\\escape']) {
    assert.equal(removePrivateSkillPlan(runtimeRoot, paneId), false)
  }
  assert.equal(removePrivateSkillPlan(runtimeRoot, 'pane', '../escape'), false)
  assert.equal(removePrivateSkillPlan(runtimeRoot, 'pane', 'run', '../escape'), false)
  assert.equal(removePrivateSkillPlan(runtimeRoot, 'pane', undefined, 'ui-contract'), false)

  assert.equal(readFileSync(sentinel, 'utf8'), 'intacto\n')
  assert.equal(existsSync(join(root, 'escape')), false)
})

test('agents gerenciados obedecem à mesma fronteira exata sem tocar em arquivo local', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-agent-prune-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const library = join(root, 'library')
  const agentRoot = join(root, 'project', '.claude', 'agents')
  mkdirSync(library, { recursive: true })
  mkdirSync(agentRoot, { recursive: true })

  const managedSource = join(library, 'managed.md')
  const managedDestination = join(agentRoot, 'managed.md')
  const keptSource = join(library, 'kept.md')
  const keptDestination = join(agentRoot, 'kept.md')
  const localDestination = join(agentRoot, 'local.md')
  writeFileSync(managedSource, 'managed agent\n', 'utf8')
  writeFileSync(keptSource, 'kept agent\n', 'utf8')
  writeFileSync(localDestination, 'local agent\n', 'utf8')

  assert.equal(syncManagedWorkspaceAgentCopy(managedSource, managedDestination, 'managed', 'v1'), true)
  assert.equal(syncManagedWorkspaceAgentCopy(keptSource, keptDestination, 'kept', 'v1'), true)
  assert.equal(existsSync(`${managedDestination}${MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX}`), true)

  assert.deepEqual(
    pruneUnrequestedManagedWorkspaceAgents(
      agentRoot,
      new Set(['kept']),
      { managed: managedSource, kept: keptSource }
    ),
    ['managed']
  )
  assert.equal(existsSync(managedDestination), false)
  assert.equal(existsSync(`${managedDestination}${MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX}`), false)
  assert.equal(existsSync(keptDestination), true)
  assert.equal(readFileSync(localDestination, 'utf8'), 'local agent\n')
})

test('sidecar orfao e removido sem tocar em arquivo local novo', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-agent-orphan-sidecar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const agentRoot = join(root, 'project', '.claude', 'agents')
  const orphanDestination = join(agentRoot, 'removed.md')
  const orphanMarker = `${orphanDestination}${MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX}`
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(
    orphanMarker,
    `${JSON.stringify({ managedBy: 'synkora', id: 'removed', contentSha: 'sha-antigo' })}\n`,
    'utf8'
  )
  assert.deepEqual(
    pruneUnrequestedManagedWorkspaceAgents(agentRoot, new Set(), {}),
    []
  )
  assert.equal(existsSync(orphanMarker), false)

  writeFileSync(orphanDestination, 'criado depois pelo projeto\n', 'utf8')
  assert.deepEqual(
    pruneUnrequestedManagedWorkspaceAgents(agentRoot, new Set(), {}),
    []
  )
  assert.equal(readFileSync(orphanDestination, 'utf8'), 'criado depois pelo projeto\n')
  assert.equal(existsSync(orphanMarker), false)
})

test('agent gerenciado editado localmente nunca e sobrescrito nem apagado', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-agent-local-edit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'ui-reviewer.md')
  const agentRoot = join(root, 'project', '.claude', 'agents')
  const destination = join(agentRoot, 'ui-reviewer.md')
  mkdirSync(join(root, 'library'), { recursive: true })
  writeFileSync(source, 'versao da biblioteca\n', 'utf8')
  assert.equal(syncManagedWorkspaceAgentCopy(source, destination, 'ui-reviewer', 'v1'), true)

  writeFileSync(destination, 'edicao local divergente\n', 'utf8')
  writeFileSync(source, 'nova versao da biblioteca\n', 'utf8')

  assert.equal(syncManagedWorkspaceAgentCopy(source, destination, 'ui-reviewer', 'v2'), false)
  assert.equal(readFileSync(destination, 'utf8'), 'edicao local divergente\n')
  assert.deepEqual(
    pruneUnrequestedManagedWorkspaceAgents(
      agentRoot,
      new Set(),
      { 'ui-reviewer': source }
    ),
    []
  )
  assert.equal(readFileSync(destination, 'utf8'), 'edicao local divergente\n')
})

test('colisão com agent local homônimo é preservada e nunca ganha marcador', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-agent-collision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'library', 'ui-reviewer.md')
  const destination = join(root, 'project', '.claude', 'agents', 'ui-reviewer.md')
  mkdirSync(join(root, 'library'), { recursive: true })
  mkdirSync(join(root, 'project', '.claude', 'agents'), { recursive: true })
  writeFileSync(source, 'library version\n', 'utf8')
  writeFileSync(destination, 'project local version\n', 'utf8')

  assert.equal(syncManagedWorkspaceAgentCopy(source, destination, 'ui-reviewer', 'v1'), false)
  assert.equal(readFileSync(destination, 'utf8'), 'project local version\n')
  assert.equal(existsSync(`${destination}${MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX}`), false)
})

test('leases preservam a união das skills de panes paralelos até cada pane encerrar', () => {
  const leases = new WorkspaceSkillLeaseRegistry()
  leases.acquire('pane-a', {
    cwd: 'C:/repo',
    workspaceKey: 'c:/repo',
    ids: ['using-superpowers', 'using-superpowers']
  })
  leases.acquire('pane-b', {
    cwd: 'C:/repo',
    workspaceKey: 'c:/repo',
    ids: ['executing-plans']
  })
  leases.acquire('pane-c', {
    cwd: 'C:/outro',
    workspaceKey: 'c:/outro',
    ids: ['writing-plans']
  })

  assert.deepEqual(leases.activeIds('c:/repo'), [
    'using-superpowers',
    'executing-plans'
  ])
  assert.equal(leases.release('pane-a')?.cwd, 'C:/repo')
  assert.deepEqual(leases.activeIds('c:/repo'), ['executing-plans'])
  assert.deepEqual(leases.activeIds('c:/outro'), ['writing-plans'])
  assert.equal(leases.release('inexistente'), undefined)
})

test('o catálogo mantém métodos externos de planejamento somente para uso manual', () => {
  const catalogPlanning = CURATED_SKILLS.filter(
    (skill) => skill.kind === 'skill' && skill.group.toLocaleLowerCase('pt-BR') === 'planejamento'
  )

  assert.deepEqual(catalogPlanning.map((skill) => skill.id), PLANNING_IDS)
  assert.ok(catalogPlanning.every((skill) => skill.manualOnly === true))
  assert.deepEqual(selectInstalledPlanningIds(CURATED_SKILLS, () => true), [])

  const automaticallyRouted = new Set(
    selectInstalledIdsForDepartment(CURATED_SKILLS, () => true, 'research')
  )
  for (const id of PLANNING_IDS) assert.equal(automaticallyRouted.has(id), false, id)
})

test('o Maestro usa apenas o standard nativo mesmo com métodos externos instalados', () => {
  const defs = [
    {
      id: SYNKORA_PLANNING_STANDARD_ID,
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      orchestratorDefault: true,
      allowedPhases: ['planning'],
      adapter: 'synkora-native'
    },
    {
      id: 'writing-plans',
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      manualOnly: true
    },
    {
      id: 'brainstorming',
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      manualOnly: true,
      orchestratorDefault: true
    },
    {
      id: 'future-planner',
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      manualOnly: true,
      orchestratorDefault: true
    }
  ]

  const installed = new Set(defs.map((skill) => skill.id))
  assert.deepEqual(
    selectInstalledPlanningIds(defs, (id) => installed.has(id)),
    [SYNKORA_PLANNING_STANDARD_ID]
  )

  installed.delete('writing-plans')
  installed.delete('brainstorming')
  assert.deepEqual(
    selectInstalledPlanningIds(defs, (id) => installed.has(id)),
    [SYNKORA_PLANNING_STANDARD_ID]
  )
})

test('planejamento falha fechado quando o standard nativo não está disponível', () => {
  const externalOnly = [
    {
      id: 'writing-plans',
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      manualOnly: true,
      orchestratorDefault: true
    },
    {
      id: 'brainstorming',
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      manualOnly: true
    }
  ]
  assert.deepEqual(selectInstalledPlanningIds(externalOnly, () => true), [])

  const nativeNotInstalled = [
    ...externalOnly,
    {
      id: SYNKORA_PLANNING_STANDARD_ID,
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      allowedPhases: ['planning'],
      adapter: 'synkora-native'
    }
  ]
  assert.deepEqual(
    selectInstalledPlanningIds(nativeNotInstalled, (id) => id !== SYNKORA_PLANNING_STANDARD_ID),
    []
  )

  const externalImpersonatingNative = [
    ...externalOnly,
    {
      id: SYNKORA_PLANNING_STANDARD_ID,
      kind: 'skill',
      depts: ['research'],
      group: 'planejamento',
      allowedPhases: ['planning'],
      adapter: 'impeccable-operation'
    }
  ]
  assert.deepEqual(selectInstalledPlanningIds(externalImpersonatingNative, () => true), [])
})

test('front-end também recebe os métodos de implementação, depuração e revisão aplicáveis', () => {
  const frontIds = new Set(selectInstalledIdsForDepartment(CURATED_SKILLS, () => true, 'front'))
  for (const id of [
    'test-driven-development',
    'verification-before-completion',
    'receiving-code-review',
    'systematic-debugging'
  ]) {
    assert.ok(frontIds.has(id), `${id} deveria estar disponível para front-end`)
  }
  assert.equal(frontIds.has('requesting-code-review'), false, 'skill manual não deve ser injetada')
})

test('workflows que disputariam git/review do Synkora são somente explícitos', () => {
  const manual = new Set(
    CURATED_SKILLS.filter((skill) => skill.manualOnly).map((skill) => skill.id)
  )
  for (const id of [
    'executing-plans',
    'finishing-a-development-branch',
    'requesting-code-review',
    'subagent-driven-development',
    'using-git-worktrees',
    'using-superpowers'
  ]) {
    assert.ok(manual.has(id), `${id} deveria exigir seleção explícita`)
  }
})

test('as personas impedem que Superpowers crie um segundo fluxo de execução', () => {
  const personaSource = readFileSync(new URL('../src/main/maestro.ts', import.meta.url), 'utf8')
  assert.match(personaSource, /save_project_plan/)
  assert.match(personaSource, /NEVER create or commit docs\/superpowers/)
  assert.match(personaSource, /start_project_mission/)
  assert.match(personaSource, /SYNKORA PRECEDENCE/)
  assert.match(personaSource, /docs\/superpowers\/specs/)
  assert.match(personaSource, /integrate_mission/)
  assert.match(personaSource, /GREENFIELD ORIGIN/)
  assert.match(personaSource, /CURRENT persisted status/)
  assert.match(personaSource, /awaiting_release/)
  assert.match(personaSource, /done: the original roadmap is history/)
  assert.match(personaSource, /focused-mission flow/)
  assert.match(personaSource, /do not reopen the old roadmap implicitly/)
  assert.match(personaSource, /WINDOWS VISUAL COMPANION/)
  assert.match(personaSource, /Program Files\\\\Git\\\\bin\\\\bash\.exe/)
})

test('classificador distingue superficie visual de trabalho tecnico no front', () => {
  assert.equal(isUiSurfaceWork('front', 'Corrija o layout responsivo da tela de tarefas.'), true)
  assert.equal(isUiSurfaceWork('design', 'Refine o header e o menu mobile.'), true)
  assert.equal(
    isUiSurfaceWork('front', 'Refine o visual, a harmonia e a responsividade do frontend.'),
    true
  )
  assert.equal(
    isUiSurfaceWork('front', 'Refactor the data adapter and TypeScript types; no user interface changes.'),
    false
  )
  assert.equal(
    isUiSurfaceWork('front', 'Atualize o pipeline de build, sem alteracao na interface.'),
    false
  )
  assert.equal(isUiSurfaceWork('front', 'Refactor only the adapter; no visual changes.'), false)
  assert.equal(isUiSurfaceWork('front', 'Refatore adapter e tipos, sem mudança visual.'), false)
  assert.equal(
    isUiSurfaceWork(
      'front',
      'Corrigir header Authorization no adapter; sem mudanças visuais.'
    ),
    false
  )
  assert.equal(
    isUiSurfaceWork('front', 'Atualizar table types no adapter; no UI changes.'),
    false
  )
  assert.equal(
    isUiSurfaceWork('front', 'Ajustar Dialog protocol RPC no client, sem interface.'),
    false
  )
  assert.equal(
    isUiSurfaceWork('front', 'Ajuste o espaçamento do header. Sem alterações na UI fora do header.'),
    true
  )
  assert.equal(
    isUiSurfaceWork('front', 'Fix the header spacing. No UI changes outside the header.'),
    true
  )
  assert.equal(isUiSurfaceWork('back', 'Implemente o endpoint da pagina.'), false)
  assert.equal(
    isUiSurfaceWork(
      'back',
      'Renderize o template SSR e altere HTML, CSS e o header responsivo.'
    ),
    true
  )
  assert.equal(
    isUiSurfaceWork('back', 'A API devolve os dados usados pelo formulário, sem mudança visual.'),
    false
  )
  assert.equal(
    isUiSurfaceWork(
      'back',
      'Parser de HTML: processar HTML de terceiros no servidor, backend-only, sem mudanças visuais.'
    ),
    false
  )
  assert.equal(
    isUiSurfaceWork('back', 'Minificador CSS no pipeline, sem alterações visuais.'),
    false
  )
  assert.equal(
    isUiSurfaceWork('back', 'Corrigir o header Authorization da API, backend-only; no UI changes.'),
    false
  )
  assert.equal(
    isUiSurfaceWork('back', 'Corrigir o layout binário do protocolo no servidor, sem interface.'),
    false
  )
  assert.equal(
    isUiSurfaceWork('back', 'Ajustar o dialog do protocolo RPC server-only; no visual changes.'),
    false
  )
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'front', 'qa', false), [
    SYNKORA_RUNTIME_QA_ID
  ])
})

test('classificacao usa escopo visual real e ignora feedback operacional do card', () => {
  const technicalFront = {
    department: 'front',
    title: 'Refatorar adapter',
    description: 'Sem mudança visual',
    affectsUi: false,
    feedback: 'retomar o mesmo card depois de reabrir o pane'
  }
  assert.equal(classifyTaskUiWork(technicalFront), false)
  assert.equal(classifyTaskUiWork(technicalFront, 'corrigir overflow e layout responsivo'), true)
  assert.equal(
    classifyTaskUiWork({
      department: 'back',
      title: 'Renderizar template SSR',
      description: 'A entrega altera HTML e CSS visíveis',
      affectsUi: true
    }),
    true
  )
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'dev', true), [
    SYNKORA_BACKEND_STANDARD_ID,
    SYNKORA_FRONTEND_STANDARD_ID,
    IMPECCABLE_SKILL_ID
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'back', 'qa', true), [
    SYNKORA_BACKEND_STANDARD_ID,
    SYNKORA_BACKEND_QA_ID,
    SYNKORA_FRONTEND_STANDARD_ID,
    SYNKORA_UI_QA_ID
  ])
})

test('QA visual classifica o artefato testado sem fingir que altera o produto', () => {
  const qaVisualTest = {
    department: 'qa',
    title: 'Adicionar regressao visual',
    description: 'Criar screenshots com Percy para o modal de ajustes.',
    affectsUi: false
  }
  assert.equal(classifyTaskUiWork(qaVisualTest), false)
  assert.equal(
    classifyTaskUiWork({
      department: 'qa',
      title: 'Corrigir os testes Playwright do modal',
      description: 'Cobrir os estados aberto, fechado e overflow.',
      affectsUi: false
    }),
    false
  )
  assert.equal(
    classifyTaskUiWork({
      ...qaVisualTest,
      title: 'Alterar o modal e atualizar sua regressao visual',
      affectsUi: true
    }),
    true
  )

  const defs = [...ROUTING_DEFS, ...CURATED_SKILLS]
  const devPlan = selectPhaseSkillPlan({
    defs,
    isInstalled: () => true,
    department: 'qa',
    phase: 'dev',
    taskText: `${qaVisualTest.title}\n${qaVisualTest.description}`,
    uiCard: classifyTaskUiWork(qaVisualTest),
    availableCapabilities: ['read', 'write', 'shell', 'browser'],
    executionMode: 'standard',
    delegationMode: 'none'
  })
  assert.deepEqual(devPlan.skillIds, [SYNKORA_QA_STANDARD_ID, 'visual-testing'])
  assert.equal(devPlan.skillIds.includes(SYNKORA_FRONTEND_STANDARD_ID), false)
  assert.equal(devPlan.skillIds.includes(IMPECCABLE_SKILL_ID), false)
})

test('adapter Impeccable fecha uma unica operacao e neutraliza handoffs', () => {
  const adapted = buildSynkoraImpeccableActivation(
    'layout',
    'When a sub-agent tool is available, delegate the assessment.\nWhen done, hand off to `/impeccable polish`.\nKeep the spacing rhythm.'
  )
  assert.ok(adapted)
  assert.match(adapted, /closed, operation-scoped technique/)
  assert.match(adapted, /Apply only \*\*layout\*\*/)
  assert.doesNotMatch(adapted, /\/impeccable polish/)
  assert.doesNotMatch(adapted, /When a sub-agent tool|delegate the assessment/)
  assert.match(adapted, /Do not spawn or delegate/)
  assert.match(adapted, /Repeated cards and rows use one anatomy/)
  assert.doesNotMatch(adapted, /Go all out|Routing:|context\.mjs|new-work\.md|craft-floor/)
  assert.equal(buildSynkoraImpeccableActivation('overdrive', 'x'), undefined)
})

test('operacao visual pondera a intencao dominante em briefings mistos', () => {
  assert.equal(
    detectImpeccableOperation(
      'Corrigir layout e hierarquia do painel\nTambem garantir mobile, overflow e acabamento harmonico.'
    ),
    'layout'
  )
  assert.equal(
    detectImpeccableOperation(
      'Adaptar calendario para mobile e tablet\nPreservar alinhamento, texto longo e harmonia.'
    ),
    'adapt'
  )
  assert.equal(
    detectImpeccableOperation(
      'operation: harden\nAjustar layout e tipografia apenas quando necessario para evitar overflow.'
    ),
    'harden'
  )
})

test('taxonomia escolhe uma tecnica contextual por funcao e por QA', () => {
  const contextual = (department, taskText, phase = 'dev') =>
    selectPhaseSkillPlan({
      defs: [...ROUTING_DEFS, ...CURATED_SKILLS],
      isInstalled: () => true,
      department,
      phase,
      taskText,
      uiCard: false,
      executionMode: 'standard',
      delegationMode: 'none'
    }).skillIds

  assert.deepEqual(contextual('back', 'Investigue a regressao e prove a causa raiz.'), [
    SYNKORA_BACKEND_STANDARD_ID,
    'diagnosing-bugs'
  ])
  assert.deepEqual(contextual('back', 'Desenhe os endpoints REST desta API.'), [
    SYNKORA_BACKEND_STANDARD_ID,
    'api-design-principles'
  ])
  assert.deepEqual(contextual('copy', 'Escreva uma sequencia de emails de onboarding.'), [
    SYNKORA_COPY_STANDARD_ID,
    'email-sequence'
  ])
  assert.deepEqual(contextual('cyber', 'Audite prompt injection no recurso de LLM.'), [
    SYNKORA_CYBER_STANDARD_ID,
    'prompt-injection-defense'
  ])
  assert.deepEqual(contextual('data', 'Crie um dashboard de KPIs com filtros.'), [
    SYNKORA_DATA_STANDARD_ID,
    'build-dashboard'
  ])
  assert.deepEqual(contextual('research', 'Compare concorrentes e posicionamento.'), [
    SYNKORA_RESEARCH_STANDARD_ID,
    'competitive-brief'
  ])
  assert.deepEqual(contextual('back', 'Valide os endpoints e status HTTP.', 'qa'), [
    SYNKORA_BACKEND_STANDARD_ID,
    SYNKORA_BACKEND_QA_ID
  ])
})

test('QA autoral recebe o contrato e exatamente uma tecnica aderente ao risco', () => {
  const defs = [...ROUTING_DEFS, ...CURATED_SKILLS]
  const choose = (
    taskText,
    availableCapabilities = ['read', 'write', 'shell', 'browser'],
    explicitSkillIds = []
  ) =>
    selectPhaseSkillPlan({
      defs,
      isInstalled: () => true,
      department: 'qa',
      phase: 'dev',
      taskText,
      explicitSkillIds,
      uiCard: false,
      availableCapabilities,
      executionMode: 'standard',
      delegationMode: 'none'
    })

  const cases = [
    ['Corrigir selector drift nos locators apos o refactor.', 'selector-drift-recovery'],
    ['Adicionar mutation testing com Stryker para provar a forca dos asserts.', 'mutation-testing'],
    ['Analisar branch coverage e criar um ratchet de cobertura.', 'coverage-analysis'],
    ['Criar teste de carga k6 para o SLO de latencia.', 'k6'],
    ['Adicionar testes de acessibilidade com axe e teclado.', 'accessibility-testing'],
    ['Adicionar testes de seguranca para a autorizacao.', 'security-testing'],
    ['Criar testes de contrato Pact entre consumidor e provedor.', 'contract-testing'],
    ['Criar testes da API REST e seus status HTTP.', 'api-testing'],
    ['Adicionar regressao visual com screenshots e pixel diff.', 'visual-testing'],
    ['Eliminar testes flaky e a dependencia de ordem.', 'test-reliability'],
    ['Executar uma sessao de teste exploratorio com charter.', 'exploratory-testing'],
    ['Criar o fluxo E2E com Cypress.', 'cypress-author'],
    ['Corrigir os testes Playwright e seus locators.', 'playwright-best-practices'],
    ['Criar testes unitarios com Vitest.', 'vitest'],
    ['Automatizar o fluxo de usuario no navegador.', 'playwright-best-practices']
  ]

  for (const [text, technique] of cases) {
    const selected = choose(text)
    assert.deepEqual(selected.skillIds, [SYNKORA_QA_STANDARD_ID, technique], text)
    assert.deepEqual(selected.agentIds, [], text)
    assert.deepEqual(selected.incompatibilities, [], text)
  }

  const generic = choose('Definir a matriz de testes para os criterios de aceitacao.')
  assert.deepEqual(generic.skillIds, [SYNKORA_QA_STANDARD_ID])

  const negated = choose('Documentar a estrategia, sem testes de API ou browser nesta rodada.')
  assert.deepEqual(negated.skillIds, [SYNKORA_QA_STANDARD_ID])
})

test('QA dos testes e independente e capacidades impedem tecnica impossivel', () => {
  const defs = [...ROUTING_DEFS, ...CURATED_SKILLS]
  const gate = selectPhaseSkillPlan({
    defs,
    isInstalled: () => true,
    department: 'qa',
    phase: 'qa',
    taskText: 'Auditar os testes Playwright entregues.',
    explicitSkillIds: ['playwright-best-practices'],
    uiCard: false,
    availableCapabilities: ['read'],
    executionMode: 'standard',
    delegationMode: 'none'
  })
  assert.deepEqual(gate.skillIds, [SYNKORA_QA_QA_ID])
  assert.deepEqual(gate.agentIds, [])
  assert.deepEqual(gate.incompatibilities, [])

  const automaticWithoutBrowser = selectPhaseSkillPlan({
    defs,
    isInstalled: () => true,
    department: 'qa',
    phase: 'dev',
    taskText: 'Corrigir os testes Playwright do fluxo principal.',
    uiCard: false,
    availableCapabilities: ['read', 'write', 'shell'],
    executionMode: 'standard',
    delegationMode: 'none'
  })
  assert.deepEqual(automaticWithoutBrowser.skillIds, [SYNKORA_QA_STANDARD_ID])
  assert.deepEqual(automaticWithoutBrowser.incompatibilities, [])

  const explicitWithoutBrowser = selectPhaseSkillPlan({
    defs,
    isInstalled: () => true,
    department: 'qa',
    phase: 'dev',
    taskText: 'Corrigir os testes Playwright do fluxo principal.',
    explicitSkillIds: ['playwright-best-practices'],
    uiCard: false,
    availableCapabilities: ['read', 'write', 'shell'],
    executionMode: 'standard',
    delegationMode: 'none'
  })
  assert.deepEqual(explicitWithoutBrowser.skillIds, [SYNKORA_QA_STANDARD_ID])
  assert.deepEqual(explicitWithoutBrowser.incompatibilities, [
    {
      id: 'playwright-best-practices',
      reason: 'capability',
      missingCapabilities: ['browser']
    }
  ])

  const authorWithoutShell = selectPhaseSkillPlan({
    defs,
    isInstalled: () => true,
    department: 'qa',
    phase: 'dev',
    taskText: 'Criar testes unitarios com Vitest.',
    uiCard: false,
    availableCapabilities: ['read', 'write'],
    executionMode: 'standard',
    delegationMode: 'none'
  })
  assert.deepEqual(authorWithoutShell.skillIds, [])
  assert.equal(
    authorWithoutShell.incompatibilities.some(
      (issue) =>
        issue.id === SYNKORA_QA_STANDARD_ID && issue.missingCapabilities?.includes('shell')
    ),
    true
  )

  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'qa', 'dev', false), [
    SYNKORA_QA_STANDARD_ID
  ])
  assert.deepEqual(missingMandatoryUiPhaseSkills([], 'qa', 'qa', false), [SYNKORA_QA_QA_ID])
})

test('nova superfície recebe layout; polish fica reservado ao acabamento', () => {
  const creation = route({
    taskText: 'Implementar uma nova tela de calendário de reservas para a equipe.'
  })
  assert.equal(creation.impeccableOperation, 'layout')

  const finish = route({
    taskText: 'Refine o acabamento e faça o polimento visual do componente aprovado.'
  })
  assert.equal(finish.impeccableOperation, 'polish')
})

test('fase e capacidades são barreiras executáveis, não metadados decorativos', () => {
  const qaWithoutBrowser = route({
    phase: 'qa',
    department: 'back',
    uiCard: false,
    taskText: 'Validar o endpoint entregue.',
    availableCapabilities: ['read']
  })
  assert.deepEqual(qaWithoutBrowser.skillIds, [
    SYNKORA_BACKEND_STANDARD_ID,
    SYNKORA_BACKEND_QA_ID
  ])
  assert.deepEqual(qaWithoutBrowser.incompatibilities, [])

  const uiDevWithoutBrowser = route({
    taskText: 'Criar uma nova tela responsiva.',
    availableCapabilities: ['read', 'write', 'shell']
  })
  assert.equal(uiDevWithoutBrowser.skillIds.includes(SYNKORA_FRONTEND_STANDARD_ID), true)
  assert.equal(uiDevWithoutBrowser.skillIds.includes(IMPECCABLE_SKILL_ID), false)
  assert.deepEqual(uiDevWithoutBrowser.incompatibilities, [
    {
      id: IMPECCABLE_SKILL_ID,
      reason: 'capability',
      missingCapabilities: ['browser']
    }
  ])

  const helperWithoutBrowser = route({
    phase: 'helper',
    taskText: 'Ajustar o layout da tela.',
    explicitAgentIds: ['ui-ux-designer'],
    availableCapabilities: ['read', 'write', 'shell']
  })
  assert.equal(helperWithoutBrowser.skillIds.includes(SYNKORA_FRONTEND_STANDARD_ID), true)
  assert.equal(helperWithoutBrowser.skillIds.includes(IMPECCABLE_SKILL_ID), false)
  assert.deepEqual(helperWithoutBrowser.agentIds, [])
  assert.equal(
    helperWithoutBrowser.incompatibilities.some(
      (issue) =>
        issue.id === IMPECCABLE_SKILL_ID && issue.missingCapabilities?.includes('browser')
    ),
    true
  )

  const designSystemText =
    'Criar um design system com tokens, biblioteca de componentes, specimen e governança.'
  const designSystemDevWithoutBrowser = route({
    department: 'design',
    taskText: designSystemText,
    uiCard: true,
    availableCapabilities: ['read', 'write', 'shell']
  })
  assert.deepEqual(designSystemDevWithoutBrowser.skillIds, [SYNKORA_FRONTEND_STANDARD_ID])
  assert.deepEqual(designSystemDevWithoutBrowser.incompatibilities, [
    {
      id: SYNKORA_DESIGN_SYSTEM_STANDARD_ID,
      reason: 'capability',
      missingCapabilities: ['browser']
    }
  ])

  const designSystemQaWithoutBrowser = route({
    department: 'design',
    phase: 'qa',
    taskText: designSystemText,
    uiCard: true,
    availableCapabilities: ['read']
  })
  assert.deepEqual(designSystemQaWithoutBrowser.skillIds, [SYNKORA_FRONTEND_STANDARD_ID])
  assert.deepEqual(designSystemQaWithoutBrowser.incompatibilities, [
    {
      id: SYNKORA_UI_QA_ID,
      reason: 'capability',
      missingCapabilities: ['browser']
    },
    {
      id: SYNKORA_DESIGN_SYSTEM_QA_ID,
      reason: 'capability',
      missingCapabilities: ['browser']
    }
  ])
})

test('técnica específica vence o diagnóstico genérico em pedidos combinados', () => {
  const defs = [...ROUTING_DEFS, ...CURATED_SKILLS]
  const choose = (taskText) =>
    selectPhaseSkillPlan({
      defs,
      isInstalled: () => true,
      department: 'back',
      phase: 'dev',
      taskText,
      uiCard: false,
      executionMode: 'standard',
      delegationMode: 'none'
    }).skillIds

  assert.deepEqual(choose('Corrigir falha de autorização OAuth no refresh token.'), [
    SYNKORA_BACKEND_STANDARD_ID,
    'oauth'
  ])
  assert.deepEqual(choose('Investigar erro no schema Postgres e na política RLS.'), [
    SYNKORA_BACKEND_STANDARD_ID,
    'supabase-postgres-best-practices'
  ])
  assert.deepEqual(choose('Corrigir bug no webhook e no contrato da API.'), [
    SYNKORA_BACKEND_STANDARD_ID,
    'api-design-principles'
  ])
  assert.deepEqual(choose('Resolver regressão de segurança e autorização RBAC.'), [
    SYNKORA_BACKEND_STANDARD_ID,
    'security-best-practices'
  ])
})

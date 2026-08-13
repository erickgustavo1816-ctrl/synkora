// @ts-expect-error Node strip-types exige a extensão; o bundler também aceita.
import { detectContextualAgentId } from './agentRouting.ts'

export interface RoutableSkill<Department extends string = string> {
  id: string
  kind: 'skill' | 'agent'
  depts: Department[]
  group: string
  /** Fallback curado. Nunca vence uma escolha explícita do card. */
  defaultFor?: Department[]
  /** Metadado legado preservado no contrato nativo; nao habilita fallback externo. */
  orchestratorDefault?: boolean
  /**
   * A skill continua visível e pode ser escolhida explicitamente por card ou
   * ajudante, mas não entra no menu automático de toda execução da função.
   * Útil para workflows que o harness do Synkora já controla (git/review/merge).
   */
  manualOnly?: boolean
  allowedPhases?: Array<'planning' | 'dev' | 'review' | 'qa' | 'helper'>
  requiresCapabilities?: Array<'read' | 'write' | 'shell' | 'browser' | 'subagents' | 'network'>
  adapter?: 'synkora-native' | 'impeccable-operation'
}

export const SYNKORA_FRONTEND_STANDARD_ID = 'synkora-frontend-standard'
export const SYNKORA_UI_QA_ID = 'synkora-ui-qa'
export const SYNKORA_RUNTIME_QA_ID = 'synkora-runtime-qa'
export const SYNKORA_REVIEW_STANDARD_ID = 'synkora-review-standard'
export const SYNKORA_PLANNING_STANDARD_ID = 'synkora-planning-standard'
export const SYNKORA_DESIGN_SYSTEM_STANDARD_ID = 'synkora-design-system-standard'
export const SYNKORA_DESIGN_SYSTEM_QA_ID = 'synkora-design-system-qa'
export const SYNKORA_BACKEND_STANDARD_ID = 'synkora-backend-standard'
export const SYNKORA_BACKEND_QA_ID = 'synkora-backend-qa'
export const SYNKORA_DEVOPS_STANDARD_ID = 'synkora-devops-standard'
export const SYNKORA_DEVOPS_QA_ID = 'synkora-devops-qa'
export const SYNKORA_CYBER_STANDARD_ID = 'synkora-cyber-standard'
export const SYNKORA_CYBER_QA_ID = 'synkora-cyber-qa'
export const SYNKORA_DATA_STANDARD_ID = 'synkora-data-standard'
export const SYNKORA_DATA_QA_ID = 'synkora-data-qa'
export const SYNKORA_RESEARCH_STANDARD_ID = 'synkora-research-standard'
export const SYNKORA_RESEARCH_QA_ID = 'synkora-research-qa'
export const SYNKORA_COPY_STANDARD_ID = 'synkora-copy-standard'
export const SYNKORA_COPY_QA_ID = 'synkora-copy-qa'
export const SYNKORA_QA_STANDARD_ID = 'synkora-qa-standard'
export const SYNKORA_QA_QA_ID = 'synkora-qa-qa'
export const IMPECCABLE_SKILL_ID = 'impeccable'

export type ImpeccableOperation = 'layout' | 'adapt' | 'harden' | 'typeset' | 'polish'
export type SkillExecutionPhase = 'dev' | 'review' | 'qa' | 'helper'
export type SkillCapability = 'read' | 'write' | 'shell' | 'browser' | 'subagents' | 'network'
export type SkillExecutionMode = 'fast' | 'standard' | 'deep'
export type SkillDelegationMode = 'none' | 'optional' | 'parallel'

export interface PhaseSkillSelectionInput<Department extends string = string> {
  defs: RoutableSkill<Department>[]
  isInstalled: (id: string) => boolean
  department: Department
  phase: SkillExecutionPhase
  /** Título + descrição + briefing do card; nunca inclua catálogo ou diagnóstico. */
  taskText: string
  explicitSkillIds?: Iterable<string>
  explicitAgentIds?: Iterable<string>
  executionMode?: SkillExecutionMode
  delegationMode?: SkillDelegationMode
  /** Use quando o chamador tem evidência estrutural melhor que a heurística textual. */
  uiCard?: boolean
  securitySensitive?: boolean
  /** Capabilities actually granted to this pane after risk and waiver policy. */
  availableCapabilities?: Iterable<SkillCapability>
}

export interface SkillCompatibilityIssue {
  id: string
  reason: 'phase' | 'capability'
  missingCapabilities?: SkillCapability[]
}

export interface PhaseSkillSelection {
  /** Raízes selecionadas. Dependências `requires` continuam sendo expandidas pela biblioteca. */
  skillIds: string[]
  /** Apenas DEV pode receber uma persona passiva; helpers usam delegate.agent. */
  agentIds: string[]
  /** Operação fechada; nunca encaminhar texto livre como comando do Impeccable. */
  impeccableOperation?: ImpeccableOperation
  /** Intenção visual compartilhada pelo contrato, sem implicar que QA herdou Impeccable. */
  uiOperation?: ImpeccableOperation
  /** Installed selections that cannot execute in the real pane. */
  incompatibilities: SkillCompatibilityIssue[]
}

/** REVIEW é diff de código, não um segundo QA. */
export const REVIEW_PHASE_SKILL_ALLOWLIST = [
  'code-review',
  'code-review-and-quality',
  'ce-code-review'
] as const

/** Segurança entra por risco provado e com uma lente diferencial, não pelo dept inteiro. */
export const SECURITY_REVIEW_PHASE_SKILL_ALLOWLIST = ['differential-review'] as const

/** QA recebe técnicas de verificação; métodos de criação visual ficam no DEV. */
export const QA_PHASE_SKILL_ALLOWLIST = [
  'webapp-testing',
  'better-accessibility',
  'security-testing',
  'api-testing',
  'contract-testing',
  'visual-testing',
  'test-reliability',
  'vitest'
] as const

const REVIEW_ALLOWED = new Set<string>(REVIEW_PHASE_SKILL_ALLOWLIST)
const SECURITY_REVIEW_ALLOWED = new Set<string>(SECURITY_REVIEW_PHASE_SKILL_ALLOWLIST)
const QA_ALLOWED = new Set<string>(QA_PHASE_SKILL_ALLOWLIST)

interface TechniqueIntentRule {
  departments: string[]
  id: string
  pattern: RegExp
  /** DevOps shares the `back` department in the board but has its own router. */
  lane?: 'devops'
}

// Pequena taxonomia de necessidades, deliberadamente ordenada do mais
// especifico ao mais geral. Ela escolhe UM metodo tecnico; nao despeja o
// catalogo nem tenta transformar cada palavra em uma skill.
const TECHNIQUE_INTENT_RULES: readonly TechniqueIntentRule[] = [
  { departments: ['front'], id: 'better-accessibility', pattern: /\b(?:a11y|acessibilidade|accessibility|aria|screen reader|leitor de tela|teclado|keyboard|focus)\b/ },
  { departments: ['front'], id: 'vercel-react-native-skills', pattern: /\b(?:react native|expo|ios|android|mobile nativ\w*|native app)\b/ },
  { departments: ['front'], id: 'fixing-motion-performance', pattern: /\b(?:animacao|animation|motion|scroll).{0,40}\b(?:trav\w*|jank|performance|lento|slow|fps)\b|\b(?:jank|fps)\b/ },
  { departments: ['front'], id: 'core-web-vitals', pattern: /\b(?:core web vitals|lcp|cls|inp)\b/ },
  { departments: ['front'], id: 'vercel-react-best-practices', pattern: /\b(?:react|next\.?js|nextjs|rerender|re-render|bundle|hydration|server component|client component)\b/ },

  { departments: ['back'], id: 'github-actions-templates', lane: 'devops', pattern: /\b(?:github actions?|workflow\s+ya?ml|\.github\/workflows?|action runner|reusable workflow)\b/ },
  { departments: ['back'], id: 'terraform-skill', lane: 'devops', pattern: /\b(?:terraform|tofu|opentofu|tfstate|state drift|state lock|provider upgrade|terraform plan|terraform apply)\b/ },
  { departments: ['back'], id: 'terraform-style-guide', lane: 'devops', pattern: /\b(?:hcl|terraform module|modulo terraform|infra(?:structure)? as code|infraestrutura como codigo|\biac\b)\b/ },
  { departments: ['back'], id: 'slo-implementation', lane: 'devops', pattern: /\b(?:slo|sli|error budget|prometheus|promql|grafana|observability|observabilidade|alerta|alerting|burn rate)\b/ },
  { departments: ['back'], id: 'workers-best-practices', lane: 'devops', pattern: /\b(?:cloudflare workers?|wrangler|edge deployment|deploy(?:ment)? at the edge)\b/ },
  { departments: ['back'], id: 'deployment-pipeline-design', lane: 'devops', pattern: /\b(?:ci\/?cd|pipeline|deploy(?:ment)?|rollout|rollback|canary|blue[- ]green|container|docker|kubernetes|\bk8s\b|helm|artifact|release automation)\b/ },

  { departments: ['back'], id: 'oauth', pattern: /\b(?:oauth|jwt|pkce|refresh token|access token|login|autenticacao|authentication)\b/ },
  { departments: ['back'], id: 'security-best-practices', pattern: /\b(?:authorization|autorizacao|permissao|permission|rbac|idor|csrf|xss|security|seguranca)\b/ },
  { departments: ['back'], id: 'supabase-postgres-best-practices', pattern: /\b(?:postgres|postgresql|supabase|database|banco de dados|schema|migration|migracao|rls|sql)\b/ },
  { departments: ['back'], id: 'api-design-principles', pattern: /\b(?:api|endpoint|rest|graphql|webhook|status code|contrato http)\b/ },
  { departments: ['back'], id: 'mcp-builder', pattern: /\b(?:mcp|model context protocol)\b/ },
  { departments: ['back'], id: 'stripe-best-practices', pattern: /\b(?:stripe|pagamento|payment|checkout|billing|subscription)\b/ },
  { departments: ['back'], id: 'nodejs-backend-patterns', pattern: /\b(?:node\.?js|nodejs|express|fastify|nestjs|typescript backend)\b/ },
  { departments: ['back'], id: 'python-project-structure', pattern: /\b(?:python|fastapi|django|flask|pytest)\b/ },
  { departments: ['back'], id: 'diagnosing-bugs', pattern: /\b(?:bug|erro|error|falha|failure|debug|regressao|regression|root cause|causa raiz)\b/ },
  { departments: ['back'], id: 'test-driven-development', pattern: /\b(?:teste|test|tdd|spec|regressao|regression)\b/ },

  { departments: ['copy'], id: 'brand-review', pattern: /\b(?:review|revis\w*|audit\w*|chec\w*)\b.{0,64}\b(?:brand voice|voz da marca|tom de voz|tone of voice|style guide|guia de estilo)\b|\b(?:brand voice|voz da marca|tom de voz|tone of voice|style guide|guia de estilo)\b.{0,64}\b(?:review|revis\w*|audit\w*|chec\w*)\b/ },
  { departments: ['copy'], id: 'email-sequence', pattern: /\b(?:email|newsletter|drip|nurture|onboarding sequence|sequencia)\b/ },
  { departments: ['copy'], id: 'social', pattern: /\b(?:social|instagram|linkedin|tiktok|twitter|x\.com|carrossel|carousel|post)\b/ },
  { departments: ['copy'], id: 'landing-page-copy', pattern: /\b(?:landing page|pagina de vendas|sales page|cta|conversao|conversion)\b/ },
  { departments: ['copy'], id: 'ai-seo', pattern: /\b(?:seo|aeo|geo|search engine|palavra-chave|keyword|llms\.txt)\b/ },
  { departments: ['copy'], id: 'brand-voice', pattern: /\b(?:brand voice|voz da marca|tom de voz|tone of voice|identidade verbal)\b/ },
  { departments: ['copy'], id: 'ux-writing', pattern: /\b(?:microcopy|ux writing|content design|rotulo|label|mensagem de erro|error message|empty state|estado vazio|helper text|texto de ajuda)\b/ },
  { departments: ['copy'], id: 'copy-editing', pattern: /\b(?:copy edit|copyedit|editar copy|edicao de copy|revisar rascunho|polir texto|proofread|revisao editorial)\b/ },
  { departments: ['copy'], id: 'humanizer', pattern: /\b(?:humaniz|texto de ia|ai[- ]written|robotic|robotico|naturalidade)\b/ },

  { departments: ['cyber'], id: 'oauth', pattern: /\b(?:oauth|jwt|pkce|refresh token|access token|oidc|openid connect)\b/ },
  { departments: ['cyber'], id: 'secrets-audit', pattern: /\b(?:secrets?|segred\w*|token|credentials?|credencia\w*|api key|chave privada|\.env)\b/ },
  { departments: ['cyber'], id: 'dependency-supply-chain', pattern: /\b(?:supply chain|dependenc|dependency|package|npm|lockfile|sbom)\b/ },
  { departments: ['cyber'], id: 'prompt-injection-defense', pattern: /\b(?:prompt injection|injecao de prompt|indirect injection|llm)\b/ },
  { departments: ['cyber'], id: 'mcp-security', pattern: /\b(?:mcp|model context protocol|tool poisoning)\b/ },
  { departments: ['cyber'], id: 'nextjs-security', pattern: /\b(?:next\.?js|nextjs|app router|middleware bypass)\b/ },
  { departments: ['cyber'], id: 'security-threat-model', pattern: /\b(?:threat model|modelagem de ameaca|stride|attack tree|arvore de ataque)\b/ },
  { departments: ['cyber', 'qa'], id: 'security-testing', pattern: /\b(?:security tests?|testes? de seguranca|sast|dast|semgrep|codeql|vulnerab)\b/ },

  { departments: ['qa'], id: 'selector-drift-recovery', pattern: /\b(?:selector drift|seletor(?:es)? quebrad\w*|aria snapshot|locator drift|refactor).{0,48}\b(?:selector|seletor|locator)\b|\b(?:selector|seletor|locator).{0,48}\b(?:drift|quebrad\w*|refactor)\b/ },
  { departments: ['qa'], id: 'mutation-testing', pattern: /\b(?:mutation test|teste de mutacao|stryker|mutmut|surviving mutant|mutante sobrevivente)\b/ },
  { departments: ['qa'], id: 'coverage-analysis', pattern: /\b(?:coverage|cobertura|branch coverage|diff coverage|ratchet)\b/ },
  { departments: ['qa'], id: 'k6', pattern: /\b(?:k6|load test|teste de carga|stress test|spike test|soak test|performance test|teste de performance|throughput|latencia sob carga|latency under load)\b/ },
  { departments: ['qa'], id: 'accessibility-testing', pattern: /\b(?:a11y|acessibilidade|accessibility|axe-core|aria|screen reader|leitor de tela|teclado|keyboard|focus)\b/ },
  { departments: ['qa'], id: 'security-testing', pattern: /\b(?:security tests?|testes? de seguranca|sast|dast|semgrep|codeql|vulnerab)\b/ },
  { departments: ['qa'], id: 'contract-testing', pattern: /\b(?:contract test|teste de contrato|pact|consumer driven|schema contract)\b/ },
  { departments: ['qa'], id: 'api-testing', pattern: /\b(?:api|endpoint|rest|graphql|webhook|http status|request context|supertest)\b/ },
  { departments: ['qa'], id: 'visual-testing', pattern: /\b(?:visual regression|regressao visual|screenshot|snapshot visual|pixel diff|chromatic|percy|argos)\b/ },
  { departments: ['qa'], id: 'test-reliability', pattern: /\b(?:flaky|flakiness|teste instavel|test reliability|quarantine|race no teste|test race)\b/ },
  { departments: ['qa'], id: 'exploratory-testing', pattern: /\b(?:exploratory test|teste exploratorio|exploracao|charter|session based|sbtm)\b/ },
  { departments: ['qa'], id: 'cypress-author', pattern: /\b(?:cypress|cy\.(?:visit|get|intercept)|cypress\.config)\b/ },
  { departments: ['qa'], id: 'playwright-best-practices', pattern: /\b(?:playwright|@playwright\/test|page\.getby|locator|browser test|teste de navegador)\b/ },
  { departments: ['qa'], id: 'vitest', pattern: /\b(?:vitest|unit test|teste unitario|vi\.mock|expect\.)\b/ },
  { departments: ['qa'], id: 'playwright-best-practices', pattern: /\b(?:browser|navegador|e2e|end-to-end|webapp|fluxo de usuario|user flow)\b/ },

  { departments: ['data'], id: 'building-dbt-semantic-layer', pattern: /\b(?:semantic layer|camada semantica|metricflow|semantic model|modelo semantico|dbt metrics?)\b/ },
  { departments: ['data'], id: 'using-dbt-for-analytics-engineering', pattern: /\b(?:dbt|dbt model|modelo dbt|dbt source|dbt ref|dbt snapshot|analytics engineering)\b/ },
  { departments: ['data'], id: 'polars', pattern: /\b(?:polars|lazyframe|lazy frame)\b/ },
  { departments: ['data'], id: 'read-file', pattern: /\b(?:ler|read|inspecionar|inspect|preview|amostrar|sample)\b.{0,48}\b(?:csv|parquet|json|avro|xlsx|excel|sqlite|data file|arquivo de dados)\b|\b(?:csv|parquet|avro|xlsx|excel)\b.{0,48}\b(?:schema|colunas?|columns?|amostra|sample)\b/ },
  { departments: ['data'], id: 'query', pattern: /\b(?:duckdb|ducklake|friendly sql)\b/ },
  { departments: ['data'], id: 'kpi-dashboard-design', pattern: /\b(?:defin\w*|design\w*|estrutur\w*|hierarqu\w*)\b.{0,48}\b(?:kpi|metric\w*|scorecard|dashboard)\b/ },
  { departments: ['data'], id: 'build-dashboard', pattern: /\b(?:constru\w*|cri\w*|build\w*|implement\w*)\b.{0,48}\b(?:dashboard|painel|scorecard)\b|\b(?:dashboard|painel|scorecard)\b.{0,48}\b(?:interativ\w*|filtro\w*|chart\w*|grafico\w*)\b/ },
  { departments: ['data'], id: 'data-visualization', pattern: /\b(?:visualiz|chart|grafico|graph|plot)\b/ },
  { departments: ['data'], id: 'data-quality-frameworks', pattern: /\b(?:data quality|qualidade de dados|expectation|great expectations|dbt test)\b/ },
  { departments: ['data'], id: 'validate-data', pattern: /\b(?:validar|validate|reconcile|reconciliar|sanity check|confiabilidade)\b/ },
  { departments: ['data'], id: 'ab-testing', pattern: /\b(?:a\/b|ab test|experimento|experiment|sample size|guardrail metrics?)\b/ },
  { departments: ['data'], id: 'statistical-analysis', pattern: /\b(?:estatistic\w*|statistic\w*|correlacao|correlation|regressao linear|significancia|effect size|confidence interval|intervalo de confianca)\b/ },
  { departments: ['data'], id: 'explore-data', pattern: /\b(?:explorar|explore|profil|dataset desconhecido|unfamiliar dataset)\b/ },
  { departments: ['data'], id: 'sql-queries', pattern: /\b(?:sql|query|consulta|warehouse|bigquery|snowflake|redshift|databricks)\b/ },

  { departments: ['research'], id: 'spec-miner', pattern: /\b(?:engenharia reversa|reverse engineer|extrair spec|mine spec|spec miner|codigo legado|legacy code|sem documentacao|undocumented)\b/ },
  { departments: ['research'], id: 'write-spec', pattern: /\b(?:prd|product requirements?|requisitos? de produto|user stor\w*|historias? de usuario|acceptance criteria|criterios? de aceitacao|escrever spec|write spec)\b/ },
  { departments: ['research'], id: 'competitive-brief', pattern: /\b(?:concorrent\w*|competitor\w*|competitive|benchmark de mercado)\b/ },
  { departments: ['research'], id: 'market-sizing-analysis', pattern: /\b(?:tam|sam|som|market siz|tamanho de mercado)\b/ },
  { departments: ['research'], id: 'synthesize-research', pattern: /\b(?:sintetiz|synthesi|entrevista|interview|survey|pesquisa com usuario|user research)\b/ },
  { departments: ['research'], id: 'research', pattern: /\b(?:deep research|pesquisa profunda|multi-source|multiplas fontes|literature review|revisao de literatura)\b/ },
  { departments: ['research'], id: 'research', pattern: /\b(?:research|pesquisa|investigar|investigate|documentacao oficial|official docs|fonte primaria|primary source)\b/ }
]

const CURATED_TECHNIQUE_FALLBACK: Readonly<Record<string, string>> = {
  back: 'test-driven-development',
  copy: 'copywriting',
  cyber: 'security-best-practices',
  data: 'sql-queries',
  research: 'research'
}

// Uma exclusao explicita de escopo nao pode virar selecao de tecnica apenas
// porque o nome da ferramenta apareceu no briefing. O contrato nativo continua
// ativo; somente a tecnica negada e removida da decisao contextual.
const NON_QA_TECHNIQUE_SCOPE_RE =
  /\b(?:sem|without|no|nao\s+(?:cri\w*|adicion\w*|alter\w*)|do not\s+(?:add|write|change))\s+(?:(?:nov\w*|new)\s+)?(?:(?:testes?|tests?|testing)\s+(?:de|do|da|for|of|in)?\s*)?(?:api|browser|navegador|visual(?:is)?|acessibilidade|accessibility|carga|load|performance|seguranca|security|contrato|contract|cypress|playwright|vitest)(?:\s*(?:,|\/|e|ou|and|or)\s*(?:api|browser|navegador|visual(?:is)?|acessibilidade|accessibility|carga|load|performance|seguranca|security|contrato|contract|cypress|playwright|vitest))*\s*(?:testes?|tests?|testing)?\b/g

function normalizedRoutingText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
}

const UI_SURFACE_RE =
  /\b(?:ui|interface|tela|screen|pagina|page|header|cabecalho|sidebar|menu|toolbar|barra de ferramentas|tabela|table|filtro|filter|formulario|form|modal|dialog|botao|button|calendario|calendar|navegacao|navigation|viewport|breakpoint|tema|theme|design system|componente visual|visual component|layout|visua(?:l|is)|estetic\w*|harmoni\w*|aparencia|responsiv\w*|css|styling|estiliz\w*|espacamento|alinhamento|proporc\w*|overflow)\b/

// Fora das lanes front/design, até "header", "layout", "dialog", HTML e CSS
// podem descrever protocolo, parser ou pipeline. Só sinais inequivocamente
// renderizados elevam o card; alterações em substantivos ambíguos precisam de
// um verbo visual e não podem estar sob uma negação backend/server-only.
const CROSS_DEPARTMENT_UI_RE =
  /\b(?:ssr(?:\s+template)?|server[- ]rendered\s+(?:html|ui|interface)|interface renderizada|rendered interface|design system|componente visual|visual component|superficie visivel|user-visible surface|viewport|breakpoint|visua(?:l|is)|estetic\w*|harmoni\w*|aparencia|responsiv\w*|styling|estiliz\w*|espacamento|spacing|alinhamento|alignment|proporc\w*|proportion\w*|overflow)\b/

const CROSS_DEPARTMENT_UI_ACTION_RE =
  /\b(?:alter\w*|ajust\w*|corrig\w*|renderiz\w*|redesenh\w*|estiliz\w*|change\w*|fix\w*|render\w*|redesign\w*|style\w*)\b.{0,80}\b(?:html|css|stylesheet|style sheet|layout|header|cabecalho|sidebar|toolbar|modal|dialog)\b/

// Termos visuais dentro de uma exclusao nao provam trabalho de interface.
// Isso evita mandar Impeccable para refactors de adapter/types que apenas
// esclarecem que nao alteram a tela.
const NON_UI_SCOPE_RE =
  /\b(?:non[- ]ui|backend[- ]only|server[- ]only|fora da interface|no\s+(?:user\s+)?(?:ui|interface|screen|visual)(?:\s+changes?)?|no\s+(?:changes?|work|impact)\s+(?:to|on|in)\s+(?:the\s+)?(?:user\s+)?(?:ui|interface|screen|visual)|sem\s+(?:mudancas?|alterac(?:ao|oes)|impacto)\s+visua(?:l|is)|sem\s+(?:(?:mudancas?|alterac(?:ao|oes)|impacto)\s+(?:na|no|de)\s+)?(?:ui|interface|tela|visual)|nao\s+(?:(?:ha|tera)\s+)?(?:mudancas?|alterac(?:ao|oes)|impacto)?\s*(?:na|no|de)?\s*(?:ui|interface|tela|visual))\b/

const DESIGN_SYSTEM_SUBJECT_RE =
  /\b(?:design system|sistema de design|component library|biblioteca de componentes|ui kit|design tokens?|tokens? de design|storybook|style dictionary)\b/

const DESIGN_SYSTEM_ACTION_RE =
  /\b(?:cri\w*|constru\w*|estrutur\w*|estabelec\w*|defin\w*|evolu\w*|expand\w*|consolid\w*|migr\w*|refator\w*|atualiz\w*|audit\w*|document\w*|govern\w*|padroniz\w*|implement\w*|create\w*|build\w*|establish\w*|define\w*|evolve\w*|expand\w*|consolidat\w*|migrat\w*|refactor\w*|update\w*|audit\w*|document\w*|govern\w*|standardiz\w*|implement\w*)\b/

const DESIGN_SYSTEM_CONSUMPTION_RE =
  /\b(?:(?:usar|use|aplicar|apply|seguir|follow|consumir|consume|reutilizar|reuse)\w*\b.{0,64}\b(?:design system|sistema de design|component library|biblioteca de componentes|ui kit)|(?:com|using|from)\s+(?:os\s+|the\s+)?componentes?\s+(?:do|da|of|from)\s+(?:design system|sistema de design|component library|biblioteca de componentes))\b/

const DESIGN_SYSTEM_MUTATION_RE =
  /\b(?:token\w*|fundament\w*|component library|biblioteca de componentes|catalogo de componentes|component catalog|storybook|governanca|governance|contribuic\w*|contribution|versionamento|versioning|depreca\w*|deprecation|migracao|migration|documentacao viva|living documentation|specimen|showcase)\b/

// DevOps ainda compartilha a lane `back` na UI. A classificacao exige um
// artefato ou mecanismo operacional concreto; palavras vagas como "release"
// de negocio, "deploy da feature" ou "pipeline de dados" nao bastam sozinhas.
const DEVOPS_STRONG_SUBJECT_RE =
  /\b(?:ci\/?cd|github actions?|\.github\/workflows?|reusable workflow|build pipeline|deployment pipeline|release pipeline|deploy pipeline|infra(?:structure)? as code|infraestrutura como codigo|\biac\b|terraform|opentofu|tfstate|hcl|kubernetes|\bk8s\b|helm(?: chart)?|docker(?:file| compose)?|container image|imagem de container|container registry|artifact registry|canary rollout|blue[- ]green|rollout|rollback|slo|sli|error budget|prometheus|promql|grafana|observability|observabilidade|cloudflare workers?|wrangler)\b/

const DEVOPS_COMPOSITE_RE =
  /\b(?:cri\w*|configur\w*|corrig\w*|automatiz\w*|public\w*|promov\w*|monitor\w*|build\w*|deploy\w*|release\w*|roll\w*|provision\w*|create\w*|configure\w*|fix\w*|automate\w*)\b.{0,80}\b(?:workflow|runner|artifact|container|image|cluster|infrastructure|infraestrutura|environment|ambiente|alert|dashboard operacional|cloud)\b/

const NON_DEVOPS_SCOPE_RE =
  /\b(?:sem|no|without)\s+(?:mudancas?|alterac(?:ao|oes)|changes?|work|impact)?\s*(?:em|na|no|to|on|in)?\s*(?:ci\/?cd|pipeline(?:s)?(?:\s+(?:de|do|da|for|of)?\s*(?:build|deploy(?:ment)?|release))?|deploy(?:ment)?|release|infraestrutura|infrastructure|container(?:s)?|terraform|kubernetes|observabilidade|observability)\b/

const OPERATION_PATTERNS: ReadonlyArray<{
  operation: ImpeccableOperation
  pattern: RegExp
  tiePriority: number
}> = [
  {
    operation: 'adapt',
    pattern:
      /\b(?:adapt\w*|responsiv\w*|responsive|mobile|tablet|breakpoint|viewport|redimension\w*|resize|orientacao|orientation|desktop\s*(?:para|to)\s*mobile)\b/,
    // Responsividade é mais específica que a palavra genérica "layout".
    tiePriority: 6
  },
  {
    operation: 'harden',
    pattern:
      /\b(?:harden|robust\w*|overflow|vazando|vaza|scroll|rolagem|texto longo|long text|ellipsis|reticencias|trunc\w*|edge case|caso extremo|empty state|loading state|error state|estado vazio|estado de carregamento|estado de erro|localiz\w*|zoom)\b/,
    tiePriority: 4
  },
  {
    operation: 'typeset',
    pattern:
      /\b(?:typeset|tipografia|typography|fonte|font|typeface|type scale|escala tipografica|line-height|altura de linha|letter-spacing|tracking|legibilidade|readability)\b/,
    tiePriority: 2
  },
  {
    operation: 'layout',
    pattern:
      /\b(?:layout|espacamento|spacing|alinh\w*|align\w*|grid|hierarquia|hierarchy|proporc\w*|proportion\w*|distribu\w*|distribution|respiro|whitespace|largura|width|altura|height|posicion\w*|position\w*|(?:nova?|new)\s+(?:tela|screen|pagina|page|dashboard|painel|calendario|calendar|interface|shell|navegacao|navigation)|(?:criar|implementar|construir|create|implement|build)\w*.{0,48}\b(?:tela|screen|pagina|page|dashboard|painel|calendario|calendar|interface|shell|navegacao|navigation))\b/,
    tiePriority: 5
  },
  {
    operation: 'polish',
    pattern:
      /\b(?:polish|polimento|harmoni\w*|refin\w*|acabamento|consisten\w*|coeren\w*|bonit\w*|elegan\w*|visual design|design visual|microintera\w*|micro-intera\w*)\b/,
    tiePriority: 1
  }
]

/** Classifica somente operações Impeccable seguras e fechadas. */
export function detectImpeccableOperation(taskText: string): ImpeccableOperation | undefined {
  const text = normalizedRoutingText(taskText)
  const lead = text.split(/\r?\n/, 1)[0].slice(0, 240)
  const scored = OPERATION_PATTERNS.map((candidate) => {
    const flags = candidate.pattern.flags.includes('g')
      ? candidate.pattern.flags
      : `${candidate.pattern.flags}g`
    const count = (value: string): number =>
      [...value.matchAll(new RegExp(candidate.pattern.source, flags))].length
    const explicit = new RegExp(
      `\\b(?:operacao|operation|impeccable|use|usar)\\s*[:=-]?\\s*${candidate.operation}\\b`,
      'i'
    ).test(text)
    return {
      ...candidate,
      score: (explicit ? 20 : 0) + count(text) * 2 + count(lead) * 3
    }
  })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.tiePriority - left.tiePriority)
  return scored[0]?.operation
}

/**
 * Distingue a criacao/evolucao do sistema de design do uso cotidiano de um
 * sistema existente. A segunda situacao continua pertencendo ao Impeccable.
 */
export function isDesignSystemWork(department: string, taskText: string): boolean {
  if (!['design', 'front'].includes(department)) return false
  const text = normalizedRoutingText(taskText)
  if (!DESIGN_SYSTEM_SUBJECT_RE.test(text)) return false
  const mutatesSystem = DESIGN_SYSTEM_MUTATION_RE.test(text)
  if (DESIGN_SYSTEM_CONSUMPTION_RE.test(text) && !mutatesSystem) return false
  if (DESIGN_SYSTEM_ACTION_RE.test(text) && mutatesSystem) return true

  const subjectAction = new RegExp(
    `${DESIGN_SYSTEM_ACTION_RE.source}.{0,96}${DESIGN_SYSTEM_SUBJECT_RE.source}|${DESIGN_SYSTEM_SUBJECT_RE.source}.{0,96}${DESIGN_SYSTEM_ACTION_RE.source}`
  )
  return subjectAction.test(text)
}

/** Separa trabalho DevOps de backend comum dentro do departamento `back`. */
export function isDevOpsWork(department: string, taskText: string): boolean {
  if (department !== 'back') return false
  const text = normalizedRoutingText(taskText)
  const withoutNegatedScope = text.replace(new RegExp(NON_DEVOPS_SCOPE_RE.source, 'g'), ' ')
  return (
    DEVOPS_STRONG_SUBJECT_RE.test(withoutNegatedScope) ||
    DEVOPS_COMPOSITE_RE.test(withoutNegatedScope)
  )
}

export function isVisualMethod(def: RoutableSkill): boolean {
  if (def.id === IMPECCABLE_SKILL_ID) return true
  const group = normalizedRoutingText(def.group)
  return /(?:direcao estetica|polish|layout|tipografia|cor\b|interface|animacao|identidade|design system|sistema de design|mockup)/.test(
    group
  )
}

function uniqueIds(ids: Iterable<string> | undefined): string[] {
  return [...new Set(ids ?? [])]
}

function installedSkillById<Department extends string>(
  defs: RoutableSkill<Department>[],
  isInstalled: (id: string) => boolean
): Map<string, RoutableSkill<Department>> {
  return new Map(
    defs
      .filter((def) => def.kind === 'skill' && isInstalled(def.id))
      .map((def) => [def.id, def])
  )
}

const ALL_SKILL_CAPABILITIES: readonly SkillCapability[] = [
  'read',
  'write',
  'shell',
  'browser',
  'subagents',
  'network'
]

export function skillCompatibilityIssue<Department extends string>(
  def: RoutableSkill<Department>,
  phase: SkillExecutionPhase | 'planning',
  availableCapabilities: Iterable<SkillCapability> = ALL_SKILL_CAPABILITIES
): SkillCompatibilityIssue | undefined {
  if (def.allowedPhases && !def.allowedPhases.includes(phase)) {
    return { id: def.id, reason: 'phase' }
  }
  const available = new Set(availableCapabilities)
  const missingCapabilities = (def.requiresCapabilities ?? []).filter(
    (capability): capability is SkillCapability => !available.has(capability)
  )
  return missingCapabilities.length > 0
    ? { id: def.id, reason: 'capability', missingCapabilities }
    : undefined
}

function uniqueCompatibilityIssues(
  issues: Iterable<SkillCompatibilityIssue | undefined>
): SkillCompatibilityIssue[] {
  const byKey = new Map<string, SkillCompatibilityIssue>()
  for (const issue of issues) {
    if (!issue) continue
    const key = `${issue.id}:${issue.reason}:${(issue.missingCapabilities ?? []).join(',')}`
    byKey.set(key, issue)
  }
  return [...byKey.values()]
}

function intentTechnique<Department extends string>(
  byId: ReadonlyMap<string, RoutableSkill<Department>>,
  department: Department,
  taskText: string,
  accept: (def: RoutableSkill<Department>) => boolean,
  lane?: 'devops'
): RoutableSkill<Department> | undefined {
  const normalized = normalizedRoutingText(taskText)
  const text = department === 'qa'
    ? normalized.replace(NON_QA_TECHNIQUE_SCOPE_RE, ' ')
    : normalized
  for (const rule of TECHNIQUE_INTENT_RULES) {
    if (
      rule.lane !== lane ||
      !rule.departments.includes(department) ||
      !rule.pattern.test(text)
    ) continue
    const candidate = byId.get(rule.id)
    if (candidate && accept(candidate)) return candidate
  }
  const fallback = lane === 'devops'
    ? 'deployment-pipeline-design'
    : CURATED_TECHNIQUE_FALLBACK[department]
  const candidate = fallback ? byId.get(fallback) : undefined
  return candidate && accept(candidate) ? candidate : undefined
}

function firstExplicitOrFallback<Department extends string>(
  defs: RoutableSkill<Department>[],
  byId: ReadonlyMap<string, RoutableSkill<Department>>,
  explicitIds: string[],
  department: Department,
  accept: (def: RoutableSkill<Department>) => boolean,
  explicitClosesFallback = false,
  taskText = '',
  lane?: 'devops'
): RoutableSkill<Department> | undefined {
  const explicit = explicitIds
    .map((id) => byId.get(id))
    .find((def): def is RoutableSkill<Department> => Boolean(def && accept(def)))
  // O carimbo é uma decisão fechada: se existe seleção explícita, não
  // completamos silenciosamente com um default de outra natureza.
  if (explicit || (explicitClosesFallback && explicitIds.length > 0)) return explicit
  const contextual = intentTechnique(byId, department, taskText, accept, lane)
  if (contextual) return contextual
  // A ausencia de uma tecnica DevOps instalada nunca degrada para o default
  // generico de backend; o contrato nativo continua suficiente e honesto.
  if (lane === 'devops' || department === 'qa') return undefined
  return defs.find(
    (def) =>
      byId.has(def.id) &&
      def.defaultFor?.includes(department) === true &&
      accept(def)
  )
}

/** Classifica uma entrega visual pela superficie descrita, nao pelo nome do
 * departamento. `front` tambem executa adapters, tipos e build sem mudar UI. */
export function isUiSurfaceWork(
  department: string,
  taskText: string,
  explicitVisualMethod = false
): boolean {
  const text = normalizedRoutingText(taskText)
  if (explicitVisualMethod) return true
  // A negação vale apenas para o trecho que ela governa. Removê-la antes de
  // procurar superfícies preserva pedidos como "ajuste o header; sem mudanças
  // na UI fora do header", sem transformar "adapter; no UI changes" em UI.
  const hasExplicitNonUiScope = NON_UI_SCOPE_RE.test(text)
  const withoutNegatedScope = text.replace(new RegExp(NON_UI_SCOPE_RE.source, 'g'), ' ')
  // Uma negação inequívoca elimina substantivos ambíguos até na lane front
  // (Authorization header, table types, RPC dialog). Só evidência visual forte
  // fora do trecho negado pode elevar o card novamente.
  if (hasExplicitNonUiScope) return CROSS_DEPARTMENT_UI_RE.test(withoutNegatedScope)
  if (['front', 'design'].includes(department)) return UI_SURFACE_RE.test(withoutNegatedScope)
  if (CROSS_DEPARTMENT_UI_RE.test(withoutNegatedScope)) return true
  return CROSS_DEPARTMENT_UI_ACTION_RE.test(withoutNegatedScope)
}

export interface UiWorkClassificationInput {
  department: string
  title?: string
  description?: string
  briefing?: string
  quests?: string[]
  feedback?: string
  affectsUi?: boolean
}

/** Fonte única da decisão visual em spawn, retry, report e helper. Um `false`
 * declarado nunca apaga evidência visual inequívoca surgida no feedback. */
export function classifyTaskUiWork(
  input: UiWorkClassificationInput,
  currentFeedback?: string
): boolean {
  // Na lane QA, nomes como "regressao visual", "screenshot" e a superficie
  // observada descrevem o TESTE, nao uma mutacao no produto. Cards novos de
  // codigo ja precisam declarar affectsUi; portanto somente `true` eleva uma
  // entrega de QA para o contrato visual de implementacao. Isso preserva a
  // distincao entre testar um modal e alterar o modal.
  if (input.department === 'qa' && input.affectsUi !== true) return false
  const text = [
    input.title,
    input.description,
    input.briefing,
    ...(input.quests ?? []),
    input.feedback,
    currentFeedback
  ]
    .filter(Boolean)
    .join('\n')
  return input.affectsUi === true || isUiSurfaceWork(input.department, text)
}

function routeIsUiWork<Department extends string>(
  input: PhaseSkillSelectionInput<Department>,
  explicitDefs: RoutableSkill<Department>[]
): boolean {
  if (input.uiCard !== undefined) return input.uiCard
  return isUiSurfaceWork(
    input.department,
    input.taskText,
    explicitDefs.some(isVisualMethod)
  )
}

type NativeDeliveryLane = 'backend' | 'devops' | 'cyber' | 'data' | 'research' | 'copy' | 'qa'

function nativeDeliveryLane(department: string, devOpsWork: boolean): NativeDeliveryLane | undefined {
  if (department === 'cyber') return 'cyber'
  if (department === 'data') return 'data'
  if (department === 'research') return 'research'
  if (department === 'copy') return 'copy'
  if (department === 'qa') return 'qa'
  if (department === 'back') return devOpsWork ? 'devops' : 'backend'
  return undefined
}

function nativeDeliverySkillIds(
  lane: NativeDeliveryLane | undefined,
  phase: SkillExecutionPhase
): string[] {
  if (!lane || phase === 'review') return []
  if (lane === 'backend') {
    return phase === 'qa'
      ? [SYNKORA_BACKEND_STANDARD_ID, SYNKORA_BACKEND_QA_ID]
      : [SYNKORA_BACKEND_STANDARD_ID]
  }
  if (lane === 'devops') {
    return phase === 'qa'
      ? [SYNKORA_DEVOPS_STANDARD_ID, SYNKORA_DEVOPS_QA_ID]
      : [SYNKORA_DEVOPS_STANDARD_ID]
  }
  if (lane === 'cyber') {
    return phase === 'qa'
      ? [SYNKORA_CYBER_STANDARD_ID, SYNKORA_CYBER_QA_ID]
      : [SYNKORA_CYBER_STANDARD_ID]
  }
  if (lane === 'data') {
    return phase === 'qa'
      ? [SYNKORA_DATA_STANDARD_ID, SYNKORA_DATA_QA_ID]
      : [SYNKORA_DATA_STANDARD_ID]
  }
  if (lane === 'research') {
    return phase === 'qa'
      ? [SYNKORA_RESEARCH_STANDARD_ID, SYNKORA_RESEARCH_QA_ID]
      : [SYNKORA_RESEARCH_STANDARD_ID]
  }
  if (lane === 'qa') {
    return phase === 'qa' ? [SYNKORA_QA_QA_ID] : [SYNKORA_QA_STANDARD_ID]
  }
  return phase === 'qa'
    ? [SYNKORA_COPY_STANDARD_ID, SYNKORA_COPY_QA_ID]
    : [SYNKORA_COPY_STANDARD_ID]
}

/**
 * Plano pequeno e determinístico por fase.
 *
 * - DEV de UI: contrato + no máximo um Impeccable + uma técnica.
 * - REVIEW/QA: allowlists próprias; nunca herdam a metodologia visual do DEV.
 * - Escolha explícita vence `defaultFor`; disponibilidade nunca amplia o plano.
 */
export function selectPhaseSkillPlan<Department extends string>(
  input: PhaseSkillSelectionInput<Department>
): PhaseSkillSelection {
  const explicitSkillIds = uniqueIds(input.explicitSkillIds)
  const installedById = installedSkillById(input.defs, input.isInstalled)
  const availableCapabilities = input.availableCapabilities ?? ALL_SKILL_CAPABILITIES
  const compatibilityOf = (
    def: RoutableSkill<Department>,
    phase: SkillExecutionPhase | 'planning' = input.phase
  ): SkillCompatibilityIssue | undefined =>
    skillCompatibilityIssue(def, phase, availableCapabilities)
  const byId = new Map(
    [...installedById].filter(([, def]) => compatibilityOf(def) === undefined)
  )
  const explicitDefs = explicitSkillIds
    .map((id) => installedById.get(id))
    .filter((def): def is RoutableSkill<Department> => Boolean(def))
  const explicitIssues = explicitDefs.map((def) => compatibilityOf(def))

  if (input.phase === 'review') {
    const required = installedById.get(SYNKORA_REVIEW_STANDARD_ID)
    return {
      skillIds: byId.has(SYNKORA_REVIEW_STANDARD_ID) ? [SYNKORA_REVIEW_STANDARD_ID] : [],
      agentIds: [],
      incompatibilities: uniqueCompatibilityIssues([
        required ? compatibilityOf(required) : undefined
      ])
    }
  }

  const operation = detectImpeccableOperation(input.taskText)
  const uiWork = routeIsUiWork(input, explicitDefs)
  const designSystemWork = uiWork && isDesignSystemWork(input.department, input.taskText)
  const devOpsWork = !designSystemWork && isDevOpsWork(input.department, input.taskText)
  const deliveryLane = nativeDeliveryLane(input.department, devOpsWork)
  const deliverySkillIds = nativeDeliverySkillIds(deliveryLane, input.phase)

  if (input.phase === 'qa') {
    const uiRequiredIds = uiWork
      ? [
          SYNKORA_FRONTEND_STANDARD_ID,
          SYNKORA_UI_QA_ID,
          ...(designSystemWork ? [SYNKORA_DESIGN_SYSTEM_QA_ID] : [])
        ]
      : []
    const requiredIds = [
      ...deliverySkillIds,
      ...uiRequiredIds,
      ...(!deliveryLane && !uiWork ? [SYNKORA_RUNTIME_QA_ID] : [])
    ]
    return {
      skillIds: requiredIds.filter((id) => byId.has(id)),
      agentIds: [],
      incompatibilities: uniqueCompatibilityIssues([
        ...requiredIds.map((id) => {
          const def = installedById.get(id)
          return def ? compatibilityOf(def) : undefined
        })
      ])
    }
  }

  const routedTechnique = designSystemWork
    ? undefined
    : firstExplicitOrFallback(
        input.defs,
        byId,
        explicitSkillIds,
        input.department,
        (def) =>
          def.depts.includes(input.department) &&
          def.id !== SYNKORA_FRONTEND_STANDARD_ID &&
          def.adapter !== 'synkora-native' &&
          !isVisualMethod(def),
        true,
        input.taskText,
        devOpsWork ? 'devops' : undefined
      )
  // Cada departamento pode ter uma única técnica-base curada. Disponibilidade
  // nunca amplia além dela; um carimbo explícito compatível continua vencendo.
  const technique = routedTechnique
  const visualOperation = uiWork && !designSystemWork ? operation ?? 'polish' : undefined
  const visualMethod =
    designSystemWork && byId.has(SYNKORA_DESIGN_SYSTEM_STANDARD_ID)
      ? SYNKORA_DESIGN_SYSTEM_STANDARD_ID
      : visualOperation && byId.has(IMPECCABLE_SKILL_ID)
        ? IMPECCABLE_SKILL_ID
        : undefined
  const mayExposeAgent =
    input.phase !== 'helper' &&
    input.executionMode !== 'fast' &&
    input.delegationMode !== 'none'
  const explicitAgentDefs = uniqueIds(input.explicitAgentIds)
    .map((id) => input.defs.find((candidate) => candidate.id === id))
    .filter((def): def is RoutableSkill<Department> => Boolean(def))
  const explicitAgent = mayExposeAgent
    ? explicitAgentDefs.find((def) => {
        return Boolean(
          def?.kind === 'agent' &&
            def.depts.includes(input.department) &&
            input.isInstalled(def.id) &&
            compatibilityOf(def, 'helper') === undefined
        )
      })?.id
    : undefined
  const contextualAgent =
    mayExposeAgent && !explicitAgent && input.delegationMode === 'parallel'
      ? detectContextualAgentId({
          department: input.department,
          taskText: input.taskText,
          isEligible: (id) => {
            const def = input.defs.find((candidate) => candidate.id === id)
            return Boolean(
              def?.kind === 'agent' &&
                def.depts.includes(input.department) &&
                input.isInstalled(def.id) &&
                compatibilityOf(def, 'helper') === undefined
            )
          }
        })
      : undefined
  const selectedAgent = explicitAgent ?? contextualAgent
  const requiredIds = [
    ...deliverySkillIds,
    ...(uiWork
      ? [
        SYNKORA_FRONTEND_STANDARD_ID,
        designSystemWork ? SYNKORA_DESIGN_SYSTEM_STANDARD_ID : IMPECCABLE_SKILL_ID
      ]
      : [])
  ]

  return {
    skillIds: [
      ...new Set([
        ...deliverySkillIds.filter((id) => byId.has(id)),
        ...(uiWork ? [SYNKORA_FRONTEND_STANDARD_ID] : []),
        ...(visualMethod ? [visualMethod] : []),
        ...(technique ? [technique.id] : [])
      ])
    ],
    agentIds: selectedAgent ? [selectedAgent] : [],
    ...(visualOperation ? { uiOperation: visualOperation } : {}),
    ...(visualMethod ? { impeccableOperation: visualOperation } : {}),
    incompatibilities: uniqueCompatibilityIssues([
      ...explicitIssues,
      ...explicitAgentDefs.map((def) => compatibilityOf(def, 'helper')),
      ...requiredIds.map((id) => {
        const def = installedById.get(id)
        return def ? compatibilityOf(def) : undefined
      })
    ])
  }
}

export type FrontendStandardPhase = 'dev' | 'review' | 'qa'

/** DEV de front/design e o QA desses cards nunca podem degradar sem a régua. */
export function missingMandatoryFrontendStandard(
  injectedIds: Iterable<string>,
  department: string,
  phase: FrontendStandardPhase,
  uiWork = ['front', 'design'].includes(department)
): boolean {
  if (!uiWork || !['dev', 'qa'].includes(phase)) return false
  return !new Set(injectedIds).has(SYNKORA_FRONTEND_STANDARD_ID)
}

/** Retorna as ausencias materiais do contrato da fase, para o spawn falhar
 * fechado em vez de executar uma UI sem a regua ou um QA sem independência. */
export function missingMandatoryUiPhaseSkills(
  injectedIds: Iterable<string>,
  department: string,
  phase: FrontendStandardPhase,
  uiWork = ['front', 'design'].includes(department),
  designSystemWork = false,
  devOpsWork = false
): string[] {
  const injected = new Set(injectedIds)
  if (phase === 'review') {
    return injected.has(SYNKORA_REVIEW_STANDARD_ID) ? [] : [SYNKORA_REVIEW_STANDARD_ID]
  }
  if (!['dev', 'qa'].includes(phase)) return []
  const deliveryLane = nativeDeliveryLane(department, devOpsWork)
  const functionalRequired = nativeDeliverySkillIds(deliveryLane, phase)
  const uiRequired = uiWork
    ? [
        SYNKORA_FRONTEND_STANDARD_ID,
        ...(phase === 'dev'
          ? [designSystemWork ? SYNKORA_DESIGN_SYSTEM_STANDARD_ID : IMPECCABLE_SKILL_ID]
          : []),
        ...(phase === 'qa'
          ? [
              SYNKORA_UI_QA_ID,
              ...(designSystemWork ? [SYNKORA_DESIGN_SYSTEM_QA_ID] : [])
            ]
          : [])
      ]
    : []
  const required = [
    ...functionalRequired,
    ...uiRequired,
    ...(!deliveryLane && !uiWork && phase === 'qa' ? [SYNKORA_RUNTIME_QA_ID] : [])
  ]
  return required.filter((id) => !injected.has(id))
}

/** A régua visual é contrato do produto, não uma skill opcional do orçamento. */
export function withMandatoryFrontendStandard<Department extends string>(
  ids: Iterable<string>,
  department: Department
): string[] {
  return [
    ...new Set([
      ...ids,
      ...(['front', 'design'].includes(department) ? [SYNKORA_FRONTEND_STANDARD_ID] : [])
    ])
  ]
}

/** FAST QA mantém os dois contratos obrigatórios, sem técnica adicional. */
export function selectFastQaUiSkillIds(
  installedQaIds: Iterable<string>,
  uiCard: boolean,
  designSystemWork = false
): string[] {
  if (!uiCard) return []
  return [...installedQaIds].filter(
    (id) =>
      id === SYNKORA_FRONTEND_STANDARD_ID ||
      id === SYNKORA_UI_QA_ID ||
      (designSystemWork && id === SYNKORA_DESIGN_SYSTEM_QA_ID)
  )
}

export function selectInstalledIdsForDepartment<Department extends string>(
  defs: RoutableSkill<Department>[],
  isInstalled: (id: string) => boolean,
  department: Department,
  kind: 'skill' | 'agent' = 'skill'
): string[] {
  return defs
    .filter(
      (def) =>
        def.kind === kind &&
        !def.manualOnly &&
        def.depts.includes(department) &&
        isInstalled(def.id)
    )
    .map((def) => def.id)
}

/**
 * O Maestro recebe somente o contrato nativo. Skills externas de planejamento
 * permanecem no catalogo manual, mas nunca viram fallback deste fluxo.
 */
export function selectInstalledPlanningIds<Department extends string>(
  defs: RoutableSkill<Department>[],
  isInstalled: (id: string) => boolean
): string[] {
  const native = defs.find(
    (def) =>
      def.id === SYNKORA_PLANNING_STANDARD_ID &&
      def.kind === 'skill' &&
      def.group.trim().toLocaleLowerCase('pt-BR') === 'planejamento' &&
      def.manualOnly !== true &&
      def.allowedPhases?.includes('planning') === true &&
      def.adapter === 'synkora-native'
  )
  return native && isInstalled(native.id) ? [native.id] : []
}

/**
 * Workflows manuais escolhidos numa execução anterior não podem continuar
 * sendo descobertos automaticamente pelo CLI no mesmo workspace. A biblioteca
 * usa esta lista para retirar somente cópias que ela própria gerenciou.
 */
export function selectInstalledManualOnlyIdsToPrune<Department extends string>(
  defs: RoutableSkill<Department>[],
  isInstalled: (id: string) => boolean,
  requestedIds: Iterable<string>
): string[] {
  const requested = new Set(requestedIds)
  return defs
    .filter(
      (def) =>
        def.kind === 'skill' &&
        def.manualOnly === true &&
        isInstalled(def.id) &&
        !requested.has(def.id)
    )
    .map((def) => def.id)
}

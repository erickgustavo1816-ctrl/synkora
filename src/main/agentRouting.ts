/**
 * Roteamento fechado das personas especializadas do Synkora.
 *
 * O ORQUESTRADOR decide se o card tem trabalho longo e independente ao
 * declarar delegation=parallel. Este módulo não cria paralelismo por palavra
 * solta: ele escolhe, no máximo, a melhor persona para o subproblema que o
 * orquestrador já decidiu delegar. Disponibilidade nunca amplia o plano.
 */

export interface AgentIntentRule {
  id: string
  departments: string[]
  pattern: RegExp
  priority: number
}

const rule = (
  id: string,
  departments: string[],
  pattern: RegExp,
  priority = 10
): AgentIntentRule => ({ id, departments, pattern, priority })

// Mais específico primeiro. A pontuação também privilegia o título/primeira
// linha, para uma restrição incidental no briefing não vencer o dono real do
// subproblema.
export const AGENT_INTENT_RULES: readonly AgentIntentRule[] = [
  // FRONT / DESIGN visual
  rule('css-surgeon', ['front'], /\b(?:specificity|especificidade|cascade layers?|camadas? de cascata|!important|dead css|css morto|refator\w* (?:de )?css|stylesheet refactor)\b/, 18),
  rule('motion-choreographer', ['front'], /\b(?:animat\w*|animac\w*|transitions?|transic\w*|micro[- ]?intera\w*|motion implementation|enter\/exit choreography)\b/, 15),
  rule('design-token-guardian', ['front', 'design'], /\b(?:design tokens?|tokens? de design|semantic tokens?|tokens? semantic\w*|hardcoded (?:colors?|spacing|values?)|valores? (?:de cor|espacamento) hardcoded|style dictionary)\b/, 19),
  rule('responsive-auditor', ['front'], /\b(?:responsiv\w*|breakpoints?|viewports?|container quer\w*|mobile|tablet|overflow|clipping|touch targets?)\b/, 12),
  rule('component-architect', ['front'], /\b(?:reusable component|componente reutiliz\w*|component api|api do componente|boolean props?|compound components?|variants? tipad\w*|composicao de componentes)\b/, 16),
  rule('microcopy-reviewer', ['front'], /\b(?:microcopy|button labels?|rotulos? de botoes?|error messages?|mensagens? de erro|empty states?|estados? vazios?|confirmation copy)\b/, 13),
  rule('web-perf-auditor', ['front'], /\b(?:core web vitals?|\bLCP\b|\bCLS\b|\bINP\b|web performance|performance web|bundle size|render performance|pagina lenta|page speed)\b/i, 18),
  rule('form-ux-specialist', ['front'], /\b(?:forms?|formularios?|field validation|validacao de campos?|autofill|autocomplete|input masks?|mascaras? de input|mobile keyboard|multi[- ]?step form)\b/, 22),
  rule('svg-icon-specialist', ['front', 'design'], /\b(?:svg icons?|icones? svg|icon set|conjunto de icones?|viewbox|currentcolor|inline svg|sprite de icones?)\b/, 18),
  rule('dataviz-frontend', ['front', 'data'], /\b(?:charts?|graficos?|data visualization|visualizacao de dados|analytics dashboard|dashboard de (?:dados|metricas|kpis?)|kpi tiles?|eixos?|axes|tooltips?|series? de dados)\b/, 14),

  // BACK / infraestrutura
  rule('sql-query-surgeon', ['back', 'data'], /\b(?:slow quer\w*|query lenta|sql performance|desempenho (?:de )?sql|explain analyze|missing index|indice ausente|n\+1|query plan|plano de execucao|pagination query)\b/, 20),
  rule('migration-surgeon', ['back', 'data'], /\b(?:database migration|migrac\w* (?:de )?(?:banco|schema)|alter table|backfill|zero[- ]downtime|expand[- ]migrate[- ]contract|schema change|mudanca de schema)\b/, 20),
  rule('api-contract-guardian', ['back'], /\b(?:api contract|contrato de api|request\/response|request (?:and|e) response|dtos?|status codes?|error shape|breaking api|public endpoint|pagination contract)\b/, 18),
  rule('container-optimizer', ['back', 'cyber'], /\b(?:dockerfiles?|docker images?|imagem de container|container image|multi[- ]stage|layer caching|cache de camadas|base image|docker compose|container build)\b/, 17),
  rule('ci-doctor', ['back'], /\b(?:ci (?:is )?(?:red|failing|slow)|pipeline (?:falhando|lento|quebrado)|github actions? (?:failure|failing|slow)|workflow (?:failure|falhando)|cold cache|runner|flaky jobs?)\b/, 18),
  rule('observability-instrumentor', ['back', 'cyber'], /\b(?:observability|observabilidade|structured logs?|logs? estruturad\w*|metrics? instrumentation|instrumentacao de metricas|distributed trac\w*|tracing|request[- ]id|telemetry|telemetria)\b/, 16),
  rule('backend-reality-checker', ['back', 'data'], /\b(?:verify backend|validar backend|fresh verification|verificacao fresca|prove the endpoint|provar (?:a )?rota|real commands?|comandos? reais?|migration applied|migracao aplicada)\b/, 8),

  // QA autoral
  rule('playwright-test-healer', ['qa'], /\b(?:heal\w* playwright|playwright.*(?:failing|failure|quebrad\w*|falhando)|test_debug|debugar? (?:os? )?testes? playwright)\b/, 22),
  rule('playwright-test-planner', ['qa'], /\b(?:playwright test plan|plano de testes? playwright|planejar cenarios? playwright|test scenario plan)\b/, 21),
  rule('playwright-test-generator', ['qa'], /\b(?:generate playwright tests?|gerar testes? playwright|write playwright specs?|gravar testes? playwright)\b/, 20),
  rule('flaky-test-surgeon', ['qa'], /\b(?:flaky tests?|testes? flaky|intermittent tests?|testes? intermitentes?|passes? on rerun|order[- ]dependent|timing[- ]sensitive)\b/, 21),
  rule('bug-reproducer', ['qa'], /\b(?:reproduce (?:the )?bug|reproduzir (?:o )?bug|minimal repro|repro minima|works on my machine|report vago|intermittent bug)\b/, 19),
  rule('regression-hunter', ['qa'], /\b(?:regression hunt|cacar? regress\w*|blast radius|raio de explosao|collateral damage|danos? colaterais?|guard tests? after (?:a )?fix)\b/, 18),
  rule('e2e-scenario-author', ['qa'], /\b(?:e2e|end[- ]to[- ]end|user flows? tests?|testes? de fluxo|critical path tests?|cenarios? no navegador)\b/, 16),
  rule('acceptance-verifier', ['qa'], /\b(?:(?:verify|validate|walk|check)\w*.{0,36}(?:acceptance criteri(?:on|a)|requirements?|final checklist)|(?:verificar|validar|percorrer|conferir)\w*.{0,36}(?:criterios? de aceite|requisitos?|checklist final)|item by item verification|verificacao item a item)\b/, 12),
  rule('test-writer', ['qa'], /\b(?:write tests?|escrever testes?|test coverage|cobertura de testes?|unit tests?|integration tests?|testes? unitarios?|testes? de integracao|behavioral tests?)\b/, 8),

  // DESIGN
  rule('image-asset-producer', ['design'], /\b(?:generate image|gerar imagem|image assets?|assets? de imagem|hero art|background art|illustrations?|ilustrac\w*)\b/, 17),
  rule('mockup-artist', ['design'], /\b(?:mockups?|prototipo visual|visual prototype|static html directions?|direcoes? visuais?|approve direction|aprovar direcao)\b/, 18),
  rule('brand-guardian', ['design'], /\b(?:brand consistency|consistencia de marca|brand identity|identidade de marca|brand audit|auditoria de marca|visual tone)\b/, 15),
  rule('svg-logo-producer', ['design'], /\b(?:svg logos?|logos? em svg|wordmarks?|favicon from logo|variantes? de logo|logo files?)\b/, 20),
  rule('motion-director', ['design'], /\b(?:motion language|linguagem de motion|motion system|sistema de movimento|motion direction|direcao de motion|animation vocabulary)\b/, 19),
  rule('design-brief-writer', ['design'], /\b(?:design brief|brief visual|pedido (?:de design )?vago|make it nicer|direcao visual aberta|open[- ]ended design)\b/, 17),
  rule('palette-composer', ['design'], /\b(?:color palette|paleta de cores?|oklch|color ramps?|rampas? de cor|semantic colors?|cores? semantic\w*|dark mode palette)\b/, 18),
  rule('ux-flow-mapper', ['design'], /\b(?:ux flow|fluxo de ux|user journey|jornada do usuario|screen flow|fluxo de telas?|multi[- ]screen|architecture of screens|arquitetura de telas)\b/, 17),
  rule('favicon-og-producer', ['design'], /\b(?:favicon kit|app icon kit|apple[- ]touch icon|maskable icons?|og image|open graph image|social image|pwa icons?)\b/, 19),

  // RESEARCH
  rule('context-curator', ['research'], /\b(?:context\.md|project dossier|dossie do projeto|curate context|curar contexto|reports? pile|consolidar aprendizados?|knowledge shelf)\b/, 16),

  // COPY
  rule('microcopy-surgeon', ['copy'], /\b(?:microcopy|button labels?|rotulos? de botoes?|error messages?|mensagens? de erro|empty states?|toasts?|tooltips?|confirmation dialogs?)\b/, 17),
  rule('voice-guardian', ['copy'], /\b(?:voice\.md|brand voice|voz da marca|verbal identity|identidade verbal|tone matrix|matriz de tom|voice guide)\b/, 18),
  rule('terminology-guardian', ['copy'], /\b(?:glossary|glossario|terminology|terminologia|canonical terms?|termos? canonicos?|naming drift|deriva terminologica|pt.*en terms?)\b/, 18),
  rule('release-notes-writer', ['copy'], /\b(?:release notes?|notas? de release|notas? da versao|what'?s new|changelog para usuarios?)\b/, 19),
  rule('copy-localizer', ['copy'], /\b(?:localiz\w*|locales?|translation|traduc\w*|i18n strings?|multilingual copy|copy multil[ií]ngue|placeholders? quebrad\w*)\b/, 18),
  rule('conversion-copy-reviewer', ['copy'], /\b(?:conversion copy|copy de conversao|landing page|pricing page|pagina de precos|signup flow|checkout copy|cta|objections?|objecoes?|friction audit)\b/, 16),

  // DATA
  rule('analytics-engineer', ['data'], /\b(?:dbt|staging.*marts?|dimensional model|modelo dimensional|slowly changing dimension|\bscd\b|incremental model|transformation layer|camada de transformacao)\b/, 19),
  rule('data-quality-sentinel', ['data'], /\b(?:data quality|qualidade de dados|null rate|null%|duplicates?|duplicatas?|orphans?|orfaos?|freshness|reconciliation|reconciliacao|backfill validation)\b/, 18),
  rule('dataframe-surgeon', ['data'], /\b(?:pandas|polars|duckdb|dataframes?|out of memory|\boom\b|memory blowup|chained assignment|dtypes?|timezones?|notebook.*production)\b/, 18),
  rule('experiment-designer', ['data'], /\b(?:a\/b tests?|ab tests?|experiments?|experimentos?|minimum detectable effect|\bmde\b|sample size|tamanho da amostra|randomization unit|guardrail metrics?)\b/, 19),
  rule('event-taxonomy-designer', ['data'], /\b(?:event taxonomy|taxonomia de eventos|tracking plan|plano de tracking|analytics instrumentation|instrumentacao de analytics|event properties|propriedades de eventos|tracking\.md)\b/, 19),
  rule('metrics-guardian', ['data'], /\b(?:metric definitions?|definicoes? de metricas?|metrics? drift|divergencia de metricas?|two dashboards disagree|dashboards? divergem|numerator|denominator|numerador|denominador|metrics\.md)\b/, 17),

  // CYBER defensivo
  rule('secrets-hygiene-auditor', ['cyber'], /\b(?:secret leak|vazamento de segredo|hardcoded credentials?|credenciais? hardcoded|git history.*secret|segredos?.*historico git|\.env hygiene|ci masking|gitleaks?)\b/, 21),
  rule('dependency-auditor', ['cyber'], /\b(?:dependency audit|auditoria de dependencias|cve|lockfile integrity|integridade do lockfile|typosquat|postinstall|supply chain|cadeia de suprimentos|vulnerable package)\b/, 20),
  rule('authz-reviewer', ['cyber'], /\b(?:authorization|autorizacao|access control|controle de acesso|tenant isolation|isolamento de tenant|idor|bola|privilege escalation|escalada de privilegio|session handling|gestao de sessao|jwt auth|autenticacao jwt|auth cookies?)\b/, 20),
  rule('threat-modeler', ['cyber'], /\b(?:threat model|modelo de ameacas?|stride|trust boundaries?|fronteiras? de confianca|data flow threats?|ameacas? por componente)\b/, 19),
  rule('privacy-engineer', ['cyber'], /\b(?:privacy|privacidade|lgpd|gdpr|pii inventory|inventario de pii|data retention|retencao de dados|dsar|data subject|titular de dados|telemetry leakage)\b/, 19),
  rule('crypto-usage-reviewer', ['cyber'], /\b(?:cryptograph\w*|criptograf\w*|encryption|hashing|password hash|jwt algorithm|algoritmo.*jwt|static iv|iv estatico|csprng|tls settings?)\b/, 19),
  rule('web-surface-hardener', ['cyber'], /\b(?:content security policy|\bcsp\b|security headers?|cabecalhos? de seguranca|samesite|cors|csrf|ssrf|file uploads?|uploads? de arquivos?|open redirects?|rate limit)\b/, 18),
  rule('security-fix-verifier', ['cyber'], /\b(?:verify security fix|validar (?:o )?fix de seguranca|security regression test|teste de regressao de seguranca|confirmed finding|achado confirmado|prove (?:the )?exploit is dead|provar que o exploit morreu)\b/, 22)
]

function normalized(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
}

function count(pattern: RegExp, value: string): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return [...value.matchAll(new RegExp(pattern.source, flags))].length
}

export function detectContextualAgentId(input: {
  department: string
  taskText: string
  isEligible?: (id: string) => boolean
}): string | undefined {
  const text = normalized(input.taskText)
  const lead = text.split(/\r?\n/, 1)[0].slice(0, 300)
  const isEligible = input.isEligible ?? (() => true)
  const matches = AGENT_INTENT_RULES
    .filter(
      (candidate) =>
        candidate.departments.includes(input.department) &&
        isEligible(candidate.id) &&
        candidate.pattern.test(text)
    )
    .map((candidate) => {
      const explicitId = text.includes(candidate.id)
      return {
        ...candidate,
        score:
          (explicitId ? 100 : 0) +
          candidate.priority +
          count(candidate.pattern, text) * 3 +
          count(candidate.pattern, lead) * 5
      }
    })
    .sort((left, right) => right.score - left.score || right.priority - left.priority)
  return matches[0]?.id
}

/** A persona roteada ocupa um único ajudante da rodada. Outros blocos
 * paralelos continuam genéricos; repetir a persona só empilharia o mesmo
 * método sobre ownerships diferentes. */
export function plannedAgentForHelper(input: {
  requestedAgentId?: string
  plannedAgentId?: string
  plannedAlreadyAssigned: boolean
}): string | undefined {
  if (input.plannedAlreadyAssigned) return undefined
  return input.requestedAgentId ?? input.plannedAgentId
}

/** Barreira pura usada pelo report(done): decisão parallel e persona roteada
 * são obrigações distintas, ambas ligadas à phaseRun exata. */
export function plannedHelperCompletionProblem(input: {
  delegationMode?: string
  phaseRun?: string
  requiredAgentId?: string
  completedHelperPhaseRuns: ReadonlySet<string>
  completedAgentsByPhaseRun: ReadonlyMap<string, ReadonlySet<string>>
}): string | undefined {
  if (!input.phaseRun) return undefined
  if (
    input.delegationMode === 'parallel' &&
    !input.completedHelperPhaseRuns.has(input.phaseRun)
  ) {
    return 'o orquestrador planejou paralelismo para esta rodada, mas nenhum ajudante concluiu e reportou. Abra o ajudante planejado, integre o resultado e só então reporte done.'
  }
  if (
    input.requiredAgentId &&
    !input.completedAgentsByPhaseRun.get(input.phaseRun)?.has(input.requiredAgentId)
  ) {
    return `o subagente especialista ${input.requiredAgentId} foi selecionado para esta rodada, mas nenhum ajudante com essa persona concluiu e reportou. Abra-o via delegate e integre o resultado antes de reportar done.`
  }
  return undefined
}

/**
 * Contrato de proporcionalidade do orquestrador. A persona escolhe o modo,
 * mas estas regras impedem que uma missão declarada rápida esconda ondas,
 * vários cards ou ajudantes. Os gates continuam proporcionais ao RISCO e ao
 * tipo de entregável — código rápido ainda pode exigir a rede completa.
 */
export type MissionExecutionMode = 'fast' | 'standard' | 'deep'
export type MissionRiskLevel = 'low' | 'medium' | 'high'
export type TaskDelegationMode = 'none' | 'optional' | 'parallel'
export type TaskDeliverableKind = 'code' | 'non_code'
export type OrchestratorTaskGate = 'review' | 'qa'

/** Superfícies cujo impacto mínimo não pode depender só da classificação do agente. */
export type MissionRiskSurface =
  | 'authentication'
  | 'authorization'
  | 'tenant_boundary'
  | 'payments'
  | 'secrets'
  | 'personal_data'
  | 'destructive_data'
  | 'data_migration'
  | 'public_contract'
  | 'concurrency'
  | 'release_infrastructure'
  | 'file_upload'
  | 'admin_support'
  | 'ai_agents'
  | 'external_integration'
  | 'abuse_controls'
  | 'logging_errors'
  | 'security_configuration'
  | 'supply_chain'
  | 'cryptography'
  | 'data_exposure'

export interface MissionRiskReason {
  surface: MissionRiskSurface
  minimumRisk: MissionRiskLevel
  reason: string
  /** Palavra/sinal encontrado ou a indicação de que a superfície foi declarada. */
  evidence: string
}

export interface MissionRiskAssessment {
  declaredRisk: MissionRiskLevel
  effectiveRisk: MissionRiskLevel
  raised: boolean
  surfaces: MissionRiskSurface[]
  reasons: MissionRiskReason[]
}

export interface MissionRiskAssessmentInput {
  /** Ausente em inspeções preliminares; normaliza para medium. */
  declaredRisk?: unknown
  /** Título, objetivo, escopo, resumo e briefings que já existem no momento. */
  texts?: readonly unknown[]
  /** Sinais tipados declarados pelo planejador; texto continua sendo inspecionado. */
  surfaces?: readonly unknown[]
}

export interface PlanDependencyItem {
  /** Identificador estável dentro do plano, não o UUID gerado para o card. */
  id: string
  /** Onda tipada; itens da mesma onda são independentes e podem rodar juntos. */
  waveId: string
  /** IDs de itens de ondas anteriores que precisam estar entregues. */
  dependsOn: readonly string[]
}

export interface PlanDependencyInput {
  mode: MissionExecutionMode
  expectedCards: number
  items: readonly PlanDependencyItem[]
}

export interface PlanCompletionCard {
  status: 'backlog' | 'execucao' | 'qa' | 'done'
}

export interface PlanCompletionInput {
  mode: MissionExecutionMode
  expectedCards: number
  cards: readonly PlanCompletionCard[]
}

export interface PlanSizingInput {
  mode: MissionExecutionMode
  expectedCards: number
  laneCount: number
}

export interface TaskSizingInput {
  effort?: 'leve' | 'pesada'
  gates?: OrchestratorTaskGate[]
  delegation?: TaskDelegationMode
  deliverable?: TaskDeliverableKind
  skills?: string[]
  agents?: string[]
  quests?: string[]
  /** Função do card — test card (dept qa) é isento do piso review+QA. */
  department?: string
}

export const EXECUTION_MODE_LABEL: Record<MissionExecutionMode, string> = {
  fast: 'rápido',
  standard: 'equilibrado',
  deep: 'aprofundado'
}

export function normalizeExecutionMode(value: unknown): MissionExecutionMode {
  return value === 'fast' || value === 'deep' || value === 'standard' ? value : 'standard'
}

export function normalizeDelegationMode(
  value: unknown,
  executionMode: MissionExecutionMode
): TaskDelegationMode {
  if (executionMode === 'fast') return 'none'
  return value === 'none' || value === 'parallel' || value === 'optional'
    ? value
    : 'optional'
}

/** Cards novos do Maestro não podem reabrir a decisão no executor. O modo
 * optional permanece no tipo somente para carregar cards legados. */
export function newTaskDelegationProblem(value: unknown): string | undefined {
  return value === 'none' || value === 'parallel'
    ? undefined
    : 'todo card novo precisa declarar delegation="none" ou delegation="parallel"; optional é apenas legado'
}

export function normalizeRiskLevel(value: unknown): MissionRiskLevel {
  return value === 'low' || value === 'high' || value === 'medium' ? value : 'medium'
}

export const MISSION_RISK_SURFACE_VALUES = [
  'authentication',
  'authorization',
  'tenant_boundary',
  'payments',
  'secrets',
  'personal_data',
  'destructive_data',
  'data_migration',
  'public_contract',
  'concurrency',
  'release_infrastructure',
  'file_upload',
  'admin_support',
  'ai_agents',
  'external_integration',
  'abuse_controls',
  'logging_errors',
  'security_configuration',
  'supply_chain',
  'cryptography',
  'data_exposure'
] as const satisfies readonly MissionRiskSurface[]

const MISSION_RISK_SURFACES = new Set<MissionRiskSurface>(MISSION_RISK_SURFACE_VALUES)

interface MissionRiskSurfacePolicy {
  minimumRisk: MissionRiskLevel
  reason: string
}

const RISK_SURFACE_POLICIES: Record<MissionRiskSurface, MissionRiskSurfacePolicy> = {
  authentication: {
    minimumRisk: 'high',
    reason: 'autenticação e sessão podem permitir acesso indevido quando falham'
  },
  authorization: {
    minimumRisk: 'high',
    reason: 'autorização e permissões protegem limites de acesso entre usuários'
  },
  tenant_boundary: {
    minimumRisk: 'high',
    reason: 'isolamento entre clientes precisa existir em toda leitura, escrita, exportação e tarefa de fundo'
  },
  payments: {
    minimumRisk: 'high',
    reason: 'pagamentos e cobrança podem movimentar dinheiro ou gerar perdas financeiras'
  },
  secrets: {
    minimumRisk: 'high',
    reason: 'segredos e credenciais concedem acesso a sistemas externos e dados protegidos'
  },
  personal_data: {
    minimumRisk: 'high',
    reason: 'dados pessoais e sensíveis têm impacto de privacidade e conformidade'
  },
  destructive_data: {
    minimumRisk: 'high',
    reason: 'operações destrutivas podem causar perda de dados difícil de recuperar'
  },
  data_migration: {
    minimumRisk: 'high',
    reason: 'migrações alteram dados persistidos e precisam preservar compatibilidade e recuperação'
  },
  public_contract: {
    minimumRisk: 'medium',
    reason: 'contratos públicos podem quebrar integrações fora do controle do projeto'
  },
  concurrency: {
    minimumRisk: 'medium',
    reason: 'concorrência pode produzir falhas intermitentes, duplicidade ou corrupção de estado'
  },
  release_infrastructure: {
    minimumRisk: 'high',
    reason: 'infraestrutura de publicação pode afetar todos os usuários e o ambiente de produção'
  },
  file_upload: {
    minimumRisk: 'medium',
    reason: 'uploads, exports e storage combinam risco de acesso, privacidade, malware e custo'
  },
  admin_support: {
    minimumRisk: 'high',
    reason: 'ações administrativas e de suporte podem alterar acesso, dinheiro ou dados de outras pessoas'
  },
  ai_agents: {
    minimumRisk: 'medium',
    reason: 'agentes e ferramentas de IA precisam limitar conteúdo não confiável, dados e efeitos externos'
  },
  external_integration: {
    minimumRisk: 'medium',
    reason: 'integrações externas exigem autenticidade, menor privilégio, idempotência e limites de escopo'
  },
  abuse_controls: {
    minimumRisk: 'medium',
    reason: 'controles de abuso protegem custo, disponibilidade e regras de negócio por conta e recurso'
  },
  logging_errors: {
    minimumRisk: 'medium',
    reason: 'logs e falhas precisam preservar auditoria sem vazar dados nem liberar acesso por erro'
  },
  security_configuration: {
    minimumRisk: 'medium',
    reason: 'configuração de segurança e exposição pública podem regredir a cada publicação'
  },
  supply_chain: {
    minimumRisk: 'medium',
    reason: 'dependências, automações e instruções de agente são entrada executável da cadeia de software'
  },
  cryptography: {
    minimumRisk: 'high',
    reason: 'criptografia, chaves e certificados incorretos podem expor dados ou invalidar garantias de autenticidade'
  },
  data_exposure: {
    minimumRisk: 'high',
    reason: 'vazamento ou exfiltração pode atravessar limites de usuário, cliente, sistema ou finalidade autorizada'
  }
}

const RISK_SURFACE_RULES: readonly {
  surface: MissionRiskSurface
  pattern: RegExp
  minimumRisk?: MissionRiskLevel
  reason?: string
}[] = [
  {
    surface: 'supply_chain',
    minimumRisk: 'high',
    pattern:
      /(?<![a-z0-9_.-])\.claude[\/\\](?:agents|commands|skills)[\/\\][a-z0-9_./\\-]+|(?<![a-z0-9_.-])\.claude[\/\\]settings(?:\.local)?\.json\b|(?<![a-z0-9_.-])\.cursor[\/\\]rules(?:[\/\\][a-z0-9_./\\-]+)?|(?<![a-z0-9_.-])\.github[\/\\](?:copilot-instructions\.md|instructions[\/\\][a-z0-9_.-]+\.instructions\.md|prompts[\/\\][a-z0-9_.-]+\.prompt\.md)\b|(?<![a-z0-9_.-])\.(?:windsurf|roo|cline|continue)[\/\\]rules(?:[\/\\][a-z0-9_./\\-]+)?|(?<![a-z0-9_.-])\.gemini[\/\\](?:settings\.json|gemini\.md)\b|(?<![a-z0-9_.-])\.codex-plugin[\/\\]plugin\.json\b|(?<![a-z0-9_.-])\.(?:windsurfrules|clinerules|antigravity\.md)\b|\b(?:agents(?:\.override)?|claude(?:\.local)?|gemini|skill)\.md\b|\bcopilot-instructions\.md\b|\b[a-z0-9_-]+-ret-(?:product-)?security(?:-prompt)?\.(?:md|mdc|rules)\b|(?<![a-z0-9_.-])\.(?:codex|claude)(?![a-z0-9_-])|(?<![a-z0-9_.-])\.mcp\.json\b|\bmcp(?:-server|-config)?\.(?:json|ya?ml|toml)\b|\b(?:instrucao|instrucoes|configuracao) (?:de|dos?) agentes?\b/i,
    reason: 'instruções e configuração de agentes alteram comportamento executável, ferramentas e limites de confiança'
  },
  {
    surface: 'supply_chain',
    minimumRisk: 'high',
    pattern:
      /\b(?:cve-\d{4}-\d{4,}|ghsa-[a-z0-9-]{8,}|known vulnerable dependenc(?:y|ies)|vulnerable dependenc(?:y|ies)|dependenc(?:y|ies) vulnerabilit(?:y|ies)|dependenc(?:y|ies) (?:affected by|with) (?:a )?(?:cve|known vulnerabilit)|dependencias? vulner(?:avel|aveis)|vulnerabilidade (?:na|em|de) dependencia|dependencias? (?:afetadas? por|com) (?:cve|vulnerabilidade conhecida)|npm audit|pnpm audit|yarn audit|pip-audit|cargo audit|govulncheck|osv[ -]?scanner|software composition analysis|sca scan)\b/i,
    reason: 'uma vulnerabilidade conhecida em dependência exige confirmar versão, alcance no runtime, correção disponível e regressão'
  },
  {
    surface: 'supply_chain',
    minimumRisk: 'high',
    pattern:
      /\b(?:pretooluse|posttooluse|permissionrequest|userpromptsubmit|subagentstop|sessionstart|stop hook|tool hook|permission hook|hook de (?:agente|ferramenta|permissao)|gancho de (?:agente|ferramenta|permissao)|(?:mcp|skill|plugin)(?:[-_ ](?:server|package))?[-_ ]?manifest|manifesto (?:de|do) (?:mcp|skill|plugin)|instalar (?:uma? )?(?:skill|plugin|mcp) (?:extern[oa]|de terceiro))\b/i,
    reason: 'hooks e manifestos podem conceder ferramentas, executar comandos ou mudar o escopo de confiança do agente'
  },
  {
    surface: 'authorization',
    minimumRisk: 'high',
    pattern:
      /\b(?:idor|bola (?:na|da|em) (?:api|rota|endpoint|autorizacao|controle de acesso)|(?:falha|vulnerabilidade) bola|broken object level authorization|broken access control|horizontal privilege escalation|vertical privilege escalation|privilege escalation(?: horizontal| vertical)?|escalation of privileges|escalacao (?:horizontal |vertical )?de privilegios|elevacao (?:horizontal |vertical )?de privilegios|object ownership|resource ownership|record ownership|ownership (?:of|for) (?:objects?|resources?|records?)|autorizacao em nivel de objeto|acesso indevido a objeto de outro usuario)\b/i,
    reason: 'controle de acesso por objeto e propriedade precisa ser verificado no servidor em toda leitura e escrita'
  },
  {
    surface: 'cryptography',
    minimumRisk: 'high',
    pattern:
      /\b(?:cryptographic failures?|falhas? criptograficas?|weak cryptograph(?:y|ic)|criptografia fraca|encryption at rest|encryption in transit|criptografia em repouso|criptografia em transito|encrypt(?:ion|ed|ing)?|decrypt(?:ion|ed|ing)?|criptograf(?:ia|ar|ado|ada)|descriptograf(?:ar|ado|ada)|cipher(?:text| suite)?|nonce reuse|reutilizacao de nonce|(?:static|reused) iv|iv (?:estatico|reutilizado)|ecb mode|password hashing|hash de senha|certificate pinning|tls termination|mutual tls|mtls)\b/i,
    reason: 'primitivas, parâmetros e ciclo de vida criptográfico precisam de biblioteca mantida, chaves protegidas e migração verificável'
  },
  {
    surface: 'data_exposure',
    minimumRisk: 'high',
    pattern:
      /\b(?:data exfiltration|exfiltration(?: of data)?|exfiltracao(?: de dados)?|data leak(?:age)?|vazamento de dados|(?:sensitive )?data exposure|exposicao de dados(?: sensiveis)?|information disclosure|divulgacao indevida de dados|cross[ -]?(?:account|tenant) data (?:exposure|leak)|(?:secret|credential|token|pii) leak(?:age)?|leak(?:age)? of (?:secrets?|credentials?|tokens?|pii)|vazamento de (?:segredos?|credenciais?|tokens?|pii))\b/i,
    reason: 'saídas, logs, caches, exports e ferramentas externas precisam preservar finalidade, propriedade e isolamento dos dados'
  },
  {
    surface: 'ai_agents',
    minimumRisk: 'high',
    pattern:
      /\b(?:prompt injection|indirect prompt injection|injecao (?:indireta )?de prompt|rag poisoning|retrieval poisoning|tool poisoning|mcp poisoning|vector (?:store|database) poisoning|envenenamento (?:de|do) (?:rag|retrieval|mcp|ferramenta)|excessive agency|agencia excessiva|over[ -]?privileged (?:agent|tool|mcp)|unrestricted (?:agent|tool|mcp) access|acesso irrestrito (?:do|ao) (?:agente|llm|modelo|mcp|ferramenta)|permissoes? excessivas? (?:do|de) (?:agente|llm|modelo|mcp|ferramenta)|(?:agent|llm|model|tool|mcp).{0,48}(?:without human approval|sem aprovacao humana|bypass(?:es|ing)? approval|acesso irrestrito|permissao excessiva))\b/i,
    reason: 'conteúdo não confiável e autonomia excessiva podem induzir ferramentas a atravessar escopo, dados ou aprovação humana'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern:
      /\b(?:unsafe deseriali[sz]ation|insecure deseriali[sz]ation|deserializacao insegura|untrusted deseriali[sz]ation|deseriali[sz](?:e|ing) untrusted input|objectinputstream|binaryformatter|pickle\.loads|yaml\.unsafe_load)\b|\bunserialize\s*\(/i,
    reason: 'desserialização de conteúdo não confiável pode instanciar objetos ou executar comportamento fora do formato esperado'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern:
      /\b(?:open redirects?|unvalidated redirects?|redirect aberto|redirecionamento aberto|redirect nao validado|redirecionamento nao validado|user[ -]?controlled redirect|redirect controlado pelo usuario)\b/i,
    reason: 'destinos de redirecionamento controláveis precisam de origem confiável ou allowlist estrita'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern:
      /\b(xss|cross[ -]?site scripting|html injection|dangerouslysetinnerhtml|innerhtml|outerhtml|srcdoc|insertadjacenthtml|document\.write)\b/i,
    reason: 'injeção de conteúdo no navegador pode executar código no contexto da pessoa usuária'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern: /\b(csrf|xsrf|cross[ -]?site request forgery|anti[ -]?(?:csrf|xsrf))\b/i,
    reason: 'requisições forjadas podem executar ações autenticadas sem consentimento'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern: /\b(ssrf|server[ -]?side request forgery)\b/i,
    reason: 'requisições server-side controláveis podem alcançar redes e metadados internos'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern:
      /\b(sql injection|sqli|query injection|injecao (?:de|em) sql|sql concatenad[oa]|consulta sql concatenada|raw sql|raw query|queryraw|sequelize\.query|knex\.raw)\b/i,
    reason: 'injeção em consultas pode expor ou alterar dados fora do escopo autorizado'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern:
      /\b(?:command injection|shell injection|injecao (?:de|em) comandos?|child[_ -]?process|exec command|command exec|cmd\.exe|powershell(?:\.exe)?|processbuilder)\b|\b(?:runtime\.)?exec(?:file|sync)?\s*\(|\bspawn(?:sync)?\s*\(|\bpopen\s*\(|\bshell\s*[:=]\s*true\b|\bos\.system\s*\(|\bsubprocess\.(?:run|popen|call)\s*\(/i,
    reason: 'execução de comandos precisa impedir que entrada não confiável controle o processo ou o shell'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern:
      /\b(path traversal|directory traversal|travessia de diretorios?|zip slip|caminho (?:fornecido|controlado) (?:pelo usuario|externamente)|user[ -]?controlled path)\b|\b(?:path|caminho|arquivo|diretorio|download|extracao).{0,40}\.\.[\/\\]|\.\.[\/\\].{0,40}\b(?:path|caminho|arquivo|diretorio|download|extracao)\b/i,
    reason: 'caminhos controláveis precisam permanecer dentro das raízes autorizadas do filesystem'
  },
  {
    surface: 'security_configuration',
    minimumRisk: 'high',
    pattern:
      /\b(ipcmain|ipcrenderer|contextbridge|nodeintegration|contextisolation|webpreferences|webcontents|setwindowopenhandler|will-navigate|webviewtag)\b|\bipc.{0,30}\bpreload\b|\bpreload.{0,30}\bipc\b|\b(?:electron|browserwindow).{0,40}\b(?:ipc|preload|sandbox|node integration|context isolation)\b|\b(?:ipc|preload|sandbox).{0,24}\b(?:electron|browserwindow)\b/i,
    reason: 'fronteiras Electron entre renderer, preload e main exigem IPC autenticado, isolamento e sandbox corretos'
  },
  {
    surface: 'authentication',
    pattern:
      /\b(auth(?:entication)?|autentic(?:acao|ar)|login|logon|senha|password|oauth2?|openid|sso|sessao|jwt|token de acesso)\b/i
  },
  {
    surface: 'authorization',
    pattern:
      /\b(autoriz(?:acao|ar)|permissoes?|permissions?|rbac|acl|controle de acesso|papeis? de usuario|user roles?|role[ -]?based access|verificacao de propriedade (?:do|de) (?:objeto|recurso|registro))\b/i
  },
  {
    surface: 'tenant_boundary',
    pattern:
      /\b(tenant|multi[ -]?tenant|workspace[_ -]?id|organization[_ -]?id|org[_ -]?id|isolamento (?:de|entre) clientes?|dados? (?:de|por) cliente|cross[ -]?tenant|row level security|rls)\b/i
  },
  {
    surface: 'payments',
    pattern: /\b(pagamentos?|checkout|stripe|pix|billing|faturamento|cobranca|assinatura financeira|reembolso)\b/i
  },
  {
    surface: 'secrets',
    pattern:
      /\b(segredos?|secrets?|credenciais?|credentials?|api[ -]?keys?|chaves? privadas?|private keys?|vault|service[_ -]?role(?: key)?|service account keys?|client secrets?|signing keys?|encryption keys?|key rotation|rotacao de chaves?)\b/i
  },
  {
    surface: 'personal_data',
    pattern: /\b(dados pessoais|dados sensiveis|pii|lgpd|gdpr|cpf|cnpj|prontuario|biometria|privacidade)\b/i
  },
  {
    surface: 'destructive_data',
    pattern: /\b(exclusao em massa|dele(?:cao|tar) dados|apagar dados|destruir dados|drop table|truncate|hard delete|purga(?:r)?|wipe)\b/i
  },
  {
    surface: 'data_migration',
    pattern: /\b(migrac(?:ao|oes)|migrar (?:dados|banco|schema)|database migration|schema migration|backfill|rollback de dados)\b/i
  },
  {
    surface: 'public_contract',
    pattern: /\b(api publica|public api|contrato publico|public contract|webhooks?|openapi|graphql schema|sdk publico|protocolo externo)\b/i
  },
  {
    surface: 'concurrency',
    pattern: /\b(concorrencia|concurrent|race condition|condicao de corrida|mutex|deadlock|semaforo|idempotencia|processamento paralelo|worker queue)\b/i
  },
  {
    surface: 'release_infrastructure',
    pattern: /\b(release critical|infraestrutura de release|deploy(?:ment)?|producao|ci[\/-]?cd|github actions|terraform|kubernetes|rollback de release)\b/i
  },
  {
    surface: 'file_upload',
    pattern:
      /\b(upload|file upload|upload de arquivos?|upload de anexos?|download assinado|signed url|object storage|bucket|armazenamento de arquivos?|envio de arquivos?|exportacao de dados|exportar dados|mime type|multipart)\b/i
  },
  {
    surface: 'admin_support',
    pattern:
      /\b(admin(?:istrador)?|painel administrativo|suporte privilegiado|impersonat(?:e|ion)|personificar usuario|trocar papel (?:do|de) usuario|user role change|refund|reembolso|desbloquear conta)\b/i
  },
  {
    surface: 'ai_agents',
    pattern:
      /\b(llm|rag|prompt injection|system prompt|agentes? de ia|ai agents?|tool[ -]?calling|chamada de ferramentas?|mcp(?: server)?|model context protocol|retrieval|memoria vetorial|vector store)\b/i
  },
  {
    surface: 'external_integration',
    pattern:
      /\b(integracao externa|external integration|callback|webhook|oauth provider|api de terceiro|third[ -]?party api|servico externo)\b/i
  },
  {
    surface: 'abuse_controls',
    pattern:
      /\b(rate[ -]?limit|limite de requisicoes|controle de abuso|anti[ -]?abuse|quota|throttl(?:e|ing)|brute[ -]?force|enumeracao de conta)\b/i
  },
  {
    surface: 'logging_errors',
    pattern:
      /\b(audit log|trilha de auditoria|log(?:ar|ando)? dados? sensiveis?|sensitive log|stack trace|fail[ -]?open|tratamento de excecao|exception handling|erro verboso)\b/i
  },
  {
    surface: 'security_configuration',
    pattern:
      /\b(seguranca|security|hardening|vulnerabilidades?|vulnerabilit(?:y|ies)|auditoria de seguranca|security review|cors|content security policy|csp|security headers?|headers? de seguranca|same[ -]?site|httponly|secure cookie|source maps?|debug em producao|bucket publico)\b/i
  },
  {
    surface: 'supply_chain',
    pattern:
      /\b(supply chain|cadeia de suprimentos|dependencia vulneravel|dependency vulnerabilit|lockfiles?|package-lock|pnpm-lock|yarn\.lock|osv[ -]?scanner|gitleaks|semgrep|codeql|github actions|ci[\/-]?cd|hooks? de agente|(?:skill|plugin) (?:extern[oa]|de terceiro|third[ -]?party))\b/i
  }
]

function normalizedRiskText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function isMissionRiskSurface(value: unknown): value is MissionRiskSurface {
  return typeof value === 'string' && MISSION_RISK_SURFACES.has(value as MissionRiskSurface)
}

const RISK_LEVEL_WEIGHT: Record<MissionRiskLevel, number> = { low: 0, medium: 1, high: 2 }

function maxRiskLevel(left: MissionRiskLevel, right: MissionRiskLevel): MissionRiskLevel {
  return RISK_LEVEL_WEIGHT[right] > RISK_LEVEL_WEIGHT[left] ? right : left
}

interface DetectedRiskSurface extends MissionRiskSurfacePolicy {
  evidence: string[]
}

const DECLARED_RISK_EVIDENCE = 'superfície declarada no plano'
const MAX_EVIDENCE_PER_SURFACE = 3

/**
 * Calcula o risco efetivo sem confiar apenas no rótulo escolhido pelo agente.
 * Cada superfície tem um piso proporcional. Sinais concretos de exploração
 * podem elevar uma superfície normalmente média para alta.
 */
export function assessMissionRisk(input: MissionRiskAssessmentInput): MissionRiskAssessment {
  const declaredRisk = normalizeRiskLevel(input.declaredRisk)
  const detected = new Map<MissionRiskSurface, DetectedRiskSurface>()

  for (const candidate of input.surfaces ?? []) {
    if (isMissionRiskSurface(candidate) && !detected.has(candidate)) {
      detected.set(candidate, {
        ...RISK_SURFACE_POLICIES[candidate],
        evidence: [DECLARED_RISK_EVIDENCE]
      })
    }
  }

  for (const candidate of input.texts ?? []) {
    const normalized = normalizedRiskText(candidate)
    if (!normalized) continue
    for (const rule of RISK_SURFACE_RULES) {
      const match = normalized.match(rule.pattern)
      if (!match) continue
      const policy = RISK_SURFACE_POLICIES[rule.surface]
      const found: DetectedRiskSurface = {
        minimumRisk: rule.minimumRisk ?? policy.minimumRisk,
        reason: rule.reason ?? policy.reason,
        evidence: [`sinal encontrado: “${match[0].trim()}”`]
      }
      const current = detected.get(rule.surface)
      if (!current || RISK_LEVEL_WEIGHT[found.minimumRisk] > RISK_LEVEL_WEIGHT[current.minimumRisk]) {
        detected.set(rule.surface, found)
      } else if (found.minimumRisk === current.minimumRisk) {
        const evidence = current.evidence.filter((item) => item !== DECLARED_RISK_EVIDENCE)
        for (const item of found.evidence) {
          if (!evidence.includes(item) && evidence.length < MAX_EVIDENCE_PER_SURFACE) {
            evidence.push(item)
          }
        }
        current.evidence = evidence.length > 0 ? evidence : current.evidence
      }
    }
  }

  const reasons = MISSION_RISK_SURFACE_VALUES.flatMap((surface): MissionRiskReason[] => {
    const finding = detected.get(surface)
    return finding
      ? [
          {
            surface,
            minimumRisk: finding.minimumRisk,
            reason: finding.reason,
            evidence: finding.evidence.join(' · ')
          }
        ]
      : []
  })
  const effectiveRisk = reasons.reduce(
    (risk, reason) => maxRiskLevel(risk, reason.minimumRisk),
    declaredRisk
  )

  return {
    declaredRisk,
    effectiveRisk,
    raised: RISK_LEVEL_WEIGHT[effectiveRisk] > RISK_LEVEL_WEIGHT[declaredRisk],
    surfaces: reasons.map((reason) => reason.surface),
    reasons
  }
}

/**
 * Valida a topologia planejada antes de cards reais ganharem UUIDs. A ordem da
 * lista define a ordem das ondas; uma onda não pode reaparecer depois de fechada.
 */
export function validatePlanDependencies(input: PlanDependencyInput): string[] {
  const problems: string[] = []
  if (!Number.isSafeInteger(input.expectedCards) || input.expectedCards < 1) {
    problems.push('a quantidade prevista de cards precisa ser um inteiro positivo')
  }
  if (input.items.length !== input.expectedCards) {
    problems.push(
      `o grafo descreve ${input.items.length} card(s), mas o plano declarou ${input.expectedCards}`
    )
  }
  if (input.items.length === 0) problems.push('o grafo do plano precisa conter ao menos um card')

  const byId = new Map<string, PlanDependencyItem>()
  const waveOrder = new Map<string, number>()
  const closedWaves = new Set<string>()
  let activeWave: string | undefined

  for (const [index, item] of input.items.entries()) {
    const id = item.id.trim()
    const waveId = item.waveId.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) {
      problems.push(`card ${index + 1}: id estável inválido`)
    } else if (byId.has(id)) {
      problems.push(`o grafo contém o id duplicado “${id}”`)
    } else {
      byId.set(id, item)
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(waveId)) {
      problems.push(`card ${id || index + 1}: onda inválida`)
      continue
    }
    if (!waveOrder.has(waveId)) waveOrder.set(waveId, waveOrder.size)
    if (activeWave !== waveId) {
      if (activeWave) closedWaves.add(activeWave)
      if (closedWaves.has(waveId)) {
        problems.push(`a onda “${waveId}” reaparece depois de outra onda; agrupe-a em um bloco único`)
      }
      activeWave = waveId
    }
  }

  if (input.mode === 'fast') {
    if (input.items.length !== 1)
      problems.push('o modo rápido precisa descrever exatamente um card no grafo')
    if (waveOrder.size > 1) problems.push('o modo rápido não aceita múltiplas ondas')
    if (input.items.some((item) => item.dependsOn.length > 0))
      problems.push('o modo rápido não aceita dependências entre cards')
  }

  for (const item of input.items) {
    const id = item.id.trim()
    const ownWaveOrder = waveOrder.get(item.waveId.trim())
    const seenDependencies = new Set<string>()
    for (const rawDependency of item.dependsOn) {
      const dependency = rawDependency.trim()
      if (seenDependencies.has(dependency)) {
        problems.push(`o card ${id} repete a dependência ${dependency}`)
        continue
      }
      seenDependencies.add(dependency)
      if (dependency === id) {
        problems.push(`o card ${id} não pode depender de si mesmo`)
        continue
      }
      const dependencyItem = byId.get(dependency)
      if (!dependencyItem) {
        problems.push(`o card ${id} depende de ${dependency}, que não existe no grafo`)
        continue
      }
      const dependencyWaveOrder = waveOrder.get(dependencyItem.waveId.trim())
      if (
        ownWaveOrder !== undefined &&
        dependencyWaveOrder !== undefined &&
        dependencyWaveOrder >= ownWaveOrder
      ) {
        problems.push(
          `o card ${id} só pode depender de ondas anteriores; ${dependency} está na mesma onda ou numa onda futura`
        )
      }
    }
    if (
      ownWaveOrder !== undefined &&
      ownWaveOrder > 0 &&
      !item.dependsOn.some((dependency) => {
        const dependencyItem = byId.get(dependency.trim())
        const dependencyWaveOrder = dependencyItem
          ? waveOrder.get(dependencyItem.waveId.trim())
          : undefined
        return dependencyWaveOrder !== undefined && dependencyWaveOrder < ownWaveOrder
      })
    ) {
      problems.push(
        `o card ${id} está numa onda posterior sem depender de uma entrega anterior; mantenha-o na primeira onda ou declare a dependência real`
      )
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const reportedCycles = new Set<string>()
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      const start = path.indexOf(id)
      const cycle = [...path.slice(Math.max(0, start)), id].join(' → ')
      if (!reportedCycles.has(cycle)) {
        reportedCycles.add(cycle)
        problems.push(`o grafo contém um ciclo de dependências: ${cycle}`)
      }
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    const item = byId.get(id)
    for (const dependency of item?.dependsOn ?? []) {
      const dependencyId = dependency.trim()
      if (byId.has(dependencyId)) visit(dependencyId, [...path, id])
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) visit(id, [])

  return problems
}

/**
 * Card operacional criado pelo PRÓPRIO HARNESS (sync da fila de integração —
 * briefing carrega o marcador [fila:<ticket>:<head>] que a dedupe da fila já
 * usa como identidade). Cards assim NUNCA contam no contrato de
 * proporcionalidade: a guarda existe contra expansão silenciosa do
 * ORQUESTRADOR, e contar trabalho que o app mesmo criou virava deadlock
 * (caso real 2026-08-10: plano de 3 cards + sync da fila = conclude_plan
 * recusado sem rota de saída).
 */
export function isHarnessQueueCard(
  card: {
    kind?: string
    briefing?: string
    auto?: boolean
    planItemId?: string
    queueSync?: boolean
  },
  opts?: { planHasWorkItems?: boolean }
): boolean {
  if (card.kind === 'plan') return false
  // Campo persistente (2026-08-10): a identidade que sobrevive a reescrita
  // de briefing — caso real: o orquestrador reescreveu o briefing do card de
  // sync e o marcador [fila:...] morreu, ressuscitando o deadlock.
  if (card.queueSync === true) return true
  if (/\[fila:[0-9a-f-]{8,}:/i.test(card.briefing ?? '')) return true
  // Reparo estrutural para cards legados sem campo E sem marcador: em plano
  // COM grafo aprovado, card do orquestrador SEMPRE nasce com planItemId
  // (create_tasks recusa sem) — card auto SEM vínculo só o harness cria.
  return Boolean(opts?.planHasWorkItems && card.auto === true && !card.planItemId)
}

/**
 * Gate puro de encerramento. Planos legados STANDARD/DEEP continuam aceitando
 * um orçamento máximo, mas FAST nunca pode virar "concluído" sem seu único card.
 */
export function validatePlanCompletion(input: PlanCompletionInput): string[] {
  const problems: string[] = []
  const open = input.cards.filter((card) => card.status !== 'done')
  if (open.length > 0) problems.push(`ainda há ${open.length} card(s) não concluído(s)`)

  if (input.mode !== 'fast') return problems
  if (input.expectedCards !== 1) {
    problems.push('o modo rápido precisa manter o contrato de exatamente um card previsto')
  }
  const delivered = input.cards.filter((card) => card.status === 'done').length
  if (input.cards.length !== 1 || delivered !== 1) {
    problems.push(
      `o modo rápido só pode terminar depois de entregar exatamente um card; registrados: ${input.cards.length}, entregues: ${delivered}`
    )
  }
  return problems
}

export function planCardLimit(mode: MissionExecutionMode): number {
  if (mode === 'fast') return 1
  if (mode === 'standard') return 4
  return 12
}

export function validatePlanSizing(input: PlanSizingInput): string[] {
  const problems: string[] = []
  if (!Number.isSafeInteger(input.expectedCards) || input.expectedCards < 1) {
    problems.push('a quantidade prevista de cards precisa ser um inteiro positivo')
    return problems
  }
  const limit = planCardLimit(input.mode)
  if (input.expectedCards > limit) {
    problems.push(
      `o modo ${EXECUTION_MODE_LABEL[input.mode]} aceita no máximo ${limit} card(s), não ${input.expectedCards}`
    )
  }
  if (input.mode === 'fast' && input.expectedCards !== 1)
    problems.push('o modo rápido precisa terminar em exatamente um card de trabalho')
  if (input.mode === 'fast' && input.laneCount !== 1)
    problems.push('o modo rápido usa exatamente uma função/lane')
  if (input.mode === 'standard' && input.laneCount > 4)
    problems.push('mais de quatro funções pertencem ao modo aprofundado')
  return problems
}

export function validateTaskSizing(
  mode: MissionExecutionMode,
  risk: MissionRiskLevel,
  expectedCards: number,
  existingCards: number,
  items: TaskSizingInput[],
  opts?: {
    /** T10 (2026-08-10): ordem VERBATIM do dono autoriza gates contra o piso
     *  de risco (o caso real: ask_user respondido "tira o QA" e o motor
     *  recusava a decisão dele). Só desliga os PISOS de gate — o resto da
     *  validação de conteúdo continua. */
    ownerGateWaiver?: boolean
  }
): string[] {
  const problems: string[] = []
  if (existingCards + items.length > expectedCards) {
    problems.push(
      `o plano prometeu ${expectedCards} card(s), mas esta criação levaria o total a ${existingCards + items.length}`
    )
  }
  const gateFloor = !opts?.ownerGateWaiver
  for (const [index, item] of items.entries()) {
    const label = `card ${index + 1}`
    if (!item.deliverable)
      problems.push(`${label}: declare se o entregável é code ou non_code`)
    if (gateFloor && item.deliverable === 'code' && item.gates?.length === 0)
      problems.push(`${label}: código nunca usa gates vazios; a validação básica é obrigatória`)
    if (
      gateFloor &&
      item.deliverable === 'non_code' &&
      risk === 'high' &&
      item.gates !== undefined &&
      !item.gates.includes('review')
    )
      problems.push(
        `${label}: entregável não executável de risco alto exige review (instruções, configuração e relatórios também podem afetar segurança)`
      )
    if (
      gateFloor &&
      item.deliverable === 'code' &&
      risk === 'high' &&
      // CARD DE QA NÃO TEM GATE DE QA (ordem do dono, 2026-08-12): o piso de
      // risco não se aplica a card cujo entregável É teste — gate de QA sobre
      // a suíte é circular; a suíte verde roda no harness.
      item.department !== 'qa' &&
      item.gates !== undefined &&
      (!item.gates.includes('review') || !item.gates.includes('qa'))
    )
      problems.push(`${label}: risco alto exige review + QA`)
    if (item.delegation === 'parallel' && (item.quests?.length ?? 0) < 2)
      problems.push(`${label}: ajudantes paralelos exigem ao menos dois blocos independentes`)
    if ((item.skills?.length ?? 0) > 1)
      problems.push(`${label}: cada card aceita no máximo uma skill técnica explícita`)
    if ((item.agents?.length ?? 0) > 1)
      problems.push(`${label}: cada card aceita no máximo um subagente especialista explícito`)
    if (
      (item.agents?.length ?? 0) > 0 &&
      normalizeDelegationMode(item.delegation, mode) !== 'parallel'
    ) {
      problems.push(`${label}: subagente especializado selecionado exige paralelismo planejado`)
    }
    if (mode !== 'fast') continue
    if (item.effort === 'pesada')
      problems.push(`${label}: trabalho pesado não cabe no modo rápido; reclassifique o plano`)
    if (item.delegation && item.delegation !== 'none')
      problems.push(`${label}: modo rápido não abre ajudantes`)
    if ((item.agents?.length ?? 0) > 0)
      problems.push(`${label}: modo rápido não carrega subagentes especializados`)
  }
  return problems
}

/**
 * Entregável não executável comum não abre agentes de validação. Em risco alto,
 * porém, instruções/configurações/relatórios passam por review: conteúdo sem
 * runtime também pode alterar permissões, supply chain ou decisões sensíveis.
 * Código mantém os dois gates por padrão; risco alto nunca pode reduzi-los.
 */
export function gatesForTask(
  mode: MissionExecutionMode,
  risk: MissionRiskLevel,
  deliverable: TaskDeliverableKind,
  gates: OrchestratorTaskGate[] | undefined,
  uiWork = false,
  department?: string
): OrchestratorTaskGate[] | undefined {
  // CARD DE QA NÃO TEM GATE DE QA (ordem do dono, 2026-08-12: "QA não tem
  // necessidade de QA, apenas de code review"): o entregável do test card É a
  // suíte — QA re-testando os testes é circular (o harness roda a suíte como
  // piso de regressão) e o que precisa de olho é a qualidade das specs contra
  // os critérios de aceite. Vale inclusive sob risco alto; escolha EXPLÍCITA
  // do orquestrador continua valendo.
  if (department === 'qa' && deliverable !== 'non_code') {
    return gates !== undefined ? [...gates] : ['review']
  }
  if (deliverable === 'non_code') return risk === 'high' ? ['review'] : []
  if (risk === 'high') return ['review', 'qa']
  // OS GATES EXPLÍCITOS SÃO O CONTRATO (ordem do dono, 2026-08-12 — "muito
  // mente fechada: pedi só reviewer e ele não consegue criar o fluxo sem
  // QA"): a re-imposição de QA em card de UI morreu — escolha explícita do
  // orquestrador vale literalmente; o DEFAULT de card de UI sem gates segue
  // review+qa. Guarda de julgamento anota (advance audita
  // ui-card-without-qa-gate), nunca re-impõe.
  if (gates !== undefined && gates.length > 0) return [...gates]
  // No modo rápido também mantemos uma revisão e um QA direcionados. O ganho
  // vem de zero ajudantes/skills amplas e escopo focado, não de retirar rede.
  return undefined
}

export function retryLimitForExecutionMode(mode: MissionExecutionMode): number {
  return mode === 'deep' ? 2 : 1
}

export function helperLimitForExecutionMode(mode: MissionExecutionMode): number {
  // Contrato F6.2 RESTAURADO (ordem do dono 2026-08-10: "por que o Synkora
  // parou de chamar ajudantes?" — um corte posterior tinha reduzido tudo
  // não-fast a UM ajudante e um dev Opus-max fazia tela inteira sozinho em
  // 40-50min): fast 0 · standard 2 · deep 4.
  if (mode === 'fast') return 0
  return mode === 'standard' ? 2 : 4
}

export function skillSelectionDirective(mode: MissionExecutionMode): string {
  if (mode === 'fast') {
    return 'Faça uma varredura rápida do menu e carregue no máximo UMA skill que reduza diretamente o risco deste ajuste. Nenhuma skill também é uma resposta válida. Não deixe uma metodologia adicionar fases, documentos, pesquisa ou ajudantes.'
  }
  if (mode === 'standard') {
    return 'Escolha no máximo UMA skill técnica com ganho concreto para este card; disponibilidade não obriga uso e nenhuma metodologia pode ampliar o escopo.'
  }
  return 'Escolha no máximo UMA skill técnica realmente útil e use-a sem criar um segundo fluxo de planejamento, revisão ou integração.'
}

export function delegationDirective(
  mode: MissionExecutionMode,
  delegation: TaskDelegationMode,
  questCount: number
): string {
  // O orquestrador é a autoridade de necessidade: cards novos chegam como
  // none ou parallel. `optional` fica apenas como semântica de compatibilidade
  // para cards persistidos antes deste contrato.
  if (mode === 'fast') {
    return 'EXECUTE DIRETAMENTE: card rápido não abre ajudantes. Checklist não significa paralelismo; conclua os itens no mesmo contexto.'
  }
  if (delegation === 'none') {
    return 'Este card foi planejado SEM ajudantes. Se durante o trabalho surgir evidência nova de 2+ blocos longos e genuinamente independentes, avise o orquestrador via notify_maestro: ELE reclassifica o card para delegation="parallel" antes de qualquer ajudante nascer. Sem essa decisão, siga direto.'
  }
  if (delegation === 'optional' || questCount < 2) {
    return 'COMPATIBILIDADE LEGADA — este card antigo ainda usa delegation="optional". A decisão operacional permanece com o DEV somente nesta rodada legada: delegue apenas trabalho longo e independente, com o MESMO modelo e MESMO effort, e assine a integração. Cards novos nunca usam optional; o orquestrador escolhe none ou parallel antes do spawn.'
  }
  return 'PARALELISMO PLANEJADO PELO ORQUESTRADOR: o card nasceu para paralelizar blocos LONGOS e independentes. O ACTIVE SKILL PLAN traz, quando houver aderência forte, exatamente UMA persona especializada roteada; abra DIRETO via delegate sem inventar outra persona e abra os demais blocos como ajudantes genéricos numa chamada helpers[] (até o teto do modo). O backend recusa done até ao menos um ajudante planejado concluir — e, se houver persona selecionada, ela também precisa concluir. Supervisione, inspecione, integre e ASSINE; nunca duplique review/QA.'
}

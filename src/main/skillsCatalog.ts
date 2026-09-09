// SKILLS 3.0 — O CATÁLOGO DA CASA (a 2ª camada da busca do agente).
//
// ADR-0009 (2026-09-08): o harness da missão é do agente, e ele o procura NESTA
// ORDEM — prateleira → biblioteca da máquina → CATÁLOGO DA CASA → web. Este
// módulo é o catálogo: as skills que a curadoria da era F6 verificou na fonte
// (SKILL.md aberto, path e frontmatter conferidos; racional em docs/SKILLS.md),
// agora dado offline. Palavra do dono na sessão: "ela vá atrás, ela busque, ela
// pegue e ela faça" — sem índice não há como ir atrás.
//
// PURO de propósito: sem electron, sem fs, sem rede. O dado entra por `import`
// do JSON (resolveJsonModule), então a tool `skill_search` e a suíte leem o
// catálogo sem subir nada. Gerar/regenerar o dado é
// `node scripts/skills-catalog-from-f6.mjs` — editar o JSON à mão é pedir
// divergência com a curadoria.
//
// A busca olha SÓ a query que o agente digitou. Heurística sobre conteúdo do
// chat é PROIBIDA na casa (ADR-0009): quem escolhe a skill é o agente, e a
// única coisa que a máquina faz é ordenar o que ele pediu.
import catalogData from './skillsCatalogData.json'

export interface SkillCatalogEntry {
  id: string
  repo: string
  /** subpasta da skill no repo ('' = a skill mora na raiz) */
  path: string
  /** branch/tag/sha da curadoria (ausente = branch padrão do repo) */
  ref?: string
  /** a OCASIÃO (agrupamento visual/semântico herdado da curadoria F6) */
  group: string
  depts: string[]
  /** PT-BR, para o dono e para o agente entenderem o que a skill ENSINA */
  summary: string
  /** EN, no formato "Use when…" — é o que decide a escolha do agente */
  hint: string
  /** ids irmãos que a skill referencia (o puller leva junto) */
  requires?: string[]
}

const ENTRIES: readonly SkillCatalogEntry[] = catalogData

// ————————————————————————————————————————————————————————————————————————
// O DADO
// ————————————————————————————————————————————————————————————————————————

export function skillsCatalog(): readonly SkillCatalogEntry[] {
  return ENTRIES
}

const BY_ID: ReadonlyMap<string, SkillCatalogEntry> = new Map(
  ENTRIES.map((entry) => [entry.id, entry])
)

export function catalogEntry(id: string): SkillCatalogEntry | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined
}

/** ocasiões únicas e ordenadas (a lateral e o recibo do skill_search agrupam por elas) */
const GROUPS: readonly string[] = [...new Set(ENTRIES.map((entry) => entry.group))].sort()

export function catalogGroups(): readonly string[] {
  return GROUPS
}

// ————————————————————————————————————————————————————————————————————————
// A BUSCA (só sobre a query do agente)
// ————————————————————————————————————————————————————————————————————————

export interface SkillCatalogHit {
  entry: SkillCatalogEntry
  score: number
  /** os campos que casaram, para o recibo dizer POR QUE aquilo apareceu */
  matched: string[]
}

const DEFAULT_LIMIT = 12
/** token de 1 char varreria o catálogo inteiro sem informar nada */
const MIN_TOKEN_LENGTH = 2

/** minúsculas e sem acento (NFD): "animação" e "animacao" têm de casar igual */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function tokenize(query: string): string[] {
  if (typeof query !== 'string' || query.length === 0) return []
  const tokens = new Set<string>()
  for (const piece of fold(query).split(/[^\p{L}\p{N}]+/u)) {
    if (piece.length >= MIN_TOKEN_LENGTH) tokens.add(piece)
  }
  return [...tokens]
}

interface IndexRow {
  entry: SkillCatalogEntry
  id: string
  group: string
  depts: readonly string[]
  hint: string
  summary: string
}

/** índice dobrado uma vez na carga do módulo (a busca roda dentro do turno do agente) */
const INDEX: readonly IndexRow[] = ENTRIES.map((entry) => ({
  entry,
  id: fold(entry.id),
  group: fold(entry.group),
  depts: entry.depts.map(fold),
  hint: fold(entry.hint),
  summary: fold(entry.summary)
}))

/** a régua do design §5.A — id igual 10 (exclui o "contém"), id contém 6, group 4, dept 3, hint 2, summary 2 */
const SCORE = { idExact: 10, idPart: 6, group: 4, dept: 3, hint: 2, summary: 2 } as const
/** ordem estável dos campos no `matched` (o recibo lê sempre na mesma sequência) */
const MATCH_ORDER = ['id', 'group', 'dept', 'hint', 'summary'] as const

function scoreRow(row: IndexRow, tokens: readonly string[]): SkillCatalogHit | undefined {
  let score = 0
  const matched = new Set<string>()
  for (const token of tokens) {
    if (row.id === token) {
      score += SCORE.idExact
      matched.add('id')
    } else if (row.id.includes(token)) {
      score += SCORE.idPart
      matched.add('id')
    }
    if (row.group.includes(token)) {
      score += SCORE.group
      matched.add('group')
    }
    if (row.depts.includes(token)) {
      score += SCORE.dept
      matched.add('dept')
    }
    if (row.hint.includes(token)) {
      score += SCORE.hint
      matched.add('hint')
    }
    if (row.summary.includes(token)) {
      score += SCORE.summary
      matched.add('summary')
    }
  }
  if (score === 0) return undefined
  return { entry: row.entry, score, matched: MATCH_ORDER.filter((field) => matched.has(field)) }
}

/**
 * Ordena o catálogo pela query do agente. Sem token casando devolve `[]` — dizer
 * "não achei" é resposta legítima (ADR-0009: "nenhuma skill" é harness válido).
 */
export function searchSkillsCatalog(query: string, limit: number = DEFAULT_LIMIT): SkillCatalogHit[] {
  const cap = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT
  if (cap <= 0) return []
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const hits: SkillCatalogHit[] = []
  for (const row of INDEX) {
    const hit = scoreRow(row, tokens)
    if (hit) hits.push(hit)
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
  })
  return hits.slice(0, cap)
}

/**
 * URL de EXIBIÇÃO no GitHub (é o que o agente cola no fio e o dono clica). Quando
 * a curadoria não gravou `ref`, ela CHUTA `main` só para mostrar — quem baixa usa
 * `repo`/`path`/`ref` do dado, nunca esta string (design §5.B).
 */
export function catalogSourceUrl(entry: SkillCatalogEntry): string {
  const base = `https://github.com/${entry.repo}`
  const path = entry.path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!path) return base
  return `${base}/tree/${entry.ref ?? 'main'}/${path}`
}

// ————————————————————————————————————————————————————————————————————————
// OS VETOS PERMANENTES (ADR-0010)
// ————————————————————————————————————————————————————————————————————————

export interface SkillVeto {
  kind: 'id' | 'repo' | 'name'
  value: string
  /** PT-BR: por que é veto E a receita — beco sem saída é bug (regra da casa) */
  reason: string
}

const ANTHROPIC_DOC_QUARTET =
  'Proprietária da Anthropic: o LICENSE proíbe extrair, copiar, derivar e redistribuir — e puxar para o workspace é exatamente retenção de cópia + distribuição. Receita: destile a rotina no `mission-playbook` da missão, ou use uma skill livre do catálogo para o formato.'

/**
 * Vetos PERMANENTES de fonte. Não são julgamento de qualidade (isso é escolha do
 * agente): protegem licença, um comando do dono e a verificabilidade do pin.
 * ESPELHO: `scripts/skills-catalog-from-f6.mjs` repete as chaves para excluir
 * estas entradas do JSON; `scripts/test-skills-catalog.mjs` prende os dois lados.
 *
 * A CLASSE "ensina o que o app já cerca" (revisão do orquestrador, 2026-09-08):
 * as seções "Ficou de FORA" de docs/SKILLS.md não nomeiam ids — o gênero foi
 * INSTALADO como `manualOnly` na era F6, quando o subagente nativo ainda
 * existia. Na era 2.0 ele está aposentado por ordem do dono (18/08, cerca
 * mecânica `CLAUDE_NATIVE_AGENT_FENCE` + `features.multi_agent=false`) e o app
 * é DONO de worktree, branch e integração (persona "THE APP OWNS THE
 * MECHANICS"). Uma skill que manda o agente abrir `Task`/subagente, criar
 * worktree à mão ou fechar branch por conta própria não é "de qualidade
 * duvidosa" — é um playbook para uma porta que o Synkora trancou, e segui-la
 * queima a rodada contra a cerca. Por isso as cinco viram veto por ID, cada
 * uma com a RECEITA da casa (delegate / o app / o revisor).
 */
const TEACHES_NATIVE_SUBAGENT =
  'Ensina a despachar o subagente NATIVO do CLI (Task/Agent/spawn_agent), aposentado nesta casa e cercado mecanicamente — seguir este playbook queima a rodada contra a cerca. Receita: a frota do Synkora abre pelo `delegate` (helpers headless que o dono vê na lateral), e o `mission-playbook` guarda o que valer da metodologia.'
const APP_OWNS_MECHANICS =
  'Manda fazer à mão o que o Synkora faz sozinho (worktree, branch, fechamento/merge): a missão JÁ nasce num worktree próprio e a integração é a fila do ⇪ do dono (`integration_status`/`integration_run`). Receita: trabalhe no worktree que já existe e deixe a mecânica com o app.'

export const SKILL_SOURCE_VETOES: readonly SkillVeto[] = [
  { kind: 'id', value: 'dispatching-parallel-agents', reason: TEACHES_NATIVE_SUBAGENT },
  { kind: 'id', value: 'subagent-driven-development', reason: TEACHES_NATIVE_SUBAGENT },
  {
    kind: 'id',
    value: 'requesting-code-review',
    reason:
      'Pede a revisão despachando um subagente revisor NATIVO (cercado nesta casa). Receita: a missão tem o REVISOR próprio (🧐 revisar, contexto limpo) e um ajudante do `delegate` pode revisar uma fatia — descreva o que revisar no prompt dele.'
  },
  { kind: 'id', value: 'using-git-worktrees', reason: APP_OWNS_MECHANICS },
  { kind: 'id', value: 'finishing-a-development-branch', reason: APP_OWNS_MECHANICS },
  { kind: 'id', value: 'docx', reason: ANTHROPIC_DOC_QUARTET },
  { kind: 'id', value: 'pdf', reason: ANTHROPIC_DOC_QUARTET },
  { kind: 'id', value: 'pptx', reason: ANTHROPIC_DOC_QUARTET },
  { kind: 'id', value: 'xlsx', reason: ANTHROPIC_DOC_QUARTET },
  {
    kind: 'repo',
    value: 'anthropics/claude-plugins-official',
    reason:
      'Plugin proprietário `claude-security`: o LICENSE da PASTA proíbe redistribuir modificado e usar "with any non-Anthropic product" — e o Synkora injeta a pasta também em panes codex. Receita: o grupo "review de segurança" do catálogo tem alternativas livres e pináveis.'
  },
  {
    kind: 'name',
    value: 'security-review',
    reason:
      'O `name` SOMBREIA o comando built-in /security-review do claude: instalar sequestra um comando do dono no chat dele. Receita: puxe a skill de review de segurança por outro id (grupo "review de segurança" do catálogo).'
  },
  {
    kind: 'id',
    value: 'web-design-guidelines',
    reason:
      'O SKILL.md é casca que baixa o ruleset remoto SEM PIN em runtime: as instruções que o agente executa podem mudar upstream a qualquer momento (supply chain), e o pin por sha desta casa não alcança. Receita: use uma direção de design pinada — `impeccable`, `design-taste-frontend`, `frontend-design`.'
  }
]

/**
 * O veto que barra esta fonte, se houver. Casa por `id`, por `repo` (sem ligar
 * para caixa) e por `name` — o `name` do frontmatter é o mesmo que o id da pasta
 * na spec, então o veto de nome é conferido contra o `id` recebido.
 */
export function skillSourceVeto(input: { id?: string; repo?: string }): SkillVeto | undefined {
  const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
  const repo = typeof input.repo === 'string' ? input.repo.trim().toLowerCase() : ''
  for (const veto of SKILL_SOURCE_VETOES) {
    const value = veto.value.toLowerCase()
    if (veto.kind === 'repo') {
      if (repo && repo === value) return veto
      continue
    }
    if (id && id === value) return veto
  }
  return undefined
}

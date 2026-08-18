import type { GuiItem } from './store'
import type { GuiToolItem } from './guiToolPresentation'

/**
 * Metadados que o protocolo pode trazer no input da ferramenta de delegação.
 * Eles são uma projeção limitada: o input cru nunca é guardado no renderer.
 */
export interface GuiSubagentMetadata {
  name?: string
  type?: string
  model?: string
  /** Effort PEDIDO ao motor. O claude nunca ecoa o aplicado (sonda
   *  probe-helper-matrix §2.3: nenhum frame publica effort), então a lateral
   *  mostra o pedido — que é o que o dono escolheu. */
  effort?: string
  /** CLI que roda o ajudante. Cross-CLI é normal (chat claude abre `gpt-*`);
   *  a ficha não muda por causa disso, só o carimbo. */
  cli?: string
  /** Conta (seat) resolvida para o ajudante. */
  seat?: string
  /** Identidade do ajudante no motor — o marcador EXPLÍCITO do card
   *  sintetizado (ver o contrato do card de ajudante abaixo). */
  helperId?: string
  prompt?: string
  description?: string
}

export type GuiSubagentSidebarTone = 'running' | 'completed' | 'failed' | 'denied' | 'cancelled'

export interface GuiSubagentSidebarEntry {
  id: string
  /** Identidade opaca do tool call; útil para distinguir concorrentes. */
  toolUseId: string
  name: string
  type: string | null
  model: string
  /** Effort e conta do ajudante. `null` no caminho NATIVO aposentado, que
   *  nunca informou nem um nem outro — é exatamente por isso que a ordem do
   *  dono manda toda delegação pelo MCP. */
  effort: string | null
  seat: string | null
  cli: string | null
  task: string
  activity: string | null
  status: GuiSubagentSidebarTone
  statusLabel: string
  outcome: string | null
  parent: GuiToolItem
  children: GuiToolItem[]
  at: number
}

const MAX_FIELD = 240

/** Nomes NATIVOS da ferramenta de delegação (claude publica `Task` e o modelo
 *  chama `Agent`; codex sintetiza `spawn_agent`). Âncora preservada: nome
 *  PARECIDO nunca vira subagente. */
const NATIVE_DELEGATION_RE = /^(task|agent|delegate|subagent|spawn(?:_?agent)?)$/iu

/** `mcp__<servidor>__<tool>`: a forma que o CLAUDE publica para toda tool MCP
 *  — a chave do servidor entra no NOME (sonda probe-claude-fence §3). */
const CLAUDE_MCP_TOOL_RE = /^mcp__[\w-]+?__(.+)$/u

/** `<servidor>/<tool>` (e as variantes `.`/`__`). O CODEX hoje entrega o nome
 *  CRU da tool — `codexSession.ts` projeta `item.tool` e guarda o servidor no
 *  input (sonda probe-codex-fence §B.2: `{server:'synkora', tool:'delegate'}`)
 *  —, mas ele qualifica por servidor nas mensagens de erro; aceitar a forma
 *  qualificada é barato e evita uma cegueira se o binário mudar de ideia. */
const SERVER_QUALIFIED_TOOL_RE = /^[\w-]+(?:__|[/.])(.+)$/u

/**
 * CARD SINTETIZADO DE AJUDANTE MCP — contrato (quem EMITE é o harness).
 *
 * A delegação por MCP abre o ajudante numa SESSÃO À PARTE: o stream do CLI só
 * mostra a chamada `delegate`, que é o ENVELOPE do lote. Para a lateral falar
 * um idioma só, o harness sintetiza um tool-item POR AJUDANTE no anel do
 * delegador — um lote de cinco nunca vira um card só:
 *
 *   name             `helper:<helperId>` — o marcador que promove o card
 *   toolUseId        id estável do ajudante; é ele que os cards de ATIVIDADE
 *                    do ajudante usam como `parentToolUseId`
 *   parentToolUseId  `toolUseId` da chamada `delegate` (o envelope do lote)
 *   input            { helperId, name?, model, effort?, seat?|seatName?, cli?,
 *                      prompt?|description? } → vira `GuiSubagentMetadata`
 *
 * O `helperId` no input é o marcador alternativo: um card com ele é promovido
 * mesmo que o nome mude. O ENVELOPE não vira ficha enquanto tiver ajudante
 * promovido pendurado (senão cinco ajudantes virariam seis fichas, com uma
 * delas sem modelo/effort/conta), mas continua visível na fresta entre a
 * chamada e o primeiro recibo — o `agentStatus: 'launched'` não é desfecho.
 */
const HELPER_CARD_NAME_RE = /^helper:/iu

/** Recibo de despacho do Agent assíncrono (contrato do tool-result: `launched`
 *  = agente vivo; `settled` = terminal factual).
 *
 *  Cópia deliberada da mesma checagem de `guiToolPresentation`: as suítes
 *  carregam estes módulos com type-stripping do node, que não resolve import de
 *  irmão sem extensão — um import de VALOR aqui derrubaria os testes. */
function isLaunchedSubagent(item: GuiToolItem): boolean {
  return item.result?.agentStatus === 'launched'
}

/** Ferramenta de uma thread filha. O reducer usa esta fronteira para guardar
 *  o evento sem assentar/dividir o stream da resposta principal. */
export function isGuiSubagentToolEvent(value: { parentToolUseId?: unknown }): boolean {
  return typeof value.parentToolUseId === 'string' && value.parentToolUseId.length > 0
}

/**
 * Nome de ferramenta de DELEGAÇÃO, nas três formas que chegam ao renderer: a
 * nativa (`Task`/`Agent`/`spawn_agent`), a do MCP no claude
 * (`mcp__synkora__delegate`) e a do MCP no codex (nome cru, `delegate`). O
 * teste do sufixo reusa a MESMA âncora nativa, então uma tool irmã do catálogo
 * de delegação (`helpers_status`, `helper_result`, `list_seats`) continua
 * sendo uma tool comum.
 */
export function isGuiDelegationToolName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (NATIVE_DELEGATION_RE.test(trimmed)) return true
  for (const pattern of [CLAUDE_MCP_TOOL_RE, SERVER_QUALIFIED_TOOL_RE]) {
    const tail = pattern.exec(trimmed)?.[1]
    if (tail && NATIVE_DELEGATION_RE.test(tail)) return true
  }
  return false
}

/** Card sintetizado de ajudante MCP pelo NOME (contrato acima). */
export function isGuiHelperCardName(name: string): boolean {
  return HELPER_CARD_NAME_RE.test(name.trim())
}

/** Card que tem ficha PRÓPRIA na lateral por ser um ajudante do lote, e não
 *  mera atividade do envelope. Exige a projeção já normalizada: item sem
 *  metadata é replay antigo e continua seguindo a linhagem do pai. */
function isPromotedHelperCard(item: GuiToolItem): boolean {
  if (!item.toolUseId || !item.subagent) return false
  return Boolean(item.subagent.helperId) || isGuiHelperCardName(item.name)
}

function clean(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/gu, ' ').trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = clean(input[key])
    if (value) return value
  }
  return undefined
}

/**
 * Extrai somente chaves conhecidas do input real de Task/Agent e do card
 * sintetizado de ajudante MCP. Não transforma o modelo do pai em modelo do
 * filho: se o protocolo não informar `model`, a UI mostra explicitamente
 * "modelo não informado" — hoje uma exclusividade do nativo aposentado, que
 * nunca disse modelo, effort nem conta.
 */
export function guiSubagentMetadataForTool(
  toolName: string,
  input: Record<string, unknown> | undefined
): GuiSubagentMetadata | undefined {
  if (!input) return undefined
  const name = stringField(input, 'name', 'agent_name', 'agentName')
  const type = stringField(input, 'subagent_type', 'subagentType', 'agent_type', 'agentType')
  const model = stringField(input, 'model')
  // `reasoningEffort` é como o wire do codex nomeia o mesmo campo no
  // `collabAgentToolCall` (sonda probe-codex-fence §C).
  const effort = stringField(input, 'effort', 'reasoning_effort', 'reasoningEffort')
  const cli = stringField(input, 'cli')
  const seat = stringField(input, 'seat', 'seatName', 'seat_name')
  const helperId = stringField(input, 'helperId', 'helper_id')
  const prompt = stringField(input, 'prompt')
  const description = stringField(input, 'description')

  // A relação parentToolUseId continua sendo a autoridade. Este teste só
  // permite mostrar a ficha enquanto o primeiro filho ainda não chegou.
  // `helperId` entra como marcador porque é vocabulário NOSSO: ao contrário de
  // `description`/`model`, nenhuma ferramenta comum carrega essa chave.
  const looksLikeDelegation =
    isGuiDelegationToolName(toolName) ||
    isGuiHelperCardName(toolName) ||
    Boolean(helperId) ||
    Boolean(type)
  if (!looksLikeDelegation) return undefined
  return {
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(cli ? { cli } : {}),
    ...(seat ? { seat } : {}),
    ...(helperId ? { helperId } : {}),
    ...(prompt ? { prompt } : {}),
    ...(description ? { description } : {})
  }
}

function isPotentialParent(item: GuiToolItem): boolean {
  return Boolean(item.toolUseId && (item.subagent || isGuiDelegationToolName(item.name)))
}

/**
 * Desfecho FACTUAL do pai. No Claude o primeiro resultado do Agent pode ser só
 * o recibo de despacho ('launched'): o agente segue trabalhando em background e
 * o terminal de verdade chega depois ('settled'). Sem `agentStatus` — Codex e
 * ferramenta comum — resultado É o terminal, como sempre foi.
 */
function terminalTone(item: GuiToolItem): Exclude<GuiSubagentSidebarTone, 'running'> | null {
  const result = item.result
  if (!result) return null
  if (isLaunchedSubagent(item)) return null
  if (result.status === 'denied') return 'denied'
  if (result.status === 'cancelled') return 'cancelled'
  if (result.status === 'failed' || result.isError) return 'failed'
  return 'completed'
}

function statusLabel(status: GuiSubagentSidebarTone): string {
  switch (status) {
    case 'completed':
      return 'concluído'
    case 'failed':
      return 'falhou'
    case 'denied':
      return 'negado'
    case 'cancelled':
      return 'cancelado'
    default:
      return 'trabalhando'
  }
}

function activityFor(children: readonly GuiToolItem[], parent: GuiToolItem): string | null {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]
    if (child.result) continue
    const summary = clean(child.summary)
    return summary ? `${child.name} · ${summary}` : child.name
  }
  // Recibo de despacho não é desfecho: entre o lançamento e a primeira
  // ferramenta do filho o agente já está trabalhando.
  if (!parent.result || isLaunchedSubagent(parent))
    return children.length > 0 ? 'finalizando' : 'aguardando a primeira atividade'
  return null
}

function taskFor(parent: GuiToolItem): string {
  const metadata = parent.subagent
  return (
    metadata?.prompt ??
    metadata?.description ??
    clean(parent.summary) ??
    'tarefa não informada'
  )
}

function childrenFor(
  parent: GuiToolItem,
  tools: readonly GuiToolItem[]
): GuiToolItem[] {
  const rootId = parent.toolUseId
  if (!rootId) return []
  const byParent = new Map<string, GuiToolItem[]>()
  for (const item of tools) {
    if (!item.parentToolUseId) continue
    // Ajudante promovido tem ficha própria: nem ele nem a árvore dele contam
    // como atividade do envelope. É estrutural, não coincidência — sem isso o
    // trabalho de um ajudante apareceria como "agora" de outra ficha.
    if (isPromotedHelperCard(item)) continue
    const list = byParent.get(item.parentToolUseId) ?? []
    list.push(item)
    byParent.set(item.parentToolUseId, list)
  }
  const result: GuiToolItem[] = []
  const queue = [...(byParent.get(rootId) ?? [])]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const item = queue.shift() as GuiToolItem
    if (item.id === parent.id || seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
    if (item.toolUseId) queue.push(...(byParent.get(item.toolUseId) ?? []))
  }
  return result.sort((a, b) => a.at - b.at)
}

/**
 * Normaliza eventos crus em fichas independentes. A ordem é a ordem factual
 * do tool call, portanto dois subagentes concorrentes não se sobrescrevem.
 */
export function normalizeGuiSubagentSidebar(
  items: readonly GuiItem[]
): GuiSubagentSidebarEntry[] {
  const tools = items.filter((item): item is GuiToolItem => item.kind === 'tool')
  const childParentIds = new Set(
    tools.map((item) => item.parentToolUseId).filter((value): value is string => Boolean(value))
  )
  // Envelopes de LOTE: a chamada `delegate` que já abriu ajudantes promovidos.
  // Quem representa o trabalho são os ajudantes — o envelope só ocuparia uma
  // linha a mais, sem modelo, sem effort e sem conta.
  const batchEnvelopeIds = new Set(
    tools
      .filter((item) => isPromotedHelperCard(item))
      .map((item) => item.parentToolUseId)
      .filter((value): value is string => Boolean(value))
  )
  const parents = tools.filter(
    (item) =>
      Boolean(item.toolUseId) &&
      (isPromotedHelperCard(item) || !batchEnvelopeIds.has(item.toolUseId as string)) &&
      (childParentIds.has(item.toolUseId ?? '') || isPotentialParent(item))
  )
  const seenParentIds = new Set<string>()

  return parents.filter((parent) => {
    const toolUseId = parent.toolUseId as string
    if (seenParentIds.has(toolUseId) || terminalTone(parent) !== null) return false
    seenParentIds.add(toolUseId)
    return true
  }).map((parent) => {
    const children = childrenFor(parent, tools)
    const status: GuiSubagentSidebarTone = 'running'
    const metadata = parent.subagent
    const type = metadata?.type ?? null
    const name = metadata?.name ?? type ?? 'subagente'
    return {
      id: `subagent-sidebar:${parent.toolUseId}`,
      toolUseId: parent.toolUseId as string,
      name,
      type,
      model: metadata?.model ?? 'modelo não informado',
      effort: metadata?.effort ?? null,
      seat: metadata?.seat ?? null,
      cli: metadata?.cli ?? null,
      task: taskFor(parent),
      activity: activityFor(children, parent),
      status,
      statusLabel: statusLabel(status),
      outcome: null,
      parent,
      children,
      at: parent.at
    }
  })
}

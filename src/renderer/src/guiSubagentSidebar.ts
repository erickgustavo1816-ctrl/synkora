import type { GuiItem } from './store'
import type { GuiToolItem } from './guiToolPresentation'
/** O ✕ da frota (R27F3) lê o desfecho do descarte pela declaração do MOTOR —
 *  o preload reexporta o tipo justamente para não existir uma segunda verdade
 *  sobre a mesma resposta. Import de TIPO: nada de Electron atravessa daqui. */
import type { GuiHelperOwnerDismissResult } from '../../preload/index'

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
  /** R12 — o ajudante abriu em modo fast (mais rápido, gasta mais limite). É a
   *  única escolha da ficha que CUSTA mais; ausente é desligado. */
  fast?: boolean
  /** CLI que roda o ajudante. Cross-CLI é normal (chat claude abre `gpt-*`);
   *  a ficha não muda por causa disso, só o carimbo. */
  cli?: string
  /** Conta (seat) resolvida para o ajudante. */
  seat?: string
  /** Identidade do ajudante no MOTOR — a chave que `helper_resume`,
   *  `helper_result` e a caixa-preta usam para falar deste ajudante. É só
   *  dado: quem promove o card é o NOME (ver o contrato abaixo, e R7 §B1). */
  helperId?: string
  prompt?: string
  description?: string
}

/**
 * Tom da ficha. `interrupted` é o único terminal que NÃO encerra a ficha (ver
 * `guiSubagentSidebarEntries`): parar preservando é pausa, e o dono precisa
 * enxergar qual frota ele ainda pode retomar.
 */
export type GuiSubagentSidebarTone =
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'unconfirmed'

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
  /** R12 — ⚡ na ficha. Sem terceiro estado: ausente é desligado, e é por isso
   *  que ele não segue o `null` dos vizinhos. */
  fast?: boolean
  seat: string | null
  cli: string | null
  /** Identidade do ajudante no MOTOR (`null` no caminho NATIVO aposentado, que
   *  nunca teve ajudante nenhum lá). É por ela que o ✕ da ficha fala com o
   *  descarte — e é a ausência dela que impede um botão morto de nascer. */
  helperId: string | null
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
 * QUEM PROMOVE É O NOME, NUNCA O INPUT (design R7 §B1). O `helperId` já foi
 * marcador alternativo, e isso era um bug de fábrica: TODA tool do catálogo de
 * delegação (`helper_result`, `helper_send`, `helper_resume`, `helper_cancel`)
 * carrega `helperId` no input, então o long-poll do delegador nascia ficha
 * fantasma na lateral — "subagente · modelo não informado", 2º print da
 * validação ao vivo do dono. As irmãs do catálogo são o que sempre foram:
 * cards comuns de tool no fio.
 *
 * O ENVELOPE não vira ficha enquanto tiver ajudante promovido pendurado (senão
 * cinco ajudantes virariam seis fichas, com uma delas sem modelo/effort/conta),
 * mas continua visível na fresta entre a chamada e o primeiro recibo — o
 * `agentStatus: 'launched'` não é desfecho.
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

/**
 * PARADA PRESERVADORA — o contrato entre as ondas da rodada 6 (design R6.1):
 * o ■ do dono e o fechamento do app INTERROMPEM a frota em vez de descartá-la,
 * e o card sintetizado do ajudante chega com este status. É o irmão novo do
 * 'cancelled', que continua significando DESCARTE (o dono não quer mais).
 *
 * A palavra vem do harness e atravessa o store sem validação (o redutor copia
 * `evt.outcome` para `result.status`), então a leitura é feita pelo TEXTO: o
 * vocabulário tipado `GuiToolOutcome` ainda não a conhece, e alargá-lo mexeria
 * em módulos de outra frente. Ler por texto é honesto e não mente sobre o tipo.
 */
export const GUI_SUBAGENT_INTERRUPTED_STATUS = 'interrupted'

function isInterruptedResult(result: { status?: string }): boolean {
  return result.status === GUI_SUBAGENT_INTERRUPTED_STATUS
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
 *  metadata é replay antigo e continua seguindo a linhagem do pai. O teste é o
 *  NOME sintetizado pelo harness (`helper:<id>`, e `helper:<id>#vida<n>` na
 *  retomada) — a chave `helperId` do input não promove nada desde a R7 §B1. */
function isPromotedHelperCard(item: GuiToolItem): boolean {
  if (!item.toolUseId || !item.subagent) return false
  return isGuiHelperCardName(item.name)
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
  // `true` LITERAL: o card do harness manda boolean, e um `"false"` de qualquer
  // outra fonte não pode virar ⚡ na ficha.
  const fast = input['fast'] === true
  const cli = stringField(input, 'cli')
  const seat = stringField(input, 'seat', 'seatName', 'seat_name')
  const helperId = stringField(input, 'helperId', 'helper_id')
  const prompt = stringField(input, 'prompt')
  const description = stringField(input, 'description')

  // A relação parentToolUseId continua sendo a autoridade. Este teste só
  // permite mostrar a ficha enquanto o primeiro filho ainda não chegou.
  //
  // Três portas, TODAS de NOME (design R7 §B1): o envelope (`delegate`), o card
  // sintetizado do ajudante (`helper:*`) e o subagente nativo, que se declara
  // pelo `type`. `helperId` no input não é porta nenhuma — ele viaja em toda
  // irmã do catálogo (`helper_result` e companhia), e era por ele que o
  // long-poll do delegador virava ficha fantasma na lateral.
  const looksLikeDelegation =
    isGuiDelegationToolName(toolName) || isGuiHelperCardName(toolName) || Boolean(type)
  if (!looksLikeDelegation) return undefined
  return {
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fast ? { fast: true } : {}),
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
 *
 * `interrupted` vem PRIMEIRO porque é o único terminal que a lateral guarda: a
 * ordem dos testes seguintes é a de desfechos que encerram a ficha.
 */
function terminalTone(item: GuiToolItem): Exclude<GuiSubagentSidebarTone, 'running'> | null {
  const result = item.result
  if (!result) return null
  if (isLaunchedSubagent(item)) return null
  if (isInterruptedResult(result)) return 'interrupted'
  if (result.status === 'denied') return 'denied'
  if (result.status === 'cancelled') return 'cancelled'
  if (result.status === 'failed' || result.isError) return 'failed'
  if (result.status === 'unconfirmed') return 'unconfirmed'
  return 'completed'
}

/**
 * CRONÔMETRO DA FICHA (ordem do dono, 18/08: "há quanto tempo ele tá
 * trabalhando"). Abaixo de uma hora conta em `m:ss`; a partir dela, `h:mm:ss`.
 *
 * O idioma é o MESMO do cronômetro do turno (`formatGuiElapsed`, na barra de
 * atividade) — duas telas do app contando o tempo de jeitos diferentes é o tipo
 * de desarmonia que o dono lê como bug. A régua está DUPLICADA de propósito, e
 * não importada: as suítes carregam este módulo com type-stripping do node, que
 * não resolve import de irmão sem extensão — o mesmo motivo já anotado em
 * `isLaunchedSubagent`. Mudou lá, muda aqui junto (a suíte cobra as duas).
 *
 * Relógio torto nunca vira TEXTO torto: carimbo no futuro, virada de fuso ou
 * valor não-finito aterrissam em `0:00`, nunca em "-1:59" ou "NaN:NaN".
 */
export function formatGuiSubagentElapsed(elapsedMs: number): string {
  const safe = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const totalSeconds = Math.floor(safe / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * O CRONÔMETRO CONGELADO (design R6.1: "o card dele PERMANECE na lateral como
 * interrompido, cronômetro congelado").
 *
 * Ficha viva conta contra o tique compartilhado e DEIXA GRAVADA a última
 * leitura. Ficha parada não calcula nada: ela devolve essa leitura gravada, e é
 * por isso que o relógio nunca mais anda — não existe caminho em que o estado
 * parado consulte o relógio. Uma ficha que continuasse contando diria ao dono
 * "trabalhando há 40 minutos" de um processo que morreu no minuto 4.
 *
 * `null` = NÃO HÁ tempo a mostrar, e é o caso do card que volta do anel já
 * interrompido (o boot que remonta a conversa): o carimbo `at` daquele card é a
 * hora do REPLAY, não a do trabalho, então qualquer número ali seria invenção.
 * A ficha então mostra estado e identidade, sem relógio — que é a verdade.
 *
 * A memória é do componente (um Map por montagem da lateral): ela morre com o
 * pane e é limitada aos ajudantes do anel, que já tem teto próprio de itens.
 */
export function guiSubagentElapsedMs(
  entry: { toolUseId: string; status: GuiSubagentSidebarTone; at: number },
  now: number,
  memory: Map<string, number>
): number | null {
  if (entry.status !== 'running') return memory.get(entry.toolUseId) ?? null
  const elapsed = Math.max(0, now - entry.at)
  memory.set(entry.toolUseId, elapsed)
  return elapsed
}

/**
 * O NOME DIGNO DO MODELO (design R7 §B2: "a ficha da lateral também ganha o
 * nome bonito do modelo quando houver").
 *
 * `opus[1m]` é vocabulário de MOTOR — a ficha é leitura de relance do dono, e
 * o app inteiro já escreve `OPUS 1M` no chrome do pane e no seletor do
 * composer. Duas telas nomeando o mesmo modelo de jeitos diferentes é a
 * desarmonia que o dono lê como bug.
 *
 * GÊMEO DECLARADO de `prettyModel` (`components/PaneChrome.tsx`), duplicado de
 * propósito e não importado: as suítes carregam este módulo com type-stripping
 * do node, que não resolve import de irmão sem extensão — e o gêmeo mora num
 * componente React, que não roda em node puro. Mudou lá, muda aqui junto: a
 * suíte EXECUTA a função do outro arquivo e cobra as duas.
 *
 * A ÚNICA divergência é deliberada: fora das famílias conhecidas o gêmeo
 * caixa-alta o identificador, e aqui ele volta INTACTO. Enfeitar um id que não
 * se reconhece é inventar identidade de motor — e o dono lê a ficha para saber
 * exatamente o que abriu.
 */
export function guiSubagentModelName(model: string): string {
  const id = model.trim()
  if (!id) return id
  const oneM = /\[1m\]/iu.test(id) || /-1m$/iu.test(id)
  const stem = id
    .replace(/\[1m\]/iu, '')
    .replace(/^claude-/iu, '')
    .replace(/-\d{8}$/u, '') // sufixo de data dos ids completos
  const claude = stem.match(/^(opus|sonnet|haiku|fable|mythos)[-.]?(\d+(?:[-.]\d+)*)?/iu)
  if (claude) {
    const family = claude[1].toUpperCase()
    const version = claude[2] ? claude[2].replace(/-/gu, '.') : ''
    return `${family}${version ? ` ${version}` : ''}${oneM ? ' 1M' : ''}`
  }
  const gpt = stem.match(/^gpt-?(\d+(?:\.\d+)*)?-?(.*)$/iu)
  if (gpt) {
    const version = gpt[1] ? `-${gpt[1]}` : ''
    const rest = gpt[2] ? ` ${gpt[2].replace(/-/gu, ' ').toUpperCase()}` : ''
    return `GPT${version}${rest}`.trim()
  }
  return id
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
    case 'unconfirmed':
      return 'não confirmado'
    // Palavra PRÓPRIA, nunca um parente de "cancelado": é ela que diz ao dono
    // qual frota ainda dá para retomar (helper_resume) e qual foi descartada.
    case 'interrupted':
      return 'interrompido'
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
 * Normaliza eventos crus nas fichas da LATERAL. A ordem é a ordem factual do
 * tool call, portanto dois subagentes concorrentes não se sobrescrevem — e uma
 * ficha nunca pula de lugar por mudar de estado (a régua da casa: o que o dono
 * já leu numa posição continua nela).
 *
 * Quem sai da lista é o desfecho que ENCERRA o trabalho (concluído, falhou,
 * negado, cancelado). Quem fica é quem trabalha e quem foi INTERROMPIDO: parar
 * preservando é pausa, e a ficha parada é o único lugar onde o dono vê o que
 * ainda dá para retomar.
 */
export function guiSubagentSidebarEntries(
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
    const tone = terminalTone(parent)
    if (seenParentIds.has(toolUseId) || (tone !== null && tone !== 'interrupted')) return false
    seenParentIds.add(toolUseId)
    return true
  }).map((parent) => {
    const children = childrenFor(parent, tools)
    const status: GuiSubagentSidebarTone = terminalTone(parent) ?? 'running'
    const metadata = parent.subagent
    const type = metadata?.type ?? null
    const name = metadata?.name ?? type ?? 'subagente'
    return {
      id: `subagent-sidebar:${parent.toolUseId}`,
      toolUseId: parent.toolUseId as string,
      name,
      type,
      // O motor fala em id (`opus[1m]`); a ficha fala a língua do app
      // (`OPUS 1M`). Quando a família não é conhecida o id volta INTACTO — a
      // reserva honesta de `guiSubagentModelName`.
      model: (metadata?.model ? guiSubagentModelName(metadata.model) : '') || 'modelo não informado',
      effort: metadata?.effort ?? null,
      ...(metadata?.fast ? { fast: true } : {}),
      seat: metadata?.seat ?? null,
      cli: metadata?.cli ?? null,
      helperId: metadata?.helperId ?? null,
      task: taskFor(parent),
      // "agora" é presente do indicativo: ajudante parado não tem atividade em
      // curso. O terminal do card já fecha a árvore dele no redutor, mas um
      // filho pendente de replay/queda suja não pode ressuscitar um "agora".
      activity: status === 'running' ? activityFor(children, parent) : null,
      status,
      statusLabel: statusLabel(status),
      outcome: null,
      parent,
      children,
      at: parent.at
    }
  })
}

// ————— O ✕ DA FROTA (R27F3, mockup rightdock-2 §FROTA) —————
//
// Ordem literal do dono (2026-08-22): "quando o subagente deu interrompido, eu
// quero algum X pra eu tirar dali, porque eu já entendi". Até aqui só o AGENTE
// descartava (`helper_cancel` pelo MCP); o ✕ vira o canal MECÂNICO do dono para
// a MESMA decisão — e o mockup é explícito: descartar joga fora, a entrega
// parcial vai junto, e a dica avisa.

/** A DICA, e ela promete o preço inteiro: quem lê "✕" sem isto pensaria em
 *  "esconder da lista". O nome do verbo do agente entra de propósito — é o que
 *  liga o gesto do dono ao que a conversa já sabe fazer. */
export const GUI_SUBAGENT_DISMISS_TIP =
  'descarta o ajudante — a conversa interrompida e a entrega parcial somem ' +
  '(mesmo efeito do helper_cancel do agente)'

/** A metade do MAIN só chega no restart seguinte: enquanto a ponte não existe,
 *  o clique NOMEIA a receita em vez de não fazer nada. Padrão da casa (ver
 *  `missionHistory`, `guiFileContextMenu`). */
export const GUI_SUBAGENT_DISMISS_NO_BRIDGE =
  'reinicie o app (npm run dev) para descartar ajudante daqui — esta janela ainda não tem a ponte'

/** Resposta sem forma (ponte de outra geração, canal que devolveu lixo) nunca
 *  vira "descartei": o dono ficaria olhando uma ficha que ele acha que já foi. */
const DISMISS_WITHOUT_ANSWER =
  'o app não respondeu se o ajudante foi descartado — abra o helpers_status pelo chat antes de tentar de novo'

/**
 * QUEM GANHA O ✕. Duas condições, e as duas são estruturais:
 *
 * · o tom tem de ser INTERROMPIDO. Não é a lista de "tudo que não trabalha": é
 *   o único desfecho que o motor sabe DESCARTAR (`ownerDismiss` →
 *   `helper_cancel`), porque só ele tem conversa e entrega PARCIAL para jogar
 *   fora. Quem entregou, falhou ou já foi descartado não volta a ser matéria de
 *   descarte — e a lateral nem chega a mostrá-los, porque todo desfecho que
 *   ENCERRA já sai da lista em `guiSubagentSidebarEntries`. Um botão que só
 *   sabe recusar é pior que botão nenhum;
 * · tem de haver ajudante no MOTOR (`helperId`). A ficha do caminho NATIVO
 *   aposentado nunca teve um — botão morto é pior que botão ausente.
 */
export function guiSubagentDismissable(entry: {
  status: GuiSubagentSidebarTone
  helperId: string | null
}): boolean {
  return entry.status === 'interrupted' && Boolean(entry.helperId)
}

interface GuiSubagentDismissBridge {
  dismissHelper?(helperId: string): Promise<GuiHelperOwnerDismissResult>
}

function dismissBridge(): GuiSubagentDismissBridge | undefined {
  return (window as unknown as { synkora?: { gui?: GuiSubagentDismissBridge } }).synkora?.gui
}

/**
 * O CLIQUE. Ele não decide nada: quem descarta é o motor, e a resposta dele
 * viaja VERBATIM até a lateral — é ela que nomeia o estado real do ajudante
 * quando o descarte não vale (ficha viva, entrega pronta).
 *
 * `state: 'gone'` é sucesso: o motor já não conhecia aquele ajudante (o app
 * reiniciou, o registro envelheceu, o agente já tinha descartado) e a ficha na
 * tela é história. Recusar ali deixaria o dono preso a uma linha que ele não
 * teria como tirar — beco sem saída é bug.
 */
export async function dismissGuiSubagentHelper(
  helperId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = dismissBridge()
  if (typeof api?.dismissHelper !== 'function') {
    return { ok: false, error: GUI_SUBAGENT_DISMISS_NO_BRIDGE }
  }
  try {
    const outcome = await api.dismissHelper(helperId)
    if (!outcome || typeof outcome !== 'object') {
      return { ok: false, error: DISMISS_WITHOUT_ANSWER }
    }
    if (outcome.ok) return { ok: true }
    return { ok: false, error: outcome.error || DISMISS_WITHOUT_ANSWER }
  } catch (error) {
    // Canal caído tem de VIRAR TEXTO: o clique que some em silêncio é o bug que
    // esta função existe para não ter.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * As fichas que representam trabalho EM CURSO — a projeção que o FIO consome
 * ("N subagentes trabalhando em segundo plano", em `GuiPane`).
 *
 * O nome continua sendo o da lateral porque é a MESMA normalização: o indicador
 * do fio nunca conta por conta própria, ele lê uma fatia do que a lateral
 * mostra. A fatia existe desde que a lateral passou a guardar o interrompido
 * (R6.1): frota parada é trabalho PARADO, e contá-la no fio diria ao dono que o
 * app está trabalhando enquanto ninguém está.
 */
export function normalizeGuiSubagentSidebar(
  items: readonly GuiItem[]
): GuiSubagentSidebarEntry[] {
  return guiSubagentSidebarEntries(items).filter((entry) => entry.status === 'running')
}

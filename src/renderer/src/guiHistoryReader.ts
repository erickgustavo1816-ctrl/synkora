/**
 * O LEITOR DA CONVERSA COMPLETA, do lado do renderer (R24).
 *
 * Só decisões puras moram aqui: o texto da linha-verdade do topo do fio, a
 * leitura defensiva do evento sintético de poda e a costura das PÁGINAS que o
 * main devolve. O componente cuida de DOM e foco; o store guarda o alvo.
 *
 * O `cursor` de cada fala é o offset de byte da linha no JSONL — é por ele que
 * a próxima faixa é pedida, e é ele que torna o dedupe exato (id sozinho não
 * basta: o claude regrava a mesma fala enquanto ela cresce).
 */
import type {
  HistoryPaneConversation,
  HistoryPaneConversationsResult,
  HistoryTranscriptMessage
} from '../../shared/commandPalette'

/**
 * A linha do topo, em voz de fato consumado: ela conta o que ACONTECEU com o
 * fio. A receita ("ver conversa completa") é o botão ao lado — a frase nunca
 * termina num beco.
 */
export function guiPrunedNoticeText(evicted: number): string {
  const events = evicted === 1 ? '1 evento antigo' : `${evicted} eventos antigos`
  return `o começo desta conversa saiu da tela (${events})`
}

/**
 * Contagem confiável do evento `history-pruned`. Valor torto (ou zero) NÃO
 * vira linha: melhor fio sem aviso do que um aviso dizendo "NaN eventos".
 */
export function guiPrunedEvicted(evt: unknown): number | null {
  if (!evt || typeof evt !== 'object') return null
  const record = evt as Record<string, unknown>
  if (record['type'] !== 'history-pruned') return null
  const evicted = record['evicted']
  return typeof evicted === 'number' && Number.isSafeInteger(evicted) && evicted > 0
    ? evicted
    : null
}

/**
 * Separador da chave de dedupe. O id vem do provedor e a régua do main
 * (`safeProviderId`) só aceita `[A-Za-z0-9._:-]`, então nenhum id contém este
 * caractere e a junção id+cursor é injetiva.
 */
const HISTORY_LINE_KEY_SEPARATOR = '@'

/**
 * Junta a página nova na lista aberta. Dedupe por id+cursor (a MESMA linha do
 * arquivo) e ordem pelo cursor — o overlay nunca reordena por chegada.
 */
export function mergeGuiHistoryPage(
  current: readonly HistoryTranscriptMessage[],
  incoming: readonly HistoryTranscriptMessage[]
): HistoryTranscriptMessage[] {
  const byLine = new Map<string, HistoryTranscriptMessage>()
  for (const message of [...current, ...incoming]) {
    byLine.set(`${message.id}${HISTORY_LINE_KEY_SEPARATOR}${message.cursor}`, message)
  }
  return [...byLine.values()].sort((a, b) => a.cursor - b.cursor)
}

/**
 * A faixa da próxima página, a partir do que já está na tela: subir pede o que
 * TERMINA na fala mais antiga; descer, o que COMEÇA na mais nova.
 */
export function guiHistoryPageRequest(
  messages: readonly HistoryTranscriptMessage[],
  direction: 'before' | 'after'
): { before: number } | { after: number } | null {
  if (messages.length === 0) return null
  const cursors = messages.map((message) => message.cursor)
  return direction === 'before'
    ? { before: Math.min(...cursors) }
    : { after: Math.max(...cursors) }
}

// ————— TODAS AS CONVERSAS DO CHAT (2026-09-28) —————
//
// Pedido do dono: "tem conversa que não consigo ver o histórico todo. Quero
// conseguir ver de todas as conversas". O /new deixou de apagar o fio (um
// divisor marca a troca) e o main passou a guardar o id de cada conversa que
// ficou para trás. Aqui moram as decisões puras do lado do renderer: QUANDO a
// linha do topo aparece, QUAL conversa o leitor abre e COMO o cabeçalho navega.

/** A linha do topo quando o fio COMEÇA num divisor: a conversa de antes não
 *  está no anel (chat zerado antes deste registro existir, ou poda). */
export const GUI_EARLIER_CONVERSATION_TEXT = 'a conversa anterior deste chat não está nesta tela'

/** Nem o registro do chat nem a pasta da missão devolveram a conversa de
 *  antes. A frase termina na receita que SEMPRE existe: a busca do Ctrl+K. */
export const GUI_EARLIER_CONVERSATIONS_MISSING =
  'não achei as conversas anteriores deste chat no disco — use Ctrl+K para buscar um trecho'

/** A etiqueta da conversa achada na pasta da missão (sem prova de autoria). */
export const GUI_RECOVERED_CONVERSATION_TAG = 'recuperada da pasta da missão'

/**
 * A linha-verdade do topo do fio, em dois sabores:
 *
 *  · `earlier` — o PRIMEIRO item é um divisor: houve conversa antes e ela não
 *    está na tela. Ganha da poda: com o divisor no topo, a conversa atual está
 *    inteira abaixo dele e o que o anel perdeu é de uma conversa anterior;
 *  · `pruned` — o anel descartou o começo do que guardava (R24.1).
 *
 * `dividers` é quantas trocas de conversa o fio mostra — é por ela que o
 * leitor acha a conversa a que o topo do fio pertence.
 */
export type GuiThreadTopLine = {
  kind: 'pruned' | 'earlier'
  truth: string
  action: string
  dividers: number
}

export function guiThreadTopLine(
  prunedEvents: number,
  items: readonly { kind: string }[]
): GuiThreadTopLine | null {
  let dividers = 0
  for (const item of items) if (item.kind === 'divider') dividers += 1
  if (items[0]?.kind === 'divider') {
    return {
      kind: 'earlier',
      truth: GUI_EARLIER_CONVERSATION_TEXT,
      action: 'ver conversas anteriores',
      dividers
    }
  }
  if (prunedEvents > 0) {
    return {
      kind: 'pruned',
      truth: guiPrunedNoticeText(prunedEvents),
      action: 'ver conversa completa',
      dividers
    }
  }
  return null
}

/** Onde a conversa atual está na lista do main; sem atual (o chat ainda não
 *  ganhou id), todas as listadas são anteriores. */
function currentConversationIndex(conversations: readonly HistoryPaneConversation[]): number {
  const index = conversations.findIndex((conversation) => conversation.current)
  return index < 0 ? conversations.length : index
}

/**
 * O que o leitor abre ao clicar na linha do topo:
 *
 *  · `current` — a conversa atual, primeira página (o comportamento do R24.2:
 *    `loadForPane(paneId)` sem id);
 *  · `conversation` — outra conversa do chat, pelo id (o main ancora no FIM
 *    dela quando não é a atual);
 *  · `missing` — não há conversa anterior a abrir: a frase nomeia a receita.
 *
 * A conversa escolhida é aquela a que o TOPO do fio pertence: um passo para
 * trás por divisor. Com um divisor só é a mais nova das anteriores; poda sem
 * divisor nenhum é a própria conversa atual. Troca de CLI/conta não desenha
 * divisor, então a conta pode cair numa conversa mais nova que a do topo — o
 * cabeçalho navega a partir dali, e nunca abre algo fora da lista do main.
 */
export type GuiHistoryOpenPlan =
  | { kind: 'current' }
  | { kind: 'conversation'; sessionId: string }
  | { kind: 'missing'; error: string }

export function guiHistoryOpenPlan(
  line: GuiThreadTopLine,
  listing: HistoryPaneConversationsResult | null
): GuiHistoryOpenPlan {
  const conversations = listing?.ok ? listing.conversations : null
  const steps = line.kind === 'earlier' ? Math.max(1, line.dividers) : line.dividers
  if (line.kind === 'pruned' && (steps === 0 || !conversations)) return { kind: 'current' }
  if (!conversations) {
    return { kind: 'missing', error: listing?.error?.trim() || GUI_EARLIER_CONVERSATIONS_MISSING }
  }
  const current = currentConversationIndex(conversations)
  if (current === 0) {
    return line.kind === 'pruned'
      ? { kind: 'current' }
      : { kind: 'missing', error: GUI_EARLIER_CONVERSATIONS_MISSING }
  }
  const target = conversations[Math.max(0, current - steps)]
  return { kind: 'conversation', sessionId: target.sessionId }
}

/** `28/09/2026 14:05`, no relógio local. Data inválida não vira texto. */
export function guiHistoryConversationDate(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`
}

/** O cabeçalho do leitor quando o chat tem MAIS de uma conversa. */
export interface GuiHistoryConversationNav {
  /** 1 = a mais antiga. */
  position: number
  total: number
  label: string
  previousSessionId: string | null
  nextSessionId: string | null
  recovered: boolean
  /** Quando: `conversa atual`, `encerrada em …` ou `última escrita em …`. */
  when: string | null
}

/**
 * A posição da conversa aberta na lista do chat. `null` = não há o que
 * navegar: leitura avulsa (paleta, sem lista), conversa fora da lista, ou um
 * chat de conversa única — ali "conversa 1 de 1" com duas setas mortas seria
 * ruído no leitor que já existia.
 */
export function guiHistoryConversationNav(
  conversations: readonly HistoryPaneConversation[] | undefined,
  sessionId: string
): GuiHistoryConversationNav | null {
  if (!conversations || conversations.length < 2) return null
  const index = conversations.findIndex((conversation) => conversation.sessionId === sessionId)
  if (index < 0) return null
  const open = conversations[index]
  const date = guiHistoryConversationDate(open.updatedAt)
  const when = open.current
    ? 'conversa atual'
    : date
      ? `${open.source === 'recovered' ? 'última escrita em' : 'encerrada em'} ${date}`
      : null
  return {
    position: index + 1,
    total: conversations.length,
    label: `conversa ${index + 1} de ${conversations.length}`,
    previousSessionId: index > 0 ? conversations[index - 1].sessionId : null,
    nextSessionId: index < conversations.length - 1 ? conversations[index + 1].sessionId : null,
    recovered: open.source === 'recovered',
    when
  }
}

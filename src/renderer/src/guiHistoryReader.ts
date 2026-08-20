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
import type { HistoryTranscriptMessage } from '../../shared/commandPalette'

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

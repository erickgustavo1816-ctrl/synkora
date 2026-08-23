/**
 * CITAÇÃO DO FIO (R33, 2026-08-23 — pedido verbatim do dono: "eu seleciono
 * essa parte da conversa como um anexo mesmo na parte do chat ali do input, e
 * aí eu falo sobre essa parte que ele falou").
 *
 * Este módulo é a metade PURA: clipar a seleção, rotular o chip e compor o
 * prompt. O DOM (seleção, menu, chips) mora no GuiPane/GuiSelectionMenu; as
 * suítes node testam daqui sem subir renderer nenhum.
 *
 * A composição é UMA verdade só: o bloco citado entra na frente do texto da
 * mensagem, então a bolha do dono mostra EXATAMENTE o que o modelo leu — nada
 * de canal paralelo que o transcript não registre.
 */

/** Teto por citação. Acima disso a seleção clipa com reticência — um despejo
 *  de fio inteiro dentro do prompt afogaria a própria pergunta do dono. */
export const GUI_QUOTE_MAX_CHARS = 4000

/** Teto de citações penduradas no composer de uma vez. */
export const GUI_QUOTE_MAX_COUNT = 4

/** A marca do bloco no prompt — a mesma voz de harness das outras cargas da
 *  casa (`[synkora] …`), para o agente saber que é o app repassando. */
export const GUI_QUOTE_PROMPT_TAG = '[synkora] trecho do fio citado pelo dono:'

/** Prévia de uma linha para o chip. */
export const GUI_QUOTE_LABEL_MAX_CHARS = 48

/**
 * A seleção crua vira citação: espaços das pontas fora, vazio é `null` (menu
 * nem abre), estouro clipa COM reticência — o corte aparece, nunca é mudo.
 */
export function guiQuoteFromSelection(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  if (text.length <= GUI_QUOTE_MAX_CHARS) return text
  return `${text.slice(0, GUI_QUOTE_MAX_CHARS)}…`
}

/** O rótulo do chip: primeira linha útil, clipada. */
export function guiQuoteChipLabel(quote: string): string {
  const line = quote.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  if (line.length <= GUI_QUOTE_LABEL_MAX_CHARS) return line
  return `${line.slice(0, GUI_QUOTE_LABEL_MAX_CHARS)}…`
}

/**
 * O PROMPT COMPOSTO: cada citação como blockquote sob a marca da casa, e a
 * mensagem do dono por último, verbatim — ordem de leitura: contexto, depois
 * a ordem. Sem citação, a mensagem passa intocada (byte a byte).
 */
export function guiQuotedPrompt(quotes: readonly string[], message: string): string {
  const meaningful = quotes.map((quote) => quote.trim()).filter((quote) => quote.length > 0)
  if (meaningful.length === 0) return message
  const blocks = meaningful.map(
    (quote) =>
      `${GUI_QUOTE_PROMPT_TAG}\n${quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`
  )
  return message.trim().length > 0 ? `${blocks.join('\n\n')}\n\n${message}` : blocks.join('\n\n')
}

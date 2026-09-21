// A ESCRITA DO CHAT — a régua PURA (mockup aprovado pelo dono em 2026-09-21:
// docs/mockups/chat-writer-2026-09-21.html).
//
// Três leis, nesta ordem:
// 1. UM ESCRITOR POR CONVERSA. Só o item de fala mais antigo ainda não revelado
//    escreve; o que vem depois dele no fio (falas, cartões, decisões) espera a
//    vez enquanto ele tiver texto pendente. Antes, cada mensagem tinha o
//    próprio relógio e dois parágrafos digitavam juntos (o vídeo do dono).
// 2. CADÊNCIA ADAPTATIVA. A base é palavras/segundo (preferência do dono);
//    o atraso entre o texto recebido e o texto na tela nunca passa de
//    `maxLagMs` — rajada grande acelera palavra a palavra, nunca pula. Texto já
//    completo drena em `GUI_REVEAL_DRAIN_MS`.
// 3. NUNCA MEIA PALAVRA. Cada passo termina no fim de uma palavra (com o espaço
//    que vem depois), a mesma régua de sempre.
//
// Tudo aqui é puro para ser testado em node sem montar React; o DOM (fade da
// cauda e caret) mora em `guiRevealPaint.ts`.

/** Fim da próxima palavra, incluindo o espaço que vem depois dela. */
export function nextGuiWordEnd(text: string, from: number): number {
  let cursor = Math.max(0, Math.min(from, text.length))
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1
  while (cursor < text.length && !/\s/u.test(text[cursor])) cursor += 1
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1
  return cursor
}

/** Quanto tempo o texto já completo leva para drenar por inteiro. */
export const GUI_REVEAL_DRAIN_MS = 600
/** Duração do fade de cada passo ("a palavra assenta"). */
export const GUI_REVEAL_FADE_MS = 220
/** Quantos passos recentes continuam envolvidos no fade a cada repintura. */
export const GUI_REVEAL_KEEP_STEPS = 4
/** Piso do tique — abaixo disso o relógio vira ruído de quadro. */
export const GUI_REVEAL_MIN_TICK_MS = 16

/** As preferências da escrita (Ajustes › Aparência › Escrita do chat). */
export interface GuiWritingPace {
  /** palavras por segundo na cadência base; 0 = instantâneo (sem revelação) */
  wordsPerSecond: number
  /** atraso máximo tolerado entre o texto recebido e o texto na tela, em ms */
  maxLagMs: number
  /** cada passo entra com fade (falso = a palavra entra seca) */
  fade: boolean
}

export const GUI_WRITING_PACE_DEFAULT: GuiWritingPace = {
  wordsPerSecond: 20,
  maxLagMs: 1000,
  fade: true
}

export const GUI_WRITING_WORDS_PER_SECOND_RANGE = { min: 0, max: 60 } as const
export const GUI_WRITING_MAX_LAG_RANGE = { min: 300, max: 3000 } as const

/** A régua a partir de um documento de preferências qualquer (campo ausente ou
 *  torto = padrão; fora da faixa = borda). */
export function guiWritingPaceOf(source: {
  chatWritingWordsPerSecond?: unknown
  chatWritingMaxLagMs?: unknown
  chatWritingFade?: unknown
} | null | undefined): GuiWritingPace {
  const wps = Number(source?.chatWritingWordsPerSecond)
  const lag = Number(source?.chatWritingMaxLagMs)
  return {
    wordsPerSecond: Number.isFinite(wps)
      ? Math.max(GUI_WRITING_WORDS_PER_SECOND_RANGE.min, Math.min(GUI_WRITING_WORDS_PER_SECOND_RANGE.max, Math.round(wps)))
      : GUI_WRITING_PACE_DEFAULT.wordsPerSecond,
    maxLagMs: Number.isFinite(lag)
      ? Math.max(GUI_WRITING_MAX_LAG_RANGE.min, Math.min(GUI_WRITING_MAX_LAG_RANGE.max, Math.round(lag)))
      : GUI_WRITING_PACE_DEFAULT.maxLagMs,
    fade: source?.chatWritingFade !== false
  }
}

/** O intervalo do relógio para esta cadência (uma palavra por tique na base). */
export function guiRevealTickMs(pace: GuiWritingPace): number {
  if (pace.wordsPerSecond <= 0) return GUI_REVEAL_MIN_TICK_MS
  return Math.max(GUI_REVEAL_MIN_TICK_MS, Math.round(1000 / pace.wordsPerSecond))
}

/** Palavras ainda não reveladas entre `shown` e o fim do texto. */
export function guiPendingWords(text: string, shown: number): number {
  let count = 0
  let cursor = Math.max(0, Math.min(shown, text.length))
  while (cursor < text.length) {
    const next = nextGuiWordEnd(text, cursor)
    if (next === cursor) break
    if (text.slice(cursor, next).trim().length > 0) count += 1
    cursor = next
  }
  return count
}

/**
 * QUANTAS PALAVRAS ESTE TIQUE REVELA. Base = 1. Se o pendente levaria mais do
 * que `maxLagMs` para ser lido na cadência base, o passo cresce o suficiente
 * para caber no teto; texto completo drena em `GUI_REVEAL_DRAIN_MS`. Nunca
 * menos de uma palavra (com trabalho pendente); nunca fração.
 */
export function guiRevealWordsThisTick(
  text: string,
  shown: number,
  complete: boolean,
  pace: GuiWritingPace,
  tickMs = guiRevealTickMs(pace)
): number {
  const pending = guiPendingWords(text, shown)
  if (pending === 0) return 0
  if (pace.wordsPerSecond <= 0) return pending
  const budget = complete ? GUI_REVEAL_DRAIN_MS : pace.maxLagMs
  const ticks = Math.max(1, Math.floor(budget / tickMs))
  return Math.max(1, Math.min(pending, Math.ceil(pending / ticks)))
}

/** O próximo cursor depois de revelar `words` palavras inteiras. */
export function nextGuiRevealShown(text: string, shown: number, words: number): number {
  let cursor = Math.max(0, Math.min(shown, text.length))
  for (let step = 0; step < words && cursor < text.length; step += 1) {
    const next = nextGuiWordEnd(text, cursor)
    if (next === cursor) break
    cursor = next
  }
  return cursor
}

/** O mínimo do item do fio que o escritor enxerga (o `GuiItem` do store serve). */
export interface GuiWriterScanItem {
  kind: string
  text?: string
  /** true enquanto ainda podem chegar deltas para ESTE item. */
  live?: boolean
  /** prefixo já revelado; menor que o texto = ainda escrevendo na tela. */
  animateFrom?: number
}

/** O índice do ESCRITOR DA VEZ: a primeira fala ainda não revelada. -1 = ninguém escreve. */
export function guiWriterIndex(items: readonly GuiWriterScanItem[]): number {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind !== 'assistant') continue
    const length = (item.text ?? '').length
    if (item.live || (item.animateFrom ?? length) < length) return index
  }
  return -1
}

/**
 * O QUE O FIO MOSTRA ENQUANTO O ESCRITOR TRABALHA: tudo até ele, inclusive; o
 * resto espera a vez. `writerBusy` é o escritor com texto pendente na tela —
 * um item vivo já todo revelado (esperando o próximo delta) não segura nada,
 * por isso um stream que morreu no meio nunca esconde um cartão de decisão.
 * Lista intacta (a mesma referência) quando nada precisa ser retido.
 */
export function guiHeldItems<T extends GuiWriterScanItem>(
  items: readonly T[],
  writerBusy: boolean
): readonly T[] {
  if (!writerBusy) return items
  const writer = guiWriterIndex(items)
  if (writer < 0 || writer === items.length - 1) return items
  return items.slice(0, writer + 1)
}

/** Um passo revelado, para o fade da cauda: quantas palavras e quando. */
export interface GuiRevealStep {
  words: number
  at: number
}

/** O plano do fade para a repintura: os últimos passos, cada um com a IDADE da
 *  animação (o fade continua do valor atual — nunca recomeça — porque o
 *  markdown re-pinta o último bloco a cada tique). */
export function guiRevealFadePlan(
  history: readonly GuiRevealStep[],
  now: number,
  fadeMs = GUI_REVEAL_FADE_MS,
  keep = GUI_REVEAL_KEEP_STEPS
): { words: number; ageMs: number }[] {
  const recent = history.slice(-keep)
  return recent
    .map((step) => ({ words: step.words, ageMs: Math.max(0, Math.min(fadeMs, now - step.at)) }))
    .filter((step) => step.words > 0 && step.ageMs < fadeMs)
}

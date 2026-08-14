/** Cadência deliberadamente humana: um passo revela UMA palavra, nunca uma rajada. */
export const GUI_WORD_REVEAL_MS = 52

/**
 * Fim da próxima palavra, incluindo o espaço que vem depois dela. O helper é
 * puro para que rajadas grandes do CLI possam ser testadas sem montar React.
 */
export function nextGuiWordEnd(text: string, from: number): number {
  let cursor = Math.max(0, Math.min(from, text.length))
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1
  while (cursor < text.length && !/\s/u.test(text[cursor])) cursor += 1
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1
  return cursor
}


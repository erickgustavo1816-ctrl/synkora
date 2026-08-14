export interface GuiToolResultDetails {
  text: string
  lineCount: number
  truncated: boolean
}

/**
 * O renderer recebe um preview limitado, mas a contagem descreve o output
 * INTEIRO. Comando silencioso volta com zero linhas em vez de ficar pendente.
 */
export function guiToolResultDetails(raw: string, max = 400): GuiToolResultDetails {
  let end = raw.length
  while (end > 0 && /\s/u.test(raw[end - 1])) end -= 1
  let lineCount = end > 0 ? 1 : 0
  for (let index = 0; index < end; index += 1) {
    const code = raw.charCodeAt(index)
    if (code === 10) lineCount += 1
    else if (code === 13) {
      lineCount += 1
      if (raw.charCodeAt(index + 1) === 10) index += 1
    }
  }
  const limit = Math.max(0, Math.floor(max))
  const truncated = end > limit
  return {
    text: truncated ? `${raw.slice(0, limit)}…` : raw.slice(0, end),
    lineCount,
    truncated
  }
}

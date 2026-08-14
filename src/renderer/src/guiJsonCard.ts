/**
 * Decides whether an assistant response can use the compact JSON card.
 *
 * This stays separate from the React component so the safety limits are easy
 * to exercise without mounting the chat. A response with prose around JSON is
 * deliberately not a JSON response: it keeps the normal Markdown renderer.
 */

export const GUI_JSON_CARD_MAX_CHARS = 48_000
export const GUI_JSON_CARD_MAX_FORMATTED_CHARS = 96_000
export const GUI_JSON_CARD_MAX_DEPTH = 12
export const GUI_JSON_CARD_MAX_NODES = 10_000

export interface GuiJsonCardData {
  formatted: string
  depth: number
  nodes: number
}

function exceedsJsonDepth(source: string, maxDepth: number): boolean {
  let depth = 0
  let inString = false
  let escaped = false

  for (const character of source) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{' || character === '[') {
      depth += 1
      if (depth > maxDepth) return true
    } else if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1)
    }
  }

  return false
}

function inspectJsonValue(
  value: unknown,
  depth: number,
  state: { nodes: number; maxDepth: number }
): boolean {
  state.nodes += 1
  state.maxDepth = Math.max(state.maxDepth, depth)
  if (state.nodes > GUI_JSON_CARD_MAX_NODES || depth > GUI_JSON_CARD_MAX_DEPTH) {
    return false
  }

  if (value === null || typeof value !== 'object') return true

  if (Array.isArray(value)) {
    return value.every((entry) => inspectJsonValue(entry, depth + 1, state))
  }

  return Object.values(value).every((entry) => inspectJsonValue(entry, depth + 1, state))
}

/**
 * Returns formatted JSON only when the complete response is valid, bounded
 * JSON. `null` means the caller should keep the ordinary Markdown path.
 */
export function parseGuiJsonCard(text: string): GuiJsonCardData | null {
  const source = text.trim()
  if (!source || source.length > GUI_JSON_CARD_MAX_CHARS) return null
  if (exceedsJsonDepth(source, GUI_JSON_CARD_MAX_DEPTH)) return null

  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch {
    return null
  }

  const state = { nodes: 0, maxDepth: 0 }
  if (!inspectJsonValue(value, 0, state)) return null

  const formatted = JSON.stringify(value, null, 2)
  if (typeof formatted !== 'string' || formatted.length > GUI_JSON_CARD_MAX_FORMATTED_CHARS) {
    return null
  }

  return { formatted, depth: state.maxDepth, nodes: state.nodes }
}

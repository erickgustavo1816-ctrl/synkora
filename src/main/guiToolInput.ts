export const GUI_TOOL_INPUT_MAX_CHARS = 256 * 1024
export const GUI_TOOL_INPUT_MAX_LINES = 2_000
export const GUI_TOOL_INPUT_MAX_FILES = 50
export const GUI_TOOL_INPUT_TRUNCATED = '__synkora_input_truncated'

const MAX_DEPTH = 5
const MAX_KEYS = 64
const MAX_NODES = 1_000

interface InputBudget {
  chars: number
  lines: number
  nodes: number
  truncated: boolean
}

function boundedString(raw: string, budget: InputBudget): string {
  if (budget.chars <= 0 || budget.lines <= 0) {
    if (raw) budget.truncated = true
    return ''
  }
  const charEnd = Math.min(raw.length, budget.chars)
  let end = charEnd
  let lines = raw && charEnd > 0 ? 1 : 0
  for (let index = 0; index < charEnd; index += 1) {
    if (raw.charCodeAt(index) !== 10) continue
    if (lines >= budget.lines) {
      end = index
      break
    }
    lines += 1
  }
  const value = raw.slice(0, end)
  if (end < raw.length) budget.truncated = true
  budget.chars -= value.length
  budget.lines -= lines
  return value
}

function boundedValue(
  value: unknown,
  budget: InputBudget,
  depth: number,
  seen: WeakSet<object>
): unknown {
  budget.nodes -= 1
  if (budget.nodes < 0) {
    budget.truncated = true
    return undefined
  }
  if (typeof value === 'string') return boundedString(value, budget)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH || seen.has(value)) {
    budget.truncated = true
    return undefined
  }
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > GUI_TOOL_INPUT_MAX_FILES) budget.truncated = true
    const result = value
      .slice(0, GUI_TOOL_INPUT_MAX_FILES)
      .map((item) => boundedValue(item, budget, depth + 1, seen))
      .filter((item) => item !== undefined)
    seen.delete(value)
    return result
  }
  const source = value as Record<string, unknown>
  const keys: string[] = []
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key) || key === GUI_TOOL_INPUT_TRUNCATED)
      continue
    if (keys.length >= MAX_KEYS) {
      budget.truncated = true
      break
    }
    keys.push(key)
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const limited = boundedValue(source[key], budget, depth + 1, seen)
    if (limited !== undefined) result[key] = limited
  }
  seen.delete(value)
  return result
}

/** Cópia limitada para replay/IPC. O input privado do CLI nunca é alterado. */
export function limitGuiToolInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  const budget: InputBudget = {
    chars: GUI_TOOL_INPUT_MAX_CHARS,
    lines: GUI_TOOL_INPUT_MAX_LINES,
    nodes: MAX_NODES,
    truncated: false
  }
  const limited = boundedValue(input, budget, 0, new WeakSet())
  const result =
    limited && typeof limited === 'object' && !Array.isArray(limited)
      ? (limited as Record<string, unknown>)
      : {}
  if (budget.truncated) result[GUI_TOOL_INPUT_TRUNCATED] = true
  return result
}

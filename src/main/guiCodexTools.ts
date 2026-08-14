export type GuiCodexToolType =
  | 'commandExecution'
  | 'fileChange'
  | 'webSearch'
  | 'mcpToolCall'

export interface GuiCodexCompletedItem {
  type?: string
  status?: string
  exitCode?: number
  aggregatedOutput?: string
  result?: unknown
  error?: unknown
}

const TOOL_TYPES = new Set<GuiCodexToolType>([
  'commandExecution',
  'fileChange',
  'webSearch',
  'mcpToolCall'
])

export type GuiCodexToolOutcome = 'completed' | 'failed' | 'denied' | 'cancelled'
export type GuiCodexTurnOutcome = 'completed' | 'failed' | 'cancelled'

const FAILED_STATUSES = new Set(['failed', 'error'])
const DENIED_STATUSES = new Set(['declined', 'rejected'])
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled'])

export function guiCodexTurnOutcome(status: string | undefined): GuiCodexTurnOutcome {
  const normalized = status?.trim().toLowerCase() ?? ''
  if (FAILED_STATUSES.has(normalized)) return 'failed'
  if (CANCELLED_STATUSES.has(normalized) || normalized === 'interrupted') return 'cancelled'
  return 'completed'
}

export function guiCodexErrorWillRetry(params: Record<string, unknown>): boolean {
  if (params['willRetry'] === true) return true
  const error = params['error']
  return Boolean(error && typeof error === 'object' && (error as Record<string, unknown>)['willRetry'] === true)
}

export function isGuiCodexToolType(type: string | undefined): type is GuiCodexToolType {
  return Boolean(type && TOOL_TYPES.has(type as GuiCodexToolType))
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['message', 'text', 'output', 'content']) {
      const candidate = record[key]
      if (typeof candidate !== 'string' || !candidate) continue
      return candidate.length <= 4_000 ? candidate : `${candidate.slice(0, 4_000)}…`
    }
    return '[resultado estruturado]'
  }
  return '[resultado indisponível]'
}

/** `item/completed` fecha TODA família aberta em `item/started`, inclusive
 *  resultados vazios; status/erro do protocolo nunca vira sucesso verde. */
export function guiCodexToolCompletion(item: GuiCodexCompletedItem): {
  text: string
  isError: boolean
  outcome: GuiCodexToolOutcome
} {
  const status = item.status?.trim().toLowerCase() ?? ''
  const failed =
    (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0) ||
    FAILED_STATUSES.has(status) ||
    (item.error !== undefined && item.error !== null)
  const outcome: GuiCodexToolOutcome = DENIED_STATUSES.has(status)
    ? 'denied'
    : CANCELLED_STATUSES.has(status)
      ? 'cancelled'
      : failed
        ? 'failed'
        : 'completed'
  const text = (item.aggregatedOutput ?? printable(item.result)) || printable(item.error)
  return { text, isError: outcome === 'failed', outcome }
}

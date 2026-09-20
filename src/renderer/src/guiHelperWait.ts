import type { GuiPaneState } from './store'

/** The CLI emits the raw MCP name on Codex and the qualified name on Claude.
 * Only pending parent calls count; helper activity is a separate execution. */
const HELPER_RESULT_TOOLS = new Set(['helper_result', 'mcp__synkora__helper_result'])

export function guiWaitsForHelperResult(
  pane: Pick<GuiPaneState, 'status' | 'ready' | 'thinking' | 'stream' | 'items'>
): boolean {
  if (pane.status !== 'working' || !pane.ready || pane.thinking || pane.stream) return false
  let waiting = false
  for (const item of pane.items) {
    if (item.kind !== 'tool' || item.result || item.parentToolUseId) continue
    if (!HELPER_RESULT_TOOLS.has(item.name)) return false
    waiting = true
  }
  return waiting
}

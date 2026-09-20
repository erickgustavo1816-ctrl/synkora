/** Measured by the synthetic skill-reload probe on 2026-09-08. The local
 * command changes the catalog, then returns with zero model turns/API time.
 * Result order and response wording are deliberately not evidence. */
export const GUI_SKILL_RELOAD_TTL_MS = 60 * 60 * 1_000

interface ClaudeReloadFrame {
  type?: unknown
  subtype?: unknown
  parent_tool_use_id?: unknown
  num_turns?: unknown
  duration_api_ms?: unknown
  is_error?: unknown
  result?: unknown
}

export class GuiClaudeSkillReload {
  private catalogChanged = false
  private finished = false

  constructor(private readonly requestedAt = Date.now()) {}

  observe(frame: ClaudeReloadFrame, now = Date.now()): { text?: string; isError: boolean } | undefined {
    if (this.finished) return undefined
    if (now - this.requestedAt >= GUI_SKILL_RELOAD_TTL_MS) {
      this.finished = true
      return undefined
    }
    if (frame.parent_tool_use_id != null) return undefined
    if (frame.type === 'system' && frame.subtype === 'commands_changed') {
      this.catalogChanged = true
    } else if (frame.type === 'result') {
      const changed = this.catalogChanged
      this.catalogChanged = false
      if (!changed || frame.num_turns !== 0 || frame.duration_api_ms !== 0 || typeof frame.is_error !== 'boolean')
        return undefined
      this.finished = true
      return { text: typeof frame.result === 'string' ? frame.result : undefined, isError: frame.is_error }
    } else if (frame.type === 'assistant' || frame.type === 'stream_event' || frame.type === 'user' || frame.type === 'control_request') {
      // Model/tool activity after the catalog signal belongs to another turn.
      this.catalogChanged = false
    }
    return undefined
  }
}

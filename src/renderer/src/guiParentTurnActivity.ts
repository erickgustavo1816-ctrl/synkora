import type { GuiSessionEvent } from './guiApi'

/** Logical chat activity includes helpers; only parent work drives the
 * thinking/preparing indicator. Undefined preserves older replay behavior. */
export function guiParentTurnActivity(
  previous: boolean | undefined,
  event: GuiSessionEvent
): boolean | undefined {
  switch (event.type) {
    case 'context-compaction':
      return event.active ? true : previous
    case 'turn-started':
    case 'thinking':
    case 'delta':
    case 'text':
      return true
    case 'tool':
      return event.parentToolUseId ? previous : true
    case 'result':
    case 'turn-continuation':
      return event.turnActive ?? (event.continues === true)
    case 'command-completed':
      return event.continues ? previous : false
    case 'conversation-cleared':
    case 'session-restarted':
      return undefined
    case 'fatal':
    case 'closed':
      return false
    default:
      return previous
  }
}

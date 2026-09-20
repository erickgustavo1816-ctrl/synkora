import type { GuiSessionEvent } from './guiApi'

/** Only protocol lifecycle signals change this phase; RPC acceptance is not completion. */
export function guiContextCompaction(previous: boolean, event: GuiSessionEvent): boolean {
  switch (event.type) {
    case 'context-compaction':
      return event.active
    case 'turn-started':
    case 'result':
    case 'fatal':
    case 'closed':
    case 'session-restarted':
    case 'conversation-cleared':
      return false
    default:
      return previous
  }
}

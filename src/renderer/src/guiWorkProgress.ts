import type { GuiSessionEvent } from './guiApi'

/** Measures observed public silence, never model reasoning or transport uptime.
 * Replay/restart starts a fresh observation window; it cannot backdate it. */
export function guiPublicSilenceSince(
  previous: number | null | undefined,
  event: GuiSessionEvent,
  now: number,
  parentWasActive: boolean
): number | null {
  switch (event.type) {
    case 'delta':
    case 'text':
      return event.text.trim() ? now : previous ?? null
    case 'turn-started':
      return parentWasActive ? previous ?? now : now
    case 'thinking':
      return previous ?? now
    case 'tool':
      return event.parentToolUseId ? previous ?? null : previous ?? now
    case 'result':
    case 'turn-continuation':
      return event.turnActive === true ? previous ?? now : null
    case 'command-completed':
      return event.continues ? previous ?? null : null
    case 'question':
      return event.blocking === false ? previous ?? null : null
    case 'permission':
    case 'plan-review':
    case 'fatal':
    case 'closed':
    case 'session-restarted':
    case 'conversation-cleared':
      return null
    case 'interaction-resolved':
      return previous ?? now
    default:
      return previous ?? null
  }
}

const FILE_TOOLS = new Set(['read', 'read_file', 'edit', 'write', 'write_file', 'apply_patch'])

function toolKey(name: string): string { return name.split('.').at(-1)?.toLowerCase() ?? '' }

/** Only explicit file fields, never shell commands, search content or output.
 * Keep a short file reference instead of exposing an absolute user path. */
export function guiWorkTarget(name: string, input: Record<string, unknown>, diffPath?: string): string | undefined {
  if (!FILE_TOOLS.has(toolKey(name))) return undefined
  const path = input.file_path ?? input.path ?? diffPath
  if (typeof path !== 'string' || path.length > 4096 || /[\r\n\x00-\x1f]/u.test(path)) return undefined
  return path.replace(/\\/gu, '/').split('/').filter(Boolean).slice(-2).join('/').slice(-120) || undefined
}

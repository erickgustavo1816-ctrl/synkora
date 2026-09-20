import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { guiOwnerDebtHookCommand } from './guiOwnerDebtHook'

export const CLAUDE_PROGRESS_TOOLS = 4
export const CLAUDE_PROGRESS_SILENCE_MS = 45_000

export const CLAUDE_PUBLIC_PROGRESS_STYLE = `PUBLIC CHAT — COMMUNICATION WHILE USING TOOLS:
Use mcp__synkora__commentary for your short public progress updates in PT-BR: what you found and what you will do next. Use it also to acknowledge an owner's message during work. Send one before actions, then between groups of tools and about every 45-60 seconds during longer work. Continue the already authorized task in this same turn after speaking. This tool displays YOUR message in the chat without ending the turn. Reserve the final answer for verified results or a concrete blocker with unfinished work, not a promise to apply. Respect owner stop/pause instructions and approvals still required.
If commentary is unavailable or refused, write the update as plain assistant text immediately; do not keep retrying it. Thinking is private, not a public update. Share conclusions and actions, never private reasoning. Do not ask for permission or stop working just to send an update.`

const PROGRESS_REMINDER = 'Synkora public progress reminder: the owner has been watching tools without a new update. Send one short sentence in PT-BR using mcp__synkora__commentary NOW, before another work tool: what you found and what you will do next. If commentary is unavailable or refused, write it as visible assistant text instead. Then continue the current task. Thinking, tool input/output and notes in files are not public updates. Do not expose private reasoning, ask for permission, or end the task just for this reminder.'

export function claudePublicProgressPayload(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: PROGRESS_REMINDER } })
}

/** Adds context only; existing permissions, hooks and fast-mode settings survive. */
export function withClaudePublicProgressHook(settings: Record<string, unknown>, flagPath: string): Record<string, unknown> {
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks as Record<string, unknown> : {}
  const post = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []
  return { ...settings, hooks: { ...hooks, PostToolUse: [...post, {
    matcher: '*', hooks: [{ type: 'command', command: guiOwnerDebtHookCommand(flagPath), timeout: 3 }]
  }] } }
}

interface ProgressEvent {
  type: string
  text?: string
  parentToolUseId?: string
}

export interface ClaudePublicProgressIO {
  now(): number
  write(path: string, value: string): void
  remove(path: string): void
}

export interface ClaudePublicProgressNotice {
  status: 'reminded' | 'unavailable'
  tools: number
  silenceMs: number
}

const progressIO: ClaudePublicProgressIO = {
  now: Date.now,
  write: (path, value) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.next`, value, 'utf8')
    renameSync(`${path}.next`, path)
  },
  remove: path => { try { unlinkSync(path) } catch { /* absent or already removed */ } }
}

/** Per-process, per-pane advisory. No timers, extra model turns, transcript
 * content or tool arguments. The CLI reads a fixed message after its tool. */
export class GuiClaudePublicProgress {
  private tools = 0
  private lastSpokeAt: number
  private armed = false
  private failureReported = false

  constructor(private readonly path: string, private readonly io: ClaudePublicProgressIO = progressIO,
    private readonly record?: (notice: ClaudePublicProgressNotice) => void) {
    this.lastSpokeAt = io.now()
    this.clear()
  }

  observe(event: ProgressEvent): void {
    if (event.parentToolUseId) return
    if ((event.type === 'text' || event.type === 'delta') && event.text?.trim()) {
      this.clear()
    } else if (event.type === 'result' || event.type === 'fatal' || event.type === 'closed') {
      this.clear()
    } else if (event.type === 'tool') {
      this.tools++
      if (!this.armed && (this.tools >= CLAUDE_PROGRESS_TOOLS ||
        this.io.now() - this.lastSpokeAt >= CLAUDE_PROGRESS_SILENCE_MS)) {
        try {
          this.io.write(this.path, claudePublicProgressPayload())
          this.armed = true
          this.audit('reminded')
        } catch {
          if (!this.failureReported) { this.audit('unavailable'); this.failureReported = true }
        }
      }
    }
  }

  private clear(): void {
    this.tools = 0
    this.failureReported = false
    this.lastSpokeAt = this.io.now()
    // Remove stale files at construction and every real public reply/terminal.
    // Delta tokens after the first do not need additional disk operations.
    if (this.armed || !this.initialized) {
      try { this.io.remove(this.path) } catch { /* advisory only */ }
      this.armed = false
      this.initialized = true
    }
  }

  private initialized = false

  private audit(status: ClaudePublicProgressNotice['status']): void {
    try { this.record?.({ status, tools: this.tools, silenceMs: Math.max(0, this.io.now() - this.lastSpokeAt) }) }
    catch { /* Observability must not interrupt the conversation. */ }
  }
}

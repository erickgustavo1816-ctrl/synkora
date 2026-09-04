import type { SessionEvent } from './maestroSession'

export type GuiProgressState = 'starting' | 'working' | 'waiting_user' | 'idle' | 'turn_finished' | 'interrupted' | 'error'
export type GuiProgressPendingKind = 'permission' | 'question' | 'plan-review' | 'plan-proposal'
export interface GuiProgressHelpers { running: number; interrupted: number; failed: number }
/** Structural projection only. Never copy event text, arguments, paths or accounts. */
export interface GuiProgressInput {
  paneId: string
  projectId: string
  state: GuiProgressState
  pendingCount: number
  pendingKind?: GuiProgressPendingKind
  activityAt?: string
  helpers?: GuiProgressHelpers
}

interface TrackedPane {
  paneId: string
  projectId: string
  state: Exclude<GuiProgressState, 'waiting_user'>
  activityAt?: string
  pending: Map<string, { kind: GuiProgressPendingKind; blocking: boolean }>
}
const PENDING_ORDER: Record<GuiProgressPendingKind, number> = {
  permission: 0, question: 1, 'plan-review': 2, 'plan-proposal': 3
}
const terminal = (state: TrackedPane['state']): boolean =>
  state === 'turn_finished' || state === 'interrupted' || state === 'error'

export class GuiProgressTracker {
  private readonly panes = new Map<string, TrackedPane>()

  open(identity: { paneId: string; projectId: string }, replay: readonly unknown[] = []): void {
    const pane: TrackedPane = { paneId: identity.paneId, projectId: identity.projectId, state: 'starting', pending: new Map() }
    // Only persistent, nonblocking proposals cross a process boundary. Old
    // terminal/activity events cannot claim that a new process is working.
    for (const item of replay) {
      if (!item || typeof item !== 'object') continue
      const envelope = item as { evt?: unknown }
      const event = (envelope.evt ?? item) as { type?: unknown; requestId?: unknown }
      if (typeof event.requestId !== 'string') continue
      if (event.type === 'plan-proposal') pane.pending.set(event.requestId, { kind: 'plan-proposal', blocking: false })
      if (event.type === 'interaction-resolved' || event.type === 'permission-cancel') pane.pending.delete(event.requestId)
    }
    this.panes.set(identity.paneId, pane)
  }

  forget(paneId: string): void { this.panes.delete(paneId) }

  observe(paneId: string, event: SessionEvent, at = new Date().toISOString()): boolean {
    const pane = this.panes.get(paneId)
    if (!pane) return false
    let changed = true
    const clearTurnPending = (): void => {
      for (const [id, pending] of pane.pending) if (pending.kind !== 'plan-proposal') pane.pending.delete(id)
    }
    switch (event.type) {
      case 'turn-started': pane.state = 'working'; break
      case 'ready':
        if (pane.state !== 'starting') return false
        pane.state = 'idle'; break
      case 'thinking': case 'delta': case 'text': case 'tool': case 'tool-result':
        if (terminal(pane.state)) return false
        pane.state = 'working'; break
      case 'permission': case 'question': case 'plan-review': case 'plan-proposal':
        if (terminal(pane.state) && event.type !== 'plan-proposal') return false
        pane.pending.set(event.requestId, {
          kind: event.type,
          blocking: event.type !== 'plan-proposal' && (event.type !== 'question' || event.blocking !== false)
        }); break
      case 'interaction-resolved': case 'permission-cancel':
        changed = pane.pending.delete(event.requestId); break
      case 'result':
        clearTurnPending()
        pane.state = event.interrupted || event.outcome === 'cancelled' ? 'interrupted'
          : event.isError || event.outcome === 'failed' ? 'error'
            : event.continues ? 'working' : 'turn_finished'
        break
      case 'command-completed':
        // Slash routing emits turn-started even for a local command. Its
        // completion must close that spinner without cancelling interactions.
        pane.state = event.continues ? 'working' : event.isError ? 'error' : 'turn_finished'
        break
      case 'turn-continuation':
        if (terminal(pane.state)) return false
        pane.state = event.continues ? 'working' : 'turn_finished'
        if (!event.continues) clearTurnPending()
        break
      case 'fatal': clearTurnPending(); pane.state = 'error'; break
      case 'closed':
        if (terminal(pane.state)) return false
        clearTurnPending()
        pane.state = event.code !== null && event.code !== 0 ? 'error'
          : pane.state === 'working' ? 'interrupted' : 'idle'
        break
      case 'conversation-cleared': pane.pending.clear(); pane.state = 'idle'; break
      default: return false
    }
    if (changed) pane.activityAt = at
    return changed
  }

  snapshot(): GuiProgressInput[] {
    return [...this.panes.values()].map((pane) => {
      const pending = [...pane.pending.values()].sort((a, b) =>
        Number(b.blocking) - Number(a.blocking) || PENDING_ORDER[a.kind] - PENDING_ORDER[b.kind])
      return {
        paneId: pane.paneId, projectId: pane.projectId,
        state: pending.some((item) => item.blocking) ? 'waiting_user' : pane.state,
        pendingCount: pending.length,
        ...(pending[0] ? { pendingKind: pending[0].kind } : {}),
        ...(pane.activityAt ? { activityAt: pane.activityAt } : {})
      }
    })
  }
}

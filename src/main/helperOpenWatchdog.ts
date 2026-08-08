export type HelperOpenWatchdogAction = 'retry' | 'expire'

type Entry = {
  attemptedAt: number
  retries: number
}

/**
 * Tracks helpers that were armed but have not acknowledged startup by
 * creating a PTY. The renderer notification is intentionally best-effort, so
 * state — not delivery — decides whether the helper exists.
 */
export class HelperOpenWatchdog {
  private readonly entries = new Map<string, Entry>()

  arm(paneId: string, now = Date.now()): void {
    this.entries.set(paneId, { attemptedAt: now, retries: 0 })
  }

  acknowledge(paneId: string): void {
    this.entries.delete(paneId)
  }

  has(paneId: string): boolean {
    return this.entries.has(paneId)
  }

  due(
    now: number,
    graceMs: number
  ): Array<{ paneId: string; action: HelperOpenWatchdogAction }> {
    const actions: Array<{ paneId: string; action: HelperOpenWatchdogAction }> = []
    for (const [paneId, entry] of this.entries) {
      if (now - entry.attemptedAt < graceMs) continue
      if (entry.retries === 0) {
        entry.retries = 1
        entry.attemptedAt = now
        actions.push({ paneId, action: 'retry' })
      } else {
        this.entries.delete(paneId)
        actions.push({ paneId, action: 'expire' })
      }
    }
    return actions
  }
}

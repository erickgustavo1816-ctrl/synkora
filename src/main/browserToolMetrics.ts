/** Metadata only: never collect arguments, URLs, DOM, screenshots or page text. */
import { randomUUID } from 'node:crypto'
import type { PaneIdentity } from './hub'
import type { BrowserDriverLog } from './browserDriver'
import type { BrowserTarget, GuiBrowserToolkit } from './guiBrowserTools'

interface BrowserToolResultMetadata {
  text: string
  ok?: boolean
  image?: unknown
  images?: unknown[]
  artifact?: { width: number; height: number }
}

export function instrumentBrowserToolkit(
  toolkit: GuiBrowserToolkit,
  targetOf: (id: PaneIdentity) => BrowserTarget | undefined,
  log: BrowserDriverLog
): GuiBrowserToolkit {
  const pending = new Map<string, Promise<void>>()
  const track = async <T extends string | BrowserToolResultMetadata>(
    operation: string,
    id: PaneIdentity,
    run: () => Promise<T>
  ): Promise<T> => {
    const started = Date.now()
    const callId = randomUUID()
    const target = targetOf(id)
    const key = id.paneId ?? target?.owner.paneId ?? target?.missionId ?? 'unbound'
    const previous = pending.get(key)
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    pending.set(key, current)
    // One identity's deterministic recipe must not interleave with another MCP
    // call from that same identity. Owner gestures remain outside this queue.
    if (previous) await previous
    let result: T | undefined
    try {
      result = await run()
      return result
    } finally {
      release()
      if (pending.get(key) === current) pending.delete(key)
      const metadata = typeof result === 'object' ? result : undefined
      // A telemetry sink must never turn a successful browser operation into a failure.
      try {
        log({
          event: 'browser-tool-result',
          ids: { paneId: id.paneId, missionId: target?.missionId, projectId: target?.projectId },
          detail: {
            callId,
            operation,
            durationMs: Math.max(0, Date.now() - started),
            resultCharacters: typeof result === 'string' ? result.length : metadata?.text.length ?? 0,
            modelImages: (metadata?.image ? 1 : 0) + (metadata?.images?.length ?? 0),
            ...(metadata?.artifact ? { imageWidth: metadata.artifact.width, imageHeight: metadata.artifact.height } : {}),
            outcome: result === undefined ? 'exception' : metadata?.ok === false ? 'failed' : 'returned'
          }
        })
      } catch { /* diagnostics are best effort */ }
    }
  }
  return {
    open: (id, input) => track('browser_open', id, () => toolkit.open(id, input)),
    read: (id, input) => track('browser_read', id, () => toolkit.read(id, input)),
    find: (id, input) => track('browser_find', id, () => toolkit.find(id, input)),
    act: (id, input) => track('browser_act', id, () => toolkit.act(id, input)),
    check: (id, input) => track('browser_check', id, () => toolkit.check(id, input)),
    probe: (id, input) => track('browser_probe', id, () => toolkit.probe(id, input)),
    shot: (id, input) => track('browser_shot', id, () => toolkit.shot(id, input)),
    viewport: (id, input) => track('browser_viewport', id, () => toolkit.viewport(id, input)),
    console: (id, input) => track('browser_console', id, () => toolkit.console(id, input)),
    network: (id, input) => track('browser_network', id, () => toolkit.network(id, input)),
    evaluate: (id, input) => track('browser_eval', id, () => toolkit.evaluate(id, input)),
    wait: (id, input) => track('browser_wait', id, () => toolkit.wait(id, input))
  }
}

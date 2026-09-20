import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import type { BrowserElementSnapshot } from './guiBrowserReferenceTypes'
import { BROWSER_REFERENCE_TOP_VIEWPORT } from './browserReferenceSnapshot'
import { browserReferenceDevtoolsScript } from './browserReferenceDevtools'

export type BrowserReferenceReceiver = (snapshot: BrowserElementSnapshot) => { ok: boolean; error?: string }
export interface BrowserReferencePickerDeps {
  /** Called before any async DOM reads; the receiver keeps the destination of this click. */
  prepare(): BrowserReferenceReceiver | undefined
  onError(message: string): void
  onCaptured?(): void
  onReady?(): void
}

const CAPTURE_FAILED = 'Não consegui guardar esse elemento. Selecione-o novamente e clique em Referenciar no chat.'
const BRIDGE_FAILED = 'Não consegui conectar as DevTools ao chat. Feche e abra as DevTools para tentar novamente.'
const NO_CHAT = 'Abra o chat desta missão e clique em Referenciar no chat para criar a referência.'
const MAX_PENDING = 20

/**
 * Native DevTools has its own CDP session. The agent's page debugger never
 * receives that session's selection events. This adapter runs only in the
 * trusted DevTools frontend and captures on the explicit native toolbar action.
 * The inspected website receives neither a binding nor a preload bridge.
 */
interface PendingCapture {
  receive: BrowserReferenceReceiver
  generation: number
  capturedAt: string
  top: Promise<{ url: string; viewport: BrowserElementSnapshot['viewport'] }>
  timer: ReturnType<typeof setTimeout>
  snapshot?: BrowserElementSnapshot
  failed?: boolean
}

export function installBrowserReferencePicker(page: WebContents, deps: BrowserReferencePickerDeps): () => void {
  let disposed = false
  let generation = 0
  let cleanFrontend: (() => void) | undefined
  let opening = 0
  const navigated = (): void => { generation++ }
  const closed = (): void => { opening++; cleanFrontend?.(); cleanFrontend = undefined }
  const opened = async (): Promise<void> => {
    closed()
    const expectedOpen = opening
    const frontend = page.devToolsWebContents
    if (!frontend || frontend.isDestroyed() || disposed) return
    const debuggerApi = frontend.debugger
    // A debugger attached by somebody else is never borrowed or detached.
    if (debuggerApi.isAttached()) { deps.onError(BRIDGE_FAILED); return }
    const binding = 'synkoraReference_' + randomBytes(16).toString('hex')
    const key = binding + '_state'
    const contexts = new Set<number>()
    const pending = new Map<string, PendingCapture>()
    let live = true
    let ownsDebugger = false
    let installed = false
    const feedback = (id: string, ok: boolean, message?: string): void => {
      if (!live || frontend.isDestroyed()) return
      void frontend.executeJavaScript(
        `globalThis[${JSON.stringify(key)}]?.complete(${JSON.stringify(id)},${ok},${JSON.stringify(message ?? '')})`
      ).catch(() => {})
    }
    const flush = (): void => {
      for (const [id, entry] of pending) {
        if (!entry.failed && !entry.snapshot) break
        clearTimeout(entry.timer)
        pending.delete(id)
        if (!live || disposed) continue
        if (entry.failed || entry.generation !== generation || page.isDestroyed()) {
          feedback(id, false, CAPTURE_FAILED)
          deps.onError(CAPTURE_FAILED)
        } else {
          try {
            const result = entry.receive(entry.snapshot!)
            feedback(id, result.ok, result.error || (!result.ok ? CAPTURE_FAILED : undefined))
            if (!result.ok) deps.onError(result.error || CAPTURE_FAILED)
            else deps.onCaptured?.()
          } catch { feedback(id, false, CAPTURE_FAILED); deps.onError(CAPTURE_FAILED) }
        }
      }
    }
    const fail = (id: string): void => {
      const entry = pending.get(id)
      if (entry) { entry.failed = true; flush() }
    }
    const message = (_event: unknown, method: string, params: Record<string, unknown>): void => {
      if (!live || disposed) return
      if (method === 'Runtime.executionContextCreated') {
        const context = params.context as { id?: number; origin?: string; auxData?: { isDefault?: boolean } } | undefined
        if (context?.origin === 'devtools://devtools' && context.auxData?.isDefault && typeof context.id === 'number') contexts.add(context.id)
        return
      }
      if (method === 'Runtime.executionContextDestroyed') { contexts.delete(Number(params.executionContextId)); return }
      if (method === 'Runtime.executionContextsCleared') {
        contexts.clear()
        if (installed) { cleanup(); deps.onError(BRIDGE_FAILED) }
        return
      }
      if (method !== 'Runtime.bindingCalled' || params.name !== binding || !contexts.has(Number(params.executionContextId))) return
      if (typeof params.payload !== 'string' || params.payload.length > 100_000) return
      let event: Record<string, unknown>
      try { event = JSON.parse(params.payload) } catch { return }
      if (!event || typeof event.id !== 'string' || !/^\d{1,10}$/.test(event.id)) return
      const id = event.id
      if (event.type === 'start') {
        if (pending.has(id) || !Number.isSafeInteger(event.backendNodeId) || Number(event.backendNodeId) <= 0) return
        if (pending.size >= MAX_PENDING) { feedback(id, false, CAPTURE_FAILED); deps.onError(CAPTURE_FAILED); return }
        let receive: BrowserReferenceReceiver | undefined
        try { receive = deps.prepare() } catch { feedback(id, false, CAPTURE_FAILED); deps.onError(CAPTURE_FAILED); return }
        if (!receive) { feedback(id, false, NO_CHAT); deps.onError(NO_CHAT); return }
        // Freeze top viewport and chat now, not when the DOM resolve completes.
        let top: PendingCapture['top']
        try { top = page.executeJavaScript(BROWSER_REFERENCE_TOP_VIEWPORT) as PendingCapture['top'] }
        catch { feedback(id, false, CAPTURE_FAILED); deps.onError(CAPTURE_FAILED); return }
        void top.catch(() => fail(id))
        const timer = setTimeout(() => fail(id), 5000)
        timer.unref?.()
        pending.set(id, { receive, top, timer, capturedAt: new Date().toISOString(), generation })
        return
      }
      const entry = pending.get(id)
      if (!entry) return
      if (event.type === 'error') { fail(id); return }
      if (event.type !== 'snapshot' || !event.value || typeof event.value !== 'object') { fail(id); return }
      const value = event.value as {
        frameUrl: string; frameViewport: BrowserElementSnapshot['viewport']; topFrame: boolean
        element: BrowserElementSnapshot['element']; targetToken?: string
      }
      void entry.top.then(top => {
        if (!live || !pending.has(id)) return
        entry.snapshot = {
          capturedAt: entry.capturedAt, url: top.url, frameUrl: value.frameUrl,
          viewport: value.topFrame ? value.frameViewport : top.viewport,
          ...(!value.topFrame ? { frameViewport: value.frameViewport } : {}),
          element: value.element, backendNodeId: Number(event.backendNodeId), frameId: String(event.frameId ?? ''),
          ...(value.targetToken === undefined ? {} : { targetToken: value.targetToken })
        }
        flush()
      }).catch(() => fail(id))
    }
    const detached = (_event: unknown, reason: string): void => {
      // Owned frontends emit this before devtools-closed during normal teardown.
      if (reason !== 'target closed' && live && !disposed && !page.isDestroyed() &&
          page.devToolsWebContents === frontend) deps.onError(BRIDGE_FAILED)
      cleanup()
    }
    const cleanup = (): void => {
      if (!live) return
      live = false
      for (const entry of pending.values()) clearTimeout(entry.timer)
      pending.clear()
      debuggerApi.off('message', message)
      debuggerApi.off('detach', detached)
      if (!frontend.isDestroyed()) {
        void frontend.executeJavaScript(`globalThis[${JSON.stringify(key)}]?.dispose()`).catch(() => {})
        if (ownsDebugger && debuggerApi.isAttached()) debuggerApi.detach()
      }
    }
    cleanFrontend = cleanup
    try {
      debuggerApi.attach('1.3')
      ownsDebugger = true
      debuggerApi.on('message', message)
      debuggerApi.on('detach', detached)
      await debuggerApi.sendCommand('Runtime.enable')
      await debuggerApi.sendCommand('Runtime.addBinding', { name: binding })
      if (!live || disposed || expectedOpen !== opening) return
      await frontend.executeJavaScript(browserReferenceDevtoolsScript(binding, key))
      if (live && !disposed) { installed = true; deps.onReady?.() }
    } catch {
      cleanup()
      if (!disposed && expectedOpen === opening) deps.onError(BRIDGE_FAILED)
    }
  }
  const onOpened = (): void => { void opened() }
  page.on('devtools-opened', onOpened)
  page.on('devtools-closed', closed)
  page.on('did-navigate', navigated)
  page.on('render-process-gone', navigated)
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    closed()
    page.off('devtools-opened', onOpened)
    page.off('devtools-closed', closed)
    page.off('did-navigate', navigated)
    page.off('render-process-gone', navigated)
    page.off('destroyed', dispose)
  }
  page.on('destroyed', dispose)
  if (page.isDevToolsOpened()) onOpened()
  return dispose
}

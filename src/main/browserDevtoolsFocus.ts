import type { WebContents } from 'electron'

const pendingOpenings = new WeakMap<WebContents, () => void>()

/** A user gesture opens detached DevTools and finishes with their frontend
 * focused. Defer until the native open stack unwinds: its intermediate focus
 * changes must not leave the inspected page's window in front on Windows. */
export function toggleBrowserDevtools(page: WebContents): void {
  pendingOpenings.get(page)?.()
  if (page.isDevToolsOpened()) {
    page.closeDevTools()
    return
  }

  let pending: ReturnType<typeof setImmediate> | undefined
  let cancelled = false
  const cancel = (): void => {
    if (cancelled) return
    cancelled = true
    if (pending) clearImmediate(pending)
    page.off('devtools-opened', opened)
    page.off('devtools-closed', cancel)
    page.off('destroyed', cancel)
    pendingOpenings.delete(page)
  }
  const opened = (): void => {
    if (cancelled) return
    const frontend = page.devToolsWebContents
    pending = setImmediate(() => {
      cancel()
      // Closing/reopening or destroying a tab invalidates this opening.
      if (page.isDestroyed() || !frontend || frontend.isDestroyed() ||
          page.devToolsWebContents !== frontend) return
      frontend.focus()
    })
  }
  pendingOpenings.set(page, cancel)
  page.once('devtools-opened', opened)
  page.once('devtools-closed', cancel)
  page.once('destroyed', cancel)
  try {
    // Docking would change the page geometry used by captures and references.
    page.openDevTools({ mode: 'detach', activate: true })
  } catch (error) {
    cancel()
    throw error
  }
}

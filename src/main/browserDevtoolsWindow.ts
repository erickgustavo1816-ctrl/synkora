import { BrowserWindow, type WebContents } from 'electron'

interface InspectorWindow {
  close(): void
}

const inspectors = new WeakMap<WebContents, InspectorWindow>()

/** A non-modal owned window stays above its browser host even when that host
 * regains focus. Chromium's default detached window has no such relationship. */
export function toggleBrowserDevtoolsWindow(page: WebContents, owner: BrowserWindow): void {
  const existing = inspectors.get(page)
  if (existing) { existing.close(); return }
  if (page.isDestroyed() || owner.isDestroyed()) return
  if (page.isDevToolsOpened()) { page.closeDevTools(); return }

  const inspector = new BrowserWindow({
    parent: owner, modal: false, show: false,
    width: 960, height: 720, minWidth: 320, minHeight: 240,
    title: 'DevTools · Synkora', autoHideMenuBar: true,
    backgroundColor: '#ffffff', alwaysOnTop: false,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      devTools: false, backgroundThrottling: false
    }
  })
  inspector.setMenu(null)
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    inspectors.delete(page)
    page.off('devtools-opened', opened)
    page.off('devtools-closed', close)
    page.off('destroyed', close)
    inspector.off('closed', close)
    if (!page.isDestroyed()) page.closeDevTools()
    if (!inspector.isDestroyed()) inspector.destroy()
  }
  const opened = (): void => {
    if (closed || page.isDestroyed() || owner.isDestroyed() || inspector.isDestroyed()) return
    inspector.show()
    inspector.focus()
  }
  inspectors.set(page, { close })
  page.once('devtools-opened', opened)
  page.once('devtools-closed', close)
  page.once('destroyed', close)
  inspector.once('closed', close)
  try {
    page.setDevToolsWebContents(inspector.webContents)
    page.openDevTools({ mode: 'detach', activate: true })
  } catch (error) {
    close()
    throw error
  }
}

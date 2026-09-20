import { BrowserWindow, screen, type WebContentsView } from 'electron'
import type { BrowserViewHandle } from './browserPaneHost'
import { BROWSER_DEFAULT_VIEW_SIZE, type BrowserPanelRect } from './browserPaneContracts'

interface NativeSurface {
  attach(window: BrowserWindow): void
  detach(): void
  ownerWindow(): BrowserWindow | null
  renderWindow(): BrowserWindow | null
}
const surfaces = new WeakMap<BrowserViewHandle, NativeSurface>()

/** One rendering host for ALL background tabs. A never-painted hidden native
 * view can stay at innerWidth=0 and reject pointer input on Windows. Keep it
 * composing in this transparent, unfocusable, mouse-transparent host instead.
 * This host has no browser chrome and never appears in the taskbar. */
export function createBrowserBackgroundSurface(ownerWindow: () => BrowserWindow | null): {
  wrap(view: WebContentsView): BrowserViewHandle
} {
  let background: BrowserWindow | null = null
  const live = new Set<WebContentsView>()
  const host = (): BrowserWindow => {
    if (background && !background.isDestroyed()) return background
    const owner = ownerWindow()
    const area = owner && !owner.isDestroyed()
      ? screen.getDisplayMatching(owner.getBounds()).workArea
      : screen.getPrimaryDisplay().workArea
    const created = new BrowserWindow({
      x: area.x, y: area.y, width: 16, height: 16,
      show: false, frame: false, transparent: true, opacity: 0,
      skipTaskbar: true, focusable: false, resizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false }
    })
    background = created
    created.setIgnoreMouseEvents(true)
    created.showInactive()
    created.once('closed', () => { if (background === created) background = null })
    return created
  }

  return {
    wrap(view) {
      let foreground: BrowserWindow | null = null
      let parent: BrowserWindow | null = null
      let visible = false
      let rect: BrowserPanelRect = { x: 0, y: 0, ...BROWSER_DEFAULT_VIEW_SIZE }
      live.add(view)
      const apply = (): void => {
        if (!foreground || foreground.isDestroyed() || view.webContents.isDestroyed()) return
        const target = visible ? foreground : host()
        view.setBounds(visible ? rect : { ...rect, x: 0, y: 0 })
        // Reparent in one step, never detach a live rendering surface.
        if (parent !== target) {
          target.contentView.addChildView(view)
          parent = target
        }
        view.setVisible(true)
      }
      const handle: BrowserViewHandle = {
        webContents: view.webContents,
        setBounds(value) { rect = value; apply() },
        setVisible(value) { visible = value; apply() },
        getVisible: () => visible
      }
      surfaces.set(handle, {
        ownerWindow: () => foreground,
        renderWindow: () => parent && !parent.isDestroyed() &&
          !view.webContents.isDestroyed() && parent.contentView.children.includes(view) ? parent : null,
        attach(window) { foreground = window; apply() },
        detach() {
          foreground = null
          if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view)
          parent = null
        }
      })
      view.webContents.once('destroyed', () => {
        live.delete(view)
        surfaces.delete(handle)
        if (live.size === 0 && background && !background.isDestroyed()) {
          background.destroy()
          background = null
        }
      })
      return handle
    }
  }
}

/** The logical host, including while the page renders in the hidden carrier. */
export function browserSurfaceOwner(view: BrowserViewHandle): BrowserWindow | null {
  return surfaces.get(view)?.ownerWindow() ?? null
}

/** Native membership is authoritative; fromWebContents can retain the old
 * window after removal. Undefined preserves compatibility with unwrapped views. */
export function browserSurfaceWindow(view: BrowserViewHandle): BrowserWindow | null | undefined {
  return surfaces.get(view)?.renderWindow()
}

/** Dock and pop-out use the same adapter, so logical visibility and the
 * single background host survive a change of presentation window. */
export function attachBrowserSurface(window: BrowserWindow, view: BrowserViewHandle): void {
  const surface = surfaces.get(view)
  if (surface) surface.attach(window)
  else window.contentView.addChildView(view as unknown as WebContentsView)
}

export function detachBrowserSurface(window: BrowserWindow, view: BrowserViewHandle): void {
  const surface = surfaces.get(view)
  if (surface) surface.detach()
  else window.contentView.removeChildView(view as unknown as WebContentsView)
}

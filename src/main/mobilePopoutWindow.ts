/** Native windows carry immutable bindings; URL parameters never grant authority. */
import { BrowserWindow, screen, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron'
import type { MobilePhoneGeometry, MobilePhoneGeometryResult } from '../shared/mobileSimulator'
import type { MobilePhoneBinding, MobilePhoneWindow, MobileSurface } from './mobilePresentation'

export interface MobilePopoutWindowDeps {
  preloadFile: string
  rendererUrl(windowId: string): string
  trustedUrl(url: string, windowId: string): boolean
  ownerBounds(): Rectangle | undefined
  binding(windowId: string): MobilePhoneBinding | undefined
  onDock(windowId: string): void
  onVisibility(windowId: string): void
  onInvalidated(sender: object): void
}
interface PhoneRecord {
  binding: MobilePhoneBinding
  window: BrowserWindow
  contents: WebContents
  url: string
  retired: boolean
}
const validBinding = (binding: MobilePhoneBinding): boolean => /^[a-f0-9-]{36}$/u.test(binding.windowId) &&
  [binding.missionId, binding.projectId, binding.sessionId].every(value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(value)) &&
  ['android', 'ios'].includes(binding.platform)

/** Nonresizable transparent windows use validated programmatic content sizing.
 * No persistent browser session, Node, general preload API, or native parent. */
export class MobilePopoutWindows {
  private readonly records = new Map<string, PhoneRecord>()
  constructor(private readonly deps: MobilePopoutWindowDeps) {}

  create(binding: MobilePhoneBinding): MobilePhoneWindow {
    if (!validBinding(binding) || this.records.has(binding.windowId) || !this.sameBinding(binding)) throw new Error('Mobile phone binding unavailable')
    const url = this.deps.rendererUrl(binding.windowId)
    if (!this.deps.trustedUrl(url, binding.windowId)) throw new Error('Mobile phone renderer unavailable')
    const anchor = this.deps.ownerBounds() ?? { x: 0, y: 0, width: 380, height: 800 }
    const area = screen.getDisplayMatching(anchor).workArea
    const width = Math.min(380, area.width), height = Math.min(860, area.height)
    const window = new BrowserWindow({
      x: Math.round(Math.max(area.x, Math.min(anchor.x + anchor.width - width, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(anchor.y, area.y + area.height - height))),
      width, height, useContentSize: true, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', title: binding.platform === 'ios' ? 'iPhone — Synkora' : 'Android — Synkora',
      resizable: false, maximizable: false, fullscreenable: false, hasShadow: false, alwaysOnTop: true,
      webPreferences: {
        preload: this.deps.preloadFile, additionalArguments: ['--mobile-phone'],
        partition: `mobile-phone-${binding.windowId}`, contextIsolation: true, sandbox: true,
        nodeIntegration: false, webSecurity: true, backgroundThrottling: false
      }
    })
    const record: PhoneRecord = { binding: Object.freeze({ ...binding }), window, contents: window.webContents, url, retired: false }
    this.records.set(binding.windowId, record)
    // The detached phone floats above every other window (Windows and macOS)
    // even when the owner or another app takes focus; 'floating' keeps the
    // macOS level above normal windows without stealing key status.
    window.setAlwaysOnTop(true, 'floating')
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.session.setPermissionCheckHandler(() => false)
    contents.on('will-navigate', event => event.preventDefault())
    contents.on('will-redirect', event => event.preventDefault())
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.deps.onInvalidated(contents)
    })
    contents.on('render-process-gone', () => this.lost(record))
    window.on('close', event => {
      if (record.retired) return
      event.preventDefault()
      this.deps.onDock(binding.windowId)
    })
    window.on('closed', () => this.lost(record))
    const visibility = (): void => {
      if (this.registered(record)) this.deps.onVisibility(binding.windowId)
    }
    window.on('minimize', visibility); window.on('restore', visibility)
    window.on('show', visibility); window.on('hide', visibility)
    // Moving to another display invalidates the old monitor estimate; the
    // renderer asks again and the reader verifies the requesting window.
    window.on('move', () => { if (this.registered(record)) this.notify(record) })
    let loadTimer: ReturnType<typeof setTimeout> | undefined
    const ready = Promise.race([
      window.loadURL(url),
      new Promise<never>((_resolve, reject) => { loadTimer = setTimeout(() => reject(new Error('Mobile phone load timed out')), 15_000) })
    ]).then(() => {
      if (!this.registered(record)) throw new Error('Mobile phone closed during load')
    }).catch(() => { this.destroy(record); throw new Error('Mobile phone renderer unavailable') })
      .finally(() => { if (loadTimer) clearTimeout(loadTimer) })
    // The caller owns the handle before navigation finishes; even failed or
    // hanging page loads can be destroyed synchronously during mission cleanup.
    return {
        ready,
        focus: () => {
          if (!this.registered(record)) return
          if (window.isMinimized()) window.restore()
          window.show(); window.focus()
        },
        destroy: () => this.destroy(record),
        resize: geometry => this.resize(record, geometry),
        notify: () => this.notify(record)
    }
  }
  resolve(event: IpcMainInvokeEvent | IpcMainEvent): { binding: MobilePhoneBinding; surface: MobileSurface; window: BrowserWindow } {
    const record = [...this.records.values()].find(value => value.contents === event.sender)
    if (!record || !this.trusted(record, event.senderFrame)) throw new Error('Mobile phone sender unavailable')
    const frame = event.senderFrame!
    return { binding: record.binding, window: record.window, surface: {
      kind: 'phone', windowId: record.binding.windowId, sender: event.sender, frame,
      current: () => this.trusted(record, frame),
      visible: () => this.registered(record) && record.window.isVisible() && !record.window.isMinimized(),
      send: (channel, payload) => { if (this.trusted(record, frame)) event.sender.send(channel, payload) }
    } }
  }
  /** One-way notice to every live, trusted phone window (no payload). */
  broadcast(channel: string): void {
    for (const record of this.records.values()) {
      if (this.registered(record) && this.trusted(record, record.contents.mainFrame)) record.contents.send(channel)
    }
  }
  private registered(record: PhoneRecord): boolean {
    return !record.retired && this.records.get(record.binding.windowId) === record && !record.window.isDestroyed() &&
      !record.contents.isDestroyed() && this.sameBinding(record.binding)
  }
  private sameBinding(binding: MobilePhoneBinding): boolean {
    const current = this.deps.binding(binding.windowId)
    return Boolean(current && current.windowId === binding.windowId && current.missionId === binding.missionId &&
      current.projectId === binding.projectId && current.sessionId === binding.sessionId && current.platform === binding.platform)
  }
  private trusted(record: PhoneRecord, frame: IpcMainInvokeEvent['senderFrame']): boolean {
    return this.registered(record) && Boolean(frame && frame === record.contents.mainFrame && frame.url === record.url &&
      this.deps.trustedUrl(frame.url, record.binding.windowId))
  }
  private notify(record: PhoneRecord): void {
    if (this.registered(record) && this.trusted(record, record.contents.mainFrame)) record.contents.send('mobile:phone:changed')
  }
  private resize(record: PhoneRecord, geometry: MobilePhoneGeometry): MobilePhoneGeometryResult {
    if (!this.registered(record) || ![geometry.width, geometry.height].every(value => Number.isInteger(value) && value >= 100 && value <= 8192)) throw new Error('Mobile phone geometry unavailable')
    const window = record.window, before = window.getBounds(), area = screen.getDisplayMatching(before).workArea
    const width = Math.min(geometry.width, area.width), height = Math.min(geometry.height, area.height)
    window.setContentSize(width, height)
    const bounds = window.getBounds()
    window.setPosition(Math.round(Math.max(area.x, Math.min(before.x, area.x + area.width - bounds.width))),
      Math.round(Math.max(area.y, Math.min(before.y, area.y + area.height - bounds.height))))
    const [actualWidth, actualHeight] = window.getContentSize()
    return { width: actualWidth, height: actualHeight, clamped: actualWidth !== geometry.width || actualHeight !== geometry.height }
  }
  private lost(record: PhoneRecord): void {
    if (record.retired) return
    record.retired = true; this.records.delete(record.binding.windowId)
    this.deps.onInvalidated(record.contents)
    this.deps.onDock(record.binding.windowId)
    if (!record.window.isDestroyed()) record.window.destroy()
  }
  private destroy(record: PhoneRecord): void {
    if (!record.retired) {
      record.retired = true; this.records.delete(record.binding.windowId)
      this.deps.onInvalidated(record.contents)
    }
    if (!record.window.isDestroyed()) record.window.destroy()
  }
}

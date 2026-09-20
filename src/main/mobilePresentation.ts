/** Presentation leases never confer native-device ownership or agent authority. */
import { randomUUID } from 'node:crypto'
import type {
  MobileAction, MobileFrame, MobilePhoneDescriptor, MobilePhoneGeometry, MobilePhoneGeometryResult,
  MobilePlatform, MobilePointerInput, MobilePresentation, MobileResult, MobileSession, MobileState,
  MobileVideoPacket, MobileViewLease
} from '../shared/mobileSimulator'

export interface MobileSurface {
  kind: 'dock' | 'phone'
  sender: object
  frame: object
  windowId?: string
  current(): boolean
  visible(): boolean
  send(channel: string, payload: unknown): void
}
export interface MobilePhoneBinding {
  readonly windowId: string
  readonly missionId: string
  readonly projectId: string
  readonly sessionId: string
  readonly platform: MobilePlatform
}
export interface MobilePhoneWindow {
  ready: Promise<void>
  focus(): void
  destroy(): void
  resize(geometry: MobilePhoneGeometry): MobilePhoneGeometryResult
  notify(): void
}
export interface MobilePresentationDeps {
  resolveScope(missionId: string): { projectId: string; rootPath: string } | null
  snapshot(missionId: string, sessionId: string): MobileResult<MobileSession>
  video: {
    closeSession(missionId: string, sessionId: string): Promise<void>
    setVisible(missionId: string, sessionId: string, visible: boolean): Promise<MobileResult>
    acknowledge(missionId: string, sessionId: string, streamId: string, timestampUs: number): void
  }
  capture(missionId: string, sessionId: string): Promise<MobileResult<MobileFrame>>
  act(missionId: string, sessionId: string, action: MobileAction, signal: AbortSignal): Promise<MobileResult>
  pointer(missionId: string, sessionId: string, input: MobilePointerInput): Promise<MobileResult>
  createWindow(binding: MobilePhoneBinding): MobilePhoneWindow
  onChanged(missionId: string): void
}
interface Consumer {
  id: string
  surface: MobileSurface
  abort: AbortController
  inputAbort: AbortController
  wantsVideo: boolean
  videoEpoch: number
  gesture?: MobilePointerInput
}
interface PresentationEntry {
  missionId: string
  sessionId: string
  projectId: string
  rootPath: string
  session?: MobileSession
  host: 'dock' | string
  epoch: number
  transitioning: boolean
  closed: boolean
  consumer?: Consumer
  window?: MobilePhoneWindow
  barrier: Promise<void>
}
const keyFor = (missionId: string, sessionId: string): string => JSON.stringify([missionId, sessionId])
const ok = <T = undefined>(value?: T): MobileResult<T> => ({ ok: true, value: value as T })
const refused = <T = undefined>(): MobileResult<T> => ({ ok: false, error: 'Esta visualização Mobile foi encerrada ou transferida. Reabra o aparelho na janela ativa e repita a ação.' })
const failed = <T = undefined>(): MobileResult<T> => ({ ok: false, error: 'Não consegui abrir a janela do aparelho. Confira a sessão no painel Mobile e tente novamente.' })
export const isMobileVisualAction = (action: MobileAction): boolean => ['tap', 'swipe', 'text', 'key'].includes(action.type)

/** One host and one opaque consumer per session. Retired producers finish cleanup
 * before another consumer can start. No renderer-provided ID selects a phone. */
export class MobilePresentationManager {
  private readonly entries = new Map<string, PresentationEntry>()
  private readonly windows = new Map<string, PresentationEntry>()
  private readonly closing = new Map<Promise<void>, string>()
  private disposed = false
  constructor(private readonly deps: MobilePresentationDeps) {}

  decorate(state: MobileState): MobileState {
    return { ...state, sessions: state.sessions.map(session => {
      const entry = this.entries.get(keyFor(session.missionId, session.id))
      return { ...session, presentation: entry && this.current(entry) ? this.presentation(entry) : { host: 'dock' as const } }
    }) }
  }
  changed(missionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.missionId !== missionId) continue
      if (!this.current(entry)) { void this.closeEntry(entry); continue }
      try { entry.window?.notify() } catch { /* a closing renderer is not authority */ }
    }
    this.deps.onChanged(missionId)
  }
  binding(windowId: string): MobilePhoneBinding | undefined {
    const entry = this.windows.get(windowId)
    return entry && this.current(entry) && entry.host === windowId && entry.session
      ? this.identity(entry, windowId) : undefined
  }
  async describe(windowId: string): Promise<MobileResult<MobilePhoneDescriptor>> {
    const entry = this.windows.get(windowId)
    if (!entry || !this.current(entry) || entry.host !== windowId) return refused()
    if (!this.refresh(entry)) return refused()
    return ok(this.descriptor(entry, windowId))
  }
  async detach(missionId: string, sessionId: string): Promise<MobileResult<MobilePhoneDescriptor>> {
    const entry = await this.ensure(missionId, sessionId)
    if (!entry || !entry.session || entry.session.state !== 'ready') return refused()
    if (entry.transitioning) return refused()
    if (entry.host !== 'dock' && entry.window) {
      entry.window.focus(); return ok(this.descriptor(entry, entry.host))
    }
    const windowId = randomUUID(), epoch = ++entry.epoch
    entry.transitioning = true
    entry.host = windowId
    this.windows.set(windowId, entry)
    this.retire(entry)
    this.changed(missionId)
    try {
      await entry.barrier
      if (!this.current(entry) || entry.epoch !== epoch) return refused()
      const window = this.deps.createWindow(this.identity(entry, windowId))
      entry.window = window
      this.track(entry, window.ready)
      await window.ready
      if (!this.current(entry) || entry.epoch !== epoch) { window.destroy(); return refused() }
      entry.transitioning = false
      this.changed(missionId)
      window.focus()
      return ok(this.descriptor(entry, windowId))
    } catch {
      if (this.current(entry) && entry.epoch === epoch) {
        this.windows.delete(windowId); entry.window?.destroy(); entry.window = undefined
        entry.host = 'dock'; entry.transitioning = false; ++entry.epoch
        this.changed(missionId)
      }
      return failed()
    }
  }
  async focusDetached(missionId: string, sessionId: string): Promise<MobileResult> {
    const entry = this.entries.get(keyFor(missionId, sessionId))
    if (!entry || !this.current(entry) || entry.transitioning || !entry.window) return refused()
    entry.window.focus(); return ok()
  }
  async dock(missionId: string, sessionId: string): Promise<MobileResult> {
    const entry = this.entries.get(keyFor(missionId, sessionId))
    if (!entry || !this.current(entry)) return refused()
    if (entry.host === 'dock' && !entry.transitioning) return ok()
    const epoch = ++entry.epoch, window = entry.window
    entry.transitioning = true
    this.windows.delete(entry.host)
    entry.host = 'dock'; entry.window = undefined
    this.retire(entry)
    // Membership is gone before destruction or any awaited native cleanup.
    window?.destroy()
    this.changed(missionId)
    await entry.barrier
    if (!this.current(entry) || entry.epoch !== epoch) return refused()
    entry.transitioning = false
    this.changed(missionId)
    return ok()
  }
  dockWindow(windowId: string): Promise<MobileResult> {
    const entry = this.windows.get(windowId)
    return entry ? this.dock(entry.missionId, entry.sessionId) : Promise.resolve(refused())
  }
  resize(windowId: string, geometry: MobilePhoneGeometry): MobileResult<MobilePhoneGeometryResult> {
    const entry = this.windows.get(windowId)
    if (!entry || !this.current(entry) || !entry.window || entry.transitioning ||
      ![geometry.width, geometry.height].every(value => Number.isInteger(value) && value >= 100 && value <= 8192)) return refused()
    try { return ok(entry.window.resize(geometry)) } catch { return failed() }
  }
  async acquireView(surface: MobileSurface, missionId: string, sessionId: string): Promise<MobileResult<MobileViewLease>> {
    if (!this.surfaceCurrent(surface)) return refused()
    const entry = await this.ensure(missionId, sessionId)
    if (!entry || !this.allowedHost(entry, surface) || entry.transitioning) return refused()
    this.retire(entry)
    const consumer: Consumer = { id: randomUUID(), surface, abort: new AbortController(), inputAbort: new AbortController(), wantsVideo: false, videoEpoch: 0 }
    entry.consumer = consumer
    await entry.barrier
    return this.authorized(entry, consumer, surface) ? ok({ consumerId: consumer.id }) : refused()
  }
  async releaseView(surface: MobileSurface, missionId: string, sessionId: string, consumerId: string): Promise<MobileResult> {
    const found = this.claim(surface, missionId, sessionId, consumerId)
    if (!found) return refused()
    this.retire(found.entry)
    await found.entry.barrier
    return ok()
  }
  async setVideoVisible(surface: MobileSurface, missionId: string, sessionId: string, visible: boolean, consumerId: string): Promise<MobileResult> {
    const found = this.claim(surface, missionId, sessionId, consumerId)
    if (!found) return refused()
    found.consumer.wantsVideo = visible
    return this.updateVideo(found.entry, found.consumer)
  }
  async visibilityChanged(windowId: string): Promise<void> {
    const entry = this.windows.get(windowId), consumer = entry?.consumer
    if (!entry || !consumer || !this.authorized(entry, consumer, consumer.surface)) return
    if (!consumer.surface.visible()) { this.cancelGesture(entry, consumer); consumer.inputAbort.abort() }
    else if (consumer.inputAbort.signal.aborted) consumer.inputAbort = new AbortController()
    await this.updateVideo(entry, consumer)
  }
  async surfaceVisibilityChanged(sender: object): Promise<void> {
    await Promise.all([...this.entries.values()].filter(entry => entry.consumer?.surface.sender === sender).map(async entry => {
      const consumer = entry.consumer!
      if (!this.authorized(entry, consumer, consumer.surface)) return
      if (!consumer.surface.visible()) { this.cancelGesture(entry, consumer); consumer.inputAbort.abort() }
      else if (consumer.inputAbort.signal.aborted) consumer.inputAbort = new AbortController()
      await this.updateVideo(entry, consumer)
    }))
  }
  acknowledge(surface: MobileSurface, missionId: string, sessionId: string, streamId: string, timestampUs: number, consumerId: string): void {
    const found = this.claim(surface, missionId, sessionId, consumerId)
    if (found && found.consumer.wantsVideo && surface.visible()) this.deps.video.acknowledge(missionId, sessionId, streamId, timestampUs)
  }
  emit(packet: MobileVideoPacket): void {
    const entry = this.entries.get(keyFor(packet.missionId, packet.sessionId)), consumer = entry?.consumer
    if (!entry || !consumer || !consumer.wantsVideo || !consumer.surface.visible() || !this.authorized(entry, consumer, consumer.surface)) return
    consumer.surface.send(consumer.surface.kind === 'phone' ? 'mobile:phone:video' : 'mobile:video', { ...packet, consumerId: consumer.id })
  }
  async capture(surface: MobileSurface, missionId: string, sessionId: string, consumerId: string): Promise<MobileResult<MobileFrame>> {
    const found = this.claim(surface, missionId, sessionId, consumerId)
    if (!found || !surface.visible()) return refused()
    const result = await this.deps.capture(missionId, sessionId)
    return this.authorized(found.entry, found.consumer, surface) && surface.visible() ? result : refused()
  }
  async act(surface: MobileSurface, missionId: string, sessionId: string, action: MobileAction, consumerId: string): Promise<MobileResult> {
    const found = this.claim(surface, missionId, sessionId, consumerId)
    if (!found || !isMobileVisualAction(action) || !surface.visible()) return refused()
    this.cancelGesture(found.entry, found.consumer)
    const signal = found.consumer.inputAbort.signal
    const result = await this.deps.act(missionId, sessionId, action, signal)
    return this.authorized(found.entry, found.consumer, surface) && !signal.aborted && surface.visible() ? result : refused()
  }
  async pointer(surface: MobileSurface, missionId: string, sessionId: string, input: MobilePointerInput, consumerId: string): Promise<MobileResult> {
    const found = this.claim(surface, missionId, sessionId, consumerId)
    if (!found || !surface.visible()) return refused()
    const { entry, consumer } = found
    if (input.phase === 'down') {
      if (consumer.gesture) return refused()
      consumer.gesture = input
    } else if (consumer.gesture?.gestureId !== input.gestureId) return refused()
    // Reservation precedes the runtime's first await, so handover can cancel a
    // DOWN that is still waiting behind native FIFO/geometry work.
    const result = await this.deps.pointer(missionId, sessionId, input)
    if (consumer.gesture?.gestureId === input.gestureId && (!result.ok || input.phase === 'up' || input.phase === 'cancel')) consumer.gesture = undefined
    return this.authorized(entry, consumer, surface) ? result : refused()
  }
  invalidateSurface(sender: object): void {
    for (const entry of this.entries.values()) if (entry.consumer?.surface.sender === sender) this.retire(entry)
  }
  closeSession(missionId: string, sessionId: string): Promise<void> {
    const entry = this.entries.get(keyFor(missionId, sessionId))
    return entry ? this.closeEntry(entry) : Promise.resolve()
  }
  async closeMission(missionId: string): Promise<void> {
    const pending = [...this.entries.values()].filter(entry => entry.missionId === missionId).map(entry => this.closeEntry(entry))
    pending.push(...[...this.closing].filter(([, mission]) => mission === missionId).map(([promise]) => promise))
    await Promise.all(pending)
  }
  async closeWindows(): Promise<void> {
    await Promise.all([...this.entries.values()].map(entry => this.closeEntry(entry)))
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.closeWindows()
    await Promise.all([...this.closing.keys()])
  }
  private presentation(entry: PresentationEntry): MobilePresentation {
    return { host: entry.host === 'dock' ? 'dock' : 'detached', ...(entry.host === 'dock' ? {} : { windowId: entry.host }),
      ...(entry.transitioning ? { transitioning: true } : {}) }
  }
  private identity(entry: PresentationEntry, windowId: string): MobilePhoneBinding {
    return Object.freeze({ windowId, missionId: entry.missionId, projectId: entry.projectId, sessionId: entry.sessionId, platform: entry.session!.platform })
  }
  private descriptor(entry: PresentationEntry, windowId: string): MobilePhoneDescriptor {
    return { ...this.identity(entry, windowId), session: { ...entry.session!, presentation: this.presentation(entry) } }
  }
  private surfaceCurrent(surface: MobileSurface): boolean {
    try { return Boolean(surface.sender && surface.frame && surface.current()) } catch { return false }
  }
  private current(entry: PresentationEntry): boolean {
    if (this.disposed || entry.closed || this.entries.get(keyFor(entry.missionId, entry.sessionId)) !== entry) return false
    const scope = this.deps.resolveScope(entry.missionId)
    return Boolean(scope && scope.projectId === entry.projectId && scope.rootPath === entry.rootPath)
  }
  private allowedHost(entry: PresentationEntry, surface: MobileSurface): boolean {
    return this.current(entry) && this.surfaceCurrent(surface) && (entry.host === 'dock'
      ? surface.kind === 'dock' : surface.kind === 'phone' && surface.windowId === entry.host && this.windows.get(entry.host) === entry)
  }
  private authorized(entry: PresentationEntry, consumer: Consumer, surface: MobileSurface): boolean {
    return entry.consumer === consumer && !consumer.abort.signal.aborted && !entry.transitioning && this.allowedHost(entry, surface) &&
      consumer.surface.sender === surface.sender && consumer.surface.frame === surface.frame && consumer.surface.kind === surface.kind && consumer.surface.windowId === surface.windowId
  }
  private claim(surface: MobileSurface, missionId: string, sessionId: string, consumerId: string): { entry: PresentationEntry; consumer: Consumer } | undefined {
    const entry = this.entries.get(keyFor(missionId, sessionId)), consumer = entry?.consumer
    return entry && consumer && consumer.id === consumerId && this.authorized(entry, consumer, surface) ? { entry, consumer } : undefined
  }
  private async ensure(missionId: string, sessionId: string): Promise<PresentationEntry | undefined> {
    if (this.disposed || !missionId || !sessionId) return undefined
    const key = keyFor(missionId, sessionId)
    let entry = this.entries.get(key)
    if (entry) {
      if (!this.current(entry)) { void this.closeEntry(entry); return undefined }
      return this.refresh(entry) && entry.session?.state === 'ready' ? entry : undefined
    }
    const scope = this.deps.resolveScope(missionId)
    if (!scope) return undefined
    entry = { missionId, sessionId, ...scope, host: 'dock', epoch: 0, transitioning: false, closed: false, barrier: Promise.resolve() }
    this.entries.set(key, entry)
    if (!this.refresh(entry) || entry.session?.state !== 'ready') { void this.closeEntry(entry); return undefined }
    return entry
  }
  private refresh(entry: PresentationEntry): boolean {
    if (!this.current(entry)) return false
    const result = this.deps.snapshot(entry.missionId, entry.sessionId)
    if (!result.ok || !this.current(entry) || result.value.missionId !== entry.missionId || result.value.id !== entry.sessionId ||
      (entry.session && entry.session.platform !== result.value.platform)) return false
    entry.session = { ...result.value }
    return true
  }
  private cancelGesture(entry: PresentationEntry, consumer: Consumer): Promise<void> {
    const gesture = consumer.gesture
    consumer.gesture = undefined
    if (!gesture) return Promise.resolve()
    try { return this.deps.pointer(entry.missionId, entry.sessionId, { ...gesture, phase: 'cancel' }).then(() => undefined, () => undefined) }
    catch { return Promise.resolve() }
  }
  private track(entry: PresentationEntry, promise: Promise<unknown>): void {
    entry.barrier = Promise.all([entry.barrier, promise.catch(() => undefined)]).then(() => undefined)
    const pending = entry.barrier
    this.closing.set(pending, entry.missionId)
    void pending.finally(() => this.closing.delete(pending))
  }
  private retire(entry: PresentationEntry): void {
    const consumer = entry.consumer
    entry.consumer = undefined
    if (consumer) {
      // Cancel while the runtime authority is intact; abort queued legacy input.
      const cancelled = this.cancelGesture(entry, consumer)
      consumer.abort.abort(); consumer.inputAbort.abort(); ++consumer.videoEpoch
      this.track(entry, cancelled)
    }
    this.track(entry, this.deps.video.closeSession(entry.missionId, entry.sessionId))
  }
  private async updateVideo(entry: PresentationEntry, consumer: Consumer): Promise<MobileResult> {
    const epoch = ++consumer.videoEpoch
    if (!consumer.wantsVideo || !consumer.surface.visible()) {
      this.track(entry, this.deps.video.closeSession(entry.missionId, entry.sessionId))
      await entry.barrier
      return this.authorized(entry, consumer, consumer.surface) ? ok() : refused()
    }
    await entry.barrier
    if (!this.authorized(entry, consumer, consumer.surface) || consumer.videoEpoch !== epoch || !consumer.surface.visible()) return refused()
    const result = await this.deps.video.setVisible(entry.missionId, entry.sessionId, true)
    return this.authorized(entry, consumer, consumer.surface) && consumer.videoEpoch === epoch ? result : refused()
  }
  private closeEntry(entry: PresentationEntry): Promise<void> {
    if (entry.closed) return entry.barrier
    entry.closed = true; ++entry.epoch
    this.entries.delete(keyFor(entry.missionId, entry.sessionId))
    this.windows.delete(entry.host)
    this.retire(entry)
    const window = entry.window; entry.window = undefined
    window?.destroy()
    this.deps.onChanged(entry.missionId)
    return entry.barrier
  }
}

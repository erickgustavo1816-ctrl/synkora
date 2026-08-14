export const GUI_WINDOW_TITLE = 'Synkora'
export const GUI_WINDOW_READY_TITLE = '[pronto] Synkora'
export const GUI_READY_CLEAR_MS = 2_000

type TimerHandle = ReturnType<typeof setTimeout>

export interface GuiWindowReadyDeps {
  setTitle(title: string): void
  isFocused(): boolean
  isPaneActive(paneId: string): boolean
  setTimer(callback: () => void, delayMs: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}

interface ReadyEntry {
  backgrounded: boolean
  generation: number
}

/** Controla o título real do BrowserWindow e mantém prontidões independentes. */
export class GuiWindowReadyController {
  private readonly deps: GuiWindowReadyDeps
  private readonly ready = new Map<string, ReadyEntry>()
  private readonly timers = new Map<string, TimerHandle>()
  private generation = 0

  constructor(deps: GuiWindowReadyDeps) {
    this.deps = deps
  }

  noteFinished(paneId: string): void {
    const backgrounded = !this.deps.isFocused()
    if (!backgrounded && this.deps.isPaneActive(paneId)) return
    this.cancelTimer(paneId)
    this.ready.set(paneId, { backgrounded, generation: ++this.generation })
    this.render()
    this.recheckPane(paneId)
  }

  onWindowFocus(): void {
    for (const paneId of this.ready.keys()) this.recheckPane(paneId)
  }

  onWindowBlur(): void {
    for (const paneId of this.timers.keys()) this.cancelTimer(paneId)
  }

  onPaneActiveChanged(paneId: string): void {
    if (!this.ready.has(paneId)) return
    if (this.deps.isPaneActive(paneId)) this.recheckPane(paneId)
    else this.cancelTimer(paneId)
  }

  dropPane(paneId: string): void {
    this.cancelTimer(paneId)
    if (!this.ready.delete(paneId)) return
    this.render()
  }

  pendingPaneIds(): string[] {
    return [...this.ready.keys()]
  }

  dispose(): void {
    for (const paneId of this.timers.keys()) this.cancelTimer(paneId)
    this.ready.clear()
    this.deps.setTitle(GUI_WINDOW_TITLE)
  }

  private recheckPane(paneId: string): void {
    const entry = this.ready.get(paneId)
    if (!entry || !this.deps.isFocused()) return
    if (!entry.backgrounded && !this.deps.isPaneActive(paneId)) return
    if (this.timers.has(paneId)) return

    const expectedGeneration = entry.generation
    const handle = this.deps.setTimer(() => {
      this.timers.delete(paneId)
      const current = this.ready.get(paneId)
      if (!current || current.generation !== expectedGeneration) return
      if (!this.deps.isFocused()) return
      if (!current.backgrounded && !this.deps.isPaneActive(paneId)) return
      this.ready.delete(paneId)
      this.render()
    }, GUI_READY_CLEAR_MS)
    this.timers.set(paneId, handle)
  }

  private cancelTimer(paneId: string): void {
    const handle = this.timers.get(paneId)
    if (handle === undefined) return
    this.deps.clearTimer(handle)
    this.timers.delete(paneId)
  }

  private render(): void {
    this.deps.setTitle(this.ready.size > 0 ? GUI_WINDOW_READY_TITLE : GUI_WINDOW_TITLE)
  }
}

/** Visibilidade por renderer; panes duplicados só ficam ativos se algum dono estiver ativo. */
export class GuiPaneVisibilityRegistry {
  private readonly bySender = new Map<number, Set<string>>()

  report(senderId: number, paneId: string, active: boolean): void {
    const panes = this.bySender.get(senderId) ?? new Set<string>()
    if (active) panes.add(paneId)
    else panes.delete(paneId)
    if (panes.size > 0) this.bySender.set(senderId, panes)
    else this.bySender.delete(senderId)
  }

  dropSender(senderId: number): string[] {
    const panes = [...(this.bySender.get(senderId) ?? [])]
    this.bySender.delete(senderId)
    return panes
  }

  isActive(paneId: string): boolean {
    for (const panes of this.bySender.values()) {
      if (panes.has(paneId)) return true
    }
    return false
  }
}

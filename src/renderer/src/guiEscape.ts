interface GuiEscapeState {
  working: boolean
  questionOpen: boolean
  menuOpen: boolean
}

interface GuiEscapeEntry {
  paneId: string
  element: HTMLElement
  state: () => GuiEscapeState
  interrupt: () => void | Promise<void>
  dismissMenu: () => void
  lastInterruptAt: number
}

const entries = new Map<string, GuiEscapeEntry>()
let lastInteractedPaneId: string | null = null

export function shouldInterruptGuiOnEscape(key: string, state: GuiEscapeState): boolean {
  return key === 'Escape' && state.working && !state.questionOpen && !state.menuOpen
}

export type GuiEscapeAction = 'none' | 'dismiss-menu' | 'interrupt'

export function guiEscapeAction(key: string, state: GuiEscapeState): GuiEscapeAction {
  if (key !== 'Escape' || state.questionOpen) return 'none'
  if (state.menuOpen) return 'dismiss-menu'
  return state.working ? 'interrupt' : 'none'
}

export function registerGuiEscapeTarget(
  paneId: string,
  element: HTMLElement,
  state: () => GuiEscapeState,
  interrupt: () => void | Promise<void>,
  dismissMenu: () => void
): () => void {
  const entry: GuiEscapeEntry = {
    paneId,
    element,
    state,
    interrupt,
    dismissMenu,
    lastInterruptAt: 0
  }
  entries.set(paneId, entry)
  return () => {
    if (entries.get(paneId) === entry) entries.delete(paneId)
    if (lastInteractedPaneId === paneId) lastInteractedPaneId = null
  }
}

export function noteGuiPaneInteraction(paneId: string): void {
  lastInteractedPaneId = paneId
}

function visible(entry: GuiEscapeEntry): boolean {
  if (!entry.element.isConnected || entry.element.closest('[inert]')) return false
  return entry.element.getClientRects().length > 0
}

function entryFromNode(node: EventTarget | null): GuiEscapeEntry | undefined {
  const element = node instanceof Element ? node.closest<HTMLElement>('[data-gui-pane-id]') : null
  const paneId = element?.dataset.guiPaneId
  return paneId ? entries.get(paneId) : undefined
}

function activeEntry(event?: KeyboardEvent): GuiEscapeEntry | undefined {
  const direct = entryFromNode(event?.target ?? null) ?? entryFromNode(document.activeElement)
  if (direct && visible(direct)) return direct

  const last = lastInteractedPaneId ? entries.get(lastInteractedPaneId) : undefined
  if (last && visible(last)) return last

  const candidates = [...entries.values()].filter(visible)
  if (candidates.length === 1) return candidates[0]
  const working = candidates.filter((candidate) => candidate.state().working)
  return working.length === 1 ? working[0] : undefined
}

/** Modal visível é dono do Esc; interromper o chat atrás dele seria surpresa. */
function hasVisibleEscapeOwner(): boolean {
  return [...document.querySelectorAll<HTMLElement>('.overlay, [role="dialog"]')].some(
    (element) => element.getClientRects().length > 0
  )
}

type DispatchResult = 'handled' | 'deferred' | 'unavailable'

function dispatchGuiEscape(event?: KeyboardEvent): DispatchResult {
  if (hasVisibleEscapeOwner()) return 'deferred'
  const entry = activeEntry(event)
  if (!entry) return 'unavailable'
  const action = guiEscapeAction('Escape', entry.state())
  if (action === 'none') return 'deferred'
  if (action === 'dismiss-menu') {
    entry.dismissMenu()
    return 'handled'
  }
  const now = Date.now()
  if (now - entry.lastInterruptAt < 500) return 'handled'
  entry.lastInterruptAt = now
  void entry.interrupt()
  return 'handled'
}

/** Relay do host para a WebContentsView: usa o mesmo resolvedor local. */
export function requestActiveGuiEscape(): boolean {
  return dispatchGuiEscape() === 'handled'
}

interface GuiEscapeInstallOptions {
  relay?: () => void
  /** WebContentsView compõe por cima do host: quando visível, ela é a dona. */
  preferRelay?: () => boolean
}

/** Um instalador por renderer (host e canvas de panes são processos distintos). */
export function installGlobalGuiEscape(options: GuiEscapeInstallOptions = {}): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key !== 'Escape') return
    if (hasVisibleEscapeOwner()) return
    if (options.relay && options.preferRelay?.()) {
      options.relay()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const result = dispatchGuiEscape(event)
    if (result === 'unavailable') {
      options.relay?.()
      return
    }
    if (result === 'handled') {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}

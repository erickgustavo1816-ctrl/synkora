import type { GuiInterruptOrigin, GuiInterruptTarget } from '../../shared/guiInterrupt'

function interruptTarget(node: EventTarget | null): GuiInterruptTarget {
  if (!(node instanceof Element)) return 'none'
  switch (node.tagName.toLowerCase()) {
    case 'button': return 'button'
    case 'textarea': return 'textarea'
    case 'input': return 'input'
    case 'a': return 'link'
    default: return node instanceof HTMLElement && node.isContentEditable ? 'contenteditable' : 'other'
  }
}

export function captureGuiInterruptOrigin(
  source: 'stop-button' | 'escape',
  event?: Event & { repeat?: boolean }
): GuiInterruptOrigin {
  if (!event) return { source }
  return {
    source,
    ...(event.type === 'click' || event.type === 'keydown' ? { eventType: event.type } : {}),
    isTrusted: event.isTrusted,
    defaultPrevented: event.defaultPrevented,
    ...(typeof event.repeat === 'boolean' ? { repeat: event.repeat } : {}),
    target: interruptTarget(event.target),
    focus: interruptTarget(document.activeElement)
  }
}

interface GuiEscapeState {
  working: boolean
  questionOpen: boolean
  menuOpen: boolean
}

interface GuiEscapeEntry {
  paneId: string
  element: HTMLElement
  state: () => GuiEscapeState
  interrupt: (origin: GuiInterruptOrigin) => void | Promise<void>
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
  interrupt: (origin: GuiInterruptOrigin) => void | Promise<void>,
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

/** `false` = ninguém aqui quis a tecla; ela segue para o resto da página. */
function dispatchGuiEscape(event?: KeyboardEvent): boolean {
  if (hasVisibleEscapeOwner()) return false
  const entry = activeEntry(event)
  if (!entry) return false
  const action = guiEscapeAction('Escape', entry.state())
  if (action === 'none') return false
  if (action === 'dismiss-menu') {
    entry.dismissMenu()
    return true
  }
  const now = Date.now()
  if (now - entry.lastInterruptAt < 500) return true
  entry.lastInterruptAt = now
  void entry.interrupt(captureGuiInterruptOrigin('escape', event))
  return true
}

/** Um instalador por renderer. Até a purga F6 (2026-08-17) havia um segundo
 *  renderer (o canvas de panes) e este instalador aceitava um relay para ele;
 *  hoje o registry local é a única autoridade sobre a tecla. */
export function installGlobalGuiEscape(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key !== 'Escape') return
    if (hasVisibleEscapeOwner()) return
    if (dispatchGuiEscape(event)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}

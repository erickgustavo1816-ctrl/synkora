export interface SynVoiceTarget {
  id: string
  label: string
  element: HTMLElement
  isAvailable: () => boolean
  focus: () => void
  insert: (text: string) => void
}

let currentTarget: SynVoiceTarget | null = null
const listeners = new Set<(target: SynVoiceTarget | null) => void>()
const editableIds = new WeakMap<HTMLElement, string>()
let editableSequence = 0

export function isSynVoiceElementVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.getClientRects().length === 0) return false
  if (element.closest('[inert], [aria-hidden="true"]')) return false
  let current: HTMLElement | null = element
  while (current) {
    const style = getComputedStyle(current)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    ) {
      return false
    }
    current = current.parentElement
  }
  return true
}

function announce(target: SynVoiceTarget | null): void {
  for (const listener of listeners) listener(target)
}

export function setSynVoiceTarget(target: SynVoiceTarget): void {
  if (currentTarget?.id !== target.id) {
    currentTarget?.element.classList.remove('synvoice-target')
  }
  currentTarget = target
  target.element.classList.add('synvoice-target')
  announce(target)
}

export function clearSynVoiceTarget(id: string): void {
  if (currentTarget?.id !== id) return
  currentTarget.element.classList.remove('synvoice-target')
  currentTarget = null
  announce(null)
}

export function getSynVoiceTarget(): SynVoiceTarget | null {
  if (!currentTarget) return null
  try {
    if (currentTarget.isAvailable()) return currentTarget
  } catch {
    // Um destino desmontado também deve ser descartado.
  }
  currentTarget.element.classList.remove('synvoice-target')
  currentTarget = null
  announce(null)
  return null
}

export function onSynVoiceTargetChange(
  listener: (target: SynVoiceTarget | null) => void
): () => void {
  listeners.add(listener)
  listener(getSynVoiceTarget())
  return () => listeners.delete(listener)
}

function editableLabel(element: HTMLInputElement | HTMLTextAreaElement): string {
  const aria = element.getAttribute('aria-label')?.trim()
  if (aria) return aria
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' · ')
    if (text) return text
  }
  const labels = 'labels' in element ? Array.from(element.labels ?? []) : []
  const label = labels.map((item) => item.textContent?.trim() ?? '').find(Boolean)
  if (label) return label
  return element.placeholder?.trim() || element.name?.trim() || 'campo de texto'
}

function writeNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  caret: number,
  inserted: string
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(element, value)
  else element.value = value
  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: inserted,
      inputType: 'insertText'
    })
  )
  try {
    element.setSelectionRange(caret, caret)
  } catch {
    // Alguns tipos de input (como email) aceitam valor, mas não seleção.
  }
}

export function rememberEditableTarget(node: EventTarget | null): void {
  // Qualquer interação também revalida um painel que possa ter sido ocultado
  // por navegação, troca de universo ou mudança de layout.
  getSynVoiceTarget()
  if (!(node instanceof HTMLElement)) return
  if (node.closest('.synvoice-panel')) return
  // O textarea invisível do xterm tem um destino especializado registrado em
  // TerminalPane; tratá-lo como um textarea comum perderia o bracketed paste.
  if (node.closest('.xterm')) return
  if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) return
  if (node.disabled || node.readOnly) return
  if (node instanceof HTMLInputElement) {
    const supported = new Set(['text', 'search', 'url', 'email', 'tel'])
    if (!supported.has(node.type)) return
  }

  let id = editableIds.get(node)
  if (!id) {
    id = `field-${++editableSequence}`
    editableIds.set(node, id)
  }
  const element = node
  setSynVoiceTarget({
    id,
    label: editableLabel(element),
    element,
    isAvailable: () =>
      isSynVoiceElementVisible(element) && !element.disabled && !element.readOnly,
    focus: () => element.focus({ preventScroll: true }),
    insert: (rawText) => {
      const text = rawText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      const safeText = element instanceof HTMLInputElement ? text.replace(/\s*\n+\s*/g, ' ') : text
      const start = element.selectionStart ?? element.value.length
      const end = element.selectionEnd ?? start
      const value = `${element.value.slice(0, start)}${safeText}${element.value.slice(end)}`
      element.focus({ preventScroll: true })
      writeNativeValue(element, value, start + safeText.length, safeText)
    }
  })
}

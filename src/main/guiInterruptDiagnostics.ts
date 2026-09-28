import type { GuiInterruptOrigin } from '../shared/guiInterrupt'

export function normalizeGuiInterruptOrigin(value: unknown): GuiInterruptOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { source: 'unknown' }
  const input = value as Record<string, unknown>
  if (input.source !== 'stop-button' && input.source !== 'escape') return { source: 'unknown' }
  const origin: GuiInterruptOrigin = { source: input.source }
  if (input.eventType === 'click' || input.eventType === 'keydown') origin.eventType = input.eventType
  for (const field of ['isTrusted', 'repeat', 'defaultPrevented'] as const) {
    if (typeof input[field] === 'boolean') origin[field] = input[field]
  }
  for (const field of ['target', 'focus'] as const) {
    const category = input[field]
    if (category === 'button' || category === 'textarea' || category === 'input' ||
      category === 'contenteditable' || category === 'link' || category === 'other' || category === 'none') {
      origin[field] = category
    }
  }
  return origin
}

export function traceGuiInterrupt(
  origin: GuiInterruptOrigin,
  interrupt: () => boolean,
  record: (detail: Record<string, unknown>) => void
): boolean {
  let outcome = 'error'
  try {
    const accepted = interrupt()
    outcome = accepted ? 'accepted' : 'not-active'
    return accepted
  } finally {
    try { record({ origin, outcome }) } catch { /* Diagnostics must not change interruption behavior. */ }
  }
}

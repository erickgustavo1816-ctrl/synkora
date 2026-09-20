/** Runs only in a browser page, without imports, app APIs or elevated privileges. */
export function browserReferenceRevealInPage(
  token: string, number: number, request: number, action: 'find' | 'show' | 'clear', expiresAt = Infinity
): boolean | 'hidden' {
  const globals = window as unknown as Record<symbol, {
    targets: Map<string, WeakRef<Element>>; epoch?: number; clear?: () => void
  } | undefined>
  const registry = globals[Symbol.for('synkora.browser-reference-targets.v1')]
  if (!registry) return false
  if (action === 'find') return Boolean(registry.targets.get(token)?.deref()?.isConnected)
  if (request < (registry.epoch ?? 0)) return false
  registry.epoch = request
  registry.clear?.()
  if (action === 'clear') return true
  if (Date.now() > expiresAt) return false
  const element = registry.targets.get(token)?.deref()
  if (!element?.isConnected) return false
  if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return 'hidden'

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'center', inline: 'nearest' })
  const host = document.createElement('div')
  host.setAttribute('data-synkora-reference-highlight', String(number))
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const box = document.createElement('div')
  box.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid #c77547;border-radius:5px;background:rgba(199,117,71,.10);box-shadow:0 0 0 4px rgba(199,117,71,.14);pointer-events:none;'
  const label = document.createElement('span')
  label.textContent = 'Referência ' + number
  label.style.cssText = 'position:absolute;left:0;padding:3px 7px;border-radius:4px;background:#352b23;color:#fff9ee;font:12px/1.4 ui-monospace,monospace;white-space:nowrap;'
  box.append(label)
  shadow.append(box)
  document.documentElement.append(host)
  // Top-layer presentation also works above a page dialog. It never takes focus.
  host.setAttribute('popover', 'manual')
  try { host.showPopover() } catch { /* Fixed overlay remains a usable fallback. */ }
  const animation = box.animate(reduced
    ? [{ opacity: 1 }, { opacity: 1 }, { opacity: 0 }]
    : [{ opacity: 0 }, { opacity: 1, offset: .12 }, { opacity: 1, offset: .80 }, { opacity: 0 }],
  { duration: 2200, fill: 'forwards' })
  let raf = 0, ended = false
  const clear = (): void => {
    if (ended) return
    ended = true
    cancelAnimationFrame(raf)
    clearTimeout(timer)
    animation.cancel()
    host.remove()
    if (registry.clear === clear) delete registry.clear
  }
  const position = (): void => {
    if (!element.isConnected || registry.epoch !== request) { clear(); return }
    const rect = element.getBoundingClientRect()
    box.style.left = rect.left - 3 + 'px'
    box.style.top = rect.top - 3 + 'px'
    box.style.width = rect.width + 6 + 'px'
    box.style.height = rect.height + 6 + 'px'
    label.style.top = Math.max(6, rect.top >= 28 ? rect.top - 27 : rect.top + 3) - rect.top + 'px'
    label.style.left = Math.max(6, Math.min(rect.left, innerWidth - 130)) - rect.left + 'px'
    raf = requestAnimationFrame(position)
  }
  const timer = setTimeout(clear, 2250)
  registry.clear = clear
  position()
  return true
}

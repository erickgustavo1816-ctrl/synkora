/** Executed on the selected DOM node. Keep self-contained: no app bridge or imports in the page. */
export function browserReferenceSnapshotInPage(this: Element): unknown {
  const element = this
  if (element.nodeType !== 1 || !element.isConnected) return null
  const doc = element.ownerDocument
  const win = doc.defaultView
  if (!win) return null
  const viewport = (w: Window): Record<string, number> => ({
    width: w.innerWidth, height: w.innerHeight, devicePixelRatio: w.devicePixelRatio,
    scrollX: w.scrollX, scrollY: w.scrollY
  })
  const cleanUrl = (raw: string): string => {
    try {
      const url = new URL(raw)
      if (url.protocol === 'data:') return 'data:'
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      return url.href.slice(0, 2048)
    } catch { return '' }
  }
  const selectorInRoot = (node: Element): string => {
    const root = node.getRootNode() as Document | ShadowRoot
    const segments: string[] = []
    let current: Element | null = node
    while (current) {
      if (current.id) {
        const id = '#' + CSS.escape(current.id)
        if (root.querySelectorAll(id).length === 1) { segments.unshift(id); break }
      }
      const tag = CSS.escape(current.localName)
      const siblings = current.parentElement?.children ?? root.children
      const sameTag = Array.from(siblings).filter(sibling => sibling.localName === current!.localName)
      segments.unshift(tag + (sameTag.length > 1 ? ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')' : ''))
      current = current.parentElement
    }
    const selector = segments.join(' > ')
    if (selector.length > 4096 || root.querySelectorAll(selector).length !== 1 || root.querySelector(selector) !== node) {
      throw new Error('selected element cannot be identified uniquely')
    }
    return selector
  }
  const path: string[] = []
  let node: Element | null = element
  while (node) {
    path.unshift(selectorInRoot(node))
    const root = node.getRootNode()
    node = root instanceof ShadowRoot ? root.host : null
    if (path.length > 16) throw new Error('selected shadow path is too deep')
  }
  // Text is a small visual label. Never collect editable contents, form values,
  // script bodies, raw HTML or every attribute of the selected node.
  const excluded = 'input,textarea,select,script,style,[contenteditable]:not([contenteditable="false"])'
  let text = ''
  if (!element.closest(excluded)) {
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let visited = 0
    while (text.length < 500 && visited++ < 1000) {
      const leaf = walker.nextNode()
      if (!leaf) break
      if (!leaf.parentElement?.closest(excluded)) text += ' ' + (leaf.nodeValue ?? '').slice(0, 500)
    }
  }
  const rect = element.getBoundingClientRect()
  // Page-local weak handles expire with the document. They grant no app access
  // and let reveal distinguish the original node from an identical replacement.
  const key = Symbol.for('synkora.browser-reference-targets.v1')
  const globals = win as unknown as Record<symbol, { targets: Map<string, WeakRef<Element>> }>
  const registry = globals[key] ?? (globals[key] = { targets: new Map() })
  for (const [token, target] of registry.targets) {
    if (!target.deref()?.isConnected) registry.targets.delete(token)
  }
  if (registry.targets.size >= 10_000) throw new Error('reference target registry is full')
  const targetToken = Array.from(crypto.getRandomValues(new Uint32Array(4)),
    value => value.toString(16).padStart(8, '0')).join('')
  registry.targets.set(targetToken, new WeakRef(element))
  return {
    targetToken,
    frameUrl: cleanUrl(doc.URL),
    frameViewport: viewport(win),
    topFrame: win === win.top,
    element: {
      tag: element.localName,
      selector: path[path.length - 1],
      ...(path.length > 1 ? { selectorPath: path } : {}),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 500),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
  }
}

/** Captured at selection start for selections inside a child frame. */
export const BROWSER_REFERENCE_TOP_VIEWPORT = `(() => {
  const url = new URL(location.href);
  const data = url.protocol === 'data:';
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return {url: data ? 'data:' : url.href.slice(0, 2048), viewport: {
    width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY
  }};
})()`

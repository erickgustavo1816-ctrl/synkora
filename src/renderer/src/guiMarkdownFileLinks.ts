/** Local Markdown destinations are data for the existing pane-scoped file
 * resolver. Never navigate the renderer to them or relax DOMPurify's URI rules. */
function localFileReference(href: string | null): string | null {
  if (!href || href.length > 2_048) return null
  let reference = href.trim()
  if (!reference || reference.startsWith('#')) return null

  // Accept local file URLs without turning a remote host into a local path.
  // Keep dot segments intact so the main can enforce its traversal policy.
  if (/^file:/iu.test(reference)) {
    const localUrl = /^file:\/\/(?:localhost)?(\/.*)$/iu.exec(reference)
    if (!localUrl) return null
    reference = localUrl[1]
  }
  try {
    reference = decodeURIComponent(reference)
  } catch {
    return null
  }
  if (!reference || /[\u0000-\u001f\u007f]/u.test(reference)) return null
  if (reference.startsWith('#') || /^[\\/]{2}/u.test(reference) || /[\\/]$/u.test(reference)) return null
  if (/^\/[A-Za-z]:[\\/]/u.test(reference)) reference = reference.slice(1)
  if (/^[a-z][a-z0-9+.-]*:/iu.test(reference) && !/^[A-Za-z]:[\\/]/u.test(reference)) return null
  return reference
}

export interface GuiMarkdownFileLinks {
  html: string
  references: ReadonlyMap<string, string>
}

/** Temporarily replace local hrefs with inert fragments before sanitization.
 * Windows drive letters and file: URLs would otherwise lose their href.
 * Labels still pass through DOMPurify, then become ordinary file buttons. */
export function prepareGuiMarkdownFileLinks(html: string): GuiMarkdownFileLinks {
  const template = document.createElement('template')
  template.innerHTML = html
  const links = Array.from(template.content.querySelectorAll('a'))
  const occupied = new Set(links.map(link => link.getAttribute('href')))
  const references = new Map<string, string>()
  let index = 0
  for (const link of links) {
    const reference = localFileReference(link.getAttribute('href'))
    if (!reference) continue
    let placeholder: string
    do { placeholder = `#synkora-local-file-${index++}` } while (occupied.has(placeholder))
    occupied.add(placeholder)
    references.set(placeholder, reference)
    link.setAttribute('href', placeholder)
  }
  return { html: template.innerHTML, references }
}

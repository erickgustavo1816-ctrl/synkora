import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const GUI_MARKDOWN_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'img', 'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td',
  'th', 'thead', 'tr', 'ul'
]

const GUI_MARKDOWN_ATTRS = [
  'alt', 'checked', 'disabled', 'href', 'src', 'start', 'title', 'type'
]

const GUI_LINK_OPENING_FEEDBACK_MS = 900

function normalizedExternalHref(href: string | null): string | null {
  if (!href) return null

  try {
    const url = new URL(href)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function routeChatLinksExternally(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html

  for (const link of template.content.querySelectorAll('a')) {
    if (!(link instanceof HTMLAnchorElement)) continue

    const href = normalizedExternalHref(link.getAttribute('href'))
    if (!href) {
      // O main só encaminha HTTPS ao navegador externo. Mantemos os demais
      // destinos como texto em vez de criar uma navegação privilegiada local.
      link.replaceWith(...Array.from(link.childNodes))
      continue
    }

    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }

  return template.innerHTML
}

// MARKDOWN DAS MENSAGENS DO CHAT (2.0). O agente responde em markdown; até
// aqui o chat mostrava a fonte crua e a tela ficava cheia de asteriscos.
//
// Mesmo par do resto do app (FilesView/PlanModal): `marked` com GFM +
// DOMPurify — o texto vem de um agente, e HTML embutido esperto nunca pode
// virar script no renderer. NÃO trocar por react-markdown/prism: seriam duas
// pilhas de markdown no mesmo produto.
//
// `breaks: true` de propósito: numa CONVERSA a quebra simples de linha é
// intenção de quem escreveu, não continuação de parágrafo.

export default function GuiMarkdown({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true })
    const sanitized = DOMPurify.sanitize(raw, {
      // Só a estrutura que o próprio Markdown gera. HTML cru não pode trazer
      // classes/estilos do app, containers fechados ou conteúdo visualmente
      // oculto que reapareceria apenas ao copiar.
      ALLOWED_TAGS: GUI_MARKDOWN_TAGS,
      ALLOWED_ATTR: GUI_MARKDOWN_ATTRS
    })
    return routeChatLinksExternally(sanitized)
  }, [text])

  const openingLinkRef = useRef<HTMLAnchorElement | null>(null)
  const openingTimerRef = useRef<number | null>(null)
  const [openingLinkLabel, setOpeningLinkLabel] = useState<string | null>(null)

  const clearOpeningLink = useCallback((clearLabel = true): void => {
    if (openingTimerRef.current !== null) {
      window.clearTimeout(openingTimerRef.current)
      openingTimerRef.current = null
    }
    openingLinkRef.current?.classList.remove('gui-link-opening')
    openingLinkRef.current = null
    if (clearLabel) setOpeningLinkLabel(null)
  }, [])

  useEffect(() => () => clearOpeningLink(false), [clearOpeningLink])

  const beginLinkOpenFeedback = useCallback((link: HTMLAnchorElement): void => {
    // Uma única tentativa visual fica ativa; o clique nativo continua livre
    // para chegar ao guard de navegação já existente no processo principal.
    clearOpeningLink(false)
    openingLinkRef.current = link
    link.classList.add('gui-link-opening')
    setOpeningLinkLabel('Abrindo link externo…')
    openingTimerRef.current = window.setTimeout(() => {
      if (openingLinkRef.current !== link) return
      link.classList.remove('gui-link-opening')
      openingLinkRef.current = null
      openingTimerRef.current = null
      setOpeningLinkLabel(null)
    }, GUI_LINK_OPENING_FEEDBACK_MS)
  }, [clearOpeningLink])

  const handleLinkOpenAttempt = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return

    const link = target.closest('a[href]')
    if (!(link instanceof HTMLAnchorElement) || !event.currentTarget.contains(link)) return

    // Enter sintetiza o mesmo click nativo; não há atalho paralelo que possa
    // atrasar ou duplicar a abertura do destino externo.
    beginLinkOpenFeedback(link)
  }, [beginLinkOpenFeedback])

  return (
    <div
      className={className ? `gui-md ${className}` : 'gui-md'}
      onClickCapture={handleLinkOpenAttempt}
    >
      <div
        className="gui-md-content"
        // Conteúdo JÁ sanitizado acima — é o único caminho de HTML do chat.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <span className="gui-link-opening-status" role="status" aria-live="polite" aria-atomic="true">
        {openingLinkLabel}
      </span>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { guiApi, type GuiFileOpenResult } from '../guiApi'
import { findGuiFileTokens, guiInlineCodeFileToken } from '../guiFileTokens'
import GuiFileOpenPanel from './GuiFileOpenPanel'

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

function fileButton(token: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'gui-file-link'
  button.dataset.guiFileToken = token
  button.title = `Abrir ${token} no Synkora`
  button.setAttribute('aria-label', `Abrir arquivo ${token}`)
  button.textContent = token
  return button
}

/** O HTML já passou por DOMPurify. Esta transformação pós-sanitize opera
 * somente sobre Text nodes e cria elementos/atributos constantes via DOM —
 * nunca concatena o texto do agente como markup. Links HTTPS existentes e
 * blocos de código ficam intactos. */
function linkifyGuiFileReferences(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Text) textNodes.push(current)
    current = walker.nextNode()
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentElement
    if (!parent || parent.closest('a, button, pre')) continue

    const text = textNode.data
    const inlineCode = parent.tagName === 'CODE' ? guiInlineCodeFileToken(text) : null
    const tokens = inlineCode
      ? [{ start: text.indexOf(inlineCode), length: inlineCode.length, value: inlineCode }]
      : parent.tagName === 'CODE'
        ? []
        : findGuiFileTokens(text)
    if (!tokens.length) continue

    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const token of tokens) {
      if (token.start < cursor) continue
      fragment.append(text.slice(cursor, token.start))
      fragment.append(fileButton(token.value))
      cursor = token.start + token.length
    }
    fragment.append(text.slice(cursor))
    textNode.replaceWith(fragment)
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
  paneId,
  text,
  className
}: {
  paneId: string
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
    return linkifyGuiFileReferences(routeChatLinksExternally(sanitized))
  }, [text])

  const openingLinkRef = useRef<HTMLAnchorElement | null>(null)
  const openingTimerRef = useRef<number | null>(null)
  const [openingLinkLabel, setOpeningLinkLabel] = useState<string | null>(null)
  const fileRequestRef = useRef(0)
  const fileBusyRef = useRef(false)
  const fileTriggerRef = useRef<HTMLButtonElement | null>(null)
  const fileReferenceRef = useRef<string | null>(null)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileOpeningLabel, setFileOpeningLabel] = useState<string | null>(null)
  const [fileResult, setFileResult] = useState<GuiFileOpenResult | null>(null)

  const clearOpeningLink = useCallback((clearLabel = true): void => {
    if (openingTimerRef.current !== null) {
      window.clearTimeout(openingTimerRef.current)
      openingTimerRef.current = null
    }
    openingLinkRef.current?.classList.remove('gui-link-opening')
    openingLinkRef.current = null
    if (clearLabel) setOpeningLinkLabel(null)
  }, [])

  const clearFileBusy = useCallback((): void => {
    fileBusyRef.current = false
    setFileBusy(false)
    setFileOpeningLabel(null)
    fileTriggerRef.current?.classList.remove('gui-file-opening')
    fileTriggerRef.current?.removeAttribute('aria-busy')
  }, [])

  const closeFilePanel = useCallback((restoreFocus = true): void => {
    fileRequestRef.current += 1
    clearFileBusy()
    setFileResult(null)
    fileReferenceRef.current = null
    const trigger = fileTriggerRef.current
    fileTriggerRef.current = null
    if (restoreFocus && trigger?.isConnected) {
      window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }))
    }
  }, [clearFileBusy])

  useEffect(() => () => {
    fileRequestRef.current += 1
    clearOpeningLink(false)
  }, [clearOpeningLink])

  useEffect(() => {
    // Mensagem foi substituída/remontada: preview e escolha antigos não podem
    // continuar afirmando que pertencem ao novo conteúdo.
    closeFilePanel(false)
  }, [closeFilePanel, text])

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

  const openFileReference = useCallback(async (
    reference: string,
    selectedPath?: string
  ): Promise<void> => {
    if (fileBusyRef.current) return
    fileBusyRef.current = true
    setFileBusy(true)
    setFileOpeningLabel(`Abrindo ${reference}…`)
    fileTriggerRef.current?.classList.add('gui-file-opening')
    fileTriggerRef.current?.setAttribute('aria-busy', 'true')
    if (selectedPath === undefined) setFileResult(null)
    fileReferenceRef.current = reference
    const request = ++fileRequestRef.current
    const result = await guiApi.fileOpen(paneId, reference, selectedPath)
    if (request !== fileRequestRef.current) return
    clearFileBusy()
    setFileResult(result)
  }, [clearFileBusy, paneId])

  const handleLinkOpenAttempt = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return

    const fileLink = target.closest('button[data-gui-file-token]')
    if (fileLink instanceof HTMLButtonElement && event.currentTarget.contains(fileLink)) {
      event.stopPropagation()
      const reference = fileLink.dataset.guiFileToken
      if (!reference || fileBusyRef.current) return
      fileTriggerRef.current?.classList.remove('gui-file-opening')
      fileTriggerRef.current = fileLink
      void openFileReference(reference)
      return
    }

    const link = target.closest('a[href]')
    if (!(link instanceof HTMLAnchorElement) || !event.currentTarget.contains(link)) return

    // Enter sintetiza o mesmo click nativo; não há atalho paralelo que possa
    // atrasar ou duplicar a abertura do destino externo.
    beginLinkOpenFeedback(link)
  }, [beginLinkOpenFeedback, openFileReference])

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
        {openingLinkLabel ?? fileOpeningLabel}
      </span>
      {fileResult && (
        <GuiFileOpenPanel
          result={fileResult}
          busy={fileBusy}
          onChoose={(path) => {
            const reference = fileReferenceRef.current
            if (reference) void openFileReference(reference, path)
          }}
          onClose={() => closeFilePanel(true)}
        />
      )}
    </div>
  )
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { guiApi, type GuiFileOpenResult } from '../guiApi'
import { applyGuiStableMarkdown } from '../guiStableMarkdownPatch'
import {
  GUI_INLINE_IMAGE_OPEN_ATTR,
  GUI_INLINE_IMAGE_ATTR,
  hydrateGuiInlineImages,
  rewriteGuiInlineImages,
  type GuiInlineImageState
} from '../guiInlineImageHtml'
import { findGuiFileTokens, guiInlineCodeFileToken } from '../guiFileTokens'
import {
  isChatFileTarget,
  runGuiChatFileOpen,
  type ChatFileContextTarget,
  type FileContextTarget
} from '../guiFileContextMenu'
import GuiFileContextMenu, { useFileContextMenu } from './GuiFileContextMenu'
import GuiFileOpenPanel from './GuiFileOpenPanel'
import { useGuiInlineImagePreview } from './GuiInlineImagePreview'

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
  // Rodada 7-D: o clique continua lendo aqui; o botão direito (e a tecla de
  // menu) abre ONDE ABRIR — inclusive fora do app.
  button.title = `Abrir ${token} no Synkora · botão direito: onde abrir`
  button.setAttribute('aria-label', `Abrir arquivo ${token}`)
  button.setAttribute('aria-haspopup', 'menu')
  button.textContent = token
  return button
}

/** O token clicado, se o gesto nasceu DENTRO desta mensagem. */
function fileTokenFrom(
  event: React.SyntheticEvent<HTMLDivElement>,
  node: EventTarget | null
): HTMLButtonElement | null {
  if (!(node instanceof Element)) return null
  const button = node.closest('button[data-gui-file-token]')
  if (!(button instanceof HTMLButtonElement)) return null
  return event.currentTarget.contains(button) ? button : null
}

/** A IMAGEM do fio sob o gesto (R36) — mesmo formato do token acima: a
 *  delegação vive no wrapper, então o alvo real nunca é o `currentTarget`. O
 *  alvo é o INVÓLUCRO (um `<button>` de verdade), por isso Enter e espaço
 *  chegam aqui como clique nativo, sem nenhum `preventDefault` nesta folha. */
function inlineImageFrom(
  event: React.SyntheticEvent<HTMLDivElement>,
  node: EventTarget | null
): HTMLButtonElement | null {
  if (!(node instanceof Element)) return null
  const frame = node.closest(`button[${GUI_INLINE_IMAGE_OPEN_ATTR}]`)
  if (!(frame instanceof HTMLButtonElement)) return null
  return event.currentTarget.contains(frame) ? frame : null
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
    // R36 — a reescrita das imagens é a ÚLTIMA etapa e é DETERMINÍSTICA: só os
    // bytes das tags `<img>` de caminho local mudam, e o placeholder que sai
    // daqui é sempre o mesmo para a mesma entrada (é isso que deixa o patch de
    // prefixo da R35 reconhecer os blocos já escritos durante o streaming).
    return rewriteGuiInlineImages(linkifyGuiFileReferences(routeChatLinksExternally(sanitized)))
  }, [text])

  // R35 — O CONTEÚDO NÃO É MAIS ENTREGUE AO REACT COMO STRING. Com
  // `dangerouslySetInnerHTML`, cada tick da máquina de escrever trocava o
  // innerHTML inteiro e destruía todos os nós da mensagem em streaming — a
  // seleção do dono morria no tick seguinte ao mouseup. Aqui o container fica
  // VAZIO para o React (nenhum filho declarado ⇒ ele nunca reconcilia esta
  // subárvore) e quem pinta é o patch de prefixo estável, que preserva os nós
  // do trecho já escrito. Efeito de LAYOUT: o DOM tem de estar pintado antes
  // do browser desenhar o quadro, senão a mensagem pisca vazia.
  const contentRef = useRef<HTMLDivElement | null>(null)

  // R36 — O CACHE DAS IMAGENS DESTA MENSAGEM (chave = a referência que o agente
  // escreveu). Existe por causa do INTERPLAY com a R35: um bloco hidratado
  // (com `src` de data URL) não é byte a byte igual ao bloco recém-saído do
  // pipeline, então durante o streaming o patch de prefixo REMONTA o bloco da
  // imagem a cada tick e a hidratação roda de novo. Com o cache, esse "de novo"
  // é síncrono e vem da memória — a imagem não pisca e não há uma segunda ida
  // ao main. Mensagem parada hidrata UMA vez e fica.
  const imageCacheRef = useRef<Map<string, GuiInlineImageState>>(new Map())
  const imageInFlightRef = useRef<Set<string>>(new Set())
  const imagePendingRef = useRef<string[]>([])
  const imageEpochRef = useRef(0)
  const imagePaneRef = useRef(paneId)
  const { open: openImagePreview, close: closeImagePreview, refresh: refreshImagePreview, preview: imagePreview } =
    useGuiInlineImagePreview(contentRef, imageCacheRef)

  const paintInlineImages = useCallback((): void => {
    const container = contentRef.current
    if (!container) return
    imagePendingRef.current = hydrateGuiInlineImages(container, imageCacheRef.current)
    refreshImagePreview()
  }, [refreshImagePreview])

  useLayoutEffect(() => {
    const container = contentRef.current
    if (!container) return
    // Same relative name in another pane belongs to another cwd. Invalidate
    // before painting, and ensure a request from the old pane stays inert.
    if (imagePaneRef.current !== paneId) {
      imagePaneRef.current = paneId
      imageEpochRef.current += 1
      imageCacheRef.current.clear()
      imageInFlightRef.current.clear()
      closeImagePreview(false)
      container.replaceChildren()
    }
    applyGuiStableMarkdown(container, html)
    // No MESMO efeito de layout, antes do quadro: o que o cache já sabe volta
    // pintado junto com o patch.
    paintInlineImages()
  }, [html, paneId, paintInlineImages, closeImagePreview])

  useEffect(() => {
    const pending = imagePendingRef.current
    if (pending.length === 0) return
    const epoch = imageEpochRef.current
    for (const reference of pending) {
      if (imageInFlightRef.current.has(reference)) continue
      imageInFlightRef.current.add(reference)
      void guiApi.fileImageData(paneId, reference).then((result) => {
        if (epoch !== imageEpochRef.current) return
        imageInFlightRef.current.delete(reference)
        imageCacheRef.current.set(
          reference,
          result.ok
            ? { status: 'ready', dataUrl: result.dataUrl }
            : { status: 'refused', error: result.error }
        )
        paintInlineImages()
      })
    }
  }, [html, paneId, paintInlineImages])

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
    // Resposta de imagem que chegar depois da desmontagem não pode tentar
    // pintar num container que já não existe.
    imageEpochRef.current += 1
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

  /** Lê o arquivo AQUI, na folha de código. `trigger` é o token que iniciou o
   *  gesto — quando ele já saiu do fio (mensagem substituída), a leitura segue
   *  mesmo assim, só sem o pisca do botão e sem foco de volta. */
  const readFileHere = useCallback(
    (trigger: HTMLButtonElement | null, reference: string): void => {
      if (fileBusyRef.current) return
      fileTriggerRef.current?.classList.remove('gui-file-opening')
      fileTriggerRef.current = trigger
      void openFileReference(reference)
    },
    [openFileReference]
  )

  // ONDE ABRIR O ARQUIVO DO FIO (rodada 7, C1 — a metade do CHAT). O clique
  // ESQUERDO no TOKEN não muda uma vírgula: lê aqui, na folha de código. O botão
  // direito (e a tecla de menu) abre as outras duas saídas do dono — programa
  // padrão do sistema e mostrar na pasta —, que atravessam o canal do PANE.
  //
  // Images use the left click to enlarge in a portal; right click keeps the
  // existing authorized file actions, and never opens a tab automatically.
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null)

  const openFromMenu = useCallback((menuTarget: FileContextTarget): void => {
    if (!isChatFileTarget(menuTarget)) return
    const anchor = menuAnchorRef.current
    readFileHere(anchor?.isConnected ? anchor : null, menuTarget.reference)
  }, [readFileHere])

  const fileMenu = useFileContextMenu(openFromMenu, runGuiChatFileOpen)
  // O controlador é um objeto novo a cada render; os gestos dependem só das
  // funções dele, que são estáveis.
  const { openFromPointer, openFromKeyboard } = fileMenu

  /** O alvo do menu é sempre o que o AGENTE escreveu: quem normaliza é o
   *  resolver do main. */
  const chatTarget = useCallback(
    (reference: string): ChatFileContextTarget => ({ paneId, reference, path: reference }),
    [paneId]
  )

  const tokenTarget = useCallback((fileLink: HTMLButtonElement): ChatFileContextTarget | null => {
    const reference = fileLink.dataset.guiFileToken
    return reference ? chatTarget(reference) : null
  }, [chatTarget])

  const handleLinkOpenAttempt = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const image = inlineImageFrom(event, event.target)
    if (image) {
      openImagePreview(image, event)
      return
    }

    const fileLink = fileTokenFrom(event, event.target)
    if (fileLink) {
      event.stopPropagation()
      const reference = fileLink.dataset.guiFileToken
      if (reference) readFileHere(fileLink, reference)
      return
    }

    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest('a[href]')
    if (!(link instanceof HTMLAnchorElement) || !event.currentTarget.contains(link)) return

    // Enter sintetiza o mesmo click nativo; não há atalho paralelo que possa
    // atrasar ou duplicar a abertura do destino externo.
    beginLinkOpenFeedback(link)
  }, [beginLinkOpenFeedback, openImagePreview, readFileHere])

  const handleTokenContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const image = inlineImageFrom(event, event.target)
    if (image) {
      const reference = image.getAttribute(GUI_INLINE_IMAGE_OPEN_ATTR)
      if (!reference || /^(?:data:|https?:|\/\/)/iu.test(reference)) return
      menuAnchorRef.current = image
      openFromPointer(event, chatTarget(reference), image)
      return
    }

    const fileLink = fileTokenFrom(event, event.target)
    if (!fileLink) return
    const target = tokenTarget(fileLink)
    if (!target) return
    menuAnchorRef.current = fileLink
    openFromPointer(event, target, fileLink)
  }, [chatTarget, openFromPointer, tokenTarget])

  const handleTokenMenuKey = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    const image = inlineImageFrom(event, event.target)
    if (image) {
      const reference = image.getAttribute(GUI_INLINE_IMAGE_OPEN_ATTR)
      if (!reference || /^(?:data:|https?:|\/\/)/iu.test(reference)) return
      menuAnchorRef.current = image
      // Enter/espaço já viram clique nativo no invólucro; aqui só falta a tecla
      // de menu (e Shift+F10), exatamente como no token de arquivo.
      openFromKeyboard(event, chatTarget(reference), image)
      return
    }

    const fileLink = fileTokenFrom(event, event.target)
    if (!fileLink) return
    const target = tokenTarget(fileLink)
    if (!target) return
    menuAnchorRef.current = fileLink
    openFromKeyboard(event, target, fileLink)
  }, [chatTarget, openFromKeyboard, tokenTarget])

  return (
    <div
      className={className ? `gui-md ${className}` : 'gui-md'}
      onClickCapture={handleLinkOpenAttempt}
      onContextMenu={handleTokenContextMenu}
      onKeyDown={handleTokenMenuKey}
      onErrorCapture={(event) => {
        const node = event.target
        if (!(node instanceof HTMLImageElement)) return
        const reference = node.getAttribute(GUI_INLINE_IMAGE_ATTR)
        if (!reference || !contentRef.current?.contains(node)) return
        imageCacheRef.current.set(reference, {
          status: 'refused',
          error: 'Não foi possível abrir esta imagem. Peça ao agente uma nova imagem.'
        })
        paintInlineImages()
      }}
    >
      {/* Conteúdo JÁ sanitizado acima — é o único caminho de HTML do chat; o
          efeito de layout aplica o mesmo html por patch de prefixo estável.
          A delegação de clique/menu vive no wrapper acima e por isso
          SOBREVIVE à troca dos filhos. */}
      <div className="gui-md-content" ref={contentRef} />
      {imagePreview}
      <span className="gui-link-opening-status" role="status" aria-live="polite" aria-atomic="true">
        {openingLinkLabel ?? fileOpeningLabel}
      </span>
      {/* Recusa do sistema ao pé da mensagem: onde o gesto aconteceu. */}
      {fileMenu.notice && <p className="gui-file-open-notice">// {fileMenu.notice}</p>}
      {fileResult && (
        <GuiFileOpenPanel
          paneId={paneId}
          result={fileResult}
          busy={fileBusy}
          onChoose={(path) => {
            const reference = fileReferenceRef.current
            if (reference) void openFileReference(reference, path)
          }}
          onReopen={(reference, selectedPath) => void openFileReference(reference, selectedPath)}
          onClose={() => closeFilePanel(true)}
        />
      )}
      {fileMenu.menu && (
        <GuiFileContextMenu
          target={fileMenu.menu.target}
          options={fileMenu.menu.options}
          x={fileMenu.menu.x}
          y={fileMenu.menu.y}
          onChoose={fileMenu.choose}
          onDismiss={fileMenu.dismiss}
        />
      )}
    </div>
  )
}

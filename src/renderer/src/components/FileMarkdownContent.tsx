import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * O RENDERIZADOR DE MARKDOWN DOS PREVIEWS DE ARQUIVO — um só, de propósito.
 *
 * Nasceu dentro do `FilePreviewPanel` (aba Arquivos) e foi extraído na R26
 * quando o painel de arquivo do CHAT (`GuiFileOpenPanel`) passou a renderizar
 * `.md` bonito em vez de texto cru: dois painéis, UM pipeline (marked + GFM →
 * DOMPurify), a mesma `article.md-view` e portanto o mesmo visual em qualquer
 * lugar em que um markdown abrir. Um segundo conversor desencontraria os dois.
 */
export default function FileMarkdownContent({ content }: { content: string }): React.JSX.Element {
  const markup = useMemo(() => {
    const raw = marked.parse(content, { async: false, gfm: true, breaks: false })
    // React compares this prop by identity before replacing the reader DOM.
    return { __html: DOMPurify.sanitize(String(raw), { USE_PROFILES: { html: true } }) }
  }, [content])
  return <article className="md-view file-markdown" dangerouslySetInnerHTML={markup} />
}

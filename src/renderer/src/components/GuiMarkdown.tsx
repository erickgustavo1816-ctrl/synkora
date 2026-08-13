import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

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
    return DOMPurify.sanitize(raw, {
      // `target` sobrevive ao sanitize para o link externo abrir fora do app
      // (sem isto o DOMPurify o remove e o clique navegaria a janela inteira).
      ADD_ATTR: ['target', 'rel']
    })
  }, [text])

  return (
    <div
      className={className ? `gui-md ${className}` : 'gui-md'}
      // Conteúdo JÁ sanitizado acima — é o único caminho de HTML do chat.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

import { forwardRef } from 'react'
import { mentionParts } from '../guiFileMentions'

interface Props {
  text: string
  files: readonly string[]
}

/**
 * Camada visual do textarea. O texto continua sendo editado pelo textarea;
 * este componente apenas pinta as menções conhecidas e nunca recebe foco.
 * A caixa NUNCA se move: o scroll interno do textarea é espelhado pelo
 * scrollTop do próprio box clipado (`syncInputOverlayScroll`).
 */
const GuiMentionOverlay = forwardRef<HTMLDivElement, Props>(function GuiMentionOverlay(
  { text, files },
  ref
): React.JSX.Element {
  const parts = mentionParts(text, files)
  return (
    <div ref={ref} className="gui-mention-overlay" aria-hidden="true">
      {parts.map((part, index) =>
        part.mentioned ? (
          <span className="gui-mention-token" key={`${index}-${part.text}`}>
            {part.text}
          </span>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        )
      )}
      {/* A SENTINELA da última linha (bug do caret colado, 2026-08-21): um div
          pre-wrap NÃO renderiza a linha vazia depois do \n final — o textarea
          renderiza, e é nela que o caret mora depois de um Shift+Enter no fim.
          Sem isto o conteúdo pintado fica uma linha mais curto, o espelho de
          scroll trava no teto menor e o texto pintado desliza uma linha. O
          espaço de largura zero materializa essa linha. Fora desse caso,
          acrescentá-lo após espaços perto da borda cria uma linha artificial
          e desloca o texto pintado em relação ao cursor do textarea. */}
      {text.endsWith('\n') ? '\u200b' : null}
    </div>
  )
})

export default GuiMentionOverlay

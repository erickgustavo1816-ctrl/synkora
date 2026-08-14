import { forwardRef } from 'react'
import { mentionParts } from '../guiFileMentions'

interface Props {
  text: string
  files: readonly string[]
  scrollTop: number
  scrollLeft: number
}

/**
 * Camada visual do textarea. O texto continua sendo editado pelo textarea;
 * este componente apenas pinta as menções conhecidas e nunca recebe foco.
 */
const GuiMentionOverlay = forwardRef<HTMLDivElement, Props>(function GuiMentionOverlay(
  { text, files, scrollTop, scrollLeft },
  ref
): React.JSX.Element {
  const parts = mentionParts(text, files)
  return (
    <div
      ref={ref}
      className="gui-mention-overlay"
      aria-hidden="true"
      style={{ transform: `translate(${-scrollLeft}px, ${-scrollTop}px)` }}
    >
      {parts.map((part, index) =>
        part.mentioned ? (
          <span className="gui-mention-token" key={`${index}-${part.text}`}>
            {part.text}
          </span>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        )
      )}
    </div>
  )
})

export default GuiMentionOverlay

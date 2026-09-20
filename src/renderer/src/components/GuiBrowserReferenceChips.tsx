import { useEffect, useRef, useState } from 'react'
import type { GuiBrowserReference } from '../../../shared/guiBrowserReferences'
import { guiApi } from '../guiApi'
import './GuiBrowserReferenceChips.css'

interface Props {
  paneId: string
  references: readonly GuiBrowserReference[]
  onRemove?: (id: string) => void
  disabled?: boolean
  className?: string
}

function dimensions(viewport: GuiBrowserReference['viewport']): string {
  return `${Math.round(viewport.width * 100) / 100} × ${Math.round(viewport.height * 100) / 100} px`
}

/** Texto da página é conteúdo, nunca HTML. O número vem do main e continua o
 * mesmo após remoções ou quando outra largura é selecionada na mesma página. */
export default function GuiBrowserReferenceChips({ paneId, references, onRemove, disabled = false, className = '' }: Props) {
  const request = useRef(0)
  const [feedback, setFeedback] = useState<{ id: string; pending?: boolean; error?: string } | null>(null)
  useEffect(() => {
    setFeedback(null)
    return () => { request.current++ }
  }, [paneId])
  const reveal = async (id: string): Promise<void> => {
    const current = ++request.current
    setFeedback({ id, pending: true })
    const result = await guiApi.revealBrowserReference(paneId, id)
    if (current !== request.current) return
    setFeedback(result.ok ? null : { id, error: result.error })
  }
  if (references.length === 0) return null
  return (
    <ul className={`gui-browser-references ${className}`.trim()} aria-label="Referências da página">
      {references.map(reference => (
        <li className="gui-browser-reference" key={reference.id} data-reference-number={reference.number}>
          <button type="button" className="gui-browser-reference-reveal"
            aria-label={`Mostrar referência ${reference.number} na página`}
            title="Ir até o elemento e destacá-lo por alguns instantes"
            aria-busy={feedback?.id === reference.id && feedback.pending || undefined}
            onClick={() => void reveal(reference.id)}>
              <span className="gui-browser-reference-label">Referência {reference.number}</span>
              <span className="gui-browser-reference-viewport" title="Área da página em pixels CSS no momento da seleção">
                {dimensions(reference.viewport)}
              </span>
              <span className="gui-browser-reference-preview" title={reference.element.selector}>
                {reference.element.text || reference.element.selector || reference.element.tag}
              </span>
          </button>
          <details>
            <summary aria-label={`Detalhes da referência ${reference.number}, ${dimensions(reference.viewport)}`} title="Detalhes da referência" />
            <dl className="gui-browser-reference-details">
              <dt>Página</dt><dd>{reference.url}</dd>
              <dt>Elemento</dt><dd>{reference.element.selectorPath?.join(' → ') || reference.element.selector}</dd>
              <dt>Área da página</dt><dd>{dimensions(reference.viewport)} no momento da seleção, em pixels CSS.</dd>
              {reference.frameViewport && <><dt>Quadro selecionado</dt><dd>{dimensions(reference.frameViewport)} · {reference.frameUrl}</dd></>}
            </dl>
          </details>
          {onRemove && <button type="button" className="gui-browser-reference-remove" disabled={disabled}
            aria-label={`Remover referência ${reference.number}`} onClick={() => onRemove(reference.id)}>×</button>}
          {feedback?.id === reference.id && <span className={`gui-browser-reference-feedback${feedback.error ? ' has-error' : ''}`} role="status">
            {feedback.error ?? 'Localizando na página…'}
          </span>}
        </li>
      ))}
    </ul>
  )
}

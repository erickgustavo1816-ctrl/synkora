import { useEffect, useId, useRef } from 'react'
import type { GuiFileOpenResult } from '../guiApi'

function fileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  result: GuiFileOpenResult
  busy: boolean
  onChoose: (path: string) => void
  onClose: () => void
}

/** Superfície mínima e read-only de P17. P25 pode substituir o corpo do
 * preview mantendo o mesmo contrato `GuiFileOpenResult`; escolha, erros e a
 * fronteira IPC não precisam mudar. */
export default function GuiFileOpenPanel({
  result,
  busy,
  onChoose,
  onClose
}: Props): React.JSX.Element {
  const initialFocusRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    initialFocusRef.current?.focus({ preventScroll: true })
  }, [result])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])

  if (!result.ok && result.reason === 'ambiguous' && result.choices?.length) {
    return (
      <section
        className="gui-file-panel gui-file-choices"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
      >
        <div className="gui-file-panel-head">
          <div>
            <strong id={titleId}>qual arquivo?</strong>
            <span>{result.error}</span>
          </div>
          <button
            className="gui-file-close"
            type="button"
            aria-label="Fechar escolha de arquivo"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="gui-file-choice-list">
          {result.choices.map((choice, index) => (
            <button
              key={choice.path}
              ref={index === 0 ? initialFocusRef : undefined}
              className="gui-file-choice"
              type="button"
              disabled={busy}
              onClick={() => onChoose(choice.path)}
            >
              <strong>{choice.name}</strong>
              <span>{choice.path}</span>
            </button>
          ))}
        </div>
        {result.truncated && (
          <p className="gui-file-panel-note">
            há mais resultados — feche e peça ao agente um caminho mais completo
          </p>
        )}
      </section>
    )
  }

  if (result.ok && result.action === 'preview') {
    const { preview } = result
    return (
      <section
        className="gui-file-panel gui-file-preview"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
      >
        <div className="gui-file-panel-head">
          <div>
            <strong id={titleId}>{preview.name}</strong>
            <span title={preview.path}>{preview.path}</span>
          </div>
          <button
            ref={initialFocusRef}
            className="gui-file-close"
            type="button"
            aria-label="Fechar preview do arquivo"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="gui-file-preview-body">
          {preview.kind === 'image' ? (
            <img src={preview.content} alt={`Preview de ${preview.name}`} />
          ) : (
            <pre tabIndex={0}><code>{preview.content}</code></pre>
          )}
        </div>
        <div className="gui-file-preview-foot">
          somente leitura · {fileSizeLabel(preview.size)}
        </div>
      </section>
    )
  }

  return (
    <section
      className={`gui-file-panel gui-file-feedback${result.ok ? '' : ' error'}`}
      role={result.ok ? 'status' : 'alert'}
    >
      <span>{result.ok ? result.message : result.error}</span>
      <button
        ref={initialFocusRef}
        className="gui-file-close"
        type="button"
        aria-label="Fechar aviso de arquivo"
        onClick={onClose}
      >
        ×
      </button>
    </section>
  )
}

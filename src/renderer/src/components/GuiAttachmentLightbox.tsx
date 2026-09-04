import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './GuiInlineImagePreview.css'

interface GuiAttachmentLightboxProps {
  name: string
  src: string | null
  loading: boolean
  error: string | null
  feedback: string | null
  downloading: boolean
  onClose: () => void
  onDownload?: () => void
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
  ).filter((element) => !element.closest('[inert]'))
}

/** Modal dono de foco/Escape. Recebe somente bitmap já autorizado pela ponte
 * ou pelo filtro de data URL do chat; nunca conhece um caminho local. */
export default function GuiAttachmentLightbox({
  name,
  src,
  loading,
  error,
  feedback,
  downloading,
  onClose,
  onDownload
}: GuiAttachmentLightboxProps): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const [actualSize, setActualSize] = useState(false)
  const visibleError = error || (src && failedSource === src
    ? 'Não foi possível abrir esta imagem. Feche a prévia e peça ao agente uma nova imagem.'
    : null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current
      if (!dialog) return
      focusableElements(dialog)[0]?.focus()
    }, 0)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = focusableElements(dialogRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        first?.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [onClose])

  return createPortal(
    <div
      ref={dialogRef}
      className="gui-attachment-lightbox"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={loading}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="gui-attachment-lightbox-panel">
        <header className="gui-attachment-lightbox-head">
          <h2 id={titleId}>{name}</h2>
          <div className="gui-attachment-lightbox-actions">
            {src && !visibleError && (
              <button type="button" aria-pressed={actualSize} onClick={() => setActualSize((value) => !value)}>
                {actualSize ? 'Ajustar à tela' : 'Tamanho real'}
              </button>
            )}
            {onDownload && (
              <button type="button" disabled={downloading} onClick={onDownload}>
                {downloading ? 'Baixando…' : 'Baixar'}
              </button>
            )}
            <button type="button" aria-label="Fechar prévia" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        <div className={`gui-attachment-lightbox-body${actualSize ? ' actual-size' : ''}`}>
          {src && !visibleError && <img src={src} alt={name} draggable={false} onError={() => setFailedSource(src)} />}
          {loading && <span className="gui-attachment-lightbox-status">preparando imagem…</span>}
          {visibleError && (
            <span className="gui-attachment-lightbox-status error" role="alert">
              {visibleError}
            </span>
          )}
          {feedback && !visibleError && (
            <span className="gui-attachment-lightbox-status" role="status">
              {feedback}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

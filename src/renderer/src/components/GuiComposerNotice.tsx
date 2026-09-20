import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import './GuiComposerNotice.css'

export interface GuiComposerNoticeValue {
  message: string
}

interface Props {
  notice: GuiComposerNoticeValue
  anchorRef: RefObject<HTMLElement | null>
  onDismiss(): void
}

const NOTICE_DURATION_MS = 5_000

/** A non-modal notice follows the composer without taking focus or grid space. */
export default function GuiComposerNotice({ notice, anchorRef, onDismiss }: Props): React.JSX.Element {
  const popupRef = useRef<HTMLDivElement>(null)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), NOTICE_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const popup = popupRef.current
    if (!anchor || !popup) return
    const place = (): void => {
      const box = anchor.getBoundingClientRect()
      const width = Math.min(360, box.width, window.innerWidth - 24)
      popup.style.width = `${Math.max(0, width)}px`
      const height = popup.getBoundingClientRect().height
      popup.style.left = `${Math.max(12, Math.min(box.left + (box.width - width) / 2, window.innerWidth - width - 12))}px`
      popup.style.top = `${Math.max(12, Math.min(box.top - height - 8, window.innerHeight - height - 12))}px`
      popup.style.visibility = 'visible'
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(anchor)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchorRef, notice])

  return createPortal(
    <div ref={popupRef} className="gui-composer-notice" role="alert" aria-atomic="true">
      <span className="gui-composer-notice-icon" aria-hidden="true">!</span>
      <div className="gui-composer-notice-copy">
        <strong>Não foi possível anexar</strong>
        <p>{notice.message}</p>
      </div>
      <button type="button" aria-label="Fechar aviso" onPointerDown={event => event.preventDefault()} onClick={onDismiss}>
        <span aria-hidden="true">×</span>
      </button>
    </div>,
    document.body
  )
}

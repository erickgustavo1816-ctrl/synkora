import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { GuiAttachmentDescriptor } from '../../../preload'
import { guiApi } from '../guiApi'
import { safePreviewSource } from '../guiAttachmentPreview'
import './GuiComposerImagePreview.css'

interface Props {
  paneId: string
  attachment: GuiAttachmentDescriptor
  anchorRef?: RefObject<HTMLElement | null>
  onClose: () => void
}

interface Position { x: number; y: number }
interface Frame extends Position { width: number; height: number }
const MARGIN = 12

function bounded(frame: Frame): Frame {
  const width = Math.min(Math.max(280, frame.width), window.innerWidth - MARGIN * 2)
  const height = Math.min(Math.max(180, frame.height), window.innerHeight - MARGIN * 2)
  return { width, height,
    x: Math.max(MARGIN, Math.min(frame.x, window.innerWidth - width - MARGIN)),
    y: Math.max(MARGIN, Math.min(frame.y, window.innerHeight - height - MARGIN)) }
}

/** A nonmodal reference beside the draft, with no scroll lock or focus trap. */
export default function GuiComposerImagePreview({ paneId, attachment, anchorRef, onClose }: Props): React.JSX.Element {
  const titleId = useId()
  const helpId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const zoomCenter = useRef<Position | null>(null)
  const dragRef = useRef<{ kind: 'move' | 'resize'; pointerId: number; x: number; y: number; frame: Frame } | null>(null)
  const panRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const userPositioned = useRef(false)
  const [frame, setFrame] = useState<Frame>({ x: MARGIN, y: MARGIN, width: 560, height: 400 })
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 })
  const [fitScale, setFitScale] = useState(1)
  const [zoom, setZoom] = useState<number | null>(null)
  const scale = zoom ?? fitScale
  const enlarged = scale > fitScale + 0.001
  const imageWidth = Math.max(1, Math.floor(imageSize.width * scale))
  const imageHeight = Math.max(1, Math.floor(imageSize.height * scale))

  function changeZoom(multiplier: number): void {
    const viewport = bodyRef.current
    const body = viewport?.getBoundingClientRect()
    const image = imageRef.current?.getBoundingClientRect()
    if (viewport && body && image) zoomCenter.current = {
      x: (body.left + viewport.clientLeft + viewport.clientWidth / 2 - image.left) / image.width,
      y: (body.top + viewport.clientTop + viewport.clientHeight / 2 - image.top) / image.height
    }
    setZoom(Math.max(0.05, Math.min(4, scale * multiplier)))
  }

  function startFrameGesture(event: React.PointerEvent<HTMLButtonElement>, kind: 'move' | 'resize'): void {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    userPositioned.current = true
    dragRef.current = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, frame }
  }

  function moveFrameGesture(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (drag.kind === 'move') setFrame(bounded({ ...drag.frame, x: drag.frame.x + dx, y: drag.frame.y + dy }))
    else setFrame(bounded({ ...drag.frame,
      width: Math.min(drag.frame.width + dx, window.innerWidth - drag.frame.x - MARGIN),
      height: Math.min(drag.frame.height + dy, window.innerHeight - drag.frame.y - MARGIN) }))
  }

  function finishFrameGesture(event: React.PointerEvent<HTMLButtonElement>): void {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function moveWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>, kind: 'move' | 'resize'): void {
    const step = event.shiftKey ? 40 : 10
    const delta: Record<string, Position> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step }
    }
    const move = delta[event.key]
    if (!move) return
    event.preventDefault()
    userPositioned.current = true
    setFrame(current => bounded(kind === 'move'
      ? { ...current, x: current.x + move.x, y: current.y + move.y }
      : { ...current,
          width: Math.min(current.width + move.x, window.innerWidth - current.x - MARGIN),
          height: Math.min(current.height + move.y, window.innerHeight - current.y - MARGIN) }))
  }

  useLayoutEffect(() => {
    const placeAboveComposer = (): void => {
      const anchor = anchorRef?.current?.getBoundingClientRect()
      const width = Math.min(560, anchor?.width ?? 560)
      const height = Math.min(400, (anchor?.top ?? window.innerHeight) - MARGIN * 2)
      setFrame(bounded({ width, height,
        x: anchor ? anchor.left + (anchor.width - width) / 2 : (window.innerWidth - width) / 2,
        y: anchor ? anchor.top - height - MARGIN : MARGIN }))
    }
    placeAboveComposer()
    const resize = (): void => {
      if (userPositioned.current) setFrame(current => bounded(current))
      else placeAboveComposer()
    }
    // While still anchored, a growing draft must not disappear under the image.
    const observer = new ResizeObserver(() => { if (!userPositioned.current) placeAboveComposer() })
    if (anchorRef?.current) observer.observe(anchorRef.current)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [anchorRef])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || !imageSize.width || !imageSize.height) return
    const measure = (): void => {
      const box = body.getBoundingClientRect()
      setFitScale(Math.max(0.01, Math.min(1, (box.width - 20) / imageSize.width, (box.height - 20) / imageSize.height)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [imageSize])

  useLayoutEffect(() => {
    panRef.current = null
    const body = bodyRef.current
    if (!body) return
    if (!enlarged) body.scrollTo(0, 0)
    else {
      const center = zoomCenter.current ?? { x: 0.5, y: 0.5 }
      const viewport = body.getBoundingClientRect()
      const image = imageRef.current?.getBoundingClientRect()
      if (image) {
        body.scrollLeft += image.left + center.x * image.width -
          (viewport.left + body.clientLeft + body.clientWidth / 2)
        body.scrollTop += image.top + center.y * image.height -
          (viewport.top + body.clientTop + body.clientHeight / 2)
      }
    }
    zoomCenter.current = null
  }, [scale, enlarged])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSrc(null)
    setError(null)
    void guiApi.attachmentPreview(paneId, attachment, 'lightbox').then(result => {
      if (cancelled) return
      const source = safePreviewSource(result)
      setSrc(source)
      if (source && result.ok) setImageSize({ width: result.width, height: result.height })
      setError(source ? null : 'Não foi possível abrir esta imagem. Remova o anexo e anexe novamente.')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [paneId, attachment])

  useLayoutEffect(() => {
    const panel = panelRef.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      // A later modal keeps ownership of Escape above this floating reference.
      if ([...document.querySelectorAll('[aria-modal="true"]')].some(element => element.getClientRects().length)) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (panel?.contains(document.activeElement) && previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [onClose])

  return createPortal(
    <div ref={panelRef} className="gui-composer-image-preview" role="dialog" aria-modal="false"
      aria-labelledby={titleId} aria-describedby={helpId} aria-busy={loading}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}>
      <header className="gui-composer-image-head">
        <button type="button" className="gui-composer-image-move" aria-label={`Mover prévia de ${attachment.name}`}
          onPointerDown={event => startFrameGesture(event, 'move')}
          onPointerMove={moveFrameGesture}
          onPointerUp={finishFrameGesture}
          onPointerCancel={() => { dragRef.current = null }}
          onLostPointerCapture={() => { dragRef.current = null }}
          onKeyDown={event => moveWithKeyboard(event, 'move')}>
          <span className="gui-composer-image-grip" aria-hidden="true">⠿</span>
          <span className="gui-composer-image-title">
            <span id={titleId} title={attachment.name}>{attachment.name}</span>
            <small id={helpId} className="gui-composer-image-help">Arraste o cabeçalho para mover a janela. Use o canto para redimensionar e os controles abaixo para ampliar.</small>
          </span>
        </button>
        <button type="button" className="gui-composer-image-close" aria-label="Fechar prévia"
          onPointerDown={event => event.preventDefault()} onClick={onClose}>×</button>
      </header>
      <div ref={bodyRef} className={`gui-composer-image-body${enlarged ? ' is-enlarged' : ''}`}
        tabIndex={enlarged ? 0 : undefined}
        aria-label={enlarged ? 'Imagem ampliada: arraste a imagem ou use a rolagem para explorar' : undefined}
        onPointerDown={event => {
          if (!src || error || !enlarged || !event.isPrimary || event.button !== 0) return
          const body = event.currentTarget
          const box = body.getBoundingClientRect()
          // Native scrollbar gestures keep their usual behavior; the canvas
          // (including its empty margins) can be grabbed in both directions.
          if (event.clientX >= box.left + body.clientLeft + body.clientWidth ||
              event.clientY >= box.top + body.clientTop + body.clientHeight) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }
        }}
        onPointerMove={event => {
          const pan = panRef.current
          if (!pan || pan.pointerId !== event.pointerId) return
          event.currentTarget.scrollLeft = pan.left - (event.clientX - pan.x)
          event.currentTarget.scrollTop = pan.top - (event.clientY - pan.y)
        }}
        onPointerUp={event => {
          panRef.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => { panRef.current = null }}
        onLostPointerCapture={() => { panRef.current = null }}>
        {src && !error && <div className="gui-composer-image-canvas"
          style={enlarged ? {
            width: `calc(100% + ${imageWidth}px)`,
            height: `calc(100% + ${imageHeight}px)`
          } : undefined}>
          <img ref={imageRef} src={src} alt={attachment.name} draggable={false}
            style={{ width: imageWidth, height: imageHeight }}
            onError={() => { setSrc(null); setError('Não foi possível abrir esta imagem. Remova o anexo e anexe novamente.') }} />
        </div>}
        {loading && <span role="status">Preparando imagem…</span>}
        {error && <span className="gui-composer-image-error" role="alert">{error}</span>}
      </div>
      <div className="gui-composer-image-controls" role="toolbar" aria-label="Zoom da imagem"
        onPointerDown={event => event.preventDefault()}>
        <button type="button" aria-label="Diminuir zoom" disabled={!src || scale <= 0.05}
          onClick={() => changeZoom(1 / 1.25)}>−</button>
        <button type="button" className="gui-composer-image-zoom-percent" aria-label="Ajustar imagem à janela"
          title="Ajustar à janela" aria-pressed={zoom === null} disabled={!src}
          onClick={() => setZoom(null)}>{src ? `${Math.round(scale * 100)}%` : '—'}</button>
        <button type="button" aria-label="Aumentar zoom" disabled={!src || scale >= 4}
          onClick={() => changeZoom(1.25)}>+</button>
      </div>
      <button type="button" className="gui-composer-image-resize" aria-label="Redimensionar prévia"
        title="Arraste para redimensionar · setas no teclado"
        onPointerDown={event => startFrameGesture(event, 'resize')}
        onPointerMove={moveFrameGesture} onPointerUp={finishFrameGesture}
        onPointerCancel={() => { dragRef.current = null }} onLostPointerCapture={() => { dragRef.current = null }}
        onKeyDown={event => moveWithKeyboard(event, 'resize')}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 12 12 3M8 12 12 8" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
    </div>, document.body
  )
}

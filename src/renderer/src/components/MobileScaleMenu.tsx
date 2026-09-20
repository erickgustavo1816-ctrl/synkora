import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './MobileScaleMenu.css'

/** Scale state of a phone view, owned by MobileViewport. Shared by the panel
 * toolbar and the detached window strip: one button, one menu, two homes. */
export interface MobileScaleState {
  mode: 'fit' | 'physical'
  /** Physical mode is only "Real" once the monitor calibration produced a layout. */
  physicalActive: boolean
  physicalAvailable: boolean
  physicalTitle: string
  estimated: boolean
  zoom: number
  minimumZoom: number
  maximumZoom: number
  onFit: () => void
  onPhysical: () => void
  onZoom: (value: number) => void
  onCalibrate: () => void
}

export const MOBILE_SCALE_ZOOM_STEPS = [.75, 1, 1.25, 1.5, 2] as const

export function mobileScaleLabel(scale: Pick<MobileScaleState, 'zoom' | 'physicalActive' | 'estimated'>): string {
  if (scale.zoom !== 1) return `${scale.physicalActive && scale.estimated ? '≈' : ''}${Math.round(scale.zoom * 100)}%`
  return scale.physicalActive ? 'Real' : 'Ajustar'
}

/** The scale button: names the current mode ("Ajustar", "Real" or "125%") and
 * opens a menu with the fit/real modes, the zoom steps and calibration. */
export default function MobileScaleMenu({ scale, fitLabel }: { scale: MobileScaleState; fitLabel: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = (focus = true): void => { setOpen(false); if (focus) trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    // The menu hangs from the button's bottom-right corner; the trigger's own
    // window is the reference so the same code serves panel and popout.
    const rect = trigger.current?.getBoundingClientRect(), view = trigger.current?.ownerDocument.defaultView
    if (rect && view) setPosition({ top: Math.round(rect.bottom + 4), right: Math.max(4, Math.round(view.innerWidth - rect.right)) })
    ;(panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLButtonElement>('button'))?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const view = trigger.current?.ownerDocument.defaultView
    if (!view) return
    const outside = (event: PointerEvent): void => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false)
    }
    const resized = (): void => close(false)
    view.document.addEventListener('pointerdown', outside, true)
    view.addEventListener('resize', resized)
    return () => { view.document.removeEventListener('pointerdown', outside, true); view.removeEventListener('resize', resized) }
  }, [open])
  const pick = (action: () => void): void => { close(); action() }
  const zoomStep = (value: number): boolean => value >= scale.minimumZoom && value <= scale.maximumZoom
  const host = open ? trigger.current?.ownerDocument.body ?? document.body : null

  return <>
    <button type="button" ref={trigger} className="mobile-scale-trigger" aria-label="Tamanho da visualização" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} title={scale.physicalActive ? scale.physicalTitle : 'Tamanho da visualização'}
      onClick={() => { if (open) close(); else setOpen(true) }}>{mobileScaleLabel(scale)}<i aria-hidden="true">▾</i></button>
    {open && host && createPortal(<div className="mobile-scale-menu" id={id} ref={panel} role="menu" aria-label="Tamanho da visualização" style={position}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(false) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const current = options.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        options[next]?.focus()
      }}>
      <div role="group" aria-label="Modo">
        <button type="button" role="menuitemradio" aria-checked={!scale.physicalActive} onClick={() => pick(scale.onFit)}>{fitLabel}</button>
        <button type="button" role="menuitemradio" aria-checked={scale.physicalActive} disabled={!scale.physicalAvailable} title={scale.physicalTitle}
          onClick={() => pick(scale.onPhysical)}>Tamanho real</button>
      </div>
      <hr />
      <div role="group" aria-label="Escala">
        {MOBILE_SCALE_ZOOM_STEPS.map(step => <button type="button" key={step} role="menuitemradio" aria-checked={scale.zoom === step}
          disabled={!zoomStep(step)} onClick={() => pick(() => scale.onZoom(step))}>{Math.round(step * 100)}%</button>)}
      </div>
      {scale.physicalActive && <><hr />
        <button type="button" role="menuitem" onClick={() => pick(scale.onCalibrate)}>Calibrar tamanho real…</button></>}
    </div>, host)}
  </>
}

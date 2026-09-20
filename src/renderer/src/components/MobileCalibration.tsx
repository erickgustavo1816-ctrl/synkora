import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './MobileCalibration.css'

export default function MobileCalibration({ pixelsPerMm, pixelRatio, onConfirm, onCancel, onReset }: {
  pixelsPerMm: number | null; pixelRatio: number; onConfirm: (scale: number) => boolean; onCancel: () => void; onReset?: () => boolean
}): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  const rulerArea = useRef<HTMLDivElement>(null)
  const range = useRef<HTMLInputElement>(null)
  const [barWidth, setBarWidth] = useState((pixelsPerMm ?? 4) * 50)
  const [availableWidth, setAvailableWidth] = useState(440)
  const [error, setError] = useState('')
  const fineStep = 1 / pixelRatio
  const fits = barWidth <= availableWidth
  const adjust = (delta: number): void => setBarWidth(value => Math.max(25, Math.min(1000, value + delta)))
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useLayoutEffect(() => {
    const area = rulerArea.current
    if (!area) return
    const measure = (): void => { if (area.clientWidth) setAvailableWidth(area.clientWidth) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(area)
    return () => observer?.disconnect()
  }, [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    range.current?.focus()
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel.current(); return }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => { document.removeEventListener('keydown', keyboard, true); if (previous?.isConnected) previous.focus() }
  }, [])
  return createPortal(<div className="mobile-calibration-backdrop" onPointerDown={event => event.stopPropagation()}>
    <div ref={dialog} className="mobile-calibration-dialog" style={{ width: Math.max(484, barWidth + 64) }} role="dialog" aria-modal="true" aria-label="Calibrar tamanho físico" aria-describedby="mobile-calibration-description">
      <div className="mobile-calibration-heading"><span>ESCALA DO MONITOR</span><button type="button" aria-label="Cancelar calibração" title="Fechar · Esc" onClick={onCancel}>×</button></div>
      <h2>Ajustar tamanho real.</h2>
      <p id="mobile-calibration-description">Encoste uma régua na tela e ajuste a barra até medir <strong>exatamente 5 cm</strong>.</p>
      <div ref={rulerArea} className="mobile-calibration-ruler-area">
        <div className="mobile-calibration-ruler" style={{ width: barWidth }} aria-hidden="true">
          {Array.from({ length: 51 }, (_, index) => <i key={index} className={index % 10 === 0 ? 'is-centimetre' : index % 5 === 0 ? 'is-half' : ''} style={{ left: `${index * 2}%` }}>{index % 10 === 0 && <span>{index / 10}</span>}</i>)}
        </div>
      </div>
      <div className="mobile-calibration-adjust">
        <button type="button" aria-label="Encurtar régua um pixel" onClick={() => adjust(-fineStep)}>−</button>
        <input ref={range} type="range" aria-label="Ajustar régua de 5 cm" min={25} max={1000} step="any" value={barWidth}
          onChange={event => setBarWidth(Number(event.target.value))}
          onKeyDown={event => {
            if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(event.key)) {
              event.preventDefault(); adjust((event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1) * fineStep)
            }
          }} />
        <button type="button" aria-label="Alongar régua um pixel" onClick={() => adjust(fineStep)}>+</button>
      </div>
      <p className="mobile-calibration-hint">Correção opcional para este monitor. Use + / − ou as setas para o ajuste fino.</p>
      {!fits && <p className="mobile-calibration-error" role="alert">Amplie a janela para mostrar a régua inteira.</p>}
      {error && <p className="mobile-calibration-error" role="alert">{error}</p>}
      {onReset && <button className="mobile-calibration-reset" type="button" aria-label="Usar detecção automática" onClick={() => {
        if (!onReset()) setError('Não foi possível remover o ajuste. Tente novamente.')
      }}>Usar detecção automática</button>}
      <div className="mobile-calibration-actions">
        <button type="button" onClick={onCancel}>Cancelar</button>
        <button type="button" className="is-primary" aria-label="Salvar calibração" disabled={!fits} onClick={() => {
          if (onConfirm(barWidth / 50)) return
          setError('Não foi possível salvar. Confira o monitor e tente novamente.')
        }}>A barra mede 5 cm</button>
      </div>
    </div>
  </div>, document.body)
}

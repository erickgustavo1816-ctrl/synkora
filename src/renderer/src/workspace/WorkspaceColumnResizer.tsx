import { useRef } from 'react'

export default function WorkspaceColumnResizer({ column, width, minWidth, maxWidth, outer, label, onChange, onFit, onResizing }: {
  column: number; width: number; minWidth: number; maxWidth: number; outer: boolean; label: string
  onChange: (width: number) => void; onFit: () => void; onResizing: (value: boolean) => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(null)
  const end = (): void => { drag.current = null; onResizing(false) }
  return <div className={outer ? 'workspace-panels-resizer' : 'workspace-columns-resizer'} role="separator" tabIndex={0}
    data-dragging={!!drag.current || undefined}
    aria-label={label} aria-orientation="vertical" aria-valuemin={Math.min(width, minWidth)} aria-valuemax={maxWidth} aria-valuenow={Math.min(width, maxWidth)}
    style={outer ? undefined : { gridColumn: column, gridRow: 1 }}
    title="Arraste para redimensionar · Duplo clique para encaixar ao lado do chat"
    onDoubleClick={onFit}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.clientX, width: Math.min(width, maxWidth), pointer: event.pointerId }
      onResizing(true)
    }}
    onPointerMove={(event) => {
      if (drag.current?.pointer === event.pointerId) onChange(Math.min(maxWidth, drag.current.width + drag.current.x - event.clientX))
    }}
    onPointerUp={(event) => {
      end()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={end} onLostPointerCapture={end} onBlur={end}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 80 : 24
      const value = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step
        : event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : null
      if (value !== null) { event.preventDefault(); event.stopPropagation(); onChange(Math.min(value, maxWidth)) }
    }}
  />
}

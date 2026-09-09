import { useRef } from 'react'
import { PANEL_GAP, workspaceRowSplit } from '../workspacePanels'

export default function WorkspaceRowResizer({ column, split, label, onChange, onResizing }: {
  column: number; split: number; label: string; onChange: (value: number) => void; onResizing: (value: boolean) => void
}): React.JSX.Element {
  const drag = useRef<{ y: number; split: number; height: number; pointer: number } | null>(null)
  const end = (): void => { drag.current = null; onResizing(false) }
  return <div className="workspace-rows-resizer" role="separator" tabIndex={0}
    data-dragging={!!drag.current || undefined}
    aria-label={label} aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(split)}
    style={{ gridColumn: column + 1, gridRow: 1, top: `calc(${split}% - ${PANEL_GAP * split / 100}px)` }}
    onDoubleClick={() => onChange(50)}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { y: event.clientY, split, height: event.currentTarget.parentElement?.clientHeight ?? 0, pointer: event.pointerId }
      onResizing(true)
    }}
    onPointerMove={(event) => {
      const start = drag.current
      if (!start || start.pointer !== event.pointerId || start.height <= PANEL_GAP) return
      onChange(workspaceRowSplit(start.split + (event.clientY - start.y) / (start.height - PANEL_GAP) * 100, start.height))
    }}
    onPointerUp={(event) => {
      end()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }}
    onPointerCancel={end} onLostPointerCapture={end} onBlur={end}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 10 : 5
      const value = event.key === 'ArrowUp' ? split - step : event.key === 'ArrowDown' ? split + step
        : event.key === 'Home' ? 20 : event.key === 'End' ? 80 : null
      if (value !== null) {
        event.preventDefault(); event.stopPropagation()
        onChange(workspaceRowSplit(value, event.currentTarget.parentElement?.clientHeight ?? 0))
      }
    }}
  />
}

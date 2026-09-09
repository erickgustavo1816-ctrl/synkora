import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { canMoveWorkspacePanel, isWorkspacePanelId, type WorkspaceDropTarget, type WorkspacePanelId } from '../workspacePanels'
import type { WorkspaceController } from './useWorkspaceLayout'

type Drag = { id: WorkspacePanelId; x: number; y: number; target: WorkspaceDropTarget | null; valid: boolean }

export function useWorkspacePanelDrag(boardRef: RefObject<HTMLDivElement | null>, controller: WorkspaceController, enabled: boolean) {
  const [active, setActive] = useState<Drag | null>(null)
  const current = useRef<Drag | null>(null)
  const press = useRef<{ id: WorkspacePanelId; x: number; y: number; pointer: number } | null>(null)
  const clear = (): void => { press.current = null; current.current = null; setActive(null) }
  useEffect(() => { if (!enabled) clear() }, [enabled])
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && press.current) { event.preventDefault(); event.stopPropagation(); clear() }
    }
    window.addEventListener('blur', clear)
    window.addEventListener('keydown', escape, true)
    return () => { window.removeEventListener('blur', clear); window.removeEventListener('keydown', escape, true) }
  }, [])

  function destination(id: WorkspacePanelId, x: number, y: number): WorkspaceDropTarget | null {
    const board = boardRef.current
    if (!board) return null
    const area = board.getBoundingClientRect()
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) return null
    const panels = Array.from(board.querySelectorAll<HTMLElement>('.workspace-panel[aria-hidden="false"]'))
      .filter(panel => panel.dataset.workspacePanel !== id)
      .map(panel => ({ id: panel.dataset.workspacePanel, box: panel.getBoundingClientRect() }))
      .filter((panel): panel is { id: WorkspacePanelId; box: DOMRect } => isWorkspacePanelId(panel.id))
    const inside = panels.find(({ box }) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
    if (inside) {
      const relative = (x - inside.box.left) / inside.box.width
      return { panel: inside.id, edge: relative < .22 ? 'left' : relative > .78 ? 'right' : y < inside.box.top + inside.box.height / 2 ? 'above' : 'below' }
    }
    // The empty space to either side also creates a column. No tiny drop target.
    const closest = panels.sort((a, b) => Math.min(Math.abs(x - a.box.left), Math.abs(x - a.box.right)) - Math.min(Math.abs(x - b.box.left), Math.abs(x - b.box.right)))[0]
    return closest ? { panel: closest.id, edge: x < closest.box.left + closest.box.width / 2 ? 'left' : 'right' } : null
  }

  function move(event: PointerEvent<HTMLElement>): void {
    const start = press.current
    if (!start || event.pointerId !== start.pointer) return
    if (!current.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return
    const target = destination(start.id, event.clientX, event.clientY)
    current.current = { id: start.id, x: event.clientX, y: event.clientY, target,
      valid: !!target && canMoveWorkspacePanel(controller.preference, start.id, target) }
    setActive(current.current)
  }

  function focus(id: WorkspacePanelId): void {
    requestAnimationFrame(() => boardRef.current?.querySelector<HTMLElement>(`[data-workspace-panel="${id}"] .workspace-panel-title`)?.focus())
  }

  function finish(event: PointerEvent<HTMLElement>): void {
    const drop = current.current
    if (press.current?.pointer !== event.pointerId) return
    if (drop?.valid && drop.target) { controller.movePanel(drop.id, drop.target); focus(drop.id) }
    clear()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function keyboard(event: KeyboardEvent<HTMLElement>, id: WorkspacePanelId): void {
    if (!enabled || !event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || (event.target as HTMLElement).closest?.('button')) return
    event.preventDefault(); event.stopPropagation()
    const columns = controller.preference.columns
    const column = columns.findIndex(column => column.includes(id))
    const sibling = columns[column]?.find(panel => panel !== id)
    const neighbor = columns[column + (event.key === 'ArrowLeft' ? -1 : 1)]?.[0]
    const panel = sibling ?? neighbor
    if (!panel) return
    const edge = event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : event.key === 'ArrowUp' ? 'above' : 'below'
    controller.movePanel(id, { panel, edge }); focus(id)
  }

  return { active, clear, move, finish, keyboard,
    start(event: PointerEvent<HTMLElement>, id: WorkspacePanelId): void {
      if (!enabled || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest?.('button')) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      press.current = { id, x: event.clientX, y: event.clientY, pointer: event.pointerId }
    }
  }
}

export type WorkspacePanelDrag = ReturnType<typeof useWorkspacePanelDrag>

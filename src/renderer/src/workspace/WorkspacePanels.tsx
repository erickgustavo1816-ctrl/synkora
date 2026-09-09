import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import ResizableRightRail from '../components/ResizableRightRail'
import { BROWSER_DOCK_CONTEXT_CHANGED } from '../browserDockVisibility'
import {
  PANEL_GAP, WORKSPACE_PANELS, fitWorkspaceColumnWidths, resizeWorkspaceColumns,
  workspaceChatPanelLimit, workspaceColumnBounds, workspacePanelLayout, workspacePanelLimit,
  workspaceRowSplit, type WorkspacePanelId
} from '../workspacePanels'
import { WorkspacePanelContext } from './WorkspacePanelContext'
import type { WorkspaceController } from './useWorkspaceLayout'
import WorkspaceRowResizer from './WorkspaceRowResizer'
import WorkspaceColumnResizer from './WorkspaceColumnResizer'
import { useWorkspacePresence, WORKSPACE_MOTION_MS } from './useWorkspacePresence'
import { useWorkspaceEntrance } from './useWorkspaceEntrance'
import { useWorkspacePanelDrag } from './useWorkspacePanelDrag'

export default function WorkspacePanels({ children, controller, available, enabled, visible, projectId, boardRef, legacyEnabled, onCovered }: {
  children: ReactNode
  controller: WorkspaceController
  available: readonly WorkspacePanelId[]
  enabled: boolean
  visible: boolean
  projectId: string
  boardRef: RefObject<HTMLDivElement | null>
  legacyEnabled: boolean
  /** O deck está POR CIMA do chat (overlay: mais largo que o espaço reservado,
   *  ou maximizado). O Board usa para deixar o palco inerte — ordem do dono
   *  (09/09): com painel cobrindo o chat, nada nele aceita clique. */
  onCovered?: (covered: boolean) => void
}): React.JSX.Element {
  const { preference, setColumnWidths } = controller
  const [size, setSize] = useState({ board: 0, sidebar: 0, head: 38, stacked: false, height: 0 })
  const [resizing, setResizing] = useState(false)
  const [exitingOverlay, setExitingOverlay] = useState<string | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const arranged = useMemo(() => preference.columns.map((column, index) => ({ panels: column.filter(id => available.includes(id)), index })).filter(column => column.panels.length), [preference.columns, available])
  const columns = useMemo(() => arranged.map(column => column.panels), [arranged])
  const panels = useMemo(() => columns.flat(), [columns])
  const savedWidths = arranged.map(column => preference.columnWidths[column.index])
  const maximized = preference.maximized && panels.includes(preference.maximized) ? preference.maximized : null
  const layout = workspacePanelLayout(size.board, size.sidebar, panels.length, savedWidths, !!maximized, columns.length, preference.fitToChat)
  const widths = fitWorkspaceColumnWidths(savedWidths, layout.width)
  const present = useWorkspacePresence(panels.length > 0)
  const entrance = useWorkspaceEntrance(panels.length > 0, visible && enabled, projectId)
  const drag = useWorkspacePanelDrag(boardRef, controller, enabled && visible && !maximized)
  const lastLayout = useRef(layout)
  const lastWidths = useRef(widths)
  if (panels.length > 0) lastLayout.current = layout
  if (panels.length > 0) lastWidths.current = widths
  const deck = panels.length > 0 ? layout : lastLayout.current
  const deckWidths = panels.length > 0 ? widths : lastWidths.current
  const maxDeckWidth = workspacePanelLimit(size.board, size.sidebar)
  const columnBounds = workspaceColumnBounds(maxDeckWidth, columns.length)
  const panelKey = columns.map(column => column.join(',')).join('|')
  const rowSplits = useMemo(() => arranged.map(column => workspaceRowSplit(preference.rowSplits[column.index], size.height)), [arranged, preference.rowSplits, size.height])
  const reservedWidth = entrance.entered ? layout.reservedWidth : 0
  const overlayLeaving = exitingOverlay === projectId && enabled && visible && panels.length > 0

  useLayoutEffect(() => {
    if (exitingOverlay === null) return
    if (!overlayLeaving) { setExitingOverlay(null); return }
    // transitionend normally releases the layer. Hidden/reduced-motion views
    // may skip that event, so this bounded fallback also releases the chat.
    const timer = setTimeout(() => setExitingOverlay(null), WORKSPACE_MOTION_MS + 32)
    return () => clearTimeout(timer)
  }, [exitingOverlay, overlayLeaving, layout.width])

  useLayoutEffect(() => {
    if (!enabled) return
    let observer: ResizeObserver | null = null
    let frame = 0
    const measure = (): void => {
      const board = boardRef.current
      if (!board) return
      const sidebar = board.querySelector<HTMLElement>('.mission-col')
      const box = board.getBoundingClientRect()
      const width = box.width
      if (width <= 0) return // Hidden projects must not erase their geometry.
      const stacked = window.getComputedStyle(board).flexDirection === 'column'
      const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 0
      const sidebarMargin = sidebar ? parseFloat(window.getComputedStyle(sidebar).marginRight) || 0 : 0
      const sidebarSpace = stacked || sidebarWidth === 0 ? 0 : Math.max(0, sidebarWidth + sidebarMargin + PANEL_GAP)
      const header = board.querySelector<HTMLElement>('.stage-head')
      const head = header ? header.getBoundingClientRect().bottom - box.top : 38
      const height = grid.current?.clientHeight ?? 0
      setSize((previous) => previous.board === width && previous.sidebar === sidebarSpace && previous.head === head && previous.stacked === stacked && previous.height === height
        ? previous : { board: width, sidebar: sidebarSpace, head, stacked, height })
    }
    const observe = (): void => {
      const board = boardRef.current
      if (!board) return
      measure()
      observer = new ResizeObserver(measure)
      observer.observe(board)
      const sidebar = board.querySelector<HTMLElement>('.mission-col')
      if (sidebar) observer.observe(sidebar)
      const head = board.querySelector<HTMLElement>('.stage-head')
      if (head) observer.observe(head)
      if (grid.current) observer.observe(grid.current)
    }
    // Child layout effects precede assignment of the parent's DOM ref on a
    // fresh Board. Subscribe after that commit instead of keeping width zero.
    if (boardRef.current) observe()
    else frame = window.requestAnimationFrame(observe)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.cancelAnimationFrame(frame); window.removeEventListener('resize', measure) }
  }, [boardRef, enabled, preference.sidebarCollapsed, visible])

  useLayoutEffect(() => {
    const board = boardRef.current
    if (!enabled || !board) return
    board.style.setProperty('--workspace-reserved-space', `${entrance.entered ? layout.reservedWidth + PANEL_GAP : 0}px`)
    return () => { board.style.removeProperty('--workspace-reserved-space') }
  }, [boardRef, enabled, layout.reservedWidth, entrance.entered])

  // O chat coberto pelo deck: só vale com painel de verdade na tela (entrado,
  // não fechando) e o deck em overlay. Desligar o workspace ou fechar o último
  // painel devolve o palco.
  const covered = enabled && panels.length > 0 && entrance.entered && (layout.overlay || overlayLeaving)
  useLayoutEffect(() => {
    onCovered?.(covered)
    return () => { onCovered?.(false) }
  }, [covered, onCovered])

  // Position-only changes (a neighbor closes, the sidebar returns) also need
  // fresh native bounds; its ResizeObserver alone only catches size changes.
  useLayoutEffect(() => {
    if (enabled) window.dispatchEvent(new Event(BROWSER_DOCK_CONTEXT_CHANGED))
  }, [enabled, layout.width, layout.reservedWidth, size.head, maximized, panels, rowSplits, visible])

  useLayoutEffect(() => {
    if (!enabled || !visible) return
    let frame = 0
    const until = Date.now() + (entrance.entering ? 360 : WORKSPACE_MOTION_MS)
    const tick = (): void => {
      window.dispatchEvent(new Event(BROWSER_DOCK_CONTEXT_CHANGED))
      if (Date.now() < until) frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [enabled, visible, panelKey, maximized, preference.sidebarCollapsed, entrance.entered])

  const returnFocus = useCallback(() => {
    boardRef.current?.querySelector<HTMLButtonElement>('.workspace-panels-trigger')?.focus()
  }, [boardRef])
  const resizeColumn = (column: number, width: number): void => {
    setExitingOverlay(null)
    setColumnWidths(resizeWorkspaceColumns(widths, column, width, maxDeckWidth), arranged.map(item => item.index))
  }
  const fitPanel = (id: WorkspacePanelId): void => {
    const column = columns.findIndex(items => items.includes(id))
    if (column < 0) return
    const limit = workspaceChatPanelLimit(size.board, size.sidebar)
    const { minimum, maximum } = workspaceColumnBounds(limit, columns.length)
    // Keep the shrinking surface above the chat until its painted width fits.
    // Dropping its stacking layer at the target state hides the whole motion.
    if (layout.overlay && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) setExitingOverlay(projectId)
    setColumnWidths(resizeWorkspaceColumns(columns.map(() => minimum), column, maximum, limit), arranged.map(item => item.index), true)
  }
  const context = { controller, panels, columns, maximized, visible, projectId, rowSplits, returnFocus, drag, fitPanel }

  if (!enabled) return (
    <ResizableRightRail className="board-content" enabled={legacyEnabled} projectKey={projectId} label="painel lateral">
      {children}
    </ResizableRightRail>
  )

  return (
    <WorkspacePanelContext.Provider value={context}>
      <aside
        className={`workspace-panel-slot${size.stacked ? ' is-stacked' : ''}${!present ? ' is-empty' : ''}${panels.length === 0 ? ' is-closing' : ''}${!entrance.entered ? ' is-unentered' : ''}${entrance.entering ? ' is-opening' : ''}`}
        data-resizing={resizing || undefined}
        style={{ width: reservedWidth, ...(size.stacked ? { top: size.head + 8 } : {}) }} aria-label="Painéis da missão"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drag.active) {
            event.preventDefault(); event.stopPropagation(); drag.clear(); return
          }
          if (event.key === 'Escape' && maximized && !event.defaultPrevented) {
            event.preventDefault(); event.stopPropagation(); controller.restorePanels()
          }
        }}
      >
        <div className={`workspace-panel-deck${deck.overlay ? ' is-overlay' : ''}`} style={{ width: deck.width }}
          data-overlay-leaving={overlayLeaving || undefined}
          onTransitionEnd={event => {
            if (event.target === event.currentTarget && event.propertyName === 'width') setExitingOverlay(null)
          }}>
        {!maximized && panels.length > 0 && <WorkspaceColumnResizer column={1} outer width={widths[0]}
          minWidth={columnBounds.minimum} maxWidth={columnBounds.maximum} label={`Largura de ${columns[0].map(id => WORKSPACE_PANELS.find(panel => panel.id === id)!.title).join(' e ')}`}
          onChange={width => resizeColumn(0, width)} onFit={() => fitPanel(columns[0][0])} onResizing={setResizing} />}
        <div ref={grid} className="workspace-panel-grid"
          style={{ columnGap: Math.min(PANEL_GAP, deck.width / Math.max(1, deck.columns - 1)), gridTemplateColumns: deck.columns === 1 ? 'minmax(0, 1fr)' : deckWidths.slice(0, deck.columns).map(width => `minmax(0, ${width || 1}fr)`).join(' ') }}>
          {children}
          {!maximized && Array.from({ length: layout.columns - 1 }, (_, column) => <WorkspaceColumnResizer key={column}
            column={column + 2} outer={false} width={widths[column + 1]} minWidth={columnBounds.minimum} maxWidth={columnBounds.maximum}
            label={`Largura de ${columns[column + 1].map(id => WORKSPACE_PANELS.find(panel => panel.id === id)!.title).join(' e ')}`}
            onChange={width => resizeColumn(column + 1, width)} onFit={() => fitPanel(columns[column + 1][0])} onResizing={setResizing} />)}
          {!maximized && columns.map((items, column) => {
            if (items.length !== 2) return null
            const title = (id: WorkspacePanelId): string => WORKSPACE_PANELS.find((panel) => panel.id === id)!.title
            return <WorkspaceRowResizer key={column} column={column} split={rowSplits[column] ?? 50}
              label={`Altura entre ${title(items[0])} e ${title(items[1])}`}
              onChange={(value) => controller.setRowSplit(arranged[column].index, value)} onResizing={setResizing} />
          })}
        </div>
        </div>
      </aside>
      {drag.active && createPortal(<div className="workspace-drag-preview" style={{ left: drag.active.x + 14, top: drag.active.y + 14 }}>
        {WORKSPACE_PANELS.find(panel => panel.id === drag.active!.id)!.title}
      </div>, document.body)}
    </WorkspacePanelContext.Provider>
  )
}

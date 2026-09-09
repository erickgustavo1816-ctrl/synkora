import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { PANEL_GAP, WORKSPACE_PANELS, workspacePanelPosition, type WorkspacePanelId } from '../workspacePanels'
import { WorkspacePanelContext, WorkspacePanelVisibility } from './WorkspacePanelContext'
import WorkspaceIcon from './WorkspaceIcon'
import { useWorkspacePresence } from './useWorkspacePresence'
import { useWorkspacePanelMotion } from './useWorkspacePanelMotion'
import { useWorkspaceEntrance } from './useWorkspaceEntrance'

export default function WorkspacePanel({ id, summary, children }: {
  id: WorkspacePanelId; summary?: string; children: ReactNode
}): React.JSX.Element | null {
  const context = useContext(WorkspacePanelContext)!
  const titleId = useId()
  const index = context.panels.indexOf(id)
  const open = index >= 0
  const present = useWorkspacePresence(open)
  const entrance = useWorkspaceEntrance(open, context.visible, context.projectId)
  const ref = useRef<HTMLElement>(null)
  const [visited, setVisited] = useState(open)
  useEffect(() => { if (open) setVisited(true) }, [open])

  const maximized = context.maximized === id
  const shown = open && (!context.maximized || maximized)
  const position = workspacePanelPosition(Math.max(0, index), context.panels.length, maximized, context.columns)
  const split = context.rowSplits[context.columns.findIndex(column => column.includes(id))] ?? 50
  const height = position.row === 1 ? split : 100 - split
  const style = { gridColumn: position.column, gridRow: 1, alignSelf: position.row === 1 ? 'start' : 'end',
    height: position.span === 2 ? '100%' : `calc(${height}% - ${PANEL_GAP * height / 100}px)` }
  const lastStyle = useRef(style)
  if (open) lastStyle.current = style
  useWorkspacePanelMotion(ref, shown && context.visible, `${position.column}:${position.row}:${position.span}:${context.maximized}`)
  if (!open && !visited) return null
  const panel = WORKSPACE_PANELS.find((panel) => panel.id === id)!
  return (
    <section
      ref={ref} className={`workspace-panel${open ? ' is-open' : ' is-closing'}${!entrance.entered ? ' is-unentered' : ''}${context.drag.active?.id === id ? ' is-moving' : ''}`} data-workspace-panel={id}
      role="region" aria-labelledby={titleId} hidden={!present || (!shown && !!context.maximized)} aria-hidden={!shown} inert={!shown || undefined}
      style={lastStyle.current}
    >
      <header className="workspace-panel-head" tabIndex={0} title="Arraste para reorganizar · Alt + setas · Duplo clique para encaixar ao lado do chat"
        onPointerDown={event => context.drag.start(event, id)} onPointerMove={context.drag.move} onPointerUp={context.drag.finish}
        onPointerCancel={context.drag.clear} onLostPointerCapture={context.drag.clear}
        onKeyDown={event => context.drag.keyboard(event, id)}
        onDoubleClick={() => context.fitPanel(id)}>
        <WorkspaceIcon name={id} />
        <h3 id={titleId} tabIndex={-1} className="workspace-panel-title">{panel.title}</h3>
        {summary && <span className="workspace-panel-summary">{summary}</span>}
        <div className="workspace-panel-actions" onDoubleClick={(event) => event.stopPropagation()}>
          <button type="button" aria-label={`${maximized ? 'Restaurar' : 'Ampliar'} ${panel.title}`}
            title={maximized ? 'Restaurar tamanho' : 'Ampliar painel'} onClick={() => context.controller.maximizePanel(id)}>
            <WorkspaceIcon name={maximized ? 'restore' : 'expand'} />
          </button>
          <button type="button" aria-label={`Fechar ${panel.title}`} title="Fechar painel" onClick={() => {
            context.controller.closePanel(id)
            context.returnFocus()
          }}><WorkspaceIcon name="close" /></button>
        </div>
      </header>
      <div className="workspace-panel-body">
        <WorkspacePanelVisibility.Provider value={shown && context.visible && !context.drag.active && entrance.entered}>
          <div className="dock-sec-body">{children}</div>
        </WorkspacePanelVisibility.Provider>
      </div>
      {context.drag.active?.target?.panel === id && <div className={`workspace-drop-target ${context.drag.active.target.edge}${context.drag.active.valid ? '' : ' is-full'}`} aria-hidden="true">
        {context.drag.active.valid ? ({ left: 'Nova coluna', right: 'Nova coluna', above: 'Acima', below: 'Abaixo' }[context.drag.active.target.edge]) : 'Até 2 painéis por coluna'}
      </div>}
    </section>
  )
}

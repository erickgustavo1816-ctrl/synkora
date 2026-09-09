import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { WORKSPACE_PANELS, type WorkspacePanelId } from '../workspacePanels'
import type { WorkspaceController } from './useWorkspaceLayout'
import WorkspaceIcon from './WorkspaceIcon'

export function WorkspaceSidebarToggle({ controller, sidebarId }: { controller: WorkspaceController; sidebarId: string }): React.JSX.Element {
  const collapsed = controller.preference.sidebarCollapsed
  return <button className="workspace-sidebar-toggle" type="button" onClick={controller.toggleSidebar}
    aria-label={collapsed ? 'Mostrar missões' : 'Recolher missões'} title={collapsed ? 'Mostrar missões' : 'Recolher missões'}
    aria-expanded={!collapsed} aria-controls={sidebarId}><WorkspaceIcon name="sidebar" /></button>
}

export default function WorkspaceToolbar({ controller, available, enabled, visible, title, boardRef, actions }: {
  controller: WorkspaceController
  available: readonly WorkspacePanelId[]
  enabled: boolean
  visible: boolean
  title: string
  boardRef: RefObject<HTMLDivElement | null>
  actions?: ReactNode
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const { preference } = controller
  const panels = preference.panels.filter((id) => available.includes(id))
  const close = (focus = true): void => { setMenu(null); if (focus) trigger.current?.focus() }

  useEffect(() => { setMenu(null) }, [visible, enabled, title])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenu(null)
    }
    const resized = (): void => setMenu(null)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', resized)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', resized) }
  }, [menu])
  useLayoutEffect(() => { if (menu) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [menu])

  const open = (id: WorkspacePanelId): void => {
    controller.openPanel(id)
    close(false)
    requestAnimationFrame(() => {
      boardRef.current?.querySelector<HTMLElement>(`[data-workspace-panel="${id}"] .workspace-panel-title`)?.focus()
    })
  }

  return (
    <div className="workspace-toolbar">
      {actions}
      <button type="button" className="workspace-panels-trigger" ref={trigger}
        aria-label="Abrir painéis" aria-haspopup="menu" aria-expanded={!!menu && visible} aria-controls={menu ? menuId : undefined}
        title={enabled ? 'Escolher painéis' : 'Abra uma missão para escolher seus painéis'} disabled={!enabled}
        onClick={() => {
          if (menu) { close(); return }
          const box = trigger.current?.getBoundingClientRect()
          if (box) setMenu({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) })
        }}>
        <WorkspaceIcon name="menu" />
      </button>
      {/* Direct body portal: the native browser already detects host menus and
          hides its page while their rectangles overlap. */}
      {menu && visible && enabled && createPortal(
        <div className="workspace-panels-menu" ref={menuRef} id={menuId} role="menu" aria-label="Painéis da missão"
          style={menu} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(false) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}>
          {WORKSPACE_PANELS.filter((panel) => available.includes(panel.id)).map((panel) => (
            <button type="button" role="menuitem" key={panel.id} onClick={() => open(panel.id)}>
              <WorkspaceIcon name={panel.id} /><span>{panel.title}</span>
              {panels.includes(panel.id) && <span className="workspace-menu-open" aria-label="aberto">✓</span>}
            </button>
          ))}
          {panels.length > 0 && <button className="workspace-menu-close" type="button" role="menuitem" onClick={() => { controller.closeAll(); close() }}>fechar todos os painéis</button>}
        </div>, document.body
      )}
    </div>
  )
}

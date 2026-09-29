import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { groupOfProject, layoutGroups, type ProjectLayout } from '../../../shared/projectLayout'
import { useProjectLayout } from '../projectLayoutStore'
import { useStore } from '../store'
import { hueStyle } from './RailGroupFolder'

// ————————————————————————————————————————————————————————————————————————
// O MENU DO RAIL (grupos, 2026-09-29). O clique direito — ou a tecla
// ContextMenu / Shift+F10 — num universo ou num grupo abre este menu em
// papel (o `.ctx` do mockup aprovado). Portal no body, posição grampeada na
// viewport depois de medir, teclado inteiro (setas, Home/End, Tab circular,
// Esc devolvendo o foco a quem abriu) — o mesmo desenho de
// GuiFileContextMenu. Nenhuma confirmação modal: desfazer grupo não apaga
// nada (os universos ficam soltos no mesmo lugar).
// ————————————————————————————————————————————————————————————————————————

export type RailMenuTarget = { kind: 'project'; projectId: string } | { kind: 'group'; groupId: string }

export interface RailMenuRequest {
  target: RailMenuTarget
  x: number
  y: number
  /** quem abriu (recebe o foco de volta no Esc) */
  invoker: HTMLElement | null
}

type Item =
  | { kind: 'label'; key: string; text: string }
  | { kind: 'sep'; key: string }
  | {
      kind: 'action'
      key: string
      label: string
      run: () => void
      disabled?: boolean
      danger?: boolean
      tail?: string
      /** amostra da cor do grupo (`undefined` = sem amostra, `null` = neutra) */
      swatch?: number | null
    }

interface Props {
  request: RailMenuRequest
  layout: ProjectLayout | null
  onDismiss: (restoreFocus: boolean) => void
  /** abrir/fechar no rail passa pelo ProjectRail (anima a cápsula) */
  onToggleGroup: (groupId: string, open: boolean) => void
  /** um grupo nasceu pelo menu (a pasta nasce com o "pop") */
  onGroupMade: (groupId: string) => void
}

export default function RailContextMenu({ request, layout, onDismiss, onToggleGroup, onGroupMade }: Props): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [position, setPosition] = useState({ left: request.x, top: request.y })
  const targetProjectId = request.target.kind === 'project' ? request.target.projectId : null
  const project = useStore((s) => (targetProjectId ? s.projects.find((p) => p.id === targetProjectId) : undefined))

  const apply = useProjectLayout.getState().apply
  const openGroupSheet = useProjectLayout.getState().openGroupSheet

  const items: Item[] = []
  let label = ''
  if (project) {
    const projectId = project.id
    label = `Ações do universo ${project.name}`
    const current = layout ? groupOfProject(layout, projectId) : null
    items.push({
      kind: 'action',
      key: 'photo',
      label: 'definir foto…',
      run: () => void useStore.getState().setProjectPhoto(projectId)
    })
    if (layout) {
      items.push({ kind: 'sep', key: 'sep-move' }, { kind: 'label', key: 'label-move', text: 'mover para grupo' })
      for (const group of layoutGroups(layout)) {
        const here = group.id === current?.id
        items.push({
          kind: 'action',
          key: `move-${group.id}`,
          label: group.name,
          swatch: group.hue,
          tail: here ? 'aqui' : String(group.projectIds.length),
          disabled: here,
          run: () => void apply({ op: 'moveToGroup', projectId, groupId: group.id })
        })
      }
      items.push({
        kind: 'action',
        key: 'new-group',
        label: '+ novo grupo…',
        run: () =>
          void apply({ op: 'createGroup', projectId }).then((result) => {
            if (!result?.createdGroupId) return
            onGroupMade(result.createdGroupId)
            openGroupSheet(result.createdGroupId, true)
          })
      })
      if (current) {
        items.push(
          { kind: 'sep', key: 'sep-out' },
          {
            kind: 'action',
            key: 'out',
            label: `tirar de ${current.name}`,
            run: () => void apply({ op: 'removeFromGroup', projectId })
          }
        )
      }
    }
  } else if (request.target.kind === 'group' && layout) {
    const groupId = request.target.groupId
    const group = layoutGroups(layout).find((g) => g.id === groupId)
    if (group) {
      label = `Ações do grupo ${group.name}`
      items.push(
        { kind: 'action', key: 'sheet', label: 'renomear e cor…', run: () => openGroupSheet(groupId, false) },
        {
          kind: 'action',
          key: 'toggle',
          label: group.open ? 'fechar no rail' : 'abrir no rail',
          run: () => onToggleGroup(groupId, !group.open)
        },
        { kind: 'sep', key: 'sep-dissolve' },
        {
          kind: 'action',
          key: 'dissolve',
          label: 'desfazer grupo',
          danger: true,
          run: () => void apply({ op: 'dissolveGroup', groupId })
        }
      )
    }
  }

  const actions = items.filter((item): item is Extract<Item, { kind: 'action' }> => item.kind === 'action')
  const enabledIndexes = actions.flatMap((item, index) => (item.disabled ? [] : [index]))
  const empty = actions.length === 0

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const margin = 8
    const rect = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(margin, Math.min(request.x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(request.y, window.innerHeight - rect.height - margin))
    })
    const first = itemRefs.current.find((item) => item && !item.disabled)
    first?.focus({ preventScroll: true })
  }, [request.x, request.y])

  useEffect(() => {
    // o alvo sumiu (universo removido, grupo desfeito em outra janela)
    if (empty) onDismiss(false)
  }, [empty, onDismiss])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss(false)
    }
    const onViewportChange = (): void => onDismiss(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('blur', onViewportChange)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('blur', onViewportChange)
    }
  }, [onDismiss])

  if (empty) return null

  const moveFocus = (from: number, delta: number): void => {
    if (enabledIndexes.length === 0) return
    const at = enabledIndexes.indexOf(from)
    const next =
      at < 0
        ? delta > 0
          ? 0
          : enabledIndexes.length - 1
        : (at + delta + enabledIndexes.length) % enabledIndexes.length
    itemRefs.current[enabledIndexes[next]]?.focus()
  }

  let actionIndex = -1
  return createPortal(
    <div
      ref={menuRef}
      className="rail-ctx"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const current = itemRefs.current.findIndex((item) => item === document.activeElement)
        if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
          event.preventDefault()
          moveFocus(current, 1)
        } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
          event.preventDefault()
          moveFocus(current, -1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          itemRefs.current[enabledIndexes[0]]?.focus()
        } else if (event.key === 'End') {
          event.preventDefault()
          itemRefs.current[enabledIndexes[enabledIndexes.length - 1]]?.focus()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss(true)
        }
      }}
    >
      {items.map((item) => {
        if (item.kind === 'sep') return <hr key={item.key} aria-hidden="true" />
        if (item.kind === 'label') {
          return (
            <div key={item.key} className="rail-ctx-label" role="presentation">
              {item.text}
            </div>
          )
        }
        actionIndex += 1
        const index = actionIndex
        return (
          <button
            key={item.key}
            ref={(el) => {
              itemRefs.current[index] = el
            }}
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            onClick={() => {
              // o foco volta a quem abriu ANTES da ação: a folha do grupo, se
              // a ação abrir uma, toma o foco para si logo depois
              onDismiss(true)
              item.run()
            }}
          >
            {item.swatch !== undefined && (
              <span className={`rail-ctx-sw${item.swatch !== null ? ' hue' : ''}`} style={hueStyle(item.swatch)} aria-hidden="true" />
            )}
            <span className="rail-ctx-text">{item.label}</span>
            {item.tail && <span className="rail-ctx-tail">{item.tail}</span>}
          </button>
        )
      })}
    </div>,
    document.body
  )
}

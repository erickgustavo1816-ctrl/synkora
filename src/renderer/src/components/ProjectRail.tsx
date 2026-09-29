import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectLayoutDropTarget, ProjectLayoutGroupEntry } from '../../../shared/projectLayout'
import { useStore } from '../store'
import { projectMissionActivityLabel } from '../projectMissionActivity'
import { useProjectMissionActivity } from '../useProjectMissionActivity'
import { useProjectLayout } from '../projectLayoutStore'
import { railDropHint, railDropOp, type RailDragSource } from '../railDragModel'
import { railEntries, railProjectTip, railRenderedCount } from '../railGroupPresentation'
import { useRailDrag, type RailDragState } from '../useRailDrag'
import { hueOf, initialsOf } from '../util'
import SynkoraMark from './SynkoraMark'
import NewUniverseModal from './NewUniverseModal'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import AppUpdateBadge from './AppUpdateBadge'
import RailContextMenu, { type RailMenuRequest, type RailMenuTarget } from './RailContextMenu'
import RailGroupSheet from './RailGroupSheet'
import {
  hueStyle,
  RailFolderGrid,
  RailGroupCapsule,
  RailGroupFolder,
  railProjectActivity,
  railProjectAttention
} from './RailGroupFolder'
import './ProjectRail.css'

/** Quanto dura a "marca" de uma pasta que acabou de nascer/abrir (o pop de
 *  260 ms e a entrada escalonada dos filhos cabem aqui dentro). */
const JUST_MARK_MS = 450

interface RailItemProps {
  projectId: string
  /** grupo aberto que contém o tile (null = solto no nível de cima) */
  groupId: string | null
  tipsOff: boolean
  isDragging: boolean
  dropCombine: boolean
}

function RailItem({ projectId, groupId, tipsOff, isDragging, dropCombine }: RailItemProps): React.JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const active = useStore((s) => s.appPage === 'workspace' && s.openProjectId === projectId)
  const activity = useStore((s) => railProjectActivity(s, projectId))
  // Atenção do projeto visível de QUALQUER lugar (pedido do usuário,
  // 2026-08-06): um pane pedindo permissão faz o avatar pulsar até o dono ir
  // lá resolver. O canal ask_user saiu na purga F6 — a pergunta do agente na
  // era 2.0 mora dentro da conversa.
  const attention = useStore((s) => railProjectAttention(s, projectId))
  const openProject = useStore((s) => s.openProject)

  if (!project) return null
  const missing = project.missing === true
  const activityLabel = projectMissionActivityLabel(activity)
  const className = [
    'rail-item',
    active ? 'active' : '',
    missing ? 'missing' : '',
    attention && !missing ? 'attn' : '',
    isDragging ? 'is-dragging' : '',
    dropCombine ? 'drop-combine' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      type="button"
      className={className}
      style={{ ['--card-hue' as string]: hueOf(project.name) }}
      // o que o arraste mede: solto é um slot do nível de cima; dentro da
      // cápsula é um filho do grupo
      data-slot={groupId === null ? 'p' : undefined}
      data-child={groupId === null ? undefined : ''}
      data-gid={groupId ?? undefined}
      data-pid={project.id}
      aria-label={`${project.name} — ${missing ? 'pasta não encontrada' : activityLabel}`}
      data-tip={tipsOff ? undefined : railProjectTip({ name: project.name, missing, attention, activityLabel })}
      // pasta morta: abrir o universo só geraria panes quebrados — vai para a
      // Home, onde o card oferece a relocação
      onClick={() => openProject(missing ? null : project.id)}
    >
      {project.photo ? (
        <img src={project.photo} alt="" draggable={false} />
      ) : (
        <span className="rail-initials">{initialsOf(project.name)}</span>
      )}
      {attention && !missing && !activity && (
        <span className="rail-ask-dot" data-tip={tipsOff ? undefined : 'Um agente precisa de você'} />
      )}
      {activity && !missing && (
        <span
          className="rail-mission-dot"
          data-activity={activity}
          data-tip={tipsOff ? undefined : activityLabel}
          aria-hidden="true"
        />
      )}
      {missing && <span className="rail-warn-dot" data-tip={tipsOff ? undefined : 'Pasta não encontrada'} />}
    </button>
  )
}

/**
 * Quais bordas da lista escondem universos. O esmaecimento só aparece do lado
 * que tem mais para rolar — no topo parado a lista nasce nítida, como no
 * Discord. `itemCount` re-mede quando um universo entra ou sai (o conteúdo
 * cresce sem a caixa da lista mudar de tamanho).
 */
function useRailListEdges(itemCount: number): {
  ref: React.RefObject<HTMLDivElement | null>
  top: boolean
  bottom: boolean
} {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ top: false, bottom: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const top = el.scrollTop > 1
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      resize.disconnect()
    }
  }, [itemCount])
  return { ref, ...edges }
}

/** Uma "marca" passageira (a pasta que nasceu, a cápsula que abriu): some
 *  sozinha depois da animação. */
function useTransientMark(): [string | null, (id: string) => void] {
  const [mark, setMark] = useState<string | null>(null)
  useEffect(() => {
    if (mark === null) return
    const timer = window.setTimeout(() => setMark(null), JUST_MARK_MS)
    return () => window.clearTimeout(timer)
  }, [mark])
  return [mark, setMark]
}

/** O fantasma do arraste e a pílula "soltar: …" (portal; posição por ref). */
function RailDragOverlay({
  drag,
  groups,
  activeProjectId,
  ghostRef,
  hintRef
}: {
  drag: RailDragState
  groups: readonly ProjectLayoutGroupEntry[]
  activeProjectId: string | null
  ghostRef: (el: HTMLElement | null) => void
  hintRef: (el: HTMLElement | null) => void
}): React.JSX.Element {
  const source = drag.source
  const project = useStore((s) =>
    source.kind === 'project' ? s.projects.find((p) => p.id === source.projectId) : undefined
  )
  const layout = useProjectLayout((s) => s.layout)
  const group = source.kind === 'group' ? groups.find((g) => g.id === source.groupId) : undefined
  const hint =
    layout && drag.drop
      ? railDropHint(
          layout,
          (id) => useStore.getState().projects.find((p) => p.id === id)?.name ?? '',
          source,
          drag.drop.target
        )
      : null

  let ghost: React.JSX.Element | null = null
  if (project) {
    ghost = (
      <div
        ref={ghostRef}
        className="rail-item rail-ghost"
        style={{ ['--card-hue' as string]: hueOf(project.name) }}
        aria-hidden="true"
      >
        {project.photo ? (
          <img src={project.photo} alt="" draggable={false} />
        ) : (
          <span className="rail-initials">{initialsOf(project.name)}</span>
        )}
      </div>
    )
  } else if (group) {
    ghost = (
      <div
        ref={ghostRef}
        className={`rail-item rail-folder rail-ghost${group.hue !== null ? ' has-hue' : ''}`}
        style={hueStyle(group.hue)}
        aria-hidden="true"
      >
        <RailFolderGrid projectIds={group.projectIds} activeProjectId={activeProjectId} />
      </div>
    )
  }

  return createPortal(
    <>
      {ghost}
      <div ref={hintRef} className={`rail-drag-hint${hint ? ' on' : ''}`} role="status" aria-live="polite">
        {hint && (
          <>
            {hint.lead}
            {hint.em && <em>{hint.em}</em>}
            {hint.tail}
          </>
        )}
      </div>
    </>,
    document.body
  )
}

function menuTargetOf(el: HTMLElement): RailMenuTarget | null {
  if (el.dataset.pid) return { kind: 'project', projectId: el.dataset.pid }
  const groupId = el.dataset.folder ?? el.dataset.head
  return groupId ? { kind: 'group', groupId } : null
}

const MENU_SOURCE = '[data-pid], [data-folder], [data-head]'

/**
 * Rail lateral estilo Discord: Home no topo e um avatar por universo — e,
 * desde 2026-09-29, GRUPOS (pastas que abrem como cápsula; arrastar um
 * universo sobre outro cria um). A ordem é o layout do main
 * (`useProjectLayout`); sem ele ainda, a lista plana de `projects`.
 * Trocar de projeto NUNCA derruba nada — os universos ficam montados em
 * segundo plano; o ponto mostra atividade de missões, não a contagem de panes.
 */
export default function ProjectRail(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  useProjectMissionActivity(projects)
  const openProjectId = useStore((s) => s.openProjectId)
  const appPage = useStore((s) => s.appPage)
  const openProject = useStore((s) => s.openProject)
  // nome do grupo sob a pasta: preferência de Ajustes, ligada por padrão
  const showNames = useStore((s) => s.settings?.railGroupNames !== false)
  const layout = useProjectLayout((s) => s.layout)
  const apply = useProjectLayout((s) => s.apply)
  const openGroupSheet = useProjectLayout((s) => s.openGroupSheet)
  const sheetGroupId = useProjectLayout((s) => s.sheetGroupId)
  const sheetSelectName = useProjectLayout((s) => s.sheetSelectName)
  // ONDA D: o "+" abre o MESMO modal da Home — a pasta continua sendo o
  // essencial, mas agora existe uma decisão a mais (link do GitHub).
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<RailMenuRequest | null>(null)
  const menuRef = useRef<RailMenuRequest | null>(null)
  menuRef.current = menu
  const [justOpened, markOpened] = useTransientMark()
  const [justMade, markMade] = useTransientMark()

  useEffect(() => {
    void useProjectLayout.getState().load()
  }, [])

  const projectIds = useMemo(() => projects.map((p) => p.id), [projects])
  const entries = useMemo(() => railEntries(layout, projectIds), [layout, projectIds])
  const groups = useMemo(
    () => entries.filter((e): e is ProjectLayoutGroupEntry => e.kind === 'group'),
    [entries]
  )
  const activeProjectId = appPage === 'workspace' ? openProjectId : null
  const listEdges = useRailListEdges(railRenderedCount(entries, showNames))

  const setGroupOpen = useCallback(
    (groupId: string, open: boolean) => {
      if (open) markOpened(groupId)
      void apply({ op: 'setGroupOpen', groupId, open })
    },
    [apply, markOpened]
  )

  const onDrop = useCallback(
    (source: RailDragSource, target: ProjectLayoutDropTarget) => {
      const op = railDropOp(source, target)
      if (!op) return
      void apply(op).then((result) => {
        if (!result) return
        if (result.createdGroupId) {
          markMade(result.createdGroupId)
          openGroupSheet(result.createdGroupId, true)
        } else if (target.type === 'into') {
          markMade(target.groupId)
        }
      })
    },
    [apply, markMade, openGroupSheet]
  )

  const { drag, ghostRef, hintRef, onPointerDown, onClickCapture } = useRailDrag({
    listRef: listEdges.ref,
    enabled: layout !== null,
    onDrop
  })

  const openMenuFor = (el: HTMLElement, x: number, y: number): void => {
    const target = menuTargetOf(el)
    if (target) setMenu({ target, x, y, invoker: el })
  }

  const dismissMenu = useCallback((restoreFocus: boolean) => {
    const invoker = menuRef.current?.invoker
    setMenu(null)
    if (restoreFocus && invoker?.isConnected) invoker.focus({ preventScroll: true })
  }, [])

  // a folha do grupo mora aqui, mas abre de qualquer lugar (Home inclusive);
  // grupo que sumiu (desfeito em outra janela, último universo removido)
  // fecha a folha
  const sheetOpen = sheetGroupId !== null && groups.some((g) => g.id === sheetGroupId)
  useEffect(() => {
    if (sheetGroupId !== null && layout !== null && !sheetOpen) useProjectLayout.getState().closeGroupSheet()
  }, [sheetGroupId, layout, sheetOpen])

  const tipsOff = drag !== null
  const draggingProject = drag?.source.kind === 'project' ? drag.source.projectId : null
  const draggingGroup = drag?.source.kind === 'group' ? drag.source.groupId : null
  const combineId = drag?.drop?.feedback.kind === 'combine' ? drag.drop.feedback.projectId : null
  const intoId = drag?.drop?.feedback.kind === 'into' ? drag.drop.feedback.groupId : null
  const line = drag?.drop?.feedback.kind === 'line' ? drag.drop.feedback : null

  const tile = (projectId: string, groupId: string | null): React.JSX.Element => (
    <RailItem
      key={`p:${projectId}`}
      projectId={projectId}
      groupId={groupId}
      tipsOff={tipsOff}
      isDragging={draggingProject === projectId}
      dropCombine={combineId === projectId}
    />
  )

  return (
    <nav className="project-rail" aria-label="Universos">
      <button
        type="button"
        className={`rail-item rail-home${appPage === 'workspace' && openProjectId === null ? ' active' : ''}`}
        data-tip="Home — universos"
        aria-label="Home — universos"
        onClick={() => openProject(null)}
      >
        <SynkoraMark size={22} />
      </button>
      <div className="rail-sep" />
      <div
        ref={listEdges.ref}
        className={`rail-list${listEdges.top ? ' fade-top' : ''}${listEdges.bottom ? ' fade-bottom' : ''}`}
        onPointerDown={onPointerDown}
        onClickCapture={onClickCapture}
        onContextMenu={(event) => {
          const el = (event.target as HTMLElement).closest<HTMLElement>(MENU_SOURCE)
          if (!el) return
          event.preventDefault()
          openMenuFor(el, event.clientX, event.clientY)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          const el = (event.target as HTMLElement).closest<HTMLElement>(MENU_SOURCE)
          if (!el) return
          event.preventDefault()
          const r = el.getBoundingClientRect()
          openMenuFor(el, r.right + 6, r.top)
        }}
      >
        {entries.map((entry) => {
          if (entry.kind === 'project') return tile(entry.projectId, null)
          if (!entry.open) {
            return (
              <RailGroupFolder
                key={`g:${entry.id}`}
                group={entry}
                activeProjectId={activeProjectId}
                showName={showNames}
                tipsOff={tipsOff}
                isDragging={draggingGroup === entry.id}
                dropInto={intoId === entry.id}
                justMade={justMade === entry.id}
                onOpen={(groupId) => setGroupOpen(groupId, true)}
              />
            )
          }
          return (
            <RailGroupCapsule
              key={`g:${entry.id}`}
              group={entry}
              showName={showNames}
              tipsOff={tipsOff}
              isDragging={draggingGroup === entry.id}
              justOpened={justOpened === entry.id}
              onClose={(groupId) => setGroupOpen(groupId, false)}
            >
              {entry.projectIds.map((id) => tile(id, entry.id))}
            </RailGroupCapsule>
          )
        })}
        <button
          type="button"
          className={`rail-item rail-add${adding ? ' busy' : ''}`}
          data-tip={'Novo universo\npasta do projeto · link do GitHub opcional'}
          aria-label="Novo universo"
          onClick={() => setAdding(true)}
        >
          +
        </button>
        {line && drag?.lineTop != null && (
          <div
            className={`rail-drop-line${line.inset ? ' inset' : ''}`}
            style={{ top: drag.lineTop }}
            aria-hidden="true"
          />
        )}
      </div>
      {/* O SELO DE VERSÃO (2026-09-21): o pé do rail é o único lugar visível de
          QUALQUER universo — a versão que roda, e se há uma nova chegando. */}
      <GuiPanelErrorBoundary paneId="rail:app-update" label="a versão do Synkora">
        <AppUpdateBadge />
      </GuiPanelErrorBoundary>
      {drag && (
        <RailDragOverlay
          drag={drag}
          groups={groups}
          activeProjectId={activeProjectId}
          ghostRef={ghostRef}
          hintRef={hintRef}
        />
      )}
      {menu && (
        <GuiPanelErrorBoundary paneId="overlay:rail:menu" label="o menu do rail" onClose={() => setMenu(null)}>
          <RailContextMenu
            request={menu}
            layout={layout}
            onDismiss={dismissMenu}
            onToggleGroup={setGroupOpen}
            onGroupMade={markMade}
          />
        </GuiPanelErrorBoundary>
      )}
      {sheetOpen && sheetGroupId !== null && (
        <GuiPanelErrorBoundary
          paneId="overlay:rail:group-sheet"
          label="a folha do grupo"
          onClose={() => useProjectLayout.getState().closeGroupSheet()}
        >
          <RailGroupSheet
            key={sheetGroupId}
            groupId={sheetGroupId}
            selectName={sheetSelectName}
            activeProjectId={activeProjectId}
            listRef={listEdges.ref}
          />
        </GuiPanelErrorBoundary>
      )}
      {adding && (
        <GuiPanelErrorBoundary
          paneId="overlay:rail:new-universe"
          label="o novo universo"
          onClose={() => setAdding(false)}
        >
          <NewUniverseModal onClose={() => setAdding(false)} />
        </GuiPanelErrorBoundary>
      )}
    </nav>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useStore, type Mission } from '../store'
import { projectMissionActivity, projectMissionActivityLabel } from '../projectMissionActivity'
import { useProjectMissionActivity } from '../useProjectMissionActivity'
import { hueOf, initialsOf } from '../util'
import SynkoraMark from './SynkoraMark'
import NewUniverseModal from './NewUniverseModal'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import AppUpdateBadge from './AppUpdateBadge'
import './ProjectRail.css'

// Referência estável para seletores (regra do projeto: nunca `?? []` inline).
const NO_PANES: never[] = []
const NO_MISSIONS: Mission[] = []

function RailItem({ projectId }: { projectId: string }): React.JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const active = useStore((s) => s.appPage === 'workspace' && s.openProjectId === projectId)
  const activity = useStore(s => projectMissionActivity(projectId, s.missionsByProject[projectId] ?? NO_MISSIONS, s.guiPanes))
  // Atenção do projeto visível de QUALQUER lugar (pedido do usuário,
  // 2026-08-06): um pane pedindo permissão faz o avatar pulsar até o dono ir
  // lá resolver. O canal ask_user saiu na purga F6 — a pergunta do agente na
  // era 2.0 mora dentro da conversa.
  const attention = useStore((s) =>
    (s.panesByProject[projectId] ?? NO_PANES).some((p) => s.paneAttention[p.id])
  )
  const openProject = useStore((s) => s.openProject)
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)

  if (!project) return null
  const missing = project.missing === true
  const activityLabel = projectMissionActivityLabel(activity)
  return (
    <button
      className={`rail-item${active ? ' active' : ''}${missing ? ' missing' : ''}${attention && !missing ? ' attn' : ''}`}
      style={{ ['--card-hue' as string]: hueOf(project.name) }}
      aria-label={`${project.name} — ${missing ? 'pasta não encontrada' : activityLabel}`}
      data-tip={
        missing
          ? `${project.name}\npasta não encontrada — corrija na Home (📁 alterar pasta)`
          : `${project.name}\n${activityLabel}${attention ? '\n❓ um agente está esperando você aqui' : ''}\nclique direito: definir foto`
      }
      // pasta morta: abrir o universo só geraria panes quebrados — vai para a
      // Home, onde o card oferece a relocação
      onClick={() => openProject(missing ? null : project.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        void setProjectPhoto(project.id)
      }}
    >
      {project.photo ? (
        <img src={project.photo} alt="" draggable={false} />
      ) : (
        <span className="rail-initials">{initialsOf(project.name)}</span>
      )}
      {attention && !missing && !activity && <span className="rail-ask-dot" data-tip="Um agente precisa de você" />}
      {activity && !missing && (
        <span className="rail-mission-dot" data-activity={activity} data-tip={activityLabel} aria-hidden="true" />
      )}
      {missing && <span className="rail-warn-dot" data-tip="Pasta não encontrada" />}
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

/**
 * Rail lateral estilo Discord: Home no topo e um avatar por universo.
 * Trocar de projeto NUNCA derruba nada — os universos ficam montados em
 * segundo plano; o ponto mostra atividade de missões, não a contagem de panes.
 */
export default function ProjectRail(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  useProjectMissionActivity(projects)
  const openProjectId = useStore((s) => s.openProjectId)
  const appPage = useStore((s) => s.appPage)
  const openProject = useStore((s) => s.openProject)
  // ONDA D: o "+" abre o MESMO modal da Home — a pasta continua sendo o
  // essencial, mas agora existe uma decisão a mais (link do GitHub).
  const [adding, setAdding] = useState(false)
  const listEdges = useRailListEdges(projects.length)

  return (
    <nav className="project-rail">
      <button
        className={`rail-item rail-home${appPage === 'workspace' && openProjectId === null ? ' active' : ''}`}
        data-tip="Home — universos"
        onClick={() => openProject(null)}
      >
        <SynkoraMark size={22} />
      </button>
      <div className="rail-sep" />
      <div
        ref={listEdges.ref}
        className={`rail-list${listEdges.top ? ' fade-top' : ''}${listEdges.bottom ? ' fade-bottom' : ''}`}
      >
        {projects.map((p) => (
          <RailItem key={p.id} projectId={p.id} />
        ))}
        <button
          className={`rail-item rail-add${adding ? ' busy' : ''}`}
          data-tip={'Novo universo\npasta do projeto · link do GitHub opcional'}
          onClick={() => setAdding(true)}
        >
          +
        </button>
      </div>
      {/* O SELO DE VERSÃO (2026-09-21): o pé do rail é o único lugar visível de
          QUALQUER universo — a versão que roda, e se há uma nova chegando. */}
      <GuiPanelErrorBoundary paneId="rail:app-update" label="a versão do Synkora">
        <AppUpdateBadge />
      </GuiPanelErrorBoundary>
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

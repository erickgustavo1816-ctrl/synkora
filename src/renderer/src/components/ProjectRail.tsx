import { useState } from 'react'
import { useStore } from '../store'
import { hueOf, initialsOf } from '../util'
import SynkoraMark from './SynkoraMark'
import NewUniverseModal from './NewUniverseModal'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'

// Referência estável para seletores (regra do projeto: nunca `?? []` inline).
const NO_PANES: never[] = []

function RailItem({ projectId }: { projectId: string }): React.JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const active = useStore((s) => s.appPage === 'workspace' && s.openProjectId === projectId)
  const running = useStore((s) => (s.panesByProject[projectId] ?? NO_PANES).length)
  // Atenção do projeto visível de QUALQUER lugar (pedido do usuário,
  // 2026-08-06): pergunta do ask_user esperando OU pane pedindo permissão —
  // o avatar pulsa até o dono ir lá resolver.
  const attention = useStore(
    (s) =>
      Object.keys(s.askQuestions[projectId] ?? {}).length > 0 ||
      (s.panesByProject[projectId] ?? NO_PANES).some((p) => s.paneAttention[p.id])
  )
  const openProject = useStore((s) => s.openProject)
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)

  if (!project) return null
  const missing = project.missing === true
  return (
    <button
      className={`rail-item${active ? ' active' : ''}${missing ? ' missing' : ''}${attention && !missing ? ' attn' : ''}`}
      style={{ ['--card-hue' as string]: hueOf(project.name) }}
      data-tip={
        missing
          ? `${project.name}\npasta não encontrada — corrija na Home (📁 alterar pasta)`
          : `${project.name}${attention ? '\n❓ um agente está esperando você aqui' : ''}${running > 0 ? ` · ${running} pane(s) rodando` : ''}\nclique direito: definir foto`
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
      {attention && !missing && <span className="rail-ask-dot" data-tip="Um agente precisa de você" />}
      {running > 0 && !missing && !attention && (
        <span className="rail-run-dot" data-tip="Sessões rodando" />
      )}
      {missing && <span className="rail-warn-dot" data-tip="Pasta não encontrada" />}
    </button>
  )
}

/**
 * Rail lateral estilo Discord: Home no topo e um avatar por universo.
 * Trocar de projeto NUNCA derruba nada — os universos ficam montados em
 * segundo plano; o dot verde mostra onde há sessões vivas.
 */
export default function ProjectRail(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const openProjectId = useStore((s) => s.openProjectId)
  const appPage = useStore((s) => s.appPage)
  const openProject = useStore((s) => s.openProject)
  // ONDA D: o "+" abre o MESMO modal da Home — a pasta continua sendo o
  // essencial, mas agora existe uma decisão a mais (link do GitHub).
  const [adding, setAdding] = useState(false)

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
      <div className="rail-list">
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

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { hueOf } from '../util'
import Board from '../components/Board'
import PanesView from '../components/PanesView'

interface Props {
  projectId: string
}

const NO_PANES: never[] = []

export default function Universe({ projectId }: Props): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const seats = useStore((s) => s.seats)
  const paneCount = useStore(
    (s) => (s.panesByProject[projectId] ?? NO_PANES).length + Object.keys(s.taskRuns).length
  )
  const addPane = useStore((s) => s.addPane)
  const openProject = useStore((s) => s.openProject)

  const tab = useStore((s) => s.universeTab)
  const setTab = useStore((s) => s.setUniverseTab)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function onDocClick(e: MouseEvent): void {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  if (!project) return <div className="bridge-warning">Projeto não encontrado.</div>

  function openAgent(seatId: string, kind: 'claude' | 'codex'): void {
    addPane(projectId, kind, { seatId })
    setMenuOpen(false)
    setTab('panes')
  }

  return (
    <div className="workspace">
      <header className="ws-header">
        <button className="btn ghost back" onClick={() => openProject(null)}>
          ‹
        </button>
        <div className="ws-title">
          <span className="ws-name">{project.name}</span>
          <span className="ws-path">{project.path}</span>
        </div>

        <nav className="tabs">
          <button className={`tab ${tab === 'board' ? 'active' : ''}`} onClick={() => setTab('board')}>
            Board
          </button>
          <button className={`tab ${tab === 'panes' ? 'active' : ''}`} onClick={() => setTab('panes')}>
            Panes {paneCount > 0 && <span className="tab-badge">{paneCount}</span>}
          </button>
        </nav>

        <div className="ws-actions">
          <div className="menu-anchor" ref={menuRef}>
            <button className="btn accent" onClick={() => setMenuOpen((v) => !v)}>
              <span className="btn-icon">✦</span> Agente <span className="caret">▾</span>
            </button>
            {menuOpen && (
              <div className="menu">
                {seats.length === 0 && (
                  <div className="menu-note">
                    Nenhum seat cadastrado — crie um na Home para abrir agentes.
                  </div>
                )}
                {seats.map((seat) => (
                  <button
                    key={seat.id}
                    className="menu-item"
                    onClick={() => openAgent(seat.id, seat.cli)}
                  >
                    <span
                      className="seat-swatch"
                      style={{ ['--card-hue' as string]: hueOf(seat.name) }}
                    />
                    <span className="menu-label">{seat.name}</span>
                    <span className="seat-cli">{seat.cli === 'claude' ? '✦' : '⌁'}</span>
                    <span className={`meta-dot ${seat.status === 'logado' ? 'run' : 'idle'}`} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="btn ghost"
            onClick={() => {
              addPane(projectId, 'shell')
              setTab('panes')
            }}
          >
            <span className="btn-icon">&gt;_</span> Terminal
          </button>
        </div>
      </header>

      {/* Panes ficam montados mesmo na aba Board — trocar de aba não pode
          matar as sessões de CLI; só esconde via CSS. */}
      <div className="tab-content" style={{ display: tab === 'board' ? 'flex' : 'none' }}>
        <Board projectId={projectId} />
      </div>
      <div className="tab-content" style={{ display: tab === 'panes' ? 'flex' : 'none' }}>
        <PanesView projectId={projectId} projectPath={project.path} />
      </div>
    </div>
  )
}

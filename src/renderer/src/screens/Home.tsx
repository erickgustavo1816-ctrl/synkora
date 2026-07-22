import { useState } from 'react'
import { useStore } from '../store'
import { hueOf, initialsOf } from '../util'
import SeatRail from '../components/SeatRail'

export default function Home(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const createProject = useStore((s) => s.createProject)
  const removeProject = useStore((s) => s.removeProject)
  const openProject = useStore((s) => s.openProject)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')

  async function pickFolder(): Promise<void> {
    const folder = await window.synkora.pickFolder()
    if (folder) {
      setPath(folder)
      if (!name) setName(folder.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }

  async function submit(): Promise<void> {
    if (!name.trim() || !path) return
    await createProject(name.trim(), path)
    setCreating(false)
    setName('')
    setPath('')
  }

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-header">
          <div className="brand-mark">✦</div>
          <div>
            <div className="brand">SYNKORA</div>
            <div className="brand-sub">ambiente de desenvolvimento agêntico</div>
          </div>
        </header>

        <SeatRail />

        <div className="section-label">universos</div>

        <div className="project-grid">
          {projects.map((p) => (
            <div
              key={p.id}
              className="project-card"
              style={{ ['--card-hue' as string]: hueOf(p.name) }}
              onClick={() => openProject(p.id)}
            >
              <div className="project-avatar">{initialsOf(p.name)}</div>
              <div className="project-info">
                <div className="project-name">{p.name}</div>
                <div className="project-path">{p.path}</div>
              </div>
              <div className="project-meta">
                <span className="meta-dot idle" /> pronto
              </div>
              <button
                className="card-remove"
                title="Remover projeto da lista (não apaga a pasta)"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeProject(p.id)
                }}
              >
                ×
              </button>
            </div>
          ))}

          {creating ? (
            <div className="project-card new-form">
              <input
                autoFocus
                placeholder="Nome do projeto"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
              />
              <button className="btn ghost picker" onClick={() => void pickFolder()}>
                {path ? path : '📁 Escolher pasta…'}
              </button>
              <div className="form-actions">
                <button
                  className="btn"
                  disabled={!name.trim() || !path}
                  onClick={() => void submit()}
                >
                  Criar universo
                </button>
                <button className="btn ghost" onClick={() => setCreating(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button className="project-card add-card" onClick={() => setCreating(true)}>
              <span className="add-plus">+</span>
              Novo universo
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

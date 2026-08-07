import { useState } from 'react'
import { useStore, type Pane } from '../store'
import { hueOf, initialsOf } from '../util'

// ————————————————————————————————————————————————————————————————————————
// O CARD DE UM UNIVERSO — a mesma anatomia do núcleo do mapa (.map-core), de
// propósito: entrar no projeto deve ler como dar ZOOM no card que foi clicado.
//
// Regra de honestidade que vale mais que qualquer número bonito: painéis vivos
// só existem para projeto ABERTO nesta sessão (os panes nascem no renderer).
// Projeto que ainda não foi visitado diz "sessão fechada" — nunca "0 painéis",
// que seria mentira sobre um universo possivelmente cheio de trabalho.
// ————————————————————————————————————————————————————————————————————————

const NO_PANES: Pane[] = []

interface Props {
  projectId: string
  index: number
  /** registra a caixa do card como âncora de gravidade do campo de partículas */
  anchor: (key: string, el: HTMLElement | null) => void
}

export default function UniverseCard({ projectId, index, anchor }: Props): React.JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const stats = useStore((s) => s.homeStats[projectId])
  const panes = useStore((s) => s.panesByProject[projectId]) ?? NO_PANES
  const paneActivity = useStore((s) => s.paneActivity)
  const paneAttention = useStore((s) => s.paneAttention)
  const visited = useStore((s) => s.mountedProjects.includes(projectId))

  const openProject = useStore((s) => s.openProject)
  const removeProject = useStore((s) => s.removeProject)
  const renameProject = useStore((s) => s.renameProject)
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)
  const relocateProject = useStore((s) => s.relocateProject)

  const [relocError, setRelocError] = useState<string | null>(null)
  const [relocating, setRelocating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)

  if (!project) return null

  const missing = project.missing === true
  const vivos = panes.filter((p) => paneActivity[p.id] !== 'dead')
  const rodando = vivos.filter((p) => paneActivity[p.id] === 'run').length
  const pedindo = vivos.filter((p) => paneAttention[p.id]).length
  const hue = hueOf(project.name)

  async function relocate(): Promise<void> {
    if (relocating) return
    setRelocating(true)
    setRelocError(null)
    try {
      setRelocError(await relocateProject(projectId))
    } finally {
      setRelocating(false)
    }
  }

  function commitRename(): void {
    setRenaming(false)
    if (draft.trim() && draft.trim() !== project?.name) void renameProject(projectId, draft.trim())
  }

  const state = missing ? 'missing' : pedindo > 0 ? 'needs-perm' : rodando > 0 ? 'live' : ''
  // Atividade = o agregado das versões EM DESENVOLVIMENTO (decisão do usuário,
  // 2026-07-29): somar a história inteira do projeto vira ruído — a cada
  // release o recorte avança e os números renascem do zero. Pode haver várias
  // versões abertas ao mesmo tempo, então o card diz de QUANTAS o número vem
  // (a linha e o chip ◈). "Em curso" segue vivo e global.
  const versoes = stats?.versoes ?? []
  const agg = versoes.reduce(
    (a, v) => ({
      missoesFeitas: a.missoesFeitas + v.missoesFeitas,
      missoesTotal: a.missoesTotal + v.missoesTotal,
      feitas: a.feitas + v.feitas,
      total: a.total + v.total
    }),
    { missoesFeitas: 0, missoesTotal: 0, feitas: 0, total: 0 }
  )
  const activitySummary = !stats
    ? 'lendo atividade…'
    : [
        versoes.length > 1 ? `${versoes.length} versões` : null,
        agg.missoesTotal > 0
          ? `${agg.missoesFeitas}/${agg.missoesTotal} ${agg.missoesTotal === 1 ? 'missão' : 'missões'}`
          : null,
        agg.total > 0 ? `${agg.feitas}/${agg.total} tarefas` : null,
        stats.emCurso > 0 ? `${stats.emCurso} em curso` : null
      ]
        .filter(Boolean)
        .join(' · ') || 'sem trabalho em aberto'

  return (
    <article
      ref={(el) => anchor(`project:${projectId}`, el)}
      className={`universe-card ${state}${actionsOpen ? ' menu-open' : ''}`}
      style={{
        ['--card-hue' as string]: hue,
        animationDelay: `${Math.min(index * 55, 500)}ms`
      }}
      aria-busy={relocating}
      data-tip={missing ? 'A pasta deste universo não existe mais — clique para escolher a nova' : undefined}
    >
      <button
        type="button"
        className="uc-open-hit"
        aria-label={missing ? `Relocar pasta do universo ${project.name}` : `Abrir universo ${project.name}`}
        disabled={renaming || confirmDel || relocating || actionsOpen}
        onClick={() => {
          // pasta sumiu: o clique vira relocação — abrir levaria a um universo
          // cujo cwd não existe (todo pane nasceria morto)
          if (missing) void relocate()
          else openProject(projectId)
        }}
      />

      {actionsOpen && (
        <div
          className="uc-menu-dismiss"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setActionsOpen(false)
          }}
        />
      )}

      <div className="uc-head">
        {project.photo ? (
          <img className="core-photo" src={project.photo} alt="" draggable={false} />
        ) : (
          <i className="core-photo ph">{initialsOf(project.name)}</i>
        )}

        <div className="uc-identity">
          {renaming ? (
            <input
              className="uc-rename"
              aria-label={`Novo nome do universo ${project.name}`}
              autoFocus
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <span className="core-name" title={project.name}>{project.name}</span>
          )}
          <div className="uc-path" title={project.path}>{project.path}</div>
        </div>

        <div
          className={`uc-menu${actionsOpen ? ' open' : ''}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && actionsOpen) {
              e.preventDefault()
              setActionsOpen(false)
              e.currentTarget.querySelector<HTMLButtonElement>('.uc-menu-trigger')?.focus()
              return
            }

            if (!actionsOpen || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
            )
            if (items.length === 0) return
            e.preventDefault()
            const active = items.indexOf(document.activeElement as HTMLButtonElement)
            const direction = e.key === 'ArrowDown' ? 1 : -1
            const next = active < 0 ? (direction > 0 ? 0 : items.length - 1) : (active + direction + items.length) % items.length
            items[next]?.focus()
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActionsOpen(false)
          }}
        >
          <button
            type="button"
            className="uc-menu-trigger"
            aria-label={`Ações do universo ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((open) => !open)}
            onKeyDown={(e) => {
              if (actionsOpen || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
              e.preventDefault()
              const menu = e.currentTarget.parentElement
              setActionsOpen(true)
              window.requestAnimationFrame(() => {
                const items = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
                items?.[e.key === 'ArrowUp' ? items.length - 1 : 0]?.focus()
              })
            }}
          >
            ···
          </button>
          {actionsOpen && (
            <div className="uc-menu-pop" role="menu" aria-label={`Ações do universo ${project.name}`}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setActionsOpen(false)
                  setDraft(project.name)
                  setRenaming(true)
                }}
              >
                renomear
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setActionsOpen(false)
                  void setProjectPhoto(projectId)
                }}
              >
                trocar imagem
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={relocating}
                onClick={() => {
                  setActionsOpen(false)
                  void relocate()
                }}
              >
                alterar pasta
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setActionsOpen(false)
                  setConfirmDel(true)
                }}
              >
                remover da lista
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="uc-work">
        <span className="uc-work-label">atividade</span>
        <span className={`uc-work-text${stats ? '' : ' loading'}`}>{activitySummary}</span>
        {stats && (agg.total > 0 || agg.missoesTotal > 0) && (
          <div
            className="uc-progress"
            data-tip={
              (agg.total > 0
                ? `${agg.feitas} de ${agg.total} tarefas concluídas`
                : `${agg.missoesFeitas} de ${agg.missoesTotal} missões entregues`) +
              (versoes.length === 1
                ? ` na ◈${versoes[0].name}`
                : ` nas ${versoes.length} versões em dev`)
            }
          >
            <i
              style={{
                width: `${Math.round(
                  (agg.total > 0
                    ? agg.feitas / agg.total
                    : agg.missoesFeitas / agg.missoesTotal) * 100
                )}%`
              }}
            />
          </div>
        )}
      </div>

      <div className="uc-tele">
        <span className={`led ${missing || relocError ? 'dead' : rodando > 0 ? 'run' : ''}`} aria-hidden="true" />
        {relocError ? (
          <span className="uc-warn" role="alert">{relocError}</span>
        ) : missing ? (
          <span className="uc-warn">pasta não encontrada</span>
        ) : pedindo > 0 ? (
          <span className="uc-warn">
            {pedindo} {pedindo === 1 ? 'permissão pendente' : 'permissões pendentes'}
          </span>
        ) : visited ? (
          <span>
            {vivos.length === 0
              ? 'nenhum painel aberto'
              : `${vivos.length} ${vivos.length === 1 ? 'painel' : 'painéis'}${rodando > 0 ? ` · ${rodando} rodando` : ''}`}
          </span>
        ) : (
          <span>sessão fechada</span>
        )}
        <span className="uc-tele-end">
          {versoes.length > 0 && (
            <span
              className={`uc-version ${versoes[0].lancada ? 'live' : ''}`}
              data-tip={
                versoes[0].lancada
                  ? 'Versão mais recente já lançada na branch base'
                  : versoes.length === 1
                    ? 'Versão aberta em construção'
                    : `Em desenvolvimento: ${versoes.map((v) => v.name).join(' · ')}`
              }
            >
              ◈ {versoes.length === 1 ? versoes[0].name : `${versoes.length} em dev`}
            </span>
          )}
          <span className="uc-enter" aria-hidden="true">{missing ? 'realocar' : 'abrir'} →</span>
        </span>
      </div>

      {/* confirmação DENTRO do card: window.confirm quebra o foco da janela no
          Windows (cliques param de funcionar até refocar) */}
      {confirmDel && (
        <div className="uc-confirm" role="group" aria-label={`Remover universo ${project.name}`}>
          <span>remove só da lista; a pasta fica intacta</span>
          <button type="button" className="btn tiny danger" onClick={() => void removeProject(projectId)}>
            remover
          </button>
          <button type="button" className="btn ghost tiny" autoFocus onClick={() => setConfirmDel(false)}>
            cancelar
          </button>
        </div>
      )}
    </article>
  )
}

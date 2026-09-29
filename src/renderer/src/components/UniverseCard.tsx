import { useState, type CSSProperties } from 'react'
import { useStore, type Pane } from '../store'
import { hueOf, initialsOf } from '../util'
import { useProjectLayout } from '../projectLayoutStore'
import { groupOfProject, layoutGroups } from '../../../shared/projectLayout'
import { highlightMatch } from '../homeIndexModel'
import { HomePopover } from './HomeIndexBar'

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
  /** a busca do índice da Home: o trecho achado ganha <mark> no nome e na pasta */
  query?: string
  /** a etiqueta do grupo na linha de meta (visão "todos juntos") */
  showGroup?: boolean
  /** a data da linha de meta: "criado 24 set 2026" ou "aberto há 2 h" */
  dateLabel?: string | null
}

interface CardMenu {
  trigger: HTMLElement
  /** o card é o DONO do menu: apertar dentro dele é assunto da cortina
   *  `.uc-menu-dismiss`, que fecha sem deixar o clique abrir o universo */
  card: HTMLElement | null
  focus: 'first' | 'last'
}

/** O texto com o trecho da busca marcado (sem busca, o texto puro). */
function Marked({ text, query }: { text: string; query: string }): React.JSX.Element {
  const parts = highlightMatch(text, query)
  if (!parts) return <>{text}</>
  return (
    <>
      {parts.before}
      <mark>{parts.match}</mark>
      {parts.after}
    </>
  )
}

export default function UniverseCard({
  projectId,
  index,
  anchor,
  query = '',
  showGroup = false,
  dateLabel = null
}: Props): React.JSX.Element | null {
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
  const layout = useProjectLayout((s) => s.layout)
  const applyLayout = useProjectLayout((s) => s.apply)
  const openGroupSheet = useProjectLayout((s) => s.openGroupSheet)

  const [relocError, setRelocError] = useState<string | null>(null)
  const [relocating, setRelocating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  // o menu ··· sai do card por portal: com "mover para grupo" ele passa da
  // altura da ficha, e a ficha (overflow: hidden) cortaria o que transborda
  const [menu, setMenu] = useState<CardMenu | null>(null)
  const actionsOpen = menu !== null

  if (!project) return null

  const missing = project.missing === true
  const vivos = panes.filter((p) => paneActivity[p.id] !== 'dead')
  const rodando = vivos.filter((p) => paneActivity[p.id] === 'run').length
  const pedindo = vivos.filter((p) => paneAttention[p.id]).length
  const hue = hueOf(project.name)
  const groups = layout ? layoutGroups(layout) : []
  const currentGroup = layout ? groupOfProject(layout, projectId) : null
  const groupTag = showGroup ? currentGroup : null

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

  function openMenu(trigger: HTMLElement, focus: CardMenu['focus']): void {
    setMenu({ trigger, card: trigger.closest<HTMLElement>('.universe-card'), focus })
  }

  /** fecha o menu e executa a escolha */
  const pick = (run: () => void) => (): void => {
    setMenu(null)
    run()
  }

  async function newGroup(): Promise<void> {
    const result = await applyLayout({ op: 'createGroup', projectId })
    // nasce "grupo N" e a folha de nome abre com o texto selecionado (iPhone)
    if (result?.createdGroupId) openGroupSheet(result.createdGroupId, true)
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
      missoesTotal: a.missoesTotal + v.missoesTotal
    }),
    { missoesFeitas: 0, missoesTotal: 0 }
  )
  const activitySummary = !stats
    ? 'lendo atividade…'
    : [
        versoes.length > 1 ? `${versoes.length} versões` : null,
        agg.missoesTotal > 0
          ? `${agg.missoesFeitas}/${agg.missoesTotal} ${agg.missoesTotal === 1 ? 'missão' : 'missões'}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'sem trabalho em aberto'

  return (
    <article
      ref={(el) => anchor(`project:${projectId}`, el)}
      className={`universe-card ${state}`}
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
            setMenu(null)
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
            <span className="core-name" title={project.name}>
              <Marked text={project.name} query={query} />
            </span>
          )}
          <div className="uc-path" title={project.path}>
            <Marked text={project.path} query={query} />
          </div>
          {(groupTag || dateLabel) && (
            <div className="uc-meta">
              {groupTag && (
                <span className="uc-group">
                  <span
                    className={`sw${groupTag.hue !== null ? ' hue' : ''}`}
                    style={groupTag.hue !== null ? ({ '--g-hue': groupTag.hue } as CSSProperties) : undefined}
                    aria-hidden="true"
                  />
                  <span>{groupTag.name}</span>
                </span>
              )}
              {dateLabel && <span className="uc-date">{dateLabel}</span>}
            </div>
          )}
        </div>

        <div className={`uc-menu${actionsOpen ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="uc-menu-trigger"
            aria-label={`Ações do universo ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            onClick={(e) => (actionsOpen ? setMenu(null) : openMenu(e.currentTarget, 'first'))}
            onKeyDown={(e) => {
              if (actionsOpen || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
              e.preventDefault()
              openMenu(e.currentTarget, e.key === 'ArrowUp' ? 'last' : 'first')
            }}
          >
            ···
          </button>
          {menu && (
            <HomePopover
              anchor={menu.trigger}
              owner={menu.card}
              className="uc-menu-pop is-floating"
              role="menu"
              label={`Ações do universo ${project.name}`}
              itemSelector='[role="menuitem"]'
              initialFocus={menu.focus}
              gap={4}
              onClose={() => setMenu(null)}
            >
              <button
                type="button"
                role="menuitem"
                onClick={pick(() => {
                  setDraft(project.name)
                  setRenaming(true)
                })}
              >
                renomear
              </button>
              <button type="button" role="menuitem" onClick={pick(() => void setProjectPhoto(projectId))}>
                trocar imagem
              </button>
              <button type="button" role="menuitem" disabled={relocating} onClick={pick(() => void relocate())}>
                alterar pasta
              </button>
              {layout && (
                <>
                  <div className="uc-menu-sep" role="separator" />
                  <div className="uc-menu-label" aria-hidden="true">
                    mover para grupo
                  </div>
                  {groups.map((g) => {
                    const here = g.id === currentGroup?.id
                    return (
                      <button
                        key={g.id}
                        type="button"
                        role="menuitem"
                        className="uc-menu-group"
                        aria-label={here ? `${g.name} (grupo atual)` : `Mover para ${g.name}`}
                        disabled={here}
                        onClick={pick(() => void applyLayout({ op: 'moveToGroup', projectId, groupId: g.id }))}
                      >
                        <span
                          className={`sw${g.hue !== null ? ' hue' : ''}`}
                          style={g.hue !== null ? ({ '--g-hue': g.hue } as CSSProperties) : undefined}
                          aria-hidden="true"
                        />
                        <span className="name">{g.name}</span>
                        <span className="tail">{here ? 'aqui' : g.projectIds.length}</span>
                      </button>
                    )
                  })}
                  <button type="button" role="menuitem" onClick={pick(() => void newGroup())}>
                    + novo grupo…
                  </button>
                  {currentGroup && (
                    <button
                      type="button"
                      role="menuitem"
                      className="uc-menu-group"
                      onClick={pick(() => void applyLayout({ op: 'removeFromGroup', projectId }))}
                    >
                      <span className="name">tirar de {currentGroup.name}</span>
                    </button>
                  )}
                  <div className="uc-menu-sep" role="separator" />
                </>
              )}
              <button type="button" role="menuitem" className="danger" onClick={pick(() => setConfirmDel(true))}>
                remover da lista
              </button>
            </HomePopover>
          )}
        </div>
      </div>

      <div className="uc-work">
        <span className="uc-work-label">atividade</span>
        <span className={`uc-work-text${stats ? '' : ' loading'}`}>{activitySummary}</span>
        {/* A barra mede MISSÕES entregues. Media tarefas quando havia card;
            eles morreram na purga F6 (2026-08-17) e a missão virou a unidade. */}
        {stats && agg.missoesTotal > 0 && (
          <div
            className="uc-progress"
            data-tip={
              `${agg.missoesFeitas} de ${agg.missoesTotal} missões entregues` +
              (versoes.length === 1
                ? ` na ◈${versoes[0].name}`
                : ` nas ${versoes.length} versões em dev`)
            }
          >
            <i
              style={{
                width: `${Math.round((agg.missoesFeitas / agg.missoesTotal) * 100)}%`
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

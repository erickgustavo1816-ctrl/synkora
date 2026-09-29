import type { CSSProperties, ReactNode } from 'react'
import type { ProjectLayoutGroupEntry } from '../../../shared/projectLayout'
import { useStore, type Mission } from '../store'
import { projectMissionActivity, type ProjectMissionActivity } from '../projectMissionActivity'
import { railFolderHoldsActive, railFolderMinis, railFolderSignal, type RailFolderSignal } from '../railGroupPresentation'
import { hueOf, initialsOf } from '../util'

// ————————————————————————————————————————————————————————————————————————
// O GRUPO NO RAIL (missão "Nova features de Grupos", 2026-09-29).
//
// Fechado, é a PASTA do Discord: 46 px, fundo mais claro que as miniaturas,
// grade 2×2 (com mais de 4, três e um +N). Aberto, é a CÁPSULA: o ícone de
// pasta no topo fecha, e os universos ficam dentro. A FORMA diz "grupo" antes
// da cor; a cor do grupo só tinge o fundo — é identificação, nunca estado.
// Contrato visual: docs/mockups/grupos-universos-2026-09-29.html.
// ————————————————————————————————————————————————————————————————————————

// Referência estável para seletores (regra do projeto: nunca `?? []` inline).
const NO_PANES: never[] = []
const NO_MISSIONS: Mission[] = []

type StoreState = ReturnType<typeof useStore.getState>

/** Um agente deste universo espera o dono (permissão / pergunta) — visível
 *  de QUALQUER lugar (pedido do dono, 2026-08-06). */
export function railProjectAttention(s: StoreState, projectId: string): boolean {
  return (s.panesByProject[projectId] ?? NO_PANES).some((p) => s.paneAttention[p.id])
}

export function railProjectActivity(s: StoreState, projectId: string): ProjectMissionActivity {
  return projectMissionActivity(projectId, s.missionsByProject[projectId] ?? NO_MISSIONS, s.guiPanes)
}

function folderSignalOf(s: StoreState, projectIds: readonly string[]): RailFolderSignal {
  return railFolderSignal(
    projectIds.map((id) => ({
      missing: s.projects.find((p) => p.id === id)?.missing === true,
      attention: railProjectAttention(s, id),
      activity: railProjectActivity(s, id)
    }))
  )
}

export function hueStyle(hue: number | null): CSSProperties | undefined {
  return hue === null ? undefined : ({ ['--g-hue' as string]: hue } as CSSProperties)
}

export const FOLDER_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3c.4 0 .8.2 1.1.5L11.5 7h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
)

// ┌──────────────────────────────────────────────────────────────────────┐
// │ A GRADE DE MINIATURAS DA PASTA — bloco VISUAL isolado (2026-09-29).   │
// │ O dono ainda está redesenhando o miolo da pasta fechada: a forma das  │
// │ miniaturas mora SÓ aqui (RailMini + RailFolderGrid) e nas regras      │
// │ .rf-grid / .rf-mini do ProjectRail.css (bloco com a mesma moldura).   │
// │ Contrato para quem redesenhar: RailFolderGrid recebe os ids do grupo  │
// │ e o universo aberto; quais ids aparecem e o "+N" vêm de               │
// │ railFolderMinis (puro, testado). Nada de comportamento depende disto. │
// └──────────────────────────────────────────────────────────────────────┘

function RailMini({ projectId, active }: { projectId: string; active: boolean }): React.JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  if (!project) return null
  const missing = project.missing === true
  return (
    <span
      className={`rf-mini${active ? ' is-active' : ''}${missing ? ' is-missing' : ''}`}
      style={{ ['--card-hue' as string]: hueOf(project.name) }}
    >
      {project.photo ? <img src={project.photo} alt="" draggable={false} /> : initialsOf(project.name).slice(0, 1)}
    </span>
  )
}

/** A grade de miniaturas (a pasta do rail, o fantasma do arraste e a folha). */
export function RailFolderGrid({
  projectIds,
  activeProjectId
}: {
  projectIds: readonly string[]
  activeProjectId: string | null
}): React.JSX.Element {
  const minis = railFolderMinis(projectIds)
  return (
    <span className="rf-grid" aria-hidden="true">
      {minis.ids.map((id) => (
        <RailMini key={id} projectId={id} active={id === activeProjectId} />
      ))}
      {minis.more > 0 && <span className="rf-mini more">+{minis.more}</span>}
    </span>
  )
}

// └─────────────────────── fim do bloco da grade ───────────────────────┘

function SignalDot({ signal }: { signal: RailFolderSignal }): React.JSX.Element | null {
  if (signal === 'attention') return <span className="rail-ask-dot" aria-hidden="true" />
  if (signal === 'running' || signal === 'paused') {
    return <span className="rail-mission-dot" data-activity={signal} aria-hidden="true" />
  }
  if (signal === 'missing') return <span className="rail-warn-dot" aria-hidden="true" />
  return null
}

const SIGNAL_LABEL: Record<Exclude<RailFolderSignal, null>, string> = {
  attention: 'um agente está esperando você',
  running: 'há trabalho em andamento',
  paused: 'há trabalho em espera',
  missing: 'uma pasta não foi encontrada'
}

function universesLabel(count: number): string {
  return `${count} ${count === 1 ? 'universo' : 'universos'}`
}

interface FolderProps {
  group: ProjectLayoutGroupEntry
  activeProjectId: string | null
  showName: boolean
  /** durante o arraste as dicas calam (a pílula "soltar: …" fala por elas) */
  tipsOff: boolean
  isDragging: boolean
  dropInto: boolean
  justMade: boolean
  onOpen: (groupId: string) => void
}

/** O grupo FECHADO: a pasta. Clique abre a cápsula. */
export function RailGroupFolder({
  group,
  activeProjectId,
  showName,
  tipsOff,
  isDragging,
  dropInto,
  justMade,
  onOpen
}: FolderProps): React.JSX.Element {
  const signal = useStore((s) => folderSignalOf(s, group.projectIds))
  const holdsActive = railFolderHoldsActive(group.projectIds, activeProjectId)
  const className = [
    'rail-item rail-folder',
    group.hue !== null ? 'has-hue' : '',
    holdsActive ? 'holds-active' : '',
    signal === 'attention' ? 'attn' : '',
    dropInto ? 'drop-into' : '',
    justMade ? 'just-made' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={`rail-slot-folder${isDragging ? ' is-dragging' : ''}`} data-slot="g" data-gid={group.id}>
      <button
        type="button"
        className={className}
        style={hueStyle(group.hue)}
        data-folder={group.id}
        aria-expanded={false}
        aria-label={`Grupo ${group.name}, ${universesLabel(group.projectIds.length)}${signal ? ` — ${SIGNAL_LABEL[signal]}` : ''}`}
        // hover da pasta = SÓ o nome do grupo (pedido do dono, 2026-09-29)
        data-tip-side="right" data-tip={tipsOff ? undefined : group.name.toLocaleUpperCase('pt-BR')}
        onClick={() => onOpen(group.id)}
      >
        <RailFolderGrid projectIds={group.projectIds} activeProjectId={activeProjectId} />
        <SignalDot signal={signal} />
      </button>
      {showName && <span className="rail-group-name">{group.name}</span>}
    </div>
  )
}

interface CapsuleProps {
  group: ProjectLayoutGroupEntry
  showName: boolean
  tipsOff: boolean
  isDragging: boolean
  justOpened: boolean
  onClose: (groupId: string) => void
  /** os universos do grupo (RailItem do ProjectRail) */
  children: ReactNode
}

/** O grupo ABERTO: a cápsula. O ícone de pasta do topo fecha. */
export function RailGroupCapsule({
  group,
  showName,
  tipsOff,
  isDragging,
  justOpened,
  onClose,
  children
}: CapsuleProps): React.JSX.Element {
  const className = [
    'rail-group',
    group.hue !== null ? 'has-hue' : '',
    justOpened ? 'just-opened' : '',
    isDragging ? 'is-dragging' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={className} style={hueStyle(group.hue)} data-slot="go" data-gid={group.id}>
      <div className="rail-group-headwrap" data-headwrap="">
        <button
          type="button"
          className="rail-item rail-group-head"
          data-head={group.id}
          aria-expanded={true}
          aria-label={`Grupo ${group.name}, ${universesLabel(group.projectIds.length)} — fechar`}
          data-tip-side="right" data-tip={tipsOff ? undefined : group.name.toLocaleUpperCase('pt-BR')}
          onClick={() => onClose(group.id)}
        >
          {FOLDER_ICON}
        </button>
        {showName && <span className="rail-group-name">{group.name}</span>}
      </div>
      {children}
    </div>
  )
}

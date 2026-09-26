import { useState } from 'react'
import { missionTypeOf, type Mission } from '../store'
import type { MissionColumnEntry } from './MissionColumn'
import {
  missionStatePill,
  waitingOnOwner,
  type MissionSignal,
  type MissionTone
} from '../missionPresentation'
import { missionDayLabel } from '../projectLanding'
import { missionWorkspace } from '../missionWorkspace'
import { missionHistory, type MissionCommit } from '../missionHistory'
import WorkspaceIcon from '../workspace/WorkspaceIcon'

// A linha de missão VIVA do painel do projeto (`setMissionTab` só resolve
// missão viva; a integrada é leitura, desenhada pelo `ProjectDashboard`).
//
// A gaveta "Mudanças" lê o Git SÓ no clique, uma missão por vez: dez linhas
// lendo no mount seriam dez processos por render. As costuras são as mesmas do
// trilho de entrega — o painel não fala com `window.synkora` direto.

const DRAWER_COMMIT_CAP = 3

// o selo só ganha cor quando é notícia para o dono; no resto quem colore é o ponto
const PILL_CLASS: Record<MissionTone, string> = { ask: ' ask', err: ' err', busy: '', ok: '' }

interface DrawerState {
  status: 'loading' | 'ready' | 'error'
  error?: string
  ahead?: number
  insertions?: number
  deletions?: number
  files?: number
  commits?: MissionCommit[]
}

function commitDay(iso: string): string {
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return ''
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(at)
}

export default function MissionDashboardRow({
  mission,
  entry,
  onOpen
}: {
  mission: Mission
  entry?: MissionColumnEntry
  onOpen: (missionId: string) => void
}): React.JSX.Element {
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [open, setOpen] = useState(false)

  const signal: MissionSignal = { mission, pulse: entry?.pulse }
  const pill = missionStatePill(signal)
  const waiting = waitingOnOwner(signal)
  const planning = missionTypeOf(mission) === 'planejamento'
  const day = missionDayLabel(mission)
  const seat = [entry?.seatName, entry?.model].filter(Boolean).join(' · ')
  // planejamento escreve `plano/` na raiz: não há diff de worktree para abrir
  const canDisclose = !planning && Boolean(mission.branch)

  async function toggle(): Promise<void> {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (drawer) return
    setDrawer({ status: 'loading' })
    const [files, history] = await Promise.all([
      missionWorkspace.files(mission.id),
      missionHistory.commits(mission.id)
    ])
    if (!files.ok && !history.ok) {
      setDrawer({
        status: 'error',
        error: files.error ?? history.error ?? 'não deu para ler esta branch'
      })
      return
    }
    setDrawer({
      status: 'ready',
      ahead: files.summary?.ahead ?? 0,
      insertions: files.summary?.insertions ?? 0,
      deletions: files.summary?.deletions ?? 0,
      files: files.summary?.files.length ?? 0,
      commits: history.commits ?? []
    })
  }

  const tip = [
    waiting ? `${mission.title}\nEsta missão espera você: abra a conversa para destravar` : `Abrir ${mission.title}`,
    entry?.queueLabel
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <li className={`pd-row${canDisclose ? ' has-tool' : ''}${open ? ' open' : ''}`}>
      <div className="pd-row-line">
        <button type="button" className="pd-row-open" data-tip={tip} onClick={() => onOpen(mission.id)}>
          <span className={`pd-dot ${pill.tone}`} aria-hidden="true" />
          <span className="pd-row-text">
            <span className="pd-row-title">{mission.title}</span>
            <span className="pd-row-meta">
              {planning ? (
                <span>
                  <WorkspaceIcon name="plan" />
                  escreve plano/
                </span>
              ) : (
                <span>
                  <WorkspaceIcon name="branch" />
                  {mission.branch ?? 'sem branch (repo novo)'}
                </span>
              )}
              {seat && <span>{seat}</span>}
              {day && <span>{day}</span>}
            </span>
          </span>
          <span className={`pd-pill${PILL_CLASS[pill.tone]}`}>
            {mission.integration?.state === 'queued' && <WorkspaceIcon name="queue" />}
            {pill.label}
          </span>
        </button>
        {canDisclose && (
          <button
            type="button"
            className="pd-row-tool"
            aria-expanded={open}
            data-tip="Lê o diff desta branch contra a base — só quando você pede"
            onClick={() => void toggle()}
          >
            Mudanças
            <WorkspaceIcon name="chevron" />
          </button>
        )}
      </div>
      {open && (
        <div className="pd-drawer">
          {(!drawer || drawer.status === 'loading') && (
            <span className="pd-drawer-note">lendo a branch…</span>
          )}
          {drawer?.status === 'error' && <span className="pd-drawer-note err">{drawer.error}</span>}
          {drawer?.status === 'ready' && (
            <>
              <span className="pd-drawer-stats">
                <span>
                  <b>{drawer.ahead}</b> {drawer.ahead === 1 ? 'commit' : 'commits'} à frente
                </span>
                <span>
                  <span className="pd-ins">+{drawer.insertions}</span>{' '}
                  <span className="pd-del">−{drawer.deletions}</span>
                </span>
                <span>
                  {drawer.files} {drawer.files === 1 ? 'arquivo' : 'arquivos'}
                </span>
              </span>
              {drawer.commits && drawer.commits.length > 0 ? (
                <ul className="pd-commits">
                  {drawer.commits.slice(0, DRAWER_COMMIT_CAP).map((commit) => (
                    <li key={commit.sha} className="pd-commit">
                      <span className="pd-commit-subject">{commit.subject}</span>
                      <span className="pd-commit-at">{commitDay(commit.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="pd-drawer-note">
                  ainda não há commit nesta branch — o trabalho está no worktree
                </span>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}

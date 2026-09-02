import { useState } from 'react'
import { missionTypeOf, type Mission } from '../store'
import type { MissionColumnEntry } from './MissionColumn'
import {
  MISSION_STATUS_LABEL,
  badgeFor,
  dotClass,
  waitingOnOwner,
  type MissionSignal
} from '../missionPresentation'
import { missionDayLabel } from '../projectLanding'
import { missionWorkspace } from '../missionWorkspace'
import { missionHistory, type MissionCommit } from '../missionHistory'

// A LINHA DE MISSÃO DO PAINEL DO PROJETO (2026-08-17).
//
// Ela morava dentro do `ProjectDashboard` como um `MissionRow` de três linhas.
// Saiu para cá quando ganhou a GAVETA: a linha passou a poder responder "o que
// essa branch já mudou?" sem o dono abrir a missão — e isso é estado próprio
// (busca, erro, resultado) que não pertence ao painel inteiro.
//
// SÓ MISSÃO VIVA (R38, 2026-08-24). A linha tinha um modo `done` — leitura,
// sem clique e sem gaveta — para a seção "integradas" do painel. Aquela seção
// morreu na fusão das duas listas repetidas (a obra por dia conta o que já
// integrou, em linha fina), e um modo sem chamador é dívida, não proteção.
// Missão encerrada não é botão de jeito nenhum: `setMissionTab` só resolve
// missão viva, e o histórico dela mora na aba Versões.
//
// SOB DEMANDA, SEMPRE. A leitura só acontece no clique do dono, uma missão por
// vez: um painel com dez missões abertas que dispara dez leituras de Git no
// mount custaria dez processos por render e é exatamente o leque que o desenho
// proíbe. Fechada, a gaveta não custa nada.
//
// As duas costuras (`missionWorkspace`, `missionHistory`) são as MESMAS que o
// trilho de entrega usa — o painel não fala com `window.synkora` direto.

/** Quantos commits a gaveta mostra: ela dá o pulso da branch, não o histórico
 *  (o grafo inteiro é do trilho da missão). */
const DRAWER_COMMIT_CAP = 3

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
  versionLabel,
  onOpen
}: {
  mission: Mission
  entry?: MissionColumnEntry
  versionLabel?: string
  onOpen: (missionId: string) => void
}): React.JSX.Element {
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [open, setOpen] = useState(false)

  const signal: MissionSignal = { mission, pulse: entry?.pulse }
  const badge = badgeFor(signal)
  const waiting = waitingOnOwner(signal)
  const planning = missionTypeOf(mission) === 'planejamento'
  const day = missionDayLabel(mission)
  const label = MISSION_STATUS_LABEL[mission.status]
  const seat = [entry?.seatName, entry?.model].filter(Boolean).join(' · ')
  // PLANEJAMENTO NÃO TEM BRANCH: ele escreve `plano/` na raiz, então não há
  // diff de worktree para abrir.
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

  const head = (
    <>
      <span className="pd-head">
        <span className={`pd-dot ${dotClass(signal)}`} aria-hidden="true" />
        <span className="pd-title">{mission.title}</span>
        <span className={`pd-status ${mission.status}`}>{label}</span>
        {badge && <span className={`pd-badge ${badge.kind}`}>{badge.glyph}</span>}
      </span>
      <span className="pd-meta">
        {versionLabel && <span className="pd-version-tag">◈ {versionLabel}</span>}
        {planning ? (
          <span className="pd-branch">✎ planejamento · escreve plano/</span>
        ) : (
          <span className="pd-branch">⎇ {mission.branch ?? 'sem branch (repo novo)'}</span>
        )}
        {/* A CONTA E O MODELO que a coluna da esquerda já mostra: aqui eles
            dizem quem está gastando o limite naquela conversa. */}
        {seat && <span className="pd-seat">{seat}</span>}
        {entry?.queueLabel && <span className="pd-queue">{entry.queueLabel}</span>}
        {day && <span className="pd-day">{day}</span>}
      </span>
      {waiting && (
        <span className="pd-waiting">
          {entry?.pulse ? `❓ ${entry.pulse}` : '⇪ a integração espera o seu aval no trilho de entrega'}
        </span>
      )}
    </>
  )

  const className = `pd-mission${waiting ? ' waiting' : ''}`

  const openButton = (
    <button
      type="button"
      className={className}
      data-tip={
        waiting
          ? `❓ ESTA MISSÃO ESPERA VOCÊ:\nabra a conversa para destravar`
          : `Abrir ${mission.title}`
      }
      onClick={() => onOpen(mission.id)}
    >
      {head}
    </button>
  )

  // SEM GAVETA, SEM INVÓLUCRO: a linha continua sendo exatamente o botão que
  // sempre foi (e que o CSS de `button.pd-mission` veste).
  if (!canDisclose) return openButton

  // COM GAVETA, o botão da missão NÃO muda: a gaveta é IRMÃ dele, recuada
  // logo abaixo. Botão dentro de botão é HTML inválido — e reaproveitar o
  // invólucro como o cartão faria toda a roupa de `button.pd-mission`
  // (cursor, hover, foco) deixar de alcançar alguma coisa.
  return (
    <div className="pd-mission-box">
      {openButton}
      <button
        type="button"
        className="pd-drawer-toggle"
        aria-expanded={open}
        data-tip="Lê o diff desta branch contra a base — só quando você pede"
        onClick={() => void toggle()}
      >
        {open ? '▾' : '▸'} o que esta branch já mudou
      </button>
      {open && (
        <div className="pd-drawer">
          {(!drawer || drawer.status === 'loading') && (
            <span className="pd-drawer-note">lendo a branch…</span>
          )}
          {drawer?.status === 'error' && (
            <span className="pd-drawer-note err">✗ {drawer.error}</span>
          )}
          {drawer?.status === 'ready' && (
            <>
              <span className="pd-drawer-stat">
                <b>⇡ {drawer.ahead}</b> {drawer.ahead === 1 ? 'commit' : 'commits'} à frente
                <span className="pd-drawer-sep">·</span>
                <span className="pd-drawer-ins">+{drawer.insertions}</span>{' '}
                <span className="pd-drawer-del">−{drawer.deletions}</span>
                <span className="pd-drawer-sep">·</span>
                {drawer.files} {drawer.files === 1 ? 'arquivo' : 'arquivos'}
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
    </div>
  )
}

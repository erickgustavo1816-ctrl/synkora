import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProgressCardPreview,
  ProgressCoordinatorSnapshot,
  ProgressMissionSnapshot,
  ProgressOverlaySnapshot,
  ProgressProjectSnapshot
} from '../../../preload/index'
import { progressCompletionFeed } from '../progressHistory'
import SynkoraMark from './SynkoraMark'

const EMPTY_SNAPSHOT: ProgressOverlaySnapshot = {
  revision: 0,
  generatedAt: new Date(0).toISOString(),
  totals: {
    projects: 0,
    activeProjects: 0,
    activeMissions: 0,
    activeCards: 0,
    activeCoordinators: 0,
    attentionMissions: 0,
    attentionProjects: 0,
    recentCompletions: 0
  },
  projects: []
}

function plural(value: number, one: string, many = `${one}s`): string {
  return `${value} ${value === 1 ? one : many}`
}

function relativeCompletion(iso: string | undefined): string {
  if (!iso) return 'recentemente'
  const value = new Date(iso)
  if (!Number.isFinite(value.getTime())) return 'recentemente'
  const now = new Date()
  const sameDay = value.toDateString() === now.toDateString()
  if (sameDay) return `hoje, ${value.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (value.toDateString() === yesterday.toDateString()) {
    return `ontem, ${value.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  }
  return value.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

function overallSummary(snapshot: ProgressOverlaySnapshot, completion?: string): string {
  if (snapshot.totals.attentionMissions > 0) {
    return `${plural(snapshot.totals.attentionMissions, 'missão')} precisa${snapshot.totals.attentionMissions === 1 ? '' : 'm'} de atenção`
  }
  if (snapshot.totals.attentionProjects > 0) {
    return `${plural(snapshot.totals.attentionProjects, 'projeto')} precisa${snapshot.totals.attentionProjects === 1 ? '' : 'm'} de atenção`
  }
  if (completion) return `“${completion}” terminou`
  const active: string[] = []
  if (snapshot.totals.activeCoordinators > 0) {
    active.push(`${plural(snapshot.totals.activeCoordinators, 'coordenador')} trabalhando`)
  }
  if (snapshot.totals.activeCards > 0) {
    active.push(`${plural(snapshot.totals.activeCards, 'card')} em andamento`)
  }
  if (active.length > 0) return active.join(' · ')
  if (snapshot.totals.activeMissions > 0) return `${plural(snapshot.totals.activeMissions, 'missão')} sendo acompanhada${snapshot.totals.activeMissions === 1 ? '' : 's'}`
  if (snapshot.totals.recentCompletions > 0) return 'Tudo terminou por enquanto'
  return 'Nada rodando agora'
}

function cardActor(card: ProgressCardPreview): string {
  if (card.phaseState === 'pending' || card.phaseState === 'finalizing') return 'Pipeline'
  if (card.phase === 'review') return 'Revisor'
  if (card.phase === 'qa') return 'QA'
  if (card.phase === 'dev') return 'Executor'
  return 'Pipeline'
}

// Pill de status por agente (a ideia do radar detalhado, 2026-08-06): bater o
// olho e saber QUEM está trabalhando, travado ou esperando — com o frescor
// "há Xs" dizendo se a informação é de agora ou de meia hora atrás.
const PILL_LABEL: Record<string, string> = {
  attention: 'travado',
  running: 'trabalhando',
  waiting: 'aguardando',
  success: 'finalizado',
  idle: 'ocioso'
}

function freshLabel(iso: string | undefined, nowMs: number): string | null {
  if (!iso) return null
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return null
  const diff = Math.max(0, Math.round((nowMs - at) / 1000))
  if (diff < 60) return `há ${diff}s`
  if (diff < 3600) return `há ${Math.round(diff / 60)}min`
  if (diff < 86_400) return `há ${Math.round(diff / 3600)}h`
  return null
}

function StatusPill({
  tone,
  label,
  updatedAt,
  nowMs
}: {
  tone: string
  label?: string
  updatedAt?: string
  nowMs: number
}): React.JSX.Element {
  const fresh = freshLabel(updatedAt, nowMs)
  return (
    <span className={`progress-pill tone-${tone}`}>
      <b>{label ?? PILL_LABEL[tone] ?? tone}</b>
      {fresh && <small>{fresh}</small>}
    </span>
  )
}

function QuestionLine({ question }: { question: string }): React.JSX.Element {
  return (
    <span className="progress-question">
      <em>❓ esperando VOCÊ</em>
      <span>{question}</span>
    </span>
  )
}

interface CompactFocus {
  title: string
  detail: string
  tone: 'attention' | 'running' | 'success' | 'idle'
}

function compactFocus(
  snapshot: ProgressOverlaySnapshot,
  completion?: string
): CompactFocus {
  // pergunta pendente vence tudo — é o dono que está segurando o fluxo
  for (const project of snapshot.projects) {
    const question =
      project.question ?? project.activeMissions.find((mission) => mission.question)?.question
    if (question) {
      return { title: 'Pergunta esperando você', detail: question, tone: 'attention' }
    }
  }
  for (const project of snapshot.projects) {
    const mission = project.activeMissions.find((candidate) => candidate.tone === 'attention')
    if (mission) {
      return {
        title: `Atenção · ${mission.label}`,
        detail: `${project.name} / ${mission.title}`,
        tone: 'attention'
      }
    }
  }
  for (const project of snapshot.projects) {
    if (project.tone === 'attention') {
      return {
        title: `Atenção · ${project.label}`,
        detail: project.masterPlan?.label
          ? `${project.name} / ${project.masterPlan.label}`
          : project.name,
        tone: 'attention'
      }
    }
  }
  for (const project of snapshot.projects) {
    const coordinator = project.coordinators[0]
    if (coordinator) {
      return {
        title: `${coordinator.roleLabel} · ${coordinator.label}`,
        detail: coordinator.detail
          ? `${project.name} / ${coordinator.detail}`
          : project.name,
        tone: 'running'
      }
    }
  }
  for (const project of snapshot.projects) {
    for (const mission of project.activeMissions) {
      const card = mission.activeCards[0]
      if (card) {
        return {
          title: `${cardActor(card)} · ${card.phaseLabel}`,
          detail: `${card.title} · ${project.name} / ${mission.title}`,
          tone: card.interrupted ? 'attention' : 'running'
        }
      }
    }
  }
  const followed = snapshot.projects.find((project) => project.activeMissions.length > 0)
  if (followed) {
    const mission = followed.activeMissions[0]
    return {
      title: mission.label,
      detail: `${followed.name} · ${mission.title}`,
      tone: mission.tone === 'attention' ? 'attention' : 'idle'
    }
  }
  const activeProject = snapshot.projects.find((project) =>
    project.state === 'running' ||
    project.state === 'integrating' ||
    project.state === 'planning'
  )
  if (activeProject) {
    return {
      title: activeProject.label,
      detail: activeProject.masterPlan?.label
        ? `${activeProject.name} / ${activeProject.masterPlan.label}`
        : activeProject.name,
      tone: activeProject.tone === 'running' ? 'running' : 'idle'
    }
  }
  if (completion) {
    return { title: 'Missão concluída', detail: completion, tone: 'success' }
  }
  return {
    title: snapshot.totals.recentCompletions > 0 ? 'Tudo em dia' : 'Sem atividade agora',
    detail: snapshot.totals.recentCompletions > 0
      ? 'As últimas entregas foram concluídas.'
      : 'O painel atualiza automaticamente quando o trabalho começar.',
    tone: snapshot.totals.recentCompletions > 0 ? 'success' : 'idle'
  }
}

function CoordinatorActivity({
  activity,
  nowMs
}: {
  activity: ProgressCoordinatorSnapshot
  nowMs: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="progress-coordinator tone-running"
      onClick={() => window.synkoraProgressOverlay.command('open-target', {
        projectId: activity.projectId,
        ...(activity.missionId ? { missionId: activity.missionId } : {})
      })}
      aria-label={`Abrir ${activity.roleLabel}: ${activity.label}`}
    >
      <span className="progress-status-dot" aria-hidden="true" />
      <span className="progress-coordinator-copy">
        <span className="progress-coordinator-meta">
          <b>{activity.roleLabel}</b>
          <StatusPill tone="running" updatedAt={activity.updatedAt} nowMs={nowMs} />
        </span>
        <strong>{activity.label}</strong>
        {activity.note ? (
          <span className="progress-note">▸ {activity.note}</span>
        ) : (
          activity.detail && <small>{activity.detail}</small>
        )}
      </span>
      <span className="progress-mission-open" aria-hidden="true">›</span>
    </button>
  )
}

function ActiveCard({
  card,
  nowMs
}: {
  card: ProgressCardPreview
  nowMs: number
}): React.JSX.Element {
  return (
    <span className={`progress-active-card${card.interrupted ? ' interrupted' : ''}`}>
      <em>{cardActor(card)}</em>
      <span>
        <span className="progress-active-card-head">
          <b>{card.title}</b>
          <StatusPill tone={card.tone} updatedAt={card.updatedAt} nowMs={nowMs} />
        </span>
        <small>{card.phaseLabel}</small>
        {card.note && <span className="progress-note">▸ {card.note}</span>}
      </span>
    </span>
  )
}

function MissionRow({
  mission,
  highlighted,
  nowMs
}: {
  mission: ProgressMissionSnapshot
  highlighted: boolean
  nowMs: number
}): React.JSX.Element {
  const hasProgress = mission.progress.total > 0
  const ratio = hasProgress ? Math.round((mission.progress.done / mission.progress.total) * 100) : 0
  const hiddenActiveCards = Math.max(0, mission.progress.active - mission.activeCards.length)
  return (
    <button
      type="button"
      className={`progress-mission tone-${mission.tone}${highlighted ? ' just-completed' : ''}${mission.question ? ' has-question' : ''}`}
      onClick={() => window.synkoraProgressOverlay.command('open-target', {
        projectId: mission.projectId,
        missionId:
          mission.state === 'completed' || mission.kind === 'general' ? undefined : mission.id
      })}
      aria-label={`Abrir ${mission.title}: ${mission.label}`}
    >
      <span className="progress-status-dot" aria-hidden="true" />
      <span className="progress-mission-copy">
        <span className="progress-mission-title">{mission.title}</span>
        <span className="progress-mission-state">{mission.label}</span>
        {mission.question && <QuestionLine question={mission.question} />}
        {mission.detail && (mission.tone === 'attention' || mission.activeCards.length === 0) && (
          <span className="progress-mission-detail">{mission.detail}</span>
        )}
        {mission.activeCards.length > 0 && (
          <span className="progress-active-cards">
            {mission.activeCards.map((card) => (
              <ActiveCard key={card.id} card={card} nowMs={nowMs} />
            ))}
            {hiddenActiveCards > 0 && (
              <small className="progress-active-more">
                +{hiddenActiveCards} {hiddenActiveCards === 1 ? 'outro card acompanhado' : 'outros cards acompanhados'}
              </small>
            )}
          </span>
        )}
        {hasProgress && (
          <span className="progress-card-progress" aria-label={`${mission.progress.done} de ${mission.progress.total} tarefas concluídas`}>
            <i><b style={{ width: `${ratio}%` }} /></i>
            <em>{mission.progress.done}/{mission.progress.total}</em>
            {mission.progress.active > 1 && <small>{mission.progress.active} acompanhados</small>}
          </span>
        )}
      </span>
      <span className="progress-mission-open" aria-hidden="true">›</span>
    </button>
  )
}

function ProjectGroup({
  project,
  highlightedMissionId,
  nowMs
}: {
  project: ProgressProjectSnapshot
  highlightedMissionId: string | null
  nowMs: number
}): React.JSX.Element {
  return (
    <section className={`progress-project tone-${project.tone}`}>
      <button
        type="button"
        className="progress-project-head"
        onClick={() => window.synkoraProgressOverlay.command('open-target', { projectId: project.id })}
        aria-label={`Abrir projeto ${project.name}`}
      >
        <span className="progress-project-name">{project.name}</span>
        <span className="progress-project-label">{project.label}</span>
        <span aria-hidden="true">↗</span>
      </button>
      {project.question && (
        <button
          type="button"
          className="progress-project-question"
          onClick={() => window.synkoraProgressOverlay.command('open-target', { projectId: project.id })}
          aria-label={`Responder ao Maestro de ${project.name}`}
        >
          <QuestionLine question={project.question} />
        </button>
      )}
      {project.coordinators.length > 0 && (
        <div className="progress-coordinators">
          <span className="progress-section-label">Coordenação agora</span>
          {project.coordinators.map((activity) => (
            <CoordinatorActivity key={activity.id} activity={activity} nowMs={nowMs} />
          ))}
        </div>
      )}
      {project.masterPlan && (
        <div className="progress-master-plan">
          <span>{project.masterPlan.label}</span>
          {project.masterPlan.total > 0 && (
            <b>{project.masterPlan.done}/{project.masterPlan.total} missões do mapa</b>
          )}
        </div>
      )}
      <div className="progress-mission-list">
        {project.activeMissions.map((mission) => (
          <MissionRow
            key={mission.id}
            mission={mission}
            highlighted={highlightedMissionId === mission.id}
            nowMs={nowMs}
          />
        ))}
      </div>
    </section>
  )
}

export default function ProgressOverlay(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT)
  const [compact, setCompact] = useState(false)
  // Relógio do frescor ("há 12s") — barato: um tick de 5s re-renderiza uma
  // janelinha pequena; sem ele os carimbos congelariam no último snapshot.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])
  const [historyClearedAt, setHistoryClearedAt] = useState<string | null>(null)
  const [highlightedMissionId, setHighlightedMissionId] = useState<string | null>(null)
  const [historyNotice, setHistoryNotice] = useState('')
  const knownCompleted = useRef<Set<string> | null>(null)
  const acceptedRevision = useRef(0)
  const highlightTimer = useRef<number | null>(null)
  const openMainButtonRef = useRef<HTMLButtonElement>(null)
  const resizeGestureRef = useRef<{
    pointerX: number
    pointerY: number
    width: number
    height: number
  } | null>(null)

  useEffect(() => {
    const bridge = window.synkoraProgressOverlay
    const accept = (next: ProgressOverlaySnapshot, announce = true): void => {
      if (next.revision < acceptedRevision.current) return
      acceptedRevision.current = next.revision
      setSnapshot(next)
      const completed = new Set(
        next.projects.flatMap((project) => project.recentCompletions.map((mission) => mission.id))
      )
      if (announce && knownCompleted.current) {
        const fresh = [...completed].find((id) => !knownCompleted.current?.has(id))
        if (fresh) {
          setHighlightedMissionId(fresh)
          if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current)
          highlightTimer.current = window.setTimeout(() => setHighlightedMissionId(null), 6000)
        }
      }
      knownCompleted.current = completed
    }
    const offSnapshot = bridge.onSnapshot((next) => accept(next))
    const offMode = bridge.onMode((next) => setCompact(next.compact))
    const offHistory = bridge.onHistory((next) => setHistoryClearedAt(next.clearedAt))
    void bridge.getState().then((state) => {
      setCompact(state.compact)
      setHistoryClearedAt(state.historyClearedAt)
      accept(state.snapshot, false)
    })
    return () => {
      offSnapshot()
      offMode()
      offHistory()
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current)
    }
  }, [])

  const completionFeed = useMemo(
    () => progressCompletionFeed(snapshot, historyClearedAt, 3),
    [snapshot, historyClearedAt]
  )
  const recent = completionFeed.items
  const highlighted = recent.find(({ mission }) => mission.id === highlightedMissionId)?.mission.title
  const visibleProjects = snapshot.projects.filter(
    (project) =>
      project.coordinators.length > 0 ||
      project.activeMissions.length > 0 ||
      project.state === 'attention' ||
      project.state === 'planning' ||
      project.state === 'integrating'
  )
  const idleProjects = snapshot.projects.length - visibleProjects.length
  const empty = visibleProjects.length === 0 && recent.length === 0
  const summary = overallSummary(snapshot, highlighted)
  const focus = compactFocus(snapshot, highlighted)

  return (
    <div className={`progress-overlay-shell${compact ? ' compact' : ' expanded'}`}>
      <header className="progress-overlay-head">
        <span className="progress-overlay-brand" aria-hidden="true"><SynkoraMark size={18} /></span>
        <span className={`progress-overlay-heading${compact ? ` tone-${focus.tone}` : ''}`}>
          <strong>{compact ? focus.title : 'Andamento'}</strong>
          <small aria-live="polite">{compact ? focus.detail : summary}</small>
        </span>
        <span className="progress-overlay-actions">
          <button
            ref={openMainButtonRef}
            type="button"
            aria-label="Abrir o Synkora"
            title="Abrir o Synkora"
            onClick={() => window.synkoraProgressOverlay.command('open-main')}
          >↗</button>
          <button
            type="button"
            aria-label={compact ? 'Expandir andamento' : 'Compactar andamento'}
            title={compact ? 'Expandir' : 'Compactar'}
            onClick={() => window.synkoraProgressOverlay.command(compact ? 'expand' : 'compact')}
          >{compact ? '▣' : '—'}</button>
          <button
            type="button"
            className="close"
            aria-label="Ocultar andamento"
            title="Ocultar"
            onClick={() => window.synkoraProgressOverlay.command('close')}
          >×</button>
        </span>
      </header>
      <span className="progress-overlay-live" role="status" aria-live="polite">
        {historyNotice}
      </span>

      {!compact && (
        <div
          className="progress-overlay-resize"
          role="presentation"
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            resizeGestureRef.current = {
              pointerX: event.screenX,
              pointerY: event.screenY,
              width: window.outerWidth,
              height: window.outerHeight
            }
          }}
          onPointerMove={(event) => {
            const start = resizeGestureRef.current
            if (!start) return
            window.synkoraProgressOverlay.resize(
              start.width + (event.screenX - start.pointerX),
              start.height + (event.screenY - start.pointerY)
            )
          }}
          onPointerUp={(event) => {
            resizeGestureRef.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            resizeGestureRef.current = null
          }}
        />
      )}

      {!compact && (
        <div className={'progress-overlay-body' + (empty ? ' is-empty' : '')}>
          {empty && (
            <div className="progress-empty">
              <span aria-hidden="true">✓</span>
              <strong>Nada rodando agora</strong>
              <small>Quando uma missão começar, ela aparece aqui automaticamente.</small>
            </div>
          )}

          {visibleProjects.length > 0 && (
            <div className="progress-project-grid">
              {visibleProjects.map((project) => (
                <ProjectGroup
                  key={project.id}
                  project={project}
                  highlightedMissionId={highlightedMissionId}
                  nowMs={nowMs}
                />
              ))}
            </div>
          )}

          {recent.length > 0 && (
            <section className="progress-recent">
              <div className="progress-recent-head">
                <h2>Últimas concluídas</h2>
                {completionFeed.hiddenCount > 0 && (
                  <span className="progress-recent-count">
                    +{completionFeed.hiddenCount} anteriores
                  </span>
                )}
                <button
                  type="button"
                  className="progress-recent-clear"
                  aria-label="Ocultar o histórico concluído desta janela — as missões não serão apagadas"
                  title="Ocultar desta janela — as missões não serão apagadas"
                  onClick={() => {
                    setHistoryClearedAt(snapshot.generatedAt)
                    setHistoryNotice('Histórico ocultado. Nenhuma missão foi apagada.')
                    window.synkoraProgressOverlay.command('clear-history')
                    window.requestAnimationFrame(() => openMainButtonRef.current?.focus())
                  }}
                >
                  Ocultar
                </button>
              </div>
              {recent.map(({ project, mission }) => (
                <button
                  type="button"
                  key={mission.id}
                  className={highlightedMissionId === mission.id ? 'just-completed' : ''}
                  onClick={() => window.synkoraProgressOverlay.command('open-target', { projectId: project.id })}
                >
                  <span className="progress-status-dot" aria-hidden="true" />
                  <span><b>{mission.title}</b><small>{project.name} · {relativeCompletion(mission.completedAt)}</small></span>
                  <i aria-hidden="true">✓</i>
                </button>
              ))}
            </section>
          )}

          {idleProjects > 0 && (
            <div className="progress-idle-count">
              {plural(idleProjects, 'projeto')} sem atividade agora
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProgressMissionSnapshot, ProgressOverlaySnapshot, ProgressProjectSnapshot } from '../../../preload/index'
import { progressCompletionFeed } from '../progressHistory'
import {
  createProgressRevisionGate, EMPTY_PROGRESS_SNAPSHOT, PROGRESS_FILTERS,
  progressAction, progressEntryKey, progressFocus, progressSignalLabel, progressTarget, progressView,
  type ProgressFilter
} from '../progressPresentation'
import SynkoraMark from './SynkoraMark'
import Select from './Select'
import './progressOverlay.css'

function completionLabel(iso: string | undefined): string {
  const at = iso ? new Date(iso) : null
  return at && Number.isFinite(at.getTime())
    ? at.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : 'horário não disponível'
}

function MissionRow({ mission, nowMs }: { mission: ProgressMissionSnapshot; nowMs: number }): React.JSX.Element {
  const workingAlongside = mission.group === 'attention' && mission.workingSessions > 0
  return (
    <button type="button" className={`progress-mission group-${mission.group}`}
      onClick={() => window.synkoraProgressOverlay.command('open-target', progressTarget(mission))}
      aria-label={`${progressAction(mission)}: ${mission.title}. ${mission.label}`}>
      <span className="progress-state-mark" aria-hidden="true">{
        mission.group === 'attention' ? '!' : mission.group === 'working' ? '›' : mission.group === 'delivery' ? '↗' : 'Ⅱ'
      }</span>
      <span className="progress-mission-copy">
        <span className="progress-mission-title">{mission.title}</span>
        <span className="progress-mission-state">{mission.label}</span>
        {mission.detail && <span className="progress-mission-detail">{mission.detail}</span>}
        {workingAlongside && <span className="progress-parallel-work">Continua trabalhando · {mission.workingSessions} conversa{mission.workingSessions === 1 ? '' : 's'}</span>}
        <span className="progress-mission-meta">
          {mission.kind === 'general' && <span>GERAL · fora da contagem de missões</span>}
          {mission.sessionCount > 0 && <span>{mission.sessionCount} conversa{mission.sessionCount === 1 ? '' : 's'}</span>}
          {mission.pendingCount > 0 && <span>{mission.pendingCount} pendência{mission.pendingCount === 1 ? '' : 's'}</span>}
          {mission.helpers && mission.helpers.running > 0 && <span>{mission.helpers.running} ajudante{mission.helpers.running === 1 ? '' : 's'} trabalhando</span>}
          {mission.helpers && mission.helpers.interrupted > 0 && <span>{mission.helpers.interrupted} ajudante{mission.helpers.interrupted === 1 ? '' : 's'} interrompido{mission.helpers.interrupted === 1 ? '' : 's'}</span>}
          {mission.helpers && mission.helpers.failed > 0 && <span>{mission.helpers.failed} ajudante{mission.helpers.failed === 1 ? '' : 's'} com erro</span>}
        </span>
        <span className="progress-row-footer">
          <span className="progress-signal" title={mission.activityAt ? completionLabel(mission.activityAt) : 'Nenhuma atividade de conversa registrada'}>
            {mission.activityAt ? 'Último sinal ' : ''}{progressSignalLabel(mission.activityAt, nowMs)}
          </span>
          <span className="progress-row-action">{progressAction(mission)} <span aria-hidden="true">↗</span></span>
        </span>
      </span>
    </button>
  )
}

function ProjectGroup({ project, nowMs }: { project: ProgressProjectSnapshot; nowMs: number }): React.JSX.Element {
  const count = project.activeMissions.filter((mission) => mission.kind !== 'general').length
  return (
    <section className="progress-project" aria-label={`Projeto ${project.name}`}>
      <button type="button" className="progress-project-head"
        onClick={() => window.synkoraProgressOverlay.command('open-target', { projectId: project.id, destination: 'project' })}
        aria-label={`Abrir projeto ${project.name}`}>
        <span className="progress-project-name">{project.name}</span>
        <span className="progress-project-count">{count} miss{count === 1 ? 'ão' : 'ões'}</span>
        <span aria-hidden="true">↗</span>
      </button>
      {project.missing && <p className="progress-project-warning">Pasta do projeto não encontrada</p>}
      <div className="progress-mission-list">
        {project.activeMissions.map((mission) => <MissionRow key={progressEntryKey(project.id, mission)} mission={mission} nowMs={nowMs} />)}
      </div>
    </section>
  )
}

export default function ProgressOverlay(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(EMPTY_PROGRESS_SNAPSHOT)
  const [compact, setCompact] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [retry, setRetry] = useState(0)
  const [filter, setFilter] = useState<ProgressFilter>('all')
  const [projectId, setProjectId] = useState('')
  const [query, setQuery] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [historyClearedAt, setHistoryClearedAt] = useState<string | null>(null)
  const [historyNotice, setHistoryNotice] = useState('')
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null)
  const openMainButtonRef = useRef<HTMLButtonElement>(null)
  const resizeGestureRef = useRef<{ pointerX: number; pointerY: number; width: number; height: number } | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const bridge = window.synkoraProgressOverlay
    if (!bridge) { setLoadState('unavailable'); return }
    let disposed = false
    let pushedMode = false
    let pushedHistory = false
    let receivedSnapshot = false
    let knownCompleted: Set<string> | null = null
    let highlightTimer: number | undefined
    const acceptsRevision = createProgressRevisionGate()
    const accept = (next: ProgressOverlaySnapshot, announce = true): void => {
      if (disposed || !acceptsRevision(next)) return
      receivedSnapshot = true
      setSnapshot(next)
      setLoadState('ready')
      const completed = new Set(next.projects.flatMap((project) => project.recentCompletions.map((mission) => progressEntryKey(project.id, mission))))
      if (announce && knownCompleted) {
        const fresh = [...completed].find((key) => !knownCompleted?.has(key))
        if (fresh) {
          setHighlightedKey(fresh)
          window.clearTimeout(highlightTimer)
          highlightTimer = window.setTimeout(() => setHighlightedKey(null), 6000)
        }
      }
      knownCompleted = completed
    }
    const offSnapshot = bridge.onSnapshot((next) => accept(next))
    const offMode = bridge.onMode((next) => { pushedMode = true; if (!disposed) setCompact(next.compact) })
    const offHistory = bridge.onHistory((next) => { pushedHistory = true; if (!disposed) setHistoryClearedAt(next.clearedAt) })
    void bridge.getState().then((state) => {
      if (disposed) return
      if (!pushedMode) setCompact(state.compact)
      if (!pushedHistory) setHistoryClearedAt(state.historyClearedAt)
      accept(state.snapshot, false)
    }).catch(() => { if (!disposed && !receivedSnapshot) setLoadState('unavailable') })
    return () => {
      disposed = true
      offSnapshot(); offMode(); offHistory()
      window.clearTimeout(highlightTimer)
    }
  }, [retry])

  const view = useMemo(() => progressView(snapshot, filter, projectId, query), [snapshot, filter, projectId, query])
  const completionFeed = useMemo(() => progressCompletionFeed(snapshot, historyClearedAt, 3), [snapshot, historyClearedAt])
  const focus = progressFocus(snapshot)
  const focusMission = focus?.mission
  const snapshotAge = nowMs - Date.parse(snapshot.generatedAt)
  const snapshotStale = !Number.isFinite(snapshotAge) || snapshotAge > 45_000
  const hasFilters = filter !== 'all' || Boolean(projectId) || Boolean(query.trim())
  const recent = hasFilters ? [] : completionFeed.items
  const globalEmpty = view.totalRows === 0
  const visibleEmpty = view.projects.length === 0
  const summary = loadState === 'loading' ? 'Buscando o estado das missões…'
    : loadState === 'unavailable' ? 'Não foi possível carregar o andamento'
      : `${snapshot.totals.activeMissions} miss${snapshot.totals.activeMissions === 1 ? 'ão' : 'ões'} · ${snapshot.totals.projects} projeto${snapshot.totals.projects === 1 ? '' : 's'}`

  return (
    <div className={`progress-overlay-shell${compact ? ' compact' : ' expanded'}`}>
      <header className="progress-overlay-head">
        <span className="progress-overlay-brand" aria-hidden="true"><SynkoraMark size={19} /></span>
        <span className="progress-overlay-heading"><strong>Andamento</strong><small>{compact ? 'Synkora · visão rápida' : summary}</small></span>
        <span className="progress-overlay-actions">
          <button ref={openMainButtonRef} type="button" aria-label="Abrir o Synkora" title="Abrir o Synkora" onClick={() => window.synkoraProgressOverlay.command('open-main')}>↗</button>
          <button type="button" aria-label={compact ? 'Expandir andamento' : 'Compactar andamento'} title={compact ? 'Expandir' : 'Compactar'} onClick={() => window.synkoraProgressOverlay.command(compact ? 'expand' : 'compact')}>{compact ? '▣' : '—'}</button>
          <button type="button" className="close" aria-label="Ocultar andamento" title="Ocultar" onClick={() => window.synkoraProgressOverlay.command('close')}>×</button>
        </span>
      </header>
      <span className="progress-overlay-live" role="status" aria-live="polite">{historyNotice}</span>
      {compact ? (
        focusMission && focus && loadState === 'ready' ? <button type="button" className={`progress-compact-focus group-${focusMission.group}`}
          aria-label={`${progressAction(focusMission)}: ${focusMission.title}`}
          onClick={() => window.synkoraProgressOverlay.command('open-target', progressTarget(focusMission))}>
          <span><b>{focusMission.label}</b><strong>{focus.project.name} · {focusMission.title}</strong><small>{focus.project.name}</small></span><span aria-hidden="true">↗</span>
        </button> : focus && loadState === 'ready' ? <button type="button" className="progress-compact-focus group-attention" onClick={() => window.synkoraProgressOverlay.command('open-target', { projectId: focus.project.id, destination: 'project' })} aria-label={"Abrir projeto " + focus.project.name}><span><b>Pasta não encontrada</b><strong>{focus.project.name}</strong></span><span aria-hidden="true">↗</span></button> : <div className="progress-compact-empty"><strong>{loadState === 'ready' ? 'Sem missões em acompanhamento' : summary}</strong><small>{loadState === 'ready' ? 'Expanda para ver o histórico.' : 'Expanda para mais detalhes.'}</small></div>
      ) : <>
        {loadState === 'ready' && <div className="progress-controls">
          <div className="progress-filters" role="group" aria-label="Filtrar missões por estado">
            {PROGRESS_FILTERS.map(({ id, label }) => <button type="button" key={id} className={`progress-filter group-${id}`} aria-pressed={filter === id}
              title={`${view.counts[id]} missões${view.generalCounts[id] ? ` e ${view.generalCounts[id]} conversa(s) geral` : ''}`} onClick={() => setFilter(id)}>
              <span>{label}</span><b>{view.counts[id]}</b>{view.generalCounts[id] > 0 && <small>+ geral</small>}
            </button>)}
          </div>
          {(snapshot.projects.length > 1 || view.totalRows > 4) && <div className="progress-search-row">
            <Select className="dark progress-project-select" tip="Filtrar por projeto" value={projectId} onChange={setProjectId}
              options={[{ value: '', label: 'Todos os projetos' }, ...snapshot.projects.map((project) => ({ value: project.id, label: project.name }))]} />
            <input type="search" aria-label="Buscar projeto ou missão" placeholder="Buscar missão…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>}
        </div>}
        <div className={'progress-overlay-body' + (visibleEmpty && recent.length === 0 ? ' is-empty' : '')}>
          {loadState !== 'ready' ? <div className="progress-empty"><span aria-hidden="true">{loadState === 'loading' ? '···' : '!'}</span><strong>{loadState === 'loading' ? 'Carregando andamento' : 'Andamento indisponível'}</strong><small>{loadState === 'loading' ? 'Consultando o estado confirmado no Synkora.' : 'Não foi possível consultar o aplicativo. Tente novamente.'}</small>{loadState === 'unavailable' && <button type="button" onClick={() => { setLoadState('loading'); setRetry((value) => value + 1) }}>Tentar novamente</button>}</div>
            : visibleEmpty && <div className="progress-empty"><span aria-hidden="true">{hasFilters ? '⌕' : '○'}</span><strong>{hasFilters ? 'Nenhuma missão neste filtro' : 'Sem missões em acompanhamento'}</strong><small>{hasFilters ? 'Escolha outro estado, projeto ou termo de busca.' : 'Novas missões e conversas gerais aparecem aqui automaticamente.'}</small>{hasFilters && <button type="button" onClick={() => { setFilter('all'); setProjectId(''); setQuery('') }}>Limpar filtros</button>}</div>}
          {loadState === 'ready' && !visibleEmpty && <div className="progress-project-grid">{view.projects.map((project) => <ProjectGroup key={project.id} project={project} nowMs={nowMs} />)}</div>}
          {loadState === 'ready' && recent.length > 0 && <section className="progress-recent" aria-label="Conclusões recentes">
            <div className="progress-recent-head"><h2>Concluídas recentemente</h2>{completionFeed.hiddenCount > 0 && <small>+{completionFeed.hiddenCount}</small>}
              <button type="button" aria-label="Ocultar o histórico concluído desta janela — as missões não serão apagadas" title="Ocultar desta janela — as missões não serão apagadas" onClick={() => {
                setHistoryClearedAt(snapshot.generatedAt)
                setHistoryNotice('Histórico ocultado. Nenhuma missão foi apagada.')
                window.synkoraProgressOverlay.command('clear-history')
                window.requestAnimationFrame(() => openMainButtonRef.current?.focus())
              }}>Ocultar</button>
            </div>
            {recent.map(({ project, mission }) => <button type="button" key={progressEntryKey(project.id, mission)} className={highlightedKey === progressEntryKey(project.id, mission) ? 'just-completed' : ''}
              aria-label={`Abrir contexto de ${mission.title} em ${project.name}`}
              onClick={() => window.synkoraProgressOverlay.command('open-target', progressTarget(mission))}>
              <span aria-hidden="true">✓</span><span><b>{mission.title}</b><small>{project.name} · {completionLabel(mission.completedAt)}</small></span><span aria-hidden="true">↗</span>
            </button>)}
          </section>}
        </div>
        {loadState === 'ready' && <footer className="progress-overlay-foot"><span className={'progress-live-dot' + (snapshotStale ? ' stale' : '')} aria-hidden="true" /><span>{snapshotStale ? `Sem atualização ${progressSignalLabel(snapshot.generatedAt, nowMs)}` : 'Atualização automática'}</span><span title={completionLabel(snapshot.generatedAt)}>{snapshotStale ? 'Exibindo último estado' : globalEmpty ? 'Sem execução registrada' : `Recebido ${progressSignalLabel(snapshot.generatedAt, nowMs)}`}</span></footer>}
        <div className="progress-overlay-resize" role="presentation"
          onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resizeGestureRef.current = { pointerX: event.screenX, pointerY: event.screenY, width: window.outerWidth, height: window.outerHeight } }}
          onPointerMove={(event) => { const start = resizeGestureRef.current; if (start) window.synkoraProgressOverlay.resize(start.width + event.screenX - start.pointerX, start.height + event.screenY - start.pointerY) }}
          onPointerUp={(event) => { resizeGestureRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
          onPointerCancel={() => { resizeGestureRef.current = null }} />
      </>}
    </div>
  )
}

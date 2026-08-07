import { useEffect, useRef, useState } from 'react'
import type { ProgressOverlaySnapshot } from '../../../preload/index'
import ProgressPanelIcon from './ProgressPanelIcon'

const EMPTY_TOTALS: ProgressOverlaySnapshot['totals'] = {
  projects: 0,
  activeProjects: 0,
  activeMissions: 0,
  activeCards: 0,
  activeCoordinators: 0,
  attentionMissions: 0,
  attentionProjects: 0,
  recentCompletions: 0
}

export default function ProgressRadarButton(): React.JSX.Element {
  const [totals, setTotals] = useState(EMPTY_TOTALS)
  const acceptedRevision = useRef(0)

  useEffect(() => {
    const progress = window.synkora.progress
    const accept = (snapshot: ProgressOverlaySnapshot): void => {
      if (snapshot.revision < acceptedRevision.current) return
      acceptedRevision.current = snapshot.revision
      setTotals(snapshot.totals)
    }
    const off = progress.onSnapshot(accept)
    void progress.getSnapshot().then(accept)
    return off
  }, [])

  const attentionCount = totals.attentionMissions + totals.attentionProjects
  const liveCount = totals.activeCards + totals.activeCoordinators
  const count = attentionCount || liveCount || totals.activeMissions || totals.activeProjects
  const attention = attentionCount > 0
  const details: string[] = []
  if (totals.attentionMissions > 0) details.push(`${totals.attentionMissions} missão(ões) precisam de atenção`)
  if (totals.attentionProjects > 0) details.push(`${totals.attentionProjects} projeto(s) precisam de atenção`)
  if (totals.activeCoordinators > 0) details.push(`${totals.activeCoordinators} agente(s) de coordenação trabalhando`)
  if (totals.activeCards > 0) details.push(`${totals.activeCards} card(s) em andamento`)
  if (details.length === 0 && totals.activeMissions > 0) {
    details.push(`${totals.activeMissions} missão(ões) sendo acompanhadas`)
  }
  const tip = details.length > 0
    ? `${details.join(' · ')}. Abrir painel de andamento.`
    : 'Abrir painel de andamento dos projetos e missões'

  return (
    <button
      type="button"
      className={`tb-btn progress-radar-trigger${attention ? ' attention' : ''}`}
      data-tip={tip}
      aria-label={tip}
      onClick={() => void window.synkora.progress.openOverlay()}
    >
      <ProgressPanelIcon className="progress-radar-icon" />
      {count > 0 && <b aria-hidden="true">{count > 9 ? '9+' : count}</b>}
    </button>
  )
}

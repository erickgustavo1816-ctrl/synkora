import { useEffect, useState } from 'react'
import type { ProgressOverlaySnapshot } from '../../../preload/index'
import { createProgressRevisionGate, EMPTY_PROGRESS_TOTALS } from '../progressPresentation'
import ProgressPanelIcon from './ProgressPanelIcon'

export default function ProgressRadarButton(): React.JSX.Element {
  const [totals, setTotals] = useState(EMPTY_PROGRESS_TOTALS)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let disposed = false
    let received = false
    const progress = window.synkora.progress
    const acceptsRevision = createProgressRevisionGate()
    const accept = (snapshot: ProgressOverlaySnapshot): void => {
      if (disposed || !acceptsRevision(snapshot)) return
      received = true
      setTotals(snapshot.totals)
      setUnavailable(false)
    }
    const off = progress.onSnapshot(accept)
    void progress.getSnapshot().then(accept).catch(() => { if (!disposed && !received) setUnavailable(true) })
    return () => { disposed = true; off() }
  }, [])

  // Projects may contain the same attention missions. Never add both counters.
  const attention = totals.attentionMissions > 0 || totals.attentionProjects > 0
  const count = totals.attentionMissions || totals.workingMissions || totals.activeMissions
  const detail = [
    `${totals.attentionMissions} missões precisam de atenção`,
    `${totals.workingMissions} trabalhando`,
    `${totals.deliveryMissions} em entrega`,
    `${totals.idleMissions} paradas`
  ].join(' · ')
  const tip = unavailable ? 'Andamento indisponível. Abrir painel para tentar novamente.'
    : `${detail}${totals.attentionProjects > 0 ? ' · Há projeto(s) que precisam de atenção' : ''}. Abrir painel de andamento.`
  return (
    <button type="button" className={`tb-btn progress-radar-trigger${attention ? ' attention' : ''}`}
      data-tip={tip} aria-label={tip} onClick={() => void window.synkora.progress.openOverlay()}>
      <ProgressPanelIcon className="progress-radar-icon" />
      {count > 0 && <b aria-hidden="true">{count > 9 ? '9+' : count}</b>}
    </button>
  )
}

import { useEffect, useState } from 'react'
import { formatGuiElapsed, guiActivityLabel } from '../guiActivity'

export default function GuiActivityBar({
  startedAt,
  statusText,
  onStop
}: {
  startedAt: number
  statusText?: string | null
  onStop: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [startedAt])

  const elapsed = Math.max(0, now - startedAt)
  return (
    <div className="gui-activity">
      <span className="gui-live" role="status" aria-live="polite">
        {statusText?.trim() ? `Agente trabalhando: ${statusText.trim()}` : 'Agente trabalhando'}
      </span>
      <span className="gui-activity-main">
        <i className="gui-activity-dot" aria-hidden="true" />
        <span className="gui-activity-label">{guiActivityLabel(elapsed, statusText)}…</span>
        <time className="gui-activity-time">{formatGuiElapsed(elapsed)}</time>
      </span>
      <button
        type="button"
        className="gui-activity-stop"
        data-tip="Parar resposta · Esc"
        aria-label="Parar resposta"
        aria-keyshortcuts="Escape"
        onClick={onStop}
      >
        <span className="gui-activity-stop-icon" aria-hidden="true" />
        <span className="gui-activity-stop-label">Parar</span>
        <kbd>esc</kbd>
      </button>
    </div>
  )
}

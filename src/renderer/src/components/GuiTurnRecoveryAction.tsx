import { useRef, useState } from 'react'
import { guiApi } from '../guiApi'
import { useStore } from '../store'

export default function GuiTurnRecoveryAction({ paneId, recoveryToken }: {
  paneId: string
  recoveryToken: string
}): React.JSX.Element | null {
  const current = useStore(state => state.guiPanes[paneId]?.recoveryToken === recoveryToken)
  const busy = useStore(state => {
    const pane = state.guiPanes[paneId]
    return !pane || pane.status !== 'idle' || pane.composerBusy || pane.queued !== null ||
      pane.sendBatch !== null || pane.interactionQueue.length > 0
  })
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function resume(): Promise<void> {
    if (!current || busy || accepted || submitting.current) return
    submitting.current = true
    setPending(true)
    setError(null)
    const result = await guiApi.resumeFailedTurn(paneId, recoveryToken)
    if (result.ok) setAccepted(true)
    else setError(result.error || 'Não foi possível retomar. Confira a conversa e tente novamente.')
    submitting.current = false
    setPending(false)
  }

  if (!current || accepted) return null
  return (
    <div className="gui-turn-recovery">
      <div className="gui-turn-recovery-row">
        <button type="button" disabled={busy || pending} onClick={() => { void resume() }}>
          {pending ? 'Retomando…' : 'Retomar conversa'}
        </button>
        <span>Mantém o modelo e o histórico.</span>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

import { useState } from 'react'
import { releaseDiscardOffer, type ReleaseDiscardInput } from '../releaseRailPresentation'
import WorkspaceIcon from './WorkspaceIcon'

/** Presentation only — the release twin of MissionHeaderActions. The stage
 * head holds the levers of every chat (owner's order, 2026-09-09: one frame
 * for mission, planning and release), and the release has exactly one:
 * discarding the ascent. It is irreversible (record and conversation go
 * away), so the button ARMS on the first click and confirms on the second,
 * the same inline pattern the stage pills use for "fechar?"; the browser's
 * native confirm dialog is forbidden in the house (it breaks window focus on
 * Windows). The truth of the state comes from the pure module: what
 * discarding undoes, and what it never does (git). */
export default function ReleaseHeaderActions({ mission, onDiscard }: {
  mission: ReleaseDiscardInput
  /** Absent while the store predates the lever (HMR): the button then says
   *  the recipe instead of vanishing. */
  onDiscard?: () => void
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const offer = releaseDiscardOffer(mission)
  const enabled = offer.offered && !!onDiscard
  const tip = !offer.offered ? 'Subida encerrada — ela já saiu da coluna sozinha'
    : !onDiscard ? 'Reinicie o app (npm run dev) para descartar a subida'
    : `Tira a subida da coluna — ${offer.confirm}`
  return <div className="workspace-mission-actions" role="group" aria-label="Ações do release">
    {armed ? (
      <button type="button" className="is-confirming" aria-label="Confirmar o descarte da subida" data-tip={offer.confirm}
        autoFocus
        onClick={() => { setArmed(false); onDiscard?.() }}
        onBlur={() => setArmed(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault(); event.stopPropagation(); setArmed(false)
        }}>descartar?</button>
    ) : (
      <button type="button" aria-label="Descartar a subida" data-tip={tip} disabled={!enabled}
        onClick={() => setArmed(true)}><WorkspaceIcon name="discard" /></button>
    )}
  </div>
}

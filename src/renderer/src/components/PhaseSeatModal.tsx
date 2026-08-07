import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { ModelSelect } from './ModelSelect'
import Select from './Select'

const PHASE_LABEL: Record<'dev' | 'review' | 'qa', string> = {
  dev: 'DEV',
  review: 'REVIEW',
  qa: 'QA'
}

// Modal ⇄ TROCA DE CONTA DA FASE (dev/review/qa) — irmão do reseat do
// orquestrador (NewMissionModal em modo reseat): limite estourado nunca pode
// prender o card nem custar o contexto. O main mata o pane da fase,
// transplanta a conversa quando é claude→claude (o pane renasce via resume) e
// REABRE o pane sozinho — aqui só se escolhe conta/modelo/effort e se mostra
// a msg retornada. Codex/cross-CLI renasce fresco sobre o worktree preservado.
export default function PhaseSeatModal({
  projectId,
  taskId,
  phase,
  taskTitle,
  currentSeatId,
  onClose
}: {
  projectId: string
  taskId: string
  phase: 'dev' | 'review' | 'qa'
  taskTitle: string
  /** seat atual do pane da fase — pré-seleciona para a troca ser um clique */
  currentSeatId?: string
  onClose: () => void
}): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const loadCatalog = useStore((s) => s.loadCatalog)

  const [seatId, setSeatId] = useState(currentSeatId ?? '')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  // guard do PlanModal: seleção de texto que TERMINA fora do modal não fecha —
  // o clique no backdrop só fecha se o gesto COMEÇOU no próprio overlay.
  const downOnOverlay = useRef(false)

  // Catálogo REAL do CLI do seat escolhido — mesma mecânica dos outros modais:
  // trocar de seat reseta modelo/effort (a lista é do CLI do seat novo).
  const seatObj = seats.find((x) => x.id === seatId)
  const cli = seatObj?.cli ?? 'claude'
  const catalog = useStore((s) => s.catalogByCli[`${cli}:${seatObj?.id ?? ''}`])
  useEffect(() => {
    if (seatObj) void loadCatalog(cli, seatObj.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, seatObj?.id, loadCatalog])
  const effortOpts = catalog?.models.find((m) => m.id === model)?.efforts ?? catalog?.efforts ?? []

  async function submit(): Promise<void> {
    if (!seatId || busy || okMsg) return
    setBusy(true)
    setError('')
    const res = await window.synkora.tasks.setPhaseSeat(projectId, taskId, {
      seatId,
      model: model.trim() || undefined,
      effort: effort || undefined
    })
    setBusy(false)
    if (!res.ok) {
      setError(res.msg)
      return
    }
    // mostra a msg do main (transplantou ou renasceu fresco) — o pane já está
    // renascendo sozinho; o usuário fecha quando quiser.
    setOkMsg(res.msg)
  }

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="task-modal mission-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-dept">⇄ trocar a conta desta fase</span>
          <span className="task-origin" data-tip={taskTitle}>
            {PHASE_LABEL[phase]} · {taskTitle}
          </span>
          <button className="pane-close dark-close" onClick={onClose}>
            ×
          </button>
        </div>
        {error && (
          <div className="mission-modal-error" role="alert">
            {error}
          </div>
        )}
        {okMsg && (
          <div className="mission-modal-ok" role="status">
            ✓ {okMsg}
          </div>
        )}
        <div className="mission-exec-row">
          <label>
            conta (seat)
            <Select
              value={seatId}
              disabled={busy || Boolean(okMsg)}
              placeholder="— escolha a conta —"
              onChange={(v) => {
                setSeatId(v)
                setModel('')
                setEffort('')
              }}
              options={seats.map((s) => ({ value: s.id, label: s.name, cli: s.cli }))}
            />
          </label>
          <label>
            modelo
            <ModelSelect
              cli={cli}
              seatId={seatObj?.id}
              value={model}
              disabled={!seatObj || busy || Boolean(okMsg)}
              onChange={(m) => {
                setModel(m)
                setEffort('')
              }}
            />
          </label>
          <label>
            effort
            <Select
              value={effort}
              disabled={!seatObj || busy || Boolean(okMsg)}
              onChange={setEffort}
              options={[
                { value: '', label: 'padrão do modelo' },
                ...effortOpts.map((ef) => ({ value: ef, label: ef }))
              ]}
            />
          </label>
        </div>
        <div className="task-modal-actions">
          <span className="task-modal-meta">
            claude → claude mantém a conversa (transplante); codex ou troca de CLI recomeça a
            conversa sobre o trabalho preservado
          </span>
          {okMsg ? (
            <button className="btn accent" onClick={onClose}>
              fechar
            </button>
          ) : (
            <>
              <button className="btn ghost" onClick={onClose}>
                cancelar
              </button>
              <button className="btn accent" disabled={!seatId || busy} onClick={() => void submit()}>
                {busy ? 'trocando…' : '⇄ trocar conta'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

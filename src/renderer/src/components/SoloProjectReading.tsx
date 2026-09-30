import { useEffect, useRef, useState } from 'react'
import GuiPane from './GuiPane'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import { useFrozenMissionChats } from './ArchivedMissionChat'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import { soloFinishedLabel } from '../soloProjectModel'
import type { Mission, Seat } from '../store'
import './SoloProject.css'

// A MISSÃO FINALIZADA, SÓ LEITURA, NO LUGAR DO INÍCIO (cena 6 do mockup).
//
// Não é modal: a leitura ocupa a mesma tela, com o fio congelado, o resumo no
// topo, "← Início" na cabeça e de novo no pé, e Esc. O fio chega pela sonda que
// não ressuscita nada (`useFrozenMissionChats` → `gui:state`) e o GuiPane
// `readOnly` para ANTES de decidir abrir sessão — ler nunca liga um CLI.
//
// Remover do histórico mora aqui (decisão do dono na aprovação), com a
// confirmação NA PRÓPRIA LINHA (nunca window.confirm): o registro e o chat
// arquivado saem; a pasta não muda.

export default function SoloProjectReading({
  mission,
  projectPath,
  seats,
  onBack,
  onRemove
}: {
  mission: Mission
  /** a pasta do projeto: é onde a missão trabalhou (não há worktree) */
  projectPath: string
  seats: Seat[]
  onBack: () => void
  /** tira a missão do histórico; devolve a recusa do main, ou null */
  onRemove: () => Promise<string | null>
}): React.JSX.Element {
  const { probing, found, current, select } = useFrozenMissionChats(mission.id)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const confirmingRef = useRef(confirming)
  confirmingRef.current = confirming

  // Esc volta ao Início — leitura não prende o teclado. Com a remoção armada,
  // o primeiro Esc desarma (a pergunta é o que está em foco).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (confirmingRef.current) {
        setConfirming(false)
        setRemoveError(null)
        return
      }
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  useEffect(() => {
    backRef.current?.focus()
  }, [mission.id])

  const seat = seats.find((s) => s.id === mission.seatId)
  const summary = mission.summary?.trim()

  async function remove(): Promise<void> {
    if (removing) return
    setRemoving(true)
    setRemoveError(null)
    try {
      const refusal = await onRemove()
      if (refusal) setRemoveError(refusal)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="board solo-reading">
      <div className="maestro-window stage-window solo-read-window">
        <div className="stage-head">
          <button ref={backRef} type="button" className="btn ghost tiny solo-read-back" onClick={onBack}>
            <WorkspaceIcon name="back" />
            Início
          </button>
          <span className="stage-sep" aria-hidden="true" />
          <span className="solo-stage-title is-static" title={mission.title}>
            <span>{mission.title}</span>
          </span>
          <span className="solo-read-when">{soloFinishedLabel(mission)}</span>
          <div className="stage-trail">
            {found.length > 1 && (
              <div className="stage-pills solo-read-pills" role="tablist" aria-label="Conversas desta missão">
                {found.map((address) => (
                  <button
                    key={address.paneId}
                    type="button"
                    role="tab"
                    aria-selected={address.paneId === current?.paneId}
                    className={`stage-pill${address.paneId === current?.paneId ? ' active' : ''}`}
                    data-tip={`Ler a conversa "${address.label}" desta missão`}
                    onClick={() => select(address.paneId)}
                  >
                    {address.label}
                  </button>
                ))}
              </div>
            )}
            <span className="solo-read-chip">
              <WorkspaceIcon name="lock" />
              somente leitura
            </span>
            <span className="stage-sep" aria-hidden="true" />
            {confirming ? (
              <span className="solo-remove-confirm" role="group" aria-label="Remover do histórico">
                <span className="solo-remove-q">Remover do histórico? A pasta não muda.</span>
                <button type="button" className="btn tiny danger" disabled={removing} onClick={() => void remove()}>
                  {removing ? 'Removendo…' : 'Remover'}
                </button>
                <button
                  type="button"
                  className="btn tiny ghost"
                  disabled={removing}
                  onClick={() => {
                    setConfirming(false)
                    setRemoveError(null)
                  }}
                >
                  Cancelar
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="solo-icon-btn"
                aria-label="Remover do histórico"
                data-tip="Remover do histórico (a pasta não muda)"
                onClick={() => setConfirming(true)}
              >
                <WorkspaceIcon name="discard" />
              </button>
            )}
          </div>
        </div>
        {removeError && (
          <p className="solo-remove-error" role="alert">
            {removeError}
          </p>
        )}
        <div className="maestro-body solo-read-body">
          {summary && (
            <div className="solo-summary">
              <span className="ssum-label">
                <WorkspaceIcon name="historico" />
                Resumo
              </span>
              {summary}
            </div>
          )}
          <div className="solo-read-thread">
            {probing ? (
              <p className="solo-read-empty">procurando a conversa desta missão…</p>
            ) : current ? (
              <GuiPanelErrorBoundary key={current.paneId} paneId={current.paneId} label="esta conversa">
                <GuiPane
                  readOnly
                  showHeader={false}
                  active={false}
                  paneId={current.paneId}
                  projectId={mission.projectId}
                  cli={seat?.cli ?? 'claude'}
                  cwd={projectPath}
                  model={mission.model}
                  effort={mission.effort}
                  seats={seats}
                  seatId={mission.seatId}
                  role={current.label}
                />
              </GuiPanelErrorBoundary>
            ) : (
              <p className="solo-read-empty">
                a conversa desta missão não está mais guardada — o histórico tem limite de espaço e as
                conversas mais antigas saem primeiro.
              </p>
            )}
          </div>
          <div className="solo-frozen-foot">
            <WorkspaceIcon name="lock" />
            <span>Missão finalizada. Para continuar o trabalho, inicie uma nova missão.</span>
            <button type="button" className="btn ghost tiny" onClick={onBack}>
              <WorkspaceIcon name="back" />
              Voltar ao Início
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

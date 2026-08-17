import { useCallback, useRef, useState } from 'react'
import type { PlanDraft } from '../planContract'
import {
  planDraftDependencyLabels,
  planDraftItemCountLabel,
  planTierLabel
} from '../planBoardPresentation'

// PROPOSTA DE PLANO (D4.4) — o pedido central do dono: o plano nasce NA
// CONVERSA e a criação é um clique dele.
//
// Irmão do GuiPlanCard (mesma barra de acento, mesma tag "esperando você") com
// a riqueza do GuiQuestionCard: aqui não se decide sobre um texto, se decide
// sobre uma LISTA DE MISSÕES. Por isso cada item abre — objetivo, pronto
// quando, fora do escopo, dependências — em vez de virar um parágrafo só.
//
// A porteira é mecânica (risco R8): "criar plano" é a ÚNICA porta de criação;
// a ferramenta do agente apenas apresenta. "Ajustar" devolve o texto do dono
// como mensagem e o agente propõe de novo.

export default function GuiPlanProposalCard({
  draft,
  onDecide,
  disabled = false
}: {
  draft: PlanDraft
  /** approve=true cria o plano; false devolve com o texto do dono. */
  onDecide: (approve: boolean, note?: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const [openItems, setOpenItems] = useState<Record<number, boolean>>({})
  const [adjusting, setAdjusting] = useState(false)
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const toggleItem = useCallback((index: number): void => {
    setOpenItems((prev) => ({ ...prev, [index]: !prev[index] }))
  }, [])

  const openAdjust = useCallback((): void => {
    setAdjusting(true)
    window.setTimeout(() => noteRef.current?.focus({ preventScroll: true }), 0)
  }, [])

  const title = draft.title.trim() || 'plano sem título'
  const noteReady = note.trim().length > 0

  return (
    <div className="gui-proposal" role="group" aria-label="Proposta de plano">
      <div className="gui-proposal-head">
        <span className="gui-proposal-icon" aria-hidden="true">
          ◇
        </span>
        <span className="gui-proposal-kicker">proposta de plano</span>
        <span className="gui-proposal-tag">esperando você</span>
      </div>

      <div className="gui-proposal-body">
        <h3 className="gui-proposal-title">{title}</h3>
        {draft.description && <p className="gui-proposal-desc">{draft.description}</p>}

        <span className="gui-proposal-count">{planDraftItemCountLabel(draft.items.length)}</span>

        {/* CONSENTIMENTO INFORMADO (2026-08-17): `propose_plan` aceita
            kind:'mestre', e antes disto o card não mostrava — o dono criava o
            plano de fundo do universo num clique cego. Designar depois é gesto
            dele; nascer designado tem de ser também. */}
        {draft.kind === 'mestre' && (
          <span className="gui-proposal-kind">
            proposto como <b>plano mestre</b> — o plano de fundo deste universo
          </span>
        )}

        {draft.items.length === 0 ? (
          <p className="gui-proposal-empty">
            O plano nasce vazio: as missões você pede conversando, e elas entram na aba dele no
            mapa.
          </p>
        ) : (
          <ol className="gui-proposal-items">
            {draft.items.map((item, index) => {
              const open = Boolean(openItems[index])
              const dependencies = planDraftDependencyLabels(draft, item)
              const tier = planTierLabel(item.tier)
              return (
                <li key={item.id ?? `${index}-${item.title}`} className="gui-proposal-item">
                  <button
                    type="button"
                    className={`gpi-head${open ? ' open' : ''}`}
                    aria-expanded={open}
                    onClick={() => toggleItem(index)}
                  >
                    <span className="gpi-order" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="gpi-title">{item.title}</span>
                    {tier && <span className="gpi-tier">{tier}</span>}
                    <span className="gpi-caret" aria-hidden="true">
                      {open ? '▾' : '▸'}
                    </span>
                  </button>
                  {open && (
                    <div className="gpi-detail">
                      {item.objective && (
                        <p className="gpi-objective">{item.objective}</p>
                      )}
                      {item.doneCriteria && item.doneCriteria.length > 0 && (
                        <div className="gpi-block">
                          <span className="gpi-label">pronto quando</span>
                          <ul className="gpi-list">
                            {item.doneCriteria.map((criterion) => (
                              <li key={criterion}>{criterion}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {item.outOfScope && (
                        <div className="gpi-block">
                          <span className="gpi-label">fora do escopo</span>
                          <p className="gpi-text">{item.outOfScope}</p>
                        </div>
                      )}
                      {item.context && (
                        <div className="gpi-block">
                          <span className="gpi-label">contexto</span>
                          <p className="gpi-text">{item.context}</p>
                        </div>
                      )}
                      {dependencies.length > 0 && (
                        <div className="gpi-block">
                          <span className="gpi-label">depende de</span>
                          <p className="gpi-text">{dependencies.join(' · ')}</p>
                        </div>
                      )}
                      {item.docPath && (
                        <span className="gpi-doc">brief: {item.docPath}</span>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>

      {adjusting && (
        <div className="gui-proposal-adjust">
          <label className="gpa-label" htmlFor="gui-proposal-note">
            o que mudar antes de criar
          </label>
          <textarea
            id="gui-proposal-note"
            ref={noteRef}
            className="gpa-input"
            rows={3}
            disabled={disabled}
            placeholder="ex.: separe a missão 2 em duas e tire o app mobile do escopo"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && noteReady && !disabled) {
                e.preventDefault()
                onDecide(false, note.trim())
              }
            }}
          />
          <span className="gpa-hint">
            o plano não é criado agora — o agente recebe seu texto e propõe de novo
          </span>
        </div>
      )}

      <div className="gui-proposal-actions">
        {adjusting ? (
          <>
            <button
              className="gui-btn"
              disabled={disabled}
              onClick={() => {
                setAdjusting(false)
                setNote('')
              }}
            >
              voltar
            </button>
            <button
              className="gui-btn primary"
              disabled={disabled || !noteReady}
              onClick={() => onDecide(false, note.trim())}
            >
              enviar ajuste
            </button>
          </>
        ) : (
          <>
            <button
              className="gui-btn primary"
              disabled={disabled}
              onClick={() => onDecide(true)}
            >
              ✓ criar plano
            </button>
            <button className="gui-btn" disabled={disabled} onClick={openAdjust}>
              ✎ ajustar
            </button>
          </>
        )}
      </div>
    </div>
  )
}

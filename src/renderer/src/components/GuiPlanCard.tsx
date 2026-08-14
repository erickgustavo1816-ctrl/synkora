import GuiMarkdown from './GuiMarkdown'

// MODO PLANO (ExitPlanMode): o agente estudou e propõe. O veredito mora no
// PRÓPRIO card do plano, não num banner solto — quem decide precisa ler o que
// está decidindo (desenho do claudecodeui, aprovado como referência).
//
// Construir = allow no protocolo; revisar = deny com a frase que o CLI espera
// (ele volta a planejar em vez de tratar como recusa final).

export default function GuiPlanCard({
  paneId,
  plan,
  onDecide,
  disabled = false
}: {
  paneId: string
  plan: string
  onDecide: (approve: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="gui-plan">
      <div className="gui-plan-head">
        <span className="gui-plan-icon" aria-hidden="true">
          ☰
        </span>
        <span className="gui-plan-title">plano proposto</span>
        <span className="gui-plan-tag">esperando você</span>
      </div>
      <div className="gui-plan-body">
        <GuiMarkdown paneId={paneId} text={plan} />
      </div>
      <div className="gui-plan-actions">
        <button className="gui-btn primary" disabled={disabled} onClick={() => onDecide(true)}>
          ▶ construir
        </button>
        <button className="gui-btn" disabled={disabled} onClick={() => onDecide(false)}>
          ✎ revisar
        </button>
      </div>
    </div>
  )
}

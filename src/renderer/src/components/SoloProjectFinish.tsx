import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import type { SoloFinishRisk } from '../soloProjectModel'
import './SheetModal.css'
import './SoloProject.css'

// FINALIZAR A MISSÃO (cena 5 do mockup aprovado) — a única cerimônia do
// projeto sem versionamento. Folha de papel por portal (nunca window.confirm:
// quebra o foco da janela no Windows), com os três fatos do que acontece.
//
// No meio do trabalho o BOTÃO muda, não só o texto: o aviso em âmbar diz o
// risco real (uma edição pela metade pode ficar na pasta), a saída segura é
// "Esperar o agente" e a decisão vira "Interromper e finalizar", em vermelho.
// O aviso é VIVO: o turno que fecha com a folha aberta devolve a variante calma.

export default function SoloProjectFinish({
  title,
  risk,
  busy,
  error,
  onConfirm,
  onCancel
}: {
  title: string
  /** o que finalizar interromperia agora; null = agente parado */
  risk: SoloFinishRisk | null
  busy: boolean
  /** a recusa do main, dita na própria folha */
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const headingId = useId()
  const safeRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const risky = risk !== null

  // O foco nasce na saída que o momento pede: parado, o próprio finalizar;
  // no meio do turno, esperar o agente (a decisão perigosa exige o gesto).
  useEffect(() => {
    ;(risky ? safeRef.current : confirmRef.current)?.focus()
  }, [risky])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return createPortal(
    <div className="overlay" onClick={() => !busy && onCancel()}>
      <div
        className="sheet-modal solo-finish"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sm-head">
          <span className="sm-kind"><WorkspaceIcon name="check" />Finalizar missão</span>
          <button type="button" className="sm-close" aria-label="Fechar" disabled={busy} onClick={onCancel}>
            <WorkspaceIcon name="close" />
          </button>
        </div>
        <h2 className="fm-title" id={headingId}>Finalizar “{title}”?</h2>
        <ul className="fm-facts">
          <li><WorkspaceIcon name="stop" /><span>O chat do agente e os ajudantes param.</span></li>
          <li><WorkspaceIcon name="folder" /><span>As edições já estão na pasta e ficam como estão.</span></li>
          <li><WorkspaceIcon name="historico" /><span>A missão vai para o histórico, só para leitura, e a tela volta para o Início.</span></li>
        </ul>
        {risk && (
          <div className="fm-risk" role="alert">
            <WorkspaceIcon name="alert" />
            <span><b>{risk.headline}</b> {risk.consequence}</span>
          </div>
        )}
        {error && <p className="fm-error" role="alert">{error}</p>}
        <div className="sm-actions">
          <button type="button" className="btn ghost" ref={safeRef} disabled={busy} onClick={onCancel}>
            {risky ? 'Esperar o agente' : 'Cancelar'}
          </button>
          <span className="sm-meta" />
          <button
            type="button"
            ref={confirmRef}
            className={`btn ${risky ? 'danger' : 'accent'}`}
            disabled={busy}
            onClick={onConfirm}
          >
            <WorkspaceIcon name={risky ? 'stop' : 'check'} />
            {busy ? 'Finalizando…' : risky ? 'Interromper e finalizar' : 'Finalizar missão'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

import './GuiComposerDeliveryActions.css'

interface GuiComposerDeliveryActionsProps {
  disabled: boolean
  showSendNow: boolean
  onSendNow: () => void
  onSendLater: () => void
}

/** The current response keeps its stop control. These actions concern only
 * the next message, which can either steer now or wait in a cancellable queue. */
export default function GuiComposerDeliveryActions({
  disabled,
  showSendNow,
  onSendNow,
  onSendLater
}: GuiComposerDeliveryActionsProps): React.JSX.Element {
  return (
    <div className="gui-composer-delivery-actions" role="group" aria-label="Quando enviar esta mensagem">
      <button
        type="button"
        className="term-btn ghost-dim"
        disabled={disabled}
        data-tip="espera a resposta terminar; você pode cancelar enquanto estiver na fila"
        onClick={onSendLater}
      >
        enviar depois
      </button>
      {showSendNow && (
        <button
          type="button"
          className="term-btn"
          disabled={disabled}
          data-tip="envia ao agente durante a resposta atual · Enter"
          onClick={onSendNow}
        >
          enviar agora
        </button>
      )}
    </div>
  )
}

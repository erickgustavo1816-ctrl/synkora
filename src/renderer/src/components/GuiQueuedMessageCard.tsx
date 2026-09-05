import { useState } from 'react'
import type { GuiQueuedMessage } from '../guiMessageQueue'
import './GuiQueuedMessageCard.css'
import GuiAttachmentChips from './GuiAttachmentChips'

interface GuiQueuedMessageCardProps {
  message: GuiQueuedMessage
  optionsLabel?: string
  onEdit: () => boolean
  onCancel: () => boolean
  editDisabled?: boolean
  onRetry: () => void
  /** PULA A FILA (ordem do dono, 18/08): entrega AGORA, dentro do turno vivo,
   *  pelo caminho direto de envio — os dois CLIs aceitam steering. Ausente =
   *  card sem o verbo (pane sem ponte não tem para onde pular). */
  onSendNow?: () => void
  /** ponte fora do ar (starting/dead): o verbo fica com a dica honesta. */
  sendNowDisabled?: boolean
}

export default function GuiQueuedMessageCard({
  message,
  optionsLabel,
  onEdit,
  onCancel,
  editDisabled,
  onRetry,
  onSendNow,
  sendNowDisabled
}: GuiQueuedMessageCardProps) {
  const failed = Boolean(message.deliveryError)
  const sending = Boolean(message.deliveryInFlight)
  const [actionError, setActionError] = useState<string | null>(null)
  return (
    <aside
      className={`gui-queued-message${failed ? ' has-error' : ''}${sending ? ' is-sending' : ''}`}
      role="status"
      aria-label="Mensagem na fila"
    >
      <div className="gui-queued-message-copy">
        <strong>
          {sending
            ? 'enviando a mensagem da fila…'
            : failed
              ? 'não enviou automaticamente'
              : 'vai enviar quando terminar'}
        </strong>
        {message.text && <span className="gui-queued-message-text">{message.text}</span>}
        <GuiAttachmentChips attachments={message.attachments} className="gui-queued-attachments" />
        {optionsLabel && <small>{optionsLabel}</small>}
        {message.deliveryError && (
          <span className="gui-queued-message-error" role="alert">
            {message.deliveryError}
          </span>
        )}
        <span className="gui-queued-message-error" role="alert">
          {actionError}
        </span>
      </div>
      <div className="gui-queued-message-actions">
        {failed && !sending && (
          <button type="button" className="term-btn" onClick={onRetry}>
            tentar novamente
          </button>
        )}
        {onSendNow && !failed && (
          <button
            type="button"
            className="term-btn"
            disabled={sending || sendNowDisabled}
            data-tip={
              sendNowDisabled
                ? 'a ponte do chat está fora do ar — sem turno para entrar'
                : 'envia esta mensagem durante a resposta atual; depois do envio ela não pode mais ser cancelada'
            }
            onClick={onSendNow}
          >
            enviar agora
          </button>
        )}
        <button
          type="button"
          className="term-btn ghost-dim"
          disabled={sending || editDisabled}
          data-tip={
            editDisabled
              ? 'conclua seu rascunho atual antes de editar a mensagem da fila'
              : undefined
          }
          onClick={() => {
            if (!onEdit()) {
              setActionError('Não foi possível trazer a mensagem para edição. Ela foi preservada na fila.')
            }
          }}
        >
          editar
        </button>
        <button
          type="button"
          className="term-btn ghost-dim"
          disabled={sending}
          aria-label="Cancelar envio da mensagem na fila"
          data-tip={
            sending
              ? 'o envio já começou; aguarde a confirmação'
              : 'retira esta mensagem da fila sem interromper a resposta atual'
          }
          onClick={() => {
            if (!onCancel()) {
              setActionError('Não foi possível confirmar o cancelamento. A mensagem foi preservada; confira o estado da fila e tente novamente.')
            }
          }}
        >
          cancelar envio
        </button>
      </div>
    </aside>
  )
}

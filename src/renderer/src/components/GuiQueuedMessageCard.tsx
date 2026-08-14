import type { GuiQueuedMessage } from '../guiMessageQueue'
import './GuiQueuedMessageCard.css'
import GuiAttachmentChips from './GuiAttachmentChips'

interface GuiQueuedMessageCardProps {
  message: GuiQueuedMessage
  optionsLabel?: string
  onEdit: () => void
  onDelete: () => void
  onRetry: () => void
}

export default function GuiQueuedMessageCard({
  message,
  optionsLabel,
  onEdit,
  onDelete,
  onRetry
}: GuiQueuedMessageCardProps) {
  const failed = Boolean(message.deliveryError)
  const sending = Boolean(message.deliveryInFlight)
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
      </div>
      <div className="gui-queued-message-actions">
        {failed && !sending && (
          <button type="button" className="term-btn" onClick={onRetry}>
            tentar novamente
          </button>
        )}
        <button type="button" className="term-btn ghost-dim" disabled={sending} onClick={onEdit}>
          editar
        </button>
        <button
          type="button"
          className="term-btn ghost-dim"
          disabled={sending}
          aria-label="Apagar mensagem da fila"
          onClick={onDelete}
        >
          apagar
        </button>
      </div>
    </aside>
  )
}

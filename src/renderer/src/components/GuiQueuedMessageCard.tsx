import { useState } from 'react'
import type { GuiQueuedMessage } from '../guiMessageQueue'
import './GuiQueuedMessageCard.css'
import GuiAttachmentChips from './GuiAttachmentChips'
import GuiBrowserReferenceChips from './GuiBrowserReferenceChips'
import { ownerForceLabel } from '../guiOwnerBubble'

interface GuiQueuedMessageCardProps {
  paneId: string
  message: GuiQueuedMessage
  onCancel: () => boolean
  onReadNow: () => void
  readNowDisabled?: boolean
}

export default function GuiQueuedMessageCard({
  paneId,
  message,
  onCancel,
  onReadNow,
  readNowDisabled
}: GuiQueuedMessageCardProps) {
  const failed = Boolean(message.deliveryError)
  const sending = Boolean(message.deliveryInFlight)
  const [actionError, setActionError] = useState<string | null>(null)
  return (
    <div
      className={`gui-msg user gui-queued-message${failed ? ' has-error' : ''}${sending ? ' is-sending' : ''}`}
      role="group"
      aria-label="Mensagem na fila"
    >
      <span className="gui-msg-tag">você</span>
      <GuiAttachmentChips attachments={message.attachments} className="gui-msg-attachments" />
      <GuiBrowserReferenceChips paneId={paneId} references={message.browserReferences ?? []} className="gui-msg-browser-references" />
      {message.text.trim() && <div className="gui-msg-text">{message.text}</div>}
      <div className="gui-owner-state gui-owner-state-unread gui-queued-message-actions">
        <i className="gui-owner-state-mark" aria-hidden="true" />
        <span>{sending ? 'enviando…' : 'não lida ainda'}</span>
        <button
          type="button"
          className="gui-owner-force"
          disabled={sending || readNowDisabled}
          aria-label={ownerForceLabel(message.text)}
          data-tip={
            readNowDisabled
              ? 'a ponte do chat está fora do ar — aguarde a conversa abrir'
              : 'força o agente a parar e ler esta mensagem agora'
          }
          onClick={onReadNow}
        >
          ler agora
        </button>
        <button
          type="button"
          className="gui-owner-force gui-owner-cancel"
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
          cancelar
        </button>
      </div>
      <div className="gui-queued-message-error" role="alert">
        {actionError || message.deliveryError}
      </div>
    </div>
  )
}

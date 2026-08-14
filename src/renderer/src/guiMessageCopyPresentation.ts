import type { GuiItem, GuiPaneStatus } from './store'

interface GuiMessageCopyPlacement {
  items: readonly GuiItem[]
  assistantId: string
  status: GuiPaneStatus
  stream: string
  thinking: boolean
  awaitingInteraction: boolean
}

/**
 * A cópia pertence somente ao fechamento factual do turno. Uma fala já
 * revelada pode continuar em seguida com ferramenta ou outro texto, portanto
 * o texto da mensagem nunca é usado para decidir a posição do controle.
 */
export function isGuiFinalAssistantMessage({
  items,
  assistantId,
  status,
  stream,
  thinking,
  awaitingInteraction
}: GuiMessageCopyPlacement): boolean {
  if (status !== 'idle' || stream || thinking || awaitingInteraction) return false

  const lastItem = items.at(-1)
  return (
    lastItem?.kind === 'assistant' &&
    lastItem.id === assistantId &&
    !lastItem.live &&
    lastItem.animateFrom >= lastItem.text.length
  )
}

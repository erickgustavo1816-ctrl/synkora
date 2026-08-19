import type { GuiItem, GuiPaneStatus } from './store'

interface GuiTurnClosePlacement {
  items: readonly GuiItem[]
  status: GuiPaneStatus
  stream: string
  thinking: boolean
  awaitingInteraction: boolean
}

interface GuiMessageCopyPlacement extends GuiTurnClosePlacement {
  assistantId: string
}

/**
 * O pós-escrito não fecha o turno. O selo ⏱ da rodada (store.ts) e os recibos
 * pós-idle (troca de modo, interrupção pedida) entram como `note` DEPOIS da
 * resposta; quem fecha o turno de fato é a última fala ANTES deles.
 */
function guiTurnClosingItem(items: readonly GuiItem[]): GuiItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind !== 'note') return item
  }
  return undefined
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

  const closing = guiTurnClosingItem(items)
  return (
    closing?.kind === 'assistant' &&
    closing.id === assistantId &&
    !closing.live &&
    closing.animateFrom >= closing.text.length
  )
}

/**
 * Id da fala que recebe o controle, ou null quando nada fecha o turno. Achar o
 * fechamento é parte da régua e mora aqui: procurar por `items.at(-1)` no
 * chamador era exatamente o que o selo de rodada derrubava.
 */
export function guiCopyableAssistantId(placement: GuiTurnClosePlacement): string | null {
  const closing = guiTurnClosingItem(placement.items)
  if (closing?.kind !== 'assistant') return null
  return isGuiFinalAssistantMessage({ ...placement, assistantId: closing.id })
    ? closing.id
    : null
}

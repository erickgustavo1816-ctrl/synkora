import type { GuiPaneStatus } from './store'

export interface GuiThinkingPresentationInput {
  status: GuiPaneStatus
  stream: string
  activeAssistantId: string | null
  thinking: boolean
  /** Atividade de ferramenta: o próprio card é a superfície factual. */
  activityText: string | null
  awaitingInteraction: boolean
}

export interface GuiThinkingPresentation {
  label: string
}

/**
 * Indicador exclusivamente de apresentação. Ele não entra no transcript e
 * só existe enquanto o estado canônico ainda diz que um turno está trabalhando.
 * Assim o envio tem confirmação imediata, sem fingir que há atividade depois do
 * resultado, de uma ferramenta ou de uma interação humana.
 */
export function guiThinkingPresentation({
  status,
  stream,
  activeAssistantId,
  thinking,
  activityText,
  awaitingInteraction
}: GuiThinkingPresentationInput): GuiThinkingPresentation | null {
  if (
    status !== 'working' ||
    stream ||
    activeAssistantId ||
    activityText ||
    awaitingInteraction
  ) {
    return null
  }

  // `thinking.text` pode carregar raciocínio interno do backend. A UI usa
  // somente o sinal factual de atividade e nunca reproduz esse conteúdo.
  return { label: thinking ? 'o agente está pensando' : 'o agente está preparando a resposta' }
}

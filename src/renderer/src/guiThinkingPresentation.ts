import type { GuiPaneStatus } from './store'

export interface GuiThinkingPresentationInput {
  status: GuiPaneStatus
  stream: string
  activeAssistantId: string | null
  thinking: boolean
  /** Ferramenta ainda sem resultado, inclusive fora da janela visível. */
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
 * resultado ou durante uma interação humana que bloqueia o turno.
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
    awaitingInteraction
  ) {
    return null
  }

  // `thinking.text` pode carregar raciocínio interno do backend. A UI usa
  // somente o sinal factual de atividade e nunca reproduz esse conteúdo.
  return {
    label: thinking
      ? 'o agente está pensando'
      : activityText
        ? 'aguardando retorno da ferramenta'
        : 'o agente está preparando a resposta'
  }
}

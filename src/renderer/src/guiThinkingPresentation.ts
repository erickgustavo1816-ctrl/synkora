import type { GuiPaneStatus } from './store'

export interface GuiThinkingPresentationInput {
  status: GuiPaneStatus
  turnActive?: boolean
  stream: string
  activeAssistantId: string | null
  thinking: boolean
  contextCompacting?: boolean
  /** Ferramenta ainda sem resultado, inclusive fora da janela visível. */
  activityText: string | null
  awaitingInteraction: boolean
}

/** A FASE factual do turno do pai — o que o pulso (guiAgentPulse) veste com
 *  verbo, gesto e relógio. */
export type GuiThinkingPhase = 'compacting' | 'thinking' | 'tool' | 'responding' | 'preparing'

export interface GuiThinkingPresentation {
  label: string
  phase: GuiThinkingPhase
}

/**
 * Indicador exclusivamente de apresentação. Ele não entra no transcript e
 * só existe enquanto o estado canônico ainda diz que um turno está trabalhando.
 * Assim o envio tem confirmação imediata, sem fingir que há atividade depois do
 * resultado ou durante uma interação humana que bloqueia o turno.
 */
export function guiThinkingPresentation({
  status,
  turnActive,
  stream,
  activeAssistantId,
  thinking,
  contextCompacting,
  activityText,
  awaitingInteraction
}: GuiThinkingPresentationInput): GuiThinkingPresentation | null {
  if (contextCompacting && status !== 'dead' && !awaitingInteraction) {
    return { label: 'Compactando contexto…', phase: 'compacting' }
  }
  if (status !== 'working' || turnActive === false || awaitingInteraction) {
    return null
  }

  // `thinking.text` pode carregar raciocínio interno do backend. A UI usa
  // somente o sinal factual de atividade e nunca reproduz esse conteúdo.
  // Texto parcial não encerra o turno: outra fase de pensamento/ferramenta
  // pode começar depois dele, antes de o backend confirmar o resultado.
  if (thinking) return { label: 'o agente está pensando', phase: 'thinking' }
  if (activityText) return { label: 'aguardando retorno da ferramenta', phase: 'tool' }
  if (stream || activeAssistantId) return { label: 'o agente está respondendo', phase: 'responding' }
  return { label: 'o agente está preparando a resposta', phase: 'preparing' }
}

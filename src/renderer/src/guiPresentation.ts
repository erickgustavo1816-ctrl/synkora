const GUI_PRESENTATION_SEQ_CAP = 16

type PresentationEvent = {
  type?: unknown
  continues?: unknown
}

type PresentationItem = {
  kind?: unknown
  live?: unknown
  animateFrom?: unknown
  text?: unknown
}

/** Eventos cujo desfecho pode estar retido no main aguardando a tela. */
export function isGuiPresentationTerminal(event: PresentationEvent): boolean {
  if (event.type === 'result' || event.type === 'fatal' || event.type === 'closed') return true
  return event.type === 'turn-continuation' && event.continues === false
}

/** Fila curta e idempotente: fatal + closed precisam confirmar SEQs distintos. */
export function appendGuiPresentationSeq(current: number[], seq: number): number[] {
  if (!Number.isSafeInteger(seq) || seq <= 0 || current.includes(seq)) return current
  return [...current.slice(-(GUI_PRESENTATION_SEQ_CAP - 1)), seq]
}

/** O toast só pode sair quando nenhuma resposta ainda estiver sendo revelada. */
export function isGuiTranscriptPresented(items: PresentationItem[]): boolean {
  return items.every((item) => {
    if (item.kind !== 'assistant') return true
    if (item.live === true) return false
    const textLength = typeof item.text === 'string' ? item.text.length : 0
    const shown = typeof item.animateFrom === 'number' ? item.animateFrom : textLength
    return shown >= textLength
  })
}

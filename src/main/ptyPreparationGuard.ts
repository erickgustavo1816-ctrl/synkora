/**
 * Prova de geração usada depois de uma preparação assíncrona de seat.
 * Objetos de identidade/spec são comparados por referência de propósito:
 * um remount que reutiliza o paneId publica uma nova geração e deve invalidar
 * a continuação antiga, mesmo quando todos os campos visíveis coincidem.
 */
export interface PtyPreparationGuardInput<Identity extends object, Spec extends object> {
  ticketMatches: boolean
  senderAlive: boolean
  closing: boolean
  requiresPaneGeneration: boolean
  capturedIdentity?: Identity
  currentIdentity?: Identity
  capturedToken?: string
  currentToken?: string
  capturedSpec?: Spec
  currentSpec?: Spec
  phaseStillActive: boolean
}

export function ptyPreparationCanContinue<Identity extends object, Spec extends object>(
  input: PtyPreparationGuardInput<Identity, Spec>
): boolean {
  if (!input.ticketMatches || !input.senderAlive || input.closing) return false
  if (!input.requiresPaneGeneration) return true
  return Boolean(
    input.capturedIdentity &&
      input.currentIdentity === input.capturedIdentity &&
      input.capturedToken &&
      input.currentToken === input.capturedToken &&
      input.currentSpec === input.capturedSpec &&
      input.phaseStillActive
  )
}

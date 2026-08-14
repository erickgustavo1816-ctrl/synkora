export type GuiNoticeKind = 'needs-you' | 'finished' | 'failed'

export interface GuiAlertPayload {
  paneId: string
  projectId: string
  kind: GuiNoticeKind
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function terminalNoticeKind(event: unknown): GuiNoticeKind | null {
  const value = recordOf(event)
  if (value?.['type'] !== 'result') return null
  if (value['outcome'] === 'cancelled') return null
  return value['isError'] === true || value['outcome'] === 'failed' ? 'failed' : 'finished'
}

function mergeTerminalNotice(
  previous: GuiNoticeKind | null,
  next: GuiNoticeKind
): GuiNoticeKind {
  return previous === 'failed' || next === 'failed' ? 'failed' : 'finished'
}

/**
 * Agrega uma fila de turnos: `result.continues` não anuncia cedo e o último
 * terminal publica um único desfecho. Instanciado por sessão viva; replay não
 * passa por ele.
 */
export class GuiAlertSequencer {
  private continuedTerminal: GuiNoticeKind | null = null
  private pendingPresentation: { seq: number; kind: GuiNoticeKind } | null = null
  private terminalFailureQueued = false

  /**
   * Pedidos que realmente param o agente acordam o dono na hora. Desfechos
   * ficam retidos ate o renderer confirmar o `seq` terminal que apresentou;
   * assim som, titulo e toast nao correm na frente do texto palavra a palavra.
   */
  accept(event: unknown, seq: number): GuiNoticeKind | null {
    const value = recordOf(event)
    const type = value?.['type']
    if (!value || typeof type !== 'string') return null

    if (type === 'turn-started' || type === 'session-restarted') {
      this.terminalFailureQueued = false
    }

    if (type === 'permission' || type === 'question' || type === 'plan-review') {
      return 'needs-you'
    }

    if (
      type === 'fatal' ||
      (type === 'closed' && typeof value['code'] === 'number' && value['code'] !== 0)
    ) {
      this.continuedTerminal = null
      if (this.terminalFailureQueued) return null
      this.terminalFailureQueued = true
      this.queueForPresentation(seq, 'failed')
      return null
    }

    if (type === 'result') {
      const kind = terminalNoticeKind(event)
      if (!kind) {
        if (value['continues'] === true) return null
        const priorFailure = this.continuedTerminal === 'failed' ? 'failed' : null
        this.continuedTerminal = null
        if (priorFailure) {
          this.terminalFailureQueued = true
          this.queueForPresentation(seq, priorFailure)
        }
        return null
      }
      if (value['continues'] === true) {
        this.continuedTerminal = mergeTerminalNotice(this.continuedTerminal, kind)
        return null
      }
      const finalKind = mergeTerminalNotice(this.continuedTerminal, kind)
      this.continuedTerminal = null
      if (finalKind === 'failed') this.terminalFailureQueued = true
      this.queueForPresentation(seq, finalKind)
      return null
    }

    if (type === 'turn-continuation' && value['continues'] === false) {
      const kind = this.continuedTerminal
      this.continuedTerminal = null
      if (kind) {
        if (kind === 'failed') this.terminalFailureQueued = true
        this.queueForPresentation(seq, kind)
      }
    }

    return null
  }

  /** ACK fechado: somente o MESMO seq terminal libera o alerta canonico. */
  presented(terminalSeq: number): GuiNoticeKind | null {
    const pending = this.pendingPresentation
    if (!pending || pending.seq !== terminalSeq) return null
    this.pendingPresentation = null
    return pending.kind
  }

  private queueForPresentation(seq: number, kind: GuiNoticeKind): void {
    if (!Number.isSafeInteger(seq) || seq <= 0) return
    const previous = this.pendingPresentation
    this.pendingPresentation = {
      seq,
      kind: previous ? mergeTerminalNotice(previous.kind, kind) : kind
    }
  }
}

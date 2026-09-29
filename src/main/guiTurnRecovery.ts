import { randomUUID } from 'node:crypto'
import type { SessionEvent } from './maestroSession'

type TurnResult = Extract<SessionEvent, { type: 'result' }>

export const GUI_TURN_RECOVERY_PROMPT = `[synkora: continuação autorizada após falha de turno]
Continue o trabalho pendente nesta conversa a partir do histórico existente.
Antes de agir, confira o estado atual, as ferramentas já concluídas e seus recibos. Preserve o trabalho concluído e reconcilie efeitos cujo resultado ficou incerto antes de decidir repetir qualquer ação.
Esta é uma nova instrução de continuação: não reenvie o pedido anterior, seus anexos ou chamadas de ferramentas. Execute somente o que ainda falta e explique qualquer impedimento ao dono.`

export function withoutGuiTurnRecovery(event: SessionEvent): SessionEvent {
  if (event.type !== 'result' || event.recoveryToken === undefined) return event
  const result = { ...event }
  delete result.recoveryToken
  return result
}

export class GuiTurnRecovery {
  conversationId?: string
  revision = 0
  private readonly terminalTurns = new Set<string>()
  private authority?: { token: string; turnId: string; identity: string }

  get token(): string | undefined {
    return this.authority?.token
  }

  invalidate(): boolean {
    const revoked = this.authority !== undefined
    this.authority = undefined
    this.revision += 1
    return revoked
  }

  observe(event: SessionEvent): boolean {
    switch (event.type) {
      case 'init':
      case 'session-id': {
        if (event.sessionId === this.conversationId) return false
        this.conversationId = event.sessionId
        return this.invalidate()
      }
      case 'fatal':
      case 'closed':
      case 'conversation-cleared':
      case 'session-restarted':
        this.conversationId = undefined
        return this.invalidate()
      case 'result':
        return event.isError === true && event.outcome === 'failed' && event.turnId &&
          this.terminalTurns.has(event.turnId) ? false : this.invalidate()
      case 'tool':
        return event.parentToolUseId ? false : this.invalidate()
      case 'turn-started':
      case 'turn-retry':
      case 'user-message':
      case 'executor-changed':
      case 'thinking':
      case 'delta':
      case 'text':
        return this.invalidate()
      default:
        return false
    }
  }

  result(event: TurnResult, identity: string | undefined, eligible: boolean, revision: number): TurnResult {
    const result = withoutGuiTurnRecovery(event) as TurnResult
    if (event.turnId && this.terminalTurns.has(event.turnId)) return result
    if (event.turnId) this.terminalTurns.add(event.turnId)
    this.authority = undefined
    if (!eligible || !identity || revision !== this.revision || !event.turnId ||
      event.outcome !== 'failed' || event.isError !== true || event.interrupted === true ||
      event.continues === true || event.turnActive !== false) return result
    this.authority = { token: randomUUID(), turnId: event.turnId, identity }
    return { ...result, recoveryToken: this.authority.token }
  }

  authorizes(token: unknown, identity: string | undefined, turnId?: string): boolean {
    return Boolean(this.authority && identity && this.authority.identity === identity &&
      this.authority.token === token && (turnId === undefined || turnId === this.authority.turnId))
  }
}

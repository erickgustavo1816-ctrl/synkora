export type GuiTransportStatus = 'starting' | 'working' | 'waiting-you' | 'idle' | 'dead'

const DEAD_SESSION = /(?:não tem sessão|sessão[^\n]*encerrou|ponte[^\n]*não[^\n]*disponível)/iu

/** Falha conhecida de sessão fecha o pane; falha transitória apenas para. */
export function guiTransportFailureStatus(
  current: GuiTransportStatus,
  error?: string
): GuiTransportStatus {
  if (current === 'dead' || DEAD_SESSION.test(error ?? '')) return 'dead'
  return 'idle'
}

export function canSendGuiMessage(status: GuiTransportStatus, ready: boolean): boolean {
  return ready && status !== 'starting' && status !== 'dead'
}

/**
 * TURNO VIVO: o agente ainda está escrevendo. `working` cobre o turno e o
 * stream aberto cobre a janela em que os deltas já chegam antes de o status
 * assentar. É a cerca que segura o card da PROPOSTA DE PLANO até a fala
 * terminar — decisão do dono (2026-08-15): nada de card no meio da resposta;
 * ele aparece embaixo dela, pronto, e fica até a decisão.
 */
export function isGuiTurnActive(status: GuiTransportStatus, stream: string): boolean {
  return status === 'working' || stream.length > 0
}

/** Um comando local termina apenas o busy que ele proprio abriu. Ele nunca
 * terminaliza um turno real nem esconde uma interacao humana pendente. */
export function guiCommandCompletionStatus(
  current: GuiTransportStatus,
  continues: boolean,
  waitingForHuman: boolean
): GuiTransportStatus {
  if (current === 'dead') return 'dead'
  if (waitingForHuman) return 'waiting-you'
  return continues ? 'working' : 'idle'
}

export function shouldApplyGuiBufferedEvent(seq: number | null, snapshotCursor: number): boolean {
  return seq === null || seq > snapshotCursor
}

export function shouldCreateGuiSession(replayExists: boolean, replayAlive: boolean): boolean {
  return !replayExists || !replayAlive
}

/** Init/ready comuns nao podem ressuscitar um terminal sem boundary de retry. */
export function guiBackendReadyStatus(current: GuiTransportStatus): GuiTransportStatus {
  return current === 'starting' ? 'idle' : current
}

export function guiSessionRestartState(
  currentReady: boolean,
  boundarySawReady: boolean
): { ready: boolean; status: GuiTransportStatus } {
  const ready = currentReady && boundarySawReady
  return { ready, status: ready ? 'idle' : 'starting' }
}

/**
 * Uma fotografia morta pode terminar no meio de um delta. Antes de abrir a
 * geração seguinte, esse assistant parcial vira histórico fechado; caso
 * contrário o primeiro delta novo seria concatenado ao texto anterior.
 */
export function settleGuiRespawnStream<
  T extends { id: string; kind: string; live?: boolean }
>(
  items: T[],
  activeAssistantId: string | null,
  turnHadText: boolean
): { items: T[]; stream: ''; activeAssistantId: null; turnHadText: boolean } {
  let found = false
  const settled = items.map((item) => {
    if (item.id !== activeAssistantId || item.kind !== 'assistant') return item
    found = true
    return { ...item, live: false } as T
  })
  return {
    items: settled,
    stream: '',
    activeAssistantId: null,
    turnHadText: turnHadText || found
  }
}

export interface GuiTurnIdentity {
  eventRevision: number
  startedAt: number | null
}

export function isSameGuiTurn(
  current: GuiTurnIdentity,
  captured: GuiTurnIdentity
): boolean {
  return (
    current.eventRevision === captured.eventRevision && current.startedAt === captured.startedAt
  )
}

/** Uma resposta IPC atrasada pode informar a falha, mas nunca rebaixar um
 * turno que já recebeu evento novo do backend. */
export function settleGuiActionFailure(
  current: GuiTurnIdentity & { status: GuiTransportStatus },
  captured: GuiTurnIdentity,
  error?: string
): { sameTurn: boolean; status: GuiTransportStatus } {
  const sameTurn = isSameGuiTurn(current, captured)
  return {
    sameTurn,
    status: sameTurn ? guiTransportFailureStatus(current.status, error) : current.status
  }
}

export interface GuiSendBatch {
  id: string
  requestIds: string[]
  /** Revisão do último evento real do backend quando o lote nasceu. */
  eventRevision: number
  /** O lote abriu o estado `working`, em vez de entrar num turno existente. */
  startedTurn: boolean
  /** Pelo menos um envio do lote foi aceito pelo main. */
  accepted: boolean
}

/**
 * Envios que se sobrepõem compartilham um lote. Assim, a última falha só pode
 * fechar o `working` quando nenhum envio foi aceito e nenhum evento mais novo
 * do backend chegou desde o primeiro clique.
 */
export function beginGuiSendBatch(
  current: GuiSendBatch | null,
  batchId: string,
  requestId: string,
  eventRevision: number,
  startedTurn: boolean
): GuiSendBatch {
  // Um evento real do backend separa os turnos. Promises IPC antigas ainda
  // podem estar pendentes, mas um envio posterior já pertence a outro lote.
  if (current?.eventRevision === eventRevision) {
    return { ...current, requestIds: [...current.requestIds, requestId] }
  }
  return {
    id: batchId,
    requestIds: [requestId],
    eventRevision,
    startedTurn,
    accepted: false
  }
}

export function settleGuiSendBatch(
  current: GuiSendBatch | null,
  batchId: string,
  requestId: string,
  accepted: boolean,
  currentEventRevision: number
): { batch: GuiSendBatch | null; closeTurn: boolean } {
  if (!current || current.id !== batchId || !current.requestIds.includes(requestId)) {
    return { batch: current, closeTurn: false }
  }

  const requestIds = current.requestIds.filter((id) => id !== requestId)
  const batchAccepted = current.accepted || accepted
  if (requestIds.length > 0) {
    return {
      batch: { ...current, requestIds, accepted: batchAccepted },
      closeTurn: false
    }
  }

  return {
    batch: null,
    closeTurn:
      !batchAccepted && current.startedTurn && current.eventRevision === currentEventRevision
  }
}

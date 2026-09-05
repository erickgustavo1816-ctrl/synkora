import type { SessionEvent } from './maestroSession'

export const INTEGRATION_REPLY_TIMEOUT_MS = 30_000

/** IDs vêm do stream do CLI; texto de conversa nunca decide o recibo. */
export function pendingIntegrationTool(events: readonly SessionEvent[]): string | undefined {
  const pending = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool' && event.toolUseId) {
      const input = event.input
      const synkora = input && typeof input === 'object' && 'server' in input && input.server === 'synkora'
      if (event.name === 'mcp__synkora__integration_run' || (event.name === 'integration_run' && synkora))
        pending.add(event.toolUseId)
    }
    if (event.type === 'tool-result' && event.toolUseId) pending.delete(event.toolUseId)
  }
  return [...pending].at(-1)
}

interface ReplyWait {
  toolUseId?: string
  acknowledged: boolean
  terminal: boolean
  cancelTimer: () => void
  start: () => void
}

/** Apenas espera o recibo. O motor da missão continua dono de Git, fila e reparo. */
export class GuiIntegrationReply {
  private readonly waits = new Map<object, ReplyWait>()

  constructor(private readonly setTimer = (ms: number, fn: () => void): (() => void) => {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return () => clearTimeout(timer)
  }) {}

  arm(
    generation: object,
    toolUseId: string | undefined,
    mergedText: string,
    emit: (event: SessionEvent) => void,
    finish: () => Promise<string>
  ): void {
    if (this.waits.has(generation)) throw new Error('já existe um fecho de integração neste chat')
    const wait: ReplyWait = {
      toolUseId, acknowledged: false, terminal: false, cancelTimer: () => {},
      start: () => {
        if (!this.waits.delete(generation)) return
        wait.cancelTimer()
        // Saída do parser/dispose primeiro; nenhuma limpeza dentro do evento
        // que ainda está salvando o próprio transcript.
        setImmediate(() => {
          if (!wait.acknowledged && toolUseId)
            emit({ type: 'tool-result', toolUseId, text: mergedText, isError: false })
          if (!wait.terminal) emit({ type: 'result', isError: false })
          emit({ type: 'command-output', text: '⇪ merge confirmado; liberando a pasta e finalizando a fila…' })
          void Promise.resolve().then(finish).then(
            (text) => emit({ type: 'command-output', text }),
            () => emit({ type: 'command-output', text: '⇪ merge confirmado; a finalização falhou. O ponto de recuperação foi preservado. Não repita o merge.' })
          )
        })
      }
    }
    this.waits.set(generation, wait)
    wait.cancelTimer = this.setTimer(INTEGRATION_REPLY_TIMEOUT_MS, wait.start)
  }

  observe(generation: object, event: SessionEvent): void {
    const wait = this.waits.get(generation)
    if (!wait) return
    if (event.type === 'tool-result' && event.toolUseId === wait.toolUseId && wait.toolUseId)
      wait.acknowledged = true
    if (event.type === 'result' && !event.continues) {
      wait.terminal = true
      wait.start()
    } else if (event.type === 'closed' || event.type === 'fatal') {
      wait.start()
    }
  }

  disposed(generation: object): void {
    this.waits.get(generation)?.start()
  }
}

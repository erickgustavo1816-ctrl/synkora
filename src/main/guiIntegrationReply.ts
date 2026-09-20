import type { SessionEvent } from './maestroSession'

export const INTEGRATION_REPLY_TIMEOUT_MS = 30_000
export type IntegrationReplyPhase = 'merge' | 'finalization'

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

/**
 * A RODADA DO DONO NÃO ACABA COM O TURNO DO AGENTE (print de 2026-09-16).
 *
 * O merge pousa dentro da tool; a finalização (matar o dev para soltar a pasta,
 * remover worktree e branch, fazer a fila andar) roda DEPOIS do turno. Para o
 * dono isso é uma coisa só: "cliquei ⇪, a missão integrou". Então o `result`
 * do agente que chega com o fecho armado é republicado como CONTINUAÇÃO
 * (`continues: true`) — o relógio da rodada segue e a cabeça do palco continua
 * "trabalhando" — e o fecho é quem fecha a rodada (`turn-continuation`
 * terminal) quando não há mais ninguém para falar.
 *
 * Quando a pasta fica presa, a MESMA conversa é retomada na raiz do projeto e
 * HERDA a rodada: o CLI liquida o resume com um `result` próprio (o transcript
 * de 2026-09-16 mostra a tarefa de fundo morta virando tool-result de erro +
 * result antes de qualquer fala) — esse result é absorvido; só um `result`
 * depois de ATIVIDADE do modelo (pensar, falar, chamar tool) fecha a rodada.
 * Sinal estrutural, nunca leitura de conteúdo.
 */
interface RoundEnvelope {
  activity: boolean
}

/** Apenas espera o recibo. O motor da missão continua dono de Git, fila e reparo. */
export class GuiIntegrationReply {
  private readonly waits = new Map<object, ReplyWait>()
  private readonly envelopes = new Map<object, RoundEnvelope>()

  constructor(private readonly setTimer = (ms: number, fn: () => void): (() => void) => {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return () => clearTimeout(timer)
  }) {}

  /**
   * `afterFinish` devolve a GERAÇÃO retomada (o token da conversa que herda a
   * rodada) ou nada — e "nada" é o que fecha a rodada no fio. Texto vazio de
   * `finish` não vira nota: a nota de abertura já contou o que está acontecendo.
   */
  arm(
    generation: object,
    toolUseId: string | undefined,
    mergedText: string,
    emit: (event: SessionEvent) => void,
    finish: () => Promise<string>,
    afterFinish?: () => object | undefined | void,
    phase: IntegrationReplyPhase = 'merge'
  ): void {
    if (this.waits.has(generation)) throw new Error('já existe um fecho de integração neste chat')
    const closeRound = (): void => emit({ type: 'turn-continuation', continues: false, turnActive: false })
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
          // Sem result do CLI (prazo, morte): o terminal sintético também não
          // fecha a rodada — o app ainda está finalizando.
          if (!wait.terminal) emit({ type: 'result', isError: false, continues: true })
          emit({ type: 'command-output', text: phase === 'merge'
            ? '⇪ merge confirmado; liberando a pasta e finalizando a fila…'
            : '↻ conferindo o registro e retomando a finalização…' })
          void Promise.resolve().then(finish).then(
            (text) => { if (text.trim()) emit({ type: 'command-output', text }) },
            () => emit({ type: 'command-output', text: phase === 'merge'
              ? '⇪ merge confirmado; a finalização falhou. O ponto de recuperação foi preservado. Não repita o merge.'
              : '↻ a finalização falhou; o registro foi preservado para diagnóstico pelo agente.' })
          ).then(() => {
            let resumed: object | undefined
            try {
              resumed = afterFinish?.() ?? undefined
            } catch {
              emit({ type: 'command-output', text: '↻ o reparo está registrado; reabra esta conversa para o agente retomar a finalização.' })
            }
            if (resumed) this.envelopes.set(resumed, { activity: false })
            else closeRound()
          })
        })
      }
    }
    this.waits.set(generation, wait)
    wait.cancelTimer = this.setTimer(INTEGRATION_REPLY_TIMEOUT_MS, wait.start)
  }

  /** Lê o evento ANTES do anel e devolve o que deve ser publicado. */
  observe(generation: object, event: SessionEvent): SessionEvent {
    const wait = this.waits.get(generation)
    if (wait) {
      if (event.type === 'tool-result' && event.toolUseId === wait.toolUseId && wait.toolUseId)
        wait.acknowledged = true
      if (event.type === 'result' && !event.continues) {
        wait.terminal = true
        wait.start()
        // O turno do agente acabou de verdade (`turnActive` fica como veio); a
        // rodada que o dono vê continua — quem fecha é o fecho.
        return { ...event, continues: true }
      }
      if (event.type === 'closed' || event.type === 'fatal') wait.start()
      return event
    }
    const envelope = this.envelopes.get(generation)
    if (!envelope) return event
    switch (event.type) {
      case 'thinking':
      case 'delta':
      case 'text':
        envelope.activity = true
        return event
      case 'tool':
        if (!event.parentToolUseId) envelope.activity = true
        return event
      case 'result':
        if (event.continues) return event
        if (!envelope.activity) return { ...event, continues: true }
        this.envelopes.delete(generation)
        return event
      case 'closed':
      case 'fatal':
        this.envelopes.delete(generation)
        return event
      default:
        return event
    }
  }

  disposed(generation: object): void {
    this.waits.get(generation)?.start()
    this.envelopes.delete(generation)
  }
}

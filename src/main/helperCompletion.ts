export interface HelperCompletionDelivery {
  id: number
  text: string
  consumed: boolean
}

/** O que o aviso de conclusão deve carregar para UM destino específico:
 *  'full'  — destino nunca leu nada do ajudante: recebe o resultado inteiro;
 *  'short' — destino JÁ acompanhou a saída via helper_output: recebe só o
 *            sinal de conclusão (reinjetar o payload é o "digita de novo o
 *            resultado" que o usuário via — bug real, 2026-08-03);
 *  'skip'  — destino leu a conclusão APÓS o report (consumiu): nada a enviar. */
export type HelperCompletionNoticeMode = 'full' | 'short' | 'skip'

interface PendingHelperCompletion {
  id: number
  delegatorPaneId?: string
  text: string
  /** panes que leram helper_output DEPOIS do report (têm a conclusão) */
  consumedBy: Set<string>
}

/**
 * Coordena a entrega assíncrona do resultado de um ajudante.
 *
 * O report pode chegar enquanto a resposta final ainda está sendo impressa.
 * Cada destino (delegador e/ou orquestrador) que já consumiu a conclusão por
 * helper_output não deve receber uma segunda entrega; quem só acompanhou a
 * saída antes do report recebe o sinal de conclusão sem o payload repetido.
 */
export class HelperCompletionTracker {
  private sequence = 0
  private readonly pending = new Map<string, PendingHelperCompletion>()
  /** leituras de helper_output em QUALQUER momento da vida do ajudante */
  private readonly outputReaders = new Map<string, Set<string>>()

  /** Toda leitura de helper_output registra o leitor — antes ou depois do
   *  report. É o que permite rebaixar o aviso para 'short' sem adivinhação. */
  noteOutputRead(helperPaneId: string, readerPaneId: string): void {
    const readers = this.outputReaders.get(helperPaneId) ?? new Set<string>()
    readers.add(readerPaneId)
    this.outputReaders.set(helperPaneId, readers)
  }

  report(helperPaneId: string, delegatorPaneId: string | undefined, text: string): number {
    const id = ++this.sequence
    this.pending.set(helperPaneId, {
      id,
      delegatorPaneId,
      text,
      consumedBy: new Set()
    })
    return id
  }

  /** Leitura pós-report por um leitor AUTORIZADO (delegador, ou maestro com
   *  `allowNonDelegator`) devolve a conclusão e marca o leitor como
   *  consumidor — a entrega pendente para ELE morre. */
  consumeViaOutput(
    helperPaneId: string,
    readerPaneId: string,
    allowNonDelegator = false
  ): HelperCompletionDelivery | undefined {
    const completion = this.pending.get(helperPaneId)
    if (!completion) return undefined
    if (completion.delegatorPaneId !== readerPaneId && !allowNonDelegator) return undefined
    completion.consumedBy.add(readerPaneId)
    return {
      id: completion.id,
      text: completion.text,
      consumed: true
    }
  }

  peek(helperPaneId: string, id: number): HelperCompletionDelivery | undefined {
    const completion = this.pending.get(helperPaneId)
    // Um segundo report substitui o primeiro. O timer antigo não entrega nem
    // fecha o pane antes de a conclusão mais recente aquietar.
    if (!completion || completion.id !== id) return undefined
    return {
      id: completion.id,
      text: completion.text,
      consumed: completion.delegatorPaneId !== undefined
        ? completion.consumedBy.has(completion.delegatorPaneId)
        : false
    }
  }

  /** Modo do aviso para um destino específico (ver HelperCompletionNoticeMode). */
  noticeMode(helperPaneId: string, id: number, targetPaneId: string): HelperCompletionNoticeMode {
    const completion = this.pending.get(helperPaneId)
    if (completion && completion.id === id && completion.consumedBy.has(targetPaneId)) return 'skip'
    if (this.outputReaders.get(helperPaneId)?.has(targetPaneId)) return 'short'
    return 'full'
  }

  /** Guarda de última hora do Hub (stillNeeded): o destino consumiu a
   *  conclusão entre o enfileiramento e a injeção? */
  wasConsumedBy(helperPaneId: string, id: number, targetPaneId: string): boolean {
    const completion = this.pending.get(helperPaneId)
    return !!completion && completion.id === id && completion.consumedBy.has(targetPaneId)
  }

  settle(helperPaneId: string, id: number): boolean {
    const completion = this.pending.get(helperPaneId)
    if (!completion || completion.id !== id) return false
    this.pending.delete(helperPaneId)
    // pós-entrega não há mais aviso a calibrar; segurar leitores é vazamento
    this.outputReaders.delete(helperPaneId)
    return true
  }

  discard(helperPaneId: string): void {
    this.pending.delete(helperPaneId)
    this.outputReaders.delete(helperPaneId)
  }
}

export function formatHelperCompletionNote(text: string, maxChars = 1200): string {
  const normalized = text.trim() || 'sem resumo'
  const limit = Math.max(80, maxChars)
  const clipped = normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
  return `[conclusão reportada pelo ajudante: ${clipped}]`
}

export function formatHelperCompletionShortNotice(helperPaneId: string): string {
  return `ajudante ${helperPaneId.slice(0, 8)} concluiu — você já acompanhou a saída dele via helper_output; se precisar, a conclusão completa continua lá (helper_output ${helperPaneId.slice(0, 8)}…)`
}

export function helperCompletionNotificationKey(helperPaneId: string, id: number): string {
  return `helper-completion:${helperPaneId}:${id}`
}

/**
 * CORREIO MCP entre panes (CHECK 15 F1, 2026-08-07 — decisão do dono: "quero
 * que os panes conversem sem precisar ficar digitando e dando enter; mais
 * natural" + "imagina se eu durmo e volto e não rodou nada porque uma
 * mensagem se perdeu — NÃO PODE").
 *
 * A mensagem vira registro DURÁVEL numa caixa postal por endereço estável e
 * chega ao agente DE CARONA no resultado da próxima tool MCP que ele chamar
 * (ou via check_messages). O terminal recebe apenas um aviso curto e fixo —
 * payload nunca mais viaja pelo teclado (a família inteira de fragilidade do
 * composer/fatiamento/Enter morre por desenho).
 *
 * F1: convive com o caminho antigo (pane SEM identidade MCP segue com a
 * injeção clássica). F2 (futuro): correlationId fim-a-fim para coalescer
 * eventos do mesmo fato; F1 deduplica por texto idêntico não-entregue.
 */
import { loadJsonStore, persistJsonStore } from './jsonStore'

export interface MailboxMessage {
  text: string
  at: string
  urgent?: boolean
}

const BOX_CAP = 60
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export class PaneMailbox {
  private data: Record<string, MailboxMessage[]>

  constructor(private readonly file: string) {
    this.data = loadJsonStore<Record<string, MailboxMessage[]>>(
      this.file,
      () => ({}),
      (value): value is Record<string, MailboxMessage[]> =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value as Record<string, unknown>).every(
          (box) =>
            Array.isArray(box) &&
            box.every(
              (m) =>
                typeof m === 'object' &&
                m !== null &&
                typeof (m as MailboxMessage).text === 'string' &&
                typeof (m as MailboxMessage).at === 'string'
            )
        )
    )
    this.pruneOld()
  }

  /** Posta no endereço; texto idêntico ainda não entregue coalesce (dedup F1). */
  post(key: string, message: MailboxMessage): 'posted' | 'coalesced' {
    const box = this.data[key] ?? []
    const dup = box.find((m) => m.text === message.text)
    if (dup) {
      dup.at = message.at
      dup.urgent = dup.urgent || message.urgent
      this.persist()
      return 'coalesced'
    }
    box.push(message)
    if (box.length > BOX_CAP) box.splice(0, box.length - BOX_CAP)
    this.data[key] = box
    this.persist()
    return 'posted'
  }

  /** Drena o endereço inteiro (a entrega registra o recibo no chamador). */
  drain(key: string): MailboxMessage[] {
    const box = this.data[key] ?? []
    if (box.length === 0) return []
    delete this.data[key]
    this.persist()
    return box
  }

  pending(key: string): number {
    return this.data[key]?.length ?? 0
  }

  /** Caixa de pane efêmero morto nunca vira lixo eterno. */
  dropBox(key: string): void {
    if (!this.data[key]) return
    delete this.data[key]
    this.persist()
  }

  private pruneOld(): void {
    const cutoff = Date.now() - PRUNE_AFTER_MS
    let dirty = false
    for (const [key, box] of Object.entries(this.data)) {
      const fresh = box.filter((m) => Date.parse(m.at) >= cutoff)
      if (fresh.length !== box.length) {
        dirty = true
        if (fresh.length === 0) delete this.data[key]
        else this.data[key] = fresh
      }
    }
    if (dirty) this.persist()
  }

  private persist(): void {
    persistJsonStore(this.file, this.data)
  }
}

/** Endereço DURÁVEL: pane de fase/gate usa card+papel (sobrevive a paneId
 * novo a cada reabertura); maestro/orquestrador usam o paneId estável;
 * ajudante usa o paneId efêmero (mensagem de helper morre com ele — aceito). */
export function mailboxKeyOf(
  identity: { taskId?: string; role?: string },
  paneId: string
): string {
  if (identity.taskId && identity.role) return `task:${identity.taskId}:${identity.role}`
  return `pane:${paneId}`
}

/** Bloco de carona anexado ao resultado da tool — o formato que o agente lê. */
export function formatInboxBlock(messages: MailboxMessage[]): string {
  if (messages.length === 0) return ''
  const lines = messages.map((m, i) => {
    const hh = m.at.slice(11, 16)
    return `${i + 1}. (${hh}${m.urgent ? ' · URGENTE' : ''}) ${m.text}`
  })
  return `\n\n[synkora inbox] ${messages.length} mensagem(ns) para você — trate como as linhas "[synkora]" do terminal:\n${lines.join('\n')}`
}

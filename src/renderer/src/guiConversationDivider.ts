/**
 * A FRONTEIRA DE CONVERSA NO FIO (2026-09-28, pedido do dono: "tem conversa
 * que não consigo ver o histórico todo").
 *
 * O /new, /reset e /clear trocam a conversa do CLI, mas o fio NÃO é mais
 * apagado: o que veio antes fica na tela e um divisor diz que o agente não
 * lembra dele. Este módulo guarda as duas réguas desse corte:
 *
 *  · o SELO da conversa que acabou — o processo dela morreu com o /new, então
 *    nada ali pode continuar pendente. Ferramenta sem desfecho vira cancelada,
 *    desfecho provisório vira definitivo e aviso transitório vira permanente.
 *    Sem isso, toda conta que varre o fio inteiro (órfã no fim do turno,
 *    pareamento anônimo de tool-result, limpeza do aviso transitório) leria
 *    pendência de uma conversa que não existe mais;
 *  · onde a conversa ATUAL começa: logo depois do ÚLTIMO divisor.
 *
 * Quem roda sob o type-stripping do node (lateral, barra de aceite, pulso) não
 * importa valor de irmão: repete a varredura de uma linha em vez de importar
 * `guiCurrentConversationStart`. A régua é a mesma — o `kind` do divisor.
 */
import type { GuiItem } from './store'
import { closePendingGuiTools } from './guiTerminalTools'

/** A frase do divisor: fato, sem convite. A receita (ler o que ficou para
 *  trás) é a linha do topo do fio e o leitor de conversas. */
export const GUI_CONVERSATION_DIVIDER_TEXT = 'conversa nova — o agente não lembra do que está acima'

/** Índice do primeiro item da conversa ATUAL: logo depois do último divisor
 *  (0 quando o fio nunca trocou de conversa). */
export function guiCurrentConversationStart(items: readonly { kind: string }[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind === 'divider') return index + 1
  }
  return 0
}

/**
 * Fecha a conversa que o /new encerrou. Lista intacta (mesma referência)
 * quando não havia nada pendente — o replay de um fio calmo não re-renderiza.
 *
 * O desfecho das pendentes é o `cancelled` do terminal comum: ninguém errou, a
 * conversa é que acabou antes do recibo. Agente só despachado segue a mesma
 * régua de `closePendingGuiTools` (cancelado com a árvore dele).
 */
export function sealGuiConversationItems(items: GuiItem[]): GuiItem[] {
  const closed = closePendingGuiTools(items, { type: 'result', isError: false, outcome: 'cancelled' })
  let changed = closed !== items
  const sealed = closed.map((item): GuiItem => {
    if (item.kind === 'tool' && item.result?.provisional === true) {
      changed = true
      const { provisional: _provisional, ...result } = item.result
      return { ...item, result }
    }
    if ((item.kind === 'note' || item.kind === 'error') && item.transient === true) {
      changed = true
      const { transient: _transient, ...permanent } = item
      return permanent
    }
    return item
  })
  return changed ? sealed : items
}

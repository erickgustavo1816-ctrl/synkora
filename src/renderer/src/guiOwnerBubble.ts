/**
 * O RECIBO DA FALA DO DONO (D6 do design de 2026-09-02).
 *
 * Queixa do dono, verbatim: *"ele tá deixando na fila"*. Três mensagens dele
 * ficaram três minutos dentro de um pote enquanto o agente rodava tools
 * nativas, e a tela não contava nada disso — a bolha subia igualzinha à de uma
 * fala entregue na hora. Agora o main manda `owner-message-state` e a bolha
 * ganha, embaixo, um carimbo de recibo com três palavras: o agente está sendo
 * PARADO, a fala foi ENTREGUE (com a hora) ou já foi RESPONDIDA.
 *
 * Módulo PURO de propósito: quem decide a palavra e quem decide se o estado
 * pode andar mora aqui, longe do React e do zustand — a suíte
 * `scripts/test-gui-owner-bubble.mjs` prende as duas coisas sem montar tela.
 */

/** Espelho declarado de `owner-message-state` (o dono do union é o main:
 *  `src/main/guiSessions.ts`). Ordem = ordem do tempo. */
export type GuiOwnerDeliveryState = 'stopping' | 'delivered' | 'answered'

/** O que fica gravado no item `user` do fio (ver `GuiItem` em `store.ts`). */
export interface GuiOwnerDelivery {
  state: GuiOwnerDeliveryState
  at: number
}

/** `tone` é a FORMA da marca, não uma cor: o carimbo vive inteiro em ink. */
export interface GuiOwnerStamp {
  text: string
  tone: GuiOwnerDeliveryState
}

/** A escada do tempo. Um número por estado é o que faz o recibo nunca andar
 *  para trás quando o correio chega fora de ordem (uma carona atrasada não
 *  pode apagar um "respondida" que já está na tela). */
const RANK: Record<GuiOwnerDeliveryState, number> = {
  stopping: 1,
  delivered: 2,
  answered: 3
}

function isDeliveryState(value: unknown): value is GuiOwnerDeliveryState {
  return value === 'stopping' || value === 'delivered' || value === 'answered'
}

function clockText(at: number, now: number): string {
  const when = new Date(at)
  const hora = when.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const today = new Date(now)
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()
  if (sameDay) return hora
  // Fio de ontem reaberto: `entregue 21:33:46` sozinho contaria a hora de hoje
  // ao dono. A data entra curta, na frente, e o relógio continua o mesmo.
  const dia = when.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  return `${dia} ${hora}`
}

/**
 * A palavra do carimbo, ou `null` quando não há carimbo nenhum: mensagem de
 * motor velho — ou mandada sem turno aberto — deixa a bolha exatamente como
 * ela sempre foi. Estado fora do vocabulário também vira `null`: o main é o
 * dono da união, mas uma palavra inventada nunca chega à tela do dono.
 */
export function ownerDeliveryStamp(
  delivery: GuiOwnerDelivery | null | undefined,
  now: number
): GuiOwnerStamp | null {
  if (!delivery || !isDeliveryState(delivery.state)) return null
  if (delivery.state === 'stopping') return { text: 'parando o agente…', tone: 'stopping' }
  if (delivery.state === 'answered') return { text: 'respondida', tone: 'answered' }
  if (!Number.isFinite(delivery.at)) return null
  return { text: `entregue ${clockText(delivery.at, now)}`, tone: 'delivered' }
}

/** O nome acessível da bolha carrega o estado — o carimbo desenhado fica
 *  `aria-hidden` para o leitor de tela não ouvir a mesma frase duas vezes. */
export function ownerBubbleLabel(stamp: GuiOwnerStamp | null): string | null {
  return stamp ? `sua mensagem — ${stamp.text}` : null
}

/**
 * A régua do avanço: devolve a entrega NOVA, ou `null` quando o evento não
 * muda nada (repetido, atrasado ou fora do vocabulário). `null` é o sinal para
 * o fio sair com a MESMA referência — sem isso, um `delivered` de carona
 * repintaria a conversa inteira a cada resultado de tool.
 */
export function nextOwnerDelivery(
  current: GuiOwnerDelivery | null | undefined,
  state: GuiOwnerDeliveryState,
  at: number
): GuiOwnerDelivery | null {
  if (!isDeliveryState(state)) return null
  const previous = current && isDeliveryState(current.state) ? RANK[current.state] : 0
  if (RANK[state] <= previous) return null
  return { state, at }
}

/** Espelho ESTRUTURAL mínimo do item do fio (o dono do tipo é `store.ts`): só
 *  o que a régua precisa ler para achar a bolha certa. */
export interface GuiOwnerBubbleItem {
  id: string
  kind: string
  delivery?: GuiOwnerDelivery
}

/**
 * Grava o estado na bolha do `messageId` e devolve a lista. Id desconhecido
 * (evento de outra conversa, bolha já podada do anel) e evento que não avança
 * saem com a MESMA lista — referência estável é contrato do zustand aqui.
 */
export function applyGuiOwnerMessageState<T extends GuiOwnerBubbleItem>(
  items: T[],
  id: string,
  state: GuiOwnerDeliveryState,
  at: number
): T[] {
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'user' || item.id !== id) return item
    const delivery = nextOwnerDelivery(item.delivery, state, at)
    if (!delivery) return item
    changed = true
    // O spread de um genérico volta como interseção; o item continua sendo o
    // mesmo tipo do fio, só com a entrega preenchida.
    return { ...item, delivery } as T
  })
  return changed ? next : items
}

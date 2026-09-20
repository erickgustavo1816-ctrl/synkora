/**
 * O RECIBO DA FALA DO DONO (D6 do design de 2026-09-02; estendido pela R39.1
 * em 2026-09-02).
 *
 * Queixa do dono, verbatim: *"ele tá deixando na fila"*. Três mensagens dele
 * ficaram três minutos dentro de um pote enquanto o agente rodava tools
 * nativas, e a tela não contava nada disso — a bolha subia igualzinha à de uma
 * fala entregue na hora. Agora o main manda `owner-message-state` e a bolha
 * ganha, embaixo, um carimbo de recibo: o agente está sendo PARADO, a fala foi
 * ENTREGUE (com a hora) ou já foi RESPONDIDA.
 *
 * R39.1 (D1'/D2'/D4') — decisão do dono, verbatim: *"pode ser sem parar, puro.
 * Aí minha mensagem vai ficar lá. Só que eu quero que tenha alguma coisa, tipo
 * que ela não foi lida ainda… E se eu quiser eu posso forçar, aí forçando ele
 * para o turno e lê o que eu quero falar, quando for algo urgente."* Daí os
 * dois estados novos: `unread` (a fala já foi ao CLI e ESPERA a fronteira — o
 * ÚNICO estado com AÇÃO, o botão "ler agora") e `read` (o recibo de leitura:
 * o CLI absorveu a fala às hh:mm:ss).
 *
 * Módulo PURO de propósito: quem decide a palavra e quem decide se o estado
 * pode andar mora aqui, longe do React e do zustand — a suíte
 * `scripts/test-gui-owner-bubble.mjs` prende as duas coisas sem montar tela.
 */

/** Espelho declarado de `owner-message-state` (o dono do union é o main:
 *  `src/main/guiSessions.ts`). Ordem = ordem do tempo. */
export type GuiOwnerDeliveryState = 'unread' | 'stopping' | 'read' | 'delivered' | 'answered' | 'cancelled'

/** O que fica gravado no item `user` do fio (ver `GuiItem` em `store.ts`). */
export interface GuiOwnerDelivery {
  state: GuiOwnerDeliveryState
  at: number
}

/**
 * A AÇÃO do carimbo (R39.1, D4'). SÓ existe em `unread`: é o único momento em
 * que ainda há o que fazer — depois que o CLI leu, forçar não significa nada.
 * `hint` conta o CUSTO antes do clique (o medo do dono era exatamente esse: o
 * corte joga fora raciocínio e tool em voo).
 */
export interface GuiOwnerStampAction {
  label: string
  hint: string
}

/** `tone` é a FORMA da marca, não uma cor: o carimbo vive inteiro em ink. */
export interface GuiOwnerStamp {
  text: string
  tone: GuiOwnerDeliveryState
  /** Ausente em todo estado que não seja `unread` (ver `ownerDeliveryStamp`). */
  action?: GuiOwnerStampAction
}

/** A escada do tempo. Um número por estado é o que faz o recibo nunca andar
 *  para trás quando o correio chega fora de ordem (uma carona atrasada não
 *  pode apagar um "respondida" que já está na tela).
 *
 *  `read` e `delivered` dividem o degrau 3 de propósito: são a MESMA batida da
 *  história ("chegou nele"), por duas rotas diferentes — `read` é o recibo do
 *  steer (D2'), `delivered` é o pote entregue como turno novo (R39). Quem
 *  chegar primeiro fica; o segundo é no-op. */
const RANK: Record<GuiOwnerDeliveryState, number> = {
  cancelled: 5,
  unread: 1,
  stopping: 2,
  read: 3,
  delivered: 3,
  answered: 4
}

function isDeliveryState(value: unknown): value is GuiOwnerDeliveryState {
  return (
    value === 'cancelled' ||
    value === 'unread' ||
    value === 'stopping' ||
    value === 'read' ||
    value === 'delivered' ||
    value === 'answered'
  )
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

/** O botão do `unread`, na voz da casa: o rótulo NOMEIA a ação e a dica conta
 *  o preço dela antes do clique — nunca depois. */
const FORCE_ACTION: GuiOwnerStampAction = {
  label: 'ler agora',
  hint: 'força o agente a parar e ler esta mensagem agora — o que ele estava fazendo é cortado'
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
  // Cancelada = a bolha SAI do fio (`applyGuiOwnerMessageState` a remove; a
  // bolha ainda montada se esconde sozinha). Não há o que carimbar — ordem do
  // dono, 2026-09-16: "parecer que cancelou sem afetar nada".
  if (delivery.state === 'cancelled') return null
  // A fala já está no CLI e espera a fronteira: nada de relógio (não aconteceu
  // nada ainda para carimbar hora) e nada de pulso — ESPERAR NÃO É MOVIMENTO.
  // O que se mexe aqui é o dono, se ele quiser: o botão é a saída sancionada.
  if (delivery.state === 'unread') {
    return { text: 'não lida ainda', tone: 'unread', action: FORCE_ACTION }
  }
  if (delivery.state === 'stopping') return { text: 'parando o agente…', tone: 'stopping' }
  if (delivery.state === 'answered') return { text: 'respondida', tone: 'answered' }
  if (!Number.isFinite(delivery.at)) return null
  // Duas rotas, duas palavras: `read` é o RECIBO DE LEITURA (o CLI absorveu a
  // fala no meio do turno), `delivered` é o pote entregue como turno novo.
  const verbo = delivery.state === 'read' ? 'lida' : 'entregue'
  return { text: `${verbo} ${clockText(delivery.at, now)}`, tone: delivery.state }
}

/** O nome acessível da bolha carrega o estado — o carimbo desenhado fica
 *  `aria-hidden` para o leitor de tela não ouvir a mesma frase duas vezes. */
export function ownerBubbleLabel(stamp: GuiOwnerStamp | null): string | null {
  return stamp ? `sua mensagem — ${stamp.text}` : null
}

/** Quantos caracteres da fala cabem no nome do botão antes de virar ladainha
 *  no leitor de tela. */
const FORCE_LABEL_MAX = 42

/**
 * O nome acessível do BOTÃO. "ler agora" sozinho, repetido em três bolhas não
 * lidas, não diz QUAL fala vai furar a fila — então o nome cita a mensagem.
 * Fala vazia (só espaços) cai no rótulo puro: nome pela metade seria pior.
 */
export function ownerForceLabel(text: string): string {
  const inteiro = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!inteiro) return FORCE_ACTION.label
  const curto =
    inteiro.length > FORCE_LABEL_MAX
      ? `${inteiro.slice(0, FORCE_LABEL_MAX - 1).trimEnd()}…`
      : inteiro
  return `${FORCE_ACTION.label}: "${curto}"`
}

/**
 * A RECUSA do main na linha de aviso do pane (mesma voz do `interruptGuiPane`
 * do `store.ts`: "não deu para interromper o turno — …"). Beco sem paredes: o
 * texto do main vem inteiro, e quando ele não vem a frase ainda diz o que
 * aconteceu em vez de sumir.
 */
export function ownerForceRefusalText(error: string | null | undefined): string {
  const motivo = String(error ?? '').trim()
  return `não deu para forçar a leitura — ${motivo || 'a sessão não respondeu'}`
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
  if (current?.state === 'cancelled') return null
  if (state === 'cancelled' && current && current.state !== 'unread') return null
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
  const next = items.flatMap((item): T[] => {
    if (item.kind !== 'user' || item.id !== id) return [item]
    const delivery = nextOwnerDelivery(item.delivery, state, at)
    if (!delivery) return [item]
    changed = true
    // CANCELADA SOME (ordem do dono, 2026-09-16): a fala retirada não deixa
    // rastro no fio — nem carimbo, nem bolha. Só a `unread` chega aqui (a
    // régua acima recusa cancelar o que já foi lido).
    if (delivery.state === 'cancelled') return []
    // O spread de um genérico volta como interseção; o item continua sendo o
    // mesmo tipo do fio, só com a entrega preenchida.
    return [{ ...item, delivery } as T]
  })
  return changed ? next : items
}

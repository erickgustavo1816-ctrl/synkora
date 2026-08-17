/**
 * A BARRA DE ACEITE INLINE ("esta conversa está esperando você · aprovar ·
 * ajustar") e o detector que decide se ela aparece.
 *
 * O que ela faz quando o dono clica em "aprovar" é ENVIAR UMA MENSAGEM que ele
 * não escreveu ("aprovado — pode seguir."). Isso define a régua deste módulo:
 *
 *   PRECISÃO ANTES DE COBERTURA. Falso positivo custa um turno inteiro numa
 *   conversa de 1M de contexto e põe na boca do dono uma frase que não é dele;
 *   falso negativo custa ZERO — o composer está logo ali, e é por ele que o
 *   dono responde no resto do tempo.
 *
 * CASO REAL que reescreveu este arquivo (transcript do dono, pane de
 * planejamento do PAINEL DE GESTÃO, 2026-08-17): com o plano JÁ aprovado e já
 * virado aba no mapa, o agente fechou o turno com
 *
 *   "…o plano **"V1.0 completa…"** está aprovado no mapa, com os 13 briefs em
 *    `plano/`. Precisa de alguma coisa — ajustar alguma missão, repensar
 *    ordem, ou tirar dúvida sobre o plano?"
 *
 * e a barra apareceu. O dono: "não entendi o porquê dessa pergunta — não
 * deveria ter". Ele clicou em aprovar, a frase fabricada saiu, e o turno
 * seguinte foi o agente explicando que não executa missão nenhuma.
 *
 * O detector antigo procurava a marca em QUALQUER lugar dos últimos 320
 * caracteres. As duas falhas independentes que isso escondia — e que este
 * módulo fecha uma a uma:
 *
 *  1. MARCA FORA DA PERGUNTA. "aprovado" estava 148 caracteres antes do "?",
 *     numa frase que AFIRMA um fato do passado; a pergunta de verdade
 *     ("Precisa de alguma coisa…?") é um menu aberto, não um sim/não. A marca
 *     agora precisa morar na PRÓPRIA frase que termina em "?".
 *  2. FORMA DE AFIRMAÇÃO ACEITA COMO PEDIDO. O particípio ("aprovado") é como
 *     se DIZ que algo já foi aprovado — e numa conversa de planejamento, onde
 *     aprovação é o assunto o tempo todo, ele aparece toda hora. Pedido se diz
 *     "aprova?", "posso seguir?", "pode seguir?". O particípio saiu da lista.
 *
 * Medição no corpus real do dono (123 falas de assistente nos transcripts de
 * gui-sessions.json): o detector antigo disparou UMA vez, e essa vez foi este
 * falso positivo. Nenhum acerto foi perdido ao apertar a régua.
 */

/**
 * Marcas de PEDIDO DE ACEITE: o dev fecha o turno pedindo para seguir/parar.
 * Só primeira pessoa ("posso…", "sigo") ou pergunta direta ao dono ("pode
 * seguir?", "aprova?", "confirma?") — as formas em que alguém PEDE.
 *
 * `aprova(?:r|ção)?` cobre "aprova?", "quer aprovar?" e "mando para
 * aprovação?". O particípio "aprovado/aprovada" NÃO entra: é a forma de
 * AFIRMAR estado ("o plano está aprovado"), nunca a de pedir. Custo conhecido
 * e aceito: um "está aprovado?" literal deixa de acender a barra e é
 * respondido no composer.
 */
const ASK_RE =
  /\b(?:aprova(?:r|ção)?|posso (?:seguir|implementar|começar|continuar|ir)|pode (?:seguir|ir)|sigo|prossigo|confirma|de acordo|segue assim)\b|\bfecha(?:do)?\?/iu
// "fechado?" ficou FORA do grupo com `\b` no fim: a marca termina em "?", e um
// `\b` depois de caractere não-palavra nunca casa no fim do texto — no base
// 25ad293 ela estava morta (só casaria em "fechado?sim"). Aqui ela vive com
// `\b` só na entrada, e o próprio "?" fecha a marca.

/** Teto herdado do detector antigo: fala gigante sem pontuação nenhuma não vira
 *  varredura de regex sobre megabytes. */
const ASK_WINDOW = 320

/**
 * A FRASE FINAL, quando a fala termina em pergunta — o texto depois do último
 * fim de frase (`.`, `!`, `?` ou quebra de linha). É essa frase que o dono lê
 * como "a pergunta"; o que veio antes é contexto, e contexto não pede nada.
 *
 * Devolve `null` quando a fala não termina em "?": sem pergunta não há aceite
 * a dar. Exportado porque é a metade testável do detector.
 */
export function guiFinalQuestion(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.endsWith('?')) return null
  // O "?" do fim fica FORA da busca pelo fim de frase anterior (senão ele
  // mesmo seria o corte) e DENTRO do que se devolve: há marca que só existe
  // com o sinal ("fechado?"), e sem ele a frase deixaria de ser pergunta.
  const body = trimmed.slice(0, -1)
  let cut = -1
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const ch = body[i]
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      cut = i
      break
    }
  }
  return trimmed.slice(cut + 1).trim()
}

/** A fala fecha o turno PEDINDO um sim ao dono? */
export function guiAsksForGo(text: string): boolean {
  const question = guiFinalQuestion(text)
  if (question === null) return false
  return ASK_RE.test(question.slice(-ASK_WINDOW))
}

/** O mínimo do item do fio que a decisão enxerga (o `GuiItem` do store serve). */
export interface GuiGoScanItem {
  kind: string
  text?: string
  /** true enquanto ainda podem chegar deltas para ESTE item. */
  live?: boolean
  /** prefixo já revelado; menor que o texto = ainda digitando na tela. */
  animateFrom?: number
}

/** As travas de fora do fio: nada de aceite com trabalho em curso ou com outra
 *  decisão já na tela (permissão, pergunta, plano). */
export interface GuiGoGate {
  /** `status` do pane; só `idle` (turno fechado) admite a barra. */
  status: string
  /** Há pedido de permissão vivo? */
  perm?: boolean
  /** Há fala ainda chegando? */
  stream?: boolean
  /** Já existe card esperando decisão (pergunta/plano/proposta)? */
  awaitingCard?: boolean
}

/**
 * A barra deve aparecer? A varredura vai do fim para trás e para na primeira
 * fala: se a última voz do fio é do DONO, ele já respondeu — nada a aceitar.
 */
export function guiAwaitingGoDecision(
  items: readonly GuiGoScanItem[],
  gate: GuiGoGate
): boolean {
  if (gate.status !== 'idle' || gate.perm || gate.stream || gate.awaitingCard) return false
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind === 'user') return false
    if (item.kind === 'assistant') {
      const text = item.text ?? ''
      // Fala ainda sendo revelada não é fala fechada: o "?" pode ser de uma
      // frase que o próximo delta continua.
      if (item.live || (item.animateFrom ?? text.length) < text.length) return false
      return guiAsksForGo(text)
    }
  }
  return false
}

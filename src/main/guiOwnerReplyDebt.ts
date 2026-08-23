/**
 * A DÍVIDA DE RESPOSTA AO DONO (R32, 2026-08-23).
 *
 * O CASO REAL, com transcript: o dono perguntou "O que vc ta fazendo ai?" no
 * meio da espera de frota. A entrega funcionou INTEIRA — pote, wake e carona
 * no mesmo segundo (caixa-preta 15:54:16), o bloco com "FALE COM ELE JÁ,
 * antes de qualquer outra tool" dentro do resultado — e o modelo (fable 5
 * xhigh, JÁ com a persona R31 no contrato) leu, pensou e chamou
 * `helper_result` de novo. Duas vezes. Zero texto. Palavras do dono na
 * sequência: "independente do que tá fazendo... você me responde".
 *
 * A lição é a da sonda (probe-claude-owner-midturn, rodada haiku): ENTREGA
 * não é OBEDIÊNCIA — e depois de persona + ordem na carona ignoradas no mesmo
 * dia, pedir de novo seria a terceira versão do mesmo pedido. Este módulo é a
 * metade MECÂNICA: enquanto houver fala do dono entregue e não respondida,
 * as tools de delegação RECUSAM, e a recusa nomeia a receita (fale UMA linha
 * no chat) e re-cita a fala pendente. Falar destrava — a saída sancionada
 * existe e é a única.
 *
 * É GUARDA DURA DE PROPÓSITO, e dentro da régua da casa (memória
 * feedback-guardas-nao-capam-inteligencia): o que ela protege é AUTORIDADE —
 * o direito da fala do dono de ser ouvida — não um julgamento de qualidade.
 * O agente continua livre para decidir O QUE responder e o que fazer depois.
 *
 * As duas pontas recebem a MESMA instância por injeção (o padrão do
 * `guiOwnerMailbox`): a CARONA arma (`guiDelegationWiring.withOwnerMail`, o
 * único lugar onde a fala é entregue DENTRO de um turno de delegador) e o
 * PUMP de eventos quita (`guiSessions`: texto do assistente = resposta;
 * `result` = turno acabou e a cobrança mid-turn perdeu o sentido). Sem disco:
 * dívida de um turno morre com o turno.
 */

/** Teto da citação re-entregue na recusa. A fala original já viajou inteira
 *  na carona; aqui é lembrete, não segunda entrega. */
const QUOTE_MAX_CHARS = 600

export class GuiOwnerReplyDebt {
  private readonly panes = new Map<string, string[]>()

  /** A carona entregou estas falas: o pane passa a DEVER uma resposta. */
  arm(paneId: string, texts: readonly string[]): void {
    if (!paneId) return
    const meaningful = texts.map((text) => text.trim()).filter((text) => text.length > 0)
    if (meaningful.length === 0) return
    this.panes.set(paneId, [...(this.panes.get(paneId) ?? []), ...meaningful])
  }

  /** O agente falou (ou o turno acabou): dívida quitada. */
  clear(paneId: string): void {
    this.panes.delete(paneId)
  }

  /** As falas ainda sem resposta, na ordem — `null` = nada devido. */
  pending(paneId: string): readonly string[] | null {
    const texts = this.panes.get(paneId)
    return texts && texts.length > 0 ? texts : null
  }
}

/** A instância de PRODUÇÃO — uma por processo, compartilhada entre a carona
 *  (arma), o pump (quita) e as tools (cobram). Suítes injetam a própria. */
export const guiOwnerReplyDebt = new GuiOwnerReplyDebt()

function quoted(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > QUOTE_MAX_CHARS ? `${trimmed.slice(0, QUOTE_MAX_CHARS)}…` : trimmed
}

/**
 * A RECUSA QUE COBRA. Três coisas obrigatórias, na ordem que destravam: o
 * MOTIVO (o dono falou e não ouviu resposta), a RECEITA exata (uma ou duas
 * linhas de texto normal, fora de tool) e a FALA re-citada — o modelo que
 * perdeu o bloco da carona responde só com o que está aqui.
 */
export function guiOwnerReplyRefusal(texts: readonly string[]): string {
  const body =
    texts.length === 1
      ? `"${quoted(texts[0] ?? '')}"`
      : texts.map((text, index) => `${index + 1}. "${quoted(text)}"`).join('\n')
  return (
    'PARE: o DONO falou no meio deste turno e ainda não ouviu resposta. Esta tool só destrava ' +
    'depois que você falar com ele — escreva AGORA uma ou duas linhas de texto normal no chat ' +
    '(fora de qualquer tool) dizendo o que entendeu e o que muda, e então chame a tool de novo. ' +
    'O que ele disse:\n' +
    body
  )
}

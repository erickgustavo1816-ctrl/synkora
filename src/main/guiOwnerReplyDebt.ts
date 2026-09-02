/**
 * A DÍVIDA DE RESPOSTA AO DONO (R32, 2026-08-23; UNIVERSAL na R39, 2026-09-02).
 *
 * O CASO DA R32, com transcript: o dono perguntou "O que vc ta fazendo ai?" no
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
 * metade MECÂNICA: enquanto houver fala do dono entregue e não respondida, as
 * tools RECUSAM, e a recusa nomeia a receita (fale UMA linha no chat) e
 * re-cita a fala pendente. Falar destrava — a saída sancionada existe e é a
 * única.
 *
 * O QUE A R39 MUDOU, e por quê (medido em 01/09, missão 86a05c06): a guarda da
 * R32 morava só no nosso servidor MCP, e o modelo simplesmente TROCOU DE TOOL —
 * `helper_send`×3, `delegate`×2, `helpers_status`, SEIS recusas em fila antes
 * da primeira linha de texto, oito minutos. Pior: `Bash`, `Read`, `Edit` e
 * `AskUserQuestion` nunca passam pelo MCP, então num trecho de tools nativas a
 * guarda nem existia. Duas coisas nasceram daí:
 *   1. a BANDEIRA em disco (`<flagDir>/<paneId sanitizado>.txt`), que um hook
 *      `PreToolUse` do claude lê antes de CADA tool — o `guiOwnerDebtHook`
 *      guarda a forma exata, sondada no binário;
 *   2. o TEXTO da recusa, que passou a dizer que TODAS as tools estão
 *      bloqueadas e que tentar outra devolve a mesma recusa. O texto velho
 *      dizia "esta tool", e foi essa brecha que o modelo usou cinco vezes.
 *
 * É GUARDA DURA DE PROPÓSITO, e dentro da régua da casa (memória
 * feedback-guardas-nao-capam-inteligencia): o que ela protege é AUTORIDADE —
 * o direito da fala do dono de ser ouvida — não um julgamento de qualidade.
 * O agente continua livre para decidir O QUE responder e o que fazer depois.
 *
 * As duas pontas recebem a MESMA instância por injeção (o padrão do
 * `guiOwnerMailbox`): a CARONA e o FLUSH armam (`guiDelegationWiring`,
 * `guiSessions`) e o PUMP de eventos quita (texto do assistente = resposta;
 * `result` = turno acabou). A memória é a fonte da verdade; a bandeira é
 * CINTO — escrevê-la nunca pode derrubar nada, e por isso todo toque em disco
 * aqui é engolido.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { guiOwnerDebtFlagPath, guiOwnerDebtHookPayload } from './guiOwnerDebtHook'

/** Teto da citação re-entregue na recusa. A fala original já viajou inteira
 *  na carona; aqui é lembrete, não segunda entrega. */
const QUOTE_MAX_CHARS = 600

/**
 * O disco por trás da bandeira, injetável porque as suítes são puras (nada
 * aqui pode exigir um sistema de arquivos de verdade para ser testado).
 * `list` é opcional: sem ele a varredura de boot vira no-op, que é o degrade
 * certo — bandeira órfã recusa até o pane falar, nunca trava para sempre.
 */
export interface GuiOwnerDebtFs {
  write(path: string, text: string): void
  remove(path: string): void
  list?(dir: string): readonly string[]
}

/** O fs de PRODUÇÃO. Cria a pasta na hora de escrever (a bandeira pode ser a
 *  primeira coisa que existe ali) e engole tudo — quem chama já protege. */
const nodeDebtFs: GuiOwnerDebtFs = {
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text, 'utf8')
  },
  remove(path) {
    rmSync(path, { force: true })
  },
  list(dir) {
    return readdirSync(dir)
  }
}

export interface GuiOwnerReplyDebtDeps {
  /** Onde as bandeiras moram. Em produção,
   *  `join(app.getPath('userData'), 'owner-debt')`, carimbado no boot por
   *  `setFlagDir`. Sem ele a dívida existe só em memória (o comportamento da
   *  R32) — a guarda do MCP continua de pé, o hook do claude é que não arma. */
  flagDir?: string
  fs?: GuiOwnerDebtFs
}

export class GuiOwnerReplyDebt {
  private readonly panes = new Map<string, string[]>()
  private readonly fs: GuiOwnerDebtFs
  private flagDir: string | undefined

  constructor(deps?: GuiOwnerReplyDebtDeps) {
    this.flagDir = deps?.flagDir
    this.fs = deps?.fs ?? nodeDebtFs
  }

  /** O boot conhece o userData; o módulo, não. Uma linha no `index.ts`. */
  setFlagDir(flagDir: string): void {
    this.flagDir = flagDir
  }

  /** A entrega (carona ou flush) passou estas falas: o pane passa a DEVER uma
   *  resposta — e, com `flagDir` configurado, TODA tool do claude trava junto. */
  arm(paneId: string, texts: readonly string[]): void {
    if (!paneId) return
    const meaningful = texts.map((text) => text.trim()).filter((text) => text.length > 0)
    if (meaningful.length === 0) return
    this.panes.set(paneId, [...(this.panes.get(paneId) ?? []), ...meaningful])
    this.writeFlag(paneId)
  }

  /** O agente falou (ou o turno acabou): dívida quitada, bandeira apagada. */
  clear(paneId: string): void {
    this.panes.delete(paneId)
    this.removeFlag(paneId)
  }

  /**
   * O caminho da bandeira deste pane, ou `undefined` enquanto o boot não
   * carimbou o `flagDir`. É a COSTURA do spawn: o `guiSessions` monta o
   * `--settings` do hook a partir daqui sem precisar conhecer o `userData`, e
   * o `undefined` faz o pane nascer exatamente como nascia antes da R39.
   */
  flagPathFor(paneId: string): string | undefined {
    if (!this.flagDir || !paneId) return undefined
    return guiOwnerDebtFlagPath(this.flagDir, paneId)
  }

  /** As falas ainda sem resposta, na ordem — `null` = nada devido. */
  pending(paneId: string): readonly string[] | null {
    const texts = this.panes.get(paneId)
    return texts && texts.length > 0 ? texts : null
  }

  /** A bandeira sempre reflete o POTE INTEIRO: a segunda fala re-escreve o
   *  arquivo com as duas, senão a recusa citaria só metade do que ele disse. */
  private writeFlag(paneId: string): void {
    const texts = this.panes.get(paneId)
    if (!this.flagDir || !texts || texts.length === 0) return
    try {
      this.fs.write(
        guiOwnerDebtFlagPath(this.flagDir, paneId),
        guiOwnerDebtHookPayload(guiOwnerReplyRefusal(texts))
      )
    } catch {
      // Bandeira é CINTO, não pré-requisito: disco cheio ou pasta sem
      // permissão não pode derrubar a dívida em memória nem o turno do dono.
    }
  }

  private removeFlag(paneId: string): void {
    if (!this.flagDir) return
    try {
      this.fs.remove(guiOwnerDebtFlagPath(this.flagDir, paneId))
    } catch {
      // idem: apagar é idempotente e nunca é motivo de crash.
    }
  }
}

/**
 * A VARREDURA DE BOOT. Dívida de um turno morre com o turno (R32) — mas a
 * bandeira mora em DISCO, e um app derrubado no meio de uma dívida deixaria o
 * arquivo lá para travar a primeira tool do pane seguinte. O boot limpa a
 * pasta inteira: nenhuma bandeira sobrevive ao processo que a escreveu.
 * Devolve quantas apagou (a caixa-preta gosta de número).
 */
export function sweepFlags(flagDir: string, fs: GuiOwnerDebtFs = nodeDebtFs): number {
  if (!flagDir || !fs.list) return 0
  let removed = 0
  try {
    for (const name of fs.list(flagDir)) {
      if (!name.endsWith('.txt')) continue
      try {
        fs.remove(join(flagDir, name))
        removed += 1
      } catch {
        // uma bandeira presa não pode impedir a limpeza das outras.
      }
    }
  } catch {
    // pasta que ainda não existe é o caso NORMAL do primeiro boot.
  }
  return removed
}

/** A instância de PRODUÇÃO — uma por processo, compartilhada entre a carona e
 *  o flush (armam), o pump (quita) e as tools (cobram). Suítes injetam a
 *  própria; o `index.ts` carimba o `flagDir` no boot. */
export const guiOwnerReplyDebt = new GuiOwnerReplyDebt()

function quoted(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > QUOTE_MAX_CHARS ? `${trimmed.slice(0, QUOTE_MAX_CHARS)}…` : trimmed
}

/**
 * A RECUSA QUE COBRA. Quatro coisas obrigatórias, na ordem que destravam: o
 * MOTIVO (o dono falou e não ouviu resposta), o ALCANCE (TODAS as tools —
 * nativas e do Synkora — e trocar de tool dá na mesma), a RECEITA exata (uma
 * ou duas linhas de texto normal, fora de tool) e a FALA re-citada.
 *
 * O alcance é a emenda da R39 e não é retórica: o texto velho dizia "Esta tool
 * só destrava…", e em 01/09 o modelo leu isso como convite e tentou outras
 * CINCO. O mesmo texto vai pelos dois canais — a recusa do MCP e o motivo do
 * hook `PreToolUse` do claude —, então ele precisa se explicar sozinho.
 *
 * Ele CITA a fala do dono e pede resposta; não manda ecoar palavra nenhuma.
 * A sonda de 02/09 mostrou por quê: com um texto em forma de ordem plantada, o
 * modelo levantou bandeira de PROMPT INJECTION contra a própria casa.
 */
export function guiOwnerReplyRefusal(texts: readonly string[]): string {
  const body =
    texts.length === 1
      ? `"${quoted(texts[0] ?? '')}"`
      : texts.map((text, index) => `${index + 1}. "${quoted(text)}"`).join('\n')
  return (
    'PARE: o DONO falou no meio deste turno e ainda não ouviu resposta. TODAS as suas tools ' +
    '— as NATIVAS (Bash, Read, Edit, AskUserQuestion…) e as do Synkora — estão bloqueadas até ' +
    'você responder, e pedir outra tool devolve exatamente esta mesma recusa. A saída é uma só: ' +
    'escreva AGORA, como TEXTO no chat (fora de qualquer tool), uma ou duas linhas dizendo o que ' +
    'entendeu e o que muda; feito isso tudo destrava e você retoma de onde parou. O que ele disse:\n' +
    body
  )
}

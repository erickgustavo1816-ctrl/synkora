/**
 * CARDS SINTETIZADOS DOS AJUDANTES SEM ABA (D3 do design vinculante
 * `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
 *
 * O ajudante MCP trabalha numa SESSÃO À PARTE: o stream do CLI do delegador só
 * mostra a chamada `delegate`, que é o ENVELOPE do lote. Para a lateral falar um
 * idioma só, o harness sintetiza um tool-item POR AJUDANTE no anel do delegador
 * — um lote de cinco nunca vira um card só. O contrato está fixado em
 * `src/renderer/src/guiSubagentSidebar.ts` (bloco `CARD SINTETIZADO DE AJUDANTE
 * MCP`) e é ele que este módulo emite, verbatim:
 *
 *   name             `helper:<helperId>`
 *   toolUseId        `helper:<helperId>` — os cards de ATIVIDADE do ajudante o
 *                    usam como `parentToolUseId`
 *   parentToolUseId  o `toolUseId` da chamada `delegate` (o envelope do lote)
 *   input            { helperId, name?, model, effort?, seat?, cli, prompt }
 *   recibo           result { agentStatus: 'launched' }  ← segura o card
 *   terminal         result { agentStatus: 'settled', outcome }
 *
 * ————— A COSTURA DE CORRELAÇÃO (a decisão desta onda) —————
 *
 * O servidor MCP NUNCA vê o `toolUseId` da chamada: ele recebe um bearer token
 * de pane e um payload, e o id do tool_use mora no stream do CLI. Os dois lados
 * se encontram AQUI, por FIFO por pane:
 *
 *  1. o card `delegate` chega ao anel ANTES da chamada MCP (o claude publica a
 *     mensagem `assistant` inteira e só então executa a tool; o codex abre
 *     `item/started` do `mcpToolCall` antes de despachar) — `observe` empilha
 *     esse `toolUseId` na fila de envelopes NÃO RECLAMADOS do pane;
 *  2. o handler da tool `delegate` chama `begin(paneId)` ANTES de `engine.spawn`
 *     e leva o envelope MAIS ANTIGO da fila.
 *
 * FALHA CONHECIDA (documentada, não mascarada): duas chamadas `delegate`
 * CONCORRENTES no mesmo turno cujos handlers rodem fora da ordem em que os
 * tool_use foram publicados trocam os envelopes entre si. O estrago é
 * COSMÉTICO — os N cards de ajudante continuam corretos (modelo, effort, conta,
 * atividade e desfecho saem do motor, não do envelope); só o agrupamento sob a
 * chamada-pai fica invertido, e as duas chamadas são do mesmo pane. Não há como
 * fazer melhor sem o CLI publicar o `toolUseId` para dentro da tool.
 *
 * SEM ENVELOPE: se a fila estiver vazia (ordem invertida, nome de tool que não
 * reconhecemos, chamada perdida), o lote recebe um envelope SINTÉTICO — um id
 * que nunca existe como card. A lateral continua correta: os ajudantes são
 * promovidos por conta própria (`helperId` no input) e o envelope inexistente
 * simplesmente não casa com card nenhum.
 */
import type { SessionEvent } from './maestroSession'
// A régua do "fim da linha" é do MOTOR, e vem dele: duplicar a lista de estados
// terminais aqui seria a segunda cópia de uma decisão que já tem dono.
import { isGuiHelperTerminal } from './guiHelperSessions'
import type { GuiHelperChange, GuiHelperRecord } from './guiHelperSessions'

/** Marcador do card sintetizado — o renderer promove o card por ele. */
export const GUI_HELPER_CARD_PREFIX = 'helper:'

/**
 * O DESFECHO DO CARD DE UM AJUDANTE PARADO (contrato R6-B × R6-C).
 *
 * A lateral decide o tom do card por `result.status`, e já conhece 'cancelled'
 * (terminal sem conclusão). 'interrupted' é o irmão novo: parou, guardou e
 * VOLTA — o único desfecho em que o dono ainda tem uma escolha na mão. Ele mora
 * numa constante para os dois lados do contrato falarem do mesmo literal.
 */
export const GUI_HELPER_INTERRUPTED_OUTCOME = 'interrupted' as const

/** O mínimo de um ajudante PARADO para o aviso de boot (o `GuiHelperSnapshot`
 *  do motor cabe aqui inteiro, e o registro também). */
export interface GuiHelperInterruptedInput {
  helperId: string
  name?: string
  model: string
  resultPath?: string
  /** Quanto ele trabalhou antes de parar — congelado no encerramento. */
  elapsedMs?: number
}

/** Trecho do briefing que viaja no card. A ficha da lateral corta em 240; mais
 *  que isso é peso morto no anel (que tem teto de bytes). */
export const GUI_HELPER_CARD_PROMPT_CHARS = 240

/** Trecho da ENTREGA que fecha o card. O texto inteiro (até 64KB) sai pelo
 *  `helper_result`; o anel guarda o suficiente para o dono entender o desfecho
 *  sem abrir nada. */
export const GUI_HELPER_CARD_RESULT_CHARS = 2_000

/**
 * Throttle e teto dos cards de ATIVIDADE, e eles existem para proteger o ANEL:
 * o motor já limita o anúncio a um a cada 2s, mas meia hora de ajudante nesse
 * ritmo são ~900 cards — o anel tem 500 itens e a conversa inteira do dono seria
 * despejada por barulho de fundo. A fotografia viva é o `helpers_status`; o anel
 * fica com uma amostra honesta.
 */
export const GUI_HELPER_CARD_ACTIVITY_MS = 15_000
export const GUI_HELPER_CARD_ACTIVITY_MAX = 16

/** Envelopes vistos e ainda não reclamados por um lote. Fila curta de propósito:
 *  chamada `delegate` que nunca virou lote é lixo, não memória. */
export const GUI_HELPER_PENDING_ENVELOPE_CAP = 8

/**
 * DESPERTADOR — a janela de coalescência.
 *
 * Uma frota que encerra junto (o caso comum: cinco ajudantes soltos no mesmo
 * turno) tem de virar UMA mensagem, não cinco. O primeiro encerramento abre a
 * janela e quem cair dentro dela entra no mesmo aviso; re-armar a cada
 * encerramento seria pior — uma frota escalonada empurraria o aviso para
 * sempre, que é exatamente o silêncio que este módulo veio matar.
 */
export const GUI_HELPER_WAKE_COALESCE_MS = 3_000

/** Teto de LINHAS do aviso. Trinta ajudantes numa mensagem só é despejo de
 *  contexto; o resto se lê no `helpers_status`, que existe para isso. */
export const GUI_HELPER_WAKE_LIST_MAX = 20

/** Nomes NATIVOS de delegação — a MESMA âncora do renderer. */
const NATIVE_DELEGATION_RE = /^(task|agent|delegate|subagent|spawn(?:_?agent)?)$/iu
/** `mcp__<servidor>__<tool>`: a forma que o claude publica (sonda probe-claude-fence §3). */
const CLAUDE_MCP_TOOL_RE = /^mcp__[\w-]+?__(.+)$/u
/** `<servidor>/<tool>` e variantes — o codex hoje entrega o nome CRU, mas
 *  qualifica por servidor em outras superfícies. */
const SERVER_QUALIFIED_TOOL_RE = /^[\w-]+(?:__|[/.])(.+)$/u

/** `helper:<helperId>` — nome e toolUseId do card sintetizado são o MESMO id. */
export function guiHelperCardId(helperId: string): string {
  return `${GUI_HELPER_CARD_PREFIX}${helperId}`
}

/**
 * O card da SEGUNDA VIDA (R6.2), quando o delegador retoma um interrompido.
 *
 * Ele NÃO pode reusar o id do primeiro, e a razão é mecânica: no renderer, dois
 * cards com o mesmo `toolUseId` fazem `guiToolResultTargetIndex` desistir de
 * ambos ("sem unicidade, nenhum card recebe o resultado") — o ajudante retomado
 * entregaria no vazio e o card ficaria aberto para sempre. E reaproveitar o card
 * FECHADO também não serve: um card com desfecho não aceita outro resultado.
 *
 * O prefixo continua sendo `helper:`, então a limpeza de órfãos do boot e a
 * promoção da lateral (que lê o `helperId` do input) seguem valendo iguais.
 */
export function guiHelperResumeCardId(helperId: string, life: number): string {
  return `${guiHelperCardId(helperId)}#vida${life}`
}

export function isGuiHelperCardId(value: string): boolean {
  return value.startsWith(GUI_HELPER_CARD_PREFIX)
}

/**
 * A chamada `delegate` como ela chega ao anel: nativa (`delegate`), claude MCP
 * (`mcp__synkora__delegate`) ou qualificada por servidor. As IRMÃS do catálogo
 * (`helpers_status`, `helper_result`, `helper_send`, `list_seats`) NÃO casam —
 * o sufixo é testado contra a mesma âncora fechada do renderer.
 */
export function isGuiDelegateToolName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (NATIVE_DELEGATION_RE.test(trimmed)) return true
  for (const pattern of [CLAUDE_MCP_TOOL_RE, SERVER_QUALIFIED_TOOL_RE]) {
    const tail = pattern.exec(trimmed)?.[1]
    if (tail && NATIVE_DELEGATION_RE.test(tail)) return true
  }
  return false
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** O input do card, na forma que `guiSubagentMetadataForTool` sabe ler. */
export function guiHelperCardInput(record: GuiHelperRecord): Record<string, unknown> {
  return {
    helperId: record.helperId,
    ...(record.name ? { name: record.name } : {}),
    model: record.model,
    ...(record.effort ? { effort: record.effort } : {}),
    seat: record.seatName ?? record.seatId,
    cli: record.cli,
    prompt: clip(record.prompt, GUI_HELPER_CARD_PROMPT_CHARS)
  }
}

/** Recibo curto do card — o que o dono lê antes de o ajudante entregar. */
export function guiHelperLaunchReceipt(record: GuiHelperRecord): string {
  const parts = [record.model]
  if (record.effort) parts.push(record.effort)
  parts.push(record.seatName ?? record.seatId)
  return `ajudante aberto · ${parts.join(' · ')}`
}

/**
 * Nascimento do card: o tool-item E o recibo `launched` na mesma passada.
 *
 * O recibo não é enfeite. Ele é o que dá ao ajudante, DE GRAÇA, todo o ciclo de
 * vida já provado do Agent nativo do claude no renderer: `capGuiItems` nunca
 * evicta um card `launched` vivo, `closePendingGuiTools` o cancela quando a
 * sessão morre e `settleLaunchedGuiSubagents` o assenta no respawn — que é
 * literalmente o "ajudante não sobrevive a restart" do D1, sem código novo.
 */
export function guiHelperSpawnedEvents(
  record: GuiHelperRecord,
  envelopeToolUseId: string,
  /** Card desta VIDA. Ausente = o primeiro (`helper:<id>`); presente = a
   *  retomada, que precisa de id próprio (ver `guiHelperResumeCardId`). */
  cardId?: string
): SessionEvent[] {
  const toolUseId = cardId ?? guiHelperCardId(record.helperId)
  return [
    {
      type: 'tool',
      name: toolUseId,
      input: guiHelperCardInput(record),
      toolUseId,
      parentToolUseId: envelopeToolUseId
    },
    {
      type: 'tool-result',
      toolUseId,
      text: guiHelperLaunchReceipt(record),
      isError: false,
      agentStatus: 'launched'
    }
  ]
}

/**
 * Atividade do ajudante: card FILHO que fica ABERTO — é o último card sem
 * resultado que a lateral lê como "o que ele está fazendo agora".
 *
 * O nome é fixo e o resumo viaja em `description`: um card cujo INPUT tivesse
 * `helperId` (ou cujo nome começasse por `helper:`) seria PROMOVIDO pelo
 * renderer e ganharia ficha própria — a atividade do ajudante viraria um
 * ajudante fantasma na lateral.
 */
export function guiHelperActivityEvent(
  record: GuiHelperRecord,
  index: number,
  cardId?: string
): SessionEvent | null {
  const summary = record.lastActivity?.summary
  if (!summary) return null
  const parent = cardId ?? guiHelperCardId(record.helperId)
  return {
    type: 'tool',
    name: 'atividade',
    input: { description: clip(summary, GUI_HELPER_CARD_PROMPT_CHARS) },
    toolUseId: `${parent}#${index}`,
    parentToolUseId: parent
  }
}

/**
 * Desfecho FACTUAL do ajudante — fecha o card e, no renderer, a árvore dele.
 *
 * O CAMINHO DA ENTREGA abre o texto: o dono lê o card na lateral e já sabe qual
 * arquivo abrir, sem passar pelo agente. O corte continua existindo porque o
 * anel tem teto de bytes — só que agora ele aponta para o arquivo, que é onde a
 * entrega inteira está, e não para uma tool que só o agente pode chamar.
 */
export function guiHelperSettledEvent(record: GuiHelperRecord, cardId?: string): SessionEvent {
  const failed = record.state === 'failed'
  const cancelled = record.state === 'cancelled'
  const interrupted = record.state === 'interrupted'
  const body = failed || cancelled || interrupted ? (record.failure ?? '') : (record.result ?? '')
  const truncated = body.length > GUI_HELPER_CARD_RESULT_CHARS
  const shown = truncated
    ? `${body.slice(0, GUI_HELPER_CARD_RESULT_CHARS)}…\n[synkora] o texto inteiro está ${record.resultPath ? `em ${record.resultPath}` : 'no helper_result'}`
    : body
  return {
    type: 'tool-result',
    toolUseId: cardId ?? guiHelperCardId(record.helperId),
    text: record.resultPath ? `entrega: ${record.resultPath}\n\n${shown}` : shown,
    isError: failed,
    // O DESFECHO `interrupted` É CONTRATO (R6.1×R6-C): a lateral já lê
    // `result.status === 'cancelled'` e ganha aqui o irmão novo. Fechar um
    // interrompido como 'completed' — o que a onda A fazia — diria ao dono que o
    // trabalho terminou bem, e é justamente o card em que ele precisa decidir
    // entre retomar e descartar. Interromper também NÃO é falhar: `isError`
    // continua falso.
    outcome: interrupted
      ? GUI_HELPER_INTERRUPTED_OUTCOME
      : failed
        ? 'failed'
        : cancelled
          ? 'cancelled'
          : 'completed',
    agentStatus: 'settled',
    truncated
  }
}

/** Terminal do ENVELOPE: só quando o lote inteiro encerrou. */
export function guiHelperEnvelopeSettledEvent(
  envelopeToolUseId: string,
  total: number
): SessionEvent {
  return {
    type: 'tool-result',
    toolUseId: envelopeToolUseId,
    text: total === 1 ? 'o ajudante encerrou' : `os ${total} ajudantes encerraram`,
    isError: false,
    outcome: 'completed',
    agentStatus: 'settled'
  }
}

// ————— o despertador (a mensagem) —————

/** Um ajudante que ENCERROU e o delegador ainda não sabe. Cancelado nunca chega
 *  aqui: ninguém está esperando um trabalho que o próprio app (ou o agente)
 *  mandou parar. */
export interface GuiHelperWakeEntry {
  helperId: string
  name?: string
  model: string
  /** `true` = entregou (`done`); `false` = falhou. Não se lê com `interrupted`:
   *  um ajudante parado não terminou de jeito nenhum. */
  ok: boolean
  /** O ARQUIVO da entrega (relativo ao worktree). É o endereço que o delegador
   *  abre — o texto inteiro nunca viaja no aviso. */
  resultPath?: string
  /**
   * PAROU, não terminou (R6.1). É o aviso do BOOT: a conversa reabriu e há
   * trabalho preservado esperando uma decisão — retomar ou descartar. Ele viaja
   * pelo MESMO pote dos encerramentos porque o leitor é o mesmo e o custo de um
   * segundo canal seria dois lugares para a mesma novidade se perder.
   */
  interrupted?: boolean
  /** Quanto ele trabalhou ANTES de parar (congelado). Só faz sentido com
   *  `interrupted`: é o que diz ao dono se vale a pena retomar. */
  elapsedMs?: number
}

/** O aviso pronto para ser entregue na conversa do delegador. */
export interface GuiHelperWake {
  /** Ids na ORDEM em que encerraram — a mesma ordem das linhas do texto. */
  helperIds: string[]
  done: number
  failed: number
  /** Ajudantes deste chat que continuam trabalhando (0 = a frota acabou). */
  stillWorking: number
  text: string
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Quanto tempo ele trabalhou antes de parar, na régua do dono (segundos até um
 *  minuto e meio; minutos depois disso). */
function workedFor(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const seconds = Math.round(ms / 1000)
  return seconds < 90 ? ` depois de ${seconds}s` : ` depois de ${Math.round(seconds / 60)}min`
}

/** O placar honesto: parado NÃO é falha, e chamar de falha faria o agente
 *  reabrir o trabalho do zero em vez de retomá-lo. */
function tally(entries: readonly GuiHelperWakeEntry[]): {
  done: number
  failed: number
  interrupted: number
} {
  let done = 0
  let failed = 0
  let interrupted = 0
  for (const entry of entries) {
    if (entry.interrupted) interrupted += 1
    else if (entry.ok) done += 1
    else failed += 1
  }
  return { done, failed, interrupted }
}

/** A linha de UM ajudante — a MESMA nos dois caminhos de entrega (despertador e
 *  correio), porque é o mesmo fato contado ao mesmo leitor. */
function settledLine(entry: GuiHelperWakeEntry): string {
  const label = entry.name ? `${entry.name} · ` : ''
  const file = entry.resultPath ? ` · ${entry.resultPath}` : ''
  const state = entry.interrupted
    ? `interrompido${workedFor(entry.elapsedMs)}`
    : entry.ok
      ? 'concluído'
      : 'falhou'
  return `· ${label}${entry.model} · ${state} · id ${entry.helperId}${file}`
}

/** A receita dos DOIS verbos, escrita UMA vez: repeti-la por ajudante seria
 *  contexto pago em toda linha de uma frota de vinte. */
const RESUME_OR_DISCARD =
  'Retome com helper_resume (ele volta de onde parou, na mesma conversa) ou descarte com ' +
  'helper_cancel. Se não estiver claro o que o dono quer, PERGUNTE a ele antes.'

// ————— o correio (o pote ÚNICO dos dois caminhos de entrega) —————

/** A marca do bloco que pega carona nos resultados de tool. O agente e o dono
 *  leem a mesma linha e sabem de cara que quem falou foi o app. */
export const GUI_HELPER_INBOX_TAG = '[synkora] ajudantes:'

/**
 * O CORREIO DOS AJUDANTES — onde um encerramento espera até alguém entregá-lo.
 *
 * O BUG REAL (5º teste do dono, 18/08): dois ajudantes encerraram enquanto o
 * delegador estava DENTRO do turno, esperando um terceiro no long-poll. O
 * despertador segurou o aviso — e segurar está certo, nunca se interrompe um
 * turno vivo —, mas o agente, cego lá dentro, disse ao dono "nenhum terminou"
 * com a lateral mostrando três rodando. Ordem dele: "cada ajudante que terminar,
 * avisar o orquestrador que terminou e entregar via MCP, pra não poluir o chat".
 *
 * Daí DOIS caminhos de entrega para o MESMO fato: o despertador (conversa
 * ociosa, mensagem visível no fio) e a CARONA no resultado da próxima tool
 * (dentro do turno, sem interromper nada). Este pote é o que os mantém
 * coerentes: quem entrega primeiro CONSOME, então o dono nunca lê a mesma
 * novidade duas vezes nem fica sem ela. É o padrão do correio F6
 * (CLAUDE.md F6.10: "[synkora inbox]" nos resultados de tool), agora com o
 * escopo estreito da delegação.
 *
 * Ele é uma INSTÂNCIA, e a de produção é o `guiHelperInbox` abaixo: o
 * correlacionador (que posta) e as tools do MCP (que colhem) moram em módulos
 * diferentes e nunca se enxergam — pedir ao `index.ts` uma segunda costura para
 * ligar os dois seria repetir uma fiação que ele já fez uma vez (a mesma
 * disciplina do `engineJournals` no guiDelegationWiring). Os dois lados aceitam
 * a instância por injeção, que é como a suíte fica hermética.
 */
export class GuiHelperInbox {
  private readonly panes = new Map<string, GuiHelperWakeEntry[]>()

  /** `false` = este ajudante já estava no pote (o motor repetiu o `settled`). */
  post(paneId: string, entry: GuiHelperWakeEntry): boolean {
    const pending = this.panes.get(paneId) ?? []
    if (pending.some((known) => known.helperId === entry.helperId)) return false
    pending.push(entry)
    this.panes.set(paneId, pending)
    return true
  }

  count(paneId: string): number {
    return this.panes.get(paneId)?.length ?? 0
  }

  has(paneId: string): boolean {
    return this.count(paneId) > 0
  }

  /**
   * Tira TODAS as pendências do pane. `except` sai do RETORNO mas some do pote
   * do mesmo jeito: quem lê a entrega de um ajudante já ficou sabendo dele — o
   * eco só gastaria contexto e faria o agente achar que houve um segundo fim.
   */
  drain(paneId: string, except?: string): GuiHelperWakeEntry[] {
    const pending = this.panes.get(paneId)
    if (!pending || pending.length === 0) return []
    this.panes.delete(paneId)
    return except ? pending.filter((entry) => entry.helperId !== except) : pending
  }

  /** Devolve à FRENTE (recusa transitória da entrega): a ordem de encerramento
   *  é a ordem em que o delegador vai colher, e ela não pode se embaralhar. */
  restore(paneId: string, entries: readonly GuiHelperWakeEntry[]): void {
    if (entries.length === 0) return
    this.panes.set(paneId, [...entries, ...(this.panes.get(paneId) ?? [])])
  }

  /** Conversa desmontada: novidade sem ninguém para ler é lixo, não memória. */
  forget(paneId: string): void {
    this.panes.delete(paneId)
  }
}

/** O correio de PRODUÇÃO — um por processo, chaveado por paneId (que é único
 *  no app inteiro). Testes injetam o próprio; o app usa este dos dois lados. */
export const guiHelperInbox = new GuiHelperInbox()

/**
 * O BLOCO QUE PEGA CARONA num resultado de tool. Curto por obrigação: ele viaja
 * em TODA tool do catálogo de delegação, então cada linha é contexto que o
 * delegador paga em toda chamada. Diz o mínimo acionável — quem encerrou, como
 * encerrou, o ARQUIVO da entrega — e nunca o texto dela.
 */
export function guiHelperInboxBlock(
  entries: readonly GuiHelperWakeEntry[],
  options: { stillWorking?: number } = {}
): string {
  if (entries.length === 0) return ''
  const { done, failed, interrupted } = tally(entries)
  const placar = [
    done > 0 ? plural(done, 'concluído', 'concluídos') : '',
    failed > 0 ? plural(failed, 'falhou', 'falharam') : '',
    interrupted > 0 ? plural(interrupted, 'interrompido', 'interrompidos') : ''
  ].filter(Boolean)
  const head =
    entries.length === 1
      ? `${GUI_HELPER_INBOX_TAG} 1 novidade enquanto você trabalhava (${placar.join(', ')}).`
      : `${GUI_HELPER_INBOX_TAG} ${entries.length} novidades enquanto você trabalhava ` +
        `(${placar.join(', ')}).`
  const shown = entries.slice(0, GUI_HELPER_WAKE_LIST_MAX)
  const lines = shown.map(settledLine)
  if (entries.length > shown.length) {
    lines.push(`· … e mais ${entries.length - shown.length} (a lista inteira está no helpers_status)`)
  }
  const tail: string[] = []
  if (done + failed > 0) {
    tail.push(
      entries.some((entry) => entry.resultPath && !entry.interrupted)
        ? `A entrega ${done + failed === 1 ? 'inteira está' : 'de cada um está'} no ARQUIVO citado — abra o arquivo (o helper_result devolve o mesmo caminho).`
        : 'Colha cada um com helper_result.'
    )
  }
  if (interrupted > 0) tail.push(RESUME_OR_DISCARD)
  const working = Math.max(0, Math.trunc(options.stillWorking ?? 0))
  if (working > 0) tail.push(`Ainda trabalhando: ${working}.`)
  return [head, ...lines, tail.join(' ')].join('\n')
}

/**
 * O TEXTO QUE O HARNESS FALA NA CONVERSA quando a frota encerra e o agente já
 * encerrou o turno (o bug real de 18/08: cinco ajudantes entregaram e o chat
 * ficou mudo para sempre, porque ninguém tinha como saber).
 *
 * Curto de propósito, e com TRÊS coisas obrigatórias: quem encerrou (apelido +
 * modelo, o mesmo vocabulário da lateral), o placar honesto (falha também se
 * conta ao dono) e o MOVIMENTO — `helper_result` com os ids na mão. O prefixo
 * `[synkora]` é o mesmo da receita de conflito: o dono lê o fio e sabe de cara
 * que quem falou foi o app, não ele.
 */
export function guiHelperWakeMessage(
  entries: readonly GuiHelperWakeEntry[],
  stillWorking = 0
): string {
  const { done, failed, interrupted } = tally(entries)
  const settled = done + failed
  // O AVISO DE BOOT (R6.1) é só de interrompidos, e ele não fala de
  // encerramento nenhum: o que aconteceu com esses ajudantes foi uma PARADA, e
  // dizer "encerraram" faria o agente abrir tudo de novo do zero.
  const head =
    settled === 0
      ? interrupted === 1
        ? '[synkora] um ajudante deste chat ficou INTERROMPIDO: o processo dele parou e a conversa ficou guardada.'
        : `[synkora] ${interrupted} ajudantes deste chat ficaram INTERROMPIDOS: os processos pararam e as conversas ficaram guardadas.`
      : entries.length === 1
        ? '[synkora] o ajudante que você abriu encerrou.'
        : `[synkora] ${entries.length} ajudantes que você abriu encerraram: ` +
          [
            `${plural(done, 'concluído', 'concluídos')}`,
            `${plural(failed, 'falhou', 'falharam')}`,
            ...(interrupted > 0 ? [plural(interrupted, 'interrompido', 'interrompidos')] : [])
          ].join(', ') +
          '.'
  const shown = entries.slice(0, GUI_HELPER_WAKE_LIST_MAX)
  const lines = shown.map(settledLine)
  if (entries.length > shown.length) {
    lines.push(`· … e mais ${entries.length - shown.length} (a lista inteira está no helpers_status)`)
  }
  const tail: string[] = []
  if (settled > 0) {
    tail.push(
      entries.some((entry) => entry.resultPath && !entry.interrupted)
        ? `A entrega ${settled === 1 ? 'está' : 'de cada um está'} no ARQUIVO citado — abra o arquivo (o helper_result devolve o mesmo caminho) e conte ao dono o que voltou.`
        : settled === 1
          ? 'Colha a entrega com helper_result e conte ao dono o que voltou.'
          : 'Colha cada um com helper_result (um id por chamada) e conte ao dono o que voltou.'
    )
  }
  if (interrupted > 0) tail.push(RESUME_OR_DISCARD)
  if (stillWorking > 0) {
    tail.push(
      `Outros ${stillWorking} ainda estão trabalhando — o app te acorda de novo quando encerrarem.`
    )
  }
  return [head, ...lines, tail.join(' ')].join('\n')
}

/**
 * BOOT/REMONTAGEM: cards de ajudante (e envelopes) que ficaram ABERTOS numa
 * fotografia de outro processo. Ajudante não sobrevive a restart (D1, MVP
 * explícito), então a fotografia que volta do disco não pode mostrar "ainda
 * trabalhando" para uma sessão que não existe mais.
 *
 * Puro de propósito: entra a fotografia do anel, sai a lista de terminais.
 */
export function guiOrphanHelperCancellations(
  events: readonly unknown[],
  reason: string
): SessionEvent[] {
  const helperCards: string[] = []
  const envelopes: string[] = []
  const envelopeCandidates = new Set<string>()
  const knownToolIds = new Set<string>()
  const settled = new Set<string>()

  for (const raw of events) {
    const evt = raw as Record<string, unknown> | null
    if (!evt || typeof evt !== 'object') continue
    const toolUseId = typeof evt['toolUseId'] === 'string' ? evt['toolUseId'] : undefined
    if (evt['type'] === 'tool') {
      if (!toolUseId) continue
      knownToolIds.add(toolUseId)
      const name = typeof evt['name'] === 'string' ? evt['name'] : ''
      if (!isGuiHelperCardId(name)) continue
      helperCards.push(toolUseId)
      const parent = evt['parentToolUseId']
      if (typeof parent === 'string' && parent) envelopeCandidates.add(parent)
      continue
    }
    if (evt['type'] !== 'tool-result' || !toolUseId) continue
    // `launched` é RECIBO, nunca desfecho: um card com ele segue aberto.
    if (evt['agentStatus'] === 'launched') continue
    settled.add(toolUseId)
  }

  for (const candidate of envelopeCandidates) {
    // Envelope SINTÉTICO não tem card no anel — nada a fechar.
    if (knownToolIds.has(candidate)) envelopes.push(candidate)
  }

  const terminal = (toolUseId: string, text: string): SessionEvent => ({
    type: 'tool-result',
    toolUseId,
    text,
    isError: false,
    outcome: 'cancelled',
    agentStatus: 'settled'
  })

  // Ajudantes PRIMEIRO: o terminal do envelope fecha, no renderer, todo filho
  // ainda pendente dele — e o ajudante merece o próprio motivo, não o do lote.
  return [
    ...helperCards
      .filter((id) => !settled.has(id))
      .map((id) => terminal(id, `${reason} — o ajudante não sobrevive a isso`)),
    ...envelopes
      .filter((id) => !settled.has(id))
      .map((id) => terminal(id, `${reason} — a frota de ajudantes foi encerrada`))
  ]
}

// ————— o correlacionador —————

export interface GuiHelperCardDeps {
  /** Publica no anel do pane pelo MESMO sink da sessão (nunca por fora). */
  emit(paneId: string, evt: SessionEvent): void
  /** `true` = o CLI está no meio de um turno neste pane. */
  turnActive?(paneId: string): boolean
  /**
   * ENTREGA O DESPERTADOR na conversa do delegador — visível no fio E abrindo
   * turno (é o registro de sessões quem sabe fazer isso; este módulo nunca fala
   * com backend).
   *
   * `true` = entregue, a pendência morre. `false` = recusa TRANSITÓRIA (troca
   * de executor em voo, mensagem da fila saindo): o aviso volta para a
   * pendência e a próxima batida tenta de novo. Ausente = ninguém para acordar
   * e a pendência é descartada em vez de crescer sem fim.
   */
  wake?(paneId: string, wake: GuiHelperWake): boolean
  /** O CORREIO onde o encerramento espera. Ausente = o de produção
   *  (`guiHelperInbox`), que é o MESMO pote que as tools do MCP colhem. */
  inbox?: GuiHelperInbox
  /** Relógio da coalescência. Injetável para o teste não esperar 3s de verdade. */
  setTimer?(ms: number, fn: () => void): () => void
  now?(): number
  newId?(): string
}

interface HelperBatch {
  batchId: string
  paneId: string
  envelopeToolUseId: string
  /** Envelope REAL do stream × id sintético (sem card correspondente). */
  paired: boolean
  /** A janela do lote ainda está aberta (o `engine.spawn` não voltou). */
  open: boolean
  helperIds: string[]
  live: Set<string>
  closed: boolean
}

interface HelperPaneState {
  pendingEnvelopes: string[]
  openBatchId?: string
  batches: Map<string, HelperBatch>
  batchOfHelper: Map<string, string>
  /** Card VIVO de cada ajudante. Ele muda quando o ajudante é retomado (a
   *  segunda vida tem card próprio), e é por ele que a atividade e o desfecho
   *  encontram o card certo — nunca por derivação do helperId. */
  cardOfHelper: Map<string, string>
  /** Quantas vidas cada ajudante já teve (1 = nasceu; 2 = foi retomado uma vez). */
  lives: Map<string, number>
  /** Ajudantes cujo ÚLTIMO card foi fechado como interrompido. Eles saíram do
   *  `live` do lote mas ainda podem receber um desfecho novo — o descarte. */
  interrupted: Set<string>
  activity: Map<string, { at: number; count: number }>
  /** Cancelador do relógio de coalescência (ausente = nenhum armado). */
  cancelWake?: () => void
}

export class GuiHelperCardCorrelator {
  private readonly deps: GuiHelperCardDeps
  private readonly panes = new Map<string, HelperPaneState>()
  /** Os ajudantes encerrados esperam AQUI — o mesmo pote que as tools colhem. */
  private readonly inbox: GuiHelperInbox
  private readonly now: () => number
  private readonly setTimer: (ms: number, fn: () => void) => () => void
  private syntheticSeq = 0

  constructor(deps: GuiHelperCardDeps) {
    this.deps = deps
    this.inbox = deps.inbox ?? guiHelperInbox
    this.now = deps.now ?? Date.now
    this.setTimer =
      deps.setTimer ??
      ((ms, fn) => {
        const handle = setTimeout(fn, ms)
        // Aviso pendente nunca segura o encerramento do app.
        handle.unref?.()
        return () => clearTimeout(handle)
      })
  }

  /**
   * Passa TODO evento do pane por aqui, antes do anel. Três trabalhos:
   *
   *  1. empilhar o `toolUseId` de cada chamada `delegate` (a fila do pareamento);
   *  2. carimbar `agentStatus: 'launched'` no resultado do ENVELOPE enquanto os
   *     ajudantes dele estiverem vivos — sem isso o card do lote fecharia no
   *     mesmo segundo e a poda de 400 itens poderia evictá-lo;
   *  3. carimbar `continues: true` no `result` do turno enquanto houver ajudante
   *     vivo. Este é o degrau que faltava: no renderer, o fim de turno
   *     (`closePendingGuiTools`) CANCELA todo card pendente — inclusive os
   *     `launched`. É exatamente por isso que o próprio claude mantém
   *     `continues` verdadeiro enquanto tem tarefa de fundo viva
   *     (`maestroSession.ts`: `this.claudeTasks.size > 0`). Ajudante MCP é a
   *     mesma natureza de trabalho, e usa o mesmo degrau.
   */
  observe(paneId: string, evt: SessionEvent): SessionEvent {
    if (evt.type === 'tool') {
      if (evt.toolUseId && !isGuiHelperCardId(evt.name) && isGuiDelegateToolName(evt.name)) {
        const state = this.state(paneId)
        state.pendingEnvelopes.push(evt.toolUseId)
        while (state.pendingEnvelopes.length > GUI_HELPER_PENDING_ENVELOPE_CAP) {
          state.pendingEnvelopes.shift()
        }
      }
      return evt
    }
    if (evt.type === 'tool-result') {
      if (!evt.toolUseId || evt.agentStatus !== undefined) return evt
      const state = this.panes.get(paneId)
      if (!state) return evt
      // Envelope resolvido pelo CLI e não reclamado por lote nenhum: some da
      // fila, senão pareria um lote FUTURO com uma chamada que já terminou.
      const pendingAt = state.pendingEnvelopes.indexOf(evt.toolUseId)
      if (pendingAt >= 0) state.pendingEnvelopes.splice(pendingAt, 1)
      const batch = this.batchByEnvelope(state, evt.toolUseId)
      if (!batch || batch.live.size === 0) return evt
      return { ...evt, agentStatus: 'launched' }
    }
    if (evt.type === 'result' && evt.continues !== true && this.hasLiveHelpers(paneId)) {
      return { ...evt, continues: true }
    }
    return evt
  }

  /** Há ajudante VIVO neste pane? (o que segura o turno e os cards). */
  hasLiveHelpers(paneId: string): boolean {
    const state = this.panes.get(paneId)
    if (!state) return false
    for (const batch of state.batches.values()) {
      if (batch.live.size > 0) return true
    }
    return false
  }

  /**
   * Abre o lote e RECLAMA um envelope. Chamado pelo handler da tool `delegate`
   * ANTES do `engine.spawn` — os avisos `spawned` chegam DENTRO do spawn, e é
   * o lote aberto que diz a qual chamada eles pertencem.
   */
  begin(paneId: string): string {
    const state = this.state(paneId)
    const claimed = state.pendingEnvelopes.shift()
    const batchId = this.deps.newId?.() ?? `lote-${(this.syntheticSeq += 1)}`
    const batch: HelperBatch = {
      batchId,
      paneId,
      envelopeToolUseId: claimed ?? `${GUI_HELPER_CARD_PREFIX}lote:${batchId}`,
      paired: Boolean(claimed),
      open: true,
      helperIds: [],
      live: new Set(),
      closed: false
    }
    state.batches.set(batchId, batch)
    state.openBatchId = batchId
    return batchId
  }

  /**
   * Fecha a janela do lote. Lote sem nenhum ajudante é descartado na hora — e o
   * envelope dele, reclamado da fila, volta a ser um card comum que o próprio
   * CLI encerra.
   *
   * O terminal do envelope só pode sair DEPOIS desta barreira: um ajudante que
   * morre no nascimento (adaptador que explode) encerraria o lote enquanto o
   * `engine.spawn` ainda está abrindo os irmãos dele.
   */
  end(paneId: string): void {
    const state = this.panes.get(paneId)
    if (!state?.openBatchId) return
    const batch = state.batches.get(state.openBatchId)
    state.openBatchId = undefined
    if (!batch) return
    batch.open = false
    if (batch.helperIds.length === 0) {
      state.batches.delete(batch.batchId)
      return
    }
    if (batch.live.size === 0) this.closeBatch(paneId, batch)
  }

  /** O motor falou: nasceu, mexeu, voltou ou encerrou. */
  change(change: GuiHelperChange): void {
    if (change.kind === 'spawned') this.spawned(change.record)
    else if (change.kind === 'activity') this.activity(change.record)
    else if (change.kind === 'resumed') this.resumed(change.record)
    else this.settled(change.record)
  }

  /**
   * O ■ DO DONO (R6.3), terceira parte: as pendências de aviso deste pane são
   * DESCARTADAS.
   *
   * O caso real: o dono interrompeu a conversa e o despertador, que tinha um
   * aviso preso, abriu um turno NOVO por cima — o app falando justamente na
   * conversa que ele mandou calar. Silenciar é o certo aqui: quem interrompe
   * está no teclado, vendo a lateral, e vai perguntar o que quiser saber.
   *
   * O que NÃO se esquece: os lotes e os ajudantes vivos. Isto não é
   * `forgetPane` — a conversa continua de pé, e o que encerrar DEPOIS do ■
   * volta a ser anunciado normalmente.
   */
  discardPending(paneId: string): number {
    const state = this.panes.get(paneId)
    const dropped = this.inbox.drain(paneId).length
    if (state?.cancelWake) {
      state.cancelWake()
      state.cancelWake = undefined
    }
    return dropped
  }

  /**
   * O DESPERTADOR DE BOOT (R6.1, cauda): a conversa reabriu e há ajudantes
   * PARADOS esperando uma decisão. Eles entram no MESMO pote dos encerramentos
   * — o dono não tem dois correios, e o primeiro caminho de entrega que passar
   * (a carona numa tool ou o despertador) consome a novidade uma vez só.
   *
   * Devolve quantos foram postados: repetição (remontagem, aviso já entregue)
   * devolve zero, e é assim que "uma vez por boot" acontece sem estado novo.
   */
  noteInterrupted(paneId: string, helpers: readonly GuiHelperInterruptedInput[]): number {
    let posted = 0
    for (const helper of helpers) {
      const entered = this.inbox.post(paneId, {
        helperId: helper.helperId,
        ...(helper.name ? { name: helper.name } : {}),
        model: helper.model,
        ok: false,
        interrupted: true,
        ...(helper.resultPath ? { resultPath: helper.resultPath } : {}),
        ...(typeof helper.elapsedMs === 'number' ? { elapsedMs: helper.elapsedMs } : {})
      })
      if (entered) posted += 1
    }
    if (posted > 0) this.scheduleWake(paneId, this.state(paneId))
    return posted
  }

  /** Há aviso preso neste pane? (o ■ do dono usa para auditar o que calou). */
  pendingWakes(paneId: string): number {
    return this.inbox.count(paneId)
  }

  /** O pane sumiu: o estado de correlação morre com ele (o anel é a memória) —
   *  e com ele o aviso pendente. Acordar uma conversa que está sendo desmontada
   *  seria barulho para ninguém. */
  forgetPane(paneId: string): void {
    this.panes.get(paneId)?.cancelWake?.()
    this.panes.delete(paneId)
    this.inbox.forget(paneId)
  }

  private state(paneId: string): HelperPaneState {
    let state = this.panes.get(paneId)
    if (!state) {
      state = {
        pendingEnvelopes: [],
        batches: new Map(),
        batchOfHelper: new Map(),
        cardOfHelper: new Map(),
        lives: new Map(),
        interrupted: new Set(),
        activity: new Map()
      }
      this.panes.set(paneId, state)
    }
    return state
  }

  private batchByEnvelope(state: HelperPaneState, toolUseId: string): HelperBatch | undefined {
    for (const batch of state.batches.values()) {
      if (batch.envelopeToolUseId === toolUseId) return batch
    }
    return undefined
  }

  private spawned(record: GuiHelperRecord): void {
    const state = this.state(record.delegatorPaneId)
    const batch = state.openBatchId ? state.batches.get(state.openBatchId) : undefined
    if (!batch) return
    batch.helperIds.push(record.helperId)
    batch.live.add(record.helperId)
    state.batchOfHelper.set(record.helperId, batch.batchId)
    const cardId = guiHelperCardId(record.helperId)
    state.cardOfHelper.set(record.helperId, cardId)
    state.lives.set(record.helperId, 1)
    for (const evt of guiHelperSpawnedEvents(record, batch.envelopeToolUseId, cardId)) {
      this.deps.emit(record.delegatorPaneId, evt)
    }
  }

  /**
   * A SEGUNDA VIDA (R6.2). O card do interrompido já fechou — e no renderer um
   * card fechado nunca mais aceita resultado —, então o retomado ganha card
   * PRÓPRIO, com id novo, sob o mesmo envelope de sempre.
   *
   * Depois de um BOOT não há lote nenhum na memória (o correlacionador nasce
   * vazio com o processo): o ajudante ganha um lote só dele, com envelope
   * SINTÉTICO — que não tem card para fechar, e é exatamente o caso que a
   * costura de correlação já sabia tratar.
   */
  private resumed(record: GuiHelperRecord): void {
    const paneId = record.delegatorPaneId
    const state = this.state(paneId)
    const batchId = state.batchOfHelper.get(record.helperId)
    let batch = batchId ? state.batches.get(batchId) : undefined
    if (!batch) {
      const newBatchId = this.deps.newId?.() ?? `lote-${(this.syntheticSeq += 1)}`
      batch = {
        batchId: newBatchId,
        paneId,
        envelopeToolUseId: `${GUI_HELPER_CARD_PREFIX}lote:${newBatchId}`,
        paired: false,
        open: false,
        helperIds: [record.helperId],
        live: new Set(),
        closed: false
      }
      state.batches.set(newBatchId, batch)
      state.batchOfHelper.set(record.helperId, newBatchId)
    }
    // O LOTE VOLTA A TER VIDA: sem isto o `hasLiveHelpers` diria "não" e o
    // `result` do turno deixaria de carregar `continues`, o que faria o renderer
    // cancelar o card recém-aberto no fim do turno.
    batch.closed = false
    batch.live.add(record.helperId)
    if (!batch.helperIds.includes(record.helperId)) batch.helperIds.push(record.helperId)
    state.interrupted.delete(record.helperId)
    // A amostragem de atividade recomeça: a segunda vida tem o próprio
    // orçamento de cards no anel.
    state.activity.delete(record.helperId)
    const life = (state.lives.get(record.helperId) ?? 1) + 1
    state.lives.set(record.helperId, life)
    const cardId = guiHelperResumeCardId(record.helperId, life)
    state.cardOfHelper.set(record.helperId, cardId)
    for (const evt of guiHelperSpawnedEvents(record, batch.envelopeToolUseId, cardId)) {
      this.deps.emit(paneId, evt)
    }
  }

  private activity(record: GuiHelperRecord): void {
    const state = this.panes.get(record.delegatorPaneId)
    if (!state || !state.batchOfHelper.has(record.helperId)) return
    const seen = state.activity.get(record.helperId) ?? { at: 0, count: 0 }
    const at = this.now()
    if (seen.count >= GUI_HELPER_CARD_ACTIVITY_MAX) return
    if (seen.count > 0 && at - seen.at < GUI_HELPER_CARD_ACTIVITY_MS) return
    const evt = guiHelperActivityEvent(record, seen.count + 1, state.cardOfHelper.get(record.helperId))
    if (!evt) return
    state.activity.set(record.helperId, { at, count: seen.count + 1 })
    this.deps.emit(record.delegatorPaneId, evt)
  }

  private settled(record: GuiHelperRecord): void {
    const state = this.panes.get(record.delegatorPaneId)
    const batchId = state?.batchOfHelper.get(record.helperId)
    const batch = state && batchId ? state.batches.get(batchId) : undefined
    if (!state || !batch) return
    const cardId = state.cardOfHelper.get(record.helperId)
    if (!batch.live.delete(record.helperId)) {
      // DESCARTE DE UM INTERROMPIDO (R6.2): ele já saiu do `live` quando parou,
      // mas o card dele continua na tela mostrando "interrompido" — e o dono
      // acabou de mandar jogar fora. O tool-result novo cai no MESMO card e
      // reescreve o desfecho; sem isto a lateral mentiria para sempre.
      if (!state.interrupted.has(record.helperId) || !isGuiHelperTerminal(record.state)) return
      state.interrupted.delete(record.helperId)
      state.cardOfHelper.delete(record.helperId)
      this.deps.emit(record.delegatorPaneId, guiHelperSettledEvent(record, cardId))
      return
    }
    if (record.state === 'interrupted') state.interrupted.add(record.helperId)
    else state.cardOfHelper.delete(record.helperId)
    this.deps.emit(record.delegatorPaneId, guiHelperSettledEvent(record, cardId))
    // O CORREIO + O DESPERTADOR (as duas correções de 18/08). O card fechar na
    // lateral não conta nada ao AGENTE: se ele já encerrou o turno, ninguém mais
    // vai chamar `helper_result` e a conversa morre em silêncio com a entrega
    // pronta na mão do harness; e se ele está DENTRO de um turno, o despertador
    // (que nunca interrompe) o deixaria cego até o turno acabar. A novidade
    // entra no pote e sai pelo primeiro dos dois caminhos. `cancelled` fica DE
    // FORA: pane desmontado, quit e órfão de boot não têm ninguém esperando.
    if (record.state === 'done' || record.state === 'failed') {
      this.armWake(record.delegatorPaneId, state, record)
    }
    if (batch.live.size > 0 || batch.open) return
    this.closeBatch(record.delegatorPaneId, batch)
  }

  private armWake(paneId: string, state: HelperPaneState, record: GuiHelperRecord): void {
    // O `live.delete` acima já é a barreira de "encerra uma vez só"; o `post`
    // devolvendo `false` é o segundo pente, para o motor que repetisse um
    // `settled` sem passar por lá.
    const posted = this.inbox.post(paneId, {
      helperId: record.helperId,
      ...(record.name ? { name: record.name } : {}),
      model: record.model,
      ok: record.state === 'done',
      ...(record.resultPath ? { resultPath: record.resultPath } : {})
    })
    if (!posted) return
    this.scheduleWake(paneId, state)
  }

  /** Janela ÚNICA por pane: quem já tem relógio armado não arma outro. */
  private scheduleWake(paneId: string, state: HelperPaneState): void {
    if (state.cancelWake) return
    state.cancelWake = this.setTimer(GUI_HELPER_WAKE_COALESCE_MS, () => {
      const current = this.panes.get(paneId)
      if (!current) return
      current.cancelWake = undefined
      this.flushWake(paneId, current)
    })
  }

  /**
   * A BATIDA DO DESPERTADOR.
   *
   * Turno em andamento SEGURA o aviso: o agente está falando, os cards fecham
   * sozinhos na lateral e interrompê-lo seria pior que esperar — quem alcança o
   * agente lá dentro é o CORREIO, de carona no resultado da próxima tool. O
   * relógio então se re-arma — batida de 3 em 3s que só existe ENQUANTO há aviso
   * preso, e que morre no primeiro desfecho (entregue por qualquer um dos dois
   * caminhos, pane esquecido, sessão morta). É de propósito que a espera não
   * dependa de observar o `result` do turno: o mesmo laço cobre também as
   * recusas que não são de turno (troca de executor em voo, entrega da fila
   * saindo), e uma recusa dessas nunca deixa o dono no silêncio que este código
   * veio consertar.
   */
  private flushWake(paneId: string, state: HelperPaneState): void {
    // Pote vazio = o correio já entregou esta novidade numa tool. O relógio
    // simplesmente não se re-arma e o despertador se apaga sozinho.
    if (!this.inbox.has(paneId)) return
    const deliver = this.deps.wake
    if (!deliver) {
      this.inbox.forget(paneId)
      return
    }
    if (!this.deps.turnActive?.(paneId)) {
      // COLHE ANTES DE ENTREGAR: a entrega ABRE UM TURNO, e um turno é evento —
      // pendência viva aqui viraria um segundo aviso para o mesmo ajudante.
      const entries = this.inbox.drain(paneId)
      const done = entries.filter((entry) => entry.ok).length
      const stillWorking = this.liveHelperCount(state)
      const delivered = deliver(paneId, {
        helperIds: entries.map((entry) => entry.helperId),
        done,
        failed: entries.length - done,
        stillWorking,
        text: guiHelperWakeMessage(entries, stillWorking)
      })
      if (delivered) return
      // Devolve os antigos NA FRENTE do que possa ter encerrado durante a
      // tentativa — recusa não pode reordenar nem comer encerramento novo.
      this.inbox.restore(paneId, entries)
    }
    this.scheduleWake(paneId, state)
  }

  private liveHelperCount(state: HelperPaneState): number {
    let count = 0
    for (const batch of state.batches.values()) count += batch.live.size
    return count
  }

  private closeBatch(paneId: string, batch: HelperBatch): void {
    if (batch.closed) return
    batch.closed = true
    // O terminal do envelope fecha o card do lote (e, no renderer, qualquer
    // filho pendente dele). Envelope sintético não tem card: nada a fechar.
    if (batch.paired) {
      this.deps.emit(
        paneId,
        guiHelperEnvelopeSettledEvent(batch.envelopeToolUseId, batch.helperIds.length)
      )
    }
    // A frota acabou e o CLI não está em turno: o pane volta a IDLE. Sem isto
    // ele ficaria "trabalhando" para sempre por causa do `continues` que este
    // mesmo módulo carimbou enquanto os ajudantes viviam.
    if (this.hasLiveHelpers(paneId)) return
    if (this.deps.turnActive?.(paneId)) return
    this.deps.emit(paneId, { type: 'turn-continuation', continues: false })
  }
}

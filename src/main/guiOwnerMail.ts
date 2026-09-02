/**
 * O POTE DO DONO — a mensagem que FURA o turno-fortaleza (R22, design vinculante
 * `.synkora/reports/DESIGN_MENSAGEM_FURA_TURNO_R22_2026-08-19.md`).
 *
 * O CASO REAL (print do dono, 19/08): o delegador estava num laço de
 * `helper_result` esperando três ajudantes; o dono mandou uma mensagem com
 * "enviar agora", a bolha VOCÊ apareceu no fio — e o agente NÃO leu. O turno do
 * delegador é UMA request longa, e mensagem empurrada pro stdin no meio dela
 * fica na fila INTERNA do CLI até o turno fechar; pós-R19 isso pode ser HORAS.
 * O dono ficava sem volante justamente quando mais precisava dele.
 *
 * ATUALIZAÇÃO R31 (2026-08-23): o retrato acima envelheceu — o claude 2.1.241
 * STEERA o stdin na fronteira da próxima tool (sonda
 * probe-claude-owner-midturn), e o composer passou a enviar na hora. O pote
 * continua de pé pelo que o steering NÃO dá: o WAKE do long-poll da frota
 * (sem ele a fala do dono esperaria até 240s pela fronteira do
 * `helper_result`), o reconciliador de fecho/boot e a persistência em disco —
 * a rede não se remove inteira por se achar a causa raiz.
 *
 * ATUALIZAÇÃO R39 (2026-09-02): a carona também envelheceu, e a medição de
 * 01/09 (missão 86a05c06/d13f0a00) diz por quê — três falas do dono ficaram 3
 * min no pote porque o agente estava em tools NATIVAS, que nenhuma carona
 * alcança, e quando enfim viajaram DENTRO de um resultado de tool o modelo
 * tentou seis tools antes de escrever uma linha: OITO minutos até a resposta.
 * ENTREGA não é OBEDIÊNCIA, e a posição da fala é a causa. Agora a fala com
 * turno aberto PARA o turno (`guiSessions` → `entry.session.interrupt()`) e
 * volta como TURNO NOVO, com o envelope de `guiOwnerHandText`. O pote continua
 * sendo o mesmo lugar de espera — só que a entrada dele nasce MARCADA
 * (`handoff`), e a marca é o que impede a carona de levá-la para dentro do
 * turno que está sendo cortado.
 *
 * O ÚNICO canal que alcança o modelo NO MEIO do turno é o RESULTADO DE TOOL — a
 * casa já anda nele com o correio dos ajudantes (`guiHelperCards.GuiHelperInbox`,
 * o bloco `[synkora] ajudantes:`). Este módulo é o pote da OUTRA carga: a fala do
 * dono. Pote PRÓPRIO de propósito — o dos ajudantes é moldado em encerramento
 * (chave por `helperId`, placar de concluído/falhou, receita de colheita), e
 * enfiar a voz do dono lá dentro faria uma coisa mentir sobre a outra.
 *
 * A DOUTRINA DA CASA, inteira, mora aqui:
 *  - a bolha VOCÊ continua aparecendo NA HORA (apresentação não é entrega);
 *  - o pote guarda com RECIBO (caixa-preta no `post`, no drain e no fecho);
 *  - entrega por carona é ÚNICA: nunca também por stdin, senão o modelo lê duas
 *    vezes (agora na carona e de novo como turno quando o CLI liberar a fila);
 *  - nada depende de entrega única — se o turno fechar com o pote cheio, o fecho
 *    FLUSHA como envio normal (`guiSessions.flushOwnerMail`), e o que o app não
 *    entregou antes de morrer volta do disco no próximo nascimento do pane.
 *
 * Este módulo não conhece electron, sessão, CLI nem MCP: ele guarda, entrega e
 * escreve texto. As duas pontas (a ROTA, em `guiSessions.ts`, e a CARONA, em
 * `guiDelegationWiring.ts`) recebem a MESMA instância por injeção — em produção,
 * o `guiOwnerMailbox` abaixo.
 */
import { loadJsonStore, persistJsonStore } from './jsonStore'

/** A marca do bloco que pega carona. O agente e o dono leem a mesma linha e
 *  sabem de cara que quem falou foi o app repassando a voz do DONO. */
export const GUI_OWNER_MAIL_TAG = '[synkora] MENSAGEM DO DONO'

/**
 * Teto por mensagem. Acima dele o pote RECUSA — e recusar aqui não é beco: a
 * rota cai no caminho de sempre (stdin do CLI, entregue no fecho do turno).
 * Existe porque a carona viaja DENTRO de um resultado de tool: um despejo de
 * 256 mil caracteres (o teto do composer) num `helper_result` sufocaria o
 * próprio turno que a mensagem quer corrigir. A mesma ordem de grandeza do
 * `HELPER_SEND_MAX_CHARS` do servidor MCP.
 */
export const GUI_OWNER_MAIL_MAX_CHARS = 16 * 1024

/** Teto de mensagens em espera por pane. Estourou = caminho de sempre (nunca
 *  descartar a fala do dono para caber num limite nosso). */
export const GUI_OWNER_MAIL_PANE_CAP = 16

/**
 * Teto do POTE INTEIRO de um pane. Ele existe pelo reconciliador: o fecho do
 * turno entrega tudo numa mensagem só, e o `guiPromptProblem` (256 mil
 * caracteres / 1 MB) recusaria um pote maior que isso — recusa que voltaria a
 * cada fecho, para sempre, sem nunca progredir. Com este teto o fecho SEMPRE
 * cabe, e a mensagem que não coube nele seguiu pelo caminho de sempre.
 */
export const GUI_OWNER_MAIL_PANE_MAX_CHARS = 64 * 1024

/**
 * Validade da mensagem guardada no disco. A mesma régua da mensagem em fila do
 * composer (`GUI_QUEUED_DELIVERY_MAX_AGE_MS`): uma semana depois, entregar
 * "agora" uma ordem daquela idade seria pior que perdê-la — e o fio ainda tem a
 * bolha para o dono reler e reenviar se quiser.
 */
export const GUI_OWNER_MAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

/** `userData/gui-owner-mail.json` — o nome mora aqui para os dois lados (quem
 *  monta o caminho e quem lê o arquivo) falarem do MESMO arquivo. */
export const GUI_OWNER_MAIL_STORE_FILE = 'gui-owner-mail.json'

export const GUI_OWNER_MAIL_STORE_VERSION = 1

/** Uma fala do dono esperando entrega. */
export interface GuiOwnerMailEntry {
  /** O MESMO id da bolha no fio. É ele que impede a entrega dupla quando o
   *  boundary IPC repete o envio (a rota e o reconciliador olham para o mesmo
   *  bilhete). */
  messageId: string
  text: string
  at: number
  /**
   * R39 D1/D2 — ESTA FALA PAROU O TURNO. Marcada assim, ela pertence ao TURNO
   * NOVO que vai nascer do fecho da interrupção: a carona (`withOwnerMail`) a
   * pula de propósito, porque entregá-la dentro de um turno que está sendo
   * cortado faria o modelo lê-la e perdê-la no mesmo passo. A marca morre
   * quando o flush entrega, com o envelope de retomada.
   */
  handoff?: true
}

/** A mesma fala, com o endereço — a forma que vai ao disco. */
export interface GuiOwnerMailRecord extends GuiOwnerMailEntry {
  paneId: string
}

export interface GuiOwnerMailStoreDoc {
  version: number
  mail: GuiOwnerMailRecord[]
}

/**
 * O disco do pote. Injetado pela MESMA razão do `GuiHelperStore`: este módulo
 * roda nas suítes em node puro, e um pote que abrisse arquivo no import
 * arrastaria disco para dentro de todo teste que só quer ler texto.
 */
export interface GuiOwnerMailStore {
  load(): GuiOwnerMailRecord[]
  save(records: readonly GuiOwnerMailRecord[]): void
}

function validEntry(value: unknown): value is GuiOwnerMailRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['paneId'] === 'string' &&
    record['paneId'].length > 0 &&
    record['paneId'].length <= 256 &&
    typeof record['messageId'] === 'string' &&
    record['messageId'].length > 0 &&
    record['messageId'].length <= 256 &&
    typeof record['text'] === 'string' &&
    record['text'].length > 0 &&
    record['text'].length <= GUI_OWNER_MAIL_MAX_CHARS &&
    typeof record['at'] === 'number' &&
    Number.isFinite(record['at']) &&
    // A marca só existe em uma forma (`true`): qualquer outra coisa é fotografia
    // estragada, e fala do dono não se entrega com metade do endereço.
    (record['handoff'] === undefined || record['handoff'] === true)
  )
}

/** A fala, sem o endereço — a forma que o pote guarda em memória. Mantém a
 *  MARCA (D2): sem ela, o disco devolveria a fala crua e o renascimento a
 *  entregaria sem dizer que ele foi parado. */
function mailEntry(record: GuiOwnerMailRecord | GuiOwnerMailEntry): GuiOwnerMailEntry {
  return {
    messageId: record.messageId,
    text: record.text,
    at: record.at,
    ...(record.handoff === true ? { handoff: true as const } : {})
  }
}

export function isGuiOwnerMailStoreDoc(value: unknown): value is GuiOwnerMailStoreDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const doc = value as Record<string, unknown>
  return typeof doc['version'] === 'number' && Array.isArray(doc['mail'])
}

/**
 * O disco de PRODUÇÃO, sobre o `jsonStore` atômico da casa — o mesmo que guarda
 * as conversas e a frota: escrita por rename, backup `.bak` reparável e leitura
 * que cai no backup quando o principal está estragado.
 */
export function createGuiOwnerMailStore(file: string): GuiOwnerMailStore {
  return {
    load: () =>
      loadJsonStore<GuiOwnerMailStoreDoc>(
        file,
        () => ({ version: GUI_OWNER_MAIL_STORE_VERSION, mail: [] }),
        isGuiOwnerMailStoreDoc
      ).mail.filter((entry): entry is GuiOwnerMailRecord => validEntry(entry)),
    save: (records) =>
      persistJsonStore(file, { version: GUI_OWNER_MAIL_STORE_VERSION, mail: [...records] })
  }
}

/**
 * O POTE, por pane. Ordem de chegada preservada em tudo — a segunda fala do dono
 * costuma corrigir a primeira, e embaralhá-las inverteria a ordem dele.
 */
export class GuiOwnerMailbox {
  private readonly panes = new Map<string, GuiOwnerMailEntry[]>()
  private readonly now: () => number
  private store?: GuiOwnerMailStore

  constructor(deps: { store?: GuiOwnerMailStore; now?: () => number } = {}) {
    this.now = deps.now ?? Date.now
    if (deps.store) this.attachStore(deps.store)
  }

  /**
   * Liga o disco DEPOIS do nascimento (o singleton de produção nasce no import,
   * quando `userData` ainda não é conhecido) e lê a fotografia na hora: o que o
   * app não entregou antes de morrer volta para o pote, e o nascimento do pane
   * o flusha (`guiSessions.flushOwnerMail`).
   *
   * O que está NO POTE agora não se perde: a fotografia do disco entra ATRÁS do
   * que já está em memória, que é a ordem cronológica de verdade.
   */
  attachStore(store: GuiOwnerMailStore): void {
    this.store = store
    let restored: GuiOwnerMailRecord[] = []
    try {
      restored = store.load() ?? []
    } catch {
      // Disco ilegível é pote vazio, nunca um app que não abre.
      return
    }
    const cutoff = this.now() - GUI_OWNER_MAIL_MAX_AGE_MS
    for (const record of restored) {
      if (!validEntry(record) || record.at < cutoff) continue
      const pending = this.panes.get(record.paneId) ?? []
      if (pending.length >= GUI_OWNER_MAIL_PANE_CAP) continue
      if (pending.some((known) => known.messageId === record.messageId)) continue
      pending.push(mailEntry(record))
      this.panes.set(record.paneId, pending)
    }
    this.persist()
  }

  /**
   * Guarda a fala do dono. `false` = o pote NÃO ficou com ela e o chamador tem
   * de seguir pelo caminho de sempre (stdin do CLI) — mensagem gigante demais
   * para viajar num resultado de tool, ou pote cheio. Nunca é descarte: a
   * recusa é justamente o que mantém a rota alternativa viva.
   */
  post(paneId: string, entry: GuiOwnerMailEntry): boolean {
    if (!paneId || typeof entry.text !== 'string') return false
    const text = entry.text
    if (!text.trim() || text.length > GUI_OWNER_MAIL_MAX_CHARS) return false
    if (!entry.messageId) return false
    const pending = this.panes.get(paneId) ?? []
    // Bilhete repetido (retry do boundary IPC) já está guardado: dizer `true`
    // aqui é o que impede a MESMA fala de sair duas vezes.
    if (pending.some((known) => known.messageId === entry.messageId)) return true
    if (pending.length >= GUI_OWNER_MAIL_PANE_CAP) return false
    const total = pending.reduce((sum, known) => sum + known.text.length, 0)
    if (total + text.length > GUI_OWNER_MAIL_PANE_MAX_CHARS) return false
    pending.push(mailEntry({ ...entry, text }))
    this.panes.set(paneId, pending)
    this.persist()
    return true
  }

  count(paneId: string): number {
    return this.panes.get(paneId)?.length ?? 0
  }

  has(paneId: string): boolean {
    return this.count(paneId) > 0
  }

  /** Fotografia sem consumir — para quem só precisa saber o tamanho da carga. */
  peek(paneId: string): readonly GuiOwnerMailEntry[] {
    return this.panes.get(paneId) ?? []
  }

  /**
   * Tira do pane. Drenar É a entrega: quem drenou tem de entregar, ou devolver
   * com `restore` — a fala do dono nunca some no meio.
   *
   * R39 D2 — o pote passou a ter DUAS cargas com destinos diferentes, e quem
   * drena diz qual leva:
   *  - `skipHandoff` (a CARONA): só o correio SEM marca. A fala que parou o
   *    turno não pode viajar dentro do turno que está sendo cortado.
   *  - `handoffOnly`: só a marcada.
   *  - sem opção: TUDO (o fecho do turno entrega o pote inteiro numa mensagem
   *    só — foi o dono quem falou duas vezes, não o app que somou duas coisas).
   */
  drain(
    paneId: string,
    opts: { skipHandoff?: boolean; handoffOnly?: boolean } = {}
  ): GuiOwnerMailEntry[] {
    const pending = this.panes.get(paneId)
    if (!pending || pending.length === 0) return []
    const wanted = (entry: GuiOwnerMailEntry): boolean => {
      if (opts.handoffOnly === true) return entry.handoff === true
      if (opts.skipHandoff === true) return entry.handoff !== true
      return true
    }
    const taken = pending.filter(wanted)
    if (taken.length === 0) return []
    const left = pending.filter((entry) => !wanted(entry))
    if (left.length === 0) this.panes.delete(paneId)
    else this.panes.set(paneId, left)
    this.persist()
    return taken
  }

  /** Devolve à FRENTE (a entrega não aconteceu): a ordem em que o dono falou é
   *  a ordem em que o agente tem de ler. */
  restore(paneId: string, entries: readonly GuiOwnerMailEntry[]): void {
    if (entries.length === 0) return
    this.panes.set(paneId, [...entries, ...(this.panes.get(paneId) ?? [])])
    this.persist()
  }

  /** A conversa acabou de vez (nunca um respawn): fala sem destinatário é lixo,
   *  não memória. */
  forget(paneId: string): void {
    if (!this.panes.delete(paneId)) return
    this.persist()
  }

  private persist(): void {
    const store = this.store
    if (!store) return
    const records: GuiOwnerMailRecord[] = []
    for (const [paneId, entries] of this.panes) {
      for (const entry of entries) records.push({ paneId, ...entry })
    }
    try {
      store.save(records)
    } catch {
      // Disco recusando nunca pode derrubar uma entrega que já está em memória:
      // o pote continua funcionando, e só a travessia do boot se perde.
    }
  }
}

/** O pote de PRODUÇÃO — um por processo, chaveado por paneId (único no app
 *  inteiro). As suítes injetam o próprio; o app usa este dos dois lados. */
export const guiOwnerMailbox = new GuiOwnerMailbox()

function quoted(text: string): string {
  return `"${text.trim()}"`
}

/**
 * O BLOCO QUE PEGA CARONA num resultado de tool (R22.2).
 *
 * Curto por obrigação — ele viaja no meio de um resultado que o agente já está
 * pagando —, e com TRÊS coisas obrigatórias: de quem é a fala (o DONO, não o
 * app), QUANDO ela chegou (agora, no meio do turno — não é turno novo) e o
 * MOVIMENTO (ler, ajustar o rumo e responder na próxima fala). Sem a terceira,
 * um agente disciplinado guardaria a mensagem para "depois de terminar" — que é
 * exatamente o comportamento que esta rodada existe para matar.
 */
export function guiOwnerMailBlock(entries: readonly GuiOwnerMailEntry[]): string {
  if (entries.length === 0) return ''
  const head =
    entries.length === 1
      ? `${GUI_OWNER_MAIL_TAG} (chegou agora, no meio do turno):`
      : `${GUI_OWNER_MAIL_TAG} — ${entries.length} mensagens (chegaram agora, no meio do turno):`
  const body =
    entries.length === 1
      ? quoted(entries[0]?.text ?? '')
      : entries.map((entry, index) => `${index + 1}. ${quoted(entry.text)}`).join('\n')
  // "Responda na sua próxima fala" era brecha (caso do dono, 2026-08-21): a
  // entrega chegava em segundos — a caixa-preta provou 0-25s — mas o modelo
  // lia, ajustava e voltava a ESPERAR sem falar, e a "próxima fala" só vinha
  // quando o ajudante acabava. Para o dono, agente mudo = mensagem perdida.
  // A ordem agora nomeia o momento: a fala vem ANTES de qualquer outra tool.
  const tail =
    'Leia e AJUSTE O RUMO AGORA — isto não é um turno novo, é o dono falando DENTRO deste. ' +
    'FALE COM ELE JÁ, antes de qualquer outra tool (inclusive antes de voltar a esperar ajudante): ' +
    'uma ou duas linhas dizendo o que você entendeu e o que muda — até você falar, a tela dele fica ' +
    'parada e ele conclui que a mensagem se perdeu. Depois aja: se o pedido muda o trabalho da frota, ' +
    'dirija (helper_send), descarte (helper_cancel) ou abra outros (delegate) antes de seguir.'
  return [head, body, tail].join('\n')
}

/**
 * O TEXTO DO FECHO (R22.4) — a fala do dono, VERBATIM.
 *
 * Aqui não há bloco de casa nenhum de propósito: o turno acabou, então a
 * mensagem entra no CLI como a mensagem de usuário que ela sempre foi (a bolha
 * dela já está no fio desde o envio). Embrulhá-la em prefixo de harness faria o
 * modelo tratar a ordem do dono como citação do app — e é justamente esse
 * caminho, o de sempre, que o pane não-delegador continua usando inteiro.
 */
export function guiOwnerMailFlushText(entries: readonly GuiOwnerMailEntry[]): string {
  return entries
    .map((entry) => entry.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * O ENVELOPE DE RETOMADA (R39 D3) — o texto do TURNO NOVO que nasce depois de a
 * fala do dono PARAR o turno anterior.
 *
 * O QUE FOI MEDIDO (missão 86a05c06/d13f0a00, 01/09 21:30–21:40): três falas do
 * dono ficaram 3 min no pote porque o agente estava em tools NATIVAS, que
 * nenhuma carona alcança; entregues no meio de um resultado de tool, o modelo
 * tentou SEIS tools — todas recusadas pela dívida — antes de escrever a
 * primeira linha, às 21:38:45. OITO minutos entre a fala e a resposta. A sonda
 * e o transcript já tinham nomeado a causa: a posição da mensagem. Dentro de um
 * resultado de tool ela é a que o modelo menos respeita; a que ele obedece é a
 * ÚLTIMA mensagem de usuário de um TURNO NOVO — que é exatamente o que este
 * texto é.
 *
 * Três coisas obrigatórias, e nenhuma decorativa:
 *  1. ele foi PARADO (senão a interrupção vira mistério e ele retoma o que
 *     fazia como se nada tivesse acontecido);
 *  2. ONDE ele estava — a tool em voo foi cortada e NÃO terminou, então
 *     confiar no resultado dela seria trabalhar sobre um fato que não existe;
 *     sem tool em voo o envelope diz "pensando" e não inventa corte nenhum;
 *  3. a ORDEM: responder PRIMEIRO, em 1–2 linhas, e só então retomar — a
 *     metade que a persona sozinha não segurou em 23/08 nem em 01/09.
 */
export function guiOwnerHandText(
  entries: readonly GuiOwnerMailEntry[],
  lastStep: string | null
): string {
  const texts = entries.map((entry) => entry.text.trim()).filter((text) => text.length > 0)
  if (texts.length === 0) return ''
  const head =
    texts.length === 1
      ? `${GUI_OWNER_MAIL_TAG} — você foi PARADO para lê-la.`
      : `${GUI_OWNER_MAIL_TAG} — ${texts.length} mensagens, na ordem em que ele falou; você foi PARADO para lê-las.`
  const body =
    texts.length === 1
      ? `"${texts[0] ?? ''}"`
      : texts.map((text, index) => `${index + 1}. "${text}"`).join('\n')
  const step = lastStep?.trim()
    ? `Você estava em: ${lastStep.trim()}. A tool em voo NÃO terminou — re-cheque antes de confiar no que ela ia devolver.`
    : 'Você estava em: pensando (nenhuma tool em voo).'
  const tail =
    'Responda PRIMEIRO, em 1–2 linhas, o que você entendeu e o que muda; depois retome de onde estava, ' +
    'complementando o que já tinha feito. Não recomece do zero e não troque de assunto.'
  return [head, body, step, tail].join('\n')
}

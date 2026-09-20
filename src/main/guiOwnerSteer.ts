/**
 * A RÉGUA DA FALA DO DONO (R39 + R39.1, designs vinculantes
 * `.synkora/reports/DESIGN_FALA_DO_DONO_PARA_O_TURNO_2026-09-02.md` e
 * `.synkora/reports/DESIGN_FALA_DO_DONO_SEM_PARAR_R39_1_2026-09-02.md`).
 *
 * A VIRADA DA R39.1 (02/09, à tarde, depois de o dono ver bônus e ônus da R39):
 * *"pode ser sem parar, puro. Aí minha mensagem vai ficar lá. Só que eu quero
 * que tenha alguma coisa, tipo que ela não foi lida ainda… E se eu quiser eu
 * posso forçar, aí forçando ele para o turno e lê o que eu quero falar, quando
 * for algo urgente."* Cortar SEMPRE custava caro (raciocínio e tool em voo
 * jogados fora) para resolver um problema de POSIÇÃO — e a frota, que era o
 * medo dele, nunca esteve em risco (D1.c). Então o padrão virou STEER, com
 * RECIBO DE LEITURA sondado, e o corte virou GESTO.
 *
 * Ordem do dono (02/09): *"toda mensagem que eu enviar, independente de onde o
 * Claude estiver, se ele estiver pensando, o que ele estiver fazendo, ele vai
 * parar, vai ler o que eu falei e vai complementar com o que ele tava fazendo"*.
 *
 * O QUE FOI MEDIDO (missão 86a05c06/d13f0a00, 01/09 21:30–21:40, caixa-preta +
 * transcrição do pane): três falas dele entraram no pote enquanto o agente
 * estava em `AskUserQuestion`/`Bash`/`Skill` — tools NATIVAS, que não carregam
 * o correio — e só pegaram carona 3 min depois, num `delegate`. Entregues
 * DENTRO do turno, o modelo (fable xhigh, 451k de contexto, 40–90s por passo)
 * tentou `helper_send`×3, `delegate`×2 e `helpers_status`, todas recusadas pela
 * dívida de resposta, e só escreveu texto às 21:38:45: OITO minutos entre a
 * primeira fala e a primeira resposta.
 *
 * A causa não é entrega — é POSIÇÃO. No meio de um resultado de tool a fala do
 * dono é a mensagem que o modelo menos respeita; a que ele obedece de forma
 * confiável é a ÚLTIMA mensagem de usuário de um TURNO NOVO. Daí a decisão D1:
 * a fala PARA o turno (só o do CLI — a frota é do ■) e volta como turno novo,
 * com o envelope de retomada (`guiOwnerHandText`).
 *
 * Este módulo é PURO de propósito: o `guiSessions.ts` já passa de 3707 linhas, e
 * a régua desta rota — mais o rastreio do último passo que o envelope nomeia —
 * tem de caber num teste de mesa, sem electron, sem sessão e sem CLI. O
 * registro só COSTURA: pergunta a rota, executa e carimba.
 */
import { GUI_OWNER_MAIL_MAX_CHARS } from './guiOwnerMail'

/**
 * As rotas possíveis de uma fala do dono. `hold` não estava nomeada no cardápio
 * do design (que lista quatro), mas o próprio D5 a descreve em prosa: com
 * permissão ou plano em aberto o CLI está PARADO esperando o dono, e ali não há
 * turno para cortar — a fala espera no pote e sai no fecho, como hoje.
 */
export type GuiOwnerSteerRoute =
  /** Comando do CLI: quem executa é o binário (cerca R31.2). */
  | 'slash-queue'
  /** Pergunta aberta: o texto do dono VIRA a resposta livre (D5). */
  | 'answer-question'
  /** Pedido parado esperando o dono: guardar e entregar no fecho (D5). */
  | 'hold'
  /**
   * R39.1 D1' — O PADRÃO com turno vivo: a fala vai AGORA ao CLI (steer) e uma
   * cópia durável espera o RECIBO DE LEITURA. Nada é cortado.
   */
  | 'steer'
  /** Turno aberto + gesto "ler agora": parar o turno (D1 virou D4'). */
  | 'stop-and-hand'
  /** O caminho de sempre: direto ao CLI. */
  | 'stdin'

/**
 * O que está PENDURADO no pane esperando o dono. `question` só entra aqui
 * quando o CLI aceita RESPOSTA LIVRE — provado no claude (ver o cabeçalho de
 * `ownerSteerPlan`); permissão e plano são allow/deny e nunca aceitam texto.
 */
export interface GuiOwnerPendingInteraction {
  kind: 'question' | 'permission' | 'plan-review'
  requestId: string
  /** O texto da pergunta que a fala do dono vai responder (só em `question`). */
  question?: string
}

export interface GuiOwnerSteerInput {
  /** Sessão viva? Morta não tem turno a parar nem pergunta a responder. */
  alive: boolean
  turnActive: boolean
  /** A mensagem começa com `/` (comando do CLI). */
  isSlash: boolean
  /** O contrato da missão ainda não foi entregue — ele viaja como PROMPT. */
  hasPendingBriefing: boolean
  /** O pedido em aberto no anel deste pane, se houver. */
  pendingInteraction: GuiOwnerPendingInteraction | null
  text: string
  /**
   * R39.1 D4' — o GESTO "ler agora". Só ele volta a PARAR o turno; o composer
   * nunca o liga, porque o padrão do dono passou a ser sem parar.
   */
  force?: boolean
}

export interface GuiOwnerSteerPlan {
  route: GuiOwnerSteerRoute
  /** Por que esta rota — é o que vai ao diário e o que uma sessão futura lê. */
  reason: string
  /** Só em `answer-question`: qual pedido a fala responde. */
  requestId?: string
  /** Só em `answer-question`: a pergunta que recebe o texto do dono. */
  question?: string
}

/**
 * A DECISÃO, em uma passada e sem estado. A ordem das cercas é a ordem em que
 * elas mandam:
 *
 *  1. sessão morta — quem chama já tem recusa/renascimento melhor;
 *  2. SLASH (R31.2) — comando tem de ser EXECUTADO pelo binário; citá-lo dentro
 *     de um envelope faria o dono ver a bolha e nada acontecer;
 *  3. BRIEFING pendente — o contrato da missão é prompt, não citação, e ele só
 *     existe antes da primeira fala do dono;
 *  4. PERGUNTA aberta (D5) — o CLI está parado esperando: o texto dele É a
 *     resposta. Que o claude aceita RESPOSTA LIVRE está provado em produção:
 *     o card do chat já manda texto do campo "outra resposta" pelo mesmo
 *     `answers` (GuiQuestionCard.buildAnswers → answerQuestion → updatedInput),
 *     e as transcrições dos seats trazem 15 pares em que a resposta não é
 *     nenhum `label` e o CLI devolve, sem erro, "The user answered: … Read the
 *     answers carefully — they may request clarification, changes, or that you
 *     not proceed — and follow what they actually say";
 *  5. PERMISSÃO/PLANO abertos — allow/deny não têm onde caber texto, e
 *     interromper um CLI parado arriscaria a escalada de 10s derrubar o
 *     processo por nada: a fala espera no pote (comportamento de hoje);
 *  6. FALA GRANDE DEMAIS para o pote — steerar sem ter onde guardar a cópia
 *     deixaria a fala sem cinto; ela segue pelo caminho de sempre;
 *  7. TURNO ABERTO (R39.1 D1') — STEER: a fala vai AGORA ao CLI e a cópia
 *     espera o recibo. Com o gesto "ler agora" (`force`), e SÓ com ele, a rota
 *     volta a ser a da R39: parar o turno e entregar como turno novo;
 *  8. resto — o caminho de sempre.
 */
export function ownerSteerPlan(input: GuiOwnerSteerInput): GuiOwnerSteerPlan {
  if (!input.alive) return { route: 'stdin', reason: 'sessao-morta' }
  if (input.isSlash) return { route: 'slash-queue', reason: 'comando-do-cli' }
  if (input.hasPendingBriefing) return { route: 'stdin', reason: 'briefing-pendente' }
  const pending = input.pendingInteraction
  // Pergunta SEM texto legível (input do AskUserQuestion fora do molde) não vira
  // resposta: sem a chave certa em `answers` o CLI receberia uma resposta a uma
  // pergunta que ele não fez. Ela cai no ramo de pedido parado, e a fala espera.
  if (pending?.kind === 'question' && pending.question?.trim()) {
    return {
      route: 'answer-question',
      reason: 'pergunta-aberta',
      requestId: pending.requestId,
      ...(pending.question ? { question: pending.question } : {})
    }
  }
  if (pending) return { route: 'hold', reason: `pedido-parado:${pending.kind}` }
  if (input.text.length > GUI_OWNER_MAIL_MAX_CHARS) {
    return { route: 'stdin', reason: 'fala-grande-demais' }
  }
  if (input.turnActive) {
    return input.force === true
      ? { route: 'stop-and-hand', reason: 'turno-aberto-forcado' }
      : { route: 'steer', reason: 'turno-aberto' }
  }
  return { route: 'stdin', reason: 'sem-turno' }
}

/** Teto do pedaço do input que entra no envelope. Curto por obrigação: ele
 *  viaja num turno que o dono já está pagando (40–90s o passo, no caso medido). */
export const GUI_OWNER_STEP_INPUT_CHARS = 60

/** Uma linha só, sem quebras: o envelope é lido de relance. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * O RÓTULO DO PASSO: `<tool> — <começo do input>`. O input vem do evento do
 * pump (já orçado por `limitGuiToolInput`) e entra CAPADO — o que o modelo
 * precisa é reconhecer o que ficou pela metade, não reler o argumento inteiro.
 */
export function guiOwnerStepLabel(name: string, input: unknown): string {
  const tool = oneLine(String(name || 'tool')).slice(0, 40)
  let raw = ''
  try {
    raw = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input) ?? ''
  } catch {
    // Input impossível de serializar (ciclo, getter que estoura) não pode
    // derrubar a entrega: o nome da tool sozinho já orienta a re-checagem.
    raw = ''
  }
  const detail = oneLine(raw)
  if (!detail) return tool
  return detail.length > GUI_OWNER_STEP_INPUT_CHARS
    ? `${tool} — ${detail.slice(0, GUI_OWNER_STEP_INPUT_CHARS)}…`
    : `${tool} — ${detail}`
}

interface GuiOwnerPaneStep {
  label: string
  /** Quantas tools deste pane ainda não devolveram. */
  inFlight: number
}

/** Uma fala que JÁ FOI ao CLI e ainda não tem recibo de leitura (R39.1 D1'). */
export interface GuiOwnerSteeredNote {
  messageId: string
  /** Quando ela saiu — é este relógio que vira o `msSinceSend` do diário. */
  at: number
}

/**
 * O RASTREIO POR PANE — o que o envelope precisa saber e o motor não guarda.
 *
 * Duas cargas, o mesmo dono (o pane), e as duas curtas de vida:
 *  - o ÚLTIMO PASSO: só vale enquanto a tool está EM VOO. Depois que ela
 *    devolveu, dizer que ela foi cortada seria mentir para o modelo — o
 *    rastreio devolve `null` e o envelope diz "pensando".
 *  - os ids ENTREGUES: as bolhas que esperam o carimbo "respondida" (D6); o
 *    primeiro texto do assistente as quita, no mesmo lugar onde a dívida quita.
 */
export class GuiOwnerStepTracker {
  private readonly steps = new Map<string, GuiOwnerPaneStep>()
  private readonly delivered = new Map<string, string[]>()
  /** R39.1 D2' — as falas steeradas que ainda esperam o RECIBO DE LEITURA. */
  private readonly steered = new Map<string, GuiOwnerSteeredNote[]>()
  /** Falas forçadas; o gesto não comprova leitura pelo motor. */
  private readonly forced = new Map<string, Set<string>>()

  /** O pump viu uma tool COMEÇAR. */
  noteTool(paneId: string, name: string, input: unknown): void {
    if (!paneId) return
    const current = this.steps.get(paneId)
    this.steps.set(paneId, {
      label: guiOwnerStepLabel(name, input),
      inFlight: (current?.inFlight ?? 0) + 1
    })
  }

  /** O pump viu uma tool VOLTAR. */
  noteToolResult(paneId: string): void {
    const current = this.steps.get(paneId)
    if (!current) return
    this.steps.set(paneId, { ...current, inFlight: Math.max(0, current.inFlight - 1) })
  }

  /** O pump viu o modelo PENSANDO — só informa quando não há tool nenhuma em
   *  voo; com tool aberta, o que foi cortado continua sendo a tool. */
  noteThinking(paneId: string): void {
    const current = this.steps.get(paneId)
    if (current && current.inFlight > 0) return
    this.steps.delete(paneId)
  }

  /** O turno acabou: o passo dele morre com ele. */
  noteResult(paneId: string): void {
    this.steps.delete(paneId)
  }

  /** O passo cortado, ou `null` (= "pensando", no envelope). */
  lastStepOf(paneId: string): string | null {
    const current = this.steps.get(paneId)
    return current && current.inFlight > 0 ? current.label : null
  }

  /** Estas bolhas foram ENTREGUES e esperam a resposta do agente (D6). */
  noteDelivered(paneId: string, messageIds: readonly string[]): void {
    if (!paneId || messageIds.length === 0) return
    this.delivered.set(paneId, [...(this.delivered.get(paneId) ?? []), ...messageIds])
  }

  /** O agente falou: leva os ids pendentes e esvazia — a mesma entrega nunca
   *  vira duas respostas. */
  takeDelivered(paneId: string): string[] {
    const ids = this.delivered.get(paneId)
    if (!ids || ids.length === 0) return []
    this.delivered.delete(paneId)
    return ids
  }

  /**
   * R39.1 D1' — a fala FOI ao CLI e espera o recibo. `at` é o instante do envio:
   * é a única coisa que o recibo não traz e o diário precisa (`msSinceSend`).
   */
  noteSteered(paneId: string, messageId: string, at: number): void {
    if (!paneId || !messageId) return
    const pending = this.steered.get(paneId) ?? []
    if (pending.some((note) => note.messageId === messageId)) return
    pending.push({ messageId, at })
    this.steered.set(paneId, pending)
  }

  /** As falas deste pane que ainda não foram lidas — é o que a bolha `unread`
   *  espelha e o que o "ler agora" pode forçar. */
  pendingSteered(paneId: string): readonly GuiOwnerSteeredNote[] {
    return this.steered.get(paneId) ?? []
  }

  /**
   * O RECIBO. Com `messageId` (o eco sondado), leva só aquela fala; sem ele (a
   * aproximação), leva TODAS as que estavam esperando — a fronteira que a
   * aproximação observa absorve o pote inteiro do CLI de uma vez.
   *
   * Levar é consumir: o mesmo recibo nunca arma a dívida duas vezes.
   */
  takeRead(paneId: string, messageId?: string): GuiOwnerSteeredNote[] {
    const pending = this.steered.get(paneId)
    if (!pending || pending.length === 0) return []
    if (messageId === undefined) {
      this.steered.delete(paneId)
      return pending
    }
    const at = pending.findIndex((note) => note.messageId === messageId)
    if (at < 0) return []
    const [taken] = pending.splice(at, 1)
    if (pending.length === 0) this.steered.delete(paneId)
    return taken ? [taken] : []
  }

  /** O dono forçou esta fala; a entrega ainda depende do reconciliador. */
  noteForced(paneId: string, messageId: string): void {
    if (!paneId || !messageId) return
    const ids = this.forced.get(paneId) ?? new Set<string>()
    ids.add(messageId)
    this.forced.set(paneId, ids)
  }

  /** Esta entrega nasceu de um "ler agora"? Consome a marca junto. */
  takeForced(paneId: string, messageId: string): boolean {
    const ids = this.forced.get(paneId)
    if (!ids?.delete(messageId)) return false
    if (ids.size === 0) this.forced.delete(paneId)
    return true
  }

  /** A conversa acabou de vez. */
  forget(paneId: string): void {
    this.steps.delete(paneId)
    this.delivered.delete(paneId)
    this.steered.delete(paneId)
    this.forced.delete(paneId)
  }
}

/**
 * O CARIMBO DA BOLHA (D6) — evento SINTÉTICO do harness, não do CLI.
 *
 * Ele não entra na união `SessionEvent` (que é o vocabulário dos MOTORES) pelo
 * mesmo motivo do `history-pruned`: quem o emite é o registro. O anel e o IPC
 * carregam `unknown`, então ele viaja pelo mesmo cano, entra no replay da
 * remontagem e o renderer o espelha em `guiApi.ts`.
 */
export type GuiOwnerMessageState =
  | 'cancelled'
  /** R39.1 D1' — foi ao CLI e AINDA NÃO FOI LIDA (o estado com AÇÃO: "ler agora"). */
  | 'unread'
  /** O corte do "ler agora" saiu; a confirmação do CLI ainda não voltou. */
  | 'stopping'
  /** R39.1 D2' — o RECIBO chegou: o CLI absorveu a fala e ele passou a dever resposta. */
  | 'read'
  /** A entrega pelo pote (fecho de turno, renascimento, resposta de pergunta). */
  | 'delivered'
  /** O agente falou depois de ler: a dívida está paga. */
  | 'answered'

/** O SINAL do recibo — sondado (`echo`) ou aproximado. O diário nunca finge
 *  medição: um CLI sem eco produz `approx`, e quem ler o diário sabe disso. */
export type GuiOwnerReadSignal = 'echo' | 'approx'

export interface GuiOwnerMessageStateEvent {
  type: 'owner-message-state'
  /** O id da bolha VOCÊ no fio. */
  id: string
  state: GuiOwnerMessageState
  at: number
}

export function isGuiOwnerMessageStateEvent(value: unknown): value is GuiOwnerMessageStateEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return event['type'] === 'owner-message-state' && typeof event['id'] === 'string' &&
    event['id'].length > 0 && event['id'].length <= 256 &&
    typeof event['at'] === 'number' && Number.isFinite(event['at']) &&
    typeof event['state'] === 'string' &&
    ['unread', 'stopping', 'read', 'delivered', 'answered', 'cancelled'].includes(event['state'])
}

export function guiOwnerMessageStateEvent(
  id: string,
  state: GuiOwnerMessageState,
  at: number
): GuiOwnerMessageStateEvent {
  return { type: 'owner-message-state', id, state, at }
}

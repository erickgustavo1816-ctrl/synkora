import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { redactSensitiveText } from './securityRedaction'

// Hub do Synkora: o barramento central de eventos da orquestração.
// TODO evento relevante (pane aberto/fechado, tarefa criada/movida, report,
// delegate, merge…) passa por aqui e vira: (a) linha em .synkora/EVENTS.md,
// (b) evento hub:event para a UI, (c) mensagem digitada no pane do MAESTRO
// quando ele está ocioso — é assim que o orquestrador "sabe de tudo, sempre".

/**
 * `gui-planner` (2.0, onda D) é o forasteiro desta lista: ele identifica um
 * CHAT (pane GUI de missão de planejamento), não um pane de terminal. A
 * identidade existe só para AUTENTICAR e ESCOPAR as tools de plano — ele nunca
 * entra na fila de injeção do hub, não recebe evento e não é destino de
 * notify_pane. Ver `guiPlannerMcp.ts`.
 */
export type HubPaneRole =
  | 'maestro'
  | 'dev'
  | 'review'
  | 'qa'
  | 'ajudante'
  | 'livre'
  | 'gui-planner'
export type HubCommunicationKind = 'message' | 'delegate' | 'report' | 'feedback' | 'handoff'

/** Entrega causal entre dois panes. Diferente de HubEvent, este evento só
 * existe depois que a mensagem entrou de fato no terminal de destino. */
export interface HubCommunicationEvent {
  id: string
  ts: string
  projectId: string
  missionId?: string
  taskId?: string
  sourcePaneId: string
  targetPaneId: string
  kind: HubCommunicationKind
}

export interface PaneIdentity {
  paneId: string
  projectId: string
  role: HubPaneRole
  taskId?: string
  phase?: 'dev' | 'review' | 'qa'
  cwd: string
  seatId?: string
  /** quem pediu este ajudante (recebe o aviso de conclusão) */
  delegatorPaneId?: string
  /** missão do pane (orquestrador da missão ou pane de tarefa da missão) */
  missionId?: string
}

export interface HubEvent {
  ts: string
  projectId: string
  kind:
    | 'pane-open'
    | 'pane-close'
    | 'task-created'
    | 'task-updated'
    | 'report'
    | 'delegate'
    | 'merge'
    | 'image'
    | 'error'
    | 'info'
  text: string
  /** quem causou (maestro/dev/review/qa/ajudante/harness/user) */
  actor?: string
  /** evento de MISSÃO: vai para o orquestrador dela, não para o PM */
  missionId?: string
  /** silencioso: registra em EVENTS.md + UI, mas NÃO injeta em pane nenhum
   *  (rotina que o usuário mesmo causou — o PM não precisa tagarelar) */
  quiet?: boolean
  /** URGENTE: um agente está ESPERANDO por isto (aprovação/pausa de plano) —
   *  tenta injetar AGORA, furando a cadência do drain; cai na fila se o pane
   *  não estiver quieto. */
  urgent?: boolean
}

export interface HubDeps {
  projectPathOf: (projectId: string) => string | undefined
  /** Guarda central: nenhuma escrita/limpeza do runtime pode tocar .synkora
   *  quando o projeto já versiona esse diretório. */
  ensureProjectRuntimeWritable: (projectPath: string) => void
  /** paneId do orquestrador certo: da missão (se viva) ou o PM do projeto */
  maestroPaneOf: (projectId: string, missionId?: string) => string | undefined
  /** Agenda a digitação e confirma em `onSubmitted` somente depois que o
   *  Enter foi escrito no mesmo PTY que recebeu o texto. O boolean continua
   *  indicando apenas se a injeção foi aceita para manter a API síncrona. */
  inject: (paneId: string, text: string, onSubmitted: (submitted: boolean) => void) => boolean
  /** o HUMANO está com texto pendente/digitando neste pane? (único caso em
   *  que injetar corrompe — ver PtyManager.composerBusy) */
  composerBusy: (paneId: string) => boolean
  /** o pane ainda existe? fila de pane morto é DESCARTADA na hora — nunca
   *  fica girando nem entrega em silêncio (paneId morre com o pane) */
  alive: (paneId: string) => boolean
  /** CORREIO MCP (F5-F2): o pane tem caixa postal (identidade MCP)? Quando
   *  tem, o payload NUNCA passa pelo teclado — vai direto para a mailbox,
   *  IMEDIATO por desenho: composer/inFlight/gap são guardas de TECLADO e
   *  não se aplicam a correio (ordem do dono: "conversa extremamente
   *  rápida"). */
  hasMailbox?: (paneId: string) => boolean
  /** Posta o payload na caixa do pane. Retorna false se o pane perdeu a
   *  identidade entre o hasMailbox e o post (corrida rara) — a entrega cai
   *  no caminho clássico. O nudge curto de teclado é responsabilidade do
   *  adapter (auditado, e só ele respeita o composer). */
  deliverToMailbox?: (paneId: string, line: string, meta: HubNotificationOptions) => boolean
  onEvent: (evt: HubEvent) => void
  /** caixa-preta: desfecho REAL de cada entrega de mensagem a um pane —
   *  'injected' chegou ao terminal pelo TECLADO; 'mailboxed' entrou na caixa
   *  postal MCP (nada foi digitado além do nudge); 'dead' o pane não
   *  existia; 'discarded' a fila morreu antes da injeção. (O enfileiramento
   *  em si não é desfecho.) */
  onDelivery?: (
    paneId: string,
    status: 'injected' | 'mailboxed' | 'dead' | 'discarded',
    line: string,
    meta: Pick<HubNotificationOptions, 'sourcePaneId' | 'kind' | 'correlationId'>
  ) => void
}

export interface HubPublishOptions {
  /** Pane que já consumiu o evento por outro caminho e não deve ser acordado. */
  excludePaneId?: string
  /** Identificador usado para cancelar uma entrega ainda não injetada. */
  notificationKey?: string
  /** Metadados causais opcionais. Só publicações originadas por um pane real
   * devem preenchê-los; avisos produzidos pelo harness ficam sem origem. */
  sourcePaneId?: string
  communicationKind?: HubCommunicationKind
  correlationId?: string
  /** Reavaliada no instante da injeção (ver HubNotificationOptions). */
  stillNeeded?: () => boolean
}

export interface HubNotificationOptions {
  key?: string
  onSettled?: (delivered: boolean) => void
  /** Origem estruturada da mensagem. Quando presente, uma entrega real pode
   *  virar pulso direcional no mapa sem interpretar texto livre. */
  sourcePaneId?: string
  kind?: HubCommunicationKind
  correlationId?: string
  /** Guarda de ÚLTIMA HORA: reavaliada quando o drain vai injetar. `false` =
   *  o destino já consumiu a informação por outro caminho (ex.: leu o
   *  helper_output depois do report) — a entrega é descartada em vez de
   *  digitar de novo um resultado que o pane já conhece. Exceção nunca
   *  bloqueia a entrega. */
  stillNeeded?: () => boolean
}

interface QueuedNotification extends HubNotificationOptions {
  line: string
}

// INJEÇÃO INSTANTÂNEA (decisão do usuário, 2026-07-29 — sondado em PTY real
// nos dois CLIs): pane OCUPADO enfileira sozinho — o claude mostra a mensagem
// pendente e a auto-submete ao fim do turno; o codex mostra "Messages to be
// submitted after next tool call" e a steera para dentro do turno. Zero
// corrupção medida. A ÚNICA espera que sobrou é o composer sujo do humano.
// O gap entre injeções no MESMO pane cobre o fatiamento da anterior
// (160 chars/24ms + Enter 300ms) — duas injeções entrelaçadas se misturariam.
const INJECT_GAP_MS = 1500
const DRAIN_MS = 300
const MAX_QUEUE = 30
// EVENTS.md é JANELA OPERACIONAL, não história (decisão do usuário): a
// memória durável do projeto é o CONTEXT.md (o Maestro consolida a cada
// integração) + os PLANs de missão. Janela curta = leve, sem lixo.
const EVENTS_MAX_LINES = 300
const EVENTS_KEEP_LINES = 150

export class Hub {
  private readonly deps: HubDeps
  private byToken = new Map<string, PaneIdentity>()
  private byPane = new Map<string, PaneIdentity>()
  /** mensagens pendentes de injeção, por paneId de destino */
  private queues = new Map<string, QueuedNotification[]>()
  private lastInject = new Map<string, number>()
  /** Uma injeção fatiada por pane. Sem esta trava, duas sequências de
   *  chunks podem se intercalar antes de qualquer uma escrever o Enter. */
  private inFlight = new Set<string>()
  private appendCount = 0
  private timer: NodeJS.Timeout

  constructor(deps: HubDeps) {
    this.deps = deps
    this.timer = setInterval(() => this.drain(), DRAIN_MS)
  }

  dispose(): void {
    clearInterval(this.timer)
    for (const paneId of this.queues.keys()) this.dropQueue(paneId)
  }

  registerPane(token: string, identity: PaneIdentity): void {
    this.byToken.set(token, identity)
    this.byPane.set(identity.paneId, identity)
  }

  /** Lápides de panes mortos: paneId → identidade. notify_pane usa para
   *  reendereçar um id velho ao pane VIVO do mesmo card+papel (paneIds morrem
   *  em minutos — 3 ids para o mesmo dev em 4min no caso real de 05/08). */
  private tombstones = new Map<string, PaneIdentity>()

  tombstoneOf(paneId: string): PaneIdentity | undefined {
    return this.tombstones.get(paneId)
  }

  unregisterPane(paneId: string): PaneIdentity | undefined {
    const identity = this.byPane.get(paneId)
    if (identity) {
      this.tombstones.set(paneId, identity)
      if (this.tombstones.size > 300) {
        const oldest = this.tombstones.keys().next().value
        if (oldest !== undefined) this.tombstones.delete(oldest)
      }
      this.byPane.delete(paneId)
      for (const [token, id] of this.byToken) {
        if (id.paneId === paneId) this.byToken.delete(token)
      }
    }
    this.dropQueue(paneId)
    return identity
  }

  identityByToken(token: string): PaneIdentity | undefined {
    return this.byToken.get(token)
  }

  identityByPane(paneId: string): PaneIdentity | undefined {
    return this.byPane.get(paneId)
  }

  panesOf(projectId: string): PaneIdentity[] {
    return [...this.byPane.values()].filter((p) => p.projectId === projectId)
  }

  /** Publica um evento: EVENTS.md + UI + fila do Maestro do projeto. */
  publish(evt: Omit<HubEvent, 'ts'>, options: HubPublishOptions = {}): void {
    const full: HubEvent = {
      ...evt,
      text: redactSensitiveText(evt.text),
      ts: new Date().toISOString()
    }
    this.appendEventsFile(full)
    try {
      this.deps.onEvent(full)
    } catch {
      // UI é best-effort
    }
    // O orquestrador certo é informado de tudo — menos do que ele mesmo
    // acabou de fazer: evento de missão → orquestrador da missão (fallback
    // PM se o pane dela morreu); evento de projeto → PM.
    if (full.actor !== 'maestro' && !full.quiet) {
      const maestroPane = this.deps.maestroPaneOf(full.projectId, full.missionId)
      if (maestroPane && maestroPane !== options.excludePaneId) {
        const line = `${full.kind}: ${full.text}`
        const deliveryOptions: HubNotificationOptions = {
          key: options.notificationKey,
          sourcePaneId: options.sourcePaneId,
          kind: options.communicationKind,
          correlationId: options.correlationId,
          stillNeeded: options.stillNeeded
        }
        if (full.urgent) this.notifyPaneNow(maestroPane, line, deliveryOptions)
        // CORREIO (F5-F2): o orquestrador tem identidade — o evento vai
        // direto para a caixa dele; a fila do drain sobra para pane clássico.
        else if (!this.tryMailbox(maestroPane, line, deliveryOptions))
          this.enqueue(maestroPane, line, deliveryOptions)
      }
    }
  }

  /** CORREIO MCP (F5-F2): pane com identidade recebe o payload na caixa
   *  postal AGORA — sem composer, sem inFlight, sem gap (guardas de teclado
   *  não se aplicam a correio; o nudge do adapter é quem respeita o
   *  composer). Retorna undefined quando o pane não tem correio (a entrega
   *  segue pelo caminho clássico do teclado). */
  private tryMailbox(
    paneId: string,
    line: string,
    options: HubNotificationOptions
  ): 'mailboxed' | 'discarded' | undefined {
    if (!this.deps.hasMailbox?.(paneId) || !this.deps.deliverToMailbox) return undefined
    if (!this.isStillNeeded(options)) {
      // o destino já consumiu por outro caminho — mesmo desfecho do drain
      this.settle(options, false)
      this.reportDelivery(paneId, 'discarded', line, options)
      return 'discarded'
    }
    if (!this.deps.deliverToMailbox(paneId, line, options)) return undefined
    this.settle(options, true)
    this.reportDelivery(paneId, 'mailboxed', line, options)
    return 'mailboxed'
  }

  /** Aviso direto a um pane específico (ex.: delegador quando o ajudante conclui). */
  notifyPane(
    paneId: string,
    text: string,
    options: HubNotificationOptions = {}
  ): 'queued' | 'mailboxed' | 'discarded' | 'dead' {
    text = redactSensitiveText(text)
    if (!this.deps.alive(paneId)) {
      this.settle(options, false)
      this.reportDelivery(paneId, 'dead', text, options)
      return 'dead'
    }
    const mailed = this.tryMailbox(paneId, text, options)
    if (mailed) return mailed
    this.enqueue(paneId, text, options)
    return 'queued'
  }

  /** Remove avisos identificados que ainda não chegaram ao TUI. */
  cancelPaneNotification(paneId: string, key: string): number {
    const queue = this.queues.get(paneId)
    if (!queue) return 0
    const removed = queue.filter((entry) => entry.key === key)
    if (removed.length === 0) return 0
    const kept = queue.filter((entry) => entry.key !== key)
    if (kept.length === 0) this.queues.delete(paneId)
    else this.queues.set(paneId, kept)
    for (const entry of removed) this.settle(entry, false)
    return removed.length
  }

  /** Aviso direto IMEDIATO: injeta AGORA — pane ocupado enfileira no próprio
   *  TUI (sondado; ver o bloco INJEÇÃO INSTANTÂNEA). Só espera quando o
   *  humano está com texto pendente no composer, ou quando outra injeção
   *  fatiada ainda está em curso neste pane. */
  notifyPaneNow(
    paneId: string,
    text: string,
    options: HubNotificationOptions = {}
  ): 'injected' | 'mailboxed' | 'queued' | 'discarded' | 'dead' {
    text = redactSensitiveText(text)
    if (!this.deps.alive(paneId)) {
      this.reportDelivery(paneId, 'dead', text, options)
      return 'dead'
    }
    const mailed = this.tryMailbox(paneId, text, options)
    if (mailed) return mailed
    const last = this.lastInject.get(paneId) ?? 0
    if (
      !this.deps.composerBusy(paneId) &&
      !this.inFlight.has(paneId) &&
      Date.now() - last >= INJECT_GAP_MS &&
      this.beginInjection(paneId, `[synkora] ${text}`, (submitted) => {
        if (submitted) this.reportDelivery(paneId, 'injected', text, options)
        else this.reportDelivery(paneId, 'discarded', text, options)
      })
    ) {
      return 'injected'
    }
    this.enqueue(paneId, text, options)
    return 'queued'
  }

  /** Missão integrada/excluída: os eventos dela viraram lixo operacional —
   *  as linhas somem do EVENTS.md (a história consolidada vive no CONTEXT.md
   *  e no PLAN da missão). */
  purgeMissionEvents(projectId: string, missionId: string): void {
    const projectPath = this.deps.projectPathOf(projectId)
    if (!projectPath) return
    try {
      this.deps.ensureProjectRuntimeWritable(projectPath)
      const file = join(projectPath, '.synkora', 'EVENTS.md')
      const tag = `[missão ${missionId.slice(0, 8)}]`
      const lines = readFileSync(file, 'utf-8').split('\n')
      const kept = lines.filter((l) => !l.includes(tag))
      if (kept.length !== lines.length) writeFileSync(file, kept.join('\n'), 'utf-8')
    } catch {
      // sem arquivo de eventos ainda
    }
  }

  private enqueue(
    paneId: string,
    line: string,
    options: HubNotificationOptions = {}
  ): void {
    const q = this.queues.get(paneId) ?? []
    if (options.key) {
      // A publicação global e o aviso direto podem apontar para o mesmo
      // orquestrador. A chave transforma os dois caminhos em uma única linha,
      // mantendo a versão direta (mais útil) que chegou por último.
      const duplicateIndex = q.findIndex((entry) => entry.key === options.key)
      if (duplicateIndex >= 0) {
        const [replaced] = q.splice(duplicateIndex, 1)
        this.settle(replaced, false)
      }
    }
    q.push({ line, ...options })
    if (q.length > MAX_QUEUE) {
      const dropped = q.splice(0, q.length - MAX_QUEUE)
      for (const entry of dropped) this.settle(entry, false)
    }
    this.queues.set(paneId, q)
  }

  private settle(entry: HubNotificationOptions, delivered: boolean): void {
    try {
      entry.onSettled?.(delivered)
    } catch {
      // callback de ciclo de vida é best-effort
    }
  }

  private isStillNeeded(entry: HubNotificationOptions): boolean {
    try {
      return entry.stillNeeded?.() !== false
    } catch {
      // a guarda nunca bloqueia a entrega
      return true
    }
  }

  private dropQueue(paneId: string): void {
    const queue = this.queues.get(paneId)
    this.queues.delete(paneId)
    if (!queue) return
    for (const entry of queue) {
      this.settle(entry, false)
      this.reportDelivery(paneId, 'discarded', entry.line, entry)
    }
  }

  private reportDelivery(
    paneId: string,
    status: 'injected' | 'mailboxed' | 'dead' | 'discarded',
    line: string,
    meta: HubNotificationOptions = {}
  ): void {
    try {
      this.deps.onDelivery?.(paneId, status, line, meta)
    } catch {
      // observador é best-effort
    }
  }

  /** Inicia uma única sequência de chunks e só libera o pane depois da
   *  confirmação do write do Enter. */
  private beginInjection(
    paneId: string,
    text: string,
    onSubmitted: (submitted: boolean) => void
  ): boolean {
    if (this.inFlight.has(paneId)) return false
    this.inFlight.add(paneId)
    let completed = false
    const complete = (submitted: boolean): void => {
      if (completed) return
      completed = true
      this.inFlight.delete(paneId)
      if (submitted) this.lastInject.set(paneId, Date.now())
      onSubmitted(submitted)
    }
    const accepted = this.deps.inject(paneId, text, complete)
    if (!accepted) this.inFlight.delete(paneId)
    // Compatibilidade com adaptadores legados/simulados cujo booleano ainda
    // significa "write concluído" e que, por contrato, recebem só 2 args.
    // O adapter real do PTY declara 3 args e sempre confirma pelo callback.
    else if (this.deps.inject.length < 3) complete(true)
    return accepted
  }

  // Drain rápido (300ms): a fila daqui só existe enquanto o HUMANO está com
  // texto pendente naquele pane ou uma injeção anterior ainda está sendo
  // fatiada — TUI ocupado NÃO segura mais nada (a fila de input do próprio
  // CLI enfileira e entrega; sondado em PTY real 2026-07-29).
  private drain(): void {
    for (const [paneId, q] of this.queues) {
      if (q.length === 0) continue
      if (!this.deps.alive(paneId)) {
        // pane morreu com fila pendente — descarta JÁ (girar aqui era o
        // caminho da mensagem sumir em silêncio; caso real 2026-07-30)
        this.dropQueue(paneId)
        continue
      }
      if (this.deps.composerBusy(paneId)) continue
      if (this.inFlight.has(paneId)) continue
      const last = this.lastInject.get(paneId) ?? 0
      if (Date.now() - last < INJECT_GAP_MS) continue
      const drained = q.splice(0, 3)
      const batch: QueuedNotification[] = []
      for (const entry of drained) {
        if (this.isStillNeeded(entry)) batch.push(entry)
        else {
          // o destino já consumiu por outro caminho (helper_output pós-report)
          this.settle(entry, false)
          this.reportDelivery(paneId, 'discarded', entry.line, entry)
        }
      }
      if (batch.length === 0) {
        if (q.length === 0) this.queues.delete(paneId)
        continue
      }
      const text =
        batch.length === 1
          ? `[synkora] ${batch[0].line}`
          : `[synkora] ${batch.length} eventos: ${batch.map((entry) => entry.line).join(' · ')}`
      if (
        this.beginInjection(paneId, text, (submitted) => {
          for (const entry of batch) {
            this.settle(entry, submitted)
            this.reportDelivery(
              paneId,
              submitted ? 'injected' : 'discarded',
              entry.line,
              entry
            )
          }
          if (!submitted) this.dropQueue(paneId)
        })
      ) {
        if (q.length === 0) this.queues.delete(paneId)
      } else {
        // pane morreu — descarta a fila
        for (const entry of batch) {
          this.settle(entry, false)
          this.reportDelivery(paneId, 'discarded', entry.line, entry)
        }
        this.dropQueue(paneId)
      }
    }
  }

  private appendEventsFile(evt: HubEvent): void {
    const projectPath = this.deps.projectPathOf(evt.projectId)
    if (!projectPath) return
    try {
      this.deps.ensureProjectRuntimeWritable(projectPath)
      const dir = join(projectPath, '.synkora')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'EVENTS.md')
      appendFileSync(
        file,
        `- ${evt.ts} [${evt.kind}]${evt.missionId ? ` [missão ${evt.missionId.slice(0, 8)}]` : ''}${evt.actor ? ` (${evt.actor})` : ''} ${evt.text.replace(/\s+/g, ' ').trim()}\n`,
        'utf-8'
      )
      // rotação barata: de tempos em tempos, mantém só o rabo do arquivo
      if (++this.appendCount % 200 === 0) {
        const lines = readFileSync(file, 'utf-8').split('\n')
        if (lines.length > EVENTS_MAX_LINES) {
          writeFileSync(file, lines.slice(-EVENTS_KEEP_LINES).join('\n'), 'utf-8')
        }
      }
    } catch {
      // eventos em arquivo são best-effort
    }
  }
}

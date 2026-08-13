/**
 * MOTOR DO PANE GUI (Synkora 2.0, onda A — docs/GUI_PANE_CONTRACT.md).
 *
 * Onde nascia um xterm com o CLI dentro, nasce um CHAT: o motor é o que já
 * existe no repo — MaestroSession (claude, stream-json) e CodexSession (codex,
 * app-server) — só que instanciado POR PANE, num Map. Aqui não há nada de
 * terminal: o registro spawna, guarda os eventos num anel para a remontagem
 * poder replayar, e empurra cada evento ao renderer.
 *
 * REGRAS QUE VALEM COMO CONTRATO:
 * - Uma sessão por paneId. `matches()` das classes NUNCA é usado para
 *   reaproveitar sessão entre panes — a chave é o paneId e ponto.
 * - Pane GUI roda com `idleTimeoutMs: 0`: chat aberto não morre por tédio.
 * - Persona do claude vai por ARQUIVO (--append-system-prompt-file): argv tem
 *   teto de 32767 chars no Windows (caso 02/08). No codex ela é
 *   developerInstructions do thread/start, então viaja como string.
 * - `paneId → {sessionId, cli}` é persistido para o resume pós-boot; a morte
 *   do pane NÃO apaga o registro (retomar é decisão de quem reabre).
 * - Higiene de env (deletar os marcadores CLAUDE_CODE_ e CLAUDECODE herdados)
 *   já é feita dentro das classes de sessão — nada a repetir aqui.
 */
import { CodexSession } from './codexSession'
import { MaestroSession, type SessionEvent } from './maestroSession'
import { loadJsonStore, persistJsonStore } from './jsonStore'

// ————— tipos do contrato (fonte única — o renderer copia VERBATIM) —————

export interface GuiPaneSpawn {
  paneId: string
  projectId: string
  cli: 'claude' | 'codex'
  /** Config dir isolado do seat (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  configDir: string
  /** Worktree da missão (ou raiz do projeto no planejamento). */
  cwd: string
  model?: string
  effort?: string
  /** Persona/contrato curto (claude: append-system-prompt; codex: developerInstructions). */
  systemPrompt?: string
  /** Retomar conversa existente (claude sessionId / codex thread id). */
  resumeSessionId?: string
  /** Primeiro turno injetado logo após o spawn (ex.: conteúdo do plano da missão). */
  firstPrompt?: string
}

export type GuiPermBehavior = 'allow' | 'allow-always' | 'deny'

/** Evento vivo empurrado ao renderer. `evt` é o SessionEvent dos backends
 *  (maestroSession.ts — kinds: init, delta, thinking, text, tool, tool-result,
 *  permission, permission-cancel, session-id, ready, command-output, limit,
 *  result, fatal, closed). */
export interface GuiLivePayload { paneId: string; evt: unknown /* SessionEvent */ }

/** Resposta padrão dos canais gui:* — `error` em PT-BR, é texto de UI. */
export interface GuiResult {
  ok: boolean
  error?: string
}

// ————— anel de eventos (replay da remontagem) —————

export const GUI_RING_CAP = 500

/**
 * Buffer circular por pane. O renderer remonta (troca de aba, reload da view)
 * e pede `gui:state` — sem isto a conversa nasceria vazia com a sessão viva.
 * Cap por CONTAGEM: evento de tool grande é raro e já vem truncado pelas
 * classes de sessão (firstLines).
 */
export class GuiEventRing {
  private items: unknown[] = []
  private readonly cap: number

  constructor(cap: number = GUI_RING_CAP) {
    this.cap = cap > 0 ? cap : GUI_RING_CAP
  }

  push(evt: unknown): void {
    this.items.push(evt)
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap)
  }

  get size(): number {
    return this.items.length
  }

  snapshot(): unknown[] {
    return this.items.slice()
  }

  clear(): void {
    this.items = []
  }
}

// ————— documento de resume (userData/gui-sessions.json) —————

export interface GuiSessionRecord {
  sessionId: string
  cli: 'claude' | 'codex'
  projectId: string
  updatedAt: string
}

interface GuiSessionsDoc {
  panes: Record<string, GuiSessionRecord>
}

function emptyDoc(): GuiSessionsDoc {
  return { panes: {} }
}

function isDoc(value: unknown): value is GuiSessionsDoc {
  if (!value || typeof value !== 'object') return false
  const panes = (value as GuiSessionsDoc).panes
  return Boolean(panes) && typeof panes === 'object'
}

// ————— registro —————

type GuiBackend = MaestroSession | CodexSession

interface GuiPaneEntry {
  spawn: GuiPaneSpawn
  /** Identidade do SPAWN: mudou = processo novo; igual = remontagem reusa. */
  fingerprint: string
  session: GuiBackend
  ring: GuiEventRing
  /** Guarda de geração: o `dispose` apaga a chama e o sink da sessão MORTA
   *  cala na hora — evento atrasado nunca fala pelo pane que a substituiu. */
  token: { alive: boolean }
}

export interface GuiSessionDeps {
  /** Empurra o evento vivo ao renderer (ctx.pushAll no canal `gui:live`). */
  push(payload: GuiLivePayload): void
  /** Materializa a persona do claude em arquivo; undefined = falhou. */
  systemPromptFile(name: string, content: string): string | undefined
  /** userData/gui-sessions.json — ausente desliga a persistência (testes). */
  storeFile?: string
  /** Caixa-preta opcional. */
  record?(
    event: string,
    ids: { paneId: string; projectId?: string },
    detail?: Record<string, unknown>
  ): void
}

/** Espera do handshake antes de soltar o firstPrompt (waitCaps resolve antes
 *  disso no caminho feliz; o teto só existe para o CLI que não responde). */
const READY_TIMEOUT_MS = 20_000

export class GuiSessionRegistry {
  private readonly deps: GuiSessionDeps
  private readonly panes = new Map<string, GuiPaneEntry>()
  private doc: GuiSessionsDoc

  constructor(deps: GuiSessionDeps) {
    this.deps = deps
    this.doc = deps.storeFile
      ? loadJsonStore<GuiSessionsDoc>(deps.storeFile, emptyDoc, isDoc)
      : emptyDoc()
  }

  /** Sessão do pane (undefined = nunca criada ou já encerrada). */
  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  /** Conversa gravada para este pane — a chave do resume pós-boot. */
  remembered(paneId: string): GuiSessionRecord | undefined {
    return this.doc.panes[paneId]
  }

  create(spawn: GuiPaneSpawn): GuiResult {
    if (!spawn.paneId) return { ok: false, error: 'pane sem identificador' }
    if (!spawn.cwd) return { ok: false, error: 'pane sem pasta de trabalho' }
    if (spawn.cli !== 'claude' && spawn.cli !== 'codex') {
      return { ok: false, error: `CLI desconhecido: ${String(spawn.cli)}` }
    }

    const fingerprint = spawnFingerprint(spawn)
    const current = this.panes.get(spawn.paneId)
    if (current) {
      // Remontagem do MESMO pane (troca de aba, reload da view): sessão viva e
      // idêntica se reusa — matar aqui jogaria a conversa fora. O replay vem
      // do anel via gui:state.
      if (current.session.alive && current.fingerprint === fingerprint) return { ok: true }
      this.dispose(spawn.paneId, 'respawn')
    }

    const ring = new GuiEventRing()
    // Vale já DURANTE o construtor da sessão (um 'fatal' síncrono é captado
    // antes de a entrada existir no Map).
    const token = { alive: true }
    const sink = (evt: SessionEvent): void => {
      // Sessão substituída/encerrada: o sink da anterior morre calado — nunca
      // fala pelo pane novo nem re-suja o anel dele.
      if (!token.alive) return
      ring.push(evt)
      this.deps.push({ paneId: spawn.paneId, evt })
      if (evt.type === 'init' || evt.type === 'session-id') this.remember(spawn, evt.sessionId)
    }

    let session: GuiBackend
    try {
      session = this.spawnSession(spawn, sink)
    } catch (error) {
      token.alive = false
      const text = error instanceof Error ? error.message : String(error)
      this.deps.record?.(
        'gui-session-spawn-failed',
        { paneId: spawn.paneId, projectId: spawn.projectId },
        { cli: spawn.cli, err: text }
      )
      return { ok: false, error: `não consegui abrir a sessão: ${text}` }
    }

    this.panes.set(spawn.paneId, { spawn, fingerprint, session, ring, token })
    this.deps.record?.(
      'gui-session-created',
      { paneId: spawn.paneId, projectId: spawn.projectId },
      { cli: spawn.cli, resumed: Boolean(spawn.resumeSessionId) }
    )

    if (spawn.firstPrompt?.trim()) this.sendFirstPrompt(spawn.paneId, token, spawn.firstPrompt)
    return { ok: true }
  }

  send(paneId: string, text: string): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    if (!entry.session.alive) return { ok: false, error: 'a sessão deste pane encerrou' }
    // Turno durante turno é problema RESOLVIDO dos backends (claude enfileira,
    // codex faz steer) — o motor não tem fila própria.
    entry.session.send(text)
    return { ok: true }
  }

  permission(paneId: string, requestId: string, behavior: GuiPermBehavior): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    const answered = entry.session.answerPermission(requestId, behavior)
    if (!answered) return { ok: false, error: 'este pedido de permissão não está mais pendente' }
    return { ok: true }
  }

  interrupt(paneId: string): GuiResult {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'este pane não tem sessão aberta' }
    entry.session.interrupt()
    return { ok: true }
  }

  kill(paneId: string): GuiResult {
    if (!this.panes.has(paneId)) return { ok: true }
    this.dispose(paneId, 'kill')
    return { ok: true }
  }

  /** Replay da remontagem: o que o pane perdeu enquanto estava desmontado. */
  state(paneId: string): { events: unknown[] } {
    return { events: this.panes.get(paneId)?.ring.snapshot() ?? [] }
  }

  /** Encerramento do app: nenhum CLI filho sobrevive ao quit. */
  killAll(): void {
    for (const paneId of [...this.panes.keys()]) this.dispose(paneId, 'quit')
  }

  // ————— internos —————

  private spawnSession(spawn: GuiPaneSpawn, sink: (evt: SessionEvent) => void): GuiBackend {
    const persona = spawn.systemPrompt?.trim() ?? ''
    const opts = {
      cwd: spawn.cwd,
      configDir: spawn.configDir || undefined,
      model: spawn.model,
      effort: spawn.effort,
      // Chat aberto não morre por tédio (contrato do pane GUI).
      idleTimeoutMs: 0
    }
    if (spawn.cli === 'codex') {
      // O id do thread é gravado com prefixo próprio pelo evento session-id —
      // o thread/resume quer o uuid cru.
      const threadId = spawn.resumeSessionId?.startsWith('codex-thread:')
        ? spawn.resumeSessionId.slice('codex-thread:'.length)
        : spawn.resumeSessionId
      return new CodexSession({ ...opts, resumeSessionId: threadId }, persona, sink)
    }
    // claude: persona ao nível de SISTEMA e por arquivo (teto de argv).
    const file = persona
      ? this.deps.systemPromptFile(`gui-${spawn.paneId}.system.md`, persona)
      : undefined
    return new MaestroSession(
      { ...opts, resumeSessionId: spawn.resumeSessionId, systemPromptFile: file },
      sink
    )
  }

  /**
   * O primeiro turno só sai com o CLI PRONTO. `waitCaps` é o sinal real do
   * handshake nos dois backends (e resolve na morte do processo também), com
   * teto próprio — o firstPrompt nunca fica preso esperando um CLI mudo.
   */
  private sendFirstPrompt(paneId: string, token: { alive: boolean }, prompt: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return
    void entry.session
      .waitCaps(READY_TIMEOUT_MS)
      .then(() => {
        if (!token.alive || !entry.session.alive) return
        entry.session.send(prompt)
      })
      .catch(() => {
        // waitCaps não rejeita; o catch existe só para nunca virar rejeição solta.
      })
  }

  private dispose(paneId: string, reason: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return
    this.panes.delete(paneId)
    entry.token.alive = false
    entry.ring.clear()
    try {
      entry.session.kill()
    } catch {
      // processo já morto — encerrar nunca derruba o app
    }
    this.deps.record?.(
      'gui-session-closed',
      { paneId, projectId: entry.spawn.projectId },
      { reason }
    )
  }

  /** Grava a conversa do pane para o resume pós-boot (nunca apaga no kill). */
  private remember(spawn: GuiPaneSpawn, sessionId: string): void {
    if (!sessionId) return
    const previous = this.doc.panes[spawn.paneId]
    if (previous?.sessionId === sessionId && previous.cli === spawn.cli) return
    this.doc.panes[spawn.paneId] = {
      sessionId,
      cli: spawn.cli,
      projectId: spawn.projectId,
      updatedAt: new Date().toISOString()
    }
    if (!this.deps.storeFile) return
    try {
      persistJsonStore(this.deps.storeFile, this.doc)
    } catch {
      // O resume é conveniência; falha de disco não derruba a conversa viva.
    }
  }
}

/** Identidade do spawn: o que só muda com processo novo. */
function spawnFingerprint(spawn: GuiPaneSpawn): string {
  return [
    spawn.cli,
    spawn.cwd,
    spawn.configDir,
    spawn.model ?? '',
    spawn.effort ?? '',
    spawn.resumeSessionId ?? '',
    spawn.systemPrompt ?? ''
  ].join(' ')
}

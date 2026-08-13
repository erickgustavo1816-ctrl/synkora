// Ponte tipada do PANE GUI (Synkora 2.0, onda A).
//
// O contrato vive em docs/GUI_PANE_CONTRACT.md e tem duas metades: o agente
// MOTOR é dono de main/ + preload (namespace `window.synkora.gui`), o agente
// PANE é dono do renderer. Este arquivo é a ÚNICA costura entre os dois lados
// no renderer: nenhum componente fala com `window.synkora.gui` direto.
//
// Enquanto as duas frentes não mesclam, o preload deste worktree ainda não
// declara `gui` — por isso o acesso passa por um cast estreito, resolvido a
// cada chamada (o namespace pode nascer depois deste módulo ser importado).
// Quando o preload publicar os tipos, basta trocar `bridge()` por
// `window.synkora.gui`; nada fora daqui muda.

// ————— tipos do contrato (cópia VERBATIM — fonte única dos dois lados) —————

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
export interface GuiLivePayload {
  paneId: string
  evt: unknown /* SessionEvent */
}

// ————— espelho do SessionEvent do main —————
// O contrato entrega `evt` como `unknown` de propósito (o main é dono da
// união). O renderer precisa lê-lo, então mantém um ESPELHO estreito: campos
// desconhecidos são ignorados, e um kind novo nunca quebra a UI (cai no
// default do redutor). `thinking.text` é o campo ADITIVO previsto no contrato.

export interface GuiCliCommand {
  name: string
  description: string
  argumentHint?: string
}

export interface GuiCliModel {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

export interface GuiCliCaps {
  commands: GuiCliCommand[]
  models: GuiCliModel[]
  account?: { email?: string; subscriptionType?: string }
}

export type GuiSessionEvent =
  | {
      type: 'init'
      model: string
      sessionId: string
      permissionMode: string
      toolCount: number
      contextWindow?: number
    }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text?: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; text: string; isError: boolean }
  | {
      type: 'permission'
      requestId: string
      toolName: string
      description: string
      inputPretty: string
      reason?: string
      canAlways: boolean
    }
  | { type: 'permission-cancel'; requestId: string }
  | { type: 'session-id'; sessionId: string }
  | { type: 'ready'; caps: GuiCliCaps }
  | { type: 'command-output'; text: string }
  | { type: 'limit'; text: string }
  | {
      type: 'result'
      isError: boolean
      errorText?: string
      resultText?: string
      contextTokens?: number
      contextWindow?: number
      fastModeState?: string
      costUsd?: number
    }
  | { type: 'fatal'; text: string }
  | { type: 'closed'; code: number | null }

/** Só o que tem `type` string entra no redutor — payload torto do canal nunca
 *  vira exceção dentro de um `set` do zustand. */
export function asGuiEvent(evt: unknown): GuiSessionEvent | null {
  if (!evt || typeof evt !== 'object') return null
  const type = (evt as { type?: unknown }).type
  return typeof type === 'string' ? (evt as GuiSessionEvent) : null
}

// ————— acesso ao namespace do preload —————

interface GuiBridge {
  create: (spawn: GuiPaneSpawn) => Promise<{ ok: boolean; error?: string }>
  send: (paneId: string, text: string) => Promise<{ ok: boolean }>
  permission: (
    paneId: string,
    requestId: string,
    behavior: GuiPermBehavior
  ) => Promise<{ ok: boolean }>
  interrupt: (paneId: string) => Promise<{ ok: boolean }>
  kill: (paneId: string) => Promise<{ ok: boolean }>
  state: (paneId: string) => Promise<{ events: unknown[] }>
  onLive: (cb: (payload: GuiLivePayload) => void) => () => void
}

function bridge(): Partial<GuiBridge> | undefined {
  return (window as unknown as { synkora?: { gui?: Partial<GuiBridge> } }).synkora?.gui
}

const NO_BRIDGE = 'a ponte do pane GUI ainda não está disponível nesta janela'

export const guiApi = {
  /** false = preload sem o namespace `gui` (devMock/browser puro, ou motor
   *  ainda não mesclado). A UI mostra o aviso em vez de fingir que funcionou. */
  available(): boolean {
    return typeof bridge()?.create === 'function'
  },

  async create(spawn: GuiPaneSpawn): Promise<{ ok: boolean; error?: string }> {
    const api = bridge()
    if (!api?.create) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.create(spawn)) ?? { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  async send(paneId: string, text: string): Promise<{ ok: boolean }> {
    const api = bridge()
    if (!api?.send) return { ok: false }
    try {
      return (await api.send(paneId, text)) ?? { ok: true }
    } catch {
      return { ok: false }
    }
  },

  async permission(
    paneId: string,
    requestId: string,
    behavior: GuiPermBehavior
  ): Promise<{ ok: boolean }> {
    const api = bridge()
    if (!api?.permission) return { ok: false }
    try {
      return (await api.permission(paneId, requestId, behavior)) ?? { ok: true }
    } catch {
      return { ok: false }
    }
  },

  async interrupt(paneId: string): Promise<{ ok: boolean }> {
    const api = bridge()
    if (!api?.interrupt) return { ok: false }
    try {
      return (await api.interrupt(paneId)) ?? { ok: true }
    } catch {
      return { ok: false }
    }
  },

  async kill(paneId: string): Promise<{ ok: boolean }> {
    const api = bridge()
    if (!api?.kill) return { ok: false }
    try {
      return (await api.kill(paneId)) ?? { ok: true }
    } catch {
      return { ok: false }
    }
  },

  /** Replay para remontagem: o main guarda um ring buffer (~500 eventos) por
   *  pane. Devolve a lista já filtrada pelo espelho de tipos. */
  async state(paneId: string): Promise<GuiSessionEvent[]> {
    const api = bridge()
    if (!api?.state) return []
    try {
      const res = await api.state(paneId)
      const events = Array.isArray(res?.events) ? res.events : []
      return events.map(asGuiEvent).filter((e): e is GuiSessionEvent => e !== null)
    } catch {
      return []
    }
  },

  /** Assina o canal `gui:live`. Devolve unsubscribe (no-op sem ponte). */
  onLive(cb: (payload: GuiLivePayload) => void): () => void {
    const api = bridge()
    if (!api?.onLive) return () => undefined
    try {
      return api.onLive(cb) ?? (() => undefined)
    } catch {
      return () => undefined
    }
  }
}

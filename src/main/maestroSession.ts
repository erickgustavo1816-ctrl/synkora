import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { freshWindowsPath } from './winPath'

// Sessão PERSISTENTE do Maestro: um processo `claude` vivo em stream-json
// bidirecional — o mesmo motor do TUI, rodando como "painel de fundo".
// O chat estruturado do board é só um espelho bonito dos eventos daqui:
// texto ao vivo, ferramentas com input real, pedidos de permissão do CLI
// (via --permission-prompt-tool stdio) respondidos pelo usuário na UI.

export interface MaestroSessionOpts {
  cwd: string
  configDir?: string
  resumeSessionId?: string
  model?: string
  effort?: string
  /** codex: política de aprovação (untrusted | on-request | never), override por turno */
  approvalPolicy?: string
  /** claude: fast mode via settings {"fastMode":true} — o /fast do TUI headless */
  fastMode?: boolean
  /** codex: SandboxMode do thread/start (ex.: 'read-only' para o /estudar) */
  sandbox?: string
  /** claude: --permission-mode (ex.: 'acceptEdits' nos executores de tarefa) */
  permissionMode?: string
}

// Capacidades REAIS do CLI, vindas do handshake `initialize`: a mesma lista
// de comandos e de modelos que o TUI mostra — nada curado na mão.
export interface CliCommand {
  name: string
  description: string
  argumentHint?: string
}

export interface CliModel {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

export interface CliCaps {
  commands: CliCommand[]
  models: CliModel[]
  account?: { email?: string; subscriptionType?: string }
}

export type SessionEvent =
  | {
      type: 'init'
      model: string
      sessionId: string
      permissionMode: string
      toolCount: number
      contextWindow?: number
    }
  | { type: 'delta'; text: string }
  | { type: 'thinking' }
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
  | { type: 'ready'; caps: CliCaps }
  | { type: 'command-output'; text: string }
  | { type: 'limit'; text: string }
  | {
      type: 'result'
      isError: boolean
      errorText?: string
      contextTokens?: number
      contextWindow?: number
      fastModeState?: string
      costUsd?: number
    }
  | { type: 'fatal'; text: string }
  | { type: 'closed'; code: number | null }

export type PermissionChoice = 'allow' | 'allow-always' | 'deny'

interface PendingPermission {
  toolName: string
  description: string
  input: Record<string, unknown>
  suggestions: unknown[]
}

interface StreamLine {
  type?: string
  subtype?: string
  request_id?: string
  fast_mode_state?: string
  total_cost_usd?: number
  response?: {
    subtype?: string
    request_id?: string
    error?: string
    response?: {
      commands?: CliCommand[]
      models?: CliModel[]
      account?: { email?: string; subscriptionType?: string }
    }
  }
  model?: string
  session_id?: string
  permissionMode?: string
  tools?: string[]
  result?: string
  is_error?: boolean
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  rate_limit_info?: { status?: string; resetsAt?: number }
  request?: {
    subtype?: string
    tool_name?: string
    display_name?: string
    description?: string
    input?: Record<string, unknown>
    permission_suggestions?: unknown[]
    decision_reason?: string
  }
  event?: {
    type?: string
    delta?: { type?: string; text?: string }
  }
  message?: {
    role?: string
    content?:
      | string
      | {
          type?: string
          text?: string
          name?: string
          input?: Record<string, unknown>
          content?: unknown
          is_error?: boolean
        }[]
  }
  tool_use_result?: { stdout?: string; stderr?: string }
}

const IDLE_TIMEOUT = 600_000 // 10 min sem NENHUM evento (permissão pendente pausa)
const DETAIL_MAX = 2000
const RESULT_MAX = 400

function firstLines(text: string, max: number): string {
  const clean = text.trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max) + '…'
}

export class MaestroSession {
  readonly opts: MaestroSessionOpts
  personaSent = false
  readyAnnounced = false
  fastWarned = false
  caps: CliCaps | null = null
  private child: ChildProcessWithoutNullStreams
  private emit: (evt: SessionEvent) => void
  private buffer = ''
  private stderrTail = ''
  private announced = false
  private killed = false
  private idleTimer: NodeJS.Timeout | null = null
  private pending = new Map<string, PendingPermission>()
  private initReqId = randomUUID()
  private capsWaiters: ((caps: CliCaps | null) => void)[] = []
  private controlWaiters = new Map<string, (ok: boolean) => void>

  constructor(opts: MaestroSessionOpts, emit: (evt: SessionEvent) => void) {
    this.opts = opts
    this.emit = emit

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath()
    }
    if (opts.configDir) env['CLAUDE_CONFIG_DIR'] = opts.configDir

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      // Permissões chegam como control_request na stream e o usuário decide
      // na UI — nada de auto-negar escondido.
      '--permission-prompt-tool',
      'stdio'
    ]
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
    if (opts.fastMode) {
      // O comando /fast é bloqueado em modo SDK, mas a CHAVE de settings liga
      // o fast mode de verdade (validado: result.fast_mode_state=on). Com
      // shell no Windows, o JSON precisa da camada extra de aspas.
      const settings = JSON.stringify({ fastMode: true })
      args.push('--settings', process.platform === 'win32' ? JSON.stringify(settings) : settings)
    }

    // claude é shim .cmd no Windows — precisa de shell.
    this.child = spawn('claude', args, {
      cwd: opts.cwd,
      env,
      shell: process.platform === 'win32'
    })

    this.child.stdout.on('data', (d: Buffer) => {
      this.buffer += d.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) this.handleLine(line)
      this.resetIdle()
    })
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-1000)
    })
    this.child.on('error', (e) => {
      this.clearIdle()
      this.emit({ type: 'fatal', text: e.message })
    })
    // Handshake: a resposta traz comandos, modelos e conta REAIS do CLI.
    this.write({
      type: 'control_request',
      request_id: this.initReqId,
      request: { subtype: 'initialize' }
    })

    this.child.on('close', (code) => {
      this.clearIdle()
      if (this.buffer) this.handleLine(this.buffer)
      for (const w of this.capsWaiters.splice(0)) w(this.caps)
      if (!this.killed) {
        const err = this.stderrTail.trim()
        this.emit({
          type: 'fatal',
          text: `o painel de fundo encerrou (exit ${code})${err ? ` · ${firstLines(err, 300)}` : ''}`
        })
      }
      this.emit({ type: 'closed', code })
    })
  }

  get alive(): boolean {
    return !this.killed && this.child.exitCode === null
  }

  /** Mesmo destino de spawn? (mudar seat/modelo/effort/fast exige processo novo) */
  matches(opts: MaestroSessionOpts): boolean {
    return (
      this.opts.cwd === opts.cwd &&
      (this.opts.configDir ?? '') === (opts.configDir ?? '') &&
      (this.opts.model ?? '') === (opts.model ?? '') &&
      (this.opts.effort ?? '') === (opts.effort ?? '') &&
      Boolean(this.opts.fastMode) === Boolean(opts.fastMode)
    )
  }

  send(text: string): void {
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    })
    this.resetIdle()
  }

  /** Responde um pedido de permissão pendente; devolve o que foi decidido para logar. */
  answerPermission(
    requestId: string,
    choice: PermissionChoice
  ): { toolName: string; description: string } | null {
    const req = this.pending.get(requestId)
    if (!req) return null
    this.pending.delete(requestId)
    const response =
      choice === 'deny'
        ? { behavior: 'deny', message: 'negado pelo usuário no painel do Maestro' }
        : {
            behavior: 'allow',
            updatedInput: req.input,
            ...(choice === 'allow-always' && req.suggestions.length > 0
              ? { updatedPermissions: req.suggestions }
              : {})
          }
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })
    this.resetIdle()
    return { toolName: req.toolName, description: req.description }
  }

  interrupt(): void {
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' }
    })
  }

  /** Espera o handshake initialize responder (caps reais do CLI). */
  waitCaps(timeoutMs = 10_000): Promise<CliCaps | null> {
    if (this.caps) return Promise.resolve(this.caps)
    if (!this.alive) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.caps), timeoutMs)
      this.capsWaiters.push((caps) => {
        clearTimeout(timer)
        resolve(caps)
      })
    })
  }

  /** Troca de modelo AO VIVO via protocolo de controle (sem matar a sessão). */
  setModel(model: string): Promise<boolean> {
    if (!this.alive) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(id)
        resolve(false)
      }, 10_000)
      this.controlWaiters.set(id, (ok) => {
        clearTimeout(timer)
        if (ok) this.opts.model = model === 'default' ? undefined : model
        resolve(ok)
      })
      this.write({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'set_model', model }
      })
    })
  }

  kill(): void {
    this.killed = true
    this.clearIdle()
    try {
      this.child.stdin.end()
    } catch {
      // stdin já fechado
    }
    this.child.kill()
  }

  private write(obj: unknown): void {
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n')
    } catch (e) {
      this.emit({ type: 'fatal', text: e instanceof Error ? e.message : String(e) })
    }
  }

  private resetIdle(): void {
    this.clearIdle()
    // Permissão pendente = esperando o HUMANO, não o CLI. Sem timeout.
    if (this.pending.size > 0) return
    this.idleTimer = setTimeout(() => {
      this.emit({ type: 'fatal', text: 'sem resposta do CLI há 10 min — sessão encerrada' })
      this.kill()
    }, IDLE_TIMEOUT)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let evt: StreamLine
    try {
      evt = JSON.parse(line) as StreamLine
    } catch {
      return // linha parcial/não-JSON
    }

    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init' && evt.session_id) {
          // init repete a cada turno — anuncia uma vez por processo, mas o
          // session_id sobe sempre (resume pode trocar o id).
          const model = evt.model ?? 'claude'
          this.emit({
            type: 'init',
            model,
            sessionId: evt.session_id,
            permissionMode: evt.permissionMode ?? 'default',
            toolCount: evt.tools?.length ?? 0,
            // O sufixo [1m] no id resolvido indica a janela de 1M; o resto é 200k.
            contextWindow: model.includes('[1m]') ? 1_000_000 : 200_000
          })
        }
        break

      case 'stream_event': {
        const inner = evt.event
        if (inner?.type === 'content_block_delta') {
          if (inner.delta?.type === 'text_delta' && inner.delta.text) {
            this.emit({ type: 'delta', text: inner.delta.text })
          } else if (inner.delta?.type === 'thinking_delta') {
            this.emit({ type: 'thinking' })
          }
        }
        break
      }

      case 'assistant': {
        const content = evt.message?.content
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            this.emit({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use' && block.name) {
            this.emit({ type: 'tool', name: block.name, input: block.input ?? {} })
          }
        }
        break
      }

      case 'control_response': {
        const resp = evt.response
        if (!resp?.request_id) break
        if (resp.request_id === this.initReqId) {
          if (resp.subtype === 'success' && resp.response) {
            this.caps = {
              commands: resp.response.commands ?? [],
              models: resp.response.models ?? [],
              account: resp.response.account
            }
            this.emit({ type: 'ready', caps: this.caps })
          }
          for (const w of this.capsWaiters.splice(0)) w(this.caps)
        } else {
          const waiter = this.controlWaiters.get(resp.request_id)
          if (waiter) {
            this.controlWaiters.delete(resp.request_id)
            waiter(resp.subtype === 'success')
          }
        }
        break
      }

      case 'user': {
        // Saída de comando local (/model via controle, etc.) vem como user
        // com content string "<local-command-stdout>…</local-command-stdout>".
        const content = evt.message?.content
        if (typeof content === 'string') {
          const m = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
          if (m && m[1].trim()) {
            this.emit({ type: 'command-output', text: firstLines(m[1], 600) })
          }
          break
        }
        // Resultado de ferramenta volta como mensagem user com tool_result.
        if (!Array.isArray(content)) break
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const r = evt.tool_use_result
          const raw =
            r?.stdout || r?.stderr
              ? [r.stdout, r.stderr].filter(Boolean).join('\n')
              : typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as { text?: string }[])
                      .map((c) => c.text ?? '')
                      .join('\n')
                  : ''
          if (raw.trim()) {
            this.emit({
              type: 'tool-result',
              text: firstLines(raw, RESULT_MAX),
              isError: Boolean(block.is_error)
            })
          }
        }
        break
      }

      case 'control_request': {
        const req = evt.request
        if (req?.subtype === 'can_use_tool' && evt.request_id && req.tool_name) {
          const suggestions = req.permission_suggestions ?? []
          this.pending.set(evt.request_id, {
            toolName: req.display_name ?? req.tool_name,
            description: req.description ?? '',
            input: req.input ?? {},
            suggestions
          })
          this.clearIdle() // esperando o humano
          this.emit({
            type: 'permission',
            requestId: evt.request_id,
            toolName: req.display_name ?? req.tool_name,
            description: req.description ?? '',
            inputPretty: firstLines(JSON.stringify(req.input ?? {}, null, 2), DETAIL_MAX),
            reason: req.decision_reason,
            canAlways: suggestions.length > 0
          })
        }
        break
      }

      case 'control_cancel_request':
        if (evt.request_id && this.pending.delete(evt.request_id)) {
          this.emit({ type: 'permission-cancel', requestId: evt.request_id })
          this.resetIdle()
        }
        break

      case 'rate_limit_event': {
        const info = evt.rate_limit_info
        if (info && info.status && info.status !== 'allowed') {
          const resets = info.resetsAt
            ? ` · libera ${new Date(info.resetsAt * 1000).toLocaleTimeString('pt-BR')}`
            : ''
          this.emit({ type: 'limit', text: `rate limit do plano atingido (${info.status})${resets}` })
        }
        break
      }

      case 'result': {
        const u = evt.usage
        const contextTokens = u
          ? (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.output_tokens ?? 0)
          : undefined
        if (evt.session_id) {
          // resume/fork pode mudar o id — o result é a palavra final do turno.
          this.emit({ type: 'session-id', sessionId: evt.session_id })
        }
        this.emit({
          type: 'result',
          isError: Boolean(evt.is_error),
          errorText: evt.is_error ? (evt.result ?? 'erro sem detalhe') : undefined,
          contextTokens,
          fastModeState: evt.fast_mode_state,
          costUsd: evt.total_cost_usd
        })
        break
      }
    }
  }

  /** Uma vez por processo: o wrapper usa para anunciar "sessão aberta" só no 1º init. */
  announceOnce(): boolean {
    if (this.announced) return false
    this.announced = true
    return true
  }
}

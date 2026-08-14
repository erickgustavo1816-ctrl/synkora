import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { freshWindowsPath } from './winPath'
import type { GuiAttachmentDescriptor } from './guiAttachments'
import { guiToolResultDetails } from './guiToolResults'
import {
  GuiProtocolStream,
  isGuiClaudeProtocolEnvelope,
  parseGuiProtocolLine
} from './guiProtocolLine'
import { limitGuiToolInput } from './guiToolInput'
import { terminateGuiProcessTree } from './guiProcessTree'
import {
  advanceGuiTurn,
  enqueueGuiTurn,
  GUI_ACTIVE_TURN_SILENCE_TIMEOUT,
  shouldArmGuiTurnWatchdog
} from './guiTurnQueue'
import {
  chatPermissionRuleLabel,
  resolveChatPermissionSuggestions
} from './chatPermissions'

// Sessão PERSISTENTE do Maestro: um processo `claude` vivo em stream-json
// bidirecional — o mesmo motor do TUI, rodando como "painel de fundo".
// O chat estruturado do board é só um espelho bonito dos eventos daqui:
// texto ao vivo, ferramentas com input real, pedidos de permissão do CLI
// (via --permission-prompt-tool stdio) respondidos pelo usuário na UI.

export interface MaestroSessionOpts {
  cwd: string
  configDir?: string
  /** Claude: trusted persona/policy injected above the user turn. */
  systemPromptFile?: string
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
  /** Teto de silêncio do CLI antes de encerrar a sessão. Ausente = os 10 min
   *  de sempre (todo chamador existente); 0 DESLIGA o relógio — é o que o pane
   *  GUI usa: chat aberto não morre por tédio (docs/GUI_PANE_CONTRACT.md). */
  idleTimeoutMs?: number
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

// ————— pergunta estruturada (AskUserQuestion → card de opções no chat GUI) —————
// Formas FIXADAS no contrato 2.0 (Anexo A do CONTRATO_CHAT_2_0) — o renderer
// copia VERBATIM. O input chega no can_use_tool e a resposta viaja no
// updatedInput do MESMO control_response da permissão.

export interface GuiQuestionOption {
  label: string
  description?: string
}

export interface GuiQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: GuiQuestionOption[]
}

export const GUI_QUESTION_MAX_COUNT = 8
export const GUI_QUESTION_OPTION_MAX_COUNT = 12
export const GUI_PLAN_MAX_CHARS = 64 * 1024

function boundedGuiText(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length <= cap ? value : value.slice(0, Math.max(0, cap - 1)) + '…'
}

/** Parse DEFENSIVO do input do AskUserQuestion. Qualquer coisa fora do molde
 *  devolve undefined e o pedido segue como permissão genérica — pergunta
 *  ilegível nunca some muda. */
export function parseGuiQuestions(input: Record<string, unknown>): GuiQuestion[] | undefined {
  const raw = input['questions']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const questions: GuiQuestion[] = []
  for (const item of raw.slice(0, GUI_QUESTION_MAX_COUNT)) {
    if (!item || typeof item !== 'object') return undefined
    const q = item as Record<string, unknown>
    const questionText = boundedGuiText(q['question'], 2_000)
    if (!questionText?.trim()) return undefined
    const rawOptions = q['options']
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) return undefined
    const options: GuiQuestionOption[] = []
    for (const opt of rawOptions.slice(0, GUI_QUESTION_OPTION_MAX_COUNT)) {
      if (!opt || typeof opt !== 'object') return undefined
      const o = opt as Record<string, unknown>
      const label = boundedGuiText(o['label'], 240)
      if (!label?.trim()) return undefined
      const description = boundedGuiText(o['description'], 1_000)
      options.push({
        label,
        ...(description ? { description } : {})
      })
    }
    const header = boundedGuiText(q['header'], 160)
    questions.push({
      question: questionText,
      ...(header ? { header } : {}),
      ...(typeof q['multiSelect'] === 'boolean' ? { multiSelect: q['multiSelect'] } : {}),
      options
    })
  }
  return questions
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
  /** `text` = delta do raciocínio quando o backend o entrega (aditivo: quem
   *  só acende um spinner continua funcionando sem ler o campo). */
  | { type: 'thinking'; text?: string }
  | { type: 'turn-started' }
  | { type: 'turn-continuation'; continues: boolean }
  | {
      type: 'session-restarted'
      ready: boolean
      /** Fotografia canônica já persistida para a mesma conversa. */
      contextTokens?: number | null
      contextWindow?: number | null
    }
  /** /clear explícito: zera somente o fio desta conversa no renderer. */
  | { type: 'conversation-cleared' }
  /** Estado silencioso do composer. `null` significa usar o padrão do CLI. */
  | { type: 'executor-changed'; model: string | null; effort: string | null }
  | {
      type: 'user-message'
      id: string
      text: string
      /** Anexos já validados pelo main; o transcript mostra chips, nunca paths
       * despejados dentro da fala do usuário. */
      attachments?: GuiAttachmentDescriptor[]
      at: number
    }
  | { type: 'text'; text: string }
  | {
      type: 'tool'
      name: string
      input: Record<string, unknown>
      toolUseId?: string
      /** Relação explícita do stream-json do Claude. É metadado opaco de
       *  protocolo: a apresentação nunca tenta deduzi-la pelo nome da tool. */
      parentToolUseId?: string
    }
  | {
      type: 'tool-result'
      text: string
      isError: boolean
      outcome?: 'completed' | 'failed' | 'denied' | 'cancelled'
      toolUseId?: string
      /** Metadados do output INTEIRO, calculados antes do preview capado. */
      lineCount?: number
      truncated?: boolean
    }
  | {
      type: 'permission'
      requestId: string
      toolUseId?: string
      toolName: string
      description: string
      inputPretty: string
      reason?: string
      permissionRule?: string
      canAlways: boolean
    }
  | { type: 'permission-cancel'; requestId: string }
  | {
      type: 'interaction-resolved'
      requestId: string
      resolution:
        | {
            kind: 'permission'
            toolUseId?: string
            toolName: string
            behavior: PermissionChoice
          }
        | { kind: 'question'; entries: { question: string; answer: string }[] }
        | { kind: 'plan'; approve: boolean }
        | { kind: 'stale' }
    }
  /** AskUserQuestion virou card de opções (2.0): a resposta volta por
   *  answerQuestion, no mesmo canal de control_response da permissão. */
  | { type: 'question'; requestId: string; questions: GuiQuestion[] }
  /** ExitPlanMode (modo plano): o plano em markdown para o dono aprovar
   *  (answerPlanReview) — construir = allow, revisar = deny. */
  | { type: 'plan-review'; requestId: string; plan: string }
  | { type: 'session-id'; sessionId: string }
  | { type: 'ready'; caps: CliCaps }
  | { type: 'command-output'; text: string }
  /** Medição canônica do contexto vivo; `null` significa que o backend não a informou. */
  | { type: 'context-usage'; contextTokens: number | null; contextWindow: number | null }
  | { type: 'command-completed'; isError: boolean; continues: boolean; errorText?: string }
  | { type: 'limit'; text: string }
  | {
      type: 'result'
      isError: boolean
      outcome?: 'completed' | 'failed' | 'cancelled'
      /** Outra mensagem já foi aceita pelo stream e continua trabalhando. */
      continues?: boolean
      errorText?: string
      /* texto final do turno — comandos locais (ex.: /usage) respondem por
         mensagem assistant SINTÉTICA e o texto só aparece aqui, não em
         <local-command-stdout> (sondado 2026-07-23) */
      resultText?: string
      contextTokens?: number
      contextWindow?: number
      fastModeState?: string
      costUsd?: number
    }
  | { type: 'fatal'; text: string }
  | { type: 'closed'; code: number | null }

export type PermissionChoice = 'allow' | 'allow-always' | 'deny'

interface PendingPermission {
  toolUseId?: string
  toolName: string
  description: string
  input: Record<string, unknown>
  suggestions: unknown[]
}

interface StreamLine {
  type?: string
  subtype?: string
  /** `null` é o valor normal das mensagens da raiz; filhos carregam o id da
   *  tool de delegação. O valor só atravessa a fronteira depois do narrow. */
  parent_tool_use_id?: string | null
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
    tool_use_id?: string
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
          id?: string
          tool_use_id?: string
          text?: string
          name?: string
          input?: Record<string, unknown>
          content?: unknown
          is_error?: boolean
        }[]
  }
  tool_use_result?: { stdout?: string; stderr?: string }
}

/** O stream-json mistura mensagens da conversa raiz e dos agentes filhos.
 *  Somente a raiz pode alimentar texto/animação/terminal do chat; o id do pai
 *  continua sendo propagado nas ferramentas para a lateral acompanhar o filho. */
export function guiClaudeParentToolUseId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined
}

const IDLE_TIMEOUT = 600_000 // 10 min sem NENHUM evento (permissão pendente pausa)
const INTERRUPT_CONFIRM_TIMEOUT = 10_000
const INIT_CONFIRM_TIMEOUT = 20_000
const DETAIL_MAX = 2000

function firstLines(text: string, max: number): string {
  const sliced = text.slice(0, Math.max(0, max) + 1).trim()
  return sliced.length <= max ? sliced : sliced.slice(0, max) + '…'
}

function prettyGuiInput(input: Record<string, unknown>): string {
  try {
    return firstLines(JSON.stringify(limitGuiToolInput(input), null, 2), DETAIL_MAX)
  } catch {
    return '{ pedido indisponível para visualização }'
  }
}

function toolResultEvent(
  raw: string,
  isError: boolean,
  toolUseId?: string
): Extract<SessionEvent, { type: 'tool-result' }> {
  const details = guiToolResultDetails(raw)
  return {
    type: 'tool-result',
    text: details.text,
    isError,
    outcome: isError ? 'failed' : 'completed',
    toolUseId,
    lineCount: details.lineCount,
    truncated: details.truncated
  }
}

export class MaestroSession {
  readonly opts: MaestroSessionOpts
  personaSent = false
  readyAnnounced = false
  fastWarned = false
  caps: CliCaps | null = null
  private child: ChildProcessWithoutNullStreams
  private emit: (evt: SessionEvent) => void
  private protocol = new GuiProtocolStream()
  private stderrTail = ''
  private announced = false
  private killed = false
  private closed = false
  private initTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private turnSilenceTimer: NodeJS.Timeout | null = null
  private pending = new Map<string, PendingPermission>()
  private initReqId = randomUUID()
  private capsWaiters: ((caps: CliCaps | null) => void)[] = []
  private controlWaiters = new Map<string, (ok: boolean) => void>
  private turnGeneration = 0
  private pendingTurnGenerations: number[] = []
  private activeTurnGeneration: number | null = null
  private interruptGeneration: number | null = null
  private interruptRequestId: string | null = null
  private interruptTimer: NodeJS.Timeout | null = null

  constructor(opts: MaestroSessionOpts, emit: (evt: SessionEvent) => void) {
    this.opts = opts
    this.emit = emit

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath()
    }
    // App lançado de dentro de uma sessão do Claude Code: os marcadores
    // CLAUDE_CODE_*/CLAUDECODE herdados fazem o CLI filho rodar como "child
    // session" SEM salvar transcript (sondado no 2.1.218) — o que mata o
    // --resume e a telemetria. Limpar sempre, como o pty.ts faz.
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
    }
    delete env['CLAUDECODE']
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
    if (opts.systemPromptFile)
      args.push('--append-system-prompt-file', opts.systemPromptFile)
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
      const chunk = this.protocol.push(d)
      for (const line of chunk.lines) {
        this.handleLine(line)
        if (!this.alive) return
      }
      if (chunk.overflow) {
        this.emit({ type: 'fatal', text: 'o Claude excedeu o limite de uma mensagem de protocolo' })
        this.kill()
        return
      }
      this.resetIdle()
    })
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-1000)
    })
    this.child.on('error', (e) => {
      this.closed = true
      this.clearInitGuard()
      this.clearIdle()
      this.clearTurnSilence()
      this.clearInterruptGuard()
      this.cancelPendingInteractions()
      this.pendingTurnGenerations = []
      this.activeTurnGeneration = null
      this.emit({ type: 'fatal', text: e.message })
    })
    // Handshake: a resposta traz comandos, modelos e conta REAIS do CLI.
    this.write({
      type: 'control_request',
      request_id: this.initReqId,
      request: { subtype: 'initialize' }
    })
    this.initTimer = setTimeout(() => {
      if (!this.alive || this.caps) return
      this.emit({ type: 'fatal', text: 'o Claude não confirmou a abertura da conversa' })
      this.kill()
    }, INIT_CONFIRM_TIMEOUT)

    this.child.on('close', (code) => {
      const failedBeforeClose = this.closed
      this.closed = true
      this.clearInitGuard()
      const final = this.protocol.end()
      for (const line of final.lines) this.handleLine(line)
      this.clearIdle()
      this.clearTurnSilence()
      this.clearInterruptGuard()
      this.cancelPendingInteractions()
      this.pendingTurnGenerations = []
      this.activeTurnGeneration = null
      for (const w of this.capsWaiters.splice(0)) w(this.caps)
      if (!this.killed && !failedBeforeClose) {
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
    return !this.killed && !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Mesmo destino de spawn? (mudar seat/modelo/effort/fast exige processo novo) */
  matches(opts: MaestroSessionOpts): boolean {
    return (
      this.opts.cwd === opts.cwd &&
      (this.opts.configDir ?? '') === (opts.configDir ?? '') &&
      (this.opts.systemPromptFile ?? '') === (opts.systemPromptFile ?? '') &&
      (this.opts.model ?? '') === (opts.model ?? '') &&
      (this.opts.effort ?? '') === (opts.effort ?? '') &&
      Boolean(this.opts.fastMode) === Boolean(opts.fastMode)
    )
  }

  send(text: string): void {
    const generation = ++this.turnGeneration
    this.pendingTurnGenerations = enqueueGuiTurn(this.pendingTurnGenerations, generation)
    this.activeTurnGeneration = this.pendingTurnGenerations[0] ?? null
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
  ): { toolUseId?: string; toolName: string; description: string } | null {
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
    return {
      ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
      toolName: req.toolName,
      description: req.description
    }
  }

  /** Responde a AskUserQuestion pendente: allow com as escolhas DENTRO do
   *  updatedInput ({...input, answers}) — formato provado no claudecodeui.
   *  `answers` = { "<texto da pergunta>": "labels unidos por ', '" }; "pular"
   *  é answers {} com allow. Id stale → false, espelhando answerPermission. */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean {
    const req = this.pending.get(requestId)
    if (!req) return false
    this.pending.delete(requestId)
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'allow', updatedInput: { ...req.input, answers } }
      }
    })
    this.resetIdle()
    return true
  }

  /** Veredito do modo plano (ExitPlanMode): construir = allow (updatedInput é
   *  o próprio input); revisar = deny com a frase que o CLI espera. */
  answerPlanReview(requestId: string, approve: boolean): boolean {
    const req = this.pending.get(requestId)
    if (!req) return false
    this.pending.delete(requestId)
    const response = approve
      ? { behavior: 'allow', updatedInput: req.input }
      : { behavior: 'deny', message: 'User asked to revise the plan' }
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response }
    })
    this.resetIdle()
    return true
  }

  interrupt(): boolean {
    if (this.activeTurnGeneration === null) return false
    const generation = this.activeTurnGeneration
    if (
      this.interruptGeneration === generation &&
      this.interruptRequestId !== null &&
      this.interruptTimer !== null
    )
      return true
    this.clearInterruptGuard()
    const requestId = randomUUID()
    this.interruptGeneration = generation
    this.interruptRequestId = requestId
    this.interruptTimer = setTimeout(() => {
      this.failInterrupt(generation, 'o Claude não confirmou a interrupção')
    }, INTERRUPT_CONFIRM_TIMEOUT)
    this.write({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' }
    })
    return true
  }

  get turnActive(): boolean {
    return this.activeTurnGeneration !== null || this.pendingTurnGenerations.length > 0
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
    if (!this.alive || this.turnActive) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.controlWaiters.delete(id)) return
        this.emit({
          type: 'fatal',
          text: 'o Claude não confirmou a troca de executor; encerrei a sessão para não usar um estado incerto'
        })
        resolve(false)
        this.kill()
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
    if (this.killed) return
    this.killed = true
    this.clearInitGuard()
    this.cancelPendingInteractions()
    this.pendingTurnGenerations = []
    this.activeTurnGeneration = null
    this.clearIdle()
    this.clearTurnSilence()
    this.clearInterruptGuard()
    for (const waiter of this.capsWaiters.splice(0)) waiter(null)
    for (const waiter of this.controlWaiters.values()) waiter(false)
    this.controlWaiters.clear()
    terminateGuiProcessTree(this.child)
  }

  /** Modelo + effort na camada de flags da sessão viva. Um único request
   *  evita sucesso parcial: ou o CLI confirma o par inteiro, ou o chamador
   *  mantém a seleção anterior. `null` remove o override daquela chave. */
  setExecutor(input: { model?: string; effort?: string }): Promise<boolean> {
    if (!this.alive || this.turnActive) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.controlWaiters.delete(id)) return
        this.emit({
          type: 'fatal',
          text: 'o Claude não confirmou a troca; encerrei a sessão para não usar um estado incerto'
        })
        resolve(false)
        this.kill()
      }, 10_000)
      this.controlWaiters.set(id, (ok) => {
        clearTimeout(timer)
        if (ok) {
          this.opts.model = input.model
          this.opts.effort = input.effort
        }
        resolve(ok)
      })
      this.write({
        type: 'control_request',
        request_id: id,
        request: {
          subtype: 'apply_flag_settings',
          settings: {
            model: input.model ?? null,
            effortLevel: input.effort ?? null
          }
        }
      })
    })
  }

  private clearInitGuard(): void {
    if (this.initTimer) clearTimeout(this.initTimer)
    this.initTimer = null
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
    this.clearTurnSilence()
    // Permissão pendente = esperando o HUMANO, não o CLI. Sem timeout.
    if (this.pending.size > 0) return
    if (
      shouldArmGuiTurnWatchdog(
        this.opts.idleTimeoutMs,
        this.activeTurnGeneration !== null,
        false
      )
    ) {
      this.turnSilenceTimer = setTimeout(() => {
        if (!this.alive || this.activeTurnGeneration === null || this.pending.size > 0) return
        this.emit({ type: 'fatal', text: 'o Claude ficou sem responder durante o turno' })
        this.kill()
      }, GUI_ACTIVE_TURN_SILENCE_TIMEOUT)
    }
    const timeout = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT
    if (timeout <= 0) return // relógio desligado (pane GUI)
    this.idleTimer = setTimeout(() => {
      this.emit({ type: 'fatal', text: 'sem resposta do CLI há 10 min — sessão encerrada' })
      this.kill()
    }, timeout)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private clearTurnSilence(): void {
    if (this.turnSilenceTimer) clearTimeout(this.turnSilenceTimer)
    this.turnSilenceTimer = null
  }

  private cancelPendingInteractions(): void {
    const requestIds = [...this.pending.keys()]
    this.pending.clear()
    for (const requestId of requestIds) {
      this.emit({ type: 'permission-cancel', requestId })
    }
  }

  private clearInterruptGuard(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer)
    this.interruptTimer = null
    this.interruptGeneration = null
    this.interruptRequestId = null
  }

  private failInterrupt(generation: number, message: string): void {
    if (
      !this.alive ||
      this.activeTurnGeneration !== generation ||
      this.interruptGeneration !== generation
    )
      return
    this.clearInterruptGuard()
    this.activeTurnGeneration = null
    this.emit({ type: 'fatal', text: message })
    this.kill()
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    const parsed = parseGuiProtocolLine<unknown>(line)
    if (!parsed.ok || !isGuiClaudeProtocolEnvelope(parsed.value)) {
      this.emit({ type: 'fatal', text: 'o Claude enviou uma resposta de protocolo inválida' })
      this.kill()
      return
    }
    const evt = parsed.value as StreamLine

    switch (evt.type) {
      case 'system':
        if (guiClaudeParentToolUseId(evt.parent_tool_use_id)) break
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
        if (guiClaudeParentToolUseId(evt.parent_tool_use_id)) break
        const inner = evt.event
        if (inner?.type === 'content_block_delta') {
          if (inner.delta?.type === 'text_delta' && inner.delta.text) {
            this.emit({ type: 'delta', text: inner.delta.text })
          } else if (inner.delta?.type === 'thinking_delta') {
            this.emit({ type: 'thinking', text: inner.delta.text })
          }
        }
        break
      }

      case 'assistant': {
        const content = evt.message?.content
        if (!Array.isArray(content)) break
        const parentToolUseId = guiClaudeParentToolUseId(evt.parent_tool_use_id)
        for (const block of content) {
          if (block.type === 'text' && block.text && !parentToolUseId) {
            this.emit({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use' && block.name) {
            this.emit({
              type: 'tool',
              name: block.name,
              input: block.input ?? {},
              toolUseId: block.id,
              ...(parentToolUseId ? { parentToolUseId } : {})
            })
          }
        }
        break
      }

      case 'control_response': {
        const resp = evt.response
        if (!resp?.request_id) break
        if (resp.request_id === this.interruptRequestId) {
          if (resp.subtype !== 'success' && this.interruptGeneration !== null) {
            this.failInterrupt(
              this.interruptGeneration,
              resp.error
                ? 'não deu para interromper o Claude — ' + firstLines(resp.error, 300)
                : 'o Claude recusou a interrupção'
            )
          }
        } else if (resp.request_id === this.initReqId) {
          this.clearInitGuard()
          if (resp.subtype === 'success' && resp.response) {
            this.caps = {
              commands: resp.response.commands ?? [],
              models: resp.response.models ?? [],
              account: resp.response.account
            }
            this.emit({ type: 'ready', caps: this.caps })
          } else {
            const detail = resp.error ? `: ${firstLines(resp.error, 300)}` : ''
            this.emit({ type: 'fatal', text: `handshake do Claude falhou${detail}` })
            for (const w of this.capsWaiters.splice(0)) w(null)
            this.kill()
            break
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
          // Resultado vazio também FECHA o card: comando silencioso não pode
          // ficar com spinner eterno. A contagem nasce antes do preview capado.
          this.emit(toolResultEvent(raw, Boolean(block.is_error), block.tool_use_id))
        }
        break
      }

      case 'control_request': {
        const req = evt.request
        if (req?.subtype === 'can_use_tool' && evt.request_id && req.tool_name) {
          const input = req.input ?? {}
          const suggestions = resolveChatPermissionSuggestions(
            req.tool_name,
            input,
            req.permission_suggestions
          )
          const permissionRule = chatPermissionRuleLabel(suggestions)
          const toolName = firstLines(req.display_name ?? req.tool_name, 160)
          const description = firstLines(req.description ?? '', 500)
          // Interativo ou não, o pedido mora no MESMO `pending`: a resposta de
          // question/plan-review reusa o control_response da permissão, e o
          // control_cancel_request abaixo cobre os três tipos de graça.
          this.pending.set(evt.request_id, {
            ...(req.tool_use_id ? { toolUseId: req.tool_use_id } : {}),
            toolName,
            description,
            input,
            suggestions
          })
          this.resetIdle() // esperando o humano — nenhum relógio corre
          // PERGUNTA ESTRUTURADA (2.0): AskUserQuestion vira card de opções.
          // GOTCHA documentado no fork (claudecodeui): em acceptEdits/
          // bypassPermissions o caminho de permissão pode resolver ANTES do
          // can_use_tool e a pergunta nem chega (o modelo inventa a resposta)
          // — fora desta rodada; default/plan cobrem o caminho feliz.
          if (req.tool_name === 'AskUserQuestion') {
            const questions = parseGuiQuestions(input)
            if (questions) {
              this.emit({ type: 'question', requestId: evt.request_id, questions })
              break
            }
            // input torto → cai na permissão genérica (nunca engolir o pedido)
          }
          // MODO PLANO: ExitPlanMode carrega o plano em markdown (o fork
          // desfaz o \n escapado — mesma regra aqui).
          if (req.tool_name === 'ExitPlanMode' || req.tool_name === 'exit_plan_mode') {
            const rawPlan = boundedGuiText(input['plan'], GUI_PLAN_MAX_CHARS) ?? ''
            const plan = rawPlan.replace(/\\n/g, '\n')
            this.emit({ type: 'plan-review', requestId: evt.request_id, plan })
            break
          }
          this.emit({
            type: 'permission',
            requestId: evt.request_id,
            ...(req.tool_use_id ? { toolUseId: req.tool_use_id } : {}),
            toolName,
            description,
            inputPretty: prettyGuiInput(input),
            reason: boundedGuiText(req.decision_reason, 500),
            ...(permissionRule ? { permissionRule } : {}),
            canAlways: suggestions.length > 0
          })
        }
        break
      }

      case 'control_cancel_request':
        // Vale para permission E question/plan-review: os três moram no mesmo
        // `pending`, então o permission-cancel com o requestId limpa qualquer
        // um deles no renderer (contrato A.3 — visível nos testes do chat).
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
        if (guiClaudeParentToolUseId(evt.parent_tool_use_id)) break
        this.cancelPendingInteractions()
        const advanced = advanceGuiTurn(this.pendingTurnGenerations)
        const generation = advanced.completed ?? this.activeTurnGeneration
        const interrupted =
          generation !== null && this.interruptGeneration === generation
        this.pendingTurnGenerations = advanced.pending
        this.activeTurnGeneration = advanced.active
        this.clearInterruptGuard()
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
        const outcome = evt.is_error
          ? 'failed'
          : interrupted
            ? 'cancelled'
            : 'completed'
        this.emit({
          type: 'result',
          isError: Boolean(evt.is_error),
          outcome,
          continues: this.activeTurnGeneration !== null,
          errorText: evt.is_error ? (evt.result ?? 'erro sem detalhe') : undefined,
          resultText: typeof evt.result === 'string' && evt.result.trim() ? evt.result : undefined,
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

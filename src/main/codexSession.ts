import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { freshWindowsPath } from './winPath'
import type {
  CliCaps,
  MaestroSessionOpts,
  PermissionChoice,
  SessionEvent
} from './maestroSession'

// Painel de fundo do Maestro para seats CODEX: um `codex app-server` persistente
// (JSON-RPC v2 via stdio) por projeto — o espelho exato do que o TUI do Codex
// faz. Threads ficam gravadas em CODEX_HOME/sessions e são retomadas via
// thread/resume; modelo e effort são overrides POR TURNO (turn/start), então
// trocar não exige respawn. Aprovações (comando/patch) chegam como requests
// JSON-RPC do servidor e a UI responde accept/acceptForSession/decline.

interface RpcResponse {
  result?: Record<string, unknown>
  error?: { message?: string }
}

interface JsonRpcMsg {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

interface CodexItem {
  type?: string
  id?: string
  text?: string
  command?: unknown
  cwd?: string
  query?: string
  tool?: string
  server?: string
  status?: string
  exitCode?: number
  aggregatedOutput?: string
  changes?: unknown
}

const IDLE_TIMEOUT = 600_000
const RESULT_MAX = 400

// Comandos slash do painel codex — cada um mapeado para o MÉTODO REAL do
// app-server (o TUI do Codex usa esses mesmos por trás dos comandos dele).
const CODEX_COMMANDS = [
  { name: 'status', description: 'conta, plano, modelo, thread e rate limits (account/read)' },
  { name: 'usage', description: 'uso real do plano — janelas de rate limit (account/rateLimits/read)' },
  { name: 'compact', description: 'compacta o contexto da thread (thread/compact/start)' },
  { name: 'review', description: 'revisa as mudanças não commitadas do repo (review/start)' },
  { name: 'diff', description: 'git diff do projeto, incluindo arquivos novos' },
  { name: 'init', description: 'cria um AGENTS.md com instruções para o Codex' },
  {
    name: 'permissions',
    description: 'política de aprovação do Codex (untrusted · on-request · never)',
    argumentHint: '[modo]'
  },
  { name: 'rename', description: 'renomeia a thread atual (thread/name/set)', argumentHint: '<nome>' },
  { name: 'goal', description: 'vê ou define o objetivo da thread (thread/goal)', argumentHint: '[texto]' },
  { name: 'mcp', description: 'status real dos servidores MCP (mcpServerStatus/list)' },
  { name: 'skills', description: 'skills disponíveis no codex (skills/list)' },
  {
    name: 'fast',
    description: 'Fast: 1.5x speed, increased usage (service tier priority, igual ao TUI)'
  }
]

// Comandos que existem no TUI do Codex mas são UI de terminal — não se
// aplicam ao painel embutido. Responder explicando é melhor que "não existe".
const CODEX_TUI_ONLY = new Map<string, string>([
  ['/new', 'use /clear — reinicia a conversa do Maestro'],
  ['/clear', 'use o /clear do Synkora (mesmo efeito)'],
  ['/quit', 'o painel vive embutido — feche o projeto para encerrá-lo'],
  ['/exit', 'o painel vive embutido — feche o projeto para encerrá-lo'],
  ['/logout', 'login/logout é por seat, na Home do Synkora'],
  ['/resume', 'a thread é retomada automaticamente ao voltar para o projeto'],
  ['/model', 'use o /model do Synkora (mesma lista real do Codex)'],
  ['/approvals', 'use /permissions'],
  ['/plan', 'modo plan é do TUI — peça um plano em texto ao Maestro'],
  ['/mention', 'cole o caminho do arquivo direto na mensagem'],
  ['/copy', 'selecione o texto no painel e copie normal'],
  ['/undo', 'sem equivalente no painel embutido'],
  ['/feedback', 'sem equivalente no painel embutido']
])

const CODEX_UI_COMMANDS = new Set([
  '/ide', '/keymap', '/vim', '/setup-default-sandbox', '/sandbox-add-read-dir',
  '/experimental', '/approve', '/memories', '/import', '/hooks', '/archive',
  '/delete', '/fork', '/app', '/side', '/btw', '/agent', '/subagents', '/raw',
  '/debug-config', '/title', '/statusline', '/theme', '/pets', '/apps',
  '/plugins', '/ps', '/stop', '/personality'
])

const INIT_PROMPT = `Analise este repositório (estrutura, manifests, convenções) e crie um arquivo AGENTS.md na raiz com instruções objetivas para agentes de código trabalharem aqui: visão geral do projeto, comandos de build/teste/lint, convenções de código e armadilhas conhecidas. Se já existir, melhore-o. Responda em PT-BR resumindo o que gravou.`

function fmtReset(epochSecs: unknown): string {
  return typeof epochSecs === 'number'
    ? new Date(epochSecs * 1000).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '?'
}

function firstLines(text: string, max: number): string {
  const clean = text.trim()
  return clean.length <= max ? clean : clean.slice(0, max) + '…'
}

function commandText(command: unknown): string {
  if (Array.isArray(command)) return command.map(String).join(' ')
  return typeof command === 'string' ? command : JSON.stringify(command)
}

export class CodexSession {
  readonly opts: MaestroSessionOpts
  // Persona vai como developerInstructions no thread/start — nunca no prompt.
  personaSent = true
  readyAnnounced = false
  caps: CliCaps | null = null
  private child: ChildProcessWithoutNullStreams
  private emit: (evt: SessionEvent) => void
  private persona: string
  private buffer = ''
  private stderrTail = ''
  private killed = false
  private idleTimer: NodeJS.Timeout | null = null
  private nextId = 1
  private pending = new Map<number, (msg: RpcResponse) => void>()
  private approvals = new Map<
    string,
    { rpcId: number | string; toolName: string; description: string }
  >()
  private capsWaiters: ((caps: CliCaps | null) => void)[] = []
  private initDone: Promise<void>
  private threadReady: Promise<boolean> | null = null
  private threadId: string | null = null
  private turnId: string | null = null
  private lastTokens: number | undefined
  private lastWindow: number | undefined
  // /fast: service tier "priority" (1.5x speed) aplicado como override por turno.
  private fastTier = false
  private wantInterrupt = false

  constructor(opts: MaestroSessionOpts, persona: string, emit: (evt: SessionEvent) => void) {
    this.opts = opts
    this.persona = persona
    this.emit = emit

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath()
    }
    if (opts.configDir) env['CODEX_HOME'] = opts.configDir

    // shell:true para o PATH do env resolver o binário (mesmo padrão do chat antigo).
    this.child = spawn('codex', ['app-server'], {
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
    this.child.on('close', (code) => {
      this.clearIdle()
      for (const w of this.capsWaiters.splice(0)) w(this.caps)
      if (!this.killed) {
        const err = this.stderrTail.trim()
        this.emit({
          type: 'fatal',
          text: `o painel codex encerrou (exit ${code})${err ? ` · ${firstLines(err, 300)}` : ''}`
        })
      }
      this.emit({ type: 'closed', code })
    })

    this.initDone = this.request('initialize', {
      clientInfo: { name: 'synkora', title: 'Synkora', version: '0.1.0' }
    }).then((resp) => {
      if (resp.error) {
        this.emit({ type: 'fatal', text: `handshake do codex falhou: ${resp.error.message}` })
        return
      }
      this.notify('initialized', {})
      void this.loadCaps()
    })
  }

  get alive(): boolean {
    return !this.killed && this.child.exitCode === null
  }

  /** Modelo/effort são por turno no Codex — só cwd/seat exigem processo novo. */
  matches(opts: MaestroSessionOpts): boolean {
    return (
      this.opts.cwd === opts.cwd && (this.opts.configDir ?? '') === (opts.configDir ?? '')
    )
  }

  send(text: string): void {
    void this.startTurn(text).catch((e: unknown) => {
      this.emit({
        type: 'result',
        isError: true,
        errorText: e instanceof Error ? e.message : String(e)
      })
    })
  }

  answerPermission(
    requestId: string,
    choice: PermissionChoice
  ): { toolName: string; description: string } | null {
    const req = this.approvals.get(requestId)
    if (!req) return null
    this.approvals.delete(requestId)
    const decision =
      choice === 'deny' ? 'decline' : choice === 'allow-always' ? 'acceptForSession' : 'accept'
    this.respond(req.rpcId, { decision })
    this.resetIdle()
    return { toolName: req.toolName, description: req.description }
  }

  interrupt(): void {
    if (this.threadId && this.turnId) {
      void this.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId
      }).then((r) => {
        if (r.error) this.emit({ type: 'limit', text: `interrupt falhou: ${r.error.message}` })
      })
    } else {
      // Turno ainda subindo (turn/start em voo) — interrompe assim que o
      // turn/started trouxer o id.
      this.wantInterrupt = true
    }
  }

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

  /** Override por turno: só atualiza o opts — o próximo turn/start aplica. */
  setModel(model: string): Promise<boolean> {
    this.opts.model = model && model !== 'default' ? model : undefined
    return Promise.resolve(true)
  }

  /** Comandos slash do codex, cada um via RPC real. false = comando não existe. */
  runSlash(raw: string): boolean {
    const trimmed = raw.trim()
    const cmd = trimmed.split(/\s+/)[0]
    const arg = trimmed.slice(cmd.length).trim()
    const run = (fn: () => Promise<void>): boolean => {
      void fn().catch((e: unknown) => {
        this.emit({
          type: 'result',
          isError: true,
          errorText: e instanceof Error ? e.message : String(e),
          contextTokens: this.lastTokens
        })
      })
      return true
    }
    // Comandos do TUI do Codex que não se aplicam ao painel embutido:
    // responder explicando (com a alternativa) em vez de "não existe".
    const hint = CODEX_TUI_ONLY.get(cmd)
    if (hint) {
      return run(async () => this.finishCommand(`${cmd} é do terminal do Codex — ${hint}`))
    }
    if (CODEX_UI_COMMANDS.has(cmd)) {
      return run(async () =>
        this.finishCommand(`${cmd} é um recurso da interface do terminal do Codex — não se aplica ao painel embutido`)
      )
    }
    switch (cmd) {
      case '/status':
        return run(() => this.cmdStatus())
      case '/usage':
        return run(() => this.cmdUsage())
      case '/compact':
        return run(() => this.cmdCompact())
      case '/review':
        return run(() => this.cmdReview())
      case '/diff':
        return run(() => this.cmdDiff())
      case '/init':
        this.send(INIT_PROMPT)
        return true
      case '/permissions':
        return run(() => this.cmdPermissions(arg))
      case '/rename':
        return run(() => this.cmdRename(arg))
      case '/goal':
        return run(() => this.cmdGoal(arg))
      case '/mcp':
        return run(() => this.cmdMcp())
      case '/skills':
        return run(() => this.cmdSkills())
      case '/fast':
        return run(() => this.cmdFast())
      default:
        return false
    }
  }

  private finishCommand(text: string): void {
    this.emit({ type: 'command-output', text })
    this.emit({ type: 'result', isError: false, contextTokens: this.lastTokens })
  }

  private async cmdStatus(): Promise<void> {
    const [acc, limits] = await Promise.all([
      this.request('account/read', {}),
      this.request('account/rateLimits/read', {})
    ])
    const a = acc.result?.['account'] as { email?: string; planType?: string } | undefined
    const rl = limits.result?.['rateLimits'] as
      | { primary?: { usedPercent?: number; resetsAt?: number } }
      | undefined
    const lines = [
      `conta: ${a?.email ?? '?'} · plano ${a?.planType ?? '?'}`,
      `modelo: ${this.opts.model ?? 'padrão do config'} · effort: ${this.opts.effort ?? 'padrão'} · aprovação: ${this.opts.approvalPolicy ?? 'padrão do config'}${this.fastTier ? ' · fast (priority)' : ''}`,
      `thread: ${this.threadId ?? 'ainda não aberta (nasce na 1ª mensagem)'}`,
      `contexto: ${this.lastTokens ? `~${Math.round(this.lastTokens / 1000)}k tokens` : 'sem uso ainda'}`,
      rl?.primary
        ? `rate limit: ${rl.primary.usedPercent ?? 0}% usado · reseta ${fmtReset(rl.primary.resetsAt)}`
        : 'rate limit: sem dados'
    ]
    this.finishCommand(lines.join('\n'))
  }

  private async cmdUsage(): Promise<void> {
    const limits = await this.request('account/rateLimits/read', {})
    if (limits.error) throw new Error(limits.error.message ?? 'account/rateLimits/read falhou')
    const byId = limits.result?.['rateLimitsByLimitId'] as
      | Record<string, { primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } }>
      | undefined
    const single = limits.result?.['rateLimits'] as
      | { primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } }
      | undefined
    const buckets = byId && Object.keys(byId).length > 0 ? byId : single ? { plano: single } : {}
    const lines = Object.entries(buckets).map(([id, b]) => {
      const p = b.primary
      const days = p?.windowDurationMins ? Math.round(p.windowDurationMins / 1440) : null
      return `${id}: ${p?.usedPercent ?? 0}% da janela${days ? ` de ${days}d` : ''} · reseta ${fmtReset(p?.resetsAt)}`
    })
    this.finishCommand(lines.length ? lines.join('\n') : 'sem dados de uso')
  }

  private async cmdCompact(): Promise<void> {
    if (!this.threadId) {
      this.finishCommand('nada para compactar — a thread nasce na primeira mensagem')
      return
    }
    const resp = await this.request('thread/compact/start', { threadId: this.threadId })
    if (resp.error) throw new Error(resp.error.message ?? 'compact falhou')
    // O resultado real chega na notificação thread/compacted.
    this.finishCommand('compactação iniciada…')
  }

  private async cmdReview(): Promise<void> {
    const ok = await this.ensureThread()
    if (!ok) throw new Error('painel codex sem thread')
    const resp = await this.request('review/start', {
      threadId: this.threadId,
      target: { type: 'uncommittedChanges' },
      delivery: 'inline'
    })
    if (resp.error) throw new Error(resp.error.message ?? 'review/start falhou')
    // A review roda como um turno normal — achados chegam pela stream,
    // e o turn/completed dela encerra o busy.
    this.emit({
      type: 'command-output',
      text: 'review das mudanças não commitadas iniciada — achados chegam aqui'
    })
  }

  private cmdDiff(): Promise<void> {
    // Igual ao TUI: git diff + untracked, direto do repo.
    return new Promise((resolve) => {
      const child = spawn(
        'git',
        ['-c', 'core.quotepath=false', 'diff', 'HEAD'],
        { cwd: this.opts.cwd, shell: process.platform === 'win32' }
      )
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('close', () => {
        const untracked = spawn('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: this.opts.cwd,
          shell: process.platform === 'win32'
        })
        let files = ''
        untracked.stdout.on('data', (d: Buffer) => (files += d.toString()))
        untracked.on('close', () => {
          const parts: string[] = []
          if (out.trim()) parts.push(firstLines(out, 3000))
          if (files.trim())
            parts.push(`arquivos novos (untracked):\n${firstLines(files, 500)}`)
          if (err.trim() && !out.trim()) parts.push(err.trim().slice(0, 300))
          this.finishCommand(parts.length ? parts.join('\n\n') : 'sem mudanças no repositório')
          resolve()
        })
        untracked.on('error', () => {
          this.finishCommand(out.trim() ? firstLines(out, 3000) : 'git indisponível')
          resolve()
        })
      })
      child.on('error', (e) => {
        this.finishCommand(`git indisponível: ${e.message}`)
        resolve()
      })
    })
  }

  private async cmdPermissions(arg: string): Promise<void> {
    const modes = ['untrusted', 'on-request', 'never']
    if (!arg) {
      this.finishCommand(
        `política de aprovação atual: ${this.opts.approvalPolicy ?? 'padrão do config'}\n` +
          `opções: untrusted (pergunta em comandos fora da lista segura) · on-request (o agente decide quando pedir) · never (nunca pergunta)\n` +
          `uso: /permissions <modo>`
      )
      return
    }
    if (!modes.includes(arg)) {
      throw new Error(`modo inválido: ${arg} — use ${modes.join(', ')}`)
    }
    // Override por turno (turn/start.approvalPolicy) — igual ao /permissions do TUI.
    this.opts.approvalPolicy = arg
    this.finishCommand(`política de aprovação: ${arg} (vale a partir do próximo turno)`)
  }

  private async cmdRename(arg: string): Promise<void> {
    if (!arg) throw new Error('uso: /rename <nome da thread>')
    const ok = await this.ensureThread()
    if (!ok) throw new Error('painel codex sem thread')
    const resp = await this.request('thread/name/set', { threadId: this.threadId, name: arg })
    if (resp.error) throw new Error(resp.error.message ?? 'thread/name/set falhou')
    this.finishCommand(`thread renomeada: ${arg}`)
  }

  private async cmdGoal(arg: string): Promise<void> {
    const ok = await this.ensureThread()
    if (!ok) throw new Error('painel codex sem thread')
    if (!arg) {
      const resp = await this.request('thread/goal/get', { threadId: this.threadId })
      if (resp.error) throw new Error(resp.error.message ?? 'thread/goal/get falhou')
      const goal = resp.result?.['goal'] as { objective?: string } | undefined
      this.finishCommand(
        goal?.objective ? `objetivo da thread: ${goal.objective}` : 'nenhum objetivo definido — uso: /goal <texto>'
      )
      return
    }
    const resp = await this.request('thread/goal/set', {
      threadId: this.threadId,
      objective: arg
    })
    if (resp.error) throw new Error(resp.error.message ?? 'thread/goal/set falhou')
    this.finishCommand(`objetivo definido: ${arg}`)
  }

  /** /fast REAL do codex: toggle do service tier "priority" (1.5x speed). */
  private async cmdFast(): Promise<void> {
    this.fastTier = !this.fastTier
    this.finishCommand(
      this.fastTier
        ? 'Fast ATIVADO — service tier priority (1.5x speed, increased usage) · vale a partir do próximo turno · /fast de novo desativa'
        : 'Fast desativado — service tier padrão'
    )
  }

  private async cmdMcp(): Promise<void> {
    const resp = await this.request('mcpServerStatus/list', {})
    if (resp.error) throw new Error(resp.error.message ?? 'mcpServerStatus/list falhou')
    const data = (resp.result?.['data'] ?? []) as {
      name?: string
      tools?: Record<string, unknown>
      serverInfo?: { version?: string }
    }[]
    const lines = data.map(
      (s) =>
        `${s.name ?? '?'} · ${Object.keys(s.tools ?? {}).length} ferramentas${s.serverInfo?.version ? ` · v${s.serverInfo.version}` : ''}`
    )
    this.finishCommand(lines.length ? lines.join('\n') : 'nenhum servidor MCP configurado')
  }

  private async cmdSkills(): Promise<void> {
    const resp = await this.request('skills/list', { cwds: [this.opts.cwd] })
    if (resp.error) throw new Error(resp.error.message ?? 'skills/list falhou')
    // data = [{cwd, skills: [{name, description, enabled}]}] — agrupado por cwd.
    const groups = (resp.result?.['data'] ?? []) as {
      skills?: { name?: string; description?: string; enabled?: boolean }[]
    }[]
    const lines = groups
      .flatMap((g) => g.skills ?? [])
      .filter((s) => s.enabled !== false)
      .map((s) => `${s.name ?? '?'}${s.description ? ` — ${firstLines(s.description, 90)}` : ''}`)
    this.finishCommand(lines.length ? lines.join('\n') : 'nenhuma skill instalada')
  }

  announceOnce(): boolean {
    return false // codex anuncia via evento 'ready' (painel pronto)
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

  // ————— internos —————

  private request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.alive) return Promise.resolve({ error: { message: 'painel codex morto' } })
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private respond(id: number | string, result: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', id, result })
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
    if (this.approvals.size > 0) return // esperando o humano
    this.idleTimer = setTimeout(() => {
      this.emit({ type: 'fatal', text: 'sem resposta do codex há 10 min — sessão encerrada' })
      this.kill()
    }, IDLE_TIMEOUT)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private async loadCaps(): Promise<void> {
    const [models, account] = await Promise.all([
      this.request('model/list', {}),
      this.request('account/read', {})
    ])
    const data = (models.result?.['data'] ?? []) as {
      id?: string
      model?: string
      displayName?: string
      description?: string
      hidden?: boolean
      supportedReasoningEfforts?: { reasoningEffort?: string }[]
    }[]
    const acc = account.result?.['account'] as
      | { email?: string; planType?: string }
      | undefined
    this.caps = {
      commands: CODEX_COMMANDS, // cada um mapeado a um RPC real (runSlash)
      models: data
        .filter((m) => m.id && !m.hidden)
        .map((m) => ({
          value: m.id as string,
          resolvedModel: m.model,
          displayName: m.displayName ?? (m.id as string),
          description: m.description,
          supportsEffort: (m.supportedReasoningEfforts ?? []).length > 0,
          supportedEffortLevels: (m.supportedReasoningEfforts ?? [])
            .map((e) => e.reasoningEffort)
            .filter((e): e is string => Boolean(e))
        })),
      account: acc ? { email: acc.email, subscriptionType: acc.planType } : undefined
    }
    for (const w of this.capsWaiters.splice(0)) w(this.caps)
    this.emit({ type: 'ready', caps: this.caps })
  }

  private ensureThread(): Promise<boolean> {
    if (!this.threadReady) this.threadReady = this.openThread()
    return this.threadReady
  }

  private async openThread(): Promise<boolean> {
    await this.initDone
    const base: Record<string, unknown> = {
      cwd: this.opts.cwd,
      developerInstructions: this.persona
    }
    if (this.opts.sandbox) base['sandbox'] = this.opts.sandbox
    let resp: RpcResponse | null = null
    if (this.opts.resumeSessionId) {
      resp = await this.request('thread/resume', {
        threadId: this.opts.resumeSessionId,
        ...base
      })
      if (resp.error) resp = null // thread sumiu — abre nova
    }
    if (!resp) resp = await this.request('thread/start', base)
    const thread = resp.result?.['thread'] as { id?: string } | undefined
    if (resp.error || !thread?.id) {
      this.emit({
        type: 'fatal',
        text: `não consegui abrir a thread do codex${resp.error?.message ? ` · ${resp.error.message}` : ''}`
      })
      return false
    }
    this.threadId = thread.id
    this.emit({ type: 'session-id', sessionId: `codex-thread:${thread.id}` })
    return true
  }

  private async startTurn(text: string): Promise<void> {
    const ok = await this.ensureThread()
    if (!ok) {
      this.emit({ type: 'result', isError: true, errorText: 'painel codex sem thread' })
      return
    }
    // Mensagem NO MEIO de um turno ativo = steering (igual ao TUI): entra no
    // turno em andamento via turn/steer. Se o turno acabou na corrida, cai
    // no turn/start normal.
    if (this.turnId) {
      const steer = await this.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        input: [{ type: 'text', text }]
      })
      if (!steer.error) return
    }
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text }]
    }
    if (this.opts.model) params['model'] = this.opts.model
    if (this.opts.effort) params['effort'] = this.opts.effort
    if (this.opts.approvalPolicy) params['approvalPolicy'] = this.opts.approvalPolicy
    if (this.fastTier) params['serviceTier'] = 'priority'
    const resp = await this.request('turn/start', params)
    if (resp.error) {
      this.emit({ type: 'result', isError: true, errorText: resp.error.message ?? 'turn falhou' })
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: JsonRpcMsg
    try {
      msg = JSON.parse(line) as JsonRpcMsg
    } catch {
      return
    }

    // Resposta a um request nosso.
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id as number)
      if (waiter) {
        this.pending.delete(msg.id as number)
        waiter({ result: msg.result, error: msg.error })
      }
      return
    }

    // Request DO SERVIDOR (aprovações etc.) — tem id E method.
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg.id, msg.method, msg.params ?? {})
      return
    }

    // Notificação.
    if (msg.method) this.handleNotification(msg.method, msg.params ?? {})
  }

  private handleServerRequest(
    id: number | string,
    method: string,
    p: Record<string, unknown>
  ): void {
    const requestId = `rpc-${String(id)}`
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const desc = commandText(p['command'])
      this.approvals.set(requestId, { rpcId: id, toolName: 'comando', description: desc })
      this.clearIdle()
      this.emit({
        type: 'permission',
        requestId,
        toolName: 'comando',
        description: firstLines(desc, 160),
        inputPretty: firstLines(
          JSON.stringify({ command: desc, cwd: p['cwd'] ?? this.opts.cwd }, null, 2),
          2000
        ),
        reason: typeof p['reason'] === 'string' ? p['reason'] : undefined,
        canAlways: true
      })
      return
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const root = typeof p['grantRoot'] === 'string' ? p['grantRoot'] : this.opts.cwd
      this.approvals.set(requestId, {
        rpcId: id,
        toolName: 'edição de arquivos',
        description: root
      })
      this.clearIdle()
      this.emit({
        type: 'permission',
        requestId,
        toolName: 'edição de arquivos',
        description: root,
        inputPretty: firstLines(JSON.stringify(p, null, 2), 2000),
        reason: typeof p['reason'] === 'string' ? p['reason'] : undefined,
        canAlways: true
      })
      return
    }
    // Pedido que a UI não suporta: nega para o turno seguir.
    this.emit({ type: 'limit', text: `pedido não suportado do codex negado: ${method}` })
    this.respond(id, { decision: 'decline' })
  }

  private handleNotification(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = p['delta']
        if (typeof delta === 'string' && delta) this.emit({ type: 'delta', text: delta })
        break
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        this.emit({ type: 'thinking' })
        break
      case 'turn/started': {
        const turn = p['turn'] as { id?: string } | undefined
        if (turn?.id) this.turnId = turn.id
        if (this.wantInterrupt) {
          this.wantInterrupt = false
          this.interrupt()
        }
        break
      }
      case 'item/started': {
        const item = p['item'] as CodexItem | undefined
        if (!item) break
        if (item.type === 'commandExecution') {
          this.emit({
            type: 'tool',
            name: 'Bash',
            input: { command: commandText(item.command), cwd: item.cwd }
          })
        } else if (item.type === 'fileChange') {
          this.emit({ type: 'tool', name: 'Patch', input: { changes: item.changes } })
        } else if (item.type === 'webSearch') {
          this.emit({ type: 'tool', name: 'WebSearch', input: { query: item.query } })
        } else if (item.type === 'mcpToolCall') {
          this.emit({
            type: 'tool',
            name: item.tool ?? 'mcp',
            input: { server: item.server }
          })
        }
        break
      }
      case 'item/completed': {
        const item = p['item'] as CodexItem | undefined
        if (!item) break
        if (item.type === 'agentMessage' && item.text) {
          this.emit({ type: 'text', text: item.text })
        } else if (item.type === 'commandExecution') {
          const out = item.aggregatedOutput ?? ''
          if (out.trim()) {
            this.emit({
              type: 'tool-result',
              text: firstLines(out, RESULT_MAX),
              isError: (item.exitCode ?? 0) !== 0
            })
          }
        }
        break
      }
      case 'thread/compacted':
        this.emit({ type: 'command-output', text: 'contexto da thread compactado' })
        break
      case 'thread/tokenUsage/updated': {
        const usage = p['tokenUsage'] as
          | { total?: { totalTokens?: number }; modelContextWindow?: number }
          | undefined
        if (usage?.total?.totalTokens) this.lastTokens = usage.total.totalTokens
        // Janela REAL do modelo, direto do protocolo (ex.: 258400 no GPT-5.6).
        if (usage?.modelContextWindow) this.lastWindow = usage.modelContextWindow
        break
      }
      case 'turn/completed': {
        const turn = p['turn'] as
          | { status?: string; error?: { message?: string } }
          | undefined
        this.turnId = null
        this.wantInterrupt = false
        this.emit({
          type: 'result',
          isError: turn?.status === 'failed',
          errorText: turn?.error?.message,
          contextTokens: this.lastTokens,
          contextWindow: this.lastWindow
        })
        break
      }
      case 'error': {
        const m = p['message']
        this.emit({
          type: 'limit',
          text: `codex: ${typeof m === 'string' ? m : JSON.stringify(p).slice(0, 200)}`
        })
        break
      }
      default:
        break
    }
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { freshWindowsPath } from './winPath'
import { guiToolResultDetails } from './guiToolResults'
import {
  GuiProtocolStream,
  isGuiCodexProtocolEnvelope,
  parseGuiProtocolLine
} from './guiProtocolLine'
import {
  canFlushGuiTurnResult,
  GUI_ACTIVE_TURN_SILENCE_TIMEOUT,
  ownsFailedGuiSteer,
  shouldArmGuiTurnWatchdog
} from './guiTurnQueue'
import { limitGuiToolInput } from './guiToolInput'
import { codexContextFromTokenUsage } from './codexTokenUsage'
import { terminateGuiProcessTree } from './guiProcessTree'
import {
  guiCodexErrorWillRetry,
  guiCodexToolCompletion,
  guiCodexTurnOutcome,
  isGuiCodexToolType,
  type GuiCodexCompletedItem
} from './guiCodexTools'
import {
  GuiCodexAgentRegistry,
  guiCodexAgentThreadId,
  type GuiCodexAgent
} from './guiCodexAgents'
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

/** Cerca anti-subagente NATIVO, aplicada POR THREAD. Sondada no codex-cli
 *  0.147 (2026-08-18, relatório probe-codex-fence §A.2): `ThreadStartParams` e
 *  `ThreadResumeParams` aceitam `config`, e `features.multi_agent=false` REMOVE
 *  a ferramenta de colaboração do catálogo do modelo — com o MESMO prompt que
 *  sem a cerca abre um subagente, o modelo responde "spawn_agent tool is
 *  unavailable". Prosa não cerca (na sonda o modelo furou uma proibição
 *  absoluta entregue por config), então ou a cerca é mecânica ou não existe.
 *
 *  Este é o SUSPENSÓRIO: o cinto é `-c features.multi_agent=false` nos args do
 *  `app-server`, que chega por `extraArgs` na costura do spawn (sem espaço no
 *  valor — é o que sobrevive ao `shell: true` do Windows). A cerca por thread
 *  vale mesmo quando o processo nasceu sem o `-c`, e acompanha o resume.
 *  Chave desconhecida é ignorada em silêncio pelo binário: a cerca nunca
 *  derruba a thread — por isso o rastreio de spawn nativo abaixo continua vivo
 *  como espelho honesto, em vez de confiar que a cerca está sempre armada. */
export function codexNativeAgentFenceConfig(): Record<string, unknown> {
  return { features: { multi_agent: false } }
}

/**
 * O NOME do nosso servidor MCP dentro do codex. É o mesmo literal que
 * `guiPlannerCodexArgs` escreve em `mcp_servers.synkora.*` — a única coisa que
 * o `mcpServer/elicitation/request` nos dá para reconhecer a origem é este
 * nome, e por isso ele mora aqui, do lado de quem julga.
 *
 * Duplicar o literal em vez de importar é deliberado: a suíte
 * `test:codex-collab-signals` compila SÓ este arquivo, e puxar o módulo de
 * arme traria o SDK do MCP inteiro para dentro de um teste puro. O par vive
 * fixado nos DOIS lados — `scripts/test-gui-delegate-mcp.mjs` prende o mesmo
 * literal nos args reais do spawn, então uma divergência quebra as duas.
 */
export const CODEX_SYNKORA_MCP_SERVER_NAME = 'synkora'

/** O que fazer com um `mcpServer/elicitation/request`. */
export type CodexElicitationVerdict =
  | { kind: 'accept'; content: Record<string, unknown> }
  | { kind: 'refuse' }

/**
 * ELICITATION DO CODEX = APROVAÇÃO DE CHAMADA DE TOOL MCP (bug ao vivo de
 * 2026-08-18 15:08, reproduzido 1:1 na sonda `scratchpad/probe-elicit`).
 *
 * Um chat de missão codex nasce com `permissionMode: 'default'`, e
 * `guiPermissionProfile('codex','default')` é `{}`: nem sandbox nem
 * approvalPolicy viajam. Sem approvalPolicy explícita vale o default de
 * config, e o config dir de um seat não define `approval_policy` — ou seja, o
 * default embutido do binário, que é `on-request`. Nesse regime o 0.147 pede
 * aprovação de CADA chamada de tool MCP por este request server→cliente:
 *
 *   { serverName:"synkora", mode:"form", threadId, turnId,
 *     _meta:{ codex_approval_kind:"mcp_tool_call", persist:["session","always"],
 *             tool_description, tool_params, tool_params_display },
 *     message:'Allow the synkora MCP server to run tool "list_seats"?',
 *     requestedSchema:{ type:"object", properties:{} } }
 *
 * A recusa genérica que existia aqui respondia `{decision:'decline'}` e o
 * app-server derrubava a chamada com "user rejected MCP tool call" — o chat
 * do dono ficava sem `list_seats` e o modelo passava a CHUTAR conta. As
 * sondas da onda 2 nunca viram isto porque rodaram com `approvalPolicy:
 * 'never'`, e o `~/.codex` desta máquina também tem `approval_policy =
 * "never"` gravado: o regime do bug só aparece com um config dir de seat.
 *
 * A REGRA, na doutrina do dono (a delegação é o caminho sancionado, controle
 * total, zero burocracia): aprovar a NOSSA PRÓPRIA ferramenta não é decisão
 * do dono — é encanamento. Então:
 *
 *  - servidor nosso + formulário que não pede NADA (o caso da aprovação) →
 *    `accept` em silêncio, sem card e sem aviso;
 *  - servidor nosso + campo com `default` → responde o default declarado;
 *  - servidor nosso + campo obrigatório SEM default → recusa: inventar dado
 *    em nome do dono seria fabricar resposta;
 *  - modo `url` (reautenticação) ou servidor DESCONHECIDO → recusa, com a
 *    mensagem de sempre. Um servidor de terceiro pedindo dados nunca é
 *    respondido às escondidas.
 *
 * Pura e exportada de propósito: é a regra, e ela é testada sem processo.
 */
export function codexElicitationVerdict(p: Record<string, unknown>): CodexElicitationVerdict {
  if (p['serverName'] !== CODEX_SYNKORA_MCP_SERVER_NAME) return { kind: 'refuse' }
  // `openai/form` traz schema opaco e `url` não tem o que responder daqui.
  if (p['mode'] !== 'form') return { kind: 'refuse' }
  const schema = (p['requestedSchema'] ?? {}) as {
    properties?: Record<string, { default?: unknown } | undefined>
    required?: unknown
  }
  const declared = Array.isArray(schema.required) ? schema.required : []
  const required = new Set(declared.filter((key): key is string => typeof key === 'string'))
  const content: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const fallback = field?.default
    if (fallback !== undefined && fallback !== null) {
      content[key] = fallback
      continue
    }
    if (required.has(key)) return { kind: 'refuse' }
  }
  return { kind: 'accept', content }
}

/** Opções do painel codex: as de sempre mais a cerca acima, que só existe deste
 *  lado (no claude a mesma ordem do dono vira `--disallowedTools`, por
 *  `extraArgs`). Default DESLIGADO — quem decide é a costura do spawn: chat de
 *  missão e helper nascem cercados, o chat do planejador fica como está. */
export interface CodexSessionOpts extends MaestroSessionOpts {
  suppressNativeAgents?: boolean
}

interface RpcResponse {
  result?: Record<string, unknown>
  error?: { message?: string; timeout?: boolean }
}

interface PendingRpc {
  resolve: (msg: RpcResponse) => void
  timer: NodeJS.Timeout
}

interface PendingTurnStart {
  generation: number
  operationId: number | null
  done: Promise<void>
  resolve: () => void
}

interface JsonRpcMsg {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

interface CodexItem extends GuiCodexCompletedItem {
  type?: string
  id?: string
  text?: string
  command?: unknown
  cwd?: string
  query?: string
  tool?: string
  server?: string
  changes?: unknown
  senderThreadId?: string
  receiverThreadId?: string
  newThreadId?: string
  receiverThreadIds?: unknown
  receiverAgents?: unknown
  agentsStates?: unknown
  prompt?: string
  agentStatus?: unknown
  model?: string
  agentNickname?: string
  agentRole?: string
  /** `subAgentActivity`: started | interacted | interrupted (enum ABERTO). */
  kind?: string
  agentThreadId?: string
  agentPath?: string
}

type GuiCodexCollabOutcome = 'completed' | 'failed' | 'cancelled'

function guiCodexString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function guiCodexRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isGuiCodexCollabType(type: string | undefined): boolean {
  return type === 'collabToolCall' || type === 'collabAgentToolCall'
}

function guiCodexCollabTool(value: unknown): string | undefined {
  const raw = guiCodexString(value)
  if (!raw) return undefined
  return raw.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`).toLowerCase()
}

function guiCodexCollabThreadIds(item: CodexItem): string[] {
  const ids = new Set<string>()
  for (const value of [item.receiverThreadId, item.newThreadId]) {
    const id = guiCodexString(value)
    if (id) ids.add(id)
  }
  if (Array.isArray(item.receiverThreadIds)) {
    for (const value of item.receiverThreadIds) {
      const id = guiCodexString(value)
      if (id) ids.add(id)
    }
  }
  if (Array.isArray(item.receiverAgents)) {
    for (const value of item.receiverAgents) {
      const agent = guiCodexRecord(value)
      const id = guiCodexString(agent?.['threadId'] ?? agent?.['thread_id'] ?? agent?.['id'])
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

// `CollabAgentStatus` do schema do binário: pendingInit | running | interrupted
// | completed | errored | shutdown | notFound. Tratado como enum ABERTO — valor
// desconhecido não encerra nada (null), mas `notFound` SIM: agente que sumiu do
// servidor nunca pode pendurar o card do pai.
function guiCodexCollabOutcome(value: unknown): GuiCodexCollabOutcome | null {
  const record = guiCodexRecord(value)
  const status = guiCodexString(record?.['status'] ?? value)?.toLowerCase()
  if (
    !status ||
    ['pending', 'pendinginit', 'running', 'working', 'inprogress', 'in_progress', 'waiting'].includes(
      status
    )
  )
    return null
  if (['failed', 'error', 'errored', 'notfound'].includes(status)) return 'failed'
  if (['cancelled', 'canceled', 'interrupted', 'closed', 'shutdown'].includes(status))
    return 'cancelled'
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status))
    return 'completed'
  return null
}

/** Fala final do sub-agente: o último `agentMessage` do turno dele (o protocolo
 *  marca a resposta com `phase: "final_answer"`; sem a marca, vale a última
 *  mensagem mesmo assim). Vira o TEXTO do card do pai — nunca uma mensagem do
 *  fio principal. */
function guiCodexAgentFinalText(turn: unknown): string | undefined {
  const items = guiCodexRecord(turn)?.['items']
  if (!Array.isArray(items)) return undefined
  let fallback: string | undefined
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = guiCodexRecord(items[index])
    if (!item || item['type'] !== 'agentMessage') continue
    const text = guiCodexString(item['text'])
    if (!text) continue
    if (item['phase'] === 'final_answer') return firstLines(text, 4_000)
    fallback ??= firstLines(text, 4_000)
  }
  return fallback
}

function guiCodexCollabMessage(value: unknown): string | undefined {
  const record = guiCodexRecord(value)
  return guiCodexString(record?.['message'] ?? record?.['text'] ?? record?.['output'])
}

const IDLE_TIMEOUT = 600_000
const INTERRUPT_CONFIRM_TIMEOUT = 10_000
const RPC_TIMEOUT = 20_000
const TURN_START_CONFIRM_TIMEOUT = 10_000
const TURN_ERROR_CONFIRM_TIMEOUT = 10_000

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
  ['/logout', 'login/logout é por seat, em Configurações › Minhas contas'],
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
  const sliced = text.slice(0, Math.max(0, max) + 1).trim()
  return sliced.length <= max ? sliced : sliced.slice(0, max) + '…'
}

function boundedJson(value: Record<string, unknown>, max = 2000): string {
  try {
    return firstLines(JSON.stringify(limitGuiToolInput(value), null, 2), max)
  } catch {
    return '{ pedido indisponível para visualização }'
  }
}

function commandResultEvent(
  raw: string,
  isError: boolean,
  toolUseId?: string,
  outcome?: 'completed' | 'failed' | 'denied' | 'cancelled'
): Extract<SessionEvent, { type: 'tool-result' }> {
  const details = guiToolResultDetails(raw)
  return {
    type: 'tool-result',
    text: details.text,
    isError,
    outcome: outcome ?? (isError ? 'failed' : 'completed'),
    toolUseId,
    lineCount: details.lineCount,
    truncated: details.truncated
  }
}

function commandText(command: unknown): string {
  if (typeof command === 'string') return firstLines(command, 64 * 1024)
  if (Array.isArray(command)) {
    let output = ''
    for (const part of command.slice(0, 256)) {
      const next = typeof part === 'string' ? part : boundedJson({ part }, 4_000)
      const separator = output ? ' ' : ''
      const room = 64 * 1024 - output.length - separator.length
      if (room <= 0) return `${output}…`
      output += `${separator}${next.slice(0, room)}`
      if (next.length > room) return `${output}…`
    }
    return output
  }
  return boundedJson({ command }, 64 * 1024)
}

export class CodexSession {
  readonly opts: CodexSessionOpts
  // Persona vai como developerInstructions no thread/start — nunca no prompt.
  personaSent = true
  readyAnnounced = false
  caps: CliCaps | null = null
  private child: ChildProcessWithoutNullStreams
  private emit: (evt: SessionEvent) => void
  private persona: string
  private protocol = new GuiProtocolStream()
  private stderrTail = ''
  private killed = false
  private closed = false
  private idleTimer: NodeJS.Timeout | null = null
  private turnSilenceTimer: NodeJS.Timeout | null = null
  private nextId = 1
  private pending = new Map<number, PendingRpc>()
  private approvals = new Map<
    string,
    { rpcId: number | string; toolUseId?: string; toolName: string; description: string }
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
  private interruptTimer: NodeJS.Timeout | null = null
  private interruptedTurnId: string | null = null
  private turnStartGeneration = 0
  private pendingTurnStart: PendingTurnStart | null = null
  private turnStartTimer: NodeJS.Timeout | null = null
  private interruptedStartGeneration: number | null = null
  private turnErrorTimer: NodeJS.Timeout | null = null
  /** Sends aceitos cujo steer/start ainda não encontrou destino definitivo. */
  private nextSendOperation = 0
  private pendingSendOperations = new Set<number>()
  private terminalReconcilePending = false
  /** O app-server entrega collabToolCall separado da mensagem principal. A
   *  raiz fica ativa até o estado factual do filho encerrar; o terminal do
   *  turno é retido para som/toast nunca anunciarem antes dos agentes. */
  private activeCollabParentIds = new Set<string>()
  private collabParentByThreadId = new Map<string, string>()
  private startedCollabToolIds = new Set<string>()
  private deferredCollabResult: Extract<SessionEvent, { type: 'result' }> | null = null
  /** Sub-agentes NATIVOS vivos: a chave é o thread do FILHO, e é ela que faz o
   *  roteador aceitar os frames dele. Alimentado pelas duas formas de spawn —
   *  o `collabAgentToolCall`/`spawnAgent` do 0.147 (que entrega
   *  `receiverThreadIds` no `item/completed`) e o `subAgentActivity` legado. */
  private codexAgents = new GuiCodexAgentRegistry()

  constructor(opts: CodexSessionOpts, persona: string, emit: (evt: SessionEvent) => void) {
    this.opts = opts
    this.persona = persona
    this.emit = emit

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath()
    }
    if (opts.configDir) env['CODEX_HOME'] = opts.configDir
    for (const [key, value] of Object.entries(opts.extraEnv ?? {})) env[key] = value

    // shell:true para o PATH do env resolver o binário (mesmo padrão do chat
    // antigo). `-c` é opção do PRÓPRIO subcomando `app-server` (sondado no
    // 0.147: `codex app-server -c mcp_servers.…` sobe e responde o initialize),
    // e os valores chegam sem aspas de propósito — o shell não escapa nada.
    this.child = spawn('codex', ['app-server', ...(opts.extraArgs ?? [])], {
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
        this.emit({ type: 'fatal', text: 'o Codex excedeu o limite de uma mensagem de protocolo' })
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
      this.cancelLiveCodexAgents()
      this.clearIdle()
      this.clearTurnSilence()
      this.clearInterruptGuard()
      this.clearTurnStartGuard()
      this.clearTurnErrorGuard()
      this.cancelPendingInteractions()
      this.failPendingRpcs(e.message)
      this.emit({ type: 'fatal', text: e.message })
    })
    this.child.on('close', (code) => {
      const failedBeforeClose = this.closed
      this.closed = true
      const final = this.protocol.end()
      for (const line of final.lines) this.handleLine(line)
      // Cada card do sub-agente fecha ANTES do terminal da conversa: o processo
      // morreu e ninguém mais vai reportar por eles.
      this.cancelLiveCodexAgents()
      this.clearIdle()
      this.clearTurnSilence()
      this.clearInterruptGuard()
      this.clearTurnStartGuard()
      this.clearTurnErrorGuard()
      this.cancelPendingInteractions()
      this.failPendingRpcs('o painel codex encerrou')
      for (const w of this.capsWaiters.splice(0)) w(this.caps)
      if (!this.killed && !failedBeforeClose) {
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
        this.kill()
        return
      }
      this.notify('initialized', {})
      void this.loadCaps()
    })
  }

  get alive(): boolean {
    return !this.killed && !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Modelo/effort são por turno no Codex — só cwd/seat exigem processo novo. */
  matches(opts: MaestroSessionOpts): boolean {
    return (
      this.opts.cwd === opts.cwd && (this.opts.configDir ?? '') === (opts.configDir ?? '')
    )
  }

  send(text: string): void {
    const operationId = ++this.nextSendOperation
    this.pendingSendOperations.add(operationId)
    void this.startTurn(text, operationId).catch((e: unknown) => {
      const pending = this.pendingTurnStart
      if (pending?.operationId === operationId) this.clearTurnStartGuard(pending.generation)
      this.emitTurnResult({
        type: 'result',
        isError: true,
        errorText: e instanceof Error ? e.message : String(e)
      })
    })
  }

  answerPermission(
    requestId: string,
    choice: PermissionChoice
  ): { toolUseId?: string; toolName: string; description: string } | null {
    const req = this.approvals.get(requestId)
    if (!req) return null
    this.approvals.delete(requestId)
    const decision =
      choice === 'deny' ? 'decline' : choice === 'allow-always' ? 'acceptForSession' : 'accept'
    this.respond(req.rpcId, { decision })
    this.resetIdle()
    return {
      ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
      toolName: req.toolName,
      description: req.description
    }
  }

  interrupt(): boolean {
    if (this.threadId && this.turnId) {
      const interruptedTurnId = this.turnId
      // Enquanto a tentativa deste mesmo turno está aguardando o terminal,
      // cliques repetidos são idempotentes. Assim uma resposta antiga nunca
      // pode invalidar uma tentativa mais nova.
      if (this.interruptedTurnId === interruptedTurnId && this.interruptTimer) return true
      this.clearInterruptGuard()
      this.interruptedTurnId = interruptedTurnId
      this.interruptTimer = setTimeout(() => {
        this.failInterrupt(interruptedTurnId, 'o Codex não confirmou a interrupção')
      }, INTERRUPT_CONFIRM_TIMEOUT)
      void this.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: interruptedTurnId
      }).then((r) => {
        if (r.error)
          this.failInterrupt(
            interruptedTurnId,
            `não deu para interromper o turno: ${r.error.message ?? 'erro sem detalhe'}`
          )
      })
      return true
    }
    if (this.pendingTurnStart) {
      const generation = this.pendingTurnStart.generation
      this.interruptedStartGeneration = generation
      this.armTurnStartGuard(generation)
      return true
    }
    return false
  }

  get turnActive(): boolean {
    return Boolean(
      this.turnId ||
      this.pendingTurnStart ||
      this.pendingSendOperations.size > 0 ||
      this.activeCollabParentIds.size > 0 ||
      this.codexAgents.size > 0 ||
      this.deferredCollabResult
    )
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
    if (!this.alive || this.turnActive) return Promise.resolve(false)
    this.opts.model = model && model !== 'default' ? model : undefined
    return Promise.resolve(true)
  }

  /** Overrides por turno: a conversa e o processo continuam intactos; o
   *  próximo `turn/start` lê o novo par de `opts`. */
  setExecutor(input: { model?: string; effort?: string }): Promise<boolean> {
    if (!this.alive || this.turnActive) return Promise.resolve(false)
    this.opts.model = input.model
    this.opts.effort = input.effort
    return Promise.resolve(true)
  }

  /** Comandos slash do codex, cada um via RPC real. false = comando não existe. */
  runSlash(raw: string): boolean {
    const trimmed = raw.trim()
    const cmd = trimmed.split(/\s+/)[0]
    const arg = trimmed.slice(cmd.length).trim()
    const run = (fn: () => Promise<void>): boolean => {
      void fn().catch((e: unknown) => {
        this.finishCommand(e instanceof Error ? e.message : String(e), true)
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

  private finishCommand(text: string, isError = false): void {
    if (!isError) this.emit({ type: 'command-output', text })
    this.emit({
      type: 'command-completed',
      isError,
      continues: this.turnActive,
      ...(isError ? { errorText: text } : {})
    })
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
    if (this.turnActive) {
      this.finishCommand('o /review só pode começar entre turnos — interrompa ou aguarde o trabalho atual')
      return
    }
    const pending = this.beginTurnStart(null)
    try {
      const ok = await this.ensureThread()
      if (!ok) throw new Error('painel codex sem thread')
      const resp = await this.request('review/start', {
        threadId: this.threadId,
        target: { type: 'uncommittedChanges' },
        delivery: 'inline'
      })
      // A notificação turn/started pode preceder a resposta RPC; nesse caso
      // ela já provou o sucesso e limpou esta guarda.
      if (resp.error && this.isPendingTurnStart(pending.generation))
        throw new Error(resp.error.message ?? 'review/start falhou')
      if (this.isPendingTurnStart(pending.generation)) this.armTurnStartGuard(pending.generation)
    } catch (error) {
      this.clearTurnStartGuard(pending.generation)
      throw error
    }
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
    if (this.killed) return
    this.killed = true
    this.cancelLiveCodexAgents()
    this.cancelPendingInteractions()
    this.pendingSendOperations.clear()
    this.terminalReconcilePending = false
    this.activeCollabParentIds.clear()
    this.collabParentByThreadId.clear()
    this.startedCollabToolIds.clear()
    this.deferredCollabResult = null
    this.clearIdle()
    this.clearTurnSilence()
    this.clearInterruptGuard()
    this.clearTurnStartGuard()
    this.clearTurnErrorGuard()
    this.failPendingRpcs('painel codex encerrado')
    terminateGuiProcessTree(this.child)
  }

  // ————— internos —————

  private request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.alive) return Promise.resolve({ error: { message: 'painel codex morto' } })
    const id = this.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        resolve({
          error: {
            message: 'o Codex não respondeu ao pedido ' + method,
            timeout: true
          }
        })
      }, RPC_TIMEOUT)
      this.pending.set(id, { resolve, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private failPendingRpcs(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ error: { message } })
    }
    this.pending.clear()
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
    this.clearTurnSilence()
    if (this.approvals.size > 0) return // esperando o humano
    if (
      shouldArmGuiTurnWatchdog(
        this.opts.idleTimeoutMs,
        Boolean(this.turnId || this.pendingTurnStart),
        false
      )
    ) {
      this.turnSilenceTimer = setTimeout(() => {
        if (!this.alive || (!this.turnId && !this.pendingTurnStart) || this.approvals.size > 0)
          return
        this.emit({ type: 'fatal', text: 'o Codex ficou sem responder durante o turno' })
        this.kill()
      }, GUI_ACTIVE_TURN_SILENCE_TIMEOUT)
    }
    const timeout = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT
    if (timeout <= 0) return // relógio desligado (pane GUI)
    this.idleTimer = setTimeout(() => {
      this.emit({ type: 'fatal', text: 'sem resposta do codex há 10 min — sessão encerrada' })
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
    const requestIds = [...this.approvals.keys()]
    this.approvals.clear()
    for (const requestId of requestIds) {
      this.emit({ type: 'permission-cancel', requestId })
    }
  }

  private clearInterruptGuard(): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer)
    this.interruptTimer = null
    this.interruptedTurnId = null
  }

  private beginTurnStart(operationId: number | null): PendingTurnStart {
    const generation = ++this.turnStartGeneration
    let resolve = (): void => undefined
    const done = new Promise<void>((release) => {
      resolve = release
    })
    const pending = { generation, operationId, done, resolve }
    this.pendingTurnStart = pending
    this.resetIdle()
    this.reconcileTerminalContinuation()
    return pending
  }

  private emitTurnResult(
    result: Extract<SessionEvent, { type: 'result' }>,
    ignoreOperationId?: number
  ): void {
    const pendingOperations =
      this.pendingSendOperations.size -
      (ignoreOperationId !== undefined && this.pendingSendOperations.has(ignoreOperationId)
        ? 1
        : 0)
    const hasTurnDestination = Boolean(this.pendingTurnStart || this.turnId)
    this.emit({ ...result, continues: pendingOperations > 0 || hasTurnDestination })
    this.terminalReconcilePending = pendingOperations > 0 && !hasTurnDestination
  }

  private reconcileTerminalContinuation(): void {
    if (!this.terminalReconcilePending || !this.alive) return
    const hasTurnDestination = Boolean(this.pendingTurnStart || this.turnId)
    if (!canFlushGuiTurnResult(this.pendingSendOperations.size, hasTurnDestination)) return
    this.terminalReconcilePending = false
    this.emit({
      type: 'turn-continuation',
      continues: this.pendingSendOperations.size > 0 || hasTurnDestination
    })
  }

  private collabParentForItem(item: CodexItem): string | undefined {
    for (const threadId of guiCodexCollabThreadIds(item)) {
      const parentId = this.collabParentByThreadId.get(threadId)
      if (parentId) return parentId
    }
    return undefined
  }

  /** Threads filhas de um `spawn_agent`: viram linhagem do card pai E entram no
   *  registro de sub-agentes. O registro é o que faz o roteador aceitar os
   *  frames do thread do FILHO (`handleNotification`) — sem ele o trabalho do
   *  subagente nativo é descartado inteiro. É a correção de fato da sonda de
   *  2026-08-18: `subAgentActivity` nunca é emitido pelo 0.147, e o sinal REAL
   *  de spawn é este par `collabAgentToolCall`/`spawnAgent`, cujo
   *  `item/completed` carrega `receiverThreadIds` + `agentsStates`.
   *  O card do pai continua sendo o ITEM do protocolo (ele nasce no
   *  `item/started`, quando o filho ainda não existe): o id sintético do
   *  registro só vale no caminho legado do `subAgentActivity`. */
  private rememberCollabThreads(parentId: string, item: CodexItem): string[] {
    const threadIds = guiCodexCollabThreadIds(item)
    for (const threadId of threadIds) {
      // Auto-referência (a raiz anunciada como filha de si mesma) esconderia a
      // conversa inteira atrás do roteador de sub-agentes.
      if (threadId === this.threadId) continue
      this.collabParentByThreadId.set(threadId, parentId)
      // Idempotente por desenho: started e completed do mesmo spawn chegam com
      // o payload repetido, e agente já encerrado nunca ressuscita.
      this.codexAgents.noteStarted(threadId, item.agentPath)
    }
    return threadIds
  }

  private collabParentInput(item: CodexItem): Record<string, unknown> {
    const receiver = Array.isArray(item.receiverAgents)
      ? guiCodexRecord(item.receiverAgents[0])
      : null
    const name = guiCodexString(
      item.agentNickname ?? receiver?.['agentNickname'] ?? receiver?.['nickname']
    )
    const type = guiCodexString(item.agentRole ?? receiver?.['agentRole'] ?? receiver?.['role'])
    const model = guiCodexString(item.model ?? receiver?.['model'])
    return {
      ...(name ? { name } : { name: 'subagente Codex' }),
      agent_type: type ?? 'codex',
      ...(model ? { model } : {}),
      ...(guiCodexString(item.prompt) ? { prompt: firstLines(item.prompt as string, 2_000) } : {})
    }
  }

  private startCollabItem(item: CodexItem): void {
    const itemId = guiCodexString(item.id)
    const tool = guiCodexCollabTool(item.tool)
    if (!itemId || !tool) return
    if (tool === 'spawn_agent') {
      this.activeCollabParentIds.add(itemId)
      this.rememberCollabThreads(itemId, item)
      this.startedCollabToolIds.add(itemId)
      this.emit({
        type: 'tool',
        name: 'spawn_agent',
        input: this.collabParentInput(item),
        toolUseId: itemId
      })
      return
    }
    const parentId = this.collabParentForItem(item)
    if (!parentId) return
    this.startedCollabToolIds.add(itemId)
    const threadId = guiCodexCollabThreadIds(item)[0]
    this.emit({
      type: 'tool',
      name: tool,
      input: {
        ...(threadId ? { thread_id: threadId } : {}),
        ...(guiCodexString(item.prompt) ? { prompt: firstLines(item.prompt as string, 2_000) } : {})
      },
      toolUseId: itemId,
      parentToolUseId: parentId
    })
  }

  private finishCollabParent(
    parentId: string,
    outcome: GuiCodexCollabOutcome,
    detail?: string
  ): void {
    if (!this.activeCollabParentIds.delete(parentId)) return
    for (const [threadId, mappedParent] of this.collabParentByThreadId) {
      if (mappedParent !== parentId) continue
      this.collabParentByThreadId.delete(threadId)
      // O registro fecha JUNTO com o card: o `turn/completed` do filho pode
      // chegar depois do veredito do `wait`, e um agente sobrevivente prenderia
      // o terminal do turno (`turnActive`) e fecharia um id sintético que card
      // nenhum abriu. Ferramenta do filho sem retorno cai aqui também.
      const agent = this.codexAgents.noteSettled(threadId)
      if (agent) this.closeChildToolCards(agent)
    }
    this.emit(commandResultEvent(
      detail ??
        (outcome === 'completed'
          ? 'subagente concluído'
          : outcome === 'failed'
            ? 'subagente falhou'
            : 'subagente cancelado'),
      outcome === 'failed',
      parentId,
      outcome
    ))
    this.flushDeferredCollabResult()
  }

  private finishCollabItem(item: CodexItem): void {
    const itemId = guiCodexString(item.id)
    const tool = guiCodexCollabTool(item.tool)
    if (!itemId || !tool) return
    const threadIds = tool === 'spawn_agent'
      ? this.rememberCollabThreads(itemId, item)
      : guiCodexCollabThreadIds(item)

    if (tool !== 'spawn_agent' && this.startedCollabToolIds.delete(itemId)) {
      const completed = guiCodexToolCompletion(item)
      this.emit(commandResultEvent(completed.text, completed.isError, itemId, completed.outcome))
    }

    const stateEntries: { threadId?: string; value: unknown }[] = []
    const agentsStates = guiCodexRecord(item.agentsStates)
    if (agentsStates) {
      for (const [threadId, value] of Object.entries(agentsStates)) {
        stateEntries.push({ threadId, value })
      }
    }
    if (Array.isArray(item.receiverAgents)) {
      for (const value of item.receiverAgents) {
        const agent = guiCodexRecord(value)
        if (!agent) continue
        stateEntries.push({
          threadId: guiCodexString(agent['threadId'] ?? agent['thread_id'] ?? agent['id']),
          value: agent['status'] ?? agent['agentStatus']
        })
      }
    }
    if (item.agentStatus !== undefined) {
      stateEntries.push({ threadId: threadIds[0], value: item.agentStatus })
    }

    for (const state of stateEntries) {
      const outcome = guiCodexCollabOutcome(state.value)
      if (!outcome) continue
      const parentId = tool === 'spawn_agent'
        ? itemId
        : state.threadId
          ? this.collabParentByThreadId.get(state.threadId)
          : this.collabParentForItem(item)
      if (parentId) this.finishCollabParent(parentId, outcome, guiCodexCollabMessage(state.value))
    }

    if (tool === 'spawn_agent') {
      if (item.status?.toLowerCase() === 'failed' || item.error) {
        this.finishCollabParent(itemId, 'failed', guiCodexCollabMessage(item.error))
      } else if (threadIds.length === 0 && stateEntries.length === 0) {
        this.finishCollabParent(itemId, 'failed', 'o Codex não informou a identidade do subagente')
      }
      return
    }

    if (tool === 'close_agent' && stateEntries.length === 0) {
      const parentId = this.collabParentForItem(item)
      if (parentId) this.finishCollabParent(parentId, 'cancelled')
    }
  }

  private flushDeferredCollabResult(): void {
    if (
      this.activeCollabParentIds.size > 0 ||
      this.codexAgents.size > 0 ||
      !this.deferredCollabResult
    )
      return
    const result = this.deferredCollabResult
    this.deferredCollabResult = null
    this.emitTurnResult(result)
  }

  // ————— sub-agentes: registro do filho + frames do thread dele —————

  /** Card de ferramenta do Codex. A MESMA projeção serve para a raiz e para o
   *  thread de um sub-agente — só a linhagem (`parentToolUseId`) muda. */
  private codexToolEvent(item: CodexItem): Extract<SessionEvent, { type: 'tool' }> | null {
    switch (item.type) {
      case 'commandExecution':
        return {
          type: 'tool',
          name: 'Bash',
          input: { command: commandText(item.command), cwd: item.cwd },
          toolUseId: item.id
        }
      case 'fileChange':
        return { type: 'tool', name: 'Patch', input: { changes: item.changes }, toolUseId: item.id }
      case 'webSearch':
        return { type: 'tool', name: 'WebSearch', input: { query: item.query }, toolUseId: item.id }
      case 'mcpToolCall':
        return {
          type: 'tool',
          name: item.tool ?? 'mcp',
          input: { server: item.server },
          toolUseId: item.id
        }
      default:
        return null
    }
  }

  /** `subAgentActivity` no thread RAIZ: sinal de spawn dos binários que o
   *  emitem. O codex-cli 0.147 NÃO emite (sonda de 2026-08-18: zero ocorrências
   *  em 6 rodadas vivas com spawn real) — lá quem anuncia é o
   *  `collabAgentToolCall`/`spawnAgent` tratado acima. Este caminho fica como
   *  compatibilidade: se um binário voltar a emitir, o card nasce por aqui, com
   *  o id SINTÉTICO do registro (não há item de protocolo para o spawn).
   *  `item/started` e `item/completed` chegam com payload IDÊNTICO ~1ms depois
   *  um do outro — o registro faz o dedupe e o card nasce uma vez só. */
  private noteSubAgentActivity(item: CodexItem): void {
    const agentThreadId = guiCodexAgentThreadId(item.agentThreadId)
    // Id torto e auto-referência (raiz registrada como filha de si mesma) nunca
    // entram: é o registro que o roteador consulta para decidir o que é fala de
    // filho, e a raiz não pode se esconder de si mesma.
    if (!agentThreadId || agentThreadId === this.threadId) return
    const kind = guiCodexString(item.kind)?.toLowerCase()
    if (kind === 'interrupted') {
      const interrupted = this.codexAgents.noteInterrupted(agentThreadId)
      if (interrupted) this.emitCodexAgentSettled(interrupted, 'cancelled')
      return
    }
    // `interacted` — e qualquer kind que o enum ganhe depois — é no-op: só
    // 'started' registra, então kind desconhecido no máximo deixa de mostrar um
    // card, nunca prende o turno num agente que ninguém encerraria.
    if (kind !== 'started') return
    const agent = this.codexAgents.noteStarted(agentThreadId, item.agentPath)
    if (!agent) return
    this.emit({
      type: 'tool',
      name: 'spawn_agent',
      input: {
        name: agent.name ?? 'subagente Codex',
        agent_type: 'codex',
        ...(agent.agentPath ? { path: agent.agentPath } : {})
      },
      toolUseId: agent.toolUseId
    })
  }

  /** Frames do thread do FILHO. Só ferramenta atravessa — carimbada com a
   *  linhagem do card pai — e o `turn/completed` dele encerra o card. Fala de
   *  filho (agentMessage, deltas, raciocínio, contexto) NUNCA entra no fio
   *  principal, e o contexto/turnId da conversa do dono continua intocado. */
  private handleSubAgentNotification(
    agentThreadId: string,
    method: string,
    p: Record<string, unknown>
  ): void {
    switch (method) {
      case 'turn/completed': {
        const turn = guiCodexRecord(p['turn'])
        const agent = this.codexAgents.noteSettled(agentThreadId)
        if (!agent) return
        // `TurnStatus` é enum ABERTO: qualquer valor encerra o card. Pendurar o
        // agente seria pior que classificá-lo errado.
        const outcome = guiCodexTurnOutcome(guiCodexString(turn?.['status']))
        this.emitCodexAgentSettled(
          agent,
          outcome,
          guiCodexAgentFinalText(turn) ?? guiCodexCollabMessage(turn?.['error'])
        )
        break
      }
      case 'item/started': {
        const item = p['item'] as CodexItem | undefined
        const event = item ? this.codexToolEvent(item) : null
        if (!event) break
        const registered = this.codexAgents.noteChildTool(agentThreadId, item?.id)
        if (!registered) break
        this.emit({
          ...event,
          parentToolUseId: this.agentParentToolUseId(agentThreadId, registered)
        })
        break
      }
      case 'item/completed': {
        const item = p['item'] as CodexItem | undefined
        if (!item || !isGuiCodexToolType(item.type)) break
        if (!this.codexAgents.noteChildToolDone(agentThreadId, item.id)) break
        const completed = guiCodexToolCompletion(item)
        this.emit(
          commandResultEvent(completed.text, completed.isError, item.id, completed.outcome)
        )
        break
      }
      default:
        break
    }
  }

  /** Card PAI de um sub-agente registrado: o item do protocolo quando o spawn
   *  veio por `collabAgentToolCall` (o card já existe no anel com esse id), o
   *  id sintético do registro no caminho legado do `subAgentActivity`. Um id
   *  sintético emitido sobre um spawn collab seria linhagem para um card que
   *  ninguém abriu. */
  private agentParentToolUseId(agentThreadId: string, fallback: string): string {
    return this.collabParentByThreadId.get(agentThreadId) ?? fallback
  }

  /** Cards de ferramenta do filho que ficaram sem resultado fecham JUNTO com o
   *  sub-agente: o tool-result do Codex não carrega `agentStatus` (cerca entre
   *  os backends), então o renderer não cascateia sozinho — e card filho
   *  pendente faz o terminal do turno inventar o erro de órfão. */
  private closeChildToolCards(agent: GuiCodexAgent): void {
    for (const toolUseId of agent.openToolUseIds) {
      this.emit(commandResultEvent('encerrado com o subagente', false, toolUseId, 'cancelled'))
    }
  }

  /** Terminal do card do pai a partir do estado FACTUAL do filho. */
  private emitCodexAgentSettled(
    agent: GuiCodexAgent,
    outcome: GuiCodexCollabOutcome,
    detail?: string
  ): void {
    this.closeChildToolCards(agent)
    const collabParentId = this.collabParentByThreadId.get(agent.agentThreadId)
    if (collabParentId) {
      // Spawn nativo do 0.147: quem fecha é sempre o dono do card do protocolo,
      // uma vez só — o `wait` e o `turn/completed` do filho disputam o mesmo
      // desfecho, e quem chegar primeiro leva.
      this.finishCollabParent(collabParentId, outcome, detail)
    } else {
      this.emit(
        commandResultEvent(
          detail ??
            (outcome === 'completed'
              ? 'subagente concluído'
              : outcome === 'failed'
                ? 'subagente falhou'
                : 'subagente cancelado'),
          outcome === 'failed',
          agent.toolUseId,
          outcome
        )
      )
    }
    this.flushDeferredCollabResult()
  }

  /** Interrupção confirmada do turno raiz, `closed`, `fatal` e dispose levam os
   *  sub-agentes junto: drena o registro e fecha cada card como cancelado —
   *  ninguém errou, o turno é que acabou antes do terminal factual. */
  private cancelLiveCodexAgents(): void {
    for (const agent of this.codexAgents.settleAll()) {
      this.emitCodexAgentSettled(agent, 'cancelled')
    }
  }

  private isPendingTurnStart(generation: number): boolean {
    return this.pendingTurnStart?.generation === generation
  }

  private clearTurnStartGuard(generation?: number): void {
    const pending = this.pendingTurnStart
    if (generation !== undefined && pending?.generation !== generation) return
    if (this.turnStartTimer) clearTimeout(this.turnStartTimer)
    this.turnStartTimer = null
    this.pendingTurnStart = null
    this.interruptedStartGeneration = null
    pending?.resolve()
  }

  private armTurnStartGuard(generation: number): void {
    if (this.turnStartTimer) clearTimeout(this.turnStartTimer)
    this.turnStartTimer = setTimeout(() => {
      if (!this.alive || this.pendingTurnStart?.generation !== generation) return
      this.clearTurnStartGuard(generation)
      this.emit({ type: 'fatal', text: 'o Codex não confirmou o início do turno' })
      this.kill()
    }, TURN_START_CONFIRM_TIMEOUT)
  }

  private clearTurnErrorGuard(): void {
    if (this.turnErrorTimer) clearTimeout(this.turnErrorTimer)
    this.turnErrorTimer = null
  }

  private armTurnErrorGuard(message: string): void {
    this.clearTurnErrorGuard()
    if (!this.turnId && !this.pendingTurnStart) return
    this.turnErrorTimer = setTimeout(() => {
      if (!this.alive || (!this.turnId && !this.pendingTurnStart)) return
      this.clearTurnErrorGuard()
      this.emit({ type: 'fatal', text: message })
      this.kill()
    }, TURN_ERROR_CONFIRM_TIMEOUT)
  }

  private failInterrupt(turnId: string, message: string): void {
    if (!this.alive || this.turnId !== turnId || this.interruptedTurnId !== turnId) return
    this.clearInterruptGuard()
    this.turnId = null
    this.emit({ type: 'fatal', text: message })
    // Se não foi possível provar que o turno parou, encerra o processo:
    // deixar uma tool seguir sem controle seria pior do que perder o resume vivo.
    this.kill()
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
    // A cerca viaja no MESMO `base`, então vale no start E no resume: thread
    // retomada não volta a poder abrir subagente nativo.
    if (this.opts.suppressNativeAgents) base['config'] = codexNativeAgentFenceConfig()
    let resp: RpcResponse | null = null
    if (this.opts.resumeSessionId) {
      resp = await this.request('thread/resume', {
        threadId: this.opts.resumeSessionId,
        ...base
      })
      if (resp.error?.timeout) {
        this.emit({ type: 'fatal', text: resp.error.message ?? 'o Codex parou de responder' })
        this.kill()
        return false
      }
      if (resp.error) resp = null // thread sumiu — abre nova
    }
    if (!resp) resp = await this.request('thread/start', base)
    const thread = resp.result?.['thread'] as { id?: string } | undefined
    if (resp.error || !thread?.id) {
      this.emit({
        type: 'fatal',
        text: `não consegui abrir a thread do codex${resp.error?.message ? ` · ${resp.error.message}` : ''}`
      })
      this.kill()
      return false
    }
    this.threadId = thread.id
    this.emit({ type: 'session-id', sessionId: `codex-thread:${thread.id}` })
    return true
  }

  private async startTurn(text: string, operationId: number): Promise<void> {
    try {
      while (this.alive) {
        // Mensagem NO MEIO de um turno ativo = steering (igual ao TUI): entra no
        // turno em andamento via turn/steer. Se o turno acabou na corrida, cai
        // no turn/start normal.
        if (this.turnId) {
          const expectedTurnId = this.turnId
          const steer = await this.request('turn/steer', {
            threadId: this.threadId,
            expectedTurnId,
            input: [{ type: 'text', text }]
          })
          if (!steer.error) return
          // Timeout não prova rejeição: reenviar poderia executar a mensagem
          // duas vezes. Falha fechada antes de qualquer retry.
          if (steer.error.timeout) {
            this.emit({
              type: 'fatal',
              text: steer.error.message ?? 'o Codex parou de responder'
            })
            this.kill()
            return
          }
          // Uma resposta tardia do steer(A) não pode apagar um turnId=B que já
          // nasceu enquanto o RPC anterior estava em voo.
          if (!ownsFailedGuiSteer(this.turnId, expectedTurnId)) continue
          this.turnId = null
        }
        if (this.pendingTurnStart) {
          await this.pendingTurnStart.done
          continue
        }

        const pending = this.beginTurnStart(operationId)
        const ok = await this.ensureThread()
        if (!this.isPendingTurnStart(pending.generation)) return
        if (!ok) {
          this.clearTurnStartGuard(pending.generation)
          this.emitTurnResult({
            type: 'result',
            isError: true,
            errorText: 'painel codex sem thread'
          }, operationId)
          return
        }
        if (this.interruptedStartGeneration === pending.generation) {
          this.clearTurnStartGuard(pending.generation)
          this.emitTurnResult({
            type: 'result',
            isError: false,
            outcome: 'cancelled'
          }, operationId)
          return
        }
        const params: Record<string, unknown> = {
          threadId: this.threadId,
          input: [{ type: 'text', text }]
        }
        // id em minúsculas: "GPT-5.6-Luna" (display name vazado) dá 400 na API
        if (this.opts.model) params['model'] = this.opts.model.toLowerCase()
        if (this.opts.effort) params['effort'] = this.opts.effort
        if (this.opts.approvalPolicy) params['approvalPolicy'] = this.opts.approvalPolicy
        if (this.fastTier) params['serviceTier'] = 'priority'
        const resp = await this.request('turn/start', params)
        if (!this.isPendingTurnStart(pending.generation)) return
        if (resp.error) {
          this.clearTurnStartGuard(pending.generation)
          if (resp.error.timeout) {
            this.emit({
              type: 'fatal',
              text: resp.error.message ?? 'o Codex parou de responder'
            })
            this.kill()
            return
          }
          this.emitTurnResult({
            type: 'result',
            isError: true,
            errorText: resp.error.message ?? 'turn falhou'
          }, operationId)
          return
        }
        this.armTurnStartGuard(pending.generation)
        return
      }
    } finally {
      // Este finally pertence à MESMA continuação do RPC. Assim, um
      // turn/completed no mesmo chunk observa o Set já assentado.
      this.pendingSendOperations.delete(operationId)
      this.reconcileTerminalContinuation()
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    const parsed = parseGuiProtocolLine<unknown>(line)
    if (!parsed.ok || !isGuiCodexProtocolEnvelope(parsed.value)) {
      this.emit({ type: 'fatal', text: 'o Codex enviou uma resposta de protocolo inválida' })
      this.kill()
      return
    }
    const msg = parsed.value as JsonRpcMsg

    // Resposta a um request nosso.
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id as number)
      if (waiter) {
        this.pending.delete(msg.id as number)
        clearTimeout(waiter.timer)
        waiter.resolve({ result: msg.result, error: msg.error })
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
    const toolUseId = typeof p['itemId'] === 'string' ? p['itemId'] : undefined
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const desc = commandText(p['command'])
      const visibleDescription = firstLines(desc, 500)
      const visibleCwd = firstLines(
        typeof p['cwd'] === 'string' ? p['cwd'] : this.opts.cwd,
        500
      )
      this.approvals.set(requestId, {
        rpcId: id,
        ...(toolUseId ? { toolUseId } : {}),
        toolName: 'comando',
        description: visibleDescription
      })
      this.resetIdle()
      this.emit({
        type: 'permission',
        requestId,
        ...(toolUseId ? { toolUseId } : {}),
        toolName: 'comando',
        description: firstLines(visibleDescription, 160),
        inputPretty: boundedJson({ command: visibleDescription, cwd: visibleCwd }),
        reason: typeof p['reason'] === 'string' ? firstLines(p['reason'], 500) : undefined,
        canAlways: true
      })
      return
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const root = firstLines(
        typeof p['grantRoot'] === 'string' ? p['grantRoot'] : this.opts.cwd,
        500
      )
      this.approvals.set(requestId, {
        rpcId: id,
        ...(toolUseId ? { toolUseId } : {}),
        toolName: 'edição de arquivos',
        description: root
      })
      this.resetIdle()
      this.emit({
        type: 'permission',
        requestId,
        ...(toolUseId ? { toolUseId } : {}),
        toolName: 'edição de arquivos',
        description: root,
        inputPretty: boundedJson(p),
        reason: typeof p['reason'] === 'string' ? firstLines(p['reason'], 500) : undefined,
        canAlways: true
      })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      // Ver `codexElicitationVerdict`: com approvalPolicy != never, TODA
      // chamada de tool MCP passa por aqui. A nossa é pré-sancionada e é
      // aceita SEM RUÍDO — o recibo já existe no fio, no par tool/tool-result
      // da própria chamada. O resto cai na recusa de sempre, logo abaixo.
      const verdict = codexElicitationVerdict(p)
      if (verdict.kind === 'accept') {
        this.respond(id, { action: 'accept', content: verdict.content })
        return
      }
      this.emit({ type: 'limit', text: `pedido não suportado do codex negado: ${method}` })
      // `action` é o campo do McpServerElicitationRequestResponse; o
      // `{decision:...}` genérico chega como resposta ilegível e o app-server
      // trata como recusa por acidente. Recusar de propósito é melhor.
      this.respond(id, { action: 'decline' })
      return
    }
    // Pedido que a UI não suporta: nega para o turno seguir.
    this.emit({ type: 'limit', text: `pedido não suportado do codex negado: ${method}` })
    this.respond(id, { decision: 'decline' })
  }

  private handleNotification(method: string, p: Record<string, unknown>): void {
    const notificationThreadId = guiCodexString(p['threadId'])
    // Thread de sub-agente REGISTRADO tem rota própria: vira atividade do card
    // dele. Precisa vir ANTES da guarda abaixo, que é justamente o que hoje
    // descarta 100% do trabalho dos filhos.
    if (notificationThreadId && this.codexAgents.has(notificationThreadId)) {
      this.handleSubAgentNotification(notificationThreadId, method, p)
      return
    }
    // O app-server pode transmitir atividade de threads filhas na mesma
    // conexão. Ela alimenta o collabToolCall da raiz, nunca o texto animado,
    // o turnId ou o terminal da conversa que o usuário está vendo.
    if (notificationThreadId && this.threadId && notificationThreadId !== this.threadId) return
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = p['delta']
        if (typeof delta === 'string' && delta) this.emit({ type: 'delta', text: delta })
        break
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        // O delta do raciocínio viaja no mesmo campo do agentMessage/delta.
        const delta = p['delta']
        this.emit({ type: 'thinking', text: typeof delta === 'string' && delta ? delta : undefined })
        break
      }
      case 'turn/started': {
        const turn = p['turn'] as { id?: string } | undefined
        if (turn?.id) {
          const pending = this.pendingTurnStart
          const shouldInterrupt =
            pending !== null && this.interruptedStartGeneration === pending.generation
          this.turnId = turn.id
          if (pending) {
            // A notificação autoritativa dá destino a ESTE envio mesmo quando
            // a resposta RPC chega depois de turn/completed. Retirá-lo aqui
            // faz o resultado distinguir "A terminou" de "B ainda espera".
            if (pending.operationId !== null)
              this.pendingSendOperations.delete(pending.operationId)
            this.clearTurnStartGuard(pending.generation)
          }
          this.reconcileTerminalContinuation()
          if (shouldInterrupt) this.interrupt()
        }
        break
      }
      case 'item/started': {
        const item = p['item'] as CodexItem | undefined
        if (!item) break
        if (item.type === 'subAgentActivity') {
          this.noteSubAgentActivity(item)
          break
        }
        if (isGuiCodexCollabType(item.type)) {
          this.startCollabItem(item)
          break
        }
        const tool = this.codexToolEvent(item)
        if (tool) this.emit(tool)
        break
      }
      case 'item/completed': {
        const item = p['item'] as CodexItem | undefined
        if (!item) break
        if (item.type === 'subAgentActivity') {
          this.noteSubAgentActivity(item)
        } else if (isGuiCodexCollabType(item.type)) {
          this.finishCollabItem(item)
        } else if (item.type === 'agentMessage' && item.text) {
          this.emit({ type: 'text', text: item.text })
        } else if (isGuiCodexToolType(item.type)) {
          const completed = guiCodexToolCompletion(item)
          // Cada card aberto no item/started fecha pelo id autoritativo, mesmo
          // quando Patch/WebSearch/MCP terminam sem texto visível.
          this.emit(
            commandResultEvent(completed.text, completed.isError, item.id, completed.outcome)
          )
        }
        break
      }
      case 'thread/compacted':
        // A compactação invalida a fotografia anterior. Esperamos a próxima
        // medição `last` do protocolo em vez de estimar o quanto ela reduziu.
        this.lastTokens = undefined
        this.lastWindow = undefined
        this.emit({ type: 'context-usage', contextTokens: null, contextWindow: null })
        this.emit({ type: 'command-output', text: 'contexto da thread compactado' })
        break
      case 'thread/tokenUsage/updated': {
        // A régua sai da fotografia do ÚLTIMO REQUEST (um turno emite um evento
        // por chamada de API); o acumulado da thread — restaurado no
        // thread/resume e sem teto — jamais a alimenta. Ausência não vira
        // fallback: a UI remove a régua até uma medida válida voltar. Semântica
        // sondada e provada em `codexTokenUsage.ts`.
        const { contextTokens, contextWindow } = codexContextFromTokenUsage(p['tokenUsage'])
        this.lastTokens = contextTokens
        this.lastWindow = contextWindow
        this.emit({
          type: 'context-usage',
          contextTokens: contextTokens ?? null,
          contextWindow: contextWindow ?? null
        })
        break
      }
      case 'turn/completed': {
        const turn = p['turn'] as
          | { status?: string; error?: { message?: string } }
          | undefined
        const outcome = guiCodexTurnOutcome(turn?.status)
        this.cancelPendingInteractions()
        this.clearInterruptGuard()
        this.clearTurnErrorGuard()
        this.turnId = null
        // Turno raiz que NÃO concluiu (interrupção confirmada pelo servidor,
        // falha) leva os sub-agentes junto: eles pertencem a este turno e
        // ninguém mais vai reportar por eles. Reter o terminal aqui prenderia a
        // conversa em "trabalhando" para sempre.
        if (outcome !== 'completed') this.cancelLiveCodexAgents()
        const result: Extract<SessionEvent, { type: 'result' }> = {
          type: 'result',
          isError: outcome === 'failed',
          outcome,
          errorText: turn?.error?.message
        }
        // Respostas RPC resolvidas no mesmo chunk retomam em microtask. Só
        // depois delas sabemos se uma mensagem aceita precisa abrir outro turno.
        queueMicrotask(() => {
          if (this.activeCollabParentIds.size > 0 || this.codexAgents.size > 0) {
            this.deferredCollabResult = result
            return
          }
          this.emitTurnResult(result)
        })
        break
      }
      case 'error': {
        const payload = p['error'] as { message?: unknown; willRetry?: boolean } | undefined
        const m = payload?.message ?? p['message']
        const message = `codex: ${typeof m === 'string' ? firstLines(m, 500) : boundedJson(p, 200)}`
        this.emit({
          type: 'limit',
          text: message
        })
        if (!guiCodexErrorWillRetry(p))
          this.armTurnErrorGuard(message + ' — o turno não encerrou corretamente')
        break
      }
      default:
        break
    }
  }
}

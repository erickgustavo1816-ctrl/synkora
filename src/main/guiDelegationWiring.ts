/**
 * A COSTURA DOS AJUDANTES SEM ABA COM O MAIN (onda 2 do design vinculante
 * `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
 *
 * O motor (`guiHelperSessions.ts`) é puro por decisão: ele não conhece
 * `MaestroSession`/`CodexSession`, não conhece `SeatStore` e não conhece
 * electron. Este módulo é o ÚNICO lugar onde essas três coisas encostam nele —
 * e é por isso que ele também não importa electron: tudo que vem do main entra
 * por injeção, e a suíte roda em node puro.
 *
 * O que mora aqui:
 *  1. os dois ADAPTADORES (claude e codex), com as cercas do D5 nos args;
 *  2. `resolveSeat` e `modelSupportsEffort` sobre o catálogo REAL do CLI;
 *  3. a implementação das tools de delegação do `McpApi` — texto legível,
 *     sempre em PT-BR, com o recibo por ajudante.
 *
 * SEM CADEIA (cerca dura do D1): o ajudante nasce SEM `--mcp-config`/
 * `mcp_servers.*`. Ele não enxerga o catálogo `gui-delegator` porque não tem
 * token nenhum — quem delega é o chat do dono, e frota que abre frota é o laço
 * que o backstop existe para conter.
 */
import { CLAUDE_NATIVE_AGENT_FENCE } from './guiDelegateMcp'
import { CodexSession } from './codexSession'
import { MaestroSession, type SessionEvent } from './maestroSession'
import { getCatalog } from './catalog'
import { getSeatUsage, type SeatUsageInfo } from './seatUsage'
import { guiPermissionProfile, isGuiPermissionMode } from './guiSessions'
import {
  GuiHelperEngine,
  type GuiHelperCli,
  type GuiHelperDelegator,
  type GuiHelperEvent,
  type GuiHelperLogEntry,
  type GuiHelperProcess,
  type GuiHelperReceipt,
  type GuiHelperSeat,
  type GuiHelperSnapshot,
  type GuiHelperSpawnRequest,
  type GuiHelperChange,
  type GuiHelperResultOutcome
} from './guiHelperSessions'
import type { McpHelperRequestInput } from './mcpServer'

/** A conta como o main a conhece (SeatStore + configDir já resolvido). */
export interface GuiDelegationSeat {
  id: string
  name: string
  cli: GuiHelperCli
  status: string
  configDir: string
}

/**
 * PERSONA DO AJUDANTE — curta de propósito (D1). Ele não conversa: recebe uma
 * fatia, trabalha e entrega no TEXTO FINAL. Em inglês, como todo prompt de
 * agente desta casa; a resposta ao dono é sempre PT-BR.
 */
export const GUI_HELPER_PERSONA = [
  'You are a Synkora helper: a headless worker opened by another agent through the internal MCP.',
  'You have no tab, no terminal and no human on the other side.',
  '',
  'RULES:',
  '- Do the slice of work you were given, end to end, and put the ANSWER in your FINAL message.',
  '  That final text is the only thing your delegator receives.',
  '- NEVER ask questions and never wait for approval: nobody can answer you. If something is',
  '  genuinely blocked, say what is blocked and why, in your final message, and stop.',
  '- NEVER open subagents of your own (no Task/Agent, no collab, no delegation of any kind).',
  '- Long deliverables go to a FILE inside the worktree and your final message points to the path;',
  '  do not paste tens of thousands of characters back.',
  '- Answer the delegator in Brazilian Portuguese (PT-BR).'
].join('\n')

/** Sem silêncio: um pedido de permissão numa sessão headless nunca é respondido. */
const HELPER_PERMISSION_DEAD_END =
  'o ajudante parou pedindo permissão e não há ninguém para responder por ele — ' +
  'troque o modo desta conversa para edições/bypass antes de delegar trabalho que escreve'

/** Teto da espera pelos limites das contas no `list_seats`: cache quente responde
 *  na hora; conta fria não pode segurar a tool até o corte do CLI. */
const SEAT_USAGE_WAIT_MS = 8_000

// ————— tradução dos eventos do CLI para o vocabulário do motor —————

function toolActivitySummary(evt: SessionEvent & { type: 'tool' }): string {
  const input = evt.input ?? {}
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return `${evt.name} · ${value.replace(/\s+/gu, ' ').trim().slice(0, 120)}`
    }
  }
  return evt.name
}

/**
 * O MESMO tradutor serve aos dois CLIs: `MaestroSession` e `CodexSession`
 * implementam a mesma união `SessionEvent`, e o motor consome um subconjunto
 * dela. Quanto menos protocolo o motor conhecer, menos ele quebra num update.
 */
export function guiHelperEventFor(evt: SessionEvent): GuiHelperEvent | null {
  switch (evt.type) {
    case 'text':
      return { type: 'text', text: evt.text }
    case 'tool':
      return { type: 'activity', summary: toolActivitySummary(evt) }
    case 'context-usage':
      return { type: 'context', contextTokens: evt.contextTokens }
    case 'result':
      // `continues` = o turno lógico ainda não acabou (mensagem enfileirada,
      // trabalho de fundo). Encerrar aqui mataria um ajudante em pleno trabalho.
      if (evt.continues === true) return null
      return {
        type: 'result',
        isError: evt.isError,
        ...(evt.resultText ? { text: evt.resultText } : {}),
        ...(evt.errorText ? { errorText: evt.errorText } : {})
      }
    case 'fatal':
      return { type: 'fatal', text: evt.text }
    case 'closed':
      return { type: 'closed', code: evt.code }
    // Sessão headless não tem quem responda: pedido de interação é BECO, e beco
    // vira desfecho com receita em vez de meia hora pendurado no watchdog.
    case 'permission':
      return { type: 'fatal', text: `${HELPER_PERMISSION_DEAD_END} (${evt.toolName})` }
    case 'question':
    case 'plan-review':
      return { type: 'fatal', text: HELPER_PERMISSION_DEAD_END }
    default:
      return null
  }
}

// ————— os adaptadores —————

export interface GuiHelperAdapterDeps {
  /** Materializa a persona do claude em arquivo (teto de argv no Windows). */
  systemPromptFile(name: string, content: string): string | undefined
  /** Prepara o config dir do seat antes do spawn (sandbox do codex). */
  prepareSeat?(seat: GuiHelperSeat, cli: GuiHelperCli): void
}

/** Flags do helper CLAUDE. A cerca de 13 nomes vem do guiDelegateMcp — fonte
 *  única — e é a MESMA que o chat do delegador usa (S1, sondada). */
export function claudeHelperArgs(): string[] {
  return ['--disallowedTools', CLAUDE_NATIVE_AGENT_FENCE.join(',')]
}

/** Flags do helper CODEX: o CINTO da cerca anti-nativo, no formato que
 *  sobrevive ao `shell: true` (S2). O suspensório é `suppressNativeAgents`. */
export function codexHelperArgs(): string[] {
  return ['-c', 'features.multi_agent=false']
}

function permissionProfileFor(
  cli: GuiHelperCli,
  permissionMode: string | undefined
): { permissionMode?: string; sandbox?: string; approvalPolicy?: string } {
  return guiPermissionProfile(cli, isGuiPermissionMode(permissionMode) ? permissionMode : undefined)
}

export function createClaudeHelperAdapter(deps: GuiHelperAdapterDeps) {
  return (request: GuiHelperSpawnRequest, emit: (event: GuiHelperEvent) => void): GuiHelperProcess => {
    deps.prepareSeat?.(request.seat, 'claude')
    const file = deps.systemPromptFile(`helper-${request.helperId}.system.md`, GUI_HELPER_PERSONA)
    const session = new MaestroSession(
      {
        cwd: request.cwd,
        configDir: request.seat.configDir || undefined,
        model: request.model,
        ...(request.effort ? { effort: request.effort } : {}),
        ...permissionProfileFor('claude', request.permissionMode),
        ...(file ? { systemPromptFile: file } : {}),
        // NENHUM `extraEnv`/`mcp`: ajudante não tem ferramenta Synkora (D1).
        extraArgs: claudeHelperArgs()
      },
      (evt) => {
        const translated = guiHelperEventFor(evt)
        if (translated) emit(translated)
      }
    )
    // A persona por arquivo pode falhar (disco cheio, userData sumindo): o
    // contrato então viaja COLADO no pedido — nunca some em silêncio.
    session.send(file ? request.prompt : `${GUI_HELPER_PERSONA}\n\n---\n\n${request.prompt}`)
    return {
      send: (text) => session.send(text),
      dispose: () => session.kill()
    }
  }
}

export function createCodexHelperAdapter(deps: GuiHelperAdapterDeps) {
  return (request: GuiHelperSpawnRequest, emit: (event: GuiHelperEvent) => void): GuiHelperProcess => {
    deps.prepareSeat?.(request.seat, 'codex')
    const session = new CodexSession(
      {
        cwd: request.cwd,
        configDir: request.seat.configDir || undefined,
        model: request.model,
        ...(request.effort ? { effort: request.effort } : {}),
        ...permissionProfileFor('codex', request.permissionMode),
        // Cerca DUPLA do D5: cinto nos args do app-server, suspensório no
        // thread/start (e no thread/resume, que este ajudante nem usa).
        extraArgs: codexHelperArgs(),
        suppressNativeAgents: true
      },
      GUI_HELPER_PERSONA,
      (evt) => {
        const translated = guiHelperEventFor(evt)
        if (translated) emit(translated)
      }
    )
    session.send(request.prompt)
    return {
      send: (text) => session.send(text),
      // O `app-server` do codex NUNCA encerra sozinho ao fim do turno (sonda
      // probe-helper-matrix §6): o kill é obrigatório em todo desfecho.
      dispose: () => session.kill()
    }
  }
}

// ————— catálogo: o effort só viaja quando o modelo o aceita —————

/**
 * `modelSupportsEffort` do motor é SÍNCRONO (ele decide na hora do spawn) e o
 * catálogo do CLI é assíncrono. A ponte é este cache: resposta imediata quando
 * já se sabe, `undefined` quando ainda não — e `undefined` NÃO é "não suporta"
 * (o motor manda o effort assim mesmo; derrubar o nível de toda frota por
 * catálogo frio seria um estrago maior que um rótulo otimista).
 */
export class GuiHelperCatalogCache {
  private readonly efforts = new Map<string, Map<string, boolean>>()
  private readonly loading = new Set<string>()
  private readonly configDirOf: (cli: GuiHelperCli) => string | undefined

  constructor(configDirOf: (cli: GuiHelperCli) => string | undefined) {
    this.configDirOf = configDirOf
  }

  supportsEffort(query: { cli: GuiHelperCli; model: string }): boolean | undefined {
    const table = this.efforts.get(query.cli)
    if (!table) {
      this.load(query.cli)
      return undefined
    }
    return table.get(query.model.trim().toLowerCase())
  }

  private load(cli: GuiHelperCli): void {
    if (this.loading.has(cli)) return
    this.loading.add(cli)
    void getCatalog(cli, this.configDirOf(cli))
      .then((catalog) => {
        const table = new Map<string, boolean>()
        for (const model of catalog.models) {
          // `efforts` ausente = o catálogo não disse nada sobre este modelo;
          // vazio = ele DECLARA que não aceita nível (o caso do haiku, §2.4).
          if (model.efforts === undefined) continue
          table.set(model.id.trim().toLowerCase(), model.efforts.length > 0)
        }
        this.efforts.set(cli, table)
      })
      .catch(() => undefined)
      .finally(() => this.loading.delete(cli))
  }
}

// ————— a conta —————

/**
 * MESMO CLI → a conta do delegador (o pedido explícito vence). CLI CRUZADO → a
 * primeira conta LOGADA daquele binário. Nenhuma → `undefined`, e o motor
 * produz a recusa legível.
 *
 * Conta pedida que existe mas é do OUTRO CLI cai na regra do cruzado em vez de
 * recusar: o delegador pediu um modelo, e o modelo é quem manda no binário. O
 * recibo carimba a conta que de fato abriu, então a escolha nunca é muda.
 */
export function resolveGuiHelperSeat(
  seats: readonly GuiDelegationSeat[],
  query: { cli: GuiHelperCli; preferredSeatId?: string }
): GuiHelperSeat | undefined {
  const asSeat = (seat: GuiDelegationSeat): GuiHelperSeat => ({
    seatId: seat.id,
    configDir: seat.configDir,
    ...(seat.name ? { name: seat.name } : {})
  })
  if (query.preferredSeatId) {
    const wanted = seats.find((seat) => seat.id === query.preferredSeatId)
    if (wanted && wanted.cli === query.cli) return asSeat(wanted)
  }
  const logged = seats.find((seat) => seat.cli === query.cli && seat.status === 'logado')
  return logged ? asSeat(logged) : undefined
}

// ————— o motor, montado —————

export interface GuiHelperEngineWiring extends GuiHelperAdapterDeps {
  seats(): GuiDelegationSeat[]
  onChange(change: GuiHelperChange): void
  log(entry: GuiHelperLogEntry): void
}

export function createGuiHelperEngine(wiring: GuiHelperEngineWiring): GuiHelperEngine {
  const catalog = new GuiHelperCatalogCache(
    (cli) => wiring.seats().find((seat) => seat.cli === cli && seat.status === 'logado')?.configDir
  )
  return new GuiHelperEngine({
    spawnClaude: createClaudeHelperAdapter(wiring),
    spawnCodex: createCodexHelperAdapter(wiring),
    resolveSeat: (query) => resolveGuiHelperSeat(wiring.seats(), query),
    modelSupportsEffort: (query) => catalog.supportsEffort(query),
    onChange: wiring.onChange,
    log: wiring.log
  })
}

// ————— o texto que o delegador lê —————

function receiptLine(receipt: GuiHelperReceipt): string {
  if (!receipt.ok) {
    return `✗ ${receipt.name ? `${receipt.name}: ` : ''}${receipt.error}`
  }
  // Modelo vazio = o delegador roda no padrão da conta e o card não pode
  // inventar um nome; a linha simplesmente não mostra o campo.
  const parts = [receipt.model, receipt.effort, receipt.seatName ?? receipt.seatId, receipt.cli].filter(
    (part): part is string => Boolean(part)
  )
  const head = `✓ ${receipt.name ? `${receipt.name} — ` : ''}${receipt.helperId}`
  const dropped = receipt.effortDropped ? `\n    · ${receipt.effortDropped}` : ''
  return `${head}\n    ${parts.join(' · ')}${dropped}`
}

export function guiHelperSpawnText(
  receipts: readonly GuiHelperReceipt[],
  warning?: string
): string {
  const opened = receipts.filter((receipt) => receipt.ok).length
  const head =
    opened === 0
      ? 'nenhum ajudante abriu'
      : opened === 1
        ? '1 ajudante aberto (trabalhando agora, em sessão própria)'
        : `${opened} ajudantes abertos (trabalhando agora, cada um em sessão própria)`
  const body = receipts.map(receiptLine).join('\n')
  const tail =
    opened > 0
      ? '\n\nEles NÃO bloqueiam você: siga conversando. Acompanhe por helpers_status, ' +
        'colha com helper_result (long-poll), dirija com helper_send e desista com helper_cancel.'
      : ''
  return `${head}:\n${body}${warning ? `\n\n⚠ ${warning}` : ''}${tail}`
}

function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return `${minutes}min`
}

export function guiHelperStatusText(snapshots: readonly GuiHelperSnapshot[]): string {
  if (snapshots.length === 0) {
    return 'nenhum ajudante neste chat — abra com delegate quando quiser paralelizar.'
  }
  const lines = snapshots.map((snapshot) => {
    const head = `${snapshot.name ? `${snapshot.name} — ` : ''}${snapshot.helperId}`
    const meta = [snapshot.model, snapshot.effort, snapshot.seatName ?? snapshot.seatId].filter(
      (part): part is string => Boolean(part)
    )
    const detail: string[] = [`${snapshot.state} há ${elapsedText(snapshot.elapsedMs)}`]
    if (snapshot.lastActivity) detail.push(`agora: ${snapshot.lastActivity.summary}`)
    if (snapshot.contextTokens) detail.push(`contexto ~${Math.round(snapshot.contextTokens / 1000)}k`)
    if (snapshot.hasResult) detail.push('entrega pronta (helper_result)')
    if (snapshot.failure) detail.push(snapshot.failure)
    return `- ${head}\n    ${meta.join(' · ')}\n    ${detail.join(' · ')}`
  })
  const live = snapshots.filter((snapshot) => snapshot.state === 'spawning' || snapshot.state === 'working')
  return `${snapshots.length} ajudante(s) neste chat · ${live.length} vivo(s):\n${lines.join('\n')}`
}

export function guiHelperResultText(outcome: GuiHelperResultOutcome): string {
  if (!outcome.ok) return outcome.error
  if (outcome.pending) {
    const activity = outcome.snapshot.lastActivity?.summary
    return (
      `ainda trabalhando (${outcome.snapshot.state} há ${elapsedText(outcome.snapshot.elapsedMs)}` +
      `${activity ? `, agora: ${activity}` : ''}). ` +
      'Esperei o que pedi e devolvi a fotografia — chame de novo quando quiser, ' +
      'ou siga com outra coisa: o ajudante não para porque você saiu.'
    )
  }
  if (outcome.state === 'done') {
    return `entrega do ajudante ${outcome.helperId}${outcome.truncated ? ' (cortada no teto)' : ''}:\n\n${outcome.result ?? ''}`
  }
  return `o ajudante ${outcome.helperId} encerrou como ${outcome.state}: ${outcome.failure ?? 'sem motivo declarado'}`
}

function usageText(info: SeatUsageInfo | null | undefined, now: number): string {
  if (!info) return 'limites não consultados agora'
  const age = Math.max(0, Math.round((now - info.at) / 60_000))
  const meters = info.meters
    .map((meter) => `${meter.label}: ${meter.pct}% ${meter.mode === 'used' ? 'usado' : 'restante'}`)
    .join(' · ')
  const head = meters || info.lines.slice(0, 2).join(' · ') || 'sem medidor reconhecido'
  return `${head}${age > 0 ? ` (leitura de ${age}min atrás)` : ''}`
}

export function guiHelperSeatsText(
  seats: readonly GuiDelegationSeat[],
  usage: ReadonlyMap<string, SeatUsageInfo | null>,
  now: number
): string {
  if (seats.length === 0) return 'nenhuma conta cadastrada neste app.'
  const lines = seats.map((seat) => {
    const plan = usage.get(seat.id)?.plan
    return (
      `- ${seat.name} [${seat.id}] · ${seat.cli}${plan ? ` ${plan}` : ''} · ${seat.status}\n` +
      `    ${usageText(usage.get(seat.id), now)}`
    )
  })
  return (
    'contas deste app (use o id em delegate.seat para escolher onde gastar limite):\n' +
    `${lines.join('\n')}\n\n` +
    'Frota grande: distribua pelas contas com mais folga — o modelo decide o CLI ' +
    '(gpt-* = codex; o resto = claude) e a conta segue o modelo.'
  )
}

// ————— as tools do McpApi —————

export interface GuiDelegationApiDeps {
  engine: GuiHelperEngine
  /** O chat vivo do pane (modelo/effort/conta atuais) — `undefined` = sem sessão. */
  delegator(paneId: string): GuiHelperDelegator | undefined
  /** Abre/fecha a janela do lote no anel do delegador (a costura de correlação). */
  beginBatch(paneId: string): string | undefined
  endBatch(paneId: string): void
  seats(): GuiDelegationSeat[]
  seatUsage?(seat: GuiDelegationSeat): Promise<SeatUsageInfo | null>
  now?(): number
}

/** Identidade mínima que as tools consomem (o `PaneIdentity` do hub cabe aqui). */
export interface GuiDelegationIdentity {
  paneId: string
  role: string
  projectId: string
  cwd: string
}

const NOT_A_DELEGATOR = 'esta conversa não delega ajudantes'
const NO_SESSION = 'o chat deste pane não está aberto'

function helperOfPane(
  deps: GuiDelegationApiDeps,
  identity: GuiDelegationIdentity,
  helperId: string
): { ok: true } | { ok: false; error: string } {
  const record = deps.engine.get(helperId)
  // Escopo por pane, e é cerca: um chat nunca lê, dirige ou cancela o ajudante
  // de outro. O id é opaco, mas opacidade não é autorização.
  if (!record || record.delegatorPaneId !== identity.paneId) {
    return {
      ok: false,
      error: `ajudante ${helperId} não é deste chat — confira o id no helpers_status`
    }
  }
  return { ok: true }
}

export function buildGuiDelegationApi(deps: GuiDelegationApiDeps): {
  delegateHelpers(id: GuiDelegationIdentity, helpers: McpHelperRequestInput[]): Promise<string>
  listSeats(id: GuiDelegationIdentity): Promise<string>
  helpersStatus(id: GuiDelegationIdentity): string
  helperResult(id: GuiDelegationIdentity, helperId: string, waitSeconds?: number): Promise<string>
  helperSend(id: GuiDelegationIdentity, helperId: string, text: string): string
  helperCancel(id: GuiDelegationIdentity, helperId: string): string
} {
  const now = deps.now ?? Date.now
  const guard = (id: GuiDelegationIdentity): string | null =>
    id.role === 'gui-delegator' ? null : NOT_A_DELEGATOR

  return {
    async delegateHelpers(id, helpers) {
      const refusal = guard(id)
      if (refusal) return refusal
      const delegator = deps.delegator(id.paneId)
      if (!delegator) return NO_SESSION
      if (!Array.isArray(helpers) || helpers.length === 0) {
        return 'mande ao menos um ajudante em `helpers` — cada item é uma fatia de trabalho.'
      }
      // A JANELA DO LOTE envolve o spawn INTEIRO: os avisos `spawned` chegam
      // dentro dele, e é o lote aberto que os liga à chamada `delegate` que o
      // CLI publicou. Sem o try/finally, uma exceção deixaria a janela aberta e
      // o lote seguinte herdaria os ajudantes deste.
      deps.beginBatch(id.paneId)
      let outcome
      try {
        outcome = deps.engine.spawn(delegator, helpers)
      } finally {
        deps.endBatch(id.paneId)
      }
      return guiHelperSpawnText(outcome.receipts, outcome.warning)
    },

    async listSeats(id) {
      const refusal = guard(id)
      if (refusal) return refusal
      const seats = deps.seats()
      const usage = new Map<string, SeatUsageInfo | null>()
      if (deps.seatUsage) {
        // Cache quente responde na hora; conta fria spawna um processo efêmero.
        // O teto é do SERVIDOR: melhor a lista sem limites do que a tool cortada.
        const deadline = new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), SEAT_USAGE_WAIT_MS)
          timer.unref?.()
        })
        await Promise.all(
          seats.map(async (seat) => {
            const info = await Promise.race([
              deps.seatUsage?.(seat).catch(() => null) ?? Promise.resolve(null),
              deadline
            ])
            usage.set(seat.id, info ?? null)
          })
        )
      }
      return guiHelperSeatsText(seats, usage, now())
    },

    helpersStatus(id) {
      const refusal = guard(id)
      if (refusal) return refusal
      return guiHelperStatusText(deps.engine.status(id.paneId))
    },

    async helperResult(id, helperId, waitSeconds) {
      const refusal = guard(id)
      if (refusal) return refusal
      const owned = helperOfPane(deps, id, helperId)
      if (!owned.ok) return owned.error
      return guiHelperResultText(await deps.engine.result(helperId, waitSeconds))
    },

    helperSend(id, helperId, text) {
      const refusal = guard(id)
      if (refusal) return refusal
      const owned = helperOfPane(deps, id, helperId)
      if (!owned.ok) return owned.error
      const sent = deps.engine.send(helperId, text)
      return sent.ok
        ? `mensagem entregue ao ajudante ${helperId} — ela entra no turno dele.`
        : sent.error
    },

    helperCancel(id, helperId) {
      const refusal = guard(id)
      if (refusal) return refusal
      const owned = helperOfPane(deps, id, helperId)
      if (!owned.ok) return owned.error
      const cancelled = deps.engine.cancel(helperId, 'cancelado pelo chat que o abriu')
      return cancelled.ok
        ? `ajudante ${helperId} cancelado — o que ele já escreveu no worktree continua lá.`
        : cancelled.error
    }
  }
}

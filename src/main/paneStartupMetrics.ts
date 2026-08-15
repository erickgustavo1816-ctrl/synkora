import { createWriteStream, mkdirSync, type WriteStream } from 'fs'
import { performance } from 'perf_hooks'
import { join } from 'path'
import { randomUUID } from 'crypto'

export type PaneStartupMode = 'livre' | 'maestro' | 'estrito' | 'shell'

/** Papéis que de fato NASCEM num PTY. `gui-planner` é identidade de CHAT (2.0,
 *  onda D): ela existe só para autenticar o MCP do planejador e nunca chega
 *  aqui — quem mede partida de pane é o paneLifecycle, que é dos TUIs. */
export type PaneStartupRole = 'maestro' | 'dev' | 'review' | 'qa' | 'ajudante' | 'livre'

export function isPaneStartupRole(role: string | undefined): role is PaneStartupRole {
  return (
    role === 'maestro' ||
    role === 'dev' ||
    role === 'review' ||
    role === 'qa' ||
    role === 'ajudante' ||
    role === 'livre'
  )
}

export interface PaneStartupDescriptor {
  kind: 'shell' | 'claude' | 'codex'
  role?: PaneStartupRole
  mode: PaneStartupMode
  externalMcpCount: number
  hasInitialPrompt: boolean
}

export type PaneStartupMilestone =
  | 'pane_create_requested'
  | 'internal_mcp_available'
  | 'external_mcp_configured'
  | 'pty_spawn_started'
  | 'pty_spawn_completed'
  | 'process_first_output'
  | 'terminal_first_frame'
  | 'first_message_sent'
  | 'external_mcp_available'
  | 'agent_first_output'
  | 'startup_failed'
  | 'pane_exited'

interface PaneStartupTrace {
  traceId: string
  paneId: string
  startedAtUnixMs: number
  startedAtMonotonicMs: number
  descriptor: PaneStartupDescriptor
  marks: Set<PaneStartupMilestone>
  firstMessageAt?: number
}

interface PendingPaneRequest {
  traceId: string
  paneId: string
  startedAtUnixMs: number
  startedAtMonotonicMs: number
  expires: ReturnType<typeof setTimeout>
}

interface RuntimeInfo {
  appVersion: string
  electronVersion: string
}

export type PaneStartupSummaryMilestone =
  | 'terminal_first_frame'
  | 'external_mcp_available'
  | 'agent_first_output'

export interface PaneStartupMetricSummary {
  samples: number
  p50Ms: number | null
  p95Ms: number | null
}

export interface PaneStartupRecentSummary extends PaneStartupMetricSummary {
  primaryMilestone: 'agent_first_output'
  windowSize: number
  milestones: Record<PaneStartupSummaryMilestone, PaneStartupMetricSummary>
}

const RECENT_SAMPLE_LIMIT = 200

/**
 * Instrumentação de startup com duas regras duras:
 *
 * 1. intervalos são calculados somente com o relógio monotônico do processo;
 * 2. o arquivo recebe apenas metadados allowlisted — nunca prompt, output,
 *    cwd, token MCP, chave, argumentos de CLI ou conteúdo do terminal.
 *
 * A escrita usa stream assíncrono para a própria medição não colocar I/O
 * síncrono no caminho crítico de abertura dos panes.
 */
export class PaneStartupMetrics {
  readonly file: string
  private readonly sessionId = randomUUID()
  private readonly traces = new Map<string, PaneStartupTrace>()
  private readonly pendingRequests = new Map<string, PendingPaneRequest>()
  private readonly recentSamples: Array<{
    milestone: PaneStartupSummaryMilestone
    elapsedMs: number
  }> = []
  private stream: WriteStream | null = null
  private internalMcpReady = false

  constructor(userDataDir: string, runtime: RuntimeInfo) {
    this.file = join(userDataDir, 'performance', 'pane-startup.jsonl')
    try {
      mkdirSync(join(userDataDir, 'performance'), { recursive: true })
      const stream = createWriteStream(this.file, { flags: 'a', encoding: 'utf-8' })
      stream.on('error', () => {
        if (this.stream === stream) this.stream = null
      })
      this.stream = stream
      this.write({
        schemaVersion: 1,
        record: 'session-start',
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        appVersion: runtime.appVersion,
        electronVersion: runtime.electronVersion,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      })
    } catch {
      this.stream = null
    }
  }

  /** Recebido assim que o componente do terminal monta, antes de o renderer
   * aguardar o layout estabilizar. Isso inclui no tempo total justamente a
   * espera que antecede o IPC de criação do PTY. */
  request(paneId: string): void {
    if (this.traces.has(paneId) || this.pendingRequests.has(paneId)) return
    const startedAtMonotonicMs = performance.now()
    const pending: PendingPaneRequest = {
      traceId: randomUUID(),
      paneId,
      startedAtUnixMs: Date.now(),
      startedAtMonotonicMs,
      expires: setTimeout(() => this.pendingRequests.delete(paneId), 30_000)
    }
    this.pendingRequests.set(paneId, pending)
    this.write({
      schemaVersion: 1,
      record: 'milestone',
      sessionId: this.sessionId,
      traceId: pending.traceId,
      paneId,
      timestamp: new Date(pending.startedAtUnixMs).toISOString(),
      monotonicMs: round(startedAtMonotonicMs),
      elapsedMs: 0,
      milestone: 'pane_create_requested',
      evidence: 'observed'
    })
  }

  begin(paneId: string, descriptor: PaneStartupDescriptor): void {
    const pending = this.pendingRequests.get(paneId)
    if (pending) {
      clearTimeout(pending.expires)
      this.pendingRequests.delete(paneId)
    }
    const now = pending?.startedAtMonotonicMs ?? performance.now()
    const trace: PaneStartupTrace = {
      traceId: pending?.traceId ?? randomUUID(),
      paneId,
      startedAtUnixMs: pending?.startedAtUnixMs ?? Date.now(),
      startedAtMonotonicMs: now,
      descriptor,
      marks: new Set(pending ? ['pane_create_requested'] : [])
    }
    this.traces.set(paneId, trace)
    if (!pending) this.mark(paneId, 'pane_create_requested')
    if (this.internalMcpReady) this.mark(paneId, 'internal_mcp_available')
    if (descriptor.externalMcpCount > 0) this.mark(paneId, 'external_mcp_configured')
  }

  markInternalMcpAvailable(): void {
    this.internalMcpReady = true
    for (const paneId of this.traces.keys()) this.mark(paneId, 'internal_mcp_available')
  }

  markInternalMcpUnavailable(): void {
    this.internalMcpReady = false
  }

  mark(paneId: string, milestone: PaneStartupMilestone, evidence: 'observed' | 'inferred' = 'observed'): void {
    const trace = this.traces.get(paneId)
    if (!trace || trace.marks.has(milestone)) return
    trace.marks.add(milestone)
    const now = performance.now()
    const elapsedMs = round(now - trace.startedAtMonotonicMs)
    if (
      milestone === 'terminal_first_frame' ||
      milestone === 'external_mcp_available' ||
      milestone === 'agent_first_output'
    ) {
      this.recentSamples.push({ milestone, elapsedMs })
      if (this.recentSamples.length > RECENT_SAMPLE_LIMIT) this.recentSamples.shift()
    }
    this.write({
      schemaVersion: 1,
      record: 'milestone',
      sessionId: this.sessionId,
      traceId: trace.traceId,
      paneId: trace.paneId,
      timestamp: new Date().toISOString(),
      monotonicMs: round(now),
      elapsedMs,
      milestone,
      evidence,
      pane: trace.descriptor
    })
  }

  markFirstMessage(paneId: string): void {
    const trace = this.traces.get(paneId)
    if (!trace || trace.marks.has('first_message_sent')) return
    trace.firstMessageAt = performance.now()
    this.mark(paneId, 'first_message_sent')
  }

  observeOutput(paneId: string): void {
    const trace = this.traces.get(paneId)
    if (!trace) return
    this.mark(paneId, 'process_first_output')
    // O eco imediato do próprio Enter não é resposta do agente. A folga curta
    // evita contá-lo sem inspecionar um único byte do conteúdo.
    if (trace.firstMessageAt == null || performance.now() - trace.firstMessageAt < 10) return
    if (trace.descriptor.externalMcpCount > 0) {
      // Os CLIs só aceitam o turno depois da preparação dos MCPs. Eles não
      // publicam um evento neutro de "ready" para o host, então esta marca é
      // explicitamente inferida; bench-mcp mede a disponibilidade diretamente.
      this.mark(paneId, 'external_mcp_available', 'inferred')
    }
    this.mark(paneId, 'agent_first_output', 'inferred')
  }

  fail(paneId: string): void {
    this.mark(paneId, 'startup_failed')
  }

  end(paneId: string): void {
    this.mark(paneId, 'pane_exited')
    this.traces.delete(paneId)
  }

  /** Resumo allowlisted em memória. Não guarda paneId, prompt, cwd, token,
   * argumentos, output ou conteúdo do terminal. */
  recentSummary(): PaneStartupRecentSummary {
    const milestones = {
      terminal_first_frame: summarize(
        this.recentSamples.filter((sample) => sample.milestone === 'terminal_first_frame')
          .map((sample) => sample.elapsedMs)
      ),
      external_mcp_available: summarize(
        this.recentSamples.filter((sample) => sample.milestone === 'external_mcp_available')
          .map((sample) => sample.elapsedMs)
      ),
      agent_first_output: summarize(
        this.recentSamples.filter((sample) => sample.milestone === 'agent_first_output')
          .map((sample) => sample.elapsedMs)
      )
    }
    return {
      primaryMilestone: 'agent_first_output',
      windowSize: RECENT_SAMPLE_LIMIT,
      ...milestones.agent_first_output,
      milestones
    }
  }

  close(): void {
    for (const pending of this.pendingRequests.values()) clearTimeout(pending.expires)
    this.pendingRequests.clear()
    const stream = this.stream
    this.stream = null
    stream?.end()
  }

  private write(record: Record<string, unknown>): void {
    try {
      this.stream?.write(`${JSON.stringify(record)}\n`)
    } catch {
      this.stream = null
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function summarize(values: number[]): PaneStartupMetricSummary {
  if (values.length === 0) return { samples: 0, p50Ms: null, p95Ms: null }
  const sorted = [...values].sort((left, right) => left - right)
  return {
    samples: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95))
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 1) return sorted[0]
  const rank = (sorted.length - 1) * ratio
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower)
}

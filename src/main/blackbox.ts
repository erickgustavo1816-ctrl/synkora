import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { redactPersistedValue, redactSensitiveText } from './securityRedaction'

/**
 * Caixa-preta central do Synkora (plano de estabilização 02/08/2026).
 *
 * Um único diário local, append-only, em JSONL, com uma versão resumida
 * legível ao lado. Cada evento carrega horário, sequência, o boot que o gerou
 * e os identificadores disponíveis (projeto, missão, card, fase, pane, agente,
 * ticket). Entram somente ações observáveis e mudanças de estado — nunca
 * segredos, tokens, prompts inteiros ou raciocínio interno de IA.
 *
 * O módulo não conhece Electron nem stores: recebe o diretório no construtor
 * e nunca lança por falha de IO — telemetria jamais derruba o app.
 */

export type BlackboxCategory =
  | 'app' // boot, quit limpo, crash, dirty-exit, processos filhos
  | 'pane' // nascimento, remount e encerramento de pane/processo
  | 'mcp' // config MCP gerada, conexão do pane, chamadas de tool
  | 'msg' // mensagens entre agentes (hub): publicação, entrega, descarte
  | 'task' // mudanças de estado de card (status/fase/feedback)
  | 'phase' // início/fim de dev, review, qa, finalização
  | 'git' // fotografias: commit base, entregue, fingerprint, diff
  | 'merge' // tentativa de merge, resultado, bloqueio, reparo
  | 'queue' // fila de integração
  | 'recovery' // reconciliação no boot e decisões de recuperação
  | 'verify' // verificação proporcional (typecheck/test)
  | 'user' // intervenções e autorizações manuais

export interface BlackboxIds {
  projectId?: string
  missionId?: string
  taskId?: string
  planId?: string
  ticketId?: string
  paneId?: string
  phase?: string
  attempt?: number
  role?: string
  seatId?: string
}

export interface BlackboxEventInput {
  cat: BlackboxCategory
  event: string
  ids?: BlackboxIds
  /** estado anterior legível (ex.: "execucao/review/running") */
  prev?: string
  /** estado seguinte legível */
  next?: string
  /** quem causou: harness/maestro/dev/review/qa/user/boot… */
  actor?: string
  /** por que a transição aconteceu */
  reason?: string
  /** evidência usada (ex.: "report MCP", "marcador .verdict", "git head ab12…") */
  evidence?: string
  /** metadados pequenos e sanitizados */
  detail?: Record<string, unknown>
  /** trecho limitado de erro */
  err?: string
}

export interface BlackboxEntry extends BlackboxEventInput {
  ts: string
  seq: number
  boot: string
}

const MAX_STRING = 600
const MAX_ARRAY = 20
// 5 níveis: args de tool chegam como args → array → card → campo → item.
// Com 3, o conteúdo real de um create_tasks virava "[profundidade]".
const MAX_DEPTH = 5

export function sanitizeDetail(
  detail: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!detail) return undefined
  return redactPersistedValue(detail, {
    maxString: MAX_STRING,
    maxArray: MAX_ARRAY,
    maxDepth: MAX_DEPTH
  }) as Record<string, unknown>
}

/** Linha resumida legível de um evento — usada no journal.md e no export. */
export function describeEntry(entry: BlackboxEntry): string {
  const time = entry.ts.slice(11, 19)
  const who = entry.actor ? ` (${redactSensitiveText(entry.actor)})` : ''
  const ids: string[] = []
  if (entry.ids?.taskId) ids.push(`card ${entry.ids.taskId.slice(0, 8)}`)
  if (entry.ids?.missionId) ids.push(`missão ${entry.ids.missionId.slice(0, 8)}`)
  if (entry.ids?.paneId) ids.push(`pane ${entry.ids.paneId.slice(0, 8)}`)
  if (entry.ids?.phase) ids.push(entry.ids.phase)
  const scope = ids.length ? ` [${ids.join(' · ')}]` : ''
  const transition =
    entry.prev || entry.next
      ? ` ${redactSensitiveText(entry.prev ?? '?')} → ${redactSensitiveText(entry.next ?? '?')}`
      : ''
  // Journals antigos também passam pelo redator ao serem exibidos/exportados.
  const reason = entry.reason ? ` — ${redactSensitiveText(entry.reason)}` : ''
  const err = entry.err ? ` — ERRO: ${redactSensitiveText(entry.err)}` : ''
  return `${time} [${entry.cat}/${redactSensitiveText(entry.event)}]${who}${scope}${transition}${reason}${err}`
}

export interface BlackboxOptions {
  dir: string
  /** injetável para teste */
  now?: () => Date
  maxFileBytes?: number
  retentionDays?: number
  readableMaxLines?: number
  readableKeepLines?: number
}

export class Blackbox {
  readonly bootId = randomUUID()
  private readonly dir: string
  private readonly now: () => Date
  private readonly maxFileBytes: number
  private readonly retentionDays: number
  private readonly readableMaxLines: number
  private readonly readableKeepLines: number
  private seq = 0
  private readableCount = 0

  constructor(options: BlackboxOptions) {
    this.dir = options.dir
    this.now = options.now ?? ((): Date => new Date())
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
    this.retentionDays = options.retentionDays ?? 14
    this.readableMaxLines = options.readableMaxLines ?? 800
    this.readableKeepLines = options.readableKeepLines ?? 400
    try {
      mkdirSync(this.dir, { recursive: true })
      this.sweepOldFiles()
    } catch {
      // telemetria nunca derruba o app
    }
  }

  /** Caminho do JSONL do dia — é este arquivo que um monitor externo taila. */
  journalFile(): string {
    const day = this.now().toISOString().slice(0, 10).replace(/-/g, '')
    return join(this.dir, `journal-${day}.jsonl`)
  }

  readableFile(): string {
    return join(this.dir, 'journal.md')
  }

  record(input: BlackboxEventInput): BlackboxEntry | undefined {
    try {
      const entry: BlackboxEntry = {
        ts: this.now().toISOString(),
        seq: ++this.seq,
        boot: this.bootId.slice(0, 8),
        ...input,
        detail: sanitizeDetail(input.detail),
        event: redactSensitiveText(input.event).slice(0, MAX_STRING),
        actor: input.actor ? redactSensitiveText(input.actor).slice(0, MAX_STRING) : undefined,
        prev: input.prev ? redactSensitiveText(input.prev).slice(0, MAX_STRING) : undefined,
        next: input.next ? redactSensitiveText(input.next).slice(0, MAX_STRING) : undefined,
        evidence: input.evidence
          ? redactSensitiveText(input.evidence).slice(0, MAX_STRING)
          : undefined,
        err: input.err ? redactSensitiveText(input.err).slice(0, MAX_STRING) : undefined,
        reason: input.reason ? redactSensitiveText(input.reason).slice(0, MAX_STRING) : undefined
      }
      const file = this.journalFile()
      this.rotateIfNeeded(file)
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
      this.appendReadable(describeEntry(entry))
      return entry
    } catch {
      return undefined
    }
  }

  /** Lista os journals existentes, mais novo por último. */
  listJournalFiles(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.startsWith('journal-') && name.endsWith('.jsonl'))
        .sort()
        .map((name) => join(this.dir, name))
    } catch {
      return []
    }
  }

  /** Últimas `limit` entradas do diário (para export/monitor embutido). */
  tail(limit = 200): BlackboxEntry[] {
    const out: BlackboxEntry[] = []
    try {
      const files = this.listJournalFiles().slice(-2)
      for (const file of files) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line) as BlackboxEntry
            out.push(
              redactPersistedValue(parsed, {
                maxString: MAX_STRING,
                maxArray: MAX_ARRAY,
                maxDepth: MAX_DEPTH
              }) as BlackboxEntry
            )
          } catch {
            // linha corrompida (crash no meio do append) — ignorada
          }
        }
      }
    } catch {
      // sem journal ainda
    }
    return out.slice(-limit)
  }

  private rotateIfNeeded(file: string): void {
    try {
      if (existsSync(file) && statSync(file).size > this.maxFileBytes) {
        const stamp = this.now().toISOString().replace(/[-:]/g, '').slice(0, 15)
        renameSync(file, file.replace(/\.jsonl$/, `.${stamp}.jsonl`))
      }
    } catch {
      // rotação é best-effort
    }
  }

  private appendReadable(line: string): void {
    try {
      const file = this.readableFile()
      appendFileSync(file, `${line}\n`, 'utf8')
      this.readableCount += 1
      if (this.readableCount >= 200) {
        this.readableCount = 0
        const lines = readFileSync(file, 'utf8').split('\n')
        if (lines.length > this.readableMaxLines) {
          writeFileSync(file, lines.slice(-this.readableKeepLines).join('\n'), 'utf8')
        }
      }
    } catch {
      // resumo legível é best-effort
    }
  }

  private sweepOldFiles(): void {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('journal-')) continue
      try {
        const file = join(this.dir, name)
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
      } catch {
        // arquivo em uso/apagado — ignora
      }
    }
  }
}

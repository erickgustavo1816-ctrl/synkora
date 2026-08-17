import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Export de diagnóstico deliberadamente mínimo. O pacote serve para reconstruir
 * estados e transições sem copiar conversas, briefings, caminhos locais, logs,
 * documentos do projeto ou stores completos para fora da máquina.
 */

export interface DiagnosticsProjectInput {
  id: string
  name: string
  path: string
}

export interface DiagnosticsInput {
  outFile: string
  userDataDir: string
  blackboxDir: string
  meta: Record<string, unknown>
  projects: DiagnosticsProjectInput[]
  /** Janela de dias da caixa-preta no pacote (1 = só hoje); ausente = tudo
   *  que a retenção guarda (14d). Escolhido no modal de export (2026-08-05:
   *  "na hora de exportar vem o modal que eu escolho o período"). */
  days?: number
}

const STORE_FILES = [
  'missions.json',
  'plans.json',
  'backlog.json',
  'maestro.json',
  'projects.json',
  'progress-overlay.json',
  'integration-queue.json'
]

const LOG_FILES = ['synkora-crash.log', 'cli-update.log']
const REDACTED = '[redigido]'
const MAX_STRING = 400
const MAX_ARRAY = 50
const MAX_DEPTH = 6
const SENSITIVE_KEY =
  /token|secret|password|bearer|authorization|api[-_]?key|cookie|card|private|credential|webhook|payload|prompt|message|content|transcript|email|customer|client|path|cwd|file|url|reason|error|detail|evidence/i

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi,
  /\bwhsec_[A-Za-z0-9_-]{8,}\b/gi,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b[A-Za-z]:[\\/][^\r\n<>"|]*/g,
  /\/(?:Users|home)\/[^\r\n\s]+/g
]

function sanitizeDiagnosticString(value: string): string {
  let out = value
  for (const pattern of SENSITIVE_TEXT_PATTERNS) out = out.replace(pattern, REDACTED)
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out
}

/** Redator defensivo para metadados explicitamente permitidos no pacote. */
export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return sanitizeDiagnosticString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return '[profundidade]'
  if (Array.isArray(value)) {
    const head = value
      .slice(0, MAX_ARRAY)
      .map((item) => sanitizeDiagnosticValue(item, depth + 1))
    return value.length > MAX_ARRAY ? [...head, `…+${value.length - MAX_ARRAY}`] : head
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeDiagnosticValue(item, depth + 1)
    }
    return out
  }
  return sanitizeDiagnosticString(String(value))
}

function hashLabel(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const clean = sanitizeDiagnosticString(value).slice(0, 80)
  return /^[\p{L}\p{N}_.:/ -]+$/u.test(clean) ? clean : undefined
}

function sanitizedBlackboxEntry(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof entry.ts === 'string' && Number.isFinite(Date.parse(entry.ts))) out.ts = entry.ts
  if (typeof entry.seq === 'number' && Number.isFinite(entry.seq)) out.seq = entry.seq
  for (const key of ['boot', 'cat', 'event', 'prev', 'next', 'actor'] as const) {
    const label = safeLabel(entry[key])
    if (label) out[key] = label
  }
  if (entry.ids && typeof entry.ids === 'object' && !Array.isArray(entry.ids)) {
    const ids: Record<string, string> = {}
    for (const [key, item] of Object.entries(entry.ids as Record<string, unknown>)) {
      if (typeof item !== 'string' || !item) continue
      if (key === 'phase' || key === 'role') {
        const label = safeLabel(item)
        if (label) ids[key] = label
      } else {
        ids[key] = hashLabel(item)
      }
    }
    if (Object.keys(ids).length) out.ids = ids
  }
  if (entry.reason !== undefined) out.hasReason = true
  if (entry.evidence !== undefined) out.hasEvidence = true
  if (entry.detail !== undefined) out.hasDetail = true
  if (entry.err !== undefined) out.hasError = true
  return Object.keys(out).length ? out : null
}

function fileSummary(path: string): Record<string, unknown> | null {
  try {
    const stat = statSync(path)
    return { bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
  } catch {
    return null
  }
}

function storeSummary(path: string): Record<string, unknown> | null {
  const summary = fileSummary(path)
  if (!summary) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return {
      ...summary,
      parseable: true,
      topLevel: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed,
      records: Array.isArray(parsed)
        ? parsed.length
        : parsed && typeof parsed === 'object'
          ? Object.keys(parsed as Record<string, unknown>).length
          : 1
    }
  } catch {
    return { ...summary, parseable: false }
  }
}

/** AAAAMMDD do arquivo diário; undefined para nomes fora do padrão de data. */
function journalDateOf(name: string): string | undefined {
  return /^journal-(\d{8})\.jsonl$/.exec(name)?.[1]
}

function journalCutoff(days: number): string {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - Math.max(0, Math.floor(days) - 1))
  return `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}${String(cutoff.getDate()).padStart(2, '0')}`
}

function sanitizedBlackboxFiles(
  dir: string,
  days?: number
): {
  files: { name: string; entries: number; skipped: number }[]
  payloads: { name: string; content: Buffer }[]
} {
  const files: { name: string; entries: number; skipped: number }[] = []
  const payloads: { name: string; content: Buffer }[] = []
  if (!existsSync(dir)) return { files, payloads }
  const cutoff = days !== undefined ? journalCutoff(days) : undefined

  for (const name of readdirSync(dir).sort()) {
    if (!/^journal-[A-Za-z0-9.-]+\.jsonl$/.test(name)) continue
    if (cutoff) {
      const stamped = journalDateOf(name)
      // nome fora do padrão de data entra sempre (conservador — nunca perder
      // evidência por um rename inesperado)
      if (stamped && stamped < cutoff) continue
    }
    let entries = 0
    let skipped = 0
    const safeLines: string[] = []
    try {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const safe = sanitizedBlackboxEntry(JSON.parse(line) as unknown)
          if (!safe) {
            skipped++
            continue
          }
          safeLines.push(JSON.stringify(safe))
          entries++
        } catch {
          skipped++
        }
      }
      payloads.push({
        name: `blackbox/${name.replace(/\.jsonl$/, '.sanitized.jsonl')}`,
        content: Buffer.from(safeLines.length ? `${safeLines.join('\n')}\n` : '', 'utf8')
      })
      files.push({ name, entries, skipped })
    } catch {
      files.push({ name, entries: 0, skipped: 1 })
    }
  }
  return { files, payloads }
}

function gitRun(projectPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['--no-pager', ...args], {
      cwd: projectPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

function gitEvidence(projectPath: string): Record<string, unknown> {
  const headRaw = gitRun(projectPath, ['rev-parse', '--verify', 'HEAD'])
  const head = headRaw && /^[0-9a-f]{7,64}$/i.test(headRaw) ? headRaw : undefined
  if (!head) return { available: false }

  const statusRaw = gitRun(projectPath, ['status', '--porcelain=v1', '-z']) ?? ''
  const statusCounts: Record<string, number> = {}
  for (const item of statusRaw.split('\0')) {
    const code = item.slice(0, 2)
    if (!/^[ MADRCU?!]{2}$/.test(code)) continue
    statusCounts[code] = (statusCounts[code] ?? 0) + 1
  }
  const worktreeRaw = gitRun(projectPath, ['worktree', 'list', '--porcelain']) ?? ''
  const refsRaw = gitRun(projectPath, [
    'for-each-ref',
    '--format=%(objectname)',
    'refs/heads',
    'refs/remotes'
  ]) ?? ''
  const commitsRaw = gitRun(projectPath, ['rev-list', '--all', '--max-count=20']) ?? ''
  return {
    available: true,
    head,
    attachedBranch: gitRun(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== null,
    clean: statusRaw.length === 0,
    statusCounts,
    worktreeCount: worktreeRaw.split('\n').filter((line) => line.startsWith('worktree ')).length,
    refCount: refsRaw.split('\n').filter((line) => /^[0-9a-f]{7,64}$/i.test(line)).length,
    recentCommits: commitsRaw.split('\n').filter((line) => /^[0-9a-f]{7,64}$/i.test(line))
  }
}

function projectArtifactSummary(projectPath: string): Record<string, unknown> {
  const synkoraDir = join(projectPath, '.synkora')
  const documents: Record<string, unknown> = {}
  for (const name of ['EVENTS.md']) {
    const summary = fileSummary(join(synkoraDir, name))
    if (summary) documents[name] = summary
  }
  let missionDocumentCount = 0
  try {
    missionDocumentCount = readdirSync(join(synkoraDir, 'missions'))
      .filter((name) => name.endsWith('.md')).length
  } catch {
    // pasta opcional
  }
  return { documents, missionDocumentCount }
}

export function diagnosticsConsentDetail(projectCount: number): string {
  return [
    `O pacote sanitizado incluirá versões, saúde dos serviços, ${projectCount} projeto(s) em forma de contagens, estado Git sem nomes/caminhos e eventos da caixa-preta sem texto livre.`,
    '',
    'Não serão incluídos: conversas, prompts, briefings, documentos do projeto, conteúdo dos stores, logs crus, nomes/caminhos locais ou valores de chaves e tokens.',
    '',
    'Revise o destino escolhido antes de compartilhar o ZIP.'
  ].join('\n')
}

export function exportDiagnostics(input: DiagnosticsInput): { ok: boolean; msg: string } {
  try {
    const zip = new AdmZip()
    zip.addFile(
      'meta.sanitized.json',
      Buffer.from(JSON.stringify(sanitizeDiagnosticValue(input.meta), null, 2), 'utf8')
    )

    const blackbox = sanitizedBlackboxFiles(input.blackboxDir, input.days)
    for (const payload of blackbox.payloads) zip.addFile(payload.name, payload.content)
    zip.addFile(
      'blackbox/manifest.json',
      Buffer.from(
        JSON.stringify(
          { files: blackbox.files, periodDays: input.days ?? null },
          null,
          2
        ),
        'utf8'
      )
    )

    const storeManifest: Record<string, unknown> = {}
    for (const name of STORE_FILES) {
      const summary = storeSummary(join(input.userDataDir, name))
      if (summary) storeManifest[name] = summary
    }
    const logManifest: Record<string, unknown> = {}
    for (const name of LOG_FILES) {
      const summary = fileSummary(join(input.userDataDir, name))
      if (summary) logManifest[name] = summary
    }
    zip.addFile(
      'userData/manifest.json',
      Buffer.from(
        JSON.stringify(
          {
            stores: storeManifest,
            logs: logManifest,
            notice: 'Conteúdos crus foram omitidos deliberadamente.'
          },
          null,
          2
        ),
        'utf8'
      )
    )

    const settingsFile = join(input.userDataDir, 'settings.json')
    if (existsSync(settingsFile)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'))
        zip.addFile(
          'userData/settings.sanitized.json',
          Buffer.from(JSON.stringify(sanitizeDiagnosticValue(parsed), null, 2), 'utf8')
        )
      } catch {
        // settings ilegível fica de fora; nunca copiamos o arquivo cru.
      }
    }

    for (const project of input.projects) {
      const slug = `project-${hashLabel(project.id)}`
      const present = existsSync(project.path)
      zip.addFile(
        `projects/${slug}/summary.json`,
        Buffer.from(
          JSON.stringify(
            present
              ? {
                  present: true,
                  git: gitEvidence(project.path),
                  artifacts: projectArtifactSummary(project.path)
                }
              : { present: false },
            null,
            2
          ),
          'utf8'
        )
      )
    }

    zip.writeZip(input.outFile)
    return { ok: true, msg: `diagnóstico sanitizado exportado: ${input.outFile}` }
  } catch (error) {
    return {
      ok: false,
      msg: `falha ao exportar diagnóstico: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

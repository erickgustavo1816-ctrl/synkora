export const HELPER_RECOVERY_VERSION = 1 as const

const HEADER_PREFIX = '<!-- synkora-helper '
const HEADER_SUFFIX = ' -->'
const MAX_HEADER_CHARS = 32_768

export type HelperRecoveryStatus = 'running' | 'done' | 'interrupted'

/** Metadados pequenos e não sensíveis que ligam um transcript ao trabalho que
 * o originou. O prompt e a saída do ajudante nunca entram neste cabeçalho. */
export interface HelperRecoveryRecord {
  version: typeof HELPER_RECOVERY_VERSION
  paneId: string
  projectId: string
  missionId?: string
  taskId?: string
  delegatorPaneId?: string
  title?: string
  seatId?: string
  model?: string
  createdAt: string
  status: HelperRecoveryStatus
  statusAt: string
}

export interface HelperRecoveryFilter {
  projectId?: string
  missionId?: string
  taskId?: string
  delegatorPaneId?: string
  status?: HelperRecoveryStatus | readonly HelperRecoveryStatus[]
}

export interface HelperRecoveryUpdateResult {
  transcript: string
  record?: HelperRecoveryRecord
  changed: boolean
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || nonEmptyString(value)
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value))
}

function validStatus(value: unknown): value is HelperRecoveryStatus {
  return value === 'running' || value === 'done' || value === 'interrupted'
}

/** Constrói uma cópia allowlisted. Além de validar dados do disco, isto impede
 * que propriedades inesperadas do JSON sejam propagadas para stores/IPC. */
function normalizeRecord(value: unknown): HelperRecoveryRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== HELPER_RECOVERY_VERSION ||
    !nonEmptyString(candidate.paneId) ||
    !nonEmptyString(candidate.projectId) ||
    !optionalString(candidate.missionId) ||
    !optionalString(candidate.taskId) ||
    !optionalString(candidate.delegatorPaneId) ||
    !optionalString(candidate.title) ||
    !optionalString(candidate.seatId) ||
    !optionalString(candidate.model) ||
    !validTimestamp(candidate.createdAt) ||
    !validStatus(candidate.status) ||
    !validTimestamp(candidate.statusAt)
  ) {
    return undefined
  }

  return {
    version: HELPER_RECOVERY_VERSION,
    paneId: candidate.paneId,
    projectId: candidate.projectId,
    ...(candidate.missionId ? { missionId: candidate.missionId } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.delegatorPaneId ? { delegatorPaneId: candidate.delegatorPaneId } : {}),
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(candidate.seatId ? { seatId: candidate.seatId } : {}),
    ...(candidate.model ? { model: candidate.model } : {}),
    createdAt: candidate.createdAt,
    status: candidate.status,
    statusAt: candidate.statusAt
  }
}

/** Escapa caracteres que poderiam encerrar o comentário HTML antes da hora,
 * mantendo o payload como JSON literal e reversível por JSON.parse. */
function safeJson(value: HelperRecoveryRecord): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

export function formatHelperRecoveryHeader(record: HelperRecoveryRecord): string {
  const normalized = normalizeRecord(record)
  if (!normalized) throw new Error('metadados de recuperação do ajudante são inválidos')
  return `${HEADER_PREFIX}${safeJson(normalized)}${HEADER_SUFFIX}`
}

/** Semeia o arquivo antes de o tee do PTY começar a acrescentar a saída. */
export function formatHelperRecoveryTranscript(
  record: HelperRecoveryRecord,
  body = ''
): string {
  const header = formatHelperRecoveryHeader(record)
  return body ? `${header}\n${body}` : `${header}\n`
}

export function parseHelperRecoveryHeader(line: string): HelperRecoveryRecord | undefined {
  const clean = line.replace(/^\uFEFF/, '').replace(/\r$/, '')
  if (
    clean.length > MAX_HEADER_CHARS ||
    !clean.startsWith(HEADER_PREFIX) ||
    !clean.endsWith(HEADER_SUFFIX)
  ) {
    return undefined
  }
  const raw = clean.slice(HEADER_PREFIX.length, -HEADER_SUFFIX.length)
  try {
    return normalizeRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** Só a primeira linha é autoritativa. Texto que imite um cabeçalho no corpo
 * do transcript não pode sequestrar a associação do ajudante. */
export function parseHelperRecoveryTranscript(
  transcript: string
): HelperRecoveryRecord | undefined {
  const newline = transcript.indexOf('\n')
  const firstLine = newline === -1 ? transcript : transcript.slice(0, newline)
  return parseHelperRecoveryHeader(firstLine)
}

function canTransition(
  current: HelperRecoveryStatus,
  next: HelperRecoveryStatus
): boolean {
  if (current === next || next === 'running') return false
  if (current === 'done') return false
  // Um report autoritativo pode chegar depois de uma marca de interrupção.
  if (current === 'interrupted') return next === 'done'
  return true
}

/** Atualiza exclusivamente a primeira linha e preserva byte a byte o restante,
 * inclusive CRLF. Repetir a mesma transição devolve a string original. */
export function updateHelperRecoveryStatus(
  transcript: string,
  status: HelperRecoveryStatus,
  statusAt: string
): HelperRecoveryUpdateResult {
  const current = parseHelperRecoveryTranscript(transcript)
  if (!current || !validStatus(status) || !validTimestamp(statusAt)) {
    return { transcript, record: current, changed: false }
  }
  if (!canTransition(current.status, status)) {
    return { transcript, record: current, changed: false }
  }

  const next: HelperRecoveryRecord = { ...current, status, statusAt }
  const newline = transcript.indexOf('\n')
  const updated =
    newline === -1
      ? formatHelperRecoveryHeader(next)
      : `${formatHelperRecoveryHeader(next)}${transcript.slice(newline > 0 && transcript[newline - 1] === '\r' ? newline - 1 : newline)}`
  return { transcript: updated, record: next, changed: true }
}

export function filterHelperRecoveryRecords(
  records: readonly HelperRecoveryRecord[],
  filter: HelperRecoveryFilter
): HelperRecoveryRecord[] {
  const statuses = filter.status
    ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
    : undefined
  return records.filter(
    (record) =>
      (!filter.projectId || record.projectId === filter.projectId) &&
      (!filter.missionId || record.missionId === filter.missionId) &&
      (!filter.taskId || record.taskId === filter.taskId) &&
      (!filter.delegatorPaneId || record.delegatorPaneId === filter.delegatorPaneId) &&
      (!statuses || statuses.has(record.status))
  )
}

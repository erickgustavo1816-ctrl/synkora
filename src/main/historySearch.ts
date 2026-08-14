/**
 * Busca local e limitada nos JSONL dos CLIs.
 *
 * Fronteira de privacidade: só saem falas com papel explícito `user` ou
 * `assistant`. Tool calls/results, metadata, paths de config e linhas que não
 * reconhecemos ficam no main. Mesmo o texto aceito passa pela redação comum
 * antes do match e antes de cruzar IPC.
 */
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { basename, join, resolve } from 'path'
import { redactSensitiveText } from './securityRedaction'
import type {
  HistoryMessageRole,
  HistoryProvider,
  HistoryTranscriptMessage
} from '../shared/commandPalette'

export interface HistoryProviderRoot {
  provider: HistoryProvider
  configDir: string
}

export interface HistoryWorkspaceScope {
  cwd: string
  projectId: string
  missionId?: string
  paneId?: string
  label?: string
  canMount?: boolean
}

export interface HistorySessionBinding {
  sessionId: string
  projectId?: string
  missionId?: string
  paneId?: string
  label?: string
  canMount?: boolean
}

export interface HistorySearchLimits {
  maxFiles: number
  maxBytes: number
  maxBytesPerFile: number
  maxMs: number
  maxResults: number
  maxLineBytes: number
  maxMessageChars: number
  maxTranscriptMessages: number
  maxTranscriptChars: number
}

export const HISTORY_SEARCH_LIMITS: Readonly<HistorySearchLimits> = {
  maxFiles: 160,
  maxBytes: 32 * 1024 * 1024,
  maxBytesPerFile: 4 * 1024 * 1024,
  maxMs: 1_500,
  maxResults: 72,
  maxLineBytes: 1024 * 1024,
  maxMessageChars: 32 * 1024,
  maxTranscriptMessages: 240,
  maxTranscriptChars: 1024 * 1024
}

export type HistoryLimitReason = 'arquivos' | 'bytes' | 'tempo' | 'resultados'

export interface LocalHistoryLocator {
  file: string
  configDir: string
  provider: HistoryProvider
  sessionId: string
  messageId: string
  cursor: number
}

export interface LocalHistoryMatch {
  provider: HistoryProvider
  sessionId: string
  messageId: string
  cursor: number
  role: HistoryMessageRole
  snippet: string
  at?: string
  projectId?: string
  missionId?: string
  paneId?: string
  label?: string
  canMount: boolean
  locator: LocalHistoryLocator
}

export interface LocalHistorySearchResult {
  hits: LocalHistoryMatch[]
  cancelled: boolean
  truncated: boolean
  limitReason?: HistoryLimitReason
  scannedFiles: number
  scannedBytes: number
}

export interface LocalHistorySearchInput {
  query: string
  roots: readonly HistoryProviderRoot[]
  workspaces: readonly HistoryWorkspaceScope[]
  sessionBindings?: readonly HistorySessionBinding[]
  signal?: AbortSignal
  limits?: Partial<HistorySearchLimits>
}

export interface LocalHistoryTranscriptResult {
  ok: boolean
  provider?: HistoryProvider
  sessionId?: string
  messages?: HistoryTranscriptMessage[]
  targetMessageId?: string
  targetCursor?: number
  truncated?: boolean
  error?: string
}

interface Candidate {
  file: string
  configDir: string
  provider: HistoryProvider
  mtime: number
  scope?: HistoryWorkspaceScope
  sessionId?: string
}

interface ParsedMessage {
  id: string
  cursor: number
  role: HistoryMessageRole
  text: string
  at?: string
}

interface ReadJsonlResult {
  lines: Array<{ value: unknown; cursor: number }>
  truncated: boolean
}

interface SearchBudget {
  limits: HistorySearchLimits
  deadline: number
  signal?: AbortSignal
  scannedFiles: number
  scannedBytes: number
  limitReason?: HistoryLimitReason
  softTruncated: boolean
}

function limitsOf(input?: Partial<HistorySearchLimits>): HistorySearchLimits {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback
  return {
    maxFiles: positive(input?.maxFiles, HISTORY_SEARCH_LIMITS.maxFiles),
    maxBytes: positive(input?.maxBytes, HISTORY_SEARCH_LIMITS.maxBytes),
    maxBytesPerFile: positive(input?.maxBytesPerFile, HISTORY_SEARCH_LIMITS.maxBytesPerFile),
    maxMs: positive(input?.maxMs, HISTORY_SEARCH_LIMITS.maxMs),
    maxResults: positive(input?.maxResults, HISTORY_SEARCH_LIMITS.maxResults),
    maxLineBytes: positive(input?.maxLineBytes, HISTORY_SEARCH_LIMITS.maxLineBytes),
    maxMessageChars: positive(input?.maxMessageChars, HISTORY_SEARCH_LIMITS.maxMessageChars),
    maxTranscriptMessages: positive(
      input?.maxTranscriptMessages,
      HISTORY_SEARCH_LIMITS.maxTranscriptMessages
    ),
    maxTranscriptChars: positive(
      input?.maxTranscriptChars,
      HISTORY_SEARCH_LIMITS.maxTranscriptChars
    )
  }
}

function budgetStopped(budget: SearchBudget): boolean {
  if (budget.signal?.aborted) return true
  if (Date.now() >= budget.deadline) {
    budget.limitReason ??= 'tempo'
    return true
  }
  return Boolean(budget.limitReason)
}

function normalizedPath(value: string): string {
  return resolve(value).replace(/[\\/]+/g, '/').replace(/\/$/u, '').toLowerCase()
}

function pathContains(root: string, child: string): boolean {
  const base = normalizedPath(root)
  const value = normalizedPath(child)
  return value === base || value.startsWith(`${base}/`)
}

function claudeSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function boundedStringOf(value: unknown, maxLength = 512): string | undefined {
  const text = stringOf(value)
  return text && text.length <= maxLength ? text : undefined
}

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u

function safeProviderId(value: unknown): string | undefined {
  const text = boundedStringOf(value, 160)
  if (!text || !PROVIDER_ID_RE.test(text)) return undefined
  return redactSensitiveText(text) === text ? text : undefined
}

function safeTimestamp(value: unknown): string | undefined {
  const text = boundedStringOf(value, 100)
  return text && Number.isFinite(Date.parse(text)) ? text : undefined
}

function visibleBlocks(value: unknown, accepted: ReadonlySet<string>): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const text: string[] = []
  for (const raw of value) {
    const block = recordOf(raw)
    if (!block || !accepted.has(String(block.type ?? ''))) continue
    const part = stringOf(block.text)
    if (part) text.push(part)
  }
  return text.join('\n')
}

const CLAUDE_TEXT_BLOCKS = new Set(['text'])
const CODEX_USER_TEXT_BLOCKS = new Set(['input_text', 'text'])
const CODEX_ASSISTANT_TEXT_BLOCKS = new Set(['output_text', 'text'])

function stableFallbackId(provider: HistoryProvider, role: HistoryMessageRole, cursor: number): string {
  return `${provider}:${role}:${cursor}`
}

/**
 * Extrator fechado: não percorre objetos recursivamente. Se a linha não for
 * uma mensagem humana/assistente numa forma conhecida, ela não produz nada.
 */
export function extractVisibleHistoryMessage(
  provider: HistoryProvider,
  raw: unknown,
  cursor: number,
  maxChars = HISTORY_SEARCH_LIMITS.maxMessageChars
): ParsedMessage | undefined {
  const entry = recordOf(raw)
  if (!entry) return undefined

  let role: HistoryMessageRole | undefined
  let text = ''
  let id: string | undefined
  let at: string | undefined

  if (provider === 'claude') {
    if (entry.type !== 'user' && entry.type !== 'assistant') return undefined
    // Sidechains são conversas internas de subagentes, não falas do dono.
    if (entry.isMeta === true || entry.isSidechain === true || entry.agentId !== undefined) {
      return undefined
    }
    const message = recordOf(entry.message)
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return undefined
    if (message.role !== entry.type) return undefined
    role = message.role
    text = visibleBlocks(message.content, CLAUDE_TEXT_BLOCKS)
    // Assistant pode aparecer em várias fotografias crescentes. O id da
    // mensagem é comum a todas; o uuid da linha é o fallback do user.
    id = role === 'assistant'
      ? safeProviderId(message.id) ?? safeProviderId(entry.uuid)
      : safeProviderId(entry.uuid) ?? safeProviderId(message.id)
    at = safeTimestamp(entry.timestamp)
  } else {
    const payload = recordOf(entry.payload)
    if (!payload) return undefined
    // Forma canônica dos rollouts atuais. function_call e
    // function_call_output nunca chegam a este ramo.
    if (entry.type === 'response_item' && payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') return undefined
      role = payload.role
      text = visibleBlocks(
        payload.content,
        role === 'user' ? CODEX_USER_TEXT_BLOCKS : CODEX_ASSISTANT_TEXT_BLOCKS
      )
      id = safeProviderId(payload.id)
      at = safeTimestamp(entry.timestamp)
    } else if (entry.type === 'event_msg' && payload.type === 'user_message') {
      // Compatibilidade com rollouts antigos que não tinham response_item.
      role = 'user'
      text = stringOf(payload.message) ?? ''
      id = safeProviderId(payload.id)
      at = safeTimestamp(entry.timestamp)
    } else if (entry.type === 'event_msg' && payload.type === 'agent_message') {
      role = 'assistant'
      text = stringOf(payload.message) ?? ''
      id = safeProviderId(payload.id)
      at = safeTimestamp(entry.timestamp)
    } else {
      return undefined
    }
  }

  const visible = redactSensitiveText(text).trim().slice(0, maxChars)
  if (!role || !visible) return undefined
  return {
    id: id ?? stableFallbackId(provider, role, cursor),
    cursor,
    role,
    text: visible,
    ...(at ? { at } : {})
  }
}

function normalizedSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
}

function snippetFor(text: string, normalizedQuery: string): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  const normalized = normalizedSearchText(oneLine)
  const at = normalized.indexOf(normalizedQuery)
  const start = Math.max(0, at < 0 ? 0 : at - 100)
  const end = Math.min(oneLine.length, start + 300)
  return `${start > 0 ? '…' : ''}${oneLine.slice(start, end)}${end < oneLine.length ? '…' : ''}`
}

async function safeRegularFile(path: string): Promise<{ size: number; mtime: number } | null> {
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return { size: stat.size, mtime: stat.mtimeMs }
  } catch {
    return null
  }
}

async function safeDirectoryEntries(
  path: string,
  budget: SearchBudget,
  maxEntries = 2_048
): Promise<import('fs').Dirent[]> {
  try {
    const stat = await fs.lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || budgetStopped(budget)) return []
    const entries: import('fs').Dirent[] = []
    const directory = await fs.opendir(path)
    for await (const entry of directory) {
      if (budgetStopped(budget)) break
      if (entries.length >= maxEntries) {
        budget.softTruncated = true
        break
      }
      entries.push(entry)
    }
    return entries
  } catch {
    return []
  }
}

function preferScope(
  current: HistoryWorkspaceScope | undefined,
  next: HistoryWorkspaceScope
): HistoryWorkspaceScope {
  if (!current) return next
  if (!current.missionId && next.missionId) return next
  if (!current.paneId && next.paneId) return next
  return current
}

async function discoverClaudeCandidates(
  roots: readonly HistoryProviderRoot[],
  workspaces: readonly HistoryWorkspaceScope[],
  budget: SearchBudget,
  out: Map<string, Candidate>
): Promise<void> {
  const discoveryCap = Math.max(budget.limits.maxFiles, budget.limits.maxFiles * 4)
  for (const root of roots) {
    if (root.provider !== 'claude' || budgetStopped(budget)) continue
    for (const scope of workspaces) {
      if (budgetStopped(budget)) return
      if (out.size >= discoveryCap) {
        budget.softTruncated = true
        return
      }
      const dir = join(root.configDir, 'projects', claudeSlug(scope.cwd))
      const entries = await safeDirectoryEntries(dir, budget, discoveryCap)
      for (const entry of entries) {
        if (budgetStopped(budget)) return
        if (out.size >= discoveryCap) {
          budget.softTruncated = true
          return
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = join(dir, entry.name)
        const stat = await safeRegularFile(file)
        if (!stat) continue
        const key = normalizedPath(file)
        const current = out.get(key)
        if (current) {
          current.scope = preferScope(current.scope, scope)
          continue
        }
        out.set(key, {
          file,
          configDir: root.configDir,
          provider: 'claude',
          mtime: stat.mtime,
          scope,
          sessionId: safeProviderId(basename(entry.name, '.jsonl'))
        })
      }
    }
  }
}

async function codexDateDirectories(root: string, budget: SearchBudget): Promise<string[]> {
  const result: string[] = []
  const years = (await safeDirectoryEntries(join(root, 'sessions'), budget, 128))
    .filter((entry) => entry.isDirectory() && /^\d{4}$/u.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name))
  for (const year of years) {
    if (budgetStopped(budget) || result.length >= 512) {
      if (result.length >= 512) budget.softTruncated = true
      break
    }
    const yearPath = join(root, 'sessions', year.name)
    const months = (await safeDirectoryEntries(yearPath, budget, 24))
      .filter((entry) => entry.isDirectory() && /^\d{2}$/u.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name))
    for (const month of months) {
      if (budgetStopped(budget) || result.length >= 512) {
        if (result.length >= 512) budget.softTruncated = true
        break
      }
      const monthPath = join(yearPath, month.name)
      const days = (await safeDirectoryEntries(monthPath, budget, 64))
        .filter((entry) => entry.isDirectory() && /^\d{2}$/u.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name))
      for (const day of days) {
        result.push(join(monthPath, day.name))
        if (result.length >= 512) break
      }
    }
  }
  return result
}

async function discoverCodexCandidates(
  roots: readonly HistoryProviderRoot[],
  budget: SearchBudget,
  out: Map<string, Candidate>
): Promise<void> {
  const discoveryCap = Math.max(budget.limits.maxFiles, budget.limits.maxFiles * 6)
  for (const root of roots) {
    if (root.provider !== 'codex' || budgetStopped(budget)) continue
    for (const dir of await codexDateDirectories(root.configDir, budget)) {
      if (budgetStopped(budget)) return
      if (out.size >= discoveryCap) {
        budget.softTruncated = true
        return
      }
      const entries = (await safeDirectoryEntries(dir, budget, discoveryCap)).sort((a, b) =>
        b.name.localeCompare(a.name)
      )
      for (const entry of entries) {
        if (budgetStopped(budget)) return
        if (out.size >= discoveryCap) {
          budget.softTruncated = true
          return
        }
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl'))
          continue
        const file = join(dir, entry.name)
        const stat = await safeRegularFile(file)
        if (!stat) continue
        const key = normalizedPath(file)
        if (!out.has(key)) {
          out.set(key, {
            file,
            configDir: root.configDir,
            provider: 'codex',
            mtime: stat.mtime
          })
        }
      }
    }
  }
}

function parseJsonLine(buffer: Buffer): unknown | undefined {
  if (!buffer.length) return undefined
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown
  } catch {
    // Última linha parcialmente gravada e linha corrompida são ambas
    // ignoradas; nenhuma derruba a busca nem vaza o conteúdo no erro.
    return undefined
  }
}

async function readJsonl(
  file: string,
  budget: SearchBudget,
  countFile = true
): Promise<ReadJsonlResult | null> {
  if (budgetStopped(budget)) return null
  if (countFile) {
    if (budget.scannedFiles >= budget.limits.maxFiles) {
      budget.limitReason ??= 'arquivos'
      return null
    }
    budget.scannedFiles += 1
  }
  const stat = await safeRegularFile(file)
  if (!stat || budgetStopped(budget)) return null
  const remaining = budget.limits.maxBytes - budget.scannedBytes
  if (remaining <= 0) {
    budget.limitReason ??= 'bytes'
    return null
  }
  const length = Math.min(stat.size, budget.limits.maxBytesPerFile, remaining)
  if (length <= 0) return { lines: [], truncated: stat.size > 0 }
  const start = Math.max(0, stat.size - length)
  let handle: import('fs/promises').FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const data = Buffer.alloc(length)
    const { bytesRead } = await handle.read(data, 0, length, start)
    budget.scannedBytes += bytesRead
    if (bytesRead < length) data.fill(0, bytesRead)
    let view = data.subarray(0, bytesRead)
    let base = start
    if (start > 0) {
      const firstNewline = view.indexOf(0x0a)
      if (firstNewline < 0) return { lines: [], truncated: true }
      view = view.subarray(firstNewline + 1)
      base += firstNewline + 1
    }
    const lines: Array<{ value: unknown; cursor: number }> = []
    let lineStart = 0
    while (lineStart < view.length && !budgetStopped(budget)) {
      const newline = view.indexOf(0x0a, lineStart)
      const lineEnd = newline < 0 ? view.length : newline
      const lineLength = lineEnd - lineStart
      if (lineLength > 0 && lineLength <= budget.limits.maxLineBytes) {
        const value = parseJsonLine(view.subarray(lineStart, lineEnd))
        if (value !== undefined) lines.push({ value, cursor: base + lineStart })
      }
      if (newline < 0) break
      lineStart = newline + 1
    }
    if (stat.size > length && budget.scannedBytes >= budget.limits.maxBytes) {
      budget.limitReason ??= 'bytes'
    }
    return { lines, truncated: start > 0 }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readFirstJsonValue(
  file: string,
  budget: SearchBudget
): Promise<{ value: unknown; cursor: 0 } | undefined> {
  if (budget.signal?.aborted || Date.now() >= budget.deadline) return undefined
  const stat = await safeRegularFile(file)
  if (!stat) return undefined
  const remaining = budget.limits.maxBytes - budget.scannedBytes
  if (remaining <= 0) {
    budget.limitReason ??= 'bytes'
    return undefined
  }
  const length = Math.min(stat.size, budget.limits.maxLineBytes, remaining)
  if (length <= 0) return undefined
  let handle: import('fs/promises').FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const data = Buffer.alloc(length)
    const { bytesRead } = await handle.read(data, 0, length, 0)
    budget.scannedBytes += bytesRead
    const view = data.subarray(0, bytesRead)
    const newline = view.indexOf(0x0a)
    // Metadata maior que o teto é irreconhecível e falha fechado.
    if (newline < 0 && bytesRead < stat.size) return undefined
    const value = parseJsonLine(view.subarray(0, newline < 0 ? view.length : newline))
    return value === undefined ? undefined : { value, cursor: 0 }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function codexMeta(lines: readonly { value: unknown }[]): {
  sessionId?: string
  cwd?: string
  subagent: boolean
} {
  for (const { value } of lines.slice(0, 4)) {
    const entry = recordOf(value)
    const payload = recordOf(entry?.payload)
    if (entry?.type !== 'session_meta' || !payload) continue
    const id = safeProviderId(payload.id) ?? safeProviderId(payload.session_id)
    const cwd = boundedStringOf(payload.cwd, 4096)
    const source = recordOf(payload.source)
    const threadSource = stringOf(payload.thread_source)?.toLowerCase()
    const subagent =
      threadSource === 'subagent' ||
      Boolean(source && Object.prototype.hasOwnProperty.call(source, 'subagent')) ||
      Boolean(
        payload.parent_thread_id &&
          payload.id &&
          payload.session_id &&
          payload.id !== payload.session_id
      )
    return { sessionId: id, cwd, subagent }
  }
  return { subagent: false }
}

function sessionIdFromCodexFilename(file: string): string | undefined {
  return basename(file).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
  )?.[1]
}

function scopeForCwd(
  cwd: string | undefined,
  workspaces: readonly HistoryWorkspaceScope[]
): HistoryWorkspaceScope | undefined {
  if (!cwd) return undefined
  const exact = workspaces.find((scope) => normalizedPath(scope.cwd) === normalizedPath(cwd))
  if (exact) return exact
  return workspaces
    .filter((scope) => pathContains(scope.cwd, cwd))
    .sort((a, b) => normalizedPath(b.cwd).length - normalizedPath(a.cwd).length)[0]
}

function bindingFor(
  sessionId: string,
  scope: HistoryWorkspaceScope | undefined,
  bindings: ReadonlyMap<string, HistorySessionBinding>
): HistorySessionBinding | HistoryWorkspaceScope | undefined {
  return bindings.get(sessionId) ?? scope
}

function dedupeMessages(
  messages: readonly ParsedMessage[],
  preferred?: { id: string; cursor: number }
): ParsedMessage[] {
  const byId = new Map<string, ParsedMessage>()
  for (const message of messages) {
    const previous = byId.get(message.id)
    const messagePreferred = Boolean(
      preferred && message.id === preferred.id && message.cursor === preferred.cursor
    )
    const previousPreferred = Boolean(
      preferred && previous && previous.id === preferred.id && previous.cursor === preferred.cursor
    )
    // Claude pode regravar o mesmo assistant enquanto ele cresce. A forma
    // mais completa vence; no empate, a linha mais nova é o cursor canônico.
    if (
      !previous ||
      messagePreferred ||
      (!previousPreferred &&
        (message.text.length > previous.text.length ||
          (message.text.length === previous.text.length && message.cursor > previous.cursor)))
    ) {
      byId.set(message.id, message)
    }
  }
  const ordered = [...byId.values()].sort((a, b) => a.cursor - b.cursor)
  // Rollouts antigos do Codex duplicavam a mesma fala como event_msg e
  // response_item sem um id comum. Só remove duplicata adjacente exata e, no
  // load, preserva a linha que originou a seleção opaca.
  const result: ParsedMessage[] = []
  for (const message of ordered) {
    const previous = result[result.length - 1]
    if (!previous || message.role !== previous.role || message.text !== previous.text) {
      result.push(message)
      continue
    }
    if (message.id === preferred?.id && message.cursor === preferred.cursor) {
      result[result.length - 1] = message
    }
  }
  return result
}

function bindingMap(values: readonly HistorySessionBinding[]): Map<string, HistorySessionBinding> {
  const result = new Map<string, HistorySessionBinding>()
  for (const value of values) {
    if (!value.sessionId) continue
    const current = result.get(value.sessionId)
    if (!current || (!current.paneId && value.paneId) || (!current.missionId && value.missionId)) {
      result.set(value.sessionId, value)
    }
  }
  return result
}

export async function searchLocalHistory(
  input: LocalHistorySearchInput
): Promise<LocalHistorySearchResult> {
  const limits = limitsOf(input.limits)
  const budget: SearchBudget = {
    limits,
    deadline: Date.now() + limits.maxMs,
    signal: input.signal,
    scannedFiles: 0,
    scannedBytes: 0,
    softTruncated: false
  }
  // O texto indexado já foi redigido. Não redigir a consulta é importante:
  // procurar o valor bruto de um token não pode virar uma busca genérica por
  // "[redigido:token]" e revelar todas as mensagens que continham segredos.
  const normalizedQuery = normalizedSearchText(input.query.trim())
  if (!normalizedQuery || input.signal?.aborted) {
    return {
      hits: [],
      cancelled: Boolean(input.signal?.aborted),
      truncated: false,
      scannedFiles: 0,
      scannedBytes: 0
    }
  }

  const candidates = new Map<string, Candidate>()
  await Promise.all([
    discoverClaudeCandidates(input.roots, input.workspaces, budget, candidates),
    discoverCodexCandidates(input.roots, budget, candidates)
  ])
  const ordered = [...candidates.values()].sort((a, b) => b.mtime - a.mtime)
  const bindings = bindingMap(input.sessionBindings ?? [])
  const hits: LocalHistoryMatch[] = []

  for (const candidate of ordered) {
    if (budgetStopped(budget)) break
    if (budget.scannedFiles >= limits.maxFiles) {
      budget.limitReason ??= 'arquivos'
      break
    }
    const read = await readJsonl(candidate.file, budget)
    if (!read) continue
    if (read.truncated) budget.softTruncated = true
    let sessionId = candidate.sessionId
    let scope = candidate.scope
    if (candidate.provider === 'codex') {
      let meta = codexMeta(read.lines)
      // Busca por cauda mantém sessões grandes baratas; o session_meta mora
      // na primeira linha, então o lemos separadamente só quando necessário.
      if (read.truncated && (!meta.sessionId || !meta.cwd)) {
        const first = await readFirstJsonValue(candidate.file, budget)
        if (first) meta = codexMeta([first])
      }
      if (meta.subagent) continue
      sessionId = meta.sessionId ?? sessionIdFromCodexFilename(candidate.file)
      scope = scopeForCwd(meta.cwd, input.workspaces)
      // Rollout de outro produto/projeto local não cruza a fronteira.
      if (!scope && !(sessionId && bindings.has(sessionId))) continue
    }
    if (!sessionId) continue
    const binding = bindingFor(sessionId, scope, bindings)
    const parsed = dedupeMessages(
      read.lines
        .map(({ value, cursor }) =>
          extractVisibleHistoryMessage(candidate.provider, value, cursor, limits.maxMessageChars)
        )
        .filter((message): message is ParsedMessage => Boolean(message))
    )
    for (const message of parsed) {
      if (budgetStopped(budget)) break
      if (!normalizedSearchText(message.text).includes(normalizedQuery)) continue
      hits.push({
        provider: candidate.provider,
        sessionId,
        messageId: message.id,
        cursor: message.cursor,
        role: message.role,
        snippet: snippetFor(message.text, normalizedQuery),
        ...(message.at ? { at: message.at } : {}),
        ...(binding?.projectId ? { projectId: binding.projectId } : {}),
        ...(binding?.missionId ? { missionId: binding.missionId } : {}),
        ...(binding?.paneId ? { paneId: binding.paneId } : {}),
        ...(binding?.label ? { label: redactSensitiveText(binding.label).slice(0, 180) } : {}),
        canMount: binding?.canMount === true && Boolean(binding.paneId),
        locator: {
          file: candidate.file,
          configDir: candidate.configDir,
          provider: candidate.provider,
          sessionId,
          messageId: message.id,
          cursor: message.cursor
        }
      })
      if (hits.length >= limits.maxResults) {
        budget.limitReason ??= 'resultados'
        break
      }
    }
  }

  return {
    hits,
    cancelled: Boolean(input.signal?.aborted),
    truncated: Boolean(budget.limitReason) || budget.softTruncated,
    ...(budget.limitReason ? { limitReason: budget.limitReason } : {}),
    scannedFiles: budget.scannedFiles,
    scannedBytes: budget.scannedBytes
  }
}

/** Revalidação de contenção usada pelo IPC antes de honrar um selectionId. */
export async function localHistoryLocatorIsSafe(locator: LocalHistoryLocator): Promise<boolean> {
  try {
    const [root, file, stat] = await Promise.all([
      fs.realpath(locator.configDir),
      fs.realpath(locator.file),
      fs.lstat(locator.file)
    ])
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const normalizedRoot = normalizedPath(root)
    const normalizedFile = normalizedPath(file)
    const rootWithSep = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
    return normalizedFile.startsWith(rootWithSep)
  } catch {
    return false
  }
}

export async function loadLocalHistoryTranscript(
  locator: LocalHistoryLocator,
  options: { signal?: AbortSignal; limits?: Partial<HistorySearchLimits> } = {}
): Promise<LocalHistoryTranscriptResult> {
  const limits = limitsOf(options.limits)
  const budget: SearchBudget = {
    limits: { ...limits, maxFiles: 1, maxBytes: Math.max(limits.maxBytes, limits.maxBytesPerFile) },
    deadline: Date.now() + limits.maxMs,
    signal: options.signal,
    scannedFiles: 0,
    scannedBytes: 0,
    softTruncated: false
  }
  const read = await readJsonl(locator.file, budget)
  if (!read || options.signal?.aborted) {
    return { ok: false, error: 'não consegui carregar essa conversa antiga agora' }
  }
  const messages = dedupeMessages(
    read.lines
      .map(({ value, cursor }) =>
        extractVisibleHistoryMessage(locator.provider, value, cursor, limits.maxMessageChars)
      )
      .filter((message): message is ParsedMessage => Boolean(message)),
    { id: locator.messageId, cursor: locator.cursor }
  )
  let targetIndex = messages.findIndex(
    (message) => message.id === locator.messageId && message.cursor === locator.cursor
  )
  if (targetIndex < 0) {
    return {
      ok: false,
      error: 'a conversa mudou no disco e a mensagem exata não pôde ser reencontrada'
    }
  }

  const half = Math.floor(limits.maxTranscriptMessages / 2)
  const start = Math.max(0, Math.min(targetIndex - half, messages.length - limits.maxTranscriptMessages))
  const window = messages.slice(start, start + limits.maxTranscriptMessages)
  let chars = 0
  const visible: HistoryTranscriptMessage[] = []
  for (const message of window) {
    if (chars + message.text.length > limits.maxTranscriptChars && visible.length > 0) break
    visible.push({
      id: message.id,
      cursor: message.cursor,
      role: message.role,
      text: message.text,
      ...(message.at ? { at: message.at } : {})
    })
    chars += message.text.length
  }
  const target = messages[targetIndex]
  if (!visible.some((message) => message.id === target.id && message.cursor === target.cursor)) {
    // O teto textual nunca pode cortar justamente o alvo prometido.
    visible.push({
      id: target.id,
      cursor: target.cursor,
      role: target.role,
      text: target.text,
      ...(target.at ? { at: target.at } : {})
    })
    visible.sort((a, b) => a.cursor - b.cursor)
  }
  return {
    ok: true,
    provider: locator.provider,
    sessionId: locator.sessionId,
    messages: visible,
    targetMessageId: target.id,
    targetCursor: target.cursor,
    truncated:
      read.truncated || start > 0 || start + window.length < messages.length || visible.length < window.length
  }
}

/** ID curto e não reversível para fixtures/diagnóstico; nunca inclui path. */
export function historyLocatorFingerprint(locator: LocalHistoryLocator): string {
  return createHash('sha256')
    .update(`${locator.provider}\0${locator.sessionId}\0${locator.messageId}\0${locator.cursor}`)
    .digest('hex')
    .slice(0, 16)
}

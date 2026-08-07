import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DocumentStore, type DocumentSnapshot, type DocumentStoreOptions } from './documents'
import { LspClient, LspRpcError, LspTransportError } from './lspClient'
import {
  canonicalPath,
  detectTypeScriptServer,
  detectWorkspace,
  isPathInside,
  languageForPath,
  relativePathFromUri,
  resolveAuthorizedFile,
  type ServerDetectionOptions,
  type TypeScriptServerDescriptor,
  type WorkspaceDescriptor
} from './servers'
import {
  CodeIntelligenceError,
  type CodeCallEdge,
  type CodeCallHierarchyItem,
  type CodeDefinition,
  type CodeDiagnostic,
  type CodeHover,
  type CodeImplementation,
  type CodeIntelligenceSnapshot,
  type CodeLocation,
  type CodeOperation,
  type CodePosition,
  type CodeQuery,
  type CodeQueryResult,
  type CodeRange,
  type CodeReference,
  type CodeResultItem,
  type CodeServerMetadata,
  type CodeSymbol
} from './types'

const DEFAULT_IDLE_TTL_MS = 5 * 60_000
const DEFAULT_MAX_SERVERS = 8
const DEFAULT_MAX_RESTART_ATTEMPTS = 3
const DEFAULT_RESTART_BASE_DELAY_MS = 250
const DEFAULT_RESTART_WINDOW_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_LIMIT = 50
const HARD_RESULT_LIMIT = 200
const MAX_OFFSET = 1_000_000

// PRIMING DE DEPENDENTES (sondado em tsgo 7.0.2, 2026-08-03): o LSP nativo
// monta o programa a partir dos arquivos ABERTOS e do fecho de imports deles —
// references/implementations/call_hierarchy não enxergam um arquivo que
// IMPORTA o alvo se ele não estiver nesse fecho (refs cross-file vinham
// vazias). Um pull `textDocument/diagnostic` num arquivo FECHADO carrega o
// programa dele sem didOpen nem sincronização. Antes dessas consultas, um
// scan textual barato acha os prováveis dependentes e os "esquenta".
const DEPENDENT_SCAN_TTL_MS = 30_000
const DEPENDENT_PRIME_TIMEOUT_MS = 5_000
const DEPENDENT_PRIME_BUDGET_MS = 15_000
const DEPENDENT_MAX_CANDIDATES = 200
const DEPENDENT_MAX_SCAN_FILES = 4_000
const DEPENDENT_MAX_SCAN_DEPTH = 12
const DEPENDENT_MAX_FILE_BYTES = 2 * 1024 * 1024
const DEPENDENT_SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'
])
const DEPENDENT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', 'release', 'coverage',
  '.next', '.cache', '.synkora', '.tmp', '.claude', '.agents', 'vendor', 'target'
])
const DEPENDENT_CLOSURE_OPERATIONS: ReadonlySet<CodeOperation> = new Set([
  'references', 'implementations', 'call_hierarchy'
])

interface Runtime {
  client: LspClient
  documents: DocumentStore
  /** arquivos já "esquentados" via pull-diagnostic nesta vida do servidor */
  primedFiles: Set<string>
  /** último scan de dependentes por arquivo-alvo (TTL curto) */
  dependentScans: Map<string, number>
}

interface PoolEntry {
  key: string
  descriptor: TypeScriptServerDescriptor
  runtime: Runtime | null
  startingClient: LspClient | null
  startPromise: Promise<Runtime> | null
  disposePromise: Promise<void> | null
  activeQueries: number
  owners: Set<string>
  lastUsedAt: number
  restartFailures: number
  firstFailureAt: number
  nextRestartAt: number
  disposing: boolean
}

interface DiagnosticCheck {
  mtimeMs: number
  documentVersion: number
  checkedAt: number
  serverKey: string
  /** Resultado da consulta que carimbou esta revisao. Um diagnostico fresco
   *  com erro continua vermelho; "foi consultado" nao significa "esta limpo". */
  errorCount: number
  warningCount: number
}

export interface ManagerTelemetry {
  starts: number
  restarts: number
  evictions: number
  failures: number
  requests: number
  reuses: number
}

export interface CodeIntelligenceManagerOptions extends ServerDetectionOptions {
  idleTtlMs?: number
  maxServers?: number
  maxRestartAttempts?: number
  restartBaseDelayMs?: number
  restartWindowMs?: number
  requestTimeoutMs?: number
  maxFileBytes?: number
  watchDebounceMs?: number
  workspaceWatchDebounceMs?: number
  maxOpenBytes?: number
  maxOpenDocuments?: number
}

export interface CodePagination {
  limit?: number
  offset?: number
}

export interface CodeIntelligenceServiceSnapshot {
  state: 'idle' | 'active' | 'degraded' | 'closed'
  processCount: number
  languages: Array<'TypeScript' | 'JavaScript'>
  servers: Array<{
    kind: CodeServerMetadata['kind']
    name: string
    version: string
    running: boolean
    activeQueries: number
    openDocuments: number
    command?: string
  }>
  telemetry: ManagerTelemetry
}

export interface DiagnosticsGuardStatus {
  state: 'missing' | 'current' | 'stale' | 'unavailable'
  required: boolean
  available: boolean
  current: boolean
  checkedAt: number | null
  /** Presentes quando existe uma consulta atual. Ausentes em missing/stale e
   *  unavailable, pois nesses estados nao ha evidencia valida para contar. */
  errorCount?: number
  warningCount?: number
  reason?: string
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function compactText(value: unknown, maxLength = 600): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`
}

function lspPosition(value: unknown): CodePosition | null {
  const position = asObject(value)
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) return null
  const line = Number(position.line)
  const character = Number(position.character)
  if (line < 0 || character < 0) return null
  return { line: line + 1, column: character + 1 }
}

function lspRange(value: unknown): CodeRange | null {
  const range = asObject(value)
  if (!range) return null
  const start = lspPosition(range.start)
  const end = lspPosition(range.end)
  return start && end ? { start, end } : null
}

function requestPosition(position: CodePosition): { line: number; character: number } {
  if (
    !position ||
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.column) ||
    position.line < 1 ||
    position.column < 1
  ) {
    throw new CodeIntelligenceError('INVALID_ARGUMENT', 'line and column must be positive integers')
  }
  return { line: position.line - 1, character: position.column - 1 }
}

const SYMBOL_KINDS = [
  'unknown',
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enum_member',
  'struct',
  'event',
  'operator',
  'type_parameter'
] as const

function symbolKind(value: unknown): string {
  return typeof value === 'number' && value >= 1 && value < SYMBOL_KINDS.length
    ? SYMBOL_KINDS[value]
    : 'unknown'
}

function severity(value: unknown): CodeDiagnostic['severity'] {
  switch (value) {
    case 1:
      return 'error'
    case 2:
      return 'warning'
    case 3:
      return 'information'
    case 4:
      return 'hint'
    default:
      return 'unknown'
  }
}

function normalizedCode(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return compactText(value, 80)
  const object = asObject(value)
  if (typeof object?.value === 'string' || typeof object?.value === 'number') {
    return compactText(object.value, 80)
  }
  return undefined
}

function locationSortKey(item: CodeResultItem): string {
  if ('direction' in item) {
    return [
      item.direction,
      item.from.path,
      item.from.range.start.line,
      item.from.range.start.column,
      item.to.path,
      item.to.range.start.line,
      item.to.range.start.column,
      item.from.name,
      item.to.name
    ].join('\0')
  }
  const named = 'name' in item ? item.name : ''
  const message = 'message' in item ? item.message : ''
  return [
    item.path,
    String(item.range.start.line).padStart(10, '0'),
    String(item.range.start.column).padStart(10, '0'),
    String(item.range.end.line).padStart(10, '0'),
    String(item.range.end.column).padStart(10, '0'),
    named,
    message
  ].join('\0')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sortAndDedupe<T extends CodeResultItem>(items: T[]): T[] {
  const sorted = [...items].sort((left, right) => locationSortKey(left).localeCompare(locationSortKey(right)))
  const unique: T[] = []
  let previous = ''
  for (const item of sorted) {
    const serialized = JSON.stringify(item)
    if (serialized === previous) continue
    previous = serialized
    unique.push(item)
  }
  return unique
}

function pagination(query: CodeQuery): { offset: number; limit: number } {
  const offset = query.offset ?? 0
  const requestedLimit = query.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw new CodeIntelligenceError('INVALID_ARGUMENT', 'offset is outside the allowed range')
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new CodeIntelligenceError('INVALID_ARGUMENT', 'limit must be a positive integer')
  }
  return { offset, limit: Math.min(requestedLimit, HARD_RESULT_LIMIT) }
}

function locationFromRaw(
  root: string,
  raw: unknown,
  fallbackPath?: string,
  fallbackRange?: CodeRange
): CodeLocation | null {
  const value = asObject(raw)
  if (!value) return null
  const uri = typeof value.uri === 'string'
    ? value.uri
    : typeof value.targetUri === 'string'
      ? value.targetUri
      : null
  const path = uri ? relativePathFromUri(root, uri) : fallbackPath ?? null
  const range = lspRange(value.range ?? value.targetSelectionRange ?? value.targetRange) ?? fallbackRange ?? null
  return path && range ? { path, range } : null
}

function arrayResult(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value == null ? [] : [value]
}

function hoverContents(value: unknown): string {
  if (typeof value === 'string') return compactText(value, 2_000)
  if (Array.isArray(value)) return compactText(value.map(hoverContents).filter(Boolean).join(' · '), 2_000)
  const object = asObject(value)
  if (!object) return ''
  if (typeof object.value === 'string') return compactText(object.value, 2_000)
  if (typeof object.language === 'string' && typeof object.value === 'string') {
    return compactText(`${object.language}: ${object.value}`, 2_000)
  }
  return ''
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export class CodeIntelligenceManager {
  private readonly entries = new Map<string, PoolEntry>()
  private readonly ownerEntries = new Map<string, Set<string>>()
  private readonly pendingDisposals = new Set<Promise<void>>()
  private readonly diagnosticChecks = new Map<string, Map<string, DiagnosticCheck>>()
  private readonly diagnosticAvailability = new Map<
    string,
    Map<string, { available: boolean; reason?: string }>
  >()
  private readonly idleTtlMs: number
  private readonly maxServers: number
  private readonly maxRestartAttempts: number
  private readonly restartBaseDelayMs: number
  private readonly restartWindowMs: number
  private readonly requestTimeoutMs: number
  private readonly serverOptions: ServerDetectionOptions
  private readonly documentOptions: DocumentStoreOptions
  private readonly cleanupTimer: NodeJS.Timeout
  private readonly telemetry: ManagerTelemetry = {
    starts: 0,
    restarts: 0,
    evictions: 0,
    failures: 0,
    requests: 0,
    reuses: 0
  }
  private closed = false

  constructor(options: CodeIntelligenceManagerOptions = {}) {
    this.idleTtlMs = Math.max(100, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS)
    this.maxServers = Math.max(1, Math.floor(options.maxServers ?? DEFAULT_MAX_SERVERS))
    this.maxRestartAttempts = Math.max(
      0,
      Math.floor(options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS)
    )
    this.restartBaseDelayMs = Math.max(0, options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS)
    this.restartWindowMs = Math.max(1_000, options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS)
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    this.serverOptions = { appRoot: options.appRoot, appPath: options.appPath }
    this.documentOptions = {
      maxFileBytes: options.maxFileBytes,
      watchDebounceMs: options.watchDebounceMs,
      workspaceWatchDebounceMs: options.workspaceWatchDebounceMs,
      maxOpenBytes: options.maxOpenBytes,
      maxOpenDocuments: options.maxOpenDocuments
    }
    const cleanupInterval = Math.min(30_000, Math.max(50, Math.floor(this.idleTtlMs / 2)))
    this.cleanupTimer = setInterval(() => void this.cleanupIdle(), cleanupInterval)
    this.cleanupTimer.unref?.()
  }

  openWorkspace(cwd: string, ownerId: string = randomUUID()): CodeIntelligenceSession {
    this.assertOpen()
    const workspace = detectWorkspace(cwd)
    return new CodeIntelligenceSession(this, workspace, ownerId)
  }

  async query(cwd: string, query: CodeQuery): Promise<CodeQueryResult> {
    const workspace = detectWorkspace(cwd)
    return this.queryWorkspace(workspace, null, query)
  }

  async invalidateWorktree(directory: string): Promise<number> {
    this.assertOpen()
    const target = this.invalidationTarget(directory)
    const entries = this.matchingEntries(target)
    for (const entry of entries) {
      entry.runtime?.client.forceKill()
      entry.startingClient?.forceKill()
    }
    await Promise.all(entries.map((entry) => this.disposeEntry(entry)))
    this.clearWorktreeDiagnostics(target)
    return entries.length
  }

  /**
   * Synchronous invalidation barrier for git worktree removal/merge code paths.
   * Processes are killed and detached from the pool before this method returns;
   * stream/document cleanup continues in the background.
   */
  invalidateWorktreeNow(directory: string): number {
    this.assertOpen()
    const target = this.invalidationTarget(directory)
    const entries = this.matchingEntries(target)
    for (const entry of entries) {
      entry.runtime?.client.forceKill()
      entry.startingClient?.forceKill()
      void this.disposeEntry(entry)
    }
    this.clearWorktreeDiagnostics(target)
    return entries.length
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.cleanupTimer)
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.ownerEntries.clear()
    this.diagnosticChecks.clear()
    this.diagnosticAvailability.clear()
    await Promise.all([
      ...entries.map((entry) => this.disposeEntry(entry)),
      ...this.pendingDisposals
    ])
  }

  snapshot(): CodeIntelligenceSnapshot {
    const entries = [...this.entries.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => ({
        key: entry.key,
        root: entry.descriptor.root,
        server: entry.descriptor.metadata,
        running: Boolean(entry.runtime?.client.isRunning || entry.startPromise),
        activeQueries: entry.activeQueries,
        owners: entry.owners.size,
        lastUsedAt: entry.lastUsedAt,
        restartFailures: entry.restartFailures,
        openDocuments: entry.runtime?.documents.openDocumentCount ?? 0,
        documentBytes: entry.runtime?.documents.openBytes ?? 0
      }))
    return {
      closed: this.closed,
      processCount: entries.filter((entry) => entry.running).length,
      documentBytes: entries.reduce((total, entry) => total + entry.documentBytes, 0),
      entries,
      telemetry: { ...this.telemetry }
    }
  }

  /** Snapshot para a UI local: nunca inclui worktree, chave do pool, env,
   * argumentos, documento ou conteúdo. O executável é opt-in de detalhe. */
  serviceSnapshot(includeLocalDetails = false): CodeIntelligenceServiceSnapshot {
    const detectedLanguages = new Set<'TypeScript' | 'JavaScript'>()
    for (const entry of this.entries.values()) {
      for (const language of entry.runtime?.documents.openLanguages ?? []) {
        detectedLanguages.add(language.startsWith('typescript') ? 'TypeScript' : 'JavaScript')
      }
    }
    const servers = [...this.entries.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => ({
        kind: entry.descriptor.metadata.kind,
        name: entry.descriptor.metadata.name,
        version: entry.descriptor.metadata.version,
        running: Boolean(entry.runtime?.client.isRunning || entry.startPromise),
        activeQueries: entry.activeQueries,
        openDocuments: entry.runtime?.documents.openDocumentCount ?? 0,
        ...(includeLocalDetails ? { command: entry.descriptor.command } : {})
      }))
    const processCount = servers.filter((server) => server.running).length
    const degraded = [...this.entries.values()].some(
      (entry) => entry.restartFailures > 0 && !entry.runtime && !entry.startPromise
    )
    return {
      state: this.closed ? 'closed' : degraded ? 'degraded' : processCount > 0 ? 'active' : 'idle',
      processCount,
      languages: [...detectedLanguages].sort(),
      servers,
      telemetry: { ...this.telemetry }
    }
  }

  releaseOwner(ownerId: string): void {
    const keys = this.ownerEntries.get(ownerId)
    if (keys) {
      for (const key of keys) this.entries.get(key)?.owners.delete(ownerId)
      this.ownerEntries.delete(ownerId)
    }
    this.diagnosticChecks.delete(ownerId)
    this.diagnosticAvailability.delete(ownerId)
  }

  async diagnosticsGuard(
    workspace: WorkspaceDescriptor,
    ownerId: string,
    relativePath: string
  ): Promise<DiagnosticsGuardStatus> {
    try {
      this.validateWorkspace(workspace)
      const file = resolveAuthorizedFile(workspace.root, relativePath)
      languageForPath(file)
      const descriptor = detectTypeScriptServer(workspace.root, file, this.serverOptions)
      const mtimeMs = statSync(file).mtimeMs
      const check = this.diagnosticChecks.get(ownerId)?.get(file)
      if (!check) {
        return {
          state: 'missing',
          required: true,
          available: true,
          current: false,
          checkedAt: null,
          reason: 'diagnostics have not been checked for this file revision'
        }
      }
      const current = check.mtimeMs === mtimeMs && check.serverKey === descriptor.key
      return {
        state: current ? 'current' : 'stale',
        required: true,
        available: true,
        current,
        checkedAt: check.checkedAt,
        ...(current
          ? { errorCount: check.errorCount, warningCount: check.warningCount }
          : {}),
        ...(current ? {} : { reason: 'file or language-server configuration changed after diagnostics' })
      }
    } catch (error) {
      if (
        error instanceof CodeIntelligenceError &&
        (error.code === 'SERVER_UNAVAILABLE' || error.code === 'UNSUPPORTED_LANGUAGE')
      ) {
        return {
          state: 'unavailable',
          required: false,
          available: false,
          current: false,
          checkedAt: null,
          reason: error.message
        }
      }
      throw error
    }
  }

  async diagnosticsStatus(
    workspace: WorkspaceDescriptor,
    ownerId: string
  ): Promise<DiagnosticsGuardStatus> {
    this.validateWorkspace(workspace)
    const availability = this.diagnosticAvailability.get(ownerId)?.get(workspace.key)
    const checks = [...(this.diagnosticChecks.get(ownerId)?.entries() ?? [])]
      .filter(([file]) => isPathInside(workspace.root, file))
    if (checks.length === 0) {
      if (availability && !availability.available) {
        return {
          state: 'unavailable',
          required: false,
          available: false,
          current: false,
          checkedAt: null,
          reason: availability.reason ?? 'no compatible language server is available'
        }
      }
      return {
        state: 'missing',
        required: true,
        available: true,
        current: false,
        checkedAt: null,
        reason: 'diagnostics have not been checked in this worktree'
      }
    }

    let latestCheck = 0
    let errorCount = 0
    let warningCount = 0
    for (const [file, check] of checks) {
      latestCheck = Math.max(latestCheck, check.checkedAt)
      try {
        const mtimeMs = statSync(file).mtimeMs
        const descriptor = detectTypeScriptServer(workspace.root, file, this.serverOptions)
        if (mtimeMs !== check.mtimeMs || descriptor.key !== check.serverKey) {
          return {
            state: 'stale',
            required: true,
            available: true,
            current: false,
            checkedAt: latestCheck,
            reason: 'a checked file or language-server configuration changed'
          }
        }
        errorCount += check.errorCount
        warningCount += check.warningCount
      } catch (error) {
        if (
          error instanceof CodeIntelligenceError &&
          (error.code === 'SERVER_UNAVAILABLE' || error.code === 'UNSUPPORTED_LANGUAGE')
        ) {
          return {
            state: 'unavailable',
            required: false,
            available: false,
            current: false,
            checkedAt: latestCheck || null,
            reason: error.message
          }
        }
        return {
          state: 'stale',
          required: true,
          available: true,
          current: false,
          checkedAt: latestCheck || null,
          reason: 'a file checked by diagnostics is no longer available'
        }
      }
    }
    return {
      state: 'current',
      required: true,
      available: true,
      current: true,
      checkedAt: latestCheck || null,
      errorCount,
      warningCount
    }
  }

  async queryWorkspace(
    workspace: WorkspaceDescriptor,
    ownerId: string | null,
    query: CodeQuery
  ): Promise<CodeQueryResult> {
    this.assertOpen()
    this.validateWorkspace(workspace)
    const file = resolveAuthorizedFile(workspace.root, query.path)
    let language
    let descriptor: TypeScriptServerDescriptor
    try {
      language = languageForPath(file)
      descriptor = detectTypeScriptServer(workspace.root, file, this.serverOptions)
      if (ownerId && query.operation === 'diagnostics') {
        this.recordDiagnosticAvailability(ownerId, workspace.key, true)
      }
    } catch (error) {
      if (
        ownerId &&
        query.operation === 'diagnostics' &&
        error instanceof CodeIntelligenceError &&
        (error.code === 'SERVER_UNAVAILABLE' || error.code === 'UNSUPPORTED_LANGUAGE')
      ) {
        this.recordDiagnosticAvailability(ownerId, workspace.key, false, error.message)
      }
      throw error
    }
    const page = pagination(query)
    let entry = this.getOrCreateEntry(descriptor)
    if (ownerId) this.attachOwner(entry, ownerId)

    for (let attempt = 0; attempt < 2; attempt++) {
      const currentEntry = entry
      currentEntry.activeQueries += 1
      currentEntry.lastUsedAt = Date.now()
      this.telemetry.requests += 1
      let runtime: Runtime | null = null
      try {
        runtime = await this.ensureRuntime(currentEntry)
        const document = await runtime.documents.ensure(file, language)
        if (
          DEPENDENT_CLOSURE_OPERATIONS.has(query.operation) &&
          descriptor.metadata.kind === 'typescript-native'
        ) {
          await this.primeDependents(workspace.root, runtime, file)
        }
        const allItems = sortAndDedupe(
          await this.performOperation(workspace.root, runtime, document, query)
        )
        const total = allItems.length
        const items = allItems.slice(page.offset, page.offset + page.limit)
        const result: CodeQueryResult = {
          operation: query.operation,
          items,
          total,
          offset: page.offset,
          truncated: page.offset + items.length < total,
          language,
          server: descriptor.metadata,
          synchronization: document.synchronization
        }
        currentEntry.restartFailures = 0
        currentEntry.firstFailureAt = 0
        currentEntry.nextRestartAt = 0
        if (ownerId && query.operation === 'diagnostics' && document.synchronization.state === 'current') {
          this.recordDiagnosticCheck(ownerId, file, document, descriptor.key, allItems)
        }
        return result
      } catch (error) {
        if (runtime && error instanceof LspTransportError && attempt === 0) {
          await this.failRuntime(currentEntry, runtime)
          entry = this.getOrCreateEntry(descriptor)
          if (ownerId) this.attachOwner(entry, ownerId)
          continue
        }
        // WARM-UP pós-boot (pendência 2026-08-04): a 1ª consulta pode estourar
        // enquanto o tsgo ainda monta o programa — erro RETRYABLE com o server
        // vivo não é falha do runtime; uma espera curta e UMA repetição
        // resolvem sem derrubar/reiniciar nada.
        if (
          attempt === 0 &&
          error instanceof CodeIntelligenceError &&
          error.retryable &&
          runtime?.client.isRunning
        ) {
          await delay(900)
          continue
        }
        const publicError = this.publicError(error)
        if (
          ownerId &&
          query.operation === 'diagnostics' &&
          publicError.code === 'SERVER_UNAVAILABLE'
        ) {
          this.recordDiagnosticAvailability(ownerId, workspace.key, false, publicError.message)
        }
        throw publicError
      } finally {
        currentEntry.activeQueries = Math.max(0, currentEntry.activeQueries - 1)
        currentEntry.lastUsedAt = Date.now()
      }
    }
    throw new CodeIntelligenceError('REQUEST_FAILED', 'language-server request failed', true)
  }

  /** Especificadores prováveis do alvo em imports: o nome do arquivo sem
   *  extensão e, para `index.*`, o nome do diretório pai (`./pasta`). */
  private dependentSpecifiers(file: string): string[] {
    const name = basename(file, extname(file))
    if (!name) return []
    if (name !== 'index') return [name]
    const parent = basename(join(file, '..'))
    return parent ? [parent] : []
  }

  private collectWorkspaceSourceFiles(root: string): string[] {
    const files: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > DEPENDENT_MAX_SCAN_DEPTH || files.length >= DEPENDENT_MAX_SCAN_FILES) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (files.length >= DEPENDENT_MAX_SCAN_FILES) return
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !DEPENDENT_SKIP_DIRS.has(entry.name)) {
            walk(join(dir, entry.name), depth + 1)
          }
        } else if (entry.isFile() && DEPENDENT_SOURCE_EXTENSIONS.has(extname(entry.name))) {
          files.push(join(dir, entry.name))
        }
      }
    }
    walk(root, 0)
    return files
  }

  /** Esquenta os prováveis DEPENDENTES do alvo (arquivos que o importam) com
   *  pull-diagnostics, para o programa do servidor nativo conter quem
   *  referencia o símbolo. Best-effort: falha aqui nunca falha a consulta. */
  private async primeDependents(root: string, runtime: Runtime, targetFile: string): Promise<void> {
    const startedAt = Date.now()
    const lastScan = runtime.dependentScans.get(targetFile)
    if (lastScan !== undefined && startedAt - lastScan < DEPENDENT_SCAN_TTL_MS) return
    runtime.dependentScans.set(targetFile, startedAt)
    const specifiers = this.dependentSpecifiers(targetFile)
    if (specifiers.length === 0) return
    const patterns = specifiers.map(
      (name) =>
        new RegExp(
          String.raw`['"][^'"\n]*[/\\]?${escapeRegExp(name)}(?:\.(?:[cm]?js|[cm]?ts|jsx|tsx))?['"]`
        )
    )
    const importish = /\b(?:import|from|require|export)\b/
    const candidates: string[] = []
    for (const file of this.collectWorkspaceSourceFiles(root)) {
      if (candidates.length >= DEPENDENT_MAX_CANDIDATES) break
      if (file === targetFile || runtime.primedFiles.has(file)) continue
      let text: string
      try {
        if (statSync(file).size > DEPENDENT_MAX_FILE_BYTES) continue
        text = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      if (!specifiers.some((name) => text.includes(name))) continue
      if (!importish.test(text)) continue
      if (!patterns.some((pattern) => pattern.test(text))) continue
      candidates.push(file)
    }
    let index = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (Date.now() - startedAt > DEPENDENT_PRIME_BUDGET_MS) return
        const i = index++
        if (i >= candidates.length) return
        const file = candidates[i]
        runtime.primedFiles.add(file)
        try {
          await runtime.client.request(
            'textDocument/diagnostic',
            { textDocument: { uri: pathToFileURL(file).href } },
            DEPENDENT_PRIME_TIMEOUT_MS
          )
        } catch {
          // priming é otimização: sem ele a consulta responde (apenas rasa)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker))
  }

  private async performOperation(
    root: string,
    runtime: Runtime,
    document: DocumentSnapshot,
    query: CodeQuery
  ): Promise<CodeResultItem[]> {
    const textDocument = { uri: document.uri }
    switch (query.operation) {
      case 'diagnostics': {
        let raw: unknown
        try {
          raw = await runtime.client.request(
            'textDocument/diagnostic',
            { textDocument },
            this.requestTimeoutMs
          )
        } catch (error) {
          if (
            !(error instanceof LspRpcError) ||
            (error.rpcCode !== -32601 && error.rpcCode !== '-32601')
          ) {
            throw error
          }
          const published = runtime.documents.getPublishedDiagnostics(
            document.uri,
            document.version
          )
          if (!published) {
            throw new CodeIntelligenceError(
              'REQUEST_FAILED',
              'the language server has not published diagnostics for this document revision',
              true
            )
          }
          raw = { items: published.diagnostics }
        }
        const report = asObject(raw)
        const diagnostics = Array.isArray(report?.items) ? report.items : []
        return diagnostics.flatMap((item): CodeDiagnostic[] => {
          const value = asObject(item)
          const range = lspRange(value?.range)
          if (!value || !range || typeof value.message !== 'string') return []
          return [{
            path: this.relativeDocumentPath(root, document.file),
            range,
            severity: severity(value.severity),
            message: compactText(value.message),
            ...(normalizedCode(value.code) ? { code: normalizedCode(value.code) } : {}),
            ...(typeof value.source === 'string' ? { source: compactText(value.source, 80) } : {})
          }]
        })
      }
      case 'definition':
      case 'implementations':
      case 'references': {
        const position = requestPosition(query.position)
        const method = query.operation === 'definition'
          ? 'textDocument/definition'
          : query.operation === 'implementations'
            ? 'textDocument/implementation'
            : 'textDocument/references'
        const params = query.operation === 'references'
          ? {
              textDocument,
              position,
              context: { includeDeclaration: query.includeDeclaration ?? true }
            }
          : { textDocument, position }
        const raw = await runtime.client.request(method, params, this.requestTimeoutMs)
        return arrayResult(raw).flatMap((item): Array<CodeDefinition | CodeReference | CodeImplementation> => {
          const location = locationFromRaw(root, item)
          if (!location) return []
          if (query.operation !== 'definition') return [location]
          const value = asObject(item)
          const originRange = lspRange(value?.originSelectionRange)
          return [{ ...location, ...(originRange ? { originRange } : {}) }]
        })
      }
      case 'symbols': {
        const raw = await runtime.client.request(
          'textDocument/documentSymbol',
          { textDocument },
          this.requestTimeoutMs
        )
        return this.convertSymbols(root, arrayResult(raw), document)
      }
      case 'hover': {
        const raw = asObject(await runtime.client.request(
          'textDocument/hover',
          { textDocument, position: requestPosition(query.position) },
          this.requestTimeoutMs
        ))
        if (!raw) return []
        const contents = hoverContents(raw.contents)
        if (!contents) return []
        const point = { start: query.position, end: query.position }
        const range = lspRange(raw.range) ?? point
        const item: CodeHover = {
          path: this.relativeDocumentPath(root, document.file),
          range,
          contents
        }
        return [item]
      }
      case 'call_hierarchy':
        return this.callHierarchy(root, runtime.client, document, query)
    }
  }

  private convertSymbols(
    root: string,
    raw: unknown[],
    document: DocumentSnapshot,
    container?: string
  ): CodeSymbol[] {
    const symbols: CodeSymbol[] = []
    for (const item of raw) {
      const value = asObject(item)
      if (!value || typeof value.name !== 'string') continue
      const locationObject = asObject(value.location)
      const path = locationObject && typeof locationObject.uri === 'string'
        ? relativePathFromUri(root, locationObject.uri)
        : this.relativeDocumentPath(root, document.file)
      const range = lspRange(locationObject?.range ?? value.range)
      if (!path || !range) continue
      const selectionRange = lspRange(value.selectionRange)
      const ownContainer = typeof value.containerName === 'string'
        ? compactText(value.containerName, 160)
        : container
      symbols.push({
        path,
        range,
        name: compactText(value.name, 200),
        kind: symbolKind(value.kind),
        ...(typeof value.detail === 'string' ? { detail: compactText(value.detail, 300) } : {}),
        ...(ownContainer ? { container: ownContainer } : {}),
        ...(selectionRange ? { selectionRange } : {})
      })
      if (Array.isArray(value.children)) {
        const nextContainer = container ? `${container}.${compactText(value.name, 100)}` : compactText(value.name, 100)
        symbols.push(...this.convertSymbols(root, value.children, document, nextContainer))
      }
    }
    return symbols
  }

  private hierarchyItem(root: string, raw: unknown): CodeCallHierarchyItem | null {
    const value = asObject(raw)
    if (!value || typeof value.name !== 'string' || typeof value.uri !== 'string') return null
    const path = relativePathFromUri(root, value.uri)
    const range = lspRange(value.selectionRange ?? value.range)
    if (!path || !range) return null
    return {
      path,
      range,
      name: compactText(value.name, 200),
      kind: symbolKind(value.kind),
      ...(typeof value.detail === 'string' ? { detail: compactText(value.detail, 300) } : {})
    }
  }

  private async callHierarchy(
    root: string,
    client: LspClient,
    document: DocumentSnapshot,
    query: Extract<CodeQuery, { operation: 'call_hierarchy' }>
  ): Promise<CodeCallEdge[]> {
    const preparedRaw = await client.request(
      'textDocument/prepareCallHierarchy',
      { textDocument: { uri: document.uri }, position: requestPosition(query.position) },
      this.requestTimeoutMs
    )
    const prepared = arrayResult(preparedRaw).slice(0, 20)
    const direction = query.direction ?? 'both'
    const edges: CodeCallEdge[] = []

    for (const rawItem of prepared) {
      const center = this.hierarchyItem(root, rawItem)
      if (!center) continue
      if (direction === 'incoming' || direction === 'both') {
        const incoming = await client.request(
          'callHierarchy/incomingCalls',
          { item: rawItem },
          this.requestTimeoutMs
        )
        for (const rawCall of arrayResult(incoming)) {
          const call = asObject(rawCall)
          const from = this.hierarchyItem(root, call?.from)
          if (!from) continue
          const ranges = Array.isArray(call?.fromRanges)
            ? call.fromRanges.map(lspRange).filter((range): range is CodeRange => Boolean(range))
            : []
          edges.push({ direction: 'incoming', from, to: center, ...(ranges.length ? { ranges } : {}) })
        }
      }
      if (direction === 'outgoing' || direction === 'both') {
        const outgoing = await client.request(
          'callHierarchy/outgoingCalls',
          { item: rawItem },
          this.requestTimeoutMs
        )
        for (const rawCall of arrayResult(outgoing)) {
          const call = asObject(rawCall)
          const to = this.hierarchyItem(root, call?.to)
          if (!to) continue
          const ranges = Array.isArray(call?.fromRanges)
            ? call.fromRanges.map(lspRange).filter((range): range is CodeRange => Boolean(range))
            : []
          edges.push({ direction: 'outgoing', from: center, to, ...(ranges.length ? { ranges } : {}) })
        }
      }
    }
    return edges
  }

  private relativeDocumentPath(root: string, file: string): string {
    return relativePathFromUri(root, pathToFileURL(file).href)
      ?? basename(file)
  }

  private getOrCreateEntry(descriptor: TypeScriptServerDescriptor): PoolEntry {
    const existing = this.entries.get(descriptor.key)
    if (existing && !existing.disposing) {
      this.telemetry.reuses += 1
      return existing
    }
    const entry: PoolEntry = {
      key: descriptor.key,
      descriptor,
      runtime: null,
      startingClient: null,
      startPromise: null,
      disposePromise: null,
      activeQueries: 0,
      owners: new Set(),
      lastUsedAt: Date.now(),
      restartFailures: 0,
      firstFailureAt: 0,
      nextRestartAt: 0,
      disposing: false
    }
    this.entries.set(entry.key, entry)
    return entry
  }

  private async ensureRuntime(entry: PoolEntry): Promise<Runtime> {
    if (entry.runtime?.client.isRunning) return entry.runtime
    if (entry.startPromise) return entry.startPromise
    if (entry.disposing) throw new CodeIntelligenceError('SERVER_UNAVAILABLE', 'language server is stopping', true)

    const now = Date.now()
    if (entry.firstFailureAt && now - entry.firstFailureAt > this.restartWindowMs) {
      entry.restartFailures = 0
      entry.firstFailureAt = 0
      entry.nextRestartAt = 0
    }
    if (entry.restartFailures > this.maxRestartAttempts) {
      throw new CodeIntelligenceError(
        'SERVER_UNAVAILABLE',
        'language server restart limit was reached; retry after the cooldown',
        true
      )
    }

    const isRestart = entry.restartFailures > 0
    entry.startPromise = (async () => {
      try {
        // Assign startPromise before the first await so concurrent queries for
        // the same pool key cannot spawn duplicate servers.
        await this.ensureCapacity(entry)
        await delay(Math.max(0, entry.nextRestartAt - Date.now()))
        const client = await LspClient.start(
          {
            command: entry.descriptor.command,
            args: entry.descriptor.args,
            cwd: entry.descriptor.root,
            env: entry.descriptor.env
          },
          entry.descriptor.root,
          (startingClient) => {
            entry.startingClient = startingClient
            if (entry.disposing || this.closed) startingClient.forceKill()
          }
        )
        entry.startingClient = null
        if (entry.disposing || this.closed) {
          await client.stop()
          throw new CodeIntelligenceError('SERVER_UNAVAILABLE', 'language server start was cancelled', true)
        }
        const runtime = {
          client,
          documents: new DocumentStore(client, this.documentOptions),
          primedFiles: new Set<string>(),
          dependentScans: new Map<string, number>()
        }
        entry.runtime = runtime
        this.telemetry.starts += 1
        if (isRestart) this.telemetry.restarts += 1
        void client.exitPromise.then(() => {
          if (!entry.disposing && entry.runtime?.client === client) {
            void this.failRuntime(entry, runtime)
          }
        })
        return runtime
      } catch (error) {
        entry.startingClient = null
        if (!(error instanceof CodeIntelligenceError && error.code === 'SERVER_BUSY')) {
          this.noteFailure(entry)
        }
        throw error
      } finally {
        entry.startPromise = null
      }
    })()
    return entry.startPromise
  }

  private async ensureCapacity(target: PoolEntry): Promise<void> {
    const running = [...this.entries.values()].filter(
      (entry) => entry !== target && (entry.runtime || entry.startPromise)
    )
    if (running.length < this.maxServers) return
    const candidate = running
      .filter((entry) => entry.activeQueries === 0 && entry.owners.size === 0 && !entry.disposing)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
    if (!candidate) {
      throw new CodeIntelligenceError('SERVER_BUSY', 'all language-server slots are busy', true)
    }
    this.telemetry.evictions += 1
    await this.disposeEntry(candidate)
  }

  private async failRuntime(entry: PoolEntry, runtime: Runtime): Promise<void> {
    if (entry.runtime !== runtime) return
    entry.runtime = null
    this.noteFailure(entry)
    runtime.client.forceKill()
    await runtime.documents.close()
    await runtime.client.stop()
  }

  private noteFailure(entry: PoolEntry): void {
    const now = Date.now()
    if (!entry.firstFailureAt || now - entry.firstFailureAt > this.restartWindowMs) {
      entry.firstFailureAt = now
      entry.restartFailures = 0
    }
    entry.restartFailures += 1
    const exponent = Math.max(0, entry.restartFailures - 1)
    entry.nextRestartAt = now + Math.min(5_000, this.restartBaseDelayMs * (2 ** exponent))
    this.telemetry.failures += 1
  }

  private async disposeEntry(entry: PoolEntry): Promise<void> {
    if (entry.disposePromise) return entry.disposePromise
    entry.disposing = true
    entry.startingClient?.forceKill()
    this.entries.delete(entry.key)
    for (const owner of entry.owners) {
      const keys = this.ownerEntries.get(owner)
      keys?.delete(entry.key)
      if (keys?.size === 0) this.ownerEntries.delete(owner)
    }
    const disposal = (async () => {
      let runtime = entry.runtime
      if (!runtime && entry.startPromise) {
        try {
          runtime = await entry.startPromise
        } catch {
          runtime = null
        }
      }
      entry.runtime = null
      if (runtime) {
        await runtime.documents.close()
        await runtime.client.stop()
      }
    })()
    entry.disposePromise = disposal
    this.pendingDisposals.add(disposal)
    void disposal.then(
      () => this.pendingDisposals.delete(disposal),
      () => this.pendingDisposals.delete(disposal)
    )
    return disposal
  }

  private async cleanupIdle(): Promise<void> {
    if (this.closed) return
    const cutoff = Date.now() - this.idleTtlMs
    const idle = [...this.entries.values()].filter(
      (entry) =>
        entry.activeQueries === 0 &&
        entry.owners.size === 0 &&
        entry.lastUsedAt <= cutoff &&
        !entry.disposing
    )
    await Promise.all(idle.map((entry) => this.disposeEntry(entry)))
  }

  private attachOwner(entry: PoolEntry, ownerId: string): void {
    const previousKeys = this.ownerEntries.get(ownerId)
    if (previousKeys) {
      for (const key of [...previousKeys]) {
        const previous = this.entries.get(key)
        if (
          previous &&
          previous !== entry &&
          previous.descriptor.root === entry.descriptor.root &&
          previous.descriptor.metadata.config === entry.descriptor.metadata.config &&
          previous.descriptor.metadata.kind === entry.descriptor.metadata.kind
        ) {
          previous.owners.delete(ownerId)
          previousKeys.delete(key)
        }
      }
    }
    entry.owners.add(ownerId)
    let keys = this.ownerEntries.get(ownerId)
    if (!keys) {
      keys = new Set()
      this.ownerEntries.set(ownerId, keys)
    }
    keys.add(entry.key)
  }

  private recordDiagnosticCheck(
    ownerId: string,
    file: string,
    document: DocumentSnapshot,
    serverKey: string,
    items: CodeResultItem[]
  ): void {
    let checks = this.diagnosticChecks.get(ownerId)
    if (!checks) {
      checks = new Map()
      this.diagnosticChecks.set(ownerId, checks)
    }
    checks.set(file, {
      mtimeMs: document.synchronization.diskMtimeMs ?? 0,
      documentVersion: document.version,
      checkedAt: Date.now(),
      serverKey,
      errorCount: items.filter(
        (item): item is CodeDiagnostic => 'severity' in item && item.severity === 'error'
      ).length,
      warningCount: items.filter(
        (item): item is CodeDiagnostic => 'severity' in item && item.severity === 'warning'
      ).length
    })
  }

  private recordDiagnosticAvailability(
    ownerId: string,
    workspaceKey: string,
    available: boolean,
    reason?: string
  ): void {
    let workspaces = this.diagnosticAvailability.get(ownerId)
    if (!workspaces) {
      workspaces = new Map()
      this.diagnosticAvailability.set(ownerId, workspaces)
    }
    workspaces.set(workspaceKey, { available, ...(reason ? { reason } : {}) })
  }

  private validateWorkspace(workspace: WorkspaceDescriptor): void {
    if (!existsSync(workspace.root)) {
      throw new CodeIntelligenceError('SERVER_UNAVAILABLE', 'authorized worktree no longer exists')
    }
    try {
      if (canonicalPath(workspace.root) !== workspace.root) {
        throw new CodeIntelligenceError('SERVER_UNAVAILABLE', 'authorized worktree identity changed')
      }
    } catch (error) {
      if (error instanceof CodeIntelligenceError) throw error
      throw new CodeIntelligenceError('SERVER_UNAVAILABLE', 'authorized worktree is unavailable')
    }
  }

  private invalidationTarget(directory: string): string {
    try {
      return canonicalPath(directory)
    } catch {
      // Callers should invalidate before removal; text resolution still matches a just-removed path.
      return directory
    }
  }

  private matchingEntries(target: string): PoolEntry[] {
    return [...this.entries.values()].filter(
      (entry) => isPathInside(target, entry.descriptor.root) || isPathInside(entry.descriptor.root, target)
    )
  }

  private clearWorktreeDiagnostics(target: string): void {
    for (const checks of this.diagnosticChecks.values()) {
      for (const file of [...checks.keys()]) {
        if (isPathInside(target, file)) checks.delete(file)
      }
    }
    let workspaceKey: string | null = null
    try {
      workspaceKey = detectWorkspace(target).key
    } catch {
      // The path may already have been removed.
    }
    if (workspaceKey) {
      for (const availability of this.diagnosticAvailability.values()) {
        availability.delete(workspaceKey)
      }
    }
  }

  private publicError(error: unknown): CodeIntelligenceError {
    if (error instanceof CodeIntelligenceError) return error
    if (error instanceof LspRpcError) {
      return new CodeIntelligenceError('REQUEST_FAILED', error.message)
    }
    if (error instanceof LspTransportError) {
      return new CodeIntelligenceError('SERVER_UNAVAILABLE', error.message, true)
    }
    return new CodeIntelligenceError('REQUEST_FAILED', 'code intelligence request failed', true)
  }

  private assertOpen(): void {
    if (this.closed) throw new CodeIntelligenceError('MANAGER_CLOSED', 'code intelligence manager is closed')
  }
}

export class CodeIntelligenceSession {
  private closed = false

  constructor(
    private readonly manager: CodeIntelligenceManager,
    private readonly workspace: WorkspaceDescriptor,
    readonly ownerId: string
  ) {}

  query(query: CodeQuery): Promise<CodeQueryResult> {
    this.assertOpen()
    return this.manager.queryWorkspace(this.workspace, this.ownerId, query)
  }

  diagnostics(path: string, page: CodePagination = {}): Promise<CodeQueryResult<CodeDiagnostic>> {
    return this.query({ operation: 'diagnostics', path, ...page }) as Promise<CodeQueryResult<CodeDiagnostic>>
  }

  definition(
    path: string,
    position: CodePosition,
    page: CodePagination = {}
  ): Promise<CodeQueryResult<CodeDefinition>> {
    return this.query({ operation: 'definition', path, position, ...page }) as Promise<CodeQueryResult<CodeDefinition>>
  }

  references(
    path: string,
    position: CodePosition,
    options: CodePagination & { includeDeclaration?: boolean } = {}
  ): Promise<CodeQueryResult<CodeReference>> {
    return this.query({ operation: 'references', path, position, ...options }) as Promise<CodeQueryResult<CodeReference>>
  }

  symbols(path: string, page: CodePagination = {}): Promise<CodeQueryResult<CodeSymbol>> {
    return this.query({ operation: 'symbols', path, ...page }) as Promise<CodeQueryResult<CodeSymbol>>
  }

  hover(
    path: string,
    position: CodePosition,
    page: CodePagination = {}
  ): Promise<CodeQueryResult<CodeHover>> {
    return this.query({ operation: 'hover', path, position, ...page }) as Promise<CodeQueryResult<CodeHover>>
  }

  implementations(
    path: string,
    position: CodePosition,
    page: CodePagination = {}
  ): Promise<CodeQueryResult<CodeImplementation>> {
    return this.query({ operation: 'implementations', path, position, ...page }) as Promise<CodeQueryResult<CodeImplementation>>
  }

  callHierarchy(
    path: string,
    position: CodePosition,
    options: CodePagination & { direction?: 'incoming' | 'outgoing' | 'both' } = {}
  ): Promise<CodeQueryResult<CodeCallEdge>> {
    return this.query({ operation: 'call_hierarchy', path, position, ...options }) as Promise<CodeQueryResult<CodeCallEdge>>
  }

  diagnosticsGuard(path: string): Promise<DiagnosticsGuardStatus> {
    this.assertOpen()
    return this.manager.diagnosticsGuard(this.workspace, this.ownerId, path)
  }

  diagnosticsStatus(): Promise<DiagnosticsGuardStatus> {
    this.assertOpen()
    return this.manager.diagnosticsStatus(this.workspace, this.ownerId)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.manager.releaseOwner(this.ownerId)
  }

  private assertOpen(): void {
    if (this.closed) throw new CodeIntelligenceError('MANAGER_CLOSED', 'code intelligence session is closed')
  }
}

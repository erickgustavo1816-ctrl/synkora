import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LspClient } from './lspClient'
import { canonicalPath, isPathInside } from './servers'
import { CodeIntelligenceError, type CodeLanguage, type CodeSynchronizationMetadata } from './types'

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_WATCH_DEBOUNCE_MS = 120
const DEFAULT_WORKSPACE_WATCH_DEBOUNCE_MS = 180
const DEFAULT_MAX_OPEN_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_OPEN_DOCUMENTS = 128
const MAX_WORKSPACE_EVENTS = 256
const MAX_PUBLISHED_DIAGNOSTICS = 500

interface DiskDocument {
  text: string
  mtimeMs: number
  size: number
}

interface OpenDocument extends DiskDocument {
  file: string
  uri: string
  language: CodeLanguage
  version: number
  watcher: FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
  syncQueue: Promise<void>
  state: CodeSynchronizationMetadata['state']
  staleReason?: string
  byteSize: number
  lastAccessAt: number
}

export interface DocumentSnapshot {
  file: string
  uri: string
  language: CodeLanguage
  version: number
  synchronization: CodeSynchronizationMetadata
}

export interface DocumentStoreOptions {
  maxFileBytes?: number
  watchDebounceMs?: number
  workspaceWatchDebounceMs?: number
  maxOpenBytes?: number
  maxOpenDocuments?: number
}

interface PublishedDiagnostics {
  version: number | null
  diagnostics: unknown[]
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeDiagnosticRange(value: unknown): unknown | null {
  const range = objectValue(value)
  const start = objectValue(range?.start)
  const end = objectValue(range?.end)
  if (
    !Number.isSafeInteger(start?.line) ||
    !Number.isSafeInteger(start?.character) ||
    !Number.isSafeInteger(end?.line) ||
    !Number.isSafeInteger(end?.character)
  ) return null
  return {
    start: { line: start?.line, character: start?.character },
    end: { line: end?.line, character: end?.character }
  }
}

function safeDiagnosticCode(value: unknown): string | number | undefined {
  if (typeof value === 'string') return value.slice(0, 120)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const object = objectValue(value)
  if (typeof object?.value === 'string') return object.value.slice(0, 120)
  if (typeof object?.value === 'number' && Number.isFinite(object.value)) return object.value
  return undefined
}

export class DocumentStore {
  private readonly documents = new Map<string, OpenDocument>()
  private readonly publishedDiagnostics = new Map<string, PublishedDiagnostics>()
  private readonly maxFileBytes: number
  private readonly watchDebounceMs: number
  private readonly workspaceWatchDebounceMs: number
  private readonly maxOpenBytes: number
  private readonly maxOpenDocuments: number
  private readonly removeDiagnosticListener: () => void
  private workspaceWatcher: FSWatcher | null = null
  private workspaceDebounceTimer: NodeJS.Timeout | null = null
  private readonly workspaceEvents = new Map<string, 1 | 2 | 3>()
  private totalBytes = 0
  private closed = false

  constructor(
    private readonly client: LspClient,
    options: DocumentStoreOptions = {}
  ) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
    this.workspaceWatchDebounceMs = options.workspaceWatchDebounceMs
      ?? DEFAULT_WORKSPACE_WATCH_DEBOUNCE_MS
    this.maxOpenBytes = options.maxOpenBytes ?? DEFAULT_MAX_OPEN_BYTES
    this.maxOpenDocuments = options.maxOpenDocuments ?? DEFAULT_MAX_OPEN_DOCUMENTS
    this.removeDiagnosticListener = client.onNotification(
      'textDocument/publishDiagnostics',
      (params) => this.capturePublishedDiagnostics(params)
    )
    this.startWorkspaceWatcher()
  }

  get openDocumentCount(): number {
    return this.documents.size
  }

  get openBytes(): number {
    return this.totalBytes
  }

  /** Somente identificadores de linguagem agregados; nunca expõe arquivos. */
  get openLanguages(): CodeLanguage[] {
    return [...new Set([...this.documents.values()].map((document) => document.language))]
      .sort()
  }

  async ensure(file: string, language: CodeLanguage): Promise<DocumentSnapshot> {
    if (this.closed) throw new CodeIntelligenceError('REQUEST_FAILED', 'document store is closed', true)
    const existing = this.documents.get(file)
    if (existing) {
      if (existing.language !== language) {
        throw new CodeIntelligenceError('INVALID_ARGUMENT', 'document language changed while open')
      }
      existing.lastAccessAt = Date.now()
      await this.synchronize(existing, true)
      return this.snapshot(existing)
    }

    const disk = await this.readStable(file)
    const byteSize = Buffer.byteLength(disk.text, 'utf8')
    await this.ensureBudget(byteSize)
    const document: OpenDocument = {
      ...disk,
      file,
      uri: pathToFileURL(file).href,
      language,
      version: 1,
      watcher: null,
      debounceTimer: null,
      syncQueue: Promise.resolve(),
      state: 'current',
      byteSize,
      lastAccessAt: Date.now()
    }
    this.documents.set(file, document)
    this.totalBytes += byteSize
    try {
      this.publishedDiagnostics.delete(document.uri)
      await this.client.notify('textDocument/didOpen', {
        textDocument: {
          uri: document.uri,
          languageId: language,
          version: document.version,
          text: document.text
        }
      })
      this.startWatcher(document)
      return this.snapshot(document)
    } catch (error) {
      this.documents.delete(file)
      this.totalBytes = Math.max(0, this.totalBytes - document.byteSize)
      this.stopWatcher(document)
      throw error
    }
  }

  getPublishedDiagnostics(uri: string, expectedVersion?: number): PublishedDiagnostics | null {
    const published = this.publishedDiagnostics.get(uri) ?? null
    if (
      published &&
      expectedVersion !== undefined &&
      published.version !== null &&
      published.version !== expectedVersion
    ) {
      return null
    }
    return published
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.removeDiagnosticListener()
    this.stopWorkspaceWatcher()
    const documents = [...this.documents.values()]
    this.documents.clear()
    this.totalBytes = 0
    for (const document of documents) {
      this.stopWatcher(document)
      try {
        await document.syncQueue
      } catch {
        // Closing remains best-effort if a previous disk synchronization failed.
      }
      try {
        await this.client.notify('textDocument/didClose', {
          textDocument: { uri: document.uri }
        })
      } catch {
        // The manager may be disposing a failed server.
      }
    }
    this.publishedDiagnostics.clear()
  }

  private snapshot(document: OpenDocument): DocumentSnapshot {
    return {
      file: document.file,
      uri: document.uri,
      language: document.language,
      version: document.version,
      synchronization: {
        state: document.state,
        documentVersion: document.version,
        diskMtimeMs: document.mtimeMs,
        ...(document.staleReason ? { reason: document.staleReason } : {})
      }
    }
  }

  private async readStable(file: string): Promise<DiskDocument> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const beforeFile = this.authorizedReadPath(file)
      let before
      try {
        before = await stat(beforeFile)
      } catch {
        throw new CodeIntelligenceError('FILE_NOT_FOUND', 'file no longer exists')
      }
      if (!before.isFile()) throw new CodeIntelligenceError('INVALID_ARGUMENT', 'path is not a file')
      if (before.size > this.maxFileBytes) {
        throw new CodeIntelligenceError('FILE_TOO_LARGE', 'file exceeds the code intelligence size limit')
      }

      let text: string
      try {
        // Re-resolve immediately before the read. This catches a path whose
        // symlink/junction target changed after authorization or the first stat.
        const readableFile = this.authorizedReadPath(file)
        if (!this.sameCanonicalPath(beforeFile, readableFile)) continue
        text = await readFile(readableFile, 'utf8')
      } catch (error) {
        if (error instanceof CodeIntelligenceError) throw error
        throw new CodeIntelligenceError('FILE_NOT_FOUND', 'file could not be read')
      }
      const afterFile = this.authorizedReadPath(file)
      if (!this.sameCanonicalPath(beforeFile, afterFile)) continue
      const after = await stat(afterFile).catch(() => null)
      if (!after) throw new CodeIntelligenceError('FILE_NOT_FOUND', 'file no longer exists')
      if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
        return { text, size: after.size, mtimeMs: after.mtimeMs }
      }
    }
    throw new CodeIntelligenceError(
      'REQUEST_FAILED',
      'file changed repeatedly while it was being synchronized',
      true
    )
  }

  private authorizedReadPath(file: string): string {
    let canonical: string
    try {
      canonical = canonicalPath(file)
    } catch {
      throw new CodeIntelligenceError('FILE_NOT_FOUND', 'file no longer exists')
    }
    if (!isPathInside(this.client.workspaceRoot, canonical)) {
      throw new CodeIntelligenceError(
        'PATH_OUTSIDE_WORKTREE',
        'file resolves outside the authorized worktree'
      )
    }
    return canonical
  }

  private sameCanonicalPath(left: string, right: string): boolean {
    return isPathInside(left, right) && isPathInside(right, left)
  }

  private synchronize(document: OpenDocument, wait: boolean): Promise<void> {
    const operation = document.syncQueue.then(async () => {
      try {
        const disk = await this.readStable(document.file)
        if (this.documents.get(document.file) !== document) return
        const nextByteSize = Buffer.byteLength(disk.text, 'utf8')
        await this.ensureBudget(Math.max(0, nextByteSize - document.byteSize), document.file)
        if (this.documents.get(document.file) !== document) return
        if (disk.text !== document.text) {
          document.version += 1
          this.publishedDiagnostics.delete(document.uri)
          await this.client.notify('textDocument/didChange', {
            textDocument: { uri: document.uri, version: document.version },
            contentChanges: [{ text: disk.text }]
          })
        }
        if (this.documents.get(document.file) !== document) return
        document.text = disk.text
        document.size = disk.size
        document.mtimeMs = disk.mtimeMs
        this.totalBytes = Math.max(0, this.totalBytes - document.byteSize + nextByteSize)
        document.byteSize = nextByteSize
        document.lastAccessAt = Date.now()
        document.state = 'current'
        delete document.staleReason
      } catch (error) {
        document.state = 'stale'
        document.staleReason = error instanceof Error ? error.message : 'disk synchronization failed'
        if (wait) throw error
      }
    })
    document.syncQueue = operation.catch(() => undefined)
    return wait ? operation : document.syncQueue
  }

  private startWatcher(document: OpenDocument): void {
    try {
      const watcher = watch(document.file, { persistent: false }, () => {
        if (this.closed || !this.documents.has(document.file)) return
        document.state = 'stale'
        document.staleReason = 'disk change is pending synchronization'
        if (document.debounceTimer) clearTimeout(document.debounceTimer)
        document.debounceTimer = setTimeout(() => {
          document.debounceTimer = null
          void this.synchronize(document, false)
        }, this.watchDebounceMs)
        document.debounceTimer.unref?.()
      })
      watcher.on('error', () => {
        document.state = 'stale'
        document.staleReason = 'file watcher failed; next query will synchronize from disk'
        document.watcher = null
      })
      document.watcher = watcher
    } catch {
      // Queries always re-read disk, so watcher failure degrades without stale answers.
      document.state = 'unknown'
      document.staleReason = 'file watcher is unavailable; queries synchronize from disk'
    }
  }

  private stopWatcher(document: OpenDocument): void {
    if (document.debounceTimer) clearTimeout(document.debounceTimer)
    document.debounceTimer = null
    try {
      document.watcher?.close()
    } catch {
      // Already closed.
    }
    document.watcher = null
  }

  private capturePublishedDiagnostics(value: unknown): void {
    const params = objectValue(value)
    if (!params || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return
    const document = [...this.documents.values()].find((candidate) => candidate.uri === params.uri)
    if (!document) return
    const version = typeof params.version === 'number' ? params.version : null
    if (version !== null && version !== document.version) return
    const diagnostics: unknown[] = []
    for (const raw of params.diagnostics.slice(0, MAX_PUBLISHED_DIAGNOSTICS)) {
      const item = objectValue(raw)
      if (!item || typeof item.message !== 'string') continue
      const range = safeDiagnosticRange(item.range)
      if (!range) continue
      const code = safeDiagnosticCode(item.code)
      diagnostics.push({
        range,
        severity: item.severity,
        message: item.message.slice(0, 2_000),
        ...(code !== undefined ? { code } : {}),
        source: typeof item.source === 'string' ? item.source.slice(0, 120) : undefined
      })
    }
    this.publishedDiagnostics.set(params.uri, { version, diagnostics })
  }

  private async ensureBudget(extraBytes: number, protectedFile?: string): Promise<void> {
    for (;;) {
      const tooManyDocuments = protectedFile === undefined
        ? this.documents.size >= this.maxOpenDocuments
        : this.documents.size > this.maxOpenDocuments
      const tooManyBytes = this.totalBytes + extraBytes > this.maxOpenBytes
      if (!tooManyDocuments && !tooManyBytes) return
      const candidate = [...this.documents.values()]
        .filter((document) => document.file !== protectedFile)
        .sort((left, right) => left.lastAccessAt - right.lastAccessAt)[0]
      if (!candidate) {
        throw new CodeIntelligenceError(
          'FILE_TOO_LARGE',
          'open document memory budget would be exceeded'
        )
      }
      this.closeDocument(candidate)
    }
  }

  private closeDocument(document: OpenDocument): void {
    if (!this.documents.delete(document.file)) return
    this.stopWatcher(document)
    this.totalBytes = Math.max(0, this.totalBytes - document.byteSize)
    this.publishedDiagnostics.delete(document.uri)
    void document.syncQueue
      .then(() => this.client.notify('textDocument/didClose', {
        textDocument: { uri: document.uri }
      }))
      .catch(() => undefined)
  }

  private startWorkspaceWatcher(): void {
    try {
      this.workspaceWatcher = watch(
        this.client.workspaceRoot,
        { persistent: false, recursive: true },
        (eventType, filename) => {
          if (this.closed || !filename || this.workspaceEvents.size >= MAX_WORKSPACE_EVENTS) return
          const relativeName = String(filename).replaceAll('\\', '/')
          if (
            relativeName.split('/').some((part) => part === '.git' || part === 'node_modules')
          ) return
          const absolute = resolve(this.client.workspaceRoot, relativeName)
          const rel = relative(this.client.workspaceRoot, absolute)
          if (!isPathInside(this.client.workspaceRoot, absolute) || rel === '' || isAbsolute(rel)) return
          this.workspaceEvents.set(absolute, eventType === 'change' ? 2 : 1)
          if (this.workspaceDebounceTimer) clearTimeout(this.workspaceDebounceTimer)
          this.workspaceDebounceTimer = setTimeout(
            () => void this.flushWorkspaceEvents(),
            this.workspaceWatchDebounceMs
          )
          this.workspaceDebounceTimer.unref?.()
        }
      )
      this.workspaceWatcher.on('error', () => {
        try {
          this.workspaceWatcher?.close()
        } catch {
          // Already closed.
        }
        this.workspaceWatcher = null
      })
    } catch {
      // Recursive watching is platform-dependent; per-document synchronization remains active.
      this.workspaceWatcher = null
    }
  }

  private async flushWorkspaceEvents(): Promise<void> {
    this.workspaceDebounceTimer = null
    if (this.closed || this.workspaceEvents.size === 0) return
    const pending = [...this.workspaceEvents.entries()]
    this.workspaceEvents.clear()
    const changes = await Promise.all(pending.map(async ([file, type]) => {
      if (type === 1) {
        const current = await stat(file).catch(() => null)
        type = current ? 1 : 3
      }
      return { uri: pathToFileURL(file).href, type }
    }))
    try {
      await this.client.notify('workspace/didChangeWatchedFiles', { changes })
    } catch {
      // A failed server is restarted by the manager on the next query.
    }
  }

  private stopWorkspaceWatcher(): void {
    if (this.workspaceDebounceTimer) clearTimeout(this.workspaceDebounceTimer)
    this.workspaceDebounceTimer = null
    this.workspaceEvents.clear()
    try {
      this.workspaceWatcher?.close()
    } catch {
      // Already closed.
    }
    this.workspaceWatcher = null
  }
}

import {
  lstatSync,
  readdirSync,
  realpathSync,
  type Dirent
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Lista read-only usada pelo composer de menções. O contrato entrega apenas
 * caminhos relativos ao worktree; o caminho absoluto nunca cruza o IPC.
 */
export interface GuiWorkspaceFilesResult {
  ok: boolean
  files?: string[]
  truncated?: boolean
  cached?: boolean
  error?: string
}

export interface GuiWorkspaceFileScanOptions {
  maxFiles?: number
  maxDepth?: number
  maxEntries?: number
  excludedDirectories?: ReadonlySet<string>
  excludedFiles?: ReadonlySet<string>
}

export const GUI_WORKSPACE_FILE_MAX_FILES = 20_000
export const GUI_WORKSPACE_FILE_MAX_DEPTH = 32
export const GUI_WORKSPACE_FILE_MAX_ENTRIES = 100_000
export const GUI_WORKSPACE_CACHE_CAP = 64

/** Dependências e runtime interno não ajudam a completar uma menção. */
export const GUI_WORKSPACE_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.agents',
  '.cache',
  '.claude',
  '.codex',
  '.git',
  '.next',
  '.synkora',
  '.tmp',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'target',
  'vendor'
])

/** Segredos comuns não entram no índice de sugestões do composer. */
export const GUI_WORKSPACE_EXCLUDED_FILES: ReadonlySet<string> = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test'
])

interface CachedWorkspaceFiles {
  files: string[]
  truncated: boolean
}

interface ScanFrame {
  absolute: string
  depth: number
}

function normalizedName(name: string): string {
  return name.toLocaleLowerCase('en-US')
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value as number)))
}

function canonicalWorkspace(cwd: string): string | undefined {
  if (typeof cwd !== 'string' || !cwd.trim()) return undefined
  try {
    const canonical = realpathSync(resolve(cwd))
    return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical
  } catch {
    return undefined
  }
}

function relativeFilePath(root: string, absolute: string): string | undefined {
  const value = relative(root, absolute).replace(/\\/gu, '/')
  if (!value || value === '.' || value.startsWith('../') || value.includes('/../')) return undefined
  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) return undefined
  return value
}

function isExcludedFile(name: string, excludedFiles: ReadonlySet<string>): boolean {
  const normalized = normalizedName(name)
  if (excludedFiles.has(normalized)) return true
  if (normalized.startsWith('.env.')) return true
  // Private key material is not useful as a completion and should not be
  // advertised by a UI list, even when it has a non-standard basename.
  return /\.(?:key|pem|p12|pfx)$/iu.test(name)
}

function readEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Varre uma árvore sem seguir links/junctions. A função não lê conteúdos e
 * pode ser exercitada isoladamente nos testes de limites e traversal.
 */
export function scanGuiWorkspaceFiles(
  cwd: string,
  options: GuiWorkspaceFileScanOptions = {}
): { files: string[]; truncated: boolean } {
  const root = canonicalWorkspace(cwd)
  if (!root) return { files: [], truncated: false }

  const maxFiles = boundedOption(options.maxFiles, GUI_WORKSPACE_FILE_MAX_FILES, 1, GUI_WORKSPACE_FILE_MAX_FILES)
  const maxDepth = boundedOption(options.maxDepth, GUI_WORKSPACE_FILE_MAX_DEPTH, 0, GUI_WORKSPACE_FILE_MAX_DEPTH)
  const maxEntries = boundedOption(
    options.maxEntries,
    GUI_WORKSPACE_FILE_MAX_ENTRIES,
    1,
    GUI_WORKSPACE_FILE_MAX_ENTRIES
  )
  const excludedDirectories = new Set(
    [...(options.excludedDirectories ?? GUI_WORKSPACE_EXCLUDED_DIRECTORIES)].map(normalizedName)
  )
  const excludedFiles = new Set(
    [...(options.excludedFiles ?? GUI_WORKSPACE_EXCLUDED_FILES)].map(normalizedName)
  )

  const files: string[] = []
  const stack: ScanFrame[] = [{ absolute: root, depth: 0 }]
  let entriesSeen = 0
  let truncated = false

  while (stack.length > 0) {
    const frame = stack.pop() as ScanFrame
    const entries = readEntries(frame.absolute)
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > maxEntries) {
        truncated = true
        break
      }

      const name = entry.name
      if (!name || name === '.' || name === '..') continue
      const fullPath = join(frame.absolute, name)

      // readdir's Dirent reports normal directories as directories and links
      // as symbolic links on supported platforms. The lstat fallback keeps a
      // junction from becoming a traversal edge when the Dirent is ambiguous.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (frame.depth >= maxDepth || excludedDirectories.has(normalizedName(name))) continue
        try {
          if (lstatSync(fullPath).isSymbolicLink()) continue
        } catch {
          continue
        }
        stack.push({ absolute: fullPath, depth: frame.depth + 1 })
        continue
      }
      if (!entry.isFile() || isExcludedFile(name, excludedFiles)) continue

      const path = relativeFilePath(root, fullPath)
      if (!path) continue
      files.push(path)
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }

  files.sort((a, b) => a.localeCompare(b, 'en-US'))
  return { files, truncated }
}

/**
 * Cache de processo por worktree. O renderer pode pedir a lista em cada
 * mudança de pane sem provocar uma nova varredura; `invalidate` fica separado
 * para um futuro evento explícito de mudança de árvore.
 */
export class GuiWorkspaceFileIndex {
  private readonly cache = new Map<string, CachedWorkspaceFiles>()

  list(cwd: string): GuiWorkspaceFilesResult {
    const key = canonicalWorkspace(cwd)
    if (!key) return { ok: false, error: 'worktree indisponível' }

    const cached = this.cache.get(key)
    if (cached) {
      return {
        ok: true,
        files: [...cached.files],
        truncated: cached.truncated,
        cached: true
      }
    }

    const scanned = scanGuiWorkspaceFiles(key)
    const entry: CachedWorkspaceFiles = {
      files: [...scanned.files],
      truncated: scanned.truncated
    }
    this.cache.set(key, entry)
    while (this.cache.size > GUI_WORKSPACE_CACHE_CAP) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest !== 'string') break
      this.cache.delete(oldest)
    }
    return {
      ok: true,
      files: [...entry.files],
      truncated: entry.truncated,
      cached: false
    }
  }

  invalidate(cwd: string): void {
    const key = canonicalWorkspace(cwd)
    if (key) this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

/**
 * Leitura segura de arquivos para a superfície Arquivos.
 *
 * Este módulo é deliberadamente independente de Electron/IPC para que a
 * contenção física e os limites possam ser testados com uma raiz sintética e
 * reutilizados por futuras superfícies de leitura. Ele não expõe caminhos
 * absolutos, não escreve no disco e nunca segue links simbólicos/junctions.
 */
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Dirent,
  type Stats
} from 'fs'
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32
} from 'path'

export const FILE_TREE_MAX_ENTRIES = 2_000
export const FILE_TREE_MAX_DEPTH = 24
export const FILE_TREE_MAX_PATH_LENGTH = 2_048
export const FILE_PREVIEW_MAX_BYTES = 1 * 1024 * 1024
export const FILE_PREVIEW_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const FILE_PREVIEW_PROBE_BYTES = 8 * 1024

export type FilePreviewKind =
  | 'markdown'
  | 'code'
  | 'text'
  | 'image'
  | 'binary'
  | 'large'
  | 'blocked'

/** Identificador lógico de uma raiz; nunca contém caminho do sistema. */
export type FileTreeRoot =
  | { kind: 'project' }
  | { kind: 'mission'; missionId: string }

export interface FileTreeEntry {
  /** Caminho relativo à raiz autorizada, sempre com `/`. */
  path: string
  name: string
  kind: 'file' | 'directory'
  depth: number
  size?: number
  mtime?: number
  /** Uma dica de apresentação; a decisão final ocorre na leitura. */
  previewKind?: FilePreviewKind
}

export interface FileTreeResult {
  entries: FileTreeEntry[]
  truncated: boolean
  /** Entradas ignoradas por serem links ou ilegíveis. */
  skipped: number
  error?: string
}

export interface FilePreviewBase {
  path: string
  name: string
  size: number
  mtime: number
}

type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type FilePreviewResult =
  | (FilePreviewBase & { ok: true; kind: 'markdown' | 'code' | 'text'; content: string })
  | (FilePreviewBase & {
      ok: true
      kind: 'image'
      image: { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; base64: string }
    })
  | (FilePreviewBase & {
      ok: true
      kind: 'binary' | 'large' | 'blocked'
      message: string
    })
  | { ok: false; error: string; path?: string }

interface PreparedRoot {
  realPath: string
}

interface ResolvedFile extends PreparedRoot {
  absolutePath: string
  relativePath: string
  stats: Stats
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkdn'])
const CODE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.json',
  '.jsonc',
  '.mjs',
  '.php',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.xml'
])
const TEXT_EXTENSIONS = new Set([
  '.cfg',
  '.conf',
  '.csv',
  '.env.example',
  '.gitignore',
  '.ini',
  '.log',
  '.properties',
  '.text',
  '.txt',
  '.yml',
  '.yaml'
])
const IMAGE_EXTENSIONS = new Map<string, ImageMime>([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp']
])
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.bin',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.eot',
  '.exe',
  '.gz',
  '.ico',
  '.iso',
  '.jar',
  '.mov',
  '.mp3',
  '.mp4',
  '.o',
  '.obj',
  '.pdf',
  '.ppt',
  '.pptx',
  '.so',
  '.tar',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip'
])
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])
const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  'id_rsa',
  'id_ed25519'
])
const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.crt', '.cer'])

function asPath(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > FILE_TREE_MAX_PATH_LENGTH) {
    return null
  }
  if (value.includes('\0')) return null
  return value
}

function isLinkLike(stats: Stats): boolean {
  // `isSymbolicLink` also covers symlink-created junctions on supported
  // Windows Node versions. The reparse probe is an extra guard for junctions
  // whose lstat representation does not report the symbolic-link bit.
  const reparse = (stats as Stats & { isReparsePoint?: () => boolean }).isReparsePoint
  return stats.isSymbolicLink() || (process.platform === 'win32' && Boolean(reparse?.()))
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function normalizedRelativePath(value: string): string | null {
  const raw = asPath(value)
  if (raw == null || isAbsolute(raw) || win32.isAbsolute(raw)) return null
  const slash = raw.replace(/\\/g, '/')
  if (!slash || slash.startsWith('/') || slash.startsWith('//')) return null
  const segments = slash.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function prepareRoot(rootPath: string): PreparedRoot | null {
  const candidate = asPath(rootPath)
  if (candidate == null || (!isAbsolute(candidate) && !win32.isAbsolute(candidate))) {
    // A root is expected to be authoritative and absolute. Resolving a
    // relative value against the main process cwd would create an implicit,
    // renderer-controlled authority boundary.
    return null
  }
  const lexicalPath = resolve(candidate)
  let rootStats: Stats
  let realPath: string
  try {
    rootStats = lstatSync(lexicalPath)
    if (!rootStats.isDirectory() || isLinkLike(rootStats)) return null
    realPath = realpathSync.native(lexicalPath)
  } catch {
    return null
  }
  if (!realPath) return null
  return { realPath }
}

function resolveRelativeFile(root: PreparedRoot, relativePath: string): ResolvedFile | null {
  const normalized = normalizedRelativePath(relativePath)
  if (normalized == null) return null
  const lexicalTarget = join(root.realPath, ...normalized.split('/'))
  if (!isInside(root.realPath, lexicalTarget)) return null

  let stats: Stats | undefined
  try {
    // Check every component before realpath. This rejects links even when an
    // internal link happens to target another location inside the root and
    // avoids silently changing the physical authority boundary between calls.
    let component = root.realPath
    const segments = normalized.split('/')
    for (const [index, segment] of segments.entries()) {
      component = join(component, segment)
      const componentStats = lstatSync(component)
      if (isLinkLike(componentStats)) return null
      if (index < segments.length - 1 && !componentStats.isDirectory()) return null
      if (index === segments.length - 1) stats = componentStats
    }
    if (!stats || isLinkLike(stats) || !stats.isFile()) return null
    const target = realpathSync.native(lexicalTarget)
    if (!isInside(root.realPath, target)) return null
    const physicalStats = lstatSync(target)
    if (isLinkLike(physicalStats) || !physicalStats.isFile()) return null
    return {
      ...root,
      absolutePath: target,
      relativePath: relative(root.realPath, target).replace(/\\/g, '/'),
      stats: physicalStats
    }
  } catch {
    return null
  }
}

function extensionOf(name: string): string {
  return extname(name).toLowerCase()
}

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    SENSITIVE_BASENAMES.has(lower) ||
    SENSITIVE_EXTENSIONS.has(extensionOf(lower)) ||
    lower.endsWith('.env') ||
    lower.startsWith('.env.')
  )
}

function hintedKind(name: string): FilePreviewKind | undefined {
  if (isSensitiveName(name)) return 'blocked'
  const extension = extensionOf(name)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (TEXT_EXTENSIONS.has(extension) || name.toLowerCase() === 'makefile') return 'text'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (BINARY_EXTENSIONS.has(extension)) return 'binary'
  return undefined
}

function imageMimeFromBytes(bytes: Buffer): ImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return null
}

function allowedImageMimeForExtension(name: string, mime: ImageMime): boolean {
  const expected = IMAGE_EXTENSIONS.get(extensionOf(name))
  return expected === mime
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')
  } catch {
    return null
  }
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, FILE_PREVIEW_PROBE_BYTES))
  if (sample.includes(0)) return true
  return decodeUtf8(sample) == null
}

function messageFor(kind: 'binary' | 'large' | 'blocked'): string {
  if (kind === 'large') return `arquivo grande demais para prévia (limite de ${FILE_PREVIEW_MAX_BYTES / 1024 / 1024} MiB)`
  if (kind === 'blocked') return 'arquivo sensível não é exibido na prévia'
  return 'arquivo binário não tem prévia de texto'
}

function baseInfo(file: ResolvedFile): FilePreviewBase {
  return {
    path: file.relativePath,
    name: file.relativePath.split('/').at(-1) ?? file.relativePath,
    size: file.stats.size,
    mtime: file.stats.mtimeMs
  }
}

function nonText(file: ResolvedFile, kind: 'binary' | 'large' | 'blocked'): FilePreviewResult {
  return { ok: true, ...baseInfo(file), kind, message: messageFor(kind) }
}

/** Resolve a validated path against a main-owned root without following links. */
export function resolveReadOnlyFile(rootPath: string, relativePath: string): ResolvedFile | null {
  const root = prepareRoot(rootPath)
  return root ? resolveRelativeFile(root, relativePath) : null
}

/**
 * List files below a main-owned root. The returned entries contain no absolute
 * path and are bounded even when a project has a generated/vendor tree.
 */
export function listReadOnlyFileTree(rootPath: string): FileTreeResult {
  const root = prepareRoot(rootPath)
  if (!root) return { entries: [], truncated: false, skipped: 0, error: 'raiz de arquivos indisponível' }

  const entries: FileTreeEntry[] = []
  let truncated = false
  let skipped = 0

  const walk = (directory: string, relativeBase: string, depth: number): void => {
    if (truncated || depth > FILE_TREE_MAX_DEPTH) {
      truncated = true
      return
    }
    let children: Dirent[]
    try {
      children = readdirSync(directory, { withFileTypes: true })
    } catch {
      skipped++
      return
    }
    children.sort((left, right) => {
      const leftDir = left.isDirectory() ? 0 : 1
      const rightDir = right.isDirectory() ? 0 : 1
      return leftDir - rightDir || left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })
    })

    for (const child of children) {
      if (entries.length >= FILE_TREE_MAX_ENTRIES) {
        truncated = true
        return
      }
      if (child.name === '.' || child.name === '..') {
        skipped++
        continue
      }
      const childRelative = relativeBase ? `${relativeBase}/${child.name}` : child.name
      if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) {
        skipped++
        continue
      }
      const absolute = join(directory, child.name)
      let stats: Stats
      try {
        stats = lstatSync(absolute)
        if (isLinkLike(stats)) {
          skipped++
          continue
        }
      } catch {
        skipped++
        continue
      }

      if (stats.isDirectory()) {
        entries.push({ path: childRelative, name: child.name, kind: 'directory', depth })
        if (depth < FILE_TREE_MAX_DEPTH) walk(absolute, childRelative, depth + 1)
        else truncated = true
        continue
      }
      if (!stats.isFile()) {
        skipped++
        continue
      }
      entries.push({
        path: childRelative,
        name: child.name,
        kind: 'file',
        depth,
        size: stats.size,
        mtime: stats.mtimeMs,
        previewKind: hintedKind(child.name)
      })
    }
  }

  walk(root.realPath, '', 0)
  return { entries, truncated, skipped }
}

/** Read one relative file, returning an honest non-text/large result. */
export function readReadOnlyFilePreview(
  rootPath: string,
  relativePath: string
): FilePreviewResult | null {
  const file = resolveReadOnlyFile(rootPath, relativePath)
  if (!file) return null
  const info = baseInfo(file)
  const hint = hintedKind(file.relativePath)
  if (hint === 'blocked') return nonText(file, 'blocked')
  if (hint === 'large' || file.stats.size > FILE_PREVIEW_MAX_BYTES && hint !== 'image') {
    return nonText(file, 'large')
  }

  if (hint === 'image') {
    if (file.stats.size > FILE_PREVIEW_MAX_IMAGE_BYTES) return nonText(file, 'large')
    try {
      const bytes = readFileSync(file.absolutePath)
      const mime = imageMimeFromBytes(bytes)
      if (!mime || !allowedImageMimeForExtension(file.relativePath, mime)) return nonText(file, 'binary')
      return { ok: true, ...info, kind: 'image', image: { mime, base64: bytes.toString('base64') } }
    } catch {
      return null
    }
  }

  let bytes: Buffer
  try {
    bytes = readFileSync(file.absolutePath)
  } catch {
    return null
  }
  if (bytes.length > FILE_PREVIEW_MAX_BYTES) return nonText(file, 'large')
  if (hint === 'binary' || looksBinary(bytes)) return nonText(file, 'binary')
  const content = decodeUtf8(bytes)
  if (content == null) return nonText(file, 'binary')
  const kind = hint === 'markdown' || hint === 'code' || hint === 'text' ? hint : 'text'
  return { ok: true, ...info, kind, content }
}

// Named aliases keep the small contract discoverable for later read-only
// consumers (P5/P17/P26) without making them depend on an IPC module.
export const listFileTree = listReadOnlyFileTree
export const readFilePreview = readReadOnlyFilePreview

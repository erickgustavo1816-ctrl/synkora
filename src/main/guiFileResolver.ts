import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent
} from 'node:fs'
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path'

/**
 * Resolução de arquivos citados no CHAT GUI.
 *
 * A raiz nunca faz parte da entrada pública: o IPC a obtém do
 * `GuiSessionRegistry.cwdOf`. Este módulo também não importa Electron; assim a
 * política de contenção, ambiguidade e preview pode ser testada sem abrir app,
 * shell ou associação de arquivo do sistema.
 */

export const GUI_FILE_REFERENCE_MAX_CHARS = 2_048
export const GUI_FILE_PREVIEW_TEXT_MAX_BYTES = 512 * 1024
export const GUI_FILE_PREVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const GUI_FILE_SCAN_MAX_ENTRIES = 12_000
export const GUI_FILE_SCAN_MAX_DEPTH = 24
export const GUI_FILE_MAX_CHOICES = 12
export const GUI_FILE_CACHE_TTL_MS = 4_000
export const GUI_FILE_CACHE_MAX_ROOTS = 24

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.pnpm-store',
  '.svn',
  '.yarn',
  'node_modules'
])

/** Formatos cujo clique pode virar execução/instalação/atalho no SO. Eles não
 * entram nem no preview nem no fallback de revelar. Código-fonte continua
 * legível internamente; e desde a rodada 7 o `shell.openPath` do menu "onde
 * abrir" (gui:fileOpenExternal) só recebe caminho que ESTE resolver aprovou —
 * um executável citado no fio morre aqui, nunca vira associação do sistema. */
const EXECUTABLE_FILE_EXTENSIONS = new Set([
  '.appref-ms',
  '.application',
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.exe',
  '.gadget',
  '.hta',
  '.jar',
  '.jse',
  '.lnk',
  '.msi',
  '.msp',
  '.mst',
  '.pif',
  '.ps1',
  '.ps1xml',
  '.ps2',
  '.psc1',
  '.psc2',
  '.reg',
  '.scf',
  '.scr',
  '.sh',
  '.url',
  '.vb',
  '.vbe',
  '.vbs',
  '.ws',
  '.wsc',
  '.wsf',
  '.wsh'
])

const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.astro',
  '.c',
  '.cc',
  '.cjs',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.cts',
  '.d.ts',
  '.diff',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gql',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.lock',
  '.log',
  '.lua',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.php',
  '.prisma',
  '.proto',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sql',
  '.svelte',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsv',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml'
])

const TEXT_PREVIEW_BASENAMES = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  'changelog',
  'dockerfile',
  'gemfile',
  'license',
  'makefile',
  'notice',
  'procfile',
  'rakefile',
  'readme',
  'vagrantfile'
])

/** R26 — o que o CHAT renderiza como markdown. ESPELHO DECLARADO da régua da
 *  aba Arquivos (`filePreview.MARKDOWN_EXTENSIONS`): este módulo é folha (a
 *  suíte roda o .ts cru), então a lista é cópia declarada — e o lacre é o
 *  deepEqual do test:gui-file-open. `.mdx` fica FORA de propósito: a aba
 *  Arquivos também o trata como código, e paridade é o contrato. */
export const GUI_MARKDOWN_PREVIEW_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkdn'])

const IMAGE_PREVIEW_MIME = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp']
])

const SENSITIVE_BASENAMES = new Set([
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
  'service-account.json'
])

const SENSITIVE_EXTENSIONS = new Set(['.key', '.kdbx', '.p12', '.pem', '.pfx'])

export interface GuiFileChoice {
  /** Sempre relativo ao cwd do pane e normalizado com `/`. */
  path: string
  name: string
}

export interface GuiFilePreview {
  path: string
  name: string
  /** `markdown` é texto que o painel do chat renderiza como a aba Arquivos
   *  (R26); a leitura e os tetos são os MESMOS do `text`. */
  kind: 'text' | 'markdown' | 'image'
  /** Texto UTF-8 ou data URL de imagem criada pelo main. */
  content: string
  mimeType?: string
  size: number
  mtime: number
}

export type GuiFileResolveReason =
  | 'ambiguous'
  | 'denied'
  | 'invalid'
  | 'limited'
  | 'not-found'
  | 'unavailable'

export type GuiFileOpenResult =
  | { ok: true; action: 'preview'; preview: GuiFilePreview }
  | { ok: true; action: 'reveal'; message: string }
  | {
      ok: false
      reason: GuiFileResolveReason
      error: string
      choices?: GuiFileChoice[]
      truncated?: boolean
    }

export interface GuiResolvedFile extends GuiFileChoice {
  /** Nunca deve atravessar IPC. */
  absolutePath: string
  /** Raiz física usada para uma última checagem antes de ler/revelar. */
  rootRealPath: string
  rootPath: string
}

export type GuiFileResolveResult =
  | { ok: true; file: GuiResolvedFile }
  | Exclude<GuiFileOpenResult, { ok: true }>

export type GuiPreparedFileOpen =
  | { ok: true; action: 'preview'; preview: GuiFilePreview }
  | { ok: true; action: 'reveal'; absolutePath: string; message: string }
  | Exclude<GuiFileOpenResult, { ok: true }>

export interface GuiFileResolverOptions {
  cacheTtlMs?: number
  maxCacheRoots?: number
  maxChoices?: number
  maxDepth?: number
  maxScanEntries?: number
  now?: () => number
}

interface PreparedRoot {
  path: string
  realPath: string
  key: string
}

interface IndexedRoot {
  files: string[]
  scannedAt: number
  truncated: boolean
}

interface ValidationFailure {
  ok: false
  reason: 'denied' | 'invalid' | 'not-found'
  error: string
}

type ValidationResult = { ok: true; file: GuiResolvedFile } | ValidationFailure
type ResolveFailure = Exclude<GuiFileOpenResult, { ok: true }>

function normalizedKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function relativeForIpc(root: string, target: string): string {
  return relative(root, target).replace(/\\/g, '/')
}

function isSensitiveFile(path: string): boolean {
  const name = basename(path).toLocaleLowerCase('en-US')
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    SENSITIVE_BASENAMES.has(name) ||
    SENSITIVE_EXTENSIONS.has(extname(name))
  )
}

function executableExtension(path: string): boolean {
  return EXECUTABLE_FILE_EXTENSIONS.has(extname(path).toLocaleLowerCase('en-US'))
}

function cleanReference(raw: string): string | null {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > GUI_FILE_REFERENCE_MAX_CHARS ||
    raw.includes('\0') ||
    /[\r\n]/u.test(raw)
  ) return null

  let value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '`' || first === '"' || first === "'") && first === last) {
      value = value.slice(1, -1).trim()
    }
  }
  return value && value.length <= GUI_FILE_REFERENCE_MAX_CHARS ? value : null
}

function hasTraversal(value: string): boolean {
  return value.replace(/\\/g, '/').split('/').some((part) => part === '..')
}

function portableAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value)
}

function prepareRoot(cwd: string): PreparedRoot | ResolveFailure {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 32_768 || cwd.includes('\0')) {
    return { ok: false, reason: 'unavailable', error: 'este pane não tem uma pasta válida' }
  }
  try {
    const path = resolve(cwd)
    const linkStat = lstatSync(path)
    if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) {
      return { ok: false, reason: 'denied', error: 'a pasta do pane não é uma raiz física segura' }
    }
    const realPath = realpathSync.native(path)
    return { path, realPath, key: normalizedKey(realPath) }
  } catch {
    return { ok: false, reason: 'not-found', error: 'a pasta deste pane não está disponível' }
  }
}

/** Confirma contenção léxica e física e recusa QUALQUER link/reparse point no
 * caminho descendente. O arquivo pode sumir entre chamadas; isso vira falha
 * fechada e sem detalhe bruto de filesystem. */
function validateFile(root: PreparedRoot, targetInput: string): ValidationResult {
  try {
    const rootStat = lstatSync(root.path)
    const currentRootReal = realpathSync.native(root.path)
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      normalizedKey(currentRootReal) !== normalizedKey(root.realPath)
    ) {
      return { ok: false, reason: 'denied', error: 'a raiz física do pane mudou' }
    }
  } catch {
    return { ok: false, reason: 'not-found', error: 'a pasta deste pane não está disponível' }
  }

  const target = resolve(targetInput)
  if (!isInside(root.path, target)) {
    return { ok: false, reason: 'denied', error: 'o arquivo fica fora da pasta desta conversa' }
  }

  const rel = relative(root.path, target)
  if (!rel || hasTraversal(rel)) {
    return { ok: false, reason: 'invalid', error: 'o caminho não aponta para um arquivo' }
  }

  let cursor = root.path
  try {
    for (const part of rel.split(sep)) {
      if (!part || part === '.') continue
      cursor = resolve(cursor, part)
      const linkStat = lstatSync(cursor)
      if (linkStat.isSymbolicLink()) {
        return {
          ok: false,
          reason: 'denied',
          error: 'links simbólicos e junctions não podem ser abertos pelo chat'
        }
      }
    }

    const targetStat = statSync(target)
    if (!targetStat.isFile()) {
      return { ok: false, reason: 'not-found', error: 'o caminho não é um arquivo' }
    }
    const targetReal = realpathSync.native(target)
    if (!isInside(root.realPath, targetReal)) {
      return { ok: false, reason: 'denied', error: 'o arquivo físico fica fora desta conversa' }
    }
  } catch {
    return { ok: false, reason: 'not-found', error: 'arquivo não encontrado' }
  }

  if (isSensitiveFile(target)) {
    return {
      ok: false,
      reason: 'denied',
      error: 'este tipo de arquivo pode conter credenciais e não é aberto pelo chat'
    }
  }
  if (executableExtension(target)) {
    return {
      ok: false,
      reason: 'denied',
      error: 'arquivos executáveis ou atalhos não são abertos pelo chat'
    }
  }

  return {
    ok: true,
    file: {
      absolutePath: target,
      path: relativeForIpc(root.path, target),
      name: basename(target),
      rootPath: root.path,
      rootRealPath: root.realPath
    }
  }
}

function referenceForLookup(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+|\/+$/gu, '')
}

function choiceMatchesReference(reference: string, relativePath: string): boolean {
  const query = normalizedKey(referenceForLookup(reference))
  const target = normalizedKey(relativePath)
  if (!query) return false
  if (!query.includes('/')) return normalizedKey(basename(relativePath)) === query
  return target === query || target.endsWith(`/${query}`)
}

function extensionForPreview(path: string): string {
  const lower = basename(path).toLocaleLowerCase('en-US')
  if (lower.endsWith('.d.ts')) return '.d.ts'
  return extname(lower)
}

function finalValidation(file: GuiResolvedFile): ValidationResult {
  const root: PreparedRoot = {
    path: file.rootPath,
    realPath: file.rootRealPath,
    key: normalizedKey(file.rootRealPath)
  }
  return validateFile(root, file.absolutePath)
}

/** Prepara conteúdo INERTE para o renderer. Formato grande/desconhecido cai
 * em `reveal`; execução nunca é uma ação possível desta união. */
export function prepareGuiFileOpen(file: GuiResolvedFile): GuiPreparedFileOpen {
  const validated = finalValidation(file)
  if (!validated.ok) return validated
  const current = validated.file

  let size: number
  let mtime: number
  try {
    const stat = statSync(current.absolutePath)
    size = stat.size
    mtime = stat.mtimeMs
  } catch {
    return { ok: false, reason: 'not-found', error: 'o arquivo não está mais disponível' }
  }

  const extension = extensionForPreview(current.absolutePath)
  const imageMime = IMAGE_PREVIEW_MIME.get(extension)
  if (imageMime) {
    if (size > GUI_FILE_PREVIEW_IMAGE_MAX_BYTES) {
      return {
        ok: true,
        action: 'reveal',
        absolutePath: current.absolutePath,
        message: 'imagem grande demais para o preview; mostrei o arquivo na pasta'
      }
    }
    try {
      const bytes = readFileSync(current.absolutePath)
      return {
        ok: true,
        action: 'preview',
        preview: {
          path: current.path,
          name: current.name,
          kind: 'image',
          content: `data:${imageMime};base64,${bytes.toString('base64')}`,
          mimeType: imageMime,
          size,
          mtime
        }
      }
    } catch {
      return { ok: false, reason: 'not-found', error: 'não consegui ler a imagem agora' }
    }
  }

  const lowerName = current.name.toLocaleLowerCase('en-US')
  // R26 — as variantes de markdown (.markdown/.mdown/.mkdn) entram pela régua
  // própria: só .md morava na lista de texto, e as irmãs caíam no "sem preview".
  const textPreview =
    TEXT_PREVIEW_EXTENSIONS.has(extension) ||
    GUI_MARKDOWN_PREVIEW_EXTENSIONS.has(extension) ||
    TEXT_PREVIEW_BASENAMES.has(lowerName)
  if (!textPreview || size > GUI_FILE_PREVIEW_TEXT_MAX_BYTES) {
    return {
      ok: true,
      action: 'reveal',
      absolutePath: current.absolutePath,
      message: textPreview
        ? 'arquivo grande demais para o preview; mostrei o arquivo na pasta'
        : 'este formato não tem preview seguro; mostrei o arquivo na pasta'
    }
  }

  try {
    const bytes = readFileSync(current.absolutePath)
    if (bytes.includes(0)) {
      return {
        ok: true,
        action: 'reveal',
        absolutePath: current.absolutePath,
        message: 'o arquivo parece binário; mostrei o arquivo na pasta'
      }
    }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return {
      ok: true,
      action: 'preview',
      preview: {
        path: current.path,
        name: current.name,
        kind: GUI_MARKDOWN_PREVIEW_EXTENSIONS.has(extension) ? 'markdown' : 'text',
        content,
        size,
        mtime
      }
    }
  } catch {
    return {
      ok: true,
      action: 'reveal',
      absolutePath: current.absolutePath,
      message: 'o arquivo não é texto UTF-8; mostrei o arquivo na pasta'
    }
  }
}

export class GuiFileResolver {
  private readonly cache = new Map<string, IndexedRoot>()
  private readonly cacheTtlMs: number
  private readonly maxCacheRoots: number
  private readonly maxChoices: number
  private readonly maxDepth: number
  private readonly maxScanEntries: number
  private readonly now: () => number

  constructor(options: GuiFileResolverOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? GUI_FILE_CACHE_TTL_MS
    this.maxCacheRoots = options.maxCacheRoots ?? GUI_FILE_CACHE_MAX_ROOTS
    this.maxChoices = options.maxChoices ?? GUI_FILE_MAX_CHOICES
    this.maxDepth = options.maxDepth ?? GUI_FILE_SCAN_MAX_DEPTH
    this.maxScanEntries = options.maxScanEntries ?? GUI_FILE_SCAN_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  clear(cwd?: string): void {
    if (!cwd) {
      this.cache.clear()
      return
    }
    const root = prepareRoot(cwd)
    if ('key' in root) this.cache.delete(root.key)
  }

  private scan(root: PreparedRoot): IndexedRoot {
    const cached = this.cache.get(root.key)
    const now = this.now()
    if (cached && now - cached.scannedAt <= this.cacheTtlMs) {
      // Map em ordem de uso para a poda LRU simples.
      this.cache.delete(root.key)
      this.cache.set(root.key, cached)
      return cached
    }

    const files: string[] = []
    const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
      { absolutePath: root.path, relativePath: '', depth: 0 }
    ]
    let queueIndex = 0
    let visited = 0
    let truncated = false
    let incomplete = false

    while (queueIndex < queue.length && !truncated) {
      const current = queue[queueIndex]
      queueIndex += 1
      if (!current) break
      let entries: Dirent[]
      try {
        entries = readdirSync(current.absolutePath, { withFileTypes: true })
      } catch {
        incomplete = true
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        visited += 1
        if (visited > this.maxScanEntries) {
          truncated = true
          break
        }
        const absolutePath = resolve(current.absolutePath, entry.name)
        const relativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name

        // Dirent cobre symlink/junction usuais; lstat fecha a lacuna de um
        // reparse point que o provider tenha classificado de forma diferente.
        let linkStat
        try {
          linkStat = lstatSync(absolutePath)
        } catch {
          incomplete = true
          continue
        }
        if (entry.isSymbolicLink() || linkStat.isSymbolicLink()) continue
        if (linkStat.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) continue
          if (current.depth >= this.maxDepth) {
            incomplete = true
            continue
          }
          queue.push({ absolutePath, relativePath, depth: current.depth + 1 })
          continue
        }
        if (linkStat.isFile()) files.push(relativePath.replace(/\\/g, '/'))
      }
    }

    const index = { files, scannedAt: now, truncated: truncated || incomplete }
    this.cache.delete(root.key)
    this.cache.set(root.key, index)
    while (this.cache.size > this.maxCacheRoots) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest !== 'string') break
      this.cache.delete(oldest)
    }
    return index
  }

  resolve(cwd: string, rawReference: string, selectedPath?: string): GuiFileResolveResult {
    const reference = cleanReference(rawReference)
    if (!reference) {
      return { ok: false, reason: 'invalid', error: 'caminho inválido' }
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(reference) && !/^[A-Za-z]:[\\/]/u.test(reference)) {
      return { ok: false, reason: 'denied', error: 'URLs e ações não são caminhos de arquivo' }
    }
    if (hasTraversal(reference)) {
      return { ok: false, reason: 'denied', error: 'caminhos com .. não são aceitos' }
    }
    if (isSensitiveFile(reference)) {
      return {
        ok: false,
        reason: 'denied',
        error: 'este tipo de arquivo pode conter credenciais e não é aberto pelo chat'
      }
    }
    if (executableExtension(reference)) {
      return {
        ok: false,
        reason: 'denied',
        error: 'arquivos executáveis ou atalhos não são abertos pelo chat'
      }
    }

    const rootResult = prepareRoot(cwd)
    if (!('key' in rootResult)) return rootResult
    const root = rootResult

    if (selectedPath !== undefined) {
      const selected = cleanReference(selectedPath)
      if (
        !selected ||
        portableAbsolute(selected) ||
        hasTraversal(selected) ||
        !choiceMatchesReference(reference, selected)
      ) {
        return { ok: false, reason: 'invalid', error: 'a escolha de arquivo não é válida' }
      }
      return validateFile(root, resolve(root.path, selected.replace(/[\\/]/g, sep)))
    }

    if (portableAbsolute(reference)) {
      const absolute = resolve(reference)
      if (!isInside(root.path, absolute)) {
        return { ok: false, reason: 'denied', error: 'o caminho absoluto fica fora desta conversa' }
      }
      return validateFile(root, absolute)
    }

    const lookup = referenceForLookup(reference)
    if (!lookup) return { ok: false, reason: 'invalid', error: 'caminho inválido' }
    const isBareName = !lookup.includes('/')

    // Caminho relativo explícito tem precedência. Nome curto, por outro lado,
    // precisa ser único na árvore inteira — até se houver um homônimo na raiz.
    if (!isBareName) {
      const direct = validateFile(root, resolve(root.path, lookup.replace(/\//g, sep)))
      if (direct.ok || direct.reason === 'denied' || direct.reason === 'invalid') return direct
    }

    const index = this.scan(root)
    const query = normalizedKey(lookup)
    const candidatePaths = index.files.filter((path) => {
      const key = normalizedKey(path)
      return isBareName
        ? normalizedKey(basename(path)) === query
        : key === query || key.endsWith(`/${query}`)
    })

    const valid: GuiResolvedFile[] = []
    let denied: ValidationFailure | undefined
    for (const path of candidatePaths) {
      const checked = validateFile(root, resolve(root.path, path.replace(/\//g, sep)))
      if (checked.ok) valid.push(checked.file)
      else if (checked.reason === 'denied') denied = checked
    }

    if (valid.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        error: 'encontrei mais de um arquivo com esse nome; escolha qual abrir',
        choices: valid.slice(0, this.maxChoices).map(({ path, name }) => ({ path, name })),
        truncated: index.truncated || valid.length > this.maxChoices
      }
    }
    if (index.truncated) {
      return {
        ok: false,
        reason: 'limited',
        error: valid.length === 1
          ? 'a busca atingiu o limite antes de provar que esse nome é único; cite um caminho mais completo'
          : 'a busca atingiu o limite; cite um caminho mais completo',
        truncated: true
      }
    }
    if (valid.length === 1) return { ok: true, file: valid[0] }
    if (denied) return denied
    return { ok: false, reason: 'not-found', error: 'arquivo não encontrado nesta conversa' }
  }
}

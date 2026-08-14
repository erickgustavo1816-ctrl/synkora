import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  watch,
  type Stats
} from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * P28 — observador PASSIVO de evidências locais do navegador.
 *
 * Esta camada deliberadamente não conhece Playwright, CDP ou um navegador.
 * Ela só acompanha duas casas já pertencentes ao cwd canônico do pane e
 * publica o último arquivo de imagem que conseguiu provar no disco.
 */

export const BROWSER_OBSERVER_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const BROWSER_OBSERVER_MAX_ACTIVE_PANES = 12
export const BROWSER_OBSERVER_MAX_WATCHERS_PER_PANE = 4
export const BROWSER_OBSERVER_MAX_ENTRIES_PER_ROOT = 512
export const BROWSER_OBSERVER_DEBOUNCE_MS = 140

export type BrowserObserverStatus = 'stopped' | 'watching'
export type BrowserScreenshotSource = 'playwright' | 'attachments'
export type BrowserScreenshotMime = 'image/png' | 'image/jpeg' | 'image/webp'

export interface BrowserScreenshotMeta {
  /** Token opaco: autoriza somente a fotografia corrente deste pane. */
  id: string
  name: string
  source: BrowserScreenshotSource
  mime: BrowserScreenshotMime
  bytes: number
  /** mtime factual do arquivo; não é apresentado como horário de navegação. */
  modifiedAt: number
  /** Momento em que o watcher local aceitou esta versão. */
  observedAt: number
  width?: number
  height?: number
}

export interface BrowserObserverSnapshot {
  paneId: string
  status: BrowserObserverStatus
  frame?: BrowserScreenshotMeta
  /** Mensagem fechada e sem caminho bruto, apenas para falha do lifecycle. */
  note?: string
}

export type BrowserObserverResult =
  | { ok: true; snapshot: BrowserObserverSnapshot }
  | { ok: false; error: string }

export type BrowserObserverFrameResult =
  | { ok: true; mime: BrowserScreenshotMime; bytes: ArrayBuffer }
  | { ok: false; error: string }

export interface BrowserDirectoryWatcher {
  readonly closed?: boolean
  close(): void
}

export interface BrowserObserverDeps {
  /** Resolve a autoridade no registro VIVO do pane, nunca no renderer. */
  cwdOf(paneId: string): string | undefined
  push(snapshot: BrowserObserverSnapshot): void
  watchDirectory?: (
    directory: string,
    onChange: () => void
  ) => BrowserDirectoryWatcher
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

interface ObservedRoot {
  path: string
  source: BrowserScreenshotSource
}

interface BrowserFrameRecord extends BrowserScreenshotMeta {
  path: string
  root: string
  dev: number
  ino: number
  mtimeMs: number
  fingerprint: string
}

interface BrowserObserverEntry {
  paneId: string
  cwdRoot: string
  status: BrowserObserverStatus
  watchers: Map<string, BrowserDirectoryWatcher>
  timer?: ReturnType<typeof setTimeout>
  frame?: BrowserFrameRecord
  note?: string
}

interface OpenedImage {
  fd: number
  stat: Stats
  physicalPath: string
  mime: BrowserScreenshotMime
  width?: number
  height?: number
}

const SOURCE_ROOTS: ReadonlyArray<{
  segments: readonly string[]
  source: BrowserScreenshotSource
}> = [
  { segments: ['.playwright-mcp'], source: 'playwright' },
  { segments: ['.synkora', 'attachments'], source: 'attachments' }
]

const MIME_BY_EXTENSION: Readonly<Record<string, BrowserScreenshotMime | undefined>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function defaultWatchDirectory(
  directory: string,
  onChange: () => void
): BrowserDirectoryWatcher {
  const watcher = watch(directory, { persistent: false }, onChange)
  let closed = false
  watcher.on('error', () => {
    closed = true
    try {
      watcher.close()
    } catch {
      // já encerrado pelo runtime
    }
    onChange()
  })
  return {
    get closed() {
      return closed
    },
    close() {
      closed = true
      watcher.close()
    }
  }
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  )
}

function physicalCwd(input: string): string | null {
  try {
    const absolute = resolve(input)
    const lexical = lstatSync(absolute)
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) return null
    const physical = realpathSync.native(absolute)
    const current = lstatSync(physical)
    return current.isDirectory() && !current.isSymbolicLink() ? physical : null
  } catch {
    return null
  }
}

/** Resolve um descendente segmento a segmento; link/junction invalida a raiz. */
function safeChildDirectory(root: string, segments: readonly string[]): string | null {
  let current = root
  try {
    for (const segment of segments) {
      const lexical = join(current, segment)
      const info = lstatSync(lexical)
      if (!info.isDirectory() || info.isSymbolicLink()) return null
      const physical = realpathSync.native(lexical)
      if (!isInside(root, physical)) return null
      current = physical
    }
    return current
  } catch {
    return null
  }
}

function observedRoots(cwdRoot: string): ObservedRoot[] {
  const roots: ObservedRoot[] = []
  for (const definition of SOURCE_ROOTS) {
    const path = safeChildDirectory(cwdRoot, definition.segments)
    if (path) roots.push({ path, source: definition.source })
  }
  return roots
}

/**
 * O cwd descobre `.playwright-mcp`; `.synkora` descobre `attachments`; as duas
 * raízes finais descobrem imagens. São no máximo quatro watchers por pane.
 */
function directoriesToWatch(cwdRoot: string): string[] {
  const paths = [cwdRoot]
  const synkora = safeChildDirectory(cwdRoot, ['.synkora'])
  if (synkora) paths.push(synkora)
  for (const root of observedRoots(cwdRoot)) paths.push(root.path)

  const unique = new Map<string, string>()
  for (const path of paths) unique.set(pathKey(path), path)
  return [...unique.values()].slice(0, BROWSER_OBSERVER_MAX_WATCHERS_PER_PANE)
}

function readExactly(fd: number, size: number, position: number): Buffer | null {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = readSync(fd, buffer, offset, size - offset, position + offset)
    if (count === 0) return null
    offset += count
  }
  return buffer
}

function detectImageParts(
  header: Buffer,
  trailer: Buffer,
  size: number
): { mime: BrowserScreenshotMime; width?: number; height?: number } | null {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (
    size >= 45 &&
    header.subarray(0, 8).equals(pngSignature) &&
    header.subarray(12, 16).toString('ascii') === 'IHDR'
  ) {
    if (trailer.length < 12 || trailer.subarray(4, 8).toString('ascii') !== 'IEND') return null
    const width = header.readUInt32BE(16)
    const height = header.readUInt32BE(20)
    if (width === 0 || height === 0 || width > 100_000 || height > 100_000) return null
    return { mime: 'image/png', width, height }
  }

  if (size >= 16 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    if (trailer.at(-2) !== 0xff || trailer.at(-1) !== 0xd9) return null
    return { mime: 'image/jpeg' }
  }

  if (
    size >= 16 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP' &&
    header.readUInt32LE(4) + 8 === size
  ) {
    return { mime: 'image/webp' }
  }

  return null
}

function detectImage(
  fd: number,
  size: number
): { mime: BrowserScreenshotMime; width?: number; height?: number } | null {
  const headerSize = Math.min(32, size)
  const trailerSize = Math.min(12, size)
  const header = headerSize > 0 ? readExactly(fd, headerSize, 0) : null
  const trailer = trailerSize > 0 ? readExactly(fd, trailerSize, size - trailerSize) : null
  return header && trailer ? detectImageParts(header, trailer, size) : null
}

function detectImageBuffer(
  buffer: Buffer
): { mime: BrowserScreenshotMime; width?: number; height?: number } | null {
  return detectImageParts(
    buffer.subarray(0, Math.min(32, buffer.length)),
    buffer.subarray(Math.max(0, buffer.length - 12)),
    buffer.length
  )
}

/**
 * Abre o arquivo depois de três barreiras: entrada lexical não é link, caminho
 * físico segue dentro da raiz allowlisted e a identidade antes/depois do open
 * coincide. A leitura posterior usa o fd já provado, não reabre pelo nome.
 */
function openImage(path: string, allowedRoot: string): OpenedImage | null {
  let fd: number | undefined
  try {
    const before = lstatSync(path)
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size <= 0 ||
      before.size > BROWSER_OBSERVER_MAX_IMAGE_BYTES
    ) {
      return null
    }

    const physicalPath = realpathSync.native(path)
    if (!isInside(allowedRoot, physicalPath)) return null

    fd = openSync(path, constants.O_RDONLY)
    const opened = fstatSync(fd)
    const after = lstatSync(path)
    if (!opened.isFile() || after.isSymbolicLink() || !sameFile(before, opened) || !sameFile(opened, after)) {
      closeSync(fd)
      return null
    }

    const detected = detectImage(fd, opened.size)
    const extensionMime = MIME_BY_EXTENSION[extname(path).toLocaleLowerCase('en-US')]
    if (!detected || detected.mime !== extensionMime) {
      closeSync(fd)
      return null
    }

    return { fd, stat: opened, physicalPath, ...detected }
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // já fechado por uma corrida de filesystem
      }
    }
    return null
  }
}

function frameMeta(frame: BrowserFrameRecord): BrowserScreenshotMeta {
  const { id, name, source, mime, bytes, modifiedAt, observedAt, width, height } = frame
  return {
    id,
    name,
    source,
    mime,
    bytes,
    modifiedAt,
    observedAt,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height })
  }
}

function snapshotOf(entry: BrowserObserverEntry): BrowserObserverSnapshot {
  return {
    paneId: entry.paneId,
    status: entry.status,
    ...(entry.frame ? { frame: frameMeta(entry.frame) } : {}),
    ...(entry.note ? { note: entry.note } : {})
  }
}

function stoppedSnapshot(paneId: string): BrowserObserverSnapshot {
  return { paneId, status: 'stopped' }
}

function paneIdProblem(paneId: unknown): string | null {
  return typeof paneId === 'string' && paneId.length > 0 && paneId.length <= 256
    ? null
    : 'pane sem identificador válido'
}

export class BrowserObserverRegistry {
  private readonly deps: Required<
    Pick<BrowserObserverDeps, 'cwdOf' | 'push'>
  > &
    Required<Omit<BrowserObserverDeps, 'cwdOf' | 'push'>>
  private readonly entries = new Map<string, BrowserObserverEntry>()
  private nextFrameId = 0

  constructor(deps: BrowserObserverDeps) {
    this.deps = {
      cwdOf: deps.cwdOf,
      push: deps.push,
      watchDirectory: deps.watchDirectory ?? defaultWatchDirectory,
      setTimer: deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimer: deps.clearTimer ?? ((timer) => clearTimeout(timer)),
      now: deps.now ?? (() => Date.now())
    }
  }

  state(paneId: unknown): BrowserObserverSnapshot {
    if (paneIdProblem(paneId)) return stoppedSnapshot('')
    const id = paneId as string
    const entry = this.entries.get(id)
    return entry ? snapshotOf(entry) : stoppedSnapshot(id)
  }

  start(paneId: unknown): BrowserObserverResult {
    const problem = paneIdProblem(paneId)
    if (problem) return { ok: false, error: problem }
    const id = paneId as string
    const cwd = this.deps.cwdOf(id)
    if (!cwd) return { ok: false, error: 'este pane não tem sessão aberta' }
    const cwdRoot = physicalCwd(cwd)
    if (!cwdRoot) {
      return { ok: false, error: 'não foi possível observar esta pasta de trabalho' }
    }

    const current = this.entries.get(id)
    if (current?.status === 'watching' && pathKey(current.cwdRoot) === pathKey(cwdRoot)) {
      return { ok: true, snapshot: snapshotOf(current) }
    }

    const active = [...this.entries.values()].filter((entry) => entry.status === 'watching').length
    if ((!current || current.status !== 'watching') && active >= BROWSER_OBSERVER_MAX_ACTIVE_PANES) {
      return { ok: false, error: 'limite de observações simultâneas atingido' }
    }

    if (current && pathKey(current.cwdRoot) !== pathKey(cwdRoot)) this.closePane(id)
    const entry = this.entries.get(id) ?? {
      paneId: id,
      cwdRoot,
      status: 'stopped' as const,
      watchers: new Map<string, BrowserDirectoryWatcher>()
    }
    entry.cwdRoot = cwdRoot
    entry.status = 'watching'
    entry.note = undefined
    this.entries.set(id, entry)

    this.reconcileWatchers(entry)
    if (entry.watchers.size === 0) {
      this.closePane(id)
      return { ok: false, error: 'não foi possível acompanhar esta pasta de trabalho' }
    }
    this.scan(entry, false)
    this.push(entry)
    return { ok: true, snapshot: snapshotOf(entry) }
  }

  stop(paneId: unknown): BrowserObserverResult {
    const problem = paneIdProblem(paneId)
    if (problem) return { ok: false, error: problem }
    const id = paneId as string
    const entry = this.entries.get(id)
    if (!entry) return { ok: true, snapshot: stoppedSnapshot(id) }
    this.clearRuntime(entry)
    entry.status = 'stopped'
    entry.note = undefined
    this.push(entry)
    return { ok: true, snapshot: snapshotOf(entry) }
  }

  frame(paneId: unknown, frameId: unknown): BrowserObserverFrameResult {
    const problem = paneIdProblem(paneId)
    if (problem || typeof frameId !== 'string' || frameId.length === 0 || frameId.length > 128) {
      return { ok: false, error: problem ?? 'imagem sem identificador válido' }
    }
    const entry = this.entries.get(paneId as string)
    const expected = entry?.frame
    if (!entry || !expected || expected.id !== frameId) {
      return { ok: false, error: 'esta imagem não está mais disponível' }
    }

    const opened = openImage(expected.path, expected.root)
    if (!opened) return { ok: false, error: 'esta imagem não está mais disponível' }
    try {
      if (
        opened.physicalPath !== expected.path ||
        opened.stat.dev !== expected.dev ||
        opened.stat.ino !== expected.ino ||
        opened.stat.size !== expected.bytes ||
        opened.stat.mtimeMs !== expected.mtimeMs ||
        opened.mime !== expected.mime
      ) {
        return { ok: false, error: 'a imagem mudou antes de ser carregada' }
      }
      const data = readExactly(opened.fd, expected.bytes, 0)
      const afterRead = fstatSync(opened.fd)
      const current = lstatSync(expected.path)
      const detected = data ? detectImageBuffer(data) : null
      if (
        !data ||
        !sameFile(opened.stat, afterRead) ||
        current.isSymbolicLink() ||
        !sameFile(afterRead, current) ||
        detected?.mime !== expected.mime ||
        detected.width !== expected.width ||
        detected.height !== expected.height
      ) {
        return { ok: false, error: 'a imagem mudou antes de ser carregada' }
      }
      const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      return { ok: true, mime: expected.mime, bytes }
    } catch {
      return { ok: false, error: 'não foi possível carregar esta imagem' }
    } finally {
      try {
        closeSync(opened.fd)
      } catch {
        // o retorno já é fechado e sanitizado
      }
    }
  }

  /** Lifecycle canônico do pane: remove inclusive a referência ao último path. */
  closePane(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    this.clearRuntime(entry)
    this.entries.delete(paneId)
  }

  closeAll(): void {
    for (const paneId of [...this.entries.keys()]) this.closePane(paneId)
  }

  private clearRuntime(entry: BrowserObserverEntry): void {
    if (entry.timer) {
      this.deps.clearTimer(entry.timer)
      entry.timer = undefined
    }
    for (const watcher of entry.watchers.values()) {
      try {
        watcher.close()
      } catch {
        // watcher já encerrado — lifecycle permanece idempotente
      }
    }
    entry.watchers.clear()
  }

  private reconcileWatchers(entry: BrowserObserverEntry): void {
    const wanted = new Map(
      directoriesToWatch(entry.cwdRoot).map((path) => [pathKey(path), path] as const)
    )
    for (const [key, watcher] of entry.watchers) {
      if (wanted.has(key) && !watcher.closed) continue
      try {
        watcher.close()
      } catch {
        // já fechado
      }
      entry.watchers.delete(key)
    }
    for (const [key, path] of wanted) {
      if (entry.watchers.has(key)) continue
      try {
        entry.watchers.set(key, this.deps.watchDirectory(path, () => this.schedule(entry)))
      } catch {
        // Uma raiz final pode nascer/sumir durante o reconcile. O watcher do
        // pai continua responsável pela próxima tentativa.
      }
    }
  }

  private schedule(entry: BrowserObserverEntry): void {
    if (entry.status !== 'watching' || entry.timer) return
    // Não reinicia o relógio a cada rajada: atividade contínua nunca adia a
    // atualização para sempre e custa no máximo uma varredura por janela.
    entry.timer = this.deps.setTimer(() => {
      entry.timer = undefined
      if (entry.status !== 'watching' || this.entries.get(entry.paneId) !== entry) return
      const currentRoot = physicalCwd(entry.cwdRoot)
      if (!currentRoot || pathKey(currentRoot) !== pathKey(entry.cwdRoot)) {
        this.clearRuntime(entry)
        entry.status = 'stopped'
        entry.frame = undefined
        entry.note = 'a pasta de trabalho deixou de estar disponível'
        this.push(entry)
        return
      }
      this.reconcileWatchers(entry)
      this.scan(entry, true)
    }, BROWSER_OBSERVER_DEBOUNCE_MS)
  }

  private scan(entry: BrowserObserverEntry, publish: boolean): void {
    let latest: BrowserFrameRecord | undefined
    for (const root of observedRoots(entry.cwdRoot)) {
      let directory: ReturnType<typeof opendirSync> | undefined
      try {
        directory = opendirSync(root.path)
        for (let count = 0; count < BROWSER_OBSERVER_MAX_ENTRIES_PER_ROOT; count += 1) {
          const item = directory.readSync()
          if (!item) break
          if (!item.isFile() || item.isSymbolicLink()) continue
          const extensionMime = MIME_BY_EXTENSION[extname(item.name).toLocaleLowerCase('en-US')]
          if (!extensionMime) continue
          const candidatePath = join(root.path, item.name)
          const opened = openImage(candidatePath, root.path)
          if (!opened) continue
          try {
            const fingerprint = [
              root.source,
              item.name,
              opened.stat.dev,
              opened.stat.ino,
              opened.stat.size,
              opened.stat.mtimeMs
            ].join(':')
            const candidate: BrowserFrameRecord = {
              id: '',
              name: basename(candidatePath),
              source: root.source,
              mime: opened.mime,
              bytes: opened.stat.size,
              modifiedAt: opened.stat.mtimeMs,
              observedAt: this.deps.now(),
              ...(opened.width === undefined ? {} : { width: opened.width }),
              ...(opened.height === undefined ? {} : { height: opened.height }),
              path: opened.physicalPath,
              root: root.path,
              dev: opened.stat.dev,
              ino: opened.stat.ino,
              mtimeMs: opened.stat.mtimeMs,
              fingerprint
            }
            if (
              !latest ||
              candidate.modifiedAt > latest.modifiedAt ||
              (candidate.modifiedAt === latest.modifiedAt && candidate.name > latest.name)
            ) {
              latest = candidate
            }
          } finally {
            closeSync(opened.fd)
          }
        }
      } catch {
        // Diretório sumiu no meio da leitura; o watcher do pai fará a próxima.
      } finally {
        try {
          directory?.closeSync()
        } catch {
          // já fechado
        }
      }
    }

    const previous = entry.frame
    if (!latest) {
      if (!previous) return
      entry.frame = undefined
      if (publish) this.push(entry)
      return
    }
    if (previous?.fingerprint === latest.fingerprint) return
    latest.id = `frame-${++this.nextFrameId}`
    entry.frame = latest
    if (publish) this.push(entry)
  }

  private push(entry: BrowserObserverEntry): void {
    try {
      this.deps.push(snapshotOf(entry))
    } catch {
      // A view pode estar desmontando; watcher e pane continuam íntegros.
    }
  }
}

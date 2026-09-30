import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isUnversionedProject, unversionedRefusal, type ProjectVersioning } from '../shared/projectVersioning'

/**
 * P26 — contrato do menu da árvore.
 *
 * O renderer nunca escolhe uma raiz física. Ele entrega somente estes ids e o
 * main resolve a pasta registrada do projeto/worktree a cada operação.
 */
export interface FileActionScope {
  projectId: string
  missionId?: string
}

export interface FileActionProjectRecord {
  path: string
  versioning?: ProjectVersioning
}

/**
 * Espelho ESTRUTURAL de `MissionStatus` (src/main/missions.ts), declarado aqui
 * de propósito: este módulo compila ISOLADO na suíte `test:file-actions` e
 * importar de './missions' arrastaria `electron` para dentro do compile.
 */
export type FileActionMissionStatus = 'ativa' | 'integrando' | 'concluida' | 'arquivada'

export interface FileActionMissionRecord {
  projectId: string
  worktree?: string
  /** Só missão VIVA é raiz navegável. Arquivar não apaga o worktree do disco e
   *  a integração limpa o registro — sem o status, a pasta encerrada seguiria
   *  navegável e mutável. */
  status?: FileActionMissionStatus
}

export interface FileActionRootLookup {
  project(id: string): FileActionProjectRecord | undefined
  mission(id: string): FileActionMissionRecord | undefined
}

export type FileTreeEntryKind = 'file' | 'directory' | 'blocked'

export interface FileTreeEntry {
  /** Sempre relativo à raiz resolvida, com `/`; nunca contém caminho físico. */
  path: string
  parentPath: string
  name: string
  kind: FileTreeEntryKind
  depth: number
  size: number
  mtime: number
  /** Links/junctions são visíveis, mas deliberadamente não operáveis. */
  blockedReason?: 'link'
  /** Metadados são navegáveis, mas continuam fora das ações de escrita. */
  readOnly?: true
}

export interface FileTreeSnapshot {
  ok: boolean
  entries: FileTreeEntry[]
  truncated: boolean
  /** Próxima página de filhos da mesma pasta; ausente quando a lista terminou. */
  nextOffset?: number
  error?: string
}

export interface FileActionResult {
  ok: boolean
  /** Caminho relativo resultante; nunca absoluto. */
  path?: string
  previousPath?: string
  cancelled?: boolean
  savedName?: string
  archive?: { files: number; bytes: number }
  error?: string
}

export interface FileArchiveResult {
  files: number
  bytes: number
}

export interface FileActionIo {
  /** Electron `shell.trashItem`; não existe fallback de exclusão permanente. */
  trashItem(absolutePath: string): Promise<void>
  writeClipboard(text: string): void | Promise<void>
  /** Implementado por worker; destinationPath nasce no main, nunca no renderer. */
  archiveDirectory(
    sourceDirectory: string,
    destinationPath: string
  ): Promise<FileArchiveResult>
}

export const FILE_TREE_PAGE_SIZE = 500

/** Metadados de controle aparecem na árvore, mas não são mutáveis por ela. */
const PROTECTED_METADATA_NAMES = new Set([
  '.git',
  '.synkora',
  '.hg',
  '.svn',
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '$recycle.bin',
  'system volume information'
])

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const WINDOWS_ILLEGAL_NAME = /[<>:"|?*\u0000-\u001f]/u
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u

export type FileActionErrorCode =
  | 'invalid-scope'
  | 'mission-closed'
  | 'mission-no-workspace'
  | 'invalid-path'
  | 'protected-path'
  | 'missing'
  | 'wrong-kind'
  | 'link'
  | 'outside-root'
  | 'exists'
  | 'root'
  | 'race'
  | 'trash-unavailable'
  | 'archive-failed'
  | 'operation-failed'

const PUBLIC_ERROR: Readonly<Record<FileActionErrorCode, string>> = {
  'invalid-scope': 'Projeto ou missão inválidos.',
  'mission-closed':
    'Esta missão foi encerrada — a pasta dela não abre mais aqui. '
    + 'Reative a missão para voltar a navegar.',
  'mission-no-workspace':
    'Esta missão não tem pasta própria. Escolha “raiz do projeto” na origem.',
  'invalid-path': 'O caminho informado é inválido.',
  'protected-path': 'Esta área contém metadados internos e não pode ser alterada.',
  missing: 'O item não existe mais. Recarregue a árvore.',
  'wrong-kind': 'O item não tem o tipo esperado para esta ação.',
  link: 'Links simbólicos e junctions não podem ser usados nesta ação.',
  'outside-root': 'A ação foi recusada porque sairia da pasta de trabalho.',
  exists: 'Já existe um item com esse nome. Nada foi sobrescrito.',
  root: 'A raiz da pasta de trabalho não pode ser alterada.',
  race: 'A pasta mudou durante a ação. Nada mais foi feito; recarregue a árvore.',
  'trash-unavailable': 'Não foi possível mover para a Lixeira. Nada foi excluído.',
  'archive-failed': 'Não foi possível criar o ZIP com segurança.',
  'operation-failed': 'Não foi possível concluir esta ação agora.'
}

export class FileActionError extends Error {
  readonly code: FileActionErrorCode

  constructor(code: FileActionErrorCode, message = PUBLIC_ERROR[code]) {
    super(message)
    this.name = 'FileActionError'
    this.code = code
  }
}

export function publicFileActionError(error: unknown): string {
  return error instanceof FileActionError
    ? error.message
    : PUBLIC_ERROR['operation-failed']
}

export function isProtectedMetadataName(name: string): boolean {
  return PROTECTED_METADATA_NAMES.has(name.toLocaleLowerCase('en-US'))
}

function assertScopeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new FileActionError('invalid-scope')
  }
}

/** Resolve por identidade de domínio. Caminho físico vindo do renderer não
 * participa deste contrato. Escopo de missão exige espaço de trabalho VIVO e
 * PRÓPRIO — o worktree registrado de uma missão 'ativa'. Missão encerrada
 * (arquivada/concluída/integrando) e missão sem worktree (planejamento) não
 * têm raiz aqui: a raiz do projeto se pede pelo escopo de projeto, nunca por
 * herança silenciosa que rotularia a pasta do projeto de "worktree da missão". */
export function resolveFileActionRoot(
  scope: FileActionScope,
  lookup: FileActionRootLookup
): string {
  if (!scope || typeof scope !== 'object') throw new FileActionError('invalid-scope')
  assertScopeId(scope.projectId)
  const project = lookup.project(scope.projectId)
  if (!project || typeof project.path !== 'string' || !isAbsolute(project.path)) {
    throw new FileActionError('invalid-scope')
  }

  if (scope.missionId === undefined) return project.path
  assertScopeId(scope.missionId)
  const mission = lookup.mission(scope.missionId)
  if (!mission || mission.projectId !== scope.projectId) {
    throw new FileActionError('invalid-scope')
  }
  if (mission.status !== undefined && mission.status !== 'ativa') {
    if (isUnversionedProject(project)) throw new FileActionError('mission-closed', unversionedRefusal('reopen'))
    throw new FileActionError('mission-closed')
  }
  if (isUnversionedProject(project)) {
    if (mission.status !== 'ativa') throw new FileActionError('mission-closed', unversionedRefusal('reopen'))
    return project.path
  }
  const worktree = mission.worktree
  if (worktree === undefined || worktree === '') {
    throw new FileActionError('mission-no-workspace')
  }
  if (typeof worktree !== 'string' || !isAbsolute(worktree)) {
    throw new FileActionError('invalid-scope')
  }
  return worktree
}

interface ParsedRelativePath {
  normalized: string
  segments: string[]
}

function protectedSegments(segments: readonly string[]): boolean {
  return segments.some(isProtectedMetadataName)
}

/**
 * Aceita somente o dialeto relativo emitido pela árvore. Em particular,
 * `C:foo` é drive-relative no Windows (e `path.isAbsolute` não o detecta),
 * então recebe uma cerca explícita junto com UNC, `..` e ADS (`:`).
 */
function parseRelativePath(
  input: unknown,
  options: { allowRoot?: boolean; allowMetadata?: boolean } = {}
): ParsedRelativePath {
  if (typeof input !== 'string' || input.length > 4_096 || input.includes('\0')) {
    throw new FileActionError('invalid-path')
  }
  if (
    /^[A-Za-z]:/u.test(input) ||
    input.startsWith('/') ||
    input.startsWith('\\') ||
    isAbsolute(input)
  ) {
    throw new FileActionError('invalid-path')
  }
  if (input === '') {
    if (options.allowRoot) return { normalized: '', segments: [] }
    throw new FileActionError('root')
  }

  const segments = input.split(/[\\/]/u)
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.length > 255 ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_ILLEGAL_NAME.test(segment) ||
        WINDOWS_DEVICE_NAME.test(segment)
    )
  ) {
    throw new FileActionError('invalid-path')
  }
  if (!options.allowMetadata && protectedSegments(segments)) throw new FileActionError('protected-path')
  return { normalized: segments.join('/'), segments }
}

export function parseFileActionRelativePath(
  input: unknown,
  options: { allowRoot?: boolean } = {}
): ParsedRelativePath {
  return parseRelativePath(input, { allowRoot: options.allowRoot })
}

export function parseFileActionName(input: unknown): string {
  if (typeof input !== 'string' || input !== input.trim()) {
    throw new FileActionError('invalid-path')
  }
  const parsed = parseFileActionRelativePath(input)
  if (parsed.segments.length !== 1) throw new FileActionError('invalid-path')
  return parsed.segments[0]
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isContained(root: string, target: string): boolean {
  const delta = relative(root, target)
  return (
    delta === '' ||
    (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  )
}

interface Identity {
  dev: number | bigint
  ino: number | bigint
}

function identityOf(stats: Awaited<ReturnType<typeof lstat>>): Identity {
  return { dev: stats.dev, ino: stats.ino }
}

function sameIdentity(left: Identity, right: Identity): boolean {
  // Node fornece ino/dev no Windows moderno. Em filesystems que devolvam 0,
  // realpath + nova lstat ainda são a barreira possível sem um openat nativo.
  if ((left.dev === 0 && left.ino === 0) || (right.dev === 0 && right.ino === 0)) {
    return true
  }
  return left.dev === right.dev && left.ino === right.ino
}

interface CanonicalRoot {
  physical: string
}

async function canonicalRoot(rootPath: string): Promise<CanonicalRoot> {
  let declared
  try {
    declared = await lstat(rootPath)
  } catch {
    throw new FileActionError('invalid-scope')
  }
  if (declared.isSymbolicLink()) throw new FileActionError('link')
  if (!declared.isDirectory()) throw new FileActionError('invalid-scope')
  let physical: string
  try {
    physical = await realpath(rootPath)
  } catch {
    throw new FileActionError('invalid-scope')
  }
  const current = await lstat(rootPath).catch(() => undefined)
  if (!current || current.isSymbolicLink()) throw new FileActionError('race')
  if (!sameIdentity(identityOf(declared), identityOf(current))) {
    throw new FileActionError('race')
  }
  return { physical }
}

interface ExistingTarget {
  absolutePath: string
  canonicalPath: string
  stats: Awaited<ReturnType<typeof lstat>>
  identity: Identity
  relativePath: string
}

async function resolveExistingTarget(
  root: CanonicalRoot,
  input: unknown,
  expected?: 'file' | 'directory',
  allowMetadata = false
): Promise<ExistingTarget> {
  const parsed = parseRelativePath(input, { allowMetadata })
  let cursor = root.physical
  let finalStats: Awaited<ReturnType<typeof lstat>> | undefined

  for (let index = 0; index < parsed.segments.length; index += 1) {
    cursor = join(cursor, parsed.segments[index])
    if (!isContained(root.physical, cursor)) throw new FileActionError('outside-root')
    try {
      finalStats = await lstat(cursor)
    } catch (error) {
      if (isMissingError(error)) throw new FileActionError('missing')
      throw new FileActionError('operation-failed')
    }
    if (finalStats.isSymbolicLink()) throw new FileActionError('link')
    if (index < parsed.segments.length - 1 && !finalStats.isDirectory()) {
      throw new FileActionError('missing')
    }
  }

  if (!finalStats) throw new FileActionError('root')
  if (expected === 'file' && !finalStats.isFile()) throw new FileActionError('wrong-kind')
  if (expected === 'directory' && !finalStats.isDirectory()) {
    throw new FileActionError('wrong-kind')
  }

  let canonicalPath: string
  try {
    canonicalPath = await realpath(cursor)
  } catch {
    throw new FileActionError('missing')
  }
  if (!isContained(root.physical, canonicalPath)) throw new FileActionError('outside-root')

  const after = await lstat(cursor).catch(() => undefined)
  if (
    !after ||
    after.isSymbolicLink() ||
    !sameIdentity(identityOf(finalStats), identityOf(after))
  ) {
    throw new FileActionError('race')
  }

  return {
    absolutePath: cursor,
    canonicalPath,
    stats: after,
    identity: identityOf(after),
    relativePath: parsed.normalized
  }
}

async function assertTargetStable(target: ExistingTarget): Promise<void> {
  const current = await lstat(target.absolutePath).catch(() => undefined)
  if (!current || current.isSymbolicLink()) throw new FileActionError('race')
  const currentReal = await realpath(target.absolutePath).catch(() => undefined)
  if (
    !currentReal ||
    currentReal !== target.canonicalPath ||
    !sameIdentity(target.identity, identityOf(current))
  ) {
    throw new FileActionError('race')
  }
}

function assertRegularTreeTarget(target: ExistingTarget): void {
  if (!target.stats.isFile() && !target.stats.isDirectory()) {
    throw new FileActionError('wrong-kind')
  }
}

async function destinationDoesNotExist(destination: string): Promise<void> {
  try {
    await lstat(destination)
    throw new FileActionError('exists')
  } catch (error) {
    if (error instanceof FileActionError) throw error
    if (isMissingError(error)) return
    throw new FileActionError('operation-failed')
  }
}

function parentRelativePath(relativePath: string): string {
  const index = relativePath.lastIndexOf('/')
  return index < 0 ? '' : relativePath.slice(0, index)
}

function scopeKey(scope: FileActionScope): string {
  const project = typeof scope?.projectId === 'string' ? scope.projectId : '?'
  const mission = typeof scope?.missionId === 'string' ? scope.missionId : ''
  return `${project}\0${mission}`
}

/**
 * Serviço serializado por projeto/worktree. A fila remove as corridas entre
 * duas ações do próprio app; lstat/realpath/identidade imediatamente antes da
 * mutação reduz a janela restante contra mudanças externas.
 */
export class FileActionService {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly lookup: FileActionRootLookup,
    private readonly io: FileActionIo
  ) {}

  private serialize<T>(scope: FileActionScope, operation: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope)
    const previous = this.chains.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(key, tail)
    void tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return current
  }

  private async rootFor(scope: FileActionScope): Promise<CanonicalRoot> {
    return canonicalRoot(resolveFileActionRoot(scope, this.lookup))
  }

  /** Lista somente os filhos solicitados. Pastas grandes têm continuação;
   * dependências e metadados não exigem varrer o projeto inteiro no main. */
  async listTree(
    scope: FileActionScope,
    directoryInput: unknown = '',
    offsetInput: unknown = 0
  ): Promise<FileTreeSnapshot> {
    try {
      return await this.serialize(scope, async () => {
        const directoryPath = parseRelativePath(directoryInput, { allowRoot: true, allowMetadata: true })
        if (typeof offsetInput !== 'number' || !Number.isSafeInteger(offsetInput) || offsetInput < 0) {
          throw new FileActionError('invalid-path')
        }
        const root = await this.rootFor(scope)
        const directory = directoryPath.normalized === ''
          ? await this.rootTarget(root)
          : await resolveExistingTarget(root, directoryPath.normalized, 'directory', true)
        await assertTargetStable(directory)
        const children = await readdir(directory.canonicalPath, { withFileTypes: true })
        children.sort((left, right) =>
          Number(right.isDirectory()) - Number(left.isDirectory())
          || left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base', numeric: true })
          || left.name.localeCompare(right.name)
        )
        const page = children.slice(offsetInput, offsetInput + FILE_TREE_PAGE_SIZE)
        const entries: FileTreeEntry[] = []
        for (const child of page) {
          const childRelative = directoryPath.normalized
            ? `${directoryPath.normalized}/${child.name}`
            : child.name
          // Enumeração não concede autoridade: o parser e a validação física
          // continuam valendo, inclusive em metadados e dependências.
          let parsed: ParsedRelativePath
          try {
            parsed = parseRelativePath(childRelative, { allowMetadata: true })
          } catch {
            continue
          }
          const absolutePath = resolve(root.physical, ...parsed.segments)
          if (!isContained(root.physical, absolutePath)) throw new FileActionError('outside-root')
          const stats = await lstat(absolutePath).catch(() => undefined)
          if (!stats) continue
          const common = {
            path: parsed.normalized,
            parentPath: directoryPath.normalized,
            name: child.name,
            depth: parsed.segments.length,
            size: stats.size,
            mtime: stats.mtimeMs,
            ...(protectedSegments(parsed.segments) ? { readOnly: true as const } : {})
          }
          if (stats.isSymbolicLink()) {
            entries.push({ ...common, kind: 'blocked', blockedReason: 'link' })
            continue
          }
          const childPhysical = await realpath(absolutePath).catch(() => undefined)
          const after = await lstat(absolutePath).catch(() => undefined)
          if (
            !childPhysical || !isContained(root.physical, childPhysical) || !after
            || after.isSymbolicLink() || !sameIdentity(identityOf(stats), identityOf(after))
          ) {
            throw new FileActionError('race')
          }
          if (after.isDirectory()) {
            entries.push({ ...common, kind: 'directory' })
          } else if (after.isFile()) {
            entries.push({ ...common, kind: 'file' })
          }
        }
        await assertTargetStable(directory)
        const nextOffset = offsetInput + page.length
        const truncated = nextOffset < children.length
        return { ok: true, entries, truncated, ...(truncated ? { nextOffset } : {}) }
      })
    } catch (error) {
      return { ok: false, entries: [], truncated: false, error: publicFileActionError(error) }
    }
  }

  async createFile(
    scope: FileActionScope,
    parentInput: unknown,
    nameInput: unknown
  ): Promise<FileActionResult> {
    return this.mutate(scope, async (root) => {
      const parentParsed = parseFileActionRelativePath(parentInput, { allowRoot: true })
      const parent = parentParsed.normalized === ''
        ? await this.rootTarget(root)
        : await resolveExistingTarget(root, parentParsed.normalized, 'directory')
      const name = parseFileActionName(nameInput)
      const destination = join(parent.canonicalPath, name)
      if (!isContained(root.physical, destination)) throw new FileActionError('outside-root')
      await destinationDoesNotExist(destination)
      await assertTargetStable(parent)

      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(destination, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
          throw new FileActionError('exists')
        }
        throw new FileActionError('operation-failed')
      } finally {
        await handle?.close().catch(() => undefined)
      }
      await assertTargetStable(parent)
      const createdPath = parentParsed.normalized
        ? `${parentParsed.normalized}/${name}`
        : name
      await resolveExistingTarget(root, createdPath, 'file')
      return { ok: true, path: createdPath }
    })
  }

  async createFolder(
    scope: FileActionScope,
    parentInput: unknown,
    nameInput: unknown
  ): Promise<FileActionResult> {
    return this.mutate(scope, async (root) => {
      const parentParsed = parseFileActionRelativePath(parentInput, { allowRoot: true })
      const parent = parentParsed.normalized === ''
        ? await this.rootTarget(root)
        : await resolveExistingTarget(root, parentParsed.normalized, 'directory')
      const name = parseFileActionName(nameInput)
      const destination = join(parent.canonicalPath, name)
      if (!isContained(root.physical, destination)) throw new FileActionError('outside-root')
      await destinationDoesNotExist(destination)
      await assertTargetStable(parent)
      try {
        await mkdir(destination, { recursive: false, mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
          throw new FileActionError('exists')
        }
        throw new FileActionError('operation-failed')
      }
      await assertTargetStable(parent)
      const createdPath = parentParsed.normalized
        ? `${parentParsed.normalized}/${name}`
        : name
      await resolveExistingTarget(root, createdPath, 'directory')
      return { ok: true, path: createdPath }
    })
  }

  async rename(
    scope: FileActionScope,
    pathInput: unknown,
    nameInput: unknown
  ): Promise<FileActionResult> {
    return this.mutate(scope, async (root) => {
      const source = await resolveExistingTarget(root, pathInput)
      assertRegularTreeTarget(source)
      const name = parseFileActionName(nameInput)
      const parentPath = parentRelativePath(source.relativePath)
      const parent = parentPath === ''
        ? await this.rootTarget(root)
        : await resolveExistingTarget(root, parentPath, 'directory')
      const destination = join(parent.canonicalPath, name)
      const destinationRelative = parentPath ? `${parentPath}/${name}` : name
      if (destinationRelative === source.relativePath) {
        throw new FileActionError('exists')
      }
      if (!isContained(root.physical, destination)) throw new FileActionError('outside-root')
      await destinationDoesNotExist(destination)
      await assertTargetStable(parent)
      await assertTargetStable(source)
      try {
        // Node não oferece RENAME_NOREPLACE portátil. A fila do app + a
        // checagem imediatamente anterior reduzem a janela; no Windows o alvo
        // ainda é revalidado logo depois e toda colisão já existente é recusada.
        await rename(source.absolutePath, destination)
      } catch {
        throw new FileActionError('operation-failed')
      }
      await assertTargetStable(parent)
      await resolveExistingTarget(
        root,
        destinationRelative,
        source.stats.isDirectory() ? 'directory' : source.stats.isFile() ? 'file' : undefined
      )
      return {
        ok: true,
        path: destinationRelative,
        previousPath: source.relativePath
      }
    })
  }

  async moveToTrash(scope: FileActionScope, pathInput: unknown): Promise<FileActionResult> {
    return this.mutate(scope, async (root) => {
      const target = await resolveExistingTarget(root, pathInput)
      assertRegularTreeTarget(target)
      await assertTargetStable(target)
      try {
        await this.io.trashItem(target.absolutePath)
      } catch (error) {
        if (error instanceof FileActionError) throw error
        throw new FileActionError('trash-unavailable')
      }
      return { ok: true, previousPath: target.relativePath }
    })
  }

  async copyPath(scope: FileActionScope, pathInput: unknown): Promise<FileActionResult> {
    return this.mutate(scope, async (root) => {
      const target = await resolveExistingTarget(root, pathInput)
      assertRegularTreeTarget(target)
      await assertTargetStable(target)
      try {
        await this.io.writeClipboard(target.canonicalPath)
      } catch {
        throw new FileActionError('operation-failed')
      }
      return { ok: true, path: target.relativePath }
    })
  }

  async archiveFolder(
    scope: FileActionScope,
    pathInput: unknown,
    destinationPath: string,
    savedName: string
  ): Promise<FileActionResult> {
    return this.mutate(scope, async (root) => {
      if (
        typeof destinationPath !== 'string' ||
        !isAbsolute(destinationPath) ||
        destinationPath.startsWith('\\') ||
        /^[A-Za-z]:[^\\/]/u.test(destinationPath)
      ) {
        throw new FileActionError('invalid-path')
      }
      const target = await resolveExistingTarget(root, pathInput, 'directory')
      await assertTargetStable(target)
      let archive: FileArchiveResult
      try {
        archive = await this.io.archiveDirectory(target.canonicalPath, destinationPath)
      } catch (error) {
        if (error instanceof FileActionError) throw error
        throw new FileActionError('archive-failed')
      }
      return { ok: true, path: target.relativePath, savedName, archive }
    })
  }

  private async rootTarget(root: CanonicalRoot): Promise<ExistingTarget> {
    const stats = await lstat(root.physical).catch(() => undefined)
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new FileActionError('race')
    }
    return {
      absolutePath: root.physical,
      canonicalPath: root.physical,
      stats,
      identity: identityOf(stats),
      relativePath: ''
    }
  }

  private async mutate(
    scope: FileActionScope,
    operation: (root: CanonicalRoot) => Promise<FileActionResult>
  ): Promise<FileActionResult> {
    try {
      return await this.serialize(scope, async () => operation(await this.rootFor(scope)))
    } catch (error) {
      return { ok: false, error: publicFileActionError(error) }
    }
  }
}

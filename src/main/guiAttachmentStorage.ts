/** Escrita física dos anexos do composer.
 *
 * O renderer nunca escolhe este caminho. Mesmo assim, `.synkora` pode já
 * existir como symlink/junction dentro do projeto; por isso cada diretório é
 * validado com lstat + realpath e o arquivo nasce com criação exclusiva.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  GUI_ATTACHMENT_MAX_BYTES,
  GUI_ATTACHMENT_MAX_FILES,
  GUI_ATTACHMENT_MAX_TOTAL_BYTES,
  guiAttachmentMediaType,
  guiAttachmentDescriptorProblem,
  uniqueAttachmentPath,
  type GuiAttachmentDescriptor,
  type GuiResolvedAttachment
} from './guiAttachments'
import type { GuiAttachmentCapabilityStore } from './guiAttachmentCapabilities'

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

export function guiAttachmentPathInside(root: string, target: string): boolean {
  const rel = relative(pathKey(resolve(root)), pathKey(resolve(target)))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function sameGuiAttachmentPath(left: string, right: string): boolean {
  return pathKey(resolve(left)) === pathKey(resolve(right))
}

function physicalDirectory(path: string, allowedRoot: string): string {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('a pasta de anexos não pode ser link simbólico ou junction')
  }
  const physical = realpathSync.native(path)
  if (!guiAttachmentPathInside(allowedRoot, physical)) {
    throw new Error('a pasta de anexos saiu da pasta de trabalho desta conversa')
  }
  return physical
}

function ensurePhysicalChild(parent: string, name: string, allowedRoot: string): string {
  const child = join(parent, name)
  if (!existsSync(child)) {
    try {
      mkdirSync(child)
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'EEXIST') throw error
    }
  }
  return physicalDirectory(child, allowedRoot)
}

/** Prepara `<cwd>/.synkora/attachments` sem seguir links para fora do cwd. */
export function prepareGuiAttachmentDirectory(cwd: string): string {
  const root = realpathSync.native(resolve(cwd))
  if (!statSync(root).isDirectory()) throw new Error('a pasta de trabalho não é um diretório')
  const synkora = ensurePhysicalChild(root, '.synkora', root)
  return ensurePhysicalChild(synkora, 'attachments', root)
}

/** Cria um nome livre atomicamente. O fd é aberto antes de escrever e o alvo
 * físico é conferido enquanto o handle exclusivo ainda está aberto. */
export function writeGuiAttachmentExclusive(
  dir: string,
  rawName: string,
  bytes: Uint8Array
): string {
  const physicalDir = physicalDirectory(dir, dir)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const destination = uniqueAttachmentPath(physicalDir, rawName, existsSync)
    let fd: number | undefined
    try {
      fd = openSync(destination, 'wx')
      const physicalDestination = realpathSync.native(destination)
      if (!guiAttachmentPathInside(physicalDir, physicalDestination)) {
        throw new Error('o destino do anexo saiu da pasta autorizada')
      }
      writeFileSync(fd, bytes)
      return physicalDestination
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'EEXIST') continue
      throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  throw new Error('não consegui reservar um nome único para o anexo')
}

export type GuiAttachmentReferencesResult =
  | {
      ok: true
      /** Forma pública, segura para transcript/renderer. */
      attachments: GuiAttachmentDescriptor[]
      /** Forma privada, usada somente para compor o prompt no main. */
      resolved: GuiResolvedAttachment[]
    }
  | { ok: false; error: string }

export type GuiFolderReferenceResult =
  | { ok: true; path: string; name: string }
  | { ok: false; error: string }

function physicalWorkspaceRoot(cwd: string): string {
  const requestedRoot = resolve(cwd)
  if (lstatSync(requestedRoot).isSymbolicLink()) {
    throw new Error('a pasta de trabalho não pode ser link simbólico ou junction')
  }
  const root = realpathSync.native(requestedRoot)
  if (!statSync(root).isDirectory()) throw new Error('cwd não é diretório')
  return root
}

/** A referência de pasta pode ser aninhada, mas nenhum trecho entre o cwd
 * físico e ela pode redirecionar por symlink/junction. `realpath` sozinho
 * aceitaria um link interno que por acaso ainda aponta para dentro do cwd. */
function pathInsideWorkspaceWithoutLinks(root: string, rawPath: string): boolean {
  const candidate = resolve(rawPath)
  if (!guiAttachmentPathInside(root, candidate)) return false
  const rel = relative(pathKey(resolve(root)), pathKey(candidate))
  if (!rel) return true
  let cursor = root
  for (const part of rel.split(/[\\/]+/u)) {
    if (!part || part === '.') continue
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) return false
  }
  return true
}

/** Pasta é uma REFERÊNCIA: nunca copiamos uma árvore. A pasta selecionada
 * precisa ser real (sem symlink/junction) e continuar dentro do worktree do
 * pane que a enviou. */
export function resolveGuiFolderReference(cwd: string, rawPath: unknown): GuiFolderReferenceResult {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 32_767 || !isAbsolute(rawPath)) {
    return { ok: false, error: 'pasta sem caminho válido' }
  }
  try {
    const root = physicalWorkspaceRoot(cwd)
    const info = lstatSync(rawPath)
    if (info.isSymbolicLink()) {
      return { ok: false, error: 'pasta não pode ser link simbólico ou junction' }
    }
    if (!pathInsideWorkspaceWithoutLinks(root, rawPath)) {
      return { ok: false, error: 'escolha uma pasta real dentro da pasta de trabalho desta conversa' }
    }
    if (!info.isDirectory()) return { ok: false, error: 'o item escolhido não é uma pasta' }
    const physical = realpathSync.native(rawPath)
    if (!guiAttachmentPathInside(root, physical)) {
      return { ok: false, error: 'escolha uma pasta dentro da pasta de trabalho desta conversa' }
    }
    return { ok: true, path: physical, name: basename(physical) || 'pasta' }
  } catch {
    return { ok: false, error: 'a pasta escolhida não está mais disponível' }
  }
}

/**
 * Resolve uma pasta escolhida pelo diálogo nativo do composer.
 *
 * Diferente do seletor de pasta de um universo, este anexo pode apontar para
 * qualquer diretório local que o dono autorizou explicitamente. A escolha
 * chega aqui pelo main (não pelo renderer), e ainda assim é revalidada: a
 * entrada precisa existir, ser diretório físico e não atravessar um link ou
 * junction em nenhum trecho do caminho. Nenhum conteúdo é copiado.
 */
function pathHasNoLinks(rawPath: string): boolean {
  let cursor = resolve(rawPath)
  for (;;) {
    const info = lstatSync(cursor)
    if (info.isSymbolicLink()) return false
    const parent = dirname(cursor)
    if (parent === cursor) return true
    cursor = parent
  }
}

export function resolveGuiExternalFolderReference(rawPath: unknown): GuiFolderReferenceResult {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 32_767 || !isAbsolute(rawPath)) {
    return { ok: false, error: 'pasta sem caminho válido' }
  }
  try {
    const info = lstatSync(rawPath)
    if (info.isSymbolicLink()) {
      return { ok: false, error: 'pasta não pode ser link simbólico ou junction' }
    }
    if (!info.isDirectory()) return { ok: false, error: 'o item escolhido não é uma pasta' }
    if (!pathHasNoLinks(rawPath)) {
      return { ok: false, error: 'pasta não pode atravessar link simbólico ou junction' }
    }
    const physical = realpathSync.native(rawPath)
    const physicalInfo = lstatSync(physical)
    if (physicalInfo.isSymbolicLink() || !physicalInfo.isDirectory()) {
      return { ok: false, error: 'a pasta escolhida não é um diretório físico' }
    }
    return { ok: true, path: physical, name: basename(physical) || 'pasta' }
  } catch {
    return { ok: false, error: 'a pasta escolhida não está mais disponível' }
  }
}

export type GuiDroppedTargetResult =
  | { ok: true; kind: 'folder'; path: string }
  | { ok: true; kind: 'file'; path: string; size: number }
  | { ok: false; error: string }

/**
 * O que o dono SOLTOU no chat (2026-09-04, "não deu para ler Documentos da
 * Luma": pasta arrastada do Explorer chega ao renderer como File sem bytes, e
 * o FileReader morria nela). O caminho nasce no PRELOAD, do File que o SO
 * entregou (webUtils) — nunca de texto do renderer —, e ainda assim passa pela
 * MESMA régua de qualquer alvo físico: link simbólico/junction recusa; pasta
 * vira a referência do diálogo nativo; arquivo volta com o tamanho real para o
 * teto ser cobrado ANTES de ler um byte. Toda recusa nomeia a receita.
 */
export function resolveGuiDroppedTarget(rawPath: unknown): GuiDroppedTargetResult {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 32_767 || !isAbsolute(rawPath)) {
    return { ok: false, error: 'não deu para localizar o item solto — escolha pelo + do composer' }
  }
  let info: Stats
  try {
    info = lstatSync(rawPath)
  } catch {
    return { ok: false, error: 'o item solto não está mais disponível — solte de novo ou use o +' }
  }
  if (info.isSymbolicLink()) {
    return { ok: false, error: 'o item solto é link simbólico ou junction — solte o alvo real' }
  }
  if (info.isDirectory()) {
    const folder = resolveGuiExternalFolderReference(rawPath)
    return folder.ok ? { ok: true, kind: 'folder', path: folder.path } : folder
  }
  if (!info.isFile()) return { ok: false, error: 'o item solto não é arquivo nem pasta' }
  return { ok: true, kind: 'file', path: rawPath, size: info.size }
}

/**
 * Revalida os descritores que voltaram de localStorage/fila antes de entregar
 * uma referência ao CLI. O renderer pode sugerir, mas nunca autorizar um
 * caminho local: arquivos ficam apenas em `.synkora/attachments`; pasta é
 * apenas uma referência real escolhida pelo diálogo nativo e revalidada aqui.
 */
export function validateGuiAttachmentReferences(
  cwd: string,
  paneId: string,
  raw: unknown,
  capabilities: GuiAttachmentCapabilityStore
): GuiAttachmentReferencesResult {
  if (raw === undefined) return { ok: true, attachments: [], resolved: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'anexos em formato inválido' }
  if (raw.length > GUI_ATTACHMENT_MAX_FILES) {
    return { ok: false, error: `envie no máximo ${GUI_ATTACHMENT_MAX_FILES} anexos por vez` }
  }

  let attachmentDir: string | null = null
  let totalBytes = 0
  const ids = new Set<string>()
  const physicalPaths = new Set<string>()
  const attachments: GuiAttachmentDescriptor[] = []
  const resolved: GuiResolvedAttachment[] = []

  for (const value of raw) {
    const formatProblem = guiAttachmentDescriptorProblem(value)
    if (formatProblem) return { ok: false, error: formatProblem }
    const descriptor = value as GuiAttachmentDescriptor
    if (ids.has(descriptor.id)) return { ok: false, error: 'anexos repetidos' }
    ids.add(descriptor.id)
    const authorization = capabilities.resolve(paneId, descriptor)
    if (!authorization) return { ok: false, error: 'anexo sem autorização válida' }

    if (descriptor.kind === 'folder') {
      const folder = resolveGuiExternalFolderReference(authorization.realpath)
      if (!folder.ok) return folder
      if (!sameGuiAttachmentPath(folder.path, authorization.realpath)) {
        return { ok: false, error: 'a pasta autorizada mudou de lugar' }
      }
      if (physicalPaths.has(folder.path)) return { ok: false, error: 'anexos repetidos' }
      physicalPaths.add(folder.path)
      const publicDescriptor = { ...descriptor }
      attachments.push(publicDescriptor)
      resolved.push({ ...publicDescriptor, path: folder.path })
      continue
    }

    try {
      attachmentDir ??= prepareGuiAttachmentDirectory(cwd)
      // A escrita exclusiva cria somente filhos diretos desta pasta. Não aceite
      // um caminho aninhado/restaurado que poderia atravessar um link interno.
      if (!sameGuiAttachmentPath(dirname(resolve(authorization.realpath)), attachmentDir)) {
        return { ok: false, error: 'anexo saiu da pasta autorizada' }
      }
      const info = lstatSync(authorization.realpath)
      if (info.isSymbolicLink()) {
        return { ok: false, error: 'anexo não pode ser link simbólico ou junction' }
      }
      if (!info.isFile()) return { ok: false, error: 'anexo não está mais disponível' }
      const physical = realpathSync.native(authorization.realpath)
      if (
        !guiAttachmentPathInside(attachmentDir, physical) ||
        !sameGuiAttachmentPath(dirname(physical), attachmentDir) ||
        !sameGuiAttachmentPath(physical, authorization.realpath)
      ) {
        return { ok: false, error: 'anexo saiu da pasta autorizada' }
      }
      const size = statSync(physical).size
      if (!Number.isSafeInteger(size) || size < 0 || size > GUI_ATTACHMENT_MAX_BYTES) {
        return { ok: false, error: 'anexo excede o limite de 10 MB' }
      }
      if (size !== authorization.size || size !== descriptor.size) {
        return { ok: false, error: 'o anexo mudou desde que foi autorizado' }
      }
      if (totalBytes + size > GUI_ATTACHMENT_MAX_TOTAL_BYTES) {
        return { ok: false, error: 'anexos ultrapassam o limite de 50 MB por mensagem' }
      }
      const bytes = readFileSync(physical)
      const media = guiAttachmentMediaType(descriptor.name, bytes)
      if (media.kind !== descriptor.kind || media.mime !== descriptor.mime) {
        return { ok: false, error: 'o tipo do anexo mudou desde que foi autorizado' }
      }
      totalBytes += size
      if (physicalPaths.has(physical)) return { ok: false, error: 'anexos repetidos' }
      physicalPaths.add(physical)
      const publicDescriptor = { ...descriptor }
      attachments.push(publicDescriptor)
      resolved.push({ ...publicDescriptor, path: physical, bytes })
    } catch {
      // Jamais reflita erro/raw path do fs de volta para a UI ou a caixa-preta.
      return { ok: false, error: 'anexo não está mais disponível' }
    }
  }
  return { ok: true, attachments, resolved }
}

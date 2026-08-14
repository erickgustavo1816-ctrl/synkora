import AdmZip from 'adm-zip'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parentPort } from 'node:worker_threads'
import {
  isProtectedMetadataName,
  parseFileActionName,
  type FileArchiveResult
} from './fileActions'

export interface FileArchiveCaps {
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
  maxDepth: number
}

export const DEFAULT_FILE_ARCHIVE_CAPS: Readonly<FileArchiveCaps> = {
  maxFiles: 5_000,
  maxBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxDepth: 32
}

export interface FileArchiveWorkerInput {
  sourceDirectory: string
  outputFile: string
  caps?: Partial<FileArchiveCaps>
}

interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
}

function sameIdentity(
  left: FileIdentity,
  right: FileIdentity
): boolean {
  if ((left.dev === 0 && left.ino === 0) || (right.dev === 0 && right.ino === 0)) {
    return true
  }
  return left.dev === right.dev && left.ino === right.ino
}

function contained(root: string, target: string): boolean {
  const delta = relative(root, target)
  return (
    delta === '' ||
    (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  )
}

function archiveFailure(message: string): Error {
  // Mensagens são deliberadamente estáveis e não carregam nomes/caminhos.
  return new Error(message)
}

async function assertNoLinkSegments(root: string, target: string): Promise<void> {
  const delta = relative(root, target)
  if (delta === '') return
  if (delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw archiveFailure('A pasta contém um caminho fora da raiz permitida.')
  }
  let cursor = root
  for (const segment of delta.split(sep)) {
    cursor = join(cursor, segment)
    const stats = await lstat(cursor).catch(() => undefined)
    if (!stats) throw archiveFailure('A pasta mudou durante a criação do ZIP.')
    if (stats.isSymbolicLink()) {
      throw archiveFailure('A pasta contém um link simbólico ou junction.')
    }
  }
}

function mergedCaps(input?: Partial<FileArchiveCaps>): FileArchiveCaps {
  const caps = { ...DEFAULT_FILE_ARCHIVE_CAPS, ...input }
  if (
    !Number.isSafeInteger(caps.maxFiles) || caps.maxFiles < 1 || caps.maxFiles > 20_000 ||
    !Number.isSafeInteger(caps.maxBytes) || caps.maxBytes < 1 || caps.maxBytes > 1024 ** 3 ||
    !Number.isSafeInteger(caps.maxFileBytes) ||
    caps.maxFileBytes < 1 ||
    caps.maxFileBytes > caps.maxBytes ||
    !Number.isSafeInteger(caps.maxDepth) || caps.maxDepth < 1 || caps.maxDepth > 64
  ) {
    throw archiveFailure('Limites inválidos para o ZIP.')
  }
  return caps
}

/**
 * Trabalho pesado do ZIP. Esta função é exportada só para testes focados; em
 * produção ela é chamada exclusivamente pelo entry de worker abaixo.
 */
export async function buildFolderArchive(
  input: FileArchiveWorkerInput
): Promise<FileArchiveResult> {
  if (
    !input ||
    typeof input.sourceDirectory !== 'string' ||
    !isAbsolute(input.sourceDirectory) ||
    typeof input.outputFile !== 'string' ||
    !isAbsolute(input.outputFile)
  ) {
    throw archiveFailure('Origem ou destino inválidos para o ZIP.')
  }
  const caps = mergedCaps(input.caps)
  const sourceBefore = await lstat(input.sourceDirectory).catch(() => undefined)
  if (!sourceBefore || sourceBefore.isSymbolicLink() || !sourceBefore.isDirectory()) {
    throw archiveFailure('A pasta do ZIP não está mais disponível.')
  }
  const sourceRoot = await realpath(input.sourceDirectory).catch(() => undefined)
  if (!sourceRoot) throw archiveFailure('A pasta do ZIP não está mais disponível.')
  const sourceAfter = await lstat(input.sourceDirectory).catch(() => undefined)
  if (
    !sourceAfter ||
    sourceAfter.isSymbolicLink() ||
    !sameIdentity(sourceBefore, sourceAfter)
  ) {
    throw archiveFailure('A pasta mudou durante a criação do ZIP.')
  }

  const zip = new AdmZip()
  const stack: Array<{ absolutePath: string; archivePath: string; depth: number }> = [
    { absolutePath: sourceRoot, archivePath: '', depth: 0 }
  ]
  let files = 0
  let bytes = 0

  while (stack.length > 0) {
    const directory = stack.pop() as (typeof stack)[number]
    if (directory.depth > caps.maxDepth) {
      throw archiveFailure('A pasta é profunda demais para baixar como ZIP.')
    }
    await assertNoLinkSegments(sourceRoot, directory.absolutePath)
    const directoryBefore = await lstat(directory.absolutePath).catch(() => undefined)
    if (!directoryBefore || directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw archiveFailure('A pasta contém um link simbólico ou junction.')
    }
    const directoryReal = await realpath(directory.absolutePath).catch(() => undefined)
    if (!directoryReal || !contained(sourceRoot, directoryReal)) {
      throw archiveFailure('A pasta contém um caminho fora da raiz permitida.')
    }
    const children = await readdir(directory.absolutePath, { withFileTypes: true }).catch(() => {
      throw archiveFailure('Não foi possível ler toda a pasta para criar o ZIP.')
    })
    children.sort((left, right) =>
      left.name.localeCompare(right.name, 'pt-BR', { sensitivity: 'base', numeric: true })
    )

    let addedChild = false
    const directories: Array<(typeof stack)[number]> = []
    for (const child of children) {
      // Metadados de Git/Synkora nunca saem em um pacote baixável.
      if (isProtectedMetadataName(child.name)) continue
      try {
        parseFileActionName(child.name)
      } catch {
        throw archiveFailure('A pasta contém um nome incompatível com um ZIP seguro.')
      }
      const absolutePath = join(directory.absolutePath, child.name)
      const archivePath = directory.archivePath
        ? `${directory.archivePath}/${child.name}`
        : child.name
      const before = await lstat(absolutePath).catch(() => undefined)
      if (!before) throw archiveFailure('A pasta mudou durante a criação do ZIP.')
      if (before.isSymbolicLink()) {
        throw archiveFailure('A pasta contém um link simbólico ou junction.')
      }
      await assertNoLinkSegments(sourceRoot, absolutePath)
      const physical = await realpath(absolutePath).catch(() => undefined)
      if (!physical || !contained(sourceRoot, physical)) {
        throw archiveFailure('A pasta contém um caminho fora da raiz permitida.')
      }

      if (before.isDirectory()) {
        directories.push({
          absolutePath,
          archivePath,
          depth: directory.depth + 1
        })
        addedChild = true
        continue
      }
      if (!before.isFile()) {
        throw archiveFailure('A pasta contém um tipo de arquivo não suportado.')
      }
      if (before.size > caps.maxFileBytes) {
        throw archiveFailure('Um arquivo excede o limite individual do ZIP.')
      }
      if (files + 1 > caps.maxFiles || bytes + before.size > caps.maxBytes) {
        throw archiveFailure('A pasta excede os limites seguros do ZIP.')
      }

      // Abrir antes de ler e comparar a identidade do handle impede que uma
      // troca por symlink entre lstat e open faça o worker consumir o alvo.
      const handle = await open(absolutePath, 'r').catch(() => undefined)
      if (!handle) throw archiveFailure('Não foi possível ler toda a pasta para criar o ZIP.')
      try {
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          !sameIdentity(
            { dev: before.dev, ino: before.ino },
            { dev: opened.dev, ino: opened.ino }
          ) ||
          opened.size !== before.size
        ) {
          throw archiveFailure('A pasta mudou durante a criação do ZIP.')
        }
        const data = await handle.readFile()
        const afterRead = await handle.stat()
        if (
          data.byteLength !== before.size ||
          afterRead.size !== before.size ||
          afterRead.mtimeMs !== before.mtimeMs ||
          !sameIdentity(
            { dev: before.dev, ino: before.ino },
            { dev: afterRead.dev, ino: afterRead.ino }
          )
        ) {
          throw archiveFailure('A pasta mudou durante a criação do ZIP.')
        }
        zip.addFile(archivePath.replace(/\\/gu, '/'), data)
      } finally {
        await handle.close().catch(() => undefined)
      }
      files += 1
      bytes += before.size
      addedChild = true
    }

    if (!addedChild && directory.archivePath) {
      zip.addFile(`${directory.archivePath.replace(/\\/gu, '/')}/`, Buffer.alloc(0))
    }
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      stack.push(directories[index])
    }
    const directoryAfter = await lstat(directory.absolutePath).catch(() => undefined)
    if (
      !directoryAfter ||
      directoryAfter.isSymbolicLink() ||
      !sameIdentity(directoryBefore, directoryAfter)
    ) {
      throw archiveFailure('A pasta mudou durante a criação do ZIP.')
    }
  }

  // outputFile é um arquivo temporário exclusivo escolhido pelo main. A
  // publicação no destino final usa COPYFILE_EXCL fora deste worker.
  zip.writeZip(input.outputFile)
  return { files, bytes }
}

interface WorkerReply {
  ok: boolean
  result?: FileArchiveResult
  error?: string
}

parentPort?.once('message', (input: FileArchiveWorkerInput) => {
  void buildFolderArchive(input)
    .then((result) => {
      parentPort?.postMessage({ ok: true, result } satisfies WorkerReply)
    })
    .catch((error: unknown) => {
      parentPort?.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : 'Não foi possível criar o ZIP.'
      } satisfies WorkerReply)
    })
    .finally(() => parentPort?.close())
})

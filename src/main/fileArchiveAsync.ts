import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type {
  FileArchiveCaps,
  FileArchiveWorkerInput
} from './fileArchiveWorker'
import { FileActionError, type FileArchiveResult } from './fileActions'

const FILE_ARCHIVE_TIMEOUT_MS = 120_000

interface WorkerReply {
  ok: boolean
  result?: FileArchiveResult
  error?: string
}

const SAFE_ARCHIVE_ERROR_PREFIXES = [
  'A pasta ',
  'Não foi possível ',
  'Um arquivo ',
  'Limites ',
  'O worker ',
  'O ZIP ',
  'Origem ou destino '
]

function safeArchiveError(error: unknown): FileActionError {
  const message = error instanceof Error ? error.message : ''
  return new FileActionError(
    'archive-failed',
    SAFE_ARCHIVE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
      ? message
      : 'Não foi possível criar o ZIP com segurança.'
  )
}

/** Executa um ZIP por worker descartável: nenhuma compressão ou leitura de
 * payload grande ocupa o event loop do processo main. Não há fallback sync. */
export function archiveDirectoryOffMain(
  sourceDirectory: string,
  outputFile: string,
  caps?: Partial<FileArchiveCaps>
): Promise<FileArchiveResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(join(__dirname, 'fileArchiveWorker.js'))
    } catch {
      reject(new Error('O worker de ZIP não está disponível.'))
      return
    }

    const finish = (error?: Error, result?: FileArchiveResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      worker.removeAllListeners()
      void worker.terminate()
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('O worker de ZIP não retornou resultado.'))
    }
    const timeout = setTimeout(
      () => finish(new Error('O ZIP excedeu o tempo limite.')),
      FILE_ARCHIVE_TIMEOUT_MS
    )
    timeout.unref()

    worker.once('message', (message: WorkerReply) => {
      if (message?.ok && message.result) finish(undefined, message.result)
      else finish(new Error(message?.error ?? 'Não foi possível criar o ZIP.'))
    })
    worker.once('error', () => finish(new Error('O worker de ZIP falhou.')))
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`O worker de ZIP encerrou antes do resultado (${code}).`))
    })
    const input: FileArchiveWorkerInput = { sourceDirectory, outputFile, caps }
    worker.postMessage(input)
  })
}

/** Publica o resultado somente se o nome escolhido continuar livre. O worker
 * grava num temp privado; COPYFILE_EXCL é a barreira final anti-overwrite. */
export async function archiveDirectoryToNewFileOffMain(
  sourceDirectory: string,
  destinationPath: string
): Promise<FileArchiveResult> {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'synkora-file-zip-'))
  const tempArchive = join(tempDirectory, 'archive.zip')
  try {
    let archive: FileArchiveResult
    try {
      archive = await archiveDirectoryOffMain(sourceDirectory, tempArchive)
    } catch (error) {
      throw safeArchiveError(error)
    }
    try {
      await copyFile(tempArchive, destinationPath, constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
        throw new FileActionError('exists')
      }
      throw new FileActionError('archive-failed')
    }
    return archive
  } finally {
    await unlink(tempArchive).catch(() => undefined)
    await rmdir(tempDirectory).catch(() => undefined)
  }
}

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

type Snapshot =
  | { state: 'missing' | 'unreadable' }
  | { state: 'invalid'; content: Buffer }
  | { state: 'valid'; content: Buffer; value: unknown }

const validators = new Map<string, (value: unknown) => boolean>()
const blockedStores = new Set<string>()

function storeKey(file: string): string {
  const absolute = resolve(file)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function readSnapshot(file: string, validate?: (value: unknown) => boolean): Snapshot {
  let content: Buffer
  try {
    content = readFileSync(file)
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  try {
    const value: unknown = JSON.parse(content.toString('utf8'))
    if (!validate || validate(value)) return { state: 'valid', content, value }
  } catch {}
  return { state: 'invalid', content }
}

function unavailableStore(): Error {
  return Object.assign(new Error(
    'Persistência indisponível: preserve os arquivos e carregue uma cópia válida antes de salvar.'
  ), { code: 'JSON_STORE_UNRECOVERABLE' })
}

function atomicWrite(file: string, content: string | Buffer): void {
  const temporary = `${file}.tmp-${randomUUID()}`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    try {
      unlinkSync(temporary)
    } catch {}
  }
}

function preserveDamage(file: string, snapshot: Snapshot): void {
  if (snapshot.state === 'unreadable') throw unavailableStore()
  if (snapshot.state === 'invalid') atomicWrite(`${file}.corrupt-${randomUUID()}`, snapshot.content)
}

export function persistJsonStore<T>(file: string, value: T): void {
  const key = storeKey(file)
  if (blockedStores.has(key)) throw unavailableStore()
  const backup = `${file}.bak`
  const older = `${backup}.1`
  const validate = validators.get(key)
  const primarySnapshot = readSnapshot(file, validate)
  const backupSnapshot = readSnapshot(backup, validate)
  const olderSnapshot = readSnapshot(older, validate)
  const snapshots = [primarySnapshot, backupSnapshot, olderSnapshot]
  if (snapshots.some(snapshot => snapshot.state !== 'missing') &&
      !snapshots.some(snapshot => snapshot.state === 'valid')) {
    blockedStores.add(key)
    throw unavailableStore()
  }
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) throw new TypeError('Documento de persistência sem valor JSON.')
  const serialized = `${json}\n`
  preserveDamage(file, primarySnapshot)
  if (primarySnapshot.state === 'valid') {
    if (primarySnapshot.content.equals(Buffer.from(serialized))) return
    if (backupSnapshot.state === 'valid' && !backupSnapshot.content.equals(primarySnapshot.content)) {
      preserveDamage(older, olderSnapshot)
      atomicWrite(older, backupSnapshot.content)
    }
    preserveDamage(backup, backupSnapshot)
    if (backupSnapshot.state !== 'valid' || !backupSnapshot.content.equals(primarySnapshot.content)) {
      atomicWrite(backup, primarySnapshot.content)
    }
  }
  // The primary rename commits. Backup rotation may precede a failed commit,
  // but both the committed primary and the previous alternate remain recoverable.
  atomicWrite(file, serialized)
  if (snapshots.every(snapshot => snapshot.state === 'missing')) {
    try {
      atomicWrite(backup, serialized)
    } catch {
      // First-use backup is best effort only after the primary committed.
    }
  }
}

export function loadJsonStore<T>(
  file: string,
  fallback: () => T,
  validate: (value: unknown) => value is T
): T {
  const key = storeKey(file)
  validators.set(key, validate)
  let present = false
  for (const candidate of [file, `${file}.bak`, `${file}.bak.1`]) {
    const snapshot = readSnapshot(candidate, validate)
    present ||= snapshot.state !== 'missing'
    if (snapshot.state === 'valid') {
      blockedStores.delete(key)
      return snapshot.value as T
    }
  }
  if (present) blockedStores.add(key)
  return fallback()
}

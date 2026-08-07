import { createHash, timingSafeEqual } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { inflateRawSync } from 'node:zlib'

export const SKILL_ARCHIVE_INTEGRITY_VERSION = 1 as const
export const SKILL_ARCHIVE_INTEGRITY_FILE = 'integrity.json'
export const SKILL_ARCHIVE_MANIFEST_FILE = 'manifest.json'

// O ZIP e a biblioteca inteira podem ser bem maiores que uma skill isolada,
// mas continuam limitados antes de o adm-zip descompactar qualquer entrada.
// Os limites comportam a curadoria completa e exports legados reais, sem
// permitir que poucos KB comprimidos virem GBs em memória/disco.
export const MAX_SKILL_ARCHIVE_COMPRESSED_BYTES = 256 * 1024 * 1024
export const MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
export const MAX_SKILL_ARCHIVE_ENTRIES = 50_000
export const MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES = 16 * 1024 * 1024
export const MAX_SKILL_ARCHIVE_PACKAGES = 1_000

const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const SHA256_RE = /^[a-f0-9]{64}$/i
const SAFE_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface SkillArchiveEntry {
  path: string
  data: Buffer
}

export interface SkillArchiveDigestEntry {
  path: string
  bytes: number
  sha256: string
}

export interface SkillArchiveMetadataEntry {
  path: string
  isDirectory: boolean
  compressedBytes: number
  uncompressedBytes: number
  compressionMethod: number
  encrypted: boolean
}

export interface SkillArchiveCompressedEntry extends SkillArchiveMetadataEntry {
  crc32: number
  compressedData: Buffer
}

export interface SkillArchiveIntegrity {
  version: typeof SKILL_ARCHIVE_INTEGRITY_VERSION
  algorithm: 'sha256'
  files: SkillArchiveDigestEntry[]
}

export interface SkillArchiveIntegrityResult {
  ok: boolean
  reason?: string
}

export type SkillArchiveDepartment =
  | 'front'
  | 'back'
  | 'qa'
  | 'design'
  | 'research'
  | 'copy'
  | 'cyber'
  | 'data'

export interface ImportedSkillArchiveCustom {
  id: string
  kind: 'skill' | 'agent'
  depts: SkillArchiveDepartment[]
  group: string
  source: { repo: string; path: string; ref?: string }
  summary: string
  hint: string
  requires?: string[]
  defaultFor?: SkillArchiveDepartment[]
  orchestratorDefault?: boolean
  manualOnly?: boolean
}

export interface ImportedSkillArchiveManifest {
  installed: Record<string, { sha: string; installedAt: string }>
  updates: Record<string, string>
  repoHeads?: Record<string, { sha: string; etag?: string }>
  custom?: ImportedSkillArchiveCustom[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalPathKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/**
 * Aceita somente caminhos portáveis que tenham uma interpretação única no
 * Windows. Backslash, ADS (`:`), segmentos relativos e aliases por ponto/espaço
 * final são recusados em vez de serem silenciosamente normalizados.
 */
export function normalizedSkillArchivePath(
  value: string,
  isDirectory = false
): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    Buffer.byteLength(value, 'utf8') > 1_024
  )
    return undefined
  let path = value
  if (isDirectory && path.endsWith('/')) path = path.slice(0, -1)
  if (
    !path ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    /[\0-\x1f\x7f]/.test(path)
  )
    return undefined
  const parts = path.split('/')
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes(':') ||
        Buffer.byteLength(part, 'utf8') > 255 ||
        /[. ]$/.test(part) ||
        WINDOWS_RESERVED_NAME_RE.test(part)
    )
  )
    return undefined
  return path
}

function validArchivePayloadPath(path: string, isDirectory: boolean): boolean {
  if (path === 'lib') return isDirectory
  if (!path.startsWith('lib/')) return false
  const parts = path.split('/')
  if (parts.length < 2 || !SKILL_ID_RE.test(parts[1])) return false
  return isDirectory ? parts.length >= 2 : parts.length >= 3
}

/**
 * Valida apenas o diretório central do ZIP. Nenhuma entrada é descompactada
 * aqui, portanto cabeçalhos gigantes, duplicatas e paths ambíguos são barrados
 * antes de `getData()`.
 */
export function validateSkillArchiveMetadata(
  entries: readonly SkillArchiveMetadataEntry[]
): SkillArchiveIntegrityResult {
  if (entries.length > MAX_SKILL_ARCHIVE_ENTRIES)
    return { ok: false, reason: `arquivo excede o teto de ${MAX_SKILL_ARCHIVE_ENTRIES} entradas` }

  const seen = new Set<string>()
  const normalizedEntries: Array<{ key: string; path: string; isDirectory: boolean }> = []
  let totalBytes = 0
  let manifests = 0
  let integrityFiles = 0
  for (const entry of entries) {
    const path = normalizedSkillArchivePath(entry.path, entry.isDirectory)
    if (!path)
      return { ok: false, reason: `caminho inválido no arquivo: ${entry.path}` }
    const key = canonicalPathKey(path)
    if (seen.has(key))
      return { ok: false, reason: `entrada duplicada ou ambígua no arquivo: ${entry.path}` }
    seen.add(key)
    normalizedEntries.push({ key, path, isDirectory: entry.isDirectory })

    if (
      !Number.isSafeInteger(entry.compressedBytes) ||
      entry.compressedBytes < 0 ||
      !Number.isSafeInteger(entry.uncompressedBytes) ||
      entry.uncompressedBytes < 0
    )
      return { ok: false, reason: `tamanho inválido no arquivo: ${path}` }
    if (entry.encrypted)
      return { ok: false, reason: `entrada criptografada não suportada: ${path}` }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
      return { ok: false, reason: `compressão não suportada em ${path}` }
    if (entry.isDirectory && (entry.compressedBytes !== 0 || entry.uncompressedBytes !== 0))
      return { ok: false, reason: `diretório com conteúdo inválido: ${path}` }

    totalBytes += entry.uncompressedBytes
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES
    )
      return {
        ok: false,
        reason: `arquivo expandido excede o teto de ${MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES / 1024 / 1024}MB`
      }

    if (entry.isDirectory) {
      if (!validArchivePayloadPath(path, true))
        return { ok: false, reason: `diretório inesperado no arquivo: ${path}` }
      continue
    }
    if (path === SKILL_ARCHIVE_MANIFEST_FILE) {
      manifests++
      if (entry.uncompressedBytes > MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES)
        return { ok: false, reason: 'manifest.json excede o teto seguro' }
      continue
    }
    if (path === SKILL_ARCHIVE_INTEGRITY_FILE) {
      integrityFiles++
      if (entry.uncompressedBytes > MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES)
        return { ok: false, reason: 'integrity.json excede o teto seguro' }
      continue
    }
    if (!validArchivePayloadPath(path, false))
      return { ok: false, reason: `entrada inesperada no arquivo: ${path}` }
  }
  if (manifests !== 1)
    return { ok: false, reason: 'o arquivo deve conter exatamente um manifest.json' }
  if (integrityFiles > 1)
    return { ok: false, reason: 'o arquivo contém mais de um integrity.json' }
  const files = new Set(
    normalizedEntries.filter((entry) => !entry.isDirectory).map((entry) => entry.key)
  )
  for (const entry of normalizedEntries) {
    const parts = entry.key.split('/')
    let ancestor = ''
    for (let index = 0; index < parts.length - 1; index++) {
      ancestor = ancestor ? `${ancestor}/${parts[index]}` : parts[index]
      if (files.has(ancestor))
        return {
          ok: false,
          reason: `arquivo e diretório usam o mesmo caminho: ${entry.path}`
        }
    }
  }
  return { ok: true }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Descompacta uma única entrada com teto absoluto de saída, sem confiar no
 * tamanho declarado para dimensionar memória. O CRC do diretório central e o
 * tamanho real precisam concordar antes de o conteúdo ser usado.
 */
export function decompressSkillArchiveEntry(
  entry: SkillArchiveCompressedEntry,
  maxOutputBytes: number
): Buffer {
  const path = normalizedSkillArchivePath(entry.path)
  if (!path || entry.isDirectory) throw new Error(`entrada inválida: ${entry.path}`)
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 0 ||
    !Number.isSafeInteger(entry.compressedBytes) ||
    entry.compressedBytes < 0 ||
    !Number.isSafeInteger(entry.uncompressedBytes) ||
    entry.uncompressedBytes < 0 ||
    entry.uncompressedBytes > maxOutputBytes ||
    entry.compressedData.byteLength !== entry.compressedBytes
  )
    throw new Error(`entrada excede o teto seguro: ${path}`)
  if (entry.encrypted) throw new Error(`entrada criptografada não suportada: ${path}`)

  let data: Buffer
  if (entry.compressionMethod === 0) {
    if (entry.compressedData.byteLength > maxOutputBytes)
      throw new Error(`entrada excede o teto seguro: ${path}`)
    data = Buffer.from(entry.compressedData)
  } else if (entry.compressionMethod === 8) {
    data = inflateRawSync(entry.compressedData, { maxOutputLength: maxOutputBytes })
  } else {
    throw new Error(`compressão não suportada em ${path}`)
  }
  if (data.byteLength !== entry.uncompressedBytes)
    throw new Error(`tamanho descompactado diverge do cabeçalho: ${path}`)
  if (crc32(data) !== (entry.crc32 >>> 0)) throw new Error(`CRC inválido em ${path}`)
  return data
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function comparableHash(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) return undefined
  return Buffer.from(value, 'hex')
}

export function createSkillArchiveDigest(entry: SkillArchiveEntry): SkillArchiveDigestEntry {
  const path = normalizedSkillArchivePath(entry.path)
  if (!path || canonicalPathKey(path) === canonicalPathKey(SKILL_ARCHIVE_INTEGRITY_FILE))
    throw new Error(`entrada inválida no arquivo: ${entry.path}`)
  return { path, bytes: entry.data.byteLength, sha256: digest(entry.data) }
}

function normalizedDigests(
  entries: readonly SkillArchiveDigestEntry[]
): SkillArchiveDigestEntry[] {
  const seen = new Set<string>()
  const files = entries.map((entry) => {
    const path = normalizedSkillArchivePath(entry.path)
    const key = path ? canonicalPathKey(path) : ''
    if (
      !path ||
      key === canonicalPathKey(SKILL_ARCHIVE_INTEGRITY_FILE) ||
      seen.has(key) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !comparableHash(entry.sha256)
    )
      throw new Error(`entrada inválida ou duplicada no arquivo: ${entry.path}`)
    seen.add(key)
    return { path, bytes: entry.bytes, sha256: entry.sha256.toLowerCase() }
  })
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return files
}

export function createSkillArchiveIntegrity(
  entries: readonly SkillArchiveEntry[]
): SkillArchiveIntegrity {
  return {
    version: SKILL_ARCHIVE_INTEGRITY_VERSION,
    algorithm: 'sha256',
    files: normalizedDigests(entries.map(createSkillArchiveDigest))
  }
}

function parseIntegrity(rawIntegrity: Buffer | string): SkillArchiveIntegrity | undefined {
  try {
    const text =
      typeof rawIntegrity === 'string' ? rawIntegrity : SAFE_TEXT_DECODER.decode(rawIntegrity)
    if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES) return undefined
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return undefined
    if (
      parsed.version !== SKILL_ARCHIVE_INTEGRITY_VERSION ||
      parsed.algorithm !== 'sha256' ||
      !Array.isArray(parsed.files) ||
      parsed.files.length > MAX_SKILL_ARCHIVE_ENTRIES
    )
      return undefined
    return parsed as unknown as SkillArchiveIntegrity
  } catch {
    return undefined
  }
}

export function verifySkillArchiveIntegrityDigests(
  entries: readonly SkillArchiveDigestEntry[],
  rawIntegrity: Buffer | string
): SkillArchiveIntegrityResult {
  const declared = parseIntegrity(rawIntegrity)
  if (!declared)
    return { ok: false, reason: 'manifesto de integridade inválido ou não suportado' }

  let actual: SkillArchiveDigestEntry[]
  let expected: SkillArchiveDigestEntry[]
  try {
    actual = normalizedDigests(entries)
    expected = normalizedDigests(declared.files)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'arquivo inválido' }
  }
  if (actual.length !== expected.length)
    return { ok: false, reason: 'quantidade de arquivos difere do manifesto de integridade' }

  const expectedByPath = new Map(expected.map((item) => [item.path, item]))
  for (const item of actual) {
    const declaredItem = expectedByPath.get(item.path)
    if (!declaredItem || declaredItem.bytes !== item.bytes)
      return { ok: false, reason: `tamanho inesperado em ${item.path}` }
    const expectedHash = comparableHash(declaredItem.sha256)!
    const actualHash = comparableHash(item.sha256)!
    if (!timingSafeEqual(expectedHash, actualHash))
      return { ok: false, reason: `conteúdo alterado em ${item.path}` }
  }
  return { ok: true }
}

export function verifySkillArchiveIntegrity(
  entries: readonly SkillArchiveEntry[],
  rawIntegrity: Buffer | string
): SkillArchiveIntegrityResult {
  try {
    return verifySkillArchiveIntegrityDigests(entries.map(createSkillArchiveDigest), rawIntegrity)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'arquivo inválido' }
  }
}

const IMPORT_DEPARTMENTS = new Set<SkillArchiveDepartment>([
  'front',
  'back',
  'qa',
  'design',
  'research',
  'copy',
  'cyber',
  'data'
])

function importedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && text.length <= max && !/[\0-\x1f\x7f]/.test(text) ? text : undefined
}

function importedSha(value: unknown): string | undefined {
  const sha = importedString(value, 64)
  return sha && (/^[a-f0-9]{40,64}$/i.test(sha) || sha === 'bundled' || sha === 'imported')
    ? sha
    : undefined
}

function importedIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 40) return undefined
  const ids = value.filter(
    (item): item is string => typeof item === 'string' && SKILL_ID_RE.test(item)
  )
  return ids.length === value.length && new Set(ids).size === ids.length ? ids : undefined
}

function importedDepartments(
  value: unknown,
  required: boolean
): SkillArchiveDepartment[] | undefined {
  if (value === undefined && !required) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > IMPORT_DEPARTMENTS.size)
    return undefined
  const departments = value.filter(
    (item): item is SkillArchiveDepartment =>
      typeof item === 'string' && IMPORT_DEPARTMENTS.has(item as SkillArchiveDepartment)
  )
  return departments.length === value.length && new Set(departments).size === departments.length
    ? departments
    : undefined
}

function importedSourcePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 1_000 || value.includes('\\')) return undefined
  if (!value) return ''
  if (value.startsWith('/') || /[\0-\x1f\x7f]/.test(value)) return undefined
  const parts = value.split('/')
  return parts.some((part) => !part || part === '.' || part === '..') ? undefined : value
}

function validatedImportedCustom(value: unknown): ImportedSkillArchiveCustom | undefined {
  if (!isRecord(value)) return undefined
  const id = importedString(value.id, 64)
  const depts = importedDepartments(value.depts, true)
  const group = importedString(value.group, 120)
  const summary = importedString(value.summary, 500)
  const hint = importedString(value.hint, 500)
  if (
    !id ||
    !SKILL_ID_RE.test(id) ||
    id.includes('--') ||
    (value.kind !== 'skill' && value.kind !== 'agent') ||
    !depts ||
    !group ||
    !summary ||
    !hint ||
    !isRecord(value.source)
  )
    return undefined
  const repo = importedString(value.source.repo, 200)
  const path = importedSourcePath(value.source.path)
  const ref = value.source.ref === undefined ? undefined : importedString(value.source.ref, 200)
  if (
    !repo ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    path === undefined ||
    (value.source.ref !== undefined && !ref)
  )
    return undefined
  const requires = importedIds(value.requires)
  const defaultFor = importedDepartments(value.defaultFor, false)
  if (
    (value.requires !== undefined && !requires) ||
    (value.defaultFor !== undefined && !defaultFor) ||
    (value.orchestratorDefault !== undefined && typeof value.orchestratorDefault !== 'boolean') ||
    (value.manualOnly !== undefined && typeof value.manualOnly !== 'boolean')
  )
    return undefined
  return {
    id,
    kind: value.kind,
    depts,
    group,
    source: { repo, path, ...(ref ? { ref } : {}) },
    summary,
    hint,
    ...(requires ? { requires } : {}),
    ...(defaultFor ? { defaultFor } : {}),
    ...(typeof value.orchestratorDefault === 'boolean'
      ? { orchestratorDefault: value.orchestratorDefault }
      : {}),
    ...(typeof value.manualOnly === 'boolean' ? { manualOnly: value.manualOnly } : {})
  }
}

/** Valida e sanitiza somente os campos portáveis usados durante o import. */
export function validateImportedSkillArchiveManifest(
  value: unknown
): ImportedSkillArchiveManifest | undefined {
  if (!isRecord(value) || !isRecord(value.installed)) return undefined
  const installedEntries = Object.entries(value.installed)
  if (installedEntries.length === 0 || installedEntries.length > MAX_SKILL_ARCHIVE_PACKAGES)
    return undefined
  const installed: ImportedSkillArchiveManifest['installed'] = {}
  for (const [id, raw] of installedEntries) {
    if (!SKILL_ID_RE.test(id) || !isRecord(raw)) return undefined
    const sha = importedSha(raw.sha)
    const installedAt = importedString(raw.installedAt, 100)
    if (!sha || !installedAt || !Number.isFinite(Date.parse(installedAt))) return undefined
    installed[id] = { sha, installedAt }
  }

  if (value.updates !== undefined) {
    if (!isRecord(value.updates)) return undefined
    const updates = Object.entries(value.updates)
    if (updates.length > MAX_SKILL_ARCHIVE_PACKAGES) return undefined
    for (const [id, sha] of updates) {
      if (!SKILL_ID_RE.test(id) || !importedSha(sha)) return undefined
    }
  }

  let custom: ImportedSkillArchiveCustom[] | undefined
  if (value.custom !== undefined) {
    if (!Array.isArray(value.custom) || value.custom.length > MAX_SKILL_ARCHIVE_PACKAGES)
      return undefined
    custom = []
    const customIds = new Set<string>()
    for (const raw of value.custom) {
      const entry = validatedImportedCustom(raw)
      if (!entry || customIds.has(entry.id)) return undefined
      customIds.add(entry.id)
      custom.push(entry)
    }
  }

  let repoHeads: ImportedSkillArchiveManifest['repoHeads']
  if (value.repoHeads !== undefined) {
    if (!isRecord(value.repoHeads)) return undefined
    const heads = Object.entries(value.repoHeads)
    if (heads.length > MAX_SKILL_ARCHIVE_PACKAGES * 2) return undefined
    repoHeads = {}
    for (const [key, raw] of heads) {
      if (
        !key ||
        key.length > 500 ||
        /[\0-\x1f\x7f]/.test(key) ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor' ||
        !isRecord(raw)
      )
        return undefined
      const sha = importedSha(raw.sha)
      const etag = raw.etag === undefined ? undefined : importedString(raw.etag, 500)
      if (!sha || (raw.etag !== undefined && !etag)) return undefined
      repoHeads[key] = { sha, ...(etag ? { etag } : {}) }
    }
  }

  if (value.lastCheckAt !== undefined) {
    const lastCheckAt = importedString(value.lastCheckAt, 100)
    if (!lastCheckAt || !Number.isFinite(Date.parse(lastCheckAt))) return undefined
  }

  return {
    installed,
    updates: {},
    ...(custom?.length ? { custom } : {}),
    ...(repoHeads && Object.keys(repoHeads).length ? { repoHeads } : {})
  }
}

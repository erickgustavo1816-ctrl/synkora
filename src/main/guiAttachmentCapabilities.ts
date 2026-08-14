/** Autoridade durável dos anexos do chat.
 *
 * O renderer guarda somente uma capacidade aleatória. O caminho físico fica
 * neste documento do main, vinculado ao pane, id e metadados emitidos. Uma
 * entrada inventada no localStorage, mesmo apontando conceitualmente para uma
 * pasta existente, não cria autoridade alguma.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  GUI_ATTACHMENT_CAPABILITY_RE,
  GUI_ATTACHMENT_MAX_BYTES,
  guiAttachmentDescriptorProblem,
  makeGuiAttachmentDescriptor,
  safeAttachmentName,
  type GuiAttachmentDescriptor,
  type GuiAttachmentKind
} from './guiAttachments'
import { loadJsonStore, persistJsonStore } from './jsonStore'

const STORE_VERSION = 1
const MAX_CAPABILITIES = 10_000
const PANE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/u
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,127}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u

export interface GuiAttachmentCapabilityTarget {
  kind: GuiAttachmentKind
  path: string
  size: number | null
  mime: string | null
}

export interface GuiAttachmentCapabilityRecord {
  capability: string
  paneId: string
  attachmentId: string
  realpath: string
  kind: GuiAttachmentKind
  name: string
  size: number | null
  mime: string | null
  createdAt: string
}

interface GuiAttachmentCapabilitiesDoc {
  version: typeof STORE_VERSION
  entries: Record<string, GuiAttachmentCapabilityRecord>
}

function emptyDoc(): GuiAttachmentCapabilitiesDoc {
  return { version: STORE_VERSION, entries: {} }
}

function validRecord(value: unknown, key: string): value is GuiAttachmentCapabilityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<GuiAttachmentCapabilityRecord>
  if (
    record.capability !== key ||
    !GUI_ATTACHMENT_CAPABILITY_RE.test(key) ||
    typeof record.paneId !== 'string' ||
    !PANE_ID_RE.test(record.paneId) ||
    typeof record.attachmentId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(record.attachmentId) ||
    typeof record.realpath !== 'string' ||
    !record.realpath ||
    record.realpath.length > 32_767 ||
    !isAbsolute(record.realpath) ||
    (record.kind !== 'file' && record.kind !== 'image' && record.kind !== 'folder') ||
    typeof record.name !== 'string' ||
    !record.name.trim() ||
    record.name.length > 120 ||
    record.name !== safeAttachmentName(record.name) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return false
  }
  const metadataValid =
    record.kind === 'folder'
      ? record.size === null && record.mime === null
      : typeof record.size === 'number' &&
        Number.isSafeInteger(record.size) &&
        record.size >= 0 &&
        record.size <= GUI_ATTACHMENT_MAX_BYTES &&
        typeof record.mime === 'string' &&
        MIME_RE.test(record.mime)
  if (!metadataValid) return false
  return (
    guiAttachmentDescriptorProblem({
      id: record.attachmentId,
      capability: record.capability,
      kind: record.kind,
      name: record.name,
      size: record.size,
      mime: record.mime
    }) === undefined
  )
}

function isDoc(value: unknown): value is GuiAttachmentCapabilitiesDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const doc = value as Partial<GuiAttachmentCapabilitiesDoc>
  if (
    doc.version !== STORE_VERSION ||
    !doc.entries ||
    typeof doc.entries !== 'object' ||
    Array.isArray(doc.entries)
  ) {
    return false
  }
  const entries = Object.entries(doc.entries)
  return entries.length <= MAX_CAPABILITIES && entries.every(([key, record]) => validRecord(record, key))
}

function sameDescriptor(
  record: GuiAttachmentCapabilityRecord,
  descriptor: GuiAttachmentDescriptor
): boolean {
  return (
    record.capability === descriptor.capability &&
    record.attachmentId === descriptor.id &&
    record.kind === descriptor.kind &&
    record.name === descriptor.name &&
    record.size === descriptor.size &&
    record.mime === descriptor.mime
  )
}

function pruneEntries(
  entries: Record<string, GuiAttachmentCapabilityRecord>,
  protectedCapability: string
): void {
  const overflow = Object.keys(entries).length - MAX_CAPABILITIES
  if (overflow <= 0) return
  const oldest = Object.values(entries)
    .filter((record) => record.capability !== protectedCapability)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(0, overflow)
  for (const record of oldest) delete entries[record.capability]
}

export class GuiAttachmentCapabilityStore {
  private doc: GuiAttachmentCapabilitiesDoc

  constructor(private readonly file?: string) {
    this.doc = file ? loadJsonStore(file, emptyDoc, isDoc) : emptyDoc()
  }

  /** Emite a capacidade somente depois de gravar o vínculo durável. Falha de
   * persistência não entrega ao renderer um descritor que morreria no reload. */
  issue(paneId: string, target: GuiAttachmentCapabilityTarget): GuiAttachmentDescriptor {
    if (!PANE_ID_RE.test(paneId)) throw new Error('pane sem identificador válido')
    const physical = realpathSync.native(resolve(target.path))
    if (!isAbsolute(physical) || physical.length > 32_767) {
      throw new Error('alvo físico inválido')
    }
    if (target.kind === 'folder') {
      if (target.size !== null || target.mime !== null) throw new Error('metadados de pasta inválidos')
    } else if (
      typeof target.size !== 'number' ||
      !Number.isSafeInteger(target.size) ||
      target.size < 0 ||
      target.size > GUI_ATTACHMENT_MAX_BYTES ||
      typeof target.mime !== 'string' ||
      !MIME_RE.test(target.mime)
    ) {
      throw new Error('metadados de arquivo inválidos')
    }

    const attachmentId = `attachment-${randomUUID()}`
    const capability = `gui-cap-v1-${randomBytes(32).toString('base64url')}`
    const descriptor = makeGuiAttachmentDescriptor(
      attachmentId,
      capability,
      target.kind,
      physical,
      target.size,
      target.mime
    )
    if (guiAttachmentDescriptorProblem(descriptor)) {
      throw new Error('metadados públicos do anexo são inválidos')
    }
    const record: GuiAttachmentCapabilityRecord = {
      capability,
      paneId,
      attachmentId,
      realpath: physical,
      kind: descriptor.kind,
      name: descriptor.name,
      size: descriptor.size,
      mime: descriptor.mime,
      createdAt: new Date().toISOString()
    }
    const previous = this.doc
    this.doc = {
      version: STORE_VERSION,
      entries: { ...previous.entries, [capability]: record }
    }
    // Mesmo se o relógio do sistema voltar, a emissão corrente não pode ser a
    // entrada podada: só entregamos uma capacidade que ficou no commit.
    pruneEntries(this.doc.entries, capability)
    try {
      if (this.file) persistJsonStore(this.file, this.doc)
    } catch {
      this.doc = previous
      throw new Error('não foi possível registrar a autorização do anexo')
    }
    return descriptor
  }

  /** A capacidade é válida apenas no pane emissor e com os mesmos metadados.
   * O caminho nunca é aceito ou sugerido pelo renderer. */
  resolve(
    paneId: string,
    descriptor: GuiAttachmentDescriptor
  ): GuiAttachmentCapabilityRecord | undefined {
    if (!PANE_ID_RE.test(paneId) || guiAttachmentDescriptorProblem(descriptor)) return undefined
    const record = this.doc.entries[descriptor.capability]
    if (!record || record.paneId !== paneId || !sameDescriptor(record, descriptor)) return undefined
    return { ...record }
  }
}

import type { GuiAttachmentDescriptor } from '../../preload'

const GUI_COMPOSER_ATTACHMENTS_PREFIX = 'synkora.guiAttachments.'
const GUI_COMPOSER_ATTACHMENTS_VERSION = 1
// Espelhos do contrato do composer: este módulo precisa continuar puro para a
// persistência sobreviver mesmo quando o resto do renderer ainda não montou.
const GUI_COMPOSER_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const GUI_COMPOSER_ATTACHMENT_MAX_FILES = 20
const GUI_COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024

type GuiComposerAttachmentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

interface GuiComposerAttachmentsEnvelope {
  v: typeof GUI_COMPOSER_ATTACHMENTS_VERSION
  attachments: GuiAttachmentDescriptor[]
  updatedAt: number
}

function attachmentKey(paneId: string): string {
  return `${GUI_COMPOSER_ATTACHMENTS_PREFIX}${paneId}`
}

function looksAbsolute(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/u.test(path)
}

/** O main volta a validar existência, containment e links. Aqui só evitamos
 * restaurar lixo do localStorage para a UI/fila. */
export function isGuiComposerAttachment(value: unknown): value is GuiAttachmentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attachment = value as Partial<GuiAttachmentDescriptor>
  if (
    typeof attachment.id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(attachment.id) ||
    (attachment.kind !== 'file' && attachment.kind !== 'image' && attachment.kind !== 'folder') ||
    typeof attachment.name !== 'string' ||
    !attachment.name.trim() ||
    attachment.name.length > 120 ||
    /[\u0000-\u001f\r\n]/u.test(attachment.name) ||
    typeof attachment.path !== 'string' ||
    attachment.path.length > 32_767 ||
    !looksAbsolute(attachment.path)
  )
    return false
  if (attachment.kind === 'folder') return attachment.size === null
  return (
    typeof attachment.size === 'number' &&
    Number.isSafeInteger(attachment.size) &&
    attachment.size >= 0 &&
    attachment.size <= GUI_COMPOSER_ATTACHMENT_MAX_BYTES
  )
}

function parseAttachments(raw: string | null): GuiComposerAttachmentsEnvelope | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const envelope = value as Partial<GuiComposerAttachmentsEnvelope>
    if (
      envelope.v !== GUI_COMPOSER_ATTACHMENTS_VERSION ||
      !Array.isArray(envelope.attachments) ||
      envelope.attachments.length > GUI_COMPOSER_ATTACHMENT_MAX_FILES ||
      !envelope.attachments.every(isGuiComposerAttachment) ||
      typeof envelope.updatedAt !== 'number' ||
      !Number.isFinite(envelope.updatedAt)
    )
      return null
    const ids = new Set<string>()
    const paths = new Set<string>()
    let totalBytes = 0
    for (const attachment of envelope.attachments) {
      if (ids.has(attachment.id) || paths.has(attachment.path)) return null
      ids.add(attachment.id)
      paths.add(attachment.path)
      totalBytes += attachment.size ?? 0
    }
    if (totalBytes > GUI_COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES)
      return null
    return {
      v: GUI_COMPOSER_ATTACHMENTS_VERSION,
      attachments: envelope.attachments.map((attachment) => ({ ...attachment })),
      updatedAt: envelope.updatedAt
    }
  } catch {
    return null
  }
}

export function readGuiComposerAttachments(
  paneId: string,
  storage: GuiComposerAttachmentStorage = localStorage
): GuiAttachmentDescriptor[] {
  try {
    return parseAttachments(storage.getItem(attachmentKey(paneId)))?.attachments ?? []
  } catch {
    return []
  }
}

export function removeGuiComposerAttachments(
  paneId: string,
  storage: GuiComposerAttachmentStorage = localStorage
): void {
  try {
    storage.removeItem(attachmentKey(paneId))
  } catch {
    // localStorage indisponível não pode derrubar o chat.
  }
}

export function writeGuiComposerAttachments(
  paneId: string,
  attachments: readonly GuiAttachmentDescriptor[],
  storage: GuiComposerAttachmentStorage = localStorage,
  now = Date.now()
): boolean {
  const payload = parseAttachments(
    JSON.stringify({
      v: GUI_COMPOSER_ATTACHMENTS_VERSION,
      attachments: [...attachments],
      updatedAt: now
    } satisfies GuiComposerAttachmentsEnvelope)
  )
  if (!payload) return false
  try {
    if (payload.attachments.length === 0) {
      storage.removeItem(attachmentKey(paneId))
      return true
    }
    storage.setItem(attachmentKey(paneId), JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

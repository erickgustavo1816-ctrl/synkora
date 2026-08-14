import type { GuiAttachmentDescriptor } from '../../preload'

const GUI_QUEUE_PREFIX = 'synkora.guiQueue.'
const GUI_QUEUE_VERSION = 1
export const GUI_QUEUE_MAX_CHARS = 1_000_000
export const GUI_QUEUE_CLAIM_LEASE_MS = 60_000
const GUI_QUEUE_ATTACHMENT_MAX_FILES = 20
const GUI_QUEUE_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024

type GuiQueueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface GuiQueuedOptions {
  model: string | null
  effort: string | null
  permissionMode: string
}

export interface GuiQueuedMessage {
  id: string
  text: string
  at: number
  options: GuiQueuedOptions
  attachments: GuiAttachmentDescriptor[]
  /** Falha da ultima tentativa automatica. Enquanto existir, o dispatcher nao
   * tenta de novo sozinho: o dono decide entre repetir, editar ou apagar. */
  deliveryError?: string
  /** A entrega ja foi tomada por um renderer, mas o envelope continua no
   * storage ate o ACK do main. Durante a lease a UI nao permite editar/apagar. */
  deliveryInFlight?: boolean
  deliveryClaimedUntil?: number
}

interface GuiQueueEnvelope extends GuiQueuedMessage {
  v: typeof GUI_QUEUE_VERSION
  claimToken?: string
  claimedAt?: number
}

function queueKey(paneId: string): string {
  return `${GUI_QUEUE_PREFIX}${paneId}`
}

function storageGet(storage: GuiQueueStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(storage: GuiQueueStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function storageRemove(storage: GuiQueueStorage, key: string): boolean {
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

function cleanNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  return value.slice(0, 256)
}

/** O main ainda é autoridade de path/arquivo; isto só impede estado adulterado
 * do localStorage de entrar na fila visível. Mantido local para a fila poder
 * ser lida no boot sem depender do composer já montado. */
function isQueuedAttachment(value: unknown): value is GuiAttachmentDescriptor {
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
    !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/u.test(attachment.path)
  )
    return false
  if (attachment.kind === 'folder') return attachment.size === null
  return (
    typeof attachment.size === 'number' &&
    Number.isSafeInteger(attachment.size) &&
    attachment.size >= 0 &&
    attachment.size <= 10 * 1024 * 1024
  )
}

function parseQueue(raw: string | null): GuiQueueEnvelope | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<GuiQueueEnvelope>
    const options = candidate.options as Partial<GuiQueuedOptions> | undefined
    const attachments = candidate.attachments === undefined ? [] : candidate.attachments
    const model = cleanNullableString(options?.model)
    const effort = cleanNullableString(options?.effort)
    const deliveryError =
      typeof candidate.deliveryError === 'string'
        ? candidate.deliveryError.replace(/\s+/gu, ' ').trim().slice(0, 320)
        : undefined
    if (
      candidate.v !== GUI_QUEUE_VERSION ||
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      typeof candidate.text !== 'string' ||
      candidate.text.length > GUI_QUEUE_MAX_CHARS ||
      typeof candidate.at !== 'number' ||
      !Number.isFinite(candidate.at) ||
      !options ||
      model === undefined ||
      effort === undefined ||
      (candidate.deliveryError !== undefined && typeof candidate.deliveryError !== 'string') ||
      typeof options.permissionMode !== 'string' ||
      !Array.isArray(attachments) ||
      attachments.length > GUI_QUEUE_ATTACHMENT_MAX_FILES ||
      !attachments.every(isQueuedAttachment)
    )
      return null
    if (!candidate.text.trim() && attachments.length === 0) return null
    const attachmentIds = new Set<string>()
    const attachmentPaths = new Set<string>()
    let attachmentBytes = 0
    for (const attachment of attachments) {
      if (attachmentIds.has(attachment.id) || attachmentPaths.has(attachment.path)) return null
      attachmentIds.add(attachment.id)
      attachmentPaths.add(attachment.path)
      attachmentBytes += attachment.size ?? 0
    }
    if (attachmentBytes > GUI_QUEUE_ATTACHMENT_MAX_TOTAL_BYTES) return null
    const claimToken =
      typeof candidate.claimToken === 'string' && candidate.claimToken
        ? candidate.claimToken.slice(0, 256)
        : undefined
    const claimedAt =
      typeof candidate.claimedAt === 'number' && Number.isFinite(candidate.claimedAt)
        ? candidate.claimedAt
        : undefined
    return {
      v: GUI_QUEUE_VERSION,
      id: candidate.id.slice(0, 128),
      text: candidate.text,
      at: candidate.at,
      options: {
        model,
        effort,
        permissionMode: options.permissionMode.slice(0, 64)
      },
      attachments: attachments.map((attachment) => ({ ...attachment })),
      ...(deliveryError ? { deliveryError } : {}),
      ...(claimToken && claimedAt !== undefined ? { claimToken, claimedAt } : {})
    }
  } catch {
    return null
  }
}

function publicMessage(envelope: GuiQueueEnvelope): GuiQueuedMessage {
  const { id, text, at, options, attachments, deliveryError } = envelope
  const claimedUntil =
    envelope.claimToken && envelope.claimedAt !== undefined
      ? envelope.claimedAt + GUI_QUEUE_CLAIM_LEASE_MS
      : undefined
  return {
    id,
    text,
    at,
    options,
    attachments: attachments.map((attachment) => ({ ...attachment })),
    ...(deliveryError ? { deliveryError } : {}),
    // O prazo autoriza outro renderer a ASSUMIR a entrega depois de um crash;
    // nunca autoriza o usuário a editar/apagar enquanto não houve ACK ou falha.
    ...(claimedUntil !== undefined
      ? { deliveryInFlight: true, deliveryClaimedUntil: claimedUntil }
      : {})
  }
}

export function readGuiQueuedMessage(
  paneId: string,
  storage: GuiQueueStorage = localStorage
): GuiQueuedMessage | null {
  const envelope = parseQueue(storageGet(storage, queueKey(paneId)))
  return envelope ? publicMessage(envelope) : null
}

export function writeGuiQueuedMessage(
  paneId: string,
  message: GuiQueuedMessage,
  storage: GuiQueueStorage = localStorage
): boolean {
  const envelope = parseQueue(JSON.stringify({ ...message, v: GUI_QUEUE_VERSION }))
  if (!envelope) return false
  return storageSet(storage, queueKey(paneId), JSON.stringify(envelope))
}

export function removeGuiQueuedMessage(
  paneId: string,
  expectedId?: string,
  storage: GuiQueueStorage = localStorage
): boolean {
  const key = queueKey(paneId)
  const current = parseQueue(storageGet(storage, key))
  if (!current || (expectedId && current.id !== expectedId)) return false
  if (current.claimToken) return false
  return storageRemove(storage, key)
}

/**
 * Lease recuperável entre os dois renderers do Electron. O vencedor escreve
 * um token e confirma a posse, mas o envelope só sai depois do ACK idempotente
 * do main. Se o renderer morrer, outra janela pode retomá-lo após o prazo.
 */
export function claimGuiQueuedMessage(
  paneId: string,
  ownerToken: string,
  storage: GuiQueueStorage = localStorage,
  now = Date.now()
): GuiQueuedMessage | null {
  const key = queueKey(paneId)
  const current = parseQueue(storageGet(storage, key))
  if (!current) return null
  const claimToken = `${ownerToken}:${current.id}`.slice(0, 256)
  const activeUntil =
    current.claimToken && current.claimedAt !== undefined
      ? current.claimedAt + GUI_QUEUE_CLAIM_LEASE_MS
      : 0
  if (activeUntil > now && current.claimToken !== claimToken) return null
  if (!storageSet(storage, key, JSON.stringify({ ...current, claimToken, claimedAt: now }))) {
    return null
  }
  const claimed = parseQueue(storageGet(storage, key))
  if (!claimed || claimed.id !== current.id || claimed.claimToken !== claimToken) return null
  return publicMessage(claimed)
}

/** Remove somente o envelope que este renderer tomou e apenas depois do ACK
 * idempotente do main. Um token vencido/sobrescrito nunca apaga trabalho alheio. */
export function acknowledgeGuiQueuedMessage(
  paneId: string,
  expectedId: string,
  ownerToken: string,
  storage: GuiQueueStorage = localStorage
): boolean {
  const key = queueKey(paneId)
  const current = parseQueue(storageGet(storage, key))
  const claimToken = `${ownerToken}:${expectedId}`.slice(0, 256)
  if (!current || current.id !== expectedId || current.claimToken !== claimToken) return false
  return storageRemove(storage, key)
}

/** Falha confirmada libera a lease e conserva exatamente o mesmo id/payload. */
export function releaseGuiQueuedMessageClaim(
  paneId: string,
  ownerToken: string,
  message: GuiQueuedMessage,
  error: string,
  storage: GuiQueueStorage = localStorage
): GuiQueuedMessage | null {
  const key = queueKey(paneId)
  const current = parseQueue(storageGet(storage, key))
  const claimToken = `${ownerToken}:${message.id}`.slice(0, 256)
  if (!current || current.id !== message.id || current.claimToken !== claimToken) return null
  const deliveryError = error.replace(/\s+/gu, ' ').trim().slice(0, 320)
  const released = parseQueue(
    JSON.stringify({
      ...message,
      v: GUI_QUEUE_VERSION,
      deliveryError: deliveryError || 'não deu para enviar automaticamente'
    })
  )
  if (!released || !storageSet(storage, key, JSON.stringify(released))) return null
  return publicMessage(released)
}

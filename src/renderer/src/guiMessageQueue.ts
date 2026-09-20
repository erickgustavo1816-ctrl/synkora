import type { GuiAttachmentDescriptor } from '../../preload'
import type { GuiBrowserReference } from '../../shared/guiBrowserReferences'

const GUI_QUEUE_PREFIX = 'synkora.guiQueue.'
const GUI_QUEUE_VERSION = 2
export const GUI_QUEUE_MAX_CHARS = 1_000_000
export const GUI_QUEUE_CLAIM_LEASE_MS = 60_000
const GUI_QUEUE_ATTACHMENT_MAX_FILES = 20
// Mirrors main/guiAttachments.ts and guiComposerAttachments.ts.
const GUI_QUEUE_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
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
  browserReferences?: GuiBrowserReference[]
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

/** O main ainda é autoridade da capacidade/arquivo; isto só impede estado
 * adulterado do localStorage de entrar na fila visível. Mantido local para a fila poder
 * ser lida no boot sem depender do composer já montado. */
function isQueuedAttachment(value: unknown): value is GuiAttachmentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attachment = value as Partial<GuiAttachmentDescriptor>
  if (
    Object.keys(attachment).some(
      (key) => !['id', 'capability', 'kind', 'name', 'mime', 'size'].includes(key)
    )
  )
    return false
  if (
    typeof attachment.id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(attachment.id) ||
    typeof attachment.capability !== 'string' ||
    !/^gui-cap-v1-[A-Za-z0-9_-]{43}$/u.test(attachment.capability) ||
    (attachment.kind !== 'file' && attachment.kind !== 'image' && attachment.kind !== 'folder') ||
    typeof attachment.name !== 'string' ||
    !attachment.name.trim() ||
    attachment.name.length > 120 ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(attachment.name) ||
    /^[.\s]|[.\s]$/u.test(attachment.name)
  )
    return false
  if (attachment.kind === 'folder') return attachment.size === null && attachment.mime === null
  return (
    typeof attachment.size === 'number' &&
    Number.isSafeInteger(attachment.size) &&
    attachment.size >= 0 &&
    attachment.size <= GUI_QUEUE_ATTACHMENT_MAX_BYTES &&
    typeof attachment.mime === 'string' &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,127}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(
      attachment.mime
    )
  )
}

/** Leitura do envelope é síncrona no boot. O main continua resolvendo estes
 * IDs contra os snapshots canônicos do mesmo pane antes de entregar ao agente. */
function isQueuedBrowserReference(value: unknown): value is GuiBrowserReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as GuiBrowserReference
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  const short = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max
  const viewport = (v: GuiBrowserReference['viewport']): boolean => Boolean(v &&
    finite(v.width) && v.width > 0 && v.width <= 100_000 &&
    finite(v.height) && v.height > 0 && v.height <= 100_000 &&
    finite(v.devicePixelRatio) && v.devicePixelRatio > 0 && v.devicePixelRatio <= 100 &&
    finite(v.scrollX) && finite(v.scrollY))
  return Boolean(
    short(ref.id, 128) && /^browser-reference-[A-Za-z0-9-]{20,100}$/u.test(ref.id) &&
    Number.isSafeInteger(ref.number) && ref.number > 0 &&
    short(ref.capturedAt, 40) && Number.isFinite(Date.parse(ref.capturedAt)) &&
    short(ref.missionId, 256) && ref.missionId && short(ref.tabId, 256) && ref.tabId &&
    short(ref.url, 16_384) && short(ref.frameUrl, 16_384) &&
    short(ref.frameId, 256) && Number.isSafeInteger(ref.backendNodeId) && ref.backendNodeId > 0 &&
    viewport(ref.viewport) && (ref.frameViewport === undefined || viewport(ref.frameViewport)) &&
    ref.element && short(ref.element.tag, 128) && short(ref.element.selector, 8_192) &&
    (ref.element.selectorPath === undefined || (Array.isArray(ref.element.selectorPath) &&
      ref.element.selectorPath.length <= 100 && ref.element.selectorPath.every(part => short(part, 8_192)))) &&
    short(ref.element.text, 8_192) && ref.element.bounds &&
    ['x', 'y', 'width', 'height'].every(key => finite(ref.element.bounds[key as keyof typeof ref.element.bounds]))
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
    const browserReferences = candidate.browserReferences === undefined ? [] : candidate.browserReferences
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
      !attachments.every(isQueuedAttachment) ||
      !Array.isArray(browserReferences) || browserReferences.length > 20 ||
      !browserReferences.every(isQueuedBrowserReference) ||
      new Set(browserReferences.map(ref => ref.id)).size !== browserReferences.length ||
      new Set(browserReferences.map(ref => ref.number)).size !== browserReferences.length
    )
      return null
    if (!candidate.text.trim() && attachments.length === 0 && browserReferences.length === 0) return null
    const attachmentIds = new Set<string>()
    const attachmentCapabilities = new Set<string>()
    let attachmentBytes = 0
    for (const attachment of attachments) {
      if (
        attachmentIds.has(attachment.id) ||
        attachmentCapabilities.has(attachment.capability)
      )
        return null
      attachmentIds.add(attachment.id)
      attachmentCapabilities.add(attachment.capability)
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
      ...(browserReferences.length > 0 ? { browserReferences: structuredClone(browserReferences) } : {}),
      ...(deliveryError ? { deliveryError } : {}),
      ...(claimToken && claimedAt !== undefined ? { claimToken, claimedAt } : {})
    }
  } catch {
    return null
  }
}

function publicMessage(envelope: GuiQueueEnvelope): GuiQueuedMessage {
  const { id, text, at, options, attachments, browserReferences, deliveryError } = envelope
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
    ...(browserReferences?.length ? { browserReferences: structuredClone(browserReferences) } : {}),
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

/** A refusal releases the lease and preserves the exact payload. An empty
 * error means a transient deferral, eligible for automatic retry. */
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
      deliveryError: deliveryError || undefined
    })
  )
  if (!released || !storageSet(storage, key, JSON.stringify(released))) return null
  return publicMessage(released)
}

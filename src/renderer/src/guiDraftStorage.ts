const GUI_DRAFT_PREFIX = 'synkora.guiDraft.'
const GUI_DRAFT_VERSION = 1
export const GUI_DRAFT_MAX_CHARS = 1_000_000

type GuiDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

interface GuiDraftEnvelope {
  v: typeof GUI_DRAFT_VERSION
  text: string
  updatedAt: number
}

function draftKey(paneId: string): string {
  return `${GUI_DRAFT_PREFIX}${paneId}`
}

function parseDraft(raw: string | null): GuiDraftEnvelope | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<GuiDraftEnvelope>
    if (
      candidate.v !== GUI_DRAFT_VERSION ||
      typeof candidate.text !== 'string' ||
      typeof candidate.updatedAt !== 'number' ||
      !Number.isFinite(candidate.updatedAt)
    )
      return null
    return {
      v: GUI_DRAFT_VERSION,
      text: candidate.text.slice(0, GUI_DRAFT_MAX_CHARS),
      updatedAt: candidate.updatedAt
    }
  } catch {
    return null
  }
}

function quotaExceeded(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'QuotaExceededError' || (error as Error & { code?: number }).code === 22
}

function draftEntries(storage: GuiDraftStorage): Array<{ key: string; updatedAt: number }> {
  const entries: Array<{ key: string; updatedAt: number }> = []
  let length: number
  try {
    length = storage.length
  } catch {
    return entries
  }
  for (let index = 0; index < length; index += 1) {
    try {
      const key = storage.key(index)
      if (!key?.startsWith(GUI_DRAFT_PREFIX)) continue
      entries.push({ key, updatedAt: parseDraft(storage.getItem(key))?.updatedAt ?? 0 })
    } catch {
      // Uma origem de storage indisponível não deve derrubar o composer.
    }
  }
  return entries.sort((left, right) => left.updatedAt - right.updatedAt)
}

export function readGuiDraft(paneId: string, storage: GuiDraftStorage = localStorage): string {
  try {
    return parseDraft(storage.getItem(draftKey(paneId)))?.text ?? ''
  } catch {
    return ''
  }
}

export function removeGuiDraft(paneId: string, storage: GuiDraftStorage = localStorage): void {
  try {
    storage.removeItem(draftKey(paneId))
  } catch {
    // localStorage indisponível é degradado para rascunho somente em memória.
  }
}

export function writeGuiDraft(
  paneId: string,
  text: string,
  storage: GuiDraftStorage = localStorage,
  now = Date.now()
): boolean {
  const key = draftKey(paneId)
  if (!text) {
    try {
      storage.removeItem(key)
      return true
    } catch {
      return false
    }
  }
  const payload = JSON.stringify({
    v: GUI_DRAFT_VERSION,
    text: text.slice(0, GUI_DRAFT_MAX_CHARS),
    updatedAt: now
  } satisfies GuiDraftEnvelope)
  try {
    storage.setItem(key, payload)
    return true
  } catch (error) {
    if (!quotaExceeded(error)) return false
  }

  // Quota cheia: rascunhos mais antigos cedem espaço primeiro. A chave atual
  // fica por último, para nunca perder uma versão ainda recuperável cedo demais.
  // A versão anterior do rascunho atual é a única que nunca pode virar vítima:
  // se o novo payload também não couber, ela continua recuperável no reload.
  const victims = draftEntries(storage)
    .filter((entry) => entry.key !== key)
    .sort((left, right) => left.updatedAt - right.updatedAt)
  for (const victim of victims) {
    try {
      storage.removeItem(victim.key)
    } catch {
      return false
    }
    try {
      storage.setItem(key, payload)
      return true
    } catch (error) {
      if (!quotaExceeded(error)) return false
    }
  }
  return false
}

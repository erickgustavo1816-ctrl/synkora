import { randomUUID } from 'node:crypto'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import {
  GUI_BROWSER_REFERENCE_ID_RE,
  GUI_BROWSER_REFERENCE_MAX,
  guiBrowserReferenceUrl,
  isBrowserElementSnapshot,
  isGuiBrowserReference,
  type BrowserElementSnapshot,
  type GuiBrowserReference
} from './guiBrowserReferenceTypes'

const MAX_STORED_REFERENCES = 10_000
const PANE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/u
interface ReferenceRecord { paneId: string; pending: boolean; reference: GuiBrowserReference }
interface ReferenceDoc {
  version: 1
  entries: Record<string, ReferenceRecord>
  nextNumbers: Record<string, number>
}

function emptyDoc(): ReferenceDoc { return { version: 1, entries: {}, nextNumbers: {} } }
function clone<T>(value: T): T { return structuredClone(value) }

function isDoc(value: unknown): value is ReferenceDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const doc = value as Partial<ReferenceDoc>
  if (doc.version !== 1 || !doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries) ||
    !doc.nextNumbers || typeof doc.nextNumbers !== 'object' || Array.isArray(doc.nextNumbers)) return false
  const entries = Object.entries(doc.entries)
  if (entries.length > MAX_STORED_REFERENCES || Object.keys(doc.nextNumbers).length > MAX_STORED_REFERENCES) return false
  const numbers = new Set<string>()
  const pending = new Map<string, number>()
  for (const [id, entry] of entries) {
    if (!entry || !PANE_ID_RE.test(entry.paneId) || typeof entry.pending !== 'boolean' ||
      !isGuiBrowserReference(entry.reference) || entry.reference.id !== id) return false
    const key = `${entry.paneId}/${entry.reference.number}`
    if (numbers.has(key)) return false
    numbers.add(key)
    if ((doc.nextNumbers[entry.paneId] ?? 0) <= entry.reference.number) return false
    if (entry.pending) {
      const count = (pending.get(entry.paneId) ?? 0) + 1
      if (count > GUI_BROWSER_REFERENCE_MAX) return false
      pending.set(entry.paneId, count)
    }
  }
  return Object.entries(doc.nextNumbers).every(([paneId, number]) =>
    PANE_ID_RE.test(paneId) && Number.isSafeInteger(number) && number > 0)
}

/** The main process owns the snapshot. Renderer descriptors can only select an
 * opaque, pane-bound record. Consuming/removing a draft pin does not revoke an
 * already queued message; the canonical record remains valid after reload. */
export class GuiBrowserReferenceStore {
  private doc: ReferenceDoc

  constructor(private readonly file?: string) {
    this.doc = file ? loadJsonStore(file, emptyDoc, isDoc) : emptyDoc()
  }

  list(paneId: string): GuiBrowserReference[] {
    this.assertPane(paneId)
    return Object.values(this.doc.entries)
      .filter(entry => entry.paneId === paneId && entry.pending)
      .sort((left, right) => left.reference.number - right.reference.number)
      .map(entry => clone(entry.reference))
  }

  capture(paneId: string, missionId: string, tabId: string, snapshot: BrowserElementSnapshot): GuiBrowserReference {
    this.assertPane(paneId)
    const sanitized = { ...snapshot, url: guiBrowserReferenceUrl(snapshot?.url), frameUrl: guiBrowserReferenceUrl(snapshot?.frameUrl) }
    if (!isBrowserElementSnapshot(sanitized)) throw new Error('a seleção do browser está incompleta; selecione o elemento novamente')
    if (this.list(paneId).length >= GUI_BROWSER_REFERENCE_MAX) {
      throw new Error('há 20 referências no rascunho; remova ou envie algumas antes de selecionar mais')
    }
    if (Object.keys(this.doc.entries).length >= MAX_STORED_REFERENCES) {
      throw new Error('o registro de referências está cheio; não foi possível guardar esta seleção')
    }
    const reference: GuiBrowserReference = {
      ...clone(sanitized), id: `browser-reference-${randomUUID()}`,
      number: this.doc.nextNumbers[paneId] ?? 1, missionId, tabId
    }
    if (!isGuiBrowserReference(reference) || !Number.isSafeInteger(reference.number + 1)) {
      throw new Error('a referência do browser não tem um identificador válido')
    }
    this.commit({
      version: 1,
      entries: { ...this.doc.entries, [reference.id]: { paneId, pending: true, reference } },
      nextNumbers: { ...this.doc.nextNumbers, [paneId]: reference.number + 1 }
    })
    return clone(reference)
  }

  resolve(paneId: string, input?: unknown): GuiBrowserReference[] {
    this.assertPane(paneId)
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > GUI_BROWSER_REFERENCE_MAX) {
      throw new Error('as referências do browser estão em formato inválido')
    }
    const ids = input.map(value => typeof value === 'string' ? value : value?.id)
    return this.records(paneId, ids).map(entry => clone(entry.reference))
  }

  remove(paneId: string, id: unknown): void { this.consume(paneId, [id]) }

  consume(paneId: string, input: unknown): void {
    this.assertPane(paneId)
    const selected = this.records(paneId, input)
    if (selected.every(entry => !entry.pending)) return
    const entries = { ...this.doc.entries }
    for (const entry of selected) entries[entry.reference.id] = { ...entry, pending: false }
    this.commit({ ...this.doc, entries })
  }

  private records(paneId: string, input: unknown): ReferenceRecord[] {
    if (!Array.isArray(input) || input.length > GUI_BROWSER_REFERENCE_MAX ||
      input.some(id => typeof id !== 'string' || !GUI_BROWSER_REFERENCE_ID_RE.test(id)) ||
      new Set(input).size !== input.length) throw new Error('as referências do browser estão em formato inválido')
    return input.map(id => {
      const entry = this.doc.entries[id]
      if (!entry || entry.paneId !== paneId) {
        throw new Error('esta referência não pertence a esta conversa; selecione o elemento novamente')
      }
      return entry
    })
  }

  private assertPane(paneId: string): void {
    if (typeof paneId !== 'string' || !PANE_ID_RE.test(paneId)) throw new Error('pane sem identificador válido')
  }

  private commit(next: ReferenceDoc): void {
    try { if (this.file) persistJsonStore(this.file, next) }
    catch { throw new Error('não foi possível guardar a referência; tente selecionar o elemento novamente') }
    this.doc = next
  }
}

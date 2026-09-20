import { existsSync } from 'node:fs'
// @ts-expect-error Node strip-types requires the extension.
import { loadJsonStore, persistJsonStore } from './jsonStore.ts'
// @ts-expect-error Node strip-types requires the extension.
import { redactSensitiveText } from './securityRedaction.ts'
import type { ReleaseChangeRecord } from '../shared/releaseChanges'

interface ChangesDoc { version: 1; changes: ReleaseChangeRecord[] }

function validDoc(value: unknown): value is ChangesDoc {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<ChangesDoc>
  return doc.version === 1 && Array.isArray(doc.changes) && doc.changes.every((record) =>
    record && ['id', 'projectId', 'versionId', 'missionId', 'at', 'branch', 'parentHead',
      'sha', 'summary', 'reason', 'validation'].every((key) =>
      typeof (record as unknown as Record<string, unknown>)[key] === 'string') &&
    ['before-release', 'after-release'].includes(record.phase) &&
    ['prepared', 'saved', 'not-applied'].includes(record.state) &&
    /^[a-f0-9]{40,64}$/u.test(record.sha) && /^[a-f0-9]{40,64}$/u.test(record.parentHead) &&
    Array.isArray(record.files) && record.files.every((file) => typeof file === 'string')
  )
}

/** The journal is written BEFORE moving a branch. Corruption never becomes an empty journal. */
export class ReleaseChangesStore {
  private readonly file: string
  constructor(file: string) { this.file = file }

  private load(): ChangesDoc {
    return loadJsonStore(this.file, () => {
      if (existsSync(this.file) || existsSync(`${this.file}.bak`))
        throw new Error('histórico de correções ilegível; restaure o backup do Synkora antes de salvar')
      return { version: 1, changes: [] }
    }, validDoc)
  }

  list(projectId: string, versionId: string): ReleaseChangeRecord[] {
    return this.load().changes.filter((r) => r.projectId === projectId && r.versionId === versionId)
  }

  prepare(record: ReleaseChangeRecord): ReleaseChangeRecord {
    const doc = this.load()
    const existing = doc.changes.find((r) => r.projectId === record.projectId &&
      r.versionId === record.versionId && r.id === record.id)
    if (existing) return existing
    const clean = { ...record, summary: redactSensitiveText(record.summary),
      reason: redactSensitiveText(record.reason), validation: redactSensitiveText(record.validation) }
    persistJsonStore(this.file, { ...doc, changes: [...doc.changes, clean] })
    return clean
  }

  update(record: ReleaseChangeRecord, patch: Partial<Pick<ReleaseChangeRecord, 'state' | 'pushedAt'>>): void {
    const doc = this.load()
    const found = doc.changes.find((r) => r.projectId === record.projectId &&
      r.versionId === record.versionId && r.id === record.id)
    if (!found) throw new Error('recibo da correção não encontrado; leia release_status')
    Object.assign(found, patch)
    persistJsonStore(this.file, doc)
  }
}

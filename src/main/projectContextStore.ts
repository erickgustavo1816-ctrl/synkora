import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import type { ContextNote, ContextNoteRepository } from './projectContextTypes'

interface ContextDocument { version: 1; notes: ContextNote[] }
function valid(value: unknown): value is ContextDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<ContextDocument>
  return doc.version === 1 && Array.isArray(doc.notes) && doc.notes.every((note) =>
    note && typeof note.id === 'string' && typeof note.projectId === 'string' &&
    typeof note.missionId === 'string' && Number.isInteger(note.revision) && note.revision > 0 &&
    ['overview', 'decision', 'note'].includes(note.kind) && typeof note.title === 'string' &&
    typeof note.body === 'string' && typeof note.updatedAt === 'string' &&
    (note.versionId === undefined || typeof note.versionId === 'string') &&
    (note.sourceHead === undefined || /^[a-f0-9]{40,64}$/u.test(note.sourceHead)) &&
    Array.isArray(note.sources) && note.sources.every((source) => typeof source === 'string'))
}
const unavailable = 'Memória indisponível: preserve os arquivos de contexto e restaure uma cópia válida antes de registrar decisões.'

/** Append-only revisions, atomic persistence and compare-and-swap across missions. */
export class ProjectContextStore implements ContextNoteRepository {
  private doc: ContextDocument = { version: 1, notes: [] }
  private problem = false
  constructor(private readonly file: string) {
    const existed = existsSync(file) || existsSync(`${file}.bak`)
    this.doc = loadJsonStore(file, () => {
      this.problem = existed
      return { version: 1, notes: [] }
    }, valid)
  }
  private ready(): void { if (this.problem) throw new Error(unavailable) }
  list(projectId: string): ContextNote[] {
    this.ready()
    const latest = new Map<string, ContextNote>()
    for (const note of this.doc.notes) {
      if (note.projectId !== projectId) continue
      if ((latest.get(note.id)?.revision ?? 0) < note.revision) latest.set(note.id, note)
    }
    return structuredClone([...latest.values()])
  }
  get(projectId: string, id: string, revision?: number): ContextNote | undefined {
    this.ready()
    const notes = this.doc.notes.filter((note) => note.projectId === projectId && note.id === id &&
      (revision === undefined || note.revision === revision))
    return structuredClone(notes.sort((a, b) => b.revision - a.revision)[0])
  }
  save(input: Omit<ContextNote, 'revision' | 'updatedAt'>, expectedRevision: number): ContextNote {
    this.ready()
    const previous = this.get(input.projectId, input.id)
    if (previous && previous.missionId !== input.missionId) throw new Error('Registro pertence a outra missão.')
    // A repeated receipt repairs the caller after a response was lost.
    if (previous && previous.kind === input.kind && previous.title === input.title &&
      previous.body === input.body && JSON.stringify(previous.sources) === JSON.stringify(input.sources) &&
      previous.sourceHead === input.sourceHead && previous.versionId === input.versionId) return previous
    if ((previous?.revision ?? 0) !== expectedRevision)
      throw new Error('O registro mudou. Leia context_read e repita context_record com a revision atual.')
    const note: ContextNote = { ...input, revision: expectedRevision + 1, updatedAt: new Date().toISOString() }
    const next: ContextDocument = { version: 1, notes: [...this.doc.notes, note] }
    if (!valid(next)) throw new Error('Registro inválido; confira os campos de context_record.')
    mkdirSync(dirname(this.file), { recursive: true })
    persistJsonStore(this.file, next)
    this.doc = next
    return structuredClone(note)
  }
}

import type { PaneIdentity } from './hub'
import type { Mission } from './missions'
import type { Version } from './backlog'
import type { Plan } from './plans'
import type { Project } from './projects'

export type ContextScope = 'base' | 'version' | 'project'
export type ContextNoteKind = 'overview' | 'decision' | 'note'
export interface ContextNote {
  id: string
  projectId: string
  missionId: string
  versionId?: string
  revision: number
  kind: ContextNoteKind
  title: string
  body: string
  sources: string[]
  sourceHead?: string
  updatedAt: string
}
export interface ContextRecordInput {
  key: string
  expectedRevision: number
  kind: ContextNoteKind
  title: string
  body: string
  sources: string[]
}
export interface ContextSearchInput {
  query?: string
  scope?: ContextScope
  versionId?: string
  missionId?: string
  file?: string
  offset?: number
  limit?: number
}
export interface ContextReadInput {
  id: string
  revision?: number
  offset?: number
  limit?: number
}
export interface ContextGitSnapshot {
  head?: string
  included: Record<string, boolean | null>
}
export interface ContextNoteRepository {
  list(projectId: string): ContextNote[]
  get(projectId: string, id: string, revision?: number): ContextNote | undefined
  save(note: Omit<ContextNote, 'revision' | 'updatedAt'>, expectedRevision: number): ContextNote
}
export interface ProjectContextDeps {
  projects: { get(id: string): Project | undefined }
  missions: { get(id: string): Mission | undefined; list(projectId: string): Mission[] }
  versions: { listVersions(projectId: string): Version[] }
  plans: { list(projectId: string): Plan[] }
  notes: ContextNoteRepository
  inspect(cwd: string, heads: string[]): Promise<ContextGitSnapshot>
  audit?(event: string, identity: PaneIdentity, detail: Record<string, unknown>): void
}
export interface ContextData {
  project: Project
  mission?: Mission
  version?: Version
  missions: Mission[]
  versions: Version[]
  plans: Plan[]
  notes: ContextNote[]
}
export interface ContextEntry {
  id: string
  kind: 'mission' | 'version' | 'plan' | 'plan-item' | ContextNoteKind
  title: string
  body: string
  versionId?: string
  missionId?: string
  state: string
  updatedAt: string
  files: string[]
  sources: string[]
  sourceHead?: string
  revision?: number
}
export interface ProjectContextToolkit {
  status(identity: PaneIdentity, afterRevision?: string): Promise<string>
  search(identity: PaneIdentity, input: ContextSearchInput): Promise<string>
  read(identity: PaneIdentity, input: ContextReadInput): Promise<string>
  record(identity: PaneIdentity, input: ContextRecordInput): Promise<string>
  notice(identity: PaneIdentity): string | undefined
  briefing(projectId: string, missionId: string): string
}

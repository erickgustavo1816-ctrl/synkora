/** Type-only contract shared by main, preload and renderer; no runtime dependency. */
export interface ReleaseChangeRecord {
  id: string
  projectId: string
  versionId: string
  missionId: string
  at: string
  phase: 'before-release' | 'after-release'
  branch: string
  parentHead: string
  sha: string
  files: string[]
  summary: string
  reason: string
  /** Agent-reported validation, not an automatically verified test result. */
  validation: string
  state: 'prepared' | 'saved' | 'not-applied'
  pushedAt?: string
}

export interface ReleaseSaveInput {
  requestId: string
  expectedHead: string
  files: string[]
  summary: string
  reason: string
  validation: string
}

export interface ReleaseChangesSignal {
  dirty?: boolean
  pending: boolean
  pendingPush?: boolean
  error?: string
  text?: string
}

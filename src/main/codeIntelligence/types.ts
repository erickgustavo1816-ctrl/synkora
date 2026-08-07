export type CodeLanguage =
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact'

export type CodeOperation =
  | 'diagnostics'
  | 'definition'
  | 'references'
  | 'symbols'
  | 'hover'
  | 'implementations'
  | 'call_hierarchy'

export interface CodePosition {
  /** One-based line number. */
  line: number
  /** One-based UTF-16 column. */
  column: number
}

export interface CodeRange {
  start: CodePosition
  end: CodePosition
}

export interface CodeLocation {
  path: string
  range: CodeRange
}

export interface CodeDiagnostic extends CodeLocation {
  severity: 'error' | 'warning' | 'information' | 'hint' | 'unknown'
  message: string
  code?: string
  source?: string
}

export interface CodeDefinition extends CodeLocation {
  originRange?: CodeRange
}

export interface CodeReference extends CodeLocation {}

export interface CodeSymbol extends CodeLocation {
  name: string
  kind: string
  detail?: string
  container?: string
  selectionRange?: CodeRange
}

export interface CodeHover extends CodeLocation {
  contents: string
}

export interface CodeImplementation extends CodeLocation {}

export interface CodeCallHierarchyItem extends CodeLocation {
  name: string
  kind: string
  detail?: string
}

export interface CodeCallEdge {
  direction: 'incoming' | 'outgoing'
  from: CodeCallHierarchyItem
  to: CodeCallHierarchyItem
  ranges?: CodeRange[]
}

export type CodeResultItem =
  | CodeDiagnostic
  | CodeDefinition
  | CodeReference
  | CodeSymbol
  | CodeHover
  | CodeImplementation
  | CodeCallEdge

export interface CodeServerMetadata {
  kind: 'typescript-native' | 'typescript-language-server'
  name: string
  version: string
  config: string | null
}

export interface CodeSynchronizationMetadata {
  state: 'current' | 'stale' | 'unknown'
  documentVersion: number | null
  diskMtimeMs: number | null
  reason?: string
}

export interface CodeQueryResult<T extends CodeResultItem = CodeResultItem> {
  operation: CodeOperation
  items: T[]
  /** Number of matching items before pagination. */
  total: number
  /** Applied zero-based result offset. */
  offset: number
  truncated: boolean
  language: CodeLanguage
  server: CodeServerMetadata
  synchronization: CodeSynchronizationMetadata
}

interface CodeQueryBase {
  /** Path relative to the authorized worktree. */
  path: string
  /** Maximum number of items returned. The manager also enforces a hard ceiling. */
  limit?: number
  /** Zero-based offset applied after deterministic sorting. */
  offset?: number
}

interface CodePositionQuery extends CodeQueryBase {
  /** One-based line and UTF-16 column. */
  position: CodePosition
}

export interface CodeDiagnosticsQuery extends CodeQueryBase {
  operation: 'diagnostics'
}

export interface CodeDefinitionQuery extends CodePositionQuery {
  operation: 'definition'
}

export interface CodeReferencesQuery extends CodePositionQuery {
  operation: 'references'
  includeDeclaration?: boolean
}

export interface CodeSymbolsQuery extends CodeQueryBase {
  operation: 'symbols'
}

export interface CodeHoverQuery extends CodePositionQuery {
  operation: 'hover'
}

export interface CodeImplementationsQuery extends CodePositionQuery {
  operation: 'implementations'
}

export interface CodeCallHierarchyQuery extends CodePositionQuery {
  operation: 'call_hierarchy'
  direction?: 'incoming' | 'outgoing' | 'both'
}

export type CodeQuery =
  | CodeDiagnosticsQuery
  | CodeDefinitionQuery
  | CodeReferencesQuery
  | CodeSymbolsQuery
  | CodeHoverQuery
  | CodeImplementationsQuery
  | CodeCallHierarchyQuery

export type CodeIntelligenceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PATH_OUTSIDE_WORKTREE'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_LANGUAGE'
  | 'SERVER_UNAVAILABLE'
  | 'SERVER_BUSY'
  | 'REQUEST_FAILED'
  | 'MANAGER_CLOSED'

export class CodeIntelligenceError extends Error {
  readonly code: CodeIntelligenceErrorCode
  readonly retryable: boolean

  constructor(code: CodeIntelligenceErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'CodeIntelligenceError'
    this.code = code
    this.retryable = retryable
  }
}

export interface CodeIntelligenceSnapshot {
  closed: boolean
  processCount: number
  documentBytes: number
  telemetry: {
    starts: number
    restarts: number
    evictions: number
    failures: number
    requests: number
    reuses: number
  }
  entries: Array<{
    key: string
    root: string
    server: CodeServerMetadata
    running: boolean
    activeQueries: number
    owners: number
    lastUsedAt: number
    restartFailures: number
    openDocuments: number
    documentBytes: number
  }>
}

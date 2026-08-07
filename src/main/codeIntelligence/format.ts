import {
  CodeIntelligenceError,
  type CodeCallEdge,
  type CodeDiagnostic,
  type CodeHover,
  type CodeQueryResult,
  type CodeRange,
  type CodeResultItem,
  type CodeSymbol
} from './types'

/** A borda MCP usa um formato deliberadamente menor que os tipos internos.
 *  Caminhos já chegam relativos e ranges já chegam em base 1 pelo manager. */
export function formatCodeQueryResult(result: CodeQueryResult): string {
  return JSON.stringify({
    ok: true,
    op: result.operation,
    language: result.language,
    server: {
      kind: result.server.kind,
      name: result.server.name,
      version: result.server.version,
      config: result.server.config
    },
    state: result.synchronization.state,
    documentVersion: result.synchronization.documentVersion,
    total: result.total,
    offset: result.offset,
    truncated: result.truncated,
    items: result.items.map(compactItem)
  })
}

export function formatCodeQueryError(operation: string, error: unknown): string {
  const known = error instanceof CodeIntelligenceError ? error : null
  const code = known?.code ?? 'REQUEST_FAILED'
  const reasons: Record<string, string> = {
    INVALID_ARGUMENT: 'Parâmetros inválidos para a consulta.',
    PATH_OUTSIDE_WORKTREE: 'O caminho sai da worktree autorizada.',
    FILE_NOT_FOUND: 'O arquivo não existe mais.',
    FILE_TOO_LARGE: 'O arquivo excede o limite da inteligência de código.',
    UNSUPPORTED_LANGUAGE: 'A linguagem não tem servidor compatível nesta fase.',
    SERVER_UNAVAILABLE: 'O servidor de linguagem não está disponível.',
    SERVER_BUSY: 'Todos os servidores de linguagem estão ocupados.',
    REQUEST_FAILED: 'A consulta estrutural não pôde ser concluída.',
    MANAGER_CLOSED: 'A inteligência de código está encerrada.'
  }
  return JSON.stringify({
    ok: false,
    op: operation,
    code,
    retryable: known?.retryable ?? false,
    reason: reasons[code] ?? reasons.REQUEST_FAILED,
    fallback: 'Use busca textual; o pane continua funcionando normalmente.'
  })
}

function compactItem(item: CodeResultItem): Record<string, unknown> {
  if (isCallEdge(item)) {
    return {
      direction: item.direction,
      from: compactHierarchyItem(item.from),
      to: compactHierarchyItem(item.to)
    }
  }
  if (isDiagnostic(item)) {
    return {
      at: at(item.path, item.range),
      severity: item.severity,
      ...(item.code ? { code: item.code } : {}),
      ...(item.source ? { source: item.source } : {}),
      message: item.message
    }
  }
  if (isSymbol(item)) {
    return {
      at: at(item.path, item.selectionRange ?? item.range),
      name: item.name,
      kind: item.kind,
      ...(item.container ? { container: item.container } : {}),
      ...(item.detail ? { detail: item.detail } : {})
    }
  }
  if (isHover(item)) return { at: at(item.path, item.range), text: item.contents }
  return { at: at(item.path, item.range) }
}

function compactHierarchyItem(item: CodeCallEdge['from']): Record<string, unknown> {
  return {
    at: at(item.path, item.range),
    name: item.name,
    kind: item.kind,
    ...(item.detail ? { detail: item.detail } : {})
  }
}

function at(path: string, range: CodeRange): string {
  const start = `${path}:${range.start.line}:${range.start.column}`
  if (range.start.line === range.end.line && range.start.column === range.end.column) return start
  return `${start}-${range.end.line}:${range.end.column}`
}

function isCallEdge(item: CodeResultItem): item is CodeCallEdge {
  return 'direction' in item && 'from' in item && 'to' in item
}

function isDiagnostic(item: CodeResultItem): item is CodeDiagnostic {
  return 'severity' in item && 'message' in item
}

function isSymbol(item: CodeResultItem): item is CodeSymbol {
  return 'name' in item && !('direction' in item)
}

function isHover(item: CodeResultItem): item is CodeHover {
  return 'contents' in item
}

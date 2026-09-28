/**
 * Contratos clonáveis da paleta global. Este módulo é deliberadamente puro:
 * main, preload e os dois renderers precisam concordar sobre os mesmos alvos
 * sem importar Electron, React ou o store.
 */

export type HistoryProvider = 'claude' | 'codex'
export type HistoryMessageRole = 'user' | 'assistant'

export interface HistorySearchInput {
  requestId: string
  query: string
  /** Ausente = todos os universos conhecidos; presente = recorte do atual. */
  projectId?: string
}

export interface HistorySearchHit {
  selectionId: string
  provider: HistoryProvider
  sessionId: string
  /** ID do provedor quando existe; fallback determinístico baseado no cursor. */
  messageId: string
  /** Offset em bytes da linha JSONL. Continua estável entre buscas. */
  cursor: number
  role: HistoryMessageRole
  snippet: string
  at?: string
  projectId?: string
  missionId?: string
  paneId?: string
  label?: string
  /** Só panes GUI conhecidos podem receber um transcript arquivado. */
  canMount: boolean
}

export interface HistorySearchResult {
  ok: boolean
  requestId: string
  hits: HistorySearchHit[]
  cancelled: boolean
  truncated: boolean
  limitReason?: 'arquivos' | 'bytes' | 'tempo' | 'resultados'
  scannedFiles: number
  scannedBytes: number
  error?: string
}

export interface HistoryTranscriptMessage {
  id: string
  cursor: number
  role: HistoryMessageRole
  text: string
  at?: string
}

export interface HistoryLoadResult {
  ok: boolean
  selectionId: string
  provider?: HistoryProvider
  sessionId?: string
  messages?: HistoryTranscriptMessage[]
  targetMessageId?: string
  targetCursor?: number
  truncated?: boolean
  /** Vínculo reemitido pelo main a partir da seleção opaca. O renderer nunca
   *  usa os campos editáveis do alvo para escolher outro pane/universo. */
  projectId?: string
  missionId?: string
  paneId?: string
  canMount?: boolean
  error?: string
}

/**
 * A CONVERSA COMPLETA DE UM PANE (R24.2/R24.3). A paleta chega ao transcript
 * por um hit de busca; este contrato é o caminho inverso — o pane pede a
 * própria conversa e a lê por PÁGINAS, porque o anel de eventos poda por
 * espaço e o começo do fio some da tela.
 *
 * A faixa é pedida por CURSOR, que é o offset de byte da linha no JSONL:
 * `before` = a página que termina naquele cursor; `after` = a que começa
 * depois dele. Ausentes = a página do COMEÇO da conversa.
 */
export interface HistoryPageRequest {
  before?: number
  after?: number
}

/**
 * AS CONVERSAS DE UM CHAT (2026-09-28, pedido do dono: "ver o histórico de
 * todas as conversas"). Um pane troca de conversa no /new, /reset, /clear, na
 * troca de CLI ou de conta; o registro guarda o id de cada uma que ficou para
 * trás. `recovered` = conversa achada na pasta da missão para chats zerados
 * antes deste registro existir (melhor esforço, sem prova de autoria).
 */
export interface HistoryPaneConversation {
  sessionId: string
  provider: HistoryProvider
  /** A conversa que o chat retoma hoje (no máximo uma). */
  current: boolean
  source: 'chat' | 'recovered'
  /** ISO: quando ela deixou de ser a atual (chat) ou a última escrita no disco (recuperada). */
  updatedAt?: string
}

export interface HistoryPaneConversationsResult {
  ok: boolean
  paneId: string
  /** Da mais antiga para a mais nova; a atual, se existir, é a última. */
  conversations: HistoryPaneConversation[]
  error?: string
}

export interface HistoryPaneLoadResult {
  ok: boolean
  paneId: string
  provider?: HistoryProvider
  sessionId?: string
  messages?: HistoryTranscriptMessage[]
  targetMessageId?: string
  targetCursor?: number
  truncated?: boolean
  /** Sobrou arquivo fora desta página (arma "carregar mais antigas/novas"). */
  hasMoreBefore?: boolean
  hasMoreAfter?: boolean
  error?: string
}

/**
 * O renderer da WebContentsView não alcança o shell do host. Ele envia apenas
 * este alvo pequeno e validável; o host refaz a navegação com seu próprio
 * store e, para histórico, carrega o texto sanitizado de volta no main.
 */
export type PaletteNavigationTarget =
  | { kind: 'app'; page: 'home' | 'settings' }
  | {
      kind: 'project'
      projectId: string
      tab: 'board' | 'mapa' | 'backlog' | 'arquivos'
      missionId?: string
    }
  | { kind: 'file'; projectId: string; path: string; name: string }
  | {
      kind: 'history'
      selectionId: string
      projectId?: string
      missionId?: string
      paneId?: string
      canMount: boolean
    }

function safeId(value: unknown, cap = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= cap
}

/** Fail-closed no relay view -> host. Campos extras não viram autoridade. */
export function isPaletteNavigationTarget(value: unknown): value is PaletteNavigationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  if (target.kind === 'app') return target.page === 'home' || target.page === 'settings'
  if (target.kind === 'project') {
    return (
      safeId(target.projectId) &&
      (target.tab === 'board' ||
        target.tab === 'mapa' ||
        target.tab === 'backlog' ||
        target.tab === 'arquivos') &&
      (target.missionId === undefined || safeId(target.missionId))
    )
  }
  if (target.kind === 'file') {
    return safeId(target.projectId) && safeId(target.path, 4096) && safeId(target.name, 512)
  }
  if (target.kind === 'history') {
    return (
      safeId(target.selectionId) &&
      (target.projectId === undefined || safeId(target.projectId)) &&
      (target.missionId === undefined || safeId(target.missionId)) &&
      (target.paneId === undefined || safeId(target.paneId)) &&
      typeof target.canMount === 'boolean'
    )
  }
  return false
}

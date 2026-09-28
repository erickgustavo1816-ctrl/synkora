/**
 * AS CONVERSAS QUE UM CHAT DEIXOU PARA TRÁS (2026-09-28 — pedido do dono: "tem
 * conversa que não consigo ver o histórico todo").
 *
 * Um pane troca de conversa no /new, /reset, /clear, na troca de CLI e quando a
 * conta perde a identidade. Até aqui o registro (gui-sessions.json) guardava só
 * o id da conversa ATUAL, e cada troca jogava o anterior fora: o leitor da
 * conversa completa não tinha mais como chegar nele. Este módulo é a CORRENTE:
 * cada id que deixa de ser o atual entra aqui, com o CLI e o instante.
 *
 * Módulo PURO (sem disco, sem Electron): o registro grava, o IPC de histórico
 * lê, e as duas pontas passam pelas mesmas funções de validação — o documento
 * vem de userData e pode estar sujo (versão futura, edição à mão).
 */
import type { HistoryPaneConversation, HistoryProvider } from '../shared/commandPalette'

export type GuiPastSessionCli = 'claude' | 'codex'

export interface GuiPastSession {
  cli: GuiPastSessionCli
  /** Como o registro o guarda (o codex vem com `codex-thread:`). */
  sessionId: string
  /** ISO: quando ela deixou de ser a conversa do chat. */
  endedAt: string
}

/** Quantas conversas antigas um chat lembra. As mais NOVAS ficam. */
export const GUI_PAST_SESSIONS_CAP = 40

const GUI_PAST_SESSION_ID_MAX = 512
const CODEX_THREAD_PREFIX = 'codex-thread:'
// Id que vira nome de arquivo e chave de comparação: nada de controle.
const CONTROL_RE = /[\u0000-\u001f\u007f]/u

/**
 * O id como o DISCO o conhece. ESPELHO DECLARADO de `historySessionIdOf`
 * (historySearch.ts): este módulo não importa o leitor de disco para o registro
 * continuar compilando sozinho nas suítes node puras.
 */
export function guiDiskSessionId(sessionId: string): string {
  const clean = sessionId.trim()
  return clean.startsWith(CODEX_THREAD_PREFIX) ? clean.slice(CODEX_THREAD_PREFIX.length) : clean
}

function sessionKey(cli: GuiPastSessionCli, sessionId: string): string {
  return `${cli}:${guiDiskSessionId(sessionId).toLowerCase()}`
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validCli(value: unknown): value is GuiPastSessionCli {
  return value === 'claude' || value === 'codex'
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= GUI_PAST_SESSION_ID_MAX &&
    !CONTROL_RE.test(value) &&
    guiDiskSessionId(value).length > 0
  )
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function pastSessionOf(value: unknown): GuiPastSession | undefined {
  const entry = plainRecord(value)
  if (!entry || !validCli(entry['cli']) || !validSessionId(entry['sessionId'])) return undefined
  if (!validIso(entry['endedAt'])) return undefined
  return { cli: entry['cli'], sessionId: entry['sessionId'].trim(), endedAt: entry['endedAt'] }
}

/**
 * A corrente LIDA do documento: entradas sujas saem caladas (nunca derrubam o
 * chat), a repetida fica na posição da ÚLTIMA vez que saiu de cena, e o teto
 * guarda as mais novas. Ordem: da mais antiga para a mais nova.
 */
export function guiPastSessionsOf(value: unknown): GuiPastSession[] {
  if (!Array.isArray(value)) return []
  const byKey = new Map<string, GuiPastSession>()
  for (const raw of value) {
    const entry = pastSessionOf(raw)
    if (!entry) continue
    const key = sessionKey(entry.cli, entry.sessionId)
    // Reinserir move para o fim: a Map preserva a ordem de inserção.
    byKey.delete(key)
    byKey.set(key, entry)
  }
  return [...byKey.values()].slice(-GUI_PAST_SESSIONS_CAP)
}

/** O pedaço do record que a corrente usa (tipado aberto: vem do disco). */
export interface GuiPastSessionChain {
  pastSessions?: unknown
  pastSessionsSince?: unknown
}

/**
 * Desde quando ESTE pane registra toda troca de conversa. Antes disso (chats
 * zerados antes de 2026-09-28) a corrente não sabe nada — é a janela onde a
 * recuperação por pasta ainda faz sentido. Inválido = ausente.
 */
export function guiPastSessionsSinceOf(record: GuiPastSessionChain | undefined): string | undefined {
  return validIso(record?.pastSessionsSince) ? record.pastSessionsSince : undefined
}

export interface GuiSessionIdentity {
  cli: GuiPastSessionCli
  sessionId?: string
}

/**
 * Os campos da corrente para o PRÓXIMO record. `archived` é a conversa que
 * está saindo de cena (ignorada quando é a mesma que continua); `current` é a
 * que fica — ela nunca aparece como antiga, nem se o documento sujo a trouxer.
 */
export function guiPastSessionFields(
  previous: GuiPastSessionChain | undefined,
  archived: GuiSessionIdentity | undefined,
  current: GuiSessionIdentity | undefined,
  endedAt: string
): { pastSessions?: GuiPastSession[]; pastSessionsSince: string } {
  const chain = guiPastSessionsOf(previous?.pastSessions)
  const currentKey =
    current && validSessionId(current.sessionId) ? sessionKey(current.cli, current.sessionId) : undefined
  if (
    archived &&
    validCli(archived.cli) &&
    validSessionId(archived.sessionId) &&
    validIso(endedAt) &&
    sessionKey(archived.cli, archived.sessionId) !== currentKey
  ) {
    chain.push({ cli: archived.cli, sessionId: archived.sessionId.trim(), endedAt })
  }
  const pastSessions = guiPastSessionsOf(chain).filter(
    (entry) => sessionKey(entry.cli, entry.sessionId) !== currentKey
  )
  return {
    ...(pastSessions.length > 0 ? { pastSessions } : {}),
    pastSessionsSince: guiPastSessionsSinceOf(previous) ?? endedAt
  }
}

// ————— a lista que o leitor da conversa completa navega —————

/** Conversa achada na pasta da missão (historySessionReader), já sem as que
 *  pertencem a outro pane ou a um ajudante. */
export interface GuiRecoveredConversation {
  provider: HistoryProvider
  sessionId: string
  /** ISO da última escrita no disco. */
  updatedAt: string
}

export interface GuiPaneConversationSource {
  cli: GuiPastSessionCli
  sessionId?: string
  pastSessions?: unknown
}

function conversationKey(sessionId: string): string {
  return guiDiskSessionId(sessionId).toLowerCase()
}

/**
 * As conversas deste chat, da mais antiga para a mais nova, com a ATUAL por
 * último (contrato `HistoryPaneConversationsResult`). A corrente do chat vence
 * a recuperação quando as duas falam do mesmo id; a recuperada nunca repete a
 * atual. Os ids saem na forma do DISCO — é o que o leitor ecoa de volta.
 */
export function guiPaneConversations(
  record: GuiPaneConversationSource | undefined,
  recovered: readonly GuiRecoveredConversation[] = []
): HistoryPaneConversation[] {
  const seen = new Set<string>()
  const currentId =
    record && validCli(record.cli) && validSessionId(record.sessionId)
      ? guiDiskSessionId(record.sessionId)
      : undefined
  if (currentId) seen.add(conversationKey(currentId))

  const older: { entry: HistoryPaneConversation; at: number; order: number }[] = []
  for (const past of guiPastSessionsOf(record?.pastSessions)) {
    const sessionId = guiDiskSessionId(past.sessionId)
    const key = conversationKey(sessionId)
    if (seen.has(key)) continue
    seen.add(key)
    older.push({
      entry: { sessionId, provider: past.cli, current: false, source: 'chat', updatedAt: past.endedAt },
      at: Date.parse(past.endedAt),
      order: older.length
    })
  }
  for (const found of recovered) {
    if (!validCli(found.provider) || !validSessionId(found.sessionId) || !validIso(found.updatedAt))
      continue
    const sessionId = guiDiskSessionId(found.sessionId)
    const key = conversationKey(sessionId)
    if (seen.has(key)) continue
    seen.add(key)
    older.push({
      entry: {
        sessionId,
        provider: found.provider,
        current: false,
        source: 'recovered',
        updatedAt: found.updatedAt
      },
      at: Date.parse(found.updatedAt),
      order: older.length
    })
  }
  older.sort((a, b) => a.at - b.at || a.order - b.order)
  const conversations = older.map((item) => item.entry)
  if (record && currentId) {
    conversations.push({ sessionId: currentId, provider: record.cli, current: true, source: 'chat' })
  }
  return conversations
}

/** A conversa pedida pelo renderer, SE ela for deste chat. Undefined = recusa. */
export function guiPaneConversationFor(
  conversations: readonly HistoryPaneConversation[],
  sessionId: string
): HistoryPaneConversation | undefined {
  if (!validSessionId(sessionId)) return undefined
  const key = conversationKey(sessionId)
  return conversations.find((conversation) => conversationKey(conversation.sessionId) === key)
}

/**
 * A JANELA DA RECUPERAÇÃO de um chat de missão: do nascimento da missão até o
 * instante em que o pane passou a registrar toda troca (`pastSessionsSince`).
 * Depois disso, conversa que não está na corrente não é deste chat — é de um
 * ajudante ou de outro pane no mesmo worktree. Undefined = sem recuperação.
 */
export function guiRecoveryWindow(
  missionCreatedAt: unknown,
  record: GuiPastSessionChain | undefined
): { since: number; until?: number } | undefined {
  if (!validIso(missionCreatedAt)) return undefined
  const since = Date.parse(missionCreatedAt)
  const marker = guiPastSessionsSinceOf(record)
  if (marker === undefined) return { since }
  const until = Date.parse(marker)
  return until > since ? { since, until } : undefined
}

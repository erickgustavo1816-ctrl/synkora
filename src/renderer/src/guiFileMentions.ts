export interface FileMentionQuery {
  at: number
  cursor: number
  query: string
}

export interface FileMentionCompletion {
  text: string
  cursor: number
}

export interface FileMentionDismissal {
  at: number
  token: string
}

export interface GuiMentionPart {
  text: string
  mentioned: boolean
}

const FILE_MENTION_LIMIT = 40
const MENTION_BOUNDARY = /(?:^|[\s([{\u0027"`.,;:!?])@([^\s]*)$/u
const MENTION_TOKEN = /(?:^|[\s([{\u0027"`.,;:!?])@([^\s]+)/gu

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length
  return Math.max(0, Math.min(text.length, Math.floor(cursor)))
}

export function normalizeMentionPath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^@/u, '')
}

function mentionKey(value: string): string {
  return normalizeMentionPath(value).toLocaleLowerCase('en-US')
}

function isSafeRelativeMentionPath(value: string): boolean {
  const segments = value.split('/')
  return Boolean(
      value &&
      !value.startsWith('/') &&
      !/^[A-Za-z]:/u.test(value) &&
      segments.every((segment) => segment !== '..')
  )
}

/** Consulta do token `@...` sob o cursor; e-mails e tokens internos não abrem o menu. */
export function fileMentionQueryAt(text: string, cursor: number): FileMentionQuery | null {
  const safeCursor = clampCursor(text, cursor)
  const before = text.slice(0, safeCursor)
  const match = MENTION_BOUNDARY.exec(before)
  if (!match) return null
  const query = match[1]
  return {
    at: before.length - query.length - 1,
    cursor: safeCursor,
    query: normalizeMentionPath(query)
  }
}

function mentionTokenAt(text: string, at: number): string | null {
  const token = /^@[^\s]*/u.exec(text.slice(at))?.[0]
  return token ?? null
}

export function mentionDismissalAt(text: string, at: number): FileMentionDismissal | null {
  const token = mentionTokenAt(text, at)
  return token ? { at, token } : null
}

export function isFileMentionQueryDismissed(
  dismissal: FileMentionDismissal | null,
  text: string,
  query: FileMentionQuery | null
): boolean {
  return Boolean(
    dismissal &&
      query &&
      dismissal.at === query.at &&
      dismissal.token === mentionTokenAt(text, query.at)
  )
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

function segmentPrefix(path: string, query: string): boolean {
  return path.split('/').some((segment) => segment.startsWith(query))
}

/**
 * Busca por basename e por qualquer trecho de caminho, com prefixos antes de
 * matches soltos. O resultado é limitado para manter o menu navegável.
 */
export function filterFileMentions(
  files: readonly string[],
  query: string,
  limit = FILE_MENTION_LIMIT
): string[] {
  const normalizedQuery = mentionKey(query)
  const ranked: { path: string; rank: number }[] = []
  const seen = new Set<string>()

  for (const rawPath of files) {
    const path = normalizeMentionPath(rawPath)
    if (!isSafeRelativeMentionPath(path)) continue
    const key = mentionKey(path)
    if (!key || seen.has(key)) continue
    seen.add(key)

    const name = basename(key)
    const matches =
      normalizedQuery.length === 0
        ? 0
        : name === normalizedQuery
          ? 1
          : name.startsWith(normalizedQuery)
            ? 2
            : segmentPrefix(key, normalizedQuery)
              ? 3
              : key.startsWith(normalizedQuery)
                ? 4
                : name.includes(normalizedQuery)
                  ? 5
                  : key.includes(normalizedQuery)
                    ? 6
                    : -1
    if (matches >= 0) ranked.push({ path, rank: matches })
  }

  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : FILE_MENTION_LIMIT
  const boundedLimit = Math.max(1, Math.min(FILE_MENTION_LIMIT, requestedLimit))
  return ranked
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path, 'en-US'))
    .slice(0, boundedLimit)
    .map((entry) => entry.path)
}

/** Escolha de uma opção nunca envia: apenas substitui o token e deixa espaço. */
export function completeFileMention(
  text: string,
  cursor: number,
  path: string
): FileMentionCompletion | null {
  const query = fileMentionQueryAt(text, cursor)
  const normalizedPath = normalizeMentionPath(path)
  if (!query || !isSafeRelativeMentionPath(normalizedPath)) return null
  const before = text.slice(0, query.at)
  const after = text.slice(query.cursor)
  const inserted = `@${normalizedPath} `
  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + inserted.length
  }
}

export function mentionParts(text: string, files: readonly string[]): GuiMentionPart[] {
  const known = new Set(
    files
      .map(normalizeMentionPath)
      .filter(isSafeRelativeMentionPath)
      .map(mentionKey)
  )
  const parts: GuiMentionPart[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  MENTION_TOKEN.lastIndex = 0
  while ((match = MENTION_TOKEN.exec(text))) {
    const prefix = match[0].slice(0, match[0].length - match[1].length - 1)
    const tokenStart = match.index + prefix.length
    const token = `@${match[1]}`
    if (tokenStart > cursor) parts.push({ text: text.slice(cursor, tokenStart), mentioned: false })
    parts.push({ text: token, mentioned: known.has(mentionKey(match[1])) })
    cursor = tokenStart + token.length
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mentioned: false })
  if (parts.length === 0 && text.length > 0) parts.push({ text, mentioned: false })
  return parts
}

/** Escape adicional para qualquer uso textual do overlay fora do React. */
export function escapeMentionOverlayText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

export function renderMentionOverlayMarkup(
  text: string,
  files: readonly string[]
): string {
  return mentionParts(text, files)
    .map((part) =>
      part.mentioned
        ? `<span class="gui-mention-token">${escapeMentionOverlayText(part.text)}</span>`
        : escapeMentionOverlayText(part.text)
    )
    .join('')
}

/** Mantém o texto pintado no mesmo deslocamento do textarea com scroll interno.
 *  O box clipado (overflow: hidden) aceita scroll programático — o espelho é
 *  SÓ esse scroll. Transladar a própria caixa (o bug do paste de 2026-08-20)
 *  empurrava o overlay para cima do fio sempre que o textarea rolava por
 *  dentro, e o texto transparente do modo menções ficava invisível. */
export function syncInputOverlayScroll(
  input: Pick<HTMLTextAreaElement, 'scrollTop' | 'scrollLeft'>,
  overlay: Pick<HTMLDivElement, 'scrollTop' | 'scrollLeft'>
): void {
  overlay.scrollTop = input.scrollTop
  overlay.scrollLeft = input.scrollLeft
}

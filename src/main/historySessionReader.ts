/**
 * LEITOR DA CONVERSA COMPLETA DE UM PANE (R24.2/R24.3).
 *
 * A paleta chega ao transcript pelo caminho da BUSCA: um hit textual entrega o
 * arquivo e a fala exata. Este módulo é o caminho inverso — dado
 * `provider + sessionId` (o que o registro de panes guarda), ele acha o arquivo
 * no disco e devolve uma PÁGINA de falas por faixa de bytes.
 *
 * Duas propriedades tornam isso barato e sem índice em background:
 * - claude: tenta `<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl`;
 *   sem o cwd antigo, procura o mesmo id nas pastas de projetos da conta.
 * - o `cursor` de cada fala É O OFFSET DE BYTE da linha no arquivo, então
 *   "carregar mais antigas" é ler a faixa que TERMINA no menor cursor já
 *   carregado, e "mais novas" a que COMEÇA no maior.
 *
 * A fronteira de privacidade e os tetos são os MESMOS da busca: o par deste
 * módulo é `historySearch.ts`, de onde vêm o extrator fechado, a redação e o
 * orçamento. Aqui não existe leitura nova de disco fora dessas portas.
 */
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import {
  claudeSlug,
  codexDateDirectories,
  historySessionIdOf,
  historyTranscriptMessage,
  historyVisibleWindow,
  limitsOf,
  readJsonl,
  safeDirectoryEntries,
  safeProviderId,
  safeRegularFile,
  sessionIdFromCodexFilename,
  visibleHistoryMessages,
  type HistoryByteRange,
  type HistorySearchLimits,
  type HistorySessionFile,
  type LocalHistoryTranscriptResult,
  type ParsedMessage,
  type SearchBudget
} from './historySearch'
import type { HistoryProvider } from '../shared/commandPalette'

export interface HistorySessionLookup {
  provider: HistoryProvider
  /** Aceita o id como o pane o guarda (o codex vem com `codex-thread:`). */
  sessionId: string
  /** Config dirs candidatos, na ordem de preferência (o seat do pane primeiro). */
  configDirs: readonly string[]
  /** Pastas de trabalho candidatas — só o claude precisa (slug do caminho). */
  cwds?: readonly string[]
  limits?: Partial<HistorySearchLimits>
  signal?: AbortSignal
}

/** Faixa pedida pelo overlay: a página anterior TERMINA em `before`; a
 *  seguinte COMEÇA depois de `after`. Ambos são cursores de fala (byte). */
export interface HistoryPageWindow {
  before?: number
  after?: number
}

export interface HistoryPageOptions {
  /** Sem página explícita: 'first' (o que o anel perdeu) ou 'last'. */
  anchor?: 'first' | 'last'
  page?: HistoryPageWindow
  limits?: Partial<HistorySearchLimits>
  signal?: AbortSignal
}

/**
 * Releituras de uma MESMA página. Uma faixa de bytes pode não conter fala
 * nenhuma (rollout do codex com megabytes de ferramenta): em vez de devolver
 * página vazia — beco sem saída —, o leitor anda mais um pouco na mesma
 * direção, com teto duro. Nada disso roda em background: é o clique do dono.
 */
const HISTORY_PAGE_MAX_READS = 4
const CODEX_DIR_ENTRY_CAP = 2_048

function readerBudget(limits: HistorySearchLimits, signal?: AbortSignal): SearchBudget {
  return {
    limits: {
      ...limits,
      maxFiles: HISTORY_PAGE_MAX_READS,
      maxBytes: Math.max(limits.maxBytes, limits.maxBytesPerFile * HISTORY_PAGE_MAX_READS)
    },
    deadline: Date.now() + limits.maxMs,
    ...(signal ? { signal } : {}),
    scannedFiles: 0,
    scannedBytes: 0,
    softTruncated: false
  }
}

/**
 * O arquivo desta conversa, ou `undefined` quando ela não deixou transcript
 * em nenhuma das contas oferecidas (quem chama recusa com receita — nunca
 * inventa arquivo). Empate entre contas: a cópia mais nova, que é a que o
 * transplante de seat deixou para trás.
 */
export async function locateHistorySessionFile(
  input: HistorySessionLookup
): Promise<HistorySessionFile | undefined> {
  const sessionId = safeProviderId(historySessionIdOf(input.sessionId ?? ''))
  if (!sessionId) return undefined
  const limits = limitsOf(input.limits)
  const budget = readerBudget(limits, input.signal)
  const found: { session: HistorySessionFile; mtime: number }[] = []
  const seen = new Set<string>()
  const considerFile = async (file: string, configDir: string): Promise<void> => {
    const stat = await safeRegularFile(file)
    if (stat) {
      found.push({
        session: { file, configDir, provider: input.provider, sessionId },
        mtime: stat.mtime
      })
    }
  }

  for (const configDir of input.configDirs) {
    if (!configDir || seen.has(configDir)) continue
    seen.add(configDir)

    if (input.provider === 'claude') {
      // Caminho DIRETO: o nome do arquivo é o próprio sessionId.
      for (const cwd of input.cwds ?? []) {
        if (!cwd) continue
        const file = join(configDir, 'projects', claudeSlug(cwd), `${sessionId}.jsonl`)
        await considerFile(file, configDir)
      }
      continue
    }

    // Codex: o rollout mora em `sessions/AAAA/MM/DD/` e carrega o uuid no
    // NOME. A varredura por data já é limitada pelo orçamento da busca.
    for (const dir of await codexDateDirectories(configDir, budget)) {
      for (const entry of await safeDirectoryEntries(dir, budget, CODEX_DIR_ENTRY_CAP)) {
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl'))
          continue
        if (sessionIdFromCodexFilename(entry.name)?.toLowerCase() !== sessionId.toLowerCase())
          continue
        const file = join(dir, entry.name)
        await considerFile(file, configDir)
      }
    }
  }

  // A integração apaga mission.worktree, mas preserva o transcript no seat.
  if (input.provider === 'claude' && found.length === 0) {
    for (const configDir of seen) {
      const projects = join(configDir, 'projects')
      for (const entry of await safeDirectoryEntries(projects, budget)) {
        if (input.signal?.aborted || Date.now() >= budget.deadline) break
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        await considerFile(join(projects, entry.name, `${sessionId}.jsonl`), configDir)
      }
    }
  }

  return found.sort((a, b) => b.mtime - a.mtime)[0]?.session
}

function initialRange(options: HistoryPageOptions): HistoryByteRange {
  const before = options.page?.before
  if (before !== undefined) return { to: before, prefer: 'tail' }
  const after = options.page?.after
  // `after` é o início da linha já carregada: entrar UM byte depois faz o
  // leitor pular exatamente aquela linha em vez de repeti-la.
  if (after !== undefined) return { from: after + 1, prefer: 'head' }
  return options.anchor === 'last' ? { prefer: 'tail' } : { from: 0, prefer: 'head' }
}

/**
 * Uma PÁGINA da conversa. Sem `page` e sem `anchor`, a página é a DO COMEÇO —
 * que é exatamente o pedaço que o anel do pane perdeu.
 */
export async function loadLocalHistorySessionPage(
  session: HistorySessionFile,
  options: HistoryPageOptions = {}
): Promise<LocalHistoryTranscriptResult> {
  const limits = limitsOf(options.limits)
  const budget = readerBudget(limits, options.signal)
  // Página que TERMINA num cursor (ou ancorada no fim) cresce para trás: o
  // corte por teto tem de comer o começo dela, nunca o fim prometido.
  const backward = options.page?.before !== undefined || (!options.page && options.anchor === 'last')

  let range = initialRange(options)
  let messages: ParsedMessage[] = []
  let start = 0
  let end = 0
  let size = 0
  let truncated = false

  for (let attempt = 0; attempt < HISTORY_PAGE_MAX_READS; attempt += 1) {
    const read = await readJsonl(session.file, budget, true, range)
    if (!read || options.signal?.aborted) {
      return { ok: false, error: 'não consegui carregar essa conversa antiga agora' }
    }
    start = read.start
    end = read.end
    size = read.size
    truncated = read.truncated
    messages = visibleHistoryMessages(session.provider, read.lines, limits)
    if (messages.length > 0) break
    // Faixa sem fala nenhuma (só ferramenta/metadados): anda mais uma janela na
    // MESMA direção, a partir de uma FRONTEIRA DE LINHA (o cursor da primeira/
    // última linha lida), para nenhuma linha cair no vão entre as janelas.
    if (backward) {
      const first = read.lines[0]?.cursor ?? read.start
      if (first <= 0) break
      range = { to: first, prefer: 'tail' }
    } else {
      const last = read.lines.at(-1)?.cursor
      const next = last === undefined ? read.end : last + 1
      if (next >= read.size) break
      range = { from: next, prefer: 'head' }
    }
  }

  const windowStart = backward
    ? Math.max(0, messages.length - limits.maxTranscriptMessages)
    : 0
  const window = messages.slice(windowStart, windowStart + limits.maxTranscriptMessages)
  const kept = historyVisibleWindow(window, limits, backward)
  const visible = kept.map(historyTranscriptMessage)
  const textCut = kept.length < window.length

  const hasMoreBefore = start > 0 || windowStart > 0 || (backward && textCut)
  const hasMoreAfter =
    end < size || windowStart + window.length < messages.length || (!backward && textCut)
  // A âncora é a BORDA da página no sentido da leitura: quem sobe fica no que
  // acabou de chegar, quem desce continua de onde parou.
  const anchor = backward ? visible.at(-1) : visible[0]

  return {
    ok: true,
    provider: session.provider,
    sessionId: session.sessionId,
    messages: visible,
    ...(anchor ? { targetMessageId: anchor.id, targetCursor: anchor.cursor } : {}),
    truncated: truncated || hasMoreBefore || hasMoreAfter,
    hasMoreBefore,
    hasMoreAfter
  }
}

// ————— RECUPERAÇÃO POR PASTA (2026-09-28) —————
//
// Chats zerados ANTES de o registro guardar a corrente de conversas
// (`pastSessions`) perderam o id das conversas antigas. O que sobra é o disco:
// o CLI grava cada conversa pela pasta de trabalho, e a missão tem um worktree
// só dela. Esta listagem é o melhor esforço SEM prova de autoria — quem chama
// (history.ts) tira dela tudo que se sabe ser de outro pane ou de um ajudante,
// e a UI a rotula como recuperada. Nunca lança: falha = lista vazia.

export interface HistoryWorkspaceSessionLimits {
  /** Arquivos avaliados (stat + cabeçalho do codex). */
  maxFiles: number
  /** Bytes lidos de cabeçalhos `session_meta`. */
  maxBytes: number
  maxMs: number
  /** Conversas devolvidas (as mais NOVAS ficam). */
  maxResults: number
  /** Teto da PRIMEIRA linha de um rollout (o session_meta real tem ~22 KB). */
  maxMetaBytes: number
}

export const HISTORY_WORKSPACE_SESSION_LIMITS: Readonly<HistoryWorkspaceSessionLimits> = {
  maxFiles: 400,
  maxBytes: 16 * 1024 * 1024,
  maxMs: 1_200,
  maxResults: 60,
  maxMetaBytes: 256 * 1024
}

export interface HistoryWorkspaceSessionQuery {
  provider: HistoryProvider
  /** A pasta de trabalho (o worktree da missão). */
  cwd: string
  /** Epoch ms: só arquivos escritos a partir daqui (mtime >= since). */
  since: number
  /** Epoch ms, exclusivo: só arquivos escritos antes daqui. */
  until?: number
  configDirs: readonly string[]
  limits?: Partial<HistoryWorkspaceSessionLimits>
  signal?: AbortSignal
}

export interface HistoryWorkspaceSession {
  provider: HistoryProvider
  /** Na forma do DISCO (claude: nome do arquivo; codex: o uuid). */
  sessionId: string
  file: string
  configDir: string
  mtime: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const WORKSPACE_DIR_ENTRY_CAP = 2_048

function workspaceLimitsOf(
  input?: Partial<HistoryWorkspaceSessionLimits>
): HistoryWorkspaceSessionLimits {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback
  const base = HISTORY_WORKSPACE_SESSION_LIMITS
  return {
    maxFiles: positive(input?.maxFiles, base.maxFiles),
    maxBytes: positive(input?.maxBytes, base.maxBytes),
    maxMs: positive(input?.maxMs, base.maxMs),
    maxResults: positive(input?.maxResults, base.maxResults),
    maxMetaBytes: positive(input?.maxMetaBytes, base.maxMetaBytes)
  }
}

/** Caminho comparável: separador único, sem barra final; no Windows a caixa
 *  não distingue pastas (o session_meta grava o cwd como o processo o viu). */
export function historyComparablePath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+/gu, '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function exhausted(budget: SearchBudget): boolean {
  return (
    Boolean(budget.signal?.aborted) ||
    Date.now() >= budget.deadline ||
    budget.scannedFiles >= budget.limits.maxFiles ||
    budget.scannedBytes >= budget.limits.maxBytes
  )
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * O CABEÇALHO de um rollout do codex: só a primeira linha, com teto de bytes.
 * Mesmos sinais estruturais de `codexMeta` (historySearch.ts), que não é
 * exportado — thread de subagente nativo não é conversa de chat nenhum.
 */
async function codexRolloutHeader(
  file: string,
  budget: SearchBudget,
  maxMetaBytes: number
): Promise<{ cwd: string; subagent: boolean } | undefined> {
  const stat = await safeRegularFile(file)
  if (!stat) return undefined
  const length = Math.min(stat.size, maxMetaBytes, budget.limits.maxBytes - budget.scannedBytes)
  if (length <= 0) return undefined
  let handle: import('fs/promises').FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const data = Buffer.alloc(length)
    const { bytesRead } = await handle.read(data, 0, length, 0)
    budget.scannedBytes += bytesRead
    const view = data.subarray(0, bytesRead)
    const newline = view.indexOf(0x0a)
    // Cabeçalho maior que o teto é irreconhecível: falha fechado.
    if (newline < 0 && bytesRead < stat.size) return undefined
    const line = view.subarray(0, newline < 0 ? view.length : newline).toString('utf8')
    const entry = plainObject(JSON.parse(line) as unknown)
    const payload = plainObject(entry?.['payload'])
    if (entry?.['type'] !== 'session_meta' || !payload) return undefined
    const cwd = payload['cwd']
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4096) return undefined
    const source = plainObject(payload['source'])
    const threadSource =
      typeof payload['thread_source'] === 'string' ? payload['thread_source'].toLowerCase() : ''
    const subagent =
      threadSource === 'subagent' ||
      Boolean(source && Object.prototype.hasOwnProperty.call(source, 'subagent')) ||
      Boolean(
        payload['parent_thread_id'] &&
          payload['id'] &&
          payload['session_id'] &&
          payload['id'] !== payload['session_id']
      )
    return { cwd, subagent }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** `.../sessions/AAAA/MM/DD` → meia-noite UTC daquele dia (undefined = não é). */
function codexDirectoryDay(dir: string): number | undefined {
  const match = dir.replace(/[\\/]+/gu, '/').match(/\/(\d{4})\/(\d{2})\/(\d{2})$/u)
  if (!match) return undefined
  const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(day) ? day : undefined
}

/**
 * As conversas de UM CLI cuja pasta de trabalho é `cwd` e que foram escritas
 * dentro da janela [since, until). Cópias do mesmo id em contas diferentes
 * (transplante de seat) viram uma só: a mais nova.
 */
export async function listWorkspaceHistorySessions(
  query: HistoryWorkspaceSessionQuery
): Promise<HistoryWorkspaceSession[]> {
  try {
    if (!query.cwd?.trim() || !Number.isFinite(query.since)) return []
    const limits = workspaceLimitsOf(query.limits)
    const budget: SearchBudget = {
      limits: { ...limitsOf(), maxFiles: limits.maxFiles, maxBytes: limits.maxBytes },
      deadline: Date.now() + limits.maxMs,
      ...(query.signal ? { signal: query.signal } : {}),
      scannedFiles: 0,
      scannedBytes: 0,
      softTruncated: false
    }
    const until = query.until !== undefined && Number.isFinite(query.until) ? query.until : undefined
    const inWindow = (mtime: number): boolean =>
      mtime >= query.since && (until === undefined || mtime < until)
    const found = new Map<string, HistoryWorkspaceSession>()
    const consider = (session: HistoryWorkspaceSession): void => {
      const key = session.sessionId.toLowerCase()
      const previous = found.get(key)
      if (!previous || previous.mtime < session.mtime) found.set(key, session)
    }
    const target = historyComparablePath(query.cwd)
    const seen = new Set<string>()

    for (const configDir of query.configDirs) {
      if (!configDir?.trim() || exhausted(budget)) continue
      const dirKey = historyComparablePath(configDir)
      if (seen.has(dirKey)) continue
      seen.add(dirKey)

      if (query.provider === 'claude') {
        // O caminho do claude É o cwd: `<configDir>/projects/<slug(cwd)>/`.
        const dir = join(configDir, 'projects', claudeSlug(query.cwd))
        for (const entry of await safeDirectoryEntries(dir, budget, WORKSPACE_DIR_ENTRY_CAP)) {
          if (exhausted(budget)) break
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
          const sessionId = safeProviderId(entry.name.slice(0, -'.jsonl'.length))
          if (!sessionId) continue
          budget.scannedFiles += 1
          const file = join(dir, entry.name)
          const stat = await safeRegularFile(file)
          if (!stat || !inWindow(stat.mtime)) continue
          consider({ provider: 'claude', sessionId, file, configDir, mtime: stat.mtime })
        }
        continue
      }

      // Codex: o rollout mora em `sessions/AAAA/MM/DD/`. O dia da pasta é o
      // LOCAL de quem gravou — folga de um dia de cada lado cobre o fuso, e o
      // mtime decide o resto.
      for (const dir of await codexDateDirectories(configDir, budget)) {
        if (exhausted(budget)) break
        const day = codexDirectoryDay(dir)
        if (day === undefined || day + 2 * DAY_MS < query.since) continue
        if (until !== undefined && day - DAY_MS >= until) continue
        for (const entry of await safeDirectoryEntries(dir, budget, CODEX_DIR_ENTRY_CAP)) {
          if (exhausted(budget)) break
          if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl'))
            continue
          const sessionId = safeProviderId(sessionIdFromCodexFilename(entry.name))
          if (!sessionId) continue
          budget.scannedFiles += 1
          const file = join(dir, entry.name)
          const stat = await safeRegularFile(file)
          if (!stat || !inWindow(stat.mtime)) continue
          const header = await codexRolloutHeader(file, budget, limits.maxMetaBytes)
          if (!header || header.subagent || historyComparablePath(header.cwd) !== target) continue
          consider({ provider: 'codex', sessionId, file, configDir, mtime: stat.mtime })
        }
      }
    }

    return [...found.values()]
      .sort((a, b) => a.mtime - b.mtime || a.sessionId.localeCompare(b.sessionId))
      .slice(-limits.maxResults)
  } catch {
    return []
  }
}

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
import { join } from 'path'
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

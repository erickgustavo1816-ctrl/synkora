import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

// Telemetria REAL dos panes TUI: os próprios CLIs gravam a sessão em JSONL
// (claude: <configDir>/projects/<slug-do-cwd>/<sessionId>.jsonl · codex:
// <CODEX_HOME>/sessions/AAAA/MM/DD/rollout-*.jsonl). Este watcher faz leitura
// incremental desses arquivos — nada estimado, nada mocado.

export interface PaneStats {
  model?: string
  /** entrada total processada pela sessão, incluindo leitura/criação de cache */
  inputTokens: number
  outputTokens: number
  /** parte da entrada que não veio do cache */
  freshInputTokens?: number
  /** parte da entrada atendida pelo cache */
  cacheReadInputTokens?: number
  /** parte da entrada gravada no cache (Claude; Codex não expõe este campo) */
  cacheWriteInputTokens?: number
  contextTokens: number | null
  contextWindow: number | null
  costUsd?: number
}

export interface StatsWatchOpts {
  cli: 'claude' | 'codex'
  configDir?: string
  cwd: string
  /** modelo com que o pane foi SPAWNADO (--model, ex. "opus[1m]") — o JSONL
   *  grava o id sem o marcador [1m] (sondado), então o teto vem daqui. */
  modelHint?: string
  /** sessionId/threadId com que o pane foi RESUMADO (--resume/resume nos
   *  cliArgs) — adoção EXATA do arquivo, imune à disputa entre panes que
   *  dividem o mesmo cwd (claude: <hint>.jsonl · codex: nome contém o hint). */
  sessionHint?: string
  onStats: (stats: PaneStats) => void
  /** ID retomavel real do CLI (claude: uuid do arquivo · codex: payload.id,
   *  que tambem e o UUID no nome do rollout; payload.session_id pode apontar
   *  para a thread raiz de um fork/subagente e NAO serve para resume). */
  onSession?: (sessionId: string) => void
}

export type StatsWatchHandle = number

interface Target extends StatsWatchOpts {
  paneId: string
  generation: StatsWatchHandle
  spawnedAt: number
  file?: string
  fileBirth?: number
  sessionId?: string
  offset: number
  partial: string
  /** contribuição final conhecida por message.id. O Claude regrava a mesma
   * mensagem enquanto tools/texto chegam; aplicar deltas evita tanto duplicar
   * quanto perder uma atualização tardia de usage. */
  claudeUsageByMessage: Map<string, ClaudeTokenContribution>
  /** janela REAL vinda do banner do TUI (pty onCtxWindow) — fonte final */
  windowHint?: number
  /** /clear (claude) ou /new|/fork (codex) digitado NESTE pane — só então este
   *  target pode migrar para um arquivo de sessão estritamente mais novo
   *  (sem o flag, um /clear do pane vizinho roubava o arquivo dele). */
  expectingNew?: boolean
  stats: PaneStats
  dirty: boolean
}

interface ClaudeTokenContribution {
  input: number
  output: number
  fresh: number
  cacheRead: number
  cacheWrite: number
}

interface CodexSessionMeta {
  id?: string
  session_id?: string
  cwd?: string
  parent_thread_id?: string | null
  forked_from_id?: string | null
  thread_source?: string
  source?: unknown
}

const CLAUDE_DEFAULT_WINDOW = 200_000
const ONE_M_RE = /\[1m\]|-1m$/i

function claudeSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

function localDateDir(root: string, d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return join(root, String(d.getFullYear()), mm, dd)
}

export class SessionStatsWatcher {
  private targets = new Map<string, Target>()
  private timer: NodeJS.Timeout | null = null
  private nextGeneration = 1
  /** arquivo de sessão → paneId dono: com N panes no MESMO cwd (helpers!),
   *  cada JSONL pertence a UM pane — sem isso todos adotavam o mais novo. */
  private claims = new Map<string, string>()

  watch(paneId: string, opts: StatsWatchOpts): StatsWatchHandle {
    // Um PTY novo pode reutilizar o paneId. Solta atomicamente o claim antigo;
    // o handle de geracao impede que um onExit atrasado remova o watcher novo.
    const previous = this.targets.get(paneId)
    if (previous) this.releaseClaims(paneId)
    const generation = this.nextGeneration++
    this.targets.set(paneId, {
      ...opts,
      paneId,
      generation,
      spawnedAt: Date.now(),
      offset: 0,
      partial: '',
      claudeUsageByMessage: new Map(),
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        freshInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        contextTokens: null,
        contextWindow: null
      },
      dirty: false
    })
    if (!this.timer) this.timer = setInterval(() => this.tick(), 2000)
    return generation
  }

  unwatch(paneId: string, generation?: StatsWatchHandle): void {
    const target = this.targets.get(paneId)
    if (!target || (generation != null && target.generation !== generation)) return
    // Flush final SOMENTE do arquivo ja adotado. Rodar locate aqui poderia
    // roubar o rollout de outro pane no mesmo cwd durante o encerramento.
    try {
      // Depois de /clear|/new|/fork o arquivo atual e deliberadamente velho;
      // nao deixe um ultimo token_count dele repovoar os contadores zerados.
      if (target.file && !target.expectingNew) this.consume(target, true)
      this.emitIfDirty(target)
    } catch {
      // telemetria nunca pode impedir o fechamento do pane
    }
    this.targets.delete(paneId)
    this.releaseClaims(paneId)
    if (this.targets.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Reenvia o snapshot ao renderer sem substituir o watcher. TerminalPane
   *  pode remontar enquanto o PTY continua vivo; o store local acabou de ser
   *  zerado, mas a telemetria e os claims do processo devem sobreviver. */
  replay(paneId: string): void {
    const target = this.targets.get(paneId)
    if (!target) return
    try {
      if (target.file && !target.expectingNew) this.consume(target)
      target.onStats({ ...target.stats })
      target.dirty = false
    } catch {
      target.dirty = true
      // renderer destruido/arquivo em troca: o timer tenta novamente
    }
  }

  /** O pane digitou /clear (claude) ou /new|/fork (codex): a PRÓXIMA sessão nova
   *  deste cwd pertence a ele — habilita a troca de arquivo só para este
   *  target (chamado pelo onCommand do pty). */
  noteReset(paneId: string): void {
    const t = this.targets.get(paneId)
    if (!t) return
    t.expectingNew = true
    // o hint do resume morreu junto com a conversa antiga
    t.sessionHint = undefined
    t.sessionId = undefined
    t.claudeUsageByMessage.clear()
    this.resetUsage(t)
    // O arquivo novo so nasce na primeira mensagem. O chrome nao deve exibir
    // os numeros da conversa anterior durante essa espera.
    try {
      t.onStats({ ...t.stats })
      t.dirty = false
    } catch {
      t.dirty = true
    }
  }

  /** Teto REAL vindo do banner do TUI (pty.ts onCtxWindow) — vale mais que
   *  qualquer heurística e sobrevive a /model e /clear. */
  setWindowHint(paneId: string, tokens: number): void {
    const t = this.targets.get(paneId)
    if (!t || !tokens) return
    t.windowHint = tokens
    if (t.stats.contextWindow !== tokens) {
      t.stats.contextWindow = tokens
      t.dirty = true
    }
  }

  private tick(): void {
    for (const t of this.targets.values()) {
      try {
        this.locate(t)
        if (t.file && !t.expectingNew) this.consume(t)
        this.emitIfDirty(t)
      } catch {
        // watcher é best-effort — nunca derruba nada
      }
    }
  }

  private emitIfDirty(t: Target): void {
    if (!t.dirty) return
    t.dirty = false
    t.onStats({ ...t.stats })
  }

  private releaseClaims(paneId: string): void {
    for (const [file, owner] of this.claims) {
      if (owner === paneId) this.claims.delete(file)
    }
  }

  private resetUsage(t: Target): void {
    t.stats.inputTokens = 0
    t.stats.outputTokens = 0
    t.stats.freshInputTokens = 0
    t.stats.cacheReadInputTokens = 0
    t.stats.cacheWriteInputTokens = t.cli === 'claude' ? 0 : undefined
    t.stats.contextTokens = null
    t.stats.costUsd = undefined
    t.dirty = true
  }

  /** Adota um arquivo de sessão (inicial, hint de resume ou novo pós-/clear)
   *  e o CLAIMA para este pane. */
  private adopt(t: Target, file: string, birth: number, sessionId?: string): void {
    const isSwitch = t.file != null
    if (t.file) this.claims.delete(t.file)
    this.claims.set(file, t.paneId)
    t.file = file
    t.fileBirth = birth
    t.offset = 0
    t.partial = ''
    t.claudeUsageByMessage.clear()
    t.expectingNew = false
    if (isSwitch) this.resetUsage(t)
    t.sessionId = sessionId
    if (sessionId) t.onSession?.(sessionId)
  }

  private claimedByOther(t: Target, file: string): boolean {
    const owner = this.claims.get(file)
    return owner != null && owner !== t.paneId
  }

  /** Registro vivo do claude (<configDir>/sessions/<pid>.json): entrada com o
   *  MESMO cwd cujo processo nasceu LOGO DEPOIS do spawn deste pane = a sessão
   *  dele. Duas guardas OBRIGATÓRIAS (regressão real: o maestro da Luma
   *  resumiu a conversa de um agente livre): (1) startedAt tem de ser ≥ spawn
   *  do pane − 15s — processo mais velho é de OUTRO pane; (2) o PID tem de
   *  estar VIVO — pty morto na marra deixa o <pid>.json órfão para trás e a
   *  entrada envenenava o resume persistido. Ignora sessões já claimadas. */
  private resolveClaudeRegistry(t: Target, cfg: string): string | null {
    const regDir = join(cfg, 'sessions')
    if (!existsSync(regDir)) return null
    const slugDir = join(cfg, 'projects', claudeSlug(t.cwd))
    let best: { sid: string; delta: number } | null = null
    for (const name of readdirSync(regDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const obj = JSON.parse(readFileSync(join(regDir, name), 'utf-8')) as {
          pid?: number
          sessionId?: string
          cwd?: string
          startedAt?: number
        }
        if (!obj.sessionId || !obj.cwd || normPath(obj.cwd) !== normPath(t.cwd)) continue
        const started = obj.startedAt ?? 0
        // o claude do pane sobe segundos APÓS o create do PTY — nunca antes
        if (started < t.spawnedAt - 15_000 || started > t.spawnedAt + 120_000) continue
        if (obj.pid && !pidAlive(obj.pid)) continue // entrada órfã
        if (this.claimedByOther(t, join(slugDir, `${obj.sessionId}.jsonl`))) continue
        const delta = Math.abs(started - t.spawnedAt)
        if (!best || delta < best.delta) best = { sid: obj.sessionId, delta }
      } catch {
        // json parcial/corrompido — próximo tick
      }
    }
    return best?.sid ?? null
  }

  /** Acha o JSONL da sessão deste pane. Ordem de verdade:
   *  1) sessionHint (pane resumado): adoção EXATA — claude <hint>.jsonl,
   *     codex nome contém o hint. Imune a birth/mtime e a vizinhos.
   *  2) pane SEM arquivo: entre os candidatos NÃO claimados por outro pane e
   *     recentes (birth OU mtime ≥ spawn − 15s — resume appenda em arquivo de
   *     birth velho), vence o de birth MAIS PRÓXIMO do spawn — com N panes no
   *     mesmo cwd cada um pega o seu, não o mais novo de todos.
   *  3) pane COM arquivo: só migra para um estritamente mais novo quando ELE
   *     digitou /clear|/new|/fork (expectingNew via noteReset) — antes disso o
   *     /clear de um pane roubava o arquivo novo para todos os vizinhos. */
  private locate(t: Target): void {
    const freshness = (st: { birthtimeMs: number; mtimeMs: number }): number =>
      Math.max(st.birthtimeMs || 0, st.mtimeMs)
    if (t.cli === 'claude') {
      const cfg = t.configDir ?? join(homedir(), '.claude')
      const dir = join(cfg, 'projects', claudeSlug(t.cwd))
      if (!existsSync(dir)) return
      if (!t.file && t.sessionHint) {
        const hintFile = join(dir, `${t.sessionHint}.jsonl`)
        if (existsSync(hintFile) && !this.claimedByOther(t, hintFile)) {
          const st = statSync(hintFile)
          this.adopt(t, hintFile, st.birthtimeMs || st.mtimeMs, t.sessionHint)
          return
        }
      }
      // Registro VIVO do CLI (sondado no 2.1.218): <configDir>/sessions/
      // <pid>.json carrega {sessionId, cwd, startedAt} desde o BOOT do TUI —
      // resolve a sessão EXATA deste pane antes da 1ª mensagem (o transcript
      // só nasce quando o usuário fala) e desambigua N panes no mesmo cwd.
      if (!t.file) {
        const sid = this.resolveClaudeRegistry(t, cfg)
        if (sid) {
          const expected = join(dir, `${sid}.jsonl`)
          // reserva o arquivo JÁ (mesmo antes de nascer) — vizinho não rouba.
          // onSession SÓ quando o transcript EXISTE: persistir o resume antes
          // da 1ª mensagem gravava sessionId sem arquivo e o próximo spawn
          // morria com "No conversation found" (regressão real).
          this.claims.set(expected, t.paneId)
          if (existsSync(expected)) {
            const st = statSync(expected)
            this.adopt(t, expected, st.birthtimeMs || st.mtimeMs, sid)
          }
          return
        }
      }
      if (t.file && !t.expectingNew) return
      let best: { file: string; birth: number; score: number } | null = null
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const full = join(dir, name)
        if (this.claimedByOther(t, full)) continue
        const st = statSync(full)
        const birth = st.birthtimeMs || st.mtimeMs
        if (t.file) {
          // pós-/clear: só estritamente mais novo que o atual
          if (birth <= (t.fileBirth ?? 0)) continue
          if (!best || birth > best.birth) best = { file: full, birth, score: 0 }
        } else {
          if (freshness(st) < t.spawnedAt - 15_000) continue
          const score = Math.abs(birth - t.spawnedAt)
          if (!best || score < best.score) best = { file: full, birth, score }
        }
      }
      if (best && best.file !== t.file) {
        this.adopt(t, best.file, best.birth, basename(best.file, '.jsonl'))
      }
      return
    }
    // codex: rollouts por data local. Descoberta normal continua limitada aos
    // ultimos 7 dias; resume explicito procura o ID exato no historico inteiro.
    const root = join(t.configDir ?? join(homedir(), '.codex'), 'sessions')
    if (!existsSync(root)) return
    if (!t.file && t.sessionHint) {
      const hinted = findCodexRollout(root, t.sessionHint)
      // Hint e uma promessa EXATA: se nao existe (ou ja pertence a outro pane),
      // nunca cair no fallback por cwd e adotar uma conversa vizinha.
      if (!hinted || this.claimedByOther(t, hinted)) return
      const meta = readCodexSessionMeta(hinted)
      const resumeId = meta?.id ?? codexIdFromFilename(basename(hinted))
      if (!meta || resumeId !== t.sessionHint) return
      const st = statSync(hinted)
      this.adopt(t, hinted, st.birthtimeMs || st.mtimeMs, resumeId)
      return
    }
    if (t.file && !t.expectingNew) return
    const now = new Date()
    const dirs = Array.from({ length: 7 }, (_, i) =>
      localDateDir(root, new Date(now.getTime() - i * 86_400_000))
    )
    let best: { file: string; birth: number; score: number; sessionId?: string } | null = null
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
        const full = join(dir, name)
        if (this.claimedByOther(t, full)) continue
        const st = statSync(full)
        const birth = st.birthtimeMs || st.mtimeMs
        if (t.file) {
          if (birth <= (t.fileBirth ?? 0)) continue
        } else if (freshness(st) < t.spawnedAt - 15_000) continue
        const score = t.file ? -birth : Math.abs(birth - t.spawnedAt)
        if (best && score >= best.score) continue
        const meta = readCodexSessionMeta(full)
        if (!meta) continue
        // Rollouts internos de subagentes compartilham cwd e nascem logo apos
        // o root. Eles nunca podem vencer a descoberta de um pane interativo.
        if (isCodexSubagent(meta)) continue
        if (!meta.cwd || normPath(meta.cwd) !== normPath(t.cwd)) continue
        const resumeId = meta.id ?? codexIdFromFilename(name)
        if (!resumeId) continue
        best = { file: full, birth, score, sessionId: resumeId }
      }
    }
    if (best && best.file !== t.file) this.adopt(t, best.file, best.birth, best.sessionId)
  }

  /** Le so o que apareceu desde a ultima leitura. No flush final tenta tambem
   *  a ultima linha sem LF; JSON truncado continua sendo ignorado com seguranca. */
  private consume(t: Target, final = false): void {
    if (!t.file) return
    const size = statSync(t.file).size
    let text = t.partial
    if (size > t.offset) {
      const fd = openSync(t.file, 'r')
      let chunk: Buffer
      try {
        chunk = Buffer.alloc(size - t.offset)
        readSync(fd, chunk, 0, chunk.length, t.offset)
      } finally {
        closeSync(fd)
      }
      t.offset = size
      text += chunk.toString('utf-8')
    } else if (!final) {
      return
    }
    if (!text) return
    const lines = text.split('\n')
    const trailing = lines.pop() ?? ''
    if (final) {
      if (trailing.trim()) lines.push(trailing)
      t.partial = ''
    } else {
      t.partial = trailing
    }
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        if (t.cli === 'claude') this.parseClaude(t, JSON.parse(line))
        else this.parseCodex(t, JSON.parse(line))
      } catch {
        // linha corrompida/parcial — ignora
      }
    }
  }

  private parseClaude(t: Target, obj: unknown): void {
    const entry = obj as {
      type?: string
      message?: {
        id?: string
        model?: string
        usage?: {
          input_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          output_tokens?: number
        }
      }
    }
    if (entry.type !== 'assistant' || !entry.message?.usage) return
    // Avisos LOCAIS do CLI (limite de sessão, sem crédito, "not logged in", erro
    // de API) vão para o MESMO transcript como assistant model:"<synthetic>",
    // COM o objeto usage e todos os contadores em ZERO — o guard acima não
    // filtra. Sem isto o contexto caía de 72% (vermelho) para 0% (verde) na hora
    // em que o usuário mais precisa dele, e ficava assim (a entrada sintética é
    // a última do arquivo); o badge de modelo também virava "<SYNTHETIC>".
    if (entry.message.model === '<synthetic>') return
    const u = entry.message.usage
    const fresh = Math.max(0, u.input_tokens ?? 0)
    const cacheWrite = Math.max(0, u.cache_creation_input_tokens ?? 0)
    const cacheRead = Math.max(0, u.cache_read_input_tokens ?? 0)
    const inTok = fresh + cacheWrite + cacheRead
    const outTok = Math.max(0, u.output_tokens ?? 0)
    // Um turno com texto+tools repete a MESMA message em várias linhas. A
    // usage normalmente é idêntica, mas pode crescer numa gravação posterior;
    // guardar a contribuição por id e aplicar só o delta cobre os dois casos.
    if (entry.message.id) {
      const next: ClaudeTokenContribution = {
        input: inTok,
        output: outTok,
        fresh,
        cacheRead,
        cacheWrite
      }
      const prev = t.claudeUsageByMessage.get(entry.message.id)
      t.stats.inputTokens += next.input - (prev?.input ?? 0)
      t.stats.outputTokens += next.output - (prev?.output ?? 0)
      t.stats.freshInputTokens =
        (t.stats.freshInputTokens ?? 0) + next.fresh - (prev?.fresh ?? 0)
      t.stats.cacheReadInputTokens =
        (t.stats.cacheReadInputTokens ?? 0) + next.cacheRead - (prev?.cacheRead ?? 0)
      t.stats.cacheWriteInputTokens =
        (t.stats.cacheWriteInputTokens ?? 0) + next.cacheWrite - (prev?.cacheWrite ?? 0)
      t.claudeUsageByMessage.set(entry.message.id, next)
    }
    t.stats.contextTokens = inTok + outTok
    if (entry.message.model) t.stats.model = entry.message.model
    // Teto: banner (windowHint) > marcador [1m] no id do JSONL ou no modelo do
    // spawn (o JSONL grava "claude-opus-4-8" SEM o [1m] — sondado) > família
    // SONNET 5 = 1M de série (correção do usuário, 2026-07-28: o id não
    // carrega [1m] e o badge mostrava 200k) > 200k.
    const oneM = (m?: string): boolean => !!m && (ONE_M_RE.test(m) || /sonnet/i.test(m))
    t.stats.contextWindow =
      t.windowHint ??
      (oneM(entry.message.model) || oneM(t.modelHint) ? 1_000_000 : CLAUDE_DEFAULT_WINDOW)
    t.dirty = true
  }

  private parseCodex(t: Target, obj: unknown): void {
    const entry = obj as {
      type?: string
      payload?: {
        type?: string
        model?: string
        info?: {
          total_token_usage?: {
            input_tokens?: number
            cached_input_tokens?: number
            output_tokens?: number
            total_tokens?: number
          }
          /** tokens do ÚLTIMO turno = contexto VIVO (total_ é cumulativo) */
          last_token_usage?: { total_tokens?: number }
          model_context_window?: number | null
        } | null
      }
    }
    if (entry.type === 'turn_context' && entry.payload?.model) {
      t.stats.model = entry.payload.model
      t.dirty = true
      return
    }
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count' || !entry.payload.info)
      return
    const info = entry.payload.info
    const tot = info.total_token_usage
    if (tot) {
      // ↓in do codex: cached_input_tokens é SUBCONJUNTO de input_tokens —
      // conferido em rollout real (input 13362 + output 10 == total 13372, com
      // cached 9984 dentro do input). Somar os dois (regra que só vale para o
      // claude, onde cache_* são campos separados) inflava o badge ~1,75×, e a
      // persona manda escolher a conta com mais folga por esse número.
      t.stats.inputTokens = tot.input_tokens ?? 0
      t.stats.outputTokens = tot.output_tokens ?? 0
      const cached = Math.max(0, tot.cached_input_tokens ?? 0)
      t.stats.cacheReadInputTokens = cached
      t.stats.freshInputTokens = Math.max(0, t.stats.inputTokens - cached)
      t.stats.cacheWriteInputTokens = undefined
    }
    // CONTEXTO ≠ acumulado da sessão: total_token_usage soma TODOS os turnos
    // (rollout real de 27 turnos: 2.631.002 contra janela de 258.400 → barra
    // cravada em 1018%, vermelha, pedindo /compact quando o contexto real era
    // 139.563 = 54%). O contexto vivo é o last_token_usage. Sem o campo
    // (versão antiga do codex) MANTÉM o valor anterior — nunca voltar ao
    // cumulativo.
    const cur = info.last_token_usage?.total_tokens
    if (cur != null) t.stats.contextTokens = cur
    if (info.model_context_window) t.stats.contextWindow = info.model_context_window
    t.dirty = true
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readCodexSessionMeta(file: string): CodexSessionMeta | null {
  const line = readFirstLine(file)
  if (!line) return null
  try {
    const obj = JSON.parse(line) as { type?: string; payload?: CodexSessionMeta }
    return obj.type === 'session_meta' && obj.payload ? obj.payload : null
  } catch {
    // primeira linha ainda parcial/corrompida — tenta no proximo tick
    return null
  }
}

function codexIdFromFilename(name: string): string | undefined {
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1]
}

function isCodexSubagent(meta: CodexSessionMeta): boolean {
  if (meta.thread_source?.toLowerCase() === 'subagent') return true
  if (
    meta.source &&
    typeof meta.source === 'object' &&
    Object.prototype.hasOwnProperty.call(meta.source, 'subagent')
  ) {
    return true
  }
  // Fallback para versoes que nao gravavam a origem textual. Nao basta ter
  // parent_thread_id: /fork do usuario tambem pode ter pai. Nos subagentes
  // observados, session_id continua sendo o root enquanto payload.id e o filho.
  return Boolean(
    meta.parent_thread_id && meta.id && meta.session_id && meta.session_id !== meta.id
  )
}

/** Pastas AAAA/MM/DD existentes, mais novas primeiro. Usada apenas para um
 *  resume explicito; a descoberta normal continua no recorte barato de 7 dias. */
function codexDateDirs(root: string): string[] {
  const out: string[] = []
  try {
    for (const year of readdirSync(root, { withFileTypes: true })) {
      if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue
      const yearDir = join(root, year.name)
      for (const month of readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue
        const monthDir = join(yearDir, month.name)
        for (const day of readdirSync(monthDir, { withFileTypes: true })) {
          if (day.isDirectory() && /^\d{2}$/.test(day.name)) out.push(join(monthDir, day.name))
        }
      }
    }
  } catch {
    return out
  }
  return out.sort((a, b) => b.localeCompare(a))
}

function findCodexRollout(root: string, resumeId: string): string | null {
  for (const dir of codexDateDirs(root)) {
    try {
      for (const name of readdirSync(dir)) {
        if (
          name.startsWith('rollout-') &&
          name.endsWith('.jsonl') &&
          name.includes(resumeId)
        ) {
          return join(dir, name)
        }
      }
    } catch {
      // pasta sumiu entre a listagem e a leitura
    }
  }
  return null
}

/** Metadata do Codex hoje passa de 40 KiB porque inclui instrucoes e schemas.
 *  Le incrementalmente ate LF, com teto defensivo contra arquivo corrompido. */
function readFirstLine(file: string): string | null {
  const READ_CHUNK = 64 * 1024
  const MAX_FIRST_LINE = 1024 * 1024
  const fd = openSync(file, 'r')
  try {
    const parts: Buffer[] = []
    let position = 0
    while (position < MAX_FIRST_LINE) {
      const buf = Buffer.alloc(Math.min(READ_CHUNK, MAX_FIRST_LINE - position))
      const n = readSync(fd, buf, 0, buf.length, position)
      if (n === 0) {
        return parts.length ? Buffer.concat(parts).toString('utf-8') : null
      }
      const read = buf.subarray(0, n)
      const nl = read.indexOf(0x0a)
      parts.push(nl >= 0 ? read.subarray(0, nl) : read)
      if (nl >= 0) return Buffer.concat(parts).toString('utf-8')
      position += n
    }
    return null
  } finally {
    closeSync(fd)
  }
}

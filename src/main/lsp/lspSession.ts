import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { LspError, LspRpc, LSP_REQUEST_TIMEOUT_MS } from './lspRpc'

/**
 * UMA sessão de servidor de linguagem viva — o processo, o handshake, os
 * documentos abertos e as quatro perguntas que o chat sabe fazer.
 *
 * As regras que valem para TODA a borda pública desta classe:
 *
 * 1. **Posições são 1-BASED aqui dentro e 0-based no fio.** O protocolo LSP
 *    conta linha e caractere a partir de ZERO; humano, editor e recibo contam a
 *    partir de UM. A conversão mora nesta borda (`toWire`/`fromWire`) e em
 *    lugar nenhum mais — quem consome esta API nunca soma nem subtrai 1.
 * 2. **Caminho é confinado à raiz.** Qualquer alvo fora da raiz da sessão é
 *    RECUSA com receita (a mensagem diz qual raiz vale). É guarda de
 *    AUTORIDADE: a sessão de uma missão não lê o worktree da outra.
 * 3. **Arquivo inexistente é RESPOSTA, não exceção.** Em `diagnostics` ele vira
 *    um problema na lista; nas consultas pontuais vira `{ ok: false, reason }`.
 *    Vazio mudo seria beco sem saída — e beco sem saída é bug.
 * 4. **Sem watch de disco (onda 1).** Cada chamada RELÊ o arquivo do disco e
 *    sincroniza o documento com o servidor. Simples e honesto: o que o
 *    diagnóstico enxerga é o que está gravado neste instante.
 *
 * O tsserver publica diagnóstico em RAJADAS (a passada sintática vem quase
 * instantânea e quase sempre vazia; a semântica vem depois). Por isso
 * `diagnostics` espera a poeira baixar: quieto `settleMs` desde a última
 * rajada, com teto duro em `ceilingMs` para o servidor que nunca cala.
 */

/** Quieto por este tanto desde a última rajada = a poeira baixou. */
export const LSP_DIAGNOSTICS_SETTLE_MS = 450

/** Teto duro da espera por diagnóstico: servidor que nunca cala não trava o
 *  chat, entrega o que já publicou. */
export const LSP_DIAGNOSTICS_CEILING_MS = 15_000

export type LspSeverity = 'error' | 'warning' | 'information' | 'hint'

/** Um problema. `file` é relativo à raiz da sessão, com `/` — é o que o recibo
 *  do chat imprime (`arquivo:linha:coluna`). `line`/`column` são 1-BASED. */
export interface LspDiagnostic {
  file: string
  line: number
  column: number
  severity: LspSeverity
  code?: string
  message: string
}

/** Um ponto no código. `file` é relativo à raiz quando o alvo mora dentro dela
 *  (o caso normal) e ABSOLUTO quando não — definição em `lib.d.ts` fora do
 *  worktree é resposta legítima, e mentir a raiz seria pior que o caminho longo.
 *  Todas as quatro coordenadas são 1-BASED. */
export interface LspLocation {
  file: string
  line: number
  column: number
  endLine: number
  endColumn: number
}

export interface LspHover extends LspLocation {
  /** O texto do servidor, já achatado (markdown vira texto corrido). */
  text: string
}

/**
 * Resposta de consulta pontual: ou o alvo, ou o MOTIVO em voz alta. `ok: true`
 * com valor vazio significa "olhei e não há nada aqui"; `ok: false` traz a
 * frase que o chat mostra ao agente, sempre com a receita.
 */
export type LspAnswer<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Como o servidor nasce. `env` é MESCLADO sobre o ambiente do app; `cwd` cai
 *  na raiz quando ausente. `initializationOptions` viaja no handshake — é por
 *  ele que o `typescript` do WORKSPACE vence o do app. */
export interface LspLaunch {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  initializationOptions?: Record<string, unknown>
}

export interface LspSessionOpts {
  /** A raiz da sessão: o worktree da missão ou a raiz do projeto. */
  root: string
  launch: LspLaunch
  /** Janela de silêncio dos diagnósticos (default `LSP_DIAGNOSTICS_SETTLE_MS`). */
  settleMs?: number
  /** Teto duro da espera (default `LSP_DIAGNOSTICS_CEILING_MS`). */
  ceilingMs?: number
  /** Teto por pedido (default `LSP_REQUEST_TIMEOUT_MS`). */
  requestTimeoutMs?: number
  onProtocolError?: (message: string) => void
  /** O servidor morreu. O gerente usa isto para tirar a sessão do cache — a
   *  próxima chamada sobe um servidor novo. */
  onExit?: (info: { code: number | null; signal: string | null; stderr: string }) => void
}

export interface LspDiagnosticsOpts {
  settleMs?: number
  ceilingMs?: number
}

interface WirePosition {
  line: number
  character: number
}

interface WireRange {
  start: WirePosition
  end: WirePosition
}

interface WireDiagnostic {
  range: WireRange
  severity?: number
  code?: string | number
  message: string
}

interface OpenDocument {
  uri: string
  version: number
}

/** Uma consulta pontual já checada e sincronizada: o alvo dentro da raiz e a
 *  posição JÁ convertida para o fio (0-based). */
interface PreparedQuery {
  target: { abs: string; rel: string; key: string; uri: string }
  position: WirePosition
}

const SEVERITY_BY_CODE: Record<number, LspSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint'
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.json': 'json'
}

/** Quanto de stderr do servidor fica guardado para a mensagem de morte. */
const STDERR_TAIL_CHARS = 2000

export class LspSession {
  readonly root: string
  private readonly launch: LspLaunch
  private readonly settleMs: number
  private readonly ceilingMs: number
  private readonly requestTimeoutMs: number
  private readonly onProtocolError: (message: string) => void
  private readonly onExit?: LspSessionOpts['onExit']
  private readonly child: ChildProcess
  private readonly rpc: LspRpc
  private readonly open = new Map<string, OpenDocument>()
  private readonly published = new Map<string, LspDiagnostic[]>()
  private readonly settleWatchers = new Set<(key: string) => void>()
  private readonly deathWatchers = new Set<() => void>()
  private readonly handshakeDone: Promise<void>
  private stderrTail = ''
  private death: string | null = null
  private disposed = false

  constructor(opts: LspSessionOpts) {
    this.root = resolve(opts.root)
    this.launch = opts.launch
    this.settleMs = opts.settleMs ?? LSP_DIAGNOSTICS_SETTLE_MS
    this.ceilingMs = opts.ceilingMs ?? LSP_DIAGNOSTICS_CEILING_MS
    this.requestTimeoutMs = opts.requestTimeoutMs ?? LSP_REQUEST_TIMEOUT_MS
    this.onProtocolError = opts.onProtocolError ?? ((): void => {})
    this.onExit = opts.onExit

    this.child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd ?? this.root,
      env: { ...process.env, ...this.launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdin = this.child.stdin
    const stdout = this.child.stdout
    if (!stdin || !stdout) {
      throw new LspError(
        `o servidor de linguagem nasceu sem canos de stdio (${this.launch.command}) — problema do ambiente, não do projeto`
      )
    }
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf-8')}`.slice(-STDERR_TAIL_CHARS)
    })
    // ENOENT/EACCES chegam por 'error' (assíncrono): a morte precoce vira a
    // MESMA frase da morte no meio, com a receita, em vez de exceção solta.
    this.child.on('error', (e: Error) => this.mourn(null, null, e.message))
    this.child.on('exit', (code, signal) => this.mourn(code, signal))
    this.rpc = new LspRpc({
      streams: { stdin, stdout },
      requestTimeoutMs: this.requestTimeoutMs,
      onProtocolError: this.onProtocolError
    })
    this.rpc.onNotification('textDocument/publishDiagnostics', (params) =>
      this.collect(params)
    )
    // Pedidos que o servidor faz ao cliente. Respondemos "nada" de propósito:
    // as capabilities do handshake NÃO prometem configuração dinâmica nem
    // progresso — mas servidor que espera resposta trava, então respondemos.
    this.rpc.onRequest('client/registerCapability', () => null)
    this.rpc.onRequest('client/unregisterCapability', () => null)
    this.rpc.onRequest('window/workDoneProgress/create', () => null)
    this.rpc.onRequest('workspace/configuration', (params) => {
      const items = (params as { items?: unknown[] } | undefined)?.items
      return Array.isArray(items) ? items.map(() => null) : []
    })
    this.handshakeDone = this.handshake()
  }

  /** O handshake terminou (ou falhou nomeando a receita). O gerente espera por
   *  isto antes de entregar a sessão — servidor que não subiu tem que falar. */
  ready(): Promise<void> {
    return this.handshakeDone
  }

  get alive(): boolean {
    return !this.disposed && this.death === null
  }

  /**
   * Os problemas dos arquivos pedidos, já em 1-BASED e ordenados por
   * arquivo/linha/coluna. Arquivo inexistente entra na lista como problema
   * (com a receita), nunca como exceção; caminho fora da raiz é recusa.
   */
  async diagnostics(files: string[], opts?: LspDiagnosticsOpts): Promise<LspDiagnostic[]> {
    await this.ensureUsable()
    if (files.length === 0) return []
    const answers: LspDiagnostic[] = []
    const tracked = new Set<string>()
    const targets: { abs: string; rel: string; key: string; text: string }[] = []
    for (const file of files) {
      const located = this.locate(file)
      const content = this.readOrExplain(located)
      if (typeof content !== 'string') {
        answers.push(content)
        continue
      }
      // O texto lido AQUI é o que viaja para o servidor: reler no envio
      // deixaria uma fresta (arquivo apagado entre a checagem e o envio) que
      // viraria exceção solta no lugar de resposta.
      targets.push({ ...located, text: content })
      tracked.add(located.key)
      this.published.delete(located.key)
    }
    if (targets.length === 0) return answers

    // A escuta arma ANTES do didOpen/didChange: rajada que chega entre a
    // sincronização e a espera seria rajada perdida, e a espera inteira
    // pagaria o teto duro à toa.
    const settled = this.settle(
      tracked,
      opts?.settleMs ?? this.settleMs,
      opts?.ceilingMs ?? this.ceilingMs
    )
    for (const target of targets) this.syncDocument(target, target.text)
    await settled
    if (this.death) throw new LspError(this.death)

    for (const target of targets) answers.push(...(this.published.get(target.key) ?? []))
    return answers.sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column ||
        a.message.localeCompare(b.message)
    )
  }

  /** Onde o símbolo desta posição (1-BASED) foi definido. Lista vazia com
   *  `ok: true` = olhei e não há definição. */
  async definition(file: string, line: number, column: number): Promise<LspAnswer<LspLocation[]>> {
    return this.locations('textDocument/definition', file, line, column)
  }

  /** Quem usa o símbolo desta posição (1-BASED), a declaração incluída. */
  async references(file: string, line: number, column: number): Promise<LspAnswer<LspLocation[]>> {
    return this.locations('textDocument/references', file, line, column, {
      context: { includeDeclaration: true }
    })
  }

  /** O que o servidor sabe sobre esta posição (1-BASED). `value: null` = nada
   *  aqui. */
  async hover(file: string, line: number, column: number): Promise<LspAnswer<LspHover | null>> {
    const prepared = await this.prepare(file, line, column)
    if (!prepared.ok) return prepared
    const { target, position } = prepared.value
    const result = await this.rpc.request<unknown>('textDocument/hover', {
      textDocument: { uri: target.uri },
      position
    })
    const text = flattenHoverContents((result as { contents?: unknown } | null)?.contents)
    if (!text) return { ok: true, value: null }
    const range = (result as { range?: WireRange } | null)?.range
    const start = range?.start ?? position
    const end = range?.end ?? position
    return {
      ok: true,
      value: {
        file: this.displayPath(target.abs),
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        text
      }
    }
  }

  /** Encerra a sessão: pede tchau pelo protocolo (o servidor derruba os
   *  próprios filhos — o tsserver é filho do typescript-language-server) e só
   *  então mata o processo, se ele insistir em ficar. */
  dispose(reason?: string): void {
    if (this.disposed) return
    this.disposed = true
    if (this.death === null) {
      // `shutdown` é pedido, `exit` é notificação: mandamos os dois e não
      // esperamos resposta — quem espera no quit trava o fechamento do app.
      void this.rpc.request('shutdown', undefined, { timeoutMs: 1000 }).catch(() => undefined)
      this.rpc.notify('exit')
    }
    this.rpc.dispose(
      reason ??
        'a sessão do servidor de linguagem foi encerrada — chame de novo: a próxima chamada sobe um servidor novo'
    )
    const grace = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
    }, 1500)
    if (typeof grace.unref === 'function') grace.unref()
    this.wakeDeathWatchers()
  }

  // ————— internos —————

  private async handshake(): Promise<void> {
    await this.rpc.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'synkora' },
        rootUri: pathToFileURL(this.root).href,
        rootPath: this.root,
        workspaceFolders: null,
        initializationOptions: this.launch.initializationOptions,
        // Capabilities HONESTAS: só o que este motor de fato trata. Prometer
        // registro dinâmico ou configuração de workspace faria o servidor
        // mandar pedidos que a onda 1 não sabe responder de verdade.
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false
            },
            publishDiagnostics: { relatedInformation: false, versionSupport: false },
            definition: { dynamicRegistration: false, linkSupport: false },
            references: { dynamicRegistration: false },
            hover: { dynamicRegistration: false, contentFormat: ['plaintext', 'markdown'] }
          },
          workspace: {
            workspaceFolders: false,
            configuration: false,
            didChangeConfiguration: { dynamicRegistration: false }
          },
          window: { workDoneProgress: false }
        }
      },
      { timeoutMs: this.requestTimeoutMs }
    )
    this.rpc.notify('initialized', {})
  }

  /** Handshake pronto e servidor vivo, ou a frase com a receita. */
  private async ensureUsable(): Promise<void> {
    if (this.death) throw new LspError(this.death)
    if (this.disposed) {
      throw new LspError(
        `a sessão de ${this.root} foi encerrada — chame de novo: a próxima chamada sobe um servidor novo`
      )
    }
    await this.handshakeDone
    if (this.death) throw new LspError(this.death)
  }

  private async prepare(
    file: string,
    line: number,
    column: number
  ): Promise<LspAnswer<PreparedQuery>> {
    await this.ensureUsable()
    const located = this.locate(file)
    const content = this.readOrExplain(located)
    if (typeof content !== 'string') return { ok: false, reason: content.message }
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
      throw new LspError(
        `linha ${line} e coluna ${column} não valem: as posições desta API são 1-based (a primeira linha é 1, a primeira coluna é 1)`
      )
    }
    const uri = this.syncDocument(located, content)
    return {
      ok: true,
      value: { target: { ...located, uri }, position: { line: line - 1, character: column - 1 } }
    }
  }

  private async locations(
    method: string,
    file: string,
    line: number,
    column: number,
    extra?: Record<string, unknown>
  ): Promise<LspAnswer<LspLocation[]>> {
    const prepared = await this.prepare(file, line, column)
    if (!prepared.ok) return prepared
    const { target, position } = prepared.value
    const result = await this.rpc.request<unknown>(method, {
      textDocument: { uri: target.uri },
      position,
      ...extra
    })
    return { ok: true, value: this.toLocations(result) }
  }

  /** `Location`, `Location[]` e `LocationLink[]` — os três formatos que o
   *  protocolo permite na mesma resposta. */
  private toLocations(result: unknown): LspLocation[] {
    const raw =
      result === null || result === undefined ? [] : Array.isArray(result) ? result : [result]
    const locations: LspLocation[] = []
    for (const entry of raw) {
      const item = entry as {
        uri?: string
        range?: WireRange
        targetUri?: string
        targetSelectionRange?: WireRange
        targetRange?: WireRange
      }
      const uri = item.uri ?? item.targetUri
      const range = item.range ?? item.targetSelectionRange ?? item.targetRange
      if (typeof uri !== 'string' || !range) continue
      locations.push({
        file: this.displayPath(uriToPath(uri)),
        line: range.start.line + 1,
        column: range.start.character + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.character + 1
      })
    }
    return locations
  }

  /** Guarda de AUTORIDADE: o alvo tem que morar na raiz da sessão. A recusa
   *  nomeia a raiz que vale — o agente precisa saber por onde tentar. */
  private locate(file: string): { abs: string; rel: string; key: string } {
    const abs = isAbsolute(file) ? resolve(file) : resolve(this.root, file)
    const rel = relative(this.root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new LspError(
        `"${file}" está fora da raiz desta sessão — informe um caminho de ARQUIVO relativo a ${this.root}`
      )
    }
    return { abs, rel: toPosix(rel), key: pathKey(abs) }
  }

  /** O conteúdo do disco, ou o problema já redigido (com receita). Onda 1 relê
   *  a cada chamada: sem watch, sem cache, sem mentira sobre o que está gravado. */
  private readOrExplain(located: { abs: string; rel: string }): string | LspDiagnostic {
    try {
      if (!statSync(located.abs).isFile()) {
        return this.problem(located.rel, `"${located.rel}" é uma pasta — aponte um ARQUIVO dentro de ${this.root}`)
      }
      return readFileSync(located.abs, 'utf-8')
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return this.problem(
          located.rel,
          `"${located.rel}" não existe em ${this.root} — confira o caminho relativo à raiz e chame de novo`
        )
      }
      return this.problem(
        located.rel,
        `não foi possível ler "${located.rel}": ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  private problem(rel: string, message: string): LspDiagnostic {
    return { file: toPosix(rel), line: 1, column: 1, severity: 'error', code: 'arquivo', message }
  }

  /** Sincroniza o documento com o servidor a partir do DISCO. Primeira vez é
   *  `didOpen`; da segunda em diante é `didChange` com o texto inteiro — abrir
   *  duas vezes a mesma uri é comportamento indefinido no protocolo. */
  private syncDocument(located: { abs: string; key: string }, text: string): string {
    const already = this.open.get(located.key)
    if (already) {
      already.version += 1
      this.rpc.notify('textDocument/didChange', {
        textDocument: { uri: already.uri, version: already.version },
        contentChanges: [{ text }]
      })
      return already.uri
    }
    const uri = pathToFileURL(located.abs).href
    this.open.set(located.key, { uri, version: 1 })
    this.rpc.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: LANGUAGE_BY_EXTENSION[extname(located.abs).toLowerCase()] ?? 'plaintext',
        version: 1,
        text
      }
    })
    return uri
  }

  private collect(params: unknown): void {
    const payload = params as { uri?: string; diagnostics?: WireDiagnostic[] } | undefined
    if (!payload || typeof payload.uri !== 'string') return
    const abs = uriToPath(payload.uri)
    const key = pathKey(abs)
    const file = this.displayPath(abs)
    this.published.set(
      key,
      (payload.diagnostics ?? []).map((diagnostic) => {
        const entry: LspDiagnostic = {
          file,
          // O fio conta de ZERO; a saída desta API conta de UM.
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          severity: SEVERITY_BY_CODE[diagnostic.severity ?? 1] ?? 'error',
          message: diagnostic.message
        }
        if (diagnostic.code !== undefined && diagnostic.code !== null) {
          entry.code = String(diagnostic.code)
        }
        return entry
      })
    )
    for (const watcher of [...this.settleWatchers]) watcher(key)
  }

  /** A poeira baixou: `settleMs` de silêncio desde a última rajada, teto duro
   *  em `ceilingMs`, e morte do servidor acorda a espera na hora. */
  private settle(keys: Set<string>, settleMs: number, ceilingMs: number): Promise<void> {
    return new Promise<void>((done) => {
      let quiet: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (quiet) clearTimeout(quiet)
        clearTimeout(ceiling)
        this.settleWatchers.delete(watcher)
        this.deathWatchers.delete(finish)
        done()
      }
      const arm = (): void => {
        if (quiet) clearTimeout(quiet)
        quiet = setTimeout(finish, settleMs)
      }
      const watcher = (key: string): void => {
        if (keys.has(key)) arm()
      }
      const ceiling = setTimeout(finish, ceilingMs)
      this.settleWatchers.add(watcher)
      this.deathWatchers.add(finish)
      // Servidor que não publica NADA também assenta: a janela conta desde já.
      arm()
    })
  }

  private mourn(code: number | null, signal: string | null, error?: string): void {
    if (this.death !== null) return
    const stderr = this.stderrTail.trim()
    const cause = error
      ? `não foi possível executar "${this.launch.command}": ${error}`
      : `encerrou (código ${code ?? '—'}${signal ? `, sinal ${signal}` : ''})`
    this.death =
      `o servidor de linguagem de ${this.root} ${cause} — chame de novo: a próxima chamada sobe um servidor novo` +
      (stderr ? `; ele disse: ${stderr.slice(-400)}` : '')
    this.rpc.dispose(this.death)
    this.wakeDeathWatchers()
    this.onExit?.({ code, signal, stderr })
  }

  private wakeDeathWatchers(): void {
    for (const watcher of [...this.deathWatchers]) watcher()
    this.deathWatchers.clear()
  }

  /** Relativo à raiz (com `/`) quando o alvo mora dentro dela; absoluto quando
   *  não — `lib.d.ts` fora do worktree é resposta legítima. */
  private displayPath(abs: string): string {
    const rel = relative(this.root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return toPosix(abs)
    return toPosix(rel)
  }
}

/** `MarkedString | MarkedString[] | MarkupContent` — os três formatos de hover
 *  que o protocolo permite viram UMA linha de texto. */
function flattenHoverContents(contents: unknown): string {
  if (contents === null || contents === undefined) return ''
  if (typeof contents === 'string') return contents.trim()
  if (Array.isArray(contents)) {
    return contents
      .map((entry) => flattenHoverContents(entry))
      .filter((entry) => entry.length > 0)
      .join('\n')
      .trim()
  }
  const value = (contents as { value?: unknown }).value
  return typeof value === 'string' ? value.trim() : ''
}

/** O servidor devolve a uri que quiser (o tsserver minúscula a letra do drive):
 *  a chave de comparação é o caminho normalizado, nunca o texto da uri. */
function pathKey(abs: string): string {
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

function uriToPath(uri: string): string {
  try {
    return resolve(fileURLToPath(uri))
  } catch {
    return uri
  }
}

function toPosix(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}

// Re-exportado para que as ondas seguintes importem o erro do mesmo lugar que
// a sessão — a receita e quem a lança moram no mesmo import.
export { LspError }

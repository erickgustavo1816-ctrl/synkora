import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { LspError } from './lspRpc'
import { LspSession, type LspLaunch } from './lspSession'

/**
 * O cache de sessões por RAIZ. Uma raiz = um worktree de missão (ou a raiz do
 * projeto) = um servidor de linguagem vivo. Abre sob demanda, derruba por
 * ociosidade e some quando o worktree some.
 *
 * O LANÇADOR é injetável de propósito: em produção `tsServerLaunch(root)`
 * resolve o `typescript-language-server` do app e o executa com o próprio
 * Electron em modo node; nos testes entra um servidor FALSO em node puro que
 * fala o protocolo de verdade — o motor nunca depende de binário externo para
 * ser provado.
 *
 * Nada aqui resolve pacote no import: pacote que falta é RESPOSTA falada (com
 * o comando que instala), nunca um app que não sobe.
 */

/** Sessão parada por este tanto morre. Servidor de linguagem custa memória e
 *  um tsserver por worktree aberto é caro — mas subir de novo custa segundos,
 *  então a ociosidade é generosa. */
export const LSP_IDLE_MS = 5 * 60_000

/** O relógio do gerente. Injetável para que o teste da ociosidade prove a
 *  derrubada em milissegundos, sem esperar cinco minutos de verdade. */
export interface LspClock {
  now(): number
  /** Agenda uma varredura; devolve o cancelador. */
  schedule(fn: () => void, ms: number): () => void
}

const realClock: LspClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    // Varredura de ociosidade nunca segura o fechamento do app.
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }
}

export interface LspManagerOpts {
  /** Como nasce o servidor daquela raiz. Produção: `(root) => tsServerLaunch(root)`. */
  launcherFor: (root: string) => LspLaunch
  idleMs?: number
  clock?: LspClock
  settleMs?: number
  ceilingMs?: number
  requestTimeoutMs?: number
  onProtocolError?: (message: string) => void
}

interface CacheEntry {
  root: string
  session: LspSession
  lastUsedAt: number
}

export class LspManager {
  private readonly opts: LspManagerOpts
  private readonly clock: LspClock
  private readonly idleMs: number
  private readonly sessions = new Map<string, CacheEntry>()
  /** Aberturas em voo: duas chamadas na mesma raiz sobem UM servidor, não dois. */
  private readonly opening = new Map<string, Promise<LspSession>>()
  private cancelSweep: (() => void) | null = null
  private disposed = false

  constructor(opts: LspManagerOpts) {
    this.opts = opts
    this.clock = opts.clock ?? realClock
    this.idleMs = opts.idleMs ?? LSP_IDLE_MS
  }

  /** A sessão daquela raiz, abrindo sob demanda. Falha de abertura NÃO fica no
   *  cache: a próxima chamada tenta de novo (e o pacote pode ter sido instalado
   *  no meio). */
  async sessionFor(root: string): Promise<LspSession> {
    if (this.disposed) {
      throw new LspError(
        'o motor de linguagem foi encerrado com o app — reabra o chat para levantar um servidor novo'
      )
    }
    const absolute = resolve(root)
    const key = rootKey(absolute)
    const cached = this.sessions.get(key)
    if (cached) {
      if (cached.session.alive) {
        cached.lastUsedAt = this.clock.now()
        return cached.session
      }
      // Morreu na janela entre o handshake e o cache (o `onExit` não tinha
      // ninguém para esquecer): some agora para o `openRoots` não mentir.
      this.sessions.delete(key)
    }
    const inFlight = this.opening.get(key)
    if (inFlight) return inFlight

    const opening = this.open(absolute, key).finally(() => this.opening.delete(key))
    this.opening.set(key, opening)
    return opening
  }

  /** O worktree sumiu (missão integrada, pasta removida): a sessão daquela raiz
   *  morre agora, sem esperar a ociosidade. */
  invalidate(root: string): void {
    const key = rootKey(resolve(root))
    const entry = this.sessions.get(key)
    if (!entry) return
    this.sessions.delete(key)
    entry.session.dispose(
      `a raiz ${entry.root} saiu do ar — reabra o chat da missão para levantar um servidor novo`
    )
    this.stopSweepIfIdle()
  }

  /** O app está fechando. */
  disposeAll(): void {
    this.disposed = true
    for (const entry of this.sessions.values()) entry.session.dispose('o Synkora está fechando')
    this.sessions.clear()
    this.cancelSweep?.()
    this.cancelSweep = null
  }

  /** As raízes com servidor vivo — instrumentação e teste de ociosidade. */
  openRoots(): string[] {
    return [...this.sessions.values()].map((entry) => entry.root)
  }

  // ————— internos —————

  private async open(root: string, key: string): Promise<LspSession> {
    // O lançador fala ANTES de qualquer processo nascer: pacote que falta vira
    // erro com a receita, não um servidor fantasma no cache.
    const launch = this.opts.launcherFor(root)
    const session = new LspSession({
      root,
      launch,
      settleMs: this.opts.settleMs,
      ceilingMs: this.opts.ceilingMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      onProtocolError: this.opts.onProtocolError,
      onExit: () => this.forget(key, session)
    })
    try {
      await session.ready()
    } catch (e) {
      session.dispose()
      throw e
    }
    if (this.disposed) {
      session.dispose('o Synkora está fechando')
      throw new LspError(
        'o motor de linguagem foi encerrado com o app — reabra o chat para levantar um servidor novo'
      )
    }
    this.sessions.set(key, { root, session, lastUsedAt: this.clock.now() })
    this.armSweep()
    return session
  }

  /** O servidor morreu sozinho: sai do cache para que a próxima chamada suba
   *  um novo (é isto que faz "chame de novo" ser verdade). */
  private forget(key: string, session: LspSession): void {
    const entry = this.sessions.get(key)
    if (entry?.session !== session) return
    this.sessions.delete(key)
    this.stopSweepIfIdle()
  }

  private armSweep(): void {
    if (this.cancelSweep || this.sessions.size === 0 || this.disposed) return
    this.cancelSweep = this.clock.schedule(() => {
      this.cancelSweep = null
      this.sweep()
    }, this.idleMs)
  }

  private sweep(): void {
    const now = this.clock.now()
    for (const [key, entry] of [...this.sessions]) {
      if (now - entry.lastUsedAt < this.idleMs) continue
      this.sessions.delete(key)
      entry.session.dispose(
        `a sessão de ${entry.root} ficou parada e foi encerrada — chame de novo: a próxima chamada sobe um servidor novo`
      )
    }
    this.armSweep()
  }

  private stopSweepIfIdle(): void {
    if (this.sessions.size > 0) return
    this.cancelSweep?.()
    this.cancelSweep = null
  }
}

/** Ganchos do lançador de produção. Existem para o teste provar a FORMA do
 *  lançamento sem ter o pacote do servidor instalado. */
export interface TsServerLaunchDeps {
  /** A pasta do pacote `typescript-language-server`; `null` = não instalado. */
  serverPackageDir?: () => string | null
  /** O `tsserver.js` do WORKSPACE; `null` = o workspace não tem typescript. */
  workspaceTsServer?: (root: string) => string | null
  /** Quem executa o servidor (default: o próprio binário do app em modo node). */
  execPath?: string
}

/**
 * O lançamento de produção da onda 1: `typescript-language-server` sobre o
 * `process.execPath` com `ELECTRON_RUN_AS_NODE=1` — o app não depende de ter
 * node instalado na máquina do dono, e o servidor não abre janela.
 *
 * Quando o WORKSPACE tem o seu próprio `typescript`, o handshake aponta para
 * ele: o diagnóstico sai na versão do PROJETO, não na do Synkora. Sem
 * typescript no workspace, o servidor cai no que ele mesmo embarca.
 */
export function tsServerLaunch(root: string, deps: TsServerLaunchDeps = {}): LspLaunch {
  const packageDir = (deps.serverPackageDir ?? resolveServerPackageDir)()
  if (!packageDir) {
    throw new LspError(
      'o servidor de linguagem "typescript-language-server" não está instalado — rode `npm install` na pasta do Synkora (a dependência já está no package.json) e reabra o chat'
    )
  }
  const entry = serverEntryOf(packageDir)
  const tsserver = (deps.workspaceTsServer ?? workspaceTsServerOf)(root)
  return {
    command: deps.execPath ?? process.execPath,
    args: [entry, '--stdio'],
    // ELECTRON_RUN_AS_NODE faz o binário do app virar um node comum; sem ele o
    // "servidor" abriria uma janela do Electron.
    env: { ELECTRON_RUN_AS_NODE: '1' },
    cwd: root,
    initializationOptions: tsserver ? { tsserver: { path: tsserver } } : undefined
  }
}

/** O executável do pacote sai do `bin` do package.json dele — o nome do arquivo
 *  muda entre versões, e chutar `lib/cli.mjs` quebraria numa atualização. */
function serverEntryOf(packageDir: string): string {
  const manifest = join(packageDir, 'package.json')
  let bin: unknown
  try {
    bin = (JSON.parse(readFileSync(manifest, 'utf-8')) as { bin?: unknown }).bin
  } catch (e) {
    throw new LspError(
      `não foi possível ler ${manifest} (${e instanceof Error ? e.message : String(e)}) — rode \`npm install\` na pasta do Synkora e reabra o chat`
    )
  }
  const relative =
    typeof bin === 'string'
      ? bin
      : bin && typeof bin === 'object'
        ? ((bin as Record<string, string>)['typescript-language-server'] ??
          Object.values(bin as Record<string, string>)[0])
        : undefined
  if (!relative) {
    throw new LspError(
      `o pacote em ${packageDir} não declara executável — rode \`npm install typescript-language-server\` na pasta do Synkora e reabra o chat`
    )
  }
  return isAbsolute(relative) ? relative : join(packageDir, relative)
}

/** Resolução PREGUIÇOSA (nunca no import). Primeiro o resolvedor de módulos —
 *  que enxerga dentro do asar do app empacotado; se o `exports` do pacote
 *  barrar o package.json, sobe a árvore de `node_modules` na mão. */
function resolveServerPackageDir(): string | null {
  try {
    const requireFromHere = createRequire(
      typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json')
    )
    return dirname(requireFromHere.resolve('typescript-language-server/package.json'))
  } catch {
    // segue para a busca manual
  }
  let dir = typeof __dirname === 'string' ? __dirname : process.cwd()
  for (;;) {
    const candidate = join(dir, 'node_modules', 'typescript-language-server')
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function workspaceTsServerOf(root: string): string | null {
  const candidate = join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js')
  return existsSync(candidate) ? candidate : null
}

/** Windows não distingue maiúscula de minúscula em caminho: `C:\a` e `c:\A`
 *  são a MESMA raiz e não podem virar dois servidores. */
function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root
}

export { LspError }
export type { LspLaunch }

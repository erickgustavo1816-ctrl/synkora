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
 * O LANÇADOR é injetável de propósito: em produção `tsServerLaunch(root)` sobe
 * a ESCADA (typescript nativo do projeto → typescript clássico do projeto →
 * typescript do app) descrita na própria função; nos testes entra um servidor
 * FALSO em node puro que fala o protocolo de verdade — o motor nunca depende de
 * binário externo para ser provado, e cada degrau da escada tem gancho próprio.
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
 *  lançamento e CADA DEGRAU da escada sem ter pacote nenhum instalado. */
export interface TsServerLaunchDeps {
  /** A pasta do pacote `typescript-language-server`; `null` = não instalado.
   *  Só o degrau CLÁSSICO precisa dele. */
  serverPackageDir?: () => string | null
  /** A pasta do pacote `typescript` DO WORKSPACE; `null` = o projeto não tem o
   *  seu próprio (cai no degrau do app). */
  workspaceTypescriptDir?: (root: string) => string | null
  /** A pasta do pacote `typescript` DO APP — o último degrau. */
  appTypescriptDir?: () => string | null
  /** O `lib/tsserver.js` daquele pacote typescript; `null` = não é da linha
   *  clássica (5.x), então é a NATIVA. */
  classicTsServer?: (typescriptDir: string) => string | null
  /** O executável nativo daquele pacote typescript (espelho de
   *  `typescript/lib/getExePath.js`); `null` = o pacote de plataforma não está
   *  no disco. */
  nativeExe?: (typescriptDir: string) => string | null
  /** Quem executa o servidor CLÁSSICO (default: o binário do app em modo node).
   *  O nativo é exe: não passa por aqui. */
  execPath?: string
  /** Plataforma/arquitetura da resolução nativa (default: as do processo).
   *  Injetáveis para o teste provar o nome do pacote de plataforma e o sufixo
   *  `.exe` sem depender da máquina onde o gate roda. */
  platform?: NodeJS.Platform
  arch?: string
}

/**
 * A ESCADA DO LANÇADOR (R14.1, medida no binário real em 19/08). O degrau sai
 * do que está NO DISCO, nunca de palpite de versão:
 *
 * (a) o workspace tem typescript da linha NATIVA (7.x — `lib` sem
 *     `tsserver.js`, com `getExePath.js`) → o COMPILADOR DO PROJETO serve o LSP
 *     ele mesmo: `<exe> --lsp --stdio`. Sem `ELECTRON_RUN_AS_NODE` — é
 *     executável nativo, não script de node; passar a variável seria mentira
 *     inofensiva hoje e confusão amanhã.
 * (b) o workspace tem typescript CLÁSSICO (`lib/tsserver.js` existe) → o
 *     caminho da onda 1, intacto: `typescript-language-server` sobre o binário
 *     do app em modo node, com `initializationOptions.tsserver.path` apontando
 *     o tsserver DO PROJETO (o diagnóstico sai na versão do projeto).
 * (c) o workspace não tem typescript nenhum → o typescript DO APP, pela MESMA
 *     decisão (a)/(b) — hoje ele é 7.0.2, nativo.
 *
 * Toda falha nomeia a receita E O LUGAR: `npm install` na raiz do projeto é
 * conserto diferente de `npm install` na pasta do Synkora.
 */
export function tsServerLaunch(root: string, deps: TsServerLaunchDeps = {}): LspLaunch {
  const workspaceDir = (deps.workspaceTypescriptDir ?? workspaceTypescriptDirOf)(root)
  if (workspaceDir) return launchForTypescript(root, workspaceDir, 'workspace', deps)

  const appDir = (deps.appTypescriptDir ?? appTypescriptDirOf)()
  if (!appDir) {
    throw new LspError(
      `nem ${root} nem o Synkora têm o pacote \`typescript\` instalado — rode \`npm install\` na pasta do Synkora (a dependência já está no package.json) e, se o projeto tiver o seu próprio typescript, rode também na raiz dele; depois reabra o chat`
    )
  }
  return launchForTypescript(root, appDir, 'app', deps)
}

/** Um degrau da escada: dado UM pacote typescript, clássico ou nativo, como o
 *  servidor daquela raiz nasce. `origin` só existe para a recusa dizer ONDE
 *  rodar o `npm install` — receita sem endereço é meia receita. */
function launchForTypescript(
  root: string,
  typescriptDir: string,
  origin: 'workspace' | 'app',
  deps: TsServerLaunchDeps
): LspLaunch {
  const where = origin === 'workspace' ? `na raiz do projeto (${root})` : 'na pasta do Synkora'

  // Clássico primeiro: é um `existsSync` só, e quem tem `tsserver.js` não tem
  // pacote de plataforma para resolver.
  const tsserver = (deps.classicTsServer ?? classicTsServerOf)(typescriptDir)
  if (tsserver) {
    const packageDir = (deps.serverPackageDir ?? resolveServerPackageDir)()
    if (!packageDir) {
      throw new LspError(
        'o servidor de linguagem "typescript-language-server" não está instalado — rode `npm install` na pasta do Synkora (a dependência já está no package.json) e reabra o chat'
      )
    }
    return {
      command: deps.execPath ?? process.execPath,
      args: [serverEntryOf(packageDir), '--stdio'],
      // ELECTRON_RUN_AS_NODE faz o binário do app virar um node comum; sem ele o
      // "servidor" abriria uma janela do Electron.
      env: { ELECTRON_RUN_AS_NODE: '1' },
      cwd: root,
      initializationOptions: { tsserver: { path: tsserver } }
    }
  }

  const exe = (deps.nativeExe ?? ((dir: string) => nativeExeOf(dir, deps)))(typescriptDir)
  if (!exe) {
    throw new LspError(
      `o typescript de ${typescriptDir} não é da linha clássica (não tem \`lib/tsserver.js\`) e o executável nativo dele não foi encontrado no disco — rode \`npm install\` ${where} para trazer o pacote de plataforma \`@typescript/${platformPackageOf(typescriptDir, deps)}\` e reabra o chat`
    )
  }
  return {
    command: exe,
    // O compilador nativo VIRA servidor de linguagem com estas duas bandeiras
    // (sondadas no binário: o initialize responde `diagnosticProvider`).
    args: ['--lsp', '--stdio'],
    cwd: root
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
  return climbForPackage(
    typeof __dirname === 'string' ? __dirname : process.cwd(),
    'typescript-language-server'
  )
}

/** O pacote `typescript` do PROJETO. Existir é o que importa aqui; qual das
 *  duas linhas ele é, quem decide é `launchForTypescript`. */
function workspaceTypescriptDirOf(root: string): string | null {
  const candidate = join(root, 'node_modules', 'typescript')
  return existsSync(join(candidate, 'package.json')) ? candidate : null
}

/** O pacote `typescript` DO APP. Mesma resolução preguiçosa do servidor
 *  clássico: primeiro o resolvedor de módulos (enxerga dentro do asar), depois
 *  a subida manual da árvore de `node_modules`. */
function appTypescriptDirOf(): string | null {
  try {
    const requireFromHere = createRequire(
      typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json')
    )
    return dirname(requireFromHere.resolve('typescript/package.json'))
  } catch {
    // segue para a busca manual
  }
  return climbForPackage(typeof __dirname === 'string' ? __dirname : process.cwd(), 'typescript')
}

/** A marca da linha CLÁSSICA (5.x): o `tsserver.js` em pessoa. A linha nativa
 *  (7.x) tem `lib/getExePath.js` no lugar dele. */
function classicTsServerOf(typescriptDir: string): string | null {
  const candidate = join(typescriptDir, 'lib', 'tsserver.js')
  return existsSync(candidate) ? candidate : null
}

/**
 * O executável do typescript NATIVO — espelho fiel de
 * `typescript/lib/getExePath.js` (ler aquele arquivo é a documentação desta
 * função; ele é a fonte, isto é a cópia declarada):
 *
 * - o nome do exe é a ÚNICA chave de `bin` do pacote (`tsc` quando o pacote é
 *   `typescript`, `tsgo` nos pacotes de preview) — NÃO o caminho que ela aponta;
 * - o exe mora em `@typescript/<base>-<plataforma>-<arch>/lib/`, e esse pacote é
 *   dependência DO pacote typescript: resolve-se A PARTIR dele, nunca do app
 *   (o typescript do projeto tem o pacote de plataforma DELE);
 * - no Windows entra o sufixo `.exe` e, passando de 248 caracteres, o prefixo
 *   `\\?\` de caminho longo — sem ele o spawn falha em worktree fundo.
 *
 * Não existir é RESPOSTA (`null`), não exceção: quem recusa, com a receita, é
 * `launchForTypescript`.
 */
function nativeExeOf(typescriptDir: string, deps: TsServerLaunchDeps): string | null {
  const platform = deps.platform ?? process.platform
  const identity = typescriptIdentityOf(typescriptDir)
  if (!identity) return null

  const platformDir = platformPackageDirOf(
    typescriptDir,
    `${identity.base}-${platform}-${deps.arch ?? process.arch}`
  )
  if (!platformDir) return null

  let exe = join(
    platformDir,
    'lib',
    platform === 'win32' ? `${identity.binName}.exe` : identity.binName
  )
  if (platform === 'win32' && exe.length >= 248) exe = `\\\\?\\${exe}`
  return existsSync(exe) ? exe : null
}

/** Quem o pacote diz ser: o `base` (nome sem escopo, que batiza o pacote de
 *  plataforma) e o `binName` (a CHAVE de `bin`, que batiza o executável).
 *  `null` = nem package.json legível tem — não é pacote typescript nenhum. */
function typescriptIdentityOf(typescriptDir: string): { base: string; binName: string } | null {
  let manifest: { name?: unknown; bin?: unknown }
  try {
    manifest = JSON.parse(readFileSync(join(typescriptDir, 'package.json'), 'utf-8')) as {
      name?: unknown
      bin?: unknown
    }
  } catch {
    return null
  }
  const name = typeof manifest.name === 'string' ? manifest.name : 'typescript'
  const base = name.startsWith('@') ? (name.split('/')[1] ?? name) : name
  const declared =
    manifest.bin && typeof manifest.bin === 'object'
      ? Object.keys(manifest.bin as Record<string, unknown>)[0]
      : undefined
  return { base, binName: declared ?? (base === 'typescript' ? 'tsc' : 'tsgo') }
}

/** O nome do pacote de plataforma, para a RECUSA poder dizer o que falta com o
 *  nome CERTO (o pacote de preview procura `native-preview-…`, não
 *  `typescript-…`). */
function platformPackageOf(typescriptDir: string, deps: TsServerLaunchDeps): string {
  const base = typescriptIdentityOf(typescriptDir)?.base ?? 'typescript'
  return `${base}-${deps.platform ?? process.platform}-${deps.arch ?? process.arch}`
}

/** A pasta do `@typescript/<platformPackage>`, resolvida A PARTIR do pacote
 *  typescript dono dele (é assim que o getExePath faz: `import.meta.resolve` de
 *  dentro do próprio `lib/`). */
function platformPackageDirOf(typescriptDir: string, platformPackage: string): string | null {
  const specifier = `@typescript/${platformPackage}/package.json`
  try {
    const requireFromTypescript = createRequire(join(typescriptDir, 'lib', 'getExePath.js'))
    return dirname(requireFromTypescript.resolve(specifier))
  } catch {
    // segue para a busca manual (o `exports` do pacote pode barrar, e no asar o
    // resolvedor às vezes não enxerga)
  }
  return climbForPackage(typescriptDir, `@typescript/${platformPackage}`)
}

/** Sobe a árvore de `node_modules` procurando um pacote pelo nome. */
function climbForPackage(from: string, packageName: string): string | null {
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', ...packageName.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Windows não distingue maiúscula de minúscula em caminho: `C:\a` e `c:\A`
 *  são a MESMA raiz e não podem virar dois servidores. */
function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root
}

export { LspError }
export type { LspLaunch }

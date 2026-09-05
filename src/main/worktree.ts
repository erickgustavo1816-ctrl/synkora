import { execFileSync } from 'child_process'
import {} from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'fs'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { ensureNodeModulesLink } from './nodeModulesLink'
import { freshWindowsPath } from './winPath'

// Worktree por tarefa (F3): cada execução roda em worktrees/<task> numa branch
// task/<id>; aprovada nos dois gates, o main integra com merge --no-ff e limpa.
// Projeto sem git (ou sem commit) cai no modo direto — executa no próprio dir.

/** Sensor dos git SÍNCRONOS (diagnóstico das travadas de UI, 2026-08-19).
 *  Gancho injetado — nunca import: este módulo compila sozinho nas suítes e
 *  roda também no gitWorker (onde ninguém arma o gancho e ele fica no-op).
 *  Quem arma é o index.ts, NO MAIN THREAD, despejando na caixa-preta — é lá
 *  que cada spawn síncrono de git rouba tempo da UI. */
let gitObserver: ((info: { ms: number; args: string[]; cwd: string }) => void) | null = null

export function setGitObserver(
  observer: ((info: { ms: number; args: string[]; cwd: string }) => void) | null
): void {
  gitObserver = observer
}

function gitRaw(cwd: string, args: string[], maxBuffer?: number): string {
  const startedAt = gitObserver ? Date.now() : 0
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: { ...(process.env as Record<string, string>), PATH: freshWindowsPath() },
      timeout: 60_000,
      windowsHide: true,
      // Padrão do Node é 1MB; quem lê DIFF de arquivo pede folga explícita —
      // estourar o buffer vira ENOBUFS sem stdout aproveitável.
      ...(maxBuffer ? { maxBuffer } : {}),
      // stderr capturado (vai no erro), não despejado no console do app —
      // hasGitCommit sonda projetos sem git e enchia o dev de "fatal:".
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } finally {
    // No finally de propósito: git LENTO que FALHA também rouba a UI.
    if (gitObserver) {
      try {
        gitObserver({ ms: Date.now() - startedAt, args, cwd })
      } catch {
        // sensor nunca derruba a operação real
      }
    }
  }
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim()
}

/** O commit atual, usado pelos journals para provar que um merge realmente pousou. */
export function gitHead(cwd: string): string | undefined {
  try {
    return git(cwd, ['rev-parse', 'HEAD']) || undefined
  } catch {
    return undefined
  }
}

/** Verdadeiro somente quando não há arquivos modificados, staged ou novos. */
export function isWorktreeClean(cwd: string): boolean | undefined {
  try {
    return git(cwd, ['status', '--porcelain']).length === 0
  } catch {
    return undefined
  }
}

/**
 * Repara um worktree cujo ref foi movido atomicamente, mas cujos arquivos não
 * conseguiram acompanhar (ex.: arquivo travado no Windows). Só faz reset se
 * índice/arquivos ainda forem exatamente a fotografia anterior e não houver
 * untracked; qualquer edição real é preservada para decisão explícita.
 */
export function alignWorktreeFromSnapshot(cwd: string, previousHead: string): boolean {
  try {
    gitRaw(cwd, ['diff', '--quiet', previousHead, '--'])
    gitRaw(cwd, ['diff', '--cached', '--quiet', previousHead, '--'])
    if (git(cwd, ['ls-files', '--others', '--exclude-standard'])) return false
    const head = git(cwd, ['rev-parse', 'HEAD'])
    // `--merge` atualiza a fotografia anterior, mas recusa/preserva qualquer
    // escrita que tenha surgido depois das checagens acima. `--hard` apagaria
    // exatamente a edição que este reparo deve proteger.
    git(cwd, ['reset', '--merge', head])
    return git(cwd, ['status', '--porcelain']).length === 0
  } catch {
    return false
  }
}

/**
 * `true` somente quando o commit esperado é ancestral do HEAD do destino.
 * `false` é uma prova negativa; `undefined` significa que o Git não pôde ser
 * consultado e, portanto, a recuperação deve preservar o estado em vez de
 * presumir sucesso.
 */
export function gitCommitReached(cwd: string, expectedCommit: string): boolean | undefined {
  try {
    gitRaw(cwd, ['merge-base', '--is-ancestor', expectedCommit, 'HEAD'])
    return true
  } catch (error) {
    const status = (error as { status?: number }).status
    return status === 1 ? false : undefined
  }
}

/**
 * Prova o único estado em que um journal pode ser descartado sem concluir nem
 * repetir o merge: origem e destino continuam limpos, nas branches e SHAs
 * exatos fotografados antes do CAS.
 */
export function isExactCleanPreCasSnapshot(
  sourceDir: string,
  sourceHead: string,
  targetDir: string,
  targetHead: string,
  targetBranch: string
): boolean {
  return (
    currentBranch(targetDir) === targetBranch &&
    gitHead(targetDir) === targetHead &&
    isWorktreeClean(targetDir) === true &&
    gitHead(sourceDir) === sourceHead &&
    isWorktreeClean(sourceDir) === true
  )
}

const TYPESCRIPT_JAVASCRIPT_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i

const EXECUTABLE_SOURCE_EXTENSIONS = new Set([
  'astro', 'bash', 'bat', 'c', 'cc', 'clj', 'cljs', 'cljc', 'cmd', 'coffee',
  'cmake', 'cpp', 'cs', 'cshtml', 'csh', 'css', 'cts', 'cue', 'cxx', 'dart',
  'eex', 'erb', 'ex', 'exs', 'feature', 'fs', 'fsx', 'go', 'gradle', 'graphql',
  'gql', 'groovy', 'h', 'hbs', 'hcl', 'hh', 'hpp', 'hrl', 'hs', 'htm', 'html',
  'ipynb', 'java', 'jl', 'js', 'jsx', 'ksh', 'kt', 'kts', 'less', 'liquid',
  'lua', 'm', 'mdx', 'mm', 'mts', 'mustache', 'nix', 'php', 'pl', 'pm',
  'prisma', 'proto', 'ps1', 'psd1', 'psm1', 'py', 'pyi', 'qml', 'r', 'razor',
  'rb', 'rego', 'robot', 'rs', 'sass', 'scala', 'scss', 'sh', 'sol', 'sql',
  'svelte', 'swift', 'tf', 'tfvars', 'ts', 'tsx', 'twig', 'vb', 'vbs', 'vue',
  'wasm', 'zsh'
])

const SENSITIVE_CONFIG_EXTENSIONS = new Set([
  'config', 'conf', 'csproj', 'fsproj', 'ini', 'json', 'jsonc', 'lock',
  'properties', 'props', 'sln', 'targets', 'tfstate', 'toml', 'vbproj', 'xml',
  'yaml', 'yml', 'xcodeproj'
])

const INERT_DOCUMENT_ASSET_EXTENSIONS = new Set([
  'adoc', 'avi', 'avif', 'csv', 'doc', 'docx', 'flac', 'gif', 'ico', 'jpeg',
  'jpg', 'markdown', 'md', 'mov', 'mp3', 'mp4', 'odt', 'ogg', 'otf', 'pdf',
  'png', 'ppt', 'pptx', 'rst', 'svg', 'tsv', 'ttf', 'txt', 'wav', 'webm',
  'webp', 'woff', 'woff2', 'xls', 'xlsx'
])

const SENSITIVE_CONFIG_NAMES = new Set([
  '.browserslistrc', '.dockerignore', '.editorconfig', '.eslintignore',
  '.gitattributes', '.gitignore', '.gitmodules', '.npmrc', '.nvmrc',
  '.prettierignore', '.python-version', '.ruby-version', '.swcrc',
  '.tool-versions', 'bun.lock', 'bun.lockb', 'cargo.lock', 'cargo.toml',
  'cmakelists.txt', 'composer.json', 'composer.lock', 'deno.json', 'deno.jsonc',
  'gemfile', 'gemfile.lock', 'go.mod', 'go.sum', 'go.work', 'gradle.properties',
  'jenkinsfile', 'justfile', 'lerna.json', 'makefile', 'mix.exs', 'mix.lock',
  'nx.json', 'package-lock.json', 'package.json', 'package.swift', 'pipfile',
  'pipfile.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'podfile',
  'podfile.lock', 'poetry.lock', 'pom.xml', 'procfile', 'pubspec.lock',
  'pubspec.yaml', 'pyproject.toml', 'turbo.json', 'yarn.lock'
])

const SENSITIVE_AUTOMATION_PATH = /^(?:\.buildkite\/|\.circleci\/|\.github\/(?:actions|workflows)\/|\.githooks\/|\.husky\/|\.woodpecker\/|bin\/|ci\/|cmd\/|deploy\/|docker\/|hooks\/|infra\/|k8s\/|migrations\/|scripts\/|terraform\/|tools\/)/i

/** Repo git com pelo menos um commit? (worktree exige HEAD válido) */
export function hasGitCommit(projectPath: string): boolean {
  try {
    git(projectPath, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

export interface TaskWorktree {
  dir: string
  branch: string
}

export function taskWorktreeDescriptor(baseDir: string, taskId: string): TaskWorktree {
  const short = taskId.slice(0, 8)
  return { dir: join(baseDir, short), branch: `task/${short}` }
}

export function ensureSynkoraGitExcludes(projectPath: string): void {
  // `info/exclude` só protege arquivos ainda não rastreados. Se um projeto
  // existente já versiona `.synkora`, gravar BOARD/EVENTS/runs por cima dele
  // alteraria dados do usuário e manteria a base permanentemente suja. Pare
  // antes da primeira escrita; a migração (untrack/cópia) precisa ser explícita.
  try {
    const tracked = git(projectPath, ['ls-files', '--', '.synkora'])
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (tracked.length > 0) {
      const visible = tracked.slice(0, 4).join(', ')
      const rest = tracked.length > 4 ? ` +${tracked.length - 4}` : ''
      throw new Error(
        `.synkora já contém arquivos versionados (${visible}${rest}); preservei-os e bloqueei o runtime até uma migração explícita`
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('.synkora já contém')) throw error
    // Fora de um repo Git, initGitRepo cuidará da exclusão depois do `git init`.
  }
  try {
    const commonGitDir = git(projectPath, ['rev-parse', '--git-common-dir'])
    const common = isAbsolute(commonGitDir)
      ? commonGitDir
      : resolve(projectPath, commonGitDir)
    const exclude = join(common, 'info', 'exclude')
    const wanted = [
      '.synkora/',
      '.claude/skills/',
      '.claude/agents/',
      '.agents/skills/',
      '.codex/skills/',
      // evidência de browser dos gates (--output-dir do playwright MCP) —
      // git-invisível em QUALQUER produto, tenha ele .gitignore ou não
      // (caso real 2026-08-06: screenshots do QA invalidaram o veredito)
      '.playwright-mcp/'
    ]
    let current = ''
    try {
      current = readFileSync(exclude, 'utf8')
    } catch {
      // arquivo ainda não existe
    }
    const have = new Set(current.split(/\r?\n/).map((line) => line.trim()))
    const missing = wanted.filter((entry) => !have.has(entry))
    if (!missing.length) return
    mkdirSync(dirname(exclude), { recursive: true })
    writeFileSync(
      exclude,
      current +
        (current && !current.endsWith('\n') ? '\n' : '') +
        '# synkora: skills injetadas por execução (nunca commitar)\n' +
        missing.join('\n') +
        '\n',
      'utf8'
    )
  } catch {
    // Se o exclude falhar, initGitRepo ainda acrescenta os paths no .gitignore.
  }
}

/** Projeto sem git não tem isolamento de missão — o Synkora inicializa o
 *  repo: .gitignore mínimo (sem ele o commit inicial engoliria node_modules)
 *  + commit inicial. Identidade git: usa a global; sem global, fallback
 *  "Synkora" só neste commit. Repo já existente com commit fica intocado. */
export function initGitRepo(projectPath: string): boolean {
  try {
    if (hasGitCommit(projectPath)) {
      ensureSynkoraGitExcludes(projectPath)
      return true
    }
    // git init SEMPRE (idempotente): visto em campo um .git VAZIO/inválido
    // (sobra de outra ferramenta) — pular o init quando a pasta existe
    // deixava tudo depois falhando com "not a git repository".
    git(projectPath, ['init'])
    ensureSynkoraGitExcludes(projectPath)
    const gi = join(projectPath, '.gitignore')
    if (!existsSync(gi)) {
      writeFileSync(
        gi,
        'node_modules/\n.synkora/\ndist/\nout/\nbuild/\n.env\n.claude/skills/\n.claude/agents/\n.agents/skills/\n.codex/skills/\n',
        'utf-8'
      )
    } else {
      // .gitignore do projeto sem .synkora → o runtime do Synkora (runs,
      // eventos, board) iria para o commit e para todos os worktrees.
      try {
        const cur = readFileSync(gi, 'utf-8')
        const generated = [
          '.synkora/',
          '.claude/skills/',
          '.claude/agents/',
          '.agents/skills/',
          '.codex/skills/'
        ]
        const have = new Set(cur.split(/\r?\n/).map((line) => line.trim()))
        const missing = generated.filter((entry) => !have.has(entry))
        if (missing.length) {
          writeFileSync(
            gi,
            cur.replace(/\n?$/, '\n') + missing.join('\n') + '\n',
            'utf-8'
          )
        }
      } catch {
        // best-effort
      }
    }
    git(projectPath, ['add', '-A'])
    try {
      git(projectPath, ['commit', '-m', 'chore: initial commit (Synkora)'])
    } catch {
      git(projectPath, [
        '-c',
        'user.name=Synkora',
        '-c',
        'user.email=synkora@local',
        'commit',
        '-m',
        'chore: initial commit (Synkora)'
      ])
    }
    return hasGitCommit(projectPath)
  } catch {
    return false
  }
}

// ————— GITHUB NO NASCIMENTO DO UNIVERSO (2.0, onda D, item 6) —————
//
// Duas operações que FALAM COM A REDE, e por isso viajam pelo gitWorker como
// todo o resto: clonar um repositório para dentro da pasta nova e prender um
// remoto (com push best-effort) a uma pasta que já tem conteúdo. A regra que
// vale nas duas: NENHUM PROMPT. Sem `GIT_TERMINAL_PROMPT=0` uma credencial
// ausente pendura o git num diálogo invisível para o app, e a criação do
// universo ficaria travada para sempre em vez de falhar com um texto honesto.

/** Env do git de REDE: falha rápido em vez de esperar credencial que ninguém
 *  vai digitar (o pedido de senha do git não tem tela dentro do Synkora). */
function gitNetworkEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PATH: freshWindowsPath(),
    GIT_TERMINAL_PROMPT: '0',
    // askpass vazio cobre o caminho GUI (credential helper gráfico do Windows).
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes'
  }
}

function gitNetwork(cwd: string, args: string[], timeoutMs = 180_000): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: gitNetworkEnv(),
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/** Primeira linha útil do erro do git — é o que vira texto de UI. */
function gitFailureText(error: unknown): string {
  const raw =
    error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : ''
  const line = (raw || (error instanceof Error ? error.message : String(error)))
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !/^Cloning into/i.test(entry))
    .pop()
  return (line ?? 'o git não explicou o motivo').slice(0, 240)
}

/**
 * URL de remoto aceita. A cerca importante é a PRIMEIRA: valor começando com
 * '-' seria lido pelo git como FLAG (`--upload-pack=...` executa comando), e
 * este campo vem digitado pelo dono. Espaço/controle também caem fora.
 */
export function isSupportedGitRemoteUrl(url: string): boolean {
  const clean = url.trim()
  if (!clean || clean.startsWith('-')) return false
  if (clean.split('').some((ch) => ch.charCodeAt(0) <= 0x20)) return false
  return /^https:\/\/\S+$/i.test(clean) || /^ssh:\/\/\S+$/i.test(clean) || /^[\w.-]+@[\w.-]+:\S+$/.test(clean)
}

export interface GitRemoteSetupResult {
  ok: boolean
  /** Falha DURA: o universo não deve nascer assim (clone que não aconteceu). */
  error?: string
  /** Ficou pela metade e o universo nasce mesmo assim (push recusado etc.). */
  warning?: string
}

/**
 * (a) do item 6: pasta ausente/vazia + link → o universo É o clone. Falha aqui
 * é DURA: cadastrar um universo apontando para uma pasta que não recebeu o
 * código seria pior que não cadastrar.
 */
export function cloneRepository(url: string, targetPath: string): GitRemoteSetupResult {
  if (!isSupportedGitRemoteUrl(url))
    return { ok: false, error: 'link do repositório inválido — use https://…, ssh://… ou git@host:dono/repo.git' }
  try {
    if (existsSync(targetPath) && readdirSync(targetPath).length > 0)
      return { ok: false, error: 'a pasta escolhida já tem conteúdo — clonar aqui apagaria o que existe' }
    mkdirSync(dirname(targetPath), { recursive: true })
    gitNetwork(dirname(targetPath), ['clone', '--', url.trim(), targetPath])
    if (!existsSync(join(targetPath, '.git')))
      return { ok: false, error: 'o clone terminou sem repositório na pasta' }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `não consegui clonar: ${gitFailureText(error)}` }
  }
}

/**
 * (b) do item 6: pasta com conteúdo + link → garante repo (init + commit
 * inicial), prende o `origin` e TENTA o push. O push é BEST-EFFORT por
 * desenho: sem credencial na máquina ele falha, e o universo tem de nascer
 * assim mesmo — o dono resolve a autenticação depois e empurra quando quiser.
 */
export function attachGitRemote(projectPath: string, url: string): GitRemoteSetupResult {
  const clean = url.trim()
  if (!isSupportedGitRemoteUrl(clean))
    return { ok: false, warning: 'link do repositório inválido — o universo nasceu sem remoto; confira o endereço e prenda o origin depois' }
  try {
    if (!hasGitCommit(projectPath)) {
      // `-b main` é o nome que o dono espera ver no GitHub; git < 2.28 não
      // conhece a flag e cai no default — o initGitRepo abaixo cobre o resto.
      try {
        if (!existsSync(join(projectPath, '.git'))) git(projectPath, ['init', '-b', 'main'])
      } catch {
        // versão antiga do git: o init sem flag acontece dentro do initGitRepo
      }
      if (!initGitRepo(projectPath))
        return { ok: false, warning: 'não consegui inicializar o repositório local — o universo nasceu sem remoto' }
    }
    const existing = (() => {
      try {
        return git(projectPath, ['remote', 'get-url', 'origin'])
      } catch {
        return ''
      }
    })()
    git(projectPath, existing ? ['remote', 'set-url', 'origin', clean] : ['remote', 'add', 'origin', clean])
  } catch (error) {
    return { ok: false, warning: `não consegui prender o remoto: ${gitFailureText(error)}` }
  }
  try {
    gitNetwork(projectPath, ['push', '-u', 'origin', 'HEAD'])
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      warning: `remoto prendido, mas o push não passou: ${gitFailureText(error)} — o universo foi criado; autentique o git e envie quando quiser`
    }
  }
}

/**
 * R28 — O RELEASE EMPURRA O REMOTO (ordem do dono, 2026-08-20: uma missão
 * configurou o GitHub do projeto e o subir versão o ignorou; quando há remoto,
 * o clique em subir versão É a demanda do push — a doutrina sob-demanda segue
 * valendo para todo o resto). Fast-forward só: o release acabou de avançar a
 * base local; recusa do remoto volta como texto honesto, nunca vira força.
 */
export function pushBranchToRemote(
  projectPath: string,
  branch: string
): { ok: true; detail: string } | { ok: false; error: string } {
  let remote = ''
  try {
    remote = git(projectPath, ['remote', 'get-url', 'origin'])
  } catch {
    return { ok: false, error: 'o projeto não tem remoto origin configurado' }
  }
  if (!remote) return { ok: false, error: 'o projeto não tem remoto origin configurado' }
  try {
    gitNetwork(projectPath, ['push', 'origin', branch])
    return { ok: true, detail: `origin atualizado (${branch})` }
  } catch (error) {
    return { ok: false, error: gitFailureText(error) }
  }
}

/**
 * R28.1 — a faixa de commits tocou um ARQUIVO? É o que deixa o desfecho do
 * release avisar "o package.json mudou — npm install na pasta" (o loop das 4
 * versões de 2026-08-20: merge leva o manifesto, mas nunca instala nada).
 * `undefined` = não deu para provar (a resposta honesta, nunca um palpite).
 */
export function commitRangeTouchesFile(
  cwd: string,
  fromSha: string,
  toSha: string,
  file: string
): boolean | undefined {
  try {
    return git(cwd, ['diff', '--name-only', `${fromSha}..${toSha}`, '--', file]).length > 0
  } catch {
    return undefined
  }
}

/**
 * R29 — o commit do ALINHAMENTO DE VERSÃO do release (o bump do package.json
 * que precisa viajar no push da subida). Local e cirúrgico: `add` + `commit`
 * SÓ dos caminhos pedidos — a pasta do produto pode ter sujeira alheia (o
 * data/ do backup automático do Painel, por exemplo) que NUNCA pega carona
 * num commit do harness. Rede não sai daqui; o push da R28 é quem viaja.
 */
export function commitProjectFiles(
  projectPath: string,
  files: string[],
  message: string
): { ok: true; sha: string } | { ok: false; error: string } {
  if (files.length === 0) return { ok: false, error: 'nenhum arquivo para commitar' }
  try {
    git(projectPath, ['add', '--', ...files])
    git(projectPath, ['commit', '-m', message, '--', ...files])
    return { ok: true, sha: git(projectPath, ['rev-parse', '--short=12', 'HEAD']) }
  } catch (error) {
    return { ok: false, error: gitFailureText(error) }
  }
}

/**
 * O remoto do projeto e o quanto a branch local está à frente dele — a
 * fotografia do release_status. Leitura LOCAL (o ref origin/<branch> do
 * último fetch/push): nenhuma rede sai daqui. `undefined` = sem remoto;
 * `ahead: undefined` = o remoto nunca foi buscado (sem tracking ref).
 */
export function remoteAheadOf(
  projectPath: string,
  branch: string
): { url: string; ahead: number | undefined } | undefined {
  let url = ''
  try {
    url = git(projectPath, ['remote', 'get-url', 'origin'])
  } catch {
    return undefined
  }
  if (!url) return undefined
  let ahead: number | undefined
  try {
    const count = Number.parseInt(
      git(projectPath, ['rev-list', '--count', `origin/${branch}..${branch}`]),
      10
    )
    ahead = Number.isSafeInteger(count) && count >= 0 ? count : undefined
  } catch {
    ahead = undefined
  }
  return { url, ahead }
}

/** Pasta do projeto movida/renomeada: o `.git` de cada worktree
 *  (userData/worktrees) aponta para o caminho ANTIGO do repo — `git worktree
 *  repair` rodado do repo no caminho novo reescreve os ponteiros dos dois
 *  lados; o prune limpa o que não tem mais conserto. */
export function repairWorktrees(projectPath: string): void {
  try {
    git(projectPath, ['worktree', 'repair'])
  } catch {
    // sem worktrees para reparar
  }
  pruneWorktrees(projectPath)
}

/** Remove registros de worktrees cujos diretórios já sumiram (limpeza de boot). */
export function pruneWorktrees(projectPath: string): void {
  try {
    git(projectPath, ['worktree', 'prune'])
  } catch {
    // sem repo/nada a podar
  }
}

/** Remove worktree + branch (exclusão de missão arquivada) — best-effort. */
/**
 * Remove todo reparse point (junction/symlink) DENTRO de uma árvore — só o
 * LINK, nunca o alvo — sem jamais descer através de um link. Proteção contra
 * deleções recursivas (git/PowerShell) que atravessam junctions no Windows.
 * Best-effort com orçamento de varredura: worktree normal tem poucos milhares
 * de entradas; um node_modules materializado é grande, mas a varredura não
 * desce em links e o teto evita custo patológico.
 */
export function neutralizeReparsePoints(root: string): void {
  const stack = [root]
  let budget = 200_000
  while (stack.length > 0 && budget > 0) {
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (--budget <= 0) break
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        // rmdirSync remove a junction/symlink de diretório SEM tocar o alvo;
        // unlink cobre symlink de arquivo. Falha vira recusa do próprio git.
        try {
          rmdirSync(full)
        } catch {
          try {
            unlinkSync(full)
          } catch {
            /* deixa o git worktree remove decidir */
          }
        }
        continue
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
}

/**
 * CARCAÇA de `worktree remove` interrompido (incidente 2026-08-24): a pasta
 * existe, mas o `.git` — a identidade — foi levado junto com parte dos
 * arquivos, e o registro já saiu no prune. `gitHead` jamais provará o SHA
 * aprovado, então o preservar-e-bloquear de sempre viraria beco sem saída
 * PERMANENTE do reparo pós-merge (`target_repair_pending` a cada boot).
 *
 * Rota sancionada: duas provas e um gesto SEM deleção.
 * 1. A branch, se ainda existir, tem de apontar exatamente para o SHA
 *    aprovado — a mesma régua do ramo sem pasta.
 * 2. Nenhum arquivo rastreado PRESENTE pode diferir do conteúdo aprovado,
 *    comparado por BYTES: o index temporário populado por `read-tree` não
 *    carrega stat nenhum, então o diff lê cada arquivo de verdade. Sem o
 *    `read-tree`, o index vazio faria o diff passar sem ler NADA (provado
 *    em sonda) — ele é parte do lacre, não otimização.
 * 3. Provada, a carcaça vai INTEIRA para `<dir>-carcass-bak` ao lado:
 *    rename preserva até a sobra sem cópia no git (build ignorado, p.ex.);
 *    apagar continua sendo decisão de gente, nunca deste reparo.
 * Qualquer dúvida em qualquer passo preserva a pasta e bloqueia como antes.
 */
function quarantineProvenCarcass(
  projectPath: string,
  dir: string,
  branch: string,
  expectedHead: string
): boolean {
  const branchExists = gitLocalBranchExists(projectPath, branch)
  if (branchExists === undefined) return false
  if (branchExists) {
    try {
      if (git(projectPath, ['rev-parse', `refs/heads/${branch}`]) !== expectedHead) return false
    } catch {
      return false
    }
  }
  let gitDir: string
  try {
    gitDir = git(projectPath, ['rev-parse', '--absolute-git-dir'])
  } catch {
    return false
  }
  const scratch = mkdtempSync(join(tmpdir(), 'synkora-carcass-proof-'))
  try {
    const env = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath(),
      GIT_DIR: gitDir,
      GIT_WORK_TREE: dir,
      GIT_INDEX_FILE: join(scratch, 'index')
    }
    execFileSync('git', ['read-tree', expectedHead], {
      cwd: dir,
      env,
      timeout: 60_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const modified = execFileSync(
      'git',
      ['diff', '--diff-filter=M', '--name-only', expectedHead],
      {
        cwd: dir,
        env,
        encoding: 'utf-8',
        timeout: 60_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    if (modified.trim().length > 0) return false
  } catch {
    return false
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  let quarantine = `${dir}-carcass-bak`
  for (let n = 2; existsSync(quarantine); n += 1) {
    // teto duro: uma fila de vinte quarentenas do MESMO worktree não é
    // recuperação, é sintoma — aí o bloqueio de sempre volta a valer
    if (n > 20) return false
    quarantine = `${dir}-carcass-bak-${n}`
  }
  try {
    renameSync(dir, quarantine)
  } catch {
    return false
  }
  return !existsSync(dir)
}

export function removeWorktreeAndBranch(
  projectPath: string,
  dir: string,
  branch: string,
  expectedHead?: string
): boolean {
  // Não use `--force`: o próprio Git repete a checagem de sujeira durante a
  // remoção e impede que uma escrita tardia seja apagada pelo cleanup.
  if (expectedHead) {
    if (existsSync(dir)) {
      if (existsSync(join(dir, '.git'))) {
        if (gitHead(dir) !== expectedHead) return false
      } else if (!quarantineProvenCarcass(projectPath, dir, branch, expectedHead)) {
        // Sem `.git` a pasta é carcaça de remoção interrompida; `gitHead`
        // subiria a árvore de diretórios e responderia pelo repo ERRADO (ou
        // por nenhum). A prova/quarentena acima é a única rota de saída.
        return false
      }
    } else {
      // Recovery também cobre queda entre `worktree remove` e o CAS da
      // branch. Sem a pasta, só conclui se o ref ainda aponta exatamente para
      // o SHA aprovado; branch ausente significa que a limpeza já terminou.
      const branchExists = gitLocalBranchExists(projectPath, branch)
      if (branchExists === false) return true
      if (branchExists !== true) return false
      try {
        if (git(projectPath, ['rev-parse', `refs/heads/${branch}`]) !== expectedHead)
          return false
      } catch {
        return false
      }
    }
  }
  if (existsSync(dir) && isWorktreeClean(dir) !== true) return false
  // INCIDENTE REAL (02/08): junction de node_modules criada por um agente
  // dentro do worktree — o `git worktree remove` no Windows ATRAVESSOU o
  // link ao apagar conteúdo ignorado e esvaziou o node_modules REAL da
  // pasta base. Neutraliza todo reparse point (remove o LINK, nunca o alvo)
  // antes de qualquer deleção recursiva.
  if (existsSync(dir)) neutralizeReparsePoints(dir)
  try {
    git(projectPath, ['worktree', 'remove', dir])
  } catch {
    if (existsSync(dir)) return false
    pruneWorktrees(projectPath)
    // worktree já removido ou em uso
  }
  try {
    if (expectedHead) {
      git(projectPath, ['update-ref', '-d', `refs/heads/${branch}`, expectedHead])
    } else {
      git(projectPath, ['branch', '-D', branch])
    }
  } catch {
    // branch já removida
  }
  let branchExists = true
  try {
    git(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  } catch (error) {
    branchExists = (error as { status?: number }).status !== 1
  }
  return !existsSync(dir) && !branchExists
}

/** Branch atual do repo (alvo padrão de integração das missões). */
export function currentBranch(projectPath: string): string | undefined {
  try {
    const ref = git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return ref === 'HEAD' ? undefined : ref // detached HEAD = sem branch
  } catch {
    return undefined
  }
}

/** `false` é ausência comprovada; `undefined` significa Git indisponível. */
export function gitLocalBranchExists(
  projectPath: string,
  branch: string
): boolean | undefined {
  if (!branch.trim()) return false
  try {
    git(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch (error) {
    return (error as { status?: number }).status === 1 ? false : undefined
  }
}

/** Prova que a pasta pertence a este repositório e está na branch esperada. */
export function isExpectedWorktree(
  projectPath: string,
  dir: string,
  expectedBranch: string
): boolean {
  if (!expectedBranch.trim() || !existsSync(projectPath) || !existsSync(dir)) return false
  try {
    const canonical = (path: string): string => {
      const value = realpathSync(path)
      return process.platform === 'win32' ? value.toLowerCase() : value
    }
    const projectRoot = canonical(projectPath)
    const worktreeRoot = canonical(dir)
    const reportedWorktreeRoot = canonical(git(dir, ['rev-parse', '--show-toplevel']))
    const projectCommon = canonical(
      resolve(projectPath, git(projectPath, ['rev-parse', '--git-common-dir']))
    )
    const worktreeCommon = canonical(
      resolve(dir, git(dir, ['rev-parse', '--git-common-dir']))
    )
    return (
      worktreeRoot !== projectRoot &&
      reportedWorktreeRoot === worktreeRoot &&
      projectCommon === worktreeCommon &&
      currentBranch(dir) === expectedBranch &&
      Boolean(gitHead(dir))
    )
  } catch {
    return false
  }
}

/** Destino de release precisa ser um worktree canônico do mesmo repositório
 * e ocupar o namespace reservado `version/*`. Um worktree de missão/tarefa
 * nunca vira destino de publicação apenas porque a pasta e a branch existem. */
export function isExpectedVersionWorktree(
  projectPath: string,
  dir: string,
  expectedBranch: string
): boolean {
  return (
    expectedBranch.startsWith('version/') &&
    isExpectedWorktree(projectPath, dir, expectedBranch)
  )
}

// ————— A BASE NUNCA FICA PARA TRÁS (rodada 7, adendo C2) —————
//
// CASO REAL (2026-08-18, projeto externo do dono): a main do projeto andou 50
// commits POR FORA do Synkora e a branch da VERSÃO — a base de onde toda missão
// nova é derivada — ficou parada no commit inicial. A missão nasceu num worktree
// quase vazio, o agente (corretamente) mergeou a main, e a ENTREGA da missão
// contabilizou o repositório inteiro: +50 mil linhas, 187 arquivos.
//
// A cura é ARITMÉTICA DE GIT, não julgamento: quando a base é ANCESTRAL da main,
// avançar até ela é fast-forward — a única operação que, por definição, não pode
// perder trabalho. Quando as duas DIVERGIRAM, ninguém decide sozinho: quem chama
// emite advisory auditado e a missão nasce da base como está.

export type VersionBaseSyncOutcome =
  /** Não havia o que comparar (a base declarada JÁ é a branch principal). */
  | 'skipped'
  /** A base já contém a main — igual a ela ou À FRENTE (o estado NORMAL de uma
   *  versão que vem recebendo missões e só sobe no release). Nada a fazer. */
  | 'up-to-date'
  /** A base era ancestral da main e foi avançada exatamente até ela. */
  | 'fast-forwarded'
  /** Cada lado tem commit que o outro não tem (ou nem ancestral comum existe). */
  | 'diverged'
  /** O avanço era possível mas o git recusou (worktree da versão com trabalho
   *  não commitado, CAS perdido, arquivo travado) — obstáculo, não veredito. */
  | 'blocked'
  /** Git não pôde ser consultado / a branch não existe. NUNCA presumir avanço. */
  | 'unavailable'

export interface VersionBaseSyncResult {
  outcome: VersionBaseSyncOutcome
  baseBranch: string
  /** Branch principal usada como alvo (a checada na raiz, se não vier dada). */
  mainBranch?: string
  /** SHAs COMPLETOS (quem exibe encurta) — de onde a base estava, para onde foi. */
  fromSha?: string
  toSha?: string
  /** Commits que a base tinha a MENOS que a main… */
  behind?: number
  /** …e a MAIS que ela. */
  ahead?: number
  /** Pasta onde a branch da base está CHECADA, quando está. */
  checkedOutIn?: string
  /** Motivo legível quando o resultado não é o avanço limpo. */
  detail?: string
}

/** SHA completo de uma branch LOCAL — `refs/heads/` explícito para que um nome
 *  ambíguo (tag homônima) ou hostil jamais escolha o objeto por nós. */
function localBranchSha(projectPath: string, branch: string): string | undefined {
  try {
    const sha = git(projectPath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `refs/heads/${branch}^{commit}`
    ])
    return FULL_SHA.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

/** `true` = `ancestor` é alcançável de `descendant`. `undefined` = sem veredito
 *  (git indisponível) — quem chama nunca deve tratar isso como prova. */
function isAncestorCommit(
  cwd: string,
  ancestor: string,
  descendant: string
): boolean | undefined {
  try {
    gitRaw(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    return (error as { status?: number }).status === 1 ? false : undefined
  }
}

/** Onde uma branch está CHECADA neste repositório (raiz ou qualquer worktree),
 *  perguntando ao próprio git em vez de confiar num caminho persistido. É esta
 *  resposta que decide entre `merge --ff-only` (há arquivos para acompanhar o
 *  ref) e `update-ref` com CAS (o ref está sozinho). */
function checkedOutWorktreeDir(projectPath: string, branch: string): string | undefined {
  if (!branch.trim()) return undefined
  let out: string
  try {
    out = gitRaw(projectPath, ['worktree', 'list', '--porcelain'])
  } catch {
    return undefined
  }
  let dir: string | undefined
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length).trim()
    else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === `refs/heads/${branch}`)
      return dir
  }
  return undefined
}

/**
 * Compara a base da versão com a branch principal e, SÓ quando o avanço é um
 * fast-forward, o executa. Roda inteira dentro do gitWorker (nenhum git no main
 * thread neste caminho) e nunca lança: todo tropeço vira um `outcome` legível.
 *
 * `mainBranchInput` ausente = a branch CHECADA NA RAIZ do projeto, que é
 * exatamente o alvo que o release da versão usa (writeVersionReleaseIntent) —
 * a mesma autoridade, para que "main" signifique a mesma coisa nos dois lugares.
 */
export function syncVersionBaseWithMain(
  projectPath: string,
  baseBranch: string,
  mainBranchInput?: string
): VersionBaseSyncResult {
  const base = typeof baseBranch === 'string' ? baseBranch.trim() : ''
  if (!base)
    return { outcome: 'unavailable', baseBranch: base, detail: 'a versão não tem branch registrada' }
  const main = mainBranchInput?.trim() || currentBranch(projectPath) || ''
  if (!main)
    return {
      outcome: 'unavailable',
      baseBranch: base,
      detail: 'não consegui identificar a branch principal do projeto (HEAD solto?)'
    }
  if (main === base)
    return { outcome: 'skipped', baseBranch: base, mainBranch: main, detail: 'a base da versão É a branch principal' }
  const baseSha = localBranchSha(projectPath, base)
  const mainSha = localBranchSha(projectPath, main)
  if (!baseSha || !mainSha)
    return {
      outcome: 'unavailable',
      baseBranch: base,
      mainBranch: main,
      detail: `não consegui resolver ${!baseSha ? base : main} neste repositório`
    }
  const common = { baseBranch: base, mainBranch: main, fromSha: baseSha, toSha: mainSha }
  if (baseSha === mainSha)
    return { ...common, outcome: 'up-to-date', ahead: 0, behind: 0 }
  // Contagem simétrica ANTES de qualquer decisão: `main...base` com
  // --left-right devolve "só na main" (o quanto a base está ATRÁS) e "só na
  // base" (o quanto ela está À FRENTE). Vale inclusive sem ancestral comum.
  let behind = 0
  let ahead = 0
  try {
    const [left, right] = git(projectPath, [
      'rev-list',
      '--left-right',
      '--count',
      `${mainSha}...${baseSha}`
    ]).split(/\s+/)
    behind = Number.parseInt(left, 10) || 0
    ahead = Number.parseInt(right, 10) || 0
  } catch {
    // sem contagem — o veredito abaixo não depende dela
  }
  // A MAIN dentro da base = versão À FRENTE: é o estado saudável de toda versão
  // que já recebeu missão. Chamar isso de divergência seria alarme falso a cada
  // missão criada, e a regra do adendo é o contrário: só falar quando há o que
  // decidir.
  if (isAncestorCommit(projectPath, mainSha, baseSha) === true)
    return { ...common, outcome: 'up-to-date', ahead, behind: 0 }
  const canFastForward = isAncestorCommit(projectPath, baseSha, mainSha)
  if (canFastForward === undefined)
    return { ...common, outcome: 'unavailable', ahead, behind, detail: 'o git não deu veredito de ancestralidade' }
  if (canFastForward === false)
    return {
      ...common,
      outcome: 'diverged',
      ahead,
      behind,
      detail: ahead
        ? `${ahead} commit(s) só na base e ${behind} só na ${main}`
        : `sem ancestral comum entre ${base} e ${main}`
    }
  const holder = checkedOutWorktreeDir(projectPath, base)
  if (holder) {
    // A base está CHECADA (o caso real: a branch da versão mora no worktree
    // dela). Mover só o ref deixaria os arquivos mentindo sobre o ref; o
    // fast-forward tem de acontecer POR LÁ.
    let dirty: string
    try {
      dirty = git(holder, ['status', '--porcelain', '--untracked-files=no'])
    } catch (error) {
      return { ...common, outcome: 'unavailable', ahead, behind, checkedOutIn: holder, detail: gitFailureText(error) }
    }
    if (dirty)
      return {
        ...common,
        outcome: 'blocked',
        ahead,
        behind,
        checkedOutIn: holder,
        detail: 'o worktree da versão tem alterações NÃO COMMITADAS — preservei-as e não avancei a base'
      }
    try {
      // --ff-only pelo SHA: nome de branch poderia ter andado entre a leitura e
      // esta linha, e o único avanço sancionado é o que foi provado acima.
      git(holder, ['merge', '--ff-only', mainSha])
    } catch (error) {
      return { ...common, outcome: 'blocked', ahead, behind, checkedOutIn: holder, detail: gitFailureText(error) }
    }
  } else {
    try {
      // Branch sem worktree: plumbing com COMPARE-AND-SWAP (o SHA velho é o
      // terceiro argumento) — se qualquer outro processo moveu o ref no meio,
      // o git recusa em vez de sobrescrever uma decisão alheia.
      git(projectPath, ['update-ref', `refs/heads/${base}`, mainSha, baseSha])
    } catch (error) {
      return { ...common, outcome: 'blocked', ahead, behind, detail: gitFailureText(error) }
    }
  }
  const landed = localBranchSha(projectPath, base)
  if (landed !== mainSha)
    return {
      ...common,
      outcome: 'blocked',
      ahead,
      behind,
      checkedOutIn: holder,
      detail: 'o avanço não pousou no ref — a base continua onde estava'
    }
  return { ...common, outcome: 'fast-forwarded', ahead: 0, behind, checkedOutIn: holder }
}

/**
 * Resolve o workspace de uma missão sem confundir repo quebrado com pasta sem
 * Git. Em projeto Git, somente o worktree canônico `mission/<id8>` é aceito.
 */
export function resolveMissionWorkspace(
  projectPath: string,
  missionId: string,
  branch?: string,
  worktree?: string
): string | undefined {
  if (!hasGitCommit(projectPath)) {
    return existsSync(join(projectPath, '.git')) || branch || worktree
      ? undefined
      : projectPath
  }
  const expectedBranch = `mission/${missionId.slice(0, 8)}`
  if (!branch || !worktree || branch !== expectedBranch) return undefined
  return isExpectedWorktree(projectPath, worktree, branch) ? worktree : undefined
}

/** Leitura AGRUPADA do caminho quente do missions:paneSpec (triagem
 * 2026-08-08, ESTADO 9 do PLANO_NIVEL_5.md): ~18 execFileSync de git
 * (excludes + hasGitCommit + isExpectedWorktree, com duplicações entre
 * ensureMissionWorktree e missionWorkspacePath) viravam ~450ms de MAIN
 * PARADO por missão na abertura do projeto. Esta função roda tudo numa
 * ÚNICA viagem ao gitWorker (gitOff). `healthy:false` = qualquer
 * divergência do estado saudável — o chamador cai no caminho completo
 * SÍNCRONO de sempre (promoção/reparo, raro); comportamento idêntico. */
export interface MissionWorkspaceReadout {
  healthy: boolean
  workspace?: string
  /** ensureSynkoraGitExcludes recusou (.synkora versionado): o chamador
   *  publica o erro legível e não abre o pane — mesmo contrato de hoje. */
  excludesError?: string
}

export function missionWorkspaceReadout(
  projectPath: string,
  missionId: string,
  branch?: string,
  worktree?: string
): MissionWorkspaceReadout {
  try {
    ensureSynkoraGitExcludes(projectPath)
  } catch (error) {
    return {
      healthy: false,
      excludesError: error instanceof Error ? error.message : String(error)
    }
  }
  if (!hasGitCommit(projectPath)) return { healthy: false }
  const expectedBranch = `mission/${missionId.slice(0, 8)}`
  if (!branch || !worktree || branch !== expectedBranch) return { healthy: false }
  if (!isExpectedWorktree(projectPath, worktree, branch)) return { healthy: false }
  return { healthy: true, workspace: worktree }
}

// ————— DIFF VIVO DA MISSÃO (2.0, onda D, item 4: o trilho rico) —————

export interface MissionWorkspaceFile {
  path: string
  /** A(dicionado) · M(odificado) · D(eletado) · R(enomeado) · '?' (ainda fora do git). */
  status: string
  /** ± do numstat, POR arquivo (RIGHTDOCK). Ausente = binário ou fora do git
   *  — a linha aparece sem número, nunca com número inventado. */
  insertions?: number
  deletions?: number
}

export interface MissionWorkspaceSummary {
  /** Commits desta branch à frente da base — o que a integração vai levar. */
  ahead: number
  insertions: number
  deletions: number
  files: MissionWorkspaceFile[]
}

/** Teto do payload: o trilho mostra uma lista, não um dump do repositório. */
const WORKSPACE_FILES_CAP = 400

/**
 * DE ONDE o diff vivo parte — FONTE ÚNICA do cabeçalho do trilho e do diff
 * por arquivo (divergir aqui faria o total dizer uma coisa e o arquivo aberto
 * dizer outra).
 *
 * merge-base e não a ponta da base: a base pode ter andado depois que a missão
 * nasceu, e diffar contra a ponta mostraria o trabalho DOS OUTROS como se
 * fosse desta missão. Sem base utilizável, 'HEAD' (só o não-committed).
 */
function missionDiffBaseRef(worktreeDir: string, baseBranch?: string): string {
  const base = baseBranch?.trim()
  if (!base) return 'HEAD'
  try {
    return git(worktreeDir, ['merge-base', base, 'HEAD']) || base
  } catch {
    return base
  }
}

/**
 * O que a missão MUDOU até agora, do ponto de vista do dono: commits à frente
 * da base + o diff da base até a ÁRVORE DE TRABALHO (committed E não
 * committed — o trilho é vivo, não uma foto do último commit).
 *
 * HONESTIDADE DO NÚMERO: insertions/deletions saem do `--numstat`, que só vê
 * arquivo RASTREADO. Arquivo novo ainda fora do git entra na LISTA com status
 * '?' e contribui 0/0 — melhor um total que se pode provar do que somar linhas
 * de qualquer arquivo que apareceu na pasta (binário, build, evidência).
 */
export function missionWorkspaceSummary(
  worktreeDir: string,
  baseBranch?: string
): MissionWorkspaceSummary | undefined {
  if (!existsSync(worktreeDir)) return undefined
  let ahead = 0
  const base = baseBranch?.trim()
  const from = missionDiffBaseRef(worktreeDir, baseBranch)
  if (base) {
    try {
      ahead = Number.parseInt(git(worktreeDir, ['rev-list', '--count', `${from}..HEAD`]), 10) || 0
    } catch {
      ahead = 0
    }
  }
  let insertions = 0
  let deletions = 0
  const files: MissionWorkspaceFile[] = []
  const seen = new Set<string>()
  // RIGHTDOCK: o numstat que já era lido fica POR ARQUIVO (antes os números
  // eram somados e jogados fora) — é o ±N −M de cada linha da seção TRABALHO.
  const perFile = new Map<string, { insertions: number; deletions: number }>()
  try {
    for (const line of git(worktreeDir, ['diff', '--numstat', from]).split(/\r?\n/)) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      // '-' nas duas colunas = binário: entra na lista, fora da soma.
      const fileInsertions = Number.parseInt(parts[0], 10) || 0
      const fileDeletions = Number.parseInt(parts[1], 10) || 0
      insertions += fileInsertions
      deletions += fileDeletions
      // Rename no numstat vem como `velho => novo` (às vezes com chaves no
      // meio): o que importa é o DESTINO, o mesmo path do name-status.
      const rawPath = parts.slice(2).join('\t')
      const arrow = rawPath.lastIndexOf(' => ')
      const path = (arrow >= 0 ? rawPath.slice(arrow + 4) : rawPath).replace(/[{}]/gu, '')
      perFile.set(path, { insertions: fileInsertions, deletions: fileDeletions })
    }
  } catch {
    // sem base utilizável — a lista abaixo ainda vale
  }
  try {
    for (const line of git(worktreeDir, ['diff', '--name-status', from]).split(/\r?\n/)) {
      const parts = line.split('\t').filter(Boolean)
      if (parts.length < 2) continue
      // Rename/copy vêm como `R100 velho novo`: o que importa é o destino.
      const path = parts[parts.length - 1]
      if (seen.has(path)) continue
      seen.add(path)
      const numbers = perFile.get(path)
      files.push({ path, status: parts[0].charAt(0), ...(numbers ?? {}) })
    }
  } catch {
    // idem
  }
  try {
    for (const line of git(worktreeDir, [
      'ls-files',
      '--others',
      '--exclude-standard'
    ]).split(/\r?\n/)) {
      const path = line.trim()
      if (!path || seen.has(path)) continue
      seen.add(path)
      files.push({ path, status: '?' })
    }
  } catch {
    // repositório sem index utilizável
  }
  return { ahead, insertions, deletions, files: files.slice(0, WORKSPACE_FILES_CAP) }
}

// ————— DIFF DE UM ARQUIVO (2.0, onda D: o dono clica e VÊ o que mudou) —————

export interface MissionWorkspaceFileDiff {
  ok: boolean
  /** Diff unificado já cortado no teto. String VAZIA = o arquivo existe e não
   *  mudou nada em relação à base — resposta legítima, não erro. */
  diff?: string
  /** O diff real passou do teto e o texto acima está cortado numa linha. */
  truncated?: boolean
  error?: string
}

/** O trilho abre UM arquivo, não despeja o repositório na tela: 200KB é muito
 *  mais do que qualquer revisão humana lê de uma vez. */
const FILE_DIFF_CAP = 200_000

/** Folga do buffer do processo (o padrão de 1MB do Node corta diff grande
 *  ANTES do nosso teto e vira ENOBUFS, que não tem stdout aproveitável). */
const FILE_DIFF_MAX_BUFFER = 16 * 1024 * 1024

/**
 * O caminho pedido tem que MORAR no worktree da missão. Função PURA — só
 * aritmética de path, nenhum toque no disco — devolvendo o caminho RELATIVO em
 * barras normais (a forma que o git aceita nos dois SOs) ou `undefined` quando
 * o pedido escapa.
 *
 * Por que cerca própria em vez de confiar no git: `git diff -- ../x` até recusa
 * ("outside repository"), mas `git diff --no-index -- /dev/null <absoluto>` NÃO
 * recusa NADA — leria qualquer arquivo da máquina. A cerca é aqui, antes de
 * qualquer processo nascer.
 */
export function resolveWorkspaceFilePath(
  worktreeDir: string,
  filePath: string
): string | undefined {
  const raw = typeof filePath === 'string' ? filePath.trim() : ''
  if (!raw || raw.includes('\0')) return undefined
  // Absoluto nunca vem do trilho (que lista caminhos relativos ao worktree), e
  // aceitá-lo é a metade fácil de um escape. Junto vão as formas do Windows que
  // o isAbsolute não pega: drive-relativo ("C:sem-barra") e UNC.
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//'))
    return undefined
  const root = resolve(worktreeDir)
  const target = resolve(root, raw)
  const rel = relative(root, target)
  // rel vazio = o próprio worktree (diretório, não arquivo); '..' em qualquer
  // forma = escape; absoluto = outro volume no Windows.
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

/** `git diff --no-index` sai com 1 QUANDO HÁ diferença — que é o caso normal
 *  aqui. Só o que o git realmente reprova (128 e afins) sobe como erro. */
function gitDiffOutput(cwd: string, args: string[]): string {
  try {
    return gitRaw(cwd, args, FILE_DIFF_MAX_BUFFER)
  } catch (error) {
    const failure = error as { status?: number; stdout?: string | Buffer }
    if (failure.status === 1 && failure.stdout != null) return String(failure.stdout)
    throw error
  }
}

function fileDiffFailure(error: unknown): string {
  const failure = error as { code?: string; stderr?: string | Buffer }
  if (failure.code === 'ENOBUFS') return 'o diff deste arquivo é grande demais para exibir aqui'
  const stderr = String(failure.stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return stderr ? `não consegui ler o diff: ${stderr}` : 'não consegui ler o diff deste arquivo'
}

function capFileDiff(raw: string): MissionWorkspaceFileDiff {
  if (raw.length <= FILE_DIFF_CAP) return { ok: true, diff: raw }
  const cut = raw.slice(0, FILE_DIFF_CAP)
  const lastBreak = cut.lastIndexOf('\n')
  // Cortar na linha: meia linha de diff mente sobre o conteúdo.
  return { ok: true, diff: lastBreak > 0 ? cut.slice(0, lastBreak + 1) : cut, truncated: true }
}

/**
 * O diff de UM arquivo do trilho, com a MESMA honestidade do cabeçalho:
 * merge-base(base, HEAD) até a ÁRVORE DE TRABALHO — committed E não committed,
 * porque o trilho é vivo e não uma foto do último commit.
 *
 * Arquivo ainda FORA do git (o status '?' da lista) não tem diff nenhum contra
 * a base; nesse caso o honesto é mostrá-lo INTEIRO como adição, que é o que
 * `--no-index` contra /dev/null produz — inclusive a linha "Binary files …
 * differ" quando não é texto, sem despejar bytes na tela.
 */
export function missionWorkspaceFileDiff(
  worktreeDir: string,
  filePath: string,
  baseBranch?: string
): MissionWorkspaceFileDiff {
  if (!existsSync(worktreeDir))
    return { ok: false, error: 'o worktree desta missão não existe mais' }
  const rel = resolveWorkspaceFilePath(worktreeDir, filePath)
  if (!rel) return { ok: false, error: 'caminho fora do worktree desta missão' }
  const from = missionDiffBaseRef(worktreeDir, baseBranch)
  // --no-color: config global do dono pode forçar cor e o payload é para uma
  // tela, não para um terminal. --no-ext-diff: difftool externo não roda aqui.
  let tracked: string
  try {
    tracked = gitDiffOutput(worktreeDir, ['diff', '--no-color', '--no-ext-diff', from, '--', rel])
  } catch (error) {
    return { ok: false, error: fileDiffFailure(error) }
  }
  if (tracked.trim()) return capFileDiff(tracked)
  // Vazio é ambíguo: "nada mudou neste arquivo" OU "o git não conhece este
  // arquivo". Só o segundo caso vira o diff-de-adição abaixo.
  if (!existsSync(join(worktreeDir, rel))) return { ok: true, diff: tracked }
  let known = ''
  try {
    known = git(worktreeDir, ['ls-files', '--', rel])
  } catch {
    known = ''
  }
  if (known) return { ok: true, diff: tracked }
  try {
    return capFileDiff(
      gitDiffOutput(worktreeDir, [
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--',
        '/dev/null',
        rel
      ])
    )
  } catch (error) {
    return { ok: false, error: fileDiffFailure(error) }
  }
}

export interface MissionCommit {
  /** SHA COMPLETO do commit. Nunca devolvemos um prefixo que o renderer possa
   *  reaproveitar como argumento Git ambíguo. */
  sha: string
  /** Pais completos, na ordem canônica do Git (primeiro pai primeiro). */
  parents: string[]
  /** Primeira linha da mensagem: `%s` NÃO contém quebra de linha, por
   *  definição, e é isso que mantém uma linha do log = um commit. */
  subject: string
  /** Data do AUTOR em ISO 8601 estrito (%aI). */
  at: string
  /** Nome de autoria do commit, sem e-mail/identificador pessoal. */
  author?: string
}

/** Teto do payload: o trilho lista o trabalho da missão, não o histórico do
 *  repositório. Missão que passar disso já é grande demais para caber num
 *  cabeçalho — a lista completa se lê no terminal do worktree. */
const MISSION_COMMITS_CAP = 50

/** Um patch é uma leitura humana, não um exportador de objetos Git. O teto é
 * aplicado depois de capturar stdout com folga, sempre em uma linha completa. */
const MISSION_COMMIT_PATCH_CAP = 200_000
const MISSION_COMMIT_PATCH_MAX_BUFFER = 16 * 1024 * 1024
const FULL_SHA = /^[0-9a-f]{40,64}$/i

export interface MissionCommitPatch {
  ok: boolean
  /** O SHA validado pelo main/worker, repetido para o renderer reconciliar a
   *  resposta com a linha que abriu o patch. */
  sha?: string
  diff?: string
  truncated?: boolean
  error?: string
}

function fullCommitSha(cwd: string, ref: string): string | undefined {
  if (!ref.trim()) return undefined
  try {
    const sha = gitRaw(cwd, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`
    ]).trim()
    return FULL_SHA.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

function missionBaseSha(cwd: string, baseBranch?: string): string | undefined {
  const base = baseBranch?.trim()
  // O endpoint é somente leitura, mas ainda assim nunca transforma ausência
  // de autoridade em "todo o histórico". Sem base, não há recorte de missão.
  return base ? fullCommitSha(cwd, base) : undefined
}

function commitPatchCap(raw: string, sha: string): MissionCommitPatch {
  if (raw.length <= MISSION_COMMIT_PATCH_CAP) return { ok: true, sha, diff: raw }
  const cut = raw.slice(0, MISSION_COMMIT_PATCH_CAP)
  const lastBreak = cut.lastIndexOf('\n')
  return {
    ok: true,
    sha,
    diff: lastBreak > 0 ? cut.slice(0, lastBreak + 1) : cut,
    truncated: true
  }
}

function missionCommitPatchFailure(error: unknown): string {
  const failure = error as { code?: string; stderr?: string | Buffer }
  if (failure.code === 'ENOBUFS') return 'o patch deste commit é grande demais para exibir aqui'
  const stderr = String(failure.stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return stderr ? `não consegui ler o patch: ${stderr}` : 'não consegui ler o patch deste commit'
}

function gitDiffRead(cwd: string, args: string[]): string {
  try {
    return gitRaw(cwd, args, MISSION_COMMIT_PATCH_MAX_BUFFER)
  } catch (error) {
    const failure = error as { status?: number; stdout?: string | Buffer }
    // `git diff` exits 1 for a non-empty patch. This is success for our
    // read-only endpoint, not an operational failure.
    if (failure.status === 1 && failure.stdout != null) return String(failure.stdout)
    throw error
  }
}

function isMissionCommit(cwd: string, baseSha: string, headSha: string, commitSha: string): boolean {
  try {
    // `commitSha` is full and has already been resolved as a commit object.
    // A commit belongs to `base..HEAD` iff it is reachable from HEAD and is
    // not reachable from the authoritative base. Keeping these checks in the
    // worker prevents a renderer-supplied SHA from widening the range.
    gitRaw(cwd, ['merge-base', '--is-ancestor', commitSha, headSha])
    try {
      gitRaw(cwd, ['merge-base', '--is-ancestor', commitSha, baseSha])
      return false
    } catch (error) {
      return (error as { status?: number }).status === 1
    }
  } catch {
    return false
  }
}

/**
 * Os commits que a missão ADICIONOU sobre a base, mais novos primeiro — a
 * lista por trás do `ahead` que o missionWorkspaceSummary conta em número.
 *
 * SEM merge-base DE PROPÓSITO, e isto NÃO é uma divergência do irmão: o range
 * `base..HEAD` já significa "alcançável de HEAD, não alcançável da base", que
 * é exatamente o recorte que o merge-base compra no `diff`. SONDADO (base
 * andando + missão mergeando a base + base andando de novo): as duas formas
 * dão a MESMA lista e nenhuma vaza commit de outra missão. O summary precisa
 * do merge-base porque `diff` compara duas ÁRVORES e mostraria o trabalho
 * alheio; `log` não. Um subprocesso a menos num caminho que o trilho consulta
 * com frequência — e, no caso patológico de merge-base múltiplo (criss-cross),
 * `base..HEAD` ainda é o recorte correto.
 *
 * `undefined` = não deu para ler (worktree sumiu, base inalcançável) e o
 * chamador diz isso ao dono; `[]` = leitura boa e a missão ainda não commitou
 * nada. Os dois são estados honestos e diferentes — nunca colapsar num só.
 */
export function missionCommits(
  worktreeDir: string,
  baseBranch?: string
): MissionCommit[] | undefined {
  if (!existsSync(worktreeDir)) return undefined
  const base = missionBaseSha(worktreeDir, baseBranch)
  // Sem base declarada não existe "à frente de quê": zero commits provados é a
  // resposta honesta, e é a mesma que o summary dá em `ahead`.
  if (!base && !baseBranch?.trim()) return []
  if (!base) return undefined
  // Separador 0x1f (unit separator) — `%x1f` no formato do git, o escape aqui:
  // nenhum byte de controle solto no fonte, que editor e diff comeriam calados.
  // A data vem ANTES do assunto de propósito: o resto da linha É o assunto
  // inteiro, então assunto com caractere exótico não desloca campo nenhum.
  const SEP = '\u001f'
  let out: string
  try {
    out = gitRaw(worktreeDir, [
      'log',
      `--max-count=${MISSION_COMMITS_CAP}`,
      '--topo-order',
      '--format=%H%x1f%P%x1f%aI%x1f%an%x1f%s',
      `${base}..HEAD`
    ])
  } catch {
    return undefined
  }
  const commits: MissionCommit[] = []
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue
    const first = line.indexOf(SEP)
    if (first < 0) continue
    const second = line.indexOf(SEP, first + 1)
    const third = second < 0 ? -1 : line.indexOf(SEP, second + 1)
    const fourth = third < 0 ? -1 : line.indexOf(SEP, third + 1)
    if (second < 0 || third < 0 || fourth < 0) continue
    const sha = line.slice(0, first)
    const parents = line
      .slice(first + 1, second)
      .split(/\s+/)
      .filter(Boolean)
    if (!FULL_SHA.test(sha) || parents.some((parent) => !FULL_SHA.test(parent))) continue
    commits.push({
      sha,
      parents,
      at: line.slice(second + 1, third),
      author: line.slice(third + 1, fourth),
      subject: line.slice(fourth + 1)
    })
  }
  return commits
}

/**
 * Patch do commit individual, sempre comparado ao PRIMEIRO pai (ou à árvore
 * vazia para um root commit). A autoridade vem do worktree/base da missão:
 * SHA curto, objeto fora de `base..HEAD`, ref arbitrária e caminho implícito
 * são recusados antes de qualquer `git diff`.
 */
export function missionCommitPatch(
  worktreeDir: string,
  baseBranch: string | undefined,
  commitShaInput: string
): MissionCommitPatch {
  if (!existsSync(worktreeDir)) return { ok: false, error: 'o worktree desta missão não existe mais' }
  const commitSha = typeof commitShaInput === 'string' ? commitShaInput.trim() : ''
  if (!FULL_SHA.test(commitSha)) {
    return { ok: false, error: 'o commit precisa ser identificado pelo SHA completo' }
  }
  const baseSha = missionBaseSha(worktreeDir, baseBranch)
  if (!baseSha) return { ok: false, error: 'não consegui provar a base desta missão' }
  const headSha = fullCommitSha(worktreeDir, 'HEAD')
  if (!headSha) return { ok: false, error: 'não consegui provar o HEAD desta missão' }
  const resolvedCommitSha = fullCommitSha(worktreeDir, commitSha)
  if (!resolvedCommitSha) {
    return { ok: false, error: 'esse SHA não identifica um commit neste worktree' }
  }
  if (!isMissionCommit(worktreeDir, baseSha, headSha, resolvedCommitSha)) {
    return { ok: false, error: 'esse commit não pertence ao histórico desta missão' }
  }
  let parents: string[]
  try {
    parents = gitRaw(worktreeDir, ['show', '-s', '--format=%P', resolvedCommitSha])
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  } catch (error) {
    return { ok: false, error: missionCommitPatchFailure(error) }
  }
  if (parents.some((parent) => !FULL_SHA.test(parent))) {
    return { ok: false, error: 'não consegui provar os pais completos deste commit' }
  }
  const parent = parents[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  try {
    const diff = gitDiffRead(worktreeDir, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--binary',
      parent,
      resolvedCommitSha,
      '--'
    ])
    return commitPatchCap(diff, resolvedCommitSha)
  } catch (error) {
    return { ok: false, sha: resolvedCommitSha, error: missionCommitPatchFailure(error) }
  }
}

/** Worktree de MISSÃO: branch mission/<id8> onde as tarefas da missão nascem
 *  e mergeiam — a main só vê a missão na integração final. */
export function missionWorktreeDescriptor(baseDir: string, missionId: string): TaskWorktree {
  const short = missionId.slice(0, 8)
  return { dir: join(baseDir, `mission-${short}`), branch: `mission/${short}` }
}

export function createMissionWorktree(
  projectPath: string,
  baseDir: string,
  missionId: string,
  /** Missões seguintes da mesma versão nascem da branch version/*, que já
   *  contém as entregas anteriores; ausente = HEAD atual da base. */
  baseRef?: string
): TaskWorktree | null {
  const { dir, branch } = missionWorktreeDescriptor(baseDir, missionId)
  try {
    if (existsSync(dir)) {
      if (!isExpectedWorktree(projectPath, dir, branch)) return null
      // REMONTAGEM: worktree criado antes da R15 ganha a mobília aqui — é o
      // único momento em que passamos por ele de novo.
      ensureNodeModulesLink(projectPath, dir)
      return { dir, branch }
    }
    mkdirSync(dirname(dir), { recursive: true })
    try {
      const args = ['worktree', 'add', '-b', branch, dir]
      if (baseRef) args.push(baseRef)
      git(projectPath, args)
    } catch {
      git(projectPath, ['worktree', 'prune'])
      git(projectPath, ['worktree', 'add', dir, branch])
    }
    if (!isExpectedWorktree(projectPath, dir, branch)) return null
    // O worktree nasce MOBILIADO: junction de node_modules para o store do
    // projeto (nodeModulesLink.ts). Falha de mobília não derruba a criação —
    // o retorno do ensure é diagnóstico, nunca condição.
    ensureNodeModulesLink(projectPath, dir)
    return { dir, branch }
  } catch {
    return null
  }
}

/** Worktree de VERSÃO (F4.0): branch version/<nome> onde as missões da versão
 *  INTEGRAM — a main só recebe quando o usuário manda SUBIR a versão. */
export function createVersionWorktree(
  projectPath: string,
  baseDir: string,
  versionName: string,
  /**
   * Identidade imutável das versões novas. Versões antigas já persistidas
   * continuam sendo aceitas pelo par branch/worktree salvo; a forma legada
   * baseada no nome permanece apenas para chamadas sem id.
   */
  versionId?: string
): TaskWorktree | null {
  const slug = versionName.replace(/[^A-Za-z0-9._-]/g, '-')
  const stableId = versionId?.trim()
  if (stableId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stableId)) return null
  const identity = stableId || slug
  if (!identity) return null
  const branch = `version/${identity}`
  const dir = join(baseDir, `version-${identity}`)
  try {
    if (existsSync(dir)) {
      if (!isExpectedWorktree(projectPath, dir, branch)) return null
      // Mesma remontagem da missão: versão aberta antes da R15 se mobilia aqui.
      ensureNodeModulesLink(projectPath, dir)
      return { dir, branch }
    }
    mkdirSync(dirname(dir), { recursive: true })
    try {
      git(projectPath, ['worktree', 'add', '-b', branch, dir])
    } catch {
      git(projectPath, ['worktree', 'prune'])
      git(projectPath, ['worktree', 'add', dir, branch])
    }
    if (!isExpectedWorktree(projectPath, dir, branch)) return null
    ensureNodeModulesLink(projectPath, dir)
    return { dir, branch }
  } catch {
    return null
  }
}

export interface MergeResult {
  ok: boolean
  detail: string
  /** O ref já contém o merge exato, mas o worktree de destino requer reparo. */
  committed?: boolean
  /** Receipt suficiente para alinhar o worktree sem apagar edição inesperada. */
  previousTargetHead?: string
  committedHead?: string
  /** Arquivos em conflito, quando o veredito veio do merge-tree. Dado ESTRUTURADO
   *  ao lado do `detail` em prosa — quem precisa contar (notificação de desktop
   *  da onda D) nunca deve fazer parsing de mensagem de UI. */
  conflictFiles?: string[]
  /** Destino integrado; a origem deve ser removida depois do recibo do chat. */
  sourceCleanupDeferred?: boolean
}

export interface MergeTargetSnapshot {
  sourceHead: string
  previousTargetHead: string
  targetBranch: string
  committedHead: string
}

export interface MergeWorktreeOptions {
  /** O chamador MCP ainda tem cwd na origem. Só adia a limpeza, nunca o merge. */
  deferSourceCleanup?: boolean
  /** Gate final: nunca transforme alterações posteriores aos gates em commit. */
  requireCleanSource?: boolean
  /** SHA imutável que foi validado/journalado e deve ser o único a entrar. */
  expectedSourceHead?: string
  /** Destino imutável; quando ambos existem, a atualização do ref usa CAS. */
  expectedTargetHead?: string
  expectedTargetBranch?: string
  /** Commit de merge já journalado antes de um restart; deve bater árvore e pais. */
  expectedMergeCommit?: string
  /** Journal síncrono gravado antes do CAS. Se falhar, o ref não é movido. */
  beforeTargetUpdate?: (snapshot: MergeTargetSnapshot) => void
}

/** Commita o que o executor mudou no worktree e integra no ALVO: a branch da
 *  missão (targetDir = worktree da missão) ou o repo principal (padrão). */
export function mergeTaskWorktree(
  projectPath: string,
  wt: TaskWorktree,
  message: string,
  targetDir?: string,
  options: MergeWorktreeOptions = {}
): MergeResult {
  const target = targetDir ?? projectPath
  // GUARDA: árvore de destino SUJA (alterações não commitadas — tipicamente
  // um agente manual editando direto na base) faria o merge falhar feio ou
  // misturar trabalho alheio. Recusa limpa com o motivo, branch preservada.
  try {
    const dirty = git(
      target,
      options.expectedTargetHead
        ? ['status', '--porcelain']
        : ['status', '--porcelain', '--untracked-files=no']
    )
    if (dirty) {
      return {
        ok: false,
        detail:
          'a árvore de destino tem alterações NÃO COMMITADAS (agente manual/edição direta na base?) — commit ou stash antes de integrar; branch preservada'
      }
    }
  } catch {
    // status falhou — deixa o merge reportar o erro real
  }
  const cleanup = (sourceHead?: string): boolean => {
    if (options.deferSourceCleanup) return true
    const approvedHead = options.expectedSourceHead ?? sourceHead
    // `--force` jamais pode apagar uma escrita que apareceu depois do gate.
    // Quando a origem é um snapshot aprovado, confira novamente imediatamente
    // antes da remoção. Se algo divergiu, o merge exato pode já ter pousado,
    // mas o worktree/branch fica preservado para reconciliação explícita.
    if (options.requireCleanSource) {
      if (
        !approvedHead ||
        gitHead(wt.dir) !== approvedHead ||
        isWorktreeClean(wt.dir) !== true
      ) {
        return false
      }
    }
    return removeWorktreeAndBranch(
      projectPath,
      wt.dir,
      wt.branch,
      options.requireCleanSource ? approvedHead : undefined
    )
  }
  let targetRefUpdated = false
  let previousTargetHead: string | undefined
  let committedTargetHead: string | undefined
  try {
    const status = git(wt.dir, ['status', '--porcelain'])
    if (status && options.requireCleanSource) {
      return {
        ok: false,
        detail:
          'a branch de origem mudou depois da validação (há arquivos não commitados) — nada foi integrado'
      }
    }
    if (status) {
      git(wt.dir, ['add', '-A'])
      git(wt.dir, ['commit', '-m', message])
    }
    const sourceHead = git(wt.dir, ['rev-parse', 'HEAD'])
    if (options.expectedSourceHead && sourceHead !== options.expectedSourceHead) {
      return {
        ok: false,
        detail: `a branch de origem avançou depois da validação (${options.expectedSourceHead.slice(0, 12)} → ${sourceHead.slice(0, 12)}) — nada foi integrado`
      }
    }
    const sourceRef = options.expectedSourceHead ?? wt.branch
    const targetHead = git(target, ['rev-parse', 'HEAD'])
    previousTargetHead = targetHead
    const targetBranch = git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (options.expectedTargetHead && targetHead !== options.expectedTargetHead) {
      return {
        ok: false,
        detail: `o destino avançou depois da validação (${options.expectedTargetHead.slice(0, 12)} → ${targetHead.slice(0, 12)}) — nada foi integrado`
      }
    }
    if (options.expectedTargetBranch && targetBranch !== options.expectedTargetBranch) {
      return {
        ok: false,
        detail: `a branch de destino mudou depois da validação (${options.expectedTargetBranch} → ${targetBranch}) — nada foi integrado`
      }
    }
    const ahead = git(target, ['rev-list', '--count', `${targetHead}..${sourceRef}`])
    if (ahead === '0') {
      if (!cleanup(sourceHead))
        return {
          ok: false,
          detail: 'sem mudanças para integrar, mas a limpeza do worktree ficou pendente'
        }
      return {
        ok: true,
        detail: 'sem mudanças para integrar',
        ...(options.deferSourceCleanup
          ? { sourceCleanupDeferred: true, committed: true, committedHead: targetHead, previousTargetHead: targetHead }
          : {})
      }
    }
    try {
      if (options.expectedTargetHead && options.expectedTargetBranch) {
        // Constrói o merge contra os DOIS SHAs validados e move a branch com
        // compare-and-swap. Se qualquer processo avançou o ref, update-ref
        // falha sem tocar na história; não existe merge contra um HEAD surpresa.
        const treeOutput = git(target, [
          'merge-tree',
          '--write-tree',
          options.expectedTargetHead,
          sourceRef
        ])
        const tree = treeOutput.split(/\r?\n/)[0]?.trim()
        if (!tree || !/^[0-9a-f]{40,64}$/i.test(tree))
          throw new Error('git merge-tree não devolveu uma árvore válida')
        let mergeCommit = options.expectedMergeCommit
        if (mergeCommit) {
          const recordedTree = git(target, ['show', '-s', '--format=%T', mergeCommit])
          const recordedParents = git(target, ['show', '-s', '--format=%P', mergeCommit])
          if (
            recordedTree !== tree ||
            recordedParents !== `${options.expectedTargetHead} ${sourceHead}`
          ) {
            throw new Error('o commit journalado não corresponde à árvore e aos pais validados')
          }
        } else {
          mergeCommit = git(target, [
            'commit-tree',
            tree,
            '-p',
            options.expectedTargetHead,
            '-p',
            sourceRef,
            '-m',
            `merge: ${message}`
          ])
        }
        committedTargetHead = mergeCommit
        options.beforeTargetUpdate?.({
          sourceHead,
          previousTargetHead: options.expectedTargetHead,
          targetBranch: options.expectedTargetBranch,
          committedHead: mergeCommit
        })
        git(target, [
          'update-ref',
          `refs/heads/${options.expectedTargetBranch}`,
          mergeCommit,
          options.expectedTargetHead
        ])
        targetRefUpdated = true
        // O ref foi atualizado por plumbing; alinha índice/arquivos do
        // worktree limpo ao novo commit. A atualização do ref acima já é CAS.
        git(target, ['reset', '--merge', mergeCommit])
        if (git(target, ['status', '--porcelain'])) {
          throw new Error(
            'o ref foi atualizado, mas apareceram arquivos locais no destino; eles foram preservados'
          )
        }
      } else {
        git(target, ['merge', '--no-ff', sourceRef, '-m', `merge: ${message}`])
      }
    } catch (e) {
      try {
        git(target, ['merge', '--abort'])
      } catch {
        // nada para abortar
      }
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
      return {
        ok: false,
        detail: targetRefUpdated
          ? `o merge exato foi gravado, mas o worktree do destino não pôde ser alinhado (${msg.slice(0, 160)}) — intent e branch foram preservados para reparo`
          : `conflito no merge (${msg.slice(0, 160)}) — branch ${wt.branch} mantida para resolução manual`,
        committed: targetRefUpdated || undefined,
        previousTargetHead: targetRefUpdated ? previousTargetHead : undefined,
        committedHead: targetRefUpdated ? committedTargetHead : undefined
      }
    }
    if (!cleanup(sourceHead)) {
      return {
        ok: false,
        detail: targetRefUpdated
          ? 'o merge exato foi gravado, mas a limpeza do worktree isolado ficou pendente'
          : 'o merge terminou, mas a limpeza do worktree isolado ficou pendente',
        committed: targetRefUpdated || undefined,
        previousTargetHead: targetRefUpdated ? previousTargetHead : undefined,
        committedHead: targetRefUpdated ? committedTargetHead : undefined
      }
    }
    return {
      ok: true,
      detail: `branch ${wt.branch} integrada`,
      ...(options.deferSourceCleanup
        ? { sourceCleanupDeferred: true, committed: true, committedHead: committedTargetHead, previousTargetHead }
        : {})
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    return { ok: false, detail: msg.slice(0, 200) }
  }
}

/** PRÉ-CHECAGEM do merge da missão SEM tocar no destino (git merge-tree
 *  --write-tree, in-memory): exige a fotografia já commitada, recusa destino
 *  sujo e testa CONFLITO antes de qualquer ação irreversível.
 *  Existe pela ORDEM do fluxo direto (caso real 2026-07-30: o conflito
 *  chegava com o orquestrador já morto — quem ia resolver?): só se mata o
 *  orquestrador quando o merge VAI acontecer. Git < 2.38 (sem --write-tree)
 *  → ok:true e o merge real decide. */
export function missionMergePrecheck(
  projectPath: string,
  wt: TaskWorktree,
  message: string,
  targetDir?: string,
  expectedSourceHead?: string
): MergeResult {
  const target = targetDir ?? projectPath
  try {
    const status = git(wt.dir, ['status', '--porcelain'])
    if (status) {
      return {
        ok: false,
        detail:
          'a branch da missão contém alterações não commitadas depois dos gates — nada foi integrado'
      }
    }
    const sourceHead = git(wt.dir, ['rev-parse', 'HEAD'])
    if (expectedSourceHead && sourceHead !== expectedSourceHead) {
      return {
        ok: false,
        detail: `o código da missão mudou depois de entrar na fila (${expectedSourceHead.slice(0, 12)} → ${sourceHead.slice(0, 12)})`
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    return { ok: false, detail: `não consegui validar a fotografia da missão: ${msg.slice(0, 160)}` }
  }
  try {
    const dirty = git(target, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty)
      return {
        ok: false,
        detail:
          'a árvore de destino tem alterações NÃO COMMITADAS (agente manual/edição direta na base?) — commit ou stash antes de integrar'
      }
  } catch {
    // status falhou — deixa o merge real reportar
  }
  // CERCA DO RUNTIME na última porteira (02/08): a missão nunca entrega
  // .synkora/** versionado para o destino — o caso real armou o guard de
  // runtime na master e travou o projeto inteiro. O diff aqui pega inclusive
  // commits feitos direto na branch da missão, fora de card.
  try {
    const runtimePaths = git(target, [
      'diff',
      '--name-only',
      `HEAD...${expectedSourceHead ?? wt.branch}`,
      '--',
      '.synkora'
    ])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (runtimePaths.length > 0) {
      return {
        ok: false,
        detail:
          `a branch da missão VERSIONA runtime do Synkora (${runtimePaths.slice(0, 4).join(', ')}` +
          `${runtimePaths.length > 4 ? ` +${runtimePaths.length - 4}` : ''}) — ` +
          `rode git rm --cached -r nesses paths na branch da missão, commite e re-integre; .synkora/** nunca entra no repositório`
      }
    }
  } catch {
    // diff indisponível — o merge real segue; a cerca do report já cobriu os cards
  }
  try {
    git(target, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      'HEAD',
      expectedSourceHead ?? wt.branch
    ])
    return { ok: true, detail: 'merge limpo' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    // contrato do merge-tree: exit 1 = CONFLITO (1ª linha = OID, depois os
    // arquivos conflitados); outros códigos = sem veredito (git velho etc.)
    if (err.status === 1) {
      // Formato do `merge-tree --write-tree` em conflito: OID, depois os
      // ARQUIVOS até a primeira linha em branco, e daí em diante mensagens
      // informativas ("CONFLICT (content): …"). Cortar na linha em branco é o
      // que impede a prosa de inflar a contagem estruturada (achado R9).
      const body = (err.stdout ?? '').split('\n').slice(1)
      const blank = body.findIndex((line) => !line.trim())
      const conflictFiles = (blank === -1 ? body : body.slice(0, blank))
        .map((l) => l.trim())
        .filter(Boolean)
      const files = conflictFiles.slice(0, 6).join(', ')
      return {
        ok: false,
        conflictFiles,
        detail: `CONFLITO com o destino${files ? ` em: ${files.slice(0, 200)}` : ''} — traga a base para a branch da missão (merge da base) e resolva antes de integrar`
      }
    }
    return { ok: true, detail: 'pré-checagem indisponível — o merge real decide' }
  }
}

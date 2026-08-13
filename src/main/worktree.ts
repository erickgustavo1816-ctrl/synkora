import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { freshWindowsPath } from './winPath'

// Worktree por tarefa (F3): cada execução roda em worktrees/<task> numa branch
// task/<id>; aprovada nos dois gates, o main integra com merge --no-ff e limpa.
// Projeto sem git (ou sem commit) cai no modo direto — executa no próprio dir.

function gitRaw(cwd: string, args: string[], maxBuffer?: number): string {
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

/** Árvore imutável de um commit. O SHA da árvore permite provar que review,
 * QA e integração observaram exatamente o mesmo conteúdo, não apenas uma
 * working tree que poderia continuar recebendo escritas em segundo plano. */
export function gitTree(cwd: string, ref = 'HEAD'): string | undefined {
  try {
    const tree = git(cwd, ['show', '-s', '--format=%T', ref])
    return /^[0-9a-f]{40,64}$/i.test(tree) ? tree : undefined
  } catch {
    return undefined
  }
}

/** Merge-base validado como SHA; refs potencialmente não confiáveis nunca são
 * interpolados em comandos entregues a agentes/terminais. */
export function gitMergeBase(
  cwd: string,
  left: string,
  right: string
): string | undefined {
  try {
    const base = git(cwd, ['merge-base', left, right])
    return /^[0-9a-f]{40,64}$/i.test(base) ? base : undefined
  } catch {
    return undefined
  }
}

/** Fatos da fotografia imutável do dev (subset de verification.dev) — dados
 * puros para viajar ao worker: nada de Task aqui dentro. */
export interface DevSnapshotFacts {
  head?: string
  tree?: string
  fingerprint?: string
  baseHead?: string
}

/** Checagens da FOTOGRAFIA IMUTÁVEL da entrega numa passada só — uma viagem ao
 * worker via gitOff em vez de cinco. Fase 2 (F2-c5): o advancePhase virou
 * ASSÍNCRONO e a atomicidade do veredito vem da SERIALIZAÇÃO por card
 * (PhaseTransitionLock), não mais da sincronicidade — este corpo roda no
 * WORKER dentro de gateVerdictFacts/quarantineAndRevalidate. A cicatriz
 * continua valendo a cada await esquecido: uma Promise não-aguardada tratada
 * como string de problema vira "[object Promise]" e invalida todo gate (bug
 * real 2026-08-05). Devolve o problema em PT-BR (o texto viaja ao usuário no
 * veredito) ou undefined quando a fotografia segue exata. */
export function snapshotProblemFor(
  cwd: string,
  snap: DevSnapshotFacts,
  requireBase: boolean
): string | undefined {
  if (!snap.head || !snap.tree || !snap.fingerprint) {
    return 'a entrega ainda não possui um commit imutável produzido antes dos gates'
  }
  if (
    requireBase &&
    (!snap.baseHead ||
      !/^[0-9a-f]{40,64}$/i.test(snap.baseHead) ||
      gitMergeBase(cwd, snap.head, snap.baseHead) !== snap.baseHead)
  ) {
    return 'a entrega não possui uma base imutável/ancestral válida para o diff do reviewer'
  }
  const head = gitHead(cwd)
  if (head !== snap.head) {
    return `a branch avançou depois da entrega (${snap.head.slice(0, 12)} → ${head?.slice(0, 12) ?? 'desconhecido'})`
  }
  if (gitTree(cwd, snap.head) !== snap.tree) {
    return 'a árvore Git da entrega não corresponde à fotografia registrada'
  }
  if (isWorktreeClean(cwd) !== true) {
    // NOMEAR os culpados (CHECK 16, 2026-08-07: o motivo genérico custou um
    // dia de caça — evidência untracked de gate e tracked sujo por migração
    // no boot do produto são doenças OPOSTAS, e só o nome do arquivo as
    // distingue de primeira).
    const dirty = git(cwd, ['status', '--porcelain'])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(' · ')
    return `há arquivos não commitados criados depois da entrega do dev${
      dirty ? ` — culpados: ${dirty.slice(0, 400)}` : ''
    }`
  }
  if (gitVisibleWorktreeFingerprint(cwd) !== snap.fingerprint) {
    return 'a fotografia Git mudou depois da entrega do dev'
  }
  return undefined
}

/** QUARENTENA DE EVIDÊNCIA (item 20, 2026-08-06): move arquivos NOVOS
 * untracked (não-ignorados) para fora do worktree — o que se integra é o
 * COMMIT e untracked nunca entra no merge; anular um veredito por screenshot
 * de gate custou uma aprovação visual genuína. SÓ age quando NADA rastreado
 * mudou (tracked sujo = drift real, não evidência) — EXCETO modificação
 * não-staged dentro da allowlist de RUNTIME declarado (`tolerateRuntimePaths`,
 * 2026-08-11: divergência MISTA "?? screenshot na raiz + M data/* de runtime"
 * travava as duas válvulas mutuamente e invalidou um veredito de QA aprovado
 * no mérito; a quarentena tolera a classe do restore e o restore, rodando em
 * seguida sobre a árvore já sem os untracked, limpa o resto). Devolve os
 * paths movidos. */
export function quarantineUntrackedNew(
  cwd: string,
  quarantineDir: string,
  tolerateRuntimePaths: string[] = []
): string[] {
  try {
    const tolerated = tolerateRuntimePaths
      .map(normalizeRuntimePattern)
      .filter((p): p is string => Boolean(p))
    const trackedDirt = git(cwd, ['status', '--porcelain', '-uno'])
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
    for (const line of trackedDirt) {
      const xy = line.slice(0, 2)
      const rel = line.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/')
      // Só a assinatura exata de runtime-de-app-rodando é tolerada (' M' na
      // allowlist); qualquer outra sujeira rastreada segue sendo drift real.
      if (xy !== ' M' || !rel || !matchesRuntimePattern(rel.replace(/\/+$/, ''), tolerated))
        return []
    }
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard'])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (untracked.length === 0) return []
    const moved: string[] = []
    for (const rel of untracked) {
      const from = join(cwd, rel)
      const to = join(quarantineDir, rel)
      try {
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
        moved.push(rel)
      } catch {
        // arquivo travado/aberto: fica — a revalidação decide o veredito
      }
    }
    return moved
  } catch {
    return []
  }
}

// ————————————————————————————————————————————————————————————————————————
// PACOTES DE FATOS DO VEREDITO (Fase 2 do nível 5, docs/FASE2_PLANO.md §4.1):
// o advancePhase assíncrono consome ESTAS funções via gitOff — os fatos de
// cada ramo viajam ao worker numa viagem só (o mesmo racional que criou o
// snapshotProblemFor: "uma viagem em vez de cinco"). Conversão 1:1 viraria
// 6-7 round-trips serializados no worker único (risco R10 do mapa
// FASE2_MAPA_VEREDITO). Sem consumidor até o F2-c5 — comportamento zero.

/** Preâmbulo do veredito de GATE numa viagem: fingerprint final da árvore,
 * problema de fotografia (fonte única snapshotProblemFor) e head atual (a
 * condição de entrada da quarentena de evidência). */
export interface GateVerdictFacts {
  fingerprint: ReturnType<typeof gitVisibleWorktreeFingerprint>
  snapshotProblem: string | undefined
  head: ReturnType<typeof gitHead>
}

export function gateVerdictFacts(
  cwd: string,
  snap: DevSnapshotFacts,
  requireBase: boolean
): GateVerdictFacts {
  return {
    fingerprint: gitVisibleWorktreeFingerprint(cwd),
    snapshotProblem: snapshotProblemFor(cwd, snap, requireBase),
    head: gitHead(cwd)
  }
}

/** Quarentena de evidência + REVALIDAÇÃO na mesma viagem (a 2ª e última do
 * ramo de gate — só dispara quando há divergência com head intacto).
 * `fingerprint`/`snapshotProblem` só têm significado quando `moved` não é
 * vazio; sem nada movido, o chamador mantém os valores da 1ª viagem. */
export interface QuarantineRevalidation {
  moved: string[]
  fingerprint: ReturnType<typeof gitVisibleWorktreeFingerprint>
  snapshotProblem: string | undefined
}

export function quarantineAndRevalidate(
  cwd: string,
  quarantineDir: string,
  snap: DevSnapshotFacts,
  requireBase: boolean,
  tolerateRuntimePaths: string[] = []
): QuarantineRevalidation {
  const moved = quarantineUntrackedNew(cwd, quarantineDir, tolerateRuntimePaths)
  if (moved.length === 0) {
    return { moved, fingerprint: undefined, snapshotProblem: undefined }
  }
  return {
    moved,
    fingerprint: gitVisibleWorktreeFingerprint(cwd),
    snapshotProblem: snapshotProblemFor(cwd, snap, requireBase)
  }
}

/** T9 (2026-08-10, loop real de 4 ciclos no teste de missões): o RUNTIME do
 * produto suja arquivos RASTREADOS enquanto o gate read-only roda o app —
 * o gate não pode limpar, o veredito era descartado e o card voltava ao dev
 * que nada tinha a corrigir. Com a allowlist DECLARADA
 * (declare_runtime_paths), divergência composta APENAS de arquivos
 * rastreados MODIFICADOS dentro dela é RESTAURADA ao commit julgado e a
 * fotografia revalidada. Restaurar ≠ aceitar: o que integra é o commit
 * entregue, e QUALQUER divergência fora da allowlist (arquivo de fora,
 * staged, deleção, rename) mantém a invalidação integral — a cerca contra
 * gate-que-edita-código continua inteira. */
export interface RuntimeRestoreRevalidation {
  restored: string[]
  fingerprint: ReturnType<typeof gitVisibleWorktreeFingerprint>
  snapshotProblem: string | undefined
  /** Por que NADA foi restaurado (2026-08-11, caso real M09 23:04: culpados
   *  100% dentro da allowlist e o veredito caiu mesmo assim — o skip era
   *  silencioso e indiagnosticável pelo journal). */
  skipReason?: string
}

function normalizeRuntimePattern(pattern: string): string | undefined {
  const clean = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!clean || clean.includes('..') || clean.startsWith('/') || /^[a-z]:/i.test(clean))
    return undefined
  if (clean === '.git' || clean.startsWith('.git/')) return undefined
  return clean.replace(/\/+$/, '')
}

function matchesRuntimePattern(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => rel === p || rel.startsWith(`${p}/`))
}

export function restoreRuntimeAndRevalidate(
  cwd: string,
  snap: DevSnapshotFacts,
  requireBase: boolean,
  runtimePaths: string[]
): RuntimeRestoreRevalidation {
  const none = (skipReason: string): RuntimeRestoreRevalidation => ({
    restored: [],
    fingerprint: undefined,
    snapshotProblem: undefined,
    skipReason
  })
  const patterns = runtimePaths
    .map(normalizeRuntimePattern)
    .filter((p): p is string => Boolean(p))
  if (patterns.length === 0) return none('allowlist vazia após normalização')
  let status: string
  try {
    status = git(cwd, ['status', '--porcelain'])
  } catch {
    return none('git status falhou no worktree')
  }
  const lines = status.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return none('árvore já estava limpa')
  const modified: string[] = []
  const born: string[] = []
  for (const line of lines) {
    // Assinaturas de app gravando em runtime: ' M' (rastreado modificado,
    // não-staged) e '??' (arquivo NOVO — caso real 2026-08-10: data/notes.json
    // nascia no primeiro uso e derrubava o veredito mesmo com a allowlist,
    // achado pelo próprio orquestrador). Staged/deleção/rename = não é
    // runtime de app rodando; nada se restaura (sem mascarar).
    const xy = line.slice(0, 2)
    const rel = line.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/')
    if (!rel || !matchesRuntimePattern(rel.replace(/\/+$/, ''), patterns))
      return none(`divergência FORA da allowlist: "${line.slice(0, 120)}"`)
    if (xy === ' M') modified.push(rel)
    else if (xy === '??') born.push(rel)
    else return none(`assinatura não-runtime (staged/deleção/rename): "${line.slice(0, 120)}"`)
  }
  try {
    if (modified.length > 0) git(cwd, ['checkout', '--', ...modified])
    for (const rel of born) {
      // '??' pode ser diretório inteiro novo ("data/cache/") — remove fundo.
      rmSync(join(cwd, rel), { recursive: true, force: true })
    }
  } catch (error) {
    return none(
      'restauração falhou (checkout/rm): ' +
        (error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160))
    )
  }
  // A restauração precisa devolver a árvore EXATAMENTE limpa — sobra
  // qualquer coisa, nada foi "consertado" e a invalidação normal continua.
  const leftover = git(cwd, ['status', '--porcelain']).trim()
  if (leftover !== '')
    return none(`árvore não ficou limpa após restaurar: "${leftover.slice(0, 160)}"`)
  return {
    restored: [...modified, ...born],
    fingerprint: gitVisibleWorktreeFingerprint(cwd),
    snapshotProblem: snapshotProblemFor(cwd, snap, requireBase)
  }
}

/** Fatos da entrega do DEV numa viagem: re-checagem da fotografia
 * (head/tree/limpo/fingerprint contra o devSnapshot), fingerprint EFETIVO da
 * entrega e paths mudados contra a base. `baseRef` explícito (baseHead da
 * fotografia ou branch da missão) vence; sem ele, a branch atual de
 * `branchProbePath` (o caminho do PROJETO — tarefa solta). Fotografia
 * INCOMPLETA (sem head/tree/fingerprint) conta como drift — mais estrito que
 * o inline antigo no caso exótico de snapshot parcial, de propósito. */
export interface DevDeliveryFacts {
  snapshotStillExact: boolean
  fingerprint: ReturnType<typeof gitVisibleWorktreeFingerprint>
  baseRef: string | undefined
  changedPaths: ReturnType<typeof changedWorktreeFiles> | undefined
}

export function devDeliveryFacts(
  cwd: string,
  snapshot: { head?: string; tree?: string; fingerprint?: string } | undefined,
  opts: { hasWorktree: boolean; baseRef?: string; branchProbePath?: string }
): DevDeliveryFacts {
  let fingerprintNow: ReturnType<typeof gitVisibleWorktreeFingerprint>
  let fingerprintScanned = false
  const currentFingerprint = (): ReturnType<typeof gitVisibleWorktreeFingerprint> => {
    if (!fingerprintScanned) {
      fingerprintScanned = true
      fingerprintNow = gitVisibleWorktreeFingerprint(cwd)
    }
    return fingerprintNow
  }
  const snapshotStillExact = Boolean(
    !opts.hasWorktree ||
      (snapshot?.head &&
        snapshot.tree &&
        snapshot.fingerprint &&
        gitHead(cwd) === snapshot.head &&
        gitTree(cwd, snapshot.head) === snapshot.tree &&
        isWorktreeClean(cwd) === true &&
        currentFingerprint() === snapshot.fingerprint)
  )
  const baseRef =
    opts.baseRef ?? (opts.branchProbePath ? currentBranch(opts.branchProbePath) : undefined)
  return {
    snapshotStillExact,
    fingerprint: snapshot?.fingerprint ?? currentFingerprint(),
    baseRef,
    changedPaths: baseRef ? changedWorktreeFiles(cwd, baseRef) : undefined
  }
}

export interface TaskWorktreeSnapshot {
  ok: boolean
  detail: string
  head?: string
  tree?: string
  fingerprint?: string
}

/**
 * Congela a entrega do dev na própria branch isolada ANTES dos gates.
 *
 * O commit não roda hooks: hooks pertencem à validação do projeto, enquanto
 * esta operação é apenas o envelope imutável que review e QA irão inspecionar.
 * Qualquer escrita concorrente/posterior deixa o worktree sujo e faz a
 * operação falhar; os arquivos permanecem no worktree para o dev reconciliar.
 */
export function snapshotTaskWorktree(
  cwd: string,
  message: string
): TaskWorktreeSnapshot {
  try {
    const status = git(cwd, ['status', '--porcelain'])
    if (status) {
      const branchRef = git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])
      const previousHead = git(cwd, ['rev-parse', '--verify', 'HEAD'])
      if (!branchRef.startsWith('refs/heads/')) {
        return { ok: false, detail: 'a branch isolada do card não pôde ser identificada' }
      }
      git(cwd, ['add', '-A'])
      const tree = git(cwd, ['write-tree'])
      const commit = git(cwd, [
        '-c',
        'user.name=Synkora',
        '-c',
        'user.email=synkora@local',
        '-c',
        'commit.gpgSign=false',
        'commit-tree',
        tree,
        '-p',
        previousHead,
        '-m',
        message
      ])
      // Move somente a branch que ainda aponta para o pai fotografado. Nenhum
      // hook é executado e um commit concorrente faz o CAS falhar sem overwrite.
      git(cwd, ['update-ref', branchRef, commit, previousHead])
    }
    const head = git(cwd, ['rev-parse', '--verify', 'HEAD'])
    const tree = gitTree(cwd, head)
    const clean = git(cwd, ['status', '--porcelain']).length === 0
    const fingerprint = clean ? gitVisibleWorktreeFingerprint(cwd) : undefined
    if (!clean || !tree || !fingerprint) {
      return {
        ok: false,
        detail:
          'arquivos mudaram enquanto a fotografia era criada; preservei tudo para o dev conferir e reportar novamente',
        head,
        tree
      }
    }
    return {
      ok: true,
      detail: status ? 'entrega congelada em commit isolado' : 'commit isolado já estava limpo',
      head,
      tree,
      fingerprint
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return {
      ok: false,
      detail: `não foi possível congelar a entrega (${detail.slice(0, 180)})`
    }
  }
}

/** Prova de que uma integração identificada já alcançou o destino. O
 * marcador é gerado pelo Synkora a partir do UUID do card e entregue ao Git
 * como argumento literal, nunca como regex de shell. */
export function gitHistoryContainsMessage(cwd: string, marker: string): boolean {
  if (!marker.trim()) return false
  try {
    return Boolean(
      git(cwd, [
        'log',
        '--fixed-strings',
        `--grep=${marker}`,
        '-1',
        '--format=%H'
      ])
    )
  } catch {
    return false
  }
}

/** Confirma que o HEAD atual é justamente o snapshot criado pelo harness. */
export function gitHeadContainsMessage(cwd: string, marker: string): boolean {
  if (!marker.trim()) return false
  try {
    return git(cwd, ['show', '-s', '--format=%B', 'HEAD']).includes(marker)
  } catch {
    return false
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

export type ExecutableProjectPathKind =
  | 'source'
  | 'automation'
  | 'sensitive-config'

/**
 * Classifica paths capazes de mudar o comportamento executável do projeto.
 * Além de código, cobre manifests, lockfiles, CI/deploy, hooks e configurações
 * sensíveis que não podem passar como um simples documento/asset `non_code`.
 */
export function executableProjectPathKind(
  projectPath: string
): ExecutableProjectPathKind | undefined {
  const normalized = projectPath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .toLocaleLowerCase('en-US')
  if (!normalized) return undefined
  if (normalized.includes('\0')) return 'sensitive-config'
  // Falha fechada para um path que tente escapar da raiz.
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return 'sensitive-config'
  }
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  const extension = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : ''
  if (
    SENSITIVE_AUTOMATION_PATH.test(normalized) &&
    !INERT_DOCUMENT_ASSET_EXTENSIONS.has(extension)
  ) return 'automation'
  if (
    SENSITIVE_CONFIG_NAMES.has(basename) ||
    /^\.env(?:\.|$)/.test(basename) ||
    /^\.(?:babelrc|eslintrc|prettierrc|stylelintrc)(?:\.|$)/.test(basename) ||
    /^(?:dockerfile|taskfile)(?:\.|$)/.test(basename) ||
    /^(?:babel|electron-builder|eslint|next|nuxt|rollup|svelte|vite|webpack)\.config(?:\.|$)/.test(basename) ||
    /^(?:build|settings)\.gradle(?:\.kts)?$/.test(basename) ||
    /^requirements(?:[-_.].+)?\.txt$/.test(basename) ||
    /^tsconfig(?:\..+)?\.json$/.test(basename)
  ) {
    return 'sensitive-config'
  }
  if (EXECUTABLE_SOURCE_EXTENSIONS.has(extension)) return 'source'
  // JSON/YAML/TOML e arquivos de projeto podem dirigir runtime, dependências
  // ou contratos. Reclassificar é mais seguro do que pular os gates.
  if (SENSITIVE_CONFIG_EXTENSIONS.has(extension)) return 'sensitive-config'
  return undefined
}

export function isExecutableProjectPath(projectPath: string): boolean {
  return executableProjectPathKind(projectPath) !== undefined
}

function nulSeparatedPaths(value: string): string[] {
  return value
    .split('\0')
    .filter(Boolean)
}

function changedPathsSinceBase(
  worktreePath: string,
  baseRef: string,
  includeDeleted: boolean
): string[] | undefined {
  try {
    const headBranch = git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (baseRef === headBranch || baseRef === `refs/heads/${headBranch}`) return undefined
    const mergeBase = git(worktreePath, ['merge-base', 'HEAD', baseRef])
    if (!mergeBase) return undefined
    const changed = nulSeparatedPaths(
      gitRaw(worktreePath, [
        'diff',
        '--name-only',
        '-z',
        // Sem rename, a lista geral preserva origem e destino. Renomear
        // source.ts para nota.md continua contando como tocar código.
        ...(includeDeleted ? ['--no-renames'] : []),
        `--diff-filter=${includeDeleted ? 'ACDMRTUXB' : 'ACMRTUXB'}`,
        mergeBase,
        '--'
      ])
    )
    const untracked = nulSeparatedPaths(
      gitRaw(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
    )
    return [...new Set([...changed, ...untracked])]
      .sort((left, right) => left.localeCompare(right, 'en'))
  } catch {
    return undefined
  }
}

/**
 * Todos os paths alterados desde a base comum, incluindo commits da branch,
 * staged, unstaged, untracked, deletes e os dois lados de um rename. Arquivos
 * ignorados não entram. `undefined` significa base Git não confiável.
 */
export function changedWorktreeFiles(
  worktreePath: string,
  baseRef: string
): string[] | undefined {
  return changedPathsSinceBase(worktreePath, baseRef, true)
}

/** Arquivos TS/JS que o worktree alterou desde a base comum com `baseRef`.
 *  O diff contra o merge-base inclui commits da branch e mudanças staged ou
 *  locais; arquivos untracked entram por uma consulta separada. `undefined`
 *  significa que o Git/base não estava disponível e o chamador deve degradar
 *  para uma verificação sem conhecimento do diff. Arquivos removidos ficam de
 *  fora porque não há documento restante para consultar no language server. */
export function changedWorktreeCodeFiles(
  worktreePath: string,
  baseRef: string
): string[] | undefined {
  try {
    const headBranch = git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (baseRef === headBranch || baseRef === `refs/heads/${headBranch}`) {
      // Execução direta no próprio branch-base: não existe um marco inicial
      // persistido para separar commits da tarefa, então o gate deve usar o
      // histórico owner-wide em vez de concluir incorretamente que o diff é vazio.
      return undefined
    }
    const mergeBase = git(worktreePath, ['merge-base', 'HEAD', baseRef])
    if (!mergeBase) return undefined
    const changed = nulSeparatedPaths(
      gitRaw(worktreePath, [
        'diff',
        '--name-only',
        '-z',
        '--diff-filter=ACMRTUXB',
        mergeBase,
        '--'
      ])
    )
    const untracked = nulSeparatedPaths(
      gitRaw(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
    )
    return [...new Set([...changed, ...untracked])]
      .filter((path) => TYPESCRIPT_JAVASCRIPT_EXTENSION.test(path))
      .sort((a, b) => a.localeCompare(b, 'en'))
  } catch {
    return undefined
  }
}

function fingerprintField(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer
): void {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  hash.update(`${label}\0${body.byteLength}\0`, 'utf8')
  hash.update(body)
  hash.update('\0', 'utf8')
}

/**
 * Fotografia determinística do estado visível ao Git: HEAD/ref, status, index,
 * diff staged/unstaged e conteúdo de untracked não ignorados. Ignorados ficam
 * deliberadamente fora para QA poder gerar build/cache sem alterar a entrega.
 */
export function gitVisibleWorktreeFingerprint(cwd: string): string | undefined {
  try {
    const root = resolve(cwd)
    const hash = createHash('sha256')
    fingerprintField(hash, 'head', git(cwd, ['rev-parse', '--verify', 'HEAD']))
    let headRef = 'DETACHED'
    try {
      headRef = git(cwd, ['symbolic-ref', '--quiet', 'HEAD']) || 'DETACHED'
    } catch {
      // detached HEAD é um estado Git válido.
    }
    fingerprintField(hash, 'ref', headRef)
    fingerprintField(
      hash,
      'status',
      gitRaw(cwd, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignored=no'
      ])
    )
    fingerprintField(
      hash,
      'worktree-diff',
      gitRaw(cwd, [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--'
      ])
    )
    // O campo anterior representa o conteúdo final; este também detecta um
    // gate que apenas move mudanças do working tree para dentro/fora do index.
    fingerprintField(
      hash,
      'index-diff',
      gitRaw(cwd, [
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--'
      ])
    )
    const untracked = nulSeparatedPaths(
      gitRaw(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--'])
    ).sort((left, right) => left.localeCompare(right, 'en'))
    fingerprintField(hash, 'untracked-paths', untracked.join('\0'))
    for (const path of untracked) {
      const absolute = resolve(root, path)
      const inside = relative(root, absolute)
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        return undefined
      }
      const stat = lstatSync(absolute)
      fingerprintField(hash, `untracked-mode:${path}`, stat.mode.toString(8))
      if (stat.isSymbolicLink()) {
        fingerprintField(hash, `untracked-link:${path}`, readlinkSync(absolute))
      } else if (stat.isFile()) {
        // O próprio Git faz hashing em streaming (sem -w, portanto sem criar
        // objetos). Isso evita carregar um asset não rastreado enorme na RAM.
        fingerprintField(
          hash,
          `untracked-file:${path}`,
          git(cwd, ['hash-object', '--no-filters', '--', path])
        )
      } else {
        // Nested repo/gitlink pode aparecer como uma entrada única. O resumo
        // de sujeira já está no `status`; o tipo evita colisão com um arquivo.
        fingerprintField(
          hash,
          `untracked-other:${path}`,
          stat.isDirectory() ? 'directory' : 'other'
        )
      }
    }
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

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

export function createTaskWorktree(
  projectPath: string,
  baseDir: string,
  taskId: string,
  /** branch de onde a tarefa nasce (missão) — ausente = HEAD do repo */
  baseBranch?: string
): TaskWorktree | null {
  const { dir, branch } = taskWorktreeDescriptor(baseDir, taskId)
  try {
    if (existsSync(dir))
      return isExpectedWorktree(projectPath, dir, branch) ? { dir, branch } : null
    mkdirSync(dirname(dir), { recursive: true })
    try {
      const args = ['worktree', 'add', '-b', branch, dir]
      if (baseBranch) args.push(baseBranch)
      git(projectPath, args)
    } catch {
      // branch já existe de um run anterior — reanexa
      git(projectPath, ['worktree', 'prune'])
      git(projectPath, ['worktree', 'add', dir, branch])
    }
    return isExpectedWorktree(projectPath, dir, branch) ? { dir, branch } : null
  } catch {
    return null
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
      if (gitHead(dir) !== expectedHead) return false
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
  try {
    for (const line of git(worktreeDir, ['diff', '--numstat', from]).split(/\r?\n/)) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      // '-' nas duas colunas = binário: entra na lista, fora da soma.
      insertions += Number.parseInt(parts[0], 10) || 0
      deletions += Number.parseInt(parts[1], 10) || 0
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
      files.push({ path, status: parts[0].charAt(0) })
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
export interface MissionCommit {
  /** SHA abreviado (%h) — o que o dono lê e cola; nunca usado como argumento. */
  sha: string
  /** Primeira linha da mensagem: `%s` NÃO contém quebra de linha, por
   *  definição, e é isso que mantém uma linha do log = um commit. */
  subject: string
  /** Data do AUTOR em ISO 8601 estrito (%aI) — a mesma que o `git log` mostra
   *  por padrão, então o dono reconhece o horário do próprio trabalho. */
  at: string
}

/** Teto do payload: o trilho lista o trabalho da missão, não o histórico do
 *  repositório. Missão que passar disso já é grande demais para caber num
 *  cabeçalho — a lista completa se lê no terminal do worktree. */
const MISSION_COMMITS_CAP = 50

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
  const base = baseBranch?.trim()
  // Sem base declarada não existe "à frente de quê": zero commits provados é a
  // resposta honesta, e é a mesma que o summary dá em `ahead`.
  if (!base) return []
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
      '--format=%h%x1f%aI%x1f%s',
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
    if (second < 0) continue
    commits.push({
      sha: line.slice(0, first),
      at: line.slice(first + 1, second),
      subject: line.slice(second + 1)
    })
  }
  return commits
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
    if (existsSync(dir))
      return isExpectedWorktree(projectPath, dir, branch) ? { dir, branch } : null
    mkdirSync(dirname(dir), { recursive: true })
    try {
      const args = ['worktree', 'add', '-b', branch, dir]
      if (baseRef) args.push(baseRef)
      git(projectPath, args)
    } catch {
      git(projectPath, ['worktree', 'prune'])
      git(projectPath, ['worktree', 'add', dir, branch])
    }
    return isExpectedWorktree(projectPath, dir, branch) ? { dir, branch } : null
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
    if (existsSync(dir))
      return isExpectedWorktree(projectPath, dir, branch) ? { dir, branch } : null
    mkdirSync(dirname(dir), { recursive: true })
    try {
      git(projectPath, ['worktree', 'add', '-b', branch, dir])
    } catch {
      git(projectPath, ['worktree', 'prune'])
      git(projectPath, ['worktree', 'add', dir, branch])
    }
    return isExpectedWorktree(projectPath, dir, branch) ? { dir, branch } : null
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
}

export interface MergeTargetSnapshot {
  sourceHead: string
  previousTargetHead: string
  targetBranch: string
  committedHead: string
}

export interface MergeWorktreeOptions {
  /** Gate final: nunca transforme alterações posteriores aos gates em commit. */
  requireCleanSource?: boolean
  /** SHA imutável que foi validado/journalado e deve ser o único a entrar. */
  expectedSourceHead?: string
  /** Fotografia Git-visível conferida imediatamente antes de add/commit. */
  expectedSourceFingerprint?: string
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
    const approvedHead = options.expectedSourceHead ?? sourceHead
    // `--force` jamais pode apagar uma escrita que apareceu depois do gate.
    // Quando a origem é um snapshot aprovado, confira novamente imediatamente
    // antes da remoção. Se algo divergiu, o merge exato pode já ter pousado,
    // mas o worktree/branch fica preservado para reconciliação explícita.
    if (options.requireCleanSource) {
      if (
        !approvedHead ||
        gitHead(wt.dir) !== approvedHead ||
        isWorktreeClean(wt.dir) !== true ||
        (options.expectedSourceFingerprint !== undefined &&
          gitVisibleWorktreeFingerprint(wt.dir) !== options.expectedSourceFingerprint)
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
    if (
      options.expectedSourceFingerprint &&
      gitVisibleWorktreeFingerprint(wt.dir) !== options.expectedSourceFingerprint
    ) {
      return {
        ok: false,
        detail:
          'a origem mudou depois do último gate e antes do snapshot Git — nada foi integrado'
      }
    }
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
      return { ok: true, detail: 'sem mudanças para integrar' }
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
    return { ok: true, detail: `branch ${wt.branch} integrada` }
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
      const conflictFiles = (err.stdout ?? '')
        .split('\n')
        .slice(1)
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

/** Integração final da MISSÃO: commita pendências no worktree dela e faz
 *  merge --no-ff na branch base (repo principal). ok → worktree/branch limpos;
 *  conflito → tudo preservado para resolução. */
export function mergeMissionWorktree(
  projectPath: string,
  wt: TaskWorktree,
  message: string
): MergeResult {
  return mergeTaskWorktree(projectPath, wt, message)
}

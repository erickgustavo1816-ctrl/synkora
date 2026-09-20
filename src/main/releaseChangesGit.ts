import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ReleaseChangeRecord, ReleaseSaveInput } from '../shared/releaseChanges'

export interface ReleaseChangeTarget {
  cwd: string
  branch: string
  phase: ReleaseChangeRecord['phase']
}

function git(cwd: string, args: string[], index?: string): string {
  const env = { ...process.env }
  // A caller's inherited Git routing must never select another repository/index.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key]
  env.GIT_LITERAL_PATHSPECS = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  if (index) env.GIT_INDEX_FILE = index
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true,
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
}

export function releaseChangesProbe(cwd: string): {
  branch?: string; head?: string; dirty?: boolean; hasOrigin?: boolean; files: string[]; error?: string
} {
  try {
    const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD'])
    const head = git(cwd, ['rev-parse', 'HEAD'])
    const entries = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
      .split('\0').filter(Boolean)
    return { branch, head, dirty: entries.length > 0, hasOrigin: git(cwd, ['remote']).split('\n').includes('origin'),
      files: entries.map((entry) => entry.slice(3)) }
  } catch {
    return { files: [], error: 'não consegui conferir branch/arquivos; repare o repositório e leia release_status' }
  }
}

/** Strict literal file names: neither a directory nor a pathspec may expand the selection. */
export function releaseChangeFiles(cwd: string, files: readonly string[]): string[] {
  if (!files.length || files.length > 100) throw new Error('selecione de 1 a 100 arquivos em release_save')
  const clean = files.map((file) => file.replaceAll('\\', '/'))
  for (const file of clean) {
    const parts = file.split('/')
    if (!file || file.length > 400 || /[\x00-\x1f\x7f:*?\[\]]/u.test(file) ||
      parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part)) ||
      parts.some((part) => /^(?:\.git|\.synkora|\.env.*|\.ssh|\.aws|\.npmrc|\.netrc|\.git-credentials|credentials(?:\..*)?|cookies(?:\..*)?|id_rsa|id_ed25519)$/iu.test(part)) ||
      /\.(?:pem|key|p12|pfx)$/iu.test(file))
      throw new Error('caminho recusado: use arquivos relativos explícitos, sem credenciais, em release_save')
    let cursor = resolve(cwd)
    for (let i = 0; i < parts.length; i++) {
      cursor = join(cursor, parts[i]!)
      if (!existsSync(cursor)) {
        // A deleted tracked file is allowed; a nonexistent new path is not.
        git(cwd, ['ls-files', '--error-unmatch', '--', file])
        break
      }
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink() || (i === parts.length - 1 && !stat.isFile()))
        throw new Error('links e diretórios não entram em release_save; selecione os arquivos regulares')
      if (i < parts.length - 1 && existsSync(join(cursor, '.git')))
        throw new Error('outro repositório não entra em release_save')
    }
  }
  if (new Set(clean.map((file) => process.platform === 'win32' ? file.toLowerCase() : file)).size !== clean.length)
    throw new Error('arquivos repetidos; corrija a seleção de release_save')
  return clean.sort()
}

function assertTarget(target: ReleaseChangeTarget): void {
  if (realpathSync(git(target.cwd, ['rev-parse', '--show-toplevel'])) !== realpathSync(target.cwd) ||
    git(target.cwd, ['symbolic-ref', '--short', 'HEAD']) !== target.branch)
    throw new Error('branch/pasta mudou; leia release_status antes de salvar')
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
    if (existsSync(resolve(target.cwd, git(target.cwd, ['rev-parse', '--git-path', marker]))))
      throw new Error('há uma operação Git em andamento; conclua-a e leia release_status')
  }
}

function selectedTree(target: ReleaseChangeTarget, parent: string, files: string[]): string {
  const temporary = mkdtempSync(join(tmpdir(), 'synkora-release-index-'))
  try {
    const index = join(temporary, 'index')
    git(target.cwd, ['read-tree', parent], index)
    git(target.cwd, ['add', '--all', '--', ...files], index)
    return git(target.cwd, ['write-tree'], index)
  } finally {
    // Only the freshly allocated temporary directory; never the project or a link.
    if (dirname(temporary) === resolve(tmpdir())) rmSync(temporary, { recursive: true, force: true })
  }
}

/** Creates an unreachable commit object; the branch is untouched until the receipt is durable. */
export function prepareReleaseChange(target: ReleaseChangeTarget, input: ReleaseSaveInput): {
  ok: true; sha: string; files: string[]
} | { ok: false; error: string } {
  try {
    assertTarget(target)
    if (!/^[a-f0-9]{40,64}$/u.test(input.expectedHead) || git(target.cwd, ['rev-parse', 'HEAD']) !== input.expectedHead)
      return { ok: false, error: 'HEAD mudou; leia release_status, revise e valide os arquivos antes de repetir release_save' }
    const files = releaseChangeFiles(target.cwd, input.files)
    const tree = selectedTree(target, input.expectedHead, files)
    if (tree === git(target.cwd, ['rev-parse', `${input.expectedHead}^{tree}`]))
      return { ok: false, error: 'nenhuma alteração nos arquivos escolhidos; confira release_status e a seleção de release_save' }
    // Same plumbing as integration: the supplied validation remains explicitly agent-reported.
    const sha = git(target.cwd, ['commit-tree', tree, '-p', input.expectedHead, '-m',
      `fix(release): ${input.summary}\n\nSynkora-Release-Change: ${input.requestId}`])
    return { ok: true, sha, files }
  } catch {
    return { ok: false, error: 'não salvei: confira identidade Git, caminhos explícitos (sem links/credenciais) e operações pendentes; leia release_status e repita release_save' }
  }
}

/** CAS + recovery: a repeated request never makes a second commit. Never rewrites file contents. */
export function applyReleaseChange(target: ReleaseChangeTarget, record: ReleaseChangeRecord): {
  state: ReleaseChangeRecord['state']; error?: string
} {
  try {
    assertTarget(target)
    if (record.branch !== target.branch || record.phase !== target.phase ||
      git(target.cwd, ['rev-list', '--parents', '-n', '1', record.sha]) !== `${record.sha} ${record.parentHead}`)
      return { state: 'prepared', error: 'recibo diverge da branch/commit; preserve o histórico e valide o registro com o dono antes de repetir release_save' }
    const files = releaseChangeFiles(target.cwd, record.files)
    const head = git(target.cwd, ['rev-parse', 'HEAD'])
    let applied = false
    try { git(target.cwd, ['merge-base', '--is-ancestor', record.sha, head]); applied = true } catch { /* not applied */ }
    if (!applied) {
      if (head !== record.parentHead || selectedTree(target, head, files) !== git(target.cwd, ['rev-parse', `${record.sha}^{tree}`]))
        return { state: 'not-applied', error: 'HEAD/arquivos mudaram antes de salvar; nada aplicado. Leia release_status, valide e use outro requestId em release_save' }
      git(target.cwd, ['update-ref', '-m', 'synkora: save release change', `refs/heads/${target.branch}`, record.sha, record.parentHead])
    }
    // An interrupted operation may have advanced the ref but not refreshed these index entries.
    // An already advanced branch needs no index repair to an older receipt.
    if (git(target.cwd, ['rev-parse', 'HEAD']) === record.sha)
      git(target.cwd, ['reset', '-q', record.sha, '--', ...files])
    return { state: 'saved' }
  } catch {
    return { state: 'prepared', error: 'recibo preservado; leia release_status e repita release_save com o MESMO requestId para reconciliar' }
  }
}

export function pushReleaseChanges(target: ReleaseChangeTarget, expectedHead: string, savedShas: string[] = []): {
  ok: boolean; localOnly?: boolean; includedShas?: string[]; error?: string
} {
  try {
    assertTarget(target)
    if (!/^[a-f0-9]{40,64}$/u.test(expectedHead) || git(target.cwd, ['rev-parse', 'HEAD']) !== expectedHead)
      return { ok: false, error: 'HEAD mudou; leia release_status antes de repetir release_push' }
    if (releaseChangesProbe(target.cwd).dirty !== false)
      return { ok: false, error: 'há mudanças locais; use release_save antes de release_push' }
    if (!git(target.cwd, ['remote']).split('\n').includes('origin')) return { ok: true, localOnly: true }
    const includedShas = savedShas.filter((sha) => {
      if (!/^[a-f0-9]{40,64}$/u.test(sha)) return false
      try { git(target.cwd, ['merge-base', '--is-ancestor', sha, expectedHead]); return true } catch { return false }
    })
    git(target.cwd, ['push', 'origin', `${expectedHead}:refs/heads/${target.branch}`])
    return { ok: true, includedShas }
  } catch {
    return { ok: false, error: 'push não confirmado; os commits locais foram preservados. Confira o acesso ao origin e repita release_push após release_status' }
  }
}

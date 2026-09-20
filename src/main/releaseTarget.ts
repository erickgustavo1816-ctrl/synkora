import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface ReleaseTargetProbe {
  branch?: string
  currentBranch?: string
  head?: string
  branches: string[]
  needsSwitch: boolean
  error?: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, windowsHide: true, encoding: 'utf8', timeout: 15_000,
    maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function allowedBranchName(branch: string): boolean {
  if (!branch || branch.length > 200 || branch === 'HEAD' || branch.startsWith('-') ||
    /[\u0000-\u0020\u007f]/u.test(branch) || /^(?:refs|version|mission|task)\//u.test(branch)) return false
  return true
}

function validBranch(cwd: string, branch: string): boolean {
  if (!allowedBranchName(branch)) return false
  try { git(cwd, ['check-ref-format', `refs/heads/${branch}`]); return true } catch { return false }
}

/** Read-only. A development checkout never silently becomes a release target.
 * Legacy projects already on main/master retain their established destination. */
export function inspectReleaseTarget(projectPath: string, configuredBranch?: string): ReleaseTargetProbe {
  const result: ReleaseTargetProbe = { branches: [], needsSwitch: false }
  try {
    result.currentBranch = git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    result.branches = git(projectPath, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'])
      .split('\n').filter(allowedBranchName)
    result.branch = configuredBranch ??
      (result.currentBranch === 'main' || result.currentBranch === 'master' ? result.currentBranch : undefined)
    if (!result.branch) return { ...result, error: 'destino não definido; use release_target com a branch autorizada pelo dono. A branch aberta para desenvolvimento não define PROD.' }
    if (!validBranch(projectPath, result.branch) || !result.branches.includes(result.branch))
      return { ...result, error: 'a branch de destino não existe localmente ou não é permitida; escolha uma das branches exibidas usando release_target' }
    result.head = git(projectPath, ['rev-parse', '--verify', `refs/heads/${result.branch}^{commit}`])
    result.needsSwitch = result.currentBranch !== result.branch
    return result
  } catch {
    return { ...result, error: 'não consegui provar a branch e o commit do destino; restaure o repositório antes de publicar' }
  }
}

/** Local preparation only: no merge, push, force, stash or branch creation.
 * The release engine invokes this only after all its existing gates pass. */
export function prepareReleaseTarget(projectPath: string, expected: ReleaseTargetProbe): { ok: boolean; error?: string } {
  try {
    const actual = inspectReleaseTarget(projectPath, expected.branch)
    if (expected.error || !expected.branch || !expected.head || actual.error ||
      actual.branch !== expected.branch || actual.head !== expected.head || actual.currentBranch !== expected.currentBranch)
      return { ok: false, error: 'o destino mudou; leia release_status e confira o destino novamente' }
    for (const state of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
      const statePath = git(projectPath, ['rev-parse', '--git-path', state])
      if (existsSync(resolve(projectPath, statePath)))
        return { ok: false, error: 'há uma operação Git pendente na pasta do projeto; conclua-a antes da release' }
    }
    if (git(projectPath, ['status', '--porcelain']))
      return { ok: false, error: 'a pasta do projeto tem alterações locais; preserve e finalize esse trabalho antes de trocar o destino' }
    if (actual.needsSwitch) {
      // Git itself refuses branches checked out elsewhere and collisions with
      // tracked, untracked AND ignored files. Never override that refusal.
      git(projectPath, ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        'checkout', '--no-guess', '--no-overwrite-ignore', actual.branch!])
    }
    if (git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== expected.branch ||
      git(projectPath, ['rev-parse', 'HEAD']) !== expected.head || git(projectPath, ['status', '--porcelain']))
      return { ok: false, error: 'a pasta não confirmou o destino esperado; a release não foi iniciada' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'não foi possível abrir a branch de destino com segurança (pasta ocupada, outro worktree ou arquivos locais). Nenhum merge ou push foi executado; leia release_status.' }
  }
}

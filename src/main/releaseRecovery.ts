import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  alignWorktreeFromSnapshot, currentBranch, gitCommitReached, gitHead,
  isExactCleanPreCasSnapshot, isExpectedVersionWorktree, isWorktreeClean,
  removeWorktreeAndBranch
} from './worktree'
import { hasDanglingWorktreeRegistration } from './worktreeRegistration'
import { freshWindowsPath } from './winPath'

export interface ReleaseRecoveryInput {
  projectId: string
  projectPath: string
  worktreesRoot: string
  version: { id: string; projectId: string; branch: string; worktree: string }
  intent: unknown
}

interface RecoveryIntent {
  id: string
  projectId: string
  sourceHead: string
  targetHead: string
  targetBranch: string
  targetDir: string
}

export type ReleaseRecoveryProbe =
  | { state: 'cleanup'; targetHead: string }
  | { state: 'retry' }
  | { state: 'blocked'; reason: string }

const blocked = (reason: string): { state: 'blocked'; reason: string } => ({ state: 'blocked', reason })
const samePath = (a: string, b: string): boolean => {
  const normalize = (path: string): string => process.platform === 'win32'
    ? resolve(path).toLowerCase() : resolve(path)
  return normalize(a) === normalize(b)
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...process.env, PATH: freshWindowsPath() }, stdio: ['ignore', 'pipe', 'pipe']
  })
}

function validatedIntent(input: ReleaseRecoveryInput): RecoveryIntent | undefined {
  const value = input.intent as Partial<RecoveryIntent> | null
  if (!value || typeof value !== 'object' || value.id !== input.version.id ||
    value.projectId !== input.projectId || input.version.projectId !== input.projectId ||
    typeof value.sourceHead !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.sourceHead) ||
    typeof value.targetHead !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.targetHead) ||
    typeof value.targetBranch !== 'string' || !value.targetBranch.trim() ||
    typeof value.targetDir !== 'string' || !isAbsolute(value.targetDir) ||
    !samePath(value.targetDir, input.projectPath)) return undefined
  return value as RecoveryIntent
}

/** ENOENT is allowed after cleanup, but a linked/unreadable ancestor is not. */
function hasPhysicalDirectoryIdentity(path: string): boolean {
  let candidate = resolve(path)
  for (;;) {
    try {
      const stat = lstatSync(candidate)
      return stat.isDirectory() && !stat.isSymbolicLink() && samePath(realpathSync(candidate), candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = dirname(candidate)
      if (parent === candidate) return false
      candidate = parent
    }
  }
}

/** The persisted, exclusive version pair is the authority, not a missing .git.
 * For a carcass it must match Synkora's exact managed directory convention.
 * A live legacy worktree can still prove itself through its own Git registry. */
function sourceIdentityIsValid(input: ReleaseRecoveryInput, expectedHead: string): boolean {
  const { projectPath, worktreesRoot, version } = input
  const { branch, worktree } = version
  if (!isAbsolute(worktree) || samePath(worktree, projectPath) || !hasPhysicalDirectoryIdentity(worktree)) return false
  try {
    git(projectPath, ['check-ref-format', `refs/heads/${branch}`])
    // Legacy names were sanitized without requiring an alphanumeric first
    // character. Git's check-ref-format above still rejects unsafe refs.
    const suffix = /^version\/([A-Za-z0-9._-]+)$/.exec(branch)?.[1]
    if (!suffix) return false
    let branchExists = true
    try { git(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) }
    catch (error) {
      if ((error as { status?: number }).status !== 1) return false
      branchExists = false
    }
    if (branchExists && git(projectPath, ['rev-parse', `refs/heads/${branch}`]).trim() !== expectedHead) return false
    // Never delete a ref that was rebound to a different checkout, even when
    // its SHA is unchanged. A stale registration for this exact root is OK.
    const entries = git(projectPath, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')
    for (const entry of entries) {
      const fields = entry.split('\0')
      const dir = fields.find(field => field.startsWith('worktree '))?.slice(9)
      const ref = fields.find(field => field.startsWith('branch '))?.slice(7)
      if (!dir) continue
      if (ref === `refs/heads/${branch}` && !samePath(dir, worktree)) return false
      if (samePath(dir, worktree) && ref !== `refs/heads/${branch}`) return false
    }
    if (isExpectedVersionWorktree(projectPath, worktree, branch)) return true
    if (!isAbsolute(worktreesRoot) || !hasPhysicalDirectoryIdentity(worktreesRoot) ||
      !samePath(worktree, join(worktreesRoot, `version-${suffix}`))) return false
    try {
      lstatSync(join(worktree, '.git'))
      const common = resolve(projectPath, git(projectPath, ['rev-parse', '--git-common-dir']).trim())
      return hasDanglingWorktreeRegistration(common, worktree)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  } catch {
    return false
  }
}

/** Read-only: merge proof precedes any cleanup. Never require a live worktree
 * after Git has already removed its registration during an interrupted release. */
export function probeReleaseRecovery(input: ReleaseRecoveryInput): ReleaseRecoveryProbe {
  const intent = validatedIntent(input)
  if (!intent) return blocked('marcador da release inválido; preserve os arquivos e repare a identidade da versão antes de repetir release_run')
  if (!sourceIdentityIsValid(input, intent.sourceHead))
    return blocked('identidade da origem não comprovada; preserve as pastas e repare o vínculo da versão antes de repetir release_run')
  const landed = currentBranch(input.projectPath) === intent.targetBranch &&
    gitCommitReached(input.projectPath, intent.targetHead) === true &&
    gitCommitReached(input.projectPath, intent.sourceHead) === true
  if (!landed) {
    if (isExpectedVersionWorktree(input.projectPath, input.version.worktree, input.version.branch) &&
      isExactCleanPreCasSnapshot(input.version.worktree, intent.sourceHead,
        input.projectPath, intent.targetHead, intent.targetBranch)) return { state: 'retry' }
    return blocked('o Git não prova a subida nem a fotografia anterior intacta; preserve o marcador e confira as branches antes de repetir release_run')
  }
  const targetHead = gitHead(input.projectPath)
  return targetHead ? { state: 'cleanup', targetHead }
    : blocked('não foi possível ler o destino; confira o acesso ao projeto e repita release_run')
}

/** Run after scoped previews close. Reprobe all identities and the destination
 * HEAD inside the Git worker, because awaiting shutdown can yield to edits. */
export function finishReleaseRecovery(
  input: ReleaseRecoveryInput,
  expectedTargetHead: string
): { state: 'recovered' } | { state: 'blocked'; reason: string } {
  const proof = probeReleaseRecovery(input)
  if (proof.state === 'blocked') return proof
  if (proof.state !== 'cleanup' || proof.targetHead !== expectedTargetHead)
    return blocked('o destino mudou durante a recuperação; confira release_status antes de repetir release_run')
  const intent = validatedIntent(input)!
  if (isWorktreeClean(input.projectPath) !== true && !alignWorktreeFromSnapshot(input.projectPath, intent.targetHead))
    return blocked('a subida está gravada, mas os arquivos do destino têm alterações ou estão em uso; preserve suas alterações, libere os arquivos e repita release_run')
  if (!removeWorktreeAndBranch(input.projectPath, input.version.worktree, input.version.branch, intent.sourceHead))
    return blocked('a subida está gravada, mas a origem mudou ou ainda está em uso; preserve as pastas, feche o processo que as segura e repita release_run para finalizar')
  return { state: 'recovered' }
}

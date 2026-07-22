import { execFileSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { freshWindowsPath } from './winPath'

// Worktree por tarefa (F3): cada execução roda em worktrees/<task> numa branch
// task/<id>; aprovada nos dois gates, o main integra com merge --no-ff e limpa.
// Projeto sem git (ou sem commit) cai no modo direto — executa no próprio dir.

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...(process.env as Record<string, string>), PATH: freshWindowsPath() },
    timeout: 60_000,
    windowsHide: true
  }).trim()
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

export function createTaskWorktree(
  projectPath: string,
  baseDir: string,
  taskId: string
): TaskWorktree | null {
  const short = taskId.slice(0, 8)
  const branch = `task/${short}`
  const dir = join(baseDir, short)
  try {
    if (existsSync(dir)) return { dir, branch } // reexecução: reusa o worktree
    mkdirSync(dirname(dir), { recursive: true })
    try {
      git(projectPath, ['worktree', 'add', '-b', branch, dir])
    } catch {
      // branch já existe de um run anterior — reanexa
      git(projectPath, ['worktree', 'add', dir, branch])
    }
    return { dir, branch }
  } catch {
    return null
  }
}

export interface MergeResult {
  ok: boolean
  detail: string
}

/** Commita o que o executor mudou no worktree e integra no repo principal. */
export function mergeTaskWorktree(
  projectPath: string,
  wt: TaskWorktree,
  message: string
): MergeResult {
  const cleanup = (): void => {
    try {
      git(projectPath, ['worktree', 'remove', wt.dir, '--force'])
    } catch {
      // worktree já removido
    }
    try {
      git(projectPath, ['branch', '-D', wt.branch])
    } catch {
      // branch já removida
    }
  }
  try {
    const status = git(wt.dir, ['status', '--porcelain'])
    if (status) {
      git(wt.dir, ['add', '-A'])
      git(wt.dir, ['commit', '-m', message])
    }
    const ahead = git(projectPath, ['rev-list', '--count', `HEAD..${wt.branch}`])
    if (ahead === '0') {
      cleanup()
      return { ok: true, detail: 'sem mudanças para integrar' }
    }
    try {
      git(projectPath, ['merge', '--no-ff', wt.branch, '-m', `merge: ${message}`])
    } catch (e) {
      try {
        git(projectPath, ['merge', '--abort'])
      } catch {
        // nada para abortar
      }
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
      return {
        ok: false,
        detail: `conflito no merge (${msg.slice(0, 160)}) — branch ${wt.branch} mantida para resolução manual`
      }
    }
    cleanup()
    return { ok: true, detail: `branch ${wt.branch} integrada no repo` }
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    return { ok: false, detail: msg.slice(0, 200) }
  }
}

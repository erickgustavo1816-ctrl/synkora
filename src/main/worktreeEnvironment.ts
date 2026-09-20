import { execFileSync } from 'node:child_process'
import { appendFileSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { freshWindowsPath } from './winPath'

function git(directory: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, PATH: freshWindowsPath() }, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function statEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Call only after proving the workspace belongs to this project. Copy the
 * local .env* files without parsing, logging or sharing a link to
 * their contents. Existing entries (including links) always belong to the user.
 * Reopening a mission fills missing files, never synchronizes over edits. */
export function ensureWorktreeEnvironment(projectPath: string, worktreeDir: string): void {
  if (resolve(projectPath) === resolve(worktreeDir)) return
  try {
    const pending = readdirSync(projectPath).filter(name => name.startsWith('.env')).filter(name => {
      if (statEntry(join(worktreeDir, name))) return false
      const source = statEntry(join(projectPath, name))
      if (!source) return false
      if (!source.isFile() || source.isSymbolicLink()) return false
      // A tracked file deleted by the user must stay deleted.
      return git(worktreeDir, ['ls-files', '--', name]) === ''
    })
    if (pending.length === 0) return

    const gitPath = git(worktreeDir, ['rev-parse', '--git-path', 'info/exclude'])
    const exclude = isAbsolute(gitPath) ? gitPath : resolve(worktreeDir, gitPath)
    let current = ''
    try { current = readFileSync(exclude, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const rules = ['/.env*']
    const missing = rules.filter(rule => !current.split(/\r?\n/u).includes(rule))
    if (missing.length > 0) {
      mkdirSync(dirname(exclude), { recursive: true })
      appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# synkora: local environment\n${missing.join('\n')}\n`)
    }
    for (const name of pending) {
      // Ignore rules can be overridden by a project's .gitignore. Failure is
      // closed: no secret-bearing file is copied unless Git confirms exclusion.
      git(worktreeDir, ['check-ignore', '-q', '--', name])
      try {
        copyFileSync(join(projectPath, name), join(worktreeDir, name), constants.COPYFILE_EXCL)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  } catch {
    // Never reflect fs errors, absolute paths or configuration bytes to UI/logs.
    throw new Error('não consegui preparar os arquivos .env* da missão; confira os arquivos locais, permissões e regras de exclusão do Git e reabra a missão')
  }
}

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** A dangling pointer is only recoverable inside this repository's worktree
 * registry. Unreadable, linked, malformed or foreign metadata fails closed. */
export function hasDanglingWorktreeRegistration(commonGitDir: string, worktreeDir: string): boolean {
  try {
    const marker = join(worktreeDir, '.git')
    const stat = lstatSync(marker)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(readFileSync(marker, 'utf8'))
    if (!match) return false
    const common = realpathSync(commonGitDir)
    const registry = join(common, 'worktrees')
    let registryMissing = false
    try {
      const registryStat = lstatSync(registry)
      if (!registryStat.isDirectory() || registryStat.isSymbolicLink()) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      registryMissing = true
    }
    const target = resolve(worktreeDir, match[1]!)
    const entry = relative(registry, target)
    if (!entry || entry === '..' || entry.includes(sep) || resolve(registry, entry) !== target) return false
    // The parent exists and is the real registry; a broken junction or access
    // error at the entry is not proof that registration has been removed.
    if (registryMissing) {
      if (realpathSync(dirname(dirname(target))) !== common) return false
    } else if (realpathSync(dirname(target)) !== registry) return false
    try { lstatSync(target); return false }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
  } catch {
    return false
  }
}

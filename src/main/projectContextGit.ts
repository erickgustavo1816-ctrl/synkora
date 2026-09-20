import { execFileSync } from 'node:child_process'
import type { ContextGitSnapshot } from './projectContextTypes'

/** Called in gitWorker. No network, checkout, writes or unbounded Git output. */
export function projectContextSnapshot(cwd: string, heads: string[]): ContextGitSnapshot {
  const deadline = Date.now() + 5000
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  let head: string | undefined
  try { head = git(['rev-parse', '--verify', 'HEAD']) } catch { /* non-Git or unavailable */ }
  if (!head || !/^[a-f0-9]{40,64}$/u.test(head)) return { included: {} }
  const included: ContextGitSnapshot['included'] = {}
  for (const candidate of [...new Set(heads)].slice(0, 25)) {
    if (Date.now() > deadline) break
    if (!/^[a-f0-9]{40,64}$/u.test(candidate)) continue
    try {
      git(['cat-file', '-e', `${candidate}^{commit}`])
      try { git(['merge-base', '--is-ancestor', candidate, head]); included[candidate] = true }
      catch (error) { included[candidate] = (error as { status?: number }).status === 1 ? false : null }
    } catch { included[candidate] = null }
  }
  return { head, included }
}

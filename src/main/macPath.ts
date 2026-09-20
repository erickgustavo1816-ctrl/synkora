import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { posix } from 'node:path'

const MAX_BYTES = 65536
const MARKER = '\0SYNKORA_PATH\0'
const PATH_QUERY = 'printf "\\0SYNKORA_PATH\\0%s\\0" "$PATH"'
let cached: string | undefined

function mergePaths(...values: string[]): string {
  const seen = new Set<string>()
  for (const value of values) {
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) continue
    for (const entry of value.split(':')) {
      if (!entry || entry.length > 4096 || /[\u0000-\u001f\u007f]/u.test(entry) || !posix.isAbsolute(entry)) continue
      seen.add(posix.normalize(entry))
    }
  }
  return [...seen].join(':')
}

function parsePath(output: string): string {
  if (Buffer.byteLength(output, 'utf8') > MAX_BYTES) return ''
  const start = output.indexOf(MARKER)
  if (start < 0 || output.indexOf(MARKER, start + MARKER.length) !== -1) return ''
  const end = output.indexOf('\0', start + MARKER.length)
  return end < 0 ? '' : output.slice(start + MARKER.length, end)
}

/** Finder apps do not inherit login PATH. Query only that value once, never the
 * complete environment. The user's normal shell may evaluate its own profiles;
 * Synkora neither reads profile files nor persists/displays their output.
 * Missing/broken profiles use known locations and never block every keystroke.
 */
export function freshMacPath(): string {
  if (cached !== undefined) return cached
  const home = homedir()
  const fallback = mergePaths(process.env.PATH ?? '',
    '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin', posix.join(home, '.local', 'bin'),
    '/usr/bin:/bin:/usr/sbin:/sbin')
  const shell = process.env.SHELL === '/bin/bash' ? '/bin/bash' : '/bin/zsh'
  let loginPath = ''
  try {
    const output = execFileSync(shell, ['-ilc', PATH_QUERY], {
      shell: false, cwd: home, encoding: 'utf8', timeout: 4000, maxBuffer: MAX_BYTES, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      env: { HOME: home, SHELL: shell, PATH: fallback, LANG: 'en_US.UTF-8' }
    })
    loginPath = parsePath(output)
  } catch { /* The error may contain private profile output. Never log it. */ }
  cached = mergePaths(loginPath, fallback)
  return cached
}

export function resetMacPathCache(): void { cached = undefined }

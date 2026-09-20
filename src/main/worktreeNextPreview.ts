import { realpathSync } from 'node:fs'
import { win32 } from 'node:path'

export interface NextPreviewEntries { cli: string[]; server: string[] }

/** Resolve only the runtime installed for this worktree, including a shared
 * node_modules junction. Process-supplied paths never extend this allowlist. */
export function nextPreviewEntries(root: string): NextPreviewEntries {
  const paths = (suffix: string): string[] => {
    const lexical = win32.join(root, 'node_modules', 'next', 'dist', suffix)
    const result = [lexical.toLowerCase()]
    try { result.push(realpathSync(lexical).toLowerCase()) } catch { /* lexical proof survives cleanup */ }
    return [...new Set(result)]
  }
  return { cli: paths('bin\\next'), server: paths('server\\lib\\start-server.js') }
}

export function allowedNextPreviewFlags(args: string[]): boolean {
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const [name, ...inline] = args[index].split('=')
    const flag = name === '-p' ? '--port' : name === '-H' ? '--hostname' : name
    if (!['--port', '--hostname', '--turbo', '--turbopack', '--webpack'].includes(flag) || seen.has(flag)) return false
    seen.add(flag)
    if (['--turbo', '--turbopack', '--webpack'].includes(flag)) {
      if (inline.length) return false
      continue
    }
    const value = inline.length ? inline.join('=') : args[++index]
    if (!value) return false
    if (flag === '--port') {
      if (!/^\d{1,5}$/u.test(value) || +value < 1 || +value > 65535) return false
    } else if (value.length > 253 || !/^[a-z0-9_.:[\]-]+$/iu.test(value)) return false
  }
  return true
}

export function isNextPreviewCommand(root: string, argv: string[], entries: NextPreviewEntries): boolean {
  if (argv.length < 2 || /[\u0000-\u001f]/u.test(argv[1]) || argv[1].startsWith('\\\\?\\') || argv[1].startsWith('\\\\.\\')) return false
  const script = win32.resolve(root, argv[1]).toLowerCase()
  if (entries.server.includes(script)) return argv.length === 2
  return entries.cli.includes(script) && ['dev', 'start'].includes(argv[2]) && allowedNextPreviewFlags(argv.slice(3))
}

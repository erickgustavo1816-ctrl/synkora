import { homedir } from 'os'
import { join, resolve } from 'path'

const retiringHomes = new Map<string, Set<Promise<void>>>()

export function isCodexSqliteStartupFailure(code: number | null | undefined, stderr: string): boolean {
  return code === 1 && stderr.split(/\r?\n/u).some(line =>
    line.startsWith('Error: failed to initialize sqlite state runtime under ') &&
    line.includes(': failed to initialize state runtime at '))
}

export class CodexStartup {
  private readonly home: string
  private readonly cancellation = new AbortController()

  constructor(env: Record<string, string>, cwd: string) {
    const home = resolve(cwd, env['CODEX_HOME'] || join(homedir(), '.codex'))
    this.home = process.platform === 'win32' ? home.toLowerCase() : home
  }

  cancel(): void {
    this.cancellation.abort()
  }

  retire(completion: Promise<void>): void {
    let pending = retiringHomes.get(this.home)
    if (!pending) retiringHomes.set(this.home, pending = new Set())
    pending.add(completion)
    void completion.then(() => {
      pending.delete(completion)
      if (!pending.size && retiringHomes.get(this.home) === pending) retiringHomes.delete(this.home)
    }, () => { /* An unconfirmed retirement must keep blocking replacements. */ })
  }

  async wait(): Promise<boolean> {
    const signal = this.cancellation.signal
    if (signal.aborted) return false
    if (!retiringHomes.get(this.home)?.size) return true
    let abort!: () => void
    let timer: NodeJS.Timeout | undefined
    const cancelled = new Promise<boolean>(done => {
      abort = () => done(false)
      timer = setTimeout(abort, 5000)
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      while (retiringHomes.get(this.home)?.size) {
        const pending = [...retiringHomes.get(this.home)!]
        if (!await Promise.race([Promise.all(pending).then(() => true), cancelled])) return false
      }
      return !signal.aborted
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}

import { execFile, spawn } from 'node:child_process'
import { freshMacPath } from './macPath'

/** Only internal command builders create this object. Never expose it to IPC. */
export interface MobileCommand {
  executable: string
  args: string[]
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}
export interface MobileCommandOutput { stdout: Buffer }
export interface MobileOwnedProcess {
  isAlive(): boolean
  exited: Promise<void>
  stop(): Promise<boolean>
}
export interface MobileExecutor {
  run(command: MobileCommand): Promise<MobileCommandOutput>
  launch(command: MobileCommand): Promise<MobileOwnedProcess>
}
export class MobileProcessError extends Error {
  constructor(readonly reason: 'failed' | 'timeout' | 'cancelled' | 'limit' | 'unavailable') {
    super(reason)
    this.name = 'MobileProcessError'
  }
}

/** SDK processes do not receive account tokens or arbitrary parent options. */
export function mobileProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir',
    'home', 'userprofile', 'localappdata', 'appdata', 'lang', 'lc_all', 'display', 'wayland_display',
    'xdg_runtime_dir', 'android_home', 'android_sdk_root', 'android_avd_home', 'android_user_home',
    'developer_dir', 'java_home'])
  const filtered = Object.fromEntries(Object.entries(source).filter(([key, value]) => names.has(key.toLowerCase()) && typeof value === 'string'))
  // idb itself may be found by absolute path, but it resolves idb_companion
  // through PATH. Only the real ambient Mac environment gets the cached query.
  if (process.platform === 'darwin' && source === process.env) filtered.PATH = freshMacPath()
  return filtered
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export const mobileExecutor: MobileExecutor = {
  run(command) {
    return new Promise((resolve, reject) => {
      if (command.signal?.aborted) { reject(new MobileProcessError('cancelled')); return }
      let done = false
      let failure: MobileProcessError | undefined
      let total = 0
      const chunks: Buffer[] = []
      const child = spawn(command.executable, command.args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: mobileProcessEnvironment()
      })
      const finish = (error?: MobileProcessError): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (reapTimer) clearTimeout(reapTimer)
        command.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve({ stdout: Buffer.concat(chunks, total) })
      }
      let reapTimer: NodeJS.Timeout | undefined
      const terminate = (reason: MobileProcessError['reason']): void => {
        failure ??= new MobileProcessError(reason)
        try { child.kill() } catch { /* close/error will settle the command */ }
        reapTimer ??= setTimeout(() => finish(failure), 1500)
      }
      const abort = (): void => terminate('cancelled')
      const timer = setTimeout(() => terminate('timeout'), command.timeoutMs ?? 15_000)
      command.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return
        total += chunk.length
        if (total > (command.maxBytes ?? 512 * 1024)) { terminate('limit'); return }
        chunks.push(chunk)
      })
      // Drain, but never retain or publish arbitrary tool stderr.
      child.stderr.on('data', () => {})
      child.once('error', () => finish(failure ?? new MobileProcessError('unavailable')))
      child.once('close', code => finish(failure ?? (code === 0 ? undefined : new MobileProcessError('failed'))))
    })
  },
  launch(command) {
    return new Promise((resolve, reject) => {
      if (command.signal?.aborted) { reject(new MobileProcessError('cancelled')); return }
      const child = spawn(command.executable, command.args, {
        shell: false, windowsHide: true, stdio: 'ignore', env: mobileProcessEnvironment()
      })
      let alive = true
      let resolveExit!: () => void
      const exited = new Promise<void>(resolve => { resolveExit = resolve })
      const closed = (): void => { alive = false; resolveExit() }
      child.once('close', closed)
      child.once('error', () => { closed(); reject(new MobileProcessError('unavailable')) })
      const abort = (): void => { try { child.kill() } catch { /* already gone */ } }
      command.signal?.addEventListener('abort', abort, { once: true })
      child.once('spawn', () => {
        command.signal?.removeEventListener('abort', abort)
        let stopping: Promise<boolean> | undefined
        resolve({
          isAlive: () => alive,
          exited,
          stop: () => stopping ??= (async () => {
            if (!alive) return true
            // The live child handle guards against reuse of a historical PID.
            if (process.platform === 'win32' && child.pid) {
              await new Promise<void>(done => execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'],
                { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }, () => done()))
            } else { try { child.kill('SIGTERM') } catch { /* already gone */ } }
            await Promise.race([exited, pause(1500)])
            if (alive) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
            await Promise.race([exited, pause(1000)])
            return !alive
          })()
        })
      })
    })
  }
}

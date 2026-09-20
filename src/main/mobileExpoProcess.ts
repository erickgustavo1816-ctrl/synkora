import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createServer } from 'node:net'
import type { MobileOwnedProcess } from './mobileProcess'
import { MobileProcessError, mobileProcessEnvironment } from './mobileProcess'

export interface MobileExpoLaunch {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}
export interface MobileExpoPortReservation { port: number; release(): Promise<void> }
export type MobileExpoLauncher = (command: MobileExpoLaunch) => Promise<MobileOwnedProcess>

export async function reserveExpoPort(signal: AbortSignal): Promise<MobileExpoPortReservation> {
  if (signal.aborted) throw new MobileProcessError('cancelled')
  const server = createServer(socket => socket.destroy())
  let releasePromise: Promise<void> | undefined
  const release = (): Promise<void> => releasePromise ??= new Promise<void>(resolve => {
    signal.removeEventListener('abort', abort)
    if (!server.listening) { resolve(); return }
    server.close(() => resolve())
  })
  const abort = (): void => { void release() }
  return new Promise((resolve, reject) => {
    server.once('error', () => { signal.removeEventListener('abort', abort); reject(new MobileProcessError('unavailable')) })
    server.listen({ host: '0.0.0.0', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (signal.aborted || !address || typeof address === 'string') {
        void release().then(() => reject(new MobileProcessError('cancelled'))); return
      }
      signal.addEventListener('abort', abort, { once: true })
      resolve({ port: address.port, release })
    })
  })
}

async function waitForExit(exited: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try { await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]) }
  finally { if (timer) clearTimeout(timer) }
}

type ExpoChild = Pick<ChildProcess, 'pid' | 'on' | 'once' | 'kill'> & { stdout: Pick<Readable, 'resume'>; stderr: Pick<Readable, 'resume'> }
export interface MobileExpoProcessDeps {
  spawn?(command: MobileExpoLaunch): ExpoChild
  platform?: NodeJS.Platform
  terminateTree?(pid: number): Promise<boolean>
  waitMs?: number
}
/** Project code executes only here, following an explicit start and with a fixed CLI argument recipe. */
export function createExpoLauncher(deps: MobileExpoProcessDeps = {}): MobileExpoLauncher {
  return command => new Promise((resolve, reject) => {
  if (command.signal.aborted) { reject(new MobileProcessError('cancelled')); return }
  const platform = deps.platform ?? process.platform
  const child = deps.spawn ? deps.spawn(command) : spawn(command.executable, command.args, { cwd: command.cwd, env: command.env,
    shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  // Project logs may include credentials or arbitrary text. Drain both streams without retention.
  child.stdout.resume(); child.stderr.resume()
  let alive = true, closed = false, spawned = false, stopping: Promise<boolean> | undefined, resolveExit!: () => void, resolveClose!: () => void
  const exited = new Promise<void>(done => { resolveExit = done })
  const streamsClosed = new Promise<void>(done => { resolveClose = done })
  const onExit = (): void => { alive = false; resolveExit() }
  const onClose = (): void => { onExit(); closed = true; command.signal.removeEventListener('abort', abort); resolveClose() }
  const kill = (signal: NodeJS.Signals): void => {
    if (!alive) return
    try {
      if (platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { /* The tracked child may have exited between the handle check and termination. */ }
  }
  const stop = (): Promise<boolean> => {
    if (stopping) return stopping
    stopping = (async () => {
    if (closed) return true
    if (!alive) { await waitForExit(streamsClosed, deps.waitMs ?? 1500); return closed }
    // A currently live child handle is the authority for this one process tree.
    if (platform === 'win32' && child.pid) {
      const receipt = deps.terminateTree ? await deps.terminateTree(child.pid) : await new Promise<boolean>(done => execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'],
        { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024, env: mobileProcessEnvironment() }, error => done(!error)))
      if (!receipt) { await waitForExit(streamsClosed, deps.waitMs ?? 1500); return closed }
    } else kill('SIGTERM')
    await waitForExit(streamsClosed, deps.waitMs ?? 1500)
    if (alive) kill('SIGKILL')
    await waitForExit(streamsClosed, deps.waitMs ?? 1500)
    return closed
  })().catch(() => false)
    void stopping.then(stopped => { if (!stopped) stopping = undefined })
    return stopping
  }
  const abort = (): void => { void stop() }
  child.once('exit', onExit)
  child.once('close', onClose)
  child.on('error', () => {
    // A post-spawn error (for example EPERM while terminating) is not an exit receipt.
    if (!spawned && !child.pid) { onClose(); reject(new MobileProcessError('unavailable')) }
  })
  command.signal.addEventListener('abort', abort, { once: true })
  child.once('spawn', () => {
    spawned = true
    // Even cancellation must deliver the handle: an uncertain cleanup cannot discard ownership.
    if (command.signal.aborted) void stop()
    resolve({ isAlive: () => alive, exited, stop })
  })
  })
}
export const launchExpoProcess: MobileExpoLauncher = createExpoLauncher()

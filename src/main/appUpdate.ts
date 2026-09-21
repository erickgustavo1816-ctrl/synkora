/** App updates are owned by main; this factory never imports Electron at runtime. */
import type { AppUpdaterEvents } from 'electron-updater/out/AppUpdater'
// Declared mirror of src/preload/index.ts (mission-playbook, Auto-update).
export type AppUpdatePhase =
  | 'unsupported' | 'idle' | 'checking' | 'current'
  | 'available' | 'downloading' | 'ready' | 'error'

export interface AppUpdateStatus {
  phase: AppUpdatePhase
  version: string
  next?: string
  notes?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  checkedAt?: number
  error?: string
  reason?: string
}

// electron-builder generates resources/app-update.yml as the packaged source.
// This explicit mirror must agree with the publish block in electron-builder.yml.
export const APP_UPDATE_FEED = Object.freeze({
  provider: 'github' as const,
  owner: 'erickgustavo1816-ctrl',
  repo: 'synkora-releases'
})

interface UpdateInfo {
  version: string
  releaseNotes?: string | null | Array<{ version: string; note: string | null }>
}

type UpdateEvent = 'checking-for-update' | 'update-available' | 'update-not-available'
  | 'download-progress' | 'update-downloaded' | 'error'

/** Only the updater surface the controller needs; EventEmitter fakes work in Node. */
export interface AppUpdateUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  setFeedURL(feed: typeof APP_UPDATE_FEED): void
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
  on<K extends UpdateEvent>(event: K, listener: AppUpdaterEvents[K]): unknown
  removeListener?<K extends UpdateEvent>(event: K, listener: AppUpdaterEvents[K]): unknown
}

interface AppUpdateRecord {
  cat: 'app'
  event: 'app-update'
  detail: { phase: AppUpdatePhase; next?: string; error?: string }
}

export interface AppUpdateDependencies<Timer> {
  updater: AppUpdateUpdater | null // null only in development: no Electron/updater import
  version: string
  packaged: boolean
  now(): number
  record(event: AppUpdateRecord): void
  setTimer(callback: () => void, delayMs: number): Timer
  clearTimer(timer: Timer): void
}

export interface AppUpdateController {
  status(): AppUpdateStatus
  check(): Promise<AppUpdateStatus>
  download(): Promise<AppUpdateStatus>
  install(): { ok: boolean; error?: string }
  onStatus(listener: (status: AppUpdateStatus) => void): () => void
  start(): void
  stop(): void
}

function releaseNotes(info: UpdateInfo): string | undefined {
  const raw = typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : info.releaseNotes?.map(item => item.note ?? '').join('\n\n')
  if (!raw) return undefined
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  // Notes are displayed as text, never rendered as HTML. Preserve paragraphs and
  // link labels while dropping common HTML/Markdown presentation from the feed.
  return raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<https?:\/\/([^>]+)>/gi, 'https://$1')
    .replace(/<\/?(?:p|div|h[1-6]|li|br|ul|ol|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
      if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? entity
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
    })
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/([*`])([^\n]+?)\1/g, '$2')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim()
    .slice(0, 4000) || undefined
}

function humanError(error: unknown): string {
  const data = error !== null && typeof error === 'object'
    ? error as { message?: unknown; code?: unknown; statusCode?: unknown }
    : undefined
  const message = typeof data?.message === 'string' ? data.message.trim() : typeof error === 'string' ? error.trim() : ''
  const hint = `${data?.code ?? ''} ${data?.statusCode ?? ''} ${message}`
  if (/\b404\b|ERR_UPDATER_(?:NO_PUBLISHED_VERSIONS|LATEST_VERSION_NOT_FOUND)/i.test(hint)) {
    return 'nenhuma versão publicada ainda'
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_\w+)|network|offline|socket hang up/i.test(hint)) {
    return 'sem conexão para verificar atualizações'
  }
  return message || 'não foi possível atualizar; use Verificar atualizações para tentar novamente'
}

export function createAppUpdateController<Timer>(deps: AppUpdateDependencies<Timer>): AppUpdateController {
  const updater = deps.packaged ? deps.updater : null
  let state: AppUpdateStatus = updater
    ? { phase: 'idle', version: deps.version }
    : { phase: 'unsupported', version: deps.version, reason: 'atualização automática só existe no Synkora instalado' }
  const listeners = new Set<(status: AppUpdateStatus) => void>()
  const subscriptions: Array<() => void> = []
  let stopped = false
  let started = false
  let timer: Timer | undefined
  let lastCheckAt: number | undefined
  let checking = false
  let installing = false

  const status = (): AppUpdateStatus => ({ ...state })
  const record = (): void => {
    try {
      deps.record({ cat: 'app', event: 'app-update', detail: {
        phase: state.phase,
        ...(state.next ? { next: state.next } : {}),
        ...(state.error ? { error: state.error } : {})
      } })
    } catch { /* Telemetry cannot interrupt an update. */ }
  }
  const publish = (next: AppUpdateStatus): void => {
    if (stopped) return
    const keys = Object.keys(next) as Array<keyof AppUpdateStatus>
    if (keys.length === Object.keys(state).length && keys.every(key => state[key] === next[key])) return
    const phaseChanged = state.phase !== next.phase
    state = next
    if (phaseChanged) record()
    for (const listener of listeners) {
      try { listener(status()) } catch { /* A closing renderer must not abort the download. */ }
    }
  }
  const fail = (error: unknown): void => {
    installing = false
    publish({ ...state, phase: 'error', error: humanError(error),
      checkedAt: state.phase === 'checking' ? deps.now() : state.checkedAt })
  }
  const listen = <K extends UpdateEvent>(event: K, listener: AppUpdaterEvents[K]): void => {
    if (!updater) return
    updater.on(event, listener)
    subscriptions.push(() => updater.removeListener?.(event, listener))
  }
  const attach = (): void => {
    listen('checking-for-update', () => {
      publish({ phase: 'checking', version: deps.version, checkedAt: state.checkedAt })
    })
    listen('update-available', info => {
      publish({ phase: 'available', version: deps.version, next: info.version,
        notes: releaseNotes(info), checkedAt: deps.now() })
    })
    listen('update-not-available', () => {
      publish({ phase: 'current', version: deps.version, checkedAt: deps.now() })
    })
    listen('download-progress', progress => {
      const nonnegative = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0
      publish({ ...state, phase: 'downloading', error: undefined,
        percent: Math.min(100, nonnegative(progress.percent)),
        transferred: nonnegative(progress.transferred), total: nonnegative(progress.total),
        bytesPerSecond: nonnegative(progress.bytesPerSecond) })
    })
    listen('update-downloaded', info => {
      publish({ phase: 'ready', version: deps.version, next: info.version,
        notes: releaseNotes(info) ?? state.notes, checkedAt: state.checkedAt })
    })
    listen('error', fail)
  }

  record()
  if (updater) {
    attach()
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    try { updater.setFeedURL(APP_UPDATE_FEED) } catch (error) { fail(error) }
  }

  const check = async (): Promise<AppUpdateStatus> => {
    if (!updater || stopped || checking || ['available', 'downloading', 'ready'].includes(state.phase)) return status()
    const now = deps.now()
    if (lastCheckAt !== undefined && now - lastCheckAt < 30_000) return status()
    lastCheckAt = now
    checking = true
    publish({ phase: 'checking', version: deps.version, checkedAt: state.checkedAt })
    try {
      const result = await updater.checkForUpdates()
      // autoDownload belongs to electron-updater. Observe its promise too: a
      // rejected automatic download must not become an unhandled rejection.
      if (result?.downloadPromise) {
        void result.downloadPromise.catch(fail)
        if (state.phase === 'available') publish({ ...state, phase: 'downloading', percent: 0 })
      }
    } catch (error) { fail(error) }
    finally { checking = false }
    return status()
  }
  const schedule = (delay: number): void => {
    timer = deps.setTimer(() => {
      timer = undefined
      if (!started || stopped) return
      void check()
      if (started && !stopped) schedule(6 * 60 * 60_000)
    }, delay)
  }

  return {
    status,
    check,
    async download() {
      if (!updater || stopped || state.phase !== 'available') return status()
      publish({ ...state, phase: 'downloading', percent: 0 })
      try { await updater.downloadUpdate() } catch (error) { fail(error) }
      return status()
    },
    install() {
      // Recipe: appUpdate.check(), wait for the automatic download/ready,
      // then appUpdate.install(). Keep the IPC contract's refusal text exact.
      if (!updater || stopped || state.phase !== 'ready') {
        return { ok: false, error: 'nenhuma atualização pronta para instalar' }
      }
      if (installing) return { ok: true }
      installing = true
      try {
        updater.quitAndInstall(true, true) // Silent NSIS install, relaunch afterwards.
        // electron-updater can emit a synchronous error instead of throwing.
        const latest = status()
        return latest.phase === 'error' ? { ok: false, error: latest.error } : { ok: true }
      } catch (error) {
        fail(error)
        return { ok: false, error: state.error }
      }
    },
    onStatus(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start() {
      if (!updater || started || stopped) return
      started = true
      schedule(15_000)
    },
    stop() {
      stopped = true
      started = false
      if (timer !== undefined) deps.clearTimer(timer)
      timer = undefined
      subscriptions.splice(0).forEach(unsubscribe => unsubscribe())
      listeners.clear()
    }
  }
}

/** Call once inside app.whenReady(), before registering IPC/creating the window.
 * Only packaged apps load electron-updater or schedule network checks; dev still
 * exposes an unsupported controller to the same renderer contract. */
export function startAppUpdater({ blackbox, app }: {
  blackbox: { record(event: AppUpdateRecord): unknown }
  app: Pick<import('electron').App, 'isPackaged' | 'getVersion' | 'on' | 'once' | 'removeListener' | 'quit'>
}): AppUpdateController {
  let updater: AppUpdateUpdater | null = null
  if (app.isPackaged) {
    const native = (require('electron-updater') as typeof import('electron-updater')).autoUpdater
    updater = {
      get autoDownload() { return native.autoDownload },
      set autoDownload(value) { native.autoDownload = value },
      get autoInstallOnAppQuit() { return native.autoInstallOnAppQuit },
      set autoInstallOnAppQuit(value) { native.autoInstallOnAppQuit = value },
      get allowPrerelease() { return native.allowPrerelease },
      set allowPrerelease(value) { native.allowPrerelease = value },
      setFeedURL: feed => native.setFeedURL(feed),
      checkForUpdates: () => native.checkForUpdates(),
      downloadUpdate: () => native.downloadUpdate(),
      on: (event, listener) => native.on(event, listener),
      removeListener: (event, listener) => native.removeListener(event, listener),
      quitAndInstall: (silent, relaunch) => {
        // mobile.installQuit(app) in index.ts delays before-quit for up to 60s.
        // Starting NSIS first would let its process guard kill Synkora during
        // cleanup. This listener is added after the existing guard: wait for a
        // before-quit it allows, while windows still exist to display failures.
        // Keep the instance lock; NSIS waits for process exit before relaunch.
        const installWhenAllowed = (event: import('electron').Event): void => {
          if (event.defaultPrevented) return
          app.removeListener('before-quit', installWhenAllowed)
          try { native.quitAndInstall(silent, relaunch) }
          catch (error) { native.emit('error', error instanceof Error ? error : new Error(String(error))) }
          if (controller.status().phase === 'error') event.preventDefault()
        }
        app.on('before-quit', installWhenAllowed)
        app.quit()
      }
    }
  }
  const controller: AppUpdateController = createAppUpdateController({
    updater, version: app.getVersion(), packaged: app.isPackaged, now: Date.now,
    record: event => { blackbox.record(event) },
    setTimer: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref()
      return timer
    },
    clearTimer: clearTimeout
  })
  // Keep listeners alive through will-quit so installer errors can be reported.
  app.once('quit', () => controller.stop())
  controller.start()
  return controller
}

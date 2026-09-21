/** One runtime serves owner IPC and identity-bound MCP; all lifecycle hooks meet here. */
import type { App, BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { MainContext } from './mainContext'
import { MobileRuntimeManager } from './mobileRuntime'
import { MobileExpoManager } from './mobileExpo'
import { MobileVideoRegistry } from './mobileVideo'
import { buildGuiMobileTools, type MobileAgentContextDeps } from './guiMobileTools'
import { registerMobileIpc } from './ipc/mobile'
import { missionTypeOf } from './guiMissionContracts'
import type { MobileMonitorScale } from '../shared/mobileSimulator'
import { MobilePresentationManager, type MobileSurface } from './mobilePresentation'
import { MobilePopoutWindows, type MobilePopoutWindowDeps } from './mobilePopoutWindow'
import { MobileCalibrationStore } from './mobileCalibrationStore'

/** Electron does not await will-quit promises. Bound and complete one before-quit cleanup. */
export function installMobileQuitGuard(
  lifecycle: Pick<App, 'on' | 'quit'>,
  dispose: () => Promise<void>,
  onTimeout: () => void,
  timeoutMs = 60000
): void {
  let pending = false
  let finished = false
  lifecycle.on('before-quit', event => {
    if (finished) return
    event.preventDefault()
    if (pending) return
    pending = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => { timer = setTimeout(() => { try { onTimeout() } catch { /* diagnostic only */ } resolve() }, timeoutMs) })
    void Promise.race([Promise.resolve().then(dispose).catch(() => undefined), deadline]).finally(() => {
      if (timer) clearTimeout(timer)
      finished = true
      lifecycle.quit()
    })
  })
}

export function createMobileIntegration(ctx: MainContext, deps: Pick<MobileAgentContextDeps, 'helperOf'> & {
  cacheRoot: string; inputServerPath?: string; monitorScale?: (window: BrowserWindow) => Promise<MobileMonitorScale | null>
  /** userData JSON holding the shared "Tamanho real" calibration. */
  calibrationFile?: string
  phone?: Pick<MobilePopoutWindowDeps, 'preloadFile' | 'rendererUrl' | 'trustedUrl' | 'ownerBounds'>
}) {
  let video: MobileVideoRegistry | undefined
  let presentation: MobilePresentationManager | undefined
  const resolveMission = (missionId: string) => {
    const mission = ctx.missions.get(missionId)
    const project = mission ? ctx.projects.get(mission.projectId) : undefined
    if (!mission || mission.id !== missionId || !project || project.id !== mission.projectId || !mission.direct ||
      !['dev', 'release'].includes(missionTypeOf(mission)) ||
      !['ativa', 'integrando'].includes(mission.status)) return null
    return { projectId: project.id, rootPath: missionTypeOf(mission) === 'release' ? project.path : mission.worktree || project.path }
  }
  const runtime = new MobileRuntimeManager({
    resolveMission,
    managedApkRoot: deps.cacheRoot,
    inputServerPath: deps.inputServerPath,
    onChanged: missionId => presentation ? presentation.changed(missionId) : ctx.pushBoard('mobile:changed', missionId),
    onSessionClosed: (missionId, sessionId) => {
      void presentation?.closeSession(missionId, sessionId)
      void video?.closeSession(missionId, sessionId)
    },
    log: event => ctx.blackbox.record({ cat: 'pane', event: event.event, actor: 'harness',
      ids: { missionId: event.missionId }, detail: { sessionId: event.sessionId, platform: event.platform, outcome: event.outcome } })
  })
  video = new MobileVideoRegistry({ serverPath: deps.inputServerPath,
    resolveTarget: (missionId, sessionId) => runtime.videoTarget(missionId, sessionId),
    emit: packet => presentation?.emit(packet) })
  const expo = new MobileExpoManager({ resolveMission, cacheRoot: deps.cacheRoot, runtime,
    onChanged: missionId => ctx.pushBoard('mobile:changed', missionId) })
  const streams = video
  const windows = deps.phone ? new MobilePopoutWindows({ ...deps.phone,
    binding: windowId => presentation?.binding(windowId),
    onDock: windowId => { void presentation?.dockWindow(windowId) },
    onVisibility: windowId => { void presentation?.visibilityChanged(windowId) },
    onInvalidated: sender => presentation?.invalidateSurface(sender)
  }) : undefined
  const calibration = new MobileCalibrationStore(deps.calibrationFile)
  calibration.onChange(() => {
    const owner = ctx.mainWindow
    if (owner && !owner.isDestroyed()) owner.webContents.send('mobile:calibrationChanged')
    windows?.broadcast('mobile:phone:calibrationChanged')
  })
  const views = presentation = new MobilePresentationManager({
    resolveScope: resolveMission,
    snapshot: (missionId, sessionId) => runtime.sessionSnapshot(missionId, sessionId),
    video: streams,
    capture: (missionId, sessionId) => runtime.capture(missionId, sessionId),
    act: (missionId, sessionId, action, signal) => runtime.act(missionId, sessionId, action, { kind: 'owner' }, signal),
    pointer: (missionId, sessionId, input) => runtime.pointer(missionId, sessionId, input),
    createWindow: binding => {
      if (!windows) throw new Error('Mobile phone windows are not configured')
      return windows.create(binding)
    },
    onChanged: missionId => ctx.pushBoard('mobile:changed', missionId)
  })
  const toolkit = buildGuiMobileTools({ runtime, expo, context: {
    identityOf: paneId => ctx.hub.identityByPane(paneId),
    missionOf: missionId => ctx.missions.get(missionId),
    projectOf: projectId => ctx.projects.get(projectId),
    helperOf: deps.helperOf
  }, log: event => ctx.blackbox.record({ cat: 'mcp', event: 'mobile-tool-result', actor: 'harness',
    ids: { paneId: event.paneId, missionId: event.missionId, projectId: event.projectId },
    detail: { operation: event.operation, outcome: event.outcome, durationMs: event.durationMs } }) })
  return {
    toolkit,
    registerIpc(assertOwnerSender: (event: IpcMainInvokeEvent | IpcMainEvent) => void): void {
      const ownerSurface = (event: IpcMainInvokeEvent | IpcMainEvent): MobileSurface => {
        assertOwnerSender(event)
        const window = ctx.mainWindow, sender = event.sender, frame = event.senderFrame
        if (!window || window.isDestroyed() || window.webContents !== sender || !frame) throw new Error('Mobile owner unavailable')
        const current = (): boolean => {
          try {
            if (window.isDestroyed() || ctx.mainWindow !== window || sender.isDestroyed() || sender.mainFrame !== frame) return false
            assertOwnerSender({ sender, senderFrame: frame } as IpcMainEvent)
            return true
          } catch { return false }
        }
        return { kind: 'dock', sender, frame, current,
          visible: () => current() && window.isVisible() && !window.isMinimized(),
          send: (channel, payload) => { if (current()) sender.send(channel, payload) } }
      }
      const resolvePhone = (event: IpcMainInvokeEvent | IpcMainEvent) => {
        if (!windows) throw new Error('Mobile phone windows unavailable')
        return windows.resolve(event)
      }
      registerMobileIpc({ assertOwnerSender, runtime, expo, presentation: views, ownerSurface, resolvePhone, calibration,
        monitorScale: async event => {
          let window: BrowserWindow, surface: MobileSurface
          try { surface = ownerSurface(event); window = ctx.mainWindow! }
          catch { const phone = resolvePhone(event); window = phone.window; surface = phone.surface }
          const value = await deps.monitorScale?.(window) ?? null
          return surface.current() ? value : null
        } })
    },
    bindOwnerWindow(window: BrowserWindow): void {
      const sender = window.webContents
      sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) views.invalidateSurface(sender) })
      sender.on('render-process-gone', () => views.invalidateSurface(sender))
      const visibility = (): void => { void views.surfaceVisibilityChanged(sender) }
      window.on('minimize', visibility); window.on('restore', visibility)
      window.on('show', visibility); window.on('hide', visibility)
      window.on('closed', () => { views.invalidateSurface(sender); void views.closeWindows() })
    },
    releaseController(paneId: string): void { expo.releaseController(paneId); runtime.releaseController(paneId) },
    async closeMission(missionId: string): Promise<void> {
      // Revocation is synchronous inside closeMission, before its first await.
      // Closing video immediately drops queued pixels before the worktree is removed.
      const closingWindows = views.closeMission(missionId), closingVideo = streams.closeMission(missionId)
      await Promise.all([closingWindows, closingVideo, expo.closeMission(missionId), runtime.closeMission(missionId)])
    },
    installQuit(lifecycle: Pick<App, 'on' | 'quit'>): void {
      installMobileQuitGuard(lifecycle, async () => { const closingWindows = views.dispose(), closingVideo = streams.dispose(); await Promise.allSettled([closingWindows, closingVideo, expo.dispose(), runtime.dispose()]) }, () => {
        ctx.blackbox.record({ cat: 'app', event: 'mobile-quit-timeout', actor: 'harness' })
      })
    }
  }
}

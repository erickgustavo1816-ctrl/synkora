/** Owner gestures have a fixed actor; agent authority exists only in MCP. */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { MobileMonitorScale } from '../../shared/mobileSimulator'
import { MOBILE_CALIBRATION_KEY_PATTERN, type MobileCalibrationStoreLike } from '../mobileCalibrationStore'
import type { MobileExpoLike, MobileRuntimeLike } from '../guiMobileTools'
import { mobileActionSchema, mobileExpoStartSchema, mobileIdentifierSchema, mobileStartSchema } from '../mobileToolCatalog'
import { isMobileVisualAction, type MobilePhoneBinding, type MobilePresentationManager, type MobileSurface } from '../mobilePresentation'

export interface MobileIpcDeps {
  assertOwnerSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  runtime: MobileRuntimeLike
  expo: MobileExpoLike
  monitorScale?(event: IpcMainInvokeEvent): Promise<MobileMonitorScale | null>
  /** Shared "Tamanho real" record; the panel and detached phones read the same value. */
  calibration?: MobileCalibrationStoreLike
  presentation: MobilePresentationManager
  ownerSurface(event: IpcMainInvokeEvent | IpcMainEvent): MobileSurface
  resolvePhone(event: IpcMainInvokeEvent | IpcMainEvent): { binding: MobilePhoneBinding; surface: MobileSurface }
}

export function registerMobileIpc(deps: MobileIpcDeps): void {
  const owner = { kind: 'owner' as const }
  const pointerInput = z.object({
    phase: z.enum(['down', 'move', 'up', 'cancel']),
    gestureId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1)
  }).strict()
  const handle = <T extends unknown[]>(channel: string, schema: z.ZodType<T>, run: (event: IpcMainInvokeEvent, ...args: T) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, ...input: unknown[]) => {
      try { deps.assertOwnerSender(event) } catch {
        return { ok: false, error: 'O painel Mobile da janela principal é o único que pode enviar esta ação.' }
      }
      const parsed = schema.safeParse(input)
      if (!parsed.success) return { ok: false, error: 'Pedido Mobile inválido. Atualize o painel e repita a ação com uma sessão válida.' }
      try { return await run(event, ...parsed.data) } catch {
        return { ok: false, error: 'Não consegui concluir a ação Mobile. Atualize o painel para conferir a sessão antes de repetir.' }
      }
    })
  }
  handle('mobile:monitorScale', z.tuple([]), async event => ({ ok: true, value: await deps.monitorScale?.(event) ?? null }))
  const calibrationKey = z.string().regex(MOBILE_CALIBRATION_KEY_PATTERN), calibrationValue = z.number().finite().min(.5).max(20).nullable()
  handle('mobile:calibrationRead', z.tuple([calibrationKey]), async (_event, key) => ({ ok: true, value: deps.calibration?.read(key) ?? null }))
  handle('mobile:calibrationWrite', z.tuple([calibrationKey, calibrationValue]), async (_event, key, value) => ({ ok: true, value: deps.calibration?.write(key, value) ?? false }))
  handle('mobile:expoInspect', z.tuple([mobileIdentifierSchema]), (_event, missionId) => deps.expo.inspect(missionId, owner))
  handle('mobile:expoStart', z.tuple([mobileIdentifierSchema, mobileExpoStartSchema.optional()]), (_event, missionId, request?: z.infer<typeof mobileExpoStartSchema>) => deps.expo.start(missionId, request, owner))
  handle('mobile:expoStop', z.tuple([mobileIdentifierSchema]), (_event, missionId) => deps.expo.stop(missionId, owner))
  handle('mobile:expoOpenAndroid', z.tuple([mobileIdentifierSchema, mobileIdentifierSchema]), (_event, missionId, sessionId) => deps.expo.openAndroid(missionId, sessionId, owner))
  handle('mobile:expoInstallGo', z.tuple([mobileIdentifierSchema, mobileIdentifierSchema]), (_event, missionId, sessionId) => deps.expo.installGo(missionId, sessionId, owner))
  handle('mobile:inspect', z.tuple([mobileIdentifierSchema]), async (_event, missionId) => {
    const result = await deps.runtime.inspect(missionId, owner)
    return result.ok ? { ok: true, value: deps.presentation.decorate(result.value) } : result
  })
  handle('mobile:start', z.tuple([mobileIdentifierSchema, mobileStartSchema]), (_event, missionId, request) => deps.runtime.start(missionId, request, owner))
  handle('mobile:stop', z.tuple([mobileIdentifierSchema, mobileIdentifierSchema]), (_event, missionId, sessionId) => deps.runtime.stop(missionId, sessionId, owner))
  const session = [mobileIdentifierSchema, mobileIdentifierSchema] as const
  handle('mobile:detach', z.tuple(session), (_event, missionId, sessionId) => deps.presentation.detach(missionId, sessionId))
  handle('mobile:focusDetached', z.tuple(session), (_event, missionId, sessionId) => deps.presentation.focusDetached(missionId, sessionId))
  handle('mobile:dock', z.tuple(session), (_event, missionId, sessionId) => deps.presentation.dock(missionId, sessionId))
  handle('mobile:acquireView', z.tuple(session), (event, missionId, sessionId) => deps.presentation.acquireView(deps.ownerSurface(event), missionId, sessionId))
  handle('mobile:releaseView', z.tuple([...session, mobileIdentifierSchema]), (event, missionId, sessionId, consumerId) => deps.presentation.releaseView(deps.ownerSurface(event), missionId, sessionId, consumerId))
  handle('mobile:capture', z.tuple([...session, mobileIdentifierSchema]), (event, missionId, sessionId, consumerId) => deps.presentation.capture(deps.ownerSurface(event), missionId, sessionId, consumerId))
  handle('mobile:act', z.tuple([...session, mobileActionSchema, mobileIdentifierSchema.optional()]), (event, missionId, sessionId, action, consumerId?: string) => isMobileVisualAction(action)
    ? deps.presentation.act(deps.ownerSurface(event), missionId, sessionId, action, consumerId ?? '') : deps.runtime.act(missionId, sessionId, action, owner))
  handle('mobile:pointer', z.tuple([...session, pointerInput, mobileIdentifierSchema]), (event, missionId, sessionId, input, consumerId) => deps.presentation.pointer(deps.ownerSurface(event), missionId, sessionId, input, consumerId))
  handle('mobile:setVideoVisible', z.tuple([...session, z.boolean(), mobileIdentifierSchema]), (event, missionId, sessionId, visible, consumerId) => deps.presentation.setVideoVisible(deps.ownerSurface(event), missionId, sessionId, visible, consumerId))

  const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  const acknowledgment = z.tuple([...session, mobileIdentifierSchema, timestamp, mobileIdentifierSchema])
  ipcMain.on('mobile:videoAck', (event, ...input: unknown[]) => {
    try {
      deps.assertOwnerSender(event)
      const parsed = acknowledgment.safeParse(input)
      if (parsed.success) deps.presentation.acknowledge(deps.ownerSurface(event), ...parsed.data)
    } catch { /* foreign senders and stale acknowledgments never affect a stream */ }
  })

  const phone = <T extends unknown[]>(channel: string, schema: z.ZodType<T>, run: (resolved: ReturnType<MobileIpcDeps['resolvePhone']>, event: IpcMainInvokeEvent, ...args: T) => unknown): void => {
    ipcMain.handle(`mobile:phone:${channel}`, async (event, ...input: unknown[]) => {
      try {
        const resolved = deps.resolvePhone(event)
        const parsed = schema.safeParse(input)
        if (!parsed.success) return { ok: false, error: 'Pedido inválido para esta janela Mobile. Reabra o aparelho pelo painel.' }
        return await run(resolved, event, ...parsed.data)
      } catch { return { ok: false, error: 'Esta janela Mobile não está mais ativa. Reabra o aparelho pelo painel da missão.' } }
    })
  }
  phone('describe', z.tuple([]), ({ binding }) => deps.presentation.describe(binding.windowId))
  phone('acquireView', z.tuple([]), ({ binding: b, surface }) => deps.presentation.acquireView(surface, b.missionId, b.sessionId))
  phone('releaseView', z.tuple([mobileIdentifierSchema]), ({ binding: b, surface }, _event, token) => deps.presentation.releaseView(surface, b.missionId, b.sessionId, token))
  phone('capture', z.tuple([mobileIdentifierSchema]), ({ binding: b, surface }, _event, token) => deps.presentation.capture(surface, b.missionId, b.sessionId, token))
  phone('act', z.tuple([mobileActionSchema.refine(isMobileVisualAction), mobileIdentifierSchema]), ({ binding: b, surface }, _event, action, token) => deps.presentation.act(surface, b.missionId, b.sessionId, action, token))
  phone('pointer', z.tuple([pointerInput, mobileIdentifierSchema]), ({ binding: b, surface }, _event, input, token) => deps.presentation.pointer(surface, b.missionId, b.sessionId, input, token))
  phone('setVideoVisible', z.tuple([z.boolean(), mobileIdentifierSchema]), ({ binding: b, surface }, _event, visible, token) => deps.presentation.setVideoVisible(surface, b.missionId, b.sessionId, visible, token))
  phone('monitorScale', z.tuple([]), async (_resolved, event) => ({ ok: true, value: await deps.monitorScale?.(event) ?? null }))
  phone('calibrationRead', z.tuple([calibrationKey]), (_resolved, _event, key) => ({ ok: true, value: deps.calibration?.read(key) ?? null }))
  phone('calibrationWrite', z.tuple([calibrationKey, calibrationValue]), (_resolved, _event, key, value) => ({ ok: true, value: deps.calibration?.write(key, value) ?? false }))
  phone('resize', z.tuple([z.object({ width: z.number().int().min(100).max(8192), height: z.number().int().min(100).max(8192) }).strict()]), ({ binding }, _event, geometry) => deps.presentation.resize(binding.windowId, geometry))
  phone('dock', z.tuple([]), ({ binding }) => deps.presentation.dockWindow(binding.windowId))
  const phoneAck = z.tuple([mobileIdentifierSchema, timestamp, mobileIdentifierSchema])
  ipcMain.on('mobile:phone:videoAck', (event, ...input: unknown[]) => {
    try {
      const { binding, surface } = deps.resolvePhone(event), parsed = phoneAck.safeParse(input)
      if (parsed.success) deps.presentation.acknowledge(surface, binding.missionId, binding.sessionId, ...parsed.data)
    } catch { /* a retired or foreign window has no ACK authority */ }
  })
}

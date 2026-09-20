/** Agent tools bind the authenticated conversation to a live development mission. */
import { lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { guiMissionPaneId, missionTypeOf } from './guiMissionContracts'
import { redactSensitiveText } from './securityRedaction'
import type { PaneIdentity } from './hub'
import type { MobileAction, MobileActor, MobileFrame, MobilePointerInput, MobileResult, MobileSession, MobileStartRequest, MobileState } from '../shared/mobileSimulator'
import type { MobileExpoStartRequest, MobileExpoState } from '../shared/mobileExpo'

export const MOBILE_TOOL_NAMES = ['mobile_status', 'mobile_start', 'mobile_stop', 'mobile_screenshot', 'mobile_action', 'mobile_expo'] as const
export const MOBILE_ENGINE_OFF = 'O motor Mobile não está disponível. Nenhum dispositivo foi iniciado ou verificado. Reinicie o Synkora e chame mobile_status para conferir a disponibilidade.'
const CONTEXT_REFUSAL = 'Esta conversa não tem uma missão de desenvolvimento ativa e válida para o Mobile. Reabra o chat da missão e chame mobile_status. Nenhum comando foi enviado.'

export interface MobileRuntimeLike {
  inspect(missionId: string, actor?: MobileActor): Promise<MobileResult<MobileState>>
  start(missionId: string, request: MobileStartRequest, actor?: MobileActor): Promise<MobileResult<MobileSession>>
  stop(missionId: string, sessionId: string, actor?: MobileActor): Promise<MobileResult>
  capture(missionId: string, sessionId: string, actor?: MobileActor): Promise<MobileResult<MobileFrame>>
  act(missionId: string, sessionId: string, action: MobileAction, actor?: MobileActor): Promise<MobileResult>
  /** Owner renderer only; deliberately absent from the agent toolkit. */
  pointer?(missionId: string, sessionId: string, input: MobilePointerInput): Promise<MobileResult>
}

export interface MobileExpoLike {
  inspect(missionId: string, actor?: MobileActor): Promise<MobileResult<MobileExpoState>>
  start(missionId: string, request?: MobileExpoStartRequest, actor?: MobileActor): Promise<MobileResult<MobileExpoState>>
  stop(missionId: string, actor?: MobileActor): Promise<MobileResult>
  openAndroid(missionId: string, sessionId: string, actor?: MobileActor): Promise<MobileResult>
  installGo(missionId: string, sessionId: string, actor?: MobileActor): Promise<MobileResult>
}

export type MobileExpoToolRequest =
  | { action: 'status' | 'start' | 'stop' }
  | { action: 'open_android' | 'install_go'; sessionId: string }

export interface MobileMissionContext {
  id: string
  projectId: string
  direct?: boolean
  missionType?: 'dev' | 'planejamento' | 'release'
  status: string
  worktree?: string
}

export interface MobileAgentContextDeps {
  identityOf(paneId: string): PaneIdentity | undefined
  missionOf(missionId: string): MobileMissionContext | undefined
  projectOf(projectId: string): { id: string; path: string } | undefined
  helperOf(paneId: string): { delegatorPaneId: string; projectId: string; cwd: string; state: string } | undefined
}

export interface MobileAgentTarget {
  paneId: string
  missionId: string
  projectId: string
  rootPath: string
}

function physicalRoot(path: string): string | undefined {
  try {
    if (!path || path.includes('\0')) return undefined
    const root = resolve(path)
    const stat = lstatSync(root)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined
    return realpathSync.native(root)
  } catch { return undefined }
}

const rootKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
const sameRoot = (left: string, right: string): boolean => {
  const a = physicalRoot(left), b = physicalRoot(right)
  return Boolean(a && b && rootKey(a) === rootKey(b))
}

function sameIdentity(left: PaneIdentity, right: PaneIdentity): boolean {
  return left.paneId === right.paneId && left.projectId === right.projectId && left.role === right.role &&
    left.cwd === right.cwd && left.missionId === right.missionId && left.delegatorPaneId === right.delegatorPaneId
}

/** No tool argument can choose a project, mission, root or another controller. */
export function resolveMobileAgentTarget(deps: MobileAgentContextDeps, identity: PaneIdentity): MobileAgentTarget | undefined {
  const live = deps.identityOf(identity.paneId)
  if (!live || !sameIdentity(live, identity)) return undefined
  let developer = live
  if (live.role === 'ajudante') {
    const helper = deps.helperOf(live.paneId)
    const delegator = live.delegatorPaneId ? deps.identityOf(live.delegatorPaneId) : undefined
    if (!helper || !delegator || !['spawning', 'working'].includes(helper.state) ||
      helper.delegatorPaneId !== live.delegatorPaneId || helper.projectId !== live.projectId ||
      delegator.projectId !== live.projectId || !sameRoot(helper.cwd, live.cwd) || !sameRoot(delegator.cwd, live.cwd)) return undefined
    developer = delegator
  } else if (live.role !== 'gui-delegator') return undefined
  if (developer.role !== 'gui-delegator' || !developer.missionId ||
    developer.paneId !== guiMissionPaneId('dev', developer.missionId)) return undefined
  if (live.missionId && live.missionId !== developer.missionId) return undefined
  const mission = deps.missionOf(developer.missionId)
  const project = deps.projectOf(live.projectId)
  if (!mission || !project || project.id !== live.projectId || mission.projectId !== project.id ||
    !mission.direct || missionTypeOf(mission) !== 'dev' || !['ativa', 'integrando'].includes(mission.status)) return undefined
  const rootPath = physicalRoot(mission.worktree || project.path)
  if (!rootPath || !sameRoot(live.cwd, rootPath) || !sameRoot(developer.cwd, rootPath)) return undefined
  return { paneId: live.paneId, missionId: mission.id, projectId: project.id, rootPath }
}

export interface MobileToolReply {
  ok: boolean
  text: string
  image?: { data: string; mimeType: 'image/png' }
}

export interface GuiMobileToolkit {
  status(identity: PaneIdentity): Promise<MobileToolReply>
  start(identity: PaneIdentity, request: MobileStartRequest): Promise<MobileToolReply>
  stop(identity: PaneIdentity, sessionId: string): Promise<MobileToolReply>
  screenshot(identity: PaneIdentity, sessionId: string): Promise<MobileToolReply>
  action(identity: PaneIdentity, sessionId: string, action: MobileAction): Promise<MobileToolReply>
  expo(identity: PaneIdentity, request: MobileExpoToolRequest): Promise<MobileToolReply>
}

const safeText = (text: string): string => redactSensitiveText(text).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1200)
const failure = (text: string): MobileToolReply => ({ ok: false, text })

export function buildGuiMobileTools(deps: {
  context: MobileAgentContextDeps
  runtime: MobileRuntimeLike
  expo?: MobileExpoLike
  log?(event: { operation: string; paneId: string; missionId?: string; projectId?: string; outcome: 'ok' | 'failed'; durationMs: number }): void
}): GuiMobileToolkit {
  const run = async <T>(identity: PaneIdentity, operation: string,
    execute: (target: MobileAgentTarget, actor: MobileActor) => Promise<MobileResult<T>>,
    describe: (value: T) => MobileToolReply): Promise<MobileToolReply> => {
    const started = Date.now()
    let target: MobileAgentTarget | undefined
    let result = failure(CONTEXT_REFUSAL)
    try {
      target = resolveMobileAgentTarget(deps.context, identity)
      if (!target) return result
      const outcome = await execute(target, { kind: 'agent', paneId: target.paneId })
      const current = resolveMobileAgentTarget(deps.context, identity)
      if (!current || current.missionId !== target.missionId || current.projectId !== target.projectId ||
        rootKey(current.rootPath) !== rootKey(target.rootPath)) {
        result = failure('O vínculo da conversa mudou durante a operação. O resultado não foi confirmado. Reabra a missão e use mobile_status antes de continuar.')
      } else result = outcome.ok ? describe(outcome.value) : failure(`${safeText(outcome.error)} Receita: confira mobile_status antes de repetir.`)
      return result
    } catch {
      result = failure('Não consegui concluir a operação Mobile. Use mobile_status para conferir a sessão antes de repetir; nenhum resultado foi confirmado.')
      return result
    } finally {
      try { deps.log?.({ operation, paneId: identity.paneId, missionId: target?.missionId, projectId: target?.projectId,
        outcome: result.ok ? 'ok' : 'failed', durationMs: Math.max(0, Date.now() - started) }) } catch { /* diagnostics never change the receipt */ }
    }
  }
  return {
    status: identity => run(identity, 'mobile_status', (target, actor) => deps.runtime.inspect(target.missionId, actor), state => ({
      ok: true,
      text: JSON.stringify({ hostPlatform: state.hostPlatform,
        platforms: state.platforms.map(item => ({ ...item, title: safeText(item.title), reason: item.reason ? safeText(item.reason) : undefined, setupSteps: item.setupSteps.map(safeText) })),
        devices: state.devices.map(item => ({ ...item, name: safeText(item.name), runtime: item.runtime ? safeText(item.runtime) : undefined })),
        sessions: state.sessions.map(item => ({ ...item, deviceName: safeText(item.deviceName), error: item.error ? safeText(item.error) : undefined })),
        recipe: 'Use mobile_start com um deviceId disponível; depois use o sessionId retornado. A sessão de outro agente não pode ser controlada. iOS requer macOS; inputAvailable informa se há gestos.' }, null, 2)
    })),
    start: (identity, request) => run(identity, 'mobile_start', (target, actor) => deps.runtime.start(target.missionId, request, actor), session => ({
      ok: true, text: JSON.stringify({ sessionId: session.id, platform: session.platform, deviceName: safeText(session.deviceName), state: session.state,
        inputAvailable: session.inputAvailable, displayProfileId: session.displayProfileId,
        recipe: 'Use mobile_screenshot para observar e mobile_action para agir nesta sessão. Coordenadas normalizadas de 0 a 1.' }, null, 2)
    })),
    stop: (identity, sessionId) => run(identity, 'mobile_stop', (target, actor) => deps.runtime.stop(target.missionId, sessionId, actor), () => ({ ok: true, text: 'Sessão Mobile encerrada. Use mobile_status para conferir os dispositivos disponíveis.' })),
    screenshot: (identity, sessionId) => run(identity, 'mobile_screenshot', (target, actor) => deps.runtime.capture(target.missionId, sessionId, actor), frame => {
      if (frame.sessionId !== sessionId || frame.mimeType !== 'image/png' || !frame.data || frame.data.length > 24 * 1024 * 1024 ||
        !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || !Number.isFinite(frame.capturedAt)) {
        return failure('A captura Mobile não retornou um quadro válido. Use mobile_status e repita mobile_screenshot; nenhuma tela foi verificada.')
      }
      return { ok: true, text: `Captura da sessão ${sessionId}: ${frame.width} × ${frame.height}px, obtida em ${frame.capturedAt}. Coordenadas de mobile_action são normalizadas de 0 a 1 na orientação desta imagem. A imagem está no resultado; não foi gravada no disco.`,
        image: { data: frame.data, mimeType: 'image/png' } }
    }),
    action: (identity, sessionId, action) => run(identity, 'mobile_action', (target, actor) => deps.runtime.act(target.missionId, sessionId, action, actor), () => ({
      ok: true, text: 'Ação enviada à sua sessão Mobile. Use mobile_screenshot quando precisar confirmar o resultado visual; o comando concluído não confirma o estado do aplicativo.'
    })),
    expo: (identity, request) => {
      const expo = deps.expo
      if (!expo) return Promise.resolve(failure('O serviço Expo não está disponível. Reinicie o Synkora e confira mobile_expo com action status. Nenhum servidor foi iniciado.'))
      const metadata = (state: MobileExpoState): MobileToolReply => ({ ok: true, text: JSON.stringify({
        project: { kind: state.project.kind, expoVersion: state.project.expoVersion ? safeText(state.project.expoVersion) : undefined,
          sdkVersion: state.project.sdkVersion ? safeText(state.project.sdkVersion) : undefined,
          dependenciesInstalled: state.project.dependenciesInstalled, hasDevClient: state.project.hasDevClient, message: safeText(state.project.message) },
        status: state.status, addresses: state.addresses.map(safeText), selectedAddress: state.selectedAddress ? safeText(state.selectedAddress) : undefined,
        port: state.port, lanUrl: state.lanUrl ? safeText(state.lanUrl) : undefined, androidUrl: state.androidUrl ? safeText(state.androidUrl) : undefined,
        error: state.error ? safeText(state.error) : undefined,
        recipe: 'Use start para iniciar o Expo local. Em Android, use open_android com sua sessão; se Expo Go estiver ausente, install_go é uma instalação explícita. Para iPhone físico, abra a URL LAN no Expo Go pela mesma rede. O QR está no painel Mobile; Windows não simula iOS.'
      }, null, 2) })
      switch (request.action) {
        case 'status': return run(identity, 'mobile_expo_status', (target, actor) => expo.inspect(target.missionId, actor), metadata)
        case 'start': return run(identity, 'mobile_expo_start', (target, actor) => expo.start(target.missionId, {}, actor), metadata)
        case 'stop': return run(identity, 'mobile_expo_stop', (target, actor) => expo.stop(target.missionId, actor), () => ({ ok: true, text: 'Servidor Expo desta missão encerrado. Use mobile_expo com action status para conferir.' }))
        case 'open_android': return run(identity, 'mobile_expo_open_android', (target, actor) => expo.openAndroid(target.missionId, request.sessionId, actor), () => ({ ok: true, text: 'Projeto Expo enviado à sua sessão Android. Use mobile_screenshot para confirmar o carregamento.' }))
        case 'install_go': return run(identity, 'mobile_expo_install_go', (target, actor) => expo.installGo(target.missionId, request.sessionId, actor), () => ({ ok: true, text: 'Expo Go instalado na sua sessão Android. Use mobile_expo com action open_android e confirme com mobile_screenshot.' }))
      }
    }
  }
}

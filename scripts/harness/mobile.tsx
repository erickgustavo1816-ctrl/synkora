import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MobileApi, MobileState } from '../../src/shared/mobileSimulator'
import type { MobileExpoState } from '../../src/shared/mobileExpo'
import { getMobileDeviceProfile } from '../../src/shared/mobileDeviceProfiles'
import DockMobile from '../../src/renderer/src/components/DockMobile'
import WorkspacePanels from '../../src/renderer/src/workspace/WorkspacePanels'
import WorkspaceToolbar from '../../src/renderer/src/workspace/WorkspaceToolbar'
import { useWorkspaceLayout } from '../../src/renderer/src/workspace/useWorkspaceLayout'
import { availableWorkspacePanels } from '../../src/renderer/src/workspacePanels'
import '../../src/renderer/src/workspace/workspacePanels.css'

// Production components and CSS; the bridge and app screen are synthetic.
// Offscreen Chromium reports the window bounds as screen bounds. Model a fixed
// monitor so resizing the test window remains distinct from switching monitors.
const fixtureMonitor = { width: 1920, height: 1080, availLeft: 0, availTop: 0 }
for (const key of ['width', 'height', 'availLeft', 'availTop'] as const) {
  Object.defineProperty(window.screen, key, { configurable: true, get: () => fixtureMonitor[key] })
}
const missionId = 'mobile-fixture-mission'
const listeners = new Set<(id: string) => void>()
const calls: unknown[][] = []
let inputDelay = 0, activeInputs = 0, maxInputConcurrency = 0
let pointerDelay = 0
const pointerStarts = new Map<string, Promise<void>>()
declare const __MOBILE_FIXTURE_QR__: string
const picture = document.createElement('canvas')
picture.width = 400; picture.height = 800
const paint = picture.getContext('2d')!
paint.fillStyle = '#f5f7fb'; paint.fillRect(0, 0, 400, 800)
paint.fillStyle = '#18243c'; paint.fillRect(0, 0, 400, 32)
paint.fillStyle = '#ffffff'; paint.font = '12px sans-serif'; paint.fillText('09:41', 20, 21); paint.fillText('100%', 344, 21)
paint.fillStyle = '#18243c'; paint.font = 'bold 13px sans-serif'; paint.fillText('SYNKORA DEMO', 28, 79)
paint.font = 'bold 29px sans-serif'; paint.fillText('Olá, visitante.', 28, 131)
paint.fillStyle = '#68748a'; paint.font = '15px sans-serif'; paint.fillText('Uma tela sintética para testar o painel.', 28, 165)
paint.fillStyle = '#dce7f8'; paint.beginPath(); paint.roundRect(24, 198, 352, 190, 18); paint.fill()
paint.fillStyle = '#224e90'; paint.font = 'bold 22px sans-serif'; paint.fillText('Pronto para explorar', 46, 246)
paint.fillStyle = '#496a9b'; paint.font = '14px sans-serif'; paint.fillText('Toque e arraste nesta tela.', 46, 275)
paint.fillStyle = '#265da4'; paint.beginPath(); paint.roundRect(46, 312, 130, 46, 10); paint.fill()
paint.fillStyle = '#ffffff'; paint.font = 'bold 14px sans-serif'; paint.fillText('Começar', 74, 341)
for (const [index, title] of ['Seu espaço', 'Atividade recente', 'Preferências'].entries()) {
  const top = 412 + index * 88
  paint.fillStyle = '#ffffff'; paint.beginPath(); paint.roundRect(24, top, 352, 72, 13); paint.fill()
  paint.fillStyle = '#dce7f8'; paint.beginPath(); paint.roundRect(40, top + 16, 40, 40, 9); paint.fill()
  paint.fillStyle = '#18243c'; paint.font = 'bold 15px sans-serif'; paint.fillText(title, 98, top + 34)
  paint.fillStyle = '#8993a4'; paint.font = '12px sans-serif'; paint.fillText('Conteúdo de demonstração', 98, top + 53)
}
paint.fillStyle = '#ffffff'; paint.fillRect(0, 718, 400, 82)
paint.fillStyle = '#265da4'; paint.font = 'bold 12px sans-serif'; paint.fillText('Início', 51, 752)
paint.fillStyle = '#8993a4'; paint.fillText('Explorar', 174, 752); paint.fillText('Conta', 307, 752)
paint.fillStyle = '#18243c'; paint.beginPath(); paint.roundRect(152, 780, 96, 4, 3); paint.fill()
const data = picture.toDataURL('image/png').split(',')[1]
const horizontal = document.createElement('canvas')
horizontal.width = 800; horizontal.height = 400
const landscapePaint = horizontal.getContext('2d')!
landscapePaint.fillStyle = '#f5f7fb'; landscapePaint.fillRect(0, 0, 800, 400)
landscapePaint.fillStyle = '#18243c'; landscapePaint.fillRect(0, 0, 800, 32)
landscapePaint.fillStyle = '#ffffff'; landscapePaint.font = '12px sans-serif'; landscapePaint.fillText('09:41', 25, 21)
landscapePaint.fillStyle = '#18243c'; landscapePaint.font = 'bold 14px sans-serif'; landscapePaint.fillText('SYNKORA DEMO', 38, 82)
landscapePaint.font = 'bold 32px sans-serif'; landscapePaint.fillText('Seu app, em qualquer direção.', 38, 134)
landscapePaint.fillStyle = '#dce7f8'; landscapePaint.beginPath(); landscapePaint.roundRect(38, 172, 724, 170, 20); landscapePaint.fill()
landscapePaint.fillStyle = '#224e90'; landscapePaint.font = 'bold 25px sans-serif'; landscapePaint.fillText('Pronto para explorar', 68, 227)
landscapePaint.font = '17px sans-serif'; landscapePaint.fillText('A tela e os toques acompanham a rotação.', 68, 266)
const landscapeData = horizontal.toDataURL('image/png').split(',')[1]
let landscape = false
const profilePictures = new Map<string, { data: string; width: number; height: number }>()
const profilePicture = (profileId?: string): { data: string; width: number; height: number } => {
  const profile = getMobileDeviceProfile(profileId)
  if (!profile?.width || !profile.height) return { data: landscape ? landscapeData : data, width: landscape ? 800 : 400, height: landscape ? 400 : 800 }
  const key = `${profile.id}:${landscape}`
  const cached = profilePictures.get(key)
  if (cached) return cached
  const output = document.createElement('canvas')
  output.width = landscape ? profile.height : profile.width
  output.height = landscape ? profile.width : profile.height
  const context = output.getContext('2d')!
  context.fillStyle = '#f5f7fb'; context.fillRect(0, 0, output.width, output.height)
  if (landscape) context.drawImage(horizontal, 0, 0, output.width, output.height)
  else {
    const scale = output.width / picture.width
    context.drawImage(picture, 0, 0, 400, 718, 0, 0, output.width, 718 * scale)
    context.drawImage(picture, 0, 718, 400, 82, 0, output.height - 82 * scale, output.width, 82 * scale)
  }
  const result = { data: output.toDataURL('image/png').split(',')[1], width: output.width, height: output.height }
  profilePictures.set(key, result)
  return result
}
let expo: MobileExpoState = { project: { kind: 'expo', sdkVersion: '54.0.0', expoVersion: '~54.0.0', dependenciesInstalled: true, hasDevClient: false,
  message: 'Use Iniciar Expo para disponibilizar o projeto na rede local. No iPhone físico, confirme uma versão de Expo Go compatível com o SDK do projeto. Use a mesma rede Wi-Fi e a mesma conta Expo no CLI e no Expo Go (expo login no terminal da missão). Expo Go aceita apenas os recursos nativos incluídos nele. O QR abre o iPhone físico; não cria simulador nem espelhamento iOS no Windows.' }, status: 'running', addresses: ['192.0.2.10'], selectedAddress: '192.0.2.10',
  port: 8081, lanUrl: 'exp://192.0.2.10:8081', androidUrl: 'exp://127.0.0.1:8081', qrDataUrl: __MOBILE_FIXTURE_QR__ }

let snapshot: MobileState = {
  hostPlatform: 'win32',
  platforms: [
    { platform: 'android', title: 'Android', supported: true, available: true, inputAvailable: true, setupSteps: [], docsUrl: 'https://developer.android.com/studio/run/managing-avds' },
    { platform: 'ios', title: 'iOS', supported: false, available: false, inputAvailable: false, reason: 'iOS disponível somente no macOS com Xcode.', setupSteps: [], docsUrl: 'https://developer.apple.com/documentation/xcode' }
  ],
  devices: [{ id: 'pixel', platform: 'android', name: 'Pixel 8', runtime: 'Android 15', state: 'available' }],
  sessions: [{ id: 'android-fixture', missionId, platform: 'android', deviceId: 'pixel', deviceName: 'Pixel 8', displayProfileId: 'native', state: 'ready', inputAvailable: true }]
}
const change = (next: MobileState): void => { snapshot = next; for (const listener of listeners) listener(missionId) }
const api: MobileApi = {
  acquireView: async (mission, sessionId) => ({ ok: true, value: { consumerId: `render:${mission}:${sessionId}` } }),
  releaseView: async () => ({ ok: true, value: undefined }),
  detach: async () => ({ ok: false, error: 'A prévia usa uma única janela sintética.' }),
  focusDetached: async () => ({ ok: true, value: undefined }),
  dock: async () => ({ ok: true, value: undefined }),
  monitorScale: async () => ({ ok: true, value: { physicalPixelsPerMm: 3.6, source: 'edid-detailed', displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } }),
  expoInspect: async () => ({ ok: true, value: expo }),
  expoStart: async mission => { calls.push(['expoStart', mission]); expo = { ...expo, status: 'running' }; return { ok: true, value: expo } },
  expoStop: async mission => { calls.push(['expoStop', mission]); expo = { ...expo, status: 'idle' }; return { ok: true, value: undefined } },
  expoOpenAndroid: async (mission, sessionId) => { calls.push(['expoOpenAndroid', mission, sessionId]); return { ok: true, value: undefined } },
  expoInstallGo: async (mission, sessionId) => { calls.push(['expoInstallGo', mission, sessionId]); return { ok: true, value: undefined } },
  inspect: async () => ({ ok: true, value: snapshot }),
  start: async (_mission, request) => ({ ok: true, value: { id: 'new-session', missionId, ...request, deviceName: 'Dispositivo de teste', state: 'ready', inputAvailable: true } }),
  stop: async (mission, id) => { calls.push(['stop', mission, id]); change({ ...snapshot, sessions: snapshot.sessions.filter(session => session.id !== id) }); return { ok: true, value: undefined } },
  capture: async (mission, id) => { calls.push(['capture', mission, id]); return { ok: true, value: { sessionId: id, mimeType: 'image/png',
    ...profilePicture(snapshot.sessions.find(session => session.id === id)?.displayProfileId), capturedAt: Date.now() } } },
  act: async (mission, id, action) => {
    calls.push(['act', mission, id, action]); activeInputs++; maxInputConcurrency = Math.max(maxInputConcurrency, activeInputs)
    if (inputDelay) await new Promise(resolve => setTimeout(resolve, inputDelay))
    if (action.type === 'displayProfile') change({ ...snapshot, sessions: snapshot.sessions.map(session => session.id === id ? { ...session, displayProfileId: action.profileId } : session) })
    activeInputs--
    return { ok: true, value: undefined }
  },
  pointer: async (mission, id, event) => {
    calls.push(['pointer', mission, id, event])
    if (event.phase === 'down') {
      const prepared = new Promise<void>(resolve => setTimeout(resolve, pointerDelay))
      pointerStarts.set(event.gestureId, prepared)
      await prepared
    } else if (event.phase === 'up') {
      await pointerStarts.get(event.gestureId)
      pointerStarts.delete(event.gestureId)
    } else if (event.phase === 'cancel') pointerStarts.delete(event.gestureId)
    return { ok: true, value: undefined }
  },
  setVideoVisible: async (mission, id, visible) => { calls.push(['video', mission, id, visible]); return { ok: true, value: undefined } },
  ackVideo: () => {},
  onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
  onVideo: () => () => {}
}
Object.assign(window, { synkora: { mobile: api } })

function Harness(): React.JSX.Element {
  const boardRef = useRef<HTMLDivElement>(null)
  const workspace = useWorkspaceLayout('mobile-fixture', missionId)
  const [covered, setCovered] = useState(false)
  const [visible, setVisible] = useState(true)
  useEffect(() => { workspace.openPanel('mobile') }, [])
  Object.assign(window, { mobileFixture: { workspace, calls, snapshot: () => snapshot, change, setVisible, setLandscape: (value: boolean) => { landscape = value },
    setInputDelay: (value: number) => { inputDelay = value }, inputConcurrency: () => maxInputConcurrency,
    setPointerDelay: (value: number) => { pointerDelay = value },
    enableLiveInput: (value: boolean) => change({ ...snapshot, sessions: snapshot.sessions.map(session => ({ ...session, liveInputAvailable: value })) }) } })
  return <div className="board workspace-board" style={{ height: '100%', padding: 18 }}>
    <div className="board-main stage-mode" ref={boardRef}>
      <div className={`maestro-window stage-window${covered ? ' is-covered' : ''}`} inert={covered || undefined}>
        <header className="stage-head"><span style={{ flex: 1 }}>Missão de desenvolvimento</span>
          <WorkspaceToolbar controller={workspace} available={availableWorkspacePanels('dev', true)} enabled visible title="Simulador mobile" boardRef={boardRef} />
        </header>
        <div style={{ padding: 24, flex: 1, font: '13px/1.8 var(--mono)', color: 'var(--ink-2)' }}>
          <p style={{ color: 'var(--accent-deep)' }}>VOCÊ</p><p>Vamos conferir o app no Android.</p>
          <p style={{ marginTop: 36 }}>O simulador fica ao lado da conversa.</p><p>Esta prévia usa uma tela sintética.</p>
        </div>
        <div style={{ border: '1px solid var(--line-strong)', borderRadius: 8, margin: 18, padding: 16, color: 'var(--ink-2)' }}>Escreva uma mensagem…</div>
      </div>
      <WorkspacePanels controller={workspace} available={availableWorkspacePanels('dev', true)} enabled visible={visible}
        legacyEnabled={false} projectId="mobile-fixture" boardRef={boardRef} onCovered={setCovered}>
        <DockMobile missionId={missionId} projectId="mobile-fixture" visible={visible} />
      </WorkspacePanels>
      <aside className="mission-col"><div className="mission-col-content"><strong>MISSÕES</strong><span>App de demonstração</span></div></aside>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<Harness />)

import { useContext, useEffect, useId, useRef, useState } from 'react'
import type { MobileAction, MobilePlatform } from '../../../shared/mobileSimulator'
import { getMobileDeviceProfile, type MobileDeviceProfileId } from '../../../shared/mobileDeviceProfiles'
import { activeMobileSession, mobilePlatformEnabled, mobileSelectionKey } from '../mobileModel'
import { useMobileSimulator, type MobileSimulatorController } from '../useMobileSimulator'
import { WorkspacePanelVisibility } from '../workspace/WorkspacePanelContext'
import DockSection from './DockSection'
import MobileViewport, { MobileControlIcon } from './MobileViewport'
import MobileExpo from './MobileExpo'
import MobileDevicePicker from './MobileDevicePicker'
import './DockMobile.css'
import './MobilePhone.css'

/** State lives outside the lazily visited WorkspacePanel body. Closing its window
 * hides capture/input; only the owner's Stop action ends the native session. */
export default function DockMobile({ missionId, projectId, visible }: {
  missionId: string; projectId: string; visible: boolean
}): React.JSX.Element {
  const controller = useMobileSimulator(missionId, projectId)
  const sessionCount = controller.state?.sessions.filter(session => session.missionId === missionId && session.state === 'ready').length ?? 0
  return <DockSection id="mobile" title="Mobile" summary={sessionCount ? `${sessionCount} conectado${sessionCount > 1 ? 's' : ''}` : undefined}>
    <MobileBody key={mobileSelectionKey(projectId, missionId)} missionId={missionId} controller={controller} visible={visible} />
  </DockSection>
}

function MobileBody({ missionId, controller, visible: boardVisible }: {
  missionId: string; controller: MobileSimulatorController; visible: boolean
}): React.JSX.Element {
  const panelVisible = useContext(WorkspacePanelVisibility)
  const visible = panelVisible && boardVisible
  const { state, selection, select, loading, error, busy, notice, refresh, run, sendInput } = controller
  const expoView = selection.view === 'expo'
  const platform = selection.platform === 'ios' && state && state.hostPlatform !== 'darwin' ? 'android' : selection.platform
  const capability = state?.platforms.find(item => item.platform === platform)
  const session = activeMobileSession(state, missionId, platform)
  const detached = session?.presentation?.host === 'detached'
  const presentationChanging = session?.presentation?.transitioning === true
  const devices = state?.devices.filter(device => device.platform === platform) ?? []
  const deviceId = session?.deviceId ?? devices.find(device => device.id === selection.devices[platform])?.id ?? devices.find(device => device.state === 'available')?.id ?? devices[0]?.id ?? ''
  const device = devices.find(item => item.id === deviceId)
  const [profileChanging, setProfileChanging] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const preferredProfile = getMobileDeviceProfile(selection.displayProfileId) ?? getMobileDeviceProfile('native')!
  const appliedProfile = session ? getMobileDeviceProfile(session.displayProfileId) : preferredProfile
  const controlsBusy = !!busy || profileChanging
  const canStart = !!capability?.available && mobilePlatformEnabled(state, platform) && device?.state === 'available' && !session && !controlsBusy && visible
  const ready = session?.state === 'ready' && visible && !expoView && !controlsBusy && !modelPickerOpen && !detached && !presentationChanging
  const [focused, setFocused] = useState(false)
  const inputContext = useRef({ sessionId: session?.id, profileId: session?.displayProfileId, enabled: ready })
  if (inputContext.current.sessionId !== session?.id || inputContext.current.profileId !== session?.displayProfileId || inputContext.current.enabled !== ready)
    inputContext.current = { sessionId: session?.id, profileId: session?.displayProfileId, enabled: ready }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const deviceLabel = useId()
  const act = (action: MobileAction): Promise<boolean> => {
    const accepted = inputContext.current
    return session && ready ? sendInput(session.id, action, () => mounted.current && inputContext.current === accepted && accepted.enabled)
      : Promise.resolve(false)
  }
  const choosePlatform = (next: MobilePlatform): void => { if (mobilePlatformEnabled(state, next)) select(value => ({ ...value, platform: next, view: undefined })) }
  const present = (action: 'detach' | 'focusDetached' | 'dock'): void => {
    if (!session || session.state !== 'ready' || presentationChanging) return
    void run(action, api => {
      const method = api[action]
      return typeof method === 'function' ? method(missionId, session.id)
        : Promise.resolve({ ok: false as const, error: 'Reabra o Synkora para carregar as janelas do aparelho.' })
    }, true)
  }
  const chooseProfile = async (profileId: MobileDeviceProfileId): Promise<void> => {
    if (!getMobileDeviceProfile(profileId) || platform !== 'android' || controlsBusy || !visible) return
    if (!session) { select(value => ({ ...value, displayProfileId: profileId })); return }
    if (session.state !== 'ready' || session.displayProfileId === profileId) return
    setProfileChanging(true)
    try {
      const applied = await run('displayProfile', api => api.act(missionId, session.id, { type: 'displayProfile', profileId }))
      if (!mounted.current) return
      await refresh()
      if (applied && mounted.current) select(value => ({ ...value, displayProfileId: profileId }))
    } finally { if (mounted.current) setProfileChanging(false) }
  }
  const message = notice ?? error ?? session?.error
  const showSetup = !!capability && (!capability.available || !capability.inputAvailable)

  return <div className={`dock-mobile${focused && !expoView ? ' is-phone-focused' : ''}`} onKeyDown={event => {
    if (event.key === 'Escape' && focused) { event.stopPropagation(); setFocused(false) }
  }}>
    <div className="mobile-platforms" role="group" aria-label="Como testar o app">
      {(['android', 'ios'] as const).map(item => {
        const enabled = mobilePlatformEnabled(state, item)
        const reason = item === 'ios' && state?.hostPlatform !== 'darwin' ? 'iOS disponível somente no macOS com Xcode.'
          : state?.platforms.find(candidate => candidate.platform === item)?.reason
        return <button type="button" key={item} className={!expoView && platform === item ? 'is-selected' : ''}
          aria-label={`Selecionar ${item === 'ios' ? 'iOS' : 'Android'}`} aria-pressed={!expoView && platform === item}
          disabled={!enabled || controlsBusy} title={!enabled ? reason : undefined} onClick={() => choosePlatform(item)}>
          {item === 'ios' ? 'iOS' : 'Android'}{item === 'ios' && !enabled && <span>macOS</span>}
        </button>
      })}
      <button type="button" className={expoView ? 'is-selected' : ''} aria-label="Abrir Expo Go" aria-pressed={expoView}
        title={controller.expo?.project.kind === 'expo' ? 'Expo detectado · abrir no celular' : controller.expo?.project.kind === 'react-native' ? 'React Native detectado' : 'Abrir no celular com Expo Go'}
        disabled={controlsBusy} onClick={() => select(value => ({ ...value, view: 'expo' }))}>Expo Go
        {(controller.expo?.project.kind === 'expo' || controller.expo?.project.kind === 'react-native') && <i className="mobile-project-dot" aria-label={controller.expo.project.kind === 'expo' ? 'Expo detectado' : 'React Native detectado'} />}
      </button>
      <button type="button" className="mobile-icon-button mobile-discover" aria-label="Verificar simuladores novamente"
        title="Verificar dispositivos e ambiente" disabled={loading || !!busy} onClick={() => { void refresh() }}><MobileControlIcon name="refresh" /></button>
    </div>

    {message && <div className="mobile-notice" role="status"><span>{message}</span>
      <button type="button" disabled={loading || !!busy} onClick={() => { void refresh() }}>Verificar novamente</button>
    </div>}
    {expoView && <MobileExpo missionId={missionId} controller={controller} visible={visible}
      openAndroid={() => select(value => ({ ...value, platform: 'android', view: undefined }))} />}
    <div className="mobile-native" hidden={expoView}>
    <div className="mobile-device-row">
      {platform === 'android' ? <MobileDevicePicker devices={devices} deviceId={deviceId} session={session} profile={appliedProfile} requestedProfile={preferredProfile}
        disabled={controlsBusy || (!!session && session.state !== 'ready')} applying={profileChanging} visible={visible && !expoView}
        onOpenChange={setModelPickerOpen}
        onProfile={profileId => { void chooseProfile(profileId) }} onDevice={id => select(value => ({ ...value, devices: { ...value.devices, android: id } }))} />
        : <><label className="mobile-sr-only" htmlFor={deviceLabel}>Dispositivo virtual</label>
      <select id={deviceLabel} value={deviceId} disabled={!devices.length || !!session || controlsBusy} onChange={event => {
        const id = event.target.value
        select(value => ({ ...value, devices: { ...value.devices, [platform]: id } }))
      }}>
        {!devices.length && <option value="">{loading ? 'Buscando dispositivos…' : 'Nenhum dispositivo disponível'}</option>}
        {session && !devices.some(item => item.id === session.deviceId) && <option value={session.deviceId}>{session.deviceName}</option>}
        {devices.map(item => <option key={item.id} value={item.id} disabled={item.state === 'unavailable' || (item.state === 'running' && !item.sessionId)}>
          {item.name}{item.runtime ? ` · ${item.runtime}` : ''}{item.state === 'running' && !item.sessionId ? ' · em uso fora do Synkora' : ''}
        </option>)}
      </select></>}
      {session ? <button type="button" className="mobile-button mobile-stop" disabled={(!!busy && !(busy === 'start' && session.state === 'starting')) || !visible || session.state === 'stopping'}
        onClick={() => { void run('stop', api => api.stop(missionId, session.id), true) }}>
        {session.state === 'stopping' || busy === 'stop' ? 'Parando…' : 'Parar'}
      </button> : <button type="button" className="mobile-button mobile-start" disabled={!canStart}
        onClick={() => { if (deviceId) void run('start', api => api.start(missionId, { platform, deviceId, ...(platform === 'android' ? { displayProfileId: preferredProfile.id } : {}) }), true) }}>
        {busy === 'start' ? 'Iniciando…' : 'Iniciar'}
      </button>}
      {session?.state === 'ready' && !detached && !presentationChanging && <button type="button" className="mobile-button mobile-detach-button"
        aria-label="Destacar aparelho em janela" title="Abrir aparelho em uma janela independente" disabled={controlsBusy || !visible}
        onClick={() => present('detach')}>↗</button>}
    </div>

    {showSetup && <div className="mobile-setup">
      <strong>{capability.available ? 'Visualização disponível' : `Prepare o ${platform === 'android' ? 'Android' : 'iOS'}`}</strong>
      {capability.reason && <p>{capability.reason}</p>}
      {capability.setupSteps.length > 0 && <ol>{capability.setupSteps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      <button type="button" className="mobile-button" disabled={loading || !!busy} onClick={() => { void refresh() }}>Verificar novamente</button>
    </div>}
    {state && capability?.available && !devices.length && <div className="mobile-setup" role="status">
      <strong>Crie um dispositivo virtual</strong>
      <p>{platform === 'android' ? 'Abra o Device Manager no Android Studio e crie um dispositivo com uma imagem de sistema.'
        : 'Abra o Xcode, instale um runtime em Settings › Components e crie um dispositivo no Simulator.'}</p>
      <button type="button" className="mobile-button" disabled={loading} onClick={() => { void refresh() }}>Verificar novamente</button>
    </div>}

    {detached || presentationChanging ? <div className="mobile-detached-status" role="status">
      <strong>{presentationChanging ? 'Movendo a visualização…' : `${session?.deviceName ?? 'Aparelho'} está em outra janela`}</strong>
      <span>{presentationChanging ? 'Aguarde a troca de janela terminar.' : 'Você pode usar o outro sistema aqui ou trazer este aparelho de volta.'}</span>
      {!presentationChanging && <div className="mobile-detached-status-actions">
        <button type="button" className="mobile-button" disabled={controlsBusy || !visible} onClick={() => present('focusDetached')}>Mostrar janela</button>
        <button type="button" className="mobile-button" disabled={controlsBusy || !visible} onClick={() => present('dock')}>Trazer ao painel</button>
      </div>}
    </div> : <MobileViewport missionId={missionId} session={session} device={device} profileId={preferredProfile.id} visible={visible && !expoView} busy={controlsBusy || modelPickerOpen} act={act}
      expanded={focused} onToggleExpanded={() => setFocused(value => !value)} />}
    </div>
  </div>
}

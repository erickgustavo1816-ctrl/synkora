import { useId, useState } from 'react'
import { activeMobileSession } from '../mobileModel'
import type { MobileSimulatorController } from '../useMobileSimulator'
import { MobileControlIcon } from './MobileViewport'
import './MobileExpo.css'

function qrSource(source: string | undefined): string | null {
  return source && source.length <= 2_000_000 && source.startsWith('data:image/png;base64,iVBORw0KGgo') ? source : null
}

export default function MobileExpo({ missionId, controller, visible, openAndroid }: {
  missionId: string; controller: MobileSimulatorController; visible: boolean; openAndroid: () => void
}): React.JSX.Element {
  const { expo, expoError, state, busy, run, refresh } = controller
  const [address, setAddress] = useState('')
  const addressId = useId()
  const project = expo?.project
  const running = expo?.status === 'running'
  const starting = expo?.status === 'starting' || busy === 'expoStart'
  const stopping = expo?.status === 'stopping' || busy === 'expoStop'
  const needsReset = expo?.status === 'error'
  const canStart = visible && !busy && project?.kind === 'expo' && project.dependenciesInstalled && !running && !starting && !stopping && !needsReset
  const android = activeMobileSession(state, missionId, 'android')
  const readyAndroid = android?.state === 'ready'
  const selectedAddress = expo?.addresses.includes(address) ? address : expo?.selectedAddress ?? expo?.addresses[0] ?? ''
  const error = expoError ?? expo?.error
  const sdk = Number((project?.sdkVersion ?? project?.expoVersion ?? '').match(/\d+/)?.[0]) || null
  const unsupportedIphone = sdk !== null && sdk < 54
  const qr = running && !unsupportedIphone ? qrSource(expo?.qrDataUrl) : null
  const iphoneCompatible = sdk !== null && sdk >= 54
  const intro = !project ? 'Reconhecendo o projeto desta missão…' : project.kind === 'expo'
    ? project.dependenciesInstalled ? 'Projeto Expo reconhecido nesta missão.' : 'Instale as dependências no terminal da missão e verifique novamente para iniciar o Expo Go.'
    : project.kind === 'react-native' ? 'React Native reconhecido. Use um APK local com sua build própria no Android ou configure Expo no projeto.'
      : 'Abra uma missão com um projeto Expo ou React Native para testar no celular.'
  const iphoneHelp = sdk === 54 ? 'Para este projeto, use o Expo Go da App Store.'
    : sdk !== null && sdk >= 55 ? `Este projeto usa Expo SDK ${sdk}. No iPhone, prepare uma versão compatível do Expo Go via eas go e TestFlight; isso exige uma conta Apple Developer.`
      : sdk !== null ? `Expo SDK ${sdk} não funciona com o Expo Go disponível para iPhone. Atualize o projeto ou use uma build de desenvolvimento própria.`
        : 'Confira a versão do projeto: o Expo Go da App Store suporta SDK 54. Outras versões precisam de preparação específica no iPhone.'

  if (!project || project.kind !== 'expo') return <div className="mobile-expo">
    <div className="mobile-expo-intro">
      <span className="mobile-expo-eyebrow">SEU PROJETO</span>
      <div className="mobile-expo-heading"><h4>{!project ? 'Verificando projeto' : project.kind === 'react-native' ? 'React Native sem Expo' : 'Projeto sem Expo'}</h4></div>
      <p>{project?.message ?? 'Reconhecendo o projeto desta missão…'}</p>
      {error && <p className="mobile-expo-error" role="status">{error}</p>}
      <button type="button" className="mobile-button" disabled={!visible || !!busy} onClick={() => { void refresh() }}>Verificar projeto</button>
    </div>
  </div>

  return <div className="mobile-expo">
    <div className="mobile-expo-intro">
      <span className="mobile-expo-eyebrow">SEU PROJETO</span>
      <div className="mobile-expo-heading"><h4>{project?.kind === 'expo' ? 'Expo Go' : project?.kind === 'react-native' ? 'React Native' : 'Abra no seu celular'}</h4>
        {project?.kind === 'expo' && <span className="mobile-expo-detected">Expo detectado</span>}
      </div>
      <p>{intro}</p>
      {project?.hasDevClient && <p className="mobile-expo-note">Este projeto usa um cliente de desenvolvimento. Os módulos nativos podem precisar de uma build própria.</p>}
      {expo && expo.addresses.length > 1 && <label className="mobile-expo-address" htmlFor={addressId}>Rede do computador
        <select id={addressId} value={selectedAddress} disabled={running || starting || stopping || !!busy}
          onChange={event => setAddress(event.target.value)}>{expo.addresses.map(item => <option key={item} value={item}>{item}</option>)}</select>
      </label>}
      <div className="mobile-expo-launch">
        {running || starting || stopping || needsReset ? <button type="button" className="mobile-button" aria-label="Parar Expo Go"
          disabled={!visible || stopping || (!!busy && busy !== 'expoStart')}
          onClick={() => { void run('expoStop', api => api.expoStop(missionId), true) }}>{stopping ? 'Encerrando…' : needsReset ? 'Encerrar e tentar novamente' : 'Parar Expo Go'}</button>
          : <button type="button" className="mobile-button mobile-start" aria-label="Iniciar Expo Go" disabled={!canStart}
            onClick={() => { void run('expoStart', api => api.expoStart(missionId, selectedAddress ? { address: selectedAddress } : undefined), true) }}>Iniciar Expo Go</button>}
        <span className={`mobile-expo-status${running ? ' is-running' : ''}`}>{running ? 'servidor local iniciado' : starting ? 'preparando projeto…' : stopping ? 'encerrando' : needsReset ? 'precisa de atenção' : canStart ? 'pronto para iniciar' : 'preparação necessária'}</span>
      </div>
      {error && <div className="mobile-expo-error" role="status"><p>{error}</p><button type="button" className="mobile-button" disabled={!!busy} onClick={() => { void refresh() }}>Verificar novamente</button></div>}
    </div>

    <section className="mobile-expo-phone-card" aria-label="iPhone físico com Expo Go">
      <div className="mobile-expo-card-title"><span className="mobile-expo-card-icon"><MobileControlIcon name="phone" /></span><div><h5>iPhone físico</h5><p>Conecte pelo Expo Go</p></div></div>
      {!unsupportedIphone && <div className={`mobile-expo-qr${qr ? '' : ' is-waiting'}`}>
        {qr ? <img src={qr} alt="QR para abrir o projeto no Expo Go" draggable={false} />
          : <><span className="mobile-expo-qr-symbol" aria-hidden="true">⌗</span><span>{starting ? 'Preparando seu QR…' : 'O QR aparece ao iniciar o projeto'}</span></>}
      </div>}
      <p className={`mobile-expo-compatibility${iphoneCompatible ? '' : ' needs-setup'}`}>{iphoneHelp}</p>
      {!unsupportedIphone && <ol className="mobile-expo-steps"><li>Entre no Expo Go com a mesma conta Expo usada neste computador.</li><li>Conecte o iPhone e este computador à mesma rede Wi-Fi.</li><li>Leia o QR com a câmera do iPhone para abrir o projeto.</li></ol>}
      <p className="mobile-expo-physical-note">O app abre no seu iPhone. A tela permanece no celular.</p>
      {running && !unsupportedIphone && expo?.lanUrl && <label className="mobile-expo-link">Endereço do projeto<input aria-label="Endereço do projeto Expo" value={expo.lanUrl} readOnly onFocus={event => event.target.select()} /></label>}
    </section>

    <section className="mobile-expo-android-card" aria-label="Android com Expo Go">
      <div className="mobile-expo-card-title"><span className="mobile-expo-card-icon"><MobileControlIcon name="phone" /></span><div><h5>Android no painel</h5><p>{readyAndroid ? android.deviceName : 'Use um dispositivo virtual'}</p></div></div>
      {readyAndroid ? <button type="button" className="mobile-button mobile-start" aria-label="Abrir Expo Go no Android" disabled={!running || !!busy || !visible}
        onClick={() => { void run('expoOpen', api => api.expoOpenAndroid(missionId, android.id), true).then(ok => { if (ok) openAndroid() }) }}>{busy === 'expoOpen' ? 'Verificando e abrindo…' : 'Abrir no Android'}</button>
        : <button type="button" className="mobile-button" disabled={!!busy || !visible} onClick={openAndroid}>Escolher Android</button>}
      <details className="mobile-expo-install"><summary>Primeiro acesso neste Android?</summary><p>Instale o Expo Go no dispositivo virtual para abrir seu projeto.</p>
        <button type="button" className="mobile-button" aria-label="Instalar Expo Go no Android" disabled={!running || !readyAndroid || !!busy || !visible}
          onClick={() => { if (android) void run('expoInstall', api => api.expoInstallGo(missionId, android.id), true) }}>{busy === 'expoInstall' ? 'Instalando…' : 'Instalar Expo Go'}</button>
      </details>
    </section>
  </div>
}

import { useId, useState, type FormEvent } from 'react'
import type { MobileAction, MobilePlatform } from '../../../shared/mobileSimulator'

export default function MobileTools({ platform, disabled, act }: {
  platform: MobilePlatform; disabled: boolean; act: (action: MobileAction) => Promise<boolean>
}): React.JSX.Element {
  const id = useId()
  const [path, setPath] = useState('')
  const [appId, setAppId] = useState('')
  const [url, setUrl] = useState('')
  const [port, setPort] = useState('3000')
  const submit = (event: FormEvent, action: MobileAction): void => { event.preventDefault(); if (!disabled) void act(action) }
  return <details className="mobile-tools">
    <summary>App e conexão</summary>
    <div className="mobile-tools-body">
      <form onSubmit={event => submit(event, { type: 'install', relativePath: path.trim() })}>
        <label htmlFor={`${id}-build`}>Build local · {platform === 'android' ? '.apk' : '.app'}</label>
        <div className="mobile-input-row"><input id={`${id}-build`} value={path} onChange={event => setPath(event.target.value)}
          placeholder={platform === 'android' ? 'build/app-debug.apk' : 'build/MeuApp.app'} disabled={disabled} spellCheck={false} />
          <button className="mobile-button" disabled={disabled || !path.trim()}>Instalar</button></div>
        <span className="mobile-field-note">Caminho relativo à pasta desta missão.</span>
      </form>
      <form onSubmit={event => submit(event, { type: 'launch', appId: appId.trim() })}>
        <label htmlFor={`${id}-app`}>Identificador do app</label>
        <div className="mobile-input-row"><input id={`${id}-app`} value={appId} onChange={event => setAppId(event.target.value)}
          placeholder="com.exemplo.app" disabled={disabled} spellCheck={false} />
          <button className="mobile-button" disabled={disabled || !appId.trim()}>Abrir</button></div>
      </form>
      <form onSubmit={event => submit(event, { type: 'openUrl', url: url.trim() })}>
        <label htmlFor={`${id}-url`}>URL ou link do app</label>
        <div className="mobile-input-row"><input id={`${id}-url`} value={url} onChange={event => setUrl(event.target.value)}
          placeholder="http://localhost:3000" disabled={disabled} spellCheck={false} />
          <button className="mobile-button" disabled={disabled || !url.trim()}>Abrir</button></div>
      </form>
      {platform === 'android' && <form onSubmit={event => submit(event, { type: 'reverse', port: Number(port) })}>
        <label htmlFor={`${id}-port`}>Porta local no Android</label>
        <div className="mobile-input-row"><input id={`${id}-port`} value={port} onChange={event => setPort(event.target.value)}
          type="number" min="1" max="65535" step="1" disabled={disabled} />
          <button className="mobile-button" disabled={disabled || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535}>Conectar</button></div>
        <span className="mobile-field-note">Permite acessar o servidor desta porta por localhost.</span>
      </form>}
    </div>
  </details>
}

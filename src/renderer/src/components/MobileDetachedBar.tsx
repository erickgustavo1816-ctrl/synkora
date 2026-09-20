import type { RefObject } from 'react'
import MobileScaleMenu, { type MobileScaleState } from './MobileScaleMenu'
import './MobileDetachedBar.css'

function BarIcon({ name }: { name: 'home' | 'refresh' }): React.JSX.Element {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'home' ? <><path d="M2.5 7.5 8 2.8l5.5 4.7V13a.7.7 0 0 1-.7.7H3.2a.7.7 0 0 1-.7-.7z" /><path d="M6.4 13.7V9.4h3.2v4.3" /></>
      : <><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5V5h-2.5" /></>}
  </svg>
}

/** The single strip of a detached phone window: title (drag handle), home,
 * refresh, the shared scale menu and one close button. */
export default function MobileDetachedBar({ barRef, title, status, connected, homeDisabled, refreshDisabled, onHome, onRefresh, scale, onClose, closing }: {
  barRef: RefObject<HTMLDivElement | null>
  title: string; status: string; connected: boolean
  homeDisabled: boolean; refreshDisabled: boolean
  onHome: () => void; onRefresh: () => void
  scale: MobileScaleState
  onClose?: () => void; closing?: boolean
}): React.JSX.Element {
  return <div ref={barRef} className="mobile-detached-bar mobile-phone-window-bar" data-testid="mobile-phone-drag-bar" role="group" aria-label="Janela do aparelho">
    <div className="mobile-detached-title" title={title}>
      <i className={`mobile-detached-dot${connected ? ' is-connected' : ''}`} aria-hidden="true" />
      <span>{title}</span>
      <span className="mobile-sr-only">{status}</span>
    </div>
    <button type="button" aria-label="Início do dispositivo" title="Início" disabled={homeDisabled} onClick={onHome}><BarIcon name="home" /></button>
    <button type="button" aria-label="Atualizar tela do dispositivo" title="Atualizar tela" disabled={refreshDisabled} onClick={onRefresh}><BarIcon name="refresh" /></button>
    <i className="mobile-detached-sep" aria-hidden="true" />
    <MobileScaleMenu scale={scale} fitLabel="Ajustar à janela" />
    {onClose && <><i className="mobile-detached-sep" aria-hidden="true" />
      <button type="button" className="mobile-detached-close" aria-label="Fechar janela do aparelho" title="Fechar janela e voltar ao painel"
        disabled={closing} onClick={onClose}>×</button></>}
  </div>
}

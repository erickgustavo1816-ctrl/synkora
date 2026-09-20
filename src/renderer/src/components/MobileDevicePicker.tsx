import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MobileDevice, MobileSession } from '../../../shared/mobileSimulator'
import { MOBILE_DEVICE_PROFILES, type MobileDeviceProfile, type MobileDeviceProfileId } from '../../../shared/mobileDeviceProfiles'
import './MobileDevicePicker.css'

export default function MobileDevicePicker({ devices, deviceId, session, profile, requestedProfile, disabled, visible, applying, onDevice, onProfile, onOpenChange }: {
  devices: MobileDevice[]; deviceId: string; session: MobileSession | null; profile: MobileDeviceProfile | undefined
  disabled: boolean; visible: boolean; applying: boolean
  requestedProfile?: MobileDeviceProfile
  onDevice: (id: string) => void; onProfile: (id: MobileDeviceProfileId) => void
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId(), deviceLabel = useId()
  const deviceName = session?.deviceName ?? devices.find(item => item.id === deviceId)?.name
  const starting = session?.state === 'starting'
  const preview = starting ? requestedProfile ?? profile : profile
  const name = preview && preview.id !== 'native' ? preview.name : deviceName ?? 'Escolher aparelho'
  const description = starting ? 'Preparando…' : applying ? 'Aplicando…' : profile?.width ? `${profile.width} × ${profile.height}`
    : session && !profile ? 'perfil não confirmado' : 'tela original'
  const close = (focus = true): void => { setMenu(null); if (focus) trigger.current?.focus() }

  useEffect(() => { onOpenChange(!!menu); return () => onOpenChange(false) }, [!!menu, onOpenChange])
  useEffect(() => { if (!visible || disabled) setMenu(null) }, [visible, disabled])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent): void => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false)
    }
    const resized = (): void => close(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', resized)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', resized) }
  }, [menu])
  useLayoutEffect(() => {
    if (menu) (panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLButtonElement>('[data-profile-option]'))?.focus()
  }, [menu])

  return <>
    <button type="button" ref={trigger} className="mobile-model-trigger" aria-label="Escolher modelo de tela" aria-haspopup="dialog"
      aria-expanded={!!menu} aria-controls={menu ? id : undefined} aria-busy={applying || starting} disabled={disabled || !visible}
      data-applied-profile={session?.displayProfileId} title={`${name} · ${description}${preview?.brand === 'Samsung' ? ' · Android padrão, sem One UI' : ''}`}
      onClick={() => {
        if (menu) { close(); return }
        const rect = trigger.current?.getBoundingClientRect()
        if (!rect) return
        const width = Math.min(348, window.innerWidth - 24)
        const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 470))
        setMenu({ top, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width, maxHeight: window.innerHeight - top - 12 })
      }}>
      <span className={`mobile-model-mini frame-${preview?.frame ?? 'pixel'}`} data-profile-id={preview?.id} aria-hidden="true"><i /></span>
      <span className="mobile-model-name">{name}</span><span className="mobile-model-size">{description}</span><span className="mobile-model-chevron" aria-hidden="true">⌄</span>
    </button>
    {menu && visible && !disabled && createPortal(<div className="mobile-model-menu" id={id} ref={panel} role="dialog" aria-label="Modelos de tela" style={menu}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(false) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
        if ((event.target as HTMLElement).tagName === 'SELECT' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-profile-option]'))
        const current = options.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        options[next]?.focus()
      }}>
      <div className="mobile-model-menu-heading"><strong>Modelo de tela</strong><span>{session ? 'Aplicar ao aparelho conectado' : 'Usar ao iniciar'}</span></div>
      {!session && <label className="mobile-model-device" htmlFor={deviceLabel}>Dispositivo virtual
        <select id={deviceLabel} value={deviceId} disabled={!devices.length} onChange={event => onDevice(event.target.value)}>
          {!devices.length && <option value="">Nenhum dispositivo disponível</option>}
          {devices.map(device => <option key={device.id} value={device.id} disabled={device.state !== 'available'}>{device.name}{device.runtime ? ` · ${device.runtime}` : ''}</option>)}
        </select>
      </label>}
      <div role="menu" aria-label="Perfis de tela">
        {(['Android', 'Google', 'Samsung'] as const).map(brand => <div role="group" aria-label={brand} key={brand}>
          <p className="mobile-model-brand">{brand === 'Android' ? 'DO DISPOSITIVO' : brand.toUpperCase()}</p>
          {MOBILE_DEVICE_PROFILES.filter(item => item.brand === brand).map(item => <button type="button" key={item.id} role="menuitemradio"
            aria-checked={profile?.id === item.id} aria-label={`Usar ${item.name}`} data-profile-option={item.id}
            onClick={() => { close(); onProfile(item.id) }}>
            <span className={`mobile-model-mini frame-${item.frame}`} data-profile-id={item.id} aria-hidden="true"><i /></span>
            <span><strong>{item.name}</strong><small>{item.width ? `${item.width} × ${item.height} · ${item.density} dpi de teste` : 'Restaurar resolução e densidade originais'}</small></span>
            {profile?.id === item.id && <span className="mobile-model-selected" aria-hidden="true">✓</span>}
          </button>)}
        </div>)}
      </div>
      <p className="mobile-model-note">Os perfis Galaxy usam Android padrão, sem One UI.</p>
    </div>, document.body)}
  </>
}

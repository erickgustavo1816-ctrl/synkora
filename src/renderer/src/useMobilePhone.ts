import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileAction, MobilePhoneApi, MobilePhoneDescriptor } from '../../shared/mobileSimulator'
import { createMobilePhoneClient } from './mobileClient'
import { createMobilePhoneActionQueue, createMobilePhoneSizer, validMobilePhoneDescriptor } from './mobilePhoneController'

export function useMobilePhone(windowId: string) {
  const api = useMemo(() => (window as Window & { synkoraMobilePhone?: MobilePhoneApi }).synkoraMobilePhone ?? null, [])
  const [descriptor, setDescriptor] = useState<MobilePhoneDescriptor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [docking, setDocking] = useState(false)
  const dockingPending = useRef(false)
  const [clamped, setClamped] = useState(false)
  const active = useRef(true), request = useRef(0)
  const client = useMemo(() => api && descriptor ? createMobilePhoneClient(api, descriptor) : null,
    [api, descriptor?.windowId, descriptor?.missionId, descriptor?.sessionId])
  const enabled = !!descriptor && descriptor.session.state === 'ready' && !descriptor.session.presentation?.transitioning && !docking
  const current = useRef(enabled); current.current = enabled
  const queue = useRef<ReturnType<typeof createMobilePhoneActionQueue> | null>(null)
  useEffect(() => {
    active.current = true
    let disposed = false
    const refresh = async (): Promise<void> => {
      const ticket = ++request.current
      if (!api || !windowId) { setError('Abra o aparelho pelo painel Mobile para usar esta janela.'); return }
      try {
        const result = await api.describe()
        if (disposed || ticket !== request.current) return
        if (!result.ok || !validMobilePhoneDescriptor(result.value, windowId)) {
          setDescriptor(null); setError(result.ok ? 'A identidade desta janela não corresponde ao aparelho.' : result.error); return
        }
        setDescriptor(result.value); setError(null)
      } catch { if (!disposed && ticket === request.current) { setDescriptor(null); setError('Não foi possível consultar o aparelho. Volte ao painel Mobile.') } }
    }
    const unsubscribe = api?.onChanged(() => { void refresh() })
    void refresh()
    return () => { disposed = true; active.current = false; request.current++; unsubscribe?.() }
  }, [api, windowId])
  useEffect(() => {
    if (!client || !descriptor) return
    const actions = createMobilePhoneActionQueue(client, descriptor, () => current.current && document.visibilityState !== 'hidden', setError)
    queue.current = actions
    return () => { actions.dispose(); if (queue.current === actions) queue.current = null }
  }, [client, descriptor?.sessionId])
  const act = useCallback((action: MobileAction): Promise<boolean> => queue.current?.send(action) ?? Promise.resolve(false), [])
  const sizer = useMemo(() => api ? createMobilePhoneSizer(size => api.resize(size), setClamped) : null, [api])
  useEffect(() => () => sizer?.dispose(), [sizer])
  const contentSize = useCallback((size: { width: number; height: number }): void => {
    // The window adds only its 6px padding on each side; the strip lives
    // inside the viewport group and is already part of the reported size.
    sizer?.request({ width: size.width + 12, height: size.height + 12 })
  }, [sizer])
  const dock = useCallback(async (): Promise<void> => {
    if (!api || dockingPending.current) return
    dockingPending.current = true
    current.current = false
    setDocking(true)
    try {
      const result = await api.dock()
      if (active.current && !result.ok) { dockingPending.current = false; setDocking(false); setError(result.error) }
    } catch { if (active.current) { dockingPending.current = false; setDocking(false); setError('Não foi possível voltar ao painel. Tente novamente.') } }
  }, [api])
  return { descriptor, client, error, docking, clamped, enabled, act, contentSize, dock }
}

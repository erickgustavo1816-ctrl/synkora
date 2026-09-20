import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileAction, MobileApi, MobileResult, MobileState } from '../../shared/mobileSimulator'
import type { MobileExpoState } from '../../shared/mobileExpo'
import { MOBILE_NO_API, mobileSelectionKey, readMobileSelection, type MobileSelection } from './mobileModel'
import { currentMobileConsumer } from './mobileClient'

export function mobileApi(): MobileApi | null {
  const api = (window.synkora as { mobile?: MobileApi } | undefined)?.mobile
  return api && (['inspect', 'start', 'stop', 'capture', 'act', 'onChanged'] as const)
    .every(method => typeof api[method] === 'function') ? api : null
}

function readSelection(key: string): MobileSelection {
  try { return readMobileSelection(window.localStorage, key) }
  catch { return readMobileSelection(null, key) }
}

export function useMobileSimulator(missionId: string, projectId: string) {
  const key = mobileSelectionKey(projectId, missionId)
  const [saved, setSaved] = useState(() => ({ key, value: readSelection(key) }))
  if (saved.key !== key) setSaved({ key, value: readSelection(key) })
  const [snapshot, setSnapshot] = useState<{ key: string; state: MobileState | null; error: string | null; loading: boolean }>({ key, state: null, error: null, loading: true })
  const [operation, setOperation] = useState<{ key: string; busy: string | null; notice: string | null }>({ key, busy: null, notice: null })
  const [expo, setExpo] = useState<{ key: string; state: MobileExpoState | null; error: string | null }>({ key, state: null, error: null })
  const scope = useRef(key)
  const epoch = useRef(0)
  if (scope.current !== key) { scope.current = key; epoch.current++ }
  const request = useRef(0)
  const active = useRef(true)
  const pending = useRef<{ key: string; token: object; label: string } | null>(null)
  const inputVersion = useRef(0)
  const inputQueues = useRef(new Map<string, { tail: Promise<void>; count: number }>())

  const refresh = useCallback(async (): Promise<void> => {
    const ticket = ++request.current
    const api = mobileApi()
    if (!api) { setSnapshot({ key, state: null, error: MOBILE_NO_API, loading: false }); return }
    if (typeof api.expoInspect === 'function') {
      void api.expoInspect(missionId).then(result => {
        if (!active.current || scope.current !== key || ticket !== request.current) return
        setExpo(old => result.ok ? { key, state: result.value, error: null }
          : { key, state: old.key === key ? old.state : null, error: result.error })
      }).catch(() => {
        if (active.current && scope.current === key && ticket === request.current)
          setExpo({ key, state: null, error: 'Não foi possível reconhecer o projeto. Verifique novamente.' })
      })
    } else setExpo({ key, state: null, error: 'reinicie o app para usar o Expo Go nesta missão' })
    setSnapshot(old => ({ key, state: old.key === key ? old.state : null, error: null, loading: true }))
    try {
      const result = await api.inspect(missionId)
      if (!active.current || scope.current !== key || ticket !== request.current) return
      setSnapshot(old => result.ok ? { key, state: result.value, error: null, loading: false }
        : { key, state: old.key === key ? old.state : null, error: result.error, loading: false })
    } catch {
      if (active.current && scope.current === key && ticket === request.current)
        setSnapshot(old => ({ key, state: old.key === key ? old.state : null, error: 'Não foi possível consultar os simuladores. Verifique novamente.', loading: false }))
    }
  }, [key, missionId])

  useEffect(() => {
    active.current = true
    void refresh()
    const unsubscribe = mobileApi()?.onChanged?.(id => { if (id === missionId) void refresh() })
    const visibilityChanged = (): void => { if (document.visibilityState === 'hidden') inputVersion.current++ }
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => { active.current = false; request.current++; unsubscribe?.(); document.removeEventListener('visibilitychange', visibilityChanged) }
  }, [missionId, refresh])

  useEffect(() => {
    if (saved.key !== key) return
    try { window.localStorage.setItem(key, JSON.stringify(saved.value)) } catch { /* preference remains in memory */ }
  }, [key, saved])

  const select = useCallback((change: (value: MobileSelection) => MobileSelection): void => {
    setSaved(current => current.key === key ? { key, value: change(current.value) } : current)
  }, [key])

  const run = useCallback(async (label: string, action: (api: MobileApi) => Promise<MobileResult<unknown>>, reload = false): Promise<boolean> => {
    const cancellingStart = (label === 'stop' && pending.current?.label === 'start') || (label === 'expoStop' && pending.current?.label === 'expoStart')
    if (pending.current?.key === key && !cancellingStart) return false
    const api = mobileApi()
    if (!api) { setOperation({ key, busy: null, notice: MOBILE_NO_API }); return false }
    const token = {}
    inputVersion.current++
    const startedIn = epoch.current
    pending.current = { key, token, label }
    setOperation({ key, busy: label, notice: null })
    try {
      const result = await action(api)
      if (!active.current || scope.current !== key || epoch.current !== startedIn || pending.current?.token !== token) return false
      setOperation({ key, busy: null, notice: result.ok ? null : result.error })
      if (reload) void refresh()
      return result.ok
    } catch (cause) {
      if (active.current && scope.current === key && epoch.current === startedIn && pending.current?.token === token) setOperation({ key, busy: null,
        notice: cause instanceof TypeError ? MOBILE_NO_API : 'O simulador não respondeu. Verifique a conexão e tente novamente.' })
      return false
    } finally { if (pending.current?.token === token) pending.current = null }
  }, [key, refresh])

  const sendInput = useCallback((sessionId: string, action: MobileAction, isCurrent: () => boolean): Promise<boolean> => {
    if (!active.current || scope.current !== key || document.visibilityState === 'hidden' || pending.current?.key === key || !isCurrent()) return Promise.resolve(false)
    const client = mobileApi(), consumerId = currentMobileConsumer(client, missionId, sessionId)
    if (!client || !consumerId) return Promise.resolve(false)
    const queueKey = `${key}:${sessionId}`
    let queue = inputQueues.current.get(queueKey)
    if (!queue) { queue = { tail: Promise.resolve(), count: 0 }; inputQueues.current.set(queueKey, queue) }
    if (queue.count >= 4) {
      setOperation(old => ({ ...old, key, notice: 'O dispositivo está respondendo devagar. Aguarde um instante.' }))
      return Promise.resolve(false)
    }
    queue.count++
    const accepted = queue
    const version = inputVersion.current, startedIn = epoch.current, queuedAt = Date.now()
    const valid = (): boolean => active.current && scope.current === key && epoch.current === startedIn &&
      inputVersion.current === version && document.visibilityState !== 'hidden' && pending.current?.key !== key && isCurrent() &&
      currentMobileConsumer(client, missionId, sessionId) === consumerId
    const work = accepted.tail.then(async (): Promise<boolean> => {
      if (!valid()) return false
      if (Date.now() - queuedAt > 1800) {
        setOperation(old => ({ ...old, key, notice: 'O dispositivo está respondendo devagar. Tente o toque novamente.' }))
        return false
      }
      try {
        const result = await client.act(missionId, sessionId, action, consumerId)
        if (!valid()) return false
        setOperation(old => old.key === key && old.notice === (result.ok ? null : result.error) ? old
          : { ...old, key, notice: result.ok ? null : result.error })
        return result.ok
      } catch {
        if (valid()) setOperation(old => ({ ...old, key, notice: 'O dispositivo não respondeu ao comando. Tente novamente.' }))
        return false
      }
    })
    accepted.tail = work.then(() => {})
    return work.finally(() => {
      accepted.count--
      if (!accepted.count && inputQueues.current.get(queueKey) === accepted) inputQueues.current.delete(queueKey)
    })
  }, [key, missionId])

  return {
    selection: saved.key === key ? saved.value : readSelection(key), select,
    state: snapshot.key === key ? snapshot.state : null,
    expo: expo.key === key ? expo.state : null,
    expoError: expo.key === key ? expo.error : null,
    loading: snapshot.key !== key || snapshot.loading,
    error: snapshot.key === key ? snapshot.error : null,
    busy: operation.key === key ? operation.busy : null,
    notice: operation.key === key ? operation.notice : null,
    refresh, run, sendInput
  }
}

export type MobileSimulatorController = ReturnType<typeof useMobileSimulator>

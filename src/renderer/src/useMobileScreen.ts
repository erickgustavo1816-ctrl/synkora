import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { MobileFrame, MobileResult, MobileSession } from '../../shared/mobileSimulator'
import { startMobileCapture } from './mobileCapture'
import { mobileFrameSource } from './mobileModel'
import { ownerMobileClient, type MobileClient } from './mobileClient'
import { useMobileView } from './useMobileView'
import { createMobileVideoRenderer } from './mobileVideo'

export function useMobileScreen(missionId: string, session: MobileSession | null, visible: boolean, canvas: RefObject<HTMLCanvasElement | null>, retry: number, client: MobileClient | null = ownerMobileClient()) {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const changed = (): void => setDocumentVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  const requesting = visible && documentVisible && session?.state === 'ready' && !session.presentation?.transitioning
  const lease = useMobileView(client, missionId, session?.id, requesting, retry)
  const consumerId = lease.consumerId
  const captureKey = JSON.stringify([missionId, session?.id ?? ''])
  const sessionKey = JSON.stringify([missionId, session?.id ?? '', consumerId ?? ''])
  const key = JSON.stringify([sessionKey, session?.displayProfileId ?? ''])
  const [picture, setPicture] = useState<{ key: string; frame: MobileFrame; source: string } | null>(null)
  const [video, setVideo] = useState<{ key: string; playing: boolean }>({ key, playing: false })
  const [videoSize, setVideoSize] = useState({ key, width: 0, height: 0 })
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null)
  const playing = useRef(false)
  const generation = useRef(0)
  const resizeVideo = useRef<(() => void) | null>(null)
  const resize = useCallback(() => resizeVideo.current?.(), [])
  const visualKey = useRef<string | undefined>(undefined)
  const streamHistory = useRef<{ sessionKey: string; active?: string; retired: Set<string>; lastTimestampUs: number }>({ sessionKey, retired: new Set(), lastTimestampUs: -1 })
  const videoStops = useRef(new Map<string, Promise<boolean>>())
  const inFlight = useRef(new Map<string, Promise<MobileResult<MobileFrame>>>())
  const showing = requesting && !!consumerId

  useEffect(() => {
    const current = ++generation.current
    playing.current = false
    setVideo({ key, playing: false })
    if (visualKey.current !== key) {
      visualKey.current = key
      setVideoSize({ key, width: 0, height: 0 })
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0 }
    }
    if (streamHistory.current.sessionKey !== sessionKey) streamHistory.current = { sessionKey, retired: new Set(), lastTimestampUs: -1 }
    if (!showing || !session || !consumerId) return
    const api = client
    if (!api) return
    let stopped = false
    const valid = (): boolean => !stopped && generation.current === current
    let acceptingVideo = false
    let pendingStop = videoStops.current.get(sessionKey)
    const stopVideo = (): Promise<boolean> => {
      acceptingVideo = false
      const previous = videoStops.current.get(sessionKey)
      let request: Promise<boolean>
      try { request = api.setVideoVisible(missionId, session.id, false, consumerId).then(result => result.ok, () => false) }
      catch { request = Promise.resolve(false) }
      // A profile can change during recovery. Await every earlier stop response
      // as well as this one before opening the replacement stream.
      const pending = previous ? Promise.all([previous, request]).then(results => results.every(Boolean)) : request
      pendingStop = pending
      videoStops.current.set(sessionKey, pending)
      void pending.then(() => { if (videoStops.current.get(sessionKey) === pending) videoStops.current.delete(sessionKey) })
      return pending
    }
    const streams = streamHistory.current
    const retireStream = (): void => {
      if (!streams.active) return
      streams.retired.add(streams.active)
      streams.active = undefined
      // Only recent IPC generations can still be in transit. Keep the history
      // bounded for long sessions and discard it when the session changes.
      if (streams.retired.size > 16) streams.retired.delete(streams.retired.values().next().value!)
    }
    let restarting = false
    let recoveries = 0
    let healthTimer: ReturnType<typeof setTimeout> | undefined
    const recoverVideo = (): void => {
      if (!valid() || restarting || recoveries >= 3) return
      restarting = true
      recoveries++
      retireStream()
      // Re-open only our recorder to obtain an IDR promptly. Do not wait for
      // screenrecord's ten-second key interval after a real decoder failure.
      void stopVideo()
        .then(confirmed => {
          if (!confirmed || !valid()) return
          acceptingVideo = true
          return api.setVideoVisible(missionId, session.id, true, consumerId)
        })
        .catch(() => { /* PNG fallback remains available. */ })
        .finally(() => { restarting = false })
    }
    const measureVideo = ({ width, height }: { width: number; height: number }): void => {
      if (!valid()) return
      setVideoSize(old => old.key === key && old.width === width && old.height === height ? old : { key, width, height })
    }
    setFailure(null)
    const player = session.platform === 'android' && canvas.current && typeof api.onVideo === 'function' && typeof api.setVideoVisible === 'function'
      ? createMobileVideoRenderer(canvas.current, state => {
        if (!valid()) return
        playing.current = state === 'playing'
        setVideo(old => old.key === key && old.playing === playing.current ? old : { key, playing: playing.current })
        if (playing.current) setFailure(null)
      }, {
        onConsumed: packet => api.ackVideo?.(packet.missionId, packet.sessionId, packet.streamId, packet.timestampUs, consumerId),
        onRecovery: recoverVideo,
        onDimensions: measureVideo
      }) : null
    resizeVideo.current = player?.resize ?? null
    const unsubscribe = player ? api.onVideo(packet => {
      if (packet.missionId !== missionId || packet.sessionId !== session.id || packet.consumerId !== consumerId) return
      if (valid() && acceptingVideo && packet.sessionId === session.id && !streams.retired.has(packet.streamId) && Number.isSafeInteger(packet.timestampUs) && packet.timestampUs > streams.lastTimestampUs) {
        streams.lastTimestampUs = packet.timestampUs
        if (streams.active !== packet.streamId) { retireStream(); streams.active = packet.streamId }
        player.push(packet)
      } else api.ackVideo?.(packet.missionId, packet.sessionId, packet.streamId, packet.timestampUs, consumerId)
    }) : null
    const checkVideo = async (): Promise<void> => {
      if (!valid() || !player) return
      try {
        // A static picture is healthy. Check recorder ownership/liveness using
        // the existing idempotent metadata call, without periodic PNG traffic.
        if (!restarting) {
          if (!acceptingVideo) {
            // The stop reply is also the boundary for already-sent packets,
            // including an old first keyframe whose stream ID was never seen.
            const barrier = pendingStop
            const confirmed = !barrier || await barrier
            if (!valid() || restarting || barrier !== pendingStop) return
            if (!confirmed) { player.recover(); return }
            acceptingVideo = true
          }
          const result = await api.setVideoVisible(missionId, session.id, true, consumerId)
          if (valid() && !result.ok) player.recover()
        }
      } catch { if (valid()) player.recover() }
      finally { if (valid()) healthTimer = setTimeout(() => { void checkVideo() }, 2000) }
    }
    if (player) void checkVideo()
    const stopCapture = startMobileCapture({
      capture: async () => {
        // Hiding cannot cancel an IPC invocation. A restored view waits for that
        // request, then asks for its own fresh frame instead of overlapping it.
        const previous = inFlight.current.get(captureKey)
        if (previous) { try { await previous } catch { /* the fresh request can recover */ } }
        if (!valid()) return { ok: false, error: 'A visualização foi encerrada.' }
        const pending = api.capture(missionId, session.id, consumerId)
        inFlight.current.set(captureKey, pending)
        try { return await pending }
        finally { if (inFlight.current.get(captureKey) === pending) inFlight.current.delete(captureKey) }
      },
      isVideoPlaying: () => playing.current,
      onFrame: frame => {
        if (!valid()) return
        const source = mobileFrameSource(frame, session.id)
        if (!source) { setFailure({ key, error: 'O simulador enviou uma imagem inválida. Tente capturar novamente.' }); return }
        setPicture({ key, frame, source }); setFailure(null)
      },
      onError: error => { if (valid()) setFailure({ key, error }) }
    })
    return () => {
      stopped = true
      clearTimeout(healthTimer)
      playing.current = false
      stopCapture()
      unsubscribe?.()
      if (resizeVideo.current === player?.resize) resizeVideo.current = null
      retireStream()
      player?.dispose()
      if (player) void stopVideo()
    }
  }, [missionId, session?.id, session?.state, session?.platform, showing, captureKey, sessionKey, key, canvas, retry, client, consumerId])

  return {
    resize,
    consumerId,
    frame: picture?.key === key ? picture.frame : null,
    source: picture?.key === key ? picture.source : null,
    playing: showing && video.key === key && video.playing,
    videoSize: videoSize.key === key ? videoSize : { width: 0, height: 0 },
    error: lease.error ?? (failure?.key === key ? failure.error : null),
    showing
  }
}

import type { MobileVideoPacket } from '../../shared/mobileSimulator'
import { mobileVideoSurface, type MobileVideoSize, type MobileVideoSurface } from './mobileVideoSurface'

// Mirror of main/mobileH264.ts's IPC access-unit cap. No Node/Electron in renderer.
const MAX_PACKET_BYTES = 2 * 1024 * 1024
const MAX_DECODE_QUEUE = 4
const MAX_PENDING_FRAMES = 6
const MAX_BUFFERED_PACKETS = 12
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const MAX_QUEUE_AGE_MS = 500
const DECODE_STALL_MS = 1500
const MAX_FRAME_PIXELS = 16 * 1024 * 1024
type PlaybackState = 'playing' | 'fallback'
interface RendererOptions {
  /** Release IPC credit after decode output, or when an invalidated packet is discarded. */
  onConsumed?: (packet: MobileVideoPacket) => void
  /** The caller may request a bounded fresh stream after an actual decoder failure. */
  onRecovery?: () => void
  /** Decoded dimensions, independent of the presentation canvas backing size. */
  onDimensions?: (size: MobileVideoSize) => void
}
interface PendingPacket { packet: MobileVideoPacket; queuedAt: number }

/** Annex-B key chunks require IDR plus parameter sets in the same access unit.
 * Omitting description in VideoDecoderConfig explicitly selects Annex-B.
 * https://www.w3.org/TR/webcodecs-avc-codec-registration/#encodedvideochunk-type
 */
function completeKey(packet: MobileVideoPacket): boolean {
  let sps = false
  let pps = false
  let idr = false
  const data = packet.data
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue
    const header = i + 3
    if ((data[header] & 0x80) !== 0) return false
    const type = data[header] & 31
    if (type === 7 && header + 3 < data.length) {
      const codec = `avc1.${[data[header + 1], data[header + 2], data[header + 3]].map(value => value.toString(16).padStart(2, '0')).join('')}`
      if (codec !== packet.codec.toLowerCase()) return false
      sps = true
    }
    if (type === 8 && header + 1 < data.length) pps = true
    if (type === 5 && header + 1 < data.length) idr = true
  }
  return sps && pps && idr
}

/** A native-size 2D stage and one presentation surface; at most one pending frame. */
export function createMobileVideoRenderer(
  canvas: HTMLCanvasElement,
  onState: (state: PlaybackState) => void,
  options: RendererOptions = {}
): { push: (packet: MobileVideoPacket) => void; resize: () => void; recover: () => void; dispose: () => void } {
  let disposed = false
  let state: PlaybackState = 'fallback'
  let context: CanvasRenderingContext2D | null = null
  let decoder: VideoDecoder | undefined
  let epoch = 0
  let missionId: string | undefined
  let sessionId: string | undefined
  let streamId: string | undefined
  let codec: string | undefined
  let lastTimestamp = -1
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let queue: PendingPacket[] = []
  let queuedBytes = 0
  const decoding = new Map<number, MobileVideoPacket>()
  let draining = false
  let recoveryRequested = false
  let displayFrame: VideoFrame | undefined
  let stage: OffscreenCanvas | HTMLCanvasElement | undefined
  let stageContext: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null
  let staged = false
  let paintRequest: number | undefined
  let source: MobileVideoSize = { width: 0, height: 0 }
  let surface: MobileVideoSurface | null = null
  const view = canvas.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? undefined : window)
  const originalStyle = canvas.style ? { left: canvas.style.left, top: canvas.style.top, width: canvas.style.width, height: canvas.style.height } : null
  let media: MediaQueryList | undefined
  const resizeObserver = view?.ResizeObserver ? new view.ResizeObserver(() => resize()) : null
  if (canvas.parentElement) resizeObserver?.observe(canvas.parentElement)
  view?.addEventListener?.('resize', resize)
  view?.addEventListener?.('scroll', resize, true)
  view?.addEventListener?.('focus', resize)
  view?.visualViewport?.addEventListener('resize', resize)
  view?.visualViewport?.addEventListener('scroll', resize)
  function watchPixelRatio(): void {
    media?.removeEventListener('change', pixelRatioChanged)
    media = view?.matchMedia?.(`(resolution: ${view.devicePixelRatio}dppx)`)
    media?.addEventListener('change', pixelRatioChanged)
  }
  function pixelRatioChanged(): void { watchPixelRatio(); resize() }
  watchPixelRatio()
  try { context = canvas.getContext('2d', { alpha: false, desynchronized: true }) } catch { /* PNG fallback stays available. */ }
  onState('fallback')

  function setState(next: PlaybackState): void {
    if (disposed || next === state) return
    state = next
    onState(next)
  }

  function closeDecoder(): void {
    epoch++
    clearTimeout(stallTimer)
    stallTimer = undefined
    const closing = decoder
    decoder = undefined
    const discarded = [...decoding.values(), ...queue.map(item => item.packet)]
    decoding.clear()
    queue = []
    queuedBytes = 0
    if (paintRequest !== undefined) view?.cancelAnimationFrame?.(paintRequest)
    paintRequest = undefined
    displayFrame?.close()
    displayFrame = undefined
    // Drop native GPU storage as soon as this stream is no longer valid.
    if (stage) { stage.width = 0; stage.height = 0 }
    stage = undefined
    stageContext = null
    staged = false
    if (closing) closing.ondequeue = null
    if (closing && closing.state !== 'closed') { try { closing.close() } catch { /* Some implementations close on error themselves. */ } }
    for (const packet of discarded) consumed(packet)
  }

  function fallback(): void {
    closeDecoder()
    setState('fallback')
  }

  function consumed(packet: MobileVideoPacket): void {
    try { options.onConsumed?.(packet) } catch { /* The bridge can be gone during cleanup. */ }
  }

  function recover(): void {
    fallback()
    if (!disposed && !recoveryRequested) {
      recoveryRequested = true
      try { options.onRecovery?.() } catch { /* PNG fallback remains available. */ }
    }
  }

  function watchDecodeProgress(progress = false): void {
    if (!decoding.size && !queue.length) {
      clearTimeout(stallTimer)
      stallTimer = undefined
      return
    }
    if (progress) { clearTimeout(stallTimer); stallTimer = undefined }
    if (stallTimer !== undefined) return
    const watchedEpoch = epoch
    stallTimer = setTimeout(() => {
      stallTimer = undefined
      if (!disposed && watchedEpoch === epoch && (decoding.size > 0 || queue.length > 0)) recover()
    }, DECODE_STALL_MS)
  }

  function paint(): void {
    paintRequest = undefined
    if (disposed || !context || !surface) return
    const frame = displayFrame
    displayFrame = undefined
    try {
      if (frame) {
        const width = frame.displayWidth, height = frame.displayHeight
        if (!stage) {
          stage = view?.OffscreenCanvas ? new view.OffscreenCanvas(width, height) : canvas.ownerDocument?.createElement('canvas')
          if (!stage) throw new Error('Native video surface unavailable')
          stageContext = stage.getContext('2d', { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
        }
        if (!stageContext) throw new Error('Native video context unavailable')
        if (stage.width !== width) stage.width = width
        if (stage.height !== height) stage.height = height
        // Chromium's VideoFrame path does not prefilter strong minification
        // like its canvas-image path. Copy 1:1, then reduce exactly once below.
        stageContext.drawImage(frame, 0, 0, width, height)
        staged = true
      }
      if (!staged || !stage) return
      if (canvas.width !== surface.width) canvas.width = surface.width
      if (canvas.height !== surface.height) canvas.height = surface.height
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.fillStyle = '#000'
      context.fillRect(0, 0, surface.width, surface.height)
      context.drawImage(stage, surface.drawX, surface.drawY, surface.drawWidth, surface.drawHeight)
      setState('playing')
    } catch { recover() } finally { frame?.close() }
  }

  function schedulePaint(): void {
    if (disposed || (!displayFrame && !staged)) return
    if (view?.requestAnimationFrame && canvas.ownerDocument?.visibilityState !== 'hidden') paintRequest ??= view.requestAnimationFrame(paint)
    else paint()
  }

  /** Read geometry on layout/DPR events, never for a steady stream of frames. */
  function resize(): void {
    if (disposed || !source.width || !source.height) return
    const box = canvas.parentElement?.getBoundingClientRect()
    const next = box ? mobileVideoSurface(box, source, (view?.devicePixelRatio || 1) * (view?.visualViewport?.scale || 1),
      { left: view?.visualViewport?.offsetLeft ?? 0, top: view?.visualViewport?.offsetTop ?? 0 }) : null
    if (!next) { surface = null; setState('fallback'); return }
    if (surface && Object.keys(next).every(key => next[key as keyof MobileVideoSurface] === surface![key as keyof MobileVideoSurface])) return
    surface = next
    if (canvas.style) {
      canvas.style.left = `${next.left}px`; canvas.style.top = `${next.top}px`
      canvas.style.width = `${next.cssWidth}px`; canvas.style.height = `${next.cssHeight}px`
    }
    schedulePaint()
  }

  function drain(): void {
    if (disposed || !decoder || decoder.state !== 'configured' || draining) return
    draining = true
    try {
      while (queue.length && decoder && decoder.state === 'configured' && decoder.decodeQueueSize < MAX_DECODE_QUEUE && decoding.size < MAX_PENDING_FRAMES) {
        const item = queue.shift()!
        queuedBytes -= item.packet.data.byteLength
        if (Date.now() - item.queuedAt > MAX_QUEUE_AGE_MS) { consumed(item.packet); recover(); return }
        decoding.set(item.packet.timestampUs, item.packet)
        decoder.decode(new EncodedVideoChunk({ type: item.packet.key ? 'key' : 'delta', timestamp: item.packet.timestampUs, data: item.packet.data }))
      }
      watchDecodeProgress()
    } catch { recover() } finally { draining = false }
  }

  function configure(packet: MobileVideoPacket): boolean {
    closeDecoder()
    const decoderEpoch = epoch
    try {
      decoder = new VideoDecoder({
        output: frame => {
          if (disposed || decoderEpoch !== epoch || !context) { frame.close(); return }
          const packet = decoding.get(frame.timestamp)
          decoding.delete(frame.timestamp)
          const width = frame.displayWidth, height = frame.displayHeight
          if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > MAX_FRAME_PIXELS) {
            frame.close(); if (packet) consumed(packet); recover(); return
          }
          recoveryRequested = false
          // Decoding every reference is mandatory; painting every intermediate
          // output is not. Keep only the newest frame until its native copy;
          // the reusable stage handles static redraws after that frame closes.
          displayFrame?.close()
          displayFrame = frame
          if (source.width !== width || source.height !== height) {
            source = { width, height }
            options.onDimensions?.(source)
            // Also remeasure when rotation changes only the decoded geometry.
            surface = null
            resize()
          } else schedulePaint()
          if (packet) consumed(packet)
          watchDecodeProgress(true)
          drain()
        },
        error: () => { if (!disposed && decoderEpoch === epoch) recover() }
      })
      decoder.ondequeue = () => { if (!disposed && decoderEpoch === epoch) drain() }
      decoder.configure({ codec: packet.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' })
      if (decoderEpoch !== epoch || !decoder || decoder.state !== 'configured') return false
      return true
    } catch { recover(); return false }
  }

  return {
    recover,
    resize,
    push(packet): void {
      if (disposed) { if (packet) consumed(packet); return }
      if (!packet) { fallback(); return }
      if (missionId !== undefined && (packet.missionId !== missionId || packet.sessionId !== sessionId)) { consumed(packet); return }
      if (!context || typeof globalThis.VideoDecoder !== 'function' || typeof globalThis.EncodedVideoChunk !== 'function') { consumed(packet); fallback(); return }
      if (typeof packet.missionId !== 'string' || typeof packet.sessionId !== 'string' || typeof packet.streamId !== 'string' || packet.streamId.length > 128 || !packet.streamId || !/^avc1\.[\da-f]{6}$/i.test(packet.codec) || !Number.isSafeInteger(packet.timestampUs) || packet.timestampUs < 0 || !(packet.data instanceof Uint8Array) || packet.data.byteLength === 0 || packet.data.byteLength > MAX_PACKET_BYTES || typeof packet.key !== 'boolean') { consumed(packet); fallback(); return }
      if (packet.timestampUs <= lastTimestamp) { consumed(packet); return }
      missionId = packet.missionId
      sessionId = packet.sessionId
      lastTimestamp = packet.timestampUs
      const isKey = packet.key && completeKey(packet)
      if (packet.key && !isKey) { consumed(packet); recover(); return }
      if (streamId !== packet.streamId || codec !== packet.codec) {
        if (!isKey) { consumed(packet); fallback(); return }
        fallback()
        streamId = packet.streamId
        codec = packet.codec
        recoveryRequested = false
      }
      if (decoder && decoder.state !== 'configured') recover()
      if (!decoder && (!isKey || !configure(packet))) { consumed(packet); return }
      if (queue.length + decoding.size >= MAX_BUFFERED_PACKETS || queuedBytes + packet.data.byteLength > MAX_BUFFERED_BYTES) { consumed(packet); recover(); return }
      queue.push({ packet, queuedAt: Date.now() })
      queuedBytes += packet.data.byteLength
      drain()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      closeDecoder()
      resizeObserver?.disconnect()
      view?.removeEventListener?.('resize', resize)
      view?.removeEventListener?.('scroll', resize, true)
      view?.removeEventListener?.('focus', resize)
      view?.visualViewport?.removeEventListener('resize', resize)
      view?.visualViewport?.removeEventListener('scroll', resize)
      media?.removeEventListener('change', pixelRatioChanged)
      if (originalStyle && canvas.style) Object.assign(canvas.style, originalStyle)
      context = null
    }
  }
}

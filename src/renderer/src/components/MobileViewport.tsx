import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import type { MobileAction, MobileDevice, MobileSession } from '../../../shared/mobileSimulator'
import { getMobileDeviceProfile } from '../../../shared/mobileDeviceProfiles'
import { mobileFrameAppearance, mobilePhoneLayout, mobileCalibratedPhoneLayout, mobilePhysicalDevice, mobilePointerAction, mobileViewportPoint, mobileWheelSwipe, type MobilePoint } from '../mobileModel'
import { useMobileCalibration } from '../mobileCalibration'
import { useMobileScreen } from '../useMobileScreen'
import { useMobilePointer } from '../useMobilePointer'
import type { MobileClient } from '../mobileClient'
import MobileCalibration from './MobileCalibration'
import MobileDetachedBar from './MobileDetachedBar'
import MobileScaleMenu, { type MobileScaleState } from './MobileScaleMenu'

export function MobileControlIcon({ name }: { name: 'home' | 'back' | 'recents' | 'refresh' | 'send' | 'phone' | 'expand' | 'restore' }): React.JSX.Element {
  const shapes = {
    home: <><path d="m3 9 7-6 7 6v8H3Z" /><path d="M8 17v-6h4v6" /></>,
    back: <path d="m9 4-6 6 6 6M3 10h14" />,
    recents: <><rect x="5" y="5" width="12" height="12" rx="2" /><path d="M13 2H3a1 1 0 0 0-1 1v10" /></>,
    refresh: <><path d="M16 7a6.5 6.5 0 1 0 0 6M16 3v4h-4" /></>,
    send: <><path d="M10 16V4m-5 5 5-5 5 5" /></>,
    phone: <><rect x="5" y="1" width="10" height="18" rx="2" /><path d="M9 4h2m-2 12h2" /></>,
    expand: <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />,
    restore: <path d="M3 7h4V3m6 0v4h4M7 17v-4H3m10 4v-4h4" />
  }
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>
}

export default function MobileViewport({ missionId, session, device, profileId, visible, busy, act, expanded, onToggleExpanded,
  presentation = 'panel', initialScaleMode = 'fit', onContentSize, client, onCloseWindow, closingWindow }: {
  missionId: string; session: MobileSession | null; visible: boolean; busy: boolean
  act: (action: MobileAction) => Promise<boolean>
  expanded: boolean; onToggleExpanded: () => void
  device?: MobileDevice; profileId?: string
  presentation?: 'panel' | 'detached'; initialScaleMode?: 'fit' | 'physical'
  onContentSize?: (size: { width: number; height: number }) => void
  client?: MobileClient | null
  /** Detached window only: the strip's close button docks the phone back. */
  onCloseWindow?: () => void; closingWindow?: boolean
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const group = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const phoneStage = useRef<HTMLDivElement>(null)
  const contentSize = useRef<{ width: number; height: number } | null>(null)
  const latestContentSize = useRef(onContentSize)
  latestContentSize.current = onContentSize
  const initialPhysicalPending = useRef(initialScaleMode === 'physical')
  const feedback = useRef<HTMLDivElement>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestAct = useRef(act)
  latestAct.current = act
  const gesture = useRef<{ pointerId: number; point: MobilePoint; clientX: number; clientY: number; at: number; sessionId: string; live: boolean } | null>(null)
  const [retry, setRetry] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [scaleMode, setScaleMode] = useState<'fit' | 'physical'>(initialScaleMode)
  const [calibrating, setCalibrating] = useState(false)
  const calibration = useMobileCalibration(visible && scaleMode === 'physical', client)
  const [stageSize, setStageSize] = useState({ width: 400, height: 650 })
  const screen = useMobileScreen(missionId, session, visible, canvas, retry, client)
  const ready = session?.state === 'ready'
  const hasPicture = screen.playing || !!screen.source
  const interactive = screen.showing && !!session?.inputAvailable && hasPicture && !screen.error && !busy && !calibrating
  const dimensions = (): { width: number; height: number } => screen.playing
    ? screen.videoSize
    : { width: screen.frame?.width ?? 0, height: screen.frame?.height ?? 0 }
  const size = screen.playing ? screen.videoSize : dimensions()
  const framePlatform = session?.platform ?? device?.platform ?? 'android'
  // A requested model is a boot preview, never evidence that a live preset applied.
  const frameProfileId = framePlatform === 'android'
    ? session?.state === 'starting' && !hasPicture ? profileId ?? session.displayProfileId : session ? session.displayProfileId : profileId
    : undefined
  const profile = getMobileDeviceProfile(frameProfileId)
  const appearance = mobileFrameAppearance(framePlatform, frameProfileId, session?.deviceTypeIdentifier ?? device?.deviceTypeIdentifier)
  const physical = mobilePhysicalDevice(framePlatform, frameProfileId, session?.deviceTypeIdentifier ?? device?.deviceTypeIdentifier)
  const minimumZoom = scaleMode === 'physical' ? .5 : 1
  const ratio = size.width > 0 && size.height > 0 ? size.width / size.height : framePlatform === 'android' && profile?.width && profile.height ? profile.width / profile.height : physical?.aspectRatio ?? 390 / 844
  const physicalCompatible = physical && mobileCalibratedPhoneLayout(physical, ratio, 1, 1) !== null
  const calibratedSize = scaleMode === 'physical' && physical
    ? mobileCalibratedPhoneLayout(physical, ratio, calibration.pixelsPerMm, zoom) : null
  const phoneSize = calibratedSize ?? mobilePhoneLayout(stageSize.width, stageSize.height, ratio, zoom, appearance.bezel, appearance.chin)
  const physicalEstimated = calibration.source === 'estimated' || calibration.source === 'edid-basic'
  const scaleDescription = calibration.source === 'manual' ? 'Medidas oficiais na escala ajustada para este monitor. Clique para corrigir se necessário.'
    : calibration.source === 'edid-basic' ? 'Tamanho estimado pelas medidas do monitor. Clique para corrigir se necessário.'
      : calibration.source === 'estimated' ? 'Tamanho estimado: o monitor não informou medidas físicas. Clique novamente para ajustar com uma régua, se necessário.'
        : 'Medidas informadas pelo monitor. Clique para ajustar se necessário.'
  const physicalTitle = !physical ? 'Escolha um modelo conhecido para usar Tamanho real.'
    : !physicalCompatible ? 'Aguardando a tela com a proporção deste modelo.'
      : scaleDescription
  useLayoutEffect(() => { setCalibrating(false) }, [calibration.key])
  useLayoutEffect(() => { setCalibrating(false) }, [visible, session?.id, frameProfileId])
  useLayoutEffect(() => {
    if (calibratedSize) initialPhysicalPending.current = false
    if (scaleMode === 'physical' && !calibratedSize) {
      if (initialPhysicalPending.current && !ready) return
      initialPhysicalPending.current = false
      setScaleMode('fit'); setZoom(1)
    }
  }, [scaleMode, !!calibratedSize, ready])
  useLayoutEffect(() => { screen.resize() }, [screen.resize, screen.playing, ratio, phoneSize.width, phoneSize.height, stageSize.width, stageSize.height, expanded, calibration.key])
  const paintedBox = (): DOMRect | undefined => screen.playing ? canvas.current?.getBoundingClientRect() : viewport.current?.getBoundingClientRect()
  const pointOf = (event: PointerEvent<HTMLDivElement>, clamp = false): MobilePoint | null => {
    const box = paintedBox()
    const size = dimensions()
    return box ? mobileViewportPoint(box, size.width, size.height, event.clientX, event.clientY, clamp) : null
  }
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const measure = (): void => {
      // Scrollbars belong to the enlarged presentation, not its fit reference.
      // clientSize shrinks when a gutter appears and would resize that same
      // zoom again. The border box changes only when the actual panel does.
      const width = element.offsetWidth || element.clientWidth, height = element.offsetHeight || element.clientHeight
      if (width && height) setStageSize(old => old.width === width && old.height === height ? old : { width, height })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])
  useLayoutEffect(() => {
    // Fit derives from the existing window. Asking that window to resize back
    // from fit would create a sizing feedback loop; only intrinsic physical
    // geometry (including its explicit zoom) proposes new content bounds.
    if (!visible || !onContentSize || !calibratedSize) { contentSize.current = null; return }
    const root = group.current, controls = toolbar.current, padding = phoneStage.current
    if (!root || !controls || !padding) return
    const measuredStyle = root.ownerDocument.defaultView?.getComputedStyle.bind(root.ownerDocument.defaultView)
    if (!measuredStyle) return
    const number = (value: string): number => Number.parseFloat(value) || 0
    const report = (): void => {
      const outer = measuredStyle(root), inset = measuredStyle(padding)
      const next = {
        width: Math.ceil(phoneSize.width + number(inset.paddingLeft) + number(inset.paddingRight) + number(outer.marginLeft) + number(outer.marginRight)),
        height: Math.ceil(phoneSize.height + number(inset.paddingTop) + number(inset.paddingBottom) + controls.getBoundingClientRect().height + number(outer.marginTop) + number(outer.marginBottom))
      }
      if (contentSize.current?.width === next.width && contentSize.current?.height === next.height) return
      contentSize.current = next
      latestContentSize.current?.(next)
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    observer?.observe(controls)
    return () => observer?.disconnect()
  }, [visible, !!onContentSize, phoneSize.width, phoneSize.height, !!calibratedSize, presentation])
  useLayoutEffect(() => {
    if (!stage.current) return
    stage.current.scrollTop = 0
    stage.current.scrollLeft = Math.max(0, (phoneSize.width + 12 - stageSize.width) / 2)
  }, [scaleMode, zoom, ratio, session?.id, expanded])
  const clearFeedback = (): void => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = null
    if (feedback.current) feedback.current.hidden = true
  }
  const markTouch = (point: MobilePoint, release = false): void => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = null
    if (feedback.current) {
      const box = paintedBox(), parent = viewport.current?.getBoundingClientRect(), size = dimensions()
      if (box && parent && size.width > 0 && size.height > 0) {
        const fit = Math.min(box.width / size.width, box.height / size.height)
        feedback.current.style.left = `${box.left - parent.left + (box.width - size.width * fit) / 2 + point.x * size.width * fit}px`
        feedback.current.style.top = `${box.top - parent.top + (box.height - size.height * fit) / 2 + point.y * size.height * fit}px`
      }
      feedback.current.hidden = false
    }
    if (release) feedbackTimer.current = setTimeout(clearFeedback, 140)
  }
  const pointer = useMobilePointer(missionId, session, interactive,
    [ratio, zoom, scaleMode, expanded, stageSize.width, stageSize.height, phoneSize.width, phoneSize.height, calibration.key].join(':'),
    () => { gesture.current = null; clearFeedback() }, client, screen.consumerId)
  useEffect(() => {
    gesture.current = null
    clearFeedback()
    return () => { gesture.current = null; clearFeedback() }
  }, [session?.id, session?.displayProfileId, interactive, ratio, zoom, scaleMode, phoneSize.width, phoneSize.height, calibration.key])

  useEffect(() => {
    const display = viewport.current
    if (!display || !interactive) return
    let timer: ReturnType<typeof setTimeout> | null = null, stopped = false, sending = false, deltaX = 0, deltaY = 0
    const flush = (): void => {
      timer = null
      if (stopped || sending) return
      const box = display.getBoundingClientRect()
      const action = mobileWheelSwipe(deltaX, deltaY, box.width, box.height)
      deltaX = 0; deltaY = 0
      if (!action) return
      sending = true
      void latestAct.current(action).finally(() => {
        sending = false
        if (!stopped && (deltaX || deltaY)) timer = setTimeout(flush, 100)
      })
    }
    const wheel = (event: WheelEvent): void => {
      if (stopped || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      if (event.shiftKey) { if (stage.current) stage.current.scrollTop += event.deltaY || event.deltaX; return }
      if (gesture.current) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? display.clientHeight : 1
      deltaX = Math.max(-1200, Math.min(1200, deltaX + event.deltaX * unit))
      deltaY = Math.max(-1200, Math.min(1200, deltaY + event.deltaY * unit))
      if (!timer && !sending) timer = setTimeout(flush, 70)
    }
    display.addEventListener('wheel', wheel, { passive: false })
    return () => { stopped = true; if (timer) clearTimeout(timer); display.removeEventListener('wheel', wheel) }
  }, [interactive, session?.id, session?.displayProfileId, ratio, zoom, scaleMode, phoneSize.width, phoneSize.height, calibration.key])
  const release = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const status = session?.state === 'ready' ? !session.inputAvailable ? 'somente visualização' : screen.playing ? 'ao vivo' : 'conectado'
    : session?.state === 'starting' ? 'iniciando' : session?.state === 'stopping' ? 'encerrando' : 'dispositivo desconectado'

  const windowTitle = (framePlatform === 'android' ? profile?.name ?? session?.deviceName : session?.deviceName) ?? 'Aparelho'
  const scaleState: MobileScaleState = { mode: scaleMode, physicalActive: !!calibratedSize, physicalAvailable: !!physicalCompatible, physicalTitle, estimated: physicalEstimated,
    zoom, minimumZoom, maximumZoom: 2.5,
    onFit: () => { initialPhysicalPending.current = false; setScaleMode('fit'); setZoom(1) },
    onPhysical: () => { if (physicalCompatible) { setScaleMode('physical'); setZoom(1) } },
    onZoom: value => setZoom(Math.max(minimumZoom, Math.min(2.5, value))),
    onCalibrate: () => { if (calibratedSize) setCalibrating(true) } }
  return <div ref={group} className={`mobile-viewport-group${presentation === 'detached' ? ' is-detached' : ''}`}>
    {presentation === 'detached' ? <MobileDetachedBar barRef={toolbar} title={windowTitle} status={status} connected={!!ready}
      homeDisabled={!ready || !session.inputAvailable || !visible || busy || calibrating} onHome={() => { void act({ type: 'key', key: 'home' }) }}
      refreshDisabled={!ready || !visible} onRefresh={() => setRetry(value => value + 1)}
      onClose={onCloseWindow} closing={closingWindow} scale={scaleState} />
    : <div ref={toolbar} className="mobile-view-toolbar" role="group" aria-label="Visualização do aparelho">
      <div className="mobile-device-controls">
      <button type="button" className="mobile-icon-button" aria-label="Início do dispositivo" title="Início" disabled={!ready || !session.inputAvailable || !visible || busy || calibrating}
        onClick={() => { void act({ type: 'key', key: 'home' }) }}><MobileControlIcon name="home" /></button>
      <span className={`mobile-input-status${ready ? ' is-connected' : ''}`} title={status}><i aria-hidden="true" /><span className="mobile-sr-only">{status}</span></span>
      </div>
      <div className="mobile-window-controls">
      <MobileScaleMenu scale={scaleState} fitLabel="Ajustar ao painel" />
      <i className="mobile-toolbar-sep" aria-hidden="true" />
      <button type="button" className="mobile-expand-button" aria-label={expanded ? 'Restaurar controles do aparelho' : 'Ampliar tela do aparelho'}
        title={expanded ? 'Mostrar controles · Esc' : 'Dedicar o painel ao aparelho'} aria-pressed={expanded} onClick={onToggleExpanded}>
        <MobileControlIcon name={expanded ? 'restore' : 'expand'} />
      </button>
      <button type="button" className="mobile-icon-button" aria-label="Atualizar tela do dispositivo" title="Atualizar tela" disabled={!ready || !visible}
        onClick={() => setRetry(value => value + 1)}><MobileControlIcon name="refresh" /></button>
      </div>
    </div>}
    {pointer.error && <div className="mobile-pointer-notice" role="status">{pointer.error}</div>}
    <div ref={stage} className={`mobile-viewport${zoom > 1 ? ' is-zoomed' : ''}`} title={zoom > 1 ? 'Shift + roda do mouse move a moldura ampliada' : undefined}>
      <div ref={phoneStage} className="mobile-phone-stage" style={{ width: phoneSize.width + 12, height: phoneSize.height + 12 }}>
      <div className={`mobile-phone-shell frame-${appearance.family}${ratio > 1 ? ' is-landscape' : ''}${framePlatform === 'ios' ? ' is-iphone' : ''}`}
        data-device-profile={frameProfileId ?? 'unknown'} data-profile-id={frameProfileId} data-frame-family={appearance.family} data-size-mode={calibratedSize ? 'physical' : 'fit'}
        style={{ '--mobile-screen-ratio': ratio, '--mobile-bezel': `${appearance.bezel}px`, '--mobile-chin': `${appearance.chin}px`, width: phoneSize.width,
          ...(calibratedSize ? { height: calibratedSize.height, padding: `${calibratedSize.paddingY}px ${calibratedSize.paddingX}px` } : {}) } as CSSProperties}>
        <i className="mobile-hardware-button mobile-hardware-volume" aria-hidden="true" />
        <i className="mobile-hardware-button mobile-hardware-power" aria-hidden="true" />
        {appearance.family === 'iphone-home' && <><i className="mobile-phone-home" aria-hidden="true" /><i className="mobile-phone-earpiece" aria-hidden="true" /></>}
        <div ref={viewport} className={`mobile-phone-display${interactive ? ' is-interactive' : ''}${screen.error ? ' has-error' : ''}`}
      style={calibratedSize ? { width: calibratedSize.displayWidth, height: calibratedSize.displayHeight, aspectRatio: 'auto' } : undefined}
      data-testid="mobile-viewport" role="group" aria-label={session ? `Tela de ${session.deviceName}` : 'Tela do simulador'}
      onPointerDown={event => {
        if (!interactive || !session || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
        const point = pointOf(event)
        if (!point) return
        event.preventDefault()
        const live = pointer.available
        if (live && !pointer.down(point)) return
        event.currentTarget.setPointerCapture(event.pointerId)
        gesture.current = { pointerId: event.pointerId, point, clientX: event.clientX, clientY: event.clientY, at: Date.now(), sessionId: session.id, live }
        markTouch(point)
      }}
      onPointerMove={event => { if (gesture.current?.pointerId === event.pointerId) {
        const point = pointOf(event, true)
        if (point) { markTouch(point); if (gesture.current.live) pointer.move(point) }
      } }}
      onPointerUp={event => {
        const start = gesture.current
        if (!start || start.pointerId !== event.pointerId) return
        gesture.current = null
        release(event)
        if (!interactive || start.sessionId !== session?.id) { if (start.live) pointer.cancel(); return }
        const end = pointOf(event, true)
        if (!end) { if (start.live) pointer.cancel(); return }
        markTouch(end, true)
        if (start.live) pointer.up(end)
        else void act(mobilePointerAction(start.point, end, Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY), Date.now() - start.at))
      }}
      onPointerCancel={event => {
        if (gesture.current?.pointerId !== event.pointerId) return
        if (gesture.current.live) pointer.cancel()
        gesture.current = null; clearFeedback(); release(event)
      }}
      onLostPointerCapture={event => {
        if (gesture.current && (gesture.current.pointerId !== event.pointerId || event.currentTarget.hasPointerCapture(event.pointerId))) return
        if (gesture.current?.live) pointer.cancel()
        gesture.current = null
        if (!feedbackTimer.current) clearFeedback()
      }}>
      <canvas ref={canvas} className="mobile-screen" hidden={!screen.playing} aria-label="Vídeo do simulador" />
      {screen.source && <img className="mobile-screen" src={screen.source} alt={`Tela de ${session?.deviceName ?? 'simulador'}`}
        data-session-id={session?.id} hidden={screen.playing} draggable={false} />}
      <i className="mobile-phone-camera" aria-hidden="true"><i /></i>
      <div ref={feedback} className="mobile-touch-feedback" aria-hidden="true" hidden />
      {(!hasPicture || screen.error) && <div className="mobile-viewport-message" role="status">
        {!screen.error && (session?.state === 'starting' ? <i className="mobile-startup-indicator" aria-hidden="true" /> : <MobileControlIcon name="phone" />)}
        <strong>{screen.error ? 'A tela não está atualizando' : session?.state === 'starting' ? 'Iniciando dispositivo…'
          : session?.state === 'stopping' ? 'Encerrando dispositivo…' : session?.state === 'error' ? 'O dispositivo precisa de atenção'
            : ready ? 'Conectando…' : 'Seu app, aqui'}</strong>
        <span>{screen.error ?? session?.error ?? (session ? 'Aguardando o dispositivo.' : 'Escolha um dispositivo e clique em Iniciar.')}</span>
        {screen.error && <button type="button" className="mobile-button" disabled={!ready || !visible} onClick={() => setRetry(value => value + 1)}>Tentar captura novamente</button>}
      </div>}
        </div>
      </div>
      </div>
    </div>
    {calibrating && <MobileCalibration pixelsPerMm={calibration.pixelsPerMm} pixelRatio={calibration.screen.pixelRatio * calibration.screen.viewportScale}
      onReset={calibration.manualPixelsPerMm === null ? undefined : () => {
        if (!calibration.reset()) return false
        setCalibrating(false); setZoom(1)
        return true
      }}
      onCancel={() => setCalibrating(false)} onConfirm={pixelsPerMm => {
        if (!visible || !physicalCompatible || !calibration.confirm(pixelsPerMm)) return false
        setScaleMode('physical'); setZoom(1); setCalibrating(false)
        return true
      }} />}
  </div>
}

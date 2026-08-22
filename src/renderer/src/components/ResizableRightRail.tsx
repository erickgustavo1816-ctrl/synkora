import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import {
  clampRightRailWidth,
  readRightRailPreference,
  rightRailBounds,
  rightRailStorageKey,
  stepRightRailWidth,
  writeRightRailPreference,
  RIGHT_RAIL_DEFAULT_WIDTH,
  RIGHT_RAIL_KEYBOARD_STEP,
  RIGHT_RAIL_MOTION_MS,
  RIGHT_RAIL_MOTION_TAIL_MS
} from '../rightRailSizing'

interface Props {
  children: ReactNode
  /** Mantém o contrato para o futuro painel de subagentes: qualquer conteúdo
   *  pode ocupar este rail sem conhecer a mecânica de largura/persistência. */
  projectKey?: string
  /** O Board mantém o wrapper no DOM em modos legados para não remontar panes;
   *  o contrato só habilita controles quando o palco realmente usa o rail. */
  enabled?: boolean
  className?: string
  label?: string
}

function availableWidthOf(element: HTMLElement | null): number {
  return element?.parentElement?.clientWidth ?? window.innerWidth
}

/** Quem pediu menos movimento recebe o toggle SECO, como antes da rampa. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // matchMedia indisponível (ambiente de teste, webview antiga) nunca pode
    // derrubar o clique: sem resposta, anima.
    return false
  }
}

export default function ResizableRightRail({
  children,
  projectKey,
  enabled = true,
  className,
  label = 'Painel lateral direito'
}: Props): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const key = useMemo(() => rightRailStorageKey(projectKey), [projectKey])
  const [preference, setPreference] = useState(() => {
    if (!enabled || typeof window === 'undefined') {
      return { width: RIGHT_RAIL_DEFAULT_WIDTH, collapsed: false }
    }
    return readRightRailPreference(window.localStorage, key)
  })
  const [availableWidth, setAvailableWidth] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth
  )
  const [dragging, setDragging] = useState(false)
  // A rampa de recolher/expandir vive NESTA janela e em nenhuma outra: o
  // arrasto jamais liga a classe, senão a largura ficaria elástica atrás do
  // ponteiro em vez de colada nele.
  const [animating, setAnimating] = useState(false)
  const motionTimerRef = useRef<number | null>(null)

  function cancelCollapseAnimation(): void {
    if (motionTimerRef.current !== null) {
      window.clearTimeout(motionTimerRef.current)
      motionTimerRef.current = null
    }
    setAnimating(false)
  }

  // `projectKey` é parte do contrato de persistência. Ao trocar de projeto,
  // carregamos a preferência correspondente sem bloquear o primeiro paint.
  useLayoutEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    // Um gesto em voo é do projeto ANTERIOR: a caixa do novo nasce no estado
    // dele, nunca no meio de uma rampa herdada.
    if (motionTimerRef.current !== null) {
      window.clearTimeout(motionTimerRef.current)
      motionTimerRef.current = null
    }
    setAnimating(false)
    setPreference(readRightRailPreference(window.localStorage, key))
  }, [enabled, key])

  // Timer nunca sobrevive ao componente (setState em nó desmontado).
  useEffect(
    () => () => {
      if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current)
      motionTimerRef.current = null
    },
    []
  )

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) return
    const measure = (): void => {
      setAvailableWidth(availableWidthOf(root))
    }
    const parent = root.parentElement
    const observer = typeof ResizeObserver !== 'undefined' && parent
      ? new ResizeObserver(measure)
      : null
    if (observer && parent) observer.observe(parent)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      resizeCleanupRef.current?.()
      resizeCleanupRef.current = null
    }
  }, [enabled])

  const bounds = rightRailBounds(availableWidth)
  const visibleWidth = clampRightRailWidth(preference.width, availableWidth)

  function persist(next: Partial<typeof preference>): void {
    setPreference((current) => {
      const merged = { ...current, ...next }
      if (typeof window !== 'undefined') writeRightRailPreference(window.localStorage, key, merged)
      return merged
    })
  }

  function setWidth(next: number, persistWidth = true): void {
    const clamped = clampRightRailWidth(next, availableWidth)
    setPreference((current) => {
      const merged = { ...current, width: clamped }
      if (persistWidth && typeof window !== 'undefined') {
        writeRightRailPreference(window.localStorage, key, merged)
      }
      return merged
    })
  }

  /**
   * O ÚNICO caminho que anima. A classe entra junto com o estado novo (mesmo
   * commit do React: a transição arranca do valor de antes) e sai por um timer
   * de duração fixa — quando ela cai, o trilho recolhido já está em 0px e a
   * troca para fora do fluxo não aparece na tela.
   */
  function toggleCollapsed(): void {
    if (typeof window !== 'undefined' && !prefersReducedMotion()) {
      if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current)
      setAnimating(true)
      motionTimerRef.current = window.setTimeout(() => {
        motionTimerRef.current = null
        setAnimating(false)
      }, RIGHT_RAIL_MOTION_MS + RIGHT_RAIL_MOTION_TAIL_MS)
    }
    persist({ collapsed: !preference.collapsed })
  }

  function onResizePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (!enabled || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
    const root = rootRef.current
    const handle = event.currentTarget
    if (!root) return
    // Arrasto começado no meio do gesto do botão desarma a rampa NA HORA: a
    // partir daqui a largura é 1:1 com o ponteiro.
    cancelCollapseAnimation()
    resizeCleanupRef.current?.()
    event.preventDefault()
    event.stopPropagation()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = visibleWidth
    let nextWidth = startWidth
    let raf = 0
    let finished = false
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      return
    }
    setDragging(true)

    const applyDraft = (): void => {
      raf = 0
      root.style.setProperty('--right-rail-rendered-width', `${nextWidth}px`)
    }
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return
      move.preventDefault()
      nextWidth = clampRightRailWidth(
        startWidth + (startX - move.clientX),
        availableWidthOf(root)
      )
      if (!raf) raf = window.requestAnimationFrame(applyDraft)
    }
    const finish = (): void => {
      if (finished) return
      finished = true
      if (raf) window.cancelAnimationFrame(raf)
      raf = 0
      root.style.setProperty('--right-rail-rendered-width', `${nextWidth}px`)
      setDragging(false)
      setWidth(nextWidth)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onCancel)
      handle.removeEventListener('lostpointercapture', onLostCapture)
      window.removeEventListener('blur', onCancel)
      if (handle.hasPointerCapture(pointerId)) {
        try {
          handle.releasePointerCapture(pointerId)
        } catch {
          // A captura pode ter sido liberada pelo browser antes do cleanup.
        }
      }
      if (resizeCleanupRef.current === finish) resizeCleanupRef.current = null
    }
    const onUp = (up: PointerEvent): void => {
      if (up.pointerId === pointerId) finish()
    }
    const onCancel = (cancel?: Event): void => {
      if (cancel && 'pointerId' in cancel && (cancel as PointerEvent).pointerId !== pointerId) return
      finish()
    }
    const onLostCapture = (lost: PointerEvent): void => {
      if (lost.pointerId === pointerId) finish()
    }
    resizeCleanupRef.current = finish
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onCancel)
    handle.addEventListener('lostpointercapture', onLostCapture)
    window.addEventListener('blur', onCancel)
  }

  function onResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!enabled) return
    const largeStep = RIGHT_RAIL_KEYBOARD_STEP * 2
    let next: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
        next = stepRightRailWidth(visibleWidth, 'increase', availableWidth, event.shiftKey ? largeStep : undefined)
        break
      case 'ArrowRight':
        next = stepRightRailWidth(visibleWidth, 'decrease', availableWidth, event.shiftKey ? largeStep : undefined)
        break
      case 'Home':
        next = bounds.min
        break
      case 'End':
        next = bounds.max
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    if (next !== null) setWidth(next)
  }

  const classes = [
    className,
    'right-rail',
    enabled ? 'right-rail-enabled' : '',
    dragging ? 'is-dragging' : '',
    preference.collapsed ? 'is-collapsed' : '',
    animating ? 'is-animating' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const style = {
    '--right-rail-rendered-width': `${visibleWidth}px`,
    // Fonte única da duração: a mesma constante governa a rampa do CSS e o
    // timer que tira `.is-animating`.
    '--right-rail-motion': `${RIGHT_RAIL_MOTION_MS}ms`
  } as CSSProperties

  return (
    <div
      ref={rootRef}
      className={classes}
      style={style}
      data-right-rail={enabled ? 'true' : undefined}
      data-right-rail-collapsed={enabled && preference.collapsed ? 'true' : undefined}
    >
      {enabled && (
        <>
          <div
            className="right-rail-resizer"
            role="separator"
            tabIndex={0}
            aria-label="Redimensionar painel lateral"
            aria-orientation="vertical"
            aria-valuemin={bounds.min}
            aria-valuemax={bounds.max}
            aria-valuenow={visibleWidth}
            aria-valuetext={`${visibleWidth} pixels`}
            onPointerDown={onResizePointerDown}
            onKeyDown={onResizeKeyDown}
          />
          <button
            className="right-rail-toggle"
            type="button"
            aria-expanded={!preference.collapsed}
            aria-controls={`${key}-content`}
            aria-label={preference.collapsed ? `Mostrar ${label}` : `Ocultar ${label}`}
            data-tip={preference.collapsed ? `Mostrar ${label}` : `Ocultar ${label}`}
            onClick={toggleCollapsed}
          >
            {/* RODADA 2 DO DOCK (2026-08-22): o chevron dizia uma DIREÇÃO; este
                ícone diz o PAINEL — a moldura da tela com a divisória interna,
                no idioma que o dono já conhece do "toggle panel" do VS Code. E
                o estado é FORMA antes de cor: a fatia da direita está PINTADA
                enquanto o trilho está aberto e fica OCA quando ele fecha. */}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.75" y="3" width="12.5" height="10" rx="1.6" />
              <path d="M10 3v10" />
              {!preference.collapsed && (
                <path
                  className="right-rail-toggle-pane"
                  d="M10 3h2.65a1.6 1.6 0 0 1 1.6 1.6v6.8a1.6 1.6 0 0 1-1.6 1.6H10z"
                />
              )}
            </svg>
          </button>
        </>
      )}
      {enabled ? (
        <div
          id={`${key}-content`}
          className="right-rail-content"
          aria-hidden={preference.collapsed || undefined}
          inert={preference.collapsed ? true : undefined}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

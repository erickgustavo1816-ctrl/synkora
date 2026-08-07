import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { createPaperField, type FieldWell, type PaperField } from '../paperField'

// ————————————————————————————————————————————————————————————————————————
// O PAPEL VIVO DA HOME — campo de partículas atrás do saguão.
//
// Mesmo motor do mapa da aba Panes (paperField.ts, Canvas 2D — NUNCA WebGL: o
// orçamento de contextos é dos terminais). A diferença é a fonte da gravidade:
// no mapa os poços são os cards da constelação; aqui são as ÂNCORAS que a Home
// registra — a marca, cada universo, cada conta. Poço é sempre um FATO
// (trabalho rodando atrai, alerta repele), nunca enfeite.
//
// O componente não escuta o ponteiro sozinho: ele fica atrás do conteúdo com
// `pointer-events: none`, então quem repassa é a Home (`pointerAt`). É o mesmo
// contrato do ConstellationMap e evita um listener global disputando com os
// cards.
// ————————————————————————————————————————————————————————————————————————

/** Poço ancorado num ELEMENTO da tela — o componente mede e converte. */
export interface FieldAnchor {
  el: HTMLElement | null
  /** raio de influência em px */
  radius: number
  /** -1..1 — positivo atrai (trabalho), negativo repele (alerta) */
  strength: number
  /** VOCABULÁRIO FECHADO: 6 = problema · 21 = o app falando de si · 145 =
   *  trabalho vivo. O motor só materializa 3 matizes (HUE_SLOTS) e devolve −1
   *  para a quarta — matiz por projeto (hueOf) tingiria 3 universos ao acaso. */
  hue?: number
  pulse?: boolean
}

export interface HomeFieldHandle {
  /** substitui a gravidade do campo a partir das âncoras vivas */
  setAnchors(list: FieldAnchor[]): void
  /** onda de choque centrada num elemento (null = centro do campo) */
  shockAt(el: HTMLElement | null, opts?: { hue?: number; strength?: number }): void
  /** posição do ponteiro em coordenadas de VIEWPORT (null = saiu) */
  pointerAt(clientX: number | null, clientY: number | null): void
  /** false quando a Home está escondida (display:none) ou a janela em segundo plano */
  isLive(): boolean
}

interface Props {
  /** semente do céu. CONSTANTE de propósito: derivar de projects.length faria
   *  o campo reembaralhar a cada universo criado (resize só reamostra com >10%
   *  de mudança de área justamente para isso não acontecer). */
  seed?: string
}

const HomeField = forwardRef<HomeFieldHandle, Props>(function HomeField(
  { seed = 'synkora-home' },
  ref
) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<PaperField | null>(null)
  /** rect do canvas, cacheado: converter tela→canvas não pode custar um
   *  reflow por âncora a cada scroll */
  const rectRef = useRef<DOMRect | null>(null)
  const liveRef = useRef(false)

  useLayoutEffect(() => {
    const el = wrapRef.current
    const canvas = canvasRef.current
    if (!el || !canvas) return
    // DISCRETO por decisão do usuário (2026-07-28): a Home não pode parecer o
    // mapa. Espaçamento maior = menos pontos (o motor tem teto por área, não
    // por tela), e o resto do recuo é opacidade no CSS — nada de mexer nas
    // constantes do motor, que é compartilhado com a aba Panes.
    const field = createPaperField(canvas, { seed, spacing: 38, ringRadius: 130 })
    fieldRef.current = field

    const measure = (): void => {
      const r = el.getBoundingClientRect()
      // caixa 0×0 = Home escondida por display:none (o App mantém tudo montado)
      const visible = r.width > 0 && r.height > 0
      liveRef.current = visible && !document.hidden
      rectRef.current = r
      field.setPaused(!visible || document.hidden)
      if (visible) field.resize(r.width, r.height)
      if (!visible) field.pointer(null, null)
    }

    const obs = new ResizeObserver(measure)
    obs.observe(el)
    measure()

    const onVis = (): void => measure()
    document.addEventListener('visibilitychange', onVis)

    return () => {
      obs.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      field.destroy()
      fieldRef.current = null
    }
  }, [seed])

  useImperativeHandle(
    ref,
    (): HomeFieldHandle => ({
      setAnchors(list) {
        const field = fieldRef.current
        const rect = rectRef.current
        if (!field || !rect) return
        const wells: FieldWell[] = []
        for (const a of list) {
          if (!a.el) continue
          const r = a.el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          wells.push({
            x: r.left + r.width / 2 - rect.left,
            y: r.top + r.height / 2 - rect.top,
            radius: a.radius,
            strength: a.strength,
            hue: a.hue,
            pulse: a.pulse
          })
        }
        field.setWells(wells)
      },

      shockAt(el, opts) {
        const field = fieldRef.current
        const rect = rectRef.current
        // GUARDA: o tempo do campo só avança dentro do rAF, que não roda
        // pausado — enfileirar ondas com a Home escondida faria todas
        // estourarem juntas na volta.
        if (!field || !rect || !liveRef.current) return
        let x = rect.width / 2
        let y = rect.height / 2
        if (el) {
          const r = el.getBoundingClientRect()
          x = r.left + r.width / 2 - rect.left
          y = r.top + r.height / 2 - rect.top
        }
        field.shock(x, y, opts)
      },

      pointerAt(clientX, clientY) {
        const field = fieldRef.current
        const rect = rectRef.current
        if (!field || !rect) return
        if (clientX === null || clientY === null) {
          field.pointer(null, null)
          return
        }
        field.pointer(clientX - rect.left, clientY - rect.top)
      },

      isLive: () => liveRef.current
    }),
    []
  )

  return (
    <div className="home-field" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
})

export default HomeField

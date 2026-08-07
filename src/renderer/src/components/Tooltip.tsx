import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Tooltip customizado do app (substitui o title= nativo, feio e lento):
// UM listener global — qualquer elemento com data-tip ganha tooltip no tema
// painel, via portal no body (nunca clipado por overflow/stacking context).
// Montar UMA vez na raiz do App: <TooltipLayer />.

interface TipState {
  text: string
  anchor: DOMRect
}

const SHOW_DELAY = 350

export default function TooltipLayer(): React.JSX.Element | null {
  const [tip, setTip] = useState<TipState | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const anchorElRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let timer: number | undefined
    const overlay = typeof window.synkoraOverlay === 'undefined' ? null : window.synkoraOverlay
    const hide = (): void => {
      window.clearTimeout(timer)
      anchorElRef.current = null
      setTip(null)
      overlay?.hideTooltip()
    }
    const onOver = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      const el = target?.closest?.('[data-tip]') as HTMLElement | null
      if (el === anchorElRef.current) return
      window.clearTimeout(timer)
      anchorElRef.current = el
      setTip(null)
      overlay?.hideTooltip()
      if (!el) return
      timer = window.setTimeout(() => {
        // o elemento pode ter saído do DOM durante o delay
        if (!el.isConnected || anchorElRef.current !== el) return
        const text = el.getAttribute('data-tip')
        if (!text) return
        const anchor = el.getBoundingClientRect()
        if (overlay) {
          overlay.showTooltip({
            text,
            anchor: {
              left: anchor.left,
              top: anchor.top,
              width: anchor.width,
              height: anchor.height
            }
          })
          return
        }
        setTip({ text, anchor })
      }, SHOW_DELAY)
    }
    const onOut = (e: MouseEvent): void => {
      const anchor = anchorElRef.current
      if (!anchor) return
      const next = e.relatedTarget
      if (next instanceof Node && anchor.contains(next)) return
      hide()
    }
    const onVisibility = (): void => {
      if (document.hidden) hide()
    }
    // Sair direto de uma BrowserWindow não produz outro `mouseover`. O
    // `mouseout` com relatedTarget nulo fecha também esse caminho e evita o
    // tooltip órfão no mini (que é focusable:false e, por isso, não dá blur).
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('scroll', hide, true)
    document.documentElement.addEventListener('mouseleave', hide)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)
    return () => {
      window.clearTimeout(timer)
      overlay?.hideTooltip()
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('scroll', hide, true)
      document.documentElement.removeEventListener('mouseleave', hide)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Posiciona DEPOIS de renderizar (precisa da largura real): centrado no
  // anchor, clampado no viewport; abaixo por padrão, acima se não couber.
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!el || !tip) return
    const { anchor } = tip
    const w = el.offsetWidth
    const h = el.offsetHeight
    const margin = 8
    let x = anchor.left + anchor.width / 2 - w / 2
    x = Math.max(margin, Math.min(x, window.innerWidth - w - margin))
    const below = anchor.bottom + 7
    const placeBottom = below + h + margin <= window.innerHeight
    const y = placeBottom ? below : Math.max(margin, anchor.top - h - 7)
    el.style.left = `${Math.round(x)}px`
    el.style.top = `${Math.round(y)}px`
    el.dataset.place = placeBottom ? 'bottom' : 'top'
    // seta aponta para o centro do anchor mesmo com o corpo clampado
    const arrowX = anchor.left + anchor.width / 2 - x
    el.style.setProperty('--tip-arrow-x', `${Math.round(Math.max(10, Math.min(arrowX, w - 10)))}px`)
  }, [tip])

  if (!tip) return null
  return createPortal(
    <div ref={tipRef} className="app-tip" role="tooltip">
      {tip.text}
    </div>,
    document.body
  )
}

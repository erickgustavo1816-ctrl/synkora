import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { panesViewVisibleRect, useStore } from '../store'

// Tooltip customizado do app (substitui o title= nativo, feio e lento):
// UM listener global — qualquer elemento com data-tip ganha tooltip no tema
// painel, via portal no body (nunca clipado por overflow/stacking context).
// Montar UMA vez na raiz do App: <TooltipLayer />.
//
// 2026-08-11: "nunca clipado" ganhou uma exceção real — a WebContentsView de
// panes compõe POR CIMA do DOM do host, então tooltip do host que cruza o rect
// dela era cortado na borda (caso real: tooltip do radar de andamento cortado
// no meio com a aba Panes ativa). Solução: ROTEAR o tooltip para dentro da
// view (mesmo bundle, mesma .app-tip — este componente também monta lá) via
// panesView.tipShow/onTip; o main translada o anchor para coords da view.
// Descartados: esconder a view no hover (piscaria a cada tooltip); reusar a
// janela nativa de tooltip do SynVoice (parented ao mini overlay e gated por
// synVoiceDetached no index — outra dona, outro ciclo de vida); clampar na
// faixa visível do host (a titlebar tem 36px — tooltip de 2+ linhas não cabe).

interface TipState {
  text: string
  anchor: DOMRect
}

const SHOW_DELAY = 350

export default function TooltipLayer(): React.JSX.Element | null {
  const [tip, setTip] = useState<TipState | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const anchorElRef = useRef<HTMLElement | null>(null)
  // tooltip atual foi roteado para a view de panes? (o hide precisa alcançá-lo)
  const routedRef = useRef(false)

  useEffect(() => {
    let timer: number | undefined
    const overlay = typeof window.synkoraOverlay === 'undefined' ? null : window.synkoraOverlay
    // janelas de overlay (mini SynVoice) não têm window.synkora — só o host e
    // a própria view de panes chegam aqui com a bridge completa
    const host = typeof window.synkora === 'undefined' ? null : window.synkora
    const clearRouted = (): void => {
      if (!routedRef.current) return
      routedRef.current = false
      host?.panesView.tipHide?.()
    }
    const hide = (): void => {
      window.clearTimeout(timer)
      anchorElRef.current = null
      setTip(null)
      overlay?.hideTooltip()
      clearRouted()
    }
    const onOver = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      const el = target?.closest?.('[data-tip]') as HTMLElement | null
      if (el === anchorElRef.current) return
      window.clearTimeout(timer)
      anchorElRef.current = el
      setTip(null)
      overlay?.hideTooltip()
      clearRouted()
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
    // Lado VIEW do roteamento: tooltip do host chega já transladado para as
    // coords daqui e entra no MESMO estado/render (null = esconder). No host
    // este canal nunca dispara (o main só envia à view).
    const offTip = host?.panesView.onTip
      ? host.panesView.onTip((routed) => {
          if (!routed) {
            setTip(null)
            return
          }
          anchorElRef.current = null
          setTip({
            text: routed.text,
            anchor: new DOMRect(
              routed.anchor.left,
              routed.anchor.top,
              routed.anchor.width,
              routed.anchor.height
            )
          })
        })
      : () => undefined
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
      clearRouted()
      offTip()
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
    // Piso também no ramo "abaixo": tooltip ROTEADO chega na view com o anchor
    // ACIMA do rect dela (top negativo) — sem o clamp ele nasceria clipado de
    // novo, agora pela borda superior da view (2026-08-11).
    const y = placeBottom ? Math.max(margin, below) : Math.max(margin, anchor.top - h - 7)
    // ——— roteamento para a view de panes (2026-08-11) ———
    // Só agora o rect REAL do tooltip existe (largura depende do texto): se ele
    // cruza o rect visível da view, o host não consegue desenhá-lo (a view
    // compõe por cima) — manda para a view e some daqui ANTES do paint
    // (useLayoutEffect é síncrono, zero flicker). Na própria view o helper
    // devolve null (anchor nunca é setado lá) — sem loop de re-roteamento.
    const host = typeof window.synkora === 'undefined' ? null : window.synkora
    if (host?.panesView.tipShow) {
      const view = panesViewVisibleRect(useStore.getState())
      const crosses =
        view !== null &&
        x < view.x + view.width &&
        x + w > view.x &&
        y < view.y + view.height &&
        y + h > view.y
      if (crosses) {
        routedRef.current = true
        host.panesView.tipShow({
          text: tip.text,
          anchor: {
            left: anchor.left,
            top: anchor.top,
            width: anchor.width,
            height: anchor.height
          }
        })
        setTip(null)
        return
      }
    }
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

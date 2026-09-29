import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectLayoutDropTarget } from '../../shared/projectLayout'
import {
  railAutoScrollStep,
  railDragStarted,
  railDropAt,
  type RailDragSource,
  type RailDrop,
  type RailRect,
  type RailSlotMeasure
} from './railDragModel'

// ————————————————————————————————————————————————————————————————————————
// ARRASTAR NO RAIL — o gesto (grupos, 2026-09-29).
//
// O modelo puro (railDragModel) decide ONDE cai; aqui mora o que é de DOM:
// ponteiro, 5 px de tolerância, medir a lista, rolagem automática nas bordas,
// Esc que cancela, e o clique engolido depois de um arraste (senão soltar
// sobre uma pasta também a abriria). O fantasma e a pílula acompanham o
// ponteiro por ref, sem redesenhar o rail a cada pixel — o estado React só
// muda quando o ALVO muda.
//
// A lista marca o que se mede com atributos (ProjectRail/RailGroupFolder):
//   [data-slot="p"|"g"|"go"] no nível de cima (tile, pasta, cápsula),
//   [data-headwrap] no topo da cápsula, [data-child] em cada filho, e o que se
//   arrasta com [data-pid] (universo), [data-folder] / [data-head] (grupo).
// ————————————————————————————————————————————————————————————————————————

export interface RailDragState {
  source: RailDragSource
  drop: RailDrop | null
  /** topo da linha de 3 px no CONTEÚDO da lista (px), quando o alvo é linha */
  lineTop: number | null
}

interface Options {
  listRef: React.RefObject<HTMLDivElement | null>
  /** sem layout carregado não há o que reordenar */
  enabled: boolean
  onDrop: (source: RailDragSource, target: ProjectLayoutDropTarget) => void
}

interface Press {
  x: number
  y: number
  source: RailDragSource
}

const GHOST_HALF = 23

function rectOf(el: Element): RailRect {
  const r = el.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom }
}

function measureSlots(list: HTMLElement): RailSlotMeasure[] {
  const slots: RailSlotMeasure[] = []
  for (const el of Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-slot]'))) {
    const kind = el.dataset.slot
    if (kind === 'p' && el.dataset.pid) {
      slots.push({ kind: 'project', projectId: el.dataset.pid, rect: rectOf(el) })
    } else if (kind === 'g' && el.dataset.gid) {
      slots.push({ kind: 'folder', groupId: el.dataset.gid, rect: rectOf(el) })
    } else if (kind === 'go' && el.dataset.gid) {
      const head = el.querySelector('[data-headwrap]') ?? el
      const children = Array.from(el.querySelectorAll<HTMLElement>('[data-child]'))
        .filter((child) => child.dataset.pid)
        .map((child) => ({ projectId: child.dataset.pid as string, rect: rectOf(child) }))
      slots.push({ kind: 'capsule', groupId: el.dataset.gid, rect: rectOf(el), head: rectOf(head), children })
    }
  }
  return slots
}

function sourceOf(el: HTMLElement): RailDragSource | null {
  if (el.dataset.pid) return { kind: 'project', projectId: el.dataset.pid }
  const groupId = el.dataset.folder ?? el.dataset.head
  return groupId ? { kind: 'group', groupId } : null
}

function sameDrag(a: RailDragState | null, b: RailDragState | null): boolean {
  if (a === null || b === null) return a === b
  return a.source === b.source && a.lineTop === b.lineTop && JSON.stringify(a.drop) === JSON.stringify(b.drop)
}

export function useRailDrag({ listRef, enabled, onDrop }: Options): {
  drag: RailDragState | null
  /** callback refs do fantasma e da pílula (portal do ProjectRail) */
  ghostRef: (el: HTMLElement | null) => void
  hintRef: (el: HTMLElement | null) => void
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void
} {
  const [drag, setDrag] = useState<RailDragState | null>(null)
  const dragRef = useRef<RailDragState | null>(null)
  const pressRef = useRef<Press | null>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const ghostEl = useRef<HTMLElement | null>(null)
  const hintEl = useRef<HTMLElement | null>(null)
  const suppressClick = useRef(false)
  const frame = useRef(0)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  const commit = useCallback((next: RailDragState | null) => {
    if (sameDrag(dragRef.current, next)) return
    dragRef.current = next
    setDrag(next)
  }, [])

  const place = useCallback(() => {
    const { x, y } = pointerRef.current
    if (ghostEl.current) {
      ghostEl.current.style.left = `${x - GHOST_HALF}px`
      ghostEl.current.style.top = `${y - GHOST_HALF}px`
    }
    if (hintEl.current) hintEl.current.style.top = `${y}px`
  }, [])

  const ghostRef = useCallback(
    (el: HTMLElement | null) => {
      ghostEl.current = el
      place()
    },
    [place]
  )
  const hintRef = useCallback(
    (el: HTMLElement | null) => {
      hintEl.current = el
      place()
    },
    [place]
  )

  /** mede a lista e recalcula o alvo na altura atual do ponteiro */
  const retarget = useCallback(
    (source: RailDragSource) => {
      const list = listRef.current
      if (!list) return
      const drop = railDropAt(measureSlots(list), source, pointerRef.current.y)
      let lineTop: number | null = null
      if (drop?.feedback.kind === 'line') {
        const listTop = list.getBoundingClientRect().top
        const top = Math.round(drop.feedback.y - listTop + list.scrollTop - 1.5)
        // antes do primeiro item a linha cairia acima da caixa da lista (e
        // seria cortada): fica grampeada no respiro do topo
        lineTop = Math.max(0, Math.min(top, list.scrollHeight - 3))
      }
      commit({ source, drop, lineTop })
    },
    [commit, listRef]
  )

  const end = useCallback(
    (drop: boolean) => {
      const current = dragRef.current
      pressRef.current = null
      if (!current) return
      window.cancelAnimationFrame(frame.current)
      document.body.classList.remove('rail-dragging')
      // o click que o navegador dispara logo depois do pointerup é engolido
      // (soltar sobre a pasta não pode abri-la); zera no próximo giro
      suppressClick.current = true
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
      commit(null)
      if (drop && current.drop) onDropRef.current(current.source, current.drop.target)
    },
    [commit]
  )

  // rolagem automática: enquanto o ponteiro fica na borda, a lista rola a cada
  // quadro (e o alvo é recalculado — as fileiras andaram)
  const autoScroll = useCallback(() => {
    const current = dragRef.current
    const list = listRef.current
    if (!current || !list) return
    const r = list.getBoundingClientRect()
    const step = railAutoScrollStep(pointerRef.current.y, r.top, r.bottom)
    if (step !== 0) {
      const before = list.scrollTop
      list.scrollTop += step
      if (list.scrollTop !== before) retarget(current.source)
    }
    frame.current = window.requestAnimationFrame(autoScroll)
  }, [listRef, retarget])

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      const current = dragRef.current
      if (current) {
        // soltou fora da janela: o pointerup não chegou — cancela
        if (event.buttons === 0) {
          end(false)
          return
        }
        place()
        retarget(current.source)
        return
      }
      const press = pressRef.current
      if (!press) return
      if (event.buttons === 0) {
        pressRef.current = null
        return
      }
      if (!railDragStarted(event.clientX - press.x, event.clientY - press.y)) return
      document.body.classList.add('rail-dragging')
      retarget(press.source)
      frame.current = window.requestAnimationFrame(autoScroll)
    }
    const onUp = (): void => {
      if (dragRef.current) end(true)
      pressRef.current = null
    }
    const onCancel = (): void => end(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !dragRef.current) return
      event.preventDefault()
      event.stopPropagation()
      end(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('keydown', onKey, true)
      window.cancelAnimationFrame(frame.current)
      document.body.classList.remove('rail-dragging')
    }
  }, [autoScroll, end, place, retarget])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || dragRef.current) return
      const el = (event.target as HTMLElement).closest<HTMLElement>('[data-pid], [data-folder], [data-head]')
      if (!el || !event.currentTarget.contains(el)) return
      const source = sourceOf(el)
      if (!source) return
      pointerRef.current = { x: event.clientX, y: event.clientY }
      pressRef.current = { x: event.clientX, y: event.clientY, source }
    },
    [enabled]
  )

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return { drag, ghostRef, hintRef, onPointerDown, onClickCapture }
}

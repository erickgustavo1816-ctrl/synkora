import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { WORKSPACE_MOTION_MS } from './useWorkspacePresence'

/** Animate a change of grid cell without moving or remounting its React owner. */
export function useWorkspacePanelMotion(ref: RefObject<HTMLElement | null>, shown: boolean, key: string): void {
  const previous = useRef<{ box: DOMRect; shown: boolean; key: string } | null>(null)
  const animation = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    if (!shown) animation.current?.cancel()
    const element = ref.current
    if (!element?.getBoundingClientRect) return
    const box = element.getBoundingClientRect()
    const before = previous.current
    if (before?.shown && shown && before.key !== key && element.animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      animation.current?.cancel()
      const x = before.box.left - box.left
      const y = before.box.top - box.top
      if (Math.abs(x) + Math.abs(y) > 1) animation.current = element.animate([
        { transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }
      ], { duration: WORKSPACE_MOTION_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    }
    previous.current = { box, shown, key }
  })
  useEffect(() => () => animation.current?.cancel(), [])
}

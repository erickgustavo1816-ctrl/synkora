import { useLayoutEffect, useState } from 'react'

/** Paint the closed size first; expanding from display:none cannot transition. */
export function useWorkspaceEntrance(open: boolean, visible = true, scope = ''): { entered: boolean; entering: boolean } {
  const [state, setState] = useState({ open, visible, scope, phase: 'ready' as 'ready' | 'initial' | 'entering' })
  if (state.open !== open || state.visible !== visible || state.scope !== scope) {
    const opening = open && !state.open && visible && state.visible && state.scope === scope
    setState({ open, visible, scope, phase: opening ? 'initial' : 'ready' })
  }
  useLayoutEffect(() => {
    if (!open || !visible || state.phase !== 'initial') return
    let cancelled = false
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    frame = window.requestAnimationFrame(() => {
      if (cancelled) return
      frame = window.requestAnimationFrame(() => {
        if (cancelled) return
        setState({ open, visible, scope, phase: 'entering' })
        timer = setTimeout(() => { if (!cancelled) setState({ open, visible, scope, phase: 'ready' }) }, 340)
      })
    })
    return () => { cancelled = true; window.cancelAnimationFrame(frame); clearTimeout(timer) }
    // Phase updates belong to this opening; closing cancels both callbacks.
  }, [open, visible, scope])
  return { entered: open && state.open === open && state.phase !== 'initial', entering: open && state.phase !== 'ready' }
}

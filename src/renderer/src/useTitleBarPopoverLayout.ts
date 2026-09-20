import { useLayoutEffect, type RefObject } from 'react'
import { BROWSER_DOCK_CONTEXT_CHANGED } from './browserDockVisibility'

/** Body portals must retain the titlebar button as their visual anchor. */
export function useTitleBarPopoverLayout(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  dialogRef: RefObject<HTMLDivElement | null>
): void {
  useLayoutEffect(() => {
    const trigger = triggerRef.current, dialog = dialogRef.current
    if (!open || !trigger || !dialog) return
    const notifyBrowser = (): void => {
      window.dispatchEvent(new Event(BROWSER_DOCK_CONTEXT_CHANGED))
    }
    const measure = (): void => {
      const anchor = trigger.getBoundingClientRect()
      const width = dialog.offsetWidth
      const top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - 8))
      Object.assign(dialog.style, {
        left: `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`,
        top: `${top}px`,
        maxHeight: `${Math.max(0, Math.min(window.innerHeight * 0.7, window.innerHeight - top - 8))}px`
      })
      // Loading usage can enlarge an existing portal without adding a body
      // child. Publish its new overlap before waiting on the dock's timer.
      notifyBrowser()
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(trigger)
    observer.observe(dialog)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      // The portal must already be removed when the browser measures again.
      queueMicrotask(notifyBrowser)
    }
  }, [open, triggerRef, dialogRef])
}

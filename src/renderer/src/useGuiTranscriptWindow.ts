import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { GuiItem } from './store'

/** The first paint stays light while the in-memory transcript remains intact. */
export const GUI_TRANSCRIPT_INITIAL_ITEMS = 100
/** Loading older transcript pages is deliberately small to keep prepends cheap. */
export const GUI_TRANSCRIPT_PAGE_SIZE = 20
/** Reflowing markdown/images gets one bounded second to settle at the end. */
export const GUI_TRANSCRIPT_INITIAL_PIN_MS = 1_000
export const GUI_TRANSCRIPT_TOP_THRESHOLD = 48

export interface GuiTranscriptWindowRange {
  start: number
  end: number
  total: number
  hiddenBefore: number
}

function finiteCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function finiteIndex(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

export function guiTranscriptInitialStart(
  totalItems: number,
  windowSize = GUI_TRANSCRIPT_INITIAL_ITEMS
): number {
  const total = finiteCount(totalItems)
  const size = Math.max(1, finiteCount(windowSize))
  return Math.max(0, total - size)
}

export function guiTranscriptPageStart(
  currentStart: number,
  pageSize = GUI_TRANSCRIPT_PAGE_SIZE
): number {
  const start = finiteIndex(currentStart)
  const page = Math.max(1, finiteCount(pageSize))
  return Math.max(0, start - page)
}

export function guiTranscriptWindowRange(
  totalItems: number,
  requestedStart: number
): GuiTranscriptWindowRange {
  const total = finiteCount(totalItems)
  const start = Math.min(total, finiteIndex(requestedStart))
  // Paging prepends older items; the tail must remain in the DOM so the user
  // never loses the latest messages while asking for another 20.
  const end = total
  return { start, end, total, hiddenBefore: start }
}

/**
 * When older nodes are prepended, the same visible node stays under the user's
 * eyes by adding the exact height delta to scrollTop. It is intentionally pure
 * so the anchor contract can be tested without a browser.
 */
export function guiTranscriptAnchoredScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number
): number {
  const top = Number.isFinite(previousScrollTop) ? previousScrollTop : 0
  const before = Number.isFinite(previousScrollHeight) ? previousScrollHeight : 0
  const after = Number.isFinite(nextScrollHeight) ? nextScrollHeight : before
  return Math.max(0, top + after - before)
}

interface GuiTranscriptAnchor {
  previousScrollTop: number
  previousScrollHeight: number
  targetStart: number
}

export interface UseGuiTranscriptWindowOptions {
  items: readonly GuiItem[]
  logRef: RefObject<HTMLDivElement | null>
  pinnedRef: MutableRefObject<boolean>
  onPinnedChange: (pinned: boolean) => void
}

export interface GuiTranscriptWindowResult {
  visibleItems: GuiItem[]
  totalItems: number
  hiddenBefore: number
  hasMoreBefore: boolean
  loadMore: () => void
  loadAll: () => void
  onScroll: () => void
  goToEnd: () => void
  keepPinnedToEnd: () => void
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function requestFrame(callback: FrameRequestCallback): number | null {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return null
  }
  return window.requestAnimationFrame(callback)
}

function cancelFrame(frame: number | null): void {
  if (frame === null || typeof window === 'undefined') return
  window.cancelAnimationFrame(frame)
}

/**
 * Owns the renderer-only transcript window. `items` remains the complete store
 * snapshot; only the rendered slice is paged. Older pages are prepended from
 * that snapshot, so the main process and store caps stay untouched.
 */
export function useGuiTranscriptWindow({
  items,
  logRef,
  pinnedRef,
  onPinnedChange
}: UseGuiTranscriptWindowOptions): GuiTranscriptWindowResult {
  const [windowStart, setWindowStart] = useState(() => guiTranscriptInitialStart(items.length))
  const windowStartRef = useRef(windowStart)
  const itemCountRef = useRef(items.length)
  const previousItemCountRef = useRef(items.length)
  const previousFirstItemIdRef = useRef(items[0]?.id)
  const initializedRef = useRef(false)
  const pendingAnchorRef = useRef<GuiTranscriptAnchor | null>(null)
  const loadingMoreRef = useRef(false)
  const restoringScrollRef = useRef(false)
  const initialPinFrameRef = useRef<number | null>(null)
  const initialPinUntilRef = useRef(0)

  windowStartRef.current = windowStart
  itemCountRef.current = items.length

  const updateWindowStart = useCallback((next: number): void => {
    const total = itemCountRef.current
    const normalized = Math.min(total, Math.max(0, Math.floor(next)))
    windowStartRef.current = normalized
    setWindowStart((current) => (current === normalized ? current : normalized))
  }, [])

  const updatePinned = useCallback(
    (next: boolean): void => {
      if (pinnedRef.current === next) return
      pinnedRef.current = next
      onPinnedChange(next)
    },
    [onPinnedChange, pinnedRef]
  )

  const startInitialPinning = useCallback((): void => {
    cancelFrame(initialPinFrameRef.current)
    initialPinUntilRef.current = now() + GUI_TRANSCRIPT_INITIAL_PIN_MS

    const tick = (): void => {
      initialPinFrameRef.current = null
      const log = logRef.current
      if (!log || now() >= initialPinUntilRef.current || !pinnedRef.current) return
      log.scrollTop = log.scrollHeight
      initialPinFrameRef.current = requestFrame(() => tick())
    }

    initialPinFrameRef.current = requestFrame(() => tick())
  }, [logRef, pinnedRef])

  const loadMore = useCallback((): void => {
    if (loadingMoreRef.current || pendingAnchorRef.current) return
    const currentStart = Math.min(itemCountRef.current, windowStartRef.current)
    const nextStart = guiTranscriptPageStart(currentStart)
    if (nextStart === currentStart) return

    const log = logRef.current
    if (!log) {
      updateWindowStart(nextStart)
      return
    }
    pendingAnchorRef.current = {
      previousScrollTop: log.scrollTop,
      previousScrollHeight: log.scrollHeight,
      targetStart: nextStart
    }
    loadingMoreRef.current = true
    updateWindowStart(nextStart)
  }, [logRef, updateWindowStart])

  const loadAll = useCallback((): void => {
    if (loadingMoreRef.current || pendingAnchorRef.current) return
    const currentStart = Math.min(itemCountRef.current, windowStartRef.current)
    if (currentStart === 0) return

    const log = logRef.current
    if (!log) {
      updateWindowStart(0)
      return
    }
    pendingAnchorRef.current = {
      previousScrollTop: log.scrollTop,
      previousScrollHeight: log.scrollHeight,
      targetStart: 0
    }
    loadingMoreRef.current = true
    updateWindowStart(0)
  }, [logRef, updateWindowStart])

  const scrollToEnd = useCallback((): void => {
    const log = logRef.current
    if (!log) return
    log.scrollTop = log.scrollHeight
  }, [logRef])

  const goToEnd = useCallback((): void => {
    pendingAnchorRef.current = null
    loadingMoreRef.current = false
    updatePinned(true)
    updateWindowStart(guiTranscriptInitialStart(itemCountRef.current))
    scrollToEnd()
  }, [scrollToEnd, updatePinned, updateWindowStart])

  const keepPinnedToEnd = useCallback((): void => {
    if (!pinnedRef.current) return
    const frame = requestFrame(() => {
      if (pinnedRef.current) scrollToEnd()
    })
    if (frame === null) scrollToEnd()
  }, [pinnedRef, scrollToEnd])

  const onScroll = useCallback((): void => {
    if (restoringScrollRef.current) return
    const log = logRef.current
    if (!log) return

    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < GUI_TRANSCRIPT_TOP_THRESHOLD
    updatePinned(atBottom)

    if (log.scrollTop <= GUI_TRANSCRIPT_TOP_THRESHOLD) loadMore()
  }, [loadMore, logRef, updatePinned])

  const range = useMemo(
    () => guiTranscriptWindowRange(items.length, windowStart),
    [items.length, windowStart]
  )
  const visibleItems = useMemo(
    () => items.slice(range.start, range.end),
    [items, range.end, range.start]
  )

  // A replay can arrive after the first empty render. Keep the initial window
  // at the latest 100 and follow the end while new live items are appended.
  useLayoutEffect(() => {
    const total = items.length
    const previousTotal = previousItemCountRef.current
    const currentStart = Math.min(total, windowStartRef.current)
    const firstItemId = items[0]?.id
    const firstLoad = !initializedRef.current && total > 0

    if (total === 0) {
      initializedRef.current = false
      pendingAnchorRef.current = null
      loadingMoreRef.current = false
      updateWindowStart(0)
    } else if (firstLoad) {
      initializedRef.current = true
      updateWindowStart(guiTranscriptInitialStart(total))
      startInitialPinning()
    } else if (total > previousTotal) {
      const previousLatestStart = guiTranscriptInitialStart(previousTotal)
      if (pinnedRef.current && currentStart >= previousLatestStart) {
        updateWindowStart(guiTranscriptInitialStart(total))
      }
    } else if (total === previousTotal && firstItemId !== previousFirstItemIdRef.current) {
      // The store's ring may replace its oldest item without changing length.
      // When pinned, retain the latest window instead of exposing a stale gap.
      if (pinnedRef.current) updateWindowStart(guiTranscriptInitialStart(total))
    }

    previousItemCountRef.current = total
    previousFirstItemIdRef.current = firstItemId
  }, [items, pinnedRef, startInitialPinning, updateWindowStart])

  // The layout effect runs after a prepend has entered the DOM. Restoring in
  // the same paint prevents the browser from exposing the jump to the user.
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    if (!anchor || anchor.targetStart !== windowStartRef.current) return
    const log = logRef.current
    pendingAnchorRef.current = null
    loadingMoreRef.current = false
    if (!log) return

    restoringScrollRef.current = true
    log.scrollTop = guiTranscriptAnchoredScrollTop(
      anchor.previousScrollTop,
      anchor.previousScrollHeight,
      log.scrollHeight
    )
    const unlock = (): void => {
      restoringScrollRef.current = false
    }
    if (requestFrame(() => unlock()) === null) unlock()
  }, [logRef, windowStart])

  // Appending a stream/tool while pinned must remain attached to the end. A
  // prepend is the one exception: its anchor effect above owns scrollTop.
  useLayoutEffect(() => {
    if (pendingAnchorRef.current || !pinnedRef.current) return
    scrollToEnd()
  }, [items, scrollToEnd, windowStart, pinnedRef])

  useEffect(
    () => () => {
      cancelFrame(initialPinFrameRef.current)
      initialPinFrameRef.current = null
    },
    []
  )

  return {
    visibleItems,
    totalItems: range.total,
    hiddenBefore: range.hiddenBefore,
    hasMoreBefore: range.hiddenBefore > 0,
    loadMore,
    loadAll,
    onScroll,
    goToEnd,
    keepPinnedToEnd
  }
}

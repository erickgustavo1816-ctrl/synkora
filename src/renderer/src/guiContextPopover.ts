interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Position the context dialog inside the visible chat, independently of the
 * compact composer's trigger position. Coordinates are viewport-relative. */
export function guiContextPopoverLayout(
  anchor: Box,
  pane: Box,
  viewport: { width: number; height: number },
  contentHeight: number
): { left: number; top: number; width: number; maxHeight: number } {
  const margin = 8, gap = 9
  const leftEdge = Math.max(0, pane.left) + margin
  const rightEdge = Math.min(viewport.width, pane.right) - margin
  const topEdge = Math.max(0, pane.top) + margin
  const bottomEdge = Math.min(viewport.height, pane.bottom) - margin
  const width = Math.max(0, Math.min(272, rightEdge - leftEdge))
  const above = Math.max(0, Math.min(anchor.top - gap, bottomEdge) - topEdge)
  const below = Math.max(0, bottomEdge - Math.max(anchor.bottom + gap, topEdge))
  const placeAbove = contentHeight <= above || above >= below
  const maxHeight = placeAbove ? above : below
  return {
    left: Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width)),
    top: placeAbove
      ? Math.max(topEdge, Math.min(anchor.top - gap, bottomEdge) - Math.min(contentHeight, maxHeight))
      : Math.max(topEdge, anchor.bottom + gap),
    width,
    maxHeight
  }
}

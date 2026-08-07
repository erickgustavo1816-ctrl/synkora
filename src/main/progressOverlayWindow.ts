export const PROGRESS_OVERLAY_DEFAULT_WIDTH = 456
export const PROGRESS_OVERLAY_DEFAULT_HEIGHT = 620
export const PROGRESS_OVERLAY_COMPACT_HEIGHT = 84
export const PROGRESS_OVERLAY_MIN_WIDTH = 360
export const PROGRESS_OVERLAY_MIN_HEIGHT = 280
export const PROGRESS_OVERLAY_EDGE_MARGIN = 18

export interface ProgressOverlayExpandedSize {
  width: number
  height: number
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max))
}

/** Mantem o tamanho salvo utilizavel no monitor atual sem voltar a uma caixa fixa. */
export function progressOverlayExpandedSize(
  width: number | undefined,
  height: number | undefined,
  workAreaWidth: number,
  workAreaHeight: number
): ProgressOverlayExpandedSize {
  const maxWidth = Math.floor(workAreaWidth - PROGRESS_OVERLAY_EDGE_MARGIN * 2)
  const maxHeight = Math.floor(workAreaHeight - PROGRESS_OVERLAY_EDGE_MARGIN * 2)
  return {
    width: clamp(
      finiteOr(width, PROGRESS_OVERLAY_DEFAULT_WIDTH),
      PROGRESS_OVERLAY_MIN_WIDTH,
      maxWidth
    ),
    height: clamp(
      finiteOr(height, PROGRESS_OVERLAY_DEFAULT_HEIGHT),
      PROGRESS_OVERLAY_MIN_HEIGHT,
      maxHeight
    )
  }
}

export function progressOverlayMaximumSize(
  workAreaWidth: number,
  workAreaHeight: number
): ProgressOverlayExpandedSize {
  return progressOverlayExpandedSize(
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    workAreaWidth,
    workAreaHeight
  )
}

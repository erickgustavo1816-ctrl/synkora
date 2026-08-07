// Mini do SynVoice: TAMANHO FIXO (decisão do usuário, 2026-08-03 — "não quero
// poder redimensionar o destaque de microfone"; largura reduzida ~10px na
// mesma decisão). O tamanho salvo em disco por versões antigas é ignorado.
export const SYNVOICE_OVERLAY_WIDTH = 255
export const SYNVOICE_OVERLAY_HEIGHT = 72
export const SYNVOICE_OVERLAY_HISTORY_HEIGHT = 264
export const SYNVOICE_OVERLAY_EDGE_MARGIN = 18

export interface SynVoiceOverlaySize {
  width: number
  height: number
}

export function synVoiceOverlaySize(): SynVoiceOverlaySize {
  return { width: SYNVOICE_OVERLAY_WIDTH, height: SYNVOICE_OVERLAY_HEIGHT }
}

export interface SynVoiceOverlayArea {
  x: number
  y: number
  width: number
  height: number
}

export interface SynVoiceOverlayHistoryPlacement {
  x: number
  y: number
  offsetY: number
}

/**
 * Mantém a posição compacta como âncora quando o histórico precisa crescer
 * para cima perto do rodapé. O offset permite restaurar a âncora após arraste.
 */
export function synVoiceOverlayHistoryPlacement(
  x: number,
  y: number,
  area: SynVoiceOverlayArea
): SynVoiceOverlayHistoryPlacement {
  const maxY = area.y + area.height
  const expandedY = y + SYNVOICE_OVERLAY_HISTORY_HEIGHT > maxY
    ? Math.max(area.y, maxY - SYNVOICE_OVERLAY_HISTORY_HEIGHT)
    : y
  return { x, y: expandedY, offsetY: expandedY - y }
}

export function synVoiceOverlayCompactPosition(
  x: number,
  y: number,
  historyOffsetY: number
): { x: number; y: number } {
  return { x, y: y - historyOffsetY }
}

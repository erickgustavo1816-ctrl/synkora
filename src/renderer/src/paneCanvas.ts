import type { DockLayout } from './paneDock'

export type CanvasPreset = 'auto' | 'sidebar' | 'focus' | 'grid' | 'columns' | 'rows'

/** Uma pagina do canvas possui membership, ordem e docking independentes. */
export interface CanvasPageLayout {
  /** Identidade persistente. O rotulo "Pagina N" vem do indice, nao deste id. */
  id: string
  /** IDs desta pagina, tambem na ordem visual/DFS preferida. */
  order: string[]
  /** Arvore binaria e proporcoes exclusivas desta pagina. */
  dock: DockLayout
}

export interface CanvasNodeLayout {
  preset: CanvasPreset
  order: string[]
  /** Pesos normalizados por grupo de trilhas. As chaves sao deterministicas
   *  para que o layout sobreviva a troca de aba e reinicio do app. */
  ratios: Record<string, number[]>
  /** Layout novo de docking direto. `preset`/`ratios` acima ficam apenas para
   *  ler preferências antigas sem quebrar o localStorage. */
  dock?: DockLayout
  /** Paginas do no. Ausente significa layout legado ainda nao migrado. */
  pages?: CanvasPageLayout[]
  /** Pagina lembrada por no; null quando o no nao possui panes. */
  activePageId?: string | null
  /** Sequencia monotona para criar ids sem renumerar paginas sobreviventes. */
  nextPageSeq?: number
}

export interface CanvasBox {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasDivider {
  id: string
  axis: 'x' | 'y'
  x: number
  y: number
  w: number
  h: number
  trackKey: string
  index: number
  trackCount: number
  available: number
  /** Tamanho real dos dois lados quando a geometria foi medida. Em uma arvore
   *  ele pode divergir do ratio salvo ao reparar um layout antigo invalido. */
  beforePixels?: number
  afterPixels?: number
  /** Minimos do conteudo de cada lado. Para uma subarvore estes valores ja
   *  incluem todas as folhas recursivamente, nao apenas um pane. */
  beforeMinPixels?: number
  afterMinPixels?: number
  /** Segmentos estruturais colineares que formam uma unica linha horizontal. */
  linkedDividers?: CanvasDivider[]
}

const finiteDividerMinimum = (value: number | undefined, fallback: number): number =>
  Math.max(24, Number.isFinite(value) ? (value as number) : fallback)

/**
 * Move uma emenda sem piorar um lado que ja chegou menor que o minimo
 * (layout antigo ou janela pequena). Quando ha espaco, os dois minimos sao
 * duros. Quando nao ha, ainda e possivel corrigir o lado deficitario.
 */
function movedBeforePixels(
  currentBefore: number,
  pairPixels: number,
  delta: number,
  beforeMinimum: number,
  afterMinimum: number,
  fallbackMinimum: number
): number {
  const current = Math.max(0, Math.min(pairPixels, currentBefore))
  const beforeMin = finiteDividerMinimum(beforeMinimum, fallbackMinimum)
  const afterMin = finiteDividerMinimum(afterMinimum, fallbackMinimum)
  const lower = beforeMin
  const upper = pairPixels - afterMin

  if (lower <= upper) {
    if (current < lower) {
      if (delta <= 0) return current
      return Math.min(upper, current + delta)
    }
    if (current > upper) {
      if (delta >= 0) return current
      return Math.max(lower, current + delta)
    }
    return Math.max(lower, Math.min(upper, current + delta))
  }

  const currentAfter = pairPixels - current
  const beforeOk = current >= beforeMin
  const afterOk = currentAfter >= afterMin
  if (beforeOk && !afterOk) {
    return delta < 0 ? Math.max(beforeMin, current + delta) : current
  }
  if (!beforeOk && afterOk) {
    return delta > 0 ? Math.min(pairPixels - afterMin, current + delta) : current
  }
  return current
}

/** Delta realmente permitido por uma costura ja medida. */
export function measuredCanvasDividerDelta(
  dividerSpec: CanvasDivider,
  deltaPixels: number,
  minPixels = 160
): number {
  if (dividerSpec.beforePixels === undefined || dividerSpec.afterPixels === undefined) {
    return deltaPixels
  }
  const pairPixels = dividerSpec.beforePixels + dividerSpec.afterPixels
  if (pairPixels <= 0) return 0
  return (
    movedBeforePixels(
      dividerSpec.beforePixels,
      pairPixels,
      deltaPixels,
      dividerSpec.beforeMinPixels ?? minPixels,
      dividerSpec.afterMinPixels ?? minPixels,
      minPixels
    ) - dividerSpec.beforePixels
  )
}

export interface CanvasGeometry {
  boxes: Record<string, CanvasBox>
  dividers: CanvasDivider[]
  resolvedPreset: Exclude<CanvasPreset, 'auto'>
}

// Os panes formam um mosaico continuo. A area de clique do divisor e maior que
// a linha visual e fica sobreposta a costura, portanto nao precisa abrir gap.
export const CANVAS_GAP = 0
export const CANVAS_DIVIDER_HIT = 10

export const DEFAULT_CANVAS_LAYOUT: CanvasNodeLayout = {
  preset: 'auto',
  order: [],
  ratios: {}
}

export function normalizeCanvasOrder(ids: string[], saved: string[]): string[] {
  const alive = new Set(ids)
  const ordered = saved.filter((id, index) => alive.has(id) && saved.indexOf(id) === index)
  for (const id of ids) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  return ordered
}

function normalizedWeights(saved: number[] | undefined, count: number): number[] {
  if (count <= 0) return []
  const valid =
    saved?.length === count && saved.every((value) => Number.isFinite(value) && value > 0)
      ? saved
      : undefined
  const weights = valid ? [...valid] : Array.from({ length: count }, () => 1 / count)
  const sum = weights.reduce((total, value) => total + value, 0)
  if (!Number.isFinite(sum) || sum <= 0) return Array.from({ length: count }, () => 1 / count)
  return weights.map((value) => value / sum)
}

interface Track {
  start: number
  size: number
}

function tracks(total: number, count: number, gap: number, weights: number[]): Track[] {
  if (count <= 0) return []
  const safeTotal = Math.max(0, total)
  const available = Math.max(0, safeTotal - gap * (count - 1))
  const out: Track[] = []
  let cursor = 0
  for (let index = 0; index < count; index++) {
    const size = index === count - 1 ? Math.max(0, safeTotal - cursor) : available * weights[index]
    out.push({ start: cursor, size })
    cursor += size + gap
  }
  return out
}

function divider(
  axis: 'x' | 'y',
  key: string,
  index: number,
  count: number,
  available: number,
  before: Track,
  x: number,
  y: number,
  crossSize: number,
  gap: number
): CanvasDivider {
  const hit = Math.max(CANVAS_DIVIDER_HIT, gap)
  const seam = axis === 'x' ? x + before.start + before.size : y + before.start + before.size
  return axis === 'x'
    ? {
        id: `${key}:${index}`,
        axis,
        x: seam - hit / 2,
        y,
        w: hit,
        h: crossSize,
        trackKey: key,
        index,
        trackCount: count,
        available
      }
    : {
        id: `${key}:${index}`,
        axis,
        x,
        y: seam - hit / 2,
        w: crossSize,
        h: hit,
        trackKey: key,
        index,
        trackCount: count,
        available
      }
}

function resolvedPreset(
  requested: CanvasPreset,
  count: number,
  width: number,
  height: number
): Exclude<CanvasPreset, 'auto'> {
  if (requested !== 'auto') return requested
  if (count <= 1) return 'grid'
  if (count === 2) return width >= height * 1.15 ? 'columns' : 'rows'
  if (count <= 4) return width >= height * 1.05 ? 'sidebar' : 'focus'
  return 'grid'
}

/**
 * Calcula caixas absolutas para uma lista PLANA de panes. O React nunca move um
 * TerminalPane de pai: trocar preset ou arrastar um divisor altera apenas
 * left/top/width/height, portanto o PTY e o xterm continuam vivos.
 */
export function canvasGeometry(
  ids: string[],
  width: number,
  height: number,
  layout: CanvasNodeLayout,
  gap = CANVAS_GAP
): CanvasGeometry {
  const order = normalizeCanvasOrder(ids, layout.order)
  const boxes: Record<string, CanvasBox> = {}
  const dividers: CanvasDivider[] = []
  const preset = resolvedPreset(layout.preset, order.length, width, height)
  if (!order.length || width <= 0 || height <= 0) return { boxes, dividers, resolvedPreset: preset }

  if (preset === 'columns' || preset === 'rows') {
    const axis = preset === 'columns' ? 'x' : 'y'
    const key = `${preset}:main:${order.length}`
    const total = axis === 'x' ? width : height
    const available = Math.max(0, total - gap * (order.length - 1))
    const weights = normalizedWeights(layout.ratios[key], order.length)
    const mainTracks = tracks(total, order.length, gap, weights)
    order.forEach((id, index) => {
      const track = mainTracks[index]
      boxes[id] =
        axis === 'x'
          ? { x: track.start, y: 0, w: track.size, h: height }
          : { x: 0, y: track.start, w: width, h: track.size }
      if (index < mainTracks.length - 1) {
        dividers.push(
          divider(axis, key, index, order.length, available, track, 0, 0, axis === 'x' ? height : width, gap)
        )
      }
    })
    return { boxes, dividers, resolvedPreset: preset }
  }

  // Um pane principal ocupa toda a altura; os demais viram uma pilha na
  // lateral. O deck continua plano no DOM, entao trocar o principal com a seta
  // nao remonta nem reinicia nenhum terminal.
  if (preset === 'sidebar' && order.length > 1) {
    const colKey = `sidebar:cols:${order.length}`
    const colAvailable = Math.max(0, width - gap)
    const colWeights = normalizedWeights(layout.ratios[colKey] ?? [0.62, 0.38], 2)
    const colTracks = tracks(width, 2, gap, colWeights)
    const primary = colTracks[0]
    const side = colTracks[1]

    boxes[order[0]] = { x: primary.start, y: 0, w: primary.size, h: height }
    dividers.push(divider('x', colKey, 0, 2, colAvailable, primary, 0, 0, height, gap))

    const sideIds = order.slice(1)
    const rowKey = `sidebar:side:${sideIds.length}`
    const rowAvailable = Math.max(0, height - gap * (sideIds.length - 1))
    const rowWeights = normalizedWeights(layout.ratios[rowKey], sideIds.length)
    const rowTracks = tracks(height, sideIds.length, gap, rowWeights)
    sideIds.forEach((id, index) => {
      const row = rowTracks[index]
      boxes[id] = { x: side.start, y: row.start, w: side.size, h: row.size }
      if (index < rowTracks.length - 1) {
        dividers.push(
          divider(
            'y',
            rowKey,
            index,
            sideIds.length,
            rowAvailable,
            row,
            side.start,
            0,
            side.size,
            gap
          )
        )
      }
    })
    return { boxes, dividers, resolvedPreset: preset }
  }

  if (preset === 'focus' && order.length > 1) {
    const rowKey = `focus:rows:${order.length}`
    const rowAvailable = Math.max(0, height - gap)
    const rowWeights = normalizedWeights(layout.ratios[rowKey], 2)
    const rowTracks = tracks(height, 2, gap, rowWeights)
    boxes[order[0]] = { x: 0, y: rowTracks[0].start, w: width, h: rowTracks[0].size }
    dividers.push(divider('y', rowKey, 0, 2, rowAvailable, rowTracks[0], 0, 0, width, gap))

    const bottom = order.slice(1)
    const colKey = `focus:bottom:${bottom.length}`
    const colAvailable = Math.max(0, width - gap * (bottom.length - 1))
    const colWeights = normalizedWeights(layout.ratios[colKey], bottom.length)
    const colTracks = tracks(width, bottom.length, gap, colWeights)
    bottom.forEach((id, index) => {
      const track = colTracks[index]
      boxes[id] = {
        x: track.start,
        y: rowTracks[1].start,
        w: track.size,
        h: rowTracks[1].size
      }
      if (index < colTracks.length - 1) {
        dividers.push(
          divider(
            'x',
            colKey,
            index,
            bottom.length,
            colAvailable,
            track,
            0,
            rowTracks[1].start,
            rowTracks[1].size,
            gap
          )
        )
      }
    })
    return { boxes, dividers, resolvedPreset: preset }
  }

  // GRID: cada linha distribui apenas os panes que realmente possui. Assim uma
  // grade de 5 vira 3+2, sem deixar uma celula vazia espremendo a ultima linha.
  const aspect = Math.max(0.5, Math.min(2.5, width / Math.max(1, height)))
  const columns = Math.max(1, Math.min(order.length, Math.ceil(Math.sqrt(order.length * aspect))))
  const rowsCount = Math.ceil(order.length / columns)
  const rowKey = `grid:rows:${rowsCount}`
  const rowAvailable = Math.max(0, height - gap * (rowsCount - 1))
  const rowWeights = normalizedWeights(layout.ratios[rowKey], rowsCount)
  const rowTracks = tracks(height, rowsCount, gap, rowWeights)
  rowTracks.forEach((row, rowIndex) => {
    const rowIds = order.slice(rowIndex * columns, Math.min(order.length, (rowIndex + 1) * columns))
    const colKey = `grid:cols:${rowsCount}:${rowIndex}:${rowIds.length}`
    const colAvailable = Math.max(0, width - gap * (rowIds.length - 1))
    const colWeights = normalizedWeights(layout.ratios[colKey], rowIds.length)
    const colTracks = tracks(width, rowIds.length, gap, colWeights)
    rowIds.forEach((id, colIndex) => {
      const col = colTracks[colIndex]
      boxes[id] = { x: col.start, y: row.start, w: col.size, h: row.size }
      if (colIndex < colTracks.length - 1) {
        dividers.push(
          divider('x', colKey, colIndex, rowIds.length, colAvailable, col, 0, row.start, row.size, gap)
        )
      }
    })
    if (rowIndex < rowTracks.length - 1) {
      dividers.push(divider('y', rowKey, rowIndex, rowsCount, rowAvailable, row, 0, 0, width, gap))
    }
  })

  return {
    boxes,
    dividers,
    resolvedPreset: preset === 'focus' || preset === 'sidebar' ? 'grid' : preset
  }
}

/** Ajusta somente as duas trilhas vizinhas ao divisor. O restante do canvas nao
 *  se move, comportamento de split pane de IDE. */
export function resizeCanvasDivider(
  ratios: Record<string, number[]>,
  dividerSpec: CanvasDivider,
  deltaPixels: number,
  minPixels = 160
): Record<string, number[]> {
  const count = dividerSpec.trackCount
  const current = normalizedWeights(ratios[dividerSpec.trackKey], count)
  const available = dividerSpec.available
  if (available <= 0 || dividerSpec.index < 0 || dividerSpec.index >= count - 1) return ratios

  const leftIndex = dividerSpec.index
  const rightIndex = leftIndex + 1
  const pair = current[leftIndex] + current[rightIndex]
  const pairPixels = pair * available
  const leftPixels = dividerSpec.beforePixels ?? current[leftIndex] * available
  const nextLeftPixels = movedBeforePixels(
    leftPixels,
    pairPixels,
    deltaPixels,
    dividerSpec.beforeMinPixels ?? minPixels,
    dividerSpec.afterMinPixels ?? minPixels,
    minPixels
  )
  if (nextLeftPixels === leftPixels) return ratios
  const next = [...current]
  next[leftIndex] = nextLeftPixels / available
  next[rightIndex] = pair - next[leftIndex]
  return { ...ratios, [dividerSpec.trackKey]: next }
}

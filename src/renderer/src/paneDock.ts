import {
  measuredCanvasDividerDelta,
  resizeCanvasDivider,
  type CanvasBox,
  type CanvasDivider
} from './paneCanvas'

export type DockAxis = 'x' | 'y'
export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type DockEdge = Exclude<DockZone, 'center'>
export type DockPlacement = 'start' | 'end'

export interface DockLeaf {
  type: 'leaf'
  paneId: string
}

export interface DockSplit {
  type: 'split'
  /**
   * Identificador persistente do divisor. Tambem e usado como trackKey pelo
   * resizeCanvasDivider, portanto nao depende da posicao atual no canvas.
   */
  id: string
  /** x divide em colunas; y divide em linhas. */
  axis: DockAxis
  first: DockNode
  second: DockNode
}

export type DockNode = DockLeaf | DockSplit

/**
 * Apenas objetos, arrays, numeros e strings: pode ser salvo diretamente em
 * localStorage/JSON. As proporcoes ficam fora da arvore para continuarem
 * compativeis com resizeCanvasDivider.
 */
export interface DockLayout {
  version: 1
  root: DockNode | null
  ratios: Record<string, number[]>
}

export interface DockGeometry {
  boxes: Record<string, CanvasBox>
  dividers: CanvasDivider[]
}

export interface DockMinimumSize {
  w: number
  h: number
}

interface WeightedNode {
  node: DockNode
  weight: number
}

interface LeafCandidate {
  paneId: string
  box: CanvasBox
}

export const DOCK_LAYOUT_VERSION = 1 as const
export const DOCK_DIVIDER_HIT = 10
export const DEFAULT_DOCK_RATIO = 0.5
export const DOCK_MIN_WIDTH = 220
export const DOCK_MIN_HEIGHT = 210

const MIN_DOCK_WEIGHT = 0.02
const DEFAULT_WIDTH = 1600
const DEFAULT_HEIGHT = 900
const LOCAL_RATIO_PREFIX = 'dock-local:'
const GEOMETRY_EPSILON = 0.75

export const EMPTY_DOCK_LAYOUT: DockLayout = {
  version: DOCK_LAYOUT_VERSION,
  root: null,
  ratios: {}
}

function leaf(paneId: string): DockLeaf {
  return { type: 'leaf', paneId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniquePaneIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function finiteSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function clampRatio(value: number): number {
  return Math.max(MIN_DOCK_WEIGHT, Math.min(1 - MIN_DOCK_WEIGHT, value))
}

function nodeMinimumSize(
  node: DockNode,
  leafWidth = DOCK_MIN_WIDTH,
  leafHeight = DOCK_MIN_HEIGHT
): DockMinimumSize {
  if (node.type === 'leaf') return { w: leafWidth, h: leafHeight }
  const first = nodeMinimumSize(node.first, leafWidth, leafHeight)
  const second = nodeMinimumSize(node.second, leafWidth, leafHeight)
  return node.axis === 'x'
    ? { w: first.w + second.w, h: Math.max(first.h, second.h) }
    : { w: Math.max(first.w, second.w), h: first.h + second.h }
}

/** Minimo recursivo da topologia: x soma colunas, y soma linhas. */
export function dockMinimumSize(
  layout: DockLayout,
  leafWidth = DOCK_MIN_WIDTH,
  leafHeight = DOCK_MIN_HEIGHT
): DockMinimumSize {
  return layout.root ? nodeMinimumSize(layout.root, leafWidth, leafHeight) : { w: 0, h: 0 }
}

function normalizedPair(value: unknown, fallback = DEFAULT_DOCK_RATIO): [number, number] {
  if (Array.isArray(value) && value.length === 2) {
    const first = Number(value[0])
    const second = Number(value[1])
    const sum = first + second
    if (Number.isFinite(first) && Number.isFinite(second) && first > 0 && second > 0 && sum > 0) {
      const ratio = clampRatio(first / sum)
      return [ratio, 1 - ratio]
    }
  }
  const ratio = clampRatio(Number.isFinite(fallback) ? fallback : DEFAULT_DOCK_RATIO)
  return [ratio, 1 - ratio]
}

/** Hash deterministico pequeno; nao e usado para seguranca. */
function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function nodeSignature(node: DockNode): string {
  if (node.type === 'leaf') return `l${node.paneId.length}:${node.paneId}`
  return `s${node.axis}(${nodeSignature(node.first)})(${nodeSignature(node.second)})`
}

function deterministicSplitId(
  axis: DockAxis,
  first: DockNode,
  second: DockNode,
  used: Set<string>,
  preferred?: string
): string {
  if (preferred && !used.has(preferred)) {
    used.add(preferred)
    return preferred
  }

  const base = `dock:${axis}:${stableHash(`${nodeSignature(first)}|${nodeSignature(second)}`)}`
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}:${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

function collectSplitIds(node: DockNode | null, into = new Set<string>()): Set<string> {
  if (!node || node.type === 'leaf') return into
  into.add(node.id)
  collectSplitIds(node.first, into)
  collectSplitIds(node.second, into)
  return into
}

function collectPaneIds(node: DockNode | null, into: string[] = []): string[] {
  if (!node) return into
  if (node.type === 'leaf') {
    into.push(node.paneId)
    return into
  }
  collectPaneIds(node.first, into)
  collectPaneIds(node.second, into)
  return into
}

function parseLocalRatioKey(
  key: string
): { axis: DockAxis; beforePaneId: string; afterPaneId: string } | null {
  if (!key.startsWith(LOCAL_RATIO_PREFIX)) return null
  const parts = key.slice(LOCAL_RATIO_PREFIX.length).split('|')
  if (parts.length !== 3 || (parts[0] !== 'x' && parts[0] !== 'y')) return null
  try {
    const beforePaneId = decodeURIComponent(parts[1])
    const afterPaneId = decodeURIComponent(parts[2])
    if (!beforePaneId || !afterPaneId || beforePaneId === afterPaneId) return null
    return { axis: parts[0], beforePaneId, afterPaneId }
  } catch {
    return null
  }
}

function withoutLocalRatios(ratios: Record<string, number[]>): Record<string, number[]> {
  return Object.fromEntries(Object.entries(ratios).filter(([key]) => !parseLocalRatioKey(key)))
}

function sourceRoot(saved: unknown): unknown {
  if (isRecord(saved) && 'root' in saved) return saved.root
  return saved
}

function sourceRatios(saved: unknown): Record<string, unknown> {
  if (!isRecord(saved) || !isRecord(saved.ratios)) return {}
  return saved.ratios
}

function finishLayout(
  root: DockNode | null,
  source: Record<string, unknown> | Record<string, number[]>
): DockLayout {
  if (!root) return { version: DOCK_LAYOUT_VERSION, root: null, ratios: {} }
  const ratios: Record<string, number[]> = {}
  for (const id of collectSplitIds(root)) ratios[id] = normalizedPair(source[id])
  return { version: DOCK_LAYOUT_VERSION, root, ratios }
}

function buildWeighted(
  values: WeightedNode[],
  axis: DockAxis,
  used: Set<string>,
  ratios: Record<string, number[]>
): WeightedNode {
  if (values.length === 1) return values[0]

  const middle = Math.ceil(values.length / 2)
  const first = buildWeighted(values.slice(0, middle), axis, used, ratios)
  const second = buildWeighted(values.slice(middle), axis, used, ratios)
  const total = first.weight + second.weight
  const ratio = total > 0 ? first.weight / total : DEFAULT_DOCK_RATIO
  const id = deterministicSplitId(axis, first.node, second.node, used)
  ratios[id] = normalizedPair(undefined, ratio)
  return {
    node: { type: 'split', id, axis, first: first.node, second: second.node },
    weight: total
  }
}

/**
 * Cria uma grade binaria balanceada. A quantidade de colunas acompanha o
 * aspecto disponivel; a ultima linha usa toda a largura, sem celulas vazias.
 */
export function balancedDockLayout(
  ids: readonly string[],
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT
): DockLayout {
  const panes = uniquePaneIds(ids)
  if (!panes.length) return { version: DOCK_LAYOUT_VERSION, root: null, ratios: {} }
  if (panes.length === 1) {
    return { version: DOCK_LAYOUT_VERSION, root: leaf(panes[0]), ratios: {} }
  }

  const safeWidth = finiteSize(width, DEFAULT_WIDTH)
  const safeHeight = finiteSize(height, DEFAULT_HEIGHT)
  const aspect = Math.max(0.35, Math.min(3, safeWidth / safeHeight))
  const columns = Math.max(1, Math.min(panes.length, Math.ceil(Math.sqrt(panes.length * aspect))))
  const used = new Set<string>()
  const ratios: Record<string, number[]> = {}
  const rows: WeightedNode[] = []

  for (let index = 0; index < panes.length; index += columns) {
    const rowPanes = panes.slice(index, index + columns)
    const row = buildWeighted(
      rowPanes.map((paneId) => ({ node: leaf(paneId), weight: 1 })),
      'x',
      used,
      ratios
    )
    // Cada linha recebe a mesma altura, mesmo quando a ultima possui menos
    // panes. Dentro dela, os panes continuam com larguras iguais.
    rows.push({ node: row.node, weight: 1 })
  }

  const root = rows.length === 1 ? rows[0].node : buildWeighted(rows, 'y', used, ratios).node
  return { version: DOCK_LAYOUT_VERSION, root, ratios }
}

/** Alias explicito para a acao "reorganizar/balancear" da interface. */
export function resetDockLayout(
  ids: readonly string[],
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT
): DockLayout {
  return balancedDockLayout(ids, width, height)
}

export const resetDockLayoutBalanced = resetDockLayout

function visitSavedNode(
  value: unknown,
  alive: Set<string>,
  seenPanes: Set<string>,
  usedSplits: Set<string>,
  depth: number,
  rootAxis: DockAxis
): DockNode | null {
  if (!isRecord(value)) return null

  if (value.type === 'leaf') {
    const paneId = value.paneId
    if (typeof paneId !== 'string' || !alive.has(paneId) || seenPanes.has(paneId)) return null
    seenPanes.add(paneId)
    return leaf(paneId)
  }

  if (value.type !== 'split') return null
  const first = visitSavedNode(value.first, alive, seenPanes, usedSplits, depth + 1, rootAxis)
  const second = visitSavedNode(value.second, alive, seenPanes, usedSplits, depth + 1, rootAxis)
  if (!first) return second
  if (!second) return first

  const fallbackAxis = depth % 2 === 0 ? rootAxis : rootAxis === 'x' ? 'y' : 'x'
  const axis: DockAxis = value.axis === 'x' || value.axis === 'y' ? value.axis : fallbackAxis
  const preferred = typeof value.id === 'string' && value.id ? value.id : undefined
  const id = deterministicSplitId(axis, first, second, usedSplits, preferred)
  return { type: 'split', id, axis, first, second }
}

function enumerateLeafBoxes(
  node: DockNode,
  box: CanvasBox,
  ratios: Record<string, number[]>,
  out: LeafCandidate[]
): void {
  if (node.type === 'leaf') {
    out.push({ paneId: node.paneId, box })
    return
  }

  const [firstWeight] = normalizedPair(ratios[node.id])
  if (node.axis === 'x') {
    const firstWidth = box.w * firstWeight
    enumerateLeafBoxes(node.first, { ...box, w: firstWidth }, ratios, out)
    enumerateLeafBoxes(
      node.second,
      { x: box.x + firstWidth, y: box.y, w: Math.max(0, box.w - firstWidth), h: box.h },
      ratios,
      out
    )
  } else {
    const firstHeight = box.h * firstWeight
    enumerateLeafBoxes(node.first, { ...box, h: firstHeight }, ratios, out)
    enumerateLeafBoxes(
      node.second,
      { x: box.x, y: box.y + firstHeight, w: box.w, h: Math.max(0, box.h - firstHeight) },
      ratios,
      out
    )
  }
}

function replaceLeaf(node: DockNode, paneId: string, replacement: DockNode): DockNode {
  if (node.type === 'leaf') return node.paneId === paneId ? replacement : node
  const first = replaceLeaf(node.first, paneId, replacement)
  const second = replaceLeaf(node.second, paneId, replacement)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

function appendPaneBalanced(
  layout: DockLayout,
  paneId: string,
  width: number,
  height: number
): DockLayout {
  if (!layout.root) {
    return { version: DOCK_LAYOUT_VERSION, root: leaf(paneId), ratios: {} }
  }

  const candidates: LeafCandidate[] = []
  enumerateLeafBoxes(
    layout.root,
    { x: 0, y: 0, w: finiteSize(width, DEFAULT_WIDTH), h: finiteSize(height, DEFAULT_HEIGHT) },
    layout.ratios,
    candidates
  )
  // Maior area primeiro. Empates preservam a ordem DFS da arvore.
  let target = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (candidate.box.w * candidate.box.h > target.box.w * target.box.h) target = candidate
  }

  const axis: DockAxis = target.box.w >= target.box.h ? 'x' : 'y'
  const existing = leaf(target.paneId)
  const incoming = leaf(paneId)
  const used = collectSplitIds(layout.root)
  const id = deterministicSplitId(axis, existing, incoming, used)
  const split: DockSplit = { type: 'split', id, axis, first: existing, second: incoming }
  const root = replaceLeaf(layout.root, target.paneId, split)
  return finishLayout(root, { ...layout.ratios, [id]: normalizedPair(undefined) })
}

/**
 * Repara um layout vindo de JSON: remove panes mortos e duplicados, corrige
 * splits invalidos/duplicados e insere os IDs vivos que ainda nao estavam na
 * arvore. O percurso e deterministico e nunca produz duas folhas iguais.
 *
 * `saved` pode ser tanto DockLayout quanto apenas DockNode (ou JSON desconhecido).
 */
export function normalizeDockLayout(
  ids: readonly string[],
  saved: unknown,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT
): DockLayout {
  const panes = uniquePaneIds(ids)
  if (!panes.length) return { version: DOCK_LAYOUT_VERSION, root: null, ratios: {} }

  const alive = new Set(panes)
  const seenPanes = new Set<string>()
  const usedSplits = new Set<string>()
  const safeWidth = finiteSize(width, DEFAULT_WIDTH)
  const safeHeight = finiteSize(height, DEFAULT_HEIGHT)
  const rootAxis: DockAxis = safeWidth >= safeHeight ? 'x' : 'y'
  const root = visitSavedNode(sourceRoot(saved), alive, seenPanes, usedSplits, 0, rootAxis)

  let layout = finishLayout(root, sourceRatios(saved))
  if (!layout.root) return balancedDockLayout(panes, safeWidth, safeHeight)

  for (const paneId of panes) {
    if (!seenPanes.has(paneId)) layout = appendPaneBalanced(layout, paneId, safeWidth, safeHeight)
  }
  return layout
}

function axisMinimum(
  node: DockNode,
  axis: DockAxis,
  leafWidth: number,
  leafHeight: number
): number {
  const minimum = nodeMinimumSize(node, leafWidth, leafHeight)
  return axis === 'x' ? minimum.w : minimum.h
}

function splitPixels(
  node: DockSplit,
  total: number,
  firstWeight: number,
  leafWidth: number,
  leafHeight: number
): number {
  if (total <= 0) return 0
  const firstMinimum = axisMinimum(node.first, node.axis, leafWidth, leafHeight)
  const secondMinimum = axisMinimum(node.second, node.axis, leafWidth, leafHeight)
  const desired = total * firstWeight
  if (total >= firstMinimum + secondMinimum) {
    return Math.max(firstMinimum, Math.min(total - secondMinimum, desired))
  }

  // Nao existe solucao que entregue o minimo a todas as folhas. Distribuir a
  // falta na mesma proporcao dos minimos impede uma subarvore de sumir inteira.
  const minimumTotal = firstMinimum + secondMinimum
  return minimumTotal > 0 ? total * (firstMinimum / minimumTotal) : desired
}

function dividerForSplit(
  node: DockSplit,
  box: CanvasBox,
  seam: number,
  leafWidth: number,
  leafHeight: number
): CanvasDivider {
  const total = node.axis === 'x' ? box.w : box.h
  const hit = Math.max(0, Math.min(DOCK_DIVIDER_HIT, total))
  const start = node.axis === 'x' ? box.x : box.y
  const beforePixels = Math.max(0, Math.min(total, seam - start))
  const afterPixels = Math.max(0, total - beforePixels)
  const beforeMinPixels = axisMinimum(node.first, node.axis, leafWidth, leafHeight)
  const afterMinPixels = axisMinimum(node.second, node.axis, leafWidth, leafHeight)
  if (node.axis === 'x') {
    const x = Math.max(box.x, Math.min(box.x + box.w - hit, seam - hit / 2))
    return {
      id: `${node.id}:0`,
      axis: 'x',
      x,
      y: box.y,
      w: hit,
      h: box.h,
      trackKey: node.id,
      index: 0,
      trackCount: 2,
      available: box.w,
      beforePixels,
      afterPixels,
      beforeMinPixels,
      afterMinPixels
    }
  }

  const y = Math.max(box.y, Math.min(box.y + box.h - hit, seam - hit / 2))
  return {
    id: `${node.id}:0`,
    axis: 'y',
    x: box.x,
    y,
    w: box.w,
    h: hit,
    trackKey: node.id,
    index: 0,
    trackCount: 2,
    available: box.h,
    beforePixels,
    afterPixels,
    beforeMinPixels,
    afterMinPixels
  }
}

function layoutNode(
  node: DockNode,
  box: CanvasBox,
  ratios: Record<string, number[]>,
  geometry: DockGeometry,
  leafWidth: number,
  leafHeight: number
): void {
  if (node.type === 'leaf') {
    geometry.boxes[node.paneId] = box
    return
  }

  const [firstWeight] = normalizedPair(ratios[node.id])
  if (node.axis === 'x') {
    const firstWidth = splitPixels(node, box.w, firstWeight, leafWidth, leafHeight)
    const seam = box.x + firstWidth
    layoutNode(node.first, { ...box, w: firstWidth }, ratios, geometry, leafWidth, leafHeight)
    layoutNode(
      node.second,
      { x: seam, y: box.y, w: Math.max(0, box.w - firstWidth), h: box.h },
      ratios,
      geometry,
      leafWidth,
      leafHeight
    )
    geometry.dividers.push(dividerForSplit(node, box, seam, leafWidth, leafHeight))
  } else {
    const firstHeight = splitPixels(node, box.h, firstWeight, leafWidth, leafHeight)
    const seam = box.y + firstHeight
    layoutNode(node.first, { ...box, h: firstHeight }, ratios, geometry, leafWidth, leafHeight)
    layoutNode(
      node.second,
      { x: box.x, y: seam, w: box.w, h: Math.max(0, box.h - firstHeight) },
      ratios,
      geometry,
      leafWidth,
      leafHeight
    )
    geometry.dividers.push(dividerForSplit(node, box, seam, leafWidth, leafHeight))
  }
}

function mergeAlignedHorizontalDividers(dividers: CanvasDivider[]): CanvasDivider[] {
  const vertical = dividers.filter((item) => item.axis === 'x')
  const horizontal = dividers
    .filter((item) => item.axis === 'y')
    .sort((first, second) => {
      const seamDelta = first.y + first.h / 2 - (second.y + second.h / 2)
      return Math.abs(seamDelta) > GEOMETRY_EPSILON ? seamDelta : first.x - second.x
    })
  const merged: CanvasDivider[] = []

  let seamGroup: CanvasDivider[] = []
  const flushSeamGroup = (): void => {
    if (!seamGroup.length) return
    let component: CanvasDivider[] = []
    let componentEnd = Number.NEGATIVE_INFINITY
    const flushComponent = (): void => {
      if (!component.length) return
      if (component.length === 1) {
        merged.push(component[0])
      } else {
        const linkedDividers = component.flatMap((item) => item.linkedDividers ?? [item])
        const first = linkedDividers[0]
        const x = Math.min(...component.map((item) => item.x))
        const right = Math.max(...component.map((item) => item.x + item.w))
        const seam = component.reduce((total, item) => total + item.y + item.h / 2, 0) / component.length
        const hit = Math.max(...component.map((item) => item.h))
        merged.push({
          ...first,
          id: `dock:y-linked:${stableHash(linkedDividers.map((item) => item.id).join('|'))}`,
          x,
          y: seam - hit / 2,
          w: Math.max(0, right - x),
          h: hit,
          linkedDividers
        })
      }
      component = []
      componentEnd = Number.NEGATIVE_INFINITY
    }

    for (const item of seamGroup.sort((first, second) => first.x - second.x)) {
      if (component.length && item.x > componentEnd + GEOMETRY_EPSILON) flushComponent()
      component.push(item)
      componentEnd = Math.max(componentEnd, item.x + item.w)
    }
    flushComponent()
    seamGroup = []
  }

  for (const item of horizontal) {
    const itemSeam = item.y + item.h / 2
    const groupSeam = seamGroup.length ? seamGroup[0].y + seamGroup[0].h / 2 : itemSeam
    if (seamGroup.length && Math.abs(itemSeam - groupSeam) > GEOMETRY_EPSILON) flushSeamGroup()
    seamGroup.push(item)
  }
  flushSeamGroup()
  return [...vertical, ...merged]
}

function nodeBounds(node: DockNode, boxes: Record<string, CanvasBox>): CanvasBox | null {
  const ids = collectPaneIds(node)
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const id of ids) {
    const box = boxes[id]
    if (!box) continue
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.w)
    bottom = Math.max(bottom, box.y + box.h)
  }
  return Number.isFinite(left)
    ? { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
    : null
}

/**
 * Converte a arvore em caixas absolutas para um DOM plano. O gap e sempre zero
 * e a hitbox de 10 px fica contida na regiao do proprio split.
 */
export function dockGeometry(
  width: number,
  height: number,
  layout: DockLayout,
  leafWidth = DOCK_MIN_WIDTH,
  leafHeight = DOCK_MIN_HEIGHT
): DockGeometry {
  const geometry: DockGeometry = { boxes: {}, dividers: [] }
  if (!layout.root || width <= 0 || height <= 0) return geometry
  layoutNode(
    layout.root,
    { x: 0, y: 0, w: width, h: height },
    layout.ratios,
    geometry,
    leafWidth,
    leafHeight
  )
  // Segmentos horizontais adjacentes na mesma altura sao uma unica linha de
  // grade: um hover, uma alca e um movimento coordenado.
  geometry.dividers = mergeAlignedHorizontalDividers(geometry.dividers)
  return geometry
}

function containsHorizontalSlice(box: CanvasBox | null, y: number): boolean {
  return Boolean(box && y > box.y + GEOMETRY_EPSILON && y < box.y + box.h - GEOMETRY_EPSILON)
}

function writeSliceRatios(
  node: DockNode,
  y: number,
  desiredWidths: Map<string, number>,
  boxes: Record<string, CanvasBox>,
  ratios: Record<string, number[]>
): number {
  const bounds = nodeBounds(node, boxes)
  if (!bounds) return 0
  if (node.type === 'leaf') return desiredWidths.get(node.paneId) ?? bounds.w

  const firstBounds = nodeBounds(node.first, boxes)
  const secondBounds = nodeBounds(node.second, boxes)
  if (node.axis === 'y') {
    if (containsHorizontalSlice(firstBounds, y)) {
      return writeSliceRatios(node.first, y, desiredWidths, boxes, ratios)
    }
    if (containsHorizontalSlice(secondBounds, y)) {
      return writeSliceRatios(node.second, y, desiredWidths, boxes, ratios)
    }
    return bounds.w
  }

  if (!containsHorizontalSlice(firstBounds, y) || !containsHorizontalSlice(secondBounds, y)) {
    return bounds.w
  }
  const firstWidth = writeSliceRatios(node.first, y, desiredWidths, boxes, ratios)
  const secondWidth = writeSliceRatios(node.second, y, desiredWidths, boxes, ratios)
  const total = firstWidth + secondWidth
  if (total > 0) ratios[node.id] = normalizedPair(undefined, firstWidth / total)
  return total
}

/**
 * Redimensionamento horizontal em cadeia. Se o vizinho imediato ja chegou ao
 * minimo, a costura continua empurrando as colunas anteriores/seguintes da
 * mesma faixa. O resultado independe de como a arvore binaria foi aninhada.
 */
function resizeColumnSeam(
  layout: DockLayout,
  dividerSpec: CanvasDivider,
  deltaPixels: number,
  width: number,
  height: number,
  leafWidth: number,
  leafHeight: number
): DockLayout | null {
  if (!layout.root || dividerSpec.axis !== 'x') return null
  const safeWidth = finiteSize(width, DEFAULT_WIDTH)
  const safeHeight = finiteSize(height, DEFAULT_HEIGHT)
  const geometry = dockGeometry(safeWidth, safeHeight, layout, leafWidth, leafHeight)
  const seam = dividerSpec.x + dividerSpec.w / 2
  const sliceY = dividerSpec.y + dividerSpec.h / 2
  const row = Object.entries(geometry.boxes)
    .filter(([, box]) => containsHorizontalSlice(box, sliceY))
    .map(([paneId, box]) => ({ paneId, box, width: box.w }))
    .sort((first, second) => first.box.x - second.box.x)
  if (row.length < 2) return null

  const seamIndex = row.findIndex(
    (item, index) =>
      index < row.length - 1 &&
      Math.abs(item.box.x + item.box.w - seam) <= DOCK_DIVIDER_HIT &&
      Math.abs(row[index + 1].box.x - seam) <= DOCK_DIVIDER_HIT
  )
  if (seamIndex < 0) return null

  let remaining = Math.abs(deltaPixels)
  if (remaining <= Number.EPSILON) return layout
  if (deltaPixels < 0) {
    for (let index = seamIndex; index >= 0 && remaining > 0; index--) {
      const available = Math.max(0, row[index].width - leafWidth)
      const taken = Math.min(remaining, available)
      row[index].width -= taken
      remaining -= taken
    }
    row[seamIndex + 1].width += Math.abs(deltaPixels) - remaining
  } else {
    for (let index = seamIndex + 1; index < row.length && remaining > 0; index++) {
      const available = Math.max(0, row[index].width - leafWidth)
      const taken = Math.min(remaining, available)
      row[index].width -= taken
      remaining -= taken
    }
    row[seamIndex].width += Math.abs(deltaPixels) - remaining
  }

  const applied = Math.abs(deltaPixels) - remaining
  if (applied <= Number.EPSILON) return layout
  const desiredWidths = new Map(row.map((item) => [item.paneId, item.width]))
  const ratios = withoutLocalRatios(layout.ratios)
  writeSliceRatios(layout.root, sliceY, desiredWidths, geometry.boxes, ratios)
  return { ...layout, ratios }
}

/**
 * Colunas empurram a faixa inteira quando o vizinho imediato chega ao minimo;
 * linhas horizontais colineares compartilham o menor delta permitido e nunca
 * se separam durante o arraste.
 */
export function resizeDockDivider(
  layout: DockLayout,
  dividerSpec: CanvasDivider,
  deltaPixels: number,
  width: number,
  height: number,
  leafWidth = DOCK_MIN_WIDTH,
  leafHeight = DOCK_MIN_HEIGHT
): DockLayout {
  const columnResize = resizeColumnSeam(
    layout,
    dividerSpec,
    deltaPixels,
    width,
    height,
    leafWidth,
    leafHeight
  )
  if (columnResize) return columnResize

  const minimum = dividerSpec.axis === 'x' ? leafWidth : leafHeight
  const pieces = dividerSpec.linkedDividers?.length
    ? dividerSpec.linkedDividers
    : [dividerSpec]
  const allowed = pieces.map((piece) => measuredCanvasDividerDelta(piece, deltaPixels, minimum))
  const sharedDelta =
    deltaPixels < 0 ? Math.max(...allowed) : deltaPixels > 0 ? Math.min(...allowed) : 0
  if (Math.abs(sharedDelta) <= Number.EPSILON) return layout

  let nextRatios = layout.ratios
  for (const piece of pieces) {
    nextRatios = resizeCanvasDivider(nextRatios, piece, sharedDelta, minimum)
  }
  if (nextRatios === layout.ratios) return layout
  // Cada alca representa uma costura estrutural inteira. Isso evita que um
  // trecho local tenha um minimo diferente do restante da mesma linha e torna
  // o limite independente da ordem dos arrastes anteriores.
  return { ...layout, ratios: withoutLocalRatios(nextRatios) }
}

function detachPane(node: DockNode | null, paneId: string): { node: DockNode | null; removed: boolean } {
  if (!node) return { node: null, removed: false }
  if (node.type === 'leaf') {
    return node.paneId === paneId ? { node: null, removed: true } : { node, removed: false }
  }

  const first = detachPane(node.first, paneId)
  if (first.removed) {
    if (!first.node) return { node: node.second, removed: true }
    return { node: { ...node, first: first.node }, removed: true }
  }

  const second = detachPane(node.second, paneId)
  if (second.removed) {
    if (!second.node) return { node: node.first, removed: true }
    return { node: { ...node, second: second.node }, removed: true }
  }
  return { node, removed: false }
}

function hasPane(node: DockNode | null, paneId: string): boolean {
  if (!node) return false
  if (node.type === 'leaf') return node.paneId === paneId
  return hasPane(node.first, paneId) || hasPane(node.second, paneId)
}

function swapPanes(node: DockNode, firstId: string, secondId: string): DockNode {
  if (node.type === 'leaf') {
    if (node.paneId === firstId) return leaf(secondId)
    if (node.paneId === secondId) return leaf(firstId)
    return node
  }
  const first = swapPanes(node.first, firstId, secondId)
  const second = swapPanes(node.second, firstId, secondId)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function axisForEdge(edge: DockEdge): DockAxis {
  return edge === 'left' || edge === 'right' ? 'x' : 'y'
}

function isStartEdge(edge: DockEdge): boolean {
  return edge === 'left' || edge === 'top'
}

function alreadyAtRootEdge(root: DockNode | null, paneId: string, edge: DockEdge): boolean {
  if (!root || root.type !== 'split' || root.axis !== axisForEdge(edge)) return false
  const edgeNode = isStartEdge(edge) ? root.first : root.second
  return edgeNode.type === 'leaf' && edgeNode.paneId === paneId
}

function rootEdgeLeaf(root: DockNode | null, edge: DockEdge): DockLeaf | null {
  if (!root || root.type !== 'split' || root.axis !== axisForEdge(edge)) return null
  const edgeNode = isStartEdge(edge) ? root.first : root.second
  return edgeNode.type === 'leaf' ? edgeNode : null
}

function replaceTargetWithSplit(
  node: DockNode,
  targetId: string,
  draggedId: string,
  edge: DockEdge,
  used: Set<string>
): { node: DockNode; splitId?: string } {
  if (node.type === 'leaf') {
    if (node.paneId !== targetId) return { node }
    const dragged = leaf(draggedId)
    const target = leaf(targetId)
    const first = isStartEdge(edge) ? dragged : target
    const second = isStartEdge(edge) ? target : dragged
    const axis = axisForEdge(edge)
    const id = deterministicSplitId(axis, first, second, used)
    return { node: { type: 'split', id, axis, first, second }, splitId: id }
  }

  const first = replaceTargetWithSplit(node.first, targetId, draggedId, edge, used)
  if (first.splitId) return { node: { ...node, first: first.node }, splitId: first.splitId }
  const second = replaceTargetWithSplit(node.second, targetId, draggedId, edge, used)
  if (second.splitId) return { node: { ...node, second: second.node }, splitId: second.splitId }
  return { node }
}

function inheritedHorizontalRatio(
  layout: DockLayout,
  targetId: string,
  edge: DockEdge,
  width: number | undefined,
  height: number | undefined,
  fallback: number
): { ratio: number; donorRatios: Record<string, number[]> } {
  if ((edge !== 'top' && edge !== 'bottom') || !width || !height || width <= 0 || height <= 0) {
    return { ratio: fallback, donorRatios: {} }
  }
  const geometry = dockGeometry(width, height, layout)
  const target = geometry.boxes[targetId]
  if (!target || target.h <= 0) return { ratio: fallback, donorRatios: {} }
  const top = target.y + GEOMETRY_EPSILON
  const bottom = target.y + target.h - GEOMETRY_EPSILON
  const donors = geometry.dividers
    .filter((item) => item.axis === 'y')
    .filter((item) => {
      const seam = item.y + item.h / 2
      return seam > top && seam < bottom
    })
    .sort((first, second) => first.y + first.h / 2 - (second.y + second.h / 2))
  if (!donors.length) return { ratio: fallback, donorRatios: {} }

  // Uma divisao no topo herda a primeira linha que atravessa a altura do pane;
  // uma divisao embaixo herda a ultima. Assim um pane que ocupava varias linhas
  // entra na fileira existente em vez de criar uma costura quase paralela.
  const donor = edge === 'top' ? donors[0] : donors[donors.length - 1]
  const seam = donor.y + donor.h / 2
  const donorRatios: Record<string, number[]> = {}
  for (const piece of donor.linkedDividers ?? [donor]) {
    const before = piece.beforePixels ?? 0
    const after = piece.afterPixels ?? 0
    const total = before + after
    if (total > 0) donorRatios[piece.trackKey] = normalizedPair(undefined, before / total)
  }
  return { ratio: clampRatio((seam - target.y) / target.h), donorRatios }
}

/**
 * Encaixa um pane numa borda de outro. `center` troca as duas folhas sem
 * alterar a topologia nem as proporcoes. O pane arrastado tambem pode ser novo
 * (ainda ausente da arvore) nas quatro zonas de borda.
 */
export function dockPane(
  layout: DockLayout,
  draggedId: string,
  targetId: string,
  zone: DockZone,
  ratio = DEFAULT_DOCK_RATIO,
  width?: number,
  height?: number
): DockLayout {
  if (!draggedId || !targetId || draggedId === targetId || !layout.root) return layout
  if (!hasPane(layout.root, targetId)) return layout

  if (zone === 'center') {
    if (!hasPane(layout.root, draggedId)) return layout
    return finishLayout(
      swapPanes(layout.root, draggedId, targetId),
      withoutLocalRatios(layout.ratios)
    )
  }

  const detached = detachPane(layout.root, draggedId)
  if (!detached.node || !hasPane(detached.node, targetId)) return layout
  const detachedLayout = finishLayout(detached.node, layout.ratios)
  const inherited = inheritedHorizontalRatio(
    detachedLayout,
    targetId,
    zone,
    width,
    height,
    ratio
  )
  const used = collectSplitIds(detached.node)
  const replaced = replaceTargetWithSplit(detached.node, targetId, draggedId, zone, used)
  if (!replaced.splitId) return layout
  return finishLayout(replaced.node, {
    ...withoutLocalRatios(layout.ratios),
    ...inherited.donorRatios,
    [replaced.splitId]: normalizedPair(undefined, inherited.ratio)
  })
}

/** Encaixa o pane contra uma das quatro bordas externas do canvas. */
export function dockPaneAtRoot(
  layout: DockLayout,
  draggedId: string,
  edge: DockEdge,
  ratio = DEFAULT_DOCK_RATIO
): DockLayout {
  if (!draggedId) return layout
  // Repetir a acao de coluna/linha nao deve recriar o split nem zerar o
  // tamanho que o usuario ja ajustou manualmente.
  if (alreadyAtRootEdge(layout.root, draggedId, edge)) return layout

  // Se a borda desejada ja e uma folha full-span e o pane arrastado pertence
  // a arvore, o gesto significa PROMOVER esse pane para a borda. Trocar as
  // folhas preserva a topologia (e portanto o numero de colunas/linhas), todos
  // os ratios e o tamanho manual da faixa. Envolver a arvore criaria uma faixa
  // extra: no caso A | subarvore 2x2, tres colunas virariam quatro e o drop
  // deixaria de caber justamente quando o usuario tentasse por B no lugar de A.
  const currentEdge = rootEdgeLeaf(layout.root, edge)
  if (
    currentEdge &&
    currentEdge.paneId !== draggedId &&
    layout.root &&
    hasPane(layout.root, draggedId)
  ) {
    return {
      ...layout,
      root: swapPanes(layout.root, draggedId, currentEdge.paneId)
    }
  }

  const detached = detachPane(layout.root, draggedId)
  if (!detached.node) {
    return { version: DOCK_LAYOUT_VERSION, root: leaf(draggedId), ratios: {} }
  }

  const dragged = leaf(draggedId)
  const first = isStartEdge(edge) ? dragged : detached.node
  const second = isStartEdge(edge) ? detached.node : dragged
  const axis = axisForEdge(edge)
  const used = collectSplitIds(detached.node)
  const id = deterministicSplitId(axis, first, second, used)
  const root: DockSplit = { type: 'split', id, axis, first, second }
  return finishLayout(root, {
    ...withoutLocalRatios(layout.ratios),
    [id]: normalizedPair(undefined, ratio)
  })
}

/**
 * Faz um pane atravessar todo o eixo cruzado: axis x cria uma coluna de altura
 * total; axis y cria uma linha de largura total. Por padrao ele vai para a
 * esquerda/topo, mas `end` permite direita/baixo sem outra operacao.
 */
export function makePaneSpan(
  layout: DockLayout,
  paneId: string,
  axis: DockAxis,
  placement: DockPlacement = 'start',
  ratio = DEFAULT_DOCK_RATIO
): DockLayout {
  const edge: DockEdge =
    axis === 'x' ? (placement === 'start' ? 'left' : 'right') : placement === 'start' ? 'top' : 'bottom'
  return dockPaneAtRoot(layout, paneId, edge, ratio)
}

/** Ordem visual DFS, util para persistencia, teclado e testes. */
export function dockPaneOrder(layout: DockLayout): string[] {
  return collectPaneIds(layout.root)
}

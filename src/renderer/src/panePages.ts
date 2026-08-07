import {
  DEFAULT_CANVAS_LAYOUT,
  normalizeCanvasOrder,
  type CanvasNodeLayout,
  type CanvasPageLayout,
  type CanvasPreset
} from './paneCanvas'
import {
  balancedDockLayout,
  dockPaneOrder,
  normalizeDockLayout,
  type DockLayout
} from './paneDock'

/** O deck usa blocos fixos de oito; somente a ultima pagina pode ficar parcial. */
export const PANES_PER_PAGE = 8
export const CANVAS_PAGE_LIMIT = PANES_PER_PAGE

const DEFAULT_WIDTH = 1600
const DEFAULT_HEIGHT = 900
const PAGE_ID_PREFIX = 'page:'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueIds(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return uniqueIds(value.filter((item): item is string => typeof item === 'string'))
}

function safeSize(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function safePreset(value: unknown): CanvasPreset {
  return value === 'auto' ||
    value === 'sidebar' ||
    value === 'focus' ||
    value === 'grid' ||
    value === 'columns' ||
    value === 'rows'
    ? value
    : DEFAULT_CANVAS_LAYOUT.preset
}

function safeRatios(value: unknown): Record<string, number[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, number[]> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) continue
    const numbers = raw.map(Number)
    if (numbers.length && numbers.every((item) => Number.isFinite(item) && item > 0)) {
      out[key] = numbers
    }
  }
  return out
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function pageNumber(id: string): number | null {
  const match = /^page:(\d+)$/.exec(id)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function legacyBase(raw: Record<string, unknown>, liveIds: string[]): CanvasNodeLayout {
  const savedOrder = stringArray(raw.order)
  const order = normalizeCanvasOrder(liveIds, savedOrder)
  const base: CanvasNodeLayout = {
    preset: safePreset(raw.preset),
    order,
    ratios: safeRatios(raw.ratios)
  }
  if (isRecord(raw.dock)) base.dock = raw.dock as unknown as DockLayout
  return base
}

function canonicalPage(
  id: string,
  paneIds: string[],
  savedDock: unknown,
  width: number,
  height: number
): CanvasPageLayout {
  const dock = normalizeDockLayout(paneIds, savedDock, width, height)
  return { id, order: dockPaneOrder(dock), dock }
}

function balancedPage(
  id: string,
  paneIds: string[],
  width: number,
  height: number
): CanvasPageLayout {
  const dock = balancedDockLayout(paneIds, width, height)
  return { id, order: dockPaneOrder(dock), dock }
}

/**
 * Normaliza e migra as paginas de um no.
 *
 * Invariantes da saida:
 * - cada pane vivo aparece exatamente uma vez;
 * - nenhuma pagina possui mais de PANES_PER_PAGE panes;
 * - paginas intermediarias possuem exatamente PANES_PER_PAGE panes;
 * - abrir/fechar compacta a sequencia, deixando parcial apenas a ultima;
 * - um pane novo torna ativa a pagina para a qual ele foi compactado;
 * - toda arvore dock e normalizada somente contra sua propria pagina.
 */
export function reconcileCanvasPages(
  livePaneIds: readonly string[],
  saved: CanvasNodeLayout | null | undefined,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT
): CanvasNodeLayout {
  const liveIds = uniqueIds(livePaneIds)
  const alive = new Set(liveIds)
  const raw: Record<string, unknown> = isRecord(saved) ? saved : {}
  const safeWidth = safeSize(width, DEFAULT_WIDTH)
  const safeHeight = safeSize(height, DEFAULT_HEIGHT)
  const base = legacyBase(raw, liveIds)
  const rawPages = Array.isArray(raw.pages) ? raw.pages : null

  // IDs sao monotonicamente crescentes. Paginas vazias/antigas continuam
  // reservando sua sequencia, evitando que um layout reapareca sob outro nome.
  let nextPageSeq = positiveInteger(raw.nextPageSeq, 1)
  const reservedPageIds = new Set<string>()
  if (rawPages) {
    for (const value of rawPages) {
      if (!isRecord(value) || typeof value.id !== 'string' || !value.id) continue
      reservedPageIds.add(value.id)
      const number = pageNumber(value.id)
      if (number !== null) nextPageSeq = Math.max(nextPageSeq, number + 1)
    }
  }

  const claimedPageIds = new Set<string>()
  const createPageId = (): string => {
    let id = `${PAGE_ID_PREFIX}${nextPageSeq}`
    while (reservedPageIds.has(id) || claimedPageIds.has(id)) {
      nextPageSeq += 1
      id = `${PAGE_ID_PREFIX}${nextPageSeq}`
    }
    nextPageSeq += 1
    reservedPageIds.add(id)
    claimedPageIds.add(id)
    return id
  }
  const claimPageId = (preferred: unknown): string => {
    if (typeof preferred === 'string' && preferred && !claimedPageIds.has(preferred)) {
      claimedPageIds.add(preferred)
      return preferred
    }
    return createPageId()
  }

  // Ausencia de `pages` e o marcador de layout legado. O primeiro grupo herda
  // a arvore antiga; excedentes ganham grades proprias, sem contaminar a pagina 1.
  if (rawPages === null) {
    const pages: CanvasPageLayout[] = []
    for (let start = 0; start < liveIds.length; start += PANES_PER_PAGE) {
      const ids = liveIds.slice(start, start + PANES_PER_PAGE)
      const id = createPageId()
      pages.push(
        start === 0
          ? canonicalPage(id, ids, raw.dock, safeWidth, safeHeight)
          : balancedPage(id, ids, safeWidth, safeHeight)
      )
    }
    return {
      ...base,
      pages,
      activePageId: pages[0]?.id ?? null,
      nextPageSeq
    }
  }

  const requestedActive = typeof raw.activePageId === 'string' ? raw.activePageId : null
  const rawActiveIndex = requestedActive
    ? rawPages.findIndex((value) => isRecord(value) && value.id === requestedActive)
    : -1
  const claimedPanes = new Set<string>()
  const ordered: string[] = []
  let activeAnchor: string | null = null

  rawPages.forEach((value) => {
    if (!isRecord(value)) return
    const isRequested = requestedActive !== null && value.id === requestedActive
    for (const paneId of stringArray(value.order)) {
      if (!alive.has(paneId) || claimedPanes.has(paneId)) continue
      claimedPanes.add(paneId)
      ordered.push(paneId)
      if (isRequested) activeAnchor = paneId
    }
  })

  const missing = liveIds.filter((paneId) => !claimedPanes.has(paneId))
  ordered.push(...missing)
  // O ultimo pane novo e a intencao mais recente do usuario.
  if (missing.length) activeAnchor = missing[missing.length - 1]

  const pages: CanvasPageLayout[] = []
  for (let start = 0, pageIndex = 0; start < ordered.length; start += PANES_PER_PAGE, pageIndex++) {
    const ids = ordered.slice(start, start + PANES_PER_PAGE)
    const rawPage = isRecord(rawPages[pageIndex]) ? rawPages[pageIndex] : null
    const id = claimPageId(rawPage?.id)
    const previousIds = rawPage ? stringArray(rawPage.order).filter((paneId) => alive.has(paneId)) : []
    const membershipUnchanged =
      previousIds.length === ids.length && previousIds.every((paneId, index) => paneId === ids[index])
    pages.push(
      membershipUnchanged
        ? canonicalPage(id, ids, rawPage?.dock, safeWidth, safeHeight)
        : balancedPage(id, ids, safeWidth, safeHeight)
    )
  }

  let activeIndex = activeAnchor
    ? pages.findIndex((page) => page.order.includes(activeAnchor as string))
    : -1
  if (activeIndex < 0 && pages.length) {
    activeIndex = rawActiveIndex >= 0 ? Math.min(rawActiveIndex, pages.length - 1) : 0
  }
  return {
    ...base,
    pages,
    activePageId: activeIndex >= 0 ? pages[activeIndex].id : null,
    nextPageSeq
  }
}

/** Retorna a pagina pelo id persistente. */
export function findCanvasPageById(
  layout: Pick<CanvasNodeLayout, 'pages'> | null | undefined,
  pageId: string | null | undefined
): CanvasPageLayout | undefined {
  if (!pageId) return undefined
  return layout?.pages?.find((page) => page.id === pageId)
}

/** Retorna a pagina que contem um pane, sem depender do indice/rotulo da aba. */
export function findCanvasPageForPane(
  layout: Pick<CanvasNodeLayout, 'pages'> | null | undefined,
  paneId: string
): CanvasPageLayout | undefined {
  return layout?.pages?.find((page) => page.order.includes(paneId))
}

export function canvasPageIdForPane(
  layout: Pick<CanvasNodeLayout, 'pages'> | null | undefined,
  paneId: string
): string | null {
  return findCanvasPageForPane(layout, paneId)?.id ?? null
}

export function canvasPageIndexForPane(
  layout: Pick<CanvasNodeLayout, 'pages'> | null | undefined,
  paneId: string
): number {
  return layout?.pages?.findIndex((page) => page.order.includes(paneId)) ?? -1
}

/** Pagina ativa valida; cai na primeira somente para leitura defensiva. */
export function activeCanvasPage(
  layout: Pick<CanvasNodeLayout, 'pages' | 'activePageId'> | null | undefined
): CanvasPageLayout | undefined {
  return findCanvasPageById(layout, layout?.activePageId) ?? layout?.pages?.[0]
}

/** Troca a aba sem aceitar um id que nao pertence ao no. */
export function activateCanvasPage(layout: CanvasNodeLayout, pageId: string): CanvasNodeLayout {
  if (layout.activePageId === pageId || !findCanvasPageById(layout, pageId)) return layout
  return { ...layout, activePageId: pageId }
}

/** Atualiza uma pagina isoladamente, preservando membership das vizinhas. */
export function updateCanvasPage(
  layout: CanvasNodeLayout,
  pageId: string,
  update: (page: CanvasPageLayout) => CanvasPageLayout
): CanvasNodeLayout {
  const pages = layout.pages
  if (!pages) return layout
  const index = pages.findIndex((page) => page.id === pageId)
  if (index < 0) return layout
  const current = pages[index]
  const changed = update(current)
  if (changed === current) return layout
  const next = [...pages]
  // O updater nao pode trocar a identidade da aba por acidente.
  next[index] = changed.id === pageId ? changed : { ...changed, id: pageId }
  return { ...layout, pages: next }
}

/** Assinatura util para persistir a reconciliacao apenas quando ela mudou. */
export function canvasPagesSignature(
  layout: Pick<CanvasNodeLayout, 'pages' | 'activePageId' | 'nextPageSeq'> | null | undefined
): string {
  return JSON.stringify({
    pages: layout?.pages ?? null,
    activePageId: layout?.activePageId ?? null,
    nextPageSeq: layout?.nextPageSeq ?? null
  })
}

export function sameCanvasPageState(
  first: Pick<CanvasNodeLayout, 'pages' | 'activePageId' | 'nextPageSeq'> | null | undefined,
  second: Pick<CanvasNodeLayout, 'pages' | 'activePageId' | 'nextPageSeq'> | null | undefined
): boolean {
  return canvasPagesSignature(first) === canvasPagesSignature(second)
}

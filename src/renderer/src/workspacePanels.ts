export const WORKSPACE_PANELS = [
  { id: 'browser', title: 'Browser' },
  { id: 'mobile', title: 'Mobile' },
  { id: 'frota', title: 'Frota' },
  { id: 'trabalho', title: 'Trabalho' },
  { id: 'historico', title: 'Histórico' },
  { id: 'release', title: 'Release' }
] as const

export type WorkspacePanelId = typeof WORKSPACE_PANELS[number]['id']
/** Declared mirror of MissionType (src/renderer/src/store.ts): this module
 * stays pure so the node suites load it without the store. */
export type WorkspaceMissionType = 'dev' | 'planejamento' | 'release'
export interface WorkspacePreference {
  sidebarCollapsed: boolean
  panels: WorkspacePanelId[]
  columns: WorkspacePanelId[][]
  maximized: WorkspacePanelId | null
  /** A double-click fit stays clear of the chat until the next manual width change. */
  fitToChat: boolean
  columnWidths: number[]
  rowSplits: number[]
}

export const PANEL_GAP = 12
export const PANEL_MIN_WIDTH = 360
export const PANEL_MAX_WIDTH = 2400
const CHAT_MIN_WIDTH = 420
const CHAT_PEEK_WIDTH = 132

export function workspaceColumnWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, value))) : PANEL_MIN_WIDTH
}

export function workspaceChatPanelLimit(boardWidth: number, sidebarSpace: number): number {
  return Math.max(0, boardWidth - sidebarSpace - CHAT_MIN_WIDTH - PANEL_GAP)
}

export function workspacePanelLimit(boardWidth: number, sidebarSpace: number): number {
  const available = Math.max(0, boardWidth - sidebarSpace)
  return Math.max(Math.min(PANEL_MIN_WIDTH, available), available - CHAT_PEEK_WIDTH)
}

/** The minimum is responsive only when the viewport cannot fit all columns. */
export function workspaceColumnBounds(maxWidth: number, count: number): { minimum: number; maximum: number; budget: number } {
  const budget = Math.floor(Math.max(0, maxWidth - (count - 1) * PANEL_GAP))
  const minimum = Math.min(PANEL_MIN_WIDTH, Math.floor(budget / Math.max(1, count)))
  return { minimum, maximum: Math.min(PANEL_MAX_WIDTH, budget - (count - 1) * minimum), budget }
}

/** Project saved widths into the current viewport without overwriting them. */
export function fitWorkspaceColumnWidths(widths: readonly number[], maxWidth: number): number[] {
  if (!widths.length) return []
  const { minimum, budget } = workspaceColumnBounds(maxWidth, widths.length)
  const sizes = widths.map(width => Math.max(minimum, Number.isFinite(width) ? width : PANEL_MIN_WIDTH))
  const total = sizes.reduce((sum, width) => sum + width, 0)
  if (total <= budget) return sizes
  const slack = total - minimum * sizes.length
  const ratio = slack > 0 ? (budget - minimum * sizes.length) / slack : 0
  const fitted = sizes.map(width => minimum + Math.floor((width - minimum) * ratio))
  let remainder = budget - fitted.reduce((sum, width) => sum + width, 0)
  for (let index = 0; index < fitted.length && remainder > 0; index++, remainder--) fitted[index]++
  return fitted
}

/** Give the active column priority; nearby columns yield before the deck grows past its limit. */
export function resizeWorkspaceColumns(widths: readonly number[], column: number, width: number, maxWidth: number): number[] {
  const sizes = fitWorkspaceColumnWidths(widths, maxWidth)
  if (column < 0 || column >= sizes.length) return sizes
  const { minimum, maximum, budget } = workspaceColumnBounds(maxWidth, sizes.length)
  sizes[column] = Math.max(minimum, Math.min(maximum, Math.round(width)))
  let excess = sizes.reduce((sum, value) => sum + value, 0) - budget
  const neighbors = sizes.map((_, index) => index).filter(index => index !== column)
    .sort((a, b) => Math.abs(a - column) - Math.abs(b - column))
  for (const index of neighbors) {
    const reduction = Math.min(Math.max(0, excess), sizes[index] - minimum)
    sizes[index] -= reduction
    excess -= reduction
  }
  return sizes
}

export function workspaceRowSplit(value: number, height = 0): number {
  const minimum = height > PANEL_GAP ? Math.min(50, Math.max(20, 120 / (height - PANEL_GAP) * 100)) : 20
  return Math.min(100 - minimum, Math.max(minimum, Number.isFinite(value) ? value : 50))
}

export function workspaceStorageKey(projectId: string, missionId?: string | null): string {
  return missionId == null
    ? `synkora.workspace.v1:${encodeURIComponent(projectId)}`
    : `synkora.workspace.v2:${encodeURIComponent(projectId)}:${encodeURIComponent(missionId)}`
}

export function isWorkspacePanelId(id: unknown): id is WorkspacePanelId {
  return WORKSPACE_PANELS.some((panel) => panel.id === id)
}

export function normalizeWorkspacePreference(value: unknown): WorkspacePreference {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<WorkspacePreference> & { columnWidth?: number }
  const requested = Array.isArray(raw.panels) ? [...new Set(raw.panels.filter(isWorkspacePanelId))] : []
  const columns: WorkspacePanelId[][] = []
  const sourceColumns: number[] = []
  const placed = new Set<WorkspacePanelId>()
  // Before explicit columns were persisted, adjacent panels shared a column.
  // Reconstruct those original pairs so splitting Mobile preserves their sizes.
  // An explicit empty array is a new layout, not that historical representation.
  const originalColumns = Array.isArray(raw.columns) ? raw.columns
    : Array.from({ length: Math.ceil(requested.length / 2) }, (_, index) => requested.slice(index * 2, index * 2 + 2))
  for (const [source, candidate] of originalColumns.entries()) {
    if (!Array.isArray(candidate)) continue
    const items = candidate.filter((id): id is WorkspacePanelId => {
      if (!isWorkspacePanelId(id) || !requested.includes(id) || placed.has(id)) return false
      placed.add(id); return true
    })
    for (let i = 0; i < items.length;) {
      const count = items[i] === 'mobile' || items[i + 1] === 'mobile' ? 1 : 2
      columns.push(items.slice(i, i + count))
      // Splitting a legacy Mobile row must not shift a following column's
      // saved width or row split. Both new columns inherit their origin.
      sourceColumns.push(source)
      i += count
    }
  }
  for (const id of requested) if (!placed.has(id)) {
    const last = columns.at(-1)
    if (id !== 'mobile' && last?.length === 1 && last[0] !== 'mobile') last.push(id)
    else { sourceColumns.push(columns.length); columns.push([id]) }
  }
  const panels = columns.flat()
  const sizes = Array.from({ length: Math.max(2, columns.length) }, (_, index) => sourceColumns[index] ?? index)
  return {
    sidebarCollapsed: raw.sidebarCollapsed === true,
    panels,
    columns,
    maximized: isWorkspacePanelId(raw.maximized) && panels.includes(raw.maximized) ? raw.maximized : null,
    fitToChat: raw.fitToChat === true,
    columnWidths: sizes.map((index) => workspaceColumnWidth(Array.isArray(raw.columnWidths) ? raw.columnWidths[index] : raw.columnWidth)),
    rowSplits: sizes.map((index) => workspaceRowSplit(Array.isArray(raw.rowSplits) && typeof raw.rowSplits[index] === 'number' ? raw.rowSplits[index] : 50))
  }
}

export function readWorkspacePreference(storage: Pick<Storage, 'getItem'> | null, projectId: string, missionId?: string | null): WorkspacePreference {
  try {
    const saved = storage?.getItem(workspaceStorageKey(projectId, missionId))
    if (saved != null || missionId == null) return normalizeWorkspacePreference(JSON.parse(saved ?? 'null'))
    // The old project-wide layout cannot tell which mission opened a panel.
    // Preserve its sizing/sidebar preferences, but never spread open panels.
    const legacy = readWorkspacePreference(storage, projectId)
    return normalizeWorkspacePreference({ ...legacy, panels: [], columns: [], maximized: null })
  }
  catch { return normalizeWorkspacePreference(null) }
}

/** The panels a chat can open, decided by the nature of its mission — one
 * frame for the three chats, never a different chrome per type (owner's
 * order, 2026-09-09). Dev opens everything but Release; planning has no
 * worktree, so no Trabalho/Histórico. Release (direct release, 2026-09-28:
 * "igual uma missão normal, mas é de release") opens the mission's panels plus
 * its own; Trabalho/Histórico read where it works (version worktree before the
 * ascent, project folder after), resolved by the main. */
export function availableWorkspacePanels(type: WorkspaceMissionType, browser: boolean): WorkspacePanelId[] {
  return WORKSPACE_PANELS.filter((panel) => {
    if (panel.id === 'release') return type === 'release'
    if (panel.id === 'mobile') return type !== 'planejamento' && browser
    if (panel.id === 'browser') return browser
    return type !== 'planejamento' || panel.id === 'frota'
  }).map((panel) => panel.id)
}

export function openWorkspacePanel(state: WorkspacePreference, id: WorkspacePanelId): WorkspacePreference {
  if (state.panels.includes(id)) return normalizeWorkspacePreference({ ...state, maximized: null })
  const next = normalizeWorkspacePreference({ ...state, panels: [...state.panels, id], maximized: null })
  const column = next.columns.findIndex(items => items.includes(id))
  if (next.columns[column].length === 1) next.columnWidths[column] = PANEL_MIN_WIDTH
  next.rowSplits[column] = 50
  return next
}

export function closeWorkspacePanel(state: WorkspacePreference, id: WorkspacePanelId): WorkspacePreference {
  const remaining = state.columns.map((column, index) => ({ panels: column.filter(panel => panel !== id), width: state.columnWidths[index], split: state.rowSplits[index] })).filter(column => column.panels.length)
  return normalizeWorkspacePreference({ ...state, panels: state.panels.filter((panel) => panel !== id), columns: remaining.map(column => column.panels),
    columnWidths: remaining.length ? remaining.map(column => column.width) : state.columnWidths,
    rowSplits: remaining.length ? remaining.map(column => column.split) : state.rowSplits, maximized: state.maximized === id ? null : state.maximized })
}

export type WorkspaceDropTarget = { panel: WorkspacePanelId; edge: 'left' | 'right' | 'above' | 'below' }

export function canMoveWorkspacePanel(state: WorkspacePreference, id: WorkspacePanelId, target: WorkspaceDropTarget): boolean {
  if (!state.panels.includes(id) || id === target.panel) return false
  const column = state.columns.find(column => column.includes(target.panel))
  if (!column) return false
  if (target.edge === 'left' || target.edge === 'right') return true
  return id !== 'mobile' && !column.includes('mobile') && column.filter(panel => panel !== id).length < 2
}

export function moveWorkspacePanel(state: WorkspacePreference, id: WorkspacePanelId, target: WorkspaceDropTarget): WorkspacePreference {
  if (!canMoveWorkspacePanel(state, id, target)) return state
  const source = state.columns.findIndex(column => column.includes(id))
  const columns = state.columns.map((column, index) => ({ panels: column.filter(panel => panel !== id), width: state.columnWidths[index], split: state.rowSplits[index] })).filter(column => column.panels.length)
  const destination = columns.findIndex(column => column.panels.includes(target.panel))
  if (target.edge === 'left' || target.edge === 'right') {
    columns.splice(destination + (target.edge === 'right' ? 1 : 0), 0, { panels: [id], width: state.columnWidths[source], split: 50 })
  } else columns[destination].panels.splice(target.edge === 'above' ? 0 : 1, 0, id)
  return normalizeWorkspacePreference({ ...state, columns: columns.map(column => column.panels), panels: columns.flatMap(column => column.panels),
    columnWidths: columns.map(column => column.width), rowSplits: columns.map(column => column.split), maximized: null })
}

/** Reserve the same space once the chat reaches its minimum. Only the excess
 * of the panel deck overlaps it; the conversation never expands underneath. */
export function workspacePanelLayout(
  boardWidth: number, sidebarSpace: number, count: number, columnWidths: number | readonly number[], maximized: boolean, columnCount = Math.ceil(count / 2), fitToChat = false
): { width: number; reservedWidth: number; columns: number; overlay: boolean } {
  const available = Math.max(0, boardWidth - sidebarSpace)
  const naturalColumns = Math.max(1, columnCount)
  const naturalWidth = Array.from({ length: naturalColumns }, (_, index) => typeof columnWidths === 'number' ? columnWidths : columnWidths[index] ?? PANEL_MIN_WIDTH)
    .reduce((total, width) => total + width, 0) + (naturalColumns - 1) * PANEL_GAP
  const columns = maximized ? 1 : naturalColumns
  const chatLimit = workspaceChatPanelLimit(boardWidth, sidebarSpace)
  const reservedWidth = count === 0 ? 0 : Math.min(naturalWidth, chatLimit)
  const maximumWidth = fitToChat ? chatLimit : workspacePanelLimit(boardWidth, sidebarSpace)
  const width = count === 0 ? 0 : maximized ? available : Math.min(naturalWidth, maximumWidth)
  return { width, reservedWidth, columns, overlay: count > 0 && (maximized || width > reservedWidth) }
}

export function workspacePanelPosition(index: number, count: number, maximized: boolean, columns?: readonly (readonly WorkspacePanelId[])[]): { column: number; row: number; span: number } {
  if (columns && !maximized) {
    let offset = 0
    for (let column = 0; column < columns.length; column++) {
      if (index < offset + columns[column].length) return { column: column + 1, row: index - offset + 1, span: columns[column].length === 1 ? 2 : 1 }
      offset += columns[column].length
    }
  }
  return maximized ? { column: 1, row: 1, span: 2 } : {
    column: Math.floor(index / 2) + 1,
    row: index % 2 + 1,
    span: index === count - 1 && index % 2 === 0 ? 2 : 1
  }
}

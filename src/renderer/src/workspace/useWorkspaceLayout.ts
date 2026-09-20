import { useCallback, useEffect, useState } from 'react'
import {
  closeWorkspacePanel, moveWorkspacePanel, normalizeWorkspacePreference, openWorkspacePanel,
  readWorkspacePreference, workspaceStorageKey, type WorkspaceDropTarget, type WorkspacePanelId, type WorkspacePreference
} from '../workspacePanels'

function read(projectId: string, missionId?: string | null): WorkspacePreference {
  try { return readWorkspacePreference(window.localStorage, projectId, missionId) }
  catch { return normalizeWorkspacePreference(null) }
}

export function useWorkspaceLayout(projectId: string, missionId?: string | null) {
  const scopeKey = workspaceStorageKey(projectId, missionId)
  const [saved, setSaved] = useState(() => ({ scopeKey, preference: read(projectId, missionId) }))
  // The Board stays mounted across missions. Switch before child effects can
  // use the old mission's open panels, and never persist them into the new one.
  if (saved.scopeKey !== scopeKey) setSaved({ scopeKey, preference: read(projectId, missionId) })
  const preference = saved.preference

  useEffect(() => {
    if (saved.scopeKey !== scopeKey) return
    try { window.localStorage.setItem(scopeKey, JSON.stringify(saved.preference)) }
    catch { /* An unavailable storage does not block navigation. */ }
  }, [scopeKey, saved])

  const update = useCallback((change: (value: WorkspacePreference) => WorkspacePreference): void => {
    setSaved((current) => current.scopeKey !== scopeKey ? current :
      { scopeKey, preference: normalizeWorkspacePreference(change(current.preference)) })
  }, [scopeKey])
  const openPanel = useCallback((id: WorkspacePanelId) => update((value) => openWorkspacePanel(value, id)), [update])
  const closePanel = useCallback((id: WorkspacePanelId) => update((value) => closeWorkspacePanel(value, id)), [update])
  const movePanel = useCallback((id: WorkspacePanelId, target: WorkspaceDropTarget) => update(value => moveWorkspacePanel(value, id, target)), [update])
  const toggleSidebar = useCallback(() => update((value) => ({ ...value, sidebarCollapsed: !value.sidebarCollapsed })), [update])
  const maximizePanel = useCallback((id: WorkspacePanelId) => update((value) => ({
    ...value, maximized: value.maximized === id ? null : id
  })), [update])
  const restorePanels = useCallback(() => update((value) => ({ ...value, maximized: null })), [update])
  const closeAll = useCallback(() => update((value) => ({ ...value, panels: [], maximized: null })), [update])
  const setColumnWidth = useCallback((width: number, column = 0) => update((value) => ({
    ...value, fitToChat: false, columnWidths: value.columnWidths.map((current, index) => index === column ? width : current)
  })), [update])
  const setColumnWidths = useCallback((widths: readonly number[], columns: readonly number[], fitToChat = false) => update((value) => ({
    ...value, fitToChat, maximized: null,
    columnWidths: value.columnWidths.map((current, index) => widths[columns.indexOf(index)] ?? current)
  })), [update])
  const setRowSplit = useCallback((column: number, split: number) => update((value) => ({
    ...value, rowSplits: value.rowSplits.map((current, index) => index === column ? split : current)
  })), [update])
  return { preference, openPanel, closePanel, movePanel, toggleSidebar, maximizePanel, restorePanels, closeAll, setColumnWidth, setColumnWidths, setRowSplit }
}

export type WorkspaceController = ReturnType<typeof useWorkspaceLayout>

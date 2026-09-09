import { useCallback, useEffect, useState } from 'react'
import {
  closeWorkspacePanel, moveWorkspacePanel, normalizeWorkspacePreference, openWorkspacePanel,
  readWorkspacePreference, workspaceStorageKey, type WorkspaceDropTarget, type WorkspacePanelId, type WorkspacePreference
} from '../workspacePanels'

function read(projectId: string): WorkspacePreference {
  try { return readWorkspacePreference(window.localStorage, projectId) }
  catch { return normalizeWorkspacePreference(null) }
}

export function useWorkspaceLayout(projectId: string) {
  const [saved, setSaved] = useState(() => ({ projectId, preference: read(projectId) }))
  // Each Board normally keeps its own controller. This guard also prevents a
  // reused Board from writing the previous project's preference into the next.
  if (saved.projectId !== projectId) setSaved({ projectId, preference: read(projectId) })
  const preference = saved.preference

  useEffect(() => {
    if (saved.projectId !== projectId) return
    try { window.localStorage.setItem(workspaceStorageKey(projectId), JSON.stringify(saved.preference)) }
    catch { /* An unavailable storage does not block navigation. */ }
  }, [projectId, saved])

  const update = useCallback((change: (value: WorkspacePreference) => WorkspacePreference): void => {
    setSaved((current) => ({ projectId, preference: normalizeWorkspacePreference(change(
      current.projectId === projectId ? current.preference : read(projectId)
    )) }))
  }, [projectId])
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

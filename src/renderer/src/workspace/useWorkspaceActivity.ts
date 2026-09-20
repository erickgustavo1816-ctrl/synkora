import { useContext, useEffect, useRef } from 'react'
import type { BrowserPanelState } from '../../../preload/index'
import type { GuiSubagentSidebarEntry } from '../guiSubagentSidebar'
import type { MissionWorkspaceSummary } from '../missionWorkspace'
import type { WorkspacePanelId } from '../workspacePanels'
import { WorkspacePanelContext } from './WorkspacePanelContext'

interface Activity {
  browser: BrowserPanelState | null
  helpers: readonly Pick<GuiSubagentSidebarEntry, 'id' | 'status'>[]
  workspace: MissionWorkspaceSummary | null
}

/** Changes in published state, never guesses from chat or shell text. */
export function workspaceActivityPanels(previous: Activity | undefined, next: Activity): WorkspacePanelId[] {
  const panels: WorkspacePanelId[] = []
  if (!previous) return panels
  const before = previous?.browser
  const browser = next.browser
  if (before && browser?.alive && browser.host !== 'popout' && (
    !before?.alive || before.host === 'popout' || (browser.agentDriving && !before.agentDriving) ||
    browser.tabs.some(tab => !before.tabs.some(old => old.tabId === tab.tabId && old.url === tab.url))
  )) panels.push('browser')

  if (next.helpers.some(helper => {
    const old = previous?.helpers.find(item => item.id === helper.id)
    return !old || (old.status !== 'running' && helper.status === 'running')
  })) panels.push('frota')

  if (previous?.workspace && next.workspace) {
    if (next.workspace.ahead > previous.workspace.ahead) panels.push('historico')
  }
  return panels
}

/** Restoring a view only establishes a baseline. Auto-opening belongs to new
 * activity observed while that same mission stays visible, never navigation. */
export function useWorkspaceActivity(missionId: string, activity: Activity, enabled: boolean): void {
  const context = useContext(WorkspacePanelContext)
  const openPanel = context?.controller.openPanel
  const visible = context?.visible === true
  const previous = useRef<{ missionId: string; activity: Activity; watching: boolean } | null>(null)
  useEffect(() => {
    const old = previous.current
    const watching = visible && enabled && !!openPanel
    const continuous = watching && old?.watching && old.missionId === missionId
    previous.current = { missionId, watching, activity: {
      ...activity, workspace: activity.workspace ?? (continuous ? old.activity.workspace : null)
    } }
    if (!continuous) return
    for (const panel of workspaceActivityPanels(old.activity, activity)) openPanel!(panel)
  }, [missionId, activity.browser, activity.helpers, activity.workspace, enabled, openPanel, visible])
}

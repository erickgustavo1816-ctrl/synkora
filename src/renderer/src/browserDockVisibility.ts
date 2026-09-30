import {
  isUnversionedProject,
  openSoloMission,
  type ProjectVersioning
} from '../../shared/projectVersioning'

/** Structural mirror of App/store navigation and Board's delivery-rail guard.
 * Keepalive DOM visibility is not authority over a native WebContentsView. */
export interface BrowserDockNavigation {
  appPage: string
  openProjectId: string | null
  universeTabByProject: Record<string, string>
  missionTabByProject: Record<string, string | null>
  missions: readonly {
    id: string
    projectId: string
    direct?: boolean
    status: string
  }[]
  /** absent = every project is versioned (the historical shape) */
  projects?: readonly { id: string; versioning?: ProjectVersioning }[]
}

export const BROWSER_DOCK_CONTEXT_CHANGED = 'synkora:browser-dock-context-changed'

export function eligibleDockMission(state: BrowserDockNavigation): string | null {
  const projectId = state.openProjectId
  if (state.appPage !== 'workspace' || !projectId) return null
  if ((state.universeTabByProject[projectId] ?? 'board') !== 'board') return null
  // Non-versioned project (2026-09-30): the open mission IS the screen on the
  // Missão tab ('board'), with no mission tab to select — the seam's
  // one-at-a-time rule names it.
  if (isUnversionedProject(state.projects?.find((p) => p.id === projectId))) {
    const open = openSoloMission(state.missions, projectId)
    return open?.direct ? open.id : null
  }
  const selected = state.missionTabByProject[projectId]
  const mission = state.missions.find((m) => m.id === selected && m.projectId === projectId)
  return mission?.direct &&
    (mission.status === 'ativa' || mission.status === 'integrando')
    ? mission.id
    : null
}

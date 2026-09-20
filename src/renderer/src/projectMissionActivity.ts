import type { GuiPaneState, Mission } from './store'
import { missionChatSummary } from './guiMissionPanes'

export type ProjectMissionActivity = 'running' | 'paused' | null

/** Project work includes release conversations. Open terminals and an idle
 * CLI alone are not running work. */
export function projectMissionActivity(
  projectId: string,
  missions: readonly Mission[],
  guiPanes: Record<string, Pick<GuiPaneState, 'status' | 'perm'>>
): ProjectMissionActivity {
  let hasOpenMission = false
  for (const mission of missions) {
    if (mission.projectId !== projectId || mission.kind === 'direta' ||
      (mission.status !== 'ativa' && mission.status !== 'integrando')) continue
    hasOpenMission = true
    if (missionChatSummary(mission.id, guiPanes).running > 0 ||
      mission.integration?.state === 'merging' || (mission.status === 'integrando' && !mission.integration)) return 'running'
  }
  return hasOpenMission ? 'paused' : null
}

export function projectMissionActivityLabel(activity: ProjectMissionActivity): string {
  if (activity === 'running') return 'Há trabalho em andamento'
  if (activity === 'paused') return 'Há trabalho em espera'
  return 'Nenhum trabalho em aberto'
}

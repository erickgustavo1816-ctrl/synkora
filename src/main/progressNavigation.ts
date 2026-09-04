/** Sanitized navigation only: this contract never authorizes creating a session. */
export interface ProgressOpenTarget {
  projectId: string
  missionId?: string
  paneId?: string
  destination?: 'chat' | 'delivery' | 'project'
}

interface NavigationMission {
  id: string
  projectId: string
  status: string
}

interface NavigationContext {
  projectExists(projectId: string): boolean
  mission(missionId: string): NavigationMission | undefined
  missions(projectId: string): readonly NavigationMission[]
  panes(): readonly { paneId: string; projectId: string }[]
  /** Uses the canonical guiMissionContracts convention in the main process. */
  isMissionPane(paneId: string, missionId: string): boolean
  isPlanningPane(paneId: string, projectId: string): boolean
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)

export function validateProgressOpenTarget(value: unknown, ctx: NavigationContext): ProgressOpenTarget | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (!validId(input.projectId) || !ctx.projectExists(input.projectId)) return null
  if (input.missionId !== undefined && !validId(input.missionId)) return null
  if (input.paneId !== undefined && !validId(input.paneId)) return null
  if (input.destination !== undefined &&
    (typeof input.destination !== 'string' || !['chat', 'delivery', 'project'].includes(input.destination))) return null
  const mission = typeof input.missionId === 'string' ? ctx.mission(input.missionId) : undefined
  if (input.missionId !== undefined && (!mission || mission.projectId !== input.projectId)) return null
  const paneId = typeof input.paneId === 'string' ? input.paneId : undefined
  const destination = input.destination as ProgressOpenTarget['destination']
  if (destination === 'delivery' && (!mission || paneId)) return null
  if (destination === 'chat' && !paneId) return null
  if (paneId) {
    if (!ctx.panes().some((pane) => pane.paneId === paneId && pane.projectId === input.projectId)) return null
    if (mission) {
      // Short IDs are historical; ambiguous collisions cannot select another mission.
      const matches = ctx.missions(input.projectId).filter((candidate) => ctx.isMissionPane(paneId, candidate.id))
      if (matches.length !== 1 || matches[0].id !== mission.id) return null
    } else if (!ctx.isPlanningPane(paneId, input.projectId)) return null
  }
  if (mission && mission.status !== 'ativa' && mission.status !== 'integrando') {
    return { projectId: input.projectId, destination: 'project' }
  }
  return {
    projectId: input.projectId,
    ...(mission ? { missionId: mission.id } : {}),
    ...(paneId ? { paneId } : {}),
    ...(destination ? { destination } : {})
  }
}

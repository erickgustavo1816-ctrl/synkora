import { useEffect } from 'react'
import { useStore, type Project } from './store'

/** Metadata only: the rail never opens a project, spawns a chat or polls an agent. */
export function useProjectMissionActivity(projects: readonly Project[]): void {
  const loadMissions = useStore(s => s.loadMissions)
  useEffect(() => {
    for (const project of projects) {
      if (!project.missing) void loadMissions(project.id).catch(() => undefined)
    }
  }, [projects, loadMissions])

  useEffect(() => {
    if (!window.synkora?.missions?.onChanged) return
    return window.synkora.missions.onChanged(projectId => {
      const project = useStore.getState().projects.find(value => value.id === projectId)
      if (project && !project.missing) void loadMissions(projectId).catch(() => undefined)
    })
  }, [loadMissions])
}

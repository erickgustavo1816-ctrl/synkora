import type { MainContext } from './mainContext'
import type { MissionLifecycleExtras } from './missionLifecycle'
import type { MissionStore } from './missions'
import { isUnversionedProject, unversionedRefusal, type MissionFinishResult } from '../shared/projectVersioning'

// Shared by creation, pane reopening and teardown. The project stays occupied
// until every writer has stopped, including when its GUI pane is already gone.
const stopping = new WeakMap<MissionStore, Set<string>>()

export function soloMissionIsStopping(missions: MissionStore, projectId: string): boolean {
  return stopping.get(missions)?.has(projectId) ?? false
}

/** Recheck after an asynchronous workspace proof: finish may have started
 * while a chat/shell spec was waiting for that proof. */
export function soloMissionOpeningRefusal(ctx: MainContext, missionId: string): string | undefined {
  const mission = ctx.missions.get(missionId)
  if (!mission || !isUnversionedProject(ctx.projects.get(mission.projectId))) return undefined
  if (mission.status !== 'ativa') return unversionedRefusal('reopen')
  if (soloMissionIsStopping(ctx.missions, mission.projectId)) return unversionedRefusal('second-mission')
  return undefined
}

/** Finishing edits only the record. Teardown is the archive path's existing
 * authority over chats, delegated helpers, mobile and browser resources. */
export function buildSoloMissionLifecycle(ctx: MainContext, extras: MissionLifecycleExtras) {
  const pending = new Map<string, Promise<MissionFinishResult>>()
  const stop = async (missionId: string, afterStop?: () => void): Promise<void> => {
    const mission = ctx.missions.get(missionId)
    if (!mission) throw new Error('Missão não encontrada. Reabra a lista de missões.')
    let projects = stopping.get(ctx.missions)
    if (!projects) { projects = new Set(); stopping.set(ctx.missions, projects) }
    if (projects.has(mission.projectId)) throw new Error(unversionedRefusal('second-mission'))
    projects.add(mission.projectId)
    try {
      extras.engine.stopMissionExecution(mission.projectId, missionId, 'missão encerrando seus processos')
      // Shells have no Hub identity. Their durable main-owned registration is
      // the authority, never a renderer-supplied cwd or a worktree approximation.
      for (const [paneId, pane] of ctx.testServerPanes) {
        if (pane.projectId !== mission.projectId || pane.missionId !== missionId) continue
        ctx.ptys.kill(paneId)
        ctx.testServerPanes.delete(paneId)
        ctx.unregisterPane(paneId)
        ctx.pushAll('panes:closeById', mission.projectId, paneId)
      }
      await extras.killMissionGuiPanes(missionId)
      afterStop?.()
    } finally {
      projects.delete(mission.projectId)
    }
  }
  const finish = (missionId: string): Promise<MissionFinishResult> => {
    const existing = pending.get(missionId)
    if (existing) return existing
    const operation = async (): Promise<MissionFinishResult> => {
      const mission = ctx.missions.get(missionId)
      if (!mission) return { ok: false, error: 'Missão não encontrada. Reabra a lista de missões.' }
      const project = ctx.projects.get(mission.projectId)
      if (!project) return { ok: false, error: 'Projeto não encontrado. Reabra o projeto.' }
      if (!isUnversionedProject(project))
        return { ok: false, error: 'Este projeto é versionado. Use ⇪ para concluir a missão pela integração.' }
      if (mission.status === 'concluida') return { ok: true }
      const path = project.path
      try {
        await stop(missionId, () => {
          const current = ctx.missions.get(missionId)
          if (!current || current.projectId !== mission.projectId || current.status !== mission.status ||
            ctx.projects.get(mission.projectId)?.path !== path)
            throw new Error('mission changed during teardown')
          ctx.missions.update(missionId, { status: 'concluida' })
          extras.engine.emitMissionsChanged(mission.projectId)
        })
        return { ok: true }
      } catch {
        return { ok: false, error: 'Não consegui encerrar todos os processos. A missão continua aberta; tente finalizar novamente.' }
      }
    }
    const result = operation()
    pending.set(missionId, result)
    void result.finally(() => { pending.delete(missionId) })
    return result
  }
  return { finish, stop }
}

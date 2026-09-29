import { join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { ensureSynkoraGitExcludes, isExpectedWorktree, isWorktreeClean, removeWorktreeAndBranch } from './worktree'
import { isGuiMissionPaneId, missionTypeOf } from './guiMissionContracts'
import { discardAgentSkills } from './skillsAgentSync'
import { needsMissionFinalization } from './missionFinalization'
import type { MainContext } from './mainContext'
import type { Mission } from './missions'
import type { MissionEngine } from './missionEngine'
import type { GuiSessionRegistry } from './guiSessions'
import type { MissionRemovalResult } from '../shared/missionRemoval'

export interface MissionMetadataPatch {
  title?: string
  goal?: string
  scope?: string
  status?: 'ativa' | 'arquivada' | 'concluida'
}

export interface MissionLifecycleExtras {
  engine: Pick<MissionEngine, 'emitMissionsChanged' | 'scheduleIntegrationDrain' | 'stopMissionExecution'>
  orchKey(projectId: string, missionId: string): string
  emitBacklogChanged(projectId: string): void
  guiSessions: Pick<GuiSessionRegistry, 'forgetWhere'>
  killMissionGuiPanes(missionId: string): void | Promise<void>
}

export type MissionLifecycle = ReturnType<typeof buildMissionLifecycle>

export function buildMissionLifecycle(ctx: MainContext, extras: MissionLifecycleExtras) {
  const { projects, missions, backlog, maestro, integrationQueue, ptys, blackbox, hub,
    syncBoard, orchPaneId, unregisterPane } = ctx
  const { engine, orchKey, emitBacklogChanged, guiSessions, killMissionGuiPanes } = extras
  const { emitMissionsChanged, scheduleIntegrationDrain, stopMissionExecution } = engine
  const removing = new Set<string>()
  const closeGuiPanesInBackground = (missionId: string): void => {
    void Promise.resolve(killMissionGuiPanes(missionId)).catch(() => {
      blackbox.record({ cat: 'app', event: 'mission-process-cleanup-failed', actor: 'harness', ids: { missionId } })
    })
  }
  return {
    closeInBackground: closeGuiPanesInBackground,
    update(id: string, input: MissionMetadataPatch): Mission | null {
      if (removing.has(id)) return null
      const patch = { ...input }
      const mission = missions.get(id)
      if (!mission) return null
      if (patch.status && mission.status !== 'ativa' && mission.status !== 'arquivada')
        delete patch.status
      if (patch.status === 'concluida' && missionTypeOf(mission) !== 'planejamento')
        delete patch.status
      if (patch.status === 'arquivada' && patch.status !== mission.status) {
        const queued = integrationQueue.getByMission(mission.id)
        if (queued?.state === 'merging' || needsMissionFinalization(queued)) {
          hub.publish({
            projectId: mission.projectId,
            kind: 'error',
            text: `não arquivei "${mission.title}": conclua a integração pendente no chat da missão antes de arquivar`,
            actor: 'harness'
          })
          return mission
        }
        if (queued) {
          integrationQueue.cancel(mission.id)
          scheduleIntegrationDrain(mission.projectId)
        }
        stopMissionExecution(
          mission.projectId,
          mission.id,
          'execução pausada porque a missão foi arquivada; ao reativar, revise o transcript e rode o card novamente'
        )
      }
      const updated = missions.update(id, patch)
      if (updated) {
        if (patch.status === 'arquivada' || patch.status === 'concluida') {
          const paneId = orchPaneId(updated.projectId, id)
          if (ptys.has(paneId)) ptys.kill(paneId)
          unregisterPane(paneId)
          closeGuiPanesInBackground(id)
        }
        if (patch.status === 'concluida') {
          const projectPath = projects.get(updated.projectId)?.path
          if (projectPath) {
            try {
              const swept = discardAgentSkills(projectPath)
              for (const skillId of swept.removed) {
                blackbox.record({
                  cat: 'mcp',
                  event: 'skill-discarded',
                  actor: 'harness',
                  ids: { projectId: updated.projectId, missionId: id },
                  detail: { id: skillId, reason: 'planejamento-concluido' }
                })
              }
              if (swept.kept.length > 0) {
                blackbox.record({
                  cat: 'mcp',
                  event: 'skill-discard-kept',
                  actor: 'harness',
                  ids: { projectId: updated.projectId, missionId: id },
                  detail: { ids: swept.kept.slice(0, 12), reason: 'planejamento-concluido' }
                })
              }
            } catch (error) {
              blackbox.record({
                cat: 'mcp',
                event: 'skill-discard-failed',
                actor: 'harness',
                ids: { projectId: updated.projectId, missionId: id },
                err: error instanceof Error ? error.message : String(error)
              })
            }
          }
        }
        if (patch.status && patch.status !== mission.status) {
          hub.publish({
            projectId: updated.projectId,
            kind: 'info',
            text:
              patch.status === 'concluida'
                ? `planejamento "${updated.title}" foi CONCLUÍDO — o plano segue no mapa`
                : patch.status === 'arquivada'
                  ? `missão "${updated.title}" foi ARQUIVADA${updated.branch ? ` (branch ${updated.branch} preservada)` : ''}`
                  : `missão "${updated.title}" foi REATIVADA`,
            actor: 'user'
          })
        }
        emitMissionsChanged(updated.projectId)
        syncBoard(updated.projectId)
      }
      return updated ?? null
    },
    async remove(missionId: string, stillAuthorized: () => boolean = () => true): Promise<MissionRemovalResult> {
      if (removing.has(missionId)) return { ok: false, error: 'A exclusão desta missão já está em andamento. Aguarde o resultado.' }
      if (!stillAuthorized()) return { ok: false, error: 'A autorização mudou. Confira a missão e confirme a exclusão novamente.' }
      removing.add(missionId)
      try {
        const mission = missions.get(missionId)
        if (!mission) return { ok: false, error: 'Esta missão não foi encontrada. Atualize a lista de missões.' }
        if (!['arquivada', 'concluida'].includes(mission.status))
          return { ok: false, error: 'Esta missão está ativa. Arquive a missão antes de excluir.' }
        const project = projects.get(mission.projectId)
        if (!project) return { ok: false, error: 'O projeto desta missão não foi encontrado. Reabra o projeto e confira a lista de missões.' }
        const removal = { projectId: mission.projectId, rootPath: project.path, worktree: mission.worktree, branch: mission.branch, status: mission.status, updatedAt: mission.updatedAt }
        try {
          ensureSynkoraGitExcludes(project.path)
        } catch {
          return { ok: false, error: 'Os arquivos internos do Synkora estão versionados neste projeto. Revise essa configuração no chat do projeto antes de excluir a missão.' }
        }
        const queued = integrationQueue.getByMission(missionId)
        if (queued?.state === 'merging' || needsMissionFinalization(queued))
          return { ok: false, error: 'Esta missão tem uma integração pendente. Conclua a integração no chat da missão antes de excluir.' }
        if (queued) integrationQueue.cancel(missionId)
        stopMissionExecution(
          mission.projectId,
          missionId,
          'execução encerrada porque a missão foi excluída'
        )
        ptys.kill(orchPaneId(mission.projectId, missionId))
        await killMissionGuiPanes(missionId)
        const current = missions.get(missionId)
        if (!stillAuthorized() || !current || current.status !== removal.status || current.updatedAt !== removal.updatedAt || current.projectId !== removal.projectId ||
          current.worktree !== removal.worktree || current.branch !== removal.branch ||
          projects.get(removal.projectId)?.path !== removal.rootPath || integrationQueue.getByMission(missionId)?.state === 'merging' ||
          needsMissionFinalization(integrationQueue.getByMission(missionId)))
          return { ok: false, error: 'A missão ou sua autorização mudou durante a exclusão. Reabra a confirmação e confira o estado atual antes de tentar novamente.' }
        if (mission.worktree && existsSync(mission.worktree) &&
          (!mission.branch || !isExpectedWorktree(project.path, mission.worktree, mission.branch)))
          return { ok: false, error: 'Não consegui confirmar que a pasta pertence a esta missão. Reative a missão e confira o ambiente no chat antes de excluir.' }
        if (mission.branch && mission.worktree && existsSync(mission.worktree)) {
          const clean = isWorktreeClean(mission.worktree)
          if (clean === false)
            return { ok: false, error: 'A pasta da missão contém alterações locais. Reative a missão e peça ao agente para salvar ou revisar essas alterações antes de excluir.' }
          if (clean === undefined)
            return { ok: false, error: 'Não consegui verificar as alterações da missão pelo Git. Reative a missão e confira o ambiente no chat antes de excluir.' }
        }
        if (mission.branch && mission.worktree && !removeWorktreeAndBranch(project.path, mission.worktree, mission.branch))
          return { ok: false, error: 'Não consegui remover a pasta ou a branch da missão. Feche os programas que usam essa pasta e tente novamente; se persistir, reative a missão e investigue no chat.' }
        backlog.releaseMissionItems(missionId)
        missions.remove(missionId)
        guiSessions.forgetWhere((paneId) => isGuiMissionPaneId(paneId, missionId))
        emitBacklogChanged(mission.projectId)
        const short = missionId.slice(0, 8)
        for (const f of [
          join(project.path, '.synkora', 'missions', `${short}.PLAN.md`),
          join(project.path, '.synkora', 'runs', `mission-${short}.md`),
          join(project.path, '.synkora', 'runs', `mission-${short}.verdict`)
        ]) {
          try {
            unlinkSync(f)
          } catch { /* legacy trace may already be absent */ }
        }
        maestro.forget(orchKey(mission.projectId, missionId))
        hub.purgeMissionEvents(mission.projectId, missionId)
        hub.publish({
          projectId: mission.projectId,
          kind: 'info',
          text: `missão "${mission.title}" EXCLUÍDA (tarefas${mission.branch ? ` e branch ${mission.branch}` : ''} removidas)`,
          actor: 'user'
        })
        ctx.pushAll('tasks:changed', mission.projectId)
        emitMissionsChanged(mission.projectId)
        syncBoard(mission.projectId)
        return { ok: true }
      } catch {
        return { ok: false, error: 'Não consegui confirmar a exclusão. Atualize a lista de missões e tente novamente; se persistir, investigue no chat do projeto.' }
      } finally {
        removing.delete(missionId)
      }
    }
  }
}

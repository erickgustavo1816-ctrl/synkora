import type { MainContext } from './mainContext'
import type { Mission } from './missions'
import { missionTypeOf } from './guiMissionContracts'
import { isUnversionedProject, unversionedRefusal } from '../shared/projectVersioning'

export type MissionVersionChangeResult = { ok: true; mission: Mission } | { ok: false; error: string }

export function changeMissionVersion(
  ctx: Pick<MainContext, 'projects' | 'missions' | 'backlog' | 'integrationQueue' | 'blackbox'>,
  missionId: unknown,
  targetVersionId: unknown,
  emitMissionsChanged: (projectId: string) => void
): MissionVersionChangeResult {
  if (typeof missionId !== 'string' || !missionId.trim() || missionId.length > 256 ||
    typeof targetVersionId !== 'string' || !targetVersionId.trim() || targetVersionId.length > 256)
    return { ok: false, error: 'Escolha uma missão e uma versão válidas. Atualize a lista e tente novamente.' }

  const { projects, missions, backlog, integrationQueue, blackbox } = ctx
  const mission = missions.get(missionId)
  if (!mission)
    return { ok: false, error: 'Esta missão não foi encontrada. Atualize a lista de missões.' }
  const project = projects.get(mission.projectId)
  if (!project)
    return { ok: false, error: 'O projeto desta missão não foi encontrado. Reabra o projeto.' }
  if (isUnversionedProject(project)) return { ok: false, error: unversionedRefusal('versions') }
  if (missionTypeOf(mission) !== 'dev' || mission.kind === 'direta')
    return { ok: false, error: 'Somente missões de desenvolvimento podem alterar a versão. Escolha uma missão de desenvolvimento.' }
  if (mission.status !== 'ativa')
    return { ok: false, error: 'Somente missões ativas podem alterar a versão. Confira o estado da missão na lista.' }
  if (mission.pendingIntegrationApproval || integrationQueue.getByMission(mission.id))
    return { ok: false, error: 'Esta missão tem uma integração pendente. Resolva a integração no chat da missão antes de alterar a versão.' }

  const { versions } = backlog.missionVersionChoices(mission.projectId)
  if (!versions.some(version => version.id === targetVersionId))
    return { ok: false, error: 'Escolha uma versão aberta deste projeto. Atualize a lista de versões e tente novamente.' }
  if (mission.versionId === targetVersionId) return { ok: true, mission }

  let updated: Mission | undefined
  try {
    updated = missions.setVersion(mission.id, targetVersionId)
  } catch {
    return { ok: false, error: 'Não consegui salvar a nova versão da missão. Atualize a lista e tente novamente.' }
  }
  if (!updated)
    return { ok: false, error: 'Esta missão não foi encontrada. Atualize a lista de missões.' }
  blackbox.record({
    cat: 'app', event: 'mission-version-changed', actor: 'user',
    ids: { projectId: mission.projectId, missionId: mission.id },
    detail: { previousVersionId: mission.versionId, targetVersionId }
  })
  emitMissionsChanged(mission.projectId)
  return { ok: true, mission: updated }
}

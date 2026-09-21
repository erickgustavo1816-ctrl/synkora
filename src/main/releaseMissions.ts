import { createHash } from 'node:crypto'
import { missionTypeOf } from './guiMissionContracts'
import { needsMissionFinalization } from './missionFinalization'
import { releaseConversationError } from './releaseAuthority'
import type { MainContext } from './mainContext'
import type { MissionLifecycle } from './missionLifecycle'
import type { Mission } from './missions'
import type { PaneIdentity } from './hub'
import type { ReleaseMissionSelection, ReleaseMissionToolkit } from './releaseMissionTools'

export interface ReleaseMissionsDeps {
  context: Pick<MainContext, 'missions' | 'projects' | 'backlog' | 'integrationQueue' | 'hub'>
  lifecycle: Pick<MissionLifecycle, 'update' | 'remove'>
  releaseBusy(projectId: string): boolean
  audit(event: string, projectId: string, releaseId: string, targetId: string): void
}

export function buildReleaseMissions(deps: ReleaseMissionsDeps): ReleaseMissionToolkit {
  const { missions, projects, backlog, integrationQueue, hub } = deps.context
  const revision = (mission: Mission): string => createHash('sha256').update(JSON.stringify(mission)).digest('hex')
  const failure = (error: string): string => JSON.stringify({ ok: false, error,
    recipe: 'Leia release_missions novamente e use o ID e a revisão atuais. A própria Release termina com release_done.' })
  const snapshot = (mission: Mission) => ({ id: mission.id, title: mission.title, status: mission.status,
    type: missionTypeOf(mission), versionId: mission.versionId, goal: mission.goal, scope: mission.scope,
    revision: revision(mission), integration: integrationQueue.getByMission(mission.id)?.state })
  function authorize(identity: PaneIdentity): string | undefined {
    const live = hub.identityByPane(identity.paneId)
    const mission = identity.missionId ? missions.get(identity.missionId) : undefined
    const project = projects.get(identity.projectId)
    const version = mission?.versionId ? backlog.getVersion(mission.versionId) : undefined
    return releaseConversationError({ identity, live, mission, project, version })
  }
  function selected(identity: PaneIdentity, input: ReleaseMissionSelection): { mission: Mission } | { error: string } {
    const error = authorize(identity)
    if (error) return { error }
    if (deps.releaseBusy(identity.projectId)) return { error: 'Uma operação de release está em andamento. Aguarde e leia release_status.' }
    const mission = missions.get(input.missionId)
    if (!mission || mission.projectId !== identity.projectId) return { error: 'Missão não encontrada neste projeto.' }
    if (mission.id === identity.missionId) return { error: 'Esta é a própria Release. Use release_done para encerrá-la.' }
    if (revision(mission) !== input.expectedRevision) return { error: 'A missão mudou desde a leitura. Confira o novo estado antes de alterar.' }
    const ticket = integrationQueue.getByMission(mission.id)
    if (mission.status === 'integrando' || ticket?.state === 'merging' || needsMissionFinalization(ticket))
      return { error: 'A missão está em integração ou aguarda finalização. Conclua esse fluxo no chat da missão antes de alterá-la.' }
    return { mission }
  }
  function audit(event: string, identity: PaneIdentity, targetId: string): void {
    try { deps.audit(event, identity.projectId, identity.missionId!, targetId) } catch { /* preserve the operation receipt */ }
  }
  return {
    list(identity) {
      const error = authorize(identity)
      if (error) return failure(error)
      return JSON.stringify({ ok: true, missions: missions.list(identity.projectId)
        .filter(mission => mission.projectId === identity.projectId).map(snapshot) })
    },
    update(identity, input) {
      const target = selected(identity, input)
      if ('error' in target) return failure(target.error)
      if (Object.keys(input).some(key => !['missionId', 'expectedRevision', 'title', 'goal', 'scope', 'status'].includes(key)))
        return failure('A edição aceita somente título, objetivo, escopo e arquivamento/reativação.')
      const { title, goal, scope, status } = input
      if ((title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) ||
        (goal !== undefined && (typeof goal !== 'string' || goal.length > 4000)) ||
        (scope !== undefined && (typeof scope !== 'string' || scope.length > 4000)) ||
        (status !== undefined && !['ativa', 'arquivada'].includes(status)))
        return failure('Campos inválidos. Não é possível concluir ou integrar uma missão por esta ferramenta.')
      if (status && !['ativa', 'arquivada'].includes(target.mission.status))
        return failure('Missões concluídas não são reabertas. Escolha outra missão para trabalho novo.')
      const patch = { ...(title !== undefined ? { title: title.trim() } : {}),
        ...(goal !== undefined ? { goal } : {}), ...(scope !== undefined ? { scope } : {}), ...(status ? { status } : {}) }
      if (!Object.keys(patch).length) return failure('Informe pelo menos um campo para editar.')
      try {
        const updated = deps.lifecycle.update(target.mission.id, patch)
        if (!updated || (status && updated.status !== status)) return failure('A edição não foi aplicada; a missão pode estar ocupada.')
        audit('release-mission-updated', identity, updated.id)
        return JSON.stringify({ ok: true, mission: snapshot(updated) })
      } catch {
        return failure('Não consegui confirmar a edição. Confira o estado da missão antes de repetir.')
      }
    },
    async remove(identity, input) {
      const target = selected(identity, input)
      if ('error' in target) return failure(target.error)
      if (input.ownerConfirmed !== true || input.confirmTitle !== target.mission.title)
        return failure('A exclusão exige o pedido explícito do dono para esta missão e a confirmação do título exato.')
      if (!['arquivada', 'concluida'].includes(target.mission.status))
        return failure('A missão está ativa. Se o dono autorizou sua exclusão, arquive com release_mission_update e releia antes de excluir.')
      try {
        const removed = await deps.lifecycle.remove(target.mission.id, () => !('error' in selected(identity, input)))
        if (!removed) return failure('A missão foi preservada: o estado mudou ou a pasta continua ocupada/com alterações. Confira antes de repetir.')
        audit('release-mission-removed', identity, target.mission.id)
        return JSON.stringify({ ok: true, missionId: target.mission.id, text: 'Missão excluída. Os commits já integrados ao produto foram preservados.' })
      } catch {
        return failure('Não consegui confirmar a exclusão. Confira o estado atual antes de repetir; não remova arquivos internos manualmente.')
      }
    }
  }
}

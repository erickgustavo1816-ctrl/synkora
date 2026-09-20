import type { ReleaseChangeScope } from './releaseChanges'

export interface ReleaseIdentityInput {
  identity: { role: string; projectId: string; missionId?: string }
  mission?: { id: string; projectId: string; missionType?: string; status: string; versionId?: string }
  version?: { id: string; projectId: string; status: string; worktree?: string; branch?: string }
  project?: { id: string; path: string }
}

/** Recovery needs the same bearer authority even when cleanup removed the
 * worktree and the ordinary correction scope is intentionally unavailable. */
export function releaseIdentityError(input: ReleaseIdentityInput): string | undefined {
  const { identity, mission, version, project } = input
  if (identity.role !== 'gui-release' || !mission || mission.missionType !== 'release' ||
    mission.id !== identity.missionId || mission.projectId !== identity.projectId ||
    !version || mission.versionId !== version.id || version.projectId !== identity.projectId ||
    !project || project.id !== identity.projectId)
    return 'esta conversa não tem autoridade sobre uma release; abra a conversa da versão no Synkora'
  if (mission.status !== 'ativa' && mission.status !== 'integrando')
    return 'esta release já foi encerrada; trabalho novo deve ir para uma missão/versão escolhida pelo dono'
  return undefined
}

/** Authority comes exclusively from the authenticated pane and persisted project/version. */
export function resolveReleaseChangeScope(input: ReleaseIdentityInput & {
  isolationValid: boolean
  intentPending: boolean
  latestVersionId?: string
  mainBranch?: string
  recordedMainBranch?: string
}): { scope: ReleaseChangeScope; error?: never } | { error: string; scope?: never } {
  const { mission, version, project } = input
  const error = releaseIdentityError(input)
  if (error) return { error }
  if (!mission || !version || !project) return { error: 'identidade da release ausente; abra a conversa da versão no Synkora' }
  if (input.intentPending)
    return { error: 'subida com finalização pendente; chame release_run para recuperar a tentativa anterior antes de usar release_save' }
  const common = { projectId: project.id, versionId: version.id, missionId: mission.id }
  if (version.status === 'aberta') {
    if (!input.isolationValid || !version.worktree || !version.branch)
      return { error: 'worktree da versão não comprovado; repare o isolamento pelo Synkora e leia release_status' }
    return { scope: { ...common, cwd: version.worktree, branch: version.branch, phase: 'before-release' } }
  }
  if (version.status !== 'lancada' || input.latestVersionId !== version.id)
    return { error: 'outra versão já assumiu a principal ou o estado divergiu; registre trabalho novo em uma missão da versão atual' }
  // Legacy releases had no recorded branch. Only conventional main/master are inferred.
  const branch = input.recordedMainBranch ??
    (input.mainBranch === 'main' || input.mainBranch === 'master' ? input.mainBranch : undefined)
  if (!branch || input.mainBranch !== branch)
    return { error: 'branch principal não comprovada; restaure a branch da subida pelo Synkora antes de salvar correções' }
  return { scope: { ...common, cwd: project.path, branch, phase: 'after-release' } }
}

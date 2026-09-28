import { currentReleasedVersion } from '../shared/directRelease'
import type { DirectReleaseVersion } from '../shared/directRelease'
import type { ReleaseTargetProbe } from './releaseTarget'

export type ReleaseWorkspaceResult = { dir: string; base: string; error?: never } | { error: string; dir?: never; base?: never }

export function resolveReleaseWorkspace(input: {
  mission: { projectId: string; versionId?: string; missionType?: string; status: string }
  project?: { id: string; path: string }
  version?: DirectReleaseVersion & { projectId: string; branch?: string; worktree?: string }
  versions: readonly DirectReleaseVersion[]
  isolationValid: boolean
  target?: ReleaseTargetProbe
  originHead?: string | null
  pendingBase?: string
}): ReleaseWorkspaceResult {
  const { mission, project, version, target } = input
  if (!project || !version || mission.missionType !== 'release' || mission.projectId !== project.id ||
    version.projectId !== project.id || mission.versionId !== version.id || !['ativa', 'integrando'].includes(mission.status))
    return { error: 'Release indisponível; receita: abra a conversa ativa da versão neste projeto.' }
  if (target?.error || !target?.branch)
    return { error: target?.error ?? 'Destino não comprovado; receita: leia release_status e escolha a branch com release_target.' }
  if (version.status === 'aberta') {
    if (!input.isolationValid || !version.worktree || !version.branch)
      return { error: 'Worktree da versão não comprovado; receita: restaure o isolamento pelo Synkora e leia release_status.' }
    return { dir: version.worktree, base: target.branch }
  }
  if (currentReleasedVersion(input.versions)?.id !== version.id || target.currentBranch !== target.branch || target.needsSwitch)
    return { error: 'A versão ou a branch atual mudou; receita: confira release_status e abra uma release da versão atual.' }
  // origin is the last locally observed shipped boundary. Without it, only
  // unpushed correction receipts prove a historical base; HEAD shows local edits.
  return { dir: project.path, base: input.originHead ?? input.pendingBase ?? 'HEAD' }
}

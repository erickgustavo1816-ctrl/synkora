import type { MainContext } from './mainContext'
import type { Version } from './backlog'
import type { CreateVersionResult } from './ipc/backlog'
import { currentReleasedVersion, directReleaseInputError, type DirectReleaseInput, type DirectReleaseResult } from '../shared/directRelease'
import { ensureReleaseMission } from './releaseChat'

interface DirectReleaseDeps {
  context: Pick<MainContext, 'projects' | 'backlog' | 'missions' | 'blackbox'>
  createVersion(projectId: string, input: { name: string }): CreateVersionResult
  createIsolation(projectPath: string, version: Version): Promise<{ branch: string; dir: string } | null>
  isolationValid(projectPath: string, version: Version): boolean
  changed(projectId: string): void
}

export function buildDirectRelease(deps: DirectReleaseDeps) {
  const pending = new Map<string, Promise<DirectReleaseResult>>()
  const { projects, backlog, missions, blackbox } = deps.context
  const refuse = (error: string): DirectReleaseResult => ({ ok: false, error: `${error}. Receita: abra Nova missão → Release e escolha a versão atual ou uma versão aberta; confira o isolamento em release_status.` })

  async function create(projectId: string, input: DirectReleaseInput): Promise<DirectReleaseResult> {
    const error = directReleaseInputError(input)
    if (error) return refuse(error)
    const project = typeof projectId === 'string' ? projects.get(projectId) : undefined
    if (!project) return refuse('Este projeto não existe mais')
    let version: Version | undefined
    if (input.newVersionName !== undefined) {
      const result = deps.createVersion(projectId, { name: input.newVersionName })
      if (!result.ok) return refuse(result.error)
      version = result.version
    } else version = backlog.getVersion(input.versionId)
    if (!version || version.projectId !== projectId) return refuse('Esta versão não pertence ao projeto')
    const currentId = () => currentReleasedVersion(backlog.listVersions(projectId))?.id
    if (version.status !== 'aberta' && version.id !== currentId()) return refuse('Somente a versão lançada atual aceita uma release direta')
    if (version.status === 'aberta') {
      if (!version.branch && !version.worktree) {
        const versionId = version.id
        const history = missions.list(projectId).some(m => m.versionId === versionId &&
          (m.status === 'concluida' || m.status === 'integrando' || m.branch || m.worktree))
        if (version.deliveries.length || history) return refuse('O isolamento desta versão tem histórico; restaure-o pelo Synkora antes de abrir a release')
        const isolation = await deps.createIsolation(project.path, version)
        const latest = backlog.getVersion(version.id)
        if (!isolation || !latest || latest.projectId !== projectId || latest.status !== 'aberta' || projects.get(projectId)?.path !== project.path)
          return refuse('Não foi possível comprovar o isolamento da versão')
        if (!latest.branch && !latest.worktree) backlog.setVersionBranch(latest.id, isolation.branch, isolation.dir)
        version = backlog.getVersion(latest.id)
        deps.changed(projectId)
      }
      if (!version || !deps.isolationValid(project.path, version)) return refuse('O worktree da versão não foi comprovado; restaure o isolamento pelo Synkora')
    }
    const result = ensureReleaseMission({
      version, missions: missions.list(projectId), directRequest: { title: input.title, currentVersionId: currentId() },
      create: value => missions.create(projectId, { ...value, direct: true }) ?? null
    })
    if (!result.ok) return refuse(result.error)
    deps.changed(projectId)
    blackbox.record({ cat: 'user', event: 'direct-release-opened', actor: 'user',
      ids: { projectId, missionId: result.missionId, ticketId: version.id }, detail: { created: result.created } })
    return { ...result, versionId: version.id }
  }

  return (projectId: string, input: DirectReleaseInput): Promise<DirectReleaseResult> => {
    const previous = pending.get(projectId)
    const operation = (previous ?? Promise.resolve()).then(() => create(projectId, input))
      .catch(() => refuse('Não consegui abrir a release; o trabalho existente foi preservado'))
    pending.set(projectId, operation)
    void operation.finally(() => { if (pending.get(projectId) === operation) pending.delete(projectId) })
    return operation
  }
}

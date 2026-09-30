import type { MainContext } from './mainContext'
import type { Version } from './backlog'
import type { CreateVersionResult } from './ipc/backlog'
import { currentReleasedVersion, directReleaseInputError, type DirectReleaseInput, type DirectReleaseResult } from '../shared/directRelease'
import { ensureReleaseMission } from './releaseChat'
import { isUnversionedProject, unversionedRefusal } from '../shared/projectVersioning'

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
  // The owner reads these in the new-mission modal: every recipe is a gesture
  // HE can make there, never an agent tool.
  const refuse = (error: string, recipe: string): DirectReleaseResult => ({ ok: false, error: `${error} — receita: ${recipe}` })
  const PICK_AGAIN = 'escolha no ⇪ release a versão atual ou uma versão não lançada'
  const RETRY_OR_NEW = 'tente de novo; se repetir, escolha uma versão nova no ⇪ release'

  async function create(projectId: string, input: DirectReleaseInput): Promise<DirectReleaseResult> {
    if (isUnversionedProject(projects.get(projectId))) return { ok: false, error: unversionedRefusal('release') }
    const error = directReleaseInputError(input)
    if (error) return refuse(error, 'preencha o título e escolha um destino no ⇪ release')
    const project = typeof projectId === 'string' ? projects.get(projectId) : undefined
    if (!project) return refuse('este projeto não existe mais', 'reabra o projeto pela barra lateral')
    let version: Version | undefined
    if (input.newVersionName !== undefined) {
      const result = deps.createVersion(projectId, { name: input.newVersionName })
      if (!result.ok) return refuse(result.error, 'escolha outro número ou uma versão que já existe no ⇪ release')
      version = result.version
    } else version = backlog.getVersion(input.versionId)
    if (!version || version.projectId !== projectId) return refuse('esta versão não pertence ao projeto', PICK_AGAIN)
    const currentId = () => currentReleasedVersion(backlog.listVersions(projectId))?.id
    if (version.status !== 'aberta' && version.id !== currentId()) return refuse('entre as versões lançadas, só a atual (a mais recente) aceita release direta', PICK_AGAIN)
    if (version.status === 'aberta') {
      if (!version.branch && !version.worktree) {
        const versionId = version.id
        const history = missions.list(projectId).some(m => m.versionId === versionId &&
          (m.status === 'concluida' || m.status === 'integrando' || m.branch || m.worktree))
        if (version.deliveries.length || history) return refuse('esta versão já teve missões e perdeu a branch própria', 'escolha uma versão nova no ⇪ release')
        const isolation = await deps.createIsolation(project.path, version)
        const latest = backlog.getVersion(version.id)
        if (!isolation || !latest || latest.projectId !== projectId || latest.status !== 'aberta' || projects.get(projectId)?.path !== project.path)
          return refuse('não consegui criar a branch da versão', RETRY_OR_NEW)
        if (!latest.branch && !latest.worktree) backlog.setVersionBranch(latest.id, isolation.branch, isolation.dir)
        version = backlog.getVersion(latest.id)
        deps.changed(projectId)
      }
      if (!version || !deps.isolationValid(project.path, version)) return refuse('a branch da versão não se comprovou no disco', RETRY_OR_NEW)
    }
    const result = ensureReleaseMission({
      version, missions: missions.list(projectId), directRequest: { title: input.title, currentVersionId: currentId() },
      create: value => missions.create(projectId, { ...value, direct: true }) ?? null
    })
    if (!result.ok) return refuse(result.error, PICK_AGAIN)
    deps.changed(projectId)
    blackbox.record({ cat: 'user', event: 'direct-release-opened', actor: 'user',
      ids: { projectId, missionId: result.missionId, ticketId: version.id }, detail: { created: result.created } })
    return { ...result, versionId: version.id }
  }

  return (projectId: string, input: DirectReleaseInput): Promise<DirectReleaseResult> => {
    const previous = pending.get(projectId)
    const operation = (previous ?? Promise.resolve()).then(() => create(projectId, input))
      .catch(() => refuse('não consegui abrir a release; o trabalho existente foi preservado', 'tente de novo'))
    pending.set(projectId, operation)
    void operation.finally(() => { if (pending.get(projectId) === operation) pending.delete(projectId) })
    return operation
  }
}

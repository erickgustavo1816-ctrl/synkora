/**
 * IPC — domínio backlog (fase 1, commit 5).
 * Versões e itens de backlog: CRUD completo + o release humano
 * (backlog:releaseVersion delega ao releaseVersionImpl do index).
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { ipcMain } from 'electron'
import { ensureSynkoraGitExcludes, gitHead, removeWorktreeAndBranch } from '../worktree'
import { type BacklogItemType, type Version } from '../backlog'
import { loadProjectPlan, type ProjectPlan } from '../projectPlan'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface BacklogIpcExtras {
  emitBacklogChanged(projectId: string): void
  releaseVersionImpl(versionId: string, actor: string): Promise<string>
  versionIsolationIsValid(
    projectPath: string,
    version: Version
  ): version is Version & { branch: string; worktree: string }
}

export function registerBacklogIpc(ctx: MainContext, extras: BacklogIpcExtras): void {
  const {
    projects,
    missions,
    backlog,
    projectModeOf
  } = ctx
  const {
    emitBacklogChanged,
    releaseVersionImpl,
    versionIsolationIsValid
  } = extras
  ipcMain.handle('backlog:releaseVersion', (e, versionId: string) => {
    return releaseVersionImpl(versionId, 'user')
  })

  ipcMain.handle('backlog:listVersions', (_e, projectId: string) =>
    backlog.listVersions(projectId)
  )

  ipcMain.handle(
    'backlog:createVersion',
    (e, projectId: string, input: { name: string; theme?: string; goal?: string }) => {
      if (!input.name.trim()) return null
      // duplicada ou inferior à main → não cria (a UI só oferece opções
      // válidas; isto é a rede de segurança)
      if (backlog.validateNewVersion(projectId, input.name.trim())) return null
      const version = backlog.createVersion(projectId, { ...input, name: input.name.trim() })
      emitBacklogChanged(projectId)
      return version
    }
  )

  ipcMain.handle(
    'backlog:updateVersion',
    (e, id: string, patch: { name?: string; theme?: string; goal?: string }) => {
      const current = backlog.getVersion(id)
      if (!current) return null
      const nextName = patch.name?.trim()
      if (patch.name !== undefined && !nextName) return current
      if (
        nextName &&
        nextName.toLocaleLowerCase('pt-BR') !== current.name.toLocaleLowerCase('pt-BR')
      ) {
        if (backlog.validateVersionName(current.projectId, nextName, current.id)) return current
        const project = projects.get(current.projectId)
        if (projectModeOf(current.projectId) === 'greenfield' && project) {
          try {
            ensureSynkoraGitExcludes(project.path)
            const plan = loadProjectPlan(project.path)
            const referenced = plan?.roadmap.some(
              (item) =>
                item.version?.id === id ||
                item.release?.versionId === id ||
                item.version?.name.toLocaleLowerCase('pt-BR') ===
                  current.name.toLocaleLowerCase('pt-BR')
            )
            if (referenced) return current
          } catch {
            return current
          }
        }
      }
      const updated = backlog.updateVersion(id, {
        ...(nextName ? { name: nextName } : {}),
        ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
        ...(patch.goal !== undefined ? { goal: patch.goal } : {})
      })
      if (updated) emitBacklogChanged(updated.projectId)
      return updated ?? null
    }
  )

  ipcMain.handle('backlog:removeVersion', (e, projectId: string, id: string) => {
    // versão com branch viva: limpa worktree+branch (commits não subidos morrem
    // junto — exclusão é explícita e confirmada na UI)
    const version = backlog.getVersion(id)
    const project = projects.get(projectId)
    if (!version || version.projectId !== projectId || !project)
      return 'versão não encontrada neste projeto'
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch (error) {
      return `não excluí ${version.name}: ${error instanceof Error ? error.message : String(error)}`
    }
    const missionRefs = missions.list(projectId).filter((mission) => mission.versionId === id)
    if (missionRefs.length > 0) {
      return `não excluí ${version.name}: ela já está ligada a ${missionRefs.length} missão(ões) reais — arquive/revise o roadmap ou publique a versão; o histórico não pode ficar órfão`
    }
    if (projectModeOf(projectId) === 'greenfield') {
      let plan: ProjectPlan | undefined
      try {
        plan = loadProjectPlan(project.path)
      } catch (error) {
        return `não excluí ${version.name}: o plano mestre está inválido (${error instanceof Error ? error.message : String(error)})`
      }
      const planRefs =
        plan?.roadmap.filter(
          (item) =>
            item.release?.versionId === id ||
            item.version?.id === id ||
            item.version?.name.toLocaleLowerCase('pt-BR') ===
              version.name.toLocaleLowerCase('pt-BR')
        ) ?? []
      if (planRefs.length > 0) {
        return `não excluí ${version.name}: ela ainda aparece em ${planRefs.length} etapa(s) do plano mestre — revise e aprove o mapa antes de remover a versão`
      }
    }
    if (version.branch || version.worktree) {
      if (!versionIsolationIsValid(project.path, version)) {
        return `não excluí ${version.name}: a branch/worktree version/* não é exclusiva ou não pertence comprovadamente a este projeto`
      }
      const expectedHead = gitHead(version.worktree)
      if (!expectedHead) {
        return `não excluí ${version.name}: não consegui provar o commit atual do worktree da versão`
      }
      ctx.codeIntelligence?.invalidateWorktreeNow(version.worktree)
      if (
        !removeWorktreeAndBranch(
          project.path,
          version.worktree,
          version.branch,
          expectedHead
        )
      ) {
        return `não excluí ${version.name}: a limpeza segura da branch/worktree falhou; preservei o registro da versão para nova tentativa`
      }
    }
    backlog.removeVersion(id)
    emitBacklogChanged(projectId)
    return `versão ${version.name} excluída; os itens abertos foram movidos para a versão corrente`
  })

  ipcMain.handle('backlog:listItems', (_e, projectId: string) => backlog.listItems(projectId))

  ipcMain.handle(
    'backlog:createItem',
    (
      e,
      projectId: string,
      input: { title: string; type?: BacklogItemType; notes?: string; versionId?: string }
    ) => {
      if (!input.title.trim()) return null
      if (!projects.get(projectId)) return null
      if (input.versionId) {
        const version = backlog.getVersion(input.versionId)
        if (!version || version.projectId !== projectId) return null
      }
      const item = backlog.createItem(projectId, { ...input, title: input.title.trim() })
      emitBacklogChanged(projectId)
      return item
    }
  )

  ipcMain.handle(
    'backlog:updateItem',
    (
      e,
      projectId: string,
      id: string,
      patch: {
        title?: string
        notes?: string
        type?: BacklogItemType
        status?: 'pendente' | 'em-missao' | 'feito'
        versionId?: string | null
        missionId?: string | null
      }
    ) => {
      const current = backlog.getItem(id)
      if (!current || current.projectId !== projectId) return null
      if (typeof patch.versionId === 'string') {
        const version = backlog.getVersion(patch.versionId)
        if (!version || version.projectId !== projectId) return null
      }
      if (typeof patch.missionId === 'string') {
        const mission = missions.get(patch.missionId)
        if (!mission || mission.projectId !== projectId) return null
      }
      // null = limpar o campo (IPC não transporta undefined de forma distinta)
      const { versionId, missionId, ...rest } = patch
      const clean = {
        ...rest,
        ...(versionId !== undefined
          ? { versionId: versionId === null ? undefined : versionId }
          : {}),
        ...(missionId !== undefined
          ? { missionId: missionId === null ? undefined : missionId }
          : {})
      }
      const updated = backlog.updateItem(id, clean)
      emitBacklogChanged(projectId)
      return updated ?? null
    }
  )

  ipcMain.handle('backlog:removeItem', (e, projectId: string, id: string) => {
    const current = backlog.getItem(id)
    if (!current || current.projectId !== projectId) return false
    backlog.removeItem(id)
    emitBacklogChanged(projectId)
    return true
  })
}

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
import { app, ipcMain } from 'electron'
import { join } from 'path'
import { gitOff } from '../gitAsync'
import { buildDirectRelease } from '../directRelease'
import type { DirectReleaseInput } from '../../shared/directRelease'
import { ensureSynkoraGitExcludes, gitHead, removeWorktreeAndBranch } from '../worktree'
import { type BacklogItemType, type Version } from '../backlog'
import { ensureReleaseMission } from '../releaseChat'
import type { ReleaseRecord } from '../releasesStore'
import type { MainContext } from '../mainContext'
import { readProjectManifestVersion } from '../projectManifestVersion'
import { isUnversionedProject, unversionedRefusal } from '../../shared/projectVersioning'

/**
 * Resposta do `backlog:createVersion`. Ela deixou de ser `Version | null`
 * quando a lateral de Versões passou a aceitar um número DIGITADO pelo dono
 * (2026-08-17): enquanto todo nome vinha das sugestões calculadas, `null` era
 * um caso teórico — a tela só oferecia opções válidas. Com o campo aberto,
 * `null` virou o comportamento normal de quem erra o número, e um clique que
 * não cria nada nem diz por quê é um beco. O MOTIVO viaja junto.
 */
export type CreateVersionResult =
  | { ok: true; version: Version }
  | { ok: false; error: string }

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface BacklogIpcExtras {
  emitBacklogChanged(projectId: string): void
  releaseVersionImpl(versionId: string, actor: string): Promise<string>
  versionIsolationIsValid(
    projectPath: string,
    version: Version
  ): version is Version & { branch: string; worktree: string }
  /** R14: derruba a sessão LSP com `cwd` na raiz ANTES de remover o worktree
   *  da versão — processo com cwd na pasta trava a remoção no Windows. */
  invalidateLspRoot?(root: string): void
  /** R27F2 — o RETRATO das subidas de uma versão (entidade releasesStore),
   *  injetado pelo index: a aba Versões só LÊ. */
  listVersionReleases(versionId: string): ReleaseRecord[]
  /** RIGHTDOCK Onda B — as subidas do PROJETO (mais recente primeiro): o
   *  trilho do release mostra a última como contexto da próxima. */
  listProjectReleases(projectId: string): ReleaseRecord[]
}

export function registerBacklogIpc(ctx: MainContext, extras: BacklogIpcExtras): void {
  const {
    projects,
    missions,
    backlog,
  } = ctx
  const {
    emitBacklogChanged,
    releaseVersionImpl,
    versionIsolationIsValid,
    invalidateLspRoot,
    listVersionReleases,
    listProjectReleases
  } = extras
  const createVersion = (projectId: string, input: { name: string; theme?: string; goal?: string }): CreateVersionResult => {
    if (isUnversionedProject(projects.get(projectId))) return { ok: false, error: unversionedRefusal('versions') }
    const name = input.name.trim()
    const refusal = backlog.validateNewVersion(projectId, name)
    if (refusal) return { ok: false, error: refusal }
    const version = backlog.createVersion(projectId, { ...input, name })
    emitBacklogChanged(projectId)
    return { ok: true, version }
  }
  const directRelease = buildDirectRelease({
    context: ctx, createVersion, changed: emitBacklogChanged, isolationValid: versionIsolationIsValid,
    createIsolation: (projectPath, version) => gitOff('createVersionWorktree', projectPath,
      join(app.getPath('userData'), 'worktrees', version.projectId), version.name, version.id)
  })
  ipcMain.handle('backlog:directRelease', (_e, projectId: string, input: DirectReleaseInput) => directRelease(projectId, input))
  ipcMain.handle('backlog:releaseVersion', (e, versionId: string) => {
    const version = backlog.getVersion(versionId)
    if (version && isUnversionedProject(projects.get(version.projectId))) return unversionedRefusal('release')
    return releaseVersionImpl(versionId, 'user')
  })

  // R27F2 — o retrato da subida para a aba Versões (read-only; a entidade
  // nasce no sucesso do releaseVersionImpl e mora no releasesStore).
  ipcMain.handle('backlog:versionReleases', (_e, versionId: string): ReleaseRecord[] => {
    if (typeof versionId !== 'string' || !versionId) return []
    return listVersionReleases(versionId)
  })

  // RIGHTDOCK Onda B — o retrato POR PROJETO: a "última subida" do trilho do
  // release (mesma entidade, recorte por projectId; read-only como o irmão).
  ipcMain.handle('backlog:projectReleases', (_e, projectId: string): ReleaseRecord[] => {
    if (typeof projectId !== 'string' || !projectId) return []
    return listProjectReleases(projectId)
  })

  // R10 (2026-08-19): o botão "subir pra main" deixou de rodar a máquina — ele
  // abre (ou reencontra) a MISSÃO DE RELEASE da versão, e a tela do dono vai
  // direto para o chat dela. Quem sobe é o AGENTE, pelas ferramentas
  // release_status/release_run; o clique é o mandato.
  ipcMain.handle(
    'backlog:releaseChat',
    (_e, versionId: string): { ok: true; missionId: string } | { ok: false; error: string } => {
      const version = backlog.getVersion(versionId)
      if (!version) return { ok: false, error: 'esta versão não existe mais' }
      if (isUnversionedProject(projects.get(version.projectId))) return { ok: false, error: unversionedRefusal('release') }
      const result = ensureReleaseMission({
        version,
        missions: missions.list(version.projectId),
        create: (input) =>
          missions.create(version.projectId, {
            title: input.title,
            goal: input.goal,
            versionId: input.versionId,
            missionType: input.missionType,
            direct: true
          }) ?? null
      })
      if (result.ok) emitBacklogChanged(version.projectId)
      return result.ok ? { ok: true, missionId: result.missionId } : result
    }
  )

  ipcMain.handle('backlog:listVersions', (_e, projectId: string) =>
    isUnversionedProject(projects.get(projectId)) ? [] : backlog.listVersions(projectId)
  )

  // A versão que o produto JÁ TEM, lida do package.json da pasta do projeto
  // (a main). As telas de versão contam a partir dela em vez de pedir o número
  // ao dono. `null` = sem manifesto/sem `version`: a tela pergunta como antes.
  ipcMain.handle('backlog:manifestVersion', (_e, projectId: string): string | null => {
    const project = projects.get(projectId)
    return project ? readProjectManifestVersion(project.path) : null
  })

  ipcMain.handle(
    'backlog:createVersion',
    (
      e,
      projectId: string,
      input: { name: string; theme?: string; goal?: string }
    ): CreateVersionResult => {
      return createVersion(projectId, input)
    }
  )

  ipcMain.handle('backlog:removeVersion', (e, projectId: string, id: string) => {
    // versão com branch viva: limpa worktree+branch (commits não subidos morrem
    // junto — exclusão é explícita e confirmada na UI)
    const version = backlog.getVersion(id)
    const project = projects.get(projectId)
    if (isUnversionedProject(project)) return unversionedRefusal('versions')
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
    if (version.branch || version.worktree) {
      if (!versionIsolationIsValid(project.path, version)) {
        return `não excluí ${version.name}: a branch/worktree version/* não é exclusiva ou não pertence comprovadamente a este projeto`
      }
      const expectedHead = gitHead(version.worktree)
      if (!expectedHead) {
        return `não excluí ${version.name}: não consegui provar o commit atual do worktree da versão`
      }
      invalidateLspRoot?.(version.worktree)
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

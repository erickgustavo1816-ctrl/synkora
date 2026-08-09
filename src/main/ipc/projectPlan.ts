/**
 * IPC — domínio projectPlan (fase 1, commit 5).
 * Plano mestre pelo renderer: leitura e as DUAS pontes humanas
 * (aprovar plano / iniciar missão) que entram pelos mesmos caminhos do
 * mcpApi com o handshake de autorização 1-uso. mcpApi chega LAZY: a const
 * nasce depois no arquivo, e o registro roda depois de tudo declarado.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { ipcMain } from 'electron'
import { type McpApi } from '../mcpServer'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface ProjectPlanIpcExtras {
  humanProjectPlanApprovals: Set<string>
  humanProjectMissionStarts: Set<string>
  getMcpApi(): McpApi
}

export function registerProjectPlanIpc(ctx: MainContext, extras: ProjectPlanIpcExtras): void {
  const {
    projects,
    maestro,
    projectPlanOf
  } = ctx
  const {
    humanProjectPlanApprovals,
    humanProjectMissionStarts,
    getMcpApi
  } = extras
  // Plano mestre para a aba Mapa do renderer (read-only; a fonte é o
  // PROJECT_PLAN.json que o Maestro mantém).
  ipcMain.handle('projectPlan:get', (e, projectId: string) => {
    return projectPlanOf(projectId) ?? null
  })

  ipcMain.handle('projectPlan:approve', (e, projectId: string, expectedUpdatedAt: string) => {
    const project = projects.get(projectId)
    if (!project) return 'projeto não encontrado'
    const currentPlan = projectPlanOf(projectId)
    if (!currentPlan || currentPlan.updatedAt !== expectedUpdatedAt) {
      return 'o roadmap mudou enquanto estava aberto. Recarreguei a fotografia; revise a versão atual antes de aprovar.'
    }
    humanProjectPlanApprovals.add(projectId)
    try {
      return getMcpApi().approveProjectPlan({
        paneId: `renderer-plan-approval:${projectId}`,
        projectId,
        role: 'maestro',
        cwd: project.path
      })
    } finally {
      humanProjectPlanApprovals.delete(projectId)
    }
  })

  ipcMain.handle(
    'projectPlan:startMission',
    (e, projectId: string, itemId: string, expectedUpdatedAt: string) => {
    const project = projects.get(projectId)
    if (!project) return 'projeto não encontrado'
    const currentPlan = projectPlanOf(projectId)
    if (!currentPlan || currentPlan.updatedAt !== expectedUpdatedAt) {
      return 'o roadmap mudou enquanto estava aberto. Recarreguei a fotografia; confirme o item novamente na versão atual.'
    }
    const normalizedItemId = itemId.trim()
    const key = `${projectId}:${normalizedItemId}`
    humanProjectMissionStarts.add(key)
    try {
      return getMcpApi().startProjectMission(
        {
          paneId: `renderer-mission-start:${projectId}:${normalizedItemId}`,
          projectId,
          role: 'maestro',
          cwd: project.path
        },
        normalizedItemId
      )
    } finally {
      humanProjectMissionStarts.delete(key)
    }
    }
  )
}

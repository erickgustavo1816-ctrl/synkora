/**
 * IPC — domínio services (fase 1, commit 5).
 * Painel de serviços locais: snapshot e restart dirigido por nome.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { type SynkoraSettings } from '../settings'
import { type McpStdioLaunch } from '../mcpServer'
import { invalidateCodexMcpProtocol, prewarmCodexMcpProtocol } from '../mcpProtocol'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface ServicesIpcExtras {
  assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  transitionCodeIntelligence(
    mode: SynkoraSettings['codeIntelligenceMode'],
    restart?: boolean
  ): Promise<void>
  restartInternalMcp(): Promise<void>
  servicesSnapshot(includeLocalDetails?: boolean): unknown
  validateExternalServices(): McpStdioLaunch | undefined
}

export function registerServicesIpc(ctx: MainContext, extras: ServicesIpcExtras): void {
  const {
    seats,
    settings
  } = ctx
  const {
    assertMainRendererSender,
    transitionCodeIntelligence,
    restartInternalMcp,
    servicesSnapshot,
    validateExternalServices
  } = extras
  ipcMain.handle('services:get', (e, includeLocalDetails?: boolean) => {
    assertMainRendererSender(e)
    return servicesSnapshot(includeLocalDetails === true)
  })

  ipcMain.handle('services:restart', async (e, service: unknown) => {
    assertMainRendererSender(e)
    if (service === 'code-intelligence') {
      await transitionCodeIntelligence(settings.get().codeIntelligenceMode, true)
    } else if (service === 'internal-mcp') {
      await restartInternalMcp()
    } else if (service === 'codex-probe') {
      invalidateCodexMcpProtocol()
      await Promise.all(
        seats.list()
          .filter((seat) => seat.cli === 'codex')
          .map((seat) => prewarmCodexMcpProtocol(seats.configDirOf(seat)))
      )
    } else if (service === 'external-services') {
      validateExternalServices()
    } else {
      throw new Error('Serviço local desconhecido.')
    }
    return servicesSnapshot(false)
  })
}

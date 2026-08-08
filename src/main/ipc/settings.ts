/**
 * IPC — domínio settings (fase 1, commit 5).
 * Configurações e segredos. O cache de serviços externos (3 lets
 * compartilhados com validateExternalServices/services) vai por
 * extras.state — o dono das variáveis segue o index.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  type SettingsSecretName,
  type SynkoraSettings,
  type SynkoraSettingsPatch
} from '../settings'
import { type McpStdioLaunch } from '../mcpServer'
import { setGithubToken } from '../skillsLibrary'
import { prewarmCodexMcpProtocol } from '../mcpProtocol'
import type { MainContext } from '../mainContext'

/** Lets do closure do index que estes handlers leem/escrevem — o call
 * site entrega getters/setters fechando sobre as variáveis reais. */
export interface SettingsIpcState {
  preparedPlaywright: McpStdioLaunch | undefined
  externalServicesAvailable: boolean | null
  externalServicesCheckedAt: number | null
}

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface SettingsIpcExtras {
  assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  transitionCodeIntelligence(
    mode: SynkoraSettings['codeIntelligenceMode'],
    restart?: boolean
  ): Promise<void>
  validateExternalServices(): McpStdioLaunch | undefined
  state: SettingsIpcState
}

export function registerSettingsIpc(ctx: MainContext, extras: SettingsIpcExtras): void {
  const {
    seats,
    ptys,
    settings
  } = ctx
  const {
    assertMainRendererSender,
    transitionCodeIntelligence,
    validateExternalServices,
    state
  } = extras
  const validSettingsSecret = (value: unknown): value is SettingsSecretName =>
    value === 'openrouterKey' || value === 'githubToken'

  ipcMain.handle('settings:get', (e) => {
    assertMainRendererSender(e)
    return settings.view()
  })

  ipcMain.handle('settings:set', async (e, patch: SynkoraSettingsPatch) => {
    assertMainRendererSender(e)
    const previous = settings.get()
    const safePatch: SynkoraSettingsPatch =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    const next = settings.update(safePatch)
    ptys.setConptyDll(next.conptyDll !== false)
    setGithubToken(next.githubToken)
    if (previous.codeIntelligenceMode !== next.codeIntelligenceMode) {
      await transitionCodeIntelligence(next.codeIntelligenceMode)
    }
    if (previous.externalServicePreparation !== next.externalServicePreparation) {
      if (next.externalServicePreparation === 'automatic') {
        validateExternalServices()
        for (const seat of seats.list()) {
          if (seat.cli === 'codex') void prewarmCodexMcpProtocol(seats.configDirOf(seat))
        }
      }
      else {
        state.preparedPlaywright = undefined
        state.externalServicesAvailable = null
        state.externalServicesCheckedAt = null
      }
    }
    // Outra alteração pode ter sido persistida enquanto o fechamento do LSP
    // aguardava. Devolver o estado atual impede uma resposta tardia de fazer a
    // UI regredir para um snapshot antigo.
    return settings.view()
  })

  ipcMain.handle('settings:secret:set', (e, name: unknown, value: unknown) => {
    assertMainRendererSender(e)
    if (!validSettingsSecret(name) || typeof value !== 'string') {
      throw new Error('Credencial inválida.')
    }
    const next = settings.setSecret(name, value)
    if (name === 'githubToken') setGithubToken(next.githubToken)
    return settings.view()
  })

  ipcMain.handle('settings:secret:clear', (e, name: unknown) => {
    assertMainRendererSender(e)
    if (!validSettingsSecret(name)) throw new Error('Credencial inválida.')
    const next = settings.clearSecret(name)
    if (name === 'githubToken') setGithubToken(next.githubToken)
    return settings.view()
  })
}

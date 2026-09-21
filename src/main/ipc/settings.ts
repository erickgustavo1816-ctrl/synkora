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
  type SynkoraSettingsPatch,
  type SynkoraSettingsView
} from '../settings'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface SettingsIpcExtras {
  assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  /** F3-c4: host OU view de panes — settings GERAIS são das duas superfícies
   *  (a view lê a fonte do terminal e o zoom Ctrl+/- grava dela). */
  assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  /** ACESSIBILIDADE: escala e movimento são da JANELA, e só o main os aplica
   *  (`uiAccessibility.ts`). O index amarra na janela principal. */
  applyUiAccessibility?(view: SynkoraSettingsView): void
}

export function registerSettingsIpc(ctx: MainContext, extras: SettingsIpcExtras): void {
  const {
    ptys,
    settings
  } = ctx
  const {
    assertAppRendererSender,
    applyUiAccessibility
  } = extras
  ipcMain.handle('settings:get', (e) => {
    assertAppRendererSender(e)
    return settings.view()
  })

  ipcMain.handle('settings:set', async (e, patch: SynkoraSettingsPatch) => {
    assertAppRendererSender(e)
    const previous = settings.get()
    const safePatch: SynkoraSettingsPatch =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    const next = settings.update(safePatch)
    ptys.setConptyDll(next.conptyDll !== false)
    applyUiAccessibility?.(next)
    // F3-c4: o OUTRO lado (host ↔ view de panes) recarrega — sem isto o zoom
    // de fonte feito numa view não chegava à outra.
    ctx.pushAll('settings:changed')
    // Outra alteração pode ter sido persistida enquanto o fechamento do LSP
    // aguardava. Devolver o estado atual impede uma resposta tardia de fazer a
    // UI regredir para um snapshot antigo.
    return settings.view()
  })

}

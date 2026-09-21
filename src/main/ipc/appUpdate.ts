import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { AppUpdateController } from '../appUpdate'
import type { MainContext } from '../mainContext'

export interface AppUpdateIpcExtras {
  controller: AppUpdateController
  assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
}

/** Register inside whenReady, after instrumentIpcMain and before createWindow. */
export function registerAppUpdateIpc(ctx: MainContext, extras: AppUpdateIpcExtras): void {
  const { controller, assertMainRendererSender } = extras
  ipcMain.handle('app-update:status', event => {
    assertMainRendererSender(event)
    return controller.status()
  })
  ipcMain.handle('app-update:check', event => {
    assertMainRendererSender(event)
    return controller.check()
  })
  ipcMain.handle('app-update:download', event => {
    assertMainRendererSender(event)
    return controller.download()
  })
  ipcMain.handle('app-update:install', event => {
    assertMainRendererSender(event)
    return controller.install()
  })
  // Same route as cli:status in index.ts: pushBoard reads ctx.uiSender at send
  // time and guards destroyed webContents. status() recovers pushes lost on load.
  controller.onStatus(status => ctx.pushBoard('app-update:status', status))
}

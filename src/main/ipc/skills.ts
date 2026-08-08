/**
 * IPC — domínio skills (fase 1, commit 5).
 * Biblioteca de skills — a ilha perfeita do mapa (só ctx.skillsLib).
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { dialog, ipcMain } from 'electron'
import { type Department } from '../tasks'
import type { MainContext } from '../mainContext'

export function registerSkillsIpc(ctx: MainContext): void {
  const {
    skillsLib
  } = ctx
  ipcMain.handle('skills:list', () => skillsLib.listState())

  ipcMain.handle('skills:install', (_e, id: string) => skillsLib.install(id))

  ipcMain.handle('skills:installMany', (_e, ids: string[]) => skillsLib.installMany(ids))

  ipcMain.handle('skills:addCustom', (_e, url: string, dept: Department) =>
    skillsLib.addCustom(url, dept)
  )

  ipcMain.handle('skills:addCustomAgent', (_e, url: string, dept: Department) =>
    skillsLib.addCustomAgent(url, dept)
  )

  ipcMain.handle('skills:remove', (_e, id: string) => skillsLib.remove(id))

  ipcMain.handle('skills:update', (_e, id: string) => skillsLib.update(id))

  ipcMain.handle('skills:check', () => skillsLib.checkUpdates(true))

  // PORTABILIDADE (2026-07-30): a biblioteca inteira vai e volta num .zip —
  // levar para outro PC sem re-baixar nada (a curadoria completa não cabe na
  // quota anônima do GitHub de uma vez).
  ipcMain.handle('skills:export', async () => {
    const r = await dialog.showSaveDialog({
      title: 'Exportar biblioteca de skills',
      defaultPath: `synkora-skills-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'Biblioteca Synkora', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, msg: '' }
    return skillsLib.exportTo(r.filePath)
  })

  ipcMain.handle('skills:import', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Importar biblioteca de skills',
      properties: ['openFile'],
      filters: [{ name: 'Biblioteca Synkora', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, msg: '' }
    return skillsLib.importFrom(r.filePaths[0])
  })
}

import { resolve } from 'node:path'
import type { BrowserPaneManager } from './browserPaneContracts'
import type { GuiFileOpenResult, GuiResolvedFile } from './guiFileResolver'
import type { GuiArtifactPreviewServer } from './guiFileBrowserPreview'

export interface GuiArtifactIdentity {
  missionId: string
  projectId: string
  cwd: string
}

interface Dependencies {
  browser?: Pick<BrowserPaneManager, 'newArtifactTab' | 'tabById' | 'state' | 'closeTab' | 'popOut'>
  previews: Pick<GuiArtifactPreviewServer, 'open'>
  identity(paneId: string): GuiArtifactIdentity | undefined
}

function sameRoot(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

/** Owner clicks always create an owner tab. Never navigate the active tab:
 * that tab can belong to the agent or a helper working in the same mission. */
export function createGuiFileBrowserOpener({ browser, previews, identity }: Dependencies) {
  return async (paneId: string, file: GuiResolvedFile): Promise<GuiFileOpenResult> => {
    if (!browser) return { ok: false, reason: 'unavailable',
      error: 'o browser não está disponível; reinicie o Synkora e abra o arquivo novamente' }
    const owner = identity(paneId)
    if (!owner || !sameRoot(owner.cwd, file.rootPath)) return {
      ok: false, reason: 'unavailable', error: 'abra este arquivo na conversa da missão para usar o browser do Synkora'
    }
    const authorized = (): boolean => {
      const current = identity(paneId)
      const state = browser.state(owner.missionId)
      return current?.missionId === owner.missionId && current.projectId === owner.projectId &&
        sameRoot(current.cwd, file.rootPath) && (!state.projectId || state.projectId === owner.projectId)
    }
    if (!authorized()) return { ok: false, reason: 'denied', error: 'o browser não pertence a esta conversa; reabra a missão' }
    const preview = await previews.open(file, authorized)
    if (!preview.ok) return { ok: false, reason: 'unavailable', error: preview.error }
    let openedTabId: string | undefined
    const rollback = (): void => {
      preview.lease.close()
      if (openedTabId) {
        try { browser.closeTab(owner.missionId, openedTabId) } catch { /* tab already gone */ }
      }
    }
    try {
      if (!authorized()) { preview.lease.close(); return { ok: false, reason: 'unavailable', error: 'a conversa foi fechada; abra o arquivo novamente' } }
      const opened = await browser.newArtifactTab(owner.missionId, owner.projectId, preview.lease.url)
      if (!opened.ok) { preview.lease.close(); return { ok: false, reason: 'unavailable', error: opened.error } }
      openedTabId = opened.tabId
      if (!authorized()) {
        rollback()
        return { ok: false, reason: 'unavailable', error: 'a conversa mudou; abra o arquivo novamente' }
      }
      const tab = opened.tabId ? browser.tabById(owner.missionId, opened.tabId) : undefined
      if (!tab || tab.webContents.isDestroyed()) {
        rollback()
        return { ok: false, reason: 'unavailable', error: 'a aba foi fechada; abra o arquivo novamente' }
      }
      tab.webContents.once('destroyed', () => preview.lease.close())
      const host = browser.state(owner.missionId).host
      if (host === 'popout') {
        // The existing host owns focus/placement; never dock back or move an
        // already detached browser just because the link came from the chat.
        const visible = browser.popOut(owner.missionId)
        if (!visible.ok) { rollback(); return { ok: false, reason: 'unavailable', error: visible.error } }
      }
      return { ok: true, action: 'browser', missionId: owner.missionId, projectId: owner.projectId,
        tabId: opened.tabId, host, message: 'Aberto no browser do Synkora.' }
    } catch {
      rollback()
      return { ok: false, reason: 'unavailable', error: 'não consegui abrir esta prévia; tente novamente pelo link do arquivo' }
    }
  }
}

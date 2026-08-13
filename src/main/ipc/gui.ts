/**
 * IPC — domínio gui (Synkora 2.0, onda A — docs/GUI_PANE_CONTRACT.md).
 * Os seis canais do pane GUI. O motor mora no guiSessions; aqui só há a
 * costura: validar o remetente, delegar e empurrar `gui:live`.
 *
 * CERCA VIVA da Fase 0: register*Ipc é CHAMADO do whenReady (bloco único
 * antes do createWindow), NUNCA no import — instrumentIpcMain só cobre
 * handlers registrados depois dele.
 *
 * Sender: `assertAppRendererSender` (host OU view de panes) — quem MONTA o
 * pane é a WebContentsView do canvas (F3), então host-only trancaria o dono
 * legítimo do chat.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  GuiSessionRegistry,
  type GuiPaneSpawn,
  type GuiPermBehavior,
  type GuiResult
} from '../guiSessions'
import type { MainContext } from '../mainContext'

export interface GuiIpcExtras {
  /** F3-c4: host OU view de panes — o canvas é quem monta o pane GUI. */
  assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  /** Materializa a persona do claude em userData/prompts (teto de argv). */
  systemPromptFile(name: string, content: string): string | undefined
  /** userData/gui-sessions.json — resume pós-boot. */
  storeFile: string
}

const BEHAVIORS: GuiPermBehavior[] = ['allow', 'allow-always', 'deny']

export function registerGuiIpc(ctx: MainContext, extras: GuiIpcExtras): GuiSessionRegistry {
  const { blackbox } = ctx
  const registry = new GuiSessionRegistry({
    // pushAll: a view monta o pane e o host espelha o status (§Push do contrato).
    push: (payload) => ctx.pushAll('gui:live', payload),
    systemPromptFile: extras.systemPromptFile,
    storeFile: extras.storeFile,
    record: (event, ids, detail) =>
      blackbox.record({ cat: 'pane', event, actor: 'harness', ids, detail })
  })

  ipcMain.handle('gui:create', (e, spawn: GuiPaneSpawn): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.create(spawn)
  })

  ipcMain.handle('gui:send', (e, paneId: string, text: string): GuiResult => {
    extras.assertAppRendererSender(e)
    if (!text?.trim()) return { ok: false, error: 'mensagem vazia' }
    return registry.send(paneId, text)
  })

  ipcMain.handle(
    'gui:permission',
    (e, paneId: string, requestId: string, behavior: GuiPermBehavior): GuiResult => {
      extras.assertAppRendererSender(e)
      if (!BEHAVIORS.includes(behavior)) {
        return { ok: false, error: `decisão inválida: ${String(behavior)}` }
      }
      return registry.permission(paneId, requestId, behavior)
    }
  )

  ipcMain.handle('gui:interrupt', (e, paneId: string): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.interrupt(paneId)
  })

  ipcMain.handle('gui:kill', (e, paneId: string): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.kill(paneId)
  })

  ipcMain.handle('gui:state', (e, paneId: string): { events: unknown[] } => {
    extras.assertAppRendererSender(e)
    return registry.state(paneId)
  })

  return registry
}

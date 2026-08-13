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
import { guiMissionRoleOf, missionShortId } from '../guiMissionContracts'
import { notifyDesktop } from '../desktopNotifications'
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

const ROLE_LABEL: Record<string, string> = {
  dev: 'agente',
  reviewer: 'revisor',
  helper: 'ajudante'
}

/**
 * Quem está pedindo, em PT-BR, para a notificação de desktop. O paneId segue a
 * convenção do guiMissionContracts (`gui-<papel>-<id8>`), então o id8 basta
 * para achar a missão; sem casar, o papel sozinho já diz o essencial.
 */
function paneLabel(ctx: MainContext, paneId: string, projectId: string): string {
  const role = guiMissionRoleOf(paneId)
  if (!role) {
    const project = ctx.projects.get(projectId)
    return project ? `planejamento de ${project.name}` : 'planejamento do universo'
  }
  const short = paneId.split('-')[2] ?? ''
  const mission = ctx.missions
    .list(projectId)
    .find((candidate) => missionShortId(candidate.id) === short)
  const who = ROLE_LABEL[role] ?? role
  return mission ? `${who} · ${mission.title}` : who
}

export function registerGuiIpc(ctx: MainContext, extras: GuiIpcExtras): GuiSessionRegistry {
  const { blackbox } = ctx
  const registry = new GuiSessionRegistry({
    // pushAll: a view monta o pane e o host espelha o status (§Push do contrato).
    push: (payload) => ctx.pushAll('gui:live', payload),
    systemPromptFile: extras.systemPromptFile,
    storeFile: extras.storeFile,
    record: (event, ids, detail) =>
      blackbox.record({ cat: 'pane', event, actor: 'harness', ids, detail }),
    // ONDA D: a conversa parou pedindo permissão e o dono pode estar em outra
    // janela. O throttle por pane e a guarda de foco moram no módulo — aqui só
    // se resolve QUEM está chamando (o guiSessions não conhece missão nem
    // projeto por nome, e nunca importa electron).
    onPermissionPending: ({ paneId, projectId, toolName }) =>
      notifyDesktop({
        kind: 'attention',
        key: paneId,
        title: 'Synkora — missão esperando você',
        body: `${paneLabel(ctx, paneId, projectId)} pediu permissão para ${toolName}`
      })
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

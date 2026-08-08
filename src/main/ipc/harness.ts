/**
 * IPC — domínio harness (fase 1, commit 5).
 * Toggles do harness por projeto: bypass de permissões e "sensível ok".
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { ipcMain } from 'electron'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface HarnessIpcExtras {
  bindUiSender(sender: Electron.WebContents): void
}

export function registerHarnessIpc(ctx: MainContext, extras: HarnessIpcExtras): void {
  const {
    maestro,
    emitLog,
    hub
  } = ctx
  const {
    bindUiSender
  } = extras
  ipcMain.handle('harness:setBypass', (e, projectId: string, on: boolean) => {
    bindUiSender(e.sender)
    // on = fluxo reto (bypass); off = religa aprovações (acceptEdits/sandbox).
    maestro.update(projectId, { bypassOff: on ? undefined : true })
    emitLog(projectId, {
      kind: 'ok',
      text: on
        ? 'permissões em BYPASS — o fluxo segue reto, sem prompts (vale para panes novos)'
        : 'aprovações RELIGADAS — panes novos voltam a pedir permissão'
    })
    hub.publish({
      projectId,
      kind: 'info',
      text: on ? 'permissões em bypass (fluxo reto)' : 'aprovações religadas',
      actor: 'user'
    })
  })

  // Override do DONO para superfície sensível: em projeto cujo DOMÍNIO cita
  // PII/fiscal em toda missão (ex.: PER/DCOMP), o classificador suprimiria o
  // bypass de todo pane escritor para sempre. Este switch devolve o comando ao
  // toggle de bypass; cada pane que nasce sob o override é auditado na
  // caixa-preta (sensitive-bypass-override).
  ipcMain.handle('harness:setSensitiveBypass', (e, projectId: string, on: boolean) => {
    bindUiSender(e.sender)
    maestro.update(projectId, { sensitiveAutoOk: on ? true : undefined })
    emitLog(projectId, {
      kind: 'ok',
      text: on
        ? 'superfície sensível LIBERADA — o toggle de bypass volta a mandar (vale para panes novos; auditado na caixa-preta)'
        : 'superfície sensível PROTEGIDA — pane escritor em missão sensível volta a pedir aprovação'
    })
    hub.publish({
      projectId,
      kind: 'info',
      text: on
        ? 'superfície sensível liberada pelo usuário (bypass vale)'
        : 'superfície sensível protegida (aprovação interativa)',
      actor: 'user'
    })
  })
}

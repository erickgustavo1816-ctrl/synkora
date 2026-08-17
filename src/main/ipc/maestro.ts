/**
 * IPC — domínio maestro (fase 1, commit 6c).
 * O que o renderer legado ainda pede ao PM: o estado persistido e as
 * perguntas do ask_user. A mecânica de sessão mora no maestroEngine
 * (extras.engine). O pane TUI do PM morreu na limpa F6 — `maestro:paneSpec`
 * ficou como recusa honesta até o consumidor do renderer sair.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/máquina de fases são lidos via ctx a cada uso.
 */
import { ipcMain } from 'electron'
import {} from 'fs'
import {} from '../gitAsync'
import type { MainContext } from '../mainContext'
import type { MaestroBackend, MaestroEngine } from '../maestroEngine'

/** Dependências do closure do index ainda não migradas (mesmo padrão dos
 * outros ipc/*). O engine viaja inteiro: os handlers são a casca fina dele. */
export interface MaestroIpcExtras {
  engine: MaestroEngine
  sweepProjectFiles(projectId: string, opts?: { preserveInterruptedHelpers?: boolean }): number
  killMaestroSession(projectId: string): void
  beginProgressMaestroTurn(projectId: string, session: MaestroBackend): void
  finishProgressMaestroTurn(projectId: string, session: MaestroBackend, force?: boolean): void
  beginProgressHeadlessActivity(projectId: string, kind: 'conversation' | 'survey'): number
  endProgressHeadlessActivity(projectId: string, kind: 'conversation' | 'survey', token?: number): void
  surveySystemPromptFile: string | undefined
}

export function registerMaestroIpc(ctx: MainContext, extras: MaestroIpcExtras): void {
  const {
    maestro,
  } = ctx
  const { engine } = extras
  void engine

  ipcMain.handle('maestro:getState', (e, projectId: string) => {
    const state = maestro.get(projectId)
    return {
      log: state.log,
      contextTokens: state.contextTokens ?? null,
      contextLimit: state.contextLimit ?? null,
      contextWindow: state.contextWindow ?? null,
      model: state.model ?? null,
      effort: state.effort ?? null,
      sessionId: state.sessionId ?? null,
      seatId: state.seatId ?? null,
      version: state.version ?? null
    }
  })

  // O PANE TUI DO PM MORREU NA LIMPA F6 (2026-08-17). O handler fica como
  // RECUSA HONESTA — a mesma forma que o guard de missão direta já usava — e
  // não como canal ausente: `ipcMain.handle` removido faz o `invoke` do
  // renderer REJEITAR, e a chamada do Board legado não tem `.catch`. Some
  // junto com o consumidor, do lado do renderer.
  ipcMain.handle('maestro:paneSpec', () => null)

  // A tool `ask_user` e a fila de perguntas ao dono morreram na limpa F6
  // (2026-08-17): o canal 2.0 é o card de pergunta dentro do próprio chat.
  // Os dois handlers ficam como respostas vazias até o consumidor do renderer
  // sair — `invoke` num canal ausente REJEITA, e o Board legado não trata.
  ipcMain.handle('maestro:pendingQuestions', () => [])

  ipcMain.handle('maestro:questionSeen', () => false)

}

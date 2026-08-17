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
    projects,
    missions,
    maestro,
    scheduleProgressSnapshot
  } = ctx
  const { engine } = extras
  const {
    pendingUserQuestions,
    persistUserQuestions
  } = engine

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
      bypass: !state.bypassOff,
      sensitiveBypassOk: state.sensitiveAutoOk === true,
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

  ipcMain.handle('maestro:pendingQuestions', (e, projectId: string) => {
    // PODA PREGUIÇOSA: pergunta de projeto removido ou de missão que deixou de
    // estar viva não tem aba para pulsar — resíduo sai do arquivo aqui mesmo.
    let pruned = false
    for (const [key, q] of [...pendingUserQuestions]) {
      const projectAlive = Boolean(projects.get(q.projectId))
      const mission = q.missionKey !== 'geral' ? missions.get(q.missionKey) : undefined
      const missionAlive =
        q.missionKey === 'geral' ||
        (mission && (mission.status === 'ativa' || mission.status === 'integrando'))
      if (!projectAlive || !missionAlive) {
        pendingUserQuestions.delete(key)
        pruned = true
      }
    }
    if (pruned) persistUserQuestions()
    return [...pendingUserQuestions.values()].filter((q) => q.projectId === projectId)
  })

  ipcMain.handle('maestro:questionSeen', (e, projectId: string, missionKey: string) => {
    if (pendingUserQuestions.delete(`${projectId}--${missionKey}`)) {
      persistUserQuestions()
      scheduleProgressSnapshot()
    }
    return true
  })

}

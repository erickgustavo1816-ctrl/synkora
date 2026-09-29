/**
 * IPC — domínio projectLayout (grupos de universos, 2026-09-29).
 * A ordem do rail e os grupos: ler e aplicar UMA operação. O motor é puro
 * (`shared/projectLayoutOps`) e o store mora em `../projectLayoutStore`; aqui
 * só há a costura: validar o remetente, delegar, espalhar
 * `projectLayout:changed` (o espelho do renderer é `projectLayoutStore.ts`).
 *
 * CERCA VIVA da Fase 0: register*Ipc é CHAMADO do whenReady (bloco único antes
 * do createWindow), NUNCA no import — instrumentIpcMain só cobre handlers
 * registrados depois dele.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ProjectLayout, ProjectLayoutOp, ProjectLayoutOpResult } from '../../shared/projectLayout'
import type { ProjectLayoutStore } from '../projectLayoutStore'
import type { MainContext } from '../mainContext'

export const PROJECT_LAYOUT_CHANGED = 'projectLayout:changed'

type Push = MainContext['pushAll']

export interface ProjectLayoutIpcExtras {
  store: ProjectLayoutStore
  assertAppRendererSender(event: IpcMainInvokeEvent): void
}

/** Reconcilia com a lista de universos e espalha o layout SÓ quando mudou —
 *  chamado depois de criar ou remover um universo (ipc/projects). */
export function syncProjectLayout(store: ProjectLayoutStore, push: Push): void {
  const { layout, changed } = store.reconcile()
  if (changed) push(PROJECT_LAYOUT_CHANGED, layout)
}

export function registerProjectLayoutIpc(ctx: MainContext, extras: ProjectLayoutIpcExtras): void {
  const { store, assertAppRendererSender } = extras

  ipcMain.handle('projectLayout:get', (e): ProjectLayout => {
    assertAppRendererSender(e)
    const { layout, changed } = store.reconcile()
    if (changed) ctx.pushAll(PROJECT_LAYOUT_CHANGED, layout)
    return layout
  })

  // A operação vem do renderer sem garantia de forma: `applyProjectLayoutOp` é
  // total (lixo ou id desconhecido devolve o layout igual, nunca lança).
  ipcMain.handle('projectLayout:apply', (e, op: ProjectLayoutOp): ProjectLayoutOpResult => {
    assertAppRendererSender(e)
    const result = store.apply(op)
    ctx.pushAll(PROJECT_LAYOUT_CHANGED, result.layout)
    return result
  })
}

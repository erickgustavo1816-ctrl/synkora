/**
 * IPC — domínio progress (fase 1, commit 5).
 * Overlay de ANDAMENTO: snapshot, comandos do overlay, resize por alça
 * própria e preferências persistidas. Mesmo padrão state-accessor do voice.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { type ProgressOverlaySnapshot } from '../progressSnapshot'
import { progressOverlayExpandedSize } from '../progressOverlayWindow'
import type { MainContext } from '../mainContext'
import type { ProgressOverlayPreferences } from '../index'
import { validateProgressOpenTarget, type ProgressOpenTarget } from '../progressNavigation'
import { isGuiMissionPaneId, isGuiPlanningPaneId } from '../guiMissionContracts'

/** Lets do closure do index que estes handlers leem/escrevem — o call
 * site entrega getters/setters fechando sobre as variáveis reais. */
export interface ProgressIpcState {
  readonly progressOverlayWindow: BrowserWindow | null
  progressOverlayPreferences: ProgressOverlayPreferences | null
  mainProgressRendererReady: boolean
  readonly latestProgressSnapshot: ProgressOverlaySnapshot
}

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface ProgressIpcExtras {
  assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  assertProgressOverlaySender(event: IpcMainInvokeEvent | IpcMainEvent): void
  deliverProgressOpenTarget(target?: ProgressOpenTarget): void
  progressPanes(): readonly { paneId: string; projectId: string }[]
  hideProgressOverlay(): void
  toggleProgressOverlay(): void
  loadProgressOverlayPreferences(): ProgressOverlayPreferences
  persistProgressOverlayPreferences(): void
  progressOverlayDisplayNear(
    x: number,
    y: number,
    width?: number,
    height?: number
  ): Electron.Display
  refreshProgressSnapshot(): ProgressOverlaySnapshot
  setProgressOverlayCompact(compact: boolean): void
  showMainWindow(): void
  state: ProgressIpcState
}

export function registerProgressIpc(ctx: MainContext, extras: ProgressIpcExtras): void {
  const {
    projects,
    missions
  } = ctx
  const {
    assertMainRendererSender,
    assertProgressOverlaySender,
    deliverProgressOpenTarget,
    hideProgressOverlay,
    toggleProgressOverlay,
    loadProgressOverlayPreferences,
    persistProgressOverlayPreferences,
    progressOverlayDisplayNear,
    refreshProgressSnapshot,
    setProgressOverlayCompact,
    showMainWindow,
    state
  } = extras
  // RADAR DE ANDAMENTO: a mini recebe apenas um retrato sanitizado. Caminhos,
  // prompts, transcripts e a API privilegiada do app nunca atravessam esta ponte.
  ipcMain.on('progress:renderer-ready', (event) => {
    try {
      assertMainRendererSender(event)
      state.mainProgressRendererReady = true
      deliverProgressOpenTarget()
    } catch {
      // Um frame secundário não pode consumir a navegação pendente.
    }
  })

  ipcMain.handle('progress:overlay-open', (event) => {
    assertMainRendererSender(event)
    toggleProgressOverlay()
  })

  ipcMain.handle('progress:get-snapshot', (event) => {
    assertMainRendererSender(event)
    return refreshProgressSnapshot()
  })

  ipcMain.handle('progress:overlay-get-state', (event) => {
    assertProgressOverlaySender(event)
    const preferences = loadProgressOverlayPreferences()
    return {
      snapshot: refreshProgressSnapshot(),
      compact: preferences.compact,
      historyClearedAt: preferences.historyClearedAt ?? null
    }
  })

  ipcMain.on('progress:overlay-command', (event, value: unknown) => {
    try {
      assertProgressOverlaySender(event)
      if (!value || typeof value !== 'object') return
      const input = value as {
        command?: unknown
        projectId?: unknown
        missionId?: unknown
      }
      const allowed = new Set([
        'close',
        'compact',
        'expand',
        'clear-history',
        'open-main',
        'open-target'
      ])
      if (typeof input.command !== 'string' || !allowed.has(input.command)) return
      if (input.command === 'close') {
        hideProgressOverlay()
        return
      }
      if (input.command === 'compact' || input.command === 'expand') {
        setProgressOverlayCompact(input.command === 'compact')
        return
      }
      if (input.command === 'open-main') {
        showMainWindow()
        return
      }
      if (input.command === 'clear-history') {
        const preferences = loadProgressOverlayPreferences()
        // O corte representa exatamente o retrato que estava visível. Uma
        // conclusão criada depois dele reaparece quando o snapshot chegar.
        const clearedAt = state.latestProgressSnapshot.generatedAt
        state.progressOverlayPreferences = { ...preferences, historyClearedAt: clearedAt }
        persistProgressOverlayPreferences()
        event.sender.send('progress:overlay-history-changed', { clearedAt })
        return
      }
      const target = validateProgressOpenTarget(value, {
        projectExists: (id) => Boolean(projects.get(id)),
        mission: (id) => missions.get(id),
        missions: (id) => missions.list(id),
        panes: extras.progressPanes,
        isMissionPane: isGuiMissionPaneId,
        isPlanningPane: isGuiPlanningPaneId
      })
      if (!target) return
      showMainWindow()
      deliverProgressOpenTarget(target)
    } catch {
      // Somente a janela autenticada pode navegar para um projeto real.
    }
  })

  // Alça de redimensionamento própria do overlay expandido (janela
  // transparente não tem resize nativo no Windows): o renderer manda o
  // tamanho-alvo durante o arraste e o main aplica com os mesmos limites de
  // sempre, mantendo o canto superior esquerdo parado. O evento 'resize'
  // da janela persiste os bounds como antes.
  ipcMain.on('progress:overlay-resize', (event, value: unknown) => {
    try {
      assertProgressOverlaySender(event)
      const win = state.progressOverlayWindow
      if (!win || win.isDestroyed()) return
      if (loadProgressOverlayPreferences().compact) return
      if (!value || typeof value !== 'object') return
      const input = value as { width?: unknown; height?: unknown }
      const width = Number(input.width)
      const height = Number(input.height)
      if (!Number.isFinite(width) || !Number.isFinite(height)) return
      const bounds = win.getBounds()
      const display = progressOverlayDisplayNear(
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height
      )
      const size = progressOverlayExpandedSize(
        width,
        height,
        display.workArea.width,
        display.workArea.height
      )
      if (size.width === bounds.width && size.height === bounds.height) return
      win.setBounds({ x: bounds.x, y: bounds.y, ...size })
    } catch {
      // redimensionar é conveniência; nunca derruba o overlay
    }
  })
}

import type {
  HistoryLoadResult,
  PaletteNavigationTarget,
  TerminalMarkdownTarget
} from '../../preload'
import { queueMarkdownOpen } from './projectFileNavigation'
import { useStore } from './store'

export type CommandPaletteRoot = 'host' | 'panes'

export interface PaletteNavigationOutcome {
  close: boolean
  mounted?: boolean
  preview?: HistoryLoadResult
  error?: string
}

const PALETTE_FAILURE_EVENT = 'synkora:command-palette-failure'

export function reportPaletteNavigationFailure(message: string): void {
  window.dispatchEvent(new CustomEvent(PALETTE_FAILURE_EVENT, { detail: message }))
}

export function onPaletteNavigationFailure(listener: (message: string) => void): () => void {
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail
    if (typeof detail === 'string' && detail.trim()) listener(detail)
  }
  window.addEventListener(PALETTE_FAILURE_EVENT, handle)
  return () => window.removeEventListener(PALETTE_FAILURE_EVENT, handle)
}

function projectFileTarget(target: Extract<PaletteNavigationTarget, { kind: 'file' }>): TerminalMarkdownTarget {
  return {
    ok: true,
    action: 'markdown',
    paneId: 'command-palette',
    root: 'project',
    path: target.path,
    name: target.name,
    displayPath: target.path
  }
}

async function loadHistoryTarget(
  target: Extract<PaletteNavigationTarget, { kind: 'history' }>
): Promise<PaletteNavigationOutcome> {
  const result = await window.synkora.history.load(target.selectionId).catch(() => ({
    ok: false,
    selectionId: target.selectionId,
    error: 'não consegui carregar essa conversa antiga agora'
  } satisfies HistoryLoadResult))
  if (
    !result.ok ||
    !result.provider ||
    !result.sessionId ||
    !result.messages ||
    !result.targetMessageId ||
    result.targetCursor === undefined
  ) {
    return {
      close: false,
      preview: result,
      error: result.error ?? 'a mensagem exata não pôde ser carregada'
    }
  }
  if (!result.canMount || !result.projectId || !result.paneId) {
    return { close: false, mounted: false, preview: result }
  }

  const state = useStore.getState()
  state.openProject(result.projectId)
  state.setUniverseTab(result.projectId, 'board')
  state.setMissionTab(result.projectId, result.missionId ?? null)
  state.showGuiHistoryTarget({
    paneId: result.paneId,
    sessionId: result.sessionId,
    provider: result.provider,
    messages: result.messages,
    targetMessageId: result.targetMessageId,
    targetCursor: result.targetCursor,
    truncated: result.truncated === true
  })
  return { close: true, mounted: true }
}

/**
 * Executa no host ou encaminha da WebContentsView. A view nunca muta um store
 * irmão; o host é a única autoridade de Home/projeto/aba/missão.
 */
export async function navigateFromCommandPalette(
  target: PaletteNavigationTarget,
  root: CommandPaletteRoot
): Promise<PaletteNavigationOutcome> {
  if (root === 'panes') {
    // Sem um GuiPane naturalmente montável, o próprio overlay da view mostra
    // o transcript sanitizado e explica por que não há salto automático.
    if (target.kind === 'history' && !target.canMount) return loadHistoryTarget(target)
    window.synkora.panesView.navigateCommandTarget(target)
    return { close: true, mounted: target.kind === 'history' ? true : undefined }
  }

  const state = useStore.getState()
  if (target.kind === 'app') {
    if (target.page === 'settings') state.openSettings()
    else state.openProject(null)
    return { close: true }
  }
  if (target.kind === 'project') {
    state.openProject(target.projectId)
    state.setUniverseTab(target.projectId, target.tab)
    if (target.missionId !== undefined) state.setMissionTab(target.projectId, target.missionId)
    return { close: true }
  }
  if (target.kind === 'file') {
    state.openProject(target.projectId)
    queueMarkdownOpen(target.projectId, projectFileTarget(target))
    state.setUniverseTab(target.projectId, 'arquivos')
    return { close: true }
  }
  return loadHistoryTarget(target)
}

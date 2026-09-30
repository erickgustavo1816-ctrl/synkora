import type {
  HistoryLoadResult,
  PaletteNavigationTarget,
  TerminalMarkdownTarget
} from '../../preload'
import { projectVersioning } from '../../shared/projectVersioning'
import { paletteTabFor } from './commandPaletteScope'
import { queueMarkdownOpen } from './projectFileNavigation'
import { useStore } from './store'

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
 * O host é a única autoridade de Home/projeto/aba/missão. Havia uma segunda
 * root ('panes') que encaminhava o alvo por IPC; ela morreu com a ilha
 * panes-view na purga F6 (2026-08-17).
 */
export async function navigateFromCommandPalette(
  target: PaletteNavigationTarget
): Promise<PaletteNavigationOutcome> {
  const state = useStore.getState()
  if (target.kind === 'app') {
    if (target.page === 'settings') state.openSettings()
    else state.openProject(null)
    return { close: true }
  }
  if (target.kind === 'project') {
    // projeto sem versionamento não tem Mapa nem Versões: o destino cai na
    // aba da missão em vez de abrir uma tela que não existe nele
    const project = state.projects.find((p) => p.id === target.projectId)
    state.openProject(target.projectId)
    state.setUniverseTab(target.projectId, paletteTabFor(projectVersioning(project), target.tab))
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

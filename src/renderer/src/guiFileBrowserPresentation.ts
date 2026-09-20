import type { GuiFileOpenResult } from './guiApi'

type BrowserResult = Extract<GuiFileOpenResult, { ok: true; action: 'browser' }>

interface Presentation {
  projectId: string
  visible: boolean
  selectedMissionId: string | null | undefined
  openPanel(id: 'browser'): void
}

/** Presentation is a consequence of the owner's click, not of inspecting a
 * saved transcript. A completed request for a now-hidden mission must not
 * change the panel of the mission the owner switched to while it loaded. */
export async function presentGuiFileBrowser(
  result: BrowserResult,
  context: Presentation | null,
  popOut?: (missionId: string) => Promise<{ ok: boolean; error?: string }>
): Promise<{ ok: boolean; error?: string }> {
  if (context && (!context.visible || context.projectId !== result.projectId ||
    context.selectedMissionId !== result.missionId)) {
    return { ok: false, error: 'A prévia abriu na missão de origem. Volte à conversa para vê-la.' }
  }
  // The main already raised the existing popout. Preserve the owner's choice
  // of host instead of opening an empty dock panel next to the same page.
  if (result.host === 'popout') return { ok: true }
  if (context) { context.openPanel('browser'); return { ok: true } }
  if (popOut) {
    try { return await popOut(result.missionId) }
    catch { /* Missing presentation never becomes a false visible-success. */ }
  }
  return { ok: false, error: 'A aba foi criada. Abra o painel Browser da missão para ver o arquivo.' }
}

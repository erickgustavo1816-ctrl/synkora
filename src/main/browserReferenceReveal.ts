import type { WebContents, WebFrameMain } from 'electron'
import type { BrowserPaneManager } from './browserPaneContracts'
import type { GuiBrowserReferenceStore } from './guiBrowserReferences'
import type { GuiBrowserReferenceRevealResult } from './guiBrowserReferenceTypes'
import { browserReferenceRevealInPage } from './browserReferenceRevealPage'

interface Dependencies {
  references: GuiBrowserReferenceStore
  identity(paneId: string): { missionId?: string; projectId: string } | undefined
  browser: BrowserPaneManager
}

const STALE = 'Este elemento não está mais disponível nesta página. Selecione-o novamente nas DevTools.'
const CLOSED = 'A aba desta referência foi fechada. Abra a página e selecione o elemento novamente.'
const CANCELLED = { ok: true, cancelled: true } as const

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('reference reveal timed out')), 2000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

function frames(page: WebContents): WebFrameMain[] {
  try { return page.isDestroyed() ? [] : page.mainFrame.framesInSubtree }
  catch { return [] }
}

/** Only opaque, pane-bound IDs enter this path. It never navigates a URL,
 * activates a page control, uses a selector fallback or touches the debugger. */
export function createBrowserReferenceRevealer({ references, identity, browser }: Dependencies) {
  let sequence = 0
  let lastPage: WebContents | undefined
  return async (paneId: string, id: unknown): Promise<GuiBrowserReferenceRevealResult> => {
    let reference
    try { [reference] = references.resolve(paneId, [id]) }
    catch { return { ok: false, error: 'Esta referência não pertence a esta conversa. Selecione o elemento novamente.' } }
    const owner = identity(paneId)
    const state = browser.state(reference.missionId)
    if (!owner || owner.missionId !== reference.missionId || state.projectId !== owner.projectId) {
      return { ok: false, error: 'Abra a conversa da missão desta referência para localizar o elemento.' }
    }
    const tab = browser.tabById(reference.missionId, reference.tabId)
    if (!tab || tab.webContents.isDestroyed()) return { ok: false, error: CLOSED }
    if (!reference.targetToken) return { ok: false, error: STALE }
    const request = ++sequence
    const page = tab.webContents
    const previous = lastPage
    lastPage = page
    const script = (action: 'find' | 'show' | 'clear'): string =>
      `(${browserReferenceRevealInPage.toString()})(${JSON.stringify(reference.targetToken)},${reference.number},${request},${JSON.stringify(action)},${Date.now() + 1900})`
    const run = (frame: WebFrameMain, code: string): Promise<unknown> => bounded(frame.executeJavaScript(code))
    try {
      const toClear = new Set([...frames(page), ...(previous ? frames(previous) : [])])
      await Promise.allSettled([...toClear].map(frame => run(frame, script('clear'))))
      if (request !== sequence) return CANCELLED
      const candidates = frames(page)
      const found = await Promise.allSettled(candidates.map(frame => run(frame, script('find'))))
      if (request !== sequence) return CANCELLED
      const matches = candidates.filter((_, index) => found[index].status === 'fulfilled' && found[index].value === true)
      if (matches.length !== 1) return { ok: false, error: STALE }
      if (!browser.selectTab(reference.missionId, reference.tabId)) return { ok: false, error: CLOSED }
      // Hidden dock panels still have live pages. Reuse the existing pop-out
      // presentation when necessary instead of flashing an invisible element.
      if (state.host === 'popout' || !state.visible) {
        const presented = browser.popOut(reference.missionId)
        if (!presented.ok) return presented
      }
      await run(page.mainFrame, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
      if (request !== sequence) return CANCELLED
      const shown = await run(matches[0], script('show'))
      if (request !== sequence) return CANCELLED
      if (shown === 'hidden') return { ok: false, error: 'Este elemento está oculto no layout atual. Confira a largura indicada na referência.' }
      return shown === true ? { ok: true } : { ok: false, error: STALE }
    } catch {
      if (request !== sequence) return CANCELLED
      return { ok: false, error: 'Não consegui mostrar o elemento agora. Aguarde a página responder e tente novamente.' }
    }
  }
}

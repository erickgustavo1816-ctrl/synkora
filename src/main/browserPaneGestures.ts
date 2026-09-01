/**
 * BROWSER EMBUTIDO — OS GESTOS DO DONO (terceira metade de `./browserPane`,
 * cortada em 2026-09-01 por regra da casa: aquele arquivo cruzou ~1000 linhas
 * de novo quando a aba ganhou dono).
 *
 * Aqui moram os OITO verbos que nascem de um dedo do dono no chrome de papel —
 * a barra de URL (`navigate`), o `+` (`newTab`), ← → ⟳ (`goBack`/`goForward`/
 * `reload`), o trilho de abas (`selectTab`, `closeTab`) e o devtools
 * (`toggleDevtools`). Nada mais: o
 * motor (`createBrowserManager`, no irmão) continua dono das abas, do ⚡, das
 * notas, da captura e da geometria; a máquina de host (`./browserPaneHosting`)
 * continua dona de ONDE a página está pendurada.
 *
 * ——— o corte é de ENDEREÇO, não de contrato ———
 * Um MOVIMENTO, zero mudança de comportamento: cada corpo veio verbatim do
 * irmão. Nenhum tipo público mudou de casa e `./browserPane` não re-exporta
 * nada daqui — o que sai deste módulo é consumido por UM arquivo só (o motor),
 * e o `BrowserPaneManager` que o `ipc/browser.ts` e as suítes enxergam é byte a
 * byte o mesmo de antes. É o mesmo arranjo do corte do pop-out (2026-08-29).
 *
 * ——— por que os gestos são uma família ———
 * Todos eles têm a MESMA assinatura moral: vêm do dono, agem na aba ATIVA (ou
 * na que ele apontou), e devolvem TEXTO quando recusam — nunca um `false` mudo.
 * Nenhum deles conhece dono de aba (D1): as abas que eles criam nascem do dono
 * (`BROWSER_USER_TAB_OWNER`, aplicado pelo `openTab` do motor), e é por isso que
 * `tabOf` jamais as devolve a um agente. O `ensureTab` do agente ficou no motor,
 * do outro lado desta fronteira, de propósito.
 *
 * ——— as três leis continuam no irmão ———
 * Este módulo não anexa, não desanexa e não esconde view nenhuma. O único
 * caminho de morte de aba continua sendo o `dropTab` do motor (lei 1), que
 * chega aqui pelo contexto — e é o motor quem decide, lá, que a última aba
 * fechada encerra o browser da missão.
 *
 * ——— sem uma linha de Electron em tempo de execução ———
 * Como os irmãos: só `import type`. É isso que deixa o gate
 * (`scripts/test-browser-pane.mjs`) exercitar os sete gestos com `webContents`
 * FALSOS, em node puro, sem subir janela nenhuma.
 */
import type { WebContents } from 'electron'
import type { BrowserGestureResult } from './browserPane'
// A régua do endereço (módulo puro, sem Electron): a MESMA porta por onde o
// alvo do agente passa no motor. Importada, nunca copiada.
import { normalizeBrowserTarget, normalizeBrowserUrl } from './browserPaneUrl'

// ————————————————————————————————————————————————————————————————
// A fatia do registro que um gesto enxerga
// ————————————————————————————————————————————————————————————————

/** O que um GESTO precisa de uma aba: o id e o `webContents` (ele volta,
 *  avança, recarrega e abre o devtools — tudo em cima dele). */
export interface BrowserGestureTab {
  readonly tabId: string
  readonly wc: WebContents
}

/** A missão, do ponto de vista de QUEM RECEBE O DEDO DO DONO. O `MissionRecord`
 *  do motor a satisfaz (mesma definição, sem espelho). */
export interface BrowserGestureMission {
  readonly missionId: string
  /** O gesto da barra de URL fixa a aba ativa antes de carregar — é o único
   *  campo do registro que este módulo escreve. */
  activeTabId: string | null
}

// ————————————————————————————————————————————————————————————————
// A costura com o motor — o que a máquina pede emprestado
// ————————————————————————————————————————————————————————————————

/** `M` é o registro COMPLETO do motor e `T` a ABA completa dele (os dois
 *  satisfazem as fatias daqui): assim o irmão passa as funções dele sem um
 *  único cast, esta máquina continua enxergando só a fatia que governa, e a aba
 *  que sai de um `activeTab` volta INTEIRA para o `loadInto`/`dropTab` — sem
 *  re-buscar por id, que seria uma segunda chance de errar. */
export interface BrowserGestureContext<M extends BrowserGestureMission, T extends BrowserGestureTab> {
  /** O teardown geral já passou? Só o `+` pergunta: abrir aba num motor morto
   *  deixaria uma casca sem janela para onde voltar. */
  disposed(): boolean
  mission(missionId: string): M | undefined
  /** O `+` do dono é um dos DOIS nascimentos lazy do browser (o outro é o
   *  `browser_open` do agente) — por isso ele, e só ele, cria a missão. */
  ensureMission(missionId: string, projectId: string): M
  liveTabs(mission: M): readonly T[]
  /** A aba que o dono está OLHANDO — a régua de todo gesto sem alvo. */
  activeTab(mission: M): T | undefined
  findTab(mission: M, tabId: string): T | undefined
  /** Abre uma aba DO DONO (o `openTab` do motor com `reason: 'gesture'`, que
   *  carimba `owner: dono`). */
  openTab(
    mission: M,
    url: string | undefined
  ): Promise<{ ok: true; tab: T } | { ok: false; error: string }>
  loadInto(mission: M, tab: T, url: string): Promise<void>
  /** O ÚNICO caminho de morte de uma aba (lei 1) — com o `webContents` fechado
   *  junto, que é o que o × do dono significa. */
  dropTab(mission: M, tab: T): void
  applyLayout(mission: M): void
  /** Última aba fechada = o browser da missão acabou (a régua é do motor). */
  closeMission(missionId: string): void
  changed(missionId: string): void
}

export interface BrowserGestureMachine {
  navigate(missionId: string, url: string): Promise<BrowserGestureResult>
  newTab(missionId: string, projectId: string, url?: string): Promise<BrowserGestureResult>
  goBack(missionId: string): boolean
  goForward(missionId: string): boolean
  reload(missionId: string): boolean
  selectTab(missionId: string, tabId: string): boolean
  closeTab(missionId: string, tabId: string): boolean
  toggleDevtools(missionId: string, tabId?: string): boolean
}

// ————————————————————————————————————————————————————————————————
// A máquina
// ————————————————————————————————————————————————————————————————

export function createBrowserGestureMachine<M extends BrowserGestureMission, T extends BrowserGestureTab>(
  ctx: BrowserGestureContext<M, T>
): BrowserGestureMachine {
  /** A aba ativa de uma missão VIVA — a régua de ←, → e ⟳. */
  const active = (missionId: string): T | undefined => {
    const mission = ctx.mission(missionId)
    return mission ? ctx.activeTab(mission) : undefined
  }

  return {
    async navigate(missionId, url) {
      const mission = ctx.mission(missionId)
      if (!mission) {
        return {
          ok: false,
          error: 'o browser desta missão não está aberto — abra uma aba (+) antes de navegar'
        }
      }
      const normalized = normalizeBrowserUrl(url)
      if (!normalized.ok) return { ok: false, error: normalized.error }
      const tab = ctx.activeTab(mission)
      if (!tab) {
        const opened = await ctx.openTab(mission, normalized.url)
        return opened.ok ? { ok: true, tabId: opened.tab.tabId } : { ok: false, error: opened.error }
      }
      mission.activeTabId = tab.tabId
      await ctx.loadInto(mission, tab, normalized.url)
      ctx.changed(missionId)
      return { ok: true, tabId: tab.tabId }
    },

    async newTab(missionId, projectId, url) {
      if (ctx.disposed()) {
        return { ok: false, error: 'o browser embutido foi encerrado com a janela — reabra o app' }
      }
      const wanted = normalizeBrowserTarget(url)
      if (!wanted.ok) return { ok: false, error: wanted.error }
      const mission = ctx.ensureMission(missionId, projectId)
      const opened = await ctx.openTab(mission, wanted.url)
      return opened.ok ? { ok: true, tabId: opened.tab.tabId } : { ok: false, error: opened.error }
    },

    goBack(missionId) {
      const tab = active(missionId)
      if (!tab || !tab.wc.navigationHistory.canGoBack()) return false
      tab.wc.navigationHistory.goBack()
      ctx.changed(missionId)
      return true
    },

    goForward(missionId) {
      const tab = active(missionId)
      if (!tab || !tab.wc.navigationHistory.canGoForward()) return false
      tab.wc.navigationHistory.goForward()
      ctx.changed(missionId)
      return true
    },

    reload(missionId) {
      const tab = active(missionId)
      if (!tab) return false
      tab.wc.reload()
      ctx.changed(missionId)
      return true
    },

    selectTab(missionId, tabId) {
      const mission = ctx.mission(missionId)
      if (!mission) return false
      const tab = ctx.findTab(mission, tabId)
      if (!tab) return false
      mission.activeTabId = tab.tabId
      ctx.applyLayout(mission)
      ctx.changed(missionId)
      return true
    },

    closeTab(missionId, tabId) {
      const mission = ctx.mission(missionId)
      if (!mission) return false
      const tab = ctx.findTab(mission, tabId)
      if (!tab) return false
      ctx.dropTab(mission, tab)
      if (ctx.liveTabs(mission).length === 0) {
        // Última aba fechada = o browser da missão acabou. Devolver o processo
        // de renderer é melhor do que manter uma casca viva; o + reabre.
        ctx.closeMission(missionId)
        return true
      }
      ctx.applyLayout(mission)
      ctx.changed(missionId)
      return true
    },

    toggleDevtools(missionId, tabId) {
      const mission = ctx.mission(missionId)
      if (!mission) return false
      const tab = tabId ? ctx.findTab(mission, tabId) : ctx.activeTab(mission)
      if (!tab) return false
      if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools()
      // Modo DESTACADO: devtools acoplado roubaria metade do painel do dock e,
      // pior, mexeria na geometria de que a captura depende.
      else tab.wc.openDevTools({ mode: 'detach' })
      return true
    }
  }
}

/**
 * IPC — domínio browser (browser embutido, fatia H1 do
 * `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * A ponte entre o chrome de papel do RightDock (H3) e o `BrowserManager`
 * (`../browserPane`). Aqui só há costura: validar o remetente, resolver o
 * PROJETO da missão (a partition é por projeto — D5.3) e delegar. Nenhuma
 * regra de motor mora neste arquivo.
 *
 * CERCA VIVA da Fase 0: register*Ipc é CHAMADO do whenReady (bloco único antes
 * do createWindow), NUNCA no import — instrumentIpcMain só cobre handlers
 * registrados depois dele. Quem chama é o `index.ts` (fatia H2).
 *
 * Sender: `assertAppRendererSender` — o painel mora no host, e o porteiro é o
 * mesmo das irmãs.
 *
 * BROADCAST: `browser:changed(missionId)` NÃO sai daqui. Ele sai do próprio
 * manager (`deps.push`, que o index amarra em `ctx.pushAll`), porque metade das
 * mudanças de estado nasce FORA de um gesto do dono — navegação da página,
 * título novo, download barrado, o agente dirigindo. Um segundo emissor aqui só
 * duplicaria repaint; o motor é a fonte única.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  isBrowserPanelRect,
  type BrowserGestureResult,
  type BrowserMissionState,
  type BrowserPaneManager
} from '../browserPane'
import type { MainContext } from '../mainContext'

export interface BrowserIpcExtras {
  /** Host do app — mesmo porteiro das irmãs (ipc/plans, ipc/skills…). */
  assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  /** Instância única do main, criada no index (H2). */
  browser: BrowserPaneManager
}

const MISSION_MISSING =
  'missão não encontrada — abra a missão no Board antes de usar o browser'
const BROWSER_CLOSED =
  'o browser desta missão não está aberto — abra uma aba (+) antes'
const TAB_GONE = 'esta aba não existe mais — o painel já vai se atualizar'

/** Estado neutro: missão sem browser vivo desenha "fechado" no dock. */
const CLOSED: BrowserMissionState = { alive: false, agentDriving: false, tabs: [] }

function asId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** O motor devolve booleano (contrato do design); a superfície do dono devolve
 *  TEXTO — toda recusa nomeia a receita. A tradução mora aqui, uma vez. */
function ack(done: boolean, error: string): BrowserGestureResult {
  return done ? { ok: true } : { ok: false, error }
}

export function registerBrowserIpc(ctx: MainContext, extras: BrowserIpcExtras): void {
  const { browser } = extras
  /** Recusa auditada UMA vez por webContents intruso (padrão panesView): jogar
   *  exceção num listener `.on` não responde nada a ninguém. */
  const refusedSenders = new Set<number>()

  const senderAllowed = (event: IpcMainEvent, channel: string): boolean => {
    try {
      extras.assertAppRendererSender(event)
      return true
    } catch {
      if (!refusedSenders.has(event.sender.id)) {
        refusedSenders.add(event.sender.id)
        ctx.blackbox.record({
          cat: 'pane',
          event: 'browser-ipc-refused',
          actor: 'harness',
          reason: `webContents ${event.sender.id} tentou ${channel} — só o host comanda o browser`
        })
      }
      return false
    }
  }

  /** A partition é por PROJETO (D5.3) — todo nascimento passa por aqui. */
  const projectOf = (missionId: string): string | null =>
    ctx.missions.get(missionId)?.projectId ?? null

  ipcMain.handle('browser:state', (e, missionId: unknown): BrowserMissionState => {
    extras.assertAppRendererSender(e)
    const id = asId(missionId)
    return id ? browser.state(id) : CLOSED
  })

  // Barra de URL do dono. Com o browser ainda FECHADO, o Enter é o gesto que o
  // faz nascer (lei do nascimento lazy: gesto do dono OU browser_open do
  // agente — nunca o ResizeObserver).
  ipcMain.handle(
    'browser:navigate',
    async (e, missionId: unknown, url: unknown): Promise<BrowserGestureResult> => {
      extras.assertAppRendererSender(e)
      const id = asId(missionId)
      if (!id) return { ok: false, error: MISSION_MISSING }
      if (browser.hasMission(id)) return browser.navigate(id, typeof url === 'string' ? url : '')
      const projectId = projectOf(id)
      if (!projectId) return { ok: false, error: MISSION_MISSING }
      return browser.newTab(id, projectId, typeof url === 'string' ? url : undefined)
    }
  )

  ipcMain.handle('browser:back', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertAppRendererSender(e)
    const id = asId(missionId)
    if (!id || !browser.hasMission(id)) return { ok: false, error: BROWSER_CLOSED }
    return ack(browser.goBack(id), 'não há para onde voltar nesta aba')
  })

  ipcMain.handle('browser:forward', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertAppRendererSender(e)
    const id = asId(missionId)
    if (!id || !browser.hasMission(id)) return { ok: false, error: BROWSER_CLOSED }
    return ack(browser.goForward(id), 'não há para onde avançar nesta aba')
  })

  ipcMain.handle('browser:reload', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertAppRendererSender(e)
    const id = asId(missionId)
    if (!id) return { ok: false, error: MISSION_MISSING }
    return ack(browser.reload(id), BROWSER_CLOSED)
  })

  ipcMain.handle(
    'browser:newTab',
    async (e, missionId: unknown, url: unknown): Promise<BrowserGestureResult> => {
      extras.assertAppRendererSender(e)
      const id = asId(missionId)
      if (!id) return { ok: false, error: MISSION_MISSING }
      const projectId = projectOf(id)
      if (!projectId) return { ok: false, error: MISSION_MISSING }
      return browser.newTab(id, projectId, typeof url === 'string' ? url : undefined)
    }
  )

  ipcMain.handle(
    'browser:closeTab',
    (e, missionId: unknown, tabId: unknown): BrowserGestureResult => {
      extras.assertAppRendererSender(e)
      const id = asId(missionId)
      const tab = asId(tabId)
      if (!id || !tab) return { ok: false, error: TAB_GONE }
      return ack(browser.closeTab(id, tab), TAB_GONE)
    }
  )

  ipcMain.handle(
    'browser:selectTab',
    (e, missionId: unknown, tabId: unknown): BrowserGestureResult => {
      extras.assertAppRendererSender(e)
      const id = asId(missionId)
      const tab = asId(tabId)
      if (!id || !tab) return { ok: false, error: TAB_GONE }
      return ack(browser.selectTab(id, tab), TAB_GONE)
    }
  )

  ipcMain.handle(
    'browser:devtools',
    (e, missionId: unknown, tabId: unknown): BrowserGestureResult => {
      extras.assertAppRendererSender(e)
      const id = asId(missionId)
      if (!id) return { ok: false, error: MISSION_MISSING }
      return ack(browser.toggleDevtools(id, asId(tabId) ?? undefined), BROWSER_CLOSED)
    }
  )

  // ResizeObserver do painel: volume alto, sem resposta — `.on`, como o
  // `panes-view:layout` da era F3. O retângulo vem em DIPs da PÁGINA do host
  // (titleBarStyle hidden = a página cobre a janela), a mesma base do
  // contentView; o main clampa e aplica.
  //
  // AQUI MORA A LEI 1: `visible:false` esconde com `setVisible(false)` e a view
  // continua ANEXADA — colapsar a seção, trocar de aba do dock ou abrir um
  // overlay do host jamais chamam `removeChildView` (P5: detached mata o rAF,
  // pendura a captura por 5-8s e faz o clique cair no vazio).
  ipcMain.on(
    'browser:bounds',
    (e, missionId: unknown, rect: unknown, visible: unknown) => {
      if (!senderAllowed(e, 'browser:bounds')) return
      const id = asId(missionId)
      if (!id || !isBrowserPanelRect(rect)) return
      browser.applyBounds(id, rect, visible === true)
    }
  )
}

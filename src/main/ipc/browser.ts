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
 * SENDER — o porteiro DUPLO do pop-out (2026-08-29). O browser da missão passou
 * a ter duas superfícies legítimas: o painel do dock (a janela do app) e a
 * janela DESTACADA. As duas falam pelo MESMO `api.browser` do preload, então o
 * porteiro daqui deixou de ser o `assertAppRendererSender` das irmãs e virou o
 * `assertBrowserSender` do index — que faz DUAS coisas de uma vez: recusa quem
 * não é nenhuma das duas superfícies E diz QUAL delas falou.
 *
 * Esse retorno é a AUTORIDADE DE GEOMETRIA (lei 2 do motor). A alternativa era
 * o renderer declarar quem ele é num argumento do `browser:bounds` — e foi
 * recusada por três motivos: o remetente é INFALSIFICÁVEL (o main o observa, em
 * vez de acreditar num campo do payload); ele já é o sujeito da checagem de
 * autoridade que existe de qualquer jeito, então não se cria uma segunda
 * verdade sobre "quem é este"; e o painel do dock não muda UMA LINHA
 * (`api.browser.bounds(missionId, rect, visible)` continua idêntico), o que
 * importa porque a fatia do renderer aterrissa depois desta.
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
  type BrowserHostKind,
  type BrowserMissionState,
  type BrowserPaneManager
} from '../browserPane'
import type { BrowserViewportMode } from '../browserViewport'
import type { MainContext } from '../mainContext'

export interface BrowserIpcExtras {
  /** Porteiro E identificador da superfície: joga quando o remetente não é nem
   *  o painel do dock nem uma janela destacada VIVA, e devolve qual dos dois
   *  falou. Mora no `index.ts` porque é lá que vivem as duas janelas. */
  assertBrowserSender(event: IpcMainInvokeEvent | IpcMainEvent): BrowserHostKind
  /** Instância única do main, criada no index (H2). */
  browser: BrowserPaneManager
}

const MISSION_MISSING =
  'missão não encontrada — abra a missão no Board antes de usar o browser'
const BROWSER_CLOSED =
  'o browser desta missão não está aberto — abra uma aba (+) antes'
const TAB_GONE = 'esta aba não existe mais — o painel já vai se atualizar'

/** Estado neutro: missão sem browser vivo desenha "fechado" no dock. */
const CLOSED: BrowserMissionState = {
  alive: false,
  agentDriving: false,
  tabs: [],
  host: 'dock',
  viewport: 'auto'
}

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

  /** Versão sem exceção, para os canais `.on`: devolve QUEM falou, ou `null`. */
  const senderHost = (event: IpcMainEvent, channel: string): BrowserHostKind | null => {
    try {
      return extras.assertBrowserSender(event)
    } catch {
      if (!refusedSenders.has(event.sender.id)) {
        refusedSenders.add(event.sender.id)
        ctx.blackbox.record({
          cat: 'pane',
          event: 'browser-ipc-refused',
          actor: 'harness',
          reason: `webContents ${event.sender.id} tentou ${channel} — só o painel do dock e a janela destacada comandam o browser`
        })
      }
      return null
    }
  }

  /** A partition é por PROJETO (D5.3) — todo nascimento passa por aqui. */
  const projectOf = (missionId: string): string | null =>
    ctx.missions.get(missionId)?.projectId ?? null

  ipcMain.on('browser:setDockMission', (event, value: unknown) => {
    // Popout chrome and web pages cannot publish app navigation authority.
    if (senderHost(event, 'browser:setDockMission') !== 'dock') return
    if (value === null) {
      browser.setDockMission(null)
      return
    }
    const id = asId(value)
    const mission = id ? ctx.missions.get(id) : undefined
    // Invalid/stale navigation fails closed, without opening a tab/session.
    browser.setDockMission(
      mission &&
        mission.projectId &&
        mission.direct &&
        mission.missionType !== 'release' &&
        (mission.status === 'ativa' || mission.status === 'integrando')
        ? mission.id
        : null
    )
  })

  ipcMain.handle('browser:state', (e, missionId: unknown): BrowserMissionState => {
    extras.assertBrowserSender(e)
    const id = asId(missionId)
    return id ? browser.state(id) : CLOSED
  })

  // Barra de URL do dono. Com o browser ainda FECHADO, o Enter é o gesto que o
  // faz nascer (lei do nascimento lazy: gesto do dono OU browser_open do
  // agente — nunca o ResizeObserver).
  ipcMain.handle(
    'browser:navigate',
    async (e, missionId: unknown, url: unknown): Promise<BrowserGestureResult> => {
      extras.assertBrowserSender(e)
      const id = asId(missionId)
      if (!id) return { ok: false, error: MISSION_MISSING }
      if (browser.hasMission(id)) return browser.navigate(id, typeof url === 'string' ? url : '')
      const projectId = projectOf(id)
      if (!projectId) return { ok: false, error: MISSION_MISSING }
      return browser.newTab(id, projectId, typeof url === 'string' ? url : undefined)
    }
  )

  ipcMain.handle('browser:back', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertBrowserSender(e)
    const id = asId(missionId)
    if (!id || !browser.hasMission(id)) return { ok: false, error: BROWSER_CLOSED }
    return ack(browser.goBack(id), 'não há para onde voltar nesta aba')
  })

  ipcMain.handle('browser:forward', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertBrowserSender(e)
    const id = asId(missionId)
    if (!id || !browser.hasMission(id)) return { ok: false, error: BROWSER_CLOSED }
    return ack(browser.goForward(id), 'não há para onde avançar nesta aba')
  })

  ipcMain.handle('browser:reload', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertBrowserSender(e)
    const id = asId(missionId)
    if (!id) return { ok: false, error: MISSION_MISSING }
    return ack(browser.reload(id), BROWSER_CLOSED)
  })

  ipcMain.handle(
    'browser:newTab',
    async (e, missionId: unknown, url: unknown): Promise<BrowserGestureResult> => {
      extras.assertBrowserSender(e)
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
      extras.assertBrowserSender(e)
      const id = asId(missionId)
      const tab = asId(tabId)
      if (!id || !tab) return { ok: false, error: TAB_GONE }
      return ack(browser.closeTab(id, tab), TAB_GONE)
    }
  )

  ipcMain.handle(
    'browser:selectTab',
    (e, missionId: unknown, tabId: unknown): BrowserGestureResult => {
      extras.assertBrowserSender(e)
      const id = asId(missionId)
      const tab = asId(tabId)
      if (!id || !tab) return { ok: false, error: TAB_GONE }
      return ack(browser.selectTab(id, tab), TAB_GONE)
    }
  )

  ipcMain.handle(
    'browser:devtools',
    (e, missionId: unknown, tabId: unknown): BrowserGestureResult => {
      extras.assertBrowserSender(e)
      const id = asId(missionId)
      if (!id) return { ok: false, error: MISSION_MISSING }
      return ack(browser.toggleDevtools(id, asId(tabId) ?? undefined), BROWSER_CLOSED)
    }
  )

  // A LARGURA QUE A PÁGINA ENXERGA (2026-08-29). O seletor AUTO · 375 · 768 ·
  // 1280 do chrome escreve AQUI — e a tool `browser_viewport` do agente escreve
  // no MESMO campo do motor. Uma autoridade só, de propósito: sem isso o dono
  // veria a página emulada por ordem do agente e concluiria que o site quebrou.
  ipcMain.handle(
    'browser:setViewportMode',
    (e, missionId: unknown, mode: unknown): BrowserGestureResult => {
      extras.assertBrowserSender(e)
      const id = asId(missionId)
      if (!id) return { ok: false, error: MISSION_MISSING }
      // O motor é o dono do vocabulário: ele normaliza (`'auto'` ou largura) e
      // recusa com receita o que não entender — o porteiro não adivinha nada.
      return browser.setViewportMode(id, mode as BrowserViewportMode)
    }
  )

  // ⧉ DESTACAR / REENCAIXAR. Os dois gestos são do DONO e vêm das duas
  // superfícies: o ⧉ do chrome do dock destaca; o "trazer de volta" do recibo
  // no dock e o botão da própria janela destacada reencaixam. Um `dockBack` de
  // missão que já está no dock é SUCESSO, não recusa — o dono pode clicar duas
  // vezes, e a segunda não tem por que virar um recado vermelho.
  ipcMain.handle('browser:popOut', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertBrowserSender(e)
    const id = asId(missionId)
    if (!id) return { ok: false, error: MISSION_MISSING }
    return browser.popOut(id)
  })

  ipcMain.handle('browser:dockBack', (e, missionId: unknown): BrowserGestureResult => {
    extras.assertBrowserSender(e)
    const id = asId(missionId)
    if (!id) return { ok: false, error: MISSION_MISSING }
    return browser.dockBack(id, 'gesture')
  })

  // ResizeObserver do painel: volume alto, sem resposta — `.on`, como o
  // `panes-view:layout` da era F3. O retângulo vem em DIPs da PÁGINA do host
  // (titleBarStyle hidden = a página cobre a janela), a mesma base do
  // contentView; o main clampa e aplica.
  //
  // AQUI MORA A LEI 1: `visible:false` esconde com `setVisible(false)` e a view
  // continua ANEXADA — colapsar a seção, trocar de aba do dock ou abrir um
  // overlay do host jamais chamam `removeChildView` (P5: detached mata o rAF,
  // pendura a captura por 5-8s e faz o clique cair no vazio).
  //
  // E AQUI MORA A LEI 2: o canal é o MESMO para as duas superfícies, e quem
  // separa uma da outra é o REMETENTE (nunca um campo do payload). O motor
  // ignora — com registro na caixa-preta — o relato de quem não está com a
  // página: depois do ⧉, o ResizeObserver do dock ainda dispara um ou dois
  // quadros contando de um retângulo onde não há mais nada.
  ipcMain.on(
    'browser:bounds',
    (e, missionId: unknown, rect: unknown, visible: unknown) => {
      const reporter = senderHost(e, 'browser:bounds')
      if (!reporter) return
      const id = asId(missionId)
      if (!id || !isBrowserPanelRect(rect)) return
      browser.applyBounds(id, rect, visible === true, reporter)
    }
  )
}

/**
 * BROWSER EMBUTIDO — O PANE (fatia H1 do
 * `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * Uma `WebContentsView` por ABA, agrupadas por MISSÃO, vivendo DENTRO da janela
 * do app (sem processo filho novo). O dono assiste e pode assumir o mouse; o
 * agente dirige pelas tools `browser_*` (fatia H2) em cima do MESMO webContents.
 *
 * ——— A PRIMEIRA LEI DO MOTOR, mecanizada aqui ———
 * **A VIEW NUNCA SE DESANEXA enquanto o browser da missão viver.** Esconder é
 * `setVisible(false)` (ou bounds fora/zerados) — NUNCA `removeChildView`. A
 * sonda `PROBE_BROWSER_CDP_2026-08-29.md` §P5 mediu, em binário real:
 *   - anexada e escondida: rAF vivo, `capturePage()` em 7-14 ms, pixel FRESCO,
 *     e a página navegada escondida AINDA recebe clique;
 *   - `removeChildView` (detached): rAF = 0, as DUAS rotas de captura PENDURAM
 *     (5-8 s) e o input cai no vazio;
 *   - `win.hide()`: mesmo efeito para todas as views.
 * Por isso `removeChildView` só aparece em `closeTab`/`closeMission`/`destroy`
 * (teardown de verdade) e o único esconderijo do dia a dia é `setVisible`.
 * Corolário: `captureReadiness()` RECUSA na hora — nomeando a receita — quando
 * a janela está escondida/minimizada, porque ali a captura pendura e o agente
 * perde a rodada.
 *
 * ——— A SEGUNDA LEI (pop-out, 2026-08-29): UM HOST DE CADA VEZ ———
 * A missão tem um `host`: `'dock'` (a janela do app) ou `'popout'` (janela
 * própria, `./browserPopoutWindow`). Destacar é REPARENTAR A MESMA VIEW em UM
 * PASSO — `addChildView` na janela nova, sem `removeChildView` antes (sonda
 * `PROBE_BROWSER_POPOUT_2026-08-29.md`: 4 ms no main, um quadro de 17 ms, e
 * scroll/formulário/timers/SSE/WebSocket/sessão CDP do agente atravessam
 * intactos; recriar a view perderia tudo isso). Três cercas saem daqui:
 *   1. a janela destino está VISÍVEL antes do reparent (cura 1) — quem garante
 *      é o `open()` do host de pop-out;
 *   2. geometria NUNCA se calcula de janela minimizada (cura 2) — o
 *      `contentSize()` do pop-out devolve `null` ali e o `restore` refaz o
 *      `setBounds`;
 *   3. **autoridade única sobre a geometria**: `applyBounds` só ACEITA o
 *      relato do host ATUAL. O ex-host segue reportando por um ou dois quadros
 *      depois do gesto (o ResizeObserver dele não sabe que a página saiu), e
 *      obedecer isso jogaria a view no retângulo de uma janela onde ela não
 *      está. O relato do host errado é ignorado com registro na caixa-preta.
 *
 * ——— fronteiras ———
 * Este módulo NÃO conhece CDP, MCP nem tools: ele entrega `webContents` vivos e
 * geometria honesta. O driver/probe/shot e o kit MCP são da H2; o chrome de
 * papel no RightDock é da H3. O `index.ts` (H2) instancia, registra o IPC e
 * chama `closeMission` nos mesmos pontos que matam os panes da missão. E ele
 * continua SEM UMA LINHA DE ELECTRON: o pop-out entra injetado (`deps.popouts`)
 * atrás do contrato `BrowserPopoutHost`, como o host de views.
 *
 * ——— a família (os cinco cortes, todos pela mesma porta) ———
 * Este arquivo é O MOTOR e só ele. O que era contorno virou irmão, e o que
 * cada irmão levou está dito no cabeçalho DELE:
 *   · `./browserPaneContracts` — a PROMESSA (tipos, teto, canal do broadcast);
 *   · `./browserPaneHost` — o único lugar que toca Electron de verdade;
 *   · `./browserPaneHosting` — ONDE a página está pendurada (⧉/⇤);
 *   · `./browserPaneGestures` — os OITO verbos que nascem do dedo do dono;
 *   · `./browserPaneUrl` — o endereço do dono e a sessão do projeto;
 *   · `./browserTabOwner` — DE QUEM é a aba, e quem está com o volante.
 * Em nenhum deles o ENDEREÇO público mudou: tudo continua saindo daqui (o
 * bloco "O ENDEREÇO PÚBLICO", logo abaixo dos imports), e é por isso que
 * nenhum consumidor e nenhuma suíte mudaram uma linha de import em corte
 * nenhum.
 *
 * ——— testabilidade (a suíte `test:browser-pane` da H5) ———
 * Todo contato com o Electron mora em `electronBrowserViewHost()` — hoje no
 * módulo irmão `./browserPaneHost` (o corte de 2026-08-29). O MOTOR
 * (`createBrowserManager`) só fala com `BrowserViewHost` + a superfície de
 * `WebContents` — então o gate roda com host e webContents FAKE, em node puro,
 * sem subir janela nenhuma. Nada de Electron é tocado no topo do módulo.
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type { BlackboxEventInput } from './blackbox'
// O HOST (o único lugar que toca Electron) mora no módulo irmão. O especificador
// é EXTENSIONLESS de propósito: nenhuma suíte carrega este arquivo em
// `--experimental-strip-types` — não conseguiria, a cadeia de import chega em
// `electron`, que é CJS e não entrega named exports ao ESM do node (medido) — e
// o `tsc --outDir` das suítes compiladas resolve extensionless. A dívida do
// resolvedor duplo está em `.synkora/reports/skills2-agent-F-report.md` §2.3.
import { electronBrowserViewHost } from './browserPaneHost'
import type {
  BrowserEventEmitter,
  BrowserEventListener,
  BrowserPopoutHost,
  BrowserSessionHooks,
  BrowserViewHandle,
  BrowserViewHost
} from './browserPaneHost'
// A MÁQUINA DE HOST (onde a página está pendurada: ⧉/⇤, roteamento de
// attach/detach e a geometria da janela destacada) mora no módulo irmão — o
// corte de 2026-08-29, pelo mesmo motivo do `./browserPaneHost`. Extensionless
// pela mesma razão declarada acima.
import { createBrowserHostMachine } from './browserPaneHosting'
// OS SETE GESTOS DO DONO (barra de URL, +, ← → ⟳, × e devtools) moram no módulo
// irmão desde 2026-09-01 — o mesmo corte, pelo mesmo motivo. Aqui eles só têm
// ENDEREÇO PÚBLICO: quem chama o `BrowserPaneManager` não muda uma linha.
import { createBrowserGestureMachine } from './browserPaneGestures'
// O ENDEREÇO DO DONO e a SESSÃO DO PROJETO (o corte de 2026-09-01). Puro, sem
// Electron; re-exportado logo abaixo para o endereço público não mudar.
import { browserPartitionFor, normalizeBrowserTarget, normalizeBrowserUrl } from './browserPaneUrl'
import type { BrowserHostedMission, BrowserHostedTab, BrowserMissionLayout } from './browserPaneHosting'
// A LARGURA QUE A PÁGINA ENXERGA (2026-08-29). Módulo puro, sem Electron: a
// receita medida (`setZoomFactor(moldura / larguraLógica)`) e a matemática do
// piso do Chromium moram lá; aqui mora só QUANDO ela se aplica.
import {
  applyViewportFit,
  normalizeViewportMode,
  viewportBandWidth,
  viewportEffectiveWidth,
  viewportIsClamped,
  viewportViewRect,
  type BrowserViewportMode
} from './browserViewport'
// DE QUEM É A ABA (2026-09-01). Módulo PURO, sem Electron — e IMPORTADO pelos
// dois lados da fronteira (aqui e no kit de tools `./guiBrowserTools`), porque
// dono de aba é um conceito, não um detalhe do motor. O corte também tira daqui
// a mecânica do ⚡, que passou a existir em dois lugares (missão e aba).
import {
  armBrowserDriving,
  BROWSER_AGENT_DRIVING_DECAY_MS,
  BROWSER_USER_TAB_OWNER,
  browserTabOwnedBy,
  clearBrowserDriving,
  type BrowserDrivingFlag,
  type BrowserTabOwner
} from './browserTabOwner'
// O CONTRATO (2026-09-01): os tipos que o IPC, o index, o kit de tools e as
// suítes consomem, mais os três nomes públicos. Promessa não é motor.
import {
  BROWSER_CHANGED_CHANNEL,
  BROWSER_DEFAULT_VIEW_SIZE,
  BROWSER_TAB_CAP,
  type BrowserCaptureReadiness,
  type BrowserGestureResult,
  type BrowserMissionState,
  type BrowserNotice,
  type BrowserPaneDeps,
  type BrowserPaneManager,
  type BrowserPanelRect,
  type BrowserTabView
} from './browserPaneContracts'

// ————————————————————————————————————————————————————————————————
// O ENDEREÇO PÚBLICO — o que este módulo continua entregando
// ————————————————————————————————————————————————————————————————
//
// Este arquivo foi cortado CINCO vezes (o host em 2026-08-29, a máquina de host
// no mesmo dia, e o endereço, o dono da aba, os gestos e o contrato em
// 2026-09-01), sempre pela mesma regra da casa e sempre pela mesma porta: o que
// sai daqui continua saindo DAQUI. É por isso que nenhum consumidor
// (`ipc/browser.ts`, `index.ts`, `guiBrowserTools.ts`) e nenhuma suíte mudaram
// uma linha de import em corte nenhum — e é isto que os ESPELHOS DECLARADOS do
// preload e do `dockBrowserModel` continuam encontrando por grep do nome: as
// declarações trocaram de ARQUIVO, nunca de LADO.

// O contrato: tipos, o teto de abas, a geometria de nascimento e o canal do
// broadcast. Nenhuma linha dele executa nada.
export {
  BROWSER_CHANGED_CHANNEL,
  BROWSER_DEFAULT_VIEW_SIZE,
  BROWSER_TAB_CAP,
  isBrowserPanelRect
} from './browserPaneContracts'
export type {
  BrowserCaptureReadiness,
  BrowserDockBackReason,
  BrowserGestureResult,
  BrowserHostKind,
  BrowserManager,
  BrowserMissionState,
  BrowserNotice,
  BrowserPaneDeps,
  BrowserPaneManager,
  BrowserPanelRect,
  BrowserTabView,
  MissionBrowserTab
} from './browserPaneContracts'

// O HOST — TODO o Electron do motor mora atrás desta interface, e a
// implementação real em `./browserPaneHost` (o corte de 2026-08-29).
export { electronBrowserViewHost } from './browserPaneHost'
export type {
  BrowserPopoutHandle,
  BrowserPopoutHost,
  BrowserSessionHooks,
  BrowserViewHandle,
  BrowserViewHost,
  BrowserViewWindow,
  BrowserWindowHooks
} from './browserPaneHost'

// O ENDEREÇO DO DONO e a SESSÃO DO PROJETO — duas funções puras.
export { browserPartitionFor, normalizeBrowserUrl } from './browserPaneUrl'

// DE QUEM É A ABA e o relógio do ⚡.
export {
  BROWSER_AGENT_DRIVING_DECAY_MS,
  BROWSER_USER_TAB_OWNER,
  browserTabOwnerLabel
} from './browserTabOwner'
export type { BrowserTabOwner, BrowserTabOwnerKind } from './browserTabOwner'

/** Eventos de navegação chegam em rajada — o repaint do dock é coalescido. */
const BROWSER_CHANGE_COALESCE_MS = 40
/** Teto do `loadURL` do gesto: página que não responde não prende a tool. */
const BROWSER_LOAD_TIMEOUT_MS = 20000

// ————————————————————————————————————————————————————————————————
// Estado interno
// ————————————————————————————————————————————————————————————————

/** A aba do motor É uma aba hospedada (o `wc` inteiro no lugar do mínimo que a
 *  máquina de host precisa) — uma definição só, sem espelho. */
interface TabRecord extends BrowserHostedTab, BrowserDrivingFlag {
  view: BrowserViewHandle
  wc: WebContents
  disposers: (() => void)[]
  /** POR ABA, e nasce em `auto`: o QA de responsivo é justamente ter uma aba no
   *  desktop e outra no celular. Morre com a aba (nada disto é persistido). */
  viewport: BrowserViewportMode
  /** DE QUEM é esta aba (D1). Nunca muda em vida: a aba é a mesa de trabalho de
   *  UMA identidade, e trocar o dono no meio seria a colisão de volta. */
  owner: BrowserTabOwner
}

/** O registro do motor ESTENDE a fatia que a máquina de host governa (`host`,
 *  os dois retângulos, o carimbo de relato velho — em `./browserPaneHosting`) e
 *  acrescenta o que é só daqui: abas, ⚡ e a nota. */
interface MissionRecord extends BrowserHostedMission, BrowserDrivingFlag {
  tabs: TabRecord[]
  activeTabId: string | null
  notice: BrowserNotice | null
  /** A última largura de moldura APLICADA (dock ou janela destacada). É a base
   *  do zoom e a única forma de o `state` contar a largura efetiva sem
   *  perguntar geometria de novo. `0` = ninguém relatou ainda. */
  frameWidth: number
  /** O ESTADO da narração da largura (`tem faixa`:`o piso mordeu`) da última
   *  vez que a geometria foi aplicada. Ele existe para o motor saber QUANDO
   *  vale acordar o chrome: o relato de bounds chega a cada quadro de um
   *  arrasto, e repintar o painel ali dentro devolveria a página à altura de
   *  antes do gesto por um quadro (a armadilha que a H9 pagou). */
  viewportNarration: string
}

const EMPTY_STATE: BrowserMissionState = {
  alive: false,
  agentDriving: false,
  tabs: [],
  host: 'dock',
  viewport: 'auto'
}

function roundRect(rect: BrowserPanelRect): BrowserPanelRect {
  const num = (value: number): number => (Number.isFinite(value) ? Math.round(value) : 0)
  return {
    x: num(rect.x),
    y: num(rect.y),
    width: Math.max(0, num(rect.width)),
    height: Math.max(0, num(rect.height))
  }
}


// ————————————————————————————————————————————————————————————————
// O motor
// ————————————————————————————————————————————————————————————————

export function createBrowserManager(deps: BrowserPaneDeps): BrowserPaneManager {
  const missions = new Map<string, MissionRecord>()
  let dockMissionId: string | null = null
  /** webContents.id → missão, para os ganchos da session (que são por PROJETO)
   *  saberem em qual missão o download/permissão aconteceu. */
  const owners = new Map<number, { missionId: string; projectId: string }>()
  const changePending = new Set<string>()
  let changeTimer: NodeJS.Timeout | null = null
  let unwatchWindow: (() => void) | null = null
  let host: BrowserViewHost | null = deps.host ?? null
  let disposed = false

  const now = (): number => (deps.now ? deps.now() : Date.now())

  const resolveHost = (): BrowserViewHost => {
    if (!host) host = electronBrowserViewHost(deps.window)
    return host
  }

  const record = (event: string, input: Omit<BlackboxEventInput, 'cat' | 'event'>): void => {
    deps.record({ cat: 'pane', event, ...input })
  }

  // ——— broadcast coalescido ———
  const flushChanges = (): void => {
    changeTimer = null
    const ids = [...changePending]
    changePending.clear()
    for (const missionId of ids) {
      // A barra da janela destacada conta a mesma verdade que a aba: título da
      // página que está na frente. Vem de carona no repaint coalescido (40 ms)
      // porque `page-title-updated` chega em rajada durante uma navegação.
      const mission = missions.get(missionId)
      if (mission && mission.host === 'popout') {
        deps.popouts?.get(missionId)?.setTitle(activeTitleOf(mission))
      }
      deps.push(BROWSER_CHANGED_CHANNEL, missionId)
    }
  }

  /** O que a barra da janela destacada mostra: título da página ativa, e o
   *  endereço quando a página ainda não tem título. */
  const activeTitleOf = (mission: MissionRecord): string => {
    const tab = activeRecord(mission)
    if (!tab) return ''
    const title = tab.wc.getTitle().trim()
    return title || tab.wc.getURL().trim()
  }

  const emitChanged = (missionId: string): void => {
    if (disposed) return
    changePending.add(missionId)
    if (changeTimer) return
    changeTimer = setTimeout(flushChanges, BROWSER_CHANGE_COALESCE_MS)
    changeTimer.unref?.()
  }

  const notice = (mission: MissionRecord, kind: BrowserNotice['kind'], text: string): void => {
    mission.notice = { kind, text, at: new Date(now()).toISOString() }
    emitChanged(mission.missionId)
  }

  // ——— geometria ———
  /** Refúgio de quem ainda não tem retângulo do painel (ou o tem zerado). */
  const defaultRect = (): BrowserPanelRect => {
    const size = resolveHost().contentSize()
    const fit = (want: number, have: number | undefined): number =>
      Math.max(1, Math.min(want, have ?? want))
    return {
      x: 0,
      y: 0,
      width: fit(BROWSER_DEFAULT_VIEW_SIZE.width, size?.width),
      height: fit(BROWSER_DEFAULT_VIEW_SIZE.height, size?.height)
    }
  }

  /** Clampa o retângulo relatado à área útil: encolher a janela sem o
   *  ResizeObserver ter reportado ainda deixaria a view pendurada para fora. */
  const clampTo = (
    rect: BrowserPanelRect,
    size: { width: number; height: number } | null
  ): BrowserPanelRect => {
    const bounds = roundRect(rect)
    if (!size) return bounds
    const x = Math.max(0, Math.min(bounds.x, Math.max(0, size.width - 1)))
    const y = Math.max(0, Math.min(bounds.y, Math.max(0, size.height - 1)))
    return {
      x,
      y,
      width: Math.max(0, Math.min(bounds.width, size.width - x)),
      height: Math.max(0, Math.min(bounds.height, size.height - y))
    }
  }

  const clampRect = (rect: BrowserPanelRect): BrowserPanelRect =>
    clampTo(rect, resolveHost().contentSize())

  // ——— A MÁQUINA DE HOST (`./browserPaneHosting`) ———
  // Onde a página está pendurada, os dois gestos do dono (⧉/⇤) e a geometria da
  // janela destacada. Ela não conhece abas, notas nem ⚡ — pede emprestado só o
  // que está aqui embaixo, e nada é chamado antes de existir (as funções abaixo
  // só rodam quando um gesto acontece).
  const hosting = createBrowserHostMachine<MissionRecord>({
    popouts: deps.popouts,
    viewHost: () => resolveHost(),
    mission: (missionId) => missions.get(missionId),
    missions: () => missions.values(),
    liveTabs: (mission) => liveTabs(mission),
    applyLayout: (mission) => applyLayout(mission),
    activeTitle: (mission) => activeTitleOf(mission),
    clampTo,
    // A janela destacada tem OUTRA largura — e é a largura que manda no zoom.
    // Reencaixar/destacar tem de refazer o fit no mesmo passo do `setBounds`,
    // senão a página fica com o zoom da moldura antiga.
    fitViewport: (mission, frameWidth) => fitViewport(mission, frameWidth),
    record,
    changed: (missionId) => emitChanged(missionId)
  })

  /**
   * A RECEITA MEDIDA, aplicada. Ordem importa: a aba ATIVA é a ÚLTIMA a
   * escrever. O zoom do Chromium é por ORIGEM dentro da sessão (a sonda mediu o
   * vazamento entre views irmãs do mesmo host), então com duas abas da mesma
   * missão no mesmo endereço e modos diferentes quem tem de vencer é a que o
   * dono está OLHANDO.
   */
  const fitViewport = (mission: MissionRecord, frameWidth: number): void => {
    mission.frameWidth = frameWidth
    const tabs = liveTabs(mission)
    const active = activeRecord(mission)
    for (const tab of tabs) {
      if (tab === active) continue
      applyViewportFit(tab.wc, tab.viewport, frameWidth)
    }
    if (active) applyViewportFit(active.wc, active.viewport, frameWidth)

    // ——— A NARRAÇÃO DA LARGURA (2026-08-29) ———
    // A geometria já foi aplicada acima; o que falta é o chrome CONTAR o que
    // mudou. E ele só precisa contar quando o ESTADO da narração vira:
    //  · nasceu/morreu FAIXA (a moldura passou a caber a largura pedida);
    //  · o piso de zoom do Chromium passou a morder (ou parou).
    //
    // Só isto emite — e a razão é dura, não é economia: `applyBounds` chega a
    // CADA QUADRO de um arrasto, e um `browser:changed` por quadro faria o
    // React re-renderizar o painel no meio do gesto. O `DockBrowser` escreve
    // `--dock-browser-page-h` no render a partir da fração CONGELADA (a
    // bandeira do gesto da H9), então esse render devolveria a página à altura
    // de antes do arrasto por um quadro — o pulo que a H9 pagou para matar.
    // Os dois booleanos abaixo, ao contrário, só viram quando a LARGURA da
    // moldura cruza um limite, o que não acontece durante o arrasto da ALÇA.
    //
    // (Isto também conserta um buraco da H8: arrastar o painel até o piso
    // morder mudava `viewportWidth` sem avisar ninguém, e o aviso do piso nunca
    // aparecia até a página navegar por conta própria.)
    const mode = active?.viewport ?? 'auto'
    const narration = `${viewportBandWidth(mode, frameWidth) > 0}:${viewportIsClamped(mode, frameWidth)}`
    if (mission.viewportNarration !== narration) {
      mission.viewportNarration = narration
      emitChanged(mission.missionId)
    }
  }

  /**
   * Aplica geometria e visibilidade. AQUI mora a lei 1: o laço só chama
   * `setBounds`/`setVisible`. Toda aba — inclusive a que está no fundo —
   * recebe bounds REAIS, porque a captura da H2 depende de superfície com
   * tamanho; o que muda entre ativa e inativa é só o `setVisible`.
   *
   * E aqui mora a MOLDURA DE DISPOSITIVO: os bounds de cada aba saem de
   * `viewportViewRect(modo DELA, moldura)`, que pode devolver um retângulo mais
   * ESTREITO e centralizado. Por aba, e não por missão, porque o modo é por aba:
   * a que está no fundo em 375 tem de continuar enxergando 375 quando o agente a
   * fotografa (`capturePage` é da superfície da view, não da moldura).
   */
  const applyLayout = (mission: MissionRecord): void => {
    if (mission.host === 'popout') {
      hosting.applyPopoutLayout(mission)
      return
    }
    const wanted = mission.dockLayout
    const asked = wanted && wanted.rect.width > 0 && wanted.rect.height > 0 ? clampRect(wanted.rect) : null
    // Retângulo pedido que o clamp zerou (painel inteiro fora da janela após um
    // encolhimento) não vira superfície 0×0: aí a view cai no refúgio — anexada,
    // invisível e AINDA capturável, que é o ponto todo da lei 1.
    const usable = asked !== null && asked.width > 0 && asked.height > 0
    const rect = usable && asked ? asked : defaultRect()
    const show = mission.missionId === dockMissionId && usable && wanted?.visible === true
    for (const tab of mission.tabs) {
      tab.view.setBounds(viewportViewRect(tab.viewport, rect))
      const visible = show && tab.tabId === mission.activeTabId
      if (tab.view.getVisible() !== visible) tab.view.setVisible(visible)
    }
    // O FIT SAI DA GEOMETRIA, sempre — nunca de uma lembrança. Arrastar a alça
    // do painel muda a moldura a cada quadro, e o zoom é `moldura ÷ largura
    // lógica`: sem recalcular aqui, a página deixaria de ter a largura pedida
    // (a sonda mediu: moldura 400→760 sem recálculo vira 2432 lógicos).
    fitViewport(mission, rect.width)
  }

  /** Gesto na JANELA DO APP: só as missões que estão no dock mudam de lugar. A
   *  janela destacada tem os gestos dela (`onGeometry`/`onRestored` do host). */
  const relayoutAll = (): void => {
    for (const mission of missions.values()) {
      if (mission.host === 'dock') applyLayout(mission)
    }
  }

  const ensureWindowWatch = (): void => {
    if (unwatchWindow) return
    unwatchWindow = resolveHost().watchWindow({
      onGeometry: () => relayoutAll(),
      // Janela fechada: `win.hide()`/destruição matam a captura de TODAS as
      // views (P5) — o teardown é imediato, não preguiçoso.
      onClosed: () => manager.destroy()
    })
  }

  // ——— ciclo de vida das abas ———
  const liveTabs = (mission: MissionRecord): TabRecord[] =>
    mission.tabs.filter((tab) => !tab.wc.isDestroyed())

  const findTab = (mission: MissionRecord, tabId: string): TabRecord | undefined =>
    mission.tabs.find((tab) => tab.tabId === tabId && !tab.wc.isDestroyed())

  const activeRecord = (mission: MissionRecord): TabRecord | undefined => {
    if (mission.activeTabId) {
      const found = findTab(mission, mission.activeTabId)
      if (found) return found
    }
    return liveTabs(mission)[0]
  }

  /** A aba VIVA de UMA identidade (D1). Uma identidade tem UMA aba por missão na
   *  v1 — se um dia houver mais, a primeira viva continua sendo a dela. */
  const ownedRecord = (mission: MissionRecord, ownerPaneId: string): TabRecord | undefined =>
    liveTabs(mission).find((tab) => browserTabOwnedBy(tab.owner, ownerPaneId))

  /**
   * A ABA QUE A CHAMADA ENDEREÇA. Sem `tabId` é a ATIVA — a semântica do
   * chrome do dono, que não mudou com o dono de aba; com `tabId`, a aba pedida
   * (e `undefined` quando ela já morreu, para a recusa nomear a receita em vez
   * de a chamada cair na página de um vizinho).
   */
  const targetRecord = (mission: MissionRecord, tabId?: string): TabRecord | undefined =>
    tabId === undefined ? activeRecord(mission) : findTab(mission, tabId)

  /** O ÚNICO caminho de morte de uma aba — e o ÚNICO `detach` do módulo (lei 1).
   *  `closeContents: false` = o webContents já morreu por fora (crash): a casca
   *  ainda sai da árvore, senão fica uma view vazia pendurada no contentView. */
  const dropTab = (mission: MissionRecord, tab: TabRecord, closeContents: boolean): void => {
    for (const off of tab.disposers.splice(0)) {
      try {
        off()
      } catch {
        // webContents já morto — nada a desligar
      }
    }
    owners.delete(tab.wc.id)
    // O ⚡ desta aba morre com ela: um relógio pendurado seguraria a referência
    // de uma aba fechada até decair.
    clearBrowserDriving(tab)
    mission.tabs = mission.tabs.filter((entry) => entry !== tab)
    // Detach primeiro, close depois: o inverso deixa uma view órfã se o close
    // falhar no meio do teardown. E do host CERTO: a view de uma missão
    // destacada é filha da janela do pop-out, não da janela do app.
    hosting.detachView(mission, tab.view)
    if (closeContents && !tab.wc.isDestroyed()) tab.wc.close()
    if (mission.activeTabId === tab.tabId) {
      mission.activeTabId = liveTabs(mission)[0]?.tabId ?? null
    }
  }

  const wireTab = (mission: MissionRecord, tab: TabRecord): void => {
    const wc = tab.wc
    const repaint = (): void => emitChanged(mission.missionId)
    // O `WebContents` do Electron tem ~90 sobrecargas de `on` por evento; o
    // gate roda com um fake. Uma única ponte solta (o `EventEmitter` cru, que é
    // o que as duas coisas SÃO) troca 8 casts por um.
    const emitter = wc as unknown as BrowserEventEmitter
    const on = (event: string, listener: BrowserEventListener): void => {
      emitter.on(event, listener)
      tab.disposers.push(() => emitter.off(event, listener))
    }

    // NAVEGAR PODE APAGAR O FIT. O zoom do Chromium mora num mapa por HOST: a
    // sonda viu a receita sobreviver a uma troca de origem, mas confiar nisso
    // seria depender de entrega única. Re-aplicar é idempotente e custa uma
    // comparação de float (o `applyViewportFit` só escreve quando muda) — a
    // doutrina da casa manda a ação ser RE-DERIVÁVEL.
    const repaintAndRefit = (): void => {
      applyViewportFit(tab.wc, tab.viewport, mission.frameWidth)
      repaint()
    }

    on('page-title-updated', repaint)
    on('did-start-loading', repaint)
    on('did-stop-loading', repaint)
    on('did-navigate', repaintAndRefit)
    on('did-navigate-in-page', repaint)
    on('did-finish-load', repaintAndRefit)
    on('did-fail-load', (...args) => {
      const [, errorCode, errorDescription, validatedURL, isMainFrame] = args
      // -3 = ERR_ABORTED: navegação interrompida (redirect, novo goto), não falha.
      if (isMainFrame === false || errorCode === -3) return
      notice(
        mission,
        'load-failed',
        `não carregou ${String(validatedURL).slice(0, 160)} — ${String(errorDescription || errorCode)}`
      )
    })
    on('render-process-gone', (...args) => {
      const details = args[1]
      const reason =
        details && typeof details === 'object' && 'reason' in details
          ? String((details as { reason?: unknown }).reason)
          : 'desconhecido'
      notice(mission, 'crashed', `a página caiu (${reason}) — use ⟳ para recarregar`)
    })
    on('destroyed', () => {
      // A view morreu por fora (crash irrecuperável): some do state sem
      // desanexar nada de quem continua vivo.
      dropTab(mission, tab, false)
      emitChanged(mission.missionId)
    })
    // Seletor de Bluetooth abriria um diálogo do Chromium sem UI nossa.
    on('select-bluetooth-device', (...args) => {
      const [event, , callback] = args
      if (event && typeof event === 'object' && 'preventDefault' in event) {
        ;(event as { preventDefault(): void }).preventDefault()
      }
      if (typeof callback === 'function') (callback as (id: string) => void)('')
    })

    // Pop-up/target=_blank vira ABA INTERNA (nunca janela nova, nunca o
    // navegador do sistema — o browser da missão é o lugar do teste).
    wc.setWindowOpenHandler(({ url }) => {
      const normalized = normalizeBrowserUrl(url)
      if (!normalized.ok) return { action: 'deny' }
      void openTab(mission, normalized.url, 'window-open')
      return { action: 'deny' }
    })
  }

  /**
   * O teto, dito para a mão certa. O `×` do chrome é gesto do DONO: repeti-lo
   * para um agente seria beco sem saída (ele não tem esse verbo).
   *
   * E "agente" são DUAS mãos com catálogos diferentes: quem DELEGA (o chat da
   * missão) tem `helper_cancel` e devolve uma aba encerrando um ajudante que já
   * entregou — a aba dele morre junto (D3). O AJUDANTE não tem essa tool, e
   * mandá-lo chamá-la seria o mesmo beco outra vez: a saída dele é DIZER na
   * entrega e seguir pelo que dá para verificar sem browser. A terceira porta
   * serve às duas mãos: pedir ao dono.
   */
  const capRefusal = (reason: 'gesture' | 'agent' | 'window-open'): string =>
    reason === 'agent'
      ? `teto de ${BROWSER_TAB_CAP} abas nesta missão (cada identidade tem a SUA). Receita: se você DELEGA, encerre um ajudante que já entregou (helper_cancel) — a aba dele morre junto; se você É um ajudante, diga isso na sua entrega e siga pelo que dá para verificar sem browser; ou peça ao dono para fechar uma aba (×) no painel BROWSER.`
      : `teto de ${BROWSER_TAB_CAP} abas nesta missão — feche uma aba (×) antes de abrir outra`

  /**
   * A recusa de quem endereçou uma aba que não existe. Duas frases, porque são
   * duas mãos: o DONO (sem `tabId`) ouve o `+` do chrome; o AGENTE (que sempre
   * manda a aba dele) ouve `browser_open`, que é o verbo que reabre A DELE — e
   * nunca "escolha outra aba", que seria mandá-lo mexer na página de um vizinho.
   */
  const missingTabRefusal = (tabId: string | undefined, verb: string): string =>
    tabId === undefined
      ? `o browser desta missão não está aberto — abra uma aba (+) antes de ${verb}`
      : `a aba que você pediu não existe mais nesta missão — chame browser_open para reabrir a SUA aba antes de ${verb}`

  const loadInto = async (mission: MissionRecord, tab: TabRecord, url: string): Promise<void> => {
    let settled = false
    const watchdog = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (settled) return
        notice(
          mission,
          'load-failed',
          `${url.slice(0, 160)} passou de ${Math.round(BROWSER_LOAD_TIMEOUT_MS / 1000)}s carregando — a aba segue viva; use browser_wait ou ⟳`
        )
        resolve()
      }, BROWSER_LOAD_TIMEOUT_MS)
      timer.unref?.()
    })
    const load = tab.wc
      .loadURL(url)
      .then(() => undefined)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        if (detail.includes('ERR_ABORTED')) return
        notice(mission, 'load-failed', `não carregou ${url.slice(0, 160)} — ${detail.slice(0, 200)}`)
      })
    await Promise.race([load.finally(() => (settled = true)), watchdog])
  }

  async function openTab(
    mission: MissionRecord,
    url: string | undefined,
    reason: 'gesture' | 'agent' | 'window-open',
    /** DE QUEM a aba nasce (D1). Os gestos do dono (barra de URL, `+`, pop-up de
     *  uma página) nascem `user`; só o `ensureTab` de um agente traz outro. */
    owner: BrowserTabOwner = BROWSER_USER_TAB_OWNER
  ): Promise<{ ok: true; tab: TabRecord } | { ok: false; error: string }> {
    if (liveTabs(mission).length >= BROWSER_TAB_CAP) {
      const error = capRefusal(reason)
      record('browser-tab-cap-refused', {
        actor: reason === 'gesture' ? 'user' : 'agent',
        ids: { projectId: mission.projectId, missionId: mission.missionId },
        reason: error,
        detail: { tabs: liveTabs(mission).length, cap: BROWSER_TAB_CAP, url: url?.slice(0, 200) }
      })
      notice(mission, 'tab-cap', error)
      return { ok: false, error }
    }
    const activeHost = resolveHost()
    const partition = browserPartitionFor(mission.projectId)
    activeHost.hardenSession(partition, sessionHooks)
    const view = activeHost.create(partition)
    if (!view) {
      return { ok: false, error: 'a janela do Synkora não está pronta — abra o app e tente de novo' }
    }
    const tab: TabRecord = {
      tabId: randomUUID(),
      view,
      wc: view.webContents,
      disposers: [],
      // Aba nova NASCE em AUTO — inclusive quando a irmã está emulada. O modo é
      // da aba e morre com ela; herdar em silêncio faria o `+` abrir uma página
      // já escalada sem ninguém ter pedido.
      viewport: 'auto',
      owner,
      driving: false,
      driveTimer: null
    }
    mission.tabs.push(tab)
    // D2 — A ABA NOVA NASCE ATIVA: o dono VÊ o recém-chegado (é assim que ele
    // acompanha a frota sem caçar aba). Quem NÃO rouba a vista é a navegação de
    // uma aba que já existe — essa parte mora no `ensureTab`.
    mission.activeTabId = tab.tabId
    owners.set(tab.wc.id, { missionId: mission.missionId, projectId: mission.projectId })
    wireTab(mission, tab)
    // Aba nova de missão DESTACADA nasce na janela destacada — nunca na janela
    // do app, de onde teria de dar um segundo salto (e teria um instante fora
    // da árvore da janela onde a página aparece).
    hosting.attachView(mission, view)
    // Nasce INVISÍVEL com bounds reais: anexada (lei 1) e capturável mesmo com
    // o painel do dock fechado. O applyLayout logo abaixo decide o resto.
    view.setVisible(false)
    ensureWindowWatch()
    applyLayout(mission)
    record('browser-tab-open', {
      actor: reason === 'gesture' ? 'user' : 'agent',
      ids: { projectId: mission.projectId, missionId: mission.missionId },
      reason: `aba do browser embutido nasceu (${reason})`,
      detail: {
        tabId: tab.tabId,
        wc: tab.wc.id,
        partition,
        url: url?.slice(0, 200),
        tabs: liveTabs(mission).length,
        // D6 — AUTORIA: até 01/09 o diário não sabia QUEM abriu a aba. Sabe.
        owner: { kind: owner.kind, label: owner.label, ...(owner.paneId ? { paneId: owner.paneId } : {}) }
      }
    })
    if (url) await loadInto(mission, tab, url)
    emitChanged(mission.missionId)
    return { ok: true, tab }
  }

  const ensureMission = (missionId: string, projectId: string): MissionRecord => {
    const existing = missions.get(missionId)
    if (existing) return existing
    const created: MissionRecord = {
      missionId,
      projectId,
      tabs: [],
      activeTabId: null,
      dockLayout: null,
      popoutLayout: null,
      driving: false,
      driveTimer: null,
      notice: null,
      host: 'dock',
      staleReported: null,
      frameWidth: 0,
      viewportNarration: 'false:false'
    }
    missions.set(missionId, created)
    return created
  }

  // ——— ganchos da session (por PROJETO; a missão vem do webContents) ———
  /** Uma guarda barrada = caixa-preta SEMPRE + nota legível QUANDO houver dono
   *  conhecido (a session é do projeto e pode ter view de outra missão). */
  const guardFired = (
    event: string,
    reason: string,
    detail: Record<string, unknown>,
    webContentsId: number | null,
    kind: BrowserNotice['kind'],
    text: string
  ): void => {
    const owner = webContentsId !== null ? owners.get(webContentsId) : undefined
    record(event, {
      actor: 'harness',
      ids: { projectId: owner?.projectId, missionId: owner?.missionId },
      reason,
      detail
    })
    const mission = owner ? missions.get(owner.missionId) : undefined
    if (mission) notice(mission, kind, text)
  }

  const sessionHooks: BrowserSessionHooks = {
    onDownloadBlocked(filename, url, webContentsId) {
      guardFired(
        'browser-download-blocked',
        'o browser da missão não baixa arquivos (v1)',
        { filename: filename.slice(0, 200), url: url.slice(0, 200) },
        webContentsId,
        'download-blocked',
        `download bloqueado: "${filename.slice(0, 80)}" — o browser da missão não baixa arquivos; se precisar dele, baixe pelo terminal da missão`
      )
    },
    onPermissionDenied(permission, webContentsId) {
      guardFired(
        'browser-permission-denied',
        'o browser da missão nega toda permissão por desenho (v1)',
        { permission },
        webContentsId,
        'permission-denied',
        `permissão negada: ${permission} — o browser da missão nega mic/câmera/geo/notificações por desenho`
      )
    }
  }

  // ——— A MÁQUINA DOS GESTOS (`./browserPaneGestures`) ———
  // Os sete verbos que nascem de um dedo do dono no chrome. Ela não conhece
  // dono de aba, ⚡, notas nem captura — pede emprestado só o que está aqui em
  // cima, e as abas que ela abre nascem do DONO (o `openTab` com `reason:
  // 'gesture'` carimba `BROWSER_USER_TAB_OWNER`), que é o que impede um agente
  // de reusar a aba que o dono acabou de abrir.
  const gestures = createBrowserGestureMachine<MissionRecord, TabRecord>({
    disposed: () => disposed,
    mission: (missionId) => missions.get(missionId),
    ensureMission,
    liveTabs: (mission) => liveTabs(mission),
    activeTab: (mission) => activeRecord(mission),
    findTab: (mission, tabId) => findTab(mission, tabId),
    openTab: (mission, url) => openTab(mission, url, 'gesture'),
    loadInto: (mission, tab, url) => loadInto(mission, tab, url),
    // O × do dono fecha o `webContents` junto. O `closeContents: false` é do
    // CRASH (a aba já morreu por fora), e esse caminho não é gesto de ninguém —
    // fica aqui, no motor.
    dropTab: (mission, tab) => dropTab(mission, tab, true),
    applyLayout: (mission) => applyLayout(mission),
    closeMission: (missionId) => manager.closeMission(missionId),
    changed: (missionId) => emitChanged(missionId)
  })

  // ——— API ———
  const manager: BrowserPaneManager = {
    // ——— OS OITO GESTOS DO DONO (`./browserPaneGestures`) ———
    // Barra de URL, +, ← → ⟳, o trilho de abas e o devtools saíram daqui em
    // 2026-09-01 (regra da casa). Eles entram POR ESPALHAMENTO, e não por oito
    // repasses de três linhas: repasse escrito à mão é lugar de a assinatura
    // divergir em silêncio, e o contrato que o `ipc/browser.ts` e as suítes
    // enxergam é o mesmo de antes do corte, byte a byte.
    ...gestures,

    async ensureTab(missionId, projectId, url, owner) {
      if (disposed) throw new Error('o browser embutido foi encerrado com a janela — reabra o app')
      const wanted = normalizeBrowserTarget(url)
      if (!wanted.ok) throw new Error(wanted.error)
      const target = wanted.url
      const mission = ensureMission(missionId, projectId)
      // A ABA É DESTA IDENTIDADE (D1). Sem `paneId` (só o dono nasce assim) não
      // há identidade a reusar, e a degradação honesta é a semântica antiga: a
      // aba ativa. Nenhum caminho do produto cai aqui — o `resolveTarget` do
      // index sempre carimba o pane —, mas um motor que estourasse no `undefined`
      // seria beco sem saída num caminho que ninguém consegue destravar.
      const existing = owner.paneId ? ownedRecord(mission, owner.paneId) : activeRecord(mission)
      if (existing) {
        // Idempotente: `browser_open` reusa a aba MORNA da PRÓPRIA identidade —
        // e só navega quando o alvo é outro.
        //
        // A VISTA DO DONO NÃO É ROUBADA (D2): navegar uma aba que já existe NÃO
        // mexe no `activeTabId`. Antes disto, um QA de vinte passos puxava a
        // tela do dono vinte vezes; quem vira ativa é só a aba que NASCE.
        if (target && existing.wc.getURL() !== target) await loadInto(mission, existing, target)
        applyLayout(mission)
        emitChanged(missionId)
        return { tabId: existing.tabId, webContents: existing.wc }
      }
      const opened = await openTab(mission, target, 'agent', owner)
      if (!opened.ok) throw new Error(opened.error)
      return { tabId: opened.tab.tabId, webContents: opened.tab.wc }
    },

    tabOf(missionId, ownerPaneId) {
      const mission = missions.get(missionId)
      if (!mission || !ownerPaneId) return undefined
      const tab = ownedRecord(mission, ownerPaneId)
      return tab ? { tabId: tab.tabId, webContents: tab.wc } : undefined
    },

    activeTab(missionId) {
      const mission = missions.get(missionId)
      if (!mission) return undefined
      const tab = activeRecord(mission)
      return tab ? { tabId: tab.tabId, webContents: tab.wc } : undefined
    },

    listTabs(missionId) {
      const mission = missions.get(missionId)
      if (!mission) return []
      const active = activeRecord(mission)
      return liveTabs(mission).map((tab) => ({
        tabId: tab.tabId,
        title: tab.wc.getTitle(),
        url: tab.wc.getURL(),
        active: tab.tabId === active?.tabId,
        owner: tab.owner,
        driving: tab.driving
      }))
    },

    closeMission(missionId) {
      const mission = missions.get(missionId)
      if (!mission) return
      const tabs = mission.tabs.length
      const wasPopped = mission.host === 'popout'
      for (const tab of [...mission.tabs]) dropTab(mission, tab, true)
      // A janela destacada morre COM a missão (arquivar/integrar/excluir de vez
      // passam todos pelo `killMissionGuiPanes` do index): uma janela órfã na
      // taskbar mostrando uma missão que o dono acabou de fechar é pior do que
      // qualquer view pendurada.
      if (wasPopped) {
        mission.host = 'dock'
        deps.popouts?.close(missionId)
      }
      clearBrowserDriving(mission)
      missions.delete(missionId)
      record('browser-mission-closed', {
        actor: 'harness',
        ids: { projectId: mission.projectId, missionId },
        reason: 'browser da missão encerrado (a partition do PROJETO persiste)',
        detail: { tabs }
      })
      emitChanged(missionId)
    },

    /**
     * D3 — A ABA DO AJUDANTE MORRE COM ELE. Chamado do `dispose` do processo
     * (done/failed/cancelled/interrupted), que não sabe em quantas missões
     * aquela identidade andou: a varredura é de TODAS. Os screenshots em
     * `.synkora/browser/` são o registro que fica — a aba é bancada, não
     * galeria, e `helper_resume` reabre a dele pelo caminho normal.
     */
    closeTabsOf(ownerPaneId) {
      if (!ownerPaneId) return 0
      let closed = 0
      let touched = 0
      const emptied: string[] = []
      for (const mission of [...missions.values()]) {
        const doomed = mission.tabs.filter((tab) => browserTabOwnedBy(tab.owner, ownerPaneId))
        if (doomed.length === 0) continue
        // O ÚNICO caminho de morte continua sendo o `dropTab` (lei 1: o detach
        // dele é de teardown, não de esconderijo).
        for (const tab of doomed) dropTab(mission, tab, true)
        closed += doomed.length
        touched += 1
        if (liveTabs(mission).length === 0) {
          emptied.push(mission.missionId)
          continue
        }
        applyLayout(mission)
        emitChanged(mission.missionId)
      }
      if (closed === 0) return 0
      record('browser-owner-tabs-closed', {
        actor: 'harness',
        reason: `as abas de ${ownerPaneId} morreram com ele (D3) — os screenshots em .synkora/browser/ são o registro`,
        detail: { ownerPaneId, tabs: closed, missions: touched }
      })
      // Missão que ficou SEM aba nenhuma acabou — a mesma régua do × do dono:
      // devolver o processo de renderer é melhor do que manter casca viva.
      for (const missionId of emptied) manager.closeMission(missionId)
      return closed
    },

    setAgentDriving(missionId, driving, tabId) {
      const mission = missions.get(missionId)
      if (!mission) return
      // O ⚡ DA MISSÃO (o de sempre, que o chrome pulsa) e o ⚡ DA ABA (D2, para
      // o dono saber QUEM da frota está mexendo) acendem juntos e decaem pelo
      // mesmo relógio de ~2s. Aba que não existe mais não acende nada — e não
      // atrapalha o indicador da missão, que continua honesto.
      if (tabId !== undefined) {
        const tab = findTab(mission, tabId)
        if (tab) armBrowserDriving(tab, driving, () => emitChanged(missionId))
      }
      armBrowserDriving(mission, driving, () => emitChanged(missionId))
    },

    state(missionId) {
      const mission = missions.get(missionId)
      if (!mission) return { ...EMPTY_STATE, tabs: [] }
      const active = activeRecord(mission)
      const tabs: BrowserTabView[] = liveTabs(mission).map((tab) => ({
        tabId: tab.tabId,
        title: tab.wc.getTitle(),
        url: tab.wc.getURL(),
        active: tab.tabId === active?.tabId,
        loading: tab.wc.isLoading(),
        canBack: tab.wc.navigationHistory.canGoBack(),
        canForward: tab.wc.navigationHistory.canGoForward(),
        viewport: tab.viewport,
        owner: tab.owner,
        driving: tab.driving
      }))
      const viewport = active?.viewport ?? 'auto'
      const band = mission.frameWidth > 0 ? viewportBandWidth(viewport, mission.frameWidth) : 0
      return {
        alive: tabs.length > 0,
        agentDriving: mission.driving,
        tabs,
        host: mission.host,
        viewport,
        // A largura EFETIVA, não a pedida: com a moldura estreita demais o piso
        // de zoom do Chromium morde e a página recebe menos do que se pediu.
        ...(mission.frameWidth > 0
          ? { viewportWidth: viewportEffectiveWidth(viewport, mission.frameWidth) }
          : {}),
        // A FAIXA só viaja quando EXISTE: zero é a ausência, e mandar `0` daria
        // duas grafias do mesmo estado (o normalizador do painel reconstrói o
        // objeto, e `sameBrowserPanel` acharia diferença onde não há).
        ...(band > 0 ? { viewportBand: band } : {}),
        notice: mission.notice ?? undefined,
        projectId: mission.projectId,
        // "à vista" é a pergunta do host ATUAL: destacada, a página está à vista
        // enquanto a janela dela estiver de pé.
        visible:
          mission.host === 'popout'
            ? Boolean(deps.popouts?.get(missionId)?.visible())
            : Boolean(mission.dockLayout?.visible)
      }
    },

    setDockMission(missionId) {
      if (dockMissionId === missionId) return
      dockMissionId = missionId
      // Revocation also clears the cached permission. Returning to a mission
      // requires its panel to measure again; window geometry cannot revive it.
      for (const mission of missions.values()) {
        if (mission.dockLayout?.visible) {
          mission.dockLayout = { ...mission.dockLayout, visible: false }
        }
        if (mission.host === 'dock') applyLayout(mission)
      }
    },

    applyBounds(missionId, rect, visible, reporter = 'dock') {
      const mission = missions.get(missionId)
      // Nascimento é LAZY: bounds sozinhos nunca criam browser nenhum.
      if (!mission) return
      if (reporter !== mission.host) {
        // AUTORIDADE ÚNICA SOBRE A GEOMETRIA (lei 2). O ex-host continua
        // relatando por um ou dois quadros depois do gesto — o ResizeObserver
        // do dock não sabe que a página saiu, e o cromo da janela destacada
        // relata uma última vez enquanto fecha. Obedecer isso colocaria a view
        // no retângulo de uma janela onde ela nem está.
        if (mission.staleReported !== reporter) {
          mission.staleReported = reporter
          record('browser-bounds-stale-host', {
            actor: 'harness',
            ids: { projectId: mission.projectId, missionId },
            reason: `relato de geometria do host ${reporter} ignorado — a página está no ${mission.host}`,
            detail: { reporter, host: mission.host, rect: roundRect(rect), visible: visible === true }
          })
        }
        return
      }
      const layout: BrowserMissionLayout = { rect: roundRect(rect), visible: visible === true }
      if (reporter === 'popout') {
        mission.popoutLayout = layout
        applyLayout(mission)
        return
      }
      // A delayed measurement from a keepalive project has no authority to
      // seize the native surface. Retain its real size for background capture.
      layout.visible = layout.visible && missionId === dockMissionId
      mission.dockLayout = layout
      if (layout.visible) {
        // Só UMA missão pode ocupar o retângulo do dock. Trocar de missão sem
        // o painel antigo reportar deixaria a view velha por cima — esconder as
        // outras aqui é mecânico, não depende de o renderer lembrar. Missão
        // DESTACADA não disputa esse retângulo: ela não está nele.
        for (const other of missions.values()) {
          const otherLayout = other.dockLayout
          if (other.missionId === missionId || other.host !== 'dock' || !otherLayout?.visible) continue
          other.dockLayout = { rect: otherLayout.rect, visible: false }
          applyLayout(other)
        }
      }
      applyLayout(mission)
    },

    relayout(missionId) {
      const mission = missions.get(missionId)
      if (mission) applyLayout(mission)
    },

    setViewportMode(missionId, mode, actor = 'user', tabId) {
      const normalized = normalizeViewportMode(mode)
      if (normalized === null) {
        return {
          ok: false,
          error: `largura inválida (${String(mode)}) — use AUTO ou um número entre ${320} e ${4000}`
        }
      }
      const mission = missions.get(missionId)
      // Com `tabId` a largura é da aba PEDIDA (o agente sempre manda a SUA);
      // sem ele, a da ATIVA — o seletor do dono no chrome, inalterado.
      const tab = mission ? targetRecord(mission, tabId) : undefined
      if (!mission || !tab) {
        return {
          ok: false,
          error: missingTabRefusal(tabId, 'mudar a largura')
        }
      }
      if (tab.viewport === normalized) {
        // Gesto idempotente: clicar duas vezes no mesmo botão não é recusa. Mas
        // a geometria é REAPLICADA — é a rota de saída quando o zoom de um
        // vizinho do mesmo host vazou por cima deste (o vazamento por origem,
        // medido).
        applyLayout(mission)
        return { ok: true, tabId: tab.tabId }
      }
      tab.viewport = normalized
      // LAYOUT INTEIRO, não só o zoom: desde a moldura de dispositivo o modo
      // decide também o RETÂNGULO da view (375 numa moldura de 900 é uma view de
      // 375px centralizada). Reaplicar só o zoom deixaria a página esticada na
      // moldura toda até o próximo relato do ResizeObserver.
      applyLayout(mission)
      record('browser-viewport-mode', {
        actor,
        ids: { projectId: mission.projectId, missionId },
        reason: `a página desta aba passou a enxergar ${normalized === 'auto' ? 'a moldura de verdade' : `${normalized}px lógicos`}`,
        detail: {
          tabId: tab.tabId,
          mode: normalized,
          frameWidth: mission.frameWidth,
          efetiva: viewportEffectiveWidth(normalized, mission.frameWidth)
        }
      })
      emitChanged(missionId)
      return { ok: true, tabId: tab.tabId }
    },

    viewportOf(missionId, tabId) {
      const mission = missions.get(missionId)
      const tab = mission ? targetRecord(mission, tabId) : undefined
      return tab?.viewport ?? 'auto'
    },

    viewportFrameWidth(missionId) {
      return missions.get(missionId)?.frameWidth ?? 0
    },

    // Os dois gestos do dono são da MÁQUINA DE HOST (`./browserPaneHosting`):
    // aqui eles só têm endereço público.
    popOut(missionId) {
      return hosting.popOut(missionId)
    },

    dockBack(missionId, reason) {
      return hosting.dockBack(missionId, reason)
    },

    captureReadiness(missionId, tabId) {
      const mission = missions.get(missionId)
      // A FOTO É DA ABA DE QUEM PEDIU (2026-09-01): o agente manda a dele, e o
      // dono (sem `tabId`) fotografa a que está olhando.
      const tab = mission ? targetRecord(mission, tabId) : undefined
      if (!mission || !tab) {
        return {
          ok: false,
          error:
            tabId === undefined
              ? 'o browser desta missão não está aberto — chame browser_open antes de capturar'
              : missingTabRefusal(tabId, 'capturar')
        }
      }
      const host = resolveHost()
      // A GUARDA DE 296 ns (sonda do pop-out §P4): pergunta ao Electron ONDE a
      // view está. `null` = ÓRFÃ (a janela morreu por baixo dela) — e é o ÚNICO
      // predicado que enxerga isso: `view.getVisible()` devolve `true` e
      // `wc.isDestroyed()` devolve `false` na órfã, e quem confia neles captura
      // e PENDURA 6 s. `undefined` = host antigo (o dublê do gate), que cai na
      // pergunta de sempre logo abaixo.
      const where = host.viewWindow?.(tab.view)
      if (where === null) {
        const error =
          'o browser desta missão está SEM JANELA (a janela destacada foi fechada por baixo dele) — reencaixe o painel pelo dock ou destaque de novo (⧉), e repita'
        record('browser-capture-orphan-refused', {
          actor: 'agent',
          ids: { projectId: mission.projectId, missionId },
          reason: error,
          detail: { tabId: tab.tabId, wc: tab.wc.id, host: mission.host }
        })
        return { ok: false, error }
      }
      if (where === undefined) {
        // P5: com a janela do app escondida/minimizada as duas rotas de captura
        // PENDURAM (5-8s) e o agente perde a rodada. Recusa na hora, com receita.
        if (!host.windowVisible()) {
          return {
            ok: false,
            error:
              'a janela do Synkora está minimizada/escondida — a captura pendura ali; restaure a janela e repita'
          }
        }
        return { ok: true, tab: { tabId: tab.tabId, webContents: tab.wc } }
      }
      // JANELA DESTACADA minimizada NÃO é motivo de recusa: a sonda mediu
      // captura FRESCA em 19-81 ms com a janela minimizada/oculta/atrás, desde
      // que a view já tenha composto ali — e ela compôs, porque o reparent só
      // acontece com a janela visível (cura 1) e a geometria nunca se recalcula
      // com a janela minimizada (cura 2). O dono minimiza o pop-out e o agente
      // SEGUE trabalhando, com o carimbo de frescor de sempre.
      if (mission.host === 'dock' && (!where.visible || where.minimized)) {
        return {
          ok: false,
          error:
            'a janela do Synkora está minimizada/escondida — a captura pendura ali; restaure a janela e repita'
        }
      }
      return { ok: true, tab: { tabId: tab.tabId, webContents: tab.wc } }
    },

    hasMission(missionId) {
      return missions.has(missionId)
    },

    hostOf(missionId) {
      return missions.get(missionId)?.host ?? 'dock'
    },

    destroy() {
      if (disposed) return
      disposed = true
      for (const missionId of [...missions.keys()]) manager.closeMission(missionId)
      // Fechar a janela do app (ou o quit) leva as janelas destacadas junto —
      // elas são superfícies do app, não janelas soltas do sistema. O
      // `closeMission` acima já fechou as das missões vivas; isto varre o que
      // tiver sobrado de uma missão que morreu por fora.
      deps.popouts?.closeAll()
      if (changeTimer) {
        clearTimeout(changeTimer)
        changeTimer = null
      }
      changePending.clear()
      unwatchWindow?.()
      unwatchWindow = null
      owners.clear()
    }
  }

  return manager
}

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
 * ——— testabilidade (a suíte `test:browser-pane` da H5) ———
 * Todo contato com o Electron mora em `electronBrowserViewHost()` — hoje no
 * módulo irmão `./browserPaneHost` (o corte de 2026-08-29). O MOTOR
 * (`createBrowserManager`) só fala com `BrowserViewHost` + a superfície de
 * `WebContents` — então o gate roda com host e webContents FAKE, em node puro,
 * sem subir janela nenhuma. Nada de Electron é tocado no topo do módulo.
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
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

/** Teto de abas por missão (D5.1/H1). Passar disso é recusa com receita. */
export const BROWSER_TAB_CAP = 8
/** ⚡ do chrome: a última tool de ação segura o indicador por ~2s. */
export const BROWSER_AGENT_DRIVING_DECAY_MS = 2000
/** Geometria de nascimento: o agente pode abrir o browser com o painel do dock
 *  FECHADO — sem bounds reais a superfície nasce 0×0 e a captura devolve imagem
 *  vazia ("Cannot take screenshot with 0 width" do lado CDP, P7). */
export const BROWSER_DEFAULT_VIEW_SIZE = { width: 1280, height: 800 }
/** Broadcast único: o renderer relê `browser:state` quando isto chega. */
export const BROWSER_CHANGED_CHANNEL = 'browser:changed'
/** Eventos de navegação chegam em rajada — o repaint do dock é coalescido. */
const BROWSER_CHANGE_COALESCE_MS = 40
/** Teto do `loadURL` do gesto: página que não responde não prende a tool. */
const BROWSER_LOAD_TIMEOUT_MS = 20000

// ————————————————————————————————————————————————————————————————
// CONTRATO consumido pela H2 (verbatim do design — não mexer sem re-alinhar
// as duas fatias). O supérfluo mora em `BrowserPaneManager`, abaixo.
// ————————————————————————————————————————————————————————————————

export interface MissionBrowserTab {
  tabId: string
  webContents: WebContents
}

export interface BrowserManager {
  ensureTab(missionId: string, projectId: string, url?: string): Promise<MissionBrowserTab>
  activeTab(missionId: string): MissionBrowserTab | undefined
  listTabs(missionId: string): { tabId: string; title: string; url: string; active: boolean }[]
  selectTab(missionId: string, tabId: string): boolean
  closeMission(missionId: string): void
  setAgentDriving(missionId: string, driving: boolean): void
}

// ————————————————————————————————————————————————————————————————
// Tipos da superfície do dono (IPC `browser:*` → chrome da H3)
// ————————————————————————————————————————————————————————————————

/** Retângulo do painel em DIPs da PÁGINA do host (titleBarStyle hidden = a
 *  página cobre a janela inteira, então é a mesma base do contentView). */
export interface BrowserPanelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabView {
  tabId: string
  title: string
  url: string
  active: boolean
  loading: boolean
  canBack: boolean
  canForward: boolean
  /** A largura que ESTA aba faz a página acreditar que tem (o modo é POR ABA:
   *  uma aba conferindo o desktop e outra o celular é o caso normal do QA). */
  viewport: BrowserViewportMode
}

/** Nota legível do motor para o dono (o "evento legível" do download barrado).
 *  Viaja DENTRO do state — mensagem durável com recibo, nunca um pulso que se
 *  perde se o painel ainda não estava montado. */
export interface BrowserNotice {
  kind: 'download-blocked' | 'tab-cap' | 'permission-denied' | 'load-failed' | 'crashed'
  text: string
  at: string
}

/** Onde a página desta missão está pendurada AGORA. Espelho declarado do
 *  `BrowserHostKind` do preload (`src/preload/index.ts` — o par). */
export type BrowserHostKind = 'dock' | 'popout'

/** De onde veio o reencaixe — só para a caixa-preta contar a história certa. */
export type BrowserDockBackReason = 'gesture' | 'window-close' | 'mission-closed'

export interface BrowserMissionState {
  alive: boolean
  agentDriving: boolean
  tabs: BrowserTabView[]
  /** Dock ou janela destacada. O dock desenha o RECIBO ("destacado — trazer de
   *  volta") em vez da página quando isto é `'popout'`. */
  host: BrowserHostKind
  /** O modo da aba ATIVA — é ele que o seletor do chrome mostra e escreve. UMA
   *  autoridade: a tool `browser_viewport` do agente e o clique do dono escrevem
   *  no MESMO campo, e por isso o dono SEMPRE vê quando a página está emulada
   *  por ordem do agente. */
  viewport: BrowserViewportMode
  /** A largura que a página realmente enxerga AGORA. Nem sempre é a pedida: o
   *  piso de zoom do Chromium (0,25×, medido na sonda) faz `viewport: 1280` numa
   *  moldura de 300px virar 1200. Ausente enquanto ninguém relatou geometria. */
  viewportWidth?: number
  /**
   * A MOLDURA DE DISPOSITIVO (2026-08-29): quantos px de APP sobram de cada lado
   * da página. `0`/ausente = a página ocupa a moldura inteira (é o caso de
   * `auto` e o do ramo que encolhe); maior que zero = a largura pedida CABE, a
   * página está em TAMANHO REAL e centralizada, e estas faixas são superfície do
   * Synkora — é o que responde a pergunta do dono ("como vou saber se ta
   * quebrando de vdd ou é o app").
   *
   * É a NARRAÇÃO, não a geometria: o chrome desenha a faixa por CSS a partir da
   * largura lógica (que muda com o gesto, não com o quadro), e este número — que
   * viaja no `browser:changed` coalescido — só decide SE existe faixa e o que a
   * nota escrita conta. Quem posiciona a view é este motor, sozinho.
   */
  viewportBand?: number
  /** extensões do contrato mínimo — o chrome pode ignorar sem quebrar */
  notice?: BrowserNotice
  projectId?: string
  visible?: boolean
}

/** Ack de TODA alavanca do chrome. Espelho declarado do `BrowserActionResult`
 *  do preload (`src/preload/index.ts`, bloco do browser — o par): recusa é
 *  TEXTO em PT-BR que nomeia a receita, nunca um `false` mudo. */
export type BrowserGestureResult =
  | { ok: true; tabId?: string }
  | { ok: false; error: string }

/** Guarda de captura que a H2 consulta antes de `capturePage`/CDP (P5). */
export type BrowserCaptureReadiness =
  | { ok: true; tab: MissionBrowserTab }
  | { ok: false; error: string }

// ————————————————————————————————————————————————————————————————
// Host injetável — TODO o Electron do módulo mora atrás desta interface
// ————————————————————————————————————————————————————————————————
// A interface e a implementação real mudaram para `./browserPaneHost` (regra da
// casa: este arquivo cruzou ~1000 linhas). O ENDEREÇO público não mudou — os
// cinco nomes continuam saindo daqui, então nenhum consumidor muda uma linha.

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

export interface BrowserPaneDeps {
  /** A janela do app (getter — ela pode ser recriada). */
  window(): BrowserWindow | null
  record(input: BlackboxEventInput): void
  /** Broadcast do `browser:changed` — no index é `ctx.pushAll` MAIS as janelas
   *  destacadas (o `pushAll` da casa só fala com a janela principal). */
  push(channel: string, ...args: unknown[]): void
  /** Override do gate (host fake); ausente = host real do Electron. */
  host?: BrowserViewHost
  /** As janelas do pop-out. Ausente = app sem pop-out (o gesto recusa com
   *  receita em vez de estourar) — é assim que o gate roda sem janela. */
  popouts?: BrowserPopoutHost
  now?(): number
}

/** O que o IPC e o gate consomem — o contrato do design MAIS a superfície do
 *  dono. A H2 pode continuar tipando pelo `BrowserManager` estreito. */
export interface BrowserPaneManager extends BrowserManager {
  state(missionId: string): BrowserMissionState
  navigate(missionId: string, url: string): Promise<BrowserGestureResult>
  newTab(missionId: string, projectId: string, url?: string): Promise<BrowserGestureResult>
  goBack(missionId: string): boolean
  goForward(missionId: string): boolean
  reload(missionId: string): boolean
  closeTab(missionId: string, tabId: string): boolean
  toggleDevtools(missionId: string, tabId?: string): boolean
  /** ResizeObserver do painel (H3). NUNCA cria browser — o nascimento é lazy
   *  e só o gesto (abrir aba / `browser_open`) o justifica.
   *  `reporter` é QUEM está relatando (o remetente do IPC, não uma alegação do
   *  payload): relato do host que não está com a página é IGNORADO — lei 2. */
  applyBounds(
    missionId: string,
    rect: BrowserPanelRect,
    visible: boolean,
    reporter?: BrowserHostKind
  ): void
  /** A JANELA do host atual mexeu (arrastar/redimensionar/maximizar) ou voltou
   *  de minimizada: a geometria da view é REFEITA. É o gancho da cura 2 — o
   *  `restore()` sozinho não devolve o pixel certo. */
  relayout(missionId: string): void
  /**
   * A LARGURA QUE A PÁGINA ENXERGA, na aba ATIVA da missão. É o mesmo verbo
   * para as duas mãos — o seletor do dono no chrome e a tool `browser_viewport`
   * do agente —, de propósito: dois caminhos escrevendo o mesmo estado é o que
   * faz o dono enxergar a página emulada por ordem do agente em vez de achar
   * que o site quebrou.
   */
  setViewportMode(
    missionId: string,
    mode: BrowserViewportMode,
    /** QUEM pediu. As duas mãos escrevem o mesmo estado, mas o diário não pode
     *  creditar ao dono uma emulação que o agente ligou sozinho. */
    actor?: 'user' | 'agent'
  ): BrowserGestureResult
  /** O modo da aba ativa (o que o chrome desenha). Missão sem aba = `'auto'`. */
  viewportOf(missionId: string): BrowserViewportMode
  /** A MOLDURA de agora, em px. É a base do zoom — e do recibo que conta ao
   *  agente que a largura efetiva pode ser menor que a pedida. `0` = ninguém
   *  relatou geometria ainda. */
  viewportFrameWidth(missionId: string): number
  /** ⧉ DESTACAR: a MESMA página salta para uma janela própria. */
  popOut(missionId: string): BrowserGestureResult
  /** REENCAIXAR: a página volta para o dock e a janela fecha. */
  dockBack(missionId: string, reason?: BrowserDockBackReason): BrowserGestureResult
  /** Guarda de captura da H2 (lei 1 + P5 + a guarda de 296 ns do pop-out). */
  captureReadiness(missionId: string): BrowserCaptureReadiness
  hasMission(missionId: string): boolean
  /** Onde a página desta missão está — o porteiro do IPC usa para saber se um
   *  relato de geometria vem do host certo. */
  hostOf(missionId: string): BrowserHostKind
  /** Teardown geral (janela fechada / quit). */
  destroy(): void
}

// ————————————————————————————————————————————————————————————————
// URL do dono — normalização (https por padrão; localhost é http)
// ————————————————————————————————————————————————————————————————

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

function looksLocal(host: string): boolean {
  const bare = host.replace(/:\d+$/, '').toLowerCase()
  return LOCAL_HOSTS.has(bare) || bare.endsWith('.localhost')
}

/**
 * "URL do dono: normalizada (https default), qualquer URL — o browser é dele."
 * Duas emendas pagas por realidade, não por gosto:
 * - **localhost sai em http**, não https: o caso de uso número um é o dev
 *   server da missão (`localhost:5173`), e https ali só entrega tela de erro;
 * - **`javascript:` é recusado** nomeando a receita: ele executaria no
 *   documento ATUAL (o canal de código é `browser_eval`, da H2).
 * Texto que não é endereço NÃO vira busca: nenhum buscador foi decidido e o
 * app não manda o que o dono digitou para um terceiro por conta própria.
 */
export function normalizeBrowserUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (!input) return { ok: false, error: 'digite um endereço para navegar' }
  const invalid = { ok: false as const, error: `endereço inválido: ${input.slice(0, 120)}` }
  // Caminho do Windows colado (`C:\build\index.html`) ou UNC — vira file://.
  if (/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\')) {
    try {
      return { ok: true, url: pathToFileURL(input).href }
    } catch {
      return invalid
    }
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input)
  const proto = scheme?.[1].toLowerCase()
  if (proto === 'javascript' || proto === 'vbscript') {
    return {
      ok: false,
      error: `endereço ${proto}: não navega — para rodar código NA página use a tool browser_eval`
    }
  }
  // ARMADILHA PAGA: `localhost:5173` casa o regex de esquema — o `localhost:`
  // vira protocolo e o `new URL` ACEITA, devolvendo um endereço que não abre
  // nada. O discriminador é o que vem depois dos dois pontos: dígito = PORTA.
  const hierarchical = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
  const opaque = Boolean(scheme) && !/^[a-z][a-z0-9+.-]*:\d/i.test(input)
  if (hierarchical || opaque) {
    try {
      return { ok: true, url: new URL(input).href }
    } catch {
      return invalid
    }
  }
  const host = input.split(/[/?#]/)[0] ?? ''
  // Texto que não é endereço NÃO vira busca: nenhum buscador foi decidido, e o
  // app não manda o que o dono digitou para um terceiro por conta própria.
  if (/\s/.test(input) || (!/[.:]/.test(input) && !looksLocal(host))) {
    return {
      ok: false,
      error: 'isso não parece um endereço — digite algo como localhost:5173 ou cole o link completo (https://…)'
    }
  }
  const guess = `${looksLocal(host) ? 'http' : 'https'}://${input}`
  try {
    return { ok: true, url: new URL(guess).href }
  } catch {
    return invalid
  }
}

/** `persist:browser:<projectId>` (D5.3) — login vale para todas as missões do
 *  projeto. O id é uuid, mas a partition é sanitizada por precaução. */
export function browserPartitionFor(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '') || 'sem-projeto'
  return `persist:browser:${safe}`
}

// ————————————————————————————————————————————————————————————————
// Estado interno
// ————————————————————————————————————————————————————————————————

/** A aba do motor É uma aba hospedada (o `wc` inteiro no lugar do mínimo que a
 *  máquina de host precisa) — uma definição só, sem espelho. */
interface TabRecord extends BrowserHostedTab {
  view: BrowserViewHandle
  wc: WebContents
  disposers: (() => void)[]
  /** POR ABA, e nasce em `auto`: o QA de responsivo é justamente ter uma aba no
   *  desktop e outra no celular. Morre com a aba (nada disto é persistido). */
  viewport: BrowserViewportMode
}

/** O registro do motor ESTENDE a fatia que a máquina de host governa (`host`,
 *  os dois retângulos, o carimbo de relato velho — em `./browserPaneHosting`) e
 *  acrescenta o que é só daqui: abas, ⚡ e a nota. */
interface MissionRecord extends BrowserHostedMission {
  tabs: TabRecord[]
  activeTabId: string | null
  agentDriving: boolean
  driveTimer: NodeJS.Timeout | null
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

export function isBrowserPanelRect(value: unknown): value is BrowserPanelRect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Partial<BrowserPanelRect>
  return (
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.width === 'number' &&
    typeof rect.height === 'number'
  )
}

// ————————————————————————————————————————————————————————————————
// O motor
// ————————————————————————————————————————————————————————————————

export function createBrowserManager(deps: BrowserPaneDeps): BrowserPaneManager {
  const missions = new Map<string, MissionRecord>()
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
    const show = usable && wanted?.visible === true
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

  const capRefusal = (): string =>
    `teto de ${BROWSER_TAB_CAP} abas nesta missão — feche uma aba (×) antes de abrir outra`

  /** O endereço do AGENTE passa pela MESMA normalização do dono: `localhost:5173`
   *  é o alvo mais provável de um QA e, cru, não abre nada. Vazio = aba em branco. */
  const normalizeTarget = (
    url: string | undefined
  ): { ok: true; url: string | undefined } | { ok: false; error: string } => {
    if (url === undefined || url === '') return { ok: true, url: undefined }
    const normalized = normalizeBrowserUrl(url)
    return normalized.ok ? { ok: true, url: normalized.url } : normalized
  }

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
    reason: 'gesture' | 'agent' | 'window-open'
  ): Promise<{ ok: true; tab: TabRecord } | { ok: false; error: string }> {
    if (liveTabs(mission).length >= BROWSER_TAB_CAP) {
      const error = capRefusal()
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
      viewport: 'auto'
    }
    mission.tabs.push(tab)
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
      detail: { tabId: tab.tabId, wc: tab.wc.id, partition, url: url?.slice(0, 200), tabs: liveTabs(mission).length }
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
      agentDriving: false,
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

  // ——— API ———
  const manager: BrowserPaneManager = {
    async ensureTab(missionId, projectId, url) {
      if (disposed) throw new Error('o browser embutido foi encerrado com a janela — reabra o app')
      const wanted = normalizeTarget(url)
      if (!wanted.ok) throw new Error(wanted.error)
      const target = wanted.url
      const mission = ensureMission(missionId, projectId)
      const existing = activeRecord(mission)
      if (existing) {
        // Idempotente: `browser_open` reusa a aba MORNA (design H2) — só
        // navega quando o alvo é outro.
        mission.activeTabId = existing.tabId
        if (target && existing.wc.getURL() !== target) await loadInto(mission, existing, target)
        applyLayout(mission)
        emitChanged(missionId)
        return { tabId: existing.tabId, webContents: existing.wc }
      }
      const opened = await openTab(mission, target, 'agent')
      if (!opened.ok) throw new Error(opened.error)
      return { tabId: opened.tab.tabId, webContents: opened.tab.wc }
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
        active: tab.tabId === active?.tabId
      }))
    },

    selectTab(missionId, tabId) {
      const mission = missions.get(missionId)
      if (!mission) return false
      const tab = findTab(mission, tabId)
      if (!tab) return false
      mission.activeTabId = tab.tabId
      applyLayout(mission)
      emitChanged(missionId)
      return true
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
      if (mission.driveTimer) clearTimeout(mission.driveTimer)
      missions.delete(missionId)
      record('browser-mission-closed', {
        actor: 'harness',
        ids: { projectId: mission.projectId, missionId },
        reason: 'browser da missão encerrado (a partition do PROJETO persiste)',
        detail: { tabs }
      })
      emitChanged(missionId)
    },

    setAgentDriving(missionId, driving) {
      const mission = missions.get(missionId)
      if (!mission) return
      // `true` acende e re-arma; `false` NÃO apaga na hora — o ⚡ segura ~2s
      // depois da última tool para não piscar entre chamadas encadeadas.
      const was = mission.agentDriving
      if (!driving && !was) return
      if (driving) mission.agentDriving = true
      if (mission.driveTimer) clearTimeout(mission.driveTimer)
      mission.driveTimer = setTimeout(() => {
        mission.driveTimer = null
        if (!mission.agentDriving) return
        mission.agentDriving = false
        emitChanged(missionId)
      }, BROWSER_AGENT_DRIVING_DECAY_MS)
      mission.driveTimer.unref?.()
      if (mission.agentDriving !== was) emitChanged(missionId)
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
        viewport: tab.viewport
      }))
      const viewport = active?.viewport ?? 'auto'
      const band = mission.frameWidth > 0 ? viewportBandWidth(viewport, mission.frameWidth) : 0
      return {
        alive: tabs.length > 0,
        agentDriving: mission.agentDriving,
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

    async navigate(missionId, url) {
      const mission = missions.get(missionId)
      if (!mission) {
        return {
          ok: false,
          error: 'o browser desta missão não está aberto — abra uma aba (+) antes de navegar'
        }
      }
      const normalized = normalizeBrowserUrl(url)
      if (!normalized.ok) return { ok: false, error: normalized.error }
      const tab = activeRecord(mission)
      if (!tab) {
        const opened = await openTab(mission, normalized.url, 'gesture')
        return opened.ok ? { ok: true, tabId: opened.tab.tabId } : { ok: false, error: opened.error }
      }
      mission.activeTabId = tab.tabId
      await loadInto(mission, tab, normalized.url)
      emitChanged(missionId)
      return { ok: true, tabId: tab.tabId }
    },

    async newTab(missionId, projectId, url) {
      if (disposed) {
        return { ok: false, error: 'o browser embutido foi encerrado com a janela — reabra o app' }
      }
      const wanted = normalizeTarget(url)
      if (!wanted.ok) return { ok: false, error: wanted.error }
      const mission = ensureMission(missionId, projectId)
      const opened = await openTab(mission, wanted.url, 'gesture')
      return opened.ok ? { ok: true, tabId: opened.tab.tabId } : { ok: false, error: opened.error }
    },

    goBack(missionId) {
      const mission = missions.get(missionId)
      const tab = mission ? activeRecord(mission) : undefined
      if (!tab || !tab.wc.navigationHistory.canGoBack()) return false
      tab.wc.navigationHistory.goBack()
      emitChanged(missionId)
      return true
    },

    goForward(missionId) {
      const mission = missions.get(missionId)
      const tab = mission ? activeRecord(mission) : undefined
      if (!tab || !tab.wc.navigationHistory.canGoForward()) return false
      tab.wc.navigationHistory.goForward()
      emitChanged(missionId)
      return true
    },

    reload(missionId) {
      const mission = missions.get(missionId)
      const tab = mission ? activeRecord(mission) : undefined
      if (!tab) return false
      tab.wc.reload()
      emitChanged(missionId)
      return true
    },

    closeTab(missionId, tabId) {
      const mission = missions.get(missionId)
      if (!mission) return false
      const tab = findTab(mission, tabId)
      if (!tab) return false
      dropTab(mission, tab, true)
      if (liveTabs(mission).length === 0) {
        // Última aba fechada = o browser da missão acabou. Devolver o processo
        // de renderer é melhor do que manter uma casca viva; o + reabre.
        manager.closeMission(missionId)
        return true
      }
      applyLayout(mission)
      emitChanged(missionId)
      return true
    },

    toggleDevtools(missionId, tabId) {
      const mission = missions.get(missionId)
      if (!mission) return false
      const tab = tabId ? findTab(mission, tabId) : activeRecord(mission)
      if (!tab) return false
      if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools()
      // Modo DESTACADO: devtools acoplado roubaria metade do painel do dock e,
      // pior, mexeria na geometria da view que a captura depende.
      else tab.wc.openDevTools({ mode: 'detach' })
      return true
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
      mission.dockLayout = layout
      if (visible) {
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

    setViewportMode(missionId, mode, actor = 'user') {
      const normalized = normalizeViewportMode(mode)
      if (normalized === null) {
        return {
          ok: false,
          error: `largura inválida (${String(mode)}) — use AUTO ou um número entre ${320} e ${4000}`
        }
      }
      const mission = missions.get(missionId)
      const tab = mission ? activeRecord(mission) : undefined
      if (!mission || !tab) {
        return {
          ok: false,
          error: 'o browser desta missão não está aberto — abra uma aba (+) antes de mudar a largura'
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

    viewportOf(missionId) {
      const mission = missions.get(missionId)
      const tab = mission ? activeRecord(mission) : undefined
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

    captureReadiness(missionId) {
      const mission = missions.get(missionId)
      const tab = mission ? activeRecord(mission) : undefined
      if (!mission || !tab) {
        return {
          ok: false,
          error: 'o browser desta missão não está aberto — chame browser_open antes de capturar'
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

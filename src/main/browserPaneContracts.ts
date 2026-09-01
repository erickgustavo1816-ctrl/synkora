/**
 * BROWSER EMBUTIDO — O CONTRATO (a quarta metade de `./browserPane`, cortada em
 * 2026-09-01 pela mesma regra da casa que já tinha tirado dali o host, a máquina
 * de host, os gestos do dono, o endereço e o dono da aba).
 *
 * Aqui mora TUDO que é PROMESSA e nada que seja motor: os tipos que o `ipc/
 * browser.ts`, o `index.ts`, o kit de tools e as suítes consomem, mais os três
 * números/nomes públicos (o teto de abas, a geometria de nascimento e o canal do
 * broadcast). Nenhuma linha deste arquivo executa qualquer coisa — o único corpo
 * é o `isBrowserPanelRect`, que é uma guarda de tipo de dez linhas e pertence ao
 * contrato tanto quanto o `BrowserPanelRect` que ele defende.
 *
 * ——— o corte é de ENDEREÇO, não de contrato ———
 * MOVIMENTO PURO: cada declaração veio verbatim do irmão, com o comentário
 * junto. `./browserPane` RE-EXPORTA todos os nomes, então nenhum consumidor e
 * nenhuma suíte mudam um import — a superfície pública dele é byte a byte a
 * mesma de antes do corte.
 *
 * ——— os ESPELHOS DECLARADOS continuam apontando ———
 * Vários comentários aqui nomeiam o par do outro lado da fronteira
 * (`src/preload/index.ts`, `src/renderer/src/dockBrowserModel.ts`). Eles seguem
 * válidos: o que mudou foi o arquivo onde o lado do main mora, não o lado. Quem
 * for conferir um espelho acha a declaração por grep do nome, como sempre.
 *
 * ——— sem uma linha de Electron em tempo de execução ———
 * Como os irmãos: só `import type`. É o que mantém o gate rodando em node puro.
 */
import type { BrowserWindow, WebContents } from 'electron'
import type { BlackboxEventInput } from './blackbox'
// Os tipos do HOST (onde a página está pendurada) e o do DONO DA ABA chegam como
// import de TIPO — apagados no emit, então este módulo não arrasta o Electron
// que mora atrás deles.
import type { BrowserPopoutHost, BrowserViewHost } from './browserPaneHost'
import type { BrowserTabOwner } from './browserTabOwner'
import type { BrowserViewportMode } from './browserViewport'

/**
 * Teto de abas por missão (D5.1/H1; subiu de 8 para 12 em 2026-09-01 — D5).
 * Passar disso é recusa com receita.
 *
 * O 8 era o teto de um mundo em que a missão tinha UMA aba com todo mundo
 * dentro. Com aba POR IDENTIDADE cabem na mesma missão o dono, o dev e uma
 * frota de ajudantes — 12 é o número que o dono aprovou no design.
 * ESPELHO DECLARADO: `BROWSER_TAB_CAP` de `src/renderer/src/dockBrowserModel.ts`
 * (o par), conferido pela suíte `test:browser-pane`.
 */
export const BROWSER_TAB_CAP = 12

/** Geometria de nascimento: o agente pode abrir o browser com o painel do dock
 *  FECHADO — sem bounds reais a superfície nasce 0×0 e a captura devolve imagem
 *  vazia ("Cannot take screenshot with 0 width" do lado CDP, P7). */
export const BROWSER_DEFAULT_VIEW_SIZE = { width: 1280, height: 800 }
/** Broadcast único: o renderer relê `browser:state` quando isto chega. */
export const BROWSER_CHANGED_CHANNEL = 'browser:changed'

// ————————————————————————————————————————————————————————————————
// CONTRATO consumido pela H2 (verbatim do design — não mexer sem re-alinhar
// as duas fatias). O supérfluo mora em `BrowserPaneManager`, abaixo.
// ————————————————————————————————————————————————————————————————

export interface MissionBrowserTab {
  tabId: string
  webContents: WebContents
}

export interface BrowserManager {
  /**
   * OWNER-AWARE desde 2026-09-01 (D1): reusa a aba VIVA de `owner.paneId` — e
   * só navega quando o alvo mudou — ou cria a DELA, que nasce ATIVA (D2). A aba
   * de outra identidade nunca é tocada: a colisão de 01/09 (o ajudante e o dev
   * alternando a mesma aba entre a porta 8791 e as 8159/8148/8163) morreu aqui.
   */
  ensureTab(
    missionId: string,
    projectId: string,
    url: string | undefined,
    owner: BrowserTabOwner
  ): Promise<MissionBrowserTab>
  /** A aba VIVA desta identidade nesta missão (a porta de entrada das tools). */
  tabOf(missionId: string, ownerPaneId: string): MissionBrowserTab | undefined
  /** A aba que o DONO está olhando — os gestos do chrome, nunca as tools. */
  activeTab(missionId: string): MissionBrowserTab | undefined
  listTabs(missionId: string): {
    tabId: string
    title: string
    url: string
    active: boolean
    owner: BrowserTabOwner
    driving: boolean
  }[]
  selectTab(missionId: string, tabId: string): boolean
  closeMission(missionId: string): void
  /** D3 — a aba do ajudante MORRE COM ELE: o `dispose` do processo fecha as
   *  abas desta identidade em TODAS as missões e recebe quantas eram. Quem
   *  chama não sabe (nem tem por que saber) por onde o ajudante andou. */
  closeTabsOf(ownerPaneId: string): number
  /** O ⚡ do chrome. Sem `tabId` acende só o da MISSÃO (o de sempre); com
   *  `tabId`, acende também o da ABA — com uma frota na mesma missão, o dono
   *  precisa saber QUEM está mexendo em quê. */
  setAgentDriving(missionId: string, driving: boolean, tabId?: string): void
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
  /** DE QUEM é esta aba (D1). O chrome carimba o rótulo na aba de agente e
   *  deixa a do dono limpa. Espelho declarado do `BrowserTab.owner` do preload. */
  owner: BrowserTabOwner
  /** ⚡ POR ABA (D2): esta aba está sendo dirigida AGORA por quem é dona dela. */
  driving: boolean
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
    actor?: 'user' | 'agent',
    /** A ABA alvo (2026-09-01). Ausente = a aba ATIVA — a semântica do seletor
     *  do dono no chrome, que não mudou. O agente sempre manda a SUA: com a
     *  frota na mesma missão, escrever na ativa emularia a página de outro. */
    tabId?: string
  ): BrowserGestureResult
  /** O modo de uma aba (sem `tabId`, o da ATIVA — o que o chrome desenha).
   *  Missão sem aba, ou aba que não existe = `'auto'`. */
  viewportOf(missionId: string, tabId?: string): BrowserViewportMode
  /** A MOLDURA de agora, em px. É a base do zoom — e do recibo que conta ao
   *  agente que a largura efetiva pode ser menor que a pedida. `0` = ninguém
   *  relatou geometria ainda. */
  viewportFrameWidth(missionId: string): number
  /** ⧉ DESTACAR: a MESMA página salta para uma janela própria. */
  popOut(missionId: string): BrowserGestureResult
  /** REENCAIXAR: a página volta para o dock e a janela fecha. */
  dockBack(missionId: string, reason?: BrowserDockBackReason): BrowserGestureResult
  /** Guarda de captura da H2 (lei 1 + P5 + a guarda de 296 ns do pop-out).
   *  Sem `tabId`, a aba ATIVA (o gesto do dono); com `tabId`, a aba PEDIDA — a
   *  foto do agente é da aba dele, mesmo com o dono olhando outra. */
  captureReadiness(missionId: string, tabId?: string): BrowserCaptureReadiness
  hasMission(missionId: string): boolean
  /** Onde a página desta missão está — o porteiro do IPC usa para saber se um
   *  relato de geometria vem do host certo. */
  hostOf(missionId: string): BrowserHostKind
  /** Teardown geral (janela fechada / quit). */
  destroy(): void
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

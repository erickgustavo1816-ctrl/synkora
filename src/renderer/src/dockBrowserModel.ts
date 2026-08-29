import type {
  BrowserNoticeView,
  BrowserPanelState,
  BrowserRect,
  BrowserTab
} from '../../preload/index'

// MODELO DO PAINEL DE BROWSER (H3 do design de 2026-08-29) — a metade PURA do
// `components/DockBrowser.tsx`: estado, palavras e geometria, sem um `window`
// no meio. É ela que o gate (`test:browser-pane`) consegue rodar em node puro.
//
// Por que geometria mora aqui: a página do browser NÃO é desenhada pelo
// renderer. A `WebContentsView` nativa compõe POR CIMA do DOM, no retângulo que
// este painel reporta — então "onde o painel está" e "o painel está à vista"
// são a interface inteira entre o React e o motor. Errar o retângulo é pintar
// uma página em cima da tela do dono; errar o `visible` é deixá-la lá quando
// ele já foi olhar outra coisa.
//
// Os tipos vêm do preload (`import type` — apagado na compilação, então o
// módulo continua carregável fora do Electron).

/** Teto de abas POR MISSÃO (design H1). O `+` do chrome desabilita aqui; quem
 *  aplica a lei de verdade é o main — este número é o espelho da tela. */
export const BROWSER_TAB_CAP = 8

/** Preload velho (app rodando sem restart) não tem `api.browser`. A tela
 *  nomeia a receita em vez de morrer calada — mesma régua do `SKILLS_NO_API`. */
export const BROWSER_NO_API = 'reinicie o app para abrir o browser da missão'

/** Estado do MOTOR, não da página: `missing` é ponte velha, e a seção inteira
 *  vira um recado com receita. */
export type BrowserEngineState = 'ready' | 'missing'

/** Fotografia vazia com REFERÊNCIA ESTÁVEL: seletor zustand devolve sempre o
 *  mesmo objeto quando a missão ainda não tem browser (a regra da casa contra
 *  `?? []` inline, que renderizaria a árvore inteira a cada notificação). */
export const EMPTY_BROWSER_PANEL: BrowserPanelState = Object.freeze({
  alive: false,
  agentDriving: false,
  tabs: [] as BrowserTab[]
})

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bool(value: unknown): boolean {
  return value === true
}

/** Lê a fotografia do motor DEFENSIVAMENTE: o dono do formato é o main, e um
 *  campo que falta (motor antigo, payload torto) nunca pode derrubar o painel.
 *  Aba sem `tabId` é descartada — sem id não há gesto possível sobre ela. */
export function normalizeBrowserPanel(value: unknown): BrowserPanelState {
  if (!value || typeof value !== 'object') return EMPTY_BROWSER_PANEL
  const bag = value as { alive?: unknown; agentDriving?: unknown; tabs?: unknown; host?: unknown }
  const rawTabs = Array.isArray(bag.tabs) ? bag.tabs : []
  const tabs: BrowserTab[] = []
  for (const entry of rawTabs) {
    if (!entry || typeof entry !== 'object') continue
    const tab = entry as Record<string, unknown>
    const tabId = str(tab.tabId)
    if (!tabId) continue
    tabs.push({
      tabId,
      title: str(tab.title),
      url: str(tab.url),
      active: bool(tab.active),
      loading: bool(tab.loading),
      canBack: bool(tab.canBack),
      canForward: bool(tab.canForward)
    })
  }
  // CONSERTO de uma verdade impossível: existir aba e nenhuma marcada ativa
  // deixaria a barra de URL falando de uma página e a tira de abas de outra.
  // A primeira assume — e a tela conta UMA história só.
  if (tabs.length > 0 && !tabs.some((tab) => tab.active)) tabs[0].active = true
  const state: BrowserPanelState = {
    alive: bool(bag.alive) || tabs.length > 0,
    agentDriving: bool(bag.agentDriving),
    tabs
  }
  // ONDE a página está (pop-out, 2026-08-29). Só `'popout'` é carregado: o
  // espelho do preload declara AUSENTE = dock, e o normalizador reconstrói o
  // objeto — um campo inventado aqui viraria uma segunda grafia de "dock".
  if (bag.host === 'popout') state.host = 'popout'
  const notice = readBrowserNotice((value as { notice?: unknown }).notice)
  if (notice) state.notice = notice
  return state
}

/** A página está numa JANELA PRÓPRIA? Único jeito de perguntar: `undefined` e
 *  `'dock'` são a MESMA coisa (motor anterior ao ⧉ não manda o campo), e um
 *  `!== 'dock'` espalhado pela tela transformaria a ausência em destaque. */
export function browserIsPopout(state: BrowserPanelState): boolean {
  return state.host === 'popout'
}

/** A nota do motor só entra na tela se tiver TEXTO: `kind` e `at` são carimbos
 *  para o diário, e uma nota muda ocuparia uma linha dizendo nada. */
function readBrowserNotice(value: unknown): BrowserNoticeView | null {
  if (!value || typeof value !== 'object') return null
  const bag = value as { kind?: unknown; text?: unknown; at?: unknown }
  const text = str(bag.text).trim()
  if (!text) return null
  return { kind: str(bag.kind), text, at: str(bag.at) }
}

/** Ack de alavanca, lido com a mesma frouxidão: `undefined` de um motor que
 *  ainda não devolve nada vale como OK; só uma recusa EXPLÍCITA vira recado. */
export function readBrowserAck(value: unknown): { ok: boolean; error: string | null } {
  if (!value || typeof value !== 'object') return { ok: true, error: null }
  const bag = value as { ok?: unknown; error?: unknown }
  if (bag.ok === false) {
    const error = str(bag.error).trim()
    return { ok: false, error: error || 'o browser recusou a ação' }
  }
  return { ok: true, error: null }
}

export function activeBrowserTab(state: BrowserPanelState): BrowserTab | null {
  return state.tabs.find((tab) => tab.active) ?? null
}

/** Duas fotografias contam a MESMA história? O `browser:changed` chega a cada
 *  passo do agente, e um objeto novo com o mesmo conteúdo repintaria o dock
 *  por nada — a comparação é o portão do store. */
export function sameBrowserPanel(a: BrowserPanelState, b: BrowserPanelState): boolean {
  if (a === b) return true
  if (a.alive !== b.alive || a.agentDriving !== b.agentDriving) return false
  // O HOST muda a seção inteira (o painel vira recibo) e nada mais na fotografia
  // precisa mudar junto: sem esta linha o ⧉ não repintaria o dock.
  if (a.host !== b.host) return false
  // A nota do motor tem CARIMBO: duas notas do mesmo texto em momentos
  // diferentes são dois avisos, e o segundo precisa chegar à tela.
  if (a.notice?.at !== b.notice?.at || a.notice?.text !== b.notice?.text) return false
  if (a.tabs.length !== b.tabs.length) return false
  return a.tabs.every((tab, index) => {
    const other = b.tabs[index]
    return (
      tab.tabId === other.tabId &&
      tab.title === other.title &&
      tab.url === other.url &&
      tab.active === other.active &&
      tab.loading === other.loading &&
      tab.canBack === other.canBack &&
      tab.canForward === other.canForward
    )
  })
}

/** O HOST da URL, para a aba que ainda não tem título. `new URL` recusa
 *  endereço pela metade (o dono digitando) — nesse caso a URL crua serve. */
export function urlHost(url: string): string {
  const raw = url.trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.host || parsed.protocol.replace(':', '')
  } catch {
    return raw
  }
}

/** Nome da aba na tira: título, senão host, senão a verdade ("aba em branco").
 *  Nunca uma URL inteira — a tira mora numa coluna de 176px. */
export function browserTabLabel(tab: BrowserTab): string {
  const title = tab.title.trim()
  if (title) return title
  const host = urlHost(tab.url)
  if (host) return host
  return 'aba em branco'
}

/** O RESUMO da seção — a única verdade que sobra com o painel RECOLHIDO, então
 *  ele carrega o que decide se vale reabrir: quem está dirigindo, o que está
 *  carregando, e quantas abas existem. */
export function browserSectionSummary(
  state: BrowserPanelState,
  engine: BrowserEngineState = 'ready'
): string {
  if (engine === 'missing') return 'motor velho'
  // DESTACADO vem antes de tudo (menos o motor velho): com a seção recolhida,
  // "3 abas" faria o dono procurar no dock uma página que está em outra janela.
  // O ⚡ sobrevive porque o agente segue dirigindo a página destacada.
  if (browserIsPopout(state)) return `${state.agentDriving ? '⚡ ' : ''}destacado`
  const tab = activeBrowserTab(state)
  if (!state.alive || !tab) return 'fechado'
  const label = tab.loading ? 'carregando…' : browserTabLabel(tab)
  const extra = state.tabs.length > 1 ? ` · ${state.tabs.length} abas` : ''
  return `${state.agentDriving ? '⚡ ' : ''}${label}${extra}`
}

/** Recusa do `+` quando o teto chegou. Toda guarda nomeia a saída: aqui, a de
 *  fechar uma aba. */
export function tabCapNotice(count: number): string | null {
  if (count < BROWSER_TAB_CAP) return null
  return `teto de ${BROWSER_TAB_CAP} abas nesta missão — feche uma (×) para abrir outra`
}

// ————— GEOMETRIA —————

/** Caixa DOM crua (o que `getBoundingClientRect` devolve, na parte que
 *  interessa). Tipo próprio para o modelo não depender de `DOMRect`. */
export interface DomBox {
  left: number
  top: number
  width: number
  height: number
}

const ZERO_RECT: BrowserRect = { x: 0, y: 0, width: 0, height: 0 }

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** DOM → retângulo do motor: inteiro (meio pixel vira borda tremendo na view
 *  nativa) e nunca negativo. */
export function browserRect(box: DomBox): BrowserRect {
  const x = Math.round(finite(box.left))
  const y = Math.round(finite(box.top))
  return {
    x,
    y,
    width: Math.max(0, Math.round(finite(box.width))),
    height: Math.max(0, Math.round(finite(box.height)))
  }
}

export function sameBrowserRect(a: BrowserRect | null, b: BrowserRect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function rectHasArea(rect: BrowserRect): boolean {
  return rect.width > 0 && rect.height > 0
}

/** Interseção de dois retângulos; sem sobreposição devolve área zero (e não um
 *  retângulo de largura negativa, que o motor aceitaria calado). */
export function intersectRects(a: BrowserRect, b: BrowserRect): BrowserRect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return ZERO_RECT
  return { x, y, width: right - x, height: bottom - y }
}

export function rectsOverlap(a: BrowserRect, b: BrowserRect): boolean {
  return rectHasArea(intersectRects(a, b))
}

/**
 * O retângulo que o motor recebe é o que SOBRA da caixa do painel depois de
 * todos os recortes: a viewport e cada ancestral que corta (o dock tem
 * `overflow: hidden`, o trilho rola). Sem isto, rolar o dock empurraria a
 * página nativa para cima do chat — ela compõe por cima do DOM e não conhece
 * `overflow` nenhum.
 */
export function clipBrowserRect(
  page: BrowserRect,
  clips: readonly BrowserRect[]
): BrowserRect {
  let rect = page
  for (const clip of clips) {
    rect = intersectRects(rect, clip)
    if (!rectHasArea(rect)) return ZERO_RECT
  }
  return rect
}

// ————— ALTURA DA PÁGINA: a FRAÇÃO do trilho —————
//
// REPROVAÇÃO DO DONO (2026-08-29, olhando o painel vivo): "não gostei do
// browser, ele não é adaptativo igual do claude code. Ele tem altura travada,
// fora que não vai se adaptando igual."
//
// A altura era `clamp(180px, 34vh, 460px)` no CSS: um TETO de 460px que nenhuma
// tela grande passava, e nenhum gesto do dono alcançava. O modelo do Claude
// Code desktop — que ele apontou como referência desde o design de 2026-08-15
// (§D5.1) — é outro: cada painel tem ALTURA PRÓPRIA, ajustada por uma alça
// entre painéis, e ela é uma FATIA da coluna, não um número absoluto.
//
// Por isso a preferência guardada é uma FRAÇÃO, nunca pixels:
//  · encolher a janela reescala a página junto (o "vai se adaptando");
//  · uma tela de 4K não herda a altura escolhida num notebook;
//  · e o clamp em pixels continua existindo, mas como PISO e TETO da conta —
//    o piso porque abaixo de 180px não se enxerga página nenhuma, e o teto
//    porque o trilho tem irmãs (entrega, trabalho, histórico) que não podem
//    ficar sem um palmo de coluna.
//
// Tudo aqui é puro de propósito: quem prova estas contas é o `test:browser-pane`
// em node, sem React e sem DOM. O componente só mede o trilho e obedece.

/** A fatia do trilho que a página ocupa quando o dono nunca arrastou nada.
 *  Um pouco mais da metade: a página é o instrumento da seção, mas as irmãs
 *  continuam à vista sem rolar. */
export const BROWSER_PAGE_DEFAULT_FRACTION = 0.55

/** Fração mínima/máxima que a preferência pode GUARDAR. Não é o limite do que
 *  se vê (isso é dos pixels abaixo) — é a higiene do que se grava: um valor
 *  torto no localStorage nunca vira uma página de 8 telas de altura. */
export const BROWSER_PAGE_MIN_FRACTION = 0.15
export const BROWSER_PAGE_MAX_FRACTION = 0.9

/** Piso ABSOLUTO da página em pixels. Abaixo disto não há QA visual possível:
 *  é uma fresta escura que só ocupa lugar. Ele VENCE a fração — trilho baixo
 *  com fração pequena continua entregando página. */
export const BROWSER_PAGE_MIN_HEIGHT = 180

/** O palmo de trilho que a página NUNCA come. As irmãs (entrega, trabalho,
 *  histórico, frota) e o próprio chrome do browser precisam de um pedaço de
 *  coluna à vista — senão o dock inteiro vira um retângulo preto e o dono perde
 *  a referência de onde está. */
export const BROWSER_PAGE_RAIL_FLOOR = 160

/** Passo do teclado, em PIXELS (e não em fração): a seta tem que dar o mesmo
 *  empurrão numa tela pequena e numa grande. Mesma régua do
 *  `RIGHT_RAIL_KEYBOARD_STEP`. */
export const BROWSER_PAGE_KEYBOARD_STEP = 24

export interface BrowserPageBounds {
  min: number
  max: number
}

export interface BrowserPageOptions {
  minHeight?: number
  railFloor?: number
  /**
   * O RESTO MEDIDO do trilho: tudo que divide o scroller com a página
   * (cabeçalhos das irmãs, chrome do browser, a própria alça), em pixels.
   *
   * BUG PAGO (2026-08-29, dono na tela viva: "eu aumento o tamanho aí some e
   * não tem mais como diminuir"): o floor de 160px era um CHUTE do resto, e
   * com as irmãs colapsadas o resto real passa de 220px — a página crescia
   * além da viewport do trilho, a alça saía do quadro, e a view NATIVA come o
   * wheel do mouse: não sobrava papel para rolar até ela. Alça inalcançável é
   * beco sem saída, e beco sem saída é bug.
   *
   * Quando o componente mede e passa o resto, ele SUBSTITUI o floor: o teto
   * vira `viewport - resto`, e o pé do painel (a alça) cabe SEMPRE dentro da
   * viewport do scroller, com qualquer combinação de irmãs abertas/fechadas.
   * O floor fixo fica como fallback dos contextos sem medida (primeiro
   * quadro, harness).
   */
  railRest?: number
}

/** Storage injetado (o módulo continua puro; quem passa `window.localStorage`
 *  é o componente). Espelho do `RightRailStorage`. */
export interface BrowserPageStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * Os limites da página em PIXELS, dado o trilho que existe AGORA.
 *
 * O teto é o que sobra do trilho depois do palmo das irmãs. Quando o trilho é
 * baixo demais para o piso de 180px, o piso CEDE (min = max) em vez de estourar
 * a coluna: a mesma escolha do `rightRailBounds` — geometria nunca devolve
 * `min > max`, porque aí o clamp passaria a mentir.
 *
 * Trilho ainda não medido (0) devolve zero nas duas pontas: é a verdade, e quem
 * mede é que segura o primeiro quadro.
 */
export function browserPageBounds(
  railHeight: number,
  options: BrowserPageOptions = {}
): BrowserPageBounds {
  const rail = positive(railHeight)
  // O resto MEDIDO vence o chute: é ele que garante a alça dentro da viewport
  // (ver o comentário de `railRest`). Sem medida, o floor de sempre.
  const reserved =
    options.railRest !== undefined && Number.isFinite(options.railRest)
      ? positive(options.railRest)
      : positive(options.railFloor ?? BROWSER_PAGE_RAIL_FLOOR)
  const wanted = positive(options.minHeight ?? BROWSER_PAGE_MIN_HEIGHT)
  const max = Math.max(0, rail - reserved)
  const min = Math.min(wanted, max)
  return { min, max }
}

/** Higiene da preferência: fração fora da faixa (storage torto, versão futura)
 *  volta para dentro antes de virar conta. */
export function clampBrowserPageFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return BROWSER_PAGE_DEFAULT_FRACTION
  return Math.min(BROWSER_PAGE_MAX_FRACTION, Math.max(BROWSER_PAGE_MIN_FRACTION, fraction))
}

/**
 * FRAÇÃO → PIXELS: a única conta que a tela usa para desenhar a página.
 *
 * É aqui que o "vai se adaptando" acontece: a MESMA preferência dá alturas
 * diferentes em trilhos diferentes, e redimensionar a janela reescala a página
 * sozinho — sem gesto nenhum do dono e sem teto fixo em lugar nenhum.
 */
export function browserPageHeight(
  fraction: number,
  railHeight: number,
  options: BrowserPageOptions = {}
): number {
  const rail = positive(railHeight)
  const bounds = browserPageBounds(rail, options)
  const share = clampBrowserPageFraction(fraction)
  const raw = rail * share
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, raw)))
}

/**
 * As duas pontas ALCANÇÁVEIS, em pixels — o que a alça anuncia (`aria-valuemin`
 * / `aria-valuemax`), o que o arrasto clampa e onde Home/End param.
 *
 * Não são os limites de `browserPageBounds`: num trilho muito alto a fração
 * mínima (0,15) chega ANTES do piso de 180px, e prometer 180 num
 * `aria-valuemin` que o gesto nunca alcança é mentir para o teclado. Aqui as
 * duas leis já estão compostas, porque `browserPageHeight` aplica as duas.
 */
export function browserPageRange(
  railHeight: number,
  options: BrowserPageOptions = {}
): BrowserPageBounds {
  return {
    min: browserPageHeight(BROWSER_PAGE_MIN_FRACTION, railHeight, options),
    max: browserPageHeight(BROWSER_PAGE_MAX_FRACTION, railHeight, options)
  }
}

/**
 * PIXELS → FRAÇÃO: o fim do arrasto. A altura passa pelos limites ANTES de
 * virar fração, então o que se grava é sempre um valor que a tela conseguiria
 * desenhar de novo. Trilho sem medida devolve o padrão — dividir por zero
 * gravaria `Infinity` na preferência do dono.
 */
export function browserPageFraction(
  height: number,
  railHeight: number,
  options: BrowserPageOptions = {}
): number {
  const rail = positive(railHeight)
  if (rail <= 0) return BROWSER_PAGE_DEFAULT_FRACTION
  const bounds = browserPageBounds(rail, options)
  const px = Number.isFinite(height) ? height : bounds.min
  const clamped = Math.min(bounds.max, Math.max(bounds.min, px))
  return clampBrowserPageFraction(clamped / rail)
}

/** Um empurrão de teclado, em pixels, devolvido já como fração pronta para
 *  guardar. `grow` desce a alça (página maior), `shrink` sobe. */
export function stepBrowserPageFraction(
  fraction: number,
  direction: 'grow' | 'shrink',
  railHeight: number,
  stepPx: number = BROWSER_PAGE_KEYBOARD_STEP,
  options: BrowserPageOptions = {}
): number {
  const step = Math.max(1, Math.abs(Number.isFinite(stepPx) ? stepPx : BROWSER_PAGE_KEYBOARD_STEP))
  const current = browserPageHeight(fraction, railHeight, options)
  const next = current + (direction === 'grow' ? step : -step)
  return browserPageFraction(next, railHeight, options)
}

/** A preferência é do PROJETO (como a largura do trilho): a mesma pessoa quer o
 *  browser grande no universo em que faz QA e fechado no que só escreve plano.
 *  `v1` no nome porque o formato pode crescer. */
export function browserPageStorageKey(projectKey?: string): string {
  const suffix = projectKey?.trim() ? `:${encodeURIComponent(projectKey.trim())}` : ''
  return `synkora.dockBrowser.page.v1${suffix}`
}

/**
 * Lê a fração guardada. TUDO que der errado — storage bloqueado, JSON quebrado,
 * campo de outro tipo, fração absurda — cai no padrão em silêncio: a altura de
 * um painel é preferência, e preferência ruim nunca pode impedir o dock de
 * abrir (mesma lei do `readRightRailPreference`).
 */
export function readBrowserPageFraction(
  storage: BrowserPageStorage | null | undefined,
  key: string,
  fallback: number = BROWSER_PAGE_DEFAULT_FRACTION
): number {
  if (!storage) return clampBrowserPageFraction(fallback)
  try {
    const raw = storage.getItem(key)
    if (!raw) return clampBrowserPageFraction(fallback)
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return clampBrowserPageFraction(fallback)
    const candidate = (parsed as { fraction?: unknown }).fraction
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      return clampBrowserPageFraction(fallback)
    }
    return clampBrowserPageFraction(candidate)
  } catch {
    return clampBrowserPageFraction(fallback)
  }
}

/** Grava a fração ARREDONDADA (três casas): o arrasto produz dízima, e um
 *  número de 17 dígitos no storage do dono não conta nada a mais. */
export function writeBrowserPageFraction(
  storage: BrowserPageStorage | null | undefined,
  key: string,
  fraction: number
): void {
  if (!storage) return
  try {
    const value = Math.round(clampBrowserPageFraction(fraction) * 1000) / 1000
    storage.setItem(key, JSON.stringify({ fraction: value }))
  } catch {
    // Storage cheio/bloqueado: a altura vale por esta sessão. Nunca um erro.
  }
}

// ————— OVERLAYS DO HOST —————
//
// O padrão pago (`git show 88c49d4^`) esconde a view enquanto um overlay do
// host está aberto: a view compõe POR CIMA do DOM, então um popover que
// cruzasse o retângulo dela ficaria por baixo — invisível. Lá o contador
// `hostOverlayCount` era incrementado À MÃO por cada overlay (TitleBar,
// CommandPalette, SynVoice…).
//
// Aqui a costura manual não cabe: esta fatia não é dona daqueles arquivos, e
// um contador que ninguém incrementa é uma proteção que não existe. A versão
// FIEL e leve lê o mesmo fato pela ESTRUTURA — todo overlay da casa é um
// portal em `document.body`, irmão da raiz do app — e só esconde quando o
// overlay REALMENTE cruza o retângulo da página.
//
// O tooltip fica de FORA de propósito (`role="tooltip"`): ele nasce e morre a
// cada hover, e escondê-lo apagaria a página inteira a cada passada de mouse
// pelo chrome — trocaríamos um tooltip cortado por um pisca-pisca na tela.
// A dívida está nomeada no relatório: o conserto de verdade é rotear o tooltip
// como a era da ilha fazia, e ele mora em `Tooltip.tsx`.

/** Id da raiz do app em `index.html` — o único filho PERMANENTE do body. */
export const APP_ROOT_ID = 'root'

export interface HostNode {
  id: string
  role: string | null
}

/** É um overlay do host (e não a própria árvore do app, nem um tooltip)? */
export function isHostOverlayNode(node: HostNode): boolean {
  if (node.id === APP_ROOT_ID) return false
  if (node.role === 'tooltip') return false
  return true
}

/** A página nativa some enquanto QUALQUER overlay cruza o retângulo dela. */
export function overlayHidesPage(
  page: BrowserRect,
  overlays: readonly BrowserRect[]
): boolean {
  if (!rectHasArea(page)) return false
  return overlays.some((overlay) => rectsOverlap(page, overlay))
}

// ————— BARRA DE URL —————

/** O que o dono digitou, pronto para viajar. Vazio não vira navegação: a
 *  normalização (https por padrão, busca, o que for) é do main — quem manda no
 *  endereço é ele, e o browser é do dono. */
export function trimUrlInput(raw: string): string {
  return raw.trim()
}

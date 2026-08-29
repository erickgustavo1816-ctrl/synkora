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
  const bag = value as { alive?: unknown; agentDriving?: unknown; tabs?: unknown }
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
  const notice = readBrowserNotice((value as { notice?: unknown }).notice)
  if (notice) state.notice = notice
  return state
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

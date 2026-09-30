import type {
  BrowserNoticeView,
  BrowserPanelState,
  BrowserRect,
  BrowserTab,
  BrowserTabFailure,
  BrowserTabOwner,
  BrowserTabOwnerKind,
  BrowserViewportMode
} from '../../preload/index'

// MODELO DO BROWSER DA MISSÃO — a metade PURA do chrome (`BrowserChrome`,
// `DockBrowser`, `BrowserPopout`): estado, palavras e geometria, sem `window`,
// para os gates rodarem em node. A página NÃO é desenhada pelo renderer: a
// `WebContentsView` compõe POR CIMA do DOM no retângulo reportado, então "onde"
// e "à vista" são a interface inteira entre o React e o motor. Os tipos vêm do
// preload por `import type` (apagado na compilação).

/** Teto de abas POR MISSÃO — espelho da tela; quem aplica a lei é o main. 12
 *  desde 2026-09-01: uma aba por identidade (dono + dev + frota). */
export const BROWSER_TAB_CAP = 12

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

// ————— A LARGURA QUE A PÁGINA ENXERGA (2026-08-29) —————
//
// O painel é estreito e todo site responsivo entregava o layout de celular
// ("sempre vou ver o site/app com modo tablet"). O motor emula uma largura
// LÓGICA; aqui mora só o vocabulário do seletor do chrome.

/** As opções do seletor, na ordem da lista. `'auto'` primeiro: é o estado
 *  natural e a porta de VOLTA de qualquer emulação. */
export const BROWSER_VIEWPORT_CHOICES: readonly BrowserViewportMode[] = ['auto', 375, 768, 1280]

/** O rótulo compacto do seletor ("↔ 1280 ▾"). */
export function browserViewportLabel(mode: BrowserViewportMode): string {
  return mode === 'auto' ? 'AUTO' : String(mode)
}

/** O modo VIVO. Motor antigo não manda o campo, e ausência é `'auto'`. */
export function browserViewportOf(state: BrowserPanelState): BrowserViewportMode {
  return state.viewport ?? 'auto'
}

/** O agente pode pedir QUALQUER largura (`browser_viewport` com `width`): o
 *  seletor ganha a opção dele, senão o dono veria "AUTO" numa página emulada. */
export function browserViewportIsCustom(mode: BrowserViewportMode): boolean {
  return mode !== 'auto' && !BROWSER_VIEWPORT_CHOICES.includes(mode)
}

/** As opções da lista nativa: as da casa e, quando houver, a do agente. */
export function browserViewportOptions(state: BrowserPanelState): BrowserViewportMode[] {
  const mode = browserViewportOf(state)
  return browserViewportIsCustom(mode) ? [...BROWSER_VIEWPORT_CHOICES, mode] : [...BROWSER_VIEWPORT_CHOICES]
}

function viewportKind(mode: number): string {
  return mode >= 1024 ? 'desktop' : mode >= 700 ? 'tablet' : 'celular'
}

/** O nome de cada opção na lista aberta. */
export function browserViewportOptionLabel(mode: BrowserViewportMode): string {
  if (mode === 'auto') return 'AUTO · largura do painel'
  if (browserViewportIsCustom(mode)) return `${mode} · pedido do agente`
  return `${mode} · ${viewportKind(mode)}`
}

/**
 * A FAIXA DE UM LADO, em px de app, quando a largura pedida CABE na moldura.
 * Zero = a página ocupa a moldura inteira. Quem calcula e centraliza é o motor;
 * aqui ela só decide SE a tela desenha a faixa e o que a dica conta.
 */
export function browserViewportBand(state: BrowserPanelState): number {
  const band = state.viewportBand
  return typeof band === 'number' && Number.isFinite(band) && band > 0 ? Math.round(band) : 0
}

/** O que cada largura faz, e o preço: a receita NUNCA amplia — sobrando
 *  moldura, a página fica em tamanho real entre faixas do app. */
export function browserViewportHint(mode: BrowserViewportMode): string {
  if (mode === 'auto') return 'largura real do painel · nenhuma emulação'
  return `largura de ${viewportKind(mode)} (${mode}px) · nunca amplia: sobrando moldura, a página fica em tamanho real entre faixas do app`
}

/** A moldura CABE: a página está em tamanho REAL e centralizada. Escrito porque
 *  uma faixa escura ao lado de um site escuro não se explica sozinha — e SEM o
 *  número da faixa, que muda a cada quadro de um arrasto. */
export function browserViewportFitNote(state: BrowserPanelState): string | null {
  const mode = browserViewportOf(state)
  if (mode === 'auto' || browserViewportBand(state) <= 0) return null
  return `a página está em ${mode}px REAIS, centralizada — as faixas dos lados são o app, não o site`
}

/** A moldura NÃO cabe e o piso de 0,25× do Chromium mordeu: a página recebe
 *  menos do que o seletor promete. Situação acionável, não falha. */
export function browserViewportShortfall(state: BrowserPanelState): string | null {
  const mode = browserViewportOf(state)
  if (mode === 'auto' || browserViewportBand(state) > 0) return null
  const real = state.viewportWidth
  if (typeof real !== 'number' || real <= 0 || real === mode) return null
  return `o painel é estreito demais para ${mode}px — a página está recebendo ${real}px (alargue o painel ou destaque em janela própria)`
}

/** Os dois recados de largura num só (um de cada ramo da receita, nunca
 *  juntos) — a forma que a suíte do motor ainda lê. */
export function browserViewportNote(state: BrowserPanelState): string | null {
  return browserViewportFitNote(state) ?? browserViewportShortfall(state)
}

/** A dica nativa do seletor: o modo vigente explicado e, quando foi o agente
 *  que pediu uma largura fora da lista, a saída. */
export function browserViewportTitle(state: BrowserPanelState): string {
  if (!state.alive) return 'abra uma página (+) antes de mudar a largura'
  const mode = browserViewportOf(state)
  const said = [`largura que a página enxerga · ${browserViewportFitNote(state) ?? browserViewportHint(mode)}`]
  if (browserViewportIsCustom(mode)) said.push(`o agente pediu ${mode}px lógicos · AUTO devolve a largura do painel`)
  return said.join('\n')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bool(value: unknown): boolean {
  return value === true
}

// ————— O DONO DA ABA (2026-09-01) —————
//
// "Cada um na sua aba, na sua porta" (D1/D2 de
// `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`): a tira
// responde primeiro DE QUEM é a aba, depois QUEM dirige agora.

function isOwnerKind(value: string): value is BrowserTabOwnerKind {
  return value === 'user' || value === 'dev' || value === 'helper' || value === 'agent'
}

/** Rótulo de socorro por ESPÉCIE: ficha vazia leria como aba do dono. */
const OWNER_FALLBACK_LABEL: Record<BrowserTabOwnerKind, string> = {
  user: 'dono',
  dev: 'dev',
  helper: 'ajudante',
  agent: 'agente'
}

/**
 * O dono da aba, lido DEFENSIVAMENTE, e só o que NÃO é o padrão é carregado:
 * espécie desconhecida não vira identidade inventada, e `user` cai na AUSÊNCIA
 * (uma segunda grafia do mesmo estado faria `sameBrowserPanel` achar diferença
 * onde não há). Espécie boa com rótulo vazio é nomeada pela ESPÉCIE.
 */
function readTabOwner(value: unknown): BrowserTabOwner | undefined {
  if (!value || typeof value !== 'object') return undefined
  const bag = value as { kind?: unknown; label?: unknown; paneId?: unknown }
  const kind = str(bag.kind)
  if (!isOwnerKind(kind) || kind === 'user') return undefined
  const owner: BrowserTabOwner = { kind, label: str(bag.label).trim() || OWNER_FALLBACK_LABEL[kind] }
  // O paneId não desenha pixel (é a chave do MOTOR), mas o espelho o declara.
  const paneId = str(bag.paneId).trim()
  if (paneId) owner.paneId = paneId
  return owner
}

/** O modo vindo do motor (ou da lista do seletor), lido defensivamente.
 *  Largura que não é número positivo é `'auto'`: uma escala inventada aqui
 *  viraria uma página escalada na tela do dono por causa de um payload torto. */
export function readViewportMode(value: unknown): BrowserViewportMode {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  return 'auto'
}

/** Lê a fotografia do motor DEFENSIVAMENTE: o dono do formato é o main, e um
 *  campo que falta (motor antigo, payload torto) nunca pode derrubar o painel.
 *  Aba sem `tabId` é descartada — sem id não há gesto possível sobre ela. */
export function normalizeBrowserPanel(value: unknown): BrowserPanelState {
  if (!value || typeof value !== 'object') return EMPTY_BROWSER_PANEL
  const bag = value as {
    alive?: unknown
    agentDriving?: unknown
    tabs?: unknown
    host?: unknown
    viewport?: unknown
    viewportWidth?: unknown
    viewportBand?: unknown
  }
  const rawTabs = Array.isArray(bag.tabs) ? bag.tabs : []
  const tabs: BrowserTab[] = []
  for (const entry of rawTabs) {
    if (!entry || typeof entry !== 'object') continue
    const tab = entry as Record<string, unknown>
    const tabId = str(tab.tabId)
    if (!tabId) continue
    const view: BrowserTab = {
      tabId,
      title: str(tab.title),
      url: str(tab.url),
      active: bool(tab.active),
      loading: bool(tab.loading),
      canBack: bool(tab.canBack),
      canForward: bool(tab.canForward),
      viewport: readViewportMode(tab.viewport)
    }
    // Dono, ⚡ e falha POR ABA só são escritos quando NÃO são o padrão: é o que
    // um motor anterior conta ao não mandar campo nenhum.
    const owner = readTabOwner(tab.owner)
    if (owner) view.owner = owner
    if (bool(tab.driving)) view.driving = true
    const failure = readTabFailure(tab.failure)
    if (failure) view.failure = failure
    tabs.push(view)
  }
  // Aba sem nenhuma ativa deixaria a barra e a tira contando histórias
  // diferentes: a primeira assume.
  if (tabs.length > 0 && !tabs.some((tab) => tab.active)) tabs[0].active = true
  const state: BrowserPanelState = {
    alive: bool(bag.alive) || tabs.length > 0,
    agentDriving: bool(bag.agentDriving),
    tabs
  }
  // Host, largura e faixa: só o que NÃO é o padrão (dock, auto, zero) é
  // carregado — uma segunda grafia do mesmo estado repintaria à toa.
  if (bag.host === 'popout') state.host = 'popout'
  const viewport = readViewportMode(bag.viewport)
  if (viewport !== 'auto') state.viewport = viewport
  if (typeof bag.viewportWidth === 'number' && Number.isFinite(bag.viewportWidth)) {
    state.viewportWidth = Math.round(bag.viewportWidth)
  }
  if (
    typeof bag.viewportBand === 'number' &&
    Number.isFinite(bag.viewportBand) &&
    bag.viewportBand > 0
  ) {
    state.viewportBand = Math.round(bag.viewportBand)
  }
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

/** Palavras do motor (a nota da missão, a falha de uma aba) só entram na tela
 *  se tiverem TEXTO: uma nota muda ocuparia uma linha dizendo nada. */
function readEngineWords(value: unknown): { kind: string; text: string; title?: string } | null {
  if (!value || typeof value !== 'object') return null
  const bag = value as { kind?: unknown; text?: unknown; title?: unknown }
  const text = str(bag.text).trim()
  if (!text) return null
  // Os campos opcionais só são escritos quando o motor os manda: a ausência é
  // o motor anterior, e uma segunda grafia repintaria o dock à toa.
  const words: { kind: string; text: string; title?: string } = { kind: str(bag.kind), text }
  const title = str(bag.title).trim()
  if (title) words.title = title
  return words
}

function readTabFailure(value: unknown): BrowserTabFailure | null {
  const words = readEngineWords(value)
  if (!words) return null
  const failure: BrowserTabFailure = words
  const code = str((value as { code?: unknown }).code).trim()
  if (code) failure.code = code
  return failure
}

function readBrowserNotice(value: unknown): BrowserNoticeView | null {
  const words = readEngineWords(value)
  if (!words) return null
  const bag = value as { at?: unknown; count?: unknown; url?: unknown }
  const notice: BrowserNoticeView = { ...words, at: str(bag.at) }
  // Só a REPETIÇÃO conta (≥ 2 vira "×N"); um recado só é o padrão.
  if (typeof bag.count === 'number' && Number.isFinite(bag.count) && bag.count >= 2) {
    notice.count = Math.floor(bag.count)
  }
  const url = str(bag.url).trim()
  if (url) notice.url = url
  return notice
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
  // Host (o ⧉ vira recibo), largura (o seletor aceso, inclusive a do agente) e
  // faixa (as bandas nascem e morrem) mudam a tela sozinhos.
  if (a.host !== b.host) return false
  if (
    a.viewport !== b.viewport ||
    a.viewportWidth !== b.viewportWidth ||
    a.viewportBand !== b.viewportBand
  ) {
    return false
  }
  // A nota do motor tem CARIMBO: duas notas do mesmo texto em momentos
  // diferentes são dois avisos, e o segundo precisa chegar à tela. A repetição
  // coalescida MANTÉM o carimbo — é o contador que muda o "×N".
  if (
    a.notice?.at !== b.notice?.at ||
    a.notice?.text !== b.notice?.text ||
    a.notice?.title !== b.notice?.title ||
    a.notice?.count !== b.notice?.count ||
    a.notice?.url !== b.notice?.url
  ) {
    return false
  }
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
      tab.canForward === other.canForward &&
      tab.viewport === other.viewport &&
      tab.driving === other.driving &&
      // O dono entra pelo que a tira DESENHA (espécie e rótulo); o `paneId` não
      // aparece em pixel nenhum e repintaria o dock a cada passo do agente.
      tab.owner?.kind === other.owner?.kind &&
      tab.owner?.label === other.owner?.label &&
      // A FALHA acende o cartão de erro na página e a marca na aba.
      tab.failure?.kind === other.failure?.kind &&
      tab.failure?.text === other.failure?.text &&
      tab.failure?.title === other.failure?.title &&
      tab.failure?.code === other.failure?.code
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

/** A ficha do dono na tira, ANTES do nome da página. `null` para a aba do
 *  dono: a forma dele é a AUSÊNCIA de prefixo (ele é a régua da tira). A caixa
 *  alta é do CSS, para o leitor de tela ouvir "inv-brand" e não soletrar. */
export function browserTabOwnerTag(tab: BrowserTab): string | null {
  const owner = tab.owner
  if (!owner || owner.kind === 'user') return null
  return owner.kind === 'dev' ? 'DEV' : owner.label
}

/** A frase do dono. "aba DE x" para todo mundo: "aba do inv-brand" leria
 *  ERRADO, e uma regra só nunca sai da gramática. */
export function browserTabOwnerPhrase(tab: BrowserTab): string | null {
  const owner = tab.owner
  if (!owner || owner.kind === 'user') return null
  return `aba de ${owner.label}`
}

/** O título do cartão de erro: o do motor e, no motor anterior (sem `title`),
 *  o da ESPÉCIE da falha — nunca derivado do texto. */
export function browserTabFailureTitle(failure: BrowserTabFailure): string {
  if (failure.title) return failure.title
  if (failure.kind === 'load-failed') return 'a página não carregou'
  if (failure.kind === 'crashed') return 'a página caiu'
  if (failure.kind === 'unresponsive') return 'a página parou de responder'
  return 'a página falhou'
}

/** A falha da aba À VISTA — é ela que troca a página nativa pelo cartão. */
export function activeBrowserTabFailure(state: BrowserPanelState): BrowserTabFailure | null {
  return activeBrowserTab(state)?.failure ?? null
}

// ————— ESPERAR A PÁGINA TRAVADA (2026-09-29) —————
//
// ESPERAR é o dono escolhendo OLHAR a página travada em vez do cartão: o host
// para de esconder a página por AQUELA falha (aba + espécie + texto). Falha que
// muda ou some encerra a espera — a próxima volta ao cartão.

/** A identidade da falha à vista; `null` = página de pé. */
export function browserFailureIdentity(state: BrowserPanelState): string | null {
  const tab = activeBrowserTab(state)
  if (!tab?.failure) return null
  return `${tab.tabId}\n${tab.failure.kind}\n${tab.failure.text}`
}

/** A espera que ainda vale: a MESMA string enquanto a falha é a mesma, `null`
 *  quando ela mudou ou sumiu (espelho do `liveNoticeDismissals`). */
export function liveBrowserWait(state: BrowserPanelState, waited: string | null): string | null {
  return waited !== null && waited === browserFailureIdentity(state) ? waited : null
}

/** O host ESCONDE a página nativa (e o retângulo mostra o cartão)? Só com a
 *  aba à vista em falha que o dono não escolheu esperar. */
export function browserPageHidden(state: BrowserPanelState, waited: string | null): boolean {
  const identity = browserFailureIdentity(state)
  return identity !== null && identity !== waited
}

/** A frase inteira da aba: de quem é, que página é, e o que a ficha e a marca
 *  de erro dizem só por desenho. Com doze abas cortadas, é o que a identifica. */
export function browserTabSentence(tab: BrowserTab): string {
  const said = [browserTabOwnerPhrase(tab), browserTabLabel(tab)]
  if (tab.driving) said.push('dirigindo agora')
  if (tab.failure) said.push(browserTabFailureTitle(tab.failure))
  return said.filter(Boolean).join(' · ')
}

/** A dica nativa da aba (`title`): a frase e, embaixo, o endereço inteiro. */
export function browserTabTitle(tab: BrowserTab): string {
  const sentence = browserTabSentence(tab)
  return tab.url ? `${sentence}\n${tab.url}` : sentence
}

/** Alguém dirige: o ⚡ da missão OU o de uma aba (motor que só marca um). */
export function browserAgentDriving(state: BrowserPanelState): boolean {
  return state.agentDriving || state.tabs.some((tab) => tab.driving === true)
}

/** O RESUMO da seção — a única verdade que sobra com o painel RECOLHIDO, então
 *  ele carrega o que decide se vale reabrir: quem está dirigindo, o que está
 *  carregando, e quantas abas existem. */
export function browserSectionSummary(
  state: BrowserPanelState,
  engine: BrowserEngineState = 'ready'
): string {
  if (engine === 'missing') return 'motor velho'
  const driver = state.tabs.find((tab) => tab.driving)
  const bolt = browserAgentDriving(state) ? '⚡ ' : ''
  // Destacada, "3 abas" faria o dono procurar no dock uma página de outra janela.
  if (browserIsPopout(state)) return `${bolt}destacado`
  const tab = activeBrowserTab(state)
  if (!state.alive || !tab) return 'fechado'
  // QUEM dirige vence o nome da página; driver sem dono não tem quem nomear.
  const label = driver?.owner
    ? `${driver.owner.label} dirigindo`
    : tab.loading
      ? 'carregando…'
      : browserTabLabel(tab)
  const extra = state.tabs.length > 1 ? ` · ${state.tabs.length} abas` : ''
  // A largura emulada sobrevive à seção recolhida: "quebrou" ou "é desktop"?
  const mode = browserViewportOf(state)
  const width = mode === 'auto' ? '' : ` · ${mode}`
  return `${bolt}${label}${extra}${width}`
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

/** Native views must fit INSIDE fractional DOM edges. Rounding position and
 *  size separately lets the view cover a border at some resize widths.
 *  Overlay detection retains its existing nearest-pixel rounding. */
export function browserRect(box: DomBox, rounding: 'nearest' | 'inward' = 'nearest'): BrowserRect {
  if (rounding === 'inward') {
    const left = finite(box.left)
    const top = finite(box.top)
    const x = Math.ceil(left)
    const y = Math.ceil(top)
    return {
      x, y,
      width: Math.max(0, Math.floor(left + Math.max(0, finite(box.width))) - x),
      height: Math.max(0, Math.floor(top + Math.max(0, finite(box.height))) - y)
    }
  }
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

// ————— ALTURA DA PÁGINA: a FRAÇÃO do trilho (trilho legado do dock) —————
//
// "Ele tem altura travada, fora que não vai se adaptando" (2026-08-29): a
// preferência guardada é uma FRAÇÃO da coluna, nunca pixels — encolher a janela
// reescala a página, e uma tela 4K não herda a altura de um notebook. Os pixels
// ficam como PISO (abaixo de 180px não há QA visual) e TETO (as irmãs do trilho
// precisam de um palmo de coluna).

/** A fatia do trilho quando o dono nunca arrastou nada. */
export const BROWSER_PAGE_DEFAULT_FRACTION = 0.55

/** Higiene do que se GRAVA: storage torto nunca vira uma página de 8 telas. */
export const BROWSER_PAGE_MIN_FRACTION = 0.15
export const BROWSER_PAGE_MAX_FRACTION = 0.9

/** Piso absoluto em pixels; ele VENCE a fração. */
export const BROWSER_PAGE_MIN_HEIGHT = 180

/** O palmo de trilho que a página nunca come (fallback sem medida). */
export const BROWSER_PAGE_RAIL_FLOOR = 160

/** Passo do teclado em PIXELS: o mesmo empurrão em tela pequena e grande. */
export const BROWSER_PAGE_KEYBOARD_STEP = 24

export interface BrowserPageBounds {
  min: number
  max: number
}

export interface BrowserPageOptions {
  minHeight?: number
  railFloor?: number
  /**
   * O RESTO MEDIDO do trilho (irmãs, chrome, alça), em pixels. Ele SUBSTITUI o
   * floor: com o chute de 160px a página passava da viewport, a alça saía do
   * quadro e a view nativa comia o wheel — "aumento o tamanho aí some e não
   * tem mais como diminuir" (2026-08-29).
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
// A view compõe POR CIMA do DOM: um overlay que cruze o retângulo ficaria por
// baixo dela, invisível. Todo overlay da casa é um portal em `document.body`,
// irmão da raiz — o fato é lido pela ESTRUTURA, e a página só some quando o
// overlay REALMENTE a cruza. O tooltip fica de fora: escondê-lo a cada hover
// faria a página piscar.

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

// ————— AS IRMÃS DO TRILHO (H9, 2026-08-29) —————
//
// Seção vizinha que recolhe EMPURRA a página sem mudar tamanho nenhum: sem
// observar as irmãs, sobrava o relógio de 400ms (p95 de 384ms de página no
// lugar errado; observando, 0,28ms — `.synkora/reports/h9/probe-h9-fluidity.mjs`).
// A que CONTÉM a página fica de fora: ela muda a cada quadro do arrasto, e o
// observador do retângulo já conta isso (observá-la triplicava os relatos).
export function browserSiblingsToWatch<T>(
  children: readonly T[],
  holdsPage: (child: T) => boolean
): T[] {
  return children.filter((child) => !holdsPage(child))
}

// ————— O PORTÃO E A BOMBA DA GEOMETRIA (H9) —————
//
// QUANDO o motor ouve falar do retângulo. Moram no módulo puro porque os DOIS
// hosts (dock e janela destacada) usam as mesmas, e disciplina de quadro que
// não é testável ninguém defende.

export interface BrowserBoundsReport {
  rect: BrowserRect
  visible: boolean
}

/** O PORTÃO: relato repetido não vai ao motor. A chave é RETÂNGULO + VISÍVEL —
 *  a página que não mexeu mas SAIU DE VISTA precisa que o `false` atravesse. */
export interface BrowserBoundsGate {
  /** Este relato é novidade? (e, se for, ele passa a ser o último) */
  accept(rect: BrowserRect, visible: boolean): boolean
  /** ESQUECE o último: a rota de quando o retângulo não mudou mas a VERDADE
   *  mudou (view recém-nascida, painel de volta à vista, solta da alça, a
   *  página que troca pelo cartão de erro). */
  reset(): void
  last(): BrowserBoundsReport | null
}

export function createBrowserBoundsGate(): BrowserBoundsGate {
  let last: BrowserBoundsReport | null = null
  return {
    accept(rect, visible) {
      if (last && last.visible === visible && sameBrowserRect(last.rect, rect)) return false
      last = { rect, visible }
      return true
    },
    reset() {
      last = null
    },
    last() {
      return last
    }
  }
}

/**
 * A BOMBA: duas entradas, e a diferença entre elas vale um QUADRO INTEIRO
 * (medido na sonda H9).
 *
 *  · `hot()` — para quem corre DEPOIS do layout (o `ResizeObserver`): um rAF
 *    pedido dali lê a geometria VELHA no quadro seguinte (2,01 → 1,03 quadros).
 *  · `cold()` — para quem dispara em RAJADA antes da fase de rAF (`scroll`,
 *    `resize`, mutação de portal, o relógio): ali coalescer é de graça.
 *
 * `hot()` CANCELA um quadro frio pendente: o relato dele nasceria velho.
 */
export interface BrowserBoundsPumpHost {
  /** mede e relata AGORA (quem sabe medir é o host, não a bomba) */
  measure(): void
  /** Agenda para o próximo quadro. O identificador tem de ser NÃO-ZERO — é ele
   *  que responde "há quadro pendente?" (o rAF do browser cumpre isso). */
  requestFrame(run: () => void): number
  cancelFrame(handle: number): void
}

export interface BrowserBoundsPump {
  hot(): void
  cold(): void
  /** Terminal cleanup: retained callbacks and pending frames become inert. */
  stop(): void
  pending(): boolean
}

export function createBrowserBoundsPump(host: BrowserBoundsPumpHost): BrowserBoundsPump {
  let frame = 0
  let stopped = false
  const drop = (): void => {
    if (!frame) return
    host.cancelFrame(frame)
    frame = 0
  }
  return {
    hot() {
      if (stopped) return
      drop()
      host.measure()
    },
    cold() {
      if (stopped || frame) return
      frame = host.requestFrame(() => {
        frame = 0
        if (stopped) return
        host.measure()
      })
    },
    stop() {
      stopped = true
      drop()
    },
    pending() {
      return frame !== 0
    }
  }
}

// ————— BARRA DE URL —————

/** O que o dono digitou, pronto para viajar. Vazio não vira navegação: a
 *  normalização (https por padrão, busca, o que for) é do main — quem manda no
 *  endereço é ele, e o browser é do dono. */
export function trimUrlInput(raw: string): string {
  return raw.trim()
}

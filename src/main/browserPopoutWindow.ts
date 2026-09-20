/**
 * BROWSER POP-OUT — A JANELA (fatia P1 do
 * `.synkora/reports/DESIGN_BROWSER_POPOUT_2026-08-29.md`).
 *
 * "Tirar ele dali e desfixar, como o microfone que eu clico e ele sai — mas que
 * ele saia com todas as funções, quase como se fosse um app à parte."
 *
 * UMA janela por MISSÃO. Ela não desenha a página: a MESMA `WebContentsView`
 * que estava no dock é REPARENTADA para cá viva (sonda
 * `PROBE_BROWSER_POPOUT_2026-08-29.md`: 4 ms no main, um quadro de 17 ms, e
 * scroll/formulário/timers/SSE/WebSocket/sessão CDP do agente atravessam
 * INTACTOS — recriar a view perderia tudo isso para resolver um problema que
 * não existe). Este módulo é só a CASA: janela, geometria, título, ciclo de
 * vida. Quem manda na view é o motor (`./browserPane`).
 *
 * ——— as leis da sonda que ESTE arquivo carrega ———
 * 1. **A janela está VISÍVEL antes de a view chegar.** `open()` só volta com
 *    `showInactive()` feito (e `restore()` se estava minimizada): mover a view
 *    para uma janela escondida PENDURA as duas rotas de captura, porque ela
 *    nunca compôs um quadro ali. `showInactive` e não `show` — quem dá o foco é
 *    o motor, DEPOIS do reparent.
 * 2. **Nunca calcular retângulo de janela minimizada.** `getContentBounds()`
 *    devolve `width:0` ali (enquanto `getBounds()` segue mentindo 930×700) e a
 *    captura passa a responder RÁPIDO e ERRADA — 356 vezes seguidas na sonda.
 *    Por isso `contentSize()` devolve `null` com a janela minimizada, e o
 *    `restore` avisa o motor para REFAZER o `setBounds` (a cura medida).
 * 3. **O X não mata a página.** O Electron 43 não destrói o `webContents` filho
 *    junto com a janela (§P6): a view ficaria ÓRFÃ e VIVA, com a captura
 *    pendurando 6 s e o agente dirigindo uma página que ninguém vê. Então o
 *    `close` primeiro AVISA o motor (que reencaixa no dock) e só depois a
 *    janela morre — fechar é REENCAIXAR, nunca perder.
 *
 * ——— o que ele deve à casa ———
 * Precedente do mini SynVoice (`index.ts`): `BrowserWindow` com o preload do
 * app + `additionalArguments`, rota do renderer por query com
 * `trustedRendererView`, e o **fix de DPI misto** (bounds reaplicados DEPOIS da
 * criação — nascer com x/y de outro monitor aplica a escala errada). A rota do
 * renderer e a política de URL confiável NÃO são duplicadas aqui: chegam
 * injetadas (`loadView`/`trustedUrl`), porque quem é dono delas é o `index.ts`.
 */
import { BrowserWindow, screen, shell } from 'electron'
import { attachBrowserSurface, detachBrowserSurface } from './browserBackgroundSurface'
import type { BlackboxEventInput } from './blackbox'
import type { BrowserPopoutHandle, BrowserPopoutHost } from './browserPaneHost'
import { loadJsonStore, persistJsonStore } from './jsonStore'

/** A view do renderer que esta janela carrega (rota da casa, por query). */
export const BROWSER_POPOUT_VIEW = 'browser-popout'
/** Fundo do app enquanto o renderer não pintou (nunca um flash branco). */
export const BROWSER_POPOUT_BACKGROUND = '#0c0f15'
export const BROWSER_POPOUT_MIN_WIDTH = 520
export const BROWSER_POPOUT_MIN_HEIGHT = 380
export const BROWSER_POPOUT_DEFAULT_WIDTH = 1120
export const BROWSER_POPOUT_DEFAULT_HEIGHT = 780
/** Grava move/resize em rajada uma vez só (mesmo passo da mini SynVoice). */
const BROWSER_POPOUT_PERSIST_MS = 160
/** Título de janela é linha única: página longa vira reticências. */
const BROWSER_POPOUT_TITLE_MAX = 80

/** Geometria lembrada POR PROJETO (o dono trabalha um universo por vez, e a
 *  janela que ele posicionou vale para todas as missões daquele universo). */
export interface BrowserPopoutBounds {
  x: number
  y: number
  width: number
  height: number
  maximized?: boolean
}

interface BrowserPopoutStore {
  byProject: Record<string, BrowserPopoutBounds>
}

/** Área de trabalho de um monitor — o mínimo que o cálculo puro precisa. */
export interface BrowserPopoutArea {
  x: number
  y: number
  width: number
  height: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPopoutBounds(value: unknown): value is BrowserPopoutBounds {
  if (!value || typeof value !== 'object') return false
  const bag = value as Partial<BrowserPopoutBounds>
  return (
    isFiniteNumber(bag.x) &&
    isFiniteNumber(bag.y) &&
    isFiniteNumber(bag.width) &&
    isFiniteNumber(bag.height)
  )
}

function isPopoutStore(value: unknown): value is BrowserPopoutStore {
  if (!value || typeof value !== 'object') return false
  const bag = value as Partial<BrowserPopoutStore>
  if (!bag.byProject || typeof bag.byProject !== 'object') return false
  return Object.values(bag.byProject as Record<string, unknown>).every(isPopoutBounds)
}

/**
 * ONDE A JANELA ABRE — puro, para o gate poder prender a regra sem monitor.
 *
 * A posição salva é INTOCADA enquanto ela alcança algum monitor de verdade
 * (mesma regra da mini SynVoice: o dono manda no lugar). Monitor desligado /
 * resolução trocada / posição de outro arranjo ⇒ a janela renasce CENTRADA na
 * área do monitor da âncora (a janela do app), nunca fora da tela.
 */
export function browserPopoutBoundsOn(
  saved: BrowserPopoutBounds | null,
  areas: readonly BrowserPopoutArea[],
  anchor: BrowserPopoutArea | null
): BrowserPopoutBounds {
  const width = Math.max(
    BROWSER_POPOUT_MIN_WIDTH,
    Math.round(saved && isFiniteNumber(saved.width) ? saved.width : BROWSER_POPOUT_DEFAULT_WIDTH)
  )
  const height = Math.max(
    BROWSER_POPOUT_MIN_HEIGHT,
    Math.round(saved && isFiniteNumber(saved.height) ? saved.height : BROWSER_POPOUT_DEFAULT_HEIGHT)
  )
  const reachable =
    saved !== null &&
    areas.some((area) => {
      const overlapX = Math.min(saved.x + width, area.x + area.width) - Math.max(saved.x, area.x)
      const overlapY = Math.min(saved.y + height, area.y + area.height) - Math.max(saved.y, area.y)
      // 120×48 = tem barra de título suficiente para o dono agarrar a janela.
      return overlapX >= 120 && overlapY >= 48
    })
  if (saved && reachable) {
    return { x: Math.round(saved.x), y: Math.round(saved.y), width, height, maximized: saved.maximized }
  }
  const home =
    (anchor
      ? areas.find(
          (area) =>
            anchor.x + anchor.width / 2 >= area.x &&
            anchor.x + anchor.width / 2 < area.x + area.width &&
            anchor.y + anchor.height / 2 >= area.y &&
            anchor.y + anchor.height / 2 < area.y + area.height
        )
      : undefined) ??
    areas[0]
  if (!home) return { x: 0, y: 0, width, height, maximized: saved?.maximized }
  return {
    x: Math.round(home.x + Math.max(0, (home.width - width) / 2)),
    y: Math.round(home.y + Math.max(0, (home.height - height) / 2)),
    width: Math.min(width, Math.max(BROWSER_POPOUT_MIN_WIDTH, home.width)),
    height: Math.min(height, Math.max(BROWSER_POPOUT_MIN_HEIGHT, home.height)),
    maximized: saved?.maximized
  }
}

/** "«página» · «missão»" — o título que o dono lê na taskbar. */
export function browserPopoutTitle(pageTitle: string, missionTitle: string): string {
  const page = pageTitle.trim().replace(/\s+/gu, ' ')
  const mission = missionTitle.trim().replace(/\s+/gu, ' ') || 'missão'
  if (!page) return mission
  const short = page.length > BROWSER_POPOUT_TITLE_MAX
    ? `${page.slice(0, BROWSER_POPOUT_TITLE_MAX - 1).trimEnd()}…`
    : page
  return `${short} · ${mission}`
}

export interface BrowserPopoutDeps {
  record(input: BlackboxEventInput): void
  /** Arquivo da geometria (userData/browser-popout-position.json). */
  storeFile(): string
  /** Nome legível da missão para a barra da janela. */
  missionTitle(missionId: string): string
  /** Onde a janela nasce quando não há posição salva (a janela do app). */
  anchorBounds(): BrowserPopoutArea | null
  /** Ícone da janela (o `resolveAppIcon` do index). */
  icon(): string | undefined
  /** O preload do APP (a janela é uma view do app, não um overlay com api
   *  própria): é ele que dá `window.synkora.browser` à página destacada. */
  preloadFile(): string
  /** Carrega a rota do renderer. O `index.ts` é dono da URL e do
   *  `trustedRendererView` — a política não se duplica aqui. */
  loadView(win: BrowserWindow, query: Record<string, string>): void
  /** A MESMA política, para o guarda de navegação desta janela. */
  trustedUrl(url: string): boolean
  /** O X da janela = REENCAIXAR no dock (lei 3). Chamado ANTES do destroy. */
  onCloseRequested(missionId: string): void
  /** resize/move/maximizar: o motor reaplica a geometria da view. */
  onGeometry(missionId: string): void
  /** Restaurada de minimizada: CURA 2 — o motor REFAZ o `setBounds`. */
  onRestored(missionId: string): void
}

/** O que o `index.ts` usa além do contrato do motor. */
export interface BrowserPopoutWindows extends BrowserPopoutHost {
  /** Autoridade do remetente: de QUAL missão é esta janela? `null` = não é
   *  pop-out nenhum (o porteiro do IPC recusa). */
  missionOf(webContentsId: number): string | null
  /** `browser:changed` também precisa chegar nas janelas destacadas — o
   *  `pushAll` da casa só fala com a janela principal. */
  broadcast(channel: string, ...args: unknown[]): void
}

interface PopoutEntry {
  missionId: string
  projectId: string
  win: BrowserWindow
  /** Guardado na criação: depois do `closed` a janela não responde mais
   *  `win.webContents` (acessar objeto destruído JOGA). */
  webContentsId: number
  pageTitle: string
  persistTimer: NodeJS.Timeout | null
  /** Fechando POR DENTRO (o X do dono): `close()` do motor vira no-op. */
  closing: boolean
}

export function createBrowserPopoutWindows(deps: BrowserPopoutDeps): BrowserPopoutWindows {
  const entries = new Map<string, PopoutEntry>()
  /** webContents.id → missão. É por AQUI que o porteiro do IPC identifica o
   *  host que está falando (o remetente é infalsificável; um campo no payload
   *  seria só uma alegação do renderer). */
  const senders = new Map<number, string>()

  const record = (event: string, entry: PopoutEntry, extra: Omit<BlackboxEventInput, 'cat' | 'event'>): void => {
    deps.record({
      cat: 'pane',
      event,
      ids: { projectId: entry.projectId, missionId: entry.missionId },
      ...extra
    })
  }

  const loadStore = (): BrowserPopoutStore =>
    loadJsonStore<BrowserPopoutStore>(
      deps.storeFile(),
      () => ({ byProject: {} }),
      isPopoutStore
    )

  const savedFor = (projectId: string): BrowserPopoutBounds | null => {
    try {
      return loadStore().byProject[projectId] ?? null
    } catch {
      // Geometria é conveniência: nunca impede a janela de abrir.
      return null
    }
  }

  const persistBounds = (entry: PopoutEntry): void => {
    const win = entry.win
    if (win.isDestroyed() || win.isMinimized()) return
    const maximized = win.isMaximized()
    // Maximizada, `getBounds()` devolveria o monitor inteiro e a janela nunca
    // mais voltaria ao tamanho que o dono escolheu: o que se guarda é o normal.
    const bounds = maximized ? win.getNormalBounds() : win.getBounds()
    try {
      const store = loadStore()
      store.byProject[entry.projectId] = {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        maximized
      }
      persistJsonStore(deps.storeFile(), store)
    } catch {
      // idem: geometria nunca derruba o pop-out
    }
  }

  const schedulePersist = (entry: PopoutEntry): void => {
    if (entry.persistTimer) clearTimeout(entry.persistTimer)
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = null
      persistBounds(entry)
    }, BROWSER_POPOUT_PERSIST_MS)
    entry.persistTimer.unref?.()
  }

  const applyTitle = (entry: PopoutEntry): void => {
    if (entry.win.isDestroyed()) return
    entry.win.setTitle(browserPopoutTitle(entry.pageTitle, deps.missionTitle(entry.missionId)))
  }

  const handleOf = (entry: PopoutEntry): BrowserPopoutHandle => ({
    missionId: entry.missionId,
    attach(view) {
      if (entry.win.isDestroyed()) return
      // UM PASSO (sonda §P1): sem `removeChildView` antes. As duas formas
      // empataram em custo (4,2 × 4,1 ms), mas só esta não tem instante nenhum
      // com a view fora de árvore — e é ali que a captura pendura 5-8 s.
      attachBrowserSurface(entry.win, view)
    },
    detach(view) {
      if (entry.win.isDestroyed()) return
      try {
        detachBrowserSurface(entry.win, view)
      } catch {
        // janela no meio do teardown — o close do webContents basta
      }
    },
    contentSize() {
      const win = entry.win
      // FENCE 3: minimizada, `getContentBounds()` devolve width:0 e a captura
      // passa a MENTIR. Nenhum retângulo sai daqui nesse estado.
      if (win.isDestroyed() || win.isMinimized()) return null
      const [width, height] = win.getContentSize()
      return { width, height }
    },
    visible() {
      const win = entry.win
      return !win.isDestroyed() && win.isVisible() && !win.isMinimized()
    },
    focus() {
      const win = entry.win
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.showInactive()
      win.focus()
    },
    setTitle(pageTitle) {
      if (entry.pageTitle === pageTitle) return
      entry.pageTitle = pageTitle
      applyTitle(entry)
    }
  })

  /** A janela crua. Separada do `create` só porque o `new BrowserWindow` pode
   *  JOGAR (app em pleno `will-quit`) e o gesto tem de recusar com receita em
   *  vez de derrubar o main. */
  const buildWindow = (geometry: BrowserPopoutBounds, missionId: string): BrowserWindow => {
    const icon = deps.icon()
    return new BrowserWindow({
      width: geometry.width,
      height: geometry.height,
      minWidth: BROWSER_POPOUT_MIN_WIDTH,
      minHeight: BROWSER_POPOUT_MIN_HEIGHT,
      backgroundColor: BROWSER_POPOUT_BACKGROUND,
      title: browserPopoutTitle('', deps.missionTitle(missionId)),
      ...(icon ? { icon } : {}),
      // A sonda §P6 flagrou a barra de menu padrão do Electron (File/Edit/View)
      // nascendo na janela nova — em produção ela não existe.
      autoHideMenuBar: true,
      // "quase como se fosse um app à parte": redimensionável, na taskbar,
      // minimizável/maximizável, e NUNCA sempre-no-topo (isso é linguagem da
      // mini do microfone, que é um controle; esta é uma JANELA DE TRABALHO).
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      show: false,
      webPreferences: {
        preload: deps.preloadFile(),
        sandbox: false,
        // A view da página é filha desta janela: estrangular o renderer do
        // cromo estrangularia o quadro por baixo dele.
        backgroundThrottling: false,
        additionalArguments: ['--browser-popout']
      }
    })
  }

  const create = (missionId: string, projectId: string): PopoutEntry | null => {
    const geometry = browserPopoutBoundsOn(
      savedFor(projectId),
      screen.getAllDisplays().map((display): BrowserPopoutArea => display.workArea),
      deps.anchorBounds()
    )
    let win: BrowserWindow
    try {
      win = buildWindow(geometry, missionId)
    } catch {
      return null
    }
    const entry: PopoutEntry = {
      missionId,
      projectId,
      win,
      webContentsId: win.webContents.id,
      pageTitle: '',
      persistTimer: null,
      closing: false
    }
    // DPI MISTO (fix da casa, sonda 2026-08-03): nascer com x/y de um monitor de
    // outra escala aplica a escala errada e a janela "aparece em lugar
    // aleatório". Reaplicar os bounds DEPOIS de criada usa a escala do monitor
    // certo.
    win.setBounds({ x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height })
    if (geometry.maximized) win.maximize()

    const guardNavigation = (event: Electron.Event, url: string): void => {
      if (deps.trustedUrl(url)) return
      event.preventDefault()
      if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    }
    win.webContents.on('will-navigate', guardNavigation)
    win.webContents.on('will-redirect', guardNavigation)
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // Mesma ponte de `EventEmitter` cru do host de views: o `on` da
    // `BrowserWindow` tem uma sobrecarga por evento, e um laço sobre a união
    // dos nomes não casa com nenhuma delas.
    const emitter = win as unknown as { on(event: string, listener: () => void): unknown }
    for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
      emitter.on(event, () => {
        deps.onGeometry(missionId)
        schedulePersist(entry)
      })
    }
    // CURA 2 da sonda: `restore()` sozinho NÃO cura — o pixel continuou errado
    // até o `setBounds` ser REFEITO. É este aviso que manda o motor refazer.
    win.on('restore', () => deps.onRestored(missionId))
    win.on('close', () => {
      entry.closing = true
      if (entry.persistTimer) {
        clearTimeout(entry.persistTimer)
        entry.persistTimer = null
      }
      persistBounds(entry)
      // LEI 3: reencaixar ANTES do destroy. O Electron 43 não mata o
      // `webContents` filho junto com a janela — sem isto a view ficaria órfã e
      // VIVA, e toda captura penduraria 6 s (§P6).
      deps.onCloseRequested(missionId)
    })
    win.on('closed', () => {
      senders.delete(entry.webContentsId)
      if (entries.get(missionId) === entry) entries.delete(missionId)
    })

    senders.set(entry.webContentsId, missionId)
    entries.set(missionId, entry)
    deps.loadView(win, { missionId, projectId })
    return entry
  }

  /** O fechamento POR FORA (motor: dockBack terminado, missão morta, quit). */
  const closeWindow = (missionId: string): void => {
    const entry = entries.get(missionId)
    if (!entry) return
    // Re-entrada: quando o gesto NASCEU do `close` da janela, o motor reencaixa
    // e pede o fechamento de volta — mas o fechamento já está acontecendo.
    // Fechar de novo aqui seria um segundo `close` no meio do primeiro.
    if (entry.closing) return
    entry.closing = true
    if (entry.persistTimer) {
      clearTimeout(entry.persistTimer)
      entry.persistTimer = null
    }
    persistBounds(entry)
    entries.delete(missionId)
    senders.delete(entry.webContentsId)
    if (!entry.win.isDestroyed()) entry.win.destroy()
    record('browser-popout-closed', entry, {
      actor: 'harness',
      reason: 'janela do pop-out fechada (a página já voltou para o dock)'
    })
  }

  return {
    open(missionId, projectId) {
      const existing = entries.get(missionId)
      // Janela em pleno fechamento não se reusa: ela vai morrer daqui a um
      // tique e levaria a view junto para o limbo. Nesse instante o ⧉ abre uma
      // janela NOVA (o `closed` da antiga não mexe no registro da nova).
      const alive = existing && !existing.win.isDestroyed() && !existing.closing
      const entry = alive ? existing : create(missionId, projectId)
      if (!entry) return null
      const win = entry.win
      // CURA 1, em ordem obrigatória: a janela fica VISÍVEL aqui, ANTES de o
      // motor reparentar. `showInactive` (não `show`) porque o foco é o último
      // passo do gesto — e uma janela que rouba o foco antes de a página chegar
      // pisca vazia na cara do dono.
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.showInactive()
      return handleOf(entry)
    },

    get(missionId) {
      const entry = entries.get(missionId)
      return entry && !entry.win.isDestroyed() ? handleOf(entry) : undefined
    },

    close: closeWindow,

    closeAll() {
      for (const missionId of [...entries.keys()]) closeWindow(missionId)
    },

    missionOf(webContentsId) {
      return senders.get(webContentsId) ?? null
    },

    broadcast(channel, ...args) {
      for (const entry of entries.values()) {
        const wc = entry.win.webContents
        if (!entry.win.isDestroyed() && !wc.isDestroyed()) wc.send(channel, ...args)
      }
    }
  }
}

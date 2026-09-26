/**
 * BROWSER EMBUTIDO — O HOST (metade de `./browserPane`, cortada em 2026-08-29
 * por regra da casa: aquele arquivo cruzou ~1000 linhas).
 *
 * Aqui mora TODO o contato com o Electron do motor de browser: a criação da
 * `WebContentsView` com as webPreferences duras, o anexar/desanexar na árvore
 * da janela, o endurecimento da partition (permissões e downloads) e os ganchos
 * de geometria da janela. O MOTOR (`createBrowserManager`, no irmão) só fala
 * com a interface `BrowserViewHost` — é isso que deixa o gate rodar com host e
 * `webContents` FAKE, em node puro, sem subir janela nenhuma.
 *
 * A LEI 1 (`removeChildView` só em teardown de verdade) NÃO é decidida aqui:
 * este módulo apenas OFERECE `detach`. Quem tem um único caminho para ele é o
 * motor (`dropTab`). Ver o cabeçalho de `./browserPane` para a sonda que pagou
 * essa lei.
 *
 * ESPELHO DECLARADO: `BrowserPanelRect` continua morando em `./browserPane`
 * (é tipo do CONTRATO do dono, não do Electron) e vem para cá como import de
 * TIPO — apagado no emit, então não existe ciclo em tempo de execução.
 *
 * A superfície pública NÃO mudou de endereço: `./browserPane` re-exporta os
 * cinco nomes daqui, então quem já importava de lá não muda uma linha.
 *
 * POP-OUT (2026-08-29): o browser da missão passou a ter DOIS hosts possíveis —
 * o dock (a janela do app) e a janela destacada. O contrato do segundo
 * (`BrowserPopoutHandle`/`BrowserPopoutHost`) é DECLARADO aqui, junto do
 * primeiro, e IMPLEMENTADO em `./browserPopoutWindow`: assim o motor continua
 * sem uma linha de Electron e o gate injeta pop-out de mentira.
 */
import { BrowserWindow, WebContentsView, session } from 'electron'
import type { WebContents } from 'electron'
import type { BrowserPanelRect } from './browserPane'
import { attachBrowserSurface, browserSurfaceOwner, browserSurfaceWindow, createBrowserBackgroundSurface, detachBrowserSurface } from './browserBackgroundSurface'
import { toggleBrowserDevtoolsWindow } from './browserDevtoolsWindow'

// ————————————————————————————————————————————————————————————————
// Host injetável — TODO o Electron do módulo mora atrás desta interface
// ————————————————————————————————————————————————————————————————

/** Logical presentation surface. The native adapter keeps hidden tabs
 * composing in the shared background host; getVisible reports visibility
 * to the owner, rather than native compositor visibility. */
export interface BrowserViewHandle {
  setBounds(bounds: BrowserPanelRect): void
  setVisible(visible: boolean): void
  getVisible(): boolean
  readonly webContents: WebContents
}

/** Ganchos que a SESSION do projeto dispara de volta para o motor. */
export interface BrowserSessionHooks {
  onDownloadBlocked(filename: string, url: string, webContentsId: number | null): void
  onPermissionDenied(permission: string, webContentsId: number | null): void
}

export interface BrowserWindowHooks {
  onGeometry(): void
  onClosed(): void
}

/** Onde uma view REALMENTE está pendurada, agora. Ver `viewWindow`. */
export interface BrowserViewWindow {
  id: number
  visible: boolean
  minimized: boolean
}

export interface BrowserViewHost {
  /** Native owned DevTools window. Optional for headless test hosts. */
  toggleDevtools?(view: BrowserViewHandle): void
  /** Cria a view NA partition do projeto (webPreferences duras lá dentro).
   *  null = janela indisponível — o chamador recusa nomeando a receita. */
  create(partition: string): BrowserViewHandle | null
  attach(view: BrowserViewHandle): void
  /** SÓ no teardown — a lei 1 proíbe isto como esconderijo. */
  detach(view: BrowserViewHandle): void
  /** Endurece a partition UMA vez por projeto (permissões + downloads). */
  hardenSession(partition: string, hooks: BrowserSessionHooks): void
  /** Only private artifact sessions are eligible; normal project sessions
   * retain their existing cookies and lifecycle. Optional in headless hosts. */
  disposeEphemeralSession?(partition: string): void
  /** Área útil da janela, para clampar bounds; null = janela indisponível. */
  contentSize(): { width: number; height: number } | null
  /** Visibility metadata, not proof that a page cannot be captured. */
  windowVisible(): boolean
  /** resize/move/maximizar da janela e o `closed`. Devolve o desligador. */
  watchWindow(hooks: BrowserWindowHooks): () => void
  /**
   * Current native rendering parent, including the shared background carrier.
   * Wrapped views verify membership in contentView.children: fromWebContents
   * can retain a former parent after detach. Null means orphaned, not hidden.
   * Optional for older test hosts; capture still has a deadline and freshness stamp.
   */
  viewWindow?(view: BrowserViewHandle): BrowserViewWindow | null
}

// ————————————————————————————————————————————————————————————————
// O SEGUNDO HOST: a janela do pop-out (design BROWSER_POPOUT §P1)
// ————————————————————————————————————————————————————————————————
// A implementação real mora em `./browserPopoutWindow` (que é quem toca
// `BrowserWindow`); o contrato mora AQUI, junto do outro host, para o motor
// (`browserPane.ts`) continuar sem UMA linha de Electron — e para o gate poder
// injetar um pop-out de mentira.

/** UMA janela de pop-out (uma missão). O motor só sabe destas seis coisas. */
export interface BrowserPopoutHandle {
  readonly missionId: string
  /** UM PASSO (sonda §P1): `addChildView` direto, sem `removeChildView` antes —
   *  é o único jeito de não existir instante nenhum com a view fora de árvore,
   *  que é exatamente onde a captura pendura 5-8 s. */
  attach(view: BrowserViewHandle): void
  /** Só teardown de verdade, como no host do dock (lei 1). */
  detach(view: BrowserViewHandle): void
  /**
   * Área útil da janela — `null` quando ela está MINIMIZADA (ou morta).
   * FENCE 3 da sonda: `getContentBounds()` de janela minimizada devolve
   * `width:0` (enquanto `getBounds()` mente que está tudo bem) e a view passa a
   * responder captura RÁPIDO e ERRADA (356× seguidas). Devolver `null` é o
   * jeito de o motor NUNCA recalcular geometria nesse estado.
   */
  contentSize(): { width: number; height: number } | null
  /** À vista de verdade (nem escondida nem minimizada). */
  visible(): boolean
  /** Traz para a frente (restaura se estiver minimizada). */
  focus(): void
  /** Título da PÁGINA; a janela compõe "«página» · «missão»". */
  setTitle(pageTitle: string): void
}

/** O registro de janelas que o motor consome (uma por missão). */
export interface BrowserPopoutHost {
  /** Cria (ou reusa) a janela da missão e a deixa **VISÍVEL** antes de voltar —
   *  CURA 1 da sonda: reparentar para janela escondida pendura as DUAS rotas de
   *  captura. `null` = não deu para abrir; o chamador recusa com receita. */
  open(missionId: string, projectId: string): BrowserPopoutHandle | null
  get(missionId: string): BrowserPopoutHandle | undefined
  /** Fecha a janela da missão. No-op quando o gesto NASCEU do `close` dela. */
  close(missionId: string): void
  closeAll(): void
}

export type BrowserEventListener = (...args: unknown[]) => void

/** O `EventEmitter` cru por trás do `WebContents` (e do fake do gate). */
export interface BrowserEventEmitter {
  on(event: string, listener: BrowserEventListener): unknown
  off(event: string, listener: BrowserEventListener): unknown
}

// ————————————————————————————————————————————————————————————————
// Host real (o único lugar do módulo que toca Electron)
// ————————————————————————————————————————————————————————————————

export function electronBrowserViewHost(window: () => BrowserWindow | null): BrowserViewHost {
  const hardened = new Set<string>()
  const background = createBrowserBackgroundSurface(window)
  return {
    disposeEphemeralSession(partition) {
      if (!/^browser-artifact-[a-f0-9-]+$/u.test(partition)) return
      hardened.delete(partition)
      const ephemeral = session.fromPartition(partition)
      ephemeral.removeAllListeners('will-download')
      void Promise.allSettled([ephemeral.closeAllConnections(), ephemeral.clearCache(), ephemeral.clearStorageData()])
    },
    toggleDevtools(view) {
      const owner = browserSurfaceOwner(view) ?? BrowserWindow.fromWebContents(view.webContents)
      if (owner && !owner.isDestroyed()) toggleBrowserDevtoolsWindow(view.webContents, owner)
    },
    create(partition) {
      const win = window()
      if (!win || win.isDestroyed()) return null
      const view = new WebContentsView({
        webPreferences: {
          // Sessão POR PROJETO (D5.3): cookies/logins atravessam missões.
          session: session.fromPartition(partition),
          // Cerca dura: página web é conteúdo NÃO-confiável. Sem preload,
          // sem node, sem webview — nada de privilégio nesta superfície.
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          spellcheck: false,
          devTools: true,
          // Agent navigation must not interrupt typing elsewhere in the app.
          focusOnNavigation: false,
          // `alert/confirm/prompt` de uma view ESCONDIDA prenderia a janela do
          // dono num modal invisível — e prenderia a rodada do agente junto.
          // Rota de saída sancionada: `browser_eval` (H2) roda na página e
          // observa/instrumenta o que o diálogo faria.
          disableDialogs: true,
          autoplayPolicy: 'document-user-activation-required',
          // A LEI 1 depende do rAF vivo: sem isto o Chromium estrangula a view
          // escondida e o "quadro fresco" da captura vira mentira.
          backgroundThrottling: false
        }
      })
      // Página web assume fundo branco; sem isto a view pisca transparente e
      // mostra o papel do host por baixo.
      view.setBackgroundColor('#ffffff')
      return background.wrap(view)
    },
    attach(view) {
      const win = window()
      if (!win || win.isDestroyed()) return
      attachBrowserSurface(win, view)
    },
    detach(view) {
      const win = window()
      if (!win || win.isDestroyed()) return
      try {
        detachBrowserSurface(win, view)
      } catch {
        // janela no meio do teardown — o close do webContents basta
      }
    },
    hardenSession(partition, hooks) {
      if (hardened.has(partition)) return
      hardened.add(partition)
      const ses = session.fromPartition(partition)
      // NEGA TUDO. Sem exceção e sem card de permissão para o dono: mic,
      // câmera, geo, notificações, clipboard-read, midi, serial, usb, hid.
      ses.setPermissionRequestHandler((wc, permission, callback) => {
        hooks.onPermissionDenied(permission, wc && !wc.isDestroyed() ? wc.id : null)
        callback(false)
      })
      ses.setPermissionCheckHandler(() => false)
      ses.setDevicePermissionHandler(() => false)
      ses.setDisplayMediaRequestHandler((_request, callback) => {
        hooks.onPermissionDenied('display-capture', null)
        // objeto vazio = pedido cancelado
        callback({})
      })
      ses.on('will-download', (_event, item, wc) => {
        const filename = item.getFilename()
        const url = item.getURL()
        item.cancel()
        hooks.onDownloadBlocked(filename, url, wc && !wc.isDestroyed() ? wc.id : null)
      })
    },
    contentSize() {
      const win = window()
      if (!win || win.isDestroyed()) return null
      const [width, height] = win.getContentSize()
      return { width, height }
    },
    windowVisible() {
      const win = window()
      return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
    },
    viewWindow(view) {
      const surface = browserSurfaceWindow(view)
      const win = surface === undefined ? BrowserWindow.fromWebContents(view.webContents) : surface
      if (!win || win.isDestroyed()) return null
      return { id: win.id, visible: win.isVisible(), minimized: win.isMinimized() }
    },
    watchWindow(hooks) {
      const win = window()
      if (!win || win.isDestroyed()) return () => undefined
      // O ResizeObserver do painel (H3) só acorda quando o LAYOUT muda; arrastar
      // a borda da janela move o retângulo sem mexer no CSS do painel. Reaplicar
      // no evento da janela é o que impede a view de ficar para trás do chrome.
      const geometry = (): void => hooks.onGeometry()
      const closed = (): void => hooks.onClosed()
      const pairs: [string, () => void][] = [
        ...(['resize', 'move', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const).map(
          (name): [string, () => void] => [name, geometry]
        ),
        ['closed', closed]
      ]
      const emitter = win as unknown as BrowserEventEmitter
      for (const [name, fn] of pairs) emitter.on(name, fn)
      return () => {
        if (win.isDestroyed()) return
        for (const [name, fn] of pairs) emitter.off(name, fn)
      }
    }
  }
}

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
 */
import { WebContentsView, session } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import type { BrowserPanelRect } from './browserPane'

// ————————————————————————————————————————————————————————————————
// Host injetável — TODO o Electron do módulo mora atrás desta interface
// ————————————————————————————————————————————————————————————————

/** Superfície mínima da `WebContentsView` usada pelo motor. A classe real do
 *  Electron a satisfaz por estrutura; o fake do gate implementa isto. */
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

export interface BrowserViewHost {
  /** Cria a view NA partition do projeto (webPreferences duras lá dentro).
   *  null = janela indisponível — o chamador recusa nomeando a receita. */
  create(partition: string): BrowserViewHandle | null
  attach(view: BrowserViewHandle): void
  /** SÓ no teardown — a lei 1 proíbe isto como esconderijo. */
  detach(view: BrowserViewHandle): void
  /** Endurece a partition UMA vez por projeto (permissões + downloads). */
  hardenSession(partition: string, hooks: BrowserSessionHooks): void
  /** Área útil da janela, para clampar bounds; null = janela indisponível. */
  contentSize(): { width: number; height: number } | null
  /** Janela escondida/minimizada = captura PENDURA (P5) — a guarda usa isto. */
  windowVisible(): boolean
  /** resize/move/maximizar da janela e o `closed`. Devolve o desligador. */
  watchWindow(hooks: BrowserWindowHooks): () => void
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
  return {
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
      return view
    },
    attach(view) {
      const win = window()
      if (!win || win.isDestroyed()) return
      win.contentView.addChildView(view as unknown as WebContentsView)
    },
    detach(view) {
      const win = window()
      if (!win || win.isDestroyed()) return
      try {
        win.contentView.removeChildView(view as unknown as WebContentsView)
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

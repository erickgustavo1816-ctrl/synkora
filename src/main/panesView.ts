/**
 * PANES VIEW — a segunda view de renderer da Fase 3 (docs/FASE3_PLANO.md).
 *
 * O canvas de Panes sai do renderer do host para uma WebContentsView filha
 * (`?view=panes`, MESMO bundle/preload — padrão provado pelos overlays):
 * processo próprio de renderer = orçamento WebGL próprio (16 contextos POR
 * view, sonda 2026-08-06) e o parse dos pty:data dos panes de execução fora
 * da thread que pinta o Board.
 *
 * Regras vindas das sondas (probe-webcontentsview-hidden, 2026-08-08):
 * - esconder é SEMPRE `setVisible(false)` — layout/rAF/medições continuam
 *   vivos lá dentro (S2 idêntico ao baseline), então o keepalive dos panes
 *   (hasRealSize do TerminalPane) não quebra;
 * - NUNCA removeChildView com panes vivos (S3: rAF para → fit/RO morrem) e
 *   NUNCA bounds 0×0 como esconderijo (S4: viewport interno não-contratual).
 * - o rAF decorativo roda invisível → o sinal `panes-view:shown` avisa o
 *   renderer para pausar enfeite (paperField/mapa).
 *
 * A view nasce LAZY no primeiro `panes-view:layout` do host — enquanto o
 * renderer do host não emitir (F3-c2), este módulo fica 100% dormente.
 * O HOST é o dono da geometria e da visibilidade (ele sabe onde a área do
 * canvas está e qual aba está ativa); o main só aplica e audita.
 */
import { app, ipcMain, WebContentsView } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'path'
import {
  isPaletteNavigationTarget,
  type PaletteNavigationTarget
} from '../shared/commandPalette'

export interface PanesViewLayout {
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/** Tooltip do host roteado para dentro da view (2026-08-11) — espelho do tipo
 *  do preload; anchor chega em coords da página do HOST. */
export interface PanesViewTip {
  text: string
  anchor: { left: number; top: number; width: number; height: number }
}

export interface PanesViewDeps {
  window(): BrowserWindow | null
  preloadPath: string
  /** trustedRendererView(url, 'panes') do index — revalida a URL final antes
   *  do load e cerca a navegação (mesma dupla checagem dos overlays). */
  trustedPanesUrl(url: string): boolean
  /** O index amarra/solta o panesSender da costura de push (F3-c0). */
  onSenderBound(wc: WebContents): void
  onSenderGone(): void
  /** Só o webContents do HOST pode comandar layout/estado da view. */
  isHostSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean
  /** Relays VIEW→host (F3-c4): navegação, activity e attention-cleared. */
  pushBoard(channel: string, ...args: unknown[]): void
  record(event: string, reason: string): void
  openExternal(url: string): void
}

export class PanesViewManager {
  private view: WebContentsView | null = null
  private lastLayout: PanesViewLayout | null = null
  private lastState: unknown = null
  private refusedSenderIds = new Set<number>()
  /** F3-c5: label do terminal focado para ditado na view (null = nenhum). */
  private voiceFocusLabel: string | null = null

  constructor(private deps: PanesViewDeps) {}

  /** id do webContents da view (membership nos permission handlers). */
  isPanesWebContentsId(id: number): boolean {
    return this.view !== null && !this.view.webContents.isDestroyed() && this.view.webContents.id === id
  }

  registerIpc(): void {
    ipcMain.on('panes-view:layout', (e, layout: PanesViewLayout) => {
      if (!this.guardHost(e, 'panes-view:layout')) return
      this.applyLayout(layout)
    })
    ipcMain.on('panes-view:state', (e, state: unknown) => {
      if (!this.guardHost(e, 'panes-view:state')) return
      this.lastState = state
      const wc = this.liveWebContents()
      if (wc) wc.send('panes-view:state', state)
    })
    // Esc pode nascer na sidebar/titlebar do HOST enquanto o chat ativo mora
    // nesta WebContentsView. O main só encaminha se a view estiver visível.
    ipcMain.on('panes-view:gui-escape', (e) => {
      if (!this.guardHost(e, 'panes-view:gui-escape') || !this.lastLayout?.visible) return
      const wc = this.liveWebContents()
      if (wc) wc.send('panes-view:gui-escape')
    })
    // ——— relays da VIEW para o host (F3-c4) — volume baixo (transições) ———
    ipcMain.on('panes-view:navigate', (e, projectId: string, tab: string) => {
      if (!this.guardView(e, 'panes-view:navigate')) return
      this.deps.pushBoard('panes-view:navigate', projectId, tab)
    })
    // Cmd/Ctrl+K nasce no renderer que tem foco. Se for a WebContentsView,
    // ela só pode pedir ao host um alvo fechado/validado; texto de transcript
    // e caminhos internos nunca atravessam este relay.
    ipcMain.on('panes-view:command-target', (e, target: PaletteNavigationTarget) => {
      if (!this.guardView(e, 'panes-view:command-target')) return
      if (!isPaletteNavigationTarget(target)) {
        this.deps.record(
          'panes-view-command-refused',
          `webContents ${e.sender.id} enviou alvo inválido da paleta`
        )
        return
      }
      this.deps.pushBoard('panes-view:command-target', target)
    })
    ipcMain.on('panes-view:activity', (e, paneId: string, activity: string) => {
      if (!this.guardView(e, 'panes-view:activity')) return
      this.deps.pushBoard('panes:activity', paneId, activity)
    })
    ipcMain.on('panes-view:attention-cleared', (e, projectId: string, paneId: string) => {
      if (!this.guardView(e, 'panes-view:attention-cleared')) return
      this.deps.pushBoard('panes:attention-cleared', projectId, paneId)
    })
    // ——— F3-c5: ditado SynVoice num terminal do canvas ———
    // O registro do alvo mora AQUI (o registry módulo-level do renderer não
    // cruza processos): a view reporta o foco, o host consulta na entrega.
    ipcMain.on('panes-view:voice-focus', (e, label: string) => {
      if (!this.guardView(e, 'panes-view:voice-focus')) return
      this.voiceFocusLabel = typeof label === 'string' && label.trim() ? label.trim() : null
    })
    ipcMain.handle('panes-view:voice-target', (e) => {
      if (!this.deps.isHostSender(e)) return null
      // Semântica do registry local preservada: pane invisível não é alvo —
      // com a view ESCONDIDA (setVisible false) o CSS interno não muda, então
      // quem sabe da visibilidade real é o lastLayout daqui.
      if (!this.lastLayout?.visible || !this.voiceFocusLabel || !this.liveWebContents())
        return null
      return { label: this.voiceFocusLabel }
    })
    ipcMain.on('panes-view:voice-paste', (e, text: string) => {
      if (!this.guardHost(e, 'panes-view:voice-paste')) return
      if (typeof text !== 'string' || !text) return
      const wc = this.liveWebContents()
      if (wc) wc.send('panes-view:voice-paste', text)
    })
    // ——— 2026-08-11: tooltip do HOST sobre a área da view ———
    // A view compõe POR CIMA do DOM do host — tooltip do host que cruza o rect
    // dela é clipado (caso real: tooltip do radar de andamento cortado no meio
    // com a aba Panes ativa). Alternativas descartadas: esconder a view no
    // hover piscaria a cada tooltip; a janela nativa de tooltip do SynVoice é
    // parented ao mini overlay e gated por synVoiceDetached no index (outra
    // dona, outra vida útil); clampar na faixa visível do host não cabe (a
    // titlebar tem 36px). A view roda o MESMO bundle com a MESMA .app-tip:
    // desenhar o tooltip lá dentro custa um relay — o main só translada o
    // anchor de coords do host para coords da view.
    ipcMain.on('panes-view:tip-show', (e, tip: PanesViewTip) => {
      if (!this.guardHost(e, 'panes-view:tip-show')) return
      const wc = this.liveWebContents()
      const layout = this.lastLayout
      if (!wc || !layout?.visible) return
      const text = typeof tip?.text === 'string' ? tip.text.slice(0, 600) : ''
      const a = tip?.anchor
      if (!text || !a || typeof a !== 'object') return
      const left = Number(a.left)
      const top = Number(a.top)
      const width = Number(a.width)
      const height = Number(a.height)
      if (![left, top, width, height].every(Number.isFinite)) return
      const b = layout.bounds
      wc.send('panes-view:tip', {
        text,
        anchor: { left: left - b.x, top: top - b.y, width, height }
      })
    })
    ipcMain.on('panes-view:tip-hide', (e) => {
      if (!this.guardHost(e, 'panes-view:tip-hide')) return
      const wc = this.liveWebContents()
      if (wc) wc.send('panes-view:tip', null)
    })
    // ——— 2026-08-11: congelado da view sob overlays do host ———
    // Overlay do host aberto = view escondida (setVisible false) e a área dos
    // panes virava um BURACO vazio atrás do popover. O host captura a view
    // AINDA visível, pinta o PNG no rect dela e só então manda o hide.
    // PNG (toDataURL) e não JPEG: texto de terminal em fundo escuro comprime
    // bem sem os artefatos de ringing do JPEG. Downscale só acima de 3840px de
    // largura de DEVICE — reduzir sempre borraria o congelado em tela comum, e
    // o dataURL típico (~centenas de KB) fica longe do teto de IPC (~16MB).
    ipcMain.handle('panes-view:capture', async (e) => {
      if (!this.deps.isHostSender(e)) return null
      const wc = this.liveWebContents()
      if (!wc || !this.lastLayout?.visible) return null
      try {
        let image = await wc.capturePage()
        if (image.isEmpty()) return null
        if (image.getSize().width > 3840) image = image.resize({ width: 3840 })
        return { dataUrl: image.toDataURL() }
      } catch {
        // captura falhou = fallback gracioso: o chamador esconde sem congelado
        // (o comportamento antigo), nunca trava o fluxo do overlay.
        return null
      }
    })
  }

  /** Contraparte do guardHost: só a PRÓPRIA view emite relays view→host. */
  private guardView(e: IpcMainEvent, channel: string): boolean {
    if (this.isPanesWebContentsId(e.sender.id)) return true
    if (!this.refusedSenderIds.has(e.sender.id)) {
      this.refusedSenderIds.add(e.sender.id)
      this.deps.record(
        'panes-view-command-refused',
        `webContents ${e.sender.id} tentou ${channel} — só a view de panes emite este relay`
      )
    }
    return false
  }

  /** Guard sem throw: exception em listener `.on` não responde nada a
   *  ninguém — recusa auditada uma vez por webContents intruso. */
  private guardHost(e: IpcMainEvent, channel: string): boolean {
    if (this.deps.isHostSender(e)) return true
    if (!this.refusedSenderIds.has(e.sender.id)) {
      this.refusedSenderIds.add(e.sender.id)
      this.deps.record(
        'panes-view-command-refused',
        `webContents ${e.sender.id} tentou ${channel} — só o host comanda a view`
      )
    }
    return false
  }

  applyLayout(layout: PanesViewLayout): void {
    const win = this.deps.window()
    if (!win || win.isDestroyed()) return
    // Criação LAZY com pré-aquecimento: layout invisível com bounds vazios
    // (Home pura, nenhum universo montado) não justifica um renderer novo;
    // bounds reais (projeto aberto, mesmo na aba board) criam a view
    // invisível para o primeiro clique em Panes não pagar o boot.
    if (!this.view && !layout.visible && layout.bounds.width <= 0) {
      this.lastLayout = layout
      return
    }
    const view = this.ensureView(win)
    if (!view) return
    this.lastLayout = layout
    const b = layout.bounds
    // DIPs relativos ao contentView; o rect do host já vem na mesma base
    // (titleBarStyle hidden = a página cobre a janela inteira). Round para
    // não deixar costura de subpixel entre o chrome do host e a view.
    view.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(0, Math.round(b.width)),
      height: Math.max(0, Math.round(b.height))
    })
    if (view.getVisible() !== layout.visible) {
      view.setVisible(layout.visible)
      const wc = this.liveWebContents()
      if (wc) wc.send('panes-view:shown', layout.visible)
    }
  }

  private liveWebContents(): WebContents | null {
    const wc = this.view?.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  private ensureView(win: BrowserWindow): WebContentsView | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const view = new WebContentsView({
      webPreferences: {
        preload: this.deps.preloadPath,
        sandbox: false,
        // igual ao host: pane em segundo plano continua medindo/pintando
        backgroundThrottling: false
      }
    })
    this.view = view
    const wc = view.webContents

    // Mesma cerca de navegação da janela: conteúdo remoto nunca ocupa uma
    // superfície privilegiada; https abre no navegador do sistema.
    const guardNavigation = (event: Electron.Event, url: string): void => {
      if (this.deps.trustedPanesUrl(url)) return
      event.preventDefault()
      if (/^https:\/\//i.test(url)) this.deps.openExternal(url)
    }
    wc.on('will-navigate', guardNavigation)
    wc.on('will-redirect', guardNavigation)
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) this.deps.openExternal(url)
      return { action: 'deny' }
    })

    let loadRetries = 0
    wc.on('did-finish-load', () => {
      loadRetries = 0
      this.deps.onSenderBound(wc)
      this.deps.record('panes-view-ready', `webContents ${wc.id} carregado e amarrado ao push`)
      // Reload/crash da view: o estado cacheado re-hidrata sem esperar o
      // host notar (o host continua mandando os próximos normalmente).
      if (this.lastState !== null) wc.send('panes-view:state', this.lastState)
      if (this.lastLayout) wc.send('panes-view:shown', this.lastLayout.visible)
    })
    wc.on('render-process-gone', (_e, details) => {
      this.deps.onSenderGone()
      this.voiceFocusLabel = null
      this.deps.record(
        'panes-view-crashed',
        `renderer da view de panes morreu (${details.reason}); recarregando`
      )
      if (details.reason !== 'clean-exit' && !wc.isDestroyed()) wc.reload()
    })
    // AUTOCURA DO LOAD (crash real 2026-08-11: o Utility Network Service
    // morreu, o reload imediato disparou com a rede do Chromium ainda
    // reiniciando e o load do vite por HTTP falhou — view morta com main e
    // panes VIVOS). Load falho re-tenta com backoff; -3 (ERR_ABORTED) é
    // navegação interrompida, não falha.
    wc.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || wc.isDestroyed()) return
      if (loadRetries >= 5) return
      loadRetries += 1
      this.deps.record(
        'panes-view-load-retry',
        `did-fail-load ${errorCode} ${errorDescription} — tentativa ${loadRetries}/5 em 2s`
      )
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.reload()
      }, 2000)
    })

    win.contentView.addChildView(view)
    // nasce invisível — o applyLayout chamador decide
    view.setVisible(false)

    const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
    if (devUrl) {
      const viewUrl = new URL(devUrl)
      viewUrl.searchParams.set('view', 'panes')
      if (!this.deps.trustedPanesUrl(viewUrl.href)) {
        this.deps.record('panes-view-load-refused', `URL da view reprovada: ${viewUrl.href}`)
        this.destroy()
        return null
      }
      void wc.loadURL(viewUrl.href)
    } else {
      void wc.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { view: 'panes' }
      })
    }
    this.deps.record('panes-view-created', `WebContentsView do canvas criada (wc ${wc.id})`)
    return view
  }

  /** Teardown no closed da janela (child views não morrem sozinhas). */
  destroy(): void {
    const view = this.view
    this.view = null
    this.lastLayout = null
    this.voiceFocusLabel = null
    this.deps.onSenderGone()
    if (!view) return
    const win = this.deps.window()
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view)
      } catch {
        // janela no meio do teardown — o close do webContents abaixo basta
      }
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
}

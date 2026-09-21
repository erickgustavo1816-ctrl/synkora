/**
 * ACESSIBILIDADE DO SYNKORA — o lado do main (ordem do dono, 2026-09-21).
 *
 * A seção "Tipografia fixa" de Ajustes só falava com os panes xterm da era
 * TUI: "hoje ela não serve para nada". No lugar dela, alavancas que valem
 * para o APP INTEIRO e que só o main consegue puxar:
 *
 * - ESCALA: `webContents.setZoomFactor` na janela principal. É o zoom real do
 *   Chromium — chat, board, ajustes e terminais crescem juntos, `vh`/`fixed`
 *   continuam certos e o canvas do fundo lê o devicePixelRatio já escalado.
 *   O CSS da casa tem dezenas de tamanhos em px fixos; trocar token a token
 *   seria reescrever o tema, e o zoom entrega o mesmo resultado sem tocar
 *   nenhum.
 * - MOVIMENTO: `Emulation.setEmulatedMedia` (CDP, o mesmo motor do browser
 *   embutido) faz a janela ENXERGAR `prefers-reduced-motion: reduce`. As ~35
 *   regras CSS e os `matchMedia` do renderer já obedecem a essa mídia — nada
 *   precisa aprender uma classe nova. O debugger só é anexado quando o dono
 *   liga o modo pela primeira vez; desligar devolve a mídia ao sistema.
 * - O RETÂNGULO DO BROWSER EMBUTIDO: o renderer mede em px CSS (já escalados
 *   pelo zoom) e a WebContentsView quer DIP. `scaleRectByZoom` é a conversão,
 *   aplicada num ponto só (o handler de `browser:bounds`).
 *
 * Tudo aqui é puro ou fala com uma interface mínima do webContents, para o
 * teste rodar sem Electron.
 */

export interface UiAccessibilityView {
  uiScale: number
  uiReduceMotion: boolean
}

export interface UiRect {
  x: number
  y: number
  width: number
  height: number
}

/** 100 → 1; 125 → 1.25. Torto ou não positivo cai em 1 (sem escala). */
export function uiZoomFactor(uiScale: number): number {
  const parsed = Number(uiScale)
  if (!Number.isFinite(parsed) || parsed <= 0) return 1
  return Math.round(parsed) / 100
}

/** px CSS do renderer → DIP da janela. Zoom 1 (ou torto) devolve o mesmo objeto. */
export function scaleRectByZoom<T extends UiRect>(rect: T, zoom: number): T {
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom === 1) return rect
  return {
    ...rect,
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.round(rect.width * zoom),
    height: Math.round(rect.height * zoom)
  }
}

/** O recorte do `webContents` que a aplicação usa — mínimo para o teste. */
export interface UiSurface {
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  debugger: {
    isAttached(): boolean
    attach(protocolVersion?: string): void
    sendCommand(method: string, commandParams?: unknown): Promise<unknown>
  }
}

/**
 * Aplica escala e movimento numa superfície. A emulação de mídia é LEMBRADA
 * por superfície: quem nunca ligou o modo nunca ganha debugger; quem ligou e
 * desligou recebe a mídia vazia (volta ao que o Windows diz). Erro nunca sobe
 * — preferência de leitura não derruba o main.
 */
export function createUiAccessibilityApplier(): {
  apply(target: UiSurface, view: UiAccessibilityView): Promise<void>
} {
  const emulated = new WeakSet<object>()
  return {
    async apply(target, view) {
      try {
        const zoom = uiZoomFactor(view.uiScale)
        if (Math.abs(target.getZoomFactor() - zoom) > 0.001) target.setZoomFactor(zoom)
      } catch {
        // zoom é cortesia
      }
      const reduce = view.uiReduceMotion === true
      if (!reduce && !emulated.has(target)) return
      try {
        if (!target.debugger.isAttached()) target.debugger.attach('1.3')
        await target.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : '' }]
        })
        if (reduce) emulated.add(target)
        else emulated.delete(target)
      } catch {
        // sem CDP o movimento segue o sistema — a tela continua inteira
      }
    }
  }
}

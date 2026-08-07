export interface TerminalBox {
  w: number
  h: number
}

export const TERMINAL_DEFAULT_FONT_SIZE = 13
export const TERMINAL_DEFAULT_LINE_HEIGHT = 1.25
export const TERMINAL_DEFAULT_FONT_FAMILY = 'Cascadia Code'

const TERMINAL_CHROME_HEIGHT = 52
// Largura da scrollbar DOM própria do xterm. O mesmo valor é entregue ao
// `overviewRuler.width`, que é também a fonte usada pelo FitAddon para calcular
// as colunas: assim a barra fina não deixa uma faixa de 14px desperdiçada.
export const TERMINAL_SCROLLBAR_WIDTH = 7
export const TERMINAL_NATIVE_SCROLLBAR_WIDTH = 14

/** Stack CSS entregue ao xterm. Um nome simples ganha fallbacks; uma stack
 *  avançada digitada pelo usuário é preservada. */
export function terminalFontStack(value: string | undefined): string {
  const family = value?.trim() || TERMINAL_DEFAULT_FONT_FAMILY
  if (family.includes(',') || /^(monospace|serif|sans-serif)$/i.test(family)) return family
  return `"${family.replace(/["\\]/g, '')}", Consolas, monospace`
}

/** Tamanho seguro usado antes da primeira medicao real do xterm. */
export function terminalFallbackForBox(
  box: TerminalBox | undefined,
  fontSize: number,
  lineHeight = TERMINAL_DEFAULT_LINE_HEIGHT,
  scrollbarWidth = TERMINAL_SCROLLBAR_WIDTH
): { cols: number; rows: number } {
  if (!box) return { cols: 100, rows: 30 }
  return {
    cols: Math.max(
      24,
      Math.floor((box.w - 18 - scrollbarWidth) / (fontSize * 0.6))
    ),
    rows: Math.max(
      6,
      Math.floor((box.h - TERMINAL_CHROME_HEIGHT - 20) / (fontSize * lineHeight))
    )
  }
}

/** Estimativa para uma caixa que já representa apenas o HOST do terminal
 * (sem titlebar e sem padding do painel pai). É o contrato usado pelo Board:
 * desconta somente o padding interno do xterm e a barra reservada. */
export function terminalFallbackForHost(
  box: TerminalBox | undefined,
  fontSize: number,
  lineHeight = TERMINAL_DEFAULT_LINE_HEIGHT,
  scrollbarWidth = TERMINAL_NATIVE_SCROLLBAR_WIDTH
): { cols: number; rows: number } {
  if (!box) return { cols: 100, rows: 30 }
  return {
    cols: Math.max(
      2,
      // Claude não configura overviewRuler e o xterm conserva a reserva padrão
      // de 14px. Subestimar uma coluna no fallback oculto é seguro; exceder a
      // caixa é que causaria recorte na primeira exibição.
      Math.floor((box.w - 18 - scrollbarWidth) / (fontSize * 0.6))
    ),
    rows: Math.max(1, Math.floor((box.h - 20) / (fontSize * lineHeight)))
  }
}

/** Claude prefere 60 colunas, mas uma página pode ficar fisicamente menor que
 * o piso do gesto (ex.: três colunas numa janela estreita). Nessa exceção o
 * FitAddon deve usar as colunas que REALMENTE cabem em vez de manter 60 e
 * recortar somente o pane da borda direita. A margem de 2 colunas absorve a
 * diferença entre a estimativa e a métrica real da fonte. */
export function terminalMinColsForBox(
  kind: 'claude' | 'codex' | 'shell',
  fallback: { cols: number }
): number {
  const preferred = kind === 'claude' ? 60 : 24
  return Math.max(2, Math.min(preferred, fallback.cols - 2))
}

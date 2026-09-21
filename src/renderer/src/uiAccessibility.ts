/**
 * ACESSIBILIDADE DO SYNKORA — o lado do renderer (ordem do dono, 2026-09-21).
 *
 * O main aplica o que só ele alcança (zoom da janela e movimento reduzido —
 * `main/uiAccessibility.ts`). Aqui mora o resto: a régua dos atalhos de
 * escala, e as VARIÁVEIS CSS que a fonte do app e a leitura do chat consomem.
 * As faixas são espelho de `UI_SCALE_RANGE`, `CHAT_FONT_SIZE_RANGE` e
 * `CHAT_LINE_HEIGHT_RANGE` em `main/settingsCore.ts` — quem recusa é o main;
 * a tela só nunca oferece o que ele recusaria.
 */

export const UI_SCALE_RANGE = { min: 80, max: 150 } as const
export const UI_SCALE_STEP = 5
export const UI_SCALE_DEFAULT = 100
export const UI_FONT_FAMILY_DEFAULT = 'Cascadia Code'
export const CHAT_FONT_SIZE_RANGE = { min: 10, max: 20 } as const
export const CHAT_FONT_SIZE_STEP = 0.5
export const CHAT_FONT_SIZE_DEFAULT = 12.5
export const CHAT_LINE_HEIGHT_RANGE = { min: 1.2, max: 2 } as const
export const CHAT_LINE_HEIGHT_DEFAULT = 1.55

/** Stack CSS da fonte: um nome simples ganha fallbacks; uma stack avançada
 *  digitada pelo dono é preservada. ESPELHO de `terminalFontStack`
 *  (terminalGeometry.ts) — este módulo é puro de propósito, sem import
 *  relativo, para a suíte rodar sob strip-types; a régua é a mesma. */
export function uiFontStack(value: string | undefined): string {
  const family = value?.trim() || UI_FONT_FAMILY_DEFAULT
  if (family.includes(',') || /^(monospace|serif|sans-serif)$/i.test(family)) return family
  return `"${family.replace(/["\\]/g, '')}", Consolas, monospace`
}

/** -1 diminui um passo, +1 aumenta, 0 volta ao padrão (Ctrl + −, Ctrl + +, Ctrl + 0). */
export type UiScaleAction = -1 | 0 | 1

export function stepUiScale(current: number | undefined, action: UiScaleAction): number {
  if (action === 0) return UI_SCALE_DEFAULT
  const base = Number.isFinite(current) ? (current as number) : UI_SCALE_DEFAULT
  // O passo assenta na grade de 5: um valor gravado fora dela (por exemplo 103)
  // sobe para 105 / desce para 100 em vez de andar torto para sempre.
  const next =
    action > 0
      ? Math.floor(base / UI_SCALE_STEP) * UI_SCALE_STEP + UI_SCALE_STEP
      : Math.ceil(base / UI_SCALE_STEP) * UI_SCALE_STEP - UI_SCALE_STEP
  return Math.max(UI_SCALE_RANGE.min, Math.min(UI_SCALE_RANGE.max, next))
}

export interface UiAccessibilityTextSettings {
  uiFontFamily?: string
  chatFontSize?: number
  chatLineHeight?: number
}

/**
 * As variáveis que o CSS lê: `--mono` (a fonte de todo o app — o `:root` do
 * global.css é o padrão, e o inline no `<html>` vence), e o par do chat
 * (`uiAccessibility.css` aplica nas mensagens). Sem settings = padrões.
 */
export function uiAccessibilityVars(
  settings: UiAccessibilityTextSettings | null | undefined
): Record<'--mono' | '--chat-font-size' | '--chat-line-height', string> {
  const family = settings?.uiFontFamily?.trim() || UI_FONT_FAMILY_DEFAULT
  const fontSize = Number.isFinite(settings?.chatFontSize)
    ? (settings?.chatFontSize as number)
    : CHAT_FONT_SIZE_DEFAULT
  const lineHeight = Number.isFinite(settings?.chatLineHeight)
    ? (settings?.chatLineHeight as number)
    : CHAT_LINE_HEIGHT_DEFAULT
  return {
    '--mono': uiFontStack(family),
    '--chat-font-size': `${fontSize}px`,
    '--chat-line-height': String(lineHeight)
  }
}

export function applyUiAccessibilityVars(
  settings: UiAccessibilityTextSettings | null | undefined,
  root: { style: { setProperty(name: string, value: string): void } } = document.documentElement
): void {
  for (const [name, value] of Object.entries(uiAccessibilityVars(settings))) {
    root.style.setProperty(name, value)
  }
}

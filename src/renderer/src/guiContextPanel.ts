/**
 * Fotografia canônica do contexto que pode ser mostrada no composer.
 *
 * O main já valida a telemetria antes de ela chegar ao renderer. Ainda assim,
 * esta fronteira recusa valores incompletos para que a UI nunca transforme um
 * fallback em uma medição. Tokens e janela permanecem inteiros exatos; custo é
 * opcional porque nem todo resultado do CLI o publica.
 */

export interface GuiContextPanelPresentation {
  contextTokens: number
  contextWindow: number
  percent: number
  percentLabel: string
  contextTokensLabel: string
  contextWindowLabel: string
  costLabel?: string
  tooltip: string
}

const exactNumber = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 0
})

function exactTokenLabel(value: number): string {
  return exactNumber.format(value)
}

function costLabel(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  // O custo chega em USD. Conservamos centavos e até seis casas úteis para não
  // esconder um custo pequeno do CLI por arredondamento visual prematuro.
  const rounded = Number(value.toFixed(6))
  return `$${rounded.toLocaleString('en-US', {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  })}`
}

/**
 * Constrói a fotografia para o botão, tooltip e popover.
 *
 * `null` significa "ainda não há medição canônica" — o chamador deve ocultar
 * o indicador nesse caso, em vez de exibir zero ou uma janela estimada.
 */
export function guiContextPanelPresentation(
  contextTokens: number | null | undefined,
  contextWindow: number | null | undefined,
  costUsd: number | null | undefined = null
): GuiContextPanelPresentation | null {
  if (
    typeof contextTokens !== 'number' ||
    !Number.isSafeInteger(contextTokens) ||
    contextTokens < 0 ||
    typeof contextWindow !== 'number' ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0
  ) {
    return null
  }

  const percent = Math.max(0, Math.min(100, Math.round((contextTokens / contextWindow) * 100)))
  const contextTokensLabel = exactTokenLabel(contextTokens)
  const contextWindowLabel = exactTokenLabel(contextWindow)
  const percentLabel = `${percent}%`
  const cost = costLabel(costUsd)
  const tooltip = [
    `contexto: ${contextTokensLabel} de ${contextWindowLabel} tokens usados`,
    `${percentLabel} da janela`,
    cost ? `custo ${cost}` : null
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  return {
    contextTokens,
    contextWindow,
    percent,
    percentLabel,
    contextTokensLabel,
    contextWindowLabel,
    ...(cost ? { costLabel: cost } : {}),
    tooltip
  }
}

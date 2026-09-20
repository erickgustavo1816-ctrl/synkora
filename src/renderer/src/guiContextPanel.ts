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
  /** O ESCOPO dos números, em uma linha. Ver SCOPE_NOTE. */
  scopeNote: string
  tooltip: string
}

/**
 * O QUE ESTES NÚMEROS MEDEM, dito na tela.
 *
 * Contexto descreve a última medição do motor. O acumulado em USD do processo
 * não permite concluir cobrança adicional nem consumo da cota de assinatura.
 */
export const SCOPE_NOTE =
  'contexto é o conteúdo disponível ao modelo na última medição. USD é o acumulado informado pelo motor desde que a sessão abriu; não indica cobrança adicional nem a cota da assinatura.'

const exactNumber = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 0
})

function exactTokenLabel(value: number): string {
  return exactNumber.format(value)
}

function costLabel(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  // O custo chega em USD. Acima de um centavo, centavos bastam — seis casas ali
  // são ruído com cara de precisão. Abaixo, as casas são a única informação que
  // existe, e escondê-las mostraria "$0.00" para um gasto real.
  const digits = value >= 0.01 ? 2 : 6
  const rounded = Number(value.toFixed(digits))
  return `$${rounded.toLocaleString('en-US', {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
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
    `contexto: ${contextTokensLabel} de ${contextWindowLabel} tokens`,
    `${percentLabel} da janela`,
    // "da sessão" viaja com o número no tooltip também: quem só passa o mouse
    // tem de receber o escopo junto, não só quem abre o painel.
    cost ? `USD informado pelo motor (sessão) ${cost}` : null
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
    scopeNote: SCOPE_NOTE,
    tooltip
  }
}

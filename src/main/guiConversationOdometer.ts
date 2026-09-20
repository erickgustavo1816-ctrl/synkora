/** Legacy conversation usage totals and a fixed weighted-token heuristic.
 * Context occupancy, measured tokens and account subscription quota are
 * separate quantities. Tool calls are not one-to-one with model requests.
 * New deduplicated request/round accounting lives in guiRequestUsage.ts;
 * historical observations without IDs cannot be retroactively deduplicated. */

/**
 * As PARCELAS de uma chamada de API — a repartição que os dois CLIs entregam
 * (claude: `message.usage`; codex: o `last` do `thread/tokenUsage/updated`).
 *
 * `inputTokens` é o input FRESCO (o que não veio nem do cache lido nem do
 * cache escrito): é assim que o claude já reporta, e é como a leitura do codex
 * normaliza o dele (ver codexTokenUsage.ts).
 */
export interface GuiApiCallParcels {
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
}

/** O acumulado de uma CONVERSA (a vida do resume atual). */
export interface GuiConversationUsage {
  apiCalls: number
  cacheWriteTokens: number
  cacheReadTokens: number
  inputTokens: number
  outputTokens: number
}

/** Compatibility heuristic, not a current model pricing table or a verified
 * subscription quota formula. The historical export names are retained for
 * old consumers. Show the raw parcels and the estimate label alongside it.
 * Mirrored solely for presentation in renderer/src/guiCostSignals.ts. */
export const GUI_QUOTA_WEIGHT_CACHE_WRITE = 1.25
export const GUI_QUOTA_WEIGHT_CACHE_READ = 0.1
export const GUI_QUOTA_WEIGHT_INPUT = 1
export const GUI_QUOTA_WEIGHT_OUTPUT = 5

function wholeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Constrói a parcela a partir de números crus dos dois protocolos. `undefined`
 * quando a chamada não existiu de verdade: um `usage` inteiramente zerado é a
 * assinatura da mensagem SINTÉTICA (saída de comando local), e contá-la faria o
 * odômetro anunciar chamada de API que nunca saiu da máquina.
 */
export function guiApiCallParcels(input: {
  inputTokens: unknown
  cacheWriteTokens: unknown
  cacheReadTokens: unknown
  outputTokens: unknown
}): GuiApiCallParcels | undefined {
  const inputTokens = wholeCount(input.inputTokens) ?? 0
  const cacheWriteTokens = wholeCount(input.cacheWriteTokens) ?? 0
  const cacheReadTokens = wholeCount(input.cacheReadTokens) ?? 0
  const outputTokens = wholeCount(input.outputTokens) ?? 0
  if (inputTokens + cacheWriteTokens + cacheReadTokens === 0) return undefined
  return { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens }
}

export function isGuiApiCallParcels(value: unknown): value is GuiApiCallParcels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const parcels = value as Record<string, unknown>
  return (
    wholeCount(parcels['inputTokens']) !== undefined &&
    wholeCount(parcels['cacheWriteTokens']) !== undefined &&
    wholeCount(parcels['cacheReadTokens']) !== undefined &&
    wholeCount(parcels['outputTokens']) !== undefined
  )
}

export function isGuiConversationUsage(value: unknown): value is GuiConversationUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  return (
    wholeCount(usage['apiCalls']) !== undefined &&
    wholeCount(usage['cacheWriteTokens']) !== undefined &&
    wholeCount(usage['cacheReadTokens']) !== undefined &&
    wholeCount(usage['inputTokens']) !== undefined &&
    wholeCount(usage['outputTokens']) !== undefined
  )
}

/** Soma UMA chamada. Parcela suja NUNCA vira gasto inventado: o acumulado volta
 *  como estava, e a conversa continua com o número que já era verdade. */
export function guiAddApiCall(
  usage: GuiConversationUsage | undefined,
  parcels: unknown
): GuiConversationUsage | undefined {
  if (!isGuiApiCallParcels(parcels)) return usage
  const base = isGuiConversationUsage(usage)
    ? usage
    : { apiCalls: 0, cacheWriteTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 }
  return {
    apiCalls: base.apiCalls + 1,
    cacheWriteTokens: base.cacheWriteTokens + parcels.cacheWriteTokens,
    cacheReadTokens: base.cacheReadTokens + parcels.cacheReadTokens,
    inputTokens: base.inputTokens + parcels.inputTokens,
    outputTokens: base.outputTokens + parcels.outputTokens
  }
}

/** O peso da conversa inteira, arredondado (é aproximação — casas decimais ali
 *  seriam ruído com cara de precisão). */
export function guiConversationWeightTokens(usage: GuiConversationUsage | undefined): number {
  if (!isGuiConversationUsage(usage)) return 0
  return Math.round(
    usage.cacheWriteTokens * GUI_QUOTA_WEIGHT_CACHE_WRITE +
      usage.cacheReadTokens * GUI_QUOTA_WEIGHT_CACHE_READ +
      usage.inputTokens * GUI_QUOTA_WEIGHT_INPUT +
      usage.outputTokens * GUI_QUOTA_WEIGHT_OUTPUT
  )
}

/**
 * O LIMIAR DA CONVERSA PESADA.
 *
 * Limiar operacional herdado para contexto grande. Não estabelece o custo
 * relativo de outra conversa nem o percentual da assinatura consumido.
 *
 * ESPELHO DECLARADO: o par mora em `src/renderer/src/guiCostSignals.ts`
 * (GUI_HEAVY_CONTEXT_TOKENS) — o renderer nunca importa o main.
 */
export const GUI_HEAVY_CONTEXT_TOKENS = 150_000

/**
 * Em que MARCO de 150k esta medição caiu (150k, 300k, 450k…). `null` abaixo do
 * limiar — e é essa queda que RE-ARMA o aviso: `/clear` e `/compact` derrubam o
 * contexto, e uma conversa que voltou a ficar pesada merece ouvir de novo.
 */
export function guiHeavyContextMilestone(contextTokens: unknown): number | null {
  const tokens = wholeCount(contextTokens)
  if (tokens === undefined || tokens < GUI_HEAVY_CONTEXT_TOKENS) return null
  return Math.floor(tokens / GUI_HEAVY_CONTEXT_TOKENS) * GUI_HEAVY_CONTEXT_TOKENS
}

// A NOTA DA CONVERSA PESADA no fio morreu em 2026-09-16 (ordem do dono: "é
// feia; um aviso em tooltip seria melhor"). O marco continua sendo carimbado
// aqui e auditado no diário; a receita das três saídas (fechar a missão,
// /compact, seguir ciente) mora agora em `guiCostSignals.guiHeavyConversationTip`
// (renderer), no tooltip e no painel do medidor de contexto.

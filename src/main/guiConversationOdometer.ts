/**
 * O ODÔMETRO DA CONVERSA (R25.1) — o que ela já custou de COTA.
 *
 * A queixa que abriu esta rodada (dono, 2026-08-20): "contexto 7% (~70k), mas
 * já foi ~10% da cota de 5h — o Synkora está gastando e não mostrando". A
 * auditoria (`.synkora/reports/AUDITORIA_COTA_CLAUDE_2026-08-20.md`) somou o
 * `usage` REAL de cada chamada nos transcripts dos dois seats e fechou a conta:
 * não há vazamento, há FÍSICA SEM MEDIDOR. Cada chamada de API re-processa o
 * contexto INTEIRO, e um turno de agente com N ferramentas são N chamadas — o
 * medidor do pane mostrava a JANELA (quanto ainda cabe), nunca o custo.
 *
 * Este módulo é PURO de propósito (nada de electron/fs): ele é o que deixa o
 * peso ser provado em node cru contra números medidos, em vez de conferido no
 * olho dentro do registro de sessões.
 *
 * DUAS RÉGUAS DIFERENTES, e confundi-las foi o bug original:
 * - CONTEXTO (R20) = ocupação da janela AGORA = a fotografia de UMA chamada.
 * - ODÔMETRO (R25) = a SOMA do que a conversa já consumiu, chamada a chamada.
 *   Ele só cresce; compactar reduz a primeira e não devolve nada da segunda.
 */

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

/**
 * OS PESOS — APROXIMAÇÃO DE COTA, NUNCA PREÇO.
 *
 * Com assinatura (sem API key) o CLI não reporta custo em dinheiro, então o
 * único jeito honesto de dizer "quanto isto pesou" é em TOKENS-PESO. Os
 * multiplicadores são os da tabela de preço relativo das famílias atuais
 * (escrever cache ~1,25×, ler cache ~0,1×, saída ~5× a entrada) e foram
 * VALIDADOS na auditoria: aplicados aos transcripts das 5h do seat Hotmail,
 * reproduziram os 81% que o `/usage` do próprio CLI reportou.
 *
 * REGRA DE RE-SONDA: se a tabela de preço relativo mudar, é aqui que envelhece
 * — e a UI nunca fala em $ justamente porque isto é uma aproximação.
 */
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
 * 150k não é palpite: o `/usage` dos dois seats reportou 46–67% do uso do dia
 * em contexto ACIMA de 150k, e a conversa que sozinha comeu ~70% da janela de
 * 5h estava em 190–326k por chamada. Daqui para cima cada mensagem custa mais
 * do que uma conversa nova inteira.
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

/** Arredondamento de PROSA (o dono lê "192k", como a auditoria escreve). */
function thousands(tokens: number): string {
  return `${Math.round(tokens / 1_000)}k`
}

/**
 * A NOTA DA CONVERSA PESADA — advisory, com as três saídas REAIS de hoje.
 *
 * Beco sem saída é bug de primeira classe (regra da casa): toda fala do app
 * nomeia a RECEITA. As três existem e são executáveis DESTE chat: fechar a
 * missão (a entrega vira briefing da próxima — R16), `/compact` (está na régua
 * de slash da casa e vai CRU ao binário — R22) e seguir ciente do custo, que é
 * uma escolha legítima e por isso está escrita.
 */
export function guiHeavyConversationNote(contextTokens: number): string {
  return (
    `esta conversa re-lê ~${thousands(contextTokens)} tokens a cada mensagem — ` +
    'fechar a missão leva o conhecimento adiante (a entrega vira briefing da próxima), ' +
    '/compact compacta a conversa aqui mesmo, ou siga ciente do custo.'
  )
}

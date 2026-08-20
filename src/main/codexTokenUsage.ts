/**
 * A LEITURA DO MEDIDOR DE CONTEXTO DO CODEX (`thread/tokenUsage/updated`).
 *
 * SONDADO no binário real (codex app-server 0.147.0, 2026-08-17 — relatório
 * `probe-codex-tokenusage.md`, 8 frames crus capturados):
 *
 * - `last` = fotografia do ÚLTIMO REQUEST (um turno emite UM evento POR CHAMADA
 *   de API — o turno de 3 comandos da sonda emitiu 4 eventos, cada um com o seu
 *   `last`). É essa fotografia, e só ela, que descreve o contexto vivo.
 * - `total` = acumulado da thread, RESTAURADO no `thread/resume` (nunca zera,
 *   nem com processo novo) e portanto ilimitado. JAMAIS alimenta a régua: foi
 *   ele que produziu os 404.325 tokens numa janela de 258.400 (156,5%) antes do
 *   commit c8ceecd.
 *
 * Ausência NUNCA vira fallback para `total`: sem `last`/janela válidos a UI
 * remove a régua até o app-server voltar a publicar uma medida boa.
 *
 * MÓDULO PURO: entra o payload cru do protocolo, sai a leitura — é o que deixa
 * a régua ser provada em node puro (test:codex-token-usage) contra os frames
 * REAIS da sonda, em vez de conferida no olho dentro do `switch` da sessão.
 */

// Import de TIPO (apagado na compilação e pelo strip-types do node): é o que
// mantém este módulo sem dependência de runtime — a suíte roda o `.ts` cru.
import type { GuiApiCallParcels } from './guiConversationOdometer'

export interface CodexContextReading {
  contextTokens?: number
  contextWindow?: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** `thread/tokenUsage/updated` já vem em tokens inteiros. */
function codexContextTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function codexContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Extrai o contexto vivo do payload `tokenUsage` do protocolo. O campo `total`
 * do payload é lido por NINGUÉM — a régua é `last` ou nada.
 */
export function codexContextFromTokenUsage(tokenUsage: unknown): CodexContextReading {
  const usage = asRecord(tokenUsage)
  const last = asRecord(usage?.['last'])
  return {
    contextTokens: codexContextTokenCount(last?.['totalTokens']),
    contextWindow: codexContextWindow(usage?.['modelContextWindow'])
  }
}

/**
 * AS PARCELAS DAQUELA MESMA CHAMADA (R25.1) — o que o odômetro da conversa
 * soma. NENHUMA claim nova de protocolo: os campos abaixo já estavam nos 8
 * frames crus da sonda de 2026-08-17 (fixture de test-codex-token-usage), e a
 * fonte continua sendo `last`, o request. Repartir `total` contaria a thread
 * inteira a cada evento — o mesmo bug que produziu os 404.325 tokens.
 *
 * SEMÂNTICA DO PROTOCOLO, verificada frame a frame na fixture:
 * `last.inputTokens` é o input INTEIRO (`input + output === total` fecha em
 * 100% dos frames) e `cachedInputTokens`/`cacheWriteInputTokens` são recortes
 * DENTRO dele. O claude já reporta o input fresco separado, então a
 * normalização acontece aqui: fresco = input − lido − escrito.
 *
 * `undefined` quando a repartição não veio (frame só com `totalTokens`): sem
 * ela o contexto ainda é mensurável, mas o CUSTO não — e publicar zero em cada
 * parcela faria o odômetro contar uma chamada de graça.
 */
export function codexCallParcelsFromTokenUsage(tokenUsage: unknown): GuiApiCallParcels | undefined {
  const last = asRecord(asRecord(tokenUsage)?.['last'])
  const input = codexContextTokenCount(last?.['inputTokens'])
  // Sem input não houve chamada de verdade — mesma régua do claude, onde um
  // `usage` zerado é a assinatura da mensagem sintética de comando local.
  if (input === undefined || input === 0) return undefined
  const cacheRead = codexContextTokenCount(last?.['cachedInputTokens']) ?? 0
  const cacheWrite = codexContextTokenCount(last?.['cacheWriteInputTokens']) ?? 0
  return {
    // Frame incoerente (cache maior que o input) nunca vira parcela negativa: o
    // fresco satura em zero e o resto do frame continua sendo contado.
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    outputTokens: codexContextTokenCount(last?.['outputTokens']) ?? 0
  }
}

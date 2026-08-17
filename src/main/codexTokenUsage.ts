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

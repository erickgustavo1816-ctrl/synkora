/**
 * OS SINAIS DE CUSTO DO CHAT (R25) — o que a tela diz sobre COTA.
 *
 * O medidor que já existia responde "quanto ainda cabe na janela". A queixa do
 * dono (2026-08-20) era outra: "contexto 7%, mas já foi 10% da cota de 5h".
 * São duas réguas diferentes, e este módulo cuida da segunda — as três leituras
 * que o painel de contexto e os menus passam a mostrar:
 *
 * - o ODÔMETRO da conversa (chamadas × peso), acumulado pelo MAIN;
 * - a COTA REAL do seat desta conversa, lida do cache que o poller já mantém;
 * - a nota da TROCA CARA, quando mudar modelo/effort/⚡ vai re-escrever cache.
 *
 * Módulo PURO (nada de React, nada de `window`): é o que deixa cada número ser
 * provado em node cru, em vez de conferido no olho dentro do componente.
 */
// Import de TIPO apenas — o renderer nunca importa código do main/preload, e
// este módulo é FOLHA de propósito: a suíte o roda como `.ts` cru (strip-types),
// onde import de runtime entre módulos do renderer não resolve.
import type { SeatUsage } from '../../preload/index'

/** ESPELHO DECLARADO: o par é `compactTokens` em `guiComposerPresentation.ts`,
 *  a voz compacta do medidor de janela. O odômetro fala IGUAL a ele — dois
 *  formatos de número no mesmo painel seriam duas vozes na mesma frase. */
function compactTokens(value: number): string {
  const safe = Math.max(0, Math.round(value))
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)} mi`
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1)} mil`
  return String(safe)
}

/**
 * ESPELHO DECLARADO: o par é `GUI_HEAVY_CONTEXT_TOKENS` em
 * `src/main/guiConversationOdometer.ts`, que decide quando o app ABRE A BOCA no
 * fio. Aqui ele decide quando a tela muda de tom e quando o menu avisa — as
 * duas metades do mesmo limiar medido (o `/usage` reportou 46–67% do uso do dia
 * em conversas acima de 150k).
 */
export const GUI_HEAVY_CONTEXT_TOKENS = 150_000

/**
 * Leitura de cota mais velha que isto não é mostrada. Uma janela de sessão dura
 * 5h: passado esse tempo o número descreve uma janela que já resetou, e um
 * susto inventado é pior que uma linha ausente.
 */
export const GUI_SEAT_QUOTA_MAX_AGE_MS = 6 * 60 * 60_000

export type GuiCostTone = 'cool' | 'warm' | 'hot'

/**
 * A RÉGUA DE SEVERIDADE — UMA para a casa inteira. Ela nasceu inline nos
 * medidores do titlebar (UsageMeters), que agora bebem daqui: dois limiares
 * diferentes para a mesma pergunta ("quão apertado está isto?") seria a mesma
 * armadilha que já fez o SeatRail mostrar "sem dados" enquanto a titlebar
 * mostrava o número.
 */
export function guiMeterTone(severity: number): GuiCostTone {
  if (!Number.isFinite(severity)) return 'cool'
  if (severity >= 0.85) return 'hot'
  if (severity >= 0.6) return 'warm'
  return 'cool'
}

export interface GuiOdometerPresentation {
  calls: number
  weightTokens: number
  /** `139 chamadas · ~3.6 mi tokens-peso` */
  valueLabel: string
  /** A FÍSICA em uma frase — sem ela o número não explica nada. */
  hint: string
  tone: GuiCostTone
  tooltip: string
}

function wholeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * O ODÔMETRO, pronto para a tela. `null` = o main ainda não contou nada (ou a
 * conversa acabou de nascer): a UI ESCONDE a linha em vez de escrever zero.
 *
 * O TOM sai da mesma régua dos medidores, aplicada à COTA e não à janela: o
 * denominador é o limiar da conversa pesada, não `contextWindow`. Uma conversa
 * de 190k num modelo de 1M ocupa 19% da janela e mesmo assim é a mais cara da
 * casa — foi exatamente esse número que comeu 70% da cota do dia na auditoria.
 * Como a régua fica "quente" em 85%, o sinal esquenta um pouco ANTES de o app
 * abrir a boca no fio (150k): a cor avisa, e só depois vêm as palavras.
 */
export function guiOdometerPresentation(
  convCalls: number | null | undefined,
  convWeightTokens: number | null | undefined,
  contextTokens: number | null | undefined
): GuiOdometerPresentation | null {
  const calls = wholeCount(convCalls)
  const weightTokens = wholeCount(convWeightTokens)
  if (!calls || weightTokens === undefined) return null
  const valueLabel = `${calls} ${calls === 1 ? 'chamada' : 'chamadas'} · ~${compactTokens(
    weightTokens
  )} tokens-peso`
  const measured = typeof contextTokens === 'number' && Number.isFinite(contextTokens)
    ? Math.max(0, contextTokens)
    : 0
  return {
    calls,
    weightTokens,
    valueLabel,
    hint: 'cada mensagem re-processa o contexto inteiro',
    tone: guiMeterTone(Math.min(1, measured / GUI_HEAVY_CONTEXT_TOKENS)),
    tooltip: `esta conversa: ${valueLabel}`
  }
}

export interface GuiSeatQuotaPresentation {
  /** O rótulo do medidor, como o main o normalizou ("sessão", "geral"…). */
  label: string
  /** `81% usado · reseta 15:50` (ou `restam 8% · …`, no codex). */
  valueLabel: string
  /** `há 12 min` — presente só quando a leitura já envelheceu. */
  ageLabel?: string
  tone: GuiCostTone
  tooltip: string
}

/** A idade da leitura vira minutos/horas inteiros: precisão maior seria fingir
 *  que o número é vivo. */
function ageLabel(ms: number): string | undefined {
  if (ms < 5 * 60_000) return undefined
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `há ${minutes} min`
  return `há ${Math.floor(minutes / 60)} h`
}

/**
 * A COTA DO SEAT DESTA CONVERSA. A fonte é o cache do main (`seats.usagePeek`),
 * que NUNCA coleta — é por isso que a leitura pode estar velha, e é por isso
 * que ela DIZ a idade em vez de fingir frescor.
 *
 * O medidor mostrado é o PRIMEIRO da lista, e isso é estrutural: os dois CLIs
 * publicam a janela curta primeiro (claude: "Current session"; codex: a
 * `primary` do bucket), e é ela que estoura no meio do trabalho. Nada aqui lê
 * palavra de rótulo para escolher.
 */
export function guiSeatQuotaPresentation(
  info: SeatUsage | null | undefined,
  now: number
): GuiSeatQuotaPresentation | null {
  const meter = info?.meters?.[0]
  if (!info || !meter) return null
  const age = typeof info.at === 'number' && Number.isFinite(info.at) ? now - info.at : Number.NaN
  if (!Number.isFinite(age) || age > GUI_SEAT_QUOTA_MAX_AGE_MS) return null
  // A DIREÇÃO de cada CLI é preservada (o TUI do codex conta o que resta) —
  // mesma voz dos medidores do titlebar.
  const value = meter.mode === 'left' ? `restam ${meter.pct}%` : `${meter.pct}% usado`
  const valueLabel = meter.reset ? `${value} · reseta ${meter.reset}` : value
  const stale = ageLabel(Math.max(0, age))
  return {
    label: meter.label,
    valueLabel,
    ...(stale ? { ageLabel: stale } : {}),
    tone: guiMeterTone(meter.severity),
    tooltip: `conta: ${meter.label} ${valueLabel}${stale ? ` · medido ${stale}` : ''}`
  }
}

/**
 * A NOTA DA TROCA CARA (R25.3b). Armadilha documentada e agora MEDIDA: modelo,
 * effort e ⚡ entram na chave do prompt-cache, então trocar no meio de uma
 * conversa grande re-escreve o contexto inteiro.
 *
 * É ADVISORY e nada mais: só o número que o odômetro já tem na mão, ao lado do
 * clique que continua livre. `null` abaixo do limiar — em conversa pequena a
 * troca é barata e o aviso seria ruído.
 */
export function guiExpensiveSwitchNote(contextTokens: number | null | undefined): string | null {
  if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens)) return null
  if (contextTokens < GUI_HEAVY_CONTEXT_TOKENS) return null
  return `trocar agora re-escreve ~${Math.round(contextTokens / 1_000)}k de cache`
}

export type GuiActivityStatus = 'starting' | 'working' | 'waiting-you' | 'idle' | 'dead'

const GENERIC_ACTIVITY = ['pensando', 'analisando', 'trabalhando', 'raciocinando'] as const

/** Um turno preserva o relógio ao esperar o usuário e o encerra atomicamente. */
export function transitionGuiStartedAt(
  current: number | null,
  nextStatus: GuiActivityStatus,
  now: number
): number | null {
  if (nextStatus === 'working') return current ?? now
  if (nextStatus === 'idle' || nextStatus === 'dead') return null
  return current
}

/**
 * O FECHO DA RODADA (R11, ordem do dono: "sempre no final de cada rodada eu
 * quero o timer em algum lugar"). A rodada é a régua do `startedAt` acima —
 * arma no working, sobrevive à espera pelo dono, zera no fecho lógico. O selo
 * nasce EXATAMENTE na transição que zera para `idle`: morte de sessão não é
 * rodada concluída, e turno que continua (subagente em background) ainda conta.
 */
export function guiRoundClosed(
  prevStartedAt: number | null,
  nextStartedAt: number | null,
  nextStatus: GuiActivityStatus
): boolean {
  return prevStartedAt !== null && nextStartedAt === null && nextStatus === 'idle'
}

/** O texto do selo — fonte única (o fio e qualquer superfície futura leem o
 *  MESMO formato). */
export function guiRoundStampText(elapsedMs: number): string {
  return `⏱ rodada: ${formatGuiElapsed(elapsedMs)}`
}

/** Piso do selo: abaixo de UM segundo o carimbo nem consegue mostrar tempo (a
 *  régua é em segundos) — e `⏱ rodada: 0:00` é ruído que engana. */
export const GUI_ROUND_MIN_ELAPSED_MS = 1_000

/**
 * RODADA FANTASMA NÃO GANHA SELO (R21.4, 2º print do dono). `results`
 * ENCADEADOS — o caso real: o session-limit caindo instantâneo em cima de um
 * rejected — abrem e fecham uma rodada de 0s sem trabalho nenhum, e ela
 * carimbava `0:00`. Regra honesta: só carimba a rodada que TRABALHOU (item
 * novo desde que ela abriu) ou que durou tempo mensurável. A rodada de
 * verdade, a dos minutos, continua carimbando o tempo cheio.
 */
export function guiRoundEarnsStamp(elapsedMs: number, worked: boolean): boolean {
  return worked || elapsedMs >= GUI_ROUND_MIN_ELAPSED_MS
}

/**
 * O trabalho da rodada EM CURSO. Duas exclusões deliberadas: a rodada NASCE
 * sem trabalho (o evento que a abriu não é trabalho dela) e o evento que a
 * FECHA não conta — senão o próprio card do result encadeado se declararia
 * trabalho e o fantasma ganharia selo de novo.
 */
export function trackGuiRoundWork(
  prevStartedAt: number | null,
  nextStartedAt: number | null,
  prevWorked: boolean,
  appendedItem: boolean
): boolean {
  if (nextStartedAt === null) return false
  if (prevStartedAt === null) return false
  return prevWorked || appendedItem
}

/**
 * A DUPLICATA MORRE (R21.3, 2º print do dono): o CLI FALA o erro no stream e
 * repete a MESMA frase como palavra final do turno (`resultText`) — o fio
 * mostrava as duas ("You've hit your session limit" como fala E como card).
 * Comparação ESTRUTURAL de igualdade, nunca leitura de conteúdo: só bate
 * quando é literalmente o mesmo texto.
 */
export function guiResultEchoesSpeech(
  speech: string | undefined,
  resultText: string | undefined
): boolean {
  const said = speech?.trim()
  const final = resultText?.trim()
  return Boolean(said) && said === final
}

/** Texto factual do backend vence sempre o verbo cosmético. */
export function guiActivityLabel(elapsedMs: number, statusText?: string | null): string {
  const factual = statusText?.trim()
  if (factual) return factual
  const index = Math.floor(Math.max(0, elapsedMs) / 4_000) % GENERIC_ACTIVITY.length
  return GENERIC_ACTIVITY[index]
}

export function formatGuiElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}


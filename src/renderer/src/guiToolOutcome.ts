/** `interrupted` (R6.1): parada PRESERVADORA de um ajudante — não terminou,
 *  não caiu, não foi jogado fora; dele se volta (helper_resume).
 *  `unconfirmed`: o turno encerrou sem recibo autoritativo da ferramenta. */
export type GuiToolOutcome = 'completed' | 'failed' | 'denied' | 'cancelled' | 'interrupted' | 'unconfirmed'

export interface GuiToolResultLike {
  text: string
  isError: boolean
  status?: GuiToolOutcome
}

export type GuiToolTone = 'ok' | 'err' | 'denied' | 'cancel'

export interface GuiToolOutcomeView {
  tone: GuiToolTone
  compactLabel: string
  statusLabel: string
}

export function guiToolOutcomeView(
  result: GuiToolResultLike | undefined
): GuiToolOutcomeView | null {
  if (!result) return null
  if (result.status === 'denied') {
    return { tone: 'denied', compactLabel: 'negado', statusLabel: 'negado' }
  }
  if (result.status === 'cancelled') {
    return { tone: 'cancel', compactLabel: 'cancelada', statusLabel: 'cancelado' }
  }
  // Interrompido não é falha nem cancelamento definitivo: o tom neutro é o do
  // cancel (nenhuma cor nova), mas a PALAVRA é própria — é ela que diz ao dono
  // que dele se volta.
  if (result.status === 'interrupted') {
    return { tone: 'cancel', compactLabel: 'interrompida', statusLabel: 'interrompido' }
  }
  if (result.status === 'failed' || result.isError) {
    return {
      tone: 'err',
      compactLabel: 'falhou',
      statusLabel: 'falhou'
    }
  }
  // Ausência de recibo não confirma nem sucesso nem falha da ferramenta.
  // Erro factual acima prevalece sobre um marcador provisório inconsistente.
  if (result.status === 'unconfirmed') {
    return { tone: 'cancel', compactLabel: 'não confirmado', statusLabel: 'não confirmado' }
  }
  const passed = /(\d+)\s+(?:passed|passing|passaram)/iu.exec(result.text)
  if (passed) return { tone: 'ok', compactLabel: `✓ ${passed[1]} passed`, statusLabel: 'concluído' }
  const inserted = /(\d+)\s+(?:insertions?|inserções?|linhas? adicionadas?)/iu.exec(
    result.text
  )
  if (inserted)
    return { tone: 'ok', compactLabel: `+${inserted[1]}`, statusLabel: 'concluído' }
  return { tone: 'ok', compactLabel: '✓', statusLabel: 'concluído' }
}

export function guiToolGroupOutcomeView(
  results: Array<GuiToolResultLike | undefined>
): GuiToolOutcomeView | null {
  const views = results.map(guiToolOutcomeView).filter((view) => view !== null)
  return (
    views.find((view) => view.tone === 'err') ??
    views.find((view) => view.tone === 'denied') ??
    views.find((view) => view.tone === 'cancel') ??
    (views.length === results.length && views.length > 0
      ? { tone: 'ok', compactLabel: '✓', statusLabel: 'concluído' }
      : null)
  )
}

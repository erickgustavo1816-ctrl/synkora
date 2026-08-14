export type GuiToolOutcome = 'completed' | 'failed' | 'denied' | 'cancelled'

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
  if (result.status === 'failed' || result.isError) {
    return {
      tone: 'err',
      compactLabel: 'falhou',
      statusLabel: 'falhou'
    }
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

import type { GuiItem } from './store'

type GuiTerminalEvent =
  | {
      type: 'result'
      isError: boolean
      outcome?: 'completed' | 'failed' | 'cancelled'
      errorText?: string
    }
  | { type: 'fatal'; text: string }
  | { type: 'closed'; code: number | null }

export function guiClosedLine(code: number | null, hadPendingTool = false): {
  kind: 'note' | 'error'
  text: string
} {
  const failed = hadPendingTool || (code !== null && code !== 0)
  return failed
    ? {
        kind: 'error',
        text: hadPendingTool
          ? 'a sessão encerrou antes de receber o resultado de uma ferramenta'
          : `a sessão encerrou com código ${code}`
      }
    : { kind: 'note', text: 'sessão encerrada' }
}

function terminalToolResult(evt: GuiTerminalEvent): {
  text: string
  isError: boolean
  status: 'failed' | 'cancelled'
  lineCount: number
  truncated: false
} {
  if (evt.type === 'fatal') {
    return {
      text: evt.text.trim() || 'a sessão falhou antes de a ferramenta concluir',
      isError: true,
      status: 'failed',
      lineCount: 1,
      truncated: false
    }
  }
  if (evt.type === 'closed') {
    return {
      text:
        evt.code !== null && evt.code !== 0
          ? `a sessão encerrou antes de a ferramenta concluir (código ${evt.code})`
          : 'a sessão encerrou sem entregar o resultado da ferramenta',
      isError: true,
      status: 'failed',
      lineCount: 1,
      truncated: false
    }
  }
  if (evt.type === 'result' && (evt.isError || evt.outcome === 'failed')) {
    return {
      text: evt.errorText?.trim() || 'o turno falhou antes de a ferramenta concluir',
      isError: true,
      status: 'failed',
      lineCount: 1,
      truncated: false
    }
  }
  if (evt.type === 'result' && evt.outcome !== 'cancelled') {
    return {
      text: 'o turno terminou sem entregar o resultado da ferramenta',
      isError: true,
      status: 'failed',
      lineCount: 1,
      truncated: false
    }
  }
  return {
    text: 'o turno terminou antes de a ferramenta concluir',
    isError: false,
    status: 'cancelled',
    lineCount: 1,
    truncated: false
  }
}

export function hasPendingGuiTools(items: GuiItem[]): boolean {
  return items.some((item) => item.kind === 'tool' && !item.result)
}

/**
 * Eventos terminais são a última palavra sobre o turno. Se o CLI não enviou
 * `tool-result` (comum ao interromper), todo card ainda pendente ganha um
 * desfecho explícito; resultados já pareados permanecem intactos.
 */
export function closePendingGuiTools(
  items: GuiItem[],
  evt: GuiTerminalEvent
): GuiItem[] {
  let changed = false
  const result = terminalToolResult(evt)
  const next = items.map((item) => {
    if (item.kind !== 'tool' || item.result) return item
    changed = true
    return { ...item, result }
  })
  return changed ? next : items
}

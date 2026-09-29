import { formatUsageLimitText } from '../chatFormatting'
import GuiTurnRecoveryAction from './GuiTurnRecoveryAction'

function errorPreview(text: string, cap = 110): string {
  const first = text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? 'falha sem detalhes'
  return first.length > cap ? `${first.slice(0, cap - 1)}…` : first
}

export default function GuiErrorLine({ text, paneId, recoveryToken }: {
  text: string
  paneId?: string
  recoveryToken?: string
}): React.JSX.Element {
  const formattedText = formatUsageLimitText(text)
  const preview = errorPreview(formattedText)
  const expandable = formattedText.includes('\n') || formattedText.trim().length > preview.length
  const row = (
    <>
      <span className="gui-error-mark" aria-hidden="true">!</span>
      <b>falhou</b>
      <span>{preview}</span>
    </>
  )
  return (
    <>
      {expandable ? (
        <details className="gui-error-line" role="alert">
          <summary>{row}</summary>
          <pre>{formattedText}</pre>
        </details>
      ) : <div className="gui-error-line" role="alert">{row}</div>}
      {paneId && recoveryToken && <GuiTurnRecoveryAction paneId={paneId} recoveryToken={recoveryToken} />}
    </>
  )
}

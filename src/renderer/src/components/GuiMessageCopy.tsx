import { useEffect, useRef, useState } from 'react'
import { writeGuiMessageCopy } from '../guiMessageCopy'

type CopyFeedback =
  | { kind: 'idle'; text: '' }
  | { kind: 'copying'; text: string }
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string }

export default function GuiMessageCopy({
  markdown
}: {
  markdown: string
}): React.JSX.Element {
  const [feedback, setFeedback] = useState<CopyFeedback>({ kind: 'idle', text: '' })
  const requestRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      requestRef.current += 1
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    []
  )

  const copy = async (): Promise<void> => {
    const request = requestRef.current + 1
    requestRef.current = request
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setFeedback({ kind: 'copying', text: 'Copiando resposta como texto' })
    try {
      const writer = navigator.clipboard?.writeText?.bind(navigator.clipboard)
      if (!writer) throw new Error('clipboard indisponível')
      await writeGuiMessageCopy(writer, markdown, 'text')
      if (requestRef.current !== request) return
      setFeedback({ kind: 'success', text: 'Resposta copiada como texto' })
      timerRef.current = window.setTimeout(() => {
        if (requestRef.current === request) setFeedback({ kind: 'idle', text: '' })
      }, 2_000)
    } catch {
      if (requestRef.current !== request) return
      setFeedback({ kind: 'error', text: 'Não foi possível copiar a resposta' })
    }
  }

  const copying = feedback.kind === 'copying'
  const copied = feedback.kind === 'success'
  const buttonLabel = copying
    ? 'Copiando resposta'
    : copied
      ? 'Resposta copiada'
      : feedback.kind === 'error'
        ? 'Tentar copiar resposta novamente'
        : 'Copiar resposta como texto'

  return (
    <div className="gui-copy-row">
      <button
        type="button"
        className={`gui-copy-action ${feedback.kind}`}
        aria-label={buttonLabel}
        data-tip={buttonLabel}
        aria-busy={copying}
        disabled={copying}
        onClick={() => void copy()}
      >
        {copied ? <CheckGlyph /> : <CopyGlyph />}
      </button>
      <span
        className={`gui-copy-feedback ${feedback.kind}`}
        role={feedback.kind === 'error' ? 'alert' : 'status'}
        aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'}
      >
        {feedback.text}
      </span>
    </div>
  )
}

function CopyGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 18 18"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6.25" y="5.25" width="8" height="9" rx="1.75" />
      <path d="M11.75 5.25V4.5A1.75 1.75 0 0 0 10 2.75H4A1.75 1.75 0 0 0 2.25 4.5v7A1.75 1.75 0 0 0 4 13.25h2.25" />
    </svg>
  )
}

function CheckGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 18 18"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3.5 9.25 3.25 3.25 7.75-7.75" />
    </svg>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { GuiQuestion } from '../guiApi'

/** Two explicit, single-choice options are actions, not inferred approval.
 * Labels and question IDs come from the structured request of either CLI. */
export default function GuiQuickQuestionCard({ question, onAnswer, onSkip, disabled = false }: {
  question: GuiQuestion
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
  disabled?: boolean
}): React.JSX.Element {
  const [customOpen, setCustomOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const customRef = useRef<HTMLInputElement>(null)
  useEffect(() => { cardRef.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => { if (customOpen) customRef.current?.focus({ preventScroll: true }) }, [customOpen])

  const answer = (value: string): void => {
    if (disabled || !value.trim()) return
    // Null prototype keeps Claude's question-as-key and Codex IDs equally safe.
    const answers: Record<string, string> = Object.create(null)
    answers[question.id ?? question.question] = value
    onAnswer(answers)
  }

  return (
    <div className="gui-question" data-quick-question="true" ref={cardRef} tabIndex={-1}
      role="group" aria-label="Pergunta do agente" aria-busy={disabled}
      onKeyDown={event => {
        if (disabled) return
        if (event.key === 'Escape') { event.preventDefault(); onSkip() }
        // Enter on an explicitly focused button uses its native click. Merely
        // opening the card, pressing Enter on the group, or skipping is no yes.
        if (event.key === 'Enter' && event.target === customRef.current) {
          event.preventDefault()
          answer(custom.trim())
        }
      }}>
      <div className="gui-question-head">
        <span className="gui-question-title">{question.header?.trim() || 'Sua decisão'}</span>
      </div>
      <div className="gui-question-text">{question.question}</div>
      <div className="gq-quick-options">
        {question.options.map(option => (
          <button key={option.label} type="button" className="gq-option gq-quick-option"
            aria-label={option.label} disabled={disabled} onClick={() => answer(option.label)}>
            <span className="gq-body"><b>{option.label}</b>
              {option.description && <span className="gq-desc">{option.description}</span>}
            </span>
          </button>
        ))}
      </div>
      <div className="gq-quick-footer">
        <span className="gq-hint">Um clique envia sua resposta.</span>
        {question.allowCustom !== false && <button className="gui-btn" type="button" disabled={disabled}
          aria-expanded={customOpen} onClick={() => setCustomOpen(!customOpen)}>outra resposta…</button>}
        <button className="gui-btn" type="button" disabled={disabled} onClick={onSkip}>pular</button>
      </div>
      {question.allowCustom !== false && customOpen && <div className="gq-quick-custom">
        <input ref={customRef} className="gq-custom" aria-label="Sua resposta"
          placeholder="Descreva o ajuste que você quer" maxLength={4_000} disabled={disabled}
          value={custom} onChange={event => setCustom(event.target.value)} />
        <button className="gui-btn" type="button" disabled={disabled || !custom.trim()}
          onClick={() => answer(custom.trim())}>responder</button>
      </div>}
    </div>
  )
}

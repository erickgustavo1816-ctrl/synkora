import { useCallback, useEffect, useRef, useState } from 'react'
import type { GuiQuestion } from '../guiApi'
import GuiQuickQuestionCard from './GuiQuickQuestionCard'

interface GuiQuestionCardProps {
  questions: GuiQuestion[]
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
  disabled?: boolean
}

export default function GuiQuestionCard(props: GuiQuestionCardProps): React.JSX.Element {
  const single = props.questions.length === 1 ? props.questions[0] : undefined
  if (single && !single.multiSelect && single.options.length === 2) {
    return <GuiQuickQuestionCard question={single} onAnswer={props.onAnswer}
      onSkip={props.onSkip} disabled={props.disabled} />
  }
  return <GuiQuestionnaire {...props} />
}

// PERGUNTA COM OPÇÕES (AskUserQuestion / request_user_input) — o desenho que o dono pediu ("aquelas
// perguntas que você seleciona e digita"), traduzido do claudecodeui para o
// tema papel.
//
// Regras do formato (provadas no fork, fixadas no contrato 2.0):
//  - UMA pergunta por vez, com contador e passos clicáveis: perguntar três
//    coisas de uma vez vira formulário, e formulário ninguém responde.
//  - A resposta usa o ID do Codex, ou o texto da pergunta no Claude.
//  - "Pular" é uma resposta legítima (mapa vazio), NUNCA um "não".
//  - Teclado: 1-9 escolhe, 0 abre "outra resposta", Enter avança/envia,
//    Esc pula. O card recebe o foco sozinho a cada passo.

function GuiQuestionnaire({
  questions,
  onAnswer,
  onSkip,
  disabled = false
}: {
  questions: GuiQuestion[]
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
  disabled?: boolean
}): React.JSX.Element {
  const [step, setStep] = useState(0)
  // Escolhas por índice de pergunta: Set de labels + o texto livre do "outra".
  const [picked, setPicked] = useState<Record<number, Set<string>>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({})
  const cardRef = useRef<HTMLDivElement>(null)
  const customRef = useRef<HTMLInputElement>(null)

  const current = questions[step]
  const total = questions.length
  const multi = current?.multiSelect === true
  const allowCustom = current?.allowCustom !== false
  const freeTextOnly = current?.options.length === 0

  // O card é a coisa a responder: ele toma o foco para o teclado valer sem
  // clique. `preventScroll` porque o fio já está preso no fim.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true })
  }, [step])

  const toggle = useCallback(
    (label: string): void => {
      if (disabled) return
      setPicked((prev) => {
        const set = new Set(prev[step] ?? [])
        if (multi) {
          if (set.has(label)) set.delete(label)
          else set.add(label)
        } else {
          set.clear()
          set.add(label)
        }
        return { ...prev, [step]: set }
      })
    },
    [disabled, multi, step]
  )

  const openCustom = useCallback((): void => {
    if (disabled || !allowCustom) return
    setCustomOpen((prev) => ({ ...prev, [step]: !prev[step] }))
    window.setTimeout(() => customRef.current?.focus({ preventScroll: true }), 0)
  }, [allowCustom, disabled, step])

  /** O mapa que viaja ao CLI: labels escolhidos + o texto livre, na ordem em
   *  que aparecem. Pergunta sem resposta simplesmente não entra. */
  const buildAnswers = useCallback((): Record<string, string> => {
    const answers: Record<string, string> = Object.create(null)
    questions.forEach((q, i) => {
      const parts = [...(picked[i] ?? [])]
      const extra = custom[i]?.trim()
      if (extra && q.allowCustom !== false) parts.push(extra)
      if (parts.length) answers[q.id ?? q.question] = parts.join(', ')
    })
    return answers
  }, [custom, picked, questions])

  const advance = useCallback((): void => {
    if (disabled) return
    if (step + 1 < total) setStep(step + 1)
    else if ((picked[step]?.size ?? 0) > 0 || (allowCustom && custom[step]?.trim()))
      onAnswer(buildAnswers())
  }, [allowCustom, buildAnswers, custom, disabled, onAnswer, picked, step, total])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (disabled) return
      // Digitando no "outra resposta" o teclado é dele: só Enter/Esc sobem.
      const typing = e.target instanceof HTMLInputElement
      if (e.key === 'Escape') {
        e.preventDefault()
        onSkip()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        advance()
        return
      }
      if (typing) return
      if (e.key === '0') {
        e.preventDefault()
        openCustom()
        return
      }
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= (current?.options.length ?? 0)) {
        e.preventDefault()
        toggle(current.options[n - 1].label)
      }
    },
    [advance, current, disabled, onSkip, openCustom, toggle]
  )

  if (!current) return <div className="gui-question" />

  const chosen = picked[step] ?? new Set<string>()
  const hasAnswer = chosen.size > 0 || Boolean(custom[step]?.trim())
  const last = step + 1 >= total

  return (
    <div
      className="gui-question"
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label="Pergunta do agente"
      onKeyDown={onKeyDown}
    >
      <div className="gui-question-head">
        <span className="gui-question-icon" aria-hidden="true">
          ❓
        </span>
        <span className="gui-question-title">{current.header?.trim() || 'o agente perguntou'}</span>
        {total > 1 && (
          <span className="gui-question-steps">
            {questions.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`gq-dot${i === step ? ' active' : ''}${
                  (picked[i]?.size ?? 0) > 0 || custom[i]?.trim() ? ' done' : ''
                }`}
                disabled={disabled}
                aria-label={`Ir para a pergunta ${i + 1}`}
                onClick={() => setStep(i)}
              />
            ))}
            <span className="gq-count">
              {step + 1}/{total}
            </span>
          </span>
        )}
      </div>

      <div className="gui-question-text">{current.question}</div>

      <div
        className="gui-question-options"
        role={multi ? 'group' : 'radiogroup'}
        aria-label={current.question}
      >
        {current.options.map((option, i) => {
          const active = chosen.has(option.label)
          return (
            <button
              key={option.label}
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={active}
              disabled={disabled}
              className={`gq-option${active ? ' active' : ''}`}
              onClick={() => toggle(option.label)}
            >
              <kbd className="gq-key">{i + 1}</kbd>
              <span className="gq-body">
                <b>{option.label}</b>
                {option.description && <span className="gq-desc">{option.description}</span>}
              </span>
              {active && (
                <span className="gq-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          )
        })}

        {allowCustom && !freeTextOnly && <button
          type="button"
          disabled={disabled}
          className={`gq-option other${customOpen[step] ? ' active' : ''}`}
          onClick={openCustom}
        >
          <kbd className="gq-key">0</kbd>
          <span className="gq-body">
            <b>outra resposta…</b>
          </span>
        </button>}
        {allowCustom && (freeTextOnly || customOpen[step]) && (
          <input
            ref={customRef}
            className="gq-custom"
            disabled={disabled}
            placeholder="escreva sua resposta"
            maxLength={4_000}
            value={custom[step] ?? ''}
            onChange={(e) => setCustom((prev) => ({ ...prev, [step]: e.target.value }))}
          />
        )}
      </div>

      <div className="gui-question-actions">
        <span className="gq-hint">
          {multi ? 'pode escolher mais de uma · ' : ''}teclas 1-9 · enter segue · esc pula
        </span>
        {step > 0 && (
          <button className="gui-btn" disabled={disabled} onClick={() => setStep(step - 1)}>
            voltar
          </button>
        )}
        <button className="gui-btn" disabled={disabled} onClick={onSkip}>
          pular
        </button>
        <button
          className="gui-btn primary"
          disabled={disabled || (!hasAnswer && last)}
          onClick={advance}
        >
          {last ? 'responder' : 'próxima'}
        </button>
      </div>
    </div>
  )
}

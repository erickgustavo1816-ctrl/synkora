import { useCallback, useEffect, useRef, useState } from 'react'
import type { GuiQuestion } from '../guiApi'

// PERGUNTA COM OPÇÕES (AskUserQuestion) — o desenho que o dono pediu ("aquelas
// perguntas que você seleciona e digita"), traduzido do claudecodeui para o
// tema papel.
//
// Regras do formato (provadas no fork, fixadas no contrato 2.0):
//  - UMA pergunta por vez, com contador e passos clicáveis: perguntar três
//    coisas de uma vez vira formulário, e formulário ninguém responde.
//  - A resposta é um MAPA { texto da pergunta → labels unidos por ', ' } —
//    é assim que ela volta ao CLI, dentro do updatedInput.
//  - "Pular" é uma resposta legítima (mapa vazio), NUNCA um "não".
//  - Teclado: 1-9 escolhe, 0 abre "outra resposta", Enter avança/envia,
//    Esc pula. O card recebe o foco sozinho a cada passo.

export default function GuiQuestionCard({
  questions,
  onAnswer,
  onSkip
}: {
  questions: GuiQuestion[]
  onAnswer: (answers: Record<string, string>) => void
  onSkip: () => void
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

  // O card é a coisa a responder: ele toma o foco para o teclado valer sem
  // clique. `preventScroll` porque o fio já está preso no fim.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true })
  }, [step])

  const toggle = useCallback(
    (label: string): void => {
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
    [multi, step]
  )

  const openCustom = useCallback((): void => {
    setCustomOpen((prev) => ({ ...prev, [step]: !prev[step] }))
    window.setTimeout(() => customRef.current?.focus({ preventScroll: true }), 0)
  }, [step])

  /** O mapa que viaja ao CLI: labels escolhidos + o texto livre, na ordem em
   *  que aparecem. Pergunta sem resposta simplesmente não entra. */
  const buildAnswers = useCallback((): Record<string, string> => {
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      const parts = [...(picked[i] ?? [])]
      const extra = custom[i]?.trim()
      if (extra) parts.push(extra)
      if (parts.length) answers[q.question] = parts.join(', ')
    })
    return answers
  }, [custom, picked, questions])

  const advance = useCallback((): void => {
    if (step + 1 < total) setStep(step + 1)
    else onAnswer(buildAnswers())
  }, [buildAnswers, onAnswer, step, total])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
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
    [advance, current, onSkip, openCustom, toggle]
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

        <button
          type="button"
          className={`gq-option other${customOpen[step] ? ' active' : ''}`}
          onClick={openCustom}
        >
          <kbd className="gq-key">0</kbd>
          <span className="gq-body">
            <b>outra resposta…</b>
          </span>
        </button>
        {customOpen[step] && (
          <input
            ref={customRef}
            className="gq-custom"
            placeholder="escreva sua resposta"
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
          <button className="gui-btn" onClick={() => setStep(step - 1)}>
            voltar
          </button>
        )}
        <button className="gui-btn" onClick={onSkip}>
          pular
        </button>
        <button className="gui-btn primary" disabled={!hasAnswer && last} onClick={advance}>
          {last ? 'responder' : 'próxima'}
        </button>
      </div>
    </div>
  )
}

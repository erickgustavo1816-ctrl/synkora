import { useEffect, useRef, useState } from 'react'
import GuiMarkdown from './GuiMarkdown'

// A RESPOSTA APARECE COMO SE FOSSE DIGITADA (ordem do dono, 2026-08-13:
// "tá pulando de uma palavra pra dez, aí pula quinze de uma vez").
//
// A causa do pulo não é lentidão nossa: o CLI entrega o texto em RAJADAS
// (um delta traz uma palavra, o seguinte traz um parágrafo) e o chat pintava
// cada rajada inteira de uma vez. Aqui o buffer que chega é a FILA e a tela
// consome dela em ritmo próprio, palavra a palavra.
//
// Duas regras que fazem parecer digitação de verdade:
//  1. cadência por PALAVRA, não por caractere — caractere a caractere fica
//     lento e nervoso num texto longo;
//  2. o ritmo ACELERA com o tamanho da fila: quanto mais atrasado, mais
//     palavras por quadro. Sem isso uma resposta grande demoraria minutos
//     para terminar de aparecer depois de o agente já ter acabado.
//
// `prefers-reduced-motion` desliga tudo: quem pediu menos movimento vê o
// texto completo na hora.

/** Alvo de atraso: com a fila acima disso o revelador acelera para alcançar. */
const TARGET_LAG_MS = 900
/** Ritmo base de uma conversa tranquila. */
const BASE_WORD_MS = 34

/** Fim da próxima palavra a partir de `from` (espaço que a sucede incluso —
 *  revelar a palavra sem o espaço faria o texto "grudar" no quadro seguinte). */
function nextWordEnd(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/u.test(text[i])) i += 1
  while (i < text.length && !/\s/u.test(text[i])) i += 1
  return i
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    : false
}

export default function GuiStreamText({ text }: { text: string }): React.JSX.Element {
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const textRef = useRef(text)
  textRef.current = text

  // Turno novo (o buffer encolheu porque o anterior fechou): recomeça do zero
  // em vez de manter um cursor que aponta para fora do texto atual.
  if (shownRef.current > text.length) {
    shownRef.current = 0
  }

  useEffect(() => {
    if (prefersReducedMotion()) {
      shownRef.current = textRef.current.length
      setShown(shownRef.current)
      return
    }
    let frame = 0
    let last = performance.now()
    let credit = 0

    const tick = (now: number): void => {
      const full = textRef.current
      const elapsed = now - last
      last = now
      const pending = full.length - shownRef.current
      if (pending <= 0) {
        // Nada na fila: segue armado — o próximo delta cai no mesmo laço.
        frame = requestAnimationFrame(tick)
        return
      }
      // Quanto mais texto esperando, mais rápido cada palavra sai. O divisor é
      // o atraso que aceitamos; abaixo dele o ritmo é o base.
      const speed = Math.max(1, pending / ((TARGET_LAG_MS / BASE_WORD_MS) * 5))
      credit += (elapsed / BASE_WORD_MS) * speed
      let words = Math.floor(credit)
      if (words > 0) {
        credit -= words
        let cursor = shownRef.current
        while (words > 0 && cursor < full.length) {
          cursor = nextWordEnd(full, cursor)
          words -= 1
        }
        shownRef.current = cursor
        setShown(cursor)
      }
      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  const visible = text.slice(0, Math.min(shown, text.length))
  return (
    <div className="gui-msg dev stream">
      <div className="gui-msg-text">
        <GuiMarkdown text={visible} />
        <span className="stream-cursor" aria-hidden="true">
          ▍
        </span>
      </div>
    </div>
  )
}

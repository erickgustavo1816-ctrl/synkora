import { useEffect, useRef, useState } from 'react'
import GuiMarkdown from './GuiMarkdown'
import { GUI_WORD_REVEAL_MS, nextGuiWordEnd } from '../guiStreamReveal'

// A RESPOSTA APARECE COMO SE FOSSE DIGITADA (ordem do dono, 2026-08-13:
// "tá pulando de uma palavra pra dez, aí pula quinze de uma vez").
//
// A causa do pulo não é lentidão nossa: o CLI entrega o texto em RAJADAS
// (um delta traz uma palavra, o seguinte traz um parágrafo) e o chat pintava
// cada rajada inteira de uma vez. Aqui o buffer que chega é a FILA e a tela
// consome dela em ritmo próprio, palavra a palavra.
//
// A regra que não pode regredir: CADA passo revela UMA palavra. A versão
// anterior acelerava pelo número de CARACTERES pendentes e gastava o crédito
// em PALAVRAS; uma rajada de 2.000 caracteres pintava 10-15 palavras no mesmo
// quadro. O transporte pode chegar em rajadas, a leitura nunca chega.
//
// `prefers-reduced-motion` desliga tudo: quem pediu menos movimento vê o
// texto completo na hora.

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    : false
}

export default function GuiStreamText({
  paneId,
  text,
  initialShown = 0,
  complete,
  onComplete,
  onProgress
}: {
  paneId: string
  text: string
  initialShown?: number
  complete: boolean
  onComplete?: () => void
  onProgress?: () => void
}): React.JSX.Element {
  const [shown, setShown] = useState(() => Math.min(initialShown, text.length))
  const textRef = useRef(text)
  const completedRef = useRef(false)
  const reducedMotionRef = useRef(prefersReducedMotion())
  const onCompleteRef = useRef(onComplete)
  const onProgressRef = useRef(onProgress)
  textRef.current = text
  onCompleteRef.current = onComplete
  onProgressRef.current = onProgress

  // O cursor acompanha correções do texto final e o ponto de replay, mas nunca
  // volta durante um item vivo. Cada turno tem id/key próprio no pai.
  useEffect(() => {
    setShown((current) =>
      reducedMotionRef.current
        ? text.length
        : Math.min(text.length, Math.max(current, initialShown))
    )
  }, [initialShown, text.length])

  // Relógio ESTÁVEL: deltas podem chegar a cada 10 ms. Se o timer dependesse
  // de `text`, cada rajada cancelaria e rearmaria os 52 ms, congelando a tela
  // até o transporte parar. O ref recebe a fila nova sem reiniciar a cadência.
  useEffect(() => {
    if (reducedMotionRef.current) return
    const timer = window.setInterval(() => {
      setShown((current) => nextGuiWordEnd(textRef.current, current))
    }, GUI_WORD_REVEAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    onProgressRef.current?.()
    if (!complete || shown < text.length || completedRef.current) return
    completedRef.current = true
    onCompleteRef.current?.()
  }, [complete, shown, text.length])

  const visible = text.slice(0, Math.min(shown, text.length))
  return (
    <div className="gui-msg dev stream">
      <div className="gui-msg-text">
        <GuiMarkdown paneId={paneId} text={visible} />
        {(!complete || shown < text.length) && (
          <span className="stream-cursor" aria-hidden="true">
            ▍
          </span>
        )}
      </div>
    </div>
  )
}

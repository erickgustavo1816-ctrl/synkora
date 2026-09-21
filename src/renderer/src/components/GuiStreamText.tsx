import { useCallback, useEffect, useRef, useState } from 'react'
import GuiMarkdown from './GuiMarkdown'
import GuiMessageCopy from './GuiMessageCopy'
import {
  GUI_REVEAL_FADE_MS,
  GUI_REVEAL_KEEP_STEPS,
  GUI_WRITING_PACE_DEFAULT,
  guiRevealTickMs,
  guiRevealWordsThisTick,
  nextGuiRevealShown,
  type GuiRevealStep,
  type GuiWritingPace
} from '../guiStreamReveal'
import { clearGuiRevealPaint, paintGuiRevealTail } from '../guiRevealPaint'

// A FALA DO AGENTE, do primeiro delta à mensagem parada — UM componente, UM
// container (mockup aprovado em 2026-09-21, docs/mockups/chat-writer-2026-09-21.html).
//
// O que mudou em relação ao revelador anterior:
// - O container é o MESMO do início ao fim: `.gui-msg.dev` ganha `stream`
//   enquanto escreve e perde ao terminar. Antes o pai trocava o container de
//   streaming pelo final, e o `rise` do `.gui-msg` tocava de novo (o "pisca"
//   do vídeo do dono).
// - A cadência é ADAPTATIVA (guiStreamReveal.ts): base em palavras/segundo
//   (Ajustes › Aparência › Escrita do chat), passo maior quando o atraso passa
//   do teto, drenagem em 600 ms quando o texto já está completo. Continua
//   revelando palavras INTEIRAS — a régua que não pode regredir.
// - A cauda é pintada DEPOIS do patch de prefixo estável do markdown
//   (guiRevealPaint.ts): as últimas palavras assentam com fade e o caret fica
//   no fim do texto, dentro do último bloco.
// - O pai sabe quando este escritor tem trabalho pendente (`onBusy`): é isso que
//   segura o que vem depois dele no fio — UM escritor por conversa.
//
// `prefers-reduced-motion` (ou velocidade 0) desliga tudo: texto completo na
// hora, sem fade, sem caret.

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
  pace = GUI_WRITING_PACE_DEFAULT,
  showCopy = false,
  onComplete,
  onProgress,
  onBusy
}: {
  paneId: string
  text: string
  initialShown?: number
  complete: boolean
  pace?: GuiWritingPace
  showCopy?: boolean
  onComplete?: () => void
  onProgress?: () => void
  onBusy?: (busy: boolean) => void
}): React.JSX.Element {
  const instant = pace.wordsPerSecond <= 0 || prefersReducedMotion()
  const [shown, setShown] = useState(() => (instant ? text.length : Math.min(initialShown, text.length)))
  const shownRef = useRef(shown)
  const textRef = useRef(text)
  const completeRef = useRef(complete)
  const paceRef = useRef(pace)
  const instantRef = useRef(instant)
  const historyRef = useRef<GuiRevealStep[]>([])
  const completedRef = useRef(false)
  const busyRef = useRef(false)
  const containerRef = useRef<HTMLElement | null>(null)
  const onCompleteRef = useRef(onComplete)
  const onProgressRef = useRef(onProgress)
  const onBusyRef = useRef(onBusy)
  textRef.current = text
  completeRef.current = complete
  paceRef.current = pace
  instantRef.current = instant
  onCompleteRef.current = onComplete
  onProgressRef.current = onProgress
  onBusyRef.current = onBusy

  const revealing = shown < text.length || !complete
  const tickMs = guiRevealTickMs(pace)

  // O cursor acompanha correções do texto final e o ponto de replay, mas nunca
  // volta durante um item vivo. Cada turno tem id/key próprio no pai.
  useEffect(() => {
    setShown((current) => {
      const next = instantRef.current
        ? text.length
        : Math.min(text.length, Math.max(current, initialShown))
      shownRef.current = next
      return next
    })
  }, [initialShown, text.length])

  // Relógio ESTÁVEL: deltas podem chegar a cada 10 ms. O intervalo só depende
  // da cadência escolhida — nunca de `text` — senão cada rajada cancelaria e
  // rearmaria o tique, congelando a tela até o transporte parar. A fila nova
  // chega pelo ref; o passo (quantas palavras) é decidido a cada tique.
  useEffect(() => {
    if (instantRef.current) return
    const timer = window.setInterval(() => {
      const current = shownRef.current
      const words = guiRevealWordsThisTick(textRef.current, current, completeRef.current, paceRef.current, tickMs)
      if (words === 0) return
      const next = nextGuiRevealShown(textRef.current, current, words)
      if (next === current) return
      historyRef.current.push({ words, at: performance.now() })
      if (historyRef.current.length > GUI_REVEAL_KEEP_STEPS) {
        historyRef.current.splice(0, historyRef.current.length - GUI_REVEAL_KEEP_STEPS)
      }
      shownRef.current = next
      setShown(next)
    }, tickMs)
    return () => window.clearInterval(timer)
  }, [tickMs])

  // O pai enxerga o trabalho pendente: busy = ainda há texto recebido e não
  // mostrado. Só transições publicam, e a desmontagem sempre solta.
  useEffect(() => {
    const busy = shown < text.length
    if (busy !== busyRef.current) {
      busyRef.current = busy
      onBusyRef.current?.(busy)
    }
  }, [shown, text.length])
  useEffect(
    () => () => {
      if (busyRef.current) {
        busyRef.current = false
        onBusyRef.current?.(false)
      }
    },
    []
  )

  useEffect(() => {
    onProgressRef.current?.()
    if (!complete || shown < text.length || completedRef.current) return
    completedRef.current = true
    onCompleteRef.current?.()
  }, [complete, shown, text.length])

  // Fim da revelação: o fade dos últimos passos termina e a pintura é desfeita —
  // o DOM volta a ser exatamente o que o pipeline do markdown produz.
  useEffect(() => {
    if (revealing || instant) return
    const timer = window.setTimeout(() => {
      const container = containerRef.current
      if (container) clearGuiRevealPaint(container)
    }, GUI_REVEAL_FADE_MS + 40)
    return () => window.clearTimeout(timer)
  }, [revealing, instant])

  const onPainted = useCallback(
    (container: HTMLElement) => {
      containerRef.current = container
      if (instantRef.current) return
      const stillRevealing = shownRef.current < textRef.current.length || !completeRef.current
      paintGuiRevealTail(container, historyRef.current, {
        caret: stillRevealing,
        fade: paceRef.current.fade
      })
    },
    []
  )

  const visible = text.slice(0, Math.min(shown, text.length))
  return (
    <div className={`gui-msg dev${revealing ? ' stream' : ''}`}>
      <div className="gui-msg-text">
        <GuiMarkdown paneId={paneId} text={visible} onPainted={onPainted} />
      </div>
      {showCopy && !revealing && text.trim() && <GuiMessageCopy markdown={text} />}
    </div>
  )
}

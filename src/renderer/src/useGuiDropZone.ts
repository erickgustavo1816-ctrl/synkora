import { useEffect, useState, type RefObject } from 'react'
import { GuiDropTracker, dragTransferHasFiles, type GuiDropPhase } from './guiDropZone'

/** Liga a máquina de `guiDropZone` aos eventos de arrasto da JANELA inteira:
 *  o dono precisa ver ONDE soltar assim que o arrasto entra no app, não só
 *  quando já está em cima do pane. `enabled` desliga tudo (pane inativo,
 *  fotografia congelada, composer sem como anexar) e devolve o repouso na
 *  hora. Os listeners são passivos de propósito: quem aceita o drop
 *  (preventDefault + dropEffect) é a raiz do pane, e o `main.tsx` já barra a
 *  navegação para file:// fora dela. */
export function useGuiDropZone(paneRef: RefObject<HTMLElement | null>, enabled: boolean): GuiDropPhase {
  const [phase, setPhase] = useState<GuiDropPhase>('idle')

  useEffect(() => {
    if (!enabled) {
      setPhase('idle')
      return
    }
    const tracker = new GuiDropTracker({
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      onChange: setPhase
    })
    const onDragOver = (event: DragEvent): void => {
      if (!dragTransferHasFiles(event.dataTransfer?.types)) return
      const pane = paneRef.current
      tracker.hover(Boolean(pane && event.target instanceof Node && pane.contains(event.target)))
    }
    // `relatedTarget` nulo = o arrasto saiu da janela (ou entrou numa view
    // nativa, como o browser embutido): apaga já, sem esperar o prazo.
    const onDragLeave = (event: DragEvent): void => {
      if (event.relatedTarget === null) tracker.settle()
    }
    const settle = (): void => tracker.settle()
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', settle)
    window.addEventListener('dragend', settle)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', settle)
      window.removeEventListener('dragend', settle)
      tracker.dispose()
    }
  }, [enabled, paneRef])

  return phase
}

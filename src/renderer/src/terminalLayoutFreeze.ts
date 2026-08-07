let holds = 0
let nativeResizeSubscribers = 0
let nativeResizeTimer: number | undefined
let releaseNativeResize: (() => void) | null = null

/** O resize da moldura nativa do Electron não gera pointerup no documento.
 *  Mantém todos os xterms congelados até a janela ficar quieta; sem isto uma
 *  pausa durante o arrasto ainda podia virar um SIGWINCH intermediário. */
const onNativeWindowResize = (): void => {
  if (!releaseNativeResize) releaseNativeResize = holdTerminalLayout()
  window.clearTimeout(nativeResizeTimer)
  nativeResizeTimer = window.setTimeout(() => {
    releaseNativeResize?.()
    releaseNativeResize = null
    nativeResizeTimer = undefined
  }, 650)
}

/** Suspende fits de xterm enquanto varias caixas intermediarias passam pelo DOM.
 *  Contagem (em vez de toggle simples) evita que uma animacao solte a trava de
 *  outro gesto que ainda esta em andamento. */
export function holdTerminalLayout(): () => void {
  holds += 1
  document.body.classList.add('stage-transition')
  let released = false
  return () => {
    if (released) return
    released = true
    holds = Math.max(0, holds - 1)
    if (holds === 0) document.body.classList.remove('stage-transition')
  }
}

export function freezeTerminalLayoutFor(ms: number): () => void {
  const release = holdTerminalLayout()
  const timer = window.setTimeout(release, ms)
  return () => {
    window.clearTimeout(timer)
    release()
  }
}

/** Instala um único listener global enquanto existir ao menos um TerminalPane. */
export function observeNativeWindowResize(): () => void {
  nativeResizeSubscribers += 1
  if (nativeResizeSubscribers === 1) window.addEventListener('resize', onNativeWindowResize)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    nativeResizeSubscribers = Math.max(0, nativeResizeSubscribers - 1)
    if (nativeResizeSubscribers > 0) return
    window.removeEventListener('resize', onNativeWindowResize)
    window.clearTimeout(nativeResizeTimer)
    nativeResizeTimer = undefined
    releaseNativeResize?.()
    releaseNativeResize = null
  }
}

import ReactDOM from 'react-dom/client'
import App from './App'
import PanesApp from './PanesApp'
import SynVoiceOverlay from './components/SynVoiceOverlay'
import ProgressOverlay from './components/ProgressOverlay'
import TooltipLayer from './components/Tooltip'
import { installDevMock } from './devMock'
import './global.css'

const isSynVoiceOverlay =
  new URLSearchParams(window.location.search).get('view') === 'synvoice-overlay'
const isProgressOverlay =
  new URLSearchParams(window.location.search).get('view') === 'progress-overlay'
// Fase 3: o canvas de Panes roda numa WebContentsView própria — mesmo bundle,
// raiz diferente (o padrão dos overlays).
const isPanesView = new URLSearchParams(window.location.search).get('view') === 'panes'

if (isSynVoiceOverlay) {
  document.documentElement.classList.add('synvoice-overlay-page')
  document.body.classList.add('synvoice-overlay-page')
}
if (isProgressOverlay) {
  document.documentElement.classList.add('progress-overlay-page')
  document.body.classList.add('progress-overlay-page')
}
if (isPanesView) {
  document.documentElement.classList.add('panes-view-page')
  document.body.classList.add('panes-view-page')
}

// Drop de arquivo fora de um pane: sem isto o Chromium NAVEGA para file:// e
// derruba o renderer inteiro. Os panes tratam o próprio drop (listener no
// container do terminal); aqui só se bloqueia a navegação padrão.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

// Travada do RENDERER vira evento na caixa-preta (watchdog do event loop —
// caso real 04/08: congelamentos sem rastro). Overlays ficam de fora: janelas
// minúsculas com ciclo de vida próprio.
if (!isSynVoiceOverlay && !isProgressOverlay) {
  let stallLast = performance.now()
  setInterval(() => {
    const now = performance.now()
    const lag = now - stallLast - 1000
    stallLast = now
    if (lag > 1000) window.synkora.perf?.reportStall?.(Math.round(lag))
  }, 1000)
}

// Sem StrictMode: o double-mount de dev criaria/mataria PTYs em sequência,
// derrubando sessões reais de CLI a cada hot reload.
if (import.meta.env.DEV) installDevMock()

ReactDOM.createRoot(document.getElementById('root')!).render(
  isProgressOverlay ? (
    <ProgressOverlay />
  ) : isSynVoiceOverlay ? (
    <>
      <SynVoiceOverlay />
      <TooltipLayer />
    </>
  ) : isPanesView ? (
    <PanesApp />
  ) : (
    <App />
  )
)

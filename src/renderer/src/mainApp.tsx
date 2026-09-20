import ReactDOM from 'react-dom/client'
import App from './App'
import SynVoiceOverlay from './components/SynVoiceOverlay'
import ProgressOverlay from './components/ProgressOverlay'
import BrowserPopout from './components/BrowserPopout'
import TooltipLayer from './components/Tooltip'
import GuiPanelErrorBoundary from './components/GuiPanelErrorBoundary'
import { installDevMock } from './devMock'
import './global.css'

const query = new URLSearchParams(window.location.search)
const isSynVoiceOverlay = query.get('view') === 'synvoice-overlay'
const isProgressOverlay = query.get('view') === 'progress-overlay'
// A JANELA DESTACADA DO BROWSER (⧉, 2026-08-29): a única rota da casa que
// precisa saber DE QUEM ela é — a `WebContentsView` da missão é reparentada
// para dentro dela, e sem `missionId` não há página nenhuma para emoldurar. O
// `browserPopoutWindow.ts` carrega esta URL; o `trustedRendererView` do main é
// quem autoriza a query.
const isBrowserPopout = query.get('view') === 'browser-popout'
// A Fase 3 mantinha aqui uma terceira raiz `?view=panes` (o canvas de Panes,
// numa WebContentsView própria). Ela morreu na purga F6 (2026-08-17): sobrou
// a janela principal, os dois overlays e o pop-out do browser.

if (isSynVoiceOverlay) {
  document.documentElement.classList.add('synvoice-overlay-page')
  document.body.classList.add('synvoice-overlay-page')
}
if (isProgressOverlay) {
  document.documentElement.classList.add('progress-overlay-page')
  document.body.classList.add('progress-overlay-page')
}
// O pop-out NÃO ganha classe de rota no `body`: os dois overlays precisam dela
// porque as janelas deles são transparentes; esta é uma janela normal e a base
// do app (`html, body, #root { height: 100% }`) já entrega a tela inteira ao
// instrumento.
// Drop de arquivo fora de um pane: sem isto o Chromium NAVEGA para file:// e
// derruba o renderer inteiro. Os panes tratam o próprio drop (listener no
// container do terminal); aqui só se bloqueia a navegação padrão.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

// Travada do RENDERER vira evento na caixa-preta (watchdog do event loop —
// caso real 04/08: congelamentos sem rastro). Overlays ficam de fora: janelas
// minúsculas com ciclo de vida próprio. O pop-out do browser também: o `perf:*`
// é host-only no main (só a janela do app fala), e o relógio daqui bateria
// numa porta que recusa.
if (!isSynVoiceOverlay && !isProgressOverlay && !isBrowserPopout) {
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
  isBrowserPopout ? (
    /* SEM `TooltipLayer` de propósito: o tooltip da casa nasce 7px ABAIXO do que
       se aponta, e nesta janela tudo aponta para logo acima da página — a view
       nativa o engoliria. O chrome do browser já fala pela LINHA DO PÉ. */
    <GuiPanelErrorBoundary paneId="overlay:browser-popout" label="o browser destacado">
      <BrowserPopout
        missionId={query.get('missionId') ?? ''}
        projectId={query.get('projectId') ?? ''}
      />
    </GuiPanelErrorBoundary>
  ) : isProgressOverlay ? (
    <GuiPanelErrorBoundary paneId="overlay:progress" label="o painel de progresso">
      <ProgressOverlay />
    </GuiPanelErrorBoundary>
  ) : isSynVoiceOverlay ? (
    <>
      <GuiPanelErrorBoundary paneId="overlay:synvoice" label="o SynVoice">
        <SynVoiceOverlay />
      </GuiPanelErrorBoundary>
      <GuiPanelErrorBoundary paneId="overlay:tooltip" label="as dicas">
        <TooltipLayer />
      </GuiPanelErrorBoundary>
    </>
  ) : (
    <App />
  )
)

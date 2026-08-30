import { useCallback, useEffect, useRef, useState } from 'react'
import BrowserChrome, {
  BrowserPageBands,
  BrowserPageOverlay,
  browserApi,
  useBrowserHint,
  useBrowserRunner
} from './BrowserChrome'
import { useMissionBrowser } from './DockBrowser'
import {
  BROWSER_NO_API,
  browserRect,
  clipBrowserRect,
  createBrowserBoundsGate,
  createBrowserBoundsPump,
  rectHasArea,
  type BrowserEngineState
} from '../dockBrowserModel'
import type { BrowserPanelState, BrowserRect } from '../../../preload/index'

// A JANELA DESTACADA (fatia P2 do
// `.synkora/reports/DESIGN_BROWSER_POPOUT_2026-08-29.md`).
//
// "Tirar ele dali e desfixar, como o microfone que eu clico e ele sai — mas que
// ele saia com todas as funções, quase como se fosse um app à parte."
//
// Esta é a rota `?view=browser-popout&missionId=…&projectId=…`, montada pelo
// `main.tsx` numa `BrowserWindow` própria (P1: `src/main/browserPopoutWindow.ts`).
// A página é a MESMA `WebContentsView` que estava no dock — reparentada viva,
// sem recarregar — e ela compõe POR CIMA deste DOM, no retângulo que este
// componente reporta. Ou seja: aqui também **o renderer não desenha página
// nenhuma**; ele desenha o instrumento em volta dela e diz onde ela cabe.
//
// TRÊS DIFERENÇAS PARA O DOCK, e só três:
//  1. não há fração de coluna nem alça — **a JANELA é o controle de tamanho**;
//  2. o retângulo da página come toda a altura que sobra do instrumento;
//  3. a ação do host é o REENCAIXE (⇤), não o ⧉.
// Todo o resto (abas, setas, endereço, devtools, ⚡, barra de status) é o mesmo
// `BrowserChrome` do painel do dock — de propósito: é UM instrumento, e o dono
// não pode aprender dois.
//
// A MOLDURA DA JANELA É NATIVA (decisão declarada no relatório da P2): a janela
// da P1 nasce com `frame` padrão, e o preload não expõe verbo nenhum de
// minimizar/maximizar/fechar. Desenhar uma titlebar da casa aqui produziria uma
// SEGUNDA barra por baixo da real, com botões que não fariam nada — então o
// instrumento ocupa a janela inteira, de ponta a ponta, e quem carrega a
// identidade é o TÍTULO da janela ("«página» · «missão»", posto pelo main) mais
// o papel e a tipografia da casa. O X nativo já reencaixa (lei 3 da sonda).

/** Reconciliador da geometria — o mesmo relógio do dock (nenhum passo depende
 *  de entrega única). Aqui ele cobre o que nenhum observador vê: a janela
 *  restaurada de minimizada e a mudança de DPI ao atravessar monitores. */
const BOUNDS_RECONCILE_MS = 400

const ZERO_RECT: BrowserRect = { x: 0, y: 0, width: 0, height: 0 }

function viewportRect(): BrowserRect {
  return {
    x: 0,
    y: 0,
    width: Math.max(0, window.innerWidth),
    height: Math.max(0, window.innerHeight)
  }
}

/** O elemento está mesmo PINTANDO? (espelho do `DockBrowser`, e pela mesma
 *  razão: motor sem o método reporta VISÍVEL — melhor uma página a mais do que
 *  uma janela preta sem explicação.) */
function elementIsPainted(el: HTMLElement): boolean {
  if (typeof el.checkVisibility !== 'function') return true
  return el.checkVisibility({
    checkOpacity: true,
    checkVisibilityCSS: true,
    contentVisibilityAuto: true,
    opacityProperty: true,
    visibilityProperty: true
  })
}

/**
 * O HOST DE JANELA, sem nenhuma leitura de estado — é esta metade que o harness
 * renderiza com o CSS real para se OLHAR a tela (e é por isso que ela recebe a
 * fotografia por prop em vez de ir buscá-la).
 */
export function BrowserPopoutView({
  missionId,
  projectId,
  state,
  engine,
  error
}: {
  missionId: string
  projectId: string
  state: BrowserPanelState
  engine: BrowserEngineState
  /** falha de leitura do motor — a fotografia anterior FICA na tela */
  error: string | null
}): React.JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const { notice, setNotice, run } = useBrowserRunner()
  const { hint, hints } = useBrowserHint()
  const [painted, setPainted] = useState(false)

  // ————— GEOMETRIA: o único canal entre esta janela e a view nativa —————
  //
  // Espelho declarado do efeito de bounds do `DockBrowser` — e MAIS SIMPLES de
  // propósito: aqui não há trilho que role, não há ancestral que recorte e não
  // há overlay do host por cima (esta janela não monta o app, só o instrumento).
  // O único recorte é a própria janela.
  //
  // Ele não é opcional: sem relato, o motor põe a página na JANELA INTEIRA
  // (`applyPopoutLayout`, P1) — o que cobriria este chrome com a página.
  // O PORTÃO e a BOMBA são os MESMOS do dock (`dockBrowserModel`): um
  // instrumento copiado vira dois instrumentos na terceira correção.
  const gateRef = useRef(createBrowserBoundsGate())
  const lastRectRef = useRef<BrowserRect | null>(null)
  /** QUENTE: mede e relata AGORA (ver o bloco no efeito). */
  const measureRef = useRef<(() => void) | null>(null)

  const report = useCallback((mission: string, rect: BrowserRect, shown: boolean): void => {
    const api = browserApi()
    if (!api) return
    // Espelho do dock (H9): o `painted` só se mexe quando a visibilidade vira.
    const before = gateRef.current.last()
    if (!gateRef.current.accept(rect, shown)) return
    if (!before || before.visible !== shown) setPainted(shown)
    api.bounds(mission, rect, shown)
  }, [])

  useEffect(() => {
    const el = pageRef.current
    if (!el || !missionId) return
    const mission = missionId

    const measure = (): void => {
      const box = browserRect(el.getBoundingClientRect())
      lastRectRef.current = box
      const clipped = clipBrowserRect(box, [viewportRect()])
      if (!rectHasArea(clipped) || !elementIsPainted(el)) {
        report(mission, clipped, false)
        return
      }
      report(mission, clipped, true)
    }

    // GEOMETRIA QUENTE (H9) — a MESMA disciplina do dock, e pela mesma medida:
    // o `ResizeObserver` é entregue DEPOIS do layout do quadro, então um salto
    // de `requestAnimationFrame` na saída dele custa um quadro INTEIRO de
    // página atrás do gesto (2,01 → 1,03 quadros, medido em
    // `.synkora/reports/h9/probe-h9-fluidity.mjs`). Aqui o gesto é a moldura da
    // JANELA — arrastar o canto muda a caixa do retângulo, e é o observador de
    // tamanho que conta. O `resize` da janela e o relógio ficam FRIOS: eles são
    // entregues antes da fase de rAF, e ali o salto já custava zero.
    const pump = createBrowserBoundsPump({
      measure,
      requestFrame: (run) => window.requestAnimationFrame(run),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle)
    })
    const hot = (): void => pump.hot()
    const schedule = (): void => pump.cold()
    measureRef.current = hot

    measure()
    const sizes = new ResizeObserver(hot)
    sizes.observe(el)
    window.addEventListener('resize', schedule)
    const timer = window.setInterval(schedule, BOUNDS_RECONCILE_MS)

    return () => {
      measureRef.current = null
      window.clearInterval(timer)
      window.removeEventListener('resize', schedule)
      sizes.disconnect()
      pump.stop()
      // A SAÍDA DECLARADA, como no dock: se este cromo sair de cena com a janela
      // ainda de pé (um limite de painel que pegou uma exceção, um remonte),
      // a página some em vez de ficar cobrindo uma tela quebrada. Ela continua
      // ANEXADA e capturável — esconder nunca é desanexar (lei 1).
      //
      // SEM guarda de host aqui, ao contrário do dock: no reencaixe a janela é
      // DESTRUÍDA, e renderer destruído não roda faxina de efeito nenhuma — não
      // há relato atrasado para calar. O único caminho que chega aqui é aquele
      // em que relatar é a coisa certa.
      browserApi()?.bounds(mission, lastRectRef.current ?? ZERO_RECT, false)
      gateRef.current.reset()
      lastRectRef.current = null
    }
  }, [missionId, report])

  // A tira de abas ganha/perde uma linha e EMPURRA o retângulo sem mudar o
  // tamanho dele — nenhum observador de tamanho enxerga isso.
  useEffect(() => {
    gateRef.current.reset()
    measureRef.current?.()
  }, [state.alive, state.tabs.length])

  const openBrowser = useCallback((): void => {
    run((api) => api.newTab(missionId))
    urlRef.current?.focus()
  }, [missionId, run])

  // Janela sem missão na URL: não existe gesto possível, e um instrumento
  // desenhado por cima de nada seria pior que a verdade. A frase nomeia a
  // receita (a casa não deixa beco sem saída).
  if (!missionId) {
    return (
      <div className="dock-browser browser-popout is-lost">
        <span className="dock-browser-notice">
          // esta janela abriu sem missão — feche-a e destaque de novo pelo ⧉ do dock
        </span>
      </div>
    )
  }

  if (engine === 'missing') {
    return (
      <div className="dock-browser browser-popout is-lost">
        <span className="dock-browser-notice">// {BROWSER_NO_API}</span>
      </div>
    )
  }

  return (
    <div className="dock-browser browser-popout">
      <BrowserChrome
        missionId={missionId}
        projectId={projectId}
        state={state}
        hint={hint}
        hints={hints}
        run={run}
        notify={setNotice}
        urlRef={urlRef}
        shellClass="browser-popout-shell"
        actions={
          /* ⇤ REENCAIXAR — a porta de volta, no fim da barra (é ação da JANELA,
             não da navegação). O X nativo faz o mesmo (o `close` da janela
             reencaixa antes de destruir, lei 3 da sonda); este botão existe
             porque "fechar para trazer de volta" não se adivinha. */
          <button
            type="button"
            className="dock-browser-btn dock-browser-dock-act"
            aria-label="reencaixar o browser no painel do dock"
            onClick={() => run((api) => api.dockBack(missionId))}
            {...hints('a página volta para o painel do dock e esta janela fecha')}
          >
            ⇤ reencaixar
          </button>
        }
      >
        {/* O RETÂNGULO. Vazio por contrato (a view nativa compõe por cima) e,
            aqui, ELÁSTICO: ele come toda a altura que sobra da janela — não há
            fração nem alça, porque quem redimensiona é a moldura da janela. */}
        <div
          ref={pageRef}
          className={`dock-browser-page browser-popout-page${state.alive ? ' live' : ''}`}
        >
          {/* As faixas da MOLDURA DE DISPOSITIVO. É AQUI que elas contam mais: a
              janela destacada é larga, e é nela que o dono viu o botão 375
              esticar o site (a receita antiga ampliava 3,73×). Agora a página
              fica em 375px reais no meio da janela, com o app dos dois lados. */}
          <BrowserPageBands state={state} painted={painted} />
          <BrowserPageOverlay
            state={state}
            painted={painted}
            hints={hints}
            onOpen={openBrowser}
            hiddenText="a página continua aberta — escondida enquanto esta janela não tem onde mostrá-la"
          />
        </div>
      </BrowserChrome>

      {state.notice && <span className="dock-browser-notice">// {state.notice.text}</span>}
      {error && <span className="dock-browser-notice stale">// {error}</span>}
      {notice && <span className="dock-browser-notice">// {notice}</span>}
    </div>
  )
}

/**
 * A rota. Lê a fotografia do motor pelo MESMO hook do dock (`useMissionBrowser`,
 * que já trata `browser:changed`, leitura atrasada e falha de leitura) — a
 * janela destacada é uma view do APP, com o preload inteiro, e fala com
 * `api.browser` igual ao painel. Todo IPC irmão é recusado pelo porteiro
 * host-only do main (P1 §5), e é por isso que não há nada de projeto, seat ou
 * chat nesta tela.
 */
export default function BrowserPopout({
  missionId,
  projectId
}: {
  missionId: string
  projectId: string
}): React.JSX.Element {
  const { state, engine, error } = useMissionBrowser(missionId)
  return (
    <BrowserPopoutView
      missionId={missionId}
      projectId={projectId}
      state={state}
      engine={engine}
      error={error}
    />
  )
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { useStore } from '../store'
import BrowserChrome, {
  BrowserPageBands,
  BrowserPageOverlay,
  browserApi,
  useBrowserHint,
  useBrowserRunner
} from './BrowserChrome'
import {
  BROWSER_NO_API,
  BROWSER_PAGE_KEYBOARD_STEP,
  EMPTY_BROWSER_PANEL,
  activeBrowserTab,
  browserIsPopout,
  browserPageFraction,
  browserPageHeight,
  browserPageRange,
  browserPageStorageKey,
  browserRect,
  browserSectionSummary,
  browserSiblingsToWatch,
  browserTabLabel,
  clipBrowserRect,
  createBrowserBoundsGate,
  createBrowserBoundsPump,
  isHostOverlayNode,
  normalizeBrowserPanel,
  overlayHidesPage,
  readBrowserPageFraction,
  rectHasArea,
  stepBrowserPageFraction,
  writeBrowserPageFraction,
  type BrowserEngineState
} from '../dockBrowserModel'
import type { BrowserPanelState, BrowserRect } from '../../../preload/index'

// O PAINEL DE BROWSER DO DOCK (H3 do design de 2026-08-29).
//
// A regra que explica todo o resto deste arquivo: **o renderer não desenha
// página nenhuma**. A `WebContentsView` do main compõe POR CIMA do DOM, e o que
// existe aqui é o CHROME (`BrowserChrome.tsx`, comum aos dois hosts) mais um
// RETÂNGULO VAZIO que serve de medida. O componente tem, portanto, duas
// obrigações:
//
//  1. contar a verdade do motor (abas, carregando, ⚡ agente dirigindo);
//  2. REPORTAR, sempre, onde a página cabe e se ela está à vista.
//
// A (2) é a mais importante e a menos óbvia. Esconder é `visible:false` — nunca
// desmontar esperando que o main perceba (lei 1 do design: desanexar pendura a
// captura por 5-8s e mata o rAF da página). Colapsar a seção DESMONTA este
// componente, e por isso o efeito de geometria reporta `visible:false` na
// própria faxina: a saída é declarada, não deduzida.
//
// O QUE FICOU AQUI DEPOIS DO ⧉ (P2 do pop-out, 2026-08-29): só o que é do DOCK
// — a fração da coluna, a alça, a medida contra o trilho, o relato de geometria
// e o RECIBO de quando a página está destacada. Abas, barra e linha do pé
// moraram neste arquivo até hoje e agora são do `BrowserChrome`, porque a janela
// destacada usa exatamente as mesmas (e um instrumento copiado vira dois
// instrumentos na terceira correção).
//
// Par declarado: `src/preload/index.ts` (api.browser) ↔ `src/main/ipc/browser.ts`.

/** Reconciliador da geometria (doutrina da casa: nenhum passo depende de
 *  entrega única). Os observadores cobrem tudo que MEXE; este relógio cobre o
 *  que ninguém observou — um ancestral que mudou de lugar sem mudar de
 *  tamanho. Só corre com o painel montado.
 *
 *  A REDE FICA (lei da casa: nenhum passo depende de entrega única). O que a
 *  H9 mudou não foi a rede: foi parar de PENDURAR nela o que já tinha
 *  observador — ver o bloco "GEOMETRIA QUENTE" lá embaixo. */
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

/**
 * Ancestrais que RECORTAM (o dock tem `overflow: hidden`, o trilho rola). A
 * lista é calculada uma vez por montagem: a árvore acima do painel não muda
 * enquanto ele vive, e `getComputedStyle` por quadro seria caro à toa.
 */
function clipAncestors(el: HTMLElement): HTMLElement[] {
  const clips: HTMLElement[] = []
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    if (
      style.overflowX !== 'visible' ||
      style.overflowY !== 'visible' ||
      style.clipPath !== 'none'
    ) {
      clips.push(node)
    }
    node = node.parentElement
  }
  return clips
}

/**
 * O TRILHO que a página divide com as seções irmãs: o primeiro ancestral que
 * ROLA (`.right-rail-content`). É a caixa DELE que manda na altura da página.
 *
 * Por que não o `.delivery-rail`, que é o dock inteiro: ele CRESCE com o
 * conteúdo. Medir a página contra ele seria medir a página contra si mesma —
 * mais altura, dock mais alto, mais altura ainda. O scroller, ao contrário, tem
 * altura DEFINIDA pelo palco (`flex: 1 1 auto` com `min-height: 0`) e não se
 * mexe quando o conteúdo cresce: é a única régua estável da coluna.
 */
function railViewportOf(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    const flow = `${style.overflowY} ${style.overflowX}`
    if (flow.includes('auto') || flow.includes('scroll')) return node
    node = node.parentElement
  }
  return null
}

/** A altura da régua AGORA. Sem scroller acima (harness, modo legado, layout
 *  futuro) ou com ele medindo zero — o trilho recolhido mede zero —, a régua é
 *  a JANELA: uma medida grande demais ainda passa pelo clamp, uma medida zero
 *  apagaria a página. */
function railHeightOf(rail: HTMLElement | null): number {
  const measured = rail?.clientHeight ?? 0
  if (measured > 0) return measured
  return typeof window === 'undefined' ? 0 : window.innerHeight
}

/** O elemento está mesmo PINTANDO? `checkVisibility` responde pelos quatro
 *  esconderijos que o app usa (display, visibility, content-visibility e o
 *  `opacity: 0` do trilho recolhido) — e as duas grafias de opção vão juntas
 *  porque a antiga e a nova convivem entre versões do Chromium. Motor sem o
 *  método reporta VISÍVEL: melhor uma página a mais do que um painel que some
 *  sem ninguém saber por quê. */
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

/** Overlays do host abertos agora (portais irmãos da raiz do app). O porquê e
 *  o que fica de fora estão no bloco de comentários de `dockBrowserModel.ts`:
 *  é a versão leve e fiel do `hostOverlayCount` da era da ilha de panes. */
function hostOverlayRects(): BrowserRect[] {
  const rects: BrowserRect[] = []
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (!isHostOverlayNode({ id: child.id, role: child.getAttribute('role') })) continue
    rects.push(browserRect(child.getBoundingClientRect()))
  }
  return rects
}

export interface MissionBrowser {
  state: BrowserPanelState
  engine: BrowserEngineState
  /** falha de leitura do motor — a fotografia anterior FICA na tela */
  error: string | null
  summary: string
  refresh: () => void
}

/**
 * A assinatura do browser de UMA missão. Mora no TRILHO (não neste painel) de
 * propósito: com a seção recolhida o painel desmonta, e o resumo da seção —
 * "⚡ carregando…", "3 abas", "fechado" — precisa continuar verdadeiro.
 */
export function useMissionBrowser(missionId: string): MissionBrowser {
  const state = useStore((s) => s.browserByMission[missionId] ?? EMPTY_BROWSER_PANEL)
  const setMissionBrowser = useStore((s) => s.setMissionBrowser)
  const [engine, setEngine] = useState<BrowserEngineState>(() =>
    browserApi() ? 'ready' : 'missing'
  )
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    const api = browserApi()
    if (!api) {
      setEngine('missing')
      return
    }
    setEngine('ready')
    void api
      .state(missionId)
      .then((raw) => {
        setError(null)
        // A resposta é gravada na CHAVE da missão que a pediu: uma leitura
        // atrasada nunca pinta o browser da missão que o dono abriu depois.
        setMissionBrowser(missionId, normalizeBrowserPanel(raw))
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message.trim() : ''
        setError(detail ? `não deu para ler o browser: ${detail}` : 'não deu para ler o browser')
      })
  }, [missionId, setMissionBrowser])

  useEffect(() => {
    refresh()
    const api = browserApi()
    if (!api) return
    return api.onChanged((changed) => {
      if (changed === missionId) refresh()
    })
  }, [missionId, refresh])

  const summary = useMemo(() => browserSectionSummary(state, engine), [state, engine])
  return { state, engine, error, summary, refresh }
}

export default function DockBrowser({
  missionId,
  projectId,
  state,
  engine,
  error,
  visible
}: {
  missionId: string
  /** A SESSÃO (cookies/logins) é do PROJETO — é o que a linha do pé conta. */
  projectId: string
  state: BrowserPanelState
  engine: BrowserEngineState
  error: string | null
  /** o trilho está à vista? (o Board mantém o dock montado fora da aba) */
  visible: boolean
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  // A página desta missão saiu para uma JANELA PRÓPRIA (⧉). Aqui isso muda
  // TUDO: o dock não desenha retângulo, não desenha alça e — a parte que não é
  // óbvia — PARA de relatar geometria (ver o efeito de bounds).
  const popout = browserIsPopout(state)

  // Recado do motor para o gesto que o dono acabou de fazer (recusa do teto,
  // missão sem worktree…) e a barra de status do chrome: os dois hosts do
  // browser usam os mesmos hooks, e é o host quem tem onde mostrar.
  const { notice, setNotice, run } = useBrowserRunner()
  const { hint, hints } = useBrowserHint()
  // O que a MEDIDA concluiu: com a página escondida (overlay do host por cima,
  // seção fora de vista) o retângulo vira superfície falante em vez de um
  // buraco escuro sem explicação.
  const [painted, setPainted] = useState(false)

  // ————— ALTURA DA PÁGINA: a fatia do trilho que o dono escolheu —————
  //
  // A altura era um `clamp()` do CSS com teto de 460px — travada, sem gesto e
  // sem adaptação (a reprovação de 2026-08-29). Agora ela é uma FRAÇÃO do
  // trilho, guardada por PROJETO: encolher a janela reescala a página junto, e
  // a alça do pé ajusta a fatia. As contas moram todas no modelo puro.
  const pageKey = useMemo(() => browserPageStorageKey(projectId), [projectId])
  const [fraction, setFraction] = useState(() =>
    readBrowserPageFraction(typeof window === 'undefined' ? null : window.localStorage, pageKey)
  )
  // A régua nasce na JANELA e é corrigida pela medida real no primeiro layout:
  // zero aqui pintaria uma página de altura nenhuma no primeiro quadro.
  const [railHeight, setRailHeight] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight
  )
  const [dragging, setDragging] = useState(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  // A BANDEIRA DO GESTO (H9). O `dragging` de estado serve à CLASSE do CSS; o
  // ref serve à MECÂNICA, e por isso ele existe: ele vira `true` no
  // `pointerdown` e `false` na faxina — SÍNCRONO, sem esperar um render. É ele
  // que sustenta a regra do arrasto: **enquanto o gesto dura, quem escreve a
  // altura no nó é o gesto, e mais ninguém.** Sem isso, uma medição do trilho
  // caindo no meio do arrasto re-renderiza o React, que reescreve
  // `--dock-browser-page-h` a partir da FRAÇÃO velha — e a página pula para a
  // altura de antes por um quadro, no meio do gesto.
  const gestureRef = useRef(false)

  // ————— GEOMETRIA: o único canal entre este painel e a view nativa —————
  //
  // As alavancas moram AQUI EM CIMA (e não junto do efeito, como até a H8)
  // porque o gesto da alça precisa delas na SOLTA: a `forceReport` fecha o
  // arrasto, e ela é declarada antes de quem a chama.
  const gateRef = useRef(createBrowserBoundsGate())
  const lastRectRef = useRef<BrowserRect | null>(null)
  /** QUENTE: mede e relata AGORA, no quadro de quem chamou. */
  const measureRef = useRef<(() => void) | null>(null)
  /** Esquece o último relato e relata de novo NA HORA. Existe para os três
   *  casos em que o retângulo não mudou mas a VERDADE mudou: a view acabou de
   *  nascer, o painel voltou à vista, e a solta da alça (ver a faxina do
   *  gesto). */
  const forceReport = useCallback((): void => {
    gateRef.current.reset()
    measureRef.current?.()
  }, [])

  // O scroller é achado UMA vez por montagem (a árvore acima do painel não muda
  // enquanto ele vive) e relido a cada quadro do arrasto — subir a árvore com
  // `getComputedStyle` sessenta vezes por segundo seria pagar caro por um dado
  // que não muda.
  const railRef = useRef<HTMLElement | null>(null)
  const currentRailHeight = useCallback((): number => railHeightOf(railRef.current), [])
  // O RESTO do trilho, medido de verdade (bug pago 2026-08-29: "aumento o
  // tamanho aí some e não tem mais como diminuir" — o floor de chute deixava a
  // página crescer além da viewport e a alça sumia atrás da view nativa, que
  // come o wheel).
  //
  // SEGUNDO BUG PAGO NO MESMO DIA ("quando eu entro tá diminuindo sozinho do
  // nada"): a 1ª medição usava `scrollHeight - página`, e `scrollHeight` NUNCA
  // fica menor que o clientHeight — com o conteúdo CABENDO no trilho, o vazio
  // embaixo entrava no "resto", o teto colapsava para a altura atual menos o
  // respiro, e o clamp encolhia a página 2px por tick de 400ms, para sempre.
  // A medição honesta soma o CONTEÚDO REAL (filhos + gaps + paddings do
  // scroller) e subtrai a página: vazio não é irmã, e não reserva teto.
  // Os 2px são o respiro do arredondamento sub-pixel a 125% de DPI (lição da
  // casa). `undefined` quando ainda não há o que medir — o modelo cai no
  // floor de sempre.
  const currentRailRest = useCallback((): number | undefined => {
    const rail = railRef.current
    const page = pageRef.current
    if (!rail || !page || page.offsetHeight <= 0) return undefined
    let content = 0
    for (const child of Array.from(rail.children)) {
      if (child instanceof HTMLElement) content += child.offsetHeight
    }
    const style = window.getComputedStyle(rail)
    const gap = Number.parseFloat(style.rowGap) || 0
    content += gap * Math.max(0, rail.children.length - 1)
    content +=
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
    return Math.max(0, content - page.offsetHeight + 2)
  }, [])
  const [railRest, setRailRest] = useState<number | undefined>(undefined)
  /**
   * A RÉGUA, medida de novo: a altura do scroller e o palmo que as irmãs
   * ocupam nele. As duas juntas de propósito — quem congela, congela as duas, e
   * quem descongela precisa das duas de volta no mesmo passo.
   *
   * GESTO EM VOO: a régua fica CONGELADA (ver `gestureRef`). O arrasto já relê
   * a régua por quadro para a conta DELE; o que não pode acontecer é o React
   * redesenhar `--dock-browser-page-h` no meio do gesto a partir da FRAÇÃO
   * velha — a página pularia para a altura de antes por um quadro.
   */
  const measureRail = useCallback((): void => {
    if (gestureRef.current) return
    const height = railHeightOf(railRef.current)
    if (height > 0) setRailHeight((current) => (current === height ? current : height))
    const rest = currentRailRest()
    if (rest === undefined) return
    setRailRest((current) => (current !== undefined && Math.abs(current - rest) < 2 ? current : rest))
  }, [currentRailRest])

  const pageRange = browserPageRange(railHeight, { railRest })
  const pageHeight = browserPageHeight(fraction, railHeight, { railRest })
  // O componente publica a altura como VARIÁVEL no próprio nó: o CSS lê dela, e
  // o arrasto escreve nela direto (sem um render por quadro) — o arranjo pago
  // do `--right-rail-rendered-width`.
  const pageStyle = { '--dock-browser-page-h': `${pageHeight}px` } as CSSProperties

  // Trocar de projeto troca a preferência: o browser grande do universo em que
  // se faz QA não pode chegar herdado no universo em que só se escreve plano.
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    setFraction(readBrowserPageFraction(window.localStorage, pageKey))
  }, [pageKey])

  // A MEDIDA DO TRILHO. Um `ResizeObserver` no scroller (ele encolhe quando a
  // janela encolhe, quando o dono arrasta a largura, quando o palco muda) mais
  // o `resize` da janela para o caso de o observador não existir. Só grava
  // altura POSITIVA e DIFERENTE: o trilho recolhido mede zero, e aceitar esse
  // zero apagaria a página em vez de escondê-la.
  //
  // Quem mede é o `measureRail` lá de cima — o MESMO que a solta do gesto
  // chama, para que congelar e descongelar sejam a mesma conta.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const rail = railViewportOf(el)
    railRef.current = rail
    measureRail()
    const sizes = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureRail) : null
    if (sizes && rail) sizes.observe(rail)
    window.addEventListener('resize', measureRail)
    return () => {
      sizes?.disconnect()
      window.removeEventListener('resize', measureRail)
      // Um gesto em voo não sobrevive à desmontagem: a faxina fecha as portas e
      // GRAVA o que o dono já tinha arrastado. Ela roda antes de a régua ser
      // esquecida — a fração se calcula contra o trilho que o gesto usou.
      dragCleanupRef.current?.()
      dragCleanupRef.current = null
      railRef.current = null
    }
  }, [measureRail])

  const persistFraction = useCallback(
    (next: number): void => {
      setFraction(next)
      if (typeof window !== 'undefined') writeBrowserPageFraction(window.localStorage, pageKey, next)
    },
    [pageKey]
  )

  // ————— A ALÇA: o gesto que devolve a altura ao dono —————
  //
  // Mecânica de ponteiro da casa (`.right-rail-resizer` / `.maestro-resizer`):
  // captura no próprio nó, UM `requestAnimationFrame` por quadro, e uma faxina
  // que fecha todas as portas — soltar, cancelar, perder a captura, a janela
  // perder o foco. Gesto que não termina deixa o painel arrastando sozinho.
  //
  // Durante o arrasto a altura é escrita DIRETO na variável do nó: um render do
  // React por quadro não é preciso, e o `ResizeObserver` do retângulo já leva a
  // geometria nova para a view nativa no mesmo quadro.
  const onGripPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
      const root = rootRef.current
      if (!root) return
      dragCleanupRef.current?.()
      event.preventDefault()
      event.stopPropagation()
      const handle = event.currentTarget
      const pointerId = event.pointerId
      const startY = event.clientY
      // O resto é capturado no INÍCIO do gesto: as irmãs não mudam no meio de
      // um arrasto, e re-medi-lo por quadro leria a própria página mexendo.
      const railRestNow = currentRailRest()
      const startHeight = browserPageHeight(fraction, currentRailHeight(), {
        railRest: railRestNow
      })
      let nextHeight = startHeight
      let raf = 0
      let finished = false
      try {
        handle.setPointerCapture(pointerId)
      } catch {
        return
      }
      gestureRef.current = true
      setDragging(true)

      const paint = (): void => {
        raf = 0
        root.style.setProperty('--dock-browser-page-h', `${nextHeight}px`)
        // A alça é um separador com valor: quem arrasta pelo teclado/leitor de
        // tela ouve o número mudando, não só no fim do gesto.
        handle.setAttribute('aria-valuenow', String(nextHeight))
      }
      const onMove = (move: PointerEvent): void => {
        if (move.pointerId !== pointerId) return
        move.preventDefault()
        // A régua é relida a cada quadro: a janela pode mudar de tamanho no meio
        // do gesto, e a altura obedece ao trilho de AGORA.
        const range = browserPageRange(currentRailHeight(), { railRest: railRestNow })
        nextHeight = Math.round(
          Math.min(range.max, Math.max(range.min, startHeight + (move.clientY - startY)))
        )
        if (!raf) raf = window.requestAnimationFrame(paint)
      }
      const finish = (): void => {
        if (finished) return
        finished = true
        if (raf) window.cancelAnimationFrame(raf)
        // O último quadro pode ter sido cancelado no meio: a caixa e o valor
        // anunciado recebem o número FINAL aqui (se o React reencontrar a mesma
        // altura de antes do gesto, ele não reescreveria nem um nem outro).
        paint()
        // A SOLTA DEVOLVE A AUTORIDADE ao React (a bandeira cai ANTES de
        // `persistFraction`, senão a re-medição do trilho ficaria congelada até
        // o próximo evento). Daqui para a frente quem escreve a altura no nó é
        // o render, de novo.
        gestureRef.current = false
        setDragging(false)
        // A fração é a preferência DURÁVEL; o pixel do gesto é só o meio.
        persistFraction(
          browserPageFraction(nextHeight, currentRailHeight(), { railRest: railRestNow })
        )
        // …e a RÉGUA, congelada durante o gesto, volta a valer no mesmo passo.
        // Não é zelo: a janela pode ter mudado de tamanho e as irmãs podem ter
        // reflowado enquanto o dono arrastava, e as duas medidas ficariam
        // paradas até o próximo `resize` do trilho se ninguém as chamasse aqui.
        measureRail()
        // O DEDUPE ZERA NA SOLTA (H9). Ele compara com o ÚLTIMO retângulo
        // enviado; se o render pós-gesto reencontrar uma altura que já passou
        // no meio do arrasto — e ele reencontra, porque a fração reclampa
        // contra a régua nova —, o relato seria calado com o DOM já noutro
        // lugar, e a página nativa ficaria parada na altura do último quadro.
        // Um relato forçado fecha o gesto.
        forceReport()
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onCancel)
        handle.removeEventListener('lostpointercapture', onLostCapture)
        window.removeEventListener('blur', onCancel)
        if (handle.hasPointerCapture(pointerId)) {
          try {
            handle.releasePointerCapture(pointerId)
          } catch {
            // O browser pode ter liberado a captura antes da faxina.
          }
        }
        if (dragCleanupRef.current === finish) dragCleanupRef.current = null
      }
      const onUp = (up: PointerEvent): void => {
        if (up.pointerId === pointerId) finish()
      }
      const onCancel = (cancel?: Event): void => {
        if (cancel && 'pointerId' in cancel && (cancel as PointerEvent).pointerId !== pointerId) {
          return
        }
        finish()
      }
      const onLostCapture = (lost: PointerEvent): void => {
        if (lost.pointerId === pointerId) finish()
      }
      dragCleanupRef.current = finish
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onCancel)
      handle.addEventListener('lostpointercapture', onLostCapture)
      window.addEventListener('blur', onCancel)
    },
    [currentRailHeight, currentRailRest, forceReport, fraction, measureRail, persistFraction]
  )

  /** O MESMO ajuste pelo teclado: a casa não entrega controle só de mouse.
   *  ↓ cresce, ↑ encolhe (a alça desce quando a página cresce), Shift dobra o
   *  passo, Home/End vão às pontas que o trilho permite. */
  const onGripKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const rail = currentRailHeight()
      const opts = { railRest: currentRailRest() }
      const big = BROWSER_PAGE_KEYBOARD_STEP * 2
      let next: number | null = null
      switch (event.key) {
        case 'ArrowDown':
          next = stepBrowserPageFraction(
            fraction,
            'grow',
            rail,
            event.shiftKey ? big : undefined,
            opts
          )
          break
        case 'ArrowUp':
          next = stepBrowserPageFraction(
            fraction,
            'shrink',
            rail,
            event.shiftKey ? big : undefined,
            opts
          )
          break
        case 'Home':
          next = browserPageFraction(browserPageRange(rail, opts).min, rail, opts)
          break
        case 'End':
          next = browserPageFraction(browserPageRange(rail, opts).max, rail, opts)
          break
        default:
          return
      }
      // A tecla PARA aqui: seta que subisse viraria rolagem do dock, e Esc/setas
      // no chat têm outro dono.
      event.preventDefault()
      event.stopPropagation()
      persistFraction(next)
    },
    [currentRailHeight, currentRailRest, fraction, persistFraction]
  )

  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // ONDE a página está, lido pela FAXINA do efeito (que roda depois do render e
  // não enxerga a prop). Ver a saída declarada, lá embaixo.
  const popoutRef = useRef(popout)
  popoutRef.current = popout

  const report = useCallback((mission: string, rect: BrowserRect, shown: boolean): void => {
    const api = browserApi()
    if (!api) return
    // O `painted` só se mexe quando a VISIBILIDADE vira — e a guarda importa
    // porque este caminho passou a rodar sessenta vezes por segundo: um
    // `setState` por quadro no meio de um arrasto é despacho do React de graça.
    // (A semântica da bandeira não mudou: ela continua sendo exatamente o
    // `shown` que viajou no último relato.)
    const before = gateRef.current.last()
    if (!gateRef.current.accept(rect, shown)) return
    if (!before || before.visible !== shown) setPainted(shown)
    api.bounds(mission, rect, shown)
  }, [])

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    // A missão é capturada AQUI: a faxina deste efeito precisa esconder a view
    // da missão que ELE reportou, mesmo que o dono já tenha trocado de aba.
    const mission = missionId
    const clips = clipAncestors(el)

    const measure = (): void => {
      const box = browserRect(el.getBoundingClientRect())
      lastRectRef.current = box
      if (!visibleRef.current || !elementIsPainted(el)) {
        report(mission, box, false)
        return
      }
      const clipped = clipBrowserRect(box, [
        ...clips.map((node) => browserRect(node.getBoundingClientRect())),
        viewportRect()
      ])
      if (!rectHasArea(clipped)) {
        report(mission, clipped, false)
        return
      }
      // Overlay do host por cima: a view compõe ACIMA do DOM, então ela sai de
      // cena enquanto o modal/menu está aberto (o padrão pago do
      // hostOverlayCount, aqui lido pela estrutura).
      report(mission, clipped, !overlayHidesPage(clipped, hostOverlayRects()))
    }

    // ————— GEOMETRIA QUENTE (H9, 2026-08-29) —————
    //
    // A reprovação: *"deixa ele mais dinamico tbm, igual funciona o claude
    // code… to achando ele meio travado hoje."* A sonda
    // `.synkora/reports/h9/probe-h9-fluidity.mjs` mediu o caminho inteiro,
    // quadro a quadro, com janela de verdade — e o veredito é de RELÓGIO, não
    // de gosto:
    //
    //   arrasto da alça      2,01 quadros  →  1,03
    //   arrasto da largura   2,03 quadros  →  1,05
    //
    // O quadro perdido tinha UM dono: o salto de `requestAnimationFrame` na
    // saída do `ResizeObserver`. A ordem do quadro no Chromium explica tudo —
    // os callbacks de rAF correm ANTES do layout, e o `ResizeObserver` é
    // entregue DEPOIS dele. Um `rAF` pedido de dentro do observador só corre no
    // quadro SEGUINTE, e ainda assim corre ANTES do `paint()` do arrasto (que
    // foi agendado pelo `pointermove`, mais tarde) — ou seja: ele mede a
    // geometria VELHA e a página nativa anda um quadro atrás do dedo, sempre.
    //
    // Medir DENTRO do observador não custa layout nenhum: quando ele é
    // entregue, o layout do quadro já está limpo. E o `measure` só LÊ — nunca
    // escreve —, então não existe laço de observador para estourar.
    //
    // O que ficou FRIO, e por quê (a sonda mediu os dois e não pagou nada):
    // `scroll` e `resize` da janela são entregues ANTES da fase de rAF, então o
    // salto já corria no MESMO quadro (16,3-16,8ms = 1,00 quadro nos dois
    // caminhos). Ali o rAF é proteção de graça contra rajada, e fica.
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
    // Os ancestrais que recortam também são observados: num arrasto de largura
    // é o TRILHO que muda de tamanho, e a página precisa acompanhar quadro a
    // quadro em vez de esperar o reconciliador.
    for (const node of clips) sizes.observe(node)

    // ————— AS IRMÃS (o "pulo atrasado", medido) —————
    //
    // Seção vizinha que recolhe/expande EMPURRA a página sem mudar o tamanho
    // dela nem o de ancestral nenhum: nada acima observava isso, e sobrava o
    // relógio de 400ms — mediana de 300ms e p95 de 384ms de página parada no
    // lugar errado (18 a 23 quadros). Observando as irmãs: 0,28ms.
    //
    // A lista se refaz quando o trilho ganha ou perde seção (uma missão que
    // muda de fase troca as seções do dock). A que CONTÉM esta página fica
    // FORA — ela muda de tamanho a cada quadro do próprio arrasto, e o
    // observador do retângulo já contou isso.
    const siblings = new ResizeObserver(hot)
    const watchSiblings = (): void => {
      siblings.disconnect()
      const rail = railRef.current ?? railViewportOf(el)
      if (!rail) return
      const kids = Array.from(rail.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement
      )
      for (const node of browserSiblingsToWatch(kids, (node) => node.contains(el))) {
        siblings.observe(node)
      }
    }
    watchSiblings()
    const railKids = new MutationObserver(watchSiblings)
    const railNode = railRef.current ?? railViewportOf(el)
    if (railNode) railKids.observe(railNode, { childList: true })

    // Overlay que abre não mexe em tamanho nenhum: quem avisa é a mutação do
    // body (todo overlay da casa é um portal ali). FRIO de propósito: a
    // montagem de um portal é uma rajada de mutações, e um quadro de atraso
    // para esconder a página atrás de um modal não é gesto de ninguém.
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, { childList: true })
    window.addEventListener('resize', schedule)
    // Rolagem em QUALQUER scroller da tela pode mover o retângulo (o dock rola
    // dentro do trilho): captura para pegar todos, passivo para não segurar o
    // gesto de rolar de ninguém.
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    // A REDE FICA. O relógio continua reconciliando o que nenhum observador vê
    // — um ancestral que mudou de LUGAR sem mudar de tamanho — e o RESTO do
    // trilho, que manda no teto da alça. Ele deixou de ser o primeiro a
    // descobrir o colapso da irmã; nunca deixou de ser a rede.
    const timer = window.setInterval(() => {
      schedule()
      measureRail()
    }, BOUNDS_RECONCILE_MS)

    return () => {
      measureRef.current = null
      window.clearInterval(timer)
      document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      overlays.disconnect()
      railKids.disconnect()
      siblings.disconnect()
      sizes.disconnect()
      pump.stop()
      // A SAÍDA DECLARADA: seção recolhida, missão trocada, board desmontado —
      // todos passam por aqui, e todos DIZEM que a página saiu de vista. O main
      // esconde sem desanexar; a aba continua viva do outro lado.
      //
      // MENOS quando a página foi para a JANELA PRÓPRIA (⧉). Aí este painel não
      // é mais a autoridade sobre a geometria dela, e o `visible:false` daqui
      // seria um relato do host ERRADO: o motor o ignora (e registra
      // `browser-bounds-stale-host`), mas quem sabe que saiu é este componente —
      // calar na origem é melhor que encher o diário do dono a cada ⧉.
      if (!popoutRef.current) {
        browserApi()?.bounds(mission, lastRectRef.current ?? ZERO_RECT, false)
      }
      gateRef.current.reset()
      lastRectRef.current = null
    }
    // `popout` entra nas dependências para o efeito RENASCER no reencaixe: o
    // retângulo volta a existir no DOM e ninguém mais avisaria o motor de onde
    // ele está (o ResizeObserver morreu junto com o nó anterior).
  }, [missionId, report, measureRail, popout])

  // Três mudanças que NENHUM observador de tamanho enxerga:
  //  · o trilho saiu/voltou de vista (o Board mantém o dock montado);
  //  · a tira de abas ganhou/perdeu uma linha e EMPURROU o retângulo (a caixa
  //    não muda de tamanho, só de lugar);
  //  · a view acabou de NASCER e precisa ouvir a geometria de novo — o dedupe
  //    teria calado a repetição, e o main não pode adivinhar o retângulo.
  useEffect(() => {
    forceReport()
  }, [forceReport, visible, state.alive, state.tabs.length])

  // ————— gestos do chrome —————
  const openBrowser = useCallback((): void => {
    run((api) => api.newTab(missionId))
    // Quem abriu o browser quer digitar um endereço: o foco já cai na barra.
    urlRef.current?.focus()
  }, [missionId, run])

  if (engine === 'missing') {
    return (
      <div className="dock-browser">
        <span className="dock-browser-notice">// {BROWSER_NO_API}</span>
      </div>
    )
  }

  // ————— O RECIBO: a página está DESTACADA —————
  //
  // "No dock fica o RECIBO: destacado — trazer de volta" (design §fluxo). Com a
  // página numa janela própria, repetir aqui a tira de abas e a barra de
  // endereço criaria um SEGUNDO painel de controle da mesma página — duas barras
  // de endereço para uma página só, e nenhuma das duas com a página embaixo. O
  // que fica é o cartão quieto: onde ela está, o que ela tem, e as DUAS portas
  // de volta. Papel (não o painel escuro) porque não há página nenhuma aqui —
  // um retângulo preto vazio prometeria uma que está em outra janela.
  if (popout) {
    const awayTab = activeBrowserTab(state)
    const awayDetail = awayTab
      ? `${browserTabLabel(awayTab)}${state.tabs.length > 1 ? ` · ${state.tabs.length} abas` : ''}`
      : 'sem página aberta'
    return (
      <div className="dock-browser">
        <div className="dock-browser-shell dock-browser-away">
          <span className="dock-browser-away-head">
            <i className="dock-browser-away-mark" aria-hidden="true">
              ⧉
            </i>
            destacado numa janela própria
          </span>
          <span className="dock-browser-away-fine">{awayDetail}</span>
          <div className="dock-browser-away-acts">
            {/* FOCAR: o ⧉ do motor é idempotente de propósito — com a missão já
                destacada ele FOCA a janela em vez de abrir uma segunda
                (`browserPane.popOut`, §P1). É por isso que a porta de trazer a
                janela para a frente é o MESMO verbo. */}
            <button
              type="button"
              className="dock-browser-away-btn"
              onClick={() => run((api) => api.popOut(missionId))}
              {...hints('traz a janela do browser para a frente')}
            >
              focar a janela
            </button>
            <button
              type="button"
              className="dock-browser-away-btn on"
              onClick={() => run((api) => api.dockBack(missionId))}
              {...hints('a página volta para este painel e a janela fecha')}
            >
              trazer de volta
            </button>
          </div>
          {/* A mesma linha do pé do instrumento: é onde as duas frases acima
              aparecem no hover E no foco, e onde o ⚡ continua contando que o
              agente está dirigindo — a página destacada segue sendo dele. */}
          <div className="dock-browser-foot">
            {state.agentDriving && (
              <span
                className="dock-browser-driving"
                data-tip="O agente está usando este browser agora, na janela destacada. Você pode assumir quando quiser: a página recebe o seu mouse e o seu teclado direto, sem trava nenhuma."
              >
                <i className="dock-browser-driving-dot" aria-hidden="true" />
                <b>⚡</b> agente dirigindo
              </span>
            )}
            {hint ? (
              <span className="dock-browser-hint">{hint}</span>
            ) : (
              <span className="dock-browser-session">o X da janela também reencaixa</span>
            )}
          </div>
        </div>

        {state.notice && <span className="dock-browser-notice">// {state.notice.text}</span>}
        {error && <span className="dock-browser-notice stale">// {error}</span>}
        {notice && <span className="dock-browser-notice">// {notice}</span>}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`dock-browser${dragging ? ' is-dragging' : ''}`}
      style={pageStyle}
    >
      {/* O INSTRUMENTO (H7, reprovação de 2026-08-29: "ta estranho esse browser
          flutuando… ta no vale da estranheza"). Abas, barra, página, alça e pé
          são UM corpo com UMA borda e UM raio; as costuras de dentro são fio de
          cabelo. O corpo e o chrome moram no `BrowserChrome` — a janela
          destacada usa os mesmos. O que entra aqui como `children` é o que é DO
          DOCK: o retângulo medido (com o mesmo `ref` de sempre) e a alça. */}
      <BrowserChrome
        missionId={missionId}
        projectId={projectId}
        state={state}
        hint={hint}
        hints={hints}
        run={run}
        notify={setNotice}
        urlRef={urlRef}
        tools={
          /* ⧉ DESTACAR — "tirar ele dali e desfixar, como o microfone que eu
             clico e ele sai" (ordem do dono, 2026-08-29). A MESMA página salta
             para uma janela própria: nada recarrega, o agente nem percebe.
             Desabilitado sem página aberta porque é o que o motor responderia
             — e a frase do pé ensina a saída em vez de deixar o clique mudo. */
          <button
            type="button"
            className="dock-browser-btn"
            disabled={!state.alive}
            aria-label="destacar o browser numa janela própria"
            onClick={() => run((api) => api.popOut(missionId))}
            {...hints(
              state.alive
                ? 'destacar numa janela própria · o X dela reencaixa'
                : 'abra uma página (+) antes de destacar'
            )}
          >
            ⧉
          </button>
        }
      >
        {/* O RETÂNGULO. Vazio por contrato: a view nativa compõe por cima dele.
            O que está pintado aqui só aparece quando ela NÃO está — e então diz
            por quê. Painel escuro (família .term-window) porque é isso que a
            página vai ser: a única superfície não-papel do dock. */}
        <div ref={pageRef} className={`dock-browser-page${state.alive ? ' live' : ''}`}>
          {/* As faixas da MOLDURA DE DISPOSITIVO: com a largura pedida cabendo
              no painel, a view fica em tamanho real e centralizada, e isto marca
              onde ela começa e termina. */}
          <BrowserPageBands state={state} painted={painted} />
          <BrowserPageOverlay
            state={state}
            painted={painted}
            hints={hints}
            onOpen={openBrowser}
          />
        </div>

        {/* A ALÇA. Mora na borda de BAIXO da página, entre ela e a barra de
            status — o lugar da divisória no dock do Claude Code que o dono
            apontou como referência. Ela é um `separator` de verdade: anuncia
            valor, mínimo e máximo, e o teclado a move como o mouse. */}
        <div
          className="dock-browser-grip"
          role="separator"
          tabIndex={0}
          aria-label="altura da página do browser"
          aria-orientation="horizontal"
          aria-valuemin={pageRange.min}
          aria-valuemax={pageRange.max}
          aria-valuenow={pageHeight}
          aria-valuetext={`${pageHeight} pixels`}
          onPointerDown={onGripPointerDown}
          onKeyDown={onGripKeyDown}
          {...hints('altura da página · arraste ou use ↑ ↓')}
        >
          <i className="dock-browser-grip-line" aria-hidden="true" />
        </div>
      </BrowserChrome>

      {/* A VOZ DO MOTOR. Download barrado, página que caiu, teto de abas: a
          nota viaja dentro do state (durável, com carimbo), então ela aparece
          mesmo que o painel só tenha sido aberto depois do fato. Vem primeiro
          — é o que o dono não tem como descobrir de outro jeito. */}
      {state.notice && <span className="dock-browser-notice">// {state.notice.text}</span>}
      {error && <span className="dock-browser-notice stale">// {error}</span>}
      {notice && <span className="dock-browser-notice">// {notice}</span>}
    </div>
  )
}

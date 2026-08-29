import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import {
  BROWSER_NO_API,
  BROWSER_TAB_CAP,
  EMPTY_BROWSER_PANEL,
  activeBrowserTab,
  browserRect,
  browserSectionSummary,
  browserTabLabel,
  clipBrowserRect,
  isHostOverlayNode,
  normalizeBrowserPanel,
  overlayHidesPage,
  readBrowserAck,
  rectHasArea,
  sameBrowserRect,
  tabCapNotice,
  trimUrlInput,
  type BrowserEngineState
} from '../dockBrowserModel'
import type { BrowserPanelState, BrowserRect, SynkoraApi } from '../../../preload/index'

// O PAINEL DE BROWSER DO DOCK (H3 do design de 2026-08-29).
//
// A regra que explica todo o resto deste arquivo: **o renderer não desenha
// página nenhuma**. A `WebContentsView` do main compõe POR CIMA do DOM, e o que
// existe aqui é o CHROME (abas, endereço, setas) mais um RETÂNGULO VAZIO que
// serve de medida. O componente tem, portanto, duas obrigações:
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
// SEM `data-tip` NO CHROME (decisão desta fatia, e a única divergência do
// dialeto do dock): o tooltip da casa nasce 7px ABAIXO do que se aponta, e tudo
// aqui aponta para logo acima da página — a view nativa o engoliria inteiro (a
// mesma dor que o comentário do `Tooltip.tsx` guarda da era da ilha de panes).
// No lugar dele, cada controle escreve sua frase na LINHA DO PÉ, que mora
// ABAIXO da página: aparece no hover E no foco (o tooltip nunca aparecia no
// teclado) e é a linguagem de barra de status que um browser já tem.
//
// Par declarado: `src/preload/index.ts` (api.browser) ↔ `src/main/ipc/browser.ts`.

/** Preload velho (app aberto antes desta versão) não tem `api.browser`. */
function browserApi(): SynkoraApi['browser'] | null {
  return window.synkora?.browser ?? null
}

/** Reconciliador da geometria (doutrina da casa: nenhum passo depende de
 *  entrega única). Os observadores cobrem tudo que MEXE; este relógio cobre o
 *  que ninguém observou — um ancestral que mudou de lugar sem mudar de
 *  tamanho. Só corre com o painel montado. */
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
  const pageRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const tab = activeBrowserTab(state)
  const capNotice = tabCapNotice(state.tabs.length)

  // Recado do motor para o gesto que o dono acabou de fazer (recusa do teto,
  // missão sem worktree…). Mora ao pé do chrome, onde o clique aconteceu.
  const [notice, setNotice] = useState<string | null>(null)
  // A BARRA DE STATUS: a frase do controle sob o cursor OU sob o foco. Ver o
  // bloco do topo — é o lugar do tooltip nesta seção.
  const [hint, setHint] = useState<string | null>(null)
  // A barra de endereço só é do DONO enquanto ele está nela: fora do foco, ela
  // conta a URL da aba ativa. Sem esta separação, uma navegação do AGENTE
  // apagaria o que ele estivesse digitando (e ele PODE assumir quando quiser).
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  // O que a MEDIDA concluiu: com a página escondida (overlay do host por cima,
  // seção fora de vista) o retângulo vira superfície falante em vez de um
  // buraco escuro sem explicação.
  const [painted, setPainted] = useState(false)

  const run = useCallback((action: (api: SynkoraApi['browser']) => Promise<unknown>): void => {
    const api = browserApi()
    if (!api) {
      setNotice(BROWSER_NO_API)
      return
    }
    setNotice(null)
    void action(api)
      .then((res) => {
        const ack = readBrowserAck(res)
        if (!ack.ok) setNotice(ack.error)
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message.trim() : ''
        setNotice(detail || 'o browser não respondeu a esta ação')
      })
  }, [])

  /** Ligação de um controle à barra de status: hover E foco, sempre juntos. */
  const hints = useCallback(
    (text: string) => ({
      onMouseEnter: () => setHint(text),
      onMouseLeave: () => setHint((current) => (current === text ? null : current)),
      onFocus: () => setHint(text),
      onBlur: () => setHint((current) => (current === text ? null : current))
    }),
    []
  )

  // ————— GEOMETRIA: o único canal entre este painel e a view nativa —————
  const lastSentRef = useRef<{ rect: BrowserRect; visible: boolean } | null>(null)
  const lastRectRef = useRef<BrowserRect | null>(null)
  const scheduleRef = useRef<(() => void) | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const report = useCallback((mission: string, rect: BrowserRect, shown: boolean): void => {
    const api = browserApi()
    if (!api) return
    const last = lastSentRef.current
    if (last && last.visible === shown && sameBrowserRect(last.rect, rect)) return
    lastSentRef.current = { rect, visible: shown }
    setPainted(shown)
    api.bounds(mission, rect, shown)
  }, [])

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    // A missão é capturada AQUI: a faxina deste efeito precisa esconder a view
    // da missão que ELE reportou, mesmo que o dono já tenha trocado de aba.
    const mission = missionId
    const clips = clipAncestors(el)
    let frame = 0

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

    const schedule = (): void => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    scheduleRef.current = schedule

    measure()
    const sizes = new ResizeObserver(schedule)
    sizes.observe(el)
    // Os ancestrais que recortam também são observados: num arrasto de largura
    // é o TRILHO que muda de tamanho, e a página precisa acompanhar quadro a
    // quadro em vez de esperar o reconciliador.
    for (const node of clips) sizes.observe(node)
    // Overlay que abre não mexe em tamanho nenhum: quem avisa é a mutação do
    // body (todo overlay da casa é um portal ali).
    const overlays = new MutationObserver(schedule)
    overlays.observe(document.body, { childList: true })
    window.addEventListener('resize', schedule)
    // Rolagem em QUALQUER scroller da tela pode mover o retângulo (o dock rola
    // dentro do trilho): captura para pegar todos, passivo para não segurar o
    // gesto de rolar de ninguém.
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    const timer = window.setInterval(schedule, BOUNDS_RECONCILE_MS)

    return () => {
      scheduleRef.current = null
      window.clearInterval(timer)
      document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      overlays.disconnect()
      sizes.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
      // A SAÍDA DECLARADA: seção recolhida, missão trocada, board desmontado —
      // todos passam por aqui, e todos DIZEM que a página saiu de vista. O main
      // esconde sem desanexar; a aba continua viva do outro lado.
      browserApi()?.bounds(mission, lastRectRef.current ?? ZERO_RECT, false)
      lastSentRef.current = null
      lastRectRef.current = null
    }
  }, [missionId, report])

  // Três mudanças que NENHUM observador de tamanho enxerga:
  //  · o trilho saiu/voltou de vista (o Board mantém o dock montado);
  //  · a tira de abas ganhou/perdeu uma linha e EMPURROU o retângulo (a caixa
  //    não muda de tamanho, só de lugar);
  //  · a view acabou de NASCER e precisa ouvir a geometria de novo — o dedupe
  //    teria calado a repetição, e o main não pode adivinhar o retângulo.
  useEffect(() => {
    lastSentRef.current = null
    scheduleRef.current?.()
  }, [visible, state.alive, state.tabs.length])

  // ————— gestos do chrome —————
  const submitUrl = useCallback((): void => {
    const url = trimUrlInput(draft)
    if (!url) {
      setNotice('digite um endereço — Esc devolve o campo ao endereço da aba')
      return
    }
    setEditing(false)
    urlRef.current?.blur()
    // Sem aba ativa o gesto ABRE o browser: pedir `navigate` a uma missão sem
    // view seria contar com o motor adivinhando o que o dono quis.
    if (tab) run((api) => api.navigate(missionId, url))
    else run((api) => api.newTab(missionId, url))
  }, [draft, missionId, run, tab])

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

  const urlValue = editing ? draft : (tab?.url ?? '')
  const urlHint = tab ? 'endereço · Enter navega' : 'endereço · Enter abre o browser'

  return (
    <div className="dock-browser">
      {/* A TIRA DE ABAS quebra em vez de rolar: numa coluna de 176px um
          scroller horizontal esconderia abas atrás de um gesto que o dono não
          tem motivo para tentar. Mesmo precedente do `.dock-acts`. */}
      {state.tabs.length > 0 && (
        <div className="dock-browser-tabbar">
          <div className="dock-browser-tabs" role="tablist" aria-label="abas do browser">
            {state.tabs.map((entry) => (
              <span className="dock-browser-tab-wrap" key={entry.tabId}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={entry.active}
                  className={`dock-browser-tab${entry.active ? ' on' : ''}`}
                  onClick={() => run((api) => api.selectTab(missionId, entry.tabId))}
                  // A tira corta o nome no trilho estreito; a barra de status
                  // devolve o nome INTEIRO e o endereço, que é a única forma
                  // de saber qual aba é qual com oito abertas a 176px.
                  {...hints(
                    entry.url
                      ? `${browserTabLabel(entry)} · ${entry.url}`
                      : browserTabLabel(entry)
                  )}
                >
                  <i
                    className={`dock-browser-tab-dot${entry.loading ? ' loading' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="dock-browser-tab-name">{browserTabLabel(entry)}</span>
                </button>
                <button
                  type="button"
                  className="dock-browser-tab-x"
                  aria-label={`fechar a aba ${browserTabLabel(entry)}`}
                  onClick={() => run((api) => api.closeTab(missionId, entry.tabId))}
                  {...hints('fechar esta aba')}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {/* O `+` mora FORA do scroller: com oito abas a tira ganha barra de
              rolagem, e a porta de abrir a próxima não pode ir junto para
              debaixo dela. */}
          <button
            type="button"
            className="dock-browser-tab-add"
            disabled={Boolean(capNotice)}
            aria-label="abrir uma aba"
            onClick={() => run((api) => api.newTab(missionId))}
            {...hints(capNotice ?? `abrir aba em branco · até ${BROWSER_TAB_CAP}`)}
          >
            +
          </button>
        </div>
      )}

      <div className="dock-browser-nav">
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab?.canBack}
          aria-label="voltar"
          onClick={() => run((api) => api.back(missionId))}
          {...hints('voltar uma página')}
        >
          ←
        </button>
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab?.canForward}
          aria-label="avançar"
          onClick={() => run((api) => api.forward(missionId))}
          {...hints('avançar uma página')}
        >
          →
        </button>
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab}
          aria-label="recarregar"
          onClick={() => run((api) => api.reload(missionId))}
          {...hints('recarregar a página')}
        >
          ⟳
        </button>
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab}
          aria-label="abrir as devtools da página"
          onClick={() => {
            if (tab) run((api) => api.devtools(missionId, tab.tabId))
          }}
          {...hints('devtools DA PÁGINA, em janela separada')}
        >
          {'</>'}
        </button>
        <input
          ref={urlRef}
          className="dock-browser-url"
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label="endereço"
          placeholder={tab ? 'endereço' : 'abrir um endereço'}
          value={urlValue}
          onChange={(event) => {
            setDraft(event.target.value)
            setEditing(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submitUrl()
              return
            }
            // Esc devolve o campo à verdade da aba — e não sobe para o chat,
            // que trataria a tecla como interrupção do agente.
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setEditing(false)
              urlRef.current?.blur()
            }
          }}
          onMouseEnter={() => setHint(urlHint)}
          onMouseLeave={() => setHint((current) => (current === urlHint ? null : current))}
          onFocus={() => {
            setDraft(tab?.url ?? '')
            setEditing(true)
            setHint(urlHint)
          }}
          onBlur={() => {
            setEditing(false)
            setHint((current) => (current === urlHint ? null : current))
          }}
        />
      </div>

      {/* O RETÂNGULO. Vazio por contrato: a view nativa compõe por cima dele.
          O que está pintado aqui só aparece quando ela NÃO está — e então diz
          por quê. Painel escuro (família .term-window) porque é isso que a
          página vai ser: a única superfície não-papel do dock. */}
      <div ref={pageRef} className={`dock-browser-page${state.alive ? ' live' : ''}`}>
        {!state.alive && (
          <div className="dock-browser-empty">
            <span className="dock-browser-empty-line">nenhuma página aberta nesta missão</span>
            <button
              type="button"
              className="dock-browser-open"
              onClick={openBrowser}
              {...hints('abre o browser desta missão numa aba em branco')}
            >
              abrir browser
            </button>
            <span className="dock-browser-empty-fine">
              o agente também abre sozinho, quando o QA visual dele precisa
            </span>
          </div>
        )}
        {state.alive && !painted && (
          <div className="dock-browser-empty">
            <span className="dock-browser-empty-line">
              a página continua aberta — escondida enquanto esta tela está por cima
            </span>
          </div>
        )}
      </div>

      {/* A LINHA DO PÉ é a barra de status: ⚡ (o fato que não pode sumir) à
          esquerda e, à direita, a frase do controle apontado — ou, em silêncio,
          de onde vêm os logins desta página. */}
      <div className="dock-browser-foot">
        {state.agentDriving && (
          <span
            className="dock-browser-driving"
            data-tip="O agente está usando este browser agora. Você pode assumir quando quiser: a página recebe o seu mouse e o seu teclado direto, sem trava nenhuma."
          >
            <i className="dock-browser-driving-dot" aria-hidden="true" />
            <b>⚡</b> agente dirigindo
          </span>
        )}
        {hint ? (
          <span className="dock-browser-hint">{hint}</span>
        ) : (
          <span
            className="dock-browser-session"
            data-tip={`Cookies e logins ficam na sessão deste universo (${projectId}) — compartilhada por todas as missões dele, então entrar uma vez vale para as próximas.`}
          >
            sessão do projeto
          </span>
        )}
      </div>

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

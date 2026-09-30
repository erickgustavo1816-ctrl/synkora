import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import {
  BROWSER_NO_API,
  BROWSER_TAB_CAP,
  activeBrowserTab,
  activeBrowserTabFailure,
  browserFailureIdentity,
  browserPageHidden,
  browserTabFailureTitle,
  browserTabLabel,
  browserTabOwnerPhrase,
  browserTabOwnerTag,
  browserTabSentence,
  browserTabTitle,
  browserViewportBand,
  browserViewportIsCustom,
  browserViewportLabel,
  browserViewportOf,
  browserViewportOptionLabel,
  browserViewportOptions,
  browserViewportShortfall,
  browserViewportTitle,
  liveBrowserWait,
  readBrowserAck,
  readViewportMode,
  tabCapNotice,
  trimUrlInput
} from '../dockBrowserModel'
import {
  BROWSER_NOTICE_ACTION_WORDS,
  browserFailureLook,
  browserNoticeRows,
  liveNoticeDismissals,
  type BrowserNoticeRow
} from '../browserNoticePresentation'
import type { BrowserPanelState, BrowserTab, SynkoraApi } from '../../../preload/index'
import './BrowserChrome.css'
import './BrowserNotices.css'

// O CHROME DO INSTRUMENTO — abas, barra, faixa de avisos e o que se pinta no
// retângulo da página, comum aos DOIS hosts do browser da missão (o painel do
// dock e a janela destacada): um instrumento copiado vira dois na terceira
// correção. O desenho é o `docs/mockups/browser-chrome-2026-09-29.html`.
//
// A lei que manda aqui: NADA que aparece por causa do MOUSE muda a altura da
// página. Dica é `title` nativo — o Windows o desenha POR CIMA da
// `WebContentsView`, que engoliria um tooltip do DOM —, e recado é linha da
// faixa, entre a barra e a página, que só existe enquanto há o que dizer.
//
// Par declarado: `src/preload/index.ts` (api.browser) ↔ `src/main/ipc/browser.ts`.

/** Preload velho (app aberto antes desta versão) não tem `api.browser`. */
export function browserApi(): SynkoraApi['browser'] | null {
  return window.synkora?.browser ?? null
}

/** O que uma alavanca do chrome faz com o motor. O host injeta o executor
 *  (`useBrowserRunner`) porque é ELE quem guarda o recado da recusa. */
export type BrowserRunner = (action: (api: SynkoraApi['browser']) => Promise<unknown>) => void

/**
 * O EXECUTOR das alavancas + o recado do motor para o gesto que o dono acabou de
 * fazer (recusa do teto, missão sem worktree…). Preload velho não vira exceção:
 * vira a receita ("reinicie o app").
 */
export function useBrowserRunner(): {
  notice: string | null
  setNotice: (text: string | null) => void
  run: BrowserRunner
} {
  const [notice, setNotice] = useState<string | null>(null)
  const run = useCallback<BrowserRunner>((action) => {
    const api = browserApi()
    if (!api) {
      setNotice(BROWSER_NO_API)
      return
    }
    setNotice(null)
    let pending: Promise<unknown>
    try {
      pending = action(api)
    } catch (cause: unknown) {
      // Verbo que o preload EM EXECUÇÃO ainda não tem (chegou por HMR) joga um
      // `TypeError` síncrono: sem esta cerca o clique seria mudo.
      const detail = cause instanceof Error ? cause.message.trim() : ''
      setNotice(cause instanceof TypeError ? BROWSER_NO_API : detail || 'o browser recusou a ação')
      return
    }
    void pending
      .then((res) => {
        const ack = readBrowserAck(res)
        if (!ack.ok) setNotice(ack.error)
      })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message.trim() : ''
        setNotice(detail || 'o browser não respondeu a esta ação')
      })
  }, [])
  return { notice, setNotice, run }
}

/**
 * A ESPERA da página travada, comum aos dois hosts: `failureShown` diz se a
 * página nativa sai de cena para o cartão; `wait` é o ESPERAR do cartão (o
 * dono escolhe olhar a página travada). A espera morre com a falha que a
 * motivou — mudou ou sumiu, a próxima volta ao cartão.
 */
export function useBrowserFailureWait(state: BrowserPanelState): {
  failureShown: boolean
  wait: () => void
} {
  const [waited, setWaited] = useState<string | null>(null)
  const live = liveBrowserWait(state, waited)
  // No RENDER, não num efeito: um quadro com a espera velha mostraria a página
  // de uma falha nova que ninguém escolheu esperar.
  if (live !== waited) setWaited(live)
  const identity = browserFailureIdentity(state)
  const wait = useCallback(() => setWaited(identity), [identity])
  return { failureShown: browserPageHidden(state, live), wait }
}

const ADDRESS_SESSION_TITLE =
  'cookies e logins são da sessão deste universo — entrar uma vez vale para as próximas missões'

const DRIVING_TITLE =
  'o agente está dirigindo esta aba agora — você pode assumir quando quiser: a página recebe o seu mouse e o seu teclado, sem trava'

/** Recado sem instrumento em volta (preload velho, janela sem missão): mesma
 *  gramática da faixa, sem ×, porque não há o que dispensar. */
export function BrowserMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="dock-browser-info neutral dock-browser-message" role="status">
      <WorkspaceIcon name="info" />
      <span className="dock-browser-info-text">{text}</span>
    </div>
  )
}

const NO_DISMISSALS: ReadonlySet<string> = new Set()

/**
 * A FAIXA DE AVISOS: os recados do motor, da leitura, do gesto e da largura,
 * cada um com o tom, o ícone e a saída da SUA espécie
 * (`browserNoticePresentation`) e um ×. Dispensar vale para AQUELE recado: o
 * que some e volta — ou um carimbo novo do motor — aparece de novo. O recado do
 * gesto é do host, então o × dele o apaga lá.
 */
export function BrowserNoticeStrip({
  missionId,
  state,
  error,
  notice,
  notify,
  run
}: {
  missionId: string
  state: BrowserPanelState
  /** falha de leitura do motor — a fotografia anterior FICA na tela */
  error: string | null
  /** recado do gesto recusado (o `notice` do `useBrowserRunner` do host) */
  notice: string | null
  notify: (text: string | null) => void
  run: BrowserRunner
}): React.JSX.Element | null {
  const rows = browserNoticeRows(state, {
    readError: error,
    gesture: notice,
    viewport: browserViewportShortfall(state)
  })
  const [dismissed, setDismissed] = useState(NO_DISMISSALS)
  const rowKeys = rows.map((row) => row.key).join('\n')
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useEffect(() => {
    setDismissed((current) => liveNoticeDismissals(current, rowsRef.current))
  }, [rowKeys])

  const dismiss = (row: BrowserNoticeRow): void => {
    if (row.source === 'gesture') notify(null)
    else setDismissed((current) => new Set([...current, row.key]))
  }

  const act = (row: BrowserNoticeRow): void => {
    const action = row.action
    if (!action) return
    if (action.kind === 'reload') {
      run((api) => api.reload(missionId))
      return
    }
    // REABRIR resolve o recado: a linha sai junto, e um segundo clique não
    // abre uma segunda aba do mesmo endereço.
    run((api) => api.newTab(missionId, action.url))
    dismiss(row)
  }

  const shown = rows.filter((row) => !dismissed.has(row.key))
  if (shown.length === 0) return null
  return (
    <div className="dock-browser-infos">
      {shown.map((row) => (
        <div
          key={row.key}
          className={`dock-browser-info ${row.tone}`}
          role={row.tone === 'error' ? 'alert' : 'status'}
        >
          <WorkspaceIcon name={row.icon} />
          <span className="dock-browser-info-text">
            {row.title && <b>{row.title}</b>}
            {row.title ? ` — ${row.text}` : row.text}
          </span>
          {row.count && (
            <span className="dock-browser-info-count" title={row.count.title}>
              {row.count.label}
            </span>
          )}
          {row.action && (
            <button
              type="button"
              className="dock-browser-info-act"
              title={BROWSER_NOTICE_ACTION_WORDS[row.action.kind].title}
              onClick={() => act(row)}
            >
              {BROWSER_NOTICE_ACTION_WORDS[row.action.kind].label}
            </button>
          )}
          <button
            type="button"
            className="dock-browser-info-x"
            aria-label="dispensar este aviso"
            title="dispensar"
            onClick={() => dismiss(row)}
          >
            <WorkspaceIcon name="close" />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * A tira ROLA na horizontal quando as abas já encolheram até o piso, e a borda
 * que ESCONDE aba esmaece (nunca um corte seco). A aba ativa é trazida à vista
 * a cada troca — rolando SÓ a tira: `scrollIntoView` rolaria o trilho do dock.
 */
function useTabListEdges(listRef: RefObject<HTMLDivElement | null>, tabsKey: string): string {
  const [edges, setEdges] = useState('')
  const measureRef = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = (): void => {
      const start = list.scrollLeft > 1
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1
      const next = `${start ? ' fade-start' : ''}${end ? ' fade-end' : ''}`
      setEdges((current) => (current === next ? current : next))
    }
    measureRef.current = measure
    list.addEventListener('scroll', measure, { passive: true })
    const sizes = new ResizeObserver(measure)
    sizes.observe(list)
    return () => {
      measureRef.current = () => undefined
      list.removeEventListener('scroll', measure)
      sizes.disconnect()
    }
  }, [listRef])
  useLayoutEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('.dock-browser-tab-wrap.on')
    if (list && active) {
      const right = active.offsetLeft + active.offsetWidth
      if (active.offsetLeft < list.scrollLeft) list.scrollLeft = active.offsetLeft
      else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth
    }
    measureRef.current()
  }, [listRef, tabsKey])
  return edges
}

function BrowserTabItem({
  missionId,
  tab,
  run
}: {
  missionId: string
  tab: BrowserTab
  run: BrowserRunner
}): React.JSX.Element {
  const label = browserTabLabel(tab)
  const tag = browserTabOwnerTag(tab)
  const phrase = browserTabOwnerPhrase(tab)
  const sentence = browserTabSentence(tab)
  const driving = tab.driving === true
  return (
    <div className={`dock-browser-tab-wrap${tab.active ? ' on' : ''}`} role="presentation">
      <button
        type="button"
        role="tab"
        aria-selected={tab.active}
        // A aba do DONO sem sinal nenhum fica com o próprio texto como nome; a
        // ficha, o ⚡ e a marca de erro são desenho e voltam como PALAVRA.
        aria-label={sentence === label ? undefined : sentence}
        title={browserTabTitle(tab)}
        className="dock-browser-tab"
        onClick={() => run((api) => api.selectTab(missionId, tab.tabId))}
      >
        {tab.loading && <i className="dock-browser-tab-dot" aria-hidden="true" />}
        {tab.failure && <WorkspaceIcon name="alert" />}
        {/* UMA ficha para as duas verdades da identidade (de quem é, e se está
            agindo AGORA): o ⚡ acender não empurra o rótulo de lugar. */}
        {(tag || driving) && (
          <span className={`dock-browser-tab-owner${tag ? '' : ' is-bare'}`} aria-hidden="true">
            {driving && <WorkspaceIcon name="bolt" />}
            {tag && <span className="dock-browser-tab-owner-name">{tag}</span>}
          </span>
        )}
        <span className="dock-browser-tab-name">{label}</span>
      </button>
      {/* O × vale em TODA aba, inclusive na de um ajudante: o painel é do dono.
          A guarda NOMEIA de quem é a aba antes do gesto, nunca esconde a porta. */}
      <button
        type="button"
        className="dock-browser-tab-x"
        aria-label={phrase ? `fechar a ${phrase} · ${label}` : `fechar a aba ${label}`}
        title={phrase ? `fechar a ${phrase}` : 'fechar esta aba'}
        onClick={() => run((api) => api.closeTab(missionId, tab.tabId))}
      >
        <WorkspaceIcon name="close" />
      </button>
    </div>
  )
}

function BrowserTabStrip({
  missionId,
  state,
  run
}: {
  missionId: string
  state: BrowserPanelState
  run: BrowserRunner
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const tabsKey = state.tabs.map((tab) => `${tab.tabId}${tab.active ? '*' : ''}`).join(' ')
  const edges = useTabListEdges(listRef, tabsKey)
  const capNotice = tabCapNotice(state.tabs.length)
  return (
    <div className="dock-browser-tabbar">
      <div
        ref={listRef}
        className={`dock-browser-tabs${edges}`}
        role="tablist"
        aria-label="abas do browser"
      >
        {state.tabs.map((tab) => (
          <BrowserTabItem key={tab.tabId} missionId={missionId} tab={tab} run={run} />
        ))}
      </div>
      {/* O + mora colado à ÚLTIMA aba (como no Chrome) e FORA da rolagem: com a
          tira cheia ele encosta na borda em vez de sumir junto com as abas. */}
      <button
        type="button"
        className="dock-browser-tab-add"
        disabled={Boolean(capNotice)}
        aria-label="abrir uma aba"
        title={capNotice ?? `abrir aba em branco · até ${BROWSER_TAB_CAP}`}
        onClick={() => run((api) => api.newTab(missionId))}
      >
        <WorkspaceIcon name="plus" />
      </button>
    </div>
  )
}

export default function BrowserChrome({
  missionId,
  state,
  run,
  notice,
  notify,
  error,
  urlRef,
  shellClass,
  tools,
  actions,
  children
}: {
  missionId: string
  state: BrowserPanelState
  run: BrowserRunner
  /** recado do gesto recusado (o `notice` do `useBrowserRunner` do host) */
  notice: string | null
  /** o host guarda o recado do gesto: o endereço vazio e o × escrevem nele */
  notify: (text: string | null) => void
  /** falha de leitura do motor — a fotografia anterior FICA na tela */
  error: string | null
  /** O campo de endereço é do host: o convite "abrir browser" (que mora dentro
   *  do retângulo, e portanto fora daqui) põe o foco nele. */
  urlRef: RefObject<HTMLInputElement | null>
  /** classe extra do CORPO (o pop-out tira borda e raio: ele É a janela) */
  shellClass?: string
  /** ferramenta do host depois das devtools (o ⧉ do dock) */
  tools?: ReactNode
  /** ação do host no FIM da barra (o reencaixe do pop-out) */
  actions?: ReactNode
  /** o retângulo da página (e, no dock, a alça): FAIXA do mesmo corpo */
  children: ReactNode
}): React.JSX.Element {
  const tab = activeBrowserTab(state)
  const viewport = browserViewportOf(state)
  // A barra de endereço só é do DONO enquanto ele está nela: fora do foco, ela
  // conta a URL da aba ativa — uma navegação do AGENTE nunca apaga o que ele
  // estiver digitando.
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  const submitUrl = useCallback((): void => {
    const url = trimUrlInput(draft)
    if (!url) {
      notify('digite um endereço — Esc devolve o campo ao endereço da aba')
      return
    }
    setEditing(false)
    urlRef.current?.blur()
    // Sem aba ativa o gesto ABRE o browser: `navigate` numa missão sem view
    // contaria com o motor adivinhando.
    if (tab) run((api) => api.navigate(missionId, url))
    else run((api) => api.newTab(missionId, url))
  }, [draft, missionId, notify, run, tab, urlRef])

  const driving = tab?.driving === true

  return (
    <div className={shellClass ? `dock-browser-shell ${shellClass}` : 'dock-browser-shell'}>
      {state.tabs.length > 0 && <BrowserTabStrip missionId={missionId} state={state} run={run} />}

      <div className="dock-browser-nav">
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab?.canBack}
          aria-label="voltar"
          title="voltar uma página"
          onClick={() => run((api) => api.back(missionId))}
        >
          <WorkspaceIcon name="back" />
        </button>
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab?.canForward}
          aria-label="avançar"
          title="avançar uma página"
          onClick={() => run((api) => api.forward(missionId))}
        >
          <WorkspaceIcon name="arrow" />
        </button>
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab}
          aria-label="recarregar"
          title="recarregar a página"
          onClick={() => run((api) => api.reload(missionId))}
        >
          <WorkspaceIcon name="reload" />
        </button>
        <div className={`dock-browser-url-wrap${driving ? ' driving' : ''}`}>
          <input
            ref={urlRef}
            className="dock-browser-url"
            type="text"
            spellCheck={false}
            autoComplete="off"
            aria-label="endereço"
            placeholder={tab ? 'endereço' : 'abrir um endereço'}
            title={`${tab ? 'Enter navega · Esc devolve o endereço da aba' : 'Enter abre o browser neste endereço'}\n${ADDRESS_SESSION_TITLE}`}
            value={editing ? draft : (tab?.url ?? '')}
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
            onFocus={() => {
              setDraft(tab?.url ?? '')
              setEditing(true)
            }}
            onBlur={() => setEditing(false)}
          />
          {/* ⚡ DENTRO do campo: acender e apagar não empurra nada. */}
          {driving && (
            <span
              className="dock-browser-url-driving"
              role="img"
              aria-label="o agente está dirigindo esta aba"
              title={DRIVING_TITLE}
            >
              <WorkspaceIcon name="bolt" />
            </span>
          )}
        </div>
        {/* A LARGURA QUE A PÁGINA ENXERGA: o MESMO estado que a tool
            `browser_viewport` do agente escreve. A lista é a NATIVA — o Windows a
            abre como janela própria, por cima da página. */}
        <label
          className={`dock-browser-width${viewport === 'auto' ? '' : ' on'}${browserViewportIsCustom(viewport) ? ' custom' : ''}`}
          title={browserViewportTitle(state)}
        >
          <WorkspaceIcon name="width" />
          <span>{browserViewportLabel(viewport)}</span>
          <WorkspaceIcon name="chevron" />
          <select
            aria-label="largura que a página enxerga"
            value={String(viewport)}
            disabled={!state.alive}
            onChange={(event) => {
              const mode = readViewportMode(Number(event.target.value))
              run((api) => api.setViewportMode(missionId, mode))
            }}
          >
            {browserViewportOptions(state).map((mode) => (
              <option key={String(mode)} value={String(mode)}>
                {browserViewportOptionLabel(mode)}
              </option>
            ))}
          </select>
        </label>
        <span className="dock-browser-sep" aria-hidden="true" />
        <button
          type="button"
          className="dock-browser-btn"
          disabled={!tab}
          aria-label="abrir as devtools da página"
          title="devtools da página, em janela separada"
          onClick={() => {
            if (tab) run((api) => api.devtools(missionId, tab.tabId))
          }}
        >
          <WorkspaceIcon name="code" />
        </button>
        {tools}
        {actions}
      </div>

      <BrowserNoticeStrip
        missionId={missionId}
        state={state}
        error={error}
        notice={notice}
        notify={notify}
        run={run}
      />

      {children}
    </div>
  )
}

/**
 * AS FAIXAS DA MOLDURA DE DISPOSITIVO (2026-08-29 — "como vou saber se ta
 * quebrando de vdd ou é o app"). Com a largura pedida CABENDO, o motor põe a
 * view em tamanho REAL e centralizada; o que sobra é o painel do app. Aqui só se
 * MARCA a borda da página: a geometria é CSS (re-centraliza sem render num
 * arrasto) e o estado diz apenas SE existe faixa. Nunca comem clique.
 */
export function BrowserPageBands({
  state,
  painted
}: {
  state: BrowserPanelState
  /** a medida concluiu que a página está à vista AGORA */
  painted: boolean
}): React.JSX.Element | null {
  const mode = browserViewportOf(state)
  if (!state.alive || !painted || mode === 'auto') return null
  if (browserViewportBand(state) <= 0) return null
  const style = { '--dock-browser-vp-w': `${mode}px` } as CSSProperties
  return (
    <div className="dock-browser-bands" style={style} aria-hidden="true">
      <i className="dock-browser-band l" />
      <i className="dock-browser-band r" />
    </div>
  )
}

/**
 * O que se vê DENTRO do retângulo quando a `WebContentsView` não está por cima
 * dele: o convite (nenhuma página aberta), o CARTÃO DE ERRO da aba à vista
 * (variante B — o host esconde a página nativa, que seria um branco mudo) e a
 * explicação de por que a página sumiu. O retângulo é do HOST (ele sabe a
 * própria geometria); o conteúdo é comum.
 */
export function BrowserPageOverlay({
  missionId,
  state,
  painted,
  failureShown,
  onWait,
  run,
  urlRef,
  hiddenText = 'a página continua aberta — escondida enquanto esta tela está por cima'
}: {
  missionId: string
  state: BrowserPanelState
  /** a medida concluiu que a página está à vista AGORA */
  painted: boolean
  /** a falha da aba à vista toma o lugar da página (`useBrowserFailureWait`) */
  failureShown: boolean
  /** ESPERAR: o dono escolhe olhar a página travada */
  onWait: () => void
  run: BrowserRunner
  /** quem abre o browser quer digitar um endereço: o foco cai na barra */
  urlRef: RefObject<HTMLInputElement | null>
  hiddenText?: string
}): React.JSX.Element | null {
  if (!state.alive) {
    return (
      <div className="dock-browser-empty">
        <span className="dock-browser-empty-line">nenhuma página aberta nesta missão</span>
        <button
          type="button"
          className="dock-browser-open"
          title="abre o browser desta missão numa aba em branco"
          onClick={() => {
            run((api) => api.newTab(missionId))
            urlRef.current?.focus()
          }}
        >
          abrir browser
        </button>
        <span className="dock-browser-empty-fine">
          o agente também abre sozinho, quando o QA visual dele precisa
        </span>
      </div>
    )
  }
  const failure = failureShown ? activeBrowserTabFailure(state) : null
  if (failure) {
    const tab = activeBrowserTab(state)
    const reloading = tab?.loading === true
    const look = browserFailureLook(failure)
    return (
      <div className="dock-browser-empty dock-browser-failure" role="alert">
        <WorkspaceIcon name={look.icon} />
        <span className="dock-browser-failure-title">{browserTabFailureTitle(failure)}</span>
        <span className="dock-browser-empty-line">{failure.text}</span>
        <div className="dock-browser-failure-acts">
          {look.canWait && (
            <button
              type="button"
              className="dock-browser-open quiet"
              title="voltar a mostrar a página e dar mais tempo a ela — o cartão volta se a falha mudar"
              onClick={onWait}
            >
              esperar
            </button>
          )}
          <button
            type="button"
            className="dock-browser-open"
            disabled={reloading}
            title="recarregar a página desta aba"
            onClick={() => run((api) => api.reload(missionId))}
          >
            {reloading ? 'recarregando…' : 'recarregar'}
          </button>
        </div>
        {tab?.url && <span className="dock-browser-empty-fine">{tab.url}</span>}
        {/* O código cru é diagnóstico, não frase: letra miúda, embaixo de tudo. */}
        {failure.code && <span className="dock-browser-failure-code">{failure.code}</span>}
      </div>
    )
  }
  if (painted) return null
  return (
    <div className="dock-browser-empty">
      <span className="dock-browser-empty-line">{hiddenText}</span>
    </div>
  )
}

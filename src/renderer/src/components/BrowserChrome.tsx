import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import {
  BROWSER_NO_API,
  BROWSER_TAB_CAP,
  BROWSER_VIEWPORT_CHOICES,
  activeBrowserTab,
  browserTabLabel,
  browserViewportBand,
  browserViewportHint,
  browserViewportIsCustom,
  browserViewportLabel,
  browserViewportNote,
  browserViewportOf,
  readBrowserAck,
  tabCapNotice,
  trimUrlInput
} from '../dockBrowserModel'
import type { BrowserPanelState, SynkoraApi } from '../../../preload/index'

// O CHROME DO INSTRUMENTO — a tira de abas, a barra e a linha do pé que os DOIS
// hosts do browser da missão usam (fatia P2 do
// `.synkora/reports/DESIGN_BROWSER_POPOUT_2026-08-29.md`).
//
// Por que este arquivo existe: com o ⧉ a mesma página passou a morar em dois
// lugares — o painel do dock (`DockBrowser.tsx`) e a janela própria
// (`BrowserPopout.tsx`). O que muda entre eles é só a MOLDURA e a GEOMETRIA
// (fração da coluna + alça no dock; a janela inteira no pop-out); abas, setas,
// endereço, devtools e barra de status são o MESMO instrumento, e um instrumento
// copiado em dois arquivos vira dois instrumentos diferentes na terceira
// correção.
//
// A LEI DO H7 CONTINUA VALENDO AQUI (reprovação do dono, 2026-08-29: "ta
// estranho esse browser flutuando… ta no vale da estranheza"): UM corpo
// (`.dock-browser-shell`) com UMA borda e UM raio, costuras de fio de cabelo por
// dentro, e NADA de caixa-dentro-de-caixa. Por isso o `children` deste
// componente entra ENTRE a barra e a linha do pé: o retângulo da página é uma
// FAIXA do mesmo corpo, nunca um cartão próprio.
//
// SEM `data-tip` (a divergência declarada da H3): o tooltip da casa nasce 7px
// abaixo do que se aponta e a `WebContentsView` nativa o engoliria inteiro.
// Cada controle escreve sua frase na LINHA DO PÉ, que mora ABAIXO da página e
// aparece no hover E no foco.
//
// Par declarado: `src/preload/index.ts` (api.browser) ↔ `src/main/ipc/browser.ts`.

/** Preload velho (app aberto antes desta versão) não tem `api.browser`. */
export function browserApi(): SynkoraApi['browser'] | null {
  return window.synkora?.browser ?? null
}

/** O que uma alavanca do chrome faz com o motor. O host injeta o executor
 *  (`useBrowserRunner`) porque é ELE quem tem onde mostrar a recusa. */
export type BrowserRunner = (action: (api: SynkoraApi['browser']) => Promise<unknown>) => void

/** Ligação de um controle à barra de status: hover E foco, sempre juntos. */
export interface BrowserHintBinding {
  onMouseEnter: () => void
  onMouseLeave: () => void
  onFocus: () => void
  onBlur: () => void
}

export type BrowserHintBinder = (text: string) => BrowserHintBinding

/**
 * A BARRA DE STATUS: a frase do controle sob o cursor OU sob o foco. Mora num
 * hook porque os dois hosts precisam do mesmo par (o estado e o ligador) — o
 * dock ainda liga a alça, e o pop-out liga o reencaixe.
 */
export function useBrowserHint(): { hint: string | null; hints: BrowserHintBinder } {
  const [hint, setHint] = useState<string | null>(null)
  const hints = useCallback(
    (text: string): BrowserHintBinding => ({
      onMouseEnter: () => setHint(text),
      onMouseLeave: () => setHint((current) => (current === text ? null : current)),
      onFocus: () => setHint(text),
      onBlur: () => setHint((current) => (current === text ? null : current))
    }),
    []
  )
  return { hint, hints }
}

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
      // VERBO QUE AINDA NÃO EXISTE no preload EM EXECUÇÃO. Caso real desta
      // rodada: o ⧉ chega ao app do dono por HMR, mas `api.browser.popOut` só
      // existe no preload NOVO — a chamada joga um `TypeError` na hora, sem
      // promessa nenhuma para o `.catch` de baixo pegar. Sem esta cerca o
      // clique não faria nada e não diria nada, que é a definição de beco sem
      // saída. A recusa nomeia a receita: reiniciar o app.
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

export default function BrowserChrome({
  missionId,
  projectId,
  state,
  hint,
  hints,
  run,
  notify,
  urlRef,
  shellClass,
  tools,
  actions,
  children
}: {
  missionId: string
  /** A SESSÃO (cookies/logins) é do PROJETO — é o que a linha do pé conta. */
  projectId: string
  state: BrowserPanelState
  hint: string | null
  hints: BrowserHintBinder
  run: BrowserRunner
  /** recado do gesto que só o host sabe onde mostrar (ex.: endereço vazio) */
  notify: (text: string | null) => void
  /** O campo de endereço é do host: o convite "abrir browser" (que mora dentro
   *  do retângulo, e portanto fora daqui) põe o foco nele. */
  urlRef: RefObject<HTMLInputElement | null>
  /** classe extra do CORPO (o pop-out tira borda e raio: ele É a janela) */
  shellClass?: string
  /** controles do host DENTRO do grupo de glifos (o ⧉ do dock) */
  tools?: ReactNode
  /** ação do host no FIM da barra (o reencaixe do pop-out) */
  actions?: ReactNode
  /** o retângulo da página (e, no dock, a alça): FAIXA do mesmo corpo */
  children: ReactNode
}): React.JSX.Element {
  const tab = activeBrowserTab(state)
  const capNotice = tabCapNotice(state.tabs.length)
  // A LARGURA QUE A PÁGINA ENXERGA. Ela mora AQUI, e não em cada host, porque a
  // pergunta é a mesma nos dois: o painel do dock é estreito e a janela
  // destacada é larga, mas em ambos o dono precisa poder dizer "me mostre isto
  // como desktop" — e VER quando foi o agente que disse.
  const viewport = browserViewportOf(state)
  const viewportNote = browserViewportNote(state)
  // A barra de endereço só é do DONO enquanto ele está nela: fora do foco, ela
  // conta a URL da aba ativa. Sem esta separação, uma navegação do AGENTE
  // apagaria o que ele estivesse digitando (e ele PODE assumir quando quiser).
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
    // Sem aba ativa o gesto ABRE o browser: pedir `navigate` a uma missão sem
    // view seria contar com o motor adivinhando o que o dono quis.
    if (tab) run((api) => api.navigate(missionId, url))
    else run((api) => api.newTab(missionId, url))
  }, [draft, missionId, notify, run, tab, urlRef])

  const urlValue = editing ? draft : (tab?.url ?? '')
  const urlHint = tab ? 'endereço · Enter navega' : 'endereço · Enter abre o browser'
  // O campo é o único controle que precisa fazer DUAS coisas no foco (assumir o
  // rascunho e escrever na barra de status): a ligação é lida uma vez e chamada
  // no meio dos dois gestos.
  const urlHints = hints(urlHint)

  return (
    <div className={shellClass ? `dock-browser-shell ${shellClass}` : 'dock-browser-shell'}>
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
        {/* O ⧉ do dock entra AQUI, no grupo de glifos: no trilho de 176px a
            fileira já quebra depois do quarto botão, e um controle depois do
            campo de endereço nasceria numa terceira linha só dele. */}
        {tools}
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
          onMouseEnter={urlHints.onMouseEnter}
          onMouseLeave={urlHints.onMouseLeave}
          onFocus={() => {
            setDraft(tab?.url ?? '')
            setEditing(true)
            urlHints.onFocus()
          }}
          onBlur={() => {
            setEditing(false)
            urlHints.onBlur()
          }}
        />
        {actions}
      </div>

      {/* A LARGURA QUE A PÁGINA ENXERGA (2026-08-29 — "ta meio limitado o quanto
          consigo deixar ele maior, meio que sempre vou ver o site/app com modo
          tablet"). O painel é estreito; sem isto todo site responsivo entrega o
          layout de celular. Esta fileira é uma FAIXA do mesmo corpo (a lei do
          H7: uma borda, um raio, costuras de fio de cabelo) — nunca um cartão
          próprio —, e mora colada na página porque é dela que ela fala.

          É o MESMO estado que a tool `browser_viewport` do agente escreve: com
          ele conferindo uma tela em desktop, o botão 1280 acende aqui sozinho. */}
      <div
        className="dock-browser-vp"
        role="group"
        aria-label="largura que a página enxerga"
      >
        {BROWSER_VIEWPORT_CHOICES.map((mode) => (
          <button
            key={String(mode)}
            type="button"
            className={`dock-browser-vp-btn${viewport === mode ? ' on' : ''}`}
            aria-pressed={viewport === mode}
            disabled={!state.alive}
            onClick={() => run((api) => api.setViewportMode(missionId, mode))}
            {...hints(
              state.alive
                ? browserViewportHint(mode)
                : 'abra uma página (+) antes de mudar a largura'
            )}
          >
            {browserViewportLabel(mode)}
          </button>
        ))}
        {/* O AGENTE pode pedir uma largura que não é botão nenhum (`width` da
            tool). Sem esta ficha, o dono olharia uma página emulada com os
            quatro botões apagados e nenhuma explicação. */}
        {browserViewportIsCustom(viewport) && (
          <span
            className="dock-browser-vp-custom"
            {...hints(`o agente pediu ${viewport}px lógicos · AUTO devolve a largura do painel`)}
          >
            {browserViewportLabel(viewport)}
          </span>
        )}
        {/* O piso de zoom do Chromium (0,25×, medido na sonda): num painel
            estreito demais a página recebe MENOS do que se pediu. Mostrar
            "1280" aceso ao lado de uma página de 1200 seria o seletor mentindo.
            A nota QUEBRA para uma linha própria dentro da mesma faixa — a
            moldura da página continua sendo a linha ink de baixo. */}
        {viewportNote && <span className="dock-browser-vp-note">// {viewportNote}</span>}
      </div>

      {children}

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
    </div>
  )
}

/**
 * AS FAIXAS DA MOLDURA DE DISPOSITIVO (2026-08-29 — ordem do dono, ao vivo:
 * *"Quando estiver destacado e eu colocar opções menores, poderia colocar bordas
 * brancas ou pretas do lado, para que não tenha scroll bar, se não, como vou
 * saber se ta quebrando de vdd ou é o app"*).
 *
 * Com a largura pedida CABENDO na moldura, o motor põe a view em tamanho REAL e
 * CENTRALIZADA (`viewportViewRect`, medido na sonda §P10) — o que sobra do
 * retângulo é o painel escuro do app aparecendo dos dois lados. Este componente
 * não INVENTA essa faixa: ele a MARCA, com uma costura de fio de cabelo na borda
 * exata da página, porque um site de fundo escuro se confundiria com o painel e
 * a pergunta do dono continuaria sem resposta.
 *
 * A repartição de trabalho — e ela é o ponto:
 *  · **a geometria é CSS** (`calc((100% - min(100%, largura)) / 2)`), calculada
 *    pelo layout a cada quadro. Num arrasto da alça a faixa re-centraliza junto
 *    com a página, sem degrau e sem um único render do React;
 *  · **o estado só diz SE existe faixa** (`viewportBand`, que viaja no
 *    `browser:changed` coalescido). Ele pode atrasar um quadro ou dois na
 *    travessia — e no instante em que a moldura cruza a largura pedida a faixa
 *    tem ZERO px, então o atraso é literalmente invisível.
 *
 * Elas NUNCA comem clique (`pointer-events: none`) e nunca cobrem a página: a
 * `WebContentsView` compõe ACIMA de todo este DOM.
 */
export function BrowserPageBands({
  state,
  painted
}: {
  state: BrowserPanelState
  /** a medida concluiu que a página está à vista AGORA — sem view por cima não
   *  há borda de página para marcar, e duas listras num retângulo vazio só
   *  fariam o dono procurar o que elas emolduram */
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
 * dele — o convite (nenhuma página aberta) e a explicação de por que a página
 * sumiu. O retângulo em si é do HOST (ele é quem sabe a própria geometria); só
 * o conteúdo é comum.
 */
export function BrowserPageOverlay({
  state,
  painted,
  hints,
  onOpen,
  hiddenText = 'a página continua aberta — escondida enquanto esta tela está por cima'
}: {
  state: BrowserPanelState
  /** a medida concluiu que a página está à vista AGORA */
  painted: boolean
  hints: BrowserHintBinder
  onOpen: () => void
  hiddenText?: string
}): React.JSX.Element | null {
  if (!state.alive) {
    return (
      <div className="dock-browser-empty">
        <span className="dock-browser-empty-line">nenhuma página aberta nesta missão</span>
        <button
          type="button"
          className="dock-browser-open"
          onClick={onOpen}
          {...hints('abre o browser desta missão numa aba em branco')}
        >
          abrir browser
        </button>
        <span className="dock-browser-empty-fine">
          o agente também abre sozinho, quando o QA visual dele precisa
        </span>
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

import { useEffect } from 'react'
import { useStore, type PaneKind, type PaneOptions } from './store'
import PanesView from './components/PanesView'
import TooltipLayer from './components/Tooltip'
import { guiApi } from './guiApi'
import { getSynVoiceTarget } from './synVoiceTarget'
import { TERMINAL_DEFAULT_FONT_SIZE } from './terminalGeometry'
import { installGlobalGuiEscape, requestActiveGuiEscape } from './guiEscape'
import GuiQueueDispatcher from './components/GuiQueueDispatcher'

/**
 * PANESAPP — raiz do renderer da WebContentsView de panes (Fase 3,
 * docs/FASE3_PLANO.md). Este processo é o DONO da montagem dos panes de
 * execução: os TerminalPanes daqui criam os PTYs (o main faz unicast de
 * pty:data para quem criou — a divisão do parse é automática). O host mantém
 * só um ESPELHO da lista, alimentado pelos mesmos eventos broadcast.
 *
 * Diferenças deliberadas para o App do host:
 * - ZERO sons (notify é exclusivo do host — throttles são por processo e
 *   assinatura dupla daria plim dobrado, D6 do plano);
 * - `panes:live` (reidratação dos PTYs vivos pós-reload) mora AQUI: repopular
 *   a lista o host também faz, mas quem re-monta terminal é esta view;
 * - o estado de shell (openProject/montados/nonce) vem por push do host via
 *   main (`panes-view:state`, cacheado — reload re-hidrata sozinho);
 * - a "aba" do projeto ativo é sempre 'panes' (applyHostViewState) — é o que
 *   liga atalhos/keepalive do PanesView sem um Universe em volta.
 */
export default function PanesApp(): React.JSX.Element {
  const openProjectId = useStore((s) => s.openProjectId)
  const mountedProjects = useStore((s) => s.mountedProjects)
  const remountNonce = useStore((s) => s.remountNonce)
  const projects = useStore((s) => s.projects)

  const bridgeOk = typeof window.synkora !== 'undefined'

  useEffect(() => {
    const uninstall = installGlobalGuiEscape()
    const offRelay = window.synkora.panesView.onGuiEscape(() => requestActiveGuiEscape())
    return () => {
      offRelay()
      uninstall()
    }
  }, [])

  useEffect(() => {
    if (!bridgeOk) return
    const st = useStore.getState()
    void st.loadProjects()
    void st.loadSeats()
    void st.loadSettings()

    const offState = window.synkora.panesView.onState((state) => {
      const prev = useStore.getState().openProjectId
      useStore.getState().applyHostViewState(state)
      if (state.openProjectId && state.openProjectId !== prev) {
        void useStore.getState().loadTasks(state.openProjectId)
        void useStore.getState().loadMissions(state.openProjectId)
      }
    })
    const offShown = window.synkora.panesView.onShown((shown) =>
      useStore.getState().setPanesViewShown(shown)
    )

    // Mesmas assinaturas de estado do host — sem os efeitos sonoros.
    const offPaneOpen = window.synkora.tasks.onPaneOpen((projectId, taskId, spec) =>
      useStore.getState().openDevPane(projectId, taskId, spec)
    )
    const offPaneClose = window.synkora.tasks.onPaneClose((projectId, taskId, role) =>
      useStore.getState().closeTaskPane(projectId, taskId, role)
    )
    // Pane sem fase (agente livre/test server): nasce por evento do main e é
    // MONTADO aqui — esta view é a dona da montagem (F3-c3).
    const offOpenFree = window.synkora.panes.onOpenFree
      ? window.synkora.panes.onOpenFree((projectId, kind, opts) =>
          useStore.getState().addPane(projectId, kind as PaneKind, opts as PaneOptions)
        )
      : () => undefined
    const offCloseById = window.synkora.tasks.onPaneCloseById((projectId, paneId) =>
      useStore.getState().closePane(projectId, paneId)
    )
    const offAttention = window.synkora.tasks.onAttention((taskId, paneId) =>
      useStore.getState().setTaskAttention(taskId, paneId)
    )
    const offStats = window.synkora.pty.onStats(useStore.getState().setPaneStats)
    const offEffort = window.synkora.pty.onEffort
      ? window.synkora.pty.onEffort(useStore.getState().setPaneEffort)
      : () => undefined
    const offModel = window.synkora.pty.onModel
      ? window.synkora.pty.onModel(useStore.getState().setPaneModel)
      : () => undefined
    const offLastLines = window.synkora.pty.onLastLines
      ? window.synkora.pty.onLastLines(useStore.getState().setPaneLastLines)
      : () => undefined
    const offTasks = window.synkora.tasks.onChanged((projectId) => {
      if (useStore.getState().openProjectId === projectId)
        void useStore.getState().loadTasks(projectId)
    })
    const offMissions = window.synkora.missions.onChanged((projectId) => {
      if (useStore.getState().openProjectId === projectId)
        void useStore.getState().loadMissions(projectId)
    })
    const offProjects = window.synkora.projects.onFlowChanged(
      () => void useStore.getState().loadProjects()
    )
    const offSeats = window.synkora.seats.onChanged(
      () => void useStore.getState().loadSeats()
    )
    // F3-c4: zoom de fonte gravado no host chega aqui (e vice-versa).
    const offSettings = window.synkora.settings.onChanged
      ? window.synkora.settings.onChanged(() => void useStore.getState().loadSettings())
      : () => undefined
    // F3-c5: transcrição do SynVoice (host) para o terminal focado DAQUI — o
    // registry local resolve o alvo; sem alvo válido, clipboard (o banquinho
    // do host já guardou o texto de qualquer forma).
    const offVoicePaste = window.synkora.panesView.onVoicePaste
      ? window.synkora.panesView.onVoicePaste((text) => {
          const target = getSynVoiceTarget()
          if (target) {
            target.insert(text)
            target.focus()
          } else {
            void navigator.clipboard.writeText(text).catch(() => undefined)
          }
        })
      : () => undefined
    // ESPELHO PASSIVO DAS CONVERSAS (2.0): o mapa desta view precisa saber se
    // a missão direta está trabalhando, mas quem MONTA o chat dela é o HOST
    // (board) — aqui não existe GuiPane para assinar o canal. `gui:live` é
    // pushAll, então o estado chega; só não tinha quem o guardasse.
    // GUARDA: pane que ESTA view monta como chat (surface 'gui' no deck) já
    // aplica o evento por conta própria — aplicar de novo duplicaria a
    // conversa inteira.
    const offGuiLive = guiApi.onLive((payload) => {
      if (!payload?.paneId) return
      const state = useStore.getState()
      const mountedHere = Object.values(state.panesByProject).some((list) =>
        list.some((pane) => pane.id === payload.paneId && pane.surface === 'gui')
      )
      if (mountedHere) return
      state.handleGuiLive(payload.paneId, payload.evt)
    })

    // Reidratação pós-reload: os PTYs sobrevivem no main; remontar aqui faz o
    // pty:create rebindar o webContents NOVO (sem isto o stream cai no vazio).
    let disposed = false
    void window.synkora.panes.live().then((livePanes) => {
      if (disposed) return
      for (const pane of livePanes) {
        useStore.getState().openDevPane(pane.projectId, pane.taskId, pane.spec)
      }
    }).catch((error: unknown) => {
      console.error('[panes-view] falha ao reidratar panes vivos', error)
    })

    return () => {
      disposed = true
      offState()
      offShown()
      offPaneOpen()
      offPaneClose()
      offOpenFree()
      offCloseById()
      offAttention()
      offStats()
      offEffort()
      offModel()
      offLastLines()
      offTasks()
      offMissions()
      offProjects()
      offSeats()
      offSettings()
      offVoicePaste()
      offGuiLive()
    }
  }, [bridgeOk])

  // Zoom de fonte do terminal — o mesmo atalho do host, agindo localmente
  // (teclado só chega à view focada; o sync do valor vem por settings).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey) return
      const action =
        event.key === '-' || event.code === 'NumpadSubtract'
          ? -1
          : event.key === '+' || event.key === '=' || event.code === 'NumpadAdd'
            ? 1
            : event.key === '0' || event.code === 'Numpad0'
              ? 0
              : null
      if (action === null) return
      event.preventDefault()
      const state = useStore.getState()
      const current = state.settings?.terminalFontSize ?? TERMINAL_DEFAULT_FONT_SIZE
      const next = action === 0 ? TERMINAL_DEFAULT_FONT_SIZE : Math.max(8, Math.min(24, current + action))
      if (next !== current) void state.patchSettings({ terminalFontSize: next })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  if (!bridgeOk) {
    return (
      <div className="bridge-warning">
        Esta interface precisa rodar dentro do Electron (<code>npm run dev</code>).
      </div>
    )
  }

  // Mesma regra do host: projetos visitados ficam MONTADOS (keepalive) — os
  // panes de fundo continuam medidos e vivos ao trocar de projeto.
  return (
    <div className="app-shell panes-view-shell">
      <GuiQueueDispatcher />
      <TooltipLayer />
      {mountedProjects.map((id) => {
        const project = projects.find((p) => p.id === id)
        if (!project) return null
        return (
          <div
            key={`${id}:${remountNonce[id] ?? 0}`}
            className={`app-view app-view-keepalive${openProjectId === id ? ' is-active' : ''}`}
            aria-hidden={openProjectId === id ? undefined : true}
            inert={openProjectId === id ? undefined : true}
          >
            <PanesView projectId={id} projectPath={project.path} />
          </div>
        )
      })}
    </div>
  )
}

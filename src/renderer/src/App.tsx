import { useEffect } from 'react'
import { useStore, type PaneKind, type PaneOptions } from './store'
import { queueMarkdownOpen } from './projectFileNavigation'
import { playAttentionChime, playSoftBlip } from './notify'
import Home from './screens/Home'
import Universe from './screens/Universe'
import Settings from './screens/Settings'
import ProjectRail from './components/ProjectRail'
import TitleBar from './components/TitleBar'
import TooltipLayer from './components/Tooltip'
import GuiPanelErrorBoundary from './components/GuiPanelErrorBoundary'
import { TERMINAL_DEFAULT_FONT_SIZE } from './terminalGeometry'
import { installGlobalGuiEscape } from './guiEscape'
import { guiApi } from './guiApi'
import GuiQueueDispatcher from './components/GuiQueueDispatcher'
import CommandPalette from './components/CommandPalette'

export default function App(): React.JSX.Element {
  const openProjectId = useStore((s) => s.openProjectId)
  const appPage = useStore((s) => s.appPage)
  const mountedProjects = useStore((s) => s.mountedProjects)
  const remountNonce = useStore((s) => s.remountNonce)
  const loadProjects = useStore((s) => s.loadProjects)
  const loadSeats = useStore((s) => s.loadSeats)
  const loadSettings = useStore((s) => s.loadSettings)
  const openProject = useStore((s) => s.openProject)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const setMissionTab = useStore((s) => s.setMissionTab)

  const bridgeOk = typeof window.synkora !== 'undefined'

  const appendMaestroEvent = useStore((s) => s.appendMaestroEvent)
  const setMaestroCtx = useStore((s) => s.setMaestroCtx)
  const handleMaestroLive = useStore((s) => s.handleMaestroLive)
  const openDevPane = useStore((s) => s.openDevPane)
  const closeTaskPane = useStore((s) => s.closeTaskPane)
  const setTaskAttention = useStore((s) => s.setTaskAttention)
  const setPaneStats = useStore((s) => s.setPaneStats)
  const closePane = useStore((s) => s.closePane)

  useEffect(() => {
    if (!bridgeOk) return
    void loadProjects().then(() => {
      // perguntas do ask_user persistem no main — reidrata TODOS os projetos
      // para o rail/abas pulsarem desde o boot (não só o board aberto)
      for (const p of useStore.getState().projects) {
        void useStore.getState().loadAskQuestions(p.id)
      }
    })
    void loadSeats()
    void loadSettings()
    const offEvent = window.synkora.maestro.onEvent(appendMaestroEvent)
    const offCtx = window.synkora.maestro.onCtx(setMaestroCtx)
    const offLive = window.synkora.maestro.onLive(handleMaestroLive)
    const offPaneOpen = window.synkora.tasks.onPaneOpen((projectId, taskId, spec) => {
      // blip fraquinho de marco: o ouvido sabe que um gate entrou sem olhar
      if (spec.role === 'review') playSoftBlip('review')
      else if (spec.role === 'qa') playSoftBlip('qa')
      openDevPane(projectId, taskId, spec)
    })
    // missão/card integrado = nota de conclusão (bem baixa, throttle próprio)
    const offHubSound = window.synkora.hub.onEvent((evt) => {
      if (evt.kind === 'merge') playSoftBlip('done')
    })
    // Alerta canônico vem somente ao host; a WebContentsView nunca toca áudio.
    const offGuiAlert = guiApi.onAlert(({ kind }) => {
      if (useStore.getState().settings?.chatSoundsEnabled === false) return
      if (kind === 'needs-you') playAttentionChime()
      else if (kind === 'finished') playSoftBlip('done')
    })
    // O WebContents e os PTYs do main sobrevivem a um reload do renderer, mas
    // o store React nasce vazio. Assinamos o evento primeiro para fechar a
    // janela de corrida e reaplicamos o snapshot pelo MESMO openDevPane usado
    // por `panes:open`; ele já deduplica paneId/fase.
    let disposed = false
    void window.synkora.panes.live().then((livePanes) => {
      if (disposed) return
      for (const pane of livePanes) {
        openDevPane(pane.projectId, pane.taskId, pane.spec)
      }
    }).catch((error: unknown) => {
      // Compatibilidade limpa durante atualização parcial (renderer novo com
      // main antigo): a assinatura de eventos continua funcionando.
      console.error('[panes] falha ao reidratar panes vivos', error)
    })
    // F3-c3: pane sem fase (agente livre/test server) nasce por evento do
    // main — aqui só o ESPELHO da lista (quem monta é a view de panes).
    const offOpenFree = window.synkora.panes.onOpenFree
      ? window.synkora.panes.onOpenFree((projectId, kind, opts) =>
          useStore.getState().addPane(projectId, kind as PaneKind, opts as PaneOptions)
        )
      : () => undefined
    const offPaneClose = window.synkora.tasks.onPaneClose(closeTaskPane)
    const offAttention = window.synkora.tasks.onAttention((taskId, paneId) => {
      // plim SÓ na transição para "esperando" — repetição do evento não re-toca
      const s = useStore.getState()
      const isNew = paneId ? !s.paneAttention[paneId] : !s.taskAttention[taskId]
      if (isNew) playAttentionChime()
      setTaskAttention(taskId, paneId)
    })
    // ask_user é GLOBAL (rail + abas pulsam mesmo com outro projeto aberto);
    // o plim toca na chegada de pergunta nova.
    const offUserQuestion = window.synkora.maestro.onUserQuestion?.(
      (pid, missionKey, question) => {
        const current = useStore.getState().askQuestions[pid]?.[missionKey]
        useStore.getState().noteUserQuestion(pid, missionKey, question)
        if (current !== question) playAttentionChime()
      }
    ) ?? (() => undefined)
    const offStats = window.synkora.pty.onStats(setPaneStats)
    const offEffort = window.synkora.pty.onEffort
      ? window.synkora.pty.onEffort(useStore.getState().setPaneEffort)
      : () => undefined
    const offModel = window.synkora.pty.onModel
      ? window.synkora.pty.onModel(useStore.getState().setPaneModel)
      : () => undefined
    const offLastLines = window.synkora.pty.onLastLines
      ? window.synkora.pty.onLastLines(useStore.getState().setPaneLastLines)
      : () => undefined
    const offCloseById = window.synkora.tasks.onPaneCloseById(closePane)
    const offSeats = window.synkora.seats.onChanged(() => void loadSeats())
    const offProjectFlow = window.synkora.projects.onFlowChanged(() => void loadProjects())
    const offProgressTarget = window.synkora.progress.onOpenTarget(({ projectId, missionId }) => {
      openProject(projectId)
      setUniverseTab(projectId, 'board')
      setMissionTab(projectId, missionId ?? null)
    })
    window.synkora.progress.ready()
    // PM pode redefinir o kit ★ por função (set_default_skills) — as
    // estrelas da página ✦ geral acompanham na hora.
    const offPolicies = window.synkora.policies.onChanged(
      (projectId) => void useStore.getState().loadPolicies(projectId)
    )
    // ——— F3-c4: costuras vindas da view de panes (via main) ———
    const offFilesNav = window.synkora.files.onNavigate
      ? window.synkora.files.onNavigate((projectId, result) => {
          if (!result.ok || result.action !== 'markdown') return
          queueMarkdownOpen(projectId, result)
          useStore.getState().setUniverseTab(projectId, 'arquivos')
        })
      : () => undefined
    const offSettings = window.synkora.settings.onChanged
      ? window.synkora.settings.onChanged(() => void useStore.getState().loadSettings())
      : () => undefined
    return () => {
      disposed = true
      offFilesNav()
      offSettings()
      offOpenFree()
      offPolicies()
      offProgressTarget()
      offProjectFlow()
      offSeats()
      offStats()
      offEffort()
      offModel()
      offLastLines()
      offCloseById()
      offEvent()
      offCtx()
      offLive()
      offPaneOpen()
      offHubSound()
      offGuiAlert()
      offPaneClose()
      offAttention()
      offUserQuestion()
    }
  }, [bridgeOk, loadProjects, loadSeats, loadSettings, openProject, setUniverseTab, setMissionTab, appendMaestroEvent, setMaestroCtx, handleMaestroLive, openDevPane, closeTaskPane, setTaskAttention, setPaneStats, closePane])

  // Esc pertence ao CHAT ativo mesmo quando o foco está na lateral/header.
  // O registro dá prioridade ao card de pergunta e aos menus do composer.
  // Até a purga F6 (2026-08-17) havia um relay para a WebContentsView do
  // canvas de panes; com a ilha morta, o registry local resolve sozinho.
  useEffect(() => installGlobalGuiEscape(), [])

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

  // Universos visitados ficam MONTADOS e medidos em segundo plano — trocar de
  // projeto não derruba panes/maestro nem deixa PTY numa geometria antiga.
  return (
    <div className="app-shell">
      <GuiPanelErrorBoundary paneId="app:queue-dispatcher" label="a fila de conversas">
        <GuiQueueDispatcher />
      </GuiPanelErrorBoundary>
      <GuiPanelErrorBoundary paneId="app:command-palette" label="a paleta de comandos">
        <CommandPalette />
      </GuiPanelErrorBoundary>
      <GuiPanelErrorBoundary paneId="app:tooltip-layer" label="as dicas">
        <TooltipLayer />
      </GuiPanelErrorBoundary>
      <GuiPanelErrorBoundary paneId="app:titlebar" label="a barra de título">
        <TitleBar />
      </GuiPanelErrorBoundary>
      <div className="app-body">
        <GuiPanelErrorBoundary paneId="app:project-rail" label="a navegação dos universos">
          <ProjectRail />
        </GuiPanelErrorBoundary>
        <main className="app-main">
          {appPage === 'settings' && (
            <div className="app-view">
              <GuiPanelErrorBoundary paneId="app:settings" label="as configurações">
                <Settings />
              </GuiPanelErrorBoundary>
            </div>
          )}
          <div
            className="app-view"
            style={{ display: appPage === 'workspace' && openProjectId === null ? 'flex' : 'none' }}
          >
            <GuiPanelErrorBoundary paneId="app:home" label="a Home">
              <Home />
            </GuiPanelErrorBoundary>
          </div>
          {mountedProjects.map((id) => (
            <div
              key={id}
              className={`app-view app-view-keepalive${
                appPage === 'workspace' && openProjectId === id ? ' is-active' : ''
              }`}
              aria-hidden={appPage === 'workspace' && openProjectId === id ? undefined : true}
              inert={appPage === 'workspace' && openProjectId === id ? undefined : true}
            >
              {/* chave própria: relocar a pasta troca o nonce e o universo
                  remonta no cwd novo SEM sair de mountedProjects (sem o id na
                  lista ninguém renderizava e a área central ficava em branco) */}
              <Universe key={`${id}:${remountNonce[id] ?? 0}`} projectId={id} />
            </div>
          ))}
        </main>
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { useStore, type PaneKind, type PaneOptions } from './store'
import { queueMarkdownOpen } from './projectFileNavigation'
import { queueProgressOpen } from './progressNavigation'
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
import { eligibleDockMission, useBrowserDockVisibility } from './useBrowserDockVisibility'

export default function App(): React.JSX.Element {
  const dockMissionId = useStore(eligibleDockMission)
  useBrowserDockVisibility(dockMissionId)
  const openProjectId = useStore((s) => s.openProjectId)
  const appPage = useStore((s) => s.appPage)
  const mountedProjects = useStore((s) => s.mountedProjects)
  const remountNonce = useStore((s) => s.remountNonce)
  const loadProjects = useStore((s) => s.loadProjects)
  const loadSeats = useStore((s) => s.loadSeats)
  const loadSettings = useStore((s) => s.loadSettings)
  const openProject = useStore((s) => s.openProject)
  const setUniverseTab = useStore((s) => s.setUniverseTab)

  const bridgeOk = typeof window.synkora !== 'undefined'

  const setPaneStats = useStore((s) => s.setPaneStats)
  const closePane = useStore((s) => s.closePane)

  useEffect(() => {
    if (!bridgeOk) return
    void loadProjects()
    void loadSeats()
    void loadSettings()
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
    // Pane sem fase (agente livre/test server) nasce por evento do main.
    const offOpenFree = window.synkora.panes.onOpenFree
      ? window.synkora.panes.onOpenFree((projectId, kind, opts) =>
          useStore.getState().addPane(projectId, kind as PaneKind, opts as PaneOptions)
        )
      : () => undefined
    // ...e MORRE pelo mesmo canal (R11 — o bug da aba eterna: o main ecoava o
    // fecho e ninguém ouvia; a aba do teste ficava na tela com o processo já
    // morto). O optional chaining cobre preload antigo em janela viva.
    const offCloseById = window.synkora.panes.onCloseById
      ? window.synkora.panes.onCloseById((projectId, paneId) =>
          useStore.getState().closePane(projectId, paneId)
        )
      : () => undefined
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
    const offSeats = window.synkora.seats.onChanged(() => void loadSeats())
    const offProjectFlow = window.synkora.projects.onFlowChanged(() => void loadProjects())
    let progressNavigationEpoch = 0
    const offProgressTarget = window.synkora.progress.onOpenTarget((target) => {
      const epoch = ++progressNavigationEpoch
      openProject(target.projectId)
      setUniverseTab(target.projectId, 'board')
      void useStore.getState().loadMissions(target.projectId).then(() => {
        if (epoch !== progressNavigationEpoch || useStore.getState().openProjectId !== target.projectId) return
        queueProgressOpen(target)
      }).catch(() => {
        if (epoch !== progressNavigationEpoch || useStore.getState().openProjectId !== target.projectId) return
        queueProgressOpen({ projectId: target.projectId, destination: 'project' })
      })
    })
    window.synkora.progress.ready()
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
      offFilesNav()
      offSettings()
      offOpenFree()
      offCloseById()
      offProgressTarget()
      progressNavigationEpoch++
      offProjectFlow()
      offSeats()
      offStats()
      offEffort()
      offModel()
      offLastLines()
      offHubSound()
      offGuiAlert()
    }
  }, [bridgeOk, loadProjects, loadSeats, loadSettings, openProject, setUniverseTab, setPaneStats])

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

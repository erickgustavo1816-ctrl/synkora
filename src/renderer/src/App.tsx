import { useEffect } from 'react'
import { useStore } from './store'
import { playAttentionChime, playSoftBlip } from './notify'
import Home from './screens/Home'
import Universe from './screens/Universe'
import Settings from './screens/Settings'
import ProjectRail from './components/ProjectRail'
import TitleBar from './components/TitleBar'
import TooltipLayer from './components/Tooltip'
import { TERMINAL_DEFAULT_FONT_SIZE } from './terminalGeometry'

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
    // Biblioteca de skills (F4): global à máquina — carrega uma vez e
    // acompanha instalações/updates feitos em qualquer tela.
    void useStore.getState().loadSkills()
    const offSkills = window.synkora.skills.onChanged(() => void useStore.getState().loadSkills())
    // PM pode redefinir o kit ★ por função (set_default_skills) — as
    // estrelas da página ✦ geral acompanham na hora.
    const offPolicies = window.synkora.policies.onChanged(
      (projectId) => void useStore.getState().loadPolicies(projectId)
    )
    return () => {
      disposed = true
      offPolicies()
      offProgressTarget()
      offProjectFlow()
      offSkills()
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
      offPaneClose()
      offAttention()
      offUserQuestion()
    }
  }, [bridgeOk, loadProjects, loadSeats, loadSettings, openProject, setUniverseTab, setMissionTab, appendMaestroEvent, setMaestroCtx, handleMaestroLive, openDevPane, closeTaskPane, setTaskAttention, setPaneStats, closePane])

  // ——— FASE 3: o host comanda a WebContentsView do canvas ———
  // Efeito CENTRAL de layout: compõe visibilidade (workspace + aba panes do
  // projeto ativo + nenhum overlay global aberto) com o rect do placeholder.
  // Quem manda o {visible:false} quando se vai à Home/Settings é ESTE efeito —
  // um efeito por-Universe não cobre "nenhum universo ativo".
  const panesTab = useStore((s) =>
    s.openProjectId ? (s.universeTabByProject[s.openProjectId] ?? 'board') : null
  )
  const panesAnchor = useStore((s) =>
    s.openProjectId ? (s.panesAnchorByProject[s.openProjectId] ?? null) : null
  )
  const hostOverlayCount = useStore((s) => s.hostOverlayCount)
  useEffect(() => {
    if (!bridgeOk) return
    const visible =
      appPage === 'workspace' &&
      openProjectId !== null &&
      panesTab === 'panes' &&
      hostOverlayCount === 0 &&
      panesAnchor !== null
    window.synkora.panesView.layout({
      visible,
      bounds: panesAnchor ?? { x: 0, y: 0, width: 0, height: 0 }
    })
  }, [bridgeOk, appPage, openProjectId, panesTab, hostOverlayCount, panesAnchor])

  // Recorte de estado de shell que a view precisa (cacheado no main — o
  // reload/crash da view re-hidrata sem o host perceber).
  const mountedForView = useStore((s) => s.mountedProjects)
  const remountNonceForView = useStore((s) => s.remountNonce)
  useEffect(() => {
    if (!bridgeOk) return
    window.synkora.panesView.state({
      openProjectId,
      mountedProjects: mountedForView,
      remountNonce: remountNonceForView
    })
  }, [bridgeOk, openProjectId, mountedForView, remountNonceForView])

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
      <TooltipLayer />
      <TitleBar />
      <div className="app-body">
        <ProjectRail />
        <main className="app-main">
          {appPage === 'settings' && (
            <div className="app-view">
              <Settings />
            </div>
          )}
          <div
            className="app-view"
            style={{ display: appPage === 'workspace' && openProjectId === null ? 'flex' : 'none' }}
          >
            <Home />
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

import { useEffect } from 'react'
import { useStore } from './store'
import Home from './screens/Home'
import Universe from './screens/Universe'

export default function App(): React.JSX.Element {
  const openProjectId = useStore((s) => s.openProjectId)
  const loadProjects = useStore((s) => s.loadProjects)
  const loadSeats = useStore((s) => s.loadSeats)

  const bridgeOk = typeof window.synkora !== 'undefined'

  const appendMaestroEvent = useStore((s) => s.appendMaestroEvent)
  const setMaestroCtx = useStore((s) => s.setMaestroCtx)
  const handleMaestroLive = useStore((s) => s.handleMaestroLive)
  const handleRunEvent = useStore((s) => s.handleRunEvent)
  const handleRunLive = useStore((s) => s.handleRunLive)
  const openDevPane = useStore((s) => s.openDevPane)
  const closeTaskPane = useStore((s) => s.closeTaskPane)
  const applyTaskFeedback = useStore((s) => s.applyTaskFeedback)
  const setTaskAttention = useStore((s) => s.setTaskAttention)

  useEffect(() => {
    if (!bridgeOk) return
    void loadProjects()
    void loadSeats()
    const offEvent = window.synkora.maestro.onEvent(appendMaestroEvent)
    const offCtx = window.synkora.maestro.onCtx(setMaestroCtx)
    const offLive = window.synkora.maestro.onLive(handleMaestroLive)
    const offRunEvent = window.synkora.tasks.onRunEvent(handleRunEvent)
    const offRunLive = window.synkora.tasks.onRunLive(handleRunLive)
    const offPaneOpen = window.synkora.tasks.onPaneOpen(openDevPane)
    const offPaneClose = window.synkora.tasks.onPaneClose(closeTaskPane)
    const offFeedback = window.synkora.tasks.onFeedback(applyTaskFeedback)
    const offAttention = window.synkora.tasks.onAttention(setTaskAttention)
    return () => {
      offEvent()
      offCtx()
      offLive()
      offRunEvent()
      offRunLive()
      offPaneOpen()
      offPaneClose()
      offFeedback()
      offAttention()
    }
  }, [bridgeOk, loadProjects, loadSeats, appendMaestroEvent, setMaestroCtx, handleMaestroLive, handleRunEvent, handleRunLive, openDevPane, closeTaskPane, applyTaskFeedback, setTaskAttention])

  if (!bridgeOk) {
    return (
      <div className="bridge-warning">
        Esta interface precisa rodar dentro do Electron (<code>npm run dev</code>).
      </div>
    )
  }

  return openProjectId ? <Universe projectId={openProjectId} /> : <Home />
}

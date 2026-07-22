import { useStore } from '../store'
import { hueOf } from '../util'
import TerminalPane from './TerminalPane'
import RunPanel from './RunPanel'
import { DEPT_BY_KEY } from '../departments'

interface Props {
  projectId: string
  projectPath: string
}

// Referência estável: `?? []` no seletor criaria um array novo a cada render,
// e o zustand entraria em loop infinito de re-render.
const NO_PANES: never[] = []

export default function PanesView({ projectId, projectPath }: Props): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const panes = useStore((s) => s.panesByProject[projectId] ?? NO_PANES)
  const closePane = useStore((s) => s.closePane)
  const taskRuns = useStore((s) => s.taskRuns)
  const tasks = useStore((s) => s.tasks)
  const closeRun = useStore((s) => s.closeRun)
  const handoffRun = useStore((s) => s.handoffRun)
  const taskAttention = useStore((s) => s.taskAttention)
  const clearTaskAttention = useStore((s) => s.clearTaskAttention)

  const runIds = Object.keys(taskRuns)

  if (panes.length === 0 && runIds.length === 0) {
    return (
      <div className="ws-empty">
        <div className="orbit">
          <span className="orbit-core">✦</span>
        </div>
        <p className="empty-title">Nenhum pane aberto</p>
        <p className="hint">
          Abra um <strong>✦ Agente</strong> ou um <strong>&gt;_ Terminal</strong> no topo — ou
          execute uma tarefa do board.
        </p>
      </div>
    )
  }

  return (
    <div className="pane-grid" data-count={Math.min(panes.length + runIds.length, 4)}>
      {/* execuções de tarefa (F3): espelho do executor como um pane */}
      {runIds.map((taskId) => {
        const run = taskRuns[taskId]
        const task = tasks.find((t) => t.id === taskId)
        const dept = task ? DEPT_BY_KEY[task.department] : undefined
        const badge =
          run.status === 'running'
            ? run.phase === 'qa'
              ? '🔎 QA'
              : run.phase === 'review'
                ? '🧐 revisão'
                : '▶ executando'
            : run.status === 'done'
              ? '✓ concluída'
              : '✗ falhou'
        return (
          <div
            key={taskId}
            className={`pane term-window run-pane${run.perm ? ' needs-perm' : ''}`}
            style={dept ? { ['--dept-hue' as string]: dept.hue } : undefined}
          >
            <div className="pane-bar term-titlebar">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="pane-kind">▶</span>
              <span className="pane-title">{task?.title ?? 'tarefa'}</span>
              <span className={`pane-task-badge run-${run.status}`}>{badge}</span>
              {run.perm && (
                <span className="perm-badge" title="Aprovação pendente">
                  🖐 aprovação
                </span>
              )}
              <button
                className="term-btn ghost-dim"
                title="Assumir no TERMINAL DE VERDADE: abre o CLI na mesma conversa, dentro do worktree — digite e use / à vontade (o pipeline automático para)"
                onClick={() => void handoffRun(projectId, taskId)}
              >
                ▣ terminal
              </button>
              <button
                className="pane-close"
                title="Encerrar executor (transcript fica em .synkora/runs)"
                onClick={() => void closeRun(taskId)}
              >
                ×
              </button>
            </div>
            <div className="run-pane-body">
              <RunPanel taskId={taskId} />
            </div>
          </div>
        )
      })}
      {panes.map((pane) => {
        const seat = pane.seatId ? seats.find((s) => s.id === pane.seatId) : undefined
        const attention = pane.taskId ? taskAttention[pane.taskId] : false
        return (
          <div
            key={pane.id}
            className={`pane term-window ${pane.kind}${attention ? ' needs-perm' : ''}`}
          >
            <div className="pane-bar term-titlebar">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className={`pane-kind ${pane.kind}`}>
                {pane.kind === 'shell' ? '>_' : pane.kind === 'claude' ? '✦' : '⌁'}
              </span>
              {seat && (
                <span
                  className="seat-swatch"
                  style={{ ['--card-hue' as string]: hueOf(seat.name) }}
                />
              )}
              <span className="pane-title">{pane.title}</span>
              {pane.taskId && (
                <span className="pane-task-badge" title="Este pane executa uma tarefa do board">
                  ▶ tarefa
                </span>
              )}
              {attention && (
                <span className="perm-badge" title="O CLI está pedindo aprovação — responda aqui no pane">
                  🖐 aprovação
                </span>
              )}
              <span className="meta-dot run" title="Sessão ativa" />
              <button
                className="pane-close"
                title="Fechar pane"
                onClick={() => closePane(projectId, pane.id)}
              >
                ×
              </button>
            </div>
            <TerminalPane
              paneId={pane.id}
              cwd={pane.cwd ?? projectPath}
              kind={pane.kind}
              seatId={pane.seatId}
              taskId={pane.taskId}
              initialPrompt={pane.initialPrompt}
              model={pane.model}
              cliArgs={pane.cliArgs}
              logFile={pane.logFile}
              onUserInput={
                pane.taskId ? () => clearTaskAttention(pane.taskId as string) : undefined
              }
            />
          </div>
        )
      })}
    </div>
  )
}

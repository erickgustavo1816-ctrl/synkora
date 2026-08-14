import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildCommitGraph, type CommitGraphNode } from '../utils/commitGraph'
import { missionHistory, type MissionCommit } from '../missionHistory'

const ROW_HEIGHT = 74
const LANE_WIDTH = 24

interface PatchState {
  status: 'loading' | 'ready' | 'error'
  diff?: string
  truncated?: boolean
  error?: string
}

function formatCommitDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function shortSha(value: string): string {
  return value.slice(0, 12)
}

function edgePath(
  fromLane: number,
  fromRow: number,
  toLane: number,
  toRow: number
): string {
  const fromX = fromLane * LANE_WIDTH + LANE_WIDTH / 2
  const toX = toLane * LANE_WIDTH + LANE_WIDTH / 2
  const fromY = fromRow * ROW_HEIGHT + 18
  const toY = toRow * ROW_HEIGHT + 18
  if (fromLane === toLane) return `M ${fromX} ${fromY} L ${toX} ${toY}`
  const bend = Math.max(12, Math.min(28, (toY - fromY) / 2))
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + bend}, ${toX} ${toY - bend}, ${toX} ${toY}`
}

function CommitRow({
  node,
  laneWidth,
  expanded,
  patch,
  onToggle
}: {
  node: CommitGraphNode
  laneWidth: number
  expanded: boolean
  patch?: PatchState
  onToggle: (commit: MissionCommit) => void
}): React.JSX.Element {
  const { commit } = node
  return (
    <article className={`mh-row${expanded ? ' expanded' : ''}`}>
      <div className="mh-lanes" style={{ width: laneWidth }} aria-hidden="true">
        {node.activeLanes.map((lane) => (
          <span
            key={lane}
            className="mh-lane-line"
            style={{ left: lane * LANE_WIDTH + LANE_WIDTH / 2 }}
          />
        ))}
        <span
          className="mh-node"
          style={{ left: node.lane * LANE_WIDTH + LANE_WIDTH / 2 }}
        />
      </div>
      <div className="mh-commit-cell">
        <button
          type="button"
          className="mh-commit-summary"
          aria-expanded={expanded}
          aria-controls={`mh-patch-${commit.sha}`}
          data-tip={`SHA completo: ${commit.sha}${commit.parents.length ? `\nPais: ${commit.parents.join(', ')}` : '\nCommit raiz'}`}
          onClick={() => onToggle(commit)}
        >
          <span className="mh-commit-topline">
            <span className="mh-role" aria-label="papel: dev">
              dev
            </span>
            <strong>{commit.subject || '(sem assunto)'}</strong>
            <span className="mh-chevron" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          </span>
          <span className="mh-commit-meta">
            <code title={commit.sha}>{shortSha(commit.sha)}</code>
            <span>{commit.author || 'autor do Git'}</span>
            <time dateTime={commit.at}>{formatCommitDate(commit.at)}</time>
            {commit.parents.length > 1 && (
              <span className="mh-merge-label">merge · {commit.parents.length} pais</span>
            )}
          </span>
        </button>
        {expanded && (
          <div id={`mh-patch-${commit.sha}`} className="mh-patch-panel">
            {patch?.status === 'loading' && <span className="mh-patch-note">lendo patch…</span>}
            {patch?.status === 'error' && (
              <span className="mh-patch-error">// {patch.error ?? 'não deu para ler este patch'}</span>
            )}
            {patch?.status === 'ready' && (
              <>
                {patch.truncated && (
                  <span className="mh-patch-note">
                    patch cortado no teto de leitura; o commit continua intacto no worktree
                  </span>
                )}
                <pre>{patch.diff || '(este commit não tem linhas textuais para exibir)'}</pre>
              </>
            )}
            {!patch && <span className="mh-patch-note">preparando patch…</span>}
          </div>
        )}
      </div>
    </article>
  )
}

export default function MissionCommitHistory({
  missionId,
  reloadToken
}: {
  missionId: string
  reloadToken?: number
}): React.JSX.Element {
  const [commits, setCommits] = useState<MissionCommit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedSha, setExpandedSha] = useState<string | null>(null)
  const [patches, setPatches] = useState<Record<string, PatchState>>({})

  const refresh = useCallback(async (): Promise<void> => {
    if (!missionHistory.available()) {
      setError('reinicie o app (npm run dev) para habilitar o histórico')
      setCommits([])
      return
    }
    setBusy(true)
    const result = await missionHistory.commits(missionId)
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'não deu para ler o histórico desta missão')
      setCommits([])
      return
    }
    setError(null)
    setCommits(result.commits ?? [])
    setExpandedSha(null)
    setPatches({})
  }, [missionId])

  useEffect(() => {
    void refresh()
  }, [refresh, reloadToken])

  const graph = useMemo(() => buildCommitGraph(commits), [commits])
  const laneWidth = graph.laneCount * LANE_WIDTH + 4
  const graphHeight = Math.max(1, graph.nodes.length * ROW_HEIGHT)

  const toggle = useCallback(
    (commit: MissionCommit): void => {
      if (expandedSha === commit.sha) {
        setExpandedSha(null)
        return
      }
      setExpandedSha(commit.sha)
      if (patches[commit.sha]) return
      setPatches((current) => ({ ...current, [commit.sha]: { status: 'loading' } }))
      void missionHistory.commitDiff(missionId, commit.sha).then((result) => {
        setPatches((current) => ({
          ...current,
          [commit.sha]: result.ok
            ? { status: 'ready', diff: result.diff ?? '', truncated: result.truncated }
            : { status: 'error', error: result.error }
        }))
      })
    },
    [expandedSha, missionId, patches]
  )

  return (
    <section className="mh-history" aria-label="Histórico visual da missão">
      <div className="mh-history-head">
        <span className="mh-history-title">histórico da missão</span>
        <span className="mh-history-caption">somente leitura · {commits.length} commits</span>
      </div>
      {busy && <span className="mh-history-note">lendo commits…</span>}
      {error && <span className="mh-history-error">// {error}</span>}
      {!busy && !error && commits.length === 0 && (
        <span className="mh-history-note">nenhum commit próprio ainda</span>
      )}
      {!error && commits.length > 0 && (
        <div className="mh-graph-shell">
          <svg
            className="mh-edges"
            aria-hidden="true"
            width={laneWidth}
            height={graphHeight}
            viewBox={`0 0 ${laneWidth} ${graphHeight}`}
          >
            {graph.edges.map((edge) => (
              <path
                key={`${edge.fromRow}:${edge.fromLane}:${edge.parentSha}`}
                d={edgePath(edge.fromLane, edge.fromRow, edge.toLane, edge.toRow)}
                className="mh-edge"
              />
            ))}
          </svg>
          <div className="mh-rows">
            {graph.nodes.map((node) => (
              <CommitRow
                key={node.commit.sha}
                node={node}
                laneWidth={laneWidth}
                expanded={expandedSha === node.commit.sha}
                patch={patches[node.commit.sha]}
                onToggle={toggle}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

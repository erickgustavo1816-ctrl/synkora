import { useCallback, useEffect, useMemo, useState } from 'react'
import { buildCommitGraph, type CommitGraphNode } from '../utils/commitGraph'
import { missionHistory, type MissionCommit } from '../missionHistory'
import MissionCommitDiffViewer from './MissionCommitDiffViewer'
import {
  commitFileKindView,
  commitFilePathLabel,
  ellipsizeMiddle,
  parseCommitDiff,
  type CommitDiffSummary
} from '../guiDiffPresentation'

const ROW_HEIGHT = 74
const LANE_WIDTH = 24

/** Teto de arquivos listados DENTRO do trilho. Passou disto, a leitura é na
 *  janela larga — empilhar 60 linhas de 9px aqui não informa ninguém. */
const RAIL_FILE_CAP = 8

/** Corte do caminho na lista estreita. O trilho vai de 176px a 420px, então o
 *  teto é calibrado pelo LADO ESTREITO: perder o meio do caminho é barato,
 *  perder o nome do arquivo (o que a elipse do CSS faria) não é. */
const RAIL_PATH_CHARS = 34

interface PatchState {
  status: 'loading' | 'ready' | 'error'
  /** Já PARSEADO na chegada: o patch cru nunca vira estado nem chega à tela. */
  summary?: CommitDiffSummary
  error?: string
}

/** O que o commit abriu na janela larga: uma fotografia própria do patch, para
 *  a janela não mudar debaixo do leitor se o histórico recarregar. */
interface ViewerState {
  commit: MissionCommit
  summary: CommitDiffSummary
  focusPath?: string
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

/**
 * O RESUMO do commit dentro do trilho: um arquivo por linha com o placar de
 * cada um. Aqui NÃO se desenha diff — cada linha é o botão que abre a janela
 * larga já olhando para aquele arquivo.
 */
function CommitPatchSummary({
  summary,
  onOpen
}: {
  summary: CommitDiffSummary
  onOpen: (focusPath?: string) => void
}): React.JSX.Element {
  const files = summary.files
  const shown = files.slice(0, RAIL_FILE_CAP)
  const rest = files.length - shown.length
  return (
    <div className="mh-diff">
      <div className="mh-diff-totals">
        <b className="mh-diff-plus">+{summary.insertions}</b>
        <b className="mh-diff-minus">−{summary.deletions}</b>
        <span>
          {files.length} {files.length === 1 ? 'arquivo' : 'arquivos'}
        </span>
      </div>
      {summary.truncated && (
        <span className="mh-patch-note">
          patch cortado no teto de leitura; o commit continua intacto no worktree
        </span>
      )}
      {/* Sem arquivo nenhum não há janela para abrir: o botão sumir é mais
          honesto do que abrir uma superfície vazia. */}
      {files.length === 0 ? (
        <span className="mh-patch-note">este commit não tem linhas textuais para exibir</span>
      ) : (
        <ul className="mh-diff-files">
          {shown.map((file, index) => {
            const kind = commitFileKindView(file.kind)
            const label = commitFilePathLabel(file)
            return (
              <li key={`${index}:${file.path}`}>
                <button
                  type="button"
                  className="mh-diff-file"
                  data-tip={`${kind.label}: ${label}\n(clique para abrir o diff deste arquivo)`}
                  onClick={() => onOpen(file.path)}
                >
                  <i className={`mh-diff-kind ${kind.cls}`} aria-hidden="true">
                    {kind.glyph}
                  </i>
                  <span className="mh-diff-path">
                    {ellipsizeMiddle(file.path, RAIL_PATH_CHARS)}
                  </span>
                  <span className="mh-diff-score">
                    <b className="mh-diff-plus">+{file.insertions}</b>
                    <b className="mh-diff-minus">−{file.deletions}</b>
                  </span>
                </button>
              </li>
            )
          })}
          {rest > 0 && (
            <li>
              <span className="mh-diff-rest">
                … e mais {rest} {rest === 1 ? 'arquivo' : 'arquivos'}
              </span>
            </li>
          )}
        </ul>
      )}
      {files.length > 0 && (
        <button
          type="button"
          className="mh-diff-open"
          data-tip="Abre o diff completo numa janela larga (Esc fecha)"
          onClick={() => onOpen(undefined)}
        >
          ⤢ abrir diff
        </button>
      )}
    </div>
  )
}

function CommitRow({
  node,
  laneWidth,
  expanded,
  patch,
  onToggle,
  onOpenViewer
}: {
  node: CommitGraphNode
  laneWidth: number
  expanded: boolean
  patch?: PatchState
  onToggle: (commit: MissionCommit) => void
  onOpenViewer: (commit: MissionCommit, summary: CommitDiffSummary, focusPath?: string) => void
}): React.JSX.Element {
  const { commit } = node
  // Fotografia local do resumo: dentro do callback do clique o TS já não
  // enxergaria o estreitamento de `patch.summary`, e o `!` mentiria.
  const ready = patch?.status === 'ready' ? patch.summary : undefined
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
            {ready && (
              <CommitPatchSummary
                summary={ready}
                onOpen={(focusPath) => onOpenViewer(commit, ready, focusPath)}
              />
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
  const [viewer, setViewer] = useState<ViewerState | null>(null)

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
    // A branch andou: a janela aberta mostraria um patch de antes do sinal.
    setViewer(null)
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
            ? {
                status: 'ready',
                // O patch vira ESTRUTURA na chegada: uma leitura por commit,
                // e as duas superfícies passam a falar do mesmo modelo.
                summary: parseCommitDiff(result.diff ?? '', { truncated: result.truncated })
              }
            : { status: 'error', error: result.error }
        }))
      })
    },
    [expandedSha, missionId, patches]
  )

  const openViewer = useCallback(
    (commit: MissionCommit, summary: CommitDiffSummary, focusPath?: string): void => {
      setViewer({ commit, summary, ...(focusPath ? { focusPath } : {}) })
    },
    []
  )
  const closeViewer = useCallback((): void => setViewer(null), [])

  // O cabeçalho próprio (título + "somente leitura · N commits") saiu em
  // 2026-08-22: esta superfície mora DENTRO da DockSection "histórico", que já
  // dá o título e a contagem — o dono lia o mesmo título duas vezes,
  // empilhado. A promessa de leitura pura não morreu com ele: ela é a dica da
  // própria superfície, discreta e sempre a um hover de distância.
  return (
    <section
      className="mh-history"
      aria-label="Histórico visual da missão"
      data-tip="Esta superfície é somente leitura: nada aqui escreve no worktree — ela só mostra o que a branch já registrou"
    >
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
                onOpenViewer={openViewer}
              />
            ))}
          </div>
        </div>
      )}
      {viewer && (
        <MissionCommitDiffViewer
          key={`${viewer.commit.sha}:${viewer.focusPath ?? ''}`}
          commit={viewer.commit}
          summary={viewer.summary}
          {...(viewer.focusPath ? { focusPath: viewer.focusPath } : {})}
          onClose={closeViewer}
        />
      )}
    </section>
  )
}

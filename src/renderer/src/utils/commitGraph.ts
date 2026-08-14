import type { MissionCommit } from '../../../preload/index'

/** Uma aresta liga o nó do commit ao nó do pai que também está no recorte. */
export interface CommitGraphEdge {
  fromRow: number
  fromLane: number
  toRow: number
  toLane: number
  parentSha: string
}

export interface CommitGraphNode {
  row: number
  lane: number
  /** Lanes ocupadas antes deste commit ser consumido. A UI usa a fotografia
   *  para desenhar continuidade sem inventar linhas depois do merge. */
  activeLanes: number[]
  commit: MissionCommit
}

export interface CommitGraph {
  nodes: CommitGraphNode[]
  edges: CommitGraphEdge[]
  laneCount: number
}

/**
 * Calcula um mapa de lanes estável para a ordem topo-lógica recebida do main.
 * O algoritmo mantém o primeiro pai na lane atual e reserva uma lane nova
 * para cada pai adicional. Pais que não estão no recorte não criam nós/arestas
 * falsos — o histórico continua claramente limitado à missão.
 */
export function buildCommitGraph(commits: readonly MissionCommit[]): CommitGraph {
  const lanes: Array<string | undefined> = []
  const nodes: CommitGraphNode[] = []
  const pendingEdges: Array<{
    fromRow: number
    fromLane: number
    parentSha: string
  }> = []

  const firstOpenLane = (from: number): number => {
    for (let lane = Math.max(0, from); lane < lanes.length; lane += 1) {
      if (lanes[lane] === undefined) return lane
    }
    lanes.push(undefined)
    return lanes.length - 1
  }

  commits.forEach((commit, row) => {
    let lane = lanes.indexOf(commit.sha)
    if (lane < 0) lane = firstOpenLane(0)
    lanes[lane] = commit.sha

    const activeLanes = lanes
      .map((sha, index) => (sha ? index : -1))
      .filter((index) => index >= 0)
    nodes.push({ row, lane, activeLanes, commit })

    const [firstParent, ...additionalParents] = commit.parents
    if (firstParent) {
      const existingFirstParent = lanes.indexOf(firstParent)
      // A side branch may converge on a parent already kept by the first
      // lane. Do not leave a duplicate ghost lane behind the merge.
      lanes[lane] = existingFirstParent >= 0 && existingFirstParent !== lane ? undefined : firstParent
    } else {
      lanes[lane] = undefined
    }
    pendingEdges.push(
      ...commit.parents.map((parentSha) => ({ fromRow: row, fromLane: lane, parentSha }))
    )

    additionalParents.forEach((parentSha, index) => {
      const existing = lanes.indexOf(parentSha)
      if (existing >= 0) return
      const targetLane = firstOpenLane(lane + index + 1)
      lanes[targetLane] = parentSha
    })

    // Empty slots are kept until the end so a side branch never jumps columns
    // while the graph is being consumed.
  })

  const rowBySha = new Map<string, CommitGraphNode>()
  for (const node of nodes) rowBySha.set(node.commit.sha, node)

  const edges: CommitGraphEdge[] = []
  for (const pending of pendingEdges) {
    const target = rowBySha.get(pending.parentSha)
    if (!target || target.row <= pending.fromRow) continue
    edges.push({
      fromRow: pending.fromRow,
      fromLane: pending.fromLane,
      toRow: target.row,
      toLane: target.lane,
      parentSha: pending.parentSha
    })
  }

  const laneCount = Math.max(
    1,
    lanes.length,
    ...nodes.map((node) => node.lane + 1),
    ...edges.flatMap((edge) => [edge.fromLane + 1, edge.toLane + 1])
  )
  return { nodes, edges, laneCount }
}

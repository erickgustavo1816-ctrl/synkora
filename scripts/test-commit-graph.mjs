import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCommitGraph } from '../src/renderer/src/utils/commitGraph.ts'

const sha = (char) => char.repeat(40)

test('grafo linear preserva a lane e as arestas na ordem mais nova primeiro', () => {
  const commits = [
    { sha: sha('c'), parents: [sha('b')], subject: 'C', at: '2026-01-03T00:00:00Z' },
    { sha: sha('b'), parents: [sha('a')], subject: 'B', at: '2026-01-02T00:00:00Z' },
    { sha: sha('a'), parents: [], subject: 'A', at: '2026-01-01T00:00:00Z' }
  ]
  const graph = buildCommitGraph(commits)
  assert.deepEqual(graph.nodes.map((node) => node.lane), [0, 0, 0])
  assert.equal(graph.laneCount, 1)
  assert.deepEqual(graph.edges.map((edge) => [edge.fromRow, edge.toRow]), [[0, 1], [1, 2]])
})

test('grafo merge abre uma lane lateral e converge no pai comum sem fantasma', () => {
  const commits = [
    { sha: sha('m'), parents: [sha('b'), sha('c')], subject: 'merge', at: '2026-01-04T00:00:00Z' },
    { sha: sha('b'), parents: [sha('a')], subject: 'main', at: '2026-01-03T00:00:00Z' },
    { sha: sha('c'), parents: [sha('a')], subject: 'side', at: '2026-01-02T00:00:00Z' },
    { sha: sha('a'), parents: [], subject: 'base', at: '2026-01-01T00:00:00Z' }
  ]
  const graph = buildCommitGraph(commits)
  assert.deepEqual(graph.nodes.map((node) => node.lane), [0, 0, 1, 0])
  assert.equal(graph.laneCount, 2)
  assert.deepEqual(
    graph.edges.map((edge) => [edge.fromRow, edge.fromLane, edge.toRow, edge.toLane]),
    [
      [0, 0, 1, 0],
      [0, 0, 2, 1],
      [1, 0, 3, 0],
      [2, 1, 3, 0]
    ]
  )
  assert.deepEqual(graph.nodes[3].activeLanes, [0])
})

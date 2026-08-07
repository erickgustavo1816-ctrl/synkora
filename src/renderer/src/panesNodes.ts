import type { Department, Mission, Pane, PaneActivity, Task } from './store'

// ————————————————————————————————————————————————————————————————————————
// AGRUPAMENTO DOS PANES EM NÓS DO MAPA (aba PANES)
//
// O mapa mostra o PROJETO no centro e um card por "nó": cada missão viva, os
// panes soltos ("geral") e os órfãos. Execução de tarefa e ajudante NÃO viram
// nó — são panes DENTRO do nó da missão. É isso que segura a contagem em ~10
// cards mesmo com 30 terminais abertos.
// ————————————————————————————————————————————————————————————————————————

export const NODE_GERAL = 'geral'
export const NODE_ORFAOS = 'orfaos'
export const NODE_TESTE = 'teste'

export type NodeKind = 'mission' | 'geral' | 'orfaos' | 'teste'

export interface PaneNode {
  id: string
  kind: NodeKind
  label: string
  /** missão (só em kind==='mission') */
  mission?: Mission
  /** panes deste nó, já ordenados por prioridade de atenção */
  paneIds: string[]
  /** contagens prontas para o card */
  running: number
  waiting: number
  /** panes pedindo permissão AGORA */
  attention: number
}

/** Matiz do card: derivada do id da missão, estável entre sessões. */
export function hueOfNode(node: PaneNode): number {
  if (node.kind === 'orfaos') return 355
  if (node.kind === 'geral') return 42
  // teste do dono: verde de "rodando" — é o produto de pé para o usuário ver
  if (node.kind === 'teste') return 145
  let h = 0
  for (const ch of node.id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** paneId do orquestrador de uma missão (mora no Board, não na aba Panes). */
export function orchestratorPaneId(projectId: string, missionId: string): string {
  return `maestro-${projectId}--${missionId}`
}

/** `maestro-<projectId>--<missionId>` → missionId. O separador é `--` e NUNCA
 *  `:` — o paneId vira nome de arquivo da config MCP e dois-pontos é proibido
 *  no Windows. */
function missionIdFromPaneId(paneId: string): string | null {
  const m = /^maestro-.+?--(.+)$/.exec(paneId)
  return m ? m[1] : null
}

/**
 * A que missão um pane pertence. Cadeia de fallback, nesta ordem — cada elo
 * existe porque um caminho real de criação de pane não preenche o anterior:
 *  1. `pane.missionId` (panes criados pelo main já vêm carimbados)
 *  2. a tarefa do pane (execução/gate de card de missão)
 *  3. o paneId do orquestrador
 *  4. o cwd bate com o worktree da missão (pane aberto à mão lá dentro)
 */
export function missionOfPane(pane: Pane, tasks: Task[], missions: Mission[]): string | null {
  if (pane.missionId) return pane.missionId
  if (pane.taskId) {
    const task = tasks.find((t) => t.id === pane.taskId)
    if (task?.missionId) return task.missionId
  }
  const fromId = missionIdFromPaneId(pane.id)
  if (fromId) return fromId
  if (pane.cwd) {
    const byTree = missions.find((m) => m.worktree && m.worktree === pane.cwd)
    if (byTree) return byTree.id
  }
  return null
}

interface BuildInput {
  panes: Pane[]
  /** ids de execução de tarefa (panes-espelho `run:<taskId>`) */
  runTaskIds: string[]
  tasks: Task[]
  missions: Mission[]
  paneActivity: Record<string, PaneActivity>
  paneAttention: Record<string, boolean>
}

/**
 * Monta os nós do mapa. Um nó existe quando a missão está viva (ativa ou
 * integrando) OU quando ela ainda tem pane aberto — missão concluída com
 * terminal vivo não pode sumir da tela e continuar rodando invisível.
 */
export function buildNodes({
  panes,
  runTaskIds,
  tasks,
  missions,
  paneActivity,
  paneAttention
}: BuildInput): PaneNode[] {
  const byMission = new Map<string, string[]>()
  const geral: string[] = []
  const orfaos: string[] = []
  const teste: string[] = []
  const alive = new Map(missions.map((m) => [m.id, m]))

  const place = (itemId: string, missionId: string | null): void => {
    if (!missionId) {
      geral.push(itemId)
      return
    }
    const mission = alive.get(missionId)
    // missão excluída, concluída ou arquivada: o trabalho acabou, mas o
    // terminal ainda está de pé — vai para ÓRFÃOS em vez de desaparecer
    if (!mission || mission.status === 'concluida' || mission.status === 'arquivada') {
      orfaos.push(itemId)
      return
    }
    const list = byMission.get(missionId) ?? []
    list.push(itemId)
    byMission.set(missionId, list)
  }

  for (const pane of panes) {
    // Servidor de teste do dono (▶ testar): nó PRÓPRIO "Teste" — pane de
    // teste no "Geral · 1 painel ativo" não dizia NADA (pedido do usuário,
    // 2026-08-06); vale para teste de missão E de versão.
    if (pane.testServer) {
      teste.push(pane.id)
      continue
    }
    place(pane.id, missionOfPane(pane, tasks, missions))
  }
  for (const taskId of runTaskIds) {
    const task = tasks.find((t) => t.id === taskId)
    place(`run:${taskId}`, task?.missionId ?? null)
  }

  // ORDEM DENTRO DO NÓ = ORDEM DE CRIAÇÃO, e ponto.
  // NÃO ordenar por atividade (🖐 > rodando > parado): o estado de um pane
  // alterna entre 'run' e 'idle' a cada 4 segundos, então a ordem mudaria
  // sozinha o tempo todo e os ladrilhos do mosaico ficariam TROCANDO DE LUGAR
  // debaixo do mouse do usuário — bug real, reportado. Quem precisa de atenção
  // se anuncia por COR e pelo Ctrl+Alt+P, nunca pulando de posição.
  const sortIds = (ids: string[]): string[] => ids

  const tally = (ids: string[]): Pick<PaneNode, 'running' | 'waiting' | 'attention'> => ({
    running: ids.filter((id) => paneActivity[id] === 'run').length,
    waiting: ids.filter((id) => paneActivity[id] !== 'run' && paneActivity[id] !== 'dead').length,
    attention: ids.filter((id) => paneAttention[id]).length
  })

  const nodes: PaneNode[] = []
  // missões vivas SEMPRE aparecem, mesmo sem pane aberto: o card é o caminho
  // de entrada para abrir o primeiro terminal daquela missão
  const live = missions
    .filter((m) => m.status === 'ativa' || m.status === 'integrando')
    .filter((m) => m.kind !== 'direta') // missão direta é registro, não trabalho
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const mission of live) {
    const ids = sortIds(byMission.get(mission.id) ?? [])
    nodes.push({
      id: `mission:${mission.id}`,
      kind: 'mission',
      label: mission.title,
      mission,
      paneIds: ids,
      ...tally(ids)
    })
  }
  if (teste.length) {
    const ids = sortIds(teste)
    nodes.push({ id: NODE_TESTE, kind: 'teste', label: 'Teste', paneIds: ids, ...tally(ids) })
  }
  if (geral.length) {
    const ids = sortIds(geral)
    nodes.push({ id: NODE_GERAL, kind: 'geral', label: 'Geral', paneIds: ids, ...tally(ids) })
  }
  if (orfaos.length) {
    const ids = sortIds(orfaos)
    nodes.push({ id: NODE_ORFAOS, kind: 'orfaos', label: 'Órfãos', paneIds: ids, ...tally(ids) })
  }
  return nodes
}

// ————————————————————————————————————————————————————————————————————————
// SATÉLITES (2026-07-29, pedido do usuário): o card do nó é o ORQUESTRADOR da
// missão; cada dev/execução vira um card-satélite pendurado nele, ajudante
// pendura no DEV que o delegou (delegatorPaneId) e o gate (review/qa) liga ao
// dev E ao orquestrador — o triângulo. O fluxo do trabalho vira geometria.
// ————————————————————————————————————————————————————————————————————————

export type SatelliteRole = 'dev' | 'review' | 'qa' | 'ajudante' | 'livre'

export interface MapSatellite {
  /** paneId real ou `run:<taskId>` (pane-espelho de execução) */
  id: string
  /** nó (missão/geral/órfãos) dono do satélite */
  nodeId: string
  role: SatelliteRole
  label: string
  /** função do trabalho — pinta card e fio (gates pintam de 'qa') */
  dept?: Department
  /** pai do fio primário: outro satélite (ajudante→dev, gate→dev); ausente =
   *  o card do nó (orquestrador) */
  parentId?: string
  /** fio secundário até o card do nó — o gate fecha o triângulo */
  triangle?: boolean
  taskId?: string
}

/** Satélites de um nó, em ordem estável (a mesma dos paneIds = criação). */
export function satellitesOf(node: PaneNode, panes: Pane[], tasks: Task[]): MapSatellite[] {
  const sats: MapSatellite[] = []
  const paneOf = (id: string): Pane | undefined => panes.find((p) => p.id === id)
  const taskOf = (id?: string): Task | undefined =>
    id ? tasks.find((t) => t.id === id) : undefined
  const short = (s: string): string => (s.length > 26 ? `${s.slice(0, 25)}…` : s)

  for (const id of node.paneIds) {
    if (id.startsWith('run:')) {
      const task = taskOf(id.slice(4))
      sats.push({
        id,
        nodeId: node.id,
        role: 'dev',
        label: short(task?.title ?? 'execução'),
        dept: task?.department,
        taskId: task?.id
      })
      continue
    }
    const pane = paneOf(id)
    if (!pane || pane.role === 'maestro') continue
    const task = taskOf(pane.taskId)
    if (pane.role === 'ajudante') {
      // pendura no delegador SE ele também é satélite deste nó; senão no card
      const parent =
        pane.delegatorPaneId && node.paneIds.includes(pane.delegatorPaneId)
          ? pane.delegatorPaneId
          : undefined
      sats.push({
        id,
        nodeId: node.id,
        role: 'ajudante',
        label: short(pane.title.replace(/^🤝\s*/, '') || 'ajudante'),
        dept: task?.department,
        parentId: parent,
        taskId: task?.id
      })
    } else if (pane.role === 'review' || pane.role === 'qa') {
      // fio primário no DEV da mesma tarefa (pane vivo ou espelho run:);
      // o triângulo fecha no orquestrador
      const devSat = task
        ? (node.paneIds.find((x) => x === `run:${task.id}`) ??
          node.paneIds.find((x) => {
            const p = paneOf(x)
            return p?.taskId === task.id && p.role === 'dev'
          }))
        : undefined
      sats.push({
        id,
        nodeId: node.id,
        role: pane.role,
        label: short(task?.title ?? pane.title ?? pane.role),
        dept: 'qa',
        parentId: devSat,
        triangle: true,
        taskId: task?.id
      })
    } else {
      sats.push({
        id,
        nodeId: node.id,
        role: pane.role === 'dev' ? 'dev' : 'livre',
        label: short(task?.title ?? pane.title ?? 'agente'),
        dept: task?.department,
        taskId: task?.id
      })
    }
  }
  return sats
}

/** Posição de cada nó num anel elíptico em torno do núcleo. Determinístico: o
 *  nó novo ocupa a próxima vaga e os existentes NÃO reembaralham. */
export function ringPositions(
  count: number,
  w: number,
  h: number
): { x: number; y: number; angle: number }[] {
  const cx = w / 2
  const cy = h / 2
  const out: { x: number; y: number; angle: number }[] = []
  if (count === 0) return out
  // dois anéis a partir de 7 nós: um anel só ficaria com os cards colados
  const inner = count <= 6 ? count : Math.ceil(count / 2)
  // Raios largos de propósito (2026-07-29): cada card de nó agora tem
  // SATÉLITES orbitando (devs/ajudantes/gates) — o anel precisa de espaço
  // para as órbitas não se atropelarem. O mundo cresceu junto (WORLD_W/H).
  const rings = [
    { n: inner, rx: Math.min(w * 0.34, 700), ry: Math.min(h * 0.32, 460), offset: 0 },
    {
      n: count - inner,
      rx: Math.min(w * 0.47, 1020),
      ry: Math.min(h * 0.45, 660),
      offset: Math.PI / Math.max(1, count - inner)
    }
  ]
  let i = 0
  for (const ring of rings) {
    for (let k = 0; k < ring.n; k++) {
      // começa em -90° (topo) e distribui no sentido horário
      const angle = -Math.PI / 2 + (k * 2 * Math.PI) / Math.max(1, ring.n) + ring.offset
      out[i++] = {
        x: cx + Math.cos(angle) * ring.rx,
        y: cy + Math.sin(angle) * ring.ry,
        angle
      }
    }
  }
  return out
}

/** Campo de estrelas estável por projeto (mesmo céu toda vez que abre). */
export function starField(seed: string, n: number): { x: number; y: number; r: number; d: number }[] {
  let s = 0
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return Array.from({ length: n }, () => ({
    x: rand() * 100,
    y: rand() * 100,
    r: 0.8 + rand() * 1.8,
    d: rand() * 6
  }))
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  useStore,
  type Department,
  type NodeOffset,
  type Pane,
  type PaneActivity,
  type Task
} from '../store'
import { deptHueOf } from '../departments'
import {
  hueOfNode,
  satellitesOf,
  type MapSatellite,
  type PaneNode
} from '../panesNodes'
import { createPaperField, type FieldWell, type PaperField } from '../paperField'
import { fmtTokens, prettyModel } from './PaneChrome'
import { hueOf, initialsOf } from '../util'

// ————————————————————————————————————————————————————————————————————————
// O MAPA (aba PANES, nível 1) — papel + campo de partículas, o PROJETO no
// centro, um card por missão viva ligado por um fio VIVO. Nenhum terminal mora
// aqui: por isso o mapa pode animar à vontade sem custo nenhum para as TUIs.
//
// Regra de layout: o mapa CABE POR CONSTRUÇÃO — o raio do anel sai do tamanho
// do container. Não existe pan nem zoom contínuo; arrastar um card é clamped ao
// retângulo visível, então nada some no infinito.
//
// REGRA DE ANIMAÇÃO (decisão do projeto): movimento é SINAL, não enfeite. Todo
// pulso, onda e celebração aqui sai de um fato real — pane rodando, permissão
// pendente, missão integrada, agente morto. O que é puramente ambiente (a
// respiração do campo, o balanço do fio) fica em amplitude baixa o bastante
// para nunca competir com um sinal de verdade.
//
// Um ÚNICO rAF governa o mapa inteiro (fios + campo). Ele só roda com a caixa
// visível: os universos ficam todos montados (display:none), e o ResizeObserver
// entrega 0x0 para os escondidos — é esse o sinal de pausa.
// ————————————————————————————————————————————————————————————————————————

const CORE_W = 264
const CORE_H = 112
const NODE_W = 208
const NODE_H = 86
// card-satélite (dev/ajudante/gate) — pill compacto orbitando o orquestrador
const SAT_W = 168
const SAT_H = 46
/** Métricas do auto-layout em árvore. A altura do satélite inclui a folha de
 *  telemetria aberta; por isso dois cards nunca nascem um por cima do outro. */
const TREE_NODE_X = 390
const TREE_SAT_X = 300
const TREE_NODE_H = 110
const TREE_SAT_H = 92
const TREE_SIBLING_GAP = 18
const TREE_BRANCH_GAP = 44

// ————————————————————————————————————————————————————————————————————————
// O UNIVERSO TEM COORDENADAS PRÓPRIAS, FIXAS (decisão do usuário, 2026-07-28).
//
// Antes as vagas saíam do tamanho da CAIXA: ancorar um nó encolhia o mapa de
// tela cheia para uma coluna e o anel inteiro se reorganizava — "eu deixo de um
// jeito, quando clico no card está de outro". Redimensionar a janela fazia o
// mesmo. Agora o mundo é um plano de tamanho constante e a viewport é só uma
// CÂMERA sobre ele: encolher a janela passa a mostrar MENOS do mesmo universo,
// nunca um universo rearranjado. Quem alcança o que ficou fora é o pan.
//
// O tamanho comporta o anel externo do `ringPositions` (620×360 de raio) com
// folga para o card não encostar na borda.
// ————————————————————————————————————————————————————————————————————————
// Cresceu na F5.8 (2026-07-29, pedido do usuário: "o campo dele é pequeno"):
// os nós agora têm satélites orbitando e o universo precisa de espaço para o
// fluxo orgânico orquestrador → devs → ajudantes respirar.
const WORLD_W = 4800
const WORLD_H = 3200

/** Quanto tempo o card fantasma fica na tela depois que o nó some. */
const GHOST_MS = 1100
/** Duração da celebração (flash no fio + no card + onda no campo). */
const FX_MS = { birth: 1100, alert: 1800, done: 4200 } as const
/** Folga de câmera além da borda do mundo — respiro para o card que está
 *  encostado no limite não ficar colado no canto da tela. */
const PAN_SLACK = 90
/** Mola do fio: rigidez e amortecimento. Subamortecida de propósito — o fio
 *  passa um pouco do ponto e volta, como corda; crítico ficaria "morto". */
/** O fio entra alguns pixels sob o card (o SVG fica atrás dele), eliminando
 *  frestas de antialiasing sem deixar o traço invadir o conteúdo. */
const WIRE_OVERLAP = 4
/** Distância mínima entre as bordas de pai e filho. Além de deixar a árvore
 * respirar, impede a inversão súbita das portas laterais durante o arrasto. */
const TREE_PORT_GAP = 32
const COMM_TRAVEL_MS = 1180
const COMM_LINGER_MS = 1420

type TreeSide = -1 | 1

interface TreeSlot {
  x: number
  y: number
}

interface WorkflowTreeLayout {
  nodeSlots: Map<string, TreeSlot>
  satSlots: Map<string, TreeSlot>
  satellites: Map<string, MapSatellite[]>
}

interface DragPose {
  /** raiz do gesto: nodeId ou satId */
  id: string
  dx: number
  dy: number
  /** node movido, quando o gesto começou num card grande */
  nodeId?: string
  /** satélites que herdam o deslocamento ao vivo */
  satIds: ReadonlySet<string>
}

interface CommunicationPulse {
  key: number
  sourceId: string
  targetId: string
  kind: 'message' | 'delegate' | 'report' | 'feedback' | 'handoff'
}

interface ArrivalFx {
  key: number
  tone: 'message' | 'done' | 'alert'
}

interface BranchPlan {
  node: PaneNode
  sats: MapSatellite[]
  byId: Map<string, MapSatellite>
  parent: Map<string, string>
  children: Map<string, string[]>
  roots: string[]
  spanById: Map<string, number>
  span: number
}

/** Layout Reingold–Tilford simplificado para o domínio do Synkora. O projeto é
 *  a raiz; missões alternam entre os dois lados e cada pane cresce para fora.
 *  A ordem vem do store (criação), nunca de atividade, então não há saltos. */
function workflowTreeLayout(
  nodes: PaneNode[],
  panes: Pane[],
  tasks: Task[],
  cx: number,
  cy: number,
  sideByNode: Map<string, TreeSide>
): WorkflowTreeLayout {
  const plans: BranchPlan[] = nodes.map((node) => {
    const sats = satellitesOf(node, panes, tasks)
    const byId = new Map(sats.map((sat) => [sat.id, sat]))
    const parent = new Map<string, string>()

    for (const sat of sats) {
      let parentId = sat.parentId
      if (!parentId && sat.taskId && (sat.role === 'review' || sat.role === 'qa')) {
        parentId = sats.find(
          (candidate) => candidate.taskId === sat.taskId && candidate.role === 'dev'
        )?.id
      }
      if (parentId && parentId !== sat.id && byId.has(parentId)) parent.set(sat.id, parentId)
    }

    // Dados recuperados/legados não podem criar ciclo visual. O elo que fecha
    // o ciclo cai para o nó da missão, preservando o restante da árvore.
    for (const sat of sats) {
      const seen = new Set<string>([sat.id])
      let cursor = sat.id
      while (parent.has(cursor)) {
        const next = parent.get(cursor) as string
        if (seen.has(next)) {
          parent.delete(sat.id)
          break
        }
        seen.add(next)
        cursor = next
      }
    }

    const children = new Map<string, string[]>()
    for (const sat of sats) children.set(sat.id, [])
    for (const sat of sats) {
      const owner = parent.get(sat.id)
      if (owner) children.get(owner)?.push(sat.id)
    }
    const roots = sats.filter((sat) => !parent.has(sat.id)).map((sat) => sat.id)
    const spanById = new Map<string, number>()
    const measure = (id: string): number => {
      const known = spanById.get(id)
      if (known !== undefined) return known
      const kids = children.get(id) ?? []
      const childSpan = kids.reduce((sum, child) => sum + measure(child), 0)
      const span = Math.max(
        TREE_SAT_H,
        childSpan + Math.max(0, kids.length - 1) * TREE_SIBLING_GAP
      )
      spanById.set(id, span)
      return span
    }
    const rootsSpan = roots.reduce((sum, id) => sum + measure(id), 0)
    const span = Math.max(
      TREE_NODE_H,
      rootsSpan + Math.max(0, roots.length - 1) * TREE_SIBLING_GAP
    )
    return { node, sats, byId, parent, children, roots, spanById, span }
  })

  // O lado é atribuído uma vez por id e mantido enquanto o universo estiver
  // montado. Novos ramos entram no lado com menor altura acumulada.
  const load: Record<TreeSide, number> = { [-1]: 0, [1]: 0 }
  for (const plan of plans) {
    const side = sideByNode.get(plan.node.id)
    if (side) load[side] += plan.span + TREE_BRANCH_GAP
  }
  for (const plan of plans) {
    if (sideByNode.has(plan.node.id)) continue
    const side: TreeSide = sideByNode.size === 0 || load[1] <= load[-1] ? 1 : -1
    sideByNode.set(plan.node.id, side)
    load[side] += plan.span + TREE_BRANCH_GAP
  }

  const nodeSlots = new Map<string, TreeSlot>()
  const satSlots = new Map<string, TreeSlot>()
  const satellites = new Map<string, MapSatellite[]>()

  for (const side of [-1, 1] as const) {
    const lane = plans.filter((plan) => sideByNode.get(plan.node.id) === side)
    const total = lane.reduce((sum, plan) => sum + plan.span, 0) +
      Math.max(0, lane.length - 1) * TREE_BRANCH_GAP
    let top = cy - total / 2
    for (const plan of lane) {
      const nodeY = top + plan.span / 2
      const nodeX = cx + side * TREE_NODE_X
      nodeSlots.set(plan.node.id, { x: nodeX, y: nodeY })
      // O mesmo parentId resolvido alimenta layout, offsets, hover e fios. Antes
      // gates inferidos/ciclos legados eram corrigidos só para calcular a vaga,
      // mas voltavam com a topologia antiga na hora de desenhar e arrastar.
      satellites.set(
        plan.node.id,
        plan.sats.map((sat) => ({
          ...sat,
          parentId: plan.parent.get(sat.id),
          triangle: Boolean(sat.triangle && plan.parent.has(sat.id))
        }))
      )

      const rootsSpan = plan.roots.reduce(
        (sum, id) => sum + (plan.spanById.get(id) ?? TREE_SAT_H),
        0
      ) + Math.max(0, plan.roots.length - 1) * TREE_SIBLING_GAP
      let rootTop = nodeY - rootsSpan / 2
      const place = (id: string, itemTop: number, depth: number): void => {
        const span = plan.spanById.get(id) ?? TREE_SAT_H
        satSlots.set(id, {
          x: nodeX + side * TREE_SAT_X * depth,
          y: itemTop + span / 2
        })
        const kids = plan.children.get(id) ?? []
        const kidsSpan = kids.reduce(
          (sum, child) => sum + (plan.spanById.get(child) ?? TREE_SAT_H),
          0
        ) + Math.max(0, kids.length - 1) * TREE_SIBLING_GAP
        let childTop = itemTop + (span - kidsSpan) / 2
        for (const child of kids) {
          place(child, childTop, depth + 1)
          childTop += (plan.spanById.get(child) ?? TREE_SAT_H) + TREE_SIBLING_GAP
        }
      }
      for (const root of plan.roots) {
        place(root, rootTop, 1)
        rootTop += (plan.spanById.get(root) ?? TREE_SAT_H) + TREE_SIBLING_GAP
      }
      top += plan.span + TREE_BRANCH_GAP
    }
  }

  return { nodeSlots, satSlots, satellites }
}

const SAT_ROLE_GLYPH: Record<string, string> = {
  dev: '⚙',
  review: '🧐',
  qa: '🔎',
  ajudante: '🤝',
  livre: '✦'
}
const SAT_ROLE_LABEL: Record<string, string> = {
  dev: 'Dev executando o card',
  review: 'Revisor (gate 1)',
  qa: 'QA (gate 2) — liga o dev e o orquestrador',
  ajudante: 'Ajudante delegado pelo dev',
  livre: 'Agente/terminal da missão'
}

interface Props {
  projectId: string
  projectName: string
  projectPhoto?: string
  nodes: PaneNode[]
  anchored: string | null
  /** Pane individual aberto no palco; permite ao botão de recentralizar voltar
   *  ao card exato sem transformar a câmera em acompanhamento automático. */
  openedPaneId: string | null
  /** Estado dos panes reais. */
  itemActivity: Record<string, PaneActivity>
  itemAttention: Record<string, boolean>
  onAnchor: (nodeId: string) => void
  /** clicar num SATÉLITE abre o palco do nó já com aquele terminal em foco */
  onOpenPane: (nodeId: string, paneId: string) => void
  /** clicar no núcleo leva ao Board (o Maestro mora lá — trazer o terminal para
   *  cá seria reparent, e reparent MATA o PTY) */
  onOpenBoard: () => void
  missionsAtivas: number
  panesAtivos: number
}

interface PlacedSat extends MapSatellite {
  x: number
  y: number
  hue: number
}

interface Placed extends PaneNode {
  x: number
  y: number
  hue: number
}

/** Card que já não existe mais, mantido em tela só o tempo do desfecho. */
interface Ghost {
  key: number
  id: string
  label: string
  x: number
  y: number
  hue: number
  /** `done` = missão integrada (verde, sobe para o núcleo); `gone` = sumiu */
  tone: 'done' | 'gone'
  /** fantasma de SATÉLITE (card pequeno) — só dissolve no lugar */
  sat?: boolean
}

/** Efeito pontual num nó (ou no núcleo, id `core`). */
interface Fx {
  key: number
  kind: 'done' | 'alert' | 'birth'
}

function compactOperation(lines?: string[]): string | null {
  const line = lines
    ?.map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return null
  return line.length > 42 ? `${line.slice(0, 41)}…` : line
}

function satelliteStatus(
  sat: MapSatellite,
  activity: PaneActivity | undefined,
  asking: boolean,
  operation: string | null
): string {
  if (asking) return 'aguardando sua permissão'
  if (activity === 'dead') return 'processo encerrado'
  if (activity === 'run' && operation) return operation
  if (activity === 'run') {
    if (sat.role === 'review') return 'revisando mudanças'
    if (sat.role === 'qa') return 'validando resultado'
    if (sat.role === 'ajudante') return 'executando trabalho delegado'
    return 'trabalhando na missão'
  }
  return 'pronto para abrir'
}

export default function ConstellationMap({
  projectId,
  projectName,
  projectPhoto,
  nodes,
  anchored,
  openedPaneId,
  itemActivity,
  itemAttention,
  onAnchor,
  onOpenPane,
  onOpenBoard,
  missionsAtivas,
  panesAtivos
}: Props): React.JSX.Element {
  const offsets = useStore((s) => s.mapLayoutByProject[projectId])
  const setNodeOffset = useStore((s) => s.setNodeOffset)
  const resetNodeOffsets = useStore((s) => s.resetNodeOffsets)
  const paneStats = useStore((s) => s.paneStats)
  const paneActivity = useStore((s) => s.paneActivity)
  const paneAttention = useStore((s) => s.paneAttention)
  const paneLastLines = useStore((s) => s.paneLastLines)
  const paneModel = useStore((s) => s.paneModel)
  const missions = useStore((s) => s.missions)
  const tasks = useStore((s) => s.tasks)
  const panes = useStore((s) => s.panesByProject[projectId])
  const deptHues = useStore((s) => s.deptHues)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 900, h: 620 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const [fx, setFx] = useState<Record<string, Fx>>({})
  const [communicationPulses, setCommunicationPulses] = useState<CommunicationPulse[]>([])
  const [arrivalFx, setArrivalFx] = useState<Record<string, ArrivalFx>>({})
  const reduceMotion = useReducedMotion()

  // ---- campo de partículas (canvas 2D; ver paperField.ts) -----------------
  const fieldRef = useRef<PaperField | null>(null)
  // `live` é ESTADO, não ref: é ele que desliga o rAF dos fios. Todo universo
  // visitado fica montado (display:none), então um rAF por projeto rodando só
  // para testar um booleano seria desperdício multiplicado. setState com o
  // mesmo valor não re-renderiza — o measure pode chamar à vontade.
  const [live, setLive] = useState(true)
  const liveRef = useRef(true)

  useLayoutEffect(() => {
    const el = wrapRef.current
    const canvas = canvasRef.current
    if (!el || !canvas) return
    const field = createPaperField(canvas, { seed: projectId })
    fieldRef.current = field

    const measure = (): void => {
      const r = el.getBoundingClientRect()
      // caixa 0x0 = aba/universo escondido por display:none — pausa tudo
      const visible = r.width > 0 && r.height > 0
      liveRef.current = visible
      setLive(visible)
      field.setPaused(!visible || document.hidden)
      if (visible) {
        setBox({ w: r.width, h: r.height })
        field.resize(r.width, r.height)
      }
    }
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    measure()

    const onVis = (): void => field.setPaused(!liveRef.current || document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      obs.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      field.destroy()
      fieldRef.current = null
    }
  }, [projectId])

  // Centro do MUNDO — onde o núcleo mora. Não depende da caixa.
  const cx = WORLD_W / 2
  const cy = WORLD_H / 2
  const sideByNode = useRef(new Map<string, TreeSide>())
  const tree = useMemo(
    () => workflowTreeLayout(nodes, panes ?? [], tasks, cx, cy, sideByNode.current),
    [nodes, panes, tasks, cx, cy]
  )

  // Posição em coordenadas de MUNDO: vaga na árvore + deslocamento do usuário.
  // A árvore não depende da viewport; redimensionar muda a câmera, não o mapa.
  const placed = useMemo<Placed[]>(() => {
    const halfW = NODE_W / 2 + 8
    const halfH = NODE_H / 2 + 8
    return nodes.map((node) => {
      const base = tree.nodeSlots.get(node.id) ?? { x: cx, y: cy }
      const off = offsets?.[node.id]
      return {
        ...node,
        hue: hueOfNode(node),
        x: clamp(base.x + (off?.dx ?? 0), halfW, WORLD_W - halfW),
        y: clamp(base.y + (off?.dy ?? 0), halfH, WORLD_H - halfH)
      }
    })
  }, [nodes, offsets, tree, cx, cy])

  // ---- SATÉLITES: filhos ocupam colunas progressivas da árvore. O offset de
  // cada pai é herdado pelos descendentes, então mover um ramo move o conjunto
  // inteiro; offsets próprios continuam preservados para ajuste manual.
  const placedSats = useMemo<PlacedSat[]>(() => {
    const out: PlacedSat[] = []
    const satHalfW = SAT_W / 2 + 8
    const satHalfH = TREE_SAT_H / 2 + 8
    const accumulated = new Map<string, NodeOffset>()
    for (const node of placed) {
      const sats = tree.satellites.get(node.id) ?? []
      const byId = new Map(sats.map((sat) => [sat.id, sat]))
      const offsetOf = (sat: MapSatellite, trail = new Set<string>()): NodeOffset => {
        const known = accumulated.get(sat.id)
        if (known) return known
        if (trail.has(sat.id)) return offsets?.[node.id] ?? { dx: 0, dy: 0 }
        trail.add(sat.id)
        const parent = sat.parentId ? byId.get(sat.parentId) : undefined
        const inherited = parent
          ? offsetOf(parent, trail)
          : offsets?.[node.id] ?? { dx: 0, dy: 0 }
        const own = offsets?.[sat.id]
        const total = {
          dx: inherited.dx + (own?.dx ?? 0),
          dy: inherited.dy + (own?.dy ?? 0)
        }
        accumulated.set(sat.id, total)
        return total
      }
      for (const sat of sats) {
        const base = tree.satSlots.get(sat.id) ?? tree.nodeSlots.get(node.id) ?? node
        const off = offsetOf(sat)
        out.push({
          ...sat,
          x: clamp(base.x + off.dx, satHalfW, WORLD_W - satHalfW),
          y: clamp(base.y + off.dy, satHalfH, WORLD_H - satHalfH),
          hue: sat.dept ? deptHueOf(sat.dept, deptHues) : 42
        })
      }
    }
    return out
  }, [placed, tree, offsets, deptHues])

  // Hover inspeciona uma cadeia, não só uma caixa solta. Nó → todos os seus
  // satélites; satélite → pai, filhos e pares da mesma tarefa. É a leitura de
  // workflow da referência, aplicada à topologia real do Synkora.
  const inspection = useMemo(() => {
    const satIds = new Set<string>()
    if (!hovered) return { nodeId: null as string | null, satIds }
    const directNode = placed.find((node) => node.id === hovered)
    if (directNode) {
      for (const sat of placedSats) if (sat.nodeId === directNode.id) satIds.add(sat.id)
      return { nodeId: directNode.id, satIds }
    }
    const sat = placedSats.find((candidate) => candidate.id === hovered)
    if (!sat) return { nodeId: null as string | null, satIds }
    satIds.add(sat.id)
    if (sat.parentId) satIds.add(sat.parentId)
    for (const candidate of placedSats) {
      if (
        candidate.parentId === sat.id ||
        (sat.taskId && candidate.taskId === sat.taskId)
      ) {
        satIds.add(candidate.id)
      }
    }
    return { nodeId: sat.nodeId, satIds }
  }, [hovered, placed, placedSats])

  // Espelhos em ref: o rAF dos fios e o listener do hub leem daqui, então eles
  // NÃO precisam re-assinar/reiniciar a cada movimento de card ou resize.
  const placedRef = useRef(placed)
  placedRef.current = placed
  const satsRef = useRef(placedSats)
  satsRef.current = placedSats
  const paneVisualIds = useRef(new Map<string, string>())
  const visualPointCache = useRef(
    new Map<string, { x: number; y: number; halfW: number; halfH: number }>()
  )
  const visualCacheProject = useRef(projectId)
  if (visualCacheProject.current !== projectId) {
    visualCacheProject.current = projectId
    paneVisualIds.current.clear()
    visualPointCache.current.clear()
  }
  paneVisualIds.current.set(`maestro-${projectId}`, 'core')
  visualPointCache.current.set('core', {
    x: cx,
    y: cy,
    halfW: CORE_W / 2,
    halfH: CORE_H / 2
  })
  for (const node of placed) {
    for (const paneId of node.paneIds) paneVisualIds.current.set(paneId, node.id)
    visualPointCache.current.set(node.id, {
      x: node.x,
      y: node.y,
      halfW: NODE_W / 2,
      halfH: NODE_H / 2
    })
  }
  for (const sat of placedSats) {
    paneVisualIds.current.set(sat.id, sat.id)
    visualPointCache.current.set(sat.id, {
      x: sat.x,
      y: sat.y,
      halfW: SAT_W / 2,
      halfH: SAT_H / 2
    })
  }
  const cxRef = useRef(cx)
  cxRef.current = cx
  const cyRef = useRef(cy)
  cyRef.current = cy
  const boxRef = useRef(box)
  boxRef.current = box

  // ---- efeitos pontuais ---------------------------------------------------
  const fxKey = useRef(0)
  const fire = useCallback((id: string, kind: Fx['kind']): void => {
    const key = ++fxKey.current
    setFx((prev) => ({ ...prev, [id]: { key, kind } }))
    window.setTimeout(() => {
      setFx((prev) => (prev[id]?.key === key ? omit(prev, id) : prev))
    }, FX_MS[kind])
  }, [])

  const visualIdOfPane = useCallback(
    (paneId: string, missionId?: string, _taskId?: string): string | null => {
      if (paneId === `maestro-${projectId}`) return 'core'
      const sats = satsRef.current
      const exactSat = sats.find((sat) => sat.id === paneId)
      if (exactSat) return exactSat.id
      const list = placedRef.current
      const exactNode = list.find((node) => node.paneIds.includes(paneId))
      if (exactNode) return exactNode.id
      // `taskId` e `missionId` descrevem a conversa inteira, não um endpoint.
      // Usá-los como fallback para os dois lados colapsava orquestrador → dev
      // no mesmo satélite. Só o paneId exato do orquestrador pode cair no nó.
      if (missionId && paneId === `maestro-${projectId}--${missionId}`) {
        return list.find((node) => node.mission?.id === missionId)?.id ?? null
      }
      // Um ajudante pode encerrar logo após reportar. O cache guarda apenas a
      // associação exata daquele pane, permitindo que a última entrega ainda
      // saia do ponto onde o card existia — sem adivinhar por task/mission.
      return paneVisualIds.current.get(paneId) ?? null
    },
    [projectId]
  )

  // ---- PAN: a CENA se move, o campo de partículas NÃO ---------------------
  // O campo é o éter — fica parado enquanto a constelação navega por cima. Ele
  // só existe na área visível (amostragem Poisson da viewport); movê-lo junto
  // abriria faixas vazias na borda.
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panRef = useRef(pan)
  const sceneRef = useRef<HTMLDivElement>(null)
  const cameraEaseTimer = useRef<number | null>(null)
  const [panning, setPanning] = useState(false)
  /** nó que a câmera mantém centrado; null = o usuário assumiu o controle */
  const [focus, setFocus] = useState<string | null>(null)
  /** Trava síncrona: um evento pode renderizar no meio do gesto antes de o
   * setFocus(null) ser comitado. Só uma ação explícita do usuário abre isto. */
  const cameraFollowAllowed = useRef(false)

  // `transform` não fica no JSX: uma atualização de atividade durante o
  // pointermove não pode sobrescrever a posição viva com o último state.
  useLayoutEffect(() => {
    panRef.current = pan
    if (sceneRef.current) {
      sceneRef.current.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0)`
    }
  }, [pan])

  const stopCameraEase = useCallback((): void => {
    if (cameraEaseTimer.current !== null) {
      window.clearTimeout(cameraEaseTimer.current)
      cameraEaseTimer.current = null
    }
    sceneRef.current?.classList.remove('easing')
  }, [])

  const startCameraEase = useCallback((duration: number): void => {
    const scene = sceneRef.current
    if (!scene || reduceMotion) return
    if (cameraEaseTimer.current !== null) window.clearTimeout(cameraEaseTimer.current)
    scene.classList.add('easing')
    cameraEaseTimer.current = window.setTimeout(() => {
      scene.classList.remove('easing')
      cameraEaseTimer.current = null
    }, duration)
  }, [reduceMotion])

  useEffect(() => stopCameraEase, [stopCameraEase])

  /** Canto superior esquerdo do MUNDO em coordenadas de TELA. A cena é
   *  centralizada na viewport pelo CSS e deslocada pelo pan — esta é a única
   *  conversão entre os dois sistemas, e tudo que fala com o campo usa ela. */
  const originOf = useCallback((): { x: number; y: number } => {
    const b = boxRef.current
    const p = panRef.current
    return { x: (b.w - WORLD_W) / 2 + p.x, y: (b.h - WORLD_H) / 2 + p.y }
  }, [])

  /** Onda de choque no campo. Recebe coordenadas de MUNDO (as dos cards) e
   *  converte para tela, porque o campo não acompanha a câmera. */
  const shock = useCallback(
    (x: number, y: number, hue: number, strength = 1): void => {
      const o = originOf()
      fieldRef.current?.shock(x + o.x, y + o.y, { strength, hue })
    },
    [originOf]
  )

  // O ponto que viaja no fio nasce somente de uma entrega REAL confirmada pelo
  // Hub. Estado "rodando" colore a árvore, mas não inventa conversa infinita.
  useEffect(() => {
    let pulseKey = 0
    let arrivalKey = 0
    let activePulses = 0
    let disposed = false
    const timers = new Set<number>()
    const seenIds = new Set<string>()
    const seenOrder: string[] = []
    const pending: Array<
      Omit<CommunicationPulse, 'key'> & { tone: ArrivalFx['tone'] }
    > = []
    setCommunicationPulses([])
    setArrivalFx({})
    const later = (fn: () => void, ms: number): void => {
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        fn()
      }, ms)
      timers.add(timer)
    }
    const arrive = (id: string, tone: ArrivalFx['tone']): void => {
      const key = ++arrivalKey
      setArrivalFx((current) => ({ ...current, [id]: { key, tone } }))
      const point =
        id === 'core'
          ? { x: cxRef.current, y: cyRef.current, hue: 21 }
          : placedRef.current.find((node) => node.id === id) ??
            satsRef.current.find((sat) => sat.id === id)
      if (point) shock(point.x, point.y, point.hue, 0.28)
      later(() => {
        setArrivalFx((current) => (current[id]?.key === key ? omit(current, id) : current))
      }, 520)
    }
    const drain = (): void => {
      if (disposed || reduceMotion) return
      while (activePulses < 8 && pending.length > 0) {
        const next = pending.shift()
        if (!next) break
        const key = ++pulseKey
        activePulses++
        setCommunicationPulses((current) => [
          ...current,
          { key, sourceId: next.sourceId, targetId: next.targetId, kind: next.kind }
        ])
        later(() => arrive(next.targetId, next.tone), COMM_TRAVEL_MS)
        later(() => {
          setCommunicationPulses((current) => current.filter((pulse) => pulse.key !== key))
          activePulses = Math.max(0, activePulses - 1)
          drain()
        }, COMM_LINGER_MS)
      }
    }
    const unsubscribe = window.synkora.hub.onCommunication((event) => {
      if (event.projectId !== projectId || event.sourcePaneId === event.targetPaneId) return
      if (seenIds.has(event.id)) return
      seenIds.add(event.id)
      seenOrder.push(event.id)
      if (seenOrder.length > 128) {
        const oldest = seenOrder.shift()
        if (oldest) seenIds.delete(oldest)
      }
      const sourceId = visualIdOfPane(event.sourcePaneId, event.missionId, event.taskId)
      const targetId = visualIdOfPane(event.targetPaneId, event.missionId, event.taskId)
      if (!sourceId || !targetId || sourceId === targetId) return
      const tone: ArrivalFx['tone'] =
        event.kind === 'feedback' ? 'alert' : event.kind === 'report' ? 'done' : 'message'
      if (reduceMotion) {
        arrive(targetId, tone)
        return
      }
      pending.push({ sourceId, targetId, kind: event.kind, tone })
      drain()
    })
    return () => {
      disposed = true
      unsubscribe()
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [projectId, reduceMotion, shock, visualIdOfPane])

  // ---- POÇOS: cada card vira gravidade no campo ---------------------------
  // É isso que amarra o fundo ao domínio — as partículas se acumulam onde há
  // trabalho acontecendo e se afastam de quem está pedindo permissão.
  // Guardados em coordenadas de MUNDO; `pushWells` aplica o pan. Assim o gesto
  // de arrastar a cena reposiciona a gravidade sem recalcular nada.
  const wellsWorld = useRef<FieldWell[]>([])
  const pushWells = useCallback((): void => {
    const o = originOf()
    fieldRef.current?.setWells(
      wellsWorld.current.map((w) => ({ ...w, x: w.x + o.x, y: w.y + o.y }))
    )
  }, [originOf])

  useEffect(() => {
    const maestroBusy = paneActivity[`maestro-${projectId}`] === 'run'
    const wells: FieldWell[] = [
      {
        x: cx,
        y: cy,
        radius: 240,
        strength: maestroBusy ? 0.5 : 0.22,
        hue: 21,
        pulse: maestroBusy
      }
    ]
    for (const node of placed) {
      const alert = node.attention > 0
      const live = node.running > 0
      wells.push({
        x: node.x,
        y: node.y,
        radius: hovered === node.id ? 210 : 150,
        // atenção REPELE (abre uma clareira em volta do card, impossível de não
        // ver); trabalho ATRAI; parado quase não mexe no campo
        strength: alert ? -0.75 : live ? 0.46 : hovered === node.id ? 0.4 : 0.14,
        hue: alert ? 6 : node.hue,
        pulse: live || alert
      })
    }
    // satélites só entram no campo quando SIGNIFICAM algo (rodando/pedindo) —
    // um poço por card parado multiplicaria o custo sem informação nova
    for (const sat of placedSats) {
      const asking = itemAttention[sat.id]
      const run = itemActivity[sat.id] === 'run'
      if (!asking && !run) continue
      wells.push({
        x: sat.x,
        y: sat.y,
        radius: 96,
        strength: asking ? -0.55 : 0.24,
        hue: asking ? 6 : sat.hue,
        pulse: true
      })
    }
    wellsWorld.current = wells
    pushWells()
  }, [
    placed,
    placedSats,
    hovered,
    itemActivity,
    itemAttention,
    paneActivity,
    projectId,
    cx,
    cy,
    pushWells
  ])

  // ARRASTAR A CENA. Só pega no fundo (papel/campo) — em cima de card ou núcleo
  // o gesto pertence a eles. Durante o gesto escreve o transform direto no DOM:
  // um setState por frame re-renderizaria a constelação inteira.
  const onScenePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!e.isPrimary || e.button !== 0 || activePointerId.current !== null) return
      const target = e.target as HTMLElement
      if (target.closest('.map-node, .map-core, .map-tools')) return
      const host = e.currentTarget
      const scene = sceneRef.current
      if (!scene) return
      stopCameraEase()
      activePointerId.current = e.pointerId
      const x0 = e.clientX
      const y0 = e.clientY
      const start = { ...panRef.current }
      let next = start
      let raf = 0
      let moved = false
      host.setPointerCapture(e.pointerId)

      // Alcance da câmera: o bastante para varrer o mundo inteiro numa viewport
      // menor que ele, mais uma folga. Numa viewport MAIOR que o mundo sobra só
      // a folga — não há para onde ir, e é isso mesmo.
      const lim = panLimits(boxRef.current)

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        const dx = ev.clientX - x0
        const dy = ev.clientY - y0
        if (!moved && Math.hypot(dx, dy) < 4) return
        if (!moved) {
          setPanning(true)
          // arrastou à mão: a câmera para de perseguir o card ancorado, senão
          // o próximo resize puxaria a vista de volta
          cameraFollowAllowed.current = false
          setFocus(null)
        }
        moved = true
        next = {
          x: clamp(start.x + dx, -lim.x, lim.x),
          y: clamp(start.y + dy, -lim.y, lim.y)
        }
        // o pan vivo alimenta fios e poços ANTES do commit no estado
        panRef.current = next
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          scene.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`
          pushWells()
        })
      }
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        if (raf) cancelAnimationFrame(raf)
        host.removeEventListener('pointermove', onMove)
        host.removeEventListener('pointerup', onUp)
        host.removeEventListener('pointercancel', onCancel)
        host.removeEventListener('lostpointercapture', onLost)
        try {
          if (host.hasPointerCapture?.(e.pointerId)) host.releasePointerCapture(e.pointerId)
        } catch {
          // o sistema pode retirar a captura antes do evento de cancelamento
        }
        if (activePointerId.current === e.pointerId) activePointerId.current = null
        setPanning(false)
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        finish()
        if (moved) setPan(next)
      }
      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        finish()
        panRef.current = start
        scene.style.transform = `translate3d(${start.x}px, ${start.y}px, 0)`
        pushWells()
      }
      const onLost = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId || finished) return
        panRef.current = start
        scene.style.transform = `translate3d(${start.x}px, ${start.y}px, 0)`
        pushWells()
        finish()
      }
      host.addEventListener('pointermove', onMove)
      host.addEventListener('pointerup', onUp)
      host.addEventListener('pointercancel', onCancel)
      host.addEventListener('lostpointercapture', onLost)
    },
    [pushWells, stopCameraEase]
  )

  // A viewport mudou de tamanho (ancorar/desancorar, redimensionar a janela):
  // a câmera pode ter ficado além do novo limite. Sem isto, expandir o mapa
  // depois de navegar deixaria a constelação deslocada sem jeito de voltar a
  // não ser pelo botão.
  useEffect(() => {
    const lim = panLimits(box)
    setPan((p) => {
      const x = clamp(p.x, -lim.x, lim.x)
      const y = clamp(p.y, -lim.y, lim.y)
      return x === p.x && y === p.y ? p : { x, y }
    })
  }, [box])

  // ---- CÂMERA SEGUINDO O CARD CLICADO ------------------------------------
  // Clicar num card encolhe o mapa para a coluna lateral. Sem levar a câmera
  // junto, o card escolhido sai da vista — o universo é o mesmo, mas você fica
  // olhando para outro pedaço dele. O foco sobrevive à ANIMAÇÃO da coluna: o
  // ResizeObserver dispara várias vezes durante os 420ms e o alvo é recalculado
  // a cada uma, então a câmera chega junto com o layout.
  // Na visão geral a câmera pertence ao usuário. Voltar ao mapa encerra
  // qualquer foco anterior para que atividade, novos panes e mudanças de
  // geometria não recoloquem a câmera em um card depois de ela ser arrastada.
  useEffect(() => {
    if (anchored) return
    cameraFollowAllowed.current = false
    stopCameraEase()
    setFocus(null)
  }, [anchored, stopCameraEase])

  useEffect(() => {
    if (!anchored || !cameraFollowAllowed.current) return
    setFocus((current) => {
      // Abrir um satélite ancora o palco no nó-pai, mas a câmera deve continuar
      // olhando para o card exato que o usuário escolheu.
      const focusedSat = current ? satsRef.current.find((sat) => sat.id === current) : undefined
      return focusedSat?.nodeId === anchored ? current : anchored
    })
  }, [anchored])

  useEffect(() => {
    if (!focus || !cameraFollowAllowed.current) return
    // O foco é uma coreografia curta do clique, não um modo de perseguição.
    // A janela cobre a animação da coluna; depois disso nem layout nem
    // atividade podem reposicionar a câmera até outra ação explícita.
    const releaseFollow = window.setTimeout(() => {
      cameraFollowAllowed.current = false
    }, 620)
    const target = placed.find((item) => item.id === focus) ?? placedSats.find((item) => item.id === focus)
    if (!target) return () => window.clearTimeout(releaseFollow)
    // deslocamento que traz o card ao centro da viewport. Curiosamente não
    // depende da largura dela: a cena já é centralizada pelo CSS, então basta
    // compensar a distância do card até o centro do MUNDO.
    const lim = panLimits(boxRef.current)
    const nx = clamp(cx - target.x, -lim.x, lim.x)
    const ny = clamp(cy - target.y, -lim.y, lim.y)
    const cur = panRef.current
    // `placed` é recriado a cada tique de atividade dos panes (~4s). Sem esta
    // saída antecipada o efeito reaplicaria a transição para sempre, mesmo com
    // a câmera já no lugar.
    if (Math.abs(cur.x - nx) < 0.5 && Math.abs(cur.y - ny) < 0.5) {
      return () => window.clearTimeout(releaseFollow)
    }
    panRef.current = { x: nx, y: ny }
    setPan({ x: nx, y: ny })
    startCameraEase(480)
    return () => window.clearTimeout(releaseFollow)
  }, [focus, box, placed, placedSats, cx, cy, startCameraEase])

  // o pan comitado precisa chegar ao campo: os poços vivem em coordenadas de
  // tela e a origem depende da câmera
  useEffect(() => {
    pushWells()
  }, [pan, box, pushWells])

  const recenter = useCallback((): void => {
    const openTarget =
      openedPaneId && satsRef.current.some((sat) => sat.id === openedPaneId)
        ? openedPaneId
        : anchored
    if (openTarget) {
      cameraFollowAllowed.current = true
      setFocus(openTarget)
      const target =
        placedRef.current.find((item) => item.id === openTarget) ??
        satsRef.current.find((item) => item.id === openTarget)
      if (target) {
        const lim = panLimits(boxRef.current)
        const next = {
          x: clamp(cxRef.current - target.x, -lim.x, lim.x),
          y: clamp(cyRef.current - target.y, -lim.y, lim.y)
        }
        panRef.current = next
        setPan(next)
      }
      startCameraEase(460)
      return
    }
    const scene = sceneRef.current
    cameraFollowAllowed.current = false
    setFocus(null)
    panRef.current = { x: 0, y: 0 }
    // a volta ao centro é um VOO (classe .easing), ao contrário do arrasto, que
    // precisa ser instantâneo
    if (scene) {
      startCameraEase(460)
      scene.style.transform = 'translate3d(0px, 0px, 0)'
    }
    setPan({ x: 0, y: 0 })
    pushWells()
  }, [anchored, openedPaneId, pushWells, startCameraEase])

  // ---- DIFF: nó que nasce e nó que morre ---------------------------------
  // O store não guarda transição nenhuma (tudo é overwrite), então o desfecho
  // de uma missão só existe aqui: comparo a lista de nós com a do frame
  // anterior. Missão que sai da lista com status `concluida` = INTEGRADA.
  const prevNodes = useRef<Map<string, Placed> | null>(null)
  const ghostKey = useRef(0)
  useEffect(() => {
    const now = new Map(placed.map((p) => [p.id, p]))
    const prev = prevNodes.current
    prevNodes.current = now
    if (!prev) return // primeira passada: nada "nasceu", o mapa só abriu

    for (const [id, node] of now) {
      if (prev.has(id)) continue
      fire(id, 'birth')
      shock(node.x, node.y, node.hue, 0.7)
    }

    const born: Ghost[] = []
    for (const [id, old] of prev) {
      if (now.has(id)) continue
      const missionId = id.startsWith('mission:') ? id.slice('mission:'.length) : null
      const mission = missionId ? missions.find((m) => m.id === missionId) : undefined
      const done = mission?.status === 'concluida'
      born.push({
        key: ++ghostKey.current,
        id,
        label: old.label,
        x: old.x,
        y: old.y,
        hue: done ? 145 : old.hue,
        tone: done ? 'done' : 'gone'
      })
      shock(old.x, old.y, done ? 145 : old.hue, done ? 1.5 : 0.9)
      if (done) {
        fire('core', 'done')
        // o núcleo recebe o trabalho de volta: segunda onda, no centro
        window.setTimeout(() => shock(cx, cy, 145, 1.2), 420)
      }
    }
    if (born.length) {
      setGhosts((g) => [...g, ...born])
      const keys = new Set(born.map((b) => b.key))
      window.setTimeout(() => setGhosts((g) => g.filter((x) => !keys.has(x.key))), GHOST_MS)
    }
  }, [placed, missions, fire, shock, cx, cy])

  // ---- TRANSIÇÕES DE ITEM: início, morte e pedido de permissão ------------
  // O COMPONENTE precisa da borda (antes ≠ agora) para disparar cada efeito
  // uma única vez.
  const prevPane = useRef<{
    act: Record<string, string>
    ask: Record<string, boolean>
  } | null>(null)
  useEffect(() => {
    const before = prevPane.current
    prevPane.current = { act: { ...itemActivity }, ask: { ...itemAttention } }
    // primeira passada = abrir o mapa: o que já estava morto ou perguntando não
    // é NOVIDADE, e disparar tudo de uma vez viraria fogos de artifício na
    // entrada
    if (!before) return
    const nodeOf = (paneId: string): Placed | undefined =>
      placedRef.current.find((p) => p.paneIds.includes(paneId))
    const satOf = (paneId: string): PlacedSat | undefined =>
      satsRef.current.find((sat) => sat.id === paneId)

    for (const [paneId, act] of Object.entries(itemActivity)) {
      if (act === 'run' && before.act[paneId] !== 'run') {
        const sat = satOf(paneId)
        if (sat) {
          fire(sat.id, 'birth')
          shock(sat.x, sat.y, sat.hue, 0.38)
        }
      }
      if (act !== 'dead' || before.act[paneId] === 'dead') continue
      const node = nodeOf(paneId)
      const sat = satOf(paneId)
      // agente que caiu: onda curta e sem cor, o oposto da celebração
      if (sat) {
        fire(sat.id, 'alert')
        shock(sat.x, sat.y, 6, 0.7)
      } else if (node) shock(node.x, node.y, node.hue, 0.55)
    }
    for (const [paneId, asking] of Object.entries(itemAttention)) {
      if (!asking || before.ask[paneId]) continue
      const node = nodeOf(paneId)
      const sat = satOf(paneId)
      if (node) {
        fire(node.id, 'alert')
        if (sat) fire(sat.id, 'alert')
        shock(sat?.x ?? node.x, sat?.y ?? node.y, 6, 1.15)
      }
    }
  }, [itemActivity, itemAttention, fire, shock])

  // ---- HUB: eventos reais de orquestração --------------------------------
  // Ninguém mais consome esse canal no renderer. É a única fonte com semântica
  // explícita de "isto terminou" — o resto do store é estado, não evento.
  useEffect(() => {
    return window.synkora.hub.onEvent((evt) => {
      if (evt.projectId !== projectId) return
      const nodeId = evt.missionId ? `mission:${evt.missionId}` : null
      const target = nodeId ? placedRef.current.find((p) => p.id === nodeId) : undefined
      // Report entre panes já possui chegada causal em hub:communication.
      // Aqui fica apenas o merge estrutural, evitando dois flashes para a
      // mesma mensagem (um na publicação e outro na entrega real).
      if (evt.kind === 'merge') {
        const at = target ?? { x: cxRef.current, y: cyRef.current, hue: 145 }
        fire(target?.id ?? 'core', 'done')
        shock(at.x, at.y, 145, 1.25)
      } else if (evt.kind === 'error') {
        const at = target ?? { x: cxRef.current, y: cyRef.current, hue: 6 }
        fire(target?.id ?? 'core', 'alert')
        shock(at.x, at.y, 6, 1.1)
      } else if (evt.kind === 'pane-open' && target) {
        shock(target.x, target.y, target.hue, 0.55)
      }
    })
  }, [projectId, fire, shock])

  // ---- LINHAS POR FUNÇÃO (2026-07-29): uma linha no fio para CADA função com
  // agente RODANDO agora naquele nó, na cor da função (override do usuário
  // incluso) — design + cyber rodando = fio rosa E fio azul, lado a lado.
  const deptLinesByNode = useMemo(() => {
    const map = new Map<string, { dept: Department; hue: number; count: number }[]>()
    const paneList = panes ?? []
    for (const node of nodes) {
      const seen = new Map<Department, { dept: Department; hue: number; count: number }>()
      for (const id of node.paneIds) {
        if (itemActivity[id] !== 'run') continue
        const taskId = paneList.find((p) => p.id === id)?.taskId
        const dept = taskId ? tasks.find((t) => t.id === taskId)?.department : undefined
        if (!dept) continue
        const cur = seen.get(dept)
        if (cur) cur.count += 1
        else seen.set(dept, { dept, hue: deptHueOf(dept, deptHues), count: 1 })
      }
      map.set(node.id, [...seen.values()])
    }
    return map
  }, [nodes, panes, tasks, itemActivity, deptHues])

  // ---- FIOS VIVOS: um rAF escreve o `d` de todos ------------------------
  // O fio não é uma linha estática: ele respira, e o cursor o EMPURRA como uma
  // corda. Escrever `d` em ~4 paths por nó custa menos de 0,1 ms com 12 nós, e
  // mantém a curva sempre coerente com o card (inclusive durante o arrasto).
  const wireEls = useRef(new Map<string, SVGGElement>())
  const satWireEls = useRef(new Map<string, SVGGElement>())
  const communicationEls = useRef(new Map<number, SVGGElement>())
  const nodeCardEls = useRef(new Map<string, HTMLDivElement>())
  const satCardEls = useRef(new Map<string, HTMLDivElement>())
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const dragPos = useRef<DragPose | null>(null)
  const activePointerId = useRef<number | null>(null)
  const communicationRef = useRef(communicationPulses)
  communicationRef.current = communicationPulses

  /** Curva genérica entre dois cards da árvore. Toda aresta usa uma porta no
   *  centro da lateral voltada para o outro card: os ramos compartilham a mesma
   *  origem e se abrem só depois de sair do pai. */
  const linkD = useCallback(
    (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      halfW0: number,
      _halfH0: number,
      halfW1: number,
      _halfH1: number,
      bend: number
    ): string => {
      const direction = x1 >= x0 ? 1 : -1
      // O SVG fica atrás dos cards; entrar alguns pixels sob a borda elimina
      // qualquer fresta de antialiasing sem deixar o traço aparecer no miolo.
      const ax = x0 + direction * Math.max(0, halfW0 - WIRE_OVERLAP)
      const ay = y0
      const bx = x1 - direction * Math.max(0, halfW1 - WIRE_OVERLAP)
      const by = y1
      const handle = clamp(Math.abs(bx - ax) * 0.42, 52, 160)
      const c1x = ax + direction * handle
      const c1y = ay
      const c2x = bx - direction * handle
      const c2y = by
      if (bend) {
        const mx = (ax + bx) / 2
        const my = (ay + by) / 2 + bend
        const midHandle = Math.min(handle * 0.45, Math.abs(bx - ax) * 0.2)
        return `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${ay.toFixed(1)}, ${(mx - direction * midHandle).toFixed(1)} ${my.toFixed(1)}, ${mx.toFixed(1)} ${my.toFixed(1)} C ${(mx + direction * midHandle).toFixed(1)} ${my.toFixed(1)}, ${c2x.toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`
      }
      return `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`
    },
    []
  )

  const wireD = useCallback(
    (
      x: number,
      y: number,
      _bend: number,
      off = 0,
      coreX = cxRef.current,
      coreY = cyRef.current
    ): string => {
      const direction = x >= coreX ? 1 : -1
      const x0 = coreX + direction * (CORE_W / 2 - WIRE_OVERLAP)
      const y0 = coreY + off
      const x1 = x - direction * (NODE_W / 2 - WIRE_OVERLAP)
      const y1 = y + off
      // Todas as arestas da árvore saem e chegam com tangente horizontal. É o
      // mesmo vocabulário de curva em cada ramo, sem linhas "jogadas".
      const handle = clamp(Math.abs(x1 - x0) * 0.42, 52, 160)
      const c1x = x0 + direction * handle
      const c1y = y0
      const c2x = x1 - direction * handle
      const c2y = y1
      return `M ${x0.toFixed(1)} ${y0.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`
    },
    []
  )

  useEffect(() => {
    if (!live) return
    const reduce = reduceMotion
    let raf = 0
    // PARALLAX: uma única variável CSS no wrap move todos os cards; cada um
    // aplica seu próprio fator (--par-k), o que dá profundidade sem precisar de
    // uma ref por card. Vive em `translate:`, propriedade INDEPENDENTE de
    // `transform:` — assim não briga com o transform do arrasto.
    const par = { x: 0, y: 0 }
    if (reduce) {
      wrapRef.current?.style.setProperty('--par-x', '0px')
      wrapRef.current?.style.setProperty('--par-y', '0px')
    }
    const tick = (): void => {
      // Mesmo com movimento reduzido a geometria precisa ser recalculada: o
      // usuário ainda pode arrastar cards, redimensionar e reorganizar a árvore.
      // O que fica desligado é o parallax, não a ligação física card↔fio.
      raf = requestAnimationFrame(tick)
      const pointer = pointerRef.current
      const list = placedRef.current

      const wrap = wrapRef.current
      if (wrap && !reduce) {
        const halfW = Math.max(1, boxRef.current.w / 2)
        const halfH = Math.max(1, boxRef.current.h / 2)
        // O ponteiro chega em coordenadas da VIEWPORT, não do mundo. Subtrair
        // cx/cy (1200×780) prendia quase toda janela no mesmo quadrante.
        const tx = pointer ? clamp((pointer.x - halfW) / halfW, -1, 1) * 10 : 0
        const ty = pointer ? clamp((pointer.y - halfH) / halfH, -1, 1) * 7 : 0
        par.x += (tx - par.x) * 0.07
        par.y += (ty - par.y) * 0.07
        wrap.style.setProperty('--par-x', `${par.x.toFixed(2)}px`)
        wrap.style.setProperty('--par-y', `${par.y.toFixed(2)}px`)
      }

      const coreX = cxRef.current - par.x * 0.3
      const coreY = cyRef.current - par.y * 0.3

      for (let i = 0; i < list.length; i++) {
        const node = list[i]
        const g = wireEls.current.get(node.id)
        if (!g) continue
        const drag = dragPos.current
        const depth = 0.5 + (i % 3) * 0.28
        const shifted = drag?.nodeId === node.id
        const x = node.x + (shifted && drag ? drag.dx : 0) + par.x * depth
        const y = node.y + (shifted && drag ? drag.dy : 0) + par.y * depth

        const bend = 0
        // cada filho pode ter offset perpendicular próprio (linha por função);
        // mesma curva transladada — cache por offset dentro do frame
        const d0 = wireD(x, y, bend, 0, coreX, coreY)
        let offCache: Map<string, string> | null = null
        for (let k = 0; k < g.children.length; k++) {
          const el = g.children[k] as SVGPathElement
          const off = el.dataset.off
          if (!off || off === '0.0') {
            el.setAttribute('d', d0)
            continue
          }
          offCache = offCache ?? new Map()
          let dk = offCache.get(off)
          if (dk === undefined) {
            dk = wireD(x, y, bend, Number(off), coreX, coreY)
            offCache.set(off, dk)
          }
          el.setAttribute('d', dk)
        }
      }

      // ---- fios dos SATÉLITES: card→dev, dev→ajudante, gate→dev e o fio do
      // triângulo gate→orquestrador. Curvas curtas com respiração leve — sem
      // mola do cursor; o vivo aqui é o cometa e a cor da função.
      const sats = satsRef.current
      if (sats.length) {
        const drag = dragPos.current
        const nodePos = (id: string): { x: number; y: number } | null => {
          const index = list.findIndex((candidate) => candidate.id === id)
          if (index < 0) return null
          const n = list[index]
          const shifted = drag?.nodeId === id
          const depth = 0.5 + (index % 3) * 0.28
          return {
            x: n.x + (shifted && drag ? drag.dx : 0) + par.x * depth,
            y: n.y + (shifted && drag ? drag.dy : 0) + par.y * depth
          }
        }
        const satPos = (id: string): { x: number; y: number } | null => {
          const index = sats.findIndex((candidate) => candidate.id === id)
          if (index < 0) return null
          const s = sats[index]
          const shifted = Boolean(drag?.satIds.has(id))
          const depth = 0.35 + (index % 4) * 0.18
          return {
            x: s.x + (shifted && drag ? drag.dx : 0) + par.x * depth,
            y: s.y + (shifted && drag ? drag.dy : 0) + par.y * depth
          }
        }
        for (let i = 0; i < sats.length; i++) {
          const sat = sats[i]
          const g = satWireEls.current.get(sat.id)
          if (!g) continue
          const to = satPos(sat.id)
          const node = nodePos(sat.nodeId)
          if (!to || !node) continue
          const parent = sat.parentId ? satPos(sat.parentId) : null
          const from = parent ?? node
          const bend = 0
          const dMain = linkD(
            from.x,
            from.y,
            to.x,
            to.y,
            parent ? SAT_W / 2 : NODE_W / 2,
            parent ? SAT_H / 2 : NODE_H / 2,
            SAT_W / 2,
            SAT_H / 2,
            bend
          )
          const dTri = sat.triangle
            ? linkD(
                to.x,
                to.y,
                node.x,
                node.y,
                SAT_W / 2,
                SAT_H / 2,
                NODE_W / 2,
                NODE_H / 2,
                to.y <= node.y ? -28 : 28
              )
            : null
          for (let k = 0; k < g.children.length; k++) {
            const el = g.children[k] as SVGPathElement
            el.setAttribute('d', el.classList.contains('wire-tri') && dTri ? dTri : dMain)
          }
        }
      }

      // Entregas reais pane→pane ganham um único ponto direcional. A curva é
      // recalculada no mesmo frame dos cards, então continua colada durante
      // arrasto, pan e parallax.
      const drag = dragPos.current
      const visualPoint = (
        id: string
      ): { x: number; y: number; halfW: number; halfH: number } | null => {
        if (id === 'core') {
          return { x: coreX, y: coreY, halfW: CORE_W / 2, halfH: CORE_H / 2 }
        }
        const nodeIndex = list.findIndex((node) => node.id === id)
        if (nodeIndex >= 0) {
          const node = list[nodeIndex]
          const shifted = drag?.nodeId === id
          const depth = 0.5 + (nodeIndex % 3) * 0.28
          return {
            x: node.x + (shifted && drag ? drag.dx : 0) + par.x * depth,
            y: node.y + (shifted && drag ? drag.dy : 0) + par.y * depth,
            halfW: NODE_W / 2,
            halfH: NODE_H / 2
          }
        }
        const satIndex = sats.findIndex((sat) => sat.id === id)
        if (satIndex < 0) return visualPointCache.current.get(id) ?? null
        const sat = sats[satIndex]
        const shifted = Boolean(drag?.satIds.has(id))
        const depth = 0.35 + (satIndex % 4) * 0.18
        return {
          x: sat.x + (shifted && drag ? drag.dx : 0) + par.x * depth,
          y: sat.y + (shifted && drag ? drag.dy : 0) + par.y * depth,
          halfW: SAT_W / 2,
          halfH: SAT_H / 2
        }
      }
      for (const pulse of communicationRef.current) {
        const group = communicationEls.current.get(pulse.key)
        if (!group) continue
        const from = visualPoint(pulse.sourceId)
        const to = visualPoint(pulse.targetId)
        if (!from || !to) continue
        const d = linkD(
          from.x,
          from.y,
          to.x,
          to.y,
          from.halfW,
          from.halfH,
          to.halfW,
          to.halfH,
          0
        )
        for (const child of group.children) child.setAttribute('d', d)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [wireD, linkD, live, reduceMotion])

  // ---- ponteiro: alimenta campo e fios -----------------------------------
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    pointerRef.current = { x, y }
    fieldRef.current?.pointer(x, y)
  }, [])

  const onPointerLeave = useCallback((): void => {
    pointerRef.current = null
    fieldRef.current?.pointer(null, null)
  }, [])

  // ARRASTAR CARD: gesto sem re-render. Move o próprio elemento e publica a
  // posição num ref — o rAF dos fios lê dali, então a curva acompanha com a
  // mesma ondulação em vez de virar uma reta rígida. `setPointerCapture` +
  // pointercancel: sem capture, alt-tab no meio do arrasto deixava o card
  // colado no mouse.
  const onCardPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, node: Placed): void => {
      if (!e.isPrimary || e.button !== 0 || activePointerId.current !== null) return
      const card = e.currentTarget
      activePointerId.current = e.pointerId
      try {
        card.setPointerCapture(e.pointerId)
      } catch {
        activePointerId.current = null
        return
      }
      const x0 = e.clientX
      const y0 = e.clientY
      const startOff = offsets?.[node.id] ?? { dx: 0, dy: 0 }
      const branchSats = placedSats.filter((sat) => sat.nodeId === node.id)
      const initialTransforms = new Map<HTMLElement, string>()
      initialTransforms.set(card, card.style.transform)
      for (const sat of branchSats) {
        const el = satCardEls.current.get(sat.id)
        if (el) initialTransforms.set(el, el.style.transform)
      }
      const bounds = dragDeltaBounds([
        { x: node.x, y: node.y, halfW: NODE_W / 2 + 8, halfH: NODE_H / 2 + 8 },
        ...branchSats.map((sat) => ({
          x: sat.x,
          y: sat.y,
          halfW: SAT_W / 2 + 8,
          halfH: TREE_SAT_H / 2 + 8
        }))
      ])
      const side: TreeSide = node.x >= cx ? 1 : -1
      const nodeGap = CORE_W / 2 + NODE_W / 2 + TREE_PORT_GAP
      if (side === 1) bounds.minX = Math.max(bounds.minX, cx + nodeGap - node.x)
      else bounds.maxX = Math.min(bounds.maxX, cx - nodeGap - node.x)
      let pose: DragPose = {
        id: node.id,
        dx: 0,
        dy: 0,
        nodeId: node.id,
        satIds: new Set(branchSats.map((sat) => sat.id))
      }
      let raf = 0
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        const rawDx = ev.clientX - x0
        const rawDy = ev.clientY - y0
        // 4px de folga: clique com tremida de mão continua sendo CLIQUE
        if (!moved && Math.hypot(rawDx, rawDy) < 4) return
        if (!moved) card.classList.add('dragging')
        moved = true
        pose = {
          ...pose,
          dx: Math.round(clamp(rawDx, bounds.minX, bounds.maxX)),
          dy: Math.round(clamp(rawDy, bounds.minY, bounds.maxY))
        }
        dragPos.current = pose
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          card.style.transform = worldTransform(node.x + pose.dx, node.y + pose.dy)
          for (const sat of branchSats) {
            const el = satCardEls.current.get(sat.id)
            if (el) el.style.transform = worldTransform(sat.x + pose.dx, sat.y + pose.dy)
          }
        })
      }
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        if (raf) cancelAnimationFrame(raf)
        card.classList.remove('dragging')
        card.removeEventListener('pointermove', onMove)
        card.removeEventListener('pointerup', onUp)
        card.removeEventListener('pointercancel', onCancel)
        card.removeEventListener('lostpointercapture', onLost)
        try {
          if (card.hasPointerCapture?.(e.pointerId)) card.releasePointerCapture(e.pointerId)
        } catch {
          // captura já retirada pelo sistema
        }
        if (dragPos.current?.id === node.id) dragPos.current = null
        if (activePointerId.current === e.pointerId) activePointerId.current = null
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        finish()
        if (moved) {
          setNodeOffset(projectId, node.id, {
            dx: startOff.dx + pose.dx,
            dy: startOff.dy + pose.dy
          })
          shock(node.x + pose.dx, node.y + pose.dy, node.hue, 0.5)
        } else {
          // clique: abre o palco E traz a câmera para este card. Marcar o foco
          // aqui (e não só via `anchored`) faz o clique no card JÁ ancorado
          // recentralizar — é o gesto natural de "me leve até ele".
          cameraFollowAllowed.current = true
          setFocus(node.id)
          onAnchor(node.id)
        }
      }
      const restore = (): void => {
        for (const [el, transform] of initialTransforms) el.style.transform = transform
      }
      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        restore()
        finish()
      }
      const onLost = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId || finished) return
        restore()
        finish()
      }
      card.addEventListener('pointermove', onMove)
      card.addEventListener('pointerup', onUp)
      card.addEventListener('pointercancel', onCancel)
      card.addEventListener('lostpointercapture', onLost)
    },
    [offsets, placedSats, cx, setNodeOffset, projectId, onAnchor, shock]
  )

  // ARRASTAR SATÉLITE: mesma mecânica do card grande (gesto sem re-render,
  // offset persistido pelo MESMO mapa); clique = abrir aquele terminal.
  const onSatPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, sat: PlacedSat): void => {
      if (!e.isPrimary || e.button !== 0 || activePointerId.current !== null) return
      e.stopPropagation()
      const card = e.currentTarget
      activePointerId.current = e.pointerId
      try {
        card.setPointerCapture(e.pointerId)
      } catch {
        activePointerId.current = null
        return
      }
      const x0 = e.clientX
      const y0 = e.clientY
      const startOff = offsets?.[sat.id] ?? { dx: 0, dy: 0 }
      const affectedIds = new Set<string>([sat.id])
      let changed = true
      while (changed) {
        changed = false
        for (const candidate of placedSats) {
          if (candidate.parentId && affectedIds.has(candidate.parentId) && !affectedIds.has(candidate.id)) {
            affectedIds.add(candidate.id)
            changed = true
          }
        }
      }
      const affectedSats = placedSats.filter((candidate) => affectedIds.has(candidate.id))
      const initialTransforms = new Map<HTMLElement, string>()
      for (const candidate of affectedSats) {
        const el = satCardEls.current.get(candidate.id)
        if (el) initialTransforms.set(el, el.style.transform)
      }
      const bounds = dragDeltaBounds(
        affectedSats.map((candidate) => ({
          x: candidate.x,
          y: candidate.y,
          halfW: SAT_W / 2 + 8,
          halfH: TREE_SAT_H / 2 + 8
        }))
      )
      const parentSat = sat.parentId
        ? placedSats.find((candidate) => candidate.id === sat.parentId)
        : undefined
      const parentNode = placed.find((candidate) => candidate.id === sat.nodeId)
      const parent = parentSat ?? parentNode
      if (parent) {
        const side: TreeSide = sat.x >= parent.x ? 1 : -1
        const parentHalfW = parentSat ? SAT_W / 2 : NODE_W / 2
        const gap = parentHalfW + SAT_W / 2 + TREE_PORT_GAP
        if (side === 1) bounds.minX = Math.max(bounds.minX, parent.x + gap - sat.x)
        else bounds.maxX = Math.min(bounds.maxX, parent.x - gap - sat.x)
      }
      let pose: DragPose = { id: sat.id, dx: 0, dy: 0, satIds: affectedIds }
      let raf = 0
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        const rawDx = ev.clientX - x0
        const rawDy = ev.clientY - y0
        if (!moved && Math.hypot(rawDx, rawDy) < 4) return
        if (!moved) card.classList.add('dragging')
        moved = true
        pose = {
          ...pose,
          dx: Math.round(clamp(rawDx, bounds.minX, bounds.maxX)),
          dy: Math.round(clamp(rawDy, bounds.minY, bounds.maxY))
        }
        dragPos.current = pose
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          for (const candidate of affectedSats) {
            const el = satCardEls.current.get(candidate.id)
            if (el) {
              el.style.transform = worldTransform(
                candidate.x + pose.dx,
                candidate.y + pose.dy
              )
            }
          }
        })
      }
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        if (raf) cancelAnimationFrame(raf)
        card.classList.remove('dragging')
        card.removeEventListener('pointermove', onMove)
        card.removeEventListener('pointerup', onUp)
        card.removeEventListener('pointercancel', onCancel)
        card.removeEventListener('lostpointercapture', onLost)
        try {
          if (card.hasPointerCapture?.(e.pointerId)) card.releasePointerCapture(e.pointerId)
        } catch {
          // captura já retirada pelo sistema
        }
        if (dragPos.current?.id === sat.id) dragPos.current = null
        if (activePointerId.current === e.pointerId) activePointerId.current = null
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        finish()
        if (moved) {
          setNodeOffset(projectId, sat.id, {
            dx: startOff.dx + pose.dx,
            dy: startOff.dy + pose.dy
          })
          shock(sat.x + pose.dx, sat.y + pose.dy, sat.hue, 0.35)
        } else {
          // clique: abre o palco do nó já com ESTE terminal em destaque
          cameraFollowAllowed.current = true
          setFocus(sat.id)
          onOpenPane(sat.nodeId, sat.id)
        }
      }
      const restore = (): void => {
        for (const [el, transform] of initialTransforms) el.style.transform = transform
      }
      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return
        restore()
        finish()
      }
      const onLost = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId || finished) return
        restore()
        finish()
      }
      card.addEventListener('pointermove', onMove)
      card.addEventListener('pointerup', onUp)
      card.addEventListener('pointercancel', onCancel)
      card.addEventListener('lostpointercapture', onLost)
    },
    [offsets, placed, placedSats, setNodeOffset, projectId, onOpenPane, shock]
  )

  // Satélite que nasce/some: onda no campo e mini-fantasma (nada some seco).
  const prevSats = useRef<Map<string, PlacedSat> | null>(null)
  useEffect(() => {
    const now = new Map(placedSats.map((s) => [s.id, s]))
    const prev = prevSats.current
    prevSats.current = now
    if (!prev) return
    for (const [id, sat] of now) {
      if (!prev.has(id)) shock(sat.x, sat.y, sat.hue, 0.45)
    }
    const gone: Ghost[] = []
    for (const [id, old] of prev) {
      if (now.has(id)) continue
      gone.push({
        key: ++ghostKey.current,
        id,
        label: old.label,
        x: old.x,
        y: old.y,
        hue: old.hue,
        tone: 'gone',
        sat: true
      })
      shock(old.x, old.y, old.hue, 0.4)
    }
    if (gone.length) {
      setGhosts((g) => [...g, ...gone])
      const keys = new Set(gone.map((b) => b.key))
      window.setTimeout(() => setGhosts((g) => g.filter((x) => !keys.has(x.key))), GHOST_MS)
    }
  }, [placedSats, shock])

  // Telemetria do Maestro para o cartão-fantasma do núcleo. O terminal dele
  // vive no Board (`.maestro-slot`) — aqui só o status; clicar leva pra lá.
  const maestroId = `maestro-${projectId}`
  const maestroStats = paneStats[maestroId]
  const maestroAct = paneActivity[maestroId]
  const maestroBusy = maestroAct === 'run'

  const totalAttention = nodes.reduce((n, x) => n + x.attention, 0)
  const totalRunning = nodes.reduce((n, x) => n + x.running, 0)
  const dragged = Object.keys(offsets ?? {}).length > 0
  const coreFx = fx['core']

  return (
    <div
      className={`map-wrap${totalRunning > 0 ? ' has-work' : ''}${panning ? ' panning' : ''}`}
      ref={wrapRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onScenePointerDown}
      onDoubleClick={(e) => {
        // duplo-clique no vazio devolve a cena ao centro
        if (!(e.target as HTMLElement).closest('.map-node, .map-core')) recenter()
      }}
    >
      <div className="map-paper" aria-hidden="true" />
      {/* CAMPO DE PARTÍCULAS — canvas 2D, nunca WebGL: o orçamento de contextos
          WebGL desta janela é dos terminais (o 17º mata o mais antigo). */}
      <canvas className="map-field" ref={canvasRef} aria-hidden="true" />

      {/* A CENA é o que o pan move: fios, núcleo e cards juntos, num único
          transform. O campo de partículas fica de fora, parado. */}
      <div
        className={`map-scene${inspection.nodeId ? ' inspecting' : ''}`}
        ref={sceneRef}
        style={{
          width: WORLD_W,
          height: WORLD_H,
          marginLeft: -WORLD_W / 2,
          marginTop: -WORLD_H / 2,
        }}
      >
      <svg className={`map-wires${hovered ? ' dim' : ''}`} aria-hidden="true">
        {placed.map((node) => {
          const live = node.running > 0
          const alert = node.attention > 0
          const nodeFx = fx[node.id]
          const deptLines = deptLinesByNode.get(node.id) ?? []
          const lineCount = Math.max(1, deptLines.length)
          // trilhos paralelos separados por 5px, centrados no fio original
          const offFor = (k: number): number => (k - (lineCount - 1) / 2) * 5
          return (
            <g
              key={node.id}
              className={`wire${live ? ' live' : ''}${alert ? ' alert' : ''}${
                nodeFx ? ` fx-${nodeFx.kind}` : ''
              }${inspection.nodeId === node.id ? ' hot' : ''}${
                anchored === node.id ? ' on' : ''
              }`}
              style={{ ['--node-hue' as string]: node.hue }}
              ref={(el) => {
                if (el) wireEls.current.set(node.id, el)
                else wireEls.current.delete(node.id)
              }}
            >
              <path className="wire-glow" pathLength={100} />
              {/* uma LINHA por função rodando no nó (cor da função, trilhos
                  paralelos via data-off); sem função identificada, a linha
                  única neutra de sempre */}
              {(deptLines.length ? deptLines : [null]).map((dl, k) => (
                <path
                  key={dl ? `line-${dl.dept}` : 'line'}
                  className="wire-line"
                  pathLength={100}
                  data-off={offFor(k).toFixed(1)}
                  style={
                    dl ? ({ ['--wire-hue' as string]: dl.hue } as React.CSSProperties) : undefined
                  }
                />
              ))}
              {/* volta de permissão: o pulso corre do card PARA o núcleo */}
              {alert && <path className="wire-ask" pathLength={100} />}
              {nodeFx && (
                <path key={nodeFx.key} className={`wire-flash ${nodeFx.kind}`} pathLength={100} />
              )}
            </g>
          )
        })}
        {/* fios dos SATÉLITES: orquestrador→dev, dev→ajudante, gate→dev + o
            fio do TRIÂNGULO (gate→orquestrador, tracejado de supervisão) */}
        {placedSats.map((sat) => {
          const running = itemActivity[sat.id] === 'run'
          const asking = itemAttention[sat.id]
          const satFx = fx[sat.id]
          return (
            <g
              key={sat.id}
              className={`satwire${running ? ' live' : ''}${asking ? ' alert' : ''}${
                inspection.satIds.has(sat.id) ? ' hot' : ''
              }${satFx ? ` fx-${satFx.kind}` : ''
              }`}
              style={{ ['--wire-hue' as string]: sat.hue }}
              ref={(el) => {
                if (el) satWireEls.current.set(sat.id, el)
                else satWireEls.current.delete(sat.id)
              }}
            >
              <path className="wire-line" pathLength={100} />
              {asking && <path className="wire-ask" pathLength={100} />}
              {sat.triangle && <path className="wire-tri" pathLength={100} />}
              {satFx && (
                <path key={satFx.key} className={`wire-flash ${satFx.kind}`} pathLength={100} />
              )}
            </g>
          )
        })}
        {communicationPulses.map((pulse) => (
          <g
            key={pulse.key}
            className={`comm-route ${pulse.kind}`}
            ref={(el) => {
              if (el) communicationEls.current.set(pulse.key, el)
              else communicationEls.current.delete(pulse.key)
            }}
          >
            <path className="comm-route-track" pathLength={100} />
            <path className="comm-route-packet" pathLength={100} />
          </g>
        ))}
      </svg>

      {/* NÚCLEO — o retângulo do mockup. Cartão-fantasma do Maestro: telemetria
          viva, mas o terminal continua no Board. */}
      <div className="core-slot" style={{ left: cx, top: cy }}>
        <i className={`core-aura${maestroBusy ? ' busy' : ''}`} aria-hidden="true" />
        <svg className="core-orbit" viewBox="0 0 300 300" aria-hidden="true">
          <ellipse className="orbit-a" cx="150" cy="150" rx="146" ry="72" />
          <ellipse className="orbit-b" cx="150" cy="150" rx="132" ry="60" />
        </svg>
        {coreFx && <i key={coreFx.key} className={`core-ripple ${coreFx.kind}`} aria-hidden="true" />}
        <button
          className={`map-core${maestroBusy ? ' busy' : ''}${
            paneAttention[maestroId] ? ' needs-perm' : ''
          }${coreFx ? ` fx-${coreFx.kind}` : ''}${
            arrivalFx.core ? ` comm-hit ${arrivalFx.core.tone}` : ''
          }`}
          onClick={onOpenBoard}
          data-tip={'Maestro do projeto — o terminal dele fica no Board\nclique para ir até lá'}
        >
          <span className="core-head">
            {projectPhoto ? (
              <img className="core-photo" src={projectPhoto} alt="" />
            ) : (
              // MESMA marca do rail de projetos: sem foto, as iniciais com a
              // cor do universo. O ✦ genérico de antes fazia todo projeto
              // parecer o mesmo aqui dentro.
              <i className="core-photo ph" style={{ ['--card-hue' as string]: hueOf(projectName) }}>
                {initialsOf(projectName)}
              </i>
            )}
            <b className="core-name">{projectName}</b>
          </span>
          <span className="core-line">
            {missionsAtivas} {missionsAtivas === 1 ? 'missão ativa' : 'missões ativas'}
          </span>
          <span className="core-line">
            {panesAtivos} {panesAtivos === 1 ? 'painel ativo' : 'painéis ativos'}
          </span>
          {maestroStats && (
            <span className="core-tele">
              <i className={`led ${maestroAct ?? 'idle'}`} />
              MAESTRO ↓<Ticker value={maestroStats.inputTokens} /> ↑
              <Ticker value={maestroStats.outputTokens} />
            </span>
          )}
        </button>
      </div>

      {placed.map((node, i) => {
        const nodeFx = fx[node.id]
        const signalTone = node.attention > 0
          ? 'ask'
          : node.mission?.status === 'integrando'
            ? 'merge'
            : node.running > 0
              ? 'run'
              : 'idle'
        return (
          <div
            key={node.id}
            className={`map-node ${node.kind}${anchored === node.id ? ' anchored' : ''}${
              node.attention > 0 ? ' needs-perm' : ''
            }${node.running > 0 ? ' live' : ''}${
              node.mission?.status === 'integrando' ? ' merging' : ''
            }${nodeFx ? ` fx-${nodeFx.kind}` : ''}${
              inspection.nodeId === node.id ? ' hot' : ''
            }${arrivalFx[node.id] ? ` comm-hit ${arrivalFx[node.id].tone}` : ''}`}
            ref={(el) => {
              if (el) nodeCardEls.current.set(node.id, el)
              else nodeCardEls.current.delete(node.id)
            }}
            style={{
              transform: worldTransform(node.x, node.y),
              ['--node-hue' as string]: node.hue,
              // profundidade: cada card responde ao parallax com força própria
              ['--par-k' as string]: (0.5 + (i % 3) * 0.28).toFixed(2),
              // stagger de entrada: os cards se acendem em sequência
              animationDelay: `${Math.min(i * 35, 175)}ms`
            }}
            role="button"
            tabIndex={0}
            onPointerDown={(e) => onCardPointerDown(e, node)}
            onPointerEnter={() => setHovered(node.id)}
            onPointerLeave={() => setHovered((h) => (h === node.id ? null : h))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                cameraFollowAllowed.current = true
                setFocus(node.id)
                onAnchor(node.id)
              }
            }}
            onDoubleClick={() => setNodeOffset(projectId, node.id, { dx: 0, dy: 0 })}
            data-tip={
              node.mission
                ? `Orquestrador da missão "${node.mission.title}"\n${node.mission.branch ?? 'sem branch'}\nclique para abrir os terminais · os cards em volta são os devs/ajudantes/gates dele`
                : node.kind === 'orfaos'
                  ? 'Terminais de missões já encerradas que continuam de pé'
                  : node.kind === 'teste'
                    ? 'Servidor de teste que você subiu (▶ testar) — fechar o pane derruba o servidor'
                    : 'Agentes livres, terminais e execuções fora de missão'
            }
          >
            <span className="node-sheen" aria-hidden="true" />
            <span className={`node-signal ${signalTone}`} aria-hidden="true">
              <i />
            </span>
            <span className="node-title">{node.label}</span>
            <span className="node-line">
              {node.kind === 'mission' ? '✦ orquestrador · ' : ''}
              {node.kind === 'teste'
                ? node.paneIds.length === 1
                  ? '▶ teste em andamento'
                  : `▶ ${node.paneIds.length} testes em andamento`
                : `${node.paneIds.length} ${node.paneIds.length === 1 ? 'painel ativo' : 'painéis ativos'}`}
            </span>
            <span className="node-foot">
              {node.mission?.branch && (
                <i className="node-branch">{node.mission.branch.replace(/^mission\//, '⎇ ')}</i>
              )}
              {node.attention > 0 && <i className="node-perm">{node.attention} esperando</i>}
              {node.running > 0 && <i className="node-run">● {node.running}</i>}
            </span>
            {/* prévia de quem está fazendo o quê, sem pintar terminal nenhum */}
            <span className="node-peek">
              {node.paneIds.slice(0, 3).map((id) => (
                <i
                  key={id}
                  className={`peek-dot ${itemActivity[id] ?? 'idle'}${
                    itemAttention[id] ? ' asking' : ''
                  }`}
                  data-tip={peekTip(id, paneModel)}
                />
              ))}
              {node.paneIds.length > 3 && <i className="peek-more">+{node.paneIds.length - 3}</i>}
            </span>
            {node.mission?.status === 'integrando' && (
              <span className="node-merging" aria-hidden="true" />
            )}
            {nodeFx?.kind === 'done' && <span className="node-seal">✓</span>}
          </div>
        )
      })}

      {/* SATÉLITES — o fluxo orgânico: dev orbita o orquestrador, ajudante
          orbita o dev, gate faz triângulo. Clique abre AQUELE terminal. */}
      {placedSats.map((sat, i) => {
        const act = itemActivity[sat.id]
        const asking = itemAttention[sat.id]
        const satFx = fx[sat.id]
        const operation = compactOperation(paneLastLines[sat.id])
        const status = satelliteStatus(sat, act, asking, operation)
        const stats = paneStats[sat.id]
        const model = paneModel[sat.id]
        const meta = stats
          ? `↓ ${fmtTokens(stats.inputTokens)} · ↑ ${fmtTokens(stats.outputTokens)}`
          : model
            ? prettyModel(model)
            : SAT_ROLE_LABEL[sat.role]
        const stateTone = asking || act === 'dead'
          ? 'error'
          : satFx?.kind === 'done'
            ? 'done'
            : act === 'run'
              ? 'run'
              : 'idle'
        // Estado igual, card igual: todo pane em execução abre a mesma folha de
        // telemetria. O limite antigo de três criava uma hierarquia falsa quando
        // cinco agentes estavam rodando ao mesmo tempo.
        const engaged = act === 'run' || !!asking || !!satFx || focus === sat.id
        return (
          <div
            key={sat.id}
            className={`map-sat ${sat.role}${act === 'run' ? ' live' : ''}${
              act === 'dead' ? ' dead' : ''
            }${asking ? ' needs-perm' : ''}${engaged ? ' engaged' : ''}${
              inspection.satIds.has(sat.id) ? ' hot' : ''
            }${satFx ? ` fx-${satFx.kind}` : ''}${
              arrivalFx[sat.id] ? ` comm-hit ${arrivalFx[sat.id].tone}` : ''
            }`}
            ref={(el) => {
              if (el) satCardEls.current.set(sat.id, el)
              else satCardEls.current.delete(sat.id)
            }}
            style={{
              transform: worldTransform(sat.x, sat.y),
              ['--sat-hue' as string]: sat.hue,
              ['--par-k' as string]: (0.35 + (i % 4) * 0.18).toFixed(2),
              animationDelay: `${Math.min(i * 25, 150)}ms`
            }}
            role="button"
            tabIndex={0}
            onPointerDown={(e) => onSatPointerDown(e, sat)}
            onPointerEnter={() => setHovered(sat.id)}
            onPointerLeave={() => setHovered((h) => (h === sat.id ? null : h))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                cameraFollowAllowed.current = true
                setFocus(sat.id)
                onOpenPane(sat.nodeId, sat.id)
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setNodeOffset(projectId, sat.id, { dx: 0, dy: 0 })
            }}
            aria-label={`${SAT_ROLE_LABEL[sat.role]}${sat.label ? ` — ${sat.label}` : ''}. ${status}. Clique para abrir este terminal; arraste para reposicionar.`}
          >
            <i className={`led ${act ?? 'idle'}`} aria-hidden="true" />
            <span className="sat-role" aria-hidden="true">
              {SAT_ROLE_GLYPH[sat.role]}
            </span>
            <span className="sat-title">{sat.label}</span>
            <span className={`sat-state ${stateTone}`} aria-hidden="true">
              {stateTone === 'done' ? '✓' : stateTone === 'error' ? '×' : ''}
            </span>
            <span className={`sat-runtime${operation ? ' has-operation' : ''}`}>
              <span className="sat-runtime-meta">{meta}</span>
              <span className="sat-action">{status}</span>
              <span className={`sat-progress ${stateTone}`} aria-hidden="true">
                <i />
              </span>
            </span>
          </div>
        )
      })}

      {/* CARDS FANTASMA: nada some seco. Missão integrada sobe para o núcleo em
          verde; nó que apenas deixou de existir dissolve no lugar. */}
      {ghosts.map((g) => (
        <div
          key={g.key}
          className={`${g.sat ? 'map-sat' : 'map-node'} ghost ${g.tone}`}
          aria-hidden="true"
          style={{
            transform: `translate(-50%, -50%) translate(${g.x}px, ${g.y}px)`,
            ['--node-hue' as string]: g.hue,
            ['--sat-hue' as string]: g.hue,
            ['--to-x' as string]: `${Math.round(cx - g.x)}px`,
            ['--to-y' as string]: `${Math.round(cy - g.y)}px`
          }}
        >
          <span className="node-title">{g.label}</span>
          <span className="ghost-mark">{g.tone === 'done' ? '✓ integrada' : '— encerrada'}</span>
        </div>
      ))}
      </div>

      {nodes.length === 0 && (
        <div className="map-empty">
          <p className="empty-title">Nenhum painel aberto</p>
          <p className="hint">
            Abra um <strong>✦ Agente</strong> ou um <strong>&gt;_ Terminal</strong> no topo — ou
            execute uma tarefa do board.
          </p>
        </div>
      )}

      <div className="map-tools">
        {totalAttention > 0 && (
          <span className="map-perm-chip">{totalAttention} esperando</span>
        )}
        {(pan.x !== 0 || pan.y !== 0) && (
          <button
            className="btn ghost tiny"
            data-tip={
              anchored
                ? 'Centraliza o card que está aberto\n(duplo-clique no vazio faz o mesmo)'
                : 'Traz a constelação de volta ao centro\n(duplo-clique no vazio faz o mesmo)'
            }
            onClick={recenter}
          >
            ⌖ centralizar
          </button>
        )}
        {dragged && (
          <button
            className="btn ghost tiny"
            data-tip="Devolve todos os cards às posições do anel"
            onClick={() => resetNodeOffsets(projectId)}
          >
            ⊙ reorganizar
          </button>
        )}
      </div>
    </div>
  )
}

/** Empurrão do cursor sobre o fio, como o dedo numa corda de violão. */
function cursorPush(
  cx: number,
  cy: number,
  x: number,
  y: number,
  p: { x: number; y: number }
): number {
  const ax = x - cx
  const ay = y - cy
  const len2 = ax * ax + ay * ay
  if (len2 < 1) return 0
  // projeção do cursor no segmento núcleo→card, grampeada ao vão
  const t = Math.min(Math.max(((p.x - cx) * ax + (p.y - cy) * ay) / len2, 0), 1)
  const qx = cx + ax * t
  const qy = cy + ay * t
  const dist = Math.hypot(p.x - qx, p.y - qy)
  const reach = 130
  if (dist > reach) return 0
  // smoothstep em vez de queda quadrática: entrada e saída do alcance sem
  // degrau, o que importa porque este valor é o ALVO de uma mola
  const u = 1 - dist / reach
  const fall = u * u * (3 - 2 * u)
  // de que lado o cursor está: o fio foge para o oposto
  const cross = ax * (p.y - cy) - ay * (p.x - cx)
  return (cross > 0 ? -1 : 1) * fall * 20
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

interface DragBoundItem {
  x: number
  y: number
  halfW: number
  halfH: number
}

function dragDeltaBounds(items: DragBoundItem[]): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  let minX = -Infinity
  let maxX = Infinity
  let minY = -Infinity
  let maxY = Infinity
  for (const item of items) {
    minX = Math.max(minX, item.halfW - item.x)
    maxX = Math.min(maxX, WORLD_W - item.halfW - item.x)
    minY = Math.max(minY, item.halfH - item.y)
    maxY = Math.min(maxY, WORLD_H - item.halfH - item.y)
  }
  if (minX > maxX) minX = maxX = 0
  if (minY > maxY) minY = maxY = 0
  return { minX, maxX, minY, maxY }
}

function worldTransform(x: number, y: number): string {
  return `translate(-50%, -50%) translate(${Math.round(x)}px, ${Math.round(y)}px)`
}

/** Até onde a câmera pode andar: metade da sobra do mundo sobre a viewport,
 *  mais a folga. Viewport maior que o mundo ⇒ só a folga. */
function panLimits(box: { w: number; h: number }): { x: number; y: number } {
  return {
    x: Math.max(0, (WORLD_W - box.w) / 2) + PAN_SLACK,
    y: Math.max(0, (WORLD_H - box.h) / 2) + PAN_SLACK
  }
}

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj }
  delete next[key]
  return next
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => setReduced(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return reduced
}

/** Contador que ANDA até o valor novo em vez de saltar. Escreve direto no DOM:
 *  um setState por frame re-renderizaria o mapa inteiro. */
function Ticker({ value }: { value: number }): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const shown = useRef(value)
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const from = shown.current
    if (reduceMotion) {
      shown.current = value
      el.textContent = fmtTokens(value)
      return
    }
    if (from === value) {
      el.textContent = fmtTokens(value)
      return
    }
    const t0 = performance.now()
    const dur = 620
    let raf = 0
    const step = (now: number): void => {
      const k = Math.min((now - t0) / dur, 1)
      // ease-out: o número desacelera ao chegar, como um contador mecânico
      const v = from + (value - from) * (1 - (1 - k) ** 3)
      shown.current = v
      el.textContent = fmtTokens(Math.round(v))
      if (k < 1) raf = requestAnimationFrame(step)
      else shown.current = value
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, reduceMotion])
  return <i className="tick" ref={ref}>{fmtTokens(value)}</i>
}

function peekTip(id: string, paneModel: Record<string, string>): string {
  const model = paneModel[id]
  return model ? prettyModel(model) : 'painel'
}

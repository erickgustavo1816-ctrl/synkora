import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  useStore,
  type GuiPaneStatus,
  type PaneActivity,
  type PaneStats
} from '../store'
import TerminalPane from './TerminalPane'
import GuiPane from './GuiPane'
import PaneChrome, { ZERO_STATS } from './PaneChrome'
import PhaseSeatModal from './PhaseSeatModal'
import ConstellationMap from './ConstellationMap'
import { DEPT_BY_KEY, deptHueVar } from '../departments'
import { buildNodes, hueOfNode, NODE_GERAL, type PaneNode } from '../panesNodes'
import { missionChatSummary, type MissionChatSummary } from '../guiMissionPanes'
import {
  DEFAULT_CANVAS_LAYOUT,
  type CanvasBox,
  type CanvasDivider,
  type CanvasNodeLayout,
  type CanvasPageLayout
} from '../paneCanvas'
import { freezeTerminalLayoutFor, holdTerminalLayout } from '../terminalLayoutFreeze'
import { encodeHostNavTarget } from '../hostNavTarget'
import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
  TERMINAL_NATIVE_SCROLLBAR_WIDTH,
  terminalFallbackForBox,
  terminalMinColsForBox
} from '../terminalGeometry'
import {
  balancedDockLayout,
  DOCK_MIN_HEIGHT,
  DOCK_MIN_WIDTH,
  dockGeometry,
  dockMinimumSize,
  dockPane,
  dockPaneAtRoot,
  dockPaneOrder,
  makePaneSpan,
  normalizeDockLayout,
  resizeDockDivider,
  type DockEdge,
  type DockLayout,
  type DockZone
} from '../paneDock'
import {
  activateCanvasPage,
  activeCanvasPage,
  canvasPageIdForPane,
  reconcileCanvasPages,
  sameCanvasPageState,
  updateCanvasPage
} from '../panePages'

interface Props {
  projectId: string
  projectPath: string
}

// Referência estável: `?? []` no seletor criaria um array novo a cada render,
// e o zustand entraria em loop infinito de re-render.
const NO_PANES: never[] = []
const NO_STRINGS: string[] = []

// ABA PANES — canvas encaixavel. O deck continua uma LISTA PLANA e estavel no
// DOM: presets, foco, reordenacao e divisores alteram apenas as caixas absolutas.
// Assim nenhum TerminalPane remonta e nenhum PTY morre ao reorganizar o canvas.
// O terminal reduz fonte/colunas no modo compacto; 220px ainda preservam o
// chrome essencial (marca, papel, estado e ações) sem tornar 3 colunas
// impossíveis numa janela de ~848px. A altura possui outro orçamento.
const MIN_CANVAS_WIDTH = DOCK_MIN_WIDTH
const MIN_CANVAS_HEIGHT = DOCK_MIN_HEIGHT
type DockDropZone = DockZone | 'grid'

interface DockDropPreview {
  draggedId: string
  zone: DockDropZone
  scope: 'root' | 'pane' | 'grid'
  targetId?: string
  layout: DockLayout
  box: CanvasBox
  label: string
}

function dockSlice(box: CanvasBox, zone: DockDropZone): CanvasBox {
  if (zone === 'left') return { ...box, w: box.w / 2 }
  if (zone === 'right') return { ...box, x: box.x + box.w / 2, w: box.w / 2 }
  if (zone === 'top') return { ...box, h: box.h / 2 }
  if (zone === 'bottom') return { ...box, y: box.y + box.h / 2, h: box.h / 2 }
  return box
}

/**
 * Numa borda composta (por exemplo uma grade 2x3), arrastar um pane existente
 * para a extrema direita significa mover para o slot direito da MESMA faixa,
 * não criar uma quarta coluna full-height. O botão de coluna/linha continua
 * sendo a ação explícita para atravessar o eixo inteiro.
 */
function paneAtMatchingCanvasEdge(
  draggedId: string,
  edge: DockEdge,
  boxes: Record<string, CanvasBox>,
  stage: CanvasBox
): string | null {
  const source = boxes[draggedId]
  if (!source) return null
  const epsilon = 1.5
  const touches = (box: CanvasBox): boolean => {
    if (edge === 'left') return Math.abs(box.x - stage.x) <= epsilon
    if (edge === 'right')
      return Math.abs(box.x + box.w - (stage.x + stage.w)) <= epsilon
    if (edge === 'top') return Math.abs(box.y - stage.y) <= epsilon
    return Math.abs(box.y + box.h - (stage.y + stage.h)) <= epsilon
  }

  // Soltar na borda que o pane já ocupa é idempotente: não o joga para outra
  // linha nem cria uma faixa externa por acidente.
  if (touches(source)) return draggedId

  const horizontalEdge = edge === 'left' || edge === 'right'
  const sourceCrossStart = horizontalEdge ? source.y : source.x
  const sourceCrossEnd = horizontalEdge ? source.y + source.h : source.x + source.w
  const sourceCenter = (sourceCrossStart + sourceCrossEnd) / 2
  let best: { paneId: string; overlap: number; distance: number } | null = null

  for (const [paneId, box] of Object.entries(boxes)) {
    if (paneId === draggedId || !touches(box)) continue
    const crossStart = horizontalEdge ? box.y : box.x
    const crossEnd = horizontalEdge ? box.y + box.h : box.x + box.w
    const overlap = Math.max(
      0,
      Math.min(sourceCrossEnd, crossEnd) - Math.max(sourceCrossStart, crossStart)
    )
    const distance = Math.abs((crossStart + crossEnd) / 2 - sourceCenter)
    if (
      !best ||
      overlap > best.overlap + epsilon ||
      (Math.abs(overlap - best.overlap) <= epsilon && distance < best.distance)
    ) {
      best = { paneId, overlap, distance }
    }
  }
  return best?.paneId ?? null
}

// Pane GUI no chrome de sempre: o estado do chat vira o mesmo ● / ◌ / ■ que a
// telemetria do PTY produz nos panes TUI (permissão pendente já pulsa por
// `paneAttention`, então aqui ela lê como "esperando").
const GUI_ACTIVITY: Record<GuiPaneStatus, PaneActivity> = {
  starting: 'run',
  working: 'run',
  'waiting-you': 'idle',
  idle: 'idle',
  dead: 'dead'
}

const DOCK_LABEL: Record<DockDropZone, string> = {
  left: 'COLUNA À ESQUERDA',
  right: 'COLUNA À DIREITA',
  top: 'LINHA ACIMA',
  bottom: 'LINHA ABAIXO',
  center: 'TROCAR POSIÇÃO',
  grid: 'GRADE EQUILIBRADA'
}

const EDGE_MOVE_LABEL: Record<DockEdge, string> = {
  left: 'MOVER À ESQUERDA',
  right: 'MOVER À DIREITA',
  top: 'MOVER PARA CIMA',
  bottom: 'MOVER PARA BAIXO'
}

export default function PanesView({ projectId, projectPath }: Props): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const panes = useStore((s) => s.panesByProject[projectId] ?? NO_PANES)
  const closePane = useStore((s) => s.closePane)
  const tasks = useStore((s) => s.tasks)
  const missions = useStore((s) => s.missions)
  const paneAttention = useStore((s) => s.paneAttention)
  const clearPaneAttention = useStore((s) => s.clearPaneAttention)
  const paneStats = useStore((s) => s.paneStats)
  const paneActivity = useStore((s) => s.paneActivity)
  const paneEffort = useStore((s) => s.paneEffort)
  const paneModel = useStore((s) => s.paneModel)
  // conversa dos panes GUI (Synkora 2.0): alimenta o chrome (modelo, contexto,
  // custo, estado) exatamente como a telemetria do PTY alimenta os panes TUI
  const guiPanes = useStore((s) => s.guiPanes)
  const ui = useStore((s) => s.panesUiByProject[projectId])
  const setPanesUi = useStore((s) => s.setPanesUi)
  const loadPanesUi = useStore((s) => s.loadPanesUi)
  const setUniverseTab = useStore((s) => s.setUniverseTab)

  const anchored = ui?.anchored ?? null
  const promoted = ui?.promoted ?? NO_STRINGS
  const expanded = ui?.expanded ?? null
  const immersive = ui?.immersive ?? false
  const canvasByNode = ui?.canvasByNode ?? {}

  const floorRef = useRef<HTMLDivElement>(null)
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 })
  const [draftCanvas, setDraftCanvas] = useState<{
    nodeId: string
    pageId: string
    page: CanvasPageLayout
  } | null>(null)
  const [dockDraggingId, setDockDraggingId] = useState<string | null>(null)
  const [dockPreview, setDockPreview] = useState<DockDropPreview | null>(null)
  // ⇄ troca de conta da FASE (dev/review/qa). O estado mora aqui e só
  // re-renderiza esta view: o deck é lista plana com keys estáveis, então
  // nenhum TerminalPane remonta (e nenhum PTY morre) ao abrir/fechar o modal.
  const [phaseReseat, setPhaseReseat] = useState<{
    taskId: string
    phase: 'dev' | 'review' | 'qa'
    title: string
    seatId?: string
  } | null>(null)
  const dockPreviewRef = useRef<DockDropPreview | null>(null)
  const dockCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    loadPanesUi(projectId)
  }, [projectId, loadPanesUi])

  // Mede o CONTAINING BLOCK real dos panes. Antes o ref ficava em .panes-stage,
  // que inclui toolbar e margens; as caixas nasciam maiores que .stage-floor e
  // eram cortadas na direita/rodape a cada resize.
  useLayoutEffect(() => {
    const el = floorRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        setStageBox((current) =>
          Math.round(current.w) === Math.round(r.width) && Math.round(current.h) === Math.round(r.height)
            ? current
            : { w: r.width, h: r.height }
        )
      }
    }
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    measure()
    return () => obs.disconnect()
  }, [])

  // 2.0: missão direta não tem pane TUI — quem diz se ela está trabalhando é a
  // CONVERSA (espelho de `gui:live` alimentado no PanesApp desta view). O
  // resumo é destilado aqui e entra nos nós por ASSINATURA: `gui:live` dispara
  // a cada delta do turno, e pendurar `nodes` no objeto cru faria a geometria
  // do canvas recalcular dezenas de vezes por segundo.
  const missionChat = useMemo(() => {
    const out: Record<string, MissionChatSummary> = {}
    for (const mission of missions) {
      if (!mission.direct || mission.projectId !== projectId) continue
      out[mission.id] = missionChatSummary(mission.id, guiPanes)
    }
    return out
  }, [missions, projectId, guiPanes])
  const missionChatSig = Object.entries(missionChat)
    .map(([id, chat]) => `${id}:${chat.pulse}:${chat.running}:${chat.attention}:${chat.live}`)
    .join('|')
  const missionChatRef = useRef(missionChat)
  missionChatRef.current = missionChat

  const nodes = useMemo(
    () =>
      buildNodes({
        panes,
        tasks,
        missions: missions.filter((m) => m.projectId === projectId),
        paneActivity,
        paneAttention,
        missionChat: missionChatRef.current
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panes, tasks, missions, projectId, paneActivity, paneAttention, missionChatSig]
  )

  // Nó ancorado que deixou de existir (missão integrada/arquivada, último pane
  // fechado): volta ao mapa em vez de deixar um palco fantasma.
  const activeNode: PaneNode | null = nodes.find((n) => n.id === anchored) ?? null
  // Uma preferência antiga pode apontar para outro nó — nesse caso `expanded`
  // esconderia o canvas inteiro; só é válido se continuar sendo uma folha do
  // nó ativo.
  useEffect(() => {
    if (expanded && !activeNode?.paneIds.includes(expanded)) {
      setPanesUi(projectId, { expanded: null })
    }
  }, [expanded, activeNode, projectId, setPanesUi])
  useEffect(() => {
    if (anchored && !nodes.some((n) => n.id === anchored)) {
      setPanesUi(projectId, { anchored: null, expanded: null })
    }
  }, [anchored, nodes, projectId, setPanesUi])

  const nodeItemSignature = activeNode ? `${activeNode.id}:${activeNode.paneIds.join('|')}` : ''

  // Ajudantes costumam chegar em bloco. Mantem os xterms congelados enquanto
  // 1 -> 2 -> 3 -> 4 panes entram no canvas, para todos receberem apenas a
  // geometria final em vez de uma onda de SIGWINCH por pane adicionado.
  useEffect(() => {
    if (!nodeItemSignature) return
    return freezeTerminalLayoutFor(650)
  }, [nodeItemSignature])

  const canvasStateByNode = useMemo(() => {
    const out = new Map<
      string,
      {
        layout: CanvasNodeLayout
        canonicalLayout: CanvasNodeLayout
        page: CanvasPageLayout
        geometry: ReturnType<typeof dockGeometry>
        allBoxes: Record<string, CanvasBox>
      }
    >()
    for (const node of nodes) {
      const legacyOrder = node.id === activeNode?.id ? promoted : NO_STRINGS
      const saved = canvasByNode[node.id] ?? {
        ...DEFAULT_CANVAS_LAYOUT,
        order: legacyOrder
      }
      const canonicalLayout = reconcileCanvasPages(
        node.paneIds,
        saved,
        stageBox.w,
        stageBox.h
      )
      const currentPage = activeCanvasPage(canonicalLayout)
      if (!currentPage) continue
      const effectivePage =
        draftCanvas?.nodeId === node.id && draftCanvas.pageId === currentPage.id
          ? draftCanvas.page
          : currentPage
      const effectiveDock = normalizeDockLayout(
        effectivePage.order,
        effectivePage.dock,
        stageBox.w,
        stageBox.h
      )
      const page = {
        ...effectivePage,
        dock: effectiveDock,
        order: dockPaneOrder(effectiveDock)
      }
      const layout = updateCanvasPage(canonicalLayout, page.id, () => page)
      // Cada página inativa também ganha sua geometria real. Seus panes ficam
      // montados offscreen com visibility:hidden, permitindo ao FitAddon medir
      // exatamente a caixa futura antes de criar o PTY — sem boot 100x30 nem
      // primeiro redraw destrutivo quando a aba for aberta.
      const allBoxes: Record<string, CanvasBox> = {}
      for (const candidate of layout.pages ?? [page]) {
        const candidateDock = normalizeDockLayout(
          candidate.order,
          candidate.dock,
          stageBox.w,
          stageBox.h
        )
        Object.assign(allBoxes, dockGeometry(stageBox.w, stageBox.h, candidateDock).boxes)
      }
      out.set(node.id, {
        layout,
        canonicalLayout,
        page,
        geometry: dockGeometry(stageBox.w, stageBox.h, effectiveDock),
        allBoxes
      })
    }
    return out
  }, [nodes, canvasByNode, activeNode?.id, promoted, draftCanvas, stageBox.w, stageBox.h])

  const activeCanvas = activeNode ? canvasStateByNode.get(activeNode.id) : undefined
  const nodeItems = activeCanvas?.page.order ?? NO_STRINGS

  useEffect(() => {
    if (expanded && activeCanvas && !activeCanvas.page.order.includes(expanded)) {
      setPanesUi(projectId, { expanded: null })
    }
  }, [expanded, activeCanvas, projectId, setPanesUi])

  // Migra o layout antigo e reconcilia panes abertos/fechados uma vez. Paginas
  // inativas seguem montadas no deck, mas cada uma preserva sua propria arvore.
  useEffect(() => {
    if (draftCanvas) return
    const updates: Record<string, CanvasNodeLayout> = {}
    for (const node of nodes) {
      const state = canvasStateByNode.get(node.id)
      if (state && !sameCanvasPageState(canvasByNode[node.id], state.canonicalLayout)) {
        updates[node.id] = state.canonicalLayout
      }
    }
    if (!Object.keys(updates).length) return
    setPanesUi(projectId, { canvasByNode: { ...canvasByNode, ...updates } })
  }, [draftCanvas, nodes, canvasStateByNode, canvasByNode, projectId, setPanesUi])

  const persistNodeLayout = useCallback(
    (nodeId: string, layout: CanvasNodeLayout): void => {
      setPanesUi(projectId, { canvasByNode: { ...canvasByNode, [nodeId]: layout } })
    },
    [canvasByNode, projectId, setPanesUi]
  )

  const anchor = useCallback(
    (nodeId: string): void => {
      // congela o fit de TODO terminal durante a coreografia: a coluna do mapa
      // anima e o ResizeObserver dispararia a cada frame com caixas
      // intermediárias que não interessam a ninguém
      freezeTerminalLayoutFor(520)
      setPanesUi(projectId, {
        anchored: anchored === nodeId ? null : nodeId,
        expanded: null
      })
    },
    [anchored, projectId, setPanesUi]
  )

  // Clique num card de MISSÃO DIRETA (2.0): o trabalho dela é a conversa, e a
  // conversa mora no board — que vive no HOST. F3-c4: o único caminho é o
  // relay via main, e o alvo (aba + missão) viaja codificado na string.
  const openMissionOnBoard = useCallback(
    (missionId: string): void => {
      window.synkora.panesView.navigateHost(
        projectId,
        encodeHostNavTarget('board', missionId)
      )
    },
    [projectId]
  )

  // Clique num SATÉLITE do mapa: abre o palco do nó já com aquele terminal em
  // destaque (expanded) — o card do dev leva DIRETO ao dev.
  const openPaneFromMap = useCallback(
    (nodeId: string, paneId: string): void => {
      freezeTerminalLayoutFor(520)
      const targetCanvas = canvasStateByNode.get(nodeId)
      const pageId = canvasPageIdForPane(targetCanvas?.layout, paneId)
      setPanesUi(projectId, {
        anchored: nodeId,
        expanded: paneId,
        ...(targetCanvas && pageId
          ? {
              canvasByNode: {
                ...canvasByNode,
                [nodeId]: activateCanvasPage(targetCanvas.layout, pageId)
              }
            }
          : {})
      })
    },
    [canvasStateByNode, canvasByNode, projectId, setPanesUi]
  )

  const spanPane = useCallback(
    (paneId: string, axis: 'x' | 'y'): void => {
      const node = nodes.find((candidate) => candidate.paneIds.includes(paneId))
      if (!node) return
      const current = canvasStateByNode.get(node.id)
      if (!current || !current.page.order.includes(paneId)) return
      const dock = normalizeDockLayout(
        current.page.order,
        current.page.dock,
        stageBox.w,
        stageBox.h
      )
      const nextDock = makePaneSpan(dock, paneId, axis, 'start', axis === 'x' ? 0.56 : 0.52)
      const nextPage = {
        ...current.page,
        dock: nextDock,
        order: dockPaneOrder(nextDock)
      }
      freezeTerminalLayoutFor(420)
      setPanesUi(projectId, {
        expanded: null,
        canvasByNode: {
          ...canvasByNode,
          [node.id]: updateCanvasPage(current.layout, current.page.id, () => nextPage)
        }
      })
    },
    [nodes, canvasStateByNode, stageBox.w, stageBox.h, projectId, canvasByNode, setPanesUi]
  )

  const toggleExpand = useCallback(
    (paneId: string): void => {
      freezeTerminalLayoutFor(320)
      setPanesUi(projectId, { expanded: expanded === paneId ? null : paneId })
    },
    [expanded, projectId, setPanesUi]
  )

  const resetCanvasRatios = useCallback((): void => {
    if (!activeNode || !activeCanvas?.page.dock) return
    freezeTerminalLayoutFor(280)
    const nextPage = {
      ...activeCanvas.page,
      dock: { ...activeCanvas.page.dock, ratios: {} }
    }
    persistNodeLayout(
      activeNode.id,
      updateCanvasPage(activeCanvas.layout, activeCanvas.page.id, () => nextPage)
    )
  }, [activeNode, activeCanvas, persistNodeLayout])

  const dividerCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dividerCleanupRef.current?.(), [])
  useEffect(() => () => dockCleanupRef.current?.(), [])

  const selectCanvasPage = useCallback(
    (pageId: string): void => {
      if (!activeNode || !activeCanvas || activeCanvas.page.id === pageId) return
      dividerCleanupRef.current?.()
      dockCleanupRef.current?.()
      setDraftCanvas(null)
      freezeTerminalLayoutFor(420)
      setPanesUi(projectId, {
        expanded: null,
        canvasByNode: {
          ...canvasByNode,
          [activeNode.id]: activateCanvasPage(activeCanvas.layout, pageId)
        }
      })
    },
    [activeNode, activeCanvas, canvasByNode, projectId, setPanesUi]
  )

  const startDividerDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, divider: CanvasDivider): void => {
      if (
        !activeNode ||
        !activeCanvas ||
        !e.isPrimary ||
        (e.pointerType === 'mouse' && e.button !== 0)
      )
        return
      e.preventDefault()
      e.stopPropagation()
      dividerCleanupRef.current?.()

      const handle = e.currentTarget
      const pointerId = e.pointerId
      const start = divider.axis === 'x' ? e.clientX : e.clientY
      const initialLayout = activeCanvas.layout
      const initial = activeCanvas.page
      let next = initial
      let raf = 0
      let finished = false
      let latestDelta = 0
      try {
        handle.setPointerCapture(pointerId)
      } catch {
        return
      }
      handle.classList.add('dragging')

      const calculate = (delta: number): CanvasPageLayout => {
        return {
          ...initial,
          dock: resizeDockDivider(
            initial.dock,
            divider,
            delta,
            stageBox.w,
            stageBox.h,
            MIN_CANVAS_WIDTH,
            MIN_CANVAS_HEIGHT
          )
        }
      }
      const apply = (delta: number): void => {
        next = calculate(delta)
        setDraftCanvas({ nodeId: activeNode.id, pageId: initial.id, page: next })
      }
      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        latestDelta = divider.axis === 'x' ? ev.clientX - start : ev.clientY - start
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          apply(latestDelta)
        })
      }
      const finish = (): void => {
        if (finished) return
        finished = true
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        // O último pointermove pode chegar no mesmo frame do pointerup. Calcula
        // novamente de forma síncrona para nunca perder os pixels finais.
        next = calculate(latestDelta)
        handle.classList.remove('dragging')
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onCancel)
        handle.removeEventListener('lostpointercapture', onLostCapture)
        window.removeEventListener('blur', onCancel)
        if (handle.hasPointerCapture(pointerId)) {
          try {
            handle.releasePointerCapture(pointerId)
          } catch {
            // O browser pode ter soltado a captura antes do callback.
          }
        }
        dividerCleanupRef.current = null
        setDraftCanvas(null)
        persistNodeLayout(
          activeNode.id,
          updateCanvasPage(initialLayout, initial.id, () => next)
        )
      }
      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) finish()
      }
      const onCancel = (ev?: Event): void => {
        if (ev && 'pointerId' in ev && (ev as PointerEvent).pointerId !== pointerId) return
        finish()
      }
      const onLostCapture = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) finish()
      }

      dividerCleanupRef.current = finish
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onCancel)
      handle.addEventListener('lostpointercapture', onLostCapture)
      window.addEventListener('blur', onCancel)
    },
    [activeNode, activeCanvas, persistNodeLayout, stageBox.w, stageBox.h]
  )

  const startPaneDock = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, paneId: string): void => {
      if (
        !activeNode ||
        !activeCanvas?.page.dock ||
        expanded ||
        !e.isPrimary ||
        (e.pointerType === 'mouse' && e.button !== 0)
      )
        return

      const floor = floorRef.current
      if (!floor) return
      e.preventDefault()
      e.stopPropagation()
      dockCleanupRef.current?.()

      const handle = e.currentTarget
      const pointerId = e.pointerId
      const startX = e.clientX
      const startY = e.clientY
      const initialLayout = activeCanvas.layout
      const initialPage = activeCanvas.page
      const initialDock = initialPage.dock
      let active = false
      let finished = false
      let raf = 0
      let latestX = startX
      let latestY = startY
      let releaseLayout: (() => void) | null = null

      try {
        handle.setPointerCapture(pointerId)
      } catch {
        return
      }

      const resolvePreview = (clientX: number, clientY: number): DockDropPreview | null => {
        const rect = floor.getBoundingClientRect()
        const x = clientX - rect.left
        const y = clientY - rect.top
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null

        const stage = { x: 0, y: 0, w: rect.width, h: rect.height }
        // A geometria memorizada usa a ultima medicao do ResizeObserver. No
        // pointerup (principalmente logo apos redimensionar a janela) ela pode
        // estar um frame atrasada. Borda, hit-test e preview precisam usar o
        // mesmo retangulo real para esquerda e direita serem simetricas.
        const pointerGeometry = dockGeometry(
          rect.width,
          rect.height,
          initialDock,
          MIN_CANVAS_WIDTH,
          MIN_CANVAS_HEIGHT
        )
        const deltaX = clientX - startX
        const deltaY = clientY - startY
        // O arrasto nasce no cabecalho, portanto o ponteiro costuma permanecer
        // perto do topo mesmo quando o gesto e claramente lateral. Usar apenas
        // a borda geometricamente mais proxima classificava esse gesto como
        // "top" e fazia mover para esquerda/direita parecer travado.
        const gestureAxis: 'x' | 'y' = Math.abs(deltaX) >= Math.abs(deltaY) ? 'x' : 'y'
        const currentMinimum = dockMinimumSize(initialDock)
        // Destacar um leaf antes de reinseri-lo pode tornar valido um drop que
        // a caixa ATUAL do alvo aparenta nao comportar. Compare a topologia
        // candidata inteira. Em canvas ja menor que o minimo, permita qualquer
        // reordenacao que nao aumente a exigencia em nenhum eixo.
        const canUseLayout = (candidate: DockLayout): boolean => {
          const minimum = dockMinimumSize(candidate)
          return (
            minimum.w <= Math.max(rect.width, currentMinimum.w) + 0.5 &&
            minimum.h <= Math.max(rect.height, currentMinimum.h) + 0.5
          )
        }
        const candidateBox = (candidate: DockLayout, fallback: CanvasBox): CanvasBox =>
          dockGeometry(
            rect.width,
            rect.height,
            candidate,
            MIN_CANVAS_WIDTH,
            MIN_CANVAS_HEIGHT
          ).boxes[paneId] ?? fallback

        const edgeLimit = Math.min(74, Math.max(46, Math.min(rect.width, rect.height) * 0.09))
        const edgeCandidates: { zone: DockEdge; distance: number }[] =
          gestureAxis === 'x'
            ? [
                { zone: 'left', distance: x },
                { zone: 'right', distance: rect.width - x }
              ]
            : [
                { zone: 'top', distance: y },
                { zone: 'bottom', distance: rect.height - y }
              ]
        edgeCandidates.sort((a, b) => a.distance - b.distance)
        const edge = edgeCandidates[0]
        const edgePaneId = paneAtMatchingCanvasEdge(
          paneId,
          edge.zone,
          pointerGeometry.boxes,
          stage
        )
        const rootCandidate =
          edgePaneId === paneId
            ? initialDock
            : edgePaneId
              ? dockPane(initialDock, paneId, edgePaneId, 'center', 0.5)
              : dockPaneAtRoot(initialDock, paneId, edge.zone, 0.5)
        // Um pane já existente troca com o slot que ocupa a mesma faixa na
        // borda. Isso preserva a topologia/minimos e deixa coluna/linha inteira
        // exclusivamente nos botões dedicados do chrome.
        if (edge.distance <= edgeLimit) {
          return {
            draggedId: paneId,
            targetId: edgePaneId && edgePaneId !== paneId ? edgePaneId : undefined,
            zone: edge.zone,
            scope: 'root',
            layout: rootCandidate,
            box: candidateBox(rootCandidate, dockSlice(stage, edge.zone)),
            label: edgePaneId ? EDGE_MOVE_LABEL[edge.zone] : DOCK_LABEL[edge.zone]
          }
        }

        if (
          Math.abs(x - rect.width / 2) <= 54 &&
          Math.abs(y - rect.height / 2) <= 38
        ) {
          const order = [paneId, ...dockPaneOrder(initialDock).filter((id) => id !== paneId)]
          const gridCandidate = balancedDockLayout(order, rect.width, rect.height)
          return {
            draggedId: paneId,
            zone: 'grid',
            scope: 'grid',
            layout: gridCandidate,
            box: candidateBox(gridCandidate, stage),
            label: DOCK_LABEL.grid
          }
        }

        const target = Object.entries(pointerGeometry.boxes).find(
          ([id, box]) =>
            id !== paneId &&
            x >= box.x &&
            x <= box.x + box.w &&
            y >= box.y &&
            y <= box.y + box.h
        )
        if (!target) return null
        const [targetId, box] = target
        // Mantem a intencao do gesto tambem dentro do pane-alvo. Sem isso, um
        // arrasto horizontal entre cabecalhos escolhia sempre a zona superior
        // (o Y do ponteiro esta naturalmente no topo), em vez de esquerda,
        // centro ou direita.
        const distances: { zone: Exclude<DockZone, 'center'>; distance: number }[] =
          gestureAxis === 'x'
            ? [
                { zone: 'left', distance: (x - box.x) / Math.max(1, box.w) },
                { zone: 'right', distance: (box.x + box.w - x) / Math.max(1, box.w) }
              ]
            : [
                { zone: 'top', distance: (y - box.y) / Math.max(1, box.h) },
                { zone: 'bottom', distance: (box.y + box.h - y) / Math.max(1, box.h) }
              ]
        distances.sort((a, b) => a.distance - b.distance)
        const nearest = distances[0]
        const edgeCandidate = dockPane(
          initialDock,
          paneId,
          targetId,
          nearest.zone,
          0.5,
          rect.width,
          rect.height
        )
        const useEdge = nearest.distance <= 0.28 && canUseLayout(edgeCandidate)
        const zone: DockZone = useEdge ? nearest.zone : 'center'
        const candidate = useEdge
          ? edgeCandidate
          : dockPane(initialDock, paneId, targetId, 'center', 0.5)
        return {
          draggedId: paneId,
          targetId,
          zone,
          scope: 'pane',
          layout: candidate,
          box: candidateBox(candidate, dockSlice(box, zone)),
          label: DOCK_LABEL[zone]
        }
      }

      const publishPreview = (): void => {
        raf = 0
        const next = resolvePreview(latestX, latestY)
        dockPreviewRef.current = next
        setDockPreview(next)
      }

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        latestX = ev.clientX
        latestY = ev.clientY
        if (!active && Math.hypot(latestX - startX, latestY - startY) < 6) return
        if (!active) {
          active = true
          releaseLayout = holdTerminalLayout()
          document.body.classList.add('pane-docking')
          setDockDraggingId(paneId)
        }
        if (!raf) raf = requestAnimationFrame(publishPreview)
      }

      const finish = (commit: boolean): void => {
        if (finished) return
        finished = true
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onCancel)
        handle.removeEventListener('lostpointercapture', onLostCapture)
        window.removeEventListener('blur', onBlur)
        if (handle.hasPointerCapture(pointerId)) {
          try {
            handle.releasePointerCapture(pointerId)
          } catch {
            // A captura pode ter sido liberada pelo navegador.
          }
        }
        document.body.classList.remove('pane-docking')
        dockCleanupRef.current = null

        // O ultimo pointermove pode chegar no mesmo frame do pointerup. Antes
        // cancelavamos o rAF e persistia a preview ANTERIOR (ou nenhuma), o que
        // fazia sobretudo o drop rapido na direita parecer travado.
        const drop = active && commit
          ? resolvePreview(latestX, latestY) ?? dockPreviewRef.current
          : dockPreviewRef.current
        dockPreviewRef.current = null
        setDockDraggingId(null)
        setDockPreview(null)
        if (active && commit && drop) {
          // O hold do gesto não pode acabar antes de o React aplicar a nova
          // geometria. Se a transição de left/top volta no mesmo evento do
          // drop, os panes deslizam deixando o papel branco exposto entre as
          // posições. Um segundo hold atravessa o commit + um paint: todas as
          // caixas assentam juntas, e só então os terminais fazem um único fit.
          const releaseSettledLayout = freezeTerminalLayoutFor(180)
          const nextDock = drop.layout
          const nextPage = {
            ...initialPage,
            dock: nextDock,
            order: dockPaneOrder(nextDock)
          }
          persistNodeLayout(
            activeNode.id,
            updateCanvasPage(initialLayout, initialPage.id, () => nextPage)
          )
          requestAnimationFrame(() => requestAnimationFrame(releaseSettledLayout))
        }
        releaseLayout?.()
      }

      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        // Usa a coordenada do proprio pointerup: em gesto rapido o navegador
        // pode nao emitir outro pointermove antes de soltar.
        latestX = ev.clientX
        latestY = ev.clientY
        finish(true)
      }
      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) finish(false)
      }
      const onLostCapture = (ev: PointerEvent): void => {
        if (ev.pointerId === pointerId) finish(false)
      }
      const onBlur = (): void => finish(false)

      dockCleanupRef.current = () => finish(false)
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onCancel)
      handle.addEventListener('lostpointercapture', onLostCapture)
      window.addEventListener('blur', onBlur)
    },
    [
      activeNode,
      activeCanvas,
      expanded,
      persistNodeLayout,
      stageBox.w,
      stageBox.h
    ]
  )

  // ————— TECLADO —————
  // Ctrl+Alt é a faixa do app: nem claude nem codex a usam, e o TerminalPane
  // bloqueia o repasse. NUNCA usar Esc nem Esc-Esc: o claude usa os dois
  // (cancelar / editar a mensagem anterior).
  const isActive = useStore((s) => s.openProjectId === projectId)
  const tab = useStore((s) => s.universeTabByProject[projectId])
  useEffect(() => {
    if (!isActive || tab !== 'panes') return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.altKey || e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'm') {
        e.preventDefault()
        freezeTerminalLayoutFor(520)
        setPanesUi(projectId, { anchored: null, expanded: null })
      } else if (k === 'f') {
        e.preventDefault()
        freezeTerminalLayoutFor(520)
        setPanesUi(projectId, { immersive: !immersive })
      } else if (k === 'p') {
        e.preventDefault()
        const target = nodes.find((n) => n.attention > 0)
        if (target) {
          const pending = target.paneIds.find((id) => paneAttention[id])
          const targetCanvas = canvasStateByNode.get(target.id)
          const pageId = pending ? canvasPageIdForPane(targetCanvas?.layout, pending) : null
          freezeTerminalLayoutFor(520)
          setPanesUi(projectId, {
            anchored: target.id,
            expanded: pending ?? null,
            ...(targetCanvas && pageId
              ? {
                  canvasByNode: {
                    ...canvasByNode,
                    [target.id]: activateCanvasPage(targetCanvas.layout, pageId)
                  }
                }
              : {})
          })
        }
      } else if (/^[1-9]$/.test(k)) {
        e.preventDefault()
        const node = nodes[Number(k) - 1]
        if (node) anchor(node.id)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    isActive,
    tab,
    projectId,
    immersive,
    nodes,
    paneAttention,
    canvasStateByNode,
    canvasByNode,
    setPanesUi,
    anchor
  ])

  const mode = anchored ? (immersive ? 'imerso' : 'ancorado') : 'mapa'
  const missionsAtivas = missions.filter(
    (m) => m.projectId === projectId && (m.status === 'ativa' || m.status === 'integrando')
  ).length

  const paneNodeById = useMemo(() => {
    const out = new Map<string, string>()
    for (const node of nodes) for (const id of node.paneIds) out.set(id, node.id)
    return out
  }, [nodes])

  const boxForPane = (id: string): CanvasBox | undefined => {
    const nodeId = paneNodeById.get(id)
    return nodeId ? canvasStateByNode.get(nodeId)?.allBoxes[id] : undefined
  }

  const isPaneVisible = (id: string): boolean => {
    const nodeId = paneNodeById.get(id)
    if (!nodeId || !boxForPane(id)) return false
    const onActivePage = canvasStateByNode.get(nodeId)?.page.order.includes(id) ?? false
    return nodeId === activeNode?.id && onActivePage && (!expanded || expanded === id)
  }

  /** Caixa ABSOLUTA do pane. Inativos continuam medidos fora da area visivel
   *  (visibility:hidden), para poderem nascer no tamanho certo sem um resize
   *  destrutivo quando o usuario troca de no. */
  const tileStyle = (id: string, hue?: number | string): React.CSSProperties => {
    const nodeId = paneNodeById.get(id)
    const base = boxForPane(id)
    if (!nodeId || !base || stageBox.w <= 0 || stageBox.h <= 0) return { display: 'none' }
    const visible = isPaneVisible(id)
    const b = visible && expanded === id ? { x: 0, y: 0, w: stageBox.w, h: stageBox.h } : base
    return {
      display: 'flex',
      visibility: visible ? 'visible' : 'hidden',
      pointerEvents: visible ? 'auto' : 'none',
      left: visible ? b.x : -100000,
      top: visible ? b.y : 0,
      width: b.w,
      height: b.h,
      ...(hue !== undefined ? ({ ['--dept-hue' as string]: hue } as React.CSSProperties) : {})
    }
  }

  // A largura da coluna do mapa é decidida no CSS (--map-w por data-mode) — o
  // renderer não mede nada para isso. Só a geometria do MOSAICO precisa de
  // medida real, e essa vem do ResizeObserver do palco.
  return (
    <div className="panes-shell" data-mode={mode}>
      <div className="panes-map">
        {mode === 'imerso' ? (
          <div className="map-spine">
            <div className="spine-controls" role="toolbar" aria-label="Controles do modo imerso">
              <button
                className="spine-btn"
                aria-label="Voltar ao mapa"
                data-tip="Voltar ao mapa (Ctrl+Alt+M)"
                onClick={() => {
                  freezeTerminalLayoutFor(520)
                  setPanesUi(projectId, { anchored: null, expanded: null })
                }}
              >
                ◀
              </button>
              <button
                className="spine-btn on"
                aria-label="Sair do modo imerso"
                data-tip="Sair do modo imerso (Ctrl+Alt+F)"
                onClick={() => {
                  freezeTerminalLayoutFor(520)
                  setPanesUi(projectId, { immersive: false })
                }}
              >
                ⛶
              </button>
            </div>
            {nodes.map((node) => (
              <button
                key={node.id}
                className={`spine-node${anchored === node.id ? ' on' : ''}${
                  node.attention > 0 ? ' needs-perm' : ''
                }`}
                style={{ ['--node-hue' as string]: hueOfNode(node) }}
                data-tip={`${node.label}\n${node.paneIds.length} painéis`}
                onClick={() => anchor(node.id)}
              >
                <i className="spine-dot" />
                <b>{node.paneIds.length}</b>
              </button>
            ))}
          </div>
        ) : (
          <ConstellationMap
            projectId={projectId}
            projectName={project?.name ?? 'projeto'}
            projectPhoto={project?.photo}
            nodes={nodes}
            anchored={anchored}
            openedPaneId={expanded}
            itemActivity={paneActivity}
            itemAttention={paneAttention}
            onAnchor={anchor}
            onOpenMission={openMissionOnBoard}
            onOpenPane={openPaneFromMap}
            // F3-c4: o board mora no HOST — navegar é relay via main (o tab
            // local desta view fica cravado em 'panes' de propósito).
            onOpenBoard={() => window.synkora.panesView.navigateHost(projectId, 'board')}
            missionsAtivas={missionsAtivas}
            panesAtivos={panes.length}
          />
        )}
      </div>

      <div className="panes-stage">
        <div className="stage-bar">
          <button
            className="btn ghost tiny"
            data-tip="Voltar ao mapa (Ctrl+Alt+M)"
            onClick={() => {
              freezeTerminalLayoutFor(520)
              setPanesUi(projectId, { anchored: null, expanded: null })
            }}
          >
            ◀<span className="btn-label">mapa</span>
          </button>
          <span className="stage-title">{activeNode?.label ?? ''}</span>
          {activeNode && (
            <span className="stage-hint">
              {activeNode.paneIds.length}{' '}
              {activeNode.paneIds.length === 1 ? 'pane' : 'panes'}
              {nodeItems.length > 1 ? ' · arraste um cabeçalho para encaixar' : ''}
            </span>
          )}
          <button
            className={`btn ghost tiny${immersive ? ' on' : ''}`}
            data-tip="Modo imerso: o mapa vira uma espinha estreita (Ctrl+Alt+F)"
            onClick={() => {
              freezeTerminalLayoutFor(520)
              setPanesUi(projectId, { immersive: !immersive })
            }}
          >
            ⛶<span className="btn-label">imerso</span>
          </button>
        </div>

        {activeCanvas && (activeCanvas.layout.pages?.length ?? 0) > 1 && (
          <div className="pane-page-tabs" role="tablist" aria-label="Páginas de panes">
            {activeCanvas.layout.pages?.map((page, index) => (
              <button
                key={page.id}
                type="button"
                role="tab"
                aria-selected={page.id === activeCanvas.page.id}
                className={`pane-page-tab${page.id === activeCanvas.page.id ? ' active' : ''}`}
                data-tip={`${page.order.length} ${page.order.length === 1 ? 'pane' : 'panes'}`}
                onClick={() => selectCanvasPage(page.id)}
              >
                Página {index + 1}
                <b>{page.order.length}</b>
              </button>
            ))}
          </div>
        )}

        <div ref={floorRef} className={`stage-floor${expanded ? ' has-expanded' : ''}`}>
          {/* ————— DECK: LISTA PLANA, POSIÇÃO FIXA NO JSX ————— */}
          {panes.map((pane) => {
            const seat = pane.seatId ? seats.find((s) => s.id === pane.seatId) : undefined
            // por PANE: dev, ajudantes e gate dividem o taskId — antes a atenção
            // acendia em todos e digitar em qualquer um apagava o aviso do que travou
            const attention = paneAttention[pane.id] ?? false
            const task = pane.taskId ? tasks.find((t) => t.id === pane.taskId) : undefined
            const dept = task ? DEPT_BY_KEY[task.department] : undefined
            const baseBox = boxForPane(pane.id)
            const terminalBox =
              expanded === pane.id ? { x: 0, y: 0, w: stageBox.w, h: stageBox.h } : baseBox
            const compactTitle = !!terminalBox && terminalBox.w < 320
            // SUPERFÍCIE do pane: 'gui' troca o xterm pelo chat e NÃO cria PTY
            // nenhum (nada aqui chega ao TerminalPane, que é quem spawna).
            const isGui = pane.surface === 'gui'
            const gui = isGui ? guiPanes[pane.id] : undefined
            const guiStats: PaneStats | undefined = isGui
              ? {
                  model: gui?.model ?? undefined,
                  inputTokens: 0,
                  outputTokens: 0,
                  contextTokens: gui?.contextTokens ?? null,
                  contextWindow: gui?.contextWindow ?? null,
                  costUsd: gui?.costUsd ?? undefined
                }
              : undefined
            // A tipografia é uma preferência global FIXA. Encolher o ladrilho
            // reduz cols×rows; nunca reduz ou amplia os glifos.
            const terminalFont = settings?.terminalFontSize ?? TERMINAL_DEFAULT_FONT_SIZE
            const terminalLineHeight =
              settings?.terminalLineHeight ?? TERMINAL_DEFAULT_LINE_HEIGHT
            const terminalFontFamily =
              settings?.terminalFontFamily ?? TERMINAL_DEFAULT_FONT_FAMILY
            const fallback = terminalFallbackForBox(
              terminalBox,
              terminalFont,
              terminalLineHeight,
              pane.kind === 'claude' ? TERMINAL_NATIVE_SCROLLBAR_WIDTH : undefined
            )
            const terminalMinCols = terminalMinColsForBox(pane.kind, fallback)
            const nodeId = paneNodeById.get(pane.id) ?? 'sem-no'
            const visible = isPaneVisible(pane.id)
            // fase executável do pipeline: só ela ganha o ⇄ de troca de conta
            const phaseRole =
              pane.role === 'dev' || pane.role === 'review' || pane.role === 'qa'
                ? pane.role
                : undefined
            const phaseTaskId = pane.taskId
            const sizeGroup = terminalBox
              ? `canvas:${projectId}:${Math.round(terminalBox.w)}x${Math.round(terminalBox.h)}:${terminalFont}:${terminalLineHeight}:${terminalFontFamily}:${pane.kind}`
              : `canvas:${projectId}:${nodeId}:fallback:${pane.kind}`
            return (
              <div
                key={pane.id}
                className={`pane term-window ${pane.kind}${attention ? ' needs-perm' : ''}${
                  expanded === pane.id ? ' expanded' : ''
                }${visible ? ' on-stage' : ''}${compactTitle ? ' compact-title' : ''}${
                  dockDraggingId === pane.id ? ' dock-source' : ''
                }`}
                style={tileStyle(pane.id, dept && deptHueVar(dept.key))}
                aria-hidden={visible ? undefined : true}
                inert={visible ? undefined : true}
              >
                <PaneChrome
                  role={pane.role ?? (pane.kind === 'shell' ? undefined : 'livre')}
                  kind={pane.kind}
                  deptHue={dept && deptHueVar(dept.key)}
                  seatName={seat?.name}
                  model={isGui ? (gui?.model ?? pane.model) : (paneModel[pane.id] ?? pane.model)}
                  effort={isGui ? pane.effort : paneEffort[pane.id]}
                  title={pane.title}
                  activity={
                    isGui
                      ? GUI_ACTIVITY[gui?.status ?? 'starting']
                      : paneActivity[pane.id]
                  }
                  stats={
                    isGui
                      ? guiStats
                      : (paneStats[pane.id] ?? (pane.kind !== 'shell' ? ZERO_STATS : undefined))
                  }
                  hideTokens={isGui}
                  focused={expanded === pane.id}
                  onToggleFocus={() => toggleExpand(pane.id)}
                  onMakeColumn={() => spanPane(pane.id, 'x')}
                  onMakeRow={() => spanPane(pane.id, 'y')}
                  onDragStart={(e) => startPaneDock(e, pane.id)}
                  onClose={() => closePane(projectId, pane.id)}
                >
                  {/* ⇄ só em pane de FASE (dev/review/qa com card): o main
                      troca a conta preservando worktree/conversa e reabre o
                      pane sozinho — a UI apenas escolhe conta/modelo/effort. */}
                  {phaseRole && phaseTaskId && (
                    <button
                      className="term-btn ghost-dim"
                      data-tip="trocar conta desta fase"
                      aria-label="Trocar conta desta fase"
                      onClick={() =>
                        setPhaseReseat({
                          taskId: phaseTaskId,
                          phase: phaseRole,
                          title: task?.title ?? pane.title,
                          seatId: pane.seatId
                        })
                      }
                    >
                      ⇄<span className="btn-label">conta</span>
                    </button>
                  )}
                </PaneChrome>
                {/* A superfície é decidida no NASCIMENTO do pane e nunca muda,
                    então este ternário jamais troca de ramo com o pane vivo —
                    a regra de ouro do deck (nada remonta) segue intacta. */}
                {isGui ? (
                  <GuiPane
                    paneId={pane.id}
                    projectId={projectId}
                    cli={pane.kind === 'codex' ? 'codex' : 'claude'}
                    configDir={seat?.configDir}
                    cwd={pane.cwd ?? projectPath}
                    model={pane.model}
                    effort={pane.effort}
                    systemPrompt={pane.systemPrompt ?? pane.appendSystemPrompt}
                    resumeSessionId={pane.resumeSessionId}
                    firstPrompt={pane.initialPrompt}
                  />
                ) : (
                  <TerminalPane
                    paneId={pane.id}
                    cwd={pane.cwd ?? projectPath}
                    kind={pane.kind}
                    projectId={projectId}
                    seatId={pane.seatId}
                    taskId={pane.taskId}
                    initialPrompt={pane.initialPrompt}
                    model={pane.model}
                    cliArgs={pane.cliArgs}
                    appendSystemPrompt={pane.appendSystemPrompt}
                    logFile={pane.logFile}
                    imagePasteProjectId={projectId}
                    fontSize={terminalFont}
                    lineHeight={terminalLineHeight}
                    fontFamily={terminalFontFamily}
                    minCols={terminalMinCols}
                    minRows={pane.kind === 'claude' ? 12 : 6}
                    fallbackSize={fallback}
                    sizeGroup={sizeGroup}
                    voiceLabel={pane.title}
                    onUserInput={() => {
                      clearPaneAttention(projectId, pane.id)
                      // F3-c4: o pulso do rail/abas do host apaga junto.
                      window.synkora.panesView.reportAttentionCleared(projectId, pane.id)
                    }}
                  />
                )}
              </div>
            )
          })}

          {dockDraggingId && (
            <div className="dock-layer" aria-hidden="true">
              <div
                className={`dock-global-zone left${
                  dockPreview?.scope === 'root' && dockPreview.zone === 'left' ? ' active' : ''
                }`}
              >
                COL
              </div>
              <div
                className={`dock-global-zone right${
                  dockPreview?.scope === 'root' && dockPreview.zone === 'right' ? ' active' : ''
                }`}
              >
                COL
              </div>
              <div
                className={`dock-global-zone top${
                  dockPreview?.scope === 'root' && dockPreview.zone === 'top' ? ' active' : ''
                }`}
              >
                LINHA
              </div>
              <div
                className={`dock-global-zone bottom${
                  dockPreview?.scope === 'root' && dockPreview.zone === 'bottom' ? ' active' : ''
                }`}
              >
                LINHA
              </div>
              <div
                className={`dock-global-zone grid${dockPreview?.scope === 'grid' ? ' active' : ''}`}
              >
                GRADE
              </div>
              {dockPreview && (
                <div
                  className="dock-preview"
                  style={{
                    left: dockPreview.box.x,
                    top: dockPreview.box.y,
                    width: dockPreview.box.w,
                    height: dockPreview.box.h
                  }}
                >
                  <span>{dockPreview.label}</span>
                </div>
              )}
            </div>
          )}

          {!expanded &&
            activeCanvas?.geometry.dividers.map((divider) => (
              <div
                key={divider.id}
                className={`canvas-divider axis-${divider.axis}`}
                style={{
                  left: divider.x,
                  top: divider.y,
                  width: divider.w,
                  height: divider.h
                }}
                role="separator"
                aria-orientation={divider.axis === 'x' ? 'vertical' : 'horizontal'}
                aria-label="Redimensionar panes"
                tabIndex={0}
                onPointerDown={(e) => startDividerDrag(e, divider)}
                onDoubleClick={resetCanvasRatios}
                onKeyDown={(e) => {
                  const delta =
                    divider.axis === 'x'
                      ? e.key === 'ArrowLeft'
                        ? -24
                        : e.key === 'ArrowRight'
                          ? 24
                          : 0
                      : e.key === 'ArrowUp'
                        ? -24
                        : e.key === 'ArrowDown'
                          ? 24
                          : 0
                  if (!delta || !activeNode || !activeCanvas?.page.dock) return
                  e.preventDefault()
                  const nextDock = resizeDockDivider(
                    activeCanvas.page.dock,
                    divider,
                    delta,
                    stageBox.w,
                    stageBox.h,
                    MIN_CANVAS_WIDTH,
                    MIN_CANVAS_HEIGHT
                  )
                  const nextPage = {
                    ...activeCanvas.page,
                    dock: nextDock
                  }
                  persistNodeLayout(
                    activeNode.id,
                    updateCanvasPage(activeCanvas.layout, activeCanvas.page.id, () => nextPage)
                  )
                }}
              />
            ))}
        </div>

        {!activeNode && (
          <div className="stage-empty">
            <p className="hint">
              Clique num card do mapa para abrir os terminais daquela missão.
            </p>
          </div>
        )}
      </div>

      {/* modal via portal (PhaseSeatModal usa createPortal no body) — irmão do
          deck, nunca pai: abrir/fechar não toca na posição dos TerminalPane. */}
      {phaseReseat && (
        <PhaseSeatModal
          projectId={projectId}
          taskId={phaseReseat.taskId}
          phase={phaseReseat.phase}
          taskTitle={phaseReseat.title}
          currentSeatId={phaseReseat.seatId}
          onClose={() => setPhaseReseat(null)}
        />
      )}
    </div>
  )
}

export { NODE_GERAL }

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import PaneChrome, { ZERO_STATS, prettyModel } from './PaneChrome'
import TerminalPane from './TerminalPane'
import GuiPane from './GuiPane'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import ProjectGeneral from './ProjectGeneral'
import ProjectDashboard from './ProjectDashboard'
import NewMissionModal from './NewMissionModal'
import MissionColumn, { type MissionColumnEntry } from './MissionColumn'
import MissionDeliveryRail from './MissionDeliveryRail'
import ResizableRightRail from './ResizableRightRail'
import MissionStageHead, { type StagePill } from './MissionStageHead'
import { TestServerModal } from './TestServerModal'
import { ModelSelect } from './ModelSelect'
import Select from './Select'
import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
  TERMINAL_NATIVE_SCROLLBAR_WIDTH,
  TERMINAL_SCROLLBAR_WIDTH,
  terminalFallbackForHost,
  terminalMinColsForBox
} from '../terminalGeometry'
import {
  useStore,
  missionTypeOf,
  type Department,
  type Mission,
  type Pane,
  type PlanLane,
  type Task,
  type TaskStatus,
  type TaskType,
  type Version
} from '../store'
import type { GuiPaneSpawn, GuiPermissionMode } from '../guiApi'
import { guiModelLabel } from '../guiComposerPresentation'
import { missionGui, type MissionGuiRole } from '../missionGui'
import { GuiRequestEpoch, withoutMissionGuiSlots } from '../guiRequestEpoch'
import GuiSeatPick from './GuiSeatPick'
import { missionShell } from '../missionShell'
import { projectLanding } from '../projectLanding'
// O convite de planejamento que nascia sozinho no ✦ geral MORREU (ordem do
// dono, 2026-08-13 — "o universo começa vazio"). Planejar virou um TIPO de
// missão que o dono cria, e o chat dela abre pelo `missions:guiSpec` como
// qualquer outra. O canal `projects:planningGuiSpec` fica INTACTO no main e no
// preload, dormente e alcançável direto por `window.synkora.projects`; a ponte
// de renderer que o embrulhava saiu por não ter mais nenhum importador.

/** Uma conversa aberta de uma missão DIRETA (onda B). O papel não viaja na
 *  spec — é o Board que sabe por que pediu cada uma. */
interface MissionGuiSlot {
  role: MissionGuiRole
  spawn: GuiPaneSpawn
}

const MISSION_GUI_ROLE_LABEL: Record<MissionGuiRole, string> = {
  dev: 'agente',
  reviewer: 'revisor',
  helper: 'ajudante'
}

// O mapa de papel→chrome (MISSION_GUI_PANE_ROLE) e o LED da sessão
// (GUI_ACTIVITY) morreram com o titlebar escuro sobre o chat: no palco 2.0 a
// identidade da conversa é a PÍLULA ativa + a linha fina do MissionStageHead,
// e o estado do turno é o próprio chat (cursor de streaming). O PaneChrome
// segue vivo — só para o mundo legado, onde o que roda é um TUI.

// Spec do pane TUI do Maestro (tipo vem da bridge do preload).
type MaestroPaneSpec = NonNullable<Awaited<ReturnType<typeof window.synkora.maestro.paneSpec>>>

function integrationQueueLabel(mission: Mission): string | undefined {
  const integration = mission.integration
  if (!integration) return undefined
  if (integration.state === 'merging') return 'integrando agora'
  if (integration.state === 'blocked')
    return integration.owner === 'orchestrator'
      ? 'fila pausada — reparo seguro do destino pendente'
      : 'fila pausada — Maestro decidindo'
  if (integration.state === 'sync_required') return 'sincronizando antes de integrar'
  return `fila de integração #${integration.position} de ${integration.total}`
}

// O PIPELINE F6 morava daqui até o começo do componente: rótulos de perfil e
// risco, PHASE_META/taskPhaseView/planWorkState (as fases dev→review→QA),
// PlanContract, belongsToPlan, LaneEffortSelect e os três painéis —
// PlanModal, TaskModal e DeptStats. Tudo saiu na purga F6 (2026-08-17): a
// missão 2.0 não tem card, plano de lanes nem função com estatística.
// `integrationQueueLabel` FICA logo acima: é a fila de integração, que é 2.0.

interface Props {
  projectId: string
}

const NO_PANES: never[] = []
const NO_ASK_QUESTIONS: Record<string, string> = {}

export default function Board({ projectId }: Props): React.JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const missions = useStore((s) => s.missions)
  // Retrato por versão do painel do projeto (✦ geral com missões). NÃO se
  // busca aqui: o Universe, que hospeda este Board, já faz o load preguiçoso
  // do `homeStats` deste projeto, e os canais *:changed o mantêm fresco.
  const homeStats = useStore((s) => s.homeStats[projectId])
  const loadMissions = useStore((s) => s.loadMissions)
  const archiveMission = useStore((s) => s.archiveMission)
  const deleteMission = useStore((s) => s.deleteMission)
  const integrateMission = useStore((s) => s.integrateMission)
  const missionTab = useStore((s) => s.missionTabByProject[projectId] ?? null)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const maestroModel = useStore((s) => s.maestroModel)
  const maestroEffort = useStore((s) => s.maestroEffort)
  const panes = useStore((s) => s.panesByProject[projectId] ?? NO_PANES)
  const closePane = useStore((s) => s.closePane)
  const loadTasks = useStore((s) => s.loadTasks)
  const loadMaestroLog = useStore((s) => s.loadMaestroLog)
  // Seat do PM: hoje só alimenta o chrome do mundo LEGADO (marca do CLI do
  // pane do Maestro e o fallback de seat do orquestrador de missão antiga).
  // Missão 2.0 nunca passa por aqui — a conta dela é `mission.seatId`.
  const maestroSeatId = useStore((s) => s.maestroSeatId)
  const paneStats = useStore((s) => s.paneStats)
  const paneEffort = useStore((s) => s.paneEffort)
  const paneModel = useStore((s) => s.paneModel)
  const paneActivity = useStore((s) => s.paneActivity)
  const guiPanes = useStore((s) => s.guiPanes)
  const clearPaneAttention = useStore((s) => s.clearPaneAttention)
  const resetPaneTelemetry = useStore((s) => s.resetPaneTelemetry)
  // Vários universos ficam montados ao mesmo tempo (troca estilo Discord) —
  // efeitos que mexem em estado global/processos só rodam no projeto ATIVO.
  const isActive = useStore((s) => s.openProjectId === projectId)
  const appPage = useStore((s) => s.appPage)
  const projectFlow = useStore((s) => s.projects.find((p) => p.id === projectId))
  // Spec do pane TUI do Maestro/PM (terminal real; persona + MCP + resume).
  const [maestroSpec, setMaestroSpec] = useState<MaestroPaneSpec | null>(null)
  // Specs dos ORQUESTRADORES por missão — panes ficam MONTADOS (display:none
  // fora da aba ativa), como tudo que roda CLI de verdade.
  const [missionSpecs, setMissionSpecs] = useState<Record<string, MaestroPaneSpec>>({})
  // MISSÃO DIRETA (2.0): no lugar do orquestrador TUI, uma ou mais CONVERSAS
  // GUI no worktree — o agente (dev), o revisor de sessão limpa e ajudantes.
  // Todas ficam MONTADAS depois de abertas (a conversa É o trabalho); trocar
  // de papel só troca qual slot está visível.
  const [missionGuiSlots, setMissionGuiSlots] = useState<Record<string, MissionGuiSlot[]>>({})
  const [missionGuiActive, setMissionGuiActive] = useState<Record<string, string>>({})
  const [missionGuiError, setMissionGuiError] = useState<Record<string, string>>({})
  // Missão sem conta escolhida (2.0): não é erro — é o CARD de escolha no
  // lugar da conversa. `seatBusy` trava o card enquanto o main troca a conta.
  const [missionNeedsSeat, setMissionNeedsSeat] = useState<Record<string, boolean>>({})
  const [seatBusy, setSeatBusy] = useState<string | null>(null)
  // A geração é o valor, não só uma trava booleana: uma Promise velha
  // nunca pode apagar a trava do pedido novo que reutilizou a mesma chave.
  const missionGuiInFlight = useRef<Map<string, number>>(new Map())
  const missionGuiEpoch = useRef(new GuiRequestEpoch())
  const seatChangeInFlight = useRef(false)
  const dropGuiPane = useStore((s) => s.dropGuiPane)
  // PLANEJAMENTO (2.0): o estado da sessão avulsa saiu daqui. Planejar é uma
  // MISSÃO de tipo 'planejamento' — o chat dela nasce e vive nos mesmos
  // `missionGuiSlots` acima, sem caminho paralelo nenhum.
  // ONDA D: a aba PANES morreu e o terminal virou SLOT aqui no centro. Estas
  // duas seleções dizem qual slot de TERMINAL está no ar; null = a conversa da
  // missão ocupa a coluna, como antes.
  const [missionTerm, setMissionTerm] = useState<Record<string, string | null>>({})
  const [generalTerm, setGeneralTerm] = useState<string | null>(null)
  // O trilho de entrega re-mede o diff quando isto muda (⇪, arquivar…).
  const [railReload, setRailReload] = useState(0)
  const [newMissionOpen, setNewMissionOpen] = useState(false)
  // Troca de CONTA do orquestrador no meio da missão (limite estourou):
  // mesmo CLI = a conversa é transplantada junto (sondas 2026-08-04).
  const [testServerOpen, setTestServerOpen] = useState(false)
  // Perguntas do Maestro/orquestrador dirigidas ao USUÁRIO (tool ask_user):
  // a aba correspondente pulsa até ser aberta. O estado agora é GLOBAL no
  // store (App assina e reidrata) — rail e abas do universo pulsam de
  // qualquer lugar; aqui só se lê e se dispensa ao visitar.
  const askPulse = useStore((s) => s.askQuestions[projectId] ?? NO_ASK_QUESTIONS)
  const clearAskQuestion = useStore((s) => s.clearAskQuestion)
  const uniTab = useStore((s) => s.universeTabByProject[projectId] ?? 'board')
  // Missão criada pelo PM aguardando a escolha do orquestrador no modal;
  // "depois" marca dismissed e o placeholder da aba da missão reabre.
  const [pendingOrchDismissed, setPendingOrchDismissed] = useState<Record<string, boolean>>({})
  // Missão DIRETA nunca pede orquestrador: se um carimbo legado de
  // `pendingOrchestrator` sobrar nela, o modal de escolha não deve abrir —
  // não há orquestrador para nascer.
  const pendingOrchMission = missions.find(
    (m) => m.status === 'ativa' && m.pendingOrchestrator && !m.direct
  )
  // "nova missão a partir deste card" (card done de missão já integrada):
  // abre o MESMO modal com título/goal pré-preenchidos referenciando o card.
  const [missionPrefill, setMissionPrefill] = useState<{ title: string; goal: string } | null>(
    null
  )
  const [missionMsg, setMissionMsg] = useState<string | null>(null)
  const [missionCopied, setMissionCopied] = useState(false)
  // Confirmação de exclusão NOSSA (window.confirm nativo do Electron quebra o
  // foco da janela no Windows — cliques morriam depois dele — e era feio).
  // Versões do app (chip ◈ na missão + tooltip das abas).
  const [versionsList, setVersionsList] = useState<Version[]>([])
  useEffect(() => {
    if (!window.synkora.backlog) return
    void window.synkora.backlog.listVersions(projectId).then(setVersionsList)
    return window.synkora.backlog.onChanged((pid) => {
      if (pid === projectId) void window.synkora.backlog.listVersions(projectId).then(setVersionsList)
    })
  }, [projectId])
  const versionName = (vid?: string): string | undefined =>
    vid ? versionsList.find((v) => v.id === vid)?.name : undefined

  const winRef = useRef<HTMLDivElement>(null)
  const maestroTerminalRef = useRef<HTMLDivElement>(null)
  const [maestroTerminalBox, setMaestroTerminalBox] = useState({ w: 0, h: 0 })
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  // Pointer capture normalmente entrega pointerup, mas troca de projeto,
  // unmount ou perda da janela podem interromper o gesto antes disso.
  useLayoutEffect(
    () => () => {
      resizeCleanupRef.current?.()
    },
    []
  )

  // A largura salva é uma PREFERÊNCIA, não a largura física obrigatória. O CSS
  // limita essa preferência pela caixa real do board e sempre reserva espaço
  // para a coluna clara. Quando a janela volta a crescer, a preferência reaparece
  // sem ter sido sobrescrita pelo tamanho temporariamente menor.
  useLayoutEffect(() => {
    const el = winRef.current
    if (!el) return
    const saved = Number(localStorage.getItem('synkora.maestroWidth.v3'))
    const half = Math.round(window.innerWidth * 0.5)
    const preferred = Number.isFinite(saved) && saved >= 420 ? saved : half
    el.style.setProperty('--maestro-preferred-width', `${Math.round(preferred)}px`)
  }, [])

  // Maestro e orquestradores usam exatamente a mesma geometria responsiva do
  // canvas. Medir o corpo real evita reaproveitar 120x30 quando a coluna esta
  // estreita (causa da borda direita cortada nos TUIs oficiais).
  useLayoutEffect(() => {
    const el = maestroTerminalRef.current
    if (!el) return
    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      // O ref aponta para .maestro-body. A caixa útil do host fica DENTRO do
      // padding; usar o border-box superestimava as colunas em panes estreitos.
      const width =
        rect.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      const height =
        rect.height - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)
      if (width <= 0 || height <= 0) return
      setMaestroTerminalBox((current) =>
        Math.round(current.w) === Math.round(width) &&
        Math.round(current.h) === Math.round(height)
          ? current
          : { w: width, h: height }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  // Arrasto da alça do Maestro. Delta INVERTIDO de propósito (row-reverse:
  // arrastar para a ESQUERDA alarga). Mesma clamp do layout inicial; a
  // persistência ocorre só no fim DESTE gesto. Um ResizeObserver gravava também
  // a largura temporariamente limitada por 72vw ao encolher a janela, fazendo o
  // Maestro continuar pequeno quando a janela crescia de novo.
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>): void {
    const el = winRef.current
    if (!el || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    // Um segundo pointerdown não pode deixar listeners/trava do gesto anterior.
    resizeCleanupRef.current?.()
    e.preventDefault()
    const startX = e.clientX
    const startW = el.offsetWidth
    const handle = e.currentTarget
    const pointerId = e.pointerId
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      return
    }
    handle.classList.add('dragging')
    let raf = 0
    let next = startW
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      const available = el.parentElement?.clientWidth ?? window.innerWidth
      // Reserva 420px para o conteúdo e 12px para o gap. O limite usa a caixa
      // real do split (sem rail/paddings), nunca a largura global da janela.
      const max = Math.max(420, Math.min(available * 0.72, available - 432))
      next = Math.min(Math.max(startW + (startX - ev.clientX), 420), max)
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        el.style.setProperty('--maestro-preferred-width', `${next}px`)
      })
    }
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      el.style.setProperty('--maestro-preferred-width', `${next}px`)
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
          // A captura já pode ter sido liberada pelo browser.
        }
      }
      if (next >= 420) localStorage.setItem('synkora.maestroWidth.v3', String(Math.round(next)))
      if (resizeCleanupRef.current === finish) resizeCleanupRef.current = null
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
    resizeCleanupRef.current = finish
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onCancel)
    handle.addEventListener('lostpointercapture', onLostCapture)
    window.addEventListener('blur', onCancel)
  }

  const loadPolicies = useStore((s) => s.loadPolicies)
  const taskAttention = useStore((s) => s.taskAttention)
  // ONDA D: o bypass do UNIVERSO saiu da tela (a permissão é por conversa
  // agora). As ações seguem no store, dormentes, para o pipeline legado.

  useEffect(() => {
    void loadTasks(projectId)
    void loadMaestroLog(projectId)
    void loadPolicies(projectId)
    void loadMissions(projectId)
  }, [projectId, loadTasks, loadMaestroLog, loadPolicies, loadMissions])

  // Missões mudaram no main (criada pelo PM, integrada, sync…) → recarrega.
  useEffect(() => {
    if (!window.synkora.missions) return
    return window.synkora.missions.onChanged((pid) => {
      if (pid === projectId && useStore.getState().openProjectId === projectId) {
        void loadMissions(projectId)
        void loadTasks(projectId)
      }
    })
  }, [projectId, loadMissions, loadTasks])

  // O main avisa quando o Maestro cria tarefas — o board ATIVO recarrega na
  // hora (boards escondidos não podem sobrescrever o estado global de tasks).
  useEffect(() => {
    return window.synkora.tasks.onChanged((pid) => {
      if (pid === projectId && useStore.getState().openProjectId === projectId)
        void loadTasks(projectId)
    })
  }, [projectId, loadTasks])

  // RECONCILIADOR DO BOARD (caso real 2026-08-12: o merge concluiu o card às
  // 18:50 e o board seguiu desenhando "em execução" — um tasks:changed se
  // perdeu no caminho; princípio F6.10: nenhum passo depende de entrega
  // única). Board ATIVO re-busca as tasks a cada 30s — push perdido custa
  // segundos, nunca uma tela mentindo até o próximo evento.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (useStore.getState().openProjectId === projectId) void loadTasks(projectId)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [projectId, loadTasks])

  const maestroStateLoaded = useStore((s) => s.maestroStateLoaded)

  // MISSÃO LEGADA VIVA (2.0): o PM permanente existe para o ECOSSISTEMA antigo
  // — orquestradores, cards, fila, ask_user. Missão DIRETA não tem nada disso:
  // a conversa É o trabalho, e planejar virou uma sessão PONTUAL. Sem nenhuma
  // missão legada viva o Maestro não nasce (o main veta o paneSpec do mesmo
  // jeito) e a coluna ✦ geral vira a casa do planejamento.
  const hasLegacyLiveMission = missions.some(
    (m) =>
      m.projectId === projectId &&
      (m.status === 'ativa' || m.status === 'integrando') &&
      !m.direct
  )

  // Seat escolhido (gate) → busca a spec do pane TUI do Maestro. Só busca
  // quando FALTA spec ou o seat mudou: paneSpec RESPAWNA o processo no main,
  // e o pane vivo deve sobreviver à troca de projeto (universos montados).
  // GUARD maestroStateLoaded: ao VOLTAR para o projeto, o maestroSeatId
  // global ainda é o do projeto anterior por um instante — sem o guard o
  // Board achava que o seat mudou e respawnava o Maestro à toa.
  const maestroSpecBump = useStore((s) => s.maestroSpecBumpByProject[projectId] ?? 0)
  const lastBumpRef = useRef(maestroSpecBump)
  useEffect(() => {
    if (!isActive || !maestroStateLoaded) return
    let stale = false
    if (!maestroSeatId) {
      setMaestroSpec(null)
      return
    }
    // Sem missão legada viva o PM não tem ecossistema para coordenar: nem
    // pede spec (o main recusaria). Um pane JÁ vivo daqui não é derrubado —
    // matá-lo jogaria fora a conversa do dono por causa de um merge.
    if (!hasLegacyLiveMission) return
    // bump = usuário redefiniu seat/modelo/effort no gate (o main já matou o
    // pane) — busca spec nova mesmo com o seat igual
    const bumped = lastBumpRef.current !== maestroSpecBump
    if (maestroSpec && maestroSpec.seatId === maestroSeatId && !bumped) return
    lastBumpRef.current = maestroSpecBump
    void window.synkora.maestro.paneSpec(projectId).then((spec) => {
      if (!stale) setMaestroSpec(spec)
    })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    maestroSeatId,
    isActive,
    maestroStateLoaded,
    maestroSpec?.seatId,
    maestroSpecBump,
    hasLegacyLiveMission
  ])

  // Missão selecionada (aba). SÓ missão VIVA vale: com selMission apontando para
  // uma missão concluída/arquivada a aba 🚀 dela desaparecia da fila mas nenhuma
  // aba ficava ativa — a página ✦ geral não renderizava e o terminal do PM
  // continuava montado e ESCONDIDO, deixando o usuário sem terminal nenhum.
  // TODAS as missões deste universo (o store guarda só o projeto aberto, mas o
  // filtro por projectId é o contrato do resto do arquivo). É a base do painel
  // do ✦ geral: ele conta integradas e arquivadas, que `liveMissions` descarta.
  const projectMissions = missions.filter((m) => m.projectId === projectId)
  const liveMissions = projectMissions.filter(
    (m) => m.status === 'ativa' || m.status === 'integrando'
  )
  const selMission = missionTab ? liveMissions.find((m) => m.id === missionTab) : undefined

  // ask_user: reidrata as pendências deste projeto (a assinatura de perguntas
  // novas é GLOBAL, no App). Visitar a aba marca a pergunta como vista — mas
  // SÓ com o board realmente VISÍVEL: um Board montado-e-escondido (outro
  // projeto aberto, ou usuário na aba Panes) dispensava a pergunta sem
  // ninguém ver (bug achado na varredura do mapa, 2026-08-06).
  const loadAskQuestions = useStore((s) => s.loadAskQuestions)
  useEffect(() => {
    void loadAskQuestions(projectId)
  }, [projectId, loadAskQuestions])
  useEffect(() => {
    if (!isActive || uniTab !== 'board') return
    const key = selMission?.id ?? 'geral'
    if (!askPulse[key]) return
    void window.synkora.maestro.questionSeen?.(projectId, key)
    clearAskQuestion(projectId, key)
  }, [projectId, selMission?.id, askPulse, isActive, uniTab, clearAskQuestion])
  // Rede de segurança do ask_user (heurística, melhor esforço): pane de
  // PM/orquestrador AQUIETADO com a última linha terminando em "?" e a aba
  // escondida = provavelmente esperando o dono. Falso positivo custa um pulso
  // discreto; visitar a aba dispensa AQUELA pergunta (linha igual não re-pulsa).
  const paneLastLines = useStore((s) => s.paneLastLines)
  const [dismissedQ, setDismissedQ] = useState<Record<string, string>>({})
  const heurPulse = useMemo(() => {
    const out: Record<string, string> = {}
    const check = (paneId: string, key: string): void => {
      const lines = paneLastLines[paneId]
      if (!lines?.length) return
      const last = [...lines].reverse().find((l) => l.trim())?.trim()
      if (!last || !last.endsWith('?')) return
      if (paneActivity[paneId] === 'run') return
      if (dismissedQ[key] === last) return
      out[key] = last
    }
    check(`maestro-${projectId}`, 'geral')
    for (const m of liveMissions) check(`maestro-${projectId}--${m.id}`, m.id)
    return out
  }, [paneLastLines, paneActivity, dismissedQ, projectId, liveMissions])
  useEffect(() => {
    const key = selMission?.id ?? 'geral'
    if (heurPulse[key]) setDismissedQ((p) => ({ ...p, [key]: heurPulse[key] }))
  }, [selMission?.id, heurPulse])
  // ask_user (tool) tem prioridade sobre a heurística no rótulo do tooltip
  const tabPulse = { ...heurPulse, ...askPulse }

  // Orquestradores rodam EM SEGUNDO PLANO desde a criação da missão (decisão
  // do usuário): TODA missão viva do projeto ativo ganha spec/pane na hora —
  // trocar de aba já encontra o orquestrador pronto. paneSpec RESPAWNA o
  // processo, então só busca quando FALTA; a trava de voo evita o fetch duplo
  // (o efeito redispara enquanto o 1º resolve — dava banner duplicado).
  const missionSpecInFlight = useRef<Set<string>>(new Set())
  // Mortes recentes por missão: pane que morre NO SPAWN virava loop infinito
  // de respawn (33 ciclos em 02/08 — persona acima do teto de argv do
  // Windows). 3 mortes em 30s = para de ressuscitar e avisa; o merge-falhou
  // legítimo (mortes com minutos de intervalo) nunca atinge a janela.
  const missionDeaths = useRef<Record<string, number[]>>({})
  const [missionHalted, setMissionHalted] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!isActive || !window.synkora.missions) return
    for (const m of missions) {
      if (m.status !== 'ativa' && m.status !== 'integrando') continue
      // MISSÃO 2.0: direta NÃO tem orquestrador. Sai antes do paneSpec — que
      // spawnaria um CLI TUI com a persona de orquestrador em cima de uma
      // missão que não tem plano nem cards para ele dirigir.
      if (m.direct) continue
      // aguardando o modal de escolha do orquestrador — o paneSpec recusaria
      if (m.pendingOrchestrator) continue
      const current = missionSpecs[m.id]
      if (current && paneActivity[current.paneId] === 'dead') {
        // Um merge pode falhar depois da pré-checagem e depois de o Windows
        // exigir o fechamento do processo que segurava o worktree. Soltar a
        // spec força um orquestrador novo a nascer para executar a decisão do
        // Maestro; branch, transcript e fila continuam preservados.
        const now = Date.now()
        const deaths = (missionDeaths.current[m.id] ??= [])
        deaths.push(now)
        while (deaths.length > 5) deaths.shift()
        if (deaths.filter((t) => now - t < 30_000).length >= 3) {
          setMissionHalted((prev) => (prev[m.id] ? prev : { ...prev, [m.id]: true }))
        }
        resetPaneTelemetry(current.paneId)
        setMissionSpecs((prev) => {
          if (prev[m.id]?.paneId !== current.paneId) return prev
          const next = { ...prev }
          delete next[m.id]
          return next
        })
        continue
      }
      // Integração em voo: o main fechou o pane DE PROPÓSITO antes do merge
      // (um cwd no worktree travaria a limpeza — caso real M02d 06/08) e o
      // paneSpec recusaria de qualquer forma. O respawn volta sozinho no
      // desfecho: falha → 'ativa' + missions:changed; sucesso → 'concluida'.
      if (m.status === 'integrando') continue
      if (missionHalted[m.id]) continue
      if (current || missionSpecInFlight.current.has(m.id)) continue
      const mid = m.id
      missionSpecInFlight.current.add(mid)
      void window.synkora.missions
        .paneSpec(projectId, mid)
        .then((spec) => {
          if (spec) setMissionSpecs((prev) => ({ ...prev, [mid]: spec }))
        })
        .finally(() => missionSpecInFlight.current.delete(mid))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isActive, missions, missionSpecs, paneActivity, missionHalted, resetPaneTelemetry])

  // Missão concluída/arquivada → o main já matou o pane do orquestrador;
  // solta a spec para o slot sumir. ATENÇÃO: missão AUSENTE da lista NÃO
  // conta — `missions` é global e vira a lista de OUTRO projeto quando o
  // usuário troca de universo (apagar aqui matava o PTY e causava o respawn
  // ao voltar).
  useEffect(() => {
    setMissionSpecs((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        const m = missions.find((x) => x.id === id)
        if (m && (m.status === 'concluida' || m.status === 'arquivada')) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [missions])

  // ————— MISSÃO DIRETA: as conversas do worktree —————
  // Nada nasce em segundo plano (cada slot é um CLI de verdade): o chat do
  // agente abre quando o dono ENTRA na missão pela primeira vez e daí em
  // diante fica montado. A guarda de voo evita o fetch duplo enquanto o 1º
  // `guiSpec` viaja — o efeito redispara antes de o estado chegar.
  useEffect(() => {
    if (!isActive || !selMission?.direct) return
    const mid = selMission.id
    if (missionGuiSlots[mid]?.length) return
    const key = `${mid}:dev`
    const epoch = missionGuiEpoch.current.capture(mid)
    if (missionGuiInFlight.current.get(key) === epoch) return
    missionGuiInFlight.current.set(key, epoch)
    void missionGui
      .spec(mid, 'dev')
      .then((res) => {
        if (!missionGuiEpoch.current.isCurrent(mid, epoch)) return
        if (!res.ok || !res.spawn) {
          // Falta de conta tem tela PRÓPRIA (o card de escolha) — tratá-la
          // como erro mandaria o dono procurar um problema que não existe.
          if (res.needsSeat) {
            setMissionNeedsSeat((prev) => ({ ...prev, [mid]: true }))
            return
          }
          setMissionGuiError((prev) => ({
            ...prev,
            [mid]: res.error ?? 'não deu para abrir a conversa desta missão'
          }))
          return
        }
        setMissionNeedsSeat((prev) => {
          if (!prev[mid]) return prev
          const next = { ...prev }
          delete next[mid]
          return next
        })
        const spawn = res.spawn
        setMissionGuiSlots((prev) =>
          prev[mid]?.length ? prev : { ...prev, [mid]: [{ role: 'dev', spawn }] }
        )
        setMissionGuiActive((prev) => ({ ...prev, [mid]: spawn.paneId }))
        setMissionGuiError((prev) => {
          if (!prev[mid]) return prev
          const next = { ...prev }
          delete next[mid]
          return next
        })
      })
      .finally(() => {
        if (missionGuiInFlight.current.get(key) === epoch) {
          missionGuiInFlight.current.delete(key)
        }
      })
  }, [isActive, selMission?.id, selMission?.direct, missionGuiSlots])

  // Missão saiu de viva: as sessões dela morrem no main (gui:kill) e os slots
  // somem. Mesma cautela do efeito dos orquestradores — missão AUSENTE da
  // lista não conta (`missions` vira a lista de OUTRO projeto ao trocar de
  // universo, e matar aqui derrubaria conversa boa).
  useEffect(() => {
    setMissionGuiSlots((prev) => {
      let changed = false
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        const m = missions.find((x) => x.id === id)
        if (!m || (m.status !== 'concluida' && m.status !== 'arquivada')) continue
        for (const slot of next[id]) dropGuiPane(slot.spawn.paneId)
        delete next[id]
        changed = true
      }
      return changed ? next : prev
    })
  }, [missions, dropGuiPane])

  // ————— TERMINAIS COMO SLOT (onda D) —————
  // Com a aba PANES fora, o único lugar SEMPRE MONTADO do universo é esta
  // coluna — e é aqui que todo terminal passa a viver. Não é só estética: o
  // PTY nasce no `pty:create` do TerminalPane, então pane sem lugar para
  // montar é pane que nunca roda. Por isso a lista cobre TODO pane que não é
  // chat (surface 'gui' já tem casa nos slots de conversa): o shell da missão
  // (▷ terminal · ▶ teste), o teste de VERSÃO (sem missão, vai para a coluna
  // do ✦ geral) e os panes do pipeline legado.
  // Todos ficam MONTADOS: desmontar mata o PTY, e com ele o servidor.
  const termPanes = panes.filter((p) => p.surface !== 'gui')
  const missionTermPanes = termPanes.filter((p) => p.missionId)
  const generalTermPanes = termPanes.filter((p) => !p.missionId)
  const missionTermId =
    selMission && missionTermPanes.some((p) => p.id === missionTerm[selMission.id])
      ? (missionTerm[selMission.id] as string)
      : null
  // ✦ GERAL SEM PM LEGADO NÃO TEM CONVERSA (2.0): o convite de planejamento
  // saiu daqui, então um terminal avulso vivo é o ÚNICO habitante possível do
  // palco — o foco cai nele mesmo que o escolhido tenha morrido, senão o pane
  // seguia rodando atrás de uma tela vazia, sem porta. Com o PM legado vivo o
  // "← conversa" continua valendo e `null` é uma escolha do dono.
  const generalTermFocused = generalTermPanes.some((p) => p.id === generalTerm)
    ? generalTerm
    : null
  const generalTermId =
    generalTermFocused ?? (maestroSpec ? null : (generalTermPanes[0]?.id ?? null))

  // Terminal recém-nascido ganha o foco: o dono acabou de clicar em "▷
  // terminal"/"▶ testar" — mostrar a conversa no lugar seria engolir o que ele
  // pediu. Só a PRIMEIRA aparição de cada pane conta (o ref é a memória).
  const seenTermPanes = useRef<Set<string>>(new Set())
  // `termPanes` é array novo a cada render — a chave é a LISTA de ids, então
  // o efeito só acorda quando um terminal nasce ou morre de verdade.
  const termPaneKey = termPanes.map((p) => `${p.id}:${p.missionId ?? ''}`).join('|')
  useEffect(() => {
    if (!isActive) return
    const live = new Set<string>()
    for (const entry of termPaneKey ? termPaneKey.split('|') : []) {
      const [id, mid] = entry.split(':')
      live.add(id)
      if (seenTermPanes.current.has(id)) continue
      seenTermPanes.current.add(id)
      if (mid) setMissionTerm((prev) => ({ ...prev, [mid]: id }))
      else setGeneralTerm(id)
    }
    // pane morto sai da memória — reabrir com o MESMO id volta a focar
    for (const id of seenTermPanes.current) if (!live.has(id)) seenTermPanes.current.delete(id)
  }, [isActive, termPaneKey])

  /** Abre (ou volta o foco para) uma conversa da missão direta. */
  async function openMissionGuiRole(missionId: string, role: MissionGuiRole): Promise<void> {
    const slots = missionGuiSlots[missionId] ?? []
    // Agente e revisor são ÚNICOS por missão: clicar de novo volta o foco para
    // a rodada em andamento. A sessão do revisor é limpa por NASCER limpa —
    // recriar aqui jogaria fora a revisão que ele já estava escrevendo.
    if (role !== 'helper') {
      const existing = slots.find((s) => s.role === role)
      if (existing) {
        // Abrir uma conversa FOCA a pílula dela: se um terminal estava no ar,
        // ele sai da frente (senão o clique no trilho parecia não fazer nada).
        setMissionTerm((prev) => ({ ...prev, [missionId]: null }))
        setMissionGuiActive((prev) => ({ ...prev, [missionId]: existing.spawn.paneId }))
        return
      }
    }
    const key = `${missionId}:${role}`
    const epoch = missionGuiEpoch.current.capture(missionId)
    if (missionGuiInFlight.current.get(key) === epoch) return
    missionGuiInFlight.current.set(key, epoch)
    const res = await missionGui.spec(missionId, role)
    if (missionGuiInFlight.current.get(key) === epoch) {
      missionGuiInFlight.current.delete(key)
    }
    if (!missionGuiEpoch.current.isCurrent(missionId, epoch)) return
    if (!res.ok || !res.spawn) {
      // Sem conta escolhida NENHUM papel abre — e a resposta é o card de
      // escolha, não um erro (o revisor abre sozinho depois da escolha).
      if (res.needsSeat) {
        setMissionNeedsSeat((prev) => ({ ...prev, [missionId]: true }))
        return
      }
      setMissionGuiError((prev) => ({
        ...prev,
        [missionId]: res.error ?? `não deu para abrir ${MISSION_GUI_ROLE_LABEL[role]}`
      }))
      return
    }
    const spawn = res.spawn
    setMissionGuiSlots((prev) => {
      const cur = prev[missionId] ?? []
      if (cur.some((s) => s.spawn.paneId === spawn.paneId)) return prev
      return { ...prev, [missionId]: [...cur, { role, spawn }] }
    })
    setMissionTerm((prev) => ({ ...prev, [missionId]: null }))
    setMissionGuiActive((prev) => ({ ...prev, [missionId]: spawn.paneId }))
  }

  /** Terminal CRU no worktree da missão (trilho de entrega → "▷ terminal").
   *  F3-c3: TODO nascimento de pane viaja por evento do main — o handler do
   *  `missions:shellSpec` já transmitiu `panes:open-free` e o store montou a
   *  lista. Aqui NÃO se chama addPane (seria uma segunda entrada do mesmo
   *  pane): ONDA D — o terminal nasce como SLOT desta coluna e o efeito de
   *  foco automático já o coloca no ar. */
  async function openMissionShell(missionId: string): Promise<void> {
    const res = await missionShell.spec(missionId)
    if (!res.ok || !res.spec) {
      setMissionMsg(res.error ?? 'não deu para abrir o terminal desta missão')
    }
  }

  /** Guarda o modo de permissão que o dono escolheu NO CHAT (onda D). O motor
   *  também persiste do lado dele; aqui é para o slot remontado nascer com a
   *  regra certa em vez de voltar ao padrão. */
  function setMissionSlotPermission(
    missionId: string,
    paneId: string,
    permissionMode: GuiPermissionMode
  ): void {
    setMissionGuiSlots((prev) => {
      const cur = prev[missionId]
      if (!cur) return prev
      return {
        ...prev,
        [missionId]: cur.map((s) =>
          s.spawn.paneId === paneId ? { ...s, spawn: { ...s.spawn, permissionMode } } : s
        )
      }
    })
  }

  /** Modelo/effort trocados NO CHAT: o slot guarda a escolha para a
   *  remontagem não voltar ao executor antigo (par do setMissionSlotPermission
   *  — o motor também grava do lado dele, por pane). */
  function setMissionSlotExecutor(
    missionId: string,
    paneId: string,
    patch: { model?: string; effort?: string }
  ): void {
    setMissionGuiSlots((prev) => {
      const cur = prev[missionId]
      if (!cur) return prev
      return {
        ...prev,
        [missionId]: cur.map((s) =>
          s.spawn.paneId === paneId ? { ...s, spawn: { ...s.spawn, ...patch } } : s
        )
      }
    })
  }

  /**
   * A CONTA DA CONVERSA (2.0): vale para o card da missão sem conta e para o
   * menu do cabeçalho do chat. O main transplanta a conversa quando o CLI é o
   * mesmo e MATA as sessões vivas (elas falavam pela conta antiga) — aqui os
   * slots são descartados e o chat reabre já no seat novo.
   */
  async function chooseChatSeat(missionId: string, seatId: string): Promise<void> {
    if (seatChangeInFlight.current) return
    seatChangeInFlight.current = true
    // Specs pedidas antes deste ponto pertencem à conta anterior.
    missionGuiEpoch.current.invalidate(missionId)
    setMissionGuiError((prev) => {
      if (!prev[missionId]) return prev
      const next = { ...prev }
      delete next[missionId]
      return next
    })
    setSeatBusy(seatId)
    try {
      const res = await missionGui.setChatSeat(projectId, missionId, seatId)
      if (!res.ok) {
        setMissionGuiError((prev) => ({
          ...prev,
          [missionId]: res.msg ?? 'não deu para escolher a conta desta conversa'
        }))
        return
      }
      for (const slot of missionGuiSlots[missionId] ?? []) dropGuiPane(slot.spawn.paneId)
      setMissionGuiSlots((prev) => withoutMissionGuiSlots(prev, missionId))
      setMissionNeedsSeat((prev) => {
        const next = { ...prev }
        delete next[missionId]
        return next
      })
      setMissionGuiError((prev) => {
        if (!prev[missionId]) return prev
        const next = { ...prev }
        delete next[missionId]
        return next
      })
      await loadMissions(projectId)
      // NÃO chamar openMissionGuiRole daqui: esta closure ainda enxerga os
      // slots antigos e focaria o pane que o main acabou de matar. A remoção
      // acima dispara o efeito canônico de slots vazios, que pede uma spec nova
      // já resolvida para o seat novo.
    } catch {
      setMissionGuiError((prev) => ({
        ...prev,
        [missionId]: 'não deu para trocar a conta desta conversa'
      }))
    } finally {
      setSeatBusy(null)
      seatChangeInFlight.current = false
    }
  }

  /** Fecha UMA conversa (revisor/ajudante). O chat do agente não fecha por
   *  aqui: ele é a missão. */
  function closeMissionGuiSlot(missionId: string, paneId: string): void {
    dropGuiPane(paneId)
    const rest = (missionGuiSlots[missionId] ?? []).filter((s) => s.spawn.paneId !== paneId)
    setMissionGuiSlots((prev) => ({ ...prev, [missionId]: rest }))
    setMissionGuiActive((prev) =>
      prev[missionId] === paneId
        ? { ...prev, [missionId]: rest[0]?.spawn.paneId ?? '' }
        : prev
    )
  }

  // Missão saiu de VIVA (integrada/arquivada) com a aba dela aberta → volta para
  // ✦ geral. Sem isso a aba 🚀 desaparecia da fila e nenhuma aba ficava ativa:
  // board sem conteúdo e sem terminal. Guardas: só no projeto ATIVO e só quando
  // a missão EXISTE na lista e mudou de status — `missions` é global e vira a
  // lista de OUTRO projeto ao trocar de universo (resetar nesse instante apagaria
  // a seleção do usuário, mesmo risco do efeito acima).
  useEffect(() => {
    if (!isActive || !missionTab) return
    const m = missions.find((x) => x.id === missionTab)
    if (m && m.status !== 'ativa' && m.status !== 'integrando') setMissionTab(projectId, null)
  }, [isActive, missionTab, missions, projectId, setMissionTab])

  // avisos ficam até o usuário fechar no × (decisão do usuário)
  async function onIntegrate(): Promise<void> {
    if (!selMission) return
    setMissionMsg(await integrateMission(selMission.id))
    // o ⇪ mexe na branch: o diffstat do trilho re-mede sozinho (onda D)
    setRailReload((n) => n + 1)
  }

  // Tarefa travada = há um pane executando ela agora.
  const maestroSeat = seats.find((x) => x.id === maestroSeatId)
  const selSpec = selMission ? missionSpecs[selMission.id] : undefined
  const selSeat = selSpec ? seats.find((x) => x.id === selSpec.seatId) : undefined
  // Missão DIRETA: quem ocupa o centro é uma conversa GUI, não um TUI. O slot
  // ativo manda no chrome (modelo/estado vêm do estado do chat, não do PTY).
  const isDirect = Boolean(selMission?.direct)
  // NATUREZA da missão selecionada (2.0): planejamento roda na RAIZ, não tem
  // branch/worktree e não abre revisor nem ajudante — o palco é o MESMO de uma
  // missão de dev (o `missions:guiSpec` já roteia), só o vocabulário muda.
  const isPlanningMission = missionTypeOf(selMission) === 'planejamento'
  const directSlots = selMission ? (missionGuiSlots[selMission.id] ?? []) : []
  const directActiveId = selMission ? missionGuiActive[selMission.id] : undefined
  const directSlot =
    directSlots.find((s) => s.spawn.paneId === directActiveId) ?? directSlots[0] ?? undefined
  const directGui = directSlot ? guiPanes[directSlot.spawn.paneId] : undefined
  const directSeat = directSlot
    ? seats.find((x) => x.configDir && x.configDir === directSlot.spawn.configDir)
    : undefined
  // TERMINAL EM FOCO (onda D): quando existe, é ele que o chrome descreve —
  // papel, marca, título e telemetria saem do PTY, não da conversa que ficou
  // montada atrás dele.
  const activeTermPane = missionTab
    ? missionTermPanes.find((p) => p.id === missionTermId)
    : generalTermPanes.find((p) => p.id === generalTermId)
  // ✦ GERAL COMEÇA VAZIO (ordem do dono, 2026-08-13). O convite de
  // planejamento que nascia sozinho aqui MORREU: planejar é uma MISSÃO que ele
  // cria, e enquanto ele não criar nada o centro do universo é só o retrato do
  // projeto. Com PM legado vivo nada muda — o slot dele continua como era.
  const maestroSlotActive = !missionTab && !generalTermId
  // O PALCO só existe quando há o que mostrar nele: a conversa/orquestrador de
  // uma missão selecionada, um terminal avulso do universo ou o PM legado. Sem
  // nada disso a janela inteira sai da tela (por CSS — desmontar remontaria os
  // slots montados atrás e mataria PTYs) e o retrato ocupa a linha sozinho.
  const stageEmpty = !missionTab && !maestroSpec && !generalTermId

  // ——————————————————————————————————————————————————————————————————————
  // O PALCO (mockup aprovado, docs/MOCKUP_WORKSPACE.md).
  //
  // "A CHAT É O PALCO": em missão DIRETA (de dev OU de planejamento) a conversa
  // ocupa TODO o centro — coluna de missões à esquerda, trilho de entrega à
  // direita, e nada de cartão de estatística no meio. Missão LEGADA (pipeline
  // F6, com orquestrador TUI) mantém o desenho antigo: lá o que roda é um
  // terminal de verdade, e o titlebar escuro do PaneChrome é a roupa certa.
  //
  // A troca é SÓ de classe/render do cabeçalho — nenhum filho do
  // `.maestro-body` muda de posição, então nenhum TerminalPane remonta.
  // ——————————————————————————————————————————————————————————————————————
  const stageMode = isDirect
  const stageTermPane = activeTermPane
  // Missão de planejamento tem UMA conversa só: chamá-la de "agente" esconderia
  // justamente a natureza que o dono escolheu ao criá-la.
  const stageRoleLabel = isPlanningMission
    ? 'planejamento'
    : MISSION_GUI_ROLE_LABEL[directSlot?.role ?? 'dev']
  const stageSeat = directSeat
  const stageModel = directGui?.executorKnown
    ? directGui.executorModel ?? directGui.model ?? directSlot?.spawn.model
    : directSlot?.spawn.model ?? directGui?.model ?? undefined
  const stageModelLabel = stageModel
    ? guiModelLabel(directGui?.caps?.models ?? [], stageModel, prettyModel(stageModel))
    : null
  const stageEffort = directGui?.executorKnown
    ? directGui.effort ?? undefined
    : directSlot?.spawn.effort ?? selMission?.effort

  /** As pílulas do seletor de conversas — a linha fina no topo do palco. A
   *  PÍLULA DE PLANEJAMENTO só nasce aqui, e só quando a missão selecionada é
   *  desse tipo: ✦ geral não tem conversa nenhuma para oferecer. */
  const stagePills: StagePill[] = []
  if (stageMode && selMission) {
    directSlots.forEach((slot, i) => {
      const helperN = directSlots.filter((s, j) => s.role === 'helper' && j <= i).length
      const label =
        slot.role === 'helper'
          ? `ajudante ${helperN}`
          : slot.role === 'dev' && isPlanningMission
            ? 'planejamento'
            : MISSION_GUI_ROLE_LABEL[slot.role]
      stagePills.push({
        id: slot.spawn.paneId,
        label,
        kind: 'chat',
        active: !missionTermId && directSlot?.spawn.paneId === slot.spawn.paneId,
        attention: Boolean(
          guiPanes[slot.spawn.paneId]?.perm ||
            guiPanes[slot.spawn.paneId]?.question ||
            guiPanes[slot.spawn.paneId]?.planReview
        ),
        tip: `Ver a conversa "${label}" desta missão`,
        onSelect: () => {
          setMissionTerm((prev) => ({ ...prev, [selMission.id]: null }))
          setMissionGuiActive((prev) => ({ ...prev, [selMission.id]: slot.spawn.paneId }))
        },
        // O chat do AGENTE é a missão: ele não se fecha por aqui.
        onClose:
          slot.role === 'dev'
            ? undefined
            : () => closeMissionGuiSlot(selMission.id, slot.spawn.paneId),
        closeTip: `Encerrar a conversa "${label}" (o worktree e os commits ficam)`
      })
    })
    for (const pane of missionTermPanes.filter((p) => p.missionId === selMission.id)) {
      const label =
        pane.kind === 'shell'
          ? pane.testServer
            ? 'teste'
            : 'terminal'
          : pane.title || 'terminal'
      stagePills.push({
        id: pane.id,
        label,
        kind: 'terminal',
        active: missionTermId === pane.id,
        tip: `Ver o terminal "${pane.title}" desta missão`,
        onSelect: () => setMissionTerm((prev) => ({ ...prev, [selMission.id]: pane.id })),
        onClose: () => window.synkora.panes.requestClose(projectId, pane.id),
        closeTip: 'Fechar o terminal (derruba o que estiver rodando nele)'
      })
    }
  } else if (!selMission) {
    // ✦ GERAL: terminal de VERSÃO (o ▶ testar da aba Versões) e qualquer pane
    // sem missão. Estas abas moravam na barra escura do PaneChrome, que é
    // chrome da era LEGADA e vai sair — a onda D não pode cair de carona com
    // ela, então elas viram pílulas do mesmo seletor de sempre.
    for (const pane of generalTermPanes) {
      stagePills.push({
        id: pane.id,
        label: pane.title || 'terminal',
        kind: 'terminal',
        active: generalTermId === pane.id,
        tip: `Ver o terminal "${pane.title}"`,
        onSelect: () => setGeneralTerm(pane.id),
        onClose: () => window.synkora.panes.requestClose(projectId, pane.id),
        closeTip: 'Fechar o terminal (derruba o que estiver rodando nele)'
      })
    }
  }

  /** A cabeça do palco existe quando há CONVERSA (missão direta) ou quando há
   *  pílula para oferecer — é o caso do ✦ geral com um terminal avulso vivo. */
  const stageHead = stageMode || stagePills.length > 0

  // A LINHA FINA do mockup: `dev · opus 4.8 · mission/1f3a`, texto apagado,
  // UMA linha. Os separadores são CSS (`.stage-meta-line > * + *::before`) —
  // aqui só entram os fatos que existem de verdade.
  const stageMetaParts: React.ReactNode[] = []
  if (stageHead) {
    if (stageTermPane) {
      stageMetaParts.push(
        <span key="role" className="sm-role term">
          terminal
        </span>
      )
      stageMetaParts.push(<span key="title">{stageTermPane.title}</span>)
    } else if (stageMode) {
      stageMetaParts.push(
        <span key="role" className="sm-role">
          {stageRoleLabel}
        </span>
      )
      if (stageSeat?.name) stageMetaParts.push(<span key="seat">{stageSeat.name}</span>)
      if (stageModelLabel) stageMetaParts.push(<span key="model">{stageModelLabel}</span>)
      if (stageEffort) stageMetaParts.push(<span key="effort">{stageEffort}</span>)
    }
    // O chip do código da missão virou ESTE ⎇: mesma função de sempre (clicar
    // copia o id completo), agora dentro da linha fina em vez de um chip solto
    // no titlebar escuro que morreu. Planejamento não tem branch: mostrar um
    // ⎇ ali seria anunciar um worktree que não existe.
    if (isDirect && selMission && !isPlanningMission)
      stageMetaParts.push(
        <button
          key="branch"
          className={`stage-branch${missionCopied ? ' copied' : ''}`}
          data-tip={`Worktree desta missão. Clique para copiar o código: ${selMission.id}${
            selMission.baseBranch ? ` · base ${selMission.baseBranch}` : ''
          }`}
          onClick={() => {
            void navigator.clipboard.writeText(selMission.id)
            setMissionCopied(true)
            window.setTimeout(() => setMissionCopied(false), 1500)
          }}
        >
          {missionCopied ? '✓ código copiado' : `⎇ ${selMission.branch ?? selMission.id.slice(0, 8)}`}
        </button>
      )
  }

  const measuredMaestroBox = maestroTerminalBox.w > 0 ? maestroTerminalBox : undefined
  const maestroTerminalFont = settings?.terminalFontSize ?? TERMINAL_DEFAULT_FONT_SIZE
  const maestroTerminalLineHeight =
    settings?.terminalLineHeight ?? TERMINAL_DEFAULT_LINE_HEIGHT
  const maestroTerminalFontFamily =
    settings?.terminalFontFamily ?? TERMINAL_DEFAULT_FONT_FAMILY
  const maestroTerminalFallbackFor = (kind: Pane['kind']): { cols: number; rows: number } =>
    terminalFallbackForHost(
      measuredMaestroBox,
      maestroTerminalFont,
      maestroTerminalLineHeight,
      kind === 'claude' ? TERMINAL_NATIVE_SCROLLBAR_WIDTH : TERMINAL_SCROLLBAR_WIDTH
    )
  const maestroSizeGroup = measuredMaestroBox
    ? `board:${projectId}:${Math.round(measuredMaestroBox.w)}x${Math.round(measuredMaestroBox.h)}:${maestroTerminalFont}:${maestroTerminalLineHeight}:${maestroTerminalFontFamily}`
    : `board:${projectId}:fallback`


  // O KANBAN e o quick-add saíram na purga F6 (2026-08-17), e com eles a
  // fatia de cards da missão, o filtro por função e a régua `missionAllDone`.
  // A missão 2.0 não tem card: o board dela é a conversa no centro e o trilho
  // de entrega ao lado — quem decide se o ⇪ libera é o MissionDeliveryRail.

  // Linhas da coluna da esquerda: o Board resolve tudo (conta, modelo, versão,
  // progresso, pulso) e a coluna só desenha.
  const missionColumnEntries: MissionColumnEntry[] = liveMissions.map((m) => {
    const spec = missionSpecs[m.id]
    const slots = missionGuiSlots[m.id] ?? []
    // Missão direta: a conta/modelo que aparecem no card são os da CONVERSA
    // aberta (o que o dono está de fato gastando ali), não os de um
    // orquestrador que não existe.
    const guiSpawn = slots[0]?.spawn
    const seat = guiSpawn
      ? seats.find((x) => x.configDir && x.configDir === guiSpawn.configDir)
      : seats.find((x) => x.id === (spec?.seatId ?? m.seatId ?? maestroSeatId))
    // O chat não escreve em `paneLastLines`, então a heurística do "?" não o
    // alcança: o que PARA a conversa esperando o dono (permissão, pergunta com
    // opções, plano a aprovar) é o sinal real e precisa pulsar o card.
    const waitingPane = slots.find((s) => {
      const pane = guiPanes[s.spawn.paneId]
      return pane?.perm || pane?.question || pane?.planReview
    })
    const waitingKind = waitingPane
      ? guiPanes[waitingPane.spawn.paneId]?.question
        ? 'o agente fez uma pergunta nesta conversa'
        : guiPanes[waitingPane.spawn.paneId]?.planReview
          ? 'o agente propôs um plano e espera seu aval'
          : 'o agente está esperando sua permissão nesta conversa'
      : undefined
    const cards = tasks.filter((t) => t.missionId === m.id && t.kind !== 'plan')
    return {
      mission: m,
      done: cards.filter((t) => t.status === 'done').length,
      total: cards.length,
      seatName: seat?.name,
      model: (() => {
        const guiState = guiPanes[slots[0]?.spawn.paneId ?? '']
        return guiState?.executorKnown
          ? guiState.executorModel ?? guiState.model ?? guiSpawn?.model
          : guiSpawn?.model ?? guiState?.model ?? spec?.model ?? m.model
      })(),
      versionLabel: versionName(m.versionId),
      pulse: tabPulse[m.id] ?? waitingKind,
      queueLabel: integrationQueueLabel(m)
    }
  })


  return (
    <div className="board">
      {missionMsg && (
        <div className="mission-msg">
          {missionMsg}
          <button className="mission-msg-close" data-tip="Fechar aviso" onClick={() => setMissionMsg(null)}>
            ×
          </button>
        </div>
      )}

      {/* Linha principal em row-reverse: o 1º filho renderiza à DIREITA e o
          último à ESQUERDA. Em missão legada segue o desenho de sempre
          (missões · conteúdo · maestro). Em MODO PALCO (missão direta ou casa
          do planejamento) o `stage-mode` troca a ORDEM VISUAL por CSS
          (missões · CONVERSA · entrega) sem mexer no DOM: reordenar filhos
          remontaria os TerminalPane e mataria os PTYs.
          TODOS os panes ficam montados (display:none fora da aba). */}
      <div className={`board-main${stageMode ? ' stage-mode' : ''}`}>
      {/* Só a cabeça da fila fica bloqueada durante os poucos instantes em que
          o Git altera a branch de destino. Não existe reviewer extra aqui. */}
      {selMission?.status === 'integrando' && (
        <div className="integrating-overlay">
          <div className="integrating-card">
            <span className="spinner" />
            <b>⇪ integrando "{selMission.title}"…</b>
            <span>
              chegou a vez desta missão na fila; o Synkora está juntando a branch dela ao
              destino. A próxima posição só começa depois que esta terminar.
            </span>
          </div>
        </div>
      )}
      {/* O PALCO: em modo 2.0 a caixa é PAPEL (o chat não é terminal); em
          missão legada ela segue sendo a janela escura de sempre, porque lá
          dentro roda um TUI de verdade. Só a CLASSE muda — trocar a caixa
          remontaria os slots e mataria as sessões. */}
      <div
        className={`maestro-window${stageHead ? ' stage-window' : ' term-window'}${
          stageEmpty ? ' stage-empty' : ''
        }`}
        ref={winRef}
      >
        {stageHead ? (
          /* Sem `actions`: as alavancas do universo (estudar/conta/limpar)
             moravam na cabeça do palco de PLANEJAMENTO, que morreu — e em
             2026-08-15 saíram do app inteiro junto com o papel de Maestro. */
          <MissionStageHead pills={stagePills} meta={stageMetaParts} />
        ) : (
        <PaneChrome
          // CHROME DE TERMINAL — só o mundo LEGADO passa por aqui (missão com
          // orquestrador TUI, ou o PM enquanto existir missão legada viva). O
          // palco 2.0 (missão direta, de dev ou de planejamento) tem a cabeça
          // em papel do MissionStageHead: nenhum ramo `isDirect` alcança este
          // ponto, e por isso ele não existe mais nestas escolhas.
          role={
            activeTermPane ? 'livre' : selMission ? 'orquestrador' : 'maestro'
          }
          kind={
            activeTermPane
              ? 'shell'
              : selMission
                ? (selSpec?.kind ?? maestroSeat?.cli ?? 'claude')
                : (maestroSeat?.cli ?? 'claude')
          }
          seatName={
            activeTermPane ? undefined : selMission ? selSeat?.name : maestroSeat?.name
          }
          // valor VIVO do TUI (pty:model/pty:effort, muda na hora da troca via
          // /model) > configurado.
          model={
            activeTermPane
              ? undefined
              : selMission
                ? ((selSpec ? paneModel[selSpec.paneId] : undefined) ??
                  selSpec?.model ??
                  selMission.model)
                : ((maestroSpec ? paneModel[maestroSpec.paneId] : undefined) ??
                  maestroModel ??
                  undefined)
          }
          effort={
            activeTermPane
              ? undefined
              : selMission
                ? ((selSpec ? paneEffort[selSpec.paneId] : undefined) ?? selMission.effort)
                : ((maestroSpec ? paneEffort[maestroSpec.paneId] : undefined) ??
                  maestroEffort ??
                  undefined)
          }
          // sem repetição: o chip de papel já diz MAESTRO/ORQUESTRADOR — o
          // título é SÓ o nome da missão (PM fica sem título)
          title={activeTermPane ? activeTermPane.title : selMission ? selMission.title : ''}
          stats={
            activeTermPane
              ? (paneStats[activeTermPane.id] ?? ZERO_STATS)
              : selMission
                ? selSpec
                  ? (paneStats[selSpec.paneId] ?? ZERO_STATS)
                  : undefined
                : maestroSpec
                  ? (paneStats[maestroSpec.paneId] ?? ZERO_STATS)
                  : undefined
          }
          pinStats={Boolean(selMission)}
          activity={
            activeTermPane
              ? paneActivity[activeTermPane.id]
              : selMission
                ? selSpec
                  ? paneActivity[selSpec.paneId]
                  : undefined
                : maestroSpec
                  ? paneActivity[maestroSpec.paneId]
                  : undefined
          }
          priorityDetails={
            selMission ? (
              <>
                {selMission.versionId && (
                  <span
                    className="stat-chip version-chip mission-version-chip"
                    data-tip="Versão do app desta missão — ela integra na branch da versão, não na main"
                  >
                    {versionName(selMission.versionId) ?? 'versão'}
                  </span>
                )}
                <button
                  className={`stat-chip model code-chip mission-ref-chip${
                    missionCopied ? ' copied' : ''
                  }`}
                  data-tip={`Código da missão — clique para copiar e enviar ao Maestro: ${selMission.id}${
                    selMission.branch
                      ? ` · branch ${selMission.branch} (base: ${selMission.baseBranch ?? '?'})`
                      : ''
                  }`}
                  aria-label={`Copiar código da missão ${selMission.id}`}
                  onClick={() => {
                    void navigator.clipboard.writeText(selMission.id)
                    setMissionCopied(true)
                    window.setTimeout(() => setMissionCopied(false), 1500)
                  }}
                >
                  {missionCopied ? '✓ copiado' : `#${selMission.id.slice(0, 8)}`}
                </button>
                {selMission.status === 'integrando' && (
                  <span className="pane-task-badge run-running">⇪ integrando…</span>
                )}
                {selMission.integration && selMission.status !== 'integrando' && (
                  <span
                    className={`pane-task-badge integration-${selMission.integration.state}`}
                    data-tip={selMission.integration.lastError}
                  >
                    {selMission.integration.state === 'blocked'
                      ? selMission.integration.owner === 'orchestrator'
                        ? '⚠ reparo do destino pendente'
                        : '⚠ Maestro decidindo'
                      : selMission.integration.state === 'sync_required'
                        ? '↻ sincronizando'
                        : `⇪ fila #${selMission.integration.position}/${selMission.integration.total}`}
                  </span>
                )}
                {selMission.status === 'concluida' && (
                  <span className="pane-task-badge run-done">✓ integrada</span>
                )}
              </>
            ) : undefined
          }
        >
          {/* O SELETOR DE CONVERSAS saiu daqui: em modo 2.0 ele é a linha de
              pílulas em PAPEL no topo do palco (MissionStageHead). Este chrome
              escuro só sobrevive na missão LEGADA, que não tem conversa GUI
              nenhuma para selecionar. */}
          {/* ONDA D — CHAT ↔ TERMINAL: os terminais da missão (▷ terminal,
              ▶ teste e, em missão legada, os panes do pipeline) entram como
              aba nesta mesma barra. Fechar é no × — e fechar DERRUBA o
              processo (é o mesmo requestClose do trilho), por isso o tooltip
              diz isso com todas as letras. */}
          {selMission &&
            missionTermPanes
              .filter((p) => p.missionId === selMission.id)
              .map((pane) => (
                <span key={pane.id} className="mission-gui-tab-wrap">
                  <button
                    className={`term-btn ghost-dim mission-gui-tab${
                      missionTermId === pane.id ? ' active' : ''
                    }`}
                    data-tip={`Ver o terminal "${pane.title}" desta missão`}
                    onClick={() =>
                      setMissionTerm((prev) => ({ ...prev, [selMission.id]: pane.id }))
                    }
                  >
                    ▷{' '}
                    {pane.kind === 'shell'
                      ? pane.testServer
                        ? 'teste'
                        : 'terminal'
                      : pane.title || 'terminal'}
                  </button>
                  <button
                    className="term-btn ghost-dim mission-gui-tab-close"
                    data-tip="Fechar o terminal (derruba o que estiver rodando nele)"
                    aria-label={`Fechar ${pane.title}`}
                    onClick={() => window.synkora.panes.requestClose(projectId, pane.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
          {/* Os terminais SEM MISSÃO (▶ testar de versão, panes avulsos) saíram
              desta barra: são onda D e agora entram como PÍLULA do
              MissionStageHead, junto com os terminais de missão. O que sobra
              aqui é chrome da era legada. */}
          {/* ALAVANCAS DO PM MORTAS (ordem do dono, 2026-08-15): 📚 estudar,
              ⇄ seat e 🧹 limpar eram os controles do Maestro — o papel que a
              era 2.0 não tem. Saíram daqui e da linha do retrato; o que resta
              nesta barra são as abas dos terminais, que continuam de pé. As
              IPCs que elas chamavam também já foram (auditoria de código morto,
              2026-08-15): do domínio maestro sobraram `getState`, `paneSpec` e
              o par de perguntas do ask_user, que este arquivo usa. */}
        </PaneChrome>
        )}
        <div className="maestro-body maestro-terminal" ref={maestroTerminalRef}>
          {/* PM (Geral) — sempre montado */}
          {/* visibilidade pelo missionTab (per-projeto, nunca stale) e NÃO pelo
              selMission, que depende da lista global assíncrona de missões: ao
              trocar de universo o terminal do PM piscava no lugar do
              orquestrador por um instante */}
          <div
            className={`maestro-slot${maestroSlotActive ? ' is-active' : ''}`}
            aria-hidden={maestroSlotActive ? undefined : true}
            inert={maestroSlotActive ? undefined : true}
          >
            {maestroSpec ? (
              <GuiPanelErrorBoundary paneId={maestroSpec.paneId} label="o painel do Maestro">
              <TerminalPane
                key={`${maestroSpec.seatId}:${maestroSpec.kind}`}
                paneId={maestroSpec.paneId}
                cwd={maestroSpec.cwd}
                kind={maestroSpec.kind}
                projectId={projectId}
                seatId={maestroSpec.seatId}
                model={maestroSpec.model}
                cliArgs={maestroSpec.cliArgs}
                initialPrompt={maestroSpec.initialPrompt}
                appendSystemPrompt={maestroSpec.appendSystemPrompt}
                imagePasteProjectId={projectId}
                fontSize={maestroTerminalFont}
                lineHeight={maestroTerminalLineHeight}
                fontFamily={maestroTerminalFontFamily}
                minCols={terminalMinColsForBox(
                  maestroSpec.kind,
                  maestroTerminalFallbackFor(maestroSpec.kind)
                )}
                minRows={maestroSpec.kind === 'claude' ? 12 : 6}
                fallbackSize={maestroTerminalFallbackFor(maestroSpec.kind)}
                sizeGroup={`${maestroSizeGroup}:${maestroSpec.kind}`}
                voiceLabel="Maestro"
              />
              </GuiPanelErrorBoundary>
            ) : (
              /* Sem spec não há PM: o Maestro só nasce para o ecossistema
                 LEGADO (missão com orquestrador TUI). O texto não manda mais
                 "escolher o seat" — esse botão morreu com o gate. */
              <div className="maestro-empty">
                // sem Maestro aqui — o trabalho 2.0 mora dentro da missão
              </div>
            )}
          </div>
          {/* Orquestradores das missões já abertas — montados, escondidos */}
          {Object.values(missionSpecs).map((spec) => (
            <div
              key={spec.paneId}
              className={`maestro-slot${spec.missionId === missionTab ? ' is-active' : ''}`}
              aria-hidden={spec.missionId === missionTab ? undefined : true}
              inert={spec.missionId === missionTab ? undefined : true}
            >
              <GuiPanelErrorBoundary
                paneId={spec.paneId}
                label={`o painel de ${
                  missions.find((mission) => mission.id === spec.missionId)?.title ?? 'missão'
                }`}
              >
              <TerminalPane
                key={`${spec.seatId}:${spec.kind}`}
                paneId={spec.paneId}
                cwd={spec.cwd}
                kind={spec.kind}
                projectId={projectId}
                seatId={spec.seatId}
                model={spec.model}
                cliArgs={spec.cliArgs}
                initialPrompt={spec.initialPrompt}
                appendSystemPrompt={spec.appendSystemPrompt}
                imagePasteProjectId={projectId}
                fontSize={maestroTerminalFont}
                lineHeight={maestroTerminalLineHeight}
                fontFamily={maestroTerminalFontFamily}
                minCols={terminalMinColsForBox(spec.kind, maestroTerminalFallbackFor(spec.kind))}
                minRows={spec.kind === 'claude' ? 12 : 6}
                fallbackSize={maestroTerminalFallbackFor(spec.kind)}
                sizeGroup={`${maestroSizeGroup}:${spec.kind}`}
                voiceLabel={`Orquestrador · ${
                  missions.find((mission) => mission.id === spec.missionId)?.title ?? 'missão'
                }`}
              />
              </GuiPanelErrorBoundary>
            </div>
          ))}
          {/* MISSÃO DIRETA (2.0): as conversas GUI do worktree. Lista KEYADA e
              separada da dos orquestradores — cada slot é uma sessão viva no
              main, então nada aqui pode remontar ao trocar de aba/papel. */}
          {Object.entries(missionGuiSlots).flatMap(([mid, slots]) =>
            slots.map((slot) => {
              const active =
                appPage === 'workspace' &&
                isActive &&
                uniTab === 'board' &&
                mid === missionTab &&
                !missionTermId &&
                directSlot?.spawn.paneId === slot.spawn.paneId
              return (
                <div
                  key={slot.spawn.paneId}
                  className={`maestro-slot${active ? ' is-active' : ''}`}
                  aria-hidden={active ? undefined : true}
                  inert={active ? undefined : true}
                >
                  <GuiPanelErrorBoundary paneId={slot.spawn.paneId} label="esta conversa">
                  {/* A LISTA É ENUMERADA À MÃO: todo campo do spawn tem de
                      aparecer aqui, senão ele morre nesta fronteira sem erro
                      de tipo — foi assim que o chat de planejamento passou uma
                      noite sem as ferramentas de plano. A cerca de paridade
                      está em scripts/test-gui-chat-ui.mjs. */}
                  <GuiPane
                    paneId={slot.spawn.paneId}
                    active={active}
                    projectId={projectId}
                    cli={slot.spawn.cli}
                    configDir={slot.spawn.configDir}
                    cwd={slot.spawn.cwd}
                    model={slot.spawn.model}
                    effort={slot.spawn.effort}
                    systemPrompt={slot.spawn.systemPrompt}
                    resumeSessionId={slot.spawn.resumeSessionId}
                    firstPrompt={slot.spawn.firstPrompt}
                    permissionMode={slot.spawn.permissionMode}
                    mcp={slot.spawn.mcp}
                    onPermissionMode={(pm) => setMissionSlotPermission(mid, slot.spawn.paneId, pm)}
                    onExecutorChange={(patch) =>
                      setMissionSlotExecutor(mid, slot.spawn.paneId, patch)
                    }
                    seats={seats}
                    seatId={slot.spawn.seatId}
                    onChangeSeat={(next) => void chooseChatSeat(mid, next)}
                    seatChanging={seatBusy !== null}
                    seatError={missionGuiError[mid]}
                  />
                  </GuiPanelErrorBoundary>
                </div>
              )
            })
          )}
          {/* MISSÃO SEM CONTA (2.0): a missão nasce só com título, então o
              primeiro habitante do palco é o CARD DE ESCOLHA — não um erro.
              Fica FORA do `.maestro-empty` (que é a casca de "// aguarde"). */}
          {selMission?.direct &&
            directSlots.length === 0 &&
            !missionTermId &&
            missionNeedsSeat[selMission.id] && (
              <div className="maestro-slot is-active">
                <GuiSeatPick
                  seats={seats}
                  title={
                    isPlanningMission
                      ? 'quem escreve este planejamento?'
                      : 'quem conversa nesta missão?'
                  }
                  hint="a conta manda no modelo e no limite gasto — dá para trocar depois, no cabeçalho do chat"
                  busySeatId={seatBusy}
                  error={missionGuiError[selMission.id]}
                  onPick={(seatId) => void chooseChatSeat(selMission.id, seatId)}
                />
              </div>
            )}
          {selMission?.direct &&
            directSlots.length === 0 &&
            !missionTermId &&
            !missionNeedsSeat[selMission.id] && (
            <div className="maestro-empty">
              {missionGuiError[selMission.id] ? (
                <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
                  <span>// {missionGuiError[selMission.id]}</span>
                  <button
                    className="term-btn"
                    onClick={() => {
                      setMissionGuiError((prev) => {
                        const next = { ...prev }
                        delete next[selMission.id]
                        return next
                      })
                      void openMissionGuiRole(selMission.id, 'dev')
                    }}
                  >
                    ⟳ tentar de novo
                  </button>
                </div>
              ) : (
                '// abrindo a conversa desta missão…'
              )}
            </div>
          )}
          {selMission &&
            !selMission.direct &&
            !missionSpecs[selMission.id] &&
            (selMission.pendingOrchestrator ? (
              <div className="maestro-empty">
                <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
                  <span>// o Maestro criou esta missão — falta escolher o orquestrador</span>
                  <button
                    className="term-btn"
                    onClick={() =>
                      setPendingOrchDismissed((prev) => {
                        const next = { ...prev }
                        delete next[selMission.id]
                        return next
                      })
                    }
                  >
                    ▶ escolher orquestrador
                  </button>
                </div>
              </div>
            ) : missionHalted[selMission.id] ? (
              <div className="maestro-empty">
                <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
                  <span>
                    // o orquestrador desta missão morreu 3× seguidas ao abrir — a causa está no
                    diário da caixa-preta (clis ▾ → ◉ exportar diagnóstico)
                  </span>
                  <button
                    className="term-btn"
                    onClick={() => {
                      missionDeaths.current[selMission.id] = []
                      setMissionHalted((prev) => {
                        const next = { ...prev }
                        delete next[selMission.id]
                        return next
                      })
                    }}
                  >
                    ⟳ tentar de novo
                  </button>
                </div>
              </div>
            ) : (
              <div className="maestro-empty">// abrindo o orquestrador da missão…</div>
            ))}
          {/* PLANEJAMENTO (2.0): o slot avulso da sessão de planejamento saiu
              daqui — a missão de tipo 'planejamento' entra pelos slots de
              conversa acima, como qualquer outra. O convite que nascia sozinho
              no ✦ geral morreu junto (ordem do dono: o universo começa vazio). */}
          {/* TERMINAIS (onda D) — ÚLTIMOS filhos de propósito: acrescentar no
              FIM não desloca nenhum irmão anterior, e deslocar remontaria os
              TerminalPane vizinhos (PTY morto). Todos ficam montados: quem
              some é o servidor junto com o terminal, e ninguém pediu isso ao
              trocar de aba. */}
          {termPanes.map((pane) => {
            const active = pane.missionId
              ? pane.missionId === missionTab && missionTermId === pane.id
              : !missionTab && generalTermId === pane.id
            return (
              <div
                key={pane.id}
                className={`maestro-slot${active ? ' is-active' : ''}`}
                aria-hidden={active ? undefined : true}
                inert={active ? undefined : true}
              >
                <GuiPanelErrorBoundary
                  paneId={pane.id}
                  label={pane.title || 'este terminal'}
                  onClose={() => window.synkora.panes.requestClose(projectId, pane.id)}
                >
                <TerminalPane
                  paneId={pane.id}
                  cwd={pane.cwd ?? projectFlow?.path ?? ''}
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
                  fontSize={maestroTerminalFont}
                  lineHeight={maestroTerminalLineHeight}
                  fontFamily={maestroTerminalFontFamily}
                  minCols={terminalMinColsForBox(pane.kind, maestroTerminalFallbackFor(pane.kind))}
                  minRows={pane.kind === 'claude' ? 12 : 6}
                  fallbackSize={maestroTerminalFallbackFor(pane.kind)}
                  sizeGroup={`${maestroSizeGroup}:${pane.kind}`}
                  voiceLabel={pane.title}
                  onUserInput={() => clearPaneAttention(projectId, pane.id)}
                />
                </GuiPanelErrorBoundary>
              </div>
            )
          })}
        </div>
        {/* ÚLTIMO filho de propósito: inserir a alça antes do .maestro-body
            deslocaria os índices dos filhos não-keyados e o React remontaria o
            body → TerminalPane remontado → PTY do Maestro MORTO. */}
        <div className="maestro-resizer" onPointerDown={onResizeStart} />
      </div>

      <ResizableRightRail
        className="board-content"
        enabled={stageMode}
        projectKey={projectId}
        label="painel lateral"
      >
      {/* ✦ GERAL VAZIO (2.0): a linha de alavancas do UNIVERSO que morava aqui
          — 📚 estudar · ⇄ conta · 🧹 limpar — foi REMOVIDA por ordem do dono
          (2026-08-15): eram os controles do Maestro, e sem Maestro elas não
          descrevem nada que o dono possa querer daqui. O ✦ geral vazio é só o
          retrato do projeto; a conta se escolhe DENTRO da missão. */}

      {/* Aba GERAL = O CONVITE ou O PAINEL (ordem do dono, 2026-08-15).
          Universo SEM NENHUMA missão: a landing é a pessoa criando missão
          (`ProjectGeneral`, cartão centralizado). Com a primeira missão de
          qualquer status a tela vira o `ProjectDashboard` — quem já tem
          história merece o retrato, não o convite. O limite de erro fica POR
          FORA do ramo: as duas telas dividem o mesmo `board-general:<id>`. */}
      {!selMission && (
        <GuiPanelErrorBoundary paneId={`board-general:${projectId}`} label="o resumo do projeto">
          {projectLanding(projectMissions) === 'invite' ? (
            <ProjectGeneral
              missionCount={projectMissions.length}
              onNewMission={() => setNewMissionOpen(true)}
            />
          ) : (
            <ProjectDashboard
              missions={projectMissions}
              entries={missionColumnEntries}
              versoes={homeStats?.versoes}
              versionLabelOf={(m) => versionName(m.versionId)}
              onOpenMission={(id) => setMissionTab(projectId, id)}
              onNewMission={() => setNewMissionOpen(true)}
            />
          )}
        </GuiPanelErrorBoundary>
      )}

      {/* MISSÃO DIRETA: sem kanban e sem filtro de função — o que resta do
          board é o TRILHO DE ENTREGA (estado da branch + alavancas). */}
      {isDirect && selMission && (
        <GuiPanelErrorBoundary
          paneId={`mission-delivery:${selMission.id}`}
          label="o trilho de entrega"
        >
          <MissionDeliveryRail
            mission={selMission}
            versionLabel={versionName(selMission.versionId)}
            queueLabel={integrationQueueLabel(selMission)}
            guiAvailable={missionGui.available()}
            shellAvailable={missionShell.available()}
            subagentItems={directGui?.items ?? []}
            testServerOpen={panes.some((p) => p.testServer && p.missionId === selMission.id)}
            reloadToken={railReload}
            onIntegrate={() => void onIntegrate()}
            onReview={() => void openMissionGuiRole(selMission.id, 'reviewer')}
            onHelper={() => void openMissionGuiRole(selMission.id, 'helper')}
            onTerminal={() => void openMissionShell(selMission.id)}
            onTestServer={() => setTestServerOpen(true)}
            onKillTestServer={() => {
              const testPane = panes.find((p) => p.testServer && p.missionId === selMission.id)
              if (testPane) window.synkora.panes.requestClose(projectId, testPane.id)
            }}
            onArchive={() => void archiveMission(selMission.id, selMission.status === 'ativa')}
          />
        </GuiPanelErrorBoundary>
      )}

      {/* A LINHA LEGADA saiu inteira: os chips de FUNÇÃO (o kanban tinha
          filtro por departamento) e as ações da missão do mundo F6 — ⇪ fila,
          ⇄ conta do orquestrador, ▶ testar, ⊟ arquivar, 🗑 excluir. As que a
          era 2.0 usa já vivem no MissionDeliveryRail (⇪, ▶ terminal de teste,
          ⊟ arquivar/↩ reativar) e o excluir da missão arquivada mora na
          sub-aba de missões da tela de Versões, com o aviso da conversa. */}
      </ResizableRightRail>

      {/* COLUNA DE MISSÕES — ÚLTIMO filho de propósito: `.board-main` é
          row-reverse, então o último do DOM é o PRIMEIRO da tela, e
          acrescentar no fim não desloca `.maestro-window` nem `.board-content`
          (deslocar remontaria os TerminalPane e mataria os PTYs). */}
      <GuiPanelErrorBoundary paneId={`mission-column:${projectId}`} label="a lista de missões">
        <MissionColumn
          entries={missionColumnEntries}
          selectedId={missionTab}
          generalPulse={tabPulse['geral']}
          onSelect={(id) => setMissionTab(projectId, id)}
          onNewMission={() => setNewMissionOpen(true)}
        />
      </GuiPanelErrorBoundary>
      </div>

      {/* servidor de teste do dono: sobe a branch da missão num pane shell */}
      {testServerOpen && selMission && (
        <GuiPanelErrorBoundary
          key={`overlay:test-server:${selMission.id}`}
          paneId={`overlay:test-server:${selMission.id}`}
          label="o servidor de teste"
          onClose={() => setTestServerOpen(false)}
        >
          <TestServerModal
            projectId={projectId}
            target={{ missionId: selMission.id }}
            label={`missão "${selMission.title.slice(0, 32)}"`}
            onClose={() => setTestServerOpen(false)}
          />
        </GuiPanelErrorBoundary>
      )}

      {newMissionOpen && (
        <GuiPanelErrorBoundary
          paneId="overlay:new-mission"
          label="a nova missão"
          onClose={() => {
            setNewMissionOpen(false)
            setMissionPrefill(null)
          }}
        >
          <NewMissionModal
            projectId={projectId}
            initialTitle={missionPrefill?.title}
            initialGoal={missionPrefill?.goal}
            onClose={() => {
              setNewMissionOpen(false)
              setMissionPrefill(null)
            }}
            onCreated={(m) => setMissionTab(projectId, m.id)}
          />
        </GuiPanelErrorBoundary>
      )}

      {/* Missão criada pelo PM aguardando a escolha do orquestrador: o mesmo
          modal, com título/goal/versão travados — só conta/modelo/effort
          (decisão do usuário, 02/08). "depois" fecha; o placeholder da aba
          da missão reabre. */}
      {isActive && pendingOrchMission && !pendingOrchDismissed[pendingOrchMission.id] && (
        <GuiPanelErrorBoundary
          key={`overlay:pending-mission:${pendingOrchMission.id}`}
          paneId={`overlay:pending-mission:${pendingOrchMission.id}`}
          label="a confirmação da missão"
          onClose={() =>
            setPendingOrchDismissed((prev) => ({ ...prev, [pendingOrchMission.id]: true }))
          }
        >
          <NewMissionModal
            key={pendingOrchMission.id}
            projectId={projectId}
            confirmMission={pendingOrchMission}
            onClose={() =>
              setPendingOrchDismissed((prev) => ({ ...prev, [pendingOrchMission.id]: true }))
            }
          />
        </GuiPanelErrorBoundary>
      )}
    </div>
  )
}

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { prettyModel } from './PaneChrome'
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
  type Mission,
  type Pane,
  type Version
} from '../store'
import type { GuiPaneSpawn, GuiPermissionMode } from '../guiApi'
import { guiModelLabel } from '../guiComposerPresentation'
import { canSendGuiMessage } from '../guiTransport'
import { guiItemId } from '../guiItemIdentity'
import { REVIEW_NUDGE_TEXT } from '../missionReviewNudge'
import { missionGui, type MissionGuiRole } from '../missionGui'
import { GuiRequestEpoch, withoutMissionGuiSlots } from '../guiRequestEpoch'
import GuiSeatPick from './GuiSeatPick'
import { missionShell } from '../missionShell'
import { projectLanding } from '../projectLanding'
import { plansApi } from '../plansApi'
import type { PlanView } from '../planContract'
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
// e o estado do turno é o próprio chat (cursor de streaming). Do PaneChrome
// só sobrou `prettyModel`, que embeleza o id do modelo na linha fina.

function integrationQueueLabel(mission: Mission): string | undefined {
  const integration = mission.integration
  if (!integration) return undefined
  if (integration.state === 'merging') return 'integrando agora'
  if (integration.state === 'blocked')
    return integration.owner === 'orchestrator'
      ? 'fila pausada — reparo seguro do destino pendente'
      : 'fila pausada — decisão pendente'
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

export default function Board({ projectId }: Props): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const missions = useStore((s) => s.missions)
  // Retrato por versão do painel do projeto (✦ geral com missões). NÃO se
  // busca aqui: o Universe, que hospeda este Board, já faz o load preguiçoso
  // do `homeStats` deste projeto, e os canais *:changed o mantêm fresco.
  const homeStats = useStore((s) => s.homeStats[projectId])
  // OS PLANOS NA CASA DO PROJETO (2026-08-17): o painel do ✦ geral mostra o
  // relance (título, mestre, fração concluída) e o gesto leva ao mapa, onde
  // eles se editam. Uma leitura por projeto, com o mesmo `plans:changed` que a
  // aba do mapa assina — o agente edita por tool e a casa acompanha.
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const [projectPlans, setProjectPlans] = useState<PlanView[]>([])
  const loadMissions = useStore((s) => s.loadMissions)
  const archiveMission = useStore((s) => s.archiveMission)
  const concludePlanningMission = useStore((s) => s.concludePlanningMission)
  const deleteMission = useStore((s) => s.deleteMission)
  const integrateMission = useStore((s) => s.integrateMission)
  const missionTab = useStore((s) => s.missionTabByProject[projectId] ?? null)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const panes = useStore((s) => s.panesByProject[projectId] ?? NO_PANES)
  const closePane = useStore((s) => s.closePane)
  const paneActivity = useStore((s) => s.paneActivity)
  const guiPanes = useStore((s) => s.guiPanes)
  const clearPaneAttention = useStore((s) => s.clearPaneAttention)
  const resetPaneTelemetry = useStore((s) => s.resetPaneTelemetry)
  // Vários universos ficam montados ao mesmo tempo (troca estilo Discord) —
  // efeitos que mexem em estado global/processos só rodam no projeto ATIVO.
  const isActive = useStore((s) => s.openProjectId === projectId)
  const appPage = useStore((s) => s.appPage)
  const projectFlow = useStore((s) => s.projects.find((p) => p.id === projectId))
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
  // O 🧐 revisar é UM toque por clique: sem esta trava, dois cliques rápidos
  // colocariam duas falas iguais do dono no fio (o envio é IPC, leva ms, mas o
  // dedo é mais rápido que ele).
  const reviewNudgeInFlight = useRef(false)
  const dropGuiPane = useStore((s) => s.dropGuiPane)
  const sendGuiMessage = useStore((s) => s.sendGuiMessage)
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
  const [testServerOpen, setTestServerOpen] = useState(false)
  const uniTab = useStore((s) => s.universeTabByProject[projectId] ?? 'board')
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

  // PLANOS: uma leitura no mount + o canal de mudança. Sem a ponte a lista fica
  // vazia e a seção do painel simplesmente não nasce — a aba Mapa é quem tem de
  // explicar a falta dela, não a casa do projeto.
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void plansApi.list(projectId).then((list) => {
        if (alive) setProjectPlans(list)
      })
    }
    read()
    const off = plansApi.onChanged((pid) => {
      if (pid === projectId) read()
    })
    return () => {
      alive = false
      off()
    }
  }, [projectId])

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

  useEffect(() => {
    void loadMissions(projectId)
  }, [projectId, loadMissions])

  // Missões mudaram no main (criada pelo PM, integrada, sync…) → recarrega.
  useEffect(() => {
    if (!window.synkora.missions) return
    return window.synkora.missions.onChanged((pid) => {
      if (pid === projectId && useStore.getState().openProjectId === projectId)
        void loadMissions(projectId)
    })
  }, [projectId, loadMissions])

  // O poller de TAREFAS e o reconciliador de 30s saíram na purga F6: não há
  // mais card para reconciliar — o estado da missão 2.0 é a conversa.

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

  // O PULSO DAS ABAS saiu inteiro na purga F6 (2026-08-17): a heurística do
  // "?" lia panes TUI que não existem mais, e o canal ask_user morreu com o
  // papel que o usava (R-18). A pergunta do agente na era 2.0 é o
  // GuiQuestionCard, dentro da própria conversa — e o card da missão já pulsa
  // por ele (`waitingKind`, logo abaixo).
  const tabPulse: Record<string, string> = {}

  // O SPAWN EM SEGUNDO PLANO dos orquestradores TUI saiu na purga F6, e com
  // ele o anti-loop de 3 mortes em 30s e a liberação de spec de missão
  // concluída. Missão 2.0 não tem orquestrador: tem conversa.

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
  // ✦ GERAL NÃO TEM CONVERSA (2.0): um terminal avulso vivo é o ÚNICO
  // habitante possível do palco — o foco cai nele mesmo que o escolhido tenha
  // morrido, senão o pane seguia rodando atrás de uma tela vazia, sem porta.
  const generalTermId =
    (generalTermPanes.some((p) => p.id === generalTerm) ? generalTerm : null) ??
    (generalTermPanes[0]?.id ?? null)

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

  /** Abre (ou volta o foco para) uma conversa da missão direta.
   *
   *  ONDA W3 (ordem do dono, 2026-08-18): o AJUDANTE saiu daqui. Ele não nasce
   *  mais de clique nenhum — quem o abre é o agente do chat, pelo `delegate` do
   *  MCP, e ele nunca vira aba. A cerca é o TIPO do parâmetro: pedir 'helper'
   *  por este caminho virou erro de compilação, não de revisão. O papel segue
   *  vivo no contrato do main (pane já aberto vive até fechar, e o dispose da
   *  missão encerra todos), só o renderer é que parou de criá-los. */
  async function openMissionGuiRole(
    missionId: string,
    role: Exclude<MissionGuiRole, 'helper'>
  ): Promise<void> {
    const slots = missionGuiSlots[missionId] ?? []
    // Todo papel que a UI ainda abre é ÚNICO por missão: clicar de novo volta o
    // foco para a rodada em andamento, em vez de jogar fora o que já estava
    // escrito naquela conversa.
    const existing = slots.find((s) => s.role === role)
    if (existing) {
      // Abrir uma conversa FOCA a pílula dela: se um terminal estava no ar,
      // ele sai da frente (senão o clique no trilho parecia não fazer nada).
      setMissionTerm((prev) => ({ ...prev, [missionId]: null }))
      setMissionGuiActive((prev) => ({ ...prev, [missionId]: existing.spawn.paneId }))
      return
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

  // Missão DIRETA (2.0): quem ocupa o centro é uma CONVERSA no worktree.
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
  // SINAL DE ATIVIDADE do trilho de entrega (W4, 2026-08-18): `eventRevision`
  // é o contador que o store JÁ avança a cada evento REAL do backend —
  // mensagem, resultado de ferramenta, ajudante que assenta no fio do agente.
  // Somar as conversas desta missão dá, de graça, um número que só anda quando
  // algo aconteceu de verdade; o debounce de cauda mora no trilho. Zero canal
  // novo e zero leitura extra: o Board já re-renderiza a cada evento.
  const railActivity = directSlots.reduce(
    (total, slot) => total + (guiPanes[slot.spawn.paneId]?.eventRevision ?? 0),
    0
  )
  const directSeat = directSlot
    ? seats.find((x) => x.configDir && x.configDir === directSlot.spawn.configDir)
    : undefined
  // O 🧐 revisar fala com o chat do AGENTE — nunca com o slot que está em foco:
  // é ele o dono dos ajudantes desta missão (quem delega pelo MCP é ele).
  const devSlot = directSlots.find((s) => s.role === 'dev')
  const devGui = devSlot ? guiPanes[devSlot.spawn.paneId] : undefined
  // Mesma régua do composer: o transporte só existe depois do `ready`, e sessão
  // morta/nascendo não recebe fala nenhuma. Agente OCUPADO recebe: os dois
  // motores enfileiram/steeram por conta própria.
  const reviewReady = Boolean(devGui && canSendGuiMessage(devGui.status, devGui.ready))

  /** 🧐 REVISAR (ordem do dono, 2026-08-18): o botão parou de abrir pane de
   *  revisor — ele DÁ UM TOQUE no agente da missão. O texto entra no fio como
   *  mensagem do DONO, pelo mesmo caminho do composer (`gui.send`, pela ação do
   *  store), e quem abre o ajudante de revisão é o agente, pelo `delegate` do
   *  MCP: é o único caminho em que modelo, effort e conta aparecem na lateral.
   *  O harness NUNCA spawna o revisor direto. */
  async function nudgeReview(): Promise<void> {
    const mission = selMission
    const paneId = devSlot?.spawn.paneId
    if (!mission || !paneId || !reviewReady || reviewNudgeInFlight.current) return
    reviewNudgeInFlight.current = true
    // O toque é VISÍVEL: a conversa do agente vem para a frente antes de a
    // mensagem entrar (com um terminal no ar, o clique pareceria não fazer nada).
    setMissionTerm((prev) => ({ ...prev, [mission.id]: null }))
    setMissionGuiActive((prev) => ({ ...prev, [mission.id]: paneId }))
    try {
      // messageId PRÓPRIO, cunhado pelo `guiItemIdentity`: é ele que dá
      // idempotência à entrega no main — uma repetição do MESMO envio nunca
      // vira duas bolhas no fio.
      const ok = await sendGuiMessage(paneId, REVIEW_NUDGE_TEXT, guiItemId())
      if (!ok)
        setMissionMsg(
          'não deu para entregar o pedido de revisão no chat do agente — abra a conversa e tente de novo'
        )
    } finally {
      reviewNudgeInFlight.current = false
    }
  }
  // TERMINAL EM FOCO (onda D): quando existe, é ele que o chrome descreve —
  // papel, marca, título e telemetria saem do PTY, não da conversa que ficou
  // montada atrás dele.
  const activeTermPane = missionTab
    ? missionTermPanes.find((p) => p.id === missionTermId)
    : generalTermPanes.find((p) => p.id === generalTermId)
  // O PALCO só existe quando há o que mostrar: a conversa de uma missão 2.0
  // (mesmo antes de nascer — ali aparece a escolha de conta) ou um terminal em
  // foco. ✦ geral sem terminal e missão LEGADA (que perdeu o TUI na purga F6)
  // não têm habitante: a janela inteira sai da tela por CSS — desmontar
  // remontaria os slots de trás e mataria PTYs — e o retrato do projeto ocupa
  // a linha sozinho.
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
  const stageEmpty = !selMission && !activeTermPane
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

  /** A LINHA FINA descreve o que está no palco: uma conversa (missão direta)
   *  ou o terminal em foco — inclusive o avulso do ✦ geral. */
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
    const slots = missionGuiSlots[m.id] ?? []
    // A conta/modelo que aparecem no card são os da CONVERSA aberta (o que o
    // dono está de fato gastando ali); sem conversa, a conta carimbada na
    // missão.
    const guiSpawn = slots[0]?.spawn
    const seat = guiSpawn
      ? seats.find((x) => x.configDir && x.configDir === guiSpawn.configDir)
      : seats.find((x) => x.id === m.seatId)
    // O que PARA a conversa esperando o dono (permissão, pergunta com opções,
    // plano a aprovar) é o sinal real e precisa pulsar o card.
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
    return {
      mission: m,
      seatName: seat?.name,
      model: (() => {
        const guiState = guiPanes[slots[0]?.spawn.paneId ?? '']
        return guiState?.executorKnown
          ? guiState.executorModel ?? guiState.model ?? guiSpawn?.model
          : guiSpawn?.model ?? guiState?.model ?? m.model
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
        className={`maestro-window stage-window${stageEmpty ? ' stage-empty' : ''}`}
        ref={winRef}
      >
        {/* A CABEÇA DO PALCO é sempre em PAPEL. O chrome escuro de terminal
            (PaneChrome com badges de modelo, effort, contexto e os chips da
            missão legada) morreu na purga F6 (2026-08-17) junto com o TUI que
            ele vestia. Sem `actions`: as alavancas do universo — estudar,
            conta, limpar — saíram do app com o papel de Maestro. */}
        <MissionStageHead pills={stagePills} meta={stageMetaParts} />
        <div className="maestro-body maestro-terminal" ref={maestroTerminalRef}>
          {/* O SLOT DO PM (o terminal do Maestro, sempre montado) e os slots
              dos ORQUESTRADORES de missão legada saíram na purga F6
              (2026-08-17). Sobraram os filhos da era 2.0 — e cada um deles é
              um FRAGMENTO COM CHAVE de propósito: assim a posição de um irmão
              não é mais o que identifica a lista, e nenhuma remoção futura
              pode remontar um TerminalPane vivo (PTY morto). */}
          {/* MISSÃO DIRETA (2.0): as conversas GUI do worktree. Lista KEYADA e
              separada da dos orquestradores — cada slot é uma sessão viva no
              main, então nada aqui pode remontar ao trocar de aba/papel. */}
          <Fragment key="mission-gui-slots">
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
          </Fragment>
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
          {/* MISSÃO LEGADA: o TUI do orquestrador que ocupava este palco morreu
              na purga F6 (2026-08-17). A missão continua legível — card, fila,
              branch — mas não tem conversa para abrir aqui. Dizer isso é
              melhor do que uma coluna em branco sem explicação. */}
          {selMission && !selMission.direct && !missionTermId && (
            <div className="maestro-empty">
              // missão do fluxo antigo — sem conversa para abrir aqui
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
          {/* O ramo do ORQUESTRADOR que não nasceu (escolher orquestrador,
              anti-loop de 3 mortes, "abrindo o orquestrador…") saiu na purga
              F6: missão sem conversa 2.0 não tem orquestrador para esperar. */}
          {/* PLANEJAMENTO (2.0): o slot avulso da sessão de planejamento saiu
              daqui — a missão de tipo 'planejamento' entra pelos slots de
              conversa acima, como qualquer outra. O convite que nascia sozinho
              no ✦ geral morreu junto (ordem do dono: o universo começa vazio). */}
          {/* TERMINAIS (onda D) — ÚLTIMOS filhos de propósito: acrescentar no
              FIM não desloca nenhum irmão anterior, e deslocar remontaria os
              TerminalPane vizinhos (PTY morto). Todos ficam montados: quem
              some é o servidor junto com o terminal, e ninguém pediu isso ao
              trocar de aba. */}
          <Fragment key="terminal-slots">
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
          </Fragment>
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
              versaoNaMain={homeStats?.versaoNaMain}
              plans={projectPlans}
              versionLabelOf={(m) => versionName(m.versionId)}
              onOpenMission={(id) => setMissionTab(projectId, id)}
              onOpenPlans={() => setUniverseTab(projectId, 'mapa')}
              onNewMission={() => setNewMissionOpen(true)}
            />
          )}
        </GuiPanelErrorBoundary>
      )}

      {/* MISSÃO DIRETA: sem kanban e sem filtro de função — o que resta do
          board é o TRILHO DE ENTREGA (estado da branch + alavancas).
          W4: `visible` e `activityToken` são o que faz o trilho medir SOZINHO.
          O Board é a autoridade do "à vista" — ele fica MONTADO fora da aba e
          fora do projeto ativo (desmontar mataria as conversas e os PTYs), então
          só ele sabe se o trilho está mesmo na tela do dono. */}
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
            reviewReady={reviewReady}
            shellAvailable={missionShell.available()}
            subagentItems={directGui?.items ?? []}
            testServerOpen={panes.some((p) => p.testServer && p.missionId === selMission.id)}
            reloadToken={railReload}
            visible={isActive && uniTab === 'board'}
            activityToken={railActivity}
            onIntegrate={() => void onIntegrate()}
            onReview={() => void nudgeReview()}
            onTerminal={() => void openMissionShell(selMission.id)}
            onTestServer={() => setTestServerOpen(true)}
            onKillTestServer={() => {
              const testPane = panes.find((p) => p.testServer && p.missionId === selMission.id)
              if (testPane) window.synkora.panes.requestClose(projectId, testPane.id)
            }}
            onArchive={() => void archiveMission(selMission.id, selMission.status === 'ativa')}
            onConclude={() => void concludePlanningMission(selMission.id)}
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

      {/* O modal de CONFIRMAÇÃO DE ORQUESTRADOR (missão criada pelo PM com
          conta/modelo/effort ainda por escolher) saiu na purga F6: missão 2.0
          nasce do dono e a conta dela se escolhe no card do próprio chat. */}
    </div>
  )
}

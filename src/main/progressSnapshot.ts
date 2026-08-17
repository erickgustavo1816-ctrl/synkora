import type { IntegrationQueueTicketView } from './integrationQueue'
import type { Mission } from './missions'
import type { Project } from './projects'
import type { Task } from './tasks'

export type ProgressTone = 'attention' | 'running' | 'waiting' | 'success' | 'idle'

export type ProgressCoordinatorRole = 'maestro' | 'orchestrator'

export type ProgressCoordinatorActivityKind = 'terminal' | 'conversation' | 'survey'

export type MissionProgressState =
  | 'planning'
  | 'starting'
  | 'awaiting_approval'
  | 'paused'
  | 'implementing'
  | 'reviewing'
  | 'qa'
  | 'interrupted'
  | 'finalizing'
  | 'ready_to_integrate'
  | 'queued'
  | 'syncing'
  | 'blocked'
  | 'integrating'
  | 'completed'

export type ProjectProgressState =
  | 'attention'
  | 'integrating'
  | 'running'
  | 'planning'
  | 'completed'
  | 'idle'

export interface ProgressCardPreview {
  id: string
  title: string
  phase?: 'dev' | 'review' | 'qa'
  phaseState?: 'pending' | 'running' | 'interrupted' | 'finalizing'
  phaseLabel: string
  interrupted: boolean
  /** tom individual do card (o radar pinta pill por agente, 2026-08-06) */
  tone: ProgressTone
  /** frase viva do agente (status_note via MCP), sanitizada no main */
  note?: string
  /** frescor da linha: máximo entre mutação do card e a nota do agente */
  updatedAt: string
}

/** Frase curta que o PRÓPRIO agente registrou via tool status_note — é o que
 * faz o radar contar "o que está acontecendo agora" sem abrir o app. */
export interface ProgressPaneNoteInput {
  projectId: string
  missionId?: string
  taskId?: string
  phase?: 'dev' | 'review' | 'qa'
  role: string
  text: string
  at: string
}

/** Pergunta do ask_user pendente — o radar é o lugar nº 1 onde ela precisa
 * aparecer (o dono pode nem estar com o app na frente). */
export interface ProgressQuestionInput {
  projectId: string
  /** missionId ou 'geral' */
  missionKey: string
  question: string
  at: string
}

/** Pulso vivo e sanitizado vindo do processo principal. O radar recebe apenas
 * identidade estrutural e horário; saída de terminal, prompts e caminhos nunca
 * atravessam a ponte da janela sempre visível. */
export interface ProgressCoordinatorActivityInput {
  projectId: string
  missionId?: string
  role: ProgressCoordinatorRole
  kind?: ProgressCoordinatorActivityKind
  working: boolean
  updatedAt: string
  /** frase viva do coordenador (status_note) — viaja NA atividade para os dois
   * caminhos (build completo e pulso vivo) a carregarem sem fonte extra */
  note?: string
}

export interface ProgressCoordinatorSnapshot {
  id: string
  projectId: string
  missionId?: string
  role: ProgressCoordinatorRole
  roleLabel: string
  label: string
  detail?: string
  tone: 'running'
  updatedAt: string
  /** frase viva registrada pelo próprio coordenador (status_note) */
  note?: string
}

export interface ProgressMissionSnapshot {
  id: string
  projectId: string
  title: string
  kind?: 'mission' | 'general'
  state: MissionProgressState
  tone: ProgressTone
  label: string
  detail?: string
  updatedAt: string
  completedAt?: string
  progress: {
    done: number
    total: number
    active: number
  }
  activeCards: ProgressCardPreview[]
  queue?: {
    state: IntegrationQueueTicketView['state']
    position: number
    total: number
    owner?: 'maestro' | 'orchestrator'
  }
  /** pergunta do ask_user do ORQUESTRADOR desta missão, esperando o dono */
  question?: string
}

export interface ProgressProjectSnapshot {
  id: string
  name: string
  mode?: Project['mode']
  missing: boolean
  state: ProjectProgressState
  tone: ProgressTone
  label: string
  coordinators: ProgressCoordinatorSnapshot[]
  activeMissions: ProgressMissionSnapshot[]
  recentCompletions: ProgressMissionSnapshot[]
  /** pergunta do ask_user do PM (missionKey 'geral'), esperando o dono */
  question?: string
}

export interface ProgressOverlaySnapshot {
  revision: number
  generatedAt: string
  totals: {
    projects: number
    activeProjects: number
    activeMissions: number
    activeCards: number
    activeCoordinators: number
    attentionMissions: number
    attentionProjects: number
    recentCompletions: number
  }
  projects: ProgressProjectSnapshot[]
}

export interface ProgressSnapshotInput {
  projects: readonly Project[]
  missions: readonly Mission[]
  tasks: readonly Task[]
  integrationQueue: readonly IntegrationQueueTicketView[]
  /** projetos cuja pasta sumiu do disco — o radar mostra "pasta não encontrada" */
  missingProjectIds?: readonly string[]
  coordinatorActivity?: readonly ProgressCoordinatorActivityInput[]
  paneNotes?: readonly ProgressPaneNoteInput[]
  pendingQuestions?: readonly ProgressQuestionInput[]
  revision?: number
  now?: string | Date
  recentCompletionDays?: number
}

const PROJECT_STATE_ORDER: Record<ProjectProgressState, number> = {
  attention: 0,
  integrating: 1,
  running: 2,
  planning: 3,
  completed: 4,
  idle: 5
}

const MISSION_STATE_ORDER: Record<MissionProgressState, number> = {
  blocked: 0,
  interrupted: 1,
  syncing: 2,
  integrating: 3,
  qa: 4,
  reviewing: 5,
  implementing: 6,
  finalizing: 7,
  queued: 8,
  awaiting_approval: 9,
  paused: 10,
  ready_to_integrate: 11,
  starting: 12,
  planning: 13,
  completed: 14
}

const ATTENTION_STATES = new Set<MissionProgressState>([
  'blocked',
  'interrupted',
  'awaiting_approval'
])
const RUNNING_STATES = new Set<MissionProgressState>([
  'implementing',
  'reviewing',
  'qa',
  'finalizing',
  'syncing',
  'integrating'
])

function safeDate(value: string | Date | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  const parsed = value ? new Date(value) : new Date()
  return Number.isFinite(parsed.getTime()) ? parsed : new Date()
}

function currentPlan(tasks: readonly Task[]): Task | undefined {
  const plans = tasks.filter((task) => task.kind === 'plan')
  return [...plans].reverse().find((task) => task.status !== 'done') ?? plans.at(-1)
}

/** Mantém a mesma fronteira usada pelo Board: um plano novo nunca herda cards
 * de um plano anterior somente porque ambos pertencem à mesma missão. */
function belongsToPlan(task: Task, plan: Task): boolean {
  if (task.planId) return task.planId === plan.id
  if (plan.status === 'done') return false
  const approvedAt = plan.plan?.approvedAt
  return !approvedAt || task.createdAt >= approvedAt
}

function workTasksOf(tasks: readonly Task[], plan: Task | undefined): Task[] {
  const work = tasks.filter((task) => task.kind !== 'plan')
  return plan ? work.filter((task) => belongsToPlan(task, plan)) : work
}

function cardPhaseLabel(task: Task): string {
  if (task.phaseState === 'finalizing') return 'integrando o card aprovado'
  if (task.phaseState === 'interrupted') {
    if (task.activePhase === 'review') return 'revisão interrompida'
    if (task.activePhase === 'qa') return 'QA interrompido'
    return 'execução interrompida'
  }
  if (task.phaseState === 'pending') {
    if (task.activePhase === 'review') return 'abrindo a revisão'
    if (task.activePhase === 'qa' || task.status === 'qa') return 'abrindo o QA'
    return 'preparando a execução'
  }
  if (task.activePhase === 'review') return 'em revisão'
  if (task.activePhase === 'qa' || task.status === 'qa') return 'em QA'
  return 'implementando'
}

function activeCardOrder(task: Task): number {
  if (task.phaseState === 'interrupted') return 0
  if (task.phaseState === 'finalizing') return 1
  if (task.phaseState === 'running' && (task.activePhase === 'qa' || task.status === 'qa')) return 2
  if (task.phaseState === 'running' && task.activePhase === 'review') return 3
  if (task.phaseState === 'running') return 4
  if (task.phaseState === 'pending') return 5
  return 6
}

function activeCard(task: Task): boolean {
  return (
    task.status === 'execucao' ||
    task.status === 'qa' ||
    task.phaseState === 'running' ||
    task.phaseState === 'interrupted'
  )
}

function queueSnapshot(ticket: IntegrationQueueTicketView): ProgressMissionSnapshot['queue'] {
  return {
    state: ticket.state,
    position: ticket.position,
    total: ticket.total,
    ...(ticket.block?.owner ? { owner: ticket.block.owner } : {})
  }
}

function completedMission(mission: Mission): ProgressMissionSnapshot {
  const completedAt = mission.completedAt ?? mission.updatedAt
  return {
    id: mission.id,
    projectId: mission.projectId,
    title: mission.title,
    kind: 'mission',
    state: 'completed',
    tone: 'success',
    label: 'concluída',
    detail: mission.kind === 'direta' ? 'ajuste direto registrado' : undefined,
    updatedAt: mission.updatedAt,
    completedAt,
    progress: { done: 0, total: 0, active: 0 },
    activeCards: []
  }
}

function cardTone(task: Task): ProgressTone {
  if (task.phaseState === 'interrupted') return 'attention'
  if (task.phaseState === 'pending') return 'waiting'
  return 'running'
}

/** Nota mais fresca do card, preferindo a fase ATIVA (o dev e o gate do mesmo
 * card carimbam notas distintas — a da fase corrente é a que conta). */
function latestNoteFor(
  notes: readonly ProgressPaneNoteInput[],
  task: Task
): ProgressPaneNoteInput | undefined {
  const mine = notes.filter((note) => note.taskId === task.id)
  if (mine.length === 0) return undefined
  const samePhase = task.activePhase
    ? mine.filter((note) => note.phase === task.activePhase)
    : []
  const pool = samePhase.length > 0 ? samePhase : mine
  return [...pool].sort((a, b) => b.at.localeCompare(a.at))[0]
}

function missionSnapshot(
  mission: Mission,
  missionTasks: readonly Task[],
  ticket: IntegrationQueueTicketView | undefined,
  notes: readonly ProgressPaneNoteInput[] = [],
  question?: string
): ProgressMissionSnapshot {
  const snapshot = missionSnapshotInner(mission, missionTasks, ticket, notes)
  if (!question || snapshot.state === 'completed') return snapshot
  // pergunta pendente vence qualquer tom: é o DONO que precisa agir agora
  return { ...snapshot, question, tone: 'attention' }
}

function missionSnapshotInner(
  mission: Mission,
  missionTasks: readonly Task[],
  ticket: IntegrationQueueTicketView | undefined,
  notes: readonly ProgressPaneNoteInput[]
): ProgressMissionSnapshot {
  if (mission.status === 'concluida') return completedMission(mission)

  const plan = currentPlan(missionTasks)
  const workTasks = workTasksOf(missionTasks, plan)
  const activeTasks = workTasks.filter(activeCard)
  const previews = [...activeTasks]
    .sort((a, b) => activeCardOrder(a) - activeCardOrder(b) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6)
    .map((task): ProgressCardPreview => {
      const note = latestNoteFor(notes, task)
      return {
        id: task.id,
        title: task.title,
        phase: task.activePhase,
        phaseState: task.phaseState,
        phaseLabel: cardPhaseLabel(task),
        interrupted: task.phaseState === 'interrupted',
        tone: cardTone(task),
        ...(note ? { note: note.text } : {}),
        updatedAt: note && note.at > task.updatedAt ? note.at : task.updatedAt
      }
    })
  const done = workTasks.filter((task) => task.status === 'done').length
  const progress = { done, total: workTasks.length, active: activeTasks.length }
  const base = {
    id: mission.id,
    projectId: mission.projectId,
    title: mission.title,
    kind: 'mission' as const,
    updatedAt: mission.updatedAt,
    progress,
    activeCards: previews,
    ...(ticket ? { queue: queueSnapshot(ticket) } : {})
  }

  if (ticket?.state === 'blocked') {
    const byMaestro = ticket.block?.owner === 'maestro'
    return {
      ...base,
      state: 'blocked',
      tone: 'attention',
      label: 'integração bloqueada',
      detail: byMaestro
        ? 'o Maestro está decidindo como resolver o conflito'
        : 'o orquestrador precisa reparar a missão'
    }
  }
  if (ticket?.state === 'sync_required') {
    return {
      ...base,
      state: 'syncing',
      tone: 'waiting',
      label: 'sincronizando para integrar',
      detail: 'atualizando a missão com a base mais recente'
    }
  }
  if (ticket?.state === 'merging' || mission.status === 'integrando') {
    return {
      ...base,
      state: 'integrating',
      tone: 'running',
      label: 'integrando agora',
      detail: 'aplicando a missão ao projeto'
    }
  }
  if (ticket?.state === 'queued') {
    return {
      ...base,
      state: 'queued',
      tone: 'waiting',
      label: `na fila · ${ticket.position} de ${ticket.total}`,
      detail: ticket.isHead ? 'é a próxima a integrar' : 'aguardando as missões anteriores'
    }
  }

  const interrupted = activeTasks.find((task) => task.phaseState === 'interrupted')
  if (interrupted) {
    return {
      ...base,
      state: 'interrupted',
      tone: 'attention',
      label: cardPhaseLabel(interrupted),
      detail: interrupted.title
    }
  }

  if (activeTasks.length > 0) {
    const workingTasks = activeTasks.filter((task) => task.phaseState !== 'pending')
    if (workingTasks.length === 0) {
      return {
        ...base,
        state: 'starting',
        tone: 'waiting',
        label: activeTasks.length === 1 ? cardPhaseLabel(activeTasks[0]) : 'preparando os agentes',
        detail: activeTasks.length === 1
          ? activeTasks[0].title
          : `${activeTasks.length} cards aguardando abertura`
      }
    }
    const finalizingCard = workingTasks.find((task) => task.phaseState === 'finalizing')
    const qa = workingTasks.find((task) => task.activePhase === 'qa' || task.status === 'qa')
    const review = workingTasks.find((task) => task.activePhase === 'review')
    const state: MissionProgressState = finalizingCard
      ? 'finalizing'
      : qa
        ? 'qa'
        : review
          ? 'reviewing'
          : 'implementing'
    const label = finalizingCard
      ? 'integrando card aprovado'
      : qa
        ? 'validando em QA'
        : review
          ? 'revisando o trabalho'
          : 'implementando'
    return {
      ...base,
      state,
      tone: 'running',
      label,
      detail: workingTasks.length === 1
        ? workingTasks[0].title
        : `${workingTasks.length} tarefas em paralelo`
    }
  }

  const finalVerification = plan?.plan?.verification?.final
  if (
    plan?.status === 'execucao' &&
    (finalVerification?.status === 'running' || finalVerification?.status === 'pending')
  ) {
    return {
      ...base,
      state: 'finalizing',
      tone: 'running',
      label: 'verificando o resultado conjunto',
      detail: 'conferindo a missão inteira depois de reunir os cards'
    }
  }
  if (
    plan?.status === 'execucao' &&
    (finalVerification?.comparison?.status === 'blocked' ||
      finalVerification?.status === 'failed' ||
      finalVerification?.status === 'timed_out' ||
      finalVerification?.status === 'unavailable' ||
      finalVerification?.status === 'cancelled')
  ) {
    return {
      ...base,
      state: 'interrupted',
      tone: 'attention',
      label: 'verificação conjunta bloqueada',
      detail: 'o orquestrador recebeu o diagnóstico para corrigir o plano'
    }
  }

  if (plan?.status === 'backlog') {
    if (plan.plan?.approvedAt) {
      return {
        ...base,
        state: 'paused',
        tone: 'waiting',
        label: 'pausada',
        detail: 'aguardando você retomar o plano'
      }
    }
    return {
      ...base,
      state: 'awaiting_approval',
      tone: 'attention',
      label: 'aguardando sua aprovação',
      detail: 'o plano da missão está pronto para revisão'
    }
  }

  if (plan?.status === 'done') {
    return {
      ...base,
      state: 'ready_to_integrate',
      tone: 'waiting',
      label: 'pronta para integrar',
      detail: progress.total > 0 ? `${progress.done} de ${progress.total} tarefas concluídas` : undefined
    }
  }

  if (plan?.status === 'execucao') {
    const remaining = progress.total - progress.done
    return {
      ...base,
      state: 'finalizing',
      tone: 'running',
      label: remaining > 0 ? 'preparando a próxima tarefa' : 'finalizando o plano',
      detail: remaining > 0
        ? `${progress.done} de ${progress.total} tarefas concluídas`
        : 'as tarefas terminaram; o orquestrador está fechando a missão'
    }
  }

  return {
    ...base,
    state: 'planning',
    tone: 'waiting',
    label: 'planejando',
    detail: 'o orquestrador está preparando o plano da missão'
  }
}

function coordinatorSnapshot(
  activity: ProgressCoordinatorActivityInput,
  missions: readonly ProgressMissionSnapshot[]
): ProgressCoordinatorSnapshot | undefined {
  if (!activity.working) return undefined
  const mission = activity.missionId
    ? missions.find((candidate) => candidate.id === activity.missionId)
    : undefined

  if (activity.role === 'orchestrator') {
    if (!mission) return undefined
    const stateCopy: Record<MissionProgressState, { label: string; detail?: string }> = {
      planning: {
        label: 'preparando o plano da missão',
        detail: mission.title
      },
      starting: {
        label: 'abrindo os agentes da missão',
        detail: mission.title
      },
      awaiting_approval: {
        label: 'ajustando o plano para sua revisão',
        detail: mission.title
      },
      paused: {
        label: 'revendo o plano pausado',
        detail: mission.title
      },
      implementing: {
        label: 'coordenando a implementação',
        detail: mission.progress.active > 0
          ? `${mission.progress.active} ${mission.progress.active === 1 ? 'card ativo' : 'cards ativos'} · ${mission.title}`
          : mission.title
      },
      reviewing: {
        label: 'acompanhando a revisão',
        detail: mission.title
      },
      qa: {
        label: 'acompanhando a validação de QA',
        detail: mission.title
      },
      interrupted: {
        label: 'tratando uma execução interrompida',
        detail: mission.title
      },
      finalizing: {
        label: mission.label,
        detail: mission.title
      },
      ready_to_integrate: {
        label: 'preparando a integração da missão',
        detail: mission.title
      },
      queued: {
        label: 'acompanhando a fila de integração',
        detail: mission.title
      },
      syncing: {
        label: 'sincronizando a missão com a base',
        detail: mission.title
      },
      blocked: {
        label: mission.queue?.owner === 'maestro'
          ? 'acompanhando a decisão do Maestro'
          : 'reparando um bloqueio da missão',
        detail: mission.title
      },
      integrating: {
        label: 'acompanhando a integração',
        detail: mission.title
      },
      completed: {
        label: 'fechando a missão concluída',
        detail: mission.title
      }
    }
    return {
      id: `orchestrator:${mission.id}`,
      projectId: activity.projectId,
      missionId: mission.id,
      role: 'orchestrator',
      roleLabel: 'Orquestrador',
      ...stateCopy[mission.state],
      tone: 'running',
      updatedAt: activity.updatedAt,
      ...(activity.note ? { note: activity.note } : {})
    }
  }

  if (activity.kind === 'survey') {
    return {
      id: `maestro:${activity.projectId}`,
      projectId: activity.projectId,
      role: 'maestro',
      roleLabel: 'Maestro',
      label: 'mapeando o projeto e atualizando o dossiê',
      detail: 'analisando a estrutura e o contexto do projeto',
      tone: 'running',
      updatedAt: activity.updatedAt,
      ...(activity.note ? { note: activity.note } : {})
    }
  }

  if (activity.kind === 'conversation') {
    return {
      id: `maestro:${activity.projectId}`,
      projectId: activity.projectId,
      role: 'maestro',
      roleLabel: 'Maestro',
      label: 'analisando e respondendo sua solicitação',
      detail: 'coordenando o projeto pelo painel do Maestro',
      tone: 'running',
      updatedAt: activity.updatedAt,
      ...(activity.note ? { note: activity.note } : {})
    }
  }

  const maestroBlock = missions.find(
    (mission) => mission.state === 'blocked' && mission.queue?.owner === 'maestro'
  )
  const integrating = missions.find((mission) =>
    mission.state === 'integrating' || mission.state === 'syncing' || mission.state === 'queued'
  )
  const label = maestroBlock
    ? 'decidindo como resolver uma integração bloqueada'
    : integrating
      ? 'coordenando a integração das missões'
      : missions.length > 0
        ? 'acompanhando o projeto e suas missões'
        : 'analisando o projeto'
  const detail = maestroBlock?.title ?? integrating?.title
  return {
    id: `maestro:${activity.projectId}`,
    projectId: activity.projectId,
    role: 'maestro',
    roleLabel: 'Maestro',
    label,
    ...(detail ? { detail } : {}),
    tone: 'running',
    updatedAt: activity.updatedAt,
    ...(activity.note ? { note: activity.note } : {})
  }
}

function generalWorkSnapshot(
  projectId: string,
  allTasks: readonly Task[],
  notes: readonly ProgressPaneNoteInput[] = []
): ProgressMissionSnapshot | undefined {
  const workTasks = allTasks.filter((task) => task.kind !== 'plan')
  if (!workTasks.some(activeCard)) return undefined
  const updatedAt = workTasks
    .map((task) => task.updatedAt)
    .sort((a, b) => b.localeCompare(a))[0] ?? new Date().toISOString()
  const synthetic = missionSnapshot(
    {
      id: `general:${projectId}`,
      projectId,
      title: 'Trabalho geral',
      status: 'ativa',
      createdAt: updatedAt,
      updatedAt
    },
    workTasks,
    undefined,
    notes
  )
  return { ...synthetic, kind: 'general' }
}

function projectState(
  missing: boolean,
  missions: readonly ProgressMissionSnapshot[],
  activeCoordinators = 0,
  hasQuestion = false
): Pick<ProgressProjectSnapshot, 'state' | 'tone' | 'label'> {
  if (missing) return { state: 'attention', tone: 'attention', label: 'pasta não encontrada' }
  // pergunta do PM esperando o dono: nada é mais urgente que uma decisão parada
  if (hasQuestion || missions.some((mission) => mission.question)) {
    return { state: 'attention', tone: 'attention', label: 'pergunta esperando você' }
  }
  if (missions.some((mission) => ATTENTION_STATES.has(mission.state))) {
    return { state: 'attention', tone: 'attention', label: 'precisa de atenção' }
  }
  if (missions.some((mission) => mission.state === 'integrating')) {
    return { state: 'integrating', tone: 'running', label: 'integrando missão' }
  }
  if (missions.some((mission) => RUNNING_STATES.has(mission.state))) {
    return { state: 'running', tone: 'running', label: 'em andamento' }
  }
  if (activeCoordinators > 0) {
    return { state: 'running', tone: 'running', label: 'coordenação em atividade' }
  }
  if (missions.length > 0) {
    return { state: 'planning', tone: 'waiting', label: 'missões em preparação' }
  }
  return { state: 'idle', tone: 'idle', label: 'sem missão em andamento' }
}

/** Atualiza somente os pulsos vivos de coordenação sobre um snapshot já
 * sanitizado. Assim o TUI pode mover trabalhando → aguardando em tempo real
 * sem reler planos do disco nem executar Git a cada frame de terminal. */
export function applyProgressCoordinatorActivity(
  snapshot: ProgressOverlaySnapshot,
  activity: readonly ProgressCoordinatorActivityInput[],
  revision: number,
  now: string | Date = new Date()
): ProgressOverlaySnapshot {
  const projects = snapshot.projects.map((project): ProgressProjectSnapshot => {
    const coordinators = activity
      .filter((candidate) => candidate.projectId === project.id)
      .map((candidate) => coordinatorSnapshot(candidate, project.activeMissions))
      .filter((candidate): candidate is ProgressCoordinatorSnapshot => Boolean(candidate))
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'orchestrator' ? -1 : 1
        return b.updatedAt.localeCompare(a.updatedAt)
      })
    return {
      ...project,
      ...projectState(
        project.missing,
        project.activeMissions,
        coordinators.length,
        Boolean(project.question)
      ),
      coordinators
    }
  }).sort((a, b) => {
    const state = PROJECT_STATE_ORDER[a.state] - PROJECT_STATE_ORDER[b.state]
    return state || a.name.localeCompare(b.name, 'pt-BR')
  })
  const activeCoordinators = projects.reduce(
    (sum, project) => sum + project.coordinators.length,
    0
  )
  const attentionProjects = projects.filter((project) => project.missing).length
  return {
    ...snapshot,
    revision: Math.max(0, Math.trunc(revision)),
    generatedAt: safeDate(now).toISOString(),
    totals: {
      ...snapshot.totals,
      activeProjects: projects.filter(
        (project) => project.state !== 'idle' && project.state !== 'completed'
      ).length,
      activeCoordinators,
      attentionProjects
    },
    projects
  }
}

export function buildProgressSnapshot(input: ProgressSnapshotInput): ProgressOverlaySnapshot {
  const now = safeDate(input.now)
  const generatedAt = now.toISOString()
  const recentDays = Math.max(1, Math.min(90, input.recentCompletionDays ?? 7))
  const recentCutoff = now.getTime() - recentDays * 24 * 60 * 60 * 1000
  const missingIds = new Set(input.missingProjectIds ?? [])
  const queueByMission = new Map(input.integrationQueue.map((ticket) => [ticket.missionId, ticket]))

  const result = input.projects.map((project): ProgressProjectSnapshot => {
    const projectMissions = input.missions.filter((mission) => mission.projectId === project.id)
    const projectNotes = (input.paneNotes ?? []).filter(
      (note) => note.projectId === project.id
    )
    const projectQuestions = (input.pendingQuestions ?? []).filter(
      (question) => question.projectId === project.id
    )
    const generalQuestion = projectQuestions.find((question) => question.missionKey === 'geral')
    const missionSnapshots = projectMissions
      .filter((mission) => mission.status !== 'arquivada')
      .map((mission) => missionSnapshot(
        mission,
        input.tasks.filter(
          (task) => task.projectId === project.id && task.missionId === mission.id
        ),
        queueByMission.get(mission.id),
        projectNotes,
        projectQuestions.find((question) => question.missionKey === mission.id)?.question
      ))
    const general = generalWorkSnapshot(
      project.id,
      input.tasks.filter((task) => task.projectId === project.id && !task.missionId),
      projectNotes
    )
    const snapshots = general ? [...missionSnapshots, general] : missionSnapshots
    const activeMissions = snapshots
      .filter((mission) => mission.state !== 'completed')
      .sort((a, b) => {
        const state = MISSION_STATE_ORDER[a.state] - MISSION_STATE_ORDER[b.state]
        return state || b.updatedAt.localeCompare(a.updatedAt)
      })
    const recentCompletions = snapshots
      .filter(
        (mission) =>
          mission.state === 'completed' &&
          safeDate(mission.completedAt ?? mission.updatedAt).getTime() >= recentCutoff
      )
      .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))
      .slice(0, 5)
    const coordinators = (input.coordinatorActivity ?? [])
      .filter((activity) => activity.projectId === project.id)
      .map((activity) => coordinatorSnapshot(activity, activeMissions))
      .filter((activity): activity is ProgressCoordinatorSnapshot => Boolean(activity))
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'orchestrator' ? -1 : 1
        return b.updatedAt.localeCompare(a.updatedAt)
      })
    const status = projectState(
      missingIds.has(project.id),
      activeMissions,
      coordinators.length,
      Boolean(generalQuestion)
    )
    return {
      id: project.id,
      name: project.name,
      mode: project.mode,
      missing: missingIds.has(project.id),
      ...status,
      coordinators,
      activeMissions,
      recentCompletions,
      ...(generalQuestion ? { question: generalQuestion.question } : {})
    }
  }).sort((a, b) => {
    const state = PROJECT_STATE_ORDER[a.state] - PROJECT_STATE_ORDER[b.state]
    return state || a.name.localeCompare(b.name, 'pt-BR')
  })

  const activeMissions = result.reduce((sum, project) => sum + project.activeMissions.length, 0)
  const activeCards = result.reduce(
    (sum, project) =>
      sum + project.activeMissions.reduce((projectSum, mission) => projectSum + mission.progress.active, 0),
    0
  )
  const activeCoordinators = result.reduce(
    (sum, project) => sum + project.coordinators.length,
    0
  )
  const attentionMissions = result.reduce(
    (sum, project) =>
      sum + project.activeMissions.filter((mission) => ATTENTION_STATES.has(mission.state)).length,
    0
  )
  const attentionProjects = result.filter((project) => project.missing).length
  const recentCompletions = result.reduce(
    (sum, project) => sum + project.recentCompletions.length,
    0
  )

  return {
    revision: Math.max(0, Math.trunc(input.revision ?? 0)),
    generatedAt,
    totals: {
      projects: result.length,
      activeProjects: result.filter(
        (project) => project.state !== 'idle' && project.state !== 'completed'
      ).length,
      activeMissions,
      activeCards,
      activeCoordinators,
      attentionMissions,
      attentionProjects,
      recentCompletions
    },
    projects: result
  }
}

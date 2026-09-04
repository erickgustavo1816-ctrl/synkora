import type { IntegrationQueueTicketView } from './integrationQueue'
import type { Mission } from './missions'
import type { Project } from './projects'
import type { GuiProgressInput, GuiProgressPendingKind, GuiProgressHelpers } from './guiProgress'

export type ProgressTone = 'attention' | 'running' | 'waiting' | 'success' | 'idle'
export type ProgressGroup = 'attention' | 'working' | 'delivery' | 'idle'
export type ProgressCoordinatorRole = 'maestro' | 'orchestrator'
export type ProgressCoordinatorActivityKind = 'terminal' | 'conversation' | 'survey'
export type MissionProgressState =
  | 'planning' | 'starting' | 'awaiting_approval' | 'paused' | 'implementing'
  | 'reviewing' | 'qa' | 'interrupted' | 'finalizing' | 'ready_to_integrate'
  | 'queued' | 'syncing' | 'blocked' | 'integrating' | 'completed'
  | 'working' | 'waiting_user' | 'idle' | 'turn_finished' | 'error' | 'sync_required'
export type ProjectProgressState = 'attention' | 'integrating' | 'running' | 'planning' | 'completed' | 'idle'

/** Retired inputs retained for old callers only; never used by the GUI projection. */
export interface ProgressPaneNoteInput {
  projectId: string; missionId?: string; taskId?: string; phase?: 'dev' | 'review' | 'qa'
  role: string; text: string; at: string
}
export interface ProgressQuestionInput { projectId: string; missionKey: string; question: string; at: string }
export interface ProgressCoordinatorActivityInput {
  projectId: string; missionId?: string; role: ProgressCoordinatorRole
  kind?: ProgressCoordinatorActivityKind; working: boolean; updatedAt: string; note?: string
}
export interface ProgressCoordinatorSnapshot {
  id: string; projectId: string; missionId?: string; role: ProgressCoordinatorRole
  roleLabel: string; label: string; detail?: string; tone: 'running'; updatedAt: string; note?: string
}
/** Main-owned DTO; src/preload/index.ts reexports it through type-only imports. */
export interface ProgressMissionSnapshot {
  id: string
  projectId: string
  title: string
  kind?: 'mission' | 'general'
  state: MissionProgressState
  group: ProgressGroup
  tone: ProgressTone
  label: string
  detail?: string
  updatedAt: string
  completedAt?: string
  paneId?: string
  sessionCount: number
  workingSessions: number
  pendingCount: number
  pendingKind?: GuiProgressPendingKind
  activityAt?: string
  helpers?: GuiProgressHelpers
  queue?: {
    state: IntegrationQueueTicketView['state']
    position: number
    total: number
    owner?: 'maestro' | 'orchestrator'
  }
  /** Deprecated and intentionally never populated. */
  question?: string
}
export interface ProgressProjectSnapshot {
  id: string; name: string; mode?: Project['mode']; missing: boolean
  state: ProjectProgressState; group: ProgressGroup; tone: ProgressTone; label: string
  coordinators: ProgressCoordinatorSnapshot[]
  activeMissions: ProgressMissionSnapshot[]
  recentCompletions: ProgressMissionSnapshot[]
  question?: string
}
export interface ProgressOverlaySnapshot {
  revision: number
  generatedAt: string
  totals: {
    projects: number; activeProjects: number; activeMissions: number; activeCoordinators: number
    attentionMissions: number; workingMissions: number; deliveryMissions: number; idleMissions: number
    attentionProjects: number; recentCompletions: number
  }
  projects: ProgressProjectSnapshot[]
}
export interface ProgressSnapshotInput {
  projects: readonly Project[]
  missions: readonly Mission[]
  integrationQueue: readonly IntegrationQueueTicketView[]
  guiSessions?: readonly GuiProgressInput[]
  missingProjectIds?: readonly string[]
  coordinatorActivity?: readonly ProgressCoordinatorActivityInput[]
  paneNotes?: readonly ProgressPaneNoteInput[]
  pendingQuestions?: readonly ProgressQuestionInput[]
  revision?: number; now?: string | Date; recentCompletionDays?: number
}

const GROUP_ORDER: Record<ProgressGroup, number> = { attention: 0, working: 1, delivery: 2, idle: 3 }
const PENDING_ORDER: Record<GuiProgressPendingKind, number> = { permission: 0, question: 1, 'plan-review': 2, 'plan-proposal': 3 }
function safeDate(value: string | Date | undefined): Date {
  const parsed = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isFinite(parsed.getTime()) ? parsed : new Date()
}
function paneMatchesMission(paneId: string, missionId: string): boolean {
  // Same constructors as guiMissionContracts. Exact suffixes avoid binding a
  // forged/ambiguous address to a different conversation.
  const short = missionId.slice(0, 8)
  if (paneId === `gui-dev-${short}` || paneId === `gui-reviewer-${short}`) return true
  const prefix = `gui-helper-${short}-`
  return paneId.startsWith(prefix) && /^[1-9]\d*$/.test(paneId.slice(prefix.length))
}
function sessionPriority(pane: GuiProgressInput): number {
  if (pane.pendingCount > 0) return pane.state === 'waiting_user' ? 0 : 1
  if (pane.state === 'error' || pane.state === 'interrupted') return 2
  if (pane.state === 'working') return 3
  if (pane.state === 'turn_finished') return 4
  return 5
}
function sortedSessions(panes: readonly GuiProgressInput[]): GuiProgressInput[] {
  return [...panes].sort((a, b) => sessionPriority(a) - sessionPriority(b)
    || (PENDING_ORDER[a.pendingKind ?? 'plan-proposal'] - PENDING_ORDER[b.pendingKind ?? 'plan-proposal'])
    || (b.activityAt ?? '').localeCompare(a.activityAt ?? '') || a.paneId.localeCompare(b.paneId))
}
function sessionFields(panes: readonly GuiProgressInput[]): Pick<ProgressMissionSnapshot,
  'paneId' | 'sessionCount' | 'workingSessions' | 'pendingCount' | 'pendingKind' | 'activityAt' | 'helpers'> {
  const priority = sortedSessions(panes)[0]
  const activityAt = panes.map((pane) => pane.activityAt).filter((at): at is string => Boolean(at)).sort().at(-1)
  const measuredHelpers = panes.filter((pane) => pane.helpers)
  return {
    ...(priority ? { paneId: priority.paneId } : {}),
    sessionCount: panes.length,
    workingSessions: panes.filter((pane) => pane.state === 'working').length,
    pendingCount: panes.reduce((sum, pane) => sum + pane.pendingCount, 0),
    ...(priority?.pendingKind ? { pendingKind: priority.pendingKind } : {}),
    ...(activityAt ? { activityAt } : {}),
    ...(measuredHelpers.length ? { helpers: measuredHelpers.reduce((sum, pane) => ({
      running: sum.running + (pane.helpers?.running ?? 0),
      interrupted: sum.interrupted + (pane.helpers?.interrupted ?? 0),
      failed: sum.failed + (pane.helpers?.failed ?? 0)
    }), { running: 0, interrupted: 0, failed: 0 }) } : {})
  }
}
type Status = Pick<ProgressMissionSnapshot, 'state' | 'group' | 'tone' | 'label' | 'detail'>
function runtimeStatus(panes: readonly GuiProgressInput[]): Status {
  const pane = sortedSessions(panes)[0]
  if (!pane) return { state: 'idle', group: 'idle', tone: 'idle', label: 'sem conversa em execução', detail: 'nenhum turno GUI observado' }
  if (pane.pendingCount > 0) {
    const labels: Record<GuiProgressPendingKind, string> = {
      permission: 'permissão pendente', question: 'pergunta esperando você',
      'plan-review': 'plano para revisar', 'plan-proposal': 'proposta de plano pendente'
    }
    return { state: pane.state, group: 'attention', tone: 'attention',
      label: labels[pane.pendingKind ?? 'question'],
      detail: pane.state === 'working' ? 'a conversa continua trabalhando' : pane.state === 'waiting_user' ? 'o turno aguarda sua resposta' : 'abra a conversa para decidir' }
  }
  switch (pane.state) {
    case 'error': return { state: 'error', group: 'attention', tone: 'attention', label: 'falha na conversa', detail: 'abra a conversa para verificar' }
    case 'interrupted': return { state: 'interrupted', group: 'attention', tone: 'attention', label: 'turno interrompido', detail: 'a missão permanece aberta' }
    case 'working': return { state: 'working', group: 'working', tone: 'running', label: 'trabalhando', detail: 'agente em execução' }
    case 'waiting_user': return { state: 'waiting_user', group: 'attention', tone: 'attention', label: 'aguardando você', detail: 'abra a conversa para continuar' }
    default: break
  }
  if (panes.some((item) => (item.helpers?.running ?? 0) > 0)) return { state: 'working', group: 'working', tone: 'running', label: 'ajudantes trabalhando', detail: 'execução confirmada pelo motor de ajudantes' }
  if (pane.state === 'turn_finished') return { state: 'turn_finished', group: 'idle', tone: 'idle', label: 'resposta pronta', detail: 'o turno terminou; a missão permanece aberta' }
  if (pane.state === 'starting') return { state: 'starting', group: 'idle', tone: 'waiting', label: 'abrindo conversa', detail: 'ainda sem turno em execução' }
  return { state: 'idle', group: 'idle', tone: 'idle', label: 'conversa parada', detail: 'aguardando um novo turno' }
}
function missionSnapshot(mission: Mission, ticket: IntegrationQueueTicketView | undefined, panes: readonly GuiProgressInput[]): ProgressMissionSnapshot {
  if (mission.status === 'concluida') return {
    id: mission.id, projectId: mission.projectId, title: mission.title, kind: 'mission',
    state: 'completed', group: 'delivery', tone: 'success', label: 'concluída',
    updatedAt: mission.updatedAt, completedAt: mission.completedAt ?? mission.updatedAt,
    sessionCount: 0, workingSessions: 0, pendingCount: 0
  }
  const fields = sessionFields(panes)
  const runtime = runtimeStatus(panes)
  let status = runtime
  // Human attention in any conversation must remain visible even during delivery.
  if (runtime.group !== 'attention') {
    if (ticket?.state === 'blocked') status = { state: 'blocked', group: 'attention', tone: 'attention', label: 'integração bloqueada', detail: 'abra a fila para verificar o impedimento' }
    else if (ticket?.state === 'sync_required') status = { state: 'sync_required', group: 'attention', tone: 'attention', label: 'precisa sincronizar para integrar', detail: 'a fila aguarda a atualização com a base' }
    else if (ticket?.state === 'merging' || mission.status === 'integrando') status = { state: 'integrating', group: 'delivery', tone: 'running', label: 'integrando agora', detail: 'aplicando a missão ao projeto' }
    else if (ticket?.state === 'queued') status = { state: 'queued', group: 'delivery', tone: 'waiting', label: `na fila · ${ticket.position} de ${ticket.total}`, detail: ticket.isHead ? 'é a próxima a integrar' : 'aguardando as missões anteriores' }
    else if (mission.pendingIntegrationApproval) status = { state: 'ready_to_integrate', group: 'attention', tone: 'attention', label: 'pronta para integrar', detail: 'aguardando sua aprovação de integração' }
  }
  return {
    id: mission.id, projectId: mission.projectId, title: mission.title, kind: 'mission',
    ...status, ...fields,
    updatedAt: fields.activityAt && fields.activityAt > mission.updatedAt ? fields.activityAt : mission.updatedAt,
    ...(ticket ? { queue: { state: ticket.state, position: ticket.position, total: ticket.total,
      ...(ticket.block?.owner ? { owner: ticket.block.owner } : {}) } } : {})
  }
}
function projectStatus(missing: boolean, rows: readonly ProgressMissionSnapshot[]): Pick<ProgressProjectSnapshot, 'state' | 'group' | 'tone' | 'label'> {
  if (missing) return { state: 'attention', group: 'attention', tone: 'attention', label: 'pasta não encontrada' }
  if (rows.some((row) => row.group === 'attention')) return { state: 'attention', group: 'attention', tone: 'attention', label: 'precisa de atenção' }
  if (rows.some((row) => row.group === 'working')) return { state: 'running', group: 'working', tone: 'running', label: 'trabalhando' }
  if (rows.some((row) => row.group === 'delivery')) return { state: rows.some((row) => row.state === 'integrating') ? 'integrating' : 'planning', group: 'delivery', tone: 'waiting', label: 'entregas para acompanhar' }
  return { state: 'idle', group: 'idle', tone: 'idle', label: rows.length ? 'sem turno em execução' : 'sem missão em andamento' }
}
/** Compatibility only: retired coordinator pulses cannot change GUI progress. */
export function applyProgressCoordinatorActivity(snapshot: ProgressOverlaySnapshot, _activity: readonly ProgressCoordinatorActivityInput[], revision: number, now: string | Date = new Date()): ProgressOverlaySnapshot {
  return { ...snapshot, revision: Math.max(0, Math.trunc(revision)), generatedAt: safeDate(now).toISOString() }
}
export function buildProgressSnapshot(input: ProgressSnapshotInput): ProgressOverlaySnapshot {
  const now = safeDate(input.now)
  const recentCutoff = now.getTime() - Math.max(1, Math.min(90, input.recentCompletionDays ?? 7)) * 86_400_000
  const missingIds = new Set(input.missingProjectIds ?? [])
  const rawPanes = input.guiSessions ?? []
  // A live pane belongs to exactly one registry entry; reject duplicate input.
  const panes = rawPanes.filter((pane) => rawPanes.filter((other) => other.paneId === pane.paneId).length === 1)
  const projects = input.projects.map((project): ProgressProjectSnapshot => {
    const missions = input.missions.filter((mission) => mission.projectId === project.id)
    const projectPanes = panes.filter((pane) => pane.projectId === project.id)
    const rows = missions.filter((mission) => mission.status !== 'arquivada').map((mission) => {
      const boundPanes = projectPanes.filter((pane) => paneMatchesMission(pane.paneId, mission.id)
        && missions.filter((candidate) => paneMatchesMission(pane.paneId, candidate.id)).length === 1)
      const tickets = input.integrationQueue.filter((ticket) => ticket.projectId === project.id && ticket.missionId === mission.id)
      return missionSnapshot(mission, tickets.length === 1 ? tickets[0] : undefined, boundPanes)
    })
    const activeMissions = rows.filter((row) => row.state !== 'completed')
    const generalPanes = projectPanes.filter((pane) => pane.paneId === `gui-plan-${project.id.slice(0, 8)}`)
    if (generalPanes.length) activeMissions.push({
      id: `general:${project.id}`, projectId: project.id, kind: 'general', title: 'Planejamento do projeto',
      ...runtimeStatus(generalPanes), ...sessionFields(generalPanes),
      updatedAt: sessionFields(generalPanes).activityAt ?? project.createdAt
    })
    activeMissions.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    const recentCompletions = rows.filter((row) => row.state === 'completed' && safeDate(row.completedAt ?? row.updatedAt).getTime() >= recentCutoff)
      .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)).slice(0, 5)
    return { id: project.id, name: project.name, mode: project.mode, missing: missingIds.has(project.id),
      ...projectStatus(missingIds.has(project.id), activeMissions), coordinators: [], activeMissions, recentCompletions }
  }).sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.name.localeCompare(b.name, 'pt-BR'))
  const missions = projects.flatMap((project) => project.activeMissions).filter((row) => row.kind !== 'general')
  return {
    revision: Math.max(0, Math.trunc(input.revision ?? 0)), generatedAt: now.toISOString(),
    totals: {
      projects: projects.length, activeProjects: projects.filter((project) => project.activeMissions.length > 0).length,
      activeMissions: missions.length, activeCoordinators: 0,
      attentionMissions: missions.filter((row) => row.group === 'attention').length,
      workingMissions: missions.filter((row) => row.group === 'working').length,
      deliveryMissions: missions.filter((row) => row.group === 'delivery').length,
      idleMissions: missions.filter((row) => row.group === 'idle').length,
      attentionProjects: projects.filter((project) => project.group === 'attention').length,
      recentCompletions: projects.reduce((sum, project) => sum + project.recentCompletions.length, 0)
    }, projects
  }
}

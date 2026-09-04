import type {
  ProgressGroup,
  ProgressMissionSnapshot,
  ProgressOpenTarget,
  ProgressOverlaySnapshot,
  ProgressProjectSnapshot
} from '../../preload/index'

export type ProgressFilter = 'all' | ProgressGroup
export const PROGRESS_FILTERS: { id: ProgressFilter; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'attention', label: 'Atenção' },
  { id: 'working', label: 'Trabalhando' },
  { id: 'delivery', label: 'Entrega' },
  { id: 'idle', label: 'Paradas' }
]
const GROUP_ORDER: Record<ProgressGroup, number> = { attention: 0, working: 1, delivery: 2, idle: 3 }
export const EMPTY_PROGRESS_TOTALS: ProgressOverlaySnapshot['totals'] = {
  projects: 0, activeProjects: 0, activeMissions: 0, activeCoordinators: 0,
  attentionMissions: 0, attentionProjects: 0, workingMissions: 0,
  deliveryMissions: 0, idleMissions: 0, recentCompletions: 0
}
export const EMPTY_PROGRESS_SNAPSHOT: ProgressOverlaySnapshot = {
  revision: 0, generatedAt: new Date(0).toISOString(), totals: EMPTY_PROGRESS_TOTALS, projects: []
}

export function progressEntryKey(projectId: string, mission: ProgressMissionSnapshot): string {
  return JSON.stringify([projectId, mission.kind ?? 'mission', mission.id])
}

export function progressTarget(mission: ProgressMissionSnapshot): ProgressOpenTarget {
  const base = { projectId: mission.projectId, ...(mission.kind === 'general' ? {} : { missionId: mission.id }) }
  // Historical missions have no live conversation. The app resolves their saved
  // mission context, falling back to their own project if it is no longer present.
  if (mission.state === 'completed' || mission.kind === 'general') return { ...base, destination: 'project' }
  if (mission.paneId && mission.pendingCount > 0) return { ...base, paneId: mission.paneId, destination: 'chat' }
  if (mission.queue || mission.group === 'delivery' || mission.state === 'ready_to_integrate') return { ...base, destination: 'delivery' }
  if (mission.paneId) return { ...base, paneId: mission.paneId, destination: 'chat' }
  return { ...base, destination: 'project' }
}

export function progressAction(mission: ProgressMissionSnapshot): string {
  if (mission.state === 'completed') return 'Ver no projeto'
  const target = progressTarget(mission)
  if (target.destination === 'delivery') return 'Ver entrega'
  if (target.destination === 'chat') return mission.pendingCount > 0 ? 'Ver pendência no chat' : 'Abrir conversa'
  return mission.kind === 'general' ? 'Abrir projeto' : 'Abrir missão'
}

function searchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
}

/** Counts are exclusive mission groups. General planning is visible separately,
 * and duplicate identities never inflate counts or create duplicate cards. */
export function progressView(
  snapshot: ProgressOverlaySnapshot,
  filter: ProgressFilter = 'all',
  projectId = '',
  query = ''
): {
  projects: ProgressProjectSnapshot[]
  counts: Record<ProgressFilter, number>
  generalCounts: Record<ProgressFilter, number>
  totalRows: number
} {
  const counts = { all: 0, attention: 0, working: 0, delivery: 0, idle: 0 }
  const generalCounts = { ...counts }
  const seen = new Set<string>()
  const needle = searchText(query.trim())
  let totalRows = 0
  const projects = snapshot.projects.flatMap((project) => {
    const rows = project.activeMissions.filter((mission) => {
      const key = progressEntryKey(project.id, mission)
      if (seen.has(key) || mission.state === 'completed') return false
      seen.add(key)
      totalRows++
      return true
    }).sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || b.pendingCount - a.pendingCount || a.title.localeCompare(b.title, 'pt-BR'))
    const scoped = rows.filter((mission) => (!projectId || project.id === projectId) &&
      (!needle || searchText(`${project.name} ${mission.title}`).includes(needle)))
    for (const mission of scoped) {
      const bucket = mission.kind === 'general' ? generalCounts : counts
      bucket.all++
      bucket[mission.group]++
    }
    const activeMissions = scoped.filter((mission) => filter === 'all' || mission.group === filter)
    const visibleProjectAttention = project.missing && (filter === 'all' || filter === 'attention') &&
      (!projectId || project.id === projectId) && (!needle || searchText(project.name).includes(needle))
    return activeMissions.length || visibleProjectAttention ? [{ ...project, activeMissions }] : []
  }).sort((a, b) => (a.missing ? 0 : GROUP_ORDER[a.activeMissions[0].group]) -
    (b.missing ? 0 : GROUP_ORDER[b.activeMissions[0].group]) || a.name.localeCompare(b.name, 'pt-BR'))
  return { projects, counts, generalCounts, totalRows }
}

export function progressFocus(snapshot: ProgressOverlaySnapshot): { project: ProgressProjectSnapshot; mission: ProgressMissionSnapshot | null } | null {
  const project = progressView(snapshot).projects[0]
  return project ? { project, mission: project.activeMissions[0] ?? null } : null
}

export function progressSignalLabel(iso: string | undefined, nowMs: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return 'sem sinal de conversa'
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000))
  if (seconds < 60) return `há ${seconds}s`
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`
  return `há ${Math.floor(seconds / 86400)} d`
}

/** Push subscriptions and the initial request race. A repeated/older revision
 * must never replace a pushed state, including a late initial response. */
export function createProgressRevisionGate(): (snapshot: ProgressOverlaySnapshot) => boolean {
  let accepted = Number.NEGATIVE_INFINITY
  return (snapshot) => {
    if (!Number.isFinite(snapshot.revision) || snapshot.revision <= accepted) return false
    accepted = snapshot.revision
    return true
  }
}

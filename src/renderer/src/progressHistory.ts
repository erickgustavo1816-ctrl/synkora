import type {
  ProgressMissionSnapshot,
  ProgressOverlaySnapshot,
  ProgressProjectSnapshot
} from '../../preload/index'

export interface ProgressCompletionEntry {
  project: ProgressProjectSnapshot
  mission: ProgressMissionSnapshot
}

export interface ProgressCompletionFeed {
  items: ProgressCompletionEntry[]
  hiddenCount: number
}

function completionTime(mission: ProgressMissionSnapshot): number {
  const value = Date.parse(mission.completedAt ?? mission.updatedAt)
  return Number.isFinite(value) ? value : 0
}

/**
 * A limpeza e apenas visual: um corte temporal esconde entregas ja vistas sem
 * apagar missoes nem impedir que conclusoes novas aparecam no radar.
 */
export function progressCompletionFeed(
  snapshot: ProgressOverlaySnapshot,
  clearedAt: string | null,
  limit = 3
): ProgressCompletionFeed {
  const parsedCutoff = clearedAt ? Date.parse(clearedAt) : Number.NaN
  const cutoff = Number.isFinite(parsedCutoff) ? parsedCutoff : Number.NEGATIVE_INFINITY
  const seen = new Set<string>()
  const all = snapshot.projects
    .flatMap((project) =>
      project.recentCompletions.map((mission) => ({ project, mission }))
    )
    .filter(({ project, mission }) => {
      const key = JSON.stringify([project.id, mission.kind ?? 'mission', mission.id])
      if (seen.has(key) || completionTime(mission) <= cutoff) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => completionTime(b.mission) - completionTime(a.mission))
  const safeLimit = Math.max(0, Math.trunc(limit))
  return {
    items: all.slice(0, safeLimit),
    hiddenCount: Math.max(0, all.length - safeLimit)
  }
}

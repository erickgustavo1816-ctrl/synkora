import type {
  MissionCommit,
  MissionCommitDiffResult,
  MissionCommitsResult
} from '../../preload/index'

interface MissionHistoryBridge {
  commits: (missionId: string) => Promise<MissionCommitsResult>
  commitDiff: (missionId: string, commitSha: string) => Promise<MissionCommitDiffResult>
}

function bridge(): Partial<MissionHistoryBridge> | undefined {
  return (window as unknown as { synkora?: { missions?: Partial<MissionHistoryBridge> } })
    .synkora?.missions
}

const NO_BRIDGE =
  'reinicie o app (npm run dev) para ver o histórico desta missão — esta janela ainda não tem a ponte'

function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/iu.test(value)
}

function normalizeCommit(value: unknown): MissionCommit | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<MissionCommit>
  if (!isFullSha(candidate.sha) || typeof candidate.subject !== 'string' || typeof candidate.at !== 'string')
    return undefined
  if (!Array.isArray(candidate.parents) || candidate.parents.some((parent) => !isFullSha(parent)))
    return undefined
  const parents = candidate.parents
  return {
    sha: candidate.sha,
    parents,
    subject: candidate.subject,
    at: candidate.at,
    ...(typeof candidate.author === 'string' && candidate.author ? { author: candidate.author } : {})
  }
}

function normalizeCommits(raw: unknown): MissionCommitsResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: NO_BRIDGE }
  const candidate = raw as MissionCommitsResult
  if (!candidate.ok) return { ok: false, error: candidate.error ?? 'não deu para ler o histórico' }
  const commits = Array.isArray(candidate.commits)
    ? candidate.commits.map(normalizeCommit).filter((commit): commit is MissionCommit => Boolean(commit))
    : []
  return { ok: true, commits }
}

function normalizePatch(raw: unknown): MissionCommitDiffResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: NO_BRIDGE }
  const candidate = raw as MissionCommitDiffResult
  if (!candidate.ok) return { ok: false, error: candidate.error ?? 'não deu para ler o patch deste commit' }
  return {
    ok: true,
    ...(isFullSha(candidate.sha) ? { sha: candidate.sha } : {}),
    ...(typeof candidate.diff === 'string' ? { diff: candidate.diff } : {}),
    ...(candidate.truncated === true ? { truncated: true } : {})
  }
}

export const missionHistory = {
  available(): boolean {
    const api = bridge()
    return typeof api?.commits === 'function' && typeof api?.commitDiff === 'function'
  },

  async commits(missionId: string): Promise<MissionCommitsResult> {
    const api = bridge()
    if (typeof api?.commits !== 'function') return { ok: false, error: NO_BRIDGE }
    try {
      return normalizeCommits(await api.commits(missionId))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async commitDiff(missionId: string, commitSha: string): Promise<MissionCommitDiffResult> {
    const api = bridge()
    if (typeof api?.commitDiff !== 'function') return { ok: false, error: NO_BRIDGE }
    // Do not send a short/unknown identifier even if a stale UI somehow has
    // one; the main is authoritative and also repeats this guard.
    if (!isFullSha(commitSha)) return { ok: false, error: 'o commit precisa ser identificado pelo SHA completo' }
    try {
      return normalizePatch(await api.commitDiff(missionId, commitSha))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export type { MissionCommit }

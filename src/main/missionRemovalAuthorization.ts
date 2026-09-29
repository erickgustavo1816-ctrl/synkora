import { randomUUID } from 'crypto'
import type { MissionRemovalConfirmation, MissionRemovalDiscard } from '../shared/missionRemoval'

interface DiscardGrant extends MissionRemovalDiscard {
  identity: string
  snapshot: string
  expiresAt: number
}

export class MissionRemovalAuthorization {
  private readonly grants = new Map<string, DiscardGrant>()

  offer(missionId: string, title: string, identity: string, snapshot: string): MissionRemovalDiscard {
    const now = Date.now()
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id)
    const token = randomUUID()
    this.grants.set(missionId, { token, title, identity, snapshot, expiresAt: now + 10 * 60_000 })
    return { token, title }
  }

  consume(missionId: string, value: unknown, identity: string, snapshot: string): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const request = value as Partial<MissionRemovalConfirmation>
    if (Object.keys(request).length !== 2 || typeof request.discardToken !== 'string' ||
      typeof request.confirmTitle !== 'string') return false
    const grant = this.grants.get(missionId)
    if (!grant || grant.token !== request.discardToken || grant.title !== request.confirmTitle ||
      grant.identity !== identity || grant.snapshot !== snapshot || grant.expiresAt <= Date.now()) return false
    this.grants.delete(missionId)
    return true
  }

  clear(missionId: string): void { this.grants.delete(missionId) }
}

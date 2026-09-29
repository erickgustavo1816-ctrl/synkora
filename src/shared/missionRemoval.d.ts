export interface MissionRemovalDiscard { token: string; title: string }
export interface MissionRemovalConfirmation { discardToken: string; confirmTitle: string }
export type MissionRemovalResult = { ok: true } | { ok: false; error: string; discard?: MissionRemovalDiscard }

import { relative } from 'node:path'
import { guiMissionPaneId } from './guiMissionContracts'
import { releaseIdentityError, type ReleaseIdentityInput } from './releaseChangesScope'

export interface ReleaseConversationInput extends ReleaseIdentityInput {
  identity: ReleaseIdentityInput['identity'] & { paneId: string; cwd?: string }
  live?: ReleaseConversationInput['identity']
  mission?: NonNullable<ReleaseIdentityInput['mission']> & { direct?: boolean }
}

export function releaseConversationError(input: ReleaseConversationInput): string | undefined {
  const error = releaseIdentityError(input)
  if (error) return error
  const { identity, live, mission, project } = input
  if (!live || live.paneId !== identity.paneId || live.role !== identity.role ||
    live.projectId !== identity.projectId || live.missionId !== identity.missionId || live.cwd !== identity.cwd ||
    !mission?.direct || identity.paneId !== guiMissionPaneId('dev', mission.id) ||
    !project || !identity.cwd || relative(project.path, identity.cwd) !== '')
    return 'Identidade ou pasta da Release inválida. Reabra a conversa da versão no Synkora e leia release_status.'
  return undefined
}

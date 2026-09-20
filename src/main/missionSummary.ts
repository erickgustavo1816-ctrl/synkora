import type { Mission, MissionStore } from './missions'
import { guiMissionPaneId, missionTypeOf } from './guiMissionContracts'
import { redactSensitiveText } from './securityRedaction'

export const MISSION_SUMMARY_MAX = 600

interface SummaryIdentity {
  role: string
  paneId: string
  projectId: string
  missionId?: string
}

interface MissionSummaryDeps {
  missions: Pick<MissionStore, 'get' | 'update'>
  reconcile(mission: Mission): boolean
  changed(projectId: string): void
  audit(mission: Mission): void
}

interface SummaryResult { ok: boolean; text: string }

const summaryRecipe = 'Escreva um resumo em PT-BR, com duas ou três frases curtas sobre o que foi resolvido para quem usa o produto, sem jargão técnico (até 600 caracteres). Salve com mission_summary { summary } ou envie em integration_run { summary }.'

/** Agent-authored product notes; Git delivery evidence remains independent. */
export function buildMissionSummaries(deps: MissionSummaryDeps) {
  function ownMission(identity: SummaryIdentity): Mission | undefined {
    if (identity.role !== 'gui-delegator' || !identity.missionId) return undefined
    const mission = deps.missions.get(identity.missionId)
    if (!mission || mission.projectId !== identity.projectId ||
      identity.paneId !== guiMissionPaneId('dev', mission.id) ||
      missionTypeOf(mission) !== 'dev' || mission.status === 'arquivada') return undefined
    return mission
  }

  function save(identity: SummaryIdentity, input: unknown): SummaryResult {
    const mission = ownMission(identity)
    if (!mission) return { ok: false, text: 'O resumo só pode ser registrado pelo chat de desenvolvimento da própria missão. Abra esse chat e use mission_summary { summary }.' }
    if (typeof input !== 'string' || !input.trim() || input.length > MISSION_SUMMARY_MAX) {
      return { ok: false, text: `O resumo da missão ainda precisa ser registrado. ${summaryRecipe}` }
    }
    const summary = redactSensitiveText(input.trim().replace(/\s+/gu, ' '))
    try {
      const saved = mission.summary === summary ? mission : deps.missions.update(mission.id, { summary })
      if (!saved) return { ok: false, text: 'A missão não está mais disponível. Reabra a missão no Synkora antes de usar mission_summary.' }
      if (mission.summary !== summary) deps.audit(saved)
      // The mission is the durable source. Repeating the tool repairs a failed
      // version projection without changing completion or delivery timestamps.
      const reconciled = saved.status !== 'concluida' || deps.reconcile(saved)
      deps.changed(saved.projectId)
      return reconciled
        ? { ok: true, text: 'Resumo salvo na missão. Ele aparece abaixo da entrega na versão quando a missão é concluída.' }
        : { ok: false, text: 'O resumo foi salvo na missão, mas a cópia no histórico ainda está pendente. Repita mission_summary com o mesmo summary para concluir o registro.' }
    } catch {
      return { ok: false, text: 'Não confirmei o registro completo do resumo. Confira se o armazenamento do Synkora está disponível e repita mission_summary com o mesmo summary.' }
    }
  }

  function prepareIntegration(identity: SummaryIdentity, summary?: string): SummaryResult {
    const mission = ownMission(identity)
    return save(identity, summary ?? mission?.summary)
  }

  return { save, prepareIntegration }
}

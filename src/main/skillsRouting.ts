export interface RoutableSkill<Department extends string = string> {
  id: string
  kind: 'skill' | 'agent'
  depts: Department[]
  group: string
  /**
   * A skill continua visível e pode ser escolhida explicitamente por card ou
   * ajudante, mas não entra no menu automático de toda execução da função.
   * Útil para workflows que o harness do Synkora já controla (git/review/merge).
   */
  manualOnly?: boolean
}

export const SYNKORA_FRONTEND_STANDARD_ID = 'synkora-frontend-standard'

export type FrontendStandardPhase = 'dev' | 'review' | 'qa'

/** DEV de front/design e o QA desses cards nunca podem degradar sem a régua. */
export function missingMandatoryFrontendStandard(
  injectedIds: Iterable<string>,
  department: string,
  phase: FrontendStandardPhase
): boolean {
  if (!['front', 'design'].includes(department) || !['dev', 'qa'].includes(phase)) return false
  return !new Set(injectedIds).has(SYNKORA_FRONTEND_STANDARD_ID)
}

/** A régua visual é contrato do produto, não uma skill opcional do orçamento. */
export function withMandatoryFrontendStandard<Department extends string>(
  ids: Iterable<string>,
  department: Department
): string[] {
  return [
    ...new Set([
      ...ids,
      ...(['front', 'design'].includes(department) ? [SYNKORA_FRONTEND_STANDARD_ID] : [])
    ])
  ]
}

/** FAST QA recebe só a régua obrigatória quando o card é de UI. */
export function selectFastQaUiSkillIds(installedQaIds: Iterable<string>, uiCard: boolean): string[] {
  if (!uiCard) return []
  return [...installedQaIds].filter((id) => id === SYNKORA_FRONTEND_STANDARD_ID)
}

export function selectInstalledIdsForDepartment<Department extends string>(
  defs: RoutableSkill<Department>[],
  isInstalled: (id: string) => boolean,
  department: Department,
  kind: 'skill' | 'agent' = 'skill'
): string[] {
  return defs
    .filter(
      (def) =>
        def.kind === kind &&
        !def.manualOnly &&
        def.depts.includes(department) &&
        isInstalled(def.id)
    )
    .map((def) => def.id)
}

/** Toda skill classificada no grupo de planejamento acompanha PM e orquestrador. */
export function selectInstalledPlanningIds<Department extends string>(
  defs: RoutableSkill<Department>[],
  isInstalled: (id: string) => boolean
): string[] {
  return defs
    .filter(
      (def) =>
        def.kind === 'skill' &&
        def.group.trim().toLocaleLowerCase('pt-BR') === 'planejamento' &&
        isInstalled(def.id)
    )
    .map((def) => def.id)
}

/**
 * Workflows manuais escolhidos numa execução anterior não podem continuar
 * sendo descobertos automaticamente pelo CLI no mesmo workspace. A biblioteca
 * usa esta lista para retirar somente cópias que ela própria gerenciou.
 */
export function selectInstalledManualOnlyIdsToPrune<Department extends string>(
  defs: RoutableSkill<Department>[],
  isInstalled: (id: string) => boolean,
  requestedIds: Iterable<string>
): string[] {
  const requested = new Set(requestedIds)
  return defs
    .filter(
      (def) =>
        def.kind === 'skill' &&
        def.manualOnly === true &&
        isInstalled(def.id) &&
        !requested.has(def.id)
    )
    .map((def) => def.id)
}

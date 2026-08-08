import { randomUUID } from 'node:crypto'

/**
 * Provider-neutral skill receipt ledger.
 *
 * This module deliberately has no Electron, filesystem, MCP or model-provider
 * dependency. It records only small control-plane facts. Skill bodies, prompts,
 * project paths and model output never enter the registry or its snapshots.
 */

export const SKILL_RUNTIME_CONTRACT_VERSION = 1 as const

export interface SkillRuntimeScope {
  paneId: string
  phase: string
  phaseRun: string
}

export interface PlannedSkillInput {
  skillId: string
  operation: string
  /** Identidade imutável do pacote aprovado no momento do plano. */
  version: string
  fingerprint: string
  /** Safe reason code, not prose (for example: "ui.layout"). */
  reason: string
  required: boolean
}

export interface PlanPaneInput extends SkillRuntimeScope {
  skills: PlannedSkillInput[]
}

export interface SkillReceiptSnapshot {
  receiptId: string
  skillId: string
  operation: string
  version: string
  fingerprint: string
  reason: string
  required: boolean
  plannedAt: string
  activatedAt?: string
  appliedAt?: string
}

/** Safe durable proof that a planning artifact was produced under a receipt. */
export interface PlanningMethodEvidence {
  contractVersion: typeof SKILL_RUNTIME_CONTRACT_VERSION
  receiptId: string
  skillId: string
  operation: string
  version: string
  fingerprint: string
  phaseRun: string
  appliedAt: string
}

export interface PaneSkillPlanSnapshot extends SkillRuntimeScope {
  plannedAt: string
  receipts: SkillReceiptSnapshot[]
}

export interface SkillRuntimeSnapshot {
  contractVersion: typeof SKILL_RUNTIME_CONTRACT_VERSION
  plans: PaneSkillPlanSnapshot[]
}

export type SkillRuntimeErrorCode =
  | 'invalid_input'
  | 'plan_conflict'
  | 'pane_mismatch'
  | 'phase_mismatch'
  | 'phase_run_mismatch'
  | 'receipt_not_planned'
  | 'durable_commit_failed'
  | 'durable_rollback_failed'
  | 'report_incomplete'

export interface SkillRuntimeFailure<
  Code extends SkillRuntimeErrorCode = SkillRuntimeErrorCode
> {
  ok: false
  code: Code
  /** Fixed, non-sensitive diagnostic. Never contains caller-provided prose. */
  message: string
}

export interface SkillPlanSuccess {
  ok: true
  idempotent: boolean
  plan: PaneSkillPlanSnapshot
}

export type SkillPlanResult = SkillPlanSuccess | SkillRuntimeFailure

export interface ReplacePanePlanInput extends PlanPaneInput {
  expectedPhase: string
  expectedPhaseRun: string
}

export interface ActivateSkillInput extends SkillRuntimeScope {
  /** The only selector accepted at activation time. */
  receiptId: string
}

export interface SkillActivationSuccess {
  ok: true
  idempotent: boolean
  receipt: SkillReceiptSnapshot
}

export type SkillActivationResult = SkillActivationSuccess | SkillRuntimeFailure

export interface SkillReportInput extends SkillRuntimeScope {
  /** Receipts the pane declares it applied to this report. */
  skillApplications?: string[]
}

export interface SkillReportSuccess {
  ok: true
  /** De-duplicated receipt ids, in caller order. */
  skillApplications: string[]
  requiredReceipts: string[]
}

export type SkillReportFailure = SkillRuntimeFailure<
  'invalid_input' | 'phase_mismatch' | 'phase_run_mismatch'
> | (SkillRuntimeFailure<'report_incomplete'> & {
  missingActivated?: string[]
  missingDeclared?: string[]
  unknownApplications?: string[]
  unactivatedApplications?: string[]
})

export type SkillReportResult = SkillReportSuccess | SkillReportFailure

export interface ReleaseSkillPlanSuccess {
  ok: true
  released: boolean
  receiptCount: number
}

export type ReleaseSkillPlanResult = ReleaseSkillPlanSuccess | SkillRuntimeFailure

export interface SkillRuntimeOptions {
  now?: () => Date
  receiptId?: () => string
}

interface StoredSkillReceipt extends SkillReceiptSnapshot {
  paneId: string
  phase: string
  phaseRun: string
}

interface StoredPanePlan {
  paneId: string
  phase: string
  phaseRun: string
  plannedAt: string
  signature: string
  receipts: StoredSkillReceipt[]
}

const SAFE_CONTROL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const MAX_SKILLS_PER_PANE = 8
const MAX_APPLICATIONS_PER_REPORT = 16

function validControlValue(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CONTROL_VALUE.test(value)
}

function validScope(scope: SkillRuntimeScope): boolean {
  return (
    validControlValue(scope.paneId) &&
    validControlValue(scope.phase) &&
    validControlValue(scope.phaseRun)
  )
}

function fixedFailure<Code extends SkillRuntimeErrorCode>(
  code: Code
): SkillRuntimeFailure<Code> {
  const messages: Record<SkillRuntimeErrorCode, string> = {
    invalid_input: 'skill runtime input is invalid',
    plan_conflict: 'pane already has a different active skill plan',
    pane_mismatch: 'skill receipt belongs to another pane',
    phase_mismatch: 'skill receipt belongs to another phase',
    phase_run_mismatch: 'skill receipt belongs to another phase run',
    receipt_not_planned: 'skill receipt is not planned or is no longer active',
    durable_commit_failed: 'durable skill activation commit failed',
    durable_rollback_failed: 'durable skill activation rollback failed',
    report_incomplete: 'skill applications do not satisfy the active plan'
  }
  return { ok: false, code, message: messages[code] }
}

function receiptSnapshot(receipt: StoredSkillReceipt): SkillReceiptSnapshot {
  return {
    receiptId: receipt.receiptId,
    skillId: receipt.skillId,
    operation: receipt.operation,
    version: receipt.version,
    fingerprint: receipt.fingerprint,
    reason: receipt.reason,
    required: receipt.required,
    plannedAt: receipt.plannedAt,
    ...(receipt.activatedAt ? { activatedAt: receipt.activatedAt } : {}),
    ...(receipt.appliedAt ? { appliedAt: receipt.appliedAt } : {})
  }
}

function planSnapshot(plan: StoredPanePlan): PaneSkillPlanSnapshot {
  return {
    paneId: plan.paneId,
    phase: plan.phase,
    phaseRun: plan.phaseRun,
    plannedAt: plan.plannedAt,
    receipts: plan.receipts.map(receiptSnapshot)
  }
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function planSignature(skills: readonly PlannedSkillInput[]): string {
  return JSON.stringify(
    skills.map(({ skillId, operation, version, fingerprint, reason, required }) => ({
      skillId,
      operation,
      version,
      fingerprint,
      reason,
      required
    }))
  )
}

/**
 * An in-memory active-run ledger. Durable persistence can store safeSnapshot()
 * in the task schema, while phase restarts create a fresh phaseRun and receipts.
 */
export class SkillRuntime {
  private readonly plansByPane = new Map<string, StoredPanePlan>()
  private readonly receiptsById = new Map<string, StoredSkillReceipt>()
  private readonly now: () => Date
  private readonly makeReceiptId: () => string

  constructor(options: SkillRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.makeReceiptId = options.receiptId ?? randomUUID
  }

  planPane(input: PlanPaneInput): SkillPlanResult {
    if (!validScope(input) || !Array.isArray(input.skills) || input.skills.length > MAX_SKILLS_PER_PANE) {
      return fixedFailure('invalid_input')
    }
    const descriptors = input.skills.map(({ skillId, operation, version, fingerprint, reason, required }) => ({
      skillId,
      operation,
      version,
      fingerprint,
      reason,
      required
    }))
    if (
      descriptors.some(
        (skill) =>
          !validControlValue(skill.skillId) ||
          !validControlValue(skill.operation) ||
          !validControlValue(skill.version) ||
          !validControlValue(skill.fingerprint) ||
          !validControlValue(skill.reason) ||
          typeof skill.required !== 'boolean'
      )
    ) {
      return fixedFailure('invalid_input')
    }
    const descriptorKeys = descriptors.map(
      (skill) => `${skill.skillId}\u0000${skill.operation}`
    )
    if (new Set(descriptorKeys).size !== descriptorKeys.length) {
      return fixedFailure('invalid_input')
    }

    const signature = planSignature(descriptors)
    const existing = this.plansByPane.get(input.paneId)
    if (existing) {
      if (
        existing.phase === input.phase &&
        existing.phaseRun === input.phaseRun &&
        existing.signature === signature
      ) {
        return { ok: true, idempotent: true, plan: planSnapshot(existing) }
      }
      return fixedFailure('plan_conflict')
    }

    const plannedAt = this.now().toISOString()
    const reservedIds = new Set<string>()
    const receipts: StoredSkillReceipt[] = []
    for (const skill of descriptors) {
      let receiptId = ''
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = this.makeReceiptId()
        if (
          validControlValue(candidate) &&
          !this.receiptsById.has(candidate) &&
          !reservedIds.has(candidate)
        ) {
          receiptId = candidate
          break
        }
      }
      if (!receiptId) return fixedFailure('invalid_input')
      reservedIds.add(receiptId)
      receipts.push({
        receiptId,
        paneId: input.paneId,
        phase: input.phase,
        phaseRun: input.phaseRun,
        skillId: skill.skillId,
        operation: skill.operation,
        version: skill.version,
        fingerprint: skill.fingerprint,
        reason: skill.reason,
        required: skill.required,
        plannedAt
      })
    }

    const plan: StoredPanePlan = {
      paneId: input.paneId,
      phase: input.phase,
      phaseRun: input.phaseRun,
      plannedAt,
      signature,
      receipts
    }
    this.plansByPane.set(input.paneId, plan)
    for (const receipt of receipts) this.receiptsById.set(receipt.receiptId, receipt)
    return { ok: true, idempotent: false, plan: planSnapshot(plan) }
  }

  /**
   * Troca uma rodada viva sem janela entre o ledger duravel e o registro em
   * memoria. A rodada antiga continua integralmente valida se o commit externo
   * falhar; os novos receipts so se tornam ativos depois desse commit.
   */
  replacePanePlan(
    input: ReplacePanePlanInput,
    durability: {
      commit: (previous: PaneSkillPlanSnapshot, next: PaneSkillPlanSnapshot) => void
      rollback: (previous: PaneSkillPlanSnapshot, next: PaneSkillPlanSnapshot) => void
    }
  ): SkillPlanResult {
    if (
      !validScope(input) ||
      !validControlValue(input.expectedPhase) ||
      !validControlValue(input.expectedPhaseRun) ||
      input.phaseRun === input.expectedPhaseRun ||
      !Array.isArray(input.skills) ||
      input.skills.length > MAX_SKILLS_PER_PANE
    ) {
      return fixedFailure('invalid_input')
    }
    const existing = this.plansByPane.get(input.paneId)
    if (!existing) return fixedFailure('plan_conflict')
    if (existing.phase !== input.expectedPhase || input.phase !== input.expectedPhase) {
      return fixedFailure('phase_mismatch')
    }
    if (existing.phaseRun !== input.expectedPhaseRun) {
      return fixedFailure('phase_run_mismatch')
    }

    const descriptors = input.skills.map(
      ({ skillId, operation, version, fingerprint, reason, required }) => ({
        skillId,
        operation,
        version,
        fingerprint,
        reason,
        required
      })
    )
    if (
      descriptors.some(
        (skill) =>
          !validControlValue(skill.skillId) ||
          !validControlValue(skill.operation) ||
          !validControlValue(skill.version) ||
          !validControlValue(skill.fingerprint) ||
          !validControlValue(skill.reason) ||
          typeof skill.required !== 'boolean'
      )
    ) {
      return fixedFailure('invalid_input')
    }
    const descriptorKeys = descriptors.map(
      (skill) => `${skill.skillId}\u0000${skill.operation}`
    )
    if (new Set(descriptorKeys).size !== descriptorKeys.length) {
      return fixedFailure('invalid_input')
    }

    const plannedAt = this.now().toISOString()
    const reservedIds = new Set<string>()
    const receipts: StoredSkillReceipt[] = []
    for (const skill of descriptors) {
      let receiptId = ''
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = this.makeReceiptId()
        if (
          validControlValue(candidate) &&
          !this.receiptsById.has(candidate) &&
          !reservedIds.has(candidate)
        ) {
          receiptId = candidate
          break
        }
      }
      if (!receiptId) return fixedFailure('invalid_input')
      reservedIds.add(receiptId)
      receipts.push({
        receiptId,
        paneId: input.paneId,
        phase: input.phase,
        phaseRun: input.phaseRun,
        skillId: skill.skillId,
        operation: skill.operation,
        version: skill.version,
        fingerprint: skill.fingerprint,
        reason: skill.reason,
        required: skill.required,
        plannedAt
      })
    }
    const next: StoredPanePlan = {
      paneId: input.paneId,
      phase: input.phase,
      phaseRun: input.phaseRun,
      plannedAt,
      signature: planSignature(descriptors),
      receipts
    }
    const previousSnapshot = planSnapshot(existing)
    const nextSnapshot = planSnapshot(next)
    try {
      durability.commit(previousSnapshot, nextSnapshot)
    } catch {
      return fixedFailure('durable_commit_failed')
    }

    if (this.plansByPane.get(input.paneId) !== existing) {
      try {
        durability.rollback(previousSnapshot, nextSnapshot)
      } catch {
        return fixedFailure('durable_rollback_failed')
      }
      return fixedFailure('plan_conflict')
    }

    for (const receipt of existing.receipts) this.receiptsById.delete(receipt.receiptId)
    this.plansByPane.set(input.paneId, next)
    for (const receipt of next.receipts) this.receiptsById.set(receipt.receiptId, receipt)
    return { ok: true, idempotent: false, plan: nextSnapshot }
  }

  activate(input: ActivateSkillInput): SkillActivationResult {
    const resolved = this.resolve(input)
    if (!resolved.ok) return resolved
    const receipt = this.receiptsById.get(input.receiptId) as StoredSkillReceipt
    if (receipt.activatedAt) return resolved
    receipt.activatedAt = this.now().toISOString()
    return { ok: true, idempotent: false, receipt: receiptSnapshot(receipt) }
  }

  /**
   * Ativação em duas autoridades: primeiro o chamador confirma o ledger
   * durável; somente depois este registro efêmero recebe activatedAt. Se a
   * segunda etapa perder a corrida, o chamador restaura o ledger anterior.
   * Nenhuma exceção de persistência ou detalhe local atravessa o resultado.
   */
  activateAfterDurableCommit(
    input: ActivateSkillInput,
    durability: {
      commit: (receipt: SkillReceiptSnapshot) => void
      rollback: (receipt: SkillReceiptSnapshot) => void
    }
  ): SkillActivationResult {
    const resolved = this.resolve(input)
    if (!resolved.ok) return resolved
    try {
      durability.commit(resolved.receipt)
    } catch {
      return fixedFailure('durable_commit_failed')
    }
    const activated = this.activate(input)
    if (activated.ok) return activated
    try {
      durability.rollback(resolved.receipt)
    } catch {
      return fixedFailure('durable_rollback_failed')
    }
    return activated
  }

  /** Resolve escopo e receipt sem marcar ativacao. Permite ao adaptador MCP
   * carregar o pacote primeiro e so entao confirmar que ele foi entregue. */
  resolve(input: ActivateSkillInput): SkillActivationResult {
    if (!validScope(input) || !validControlValue(input.receiptId)) {
      return fixedFailure('invalid_input')
    }
    const receipt = this.receiptsById.get(input.receiptId)
    if (!receipt) return fixedFailure('receipt_not_planned')
    const mismatch = this.scopeMismatch(input, receipt)
    if (mismatch) return fixedFailure(mismatch)

    if (receipt.activatedAt) {
      return { ok: true, idempotent: true, receipt: receiptSnapshot(receipt) }
    }
    return { ok: true, idempotent: false, receipt: receiptSnapshot(receipt) }
  }

  guardReport(input: SkillReportInput): SkillReportResult {
    if (!validScope(input)) return fixedFailure('invalid_input')
    if (
      input.skillApplications !== undefined &&
      (!Array.isArray(input.skillApplications) ||
        input.skillApplications.length > MAX_APPLICATIONS_PER_REPORT ||
        input.skillApplications.some((receiptId) => !validControlValue(receiptId)))
    ) {
      return fixedFailure('invalid_input')
    }

    const plan = this.plansByPane.get(input.paneId)
    // No active plan means there is no skill obligation for this pane.
    if (!plan) {
      return input.skillApplications?.length
        ? {
            ...fixedFailure('report_incomplete'),
            unknownApplications: uniqueInOrder(input.skillApplications)
          }
        : { ok: true, skillApplications: [], requiredReceipts: [] }
    }
    if (plan.phase !== input.phase) return fixedFailure('phase_mismatch')
    if (plan.phaseRun !== input.phaseRun) return fixedFailure('phase_run_mismatch')

    const applications = uniqueInOrder(input.skillApplications ?? [])
    const plannedIds = new Set(plan.receipts.map((receipt) => receipt.receiptId))
    const required = plan.receipts.filter((receipt) => receipt.required)
    const applicationSet = new Set(applications)
    const unknownApplications = applications.filter((receiptId) => !plannedIds.has(receiptId))
    const unactivatedApplications = applications.filter((receiptId) => {
      const receipt = this.receiptsById.get(receiptId)
      return plannedIds.has(receiptId) && !receipt?.activatedAt
    })
    const missingActivated = required
      .filter((receipt) => !receipt.activatedAt)
      .map((receipt) => receipt.receiptId)
    const missingDeclared = required
      .filter((receipt) => !applicationSet.has(receipt.receiptId))
      .map((receipt) => receipt.receiptId)

    if (
      unknownApplications.length ||
      unactivatedApplications.length ||
      missingActivated.length ||
      missingDeclared.length
    ) {
      return {
        ...fixedFailure('report_incomplete'),
        ...(missingActivated.length ? { missingActivated } : {}),
        ...(missingDeclared.length ? { missingDeclared } : {}),
        ...(unknownApplications.length ? { unknownApplications } : {}),
        ...(unactivatedApplications.length ? { unactivatedApplications } : {})
      }
    }

    return {
      ok: true,
      skillApplications: applications,
      requiredReceipts: required.map((receipt) => receipt.receiptId)
    }
  }

  /**
   * Call only after the surrounding report transaction is accepted. It repeats
   * the guard and then stamps appliedAt atomically inside this registry.
   */
  acceptReport(input: SkillReportInput): SkillReportResult {
    const guarded = this.guardReport(input)
    if (!guarded.ok) return guarded
    const appliedAt = this.now().toISOString()
    for (const receiptId of guarded.skillApplications) {
      const receipt = this.receiptsById.get(receiptId)
      if (receipt && !receipt.appliedAt) receipt.appliedAt = appliedAt
    }
    return guarded
  }

  release(input: SkillRuntimeScope): ReleaseSkillPlanResult {
    if (!validScope(input)) return fixedFailure('invalid_input')
    const plan = this.plansByPane.get(input.paneId)
    if (!plan) return { ok: true, released: false, receiptCount: 0 }
    if (plan.phase !== input.phase) return fixedFailure('phase_mismatch')
    if (plan.phaseRun !== input.phaseRun) return fixedFailure('phase_run_mismatch')

    this.plansByPane.delete(input.paneId)
    for (const receipt of plan.receipts) this.receiptsById.delete(receipt.receiptId)
    return { ok: true, released: true, receiptCount: plan.receipts.length }
  }

  safeSnapshot(): SkillRuntimeSnapshot {
    return {
      contractVersion: SKILL_RUNTIME_CONTRACT_VERSION,
      plans: [...this.plansByPane.values()]
        .sort((left, right) => left.paneId.localeCompare(right.paneId, 'en'))
        .map(planSnapshot)
    }
  }

  private scopeMismatch(
    actual: SkillRuntimeScope,
    expected: Pick<StoredSkillReceipt, 'paneId' | 'phase' | 'phaseRun'>
  ): 'pane_mismatch' | 'phase_mismatch' | 'phase_run_mismatch' | undefined {
    if (actual.paneId !== expected.paneId) return 'pane_mismatch'
    if (actual.phase !== expected.phase) return 'phase_mismatch'
    if (actual.phaseRun !== expected.phaseRun) return 'phase_run_mismatch'
    return undefined
  }
}

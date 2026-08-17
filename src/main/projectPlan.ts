import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const PROJECT_PLAN_SCHEMA_VERSION = 2 as const
export const PROJECT_PLAN_TRUST_CONTRACT_VERSION = 1 as const
const LEGACY_PROJECT_PLAN_SCHEMA_VERSION = 1 as const
const MAX_PROJECT_PLAN_ITEMS = 500
export const PROJECT_PLAN_DIRECTORY = '.synkora'
export const PROJECT_PLAN_JSON = 'PROJECT_PLAN.json'
export const PROJECT_PLAN_MARKDOWN = 'PROJECT_PLAN.md'

export type ProjectPlanStatus =
  | 'draft'
  | 'approved'
  | 'in_progress'
  | 'revision_pending'
  | 'awaiting_release'
  | 'done'
export type ProjectPlanItemStatus = 'planned' | 'active' | 'done' | 'deferred'

export interface ProjectPlanScope {
  in: string[]
  out: string[]
}

export interface ProjectPlanVersion {
  /** id da versão no backlog, quando ela já existir */
  id?: string
  /** nome planejado, por exemplo V1.0 */
  name: string
  theme?: string
  goal?: string
}

export interface ProjectPlanWave {
  id: string
  name?: string
}

export interface ProjectPlanRoadmapMeta {
  expectedCount?: number
  complete: boolean
}

export type ProjectPlanningSkillStage =
  | 'discovery'
  | 'scope'
  | 'decisions'
  | 'roadmap'
  | 'review'

export interface ProjectPlanningSkillUse {
  id: string
  stage: ProjectPlanningSkillStage
  contribution: string
  usedAt: string
  /** Metadados ausentes identificam apenas registros legados/autodeclarados. */
  contractVersion?: 1
  receiptId?: string
  operation?: string
  version?: string
  fingerprint?: string
  phaseRun?: string
  appliedAt?: string
  /** updatedAt exato da fotografia do plano produzida por este receipt. */
  planningRevision?: string
  /** SHA-256 canonico do conteudo planejado; impede preservar o receipt ao
   * trocar silenciosamente objetivo, escopo, decisoes ou roadmap. */
  planningFingerprint?: string
}

/** Carimbo de migração guardado fora do workspace. Ele existe apenas para
 * planos que já estavam aprovados antes do contrato de receipts; o JSON do
 * projeto nunca pode conceder esse grandfathering a si próprio. */
export interface ProjectPlanLegacyApproval {
  contractVersion: typeof PROJECT_PLAN_TRUST_CONTRACT_VERSION
  planningRevision: string
  planningFingerprint: string
  approvedAt: string
  migratedAt: string
}

export interface ProjectPlanItem {
  id: string
  title: string
  objective: string
  status: ProjectPlanItemStatus
  dependsOn: string[]
  scope: ProjectPlanScope
  acceptanceCriteria: string[]
  wave: ProjectPlanWave
  version?: ProjectPlanVersion
  /** Versão real do backlog que receberá esta missão antes de subir à base. */
  release?: {
    versionId: string
    versionName: string
    releasedAt?: string
  }
  missionId?: string
  outcome?: string
  deferredReason?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  deferredAt?: string
}

export interface ProjectPlan {
  schemaVersion: typeof PROJECT_PLAN_SCHEMA_VERSION
  origin: 'greenfield'
  status: ProjectPlanStatus
  projectName: string
  problem: string
  audience: string
  vision: string
  successCriteria: string[]
  constraints: string[]
  scope: ProjectPlanScope
  decisions: string[]
  roadmapMeta: ProjectPlanRoadmapMeta
  roadmap: ProjectPlanItem[]
  planningSkills: ProjectPlanningSkillUse[]
  /** Revisao exclusiva do conteudo planejado. Eventos operacionais (aprovar,
   * iniciar/concluir missao, publicar versao) mudam updatedAt, mas nunca
   * invalidam o receipt que produziu esta fotografia. */
  planningRevision: string
  planningFingerprint: string
  /** Planos aprovados antes do contrato de receipts continuam executaveis,
   * mas ficam explicitamente identificados. Todo rascunho novo e toda revisao
   * precisam voltar a receipt_required ate um novo save governado. */
  planningGovernance: 'receipt_required' | 'receipt_verified' | 'legacy_unverified'
  activeItemIds: string[]
  readyItemIds: string[]
  currentWaveId?: string
  /** Alias legado derivado do primeiro item ativo. */
  activeItemId?: string
  /** Alias legado derivado do primeiro item pronto. */
  nextItemId?: string
  createdAt: string
  updatedAt: string
  approvedAt?: string
  completedAt?: string
}

export interface ProjectPlanDraftItem {
  id: string
  title: string
  objective: string
  dependsOn?: string[]
  scope?: Partial<ProjectPlanScope>
  acceptanceCriteria?: string[]
  wave?: ProjectPlanWave
  version?: ProjectPlanVersion
}

export interface ProjectPlanDraftInput {
  projectName?: string
  problem?: string
  audience?: string
  vision?: string
  successCriteria?: string[]
  constraints?: string[]
  scope?: Partial<ProjectPlanScope>
  decisions?: string[]
  roadmapMeta?: Partial<ProjectPlanRoadmapMeta>
  /** merge é o padrão seguro para listas; replace exige revisão explícita. */
  listMode?: 'merge' | 'replace'
  /** merge é o padrão seguro; replace troca somente itens ainda sem missão real. */
  roadmapMode?: 'merge' | 'replace'
  roadmap?: ProjectPlanDraftItem[]
  /** Preenchido somente pelo harness depois de validar um receipt ativo. */
  planningEvidence?: ProjectPlanningSkillUse
  now?: string
}

export interface ProjectPlanValidationOptions {
  /** Quando true, a evidencia embutida no workspace nao basta: ela precisa
   * coincidir byte a byte com o carimbo guardado pelo control-plane. */
  requireTrustedEvidence?: boolean
  trustedEvidence?: ProjectPlanningSkillUse
  trustedLegacyApproval?: ProjectPlanLegacyApproval
}

export function projectPlanContentFingerprint(plan: ProjectPlan): string {
  const content = {
    projectName: plan.projectName,
    problem: plan.problem,
    audience: plan.audience,
    vision: plan.vision,
    successCriteria: plan.successCriteria,
    constraints: plan.constraints,
    scope: plan.scope,
    decisions: plan.decisions,
    roadmapMeta: plan.roadmapMeta,
    roadmap: plan.roadmap.map((item) => ({
      id: item.id,
      title: item.title,
      objective: item.objective,
      dependsOn: item.dependsOn,
      scope: item.scope,
      acceptanceCriteria: item.acceptanceCriteria,
      wave: item.wave,
      version: item.version
        ? {
            name: item.version.name,
            theme: item.version.theme,
            goal: item.version.goal
          }
        : undefined
    }))
  }
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

export function legacyProjectPlanApproval(
  plan: ProjectPlan,
  migratedAt: string = new Date().toISOString()
): ProjectPlanLegacyApproval | undefined {
  if (
    plan.planningGovernance !== 'legacy_unverified' ||
    !['approved', 'in_progress', 'awaiting_release', 'done'].includes(plan.status) ||
    typeof plan.approvedAt !== 'string' ||
    plan.approvedAt.trim().length === 0
  ) {
    return undefined
  }
  const planningFingerprint = projectPlanContentFingerprint(plan)
  if (plan.planningFingerprint !== planningFingerprint) return undefined
  return {
    contractVersion: PROJECT_PLAN_TRUST_CONTRACT_VERSION,
    planningRevision: plan.planningRevision,
    planningFingerprint,
    approvedAt: plan.approvedAt,
    migratedAt
  }
}

function sameLegacyProjectPlanApproval(
  plan: ProjectPlan,
  trusted: ProjectPlanLegacyApproval | undefined
): boolean {
  return Boolean(
    trusted &&
      trusted.contractVersion === PROJECT_PLAN_TRUST_CONTRACT_VERSION &&
      trusted.planningRevision === plan.planningRevision &&
      trusted.planningFingerprint === projectPlanContentFingerprint(plan) &&
      trusted.approvedAt === plan.approvedAt
  )
}

export interface RecordProjectPlanningSkillUseInput {
  id: string
  stage: ProjectPlanningSkillStage
  contribution: string
  now?: string
}

export interface ProjectPlanExecutionWindow {
  currentWaveId?: string
  currentVersion?: ProjectPlanVersion
  itemIds: string[]
  activeItemIds: string[]
  readyItemIds: string[]
  deferredItemIds: string[]
  pausedByDeferred: boolean
  releaseGate?: ProjectPlanReleaseTarget
}

export interface EnsureGreenfieldProjectPlanInput {
  projectName?: string
  now?: string
}

export interface EnsureGreenfieldProjectPlanResult {
  greenfield: boolean
  created: boolean
  plan?: ProjectPlan
}

export interface StartProjectMissionInput {
  itemId: string
  missionId: string
  release?: {
    versionId: string
    versionName: string
  }
  now?: string
  /** Produção passa o carimbo do control-plane para revalidar a fotografia
   * imediatamente antes do vínculo. Testes puros podem omitir. */
  validation?: ProjectPlanValidationOptions
}

export interface CompleteProjectMissionInput {
  missionId: string
  outcome: string
  now?: string
}

export interface DeferProjectMissionInput {
  itemId: string
  reason?: string
  now?: string
}

export interface ReactivateProjectMissionInput {
  itemId: string
  now?: string
}

export interface DetachProjectMissionInput {
  missionId: string
  now?: string
}

export interface CompleteProjectPlanReleaseInput {
  versionId: string
  now?: string
}

export interface ProjectPlanReleaseTarget {
  versionId: string
  versionName: string
}

export type ProjectPlanErrorCode =
  | 'not_greenfield'
  | 'plan_not_found'
  | 'plan_complete'
  | 'invalid_plan'
  | 'approval_required'
  | 'item_not_found'
  | 'item_not_planned'
  | 'active_mission_exists'
  | 'dependencies_incomplete'
  | 'release_required'
  | 'mission_id_conflict'
  | 'mission_not_found'
  | 'mission_not_active'

export class ProjectPlanError extends Error {
  readonly code: ProjectPlanErrorCode

  constructor(code: ProjectPlanErrorCode, message: string) {
    super(message)
    this.name = 'ProjectPlanError'
    this.code = code
  }
}

export function projectPlanPaths(projectRoot: string): {
  directory: string
  json: string
  backup: string
  markdown: string
} {
  const directory = join(resolve(projectRoot), PROJECT_PLAN_DIRECTORY)
  return {
    directory,
    json: join(directory, PROJECT_PLAN_JSON),
    backup: join(directory, `${PROJECT_PLAN_JSON}.bak`),
    markdown: join(directory, PROJECT_PLAN_MARKDOWN)
  }
}

// ÂNCORA DO EXPURGO F6 (2026-08-17, costura S1) — NÃO transformar em import.
// A versão PÚBLICA de "esta pasta está vazia?" emigrou para `projectFolder.ts`
// (é ela que o GitHub-no-nascimento usa, e é ela que sobrevive). Esta cópia é
// PRIVADA e existe só porque este arquivo é carregado pelo strip-types do node
// em `test-project-plan.mjs`: com `moduleResolution: bundler` (sem extensão no
// especificador) um import de irmão aqui explode no loader. O arquivo inteiro
// morre na onda 3 do expurgo, e a duplicação morre junto.
const IGNORED_EMPTY_PROJECT_ENTRIES = new Set([
  '.git',
  '.synkora',
  '.agents',
  '.claude',
  '.codex',
  '.ds_store',
  'desktop.ini'
])

function isEffectivelyEmptyProject(projectRoot: string): boolean {
  const root = resolve(projectRoot)
  if (!existsSync(root)) return true
  if (!statSync(root).isDirectory()) return false
  return readdirSync(root).every((entry) =>
    IGNORED_EMPTY_PROJECT_ENTRIES.has(entry.toLocaleLowerCase('en-US'))
  )
}

export function ensureGreenfieldProjectPlan(
  projectRoot: string,
  input: EnsureGreenfieldProjectPlanInput = {}
): EnsureGreenfieldProjectPlanResult {
  const existing = loadProjectPlan(projectRoot)
  if (existing) {
    // O JSON é a fonte da verdade. Recriar o MD aqui também repara uma cópia
    // legível removida manualmente sem alterar o estado do planejamento.
    persistProjectPlan(projectRoot, existing)
    return { greenfield: true, created: false, plan: existing }
  }

  if (!isEffectivelyEmptyProject(projectRoot)) {
    return { greenfield: false, created: false }
  }

  const now = timestamp(input.now)
  const plan: ProjectPlan = {
    schemaVersion: PROJECT_PLAN_SCHEMA_VERSION,
    origin: 'greenfield',
    status: 'draft',
    projectName: clean(input.projectName) || basename(resolve(projectRoot)),
    problem: '',
    audience: '',
    vision: '',
    successCriteria: [],
    constraints: [],
    scope: { in: [], out: [] },
    decisions: [],
    roadmapMeta: { complete: false },
    roadmap: [],
    planningSkills: [],
    planningRevision: now,
    planningFingerprint: '',
    planningGovernance: 'receipt_required',
    activeItemIds: [],
    readyItemIds: [],
    createdAt: now,
    updatedAt: now
  }
  plan.planningFingerprint = projectPlanContentFingerprint(plan)
  persistProjectPlan(projectRoot, plan)
  return { greenfield: true, created: true, plan }
}

export function loadProjectPlan(projectRoot: string): ProjectPlan | undefined {
  const paths = projectPlanPaths(projectRoot)
  const file = paths.json
  if (!existsSync(file)) {
    if (!existsSync(paths.backup)) return undefined
    try {
      const recovered = parseStoredPlan(paths.backup)
      writePlanFiles(paths, recovered.plan)
      return recovered.plan
    } catch (backupError) {
      throw new ProjectPlanError(
        'invalid_plan',
        `Não foi possível recuperar ${PROJECT_PLAN_DIRECTORY}/${PROJECT_PLAN_JSON} pelo backup: ${errorMessage(backupError)}`
      )
    }
  }

  try {
    const parsed = parseStoredPlan(file)
    if (parsed.changed) writePlanFiles(paths, parsed.plan)
    else repairDerivedPlanFiles(paths, parsed.plan)
    return parsed.plan
  } catch (primaryError) {
    // A última fotografia válida é mantida ao lado. Se uma queda interromper
    // a troca atômica ou alguém truncar o JSON, repara a fonte de verdade e o
    // Markdown automaticamente sem perder o ponto do roadmap.
    if (existsSync(paths.backup)) {
      try {
        const recovered = parseStoredPlan(paths.backup)
        writePlanFiles(paths, recovered.plan)
        return recovered.plan
      } catch {
        // o erro primário é o mais útil para quem precisa reparar manualmente
      }
    }
    throw new ProjectPlanError(
      'invalid_plan',
      `Não foi possível ler ${PROJECT_PLAN_DIRECTORY}/${PROJECT_PLAN_JSON}: ${errorMessage(primaryError)}`
    )
  }
}

/**
 * Salva a fotografia mais recente do planejamento colaborativo. Itens que já
 * estão ativos ou concluídos nunca podem desaparecer nem perder o vínculo com
 * a missão real, mesmo que um novo rascunho os omita ou tente reescrevê-los.
 */
export function saveProjectPlanDraft(
  projectRoot: string,
  input: ProjectPlanDraftInput
): ProjectPlan {
  let existing = loadProjectPlan(projectRoot)
  if (!existing) {
    const ensured = ensureGreenfieldProjectPlan(projectRoot, {
      projectName: input.projectName,
      now: input.now
    })
    if (!ensured.greenfield || !ensured.plan) {
      throw new ProjectPlanError(
        'not_greenfield',
        'A pasta já contém um projeto. O plano mestre greenfield não será criado automaticamente.'
      )
    }
    existing = ensured.plan
  }
  if (existing.status === 'done') {
    throw new ProjectPlanError(
      'plan_complete',
      'O plano mestre já foi concluído. A partir daqui, melhorias viram missões pontuais; ele não volta a rascunho silenciosamente.'
    )
  }

  const now = timestamp(input.now)
  const listMode = input.listMode ?? 'merge'
  const draftItems = input.roadmap === undefined ? undefined : normalizeDraftItems(input.roadmap)
  const roadmap = applyRoadmapDraft(
    existing.roadmap,
    draftItems,
    input.roadmapMode ?? 'merge',
    now
  )

  assertRealMissionOrderPreserved(existing.roadmap, roadmap)
  validateRoadmapStructure(roadmap)
  const hasActive = roadmap.some((item) => item.status === 'active')
  const plan: ProjectPlan = {
    ...existing,
    status: hasActive ? 'revision_pending' : 'draft',
    projectName: clean(input.projectName) || existing.projectName,
    problem: input.problem === undefined ? existing.problem : clean(input.problem),
    audience: input.audience === undefined ? existing.audience : clean(input.audience),
    vision: input.vision === undefined ? existing.vision : clean(input.vision),
    successCriteria:
      input.successCriteria === undefined
        ? [...existing.successCriteria]
        : applyListDraft(existing.successCriteria, input.successCriteria, listMode),
    constraints:
      input.constraints === undefined
        ? [...existing.constraints]
        : applyListDraft(existing.constraints, input.constraints, listMode),
    scope: {
      in:
        input.scope?.in === undefined
          ? [...existing.scope.in]
          : applyListDraft(existing.scope.in, input.scope.in, listMode),
      out:
        input.scope?.out === undefined
          ? [...existing.scope.out]
          : applyListDraft(existing.scope.out, input.scope.out, listMode)
    },
    decisions:
      input.decisions === undefined
        ? [...existing.decisions]
        : applyListDraft(existing.decisions, input.decisions, listMode),
    roadmapMeta: mergeRoadmapMeta(existing.roadmapMeta, input.roadmapMeta),
    roadmap,
    planningSkills: input.planningEvidence
      ? [
          ...existing.planningSkills.filter(
            (entry) => entry.receiptId !== input.planningEvidence?.receiptId
          ),
          {
            ...input.planningEvidence,
            usedAt: now,
            appliedAt: input.planningEvidence.appliedAt || now,
            planningRevision: now
          }
        ].slice(-100)
      : [...existing.planningSkills],
    planningRevision: now,
    planningFingerprint: '',
    planningGovernance: input.planningEvidence ? 'receipt_verified' : 'receipt_required',
    updatedAt: now,
    approvedAt: hasActive ? existing.approvedAt : undefined,
    completedAt: undefined
  }
  plan.planningFingerprint = projectPlanContentFingerprint(plan)
  if (input.planningEvidence) {
    const currentEvidence = plan.planningSkills.find(
      (entry) => entry.receiptId === input.planningEvidence?.receiptId
    )
    if (currentEvidence) currentEvidence.planningFingerprint = plan.planningFingerprint
  }
  refreshNavigation(plan)
  persistProjectPlan(projectRoot, plan)
  return plan
}

/**
 * Registra, de forma auditável, qual skill de planejamento o Maestro declarou
 * ter aplicado e qual contribuição concreta ela trouxe para o plano.
 */
export function recordProjectPlanningSkillUse(
  projectRoot: string,
  input: RecordProjectPlanningSkillUseInput
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const id = required(input.id, 'id')
  const contribution = required(input.contribution, 'contribution')
  const stages: ProjectPlanningSkillStage[] = [
    'discovery',
    'scope',
    'decisions',
    'roadmap',
    'review'
  ]
  if (!stages.includes(input.stage)) {
    throw new ProjectPlanError('invalid_plan', `Etapa de skill inválida: ${input.stage}.`)
  }
  const usedAt = timestamp(input.now)
  const previous = plan.planningSkills.find(
    (entry) =>
      entry.id === id &&
      entry.stage === input.stage &&
      entry.contribution === contribution
  )
  if (previous) return plan
  plan.planningSkills.push({ id, stage: input.stage, contribution, usedAt })
  plan.updatedAt = usedAt
  persistProjectPlan(projectRoot, plan)
  return plan
}

function samePlanningEvidence(
  left: ProjectPlanningSkillUse,
  right: ProjectPlanningSkillUse
): boolean {
  return (
    left.id === right.id &&
    left.stage === right.stage &&
    left.contribution === right.contribution &&
    left.usedAt === right.usedAt &&
    left.contractVersion === right.contractVersion &&
    left.receiptId === right.receiptId &&
    left.operation === right.operation &&
    left.version === right.version &&
    left.fingerprint === right.fingerprint &&
    left.phaseRun === right.phaseRun &&
    left.appliedAt === right.appliedAt &&
    left.planningRevision === right.planningRevision &&
    left.planningFingerprint === right.planningFingerprint
  )
}

export function isVerifiedProjectPlanningEvidence(
  entry: ProjectPlanningSkillUse | undefined,
  planningRevision: string,
  planningFingerprint: string
): entry is ProjectPlanningSkillUse {
  return Boolean(
    entry &&
      entry.id === 'synkora-planning-standard' &&
      ['discovery', 'scope', 'decisions', 'roadmap', 'review'].includes(entry.stage) &&
      entry.contribution.trim() &&
      entry.usedAt.trim() &&
      entry.contractVersion === 1 &&
      entry.operation === 'plan' &&
      entry.receiptId?.trim() &&
      entry.version?.trim() &&
      entry.fingerprint?.trim() &&
      entry.phaseRun?.trim() &&
      entry.appliedAt?.trim() &&
      entry.planningRevision === planningRevision &&
      entry.planningFingerprint === planningFingerprint
  )
}

export function validateProjectPlanForApproval(
  plan: ProjectPlan,
  options: ProjectPlanValidationOptions = {}
): string[] {
  const problems: string[] = []
  if (!clean(plan.problem)) problems.push('descreva o problema que o projeto resolve')
  if (!clean(plan.audience)) problems.push('defina para quem o projeto será construído')
  if (!clean(plan.vision)) problems.push('defina a visão do projeto')
  if (cleanList(plan.successCriteria).length === 0) {
    problems.push('defina ao menos um critério de sucesso')
  }
  if (cleanList(plan.constraints).length === 0) {
    problems.push('registre os limites/restrições discutidos, mesmo que a conclusão seja “nenhum conhecido”')
  }
  if (cleanList(plan.scope.in).length === 0) {
    problems.push('defina o que entra no primeiro escopo do projeto')
  }
  if (cleanList(plan.scope.out).length === 0) {
    problems.push('defina ao menos um não-objetivo ou algo que fica fora por enquanto')
  }
  if (cleanList(plan.decisions).length === 0) {
    problems.push('registre as decisões de produto/arquitetura e pesquisas necessárias')
  }
  const calculatedPlanningFingerprint = projectPlanContentFingerprint(plan)
  const fingerprintMatches = plan.planningFingerprint === calculatedPlanningFingerprint
  const currentPlanningEvidence = plan.planningSkills.find((entry) =>
    isVerifiedProjectPlanningEvidence(
      entry,
      plan.planningRevision,
      calculatedPlanningFingerprint
    )
  )
  const trustedEvidenceMatches =
    !options.requireTrustedEvidence ||
    Boolean(
      currentPlanningEvidence &&
        options.trustedEvidence &&
        isVerifiedProjectPlanningEvidence(
          options.trustedEvidence,
          plan.planningRevision,
          calculatedPlanningFingerprint
        ) &&
        samePlanningEvidence(currentPlanningEvidence, options.trustedEvidence)
    )
  const approvedLegacy =
    plan.planningGovernance === 'legacy_unverified' &&
    (plan.status === 'approved' ||
      plan.status === 'in_progress' ||
      plan.status === 'awaiting_release' ||
      plan.status === 'done') &&
    (!options.requireTrustedEvidence ||
      sameLegacyProjectPlanApproval(plan, options.trustedLegacyApproval))
  if (
    !approvedLegacy &&
    (plan.planningGovernance !== 'receipt_verified' ||
      !fingerprintMatches ||
      !currentPlanningEvidence ||
      !trustedEvidenceMatches)
  ) {
    problems.push(
      'salve novamente a revisão atual usando o receipt do método de planejamento entregue pelo Synkora'
    )
  }
  if (!plan.roadmapMeta.complete) {
    problems.push('confirme que o roadmap foi decomposto por completo antes da aprovação')
  }
  if (
    plan.roadmapMeta.expectedCount !== undefined &&
    plan.roadmapMeta.expectedCount !== plan.roadmap.length
  ) {
    problems.push(
      `o roadmap declara ${plan.roadmapMeta.expectedCount} missões, mas contém ${plan.roadmap.length}`
    )
  }
  if (plan.roadmap.length === 0) problems.push('defina ao menos uma missão no roadmap')
  for (const item of plan.roadmap) {
    if (cleanList(item.acceptanceCriteria).length === 0) {
      problems.push(`defina ao menos um critério de aceite para a missão ${item.id}`)
    }
    if (!clean(item.version?.name)) {
      problems.push(`defina a versão-alvo da missão ${item.id}`)
    }
  }

  try {
    validateRoadmapStructure(plan.roadmap)
  } catch (error) {
    problems.push(errorMessage(error))
  }
  problems.push(...validateRoadmapFlow(plan.roadmap))
  return problems
}

export function approveProjectPlan(
  projectRoot: string,
  now?: string,
  options: ProjectPlanValidationOptions = {}
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const problems = validateProjectPlanForApproval(plan, options)
  if (problems.length > 0) {
    throw new ProjectPlanError(
      'invalid_plan',
      `O plano ainda não pode ser aprovado: ${problems.join('; ')}.`
    )
  }

  if (
    plan.status === 'approved' ||
    plan.status === 'in_progress' ||
    plan.status === 'awaiting_release' ||
    plan.status === 'done'
  ) {
    return plan
  }

  const at = timestamp(now)
  const hasExecution = plan.roadmap.some(
    (item) => item.status === 'active' || item.status === 'done'
  )
  const allDone = plan.roadmap.length > 0 && plan.roadmap.every((item) => item.status === 'done')
  const waitingRelease = allDone && hasPendingRelease(plan)
  plan.status = allDone
    ? waitingRelease
      ? 'awaiting_release'
      : 'done'
    : hasExecution
      ? 'in_progress'
      : 'approved'
  plan.approvedAt = at
  plan.completedAt = allDone && !waitingRelease ? at : undefined
  plan.updatedAt = at
  refreshNavigation(plan)
  persistProjectPlan(projectRoot, plan)
  return plan
}

export function startProjectMission(
  projectRoot: string,
  input: StartProjectMissionInput
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const itemId = required(input.itemId, 'itemId')
  const missionId = required(input.missionId, 'missionId')
  const alreadyBound = plan.roadmap.find((item) => item.missionId === missionId)
  if (alreadyBound) {
    if (
      alreadyBound.id === itemId &&
      (alreadyBound.status === 'active' || alreadyBound.status === 'done')
    ) {
      return plan
    }
    throw new ProjectPlanError(
      'mission_id_conflict',
      `A missão ${missionId} já está vinculada ao item ${alreadyBound.id}.`
    )
  }

  if (plan.status !== 'approved' && plan.status !== 'in_progress') {
    throw new ProjectPlanError(
      'approval_required',
      'Aprove o plano mestre antes de abrir a primeira missão.'
    )
  }
  const planProblems = validateProjectPlanForApproval(plan, input.validation)
  if (planProblems.length > 0) {
    throw new ProjectPlanError(
      'approval_required',
      `Revise e aprove o plano mestre antes de seguir: ${planProblems.join('; ')}.`
    )
  }

  const item = plan.roadmap.find((candidate) => candidate.id === itemId)
  if (!item) {
    throw new ProjectPlanError('item_not_found', `O item ${itemId} não existe no roadmap.`)
  }
  if (item.status !== 'planned') {
    throw new ProjectPlanError(
      'item_not_planned',
      `O item ${item.id} está ${item.status} e não pode ser iniciado.`
    )
  }
  const releaseGate = projectPlanReleaseGate(plan)
  if (releaseGate) {
    throw new ProjectPlanError(
      'release_required',
      `Antes de abrir ${item.id}, publique ${releaseGate.versionName}. A próxima versão só começa depois que a anterior chega à base.`
    )
  }

  if (!plan.readyItemIds.includes(item.id)) {
    throw new ProjectPlanError(
      'item_not_planned',
      plan.readyItemIds.length > 0
        ? `As missões liberadas na onda ${plan.currentWaveId ?? 'atual'} são ${plan.readyItemIds.join(', ')}; ${item.id} ainda não pode furar a ordem do roadmap.`
        : `O item ${item.id} ainda não está liberado na onda atual do roadmap.`
    )
  }

  const incomplete = item.dependsOn.filter(
    (dependencyId) =>
      plan.roadmap.find((candidate) => candidate.id === dependencyId)?.status !== 'done'
  )
  if (incomplete.length > 0) {
    throw new ProjectPlanError(
      'dependencies_incomplete',
      `O item ${item.id} ainda depende de: ${incomplete.join(', ')}.`
    )
  }

  const at = timestamp(input.now)
  item.status = 'active'
  item.missionId = missionId
  if (input.release) {
    const plannedVersionName = clean(item.version?.name).toLocaleLowerCase('pt-BR')
    const versionId = required(input.release.versionId, 'release.versionId')
    const versionName = required(input.release.versionName, 'release.versionName')
    item.release = {
      versionId,
      versionName
    }
    // O primeiro item aberto resolve a versão planejada para o id real do
    // backlog. Os itens futuros do mesmo grupo passam a sobreviver inclusive
    // a uma eventual renomeação visual da versão.
    for (const candidate of plan.roadmap) {
      if (
        candidate.version &&
        clean(candidate.version.name).toLocaleLowerCase('pt-BR') === plannedVersionName &&
        (!candidate.version.id || candidate.version.id === versionId)
      ) {
        candidate.version = { ...candidate.version, id: versionId, name: versionName }
        candidate.updatedAt = at
      }
    }
  }
  item.startedAt = at
  item.updatedAt = at
  item.deferredAt = undefined
  item.deferredReason = undefined
  plan.status = 'in_progress'
  plan.completedAt = undefined
  plan.updatedAt = at
  refreshNavigation(plan)
  persistProjectPlan(projectRoot, plan)
  return plan
}

export function completeProjectMission(
  projectRoot: string,
  input: CompleteProjectMissionInput
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const missionId = required(input.missionId, 'missionId')
  const item = plan.roadmap.find((candidate) => candidate.missionId === missionId)
  if (!item) {
    throw new ProjectPlanError(
      'mission_not_found',
      `A missão ${missionId} não está vinculada ao plano mestre.`
    )
  }
  if (item.status === 'done') return plan
  if (item.status !== 'active') {
    throw new ProjectPlanError(
      'mission_not_active',
      `A missão ${missionId} está vinculada a um item ${item.status}, não ativo.`
    )
  }

  const approvalPending = plan.status === 'revision_pending'
  const at = timestamp(input.now)
  item.status = 'done'
  item.outcome = required(input.outcome, 'outcome')
  item.completedAt = at
  item.updatedAt = at
  plan.updatedAt = at
  refreshNavigation(plan)
  const allDone =
    plan.roadmap.length > 0 &&
    plan.roadmap.every((candidate) => isTerminal(candidate.status))
  if (
    !approvalPending &&
    allDone &&
    !hasPendingRelease(plan)
  ) {
    plan.status = 'done'
    plan.completedAt = at
  } else if (!approvalPending && allDone) {
    plan.status = 'awaiting_release'
    plan.completedAt = undefined
  } else {
    plan.status = approvalPending ? 'revision_pending' : 'in_progress'
    plan.completedAt = undefined
  }
  persistProjectPlan(projectRoot, plan)
  return plan
}

/**
 * Registra que uma versão planejada finalmente subiu da branch de versão para
 * a base. O produto só vira concluído quando todas as missões acabaram, todas
 * as versões usadas por elas subiram e nenhuma revisão aguarda novo aval.
 */
export function completeProjectPlanRelease(
  projectRoot: string,
  input: CompleteProjectPlanReleaseInput
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const versionId = required(input.versionId, 'versionId')
  const matching = plan.roadmap.filter((item) => item.release?.versionId === versionId)
  if (matching.length === 0 || matching.every((item) => item.release?.releasedAt)) return plan

  const at = timestamp(input.now)
  for (const item of matching) {
    if (item.release) item.release.releasedAt = at
    item.updatedAt = at
  }
  plan.updatedAt = at
  const allDone =
    plan.roadmap.length > 0 && plan.roadmap.every((item) => item.status === 'done')
  if (allDone && !hasPendingRelease(plan) && plan.status === 'awaiting_release') {
    plan.status = 'done'
    plan.completedAt = at
  }
  refreshNavigation(plan)
  persistProjectPlan(projectRoot, plan)
  return plan
}

/** Missões futuras da mesma versão (ou ainda sem versão) bloqueiam publicação. */
export function projectPlanReleaseBlockers(
  plan: ProjectPlan,
  target: ProjectPlanReleaseTarget
): ProjectPlanItem[] {
  const targetName = clean(target.versionName).toLocaleLowerCase('pt-BR')
  return plan.roadmap.filter((item) => {
    if (item.status === 'done') return false
    const versionName = clean(item.version?.name)
    if (!versionName) return true
    return (
      item.version?.id === target.versionId ||
      versionName.toLocaleLowerCase('pt-BR') === targetName
    )
  })
}

/**
 * Entre dois blocos de versão, a versão anterior precisa chegar à base antes
 * de a primeira missão da seguinte nascer. O gate é derivado do mapa para não
 * depender da memória do pane do Maestro nem de uma dependência explícita.
 */
export function projectPlanExecutionWindow(plan: ProjectPlan): ProjectPlanExecutionWindow {
  const firstOpen = plan.roadmap.find((item) => item.status !== 'done')
  if (!firstOpen) {
    return {
      itemIds: [],
      activeItemIds: [],
      readyItemIds: [],
      deferredItemIds: [],
      pausedByDeferred: false
    }
  }

  const currentVersion = firstOpen.version ? { ...firstOpen.version } : undefined
  const currentWaveId = firstOpen.wave.id
  const waveItems = plan.roadmap.filter(
    (item) => item.wave.id === currentWaveId && sameProjectPlanVersionOrEmpty(item.version, currentVersion)
  )
  const activeItemIds = waveItems
    .filter((item) => item.status === 'active')
    .map((item) => item.id)
  const deferredItemIds = waveItems
    .filter((item) => item.status === 'deferred')
    .map((item) => item.id)
  const pausedByDeferred = deferredItemIds.length > 0
  const releaseGate = activeItemIds.length === 0
    ? releaseGateForWave(plan, waveItems, currentVersion)
    : undefined
  const canAdvance = plan.status === 'approved' || plan.status === 'in_progress'
  const readyItemIds =
    canAdvance && !pausedByDeferred && !releaseGate
      ? waveItems
          .filter(
            (item) =>
              item.status === 'planned' &&
              item.dependsOn.every(
                (dependencyId) =>
                  plan.roadmap.find((candidate) => candidate.id === dependencyId)?.status === 'done'
              )
          )
          .map((item) => item.id)
      : []

  return {
    currentWaveId,
    currentVersion,
    itemIds: waveItems.map((item) => item.id),
    activeItemIds,
    readyItemIds,
    deferredItemIds,
    pausedByDeferred,
    releaseGate
  }
}

export function projectPlanReleaseGate(
  plan: ProjectPlan
): ProjectPlanReleaseTarget | undefined {
  return projectPlanExecutionWindow(plan).releaseGate
}

function releaseGateForWave(
  plan: ProjectPlan,
  waveItems: ProjectPlanItem[],
  currentVersion: ProjectPlanVersion | undefined
): ProjectPlanReleaseTarget | undefined {
  const first = waveItems[0]
  if (!first) return undefined
  const nextIndex = plan.roadmap.findIndex((item) => item.id === first.id)
  for (const item of plan.roadmap.slice(0, nextIndex)) {
    if (item.status !== 'done' || !item.release || item.release.releasedAt) continue
    const releasedVersion: ProjectPlanVersion = {
      id: item.release.versionId,
      name: item.release.versionName
    }
    if (!sameProjectPlanVersion(releasedVersion, currentVersion)) {
      return {
        versionId: item.release.versionId,
        versionName: item.release.versionName
      }
    }
  }
  return undefined
}

export function deferProjectMission(
  projectRoot: string,
  input: DeferProjectMissionInput
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const itemId = required(input.itemId, 'itemId')
  const item = plan.roadmap.find((candidate) => candidate.id === itemId)
  if (!item) {
    throw new ProjectPlanError('item_not_found', `O item ${itemId} não existe no roadmap.`)
  }
  if (item.status === 'deferred') return plan
  if (item.status !== 'planned' && item.status !== 'active') {
    throw new ProjectPlanError(
      'item_not_planned',
      `Somente itens planejados ou ativos podem ser adiados; ${item.id} está ${item.status}.`
    )
  }

  const wasActive = item.status === 'active'
  const previousPlanStatus = plan.status
  const at = timestamp(input.now)
  item.status = 'deferred'
  item.deferredReason = clean(input.reason) || undefined
  item.deferredAt = at
  item.updatedAt = at
  plan.updatedAt = at
  if (wasActive) {
    // Arquivar uma missão real pausa o roteiro; não significa que o produto
    // inteiro foi concluído. O vínculo fica guardado para uma reativação fiel.
    plan.status =
      previousPlanStatus === 'revision_pending' ? 'revision_pending' : 'in_progress'
    plan.completedAt = undefined
  }
  refreshNavigation(plan)
  persistProjectPlan(projectRoot, plan)
  return plan
}

export function reactivateProjectMission(
  projectRoot: string,
  input: ReactivateProjectMissionInput
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const itemId = required(input.itemId, 'itemId')
  const item = plan.roadmap.find((candidate) => candidate.id === itemId)
  if (!item) {
    throw new ProjectPlanError('item_not_found', `O item ${itemId} não existe no roadmap.`)
  }
  if (item.status === 'planned') return plan
  if (item.status !== 'deferred') {
    throw new ProjectPlanError(
      'item_not_planned',
      `Somente itens adiados podem ser reativados; ${item.id} está ${item.status}.`
    )
  }

  if (item.missionId && (plan.status === 'draft' || plan.status === 'revision_pending')) {
    throw new ProjectPlanError(
      'approval_required',
      'O roadmap mudou enquanto a missão estava arquivada. Aprove o plano novamente antes de reativá-la.'
    )
  }
  if (item.missionId) {
    const window = projectPlanExecutionWindow(plan)
    if (window.currentWaveId !== item.wave.id || !window.itemIds.includes(item.id)) {
      throw new ProjectPlanError(
        'item_not_planned',
        `A missão arquivada ${item.id} pertence à onda ${item.wave.id}; resolva primeiro a onda ${window.currentWaveId ?? 'anterior'}.`
      )
    }
    if (window.releaseGate) {
      throw new ProjectPlanError(
        'release_required',
        `Publique ${window.releaseGate.versionName} antes de reativar ${item.id}.`
      )
    }
    const incomplete = item.dependsOn.filter(
      (dependencyId) =>
        plan.roadmap.find((candidate) => candidate.id === dependencyId)?.status !== 'done'
    )
    if (incomplete.length > 0) {
      throw new ProjectPlanError(
        'dependencies_incomplete',
        `O item ${item.id} ainda depende de: ${incomplete.join(', ')}.`
      )
    }
  }

  const previousPlanStatus = plan.status
  const at = timestamp(input.now)
  item.status = item.missionId ? 'active' : 'planned'
  item.deferredReason = undefined
  item.deferredAt = undefined
  item.updatedAt = at
  plan.status = item.missionId
    ? 'in_progress'
    : previousPlanStatus === 'draft' || previousPlanStatus === 'revision_pending'
      ? previousPlanStatus
      : plan.roadmap.some((candidate) => candidate.status === 'done')
        ? 'in_progress'
        : 'approved'
  plan.completedAt = undefined
  plan.updatedAt = at
  refreshNavigation(plan)
  persistProjectPlan(projectRoot, plan)
  return plan
}

/**
 * Uma missão arquivada que foi excluída deixa de existir, mas o objetivo do
 * roadmap continua pendente. O item volta a "planned" e poderá gerar uma nova
 * missão depois, sem carregar um id morto.
 */
export function detachProjectMission(
  projectRoot: string,
  input: DetachProjectMissionInput
): ProjectPlan {
  const plan = requirePlan(projectRoot)
  const missionId = required(input.missionId, 'missionId')
  const item = plan.roadmap.find((candidate) => candidate.missionId === missionId)
  if (!item) return plan
  if (item.status === 'active') {
    throw new ProjectPlanError(
      'mission_not_active',
      `Arquive a missão ${missionId} antes de remover seu vínculo com o roadmap.`
    )
  }
  if (item.status === 'done') return plan

  const previousPlanStatus = plan.status
  const at = timestamp(input.now)
  item.status = 'planned'
  item.missionId = undefined
  item.release = undefined
  item.startedAt = undefined
  item.deferredAt = undefined
  item.deferredReason = undefined
  item.updatedAt = at
  plan.status =
    previousPlanStatus === 'draft' || previousPlanStatus === 'revision_pending'
      ? previousPlanStatus
      : plan.roadmap.some((candidate) => candidate.status === 'done')
        ? 'in_progress'
        : 'approved'
  plan.completedAt = undefined
  plan.updatedAt = at
  refreshNavigation(plan)
  persistProjectPlan(projectRoot, plan)
  return plan
}

export function renderProjectPlanMarkdown(plan: ProjectPlan): string {
  const done = plan.roadmap.filter((item) => item.status === 'done').length
  const window = projectPlanExecutionWindow(plan)
  const activeItems = window.activeItemIds
    .map((id) => plan.roadmap.find((item) => item.id === id))
    .filter((item): item is ProjectPlanItem => Boolean(item))
  const readyItems = window.readyItemIds
    .map((id) => plan.roadmap.find((item) => item.id === id))
    .filter((item): item is ProjectPlanItem => Boolean(item))
  const active = activeItems[0]
  const next = readyItems[0]
  const releaseGate = projectPlanReleaseGate(plan)
  const deferredGate = deferredRoadmapGate(plan)
  const lines: string[] = [
    `# Plano mestre — ${plan.projectName || 'Projeto sem nome'}`,
    '',
    `> Estado: **${statusLabel(plan.status)}** · Progresso: **${done}/${plan.roadmap.length} missões concluídas**`,
    `> Etapa do fluxo: **${flowStageLabel(plan)}**`,
    `> Roadmap: **${plan.roadmapMeta.complete ? 'decomposição completa' : 'decomposição em andamento'}**${plan.roadmapMeta.expectedCount === undefined ? '' : ` · ${plan.roadmap.length}/${plan.roadmapMeta.expectedCount} missões mapeadas`}`,
    '',
    'Este documento é o mapa contínuo do projeto. O Maestro o atualiza quando o plano muda,',
    'quando uma missão começa e quando uma entrega termina. O arquivo JSON ao lado é a fonte de verdade.',
    '',
    '## Norte do projeto',
    '',
    '### Problema',
    '',
    plan.problem || '_Problema ainda em definição._',
    '',
    '### Público',
    '',
    plan.audience || '_Público ainda em definição._',
    '',
    '### Visão',
    '',
    plan.vision || '_Visão ainda em construção._',
    '',
    '## Critérios de sucesso',
    ''
  ]
  appendList(lines, plan.successCriteria, '_Ainda não definidos._')
  lines.push('', '## Restrições e limites conhecidos', '')
  appendList(lines, plan.constraints, '_Nenhuma restrição registrada ainda._')

  lines.push('', '## Fluxo agora', '')
  lines.push(
    `- **Onda atual:** ${window.currentWaveId ? `\`${window.currentWaveId}\`` : 'nenhuma'}`
  )
  lines.push(
    activeItems.length > 0
      ? `- **Missões ativas:** ${activeItems.map((item) => `${item.title} (\`${item.id}\`)${item.missionId ? ` — Synkora \`${item.missionId}\`` : ''}`).join('; ')}`
      : '- **Missões ativas:** nenhuma'
  )
  lines.push(
    readyItems.length > 0
      ? `- **Missões prontas para abrir:** ${readyItems.map((item) => `${item.title} (\`${item.id}\`)`).join('; ')}`
      : releaseGate
        ? `- **Missões prontas:** bloqueadas até publicar **${releaseGate.versionName}** na base`
        : deferredGate
          ? `- **Missões prontas:** onda pausada em **${deferredGate.title}** (\`${deferredGate.id}\`)`
        : plan.status === 'done'
          ? '- **Missões prontas:** projeto concluído'
          : '- **Missões prontas:** aguardando aprovação, conclusão da onda ou revisão do roadmap'
  )
  lines.push(`- **O que fazer agora:** ${nextActionLabel(plan, active, next)}`)
  lines.push('- **Regra:** missões da mesma onda podem avançar em paralelo; a onda seguinte só abre quando a atual terminar.')

  lines.push('', '## Roadmap de missões', '')
  if (plan.roadmap.length === 0) {
    lines.push('_O roadmap será construído com o usuário antes da primeira missão._')
  } else {
    plan.roadmap.forEach((item, index) => {
      lines.push(`### ${index + 1}. ${itemIcon(item.status)} ${item.title} (\`${item.id}\`)`, '')
      lines.push(`- **Estado:** ${itemStatusLabel(item.status)}`)
      lines.push(`- **Onda:** ${item.wave.id}${item.wave.name ? ` — ${item.wave.name}` : ''}`)
      lines.push(`- **Objetivo:** ${item.objective}`)
      lines.push(
        `- **Escopo — dentro:** ${item.scope.in.length > 0 ? item.scope.in.join('; ') : 'a detalhar'}`
      )
      lines.push(
        `- **Escopo — fora:** ${item.scope.out.length > 0 ? item.scope.out.join('; ') : 'a detalhar'}`
      )
      lines.push(
        `- **Depende de:** ${item.dependsOn.length > 0 ? item.dependsOn.map((id) => `\`${id}\``).join(', ') : 'nada'}`
      )
      lines.push(
        `- **Critérios de aceite:** ${item.acceptanceCriteria.length > 0 ? item.acceptanceCriteria.join('; ') : 'a detalhar'}`
      )
      if (item.version) lines.push(`- **Versão-alvo:** ${versionLabel(item.version)}`)
      if (item.release) {
        lines.push(
          `- **Publicação da versão:** ${item.release.versionName} — ${item.release.releasedAt ? `subiu para a base em ${item.release.releasedAt}` : 'aguardando subir para a base'}`
        )
      }
      if (item.missionId) lines.push(`- **Missão Synkora:** \`${item.missionId}\``)
      if (item.outcome) lines.push(`- **Resultado:** ${item.outcome}`)
      if (item.deferredReason) lines.push(`- **Motivo do adiamento:** ${item.deferredReason}`)
      lines.push('')
    })
    if (lines.at(-1) === '') lines.pop()
  }

  lines.push('', '## Skills de planejamento declaradas', '')
  if (plan.planningSkills.length === 0) {
    lines.push('_Nenhuma skill declarada ainda._')
  } else {
    for (const entry of plan.planningSkills) {
      lines.push(
        `- **${entry.id}** · ${planningStageLabel(entry.stage)} · ${entry.contribution} (${entry.usedAt})${
          entry.receiptId && entry.planningRevision
            ? ` · receipt \`${entry.receiptId}\` · revisão ${entry.planningRevision}`
            : ' · legado não verificado'
        }`
      )
    }
  }

  lines.push('', '## Escopo combinado', '', '### Dentro', '')
  appendList(lines, plan.scope.in, '_Ainda não definido._')
  lines.push('', '### Fora por enquanto', '')
  appendList(lines, plan.scope.out, '_Ainda não definido._')
  lines.push('', '## Decisões importantes', '')
  appendList(lines, plan.decisions, '_Nenhuma decisão registrada ainda._')
  lines.push('', '---', '', `Última atualização: ${plan.updatedAt}`, '')
  return lines.join('\n')
}

export function summarizeProjectPlanForBoard(plan: ProjectPlan | undefined): string {
  if (!plan) return ''
  const done = plan.roadmap.filter((item) => item.status === 'done').length
  const window = projectPlanExecutionWindow(plan)
  const activeItems = window.activeItemIds
    .map((id) => plan.roadmap.find((item) => item.id === id))
    .filter((item): item is ProjectPlanItem => Boolean(item))
  const readyItems = window.readyItemIds
    .map((id) => plan.roadmap.find((item) => item.id === id))
    .filter((item): item is ProjectPlanItem => Boolean(item))
  const active = activeItems[0]
  const next = readyItems[0]
  const releaseGate = projectPlanReleaseGate(plan)
  const deferredGate = deferredRoadmapGate(plan)
  const lines = [
    `Plano mestre: ${statusLabel(plan.status)} (${done}/${plan.roadmap.length} missões concluídas).`,
    `Etapa do fluxo: ${flowStageLabel(plan)}.`,
    `Onda atual: ${window.currentWaveId ?? 'nenhuma'}.`,
    activeItems.length > 0
      ? `Missões ativas: ${activeItems.map((item) => `${item.title} [${item.id}]`).join('; ')}.`
      : 'Missões ativas: nenhuma.',
    readyItems.length > 0
      ? `Missões prontas: ${readyItems.map((item) => `${item.title} [${item.id}]`).join('; ')}.`
      : releaseGate
        ? `Missões prontas: bloqueadas até publicar ${releaseGate.versionName} na base.`
        : deferredGate
          ? `Missões prontas: onda pausada em ${deferredGate.title} [${deferredGate.id}].`
      : plan.status === 'done'
        ? 'Missões prontas: projeto concluído.'
        : 'Missões prontas: ainda não liberadas.',
    `Skills declaradas: ${plan.planningSkills.length > 0 ? [...new Set(plan.planningSkills.map((entry) => entry.id))].join(', ') : 'nenhuma'}.`,
    `O que fazer agora: ${nextActionLabel(plan, active, next)}`,
    `Mapa: ${PROJECT_PLAN_DIRECTORY}/${PROJECT_PLAN_MARKDOWN}.`
  ]
  return lines.join('\n')
}

function persistProjectPlan(projectRoot: string, plan: ProjectPlan): void {
  removeUndefinedOptionalFields(plan)
  assertStoredPlan(plan)
  const paths = projectPlanPaths(projectRoot)
  mkdirSync(paths.directory, { recursive: true })
  writePlanFiles(paths, plan)
}

function writePlanFiles(paths: ReturnType<typeof projectPlanPaths>, plan: ProjectPlan): void {
  mkdirSync(paths.directory, { recursive: true })
  const serialized = `${JSON.stringify(plan, null, 2)}\n`
  // ÚNICO ponto de commit: se esta troca falhar, nada novo é considerado
  // persistido e o chamador pode desfazer os outros stores com segurança.
  atomicWrite(paths.json, serialized)
  // Backup e Markdown são derivados. Falha neles não transforma um commit
  // autoritativo bem-sucedido em erro; todo load tenta repará-los novamente.
  repairDerivedPlanFiles(paths, plan, serialized)
}

function repairDerivedPlanFiles(
  paths: ReturnType<typeof projectPlanPaths>,
  plan: ProjectPlan,
  serialized = `${JSON.stringify(plan, null, 2)}\n`
): void {
  try {
    if (!existsSync(paths.backup) || readFileSync(paths.backup, 'utf8') !== serialized) {
      atomicWrite(paths.backup, serialized)
    }
  } catch {
    // derivado reparável no próximo load
  }
  const markdown = renderProjectPlanMarkdown(plan)
  try {
    if (!existsSync(paths.markdown) || readFileSync(paths.markdown, 'utf8') !== markdown) {
      atomicWrite(paths.markdown, markdown)
    }
  } catch {
    // derivado reparável no próximo load
  }
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // rename bem-sucedido ou temporário nunca criado
    }
    throw error
  }
}

function parseStoredPlan(file: string): { plan: ProjectPlan; changed: boolean } {
  const stored: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const migrated = migrateStoredPlan(stored)
  assertStoredPlan(migrated.plan)
  const beforeNavigation = JSON.stringify(migrated.plan)
  refreshNavigation(migrated.plan)
  return {
    plan: migrated.plan,
    changed: migrated.changed || JSON.stringify(migrated.plan) !== beforeNavigation
  }
}

function migrateStoredPlan(value: unknown): { plan: ProjectPlan; changed: boolean } {
  if (!value || typeof value !== 'object') {
    return { plan: value as ProjectPlan, changed: false }
  }
  const legacy = value as Record<string, unknown>
  if (legacy.schemaVersion === PROJECT_PLAN_SCHEMA_VERSION) {
    const current = legacy as unknown as ProjectPlan
    const lastReceiptRevision = Array.isArray(current.planningSkills)
      ? current.planningSkills
          .slice()
          .reverse()
          .find((entry) => typeof entry?.planningRevision === 'string')?.planningRevision
      : undefined
    const planningRevision =
      typeof current.planningRevision === 'string'
        ? current.planningRevision
        : lastReceiptRevision ?? current.updatedAt
    const calculatedPlanningFingerprint = projectPlanContentFingerprint(current)
    const planningFingerprint =
      typeof current.planningFingerprint === 'string'
        ? current.planningFingerprint
        : calculatedPlanningFingerprint
    const hasVerifiedReceipt = Array.isArray(current.planningSkills)
      ? current.planningSkills.some((entry) =>
          isVerifiedProjectPlanningEvidence(
            entry,
            planningRevision,
            planningFingerprint
          )
        )
      : false
    const knownGovernance = [
      'receipt_required',
      'receipt_verified',
      'legacy_unverified'
    ].includes(current.planningGovernance)
    const planningGovernance = knownGovernance
      ? current.planningGovernance
      :
      (hasVerifiedReceipt
        ? 'receipt_verified'
        : current.status === 'approved' ||
            current.status === 'in_progress' ||
            current.status === 'awaiting_release' ||
            current.status === 'done'
          ? 'legacy_unverified'
          : 'receipt_required')
    if (
      current.planningRevision === planningRevision &&
      current.planningFingerprint === planningFingerprint &&
      current.planningGovernance === planningGovernance
    ) {
      return { plan: current, changed: false }
    }
    return {
      plan: { ...current, planningRevision, planningFingerprint, planningGovernance },
      changed: true
    }
  }
  if (legacy.schemaVersion !== LEGACY_PROJECT_PLAN_SCHEMA_VERSION) {
    return { plan: value as ProjectPlan, changed: false }
  }
  const legacyRoadmap = Array.isArray(legacy.roadmap) ? legacy.roadmap : []
  const roadmap = legacyRoadmap.map((rawItem, index) => ({
    ...(rawItem as Record<string, unknown>),
    wave: { id: formatWaveId(index + 1) }
  })) as unknown as ProjectPlanItem[]
  const plan = {
    ...legacy,
    schemaVersion: PROJECT_PLAN_SCHEMA_VERSION,
    roadmapMeta: {
      expectedCount: roadmap.length,
      complete: roadmap.length > 0
    },
    roadmap,
    planningSkills: [],
    planningRevision: String(legacy.updatedAt ?? ''),
    planningFingerprint: '',
    planningGovernance:
      legacy.status === 'approved' ||
      legacy.status === 'in_progress' ||
      legacy.status === 'awaiting_release' ||
      legacy.status === 'done'
        ? 'legacy_unverified'
        : 'receipt_required',
    activeItemIds: roadmap.filter((item) => item.status === 'active').map((item) => item.id),
    readyItemIds: []
  } as unknown as ProjectPlan
  plan.planningFingerprint = projectPlanContentFingerprint(plan)
  refreshNavigation(plan)
  return { plan, changed: true }
}

function removeUndefinedOptionalFields(plan: ProjectPlan): void {
  for (const key of [
    'currentWaveId',
    'activeItemId',
    'nextItemId',
    'approvedAt',
    'completedAt'
  ] as const) {
    if (plan[key] === undefined) delete plan[key]
  }
  if (plan.roadmapMeta.expectedCount === undefined) delete plan.roadmapMeta.expectedCount
  for (const item of plan.roadmap) {
    for (const key of [
      'missionId',
      'outcome',
      'deferredReason',
      'startedAt',
      'completedAt',
      'deferredAt'
    ] as const) {
      if (item[key] === undefined) delete item[key]
    }
    if (item.version) {
      for (const key of ['id', 'theme', 'goal'] as const) {
        if (item.version[key] === undefined) delete item.version[key]
      }
    }
    if (item.wave.name === undefined) delete item.wave.name
    if (item.release?.releasedAt === undefined) delete item.release?.releasedAt
  }
}

function requirePlan(projectRoot: string): ProjectPlan {
  const plan = loadProjectPlan(projectRoot)
  if (!plan) {
    throw new ProjectPlanError(
      'plan_not_found',
      `Nenhum plano mestre foi encontrado em ${PROJECT_PLAN_DIRECTORY}/${PROJECT_PLAN_JSON}.`
    )
  }
  return plan
}

interface NormalizedDraftItem {
  id: string
  title: string
  objective: string
  dependsOn?: string[]
  scope?: Partial<ProjectPlanScope>
  acceptanceCriteria?: string[]
  wave?: ProjectPlanWave
  version?: Partial<ProjectPlanVersion> & { name: string }
}

function normalizeDraftItems(items: ProjectPlanDraftItem[]): NormalizedDraftItem[] {
  if (!Array.isArray(items)) {
    throw new ProjectPlanError('invalid_plan', 'O roadmap precisa ser uma lista de missões.')
  }
  if (items.length > MAX_PROJECT_PLAN_ITEMS) {
    throw new ProjectPlanError(
      'invalid_plan',
      `O roadmap pode conter no máximo ${MAX_PROJECT_PLAN_ITEMS} missões.`
    )
  }
  const normalized = items.map((item, index) => ({
    id: required(item?.id, `roadmap[${index}].id`),
    title: required(item?.title, `roadmap[${index}].title`),
    objective: required(item?.objective, `roadmap[${index}].objective`),
    dependsOn: item?.dependsOn === undefined ? undefined : cleanList(item.dependsOn),
    scope:
      item?.scope === undefined
        ? undefined
        : {
            in: item.scope.in === undefined ? undefined : cleanList(item.scope.in),
            out: item.scope.out === undefined ? undefined : cleanList(item.scope.out)
          },
    acceptanceCriteria:
      item?.acceptanceCriteria === undefined
        ? undefined
        : cleanList(item.acceptanceCriteria),
    wave: item?.wave === undefined ? undefined : normalizeWave(item.wave, index),
    version:
      item?.version === undefined ? undefined : normalizeVersion(item.version, index)
  }))
  const ids = new Set<string>()
  for (const item of normalized) {
    if (ids.has(item.id)) {
      throw new ProjectPlanError(
        'invalid_plan',
        `O roadmap contém o id duplicado “${item.id}”. Cada missão planejada precisa de um id único.`
      )
    }
    ids.add(item.id)
  }
  return normalized
}

const WAVE_NATURAL_RE = /^O0*(\d+)([a-z]*)(?=-|$)/i

/** O array do roadmap é a autoridade de execução, e o merge appenda item novo
 *  no FIM — uma onda "O02b" criada depois rodaria após a O10 (bug real
 *  2026-08-04). Quando TODOS os ids de onda seguem a convenção
 *  O<número><sufixo>, os blocos são reordenados por ordem natural
 *  (O02 < O02b < O03 < O10), estável dentro da onda — de quebra reagrupa item
 *  novo de onda existente, que o push espalharia. Qualquer id fora do padrão
 *  desativa o sort: a ordem do autor prevalece. */
function sortWavesNaturally(roadmap: ProjectPlanItem[]): ProjectPlanItem[] {
  const groups: { num: number; suffix: string; items: ProjectPlanItem[] }[] = []
  const byWave = new Map<string, { items: ProjectPlanItem[] }>()
  for (const item of roadmap) {
    const found = byWave.get(item.wave.id)
    if (found) {
      found.items.push(item)
      continue
    }
    const match = WAVE_NATURAL_RE.exec(item.wave.id)
    if (!match) return roadmap
    const group = { num: Number(match[1]), suffix: match[2].toLowerCase(), items: [item] }
    byWave.set(item.wave.id, group)
    groups.push(group)
  }
  return groups
    .slice()
    .sort((a, b) => a.num - b.num || a.suffix.localeCompare(b.suffix))
    .flatMap((group) => group.items)
}

function applyRoadmapDraft(
  existing: ProjectPlanItem[],
  draftItems: NormalizedDraftItem[] | undefined,
  mode: 'merge' | 'replace',
  now: string
): ProjectPlanItem[] {
  if (draftItems === undefined) return existing.map(cloneItem)
  const existingById = new Map(existing.map((item) => [item.id, item]))
  const reservedWaveIds = new Set([
    ...existing.map((item) => item.wave.id),
    ...draftItems.flatMap((item) => (item.wave ? [item.wave.id] : []))
  ])
  let fallbackWaveNumber = existing.length + 1
  const fallbackWave = (): ProjectPlanWave => {
    let id = formatWaveId(fallbackWaveNumber)
    while (reservedWaveIds.has(id)) {
      fallbackWaveNumber += 1
      id = formatWaveId(fallbackWaveNumber)
    }
    fallbackWaveNumber += 1
    reservedWaveIds.add(id)
    return { id }
  }
  const fromDraft = (item: NormalizedDraftItem): ProjectPlanItem => {
    const previous = existingById.get(item.id)
    // Depois que uma missão real existe, seu briefing não pode ser reescrito
    // por um patch de roadmap. Arquive/reative/conclua pelo lifecycle próprio.
    if (previous?.missionId || previous?.status === 'active' || previous?.status === 'done') {
      return cloneItem(previous)
    }
    const preserve = mode === 'merge' ? previous : undefined
    return {
      id: item.id,
      title: item.title,
      objective: item.objective,
      status: previous?.status === 'deferred' ? 'deferred' : 'planned',
      dependsOn: item.dependsOn ?? preserve?.dependsOn ?? [],
      scope: {
        in: item.scope?.in ?? preserve?.scope.in ?? [],
        out: item.scope?.out ?? preserve?.scope.out ?? []
      },
      acceptanceCriteria:
        item.acceptanceCriteria ?? preserve?.acceptanceCriteria ?? [],
      wave: item.wave
        ? { ...(preserve?.wave ?? {}), ...item.wave }
        : preserve?.wave
          ? { ...preserve.wave }
          : fallbackWave(),
      version:
        item.version === undefined
          ? preserve?.version
            ? { ...preserve.version }
            : undefined
          : mergeDraftVersion(preserve?.version, item.version),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(previous?.status === 'deferred'
        ? {
            deferredReason: previous.deferredReason,
            deferredAt: previous.deferredAt
          }
        : {})
    }
  }

  if (mode === 'merge') {
    const roadmap = existing.map(cloneItem)
    for (const draft of draftItems) {
      const next = fromDraft(draft)
      const index = roadmap.findIndex((item) => item.id === draft.id)
      if (index >= 0) roadmap[index] = next
      else roadmap.push(next)
    }
    return sortWavesNaturally(roadmap)
  }

  const proposedIds = new Set(draftItems.map((item) => item.id))
  const protectedHistory = existing
    .filter(
      (item) =>
        Boolean(item.missionId || item.status === 'active' || item.status === 'done') &&
        !proposedIds.has(item.id)
    )
    .map(cloneItem)
  return sortWavesNaturally([...protectedHistory, ...draftItems.map(fromDraft)])
}

function normalizeWave(value: unknown, itemIndex: number): ProjectPlanWave {
  if (!value || typeof value !== 'object') {
    throw new ProjectPlanError(
      'invalid_plan',
      `roadmap[${itemIndex}].wave precisa ser um objeto estruturado.`
    )
  }
  const wave = value as Partial<ProjectPlanWave>
  return {
    id: required(wave.id, `roadmap[${itemIndex}].wave.id`),
    ...(wave.name === undefined ? {} : { name: clean(wave.name) || undefined })
  }
}

function normalizeVersion(
  value: unknown,
  itemIndex: number
): (Partial<ProjectPlanVersion> & { name: string }) | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') {
    throw new ProjectPlanError(
      'invalid_plan',
      `roadmap[${itemIndex}].version precisa ser um objeto estruturado.`
    )
  }
  const version = value as Partial<ProjectPlanVersion>
  return {
    name: required(version.name, `roadmap[${itemIndex}].version.name`),
    ...(version.id === undefined ? {} : { id: clean(version.id) || undefined }),
    ...(version.theme === undefined ? {} : { theme: clean(version.theme) || undefined }),
    ...(version.goal === undefined ? {} : { goal: clean(version.goal) || undefined })
  }
}

function validateRoadmapStructure(roadmap: ProjectPlanItem[]): void {
  if (roadmap.length > MAX_PROJECT_PLAN_ITEMS) {
    throw new ProjectPlanError(
      'invalid_plan',
      `O roadmap pode conter no máximo ${MAX_PROJECT_PLAN_ITEMS} missões.`
    )
  }
  const ids = new Set<string>()
  for (const item of roadmap) {
    if (!clean(item.id) || !clean(item.title) || !clean(item.objective)) {
      throw new ProjectPlanError(
        'invalid_plan',
        'Cada missão do roadmap precisa ter id, título e objetivo.'
      )
    }
    if (!item.wave || !clean(item.wave.id)) {
      throw new ProjectPlanError(
        'invalid_plan',
        `O item ${item.id} precisa pertencer a uma onda identificada.`
      )
    }
    if (
      !item.scope ||
      !Array.isArray(item.scope.in) ||
      !Array.isArray(item.scope.out) ||
      !Array.isArray(item.acceptanceCriteria)
    ) {
      throw new ProjectPlanError(
        'invalid_plan',
        `O item ${item.id} precisa ter escopo e critérios de aceite estruturados.`
      )
    }
    if (item.version && !clean(item.version.name)) {
      throw new ProjectPlanError(
        'invalid_plan',
        `A versão-alvo do item ${item.id} precisa ter um nome.`
      )
    }
    if (ids.has(item.id)) {
      throw new ProjectPlanError('invalid_plan', `O id ${item.id} aparece mais de uma vez no roadmap.`)
    }
    ids.add(item.id)
  }

  for (const item of roadmap) {
    for (const dependency of item.dependsOn) {
      if (dependency === item.id) {
        throw new ProjectPlanError(
          'invalid_plan',
          `O item ${item.id} não pode depender dele mesmo.`
        )
      }
      if (!ids.has(dependency)) {
        throw new ProjectPlanError(
          'invalid_plan',
          `O item ${item.id} depende de ${dependency}, que não existe no roadmap.`
        )
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(roadmap.map((item) => [item.id, item]))
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      throw new ProjectPlanError(
        'invalid_plan',
        `O roadmap contém um ciclo de dependências envolvendo ${id}.`
      )
    }
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const item of roadmap) visit(item.id)

  const active = roadmap.filter((item) => item.status === 'active')
  if (
    active.length > 1 &&
    active.some(
      (item) =>
        item.wave.id !== active[0].wave.id ||
        !sameProjectPlanVersionOrEmpty(item.version, active[0].version)
    )
  ) {
    throw new ProjectPlanError(
      'invalid_plan',
      'O plano é inválido: missões ativas em paralelo precisam estar na mesma onda e versão.'
    )
  }
}

function validateRoadmapFlow(roadmap: ProjectPlanItem[]): string[] {
  const problems: string[] = []
  const positionById = new Map(roadmap.map((item, index) => [item.id, index]))
  const waveOrder = new Map<string, number>()
  const waveVersion = new Map<string, ProjectPlanVersion | undefined>()
  const closedWaves = new Set<string>()
  let currentWave = ''
  for (const item of roadmap) {
    const waveId = item.wave.id
    if (!waveOrder.has(waveId)) waveOrder.set(waveId, waveOrder.size)
    if (waveId !== currentWave) {
      if (closedWaves.has(waveId)) {
        problems.push(
          `agrupe todas as missões da onda ${waveId} em um único bloco contínuo`
        )
        break
      }
      if (currentWave) closedWaves.add(currentWave)
      currentWave = waveId
    }
    if (!waveVersion.has(waveId)) waveVersion.set(waveId, item.version)
    else if (!sameProjectPlanVersionOrEmpty(waveVersion.get(waveId), item.version)) {
      problems.push(`todas as missões da onda ${waveId} precisam pertencer à mesma versão`)
      break
    }
  }
  for (let index = 0; index < roadmap.length; index += 1) {
    const item = roadmap[index]
    const futureDependency = item.dependsOn.find(
      (dependency) => (positionById.get(dependency) ?? -1) >= index
    )
    if (futureDependency) {
      problems.push(
        `ordene ${futureDependency} antes de ${item.id}: uma missão só pode depender de algo que aparece antes dela no roadmap`
      )
      break
    }
    const invalidWaveDependency = item.dependsOn.find((dependency) => {
      const dependencyItem = roadmap[positionById.get(dependency) ?? -1]
      return (
        dependencyItem &&
        (waveOrder.get(dependencyItem.wave.id) ?? -1) >= (waveOrder.get(item.wave.id) ?? -1)
      )
    })
    if (invalidWaveDependency) {
      problems.push(
        `${item.id} só pode depender de missões de ondas anteriores; ${invalidWaveDependency} não está numa onda anterior`
      )
      break
    }
    if (item.missionId && (item.status === 'active' || item.status === 'deferred')) {
      const earlierOpen = roadmap
        .slice(0, index)
        .find(
          (candidate) =>
            candidate.status !== 'done' && candidate.wave.id !== item.wave.id
        )
      if (earlierOpen) {
        problems.push(
          `mantenha ${item.id} antes de ${earlierOpen.id}: uma missão real ativa ou arquivada não pode ser reposicionada atrás de trabalho novo`
        )
        break
      }
    }
  }

  const seenBlocks = new Set<string>()
  const versionIdsByName = new Map<string, string>()
  const versionNamesById = new Map<string, string>()
  let currentBlock = ''
  let previousOrderedVersion: { name: string; parts: [number, number, number] } | undefined
  for (const item of roadmap) {
    const name = normalizedVersionName(item.version?.name)
    if (!name) continue
    const id = clean(item.version?.id)
    const knownId = versionIdsByName.get(name)
    if (id && knownId && knownId !== id) {
      problems.push(
        `a versão ${item.version?.name} aparece com dois identificadores diferentes; revise a versão-alvo dessas missões`
      )
      break
    }
    const knownName = id ? versionNamesById.get(id) : undefined
    if (id && knownName && knownName !== name) {
      problems.push(
        `o identificador ${id} aparece associado a ${knownName} e ${name}; cada versão precisa manter um único nome`
      )
      break
    }
    if (id) {
      versionIdsByName.set(name, id)
      versionNamesById.set(id, name)
    }
    if (name === currentBlock) continue
    if (seenBlocks.has(name)) {
      problems.push(
        `agrupe todas as missões de ${item.version?.name} em um único bloco contínuo; o roadmap não pode sair de uma versão e voltar a ela depois`
      )
      break
    }
    if (currentBlock) seenBlocks.add(currentBlock)
    currentBlock = name
    const parts = parsePlannedVersionName(name)
    if (
      parts &&
      previousOrderedVersion &&
      comparePlannedVersions(parts, previousOrderedVersion.parts) <= 0
    ) {
      problems.push(
        `ordene as versões de forma crescente: ${item.version?.name} não pode vir depois de ${previousOrderedVersion.name}`
      )
      break
    }
    if (parts) previousOrderedVersion = { name: item.version?.name ?? name, parts }
  }

  const releasedVersions = roadmap
    .filter((item) => item.release?.releasedAt)
    .map(
      (item): ProjectPlanVersion => ({
        id: item.release?.versionId,
        name: item.release?.versionName ?? item.version?.name ?? ''
      })
    )
  const reopened = roadmap.find(
    (item) =>
      item.status !== 'done' &&
      releasedVersions.some((released) => sameProjectPlanVersion(released, item.version))
  )
  if (reopened) {
    problems.push(
      `a versão ${reopened.version?.name} já foi publicada; mova ${reopened.id} para uma versão nova e crescente`
    )
  }
  return problems
}

function assertRealMissionOrderPreserved(
  existing: ProjectPlanItem[],
  proposed: ProjectPlanItem[]
): void {
  for (const item of existing) {
    if (!item.missionId || (item.status !== 'active' && item.status !== 'deferred')) continue
    const oldIndex = existing.findIndex((candidate) => candidate.id === item.id)
    const nextIndex = proposed.findIndex((candidate) => candidate.id === item.id)
    if (nextIndex < 0) continue
    const oldOpenBefore = new Set(
      existing
        .slice(0, oldIndex)
        .filter((candidate) => candidate.status !== 'done')
        .map((candidate) => candidate.id)
    )
    const insertedBefore = proposed
      .slice(0, nextIndex)
      .find(
        (candidate) =>
          candidate.status !== 'done' &&
          candidate.wave.id !== item.wave.id &&
          !oldOpenBefore.has(candidate.id)
      )
    if (insertedBefore) {
      throw new ProjectPlanError(
        'invalid_plan',
        `A missão real ${item.id} está ${item.status === 'active' ? 'ativa' : 'arquivada'} e preserva sua posição. Retome/conclua ou remova seu vínculo antes de colocar ${insertedBefore.id} na frente dela.`
      )
    }
  }
}

function refreshNavigation(plan: ProjectPlan): void {
  const window = projectPlanExecutionWindow(plan)
  plan.activeItemIds = [...window.activeItemIds]
  plan.readyItemIds = [...window.readyItemIds]
  if (window.currentWaveId) plan.currentWaveId = window.currentWaveId
  else delete plan.currentWaveId
  if (plan.activeItemIds[0]) plan.activeItemId = plan.activeItemIds[0]
  else delete plan.activeItemId
  if (plan.readyItemIds[0]) plan.nextItemId = plan.readyItemIds[0]
  else delete plan.nextItemId
}

function deferredRoadmapGate(plan: ProjectPlan): ProjectPlanItem | undefined {
  const deferredId = projectPlanExecutionWindow(plan).deferredItemIds[0]
  return deferredId
    ? plan.roadmap.find((item) => item.id === deferredId)
    : undefined
}

function assertStoredPlan(value: unknown): asserts value is ProjectPlan {
  if (!value || typeof value !== 'object') {
    throw new ProjectPlanError('invalid_plan', 'O plano mestre precisa ser um objeto JSON.')
  }
  const plan = value as Partial<ProjectPlan>
  const statuses: ProjectPlanStatus[] = [
    'draft',
    'approved',
    'in_progress',
    'revision_pending',
    'awaiting_release',
    'done'
  ]
  const itemStatuses: ProjectPlanItemStatus[] = ['planned', 'active', 'done', 'deferred']
  if (plan.schemaVersion !== PROJECT_PLAN_SCHEMA_VERSION || plan.origin !== 'greenfield') {
    throw new ProjectPlanError('invalid_plan', 'Versão ou origem do plano mestre não reconhecida.')
  }
  if (!plan.status || !statuses.includes(plan.status)) {
    throw new ProjectPlanError('invalid_plan', 'Estado geral do plano mestre inválido.')
  }
  if (
    typeof plan.projectName !== 'string' ||
    typeof plan.problem !== 'string' ||
    typeof plan.audience !== 'string' ||
    typeof plan.vision !== 'string' ||
    !Array.isArray(plan.successCriteria) ||
    !Array.isArray(plan.constraints) ||
    !plan.scope ||
    !Array.isArray(plan.scope.in) ||
    !Array.isArray(plan.scope.out) ||
    !Array.isArray(plan.decisions) ||
    !plan.roadmapMeta ||
    typeof plan.roadmapMeta.complete !== 'boolean' ||
    (plan.roadmapMeta.expectedCount !== undefined &&
      (!Number.isInteger(plan.roadmapMeta.expectedCount) ||
        plan.roadmapMeta.expectedCount < 0 ||
        plan.roadmapMeta.expectedCount > MAX_PROJECT_PLAN_ITEMS)) ||
    !Array.isArray(plan.roadmap) ||
    !Array.isArray(plan.planningSkills) ||
    typeof plan.planningRevision !== 'string' ||
    typeof plan.planningFingerprint !== 'string' ||
    !['receipt_required', 'receipt_verified', 'legacy_unverified'].includes(
      plan.planningGovernance ?? ''
    ) ||
    !Array.isArray(plan.activeItemIds) ||
    plan.activeItemIds.some((id) => typeof id !== 'string') ||
    !Array.isArray(plan.readyItemIds) ||
    plan.readyItemIds.some((id) => typeof id !== 'string') ||
    (plan.currentWaveId !== undefined && typeof plan.currentWaveId !== 'string') ||
    typeof plan.createdAt !== 'string' ||
    typeof plan.updatedAt !== 'string'
  ) {
    throw new ProjectPlanError('invalid_plan', 'Estrutura do plano mestre incompleta ou inválida.')
  }
  for (const item of plan.roadmap) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.objective !== 'string' ||
      !itemStatuses.includes(item.status) ||
      !Array.isArray(item.dependsOn) ||
      !item.scope ||
      !Array.isArray(item.scope.in) ||
      !Array.isArray(item.scope.out) ||
      !Array.isArray(item.acceptanceCriteria) ||
      !item.wave ||
      typeof item.wave.id !== 'string' ||
      (item.wave.name !== undefined && typeof item.wave.name !== 'string') ||
      (item.version !== undefined &&
        (typeof item.version !== 'object' || typeof item.version.name !== 'string')) ||
      (item.release !== undefined &&
        (typeof item.release !== 'object' ||
          typeof item.release.versionId !== 'string' ||
          typeof item.release.versionName !== 'string' ||
          (item.release.releasedAt !== undefined &&
            typeof item.release.releasedAt !== 'string'))) ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) {
      throw new ProjectPlanError('invalid_plan', 'Há uma missão inválida no roadmap.')
    }
  }
  const stages: ProjectPlanningSkillStage[] = [
    'discovery',
    'scope',
    'decisions',
    'roadmap',
    'review'
  ]
  for (const entry of plan.planningSkills) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      !stages.includes(entry.stage) ||
      typeof entry.contribution !== 'string' ||
      typeof entry.usedAt !== 'string' ||
      (entry.contractVersion !== undefined && entry.contractVersion !== 1) ||
      (entry.receiptId !== undefined && typeof entry.receiptId !== 'string') ||
      (entry.operation !== undefined && typeof entry.operation !== 'string') ||
      (entry.version !== undefined && typeof entry.version !== 'string') ||
      (entry.fingerprint !== undefined && typeof entry.fingerprint !== 'string') ||
      (entry.phaseRun !== undefined && typeof entry.phaseRun !== 'string') ||
      (entry.appliedAt !== undefined && typeof entry.appliedAt !== 'string') ||
      (entry.planningRevision !== undefined && typeof entry.planningRevision !== 'string') ||
      (entry.planningFingerprint !== undefined &&
        typeof entry.planningFingerprint !== 'string')
    ) {
      throw new ProjectPlanError('invalid_plan', 'Há um registro inválido de skill de planejamento.')
    }
  }
  validateRoadmapStructure(plan.roadmap)
}

function cloneItem(item: ProjectPlanItem): ProjectPlanItem {
  return {
    ...item,
    dependsOn: [...item.dependsOn],
    scope: { in: [...item.scope.in], out: [...item.scope.out] },
    acceptanceCriteria: [...item.acceptanceCriteria],
    wave: { ...item.wave },
    version: item.version ? { ...item.version } : undefined,
    release: item.release ? { ...item.release } : undefined
  }
}

function mergeDraftVersion(
  previous: ProjectPlanVersion | undefined,
  draft: Partial<ProjectPlanVersion> & { name: string }
): ProjectPlanVersion {
  const changedVersion =
    Boolean(previous) && normalizedVersionName(previous?.name) !== normalizedVersionName(draft.name)
  const merged: ProjectPlanVersion = { ...(previous ?? {}), ...draft, name: draft.name }
  // Trocar a versão-alvo de uma missão futura é uma reassociação, não um
  // rename do registro real já existente. Sem isto, V2 poderia carregar o id
  // de V1 e acabar abrindo silenciosamente na branch errada.
  if (changedVersion && (draft.id === undefined || draft.id === previous?.id)) delete merged.id
  return merged
}

function sameProjectPlanVersion(
  left: ProjectPlanVersion | undefined,
  right: ProjectPlanVersion | undefined
): boolean {
  if (!left || !right) return false
  const leftId = clean(left.id)
  const rightId = clean(right.id)
  if (leftId && rightId) return leftId === rightId
  const leftName = normalizedVersionName(left.name)
  const rightName = normalizedVersionName(right.name)
  return Boolean(leftName && rightName && leftName === rightName)
}

function sameProjectPlanVersionOrEmpty(
  left: ProjectPlanVersion | undefined,
  right: ProjectPlanVersion | undefined
): boolean {
  if (!left && !right) return true
  return sameProjectPlanVersion(left, right)
}

function normalizedVersionName(value: unknown): string {
  return clean(value).toLocaleLowerCase('pt-BR')
}

function parsePlannedVersionName(value: string): [number, number, number] | undefined {
  const match = value.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i)
  return match
    ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
    : undefined
}

function comparePlannedVersions(
  left: [number, number, number],
  right: [number, number, number]
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function hasPendingRelease(plan: ProjectPlan): boolean {
  return plan.roadmap.some((item) => item.release && !item.release.releasedAt)
}

function isTerminal(status: ProjectPlanItemStatus): boolean {
  return status === 'done'
}

function timestamp(value?: string): string {
  if (!value) return new Date().toISOString()
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) {
    throw new ProjectPlanError('invalid_plan', `Data inválida: ${value}.`)
  }
  return parsed.toISOString()
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function formatWaveId(value: number): string {
  return `W${String(value).padStart(3, '0')}`
}

function mergeRoadmapMeta(
  existing: ProjectPlanRoadmapMeta,
  patch: Partial<ProjectPlanRoadmapMeta> | undefined
): ProjectPlanRoadmapMeta {
  if (!patch) return { ...existing }
  const expectedCount =
    patch.expectedCount === undefined ? existing.expectedCount : patch.expectedCount
  if (
    expectedCount !== undefined &&
    (!Number.isInteger(expectedCount) || expectedCount < 0 || expectedCount > MAX_PROJECT_PLAN_ITEMS)
  ) {
    throw new ProjectPlanError(
      'invalid_plan',
      `roadmapMeta.expectedCount precisa ser um inteiro entre 0 e ${MAX_PROJECT_PLAN_ITEMS}.`
    )
  }
  if (patch.complete !== undefined && typeof patch.complete !== 'boolean') {
    throw new ProjectPlanError('invalid_plan', 'roadmapMeta.complete precisa ser booleano.')
  }
  return {
    ...(expectedCount === undefined ? {} : { expectedCount }),
    complete: patch.complete ?? existing.complete
  }
}

function required(value: unknown, field: string): string {
  const normalized = clean(value)
  if (!normalized) {
    throw new ProjectPlanError('invalid_plan', `O campo ${field} é obrigatório.`)
  }
  return normalized
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new ProjectPlanError('invalid_plan', 'Era esperada uma lista de textos no plano mestre.')
  }
  return [...new Set(values.map(clean).filter(Boolean))]
}

function applyListDraft(
  existing: string[],
  input: unknown,
  mode: 'merge' | 'replace'
): string[] {
  const normalized = cleanList(input)
  return mode === 'replace' ? normalized : [...new Set([...existing, ...normalized])]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendList(lines: string[], values: string[], fallback: string): void {
  if (values.length === 0) {
    lines.push(fallback)
    return
  }
  for (const value of values) lines.push(`- ${value}`)
}

function statusLabel(status: ProjectPlanStatus): string {
  return {
    draft: 'rascunho em construção',
    approved: 'aprovado, pronto para começar',
    in_progress: 'em andamento',
    revision_pending: 'em andamento, com revisão aguardando aprovação',
    awaiting_release: 'missões concluídas, aguardando publicação da versão',
    done: 'concluído'
  }[status]
}

function itemStatusLabel(status: ProjectPlanItemStatus): string {
  return {
    planned: 'planejada',
    active: 'ativa',
    done: 'concluída',
    deferred: 'adiada'
  }[status]
}

function itemIcon(status: ProjectPlanItemStatus): string {
  return {
    planned: '⬜',
    active: '🟡',
    done: '✅',
    deferred: '⏸️'
  }[status]
}

function planningStageLabel(stage: ProjectPlanningSkillStage): string {
  return {
    discovery: 'descoberta',
    scope: 'escopo',
    decisions: 'decisões',
    roadmap: 'roadmap',
    review: 'revisão'
  }[stage]
}

function nextActionLabel(
  plan: ProjectPlan,
  active: ProjectPlanItem | undefined,
  next: ProjectPlanItem | undefined
): string {
  if (active) {
    return plan.status === 'revision_pending'
      ? `acompanhe “${active.title}” na aba da missão e revise com o Maestro as mudanças pendentes; nenhuma próxima missão abrirá sem novo aval.`
      : `acompanhe a onda ${plan.currentWaveId ?? 'atual'}; seus pares prontos podem abrir em paralelo e a próxima onda só será liberada quando todos terminarem.`
  }
  if (plan.status === 'revision_pending') {
    return 'revise o mapa alterado com o Maestro e aprove-o explicitamente antes de abrir outra missão.'
  }
  const deferredGate = deferredRoadmapGate(plan)
  if (deferredGate) {
    return `decida com o Maestro se “${deferredGate.title}” deve ser retomada ou retirada numa revisão aprovada; o roteiro não pulará essa etapa sozinho.`
  }
  const releaseGate = projectPlanReleaseGate(plan)
  if (releaseGate) {
    const blockers = projectPlanReleaseBlockers(plan, releaseGate)
    return blockers.length > 0
      ? `resolva primeiro ${blockers.map((item) => `“${item.title}”`).join(', ')} em ${releaseGate.versionName}; depois publique essa versão antes de iniciar o próximo bloco.`
      : `revise o conjunto entregue e, quando aprovar, autorize o Maestro a publicar ${releaseGate.versionName}; só depois a próxima missão será liberada.`
  }
  if (plan.status === 'awaiting_release') {
    const versions = [
      ...new Set(
        plan.roadmap
          .filter((item) => item.release && !item.release.releasedAt)
          .map((item) => item.release?.versionName)
          .filter((name): name is string => Boolean(name))
      )
    ]
    return `todas as missões terminaram; teste o conjunto e, quando aprovar a publicação, autorize o Maestro a subir ${versions.join(', ') || 'a versão planejada'} para a base.`
  }
  if (plan.status === 'draft') {
    const missing = validateProjectPlanForApproval(plan)
    return plan.roadmap.length === 0
      ? 'conte ao Maestro qual produto você quer criar; ele conduzirá as decisões antes de existir qualquer missão.'
      : missing.length > 0
        ? `continue o planejamento com o Maestro; o próximo ponto ainda aberto é: ${missing[0]}.`
        : 'revise o mapa completo com o Maestro e diga explicitamente quando ele estiver aprovado.'
  }
  if (next) {
    return `revise as missões prontas da onda ${plan.currentWaveId ?? 'atual'} e autorize o Maestro a abrir em paralelo apenas as que puderem avançar com segurança.`
  }
  if (plan.status === 'done') {
    return 'revise o produto concluído; novas melhorias passam a ser missões pontuais.'
  }
  return 'decida com o Maestro se uma etapa adiada deve ser retomada ou se o roadmap precisa ser revisto.'
}

function flowStageLabel(plan: ProjectPlan): string {
  if (plan.status === 'revision_pending') return '5/5 — revisão do mapa aguardando aprovação'
  const deferredGate = deferredRoadmapGate(plan)
  if (deferredGate) return `roteiro pausado — ${deferredGate.title} está adiada`
  const releaseGate = projectPlanReleaseGate(plan)
  if (releaseGate) return `transição de versão — aguardando publicação de ${releaseGate.versionName}`
  if (plan.status === 'approved') return 'mapa aprovado — pronto para a primeira missão'
  if (plan.status === 'in_progress') return 'execução por ondas paralelas'
  if (plan.status === 'awaiting_release') return 'missões concluídas — aguardando publicação da versão'
  if (plan.status === 'done') return 'roadmap concluído'
  if (!plan.problem || !plan.audience || !plan.vision) {
    return '1/5 — problema, público e resultado desejado'
  }
  if (
    plan.successCriteria.length === 0 ||
    plan.constraints.length === 0 ||
    plan.scope.in.length === 0 ||
    plan.scope.out.length === 0
  ) {
    return '2/5 — sucesso, escopo e limites'
  }
  if (plan.decisions.length === 0) {
    return '3/5 — decisões do produto, arquitetura e pesquisas necessárias'
  }
  if (
    plan.roadmap.length === 0 ||
    plan.roadmap.some(
      (item) =>
        item.acceptanceCriteria.length === 0 ||
        !clean(item.version?.name)
    )
  ) {
    return '4/5 — versões e desenho do roadmap de missões'
  }
  return '5/5 — revisão completa e aprovação'
}

function versionLabel(version: ProjectPlanVersion): string {
  const details = [version.theme, version.goal].filter(Boolean)
  const suffix = details.length > 0 ? ` — ${details.join(' · ')}` : ''
  return `**${version.name}**${version.id ? ` (\`${version.id}\`)` : ''}${suffix}`
}

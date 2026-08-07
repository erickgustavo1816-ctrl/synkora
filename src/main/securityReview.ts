import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SecurityEvidenceRef,
  SecurityFinding,
  SecurityFindingConfidence,
  SecurityFindingLane,
  SecurityFindingSeverity,
  SecurityReview
} from './securityPolicy'
import { SECURITY_POLICY_VERSION } from './securityPolicy'
import { redactSensitiveText } from './securityRedaction'

export const SECURITY_REVIEW_RECORD_VERSION = 1 as const

export type SecurityTriageGate =
  | 'origin'
  | 'scope'
  | 'authorization'
  | 'evidence'
  | 'runtime'
  | 'server_control'
  | 'privacy'
  | 'business_impact'
  | 'correction_safety'

export type SecurityTriageStatus = 'confirmed' | 'refuted' | 'unknown' | 'not_applicable'

export interface SecurityTriageDecision {
  gate: SecurityTriageGate
  status: SecurityTriageStatus
  evidence: string
}

export interface SecurityFindingInput {
  id?: unknown
  lane?: unknown
  severity?: unknown
  confidence?: unknown
  title?: unknown
  evidence?: unknown
  missingContext?: unknown
  missingTests?: unknown
  businessImpact?: unknown
  recommendedAction?: unknown
  triage?: unknown
  falsePositiveBasis?: unknown
}

export interface SecurityReviewInput {
  reviewedFlows?: unknown
  findings?: unknown
  missingTests?: unknown
  recommendedNextStep?: unknown
}

export interface SecurityFindingRecord extends SecurityFinding {
  triage: SecurityTriageDecision[]
  falsePositiveBasis?: string
}

export interface SecurityReviewRecord extends Omit<SecurityReview, 'findings'> {
  recordVersion: typeof SECURITY_REVIEW_RECORD_VERSION
  taskId: string
  projectId: string
  phase: 'review' | 'qa' | 'integration'
  verdict: 'approved' | 'rejected' | 'invalid'
  reviewedAt: string
  findings: SecurityFindingRecord[]
}

export interface SecurityReviewContext {
  projectId: string
  taskId: string
  authorizedScope: string
  phase: SecurityReviewRecord['phase']
  verdict: SecurityReviewRecord['verdict']
  reviewedAt?: string
}

export interface SecurityReviewValidation {
  ok: boolean
  errors: string[]
}

export interface McpRiskEntryInput {
  id: string
  server: string
  owner: 'synkora' | 'project' | 'user'
  transport: 'http-local' | 'stdio' | 'unknown'
  source: string
  permissions: string[]
  dataAccess: string[]
  sensitiveActions: string[]
  humanApprovalRequired: boolean
  revocation: string
  version?: string
}

export interface McpRiskEntry extends McpRiskEntryInput {
  recordedAt: string
}

export interface McpRiskRegister {
  schemaVersion: 1
  updatedAt: string
  entries: McpRiskEntry[]
}

const TRIAGE_GATES: readonly SecurityTriageGate[] = [
  'origin',
  'scope',
  'authorization',
  'evidence',
  'runtime',
  'server_control',
  'privacy',
  'business_impact',
  'correction_safety'
]

const FINDING_LANES = new Set<SecurityFindingLane>([
  'fix_now',
  'monitor',
  'human_validation',
  'false_positive',
  'needs_context'
])
const FINDING_SEVERITIES = new Set<SecurityFindingSeverity>([
  'low',
  'medium',
  'high',
  'critical'
])
const FINDING_CONFIDENCES = new Set<SecurityFindingConfidence>(['low', 'medium', 'high'])
const TRIAGE_STATUSES = new Set<SecurityTriageStatus>([
  'confirmed',
  'refuted',
  'unknown',
  'not_applicable'
])

function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return redactSensitiveText(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function safeList(value: unknown, maxItems: number, maxText: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => safeText(item, maxText)).filter(Boolean))].slice(
    0,
    maxItems
  )
}

function safeIdentifier(value: unknown, fallback: string): string {
  const normalized = safeText(value, 100)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function enumValue<T extends string>(value: unknown, accepted: Set<T>, fallback: T): T {
  return typeof value === 'string' && accepted.has(value as T) ? (value as T) : fallback
}

function normalizeEvidence(value: unknown): SecurityEvidenceRef[] {
  if (!Array.isArray(value)) return []
  const result: SecurityEvidenceRef[] = []
  for (const candidate of value.slice(0, 20)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const item = candidate as Record<string, unknown>
    const path = safeText(item.path, 500)
    const note = safeText(item.note, 1_000)
    if (!path || !note) continue
    result.push({
      path,
      ...(safeText(item.location, 300) ? { location: safeText(item.location, 300) } : {}),
      note
    })
  }
  return result
}

function normalizeTriage(value: unknown): SecurityTriageDecision[] {
  const byGate = new Map<SecurityTriageGate, SecurityTriageDecision>()
  if (Array.isArray(value)) {
    for (const candidate of value.slice(0, 30)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const item = candidate as Record<string, unknown>
      if (typeof item.gate !== 'string' || !TRIAGE_GATES.includes(item.gate as SecurityTriageGate)) {
        continue
      }
      const gate = item.gate as SecurityTriageGate
      byGate.set(gate, {
        gate,
        status: enumValue(item.status, TRIAGE_STATUSES, 'unknown'),
        evidence: safeText(item.evidence, 1_000)
      })
    }
  }
  return TRIAGE_GATES.map(
    (gate) => byGate.get(gate) ?? { gate, status: 'unknown', evidence: '' }
  )
}

function normalizeFinding(value: SecurityFindingInput, index: number): SecurityFindingRecord {
  const lane = enumValue(value.lane, FINDING_LANES, 'needs_context')
  const falsePositiveBasis = safeText(value.falsePositiveBasis, 1_200)
  return {
    id: safeIdentifier(value.id, `finding-${index + 1}`),
    lane,
    severity: enumValue(value.severity, FINDING_SEVERITIES, 'medium'),
    confidence: enumValue(value.confidence, FINDING_CONFIDENCES, 'low'),
    title: safeText(value.title, 240) || `Achado ${index + 1}`,
    evidence: normalizeEvidence(value.evidence),
    missingContext: safeList(value.missingContext, 20, 500),
    missingTests: safeList(value.missingTests, 20, 500),
    businessImpact: safeText(value.businessImpact, 1_200),
    recommendedAction: safeText(value.recommendedAction, 1_200),
    triage: normalizeTriage(value.triage),
    ...(lane === 'false_positive' && falsePositiveBasis ? { falsePositiveBasis } : {})
  }
}

export function normalizeSecurityReview(
  input: SecurityReviewInput | undefined,
  context: SecurityReviewContext
): SecurityReviewRecord {
  const findings = Array.isArray(input?.findings)
    ? input.findings
        .filter(
          (candidate): candidate is SecurityFindingInput =>
            !!candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        )
        .slice(0, 50)
        .map(normalizeFinding)
    : []
  const reviewedAt = context.reviewedAt ?? new Date().toISOString()
  return {
    recordVersion: SECURITY_REVIEW_RECORD_VERSION,
    policyVersion: SECURITY_POLICY_VERSION,
    projectId: safeIdentifier(context.projectId, 'project'),
    taskId: safeIdentifier(context.taskId, 'task'),
    phase: context.phase,
    verdict: context.verdict,
    reviewedAt: Number.isFinite(Date.parse(reviewedAt)) ? reviewedAt : new Date().toISOString(),
    authorizedScope: safeText(context.authorizedScope, 1_000) || 'project-local authorized scope',
    reviewedFlows: safeList(input?.reviewedFlows, 30, 500),
    findings,
    missingTests: safeList(input?.missingTests, 30, 500),
    recommendedNextStep:
      safeText(input?.recommendedNextStep, 1_200) ||
      (context.verdict === 'approved'
        ? 'Preserve the scoped evidence and monitor regressions.'
        : 'Resolve the recorded finding and repeat the scoped review.'),
    securityClaimProhibited: true
  }
}

export function validateSecurityReview(
  review: SecurityReviewRecord,
  options: { sensitive: boolean }
): SecurityReviewValidation {
  const errors: string[] = []
  if (review.reviewedFlows.length === 0) errors.push('informe ao menos um fluxo revisado')
  // Uma revisão pode legitimamente não encontrar vulnerabilidades. O escopo
  // revisado continua obrigatório; não fabricamos um achado para liberar gate.
  for (const finding of review.findings) {
    if (!finding.businessImpact) errors.push(`${finding.id}: impacto de negócio ausente`)
    if (!finding.recommendedAction) errors.push(`${finding.id}: ação recomendada ausente`)
    if (
      finding.lane !== 'needs_context' &&
      finding.confidence !== 'low' &&
      finding.evidence.length === 0
    ) {
      errors.push(`${finding.id}: confiança ${finding.confidence} exige evidência`)
    }
    if (finding.lane === 'false_positive') {
      if (!finding.falsePositiveBasis || finding.evidence.length === 0) {
        errors.push(`${finding.id}: falso positivo exige premissa refutada e evidência`)
      }
      const premiseRefuted = finding.triage.some(
        (decision) => decision.status === 'refuted' && decision.evidence.length > 0
      )
      if (!premiseRefuted) errors.push(`${finding.id}: falso positivo sem gate de triagem refutado`)
    }
    if (options.sensitive) {
      const materialSeverity = finding.severity === 'high' || finding.severity === 'critical'
      if (materialSeverity && finding.evidence.length === 0) {
        errors.push(`${finding.id}: achado ${finding.severity} exige evidência sanitizada`)
      }
      if (
        finding.triage.every(
          (decision) => decision.status === 'unknown' || decision.status === 'not_applicable'
        )
      ) {
        errors.push(`${finding.id}: triagem sensível não pode ficar inteiramente desconhecida`)
      }
    }
  }
  if (review.verdict === 'approved') {
    const blocking = review.findings.filter(
      (finding) =>
        finding.lane === 'fix_now' ||
        (options.sensitive &&
          (finding.severity === 'high' || finding.severity === 'critical') &&
          finding.lane === 'monitor') ||
        ((finding.severity === 'high' || finding.severity === 'critical') &&
          finding.lane === 'needs_context')
    )
    if (blocking.length > 0) {
      errors.push('aprovação contém achado que ainda exige correção ou contexto crítico')
    }
  }
  if (review.verdict === 'rejected' && review.findings.length === 0) {
    errors.push('reprovação precisa registrar ao menos um achado')
  }
  return { ok: errors.length === 0, errors }
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
      // Nunca criado ou já promovido.
    }
    throw error
  }
}

function safeJsonRead(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function markdownReview(review: SecurityReviewRecord): string {
  const lines = [
    '# Synkora security review',
    '',
    `- Policy: v${review.policyVersion}`,
    `- Verdict: ${review.verdict}`,
    `- Phase: ${review.phase}`,
    `- Reviewed at: ${review.reviewedAt}`,
    `- Authorized scope: ${review.authorizedScope}`,
    '- This is scoped evidence, not a claim that the application is universally secure.',
    '',
    '## Reviewed flows',
    '',
    ...review.reviewedFlows.map((flow) => `- ${flow}`),
    '',
    '## Findings',
    ''
  ]
  if (review.findings.length === 0) lines.push('- No finding was recorded for this scoped review.')
  for (const finding of review.findings) {
    lines.push(
      `### ${finding.title}`,
      '',
      `- Lane: ${finding.lane}`,
      `- Severity: ${finding.severity}`,
      `- Confidence: ${finding.confidence}`,
      `- Business impact: ${finding.businessImpact || 'Not established.'}`,
      `- Recommended action: ${finding.recommendedAction || 'Gather missing context.'}`,
      ...(finding.falsePositiveBasis
        ? [`- False-positive basis: ${finding.falsePositiveBasis}`]
        : []),
      '',
      ...finding.evidence.map(
        (evidence) =>
          `- Evidence: ${evidence.path}${evidence.location ? ` (${evidence.location})` : ''} — ${evidence.note}`
      ),
      ...finding.missingContext.map((item) => `- Missing context: ${item}`),
      ...finding.missingTests.map((item) => `- Missing test: ${item}`),
      '',
      'Triage:',
      ...finding.triage.map(
        (decision) =>
          `- ${decision.gate}: ${decision.status}${decision.evidence ? ` — ${decision.evidence}` : ''}`
      ),
      ''
    )
  }
  lines.push(
    '## Missing tests',
    '',
    ...(review.missingTests.length > 0
      ? review.missingTests.map((item) => `- ${item}`)
      : ['- None recorded.']),
    '',
    '## Recommended next step',
    '',
    review.recommendedNextStep,
    ''
  )
  return `${lines.join('\n')}\n`
}

interface FalsePositiveLedgerEntry {
  taskId: string
  findingId: string
  title: string
  basis: string
  evidence: SecurityEvidenceRef[]
  triage: SecurityTriageDecision[]
  reviewedAt: string
}

function persistFalsePositiveLedger(directory: string, review: SecurityReviewRecord): void {
  const additions: FalsePositiveLedgerEntry[] = review.findings
    .filter(
      (finding): finding is SecurityFindingRecord & { falsePositiveBasis: string } =>
        finding.lane === 'false_positive' && !!finding.falsePositiveBasis
    )
    .map((finding) => ({
      taskId: review.taskId,
      findingId: finding.id,
      title: finding.title,
      basis: finding.falsePositiveBasis,
      evidence: finding.evidence,
      triage: finding.triage,
      reviewedAt: review.reviewedAt
    }))
  if (additions.length === 0) return
  const file = join(directory, 'FALSE_POSITIVE_LEDGER.json')
  const current = safeJsonRead(file)
  const previous = Array.isArray(current) ? (current as FalsePositiveLedgerEntry[]) : []
  const entries = new Map<string, FalsePositiveLedgerEntry>()
  for (const entry of [...previous, ...additions]) {
    if (!entry || typeof entry.taskId !== 'string' || typeof entry.findingId !== 'string') continue
    entries.set(`${entry.taskId}\0${entry.findingId}`, entry)
  }
  atomicWrite(file, `${JSON.stringify([...entries.values()], null, 2)}\n`)
}

export function persistSecurityReview(
  projectRoot: string,
  review: SecurityReviewRecord
): { json: string; markdown: string } {
  const directory = join(projectRoot, '.synkora', 'reports', 'security')
  mkdirSync(directory, { recursive: true })
  const stem = `${safeIdentifier(review.taskId, 'task')}-${review.phase}`
  const json = join(directory, `${stem}.json`)
  const markdown = join(directory, `${stem}.md`)
  atomicWrite(json, `${JSON.stringify(review, null, 2)}\n`)
  atomicWrite(markdown, markdownReview(review))
  persistFalsePositiveLedger(join(projectRoot, '.synkora'), review)
  return { json, markdown }
}

function validMcpEntry(value: unknown): value is McpRiskEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<McpRiskEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.server === 'string' &&
    (entry.owner === 'synkora' || entry.owner === 'project' || entry.owner === 'user') &&
    (entry.transport === 'http-local' || entry.transport === 'stdio' || entry.transport === 'unknown') &&
    Array.isArray(entry.permissions) &&
    Array.isArray(entry.dataAccess) &&
    Array.isArray(entry.sensitiveActions) &&
    typeof entry.humanApprovalRequired === 'boolean' &&
    typeof entry.revocation === 'string' &&
    typeof entry.recordedAt === 'string'
  )
}

export function persistMcpRiskRegister(
  projectRoot: string,
  inputs: readonly McpRiskEntryInput[],
  now = new Date().toISOString()
): McpRiskRegister {
  const directory = join(projectRoot, '.synkora')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'MCP_RISK_REGISTER.json')
  const current = safeJsonRead(file)
  const previous =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as { entries?: unknown }).entries
      : undefined
  const byId = new Map<string, McpRiskEntry>()
  if (Array.isArray(previous)) {
    for (const entry of previous) if (validMcpEntry(entry)) byId.set(entry.id, entry)
  }
  for (const input of inputs) {
    const id = safeIdentifier(input.id, 'mcp')
    byId.set(id, {
      id,
      server: safeText(input.server, 200),
      owner: input.owner,
      transport: input.transport,
      source: safeText(input.source, 500),
      permissions: safeList(input.permissions, 40, 300),
      dataAccess: safeList(input.dataAccess, 40, 300),
      sensitiveActions: safeList(input.sensitiveActions, 40, 300),
      humanApprovalRequired: input.humanApprovalRequired,
      revocation: safeText(input.revocation, 500),
      ...(safeText(input.version, 100) ? { version: safeText(input.version, 100) } : {}),
      recordedAt: now
    })
  }
  const register: McpRiskRegister = {
    schemaVersion: 1,
    updatedAt: now,
    entries: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'))
  }
  atomicWrite(file, `${JSON.stringify(register, null, 2)}\n`)
  return register
}

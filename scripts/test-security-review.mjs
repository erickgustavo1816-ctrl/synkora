import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  normalizeSecurityReview,
  persistMcpRiskRegister,
  persistSecurityReview,
  validateSecurityReview
} from '../.tmp/security-review-test/securityReview.js'

const context = {
  projectId: 'project-1',
  taskId: 'task-1',
  authorizedScope: 'local project',
  phase: 'review',
  verdict: 'approved',
  reviewedAt: '2026-08-03T12:00:00.000Z'
}

test('normalizes and redacts a structured review', () => {
  const review = normalizeSecurityReview(
    {
      reviewedFlows: ['login'],
      findings: [
        {
          id: 'AUTH-1',
          lane: 'monitor',
          severity: 'medium',
          confidence: 'high',
          title: 'Session policy',
          evidence: [{ path: 'src/auth.ts', note: 'Bearer secret-token-value' }],
          businessImpact: 'Account session drift',
          recommendedAction: 'Keep regression coverage',
          triage: [{ gate: 'runtime', status: 'confirmed', evidence: 'covered by test' }]
        }
      ],
      recommendedNextStep: 'Monitor'
    },
    context
  )
  assert.equal(review.policyVersion, 2)
  assert.equal(review.securityClaimProhibited, true)
  assert.equal(review.findings[0].id, 'auth-1')
  assert.doesNotMatch(JSON.stringify(review), /secret-token-value/)
  assert.equal(review.findings[0].triage.length, 9)
  assert.equal(validateSecurityReview(review, { sensitive: true }).ok, true)
})

test('rejects unsupported false-positive claims', () => {
  const review = normalizeSecurityReview(
    {
      reviewedFlows: ['authorization'],
      findings: [
        {
          lane: 'false_positive',
          severity: 'high',
          confidence: 'high',
          title: 'IDOR signal',
          evidence: [],
          businessImpact: 'Cross-account access',
          recommendedAction: 'No action'
        }
      ]
    },
    context
  )
  const result = validateSecurityReview(review, { sensitive: true })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /falso positivo/)
})

test('blocks approval with unresolved high-risk context', () => {
  const review = normalizeSecurityReview(
    {
      reviewedFlows: ['billing'],
      findings: [
        {
          lane: 'needs_context',
          severity: 'critical',
          confidence: 'low',
          title: 'Webhook ownership',
          businessImpact: 'Entitlement drift',
          recommendedAction: 'Inspect server handler'
        }
      ]
    },
    context
  )
  const result = validateSecurityReview(review, { sensitive: true })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /contexto crítico/)
})

test('sensitive approval cannot hide a critical finding in monitor', () => {
  const review = normalizeSecurityReview(
    {
      reviewedFlows: ['admin role change'],
      findings: [
        {
          lane: 'monitor',
          severity: 'critical',
          confidence: 'low',
          title: 'Privilege boundary',
          businessImpact: 'Cross-tenant role escalation',
          recommendedAction: 'Fix the server-side authorization check'
        }
      ]
    },
    context
  )
  const result = validateSecurityReview(review, { sensitive: true })
  assert.equal(result.ok, false)
  assert.match(result.errors.join(' '), /evidência|triagem|correção ou contexto/)
})

test('persists sanitized review and false-positive ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-security-review-'))
  const review = normalizeSecurityReview(
    {
      reviewedFlows: ['upload'],
      findings: [
        {
          id: 'fp-1',
          lane: 'false_positive',
          severity: 'low',
          confidence: 'high',
          title: 'Example-only key',
          evidence: [{ path: 'fixtures/example.ts', note: 'Static placeholder' }],
          businessImpact: 'None in runtime',
          recommendedAction: 'Keep fixture isolated',
          falsePositiveBasis: 'File is excluded from the runtime build',
          triage: [{ gate: 'runtime', status: 'refuted', evidence: 'Build graph excludes fixture' }]
        }
      ]
    },
    context
  )
  assert.equal(validateSecurityReview(review, { sensitive: true }).ok, true)
  const files = persistSecurityReview(root, review)
  assert.match(readFileSync(files.markdown, 'utf8'), /False-positive basis/)
  assert.match(readFileSync(join(root, '.synkora', 'FALSE_POSITIVE_LEDGER.json'), 'utf8'), /fp-1/)
})

test('merges the MCP register by stable id', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-mcp-register-'))
  const base = {
    id: 'synkora',
    server: 'Synkora local MCP',
    owner: 'synkora',
    transport: 'http-local',
    source: 'bundled runtime',
    permissions: ['task-scoped tools'],
    dataAccess: ['current project metadata'],
    sensitiveActions: ['mission integration'],
    humanApprovalRequired: true,
    revocation: 'close the pane'
  }
  persistMcpRiskRegister(root, [base], '2026-08-03T12:00:00.000Z')
  const register = persistMcpRiskRegister(
    root,
    [{ ...base, permissions: ['updated scope'] }],
    '2026-08-03T13:00:00.000Z'
  )
  assert.equal(register.entries.length, 1)
  assert.deepEqual(register.entries[0].permissions, ['updated scope'])
})

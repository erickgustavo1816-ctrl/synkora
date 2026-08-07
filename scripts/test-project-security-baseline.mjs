import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureProjectSecurityBaseline } from '../.tmp/project-security-baseline-test/projectSecurityBaseline.js'

function root() {
  return mkdtempSync(join(tmpdir(), 'synkora-project-security-'))
}

test('installs the policy and adapters in a new project', () => {
  const project = root()
  const result = ensureProjectSecurityBaseline(project, {
    installRepositoryAdapters: true,
    projectName: 'Safe App'
  })
  assert.equal(result.repositoryAdaptersRequested, true)
  for (const path of [
    'SECURITY.md',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
    '.cursor/rules/synkora-security.mdc',
    '.windsurf/rules/synkora-security.md',
    '.synkora/SECURITY_POLICY.md',
    '.synkora/SECURITY_PROFILE.json',
    '.synkora/MCP_RISK_REGISTER.json'
  ]) assert.equal(existsSync(join(project, path)), true, path)
  assert.match(readFileSync(join(project, 'SECURITY.md'), 'utf8'), /Authorization and multi-tenant/)
})

test('never overwrites a user-owned adapter', () => {
  const project = root()
  writeFileSync(join(project, 'AGENTS.md'), '# User rules\n', 'utf8')
  const result = ensureProjectSecurityBaseline(project, {
    installRepositoryAdapters: true
  })
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), '# User rules\n')
  assert.equal(
    result.adapters.find((adapter) => adapter.path === 'AGENTS.md')?.state,
    'preserved_existing'
  )
})

test('updates only files carrying the managed marker', () => {
  const project = root()
  ensureProjectSecurityBaseline(project, { installRepositoryAdapters: true })
  writeFileSync(
    join(project, 'CLAUDE.md'),
    '<!-- synkora-security-baseline:managed -->\n# stale\n',
    'utf8'
  )
  const result = ensureProjectSecurityBaseline(project, { installRepositoryAdapters: true })
  assert.equal(
    result.adapters.find((adapter) => adapter.path === 'CLAUDE.md')?.state,
    'updated'
  )
  assert.match(readFileSync(join(project, 'CLAUDE.md'), 'utf8'), /Read and follow SECURITY\.md/)
})

test('existing projects receive only the untracked runtime baseline', () => {
  const project = root()
  mkdirSync(join(project, 'src'))
  ensureProjectSecurityBaseline(project, {
    installRepositoryAdapters: false,
    projectName: 'Existing App'
  })
  assert.equal(existsSync(join(project, 'SECURITY.md')), false)
  assert.equal(existsSync(join(project, '.synkora', 'SECURITY_POLICY.md')), true)
})

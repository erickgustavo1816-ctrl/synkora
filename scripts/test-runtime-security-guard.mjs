import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectShellSubmission,
  referencesProtectedSecretPath
} from '../src/main/runtimeSecurityGuard.ts'

test('recognizes protected credential material without treating templates as secrets', () => {
  for (const command of [
    'Get-Content .env',
    'cat .env.production',
    'type C:\\app\\.npmrc',
    'cat ~/.ssh/id_ed25519',
    'Get-Content $HOME/.aws/credentials',
    'cat ~/.config/gcloud/application_default_credentials.json',
    'type %USERPROFILE%\\.docker\\config.json',
    'cat ~/.git-credentials',
    'Get-Content .env.example; Get-Content .env.production',
    'cat .env.development.local',
    'cat .envrc',
    'Get-Content .env*',
    'openssl pkcs12 -in certs/client.p12',
    'cat config/service-account.json',
    'rg password prod-backup.sql'
  ]) {
    assert.equal(referencesProtectedSecretPath(command), true, command)
  }
  for (const command of [
    'Get-Content .env.example',
    'cat .env.sample',
    'rg credentials src/credentials.ts',
    'node scripts/backup-database.mjs',
    'git status'
  ]) {
    assert.equal(referencesProtectedSecretPath(command), false, command)
  }
})

test('fails closed for content access but permits metadata-only inspection', () => {
  const blocked = inspectShellSubmission('Get-Content .env.local', { humanInput: true })
  assert.equal(blocked.action, 'block')
  assert.equal(blocked.action === 'block' && blocked.category, 'secret-path')
  assert.equal(blocked.action === 'block' && blocked.commandName, 'get-content')
  assert.equal('path' in blocked, false, 'decision must not carry the sensitive path')

  assert.deepEqual(inspectShellSubmission('Test-Path .env.local', { humanInput: true }), {
    action: 'allow'
  })
  assert.deepEqual(inspectShellSubmission('git status -- .env', { humanInput: true }), {
    action: 'allow'
  })
  for (const bypass of [
    'Get-Item .env | Get-Content',
    'git status -- .env; Get-Content .env',
    'Test-Path $(Get-Content .env)'
  ]) {
    assert.equal(inspectShellSubmission(bypass, { humanInput: true }).action, 'block', bypass)
  }
})

test('human submission is an auditable exact approval; automation is blocked', () => {
  const human = inspectShellSubmission('git push origin main', { humanInput: true })
  assert.equal(human.action, 'human-authorized')
  assert.equal(human.action === 'human-authorized' && human.category, 'external-effect')

  const automated = inspectShellSubmission('git push origin main', { humanInput: false })
  assert.equal(automated.action, 'block')
  assert.equal(automated.action === 'block' && automated.category, 'external-effect')

  const destructive = inspectShellSubmission('Remove-Item old -Recurse -Force', {
    humanInput: true
  })
  assert.equal(destructive.action, 'human-authorized')
  assert.equal(
    destructive.action === 'human-authorized' && destructive.category,
    'destructive-effect'
  )
})

test('normal local development commands remain untouched', () => {
  for (const command of [
    'npm test',
    'npm run build',
    'git diff -- src/main/index.ts',
    'rg "authorization" src',
    'Get-Content package.json',
    '/login'
  ]) {
    assert.deepEqual(inspectShellSubmission(command, { humanInput: true }), { action: 'allow' })
  }
})

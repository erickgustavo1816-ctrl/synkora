import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import AdmZip from 'adm-zip'
import {
  diagnosticsConsentDetail,
  exportDiagnostics,
  sanitizeDiagnosticValue
} from '../src/main/diagnostics.ts'

const sandbox = mkdtempSync(join(tmpdir(), 'synkora-diagnostics-'))
const userDataDir = join(sandbox, 'userData')
const blackboxDir = join(userDataDir, 'blackbox')
const projectDir = join(sandbox, 'Cliente Confidencial')
const synkoraDir = join(projectDir, '.synkora')
const missionsDir = join(synkoraDir, 'missions')
const outFile = join(sandbox, 'diagnostico.zip')
const secret = 'sk_live_1234567890SUPERSECRETO'
const githubToken = 'github_pat_1234567890SUPERSECRETO'
const email = 'cliente.secreto@example.com'

mkdirSync(blackboxDir, { recursive: true })
mkdirSync(missionsDir, { recursive: true })
writeFileSync(
  join(userDataDir, 'tasks.json'),
  JSON.stringify([{ title: `Projeto de ${email}`, briefing: secret, status: 'execucao' }]),
  'utf8'
)
writeFileSync(
  join(userDataDir, 'maestro.json'),
  JSON.stringify({ conversation: [{ message: secret }], token: githubToken }),
  'utf8'
)
writeFileSync(join(userDataDir, 'synkora-crash.log'), `falhou com ${secret}`, 'utf8')
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ imageProvider: 'openrouter', openrouterKey: secret, githubToken }),
  'utf8'
)
writeFileSync(
  join(blackboxDir, 'journal-20260803.jsonl'),
  `${JSON.stringify({
    ts: '2026-08-03T12:00:00.000Z',
    seq: 1,
    boot: 'boot-1',
    cat: 'task',
    event: 'updated',
    ids: { projectId: 'project-secret-id', taskId: 'task-secret-id', phase: 'dev' },
    reason: `${email} ${secret}`,
    detail: { message: githubToken },
    err: `Bearer ${secret}`
  })}\n`,
  'utf8'
)
writeFileSync(join(blackboxDir, 'journal.md'), `${email} ${secret}`, 'utf8')
writeFileSync(join(synkoraDir, 'BOARD.md'), `${email} ${secret}`, 'utf8')
writeFileSync(join(missionsDir, 'missao-secreta.md'), `${githubToken}`, 'utf8')

try {
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', email], { cwd: projectDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Cliente Confidencial'], { cwd: projectDir, stdio: 'ignore' })
  writeFileSync(join(projectDir, 'README.md'), '# teste', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: projectDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', `Entrega para ${email}`], { cwd: projectDir, stdio: 'ignore' })
} catch {
  // Git pode não estar disponível no ambiente de teste; o export degrada fechado.
}

after(() => rmSync(sandbox, { recursive: true, force: true }))

test('redator remove segredos, e-mails e caminhos em metadados permitidos', () => {
  const sanitized = JSON.stringify(
    sanitizeDiagnosticValue({
      note: `${secret} ${email} C:\\Users\\Cliente\\arquivo.txt`,
      nested: { authorization: `Bearer ${githubToken}` }
    })
  )
  assert.equal(sanitized.includes(secret), false)
  assert.equal(sanitized.includes(email), false)
  assert.equal(sanitized.includes('C:\\Users\\Cliente'), false)
  assert.match(sanitized, /redigido/)
})

test('preview explica inclusão mínima e exclusão de conteúdo cru', () => {
  const preview = diagnosticsConsentDetail(2)
  assert.match(preview, /2 projeto/)
  assert.match(preview, /Não serão incluídos: conversas, prompts, briefings/)
  assert.match(preview, /stores/)
})

test('ZIP nunca contém stores, logs, conversas ou documentos crus', () => {
  const result = exportDiagnostics({
    outFile,
    userDataDir,
    blackboxDir,
    meta: {
      app: '0.1.0',
      note: `${secret} ${email}`,
      localPath: projectDir
    },
    projects: [{ id: 'project-secret-id', name: 'Cliente Confidencial', path: projectDir }]
  })
  assert.equal(result.ok, true, result.msg)

  const zip = new AdmZip(outFile)
  const names = zip.getEntries().map((entry) => entry.entryName)
  assert.equal(names.includes('userData/tasks.json'), false)
  assert.equal(names.includes('userData/maestro.json'), false)
  assert.equal(names.includes('userData/synkora-crash.log'), false)
  assert.equal(names.some((name) => name.endsWith('/BOARD.md')), false)
  assert.equal(names.some((name) => name.includes('/missions/')), false)
  assert.equal(names.includes('blackbox/journal.md'), false)
  assert.equal(names.includes('userData/manifest.json'), true)
  assert.equal(names.includes('userData/settings.sanitized.json'), true)
  assert.equal(names.some((name) => name.endsWith('.sanitized.jsonl')), true)

  const payload = zip.getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.getData().toString('utf8'))
    .join('\n')
  for (const forbidden of [
    secret,
    githubToken,
    email,
    projectDir,
    'Cliente Confidencial',
    'project-secret-id',
    'task-secret-id'
  ]) {
    assert.equal(payload.includes(forbidden), false, `vazou: ${forbidden}`)
  }
  assert.match(payload, /Conteúdos crus foram omitidos deliberadamente/)
  assert.match(payload, /"hasReason":true/)
  assert.equal(payload.includes('Projeto de'), false)
})

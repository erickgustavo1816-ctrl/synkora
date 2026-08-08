import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  immutableReviewChangedPaths,
  immutableReviewDiff,
  immutableReviewRangeValid
} from '../src/main/reviewDiff.ts'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

test('review receives an immutable diff without running repository helpers', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-review-diff-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Synkora Test'])
  git(root, ['config', 'user.email', 'synkora@example.invalid'])
  // Se o helper usasse o diff externo ou o textconv configurado pelo próprio
  // repositório, estes executáveis inexistentes fariam a coleta falhar.
  git(root, ['config', 'diff.external', 'synkora-must-never-run-external-diff'])
  git(root, ['config', 'diff.hostile.textconv', 'synkora-must-never-run-textconv'])
  writeFileSync(join(root, '.gitattributes'), 'file.txt diff=hostile\n', 'utf8')
  writeFileSync(join(root, 'file.txt'), 'antes\n', 'utf8')
  git(root, ['add', '.gitattributes', 'file.txt'])
  git(root, ['commit', '-m', 'base'])
  const base = git(root, ['rev-parse', 'HEAD'])
  writeFileSync(join(root, 'file.txt'), `depois\n${'linha de evidencia\n'.repeat(400)}`, 'utf8')
  git(root, ['add', 'file.txt'])
  git(root, ['commit', '-m', 'snapshot'])
  const head = git(root, ['rev-parse', 'HEAD'])

  const evidence = immutableReviewDiff(root, base, head)
  assert.equal(evidence.truncated, false)
  assert.equal(evidence.mode, 'inline')
  assert.match(evidence.text, /file\.txt/)
  assert.match(evidence.text, /-antes/)
  assert.match(evidence.text, /\+depois/)
  assert.deepEqual(evidence.changedPaths, ['file.txt'])
  assert.equal(immutableReviewRangeValid(root, base, head), true)
  assert.deepEqual(immutableReviewChangedPaths(root, base, head), ['file.txt'])
  // Estouro do teto NUNCA corta o patch nem devolve o card (caso real
  // 2026-08-04): vira modo 'local' — resumo inline + leitura local pelo range
  // SHA-pinado, instruída pelo prompt do harness fora do bloco untrusted.
  const local = immutableReviewDiff(root, base, head, 2_000)
  assert.equal(local.truncated, true)
  assert.equal(local.mode, 'local')
  assert.match(local.text, /file\.txt/)
  assert.match(local.text, /grande demais para vir inline/)
  assert.doesNotMatch(local.text, /\+depois/)
  assert.ok(local.artifactSourcePath)
  const localArtifact = readFileSync(local.artifactSourcePath, 'utf8')
  assert.match(localArtifact, /\+depois/)
  assert.match(localArtifact, /PATCH/)
  assert.equal(local.artifactBytes, statSync(local.artifactSourcePath).size)
  assert.equal(
    local.artifactSha256,
    createHash('sha256').update(readFileSync(local.artifactSourcePath)).digest('hex')
  )
  rmSync(dirname(local.artifactSourcePath), { recursive: true, force: true })

  // O antigo maxBuffer de 16 MiB bloqueava para sempre uma entrega legítima.
  // Agora stdout vai direto ao spool, sem atravessar esse teto.
  writeFileSync(join(root, 'huge.txt'), `${'x'.repeat(17 * 1024 * 1024)}\n`, 'utf8')
  git(root, ['add', 'huge.txt'])
  git(root, ['commit', '-m', 'huge snapshot'])
  const hugeHead = git(root, ['rev-parse', 'HEAD'])
  const huge = immutableReviewDiff(root, head, hugeHead, 2_000)
  assert.equal(huge.mode, 'local')
  assert.deepEqual(huge.changedPaths, ['huge.txt'])
  assert.ok(huge.artifactSourcePath)
  assert.ok(statSync(huge.artifactSourcePath).size > 16 * 1024 * 1024)
  rmSync(dirname(huge.artifactSourcePath), { recursive: true, force: true })

  assert.equal(immutableReviewRangeValid(root, hugeHead, head), false)
  assert.equal(immutableReviewDiff(root, 'HEAD', head), undefined)
})

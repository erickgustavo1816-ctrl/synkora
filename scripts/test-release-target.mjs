import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { inspectReleaseTarget, prepareReleaseTarget, mergeTaskWorktree } from '../.tmp/release-target-test/worktree.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-release-target-'))
  t.after(() => {
    const child = relative(resolve(tmpdir()), resolve(root))
    assert.ok(child && !child.startsWith('..') && !child.includes(sep))
    rmSync(root, { recursive: true, force: true })
  })
  const repo = join(root, 'project'); mkdirSync(repo)
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Synthetic Release'])
  git(['config', 'user.email', 'release@example.invalid'])
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'app.txt'), 'base\n')
  git(['add', 'app.txt']); git(['commit', '-m', 'Initial fixture'])
  git(['checkout', '-b', 'dev'])
  writeFileSync(join(repo, 'dev.txt'), 'development\n')
  git(['add', 'dev.txt']); git(['commit', '-m', 'Development fixture'])
  return { root, repo, git }
}

test('destino explícito main prepara e integra a versão sem avançar dev; push vai só ao origin main sintético', t => {
  const { root, repo, git } = fixture(t)
  const unset = inspectReleaseTarget(repo)
  assert.equal(unset.branch, undefined)
  assert.match(unset.error, /release_target/u)
  assert.deepEqual(unset.branches, ['dev', 'main'])
  const target = inspectReleaseTarget(repo, 'main')
  assert.equal(target.error, undefined)
  assert.equal(target.needsSwitch, true)
  const devHead = git(['rev-parse', 'dev'])
  const versionDir = join(root, 'version')
  git(['worktree', 'add', '-b', 'version/fixture', versionDir, 'dev'])
  writeFileSync(join(versionDir, 'notes.md'), 'Synthetic release notes\n')
  git(['add', 'notes.md'], versionDir); git(['commit', '-m', 'Release notes'], versionDir)
  const sourceHead = git(['rev-parse', 'HEAD'], versionDir)
  assert.deepEqual(prepareReleaseTarget(repo, target), { ok: true })
  const merged = mergeTaskWorktree(repo, { dir: versionDir, branch: 'version/fixture' }, 'release: fixture', undefined, {
    requireCleanSource: true, expectedSourceHead: sourceHead, expectedTargetHead: target.head, expectedTargetBranch: target.branch
  })
  assert.equal(merged.ok, true, merged.detail)
  assert.equal(git(['rev-parse', 'dev']), devHead)
  assert.equal(readFileSync(join(repo, 'notes.md'), 'utf8'), 'Synthetic release notes\n')
  const remote = join(root, 'remote.git'); git(['init', '--bare', remote])
  git(['remote', 'add', 'origin', remote]); git(['push', 'origin', 'main'])
  assert.equal(git(['rev-parse', 'refs/heads/main'], remote), git(['rev-parse', 'main']))
  assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/heads'], remote), 'refs/heads/main')
})

test('seleção recusa refs inventadas, revisões, branch interna e opção de shell sem trocar o checkout', t => {
  const { repo, git } = fixture(t)
  for (const branch of ['missing', 'main~1', 'HEAD', '@{-1}', '-B', 'refs/heads/main', 'version/fixture', 'main\n--force']) {
    assert.ok(inspectReleaseTarget(repo, branch).error, branch)
  }
  assert.equal(git(['branch', '--show-current']), 'dev')
})

test('destino movido ou pasta suja é recusado sem stash/reset ou perda de trabalho', t => {
  const { repo, git } = fixture(t)
  const target = inspectReleaseTarget(repo, 'main')
  git(['branch', '-f', 'main', 'dev'])
  assert.equal(prepareReleaseTarget(repo, target).ok, false)
  const current = inspectReleaseTarget(repo, 'main')
  writeFileSync(join(repo, 'app.txt'), 'unsaved local edit\n')
  assert.equal(prepareReleaseTarget(repo, current).ok, false)
  assert.equal(readFileSync(join(repo, 'app.txt'), 'utf8'), 'unsaved local edit\n')
  assert.equal(git(['branch', '--show-current']), 'dev')
})

test('branch ocupada por outro worktree não é tomada à força', t => {
  const { root, repo, git } = fixture(t)
  git(['worktree', 'add', join(root, 'occupied-main'), 'main'])
  assert.equal(prepareReleaseTarget(repo, inspectReleaseTarget(repo, 'main')).ok, false)
  assert.equal(git(['branch', '--show-current']), 'dev')
})

test('checkout protege arquivo local ignorado que colide com arquivo versionado no destino', t => {
  const { repo, git } = fixture(t)
  git(['checkout', 'main'])
  writeFileSync(join(repo, 'local-settings.fixture'), 'versioned fixture\n')
  git(['add', 'local-settings.fixture']); git(['commit', '-m', 'Target fixture'])
  git(['checkout', 'dev'])
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'local-settings.fixture\n')
  writeFileSync(join(repo, 'local-settings.fixture'), 'local fixture to preserve\n')
  assert.equal(prepareReleaseTarget(repo, inspectReleaseTarget(repo, 'main')).ok, false)
  assert.equal(git(['branch', '--show-current']), 'dev')
  assert.equal(readFileSync(join(repo, 'local-settings.fixture'), 'utf8'), 'local fixture to preserve\n')
})

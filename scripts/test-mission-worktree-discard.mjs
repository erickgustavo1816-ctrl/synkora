import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const workspace = resolve(import.meta.dirname, '..')
const temporary = join(workspace, '.tmp')
const output = join(temporary, 'mission-worktree-discard-test')
const source = join(workspace, 'src/main/missionWorktreeDiscard.ts')
mkdirSync(temporary, { recursive: true })
execFileSync(process.execPath, [join(workspace, 'node_modules/typescript/bin/tsc'),
  '--outDir', output, '--rootDir', 'src', '--target', 'ES2022', '--module', 'Node16',
  '--moduleResolution', 'Node16', '--esModuleInterop', '--strict', '--skipLibCheck',
  '--types', 'node', existsSync(source) ? 'src/main/missionWorktreeDiscard.ts' : 'src/main/worktree.ts'],
{ cwd: workspace, stdio: 'pipe', windowsHide: true })
const canonical = require(join(output, 'main/worktree.js'))
const implementation = existsSync(source) ? require(join(output, 'main/missionWorktreeDiscard.js')) : {}

function snapshot(project, dir, branch) {
  assert.equal(typeof implementation.missionWorktreeSnapshot, 'function', 'snapshot primitive is missing')
  return implementation.missionWorktreeSnapshot(project, dir, branch)
}

function discard(project, dir, branch, expected) {
  assert.equal(typeof implementation.discardMissionWorktreeChanges, 'function', 'discard primitive is missing')
  return implementation.discardMissionWorktreeChanges(project, dir, branch, expected)
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe'
  }).trim()
}

function removeSyntheticTree(root) {
  const inside = relative(temporary, root)
  assert.ok(inside && !isAbsolute(inside) && !inside.startsWith(`..${sep}`) && inside !== '..')
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      try { rmdirSync(path) } catch { unlinkSync(path) }
    } else if (stat.isDirectory()) removeSyntheticTree(path)
    else unlinkSync(path)
  }
  rmdirSync(root)
}

function fixture(t) {
  const root = mkdtempSync(join(temporary, 'discard-fixture-'))
  t.after(() => { canonical.setGitObserver(null); removeSyntheticTree(root) })
  const project = join(root, 'project')
  const dir = join(root, 'mission')
  const branch = 'mission/synthetic-discard'
  mkdirSync(project)
  git(project, ['init', '--initial-branch=main'])
  for (const [key, value] of [['user.name', 'Synthetic Test'], ['user.email', 'test@example.invalid'],
    ['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['core.hooksPath', join(root, 'empty-hooks')]]) {
    git(project, ['config', key, value])
  }
  writeFileSync(join(project, '.gitignore'), 'node_modules\nignored/\n')
  writeFileSync(join(project, 'base.txt'), 'base\n')
  mkdirSync(join(project, 'tracked'))
  writeFileSync(join(project, 'tracked/file.txt'), 'tracked base\n')
  git(project, ['add', '.'])
  git(project, ['commit', '-m', 'synthetic base'])
  git(project, ['worktree', 'add', '-b', branch, dir])
  return { root, project, dir, branch }
}

function dirty(f) {
  writeFileSync(join(f.dir, 'base.txt'), 'staged edit\n')
  git(f.dir, ['add', 'base.txt'])
  writeFileSync(join(f.dir, 'base.txt'), 'unstaged edit\n')
  mkdirSync(join(f.dir, 'new'))
  writeFileSync(join(f.dir, 'new/content.bin'), Buffer.from([0, 255, 1, 128]))
  writeFileSync(join(f.dir, 'added.txt'), 'staged new\n')
  git(f.dir, ['add', 'added.txt'])
  git(f.dir, ['rm', 'tracked/file.txt'])
}

function approved(f) {
  const value = snapshot(f.project, f.dir, f.branch)
  assert.match(value ?? '', /^[a-f0-9]{64}$/, 'a proven worktree needs an opaque content digest')
  return value
}

function directoryLink(target, path) {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

test('exports both synchronous primitives and reuses the canonical gitRaw', () => {
  assert.equal(typeof implementation.missionWorktreeSnapshot, 'function')
  assert.equal(typeof implementation.discardMissionWorktreeChanges, 'function')
  assert.equal(typeof canonical.gitRaw, 'function')
})

test('approved staged, unstaged, deleted and untracked content becomes verified clean', (t) => {
  const f = fixture(t)
  dirty(f)
  const head = git(f.dir, ['rev-parse', 'HEAD'])
  assert.equal(discard(f.project, f.dir, f.branch, approved(f)), true)
  assert.equal(git(f.dir, ['status', '--porcelain']), '')
  assert.equal(git(f.dir, ['rev-parse', 'HEAD']), head)
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'base\n')
  assert.equal(readFileSync(join(f.dir, 'tracked/file.txt'), 'utf8'), 'tracked base\n')
  assert.equal(existsSync(join(f.dir, 'added.txt')), false)
  assert.equal(existsSync(join(f.dir, 'new')), false)
  assert.equal(readFileSync(join(f.project, 'base.txt'), 'utf8'), 'base\n')
  assert.equal(existsSync(f.dir), true)
  assert.ok(git(f.project, ['show-ref', '--verify', `refs/heads/${f.branch}`]))
})

for (const [name, mutate] of [
  ['same tracked path/status', f => writeFileSync(join(f.dir, 'base.txt'), 'later edit!!!\n')],
  ['same untracked path/status and binary size', f => writeFileSync(join(f.dir, 'new/content.bin'), Buffer.from([0, 254, 1, 128]))],
  ['new untracked path', f => writeFileSync(join(f.dir, 'later.txt'), 'later\n')],
  ['same staged path/status', f => { writeFileSync(join(f.dir, 'added.txt'), 'later staged\n'); git(f.dir, ['add', 'added.txt']) }],
  ['HEAD', f => git(f.dir, ['commit', '--allow-empty', '-m', 'later synthetic HEAD'])]
]) {
  test(`stale receipt refuses after changing ${name}`, (t) => {
    const f = fixture(t)
    dirty(f)
    const before = approved(f)
    mutate(f)
    const status = git(f.dir, ['status', '--porcelain'])
    const bytes = readFileSync(join(f.dir, 'base.txt'))
    assert.notEqual(approved(f), before)
    assert.equal(discard(f.project, f.dir, f.branch, before), false)
    assert.equal(git(f.dir, ['status', '--porcelain']), status)
    assert.deepEqual(readFileSync(join(f.dir, 'base.txt')), bytes)
  })
}

test('opaque digest is stable and bound to the exact worktree identity', (t) => {
  const f = fixture(t)
  const first = approved(f)
  assert.equal(approved(f), first)
  const other = join(f.root, 'other-mission')
  git(f.project, ['worktree', 'add', '-b', 'mission/other-synthetic', other])
  const second = snapshot(f.project, other, 'mission/other-synthetic')
  assert.notEqual(second, first)
  assert.equal(discard(f.project, other, 'mission/other-synthetic', first), false)
})

test('already clean returns true without destructive Git commands', (t) => {
  const f = fixture(t)
  const receipt = approved(f)
  const commands = []
  canonical.setGitObserver(info => commands.push(info.args))
  assert.equal(discard(f.project, f.dir, f.branch, receipt), true)
  assert.equal(commands.some(args => ['reset', 'restore', 'clean'].includes(args[0])), false)
})

for (const [name, candidate] of [
  ['wrong branch', f => [f.dir, 'mission/wrong']],
  ['project/main directory', f => [f.project, 'main']],
  ['nested directory', f => [join(f.dir, 'tracked'), f.branch]],
  ['unregistered sibling', f => [join(f.root, 'not-a-worktree'), f.branch]],
  ['filesystem root', f => [parse(f.root).root, f.branch]]
]) {
  test(`refuses ${name}`, (t) => {
    const f = fixture(t)
    dirty(f)
    mkdirSync(join(f.root, 'not-a-worktree'))
    const receipt = approved(f)
    const [dir, branch] = candidate(f)
    assert.equal(snapshot(f.project, dir, branch), undefined)
    assert.equal(discard(f.project, dir, branch, receipt), false)
    assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'unstaged edit\n')
  })
}

test('root junction cannot impersonate a registered worktree', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  const alias = join(f.root, 'alias')
  directoryLink(f.dir, alias)
  assert.equal(snapshot(f.project, alias, f.branch), undefined)
  assert.equal(discard(f.project, alias, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'unstaged edit\n')
})

test('linked ancestor cannot route the worktree through another directory', (t) => {
  const f = fixture(t)
  const alias = join(f.root, 'alias')
  directoryLink(f.root, alias)
  assert.equal(snapshot(join(alias, 'project'), join(alias, 'mission'), f.branch), undefined)
  assert.equal(discard(f.project, join(alias, 'mission'), f.branch, approved(f)), false)
})

test('a copied .git marker without exact registration is refused', (t) => {
  const f = fixture(t)
  const copy = join(f.root, 'copy')
  mkdirSync(copy)
  writeFileSync(join(copy, '.git'), readFileSync(join(f.dir, '.git')))
  assert.equal(snapshot(f.project, copy, f.branch), undefined)
  assert.equal(discard(f.project, copy, f.branch, approved(f)), false)
})

test('a removed registration invalidates an otherwise approved receipt', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  const admin = git(f.dir, ['rev-parse', '--absolute-git-dir'])
  renameSync(join(admin, 'gitdir'), join(admin, 'gitdir-unregistered'))
  assert.equal(snapshot(f.project, f.dir, f.branch), undefined)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'unstaged edit\n')
})

test('ignored shared node_modules junction is detached and its target survives', (t) => {
  const f = fixture(t)
  dirty(f)
  const shared = join(f.root, 'shared-modules')
  mkdirSync(shared)
  const sentinel = join(shared, 'sentinel.txt')
  writeFileSync(sentinel, 'shared synthetic data\n')
  const without = approved(f)
  directoryLink(shared, join(f.dir, 'node_modules'))
  const receipt = approved(f)
  assert.equal(receipt, without, 'ignored links are outside the content receipt')
  writeFileSync(sentinel, 'later shared synthetic data\n')
  assert.equal(approved(f), receipt)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), true)
  assert.equal(existsSync(join(f.dir, 'node_modules')), false)
  assert.equal(readFileSync(sentinel, 'utf8'), 'later shared synthetic data\n')
})

test('tracked directory replaced by junction never restores into its shared target', (t) => {
  const f = fixture(t)
  const receipt = approved(f)
  unlinkSync(join(f.dir, 'tracked/file.txt'))
  rmdirSync(join(f.dir, 'tracked'))
  const shared = join(f.root, 'shared-tracked')
  mkdirSync(shared)
  writeFileSync(join(shared, 'file.txt'), 'shared sentinel\n')
  directoryLink(shared, join(f.dir, 'tracked'))
  assert.equal(snapshot(f.project, f.dir, f.branch), undefined)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(shared, 'file.txt'), 'utf8'), 'shared sentinel\n')
})

test('nonignored junctions fail closed without reading or deleting their target', (t) => {
  const f = fixture(t)
  const shared = join(f.root, 'shared-untracked')
  mkdirSync(shared)
  writeFileSync(join(shared, 'sentinel.txt'), 'sentinel\n')
  directoryLink(shared, join(f.dir, 'outside'))
  assert.equal(snapshot(f.project, f.dir, f.branch), undefined)
  assert.equal(discard(f.project, f.dir, f.branch, '0'.repeat(64)), false)
  assert.equal(readFileSync(join(shared, 'sentinel.txt'), 'utf8'), 'sentinel\n')
})

test('ignored regular files survive Git clean without -x', (t) => {
  const f = fixture(t)
  dirty(f)
  mkdirSync(join(f.dir, 'ignored'))
  writeFileSync(join(f.dir, 'ignored/sentinel.txt'), 'ignored sentinel\n')
  assert.equal(discard(f.project, f.dir, f.branch, approved(f)), true)
  assert.equal(readFileSync(join(f.dir, 'ignored/sentinel.txt'), 'utf8'), 'ignored sentinel\n')
})

test('restoring ignore rules never deletes previously ignored unapproved content', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.dir, '.gitignore'), 'node_modules\nignored/\nunapproved.txt\n')
  writeFileSync(join(f.dir, 'unapproved.txt'), 'initial ignored synthetic content\n')
  const receipt = approved(f)
  writeFileSync(join(f.dir, 'unapproved.txt'), 'later ignored sentinel\n')
  assert.equal(approved(f), receipt)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'unapproved.txt'), 'utf8'), 'later ignored sentinel\n')
})

test('normal directory-only node_modules ignore rule supports the junction', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.dir, '.gitignore'), 'node_modules/\nignored/\n')
  const shared = join(f.root, 'shared-modules')
  mkdirSync(shared)
  writeFileSync(join(shared, 'sentinel.txt'), 'sentinel\n')
  directoryLink(shared, join(f.dir, 'node_modules'))
  const receipt = approved(f)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), true)
  assert.equal(readFileSync(join(shared, 'sentinel.txt'), 'utf8'), 'sentinel\n')
})

test('inaccessible content fails closed and does not leak a read error', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  const fs = require('node:fs')
  const original = fs.openSync
  t.after(() => { fs.openSync = original })
  fs.openSync = (path, ...args) => {
    if (path === join(f.dir, 'new/content.bin')) throw Object.assign(new Error('synthetic unreadable file'), { code: 'EACCES' })
    return original(path, ...args)
  }
  assert.equal(snapshot(f.project, f.dir, f.branch), undefined)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'unstaged edit\n')
})

test('a tracked ancestor junction appearing after Git restore preserves its target', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  const shared = join(f.root, 'late-shared-tracked')
  mkdirSync(shared)
  writeFileSync(join(shared, 'file.txt'), 'late shared sentinel\n')
  canonical.setGitObserver(info => {
    if (info.args.includes('restore')) {
      unlinkSync(join(f.dir, 'tracked/file.txt'))
      rmdirSync(join(f.dir, 'tracked'))
      directoryLink(shared, join(f.dir, 'tracked'))
    }
  })
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(shared, 'file.txt'), 'utf8'), 'late shared sentinel\n')
})

test('nested untracked repository is refused instead of escalating clean force', (t) => {
  const f = fixture(t)
  const nested = join(f.dir, 'nested-repo')
  mkdirSync(nested)
  git(nested, ['init'])
  writeFileSync(join(nested, 'sentinel.txt'), 'nested sentinel\n')
  assert.equal(snapshot(f.project, f.dir, f.branch), undefined)
  assert.equal(discard(f.project, f.dir, f.branch, '0'.repeat(64)), false)
  assert.equal(readFileSync(join(nested, 'sentinel.txt'), 'utf8'), 'nested sentinel\n')
})

test('index lock makes discard fail without reporting clean', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  const admin = git(f.dir, ['rev-parse', '--absolute-git-dir'])
  writeFileSync(join(admin, 'index.lock'), 'synthetic lock')
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'unstaged edit\n')
})

test('a failed Git cleanup command never reports success', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  const original = canonical.gitRaw
  t.after(() => { canonical.gitRaw = original })
  canonical.gitRaw = (cwd, args, buffer) => {
    if (args.includes('clean')) throw new Error('synthetic cleanup failure')
    return original(cwd, args, buffer)
  }
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(existsSync(join(f.dir, 'new/content.bin')), true)
})

test('failed link neutralization refuses before restoring tracked paths', (t) => {
  const f = fixture(t)
  dirty(f)
  const shared = join(f.root, 'shared-modules')
  mkdirSync(shared)
  writeFileSync(join(shared, 'sentinel.txt'), 'sentinel\n')
  directoryLink(shared, join(f.dir, 'node_modules'))
  const receipt = approved(f)
  const original = canonical.neutralizeReparsePoints
  t.after(() => { canonical.neutralizeReparsePoints = original })
  canonical.neutralizeReparsePoints = () => {}
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'unstaged edit\n')
  assert.equal(readFileSync(join(shared, 'sentinel.txt'), 'utf8'), 'sentinel\n')
})

test('a late write after Git clean prevents false success', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  canonical.setGitObserver(info => {
    if (info.args.includes('clean')) writeFileSync(join(f.dir, 'late.txt'), 'late synthetic write\n')
  })
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'late.txt'), 'utf8'), 'late synthetic write\n')
})

test('a tracked edit arriving after Git clean is preserved before restore', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  canonical.setGitObserver(info => {
    if (info.args.includes('clean')) writeFileSync(join(f.dir, 'base.txt'), 'late tracked edit\n')
  })
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'late tracked edit\n')
})

test('unavailable Git status/snapshot fails closed', (t) => {
  const f = fixture(t)
  const receipt = approved(f)
  const original = canonical.gitRaw
  t.after(() => { canonical.gitRaw = original })
  canonical.gitRaw = () => { throw new Error('synthetic Git failure') }
  assert.equal(snapshot(f.project, f.dir, f.branch), undefined)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
})

test('inherited Git routing is refused without affecting the synthetic project', (t) => {
  const f = fixture(t)
  dirty(f)
  const receipt = approved(f)
  const previous = process.env.GIT_WORK_TREE
  t.after(() => { if (previous === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previous })
  process.env.GIT_WORK_TREE = f.project
  assert.equal(snapshot(f.project, f.dir, f.branch), undefined)
  assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  assert.equal(readFileSync(join(f.project, 'base.txt'), 'utf8'), 'base\n')
})

test('unapproved or malformed snapshot never authorizes discarding edits', (t) => {
  const f = fixture(t)
  dirty(f)
  for (const receipt of ['', 'bad', '0'.repeat(64)]) {
    assert.equal(discard(f.project, f.dir, f.branch, receipt), false)
  }
  assert.equal(readFileSync(join(f.dir, 'base.txt'), 'utf8'), 'unstaged edit\n')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import worktree from '../.tmp/release-recovery-test/worktree.js'
import { releaseIdentityError } from '../src/main/releaseChangesScope.ts'
import { runReleaseForChat } from '../src/main/releaseChat.ts'
import { isUnversionedProject, unversionedRefusal } from '../src/shared/projectVersioning.ts'

// Execute the real boot wrapper with real Git. Only app/store notifications and
// the worker transport are replaced; importing Electron would start the app.
const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const names = ['versionIsolationIsUnique', 'versionIsolationIsNarrow', 'versionIsolationIsValid',
  'versionReleaseIntentPath', 'clearVersionReleaseIntent', 'recoverVersionReleaseIntents', 'releaseVersionImpl']
const compiled = stripTypeScriptTypes(names.map(name => {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(index)
  assert.ok(match, name)
  const end = index.indexOf('\n  }', match.index)
  assert.ok(end > match.index, name)
  return index.slice(match.index, end + 4)
}).join('\n'))
const handler = stripTypeScriptTypes(index.slice(index.indexOf('    releaseRun: async (id) =>'),
  index.indexOf('    releaseSave: (id, input) =>')).trim().replace(/^releaseRun:/, 'const releaseRun =').replace(/,$/, ';'))

function fixture(t, { legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-release-recovery-'))
  t.after(() => {
    const child = relative(resolve(tmpdir()), resolve(root))
    assert.ok(child && !child.startsWith('..') && !child.includes(sep))
    rmSync(root, { recursive: true, force: true })
  })
  const repo = join(root, 'project'); mkdirSync(repo)
  const git = (args, cwd = repo) => execFileSync('git', args, {
    cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Synthetic Recovery'])
  git(['config', 'user.email', 'recovery@example.invalid']); git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'app.txt'), 'base\n')
  git(['add', 'app.txt']); git(['commit', '-m', 'Base fixture'])
  const userData = join(root, 'user-data')
  const source = worktree.createVersionWorktree(repo, join(userData, 'worktrees', 'project-id'),
    legacy ? '--1.3.3' : '1.3.3', legacy ? undefined : 'version-id')
  assert.ok(source)
  const version = { id: 'version-id', name: '1.3.3', projectId: 'project-id', status: 'aberta', branch: source.branch, worktree: source.dir }
  writeFileSync(join(source.dir, 'notes.md'), 'Synthetic patch notes\n')
  git(['add', 'notes.md'], source.dir); git(['commit', '-m', 'Release fixture'], source.dir)
  const intent = { id: version.id, name: version.name, projectId: version.projectId,
    sourceHead: git(['rev-parse', 'HEAD'], source.dir), targetHead: git(['rev-parse', 'HEAD']), targetBranch: 'main', targetDir: repo }
  const journal = join(repo, '.synkora', 'releases', `${version.id}.intent`)
  mkdirSync(dirname(journal), { recursive: true }); writeFileSync(journal, JSON.stringify(intent))
  worktree.ensureSynkoraGitExcludes(repo)
  const versions = [version]; const events = []; const closed = []
  const control = { beforeClose: async () => {}, beforeGit: async () => {}, prepared: [] }
  const releaseMission = { id: 'release-mission', projectId: version.projectId, versionId: version.id, missionType: 'release', status: 'ativa' }
  const identity = { role: 'gui-release', projectId: version.projectId, missionId: releaseMission.id }
  const locks = new Set()
  const context = {
    ...worktree, join, resolve, existsSync, readdirSync, readFileSync, unlinkSync,
    app: { getPath: () => userData },
    missions: { get: id => id === releaseMission.id ? releaseMission : undefined },
    projects: { get: id => id === version.projectId ? { id, path: repo } : undefined },
    backlog: { getVersion: id => versions.find(v => v.id === id), listVersions: () => versions,
      markVersionReleased: id => { const v = versions.find(v => v.id === id); Object.assign(v, { status: 'lancada', worktree: undefined, branch: undefined }); return v } },
    hub: { publish: event => events.push(event) }, blackbox: { record: () => {} },
    emitBacklogChanged: () => {}, pushAll: () => {}, syncBoard: () => {},
    lspManager: { invalidate: () => {} },
    releaseMutationLocks: locks, releaseChangesStore: { list: () => control.prepared },
    releaseChanges: { inspect: () => ({ error: 'source scope unavailable during interrupted cleanup' }) },
    releaseIdentityError, runReleaseForChat, releaseProductPublishesBox: () => false,
    // index.ts asks the project modality first (non-versioned projects, 2026-09-30)
    isUnversionedProject, unversionedRefusal,
    closeTestServersUnder: async dir => { closed.push(dir); await control.beforeClose() },
    gitOff: async (name, ...args) => { await control.beforeGit(name); return worktree[name](...args) }
  }
  const { recover, run } = new Function(...Object.keys(context), `${compiled}\n${handler}\nreturn { recover: recoverVersionReleaseIntents, run: releaseRun }`)(...Object.values(context))
  return { root, repo, source, git, version, versions, intent, journal, events, closed, control, locks,
    run: (overrides = {}) => run({ ...identity, ...overrides }),
    recover: () => recover(version.projectId),
    merge: () => git(['merge', '--no-ff', source.branch, '-m', 'Release already merged']),
    interrupt: () => { unlinkSync(join(source.dir, '.git')); git(['worktree', 'prune', '--expire', 'now']) } }
}

test('boot conclui release já na main mesmo após perder o registro e .git da origem', async t => {
  const f = fixture(t); f.merge(); f.interrupt()
  writeFileSync(join(f.source.dir, 'local-only.fixture'), 'synthetic private local data\n')
  const main = f.git(['rev-parse', 'HEAD'])
  await f.recover()
  assert.equal(f.version.status, 'lancada', JSON.stringify(f.events))
  assert.equal(f.git(['rev-parse', 'HEAD']), main, 'recovery must never repeat the merge')
  assert.equal(existsSync(f.journal), false)
  assert.equal(existsSync(f.source.dir), false)
  assert.equal(readFileSync(join(`${f.source.dir}-carcass-bak`, 'local-only.fixture'), 'utf8'), 'synthetic private local data\n')
  assert.equal(f.git(['for-each-ref', '--format=%(refname)', `refs/heads/${f.source.branch}`]), '')
  assert.deepEqual(f.closed, [f.source.dir])
  await f.recover()
  assert.equal(f.git(['rev-parse', 'HEAD']), main, 'repeating recovery remains idempotent')
})

test('versão legada com slug sanitizado continua recuperável depois da perda do registro', async t => {
  const f = fixture(t, { legacy: true }); f.merge(); f.interrupt()
  await f.recover()
  assert.equal(f.version.status, 'lancada', JSON.stringify(f.events))
  assert.equal(existsSync(f.journal), false)
})

for (const branchRemoved of [false, true]) test(`boot recupera pasta já removida; branch removida: ${branchRemoved}`, async t => {
  const f = fixture(t); f.merge()
  f.git(['worktree', 'remove', f.source.dir])
  if (branchRemoved) f.git(['update-ref', '-d', `refs/heads/${f.source.branch}`, f.intent.sourceHead])
  await f.recover()
  assert.equal(f.version.status, 'lancada')
  assert.equal(existsSync(f.journal), false)
  assert.equal(f.git(['for-each-ref', '--format=%(refname)', `refs/heads/${f.source.branch}`]), '')
})

test('ponteiro .git próprio cujo registro sumiu também permite recuperação', async t => {
  const f = fixture(t); f.merge()
  const marker = readFileSync(join(f.source.dir, '.git'))
  f.interrupt(); writeFileSync(join(f.source.dir, '.git'), marker)
  await f.recover()
  assert.equal(f.version.status, 'lancada')
  assert.equal(existsSync(`${f.source.dir}-carcass-bak`), true)
})

test('edição posterior na carcaça preserva pasta, branch e marcador', async t => {
  const f = fixture(t); f.merge(); f.interrupt()
  writeFileSync(join(f.source.dir, 'app.txt'), 'later local edit\n')
  await f.recover()
  assert.equal(f.version.status, 'aberta')
  assert.equal(existsSync(f.journal), true)
  assert.equal(readFileSync(join(f.source.dir, 'app.txt'), 'utf8'), 'later local edit\n')
  assert.equal(existsSync(`${f.source.dir}-carcass-bak`), false)
  assert.equal(f.git(['rev-parse', f.source.branch]), f.intent.sourceHead)
})

test('branch da origem que avançou depois do marcador permanece intacta', async t => {
  const f = fixture(t); f.merge(); f.interrupt()
  f.git(['branch', '-f', f.source.branch, 'main'])
  const moved = f.git(['rev-parse', f.source.branch])
  await f.recover()
  assert.equal(f.version.status, 'aberta')
  assert.equal(existsSync(f.source.dir), true)
  assert.equal(existsSync(f.journal), true)
  assert.equal(f.git(['rev-parse', f.source.branch]), moved)
  assert.deepEqual(f.closed, [])
})

test('antes do merge só o marcador é limpo, sem integração nem fechamento da origem', async t => {
  const f = fixture(t)
  await f.recover()
  assert.equal(f.version.status, 'aberta')
  assert.equal(existsSync(f.source.dir), true)
  assert.equal(existsSync(f.journal), false)
  assert.equal(f.git(['rev-parse', 'HEAD']), f.intent.targetHead)
  assert.deepEqual(f.closed, [])
})

test('origem desaparecida antes do merge não é confundida com entrega', async t => {
  const f = fixture(t); f.git(['worktree', 'remove', f.source.dir])
  await f.recover()
  assert.equal(f.version.status, 'aberta')
  assert.equal(existsSync(f.journal), true)
  assert.deepEqual(f.closed, [])
})

for (const mutation of ['target-edit', 'target-head', 'target-branch', 'version-owner', 'close-error']) {
  test(`recovery repete provas após aguardar prévias: ${mutation}`, async t => {
    const f = fixture(t); f.merge(); f.interrupt()
    f.control.beforeClose = async () => {
      if (mutation === 'target-edit') writeFileSync(join(f.repo, 'app.txt'), 'late destination edit\n')
      if (mutation === 'target-head') f.git(['commit', '--allow-empty', '-m', 'Concurrent commit'])
      if (mutation === 'target-branch') f.git(['checkout', '-b', 'other'])
      if (mutation === 'version-owner') f.versions.push({ ...f.version, id: 'other-version' })
      if (mutation === 'close-error') throw new Error('Synthetic shutdown failure')
    }
    await f.recover()
    assert.equal(f.version.status, 'aberta')
    assert.equal(existsSync(f.source.dir), true)
    assert.equal(existsSync(f.journal), true)
    assert.equal(existsSync(`${f.source.dir}-carcass-bak`), false)
    if (mutation === 'target-edit') assert.equal(readFileSync(join(f.repo, 'app.txt'), 'utf8'), 'late destination edit\n')
  })
}

for (const mutation of ['foreign-marker', 'outside-root', 'linked-root', 'branch-rebound', 'shared-identity', 'invalid-intent']) {
  test(`identidade insuficiente não fecha processos nem altera arquivos: ${mutation}`, async t => {
    const f = fixture(t); f.merge(); f.interrupt()
    if (mutation === 'foreign-marker') writeFileSync(join(f.source.dir, '.git'), `gitdir: ${join(f.root, 'foreign', 'worktrees', 'entry')}\n`)
    if (mutation === 'outside-root') {
      const other = join(f.root, 'unmanaged-origin'); renameSync(f.source.dir, other); f.version.worktree = other
    }
    if (mutation === 'linked-root') {
      const other = join(f.root, 'link-target'); renameSync(f.source.dir, other)
      symlinkSync(other, f.source.dir, process.platform === 'win32' ? 'junction' : 'dir')
    }
    if (mutation === 'branch-rebound') f.git(['worktree', 'add', join(f.root, 'other-checkout'), f.source.branch])
    if (mutation === 'shared-identity') f.versions.push({ ...f.version, id: 'other-version' })
    if (mutation === 'invalid-intent') writeFileSync(f.journal, JSON.stringify({ ...f.intent, projectId: 'foreign-project' }))
    await f.recover()
    assert.equal(f.version.status, 'aberta')
    assert.equal(existsSync(f.journal), true)
    assert.equal(existsSync(f.version.worktree), true)
    assert.deepEqual(f.closed, [])
  })
}

test('release_run recupera a mesma tentativa e libera release_push sem exigir reinício', async t => {
  const f = fixture(t); f.merge(); f.interrupt()
  const main = f.git(['rev-parse', 'HEAD'])
  const response = await f.run()
  assert.equal(f.version.status, 'lancada')
  assert.match(response, /release_push/)
  assert.doesNotMatch(response, /reinici/)
  assert.equal(f.git(['rev-parse', 'HEAD']), main)
  assert.equal(existsSync(f.journal), false)
  assert.equal(f.locks.size, 0)
})

test('recovery por MCP exige autoridade da mesma release e conserva a trava do projeto', async t => {
  const f = fixture(t); f.merge(); f.interrupt()
  for (const identity of [{ role: 'gui-dev' }, { projectId: 'other-project' }, { missionId: 'other-mission' }]) {
    assert.match(await f.run(identity), /autoridade|não está ligada/)
    assert.equal(f.version.status, 'aberta')
    assert.equal(existsSync(f.journal), true)
    assert.deepEqual(f.closed, [])
  }
  let unblock
  let entered
  const enteredClose = new Promise(resolve => { entered = resolve })
  f.control.beforeClose = () => { entered(); return new Promise(resolve => { unblock = resolve }) }
  const first = f.run()
  await enteredClose
  assert.match(await f.run(), /operação de release está em andamento/)
  unblock(); await first
  assert.equal(f.version.status, 'lancada')
  assert.equal(f.closed.length, 1)
  assert.equal(f.locks.size, 0)
})

test('recibo de correção preparado bloqueia recovery concorrente e preserva a tentativa', async t => {
  const f = fixture(t); f.merge(); f.interrupt()
  f.control.prepared = [{ state: 'prepared' }]
  assert.match(await f.run(), /release_save/)
  assert.equal(f.version.status, 'aberta')
  assert.equal(existsSync(f.journal), true)
  assert.deepEqual(f.closed, [])
  assert.equal(f.locks.size, 0)
  await f.recover()
  assert.equal(f.version.status, 'aberta')
  assert.equal(existsSync(f.journal), true)
})

for (const failedAt of ['probeReleaseRecovery', 'finishReleaseRecovery']) {
  test(`falha do worker preserva o marcador e permite nova tentativa: ${failedAt}`, async t => {
    const f = fixture(t); f.merge(); f.interrupt()
    f.control.beforeGit = async name => { if (name === failedAt) throw new Error('Synthetic worker failure') }
    await f.recover()
    assert.equal(f.version.status, 'aberta')
    assert.equal(existsSync(f.journal), true)
    assert.equal(existsSync(f.source.dir), true)
    f.control.beforeGit = async () => {}
    await f.run()
    assert.equal(f.version.status, 'lancada')
  })
}

test('recovery alinha somente a fotografia anterior quando o ref avançou antes dos arquivos', async t => {
  const f = fixture(t)
  const tree = f.git(['merge-tree', '--write-tree', f.intent.targetHead, f.intent.sourceHead]).split(/\r?\n/)[0]
  const merge = f.git(['commit-tree', tree, '-p', f.intent.targetHead, '-p', f.intent.sourceHead, '-m', 'Interrupted release fixture'])
  f.git(['update-ref', 'refs/heads/main', merge, f.intent.targetHead])
  assert.notEqual(f.git(['status', '--porcelain']), '')
  await f.recover()
  assert.equal(f.version.status, 'lancada')
  assert.equal(f.git(['status', '--porcelain']), '')
  assert.equal(f.git(['rev-parse', 'HEAD']), merge)
  assert.equal(readFileSync(join(f.repo, 'notes.md'), 'utf8'), 'Synthetic patch notes\n')
})

test('pasta em uso no Windows fica preservada e release_run finaliza após liberar o processo', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); f.merge(); f.interrupt()
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
    cwd: f.source.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
  await once(child.stdout, 'data')
  await f.recover()
  assert.equal(f.version.status, 'aberta')
  assert.equal(existsSync(f.source.dir), true)
  assert.equal(existsSync(f.journal), true)
  child.kill(); await exited
  await f.run()
  assert.equal(f.version.status, 'lancada')
  assert.equal(existsSync(f.journal), false)
})

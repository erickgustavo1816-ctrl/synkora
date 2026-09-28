import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, load, git } from './direct-release-test-utils.mjs'

function workspaceResolver() {
  assert.ok(existsSync('src/main/releaseWorkspace.ts'), 'release workspace resolver must exist')
  return load('src/main/releaseWorkspace.ts', {}).resolveReleaseWorkspace
}

test('release workspace selects the proven version isolation before ascent and the current project after ascent', () => {
  const resolveWorkspace = workspaceResolver()
  const version = { id: 'v1', projectId: 'p1', name: 'V1', status: 'aberta', worktree: '/version', branch: 'version/v1' }
  const mission = { id: 'm1', projectId: 'p1', versionId: 'v1', missionType: 'release', status: 'ativa' }
  const input = { mission, project: { id: 'p1', path: '/project' }, version, versions: [version], isolationValid: true,
    target: { branch: 'production', currentBranch: 'dev', branches: ['production', 'dev'], needsSwitch: true } }
  assert.deepEqual(resolveWorkspace(input), { dir: '/version', base: 'production' })
  assert.ok(resolveWorkspace({ ...input, isolationValid: false }).error)
  const released = { ...version, status: 'lancada', releasedAt: '2026-02-01' }
  const after = { ...input, version: released, versions: [released], target: { ...input.target, currentBranch: 'production', needsSwitch: false }, originHead: 'a'.repeat(40) }
  assert.deepEqual(resolveWorkspace(after), { dir: '/project', base: 'a'.repeat(40) })
  assert.deepEqual(resolveWorkspace({ ...after, originHead: undefined, pendingBase: 'b'.repeat(40) }), { dir: '/project', base: 'b'.repeat(40) })
  assert.deepEqual(resolveWorkspace({ ...after, originHead: undefined }), { dir: '/project', base: 'HEAD' })
  for (const patch of [{ versions: [released, { ...released, id: 'v2', releasedAt: '2026-03-01' }] },
    { mission: { ...mission, projectId: 'other' } }, { mission: { ...mission, status: 'concluida' } },
    { target: { ...after.target, needsSwitch: true, currentBranch: 'dev' } }]) assert.ok(resolveWorkspace({ ...after, ...patch }).error)
})

async function panelFixture(t) {
  const f = fixture(t), version = f.backlog.createVersion('p1', { name: 'V2' })
  const wt = f.worktree.createVersionWorktree(f.path, join(f.root, 'worktrees'), version.name, version.id)
  f.backlog.setVersionBranch(version.id, wt.branch, wt.dir)
  const mission = f.missions.create('p1', { title: 'Release', goal: 'Fix', direct: true, missionType: 'release', versionId: version.id })
  const resolveReleaseWorkspace = async candidate => {
    const v = f.backlog.getVersion(candidate.versionId)
    // Old handlers ignore the injected resolver, so they fail on their missing mission.worktree.
    if (!existsSync('src/main/releaseWorkspace.ts')) return { dir: wt.dir, base: 'main' }
    return workspaceResolver()({ mission: candidate, version: v, project: { id: 'p1', path: f.path }, versions: f.backlog.listVersions('p1'),
      isolationValid: f.worktree.isExpectedVersionWorktree(f.path, v.worktree, v.branch),
      target: { branch: 'main', currentBranch: 'main', branches: ['main'], needsSwitch: false },
      originHead: f.worktree.fullCommitSha(f.path, 'refs/remotes/origin/main') })
  }
  return { ...f, version, wt, mission, resolveReleaseWorkspace }
}

test('all four mission panel channels read release changes before and after ascent with commit scope intact', async t => {
  const f = await panelFixture(t)
  load('src/main/ipc/missions.ts', f.electron, { '../gitAsync': { gitOff: f.gitOff } }).registerMissionsIpc(f.ctx, {
    resolveReleaseWorkspace: f.resolveReleaseWorkspace, lifecycle: { closeInBackground() {} }, engine: {}, maestroEngine: {}, guiSessions: {}
  })
  for (const dir of [f.wt.dir, f.path]) {
    if (dir === f.path) {
      git(f.path, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      f.backlog.updateVersion(f.version.id, { status: 'lancada', releasedAt: '2026-03-01' })
    }
    writeFileSync(join(dir, 'readme.txt'), 'initial\ncorrection\n')
    git(dir, 'add', 'readme.txt'); git(dir, 'commit', '-m', 'correct release')
    const sha = git(dir, 'rev-parse', 'HEAD')
    const call = (name, ...args) => f.handlers.get(`missions:${name}`)({}, f.mission.id, ...args)
    const summary = await call('workspaceFiles')
    assert.equal(summary.ok, true, JSON.stringify(summary)); assert.equal(summary.summary.ahead, 1)
    assert.match((await call('workspaceFileDiff', 'readme.txt')).diff, /correction/)
    assert.equal((await call('commits')).commits[0].sha, sha)
    assert.match((await call('commitDiff', sha)).diff, /correction/)
    assert.equal((await call('commitDiff', git(dir, 'rev-parse', 'HEAD^'))).ok, false)
  }
})

test('mission file roots read, open and reveal from the release workspace through both phases', async t => {
  const f = await panelFixture(t), opened = [], revealed = []
  const electron = { ...f.electron, shell: { openPath: async path => { opened.push(path); return '' }, showItemInFolder: path => revealed.push(path) } }
  load('src/main/ipc/files.ts', electron).registerFilesIpc(f.ctx, { assertAppRendererSender() {}, resolveReleaseWorkspace: f.resolveReleaseWorkspace })
  const root = { kind: 'mission', missionId: f.mission.id }
  for (const dir of [f.wt.dir, f.path]) {
    if (dir === f.path) f.backlog.updateVersion(f.version.id, { status: 'lancada', releasedAt: '2026-03-01' })
    writeFileSync(join(dir, 'scope.md'), dir === f.path ? 'project correction' : 'version correction')
    const call = (name, ...args) => f.handlers.get(`files:${name}`)({}, 'p1', root, ...args)
    const preview = await call('preview', 'scope.md')
    assert.ok(preview, 'release file preview must resolve its mission root')
    assert.match(JSON.stringify(preview), dir === f.path ? /project correction/ : /version correction/)
    assert.ok((await call('listTree')).entries.some(entry => entry.path === 'scope.md'))
    assert.equal((await call('openExternal', 'scope.md', 'default')).ok, true)
    assert.equal(opened.at(-1), join(dir, 'scope.md'))
    assert.equal((await call('openExternal', 'scope.md', 'reveal')).ok, true)
    assert.equal(revealed.at(-1), join(dir, 'scope.md'))
    assert.equal(await call('preview', '../outside.md'), null)
  }
  f.missions.update(f.mission.id, { status: 'arquivada' })
  assert.equal(await f.handlers.get('files:preview')({}, 'p1', root, 'scope.md'), null)
})

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const bundles = new Map()
export function load(file, electron, overrides = {}) {
  if (!bundles.has(file)) bundles.set(file, buildSync({ entryPoints: [file], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['electron', '../gitAsync'] }).outputFiles[0].text)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundles.get(file))(id =>
    id === 'electron' ? electron : id in overrides ? overrides[id] : require(id), module, module.exports)
  return module.exports
}
export const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim()
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'direct-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'project'), data = join(root, 'data')
  mkdirSync(path); mkdirSync(data)
  git(path, 'init', '-b', 'main'); git(path, 'config', 'user.name', 'Synthetic'); git(path, 'config', 'user.email', 'synthetic@example.invalid')
  writeFileSync(join(path, 'readme.txt'), 'initial\n'); git(path, 'add', '.'); git(path, 'commit', '-m', 'initial')
  const handlers = new Map(), events = []
  const electron = { app: { getPath: () => data }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } }
  const { BacklogStore } = load('src/main/backlog.ts', electron)
  const { MissionStore } = load('src/main/missions.ts', electron)
  const worktree = load('src/main/worktree.ts', electron)
  const backlog = new BacklogStore(), missions = new MissionStore(), project = { id: 'p1', path }
  const ctx = { backlog, missions, projects: { get: id => id === 'p1' ? project : undefined }, blackbox: { record() {} } }
  let isolationCalls = 0
  const gitOff = async (name, ...args) => { if (name === 'createVersionWorktree') isolationCalls++; return worktree[name](...args) }
  load('src/main/ipc/backlog.ts', electron, { '../gitAsync': { gitOff } }).registerBacklogIpc(ctx, {
    emitBacklogChanged: id => events.push(id),
    versionIsolationIsValid: (dir, version) => Boolean(version.branch && version.worktree && worktree.isExpectedVersionWorktree(dir, version.worktree, version.branch)),
    listVersionReleases: () => [], listProjectReleases: () => [], releaseVersionImpl: async () => ''
  })
  const call = (input, id = 'p1') => {
    const fn = handlers.get('backlog:directRelease')
    assert.equal(typeof fn, 'function', 'direct release IPC must be registered')
    return fn({}, id, input)
  }
  return { root, path, ctx, electron, backlog, missions, worktree, handlers, events, call, gitOff, isolationCalls: () => isolationCalls }
}

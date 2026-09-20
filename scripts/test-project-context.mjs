import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildProjectContextTools } from '../.tmp/project-context-test/projectContextTools.js'
import { ProjectContextStore } from '../.tmp/project-context-test/projectContextStore.js'
import { projectContextSnapshot } from '../.tmp/project-context-test/projectContextGit.js'
import { registerProjectContextKit, withProjectContextNotice } from '../.tmp/project-context-test/projectContextKit.js'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const NOW = '2026-09-12T12:00:00.000Z'
function bench(t, count = 0) {
  const root = mkdtempSync(join(tmpdir(), 'synkora-context-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = { id: 'project1', name: 'Synthetic product', path: root, createdAt: NOW }
  const version = (id, name, status = 'aberta') => ({ id, projectId: project.id, name, status,
    deliveries: [], createdAt: NOW, updatedAt: NOW })
  const versions = [version('v134', '1.3.4'), version('v135', '1.3.5'), version('v132', '1.3.2', 'lancada')]
  const mission = (id, versionId, extra = {}) => ({ id, projectId: project.id, title: `Mission ${id}`,
    versionId, status: 'concluida', createdAt: NOW, updatedAt: NOW, ...extra })
  const current = mission('current1', 'v134', { status: 'ativa', worktree: root,
    baseBranch: 'version/v134', goal: 'Improve access for the synthetic product' })
  const missions = [current,
    mission('old', 'v132', { goal: 'Preserve access rules', summary: 'Ancient permission decision',
      delivery: { capturedAt: NOW, commits: ['Preserve access'], files: ['src/access.ts'], sourceHead: OLD } }),
    mission('parallel', 'v135', { summary: 'Parallel exclusive feature',
      delivery: { capturedAt: NOW, commits: ['Parallel change'], files: ['src/parallel.ts'], sourceHead: NEW } }),
    mission('legacy', 'v134', { summary: 'A legacy result with no SHA' }),
    ...Array.from({ length: count }, (_, i) => mission(`bulk-${String(i).padStart(4, '0')}`, 'v134', { summary: `History entry ${i}` }))]
  const file = join(root, 'context.json')
  const notes = new ProjectContextStore(file)
  let head = OLD
  const included = { [OLD]: true, [NEW]: false }
  const audit = []
  const deps = {
    projects: { get: (id) => id === project.id ? project : undefined },
    missions: { get: (id) => missions.find((m) => m.id === id), list: (id) => missions.filter((m) => m.projectId === id) },
    versions: { listVersions: (id) => versions.filter((v) => v.projectId === id) },
    plans: { list: () => [] }, notes,
    inspect: async (_cwd, heads) => ({ head, included: Object.fromEntries(heads.map((sha) => [sha, included[sha] ?? null])) }),
    audit: (event, _id, detail) => audit.push({ event, detail })
  }
  const tools = buildProjectContextTools(deps)
  const identity = { paneId: 'gui-dev-current1', role: 'gui-delegator', projectId: project.id,
    missionId: current.id, cwd: root }
  return { root, file, project, versions, missions, current, notes, tools, deps, identity, included, audit,
    setHead: (value) => { head = value },
    record: (extra = {}) => tools.record(identity, { key: 'access', expectedRevision: 0, kind: 'decision',
      title: 'Access decision', body: 'Access is scoped to the current project.', sources: ['file:src/access.ts'], ...extra }) }
}
const parse = async (value) => JSON.parse(await value)

test('orientation stays bounded with hundreds of missions and excludes parallel work', async (t) => {
  const b = bench(t, 500)
  const status = await parse(b.tools.status(b.identity))
  assert.equal(status.version.state, 'em desenvolvimento')
  assert.equal(status.version.name, '1.3.4')
  assert.equal(status.mission.id, 'current1')
  assert.equal(status.checkoutHead, OLD)
  assert.equal(status.counts.sameVersion, 502)
  assert.ok(JSON.stringify(status).length < 5000)
  assert.doesNotMatch(JSON.stringify(status), /1\.3\.5|Parallel exclusive|History entry/)
  assert.doesNotMatch(b.tools.briefing('project1', 'current1'), /Parallel exclusive|History entry/)
})
test('all retained missions are searchable; an old decision survives 500 newer missions', async (t) => {
  const b = bench(t, 500)
  const result = await parse(b.tools.search(b.identity, { query: 'ancient permission' }))
  assert.equal(result.total, 1)
  assert.equal(result.entries[0].id, 'mission:old')
  assert.equal(result.entries[0].version, '1.3.2')
  assert.equal(result.entries[0].codePresence, 'commit de origem presente')
})
test('the current mission overview takes priority and inherited overview changes invalidate orientation', async (t) => {
  const b = bench(t)
  const inherited = { id: 'note:old:overview', projectId: 'project1', missionId: 'old', versionId: 'v132',
    kind: 'overview', title: 'Product overview', body: 'Inherited product overview', sources: ['mission:old'] }
  b.notes.save(inherited, 0)
  await b.tools.status(b.identity)
  assert.match(b.tools.briefing('project1', 'current1'), /Inherited product overview/u)
  b.notes.save({ ...inherited, body: 'Corrected inherited overview' }, 1)
  assert.match(b.tools.notice(b.identity), /context_status/u)
  await b.record({ key: 'overview', kind: 'overview', body: 'Current mission understanding' })
  b.notes.save({ ...inherited, body: 'Later historical overview' }, 2)
  const briefing = b.tools.briefing('project1', 'current1')
  assert.match(briefing, /Current mission understanding/u)
  assert.doesNotMatch(briefing, /Later historical overview/u)
})
test('pagination traverses the whole catalog without a recent-mission cutoff', async (t) => {
  const b = bench(t, 75)
  const ids = new Set()
  let offset = 0
  let total
  do {
    const result = await parse(b.tools.search(b.identity, { query: 'history entry', offset, limit: 7 }))
    total = result.total
    for (const entry of result.entries) { assert.ok(!ids.has(entry.id)); ids.add(entry.id) }
    offset = result.nextOffset
  } while (offset !== null)
  assert.equal(total, 75)
  assert.equal(ids.size, 75)
})
test('parallel work requires an explicit scope and reports absent commits', async (t) => {
  const b = bench(t)
  assert.equal((await parse(b.tools.search(b.identity, { query: 'parallel exclusive' }))).total, 0)
  const result = await parse(b.tools.search(b.identity, { query: 'parallel exclusive', scope: 'project' }))
  assert.equal(result.entries[0].version, '1.3.5')
  assert.equal(result.entries[0].codePresence, 'commit de origem ausente')
  assert.equal((await parse(b.tools.search(b.identity, { versionId: 'v135', query: 'parallel' }))).total, 1)
  const selected = await parse(b.tools.search(b.identity, { missionId: 'parallel', query: 'parallel' }))
  assert.equal(selected.total, 1)
  assert.equal(selected.scope, 'mission:parallel')
})
test('file lookup accepts Windows paths and preserves project-relative source names', async (t) => {
  const b = bench(t)
  const result = await parse(b.tools.search(b.identity, { file: 'src\\access.ts' }))
  assert.equal(result.total, 1)
  assert.equal(result.entries[0].id, 'mission:old')
})
test('legacy records and non-Git projects never claim verified availability or publication', async (t) => {
  const b = bench(t)
  const entry = await parse(b.tools.read(b.identity, { id: 'mission:legacy' }))
  assert.equal(entry.codePresence, 'não comprovada')
  const tools = buildProjectContextTools({ ...b.deps, inspect: async () => { throw new Error('offline') } })
  const status = await parse(tools.status(b.identity))
  assert.equal(status.ok, true)
  assert.equal(status.checkoutHead, undefined)
  assert.match(status.publication, /Não comprovada/)
})
test('presence is checked again after a checkout advances', async (t) => {
  const b = bench(t)
  assert.equal((await parse(b.tools.read(b.identity, { id: 'mission:parallel' }))).codePresence, 'commit de origem ausente')
  b.included[NEW] = true
  b.setHead(NEW)
  const next = await parse(b.tools.read(b.identity, { id: 'mission:parallel' }))
  assert.equal(next.codePresence, 'commit de origem presente')
  assert.equal(next.checkoutHead, NEW)
})
test('sources are paginated without losing long decisions', async (t) => {
  const b = bench(t)
  const saved = await parse(b.record({ body: 'Long synthetic decision. '.repeat(130) }))
  let offset = 0
  let body = ''
  do {
    const result = await parse(b.tools.read(b.identity, { id: saved.id, offset, limit: 250 }))
    body += result.content
    offset = result.nextOffset
  } while (offset !== null)
  assert.equal(body, 'Long synthetic decision. '.repeat(130).trim())
})
test('decisions without code symbols persist and are searchable after restart', async (t) => {
  const b = bench(t)
  const saved = await parse(b.record({ body: 'The owner postponed the mobile edition because the desktop workflow comes first.' }))
  assert.equal(saved.ok, true)
  const restored = buildProjectContextTools({ ...b.deps, notes: new ProjectContextStore(b.file) })
  const result = await parse(restored.search(b.identity, { query: 'postponed mobile' }))
  assert.equal(result.entries[0].id, saved.id)
  assert.equal(result.entries[0].kind, 'decision')
})
test('idempotent retries and stale revisions preserve concurrent edits and historical text', async (t) => {
  const b = bench(t)
  const saved = await parse(b.record())
  assert.equal((await parse(b.record())).revision, 1)
  assert.equal((await parse(b.record({ body: 'Conflicting edit' }))).ok, false)
  assert.equal((await parse(b.record({ expectedRevision: 1, body: 'Revised access decision' }))).revision, 2)
  const old = await parse(b.tools.read(b.identity, { id: saved.id, revision: 1 }))
  assert.equal(old.historical, true)
  assert.match(old.content, /scoped to the current project/)
  assert.equal((await parse(b.tools.read(b.identity, { id: saved.id }))).revision, 2)
  assert.equal(b.current.status, 'ativa')
})
test('failed persistence never advances the in-memory revision', (t) => {
  const b = bench(t)
  const blocker = join(b.root, 'blocker')
  writeFileSync(blocker, 'file, not directory')
  const store = new ProjectContextStore(join(blocker, 'notes.json'))
  assert.throws(() => store.save({ id: 'test', projectId: 'project1', missionId: 'current1',
    kind: 'note', title: 'Synthetic', body: 'Synthetic', sources: ['mission:current1'] }, 0))
  assert.equal(store.get('project1', 'test'), undefined)
})
test('a corrupt store is not silently overwritten with empty memory', async (t) => {
  const b = bench(t)
  writeFileSync(b.file, '{broken')
  const notes = new ProjectContextStore(b.file)
  assert.throws(() => notes.list('project1'), /Memória indisponível/)
  const tools = buildProjectContextTools({ ...b.deps, notes })
  assert.equal((await parse(tools.status(b.identity))).ok, false)
  assert.equal(readFileSync(b.file, 'utf8'), '{broken')
})
test('project, mission and workspace boundaries reject forged identities and references', async (t) => {
  const b = bench(t)
  for (const identity of [{ ...b.identity, projectId: 'foreign' }, { ...b.identity, missionId: 'missing' },
    { ...b.identity, cwd: join(b.root, '..') }, { ...b.identity, role: 'maestro' },
    { ...b.identity, role: 'gui-planner' }, { ...b.identity, role: 'gui-release' }]) {
    assert.equal((await parse(b.tools.search(identity, { scope: 'project' }))).ok, false)
  }
  assert.equal((await parse(b.tools.search(b.identity, { versionId: 'foreign' }))).ok, false)
  assert.equal((await parse(b.tools.read(b.identity, { id: 'mission:foreign' }))).ok, false)
  assert.equal((await parse(b.record({ sources: ['mission:foreign'] }))).ok, false)
})
test('helpers and reviewers can read but cannot register decisions', async (t) => {
  const b = bench(t)
  const helpers = [{ ...b.identity, role: 'ajudante', paneId: 'helper-mcp-1' },
    { ...b.identity, paneId: 'gui-reviewer-current1' }]
  for (const identity of helpers) {
    assert.equal((await parse(b.tools.status(identity))).ok, true)
    const registered = await parse(b.tools.record(identity, { key: 'x', expectedRevision: 0, kind: 'note',
      title: 'x', body: 'x', sources: ['mission:current1'] }))
    assert.equal(registered.ok, false)
  }
})
test('private paths and synthetic credentials do not enter tool output or saved memory', async (t) => {
  const b = bench(t)
  for (const file of ['../outside.ts', '.env', '.env.local', 'private.key', 'C:/outside.ts']) {
    assert.equal((await parse(b.record({ sources: [`file:${file}`] }))).ok, false)
    assert.equal((await parse(b.tools.search(b.identity, { file }))).ok, false)
  }
  const fake = 'sk-ant-' + 'synthetic'.repeat(12)
  await b.record({ body: `Synthetic fixture token: ${fake}` })
  assert.ok(!readFileSync(b.file, 'utf8').includes(fake))
  assert.ok(!JSON.stringify(b.audit).includes(fake))
})
test('notices track the current version, stay quiet for parallel changes and clear on reread', async (t) => {
  const b = bench(t)
  const first = await parse(b.tools.status(b.identity))
  assert.equal((await parse(b.tools.status(b.identity, first.revision))).unchanged, true)
  b.missions.find((m) => m.id === 'parallel').summary = 'Parallel updated'
  assert.equal(b.tools.notice(b.identity), undefined)
  b.current.summary = 'Current version changed'
  assert.match(b.tools.notice(b.identity), /context_status/)
  assert.equal(withProjectContextNotice({ content: [] }, b.tools, b.identity).content.length, 1)
  await b.tools.status(b.identity)
  assert.equal(b.tools.notice(b.identity), undefined)
})
test('explicitly consulted sources are watched even when they belong to an older version', async (t) => {
  const b = bench(t)
  await b.tools.status(b.identity)
  await b.tools.read(b.identity, { id: 'mission:old' })
  b.missions.find((m) => m.id === 'old').summary = 'Historical decision corrected'
  assert.match(b.tools.notice(b.identity), /context_status/u)
  await b.tools.status(b.identity)
  assert.equal(b.tools.notice(b.identity), undefined)
  await b.tools.read(b.identity, { id: 'mission:parallel' })
  b.missions.find((m) => m.id === 'parallel').summary = 'Explicitly consulted parallel source changed'
  assert.match(b.tools.notice(b.identity), /context_status/u)
})
test('a disappearing mission loses write authority even during an awaited Git read', async (t) => {
  const b = bench(t)
  b.deps.inspect = async () => { b.current.status = 'arquivada'; return { head: OLD, included: {} } }
  assert.equal((await parse(b.record())).ok, false)
  assert.equal(b.notes.list('project1').length, 0)
})
test('MCP read-only catalog omits writes and derives the project from the authenticated identity', async (t) => {
  const b = bench(t)
  const registered = new Map()
  registerProjectContextKit({ registerTool: (name, spec, handler) => registered.set(name, { spec, handler }) },
    b.tools, b.identity, false)
  assert.deepEqual([...registered.keys()], ['context_status', 'context_search', 'context_read'])
  assert.equal(registered.get('context_search').spec.inputSchema.projectId, undefined)
  const search = registered.get('context_search')
  const response = await search.handler({ query: 'ancient' })
  assert.equal(JSON.parse(response.content[0].text).total, 1)
})
test('real Git proves ancestor, parallel and missing source commits without changing checkout', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-context-git-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Synthetic test')
  git('config', 'user.email', 'synthetic@example.invalid')
  writeFileSync(join(root, 'fixture.txt'), 'base')
  git('add', 'fixture.txt'); git('commit', '-m', 'Base')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-b', 'parallel')
  writeFileSync(join(root, 'fixture.txt'), 'parallel')
  git('commit', '-am', 'Parallel')
  const parallel = git('rev-parse', 'HEAD')
  git('checkout', 'main')
  const snapshot = projectContextSnapshot(root, [base, parallel, 'f'.repeat(40), '--malicious'])
  assert.equal(snapshot.included[base], true)
  assert.equal(snapshot.included[parallel], false)
  assert.equal(snapshot.included['f'.repeat(40)], null)
  assert.equal(snapshot.head, base)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(git('branch', '--show-current'), 'main')
})

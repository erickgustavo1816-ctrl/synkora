import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { releaseNextStep, releaseDoneDecision, ensureReleaseMission } from '../src/main/releaseChat.ts'
import { resolveReleaseChangeScope } from '../src/main/releaseChangesScope.ts'
import { buildReleaseChanges } from '../src/main/releaseChanges.ts'
import { ReleaseChangesStore } from '../src/main/releaseChangesStore.ts'
import { applyReleaseChange, prepareReleaseChange, pushReleaseChanges, releaseChangeFiles,
  releaseChangesProbe } from '../src/main/releaseChangesGit.ts'

const launched = { id: 'v1', projectId: 'p1', name: '1.0.0', status: 'lancada' }
const status = (patch = {}) => ({
  version: launched, pendingMissions: [], openBacklogItems: [],
  integrationPending: [], planLockMessage: null, releaseIntentPending: false, ...patch
})

test('uma versão já subida segue para entrega e fecho, sem mandar subi-la novamente', () => {
  const text = releaseNextStep(status())
  assert.match(text, /release_done/u)
  assert.doesNotMatch(text, /chame release_run/u)
})

test('correções locais têm uma receita para salvar e impedem o fecho prematuro', () => {
  assert.match(releaseNextStep(status({ changes: { dirty: true, pending: false } })), /release_save/u)
  const decision = releaseDoneDecision({
    version: launched, publishRequired: false, changes: { dirty: true, pending: false }
  })
  assert.equal(decision.ok, false)
  assert.match(decision.text, /release_save/u)
  const pendingPush = { dirty: false, pending: false, pendingPush: true }
  assert.match(releaseNextStep(status({ changes: pendingPush })), /release_push/u)
  assert.equal(releaseDoneDecision({ version: launched, publishRequired: false, changes: pendingPush }).ok, false)
})

const identity = { role: 'gui-release', projectId: 'p1', missionId: 'm1' }
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
}).trim()

function fixture(t) {
  const fixtures = resolve('.tmp')
  const root = mkdtempSync(join(fixtures, 'synkora-release-fixture-'))
  t.after(() => {
    assert.equal(dirname(root), fixtures)
    rmSync(root, { recursive: true, force: true })
  })
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Synthetic Release Test')
  git(cwd, 'config', 'user.email', 'release@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  git(cwd, 'config', 'core.autocrlf', 'false')
  for (const file of ['fix.txt', 'unrelated.txt', 'remove.txt']) writeFileSync(join(cwd, file), 'before\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'test: initial fixture')
  const head = git(cwd, 'rev-parse', 'HEAD')
  const scope = { cwd, branch: 'main', phase: 'after-release', projectId: 'p1', versionId: 'v1', missionId: 'm1' }
  const file = join(root, 'changes.json')
  const store = new ReleaseChangesStore(file)
  const locks = new Set()
  const events = []
  const deps = { store, locks, resolve: () => ({ scope }), probe: releaseChangesProbe,
    prepare: async (...args) => prepareReleaseChange(...args),
    apply: async (...args) => applyReleaseChange(...args),
    push: async (...args) => pushReleaseChanges(...args), changed: () => {},
    audit: (event) => events.push(event) }
  const input = { requestId: 'gate-fix-1', expectedHead: head, files: ['fix.txt'],
    summary: 'Repair release gate', reason: 'Synthetic regression in the gate',
    validation: 'Synthetic focused check passed' }
  return { root, cwd, head, scope, file, store, deps, input, events }
}

test('Git real: salva só os arquivos escolhidos e preserva alterações/índice alheios', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'fixed\n')
  writeFileSync(join(f.cwd, 'unrelated.txt'), 'staged owner work\n')
  git(f.cwd, 'add', 'unrelated.txt')
  writeFileSync(join(f.cwd, 'unrelated.txt'), 'unstaged owner work\n')
  writeFileSync(join(f.cwd, 'owner-new.txt'), 'new owner work\n')
  const api = buildReleaseChanges(f.deps)
  assert.match(await api.save(identity, f.input), /CORREÇÃO SALVA/u)
  assert.equal(git(f.cwd, 'diff', '--name-only', 'HEAD^', 'HEAD'), 'fix.txt')
  assert.equal(git(f.cwd, 'show', ':unrelated.txt'), 'staged owner work')
  assert.equal(readFileSync(join(f.cwd, 'unrelated.txt'), 'utf8'), 'unstaged owner work\n')
  assert.equal(readFileSync(join(f.cwd, 'owner-new.txt'), 'utf8'), 'new owner work\n')
  const record = new ReleaseChangesStore(f.file).list('p1', 'v1')[0]
  assert.equal(record.state, 'saved')
  assert.equal(record.sha, git(f.cwd, 'rev-parse', 'HEAD'))
  assert.equal(record.validation, f.input.validation)
  assert.deepEqual(new ReleaseChangesStore(f.file).list('other', 'v1'), [])
  assert.deepEqual(new ReleaseChangesStore(f.file).list('p1', 'other'), [])
  assert.match(api.inspect(identity).text, /validação informada pelo agente/u)
})

test('uma nova instância repete o pedido sem duplicar commit nem recibo', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'fixed\n')
  await buildReleaseChanges(f.deps).save(identity, f.input)
  const head = git(f.cwd, 'rev-parse', 'HEAD')
  const resumed = buildReleaseChanges({ ...f.deps, store: new ReleaseChangesStore(f.file) })
  assert.match(await resumed.save(identity, f.input), /CORREÇÃO SALVA/u)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head)
  assert.equal(f.store.list('p1', 'v1').length, 1)
  assert.match(await resumed.save(identity, { ...f.input, files: ['unrelated.txt'] }), /outra seleção/u)
})

test('crash depois de mover a branch recupera o recibo sem criar outro commit', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'fixed\n')
  const api = buildReleaseChanges({ ...f.deps, apply: async (target, record) => {
    assert.equal(applyReleaseChange(target, record).state, 'saved')
    throw new Error('simulated process exit before receipt completion')
  } })
  assert.match(await api.save(identity, f.input), /mesmo requestId/u)
  const savedHead = git(f.cwd, 'rev-parse', 'HEAD')
  assert.notEqual(savedHead, f.head)
  assert.equal(f.store.list('p1', 'v1')[0].state, 'prepared')
  const resumed = buildReleaseChanges({ ...f.deps, store: new ReleaseChangesStore(f.file) })
  assert.equal(resumed.inspect(identity).pending, true)
  assert.match(await resumed.save(identity, f.input), /CORREÇÃO SALVA/u)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), savedHead)
  assert.equal(f.store.list('p1', 'v1')[0].state, 'saved')
})

test('sem recibo durável a branch não avança; histórico corrompido não vira vazio', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'fixed\n')
  const failing = buildReleaseChanges({ ...f.deps, store: {
    list: () => [], prepare: () => { throw new Error('disk unavailable') }
  } })
  assert.match(await failing.save(identity, f.input), /não confirmei/u)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.head)
  writeFileSync(f.file, 'invalid synthetic journal')
  assert.throws(() => f.store.list('p1', 'v1'), /histórico/u)
  const unreadable = buildReleaseChanges(f.deps)
  assert.ok(unreadable.inspect(identity).error)
  assert.match(await unreadable.save(identity, f.input), /backup/u)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.head)
})

test('HEAD ou arquivos mudando entre preparação e aplicação não são sobrescritos', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'first fix\n')
  const api = buildReleaseChanges({ ...f.deps, apply: async (target, record) => {
    writeFileSync(join(f.cwd, 'fix.txt'), 'newer owner change\n')
    return applyReleaseChange(target, record)
  } })
  assert.match(await api.save(identity, f.input), /nada aplicado/u)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.head)
  assert.equal(readFileSync(join(f.cwd, 'fix.txt'), 'utf8'), 'newer owner change\n')
  assert.equal(f.store.list('p1', 'v1')[0].state, 'not-applied')
  assert.match(await buildReleaseChanges(f.deps).save(identity, { ...f.input, requestId: 'fresh', expectedHead: 'a'.repeat(40) }), /HEAD mudou/u)
  assert.equal(f.store.list('p1', 'v1').length, 1)
})

test('arquivos novos, exclusões e espaços viajam; diretórios, globs, travessia e credenciais recusam', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'new test.txt'), 'synthetic new file\n')
  rmSync(join(f.cwd, 'remove.txt'))
  const api = buildReleaseChanges(f.deps)
  assert.match(await api.save(identity, { ...f.input, files: ['new test.txt', 'remove.txt'] }), /CORREÇÃO SALVA/u)
  assert.equal(git(f.cwd, 'diff', '--name-status', 'HEAD^', 'HEAD'), 'A\tnew test.txt\nD\tremove.txt')
  for (const bad of ['.', '../outside', '/absolute', 'C:/outside', '*.txt', ':(glob)**', '.git/config',
    '.env', '.env.local', 'credentials.json', 'file.pem', 'dir/../fix.txt', 'a\nb'])
    assert.throws(() => releaseChangeFiles(f.cwd, [bad]), undefined, bad)
  mkdirSync(join(f.cwd, 'folder'))
  assert.throws(() => releaseChangeFiles(f.cwd, ['folder']))
  assert.throws(() => releaseChangeFiles(f.cwd, ['fix.txt', 'fix.txt']))
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'file.txt'), 'synthetic outside file')
  symlinkSync(outside, join(f.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => releaseChangeFiles(f.cwd, ['linked/file.txt']), /links/u)
})

test('antes da subida salva no worktree da versão e orienta subir; principal não muda', async (t) => {
  const f = fixture(t)
  const versionCwd = join(f.root, 'version')
  git(f.cwd, 'worktree', 'add', '-b', 'version/v1', versionCwd)
  const scope = { ...f.scope, cwd: versionCwd, branch: 'version/v1', phase: 'before-release' }
  writeFileSync(join(versionCwd, 'fix.txt'), 'version fix\n')
  const api = buildReleaseChanges({ ...f.deps, resolve: () => ({ scope }) })
  assert.match(await api.save(identity, f.input), /release_run/u)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.head)
  assert.equal(readFileSync(join(f.cwd, 'fix.txt'), 'utf8'), 'before\n')
  assert.match(await api.push(identity, f.head), /a versão ainda não subiu/u)
})

test('branch divergente, operação Git em andamento e escopo recusado não gravam', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'fixed\n')
  git(f.cwd, 'checkout', '-b', 'different')
  assert.equal(prepareReleaseChange(f.scope, f.input).ok, false)
  git(f.cwd, 'checkout', 'main')
  writeFileSync(join(f.cwd, '.git', 'MERGE_HEAD'), f.head)
  assert.equal(prepareReleaseChange(f.scope, f.input).ok, false)
  rmSync(join(f.cwd, '.git', 'MERGE_HEAD'))
  const denied = buildReleaseChanges({ ...f.deps, resolve: () => ({ error: 'release encerrada ou identidade divergente' }) })
  assert.match(await denied.save(identity, f.input), /encerrada/u)
  assert.match(await denied.push(identity, f.head), /encerrada/u)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.head)
  assert.equal(f.store.list('p1', 'v1').length, 0)
})

test('recibo sanitizado, backup legível e trava de concorrência são preservados', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'fixed\n')
  f.deps.locks.add('p1')
  assert.match(await buildReleaseChanges(f.deps).save(identity, f.input), /em andamento/u)
  f.deps.locks.delete('p1')
  const input = { ...f.input, reason: 'Synthetic password=not-a-real-password' }
  await buildReleaseChanges(f.deps).save(identity, input)
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /not-a-real-password/u)
  const savedHead = git(f.cwd, 'rev-parse', 'HEAD')
  assert.equal(new ReleaseChangesStore(f.file).list('p1', 'v1')[0].state, 'saved')
  const backup = readFileSync(`${f.file}.bak`)
  writeFileSync(f.file, 'corrupted synthetic primary')
  const restored = new ReleaseChangesStore(f.file).list('p1', 'v1')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].state, 'prepared')
  assert.equal(restored[0].sha, savedHead)
  assert.equal(readFileSync(f.file, 'utf8'), 'corrupted synthetic primary')
  assert.deepEqual(readFileSync(`${f.file}.bak`), backup)
  assert.match(await buildReleaseChanges(f.deps).save(identity, input), /CORREÇÃO SALVA/u)
  assert.equal(new ReleaseChangesStore(f.file).list('p1', 'v1')[0].state, 'saved')
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), savedHead)
})

test('push explícito usa remoto local, repete falha sem duplicar commit e não atesta instalador', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'fix.txt'), 'fixed\n')
  const api = buildReleaseChanges(f.deps)
  await api.save(identity, f.input)
  const head = git(f.cwd, 'rev-parse', 'HEAD')
  git(f.cwd, 'remote', 'add', 'origin', join(f.root, 'missing.git'))
  assert.equal(api.inspect(identity).pendingPush, true)
  assert.match(await api.push(identity, head), /push não confirmado/u)
  assert.equal(f.store.list('p1', 'v1')[0].pushedAt, undefined)
  const remote = join(f.root, 'remote.git')
  git(f.root, 'init', '--bare', remote)
  git(f.cwd, 'remote', 'set-url', 'origin', remote)
  assert.match(await api.push(identity, head), /não confirma publicação/u)
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), head)
  assert.ok(f.store.list('p1', 'v1')[0].pushedAt)
  assert.equal(api.inspect(identity).pendingPush, false)
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head)
  assert.equal(f.store.list('p1', 'v1').length, 1)
})

test('sem remoto não inventa envio; sujeira ou HEAD divergente recusam push', async (t) => {
  const f = fixture(t)
  const api = buildReleaseChanges(f.deps)
  assert.match(await api.push(identity, f.head), /sem origin/u)
  assert.match(await api.push(identity, 'a'.repeat(40)), /HEAD mudou/u)
  writeFileSync(join(f.cwd, 'fix.txt'), 'unsaved\n')
  assert.match(await api.push(identity, f.head), /release_save/u)
})

test('reiniciar e reler missões não encerra implicitamente uma release com entrega pendente', () => {
  const engine = readFileSync(new URL('../src/main/missionEngine.ts', import.meta.url), 'utf8')
  const read = engine.slice(engine.indexOf('function missionsWithIntegration'))
  assert.doesNotMatch(read.slice(0, read.indexOf('const byMission')), /missions\.update/u)
  const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const recovery = index.slice(index.indexOf('function recoverVersionReleaseIntents'), index.indexOf('async function releaseVersionImpl'))
  assert.doesNotMatch(recovery, /missions\.update\(m\.id, \{ status: 'concluida' \}\)/u)
})

test('reabrir versão já subida reencontra sua release ativa sem recriar branch/conversa', () => {
  const mission = { id: 'm1', projectId: 'p1', versionId: 'v1', missionType: 'release', title: 'release', status: 'ativa' }
  const create = () => { throw new Error('must not create') }
  assert.deepEqual(ensureReleaseMission({ version: launched, missions: [mission], create }),
    { ok: true, missionId: 'm1', created: false })
  assert.equal(ensureReleaseMission({ version: launched, missions: [{ ...mission, status: 'concluida' }], create }).ok, false)
  assert.equal(ensureReleaseMission({ version: launched, missions: [{ ...mission, projectId: 'other' }], create }).ok, false)
})

test('a identidade escopa projeto, missão, versão e branch; release encerrada/antiga não escreve', () => {
  const input = { identity, mission: { id: 'm1', projectId: 'p1', versionId: 'v1', missionType: 'release', status: 'ativa' },
    version: launched, project: { id: 'p1', path: '/project' }, isolationValid: false,
    intentPending: false, latestVersionId: 'v1', mainBranch: 'master' }
  assert.equal(resolveReleaseChangeScope(input).scope.cwd, '/project')
  for (const patch of [
    { identity: { ...identity, role: 'gui-delegator' } },
    { identity: { ...identity, projectId: 'other' } },
    { identity: { ...identity, missionId: 'other' } },
    { mission: { ...input.mission, missionType: 'dev' } },
    { mission: { ...input.mission, status: 'concluida' } },
    { mission: { ...input.mission, status: 'arquivada' } },
    { mission: { ...input.mission, versionId: 'other' } },
    { version: { ...launched, projectId: 'other' } },
    { project: { ...input.project, id: 'other' } },
    { intentPending: true }, { latestVersionId: 'new-version' },
    { mainBranch: 'mission/other' }, { recordedMainBranch: 'main' }
  ]) assert.ok(resolveReleaseChangeScope({ ...input, ...patch }).error, JSON.stringify(patch))
  const before = { ...input, version: { ...launched, status: 'aberta', worktree: '/version', branch: 'version/v1' } }
  assert.ok(resolveReleaseChangeScope(before).error)
  assert.equal(resolveReleaseChangeScope({ ...before, isolationValid: true }).scope.cwd, '/version')
})

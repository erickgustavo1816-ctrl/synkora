import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  alignWorktreeFromSnapshot,
  createMissionWorktree,
  createVersionWorktree,
  ensureSynkoraGitExcludes,
  initGitRepo,
  isExactCleanPreCasSnapshot,
  isExpectedWorktree,
  isExpectedVersionWorktree,
  mergeTaskWorktree,
  missionCommitPatch,
  missionCommits,
  missionWorkspaceFileDiff,
  missionWorkspaceReadout,
  removeWorktreeAndBranch,
  resolveMissionWorkspace,
  resolveWorkspaceFilePath,
  syncVersionBaseWithMain
} from '../.tmp/mission-worktree-test/worktree.js'

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

function initializeRepository(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Synkora Test'])
  git(root, ['config', 'user.email', 'synkora-test@example.invalid'])
  writeFileSync(join(root, 'base.txt'), 'base\n', 'utf8')
  git(root, ['add', 'base.txt'])
  git(root, ['commit', '-m', 'base'])
  return root
}

function initializeWorktreesDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('Windows: mission and version checkout support long paths without changing Git config', {
  skip: process.platform !== 'win32'
}, (t) => {
  const root = initializeRepository(t, 'synkora-long-source-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-long-target-')
  git(root, ['config', 'core.longpaths', 'false'])
  git(root, ['config', 'core.autocrlf', 'false'])
  const relativeFile = join('assets', 'nested-'.repeat(8), 'content-'.repeat(7), 'fixture.txt')
  mkdirSync(join(root, 'assets', 'nested-'.repeat(8), 'content-'.repeat(7)), { recursive: true })
  writeFileSync(join(root, relativeFile), 'synthetic long path\n')
  git(root, ['add', '--', relativeFile])
  git(root, ['commit', '-m', 'test: long path fixture'])
  const base = join(worktrees, 'workspace-'.repeat(7))
  const versionId = '12345678-1234-1234-1234-123456789abc'
  assert.ok(join(base, `version-${versionId}`, relativeFile).length > 260)
  // Match the interrupted first attempt: Git leaves the new branch behind
  // after checkout fails, but no registered worktree exists to resume.
  mkdirSync(base, { recursive: true })
  assert.throws(() => execFileSync('git', ['-c', 'core.longpaths=false', 'worktree', 'add',
    '-b', `version/${versionId}`, join(base, `version-${versionId}`)], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }), /Filename too long/)
  const preservedHead = git(root, ['rev-parse', `refs/heads/version/${versionId}`])
  const version = createVersionWorktree(root, base, 'V0.0.1', versionId)
  assert.ok(version, 'the first version must survive Windows long checkout paths')
  const mission = createMissionWorktree(root, base, 'longpath-mission', version.branch)
  assert.ok(mission, 'the first mission must be isolated too')
  assert.equal(readFileSync(join(version.dir, relativeFile), 'utf8'), 'synthetic long path\n')
  assert.equal(readFileSync(join(mission.dir, relativeFile), 'utf8'), 'synthetic long path\n')
  assert.equal(isExpectedWorktree(root, mission.dir, mission.branch), true)
  assert.equal(git(root, ['rev-parse', `refs/heads/version/${versionId}`]), preservedHead)
  assert.equal(git(root, ['config', '--local', '--get', 'core.longpaths']), 'false')
})

test('missões e versões recebem env local sem versionar nem sobrescrever configurações', (t) => {
  const root = initializeRepository(t, 'synkora-env-source-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-env-wt-')
  const fixtures = {
    '.env': 'SYNTHETIC_MODE=development\r\n', '.env.local': 'SYNTHETIC_PORT=4200\r\n',
    '.env.production': 'SYNTHETIC_MODE=production\n', '.env.development.local': 'SYNTHETIC_MODE=local\n',
    '.env.example': 'SYNTHETIC_MODE=example\n', '.environment': 'SYNTHETIC_PREFIX=true\n'
  }
  for (const [name, bytes] of Object.entries(fixtures)) writeFileSync(join(root, name), bytes)
  writeFileSync(join(root, 'not-env.txt'), 'synthetic unrelated file\n')
  const version = createVersionWorktree(root, worktrees, 'env-version')
  assert.ok(version)
  const mission = createMissionWorktree(root, worktrees, 'env-mission', version.branch)
  assert.ok(mission)
  for (const workspace of [version, mission]) {
    for (const [name, bytes] of Object.entries(fixtures)) {
      assert.equal(existsSync(join(workspace.dir, name)), true, `${name} deve acompanhar o worktree`)
      assert.equal(readFileSync(join(workspace.dir, name), 'utf8'), bytes)
      assert.equal(lstatSync(join(workspace.dir, name)).isSymbolicLink(), false)
    }
    assert.equal(existsSync(join(workspace.dir, 'not-env.txt')), false)
    git(workspace.dir, ['add', '-A'])
    assert.equal(git(workspace.dir, ['status', '--porcelain']), '')
  }
  writeFileSync(join(mission.dir, '.env'), 'SYNTHETIC_MODE=mission-only\n')
  unlinkSync(join(mission.dir, '.env.local'))
  assert.ok(createMissionWorktree(root, worktrees, 'env-mission', version.branch))
  assert.equal(readFileSync(join(mission.dir, '.env'), 'utf8'), 'SYNTHETIC_MODE=mission-only\n')
  assert.equal(readFileSync(join(mission.dir, '.env.local'), 'utf8'), fixtures['.env.local'])
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), fixtures['.env'])
})

test('importar projeto sem Git mantém todos os env fora do commit inicial', (t) => {
  const root = initializeWorktreesDirectory(t, 'synkora-env-init-')
  writeFileSync(join(root, 'base.txt'), 'synthetic project\n')
  writeFileSync(join(root, '.env'), 'SYNTHETIC_MODE=development\n')
  writeFileSync(join(root, '.env.local'), 'SYNTHETIC_PORT=4200\n')
  writeFileSync(join(root, '.env.production'), 'SYNTHETIC_MODE=production\n')
  writeFileSync(join(root, '.environment'), 'SYNTHETIC_PREFIX=true\n')
  assert.equal(initGitRepo(root), true)
  assert.equal(git(root, ['ls-files', '--', '.env*']), '')
  assert.equal(existsSync(join(root, '.env')), true)
  assert.equal(existsSync(join(root, '.env.local')), true)
})

test('env exige exclusão no Git e ignora diretórios com o mesmo prefixo', (t) => {
  const root = initializeRepository(t, 'synkora-env-refusal-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-env-refusal-wt-')
  writeFileSync(join(root, '.gitignore'), '!.env\n')
  git(root, ['add', '.gitignore'])
  git(root, ['commit', '-m', 'synthetic ignore override'])
  writeFileSync(join(root, '.env'), 'SYNTHETIC_MODE=test\n')
  assert.equal(createMissionWorktree(root, worktrees, 'env-refused'), null)
  assert.equal(existsSync(join(worktrees, 'mission-env-refu', '.env')), false)
  unlinkSync(join(root, '.env'))
  mkdirSync(join(root, '.env'))
  assert.ok(createMissionWorktree(root, worktrees, 'env-folder'))
  assert.equal(existsSync(join(worktrees, 'mission-env-fold', '.env')), false)
})

test('env rastreado e removido no worktree não é restaurado pela preparação', (t) => {
  const root = initializeRepository(t, 'synkora-env-tracked-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-env-tracked-wt-')
  writeFileSync(join(root, '.env'), 'SYNTHETIC_TRACKED=true\n')
  git(root, ['add', '.env'])
  git(root, ['commit', '-m', 'synthetic tracked environment'])
  const mission = createMissionWorktree(root, worktrees, 'env-tracked')
  assert.ok(mission)
  unlinkSync(join(mission.dir, '.env'))
  assert.ok(createMissionWorktree(root, worktrees, 'env-tracked'))
  assert.equal(existsSync(join(mission.dir, '.env')), false)
})

test('prova que o isolamento é a raiz exata do mesmo repo e da branch esperada', (t) => {
  const root = initializeRepository(t, 'synkora-isolation-proof-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-isolation-proof-wt-')
  const mission = createMissionWorktree(root, worktrees, 'isolation-proof-mission')
  assert.ok(mission)
  assert.equal(isExpectedWorktree(root, mission.dir, mission.branch), true)
  assert.equal(isExpectedWorktree(root, mission.dir, 'mission/outra'), false)

  const baseBranch = git(root, ['branch', '--show-current'])
  assert.equal(isExpectedWorktree(root, root, baseBranch), false)

  const nested = join(mission.dir, 'nested')
  mkdirSync(nested)
  assert.equal(isExpectedWorktree(root, nested, mission.branch), false)

  const foreign = initializeRepository(t, 'synkora-isolation-foreign-')
  git(foreign, ['checkout', '-b', mission.branch])
  assert.equal(isExpectedWorktree(root, foreign, mission.branch), false)

  rmSync(mission.dir, { recursive: true, force: true })
  assert.equal(isExpectedWorktree(root, mission.dir, mission.branch), false)
})

test('repo Git existente ignora runtime .synkora sem tocar no .gitignore', (t) => {
  const root = initializeRepository(t, 'synkora-existing-repo-exclude-')
  assert.equal(existsSync(join(root, '.gitignore')), false)
  ensureSynkoraGitExcludes(root)
  mkdirSync(join(root, '.synkora'))
  writeFileSync(join(root, '.synkora', 'BOARD.md'), 'runtime\n', 'utf8')

  assert.equal(git(root, ['status', '--porcelain']), '')
  assert.equal(existsSync(join(root, '.gitignore')), false)
  assert.match(
    readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'),
    /^\.synkora\/$/m
  )
})

test('runtime recusa sobrescrever uma pasta .synkora já versionada', (t) => {
  const root = initializeRepository(t, 'synkora-tracked-runtime-')
  mkdirSync(join(root, '.synkora'))
  const board = join(root, '.synkora', 'BOARD.md')
  writeFileSync(board, 'conteúdo versionado do usuário\n', 'utf8')
  git(root, ['add', '.synkora/BOARD.md'])
  git(root, ['commit', '-m', 'track existing synkora metadata'])

  assert.throws(
    () => ensureSynkoraGitExcludes(root),
    /\.synkora já contém arquivos versionados/
  )
  assert.equal(readFileSync(board, 'utf8'), 'conteúdo versionado do usuário\n')
  assert.equal(git(root, ['status', '--porcelain']), '')
})

test('não reutiliza uma pasta stale como worktree de missão', (t) => {
  const root = initializeRepository(t, 'synkora-stale-isolation-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-stale-isolation-wt-')
  const stale = join(worktrees, 'mission-stale-di')
  mkdirSync(stale)
  writeFileSync(join(stale, 'preservar.txt'), 'não sobrescrever\n', 'utf8')

  assert.equal(createMissionWorktree(root, worktrees, 'stale-directory'), null)
  assert.equal(readFileSync(join(stale, 'preservar.txt'), 'utf8'), 'não sobrescrever\n')
})

test('resolver de missão nunca transforma Git incompleto em execução direta', (t) => {
  const plain = initializeWorktreesDirectory(t, 'synkora-plain-workspace-')
  assert.equal(resolveMissionWorkspace(plain, 'plain-mission'), plain)
  assert.equal(
    resolveMissionWorkspace(
      plain,
      'plain-mission',
      'mission/plain-mi',
      join(plain, 'worktree-perdido')
    ),
    undefined
  )

  const broken = initializeWorktreesDirectory(t, 'synkora-broken-git-')
  mkdirSync(join(broken, '.git'))
  assert.equal(resolveMissionWorkspace(broken, 'broken-mission'), undefined)

  const root = initializeRepository(t, 'synkora-resolve-mission-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-resolve-mission-wt-')
  const missionId = 'resolve-mission-id'
  const mission = createMissionWorktree(root, worktrees, missionId)
  assert.ok(mission)
  assert.equal(resolveMissionWorkspace(root, missionId), undefined)
  assert.equal(resolveMissionWorkspace(root, missionId, mission.branch), undefined)
  assert.equal(
    resolveMissionWorkspace(root, missionId, mission.branch, mission.dir),
    mission.dir
  )
  assert.equal(
    resolveMissionWorkspace(root, missionId, 'mission/errada', mission.dir),
    undefined
  )
})

test('leitura agrupada do paneSpec: healthy so com isolamento exato; divergencia cai no caminho lento', (t) => {
  const root = initializeRepository(t, 'synkora-readout-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-readout-wt-')
  const missionId = 'readout-mission-1'
  const mission = createMissionWorktree(root, worktrees, missionId)
  assert.ok(mission)

  const healthy = missionWorkspaceReadout(root, missionId, mission.branch, mission.dir)
  assert.equal(healthy.healthy, true)
  assert.equal(healthy.workspace, mission.dir)
  assert.equal(healthy.excludesError, undefined)

  // divergências viram healthy:false SEM erro (o chamador promove/repara)
  assert.equal(missionWorkspaceReadout(root, missionId).healthy, false)
  assert.equal(
    missionWorkspaceReadout(root, missionId, 'mission/errada', mission.dir).healthy,
    false
  )
  assert.equal(
    missionWorkspaceReadout(root, 'outra-missao-id', mission.branch, mission.dir).healthy,
    false
  )

  // pasta sem commit git: fast path recusa (o caminho lento decide git init)
  const plain = initializeWorktreesDirectory(t, 'synkora-readout-plain-')
  assert.equal(missionWorkspaceReadout(plain, missionId).healthy, false)
})

test('leitura agrupada carrega o erro legivel de .synkora versionado', (t) => {
  const root = initializeRepository(t, 'synkora-readout-tracked-')
  mkdirSync(join(root, '.synkora'))
  writeFileSync(join(root, '.synkora', 'BOARD.md'), 'versionado\n', 'utf8')
  git(root, ['add', '.synkora/BOARD.md'])
  git(root, ['commit', '-m', 'track synkora'])

  const readout = missionWorkspaceReadout(root, 'qualquer-missao')
  assert.equal(readout.healthy, false)
  assert.match(readout.excludesError ?? '', /\.synkora já contém arquivos versionados/)
})

test('cerca de caminho do diff por arquivo: so o que MORA no worktree passa', () => {
  const root = resolve('wt-raiz-do-teste')

  // aceitos: relativos, normalizados e sempre devolvidos em barras normais
  assert.equal(resolveWorkspaceFilePath(root, 'src/main/x.ts'), 'src/main/x.ts')
  assert.equal(resolveWorkspaceFilePath(root, './src/x.ts'), 'src/x.ts')
  assert.equal(resolveWorkspaceFilePath(root, 'a/b/../c.ts'), 'a/c.ts')
  assert.equal(resolveWorkspaceFilePath(root, '  src/x.ts  '), 'src/x.ts')

  // travessia em todas as formas
  assert.equal(resolveWorkspaceFilePath(root, '..'), undefined)
  assert.equal(resolveWorkspaceFilePath(root, '../fora.txt'), undefined)
  assert.equal(resolveWorkspaceFilePath(root, 'src/../../fora.txt'), undefined)
  // irmão com o MESMO PREFIXO: a checagem é por caminho, nunca por startsWith
  assert.equal(resolveWorkspaceFilePath(root, '../wt-raiz-do-teste-extra/x.ts'), undefined)

  // absoluto nunca vem do trilho — e é a metade fácil de um escape
  assert.equal(resolveWorkspaceFilePath(root, resolve(root, '..', 'fora.txt')), undefined)
  assert.equal(resolveWorkspaceFilePath(root, resolve(root, 'dentro.txt')), undefined)
  assert.equal(resolveWorkspaceFilePath(root, 'C:relativo-ao-drive.txt'), undefined)
  assert.equal(resolveWorkspaceFilePath(root, '//servidor/share/x.txt'), undefined)

  // degenerados: o worktree em si não é arquivo, e NUL nem chega ao processo
  assert.equal(resolveWorkspaceFilePath(root, ''), undefined)
  assert.equal(resolveWorkspaceFilePath(root, '   '), undefined)
  assert.equal(resolveWorkspaceFilePath(root, '.'), undefined)
  assert.equal(resolveWorkspaceFilePath(root, 'a\u0000b'), undefined)
})

test('diff por arquivo: committed + nao committado, arquivo solto inteiro e teto', (t) => {
  const root = initializeRepository(t, 'synkora-file-diff-')
  const baseBranch = git(root, ['branch', '--show-current'])
  writeFileSync(join(root, 'estavel.txt'), 'ja estava aqui\n', 'utf8')
  git(root, ['add', 'estavel.txt'])
  git(root, ['commit', '-m', 'arquivo que a missao nao toca'])
  git(root, ['checkout', '-q', '-b', 'mission/file-diff'])

  writeFileSync(join(root, 'committed.txt'), 'alfa\nbeta\n', 'utf8')
  git(root, ['add', 'committed.txt'])
  git(root, ['commit', '-m', 'entrega committada'])
  // mudança AINDA NÃO committada: o trilho é vivo, não foto do último commit
  writeFileSync(join(root, 'base.txt'), 'base\nlinha nova sem commit\n', 'utf8')
  writeFileSync(join(root, 'solto.txt'), 'nasceu fora do git\n', 'utf8')

  const committed = missionWorkspaceFileDiff(root, 'committed.txt', baseBranch)
  assert.equal(committed.ok, true)
  assert.match(committed.diff ?? '', /\+alfa/)
  assert.equal(committed.truncated, undefined)

  const working = missionWorkspaceFileDiff(root, 'base.txt', baseBranch)
  assert.equal(working.ok, true)
  assert.match(working.diff ?? '', /\+linha nova sem commit/)

  // arquivo que o git ainda não conhece volta INTEIRO como adição
  const untracked = missionWorkspaceFileDiff(root, 'solto.txt', baseBranch)
  assert.equal(untracked.ok, true)
  assert.match(untracked.diff ?? '', /--- \/dev\/null/)
  assert.match(untracked.diff ?? '', /\+nasceu fora do git/)

  // nada mudou / não existe = diff vazio com ok:true (resposta, não erro)
  const quieto = missionWorkspaceFileDiff(root, 'inexistente.txt', baseBranch)
  assert.equal(quieto.ok, true)
  assert.equal(quieto.diff, '')

  // rastreado E intocado NUNCA pode cair no diff-de-adição: o dono leria como
  // "a missão criou este arquivo inteiro", que é mentira
  const estavel = missionWorkspaceFileDiff(root, 'estavel.txt', baseBranch)
  assert.equal(estavel.ok, true)
  assert.equal(estavel.diff, '')

  // a cerca de caminho vale no caminho real, antes de qualquer git nascer
  const escapou = missionWorkspaceFileDiff(root, '../fora.txt', baseBranch)
  assert.equal(escapou.ok, false)
  assert.match(escapou.error ?? '', /fora do worktree/)

  const semWorktree = missionWorkspaceFileDiff(join(root, 'nao-existe'), 'x.txt', baseBranch)
  assert.equal(semWorktree.ok, false)

  // teto: corta em linha inteira e ASSUME o corte
  writeFileSync(
    join(root, 'gigante.txt'),
    Array.from({ length: 40_000 }, (_, i) => `linha ${i}`).join('\n') + '\n',
    'utf8'
  )
  const grande = missionWorkspaceFileDiff(root, 'gigante.txt', baseBranch)
  assert.equal(grande.ok, true)
  assert.equal(grande.truncated, true)
  assert.ok((grande.diff ?? '').length <= 200_000)
  assert.ok((grande.diff ?? '').endsWith('\n'))
})

test('missão seguinte nasce da branch da versão e herda entregas anteriores', (t) => {
  const root = initializeRepository(t, 'synkora-version-mission-')

  const worktrees = join(root, '.test-worktrees')
  const version = createVersionWorktree(root, worktrees, 'V1')
  assert.ok(version)
  writeFileSync(join(version.dir, 'entrega-m1.txt'), 'entrega da M1\n', 'utf8')
  git(version.dir, ['add', 'entrega-m1.txt'])
  git(version.dir, ['commit', '-m', 'mission: M1'])

  const mission = createMissionWorktree(
    root,
    worktrees,
    '12345678-missao-2',
    version.branch
  )
  assert.ok(mission)
  assert.equal(
    readFileSync(join(mission.dir, 'entrega-m1.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'entrega da M1\n'
  )

  const versionHead = git(version.dir, ['rev-parse', 'HEAD'])
  const missionHead = git(mission.dir, ['rev-parse', 'HEAD'])
  assert.equal(missionHead, versionHead)
  assert.doesNotThrow(() =>
    git(root, ['merge-base', '--is-ancestor', versionHead, missionHead])
  )
})

test('merge final recusa origem suja sem criar commit automático', (t) => {
  const root = initializeRepository(t, 'synkora-dirty-source-')
  const mission = createMissionWorktree(
    root,
    join(root, '.test-worktrees'),
    'dirty-source-mission'
  )
  assert.ok(mission)

  const sourceHeadBefore = git(mission.dir, ['rev-parse', 'HEAD'])
  const targetHeadBefore = git(root, ['rev-parse', 'HEAD'])
  writeFileSync(join(mission.dir, 'dirty.txt'), 'mudança ainda não validada\n', 'utf8')

  const result = mergeTaskWorktree(
    root,
    mission,
    'missão com origem suja',
    undefined,
    { requireCleanSource: true }
  )

  assert.equal(result.ok, false)
  assert.match(result.detail, /arquivos não commitados|origem mudou/i)
  assert.equal(git(mission.dir, ['rev-parse', 'HEAD']), sourceHeadBefore)
  assert.equal(git(root, ['rev-parse', 'HEAD']), targetHeadBefore)
  assert.match(git(mission.dir, ['status', '--porcelain']), /\?\? dirty\.txt/)
})

test('merge final recusa SHA diferente da fotografia validada', (t) => {
  const root = initializeRepository(t, 'synkora-expected-source-')
  const mission = createMissionWorktree(
    root,
    join(root, '.test-worktrees'),
    'expected-source-mission'
  )
  assert.ok(mission)

  writeFileSync(join(mission.dir, 'validated.txt'), 'fotografia validada\n', 'utf8')
  git(mission.dir, ['add', 'validated.txt'])
  git(mission.dir, ['commit', '-m', 'validated source'])
  const expectedSourceHead = git(mission.dir, ['rev-parse', 'HEAD'])

  writeFileSync(join(mission.dir, 'later.txt'), 'commit posterior aos gates\n', 'utf8')
  git(mission.dir, ['add', 'later.txt'])
  git(mission.dir, ['commit', '-m', 'unexpected later source'])
  const actualSourceHead = git(mission.dir, ['rev-parse', 'HEAD'])
  const targetHeadBefore = git(root, ['rev-parse', 'HEAD'])
  assert.notEqual(actualSourceHead, expectedSourceHead)

  const result = mergeTaskWorktree(
    root,
    mission,
    'missão com SHA divergente',
    undefined,
    { requireCleanSource: true, expectedSourceHead }
  )

  assert.equal(result.ok, false)
  assert.match(result.detail, /branch de origem avançou|nada foi integrado/i)
  assert.equal(git(root, ['rev-parse', 'HEAD']), targetHeadBefore)
  assert.equal(git(mission.dir, ['rev-parse', 'HEAD']), actualSourceHead)
  assert.throws(() =>
    git(root, ['merge-base', '--is-ancestor', expectedSourceHead, targetHeadBefore])
  )
})

test('merge final recusa destino com HEAD ou branch diferente da fotografia', (t) => {
  const headRoot = initializeRepository(t, 'synkora-expected-target-head-')
  const headWorktrees = initializeWorktreesDirectory(
    t,
    'synkora-expected-target-head-worktrees-'
  )
  const headMission = createMissionWorktree(
    headRoot,
    headWorktrees,
    'expected-target-head-mission'
  )
  assert.ok(headMission)
  writeFileSync(join(headMission.dir, 'mission.txt'), 'entrega da missão\n', 'utf8')
  git(headMission.dir, ['add', 'mission.txt'])
  git(headMission.dir, ['commit', '-m', 'mission source'])
  const expectedSourceHead = git(headMission.dir, ['rev-parse', 'HEAD'])
  const staleTargetHead = git(headRoot, ['rev-parse', 'HEAD'])
  const expectedTargetBranch = git(headRoot, ['branch', '--show-current'])

  writeFileSync(join(headRoot, 'target-later.txt'), 'destino avançou\n', 'utf8')
  git(headRoot, ['add', 'target-later.txt'])
  git(headRoot, ['commit', '-m', 'target advanced'])
  const actualTargetHead = git(headRoot, ['rev-parse', 'HEAD'])

  const headResult = mergeTaskWorktree(
    headRoot,
    headMission,
    'destino com HEAD divergente',
    undefined,
    {
      requireCleanSource: true,
      expectedSourceHead,
      expectedTargetHead: staleTargetHead,
      expectedTargetBranch
    }
  )

  assert.equal(headResult.ok, false)
  assert.match(headResult.detail, /destino avançou|nada foi integrado/i)
  assert.equal(git(headRoot, ['rev-parse', 'HEAD']), actualTargetHead)
  assert.equal(git(headRoot, ['branch', '--show-current']), expectedTargetBranch)
  assert.equal(git(headMission.dir, ['rev-parse', 'HEAD']), expectedSourceHead)

  const branchRoot = initializeRepository(t, 'synkora-expected-target-branch-')
  const branchWorktrees = initializeWorktreesDirectory(
    t,
    'synkora-expected-target-branch-worktrees-'
  )
  const branchMission = createMissionWorktree(
    branchRoot,
    branchWorktrees,
    'expected-target-branch-mission'
  )
  assert.ok(branchMission)
  writeFileSync(join(branchMission.dir, 'mission.txt'), 'entrega da missão\n', 'utf8')
  git(branchMission.dir, ['add', 'mission.txt'])
  git(branchMission.dir, ['commit', '-m', 'mission source'])
  const branchSourceHead = git(branchMission.dir, ['rev-parse', 'HEAD'])
  const branchTargetHead = git(branchRoot, ['rev-parse', 'HEAD'])
  const actualTargetBranch = git(branchRoot, ['branch', '--show-current'])
  const wrongTargetBranch = `${actualTargetBranch}-stale`

  const branchResult = mergeTaskWorktree(
    branchRoot,
    branchMission,
    'destino com branch divergente',
    undefined,
    {
      requireCleanSource: true,
      expectedSourceHead: branchSourceHead,
      expectedTargetHead: branchTargetHead,
      expectedTargetBranch: wrongTargetBranch
    }
  )

  assert.equal(branchResult.ok, false)
  assert.match(branchResult.detail, /branch de destino mudou|nada foi integrado/i)
  assert.equal(git(branchRoot, ['rev-parse', 'HEAD']), branchTargetHead)
  assert.equal(git(branchRoot, ['branch', '--show-current']), actualTargetBranch)
  assert.equal(git(branchMission.dir, ['rev-parse', 'HEAD']), branchSourceHead)
})

test('merge com fotografia exata usa os SHAs validados como pais', (t) => {
  const root = initializeRepository(t, 'synkora-exact-snapshot-')
  const worktrees = initializeWorktreesDirectory(
    t,
    'synkora-exact-snapshot-worktrees-'
  )
  const expectedTargetHead = git(root, ['rev-parse', 'HEAD'])
  const expectedTargetBranch = git(root, ['branch', '--show-current'])
  const mission = createMissionWorktree(
    root,
    worktrees,
    'exact-snapshot-mission'
  )
  assert.ok(mission)

  writeFileSync(join(mission.dir, 'delivered.txt'), 'conteúdo validado\n', 'utf8')
  git(mission.dir, ['add', 'delivered.txt'])
  git(mission.dir, ['commit', '-m', 'validated mission source'])
  const expectedSourceHead = git(mission.dir, ['rev-parse', 'HEAD'])

  const result = mergeTaskWorktree(
    root,
    mission,
    'fotografia exata',
    undefined,
    {
      requireCleanSource: true,
      expectedSourceHead,
      expectedTargetHead,
      expectedTargetBranch
    }
  )

  assert.equal(result.ok, true)
  const mergeHead = git(root, ['rev-parse', 'HEAD'])
  const parents = git(root, ['show', '-s', '--format=%P', mergeHead]).split(/\s+/)
  assert.deepEqual(parents, [expectedTargetHead, expectedSourceHead])
  assert.equal(git(root, ['branch', '--show-current']), expectedTargetBranch)
  assert.equal(
    readFileSync(join(root, 'delivered.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'conteúdo validado\n'
  )
})

test('recovery alinha arquivos somente quando ainda correspondem à fotografia anterior', (t) => {
  const root = initializeRepository(t, 'synkora-align-snapshot-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-align-snapshot-wt-')
  const previousHead = git(root, ['rev-parse', 'HEAD'])
  const branch = git(root, ['branch', '--show-current'])
  const mission = createMissionWorktree(root, worktrees, 'align-snapshot-mission')
  assert.ok(mission)

  writeFileSync(join(mission.dir, 'recovered.txt'), 'recuperado\n', 'utf8')
  git(mission.dir, ['add', 'recovered.txt'])
  git(mission.dir, ['commit', '-m', 'source to recover'])
  const sourceHead = git(mission.dir, ['rev-parse', 'HEAD'])
  const tree = git(root, ['merge-tree', '--write-tree', previousHead, sourceHead])
    .split(/\r?\n/)[0]
    .trim()
  const mergeCommit = git(root, [
    'commit-tree',
    tree,
    '-p',
    previousHead,
    '-p',
    sourceHead,
    '-m',
    'simulated interrupted exact merge'
  ])
  git(root, ['update-ref', `refs/heads/${branch}`, mergeCommit, previousHead])

  assert.equal(alignWorktreeFromSnapshot(root, previousHead), true)
  assert.equal(git(root, ['status', '--porcelain']), '')
  assert.equal(readFileSync(join(root, 'recovered.txt'), 'utf8').replace(/\r\n/g, '\n'), 'recuperado\n')
  assert.equal(git(root, ['rev-parse', 'HEAD']), mergeCommit)
})

test('new versions use immutable identity when sanitized names collide', (t) => {
  const root = initializeRepository(t, 'synkora-version-identity-')
  const worktrees = join(root, '.test-worktrees')

  const first = createVersionWorktree(root, worktrees, 'V/1', 'version-id-a')
  const second = createVersionWorktree(root, worktrees, 'V:1', 'version-id-b')

  assert.ok(first)
  assert.ok(second)
  assert.notEqual(first.branch, second.branch)
  assert.notEqual(first.dir, second.dir)
  assert.equal(isExpectedWorktree(root, first.dir, first.branch), true)
  assert.equal(isExpectedWorktree(root, second.dir, second.branch), true)
})

test('release target proof accepts only a canonical version/* worktree', (t) => {
  const root = initializeRepository(t, 'synkora-version-proof-')
  const version = createVersionWorktree(
    root,
    join(root, '.test-worktrees'),
    'V1',
    'version-proof-id'
  )
  assert.ok(version)
  assert.equal(
    isExpectedVersionWorktree(root, version.dir, version.branch),
    true
  )
  assert.equal(
    isExpectedVersionWorktree(root, version.dir, 'mission/version-proof-id'),
    false
  )
})

test('version cleanup preserves the worktree unless head and cleanliness are exact', (t) => {
  const root = initializeRepository(t, 'synkora-version-cleanup-')
  const version = createVersionWorktree(
    root,
    join(root, '.test-worktrees'),
    'V1',
    'version-cleanup-id'
  )
  assert.ok(version)
  const head = git(version.dir, ['rev-parse', 'HEAD'])

  assert.equal(
    removeWorktreeAndBranch(root, version.dir, version.branch, '0'.repeat(head.length)),
    false
  )
  assert.equal(existsSync(version.dir), true)

  const late = join(version.dir, 'late.txt')
  writeFileSync(late, 'late\n', 'utf8')
  assert.equal(removeWorktreeAndBranch(root, version.dir, version.branch, head), false)
  assert.equal(existsSync(version.dir), true)
  rmSync(late)

  assert.equal(removeWorktreeAndBranch(root, version.dir, version.branch, head), true)
  assert.equal(existsSync(version.dir), false)

  const interrupted = createVersionWorktree(
    root,
    join(root, '.test-worktrees'),
    'V2',
    'version-interrupted-cleanup-id'
  )
  assert.ok(interrupted)
  const interruptedHead = git(interrupted.dir, ['rev-parse', 'HEAD'])
  git(root, ['worktree', 'remove', interrupted.dir])
  assert.equal(existsSync(interrupted.dir), false)
  assert.equal(
    removeWorktreeAndBranch(
      root,
      interrupted.dir,
      interrupted.branch,
      interruptedHead
    ),
    true
  )
})

// ————— CARCAÇA DE REMOÇÃO INTERROMPIDA (incidente 2026-08-24) —————

function leaveDanglingWorktreePointer(root, mission) {
  const pointer = readFileSync(join(mission.dir, '.git'))
  unlinkSync(join(mission.dir, '.git'))
  git(root, ['worktree', 'prune', '--expire', 'now'])
  writeFileSync(join(mission.dir, '.git'), pointer)
}

test('carcaça com .git apontando para registro removido é preservada em quarentena', (t) => {
  const root = initializeRepository(t, 'synkora-dangling-source-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-dangling-wt-')
  const mission = createMissionWorktree(root, worktrees, 'dangling-pointer')
  const head = git(mission.dir, ['rev-parse', 'HEAD'])
  leaveDanglingWorktreePointer(root, mission)
  writeFileSync(join(mission.dir, 'local-only.txt'), 'synthetic local data')
  assert.equal(removeWorktreeAndBranch(root, mission.dir, mission.branch, head), true)
  assert.equal(existsSync(mission.dir), false)
  assert.equal(readFileSync(join(`${mission.dir}-carcass-bak`, 'local-only.txt'), 'utf8'), 'synthetic local data')
  assert.equal(existsSync(join(`${mission.dir}-carcass-bak`, '.git')), true)
  assert.equal(removeWorktreeAndBranch(root, mission.dir, mission.branch, head), true, 'recovery is idempotent')
})

test('ponteiro .git inválido, de outro repo ou com conteúdo divergente não autoriza quarentena', (t) => {
  const root = initializeRepository(t, 'synkora-dangling-refusal-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-dangling-refusal-wt-')
  for (const [index, mode] of ['malformed', 'foreign', 'modified', 'branch-moved', 'registration-present'].entries()) {
    const mission = createMissionWorktree(root, worktrees, `${index}-blocked-${mode}`)
    assert.ok(mission)
    const head = git(mission.dir, ['rev-parse', 'HEAD'])
    if (mode !== 'registration-present') leaveDanglingWorktreePointer(root, mission)
    if (mode === 'malformed') writeFileSync(join(mission.dir, '.git'), 'not a git pointer')
    if (mode === 'foreign') writeFileSync(join(mission.dir, '.git'), `gitdir: ${join(worktrees, 'foreign', '.git', 'worktrees', 'missing')}\n`)
    if (mode === 'modified') writeFileSync(join(mission.dir, 'base.txt'), 'changed\n')
    if (mode === 'branch-moved') {
      git(root, ['commit', '--allow-empty', '-m', 'synthetic later commit'])
      git(root, ['update-ref', `refs/heads/${mission.branch}`, 'HEAD'])
    }
    if (mode === 'registration-present') {
      const pointer = readFileSync(join(mission.dir, '.git'), 'utf8').replace(/worktrees[\\/][^\r\n]+/u, 'worktrees')
      unlinkSync(join(mission.dir, '.git'))
      writeFileSync(join(mission.dir, '.git'), pointer)
    }
    assert.equal(removeWorktreeAndBranch(root, mission.dir, mission.branch, head), false, mode)
    assert.equal(existsSync(mission.dir), true, mode)
    assert.equal(existsSync(`${mission.dir}-carcass-bak`), false, mode)
  }
})
//
// O `git worktree remove` pós-merge morreu no MEIO: levou o `.git` da pasta e
// parte dos arquivos, o prune apagou o registro — e a pasta que sobrou nunca
// mais prova identidade nenhuma. Sem rota, o reparo de boot repete
// `target_repair_pending` para SEMPRE (beco sem saída). A cura: conteúdo
// provado por BYTES contra o SHA aprovado vai para quarentena ao lado (rename,
// jamais deleção) e o CAS da branch conclui a limpeza.

test('carcaça sem .git com conteúdo provado vai para quarentena e o CAS conclui', (t) => {
  const root = initializeRepository(t, 'synkora-carcass-proven-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-carcass-proven-wt-')
  const mission = createMissionWorktree(root, worktrees, 'carcass-proven-mission')
  assert.ok(mission)
  writeFileSync(join(mission.dir, 'delivered.txt'), 'entrega\n', 'utf8')
  git(mission.dir, ['add', 'delivered.txt'])
  git(mission.dir, ['commit', '-m', 'entrega'])
  const head = git(mission.dir, ['rev-parse', 'HEAD'])
  git(root, ['merge', '--no-ff', mission.branch, '-m', 'merge mission'])

  // o crash: identidade e registro se vão, a deleção fica pela metade e uma
  // sobra sem cópia no git (build) permanece na pasta
  unlinkSync(join(mission.dir, '.git'))
  git(root, ['worktree', 'prune'])
  unlinkSync(join(mission.dir, 'base.txt'))
  writeFileSync(join(mission.dir, 'build-output.tmp'), 'sobra de build\n', 'utf8')

  assert.equal(removeWorktreeAndBranch(root, mission.dir, mission.branch, head), true)
  assert.equal(existsSync(mission.dir), false)
  assert.throws(() =>
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${mission.branch}`])
  )
  // NADA foi deletado: a carcaça inteira — sobra sem cópia incluída — mora na
  // quarentena ao lado; apagar segue sendo decisão de gente.
  const quarantine = `${mission.dir}-carcass-bak`
  assert.equal(
    readFileSync(join(quarantine, 'delivered.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'entrega\n'
  )
  assert.equal(
    readFileSync(join(quarantine, 'build-output.tmp'), 'utf8'),
    'sobra de build\n'
  )
})

test('carcaça com arquivo rastreado adulterado é preservada no lugar e bloqueia', (t) => {
  const root = initializeRepository(t, 'synkora-carcass-tampered-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-carcass-tampered-wt-')
  const mission = createMissionWorktree(root, worktrees, 'carcass-tampered-mission')
  assert.ok(mission)
  writeFileSync(join(mission.dir, 'delivered.txt'), 'entrega\n', 'utf8')
  git(mission.dir, ['add', 'delivered.txt'])
  git(mission.dir, ['commit', '-m', 'entrega'])
  const head = git(mission.dir, ['rev-parse', 'HEAD'])

  unlinkSync(join(mission.dir, '.git'))
  git(root, ['worktree', 'prune'])
  // MESMO tamanho do conteúdo aprovado: só a leitura de bytes distingue —
  // stat (mtime/size) não pode ser a prova
  writeFileSync(join(mission.dir, 'delivered.txt'), 'entrela\n', 'utf8')

  assert.equal(removeWorktreeAndBranch(root, mission.dir, mission.branch, head), false)
  assert.equal(existsSync(join(mission.dir, 'delivered.txt')), true)
  assert.doesNotThrow(() =>
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${mission.branch}`])
  )
  assert.equal(existsSync(`${mission.dir}-carcass-bak`), false)
})

test('carcaça com a BRANCH divergida do SHA aprovado não é tocada', (t) => {
  const root = initializeRepository(t, 'synkora-carcass-branch-moved-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-carcass-branch-moved-wt-')
  const mission = createMissionWorktree(root, worktrees, 'carcass-branch-moved')
  assert.ok(mission)
  const head = git(mission.dir, ['rev-parse', 'HEAD'])

  unlinkSync(join(mission.dir, '.git'))
  git(root, ['worktree', 'prune'])
  // a branch anda por fora DEPOIS da fotografia aprovada
  git(root, ['commit', '--allow-empty', '-m', 'avanço externo'])
  git(root, ['branch', '-f', mission.branch, 'HEAD'])

  assert.equal(removeWorktreeAndBranch(root, mission.dir, mission.branch, head), false)
  assert.equal(existsSync(mission.dir), true)
  assert.equal(existsSync(`${mission.dir}-carcass-bak`), false)
  assert.notEqual(git(root, ['rev-parse', `refs/heads/${mission.branch}`]), head)
})

test('release journal is discardable only while both exact pre-CAS snapshots stay clean', (t) => {
  const root = initializeRepository(t, 'synkora-release-pre-cas-')
  const source = createVersionWorktree(
    root,
    initializeWorktreesDirectory(t, 'synkora-release-pre-cas-wt-'),
    'V1',
    'release-source-id'
  )
  assert.ok(source)
  const sourceHead = git(source.dir, ['rev-parse', 'HEAD'])
  const targetHead = git(root, ['rev-parse', 'HEAD'])
  const targetBranch = git(root, ['branch', '--show-current'])

  assert.equal(
    isExactCleanPreCasSnapshot(source.dir, sourceHead, root, targetHead, targetBranch),
    true
  )
  const lateTarget = join(root, 'late-target.txt')
  writeFileSync(lateTarget, 'late\n', 'utf8')
  assert.equal(
    isExactCleanPreCasSnapshot(source.dir, sourceHead, root, targetHead, targetBranch),
    false
  )
  rmSync(lateTarget)
  writeFileSync(join(source.dir, 'late-source.txt'), 'late\n', 'utf8')
  assert.equal(
    isExactCleanPreCasSnapshot(source.dir, sourceHead, root, targetHead, targetBranch),
    false
  )
})

// ——— Fase 2: pacotes de fatos do veredito (docs/FASE2_PLANO.md §4.1) ———

function deliveryFixture(t, prefix) {
  const root = initializeRepository(t, prefix)
  const baseHead = git(root, ['rev-parse', 'HEAD'])
  writeFileSync(join(root, 'feature.txt'), 'entrega\n', 'utf8')
  git(root, ['add', 'feature.txt'])
  git(root, ['commit', '-m', 'entrega'])
  const head = git(root, ['rev-parse', 'HEAD'])
  const tree = git(root, ['show', '-s', '--format=%T', head])
  const fingerprint = gitVisibleWorktreeFingerprint(root)
  return { root, facts: { head, tree, fingerprint, baseHead } }
}

test('commits da missão vêm mais novos primeiro e sem o trabalho alheio da base', (t) => {
  const root = initializeRepository(t, 'synkora-mission-commits-')
  const baseBranch = git(root, ['branch', '--show-current'])
  const worktrees = initializeWorktreesDirectory(t, 'synkora-mission-commits-wt-')
  const mission = createMissionWorktree(root, worktrees, 'commits-mission')
  assert.ok(mission)

  // Missão recém-nascida: leitura BOA e lista vazia — estado diferente de falha.
  assert.deepEqual(missionCommits(mission.dir, baseBranch), [])

  writeFileSync(join(mission.dir, 'primeiro.txt'), 'um\n', 'utf8')
  git(mission.dir, ['add', '-A'])
  git(mission.dir, ['commit', '-m', 'primeiro passo da missão'])
  writeFileSync(join(mission.dir, 'segundo.txt'), 'dois\n', 'utf8')
  git(mission.dir, ['add', '-A'])
  git(mission.dir, ['commit', '-m', 'segundo passo da missão'])

  // A BASE anda depois que a missão nasceu: é exatamente o caso em que diffar
  // contra a ponta mostraria o trabalho DOS OUTROS como se fosse desta missão.
  writeFileSync(join(root, 'de-outra-missao.txt'), 'alheio\n', 'utf8')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'entrega de outra missão'])

  const commits = missionCommits(mission.dir, baseBranch)
  assert.deepEqual(
    commits.map((commit) => commit.subject),
    ['segundo passo da missão', 'primeiro passo da missão']
  )
  for (const commit of commits) {
    assert.match(commit.sha, /^[0-9a-f]{40}$/)
    assert.ok(Array.isArray(commit.parents))
    for (const parent of commit.parents) assert.match(parent, /^[0-9a-f]{40}$/)
    // ISO 8601 estrito (%aI), o formato que o preload promete ao renderer.
    assert.match(commit.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/)
    assert.equal(Number.isNaN(Date.parse(commit.at)), false)
  }

  // Sem base declarada não há "à frente de quê": zero provados, nunca o
  // histórico inteiro do repositório.
  assert.deepEqual(missionCommits(mission.dir), [])
  // Worktree que não existe é FALHA de leitura, não missão sem commit.
  assert.equal(missionCommits(join(worktrees, 'nao-existe'), baseBranch), undefined)
})

test('lista de commits sobrevive a assunto exótico e para no teto de 50', (t) => {
  const root = initializeRepository(t, 'synkora-mission-commits-cap-')
  const baseBranch = git(root, ['branch', '--show-current'])
  const worktrees = initializeWorktreesDirectory(t, 'synkora-mission-commits-cap-wt-')
  const mission = createMissionWorktree(root, worktrees, 'commits-cap-mission')
  assert.ok(mission)

  // Assunto carregando o PRÓPRIO separador de campos (0x1f): a data vem antes
  // do assunto no formato justamente para que o resto da linha seja o assunto
  // inteiro. A verdade comparada é o que o GIT guardou (`%s`), não a string que
  // mandamos — se o git normalizar a mensagem, quem acompanha é o teste.
  const exotic = `refatora \u001f tabela — "aspas", acentuação e | pipe`
  git(mission.dir, ['commit', '--allow-empty', '-m', exotic])
  const stored = git(mission.dir, ['log', '-1', '--format=%s'])
  assert.equal(missionCommits(mission.dir, baseBranch)[0].subject, stored)

  for (let index = 0; index < 55; index += 1) {
    git(mission.dir, ['commit', '--allow-empty', '-m', `passo ${index}`])
  }
  const capped = missionCommits(mission.dir, baseBranch)
  assert.equal(capped.length, 50)
  assert.equal(capped[0].subject, 'passo 54')
})

test('histórico linear+merge desenha pais completos e patch só aceita commits da missão', (t) => {
  const root = initializeRepository(t, 'synkora-mission-history-')
  const baseBranch = git(root, ['branch', '--show-current'])
  const worktrees = initializeWorktreesDirectory(t, 'synkora-mission-history-wt-')
  const mission = createMissionWorktree(root, worktrees, 'history-merge-mission')
  assert.ok(mission)

  writeFileSync(join(mission.dir, 'main.txt'), 'linha principal\n', 'utf8')
  git(mission.dir, ['add', 'main.txt'])
  git(mission.dir, ['commit', '-m', 'passo principal'])
  git(mission.dir, ['checkout', '-b', 'mission-side-history'])
  writeFileSync(join(mission.dir, 'side.txt'), 'linha lateral\n', 'utf8')
  git(mission.dir, ['add', 'side.txt'])
  git(mission.dir, ['commit', '-m', 'passo lateral'])
  git(mission.dir, ['checkout', mission.branch])
  writeFileSync(join(mission.dir, 'after-side.txt'), 'depois da lateral\n', 'utf8')
  git(mission.dir, ['add', 'after-side.txt'])
  git(mission.dir, ['commit', '-m', 'prepara merge'])
  git(mission.dir, ['merge', '--no-ff', 'mission-side-history', '-m', 'merge lateral'])

  const commits = missionCommits(mission.dir, baseBranch)
  assert.ok(commits)
  assert.equal(commits[0].subject, 'merge lateral')
  assert.equal(commits[0].parents.length, 2)
  assert.match(commits[0].sha, /^[0-9a-f]{40}$/)
  assert.deepEqual(commits[0].parents, git(mission.dir, ['show', '-s', '--format=%P', commits[0].sha]).split(/\s+/))
  assert.deepEqual(
    commits.map((commit) => commit.subject),
    ['merge lateral', 'passo lateral', 'prepara merge', 'passo principal']
  )

  const mergePatch = missionCommitPatch(mission.dir, baseBranch, commits[0].sha)
  assert.equal(mergePatch.ok, true)
  assert.equal(mergePatch.sha, commits[0].sha)
  assert.match(mergePatch.diff ?? '', /side\.txt/)
  assert.equal(missionCommitPatch(mission.dir, baseBranch, commits[0].sha.slice(0, 12)).ok, false)

  // O HEAD da base é um commit real, mas não pertence ao recorte base..HEAD
  // da missão; a autoridade do worker precisa recusá-lo antes do diff.
  const baseHead = git(root, ['rev-parse', 'HEAD'])
  const outside = missionCommitPatch(mission.dir, baseBranch, baseHead)
  assert.equal(outside.ok, false)
  assert.match(outside.error ?? '', /não pertence|histórico/i)
})

test('patch de commit respeita o teto e não escreve no worktree', (t) => {
  const root = initializeRepository(t, 'synkora-mission-patch-cap-')
  const baseBranch = git(root, ['branch', '--show-current'])
  const worktrees = initializeWorktreesDirectory(t, 'synkora-mission-patch-cap-wt-')
  const mission = createMissionWorktree(root, worktrees, 'patch-cap-mission')
  assert.ok(mission)
  writeFileSync(
    join(mission.dir, 'large.txt'),
    Array.from({ length: 40_000 }, (_, index) => `linha de patch ${index.toString().padStart(5, '0')}`).join('\n') + '\n',
    'utf8'
  )
  git(mission.dir, ['add', 'large.txt'])
  git(mission.dir, ['commit', '-m', 'commit grande'])
  const commit = missionCommits(mission.dir, baseBranch)[0]
  const before = git(mission.dir, ['status', '--porcelain'])
  const patch = missionCommitPatch(mission.dir, baseBranch, commit.sha)
  assert.equal(patch.ok, true)
  assert.equal(patch.truncated, true)
  assert.ok((patch.diff ?? '').length <= 200_000)
  assert.equal(git(mission.dir, ['status', '--porcelain']), before)
})

// ————— A BASE NUNCA FICA PARA TRÁS (rodada 7, adendo C2) —————
//
// O incidente que estes testes prendem: a main de um projeto do dono andou 50
// commits POR FORA do Synkora e a branch da VERSÃO — a base de toda missão nova
// — ficou parada no commit inicial. A missão nasceu num worktree quase vazio, o
// agente mergeou a main, e a ENTREGA contabilizou o repositório inteiro (+50k
// linhas, 187 arquivos). `syncVersionBaseWithMain` é a cura: avança a base SÓ
// quando isso é fast-forward (que, por definição, não pode perder trabalho) e
// não move NADA em qualquer outro caso.

/** Avança a branch principal com N commits "por fora do Synkora". */
function advanceMainOutsideSynkora(root, count, prefix = 'fora') {
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(join(root, `${prefix}-${index}.txt`), `trabalho externo ${index}\n`, 'utf8')
    git(root, ['add', '-A'])
    git(root, ['commit', '-m', `${prefix} ${index}`])
  }
  return git(root, ['rev-parse', 'HEAD'])
}

test('base ATRÁS e ancestral: a versão checada no worktree dela avança até a main', (t) => {
  const root = initializeRepository(t, 'synkora-base-ff-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-base-ff-wt-')
  const mainBranch = git(root, ['branch', '--show-current'])
  const initial = git(root, ['rev-parse', 'HEAD'])
  // A versão nasce no commit inicial — exatamente como no caso real.
  const version = createVersionWorktree(root, worktrees, 'V1.0', 'versao-atrasada')
  assert.ok(version)
  assert.equal(git(root, ['rev-parse', `refs/heads/${version.branch}`]), initial)

  const mainSha = advanceMainOutsideSynkora(root, 3)

  const result = syncVersionBaseWithMain(root, version.branch)
  assert.equal(result.outcome, 'fast-forwarded')
  assert.equal(result.mainBranch, mainBranch)
  assert.equal(result.behind, 3, 'o aviso precisa dizer QUANTO a base estava atrás')
  assert.equal(result.ahead, 0)
  assert.equal(result.fromSha, initial)
  assert.equal(result.toSha, mainSha)
  // O ref pousou…
  assert.equal(git(root, ['rev-parse', `refs/heads/${version.branch}`]), mainSha)
  // …e os ARQUIVOS do worktree da versão acompanharam (mover só o ref deixaria
  // a árvore mentindo sobre o commit em que ela está).
  assert.equal(git(version.dir, ['rev-parse', 'HEAD']), mainSha)
  assert.equal(git(version.dir, ['branch', '--show-current']), version.branch)
  assert.ok(existsSync(join(version.dir, 'fora-3.txt')), 'o trabalho externo tem de chegar na pasta da versão')
  assert.equal(git(version.dir, ['status', '--porcelain']), '')

  // E a missão derivada dessa base nasce COM o trabalho externo — o oposto do
  // worktree quase vazio que produziu a entrega de +50 mil linhas.
  const mission = createMissionWorktree(root, worktrees, 'depois-do-ff', version.branch)
  assert.ok(mission)
  assert.equal(git(mission.dir, ['rev-parse', 'HEAD']), mainSha)
})

test('base ATRÁS sem worktree: o ref anda por update-ref com compare-and-swap', (t) => {
  const root = initializeRepository(t, 'synkora-base-ff-solta-')
  const initial = git(root, ['rev-parse', 'HEAD'])
  git(root, ['branch', 'version/solta'])
  const mainSha = advanceMainOutsideSynkora(root, 2)

  const result = syncVersionBaseWithMain(root, 'version/solta')
  assert.equal(result.outcome, 'fast-forwarded')
  assert.equal(result.behind, 2)
  assert.equal(result.checkedOutIn, undefined, 'branch sem worktree não tem pasta para alinhar')
  assert.equal(result.fromSha, initial)
  assert.equal(git(root, ['rev-parse', 'refs/heads/version/solta']), mainSha)
})

test('base DIVERGIDA nunca é decidida sozinha: nada se move e os dois lados são contados', (t) => {
  const root = initializeRepository(t, 'synkora-base-diverge-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-base-diverge-wt-')
  const version = createVersionWorktree(root, worktrees, 'V2.0', 'versao-divergente')
  assert.ok(version)
  // A versão andou por conta própria…
  writeFileSync(join(version.dir, 'da-versao.txt'), 'entrega da versão\n', 'utf8')
  git(version.dir, ['add', '-A'])
  git(version.dir, ['commit', '-m', 'trabalho da versão'])
  const versionSha = git(version.dir, ['rev-parse', 'HEAD'])
  // …e a main também, por outro caminho.
  const mainSha = advanceMainOutsideSynkora(root, 2)

  const result = syncVersionBaseWithMain(root, version.branch)
  assert.equal(result.outcome, 'diverged')
  assert.equal(result.ahead, 1, 'commits que só a base tem')
  assert.equal(result.behind, 2, 'commits que só a main tem')
  assert.match(result.detail ?? '', /só na base/)
  // NADA se moveu: nem o ref, nem os arquivos.
  assert.equal(git(root, ['rev-parse', `refs/heads/${version.branch}`]), versionSha)
  assert.equal(git(version.dir, ['rev-parse', 'HEAD']), versionSha)
  assert.equal(git(root, ['rev-parse', 'HEAD']), mainSha)
})

test('base À FRENTE da main é o estado SAUDÁVEL — nunca vira divergência', (t) => {
  const root = initializeRepository(t, 'synkora-base-frente-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-base-frente-wt-')
  const version = createVersionWorktree(root, worktrees, 'V3.0', 'versao-adiantada')
  assert.ok(version)
  writeFileSync(join(version.dir, 'missao-integrada.txt'), 'missão já integrada\n', 'utf8')
  git(version.dir, ['add', '-A'])
  git(version.dir, ['commit', '-m', 'missão integrada na versão'])
  const versionSha = git(version.dir, ['rev-parse', 'HEAD'])

  const result = syncVersionBaseWithMain(root, version.branch)
  assert.equal(result.outcome, 'up-to-date', 'versão à frente é o normal: recebe missões e só sobe no release')
  assert.equal(result.ahead, 1)
  assert.equal(result.behind, 0)
  assert.equal(git(root, ['rev-parse', `refs/heads/${version.branch}`]), versionSha)
})

test('base já na main não move nada, e a base que É a main é ignorada', (t) => {
  const root = initializeRepository(t, 'synkora-base-igual-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-base-igual-wt-')
  const mainBranch = git(root, ['branch', '--show-current'])
  const version = createVersionWorktree(root, worktrees, 'V4.0', 'versao-em-dia')
  assert.ok(version)
  const head = git(root, ['rev-parse', 'HEAD'])

  const emDia = syncVersionBaseWithMain(root, version.branch)
  assert.equal(emDia.outcome, 'up-to-date')
  assert.equal(emDia.ahead, 0)
  assert.equal(emDia.behind, 0)
  assert.equal(git(root, ['rev-parse', `refs/heads/${version.branch}`]), head)

  // Projeto sem versão: a base declarada É a própria main — nada a comparar.
  assert.equal(syncVersionBaseWithMain(root, mainBranch).outcome, 'skipped')
})

test('worktree da versão SUJO bloqueia o avanço e preserva a edição do dono', (t) => {
  const root = initializeRepository(t, 'synkora-base-sujo-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-base-sujo-wt-')
  const version = createVersionWorktree(root, worktrees, 'V5.0', 'versao-suja')
  assert.ok(version)
  const initial = git(root, ['rev-parse', 'HEAD'])
  advanceMainOutsideSynkora(root, 1)
  writeFileSync(join(version.dir, 'base.txt'), 'edição não commitada do dono\n', 'utf8')

  const result = syncVersionBaseWithMain(root, version.branch)
  assert.equal(result.outcome, 'blocked')
  assert.match(result.detail ?? '', /NÃO COMMITADAS/)
  assert.equal(git(root, ['rev-parse', `refs/heads/${version.branch}`]), initial, 'a base fica onde estava')
  assert.equal(
    readFileSync(join(version.dir, 'base.txt'), 'utf8'),
    'edição não commitada do dono\n',
    'sincronia nunca sobrescreve edição do dono'
  )
})

test('branch inexistente vira veredito honesto, nunca avanço presumido', (t) => {
  const root = initializeRepository(t, 'synkora-base-ausente-')
  const result = syncVersionBaseWithMain(root, 'version/nunca-existiu')
  assert.equal(result.outcome, 'unavailable')
  assert.equal(result.baseBranch, 'version/nunca-existiu')
  assert.equal(syncVersionBaseWithMain(root, '   ').outcome, 'unavailable')
})

// ————— R15: O WORKTREE NASCE MOBILIADO (junction de node_modules) —————
//
// A CRIAÇÃO era a metade que faltava: a remoção já é à prova de junction desde
// o incidente 02/08 (neutralizeReparsePoints desarma o LINK antes de qualquer
// deleção recursiva). Tudo aqui roda em DISCO REAL do Windows — junction de
// verdade, nada mocado — e a limpeza destes testes JAMAIS deleta recursivamente
// através de um link vivo: é exatamente a lição que a feature encoda.

const PLANTED = 'marca do store do projeto\n'

/** Desarma todo link DENTRO da árvore (remove só o LINK, nunca o alvo) antes de
 *  qualquer deleção recursiva — a mesma receita de neutralizeReparsePoints. */
function disarmLinks(root) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        try {
          rmdirSync(full)
        } catch {
          try {
            unlinkSync(full)
          } catch {
            /* nada a fazer: o teste já terminou */
          }
        }
        continue
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
}

function cleanupTree(dir) {
  disarmLinks(dir)
  rmSync(dir, { recursive: true, force: true })
}

/** Projeto NODE de verdade: repo com node_modules ignorado e um store real na
 *  raiz, com pacote plantado que prova de que LADO o link resolve. */
function initializeNodeProject(t, prefix, { store = true, ignore = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => cleanupTree(root))
  git(root, ['init'])
  git(root, ['config', 'user.name', 'Synkora Test'])
  git(root, ['config', 'user.email', 'synkora-test@example.invalid'])
  // `ignore: false` é o projeto REAL sem a linha no .gitignore — o caso da
  // cinta do check-ignore (mobiliar ali deixaria o worktree eternamente sujo).
  if (ignore) writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
  writeFileSync(join(root, 'base.txt'), 'base\n', 'utf8')
  git(root, ['add', ...(ignore ? ['.gitignore'] : []), 'base.txt'])
  git(root, ['commit', '-m', 'base'])
  if (store) plantStore(root)
  return root
}

function plantStore(root) {
  mkdirSync(join(root, 'node_modules', 'pacote-plantado'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'pacote-plantado', 'index.js'), PLANTED, 'utf8')
}

/** Pasta de worktrees cuja limpeza DESARMA os links (a helper genérica apaga
 *  recursivamente e não pode receber junction viva). */
function initializeLinkSafeWorktrees(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => cleanupTree(directory))
  return directory
}

/** Mobília provada: é LINK (não cópia) e resolve NO store do projeto. */
function assertFurnished(root, worktreeDir) {
  const link = join(worktreeDir, 'node_modules')
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'node_modules do worktree não é link')
  assert.equal(
    readFileSync(join(link, 'pacote-plantado', 'index.js'), 'utf8'),
    PLANTED,
    'o link não resolve no store do projeto'
  )
  assert.equal(realpathSync(link), realpathSync(join(root, 'node_modules')))
}

test('missão nasce mobiliada: node_modules é junction que resolve no store do projeto', (t) => {
  const root = initializeNodeProject(t, 'synkora-mobiliado-missao-')
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-mobiliado-missao-wt-')

  const mission = createMissionWorktree(root, worktrees, 'mobiliado-missao')
  assert.ok(mission)
  assertFurnished(root, mission.dir)
  // mobília não entra no diff da missão: o worktree continua limpo
  assert.equal(git(mission.dir, ['status', '--porcelain']), '')
})

test('versão nasce mobiliada pela mesma receita da missão', (t) => {
  const root = initializeNodeProject(t, 'synkora-mobiliado-versao-')
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-mobiliado-versao-wt-')

  const version = createVersionWorktree(root, worktrees, 'v1.2', 'v12')
  assert.ok(version)
  assertFurnished(root, version.dir)
  assert.equal(git(version.dir, ['status', '--porcelain']), '')
})

test('projeto sem node_modules na raiz não ganha link nem erro', (t) => {
  const root = initializeNodeProject(t, 'synkora-sem-store-', { store: false })
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-sem-store-wt-')

  const mission = createMissionWorktree(root, worktrees, 'sem-store')
  // criação segue viva: mobília ausente nunca derruba o worktree
  assert.ok(mission)
  assert.equal(isExpectedWorktree(root, mission.dir, mission.branch), true)
  assert.equal(existsSync(join(mission.dir, 'node_modules')), false)
  assert.equal(git(mission.dir, ['status', '--porcelain']), '')
})

test('worktree pré-R15 ganha a mobília na remontagem', (t) => {
  const root = initializeNodeProject(t, 'synkora-remontagem-')
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-remontagem-wt-')

  const first = createMissionWorktree(root, worktrees, 'remontagem')
  assert.ok(first)
  // volta ao estado pré-R15: rmdir tira só o LINK, jamais o alvo
  rmdirSync(join(first.dir, 'node_modules'))
  assert.equal(existsSync(join(first.dir, 'node_modules')), false)
  assert.equal(
    readFileSync(join(root, 'node_modules', 'pacote-plantado', 'index.js'), 'utf8'),
    PLANTED,
    'derrubar o link tocou o store do projeto'
  )

  const again = createMissionWorktree(root, worktrees, 'remontagem')
  assert.deepEqual(again, first, 'a remontagem tem que devolver o MESMO par dir/branch')
  assertFurnished(root, first.dir)
})

test('node_modules materializado no worktree nunca é sobrescrito pela mobília', (t) => {
  const root = initializeNodeProject(t, 'synkora-materializado-')
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-materializado-wt-')

  const mission = createMissionWorktree(root, worktrees, 'materializado')
  assert.ok(mission)
  rmdirSync(join(mission.dir, 'node_modules'))
  // npm install de agente DENTRO do worktree: pasta real, não link
  const local = join(mission.dir, 'node_modules', 'pacote-local')
  mkdirSync(local, { recursive: true })
  writeFileSync(join(local, 'index.js'), 'instalado no worktree\n', 'utf8')

  const again = createMissionWorktree(root, worktrees, 'materializado')
  assert.deepEqual(again, mission)
  assert.equal(
    lstatSync(join(mission.dir, 'node_modules')).isSymbolicLink(),
    false,
    'a mobília trocou uma instalação real por um link'
  )
  assert.equal(readFileSync(join(local, 'index.js'), 'utf8'), 'instalado no worktree\n')
  assert.equal(existsSync(join(mission.dir, 'node_modules', 'pacote-plantado')), false)
})

test('contrato do ensure: linked, already, no-source e falha legível em vez de exceção', async (t) => {
  const { ensureNodeModulesLink } = await import('../.tmp/mission-worktree-test/nodeModulesLink.js')
  const root = initializeNodeProject(t, 'synkora-ensure-contrato-', { store: false })
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-ensure-contrato-wt-')
  const mission = createMissionWorktree(root, worktrees, 'ensure-contrato')
  assert.ok(mission)

  assert.equal(ensureNodeModulesLink(root, mission.dir), 'no-source')
  assert.equal(existsSync(join(mission.dir, 'node_modules')), false)

  // o dono instala no projeto: a próxima passada mobilia
  plantStore(root)
  assert.equal(ensureNodeModulesLink(root, mission.dir), 'linked')
  assertFurnished(root, mission.dir)
  assert.equal(ensureNodeModulesLink(root, mission.dir), 'already', 'link existente foi refeito')

  // falha vira valor legível, nunca exceção — criar worktree não morre por mobília
  const missing = ensureNodeModulesLink(root, join(worktrees, 'worktree-que-nao-existe'))
  assert.equal(typeof missing, 'object')
  assert.ok(missing.error.length > 0)
  // caminho vazio jamais resolve contra o cwd do app
  assert.equal(typeof ensureNodeModulesLink('', mission.dir), 'object')
  assert.equal(typeof ensureNodeModulesLink(root, '  '), 'object')
})

test('node_modules NÃO ignorado no git: a mobília recusa em vez de sujar o worktree para sempre', async (t) => {
  const { ensureNodeModulesLink } = await import('../.tmp/mission-worktree-test/nodeModulesLink.js')
  const root = initializeNodeProject(t, 'synkora-sem-ignore-', { ignore: false })
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-sem-ignore-wt-')
  const mission = createMissionWorktree(root, worktrees, 'sem-ignore')
  assert.ok(mission)

  // Sem a cinta, a junction viraria milhares de untracked e `isWorktreeClean`
  // diria "sujo" PARA SEMPRE — o ⇪ da missão passaria a ser recusado no gate.
  assert.equal(ensureNodeModulesLink(root, mission.dir), 'not-ignored')
  assert.equal(existsSync(join(mission.dir, 'node_modules')), false, 'a mobília entrou mesmo sem ignore')
  assert.equal(git(mission.dir, ['status', '--porcelain']), '', 'o worktree nasceu sujo')
})

test('SEGURO da remoção: worktree mobiliado sai inteiro e o store do projeto sobrevive', (t) => {
  const root = initializeNodeProject(t, 'synkora-seguro-remocao-')
  const worktrees = initializeLinkSafeWorktrees(t, 'synkora-seguro-remocao-wt-')

  const mission = createMissionWorktree(root, worktrees, 'seguro-remocao')
  assert.ok(mission)
  assertFurnished(root, mission.dir)

  assert.equal(removeWorktreeAndBranch(root, mission.dir, mission.branch), true)
  assert.equal(existsSync(mission.dir), false)
  // o alvo do link segue INTACTO: a deleção não atravessou a junction
  assert.equal(
    readFileSync(join(root, 'node_modules', 'pacote-plantado', 'index.js'), 'utf8'),
    PLANTED,
    'a remoção atravessou a junction e esvaziou o store do projeto'
  )
})

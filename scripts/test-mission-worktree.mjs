import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  alignWorktreeFromSnapshot,
  changedWorktreeFiles,
  createMissionWorktree,
  createVersionWorktree,
  devDeliveryFacts,
  ensureSynkoraGitExcludes,
  executableProjectPathKind,
  gateVerdictFacts,
  gitHeadContainsMessage,
  gitHistoryContainsMessage,
  gitVisibleWorktreeFingerprint,
  isExactCleanPreCasSnapshot,
  isExpectedWorktree,
  isExpectedVersionWorktree,
  isExecutableProjectPath,
  mergeTaskWorktree,
  missionWorkspaceFileDiff,
  missionWorkspaceReadout,
  quarantineAndRevalidate,
  removeWorktreeAndBranch,
  resolveMissionWorkspace,
  resolveWorkspaceFilePath,
  snapshotTaskWorktree
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

test('reconhece marcador literal de integração no histórico Git', (t) => {
  const root = initializeRepository(t, 'synkora-history-marker-')
  writeFileSync(join(root, 'marked.txt'), 'ok\n', 'utf8')
  git(root, ['add', 'marked.txt'])
  git(root, ['commit', '-m', 'synkora-task:abc[123] · entrega'])
  assert.equal(gitHistoryContainsMessage(root, 'synkora-task:abc[123]'), true)
  assert.equal(gitHistoryContainsMessage(root, 'synkora-task:abc123'), false)
})

test('snapshot do card cria commit imutável sem executar hooks do repositório', (t) => {
  const root = initializeRepository(t, 'synkora-task-snapshot-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-task-snapshot-wt-')
  const task = createMissionWorktree(root, worktrees, 'snapshot-card')
  assert.ok(task)

  const hook = join(root, '.git', 'hooks', 'prepare-commit-msg')
  writeFileSync(hook, '#!/bin/sh\nexit 37\n', 'utf8')
  chmodSync(hook, 0o755)
  writeFileSync(join(task.dir, 'delivery.txt'), 'fotografia revisável\n', 'utf8')
  const previousHead = git(task.dir, ['rev-parse', 'HEAD'])

  const snapshot = snapshotTaskWorktree(
    task.dir,
    'synkora-task:snapshot-card · fotografia do dev'
  )

  assert.equal(snapshot.ok, true)
  assert.ok(snapshot.head)
  assert.ok(snapshot.tree)
  assert.ok(snapshot.fingerprint)
  assert.notEqual(snapshot.head, previousHead)
  assert.equal(git(task.dir, ['status', '--porcelain']), '')
  assert.equal(git(task.dir, ['show', '-s', '--format=%T', snapshot.head]), snapshot.tree)
  assert.match(
    git(task.dir, ['show', '-s', '--format=%B', snapshot.head]),
    /fotografia do dev/
  )
})

test('escrita tardia no destino é preservada depois do CAS e exige reparo', (t) => {
  const root = initializeRepository(t, 'synkora-late-target-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-late-target-wt-')
  const task = createMissionWorktree(root, worktrees, 'late-target-card')
  assert.ok(task)
  writeFileSync(join(task.dir, 'delivery.txt'), 'entrega aprovada\n', 'utf8')
  const snapshot = snapshotTaskWorktree(task.dir, 'snapshot aprovado')
  assert.equal(snapshot.ok, true)

  const expectedTargetHead = git(root, ['rev-parse', 'HEAD'])
  const expectedTargetBranch = git(root, ['branch', '--show-current'])
  const latePath = join(root, 'late-target.txt')
  const shellLatePath = latePath.replace(/\\/g, '/')
  const hook = join(root, '.git', 'hooks', 'reference-transaction')
  writeFileSync(
    hook,
    `#!/bin/sh\nif [ "$1" = "committed" ]; then printf '%s\\n' 'edição tardia preservada' > '${shellLatePath}'; fi\n`,
    'utf8'
  )
  chmodSync(hook, 0o755)

  const result = mergeTaskWorktree(
    root,
    task,
    'merge com escrita tardia',
    undefined,
    {
      requireCleanSource: true,
      expectedSourceHead: snapshot.head,
      expectedSourceFingerprint: snapshot.fingerprint,
      expectedTargetHead,
      expectedTargetBranch
    }
  )

  assert.equal(result.ok, false)
  assert.equal(result.committed, true)
  assert.equal(existsSync(task.dir), true)
  assert.equal(readFileSync(latePath, 'utf8').trim(), 'edição tardia preservada')
  assert.match(result.detail, /arquivos locais|preservados|alinhado/i)
})

test('journal nasce antes do CAS e permite repetir exatamente o merge do card', (t) => {
  const root = initializeRepository(t, 'synkora-card-journal-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-card-journal-wt-')
  const task = createMissionWorktree(root, worktrees, 'journaled-card')
  assert.ok(task)
  const marker = 'synkora-task:journaled-card'
  const expectedTargetHead = git(root, ['rev-parse', 'HEAD'])
  const expectedTargetBranch = git(root, ['branch', '--show-current'])
  writeFileSync(join(task.dir, 'delivery.txt'), 'entrega journalada\n', 'utf8')

  let journal
  const interrupted = mergeTaskWorktree(
    root,
    task,
    `${marker} · entrega`,
    undefined,
    {
      expectedTargetHead,
      expectedTargetBranch,
      beforeTargetUpdate: (snapshot) => {
        journal = snapshot
        assert.equal(git(root, ['rev-parse', 'HEAD']), expectedTargetHead)
        throw new Error('simulação de fechamento após o journal')
      }
    }
  )

  assert.equal(interrupted.ok, false)
  assert.ok(journal)
  assert.equal(git(root, ['rev-parse', 'HEAD']), expectedTargetHead)
  assert.equal(git(task.dir, ['rev-parse', 'HEAD']), journal.sourceHead)
  assert.equal(gitHeadContainsMessage(task.dir, marker), true)

  const recovered = mergeTaskWorktree(
    root,
    task,
    `${marker} · entrega`,
    undefined,
    {
      requireCleanSource: true,
      expectedSourceHead: journal.sourceHead,
      expectedTargetHead: journal.previousTargetHead,
      expectedTargetBranch: journal.targetBranch,
      expectedMergeCommit: journal.committedHead,
      beforeTargetUpdate: (snapshot) => assert.deepEqual(snapshot, journal)
    }
  )
  assert.equal(recovered.ok, true)
  assert.equal(git(root, ['rev-parse', 'HEAD']), journal.committedHead)
  assert.equal(gitHistoryContainsMessage(root, marker), true)
  assert.equal(existsSync(task.dir), false)
  assert.throws(() => git(root, ['show-ref', '--verify', `refs/heads/${task.branch}`]))
  assert.equal(
    readFileSync(join(root, 'delivery.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'entrega journalada\n'
  )
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

test('merge de card recusa mudança surgida depois do fingerprint aprovado', (t) => {
  const root = initializeRepository(t, 'synkora-post-gate-change-')
  const worktrees = initializeWorktreesDirectory(t, 'synkora-post-gate-change-wt-')
  const task = createMissionWorktree(root, worktrees, 'post-gate-card')
  assert.ok(task)
  writeFileSync(join(task.dir, 'delivery.txt'), 'versão aprovada\n', 'utf8')
  const approvedFingerprint = gitVisibleWorktreeFingerprint(task.dir)
  assert.ok(approvedFingerprint)
  writeFileSync(join(task.dir, 'delivery.txt'), 'mudança depois do QA\n', 'utf8')
  const targetHead = git(root, ['rev-parse', 'HEAD'])

  const result = mergeTaskWorktree(
    root,
    task,
    'synkora-task:post-gate-card · entrega',
    undefined,
    { expectedSourceFingerprint: approvedFingerprint }
  )

  assert.equal(result.ok, false)
  assert.match(result.detail, /origem mudou depois do último gate/i)
  assert.equal(git(root, ['rev-parse', 'HEAD']), targetHead)
  assert.match(git(task.dir, ['status', '--porcelain']), /delivery\.txt/)
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

test('lista geral preserva deletes, os dois lados de rename e untracked não ignorados', (t) => {
  const root = initializeRepository(t, 'synkora-changed-paths-')
  writeFileSync(join(root, 'source.ts'), 'export const value = 1\n', 'utf8')
  writeFileSync(join(root, 'guide.md'), '# Guia\n', 'utf8')
  writeFileSync(join(root, '.gitignore'), '*.cache\n', 'utf8')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'fixture files'])
  const baseBranch = git(root, ['branch', '--show-current'])
  const worktrees = initializeWorktreesDirectory(t, 'synkora-changed-paths-wt-')
  const mission = createMissionWorktree(root, worktrees, 'changed-paths-mission')
  assert.ok(mission)

  git(mission.dir, ['mv', 'source.ts', 'notes.md'])
  rmSync(join(mission.dir, 'guide.md'))
  writeFileSync(join(mission.dir, 'package.json'), '{"private":true}\n', 'utf8')
  writeFileSync(join(mission.dir, 'ignored.cache'), 'artefato de teste\n', 'utf8')

  const expected = ['guide.md', 'notes.md', 'package.json', 'source.ts']
    .sort((left, right) => left.localeCompare(right, 'en'))
  assert.deepEqual(changedWorktreeFiles(mission.dir, baseBranch), expected)
  assert.equal(changedWorktreeFiles(root, baseBranch), undefined)

  git(mission.dir, ['add', '-A'])
  git(mission.dir, ['commit', '-m', 'changes committed in task branch'])
  assert.deepEqual(changedWorktreeFiles(mission.dir, baseBranch), expected)
})

test('fingerprint Git-visível é determinístico e detecta conteúdo, index e HEAD', (t) => {
  const root = initializeRepository(t, 'synkora-visible-fingerprint-')
  writeFileSync(join(root, '.gitignore'), '*.cache\n', 'utf8')
  git(root, ['add', '.gitignore'])
  git(root, ['commit', '-m', 'ignore test artifacts'])

  const clean = gitVisibleWorktreeFingerprint(root)
  assert.match(clean ?? '', /^[0-9a-f]{64}$/)
  assert.equal(gitVisibleWorktreeFingerprint(root), clean)

  writeFileSync(join(root, 'build.cache'), 'saída ignorada\n', 'utf8')
  assert.equal(gitVisibleWorktreeFingerprint(root), clean)

  writeFileSync(join(root, 'delivery.txt'), 'primeira versão\n', 'utf8')
  const untracked = gitVisibleWorktreeFingerprint(root)
  assert.notEqual(untracked, clean)
  assert.equal(gitVisibleWorktreeFingerprint(root), untracked)

  git(root, ['add', 'delivery.txt'])
  const staged = gitVisibleWorktreeFingerprint(root)
  assert.notEqual(staged, untracked)

  git(root, ['reset', '--', 'delivery.txt'])
  assert.equal(gitVisibleWorktreeFingerprint(root), untracked)
  writeFileSync(join(root, 'delivery.txt'), 'segunda versão\n', 'utf8')
  assert.notEqual(gitVisibleWorktreeFingerprint(root), untracked)

  git(root, ['add', 'delivery.txt'])
  git(root, ['commit', '-m', 'gate must notice this commit'])
  assert.notEqual(gitVisibleWorktreeFingerprint(root), clean)
})

test('fingerprint falha fechado fora de uma worktree Git', (t) => {
  const directory = initializeWorktreesDirectory(t, 'synkora-no-git-fingerprint-')
  assert.equal(gitVisibleWorktreeFingerprint(directory), undefined)
})

test('classifica código, automação e configurações sensíveis sem bloquear docs/assets', () => {
  const executable = [
    ['src/App.tsx', 'source'],
    ['styles/global.css', 'source'],
    ['backend/service.py', 'source'],
    ['scripts/release', 'automation'],
    ['.github/workflows/release.yml', 'automation'],
    ['migrations/001-create-users.sql', 'automation'],
    ['package.json', 'sensitive-config'],
    ['.env.production', 'sensitive-config'],
    ['Dockerfile', 'sensitive-config'],
    ['tsconfig.node.json', 'sensitive-config'],
    ['build.gradle.kts', 'sensitive-config'],
    ['docs/example-payload.json', 'sensitive-config'],
    ['..\\outside.txt', 'sensitive-config'],
    ['unsafe\0path.md', 'sensitive-config']
  ]
  for (const [path, kind] of executable) {
    assert.equal(executableProjectPathKind(path), kind, path)
    assert.equal(isExecutableProjectPath(path), true, path)
  }

  for (const path of [
    'README.md',
    'docs/architecture.md',
    'infra/README.md',
    'assets/logo.svg',
    'reports/results.csv',
    'presentation.pptx',
    '.synkora/reports/audit.md'
  ]) {
    assert.equal(executableProjectPathKind(path), undefined, path)
    assert.equal(isExecutableProjectPath(path), false, path)
  }
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

test('gateVerdictFacts entrega fingerprint+fotografia+head numa viagem', (t) => {
  const { root, facts } = deliveryFixture(t, 'synkora-gate-facts-')

  const clean = gateVerdictFacts(root, facts, true)
  assert.equal(clean.snapshotProblem, undefined)
  assert.equal(clean.head, facts.head)
  assert.equal(clean.fingerprint, facts.fingerprint)

  writeFileSync(join(root, 'feature.txt'), 'gate escreveu\n', 'utf8')
  const dirty = gateVerdictFacts(root, facts, true)
  assert.ok(/não commitados/.test(dirty.snapshotProblem))
  assert.equal(dirty.head, facts.head)
  assert.notEqual(dirty.fingerprint, facts.fingerprint)
})

test('quarantineAndRevalidate move untracked novo e devolve a revalidação junto', (t) => {
  const { root, facts } = deliveryFixture(t, 'synkora-quarantine-facts-')
  const quarantineDir = initializeWorktreesDirectory(t, 'synkora-quarantine-dir-')

  const noop = quarantineAndRevalidate(root, quarantineDir, facts, true)
  assert.deepEqual(noop.moved, [])
  assert.equal(noop.fingerprint, undefined)
  assert.equal(noop.snapshotProblem, undefined)

  writeFileSync(join(root, 'evidencia.png'), 'screenshot\n', 'utf8')
  const swept = quarantineAndRevalidate(root, quarantineDir, facts, true)
  assert.deepEqual(swept.moved, ['evidencia.png'])
  assert.equal(swept.snapshotProblem, undefined)
  assert.equal(swept.fingerprint, facts.fingerprint)
  assert.equal(existsSync(join(root, 'evidencia.png')), false)
  assert.equal(existsSync(join(quarantineDir, 'evidencia.png')), true)
})

test('devDeliveryFacts re-checa a fotografia e resolve base+changedPaths', (t) => {
  const { root, facts } = deliveryFixture(t, 'synkora-dev-facts-')
  const snapshot = { head: facts.head, tree: facts.tree, fingerprint: facts.fingerprint }

  const exact = devDeliveryFacts(root, snapshot, { hasWorktree: true, baseRef: facts.baseHead })
  assert.equal(exact.snapshotStillExact, true)
  assert.equal(exact.fingerprint, facts.fingerprint)
  assert.equal(exact.baseRef, facts.baseHead)
  assert.ok(exact.changedPaths.includes('feature.txt'))

  writeFileSync(join(root, 'feature.txt'), 'drift depois da fotografia\n', 'utf8')
  const drifted = devDeliveryFacts(root, snapshot, { hasWorktree: true, baseRef: facts.baseHead })
  assert.equal(drifted.snapshotStillExact, false)
  git(root, ['checkout', '--', '.'])

  // fotografia INCOMPLETA conta como drift (mais estrito que o inline antigo)
  const partial = devDeliveryFacts(root, { head: facts.head }, { hasWorktree: true })
  assert.equal(partial.snapshotStillExact, false)

  // sem worktree a fotografia não se aplica; a base sai da branch do projeto
  const loose = devDeliveryFacts(root, undefined, {
    hasWorktree: false,
    branchProbePath: root
  })
  assert.equal(loose.snapshotStillExact, true)
  assert.equal(typeof loose.baseRef, 'string')
})

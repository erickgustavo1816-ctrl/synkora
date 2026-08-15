import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const {
  FileActionService,
  parseFileActionName,
  parseFileActionRelativePath,
  resolveFileActionRoot
} = require('../.tmp/file-actions-test/fileActions.js')
const {
  archiveDirectoryOffMain,
  archiveDirectoryToNewFileOffMain
} = require('../.tmp/file-actions-test/fileArchiveAsync.js')
const AdmZip = require('adm-zip')

function safeCleanup(t, directory) {
  t.after(async () => {
    const tempRoot = resolve(tmpdir())
    const target = resolve(directory)
    const delta = relative(tempRoot, target)
    assert.ok(delta && delta !== '..' && !delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    await rm(target, { recursive: true, force: true })
  })
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'synkora-file-actions-test-'))
  safeCleanup(t, base)
  const projectRoot = join(base, 'project')
  const worktreeRoot = join(base, 'worktree')
  await mkdir(projectRoot)
  await mkdir(worktreeRoot)
  const missions = new Map([
    ['mission-1', { projectId: 'project-1', status: 'ativa', worktree: worktreeRoot }],
    ['mission-other', { projectId: 'project-2', status: 'ativa', worktree: worktreeRoot }],
    // Arquivar NÃO apaga o worktree do disco (só missions:remove apaga).
    ['mission-archived', { projectId: 'project-1', status: 'arquivada', worktree: worktreeRoot }],
    // A integração conclui a missão limpando branch/worktree do registro.
    ['mission-done', { projectId: 'project-1', status: 'concluida' }],
    // Missão de planejamento nasce viva e sem worktree por desenho.
    ['mission-planning', { projectId: 'project-1', status: 'ativa' }]
  ])
  const lookup = {
    project: (id) => id === 'project-1' ? { path: projectRoot } : undefined,
    mission: (id) => missions.get(id)
  }
  return { base, projectRoot, worktreeRoot, lookup }
}

test('a raiz física é resolvida apenas por projectId/missionId pareados', async (t) => {
  const { projectRoot, worktreeRoot, lookup } = await fixture(t)
  assert.equal(resolveFileActionRoot({ projectId: 'project-1' }, lookup), projectRoot)
  assert.equal(
    resolveFileActionRoot({ projectId: 'project-1', missionId: 'mission-1' }, lookup),
    worktreeRoot
  )
  assert.throws(
    () => resolveFileActionRoot(
      { projectId: 'project-1', missionId: 'mission-other' },
      lookup
    ),
    /Projeto ou missão inválidos/u
  )
  assert.throws(
    () => resolveFileActionRoot({ projectId: '../project' }, lookup),
    /Projeto ou missão inválidos/u
  )
})

test('escopo de missão exige espaço de trabalho vivo e próprio', async (t) => {
  const { worktreeRoot, lookup } = await fixture(t)
  const scopeOf = (missionId) => ({ projectId: 'project-1', missionId })

  // Missão viva com worktree continua sendo a única raiz de missão.
  assert.equal(resolveFileActionRoot(scopeOf('mission-1'), lookup), worktreeRoot)

  // Arquivada: a pasta existe no disco e mesmo assim deixa de abrir aqui.
  assert.throws(
    () => resolveFileActionRoot(scopeOf('mission-archived'), lookup),
    (error) => error.code === 'mission-closed' && /Reative a missão/u.test(error.message)
  )
  // Concluída: além de encerrada, perdeu o worktree no merge.
  assert.throws(
    () => resolveFileActionRoot(scopeOf('mission-done'), lookup),
    (error) => error.code === 'mission-closed'
  )
  // Sem worktree, a raiz do projeto NÃO é herdada disfarçada de missão: o
  // resolvedor recusa em vez de devolver `project.path`.
  assert.throws(
    () => resolveFileActionRoot(scopeOf('mission-planning'), lookup),
    (error) => error.code === 'mission-no-workspace' && /raiz do projeto/u.test(error.message)
  )

  // Efeito consciente: a cerca é do resolvedor, então as mutações caem junto.
  const service = new FileActionService(lookup, {
    trashItem: async () => assert.fail('lixeira não deveria ser chamada'),
    writeClipboard: () => assert.fail('clipboard não deveria ser chamado'),
    archiveDirectory: async () => assert.fail('zip não deveria ser chamado')
  })
  const closedScope = scopeOf('mission-archived')
  const tree = await service.listTree(closedScope)
  assert.equal(tree.ok, false)
  assert.match(tree.error, /Esta missão foi encerrada/u)
  for (const result of [
    await service.createFolder(closedScope, '', 'nova'),
    await service.createFile(closedScope, '', 'nova.md'),
    await service.copyPath(closedScope, 'qualquer.md'),
    await service.moveToTrash(closedScope, 'qualquer.md')
  ]) {
    assert.equal(result.ok, false)
    assert.match(result.error, /Esta missão foi encerrada/u)
  }
})

test('o dialeto relativo recusa traversal, absoluto, drive-relative, UNC e metadados', () => {
  for (const candidate of [
    '../fora',
    'docs/../fora',
    '/absoluto',
    'C:drive-relative',
    'C:\\absoluto',
    '\\\\servidor\\share',
    '.git/config',
    'src/.SYNKORA/item',
    'arquivo:stream',
    'nome. '
  ]) {
    assert.throws(() => parseFileActionRelativePath(candidate), undefined, candidate)
  }
  for (const candidate of ['a/b', ' CON ', 'nul.txt', 'dois\\segmentos']) {
    assert.throws(() => parseFileActionName(candidate), undefined, candidate)
  }
  assert.deepEqual(parseFileActionRelativePath('src/components/App.tsx'), {
    normalized: 'src/components/App.tsx',
    segments: ['src', 'components', 'App.tsx']
  })
})

test('criação e rename nunca sobrescrevem um item existente', async (t) => {
  const { projectRoot, lookup } = await fixture(t)
  let clipboardValue = ''
  const service = new FileActionService(lookup, {
    trashItem: async () => assert.fail('lixeira não deveria ser chamada'),
    writeClipboard: (value) => { clipboardValue = value },
    archiveDirectory: async () => ({ files: 0, bytes: 0 })
  })
  const scope = { projectId: 'project-1' }

  assert.deepEqual(await service.createFolder(scope, '', 'docs'), {
    ok: true,
    path: 'docs'
  })
  assert.deepEqual(await service.createFile(scope, 'docs', 'novo.md'), {
    ok: true,
    path: 'docs/novo.md'
  })
  await writeFile(join(projectRoot, 'docs', 'ocupado.md'), 'preservar', 'utf8')
  const collision = await service.rename(scope, 'docs/novo.md', 'ocupado.md')
  assert.equal(collision.ok, false)
  assert.match(collision.error, /Nada foi sobrescrito/u)
  assert.equal(await readFile(join(projectRoot, 'docs', 'ocupado.md'), 'utf8'), 'preservar')
  await access(join(projectRoot, 'docs', 'novo.md'))

  const duplicate = await service.createFile(scope, 'docs', 'ocupado.md')
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.error, /Nada foi sobrescrito/u)

  const copied = await service.copyPath(scope, 'docs/novo.md')
  assert.equal(copied.ok, true)
  assert.equal(clipboardValue, await realpath(join(projectRoot, 'docs', 'novo.md')))
  assert.equal('absolutePath' in copied, false)
})

test('raiz e metadados são imutáveis; exclusão usa somente o adaptador de lixeira', async (t) => {
  const { base, projectRoot, lookup } = await fixture(t)
  await mkdir(join(projectRoot, '.git'))
  await writeFile(join(projectRoot, 'apagar.txt'), 'recuperável', 'utf8')
  const trashed = join(base, 'lixeira-recuperavel.txt')
  let trashCalls = 0
  const service = new FileActionService(lookup, {
    trashItem: async (target) => {
      trashCalls += 1
      assert.equal(await readFile(target, 'utf8'), 'recuperável')
      await rename(target, trashed)
    },
    writeClipboard: () => undefined,
    archiveDirectory: async () => ({ files: 0, bytes: 0 })
  })
  const scope = { projectId: 'project-1' }

  const rootDelete = await service.moveToTrash(scope, '')
  assert.equal(rootDelete.ok, false)
  assert.match(rootDelete.error, /raiz/u)
  const metadataDelete = await service.moveToTrash(scope, '.git')
  assert.equal(metadataDelete.ok, false)
  assert.match(metadataDelete.error, /metadados/u)
  assert.equal(trashCalls, 0)

  assert.deepEqual(await service.moveToTrash(scope, 'apagar.txt'), {
    ok: true,
    previousPath: 'apagar.txt'
  })
  assert.equal(trashCalls, 1)
  assert.equal(await readFile(trashed, 'utf8'), 'recuperável')
})

test('symlink/junction fica visível como bloqueado e nunca vira autoridade', async (t) => {
  const { base, projectRoot, lookup } = await fixture(t)
  const outside = join(base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'segredo.txt'), 'não ler', 'utf8')
  const linkPath = join(projectRoot, 'atalho')
  try {
    await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.diagnostic(`ambiente sem permissão para criar link/junction: ${error.code ?? 'erro'}`)
    return
  }
  let copied = false
  const service = new FileActionService(lookup, {
    trashItem: async () => assert.fail('não deve enviar link à lixeira'),
    writeClipboard: () => { copied = true },
    archiveDirectory: async () => ({ files: 0, bytes: 0 })
  })
  const scope = { projectId: 'project-1' }
  const tree = await service.listTree(scope)
  assert.equal(tree.ok, true)
  const blocked = tree.entries.find((entry) => entry.path === 'atalho')
  assert.equal(blocked?.kind, 'blocked')
  assert.equal(blocked?.blockedReason, 'link')
  assert.equal(tree.entries.some((entry) => entry.name === 'segredo.txt'), false)
  assert.equal((await service.copyPath(scope, 'atalho')).ok, false)
  assert.equal((await service.createFile(scope, 'atalho', 'fora.txt')).ok, false)
  assert.equal(copied, false)
})

test('ZIP roda em worker, omite metadados, respeita caps e publica sem overwrite', async (t) => {
  const { base } = await fixture(t)
  const source = join(base, 'download')
  const docs = join(source, 'docs')
  await mkdir(docs, { recursive: true })
  await mkdir(join(source, '.git'))
  await writeFile(join(source, 'README.md'), 'olá', 'utf8')
  await writeFile(join(docs, 'guia.txt'), 'guia', 'utf8')
  await writeFile(join(source, '.git', 'config'), 'metadado', 'utf8')
  const output = join(base, 'download.zip')

  const result = await archiveDirectoryToNewFileOffMain(source, output)
  assert.deepEqual(result, { files: 2, bytes: 8 })
  const names = new AdmZip(output).getEntries().map((entry) => entry.entryName).sort()
  assert.deepEqual(names, ['README.md', 'docs/guia.txt'])

  await assert.rejects(
    archiveDirectoryToNewFileOffMain(source, output),
    /Nada foi sobrescrito/u
  )
  assert.deepEqual(new AdmZip(output).getEntries().map((entry) => entry.entryName).sort(), names)

  await assert.rejects(
    archiveDirectoryOffMain(source, join(base, 'cap.zip'), { maxBytes: 3, maxFileBytes: 3 }),
    /limite/u
  )

  const outside = join(base, 'fora-do-zip')
  await mkdir(outside)
  await writeFile(join(outside, 'nao-incluir.txt'), 'externo', 'utf8')
  try {
    await symlink(
      outside,
      join(source, 'atalho'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await assert.rejects(
      archiveDirectoryOffMain(source, join(base, 'link.zip')),
      /link simbólico|junction/u
    )
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.diagnostic('ambiente sem permissão para testar link/junction dentro do ZIP')
    } else {
      throw error
    }
  }
})

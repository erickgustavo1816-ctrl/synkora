import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { actionsForFileTreeNode } from '../src/renderer/src/file-tree/fileTreeTypes.ts'

const directory = {
  path: 'docs',
  parentPath: '',
  name: 'docs',
  kind: 'directory',
  depth: 1,
  size: 0,
  mtime: 0
}

test('matriz do menu não oferece mutação da raiz ou de links', () => {
  assert.deepEqual(actionsForFileTreeNode({ ...directory, path: '', root: true }), [
    'create-file',
    'create-folder'
  ])
  assert.deepEqual(actionsForFileTreeNode({
    ...directory,
    kind: 'blocked',
    blockedReason: 'link'
  }), [])
  assert.deepEqual(actionsForFileTreeNode(directory), [
    'create-file',
    'create-folder',
    'rename',
    'trash',
    'copy-path',
    'download-zip'
  ])
})

test('árvore, menu e modal preservam contratos explícitos de teclado/foco', async () => {
  const [tree, menu, modal, ipc] = await Promise.all([
    readFile(new URL('../src/renderer/src/file-tree/FileTree.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/file-tree/FileContextMenu.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/file-tree/FileActionModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/main/ipc/files.ts', import.meta.url), 'utf8')
  ])
  const all = `${tree}\n${menu}\n${modal}`
  assert.equal(all.includes('window.confirm'), false)
  for (const contract of [
    'role="tree"',
    'role="treeitem"',
    "event.key === 'ContextMenu'",
    "event.key === 'F10'",
    "event.key === 'F2'",
    "event.key === 'Delete'",
    'role="menu"',
    'role="menuitem"',
    'aria-modal="true"',
    "event.key === 'Escape'",
    "event.key !== 'Tab'"
  ]) {
    assert.ok(all.includes(contract), `contrato ausente: ${contract}`)
  }
  assert.ok(
    (ipc.match(/extras\.assertAppRendererSender\(event\)/gu) ?? []).length >= 7,
    'todo canal P26 deve autenticar o frame remetente'
  )
})

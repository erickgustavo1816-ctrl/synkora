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

test('navegador novo tem uma única hierarquia e estados visuais de linha inteira', async () => {
  const [tree, view, css] = await Promise.all([
    readFile(new URL('../src/renderer/src/file-tree/FileTree.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/components/FilesView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/global.css', import.meta.url), 'utf8')
  ])

  assert.ok(tree.includes('className="files-nav"'))
  assert.ok(tree.includes('className={`files-nav-row'))
  assert.ok(view.includes('sourceControl={('))
  assert.equal(view.includes('files-list-head'), false, 'não pode haver cabeçalho duplicado')
  assert.equal(view.includes('files-readonly-note'), false, 'instrução permanente não deve competir com a árvore')

  const hover = css.match(/\.files-nav-row:hover\s*\{(?<body>[\s\S]*?)\}/u)?.groups?.body ?? ''
  assert.match(hover, /border-color:/u)
  assert.match(hover, /background:/u)

  const selection = css.match(/\.files-nav-row\.active\s*\{(?<body>[\s\S]*?)\}/u)?.groups?.body ?? ''
  assert.match(selection, /background:\s*var\(--ink\)/u)
  assert.match(selection, /color:\s*var\(--paper\)/u)

  assert.match(css, /\.files-nav-row:has\(\.files-nav-item:focus-visible\)/u)
  assert.match(css, /\.file-context-item:hover,[\s\S]*?background:\s*var\(--ink\)/u)
})

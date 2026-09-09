import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

const compiled = buildSync({
  entryPoints: ['src/renderer/src/file-tree/FileTree.tsx'],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom']
}).outputFiles[0].text
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const scope = { projectId: 'synthetic-project' }
const entry = (path, kind = 'file', extra = {}) => ({
  path, parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  name: path.split('/').at(-1), kind, depth: path.split('/').length, size: 0, mtime: 0, ...extra
})
const snapshot = (entries, nextOffset) => ({ ok: true, entries, truncated: nextOffset !== undefined, nextOffset })

async function harness(t, list) {
  const calls = []
  const listeners = new Set()
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'window', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { synkora: { files: {
      tree: async (scope, path, offset) => { calls.push({ scope, path, offset }); return list(scope, path, offset) },
      onChanged: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    } } }
  )
  const FileTree = loaded.exports.default
  const props = { scope, sourceControl: null }
  let tree
  await act(async () => { tree = create(React.createElement(FileTree, props)) })
  t.after(async () => { await act(() => tree.unmount()) })
  return {
    tree, calls,
    changed: async () => act(async () => { for (const listener of listeners) listener(scope) }),
    update: async (scope) => act(async () => tree.update(React.createElement(FileTree, { ...props, scope }))),
    names: () => tree.root.findAllByProps({ role: 'treeitem' }).map((node) => node.props['aria-label']),
    clickItem: async (name) => act(async () => tree.root.findByProps({ role: 'treeitem', 'aria-label': name }).props.onClick()),
    clickMore: async (name) => act(async () => tree.root.findByProps({ 'aria-label': `Mostrar mais arquivos de ${name}` }).props.onClick())
  }
}

test('a árvore real mostra todos os tipos e só busca filhos quando a pasta é expandida', async (t) => {
  const h = await harness(t, (_scope, path) => snapshot(path === '' ? [
    entry('node_modules', 'directory'), entry('.git', 'directory', { readOnly: true }),
    entry('.env'), entry('image.png'), entry('archive.zip'), entry('file.custom')
  ] : path === '.git' ? [entry('.git/config', 'file', { readOnly: true })] : [entry('node_modules/dependency.js')]))
  assert.equal(h.calls.length, 1)
  assert.deepEqual(new Set(h.names()), new Set(['.git', 'node_modules', '.env', 'image.png', 'archive.zip', 'file.custom']))
  await h.clickItem('node_modules')
  assert.equal(h.calls.at(-1).path, 'node_modules')
  assert.ok(h.names().includes('dependency.js'))
  await h.clickItem('node_modules')
  assert.ok(!h.names().includes('dependency.js'))
  await h.clickItem('node_modules')
  assert.equal(h.calls.length, 2, 'reopening a loaded folder uses its cache')
  await h.clickItem('.git')
  assert.ok(h.names().includes('config'))
  for (const name of ['.git', 'config']) {
    assert.equal(h.tree.root.findAllByProps({ 'aria-label': `Ações de ${name}` }).length, 0)
    const item = h.tree.root.findByProps({ role: 'treeitem', 'aria-label': name })
    await act(async () => {
      for (const key of ['F2', 'Delete']) item.props.onKeyDown({ key, preventDefault() {} })
    })
  }
  assert.equal(h.tree.root.findAllByProps({ 'aria-modal': 'true' }).length, 0)
})

test('mostrar mais acrescenta páginas na raiz e dentro das pastas sem perder os itens anteriores', async (t) => {
  const h = await harness(t, (_scope, path, offset) => path === ''
    ? offset === 0 ? snapshot([entry('assets', 'directory'), entry('one.txt')], 2) : snapshot([entry('two.txt')])
    : offset === 0 ? snapshot([entry('assets/one.png')], 1) : snapshot([entry('assets/two.png')]))
  await h.clickMore('raiz do projeto')
  assert.ok(h.names().includes('one.txt') && h.names().includes('two.txt'))
  await h.clickItem('assets')
  await h.clickMore('assets')
  assert.ok(h.names().includes('one.png') && h.names().includes('two.png'))
  assert.deepEqual(h.calls.map(({ path, offset }) => [path, offset]), [['', 0], ['', 2], ['assets', 0], ['assets', 1]])
  assert.equal(h.tree.root.findAll((node) => node.type === 'button' && String(node.props['aria-label']).startsWith('Mostrar mais')).length, 0)
})

test('uma resposta atrasada não mistura arquivos de projetos ou origens diferentes', async (t) => {
  let resolveOld
  const h = await harness(t, (requestScope) => requestScope === scope
    ? new Promise((resolve) => { resolveOld = resolve })
    : snapshot([entry(requestScope.missionId ? 'mission.txt' : 'other.txt')]))
  await h.update({ projectId: 'other-project' })
  assert.deepEqual(h.names(), ['other.txt'])
  await act(async () => resolveOld(snapshot([entry('old.txt')])))
  assert.deepEqual(h.names(), ['other.txt'])
  await h.update({ projectId: 'other-project', missionId: 'synthetic-mission' })
  assert.deepEqual(h.names(), ['mission.txt'])
})

test('recarregar mantém pastas abertas e atualiza seus filhos, sem buscar pastas fechadas', async (t) => {
  let fileName = 'before.txt'
  const h = await harness(t, (_scope, path) => snapshot(path === ''
    ? [entry('open', 'directory'), entry('closed', 'directory')]
    : [entry(`${path}/${fileName}`)]))
  await h.clickItem('open')
  fileName = 'after.txt'
  await h.changed()
  assert.ok(h.names().includes('after.txt'))
  assert.ok(!h.names().includes('before.txt'))
  assert.equal(h.calls.filter(({ path }) => path === 'open').length, 2)
  assert.equal(h.calls.filter(({ path }) => path === 'closed').length, 0)
})

test('falha ao carregar outra página conserva os arquivos e oferece nova tentativa', async (t) => {
  let fail = true
  const h = await harness(t, (_scope, _path, offset) => {
    if (offset === 0) return snapshot([entry('one.txt')], 1)
    if (fail) throw new Error('synthetic error')
    return snapshot([entry('two.txt')])
  })
  await h.clickMore('raiz do projeto')
  assert.deepEqual(h.names(), ['one.txt'])
  fail = false
  const retry = h.tree.root.findAll((node) => node.type === 'button' && node.children.includes('tentar de novo'))[0]
  await act(async () => retry.props.onClick())
  assert.deepEqual(h.names(), ['one.txt', 'two.txt'])
  assert.deepEqual(h.calls.map(({ offset }) => offset), [0, 1, 1])
})

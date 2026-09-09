import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const compiled = await build({
  entryPoints: ['src/renderer/src/components/MissionColumn.tsx'],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-store', setup(build) {
    build.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store', namespace: 'synthetic' }))
    build.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: 'export const missionTypeOf = m => m.type ?? "produto"' }))
  } }]
})
const loaded = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const MissionColumn = loaded.exports.default

test('recolher a lista retira sua navegação do foco e reabrir preserva a seleção', async () => {
  const props = { entries: [], selectedId: null, onSelect() {}, onNewMission() {}, id: 'missions-test' }
  let tree
  await act(() => { tree = create(React.createElement(MissionColumn, props)) })
  try {
    const general = tree.root.findByProps({ className: 'mission-col-general active' })
    await act(() => tree.update(React.createElement(MissionColumn, { ...props, collapsed: true })))
    const hidden = tree.root.findByProps({ className: 'mission-col is-collapsed' })
    assert.notEqual(hidden.props.hidden, true, 'o conteúdo fica montado para a transição suave de largura')
    assert.equal(hidden.props['aria-hidden'], true)
    assert.equal(hidden.props.inert, true, 'a lista fechada não deve capturar Tab')
    await act(() => tree.update(React.createElement(MissionColumn, { ...props, collapsed: false })))
    assert.equal(tree.root.findByProps({ className: 'mission-col-general active' }), general, 'os controles existentes permanecem montados')
    assert.equal(tree.root.findByProps({ className: 'mission-col' }).props['aria-hidden'], false)
  } finally { await act(() => tree.unmount()) }
})

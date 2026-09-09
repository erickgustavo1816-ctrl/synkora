import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const code = buildSync({ entryPoints: ['src/renderer/src/useGuiComposerFit.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react'] }).outputFiles[0].text

test('real fit hook shortens labels progressively, restores them, and responds to model changes', async () => {
  const callbacks = []
  const elements = Object.fromEntries(Object.entries({
    '.gui-composer-mode .gui-mode-btn > span:first-child': 14,
    '.gui-composer-mode .gui-mode-text': 103,
    '.gui-composer-mode .gui-mode-short': 55,
    '.gui-context-trigger-bar': 24,
    '.gui-context-trigger-label': 74,
    '.gui-context-trigger-percent': 19,
    '.gui-composer-model .gui-mode-text': 76,
    '.mode-model > span:first-child': 7,
    '.gui-composer-effort .gui-mode-text': 28,
    '.mode-effort > span:first-child': 7,
    '.gui-attach-btn': 30, '.gui-send': 30, '.gui-fast-btn': 30,
    '.gui-context-trigger': 116, '.mode-effort': 58
  }).map(([key, width]) => [key, { width, getBoundingClientRect() { return { width: this.width } } }]))
  const inner = { clientWidth: 640, querySelector: s => elements[s], querySelectorAll: () => Object.values(elements) }
  const ref = { current: { querySelector: () => inner } }
  class Observer { constructor(callback) { callbacks.push(callback) } observe() {} disconnect() {} }
  const style = { paddingLeft: '7px', paddingRight: '7px', getPropertyValue: () => '' }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'document', code)(
    createRequire(import.meta.url), module, module.exports, () => style, Observer, Observer, {})
  let level
  function Harness({ enabled = true }) { level = module.exports.useGuiComposerFit(ref, enabled); return null }
  let tree
  await act(() => { tree = create(React.createElement(Harness)) })
  const sizes = [640, 550, 500, 460, 430, 340, 640]
  const levels = []
  for (const width of sizes) {
    await act(() => { inner.clientWidth = width; callbacks.forEach(run => run()) })
    levels.push(level)
  }
  assert.deepEqual(levels, [0, 1, 2, 3, 4, 5, 0])
  await act(() => { elements['.gui-composer-model .gui-mode-text'].width = 250; callbacks.forEach(run => run()) })
  assert.ok(level > 0, 'the same pane width needs a different fit when the model name grows')
  await act(() => { elements['.gui-composer-model .gui-mode-text'].width = 76; callbacks.forEach(run => run()) })
  assert.equal(level, 0)
  await act(() => tree.unmount())
  inner.clientWidth = 320
  callbacks.forEach(run => run())
  assert.equal(level, 0, 'retired observers do not update an unmounted composer')
})

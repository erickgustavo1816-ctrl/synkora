import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { buildSync } from 'esbuild'

const windows = []
class Window extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.dead = false
    this.shown = 0
    this.focused = 0
    this.webContents = { isDestroyed: () => this.dead }
    windows.push(this)
  }
  isDestroyed() { return this.dead }
  setMenu(menu) { this.menu = menu }
  show() { this.shown++ }
  focus() { this.focused++ }
  destroy() { this.dead = true; this.emit('closed') }
}
const compiled = buildSync({ entryPoints: ['src/main/browserDevtoolsWindow.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].text
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled)(() => ({ BrowserWindow: Window }), module, module.exports)
const { toggleBrowserDevtoolsWindow: toggle } = module.exports

function page() {
  const wc = new EventEmitter()
  wc.dead = false
  wc.closes = 0
  wc.isDestroyed = () => wc.dead
  // Electron reports false for an externally hosted DevTools frontend.
  wc.isDevToolsOpened = () => false
  wc.setDevToolsWebContents = frontend => { wc.devToolsWebContents = frontend }
  wc.openDevTools = options => { wc.options = options }
  wc.closeDevTools = () => { wc.closes++; wc.emit('devtools-closed') }
  return wc
}

test('DevTools belong to the browser owner and appear only after native initialization', () => {
  const owner = new Window(), wc = page()
  toggle(wc, owner)
  const inspector = windows.at(-1)
  assert.notEqual(inspector, owner)
  assert.equal(inspector.options.parent, owner)
  assert.equal(inspector.options.modal, false)
  assert.equal(inspector.options.alwaysOnTop, false)
  assert.equal(inspector.options.webPreferences.sandbox, true)
  assert.equal(inspector.options.webPreferences.nodeIntegration, false)
  assert.equal(inspector.options.webPreferences.preload, undefined)
  assert.equal(wc.devToolsWebContents, inspector.webContents)
  assert.deepEqual(wc.options, { mode: 'detach', activate: true })
  assert.equal(inspector.shown, 0)
  wc.emit('devtools-opened')
  assert.equal(inspector.shown, 1)
  assert.equal(inspector.focused, 1)
  owner.emit('focus')
  assert.equal(inspector.focused, 1, 'parent ownership maintains order without a loop stealing focus')
  toggle(wc, owner)
  assert.equal(inspector.dead, true)
  assert.equal(wc.dead, false)
})

test('toggle closes the owned frontend even though native isDevToolsOpened is false', () => {
  const owner = new Window(), wc = page()
  toggle(wc, owner)
  const first = windows.at(-1)
  toggle(wc, owner)
  assert.equal(first.dead, true)
  assert.equal(wc.closes, 1)
  wc.emit('devtools-opened')
  assert.equal(first.shown, 0, 'cancelled initialization must not revive a window')
  toggle(wc, owner)
  const second = windows.at(-1)
  assert.notEqual(second, first)
  wc.emit('devtools-opened')
  assert.equal(second.shown, 1)
  assert.equal(first.shown, 0)
  toggle(wc, owner)
})

test('closing the inspector keeps the page alive and removes opening listeners', () => {
  const owner = new Window(), wc = page()
  toggle(wc, owner)
  windows.at(-1).destroy()
  assert.equal(wc.closes, 1)
  assert.equal(wc.dead, false)
  for (const event of ['devtools-opened', 'devtools-closed', 'destroyed']) assert.equal(wc.listenerCount(event), 0)
  toggle(wc, owner)
  assert.equal(windows.at(-1).dead, false)
  toggle(wc, owner)
})

test('destroying the inspected page releases its inspector without calling the dead page', () => {
  const owner = new Window(), wc = page()
  toggle(wc, owner)
  const inspector = windows.at(-1)
  wc.dead = true
  wc.emit('destroyed')
  assert.equal(inspector.dead, true)
  assert.equal(wc.closes, 0)
  wc.emit('devtools-opened')
  assert.equal(inspector.shown, 0)
})

test('each page has its own inspector and a failed opening cleans up for retry', () => {
  const dock = new Window(), popout = new Window(), first = page(), second = page()
  toggle(first, dock)
  const a = windows.at(-1)
  toggle(second, popout)
  const b = windows.at(-1)
  assert.equal(a.options.parent, dock)
  assert.equal(b.options.parent, popout)
  toggle(first, dock)
  assert.equal(a.dead, true)
  assert.equal(b.dead, false)
  first.openDevTools = () => { throw new Error('synthetic opening failure') }
  assert.throws(() => toggle(first, dock), /synthetic opening failure/)
  assert.equal(windows.at(-1).dead, true)
  assert.equal(first.listenerCount('devtools-opened'), 0)
  first.openDevTools = () => {}
  toggle(first, dock)
  assert.equal(windows.at(-1).dead, false)
  toggle(first, dock)
  toggle(second, popout)
})

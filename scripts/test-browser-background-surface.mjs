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
    this.children = []
    const owner = this
    this.contentView = {
      get children() { return owner.children },
      addChildView: view => {
        if (view.parent) view.parent.children = view.parent.children.filter(child => child !== view)
        view.parent = this
        this.children.push(view)
      },
      removeChildView: view => {
        this.children = this.children.filter(child => child !== view)
        view.parent = null
        view.detaches++
      }
    }
    windows.push(this)
  }
  isDestroyed() { return this.dead }
  getBounds() { return { x: 0, y: 0, width: 1000, height: 800 } }
  setIgnoreMouseEvents(value) { this.ignoresMouse = value }
  showInactive() { this.shownWithoutFocus = true }
  destroy() { this.dead = true; this.emit('closed') }
}
function view() {
  const webContents = new EventEmitter()
  webContents.dead = false
  webContents.isDestroyed = () => webContents.dead
  webContents.destroy = () => { webContents.dead = true; webContents.emit('destroyed') }
  return { webContents, visible: false, detaches: 0, parent: null,
    setBounds(bounds) { this.bounds = bounds }, setVisible(value) { this.visible = value } }
}
const compiled = buildSync({ entryPoints: ['src/main/browserBackgroundSurface.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron'], write: false }).outputFiles[0].text
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled)(() => ({ BrowserWindow: Window,
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0 } }) } }), module, module.exports)
const { createBrowserBackgroundSurface, attachBrowserSurface, detachBrowserSurface, browserSurfaceOwner } = module.exports

test('unseen identities share one composing surface without appearing or taking input', () => {
  const app = new Window(), factory = createBrowserBackgroundSurface(() => app)
  const first = view(), second = view()
  const a = factory.wrap(first), b = factory.wrap(second)
  attachBrowserSurface(app, a)
  attachBrowserSurface(app, b)
  a.setBounds({ x: 350, y: 60, width: 600, height: 400 })
  b.setBounds({ x: 350, y: 60, width: 375, height: 400 })
  const carrier = first.parent
  assert.notEqual(carrier, app)
  assert.equal(second.parent, carrier)
  assert.equal(a.getVisible(), false)
  assert.equal(b.getVisible(), false)
  assert.equal(first.visible, true, 'native surface composes before the tab is ever displayed')
  assert.equal(second.visible, true)
  assert.deepEqual(first.bounds, { x: 0, y: 0, width: 600, height: 400 })
  assert.deepEqual(second.bounds, { x: 0, y: 0, width: 375, height: 400 })
  assert.equal(carrier.options.opacity, 0)
  assert.equal(carrier.options.focusable, false)
  assert.equal(carrier.options.skipTaskbar, true)
  assert.equal(carrier.ignoresMouse, true)
  assert.equal(carrier.shownWithoutFocus, true)
  first.webContents.destroy()
  assert.equal(carrier.dead, false, 'another identity is still using it')
  second.webContents.destroy()
  assert.equal(carrier.dead, true, 'closing the final tab releases the carrier')
  assert.equal(app.dead, false)
})

test('dock and pop-out restore the same page and bounds without detaching live tabs', () => {
  const app = new Window(), popout = new Window(), factory = createBrowserBackgroundSurface(() => app)
  const native = view(), tab = factory.wrap(native)
  attachBrowserSurface(app, tab)
  const carrier = native.parent
  assert.equal(browserSurfaceOwner(tab), app, 'hidden tabs keep their logical owner for DevTools')
  const rect = { x: 100, y: 80, width: 600, height: 400 }
  tab.setBounds(rect)
  tab.setVisible(true)
  assert.equal(native.parent, app)
  assert.deepEqual(native.bounds, rect)
  assert.equal(tab.webContents, native.webContents)
  attachBrowserSurface(popout, tab)
  assert.equal(browserSurfaceOwner(tab), popout)
  assert.equal(native.parent, popout)
  tab.setVisible(false)
  assert.equal(native.parent, carrier)
  assert.equal(browserSurfaceOwner(tab), popout, 'the hidden rendering carrier never owns DevTools')
  attachBrowserSurface(app, tab)
  assert.equal(native.parent, carrier, 'redocking hidden content does not expose it')
  tab.setVisible(true)
  assert.equal(native.parent, app)
  assert.equal(native.detaches, 0)
  detachBrowserSurface(app, tab)
  assert.equal(native.parent, null)
  assert.equal(browserSurfaceOwner(tab), null)
  assert.equal(native.detaches, 1, 'detach belongs only to teardown')
  native.webContents.destroy()
  assert.equal(carrier.dead, true)
})

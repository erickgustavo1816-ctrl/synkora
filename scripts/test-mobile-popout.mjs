import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: ['src/main/mobilePopoutWindow.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] })
const loaded = { exports: {} }
class FakeWindow extends EventEmitter {
  static all = []
  constructor(options) {
    super(); this.options = options; this.bounds = { x: 30, y: 20, width: options.width, height: options.height }
    this.destroyed = false; this.visible = false; this.minimized = false
    this.webContents = new EventEmitter(); this.webContents.id = FakeWindow.all.length + 10
    this.webContents.mainFrame = { url: '' }; this.webContents.isDestroyed = () => this.destroyed
    this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn }
    this.webContents.send = (...args) => { this.sent ??= []; this.sent.push(args) }
    this.webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }
    FakeWindow.all.push(this)
  }
  async loadURL(url) { this.webContents.mainFrame.url = url }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return this.minimized }
  restore() { this.minimized = false; this.emit('restore') }
  show() { this.visible = true; this.emit('show') }
  focus() {}
  setAlwaysOnTop(flag, level) { this.alwaysOnTop = { flag, level } }
  destroy() { this.destroyed = true; this.emit('closed') }
  getBounds() { return this.bounds }
  getContentSize() { return [this.bounds.width, this.bounds.height] }
  setContentSize(width, height) { this.bounds.width = width; this.bounds.height = height }
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y }
}
new Function('require', 'module', 'exports', built.outputFiles[0].text)(() => ({ BrowserWindow: FakeWindow,
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) } }), loaded, loaded.exports)
const { MobilePopoutWindows } = loaded.exports
const binding = { windowId: '12345678-1234-1234-1234-123456789abc', missionId: 'mission-a', projectId: 'project-a', sessionId: 'session-a', platform: 'android' }
function fixture() {
  const calls = [], bindings = new Map([[binding.windowId, binding]])
  const windows = new MobilePopoutWindows({ preloadFile: '/synthetic/preload.js',
    rendererUrl: id => `file:///synthetic/index.html?view=mobile-phone&windowId=${id}`,
    trustedUrl: (url, id) => url === `file:///synthetic/index.html?view=mobile-phone&windowId=${id}`,
    ownerBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }), binding: id => bindings.get(id),
    onDock: id => calls.push(['dock', id]), onVisibility: id => calls.push(['visibility', id]),
    onInvalidated: sender => calls.push(['invalidated', sender]) })
  return { windows, calls, bindings }
}
test('phone windows are independent, transparent, nonresizable and expose only the scoped preload flag', async () => {
  const f = fixture(), handle = await f.windows.create(binding), win = FakeWindow.all.at(-1)
  await handle.ready
  assert.equal(win.options.transparent, true); assert.equal(win.options.frame, false)
  assert.equal(win.options.resizable, false); assert.equal(win.options.maximizable, false); assert.equal(win.options.fullscreenable, false)
  assert.equal(win.options.parent, undefined)
  assert.equal(win.options.alwaysOnTop, true); assert.deepEqual(win.alwaysOnTop, { flag: true, level: 'floating' })
  assert.deepEqual(win.options.webPreferences.additionalArguments, ['--mobile-phone'])
  assert.equal(win.options.webPreferences.sandbox, true); assert.equal(win.options.webPreferences.nodeIntegration, false)
  handle.focus(); assert.equal(win.visible, true)
  f.windows.broadcast('mobile:phone:calibrationChanged'); assert.deepEqual(win.sent.at(-1), ['mobile:phone:calibrationChanged'])
  const result = handle.resize({ width: 2400, height: 4000 })
  assert.deepEqual(result, { width: 1000, height: 800, clamped: true })
  assert.equal(win.bounds.x >= 0 && win.bounds.y >= 0, true)
  assert.deepEqual(win.openHandler({ url: 'https://example.invalid' }), { action: 'deny' })
})
test('membership requires the actual WebContents, its main frame and the exact trusted URL', async () => {
  const f = fixture(), handle = await f.windows.create(binding), win = FakeWindow.all.at(-1)
  await handle.ready
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  assert.equal(f.windows.resolve(event).binding.sessionId, binding.sessionId)
  assert.throws(() => f.windows.resolve({ ...event, senderFrame: { url: event.senderFrame.url } }))
  assert.throws(() => f.windows.resolve({ ...event, sender: { ...win.webContents } }))
  const original = event.senderFrame.url
  for (const url of [original + '#other', original.replace('session', 'foreign') + '&missionId=other', 'https://example.invalid']) {
    event.senderFrame.url = url; assert.throws(() => f.windows.resolve(event))
  }
  event.senderFrame.url = original; f.bindings.delete(binding.windowId)
  assert.throws(() => f.windows.resolve(event))
  f.bindings.set(binding.windowId, binding); handle.destroy()
  assert.throws(() => f.windows.resolve(event))
})
test('X requests redock while renderer loss revokes membership synchronously', async () => {
  const f = fixture(); const handle = f.windows.create(binding); await handle.ready; const win = FakeWindow.all.at(-1)
  let prevented = false
  win.emit('close', { preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.deepEqual(f.calls.at(-1), ['dock', binding.windowId])
  win.webContents.emit('render-process-gone')
  assert.throws(() => f.windows.resolve({ sender: win.webContents, senderFrame: win.webContents.mainFrame }))
  assert.equal(f.calls.some(call => call[0] === 'invalidated'), true)
})

test('external native destruction never reads BrowserWindow.webContents after closed', async () => {
  const f = fixture(), handle = f.windows.create(binding), win = FakeWindow.all.at(-1)
  await handle.ready
  const contents = win.webContents
  Object.defineProperty(win, 'webContents', { get() { if (win.destroyed) throw new Error('Object has been destroyed'); return contents } })
  assert.doesNotThrow(() => win.destroy())
  assert.equal(f.calls.filter(call => call[0] === 'invalidated').length, 1)
  assert.equal(f.calls.filter(call => call[0] === 'dock').length, 1)
  assert.throws(() => f.windows.resolve({ sender: contents, senderFrame: contents.mainFrame }))
})

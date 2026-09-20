import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: ['src/main/browserReferencePicker.ts'], bundle: true, platform: 'node', format: 'cjs', write: false })
const module = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { installBrowserReferencePicker } = module.exports
const tick = () => new Promise(resolve => setImmediate(resolve))
const viewport = width => ({ width, height: 700, devicePixelRatio: 1, scrollX: 0, scrollY: 0 })

async function bench(t, prepareOverride) {
  class Debugger extends EventEmitter {
    attached = false
    binding = ''
    attach() { this.attached = true }
    isAttached() { return this.attached }
    detach() { this.attached = false; this.emit('detach', {}, 'closed') }
    async sendCommand(method, args) {
      if (method === 'Runtime.enable') this.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'devtools://devtools', auxData: { isDefault: true } } })
      if (method === 'Runtime.addBinding') this.binding = args.name
      return {}
    }
    emitBinding(payload, context = 1) { this.emit('message', {}, 'Runtime.bindingCalled', { executionContextId: context, name: this.binding, payload: JSON.stringify(payload) }) }
  }
  const frontend = { debugger: new Debugger(), isDestroyed: () => false, executeJavaScript: async () => true }
  const page = Object.assign(new EventEmitter(), {
    devToolsWebContents: frontend, isDestroyed: () => false, isDevToolsOpened: () => false,
    executeJavaScript: async () => ({ url: 'https://synthetic.test/', viewport: viewport(375) })
  })
  const captures = [], errors = []
  let prepared = 0
  const dispose = installBrowserReferencePicker(page, {
    prepare: () => { prepared++; return prepareOverride ? prepareOverride() : snapshot => { captures.push(snapshot); return { ok: true } } },
    onError: error => errors.push(error)
  })
  t.after(dispose)
  page.emit('devtools-opened')
  await tick()
  const start = id => frontend.debugger.emitBinding({ type: 'start', id: String(id), backendNodeId: Number(id) })
  const snapshot = id => frontend.debugger.emitBinding({ type: 'snapshot', id: String(id), backendNodeId: Number(id), frameId: 'synthetic-frame', value: {
    topFrame: true, frameUrl: 'https://synthetic.test/', frameViewport: viewport(375),
    element: { tag: 'h1', selector: '#title-' + id, text: 'Título sintético', bounds: { x: 10, y: 20, width: 150, height: 30 } }
  } })
  return { page, frontend, captures, errors, start, snapshot, dispose, prepared: () => prepared }
}

test('navigation during an asynchronous selection refuses stale capture with visible feedback', async t => {
  const b = await bench(t)
  let resolveTop
  b.page.executeJavaScript = () => new Promise(resolve => { resolveTop = resolve })
  b.start(1)
  b.page.emit('did-navigate')
  b.snapshot(1)
  resolveTop({ url: 'https://synthetic.test/new', viewport: viewport(1280) })
  await tick()
  assert.equal(b.captures.length, 0)
  assert.equal(b.errors.length, 1)
  assert.match(b.errors[0], /novamente/)
})

test('quick consecutive selections retain click order despite out-of-order DOM responses', async t => {
  const b = await bench(t)
  b.start(1); b.start(2)
  b.snapshot(2)
  await tick()
  assert.equal(b.captures.length, 0)
  b.snapshot(1)
  await tick()
  assert.deepEqual(b.captures.map(snapshot => snapshot.element.selector), ['#title-1', '#title-2'])
})

test('only the trusted DevTools main context can start a capture and no target never redirects it', async t => {
  const b = await bench(t, () => undefined)
  b.frontend.debugger.emitBinding({ type: 'start', id: '1', backendNodeId: 1 }, 99)
  assert.equal(b.prepared(), 0)
  b.start(1); b.snapshot(1)
  await tick()
  assert.equal(b.prepared(), 1)
  assert.equal(b.captures.length, 0)
  assert.match(b.errors[0], /chat desta missão/)
})

test('closing and reopening DevTools removes the previous bridge and does not duplicate captures', async t => {
  const b = await bench(t)
  const oldBinding = b.frontend.debugger.binding
  b.start(1)
  b.page.emit('devtools-closed')
  assert.equal(b.frontend.debugger.isAttached(), false)
  assert.equal(b.frontend.debugger.listenerCount('message'), 0)
  b.page.emit('devtools-opened')
  await tick()
  assert.notEqual(b.frontend.debugger.binding, oldBinding)
  b.start(1); b.snapshot(1)
  await tick()
  assert.equal(b.captures.length, 1)
  b.dispose()
  assert.equal(b.frontend.debugger.listenerCount('message'), 0)
  assert.equal(b.page.listenerCount('devtools-opened'), 0)
})

test('an incompatible native inspector fails visibly and releases its debugger', async t => {
  const b = await bench(t)
  b.page.emit('devtools-closed')
  b.frontend.executeJavaScript = async () => { throw new Error('synthetic unsupported native API') }
  b.page.emit('devtools-opened')
  await tick()
  assert.equal(b.captures.length, 0)
  assert.match(b.errors[0], /Feche e abra as DevTools/)
  assert.equal(b.frontend.debugger.isAttached(), false)
})

test('closing an owned DevTools window releases references without a false connection error', async t => {
  const b = await bench(t)
  b.start(1)
  b.frontend.debugger.emit('detach', {}, 'target closed')
  b.snapshot(1)
  await tick()
  assert.equal(b.errors.length, 0)
  assert.equal(b.captures.length, 0)
  assert.equal(b.frontend.debugger.listenerCount('message'), 0)
})

test('unexpected debugger detachment is visible with an externally hosted inspector', async t => {
  const b = await bench(t)
  assert.equal(b.page.isDevToolsOpened(), false)
  b.frontend.debugger.emit('detach', {}, 'replaced_with_devtools')
  assert.equal(b.errors.length, 1)
  assert.match(b.errors[0], /Feche e abra as DevTools/)
})

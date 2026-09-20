import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { buildSync } from 'esbuild'

function load(entry) {
  const built = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
  return loaded.exports
}
const { MobileMonitorScaleDetector, parseDarwinMonitorSamples } = load('src/main/mobileMonitorScale.ts')
const { createMobileMonitorReader } = load('src/main/mobileMonitorWindow.ts')
const { mobileMonitorPixelsPerMm } = load('src/renderer/src/mobileCalibration.ts')
const bounds = { x: 0, y: 0, width: 1512, height: 982 }
const sample = (patch = {}) => ({ displayId: 41, boundsDip: bounds, widthMm: 302.4, heightMm: 196.4,
  rotation: 0, active: true, mirrored: false, ...patch })
const expected = (patch = {}) => ({ displayId: 41, boundsDip: bounds, widthMm: 302.4, heightMm: 196.4,
  source: 'coregraphics', confidence: 'reported', ...patch })
const wire = (...rows) => JSON.stringify(rows)
const context = (patch = {}) => ({ platform: 'darwin', displayId: 41, displayBounds: bounds,
  scaleFactor: 2, centerPx: { x: 756, y: 491 }, ...patch })

test('darwin detector obtains physical metadata and retains generation caching', async () => {
  let calls = 0, now = 0
  const detector = new MobileMonitorScaleDetector({ platform: 'darwin', now: () => now,
    runHelper: async () => { calls++; return wire(sample()) } })
  const result = await detector.read()
  assert.deepEqual(result, [expected()])
  result[0].boundsDip.width = 1
  assert.deepEqual(await detector.read(), [expected()]); assert.equal(calls, 1)
  now = 60000
  await detector.read(); assert.equal(calls, 2)
})

test('CoreGraphics parser returns only bounded display geometry and physical millimeters', () => {
  assert.deepEqual(parseDarwinMonitorSamples(wire(sample({ serial: 'private', hardwareName: 'private' }))), [expected()])
  const external = sample({ displayId: 42, boundsDip: { x: -1920, y: 0, width: 1920, height: 1080 }, widthMm: 530, heightMm: 298.125 })
  assert.equal(parseDarwinMonitorSamples(wire(sample(), external)).length, 2)
})

test('CoreGraphics physical dimensions rotate only with verified orthogonal orientation', () => {
  const portrait = { x: -982, y: 0, width: 982, height: 1512 }
  for (const rotation of [90, 270]) assert.deepEqual(parseDarwinMonitorSamples(wire(sample({ rotation, boundsDip: portrait }))),
    [expected({ boundsDip: portrait, widthMm: 196.4, heightMm: 302.4 })])
  assert.deepEqual(parseDarwinMonitorSamples(wire(sample({ rotation: 180 }))), [expected()])
  assert.deepEqual(parseDarwinMonitorSamples(wire(sample({ boundsDip: portrait }))), [])
})

test('CoreGraphics inferred 72 dpi fallback never masquerades as reported physical size', () => {
  for (const dpi of [72, 2.835 * 25.4]) {
    assert.deepEqual(parseDarwinMonitorSamples(wire(sample({ widthMm: bounds.width * 25.4 / dpi, heightMm: bounds.height * 25.4 / dpi }))), [])
  }
  assert.deepEqual(parseDarwinMonitorSamples(wire(sample({ widthMm: 0, heightMm: 0 }))), [])
})

test('CoreGraphics rejects stale IDs, mirrored displays, bad units and unbounded helper data', () => {
  for (const patch of [{ displayId: 0 }, { displayId: -1 }, { displayId: 1.5 }, { displayId: 2 ** 32 },
    { active: false }, { active: 1 }, { mirrored: true }, { mirrored: undefined }, { rotation: 45 },
    { widthMm: NaN }, { heightMm: 16 }, { widthMm: 4000 }, { heightMm: 100 },
    { boundsDip: { ...bounds, width: 0 } }, { boundsDip: { ...bounds, x: 1.5 } }, { boundsDip: { ...bounds, x: 1000001 } }]) {
    assert.deepEqual(parseDarwinMonitorSamples(wire(sample(patch))), [])
  }
  for (const rows of [[sample(), sample()], [sample(), sample({ displayId: 42 })],
    [sample(), sample({ boundsDip: { ...bounds, x: 1512 } })]]) assert.deepEqual(parseDarwinMonitorSamples(wire(...rows)), [])
  for (const bad of ['{}', 'null', 'not-json', ' '.repeat(65537), wire(...Array.from({ length: 33 }, () => sample()))]) {
    assert.deepEqual(parseDarwinMonitorSamples(bad), [])
  }
})

test('Retina and scaled modes use render backing pixels, not the panel native resolution', async () => {
  for (const width of [1512, 1890]) {
    const displayBounds = { ...bounds, width, height: width * 982 / 1512 }
    const row = expected({ boundsDip: displayBounds })
    const read = createMobileMonitorReader({ current: () => context({ displayBounds }), read: async () => [row] })
    const scale = await read()
    assert.ok(scale)
    assert.equal(scale.physicalPixelsPerMm, width * 2 / 302.4)
    for (const zoom of [1, 1.25]) {
      const cssScale = mobileMonitorPixelsPerMm(scale, { width, height: displayBounds.height, left: 0, top: 0, pixelRatio: 2, viewportScale: zoom })
      assert.equal(cssScale, width / 302.4 / zoom)
    }
  }
})

test('macOS reader binds exact current window ID and DIP bounds, rejecting ambiguity or cross-platform rows', async () => {
  for (const rows of [[], [expected({ displayId: 42 })], [expected(), expected()],
    [expected({ boundsDip: { ...bounds, x: 1 } })], [expected({ boundsDip: { ...bounds, width: 1511 } })],
    [expected({ widthMm: 0 })], [expected({ heightMm: 100 })], [expected({ source: 'guessed' })]]) {
    assert.equal(await createMobileMonitorReader({ current: context, read: async () => rows })(), null)
  }
  assert.equal(await createMobileMonitorReader({ current: () => context({ platform: 'win32' }), read: async () => [expected()] })(), null)
  let current = context(), done
  const pending = createMobileMonitorReader({ current: () => current, read: () => new Promise(resolve => { done = resolve }) })()
  current = context({ displayId: 42 })
  done([expected()]); assert.equal(await pending, null)
})

test('darwin invalidation revokes old helper results before they can repopulate cache', async () => {
  const gates = [], signals = []
  const detector = new MobileMonitorScaleDetector({ platform: 'darwin', runHelper: signal => {
    signals.push(signal); return new Promise(resolve => gates.push(resolve))
  } })
  const old = detector.read()
  detector.invalidate()
  assert.equal(signals[0].aborted, true)
  const next = detector.read()
  gates[1](wire(sample({ displayId: 42 })))
  assert.deepEqual(await next, [expected({ displayId: 42 })])
  gates[0](wire(sample())); assert.deepEqual(await old, [])
  assert.deepEqual(await detector.read(), [expected({ displayId: 42 })])
})

function childFixture() {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => { child.killed = true; child.emit('close', null); return true }
  return child
}

test('darwin helper is fixed read-only JXA with no shell, paths or IDs supplied by renderer', async () => {
  const calls = [], child = childFixture()
  const detector = new MobileMonitorScaleDetector({ platform: 'darwin', spawnProcess: (...args) => {
    calls.push(args)
    queueMicrotask(() => { child.stderr.write('private'); child.stdout.write(wire(sample())); child.emit('close', 0) })
    return child
  } })
  assert.deepEqual(await detector.read(), [expected()])
  const [executable, args, options] = calls[0]
  assert.equal(executable, '/usr/bin/osascript')
  assert.deepEqual(args.slice(0, -1), ['-l', 'JavaScript', '-e'])
  for (const symbol of ['NSScreen', 'NSScreenNumber', 'CGDisplayBounds', 'CGDisplayScreenSize', 'CGDisplayRotation', 'CGDisplayIsActive', 'CGDisplayIsInMirrorSet']) assert.ok(args.at(-1).includes(symbol), symbol)
  assert.doesNotMatch(args.at(-1), /Application\(|doShellScript|readFile|System Events|CGDisplayCreateImage/u)
  assert.equal(options.shell, false); assert.equal(options.cwd, '/')
  assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'PATH'])
})

test('darwin helper overflow, error and timeout stop only its child and suppress raw output', async () => {
  for (const mode of ['overflow', 'error', 'nonzero', 'timeout']) {
    const child = childFixture()
    const detector = new MobileMonitorScaleDetector({ platform: 'darwin', timeoutMs: 10, spawnProcess: () => {
      queueMicrotask(() => {
        if (mode === 'overflow') child.stdout.write('x'.repeat(65537))
        if (mode === 'error') child.emit('error', new Error('private'))
        if (mode === 'nonzero') { child.stdout.write(wire(sample())); child.emit('close', 1) }
      })
      return child
    } })
    assert.deepEqual(await detector.read(), [])
    if (mode !== 'nonzero') assert.equal(child.killed, true)
  }
})

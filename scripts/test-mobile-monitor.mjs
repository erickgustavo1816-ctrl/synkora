import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: ['src/main/mobileMonitorScale.ts'], bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { MobileMonitorScaleDetector, parseMobileMonitorEdid, parseMobileMonitorSamples } = loaded.exports

function checksum(bytes) {
  bytes[127] = 0
  bytes[127] = (256 - bytes.subarray(0, 128).reduce((sum, value) => sum + value, 0) % 256) % 256
  return bytes
}

function edid({ widthMm = 531, heightMm = 299, widthPx = 1920, heightPx = 1080, basic = [53, 30], descriptor = 0, interlaced = false } = {}) {
  const bytes = Buffer.alloc(128)
  Buffer.from([0, 255, 255, 255, 255, 255, 255, 0]).copy(bytes)
  bytes[18] = 1; bytes[19] = 4; bytes[21] = basic[0]; bytes[22] = basic[1]
  if (descriptor !== null) {
    const offset = 54 + descriptor * 18
    bytes[offset] = 1
    bytes[offset + 2] = widthPx & 255; bytes[offset + 4] = (widthPx >> 8) << 4
    bytes[offset + 5] = heightPx & 255; bytes[offset + 7] = (heightPx >> 8) << 4
    bytes[offset + 12] = widthMm & 255; bytes[offset + 13] = heightMm & 255
    bytes[offset + 14] = ((widthMm >> 8) << 4) | (heightMm >> 8)
    if (interlaced) bytes[offset + 17] = 128
  }
  return checksum(bytes)
}

const reported = { widthMm: 531, heightMm: 299, source: 'edid-detailed', confidence: 'reported' }
const bounds = { x: -1920, y: 0, width: 1920, height: 1080 }
const sample = (patch = {}) => ({ boundsPx: bounds, rotation: 0, matchedInterfaces: 1, edid: edid().toString('base64'), ...patch })
const wire = (...samples) => JSON.stringify(samples)
const expected = (patch = {}) => ({ boundsPx: bounds, ...reported, ...patch })

test('EDID detailed timing decodes millimeters with high nibbles and skips non-timing descriptors', () => {
  assert.deepEqual(parseMobileMonitorEdid(edid()), reported)
  assert.deepEqual(parseMobileMonitorEdid(edid({ descriptor: 2 })), reported)
  assert.deepEqual(parseMobileMonitorEdid(edid({ widthMm: 1210, heightMm: 680, basic: [121, 68] })),
    { widthMm: 1210, heightMm: 680, source: 'edid-detailed', confidence: 'reported' })
  assert.deepEqual(parseMobileMonitorEdid(edid({ heightPx: 540, interlaced: true })), reported)
})

test('EDID rejects bad headers, checksums, version, truncation and oversized buffers', () => {
  const wrongHeader = edid(); wrongHeader[0] = 1; checksum(wrongHeader)
  const wrongChecksum = edid(); wrongChecksum[32] ^= 1
  const wrongVersion = edid(); wrongVersion[18] = 2; checksum(wrongVersion)
  for (const invalid of [wrongHeader, wrongChecksum, wrongVersion, Buffer.alloc(127), Buffer.alloc(129), Buffer.alloc(8192), undefined, 'not-bytes']) {
    assert.equal(parseMobileMonitorEdid(invalid), undefined)
  }
})

test('basic centimeters are estimated and missing dimensions never come from pixel resolution', () => {
  assert.deepEqual(parseMobileMonitorEdid(edid({ descriptor: null })),
    { widthMm: 530, heightMm: 300, source: 'edid-basic', confidence: 'estimated' })
  for (const options of [{ descriptor: null, basic: [0, 30] }, { descriptor: null, basic: [53, 0] },
    { widthMm: 0, heightMm: 0, basic: [0, 0] }, { widthMm: 16, heightMm: 9, basic: [0, 0] },
    { widthMm: 4095, heightMm: 299, basic: [0, 0] }]) assert.equal(parseMobileMonitorEdid(edid(options)), undefined)
})

test('non-square-pixel and letterboxed detailed sizes cannot overrule a plausible panel size', () => {
  assert.equal(parseMobileMonitorEdid(edid({ widthMm: 531, heightMm: 150, basic: [0, 0] })), undefined)
  assert.deepEqual(parseMobileMonitorEdid(edid({ widthMm: 424, heightMm: 239 })),
    { widthMm: 530, heightMm: 300, source: 'edid-basic', confidence: 'estimated' })
  const bytes = edid({ widthMm: 0, heightMm: 0, basic: [0, 0] })
  edid().subarray(54, 72).copy(bytes, 72)
  assert.deepEqual(parseMobileMonitorEdid(checksum(bytes)), reported)
})

test('mapping uses one active interface and declared rotation, returning only sanitized metrics', () => {
  assert.deepEqual(parseMobileMonitorSamples(wire(sample({ deviceId: 'synthetic-private', serial: 'synthetic-private' }))), [expected()])
  const portrait = { x: 0, y: -1920, width: 1080, height: 1920 }
  for (const rotation of [90, 270]) assert.deepEqual(parseMobileMonitorSamples(wire(sample({ rotation, boundsPx: portrait }))),
    [expected({ boundsPx: portrait, widthMm: 299, heightMm: 531 })])
  assert.deepEqual(parseMobileMonitorSamples(wire(sample({ rotation: 180 }))), [expected()])
  assert.deepEqual(parseMobileMonitorSamples(wire(sample({ boundsPx: portrait }))), [], 'orientation cannot be guessed from aspect')
})

test('mapping rejects ambiguity, invalid geometry, anisotropy and noncanonical payloads', () => {
  for (const patch of [{ matchedInterfaces: 0 }, { matchedInterfaces: 2 }, { matchedInterfaces: '1' },
    { rotation: 45 }, { rotation: undefined }, { edid: 'invalid' }, { edid: `${edid().toString('base64')}\n` },
    { boundsPx: { ...bounds, x: 0.5 } }, { boundsPx: { ...bounds, y: 1000001 } },
    { boundsPx: { ...bounds, width: 0 } }, { boundsPx: { ...bounds, height: 16384 } },
    { boundsPx: { ...bounds, width: 32769 } }, { boundsPx: { ...bounds, x: Infinity } }]) {
    assert.deepEqual(parseMobileMonitorSamples(wire(sample(patch))), [])
  }
  assert.deepEqual(parseMobileMonitorSamples(wire(sample(), sample())), [], 'overlapping/duplicate monitor rectangles are ambiguous')
  assert.deepEqual(parseMobileMonitorSamples(wire(...Array.from({ length: 33 }, () => sample()))), [])
  for (const invalid of ['not-json', '{}', ' '.repeat(65537), 'null']) assert.deepEqual(parseMobileMonitorSamples(invalid), [])
})

test('detector deduplicates a generation, caches for 60 seconds and protects cached objects', async () => {
  let calls = 0, now = 0, resolve
  const gate = new Promise(done => { resolve = done })
  const detector = new MobileMonitorScaleDetector({ platform: 'win32', now: () => now,
    runHelper: async () => { calls++; await gate; return wire(sample()) } })
  const first = detector.read(), second = detector.read()
  assert.equal(calls, 1)
  resolve()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, [expected()]); assert.deepEqual(b, [expected()])
  a[0].widthMm = 1; a[0].boundsPx.width = 1
  assert.deepEqual(await detector.read(), [expected()])
  now = 59999; await detector.read(); assert.equal(calls, 1)
  now = 60000; await detector.read(); assert.equal(calls, 2)
})

test('invalidation prevents old in-flight answers from publishing or refreshing the new cache', async () => {
  const gates = [], signals = []
  const detector = new MobileMonitorScaleDetector({ platform: 'win32', runHelper: signal => {
    signals.push(signal); return new Promise(resolve => gates.push(resolve))
  } })
  const old = detector.read()
  detector.invalidate()
  assert.equal(signals[0].aborted, true, 'a configuration change also stops the old owned helper')
  const current = detector.read()
  assert.equal(gates.length, 2)
  const moved = { ...bounds, x: 0 }
  gates[1](wire(sample({ boundsPx: moved })))
  assert.deepEqual(await current, [expected({ boundsPx: moved })])
  gates[0](wire(sample()))
  assert.deepEqual(await old, [])
  assert.deepEqual(await detector.read(), [expected({ boundsPx: moved })])
  const forced = detector.read(true)
  assert.equal(gates.length, 3)
  gates[2](wire(sample()))
  assert.deepEqual(await forced, [expected()])
})

test('unsupported systems, helper failures and timeout return no inferred monitor size', async () => {
  let calls = 0, aborted = false
  const absent = new MobileMonitorScaleDetector({ platform: 'linux', runHelper: async () => { calls++; return wire(sample()) } })
  assert.deepEqual(await absent.read(), []); assert.equal(calls, 0)
  const failed = new MobileMonitorScaleDetector({ platform: 'win32', runHelper: async () => { throw new Error('synthetic-private-metadata') } })
  assert.deepEqual(await failed.read(), [])
  const timeout = new MobileMonitorScaleDetector({ platform: 'win32', timeoutMs: 10, runHelper: signal => {
    signal.addEventListener('abort', () => { aborted = true }); return new Promise(() => {})
  } })
  assert.deepEqual(await timeout.read(), []); assert.equal(aborted, true)
})

function childFixture() {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = () => { child.killed = true; child.emit('close', null); return true }
  return child
}

test('native helper uses a fixed hidden PowerShell command and drains private stderr', async () => {
  const child = childFixture(), calls = []
  const detector = new MobileMonitorScaleDetector({ platform: 'win32', spawnProcess: (...args) => {
    calls.push(args)
    queueMicrotask(() => { child.stderr.write('synthetic-private-metadata'); child.stdout.write(wire(sample())); child.emit('close', 0) })
    return child
  } })
  assert.deepEqual(await detector.read(), [expected()])
  const [executable, args, options] = calls[0]
  assert.match(executable, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu)
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true)
  assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  const helper = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  for (const api of ['EnumDisplayMonitors', 'GetMonitorInfo', 'EnumDisplayDevices', 'SetupDiOpenDeviceInterface',
    'SetupDiGetDeviceInterfaceDetail', 'SetupDiOpenDevRegKey', 'SetThreadDpiAwarenessContext', 'EnumDisplaySettings']) assert.ok(helper.includes(api), api)
  assert.ok(helper.includes('EDID_OVERRIDE'))
  assert.ok(args.at(-1).length < 30000)
  assert.doesNotMatch(helper, /RegSetValue|Set-ItemProperty|Get-ChildItem|Get-CimInstance/u)
  assert.equal(options.env.NODE_OPTIONS, undefined)
})

test('helper output overflow, failure and timeout kill only its owned child and expose no raw data', async () => {
  for (const mode of ['overflow', 'error', 'nonzero', 'timeout']) {
    const child = childFixture()
    const detector = new MobileMonitorScaleDetector({ platform: 'win32', timeoutMs: 10, spawnProcess: () => {
      queueMicrotask(() => {
        if (mode === 'overflow') child.stdout.write('x'.repeat(65537))
        if (mode === 'error') child.emit('error', new Error('synthetic-private-error'))
        if (mode === 'nonzero') { child.stdout.write(wire(sample())); child.emit('close', 1) }
      })
      return child
    } })
    assert.deepEqual(await detector.read(), [])
    if (mode !== 'nonzero') assert.equal(child.killed, true)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const bundle = name => buildSync({ entryPoints: [resolve(`src/main/${name}.ts`)], bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', write: false, logLevel: 'silent' }).outputFiles[0].text
const transportSource = bundle('mobileInput')
const protocolSource = bundle('mobileInputProtocol')
function load(source, mocks = {}) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const protocol = load(protocolSource)
const ASSET = resolve('build/vendor/scrcpy/scrcpy-server-v4.1.jar')
const DIMENSIONS = { width: 1080, height: 2400 }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const event = (phase, x = 0.5, y = 0.25) => ({ phase, x, y })
const actions = socket => socket.writes.flatMap(bytes => Array.from({ length: bytes.length / 32 }, (_, i) => bytes[i * 32 + 1]))

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  writableLength = 0
  writes = []
  callbacks = []
  autoFlush = true
  backpressure = false
  noDelay = false
  paused = false
  setNoDelay(value) { this.noDelay = value; return this }
  pause() { this.paused = true; return this }
  resume() { this.paused = false; return this }
  write(bytes, callback) {
    assert.equal(this.destroyed, false)
    const copy = Buffer.from(bytes)
    this.writes.push(copy)
    this.writableLength += copy.length
    this.callbacks.push(() => { this.writableLength -= copy.length; callback() })
    if (this.autoFlush) queueMicrotask(() => this.finish())
    return !this.backpressure
  }
  finish() { this.callbacks.shift()?.() }
  destroy() {
    if (!this.destroyed) { this.destroyed = true; this.writable = false; queueMicrotask(() => this.emit('close')) }
    return this
  }
}

function harness(config = {}) {
  const calls = [], sockets = [], connects = [], closed = [], hashes = []
  const abort = new AbortController()
  let authorized = true, childAlive = true, exitResolve, targetChecks = 0, forward, stopResolve
  const exited = new Promise(resolveExit => { exitResolve = resolveExit })
  const child = {
    isAlive: () => childAlive,
    exited,
    stop: async () => {
      calls.push({ kind: 'stop' })
      if (config.holdStop) await new Promise(done => { stopResolve = done })
      childAlive = false; exitResolve(); return true
    }
  }
  const executor = {
    run: async command => {
      calls.push({ kind: 'run', ...command })
      await config.onRun?.(command, { revoke: () => { authorized = false }, abort })
      if (command.args.includes('push')) return { stdout: Buffer.alloc(0) }
      if (command.args.includes('tcp:0')) {
        forward = { serial: command.args[1], local: 'tcp:35123', remote: command.args.at(-1) }
        return { stdout: Buffer.from(config.portOutput ?? '35123\n') }
      }
      if (command.args.includes('--list')) {
        const rows = config.forwardList?.(forward) ?? (forward ? `${forward.serial} ${forward.local} ${forward.remote}\n` : '')
        return { stdout: Buffer.from(rows) }
      }
      if (command.args.includes('--remove')) forward = undefined
      return { stdout: Buffer.alloc(0) }
    },
    launch: async command => { calls.push({ kind: 'launch', ...command }); await config.onLaunch?.(); return child }
  }
  const crypto = require('node:crypto')
  const net = {
    createConnection: options => {
      connects.push(options)
      const socket = new FakeSocket()
      if (config.socket) Object.assign(socket, config.socket)
      sockets.push(socket)
      queueMicrotask(() => {
        if (config.connectFailure && sockets.length === 1) { socket.emit('error', new Error('synthetic')); return }
        socket.emit('connect')
        if (config.handshake !== false) socket.emit('data', Buffer.from(config.handshake ?? [0]))
      })
      return socket
    }
  }
  const input = load(transportSource, {
    'node:net': net,
    'node:crypto': { ...crypto, createHash: algorithm => {
      hashes.push(algorithm)
      const hash = crypto.createHash(algorithm)
      if (config.badHash) hash.digest = () => '0'.repeat(64)
      return hash
    } }
  })
  const options = {
    executable: resolve('synthetic-sdk/adb.exe'), serial: 'emulator-5580', serverPath: ASSET,
    executor, signal: abort.signal,
    assertCurrent: () => { if (!authorized) throw new Error('synthetic authority revoked') },
    verifyTarget: async () => { targetChecks++; await config.onVerify?.(targetChecks, abort) },
    onClosed: () => { closed.push(true); if (config.throwClosed) throw new Error('synthetic callback') }
  }
  return { input, options, calls, sockets, connects, closed, hashes, abort,
    get targetChecks() { return targetChecks },
    get socket() { return sockets.at(-1) },
    revoke: () => { authorized = false },
    exit: () => { childAlive = false; exitResolve() },
    releaseStop: () => stopResolve?.(),
    start: overrides => input.createMobileAndroidInput({ ...options, ...overrides }) }
}

test('official bundled 4.1 asset matches the protocol hash independently', async () => {
  const bytes = await readFile(ASSET)
  const input = load(transportSource)
  assert.equal(input.MOBILE_INPUT_SERVER_VERSION, '4.1')
  assert.equal(input.MOBILE_INPUT_SERVER_SHA256, 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), input.MOBILE_INPUT_SERVER_SHA256)
})

test('touch wire format is exactly scrcpy 4.1 big endian, finger zero, with native bounds', () => {
  const bytes = protocol.serializeMobileAndroidTouch(event('down'), DIMENSIONS)
  assert.equal(bytes.toString('hex'), '020000000000000000000000021c0000025804380960ffff0000000000000000')
  const edge = protocol.serializeMobileAndroidTouch(event('up', 1, 1), DIMENSIONS)
  assert.equal(edge.length, 32)
  assert.equal(edge.readInt32BE(10), 1079)
  assert.equal(edge.readInt32BE(14), 2399)
  assert.equal(edge.readUInt16BE(22), 0)
  assert.deepEqual(['down', 'up', 'move', 'cancel'].map(phase => protocol.serializeMobileAndroidTouch(event(phase), DIMENSIONS)[1]), [0, 1, 2, 3])
})

test('protocol rejects invalid phases, coordinates, dimensions and extra fields', () => {
  for (const value of [event('hover'), event('down', NaN), event('down', Infinity), event('down', -0.1), event('down', 1.1),
    { ...event('down'), text: 'not allowed' }, null]) {
    assert.throws(() => protocol.serializeMobileAndroidTouch(value, DIMENSIONS), /toque|gesto|tela/i)
  }
  for (const size of [{ width: 0, height: 1 }, { width: 8193, height: 1 }, { width: 1.5, height: 1 },
    { width: 8192, height: 8192 }, { width: NaN, height: 2 }, null]) {
    assert.throws(() => protocol.serializeMobileAndroidTouch(event('down'), size), /dimens|tela/i)
  }
})

test('startup rejects physical devices, invalid emulator ports and nonabsolute assets without effects', async () => {
  for (const overrides of [{ serial: 'R58M000000' }, { serial: 'emulator-5555' }, { serial: 'emulator-10' },
    { serial: 'emulator-65536' }, { serverPath: 'relative.jar' }, { executable: 'adb' }]) {
    const h = harness()
    await assert.rejects(h.start(overrides))
    assert.equal(h.calls.length, 0)
    assert.equal(h.connects.length, 0)
  }
})

test('hash is verified each initialization before any push or target effect', async () => {
  const h = harness({ badHash: true })
  await assert.rejects(h.start(), /integridade|verific|controle/i)
  assert.deepEqual(h.hashes, ['sha256'])
  assert.equal(h.calls.length, 0)
  assert.equal(h.connects.length, 0)
})

test('valid asset hashing is never cached between independent channels', async () => {
  const config = {}, h = harness(config)
  const first = await h.start()
  await first.close()
  const calls = h.calls.length
  config.badHash = true
  await assert.rejects(h.start())
  assert.deepEqual(h.hashes, ['sha256', 'sha256'])
  assert.equal(h.calls.length, calls)
})

test('startup pins serial, random SCID, private jar, owned ephemeral forward and control-only flags', async t => {
  const h = harness(), channel = await h.start()
  t.after(() => channel.close())
  const setup = h.calls.filter(call => call.kind !== 'stop' && !call.args.includes('--list'))
  assert.equal(setup.length, 3)
  assert.deepEqual(setup.map(call => call.args.slice(0, 2)), Array(3).fill(['-s', 'emulator-5580']))
  assert.equal(setup[0].args[2], 'push')
  assert.match(setup[0].args.at(-1), /^\/data\/local\/tmp\/synkora-input-[0-9a-f]{32}\.jar$/)
  assert.deepEqual(setup[1].args.slice(2, -1), ['forward', '--no-rebind', 'tcp:0'])
  assert.match(setup[1].args.at(-1), /^localabstract:scrcpy_[0-7][0-9a-f]{7}$/)
  const command = setup[2].args[3]
  for (const flag of ['video=false', 'audio=false', 'control=true', 'clipboard_autosync=false', 'power_on=false',
    'send_device_meta=false', 'tunnel_forward=true', 'send_dummy_byte=true', 'cleanup=true', 'log_level=error']) assert.ok(command.includes(`'${flag}'`), flag)
  assert.ok(command.includes("'com.genymobile.scrcpy.Server' '4.1'"))
  assert.ok(command.startsWith("'env' 'CLASSPATH=/data/local/tmp/synkora-input-"))
  assert.deepEqual(h.connects, [{ host: '127.0.0.1', port: 35123 }])
  assert.equal(h.socket.noDelay, true)
  assert.ok(h.targetChecks >= 4)
  assert.equal(channel.alive(), true)
})

test('authority is rechecked after every awaited startup verification', async () => {
  const h = harness({ onVerify: async (count, abort) => { if (count === 2) abort.abort() } })
  await assert.rejects(h.start())
  assert.equal(h.calls.filter(call => call.args?.includes('push')).length, 1)
  assert.equal(h.calls.filter(call => call.args?.includes('tcp:0')).length, 0)
  assert.equal(h.calls.filter(call => call.kind === 'launch').length, 0)
  assert.equal(h.connects.length, 0)
})

test('abort while launch resolves still stops that exact late child and cleans its forward', async () => {
  const h = harness({ onLaunch: async () => h.abort.abort() })
  await assert.rejects(h.start())
  assert.equal(h.calls.filter(call => call.kind === 'stop').length, 1)
  assert.equal(h.calls.filter(call => call.args?.includes('--remove')).length, 1)
  assert.equal(h.connects.length, 0)
})

test('aborted and revoked startup never reaches the device', async () => {
  const aborted = harness(); aborted.abort.abort()
  await assert.rejects(aborted.start())
  assert.equal(aborted.calls.length, 0)
  const revoked = harness(); revoked.revoke()
  await assert.rejects(revoked.start())
  assert.equal(revoked.calls.length, 0)
})

test('startup refuses a forward already rebound before the control connection', async () => {
  const h = harness({ forwardList: row => `${row.serial} ${row.local} localabstract:another-owner\n` })
  await assert.rejects(h.start())
  assert.equal(h.connects.length, 0)
  assert.equal(h.calls.filter(call => call.args?.includes('--remove')).length, 0)
})

test('nonzero or extra handshake bytes fail closed and clean only their forward', async () => {
  for (const handshake of [[1], [0, 0]]) {
    const h = harness({ handshake })
    await assert.rejects(h.start(), /controle|conexão|conexao/i)
    assert.equal(h.connects.length, 1)
    assert.equal(h.socket.writes.length, 0)
    assert.ok(h.calls.some(call => call.args?.includes('--remove')))
    assert.equal(h.closed.length, 1)
  }
})

test('one startup connection refusal may retry, but ready channels never reconnect', async t => {
  const h = harness({ connectFailure: true }), channel = await h.start()
  t.after(() => channel.close())
  assert.equal(h.connects.length, 2)
  h.socket.emit('error', new Error('synthetic disconnect'))
  await tick()
  assert.equal(channel.alive(), false)
  assert.equal(h.connects.length, 2)
  assert.equal(h.closed.length, 1)
})

test('only a single active gesture exists and flush releases a completed gesture', async t => {
  const h = harness(), channel = await h.start()
  t.after(() => channel.close())
  assert.throws(() => channel.touch(event('move'), DIMENSIONS), /gesto|toque/i)
  assert.throws(() => channel.touch(event('up'), DIMENSIONS), /gesto|toque/i)
  channel.touch(event('down'), DIMENSIONS)
  assert.throws(() => channel.touch(event('down'), DIMENSIONS), /gesto|toque/i)
  channel.touch(event('up'), DIMENSIONS)
  await channel.flush()
  channel.touch(event('down'), DIMENSIONS)
  channel.touch(event('up'), DIMENSIONS)
  await channel.flush()
  assert.deepEqual(actions(h.socket), [0, 1, 0, 1])
})

test('thousands of pending MOVE events coalesce to one latest position', async t => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  t.after(async () => { h.socket.autoFlush = true; h.socket.finish(); await channel.close() })
  channel.touch(event('down'), DIMENSIONS)
  for (let i = 0; i < 5000; i++) channel.touch(event('move', i / 5000, 0.9), DIMENSIONS)
  assert.equal(h.socket.writes.length, 1)
  assert.equal(h.socket.writableLength, 32)
  h.socket.finish()
  assert.equal(h.socket.writes.length, 2)
  assert.equal(h.socket.writes[1].readInt32BE(10), 1079)
  h.socket.finish()
  channel.touch(event('up'), DIMENSIONS)
  h.socket.finish()
  await channel.flush()
  assert.deepEqual(actions(h.socket), [0, 2, 1])
})

test('UP reserves the final MOVE and UP together, refusing another DOWN until drained', async t => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  t.after(() => channel.close())
  channel.touch(event('down'), DIMENSIONS)
  channel.touch(event('move', 0.9, 0.9), DIMENSIONS)
  channel.touch(event('up', 0.8, 0.8), DIMENSIONS)
  assert.throws(() => channel.touch(event('down'), DIMENSIONS), /gesto|toque/i)
  h.socket.finish()
  assert.deepEqual(actions(h.socket), [0, 2, 1])
  assert.equal(h.socket.writes[1].length, 64)
  assert.equal(h.socket.writes[1].readInt32BE(10), 972)
  assert.equal(h.socket.writes[1].readInt32BE(42), 864)
  let flushed = false
  const flushing = channel.flush().then(() => { flushed = true })
  await tick(); assert.equal(flushed, false)
  h.socket.finish(); await flushing
  assert.equal(flushed, true)
})

test('a completed flick queued during DOWN setup still contains ACTION_MOVE before UP', async t => {
  const h = harness(), channel = await h.start()
  t.after(() => channel.close())
  channel.touch(event('down', 0.1, 0.1), DIMENSIONS)
  channel.touch(event('move', 0.9, 0.9), DIMENSIONS)
  channel.touch(event('up', 0.9, 0.9), DIMENSIONS)
  await channel.flush()
  assert.deepEqual(actions(h.socket), [0, 2, 1])
  assert.equal(h.socket.writes.at(-1).readInt32BE(10), 972)
})

test('flush waiters have a fixed bound independently of queued event count', async t => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  t.after(() => channel.close())
  channel.touch(event('down'), DIMENSIONS)
  const waiting = Array.from({ length: h.input.MOBILE_INPUT_LIMITS.maxFlushWaiters }, () => channel.flush())
  await assert.rejects(channel.flush(), /gesto|toque/i)
  h.socket.finish(); await Promise.all(waiting)
  channel.touch(event('up'), DIMENSIONS)
  h.socket.finish(); await channel.flush()
})

test('backpressure requires both write completion and drain before the next packet', async t => {
  const h = harness({ socket: { autoFlush: false, backpressure: true } }), channel = await h.start()
  t.after(() => channel.close())
  channel.touch(event('down'), DIMENSIONS)
  channel.touch(event('up'), DIMENSIONS)
  h.socket.finish()
  assert.equal(h.socket.writes.length, 1)
  h.socket.emit('drain')
  assert.equal(h.socket.writes.length, 2)
  h.socket.emit('drain')
  let done = false; const flushing = channel.flush().then(() => { done = true })
  await tick(); assert.equal(done, false)
  h.socket.finish(); await flushing
})

test('cancel sends ACTION_CANCEL then pointer cleanup UP together and does not allow interleaved DOWN', async t => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  t.after(() => channel.close())
  channel.touch(event('down'), DIMENSIONS)
  channel.touch(event('move', 0.9, 0.8), DIMENSIONS)
  channel.cancel(); channel.cancel()
  assert.throws(() => channel.touch(event('down'), DIMENSIONS))
  h.socket.finish()
  assert.equal(h.socket.writes[1].length, 64)
  assert.deepEqual(actions(h.socket), [0, 3, 1])
  h.socket.finish(); await channel.flush()
  channel.cancel()
  assert.equal(h.socket.writes.length, 2)
})

test('touch cancel uses the same terminal path, not a standalone CANCEL pointer leak', async t => {
  const h = harness(), channel = await h.start()
  t.after(() => channel.close())
  channel.touch(event('down'), DIMENSIONS)
  channel.touch(event('cancel'), DIMENSIONS)
  await channel.flush()
  assert.deepEqual(actions(h.socket), [0, 3, 1])
})

test('geometry changes cancel the active gesture using its original native bounds', async t => {
  const h = harness(), channel = await h.start()
  t.after(() => channel.close())
  channel.touch(event('down'), DIMENSIONS)
  assert.throws(() => channel.touch(event('move'), { width: 1440, height: 3120 }), /tela|dimens/i)
  await channel.flush()
  assert.deepEqual(actions(h.socket), [0, 3, 1])
  assert.equal(h.socket.writes.at(-1).readUInt16BE(18), 1080)
})

test('abort drops queued input, rejects flush and does not inject a post-revocation CANCEL', async () => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  channel.touch(event('down'), DIMENSIONS)
  channel.touch(event('move'), DIMENSIONS)
  const flushing = channel.flush()
  h.abort.abort()
  await assert.rejects(flushing)
  h.socket.finish(); channel.cancel()
  assert.throws(() => channel.touch(event('up'), DIMENSIONS))
  await channel.close()
  assert.deepEqual(actions(h.socket), [0])
  assert.equal(h.closed.length, 1)
})

test('assertCurrent failure during queued drain never sends the queued terminal', async () => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  channel.touch(event('down'), DIMENSIONS)
  channel.touch(event('up'), DIMENSIONS)
  h.revoke(); h.socket.finish()
  await channel.close()
  assert.deepEqual(actions(h.socket), [0])
  assert.equal(channel.alive(), false)
  assert.equal(h.closed.length, 1)
})

test('child exit and unexpected inbound payload each invalidate control exactly once', async () => {
  for (const cause of ['child', 'payload']) {
    const h = harness({ throwClosed: true }), channel = await h.start()
    if (cause === 'child') h.exit()
    else h.socket.emit('data', Buffer.from([0, 99, 99]))
    await tick()
    assert.equal(channel.alive(), false)
    await channel.close()
    assert.equal(h.closed.length, 1)
    assert.equal(h.connects.length, 1)
  }
})

test('hard disconnect while DOWN is held sends no invented cleanup on another socket', async () => {
  const h = harness(), channel = await h.start()
  channel.touch(event('down'), DIMENSIONS)
  await channel.flush()
  h.socket.destroy()
  await tick()
  channel.cancel()
  await channel.close()
  assert.deepEqual(actions(h.socket), [0])
  assert.equal(h.connects.length, 1)
  assert.equal(h.closed.length, 1)
})

test('write stall fails closed within the exported bounded deadline', async () => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  channel.touch(event('down'), DIMENSIONS)
  const before = performance.now()
  await assert.rejects(channel.flush())
  assert.ok(performance.now() - before < h.input.MOBILE_INPUT_LIMITS.writeTimeoutMs + 1000)
  assert.equal(channel.alive(), false)
  await channel.close()
})

test('close cancels while authority is current, awaits its child and is idempotent', async () => {
  const h = harness({ holdStop: true }), channel = await h.start()
  channel.touch(event('down'), DIMENSIONS)
  let finished = false
  const closing = channel.close().then(() => { finished = true })
  await tick()
  assert.deepEqual(actions(h.socket), [0, 3, 1])
  assert.equal(finished, false)
  assert.equal(channel.alive(), false)
  h.releaseStop(); await closing; await channel.close()
  assert.equal(h.calls.filter(call => call.kind === 'stop').length, 1)
  assert.equal(h.closed.length, 1)
})

test('close during a stalled DOWN waits only its bounded cancel grace and then destroys the socket', async () => {
  const h = harness({ socket: { autoFlush: false } }), channel = await h.start()
  channel.touch(event('down'), DIMENSIONS)
  const before = performance.now()
  await channel.close()
  assert.equal(h.socket.destroyed, true)
  assert.ok(performance.now() - before < h.input.MOBILE_INPUT_LIMITS.cancelGraceMs + 1000)
  h.socket.finish()
  assert.deepEqual(actions(h.socket), [0])
})

test('cleanup checks exact serial, local port and private SCID before removing its forward', async () => {
  const h = harness(), channel = await h.start()
  const setupCount = h.calls.length
  await channel.close()
  const cleanup = h.calls.slice(setupCount).filter(call => call.args?.includes('--list') || call.args?.includes('--remove'))
  assert.equal(cleanup.length, 2)
  assert.deepEqual(cleanup[1].args, ['-s', 'emulator-5580', 'forward', '--remove', 'tcp:35123'])
  assert.ok(!h.calls.some(call => call.args?.includes('--remove-all') || call.args?.includes('kill-server')))
})

test('a forward rebound by another owner is preserved, as are ambiguous listings', async () => {
  for (const forwardList of [row => `${row.serial} ${row.local} localabstract:another-owner\n`,
    row => `emulator-5582 ${row.local} ${row.remote}\n`, row => `${row.serial} ${row.local} ${row.remote}\n${row.serial} ${row.local} ${row.remote}\n`]) {
    let closing = false
    const h = harness({ forwardList: row => closing ? forwardList(row) : `${row.serial} ${row.local} ${row.remote}\n` }), channel = await h.start()
    closing = true
    await channel.close()
    assert.equal(h.calls.filter(call => call.args?.includes('--remove')).length, 0)
  }
})

test('strict forward port parsing rejects malformed output and still reclaims an exact owned mapping', async () => {
  for (const portOutput of ['35123\nextra', '0', '65536', 'tcp:35123']) {
    const h = harness({ portOutput })
    await assert.rejects(h.start())
    assert.equal(h.calls.filter(call => call.kind === 'launch').length, 0)
    assert.equal(h.calls.filter(call => call.args?.includes('--remove')).length, 1)
  }
})

test('all gesture traffic after readiness is socket-only, with no per-event ADB process', async t => {
  const h = harness(), channel = await h.start()
  t.after(() => channel.close())
  const setupCalls = h.calls.length, checks = h.targetChecks
  for (let i = 0; i < 20; i++) {
    channel.touch(event('down'), DIMENSIONS)
    channel.touch(event('move', 0.6, 0.6), DIMENSIONS)
    channel.touch(event('up', 0.7, 0.7), DIMENSIONS)
    await channel.flush()
  }
  assert.equal(h.calls.length, setupCalls)
  assert.equal(h.targetChecks, checks)
  assert.equal(h.connects.length, 1)
})

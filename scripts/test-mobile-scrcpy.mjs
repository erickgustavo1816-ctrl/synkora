import assert from 'node:assert/strict'
import test from 'node:test'
import { Duplex } from 'node:stream'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const source = buildSync({ entryPoints: [resolve('src/main/mobileScrcpy.ts')], bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', write: false, logLevel: 'silent' }).outputFiles[0].text
const asset = resolve('build/vendor/scrcpy/scrcpy-server-v4.1.jar')
const tick = () => new Promise(done => setImmediate(done))

class FakeSocket extends Duplex {
  noDelay = false
  writes = []
  _read() {}
  _write(bytes, _encoding, done) { this.writes.push(Buffer.from(bytes)); done() }
  setNoDelay(value) { this.noDelay = value; return this }
}

function harness(config = {}) {
  const calls = [], connects = [], sockets = [], notices = []
  let current = true, childAlive = true, exitResolve, forward, verifyCount = 0, releaseStop
  const signal = new AbortController()
  const child = {
    isAlive: () => childAlive,
    exited: new Promise(done => { exitResolve = done }),
    stop: async () => {
      calls.push({ kind: 'stop' })
      if (config.holdStop) await new Promise(done => { releaseStop = done })
      childAlive = false; exitResolve(); return true
    }
  }
  const executor = {
    run: async command => {
      calls.push({ kind: 'run', ...command })
      if (command.args.includes('tcp:0')) {
        forward = [command.args[1], 'tcp:36011', command.args.at(-1)]
        return { stdout: Buffer.from(config.portOutput ?? '36011\n') }
      }
      if (command.args.includes('--list')) return { stdout: Buffer.from(config.forwardList?.(forward) ?? (forward ? forward.join(' ') + '\n' : '')) }
      return { stdout: Buffer.alloc(0) }
    },
    launch: async command => { calls.push({ kind: 'launch', ...command }); await config.onLaunch?.(signal); return child }
  }
  const net = { createConnection: options => {
    connects.push(options)
    const socket = new FakeSocket()
    sockets.push(socket)
    queueMicrotask(() => {
      socket.emit('connect')
      if (config.failFirst && sockets.length === 1) socket.destroy(new Error('synthetic'))
      else if (config.handshake !== false) socket.push(Buffer.from(config.handshake ?? [0]))
    })
    return socket
  } }
  const module = { exports: {} }
  const crypto = require('node:crypto')
  const mocks = { 'node:net': net, 'node:crypto': config.badHash ? { ...crypto, createHash: (...args) => {
    const hash = crypto.createHash(...args); hash.digest = () => '0'.repeat(64); return hash
  } } : crypto }
  new Function('require', 'module', 'exports', source)(name => mocks[name] ?? require(name), module, module.exports)
  const options = {
    executable: resolve('synthetic-sdk/adb.exe'), serial: 'emulator-5580', serverPath: asset,
    executor, signal: signal.signal, mode: 'video',
    assertCurrent: () => { if (!current) throw new Error('synthetic revoked') },
    verifyTarget: async () => { verifyCount++; await config.onVerify?.(verifyCount, signal) },
    onClosed: () => { notices.push(true); if (config.throwNotice) throw new Error('synthetic notification') }
  }
  return { calls, connects, sockets, notices, options, signal, exports: module.exports,
    get socket() { return sockets.at(-1) },
    revoke: () => { current = false },
    exit: () => { childAlive = false; exitResolve() },
    releaseStop: () => releaseStop?.(),
    start: overrides => module.exports.createMobileScrcpyLink({ ...options, ...overrides }) }
}

test('video mode uses only the fixed video flags and its own private forward/JAR', async t => {
  const h = harness(), link = await h.start()
  t.after(() => link.close())
  assert.equal(link.alive(), true)
  assert.equal(link.socket.isPaused(), true)
  assert.equal(link.socket.noDelay, true)
  assert.deepEqual(h.connects, [{ host: '127.0.0.1', port: 36011 }])
  const push = h.calls.find(call => call.args?.includes('push'))
  assert.match(push.args.at(-1), /^\/data\/local\/tmp\/synkora-video-[a-f0-9]{32}\.jar$/)
  const command = h.calls.find(call => call.kind === 'launch').args[3]
  for (const flag of ['video=true', 'audio=false', 'control=false', 'video_codec=h264', 'video_bit_rate=4000000',
    'max_size=2400', 'max_fps=60', 'video_codec_options=max-bframes:int=0', 'downsize_on_error=false',
    'clipboard_autosync=false', 'power_on=false', 'send_device_meta=false', 'send_stream_meta=true',
    'send_frame_meta=true', 'tunnel_forward=true', 'send_dummy_byte=true', 'cleanup=true', 'log_level=error']) {
    assert.ok(command.includes(`'${flag}'`), flag)
  }
  assert.ok(!command.includes("'control=true'"))
  assert.equal(link.socket.writes.length, 0)
})

test('coalesced video bytes after the dummy survive paused handoff exactly once', async t => {
  const payload = Buffer.from([0x68, 0x32, 0x36, 0x34, 0x80, 0, 0, 0, 0, 0, 2, 208, 0, 0, 6, 64])
  const h = harness({ handshake: [0, ...payload] }), link = await h.start()
  t.after(() => link.close())
  const chunks = []
  link.socket.on('data', bytes => chunks.push(Buffer.from(bytes)))
  await tick()
  assert.equal(chunks.length, 0)
  link.socket.resume()
  await tick()
  assert.deepEqual(Buffer.concat(chunks), payload)
  await tick()
  assert.equal(chunks.length, 1)
})

test('separate post-handshake chunks wait for the consumer to resume', async t => {
  const h = harness(), link = await h.start()
  t.after(() => link.close())
  h.socket.push(Buffer.from([0x68, 0x32]))
  h.socket.push(Buffer.from([0x36, 0x34]))
  const chunks = []
  link.socket.on('data', bytes => chunks.push(Buffer.from(bytes)))
  await tick(); assert.equal(chunks.length, 0)
  link.socket.resume(); await tick()
  assert.deepEqual(Buffer.concat(chunks), Buffer.from('h264'))
})

test('input mode stays strict about unsolicited bytes while sharing the paused link', async t => {
  const h = harness(), link = await h.start({ mode: 'input' })
  t.after(() => link.close())
  assert.equal(link.socket.isPaused(), true)
  const command = h.calls.find(call => call.kind === 'launch').args[3]
  assert.ok(command.includes("'video=false'"))
  assert.ok(command.includes("'control=true'"))
  const invalid = harness({ handshake: [0, 1] })
  await assert.rejects(invalid.start({ mode: 'input' }))
  assert.equal(invalid.notices.length, 1)
})

test('invalid modes, physical devices and hash mismatches cause no target effect', async () => {
  for (const overrides of [{ mode: 'arbitrary' }, { serial: 'R58M00000' }, { executable: 'adb' }, { serverPath: 'relative.jar' }]) {
    const h = harness(); await assert.rejects(h.start(overrides)); assert.equal(h.calls.length, 0)
  }
  const badHash = harness({ badHash: true })
  await assert.rejects(badHash.start())
  assert.equal(badHash.calls.length, 0)
})

test('aborting before setup or between startup effects prevents further work', async () => {
  const before = harness(); before.signal.abort(); await assert.rejects(before.start()); assert.equal(before.calls.length, 0)
  const during = harness({ onVerify: (count, signal) => { if (count === 2) signal.abort() } })
  await assert.rejects(during.start())
  assert.equal(during.calls.filter(call => call.args?.includes('push')).length, 1)
  assert.equal(during.calls.filter(call => call.args?.includes('tcp:0')).length, 0)
})

test('late launch handles are reaped after setup abort', async () => {
  const h = harness({ onLaunch: signal => signal.abort() })
  await assert.rejects(h.start())
  assert.equal(h.calls.filter(call => call.kind === 'stop').length, 1)
  assert.equal(h.calls.filter(call => call.args?.includes('--remove')).length, 1)
  assert.equal(h.connects.length, 0)
})

test('a malformed dummy closes and never retries that accepted protocol connection', async () => {
  const h = harness({ handshake: [1, 0x68] })
  await assert.rejects(h.start())
  assert.equal(h.connects.length, 1)
  assert.equal(h.notices.length, 1)
  assert.equal(h.socket.destroyed, true)
})

test('an oversized initial read is rejected before retaining video bytes', async () => {
  const bytes = Buffer.alloc(128 * 1024 + 1)
  const h = harness({ handshake: bytes })
  await assert.rejects(h.start())
  assert.equal(h.connects.length, 1)
  assert.equal(h.socket.destroyed, true)
})

test('post-handshake ownership loss rejects the prepared link and preserves the replacement mapping', async () => {
  let lists = 0
  const h = harness({ forwardList: row => ++lists === 1 ? `${row.join(' ')}\n` : `${row[0]} ${row[1]} localabstract:replacement\n` })
  await assert.rejects(h.start())
  assert.equal(h.connects.length, 1)
  assert.equal(h.socket.destroyed, true)
  assert.equal(h.calls.filter(call => call.kind === 'stop').length, 1)
  assert.equal(h.calls.filter(call => call.args?.includes('--remove')).length, 0)
})

test('startup may retry refusal, but EOF, child exit and scope revocation never reconnect after ready', async () => {
  for (const cause of ['eof', 'child', 'scope', 'abort']) {
    const h = harness({ failFirst: true, throwNotice: true }), link = await h.start()
    assert.equal(h.connects.length, 2)
    if (cause === 'eof') { link.socket.resume(); h.socket.push(null) }
    if (cause === 'child') h.exit()
    if (cause === 'scope') { h.revoke(); assert.equal(link.alive(), false) }
    if (cause === 'abort') h.signal.abort()
    await tick()
    assert.equal(link.alive(), false)
    await link.close()
    assert.equal(h.connects.length, 2)
    assert.equal(h.notices.length, 1)
  }
})

test('closing an owned channel waits for its child and removes exactly its current mapping once', async () => {
  const h = harness({ holdStop: true }), link = await h.start()
  let finished = false
  const closing = link.close().then(() => { finished = true })
  await tick()
  assert.equal(finished, false)
  assert.equal(link.socket.destroyed, true)
  h.releaseStop(); await closing; await link.close()
  assert.equal(h.calls.filter(call => call.kind === 'stop').length, 1)
  assert.deepEqual(h.calls.find(call => call.args?.includes('--remove')).args, ['-s', 'emulator-5580', 'forward', '--remove', 'tcp:36011'])
  assert.equal(h.notices.length, 1)
})

test('rebound and ambiguous forwards are preserved during teardown', async () => {
  for (const replacement of [row => `${row[0]} ${row[1]} localabstract:other\n`, row => `${row.join(' ')}\n${row.join(' ')}\n`]) {
    let closing = false
    const h = harness({ forwardList: row => closing ? replacement(row) : `${row.join(' ')}\n` }), link = await h.start()
    closing = true
    await link.close()
    assert.equal(h.calls.filter(call => call.args?.includes('--remove')).length, 0)
  }
})

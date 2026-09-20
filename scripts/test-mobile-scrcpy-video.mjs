import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const baseline = process.argv.includes('--baseline-raw')
const bundle = name => buildSync({ entryPoints: [resolve(`src/main/${name}.ts`)], bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', write: false, external: ['./mobileScrcpy'], logLevel: 'silent' }).outputFiles[0].text
const load = (source, mocks = {}) => { const module = { exports: {} }; new Function('require', 'module', 'exports', source)(name => mocks[name] ?? require(name), module, module.exports); return module.exports }
const { H264AnnexBParser } = load(bundle('mobileH264'))
const protocol = baseline ? undefined : load(bundle('mobileScrcpyVideoProtocol'))
const adapterSource = baseline ? undefined : bundle('mobileScrcpyVideo')
const ue = value => (value + 1).toString(2).padStart(2 * Math.floor(Math.log2(value + 1)) + 1, '0')
const bits = value => Buffer.from((value + '1').padEnd(Math.ceil((value.length + 1) / 8) * 8, '0').match(/.{8}/g).map(v => parseInt(v, 2)))
const concat = (...values) => Buffer.concat(values.map(value => Buffer.from(value)))
const nal = value => concat([0, 0, 0, 1], value)
const sps = concat([0x67, 0x42, 0xc0, 0x1e], bits(ue(0)))
const pps = concat([0x68], bits(ue(0) + ue(0)))
const slice = (key, first = 0) => concat([key ? 0x65 : 0x41], bits(ue(first) + ue(key ? 2 : 0) + ue(0)))
const config = concat(nal(sps), nal(pps))
const KEY = 1n << 61n, CONFIG = 1n << 62n
const codec = Buffer.from('h264')
const session = (width = 720, height = 1600, flags = 0x80000000) => { const bytes = Buffer.alloc(12); bytes.writeUInt32BE(flags); bytes.writeUInt32BE(width, 4); bytes.writeUInt32BE(height, 8); return bytes }
const header = (flags, length) => { const bytes = Buffer.alloc(12); bytes.writeBigUInt64BE(flags); bytes.writeUInt32BE(length, 8); return bytes }
const packet = (flags, data) => concat(header(flags, data.length), data)
const picture = (pts = 1000, key = true, data = nal(slice(key))) => packet(BigInt(pts) | (key ? KEY : 0n), data)
const initial = () => concat(codec, session(), packet(CONFIG, config))
const stream = () => concat(initial(), picture())
const collect = () => { const events = []; return { events, parser: new protocol.MobileScrcpyVideoParser(event => events.push(event)) } }
const frames = events => events.filter(event => event.type === 'frame')
const nalTypes = data => { const result = []; for (let i = 0; i + 3 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) result.push(data[i + 3] & 31); return result }
const check = (name, fn) => test(name, { skip: baseline }, fn)

test('last static frame is emitted at its complete producer payload, without another NAL or EOF', () => {
  const events = []
  if (baseline) {
    const raw = new H264AnnexBParser(unit => events.push({ type: 'frame', unit }))
    raw.push(config); raw.push(nal(slice(true)))
  } else {
    const parser = new protocol.MobileScrcpyVideoParser(event => events.push(event))
    parser.push(stream())
  }
  assert.equal(frames(events).length, 1, 'The final native image must not wait for a future screen change')
  assert.deepEqual(nalTypes(frames(events)[0].unit.data), [7, 8, 5])
})

check('codec, SESSION, headers and payload survive every byte split and coalescing', () => {
  const bytes = concat(stream(), picture(2000, false), picture(3000))
  for (let size = 1; size <= bytes.length; size++) {
    const { parser, events } = collect()
    for (let i = 0; i < bytes.length; i += size) parser.push(bytes.subarray(i, i + size))
    assert.equal(frames(events).length, 3, `split=${size}`)
    assert.deepEqual(frames(events).map(event => event.ptsUs), [1000, 2000, 3000])
    parser.end()
  }
})
check('partial frame emits nothing until its exact final byte', () => {
  const { parser, events } = collect(), bytes = stream()
  parser.push(bytes.subarray(0, -1)); assert.equal(frames(events).length, 0); assert.equal(parser.hasIncompletePacket, true)
  parser.push(bytes.subarray(-1)); assert.equal(frames(events).length, 1); assert.equal(parser.hasIncompletePacket, false)
})
check('a complete multislice encoder buffer is one picture with repeated key headers', () => {
  const { parser, events } = collect()
  parser.push(concat(initial(), picture(0, true, concat(nal(slice(true)), nal(slice(true, 7)))), picture(1)))
  assert.deepEqual(nalTypes(frames(events)[0].unit.data), [7, 8, 5, 5])
  assert.deepEqual(nalTypes(frames(events)[1].unit.data), [7, 8, 5])
  assert.equal(frames(events)[1].unit.codec, 'avc1.42c01e')
})
check('CONFIG can arrive as separate SPS/PPS records but never publishes a picture', () => {
  const { parser, events } = collect()
  parser.push(concat(codec, session(), packet(CONFIG, nal(sps)), packet(CONFIG, nal(pps))))
  assert.equal(frames(events).length, 0)
  parser.push(picture()); assert.equal(frames(events).length, 1)
})
check('SESSION resize resets configuration and native PTS before the next key', () => {
  const { parser, events } = collect()
  parser.push(concat(stream(), session(1600, 720, 0x80000001), packet(CONFIG, config), picture(10)))
  assert.deepEqual(events.filter(event => event.type === 'session').map(({ width, height }) => [width, height]), [[720, 1600], [1600, 720]])
  assert.deepEqual(frames(events).map(event => event.ptsUs), [1000, 10])
  const other = collect(); other.parser.push(concat(stream(), session(1600, 720)))
  assert.throws(() => other.parser.push(picture(11, false)), /framed|video|AVC/i)
})
check('disabled, error and non-AVC codec IDs are rejected before media', () => {
  for (const bytes of [Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), Buffer.from('h265'), Buffer.from('av01')]) assert.throws(() => collect().parser.push(bytes), /codec|video/i)
})
check('media requires SESSION and explicit configuration before key or delta', () => {
  for (const bytes of [concat(codec, picture()), concat(codec, packet(CONFIG, config)), concat(codec, session(), picture()), concat(initial(), picture(1, false))]) assert.throws(() => collect().parser.push(bytes), /framed|video|AVC/i)
})
for (const [width, height] of [[1080, 2400], [2400, 1080]]) {
  check(`SESSION accepts full native ${width}x${height} followed by a complete picture`, () => {
    const { parser, events } = collect()
    parser.push(concat(codec, session(width, height), packet(CONFIG, config), picture()))
    assert.deepEqual(events.filter(event => event.type === 'session'), [{ type: 'session', width, height }])
    assert.equal(frames(events).length, 1)
    parser.end()
  })
}
check('SESSION rejects invalid flags and bounded dimensions without allocating payload', () => {
  for (const bytes of [session(0, 720), session(720, 0), session(2401, 1080), session(1080, 2401), session(720, 0xffffffff), session(720, 1600, 0xc0000000), session(720, 1600, 0x80000002)]) assert.throws(() => collect().parser.push(concat(codec, bytes)), /session|limit|video/i)
})
check('CONFIG flags must be exact and payload lengths are checked before allocation', () => {
  for (const bytes of [header(CONFIG | KEY, 1), header(CONFIG | 1n, 1), header(CONFIG, 0), header(CONFIG, 65537), header(KEY, 0), header(KEY, 2 * 1024 * 1024 + 1)]) {
    const { parser } = collect(); parser.push(initial()); assert.throws(() => parser.push(bytes), /framed|limit|video/i)
  }
})
check('unsafe, duplicate and regressing PTS are rejected, but MAX_SAFE_INTEGER is exact', () => {
  const maximum = collect(); maximum.parser.push(concat(initial(), picture(Number.MAX_SAFE_INTEGER))); assert.equal(frames(maximum.events)[0].ptsUs, Number.MAX_SAFE_INTEGER)
  for (const flags of [KEY | (BigInt(Number.MAX_SAFE_INTEGER) + 1n), 999n, 1000n]) {
    const { parser } = collect(); parser.push(stream()); assert.throws(() => parser.push(packet(flags, nal(slice(false)))), /PTS|framed|video/i)
  }
})
check('config pictures, missing parameters and flag/key mismatches fail closed', () => {
  for (const bytes of [concat(codec, session(), packet(CONFIG, nal(slice(true)))), concat(codec, session(), packet(CONFIG, nal([9, 0xf0]))), concat(initial(), picture(1, false, nal(slice(true)))), concat(initial(), picture(1, true, nal(slice(false))))]) assert.throws(() => collect().parser.push(bytes), /framed|video|AVC/i)
})
check('two access units in one framed payload never publish a partial valid result', () => {
  const { parser, events } = collect(); parser.push(initial())
  assert.throws(() => parser.push(picture(1, true, concat(nal(slice(true)), nal(slice(true))))), /framed|video|AVC/i)
  assert.equal(frames(events).length, 0)
  assert.throws(() => parser.push(picture(2)), /framed|video/i)
})
check('EOF at every partial codec/header/payload position fails without invented frames', () => {
  const bytes = stream(), validBoundaries = new Set([4 + 12, initial().length])
  for (let length = 0; length < bytes.length; length++) {
    const { parser } = collect(); parser.push(bytes.subarray(0, length))
    if (validBoundaries.has(length)) parser.end()
    else assert.throws(() => parser.end(), /Incomplete|framed|video/i, `EOF=${length}`)
  }
  const complete = collect(); complete.parser.push(bytes); complete.parser.end(); assert.throws(() => complete.parser.push(bytes), /framed|video/i)
})

class FakeSocket extends EventEmitter {
  paused = true; destroyed = false; pending = []; resumes = 0
  pause() { this.paused = true; return this }
  resume() { this.paused = false; this.resumes++; while (!this.paused && this.pending.length) this.emit('data', this.pending.shift()); return this }
  receive(bytes) { if (this.paused) this.pending.push(bytes); else this.emit('data', bytes) }
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function adapterHarness(config = {}) {
  const socket = new FakeSocket(), controller = new AbortController(), events = [], closed = []
  let authorized = true, linkAlive = true, closeCalls = 0, supplied, releaseOpen, releaseClose
  const link = { socket, alive: () => linkAlive, close: async () => { closeCalls++; if (config.holdClose) await new Promise(resolve => { releaseClose = resolve }); linkAlive = false; socket.destroyed = true } }
  const helper = { createMobileScrcpyLink: async options => { supplied = options; if (config.holdOpen) await new Promise(resolve => { releaseOpen = resolve }); if (config.failOpen) throw new Error('synthetic setup'); return link } }
  const mod = load(adapterSource, { './mobileScrcpy': helper })
  const options = { executable: resolve('synthetic-adb'), serial: 'emulator-5580', serverPath: resolve('synthetic-server.jar'), executor: {}, signal: controller.signal,
    assertCurrent: () => { if (!authorized) throw new Error('revoked') }, verifyTarget: async () => {},
    onSession: value => events.push({ type: 'session', ...value }), onFrame: value => { events.push({ type: 'frame', ...value }); config.onFrame?.() }, onClosed: () => { closed.push(true); if (config.throwClosed) throw new Error('synthetic callback') } }
  return { mod, options, socket, events, closed, controller, start: () => mod.createMobileAndroidVideo(options), revoke: () => { authorized = false }, get closeCalls() { return closeCalls }, get supplied() { return supplied }, releaseOpen: () => releaseOpen?.(), releaseClose: () => releaseClose?.(), loseLink: () => { linkAlive = false; supplied.onClosed?.() } }
}
check('adapter returns paused with preserved initial bytes and fixed helper mode', async t => {
  const h = adapterHarness(); h.socket.receive(stream()); const channel = await h.start(); t.after(() => channel.close())
  assert.equal(h.supplied.mode, 'video'); assert.equal(h.socket.resumes, 0); assert.equal(h.events.length, 0); assert.equal(channel.alive(), true)
  channel.resume(); assert.equal(frames(h.events).length, 1)
})
check('adapter pause/resume preserves complete data without a private frame backlog', async t => {
  const h = adapterHarness(), channel = await h.start(); t.after(() => channel.close())
  channel.resume(); h.socket.receive(stream()); channel.pause(); h.socket.receive(picture(2000, false)); assert.equal(frames(h.events).length, 1)
  channel.resume(); assert.equal(frames(h.events).length, 2)
})
check('adapter close invalidates callbacks immediately and waits for owned cleanup', async () => {
  const h = adapterHarness({ holdClose: true }), channel = await h.start(); channel.resume(); h.socket.receive(initial())
  const closing = channel.close(); h.socket.emit('data', picture()); channel.resume(); assert.equal(frames(h.events).length, 0); assert.equal(channel.alive(), false)
  assert.strictEqual(channel.close(), closing); await tick(); h.releaseClose(); await closing; assert.equal(h.closeCalls, 1); assert.equal(h.closed.length, 1)
})
check('adapter closes on malformed payload, socket error and EOF, once only', async () => {
  for (const fault of ['invalid', 'error', 'partial-end', 'clean-end', 'helper-close']) {
    const h = adapterHarness(), channel = await h.start(); channel.resume()
    if (fault === 'invalid') h.socket.receive(Buffer.from('h265'))
    if (fault === 'error') h.socket.emit('error', new Error('synthetic socket'))
    if (fault === 'partial-end') { h.socket.receive(Buffer.from('h2')); h.socket.emit('end') }
    if (fault === 'clean-end') { h.socket.receive(stream()); h.socket.emit('end') }
    if (fault === 'helper-close') h.loseLink()
    await tick(); await channel.close(); assert.equal(channel.alive(), false); assert.equal(h.closed.length, 1); assert.equal(h.closeCalls, 1)
  }
})
check('adapter checks authority for every event and ignores all data after abort', async () => {
  const h = adapterHarness(), channel = await h.start(); channel.resume(); h.socket.receive(initial()); h.revoke(); h.socket.receive(picture()); await tick()
  assert.equal(frames(h.events).length, 0); await channel.close()
  const aborting = adapterHarness(), other = await aborting.start(); other.resume(); aborting.controller.abort(); aborting.socket.emit('data', stream()); await other.close(); assert.equal(aborting.events.length, 0)
})
check('adapter cannot resurrect after setup cancellation or hide before initial resume', async () => {
  const h = adapterHarness({ holdOpen: true }), starting = h.start(); await tick(); h.controller.abort(); h.releaseOpen(); await assert.rejects(starting); assert.equal(h.closeCalls, 1); assert.equal(h.events.length, 0)
  const hidden = adapterHarness(), channel = await hidden.start(); hidden.socket.receive(stream()); await channel.close(); channel.resume(); assert.equal(hidden.events.length, 0)
})
check('adapter stops the current coalesced chunk when a frame callback closes it', async () => {
  let channel
  const h = adapterHarness({ onFrame: () => { void channel.close() } }); channel = await h.start(); channel.resume(); h.socket.receive(concat(stream(), picture(2000, false))); await channel.close()
  assert.equal(frames(h.events).length, 1)
})
check('a silent completed static frame remains healthy without an idle restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = adapterHarness(), channel = await h.start(); channel.resume(); h.socket.receive(stream())
  t.mock.timers.tick(60_000); await tick(); assert.equal(channel.alive(), true); assert.equal(h.closed.length, 0)
  await channel.close()
})
check('an incomplete packet times out without flushing or accepting empty progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = adapterHarness(), channel = await h.start(); channel.resume(); h.socket.receive(stream().subarray(0, -1))
  t.mock.timers.tick(4999); h.socket.receive(Buffer.alloc(0)); assert.equal(channel.alive(), true)
  t.mock.timers.tick(1); await tick(); assert.equal(channel.alive(), false); assert.equal(frames(h.events).length, 0); await channel.close()
})
check('partial packet deadline stops while deliberately paused and resumes its remainder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = adapterHarness(), channel = await h.start(); channel.resume(); h.socket.receive(codec.subarray(0, 2))
  t.mock.timers.tick(1000); channel.pause(); t.mock.timers.tick(60_000); await tick(); assert.equal(channel.alive(), true)
  channel.resume(); t.mock.timers.tick(3999); assert.equal(channel.alive(), true); t.mock.timers.tick(1); await tick(); assert.equal(channel.alive(), false)
  await channel.close()
})
check('read chunk cap and throwing notifications still close only the owned link', async () => {
  const h = adapterHarness({ throwClosed: true }), channel = await h.start(); channel.resume()
  h.socket.receive(Buffer.alloc(h.mod.MOBILE_VIDEO_CHANNEL_LIMITS.maxReadChunkBytes + 1))
  await channel.close(); assert.equal(h.closeCalls, 1); assert.equal(h.events.length, 0); assert.equal(h.closed.length, 1)
})

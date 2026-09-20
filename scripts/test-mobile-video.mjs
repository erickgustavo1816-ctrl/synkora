import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { H264AnnexBParser, MOBILE_H264_LIMITS } from '../.tmp/mobile-video-test/main/mobileH264.js'
import { MobileVideoRegistry, MOBILE_VIDEO_LIMITS, mobileVideoSize } from '../.tmp/mobile-video-test/main/mobileVideo.js'
import { createMobileVideoRenderer } from '../.tmp/mobile-video-test/renderer/src/mobileVideo.js'

const ue = value => (value + 1).toString(2).padStart(2 * Math.floor(Math.log2(value + 1)) + 1, '0')
const bits = value => Uint8Array.from((value + '1').padEnd(Math.ceil((value.length + 1) / 8) * 8, '0').match(/.{8}/g).map(v => parseInt(v, 2)))
const concat = (...values) => Uint8Array.from(values.flatMap(v => [...v]))
const nal = (value, short = false) => concat(short ? [0, 0, 1] : [0, 0, 0, 1], value)
const sps = concat([0x67, 0x42, 0xc0, 0x1e], bits(ue(0)))
const pps = concat([0x68], bits(ue(0) + ue(0)))
const slice = (key, first = 0) => concat([key ? 0x65 : 0x41], bits(ue(first) + ue(key ? 2 : 0) + ue(0)))
const headers = concat(nal(sps), nal(pps, true))
const au = (key = true, first = 0) => concat(key ? headers : [], nal(slice(key, first)))
const stream = () => concat(headers, nal(slice(true)), nal(slice(true, 7), true), nal(slice(false)), nal(slice(false, 14)), nal([9, 0xf0]))
const collect = () => { const units = []; return { units, parser: new H264AnnexBParser(unit => units.push(unit)) } }
const nalTypes = data => { const result = []; for (let i = 0; i + 3 < data.length; i++) { if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) result.push(data[i + 3] & 31) } return result }

test('Annex-B recognizes every fragmented start code and keeps multislice pictures together', () => {
  const input = stream()
  for (let size = 1; size <= input.length; size++) {
    const { parser, units } = collect()
    for (let i = 0; i < input.length; i += size) parser.push(input.subarray(i, i + size))
    parser.flush()
    assert.equal(units.length, 2, `fragment size ${size}`)
    assert.deepEqual(nalTypes(units[0].data), [7, 8, 5, 5])
    assert.deepEqual(nalTypes(units[1].data), [1, 1])
    assert.equal(units[0].codec, 'avc1.42c01e')
    assert.equal(units[0].key, true)
    assert.equal(units[1].key, false)
  }
})

test('Annex-B emits the previous picture as soon as the next first slice header arrives', () => {
  const { parser, units } = collect()
  parser.push(concat(au(), nal(slice(false))))
  assert.equal(units.length, 1)
  assert.equal(units[0].key, true)
  parser.flush()
  assert.equal(units.length, 2)
})

test('Annex-B caches SPS/PPS for every keyframe and never emits a naked or orphaned keyframe', () => {
  const { parser, units } = collect()
  parser.push(concat(nal(slice(true)), nal(slice(false)), headers, nal(slice(false)), nal(slice(true)), nal(slice(false)), nal(slice(true)), nal([9, 0xf0])))
  parser.flush()
  assert.equal(units.length, 3)
  assert.deepEqual(units.map(v => v.key), [true, false, true])
  assert.deepEqual(nalTypes(units[0].data), [7, 8, 5])
  assert.deepEqual(nalTypes(units[2].data), [7, 8, 5])
})

test('Annex-B respects AUD boundaries and flushes the final access unit once', () => {
  const { parser, units } = collect()
  parser.push(concat(nal([9, 0xf0]), au(), nal([9, 0xf0]), nal(slice(false)), nal(slice(false, 10))))
  parser.flush()
  parser.flush()
  assert.equal(units.length, 2)
  assert.deepEqual(nalTypes(units[0].data), [9, 7, 8, 5])
  assert.deepEqual(nalTypes(units[1].data), [9, 1, 1])
})

test('Annex-B bounds unframed input, individual NALs and accumulated access units', () => {
  assert.throws(() => collect().parser.push(new Uint8Array(MOBILE_H264_LIMITS.maxNalBytes + 1).fill(0x55)), /limit|invalid/i)
  assert.throws(() => collect().parser.push(concat(nal([0x65, 0xb8]), new Uint8Array(MOBILE_H264_LIMITS.maxNalBytes + 1).fill(0x55))), /limit/i)
  const { parser } = collect()
  parser.push(au())
  assert.throws(() => { for (let i = 0; i <= MOBILE_H264_LIMITS.maxNalsPerAccessUnit; i++) parser.push(nal(slice(true, 1))) }, /limit/i)
})

test('Annex-B rejects malformed slice headers and forbidden bits instead of emitting partial pictures', () => {
  assert.throws(() => collect().parser.push(concat(nal([0xe5, 0x80]), nal([9, 0xf0]))), /invalid/i)
  assert.throws(() => collect().parser.push(concat(nal([0x65, 0, 0, 0, 0, 0x80]), nal([9, 0xf0]))), /invalid/i)
})

function videoLease(value={}) {
  return {signal:new AbortController().signal,assertCurrent(){},async verifyTarget(){},...value}
}
function fakeChannel(callbacks) {
  let initialized=false, pts=0, pendingFrames=0
  const channel={closeCount:0,pauseCount:0,resumeCount:0,paused:true,
    pause(){this.pauseCount++; this.paused=true},
    resume(){this.resumeCount++; this.paused=false; if(!initialized) {initialized=true; callbacks.onSession({width:320,height:640}); const pending=pendingFrames; pendingFrames=0; if(pending) this.frames(pending)}},
    alive(){return !this.closeCount},
    async close(){if(this.closeCount) return; this.closeCount++; callbacks.onClosed?.()},
    fail(){callbacks.onClosed?.()},
    frames(count){if(!initialized) {pendingFrames=count; return} for(let i=0;i<count;i++){callbacks.onFrame({ptsUs:pts,unit:{codec:'avc1.42c01e',key:i===0,data:au(i===0)}}); pts+=16_667}}
  }
  return channel
}
function harness(options = {}) {
  const channels = [], calls = [], packets = []
  let now = 1000
  const resolver=options.resolveTarget ?? (async()=>({ok:true,value:{executable:'C:\\Android SDK\\adb.exe',serial:'emulator-5554',width:320,height:640}}))
  const registry = new MobileVideoRegistry({
    serverPath:'C:\\app\\server.jar',
    emit: packet => packets.push(packet),
    createVideo:async callbacks=>{const channel=fakeChannel(callbacks); channels.push(channel); calls.push(callbacks); return channel},
    now: () => now,
    ...options,
    resolveTarget:async(...args)=>{const result=await resolver(...args); return result.ok ? {...result,value:videoLease(result.value)}:result}
  })
  return { registry, channels, calls, packets, setNow: value => { now = value } }
}
const tick = async () => {for(let i=0;i<16;i++) await Promise.resolve()}
const sendFrames = (channel,count=1)=>channel.frames(count)

function framedHarness(options={}) {
  const channels=[], packets=[], controller=new AbortController()
  const target={executable:'C:\\Android SDK\\adb.exe',serial:'emulator-5554',width:1080,height:2400,
    signal:controller.signal,assertCurrent(){if(controller.signal.aborted) throw new Error('revoked')},async verifyTarget(){this.assertCurrent()}}
  const registry=new MobileVideoRegistry({serverPath:'C:\\app\\server.jar',resolveTarget:async()=>({ok:true,value:target}),emit:packet=>packets.push(packet),
    createVideo:async callbacks=>{
      const channel={callbacks,closed:0,paused:true,pause(){this.paused=true},resume(){this.paused=false; options.resume?.(this)},alive(){return !this.closed},
        async close(){if(this.closed) return; this.closed++; callbacks.onClosed?.(); if(options.close) await options.close()},
        session(width=720,height=1600){callbacks.onSession({width,height})},
        frame(ptsUs,key=true){callbacks.onFrame({ptsUs,unit:{key,codec:'avc1.42c01e',data:au(key)}})}}
      channels.push(channel); if(options.create) await options.create(channel); return channel
    },...options.registry})
  return {registry,channels,packets,controller,target}
}

test('framed producer emits the last static frame immediately without a later NAL or EOF', async()=>{
  const h=framedHarness()
  try {
    assert.equal((await h.registry.setVisible('m','s',true)).ok,true)
    h.channels[0].session(); h.channels[0].frame(8_000_000)
    assert.equal(h.packets.length,1)
    assert.equal(h.packets[0].key,true)
  } finally {await h.registry.dispose()}
})

test('each framed SESSION requires a new key and stream id while preserving native PTS deltas and old credits', async()=>{
  const h=framedHarness()
  try {
    await h.registry.setVisible('m','s',true)
    const channel=h.channels[0]; channel.session(); channel.frame(9_000_000); channel.frame(9_016_667,false)
    assert.equal(h.packets[1].timestampUs-h.packets[0].timestampUs,16_667)
    const old=h.packets[0]
    channel.session(1600,720); channel.frame(100,false); channel.frame(16_767)
    assert.equal(h.packets.length,3)
    const rotated=h.packets[2]; assert.notEqual(rotated.streamId,old.streamId); assert.equal(rotated.key,true)
    assert.ok(rotated.timestampUs>h.packets[1].timestampUs)
    channel.frame(33_434,false); assert.equal(h.packets.length,3)
    h.registry.acknowledge('m','s',old.streamId,old.timestampUs)
    assert.equal(h.packets.length,4)
  } finally {await h.registry.dispose()}
})

test('large safe native PTS values retain exact deltas without unsafe intermediate arithmetic', async()=>{
  const h=framedHarness({registry:{now:()=>1000}})
  try {
    await h.registry.setVisible('m','s',true)
    const channel=h.channels[0], origin=Number.MAX_SAFE_INTEGER-50_000
    channel.session(); channel.frame(origin); channel.frame(origin+16_667,false)
    assert.equal(h.packets[0].timestampUs,1_000_000)
    assert.equal(h.packets[1].timestampUs,1_016_667)
  } finally {await h.registry.dispose()}
})

test('hide invalidates callbacks immediately and a replacement waits for owned channel cleanup', async()=>{
  let finishClose
  const h=framedHarness({close:()=>new Promise(resolve=>{finishClose=resolve})})
  await h.registry.setVisible('m','s',true)
  const old=h.channels[0]; old.session()
  const hiding=h.registry.setVisible('m','s',false)
  old.frame(100); assert.equal(h.packets.length,0)
  const reopening=h.registry.setVisible('m','s',true)
  await tick(); assert.equal(h.channels.length,1)
  finishClose(); await hiding; await reopening; assert.equal(h.channels.length,2)
  const closing=h.registry.dispose(); await tick(); finishClose(); await closing
})

test('initial synchronous SESSION and frame from resume are accepted only after channel assignment', async()=>{
  let resumed=false
  const h=framedHarness({resume:channel=>{if(!resumed) {resumed=true; channel.session(736,1600); channel.frame(15_000_000)}}})
  try {assert.equal((await h.registry.setVisible('m','s',true)).ok,true); assert.equal(h.packets.length,1)}
  finally {await h.registry.dispose()}
})

test('hiding during producer setup aborts its lease, discards callbacks and awaits late channel cleanup', async()=>{
  let finishSetup
  const gate=new Promise(resolve=>{finishSetup=resolve})
  const h=framedHarness({create:async()=>gate})
  const starting=h.registry.setVisible('m','s',true); await tick()
  assert.equal(h.channels.length,1)
  let hidden=false
  const hiding=h.registry.setVisible('m','s',false).then(result=>{hidden=true; return result})
  assert.equal(h.channels[0].callbacks.signal.aborted,true)
  assert.throws(()=>h.channels[0].callbacks.assertCurrent())
  h.channels[0].session(); h.channels[0].frame(100)
  const replacement=h.registry.setVisible('m','s',true)
  await tick(); assert.equal(hidden,false); assert.equal(h.channels.length,1); assert.equal(h.packets.length,0)
  finishSetup(); assert.equal((await starting).ok,false); await hiding; await replacement
  assert.equal(h.channels[0].closed,1); assert.equal(h.channels.length,2)
  await h.registry.dispose()
})

test('target revocation closes video and makes all later setup callbacks inert', async()=>{
  const h=framedHarness()
  await h.registry.setVisible('m','s',true)
  const channel=h.channels[0]; channel.session(); channel.frame(100)
  h.controller.abort()
  assert.equal(channel.closed,1); assert.equal(channel.callbacks.signal.aborted,true)
  assert.throws(()=>channel.callbacks.assertCurrent())
  await assert.rejects(channel.callbacks.verifyTarget())
  channel.session(); channel.frame(200)
  assert.equal(h.packets.length,1)
  assert.equal((await h.registry.setVisible('m','s',true)).ok,false)
  await h.registry.dispose()
})

test('malformed SESSION and regressive or unsafe producer PTS stop only the current video channel', async()=>{
  for(const failure of ['session','regressive','unsafe','missing-session']) {
    const h=framedHarness()
    await h.registry.setVisible('m','s',true)
    const channel=h.channels[0]
    if(failure==='missing-session') channel.frame(100)
    else {
      channel.session(); channel.frame(100)
      const packet=h.packets[0]; h.registry.acknowledge('m','s',packet.streamId,packet.timestampUs)
      if(failure==='session') channel.session(2401,2400)
      else channel.frame(failure==='regressive' ? 99:Number.MAX_SAFE_INTEGER+1,false)
    }
    assert.equal(channel.closed,1)
    const count=h.packets.length; channel.session(); channel.frame(300)
    assert.equal(h.packets.length,count)
    await h.registry.dispose()
  }
})

test('pressure recovery waits for the retired producer before its bounded retry starts', async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  let finishClose, closes=0
  const h=framedHarness({close:()=>++closes===1 ? new Promise(resolve=>{finishClose=resolve}):Promise.resolve()})
  await h.registry.setVisible('m','s',true)
  const channel=h.channels[0]; channel.session(); channel.frame(100)
  const packet=h.packets[0]; h.registry.acknowledge('m','s',packet.streamId,packet.timestampUs)
  channel.callbacks.onClosed()
  t.mock.timers.tick(20_000); await tick(); assert.equal(h.channels.length,1)
  finishClose(); await tick()
  t.mock.timers.tick(MOBILE_VIDEO_LIMITS.retryDelayMs); await tick()
  assert.equal(h.channels.length,2)
  await h.registry.dispose()
})

test('registry passes only the trusted server, executor and lease capabilities to its producer', async () => {
  const executor={run(){throw new Error('unused')},launch(){throw new Error('unused')}}
  const h=harness({executor})
  try {
    await h.registry.setVisible('m', 's', true)
    assert.equal(h.calls[0].serverPath,'C:\\app\\server.jar')
    assert.equal(h.calls[0].executor,executor)
    assert.equal(typeof h.calls[0].assertCurrent,'function')
    assert.equal(typeof h.calls[0].verifyTarget,'function')
    assert.equal(h.calls[0].signal.aborted,false)
  } finally {await h.registry.dispose()}
})

test('registry starts only one resolved owned framed producer and preserves monotonic native timestamps', async () => {
  const h = harness()
  try {
    assert.equal((await h.registry.setVisible('m', 's', true)).ok, true)
    assert.equal((await h.registry.setVisible('m', 's', true)).ok, true)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].serial,'emulator-5554')
    assert.equal(h.calls[0].executable,'C:\\Android SDK\\adb.exe')
    assert.equal(Object.hasOwn(h.calls[0],'args'),false)
    sendFrames(h.channels[0], 2)
    assert.equal(h.packets.length, 2)
    assert.ok(h.packets[1].timestampUs > h.packets[0].timestampUs)
    assert.equal(h.packets[0].missionId, 'm')
    assert.equal(h.packets[0].sessionId, 's')
  } finally { h.registry.dispose() }
})

test('registry refuses physical devices and resolver errors without spawn or raw errors', async () => {
  for (const resolveTarget of [async () => ({ ok: true, value: { executable: 'adb', serial: 'usb-device' } }), async () => { throw new Error('synthetic private detail') }]) {
    const h = harness({ resolveTarget })
    assert.equal((await h.registry.setVisible('m', 's', true)).ok, false)
    assert.equal(h.calls.length, 0)
    h.registry.dispose()
  }
})

test('video size caps the longest edge while preserving portrait and landscape proportions', async () => {
  for (const [width, height, expected] of [[1080, 2400, '1080x2400'], [1080, 2340, '1080x2340'], [1440, 3120, '1108x2400'], [2400, 1080, '2400x1080'], [4096, 4096, '2400x2400']]) {
    let resolutions = 0
    const target = { executable: 'adb', serial: 'emulator-5554', width, height }
    const h = harness({ resolveTarget: async () => { resolutions++; return { ok: true, value: target } } })
    try {
      assert.equal((await h.registry.setVisible('m', 's', true)).ok, true)
      await h.registry.setVisible('m', 's', true)
      const estimated=mobileVideoSize(width,height)
      assert.equal(`${estimated.width}x${estimated.height}`,expected)
      assert.equal(Object.hasOwn(h.calls[0],'width'),false,'producer SESSION supplies the actual aligned encoder geometry')
      assert.equal(resolutions, 1, 'idempotent visibility does not probe geometry again')
      assert.equal(target.width, width, 'stream scaling never changes Android geometry')
      assert.equal(target.height, height)
    } finally { h.registry.dispose() }
  }
})

test('video size keeps smaller and extremely narrow native displays unscaled', async () => {
  for (const [width, height] of [[720, 1600], [320, 640], [16, 16], [1, 1], [2, 8192]]) {
    const h = harness({ resolveTarget: async () => ({ ok: true, value: { executable: 'adb', serial: 'emulator-5554', width, height } }) })
    try {
      assert.equal((await h.registry.setVisible('m', 's', true)).ok, true)
      assert.deepEqual(mobileVideoSize(width,height),{width,height})
    } finally { h.registry.dispose() }
  }
})

test('video target geometry must be finite positive integral and bounded before starting any recorder', async () => {
  for (const [width, height] of [[undefined, undefined], [0, 2400], [-1080, 2400], [1080.5, 2400], [NaN, 2400], [1080, Infinity], ['1080', 2400], [8193, 2], [4097, 4097]]) {
    const h = harness({ resolveTarget: async () => ({ ok: true, value: { executable: 'adb', serial: 'emulator-5554', width, height } }) })
    try {
      assert.equal((await h.registry.setVisible('m', 's', true)).ok, false)
      assert.equal(h.calls.length, 0)
    } finally { h.registry.dispose() }
  }
})

test('hide, session close, mission close and dispose revoke an in-flight resolver before channel creation', async () => {
  for (const cancel of [h => h.registry.setVisible('m', 's', false), h => h.registry.closeSession('m', 's'), h => h.registry.closeMission('m'), h => h.registry.dispose()]) {
    let resolve
    const h = harness({ resolveTarget: () => new Promise(done => { resolve = done }) })
    const pending = h.registry.setVisible('m', 's', true)
    await tick()
    const closing=cancel(h)
    resolve({ ok: true, value: { executable: 'adb', serial: 'emulator-5554' } })
    await pending; await closing
    assert.equal(h.calls.length, 0)
    h.registry.dispose()
  }
})

test('hide closes only its own channel, discards late frames and prevents callback restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  await h.registry.setVisible('m', 's', true)
  await h.registry.setVisible('other', 's', true)
  await h.registry.setVisible('m', 's', false)
  assert.equal(h.channels[0].closeCount, 1)
  assert.equal(h.channels[1].closeCount, 0)
  sendFrames(h.channels[0])
  h.channels[0].fail()
  t.mock.timers.tick(20_000)
  await tick()
  assert.equal(h.packets.length, 0)
  assert.equal(h.calls.length, 2)
  h.registry.dispose()
})

test('registry bounds IPC packets in flight and invalid or repeated ACK cannot release a credit', async () => {
  const h = harness()
  try {
    await h.registry.setVisible('m', 's', true)
    sendFrames(h.channels[0], 8)
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight)
    const first = h.packets[0]
    h.registry.acknowledge('other', 's', first.streamId, first.timestampUs)
    h.registry.acknowledge('m', 's', 'stale', first.timestampUs)
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight)
    h.registry.acknowledge('m', 's', first.streamId, first.timestampUs)
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight + 1)
    assert.equal(h.packets.at(-1).key, false)
    h.registry.acknowledge('m', 's', first.streamId, first.timestampUs)
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight + 1)
  } finally { h.registry.dispose() }
})

test('ordinary ADB bursts preserve the entire delta chain behind bounded IPC credits', async () => {
  const h = harness()
  try {
    await h.registry.setVisible('m', 's', true)
    sendFrames(h.channels[0], 8)
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight)
    for (let index = 0; index < 8; index++) {
      const packet = h.packets[index]
      assert.ok(packet, `frame ${index + 1} must follow its references without waiting ten seconds for another IDR`)
      h.registry.acknowledge('m', 's', packet.streamId, packet.timestampUs)
      assert.ok(h.packets.length - index - 1 <= MOBILE_VIDEO_LIMITS.maxInFlight)
    }
    assert.deepEqual(h.packets.map(packet => packet.key), [true, false, false, false, false, false, false, false])
    assert.equal(h.channels[0].closeCount, 0)
    assert.ok(h.channels[0].pauseCount > 0)
    assert.ok(h.channels[0].resumeCount > 0)
  } finally { h.registry.dispose() }
})

test('a healthy static video remains on its persistent channel beyond the old screenrecord time limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  await h.registry.setVisible('m', 's', true)
  sendFrames(h.channels[0])
  const first = h.packets[0]
  h.registry.acknowledge('m', 's', first.streamId, first.timestampUs)
  h.setNow(181_000)
  t.mock.timers.tick(200_000)
  await tick()
  assert.equal(h.calls.length,1)
  assert.equal(h.channels[0].closeCount,0)
  sendFrames(h.channels[0])
  assert.equal(h.packets[1].streamId, first.streamId)
  assert.ok(h.packets[1].timestampUs > first.timestampUs)
  h.registry.dispose()
})

test('process errors have finite backoff and do not reset retry budget on a single successful frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  await h.registry.setVisible('m', 's', true)
  for (let i = 0; i <= MOBILE_VIDEO_LIMITS.maxRetries; i++) {
    const child = h.channels.at(-1)
    sendFrames(child)
    const packet = h.packets.at(-1)
    if (packet) h.registry.acknowledge('m', 's', packet.streamId, packet.timestampUs)
    child.fail()
    await tick()
    t.mock.timers.tick(10_000)
    await tick()
  }
  t.mock.timers.tick(100_000)
  await tick()
  assert.equal(h.calls.length, MOBILE_VIDEO_LIMITS.maxRetries + 1)
  assert.ok(h.channels.every(child => child.closeCount <= 1))
  h.registry.dispose()
})

test('missing ACK terminates the stream and dispose cancels its pending retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  await h.registry.setVisible('m', 's', true)
  sendFrames(h.channels[0])
  t.mock.timers.tick(MOBILE_VIDEO_LIMITS.ackTimeoutMs + 1)
  assert.equal(h.channels[0].closeCount, 1)
  h.registry.dispose()
  t.mock.timers.tick(60_000)
  await tick()
  assert.equal(h.calls.length, 1)
})

test('process restarts retain the same IPC credit window until old packets are acknowledged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  try {
    await h.registry.setVisible('m', 's', true)
    sendFrames(h.channels[0], MOBILE_VIDEO_LIMITS.maxInFlight)
    const previous = [...h.packets]
    h.setNow(181_000)
    h.channels[0].fail()
    await tick()
    t.mock.timers.tick(MOBILE_VIDEO_LIMITS.retryDelayMs)
    await tick()
    sendFrames(h.channels[1])
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight)
    for (const packet of previous) h.registry.acknowledge('m', 's', packet.streamId, packet.timestampUs)
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight + 1)
    assert.notEqual(h.packets.at(-1).streamId, previous[0].streamId)
  } finally { h.registry.dispose() }
})

test('channel errors are contained and late callbacks after disposal cannot restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  await h.registry.setVisible('m', 's', true)
  h.channels[0].fail()
  assert.equal(h.channels[0].closeCount, 1)
  h.registry.dispose()
  h.channels[0].fail()
  t.mock.timers.tick(60_000)
  await tick()
  assert.equal(h.channels.length, 1)
})

function decoderHarness(t, presentation = {}) {
  const decoders = [], states = [], frames = [], draws = [], copies = [], stages = [], consumed = [], recoveries = [], dimensions = [], observers = [], events = new Map(), visualEvents = new Map()
  let rect = presentation.rect ?? { left: 0, top: 0, width: 320, height: 640 }, reads = 0
  class Stage {
    constructor(width, height) { this.width = width; this.height = height; stages.push(this) }
    getContext(type) { assert.equal(type, '2d'); return { drawImage: (...args) => { if (presentation.failCopy) throw new Error('synthetic staging error'); copies.push(args) } } }
  }
  const view = { devicePixelRatio: presentation.dpr ?? 1, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    OffscreenCanvas: presentation.htmlFallback ? undefined : Stage,
    visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0, addEventListener: (name, fn) => visualEvents.set(name, fn), removeEventListener: name => visualEvents.delete(name) },
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this) } observe() {} disconnect() { this.closed = true } } }
  class Decoder {
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; this.outputIndex = 0; this.closes = 0; decoders.push(this) }
    configure(config) { this.config = config; this.state = 'configured' }
    decode(chunk) { this.chunks.push(chunk); this.decodeQueueSize++ }
    dequeue(count = 1) { this.decodeQueueSize = Math.max(0, this.decodeQueueSize - count); this.ondequeue?.() }
    close() { this.closes++; this.state = 'closed' }
    output(displayWidth = 320, displayHeight = 640) { const timestamp = this.chunks[this.outputIndex++]?.timestamp; this.dequeue(); const frame = { timestamp, displayWidth, displayHeight, closeCount: 0, close() { this.closeCount++ } }; frames.push(frame); this.callbacks.output(frame); return frame }
  }
  for (const name of ['VideoDecoder', 'EncodedVideoChunk']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    if (!previous) Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true })
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name] })
  }
  t.mock.property(globalThis, 'VideoDecoder', Decoder)
  t.mock.property(globalThis, 'EncodedVideoChunk', class { constructor(value) { Object.assign(this, value) } })
  const context = { fillRect() {}, drawImage: (...args) => draws.push(args) }
  const canvas = { width: 0, height: 0, style: { left: '', top: '', width: '', height: '' }, ownerDocument: { defaultView: view, visibilityState: 'visible', createElement: () => new Stage(0, 0) },
    parentElement: { getBoundingClientRect: () => { reads++; return rect } }, getContext(type) { assert.equal(type, '2d'); return context } }
  const player = createMobileVideoRenderer(canvas, state => states.push(state), { onConsumed: packet => consumed.push(packet.timestampUs), onRecovery: () => recoveries.push('requested'), onDimensions: size => dimensions.push(size) })
  return { player, canvas, context, decoders, states, frames, draws, copies, stages, consumed, recoveries, dimensions, observers, events, visualEvents, view, reads: () => reads,
    resize: next => { rect = next; observers.forEach(observer => observer.callback()) } }
}
const packet = (overrides = {}) => ({ missionId: 'm', sessionId: 's', streamId: 'stream-1', codec: 'avc1.42c01e', timestampUs: 1000, key: true, data: au(), ...overrides })

test('renderer configures Annex-B without avcC, draws Canvas 2D, and always closes frames/decoder', t => {
  const h = decoderHarness(t)
  h.player.push(packet())
  assert.equal(h.decoders.length, 1)
  assert.equal(h.decoders[0].config.description, undefined)
  assert.equal(h.decoders[0].config.optimizeForLatency, true)
  const frame = h.decoders[0].output()
  assert.equal(frame.closeCount, 1, 'the native copy releases the VideoFrame after painting')
  assert.deepEqual(h.copies[0], [frame, 0, 0, 320, 640]); assert.equal(h.draws[0][0], h.stages[0])
  assert.equal(h.canvas.width, 320)
  assert.equal(h.canvas.height, 640)
  assert.equal(h.states.at(-1), 'playing')
  h.player.dispose()
  assert.equal(frame.closeCount, 1)
  assert.equal(h.decoders[0].closes, 1)
  assert.equal(h.decoders[0].output().closeCount, 1)
  assert.equal(h.draws.length, 1)
})

for (const dpr of [1, 1.25, 2]) for (const landscape of [false, true]) {
  test(`presentation preserves source dimensions and aligns a fractional ${landscape ? 'landscape' : 'portrait'} surface at DPR${dpr}`, t => {
    const width = landscape ? 2400 : 1080, height = landscape ? 1080 : 2400
    const rect = { left: 26.078125, top: 121.375, width: landscape ? 652.984375 : 293.84375, height: landscape ? 293.84375 : 652.984375 }
    const h = decoderHarness(t, { rect, dpr }); h.player.push(packet()); h.decoders[0].output(width, height)
    assert.deepEqual(h.dimensions, [{ width, height }])
    assert.equal(h.canvas.width, Math.round(rect.width * dpr)); assert.equal(h.canvas.height, Math.round(rect.height * dpr))
    assert.ok(Math.abs((rect.left + parseFloat(h.canvas.style.left)) * dpr - Math.round(rect.left * dpr)) < 1e-9)
    assert.ok(Math.abs((rect.top + parseFloat(h.canvas.style.top)) * dpr - Math.round(rect.top * dpr)) < 1e-9)
    assert.equal(parseFloat(h.canvas.style.width) * dpr, h.canvas.width)
    assert.equal(h.context.imageSmoothingQuality, 'high')
    const draw = h.draws.at(-1); assert.ok(Math.abs(draw[3] / draw[4] - width / height) < 1e-12)
    const reads = h.reads(); h.player.push(packet({ key: false, data: au(false), timestampUs: 2000 })); h.decoders[0].output(width, height)
    assert.equal(h.reads(), reads, 'steady frames never read layout'); assert.equal(h.dimensions.length, 1)
    h.player.dispose(); assert.ok(h.frames.every(frame => frame.closeCount === 1))
  })
}

test('static resize and DPR changes repaint the retained native surface without copying, decoding or ACK traffic', t => {
  const h = decoderHarness(t); h.player.push(packet()); const frame = h.decoders[0].output(1080, 2400)
  h.resize({ left: .375, top: 5.25, width: 250.125, height: 555.75 })
  assert.equal(h.canvas.width, 250); assert.equal(h.draws.length, 2); assert.equal(h.draws.at(-1)[0], h.stages[0])
  h.view.devicePixelRatio = 2; h.events.get('resize')?.()
  assert.equal(h.canvas.width, 500); assert.equal(h.draws.length, 3)
  h.player.resize(); assert.equal(h.draws.length, 3, 'unchanged geometry does not repaint')
  assert.equal(h.decoders[0].chunks.length, 1); assert.deepEqual(h.consumed, [1000]); assert.equal(frame.closeCount, 1); assert.equal(h.copies.length, 1)
  h.player.dispose(); assert.equal(frame.closeCount, 1); assert.ok(h.observers.every(observer => observer.closed)); assert.equal(h.events.size, 0)
  assert.equal(h.stages[0].width, 0); assert.equal(h.stages[0].height, 0)
  h.resize({ left: 0, top: 0, width: 700, height: 900 }); assert.equal(h.draws.length, 3)
})

test('latest-rAF presentation retains only the newest frame, and errors or disposal close every frame exactly once', t => {
  const h = decoderHarness(t), pending = new Map(); let next = 0
  h.view.requestAnimationFrame = fn => { pending.set(++next, fn); return next }; h.view.cancelAnimationFrame = id => pending.delete(id)
  const flush = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn()) }
  for (let i = 0; i < 3; i++) { h.player.push(packet({ timestampUs: 1000 + i, key: i === 0, data: au(i === 0) })); h.decoders[0].output(1080, 2400) }
  assert.equal(pending.size, 1); assert.equal(h.draws.length, 0); assert.deepEqual(h.frames.map(frame => frame.closeCount), [1, 1, 0])
  flush(); assert.equal(h.draws.length, 1); assert.equal(h.copies[0][0].timestamp, 1002); assert.equal(h.copies.length, 1)
  h.context.drawImage = () => { throw new Error('synthetic lost context') }; h.resize({ left: 1, top: 0, width: 400, height: 900 }); flush()
  assert.equal(h.states.at(-1), 'fallback'); assert.deepEqual(h.frames.map(frame => frame.closeCount), [1, 1, 1])
  h.player.dispose(); assert.equal(pending.size, 0); assert.deepEqual(h.consumed, [1000, 1001, 1002])
})

test('visual viewport pinch and pan re-align a static frame using its scale and physical origin without changing layout', t => {
  const rect = { left: 26.078125, top: 121.375, width: 293.84375, height: 652.984375 }, h = decoderHarness(t, { rect })
  h.player.push(packet()); const frame = h.decoders[0].output(1080, 2400)
  Object.assign(h.view.visualViewport, { scale: 1.5, offsetLeft: .25, offsetTop: .375 }); h.visualEvents.get('resize')()
  assert.equal(h.canvas.width, 441); assert.equal(h.draws.at(-1)[0], h.stages[0]); assert.equal(h.copies[0][0], frame); assert.equal(h.copies.length, 1)
  for (const axis of ['left', 'top']) {
    const origin = h.view.visualViewport[axis === 'left' ? 'offsetLeft' : 'offsetTop']
    const pixel = (rect[axis] + parseFloat(h.canvas.style[axis]) - origin) * 1.5
    assert.ok(Math.abs(pixel - Math.round(pixel)) < 1e-9)
  }
  h.view.visualViewport.offsetLeft = .75; h.visualEvents.get('scroll')(); assert.equal(h.draws.length, 3)
  assert.equal(h.decoders[0].chunks.length, 1); h.player.dispose(); assert.equal(h.visualEvents.size, 0); assert.equal(frame.closeCount, 1)
})

test('one bounded native stage is reused across frames/rotation and released at stream switch, copy failure or disposal', t => {
  const h = decoderHarness(t); h.player.push(packet()); h.decoders[0].output(1080, 2400)
  h.player.push(packet({ timestampUs: 2000, key: false, data: au(false) })); h.decoders[0].output(2400, 1080)
  assert.equal(h.stages.length, 1); assert.deepEqual(h.copies.map(copy => copy.slice(1)), [[0, 0, 1080, 2400], [0, 0, 2400, 1080]])
  const old = h.stages[0]; assert.equal(old.width, 2400)
  h.player.push(packet({ streamId: 'new-stream', timestampUs: 3000 })); assert.equal(old.width, 0); assert.equal(old.height, 0)
  h.decoders[1].output(1080, 2400); assert.equal(h.stages.length, 2)
  h.decoders[1].callbacks.error(new Error('synthetic lost decoder')); assert.equal(h.stages[1].width, 0); assert.equal(h.stages[1].height, 0)
  h.player.dispose(); assert.ok(h.frames.every(frame => frame.closeCount === 1))
})
for (const mode of ['htmlFallback', 'failCopy']) test(`native stage handles ${mode} without retaining a VideoFrame or stale surface`, t => {
  const h = decoderHarness(t, { [mode]: true }); h.player.push(packet()); const frame = h.decoders[0].output(1080, 2400)
  assert.equal(frame.closeCount, 1); assert.equal(h.stages.length, 1)
  assert.equal(h.states.at(-1), mode === 'failCopy' ? 'fallback' : 'playing')
  h.player.dispose(); assert.equal(h.stages[0].width, 0); assert.equal(h.stages[0].height, 0)
})

test('renderer ignores stale stream, stale timestamps and other sessions; a fresh key switches decoders', t => {
  const h = decoderHarness(t)
  h.player.push(packet())
  h.player.push(packet({ streamId: 'stream-2', timestampUs: 2000 }))
  h.player.push(packet({ timestampUs: 1500 }))
  h.player.push(packet({ missionId: 'other', streamId: 'stream-3', timestampUs: 3000 }))
  h.player.push(packet({ streamId: 'stream-2', timestampUs: 1999 }))
  assert.equal(h.decoders.length, 2)
  assert.equal(h.decoders[0].closes, 1)
  assert.equal(h.decoders[1].chunks.length, 1)
  h.player.dispose()
})

test('renderer decoder errors close state and require SPS/PPS/IDR before recovery', t => {
  const h = decoderHarness(t)
  h.player.push(packet())
  h.player.push(packet({ key: false, data: au(false), timestampUs: 2000 }))
  h.decoders[0].callbacks.error(new Error('synthetic decode failure'))
  assert.equal(h.decoders[0].closes, 1)
  assert.deepEqual(h.consumed, [1000, 2000])
  assert.equal(h.recoveries.length, 1)
  h.player.push(packet({ key: true, data: nal(slice(true)), timestampUs: 3000 }))
  h.player.push(packet({ key: false, data: au(false), timestampUs: 4000 }))
  assert.equal(h.decoders.length, 1)
  h.player.push(packet({ timestampUs: 5000 }))
  assert.equal(h.decoders.length, 2)
  h.decoders[1].callbacks.error(new Error('decode error'))
  assert.equal(h.decoders[1].closes, 1)
  h.player.push(packet({ timestampUs: 6000 }))
  assert.equal(h.decoders.length, 3)
  h.player.dispose()
})

test('pending decode stalls into fallback, disposal cancels timers, and absent WebCodecs uses fallback', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = decoderHarness(t)
  h.player.push(packet())
  h.decoders[0].output()
  h.player.push(packet({ timestampUs: 2000, key: false, data: au(false) }))
  t.mock.timers.tick(3000)
  assert.equal(h.states.at(-1), 'fallback')
  assert.equal(h.decoders[0].closes, 1)
  assert.deepEqual(h.consumed, [1000, 2000])
  assert.equal(h.recoveries.length, 1)
  h.player.dispose()
  const count = h.states.length
  t.mock.timers.tick(60_000)
  assert.equal(h.states.length, count)
  Object.defineProperty(globalThis, 'VideoDecoder', { value: undefined, configurable: true, writable: true })
  const states = []
  const absent = createMobileVideoRenderer({ getContext: () => ({}) }, state => states.push(state))
  absent.push(packet())
  assert.deepEqual(states, ['fallback'])
  absent.dispose()
})

test('decoder pressure drains a short FIFO instead of discarding healthy reference frames', t => {
  const h = decoderHarness(t)
  for (let index = 0; index < 8; index++) h.player.push(packet({ timestampUs: 1000 + index * 1000, key: index === 0, data: au(index === 0) }))
  assert.equal(h.decoders.length, 1)
  assert.equal(h.decoders[0].closes, 0, 'a normal asynchronous decode queue must not reset AVC references')
  assert.equal(h.consumed.length, 0, 'IPC credit must remain held until the decoder consumes the frame')
  for (let index = 0; index < 8; index++) {
    assert.ok(h.decoders[0].chunks[index], `queued frame ${index + 1} must be fed after decoder progress`)
    h.decoders[0].output()
  }
  assert.deepEqual(h.consumed, Array.from({ length: 8 }, (_, index) => 1000 + index * 1000))
  assert.equal(h.decoders[0].closes, 0)
  assert.equal(h.recoveries.length, 0)
  h.player.dispose()
})

test('a static Android screen preserves decoder references and resumes immediately on the next delta', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = decoderHarness(t)
  h.player.push(packet())
  h.decoders[0].output()
  t.mock.timers.tick(12_000)
  assert.equal(h.states.at(-1), 'playing')
  assert.equal(h.decoders[0].closes, 0)
  h.player.push(packet({ timestampUs: 2000, key: false, data: au(false) }))
  assert.equal(h.decoders[0].chunks.length, 2)
  h.decoders[0].output()
  assert.deepEqual(h.consumed, [1000, 2000])
  h.player.dispose()
})

test('a genuinely overfull main queue restarts promptly with a fresh key and retains bounded credits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  try {
    await h.registry.setVisible('m', 's', true)
    sendFrames(h.channels[0], MOBILE_VIDEO_LIMITS.maxInFlight + MOBILE_VIDEO_LIMITS.maxQueuedUnits + 1)
    const old = [...h.packets]
    assert.equal(old.length, MOBILE_VIDEO_LIMITS.maxInFlight)
    assert.equal(h.channels[0].closeCount, 1)
    await tick()
    t.mock.timers.tick(MOBILE_VIDEO_LIMITS.pressureRetryDelayMs)
    await tick()
    assert.equal(h.channels.length, 2)
    sendFrames(h.channels[1])
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight)
    h.registry.acknowledge('m', 's', old[0].streamId, old[0].timestampUs)
    const fresh = h.packets.at(-1)
    assert.notEqual(fresh.streamId, old[0].streamId)
    assert.equal(fresh.key, true)
    assert.deepEqual(nalTypes(fresh.data), [7, 8, 5])
  } finally { h.registry.dispose() }
})

test('queue age is bounded and hiding during pressure recovery prevents a new process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  try {
    await h.registry.setVisible('m', 's', true)
    sendFrames(h.channels[0], 8)
    h.setNow(1000 + MOBILE_VIDEO_LIMITS.maxQueueAgeMs)
    t.mock.timers.tick(MOBILE_VIDEO_LIMITS.maxQueueAgeMs)
    assert.equal(h.channels[0].closeCount, 1)
    await h.registry.setVisible('m', 's', false)
    t.mock.timers.tick(60_000)
    await tick()
    assert.equal(h.channels.length, 1)
    assert.equal(h.packets.length, MOBILE_VIDEO_LIMITS.maxInFlight)
  } finally { h.registry.dispose() }
})

test('decoder queue caps settle every packet, request recovery once, and reject late work after disposal', t => {
  const h = decoderHarness(t)
  for (let index = 0; index < 30; index++) h.player.push(packet({ timestampUs: index + 1, key: index === 0, data: au(index === 0) }))
  assert.equal(h.decoders.length, 1)
  assert.equal(h.decoders[0].chunks.length, 4)
  assert.equal(h.decoders[0].closes, 1)
  assert.equal(new Set(h.consumed).size, 30)
  assert.equal(h.recoveries.length, 1)
  h.player.dispose()
  h.player.push(packet({ timestampUs: 31 }))
  assert.equal(h.decoders.length, 1)
  assert.equal(h.consumed.at(-1), 31)
  assert.equal(h.decoders[0].output().closeCount, 1)
})

test('main-to-decoder transport preserves 24 burst frames while releasing only consumed credits', async t => {
  const decoded = decoderHarness(t)
  const emitted = []
  const main = harness({ emit: packet => { emitted.push(packet); decoded.player.push(packet) } })
  try {
    await main.registry.setVisible('m', 's', true)
    sendFrames(main.channels[0], 24)
    assert.equal(emitted.length, MOBILE_VIDEO_LIMITS.maxInFlight)
    for (let index = 0; index < 24; index++) {
      const decoder = decoded.decoders[0]
      assert.ok(decoder.chunks[index], `frame ${index + 1} keeps its reference chain`)
      decoder.output()
      const consumed = decoded.consumed[index]
      const packet = emitted.find(packet => packet.timestampUs === consumed)
      assert.ok(packet)
      main.registry.acknowledge('m', 's', packet.streamId, consumed)
      assert.ok(emitted.length - decoded.consumed.length <= MOBILE_VIDEO_LIMITS.maxInFlight)
    }
    assert.equal(decoded.decoders.length, 1)
    assert.equal(decoded.decoders[0].closes, 0)
    assert.equal(decoded.draws.length, 24)
    assert.equal(main.channels[0].closeCount, 0)
  } finally { main.registry.dispose(); decoded.player.dispose() }
})

async function screenHarness(t, options = {}) {
  const decoder = decoderHarness(t)
  const calls = [], acks = [], ackTokens = [], captureTokens = [], leaseCalls = []
  let listener, current, tree, visible = true
  let visibilityResult = async () => ({ ok: true, value: undefined })
  let captureResult = options.capture ?? (async () => ({ ok: true, value: { sessionId: 's', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', width: 1, height: 1, capturedAt: 1 } }))
  const api = {
    inspect() {}, start() {}, stop() {}, act() {}, onChanged() {},
    acquireView: async () => { leaseCalls.push(['acquire']); return options.acquire ? options.acquire() : { ok: true, value: { consumerId: 'test-screen-consumer' } } },
    releaseView: async (_mission, _session, token) => { leaseCalls.push(['release', token]); return { ok: true, value: undefined } },
    onVideo: callback => { listener = callback; return () => { listener = undefined } },
    setVideoVisible: async (missionId, sessionId, value) => { calls.push(['visible', value]); return visibilityResult(value) },
    ackVideo: (_missionId, _sessionId, _streamId, timestamp, token) => { acks.push(timestamp); ackTokens.push([timestamp, token]) },
    capture: async (_mission, _session, token) => { calls.push(['capture']); captureTokens.push(token); return captureResult() }
  }
  const compiled = buildSync({ stdin: { contents: "export { useMobileScreen } from './useMobileScreen'", resolveDir: 'src/renderer/src', loader: 'tsx' }, bundle: true,
    platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'react-dom'] }).outputFiles[0].text
  const module = { exports: {} }
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  new Function('require', 'module', 'exports', 'window', 'document', compiled)(createRequire(import.meta.url), module, module.exports, { synkora: { mobile: api } }, document)
  const canvas = { current: decoder.canvas }
  let session = { id: 's', missionId: 'm', platform: 'android', state: 'ready' }
  function Probe() { current = module.exports.useMobileScreen('m', session, visible, canvas, 0); return null }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await act(async () => { tree = create(React.createElement(Probe)); await tick() })
  t.after(async () => { await act(() => tree.unmount()); decoder.player.dispose() })
  return { ...decoder, calls, acks, ackTokens, captureTokens, leaseCalls, current: () => current,
    push: value => act(() => listener?.({ consumerId: 'test-screen-consumer', ...value })),
    output: (...size) => act(() => { decoder.decoders.at(-1).output(...size) }),
    hide: () => act(() => { visible = false; tree.update(React.createElement(Probe)) }),
    show: () => act(async () => { visible = true; tree.update(React.createElement(Probe)); await tick() }),
    profile: value => act(async () => { session = { ...session, displayProfileId: value }; tree.update(React.createElement(Probe)); await tick() }),
    captureResult: callback => { captureResult = callback },
    result: callback => { visibilityResult = callback } }
}

test('the screen hook ACKs after decoding and static health checks create no PNG traffic', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = await screenHarness(t)
  await h.push(packet())
  assert.equal(h.acks.length, 0)
  await h.output()
  assert.deepEqual(h.acks, [1000])
  assert.equal(h.current().playing, true)
  const captures = h.calls.filter(call => call[0] === 'capture').length
  for (let index = 0; index < 6; index++) await act(async () => { t.mock.timers.tick(2000); await tick() })
  assert.equal(h.current().playing, true)
  assert.equal(h.decoders[0].closes, 0)
  assert.equal(h.calls.filter(call => call[0] === 'capture').length, captures)
  assert.ok(h.calls.filter(call => call[0] === 'visible' && call[1]).length > 1)
  await h.hide()
  const visibleCalls = h.calls.length
  await act(async () => { t.mock.timers.tick(20_000); await tick() })
  assert.equal(h.calls.length, visibleCalls)
})

test('consumer handover ignores foreign packets and settles decoded or disposed work with its original token', async t => {
  let generation = 0
  const h = await screenHarness(t, { acquire: async () => ({ ok: true, value: { consumerId: `view-${++generation}` } }) })
  await h.push(packet({ consumerId: 'other-view' }))
  assert.equal(h.decoders.length, 0); assert.deepEqual(h.ackTokens, [])
  await h.push(packet({ consumerId: 'view-1' })); await h.output()
  assert.deepEqual(h.ackTokens, [[1000, 'view-1']])
  await h.push(packet({ consumerId: 'view-1', timestampUs: 2000, key: false, data: au(false) }))
  const old = h.decoders[0]
  await h.hide(); await h.show()
  assert.deepEqual(h.ackTokens, [[1000, 'view-1'], [2000, 'view-1']])
  assert.equal(h.current().consumerId, 'view-2'); assert.equal(h.current().playing, false)
  assert.ok(h.leaseCalls.some(call => call[0] === 'release' && call[1] === 'view-1'))
  await h.push(packet({ consumerId: 'view-1', streamId: 'stale-unseen', timestampUs: 3000 }))
  assert.equal(h.decoders.length, 1); assert.equal(h.ackTokens.length, 2)
  await act(() => { assert.equal(old.output().closeCount, 1) })
  await h.push(packet({ consumerId: 'view-2', streamId: 'fresh-view', timestampUs: 4000 })); await h.output()
  assert.deepEqual(h.ackTokens.at(-1), [4000, 'view-2']); assert.equal(h.current().playing, true)
})

test('a new view token still waits for the previous same-session capture and discards its pixels', async t => {
  let generation = 0, captures = 0, finishOld
  const old = new Promise(resolve => { finishOld = resolve })
  const frame = width => ({ ok: true, value: { sessionId: 's', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', width, height: width * 2, capturedAt: 1 } })
  const h = await screenHarness(t, { acquire: async () => ({ ok: true, value: { consumerId: `capture-view-${++generation}` } }), capture: async () => ++captures === 1 ? old : frame(640) })
  assert.equal(captures, 1)
  await h.hide(); await h.show()
  assert.equal(h.current().consumerId, 'capture-view-2'); assert.equal(captures, 1, 'ownership changes cannot overlap the native screenshot invocation')
  assert.equal(h.current().source, null)
  await act(async () => { finishOld(frame(320)); await tick() })
  assert.equal(captures, 2); assert.equal(h.current().frame.width, 640)
  assert.deepEqual(h.captureTokens, ['capture-view-1', 'capture-view-2'])
})

test('a hidden screen cannot restart from an in-flight recovery response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = await screenHarness(t)
  await h.push(packet())
  await h.output()
  let resolveStop
  h.result(visible => visible ? Promise.resolve({ ok: false, error: 'synthetic unavailable' }) : new Promise(resolve => { resolveStop = resolve }))
  await act(async () => { t.mock.timers.tick(2000); await tick() })
  assert.equal(h.current().playing, false)
  assert.equal(h.calls.at(-1)[1], false)
  const recoveryStop = resolveStop
  await h.hide()
  const count = h.calls.filter(call => call[0] === 'visible' && call[1]).length
  await act(async () => { recoveryStop({ ok: true, value: undefined }); await tick(); t.mock.timers.tick(5000); await tick() })
  assert.equal(h.calls.filter(call => call[0] === 'visible' && call[1]).length, count)
})

test('an applied display profile retires old stream pixels and dimensions until a fresh stream arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = await screenHarness(t)
  await h.push(packet())
  await h.output()
  assert.equal(h.current().playing, true)
  assert.equal(h.current().videoSize.width, 320)
  h.captureResult(() => new Promise(() => {}))
  const before = h.calls.filter(call => call[0] === 'visible').length
  await h.profile('pixel-9')
  assert.equal(h.current().playing, false, 'the old profile must stop displaying immediately')
  assert.equal(h.current().source, null)
  assert.equal(h.current().videoSize.width, 0)
  assert.equal(h.current().videoSize.height, 0)
  assert.equal(h.canvas.width, 0)
  assert.equal(h.canvas.height, 0)
  assert.equal(h.decoders[0].closes, 1)
  assert.deepEqual(h.calls.filter(call => call[0] === 'visible').slice(before).map(call => call[1]), [false, true])
  await h.push(packet({ timestampUs: 2000 }))
  assert.equal(h.decoders.length, 1, 'an old keyframe cannot restore the previous resolution')
  assert.equal(h.acks.at(-1), 2000)
  await h.push(packet({ streamId: 'profile-stream', timestampUs: 3000 }))
  await h.output(412, 915)
  assert.equal(h.current().playing, true)
  assert.equal(h.current().videoSize.width, 412)
  assert.equal(h.current().videoSize.height, 915)
  await h.push(packet({ streamId: 'unseen-stale-stream', timestampUs: 2500 }))
  await h.push(packet({ streamId: 'profile-stream', timestampUs: 4000, key: false, data: au(false) }))
  assert.equal(h.decoders.at(-1).chunks.length, 2, 'an out-of-order obsolete stream must not retire the fresh stream')
  const calls = h.calls.length
  await h.profile('pixel-9')
  assert.equal(h.calls.length, calls, 'publishing the same applied profile does not restart video')
})

test('profile changes await the old session capture and discard its old geometry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let resolveOld, resolveNew, captures = 0
  const old = new Promise(resolve => { resolveOld = resolve })
  const fresh = new Promise(resolve => { resolveNew = resolve })
  const h = await screenHarness(t, { capture: () => ++captures === 1 ? old : fresh })
  await h.profile('galaxy-s25')
  assert.equal(captures, 1, 'changing geometry must preserve the single capture per session')
  await act(async () => { resolveOld({ ok: true, value: { sessionId: 's', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', width: 320, height: 640, capturedAt: 1 } }); await tick() })
  assert.equal(captures, 2, 'the replacement view requests a fresh image after old capture settles')
  assert.equal(h.current().source, null)
  await act(async () => { resolveNew({ ok: true, value: { sessionId: 's', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', width: 412, height: 915, capturedAt: 2 } }); await tick() })
  assert.equal(h.current().frame.width, 412)
  assert.equal(h.current().frame.height, 915)
})

test('profile changes invalidate old recovery continuations and remain stopped when hidden', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = await screenHarness(t)
  await h.push(packet())
  await h.output()
  let resolveRecovery
  h.result(visible => visible ? Promise.resolve({ ok: false, error: 'synthetic unavailable' }) : new Promise(resolve => { resolveRecovery = resolve }))
  await act(async () => { t.mock.timers.tick(2000); await tick() })
  assert.equal(typeof resolveRecovery, 'function')
  h.result(async () => ({ ok: true, value: undefined }))
  await h.profile('pixel-9')
  const starts = h.calls.filter(call => call[0] === 'visible' && call[1]).length
  assert.equal(h.current().playing, false)
  assert.equal(h.decoders.length, 1, 'the replacement also waits for the older recovery stop')
  await act(async () => { resolveRecovery({ ok: true, value: undefined }); await tick() })
  assert.equal(h.calls.filter(call => call[0] === 'visible' && call[1]).length, starts + 1)
  await h.push(packet({ streamId: 'profile-after-recovery', timestampUs: 2000 }))
  await h.output(412, 915)
  assert.equal(h.current().playing, true)
  await h.hide()
  await h.profile('galaxy-s25')
  await act(async () => { t.mock.timers.tick(10_000); await tick() })
  assert.equal(h.calls.filter(call => call[0] === 'visible' && call[1]).length, starts + 1)
  assert.equal(h.current().playing, false)
  assert.equal(h.canvas.width, 0)
})

test('a profile generation waits for stop acknowledgement before accepting an unseen old keyframe', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = await screenHarness(t)
  let resolveStop
  const stopped = new Promise(resolve => { resolveStop = resolve })
  h.result(visible => visible ? Promise.resolve({ ok: true, value: undefined }) : stopped)
  const starts = h.calls.filter(call => call[0] === 'visible' && call[1]).length
  await h.profile('pixel-9')
  await h.push(packet({ streamId: 'old-recorder-never-observed', timestampUs: 1000 }))
  assert.equal(h.decoders.length, 0, 'an unseen key from the previous recorder cannot initialize the new view before stop completes')
  assert.deepEqual(h.acks, [1000])
  assert.equal(h.current().playing, false)
  assert.equal(h.current().videoSize.width, 0)
  await act(async () => { t.mock.timers.tick(6000); await tick() })
  assert.equal(h.calls.filter(call => call[0] === 'visible' && call[1]).length, starts, 'health checks cannot cross the pending stop barrier')
  h.result(async () => ({ ok: true, value: undefined }))
  await act(async () => { resolveStop({ ok: true, value: undefined }); await tick() })
  assert.equal(h.calls.filter(call => call[0] === 'visible' && call[1]).length, starts + 1)
  await h.push(packet({ streamId: 'new-profile-recorder', timestampUs: 2000 }))
  await h.output(720, 1600)
  assert.equal(h.current().playing, true)
  assert.equal(h.current().videoSize.width, 720)
  assert.equal(h.current().videoSize.height, 1600)
})

test('hiding before a profile stop acknowledgement prevents its delayed start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = await screenHarness(t)
  let resolveStop
  const stopped = new Promise(resolve => { resolveStop = resolve })
  h.result(visible => visible ? Promise.resolve({ ok: true, value: undefined }) : stopped)
  const starts = h.calls.filter(call => call[0] === 'visible' && call[1]).length
  await h.profile('pixel-9')
  await h.hide()
  await act(async () => { resolveStop({ ok: true, value: undefined }); await tick(); t.mock.timers.tick(6000); await tick() })
  assert.equal(h.calls.filter(call => call[0] === 'visible' && call[1]).length, starts)
  assert.equal(h.decoders.length, 0)
  assert.equal(h.current().playing, false)
})

test('failed stop acknowledgements never allow health checks to reopen an unconfirmed profile generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const h = await screenHarness(t)
  const starts = h.calls.filter(call => call[0] === 'visible' && call[1]).length
  h.result(async visible => visible ? { ok: true, value: undefined } : { ok: false, error: 'synthetic stop failure' })
  await h.profile('pixel-9')
  for (let index = 0; index < 4; index++) await act(async () => { t.mock.timers.tick(2000); await tick() })
  await h.push(packet({ streamId: 'unconfirmed-recorder', timestampUs: 1000 }))
  assert.equal(h.calls.filter(call => call[0] === 'visible' && call[1]).length, starts)
  assert.equal(h.decoders.length, 0)
  assert.equal(h.current().playing, false)
})

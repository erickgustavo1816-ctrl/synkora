import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { MobileRuntimeManager } from '../.tmp/mobile-runtime-test/main/mobileRuntime.js'
import { quoteAndroidArgument, validateMobileAction, resolveMobileInstallPath } from '../.tmp/mobile-runtime-test/main/mobileCommands.js'
import { parseAndroidDevices, parseIosDevices } from '../.tmp/mobile-runtime-test/main/mobileDiscovery.js'
import { readMobilePng } from '../.tmp/mobile-runtime-test/main/mobileImage.js'
import { MobileProcessError, mobileExecutor, mobileProcessEnvironment } from '../.tmp/mobile-runtime-test/main/mobileProcess.js'

const presentationBuild = buildSync({ entryPoints: ['src/main/mobilePresentation.ts'], bundle: true, platform: 'node', format: 'cjs', write: false })
const presentationModule = { exports: {} }
new Function('require', 'module', 'exports', presentationBuild.outputFiles[0].text)(createRequire(import.meta.url), presentationModule, presentationModule.exports)
const { MobilePresentationManager } = presentationModule.exports

function crc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) { crc ^= value; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
function png(width = 108, height = 192) {
  const chunk = (name, data) => {
    const type = Buffer.from(name); const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length); type.copy(out, 4); data.copy(out, 8)
    out.writeUInt32BE(crc32(Buffer.concat([type, data])), out.length - 4); return out
  }
  const head = Buffer.alloc(13); head.writeUInt32BE(width); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))])
}
const cap = platform => ({ platform, supported: true, available: true, inputAvailable: true, title: platform, setupSteps: [], docsUrl: 'https://example.invalid' })
const androidDisplay=(width=108,height=192,rotation=0,id=0,valid=true)=>
  `Displays:\nDisplay id ${id}: DisplayInfo{"Synthetic Screen", displayId ${id}, real ${width} x ${height}, largest app 90 x 170, rotation ${rotation}, state ON}, DisplayMetrics{width=90, height=170}, isValid=${valid}\n`
function fixture(options = {}) {
  const calls = [], launches = [], children = [], changes = [], closed = [], running = new Map()
  const display={physicalSize:{width:108,height:192},physicalDensity:420,overrideSize:options.originalSize ?? null,overrideDensity:options.originalDensity ?? null}
  let current = { projectId: 'p1', rootPath: resolve('.') }
  const discovery = {
    hostPlatform: options.platform ?? 'win32', platforms: [cap('android'), cap('ios')],
    devices: [{ id: 'Synkora_A', platform: 'android', name: 'A', state: 'available' }, { id: 'Synkora_B', platform: 'android', name: 'B', state: 'available' },
      { id: '12345678-1234-1234-1234-123456789ABC', platform: 'ios', name: 'iPhone', state: 'available' }],
    tools: { adb: 'adb', emulator: 'emulator', xcrun: 'xcrun', ...(options.noIdb ? {} : { idb: 'idb' }) },
    androidSerials: {}, androidDiscoveryIncomplete: false
  }
  const executor = {
    async run(command) {
      calls.push(command)
      if (command.signal?.aborted) throw new Error('cancelled')
      if (options.run) { const result = await options.run(command); if (result !== undefined) return { stdout: result } }
      const a = command.args
      const shell=a.at(-1)
      if (shell === "'wm' 'size'") return {stdout:Buffer.from(`Physical size: ${display.physicalSize.width}x${display.physicalSize.height}\n${display.overrideSize && (display.overrideSize.width !== display.physicalSize.width || display.overrideSize.height !== display.physicalSize.height) ? `Override size: ${display.overrideSize.width}x${display.overrideSize.height}\n`:''}`)}
      if (shell === "'wm' 'density'") return {stdout:Buffer.from(`Physical density: ${display.physicalDensity}\n${display.overrideDensity && display.overrideDensity !== display.physicalDensity ? `Override density: ${display.overrideDensity}\n`:''}`)}
      const size=/^'wm' 'size' '(reset|\d+x\d+)'$/u.exec(shell ?? '')
      if (size) { const [width,height]=size[1].split('x').map(Number); display.overrideSize=size[1] === 'reset' ? null:{width,height}; return {stdout:Buffer.alloc(0)} }
      const density=/^'wm' 'density' '(reset|\d+)'$/u.exec(shell ?? '')
      if (density) { display.overrideDensity=density[1] === 'reset' ? null:Number(density[1]); return {stdout:Buffer.alloc(0)} }
      if (shell === "'cmd' 'display' 'get-displays'") { const dimensions=display.overrideSize ?? display.physicalSize; return { stdout:Buffer.from(androidDisplay(dimensions.width,dimensions.height)) } }
      if (a.includes('screencap') || a.includes('screenshot')) return { stdout: png() }
      if (a.includes('get-state')) {
        if (!running.has(a[1])) throw new Error('offline')
        return { stdout: Buffer.from('device\n') }
      }
      if (a.includes('emu') && a.includes('name')) return { stdout: Buffer.from(`${running.get(a[1]) ?? ''}\nOK\n`) }
      if (a.includes('emu') && a.includes('kill')) { running.delete(a[1]); return { stdout: Buffer.alloc(0) } }
      if (a.some(x => x.includes('sys.boot_completed'))) return { stdout: Buffer.from('1\n') }
      if (a.some(x => x.includes("'am' 'start'"))) return { stdout: Buffer.from('Status: ok\nComplete\n') }
      if (a[0] === 'describe') return { stdout: Buffer.from(JSON.stringify({ udid: discovery.devices[2].id, screen_dimensions: { width: 108, height: 192, width_points: 36, height_points: 64, density: 3 } })) }
      if (a.includes('list')) return { stdout: Buffer.from(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: discovery.devices[2].id, name: 'iPhone', state: 'Shutdown', isAvailable: true }] } })) }
      return { stdout: Buffer.alloc(0) }
    },
    async launch(command) {
      launches.push(command)
      const serial = `emulator-${command.args[command.args.indexOf('-port') + 1]}`
      running.set(serial, command.args[command.args.indexOf('-avd') + 1])
      let alive = true, finish
      const exited = new Promise(resolve => { finish = resolve })
      const child = { isAlive: () => alive, exited, crash() { alive = false; finish() }, async stop() { alive = false; running.delete(serial); finish(); return true } }
      children.push(child); return child
    }
  }
  const manager = new MobileRuntimeManager({ resolveMission: () => current,
    discover: signal => options.discover ? options.discover(signal,discovery) : Promise.resolve(discovery), executor, portAvailable: options.portAvailable ?? (async () => true),
    managedApkRoot:options.managedApkRoot, inputServerPath:options.inputServerPath, inputFactory:options.inputFactory,
    bootTimeoutMs: options.bootTimeoutMs ?? 1000, pollMs: 1,
    onChanged: id => changes.push(id), onSessionClosed: (...args) => closed.push(args) })
  return { manager, calls, launches, children, discovery, running, display, changes, closed, setScope: value => { current = value } }
}
const android = (deviceId = 'Synkora_A') => ({ platform: 'android', deviceId })
const agent = paneId => ({ kind: 'agent', paneId })

test('sessionSnapshot returns fresh detached copies without SDK queries and denies changed scope', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  const started = await f.manager.start('m', android())
  const before = f.calls.length
  const initial = f.manager.sessionSnapshot('m', started.value.id)
  assert.equal(initial.ok, true); assert.equal(f.calls.length, before)
  initial.value.deviceName = 'caller mutation'
  assert.notEqual(f.manager.sessionSnapshot('m', started.value.id).value.deviceName, 'caller mutation')
  await f.manager.act('m', started.value.id, { type: 'displayProfile', profileId: 'pixel-9' })
  assert.equal(f.manager.sessionSnapshot('m', started.value.id).value.displayProfileId, 'pixel-9')
  assert.equal(f.manager.sessionSnapshot('other', started.value.id).ok, false)
  f.setScope({ projectId: 'p2', rootPath: resolve('.') })
  assert.equal(f.manager.sessionSnapshot('m', started.value.id).ok, false)
})

function liveInputFixture(options={}) {
  const touches=[], cancellations=[], preparations=[]
  let open=true, closes=0, currentOptions
  const channel={
    touch(event,geometry) {currentOptions.assertCurrent(); if (!open) throw new Error('closed'); touches.push({...event,geometry:{...geometry}})},
    cancel() {if (open) {currentOptions.assertCurrent(); cancellations.push({aborted:currentOptions.signal.aborted})}},
    async flush() {if (!open) throw new Error('closed'); if (options.flush) await options.flush()},
    async close() {closes++; open=false; currentOptions.onClosed?.()},
    alive() {return open && !currentOptions?.signal.aborted}
  }
  const f=fixture({...options,inputServerPath:'trusted-scrcpy-server',inputFactory:async inputOptions=>{
    currentOptions=inputOptions; preparations.push(inputOptions); inputOptions.assertCurrent(); await inputOptions.verifyTarget()
    if (options.prepare) await options.prepare(inputOptions)
    return channel
  }})
  return {...f,touches,cancellations,preparations,channel,get closes(){return closes},disconnect(){open=false; currentOptions.onClosed?.()}}
}
const pointer=(phase,gestureId='gesture_1',x=0.2,y=0.3)=>({phase,gestureId,x,y})
function deferred() {let resolve; const promise=new Promise(done=>{resolve=done}); return {promise,resolve}}

test('presentation handover cancels a real runtime DOWN still awaiting display geometry', async t => {
  const entered = deferred(), release = deferred()
  const f = liveInputFixture({ run: async command => {
    if (command.args.at(-1) === "'cmd' 'display' 'get-displays'") { entered.resolve(); await release.promise }
    return undefined
  } })
  t.after(() => f.manager.dispose())
  const started = await f.manager.start('m', android()), session = started.value
  const presentation = new MobilePresentationManager({
    resolveScope: () => ({ projectId: 'p1', rootPath: resolve('.') }),
    snapshot: (m, s) => f.manager.sessionSnapshot(m, s),
    capture: (m, s) => f.manager.capture(m, s),
    act: (m, s, action, signal) => f.manager.act(m, s, action, { kind: 'owner' }, signal),
    pointer: (m, s, input) => f.manager.pointer(m, s, input),
    video: { closeSession: async () => {}, setVisible: async () => ({ ok: true }), acknowledge() {} },
    createWindow: () => ({ ready: Promise.resolve(), focus() {}, destroy() {}, notify() {}, resize: size => ({ ...size, clamped: false }) }),
    onChanged() {}
  })
  t.after(() => presentation.dispose())
  const surface = { kind: 'dock', sender: {}, frame: {}, current: () => true, visible: () => true, send() {} }
  const lease = await presentation.acquireView(surface, 'm', session.id)
  const down = presentation.pointer(surface, 'm', session.id, pointer('down'), lease.value.consumerId)
  await entered.promise
  const detached = presentation.detach('m', session.id)
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  release.resolve()
  assert.equal((await down).ok, false)
  assert.equal((await detached).ok, true)
  assert.deepEqual(f.touches, [], 'the retired DOWN never reaches the real runtime channel')
})

test('live Android input is prepared once and sends DOWN before release without per-move native commands', async t=>{
  const f=liveInputFixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal(session.liveInputAvailable,true); assert.equal(f.preparations.length,1)
  assert.equal(f.preparations[0].serial,'emulator-5554'); assert.equal(f.preparations[0].serverPath,'trusted-scrcpy-server')
  const before=f.calls.length
  assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
  assert.deepEqual(f.touches.map(event=>event.phase),['down'])
  const prepared=f.calls.length
  assert.equal((await f.manager.pointer('m',session.id,pointer('move','gesture_1',0.8,0.9))).ok,true)
  assert.equal((await f.manager.pointer('m',session.id,pointer('up','gesture_1',0.8,0.9))).ok,true)
  assert.equal(f.calls.length,prepared)
  assert.deepEqual(f.touches.map(event=>event.phase),['down','move','up'])
  assert.deepEqual(f.touches[0].geometry,{width:108,height:192})
  assert.equal(f.calls.slice(before).filter(c=>c.args.at(-1) === "'cmd' 'display' 'get-displays'").length,1)
  assert.equal(f.calls.slice(before).filter(c=>c.args.includes('name')).length,1)
  assert.ok(!f.calls.slice(before).some(c=>c.args.includes('screencap')))
  assert.equal((await f.manager.pointer('m',session.id,pointer('down','gesture_2'))).ok,true)
  assert.equal(f.preparations.length,1)
})

test('pending DOWN coalesces MOVE and retains its UP without accepting a second gesture', async t=>{
  const entered=deferred(), release=deferred()
  const f=liveInputFixture({run:async c=>{if(c.args.at(-1) === "'cmd' 'display' 'get-displays'") {entered.resolve(); await release.promise} return undefined}})
  t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  const down=f.manager.pointer('m',session.id,pointer('down')); await entered.promise
  assert.equal((await f.manager.pointer('m',session.id,pointer('move','gesture_1',0.4,0.5))).ok,true)
  assert.equal((await f.manager.pointer('m',session.id,pointer('move','gesture_1',0.7,0.8))).ok,true)
  const up=f.manager.pointer('m',session.id,pointer('up','gesture_1',0.9,0.95))
  assert.equal((await f.manager.pointer('m',session.id,pointer('down','gesture_2'))).ok,false)
  assert.equal(f.touches.length,0); release.resolve()
  assert.equal((await down).ok,true); assert.equal((await up).ok,true)
  assert.deepEqual(f.touches.map(({phase,x,y})=>({phase,x,y})),[
    {phase:'down',x:0.2,y:0.3},{phase:'move',x:0.7,y:0.8},{phase:'up',x:0.9,y:0.95}])
  assert.equal((await f.manager.pointer('m',session.id,pointer('down','gesture_2'))).ok,true)
})

test('cancelled pending DOWN is never replayed and late events cannot affect a newer gesture', async t=>{
  const entered=deferred(), release=deferred(); let blocked=true
  const f=liveInputFixture({run:async c=>{if(blocked && c.args.at(-1) === "'cmd' 'display' 'get-displays'") {entered.resolve(); await release.promise} return undefined}})
  t.after(()=>f.manager.dispose()); const {value:session}=await f.manager.start('m',android())
  const down=f.manager.pointer('m',session.id,pointer('down')); await entered.promise
  assert.equal((await f.manager.pointer('m',session.id,pointer('cancel'))).ok,true)
  blocked=false; release.resolve(); assert.equal((await down).ok,false); assert.equal(f.touches.length,0)
  assert.equal((await f.manager.pointer('m',session.id,pointer('down','gesture_2'))).ok,true)
  assert.equal((await f.manager.pointer('m',session.id,pointer('up','gesture_1'))).ok,false)
  assert.equal((await f.manager.pointer('m',session.id,pointer('cancel','gesture_1'))).ok,false)
  assert.deepEqual(f.touches.map(event=>event.phase),['down'])
})

test('a normal action cancels pending pointer preparation before its own FIFO effect', async t=>{
  const entered=deferred(), release=deferred()
  const f=liveInputFixture({run:async c=>{if(c.args.at(-1) === "'cmd' 'display' 'get-displays'") {entered.resolve(); await release.promise} return undefined}})
  t.after(()=>f.manager.dispose()); const {value:session}=await f.manager.start('m',android())
  const down=f.manager.pointer('m',session.id,pointer('down')); await entered.promise
  const home=f.manager.act('m',session.id,{type:'key',key:'home'})
  release.resolve(); assert.equal((await down).ok,false); assert.equal((await home).ok,true)
  assert.equal(f.touches.length,0); assert.ok(f.calls.some(c=>c.args.at(-1) === "'input' 'keyevent' '3'"))
})

test('pointer validation and cross-mission checks fail before native input', async t=>{
  const f=liveInputFixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android(),agent('controller'))
  const before=f.calls.length
  const invalid=[null,{...pointer('down'),x:NaN},{...pointer('down'),y:1.1},{...pointer('down'),gestureId:'../bad'},
    {...pointer('down'),gestureId:'a'.repeat(65)},{...pointer('down'),phase:'tap'},{...pointer('down'),extra:true}]
  for(const event of invalid) assert.equal((await f.manager.pointer('m',session.id,event)).ok,false)
  assert.equal((await f.manager.pointer('other',session.id,pointer('down'))).ok,false)
  assert.equal(f.calls.length,before); assert.equal(f.touches.length,0)
  assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
})

test('controller release cancels before revocation and scope loss sends no additional input', async t=>{
  for(const mode of ['controller','scope','child']) {
    const f=liveInputFixture(); t.after(()=>f.manager.dispose())
    const {value:session}=await f.manager.start('m',android(),agent('controller'))
    assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
    if(mode === 'controller') f.manager.releaseController('controller')
    if(mode === 'scope') f.setScope({projectId:'other',rootPath:resolve('other')})
    if(mode === 'child') f.children[0].crash()
    assert.equal((await f.manager.pointer('m',session.id,pointer('move'))).ok,false)
    assert.deepEqual(f.touches.map(event=>event.phase),['down'])
    if(mode === 'controller') assert.deepEqual(f.cancellations,[{aborted:false}])
    else assert.equal(f.cancellations.length,0)
  }
})

test('live gesture expires after ten seconds and does not replay a late UP', async t=>{
  const f=liveInputFixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  t.mock.timers.enable({apis:['setTimeout']})
  assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
  t.mock.timers.tick(10_000)
  assert.equal((await f.manager.pointer('m',session.id,pointer('up'))).ok,false)
  assert.deepEqual(f.cancellations,[{aborted:false}]); assert.equal(f.touches.length,1)
})

test('input disconnect clears capability without reconnecting and leaves legacy actions available', async t=>{
  const f=liveInputFixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
  const changed=f.changes.length; f.disconnect()
  assert.equal((await f.manager.inspect('m')).value.sessions[0].liveInputAvailable,false)
  assert.ok(f.changes.length>changed)
  assert.equal((await f.manager.pointer('m',session.id,pointer('move'))).ok,false)
  assert.equal((await f.manager.act('m',session.id,{type:'tap',x:0.1,y:0.1})).ok,true)
  assert.equal(f.preparations.length,1); assert.equal(f.touches.length,1)
})

test('input startup failure preserves ready capture and legacy controls', async t=>{
  const f=liveInputFixture({prepare:async()=>{throw new Error('synthetic-sensitive-input-server-output')}}); t.after(()=>f.manager.dispose())
  const started=await f.manager.start('m',android()); assert.equal(started.ok,true)
  assert.equal(started.value.liveInputAvailable,false); assert.equal(started.value.inputAvailable,true)
  assert.equal((await f.manager.pointer('m',started.value.id,pointer('down'))).ok,false)
  assert.equal((await f.manager.capture('m',started.value.id)).ok,true)
  assert.ok(!JSON.stringify(await f.manager.inspect('m')).includes('synthetic-sensitive'))
})

test('closing a live session cancels before abort and closes only its own input channel', async()=>{
  const f=liveInputFixture(); const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
  const closing=f.manager.closeMission('m')
  assert.deepEqual(f.cancellations,[{aborted:false}])
  assert.equal((await f.manager.pointer('m',session.id,pointer('move'))).ok,false)
  await closing; assert.equal(f.closes,1); assert.equal(f.preparations[0].signal.aborted,true)
})

test('UP waits for the terminal write before acknowledging or allowing the next DOWN', async t=>{
  const flushed=deferred(); let terminal=false
  const f=liveInputFixture({flush:async()=>{if(terminal) await flushed.promise}}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
  terminal=true
  let acknowledged=false
  const up=f.manager.pointer('m',session.id,pointer('up')).then(result=>{acknowledged=true; return result})
  await Promise.resolve(); assert.equal(acknowledged,false)
  assert.equal((await f.manager.pointer('m',session.id,pointer('down','gesture_2'))).ok,false)
  assert.equal((await f.manager.pointer('m',session.id,pointer('move'))).ok,false)
  assert.equal(f.cancellations.length,0)
  flushed.resolve(); assert.equal((await up).ok,true)
  assert.equal((await f.manager.pointer('m',session.id,pointer('down','gesture_2'))).ok,true)
})

test('mission close and lost scope invalidate pending geometry before any native DOWN', async()=>{
  for(const mode of ['close','scope']) {
    const entered=deferred(), release=deferred()
    const f=liveInputFixture({run:async c=>{if(c.args.at(-1) === "'cmd' 'display' 'get-displays'") {entered.resolve(); await release.promise} return undefined}})
    const {value:session}=await f.manager.start('m',android())
    const down=f.manager.pointer('m',session.id,pointer('down')); await entered.promise
    const closing=mode === 'close' ? f.manager.closeMission('m'):undefined
    if(mode === 'scope') f.setScope({projectId:'other',rootPath:resolve('other')})
    release.resolve(); assert.equal((await down).ok,false)
    assert.equal(f.touches.length,0); assert.equal(f.cancellations.length,0)
    await closing; await f.manager.dispose(); assert.equal(f.closes,1)
  }
})

test('normal actions await the cancelled native finger before executing their own effects', async t=>{
  const release=deferred(); let cancelling=false
  const f=liveInputFixture({flush:async()=>{if(cancelling) await release.promise}}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.pointer('m',session.id,pointer('down'))).ok,true)
  cancelling=true
  const home=f.manager.act('m',session.id,{type:'key',key:'home'})
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(f.cancellations,[{aborted:false}])
  assert.ok(!f.calls.some(c=>c.args.at(-1) === "'input' 'keyevent' '3'"))
  release.resolve(); assert.equal((await home).ok,true)
})

test('close during native input preparation rejects stale capability and closes the returned channel', async()=>{
  const entered=deferred(), release=deferred()
  const f=liveInputFixture({prepare:async()=>{entered.resolve(); await release.promise}})
  const starting=f.manager.start('m',android()); await entered.promise
  const closing=f.manager.closeMission('m'); release.resolve()
  assert.equal((await starting).ok,false); await closing
  assert.equal(f.closes,1); assert.equal(f.touches.length,0)
  assert.equal((await f.manager.inspect('m')).value.sessions.length,0)
})

test('shared screen profiles expose only the reviewed Android models and test densities', async () => {
  const {MOBILE_DEVICE_PROFILES,getMobileDeviceProfile}=await import('../.tmp/mobile-runtime-test/shared/mobileDeviceProfiles.js')
  assert.deepEqual(MOBILE_DEVICE_PROFILES.map(profile=>profile.id),['native','pixel-7','pixel-9','galaxy-s24','galaxy-s24-ultra','galaxy-a54'])
  assert.equal(getMobileDeviceProfile('galaxy-s24-ultra').width,1440)
  assert.equal(getMobileDeviceProfile('galaxy-s24-ultra').density,560)
  assert.equal(getMobileDeviceProfile('native').width,null)
  assert.equal(getMobileDeviceProfile('arbitrary'),undefined)
})

test('Android display profiles change actual size and density before publishing the applied model', async t => {
  const f=fixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal(session.displayProfileId,'native')
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'galaxy-s24-ultra'})).ok,true)
  assert.deepEqual(f.display.overrideSize,{width:1440,height:3120}); assert.equal(f.display.overrideDensity,560)
  assert.equal((await f.manager.inspect('m')).value.sessions[0].displayProfileId,'galaxy-s24-ultra')
  assert.equal((await f.manager.act('m',session.id,{type:'tap',x:1,y:1})).ok,true)
  assert.ok(f.calls.some(c=>c.args.at(-1) === "'input' 'tap' '1439' '3119'"))
})

test('a preset matching the physical display succeeds when wm omits equal overrides', async t => {
  const f=fixture(); f.display.physicalSize={width:1080,height:2400}; t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'pixel-7'})).ok,true)
  assert.equal((await f.manager.inspect('m')).value.sessions[0].displayProfileId,'pixel-7')
  assert.ok(!f.calls.some(c=>/^'wm' '(size|density)' '/u.test(c.args.at(-1) ?? '')))
})

test('native profile restores the original override rather than erasing user display settings', async t => {
  const f=fixture({originalSize:{width:100,height:180},originalDensity:400}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',{...android(),displayProfileId:'pixel-9'})
  assert.equal(session.displayProfileId,'pixel-9'); assert.deepEqual(f.display.overrideSize,{width:1080,height:2424})
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'native'})).ok,true)
  assert.deepEqual(f.display.overrideSize,{width:100,height:180}); assert.equal(f.display.overrideDensity,400)
})

test('profile validation rejects unknown ids, iOS and unauthorized panes without display writes', async t => {
  const f=fixture(); t.after(()=>f.manager.dispose())
  assert.equal((await f.manager.start('bad',{...android(),displayProfileId:'arbitrary'})).ok,false)
  const {value:session}=await f.manager.start('m',android(),agent('one'))
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'arbitrary'})).ok,false)
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'pixel-7'},agent('two'))).ok,false)
  assert.ok(!f.calls.some(c=>/^'wm' '(size|density)' '/u.test(c.args.at(-1) ?? '')))
  const ios=fixture({platform:'darwin'}); t.after(()=>ios.manager.dispose())
  assert.equal((await ios.manager.start('m',{platform:'ios',deviceId:ios.discovery.devices[2].id,displayProfileId:'native'})).ok,false)
})

test('a partial display-profile failure rolls back while the same target remains authorized', async t => {
  let fail=true
  const f=fixture({run:async c=>{if (fail && c.args.at(-1) === "'wm' 'density' '560'") {fail=false; throw new MobileProcessError('failed')} return undefined}})
  t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'galaxy-s24-ultra'})).ok,false)
  assert.equal(f.display.overrideSize,null); assert.equal(f.display.overrideDensity,null)
  assert.equal((await f.manager.inspect('m')).value.sessions[0].displayProfileId,'native')
})

test('a requested startup profile failure is not repeatedly applied by the boot polling loop', async () => {
  const f=fixture({bootTimeoutMs:20,run:async c=>{if (c.args.at(-1) === "'wm' 'density' '560'") throw new MobileProcessError('failed'); return undefined}})
  assert.equal((await f.manager.start('m',{...android(),displayProfileId:'galaxy-s24-ultra'})).ok,false)
  assert.equal(f.calls.filter(c=>c.args.at(-1) === "'wm' 'size' '1440x3120'").length,1)
  assert.equal(f.children[0].isAlive(),false)
})

test('profile recovery sends no effects after the mission scope is revoked', async () => {
  const f=fixture({run:async c=>{if (c.args.at(-1) === "'wm' 'size' '1440x3120'") f.setScope({projectId:'other',rootPath:resolve('other')}); return undefined}})
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'galaxy-s24-ultra'})).ok,false)
  assert.deepEqual(f.calls.filter(c=>/^'wm' '(size|density)' '/u.test(c.args.at(-1) ?? '')).map(c=>c.args.at(-1)),["'wm' 'size' '1440x3120'"])
  await f.manager.dispose()
})

test('owned stop restores our last applied profile but preserves a later outside override', async () => {
  for (const external of [false,true]) {
    const f=fixture(); const {value:session}=await f.manager.start('m',{...android(),displayProfileId:'pixel-7'})
    assert.equal(session.displayProfileId,'pixel-7')
    if (external) {f.display.overrideSize={width:1200,height:2600}; f.display.overrideDensity=500}
    assert.equal((await f.manager.stop('m',session.id)).ok,true)
    assert.deepEqual(f.display.overrideSize,external ? {width:1200,height:2600}:null)
    assert.equal(f.display.overrideDensity,external ? 500:null)
  }
})

test('stop restores a size command accepted immediately before its operation was cancelled', async () => {
  let stopping, sessionId
  const f=fixture({run:async c=>{
    if (c.args.at(-1) !== "'wm' 'size' '1440x3120'") return undefined
    f.display.overrideSize={width:1440,height:3120}
    stopping=f.manager.stop('m',sessionId)
    throw new MobileProcessError('cancelled')
  }})
  sessionId=(await f.manager.start('m',android())).value.id
  assert.equal((await f.manager.act('m',sessionId,{type:'displayProfile',profileId:'galaxy-s24-ultra'})).ok,false)
  assert.equal((await stopping).ok,true)
  assert.equal(f.display.overrideSize,null); assert.equal(f.display.overrideDensity,null)
})

test('a later pre-dispatch cancellation retains an earlier accepted display candidate for cleanup', async () => {
  const firstController=new AbortController(), secondController=new AbortController()
  let second=false, checks=0
  const f=fixture({run:async c=>{
    if (!second && c.args.at(-1) === "'wm' 'size' '1440x3120'") {
      f.display.overrideSize={width:1440,height:3120}; firstController.abort(); throw new MobileProcessError('cancelled')
    }
    if (second && c.args.includes('emu') && c.args.includes('name') && ++checks === 2) secondController.abort()
    return undefined
  }})
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'galaxy-s24-ultra'},undefined,firstController.signal)).ok,false)
  second=true
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'pixel-9'},undefined,secondController.signal)).ok,false)
  assert.equal((await f.manager.stop('m',session.id)).ok,true)
  assert.equal(f.display.overrideSize,null)
})

test('a display command cancelled before dispatch never claims an identical later outside override', async () => {
  const controller=new AbortController(); let checking=false, checks=0
  const f=fixture({run:async c=>{
    if (checking && c.args.includes('emu') && c.args.includes('name') && ++checks === 2) controller.abort()
    return undefined
  }})
  const {value:session}=await f.manager.start('m',android()); checking=true
  assert.equal((await f.manager.act('m',session.id,{type:'displayProfile',profileId:'galaxy-s24-ultra'},undefined,controller.signal)).ok,false)
  assert.ok(!f.calls.some(c=>/^'wm' '(size|density)' '/u.test(c.args.at(-1) ?? '')))
  f.display.overrideSize={width:1440,height:3120}
  assert.equal((await f.manager.stop('m',session.id)).ok,true)
  assert.deepEqual(f.display.overrideSize,{width:1440,height:3120})
  assert.ok(!f.calls.some(c=>/^'wm' '(size|density)' '/u.test(c.args.at(-1) ?? '')))
})

test('missing mission fails closed before discovery or launching', async () => {
  const f = fixture(); f.setScope(null)
  assert.equal((await f.manager.start('m', android())).ok, false)
  assert.equal((await f.manager.inspect('m')).ok, false); assert.equal(f.launches.length, 0)
})
test('starts a headless exact AVD with a reserved serial and returns copies', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  const started = await f.manager.start('m', android()); assert.equal(started.ok, true)
  assert.equal(started.value.state, 'ready'); assert.ok(f.launches[0].args.includes('-no-window'))
  const target=await f.manager.videoTarget('m',started.value.id)
  assert.equal(target.ok,true)
  assert.deepEqual({executable:target.value.executable,serial:target.value.serial,width:target.value.width,height:target.value.height},{executable:'adb',serial:'emulator-5554',width:108,height:192})
  started.value.state = 'error'
  assert.equal((await f.manager.inspect('m')).value.sessions[0].state, 'ready')
})

test('video target leases revoke setup authority immediately on scope loss or session close', async()=>{
  for(const mode of ['scope','close']) {
    const f=fixture(); const {value:session}=await f.manager.start('m',android())
    const {value:target}=await f.manager.videoTarget('m',session.id)
    assert.equal(target.signal.aborted,false); target.assertCurrent()
    await target.verifyTarget()
    const before=f.calls.length
    if(mode === 'scope') f.setScope({projectId:'other',rootPath:resolve('other')})
    const closing=mode === 'close' ? f.manager.closeMission('m'):undefined
    assert.throws(()=>target.assertCurrent())
    await assert.rejects(target.verifyTarget())
    if(mode === 'scope') assert.equal(f.calls.length,before)
    else assert.equal(target.signal.aborted,true)
    await closing; await f.manager.dispose()
  }
})

test('video setup verification respects the caller visibility abort before any SDK request', async t=>{
  const f=fixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android()), {value:target}=await f.manager.videoTarget('m',session.id)
  const controller=new AbortController(); controller.abort(); const before=f.calls.length
  await assert.rejects(target.verifyTarget(controller.signal))
  assert.equal(f.calls.length,before)
  assert.equal(target.signal.aborted,false)
})

test('video targets obtain current display dimensions once per recorder request without screenshots', async t => {
  const f=fixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.videoTarget('m',session.id)).value.width,108)
  f.display.overrideSize={width:1440,height:3120}
  const target=await f.manager.videoTarget('m',session.id)
  assert.equal(target.value.width,1440); assert.equal(target.value.height,3120)
  assert.equal(f.calls.filter(c=>c.args.at(-1) === "'cmd' 'display' 'get-displays'").length,2)
  assert.ok(!f.calls.some(c=>c.args.includes('screencap')))
})
test('simultaneous starts reserve device leases before their first await', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  const [a, b] = await Promise.all([f.manager.start('a', android()), f.manager.start('b', android())])
  assert.equal(a.ok, true); assert.equal(b.ok, false); assert.equal(f.launches.length, 1)
})
test('different missions reserve distinct available port pairs', async t => {
  const f = fixture({ portAvailable: async port => port !== 5555 }); t.after(() => f.manager.dispose())
  const [a, b] = await Promise.all([f.manager.start('a', android()), f.manager.start('b', android('Synkora_B'))])
  assert.equal(a.ok && b.ok, true)
  const ports = f.launches.map(c => c.args[c.args.indexOf('-port') + 1])
  assert.equal(new Set(ports).size, 2); assert.ok(!ports.includes('5554'))
})
test('an external running emulator cannot be adopted by owner or agent', async () => {
  const f = fixture(); f.discovery.devices[0].state = 'running'
  assert.equal((await f.manager.start('m', android())).ok, false)
  assert.equal((await f.manager.start('m', android(), agent('pane-a'))).ok, false)
  assert.equal(f.launches.length, 0)
})
test('owner session can be claimed by one agent; peer pane and foreign mission are denied', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  const started = await f.manager.start('m', android()); const id = started.value.id
  assert.equal((await f.manager.start('m', android(), agent('pane-a'))).ok, true)
  assert.equal((await f.manager.act('m', id, { type: 'key', key: 'home' }, agent('pane-b'))).ok, false)
  assert.equal((await f.manager.capture('other', id, agent('pane-a'))).ok, false)
  assert.equal((await f.manager.act('m', id, { type: 'key', key: 'home' })).ok, true)
})
test('capture contains validated raw base64 PNG and normalized taps use logical display pixels', async t => {
  const f = fixture(); t.after(() => f.manager.dispose())
  const { value: session } = await f.manager.start('m', android())
  const frame = await f.manager.capture('m', session.id)
  assert.equal(frame.ok, true); assert.equal(frame.value.width, 108); assert.equal(frame.value.height, 192)
  assert.equal(frame.value.data.startsWith('data:'), false)
  assert.equal((await f.manager.act('m', session.id, { type: 'tap', x: 1, y: 0.5 })).ok, true)
  assert.ok(f.calls.some(c => c.args.at(-1) === "'input' 'tap' '107' '96'"))
})

test('Android pointer input uses current logical display geometry without taking a screenshot', async t => {
  const f=fixture({run:async c=>c.args.at(-1) === "'cmd' 'display' 'get-displays'" ? Buffer.from(androidDisplay(192,108,1)) : undefined})
  t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.act('m',session.id,{type:'tap',x:0.75,y:0.5})).ok,true)
  assert.equal((await f.manager.act('m',session.id,{type:'swipe',x:0,y:0,endX:1,endY:1,durationMs:500})).ok,true)
  assert.ok(!f.calls.some(c=>c.args.includes('screencap')))
  assert.ok(f.calls.some(c=>c.args.at(-1) === "'input' 'tap' '144' '54'"))
  assert.ok(f.calls.some(c=>c.args.at(-1) === "'input' 'swipe' '0' '0' '191' '107' '500'"))
})

test('Android pointer geometry is refreshed between rotations instead of reusing a stale portrait size', async t => {
  let rotation=0
  const f=fixture({run:async c=>{
    if (c.args.at(-1) !== "'cmd' 'display' 'get-displays'") return undefined
    const current=rotation++
    return Buffer.from(androidDisplay(current % 2 ? 192:108,current % 2 ? 108:192,current))
  }}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  for (let i=0;i<4;i++) assert.equal((await f.manager.act('m',session.id,{type:'tap',x:0.25,y:0.75})).ok,true)
  assert.deepEqual(f.calls.filter(c=>c.args.at(-1)?.startsWith("'input' 'tap'")).map(c=>c.args.at(-1)),
    ["'input' 'tap' '27' '144'","'input' 'tap' '48' '81'","'input' 'tap' '27' '144'","'input' 'tap' '48' '81'"])
})

test('unverified Android display geometry refuses pointer effects and never falls back to screenshots', async () => {
  for (const reply of [androidDisplay(108,192,0,1),androidDisplay(108,192,0,0,false),androidDisplay(0,192),
    androidDisplay(9000,192),androidDisplay(108,192,4),androidDisplay().replace(', rotation 0',''),androidDisplay()+androidDisplay()]) {
    const f=fixture({run:async c=>c.args.at(-1) === "'cmd' 'display' 'get-displays'" ? Buffer.from(reply) : undefined})
    const {value:session}=await f.manager.start('m',android())
    assert.equal((await f.manager.act('m',session.id,{type:'tap',x:0.5,y:0.5})).ok,false)
    assert.ok(!f.calls.some(c=>c.args.includes('screencap') || c.args.at(-1)?.startsWith("'input' 'tap'")))
    await f.manager.dispose()
  }
})

test('scope changes and caller cancellation during geometry lookup cannot send pointer effects', async () => {
  for (const mode of ['scope','cancel']) {
    let enteredResolve, release
    const entered=new Promise(resolve=>{enteredResolve=resolve}), blocked=new Promise(resolve=>{release=resolve})
    const f=fixture({run:async c=>{
      if (c.args.at(-1) !== "'cmd' 'display' 'get-displays'") return undefined
      enteredResolve(); await blocked; return Buffer.from(androidDisplay())
    }})
    const {value:session}=await f.manager.start('m',android())
    const controller=new AbortController(), action=f.manager.act('m',session.id,{type:'tap',x:0.5,y:0.5},undefined,controller.signal)
    await entered
    if (mode === 'scope') f.setScope({projectId:'p2',rootPath:resolve('other')})
    else controller.abort()
    release(); assert.equal((await action).ok,false)
    assert.ok(!f.calls.some(c=>c.args.at(-1)?.startsWith("'input' 'tap'")))
    await f.manager.dispose()
  }
})
test('invalid PNG and excessive dimensions fail closed', () => {
  assert.throws(() => readMobilePng(Buffer.from('not a png')))
  assert.throws(() => readMobilePng(png(0, 2)))
  const bad = png(); bad.writeUInt32BE(100000, 16); assert.throws(() => readMobilePng(bad))
  assert.deepEqual(readMobilePng(png()), { width: 108, height: 192 })
})
test('ADB values are remote-shell quoted; unsupported text is refused without a command', async t => {
  assert.equal(quoteAndroidArgument("a'b;$(x)"), "'a'\\''b;$(x)'")
  const f = fixture(); t.after(() => f.manager.dispose())
  const { value: session } = await f.manager.start('m', android()); const before = f.calls.length
  assert.equal((await f.manager.act('m', session.id, { type: 'text', text: 'olá' })).ok, false)
  assert.equal(f.calls.length, before)
  assert.equal((await f.manager.act('m', session.id, { type: 'text', text: "hello'; touch no" })).ok, true)
  assert.ok(f.calls.some(c => c.args.at(-1) === "'input' 'text' 'hello'\\'';%stouch%sno'"))
})
test('validation rejects non-finite coordinates, invalid ports, dangerous URLs and command-like app IDs', () => {
  for (const a of [{ type:'tap', x:NaN, y:0 }, { type:'tap', x:2, y:0 }, { type:'reverse', port:0 },
    { type:'reverse', port:65536 }, { type:'openUrl', url:'javascript:alert(1)' }, { type:'launch', appId:'a;bad' },
    { type:'swipe', x:0, y:0, endX:1, endY:1, durationMs:9000 }]) assert.throws(() => validateMobileAction(a))
})
test('install only accepts regular scoped APK files and rejects traversal and linked parents', async t => {
  const base = resolve('.tmp'); mkdirSync(base, { recursive: true }); const dir = mkdtempSync(join(base, 'mobile-path-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'work'); mkdirSync(root); writeFileSync(join(root, 'app.apk'), 'synthetic')
  assert.equal(await resolveMobileInstallPath(root, 'app.apk', 'android'), join(root, 'app.apk'))
  await assert.rejects(resolveMobileInstallPath(root, '../outside.apk', 'android'))
  await assert.rejects(resolveMobileInstallPath(root, 'app.apk', 'ios'))
  const outside = join(dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'app.apk'), 'synthetic')
  symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(resolveMobileInstallPath(root, 'link/app.apk', 'android'))
})

test('iOS install accepts a scoped app bundle but refuses a linked bundle descendant', async t => {
  const base=resolve('.tmp'); mkdirSync(base,{recursive:true}); const dir=mkdtempSync(join(base,'mobile-path-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const root=join(dir,'work'), bundle=join(root,'Synthetic.app'), outside=join(dir,'outside')
  mkdirSync(bundle,{recursive:true}); mkdirSync(outside); writeFileSync(join(bundle,'Synthetic'),'synthetic')
  assert.equal(await resolveMobileInstallPath(root,'Synthetic.app','ios'),bundle)
  symlinkSync(outside,join(bundle,'Linked'),process.platform === 'win32' ? 'junction':'dir')
  await assert.rejects(resolveMobileInstallPath(root,'Synthetic.app','ios'))
})
test('stop cleans only the owned device and revokes video access immediately', async () => {
  const f = fixture(); const { value: session } = await f.manager.start('m', android())
  const stopping = f.manager.stop('m', session.id)
  assert.equal((await f.manager.videoTarget('m', session.id)).ok, false)
  assert.equal((await stopping).ok, true); assert.equal(f.closed.length, 1)
  assert.ok(!f.calls.some(c => c.args.includes('kill-server')))
})
test('worktree change during discovery cannot launch a device for stale scope', async () => {
  const f = fixture(); const pending = f.manager.start('m', android()); f.setScope({ projectId:'p1', rootPath: resolve('other') })
  assert.equal((await pending).ok, false); assert.equal(f.launches.length, 0)
})
test('close during boot aborts polling and releases the reserved device after cleanup', async () => {
  let enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve })
  const f = fixture({ run: async c => {
    if (!c.args.some(x => x.includes('sys.boot_completed'))) return undefined
    enteredResolve(); return new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(new Error('cancelled')), {once:true}))
  } })
  const pending = f.manager.start('m', android()); await entered
  await f.manager.closeMission('m'); assert.equal((await pending).ok, false)
  assert.equal(f.running.size, 0); assert.equal((await f.manager.inspect('m')).value.sessions.length, 0)
})

test('close during discovery cancels the lookup before any device can launch', async () => {
  let observedSignal, enteredResolve
  const entered=new Promise(resolve=>{enteredResolve=resolve})
  const f=fixture({discover:(signal,snapshot)=>new Promise((resolve,reject)=>{
    observedSignal=signal; enteredResolve()
    const timer=setTimeout(()=>resolve(snapshot),50)
    signal?.addEventListener('abort',()=>{clearTimeout(timer); reject(new MobileProcessError('cancelled'))},{once:true})
  })})
  const starting=f.manager.start('m',android()); await entered
  await f.manager.closeMission('m')
  assert.equal(observedSignal?.aborted,true); assert.equal((await starting).ok,false); assert.equal(f.launches.length,0)
})

test('managed APK install only uses the injected cache and the authorized owned Android session', async t => {
  const base=resolve('.tmp'); mkdirSync(base,{recursive:true}); const dir=mkdtempSync(join(base,'mobile-path-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const cache=join(dir,'cache'), outside=join(dir,'outside'); mkdirSync(cache); mkdirSync(outside)
  writeFileSync(join(cache,'expo.apk'),'synthetic'); writeFileSync(join(outside,'outside.apk'),'synthetic')
  symlinkSync(outside,join(cache,'link'),process.platform === 'win32' ? 'junction':'dir')
  const f=fixture({managedApkRoot:cache}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android(),agent('one'))
  const install=(mission,path,actor=agent('one'))=>f.manager.installManagedApk(mission,session.id,path,actor)
  assert.equal((await install('m','expo.apk')).ok,true)
  assert.ok(f.calls.some(c=>c.args.join('|') === ['-s','emulator-5554','install','-r',join(cache,'expo.apk')].join('|')))
  const before=f.calls.filter(c=>c.args.includes('install')).length
  for (const path of ['missing.apk','../outside/outside.apk',join(outside,'outside.apk'),'link/outside.apk']) assert.equal((await install('m',path)).ok,false)
  assert.equal((await install('other','expo.apk')).ok,false)
  assert.equal((await install('m','expo.apk',agent('two'))).ok,false)
  assert.equal(f.calls.filter(c=>c.args.includes('install')).length,before)
})

test('managed APK install pins the verified cache across its FIFO wait', async t => {
  const base=resolve('.tmp'); mkdirSync(base,{recursive:true}); const dir=mkdtempSync(join(base,'mobile-path-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const original=join(dir,'original'), replacement=join(dir,'replacement'), alias=join(dir,'active')
  for (const root of [original,replacement]) { mkdirSync(join(root,'cache'),{recursive:true}); writeFileSync(join(root,'cache','expo.apk'),'synthetic') }
  const linkType=process.platform === 'win32' ? 'junction':'dir'
  symlinkSync(original,alias,linkType)
  const expectedRoot=realpathSync(join(original,'cache'))
  let enteredResolve, release
  const entered=new Promise(resolve=>{enteredResolve=resolve}), blocked=new Promise(resolve=>{release=resolve})
  const f=fixture({managedApkRoot:join(alias,'cache'),run:async c=>{
    if (c.args.at(-1) !== "'input' 'keyevent' '3'") return undefined
    enteredResolve(); await blocked; return Buffer.alloc(0)
  }}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  const preceding=f.manager.act('m',session.id,{type:'key',key:'home'}); await entered
  const installing=f.manager.installManagedApk('m',session.id,'expo.apk',undefined,undefined,expectedRoot)
  unlinkSync(alias); symlinkSync(replacement,alias,linkType); release()
  assert.equal((await preceding).ok,true); assert.equal((await installing).ok,false)
  assert.ok(!f.calls.some(c=>c.args.includes('install')))
  unlinkSync(alias); symlinkSync(original,alias,linkType)
  assert.equal((await f.manager.installManagedApk('m',session.id,'expo.apk',undefined,undefined,expectedRoot)).ok,true)
  assert.equal(f.calls.find(c=>c.args.includes('install')).args.at(-1),join(expectedRoot,'expo.apk'))
})
test('managed APK install requires configured cache and respects caller cancellation', async t => {
  const f=fixture(); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.installManagedApk('m',session.id,'expo.apk')).ok,false)
  const base=resolve('.tmp'); mkdirSync(base,{recursive:true}); const cache=mkdtempSync(join(base,'mobile-path-'))
  t.after(()=>rmSync(cache,{recursive:true,force:true})); writeFileSync(join(cache,'expo.apk'),'synthetic')
  let enteredResolve; const entered=new Promise(resolve=>{enteredResolve=resolve})
  const g=fixture({managedApkRoot:cache,run:async c=>{
    if (!c.args.includes('install')) return undefined
    enteredResolve(); return new Promise((_,reject)=>c.signal.addEventListener('abort',()=>reject(new MobileProcessError('cancelled')),{once:true}))
  }}); t.after(()=>g.manager.dispose())
  const {value:managedSession}=await g.manager.start('m',android())
  const controller=new AbortController(), installing=g.manager.installManagedApk('m',managedSession.id,'expo.apk',undefined,controller.signal)
  await entered; controller.abort(); assert.equal((await installing).ok,false)
  assert.equal((await g.manager.videoTarget('m',managedSession.id)).ok,true)
})
test('controller release aborts an old action and prevents transfer until it settles', async t => {
  let enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve })
  const f = fixture({ run: async c => {
    if (!c.args.some(x => x.includes("'input' 'text'"))) return undefined
    enteredResolve(); return new Promise((_, reject) => c.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('cancelled')), 5), {once:true}))
  } }); t.after(() => f.manager.dispose())
  const { value: session } = await f.manager.start('m', android(), agent('old'))
  const action = f.manager.act('m', session.id, { type:'text', text:'test' }, agent('old')); await entered
  f.manager.releaseController('old')
  assert.equal((await f.manager.start('m', android(), agent('new'))).ok, false)
  assert.equal((await action).ok, false)
  assert.equal((await f.manager.start('m', android(), agent('new'))).ok, true)
})
test('iOS is macOS-only, and absent idb leaves capture available with honest read-only input', async t => {
  const windows = fixture(); assert.equal((await windows.manager.start('m', {platform:'ios',deviceId:windows.discovery.devices[2].id})).ok, false)
  const f = fixture({ platform:'darwin', noIdb:true }); t.after(() => f.manager.dispose())
  const result = await f.manager.start('m', { platform:'ios', deviceId:f.discovery.devices[2].id })
  assert.equal(result.ok, true); assert.equal(result.value.inputAvailable, false)
  assert.equal((await f.manager.capture('m', result.value.id)).ok, true)
  assert.equal((await f.manager.act('m', result.value.id, {type:'tap',x:0.5,y:0.5})).ok, false)
})
test('idb taps use verified screen points, not screenshot pixels', async t => {
  const f = fixture({ platform:'darwin' }); t.after(() => f.manager.dispose())
  const result = await f.manager.start('m', { platform:'ios', deviceId:f.discovery.devices[2].id })
  assert.equal(result.value.inputAvailable, true)
  assert.equal((await f.manager.act('m', result.value.id, {type:'tap',x:0.5,y:0.5})).ok, true)
  assert.ok(f.calls.some(c => c.executable === 'idb' && c.args.slice(0,4).join(' ') === 'ui tap 18 32'))
})

test('iOS refuses rotated screenshot geometry without a verified HID orientation transform', async t => {
  const f = fixture({ platform:'darwin', run:async c=>c.args.includes('screenshot') ? png(192,108) : undefined })
  t.after(()=>f.manager.dispose())
  const result=await f.manager.start('m',{platform:'ios',deviceId:f.discovery.devices[2].id})
  const action=await f.manager.act('m',result.value.id,{type:'tap',x:0.9,y:0.5})
  assert.equal(action.ok,false); assert.match(action.error,/retrato/u)
  assert.ok(!f.calls.some(c=>c.executable === 'idb' && c.args[0] === 'ui'))
  assert.equal((await f.manager.capture('m',result.value.id)).ok,true)
})
test('device parsers exclude physical Android devices and non-iOS/unavailable simulators', () => {
  assert.deepEqual(parseAndroidDevices('List of devices attached\nreal-phone device\n10.0.0.1:5555 device\nemulator-5554 device\nemulator-5556 offline\n'), ['emulator-5554','emulator-5556'])
  const parsed = parseIosDevices(JSON.stringify({devices:{ 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{udid:'12345678-1234-1234-1234-123456789ABC',name:'iPhone',state:'Shutdown',isAvailable:true}], 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{udid:'AA',name:'Watch',state:'Booted',isAvailable:true}] }}))
  assert.equal(parsed.length, 1); assert.equal(parsed[0].platform,'ios')
})

test('iOS frame identity comes from CoreSimulator type metadata rather than the editable name', async t => {
  const type='com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro'
  const parsed=parseIosDevices(JSON.stringify({devices:{'com.apple.CoreSimulator.SimRuntime.iOS-18-0':[
    {udid:'12345678-1234-1234-1234-123456789ABC',name:'Arbitrary owner name',state:'Shutdown',isAvailable:true,deviceTypeIdentifier:type},
    {udid:'22345678-1234-1234-1234-123456789ABC',name:'iPhone fake name',state:'Shutdown',isAvailable:true,deviceTypeIdentifier:'untrusted/type'}]}}))
  assert.equal(parsed[0].deviceTypeIdentifier,type); assert.equal(parsed[1].deviceTypeIdentifier,undefined)
  const f=fixture({platform:'darwin'}); f.discovery.devices[2].deviceTypeIdentifier=type; t.after(()=>f.manager.dispose())
  assert.equal((await f.manager.start('m',{platform:'ios',deviceId:f.discovery.devices[2].id})).value.deviceTypeIdentifier,type)
})
test('an exited owned emulator cannot hand its serial to an outside replacement', async () => {
  const f = fixture(); const { value: session } = await f.manager.start('m', android())
  f.children[0].crash(); f.running.set('emulator-5554', 'Outside_AVD'); await Promise.resolve()
  const before = f.calls.length
  assert.equal((await f.manager.act('m',session.id,{type:'key',key:'home'})).ok,false)
  assert.equal((await f.manager.capture('m',session.id)).ok,false)
  assert.equal((await f.manager.videoTarget('m',session.id)).ok,false)
  assert.equal(f.calls.length,before, 'no SDK effects after the owned handle exits')
  assert.equal(f.closed.length,1, 'video revoked on the owned process exit')
})
test('boot timeout cleans its owned child and permits a fresh reservation', async t => {
  let slow = true
  const f = fixture({bootTimeoutMs:8,run:async c=>c.args.some(x=>x.includes('sys.boot_completed')) && slow ? Buffer.from('0') : undefined})
  t.after(()=>f.manager.dispose())
  assert.equal((await f.manager.start('m',android())).ok,false)
  assert.equal(f.children[0].isAlive(),false); assert.equal(f.running.size,0)
  slow=false; assert.equal((await f.manager.start('m',android())).ok,true)
})
test('missing idb point metadata does not invent a coordinate scale', async t => {
  const f = fixture({platform:'darwin',run:async c=>c.args[0] === 'describe' ? Buffer.from(JSON.stringify({udid:'12345678-1234-1234-1234-123456789ABC',screen_dimensions:{width:108,height:192}})) : undefined})
  t.after(()=>f.manager.dispose())
  const result=await f.manager.start('m',{platform:'ios',deviceId:f.discovery.devices[2].id})
  assert.equal(result.ok,true); assert.equal(result.value.inputAvailable,false)
})
test('action submission order survives differently delayed identity replies', async t => {
  let checks=0, unlock
  const blocked=new Promise(resolve=>{unlock=resolve})
  const f=fixture({run:async c=>{
    if (c.args.includes('emu') && c.args.includes('name') && ++checks === 2) { await blocked; return Buffer.from('Synkora_A\nOK\n') }
    return undefined
  }}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  const first=f.manager.act('m',session.id,{type:'key',key:'home'})
  const second=f.manager.act('m',session.id,{type:'key',key:'back'})
  await new Promise(resolve=>setImmediate(resolve)); unlock()
  assert.equal((await first).ok && (await second).ok,true)
  assert.deepEqual(f.calls.filter(c=>c.args.at(-1)?.startsWith("'input' 'keyevent'")).map(c=>c.args.at(-1)),["'input' 'keyevent' '3'","'input' 'keyevent' '4'"])
})
test('caller cancellation prevents queued reverse and openUrl effects after the preceding action completes', async t => {
  let enteredResolve, release
  const entered=new Promise(resolve=>{enteredResolve=resolve}), blocked=new Promise(resolve=>{release=resolve})
  const f=fixture({run:async c=>{
    if (c.args.at(-1) !== "'input' 'keyevent' '3'") return undefined
    enteredResolve(); await blocked; return Buffer.alloc(0)
  }}); t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  const preceding=f.manager.act('m',session.id,{type:'key',key:'home'}); await entered
  const controller=new AbortController()
  const reverse=f.manager.act('m',session.id,{type:'reverse',port:8081},undefined,controller.signal)
  const open=f.manager.act('m',session.id,{type:'openUrl',url:'exp://127.0.0.1:8081'},undefined,controller.signal)
  controller.abort(); release()
  assert.equal((await preceding).ok,true)
  assert.equal((await reverse).ok,false); assert.equal((await open).ok,false)
  assert.ok(!f.calls.some(c=>c.args.includes('reverse') || c.args.at(-1)?.startsWith("'am' 'start'")))
})
test('Android openUrl requires the Activity Manager success receipt, not exit zero alone', async t => {
  const f=fixture({run:async c=>c.args.some(x=>x.includes("'am' 'start'")) ? Buffer.from('Starting: Intent\nComplete\n') : undefined})
  t.after(()=>f.manager.dispose())
  const {value:session}=await f.manager.start('m',android())
  assert.equal((await f.manager.act('m',session.id,{type:'openUrl',url:'missing-app://test'})).ok,false)
})
test('uncertain iOS boot can be released by read-only proof after manual shutdown', async () => {
  let booted=true
  const f=fixture({platform:'darwin',run:async c=>{
    if (c.args[1] === 'boot') throw new MobileProcessError('timeout')
    if (c.args[1] === 'list') return Buffer.from(JSON.stringify({devices:{'com.apple.CoreSimulator.SimRuntime.iOS-18-0':[{udid:'12345678-1234-1234-1234-123456789ABC',name:'iPhone',state:booted ? 'Booted':'Shutdown',isAvailable:true}]}}))
    return undefined
  }})
  assert.equal((await f.manager.start('m',{platform:'ios',deviceId:f.discovery.devices[2].id})).ok,false)
  const session=(await f.manager.inspect('m')).value.sessions[0]; assert.equal(session.state,'error')
  booted=false; assert.equal((await f.manager.stop('m',session.id)).ok,true)
  assert.ok(!f.calls.some(c=>c.args[1] === 'shutdown'),'uncertain ownership never authorizes shutdown')
})
test('process executor bounds output and masks process errors without inheriting tokens', async () => {
  const env=mobileProcessEnvironment({PATH:'synthetic',SystemRoot:'synthetic',OPENAI_API_KEY:'synthetic-secret',ADB_SERVER_SOCKET:'tcp:third-party',SYNKORA_TOKEN:'synthetic-secret'})
  assert.deepEqual(env,{PATH:'synthetic',SystemRoot:'synthetic'})
  await assert.rejects(mobileExecutor.run({executable:process.execPath,args:['-e','process.stdout.write("x".repeat(5000))'],maxBytes:64}),error=>error instanceof MobileProcessError && error.reason === 'limit')
  await assert.rejects(mobileExecutor.run({executable:process.execPath,args:['-e','process.stderr.write("synthetic-sensitive-output");process.exit(3)']}),error=>error instanceof MobileProcessError && !error.message.includes('synthetic-sensitive'))
})

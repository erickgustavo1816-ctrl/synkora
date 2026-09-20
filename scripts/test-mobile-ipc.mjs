import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: ['src/main/ipc/mobile.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] })

function fixture() {
  const handlers = new Map()
  const events = new Map()
  const calls = []
  const loaded = { exports: {} }
  const nativeRequire = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'electron'
    ? { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback), on: (channel, callback) => events.set(channel, callback) } } : nativeRequire(name), loaded, loaded.exports)
  const okay = async (...args) => { calls.push(args); return { ok: true, value: undefined } }
  const runtime = { inspect: okay, start: okay, stop: okay, capture: okay, act: okay, pointer: okay }
  const expo = { inspect: okay, start: okay, stop: okay, openAndroid: okay, installGo: okay }
  const presentation = Object.fromEntries(['detach', 'focusDetached', 'dock'].map(name => [name, okay]))
  for (const name of ['capture', 'act', 'pointer', 'acquireView', 'releaseView', 'setVideoVisible']) presentation[name] = async (_surface, ...args) => okay(...args)
  presentation.decorate = value => value
  presentation.acknowledge = (_surface, ...args) => calls.push(args)
  loaded.exports.registerMobileIpc({ assertOwnerSender: event => { if (event !== 'owner') throw new Error('denied') }, runtime, expo,
    presentation, ownerSurface: () => 'owner-surface', resolvePhone: () => { throw new Error('no registered phone') },
    monitorScale: async () => { calls.push([]); return null },
    calibration: { read: key => { calls.push([key]); return null }, write: (key, value) => { calls.push([key, value]); return true } } })
  return { handlers, events, calls, runtime, presentation }
}

const payloads = {
  'mobile:monitorScale': [],
  'mobile:calibrationRead': ['synkora.mobile.calibration.v3:1920:1080:0:0:1:1:unidentified'],
  'mobile:calibrationWrite': ['synkora.mobile.calibration.v3:1920:1080:0:0:1:1:unidentified', 3.6],
  'mobile:expoInspect': ['mission-a'],
  'mobile:expoStart': ['mission-a', { address: '192.168.0.2' }],
  'mobile:expoStop': ['mission-a'],
  'mobile:expoOpenAndroid': ['mission-a', 'session-a'],
  'mobile:expoInstallGo': ['mission-a', 'session-a'],
  'mobile:inspect': ['mission-a'],
  'mobile:start': ['mission-a', { platform: 'android', deviceId: 'avd-a' }],
  'mobile:stop': ['mission-a', 'session-a'],
  'mobile:detach': ['mission-a', 'session-a'],
  'mobile:focusDetached': ['mission-a', 'session-a'],
  'mobile:dock': ['mission-a', 'session-a'],
  'mobile:acquireView': ['mission-a', 'session-a'],
  'mobile:releaseView': ['mission-a', 'session-a', 'consumer-a'],
  'mobile:capture': ['mission-a', 'session-a', 'consumer-a'],
  'mobile:act': ['mission-a', 'session-a', { type: 'tap', x: 0.5, y: 0.5 }, 'consumer-a'],
  'mobile:pointer': ['mission-a', 'session-a', { phase: 'down', gestureId: 'gesture-a', x: 0.5, y: 0.5 }, 'consumer-a'],
  'mobile:setVideoVisible': ['mission-a', 'session-a', true, 'consumer-a']
}

test('every mobile IPC channel denies foreign renderers before calling runtime', async () => {
  const f = fixture()
  assert.deepEqual([...f.handlers.keys()].filter(name => !name.startsWith('mobile:phone:')).sort(), Object.keys(payloads).sort())
  for (const [channel, args] of Object.entries(payloads)) {
    const result = await f.handlers.get(channel)('foreign', ...args)
    assert.equal(result.ok, false, channel)
  }
  f.events.get('mobile:videoAck')('foreign', 'mission-a', 'session-a', 'stream-a', 1000)
  assert.equal(f.calls.length, 0)
})

test('video acknowledgments validate owner, exact session/stream and integer timestamp', () => {
  const f = fixture()
  const acknowledge = f.events.get('mobile:videoAck')
  acknowledge('owner', 'mission-a', 'session-a', 'stream-a', Infinity, 'consumer-a')
  acknowledge('owner', 'mission-a', 'session-a', '', 1000, 'consumer-a')
  assert.equal(f.calls.length, 0)
  acknowledge('owner', 'mission-a', 'session-a', 'stream-a', 1000, 'consumer-a')
  assert.deepEqual(f.calls, [['mission-a', 'session-a', 'stream-a', 1000, 'consumer-a']])
})

test('owner IPC validates IDs and discriminated payloads before an effect', async () => {
  const f = fixture()
  for (const [channel, args] of Object.entries(payloads)) {
    const result = await f.handlers.get(channel)('owner', '', ...args.slice(1))
    assert.equal(result.ok, false)
  }
  assert.equal((await f.handlers.get('mobile:start')('owner', 'mission-a', { platform: 'android', deviceId: 'avd-a', actor: { kind: 'owner' } })).ok, false)
  assert.equal((await f.handlers.get('mobile:act')('owner', 'mission-a', 'session-a', { type: 'shell', command: 'anything' })).ok, false)
  assert.equal((await f.handlers.get('mobile:setVideoVisible')('owner', 'mission-a', 'session-a', 'yes')).ok, false)
  for (const request of [{ port: 8081 }, { url: 'exp://example.invalid' }, { address: 'https://example.invalid' }, { address: '192.168.0.2', actor: { kind: 'owner' } }]) {
    assert.equal((await f.handlers.get('mobile:expoStart')('owner', 'mission-a', request)).ok, false)
  }
  assert.equal((await f.handlers.get('mobile:expoInstallGo')('owner', 'mission-a', 'session-a', '/outside.apk')).ok, false)
  assert.equal(f.calls.length, 0)
})

test('owner IPC forwards only allowlisted Android display profiles with the fixed owner actor', async () => {
  const f = fixture()
  for (const profileId of ['native', 'pixel-7', 'pixel-9', 'galaxy-s24', 'galaxy-s24-ultra', 'galaxy-a54']) {
    const start = { platform: 'android', deviceId: 'avd-a', displayProfileId: profileId }
    assert.equal((await f.handlers.get('mobile:start')('owner', 'mission-a', start)).ok, true)
    assert.deepEqual(f.calls.at(-1), ['mission-a', start, { kind: 'owner' }])
    const action = { type: 'displayProfile', profileId }
    assert.equal((await f.handlers.get('mobile:act')('owner', 'mission-a', 'session-a', action)).ok, true)
    assert.deepEqual(f.calls.at(-1), ['mission-a', 'session-a', action, { kind: 'owner' }])
  }
})

test('display profile IPC denies foreign renderers, unknown IDs, dimensions and platform mismatches', async () => {
  const f = fixture()
  assert.equal((await f.handlers.get('mobile:start')('foreign', 'mission-a', { platform: 'android', deviceId: 'avd-a', displayProfileId: 'pixel-7' })).ok, false)
  assert.equal((await f.handlers.get('mobile:act')('foreign', 'mission-a', 'session-a', { type: 'displayProfile', profileId: 'native' })).ok, false)
  for (const profileId of ['unknown', 'Pixel 7', 'pixel-7;unexpected', ' pixel-7', 'pixel-7\n', null, 7, { id: 'pixel-7' }]) {
    assert.equal((await f.handlers.get('mobile:start')('owner', 'mission-a', { platform: 'android', deviceId: 'avd-a', displayProfileId: profileId })).ok, false)
    assert.equal((await f.handlers.get('mobile:act')('owner', 'mission-a', 'session-a', { type: 'displayProfile', profileId })).ok, false)
  }
  for (const extra of [{ width: 1080 }, { height: 2400 }, { density: 420 }, { command: 'synthetic' }, { actor: { kind: 'owner' } }]) {
    assert.equal((await f.handlers.get('mobile:start')('owner', 'mission-a', { platform: 'android', deviceId: 'avd-a', displayProfileId: 'pixel-7', ...extra })).ok, false)
    assert.equal((await f.handlers.get('mobile:act')('owner', 'mission-a', 'session-a', { type: 'displayProfile', profileId: 'pixel-7', ...extra })).ok, false)
  }
  assert.equal((await f.handlers.get('mobile:start')('owner', 'mission-a', { platform: 'ios', deviceId: 'simulator-a', displayProfileId: 'native' })).ok, false)
  assert.equal(f.calls.length, 0)
})

test('owner pointer IPC forwards each bounded phase without a caller-selected actor', async () => {
  const f = fixture()
  const pointer = f.handlers.get('mobile:pointer')
  for (const [index, phase] of ['down', 'move', 'up', 'cancel'].entries()) {
    const input = { phase, gestureId: index === 0 ? 'a'.repeat(64) : 'gesture-A_2', x: index % 2, y: (index + 1) % 2 }
    assert.equal((await pointer('owner', 'mission-a', 'session-a', input, 'consumer-a')).ok, true)
    assert.deepEqual(f.calls.at(-1), ['mission-a', 'session-a', input, 'consumer-a'])
  }
  assert.equal(f.calls.length, 4)
})

test('pointer IPC rejects invalid input, missing sessions and extra authority before forwarding', async () => {
  const f = fixture()
  const pointer = f.handlers.get('mobile:pointer')
  const valid = { phase: 'move', gestureId: 'gesture-a', x: 0.3, y: 0.7 }
  const invalid = [
    { ...valid, phase: 'tap' }, { ...valid, phase: 'MOVE' },
    ...[NaN, Infinity, -Infinity, -0.01, 1.01, '0.5', null].flatMap(value => [{ ...valid, x: value }, { ...valid, y: value }]),
    ...['', 'a'.repeat(65), 'gesture a', 'gesture/a', 'gesture\n', 'ação', null, 1].map(gestureId => ({ ...valid, gestureId })),
    { ...valid, actor: { kind: 'owner' } }, { ...valid, missionId: 'other' }, { ...valid, sessionId: 'other' },
    { ...valid, command: 'synthetic' }, { phase: 'up', gestureId: 'gesture-a', x: 0.3 }, null
  ]
  for (const input of invalid) assert.equal((await pointer('owner', 'mission-a', 'session-a', input, 'consumer-a')).ok, false)
  for (const args of [[], ['mission-a'], ['mission-a', valid], ['mission-a', '', valid],
    ['mission-a', 'session-a', valid, { kind: 'owner' }]]) {
    assert.equal((await pointer('owner', ...args)).ok, false)
  }
  assert.equal(f.calls.length, 0)
})

test('pointer IPC fails closed when a coordinator lacks the method or throws', async () => {
  const f = fixture()
  const pointer = f.handlers.get('mobile:pointer')
  delete f.presentation.pointer
  const absent = await pointer('owner', ...payloads['mobile:pointer'])
  assert.equal(absent.ok, false)
  assert.match(absent.error, /Atualize o painel/u)
  f.presentation.pointer = async () => { throw new Error('synthetic-private-pointer-error') }
  const failed = await pointer('owner', ...payloads['mobile:pointer'])
  assert.equal(failed.ok, false)
  assert.doesNotMatch(failed.error, /synthetic-private-pointer/u)
  assert.equal(f.calls.length, 0)
})

test('owner operations use the fixed owner actor and return failures without raw errors', async () => {
  const f = fixture()
  for (const [channel, args] of Object.entries(payloads)) {
    assert.equal((await f.handlers.get(channel)('owner', ...args)).ok, true)
    if (['mobile:monitorScale', 'mobile:calibrationRead', 'mobile:calibrationWrite', 'mobile:pointer', 'mobile:setVideoVisible', 'mobile:detach', 'mobile:focusDetached', 'mobile:dock', 'mobile:acquireView', 'mobile:releaseView', 'mobile:capture', 'mobile:act'].includes(channel)) assert.deepEqual(f.calls.at(-1), args)
    else assert.deepEqual(f.calls.at(-1).at(-1), { kind: 'owner' })
  }
  assert.equal((await f.handlers.get('mobile:expoStart')('owner', 'mission-a')).ok, true)
  assert.deepEqual(f.calls.at(-1), ['mission-a', undefined, { kind: 'owner' }])
  f.presentation.capture = async () => { throw new Error('private-process-output') }
  const failed = await f.handlers.get('mobile:capture')('owner', 'mission-a', 'session-a', 'consumer-a')
  assert.equal(failed.ok, false)
  assert.doesNotMatch(failed.error, /private-process/u)
})

test('preload subscribes and removes exactly its own mobile listeners', () => {
  const built = buildSync({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] })
  const calls = [], listeners = new Map(), exposed = new Map()
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }) }, send: (...args) => calls.push(args),
      on: (channel, listener) => listeners.set(channel, listener), removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel) } } }
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'process', 'window', built.outputFiles[0].text)(() => electron, loaded, loaded.exports, { argv: [] }, new EventTarget())
  const mobile = exposed.get('synkora').mobile
  const got = []
  const offState = mobile.onChanged(value => got.push(value))
  const offVideo = mobile.onVideo(value => got.push(value))
  listeners.get('mobile:changed')({}, 'mission-a')
  const packet = { missionId: 'mission-a', sessionId: 'session-a', data: new Uint8Array([1]) }
  listeners.get('mobile:video')({}, packet)
  assert.deepEqual(got, ['mission-a', packet])
  offState(); offVideo()
  assert.equal(listeners.size, 0)
  mobile.inspect('mission-a'); mobile.setVideoVisible('mission-a', 'session-a', true, 'consumer-a'); mobile.ackVideo('mission-a', 'session-a', 'stream-a', 1000, 'consumer-a')
  mobile.expoInspect('mission-a'); mobile.expoStart('mission-a', { address: '192.168.0.2' }); mobile.expoStop('mission-a')
  mobile.expoOpenAndroid('mission-a', 'session-a'); mobile.expoInstallGo('mission-a', 'session-a')
  const pointer = { phase: 'move', gestureId: 'gesture-A_2', x: 0.25, y: 0.75 }
  mobile.pointer('mission-a', 'session-a', pointer, 'consumer-a')
  mobile.monitorScale()
  assert.deepEqual(calls, [['mobile:inspect', 'mission-a'], ['mobile:setVideoVisible', 'mission-a', 'session-a', true, 'consumer-a'], ['mobile:videoAck', 'mission-a', 'session-a', 'stream-a', 1000, 'consumer-a'],
    ['mobile:expoInspect', 'mission-a'], ['mobile:expoStart', 'mission-a', { address: '192.168.0.2' }], ['mobile:expoStop', 'mission-a'],
    ['mobile:expoOpenAndroid', 'mission-a', 'session-a'], ['mobile:expoInstallGo', 'mission-a', 'session-a'],
    ['mobile:pointer', 'mission-a', 'session-a', pointer, 'consumer-a'], ['mobile:monitorScale']])
})

test('main installs owner guard and mobile kit before creating owner windows', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  assert.match(main, /createMobileIntegration\(/u)
  assert.match(main, /cacheRoot:\s*join\(app\.getPath\('userData'\),\s*'mobile',\s*'expo-go'\)/u)
  assert.match(main, /mobile:\s*mobile\.toolkit/u)
  assert.match(main, /mobile\.registerIpc\(assertMainRendererSender\)/u)
  assert.ok(main.indexOf('mobile.registerIpc(assertMainRendererSender)') < main.lastIndexOf('createWindow('))
  assert.match(main, /mobile\.closeMission\(missionId\)/u)
  assert.match(main, /missions\.list\(projectId\)\.map\(mission => mobile\.closeMission\(mission\.id\)\)/u)
})

const quitBuilt = buildSync({ entryPoints: ['src/main/mobileIntegration.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['electron', './mobileRuntime', './mobileExpo', './mobileVideo'] })
const quitModule = { exports: {} }
const nativeRequire = createRequire(import.meta.url)
new Function('require', 'module', 'exports', quitBuilt.outputFiles[0].text)(name => ['./mobileRuntime', './mobileExpo', './mobileVideo'].includes(name) ? {} : nativeRequire(name), quitModule, quitModule.exports)

test('integration revokes both controllers and awaits Expo and simulator cleanup before mission removal or quit', async () => {
  const integrationBuilt = buildSync({ entryPoints: ['src/main/mobileIntegration.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['electron', './mobileRuntime', './mobileExpo', './mobileVideo'] })
  const calls = [], constructors = {}, gates = {}
  const manager = name => class {
    constructor(deps) { constructors[name] = deps }
    releaseController(paneId) { calls.push([name, 'release', paneId]) }
    closeMission(missionId) { calls.push([name, 'close', missionId]); return new Promise(resolve => { gates[`${name}:close`] = resolve }) }
    dispose() { calls.push([name, 'dispose']); return new Promise(resolve => { gates[`${name}:dispose`] = resolve }) }
  }
  class Video {
    constructor(deps) { constructors.video = deps }
    closeMission(missionId) { calls.push(['video', 'close', missionId]); return new Promise(resolve => { gates['video:close'] = resolve }) }
    dispose() { calls.push(['video', 'dispose']); return new Promise(resolve => { gates['video:dispose'] = resolve }) }
  }
  const modules = { './mobileRuntime': { MobileRuntimeManager: manager('runtime') }, './mobileExpo': { MobileExpoManager: manager('expo') }, './mobileVideo': { MobileVideoRegistry: Video } }
  const loaded = { exports: {} }, nativeRequire = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', integrationBuilt.outputFiles[0].text)(name => modules[name] ?? nativeRequire(name), loaded, loaded.exports)
  const ctx = { missions: { get: () => undefined }, projects: { get: () => undefined }, hub: {}, pushBoard() {}, blackbox: { record() {} } }
  const mobile = loaded.exports.createMobileIntegration(ctx, { helperOf: () => undefined, cacheRoot: 'synthetic-managed-cache', inputServerPath: 'synthetic-pinned-server' })
  assert.equal(constructors.runtime.managedApkRoot, 'synthetic-managed-cache')
  assert.equal(constructors.expo.cacheRoot, 'synthetic-managed-cache')
  assert.equal(constructors.video.serverPath, 'synthetic-pinned-server')
  mobile.releaseController('pane-a')
  assert.deepEqual(calls.splice(0), [['expo', 'release', 'pane-a'], ['runtime', 'release', 'pane-a']])
  let closed = false
  const closing = mobile.closeMission('mission-a').then(() => { closed = true })
  assert.deepEqual(calls.splice(0), [['video', 'close', 'mission-a'], ['expo', 'close', 'mission-a'], ['runtime', 'close', 'mission-a']])
  gates['runtime:close'](); await Promise.resolve()
  assert.equal(closed, false)
  gates['expo:close'](); await Promise.resolve(); await Promise.resolve()
  assert.equal(closed, false, 'video transport cleanup is part of mission teardown')
  gates['video:close'](); await closing
  let beforeQuit, quits = 0, complete
  const finished = new Promise(resolve => { complete = resolve })
  mobile.installQuit({ on: (_name, callback) => { beforeQuit = callback }, quit: () => { quits++; complete() } })
  beforeQuit({ preventDefault() {} }); await Promise.resolve()
  assert.deepEqual(calls.splice(0), [['video', 'dispose'], ['expo', 'dispose'], ['runtime', 'dispose']])
  gates['runtime:dispose'](); await Promise.resolve()
  assert.equal(quits, 0)
  gates['expo:dispose'](); await Promise.resolve(); await Promise.resolve()
  assert.equal(quits, 0, 'video transport cleanup is part of application teardown')
  gates['video:dispose'](); await finished
  assert.equal(quits, 1)
})

test('quit waits once for runtime cleanup, rejects repeated quit attempts and then resumes', async () => {
  let beforeQuit, disposed = 0, prevented = 0, quits = 0, complete
  const cleaning = new Promise(resolve => { complete = resolve })
  let ended
  const quitFinished = new Promise(resolve => { ended = resolve })
  const event = { preventDefault: () => { prevented++ } }
  const lifecycle = { on: (name, listener) => { assert.equal(name, 'before-quit'); beforeQuit = listener },
    quit: () => { quits++; beforeQuit(event); ended() } }
  quitModule.exports.installMobileQuitGuard(lifecycle, async () => { disposed++; await cleaning }, () => assert.fail('unexpected timeout'), 1000)
  beforeQuit(event); beforeQuit(event)
  await Promise.resolve()
  assert.equal(disposed, 1)
  assert.equal(prevented, 2)
  assert.equal(quits, 0)
  complete()
  await quitFinished
  assert.equal(quits, 1)
  assert.equal(prevented, 2, 'the final quit is allowed through')
})

test('a stuck runtime cannot indefinitely block closing the application', async () => {
  let beforeQuit, timedOut = 0, ended
  const finished = new Promise(resolve => { ended = resolve })
  quitModule.exports.installMobileQuitGuard({ on: (_name, listener) => { beforeQuit = listener }, quit: () => ended() },
    () => new Promise(() => {}), () => { timedOut++ }, 10)
  beforeQuit({ preventDefault() {} })
  await finished
  assert.equal(timedOut, 1)
})

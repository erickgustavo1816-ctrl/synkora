import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MobileExpoManager } from '../.tmp/mobile-expo-test/main/mobileExpo.js'
import { inspectExpoProject, privateExpoAddresses, expoProcessEnvironment } from '../.tmp/mobile-expo-test/main/mobileExpoProject.js'
import { downloadExpoGo, validateExpoOpenResponse, expoDownloadUrlAllowed } from '../.tmp/mobile-expo-test/main/mobileExpoNetwork.js'
import { createExpoLauncher } from '../.tmp/mobile-expo-test/main/mobileExpoProcess.js'

const owner = { kind: 'owner' }, agent = { kind: 'agent', paneId: 'pane-a' }, peer = { kind: 'agent', paneId: 'pane-b' }
const apk = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('synthetic Expo Go package')])
const digest = createHash('sha256').update(apk).digest('hex')
const apkUrl = 'https://github.com/expo/expo-go-releases/releases/download/Expo-Go-57.0.9/Expo-Go-57.0.9.apk'
const response = (value, status = 200, headers = {}) => ({ status, headers, body: (async function* () { yield Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) })() })
function tempProject(t, deps = { expo: '~57.0.24', 'react-native': '0.86.3' }, installed = true) {
  mkdirSync('.tmp', { recursive: true })
  const temp = mkdtempSync(resolve('.tmp/mobile-expo-')), root = join(temp, 'project'), cache = join(temp, 'cache')
  mkdirSync(root); t.after(() => rmSync(temp, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: deps }))
  if (installed) {
    mkdirSync(join(root, 'node_modules/expo/bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules/expo/package.json'), JSON.stringify({ name: 'expo', version: '57.0.24', bin: { expo: '../../hostile.js' } }))
    writeFileSync(join(root, 'node_modules/expo/bin/cli'), '// synthetic local CLI')
  }
  return { temp, root, cache }
}
function fixture(t, options = {}) {
  const dirs = tempProject(t, options.dependencies, options.installed), launches = [], actions = [], installs = [], requests = []
  let scope = { projectId: 'p', rootPath: dirs.root }, running = true, resolveExit, nextPort = 18081
  const runtime = {
    async inspect() { return { ok: true, value: { sessions: [{ id: 'android', missionId: 'mission', platform: 'android', state: 'ready', controllerPaneId: options.deviceController ?? 'pane-a' }, { id: 'ios', missionId: 'mission', platform: 'ios', state: 'ready' }] } } },
    async act(mission, session, action, actor, signal) { actions.push({ mission, session, action, actor, signal }); return options.act ? options.act(action, signal) : { ok: true, value: undefined } },
    async installManagedApk(mission, session, path, actor, signal, expectedRoot) { installs.push({ mission, session, path, actor, signal, expectedRoot }); return options.install ? options.install(signal) : { ok: true, value: undefined } }
  }
  const transport = async (url, request) => {
    requests.push(url.href)
    const custom = await options.transport?.(url, request)
    if (custom) return custom
    if (url.pathname === '/status') return response('packager-status:running')
    if (url.pathname === '/_expo/open') return response({ runtime: 'expo', url: `exp://192.168.10.2:${url.port}` })
    if (url.hostname === 'exp.host') return response({ sdkVersions: { '57.0.0': { androidClientUrl: apkUrl, androidClientVersion: '57.0.9' } } })
    if (url.hostname === 'api.github.com') return response({ assets: [{ name: 'Expo-Go-57.0.9.apk', browser_download_url: apkUrl, size: apk.length, digest: `sha256:${digest}` }] })
    if (url.hostname === 'github.com') return response(apk)
    throw new Error('unexpected synthetic URL')
  }
  const manager = new MobileExpoManager({ resolveMission: id => id === 'mission' || id === 'mission-two' ? scope : null, cacheRoot: dirs.cache, runtime,
    addresses: () => ['192.168.10.2', '10.0.0.3'], transport,
    reservePort: async () => ({ port: options.port ?? nextPort++, release: async () => {} }),
    launch: async command => {
      launches.push(command)
      if (options.launch) return options.launch(command)
      const exited = new Promise(resolve => { resolveExit = resolve })
      return { isAlive: () => running, exited, stop: async () => { running = false; resolveExit(); return true } }
    }, pollMs: 1, startTimeoutMs: 1000, ...(typeof options.manager === 'function' ? options.manager(dirs) : options.manager) })
  t.after(() => manager.dispose())
  return { ...dirs, manager, transport, launches, actions, requests, installs, setScope: value => { scope = value }, exit: () => { running = false; resolveExit?.() } }
}

test('structural discovery identifies Expo, uses the fixed local CLI and never evaluates config', async t => {
  const f = tempProject(t)
  writeFileSync(join(f.root, 'app.config.js'), 'throw new Error("never evaluate")')
  const found = await inspectExpoProject(f.root)
  assert.equal(found.project.kind, 'expo'); assert.equal(found.project.sdkVersion, '57.0.0')
  assert.equal(found.project.dependenciesInstalled, true); assert.equal(found.cliPath, join(f.root, 'node_modules/expo/bin/cli'))
  assert.match(found.project.message, /mesma conta/u)
})

test('React Native without Expo and missing dependencies get actionable honest setup', async t => {
  const bare = tempProject(t, { 'react-native': '0.86.3' }, false)
  const discovered = await inspectExpoProject(bare.root)
  assert.equal(discovered.project.kind, 'react-native'); assert.match(discovered.project.message, /React Native/u)
  const f = fixture(t, { installed: false })
  assert.equal((await f.manager.start('mission')).ok, false); assert.equal(f.launches.length, 0)
})

test('Electron is identified structurally as a desktop project that Expo Go cannot open', async t => {
  const f = fixture(t, { dependencies: { electron: '^43.1.1', react: '^19.2.7' }, installed: false })
  const inspected = await f.manager.inspect('mission')
  assert.equal(inspected.value.project.kind, 'other')
  assert.match(inspected.value.project.message, /Electron/u)
  assert.match(inspected.value.project.message, /computador/u)
  assert.equal((await f.manager.start('mission')).ok, false)
  assert.equal(f.launches.length, 0); assert.equal(f.actions.length, 0)
})

test('discovery rejects oversized JSON and dependencies escaping the real project', async t => {
  const f = tempProject(t, undefined, false)
  const external = join(f.temp, 'external'); mkdirSync(join(external, 'expo/bin'), { recursive: true })
  writeFileSync(join(external, 'expo/package.json'), '{"name":"expo","version":"57.0.24"}')
  writeFileSync(join(external, 'expo/bin/cli'), 'hostile')
  symlinkSync(external, join(f.root, 'node_modules'), 'junction')
  assert.equal((await inspectExpoProject(f.root)).project.dependenciesInstalled, false)
  writeFileSync(join(f.root, 'package.json'), ' '.repeat(300_000))
  await assert.rejects(inspectExpoProject(f.root))
})

test('interface discovery admits only noninternal private IPv4 and environment drops inherited authority', () => {
  const entry = (address, internal = false, family = 'IPv4') => ({ address, internal, family, netmask: '', mac: '', cidr: null })
  assert.deepEqual(privateExpoAddresses({ WiFi: [entry('192.168.2.4'), entry('127.0.0.1', true), entry('8.8.8.8'), entry('::1', false, 'IPv6'), entry('172.16.2.3'), entry('192.168.2.4')] }), ['172.16.2.3', '192.168.2.4'])
  const env = expoProcessEnvironment('192.168.2.4', { PATH: 'safe', USERPROFILE: 'home', NODE_OPTIONS: '--require hostile', EXPO_TOKEN: 'secret', SYNKORA_MCP_TOKEN: 'secret', HTTP_PROXY: 'secret', CLAUDECODE: '1', NO_COLOR: '1' })
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.EXPO_TOKEN, undefined); assert.equal(env.SYNKORA_MCP_TOKEN, undefined)
  assert.equal(env.HTTP_PROXY, undefined); assert.equal(env.CLAUDECODE, undefined); assert.equal(env.NO_COLOR, undefined)
  assert.equal(env.REACT_NATIVE_PACKAGER_HOSTNAME, '192.168.2.4'); assert.equal(env.CI, '1')
})

test('start owns a scoped process and publishes a local PNG QR only after readiness', async t => {
  const f = fixture(t)
  const result = await f.manager.start('mission', { address: '192.168.10.2' }, agent)
  assert.equal(result.ok, true); const state = result.value
  assert.equal(state.status, 'running'); assert.equal(state.lanUrl, 'exp://192.168.10.2:18081')
  assert.equal(state.androidUrl, 'exp://127.0.0.1:18081'); assert.match(state.qrDataUrl, /^data:image\/png;base64,/u)
  assert.deepEqual(Buffer.from(state.qrDataUrl.split(',')[1], 'base64').subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]))
  assert.equal(f.launches[0].cwd, f.root); assert.deepEqual(f.launches[0].args.slice(1), ['start', '--go', '--lan', '--port', '18081', '--max-workers', '2'])
  assert.equal((await f.manager.stop('mission', peer)).ok, false)
  assert.equal((await f.manager.start('mission', {}, peer)).ok, false)
  assert.equal((await f.manager.stop('mission', owner)).ok, true)
})

test('wrong scope, arbitrary addresses and invalid actors cannot launch or install', async t => {
  const f = fixture(t)
  for (const [mission, request, actor] of [['missing', {}, owner], ['mission', { address: '8.8.8.8' }, owner], ['mission', {}, { kind: 'agent', paneId: '' }]]) {
    assert.equal((await f.manager.start(mission, request, actor)).ok, false)
  }
  assert.equal(f.launches.length, 0)
  await f.manager.start('mission', {}, agent); f.setScope({ projectId: 'other', rootPath: f.root })
  assert.equal((await f.manager.openAndroid('mission', 'android', agent)).ok, false); assert.equal(f.actions.length, 0)
})

test('Android open reverses only the owned port and keeps actor on both runtime effects', async t => {
  const f = fixture(t); await f.manager.start('mission', {}, agent)
  assert.equal((await f.manager.openAndroid('mission', 'ios', agent)).ok, false)
  assert.equal((await f.manager.openAndroid('mission', 'android', peer)).ok, false)
  assert.equal((await f.manager.openAndroid('mission', 'android', agent)).ok, true)
  assert.deepEqual(f.actions.map(c => c.action), [{ type: 'reverse', port: 18081 }, { type: 'openUrl', url: 'exp://127.0.0.1:18081' }])
  assert.ok(f.actions.every(c => c.actor === agent && c.session === 'android'))
})

test('opening Android probes Metro again and rejects a live process with an unavailable server', async t => {
  let serving = true
  const f = fixture(t, { transport: url => url.pathname === '/status' && !serving ? response('not running', 503) : undefined })
  assert.equal((await f.manager.start('mission', {}, agent)).ok, true)
  serving = false
  const opened = await f.manager.openAndroid('mission', 'android', agent)
  assert.equal(opened.ok, false); assert.match(opened.error, /servidor Expo/u)
  assert.equal(f.actions.length, 0)
  const state = await f.manager.inspect('mission')
  assert.equal(state.value.status, 'error'); assert.equal(state.value.qrDataUrl, undefined)
})

test('a server lost while Android reverse waits cannot receive a stale open intent', async t => {
  let serving = true
  const f = fixture(t, { transport: url => url.pathname === '/status' && !serving ? response('', 503) : undefined,
    act: action => { if (action.type === 'reverse') serving = false; return { ok: true, value: undefined } } })
  assert.equal((await f.manager.start('mission', {}, agent)).ok, true)
  assert.equal((await f.manager.openAndroid('mission', 'android', agent)).ok, false)
  assert.deepEqual(f.actions.map(call => call.action.type), ['reverse'])
})

test('controller release immediately revokes old work and permits an explicit fresh claim', async t => {
  let unblock, started
  const reached = new Promise(r => { started = r })
  const f = fixture(t, { act: action => action.type === 'reverse' ? new Promise(resolve => { unblock = () => resolve({ ok: true, value: undefined }); started() }) : { ok: true, value: undefined } })
  await f.manager.start('mission', {}, agent)
  const pending = f.manager.openAndroid('mission', 'android', agent); await reached
  f.manager.releaseController('pane-a'); unblock()
  assert.equal((await pending).ok, false); assert.equal(f.actions.length, 1)
  assert.equal((await f.manager.start('mission', {}, peer)).ok, true)
})

test('stopping Expo aborts Android actions already queued in the native runtime', async t => {
  let release, entered, effects = 0
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture(t, { act: (_action, signal) => new Promise(resolve => {
    entered(); release = () => { if (!signal.aborted) effects++; resolve(signal.aborted ? { ok: false, error: 'cancelled' } : { ok: true, value: undefined }) }
  }) })
  await f.manager.start('mission', {}, agent)
  const pending = f.manager.openAndroid('mission', 'android', agent); await started
  const stopped = f.manager.stop('mission'); assert.equal(f.actions[0].signal.aborted, true)
  release(); assert.equal((await pending).ok, false); assert.equal((await stopped).ok, true); assert.equal(effects, 0)
})

test('mission close aborts a pending APK stream and leaves no partial artifact or install', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture(t, { transport: (url, request) => {
    if (url.hostname !== 'github.com') return
    return { status: 200, headers: {}, body: (async function* () {
      yield apk.subarray(0, 4); entered()
      await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('synthetic cancelled stream')), { once: true }))
    })() }
  } })
  await f.manager.start('mission', {}, agent)
  const installing = f.manager.installGo('mission', 'android', agent); await started
  await f.manager.closeMission('mission')
  assert.equal((await installing).ok, false); assert.equal(f.installs.length, 0); assert.deepEqual(readdirSync(f.cache), [])
})

test('uncertain process cleanup retains the lease and stop can be retried', async t => {
  let canStop = false
  const f = fixture(t, { launch: async () => ({ isAlive: () => true, exited: new Promise(() => {}), stop: async () => canStop }) })
  await f.manager.start('mission', {}, agent)
  assert.equal((await f.manager.stop('mission', agent)).ok, false)
  const inspected = await f.manager.inspect('mission')
  assert.equal(inspected.value.status, 'error'); assert.equal(inspected.value.port, 18081); assert.equal(inspected.value.qrDataUrl, undefined)
  assert.equal((await f.manager.start('mission')).ok, false)
  assert.equal((await f.manager.stop('mission', peer)).ok, false)
  canStop = true; assert.equal((await f.manager.stop('mission', agent)).ok, true)
})

test('stop during startup revokes readiness and awaits an owned child that arrives late', async t => {
  let release, reached, stopped = false
  const launched = new Promise(r => { reached = r })
  const f = fixture(t, { launch: () => { reached(); return new Promise(r => { release = () => r({ isAlive: () => !stopped, exited: new Promise(() => {}), stop: async () => { stopped = true; return true } }) }) } })
  const pending = f.manager.start('mission', {}, agent); await launched
  const stop = f.manager.stop('mission', owner); release()
  assert.equal((await pending).ok, false); assert.equal((await stop).ok, true); assert.equal(stopped, true)
  assert.equal((await f.manager.inspect('mission')).value.status, 'idle')
})

test('concurrent missions cannot reuse an already reserved port', async t => {
  const f = fixture(t, { port: 18081 })
  assert.equal((await f.manager.start('mission')).ok, true)
  assert.equal((await f.manager.start('mission-two')).ok, false)
  assert.equal(f.launches.length, 1)
})

test('Expo endpoint deep links cannot change authority, runtime, port, credentials or query', () => {
  assert.equal(validateExpoOpenResponse({ runtime: 'expo', url: 'exp://192.168.1.2:18081' }, '192.168.1.2', 18081), true)
  for (const url of ['exp://evil.test:18081', 'exp://192.168.1.2:18082', 'exp://u:p@192.168.1.2:18081', 'exp://192.168.1.2:18081?url=evil', 'https://192.168.1.2:18081']) {
    assert.equal(validateExpoOpenResponse({ runtime: 'expo', url }, '192.168.1.2', 18081), false)
  }
  assert.equal(validateExpoOpenResponse({ runtime: 'custom', url: 'exp://192.168.1.2:18081' }, '192.168.1.2', 18081), false)
})

test('hostile Expo response fails closed instead of becoming a QR', async t => {
  const f = fixture(t, { transport: url => url.pathname === '/_expo/open' ? response({ runtime: 'expo', url: 'exp://hostile.example:18081' }) : undefined })
  assert.equal((await f.manager.start('mission')).ok, false)
})

test('explicit install downloads SDK-matched official APK and verifies available digest', async t => {
  const f = fixture(t); await f.manager.start('mission', {}, agent)
  assert.equal(f.requests.some(url => url.includes('exp.host')), false)
  assert.equal((await f.manager.installGo('mission', 'android', peer)).ok, false)
  assert.equal((await f.manager.installGo('mission', 'android', agent)).ok, true)
  assert.equal(f.installs.length, 1); assert.equal(f.installs[0].actor, agent)
  assert.equal(f.installs[0].expectedRoot, f.cache)
  assert.deepEqual(readFileSync(join(f.cache, f.installs[0].path)), apk)
  assert.equal(f.installs[0].signal.aborted, false)
})

test('an ancestor cache junction changing during download cannot retarget the Android install', async t => {
  let alias, second
  const f = fixture(t, { manager: dirs => {
    alias = join(dirs.temp, 'cache-alias'); const first = join(dirs.temp, 'cache-one'); second = join(dirs.temp, 'cache-two')
    mkdirSync(join(first, 'expo-go'), { recursive: true }); mkdirSync(join(second, 'expo-go'), { recursive: true }); symlinkSync(first, alias, 'junction')
    return { cacheRoot: join(alias, 'expo-go') }
  }, transport: url => {
    if (url.hostname === 'github.com') { unlinkSync(alias); symlinkSync(second, alias, 'junction') }
  } })
  await f.manager.start('mission', {}, agent)
  assert.equal((await f.manager.installGo('mission', 'android', agent)).ok, false)
  assert.equal(f.installs.length, 0)
})

test('official download boundary rejects attacker metadata, redirects, size and checksum mismatches', async t => {
  for (const url of ['http://github.com/expo/expo-go-releases/releases/download/a/a.apk', 'https://github.com/attacker/project/releases/download/a/a.apk', 'https://github.com.evil.test/expo/app.apk', 'https://user:pass@github.com/expo/expo-go-releases/releases/download/a/a.apk', 'https://127.0.0.1/a.apk']) {
    assert.equal(expoDownloadUrlAllowed(new URL(url), false), false)
  }
  for (const mode of ['metadata', 'redirect', 'size', 'digest']) {
    const f = fixture(t, { transport: url => {
      if (mode === 'metadata' && url.hostname === 'exp.host') return response({ sdkVersions: { '57.0.0': { androidClientUrl: 'https://evil.test/a.apk' } } })
      if (url.hostname === 'github.com') {
        if (mode === 'redirect') return response('', 302, { location: 'http://127.0.0.1/secret' })
        if (mode === 'size') return response(apk, 200, { 'content-length': '9999999999' })
        if (mode === 'digest') return response(Buffer.from('PK\x03\x04altered bytes'))
      }
    } })
    await assert.rejects(downloadExpoGo('57.0.0', f.cache, { transport: f.transport, signal: new AbortController().signal }))
    assert.equal(f.requests.some(url => url.includes('evil.test') || url.includes('/secret')), false)
    assert.equal(f.installs.length, 0)
  }
})

test('download closes its response if opening the private cache artifact fails', async t => {
  let closed = false
  const f = fixture(t, { transport: url => {
    if (url.hostname !== 'github.com') return
    rmSync(f.cache, { recursive: true }); writeFileSync(f.cache, 'synthetic path obstruction')
    return { ...response(apk), close: () => { closed = true } }
  } })
  await assert.rejects(downloadExpoGo('57.0.0', f.cache, { transport: f.transport, signal: new AbortController().signal }))
  assert.equal(closed, true)
})

function processFixture(onSpawn) {
  const child = new EventEmitter(), abort = new AbortController(), kills = []
  Object.assign(child, { pid: 12345, stdout: { resume() {} }, stderr: { resume() {} }, kill() { throw new Error('must not kill historical pid') } })
  const launch = createExpoLauncher({ platform: 'win32', waitMs: 1, spawn: () => { queueMicrotask(() => { onSpawn?.(child, abort); child.emit('spawn') }); return child },
    terminateTree: async pid => { kills.push(pid); return false } })
  return { child, abort, kills, handle: launch({ executable: 'synthetic-node', args: [], cwd: '.', env: {}, signal: abort.signal }) }
}
test('a parent exit revokes process liveness before inherited output streams close', async () => {
  const f = processFixture(), child = await f.handle
  f.child.emit('exit', 0)
  assert.equal(child.isAlive(), false); await child.exited
  assert.equal(await child.stop(), false); assert.deepEqual(f.kills, [])
  f.child.emit('close', 0); assert.equal(await child.stop(), true)
})
test('a post-spawn process error is never a successful cleanup receipt', async () => {
  const f = processFixture(), child = await f.handle
  f.child.emit('error', Object.assign(new Error('synthetic termination denied'), { code: 'EPERM' }))
  assert.equal(child.isAlive(), true); assert.equal(await child.stop(), false)
  assert.deepEqual(f.kills, [12345]); f.child.emit('exit', 0); f.child.emit('close', 0)
  assert.equal(await child.stop(), true)
})
test('cancellation arriving before spawn receipt retains the owned handle after uncertain cleanup', async () => {
  const f = processFixture((_child, abort) => abort.abort()), child = await f.handle
  assert.equal(child.isAlive(), true); assert.equal(await child.stop(), false)
  assert.deepEqual(f.kills, [12345]); f.child.emit('exit', 0); f.child.emit('close', 0)
  assert.equal(await child.stop(), true)
})

test('the Expo view explains a non-Expo project without offering unavailable phone actions', () => {
  const compiled = buildSync({ stdin: { contents: "export {default} from './components/MobileExpo'", resolveDir: 'src/renderer/src', loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
    external: ['react', 'react/jsx-runtime', 'react-dom'] }).outputFiles[0].text
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), module, module.exports)
  const html = renderToStaticMarkup(React.createElement(module.exports.default, { missionId: 'mission', visible: true, openAndroid() {}, controller: {
    expo: { project: { kind: 'other', dependenciesInstalled: false, hasDevClient: false, message: 'Este projeto usa Electron e funciona no computador.' }, status: 'idle', addresses: [] },
    expoError: null, state: { sessions: [] }, busy: null, run: async () => false, refresh: async () => {}
  } }))
  assert.match(html, /Electron/u)
  assert.doesNotMatch(html, /aria-label="(?:Iniciar Expo Go|iPhone físico com Expo Go|Android com Expo Go)"/u)
  assert.match(html, /Verificar projeto/u)
})

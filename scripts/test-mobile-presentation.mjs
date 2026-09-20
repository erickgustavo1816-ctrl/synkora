import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: ['src/main/mobilePresentation.ts'], bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { MobilePresentationManager } = loaded.exports
const okay = value => ({ ok: true, value })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

function fixture() {
  const effects = [], windows = new Map(), packets = []
  const scope = { projectId: 'project-a', rootPath: '/synthetic/a' }
  let currentScope = scope, closeGate, captureGate, actionGate, windowGate
  const sessions = ['android', 'ios'].map(platform => ({ id: `session-${platform}`, missionId: 'mission-a', platform,
    deviceId: `device-${platform}`, deviceName: platform, state: 'ready', inputAvailable: true }))
  const dock = { kind: 'dock', sender: {}, frame: {}, current: () => true, visible: () => true,
    send: (channel, payload) => packets.push(['dock', channel, payload]) }
  const manager = new MobilePresentationManager({
    resolveScope: missionId => missionId === 'mission-a' ? currentScope : null,
    inspect: async () => okay({ hostPlatform: 'darwin', platforms: [], devices: [], sessions: sessions.map(session => ({ ...session })) }),
    snapshot: (missionId, sessionId) => {
      const session = sessions.find(value => value.missionId === missionId && value.id === sessionId)
      return session ? okay({ ...session }) : { ok: false, error: 'missing' }
    },
    video: { closeSession: async (...args) => { effects.push(['closeVideo', ...args]); if (closeGate) await closeGate.promise },
      setVisible: async (...args) => { effects.push(['visible', ...args]); return okay() },
      acknowledge: (...args) => effects.push(['ack', ...args]) },
    capture: async (...args) => { effects.push(['capture', ...args]); if (captureGate) await captureGate.promise; return okay({ data: 'synthetic' }) },
    act: async (missionId, sessionId, action, signal) => { if (actionGate) await actionGate.promise;
      if (signal?.aborted) return { ok: false, error: 'cancelled' }; effects.push(['act', missionId, sessionId, action]); return okay() },
    pointer: async (...args) => { effects.push(['pointer', ...args]); return okay() },
    createWindow: binding => {
      const win = { binding, ready: windowGate?.promise ?? Promise.resolve(), alive: true, minimized: false, focus() { effects.push(['focus', binding.windowId]) },
        destroy() { this.alive = false; effects.push(['destroy', binding.windowId]) },
        resize(size) { return { ...size, clamped: false } } }
      win.surface = { kind: 'phone', windowId: binding.windowId, sender: {}, frame: {},
        current: () => win.alive, visible: () => !win.minimized,
        send: (channel, payload) => packets.push([binding.windowId, channel, payload]) }
      windows.set(binding.windowId, win); return win
    },
    onChanged: missionId => effects.push(['changed', missionId])
  })
  return { manager, dock, effects, windows, packets, sessions, setScope: value => { currentScope = value },
    holdClose: () => (closeGate = deferred()), holdCapture: () => (captureGate = deferred()), holdAction: () => (actionGate = deferred()),
    holdWindow: () => (windowGate = deferred()) }
}

test('handover invalidates the old consumer before cleanup and waits before the detached claim', async () => {
  const f = fixture(), m = 'mission-a', s = 'session-android'
  const first = await f.manager.acquireView(f.dock, m, s)
  assert.equal(first.ok, true)
  await f.manager.setVideoVisible(f.dock, m, s, true, first.value.consumerId)
  const gate = f.holdClose(), moving = f.manager.detach(m, s)
  await tick()
  assert.equal((await f.manager.setVideoVisible(f.dock, m, s, false, first.value.consumerId)).ok, false)
  f.manager.acknowledge(f.dock, m, s, 'old-stream', 1, first.value.consumerId)
  assert.equal(f.effects.some(effect => effect[0] === 'ack'), false)
  assert.equal(f.windows.size, 0)
  gate.resolve()
  const detached = await moving
  assert.equal(detached.ok, true)
  const win = f.windows.get(detached.value.windowId), claim = await f.manager.acquireView(win.surface, m, s)
  assert.equal(claim.ok, true)
  assert.notEqual(claim.value.consumerId, first.value.consumerId)
  await f.manager.setVideoVisible(win.surface, m, s, true, claim.value.consumerId)
  f.manager.emit({ missionId: m, sessionId: s, streamId: 'new', timestampUs: 2, key: true, codec: 'avc1', data: new Uint8Array([1]) })
  assert.equal(f.packets.at(-1)[0], win.binding.windowId)
  assert.equal(f.packets.at(-1)[2].consumerId, claim.value.consumerId)
  assert.equal((await f.manager.acquireView(f.dock, m, s)).ok, false)
})

test('detach uses the current profile and refuses a cached ready snapshot after stopping begins', async () => {
  const f = fixture(), m = 'mission-a', s = 'session-android'
  await f.manager.acquireView(f.dock, m, s)
  f.sessions[0].displayProfileId = 'galaxy-s24-ultra'
  assert.equal((await f.manager.detach(m, s)).value.session.displayProfileId, 'galaxy-s24-ultra')
  await f.manager.dock(m, s)
  f.sessions[0].state = 'stopping'
  assert.equal((await f.manager.detach(m, s)).ok, false)
})

test('late release, hide, ACK and input cannot affect a redocked replacement consumer', async () => {
  const f = fixture(), m = 'mission-a', s = 'session-android'
  const old = (await f.manager.acquireView(f.dock, m, s)).value.consumerId
  await f.manager.detach(m, s); await f.manager.dock(m, s)
  const current = (await f.manager.acquireView(f.dock, m, s)).value.consumerId
  const before = f.effects.length
  assert.equal((await f.manager.releaseView(f.dock, m, s, old)).ok, false)
  assert.equal((await f.manager.setVideoVisible(f.dock, m, s, false, old)).ok, false)
  assert.equal((await f.manager.act(f.dock, m, s, { type: 'tap', x: 0, y: 0 }, old)).ok, false)
  f.manager.acknowledge(f.dock, m, s, 'stream', 1, old)
  assert.equal(f.effects.length, before)
  assert.equal((await f.manager.act(f.dock, m, s, { type: 'key', key: 'home' }, current)).ok, true)
})

test('Android and iOS detach independently and minimizing one cannot hide the other', async () => {
  const f = fixture(), m = 'mission-a'
  const a = await f.manager.detach(m, 'session-android'), b = await f.manager.detach(m, 'session-ios')
  assert.equal(a.ok && b.ok, true); assert.notEqual(a.value.windowId, b.value.windowId)
  const wa = f.windows.get(a.value.windowId), wb = f.windows.get(b.value.windowId)
  const ca = (await f.manager.acquireView(wa.surface, m, 'session-android')).value.consumerId
  const cb = (await f.manager.acquireView(wb.surface, m, 'session-ios')).value.consumerId
  await f.manager.setVideoVisible(wa.surface, m, 'session-android', true, ca)
  await f.manager.setVideoVisible(wb.surface, m, 'session-ios', true, cb)
  wa.minimized = true; await f.manager.visibilityChanged(a.value.windowId)
  assert.deepEqual(f.effects.filter(effect => effect[0] === 'closeVideo').at(-1), ['closeVideo', m, 'session-android'])
  assert.equal((await f.manager.act(wa.surface, m, 'session-ios', { type: 'key', key: 'home' }, cb)).ok, false)
  wa.minimized = false; await f.manager.visibilityChanged(a.value.windowId)
  assert.deepEqual(f.effects.filter(effect => effect[0] === 'visible').at(-1), ['visible', m, 'session-android', true])
})

test('handover cancels pending gestures and queued actions; stale captures never return pixels', async () => {
  const f = fixture(), m = 'mission-a', s = 'session-android'
  const token = (await f.manager.acquireView(f.dock, m, s)).value.consumerId
  await f.manager.pointer(f.dock, m, s, { phase: 'down', gestureId: 'gesture-a', x: 0.2, y: 0.3 }, token)
  const actionGate = f.holdAction(), captureGate = f.holdCapture()
  const action = f.manager.act(f.dock, m, s, { type: 'text', text: 'synthetic' }, token)
  const capture = f.manager.capture(f.dock, m, s, token)
  await f.manager.detach(m, s)
  assert.equal(f.effects.some(effect => effect[0] === 'pointer' && effect[3].phase === 'cancel'), true)
  actionGate.resolve(); captureGate.resolve()
  assert.equal((await action).ok, false); assert.equal((await capture).ok, false)
  assert.equal(f.effects.some(effect => effect[0] === 'act'), false)
})

test('project/root changes and mission disposal revoke claims before asynchronous cleanup', async () => {
  const f = fixture(), m = 'mission-a', s = 'session-android'
  const detached = await f.manager.detach(m, s), win = f.windows.get(detached.value.windowId)
  const token = (await f.manager.acquireView(win.surface, m, s)).value.consumerId
  f.setScope({ projectId: 'project-a', rootPath: '/synthetic/replaced' })
  assert.equal((await f.manager.capture(win.surface, m, s, token)).ok, false)
  assert.equal(f.effects.some(effect => effect[0] === 'capture'), false)
  const gate = f.holdClose(), closed = f.manager.closeMission(m)
  assert.equal(win.alive, false)
  assert.equal((await f.manager.acquireView(win.surface, m, s)).ok, false)
  gate.resolve(); await closed
})

test('mission cleanup destroys a window synchronously while its renderer is still loading', async () => {
  const f = fixture(), gate = f.holdWindow(), opening = f.manager.detach('mission-a', 'session-android')
  await tick()
  const win = [...f.windows.values()][0]
  assert.ok(win)
  let closed = false
  const closing = f.manager.closeMission('mission-a').then(() => { closed = true })
  assert.equal(win.alive, false)
  await tick(); assert.equal(closed, false)
  gate.resolve(); await closing
  assert.equal((await opening).ok, false)
})

test('minimization aborts queued visual actions even if the same consumer is restored', async () => {
  const f = fixture(), m = 'mission-a', s = 'session-android'
  const detached = await f.manager.detach(m, s), win = f.windows.get(detached.value.windowId)
  const token = (await f.manager.acquireView(win.surface, m, s)).value.consumerId
  const gate = f.holdAction(), action = f.manager.act(win.surface, m, s, { type: 'text', text: 'synthetic' }, token)
  win.minimized = true; await f.manager.visibilityChanged(detached.value.windowId)
  win.minimized = false; await f.manager.visibilityChanged(detached.value.windowId)
  gate.resolve()
  assert.equal((await action).ok, false)
  assert.equal(f.effects.some(effect => effect[0] === 'act'), false)
})

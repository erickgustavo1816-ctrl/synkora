import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
const built = buildSync({ entryPoints: ['src/main/ipc/mobile.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] })
function fixture() {
  const handlers = new Map(), events = new Map(), effects = [], loaded = { exports: {} }, nativeRequire = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'electron' ? {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => events.set(name, handler) }
  } : nativeRequire(name), loaded, loaded.exports)
  const call = name => async (...args) => { effects.push([name, ...args]); return { ok: true, value: undefined } }
  const binding = { windowId: 'window-a', missionId: 'mission-a', sessionId: 'session-a', projectId: 'project-a', platform: 'android' }
  const surface = { kind: 'phone', sender: {}, frame: {}, current: () => true, visible: () => true, send() {} }
  const presentation = Object.fromEntries(['describe', 'acquireView', 'releaseView', 'capture', 'act', 'pointer', 'setVideoVisible', 'dockWindow', 'resize', 'detach', 'focusDetached', 'dock'].map(name => [name, call(name)]))
  presentation.acknowledge = (...args) => effects.push(['ack', ...args]); presentation.decorate = value => value
  loaded.exports.registerMobileIpc({ assertOwnerSender: event => { if (event !== 'owner') throw new Error('foreign') },
    ownerSurface: () => surface, resolvePhone: event => { if (event !== 'phone') throw new Error('foreign'); return { binding, surface } },
    runtime: Object.fromEntries(['inspect', 'start', 'stop', 'capture', 'act', 'pointer'].map(name => [name, call(`runtime-${name}`)])),
    expo: Object.fromEntries(['inspect', 'start', 'stop', 'openAndroid', 'installGo'].map(name => [name, call(`expo-${name}`)])),
    presentation, monitorScale: call('monitor') })
  return { handlers, events, effects, surface }
}
test('restricted phone channels use only the main binding and refuse supplied authority', async () => {
  const f = fixture()
  assert.ok(f.handlers.has('mobile:phone:describe'))
  const result = await f.handlers.get('mobile:phone:pointer')('phone', { phase: 'down', gestureId: 'gesture', x: 0.5, y: 0.5 }, 'consumer-a')
  assert.equal(result.ok, true)
  assert.deepEqual(f.effects.at(-1).slice(0, 4), ['pointer', f.surface, 'mission-a', 'session-a'])
  const before = f.effects.length
  for (const args of [[], ['mission-other', 'session-other'], [{ missionId: 'mission-other' }]]) {
    assert.equal((await f.handlers.get('mobile:phone:describe')('phone', ...args)).ok, args.length === 0)
  }
  assert.equal(f.effects.length, before + 1)
  assert.equal((await f.handlers.get('mobile:phone:act')('phone', { type: 'install', relativePath: 'demo.apk' }, 'consumer-a')).ok, false)
  assert.equal((await f.handlers.get('mobile:phone:act')('phone', { type: 'displayProfile', profileId: 'pixel-7' }, 'consumer-a')).ok, false)
  assert.equal((await f.handlers.get('mobile:phone:capture')('phone', 'consumer-a', 'session-other')).ok, false)
})
test('phone sender cannot invoke broad owner channels and foreign/main senders cannot invoke phone channels', async () => {
  const f = fixture()
  for (const [name, handler] of f.handlers) {
    const result = await handler(name.startsWith('mobile:phone:') ? 'owner' : 'phone')
    assert.equal(result.ok, false, name)
  }
  assert.equal(f.effects.length, 0)
  f.events.get('mobile:phone:videoAck')('owner', 'stream-a', 1, 'consumer-a')
  assert.equal(f.effects.length, 0)
})
test('phone geometry and ACK validate strict bounded schemas before effects', async () => {
  const f = fixture(), resize = f.handlers.get('mobile:phone:resize')
  for (const size of [{ width: 99, height: 200 }, { width: NaN, height: 200 }, { width: 200, height: 8193 },
    { width: 200, height: 300, x: 10 }, { width: 200.5, height: 300 }]) assert.equal((await resize('phone', size)).ok, false)
  assert.equal((await resize('phone', { width: 100, height: 8192 })).ok, true)
  f.events.get('mobile:phone:videoAck')('phone', 'stream-a', 1, 'consumer-a')
  assert.deepEqual(f.effects.at(-1), ['ack', f.surface, 'mission-a', 'session-a', 'stream-a', 1, 'consumer-a'])
})

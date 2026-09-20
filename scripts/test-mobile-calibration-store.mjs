// The "Tamanho real" calibration is ONE app record: the panel writes it, a
// detached phone window reads the same value through its restricted bridge,
// and it survives a restart because it lives in userData, not in a window.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'

const nativeRequire = createRequire(import.meta.url)
const load = entry => {
  const built = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'] })
  const loaded = { exports: {}, handlers: new Map() }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'electron'
    ? { ipcMain: { handle: (channel, callback) => loaded.handlers.set(channel, callback), on() {} } } : nativeRequire(name), loaded, loaded.exports)
  return loaded
}
const key = 'synkora.mobile.calibration.v3:1920:1080:0:0:1:1:1:0:0:1920:1080:1'

test('the store validates keys and scales, persists atomically and reloads after a restart', async () => {
  const { MobileCalibrationStore } = load('src/main/mobileCalibrationStore.ts').exports
  const file = join(await mkdtemp(join(tmpdir(), 'synkora-calibration-')), 'mobile-calibration.json')
  const store = new MobileCalibrationStore(file)
  let changes = 0
  store.onChange(() => changes++)
  assert.equal(store.read(key), null)
  assert.equal(store.write(key, 3.6), true)
  assert.equal(store.read(key), 3.6); assert.equal(changes, 1)
  for (const [badKey, value] of [['localStorage-key', 3.6], [key, 0.1], [key, 21], [key, NaN], [key, '3.6'], [`${key}:${'x'.repeat(300)}`, 3.6]])
    assert.equal(store.write(badKey, value), false, `${badKey} / ${value}`)
  assert.equal(changes, 1)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, entries: { [key]: 3.6 } })
  const restarted = new MobileCalibrationStore(file)
  assert.equal(restarted.read(key), 3.6, 'the record outlives the process that wrote it')
  assert.equal(restarted.write(key, null), true)
  assert.equal(restarted.read(key), null)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, entries: {} })
  assert.equal(new MobileCalibrationStore().write(key, 4), true, 'a memory-only store still serves tests and previews')
})

test('the panel writes the record and a detached phone reads the very same value over its restricted channel', async () => {
  const ipc = load('src/main/ipc/mobile.ts')
  const { MobileCalibrationStore } = load('src/main/mobileCalibrationStore.ts').exports
  const calibration = new MobileCalibrationStore()
  const okay = async () => ({ ok: true, value: undefined })
  const surface = { kind: 'phone', sender: {}, frame: {}, current: () => true, visible: () => true, send() {} }
  ipc.exports.registerMobileIpc({
    assertOwnerSender: event => { if (event !== 'owner') throw new Error('foreign') },
    ownerSurface: () => surface,
    resolvePhone: event => { if (event !== 'phone') throw new Error('foreign'); return { binding: { windowId: 'w', missionId: 'm', sessionId: 's', projectId: 'p', platform: 'android' }, surface } },
    runtime: Object.fromEntries(['inspect', 'start', 'stop', 'capture', 'act', 'pointer'].map(name => [name, okay])),
    expo: Object.fromEntries(['inspect', 'start', 'stop', 'openAndroid', 'installGo'].map(name => [name, okay])),
    presentation: { decorate: value => value, acknowledge() {} }, calibration })
  const h = ipc.handlers
  assert.deepEqual(await h.get('mobile:calibrationRead')('owner', key), { ok: true, value: null })
  assert.deepEqual(await h.get('mobile:calibrationWrite')('owner', key, 3.6), { ok: true, value: true })
  assert.deepEqual(await h.get('mobile:phone:calibrationRead')('phone', key), { ok: true, value: 3.6 }, 'the detached window sees the panel value')
  assert.deepEqual(await h.get('mobile:phone:calibrationWrite')('phone', key, 4.2), { ok: true, value: true })
  assert.deepEqual(await h.get('mobile:calibrationRead')('owner', key), { ok: true, value: 4.2 }, 'the panel sees the detached correction')
  assert.deepEqual(await h.get('mobile:phone:calibrationWrite')('phone', key, null), { ok: true, value: true })
  assert.deepEqual(await h.get('mobile:calibrationRead')('owner', key), { ok: true, value: null })
  for (const args of [['not-a-calibration-key', 3.6], [key, 0.2], [key, 'x'], [key]]) assert.equal((await h.get('mobile:calibrationWrite')('owner', ...args)).ok, false, JSON.stringify(args))
  assert.equal((await h.get('mobile:calibrationRead')('phone', key)).ok, false, 'a phone cannot use the owner channel')
  assert.equal((await h.get('mobile:phone:calibrationRead')('owner', key)).ok, false, 'the owner cannot use the phone channel')
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { APP_UPDATE_FEED, createAppUpdateController, startAppUpdater } from '../.tmp/app-update-test/main/appUpdate.js'

const require = createRequire(import.meta.url)
const NOT_READY = 'nenhuma atualização pronta para instalar'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = true
  feeds = []
  checks = 0
  downloads = 0
  installs = []
  checkResult = null
  checkError = null
  downloadError = null
  setFeedURL(feed) { this.feeds.push(feed) }
  async checkForUpdates() {
    this.checks++
    this.emit('checking-for-update')
    if (this.checkError) throw this.checkError
    return this.checkResult
  }
  async downloadUpdate() {
    this.downloads++
    if (this.downloadError) throw this.downloadError
    return ['synthetic-installer.exe']
  }
  quitAndInstall(...args) { this.installs.push(args) }
}

function fixture(packaged = true) {
  const updater = new FakeUpdater()
  let now = 1_000
  let nextTimer = 0
  const timers = new Map(), recorded = []
  const controller = createAppUpdateController({
    updater, packaged, version: '1.0.0', now: () => now,
    record: event => recorded.push(event),
    setTimer: (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer: id => timers.delete(id)
  })
  return {
    controller, updater, timers, recorded,
    clock(value) { now = value },
    async tick() {
      assert.equal(timers.size, 1)
      const [id, { callback, delay }] = timers.entries().next().value
      timers.delete(id)
      now += delay
      callback()
      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

test('unpackaged app reports unsupported and never configures, checks or downloads', async () => {
  const { controller, updater, timers } = fixture(false)
  controller.start()
  assert.deepEqual(await controller.check(), {
    phase: 'unsupported', version: '1.0.0',
    reason: 'atualização automática só existe no Synkora instalado'
  })
  await controller.download()
  assert.equal(updater.checks, 0)
  assert.equal(updater.downloads, 0)
  assert.deepEqual(updater.feeds, [])
  assert.equal(timers.size, 0)
  controller.stop()
})

test('happy path pushes phases in order and silently installs then relaunches', async () => {
  const { controller, updater, recorded, clock } = fixture()
  const seen = []
  controller.onStatus(status => seen.push(status))
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.equal(updater.allowPrerelease, false)
  assert.deepEqual(updater.feeds, [APP_UPDATE_FEED])
  assert.deepEqual(APP_UPDATE_FEED, {
    provider: 'github', owner: 'erickgustavo1816-ctrl', repo: 'synkora-releases'
  })
  await controller.check()
  clock(2_000)
  updater.emit('update-available', { version: '1.1.0', releaseNotes: 'Correções.' })
  updater.emit('download-progress', { percent: 42.5, transferred: 425, total: 1_000, bytesPerSecond: 10 })
  updater.emit('update-downloaded', { version: '1.1.0', releaseNotes: 'Correções.' })
  assert.deepEqual(seen.map(status => status.phase), ['checking', 'available', 'downloading', 'ready'])
  assert.equal(seen[2].percent, 42.5)
  assert.equal(seen[2].transferred, 425)
  assert.equal(seen[2].total, 1_000)
  assert.equal(seen[2].bytesPerSecond, 10)
  assert.equal(controller.status().checkedAt, 2_000)
  assert.equal(controller.status().next, '1.1.0')
  assert.equal(controller.status().notes, 'Correções.')
  assert.equal(updater.downloads, 0, 'electron-updater owns the automatic download')
  assert.deepEqual(controller.install(), { ok: true })
  assert.deepEqual(updater.installs, [[true, true]])
  assert.deepEqual(recorded.map(event => event.detail.phase), ['idle', 'checking', 'available', 'downloading', 'ready'])
  assert.ok(recorded.every(event => event.cat === 'app' && event.event === 'app-update'))
})

test('updater errors map network failures and missing releases to PT-BR', async () => {
  for (const [error, expected] of [
    [new Error('getaddrinfo ENOTFOUND releases.invalid'), 'sem conexão para verificar atualizações'],
    [Object.assign(new Error('request failed'), { code: 'ECONNRESET' }), 'sem conexão para verificar atualizações'],
    [new Error('HttpError: 404 Not Found'), 'nenhuma versão publicada ainda'],
    [Object.assign(new Error('empty feed'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }), 'nenhuma versão publicada ainda'],
    [new Error('  falha sintética  '), 'falha sintética']
  ]) {
    const { controller, updater } = fixture()
    updater.checkError = error
    assert.equal((await controller.check()).error, expected)
    assert.equal(controller.status().phase, 'error')
    assert.equal(controller.status().checkedAt, 1_000)
  }
})

test('download errors retain checkedAt and duplicate error events do not notify twice', async () => {
  const { controller, updater, clock } = fixture()
  await controller.check()
  updater.emit('update-available', { version: '1.1.0' })
  clock(5_000)
  updater.downloadError = new Error('ENOTFOUND synthetic host')
  const seen = []
  controller.onStatus(status => seen.push(status))
  await controller.download()
  updater.emit('error', updater.downloadError)
  assert.equal(controller.status().checkedAt, 1_000)
  assert.equal(controller.status().error, 'sem conexão para verificar atualizações')
  assert.equal(seen.filter(status => status.phase === 'error').length, 1)
})

test('check is rate limited for 30 seconds including clock starting at zero', async () => {
  const { controller, updater, clock } = fixture()
  clock(0)
  await controller.check()
  updater.emit('update-not-available', { version: '1.0.0' })
  clock(29_999)
  assert.equal((await controller.check()).phase, 'current')
  assert.equal(updater.checks, 1)
  clock(30_000)
  await controller.check()
  assert.equal(updater.checks, 2)
})

test('install refuses before ready; recipe: check, wait for automatic download, then install', async () => {
  const { controller, updater } = fixture()
  assert.deepEqual(controller.install(), { ok: false, error: NOT_READY })
  assert.deepEqual(updater.installs, [])
  await controller.check()
  updater.emit('update-available', { version: '1.1.0' })
  assert.deepEqual(controller.install(), { ok: false, error: NOT_READY })
  assert.deepEqual(updater.installs, [])
})

test('manual download only runs while available and repeat clicks are ignored', async () => {
  const { controller, updater } = fixture()
  assert.equal((await controller.download()).phase, 'idle')
  assert.equal(updater.downloads, 0)
  updater.emit('update-available', { version: '1.1.0' })
  await Promise.all([controller.download(), controller.download()])
  assert.equal(updater.downloads, 1)
  assert.equal(controller.status().phase, 'downloading')
})

test('first scheduled check waits 15 seconds, repeats every 6 hours, and stop clears it', async () => {
  const { controller, updater, timers, tick } = fixture()
  controller.start()
  controller.start()
  assert.equal(timers.size, 1)
  assert.equal(timers.values().next().value.delay, 15_000)
  assert.equal(updater.checks, 0)
  await tick()
  updater.emit('update-not-available', { version: '1.0.0' })
  assert.equal(updater.checks, 1)
  assert.equal(timers.values().next().value.delay, 6 * 60 * 60 * 1_000)
  await tick()
  assert.equal(updater.checks, 2)
  controller.stop()
  assert.equal(timers.size, 0)
  assert.equal(updater.listenerCount('download-progress'), 0)
})

test('release notes accept HTML/Markdown strings or arrays as bounded plain text', () => {
  const { controller, updater } = fixture()
  updater.emit('update-available', {
    version: '1.1.0', releaseNotes: '<h2>Novidades</h2><p>Mais &amp; melhor</p>\n- **Corrigido** [item](https://example.invalid)'
  })
  const notes = controller.status().notes
  assert.match(notes, /Novidades/u)
  assert.match(notes, /Mais & melhor/u)
  assert.match(notes, /Corrigido item/u)
  assert.doesNotMatch(notes, /<\/?\w|\*\*|https:\/\//u)
  updater.emit('update-available', {
    version: '1.2.0', releaseNotes: [{ version: '1.1.0', note: '<p>Primeira</p>' }, { version: '1.2.0', note: 'Segunda' }]
  })
  assert.match(controller.status().notes, /Primeira\s+Segunda/u)
  updater.emit('update-available', { version: '1.3.0', releaseNotes: 'x'.repeat(5_000) })
  assert.equal(controller.status().notes.length, 4_000)
})

test('progress is bounded, snapshots cannot mutate controller, and unsubscribe works', () => {
  const { controller, updater, recorded } = fixture()
  const seen = []
  const off = controller.onStatus(status => seen.push(status))
  updater.emit('update-available', { version: '1.1.0' })
  updater.emit('download-progress', { percent: 110, transferred: 20, total: 10, bytesPerSecond: 3 })
  updater.emit('download-progress', { percent: -1, transferred: 0, total: 10, bytesPerSecond: 3 })
  assert.equal(seen[1].percent, 100)
  assert.equal(seen[2].percent, 0)
  assert.equal(recorded.filter(event => event.detail.phase === 'downloading').length, 1)
  controller.status().phase = 'ready'
  assert.equal(controller.status().phase, 'downloading')
  off()
  updater.emit('update-downloaded', { version: '1.1.0' })
  assert.equal(seen.length, 3)
})

test('checks cannot replace an in-flight download or an update ready to install', async () => {
  const { controller, updater, clock } = fixture()
  updater.emit('update-available', { version: '1.1.0' })
  updater.emit('download-progress', { percent: 20, transferred: 2, total: 10, bytesPerSecond: 3 })
  clock(100_000)
  assert.equal((await controller.check()).phase, 'downloading')
  updater.emit('update-downloaded', { version: '1.1.0' })
  clock(200_000)
  assert.equal((await controller.check()).phase, 'ready')
  assert.equal(updater.checks, 0)
})

test('automatic download rejection is observed without an unhandled rejection', async () => {
  const { controller, updater } = fixture()
  let reject
  updater.checkResult = { downloadPromise: new Promise((_, fail) => { reject = fail }) }
  await controller.check()
  updater.emit('update-available', { version: '1.1.0' })
  reject(new Error('ENOTFOUND synthetic host'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.status().phase, 'error')
  assert.equal(controller.status().error, 'sem conexão para verificar atualizações')
})

test('development wrapper never imports Electron/electron-updater or schedules a check', async () => {
  const lifecycle = new EventEmitter()
  const app = Object.assign(lifecycle, { isPackaged: false, getVersion: () => '1.0.0', quit() {} })
  const controller = startAppUpdater({ app, blackbox: { record() {} } })
  assert.equal((await controller.check()).phase, 'unsupported')
  assert.equal(require.cache[require.resolve('electron-updater')], undefined)
  assert.equal(require.cache[require.resolve('electron')], undefined)
  lifecycle.emit('quit')
})

test('a slow check is never duplicated, even after the manual throttle expires', async () => {
  const { controller, updater, clock } = fixture()
  let finish
  updater.checkResult = new Promise(resolve => { finish = resolve })
  const first = controller.check()
  clock(100_000)
  assert.equal((await controller.check()).phase, 'checking')
  assert.equal(updater.checks, 1)
  updater.emit('update-not-available', { version: '1.0.0' })
  finish(null)
  await first
  assert.equal(controller.status().checkedAt, 100_000)
})

test('stopping from a status listener does not leave a scheduled check behind', async () => {
  const { controller, updater, timers, tick } = fixture()
  controller.onStatus(() => controller.stop())
  controller.start()
  await tick()
  assert.equal(timers.size, 0)
  const checks = updater.checks
  await controller.check()
  assert.equal(updater.checks, checks)
})

test('repeat install clicks are idempotent and synchronous install errors are reported', () => {
  const { controller, updater } = fixture()
  updater.emit('update-downloaded', { version: '1.1.0' })
  assert.equal(controller.install().ok, true)
  assert.equal(controller.install().ok, true)
  assert.equal(updater.installs.length, 1)
  const failed = fixture()
  failed.updater.emit('update-downloaded', { version: '1.1.0' })
  failed.updater.quitAndInstall = () => { failed.updater.emit('error', new Error('falha sintética')) }
  assert.deepEqual(failed.controller.install(), { ok: false, error: 'falha sintética' })
})

function loadWithElectronStub(file, electron, globals = {}) {
  const { code } = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'window', 'process', code)(name => {
    assert.equal(name, 'electron', 'the IPC/preload module must only load its Electron bridge')
    return electron
  }, loaded, loaded.exports, globals.window, globals.process)
  return loaded.exports
}

test('all updater IPC calls enforce the main renderer guard before reaching the controller', async () => {
  const handlers = new Map(), calls = []
  const { registerAppUpdateIpc } = loadWithElectronStub('src/main/ipc/appUpdate.ts', {
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) }
  })
  const controller = { onStatus() {} }
  for (const method of ['status', 'check', 'download', 'install']) {
    controller[method] = () => { calls.push(method); return method }
  }
  registerAppUpdateIpc({ pushBoard() {} }, {
    controller,
    assertMainRendererSender(event) { if (event !== 'main') throw new Error('foreign renderer') }
  })
  assert.equal(handlers.size, 4)
  for (const method of ['status', 'check', 'download', 'install']) {
    const handler = handlers.get(`app-update:${method}`)
    assert.throws(() => handler('foreign'), /foreign renderer/u)
    assert.deepEqual(calls, [])
    assert.equal(await handler('main'), method)
    assert.deepEqual(calls.splice(0), [method])
  }
})

test('IPC forwards every controller status through the main window push route', async () => {
  const { controller, updater } = fixture()
  const sent = []
  const { registerAppUpdateIpc } = loadWithElectronStub('src/main/ipc/appUpdate.ts', {
    ipcMain: { handle() {} }
  })
  registerAppUpdateIpc({ pushBoard: (...args) => sent.push(args) }, { controller, assertMainRendererSender() {} })
  await controller.check()
  updater.emit('update-available', { version: '1.1.0' })
  updater.emit('download-progress', { percent: 30, transferred: 3, total: 10, bytesPerSecond: 5 })
  updater.emit('update-downloaded', { version: '1.1.0' })
  assert.deepEqual(sent.map(([channel]) => channel), Array(4).fill('app-update:status'))
  assert.deepEqual(sent.map(([, status]) => status.phase), ['checking', 'available', 'downloading', 'ready'])
})

test('preload exposes the exact updater channels and removes only its own subscription', async () => {
  let exposed
  const calls = [], emitter = new EventEmitter()
  loadWithElectronStub('src/preload/index.ts', {
    contextBridge: { exposeInMainWorld: (name, api) => { if (name === 'synkora') exposed = api } },
    ipcRenderer: Object.assign(emitter, { invoke: async channel => { calls.push(channel); return channel }, send() {} }),
    webUtils: {}
  }, { window: { addEventListener() {} }, process: { argv: [] } })
  assert.deepEqual(Object.keys(exposed.appUpdate), ['status', 'check', 'download', 'install', 'onStatus'])
  for (const method of ['status', 'check', 'download', 'install']) {
    assert.equal(await exposed.appUpdate[method](), `app-update:${method}`)
  }
  assert.deepEqual(calls, ['app-update:status', 'app-update:check', 'app-update:download', 'app-update:install'])
  const seen = [], retained = []
  const off = exposed.appUpdate.onStatus(status => seen.push(status))
  exposed.appUpdate.onStatus(status => retained.push(status))
  const status = { phase: 'ready', version: '1.0.0', next: '1.1.0' }
  emitter.emit('app-update:status', { sender: 'private' }, status)
  assert.deepEqual(seen, [status], 'the Electron event must not cross the bridge')
  off()
  emitter.emit('app-update:status', {}, status)
  assert.deepEqual(seen, [status])
  assert.deepEqual(retained, [status, status])
})

test('packaging feed matches runtime and local dist commands explicitly disable publication', () => {
  const { load } = require('js-yaml')
  const config = load(readFileSync('electron-builder.yml', 'utf8'))
  const { releaseType, ...feed } = config.publish
  assert.deepEqual(feed, APP_UPDATE_FEED)
  assert.equal(releaseType, 'release')
  assert.ok(config.extraResources.some(entry => entry.from === 'build/skills' && entry.to === 'skills'))
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const script of ['dist', 'dist:dir']) assert.match(pkg.scripts[script], /--publish never(?:\s|$)/u)
  assert.match(pkg.scripts['test:gui-system'], /npm run test:app-update(?: &&|$)/u)
})

test('installed electron-builder skips a missing skills extraResources source with a warning', async () => {
  const { load } = require('js-yaml')
  const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher')
  const { log } = require('builder-util')
  const config = load(readFileSync('electron-builder.yml', 'utf8'))
  const root = resolve('.tmp', `app-update-resource-probe-${randomUUID()}`)
  assert.equal(existsSync(root), false)
  const matchers = getFileMatchers({ extraResources: config.extraResources.filter(entry => entry.from === 'build/skills') },
    'extraResources', resolve(root, 'resources'), {
      defaultSrc: root, globalOutDir: resolve(root, 'out'), customBuildOptions: {}, macroExpander: value => value
    })
  assert.equal(matchers.length, 1)
  assert.equal(matchers[0].from, resolve(root, 'build/skills'))
  const warnings = [], warn = log.warn
  log.warn = (...args) => warnings.push(args)
  try { await copyFiles(matchers) } finally { log.warn = warn }
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][1], "file source doesn't exist")
  assert.equal(existsSync(resolve(root, 'resources/skills')), false)
  assert.equal(existsSync(root), false, 'the missing source must not create output or touch build/skills')
})

function packagedWrapperFixture() {
  const updater = new FakeUpdater(), timers = new Set()
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getVersion: () => '1.0.0', exited: false, windowsClosed: false,
    quit() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      app.emit('before-quit', event)
      if (event.defaultPrevented) return
      app.windowsClosed = true
      app.emit('will-quit', event)
      if (event.defaultPrevented) return
      app.exited = true
      app.emit('quit', {}, 0)
    }
  })
  const { code } = transformSync(readFileSync('src/main/appUpdate.ts', 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', code)(name => {
    assert.equal(name, 'electron-updater')
    return { autoUpdater: updater }
  }, loaded, loaded.exports, () => {
    const timer = { unref() {} }
    timers.add(timer)
    return timer
  }, timer => timers.delete(timer))
  const controller = loaded.exports.startAppUpdater({ app, blackbox: { record() {} } })
  return { app, updater, controller, timers }
}

test('packaged install waits for before-quit cleanup before starting NSIS', () => {
  const { app, updater, controller, timers } = packagedWrapperFixture()
  let cleaned = false
  app.on('before-quit', event => { if (!cleaned) event.preventDefault() })
  updater.emit('update-downloaded', { version: '1.1.0' })
  assert.deepEqual(controller.install(), { ok: true })
  assert.deepEqual(updater.installs, [], 'NSIS must not start while the mobile quit guard still holds the app open')
  assert.equal(app.exited, false)
  cleaned = true
  app.quit()
  assert.deepEqual(updater.installs, [[true, true]])
  assert.equal(app.exited, true)
  assert.equal(timers.size, 0)
})

test('a synchronous installer failure preserves the window and reports the error', () => {
  const { app, updater, controller } = packagedWrapperFixture()
  updater.emit('update-downloaded', { version: '1.1.0' })
  updater.quitAndInstall = () => updater.emit('error', new Error('falha sintética ao iniciar instalador'))
  assert.deepEqual(controller.install(), { ok: false, error: 'falha sintética ao iniciar instalador' })
  assert.equal(app.exited, false)
  assert.equal(app.windowsClosed, false)
  assert.equal(controller.status().phase, 'error')
  controller.stop()
})

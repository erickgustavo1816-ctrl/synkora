import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, screen } from 'electron'
import { MobilePopoutWindows } from '../../../src/main/mobilePopoutWindow.ts'
import { MobilePresentationManager } from '../../../src/main/mobilePresentation.ts'
import { registerMobileIpc } from '../../../src/main/ipc/mobile.ts'
import { installMobileQuitGuard } from '../../../src/main/mobileIntegration.ts'

const directory = process.argv[2]
app.setName('Synkora Mobile Phone QA')
app.setPath('userData', join(directory, 'profile'))
app.setPath('sessionData', join(directory, 'session-data'))
app.setPath('logs', join(directory, 'logs'))
app.on('window-all-closed', () => {})
const deadline = setTimeout(() => { console.error('Synthetic phone fixture deadline exceeded'); app.exit(1) }, 30_000)

const native = new Map()
// Real BrowserWindow/WebContents/preload/IPC, but never a visible desktop surface.
// Logical visibility alone is controlled for delivery tests; OS show/minimize
// behavior and visual alpha composition are deliberately not claimed here.
app.on('browser-window-created', (_event, win) => {
  const state = { visible: false, minimized: false, isNativeVisible: win.isVisible.bind(win) }
  native.set(win, state)
  win.show = () => { state.visible = true; win.emit('show') }
  win.hide = () => { state.visible = false; win.emit('hide') }
  win.minimize = () => { state.minimized = true; win.emit('minimize') }
  win.restore = () => { state.minimized = false; win.emit('restore') }
  win.focus = () => {}
  win.isVisible = () => state.visible
  win.isMinimized = () => state.minimized
})

const ok = value => ({ ok: true, value })
const no = () => ({ ok: false, error: 'Synthetic session unavailable' })
const pause = ms => new Promise(done => setTimeout(done, ms))
async function until(predicate, message, timeout = 2500) {
  const end = Date.now() + timeout
  while (!predicate() && Date.now() < end) await pause(10)
  assert.ok(predicate(), message)
}
const execute = (win, source) => win.webContents.executeJavaScript(source)
const phoneCall = (win, method, ...args) => execute(win, `window.synkoraMobilePhone[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
const ownerCall = (win, method, ...args) => execute(win, `window.synkora.mobile[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
const actualEvent = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
const packet = (sessionId, timestampUs) => ({ missionId: 'phone-qa-mission', sessionId, streamId: `synthetic-${sessionId}`,
  timestampUs, codec: 'avc1.42c01e', key: true, data: new Uint8Array([0, 0, 0, 1, 9, 240]) })

async function run() {
  await app.whenReady()
  const checks = [], geometry = [], calls = { capture: [], act: [], pointer: [], stop: [], start: [], ack: [], visible: [], closed: [], monitor: [], dock: [] }
  const check = async (name, action) => {
    try { await action(); checks.push(name) }
    catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }) }
  }
  const missionId = 'phone-qa-mission', projectId = 'phone-qa-project'
  const sessions = new Map(['android', 'ios'].map(platform => [`phone-qa-${platform}`, {
    id: `phone-qa-${platform}`, missionId, platform, deviceId: `synthetic-${platform}`, deviceName: `Synthetic ${platform}`,
    state: 'ready', inputAvailable: true, liveInputAvailable: true
  }]))
  let missionActive = true, holdCleanup = false, releaseCleanup
  const cleanupBarrier = new Promise(done => { releaseCleanup = done })
  const state = () => ({ hostPlatform: process.platform, platforms: [], devices: [], sessions: [...sessions.values()] })
  const snapshot = (mission, session) => mission === missionId && sessions.has(session) ? ok(sessions.get(session)) : no()
  const video = {
    closeSession: async (mission, session) => { calls.closed.push([mission, session]); if (holdCleanup) await cleanupBarrier },
    setVisible: async (mission, session, visible) => { calls.visible.push([mission, session, visible]); return ok() },
    acknowledge: (...args) => calls.ack.push(args)
  }
  const runtime = {
    inspect: async mission => mission === missionId ? ok(state()) : no(),
    start: async (...args) => { calls.start.push(args); return no() },
    stop: async (...args) => { calls.stop.push(args); return ok() },
    capture: async (mission, session) => {
      calls.capture.push([mission, session]); return ok({ sessionId: session, mimeType: 'image/png', width: 1, height: 1,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ0EAAAAASUVORK5CYII=', capturedAt: 1 })
    },
    act: async (mission, session, action) => { calls.act.push([mission, session, action.type]); return ok() },
    pointer: async (mission, session, input) => { calls.pointer.push([mission, session, input.phase]); return ok() }
  }
  const ownerUrl = `${pathToFileURL(join(directory, 'fixture.html')).href}?view=phone-qa-owner`
  const owner = new BrowserWindow({ show: false, skipTaskbar: true, width: 1000, height: 800,
    webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      partition: 'mobile-phone-owner-qa' } })
  const rendererUrl = windowId => `${pathToFileURL(join(directory, 'fixture.html')).href}?view=mobile-phone&windowId=${windowId}`
  let presentation
  const windows = new MobilePopoutWindows({
    preloadFile: join(directory, 'preload.cjs'), rendererUrl, trustedUrl: (url, windowId) => url === rendererUrl(windowId),
    ownerBounds: () => owner.getBounds(), binding: id => presentation.binding(id),
    onDock: id => { calls.dock.push(id); void presentation.dockWindow(id) },
    onVisibility: id => { void presentation.visibilityChanged(id) }, onInvalidated: sender => presentation.invalidateSurface(sender)
  })
  presentation = new MobilePresentationManager({
    resolveScope: mission => missionActive && mission === missionId ? { projectId, rootPath: join(directory, 'synthetic-project') } : null,
    snapshot, video, capture: runtime.capture, act: runtime.act, pointer: runtime.pointer,
    createWindow: binding => windows.create(binding), onChanged: mission => { if (!owner.isDestroyed()) owner.webContents.send('mobile:changed', mission) }
  })
  const assertOwnerSender = event => {
    if (owner.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame || event.senderFrame.url !== ownerUrl) throw new Error('Synthetic foreign owner sender')
  }
  registerMobileIpc({ runtime, expo: Object.fromEntries(['inspect', 'start', 'stop', 'openAndroid', 'installGo'].map(method => [method, async () => { throw new Error(`Unexpected synthetic Expo ${method}`) }])),
    presentation, assertOwnerSender, resolvePhone: event => windows.resolve(event),
    ownerSurface: event => {
      assertOwnerSender(event)
      return { kind: 'dock', sender: event.sender, frame: event.senderFrame,
        current: () => { try { assertOwnerSender(event); return true } catch { return false } },
        visible: () => owner.isVisible(), send: (channel, value) => event.sender.send(channel, value) }
    },
    monitorScale: async event => { calls.monitor.push(event.sender.id); return null }
  })
  await owner.loadURL(ownerUrl)
  owner.show()
  const phones = []
  const openPhone = async platform => {
    const result = await ownerCall(owner, 'detach', missionId, `phone-qa-${platform}`)
    assert.equal(result.ok, true, JSON.stringify(result))
    const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === rendererUrl(result.value.windowId))
    assert.ok(win)
    const phone = { win, descriptor: result.value, token: '' }
    phones.push(phone)
    return phone
  }
  const android = await openPhone('android'), ios = await openPhone('ios')

  await check('two independent native windows expose only the production restricted bridge', async () => {
    assert.notEqual(android.win, ios.win)
    assert.notEqual(android.descriptor.windowId, ios.descriptor.windowId)
    const expected = ['acquireView', 'ackVideo', 'act', 'calibrationRead', 'calibrationWrite', 'capture', 'describe', 'dock', 'monitorScale', 'onCalibrationChanged', 'onChanged', 'onVideo', 'pointer', 'releaseView', 'resize', 'setVideoVisible'].sort()
    for (const phone of [android, ios]) {
      assert.equal(native.get(phone.win).isNativeVisible(), false)
      assert.equal(phone.win.getParentWindow(), null)
      const exposure = await execute(phone.win, `({ phone: typeof window.synkoraMobilePhone, broad: typeof window.synkora, node: typeof window.require, keys: Object.keys(window.synkoraMobilePhone ?? {}).sort() })`)
      assert.deepEqual(exposure, { phone: 'object', broad: 'undefined', node: 'undefined', keys: expected })
      const description = await phoneCall(phone.win, 'describe')
      assert.equal(description.ok, true)
      assert.equal(description.value.sessionId, phone.descriptor.sessionId)
      assert.equal(description.value.platform, phone.descriptor.platform)
      assert.equal(description.value.missionId, missionId)
      const preferences = phone.win.webContents.getLastWebPreferences()
      assert.equal(preferences.contextIsolation, true)
      assert.equal(preferences.sandbox, true)
      assert.equal(preferences.nodeIntegration, false)
    }
    assert.notEqual(android.win.webContents.session, ios.win.webContents.session)
    assert.equal((await execute(owner, 'typeof window.synkoraMobilePhone')), 'undefined')
  })

  await check('frameless native windows remain nonresizable while bounded content resizing works', async () => {
    for (const phone of [android, ios]) {
      const win = phone.win
      assert.equal(win.isResizable(), false)
      assert.equal(win.isMaximizable(), false)
      assert.equal(win.isFullScreenable(), false)
      assert.equal(win.hasShadow(), false)
      // Electron documents this getter as RGB-only, so it cannot prove alpha.
      // Hidden native windows have no compositor surface for capturePage; the
      // renderer visual fixture independently covers transparent composition.
      assert.equal(win.getBackgroundColor().toLowerCase(), '#000000')
      assert.equal(native.get(win).isNativeVisible(), false)
      const result = await phoneCall(win, 'resize', { width: 420, height: 700 })
      assert.equal(result.ok, true)
      assert.deepEqual(win.getContentSize(), [result.value.width, result.value.height])
      const content = win.getContentBounds(), outer = win.getBounds()
      assert.ok(Math.abs(content.width - outer.width) <= 1 && Math.abs(content.height - outer.height) <= 1, 'no native titlebar or border occupies phone content')
      const clamp = await phoneCall(win, 'resize', { width: 8192, height: 8192 })
      assert.equal(clamp.ok, true)
      assert.equal(clamp.value.clamped, true)
      const bounds = win.getBounds(), work = screen.getDisplayMatching(bounds).workArea
      assert.ok(bounds.x >= work.x && bounds.y >= work.y && bounds.x + bounds.width <= work.x + work.width + 1 && bounds.y + bounds.height <= work.y + work.height + 1)
      const before = win.getContentSize()
      assert.equal((await phoneCall(win, 'resize', { width: 99, height: 700 })).ok, false)
      assert.deepEqual(win.getContentSize(), before)
      await phoneCall(win, 'resize', { width: 420, height: 700 })
      geometry.push({ platform: phone.descriptor.platform, resized: result.value, clamped: clamp.value, nonresizable: !win.isResizable(), background: win.getBackgroundColor() })
    }
  })

  await check('phone identity and consumer capabilities stay isolated over real IPC', async () => {
    for (const phone of [android, ios]) {
      const lease = await phoneCall(phone.win, 'acquireView')
      assert.equal(lease.ok, true)
      phone.token = lease.value.consumerId
      assert.equal((await phoneCall(phone.win, 'capture', phone.token)).value.sessionId, phone.descriptor.sessionId)
      assert.equal((await phoneCall(phone.win, 'act', { type: 'tap', x: .25, y: .75 }, phone.token)).ok, true)
      assert.equal((await phoneCall(phone.win, 'monitorScale')).ok, true)
    }
    assert.notEqual(android.token, ios.token)
    const count = calls.capture.length
    assert.equal((await phoneCall(android.win, 'capture', ios.token)).ok, false)
    assert.equal((await phoneCall(ios.win, 'capture', android.token)).ok, false)
    assert.equal(calls.capture.length, count)
    const actionCount = calls.act.length
    assert.equal((await phoneCall(android.win, 'act', { type: 'tap', x: .5, y: .5, sessionId: ios.descriptor.sessionId }, android.token)).ok, false)
    assert.equal((await phoneCall(android.win, 'act', { type: 'install', relativePath: 'synthetic.apk' }, android.token)).ok, false)
    assert.equal(calls.act.length, actionCount)
    assert.deepEqual(calls.monitor, [android.win.webContents.id, ios.win.webContents.id])
  })

  await check('copied route, genuine subframe and altered route cannot acquire phone authority', async () => {
    const foreign = new BrowserWindow({ show: false, webPreferences: { preload: join(directory, 'preload.cjs'),
      additionalArguments: ['--mobile-phone'], contextIsolation: true, sandbox: true, nodeIntegration: false } })
    try {
      await foreign.loadURL(rendererUrl(android.descriptor.windowId))
      assert.equal((await phoneCall(foreign, 'describe')).ok, false, 'matching URL is not membership')
      assert.equal((await phoneCall(foreign, 'capture', android.token)).ok, false)
      assert.throws(() => windows.resolve(actualEvent(foreign)))
    } finally { foreign.destroy() }
    await execute(android.win, `new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = './fixture.html'; frame.onload = () => resolve(true); document.body.append(frame) })`)
    const child = android.win.webContents.mainFrame.frames[0]
    assert.ok(child)
    assert.equal(await child.executeJavaScript('typeof window.synkoraMobilePhone'), 'undefined')
    assert.throws(() => windows.resolve({ sender: android.win.webContents, senderFrame: child }))
    await execute(android.win, 'document.querySelector("iframe").remove()')
    const url = rendererUrl(android.descriptor.windowId)
    await execute(android.win, `history.replaceState(null, '', ${JSON.stringify(`${url}&missionId=foreign`)})`)
    assert.equal((await phoneCall(android.win, 'describe')).ok, false)
    await execute(android.win, `history.replaceState(null, '', ${JSON.stringify(url)})`)
    assert.equal((await phoneCall(android.win, 'describe')).ok, true)
    const lease = await phoneCall(android.win, 'acquireView')
    assert.equal(lease.ok, true)
    android.token = lease.value.consumerId
  })

  await check('synthetic video and ACKs reach only the bound window and current consumer', async () => {
    for (const phone of [android, ios]) {
      await execute(phone.win, `window.phonePackets = []; window.phoneChanges = 0; window.stopPhonePackets = window.synkoraMobilePhone.onVideo(packet => window.phonePackets.push({ sessionId: packet.sessionId, consumerId: packet.consumerId, timestampUs: packet.timestampUs, size: packet.data.length })); window.stopPhoneChanges = window.synkoraMobilePhone.onChanged(() => window.phoneChanges++); true`)
      assert.equal((await phoneCall(phone.win, 'setVideoVisible', true, phone.token)).ok, true)
    }
    presentation.emit(packet(android.descriptor.sessionId, 1000))
    presentation.emit(packet(ios.descriptor.sessionId, 2000))
    await pause(25)
    for (const phone of [android, ios]) {
      const packets = await execute(phone.win, 'window.phonePackets')
      assert.equal(packets.length, 1)
      assert.equal(packets[0].sessionId, phone.descriptor.sessionId)
      assert.equal(packets[0].consumerId, phone.token)
      assert.equal(packets[0].size, 6)
    }
    await phoneCall(android.win, 'ackVideo', `synthetic-${android.descriptor.sessionId}`, 1000, ios.token)
    await pause(10)
    assert.equal(calls.ack.length, 0)
    await phoneCall(android.win, 'ackVideo', `synthetic-${android.descriptor.sessionId}`, 1000, android.token)
    await until(() => calls.ack.length === 1, 'valid ACK reached only its own stream')
    assert.deepEqual(calls.ack[0], [missionId, android.descriptor.sessionId, `synthetic-${android.descriptor.sessionId}`, 1000])
    android.win.minimize()
    presentation.emit(packet(android.descriptor.sessionId, 3000))
    await pause(20)
    assert.equal((await execute(android.win, 'window.phonePackets')).length, 1)
    android.win.restore()
    await pause(20)
    presentation.emit(packet(android.descriptor.sessionId, 4000))
    await pause(20)
    assert.equal((await execute(android.win, 'window.phonePackets')).length, 2)
    presentation.changed(missionId)
    await pause(20)
    assert.ok(await execute(android.win, 'window.phoneChanges > 0'))
    await execute(android.win, 'window.stopPhonePackets(); window.stopPhoneChanges()')
    presentation.emit(packet(android.descriptor.sessionId, 5000))
    await pause(20)
    assert.equal((await execute(android.win, 'window.phonePackets')).length, 2, 'preload unsubscription removes its listener')
  })

  await check('native close redocks only its session without stopping an emulator', async () => {
    android.win.close()
    await until(() => android.win.isDestroyed(), 'the actual native close must retire the phone')
    const current = await ownerCall(owner, 'inspect', missionId)
    assert.equal(current.value.sessions.find(session => session.platform === 'android').presentation.host, 'dock')
    assert.equal(current.value.sessions.find(session => session.platform === 'ios').presentation.host, 'detached')
    assert.equal(ios.win.isDestroyed(), false)
    assert.equal(calls.stop.length, 0)
    const dockLease = await ownerCall(owner, 'acquireView', missionId, android.descriptor.sessionId)
    assert.equal(dockLease.ok, true)
    assert.equal((await ownerCall(owner, 'capture', missionId, android.descriptor.sessionId, dockLease.value.consumerId)).ok, true)
  })

  await check('session and mission revocation synchronously destroy only their registered native windows', async () => {
    const sessionClosing = presentation.closeSession(missionId, ios.descriptor.sessionId)
    assert.equal(ios.win.isDestroyed(), true)
    await sessionClosing
    const fresh = await openPhone('ios')
    missionActive = false
    const missionClosing = presentation.closeMission(missionId)
    assert.equal(fresh.win.isDestroyed(), true)
    await missionClosing
    assert.equal(calls.stop.length, 0)
    missionActive = true
  })

  await openPhone('android')
  await openPhone('ios')
  const quit = { started: false, finished: false, waitedForCleanup: false }
  holdCleanup = true
  installMobileQuitGuard(app, async () => {
    quit.started = true
    const closing = presentation.dispose()
    assert.ok(phones.every(phone => phone.win.isDestroyed()), 'native phone handles retire before awaited cleanup')
    await closing
    quit.finished = true
    assert.equal(quit.waitedForCleanup, true)
    assert.equal(calls.start.length, 0)
    assert.equal(calls.stop.length, 0)
    assert.ok([...native].every(([win, details]) => win.isDestroyed() || !details.isNativeVisible()))
    owner.destroy()
    clearTimeout(deadline)
    console.log('MOBILE_PHONE_NATIVE_PASS')
    console.log(JSON.stringify({ platform: process.platform, checks: [...checks, 'real before-quit guard waits for presentation cleanup'], geometry,
      captures: calls.capture.length, inputActions: calls.act.length, routedAcks: calls.ack.length, nativeStarts: calls.start.length, nativeStops: calls.stop.length,
      nativeWindowsAlwaysHidden: true, logicalVisibilityShim: true, allPhonesDestroyed: phones.every(phone => phone.win.isDestroyed()) }))
  }, () => { console.error('Synthetic phone quit timed out'); app.exit(1) }, 3000)
  setTimeout(() => {
    try {
      assert.equal(quit.started, true)
      assert.equal(quit.finished, false)
      quit.waitedForCleanup = true
      releaseCleanup()
    } catch (error) { console.error(error.stack); app.exit(1) }
  }, 30)
  app.quit()
}

run().catch(error => {
  console.error(error.stack)
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  clearTimeout(deadline)
  app.exit(1)
})

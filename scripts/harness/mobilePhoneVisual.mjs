import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Production phone route and preload. Only native device pixels/IPC effects and
// monitor metadata are synthetic; this never discovers or starts a device.
const pause = ms => new Promise(done => setTimeout(done, ms))
const ok = value => ({ ok: true, value })
const refused = () => ({ ok: false, error: 'Visualização sintética encerrada.' })
const directory = process.argv[2]
const { app, BrowserWindow, ipcMain } = await import('electron')
app.setPath('userData', join(directory, 'profile'))
app.disableHardwareAcceleration()

async function inspect() {
  await app.whenReady()
  const records = new Map(), windows = [], metrics = [], handlers = []
  const byEvent = event => records.get(event.sender.id)
  const handle = (name, work) => {
    const channel = `mobile:phone:${name}`; handlers.push(channel)
    ipcMain.handle(channel, (event, ...args) => { const record = byEvent(event); return record && !record.closed ? work(record, ...args) : refused() })
  }
  const current = (record, token) => token === record.token && !!token
  handle('describe', record => ok(record.descriptor))
  handle('acquireView', record => {
    if (record.descriptor.session.presentation.transitioning) return refused()
    record.token = `${record.descriptor.windowId}:${++record.claims}`
    return ok({ consumerId: record.token })
  })
  handle('releaseView', (record, token) => { if (current(record, token)) { record.releases++; record.token = null }; return ok() })
  handle('capture', async (record, token) => {
    const frame = await record.frame
    if (!current(record, token)) return refused()
    record.captures++; return ok({ ...frame, sessionId: record.descriptor.sessionId, mimeType: 'image/png', capturedAt: Date.now() })
  })
  handle('setVideoVisible', (record, visible, token) => { if (!current(record, token)) return refused(); record.video.push(visible); return ok() })
  handle('act', (record, action, token) => { if (!current(record, token)) return refused(); record.actions.push(action); return ok() })
  handle('pointer', (record, input, token) => { if (!current(record, token)) return refused(); record.pointers.push(input); return ok() })
  handle('monitorScale', record => ok({ physicalPixelsPerMm: 3.6, source: 'edid-detailed', displayId: 1,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: record.dpr }))
  handle('resize', (record, size) => {
    if (record.descriptor.session.presentation.transitioning) return refused()
    assert.ok(Number.isInteger(size.width) && Number.isInteger(size.height) && size.width >= 100 && size.height >= 100 && size.width <= 8192 && size.height <= 8192)
    const actual = { width: Math.min(size.width, record.limit.width), height: Math.min(size.height, record.limit.height) }
    const result = { ...actual, clamped: actual.width !== size.width || actual.height !== size.height }
    record.sizes.push({ requested: size, ...result }); record.win.setContentSize(actual.width, actual.height); return ok(result)
  })
  // The shared calibration record: the synthetic main keeps none, so the phone falls back to monitor detection.
  handle('calibrationRead', () => ok(null))
  handle('calibrationWrite', () => ok(true))
  handle('dock', record => { record.docks++; record.closed = true; record.token = null; setTimeout(() => record.win.destroy(), 30); return ok() })
  const run = (record, source) => record.win.webContents.executeJavaScript(source)
  const waitFor = async (fn, label) => { for (let i = 0; i < 120; i++) { const value = await fn(); if (value) return value; await pause(30) }; throw Error(`Timed out: ${label}`) }
  const measure = record => run(record, `(() => {
    const shell=document.querySelector('.mobile-phone-shell'), display=document.querySelector('.mobile-phone-display'), image=document.querySelector('img.mobile-screen'), root=document.querySelector('.mobile-phone-window');
    const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
    return {ready:!!image?.complete && image.naturalWidth>0, mode:shell?.dataset.sizeMode, family:shell?.dataset.frameFamily,
      shell:shell?rect(shell):null, display:display?rect(display):null, bar:rect(document.querySelector('.mobile-phone-window-bar')),
      drag:getComputedStyle(document.querySelector('.mobile-phone-window-bar')).webkitAppRegion,
      buttons:[...document.querySelectorAll('.mobile-phone-window-bar button')].map(b=>({label:b.ariaLabel,region:getComputedStyle(b).webkitAppRegion,...rect(b),hit:document.elementFromPoint(b.getBoundingClientRect().x+b.getBoundingClientRect().width/2,b.getBoundingClientRect().y+b.getBoundingClientRect().height/2)===b})),
      backgrounds:[document.documentElement,document.body,document.getElementById('root'),root].map(e=>getComputedStyle(e).backgroundColor),
      ownerBridge:Object.hasOwn(window,'synkora'),phoneBridge:!!window.synkoraMobilePhone,expand:!!document.querySelector('[aria-label="Ampliar tela do aparelho"]'),
      clamped:root.dataset.windowClamped==='true', errors:window.__phoneFixtureErrors, viewport:[innerWidth,innerHeight], dpr:devicePixelRatio};
  })()`)
  const click = async (record, label) => {
    const point = await run(record, `(() => {const r=document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    record.win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    record.win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await pause(50)
  }
  try {
    for (const [index, platform] of ['android', 'ios'].entries()) {
      const windowId = `10000000-0000-4000-8000-00000000000${index}`
      const sessionId = `${platform}-synthetic-session`
      const session = { id: sessionId, missionId: 'synthetic-mobile-window-mission', platform, deviceId: `synthetic-${platform}`, deviceName: platform === 'android' ? 'Pixel 7 · sintético' : 'iPhone 17 · sintético',
        displayProfileId: platform === 'android' ? 'pixel-7' : undefined, deviceTypeIdentifier: platform === 'ios' ? 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' : undefined,
        state: 'ready', inputAvailable: true, liveInputAvailable: platform === 'android', presentation: { host: 'detached', windowId, transitioning: true } }
      const win = new BrowserWindow({ width: 360, height: 720, x: 80 + index * 380, y: 60, show: false, frame: false, transparent: true, backgroundColor: '#00000000', useContentSize: true,
        resizable: false, maximizable: false, fullscreenable: false, webPreferences: { preload: join(directory, 'preload.cjs'), additionalArguments: ['--mobile-phone'], contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
      windows.push(win)
      let setFrame
      const record = { win, descriptor: { windowId, missionId: session.missionId, projectId: 'synthetic-project', sessionId, platform, session }, token: null, claims: 0, releases: 0, captures: 0, docks: 0,
        sizes: [], video: [], actions: [], pointers: [], closed: false, dpr: 1, limit: { width: 900, height: 950 }, frame: new Promise(done => { setFrame = done }) }
      records.set(win.webContents.id, record)
      await win.loadFile(join(directory, 'index.html'), { query: { view: 'mobile-phone', windowId } })
      const dimensions = platform === 'android' ? [1080, 2400] : [1206, 2622]
      record.dpr = await run(record, 'devicePixelRatio')
      const frame = await run(record, `window.__paintSyntheticPhone(${JSON.stringify(platform)},${dimensions[0]},${dimensions[1]})`)
      setFrame(frame)
      assert.equal(record.claims, 0, 'presentation transition blocks early view acquisition')
      assert.equal(record.sizes.length, 0, 'presentation transition cannot consume the physical resize')
      session.presentation.transitioning = false; win.webContents.send('mobile:phone:changed')
      await waitFor(async () => { const view = await measure(record); return view.ready && view.mode === 'physical' && record.sizes.length ? view : false }, `${platform} physical pixels`)
      await pause(200)
      const view = await measure(record)
      assert.equal(view.ownerBridge, false); assert.equal(view.phoneBridge, true); assert.equal(view.expand, false)
      assert.equal(view.drag, 'drag'); assert.ok(view.buttons.every(button => button.region === 'no-drag' && button.width >= 24 && button.height >= 24 && button.hit))
      assert.deepEqual(view.buttons.map(button => button.label), ['Início do dispositivo', 'Atualizar tela do dispositivo', 'Tamanho da visualização', 'Fechar janela do aparelho'], 'one strip: home, refresh, scale menu, close')
      assert.ok(view.backgrounds.every(color => color === 'rgba(0, 0, 0, 0)')); assert.deepEqual(view.errors, [])
      const diagonalMm = platform === 'android' ? 160.5 : 6.27 * 25.4
      assert.ok(Math.abs(Math.hypot(view.display.width, view.display.height) - diagonalMm * 3.6 / view.dpr) < .1, 'official display diagonal follows the explicit synthetic monitor measurement')
      assert.deepEqual(win.getContentSize(), [record.sizes.at(-1).width, record.sizes.at(-1).height])
      const capture = await win.webContents.capturePage()
      assert.equal(capture.toBitmap()[3], 0, 'transparent corner survives native capture')
      const path = resolve(`.synkora/reports/mobile-phone-${platform}-synthetic-2026-09-20.png`)
      await writeFile(path, capture.toPNG())
      record.image = capture.toDataURL()
      metrics.push({ platform, physical: view, nativeBounds: win.getBounds(), requested: record.sizes.at(-1).requested, screenshot: path })
    }
    const [android, ios] = [...records.values()]
    assert.equal(windows.length, 2); assert.notEqual(android.token, ios.token)
    const stable = android.sizes.length
    await pause(250); assert.equal(android.sizes.length, stable, 'physical sizing converges without resize traffic')
    android.limit.height = 430
    await click(android, 'Tamanho da visualização')
    await run(android, "[...document.querySelectorAll('.mobile-scale-menu button')].find(b=>b.textContent==='125%').click()")
    await waitFor(async () => (await measure(android)).clamped, 'work-area clamp')
    assert.equal(android.win.getContentSize()[1], 430)
    const clamped = await measure(android)
    assert.ok(clamped.buttons.every(button => button.hit)); assert.deepEqual(clamped.errors, [])
    await writeFile(resolve('.synkora/reports/mobile-phone-clamped-synthetic-2026-09-20.png'), (await android.win.webContents.capturePage()).toPNG())
    const firstClampCount = android.sizes.length
    // Changing the physical width may wrap/unwrap one toolbar row. Its measured
    // height may settle once; a repeated window-size feedback loop is a defect.
    await pause(250)
    const clampCount = android.sizes.length
    assert.ok(clampCount <= firstClampCount + 1, `at most one toolbar-height correction: ${JSON.stringify(android.sizes)}`)
    await pause(250); assert.equal(android.sizes.length, clampCount, 'clamped dimensions converge without a resize loop')
    await click(android, 'Tamanho da visualização')
    await run(android, "[...document.querySelectorAll('.mobile-scale-menu button')].find(b=>b.textContent==='Ajustar à janela').click()")
    await pause(150); assert.equal(android.sizes.length, clampCount)
    assert.equal((await measure(android)).mode, 'fit')
    const together = new BrowserWindow({ width: 850, height: 820, show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false } })
    windows.push(together)
    await together.loadFile(join(directory, 'comparison.html'))
    await together.webContents.executeJavaScript(`Promise.all(${JSON.stringify([android.image, ios.image])}.map((src,index)=>new Promise(done=>{const image=document.createElement('img');image.onload=done;image.src=src;document.querySelectorAll('figure')[index].append(image)})))`)
    await writeFile(resolve('.synkora/reports/mobile-phone-two-windows-synthetic-2026-09-20.png'), (await together.webContents.capturePage()).toPNG())
    await click(android, 'Fechar janela do aparelho')
    await waitFor(() => android.win.isDestroyed(), 'dock button closes only Android window')
    assert.equal(android.docks, 1); assert.equal(ios.win.isDestroyed(), false)
    await click(ios, 'Fechar janela do aparelho')
    await waitFor(() => ios.win.isDestroyed(), 'close button docks iOS window')
    assert.equal(ios.docks, 1)
    await writeFile(resolve('.synkora/reports/mobile-phone-synthetic-metrics-2026-09-20.json'), JSON.stringify({ kind: 'synthetic Android/iOS production route and preload; no native simulator or macOS execution', metrics, clamp: clamped, dockCounts: [android.docks, ios.docks] }, null, 2))
    console.log('Phone visual Electron PASS: two restricted routes, physical dimensions, transparent native captures, bounded clamp, header hit regions and independent dock/close.')
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    for (const channel of handlers) ipcMain.removeHandler(channel)
  }
}

inspect().then(() => app.exit(0)).catch(error => { console.error(error.stack); app.exit(1) })

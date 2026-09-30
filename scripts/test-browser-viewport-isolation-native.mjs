import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(30,90,150)}
#left,#right{position:fixed;top:0;width:24px;height:100%}
#left{left:0;background:rgb(10,120,60)}#right{right:0;background:rgb(200,30,120)}
#target{position:fixed;left:70%;top:55%;width:160px;height:96px;background:rgb(220,120,40);border:0}
@media(min-width:1024px){body{--layout:desktop}}@media(max-width:699px){body{--layout:mobile}}
</style><div id="left"></div><div id="right"></div><button id="target">Synthetic target</button>
<script>
window.clicks=[];window.wheels=[];window.frames=0;window.nonce=Math.random().toString(36).slice(2);
function tick(){frames++;requestAnimationFrame(tick)}requestAnimationFrame(tick);
document.addEventListener('click',e=>clicks.push({id:e.target.id,x:e.clientX,y:e.clientY}));
document.addEventListener('wheel',e=>wheels.push({id:e.target.id,x:e.clientX,y:e.clientY,deltaX:e.deltaX,deltaY:e.deltaY}),{passive:true});
window.facts=()=>{const r=document.querySelector('#target').getBoundingClientRect();return {
width:innerWidth,height:innerHeight,dpr:devicePixelRatio,clientWidth:document.documentElement.clientWidth,
layout:getComputedStyle(document.body).getPropertyValue('--layout').trim(),
nonce,frames,clicks,wheels,target:{x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}}};
</script>`

async function bounded(work, label) {
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), 3000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

async function facts(view) {
  return bounded(view.webContents.executeJavaScript('window.facts()'), 'page facts')
}

async function painted(view) {
  await bounded(view.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'), 'two frames')
}

async function capture(view, directory, name, rect) {
  const started = performance.now()
  const image = await bounded(view.webContents.capturePage(rect), name)
  assert.ok(!image.isEmpty(), `${name}: native capture must deliver pixels`)
  await writeFile(join(directory, `${name}.png`), image.toPNG())
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const pixel = (x, y) => [...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)].reverse()
  return { width, height, rect, ms: Math.round(performance.now() - started),
    left: pixel(2, Math.floor(height / 4)), right: pixel(width - 3, Math.floor(height / 4)),
    center: pixel(Math.floor(width / 2), Math.floor(height / 4)),
    midpoint: pixel(Math.floor(width / 2), Math.floor(height / 2)) }
}

async function click(view, channel, point) {
  await view.webContents.executeJavaScript('window.clicks=[]')
  const wc = view.webContents
  if (channel === 'cdp') {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point,
        button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' })
    }
  } else {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      wc.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
    }
  }
  await pause(100)
  return { sent: point, clicks: (await facts(view)).clicks }
}

async function inspect() {
  const { app, BrowserWindow, screen } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const native = await import(pathToFileURL(join(directory, 'native.mjs')).href)
  const { electronBrowserViewHost, BrowserDriverSession } = native
  const report = { technique: 'production native applyViewportFit',
    electron: process.versions.electron, chrome: process.versions.chrome,
    monitorScale: screen.getPrimaryDisplay().scaleFactor, observations: [] }
  const server = createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(page)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  report.port = port
  const win = new BrowserWindow({ show: false, opacity: 0, focusable: false, skipTaskbar: true,
    width: 1450, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.setIgnoreMouseEvents(true)
  win.showInactive()
  const host = electronBrowserViewHost(() => win)
  const extraWindows = []
  const a = host.create('synthetic-viewport-project')
  const b = host.create('synthetic-viewport-project')
  const apply = async (view, mode, frame, force = false) => {
    const rect = native.viewportViewRect(mode, frame)
    view.setBounds(rect)
    const result = native.applyViewportFit(view.webContents, mode, frame.width, frame.height, force)
    await painted(view)
    return { mode, rect, scale: result.zoom, changed: result.changed }
  }
  const measure = async label => {
    const pair = { label, a: await facts(a), b: await facts(b),
      zoomA: a.webContents.getZoomFactor(), zoomB: b.webContents.getZoomFactor() }
    report.observations.push(pair)
    return pair
  }
  try {
    assert.ok(a && b)
    report.setZoomModeRuntime = typeof a.webContents.setZoomMode
    report.initialAuto = native.applyViewportFit(a.webContents, 'auto', 400, 320)
    report.initialForcedAuto = native.applyViewportFit(b.webContents, 'auto', 400, 320, true)
    report.initialRequestedWidth = native.applyViewportFit(a.webContents, 1280, 400, 320)
    assert.equal(report.initialAuto.changed, false, 'initial AUTO must avoid touching native emulation before a renderer exists')
    assert.equal(report.initialForcedAuto.changed, false, 'force must not disable never-enabled native emulation')
    assert.equal(report.initialRequestedWidth.changed, false, 'a preset waits for the first renderer before native emulation')
    assert.equal(a.webContents.session, b.webContents.session, 'tabs retain the same project session')
    host.attach(a)
    host.attach(b)
    a.setVisible(true)
    b.setVisible(true)
    a.setBounds({ x: 0, y: 0, width: 400, height: 320 })
    b.setBounds({ x: 450, y: 0, width: 375, height: 320 })
    await a.webContents.loadURL(`http://127.0.0.1:${port}/a`)
    await b.webContents.loadURL(`http://127.0.0.1:${port}/b`)
    await painted(a)
    report.baselineCapture = await capture(a, directory, 'baseline')
    await a.webContents.executeJavaScript("localStorage.setItem('synthetic-project-marker','shared')")
    assert.equal(await b.webContents.executeJavaScript("localStorage.getItem('synthetic-project-marker')"), 'shared')
    const frameA = { x: 0, y: 0, width: 400, height: 320 }
    const frameB = { x: 450, y: 0, width: 400, height: 320 }
    report.fitA = await apply(a, 1280, frameA)
    await measure('after fitting A')
    report.fitB = await apply(b, 375, frameB)
    const pair = await measure('after fitting B')
    assert.deepEqual([pair.a.width, pair.b.width], [1280, 375], 'same-origin project tabs keep independent effective widths')
    report.cachedFit = await apply(a, 1280, frameA)
    assert.equal(report.cachedFit.changed, false, 'unchanged native emulation avoids redundant writes')
    report.fullCapture = await capture(a, directory, 'emulated-full')
    report.frameCapture = await capture(a, directory, 'emulated-frame', { x: 0, y: 0, width: 400, height: 320 })
    const target = pair.a.target
    const logical = { x: target.cx, y: target.cy }
    const physical = { x: logical.x * report.fitA.scale, y: logical.y * report.fitA.scale }
    report.pointer = { cdpLogical: await click(a, 'cdp', logical), cdpScaled: await click(a, 'cdp', physical),
      nativePhysical: await click(a, 'native', physical) }
    const logicalClip = { x: Math.floor(target.x), y: Math.floor(target.y), width: target.width, height: target.height }
    const physicalClip = native.viewportCaptureRect(a.webContents,
      { x: target.x, y: target.y, width: target.width, height: target.height })
    try {
      report.logicalClip = await capture(a, directory, 'emulated-logical-clip', logicalClip)
    } catch (error) {
      report.logicalClip = { error: error.message, rect: logicalClip }
    }
    report.physicalClip = await capture(a, directory, 'emulated-physical-clip', physicalClip)
    assert.deepEqual([pair.a.width, pair.b.width], [1280, 375])
    assert.deepEqual([report.fullCapture.width, report.fullCapture.height],
      [report.baselineCapture.width, report.baselineCapture.height], 'native emulation preserves capture shape')
    assert.deepEqual([report.frameCapture.width, report.frameCapture.height],
      [report.baselineCapture.width, report.baselineCapture.height])
    assert.deepEqual(report.frameCapture.right, [200, 30, 120], 'cropped frame includes the right viewport edge')
    assert.equal(report.pointer.cdpScaled.clicks.at(-1)?.id, 'target', 'scaled CDP pointer hits the logical target')
    assert.equal(report.pointer.nativePhysical.clicks.at(-1)?.id, 'target', 'owner physical pointer hits the logical target')
    assert.deepEqual(report.physicalClip.center, [220, 120, 40], 'scaled clip captures the target pixels')
    assert.deepEqual(report.physicalClip.left, [220, 120, 40])
    assert.deepEqual(report.physicalClip.right, [220, 120, 40])
    assert.equal(native.viewportCaptureRect(a.webContents), undefined, 'whole-page capture keeps its native shape')
    const driver = new BrowserDriverSession(a.webContents)
    await a.webContents.executeJavaScript('window.clicks=[];window.wheels=[]')
    const driverClick = await driver.actResult([{ action: 'click', selector: '#target' }], {}, { observe: false })
    const driverWheel = await driver.actResult([{ action: 'scroll', selector: '#target', amount: 400, direction: 'down' }], {}, { observe: false })
    report.driver = { click: { ok: driverClick.ok, completed: driverClick.completed, error: driverClick.error },
      wheel: { ok: driverWheel.ok, completed: driverWheel.completed, error: driverWheel.error },
      events: await facts(a) }
    assert.ok(driverClick.ok, driverClick.error)
    assert.ok(driverWheel.ok, driverWheel.error)
    assert.equal(report.driver.events.clicks.at(-1)?.id, 'target', 'real BrowserDriverSession selector click hits the target')
    assert.equal(report.driver.events.wheels.at(-1)?.deltaY, 400, 'real BrowserDriverSession wheel retains CSS delta')
    report.wheel = []
    for (const deltaY of [400, 125]) {
      await a.webContents.executeJavaScript('window.wheels=[]')
      await a.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', ...physical, deltaX: 0, deltaY, pointerType: 'mouse' })
      await pause(50)
      report.wheel.push({ deltaYSent: deltaY, events: (await facts(a)).wheels })
    }
    report.resizedA = await apply(a, 1280, { ...frameA, width: 600 })
    const resized = await measure('A resized to 600 DIP')
    assert.deepEqual([resized.a.width, resized.b.width], [1280, 375])
    a.setVisible(false)
    b.setVisible(true)
    await painted(a)
    const background = await measure('A moved to native background carrier')
    assert.deepEqual([background.a.width, background.b.width], [1280, 375])
    await a.webContents.executeJavaScript("document.body.style.background='rgb(45,110,170)'")
    await painted(a)
    report.backgroundCapture = await capture(a, directory, 'background')
    assert.deepEqual(report.backgroundCapture.center, [45, 110, 170], 'background capture contains newly painted pixels')
    await a.webContents.executeJavaScript('window.clicks=[]')
    const backgroundClick = await driver.actResult([{ action: 'click', selector: '#target' }], {}, { observe: false })
    assert.ok(backgroundClick.ok, backgroundClick.error)
    assert.equal((await facts(a)).clicks.at(-1)?.id, 'target', 'real driver hits background targets')
    report.backgroundDriverClick = { ok: backgroundClick.ok, clicks: (await facts(a)).clicks }
    a.setVisible(true)
    b.setVisible(false)
    await painted(b)
    const selected = await measure('A selected and B background')
    assert.deepEqual([selected.a.width, selected.b.width], [1280, 375])
    a.setVisible(false)
    b.setVisible(false)
    await Promise.all([painted(a), painted(b)])
    await Promise.all([a, b].map(view => view.webContents.executeJavaScript('window.clicks=[]')))
    const otherDriver = new BrowserDriverSession(b.webContents)
    const hiddenActions = await Promise.all([driver, otherDriver].map(session =>
      session.actResult([{ action: 'click', selector: '#target' }], {}, { observe: false })))
    assert.ok(hiddenActions.every(result => result.ok), 'both hidden tabs accept concurrent actions')
    const hidden = await measure('both tabs hidden with the dock panel closed')
    assert.deepEqual([hidden.a.width, hidden.b.width], [1280, 375])
    assert.equal(hidden.a.clicks.at(-1)?.id, 'target')
    assert.equal(hidden.b.clicks.at(-1)?.id, 'target')
    report.closedPanelCaptures = await Promise.all([capture(a, directory, 'panel-closed-a'), capture(b, directory, 'panel-closed-b')])
    a.setVisible(true)
    await a.webContents.loadURL(`http://127.0.0.1:${port}/navigation`)
    const navigation = await measure('same-origin navigation without reapplying emulation')
    report.navigationNeedsReapply = navigation.a.width !== 1280
    const cachedNavigation = native.applyViewportFit(a.webContents, 1280, 600, frameA.height)
    assert.equal(cachedNavigation.changed, false)
    await apply(a, 1280, { ...frameA, width: 600 }, true)
    const reapplied = await measure('emulation reapplied after navigation')
    assert.deepEqual([reapplied.a.width, reapplied.b.width], [1280, 375])
    const nonce = navigation.a.nonce
    await apply(a, 'auto', { ...frameA, width: 600 })
    const auto = await measure('disableDeviceEmulation AUTO')
    assert.deepEqual([auto.a.width, auto.a.height, auto.b.width], [600, 320, 375])
    assert.equal(auto.a.nonce, nonce, 'AUTO does not reload the page')
    assert.equal(await a.webContents.executeJavaScript("localStorage.getItem('synthetic-project-marker')"), 'shared')
    await apply(a, 1280, { ...frameA, width: 600 })
    await bounded(a.webContents.loadURL(`http://localhost:${port}/cross-origin`), 'local cross-origin navigation')
    await measure('cross-origin navigation before force')
    await apply(a, 1280, { ...frameA, width: 600 }, true)
    const crossOrigin = await measure('cross-origin navigation after force')
    assert.deepEqual([crossOrigin.a.width, crossOrigin.b.width], [1280, 375])
    await a.webContents.loadURL(`http://127.0.0.1:${port}/session-return`)
    await apply(a, 1280, { ...frameA, width: 600 }, true)
    assert.equal(await a.webContents.executeJavaScript("localStorage.getItem('synthetic-project-marker')"), 'shared')
    assert.equal(a.webContents.session, b.webContents.session)
    report.projectSessionRetained = true
    await apply(a, 1280, { ...frameA, width: 300 })
    const clamped = await measure('canonical zoom floor in 300 DIP frame')
    assert.equal(clamped.a.width, 1200, 'existing 0.25 floor remains effective')
    const popout = new BrowserWindow({ show: false, opacity: 0, focusable: false, skipTaskbar: true,
      width: 1450, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    extraWindows.push(popout)
    popout.setIgnoreMouseEvents(true)
    popout.showInactive()
    const popoutHost = electronBrowserViewHost(() => popout)
    popoutHost.attach(a)
    report.popoutFit = await apply(a, 375, { ...frameA, width: 1400 })
    const popoutState = await measure('popout with centered 375 DIP view')
    assert.deepEqual([popoutState.a.width, popoutState.b.width], [375, 375])
    assert.equal(report.popoutFit.scale, 1, 'fitting never enlarges the page')
    assert.equal(report.popoutFit.rect.x, 512)
    assert.equal(popoutHost.viewWindow(a).id, popout.id)
    await a.webContents.executeJavaScript('window.clicks=[]')
    const popoutClick = await driver.actResult([{ action: 'click', selector: '#target' }], {}, { observe: false })
    assert.ok(popoutClick.ok, popoutClick.error)
    assert.equal((await facts(a)).clicks.at(-1)?.id, 'target', 'centered popout uses view-local pointer coordinates')
    report.popoutCapture = await capture(a, directory, 'popout')
    assert.deepEqual(report.popoutCapture.left, [10, 120, 60])
    assert.deepEqual(report.popoutCapture.right, [200, 30, 120])
  } catch (error) {
    report.failure = { message: error.message, actual: error.actual, expected: error.expected }
    throw error
  } finally {
    await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2))
    for (const view of [a, b]) if (view && !view.webContents.isDestroyed()) view.webContents.close()
    for (const window of extraWindows) if (!window.isDestroyed()) window.destroy()
    win.destroy()
    await new Promise(resolve => server.close(resolve))
    app.exit(report.failure ? 1 : 0)
  }
}

if (process.versions.electron) {
  inspect().catch(error => { console.error(error); process.exitCode = 1 })
} else {
  test('native production fit isolates project tabs and preserves driver and capture coordinates', { timeout: 60000 }, async t => {
    const root = resolve('.synkora/probes/viewport-isolation-native')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'native-'))
    buildSync({ stdin: { contents: [
      "export { electronBrowserViewHost } from './src/main/browserPaneHost.ts'",
      "export { viewportViewRect } from './src/main/browserViewport.ts'",
      "export { applyViewportFit, viewportCaptureRect } from './src/main/browserViewportFit.ts'",
      "export { BrowserDriverSession } from './src/main/browserDriver.ts'"
    ].join('\n'), resolveDir: resolve('.') }, bundle: true, platform: 'node', format: 'esm',
      external: ['electron'], outfile: join(directory, 'native.mjs') })
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory,
      '--force-color-profile=srgb'],
      { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    await writeFile(join(directory, 'electron.log'), output)
    console.log(`Native evidence: ${directory}`)
    assert.equal(code, 0, `Electron probe exit=${code}; inspect ${join(directory, 'results.json')} and electron.log`)
  })
}

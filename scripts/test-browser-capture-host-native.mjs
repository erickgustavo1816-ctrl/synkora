import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const { electronBrowserViewHost } = await import(pathToFileURL(join(directory, 'host.mjs')).href)
  const win = new BrowserWindow({ show: false, opacity: 0, focusable: false, skipTaskbar: true,
    width: 600, height: 450, webPreferences: { sandbox: true, contextIsolation: true } })
  win.setIgnoreMouseEvents(true)
  win.showInactive()
  const host = electronBrowserViewHost(() => win)
  const view = host.create('synthetic-capture-host')
  try {
    host.attach(view)
    view.setBounds({ x: 0, y: 0, width: 375, height: 300 })
    await view.webContents.loadURL('data:text/html,<style>body{background:rgb(30,90,150)}</style><h1>Captura sintética</h1>')
    view.setVisible(true)
    await pause(150)
    const actual = host.viewWindow(view)
    console.log(JSON.stringify({ expectedHost: win.id, actual, ownerVisible: win.isVisible() }))
    assert.equal(actual.id, win.id, 'visible page capture must consult its current window after reparenting')
    assert.equal(actual.visible, true)
    assert.equal(actual.minimized, false)
    win.hide()
    await view.webContents.executeJavaScript("document.body.style.background='rgb(20,140,60)'")
    await pause(100)
    const started = Date.now()
    const shot = await Promise.race([view.webContents.capturePage(), pause(2000).then(() => null)])
    assert.ok(shot && !shot.isEmpty(), 'attached hidden-window pages can still deliver pixels within the capture deadline')
    const pixel = [...shot.toBitmap().subarray(0, 3)]
    assert.deepEqual(pixel, [60, 140, 20], 'the captured page contains the new pixels, not a cached image')
    assert.equal(win.isVisible(), false, 'capture must not show the window')
    console.log(JSON.stringify({ hiddenCaptureMs: Date.now() - started, pixel }))
    win.showInactive()
    view.setVisible(false)
    await pause(100)
    const carrier = host.viewWindow(view)
    assert.notEqual(carrier.id, win.id, 'hidden tabs must report the actual rendering carrier')
    assert.equal(carrier.visible, true)
    view.setVisible(true)
    assert.equal(host.viewWindow(view).id, win.id)
    host.detach(view)
    assert.equal(host.viewWindow(view), null, 'detached pages must remain refused')
  } finally {
    view.webContents.close()
    win.destroy()
    app.quit()
  }
}

if (process.versions.electron) {
  inspect().catch(error => { console.error(error); process.exit(1) })
} else {
  test('native capture follows the rendering window across background and dock', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/capture-host-'))
    buildSync({ entryPoints: ['src/main/browserPaneHost.ts'], bundle: true, platform: 'node',
      format: 'esm', external: ['electron'], outfile: join(directory, 'host.mjs') })
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory],
      { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const report = resolve('.synkora/reports')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const baseline = process.argv.includes('--baseline')

async function inspect() {
  const { app, BrowserWindow, WebContentsView, ipcMain } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  await app.whenReady()
  const win = new BrowserWindow({ width: 1000, height: 700, useContentSize: true,
    show: false, skipTaskbar: true, focusable: false, opacity: 0, frame: false, transparent: true,
    webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false } })
  win.setIgnoreMouseEvents(true)
  win.showInactive()
  const { createBrowserBackgroundSurface, attachBrowserSurface } = createRequire(import.meta.url)(join(directory, 'surface.cjs'))
  const native = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false } })
  const view = createBrowserBackgroundSurface(() => win).wrap(native)
  attachBrowserSurface(win, view)
  let latest = null
  ipcMain.on('fixture:bounds', (_event, rect, visible) => {
    latest = { rect, visible }
    view.setBounds(rect)
    view.setVisible(visible)
  })
  const run = code => win.webContents.executeJavaScript(code)
  try {
    await native.webContents.loadURL('data:text/html,<style>body{background:%23efe9dc;font:24px monospace}</style><h1>Pagina sintetica preservada</h1><script>window.fixtureState=73</script>')
    const pageId = native.webContents.id
    await win.loadFile(join(directory, 'index.html'))
    await pause(450)
    assert.equal(latest?.visible, true, 'native browser starts visible')
    for (const [trigger, id] of [['.tb-limits-trigger', 'titlebar-account-limits'], ['.tb-cli-trigger', 'titlebar-cli-status']]) {
      await run(`document.querySelector('${trigger}').click()`)
      await pause(240)
      const metric = await run(`(() => {
        const panel = document.getElementById('${id}'), page = document.querySelector('.dock-browser-page');
        return { panel: panel.getBoundingClientRect().toJSON(), page: page.getBoundingClientRect().toJSON(),
          portal: panel.parentElement === document.body, focus: panel.contains(document.activeElement) };
      })()`)
      assert.ok(metric.panel.left < metric.page.right && metric.panel.bottom > metric.page.top, 'fixture really overlaps')
      if (id === 'titlebar-account-limits') await writeFile(join(report, `titlebar-browser-${baseline ? 'before' : 'after'}.png`), (await win.webContents.capturePage()).toPNG())
      assert.equal(latest.visible, false, `browser must yield to ${id}: ${JSON.stringify(metric)}`)
      assert.equal(metric.portal, true, 'dialog is a root portal detected by DockBrowser')
      assert.equal(metric.focus, true)
      assert.notEqual(BrowserWindow.fromWebContents(native.webContents), win, 'native view no longer covers the host dialog')
      assert.equal(await native.webContents.executeJavaScript('window.fixtureState'), 73, 'page remains live in the background')
      await run(`document.getElementById('${id}').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
      await pause(40)
      assert.equal(await run(`!!document.getElementById('${id}')`), true, 'inside click keeps portal open')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await pause(150)
      assert.equal(latest.visible, true, 'closing restores browser')
      assert.equal(BrowserWindow.fromWebContents(native.webContents), win)
      assert.equal(native.webContents.id, pageId)
      assert.equal(await run(`document.activeElement.matches('${trigger}')`), true, 'Escape restores trigger focus')
      console.log(JSON.stringify({ id, ...metric, restored: latest.visible, pageId }))
    }
    // A small, distant menu does not need to hide the native page.
    await run("Object.assign(document.querySelector('.fixture-browser').style, {width: '250px'})")
    await pause(100)
    await run("document.querySelector('.tb-limits-trigger').click()")
    await pause(180)
    assert.equal(latest.visible, true, 'non-overlapping dialog leaves the browser visible')
    await run("document.querySelector('.fixture-browser').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))")
    await pause(80)
    assert.equal(await run("!!document.getElementById('titlebar-account-limits')"), false, 'outside click closes')
    // The menu first fits above the page, then usage arrives asynchronously.
    await run("Object.assign(document.querySelector('.fixture-browser').style, {width: '850px', top: '280px'}); window.holdUsage = true")
    await pause(80)
    await run("document.querySelector('.tb-limits-trigger').click()")
    await pause(180)
    assert.equal(latest.visible, true, 'loading menu fits above the native page')
    await run('window.resolveUsage()')
    await pause(100)
    assert.equal(latest.visible, false, 'async menu growth promptly hides the overlapping native view')
    // Keep the same portal open while narrowing the app window.
    win.setContentSize(320, 380)
    await pause(150)
    const small = await run(`(() => {
      const panel = document.getElementById('titlebar-account-limits');
      return { rect: panel.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight };
    })()`)
    assert.ok(small.rect.left >= 7 && small.rect.right <= small.width - 7, JSON.stringify(small))
    assert.ok(small.rect.top >= 7 && small.rect.bottom <= small.height - 7, JSON.stringify(small))
    console.log('PASS real TitleBar + DockBrowser + native WebContentsView: usage/CLI overlap, background continuity, restore, focus, non-overlap, async growth and narrow window.')
  } catch (error) {
    console.error(error.stack)
    throw error
  } finally {
    if (!native.webContents.isDestroyed()) {
      const closed = new Promise(resolve => native.webContents.once('destroyed', resolve))
      native.webContents.close()
      await Promise.race([closed, pause(2000)])
    }
    win.destroy()
  }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  await mkdir('.tmp', { recursive: true })
  await mkdir(report, { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/titlebar-browser-qa-'))
  buildSync({ entryPoints: ['src/main/browserBackgroundSurface.ts'], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: join(directory, 'surface.cjs') })
  await writeFile(join(directory, 'preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{bounds:(rect,visible)=>ipcRenderer.send('fixture:bounds',rect,visible)})")
  buildSync({ stdin: { contents: `
    import { createRoot } from 'react-dom/client'
    import TitleBar from './components/TitleBar'
    import DockBrowser from './components/DockBrowser'
    import { installDevMock } from './devMock'
    import { useStore } from './store'
    installDevMock()
    window.synkora.browser.bounds = (_id, rect, visible) => window.fixture.bounds(rect, visible)
    const usage = () => ({ at: Date.now(), plan: 'Plano sintetico', lines: [],
      meters: [1,2,3].map(n => ({ label: 'Janela ' + n, window: '7d', pct: 70, mode: 'left', severity: .3, reset: '12:00' })) })
    const pending = []
    window.resolveUsage = () => pending.splice(0).forEach(resolve => resolve(usage()))
    window.synkora.seats.usage = () => window.holdUsage ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(usage())
    useStore.setState({ seats: [1,2].map(n => ({ id: 'synthetic-' + n, name: 'Conta de teste ' + n,
      cli: n === 1 ? 'codex' : 'claude', status: 'logado', configDir: 'C:/synthetic', createdAt: '' })) })
    const state = { alive: true, agentDriving: false, host: 'dock', tabs: [] }
    createRoot(document.getElementById('root')).render(<><TitleBar /><div className="fixture-browser">
      <DockBrowser missionId="synthetic" projectId="synthetic" state={state} engine="ready" error={null} visible />
    </div></>)
  `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src/global.css')).href}"><link rel="stylesheet" href="fixture.css"><style>.fixture-browser{position:absolute;left:40px;top:140px;width:850px;height:530px;overflow:hidden}</style><div id="root"></div><script src="fixture.js"></script></html>`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory, ...(baseline ? ['--baseline'] : [])], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 30000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  clearTimeout(timeout)
  console.log(output.trim())
  assert.equal(code, 0)
}

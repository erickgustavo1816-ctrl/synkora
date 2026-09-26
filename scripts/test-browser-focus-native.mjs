import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const pageUrl = text => `data:text/html,${encodeURIComponent(text)}`

async function inspect() {
  const { app, BrowserWindow, webContents } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const { electronBrowserViewHost, BrowserDriverSession } = await import(pathToFileURL(join(directory, 'host.mjs')).href)
  const owner = new BrowserWindow({ show: false, opacity: 0, skipTaskbar: true,
    width: 800, height: 500, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  owner.setIgnoreMouseEvents(true)
  owner.showInactive()
  const host = electronBrowserViewHost(() => owner)
  const view = host.create('synthetic-focus')
  const shell = owner.webContents
  const page = view.webContents
  const driver = new BrowserDriverSession(page)
  const content = '<input id="field" aria-label="Page field"><button id="button" onclick="this.textContent=\'Clicked\'">Continue</button>'
  try {
    await shell.loadURL(pageUrl('<textarea id="chat">draft</textarea><input id="search" value="query">'))
    host.attach(view)
    view.setBounds({ x: 400, y: 0, width: 375, height: 400 })
    view.setVisible(true)
    await page.loadURL(pageUrl(content))
    await pause(100)
    const operations = [
      ['navigate', () => page.loadURL(pageUrl(content + '<p>Next page</p>'))],
      ['reload', async () => {
        const loaded = once(page, 'did-finish-load')
        page.reload()
        await loaded
      }],
      ['read', () => driver.read()],
      ['actions', async () => {
        const result = await driver.actResult([
          { action: 'click', selector: '#button' },
          { action: 'fill', selector: '#field', value: 'auto' },
          { action: 'type', selector: '#field', text: 'matic' },
          { action: 'press', key: 'End' }
        ])
        assert.equal(result.ok, true, result.text)
        assert.equal(await page.executeJavaScript('document.querySelector("#button").textContent'), 'Clicked')
        assert.equal(await page.executeJavaScript('document.querySelector("#field").value'), 'automatic')
      }]
    ]
    for (const field of ['chat', 'search']) for (const [operation, run] of operations) {
      shell.focus()
      await shell.executeJavaScript(`{
        const field = document.getElementById('${field}'); field.value = 'draft';
        field.focus(); field.setSelectionRange(2, 2);
      }`)
      assert.equal(await shell.executeJavaScript('document.hasFocus()'), true, 'the synthetic field must actually have focus')
      const events = []
      const blur = () => events.push('shell-blur')
      const focus = () => events.push('page-focus')
      shell.on('blur', blur)
      page.on('focus', focus)
      await run()
      await pause(30)
      if (events.length) console.log(JSON.stringify({ field, operation, events, ownerFocused: owner.isFocused(), shellFocused: shell.isFocused(), pageFocused: page.isFocused() }))
      shell.off('blur', blur)
      page.off('focus', focus)
      assert.deepEqual(events, [], `${field}/${operation}: automation must not interrupt application focus`)
      assert.equal(await shell.executeJavaScript('document.hasFocus()'), true, `${field}/${operation}: application stays focused`)
      const focused = webContents.getFocusedWebContents()
      assert.equal(focused?.id, shell.id)
      focused.sendInputEvent({ type: 'char', keyCode: 'x' })
      await pause(20)
      assert.equal(await shell.executeJavaScript('document.activeElement.value'), 'drxaft', `${field}/${operation}: typing resumes at the same caret`)
      console.log(`PASS ${field}/${operation}: focus, caret and continued typing`)
    }
    page.focus()
    await page.executeJavaScript('document.querySelector("#field").focus()')
    assert.equal(page.isFocused(), true, 'explicit user focus remains available')
    const reloaded = once(page, 'did-finish-load')
    page.reload()
    await reloaded
    assert.equal(page.isFocused(), true, 'navigation preserves focus when the user is already in the browser')
  } finally {
    page.close()
    owner.destroy()
    app.quit()
  }
}

if (process.versions.electron) {
  inspect().catch(error => { console.error(error); process.exit(1) })
} else {
  test('browser automation preserves application typing and explicit browser focus', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/browser-focus-'))
    buildSync({ stdin: { contents: "export { electronBrowserViewHost } from './src/main/browserPaneHost'; export { BrowserDriverSession } from './src/main/browserDriver'", resolveDir: resolve('.') }, bundle: true, platform: 'node',
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

// Isolated Windows probe: synthetic page, native window ordering and references.
// Run with --baseline to reproduce the previous one-shot focus behavior.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function inspect() {
  const { app, BrowserWindow, WebContentsView } = await import('electron')
  app.setPath('userData', join(process.argv[2], 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const { toggleBrowserDevtools, toggleBrowserDevtoolsWindow, installBrowserReferencePicker } =
    await import(pathToFileURL(join(process.argv[2], 'probe.mjs')).href)
  const owner = new BrowserWindow({ width: 880, height: 620, show: false, title: 'Synkora — teste isolado',
    webPreferences: { sandbox: true, contextIsolation: true } })
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  owner.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 64, width: 640, height: 400 })
  const wc = view.webContents
  const baseline = process.argv.includes('--baseline')
  const toggle = () => baseline ? toggleBrowserDevtools(wc) : toggleBrowserDevtoolsWindow(wc, owner)
  const observer = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve('scripts/devtools-window-observer.ps1'), '-TargetProcess', String(process.pid),
    '-OwnerHandle', String(owner.getNativeWindowHandle().readBigUInt64LE())],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: observer.stdout })[Symbol.asyncIterator]()
  let dispose = () => {}
  try {
    assert.equal((await lines.next()).value, 'ready')
    const nativeState = async (action = 'read') => {
      observer.stdin.write(action + '\n')
      return JSON.parse((await lines.next()).value)
    }
    await owner.loadURL('data:text/html,' + encodeURIComponent('<title>Synkora — teste isolado</title><style>body{background:#efe9dc;font:16px monospace}</style>Teste de DevTools — fecha automaticamente.'))
    await wc.loadURL('data:text/html,<title>Pagina ficticia</title><h1>Elemento de teste</h1>')
    // windowsHide hides the launcher's console and overrides the first native
    // ShowWindow. A second show makes the fixture genuinely visible for Win32.
    owner.show(); owner.hide(); owner.show(); owner.focus()
    await pause(80)
    for (const withReferences of [false, true]) {
      const errors = [], captures = []
      let ready
      const installed = new Promise(resolve => { ready = resolve })
      if (withReferences) dispose = installBrowserReferencePicker(wc, {
        prepare: () => snapshot => { captures.push(snapshot); return { ok: true } },
        onError: message => errors.push(message), onReady: ready
      })
      const opened = new Promise(resolve => wc.once('devtools-opened', resolve))
      toggle()
      await opened
      await pause(80)
      const frontend = wc.devToolsWebContents
      const inspector = BrowserWindow.fromWebContents(frontend)
      const initial = await nativeState()
      assert.deepEqual(initial.order, ['devtools', 'owner'])
      // Simulate the host's late focus restoration after opening DevTools.
      owner.focus()
      const restored = await nativeState('owner')
      assert.deepEqual(restored.order, ['devtools', 'owner'], 'DevTools must remain above the host after its focus restoration')
      assert.equal(inspector.getParentWindow(), owner)
      assert.equal(inspector.isModal(), false)
      assert.equal(inspector.isAlwaysOnTop(), false)
      if (withReferences) {
        await Promise.race([installed, pause(3000).then(() => { throw new Error('reference bridge did not become ready') })])
        for (const width of [640, 390]) {
          view.setBounds({ x: 0, y: 64, width, height: 400 })
          await pause(60)
          const previous = captures.length
          const clicked = await frontend.executeJavaScript(`(async () => {
            const SDK = await import('./core/sdk/sdk.js');
            const Elements = await import('./panels/elements/elements.js');
            const model = SDK.TargetManager.TargetManager.instance().primaryPageTarget().model(SDK.DOMModel.DOMModel);
            const doc = await model.requestDocument();
            const id = await model.querySelector(doc.id, 'h1');
            Elements.ElementsPanel.ElementsPanel.instance().selectDOMNode(model.nodeForId(id), true);
            function all(root) { return [...root.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]) }
            const button = all(document).find(e => e.dataset.synkoraReference === 'button');
            if (!button || button.disabled) return false;
            (button.shadowRoot?.querySelector('button') || button).click();
            return true;
          })()`)
          assert.equal(clicked, true)
          for (let n = 0; n < 60 && captures.length === previous; n++) await pause(20)
          assert.equal(captures.length, previous + 1, errors.join('; '))
          assert.equal(captures.at(-1).element.tag, 'h1')
          assert.equal(captures.at(-1).viewport.width, width)
        }
      }
      const closed = new Promise(resolve => inspector.once('closed', resolve))
      if (withReferences) inspector.close() // Native ×, with the reference bridge still active.
      else toggle()
      await closed
      await pause(50)
      assert.equal(wc.isDestroyed(), false)
      assert.deepEqual(errors, [], 'normal close must not report a broken reference bridge')
      dispose()
      console.log(JSON.stringify({ pass: true, withReferences, initial, afterHostFocus: restored,
        referenceWidths: captures.map(s => s.viewport.width), nativeClose: true }))
    }
  } catch (error) { console.error(error.stack); throw error }
  finally {
    observer.stdin.end('quit\n'); dispose()
    if (!wc.isDestroyed() && wc.devToolsWebContents) toggle()
    await pause(30)
    owner.contentView.removeChildView(view)
    if (!wc.isDestroyed()) wc.close()
    owner.destroy()
  }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async () => (await import('electron')).app.exit(1))
} else {
  if (process.platform !== 'win32') throw new Error('This native ordering probe requires Windows')
  await mkdir(resolve('.tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/devtools-owned-probe-'))
  buildSync({ stdin: { contents: `export { toggleBrowserDevtools } from './browserDevtoolsFocus';
    export { toggleBrowserDevtoolsWindow } from './browserDevtoolsWindow';
    export { installBrowserReferencePicker } from './browserReferencePicker';`, resolveDir: resolve('src/main'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(directory, 'probe.mjs'), external: ['electron'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory, ...process.argv.slice(2)],
    { windowsHide: true, env, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 15000)
  process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)) })
  clearTimeout(timeout)
}

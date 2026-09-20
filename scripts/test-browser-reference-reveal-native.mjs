import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  const { browserReferenceSnapshotInPage, GuiBrowserReferenceStore, createBrowserReferenceRevealer } =
    await import(pathToFileURL(join(directory, 'reveal.mjs')).href)
  const win = new BrowserWindow({ show: false, width: 390, height: 700, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  const wc = win.webContents
  const store = new GuiBrowserReferenceStore()
  const calls = []
  const reveal = createBrowserReferenceRevealer({ references: store,
    identity: () => ({ missionId: 'mission', projectId: 'project' }),
    browser: {
      state: () => ({ projectId: 'project', host: 'dock', visible: true }),
      tabById: (mission, tab) => mission === 'mission' && tab === 'tab' ? { tabId: 'tab', webContents: wc } : undefined,
      selectTab: (...args) => { calls.push(args); return true }
    }
  })
  const run = code => wc.executeJavaScript(code)
  const overlay = () => run('document.querySelectorAll("[data-synkora-reference-highlight]").length')
  const capture = async (expression, frame = wc.mainFrame) => {
    const value = await frame.executeJavaScript(`(${browserReferenceSnapshotInPage.toString()}).call(${expression})`)
    const top = await run('({width:innerWidth,height:innerHeight,devicePixelRatio,scrollX,scrollY})')
    return store.capture('pane', 'mission', 'tab', {
      capturedAt: new Date().toISOString(), url: wc.getURL(), frameUrl: value.frameUrl,
      viewport: top, ...(!value.topFrame ? { frameViewport: value.frameViewport } : {}),
      element: value.element, targetToken: value.targetToken, frameId: 'synthetic-frame', backendNodeId: 1
    })
  }
  try {
    await win.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
      <style>body{margin:24px;background:#f4efe4;color:#302b23;font:16px/1.5 sans-serif}h1{font-size:23px}.gap{height:1400px}button{font:inherit;padding:8px}iframe{width:270px;height:160px}</style>
      <h1>Título parecido</h1><input id="draft" value="Rascunho sintético preservado">
      <div class="gap"></div><h1 id="chosen">Título parecido</h1><button id="action">Ação sintética</button>
      <div id="shadow"></div><iframe id="nested" srcdoc="<style>body{height:1600px}button{margin-top:1000px}</style><button id='inside'>Alvo no quadro</button>"></iframe>
      <div class="gap"></div><script>
        window.clicks=0; document.querySelector('#action').onclick=()=>window.clicks++;
        const host=document.querySelector('#shadow'); const root=host.attachShadow({mode:'closed'});
        const button=document.createElement('button'); button.textContent='Alvo no shadow'; root.append(button); window.syntheticShadowTarget=button;
      </script>`))
    wc.debugger.attach('1.3')
    const original = await capture('document.querySelector("#chosen")')
    const action = await capture('document.querySelector("#action")')
    const shadow = await capture('window.syntheticShadowTarget')
    const child = wc.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')
    assert.ok(child)
    const nested = await capture('document.querySelector("#inside")', child)
    await run('document.querySelector("#draft").focus(); scrollTo(0,0)')
    assert.deepEqual(await reveal('pane', original.id), { ok: true })
    await pause(600)
    assert.equal(await overlay(), 1)
    assert.equal(await run('document.activeElement.id'), 'draft', 'highlight must not take input focus')
    const rect = await run('(() => {const r=document.querySelector("#chosen").getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,y:scrollY}})()')
    assert.ok(rect.y > 1000 && rect.top >= 0 && rect.bottom <= rect.height, JSON.stringify(rect))
    assert.equal(await run('document.querySelector("#draft").value'), 'Rascunho sintético preservado')
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    await writeFile(resolve('.synkora/reports/browser-reference-reveal-mobile.png'), (await wc.capturePage()).toPNG())
    await pause(1750)
    assert.equal(await overlay(), 0, 'highlight removes itself after its animation')

    const before = store.resolve('pane', [original.id])
    assert.deepEqual(await reveal('pane', action.id), { ok: true })
    assert.equal(await run('window.clicks'), 0, 'reveal must not activate a site button')
    assert.deepEqual(await reveal('pane', shadow.id), { ok: true })
    assert.equal(await overlay(), 1, 'new reference replaces the previous highlight')
    assert.equal(await run('document.querySelector("[data-synkora-reference-highlight]").getAttribute("data-synkora-reference-highlight")'), String(shadow.number))
    assert.deepEqual(await reveal('pane', nested.id), { ok: true })
    await pause(600)
    assert.equal(await overlay(), 0, 'switching frames clears the old highlight')
    assert.equal(await child.executeJavaScript('document.querySelectorAll("[data-synkora-reference-highlight]").length'), 1)
    assert.ok(await child.executeJavaScript('scrollY > 800'), 'nested scroller is brought to its element')
    assert.deepEqual(store.resolve('pane', [original.id]), before)
    assert.equal(wc.debugger.isAttached(), true, 'agent debugger remains attached')

    await run('document.querySelector("#chosen").outerHTML = `<h1 id="chosen">Título parecido</h1>`')
    assert.equal((await reveal('pane', original.id)).ok, false, 'same selector and text do not authorize a replacement node')
    assert.equal(await overlay(), 0)
    await run('document.querySelector("#action").style.display="none"')
    assert.match((await reveal('pane', action.id)).error, /oculto/)
    await run('document.querySelector("#action").style.display=""')
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await run('scrollTo(0,0)')
    assert.deepEqual(await reveal('pane', action.id), { ok: true })
    assert.ok(await run('scrollY > 1000'), 'reduced motion jumps directly without smooth scrolling')
    const loaded = new Promise(resolve => wc.once('did-finish-load', resolve))
    wc.reload(); await loaded
    assert.equal((await reveal('pane', action.id)).ok, false, 'navigation expires exact-node handles')
    assert.ok(calls.every(([mission, tab]) => mission === 'mission' && tab === 'tab'))
    console.log('PASS native reference reveal: 390px, scroll, visible animated contour, automatic removal, no focus/text/action changes, exact-node identity, closed shadow, iframe, rapid replacement, hidden target, reduced motion, navigation and independent debugger.')
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else test('native browser reveals the exact reference and removes the temporary highlight', { timeout: 25000 }, async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/browser-reference-reveal-'))
  buildSync({ stdin: { contents: `
    export { browserReferenceSnapshotInPage } from './src/main/browserReferenceSnapshot';
    export { GuiBrowserReferenceStore } from './src/main/guiBrowserReferences';
    export { createBrowserReferenceRevealer } from './src/main/browserReferenceReveal';
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(directory, 'reveal.mjs') })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT
  const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, output)
  console.log(output.trim())
})

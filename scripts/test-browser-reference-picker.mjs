import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const baseline = process.argv.includes('--baseline')
async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const { installBrowserReferencePicker, GuiBrowserReferenceStore, isGuiBrowserReference, createBrowserReferenceRevealer } = baseline
    ? { installBrowserReferencePicker: (_wc, deps) => { deps.onReady(); return () => {} } }
    : await import(pathToFileURL(join(directory, 'picker.mjs')).href)
  const referenceFile = join(directory, 'references.json')
  const referenceStore = GuiBrowserReferenceStore && new GuiBrowserReferenceStore(referenceFile)
  const page = new BrowserWindow({ width: 800, height: 650, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  const inspector = new BrowserWindow({ width: 900, height: 700, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  const wc = page.webContents
  const captures = [], failures = []
  let activePane = 'chat-original', mutateOnStart
  let ready
  const installed = new Promise(resolve => { ready = resolve })
  const dispose = installBrowserReferencePicker(wc, {
    prepare() {
      const destination = activePane
      if (!destination) return undefined
      mutateOnStart?.()
      mutateOnStart = undefined
      return snapshot => {
        const reference = referenceStore.capture(destination, 'synthetic-mission', 'synthetic-tab', snapshot)
        assert.equal(isGuiBrowserReference(reference), true)
        captures.push({ destination, snapshot: reference })
        return { ok: true }
      }
    },
    onError: message => failures.push(message),
    onReady: () => ready()
  })
  try {
    await page.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
      <style>body{margin:8px;font:16px sans-serif}.target{font-size:20px;margin:16px 0;height:28px}input{display:block}</style>
      <h1 id="duplicate" class="target">Mesmo título</h1><div id="outer"><div id="parent"><h1 id="duplicate" class="target second">Mesmo título</h1></div></div>
      <div id="shadow"></div><iframe id="frame" style="width:260px;height:130px" srcdoc="<button id='nested'>Botão no frame</button>"></iframe>
      <input id="password" type="password" value="SYNTHETIC_PASSWORD"><textarea id="draft">SYNTHETIC_FORM_VALUE</textarea>
      <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="inside">Botão no shadow</button>'</script>`))
    wc.debugger.attach('1.3') // The normal browser driver's session must survive.
    wc.setDevToolsWebContents(inspector.webContents)
    const opened = new Promise(resolve => wc.once('devtools-opened', resolve))
    wc.openDevTools({ mode: 'detach', activate: false })
    await opened
    await Promise.race([installed, pause(4000).then(() => { throw new Error('native bridge did not become ready: ' + failures.join('; ')) })])
    await pause(180)
    assert.equal(captures.length, 0, 'opening DevTools must not reference an automatic default selection')
    const pick = async expression => {
      const before = captures.length
      const p = await wc.executeJavaScript(`(() => {const e=${expression}; const r=e.getBoundingClientRect(); const f=e.ownerDocument.defaultView.frameElement?.getBoundingClientRect(); return { x:r.x+5+(f?.x??0)+(f?2:0), y:r.y+5+(f?.y??0)+(f?2:0) };})()`)
      const armed = await inspector.webContents.executeJavaScript(`(() => {
        function all(root){return [...root.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?all(e.shadowRoot):[])])}
        const button=all(document).find(e=>e.tagName==='BUTTON' && /select an element/i.test(e.getAttribute('aria-label')||e.getAttribute('title')||''));
        if(!button)return false; button.click(); return true;
      })()`)
      assert.equal(armed, true, 'must use the real native Select Element button')
      await pause(60)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 })
      await pause(100)
      assert.equal(captures.length, before, 'inspecting an element must leave the reference draft unchanged until the explicit button is pressed')
    }
    const buttonState = async () => inspector.webContents.executeJavaScript(`(() => {
      function all(root){return [...root.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?all(e.shadowRoot):[])])}
      const host=all(document).find(e=>e.getAttribute('data-synkora-reference')==='button');
      const icon=host?.shadowRoot?.querySelector('devtools-icon');
      return host ? {text:host.textContent,disabled:host.disabled,result:host.dataset.referenceResult,
        width:host.getBoundingClientRect().width,height:host.getBoundingClientRect().height,
        label:host.getAttribute('aria-label'),icon:icon?.getAttribute('name'),
        mask:icon?.shadowRoot?.querySelector('span') ? getComputedStyle(icon.shadowRoot.querySelector('span')).maskImage : null} : null;
    })()`)
    const pressButton = async (goParent = false) => inspector.webContents.executeJavaScript(`(async () => {
      const UI=await import('./ui/legacy/legacy.js'); const SDK=await import('./core/sdk/sdk.js'); const Elements=await import('./panels/elements/elements.js');
      function all(root){return [...root.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?all(e.shadowRoot):[])])}
      const host=all(document).find(e=>e.getAttribute('data-synkora-reference')==='button');
      if (!host) return false;
      const button=host.shadowRoot?.querySelector('button') || host;
      if (button.disabled) return false;
      const node=UI.Context.Context.instance().flavor(SDK.DOMModel.DOMNode);
      button.click();
      if (${goParent}) Elements.ElementsPanel.ElementsPanel.instance().selectDOMNode(node.parentNode,true);
      return true;
    })()`)
    const referenceSelected = async (goParent = false) => {
      const before = captures.length
      const previousFailures = failures.length
      const clicked = await pressButton(goParent)
      assert.equal(clicked, true, 'native toolbar must expose an enabled Referenciar no chat button')
      for (let n = 0; n < 60 && captures.length === before && failures.length === previousFailures; n++) await pause(25)
      assert.equal(captures.length, before + 1, 'one explicit click must become exactly one reference: ' + failures.join('; '))
      await pause(40)
      assert.equal((await buttonState()).result, 'success', 'success is shown only after canonical storage confirms the reference')
      assert.equal((await buttonState()).text, '', 'confirmation must remain icon-only, without expanding the toolbar')
      assert.ok((await buttonState()).width <= 32, 'confirmation keeps the compact native icon hit area')
      return captures.at(-1)
    }
    const click = async expression => { await pick(expression); return referenceSelected() }
    const selectParent = async () => inspector.webContents.executeJavaScript(`(async () => {
      const UI=await import('./ui/legacy/legacy.js'); const SDK=await import('./core/sdk/sdk.js'); const Elements=await import('./panels/elements/elements.js');
      const context=UI.Context.Context.instance(); const node=context.flavor(SDK.DOMModel.DOMNode);
      Elements.ElementsPanel.ElementsPanel.instance().selectDOMNode(node.parentNode, true);
      return context.flavor(SDK.DOMModel.DOMNode).getAttribute('id');
    })()`)
    const initialButton = await buttonState()
    assert.equal(initialButton.text, '', 'the reference action must be a compact icon rather than a text button')
    assert.ok(initialButton.width <= 32 && initialButton.height >= 24)
    assert.match(initialButton.label, /Referenciar.*no chat/)
    assert.equal(initialButton.icon, 'select-element')
    assert.match(initialButton.mask, /data:image\/svg\+xml/, 'reference glyph uses its own element-plus drawing')
    const first = await click('document.querySelector(".second")')
    assert.match(first.snapshot.targetToken, /^[0-9a-f]{32}$/, 'native selection must preserve the exact page-node handle')
    assert.equal(first.snapshot.element.tag, 'h1')
    assert.equal(first.snapshot.element.text, 'Mesmo título')
    const targetMatch = await wc.executeJavaScript(`(() => { const matches=document.querySelectorAll(${JSON.stringify(first.snapshot.element.selector)}); return matches.length===1 && matches[0]===document.querySelector('.second'); })()`)
    assert.equal(targetMatch, true, 'duplicate IDs and identical text must still resolve the exact selected node')
    assert.equal(first.snapshot.viewport.width, await wc.executeJavaScript('innerWidth'))
    assert.equal(first.snapshot.viewport.height, await wc.executeJavaScript('innerHeight'))
    const originalWidth = first.snapshot.viewport.width

    page.setContentSize(375, 650)
    await pause(70)
    mutateOnStart = () => { activePane = 'chat-other' }
    const mobile = await click('document.querySelector(".second")')
    assert.equal(mobile.destination, 'chat-original', 'destination is frozen before asynchronous capture')
    assert.equal(mobile.snapshot.number, 2)
    assert.equal(mobile.snapshot.viewport.width, await wc.executeJavaScript('innerWidth'))
    assert.ok(mobile.snapshot.viewport.width < 400)
    assert.equal(first.snapshot.viewport.width, originalWidth, 'older references keep their captured viewport')

    wc.setZoomFactor(375 / 1280)
    await pause(70)
    const desktopInSmallPanel = await click('document.querySelector(".second")')
    assert.ok(desktopInSmallPanel.snapshot.viewport.width > 1200)
    assert.equal(desktopInSmallPanel.snapshot.viewport.width, await wc.executeJavaScript('innerWidth'), 'CSS viewport, not the small host bounds or requested preset')
    wc.setZoomFactor(1)
    await pause(70)
    const shadow = await click('document.querySelector("#shadow").shadowRoot.querySelector("button")')
    assert.equal(shadow.snapshot.element.selectorPath.length, 2)
    assert.equal(shadow.snapshot.element.selectorPath[0], '#shadow')
    assert.equal(shadow.snapshot.element.selector, '#inside')
    const frame = await click('document.querySelector("#frame").contentDocument.querySelector("button")')
    assert.equal(frame.snapshot.element.selector, '#nested')
    assert.ok(frame.snapshot.frameViewport.width < frame.snapshot.viewport.width)
    assert.notEqual(frame.snapshot.frameId, mobile.snapshot.frameId)
    assert.equal(frame.snapshot.viewport.width, await wc.executeJavaScript('innerWidth'))

    const password = await click('document.querySelector("#password")')
    const draft = await click('document.querySelector("#draft")')
    assert.doesNotMatch(JSON.stringify([password, draft]), /SYNTHETIC_PASSWORD|SYNTHETIC_FORM_VALUE/)
    assert.equal(wc.debugger.isAttached(), true, 'native integration must preserve the agent debugger')
    assert.equal(await wc.executeJavaScript('Object.keys(globalThis).some(key=>key.startsWith("synkoraReference_"))'), false, 'the website gets no privileged binding')
    assert.equal(failures.length, 0, failures.join('; '))
    assert.equal(new GuiBrowserReferenceStore(referenceFile).list('chat-original')[1].viewport.width, mobile.snapshot.viewport.width, 'native selection survives canonical store reload')

    const beforeAncestors = captures.length
    await pick('document.querySelector(".second")')
    assert.equal(await selectParent(), 'parent')
    assert.equal(await selectParent(), 'outer')
    assert.equal(captures.length, beforeAncestors, 'walking ancestors must not create intermediate references')
    page.setContentSize(640, 650)
    await pause(70)
    const ancestor = await referenceSelected()
    assert.equal(ancestor.snapshot.element.tag, 'div')
    assert.equal(ancestor.snapshot.element.selector, '#outer')
    assert.equal(ancestor.snapshot.viewport.width, await wc.executeJavaScript('innerWidth'), 'viewport belongs to the button click, after resize, not the initial picker click')
    assert.notEqual(ancestor.snapshot.backendNodeId, mobile.snapshot.backendNodeId)

    await pick('document.querySelector(".second")')
    const heldSelection = await referenceSelected(true)
    assert.equal(heldSelection.snapshot.element.tag, 'h1', 'changing tree selection during capture must not replace the explicitly confirmed node')
    assert.equal(heldSelection.snapshot.backendNodeId, mobile.snapshot.backendNodeId)
    await pause(1600)
    const toolbarGeometry = async () => inspector.webContents.executeJavaScript(`(() => {
      function all(root){return [...root.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?all(e.shadowRoot):[])])}
      const elements=all(document), host=elements.find(e=>e.getAttribute('data-synkora-reference')==='button');
      const select=elements.find(e=>e.tagName==='BUTTON' && /select an element/i.test(e.getAttribute('aria-label')||e.getAttribute('title')||''));
      const r=host.getBoundingClientRect(), s=select.getBoundingClientRect();
      return {left:r.x,right:r.right,top:r.y,height:r.height,selectRight:s.right,selectTop:s.y,viewport:innerWidth};
    })()`)
    let toolbar = await toolbarGeometry()
    assert.ok(Math.abs(toolbar.top - toolbar.selectTop) < 2 && toolbar.left >= toolbar.selectRight && toolbar.left - toolbar.selectRight < 24,
      'the reference button must be directly beside native Select Element, on the same toolbar')
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    await writeFile(resolve('.synkora/reports/browser-reference-devtools-button.png'),
      (await inspector.webContents.capturePage({x:0,y:Math.max(0,Math.floor(toolbar.top)-1),width:Math.min(650,Math.floor(toolbar.viewport)),height:85})).toPNG())
    inspector.setContentSize(390, 500)
    await pause(100)
    toolbar = await toolbarGeometry()
    assert.ok(toolbar.right <= toolbar.viewport && toolbar.height >= 20, 'button remains visible in narrow DevTools')
    await writeFile(resolve('.synkora/reports/browser-reference-devtools-button-narrow.png'),
      (await inspector.webContents.capturePage({x:0,y:Math.max(0,Math.floor(toolbar.top)-1),width:Math.floor(toolbar.viewport),height:85})).toPNG())

    activePane = ''
    const beforeFailure = captures.length
    assert.equal(await pressButton(), true)
    for (let n=0;n<40 && failures.length===0;n++) await pause(25)
    await pause(40)
    assert.equal(captures.length, beforeFailure)
    assert.equal((await buttonState()).result, 'error', 'missing destination must not claim the reference was added')
    assert.equal((await buttonState()).text, '', 'error feedback keeps the toolbar icon-only')
    assert.equal((await buttonState()).width, initialButton.width)
    assert.match(failures.at(-1), /chat desta missão/)
    activePane = 'chat-other'
    await referenceSelected()

    await inspector.webContents.executeJavaScript(`(async()=>{
      const UI=await import('./ui/legacy/legacy.js'); const SDK=await import('./core/sdk/sdk.js');
      UI.Context.Context.instance().setFlavor(SDK.DOMModel.DOMNode,null);
    })()`)
    const disabled = await inspector.webContents.executeJavaScript(`(() => {
      function all(root){return [...root.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?all(e.shadowRoot):[])])}
      const host=all(document).find(e=>e.getAttribute('data-synkora-reference')==='button');
      return Boolean(host?.disabled);
    })()`)
    assert.equal(disabled, true, 'no selected element means the reference action is unavailable')

    dispose()
    const count = captures.length
    await pause(50)
    assert.equal(captures.length, count)
    assert.equal(await buttonState(), null, 'cleanup removes the native action')
    assert.equal(wc.debugger.isAttached(), true, 'cleanup never detaches the agent debugger')
    wc.closeDevTools()
    const reveal = createBrowserReferenceRevealer({ references: referenceStore,
      identity: () => ({ missionId: 'synthetic-mission', projectId: 'synthetic-project' }),
      browser: {
        state: () => ({ projectId: 'synthetic-project', host: 'dock', visible: true }),
        tabById: () => ({ tabId: 'synthetic-tab', webContents: wc }), selectTab: () => true
      }
    })
    for (const capture of [first, shadow, frame]) {
      assert.deepEqual(await reveal(capture.destination, capture.snapshot.id), { ok: true },
        'references created by the native toolbar must still reveal after DevTools closes')
    }
    assert.equal(wc.debugger.isAttached(), true, 'reference replay also preserves the agent debugger')
    console.log('PASS native reference button: inspection and ancestor navigation create no references, explicit current selection, CSS viewport at confirmation, exact duplicate-node identity, shadow DOM, iframe, form privacy, disabled empty selection and independent driver session.')
  } finally { dispose(); inspector.destroy(); page.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => { console.error(error.stack); (await import('electron')).app.exit(1) })
} else {
  test('native DevTools button references the selected element and viewport when the owner confirms', { timeout: 35000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/browser-reference-test-'))
    if (!baseline) buildSync({ stdin: { contents: `
      export { installBrowserReferencePicker } from './browserReferencePicker';
      export { GuiBrowserReferenceStore } from './guiBrowserReferences';
      export { isGuiBrowserReference } from './guiBrowserReferenceTypes';
      export { createBrowserReferenceRevealer } from './browserReferenceReveal';
    `, resolveDir: resolve('src/main'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(directory, 'picker.mjs'), external: ['electron'] })
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory, ...(baseline ? ['--baseline'] : [])], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}

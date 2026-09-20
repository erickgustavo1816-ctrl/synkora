import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const scrub = text => text.replace(/http:\/\/127\.0\.0\.1:\d+\/__synkora_preview\/[^\s<>"'`]+/giu, '[synthetic-preview]')
  .replace(/\/__synkora_preview\/[^\s<>"'`]*/giu, '/[synthetic-preview]')

function syntheticWav() {
  const wav = Buffer.alloc(44 + 16000)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(16000, 40)
  return wav
}

async function inspect() {
  const { app, BrowserWindow, ipcMain, session } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const modules = await import(pathToFileURL(join(directory, 'main.mjs')))
  const { createBrowserManager, electronBrowserViewHost, browserPartitionFor, GuiFileResolver,
    GUI_BROWSER_FILE_MIME, GuiArtifactPreviewServer, createGuiFileBrowserOpener, prepareGuiFileOpen } = modules
  const root = join(directory, 'worktree')
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'one')); await mkdir(join(root, 'two'))
  const html = `<!doctype html><meta charset="utf-8"><title>Prévia sintética</title>
    <link rel="stylesheet" href="assets/style.css"><script src="assets/app.js" defer></script>
    <h1 id="title">Uma página aberta no Synkora</h1><p id="status">Carregando</p>
    <img id="art" src="assets/icon.svg" alt="Forma sintética"><a href="#details" id="jump">Ver detalhes</a>
    <div style="height:700px"></div><h2 id="details">Detalhes</h2>`
  await writeFile(join(root, 'landing.html'), html)
  await writeFile(join(root, 'app.ts'), 'export const synthetic = true')
  await writeFile(join(root, 'manual.pdf'), '%PDF synthetic unsupported private-session fixture')
  await writeFile(join(root, 'sound.wav'), syntheticWav())
  await writeFile(join(root, 'one', 'duplicate.html'), '<title>Primeira escolha sintética</title><p>Um</p>')
  await writeFile(join(root, 'two', 'duplicate.html'), '<title>Segunda escolha sintética</title><p>Dois</p>')
  await writeFile(join(root, 'assets', 'style.css'), 'body{margin:48px;background:#efe9dc;font:18px/1.5 sans-serif}h1{color:rgb(31,90,55);font-size:32px}img{display:block;width:120px;height:80px;margin:24px 0}')
  await writeFile(join(root, 'assets', 'app.js'), 'window.fixtureReady=true;document.querySelector("#status").textContent="CSS, JavaScript e imagem carregados."')
  await writeFile(join(root, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" rx="14" fill="#1f5a37"/></svg>')

  const nativeWindows = []
  const disposedPartitions = []
  const cleanupHost = electronBrowserViewHost(() => null)
  const host = {
    create(partition) {
      const win = new BrowserWindow({ show: false, width: 900, height: 650, useContentSize: true,
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
          offscreen: true, backgroundThrottling: false, disableDialogs: true,
          autoplayPolicy: 'document-user-activation-required' } })
      nativeWindows.push(win)
      let visible = true
      return { webContents: win.webContents, setBounds: bounds => {
        if (!win.isDestroyed() && bounds.width > 0 && bounds.height > 0) win.setContentSize(bounds.width, bounds.height)
      }, setVisible: value => { visible = value }, getVisible: () => visible }
    },
    attach() {}, detach() {}, contentSize: () => ({ width: 1000, height: 750 }),
    windowVisible: () => true, watchWindow: () => () => {},
    hardenSession(partition) { session.fromPartition(partition).on('will-download', event => event.preventDefault()) },
    disposeEphemeralSession(partition) { disposedPartitions.push(partition); cleanupHost.disposeEphemeralSession(partition) }
  }
  let popout
  const browser = createBrowserManager({ window: () => null, host, record: () => {}, push: () => {},
    popouts: { open(missionId) { popout = { missionId, attach() {}, detach() {}, contentSize: () => ({ width: 900, height: 650 }),
      visible: () => true, focus() {}, setTitle() {} }; return popout }, get: () => popout,
      close() { popout = undefined }, closeAll() { popout = undefined } } })
  browser.setDockMission('synthetic-mission')
  browser.applyBounds('synthetic-mission', { x: 0, y: 0, width: 900, height: 650 }, true, 'dock')
  const resolver = new GuiFileResolver()
  const previews = new GuiArtifactPreviewServer({ resolver, entryMime: GUI_BROWSER_FILE_MIME })
  const openArtifact = createGuiFileBrowserOpener({ browser, previews,
    identity: () => ({ cwd: root, projectId: 'synthetic-project', missionId: 'synthetic-mission' }) })
  const calls = []
  ipcMain.handle('fixture:fileOpen', async (_event, paneId, reference, selectedPath, mode) => {
    calls.push({ paneId, reference, selectedPath, mode })
    const resolved = resolver.resolve(root, reference, selectedPath)
    if (!resolved.ok) return resolved
    const prepared = prepareGuiFileOpen(resolved.file, mode)
    return prepared.ok && prepared.action === 'browser' ? openArtifact(paneId, prepared.file) : prepared
  })
  ipcMain.handle('fixture:popOut', (_event, missionId) => browser.popOut(missionId))
  const chat = new BrowserWindow({ show: false, width: 1000, height: 750, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false,
      preload: join(directory, 'preload.cjs') } })
  const run = script => chat.webContents.executeJavaScript(script)
  const until = async (fn, message) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) { if (await fn()) return; await pause(25) }
    throw new Error(message)
  }
  try {
    // A normal project tab establishes the synthetic pre-existing cookie.
    // Cookies ignore ports: a project-session preview would inherit this.
    await browser.newTab('synthetic-mission', 'synthetic-project', 'about:blank')
    const ordinarySession = session.fromPartition(browserPartitionFor('synthetic-project'))
    await ordinarySession.cookies.set({ url: 'http://127.0.0.1:9', name: 'syntheticLocalSession', value: 'fixture-only', path: '/' })
    await chat.loadFile(join(directory, 'index.html'))
    await until(() => run('document.querySelectorAll("button[data-gui-file-token]").length >= 3'), 'chat tokens did not mount')
    await run('document.querySelector("[data-gui-file-token=\\"landing.html\\"]").click()')
    await until(() => run('window.fixturePanels.includes("browser")'), 'successful click did not reveal the Browser panel')
    assert.equal(calls[0].mode, 'auto')
    const firstTab = browser.state('synthetic-mission').tabs.find(tab => tab.active)
    assert.equal(firstTab.owner.kind, 'user')
    const first = browser.tabById('synthetic-mission', firstTab.tabId).webContents
    const firstSession = first.session
    await until(() => first.executeJavaScript('window.fixtureReady === true && document.querySelector("#art").naturalWidth === 120'), 'relative CSS/JS/image did not finish loading')
    assert.equal(await first.executeJavaScript('getComputedStyle(document.querySelector("#title")).color'), 'rgb(31, 90, 55)')
    assert.equal(await first.executeJavaScript('document.querySelector("#status").textContent'), 'CSS, JavaScript e imagem carregados.')
    const cookieUrl = first.getURL()
    assert.equal((await ordinarySession.cookies.get({ url: cookieUrl, name: 'syntheticLocalSession' })).length, 1)
    assert.equal(await first.executeJavaScript('document.cookie.includes("syntheticLocalSession")'), false,
      'artifact inherited a normal project cookie across localhost ports')
    assert.notEqual(first.session, ordinarySession)
    assert.equal(first.session.isPersistent(), false)
    await first.executeJavaScript('document.cookie="artifactOnly=fixture; path=/"')
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    await writeFile(resolve('.synkora/reports/gui-artifact-preview-synthetic.png'), (await first.capturePage()).toPNG())
    await first.executeJavaScript('document.querySelector("#jump").click()')
    assert.equal(await first.executeJavaScript('location.hash'), '#details', 'intra-page links remain usable')

    // The same private session stays attached when the owner changes host.
    assert.equal(browser.popOut('synthetic-mission').ok, true)
    assert.equal(browser.tabById('synthetic-mission', firstTab.tabId).webContents.session, first.session)
    assert.equal(browser.dockBack('synthetic-mission', 'gesture').ok, true)
    assert.equal(browser.tabById('synthetic-mission', firstTab.tabId).webContents.session, first.session)

    const rightClick = token => run(`document.querySelector('[data-gui-file-token="${token}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:90,clientY:90}))`)
    const menuClick = label => run(`[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.includes(${JSON.stringify(label)})).click()`)
    await rightClick('landing.html')
    await until(() => run('!!document.querySelector("[role=menu]")'), 'context menu did not open')
    assert.equal(await run('document.querySelector("[role=menu]").textContent.includes("Abrir no browser do Synkora")'), true)
    await menuClick('Ler código no app')
    await until(() => run('!!document.querySelector(".gui-file-preview pre")'), 'explicit code reader did not open')
    assert.equal(calls.at(-1).mode, 'preview')
    assert.equal(await run('document.querySelector(".gui-file-preview pre").textContent.includes("<!doctype html>")'), true)
    const tabsBeforeCode = browser.state('synthetic-mission').tabs.length
    await run('document.querySelector("[data-gui-file-token=\\"app.ts\\"]").click()')
    await until(() => run('document.querySelector(".gui-file-preview pre")?.textContent.includes("synthetic = true")'), 'source-file click did not stay in reader')
    assert.equal(browser.state('synthetic-mission').tabs.length, tabsBeforeCode)

    await rightClick('duplicate.html')
    await until(() => run('!!document.querySelector("[role=menu]")'), 'duplicate menu did not open')
    await menuClick('Abrir no browser do Synkora')
    await until(() => run('document.querySelectorAll(".gui-file-choice").length === 2'), 'ambiguous file did not ask for exact relative choice')
    assert.equal(calls.at(-1).mode, 'browser')
    await run('document.querySelectorAll(".gui-file-choice")[1].click()')
    await until(() => run('!document.querySelector(".gui-file-choices")'), 'selected file did not open')
    assert.equal(calls.at(-1).mode, 'browser')
    assert.equal(calls.at(-1).selectedPath, 'two/duplicate.html')
    const secondTab = browser.state('synthetic-mission').tabs.find(tab => tab.active)
    const second = browser.tabById('synthetic-mission', secondTab.tabId).webContents
    assert.equal(await second.executeJavaScript('document.title'), 'Segunda escolha sintética')
    assert.equal(await second.executeJavaScript('document.cookie.includes("artifactOnly")'), false)
    assert.notEqual(second.session, first.session)
    browser.closeTab('synthetic-mission', firstTab.tabId)
    await until(async () => (await firstSession.cookies.get({ url: cookieUrl, name: 'artifactOnly' })).length === 0, 'artifact session data not cleared after close')
    assert.ok(disposedPartitions.length >= 1)
    assert.equal((await ordinarySession.cookies.get({ url: cookieUrl, name: 'syntheticLocalSession' })).length, 1,
      'closing an artifact must preserve the normal project session')
    const mediaResult = await openArtifact('synthetic-pane', resolver.resolve(root, 'sound.wav').file)
    assert.equal(mediaResult.ok, true)
    const media = browser.tabById('synthetic-mission', mediaResult.tabId).webContents
    await until(() => media.executeJavaScript('(()=>{const player=document.querySelector("audio,video");return !!player && player.readyState>=1 && player.duration===1})()'), 'native media player did not decode the synthetic WAV')
    assert.equal(prepareGuiFileOpen(resolver.resolve(root, 'manual.pdf').file).action, 'reveal',
      'PDF must retain its established fallback while native viewing in private sessions is unsupported')
    console.log('PASS isolated Chromium: default HTML click and visible panel request, explicit browser/code menu, source reader, preserved ambiguous mode, relative CSS/JS/SVG, same-page anchor, native WAV decoding, owner tab, private nonpersistent cookies, popout/dock session continuity and cleanup.')
  } finally {
    previews.close(); browser.destroy()
    if (!chat.isDestroyed()) chat.destroy()
    for (const win of nativeWindows) if (!win.isDestroyed()) win.destroy()
  }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(scrub(error.stack ?? String(error))); (await import('electron')).app.exit(1)
  })
} else test('isolated Chromium opens chat artifacts with working assets and private browser sessions', { timeout: 30000 }, async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/gui-artifact-native-'))
  await build({ stdin: { contents: `
    export { createBrowserManager, electronBrowserViewHost, browserPartitionFor } from './src/main/browserPane';
    export { GuiFileResolver, GUI_BROWSER_FILE_MIME, prepareGuiFileOpen } from './src/main/guiFileResolver';
    export { GuiArtifactPreviewServer } from './src/main/guiFileBrowserPreview';
    export { createGuiFileBrowserOpener } from './src/main/guiFileBrowserOpen';
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', external: ['electron'], outfile: join(directory, 'main.mjs') })
  await writeFile(join(directory, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('synkora', {gui:{fileOpen:(...args)=>ipcRenderer.invoke('fixture:fileOpen',...args)},
      browser:{popOut:mission=>ipcRenderer.invoke('fixture:popOut',mission)}});`)
  await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import GuiMarkdown from './src/renderer/src/components/GuiMarkdown';
    import { WorkspacePanelContext } from './src/renderer/src/workspace/WorkspacePanelContext';
    window.fixturePanels=[]; window.fixtureState={missionTabByProject:{'synthetic-project':'synthetic-mission'}};
    const context={projectId:'synthetic-project',visible:true,controller:{openPanel:id=>window.fixturePanels.push(id)}};
    createRoot(document.querySelector('#root')).render(<WorkspacePanelContext.Provider value={context}>
      <GuiMarkdown paneId="synthetic-pane" text={'landing.html app.ts duplicate.html'} />
    </WorkspacePanelContext.Provider>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(directory, 'ui.js'), plugins: [{ name: 'fixture-store', setup(builder) {
      builder.onResolve({ filter: /^(?:\.\.\/|\.\/)store$/ }, () => ({ path: 'fixture-store', namespace: 'fixture-store' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture-store' }, () => ({ contents: 'export const useStore = Object.assign(selector => selector(window.fixtureState), { getState: () => window.fixtureState });', loader: 'js' }))
    } }] })
  await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="ui.js"></script>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT
  const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  assert.equal(code, 0, scrub(output)); console.log(scrub(output.trim()))
})

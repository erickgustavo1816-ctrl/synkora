import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const compiled = buildSync({
  stdin: { contents: `export * from './src/renderer/src/guiMessageQueue'`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false
})
const loaded = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const queue = loaded.exports
const reference = (number, width = 375) => ({
  id: `browser-reference-00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  number, missionId: 'synthetic-mission', tabId: 'synthetic-tab', capturedAt: '2026-09-09T10:00:00.000Z',
  url: 'https://synthetic.example/page', frameUrl: 'https://synthetic.example/page',
  viewport: { width, height: 667, devicePixelRatio: 1, scrollX: 0, scrollY: 120 },
  element: { tag: 'h1', selector: '#title', text: 'Título sintético', bounds: { x: 20, y: 45, width: 220, height: 40 } },
  backendNodeId: 7, frameId: 'synthetic-frame'
})
const storage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}

if (!process.versions.electron) {
test('queued browser references retain immutable selection and actual mobile/desktop viewport', () => {
  const disk = storage()
  const refs = [reference(1), reference(3, 1280)]
  const input = { id: 'synthetic-message', text: 'Referência 1: ajustar o título.', at: 1,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [], browserReferences: refs }
  assert.equal(queue.writeGuiQueuedMessage('synthetic-pane', input, disk), true)
  refs[0].viewport.width = 999
  const saved = queue.readGuiQueuedMessage('synthetic-pane', disk)
  assert.deepEqual(saved.browserReferences.map(ref => [ref.number, ref.viewport.width]), [[1, 375], [3, 1280]])
  const claimed = queue.claimGuiQueuedMessage('synthetic-pane', 'owner', disk, 2)
  assert.deepEqual(claimed.browserReferences, saved.browserReferences)
  claimed.browserReferences[0].element.selector = '#changed'
  assert.equal(queue.readGuiQueuedMessage('synthetic-pane', disk).browserReferences[0].element.selector, '#title')
})

test('reference-only guidance survives queue retry without renumbering', () => {
  const disk = storage(), ref = reference(7)
  const input = { id: 'synthetic-reference-only', text: '', at: 1,
    options: { model: null, effort: null, permissionMode: 'default' }, attachments: [], browserReferences: [ref] }
  assert.equal(queue.writeGuiQueuedMessage('synthetic-pane', input, disk), true)
  const claimed = queue.claimGuiQueuedMessage('synthetic-pane', 'owner', disk, 2)
  const restored = queue.releaseGuiQueuedMessageClaim('synthetic-pane', 'owner', claimed, 'Falha sintética', disk)
  assert.deepEqual(restored.browserReferences, [ref])
  assert.equal(restored.deliveryInFlight, undefined)
})

test('real composer preserves selection, narrow layout, removal and concurrent submission snapshots', { timeout: 30000 }, async t => {
  await mkdir(resolve('.tmp'), { recursive: true })
  await mkdir(resolve('.synkora/reports'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/browser-reference-ui-'))
  buildSync({ stdin: { contents: `
    import { createRoot } from 'react-dom/client'
    import GuiPane from './components/GuiPane'
    import { installDevMock } from './devMock'
    import { useStore } from './store'
    installDevMock()
    const paneId = 'gui-synthetic-reference'
    const ready = { type: 'ready', caps: { models: [{ value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }], commands: [] } }
    let pending = ${JSON.stringify([reference(1), reference(3, 1280)])}
    let ack, removeFails = false, revealFails = false, mountKey = 0
    const listeners = new Set(), sent = [], consumed = [], forced = [], revealed = []
    const clone = value => structuredClone(value)
    const emit = () => { for (const callback of listeners) callback({ paneId, references: clone(pending) }) }
    const result = () => ({ ok: true, references: clone(pending) })
    Object.assign(window.synkora.gui, {
      state: async () => ({ exists: true, alive: true, cursor: 1, events: [{ seq: 1, evt: ready }] }),
      send: async (pane, text, id, attachments, browserReferences) => {
        sent.push(clone({ pane, text, id, attachments, browserReferences }))
        return new Promise(resolve => { ack = resolve })
      },
      forceOwnerMessage: async (pane, id) => { forced.push(id); return { ok: true } },
      browserReferencesList: async () => result(),
      revealBrowserReference: async (pane, id) => {
        revealed.push({ pane, id }); return revealFails ? { ok: false, error: 'Elemento sintético removido da página.' } : { ok: true }
      },
      removeBrowserReference: async (pane, id) => {
        if (removeFails) return { ok: false, references: clone(pending), error: 'Falha sintética ao remover' }
        pending = pending.filter(ref => ref.id !== id); emit(); return result()
      },
      consumeBrowserReferences: async (pane, ids) => {
        consumed.push(ids); pending = pending.filter(ref => !ids.includes(ref.id)); emit(); return result()
      },
      onBrowserReferencesChanged: callback => { listeners.add(callback); return () => listeners.delete(callback) }
    })
    const root = createRoot(document.getElementById('root'))
    const render = () => root.render(<div className="fixture-chat" style={{ width: 375, height: '100%', display: 'flex' }}>
      <GuiPane key={mountKey} paneId={paneId} projectId="synthetic" cli="codex" cwd="synthetic" model="gpt-5.6-sol" permissionMode="bypass" showHeader={false} />
    </div>)
    window.referenceFixture = {
      select: ref => { pending.push(clone(ref)); emit() },
      ack: value => { if (!ack) throw new Error('No pending send'); const resolve = ack; ack = undefined; resolve(value) },
      event: evt => useStore.getState().handleGuiLive(paneId, evt),
      sent: () => clone(sent), consumed: () => clone(consumed), forced: () => clone(forced),
      revealed: () => clone(revealed),
      revealFails: value => { revealFails = value },
      pending: () => clone(pending), removeFails: value => { removeFails = value },
      remount: () => { mountKey++; render() }
    }
    render()
  `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
  const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Browser reference fixture</title><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>`)
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.NODE_TEST_CONTEXT
  const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  assert.equal(code, 0, output)
  console.log(output.trim())
})
} else {
  inspectComposer().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
}

async function inspectComposer() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 800, height: 760, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async (code, label = code) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await run(code)) return
      await pause(50)
    }
    throw new Error('Timed out: ' + label)
  }
  const refNumbers = () => run(`Array.from(document.querySelectorAll('.gui-composer-attachments .gui-browser-reference')).map(el => Number(el.dataset.referenceNumber))`)
  const type = async value => {
    await run(`(() => { const el = document.querySelector('.gui-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await pause(60)
  }
  const click = async selector => { await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await pause(80) }
  try {
    await win.loadFile(join(directory, 'index.html'))
    await waitFor(`document.querySelectorAll('.gui-composer-attachments .gui-browser-reference').length === 2`)
    await waitFor(`!document.querySelector('.gui-send').disabled`)
    assert.deepEqual(await refNumbers(), [1, 3])
    await type('Referência 1: ajustar aqui.')
    assert.equal(await run(`Boolean(document.querySelector('[aria-label="Mostrar referência 1 na página"]'))`), true,
      'references need a distinct action to reveal the selected element')
    await click('[aria-label="Mostrar referência 1 na página"]')
    assert.deepEqual(await run('window.referenceFixture.revealed()'), [{ pane: 'gui-synthetic-reference', id: reference(1).id }])
    assert.deepEqual(await refNumbers(), [1, 3])
    assert.equal(await run(`document.querySelector('.gui-input').value`), 'Referência 1: ajustar aqui.')
    await run('window.referenceFixture.revealFails(true)')
    await click('[aria-label="Mostrar referência 3 na página"]')
    assert.match(await run(`document.querySelector('.gui-browser-reference-feedback').textContent`), /Elemento sintético removido/)
    assert.deepEqual(await refNumbers(), [1, 3])
    await run('window.referenceFixture.revealFails(false)')
    await click('[aria-label="Mostrar referência 3 na página"]')
    assert.equal(await run(`document.querySelector('.gui-browser-reference-feedback') === null`), true)
    await click('[aria-label="Remover referência 1"]')
    assert.deepEqual(await refNumbers(), [3])
    await run(`document.querySelector('.gui-input').focus()`)
    const mobile = { ...reference(4), element: { ...reference(4).element, text: '<img src=x onerror=alert(1)> Título do celular' } }
    await run(`window.referenceFixture.select(${JSON.stringify(mobile)})`)
    await pause(60)
    assert.equal(await run(`document.activeElement === document.querySelector('.gui-input')`), true)
    assert.equal(await run(`document.querySelectorAll('.gui-browser-reference img').length`), 0)
    assert.deepEqual(await refNumbers(), [3, 4])
    await click('.gui-browser-reference summary')
    await type('Referência 3: ajuste no desktop. Referência 4: ajuste no celular.\n'.repeat(8))
    const layout = await run(`(() => { const c = document.querySelector('.gui-composer-inner'), r = c.getBoundingClientRect(); return { width: c.clientWidth, scrollWidth: c.scrollWidth, overflow: Array.from(c.querySelectorAll('.gui-browser-reference')).some(el => el.getBoundingClientRect().right > r.right + 1) } })()`)
    assert.equal(layout.overflow, false)
    assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout))
    await writeFile(resolve('.synkora/reports/browser-reference-composer-375.png'), (await win.webContents.capturePage()).toPNG())
    await type('Referência 3: desktop. Referência 4: celular.')
    await click('.gui-browser-reference summary')
    await writeFile(resolve('.synkora/reports/browser-reference-composer-references.png'), (await win.webContents.capturePage()).toPNG())
    await click('.gui-send')
    await waitFor(`window.referenceFixture.sent().length === 1`)
    const sent = await run(`window.referenceFixture.sent()[0]`)
    assert.deepEqual(sent.browserReferences.map(ref => [ref.number, ref.viewport.width]), [[3, 1280], [4, 375]])
    await run(`window.referenceFixture.select(${JSON.stringify(reference(5, 768))})`)
    await type('Nova mensagem escrita durante a confirmação')
    await run(`window.referenceFixture.ack({ ok: true })`)
    await waitFor(`window.referenceFixture.consumed().length === 1`)
    assert.deepEqual(await refNumbers(), [5])
    assert.equal(await run(`document.querySelector('.gui-input').value`), 'Nova mensagem escrita durante a confirmação')
    assert.equal(await run(`document.querySelectorAll('.gui-msg.user .gui-browser-reference').length`), 2)
    const consumedBeforeReveal = await run('window.referenceFixture.consumed().length')
    await click('.gui-msg.user [aria-label="Mostrar referência 3 na página"]')
    assert.equal(await run('window.referenceFixture.revealed().at(-1).pane'), 'gui-synthetic-reference')
    assert.equal(await run('window.referenceFixture.consumed().length'), consumedBeforeReveal)
    await run(`window.referenceFixture.event({ type: 'result', isError: false, outcome: 'completed', turnActive: false })`)
    await pause(60)
    await click('.gui-send')
    await waitFor(`window.referenceFixture.sent().length === 2`)
    await run(`window.referenceFixture.ack({ ok: false, error: 'Falha sintética de envio' })`)
    await waitFor(`!document.querySelector('.gui-send').disabled`)
    assert.deepEqual(await refNumbers(), [5])
    assert.equal(await run(`document.querySelector('.gui-input').value`), 'Nova mensagem escrita durante a confirmação')
    assert.equal(await run(`window.referenceFixture.consumed().length`), 1)
    await run(`window.referenceFixture.removeFails(true)`)
    await click('[aria-label="Remover referência 5"]')
    assert.deepEqual(await refNumbers(), [5])
    assert.match(await run(`document.querySelector('.gui-attach-error').textContent`), /Falha sintética ao remover/)
    await run(`window.referenceFixture.removeFails(false); window.referenceFixture.remount()`)
    await waitFor(`document.querySelector('.gui-composer-attachments [data-reference-number="5"]')`)
    assert.deepEqual(await refNumbers(), [5])
    await run(`window.referenceFixture.event({ type: 'turn-started' })`)
    await pause(60)
    await click('.gui-send')
    await waitFor(`document.querySelector('.gui-queued-message')`)
    await waitFor(`document.querySelectorAll('.gui-composer-attachments .gui-browser-reference').length === 0`)
    assert.match(await run(`document.querySelector('.gui-queued-message').textContent`), /Referência 5/)
    assert.match(await run(`document.querySelector('.gui-queued-message').textContent`), /768 × 667 px/)
    await click('.gui-queued-message [aria-label="Mostrar referência 5 na página"]')
    assert.equal(await run('window.referenceFixture.revealed().at(-1).id'), reference(5).id)
    assert.equal(await run('window.referenceFixture.forced().length'), 0, 'revealing a queued reference must not submit it')
    await click('.gui-queued-message .gui-owner-force')
    await waitFor(`window.referenceFixture.sent().length === 3`)
    assert.deepEqual(await run(`window.referenceFixture.sent()[2].browserReferences.map(ref => [ref.number, ref.viewport.width])`), [[5, 768]])
    await run(`window.referenceFixture.ack({ ok: true })`)
    await waitFor(`window.referenceFixture.forced().length === 1`)
    console.log('PASS real GuiPane: stable labels, actual CSS viewport, escaped page text, narrow layout, focus, removal, concurrent ACK, failed send, pending recovery, queued snapshot and read now.')
  } finally { win.destroy() }
}

if (!process.versions.electron) test('invalid or duplicate reference snapshots never become a visible queued envelope', () => {
  for (const refs of [[reference(1), reference(1)], [{ ...reference(1), viewport: { width: NaN } }]]) {
    assert.equal(queue.writeGuiQueuedMessage('synthetic-pane', { id: 'synthetic-message', text: 'Ajuste.', at: 1,
      options: { model: null, effort: null, permissionMode: 'default' }, attachments: [], browserReferences: refs }, storage()), false)
  }
})

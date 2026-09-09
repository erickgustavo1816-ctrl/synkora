import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function inspectLayout() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 1600, height: 940, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const run = code => win.webContents.executeJavaScript(code)
  const action = async (method, ...args) => {
    await run(`window.workspaceHarness[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
    await pause(420)
  }
  const bounds = selector => run(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  })()`)
  const read = () => run(`(() => {
    const grid = document.querySelector('.workspace-panel-grid');
    const deck = document.querySelector('.workspace-panel-deck');
    const chat = document.querySelector('.maestro-window');
    const box = el => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
    return { deck: box(deck), chat: box(chat), grid: box(grid), scrollWidth: grid.scrollWidth, clientWidth: grid.clientWidth,
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      overlay: deck.classList.contains('is-overlay'), covered: chat.inert,
      preference: window.workspaceHarness.preference,
      panels: Object.fromEntries([...document.querySelectorAll('.workspace-panel[aria-hidden="false"]')].map(el => [el.dataset.workspacePanel, box(el)])) };
  })()`)
  const noOverflow = state => {
    assert.ok(state.scrollWidth <= state.clientWidth + 1, `grid overflow: ${JSON.stringify(state)}`)
    assert.ok(state.pageWidth <= state.viewportWidth, 'the page must not scroll horizontally')
    for (const panel of Object.values(state.panels)) {
      assert.ok(panel.left >= state.grid.left - 1 && panel.right <= state.grid.right + 1, 'each panel fits inside the grid')
    }
  }
  const fitted = state => {
    noOverflow(state)
    assert.equal(state.overlay, false)
    assert.equal(state.covered, false)
    assert.ok(state.chat.width >= 419 && state.chat.width <= 421, `chat minimum: ${state.chat.width}`)
    assert.ok(state.deck.left >= state.chat.right + 11, 'panels must clear the chat and composer')
  }
  const doubleClick = async selector => {
    const box = await bounds(selector)
    const point = { x: Math.round(box.x + Math.min(90, box.width / 2)), y: Math.round(box.y + box.height / 2) }
    for (const clickCount of [1, 2]) {
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount })
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount })
    }
    await pause(450)
  }
  const key = async (label, keyCode) => {
    await run(`document.querySelector('[role="separator"][aria-label=${JSON.stringify(label)}]').focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await pause(300)
  }
  const smoothFit = async (selector, id) => {
    const before = await read()
    await run(`(() => {
      window.workspaceMotionTrace = [];
      document.querySelector(${JSON.stringify(selector)}).addEventListener('dblclick', () => {
        const start = performance.now();
        const sample = () => {
          const panel = document.querySelector('[data-workspace-panel="${id}"]');
          const box = panel.getBoundingClientRect();
          const chat = document.querySelector('.maestro-window');
          const top = document.elementFromPoint(box.left + 12, box.top + box.height / 2);
          window.workspaceMotionTrace.push({ time: performance.now() - start, width: box.width,
            onTop: top?.closest('.workspace-panel') === panel, overlapping: box.left < chat.getBoundingClientRect().right,
            covered: chat.inert });
          if (performance.now() - start < 300) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { once: true });
    })()`)
    await doubleClick(selector)
    const after = await read()
    const trace = await run('window.workspaceMotionTrace')
    const min = Math.min(before.panels[id].width, after.panels[id].width)
    const max = Math.max(before.panels[id].width, after.panels[id].width)
    const middle = trace.filter(frame => frame.width > min + 1 && frame.width < max - 1)
    assert.ok(middle.length >= 2, `fit must animate intermediate widths: ${JSON.stringify(trace)}`)
    assert.ok(middle.every(frame => frame.onTop), `the shrinking panel must remain visible above the chat: ${JSON.stringify(trace)}`)
    assert.ok(middle.filter(frame => frame.overlapping).every(frame => frame.covered), 'the chat remains inert until the shrinking overlay clears it')
    fitted(after)
  }
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(300)
    await action('openPanel', 'browser')
    assert.equal((await read()).panels.browser.width, 360)
    await smoothFit('[data-workspace-panel="browser"] .workspace-panel-head', 'browser')
    fitted(await read())
    await action('setColumnWidth', 1300)
    assert.equal((await read()).overlay, true)
    await smoothFit('[data-workspace-panel="browser"] .workspace-panel-head', 'browser')
    fitted(await read())
    await action('setColumnWidth', 360)
    await action('setRowSplit', 0, 71)
    await action('openPanel', 'frota')
    let state = await read()
    assert.ok(Math.abs(state.panels.browser.height - state.panels.frota.height) < 1, 'second panel opens at half height')
    await action('openPanel', 'trabalho')
    state = await read()
    assert.equal(state.panels.trabalho.width, 360)
    assert.ok(state.panels.trabalho.left > state.panels.browser.right, 'third panel opens on the right')
    noOverflow(state)

    const grip = await bounds('.workspace-panels-resizer')
    const point = { x: Math.round(grip.x + grip.width / 2), y: Math.round(grip.y + grip.height / 2) }
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x - 160, y: point.y, button: 'left' })
    await pause(80)
    noOverflow(await read())
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x - 160, y: point.y, button: 'left' })
    await pause(300)
    assert.equal((await read()).panels.browser.width, 520, 'pointer drag resizes the first column')
    await key('Largura de Browser e Frota', 'End')
    state = await read()
    noOverflow(state)
    assert.equal(state.panels.trabalho.width, 360)
    await key('Largura de Trabalho', 'End')
    state = await read()
    noOverflow(state)
    assert.equal(state.panels.browser.width, 360)
    assert.ok(state.panels.trabalho.width > 360)
    await smoothFit('[data-workspace-panel="trabalho"] .workspace-panel-head', 'trabalho')
    fitted(await read())
    await action('openPanel', 'historico')
    state = await read()
    assert.ok(Math.abs(state.panels.trabalho.height - state.panels.historico.height) < 1)
    await writeFile(resolve('.synkora/reports/workspace-panel-layout-2026-09-08.png'), (await win.webContents.capturePage()).toPNG())

    for (const width of [1300, 1000, 800, 1600]) {
      win.setContentSize(width, 940)
      await pause(450)
      fitted(await read())
    }
    await action('movePanel', 'historico', { panel: 'trabalho', edge: 'right' })
    await action('movePanel', 'frota', { panel: 'browser', edge: 'right' })
    await doubleClick('[data-workspace-panel="browser"] .workspace-panel-head')
    fitted(await read())
    for (const width of [1200, 900, 700]) {
      win.setContentSize(width, 760)
      await pause(450)
      fitted(await read())
    }
    console.log('Real Chromium layout passed: minimum opening, 50/50 rows, right column, pointer drag, shared bounds, double click and 4-column responsive fit.')
    win.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error.stack)
    try { console.error(JSON.stringify(await read())) } catch { /* fixture may have failed to load */ }
    win.destroy()
    app.exit(1)
  }
}

if (process.versions.electron) {
  inspectLayout().catch(async error => {
    console.error(error.stack)
    const { app } = await import('electron')
    app.exit(1)
  })
} else {
  test('workspace panels fit their real Chromium grid with the production CSS', { timeout: 45000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/workspace-panel-layout-'))
    await mkdir(join(directory, 'profile'))
    buildSync({ entryPoints: ['scripts/harness/workspace-panels.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    const panelsCss = pathToFileURL(resolve('src/renderer/src/workspace/workspacePanels.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Workspace panel fixture</title><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${panelsCss}"><div id="root"></div><script src="fixture.js"></script></html>`)
    const executable = createRequire(import.meta.url)('electron')
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, [fileURLToPath(import.meta.url), directory], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}

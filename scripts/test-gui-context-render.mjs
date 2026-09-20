import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
  const win = new BrowserWindow({ width: 760, height: 720, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const measure = () => run(`(() => {
    const panel = document.querySelector('.gui-context-popover');
    const close = panel.querySelector('.gui-context-close');
    const rect = node => node.getBoundingClientRect().toJSON();
    const closeBox = rect(close);
    return {
      pane: rect(document.querySelector('.fixture-pane')), panel: rect(panel), close: closeBox,
      head: rect(panel.querySelector('.gui-context-popover-head')),
      scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth,
      scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, scrollTop: panel.scrollTop,
      closeHit: Boolean(document.elementFromPoint(closeBox.left + closeBox.width / 2,
        closeBox.top + closeBox.height / 2)?.closest('.gui-context-close')),
      expanded: panel.querySelectorAll('.gui-usage-breakdown[open]').length,
      pageScrollX: window.scrollX, pageScrollY: window.scrollY,
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight,
      text: panel.textContent, role: panel.getAttribute('role'), name: panel.getAttribute('aria-labelledby')
    };
  })()`)
  const assertFits = state => {
    assert.ok(state.panel.left >= state.pane.left && state.panel.right <= state.pane.right + 1,
      'dialog remains inside its chat pane')
    assert.ok(state.panel.top >= 0 && state.panel.bottom <= state.viewportHeight + 1,
      'dialog remains inside the visible viewport')
    assert.ok(state.scrollWidth <= state.clientWidth + 1, 'expanded parcels do not overflow horizontally')
    assert.ok(state.pageWidth <= state.viewportWidth + 1, 'dialog does not widen the page')
    assert.ok(state.close.top >= state.panel.top && state.close.bottom <= state.panel.bottom,
      'close button remains visible at every dialog scroll position')
    assert.ok(state.close.left >= state.panel.left && state.close.right <= state.panel.right,
      'close button remains inside the dialog width')
    assert.equal(state.closeHit, true, 'close button stays reachable above the scrolled content')
    if (state.scrollTop > 0) assert.ok(state.head.top <= state.panel.top + 1,
      `sticky header covers the top padding while scrolling (${state.head.top} > ${state.panel.top})`)
    assert.equal(state.pageScrollX, 0)
    assert.equal(state.pageScrollY, 0)
    assert.equal(state.role, 'dialog')
    assert.ok(state.name, 'dialog has an accessible name')
  }
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(180)
    const measurements = []
    for (const scenario of [
      { name: 'normal', width: 760, height: 720, paneWidth: 620 },
      { name: 'short', width: 440, height: 360, paneWidth: 380 },
      { name: 'narrow', width: 320, height: 320, paneWidth: 260 }
    ]) {
      win.setContentSize(scenario.width, scenario.height)
      await run(`window.contextFixture.width(${scenario.paneWidth})`)
      await pause(100)
      // R25.3b — a conversa pesada avisa no CHIP (forma tracejada + tooltip com a
      // receita), nunca no fio. Medido no CSS computado, não na classe.
      const chip = await run(`(() => {
        const trigger = document.querySelector('.gui-context-trigger');
        const style = getComputedStyle(trigger);
        return { heavy: trigger.classList.contains('heavy'), border: style.borderTopStyle,
          tip: trigger.getAttribute('data-tip'), rect: trigger.getBoundingClientRect().toJSON() };
      })()`)
      assert.equal(chip.heavy, true)
      assert.equal(chip.border, 'dashed', 'the heavy chip changes SHAPE before color')
      assert.match(chip.tip, /re-lê ~334k tokens a cada mensagem/u, 'the recipe lives in the tooltip')
      assert.match(chip.tip, /\/compact/u)
      if (scenario.name === 'normal') {
        const pad = 6
        await writeFile(resolve('.synkora/reports/gui-context-heavy-chip-2026-09-16.png'),
          (await win.webContents.capturePage({ x: Math.floor(chip.rect.x - pad), y: Math.floor(chip.rect.y - pad),
            width: Math.ceil(chip.rect.width + pad * 2), height: Math.ceil(chip.rect.height + pad * 2) })).toPNG())
      }
      await run(`document.querySelector('.gui-context-trigger').click()`)
      await pause(100)
      let state = await measure()
      assertFits(state)
      assert.match(state.text, /rodada mais recente/u)
      assert.match(state.text, /total da conversa/u)
      assert.match(state.text, /cota da conta/u)
      assert.match(state.text, /re-lê ~334k tokens a cada mensagem/u, 'the open panel repeats the recipe')
      if (scenario.name === 'normal')
        await writeFile(resolve('.synkora/reports/gui-context-heavy-panel-2026-09-16.png'), (await win.webContents.capturePage()).toPNG())
      await run(`document.querySelectorAll('.gui-usage-breakdown > summary').forEach(summary => summary.click())`)
      await pause(120)
      for (const fraction of [0, 0.5, 1]) {
        await run(`(() => {
          const panel = document.querySelector('.gui-context-popover');
          panel.scrollTop = (panel.scrollHeight - panel.clientHeight) * ${fraction};
          panel.dispatchEvent(new Event('scroll', { bubbles: true }));
        })()`)
        await pause(70)
        state = await measure()
        assertFits(state)
        assert.equal(state.expanded, 2)
        assert.ok(state.scrollHeight > state.clientHeight, 'expanded details have an internal scroll range')
        assert.ok(Math.abs(state.scrollTop - (state.scrollHeight - state.clientHeight) * fraction) <= 1,
          'the full dialog content remains reachable without resetting internal scroll')
      }
      measurements.push({ scenario: scenario.name, panel: { width: state.panel.width, height: state.panel.height },
        scrollHeight: state.scrollHeight, closeVisible: state.closeHit })
      if (scenario.name === 'normal') {
        await run(`document.querySelector('.gui-context-popover').scrollTop = 0`)
        await pause(70)
      }
      if (scenario.name !== 'narrow') await writeFile(resolve('.synkora/reports/gui-context-expanded-' + scenario.name + '-2026-09-11.png'),
        (await win.webContents.capturePage()).toPNG())
      await run(`document.querySelector('.gui-context-close').click()`)
      await pause(70)
      assert.equal(await run(`document.querySelector('.gui-context-popover') === null`), true)
      assert.equal(await run(`document.activeElement === document.querySelector('.gui-context-trigger')`), true,
        'closing a scrolled dialog restores focus to its trigger')
    }
    console.log(JSON.stringify({ pass: true, measurements }))
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('native context panel fits expanded usage inside normal, short and narrow viewports', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/gui-context-render-'))
    buildSync({ stdin: { contents: `
      import { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import GuiContextPanel from './components/GuiContextPanel'
      import { guiContextPanelPresentation } from './guiContextPanel'
      import { guiHeavyConversationTip, guiUsageMetersPresentation, guiSeatQuotaPresentation } from './guiCostSignals'
      const usage = guiContextPanelPresentation(334065, 1000000, 16.89)
      // R25.3b — 334k está acima do limiar de 150k: o chip veste a forma pesada.
      const heavy = guiHeavyConversationTip(334065)
      const meters = guiUsageMetersPresentation({
        conversation: { apiCalls: 178, inputTokens: 55000, cacheWriteTokens: 25000, cacheReadTokens: 5800000, outputTokens: 95000 },
        round: { id: 'synthetic-round', usage: { apiCalls: 4, inputTokens: 1684, cacheWriteTokens: 900, cacheReadTokens: 334065, outputTokens: 3100 } }
      })
      const seat = guiSeatQuotaPresentation({ at: Date.now(), lines: [], meters: [{ label: 'sessão', pct: 17, mode: 'used', severity: 0.17, reset: '16:30' }] }, Date.now())
      function Fixture() {
        const [open, setOpen] = useState(false), [width, setWidth] = useState(620)
        window.contextFixture = { width: setWidth }
        return <main className="fixture-shell">
          <section className="gui-pane fixture-pane" style={{ width }}>
            <p className="fixture-caption">Medições sintéticas para teste visual</p>
            <div className="fixture-trigger"><GuiContextPanel usage={usage} label="33% contexto"
              usageMeters={meters} seat={seat} heavy={heavy} open={open} onOpenChange={setOpen} /></div>
          </section>
        </main>
      }
      createRoot(document.getElementById('root')).render(<Fixture />)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser',
      format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Context panel synthetic fixture</title>
      <link rel="stylesheet" href="${css}"><link rel="stylesheet" href="fixture.css">
      <style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}.fixture-shell{height:100%;padding:16px;box-sizing:border-box;display:flex;justify-content:center;background:#efe9dc}.fixture-pane{position:relative;height:100%;flex:none;border:1px solid #b6ac94;border-radius:8px}.fixture-caption{margin:18px;font:12px var(--mono);color:var(--ink-2)}.fixture-trigger{position:absolute;bottom:16px;right:16px}</style>
      <div id="root"></div><script src="fixture.js"></script></html>`)
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

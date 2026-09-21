// O SELO DE VERSÃO NO RAIL, PROVADO EM ELECTRON (2026-09-21).
//
// O componente REAL (`AppUpdateBadge` + ProjectRail.css + global.css) dentro de
// um rail sintético (Home, dois universos, "+"), com o `window.synkora.appUpdate`
// substituído por um stub que a prova dirige. Quatro estados passam pela tela
// e são fotografados para o dono; o que se mede:
//   - o selo fica no PÉ do rail e dentro dele (sem transbordo horizontal);
//   - o número muda para a versão que vem; a barra do download enche;
//   - "pronto" abre a folha de confirmação (portal), e "reiniciar agora"
//     chama install() UMA vez; "depois" fecha sem chamar.
// Capturas em .synkora/reports/app-update-badge-<estado>-2026-09-21.png.
//
// Rode: node scripts/test-app-update-badge-native.mjs

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
  const win = new BrowserWindow({ width: 520, height: 420, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const measure = () => run(`(() => {
    const rail = document.querySelector('.project-rail');
    const badge = document.querySelector('.rail-version-badge');
    const rect = node => node.getBoundingClientRect().toJSON();
    const bar = badge.querySelector('.rail-version-bar > i');
    return {
      rail: rect(rail), badge: rect(badge), label: badge.querySelector('.rail-version-label').textContent,
      glyph: badge.querySelector('.rail-version-glyph')?.textContent ?? '',
      tone: [...badge.classList].find(c => c.startsWith('tone-')),
      tip: badge.getAttribute('data-tip'), aria: badge.getAttribute('aria-label'),
      barWidth: bar ? bar.getBoundingClientRect().width : null,
      railScrollWidth: rail.scrollWidth, railClientWidth: rail.clientWidth,
      sheet: document.querySelector('.rail-version-sheet') ? rect(document.querySelector('.rail-version-sheet')) : null,
      installCalls: window.badgeFixture.installCalls
    };
  })()`)
  const shot = async name => {
    await writeFile(resolve(`.synkora/reports/app-update-badge-${name}-2026-09-21.png`), (await win.webContents.capturePage()).toPNG())
  }
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(200)
    let state = await measure()
    assert.equal(state.label, '0.1.0')
    assert.equal(state.tone, 'tone-quiet')
    assert.ok(state.badge.left >= state.rail.left && state.badge.right <= state.rail.right + 0.5, 'o selo cabe na largura do rail')
    assert.ok(state.badge.bottom <= state.rail.bottom && state.badge.top > state.rail.top + state.rail.height * 0.6, 'o selo mora no pé do rail')
    assert.ok(state.railScrollWidth <= state.railClientWidth + 1, 'o rail não transborda na horizontal')
    assert.match(state.tip, /em dia/u)
    await shot('current')

    await run(`window.badgeFixture.push({ phase: 'downloading', version: '0.1.0', next: '0.2.0', percent: 42, transferred: 40 * 1048576, total: 95 * 1048576 })`)
    await pause(320)
    state = await measure()
    assert.equal(state.label, '0.2.0')
    assert.equal(state.glyph, '↓')
    assert.equal(state.tone, 'tone-busy')
    assert.ok(state.barWidth !== null && state.barWidth > 0 && state.barWidth < state.badge.width, `a barra enche parcialmente (${state.barWidth})`)
    await shot('downloading')

    await run(`window.badgeFixture.push({ phase: 'error', version: '0.1.0', error: 'sem conexão para verificar atualizações', checkedAt: Date.now() - 120000 })`)
    await pause(120)
    state = await measure()
    assert.equal(state.tone, 'tone-warn')
    assert.equal(state.glyph, '!')
    assert.match(state.tip, /sem conexão/u)
    await shot('error')

    await run(`window.badgeFixture.push({ phase: 'ready', version: '0.1.0', next: '0.2.0' })`)
    await pause(120)
    state = await measure()
    assert.equal(state.tone, 'tone-ready')
    assert.equal(state.glyph, '↻')
    assert.equal(state.sheet, null)
    await shot('ready')

    await run(`document.querySelector('.rail-version-badge').click()`)
    await pause(200)
    state = await measure()
    assert.ok(state.sheet, 'pronto abre a folha de confirmação')
    assert.ok(state.sheet.left >= state.rail.right - 1, 'a folha fica ao lado do rail, não em cima dele')
    assert.equal(state.installCalls, 0, 'abrir a folha não instala nada')
    await shot('confirm')
    await run(`[...document.querySelectorAll('.rail-version-sheet button')].find(b => b.textContent.trim() === 'depois').click()`)
    await pause(80)
    state = await measure()
    assert.equal(state.sheet, null, '"depois" fecha a folha')
    assert.equal(state.installCalls, 0)
    await run(`document.querySelector('.rail-version-badge').click()`)
    await pause(120)
    await run(`[...document.querySelectorAll('.rail-version-sheet button')].find(b => b.textContent.trim() === 'reiniciar agora').click()`)
    await pause(120)
    state = await measure()
    assert.equal(state.installCalls, 1, '"reiniciar agora" chama install() uma vez')
    console.log(JSON.stringify({ pass: true, badge: state.badge, rail: state.rail }))
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('native version badge: bottom of the rail, four states, confirmation before restart', { timeout: 40000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/app-update-badge-'))
    buildSync({ stdin: { contents: `
      import { createRoot } from 'react-dom/client'
      import AppUpdateBadge from './components/AppUpdateBadge'
      import SynkoraMark from './components/SynkoraMark'
      import './components/ProjectRail.css'
      function Rail() {
        return <nav className="project-rail">
          <button className="rail-item rail-home active"><SynkoraMark size={22} /></button>
          <div className="rail-sep" />
          <div className="rail-list">
            <button className="rail-item" style={{ ['--card-hue']: 21 }}><span className="rail-initials">SY</span></button>
            <button className="rail-item" style={{ ['--card-hue']: 210 }}><span className="rail-initials">NU</span></button>
            <button className="rail-item rail-add">+</button>
          </div>
          <AppUpdateBadge />
        </nav>
      }
      createRoot(document.getElementById('root')).render(<Rail />)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser',
      format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Version badge fixture</title>
      <link rel="stylesheet" href="${css}"><link rel="stylesheet" href="fixture.css">
      <style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}#root{display:flex;height:100%;background:#efe9dc}.project-rail{height:100%}</style>
      <script>
        // O stub do preload: só o namespace que o selo usa. A prova dirige os
        // estados por window.badgeFixture.push e conta as instalações pedidas.
        (() => {
          let current = { phase: 'current', version: '0.1.0', checkedAt: Date.now() - 5 * 60000 };
          const listeners = new Set();
          window.badgeFixture = { installCalls: 0, push(next) { current = next; listeners.forEach(cb => cb(next)); } };
          window.synkora = { appUpdate: {
            status: async () => current,
            check: async () => current,
            download: async () => current,
            install: async () => { window.badgeFixture.installCalls += 1; return { ok: true }; },
            onStatus: cb => { listeners.add(cb); return () => listeners.delete(cb); }
          } };
        })();
      </script>
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
